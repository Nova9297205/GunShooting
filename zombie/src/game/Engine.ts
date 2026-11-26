// ============================================================
// HostSimulation: ホスト権限のゲーム計算
//   - 時間経過・昼夜サイクル・5日ごとの大襲撃（ホード）
//   - ゾンビAI（徘徊 / 感知 / 騒音への反応 / フローフィールド追跡 / 壁破壊）
//   - 建築・修理・クラフト・物資回収・資源の再湧き
//   - プレイヤーの HP / 空腹 / ダウン・蘇生、弾と当たり判定
//   ソロ・ホスト時のみ実行され、ゲストはスナップショットを受け取るだけ
// ============================================================
import type {
  BuildKind,
  GameEvent,
  GameResult,
  InputFrame,
  LobbyPlayer,
  ObjSnap,
  PlayerSnap,
  Snapshot,
  SoundKey,
  Stash,
  TimePhase,
  WeaponId,
  ViewState,
  ZombieSnap,
  ZombieType,
} from '../types';
import { Tool } from '../types';
import {
  AXE,
  BREAKABLE_KINDS,
  BUILD_COST,
  CAMPFIRE_TILE,
  CYCLE_SECONDS,
  DAY_SECONDS,
  HORDE_EVERY,
  MAP_H,
  MAP_W,
  NIGHT_SECONDS,
  OBJ_HP,
  PLAYER,
  REGROW,
  REPAIR,
  SAFEHOUSE,
  SPIKE,
  START_MINUTE,
  T_WALL,
  TILE,
  USABLE_SLOTS,
  CHEST_ITEMS,
  BARBED,
  BENCH_RANGE,
  RECIPES,
  TURRET,
  WEAPONS,
  MUZZLE,
  BLUEPRINTS,
  WORLD_H,
  WORLD_W,
  ZOMBIE,
  ZOMBIE_SENSE,
} from './constants';
import { angleDiff, circleOverlapsTile, moveCircle, stepMovement } from './physics';
import { BUILD_ID_START, generateWorld, locationAt, objIsSolid, TileWorld } from './world';

interface SimPlayer extends PlayerSnap {
  queue: InputFrame[];
  fire: boolean;
  revive: boolean;
  tx: number;
  ty: number;
  fireCd: number;
  swingCd: number;
  buildCd: number;
  repairCd: number;
  warnCd: number;
  bp: number;
  alt: boolean;
  useCd: number;
  reloadW: WeaponId | '';
  /** 最後に入力が届いてからの秒数（タブが裏に回った等で入力が止まったら押しっぱなしを解除） */
  idle: number;
}

interface SimZombie extends ZombieSnap {
  kx: number;
  ky: number;
  attackCd: number;
  aggroT: number;
  noiseX: number;
  noiseY: number;
  hasNoise: boolean;
  wanderA: number;
  wanderT: number;
  speedMul: number;
  spikeAcc: number;
  dead: boolean;
}

interface SimObj extends ObjSnap {
  regrowT: number;
  /** タレット：設置者と射撃クールダウン */
  owner?: number;
  cd?: number;
}

interface SimBullet {
  id: number;
  dmg: number;
  knock: number;
  owner: number;
  x: number;
  y: number;
  vx: number;
  vy: number;
  life: number;
  dead: boolean;
}

const r1 = (v: number) => Math.round(v * 10) / 10;
const r2 = (v: number) => Math.round(v * 100) / 100;
const MAX_ZOMBIES = 110;

/** 時刻（分）を計算：サイクル開始は 06:00 */
export function cycleToMinute(cycleT: number): number {
  if (cycleT < DAY_SECONDS) return 360 + (cycleT * 840) / DAY_SECONDS;
  return (1200 + ((cycleT - DAY_SECONDS) * 600) / NIGHT_SECONDS) % 1440;
}

export function isHordeDay(day: number): boolean {
  return day % HORDE_EVERY === 0;
}

// ---------------- 小さな二分ヒープ（Dijkstra 用） ----------------
class MinHeap {
  private k: number[] = [];
  private v: number[] = [];
  get size() {
    return this.k.length;
  }
  push(key: number, val: number) {
    const k = this.k;
    const v = this.v;
    k.push(key);
    v.push(val);
    let i = k.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (k[p] <= k[i]) break;
      const tk = k[p];
      k[p] = k[i];
      k[i] = tk;
      const tv = v[p];
      v[p] = v[i];
      v[i] = tv;
      i = p;
    }
  }
  pop(): [number, number] {
    const k = this.k;
    const v = this.v;
    const top: [number, number] = [k[0], v[0]];
    const lk = k.pop()!;
    const lv = v.pop()!;
    if (k.length > 0) {
      k[0] = lk;
      v[0] = lv;
      let i = 0;
      for (;;) {
        const l = i * 2 + 1;
        const r = l + 1;
        let m = i;
        if (l < k.length && k[l] < k[m]) m = l;
        if (r < k.length && k[r] < k[m]) m = r;
        if (m === i) break;
        const tk = k[m];
        k[m] = k[i];
        k[i] = tk;
        const tv = v[m];
        v[m] = v[i];
        v[i] = tv;
        i = m;
      }
    }
    return top;
  }
}

const NEIGHBORS = [
  [1, 0, 1],
  [-1, 0, 1],
  [0, 1, 1],
  [0, -1, 1],
  [1, 1, Math.SQRT2],
  [1, -1, Math.SQRT2],
  [-1, 1, Math.SQRT2],
  [-1, -1, Math.SQRT2],
];

export class HostSimulation {
  readonly seed: number;
  world: TileWorld<SimObj>;
  players: SimPlayer[] = [];
  zombies: SimZombie[] = [];
  bullets: SimBullet[] = [];
  stash: Stash = { wood: 30, scrap: 12 };
  /** 拠点の共有チェスト */
  chest: Record<string, number> = {};

  day = 1;
  cycleT: number;
  phase: TimePhase = 'day';
  time = 0;
  tick = 0;
  result: GameResult | null = null;
  gameOver = false;

  private events: GameEvent[] = [];
  private changed = new Set<number>();
  private removed: number[] = [];
  private nextId = 1;
  private nextBuildId = BUILD_ID_START;
  // Float64 で保持する（Float32 だとヒープのキーとの丸め誤差で同じノードが何度も再投入され、計算が爆発する）
  private flow = new Float64Array(MAP_W * MAP_H);
  private flowTimer = 0;
  private spawnTimer = 2;
  private hordeQuota = 0;
  private hordeSpawned = 0;

  constructor(lobby: LobbyPlayer[], seed: number) {
    this.seed = seed;
    const gen = generateWorld(seed);
    this.world = new TileWorld<SimObj>(gen.terrain);
    for (const o of gen.objs) this.world.setObj({ ...o, regrowT: 0 });
    this.world.locations = gen.locations;
    this.cycleT = ((START_MINUTE - 360) * DAY_SECONDS) / 840;

    const cx = (CAMPFIRE_TILE.x + 0.5) * TILE;
    const cy = (CAMPFIRE_TILE.y + 0.5) * TILE;
    lobby.forEach((lp, i) => {
      const a = (i / Math.max(1, lobby.length)) * Math.PI * 2;
      this.players.push({
        id: lp.id,
        name: lp.name,
        x: cx + Math.cos(a) * 60,
        y: cy + Math.sin(a) * 60,
        bodyAngle: 0,
        aim: 0,
        hp: PLAYER.maxHp,
        maxHp: PLAYER.maxHp,
        hunger: 100,
        status: 'alive',
        downTimer: 0,
        reviveProgress: 0,
        tool: Tool.Gun,
        inv: { ammo: 36, mag: WEAPONS.pistol.magSize, shells: 0, smag: 0, gun: 0, shotgun: 0, gunpowder: 2, food: 2, medkit: 1, cloth: 1, herb: 1, parts: 0, kit: 0, axe: 0 },
        reloadT: 0,
        shots: 0,
        swings: 0,
        kills: 0,
        builds: 0,
        ack: 0,
        dashTime: 0,
        dashCd: 0,
        dashDx: 0,
        dashDy: 0,
        stamina: PLAYER.maxStamina,
        staminaDelay: 0,
        queue: [],
        fire: false,
        revive: false,
        tx: 0,
        ty: 0,
        fireCd: 0,
        swingCd: 0,
        buildCd: 0,
        repairCd: 0,
        warnCd: 0,
        idle: 0,
        bp: 0,
        alt: false,
        useCd: 0,
        reloadW: '',
      });
    });
    for (const loc of this.world.locations) if (loc.tier >= 3) for (let i = 0; i < 6; i++) this.spawnGuard(loc);
    this.events.push({ k: 'banner', t: 'DAY 1', s: '物資を集めて拠点を強化しよう。5日目の夜に大襲撃が来る…', c: '#ffe2a8', snd: 'day' });
  }

