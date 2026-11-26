// ============================================================
// HostSimulation: ホスト権限のゲーム計算（探索・漁り・生還型サバイバル）
//   - 時間経過（昼夜）。強制ウェーブはなく、ゾンビは各建物・危険地帯に潜んでいる
//   - ゾンビAI：視覚（向き・距離・懐中電灯の光）と聴覚（銃声・ドア・走る足音）で
//     徘徊 → 物音を調べる → 追跡 → 見失って捜索、と状態が変わる。閉じたドアは叩き壊す
//   - 入れ物（棚・ロッカー・武器ケースなど）は数秒の「探索」で中身が見られる
//   - バックパックはスロット制。拠点の倉庫に預けたものが「持ち帰った物資」
//   ソロ・ホスト時のみ実行され、ゲストはスナップショットを受け取るだけ
// ============================================================
import type {
  GameEvent,
  GameResult,
  InputFrame,
  LobbyPlayer,
  ObjKind,
  ObjSnap,
  PlayerSnap,
  Slot,
  Snapshot,
  SoundKey,
  StorageState,
  TimePhase,
  ViewState,
  Weather,
  ZombieSnap,
  ZombieType,
} from '../types';
import { Tool } from '../types';
import {
  AXE,
  BENCH_RANGE,
  BREAKABLE_KINDS,
  CAMPFIRE_TILE,
  CYCLE_SECONDS,
  DAY_SECONDS,
  MAP_H,
  MAP_W,
  MUZZLE,
  NIGHT_SECONDS,
  PLAYER,
  RECIPES,
  SAFEHOUSE,
  START_MINUTE,
  T_FENCE,
  T_WALL,
  T_WINDOW,
  TILE,
  USABLE_SLOTS,
  WORLD_H,
  WORLD_W,
  ZOMBIE,
} from './constants';
import {
  addItem,
  ammoOf,
  ATTACHMENTS,
  bagValue,
  countItem,
  effectiveStats,
  emptyBag,
  freeSlots,
  ITEMS,
  type ItemId,
  isWeapon,
  removeItem,
  WEAPON_STATS,
  type WeaponId,
} from './items';
import { angleDiff, circleOverlapsTile, moveCircle, stepMovement } from './physics';
import { type Facility, FACILITIES, MED_REGEN, SKILLS, levelOf, sanitizeProfile, skillMods, STORAGE_SIZES } from './progression';
import { BUILD_ID_START, generateWorld, type Location, locationAt, objIsSolid, TileWorld } from './world';

interface SimPlayer extends PlayerSnap {
  queue: InputFrame[];
  fire: boolean;
  revive: boolean;
  tx: number;
  ty: number;
  fireCd: number;
  swingCd: number;
  warnCd: number;
  useCd: number;
  idle: number;
  reloadSlot: 'prim' | 'sec' | '';
  search: { cid: number; t: number; dur: number; x: number; y: number } | null;
  /** 足音の発生タイマー */
  stepNoiseT: number;
  /** 興奮剤の残り時間 */
  stimT: number;
  /** レベルアップ表示済みのレベル */
  lv: number[];
}

type ZState = 'idle' | 'investigate' | 'chase' | 'search';

interface SimZombie extends ZombieSnap {
  kx: number;
  ky: number;
  attackCd: number;
  state: ZState;
  stateT: number;
  targetX: number;
  targetY: number;
  homeX: number;
  homeY: number;
  wanderA: number;
  wanderT: number;
  senseT: number;
  speedMul: number;
  stuckT: number;
  /** 巡回ルート（ロケーション間を移動する群れ） */
  route: { x: number; y: number }[] | null;
  routeI: number;
  dead: boolean;
}

interface SimObj extends ObjSnap {
  regrowT: number;
}

interface SimBullet {
  id: number;
  owner: number;
  dmg: number;
  knock: number;
  x: number;
  y: number;
  vx: number;
  vy: number;
  life: number;
  /** 残り貫通数 */
  pierce: number;
  ap: boolean;
  /** 当たったゾンビ（同じ敵に2回当たらないように） */
  hit: number[];
  dead: boolean;
}

const r1 = (v: number) => Math.round(v * 10) / 10;
const r2 = (v: number) => Math.round(v * 100) / 100;
const MAX_ZOMBIES = 150;
/** 天候ごとの効果：ゾンビの視覚距離・音の届く距離 */
const WEATHER_FX: Record<Weather, { sight: number; noise: number; name: string; desc: string }> = {
  clear: { sight: 1, noise: 1, name: '晴れ', desc: '' },
  fog: { sight: 0.55, noise: 1, name: '濃霧', desc: '霧で見通しが悪い。お互いに気づきにくい' },
  rain: { sight: 0.8, noise: 0.75, name: '雨', desc: '雨音が足音や銃声をかき消す' },
  storm: { sight: 0.65, noise: 0.6, name: '嵐', desc: '激しい雨と雷。音は遠くまで届かないが野外は危険' },
};
const BENCH_KINDS: ReadonlySet<ObjKind> = new Set<ObjKind>(['bench']);

/** 漁れる入れ物 */
export const CONTAINER_KINDS: ReadonlySet<ObjKind> = new Set<ObjKind>(['shelf', 'cabinet', 'locker', 'wcase', 'fridge', 'desk', 'crate', 'mcrate', 'car', 'box', 'bag', 'drop']);
/** 拠点の倉庫 */
export const STORAGE_KINDS: ReadonlySet<ObjKind> = new Set<ObjKind>(['chest', 'stash']);

/** 時刻（分）を計算：サイクル開始は 06:00 */
export function cycleToMinute(cycleT: number): number {
  if (cycleT < DAY_SECONDS) return 360 + (cycleT * 840) / DAY_SECONDS;
  return (1200 + ((cycleT - DAY_SECONDS) * 600) / NIGHT_SECONDS) % 1440;
}

/** 拠点の敷地内か（安全地帯） */
export function inBase(x: number, y: number): boolean {
  const sh = SAFEHOUSE;
  return x > sh.x * TILE && y > sh.y * TILE && x < (sh.x + sh.w) * TILE && y < (sh.y + sh.h) * TILE;
}