  // ======================== 外部API ========================

  /** 開発用：任意のオブジェクトを設置（監査スクリプト用） */
  debugPlace(kind: BuildKind, tx: number, ty: number): void {
    if (!(kind in OBJ_HP) || !this.world.inBounds(tx, ty) || this.world.solid(tx, ty) || this.world.objAt(tx, ty)) return;
    const hp = OBJ_HP[kind];
    const o: SimObj = { id: this.nextBuildId++, kind, tx, ty, hp, maxHp: hp, ready: 1, regrowT: 0 };
    this.world.setObj(o);
    this.changed.add(o.id);
    this.flowTimer = Math.min(this.flowTimer, 0.1);
  }

  queueInput(playerId: number, f: InputFrame): void {
    const p = this.players.find((pl) => pl.id === playerId);
    if (!p) return;
    p.queue.push(f);
    if (p.queue.length > 120) p.queue.splice(0, p.queue.length - 120);
  }

  removePlayer(playerId: number): void {
    this.players = this.players.filter((p) => p.id !== playerId);
  }

  drainEvents(): GameEvent[] {
    const e = this.events;
    this.events = [];
    return e;
  }

  minute(): number {
    return cycleToMinute(this.cycleT);
  }

  initialObjs(): ObjSnap[] {
    return [...this.world.objects.values()].map(toObjSnap);
  }

  /** 前回呼び出し以降に変化したオブジェクト差分 */
  takeObjDelta(): { objs: ObjSnap[]; removed: number[] } {
    const objs: ObjSnap[] = [];
    for (const id of this.changed) {
      const o = this.world.objects.get(id);
      if (o) objs.push(toObjSnap(o));
    }
    const removed = this.removed;
    this.changed.clear();
    this.removed = [];
    return { objs, removed };
  }

  view(): ViewState {
    return {
      time: r2(this.time),
      tick: this.tick,
      day: this.day,
      minute: Math.floor(this.minute()),
      phase: this.phase,
      stash: { ...this.stash },
      chest: { ...this.chest },
      hordeLeft: this.phase === 'horde' ? this.hordeQuota - this.hordeSpawned + this.zombies.filter((z) => z.horde).length : 0,
      players: this.players.map((p) => ({
        id: p.id,
        name: p.name,
        x: r1(p.x),
        y: r1(p.y),
        bodyAngle: r2(p.bodyAngle),
        aim: r2(p.aim),
        hp: Math.ceil(p.hp),
        maxHp: p.maxHp,
        hunger: r1(p.hunger),
        status: p.status,
        downTimer: r1(p.downTimer),
        reviveProgress: r2(p.reviveProgress),
        tool: p.tool,
        inv: { ...p.inv },
        reloadT: r2(p.reloadT),
        shots: p.shots,
        swings: p.swings,
        kills: p.kills,
        builds: p.builds,
        ack: p.ack,
        dashTime: p.dashTime,
        dashCd: p.dashCd,
        dashDx: p.dashDx,
        dashDy: p.dashDy,
        stamina: Math.round(p.stamina * 10) / 10,
        staminaDelay: Math.round(p.staminaDelay * 100) / 100,
      })),
      zombies: this.zombies.map((z) => ({
        id: z.id,
        type: z.type,
        x: r1(z.x),
        y: r1(z.y),
        angle: r2(z.angle),
        hp: Math.ceil(z.hp),
        maxHp: Math.ceil(z.maxHp),
        flash: r2(z.flash),
        horde: z.horde,
        atk: z.atk,
      })),
      bullets: this.bullets.map((b) => ({
        id: b.id,
        owner: b.owner,
        x: r1(b.x),
        y: r1(b.y),
        vx: Math.round(b.vx),
        vy: Math.round(b.vy),
      })),
    };
  }

  snapshot(events: GameEvent[]): Snapshot {
    const d = this.takeObjDelta();
    return { ...this.view(), events, objs: d.objs, removed: d.removed };
  }

  // ======================== メインステップ ========================

  step(dt: number): void {
    if (this.gameOver) return;
    this.time += dt;
    this.tick++;

    this.updateClock(dt);
    for (const p of this.players) this.updatePlayer(p, dt);
    this.updateRevive(dt);

    this.flowTimer -= dt;
    if (this.flowTimer <= 0) {
      this.computeFlow();
      this.flowTimer = 0.4;
    }
    this.updateSpawning(dt);
    for (const z of this.zombies) this.updateZombie(z, dt);
    this.separateZombies();
    this.updateBullets(dt);
    this.updateTurrets(dt);
    this.updateObjects(dt);
    this.zombies = this.zombies.filter((z) => !z.dead);
    this.bullets = this.bullets.filter((b) => !b.dead);

    if (this.players.length > 0 && !this.players.some((p) => p.status === 'alive')) {
      this.gameOver = true;
      this.result = {
        day: this.day,
        players: this.players.map((p) => ({ id: p.id, name: p.name, kills: p.kills, builds: p.builds })),
      };
    }
  }

  // ======================== 時間・昼夜 ========================

  private updateClock(dt: number): void {
    const prevPhase = this.phase;
    this.cycleT += dt;
    if (this.cycleT >= CYCLE_SECONDS) {
      this.cycleT -= CYCLE_SECONDS;
      this.day++;
    }
    const night = this.cycleT >= DAY_SECONDS;
    this.phase = night ? (isHordeDay(this.day) ? 'horde' : 'night') : 'day';

    if (prevPhase !== this.phase) {
      if (this.phase === 'horde') {
        // 人数ごとの大襲撃の規模（ボットによる自動テストで調整：3人は資材を分け合うぶん控えめ）
        const mult = [1, 0.92, 1.9, 2.35][Math.min(3, this.players.length)];
        const n = this.day / HORDE_EVERY;
        this.hordeQuota = Math.round((30 + 20 * (n - 1)) * mult);
        this.hordeSpawned = 0;
        this.spawnTimer = 1.5;
        this.events.push({ k: 'banner', t: '大襲撃 - HORDE NIGHT', s: 'ゾンビの大群が押し寄せてくる！朝 6:00 まで生き延びろ', c: '#ff3b3b', snd: 'horde' });
      } else if (this.phase === 'night') {
        this.events.push({ k: 'banner', t: `DAY ${this.day} - 夜`, s: 'ゾンビが活発になった。懐中電灯で周囲を照らせ', c: '#9fb7ff', snd: 'night' });
      } else {
        this.onDawn(prevPhase === 'horde');
      }
    }
  }

  private onDawn(hordeCleared: boolean): void {
    if (hordeCleared) {
      this.events.push({ k: 'banner', t: '大襲撃クリア！', s: `DAY ${this.day} の朝を迎えた。生き延びたぞ！`, c: '#7dffb0', snd: 'clear' });
      // 残ったホードゾンビは朝日で燃え尽きる
      for (const z of this.zombies) {
        if (!z.horde) continue;
        z.dead = true;
        this.events.push({ k: 'burn', x: z.x, y: z.y });
      }
    } else {
      const sub = isHordeDay(this.day)
        ? '今夜は大襲撃！ 拠点を固めろ'
        : `大襲撃まであと ${HORDE_EVERY - (this.day % HORDE_EVERY)} 日`;
      this.events.push({ k: 'banner', t: `DAY ${this.day}`, s: sub, c: '#ffe2a8', snd: 'day' });
    }
    // 戦闘不能者はキャンプファイアで復帰
    const cx = (CAMPFIRE_TILE.x + 0.5) * TILE;
    const cy = (CAMPFIRE_TILE.y + 0.5) * TILE;
    for (const p of this.players) {
      if (p.status !== 'dead') continue;
      p.status = 'alive';
      p.hp = p.maxHp * PLAYER.reviveHpRatio;
      p.hunger = Math.max(p.hunger, 50);
      p.x = cx + 50;
      p.y = cy;
      this.events.push({ k: 'revive', id: p.id, x: p.x, y: p.y });
    }
    // 収納箱は毎朝補充
    for (const o of this.world.objects.values()) {
      if (o.kind === 'box' && !o.ready) {
        o.ready = 1;
        this.changed.add(o.id);
      }
    }
  }

  // ======================== プレイヤー ========================

  private updatePlayer(p: SimPlayer, dt: number): void {
    for (const f of p.queue) {
      stepMovement(p, f, f.dt, p.status, this.world);
      p.ack = f.seq;
      p.aim = f.aim;
      p.fire = f.fire;
      p.revive = f.revive;
      p.tx = f.tx;
      p.ty = f.ty;
      if (f.tool >= 0 && f.tool < USABLE_SLOTS && f.tool !== p.tool) {
        p.tool = f.tool;
        p.reloadT = 0; // 持ち替えたらリロード中断
      }
      p.bp = Math.max(0, Math.min(BLUEPRINTS.length - 1, f.bp | 0));
      p.alt = !!f.alt;
      if (p.status !== 'alive') continue;
      if (f.interact) this.interact(p);
      if (f.reload) this.startReload(p);
      if (f.craft) this.craft(p, f.craft);
      if (f.chest) this.chestOp(p, f.chest);
      if (f.ping) this.ping(p, f.tx, f.ty);
      if (f.eat) this.useFood(p, true);
      if (f.heal) this.useMedkit(p, true);
    }
    if (p.queue.length > 0) p.idle = 0;
    else if ((p.idle += dt) > 0.3) {
      p.fire = false;
      p.alt = false;
      p.revive = false;
    }
    p.queue.length = 0;

    p.warnCd = Math.max(0, p.warnCd - dt);

    if (p.status === 'down') {
      if (p.reviveProgress <= 0) p.downTimer -= dt;
      if (p.downTimer <= 0) {
        p.status = 'dead';
        p.downTimer = 0;
        p.reviveProgress = 0;
        this.events.push({ k: 'dead', id: p.id });
      }
      return;
    }
    if (p.status !== 'alive') return;

    // 空腹
    p.hunger = Math.max(0, p.hunger - (100 / PLAYER.hungerSeconds) * dt);
    if (p.hunger <= 0) {
      p.hp -= PLAYER.starveDps * dt;
      if (p.warnCd <= 0) {
        this.pop(p, '空腹でHPが減っている！ [Q]で食事', '#ffb347');
        p.warnCd = 6;
      }
      if (p.hp <= 0) this.downPlayer(p);
      if (p.status !== 'alive') return;
    }

    // リロード
    if (p.reloadT > 0) {
      p.reloadT -= dt;
      if (p.reloadT <= 0) {
        p.reloadT = 0;
        if (p.reloadW === 'shotgun') {
          const take = Math.min(WEAPONS.shotgun.magSize - p.inv.smag, p.inv.shells);
          p.inv.smag += take;
          p.inv.shells -= take;
        } else if (p.reloadW) {
          const take = Math.min(WEAPONS[p.reloadW].magSize - p.inv.mag, p.inv.ammo);
          p.inv.mag += Math.max(0, take);
          p.inv.ammo -= Math.max(0, take);
        }
      }
    }

    p.fireCd = Math.max(-1, p.fireCd - dt);
    p.swingCd = Math.max(0, p.swingCd - dt);
    p.buildCd = Math.max(0, p.buildCd - dt);
    p.repairCd = Math.max(0, p.repairCd - dt);
    p.useCd = Math.max(0, p.useCd - dt);

    // 建築ツールの右クリック＝修理
    if (p.tool === Tool.Build && p.alt) {
      if (p.repairCd <= 0) {
        this.repair(p);
        p.repairCd = REPAIR.interval;
      }
      return;
    }
    if (!p.fire) {
      if (p.fireCd < 0) p.fireCd = 0;
      return;
    }
    switch (p.tool) {
      case Tool.Melee:
        if (p.swingCd <= 0) {
          this.swingAxe(p);
          p.swingCd = AXE.interval;
        }
        break;
      case Tool.Gun:
      case Tool.Shotgun: {
        const w = this.weaponOf(p);
        if (w) this.fireWeapon(p, w);
        else if (p.warnCd <= 0) {
          this.pop(p, 'ショットガンを持っていない（物資から入手）', '#ff8080');
          p.warnCd = 1.5;
        }
        break;
      }
      case Tool.Build:
        if (p.buildCd <= 0) {
          this.build(p, BLUEPRINTS[p.bp].kind);
          p.buildCd = 0.22;
        }
        break;
      case Tool.Food:
        if (p.useCd <= 0) {
          this.useFood(p, true);
          p.useCd = 0.7;
        }
        break;
      case Tool.Medkit:
        if (p.useCd <= 0) {
          this.useMedkit(p, true);
          p.useCd = 0.7;
        }
        break;
    }
  }

  /** 選択中のスロットの射撃武器 */
  private weaponOf(p: SimPlayer): WeaponId | null {
    if (p.tool === Tool.Gun) return p.inv.gun >= 1 ? 'rifle' : 'pistol';
    if (p.tool === Tool.Shotgun && p.inv.shotgun) return 'shotgun';
    return null;
  }

  private pop(p: SimPlayer, t: string, c: string, s?: SoundKey): void {
    // 赤い警告メッセージにはエラー音を付ける
    this.events.push({ k: 'pop', x: p.x, y: p.y - 30, t, c, id: p.id, s: s ?? (c === '#ff8080' ? 'error' : undefined) });
  }

  private fireWeapon(p: SimPlayer, wid: WeaponId): void {
    if (p.reloadT > 0) return;
    const w = WEAPONS[wid];
    const sg = wid === 'shotgun';
    const mag = () => (sg ? p.inv.smag : p.inv.mag);
    const reserve = () => (sg ? p.inv.shells : p.inv.ammo);
    if (mag() <= 0) {
      if (reserve() > 0) this.startReload(p);
      else if (p.warnCd <= 0) {
        this.pop(p, sg ? 'シェルがない！ [C]で作成（火薬2）' : '弾切れ！ [C]で弾薬を作成（火薬2）', '#ff8080');
        p.warnCd = 1.5;
      }
      return;
    }
    while (p.fireCd <= 0 && mag() > 0) {
      for (let i = 0; i < w.pellets; i++) {
        const a = p.aim + (Math.random() - 0.5) * 2 * w.spread;
        const sp = w.bulletSpeed * (sg ? 0.85 + Math.random() * 0.3 : 1);
        this.bullets.push({
          id: this.nextId++,
          owner: p.id,
          dmg: w.damage,
          knock: w.knock,
          x: p.x + Math.cos(p.aim) * MUZZLE,
          y: p.y + Math.sin(p.aim) * MUZZLE,
          vx: Math.cos(a) * sp,
          vy: Math.sin(a) * sp,
          life: w.bulletLife * (sg ? 0.8 + Math.random() * 0.4 : 1),
          dead: false,
        });
      }
      if (sg) p.inv.smag--;
      else p.inv.mag--;
      p.shots++;
      p.fireCd += w.fireInterval;
      this.makeNoise(p.x, p.y, w.noiseRadius);
    }
    if (mag() <= 0 && reserve() > 0) this.startReload(p);
  }

  private startReload(p: SimPlayer): void {
    const wid = this.weaponOf(p);
    if (!wid || p.reloadT > 0) return;
    const sg = wid === 'shotgun';
    if ((sg ? p.inv.smag : p.inv.mag) >= WEAPONS[wid].magSize) return;
    if ((sg ? p.inv.shells : p.inv.ammo) <= 0) {
      if (p.warnCd <= 0) {
        this.pop(p, sg ? '予備のシェルがない' : '予備弾薬がない', '#ff8080');
        p.warnCd = 1.5;
      }
      return;
    }
    p.reloadT = WEAPONS[wid].reloadTime;
    p.reloadW = wid;
  }

  private pingCd = new Map<number, number>();

  /** ピン：近くに敵がいれば「敵」、物資なら「物資」、それ以外は「ここ」 */
  private ping(p: SimPlayer, tx: number, ty: number): void {
    const now = this.time;
    if ((this.pingCd.get(p.id) ?? -9) > now - 0.8) return;
    this.pingCd.set(p.id, now);
    const x = (tx + 0.5) * TILE;
    const y = (ty + 0.5) * TILE;
    let t: 'enemy' | 'loot' | 'go' = 'go';
    if (this.zombies.some((z) => Math.hypot(z.x - x, z.y - y) < 90)) t = 'enemy';
    else {
      for (let dy = -1; dy <= 1 && t === 'go'; dy++)
        for (let dx = -1; dx <= 1; dx++) {
          const o = this.world.objAt(tx + dx, ty + dy);
          if (o && o.ready && (o.kind === 'crate' || o.kind === 'mcrate' || o.kind === 'box')) t = 'loot';
        }
    }
    this.events.push({ k: 'ping', id: p.id, x, y, t });
  }