// ---------------- 物資テーブル [アイテム, 重み, 最小, 最大] ----------------
type LootRow = [ItemId | 'weapon' | 'attach', number, number, number];
const LOOT: Partial<Record<ObjKind, LootRow[]>> = {
  shelf: [['can', 5, 1, 2], ['cloth', 3, 1, 3], ['scrap', 3, 1, 3], ['bandage', 1, 1, 1], ['ammo9', 1.2, 4, 10], ['gunpowder', 1, 1, 1], ['valuables', 0.5, 1, 1], ['tools', 0.15, 1, 1]],
  fridge: [['can', 6, 1, 3], ['mre', 1, 1, 1]],
  cabinet: [['bandage', 5, 1, 2], ['chem', 4, 1, 2], ['medkit', 1.2, 1, 1], ['cloth', 2, 1, 2], ['stim', 0.35, 1, 1]],
  locker: [['ammo9', 4, 6, 14], ['cloth', 2, 1, 3], ['bandage', 2, 1, 1], ['parts', 1, 1, 1], ['valuables', 1, 1, 1], ['shells', 1, 2, 5], ['ammo9ap', 0.6, 4, 10], ['holo', 0.2, 1, 1]],
  desk: [['valuables', 3, 1, 2], ['electronics', 2, 1, 1], ['ammo9', 2, 3, 8], ['gunpowder', 1, 1, 2], ['chem', 1, 1, 1]],
  crate: [['scrap', 5, 2, 5], ['gunpowder', 3, 1, 2], ['parts', 1, 1, 1], ['cloth', 2, 1, 3], ['can', 1, 1, 1], ['tools', 0.35, 1, 1]],
  car: [['scrap', 5, 2, 4], ['gunpowder', 2, 1, 2], ['electronics', 1.2, 1, 1], ['can', 1, 1, 1], ['valuables', 0.6, 1, 1], ['tools', 0.3, 1, 1]],
  wcase: [['ammo762', 4, 8, 20], ['ammo9', 3, 10, 20], ['shells', 3, 4, 8], ['weapon', 2, 1, 1], ['attach', 1.5, 1, 1], ['parts', 2, 1, 2], ['ammo762ap', 1, 5, 12], ['slug', 0.8, 3, 6]],
  mcrate: [['ammo762', 5, 10, 25], ['shells', 3, 6, 12], ['mre', 2, 1, 2], ['medkit', 2, 1, 1], ['parts', 3, 1, 2], ['attach', 1.2, 1, 1], ['weapon', 0.8, 1, 1], ['ammo762ap', 1.5, 6, 14], ['stim', 0.6, 1, 1], ['tools', 0.6, 1, 1]],
  box: [['can', 3, 1, 2], ['bandage', 2, 1, 1], ['ammo9', 2, 6, 10], ['cloth', 1, 1, 2]],
  drop: [['ammo762ap', 3, 10, 20], ['weapon', 2.5, 1, 1], ['attach', 3, 1, 1], ['stim', 2, 1, 2], ['medkit', 2, 1, 2], ['tools', 2, 1, 2], ['mre', 1.5, 1, 2], ['electronics', 1.5, 1, 3], ['valuables', 1.5, 1, 3]],
};

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
  /** 入れ物の中身（初めて探索したときに生成） */
  contents = new Map<number, (Slot | null)[]>();
  storage: StorageState = { ver: 1, shared: emptyBag(STORAGE_SIZES[0].shared), personal: {} };
  /** 拠点設備のレベル */
  base: Record<Facility, number> = { bench: 1, storage: 0, med: 0, supply: 0 };
  weather: Weather = 'clear';
  /** 天候の強さ（0..1 でなめらかに切り替わる） */
  wx = 0;
  private nextWeather: Weather = 'clear';
  /** 補給物資（空中投下） */
  dropObj: number | null = null;
  private dropAt = -1;

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
  private nextObjId = BUILD_ID_START;
  // Float64 で保持する（Float32 だとヒープのキーとの丸め誤差で同じノードが何度も再投入され、計算が爆発する）
  private flow = new Float64Array(MAP_W * MAP_H);
  private flowTimer = 0;
  private spawnTimer = 5;
  private lastStorageSent = -1;
  private pingCd = new Map<number, number>();

  constructor(lobby: LobbyPlayer[], seed: number) {
    this.seed = seed;
    const gen = generateWorld(seed);
    this.world = new TileWorld<SimObj>(gen.terrain);
    for (const o of gen.objs) this.world.setObj({ ...o, regrowT: 0 });
    this.world.locations = gen.locations;
    this.world.buildings = gen.buildings;
    this.cycleT = ((START_MINUTE - 360) * DAY_SECONDS) / 840;

    const cx = (CAMPFIRE_TILE.x + 0.5) * TILE;
    const cy = (CAMPFIRE_TILE.y + 0.5) * TILE;
    lobby.forEach((lp, i) => {
      const a = (i / Math.max(1, lobby.length)) * Math.PI * 2;
      const p: SimPlayer = {
        id: lp.id,
        name: lp.name,
        x: cx - 60 + Math.cos(a) * 40,
        y: cy - 60 + Math.sin(a) * 40,
        bodyAngle: 0,
        aim: 0,
        hp: PLAYER.maxHp,
        maxHp: PLAYER.maxHp,
        hunger: 100,
        status: 'alive',
        downTimer: 0,
        reviveProgress: 0,
        tool: Tool.Secondary,
        bag: emptyBag(),
        prim: null,
        sec: null,
        reloadT: 0,
        shots: 0,
        swings: 0,
        kills: 0,
        searchId: 0,
        searchP: 0,
        viewing: 0,
        storage: 0,
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
        warnCd: 0,
        useCd: 0,
        idle: 0,
        reloadSlot: '',
        search: null,
        stepNoiseT: 0,
        stimT: 0,
        xp: sanitizeProfile(lp.prof).xp,
        lv: [],
        heat: 0,
      };
      p.lv = p.xp.map(levelOf);
      this.applySkills(p);
      p.stamina = p.stmMax ?? PLAYER.maxStamina;
      this.giveStarterKit(p);
      this.players.push(p);
      this.storage.personal[p.id] = emptyBag(STORAGE_SIZES[0].personal);
    });
    this.populate();
    this.spawnPatrols(3);
    this.dropAt = 25 + Math.random() * 40;
    // 初日の天候はランダム（霧で始まることもある）
    if (Math.random() < 0.3) this.setWeather(Math.random() < 0.5 ? 'fog' : 'rain', true);
    this.events.push({ k: 'banner', t: 'DAY 1', s: '建物を漁って物資を集め、生きて拠点に持ち帰れ', c: '#e0cfa8', snd: 'day' });
  }

  /** スキルを反映（最大スタミナ・回復速度） */
  private applySkills(p: SimPlayer): void {
    const m = skillMods(p.xp);
    p.stmMax = m.staminaMax;
    p.stmRegen = m.staminaRegenMul * (p.stimT > 0 ? 1.8 : 1);
  }

  /** スキル経験値を加える（レベルが上がったら知らせる） */
  private gainXp(p: SimPlayer, i: number, n: number): void {
    p.xp[i] = Math.min(1e6, p.xp[i] + n);
    const lv = levelOf(p.xp[i]);
    if (lv > (p.lv[i] ?? 0)) {
      p.lv[i] = lv;
      this.applySkills(p);
      this.events.push({ k: 'feed', t: `${p.name}：${SKILLS[i].name} Lv${lv}（${SKILLS[i].desc}）`, c: '#c9e08a', id: p.id, snd: 'level' });
      this.pop(p, `${SKILLS[i].name} Lv${lv}!`, '#c9e08a');
    }
  }

  private giveStarterKit(p: SimPlayer): void {
    p.sec = { id: 'pistol', n: 1, w: { mag: WEAPON_STATS.pistol.magSize } };
    p.prim = null;
    p.bag = emptyBag();
    addItem(p.bag, 'ammo9', 24);
    addItem(p.bag, 'bandage', 2);
    addItem(p.bag, 'can', 1);
    p.tool = Tool.Secondary;
  }

  // ======================== 外部API ========================

  /** 開発用：任意のオブジェクトを設置（監査スクリプト用） */
  debugPlace(kind: ObjKind, tx: number, ty: number): void {
    if (!this.world.inBounds(tx, ty) || this.world.solid(tx, ty) || this.world.objAt(tx, ty)) return;
    const o: SimObj = { id: this.nextObjId++, kind, tx, ty, hp: 1, maxHp: 1, ready: 1, regrowT: 0 };
    this.world.setObj(o);
    this.changed.add(o.id);
  }

  /** 開発用：アイテムを渡す */
  debugGive(playerId: number, id: ItemId, n: number): void {
    const p = this.players.find((pl) => pl.id === playerId);
    if (p) addItem(p.bag, id, n, isWeapon(id) ? { mag: WEAPON_STATS[id].magSize } : undefined);
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

  view(withStorage = true): ViewState {
    const cont: Record<number, (Slot | null)[]> = {};
    for (const p of this.players) if (p.viewing) cont[p.viewing] = this.contents.get(p.viewing) ?? [];
    return {
      time: r2(this.time),
      tick: this.tick,
      day: this.day,
      minute: Math.floor(this.minute()),
      phase: this.phase,
      cont,
      ...(withStorage ? { storage: this.storage } : {}),
      weather: this.weather,
      wx: r2(this.wx),
      base: this.base,
      drop: this.dropPos(),
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
        bag: p.bag,
        prim: p.prim,
        sec: p.sec,
        reloadT: r2(p.reloadT),
        shots: p.shots,
        swings: p.swings,
        kills: p.kills,
        searchId: p.search ? p.search.cid : 0,
        searchP: p.search ? r2(p.search.t / p.search.dur) : 0,
        viewing: p.viewing,
        storage: p.storage,
        ack: p.ack,
        dashTime: p.dashTime,
        dashCd: p.dashCd,
        dashDx: p.dashDx,
        dashDy: p.dashDy,
        stamina: r1(p.stamina),
        staminaDelay: r2(p.staminaDelay),
        stmMax: p.stmMax,
        stmRegen: r2(p.stmRegen ?? 1),
        xp: p.xp.map(Math.floor),
        heat: r2(p.heat),
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
        alert: z.state === 'chase' ? 2 : z.state === 'investigate' || z.state === 'search' ? 1 : 0,
        atk: z.atk,
      })),
      bullets: this.bullets.map((b) => ({ id: b.id, owner: b.owner, x: r1(b.x), y: r1(b.y), vx: Math.round(b.vx), vy: Math.round(b.vy) })),
    };
  }

  /** スナップショット（倉庫は変化したときだけ載せる） */
  snapshot(events: GameEvent[]): Snapshot {
    const send = this.storage.ver !== this.lastStorageSent;
    this.lastStorageSent = this.storage.ver;
    const d = this.takeObjDelta();
    return { ...this.view(send), events, objs: d.objs, removed: d.removed };
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
    this.updateContainers(dt);
    this.updateWeather(dt);
    this.updateAirdrop();
    this.zombies = this.zombies.filter((z) => !z.dead);
    this.bullets = this.bullets.filter((b) => !b.dead);

    if (this.players.length > 0 && !this.players.some((p) => p.status === 'alive' || p.status === 'down')) {
      this.gameOver = true;
      this.result = {
        day: this.day,
        players: this.players.map((p) => ({
          id: p.id,
          name: p.name,
          kills: p.kills,
          xp: p.xp.map(Math.floor),
          value: bagValue(this.storage.personal[p.id] ?? []) + Math.round(bagValue(this.storage.shared) / Math.max(1, this.players.length)),
        })),
      };
    }
  }

  // ======================== 時間・昼夜 ========================

  private updateClock(dt: number): void {
    const prev = this.phase;
    this.cycleT += dt;
    if (this.cycleT >= CYCLE_SECONDS) {
      this.cycleT -= CYCLE_SECONDS;
      this.day++;
    }
    this.phase = this.cycleT >= DAY_SECONDS ? 'night' : 'day';
    if (prev === this.phase) return;
    this.rollWeather();
    if (this.phase === 'night') {
      this.spawnPatrols(1 + Math.floor(Math.random() * 2));
      this.events.push({ k: 'banner', t: `DAY ${this.day} - 夜`, s: '闇が濃くなった。懐中電灯の光はゾンビにも見えている', c: '#aab4c8', snd: 'night' });
    } else {
      this.events.push({ k: 'banner', t: `DAY ${this.day}`, s: '夜を越えた。物資を集めて拠点へ持ち帰れ', c: '#e0cfa8', snd: 'day' });
      // 戦闘不能者は拠点で復帰（持ち物は倒れた場所に落ちたまま）
      const cx = (CAMPFIRE_TILE.x + 0.5) * TILE;
      const cy = (CAMPFIRE_TILE.y + 0.5) * TILE;
      for (const p of this.players) {
        if (p.status !== 'dead') continue;
        p.status = 'alive';
        p.hp = p.maxHp * 0.6;
        p.hunger = Math.max(p.hunger, 60);
        p.x = cx - 50;
        p.y = cy - 30;
        this.giveStarterKit(p);
        this.events.push({ k: 'revive', id: p.id, x: p.x, y: p.y });
      }
      // 拠点の収納箱は毎朝補充（補給所・医務室のレベルで中身が増える）
      for (const o of this.world.objects.values()) {
        if (o.kind === 'box') {
          o.ready = 1;
          this.contents.set(o.id, this.morningSupplies(o));
          this.changed.add(o.id);
        }
      }
      // 次の補給物資の投下時刻
      this.dropAt = 20 + Math.random() * 50;
    }
  }

  // ======================== プレイヤー ========================

  private updatePlayer(p: SimPlayer, dt: number): void {
    for (const f of p.queue) {
      const px = p.x;
      const py = p.y;
      const dashing = p.dashTime > 0;
      stepMovement(p, f, f.dt, p.status, this.world);
      if (!dashing && p.dashTime > 0) this.gainXp(p, 1, 1.5);
      if (p.status === 'alive' && p.dashTime > 0) p.stepNoiseT += f.dt * 3;
      else if (Math.hypot(p.x - px, p.y - py) > 0.5) p.stepNoiseT += f.dt;
      p.ack = f.seq;
      p.aim = f.aim;
      p.fire = f.fire;
      p.revive = f.revive;
      p.tx = f.tx;
      p.ty = f.ty;
      if (f.tool >= 0 && f.tool < USABLE_SLOTS && f.tool !== p.tool) {
        p.tool = f.tool;
        p.reloadT = 0;
      }
      if (p.status !== 'alive') continue;
      if (f.op) this.invOp(p, f.op);
      if (f.interact) this.interact(p);
      if (f.reload) this.startReload(p);
      if (f.craft) this.craft(p, f.craft);
      if (f.eat) this.useFood(p, true);
      if (f.heal) this.useMeds(p, true);
      if (f.ping) this.ping(p, f.tx, f.ty);
    }
    if (p.queue.length > 0) p.idle = 0;
    else if ((p.idle += dt) > 0.3) {
      p.fire = false;
      p.revive = false;
    }
    p.queue.length = 0;
    p.warnCd = Math.max(0, p.warnCd - dt);
    // 反動は時間で戻る
    p.heat = Math.max(0, p.heat - p.heat * 5 * dt - 0.02 * dt);
    if (p.stimT > 0) {
      p.stimT -= dt;
      if (p.stimT <= 0) this.applySkills(p);
    }

    if (p.status === 'down') {
      p.search = null;
      p.viewing = 0;
      if (p.reviveProgress <= 0) p.downTimer -= dt;
      if (p.downTimer <= 0) this.killPlayer(p);
      return;
    }
    if (p.status !== 'alive') return;

    // 足音（歩きは小さく、走ると遠くまで聞こえる）
    if (p.stepNoiseT > 0.45) {
      p.stepNoiseT = 0;
      this.makeNoise(p.x, p.y, p.dashTime > 0 ? 220 : 70, false);
    }

    // 空腹（拠点の焚き火のそばで休んでいる間は減らない）
    const cfx = (CAMPFIRE_TILE.x + 0.5) * TILE;
    const cfy = (CAMPFIRE_TILE.y + 0.5) * TILE;
    const resting = Math.hypot(p.x - cfx, p.y - cfy) < 170;
    if (!resting) p.hunger = Math.max(0, p.hunger - (100 / PLAYER.hungerSeconds) * dt);
    if (p.hunger <= 0) {
      p.hp -= PLAYER.starveDps * dt;
      if (p.warnCd <= 0) {
        this.pop(p, '空腹でHPが減っている！ [Q]で食事', '#c99a5a');
        p.warnCd = 6;
      }
      if (p.hp <= 0) this.downPlayer(p);
      if (p.status !== 'alive') return;
    }
    // 拠点の焚き火のそばで休むと HP が回復
    if (resting && p.hp < p.maxHp) p.hp = Math.min(p.maxHp, p.hp + MED_REGEN[this.base.med] * dt);

    // 探索の進行（動いたり攻撃を受けたら中断）
    if (p.search) {
      const s = p.search;
      const o = this.world.objects.get(s.cid);
      if (!o || Math.hypot(p.x - s.x, p.y - s.y) > 26) {
        p.search = null;
      } else {
        s.t += dt;
        if (s.t >= s.dur) {
          p.search = null;
          this.openContainer(p, o);
        }
      }
    }
    // 中身を見ている入れ物から離れたら閉じる
    if (p.viewing) {
      const o = this.world.objects.get(p.viewing);
      if (!o || Math.hypot((o.tx + 0.5) * TILE - p.x, (o.ty + 0.5) * TILE - p.y) > 100) p.viewing = 0;
    }
    if (p.storage && !this.nearKind(p, STORAGE_KINDS, 110)) p.storage = 0;

    // リロード
    if (p.reloadT > 0) {
      p.reloadT -= dt;
      if (p.reloadT <= 0) this.finishReload(p);
    }

    p.fireCd = Math.max(-1, p.fireCd - dt);
    p.swingCd = Math.max(0, p.swingCd - dt);
    p.useCd = Math.max(0, p.useCd - dt);
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
      case Tool.Primary:
      case Tool.Secondary: {
        const slot = p.tool === Tool.Primary ? p.prim : p.sec;
        if (slot && isWeapon(slot.id)) this.fireWeapon(p, slot);
        else if (p.warnCd <= 0) {
          this.pop(p, p.tool === Tool.Primary ? 'メイン武器がない（Tabで装備）' : 'サブ武器がない', '#c87a6a');
          p.warnCd = 1.5;
        }
        break;
      }
      case Tool.Meds:
        if (p.useCd <= 0) {
          this.useMeds(p, true);
          p.useCd = 0.8;
        }
        break;
      case Tool.Food:
        if (p.useCd <= 0) {
          this.useFood(p, true);
          p.useCd = 0.8;
        }
        break;
    }
  }

  private pop(p: SimPlayer, t: string, c: string, s?: SoundKey): void {
    this.events.push({ k: 'pop', x: p.x, y: p.y - 30, t, c, id: p.id, s: s ?? (c === '#c87a6a' ? 'error' : undefined) });
  }

  private fireWeapon(p: SimPlayer, slot: Slot): void {
    if (p.reloadT > 0 || !slot.w || !isWeapon(slot.id)) return;
    const w = effectiveStats(slot.id, slot.w);
    if (slot.w.mag <= 0) {
      if (countItem(p.bag, w.ammo) > 0) this.startReload(p);
      else if (p.warnCd <= 0) {
        this.pop(p, `${ITEMS[w.ammo].name}がない`, '#c87a6a');
        p.warnCd = 1.5;
      }
      return;
    }
    const sk = skillMods(p.xp);
    while (p.fireCd <= 0 && slot.w.mag > 0) {
      const spread = w.spread + p.heat;
      for (let i = 0; i < w.pellets; i++) {
        const a = p.aim + (Math.random() - 0.5) * 2 * spread;
        const sp = w.bulletSpeed * (w.pellets > 1 ? 0.85 + Math.random() * 0.3 : 1);
        this.bullets.push({
          id: this.nextId++,
          owner: p.id,
          dmg: w.damage,
          knock: w.knock,
          x: p.x + Math.cos(p.aim) * MUZZLE,
          y: p.y + Math.sin(p.aim) * MUZZLE,
          vx: Math.cos(a) * sp,
          vy: Math.sin(a) * sp,
          life: w.bulletLife * (w.pellets > 1 ? 0.8 + Math.random() * 0.4 : 1),
          pierce: w.pierce,
          ap: w.armorPierce,
          hit: [],
          dead: false,
        });
      }
      // 反動：連射するほどばらつきが増える（グリップ・スキルで軽減）
      p.heat = Math.min(0.35, p.heat + w.recoil * sk.recoilMul);
      slot.w.mag--;
      p.shots++;
      p.fireCd += w.fireInterval;
      this.makeNoise(p.x, p.y, w.noiseRadius, true);
      // セミオートは1クリック1発（押しっぱなしでも間隔を空けて撃つ）
      if (!w.auto) break;
    }
    if (slot.w.mag <= 0 && countItem(p.bag, w.ammo) > 0) this.startReload(p);
  }

  private startReload(p: SimPlayer): void {
    const key = p.tool === Tool.Primary ? 'prim' : p.tool === Tool.Secondary ? 'sec' : '';
    if (!key || p.reloadT > 0) return;
    const slot = p[key];
    if (!slot || !slot.w || !isWeapon(slot.id)) return;
    const w = effectiveStats(slot.id, slot.w);
    if (slot.w.mag >= w.magSize) return;
    if (countItem(p.bag, w.ammo) <= 0) {
      if (p.warnCd <= 0) {
        this.pop(p, `${ITEMS[w.ammo].name}がない`, '#c87a6a');
        p.warnCd = 1.5;
      }
      return;
    }
    p.reloadT = w.reloadTime * skillMods(p.xp).reloadMul;
    p.reloadSlot = key;
  }

  private finishReload(p: SimPlayer): void {
    p.reloadT = 0;
    const key = p.reloadSlot;
    p.reloadSlot = '';
    if (!key) return;
    const slot = p[key];
    if (!slot || !slot.w || !isWeapon(slot.id)) return;
    const w = effectiveStats(slot.id, slot.w);
    slot.w.mag += removeItem(p.bag, w.ammo, w.magSize - slot.w.mag);
  }

  private eat(p: SimPlayer, id: ItemId): void {
    removeItem(p.bag, id, 1);
    p.hunger = Math.min(100, p.hunger + (id === 'mre' ? 70 : 35));
    if (id === 'mre') p.hp = Math.min(p.maxHp, p.hp + 10);
    this.pop(p, `${ITEMS[id].name}を食べた`, '#c9a86a', 'eat');
  }

  private heal(p: SimPlayer, id: ItemId): void {
    removeItem(p.bag, id, 1);
    const v = Math.round((id === 'medkit' ? 65 : id === 'stim' ? 15 : 25) * skillMods(p.xp).healMul);
    p.hp = Math.min(p.maxHp, p.hp + v);
    if (id === 'stim') {
      p.stimT = 30;
      this.applySkills(p);
      p.stamina = p.stmMax ?? PLAYER.maxStamina;
      p.staminaDelay = 0;
    }
    this.gainXp(p, 3, id === 'medkit' ? 5 : 2);
    this.pop(p, id === 'stim' ? `興奮剤！ HP +${v}・スタミナ全快` : `HP +${v}`, '#8fbf8a', 'heal');
  }

  private useFood(p: SimPlayer, explicit: boolean): boolean {
    const id: ItemId | null = countItem(p.bag, 'can') > 0 ? 'can' : countItem(p.bag, 'mre') > 0 ? 'mre' : null;
    if (!id) {
      if (explicit) this.pop(p, '食料がない', '#c87a6a');
      return false;
    }
    if (p.hunger >= 98) {
      if (explicit) this.pop(p, 'お腹はいっぱい', '#cccccc');
      return false;
    }
    this.eat(p, id);
    return true;
  }

  private useMeds(p: SimPlayer, explicit: boolean): boolean {
    if (p.hp >= p.maxHp) {
      if (explicit) this.pop(p, 'HPは満タン', '#cccccc');
      return false;
    }
    // 減りが大きいときは救急キット、少ないときは包帯
    const big = p.maxHp - p.hp > 45;
    const hasK = countItem(p.bag, 'medkit') > 0;
    const hasB = countItem(p.bag, 'bandage') > 0;
    const id: ItemId | null = big && hasK ? 'medkit' : hasB ? 'bandage' : hasK ? 'medkit' : null;
    if (!id) {
      if (explicit) this.pop(p, '回復アイテムがない', '#c87a6a');
      return false;
    }
    this.heal(p, id);
    return true;
  }

  // ======================== インベントリ操作 ========================

  private invOp(p: SimPlayer, op: string): void {
    const parts = op.split(':');
    const [cmd, a, b] = parts;
    const n = (v: string | undefined) => Math.max(0, Math.floor(Number(v) || 0));
    switch (cmd) {
      case 'close':
        p.viewing = 0;
        p.storage = 0;
        break;
      case 'take': {
        // 入れ物 → バックパック
        if (n(a) !== p.viewing) return;
        const c = this.contents.get(p.viewing);
        const s = c?.[n(b)];
        if (!c || !s) return;
        const left = addItem(p.bag, s.id, s.n, s.w);
        if (left === s.n) return this.pop(p, 'バックパックがいっぱい', '#c87a6a');
        if (left > 0) s.n = left;
        else c[n(b)] = null;
        this.pop(p, ITEMS[s.id].name, '#d8c48a', 'loot');
        break;
      }
      case 'takeall': {
        if (n(a) !== p.viewing) return;
        const c = this.contents.get(p.viewing);
        if (!c) return;
        let any = false;
        for (let i = 0; i < c.length; i++) {
          const s = c[i];
          if (!s) continue;
          const left = addItem(p.bag, s.id, s.n, s.w);
          if (left < s.n) any = true;
          if (left > 0) s.n = left;
          else c[i] = null;
        }
        if (any) this.pop(p, '回収', '#d8c48a', 'loot');
        if (c.some((s) => s)) this.pop(p, 'バックパックがいっぱい', '#c87a6a');
        break;
      }
      case 'put': {
        // バックパック → 入れ物
        if (n(a) !== p.viewing) return;
        const c = this.contents.get(p.viewing);
        const s = p.bag[n(b)];
        if (!c || !s) return;
        const left = addItem(c, s.id, s.n, s.w);
        if (left > 0) s.n = left;
        else p.bag[n(b)] = null;
        break;
      }
      case 'use': {
        const s = p.bag[n(a)];
        if (!s) return;
        const cat = ITEMS[s.id].cat;
        if (cat === 'food') {
          if (p.hunger >= 98) return this.pop(p, 'お腹はいっぱい', '#cccccc');
          this.eat(p, s.id);
        } else if (cat === 'med') {
          if (p.hp >= p.maxHp) return this.pop(p, 'HPは満タン', '#cccccc');
          this.heal(p, s.id);
        } else if (isWeapon(s.id)) this.equip(p, n(a));
        break;
      }
      case 'equip':
        this.equip(p, n(a));
        break;
      case 'unequip': {
        const key = a === 'prim' ? 'prim' : 'sec';
        const s = p[key];
        if (!s) return;
        if (freeSlots(p.bag) <= 0) return this.pop(p, 'バックパックがいっぱい', '#c87a6a');
        addItem(p.bag, s.id, 1, s.w);
        p[key] = null;
        p.reloadT = 0;
        break;
      }
      case 'drop': {
        // 足元に置く（袋に入る）
        const s = p.bag[n(a)];
        if (!s) return;
        const bag = this.groundBag(p.x, p.y);
        if (!bag) return;
        const left = addItem(this.contents.get(bag.id)!, s.id, s.n, s.w);
        if (left > 0) s.n = left;
        else p.bag[n(a)] = null;
        this.changed.add(bag.id);
        break;
      }
      case 'st': {
        // 拠点の倉庫：st:put:shared:<bagIdx> / st:take:personal:<idx> / st:putall:shared
        if (!p.storage) return;
        const dir = parts[1];
        const box = parts[2] === 'shared' ? this.storage.shared : this.storage.personal[p.id];
        if (!box) return;
        const i = n(parts[3]);
        if (dir === 'put') {
          const s = p.bag[i];
          if (!s) return;
          const left = addItem(box, s.id, s.n, s.w);
          if (left === s.n) return this.pop(p, '倉庫がいっぱい', '#c87a6a');
          if (left > 0) s.n = left;
          else p.bag[i] = null;
        } else if (dir === 'putall') {
          // 武器以外を全部預ける
          for (let k = 0; k < p.bag.length; k++) {
            const s = p.bag[k];
            if (!s || isWeapon(s.id)) continue;
            const left = addItem(box, s.id, s.n, s.w);
            if (left > 0) s.n = left;
            else p.bag[k] = null;
          }
        } else if (dir === 'take') {
          const s = box[i];
          if (!s) return;
          const left = addItem(p.bag, s.id, s.n, s.w);
          if (left === s.n) return this.pop(p, 'バックパックがいっぱい', '#c87a6a');
          if (left > 0) s.n = left;
          else box[i] = null;
        }
        this.storage.ver++;
        break;
      }
      case 'ammo': {
        // 弾種の切り替え：ammo:prim|sec → 弾倉の中身をバッグに戻し、もう一方の弾で装填し直す
        const key = a === 'prim' ? 'prim' : 'sec';
        const slot = p[key];
        if (!slot || !slot.w || !isWeapon(slot.id)) return;
        const want = slot.w.ap ? 0 : 1;
        const next = ammoOf(slot.id, { ...slot.w, ap: want });
        if (countItem(p.bag, next) <= 0) return this.pop(p, `${ITEMS[next].name}を持っていない`, '#c87a6a');
        const left = addItem(p.bag, ammoOf(slot.id, slot.w), slot.w.mag);
        if (left > 0) return this.pop(p, 'バックパックがいっぱい', '#c87a6a');
        slot.w.mag = 0;
        if (want) slot.w.ap = 1;
        else delete slot.w.ap;
        this.pop(p, `${ITEMS[next].name}に切り替え`, '#d8c48a', 'craft');
        p.tool = key === 'prim' ? Tool.Primary : Tool.Secondary;
        p.reloadT = 0;
        this.startReload(p);
        break;
      }
      case 'give': {
        // 近くの仲間に直接渡す：give:<相手のID>:<バッグの位置>
        const to = this.players.find((q) => q.id === n(a) && q !== p && q.status === 'alive' && Math.hypot(q.x - p.x, q.y - p.y) < 160);
        const s = p.bag[n(b)];
        if (!to || !s) return this.pop(p, '仲間が近くにいない', '#c87a6a');
        const left = addItem(to.bag, s.id, s.n, s.w);
        if (left === s.n) return this.pop(p, `${to.name}のバッグがいっぱい`, '#c87a6a');
        if (left > 0) s.n = left;
        else p.bag[n(b)] = null;
        this.events.push({ k: 'pop', x: to.x, y: to.y - 30, t: `${p.name}から ${ITEMS[s.id].name}`, c: '#d8c48a', id: to.id, s: 'loot' });
        this.pop(p, `${to.name}に ${ITEMS[s.id].name} を渡した`, '#d8c48a');
        break;
      }
      case 'upg': {
        // 拠点設備の強化：upg:<facility>（バッグ → 共有倉庫の順に素材を使う）
        if (!this.nearKind(p, BENCH_KINDS, BENCH_RANGE)) return this.pop(p, '作業台の近くで行う', '#c87a6a');
        const def = FACILITIES.find((f) => f.id === a);
        if (!def) return;
        const lv = this.base[def.id];
        const cur = def.id === 'bench' ? lv - 1 : lv;
        const cost = def.costs[cur];
        if (!cost) return this.pop(p, 'これ以上強化できない', '#cccccc');
        const entries = Object.entries(cost) as [ItemId, number][];
        for (const [m, need] of entries)
          if (countItem(p.bag, m) + countItem(this.storage.shared, m) < need) return this.pop(p, `素材が足りない（${ITEMS[m].name}）`, '#c87a6a');
        for (const [m, need] of entries) {
          const got = removeItem(p.bag, m, need);
          if (got < need) removeItem(this.storage.shared, m, need - got);
        }
        this.base[def.id] = lv + 1;
        if (def.id === 'storage') this.resizeStorage();
        this.storage.ver++;
        this.events.push({ k: 'feed', t: `${p.name} が拠点の${def.name}を強化した（Lv${cur + 2}）`, c: '#e0cfa8', snd: 'level' });
        this.pop(p, `${def.name} 強化！`, '#e0cfa8', 'craft');
        break;
      }
      case 'mod': {
        // 武器にアタッチメントを付け外し：mod:prim|sec:<att>
        if (!this.nearKind(p, BENCH_KINDS, BENCH_RANGE)) return this.pop(p, '作業台の近くで行う', '#c87a6a');
        const key = a === 'prim' ? 'prim' : 'sec';
        const slot = p[key];
        const att = ATTACHMENTS.find((x) => x === b);
        if (!slot || !slot.w || !att || !isWeapon(slot.id)) return;
        if (slot.w[att]) {
          if (addItem(p.bag, att, 1) > 0) return this.pop(p, 'バックパックがいっぱい', '#c87a6a');
          delete slot.w[att];
          this.pop(p, `${ITEMS[att].name}を外した`, '#d8c48a', 'craft');
        } else {
          if (removeItem(p.bag, att, 1) < 1) return this.pop(p, `${ITEMS[att].name}を持っていない`, '#c87a6a');
          // 光学サイトは1つだけ（付け替えると外したものはバッグへ）
          const other = att === 'scope' ? 'holo' : att === 'holo' ? 'scope' : null;
          if (other && slot.w[other]) {
            delete slot.w[other];
            if (addItem(p.bag, other, 1) > 0) {
              const bag = this.groundBag(p.x, p.y);
              if (bag) addItem(this.contents.get(bag.id)!, other, 1);
            }
          }
          slot.w[att] = 1;
          this.pop(p, `${ITEMS[att].name}を取り付けた`, '#d8c48a', 'craft');
        }
        slot.w.mag = Math.min(slot.w.mag, effectiveStats(slot.id, slot.w).magSize);
        break;
      }
    }
  }

  private equip(p: SimPlayer, idx: number): void {
    const s = p.bag[idx];
    if (!s || !isWeapon(s.id)) return;
    const key = WEAPON_STATS[s.id].secondary ? 'sec' : 'prim';
    const cur = p[key];
    p.bag[idx] = cur ? { ...cur } : null;
    p[key] = { ...s, w: s.w ? { ...s.w } : { mag: 0 } };
    p.tool = key === 'prim' ? Tool.Primary : Tool.Secondary;
    p.reloadT = 0;
    this.pop(p, `${ITEMS[s.id].name}を装備`, '#d8c48a', 'craft');
  }

  /** 足元の袋（なければ作る） */
  private groundBag(x: number, y: number): SimObj | null {
    const tx = Math.floor(x / TILE);
    const ty = Math.floor(y / TILE);
    for (let dy = -1; dy <= 1; dy++)
      for (let dx = -1; dx <= 1; dx++) {
        const o = this.world.objAt(tx + dx, ty + dy);
        if (o && o.kind === 'bag') return o;
      }
    for (const [dx, dy] of [[0, 0], [1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [-1, -1], [1, -1], [-1, 1]]) {
      const ox = tx + dx;
      const oy = ty + dy;
      if (!this.world.inBounds(ox, oy) || this.world.solid(ox, oy) || this.world.objAt(ox, oy)) continue;
      const o: SimObj = { id: this.nextObjId++, kind: 'bag', tx: ox, ty: oy, hp: 1, maxHp: 1, ready: 0, regrowT: 0 };
      this.world.setObj(o);
      this.contents.set(o.id, emptyBag(16));
      this.changed.add(o.id);
      return o;
    }
    return null;
  }

  private craft(p: SimPlayer, id: string): void {
    const r = RECIPES.find((x) => x.id === id);
    if (!r) return;
    if (r.bench && !this.nearKind(p, BENCH_KINDS, BENCH_RANGE)) {
      this.pop(p, '作業台の近くでないと作れない', '#c87a6a');
      return;
    }
    if ((r.lv ?? 1) > this.base.bench) {
      this.pop(p, `作業台 Lv${r.lv} が必要`, '#c87a6a');
      return;
    }
    const cost = Object.entries(r.cost) as [ItemId, number][];
    for (const [m, need] of cost) {
      if (countItem(p.bag, m) < need) {
        this.pop(p, '素材が足りない', '#c87a6a');
        return;
      }
    }
    for (const [m, need] of cost) removeItem(p.bag, m, need);
    const left = addItem(p.bag, r.out.id, r.out.n);
    if (left > 0) {
      // 入りきらない分は足元へ
      const bag = this.groundBag(p.x, p.y);
      if (bag) addItem(this.contents.get(bag.id)!, r.out.id, left);
    }
    this.pop(p, `${r.name} を作成`, '#c9a85a', 'craft');
    this.gainXp(p, 2, 1);
  }

  private ping(p: SimPlayer, tx: number, ty: number): void {
    if ((this.pingCd.get(p.id) ?? -9) > this.time - 0.8) return;
    this.pingCd.set(p.id, this.time);
    const x = (tx + 0.5) * TILE;
    const y = (ty + 0.5) * TILE;
    let t: 'enemy' | 'loot' | 'go' = 'go';
    if (this.zombies.some((z) => Math.hypot(z.x - x, z.y - y) < 90)) t = 'enemy';
    else {
      for (let dy = -1; dy <= 1; dy++)
        for (let dx = -1; dx <= 1; dx++) {
          const o = this.world.objAt(tx + dx, ty + dy);
          if (o && CONTAINER_KINDS.has(o.kind)) t = 'loot';
        }
    }
    this.events.push({ k: 'ping', id: p.id, x, y, t });
  }

  private nearKind(p: { x: number; y: number }, kinds: ReadonlySet<ObjKind>, range: number): SimObj | null {
    const ptx = Math.floor(p.x / TILE);
    const pty = Math.floor(p.y / TILE);
    const r = Math.ceil(range / TILE) + 1;
    for (let ty = pty - r; ty <= pty + r; ty++)
      for (let tx = ptx - r; tx <= ptx + r; tx++) {
        const o = this.world.objAt(tx, ty);
        if (o && kinds.has(o.kind) && Math.hypot((o.tx + 0.5) * TILE - p.x, (o.ty + 0.5) * TILE - p.y) <= range) return o;
      }
    return null;
  }

  // ======================== ドア・探索 ========================

  private toggleDoor(p: SimPlayer, d: SimObj): void {
    if (d.ready === 1) {
      const blocked =
        this.players.some((pl) => pl.status !== 'dead' && circleOverlapsTile(pl.x, pl.y, PLAYER.radius - 2, d.tx, d.ty)) ||
        this.zombies.some((z) => circleOverlapsTile(z.x, z.y, ZOMBIE[z.type].radius - 2, d.tx, d.ty));
      if (blocked) {
        this.pop(p, 'ふさがっていて閉められない', '#aaaaaa');
        return;
      }
    }
    d.ready = d.ready ? 0 : 1;
    this.changed.add(d.id);
    const x = (d.tx + 0.5) * TILE;
    const y = (d.ty + 0.5) * TILE;
    this.events.push({ k: 'door', x, y, open: d.ready === 1 });
    this.makeNoise(x, y, 230, false);
    this.flowTimer = Math.min(this.flowTimer, 0.1);
  }

  /** F キー：いちばん近いドア／入れ物／倉庫を操作。何もなければ回復/食事 */
  private interact(p: SimPlayer): void {
    if (p.viewing || p.storage) {
      p.viewing = 0;
      p.storage = 0;
      return;
    }
    if (p.search) {
      p.search = null;
      return;
    }
    let best: SimObj | null = null;
    let bd = 64;
    const ptx = Math.floor(p.x / TILE);
    const pty = Math.floor(p.y / TILE);
    for (let ty = pty - 2; ty <= pty + 2; ty++)
      for (let tx = ptx - 2; tx <= ptx + 2; tx++) {
        const o = this.world.objAt(tx, ty);
        if (!o) continue;
        const usable = o.kind === 'door' || STORAGE_KINDS.has(o.kind) || (CONTAINER_KINDS.has(o.kind) && (o.kind !== 'car' || o.hp > 0));
        if (!usable) continue;
        const d = Math.hypot((o.tx + 0.5) * TILE - p.x, (o.ty + 0.5) * TILE - p.y) - (o.kind === 'door' ? 0 : 6);
        if (d < bd) {
          bd = d;
          best = o;
        }
      }
    if (!best) {
      if (p.hp < p.maxHp - 25 && this.useMeds(p, false)) return;
      if (p.hunger < 70) this.useFood(p, false);
      return;
    }
    if (best.kind === 'door') return this.toggleDoor(p, best);
    if (STORAGE_KINDS.has(best.kind)) {
      p.storage = 1;
      return;
    }
    // 探索開始：未探索なら時間がかかる（危険な場所・武器ケースほど長い）
    const tier = this.tierAt(best.tx, best.ty);
    const fresh = best.ready === 1 && best.kind !== 'bag';
    const base = fresh ? 1.5 + tier * 0.15 + (best.kind === 'wcase' || best.kind === 'mcrate' || best.kind === 'drop' ? 0.5 : 0) : 0.3;
    const dur = base * skillMods(p.xp).searchMul;
    p.search = { cid: best.id, t: 0, dur, x: p.x, y: p.y };
    if (fresh) this.events.push({ k: 'search', id: p.id, x: (best.tx + 0.5) * TILE, y: (best.ty + 0.5) * TILE, done: false });
  }

  private openContainer(p: SimPlayer, o: SimObj): void {
    if (!this.contents.has(o.id)) this.contents.set(o.id, this.rollLoot(o));
    if (o.ready && o.kind !== 'bag') this.gainXp(p, 0, 4 + this.tierAt(o.tx, o.ty) * 3 + (o.kind === 'drop' ? 15 : 0));
    if (o.id === this.dropObj && o.ready) {
      this.dropObj = null;
      this.events.push({ k: 'feed', t: `${p.name} が補給物資を開けた`, c: '#e0b070' });
    }
    if (o.ready && o.kind !== 'bag') {
      o.ready = 0;
      o.regrowT = 420 + Math.random() * 240;
      this.changed.add(o.id);
      this.events.push({ k: 'search', id: p.id, x: (o.tx + 0.5) * TILE, y: (o.ty + 0.5) * TILE, done: true });
    }
    p.viewing = o.id;
  }

  private tierAt(tx: number, ty: number): number {
    const loc = locationAt(this.world.locations, tx, ty);
    if (loc) return loc.kind === 'base' ? 0 : loc.tier;
    return Math.hypot(tx - 40, ty - 30) > 30 ? 2 : 1;
  }

  /** 入れ物の中身を生成（遠く危険な場所ほど多く・レアに） */
  private rollLoot(o: SimObj): (Slot | null)[] {
    const out = emptyBag(o.kind === 'mcrate' || o.kind === 'wcase' || o.kind === 'drop' ? 8 : 6);
    const table = LOOT[o.kind];
    if (!table) return out;
    const tier = o.kind === 'box' ? 0 : o.kind === 'drop' ? 4 : this.tierAt(o.tx, o.ty);
    const R = Math.random;
    let rolls = 1 + Math.floor(R() * 2) + (tier >= 2 ? 1 : 0) + (tier >= 3 ? 1 : 0) + (o.kind === 'drop' ? 2 : 0);
    // まれに「当たり」の入れ物がある（同じ場所でも毎回中身が違う）
    if (R() < 0.06 + tier * 0.02) rolls += 2;
    const rare = (id: string) => id === 'weapon' || id === 'attach' || id === 'parts' || id === 'valuables';
    const weights = table.map(([id, w]) => (rare(id) ? w * (0.6 + tier * 0.5) : w));
    const total = weights.reduce((a, b) => a + b, 0);
    for (let r = 0; r < rolls; r++) {
      if (R() < 0.18 - tier * 0.04) continue; // 空振り
      let x = R() * total;
      let row = table[0];
      for (let i = 0; i < table.length; i++) {
        x -= weights[i];
        if (x <= 0) {
          row = table[i];
          break;
        }
      }
      const [id, , min, max] = row;
      if (id === 'weapon') {
        const pool: WeaponId[] =
          tier >= 4 ? ['dmr', 'rifle', 'dmr', 'hunting'] : tier >= 3 ? ['rifle', 'shotgun', 'hunting', 'smg', 'dmr'] : tier === 2 ? ['smg', 'shotgun', 'pistol', 'hunting'] : ['pistol', 'smg', 'shotgun'];
        const wid = pool[Math.floor(R() * pool.length)];
        addItem(out, wid, 1, { mag: Math.floor(WEAPON_STATS[wid].magSize * R()) });
      } else if (id === 'attach') {
        // 危険な場所ほどレアなアタッチメント（スコープ・サプレッサー）が出やすい
        const pool: ItemId[] = tier >= 3 ? ['scope', 'suppressor', 'holo', 'extmag', 'grip', 'scope', 'suppressor'] : ['holo', 'extmag', 'grip', 'holo', 'suppressor', 'scope'];
        addItem(out, pool[Math.floor(R() * pool.length)], 1);
      } else {
        addItem(out, id, min + Math.floor(R() * (max - min + 1)));
      }
    }
    return out;
  }

  /** 入れ物は長い時間がたつと（誰も近くにいなければ）中身が補充される。空の袋は消える */
  private updateContainers(dt: number): void {
    if (this.tick % 30 !== 0) return;
    const step = dt * 30;
    for (const o of [...this.world.objects.values()]) {
      if (o.kind === 'bag') {
        const c = this.contents.get(o.id);
        if ((!c || c.every((s) => !s)) && !this.players.some((p) => p.viewing === o.id || p.search?.cid === o.id)) {
          this.world.removeObj(o.id);
          this.contents.delete(o.id);
          this.changed.delete(o.id);
          this.removed.push(o.id);
        }
        continue;
      }
      if (!CONTAINER_KINDS.has(o.kind) || o.kind === 'box' || o.kind === 'drop' || o.ready || o.regrowT <= 0) continue;
      o.regrowT -= step;
      if (o.regrowT > 0) continue;
      const x = (o.tx + 0.5) * TILE;
      const y = (o.ty + 0.5) * TILE;
      if (this.players.some((p) => Math.hypot(p.x - x, p.y - y) < 600)) {
        o.regrowT = 30;
        continue;
      }
      o.ready = 1;
      this.contents.delete(o.id);
      this.changed.add(o.id);
    }
  }

  // ======================== 近接・ダウン・蘇生 ========================

  private swingAxe(p: SimPlayer): void {
    if (p.stamina < PLAYER.meleeStamina) {
      if (p.warnCd <= 0) {
        this.pop(p, 'スタミナ切れ！', '#c99a5a');
        p.warnCd = 1;
      }
      return;
    }
    p.stamina -= PLAYER.meleeStamina;
    p.staminaDelay = PLAYER.staminaDelay;
    p.swings++;
    this.makeNoise(p.x, p.y, AXE.noiseRadius, false);
    let hits = 0;
    for (const z of this.zombies) {
      if (z.dead || hits >= 3) continue;
      const r = ZOMBIE[z.type].radius;
      const dx = z.x - p.x;
      const dy = z.y - p.y;
      const d = Math.hypot(dx, dy);
      if (d > AXE.range + r) continue;
      if (Math.abs(angleDiff(p.aim, Math.atan2(dy, dx))) > AXE.arc / 2 && d > r + PLAYER.radius) continue;
      // 気づいていない相手への奇襲は大ダメージ
      const sneak = z.state !== 'chase' ? 2.2 : 1;
      this.events.push({ k: 'hit', x: z.x - (dx / (d || 1)) * r * 0.6, y: z.y - (dy / (d || 1)) * r * 0.6, o: p.id, a: Math.atan2(dy, dx), m: 1 });
      this.damageZombie(z, AXE.damage * sneak, p.id, dx, dy, 260);
      hits++;
    }
  }

  private updateRevive(dt: number): void {
    for (const d of this.players) {
      if (d.status !== 'down') continue;
      const reviver = this.players.find((p) => p !== d && p.status === 'alive' && p.revive && Math.hypot(p.x - d.x, p.y - d.y) <= PLAYER.reviveRange);
      if (reviver) {
        d.reviveProgress += dt * skillMods(reviver.xp).reviveMul;
        if (d.reviveProgress >= PLAYER.reviveTime) {
          d.status = 'alive';
          d.hp = d.maxHp * PLAYER.reviveHpRatio;
          d.hunger = Math.max(d.hunger, 30);
          d.reviveProgress = 0;
          d.downTimer = 0;
          this.events.push({ k: 'revive', id: d.id, x: d.x, y: d.y });
          this.events.push({ k: 'feed', t: `${reviver.name} が ${d.name} を救助した`, c: '#9fc48a' });
          this.gainXp(reviver, 3, 15);
        }
      } else {
        d.reviveProgress = Math.max(0, d.reviveProgress - dt * 1.5);
      }
    }
  }

  private damagePlayer(p: SimPlayer, dmg: number): void {
    if (p.status !== 'alive') return;
    p.hp -= dmg;
    p.search = null; // 攻撃されたら探索は中断
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
    p.viewing = 0;
    p.storage = 0;
    this.events.push({ k: 'down', id: p.id, x: p.x, y: p.y });
    if (this.players.length > 1) this.events.push({ k: 'feed', t: `${p.name} がダウン！ 近くで [E] 長押しで救助（${PLAYER.downTime}秒以内）`, c: '#e07a60', snd: 'alarm' });
  }

  /** 戦闘不能：持ち物をすべてその場の袋に落とす（仲間が回収できる） */
  private killPlayer(p: SimPlayer): void {
    p.status = 'dead';
    p.downTimer = 0;
    p.reviveProgress = 0;
    const bag = this.groundBag(p.x, p.y);
    if (bag) {
      const c = this.contents.get(bag.id)!;
      while (c.length < 20) c.push(null);
      for (const s of p.bag) if (s) addItem(c, s.id, s.n, s.w);
      if (p.prim) addItem(c, p.prim.id, 1, p.prim.w);
      if (p.sec) addItem(c, p.sec.id, 1, p.sec.w);
    }
    p.bag = emptyBag();
    p.prim = null;
    p.sec = null;
    this.events.push({ k: 'dead', id: p.id });
    this.events.push({ k: 'pop', x: p.x, y: p.y - 30, t: '持ち物を落とした', c: '#c98070', id: p.id });
  }

  // ======================== 騒音（ゾンビの聴覚） ========================

  /** 音を立てる：範囲内のゾンビが音のした場所を調べに来る（近い銃声は即追跡） */
  private makeNoise(x: number, y: number, radius: number, gunshot: boolean): void {
    radius *= this.weatherMul('noise');
    if (gunshot && radius >= 300) this.events.push({ k: 'noise', x, y, r: radius });
    for (const z of this.zombies) {
      if (z.state === 'chase') continue;
      const d = Math.hypot(z.x - x, z.y - y);
      if (d > radius) continue;
      // 壁越しの小さな音は届きにくい
      if (!gunshot && d > radius * 0.5 && !this.world.lineClear(z.x, z.y, x, y)) continue;
      z.state = 'investigate';
      z.stateT = 12;
      z.targetX = x + (Math.random() - 0.5) * 60;
      z.targetY = y + (Math.random() - 0.5) * 60;
      if (gunshot && d < radius * 0.35) this.startChase(z);
    }
  }

  private startChase(z: SimZombie): void {
    if (z.state !== 'chase') this.events.push({ k: 'alert', x: z.x, y: z.y });
    z.state = 'chase';
    z.stateT = 6;
  }

  // ======================== フローフィールド（追跡用の経路） ========================

  private enterCost(i: number): number {
    const t = this.world.terrain[i];
    if (t === T_WALL || t === T_WINDOW || t === T_FENCE) return -1;
    const x = i % MAP_W;
    const y = (i - x) / MAP_W;
    // 拠点（安全地帯）にはゾンビは入らない
    const sh = SAFEHOUSE;
    if (x >= sh.x && y >= sh.y && x < sh.x + sh.w && y < sh.y + sh.h) return -1;
    const o = this.world.objAt(x, y);
    if (!o) return 1;
    if (BREAKABLE_KINDS.has(o.kind) && objIsSolid(o)) return 3 + o.hp / 35;
    return objIsSolid(o) ? -1 : 1;
  }

  private computeFlow(): void {
    const flow = this.flow;
    flow.fill(Infinity);
    const heap = new MinHeap();
    for (const p of this.players) {
      if (p.status !== 'alive' || inBase(p.x, p.y)) continue;
      const i = Math.floor(p.y / TILE) * MAP_W + Math.floor(p.x / TILE);
      flow[i] = 0;
      heap.push(0, i);
    }
    if (heap.size === 0) return;
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
        if (dx && dy && (getCost(y * MAP_W + nx) !== 1 || getCost(ny * MAP_W + x) !== 1)) continue;
        const nd = d + c * w;
        if (nd < flow[j]) {
          flow[j] = nd;
          heap.push(nd, j);
        }
      }
    }
  }

  // ======================== ゾンビの配置と補充 ========================

  private locTarget(loc: Location): number {
    return Math.round(((loc.w * loc.h) / 22) * (0.7 + 0.35 * loc.tier));
  }

  /** 開始時：各ロケーションに潜ませる＋野外の徘徊者 */
  private populate(): void {
    for (const loc of this.world.locations) {
      if (loc.kind === 'base') continue;
      const n = this.locTarget(loc);
      for (let i = 0; i < n; i++) this.spawnIn(loc);
    }
    for (let i = 0; i < 22; i++) this.spawnOutdoor(700);
  }

  private typeForTier(tier: number): ZombieType {
    const r = Math.random();
    if (tier >= 3) return r < 0.5 ? 'soldier' : r < 0.68 ? 'brute' : r < 0.88 ? 'runner' : 'walker';
    if (tier === 2) return r < 0.1 ? 'brute' : r < 0.32 ? 'runner' : r < 0.4 ? 'soldier' : 'walker';
    return r < 0.18 ? 'runner' : 'walker';
  }

  private spawnIn(loc: Location): void {
    for (let t = 0; t < 20; t++) {
      const tx = loc.x + 1 + Math.floor(Math.random() * Math.max(1, loc.w - 2));
      const ty = loc.y + 1 + Math.floor(Math.random() * Math.max(1, loc.h - 2));
      if (this.world.solid(tx, ty)) continue;
      const x = (tx + 0.5) * TILE;
      const y = (ty + 0.5) * TILE;
      if (inBase(x, y) || this.players.some((p) => Math.hypot(p.x - x, p.y - y) < 420)) continue;
      this.spawnZombie(this.typeForTier(loc.tier), x, y);
      return;
    }
  }

  private spawnOutdoor(minDist: number): void {
    for (let t = 0; t < 25; t++) {
      const tx = 1 + Math.floor(Math.random() * (MAP_W - 2));
      const ty = 1 + Math.floor(Math.random() * (MAP_H - 2));
      if (this.world.solid(tx, ty) || this.world.buildingAt(tx, ty)) continue;
      const d = Math.hypot(tx - 40, ty - 30);
      if (d < 15) continue;
      const x = (tx + 0.5) * TILE;
      const y = (ty + 0.5) * TILE;
      if (this.players.some((p) => Math.hypot(p.x - x, p.y - y) < minDist)) continue;
      this.spawnZombie(this.typeForTier(d > 30 ? 2 : 1), x, y);
      return;
    }
  }

  /** 誰もいない場所には少しずつゾンビが戻ってくる。夜は野外の徘徊者が増える */
  private updateSpawning(dt: number): void {
    this.spawnTimer -= dt;
    if (this.spawnTimer > 0 || this.zombies.length >= MAX_ZOMBIES) return;
    this.spawnTimer = 6;
    for (const loc of this.world.locations) {
      if (loc.kind === 'base') continue;
      const cx = (loc.x + loc.w / 2) * TILE;
      const cy = (loc.y + loc.h / 2) * TILE;
      if (this.players.some((p) => Math.hypot(p.x - cx, p.y - cy) < 900)) continue;
      const x0 = loc.x * TILE;
      const y0 = loc.y * TILE;
      const x1 = (loc.x + loc.w) * TILE;
      const y1 = (loc.y + loc.h) * TILE;
      const inside = this.zombies.filter((z) => z.x > x0 && z.y > y0 && z.x < x1 && z.y < y1).length;
      if (inside < this.locTarget(loc) * 0.7 && Math.random() < 0.35) this.spawnIn(loc);
    }
    const outdoor = this.zombies.filter((z) => !this.world.buildingAt(Math.floor(z.x / TILE), Math.floor(z.y / TILE))).length;
    const want = (this.phase === 'night' ? 36 : 22) + this.day * 2 + (this.weather === 'storm' ? 10 : 0);
    if (outdoor < want) this.spawnOutdoor(650);
  }

  private spawnZombie(type: ZombieType, x: number, y: number): SimZombie {
    // 汚染地帯の個体は少し手強い
    const loc = locationAt(this.world.locations, Math.floor(x / TILE), Math.floor(y / TILE));
    const elite = loc?.hot ? 1.3 : 1;
    const hp = ZOMBIE[type].hp * (1 + 0.06 * (this.day - 1)) * elite;
    this.zombies.push({
      id: this.nextId++,
      type,
      x,
      y,
      angle: Math.random() * Math.PI * 2,
      hp,
      maxHp: hp,
      flash: 0,
      alert: 0,
      atk: 0,
      kx: 0,
      ky: 0,
      attackCd: 0,
      state: 'idle',
      stateT: 0,
      targetX: x,
      targetY: y,
      homeX: x,
      homeY: y,
      wanderA: Math.random() * Math.PI * 2,
      wanderT: Math.random() * 3,
      senseT: Math.random() * 0.3,
      speedMul: 0.85 + Math.random() * 0.3,
      stuckT: 0,
      route: null,
      routeI: 0,
      dead: false,
    });
    return this.zombies[this.zombies.length - 1];
  }

  /** 巡回する群れを出す：いくつかのロケーションを順に回る */
  private spawnPatrols(groups: number): void {
    const locs = this.world.locations.filter((l) => l.kind !== 'base');
    for (let g = 0; g < groups && locs.length >= 2; g++) {
      const pts: { x: number; y: number }[] = [];
      const n = 2 + Math.floor(Math.random() * 2);
      for (let i = 0; i < n; i++) {
        const l = locs[Math.floor(Math.random() * locs.length)];
        // 建物の出入口付近（外周の少し外）を通る
        pts.push({ x: (l.x + l.w / 2) * TILE + (Math.random() - 0.5) * 80, y: (l.y + l.h + 1.5) * TILE });
      }
      const start = pts[0];
      if (this.players.some((p) => Math.hypot(p.x - start.x, p.y - start.y) < 600) || inBase(start.x, start.y)) continue;
      const tier = Math.max(...locs.map((l) => l.tier)) >= 3 && Math.random() < 0.4 ? 3 : 2;
      const size = 3 + Math.floor(Math.random() * 3);
      for (let i = 0; i < size; i++) {
        const z = this.spawnZombie(this.typeForTier(tier), start.x + (Math.random() - 0.5) * 70, start.y + (Math.random() - 0.5) * 70);
        moveCircle(z, 0, 0, ZOMBIE[z.type].radius, this.world);
        z.route = pts.map((p) => ({ x: p.x + (Math.random() - 0.5) * 50, y: p.y + (Math.random() - 0.5) * 50 }));
      }
    }
  }

  // ======================== 天候 ========================

  /** 天候による倍率（切り替わり中は wx でなめらかに補間） */
  private weatherMul(k: 'sight' | 'noise'): number {
    return 1 + (WEATHER_FX[this.weather][k] - 1) * this.wx;
  }

  /** 朝と夕方に天候が変わる */
  private rollWeather(): void {
    const r = Math.random();
    const next: Weather = r < 0.45 ? 'clear' : r < 0.65 ? 'fog' : r < 0.87 ? 'rain' : 'storm';
    this.setWeather(next, false);
  }

  private setWeather(w: Weather, instant: boolean): void {
    if (w === this.weather && w === this.nextWeather) return;
    this.nextWeather = w;
    if (instant) {
      this.weather = w;
      this.wx = w === 'clear' ? 0 : 1;
    }
    if (w !== 'clear') this.events.push({ k: 'feed', t: `天候：${WEATHER_FX[w].name} — ${WEATHER_FX[w].desc}`, c: '#aab8c8' });
    else if (this.weather !== 'clear') this.events.push({ k: 'feed', t: '天候：晴れてきた', c: '#aab8c8' });
  }

  private updateWeather(dt: number): void {
    if (this.nextWeather !== this.weather) {
      // いったん弱まってから次の天候へ
      this.wx = Math.max(0, this.wx - dt / 8);
      if (this.wx <= 0) this.weather = this.nextWeather;
    } else if (this.weather !== 'clear') this.wx = Math.min(1, this.wx + dt / 8);
  }

  // ======================== 補給物資（空中投下） ========================

  private dropPos(): { x: number; y: number } | null {
    if (this.dropObj === null) return null;
    const o = this.world.objects.get(this.dropObj);
    return o ? { x: (o.tx + 0.5) * TILE, y: (o.ty + 0.5) * TILE } : null;
  }

  /** 昼のどこかで、拠点から遠い野外に補給物資が落ちてくる（感染兵士が群がる） */
  private updateAirdrop(): void {
    if (this.dropAt < 0 || this.phase !== 'day' || this.cycleT < this.dropAt) return;
    this.dropAt = -1;
    if (this.dropObj !== null && this.world.objects.has(this.dropObj)) return;
    for (let t = 0; t < 200; t++) {
      const tx = 3 + Math.floor(Math.random() * (MAP_W - 6));
      const ty = 3 + Math.floor(Math.random() * (MAP_H - 6));
      if (Math.hypot(tx - 40, ty - 30) < 24) continue;
      if (this.world.solid(tx, ty) || this.world.objAt(tx, ty) || this.world.buildingAt(tx, ty)) continue;
      const x = (tx + 0.5) * TILE;
      const y = (ty + 0.5) * TILE;
      if (this.players.some((p) => Math.hypot(p.x - x, p.y - y) < 500)) continue;
      const o: SimObj = { id: this.nextObjId++, kind: 'drop', tx, ty, hp: 1, maxHp: 1, ready: 1, regrowT: 0 };
      this.world.setObj(o);
      this.changed.add(o.id);
      this.dropObj = o.id;
      const guards = 3 + Math.floor(Math.random() * 3) + Math.min(3, Math.floor(this.day / 3));
      for (let i = 0; i < guards; i++) {
        const a = (i / guards) * Math.PI * 2;
        const z = this.spawnZombie(Math.random() < 0.6 ? 'soldier' : Math.random() < 0.5 ? 'brute' : 'runner', x + Math.cos(a) * 90, y + Math.sin(a) * 90);
        moveCircle(z, 0, 0, ZOMBIE[z.type].radius, this.world);
        z.homeX = x;
        z.homeY = y;
      }
      this.events.push({ k: 'banner', t: '補給物資が投下された', s: '赤い発煙筒の場所へ。レア物資と、それを狙う感染兵士がいる', c: '#e0b070', snd: 'alarm' });
      this.events.push({ k: 'feed', t: '補給物資が投下された（地図に赤く表示）', c: '#e0b070' });
      return;
    }
  }

  // ======================== 拠点設備 ========================

  /** 朝の収納箱の中身（補給所・医務室のレベルで増える） */
  private morningSupplies(o: SimObj): (Slot | null)[] {
    const c = this.rollLoot(o);
    const sup = this.base.supply;
    if (sup >= 1) {
      addItem(c, 'can', 1 + Math.floor(Math.random() * 2));
      addItem(c, Math.random() < 0.5 ? 'ammo9' : 'ammo762', 10 + Math.floor(Math.random() * 10));
    }
    if (sup >= 2) {
      addItem(c, 'gunpowder', 2);
      if (Math.random() < 0.5) addItem(c, 'parts', 1);
      if (Math.random() < 0.4) addItem(c, 'mre', 1);
    }
    if (this.base.med >= 1) addItem(c, 'bandage', 2);
    if (this.base.med >= 2) addItem(c, 'medkit', 1);
    return c;
  }

  private resizeStorage(): void {
    const sz = STORAGE_SIZES[Math.min(STORAGE_SIZES.length - 1, this.base.storage)];
    while (this.storage.shared.length < sz.shared) this.storage.shared.push(null);
    for (const k of Object.keys(this.storage.personal)) {
      const b = this.storage.personal[Number(k)];
      while (b.length < sz.personal) b.push(null);
    }
  }

  // ======================== ゾンビAI ========================

  /** 視覚：向いている方向の視野・距離・昼夜・懐中電灯の光で判定 */
  private canSee(z: SimZombie, p: SimPlayer): boolean {
    const dx = p.x - z.x;
    const dy = p.y - z.y;
    const d = Math.hypot(dx, dy);
    if (d < 56) return true; // すぐそばなら気配で気づく
    const night = this.phase === 'night';
    let range = (night ? 170 : 320) * this.weatherMul('sight');
    // 夜は懐中電灯の光が目立つ：プレイヤーの光の円錐の中にいると遠くからでも気づく
    if (night && d < 520 && Math.abs(angleDiff(p.aim, Math.atan2(-dy, -dx))) < 0.45) range = 520;
    if (d > range) return false;
    const fov = z.state === 'chase' || z.state === 'search' ? Math.PI : Math.PI * 0.4;
    if (Math.abs(angleDiff(z.angle, Math.atan2(dy, dx))) > fov) return false;
    return this.world.lineClear(z.x, z.y, p.x, p.y);
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
    const night = this.phase === 'night';
    z.flash = Math.max(0, z.flash - dt);
    z.attackCd = Math.max(0, z.attackCd - dt);
    z.stateT -= dt;

    // ---- 知覚（0.2秒ごと） ----
    z.senseT -= dt;
    if (z.senseT <= 0) {
      z.senseT = 0.2;
      for (const p of this.players) {
        if (p.status !== 'alive' || inBase(p.x, p.y)) continue;
        if (this.canSee(z, p)) {
          this.startChase(z);
          z.targetX = p.x;
          z.targetY = p.y;
          break;
        }
      }
    }
    // 状態の遷移
    if (z.state === 'chase' && z.stateT <= 0) {
      z.state = 'search';
      z.stateT = 7;
    } else if ((z.state === 'investigate' || z.state === 'search') && z.stateT <= 0) {
      z.state = 'idle';
      z.homeX = z.x;
      z.homeY = z.y;
    }

    const near = this.nearestAlive(z.x, z.y);
    let speed = (night ? st.nightSpeed : st.daySpeed) * z.speedMul;
    let dx = 0;
    let dy = 0;
    let wantAttack: SimObj | null = null;

    if (z.state === 'chase' && near) {
      if (near.d < 260 && this.world.lineClear(z.x, z.y, near.p.x, near.p.y)) {
        dx = (near.p.x - z.x) / (near.d || 1);
        dy = (near.p.y - z.y) / (near.d || 1);
        z.stateT = Math.max(z.stateT, 3);
        z.targetX = near.p.x;
        z.targetY = near.p.y;
      } else {
        const step = this.flowStep(z);
        if (step) {
          dx = step.dx;
          dy = step.dy;
          wantAttack = step.obstacle;
        } else {
          const l = Math.hypot(z.targetX - z.x, z.targetY - z.y) || 1;
          dx = (z.targetX - z.x) / l;
          dy = (z.targetY - z.y) / l;
        }
      }
    } else if (z.state === 'investigate' || z.state === 'search') {
      const l = Math.hypot(z.targetX - z.x, z.targetY - z.y);
      if (l < 30) {
        // 着いたらあたりを見回す
        z.wanderT -= dt;
        if (z.wanderT <= 0) {
          z.wanderT = 1 + Math.random() * 1.5;
          z.wanderA = Math.random() * Math.PI * 2;
        }
        dx = Math.cos(z.wanderA) * 0.4;
        dy = Math.sin(z.wanderA) * 0.4;
      } else {
        dx = (z.targetX - z.x) / l;
        dy = (z.targetY - z.y) / l;
      }
      speed *= 0.7;
    } else if (z.route) {
      // 巡回：ロケーションの間を群れで歩く
      const wp = z.route[z.routeI];
      const l = Math.hypot(wp.x - z.x, wp.y - z.y);
      if (l < 40) z.routeI = (z.routeI + 1) % z.route.length;
      dx = (wp.x - z.x) / (l || 1);
      dy = (wp.y - z.y) / (l || 1);
      speed *= night ? 0.55 : 0.42;
    } else {
      // 徘徊（住処の近くをうろつく）
      z.wanderT -= dt;
      if (z.wanderT <= 0) {
        z.wanderT = 2 + Math.random() * 4;
        const back = Math.hypot(z.homeX - z.x, z.homeY - z.y) > 200;
        z.wanderA = back ? Math.atan2(z.homeY - z.y, z.homeX - z.x) : Math.random() < 0.4 ? NaN : Math.random() * Math.PI * 2;
      }
      if (!Number.isNaN(z.wanderA)) {
        dx = Math.cos(z.wanderA);
        dy = Math.sin(z.wanderA);
      }
      speed *= night ? 0.45 : 0.32;
    }

    if (dx || dy) z.angle = Math.atan2(dy, dx);
    const decay = Math.exp(-6 * dt);
    z.kx *= decay;
    z.ky *= decay;
    const px = z.x;
    const py = z.y;
    const collided: { tx: number; ty: number }[] = [];
    moveCircle(z, (dx * speed + z.kx) * dt, (dy * speed + z.ky) * dt, st.radius, this.world, collided);
    // 拠点（安全地帯）には入れない
    if (inBase(z.x, z.y)) {
      z.x = px;
      z.y = py;
      if (z.state !== 'chase') {
        z.wanderA = Math.atan2(z.y - (SAFEHOUSE.y + SAFEHOUSE.h / 2) * TILE, z.x - (SAFEHOUSE.x + SAFEHOUSE.w / 2) * TILE);
        z.state = 'idle';
      }
    }
    // 引っかかったら向きを変える
    if ((dx || dy) && Math.hypot(z.x - px, z.y - py) < speed * dt * 0.2) {
      z.stuckT += dt;
      if (z.stuckT > 1.2 && z.state !== 'chase') {
        z.stuckT = 0;
        z.wanderA = Math.random() * Math.PI * 2;
        if (z.state === 'investigate') z.stateT = Math.min(z.stateT, 1.5);
      }
    } else z.stuckT = 0;

    if (z.attackCd > 0) return;
    if (near && near.d < st.radius + PLAYER.radius + 6) {
      this.damagePlayer(near.p, st.damage);
      z.attackCd = st.attackInterval;
      z.atk++;
      this.startChase(z);
      return;
    }
    if (z.state !== 'chase' && z.state !== 'investigate') return;
    let target: SimObj | null = null;
    if (wantAttack && this.distToTile(z, wantAttack.tx, wantAttack.ty) < st.radius + 8) target = wantAttack;
    if (!target) {
      for (const c of collided) {
        const o = this.world.objAt(c.tx, c.ty);
        if (o && BREAKABLE_KINDS.has(o.kind) && objIsSolid(o)) {
          target = o;
          break;
        }
      }
    }
    if (target) {
      target.hp -= st.wallDamage;
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

  private flowStep(z: SimZombie): { dx: number; dy: number; obstacle: SimObj | null } | null {
    const tx = Math.floor(z.x / TILE);
    const ty = Math.floor(z.y / TILE);
    let best = this.flow[ty * MAP_W + tx];
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
    const d = Math.hypot(cx - z.x, cy - z.y) || 1;
    const o = this.world.objAt(bx, by);
    return { dx: (cx - z.x) / d, dy: (cy - z.y) / d, obstacle: o && BREAKABLE_KINDS.has(o.kind) && objIsSolid(o) ? o : null };
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
        const min = ra + ZOMBIE[b.type].radius;
        const d2 = dx * dx + dy * dy;
        if (d2 < min * min && d2 > 1e-4) {
          const d = Math.sqrt(d2);
          const push = (min - d) * 0.5;
          a.x -= (dx / d) * push;
          a.y -= (dy / d) * push;
          b.x += (dx / d) * push;
          b.y += (dy / d) * push;
        }
      }
      moveCircle(a, 0, 0, ra, this.world);
    }
  }

  private damageZombie(z: SimZombie, dmg: number, owner: number, dirX: number, dirY: number, knock: number, ap = true): void {
    if (z.dead) return;
    // 装甲：通常弾は軽減される（徹甲弾・近接は無視）
    const armor = ZOMBIE[z.type].armor;
    if (!ap && armor > 0) {
      dmg *= 1 - armor;
      this.events.push({ k: 'ricochet', x: z.x, y: z.y });
    }
    z.hp -= dmg;
    z.flash = 0.08;
    const l = Math.hypot(dirX, dirY) || 1;
    const resist = z.type === 'brute' ? 0.25 : z.type === 'soldier' ? 0.6 : 1;
    z.kx += (dirX / l) * knock * resist;
    z.ky += (dirY / l) * knock * resist;
    const shooter = this.players.find((p) => p.id === owner);
    if (shooter) {
      z.targetX = shooter.x;
      z.targetY = shooter.y;
    }
    this.startChase(z);
    this.events.push({ k: 'dmg', x: z.x, y: z.y - ZOMBIE[z.type].radius, v: Math.round(dmg), p: false });
    if (z.hp <= 0) this.killZombie(z, owner, dirX / l, dirY / l);
  }

  private killZombie(z: SimZombie, owner: number, dx = 0, dy = 0): void {
    z.dead = true;
    const killer = this.players.find((p) => p.id === owner);
    if (killer) {
      killer.kills++;
      const xp = z.type === 'brute' ? 12 : z.type === 'soldier' ? 9 : z.type === 'runner' ? 4 : 3;
      this.gainXp(killer, killer.tool === Tool.Melee ? 1 : 2, xp);
    }
    this.events.push({ k: 'kill', x: z.x, y: z.y, r: ZOMBIE[z.type].radius, o: owner, t: z.type, id: z.id, a: z.angle, dx: r2(dx), dy: r2(dy) });
    // 感染兵士は装備を落とすことがある
    if (z.type === 'soldier' && Math.random() < 0.45) {
      const bag = this.groundBag(z.x, z.y);
      if (bag) {
        const c = this.contents.get(bag.id)!;
        addItem(c, Math.random() < 0.6 ? 'ammo762' : 'ammo9', 6 + Math.floor(Math.random() * 12));
        if (Math.random() < 0.25) addItem(c, 'bandage', 1);
        if (Math.random() < 0.08) addItem(c, ATTACHMENTS[Math.floor(Math.random() * ATTACHMENTS.length)], 1);
      }
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
          if (z.dead || b.hit.includes(z.id)) continue;
          const r = ZOMBIE[z.type].radius + 3;
          if ((z.x - b.x) ** 2 + (z.y - b.y) ** 2 < r * r) {
            b.hit.push(z.id);
            this.events.push({ k: 'hit', x: b.x, y: b.y, o: b.owner, a: Math.atan2(b.vy, b.vx) });
            this.damageZombie(z, b.dmg, b.owner, b.vx, b.vy, b.knock, b.ap);
            // 貫通：威力を落としながら次の敵へ
            if (b.pierce > 0) {
              b.pierce--;
              b.dmg *= 0.75;
            } else b.dead = true;
            break;
          }
        }
      }
      b.life -= dt;
      if (b.life <= 0) b.dead = true;
    }
  }

  private destroyObj(o: SimObj): void {
    this.world.removeObj(o.id);
    this.changed.delete(o.id);
    this.removed.push(o.id);
    this.events.push({ k: 'break', x: (o.tx + 0.5) * TILE, y: (o.ty + 0.5) * TILE, kind: o.kind });
    this.flowTimer = Math.min(this.flowTimer, 0.1);
  }
}

function toObjSnap(o: ObjSnap): ObjSnap {
  return { id: o.id, kind: o.kind, tx: o.tx, ty: o.ty, hp: Math.ceil(o.hp), maxHp: o.maxHp, ready: o.ready };
}