  /** 共有チェストへの出し入れ（チェストの近くでのみ） */
  private chestOp(p: SimPlayer, op: string): void {
    const near = [...this.world.objects.values()].some(
      (o) => o.kind === 'chest' && Math.hypot((o.tx + 0.5) * TILE - p.x, (o.ty + 0.5) * TILE - p.y) <= BENCH_RANGE,
    );
    if (!near) return;
    const [dir, item, amountStr] = op.split(':');
    if (!CHEST_ITEMS.some((c) => c.id === item)) return;
    const inv = p.inv as unknown as Record<string, number>;
    const amount = Math.max(1, Math.min(999, Number(amountStr) || 1));
    if (dir === 'd') {
      const n = Math.min(amount, inv[item] ?? 0);
      if (n <= 0) return;
      inv[item] -= n;
      this.chest[item] = (this.chest[item] ?? 0) + n;
    } else if (dir === 'w') {
      const n = Math.min(amount, this.chest[item] ?? 0);
      if (n <= 0) return;
      this.chest[item] -= n;
      inv[item] = (inv[item] ?? 0) + n;
    }
  }

  /** 作業台の近くにいるか */
  private nearBench(p: SimPlayer): boolean {
    for (const o of this.world.objects.values()) {
      if (o.kind !== 'bench') continue;
      if (Math.hypot((o.tx + 0.5) * TILE - p.x, (o.ty + 0.5) * TILE - p.y) <= BENCH_RANGE) return true;
    }
    return false;
  }

  private craft(p: SimPlayer, id: string): void {
    const r = RECIPES.find((x) => x.id === id);
    if (!r) return;
    if (r.bench && !this.nearBench(p)) {
      this.pop(p, '作業台の近くでないと作れない', '#ff8080');
      return;
    }
    if ((id === 'rifle' && p.inv.gun >= 1) || (id === 'shotgun' && p.inv.shotgun) || (id === 'axe' && p.inv.axe)) {
      this.pop(p, 'すでに持っている', '#cccccc');
      return;
    }
    const have = (m: string) => (m === 'wood' || m === 'scrap' ? this.stash[m] : (p.inv as unknown as Record<string, number>)[m]);
    for (const [m, n] of Object.entries(r.cost)) {
      if (have(m) < (n ?? 0)) {
        this.pop(p, '素材が足りない', '#ff8080');
        return;
      }
    }
    for (const [m, n] of Object.entries(r.cost)) {
      if (m === 'wood' || m === 'scrap') this.stash[m] -= n ?? 0;
      else (p.inv as unknown as Record<string, number>)[m] -= n ?? 0;
    }
    switch (id) {
      case 'ammo':
        p.inv.ammo += 10;
        break;
      case 'shells':
        p.inv.shells += 6;
        break;
      case 'medkit':
        p.inv.medkit += 1;
        break;
      case 'kit':
        p.inv.kit += 1;
        break;
      case 'rifle':
        p.inv.gun = 1;
        p.inv.mag = Math.min(p.inv.mag, WEAPONS.rifle.magSize);
        break;
      case 'shotgun':
        p.inv.shotgun = 1;
        p.inv.smag = WEAPONS.shotgun.magSize;
        break;
      case 'axe':
        p.inv.axe = 1;
        break;
    }
    this.pop(p, `${r.name} を作成！`, '#ffd84d', 'craft');
  }

  private useFood(p: SimPlayer, explicit: boolean): boolean {
    if (p.inv.food <= 0) {
      if (explicit) this.pop(p, '食料がない', '#ff8080');
      return false;
    }
    if (p.hunger >= 99) {
      if (explicit) this.pop(p, 'お腹はいっぱい', '#cccccc');
      return false;
    }
    p.inv.food--;
    p.hunger = Math.min(100, p.hunger + PLAYER.foodValue);
    p.hp = Math.min(p.maxHp, p.hp + 5);
    this.pop(p, `空腹 +${PLAYER.foodValue}`, '#ffcf6b', 'eat');
    return true;
  }

  private useMedkit(p: SimPlayer, explicit: boolean): boolean {
    if (p.inv.medkit <= 0) {
      if (explicit) this.pop(p, '救急キットがない', '#ff8080');
      return false;
    }
    if (p.hp >= p.maxHp) {
      if (explicit) this.pop(p, 'HPは満タン', '#cccccc');
      return false;
    }
    p.inv.medkit--;
    p.hp = Math.min(p.maxHp, p.hp + PLAYER.medkitValue);
    this.pop(p, `HP +${PLAYER.medkitValue}`, '#7dffb0', 'heal');
    return true;
  }

  /** F キー：近くのクレート/収納箱を調べる。なければアイテム使用 */
  private interact(p: SimPlayer): void {
    let best: SimObj | null = null;
    let bd = PLAYER.interactRange;
    const ptx = Math.floor(p.x / TILE);
    const pty = Math.floor(p.y / TILE);
    for (let ty = pty - 2; ty <= pty + 2; ty++)
      for (let tx = ptx - 2; tx <= ptx + 2; tx++) {
        const o = this.world.objAt(tx, ty);
        if (!o) continue;
        const lootable = o.ready && (o.kind === 'crate' || o.kind === 'box' || o.kind === 'mcrate');
        const turret = o.kind === 'turret' && o.ready < TURRET.maxAmmo;
        if (!lootable && !turret) continue;
        const d = Math.hypot((o.tx + 0.5) * TILE - p.x, (o.ty + 0.5) * TILE - p.y);
        if (d < bd) {
          bd = d;
          best = o;
        }
      }
    if (best && best.kind === 'turret') {
      const n = Math.min(TURRET.maxAmmo - best.ready, p.inv.ammo);
      if (n <= 0) this.pop(p, '補充する弾薬がない', '#ff8080');
      else {
        p.inv.ammo -= n;
        best.ready += n;
        this.changed.add(best.id);
        this.pop(p, `タレットに弾薬 +${n}`, '#ffd84d', 'craft');
      }
      return;
    }
    if (best) {
      this.loot(p, best);
      return;
    }
    // アイテム使用（HPが減っていれば救急キット、そうでなければ食料）
    if (p.hp < p.maxHp - 25 && this.useMedkit(p, false)) return;
    if (p.hunger < 75 && this.useFood(p, false)) return;
    if (!this.useMedkit(p, false) && !this.useFood(p, false)) this.pop(p, '近くに調べるものがない', '#aaaaaa');
  }

  /** クレートのランク：軍用=3、ロケーションのランク、なければ中心からの距離 */
  private lootTier(o: SimObj): number {
    if (o.kind === 'mcrate') return 3;
    if (o.kind === 'box') return 0;
    const loc = locationAt(this.world.locations, o.tx, o.ty);
    if (loc) return loc.tier;
    return Math.hypot(o.tx - 40, o.ty - 30) > 26 ? 2 : 1;
  }

  private loot(p: SimPlayer, o: SimObj): void {
    o.ready = 0;
    const tier = this.lootTier(o);
    o.regrowT = o.kind === 'mcrate' ? REGROW.mcrate : o.kind === 'crate' ? REGROW.crate + tier * 40 : 0;
    this.changed.add(o.id);
    const parts: string[] = [];
    const R = Math.random;
    const roll = (chance: number, min: number, max: number) => (R() < chance ? min + Math.floor(R() * (max - min + 1)) : 0);
    const give = (label: string, n: number, apply: (n: number) => void) => {
      if (n <= 0) return;
      apply(n);
      parts.push(`${label}+${n}`);
    };
    const inv = p.inv;
    // ランク別の物資テーブル（遠く危険な場所ほど武器系・レア素材）
    if (tier === 0) {
      // 拠点の収納箱（毎朝補充）
      give('食料', roll(0.8, 1, 2), (n) => (inv.food += n));
      give('布', roll(0.5, 1, 2), (n) => (inv.cloth += n));
      give('薬草', roll(0.4, 1, 1), (n) => (inv.herb += n));
      give('弾薬', roll(0.4, 4, 8), (n) => (inv.ammo += n));
    } else if (tier === 1) {
      give('食料', roll(0.4, 1, 1), (n) => (inv.food += n));
      give('布', roll(0.4, 1, 3), (n) => (inv.cloth += n));
      give('薬草', roll(0.35, 1, 2), (n) => (inv.herb += n));
      give('木材', roll(0.45, 2, 5), (n) => (this.stash.wood += n));
      give('弾薬', roll(0.25, 3, 6), (n) => (inv.ammo += n));
      give('火薬', roll(0.2, 1, 1), (n) => (inv.gunpowder += n));
      give('救急', roll(0.04, 1, 1), (n) => (inv.medkit += n));
    } else if (tier === 2) {
      give('弾薬', roll(0.5, 5, 10), (n) => (inv.ammo += n));
      give('火薬', roll(0.5, 1, 3), (n) => (inv.gunpowder += n));
      give('鉄', roll(0.5, 2, 5), (n) => (this.stash.scrap += n));
      give('シェル', roll(0.25, 2, 5), (n) => (inv.shells += n));
      give('布', roll(0.25, 1, 2), (n) => (inv.cloth += n));
      give('食料', roll(0.25, 1, 1), (n) => (inv.food += n));
      give('武器パーツ', roll(0.1, 1, 1), (n) => (inv.parts += n));
      give('救急', roll(0.08, 1, 1), (n) => (inv.medkit += n));
    } else {
      give('弾薬', roll(0.75, 10, 18), (n) => (inv.ammo += n));
      give('シェル', roll(0.5, 4, 8), (n) => (inv.shells += n));
      give('火薬', roll(0.6, 2, 4), (n) => (inv.gunpowder += n));
      give('武器パーツ', roll(0.6, 1, 2), (n) => (inv.parts += n));
      give('救急', roll(0.25, 1, 1), (n) => (inv.medkit += n));
      if (!inv.shotgun && R() < 0.22) {
        inv.shotgun = 1;
        inv.smag = WEAPONS.shotgun.magSize;
        parts.unshift('★ショットガン入手！ [3]');
      }
    }
    if (parts.length === 0) {
      inv.food += 1;
      parts.push('食料+1');
    }
    this.events.push({ k: 'pop', x: (o.tx + 0.5) * TILE, y: o.ty * TILE - 6, t: parts.join('  '), c: tier >= 3 ? '#ffb86b' : '#ffe08a', id: p.id, s: 'loot' });
  }

  private swingAxe(p: SimPlayer): void {
    if (p.stamina < PLAYER.meleeStamina) {
      if (p.warnCd <= 0) {
        this.pop(p, 'スタミナ切れ！', '#ffb347');
        p.warnCd = 1;
      }
      return;
    }
    p.stamina -= PLAYER.meleeStamina;
    p.staminaDelay = PLAYER.staminaDelay;
    p.swings++;
    this.makeNoise(p.x, p.y, AXE.noiseRadius);
    // ゾンビへの近接攻撃
    let hits = 0;
    for (const z of this.zombies) {
      if (z.dead || hits >= 3) continue;
      const r = ZOMBIE[z.type].radius;
      const dx = z.x - p.x;
      const dy = z.y - p.y;
      const d = Math.hypot(dx, dy);
      if (d > AXE.range + r) continue;
      if (Math.abs(angleDiff(p.aim, Math.atan2(dy, dx))) > AXE.arc / 2 && d > r + PLAYER.radius) continue;
      this.events.push({ k: 'hit', x: z.x - (dx / (d || 1)) * r * 0.6, y: z.y - (dy / (d || 1)) * r * 0.6, o: p.id, a: Math.atan2(dy, dx), m: 1 });
      this.damageZombie(z, AXE.damage * (p.inv.axe ? 1.6 : 1), p.id, dx, dy, 260);
      hits++;
    }
    if (hits > 0) return;
    // 資源の解体（木・廃車）
    for (const dist of [30, 52]) {
      const tx = Math.floor((p.x + Math.cos(p.aim) * dist) / TILE);
      const ty = Math.floor((p.y + Math.sin(p.aim) * dist) / TILE);
      const o = this.world.objAt(tx, ty);
      if (!o || (o.kind !== 'tree' && o.kind !== 'car') || o.hp <= 0) continue;
      this.harvest(p, o);
      return;
    }
  }

  private harvest(p: SimPlayer, o: SimObj): void {
    o.hp -= AXE.harvestDamage * (p.inv.axe ? 2 : 1);
    this.changed.add(o.id);
    const x = (o.tx + 0.5) * TILE;
    const y = (o.ty + 0.5) * TILE;
    this.events.push({ k: 'chop', x, y, kind: o.kind });
    let text: string;
    if (o.kind === 'tree') {
      this.stash.wood += 2;
      text = '木材+2';
      if (o.hp <= 0) {
        this.stash.wood += 4;
        text = '木材+6';
      }
    } else {
      this.stash.scrap += 1;
      text = '鉄+1';
      if (Math.random() < 0.15) {
        p.inv.gunpowder += 1;
        text += ' 火薬+1';
      }
      if (o.hp <= 0) {
        this.stash.scrap += 4;
        text = '鉄+5';
      }
    }
    if (o.hp <= 0) {
      o.hp = 0;
      o.regrowT = o.kind === 'tree' ? REGROW.tree : REGROW.car;
      this.events.push({ k: 'break', x, y, kind: o.kind });
    }
    this.events.push({ k: 'pop', x, y: y - 24, t: text, c: o.kind === 'tree' ? '#d9a66b' : '#c9d3e6', id: p.id });
  }

  private build(p: SimPlayer, kind: BuildKind): void {
    const { tx, ty } = p;
    if (!this.world.inBounds(tx, ty)) return;
    const cx = (tx + 0.5) * TILE;
    const cy = (ty + 0.5) * TILE;
    if (Math.hypot(cx - p.x, cy - p.y) > PLAYER.buildRange) return;
    if (this.world.terrainAt(tx, ty) === T_WALL || this.world.objAt(tx, ty)) return;
    if (kind === 'turret' && p.inv.kit <= 0) {
      if (p.warnCd <= 0) {
        this.pop(p, 'タレットキットが必要（作業台でクラフト）', '#ff8080');
        p.warnCd = 1.2;
      }
      return;
    }
    if (kind === 'woodWall' || kind === 'ironWall' || kind === 'turret') {
      for (const pl of this.players) if (pl.status !== 'dead' && circleOverlapsTile(pl.x, pl.y, PLAYER.radius, tx, ty)) return;
      for (const z of this.zombies) if (circleOverlapsTile(z.x, z.y, ZOMBIE[z.type].radius, tx, ty)) return;
    }
    const cost = BUILD_COST[kind];
    if (this.stash.wood < cost.wood || this.stash.scrap < cost.scrap) {
      if (p.warnCd <= 0) {
        this.pop(p, cost.wood ? `木材が足りない（${cost.wood}必要）` : `鉄スクラップが足りない（${cost.scrap}必要）`, '#ff8080');
        p.warnCd = 1.2;
      }
      return;
    }
    this.stash.wood -= cost.wood;
    this.stash.scrap -= cost.scrap;
    const hp = OBJ_HP[kind];
    const o: SimObj = { id: this.nextBuildId++, kind, tx, ty, hp, maxHp: hp, ready: 1, regrowT: 0 };
    if (kind === 'turret') {
      p.inv.kit--;
      o.ready = TURRET.startAmmo;
      o.owner = p.id;
      o.cd = 0;
    }
    this.world.setObj(o);
    this.changed.add(o.id);
    p.builds++;
    this.events.push({ k: 'build', x: cx, y: cy, kind });
    this.flowTimer = Math.min(this.flowTimer, 0.1); // 経路を即再計算
  }

  private repair(p: SimPlayer): void {
    let target = this.world.objAt(p.tx, p.ty);
    const ok = (o: SimObj | undefined) =>
      !!o && (BREAKABLE_KINDS.has(o.kind) || o.kind === 'spike' || o.kind === 'barbed' || o.kind === 'torch') && o.hp < o.maxHp;
    if (!ok(target)) {
      // カーソル位置になければ正面のタイル
      const tx = Math.floor((p.x + Math.cos(p.aim) * 36) / TILE);
      const ty = Math.floor((p.y + Math.sin(p.aim) * 36) / TILE);
      target = this.world.objAt(tx, ty);
      if (!ok(target)) return;
    }
    const o = target!;
    const cx = (o.tx + 0.5) * TILE;
    const cy = (o.ty + 0.5) * TILE;
    if (Math.hypot(cx - p.x, cy - p.y) > PLAYER.buildRange * 0.7) return;
    const useScrap = o.kind === 'ironWall' || o.kind === 'stone' || o.kind === 'barbed' || o.kind === 'turret';
    if (useScrap ? this.stash.scrap < 1 : this.stash.wood < 1) {
      if (p.warnCd <= 0) {
        this.pop(p, useScrap ? '修理に鉄スクラップが必要' : '修理に木材が必要', '#ff8080');
        p.warnCd = 1.2;
      }
      return;
    }
    if (useScrap) this.stash.scrap -= 1;
    else this.stash.wood -= 1;
    o.hp = Math.min(o.maxHp, o.hp + REPAIR.amount);
    this.changed.add(o.id);
    this.events.push({ k: 'pop', x: cx, y: cy - 20, t: `修理 +${REPAIR.amount}`, c: '#7dd3ff', id: p.id });
    this.events.push({ k: 'build', x: cx, y: cy, kind: o.kind });
  }

  private updateRevive(dt: number): void {
    for (const d of this.players) {
      if (d.status !== 'down') continue;
      const reviver = this.players.find(
        (p) => p !== d && p.status === 'alive' && p.revive && Math.hypot(p.x - d.x, p.y - d.y) <= PLAYER.reviveRange,
      );
      if (reviver) {
        d.reviveProgress += dt;
        if (d.reviveProgress >= PLAYER.reviveTime) {
          d.status = 'alive';
          d.hp = d.maxHp * PLAYER.reviveHpRatio;
          d.hunger = Math.max(d.hunger, 30);
          d.reviveProgress = 0;
          d.downTimer = 0;
          this.events.push({ k: 'revive', id: d.id, x: d.x, y: d.y });
        }
      } else {
        d.reviveProgress = Math.max(0, d.reviveProgress - dt * 1.5);
      }
    }
  }

  private damagePlayer(p: SimPlayer, dmg: number): void {
    if (p.status !== 'alive') return;
    p.hp -= dmg;
    this.events.push({ k: 'phit', id: p.id });
    this.events.push({ k: 'dmg', x: p.x, y: p.y - 20, v: Math.round(dmg), p: true });
    if (p.hp <= 0) this.downPlayer(p);
  }

  private downPlayer(p: SimPlayer): void {
    p.hp = 0;
    p.status = 'down';
    p.downTimer = PLAYER.downTime;
    p.reviveProgress = 0;
    p.fire = false;
    p.dashTime = 0;
    p.reloadT = 0;
    this.events.push({ k: 'down', id: p.id, x: p.x, y: p.y });
  }

  // ======================== 騒音 ========================

  private makeNoise(x: number, y: number, radius: number): void {
    if (radius >= 300) this.events.push({ k: 'noise', x, y, r: radius });
    for (const z of this.zombies) {
      if (z.horde) continue;
      const d = Math.hypot(z.x - x, z.y - y);
      if (d > radius) continue;
      z.noiseX = x + (Math.random() - 0.5) * 80;
      z.noiseY = y + (Math.random() - 0.5) * 80;
      z.hasNoise = true;
      if (d < radius * 0.45) z.aggroT = Math.max(z.aggroT, ZOMBIE_SENSE.aggroMemory * 0.6);
    }
  }

  // ======================== フローフィールド（ゾンビの経路探索） ========================

  /** タイルに入るコスト（-1 = 通行不可）。建築壁は「壊して進む」ためのコスト付き */
  private enterCost(i: number): number {
    if (this.world.terrain[i] === T_WALL) return -1;
    const o = this.world.objAt(i % MAP_W, Math.floor(i / MAP_W));
    if (!o) return 1;
    if (BREAKABLE_KINDS.has(o.kind)) return 3 + o.hp / 35;
    if (o.kind === 'spike' || o.kind === 'barbed') return 5;
    return objIsSolid(o) ? -1 : 1;
  }

  /** 全生存プレイヤーからの多始点 Dijkstra */
  private computeFlow(): void {
    const flow = this.flow;
    flow.fill(Infinity);
    const heap = new MinHeap();
    for (const p of this.players) {
      if (p.status !== 'alive') continue;
      const tx = Math.floor(p.x / TILE);
      const ty = Math.floor(p.y / TILE);
      const i = ty * MAP_W + tx;
      flow[i] = 0;
      heap.push(0, i);
    }
    const cost = new Float64Array(MAP_W * MAP_H).fill(-2);
    const getCost = (i: number) => {
      if (cost[i] === -2) cost[i] = this.enterCost(i);
      return cost[i];
    };
    while (heap.size > 0) {
      const [d, i] = heap.pop();
      if (d > flow[i]) continue;
      const x = i % MAP_W;
      const y = (i - x) / MAP_W;
      for (const [dx, dy, w] of NEIGHBORS) {
        const nx = x + dx;
        const ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= MAP_W || ny >= MAP_H) continue;
        const j = ny * MAP_W + nx;
        const c = getCost(j);
        if (c < 0) continue;
        if (dx && dy) {
          // 斜め移動は角をすり抜けない
          if (getCost(y * MAP_W + nx) !== 1 || getCost(ny * MAP_W + x) !== 1) continue;
        }
        const nd = d + c * w;
        if (nd < flow[j]) {
          flow[j] = nd;
          heap.push(nd, j);
        }
      }
    }
  }

  // ======================== ゾンビ ========================

  private updateSpawning(dt: number): void {
    this.spawnTimer -= dt;
    if (this.spawnTimer > 0) return;
    const alive = this.players.filter((p) => p.status === 'alive');
    if (alive.length === 0) return;

    if (this.phase === 'horde' && this.hordeSpawned < this.hordeQuota) {
      const group = 2 + Math.floor(Math.random() * 3);
      const anchor = alive[Math.floor(Math.random() * alive.length)];
      const ang = Math.random() * Math.PI * 2;
      for (let i = 0; i < group && this.hordeSpawned < this.hordeQuota; i++) {
        const pos = this.findSpawn(anchor.x + Math.cos(ang) * 820, anchor.y + Math.sin(ang) * 820, 160, 600);
        if (!pos) break;
        const r = Math.random();
        const bruteRate = Math.min(0.24, 0.08 + 0.014 * this.day);
        const type: ZombieType = r < bruteRate ? 'brute' : r < 0.45 ? 'runner' : 'walker';
        this.spawnZombie(type, pos.x, pos.y, true);
        this.hordeSpawned++;
      }
      this.spawnTimer = Math.max(0.35, 1.25 - this.day * 0.05) / (1 + 0.25 * (this.players.length - 1));
      return;
    }

    // 誰もいない★3ロケーションには見張りを補充
    if (Math.random() < 0.1) {
      for (const loc of this.world.locations) {
        if (loc.tier < 3) continue;
        const cx = (loc.x + loc.w / 2) * TILE;
        const cy = (loc.y + loc.h / 2) * TILE;
        if (this.players.some((p) => Math.hypot(p.x - cx, p.y - cy) < 700)) continue;
        const guards = this.zombies.filter((z) => Math.hypot(z.x - cx, z.y - cy) < 360).length;
        if (guards < 5) this.spawnGuard(loc);
      }
    }
    const roaming = this.zombies.filter((z) => !z.horde).length;
    const night = this.phase !== 'day';
    const target = Math.min(60, night ? 14 + this.day * 3 : 8 + this.day * 2) * (1 + 0.4 * (this.players.length - 1));
    if (roaming < target && this.zombies.length < MAX_ZOMBIES) {
      const pos = this.findSpawn(Math.random() * WORLD_W, Math.random() * WORLD_H, 2000, night ? 520 : 680);
      if (pos) {
        const r = Math.random();
        let type: ZombieType = 'walker';
        if (night && r < 0.3) type = 'runner';
        else if (!night && r < 0.08) type = 'runner';
        if (this.day >= 3 && r > 0.93) type = 'brute';
        this.spawnZombie(type, pos.x, pos.y, false);
      }
    }
    this.spawnTimer = night ? 0.7 : 1.4;
  }

  /** 出現位置を探す（プレイヤーから minDist 以上離れた通行可能タイル） */
  private findSpawn(cx: number, cy: number, spread: number, minDist: number): { x: number; y: number } | null {
    for (let tries = 0; tries < 25; tries++) {
      const x = Math.min(WORLD_W - 30, Math.max(30, cx + (Math.random() - 0.5) * 2 * spread));
      const y = Math.min(WORLD_H - 30, Math.max(30, cy + (Math.random() - 0.5) * 2 * spread));
      const tx = Math.floor(x / TILE);
      const ty = Math.floor(y / TILE);
      if (this.world.solid(tx, ty)) continue;
      const sh = SAFEHOUSE;
      if (tx >= sh.x - 1 && tx <= sh.x + sh.w && ty >= sh.y - 1 && ty <= sh.y + sh.h) continue;
      if (this.players.some((p) => p.status !== 'dead' && Math.hypot(p.x - x, p.y - y) < minDist)) continue;
      return { x: (tx + 0.5) * TILE, y: (ty + 0.5) * TILE };
    }
    return null;
  }

  /** ★3ロケーションの見張りゾンビ */
  private spawnGuard(loc: { x: number; y: number; w: number; h: number }): void {
    for (let t = 0; t < 10; t++) {
      const tx = loc.x + 1 + Math.floor(Math.random() * (loc.w - 2));
      const ty = loc.y + 1 + Math.floor(Math.random() * (loc.h - 2));
      if (this.world.solid(tx, ty)) continue;
      const r = Math.random();
      this.spawnZombie(r < 0.15 ? 'brute' : r < 0.45 ? 'runner' : 'walker', (tx + 0.5) * TILE, (ty + 0.5) * TILE, false);
      return;
    }
  }

  private spawnZombie(type: ZombieType, x: number, y: number, horde: boolean): void {
    // 大襲撃のゾンビは人数が多いほどタフになる（火力の増加分を相殺）
    const teamMul = horde ? 1 + 0.1 * (this.players.length - 1) : 1;
    const hp = ZOMBIE[type].hp * (1 + 0.08 * (this.day - 1)) * teamMul;
    this.zombies.push({
      id: this.nextId++,
      type,
      x,
      y,
      angle: Math.random() * Math.PI * 2,
      hp,
      maxHp: hp,
      flash: 0,
      horde,
      atk: 0,
      kx: 0,
      ky: 0,
      attackCd: 0,
      aggroT: horde ? 999 : 0,
      noiseX: 0,
      noiseY: 0,
      hasNoise: false,
      wanderA: Math.random() * Math.PI * 2,
      wanderT: 0,
      speedMul: 0.85 + Math.random() * 0.3,
      spikeAcc: 0,
      dead: false,
    });
  }

  private nearestAlive(x: number, y: number): { p: SimPlayer; d: number } | null {
    let best: SimPlayer | null = null;
    let bd = Infinity;
    for (const p of this.players) {
      if (p.status !== 'alive') continue;
      const d = Math.hypot(p.x - x, p.y - y);
      if (d < bd) {
        bd = d;
        best = p;
      }
    }
    return best ? { p: best, d: bd } : null;
  }

  private updateZombie(z: SimZombie, dt: number): void {
    const st = ZOMBIE[z.type];
    const night = this.phase !== 'day';
    z.flash = Math.max(0, z.flash - dt);
    z.attackCd = Math.max(0, z.attackCd - dt);
    if (!z.horde) z.aggroT = Math.max(0, z.aggroT - dt);

    let speed = (night ? st.nightSpeed : st.daySpeed) * z.speedMul;
    const near = this.nearestAlive(z.x, z.y);

    // ---- 感知 ----
    if (near && !z.horde) {
      const range = night ? ZOMBIE_SENSE.nightRange : ZOMBIE_SENSE.dayRange;
      if (near.d < range && this.world.lineClear(z.x, z.y, near.p.x, near.p.y)) {
        z.aggroT = ZOMBIE_SENSE.aggroMemory;
        z.hasNoise = false;
      }
    }
    const aggro = !!near && (z.horde || z.aggroT > 0);

    // ---- 目的方向の決定 ----
    let dx = 0;
    let dy = 0;
    let wantAttackTile: SimObj | null = null;
    if (aggro && near) {
      const tdx = near.p.x - z.x;
      const tdy = near.p.y - z.y;
      if (near.d < 240 && this.world.lineClear(z.x, z.y, near.p.x, near.p.y)) {
        dx = tdx / (near.d || 1);
        dy = tdy / (near.d || 1);
      } else {
        const step = this.flowStep(z);
        if (step) {
          dx = step.dx;
          dy = step.dy;
          wantAttackTile = step.obstacle;
        } else {
          dx = tdx / (near.d || 1);
          dy = tdy / (near.d || 1);
        }
      }
    } else if (z.hasNoise) {
      const ndx = z.noiseX - z.x;
      const ndy = z.noiseY - z.y;
      const nd = Math.hypot(ndx, ndy);
      if (nd < 30) z.hasNoise = false;
      else {
        dx = ndx / nd;
        dy = ndy / nd;
        speed *= 0.85;
      }
    } else {
      z.wanderT -= dt;
      if (z.wanderT <= 0) {
        z.wanderT = 2 + Math.random() * 4;
        z.wanderA = Math.random() < 0.3 ? NaN : Math.random() * Math.PI * 2;
      }
      if (!Number.isNaN(z.wanderA)) {
        dx = Math.cos(z.wanderA);
        dy = Math.sin(z.wanderA);
        speed *= 0.4;
      }
    }

    // ---- スパイク罠 ----
    const tile = this.world.objAt(Math.floor(z.x / TILE), Math.floor(z.y / TILE));
    if (tile && tile.kind === 'barbed' && tile.hp > 0) {
      speed *= BARBED.slow;
      const dmg = BARBED.dps * dt;
      z.spikeAcc += dmg;
      z.hp -= dmg;
      tile.hp -= BARBED.wearPerSec * dt;
      this.changed.add(tile.id);
      if (tile.hp <= 0) this.destroyObj(tile);
      if (z.spikeAcc >= 10) {
        this.events.push({ k: 'dmg', x: z.x, y: z.y - st.radius, v: Math.round(z.spikeAcc), p: false });
        z.spikeAcc = 0;
      }
      if (z.hp <= 0) {
        this.killZombie(z, -1);
        return;
      }
    }
    if (tile && tile.kind === 'spike' && tile.hp > 0) {
      speed *= SPIKE.slow;
      const dmg = SPIKE.dps * dt;
      z.spikeAcc += dmg;
      tile.hp -= SPIKE.wearPerSec * dt;
      this.changed.add(tile.id);
      if (tile.hp <= 0) this.destroyObj(tile);
      z.hp -= dmg;
      z.flash = Math.max(z.flash, 0.03);
      if (z.spikeAcc >= 10) {
        this.events.push({ k: 'dmg', x: z.x, y: z.y - st.radius, v: Math.round(z.spikeAcc), p: false });
        z.spikeAcc = 0;
      }
      if (z.hp <= 0) {
        this.killZombie(z, -1);
        return;
      }
    }

    // ---- 移動 ----
    if (dx || dy) z.angle = Math.atan2(dy, dx);
    const decay = Math.exp(-6 * dt);
    z.kx *= decay;
    z.ky *= decay;
    const collided: { tx: number; ty: number }[] = [];
    moveCircle(z, (dx * speed + z.kx) * dt, (dy * speed + z.ky) * dt, st.radius, this.world, collided);

    // ---- 攻撃（プレイヤー → 建築物の順） ----
    if (z.attackCd > 0) return;
    if (near && near.d < st.radius + PLAYER.radius + 6) {
      this.damagePlayer(near.p, st.damage);
      z.attackCd = st.attackInterval;
      z.atk++;
      return;
    }
    if (!aggro && !z.hasNoise) return;
    let target: SimObj | null = null;
    if (wantAttackTile && this.distToTile(z, wantAttackTile.tx, wantAttackTile.ty) < st.radius + 8) target = wantAttackTile;
    if (!target) {
      for (const c of collided) {
        const o = this.world.objAt(c.tx, c.ty);
        if (o && BREAKABLE_KINDS.has(o.kind)) {
          target = o;
          break;
        }
      }
    }
    if (target) {
      target.hp -= st.wallDamage * (this.phase === 'horde' ? 1.15 : 1);
      this.changed.add(target.id);
      z.attackCd = st.attackInterval;
      z.atk++;
      z.angle = Math.atan2((target.ty + 0.5) * TILE - z.y, (target.tx + 0.5) * TILE - z.x);
      const cx = (target.tx + 0.5) * TILE;
      const cy = (target.ty + 0.5) * TILE;
      this.events.push({ k: 'smash', x: cx, y: cy, kind: target.kind });
      if (target.hp <= 0) this.destroyObj(target);
    }
  }

  private distToTile(z: { x: number; y: number }, tx: number, ty: number): number {
    const cx = Math.max(tx * TILE, Math.min(z.x, tx * TILE + TILE));
    const cy = Math.max(ty * TILE, Math.min(z.y, ty * TILE + TILE));
    return Math.hypot(z.x - cx, z.y - cy);
  }

  /** フローフィールドに沿った次の一歩 */
  private flowStep(z: SimZombie): { dx: number; dy: number; obstacle: SimObj | null } | null {
    const tx = Math.floor(z.x / TILE);
    const ty = Math.floor(z.y / TILE);
    const here = this.flow[ty * MAP_W + tx];
    let best = here;
    let bx = -1;
    let by = -1;
    for (const [dx, dy] of NEIGHBORS) {
      const nx = tx + dx;
      const ny = ty + dy;
      if (nx < 0 || ny < 0 || nx >= MAP_W || ny >= MAP_H) continue;
      if (dx && dy && (this.world.solid(tx + dx, ty) || this.world.solid(tx, ty + dy))) continue;
      const v = this.flow[ny * MAP_W + nx];
      if (v < best) {
        best = v;
        bx = nx;
        by = ny;
      }
    }
    if (bx < 0 || !Number.isFinite(best)) return null;
    const cx = (bx + 0.5) * TILE;
    const cy = (by + 0.5) * TILE;
    const ddx = cx - z.x;
    const ddy = cy - z.y;
    const d = Math.hypot(ddx, ddy) || 1;
    const o = this.world.objAt(bx, by);
    return { dx: ddx / d, dy: ddy / d, obstacle: o && BREAKABLE_KINDS.has(o.kind) ? o : null };
  }

  private separateZombies(): void {
    const zs = this.zombies;
    for (let i = 0; i < zs.length; i++) {
      const a = zs[i];
      const ra = ZOMBIE[a.type].radius;
      for (let j = i + 1; j < zs.length; j++) {
        const b = zs[j];
        const dx = b.x - a.x;
        const dy = b.y - a.y;
        if (Math.abs(dx) > 50 || Math.abs(dy) > 50) continue;
        const rb = ZOMBIE[b.type].radius;
        const min = ra + rb;
        const d2 = dx * dx + dy * dy;
        if (d2 < min * min && d2 > 1e-4) {
          const d = Math.sqrt(d2);
          const push = (min - d) * 0.5;
          const nx = dx / d;
          const ny = dy / d;
          a.x -= nx * push;
          a.y -= ny * push;
          b.x += nx * push;
          b.y += ny * push;
        }
      }
      moveCircle(a, 0, 0, ra, this.world);
    }
  }

  private damageZombie(z: SimZombie, dmg: number, owner: number, dirX: number, dirY: number, knock: number): void {
    if (z.dead) return;
    z.hp -= dmg;
    z.flash = 0.08;
    const l = Math.hypot(dirX, dirY) || 1;
    const resist = z.type === 'brute' ? 0.25 : 1;
    z.kx += (dirX / l) * knock * resist;
    z.ky += (dirY / l) * knock * resist;
    if (!z.horde) z.aggroT = ZOMBIE_SENSE.aggroMemory;
    this.events.push({ k: 'dmg', x: z.x, y: z.y - ZOMBIE[z.type].radius, v: Math.round(dmg), p: false });
    if (z.hp <= 0) this.killZombie(z, owner, dirX / l, dirY / l);
  }

  private killZombie(z: SimZombie, owner: number, dx = 0, dy = 0): void {
    z.dead = true;
    const killer = this.players.find((p) => p.id === owner);
    if (killer) killer.kills++;
    this.events.push({ k: 'kill', x: z.x, y: z.y, r: ZOMBIE[z.type].radius, o: owner, t: z.type, id: z.id, a: z.angle, dx: Math.round(dx * 100) / 100, dy: Math.round(dy * 100) / 100 });
    // まれに物資をドロップ（拾う手間を省き直接付与）
    if (killer && Math.random() < 0.12) {
      const sg = killer.inv.shotgun && Math.random() < 0.35;
      const n = sg ? 2 + Math.floor(Math.random() * 3) : 4 + Math.floor(Math.random() * 6);
      if (sg) killer.inv.shells += n;
      else killer.inv.ammo += n;
      this.events.push({ k: 'pop', x: z.x, y: z.y - 26, t: sg ? `シェル+${n}` : `弾薬+${n}`, c: '#ffe08a', id: killer.id, s: 'loot' });
    }
  }

  // ======================== 弾 ========================

  private updateBullets(dt: number): void {
    for (const b of this.bullets) {
      if (b.dead) continue;
      for (let s = 0; s < 3 && !b.dead; s++) {
        b.x += (b.vx * dt) / 3;
        b.y += (b.vy * dt) / 3;
        if (b.x < 0 || b.y < 0 || b.x > WORLD_W || b.y > WORLD_H) {
          b.dead = true;
          break;
        }
        if (this.world.blocksBullet(Math.floor(b.x / TILE), Math.floor(b.y / TILE))) {
          b.dead = true;
          this.events.push({ k: 'wall', x: b.x - b.vx * 0.005, y: b.y - b.vy * 0.005, o: b.owner });
          break;
        }
        for (const z of this.zombies) {
          if (z.dead) continue;
          const r = ZOMBIE[z.type].radius + 3;
          if ((z.x - b.x) ** 2 + (z.y - b.y) ** 2 < r * r) {
            b.dead = true;
            this.events.push({ k: 'hit', x: b.x, y: b.y, o: b.owner, a: Math.atan2(b.vy, b.vx) });
            this.damageZombie(z, b.dmg, b.owner, b.vx, b.vy, b.knock);
            break;
          }
        }
      }
      b.life -= dt;
      if (b.life <= 0) b.dead = true;
    }
  }

  // ======================== オブジェクト ========================

  private destroyObj(o: SimObj): void {
    this.world.removeObj(o.id);
    this.changed.delete(o.id);
    this.removed.push(o.id);
    this.events.push({ k: 'break', x: (o.tx + 0.5) * TILE, y: (o.ty + 0.5) * TILE, kind: o.kind });
    this.flowTimer = Math.min(this.flowTimer, 0.1);
  }

  /** 自動タレット：射程内で視線の通る最寄りのゾンビを撃つ */
  private updateTurrets(dt: number): void {
    for (const o of this.world.objects.values()) {
      if (o.kind !== 'turret') continue;
      o.cd = Math.max(0, (o.cd ?? 0) - dt);
      if (o.cd > 0 || o.ready <= 0) continue;
      const x = (o.tx + 0.5) * TILE;
      const y = (o.ty + 0.5) * TILE;
      let best: SimZombie | null = null;
      let bd = TURRET.range;
      for (const z of this.zombies) {
        if (z.dead) continue;
        const d = Math.hypot(z.x - x, z.y - y);
        if (d < bd && this.world.lineClear(x, y, z.x, z.y)) {
          bd = d;
          best = z;
        }
      }
      if (!best) continue;
      const a = Math.atan2(best.y - y, best.x - x) + (Math.random() - 0.5) * 0.05;
      this.bullets.push({
        id: this.nextId++,
        owner: o.owner ?? -1,
        dmg: TURRET.damage,
        knock: 70,
        x: x + Math.cos(a) * 22,
        y: y + Math.sin(a) * 22,
        vx: Math.cos(a) * 1050,
        vy: Math.sin(a) * 1050,
        life: 0.45,
        dead: false,
      });
      o.ready--;
      o.cd = TURRET.fireInterval;
      this.changed.add(o.id);
      this.events.push({ k: 'tshot', x, y, a, id: o.id });
      this.makeNoise(x, y, TURRET.noise);
    }
  }

  private objTimer = 0;
  private updateObjects(dt: number): void {
    this.objTimer += dt;
    if (this.objTimer < 0.5) return;
    const step = this.objTimer;
    this.objTimer = 0;
    for (const o of this.world.objects.values()) {
      const depleted = ((o.kind === 'tree' || o.kind === 'car') && o.hp <= 0) || ((o.kind === 'crate' || o.kind === 'mcrate') && !o.ready);
      if (!depleted || o.regrowT <= 0) continue;
      o.regrowT -= step;
      if (o.regrowT > 0) continue;
      // 誰かが上に立っていたら少し待つ
      const blocked =
        o.kind !== 'crate' &&
        o.kind !== 'mcrate' &&
        (this.players.some((p) => circleOverlapsTile(p.x, p.y, PLAYER.radius, o.tx, o.ty)) ||
          this.zombies.some((z) => circleOverlapsTile(z.x, z.y, ZOMBIE[z.type].radius, o.tx, o.ty)));
      if (blocked) {
        o.regrowT = 3;
        continue;
      }
      if (o.kind === 'crate' || o.kind === 'mcrate') o.ready = 1;
      else o.hp = o.maxHp;
      this.changed.add(o.id);
      if (o.kind !== 'crate' && o.kind !== 'mcrate') this.flowTimer = Math.min(this.flowTimer, 0.1);
    }
  }
}

function toObjSnap(o: ObjSnap): ObjSnap {
  return { id: o.id, kind: o.kind, tx: o.tx, ty: o.ty, hp: Math.ceil(o.hp), maxHp: o.maxHp, ready: o.ready };
}
