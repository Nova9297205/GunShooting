// ============================================================
// GameSession: ゲームループ本体（モード別の更新・同期・描画）
//   solo  : ローカルで HostSimulation を回す
//   host  : HostSimulation を回し、約30Hzでスナップショット（オブジェクトは差分）を配信
//   guest : 入力を送りつつ自機の移動・照準・射撃エフェクトをクライアント側予測で即時反映、
//           他プレイヤー・ゾンビ・弾はスナップショット間を線形補間して描画
// ============================================================
import { isTouchDevice, TouchControls } from '../ui/TouchControls';
import { clearSave, writeSave } from './save';
import { buildDef, buildSpotError, canAfford } from './build';
import { seatPos, trunkPos, VEHICLE } from './vehicles';
import { gamepad, PAD, padBtn, type PadReader, padPrefs, padSettings, padText } from '../ui/Gamepad';
import { PerfOverlay, type PerfCounts } from './PerfOverlay';
import type {
  VehicleSnap,
  BulletSnap,
  GameEvent,
  GameMode,
  GameResult,
  InputFrame,
  LobbyPlayer,
  MoveBody,
  PlayerSnap,
  Snapshot,
  StartInfo,
  StorageState,
  ViewState,
} from '../types';
import { Tool } from '../types';
import { audio } from './Audio';
import { CraftMenu } from '../ui/CraftMenu';
import { InventoryPanel } from '../ui/InventoryPanel';
import { BUILD_KINDS, BUILDS, type BuildKind, PLAYER_COLORS, AXE, BENCH_RANGE, INTERP_DELAY, MUZZLE, PLAYER, SNAPSHOT_EVERY, TICK_DT, TILE, USABLE_SLOTS, ZOMBIE } from './constants';
import { CONTAINER_KINDS, GIVE_RANGE, STORAGE_KINDS } from './Engine';
import { CONTAINER_NAMES, countItem, effectiveStats, heldWeapon, ITEMS } from './items';
import { loadProfile, saveProfile } from './progression';
import { Effects } from './Effects';
import type { HostSimulation } from './Engine';
import { InputController } from './Input';
import { angleLerp, lerp, stepMovement } from './physics';
import { Renderer } from './Renderer';
import { generateTerrain, TileWorld } from './world';
import type { NetworkManager } from '../network/NetworkManager';

export interface SessionOptions {
  mode: GameMode;
  canvas: HTMLCanvasElement;
  localId: number;
  info: StartInfo;
  /** ソロ/ホスト時は呼び出し側で生成したシミュレーションを渡す */
  sim?: HostSimulation;
  net?: NetworkManager;
  roomCode?: string;
  onGameOver: (r: GameResult) => void;
  /** ローカル協力（画面分割）：このプレイヤーの表示枠 */
  root?: HTMLElement;
  /** ローカル協力：使う機器（'kbm' = キーボード＋マウス、それ以外はコントローラーの "<番号>|<id>"） */
  device?: string;
  /** ローカル協力の 2 人目以降（シミュレーションは 1 人目が進める） */
  secondary?: boolean;
}

interface BufferedSnap {
  snap: Snapshot;
  fired: boolean;
}

interface LocalBullet extends BulletSnap {
  life: number;
}

export class GameSession {
  private renderer: Renderer;
  private input: InputController;
  private effects = new Effects();
  private world: TileWorld;
  private running = false;
  private rafId = 0;
  private pumpTimer = 0;
  private lastFrame = 0;
  private seq = 0;
  private localTool: number = Tool.Secondary;
  private localAim = 0;

  // host / solo
  private sim: HostSimulation | null;
  private acc = 0;
  private lastPump = 0;
  private pendingEvents: GameEvent[] = [];
  private gameOverHandled = false;

  // guest
  private snaps: BufferedSnap[] = [];
  private latest: Snapshot | null = null;
  /** 直前のフレームの表示状態（ホストでもゲストでも使える） */
  private prevView: ViewState | null = null;
  private timeOffset: number | null = null;
  private pred: MoveBody | null = null;
  private pendingInputs: InputFrame[] = [];
  private predErr = { x: 0, y: 0 };
  private localFireCd = 0;
  private localSwingCd = 0;
  private localShotSeqs: number[] = [];
  private localBullets: LocalBullet[] = [];
  private localBulletId = -1;
  private campfires: { x: number; y: number }[] = [];
  private craftMenu: CraftMenu;
  private pendingCraft = '';
  private invPanel: InventoryPanel;
  private ops: string[] = [];
  /** 建設モード：選んでいる建築物（null = 建設モードでない） */
  private buildKind: BuildKind | null = null;
  private lastBuild: BuildKind = 'woodWall';
  private buildGhost: { tx: number; ty: number; err: string | null } | null = null;
  private touchFirePrev = false;
  // ---- コントローラー ----
  private padSettings = padSettings();
  /** このプレイヤーが使うコントローラー（null = 使わない） */
  private pad: PadReader | null;
  /** 蘇生を「押すたびに切り替え」にしたときの状態 */
  private padLtHeld = false;
  private padReviveOn = false;
  /** ローカル協力：同じ画面の 2 人目以降のセッション（1 人目が持つ） */
  locals: GameSession[] = [];
  private padBtn = document.getElementById('btn-pad');
  private padAim = { x: 180, y: 0 };
  private padMove = false;
  private padFire = false;
  private padRevive = false;
  /** 入れ物・倉庫を開いたことで自動的にパネルを開いたか */
  private autoOpened = false;
  private lastViewing = 0;
  private lastStorageOpen = 0;
  private lastPrim = '';
  private lastSave = 0;
  private mapOpen = false;
  /** スマホ・タブレットのタッチ操作（タッチ端末だけ） */
  private touch: TouchControls | null = null;
  /** F3 / P：パフォーマンス表示 */
  private perf = new PerfOverlay();
  private lastSec = '';
  /** ゲスト：最後に受け取った倉庫の状態（変化したときだけ届く） */
  private storage: StorageState | null = null;
  private hudButtons = document.getElementById('hud-buttons')!;
  private muteBtn = document.getElementById('btn-mute')!;

  constructor(private o: SessionOptions) {
    this.sim = o.sim ?? null;
    if (this.sim) {
      this.world = this.sim.world;
    } else {
      // ゲストもシードから同じ世界（地形・建物・オブジェクト）を再生成し、ホストからは変化分だけ受け取る
      const gen = generateTerrain(o.info.seed);
      this.world = new TileWorld(gen.terrain);
      this.world.locations = gen.locations;
      this.world.buildings = gen.buildings;
      this.world.landmarks = gen.landmarks;
      this.world.districts = gen.districts;
      this.world.features = gen.features;
      this.world.vec = gen.vec;
      for (const ob of gen.objs) this.world.setObj({ ...ob });
      for (const ob of o.info.objs) this.world.setObj({ ...ob });
      for (const id of o.info.removed ?? []) this.world.removeObj(id);
    }
    this.renderer = new Renderer(o.canvas, this.world, o.root ?? null);
    this.input = new InputController(o.canvas);
    if (isTouchDevice() && !o.root) this.touch = new TouchControls(this.input);
    // コントローラー：ふだんは設定で選んだ 1 台。ローカル協力では割り当てた 1 台（キーボードの人は無し）
    if (o.device === undefined) this.pad = gamepad;
    else if (o.device === 'kbm') this.pad = null;
    else this.pad = gamepad.forPad(o.device, PLAYER_COLORS[o.localId] ?? '#e0a33a', `P${o.localId + 1}`);
    if (this.pad && o.root) {
      const root = o.root;
      this.pad.area = () => root.getBoundingClientRect();
      this.pad.onBack = () => {
        this.craftMenu.toggle(false);
        this.invPanel.toggle(false);
        this.mapOpen = false;
      };
      this.pad.centerCursor();
      this.pad.scope = () => root.querySelector<HTMLElement>('.modal:not(.hidden)');
    }
    if (o.secondary) {
      this.perf.destroy();
      this.renderer.hooks = { shot: () => {}, swing: () => {}, reload: () => {} };
    }
    // 画面分割では、持ち物・作業台のパネルも自分の枠の中に
    const panelOf = (id: string): HTMLElement => {
      const tpl = document.getElementById(id)!;
      if (!o.root) return tpl;
      const el = tpl.cloneNode(true) as HTMLElement;
      el.classList.add('hidden');
      o.root.appendChild(el);
      return el;
    };
    // 効果音：射撃・斧・リロードは描画側のカウンタ検出から鳴らす
    if (!o.secondary) this.renderer.hooks = {
      shot: (p, w) => audio.shot(p.x, p.y, p.id === o.localId, w),
      swing: (p) => audio.swing(p.x, p.y, p.id === o.localId),
      reload: (p) => audio.reload(p.x, p.y, p.id === o.localId),
    };
    this.craftMenu = new CraftMenu(
      panelOf('craft-panel'),
      (id) => {
        this.pendingCraft = id;
        audio.click();
      },
      () => audio.click(),
      (slot, att) => {
        this.ops.push(`mod:${slot}:${att}`);
        audio.click();
      },
      (fac) => {
        this.ops.push(`upg:${fac}`);
        audio.click();
      },
      (kind) => {
        this.craftMenu.toggle(false);
        this.buildKind = kind;
        this.lastBuild = kind;
        audio.click();
      },
    );
    this.invPanel = new InventoryPanel(
      panelOf('inv-panel'),
      (op) => {
        this.ops.push(op);
        audio.click();
      },
      (open) => {
        audio.click();
        // 手動で閉じたら入れ物・倉庫も閉じる
        if (!open) {
          this.autoOpened = false;
          this.ops.push('close');
        }
      },
    );
    for (const ob of this.world.objects.values()) {
      if (ob.kind === 'campfire') this.campfires.push({ x: (ob.tx + 0.5) * TILE, y: (ob.ty + 0.5) * TILE });
    }
  }

  start(): void {
    this.running = true;
    // キーボード・マウスは、ローカル協力ではキーボード担当の人だけ
    if (this.o.device === undefined || this.o.device === 'kbm') this.input.attach();
    this.touch?.show(true);
    window.addEventListener('resize', this.onResize);
    this.lastFrame = performance.now();
    this.lastPump = performance.now();
    if (this.sim && !this.o.secondary) this.pumpTimer = window.setInterval(this.pump, 8);
    this.rafId = requestAnimationFrame(this.frame);
    if (this.o.root) gamepad.suspended = true;
    if (this.o.secondary) return;
    // 画面分割では、右下のボタンを 1P の枠の中へ
    if (this.o.root) this.o.root.appendChild(this.hudButtons);
    this.hudButtons.classList.remove('hidden');
    document.getElementById('btn-craft')!.onclick = () => this.craftMenu.toggle();
    document.getElementById('btn-inv')!.onclick = () => this.invPanel.toggle();
    document.getElementById('btn-map')!.onclick = () => {
      this.mapOpen = !this.mapOpen;
      audio.click();
    };
    if (this.padBtn) this.padBtn.onclick = () => this.padSettings.toggle();
    this.muteBtn.onclick = () => {
      audio.toggleMute();
      audio.click();
    };
  }

  stop(): void {
    for (const l of this.locals) l.stop();
    this.locals = [];
    if (this.pad && this.pad !== gamepad) gamepad.drop(this.pad);
    if (this.o.secondary) {
      this.running = false;
      cancelAnimationFrame(this.rafId);
      this.renderer.destroy();
      this.craftMenu.destroy();
      this.invPanel.destroy();
      this.input.detach();
      window.removeEventListener('resize', this.onResize);
      this.o.root?.remove();
      return;
    }
    if (this.o.root) {
      gamepad.suspended = false;
      document.body.appendChild(this.hudButtons);
      this.o.root.remove();
    }
    gamepad.gameplay = false;
    this.padSettings.toggle(false);
    // 抜けるときに保存（全滅で終わったときは保存しない）
    if (this.sim && !this.sim.gameOver) writeSave(this.sim.toSave());
    this.renderer.destroy();
    this.perf.destroy();
    this.hudButtons.classList.add('hidden');
    this.craftMenu.destroy();
    this.invPanel.destroy();
    this.running = false;
    cancelAnimationFrame(this.rafId);
    clearInterval(this.pumpTimer);
    this.input.detach();
    this.touch?.destroy();
    window.removeEventListener('resize', this.onResize);
    audio.setMood(null);
  }

  /** イベントを演出（パーティクル等）と効果音の両方へ */
  private onEvent(ev: GameEvent): void {
    this.effects.handleEvent(ev, this.o.localId);
    audio.handleEvent(ev, this.o.localId);
    // ローカル協力：同じ画面のほかの人の演出にも渡す（音は 1 回だけ）
    for (const l of this.locals) l.localEvent(ev);
  }

  /** ローカル協力の 2 人目以降：演出と、自分のコントローラーの振動 */
  localEvent(ev: GameEvent): void {
    this.effects.handleEvent(ev, this.o.localId);
    if (ev.k === 'phit' && ev.id === this.o.localId) this.pad?.rumble(0.6, 0.4, 160);
  }

  // ---------------- ネットワークからの呼び出し ----------------

  receiveInput(playerId: number, f: InputFrame): void {
    this.sim?.queueInput(playerId, f);
    this.pump();
  }

  removePlayer(playerId: number): void {
    this.sim?.removePlayer(playerId);
  }

  /** ホスト：通信が切れた仲間をその場で待たせる／戻ってきた */
  setAway(playerId: number, away: boolean): void {
    this.sim?.setAway(playerId, away);
  }

  /** ホスト：再接続したゲストに送る開始情報（今のワールドの変化をすべて含む） */
  rejoinInfo(players: LobbyPlayer[]): StartInfo | null {
    if (!this.sim) return null;
    return { players, seed: this.sim.seed, ...this.sim.fullWorldDiff() };
  }

  receiveSnapshot(s: Snapshot): void {
    // オブジェクト差分は即時反映（建築・破壊・資源の再湧き）
    for (const ob of s.objs) this.world.setObj({ ...ob });
    for (const id of s.removed) this.world.removeObj(id);
    if (s.storage) this.storage = s.storage;

    const now = performance.now() / 1000;
    const est = s.time - now;
    if (this.timeOffset === null || Math.abs(est - this.timeOffset) > 1) this.timeOffset = est;
    else this.timeOffset += (est - this.timeOffset) * 0.05;

    this.snaps.push({ snap: s, fired: false });
    this.latest = s;
    const rt = this.renderTime(now);
    while (this.snaps.length > 2 && this.snaps[1].snap.time < rt - 0.5) {
      const old = this.snaps.shift()!;
      if (!old.fired) this.fireEvents(old);
    }
    if (this.snaps.length > 90) {
      const old = this.snaps.shift()!;
      if (!old.fired) this.fireEvents(old);
    }
    this.reconcile(s);
  }

  // ---------------- ホスト計算 ----------------

  private saveT = 30;

  private pump = (): void => {
    const sim = this.sim;
    if (!sim || !this.running) return;
    // 30秒ごとに自動保存（ソロ・ホスト）
    this.saveT -= Math.min(0.25, (performance.now() - this.lastPump) / 1000);
    if (this.saveT <= 0 && !sim.gameOver) {
      this.saveT = 30;
      writeSave(sim.toSave());
    }
    const now = performance.now();
    this.acc += Math.min(0.25, (now - this.lastPump) / 1000);
    this.lastPump = now;
    while (this.acc >= TICK_DT) {
      this.acc -= TICK_DT;
      sim.step(TICK_DT);
      const evs = sim.drainEvents();
      for (const ev of evs) this.onEvent(ev);
      if (this.o.mode === 'host' && this.o.net) {
        this.pendingEvents.push(...evs);
        if (sim.tick % SNAPSHOT_EVERY === 0 || sim.gameOver) {
          // 各ゲストには、その人の周り（視界の届く範囲）のゾンビと弾だけを送る
          const snap = sim.snapshot(this.pendingEvents);
          const R = 1100;
          this.o.net.sendSnapshotEach((slot) => {
            const pl = snap.players.find((q) => q.id === slot);
            if (!pl) return snap;
            const near = (o: { x: number; y: number }) => Math.abs(o.x - pl.x) < R && Math.abs(o.y - pl.y) < R;
            return { ...snap, zombies: snap.zombies.filter(near), bullets: snap.bullets.filter(near) };
          });
          this.pendingEvents = [];
        }
      } else {
        sim.takeObjDelta(); // ソロでは差分は不要なので捨てる
      }
      if (sim.gameOver && !this.gameOverHandled && sim.result) {
        this.gameOverHandled = true;
        const result = sim.result;
        this.o.net?.sendGameOver(result);
        // 全滅：セーブは消える（やり直し）
        clearSave();
        setTimeout(() => this.o.onGameOver(result), 1800);
        break;
      }
    }
  };

  // ---------------- ゲスト：予測とリコンシリエーション ----------------

  private reconcile(s: Snapshot): void {
    const me = s.players.find((p) => p.id === this.o.localId);
    if (!me) return;
    this.pendingInputs = this.pendingInputs.filter((f) => f.seq > me.ack);
    this.localShotSeqs = this.localShotSeqs.filter((q) => q > me.ack);
    const before = this.pred ? { x: this.pred.x, y: this.pred.y } : null;
    const pred: MoveBody = {
      x: me.x,
      y: me.y,
      bodyAngle: me.bodyAngle,
      dashTime: me.dashTime,
      dashCd: me.dashCd,
      dashDx: me.dashDx,
      dashDy: me.dashDy,
      stamina: me.stamina,
      staminaDelay: me.staminaDelay,
      stmMax: me.stmMax,
      stmRegen: me.stmRegen,
      spdMul: me.spdMul,
      noDash: me.noDash,
    };
    // 車に乗っている間は歩きの予測をしない（位置はホストの車に従う）
    if (!me.veh) for (const f of this.pendingInputs) stepMovement(pred, f, f.dt, me.status, this.world);
    else this.predErr = { x: 0, y: 0 };
    if (before && !me.veh) {
      this.predErr.x += before.x - pred.x;
      this.predErr.y += before.y - pred.y;
      if (Math.hypot(this.predErr.x, this.predErr.y) > 120) this.predErr = { x: 0, y: 0 };
    }
    this.pred = pred;
  }

  private renderTime(nowSec: number): number {
    return nowSec + (this.timeOffset ?? 0) - INTERP_DELAY;
  }

  private fireEvents(b: BufferedSnap): void {
    b.fired = true;
    for (const ev of b.snap.events) {
      if (ev.k === 'wall' && ev.o === this.o.localId) continue; // ローカル予測弾で表現済み
      this.onEvent(ev);
    }
  }

  private buildGuestView(nowSec: number): ViewState | null {
    if (this.snaps.length === 0 || !this.latest) return null;
    const rt = this.renderTime(nowSec);
    for (const b of this.snaps) if (!b.fired && b.snap.time <= rt) this.fireEvents(b);

    let a = this.snaps[0].snap;
    let b = a;
    for (let i = 0; i < this.snaps.length; i++) {
      const s = this.snaps[i].snap;
      if (s.time <= rt) {
        a = s;
        b = this.snaps[i + 1]?.snap ?? s;
      } else break;
    }
    const span = b.time - a.time;
    const t = span > 0 ? Math.min(1, Math.max(0, (rt - a.time) / span)) : 1;

    const players: PlayerSnap[] = b.players.map((pb) => {
      const pa = a.players.find((p) => p.id === pb.id);
      if (!pa) return pb;
      return {
        ...pb,
        x: lerp(pa.x, pb.x, t),
        y: lerp(pa.y, pb.y, t),
        aim: angleLerp(pa.aim, pb.aim, t),
        bodyAngle: angleLerp(pa.bodyAngle, pb.bodyAngle, t),
        downTimer: lerp(pa.downTimer, pb.downTimer, t),
        reviveProgress: lerp(pa.reviveProgress, pb.reviveProgress, t),
      };
    });

    const aV = new Map((a.vehicles ?? []).map((v) => [v.id, v]));
    const vehicles = (b.vehicles ?? []).map((vb) => {
      const va = aV.get(vb.id);
      if (!va) return vb;
      return { ...vb, x: lerp(va.x, vb.x, t), y: lerp(va.y, vb.y, t), a: angleLerp(va.a, vb.a, t) };
    });
    const aZ = new Map(a.zombies.map((z) => [z.id, z]));
    const zombies = b.zombies.map((zb) => {
      const za = aZ.get(zb.id);
      if (!za) return zb;
      return { ...zb, x: lerp(za.x, zb.x, t), y: lerp(za.y, zb.y, t), angle: angleLerp(za.angle, zb.angle, t) };
    });

    const bullets: BulletSnap[] = [];
    const aB = new Map(a.bullets.map((x) => [x.id, x]));
    for (const bb of b.bullets) {
      if (bb.owner === this.o.localId) continue;
      const ba = aB.get(bb.id);
      if (ba) bullets.push({ ...bb, x: lerp(ba.x, bb.x, t), y: lerp(ba.y, bb.y, t) });
      else if (a === b) bullets.push(bb);
    }

    // 自機：最新の確定状態 + ローカル予測位置
    const meLatest = this.latest.players.find((p) => p.id === this.o.localId);
    const idx = players.findIndex((p) => p.id === this.o.localId);
    if (meLatest && this.pred) {
      // 車の中：補間した車の座席の位置（ほかの人の見え方とそろえる）
      const myVeh = meLatest.veh !== undefined ? vehicles.find((v) => v.id === meLatest.veh) : undefined;
      const seat = myVeh ? seatPos(myVeh, meLatest.seat ?? 0) : null;
      const me: PlayerSnap = {
        ...meLatest,
        x: seat ? seat.x : this.pred.x + this.predErr.x,
        y: seat ? seat.y : this.pred.y + this.predErr.y,
        bodyAngle: this.pred.bodyAngle,
        dashTime: this.pred.dashTime,
        dashCd: this.pred.dashCd,
        stamina: this.pred.stamina,
        aim: this.localAim,
        tool: this.localTool,
      };
      // 予測で撃った分だけ装填数を減らして見せる
      const held = heldWeapon(me);
      if (held && this.localShotSeqs.length) {
        const k = this.localTool === Tool.Primary ? 'prim' : 'sec';
        me[k] = { ...held, w: { ...held.w, mag: Math.max(0, held.w.mag - this.localShotSeqs.length) } };
      }
      if (idx >= 0) players[idx] = me;
      else players.push(me);
    }
    for (const lb of this.localBullets) bullets.push(lb);

    const L = this.latest;
    return {
      time: rt,
      tick: b.tick,
      day: L.day,
      minute: L.minute,
      phase: L.phase,
      weather: L.weather,
      wx: L.wx,
      base: L.base,
      drop: L.drop,
      jobs: L.jobs,
      sites: L.sites,
      rescue: L.rescue,
      winter: L.winter,
      acid: L.acid,
      spits: L.spits,
      vehicles,
      radio: L.radio,
      cont: L.cont,
      storage: this.storage ?? undefined,
      players,
      zombies,
      bullets,
    };
  }

  private updateLocalBullets(dt: number, view: ViewState | null): void {
    for (const b of this.localBullets) {
      for (let s = 0; s < 2 && b.life > 0; s++) {
        b.x += (b.vx * dt) / 2;
        b.y += (b.vy * dt) / 2;
        if (this.world.blocksBullet(Math.floor(b.x / TILE), Math.floor(b.y / TILE))) {
          b.life = 0;
          this.onEvent({ k: 'wall', x: b.x - b.vx * 0.005, y: b.y - b.vy * 0.005, o: this.o.localId });
          break;
        }
        if (view) {
          for (const z of view.zombies) {
            const r = ZOMBIE[z.type].radius + 3;
            if ((z.x - b.x) ** 2 + (z.y - b.y) ** 2 < r * r) {
              b.life = 0; // 見た目上の消滅のみ。ダメージはホストが判定
              break;
            }
          }
        }
      }
      b.life -= dt;
    }
    this.localBullets = this.localBullets.filter((b) => b.life > 0);
  }

  // ---------------- メインフレーム ----------------

  private handleToolKeys(): void {
    for (let i = 0; i < 9; i++) if (this.input.consume(`Digit${i + 1}`) && i < USABLE_SLOTS) this.localTool = i;
    const wheel = this.input.consumeWheel();
    if (wheel) this.localTool = (this.localTool + (wheel > 0 ? 1 : -1) + USABLE_SLOTS) % USABLE_SLOTS;
  }

  private frame = (nowMs: number): void => {
    if (!this.running) return;
    this.rafId = requestAnimationFrame(this.frame);
    const dt = Math.min(0.1, Math.max(0, (nowMs - this.lastFrame) / 1000));
    this.lastFrame = nowMs;
    this.perf.beginFrame(nowMs);
    try {
      this.frameBody(nowMs, dt);
    } finally {
      this.perf.endFrame();
    }
  };

  private frameBody(nowMs: number, dt: number): void {
    const localId = this.o.localId;

    let myPos: { x: number; y: number } | null = null;
    let myStatus: PlayerSnap['status'] = 'alive';
    let meServer: PlayerSnap | undefined;
    if (this.sim) {
      const p = this.sim.players.find((pl) => pl.id === localId);
      if (p) {
        myPos = p;
        myStatus = p.status;
      }
    } else if (this.pred && this.latest) {
      myPos = { x: this.pred.x + this.predErr.x, y: this.pred.y + this.predErr.y };
      meServer = this.latest.players.find((p) => p.id === localId);
      myStatus = meServer?.status ?? 'dead';
    }

    // ---- 入力 ----
    this.applyGamepad(myPos, myStatus);
    const prevTool = this.localTool;
    // V：建設モード（建てる物は 1〜6・ホイールで選ぶ）
    if (this.input.consume('KeyV')) {
      this.buildKind = this.buildKind ? null : this.lastBuild;
      if (this.buildKind) {
        this.craftMenu.toggle(false);
        this.invPanel.toggle(false);
      }
      audio.click();
    }
    if (this.buildKind) {
      for (let i = 0; i < BUILDS.length; i++)
        if (this.input.consume(`Digit${(i + 1) % 10}`)) {
          this.buildKind = BUILDS[i].kind;
          audio.click();
        }
      const wheel = this.input.consumeWheel();
      if (wheel) {
        const i = BUILDS.findIndex((b) => b.kind === this.buildKind);
        this.buildKind = BUILDS[(i + (wheel > 0 ? 1 : -1) + BUILDS.length) % BUILDS.length].kind;
        audio.click();
      }
      this.lastBuild = this.buildKind;
      if (myStatus !== 'alive') this.buildKind = null;
    } else this.handleToolKeys();
    if (this.localTool !== prevTool) audio.click();
    if (this.input.consume('KeyM')) audio.toggleMute();
    // F2：写真モード（HUD を消す。ストア用・スクリーンショット用）
    if (this.input.consume('F2')) {
      this.renderer.photo = !this.renderer.photo;
      this.hudButtons.style.visibility = this.renderer.photo ? 'hidden' : '';
    }
    this.muteBtn.textContent = audio.settings.muted ? '🔇' : '🔊';
    // Esc を先に処理する（重くて Esc と Tab/C が同じフレームに入っても、後から押したほうが効く）
    if (this.input.consume('Escape')) {
      this.buildKind = null;
      this.craftMenu.toggle(false);
      this.invPanel.toggle(false);
      this.mapOpen = false;
    }
    // B：全体地図
    if (this.input.consume('KeyB')) {
      this.mapOpen = !this.mapOpen;
      audio.click();
    }
    if (this.input.consume('KeyC')) {
      this.invPanel.toggle(false);
      this.craftMenu.toggle();
    }
    if (this.input.consume('Tab')) {
      this.craftMenu.toggle(false);
      this.invPanel.toggle();
    }
    // F：パネルが開いていれば閉じる。作業台がいちばん近ければクラフト画面、それ以外はホストに任せる（ドア・探索・倉庫）
    let interact = this.input.consume('KeyF');
    if (interact && (this.craftMenu.open || this.invPanel.open)) {
      this.craftMenu.toggle(false);
      this.invPanel.toggle(false);
      interact = false;
    } else if (interact && myPos && this.nearestUsable(myPos) === 'bench') {
      this.craftMenu.toggle(true);
      interact = false;
    } else if (interact && myPos && this.nearestUsable(myPos) === 'stove') {
      this.craftMenu.openTab('craft');
      interact = false;
    }
    // T：弾種（通常弾 ⇄ 徹甲弾/スラッグ）の切り替え
    if (this.input.consume('KeyT') && (this.localTool === Tool.Primary || this.localTool === Tool.Secondary)) {
      this.ops.push(`ammo:${this.localTool === Tool.Primary ? 'prim' : 'sec'}`);
      audio.click();
    }
    const mv = this.input.getMove();
    const mw = this.renderer.screenToWorld(this.input.mouseX, this.input.mouseY);
    const aim = myPos ? Math.atan2(mw.y - myPos.y, mw.x - myPos.x) : this.localAim;
    this.localAim = aim;
    // 建設モード：置く場所（マウスのマス。タッチは向いている方向の2マス先）と、置けるかどうか
    let fireNow = this.input.consumeFire();
    const clickNow = this.input.consumeClick();
    const altNow = this.input.consumeAltClick() || this.input.consume('KeyX');
    const touchEdge = this.input.touchFire && !this.touchFirePrev;
    this.touchFirePrev = this.input.touchFire;
    const pv = this.prevView;
    if (this.buildKind && myPos && pv) {
      const gx = this.touch ? myPos.x + Math.cos(aim) * TILE * 2.2 : mw.x;
      const gy = this.touch ? myPos.y + Math.sin(aim) * TILE * 2.2 : mw.y;
      const tx = Math.floor(gx / TILE);
      const ty = Math.floor(gy / TILE);
      const occ = [...pv.players.filter((p) => p.status !== 'dead' && !p.away), ...pv.zombies];
      let err = buildSpotError(this.world, this.buildKind, tx, ty, myPos.x, myPos.y, occ);
      const me = pv.players.find((p) => p.id === localId);
      const def = buildDef(this.buildKind)!;
      if (!err && (def.lv ?? 1) > (pv.base.bench ?? 1)) err = `作業台 Lv${def.lv} が必要`;
      if (!err && me) {
        const short = canAfford(def, me.bag, (pv.storage ?? this.storage)?.shared ?? null);
        if (short) err = `素材が足りない（${ITEMS[short].name}）`;
      }
      this.buildGhost = { tx, ty, err };
      if (clickNow || touchEdge) {
        this.ops.push(`build:${this.buildKind}:${tx}:${ty}`);
      }
      if (altNow) {
        const ob = this.world.objAt(tx, ty);
        if (ob && BUILD_KINDS.has(ob.kind)) this.ops.push(`unbuild:${ob.id}`);
      }
      fireNow = false;
    } else this.buildGhost = null;
    const frame: InputFrame = {
      seq: ++this.seq,
      dt,
      mx: mv.x,
      my: mv.y,
      aim,
      fire: fireNow,
      revive: this.input.isDown('KeyE'),
      dash: this.input.consumeDash(),
      interact,
      reload: this.input.consume('KeyR'),
      craft: this.pendingCraft,
      op: this.ops.shift() ?? '',
      ping: this.input.consume('KeyG'),
      eat: this.input.consume('KeyQ'),
      heal: this.input.consume('KeyH'),
      tool: this.localTool,
      tx: Math.floor(mw.x / TILE),
      ty: Math.floor(mw.y / TILE),
    };

    this.pendingCraft = '';
    let view: ViewState | null;
    const tSim = performance.now();
    if (this.sim) {
      this.sim.queueInput(localId, frame);
      if (!this.o.secondary) this.pump();
      view = this.sim.view();
    } else {
      const inVeh = this.latest?.players.find((p) => p.id === localId)?.veh !== undefined;
      if (this.pred && this.latest && myStatus !== 'dead' && !inVeh) {
        stepMovement(this.pred, frame, dt, myStatus, this.world);
        this.pendingInputs.push(frame);
        if (this.pendingInputs.length > 240) this.pendingInputs.shift();
      }
      this.o.net?.sendInput(frame);
      const decay = Math.exp(-10 * dt);
      this.predErr.x *= decay;
      this.predErr.y *= decay;
      this.predictLocalActions(frame, myStatus, meServer, dt);
      view = this.buildGuestView(nowMs / 1000);
      this.updateLocalBullets(dt, view);
    }

    this.perf.add('sim', performance.now() - tSim);
    if (!view) {
      this.drawWaiting();
      return;
    }

    const me = view.players.find((p) => p.id === localId);
    if (me) {
      this.syncPanels(me, view);
      this.craftMenu.update(me.bag, me.prim, me.sec, this.nearBench(me), view.base, view.storage ?? this.storage, this.nearKind(me, 'stove'));
      this.saveProgress(me, view.day);
    }
    // 弾切れのカチッという音
    const held = me ? heldWeapon({ ...me, tool: this.localTool }) : null;
    if (me && me.status === 'alive' && frame.fire && me.reloadT <= 0 && held && held.w.mag <= 0) audio.emptyClick();
    const reviveHint =
      !!me &&
      me.status === 'alive' &&
      view.players.some((p) => p.id !== localId && p.status === 'down' && Math.hypot(p.x - me.x, p.y - me.y) <= PLAYER.reviveRange);

    // 地図を開いている間は右下のボタンを隠す（地図の枠に重ならないように）
    this.hudButtons.style.visibility = this.mapOpen || this.renderer.photo ? 'hidden' : '';
    // パネル・地図を開いている間は、タッチのスティックを止めてパネルを触れるようにする
    this.touch?.show(!this.mapOpen && !this.craftMenu.open && !this.invPanel.open);
    if (this.o.root) this.fitPanels();
    this.padifyPanels();
    this.renderer.render(view, {
      localId,
      mode: this.o.mode,
      roomCode: this.o.roomCode,
      effects: this.effects,
      dt,
      mouseX: this.input.mouseX,
      mouseY: this.input.mouseY,
      skipAnimDetectId: this.o.mode === 'guest' ? localId : null,
      localTool: this.localTool,
      mapOpen: this.mapOpen,
      panelOpen: this.craftMenu.open || this.invPanel.open,
      reviveHint,
      interactHint: me && me.status === 'alive' && !this.buildKind ? this.touchWords(this.interactHint(me) ?? this.giveHint(me, view, dt)) : null,
      build: this.buildKind && this.buildGhost ? { kind: this.buildKind, ...this.buildGhost } : null,
      touch: !!this.touch,
      pad: !!this.pad?.active && (!!this.o.secondary || this.pad.usedT > this.input.mouseT),
      glyphs: this.pad?.active ? this.pad.glyphs() : null,
      syncMs: this.o.mode === 'guest' ? this.o.net?.snapInterval : undefined,
      muted: audio.settings.muted,
    });
    this.prevView = view;
    const pt = this.renderer.perfT;
    this.perf.add('world', pt.world);
    this.perf.add('light', pt.light);
    this.perf.add('over', pt.over);
    this.perf.add('hud', pt.hud);
    if (this.perf.open) this.perf.counts = this.perfCounts(view);
    // 聞き手の位置＝カメラ中心。BGMの曲調と環境音を更新
    audio.listener.x = this.renderer.cam.x;
    audio.listener.y = this.renderer.cam.y;
    if (!this.o.secondary) audio.update(dt, view, this.campfires);
  }

  /** パフォーマンス表示に出す数値 */
  private perfCounts(view: ViewState): PerfCounts {
    const r = this.renderer.perfInfo();
    const n = this.renderer.perfN;
    const sim = this.sim;
    const act = sim ? sim.chunkActive.reduce((s, v) => s + v, 0) : 0;
    const net =
      this.o.mode === 'solo'
        ? 'ソロ'
        : this.o.mode === 'host'
          ? `ホスト（ゲスト ${Math.max(0, view.players.length - 1)}人）`
          : `ゲスト 同期間隔 ${Math.round(this.o.net?.snapInterval ?? 0)}ms`;
    return {
      zombies: sim ? sim.zombies.length : view.zombies.length,
      zombiesDrawn: n.zombiesDrawn,
      objects: n.objects,
      particles: n.particles,
      chunks: sim ? `${act}/${sim.chunkActive.length} 稼働` : '（ホスト側で計算）',
      terrain: r.terrain,
      res: r.res,
      net,
    };
  }

  /** ゲスト：射撃・近接の見た目を即時に出す（判定はホスト） */
  private predictLocalActions(frame: InputFrame, status: PlayerSnap['status'], me: PlayerSnap | undefined, dt: number): void {
    this.localFireCd -= dt;
    this.localSwingCd = Math.max(0, this.localSwingCd - dt);
    if (!frame.fire || status !== 'alive' || !me || !this.pred) {
      if (this.localFireCd < 0) this.localFireCd = 0;
      return;
    }
    const held = heldWeapon({ ...me, tool: this.localTool });
    const wid = held?.id ?? null;
    if (held && wid) {
      const w = effectiveStats(wid, held.w);
      const mag = held.w.mag - this.localShotSeqs.length;
      if (me.reloadT > 0 || mag <= 0 || me.tool !== this.localTool) {
        if (this.localFireCd < 0) this.localFireCd = 0;
        return;
      }
      if (this.localFireCd <= 0) {
        this.localFireCd += w.fireInterval;
        const px = this.pred.x + this.predErr.x;
        const py = this.pred.y + this.predErr.y;
        for (let i = 0; i < w.pellets; i++) {
          const a = this.localAim + (Math.random() - 0.5) * 2 * w.spread;
          this.localBullets.push({
            id: this.localBulletId--,
            owner: this.o.localId,
            x: px + Math.cos(this.localAim) * MUZZLE,
            y: py + Math.sin(this.localAim) * MUZZLE,
            vx: Math.cos(a) * w.bulletSpeed,
            vy: Math.sin(a) * w.bulletSpeed,
            life: w.bulletLife,
          });
        }
        this.localShotSeqs.push(frame.seq);
        this.renderer.triggerShot(this.o.localId, wid, px, py, this.localAim);
        audio.shot(px, py, true, wid);
      }
    } else if (this.localTool === Tool.Melee && this.localSwingCd <= 0) {
      this.localSwingCd = AXE.interval;
      this.renderer.triggerSwing(this.o.localId);
      audio.swing(this.pred.x, this.pred.y, true);
    }
  }

  /** スキル経験値を自分のブラウザに保存（数秒おき） */
  private saveProgress(me: PlayerSnap, day: number): void {
    const now = performance.now();
    if (now - this.lastSave < 4000) return;
    this.lastSave = now;
    const prof = loadProfile();
    prof.xp = me.xp.map((v, i) => Math.max(v, prof.xp[i] ?? 0));
    prof.bestDay = Math.max(prof.bestDay, day);
    saveProfile(prof);
  }

  /** 入れ物・倉庫のパネルをサーバーの状態に合わせて開閉する */
  private syncPanels(me: PlayerSnap, view: ViewState): void {
    // 新しく武器を装備したら持ち替える
    const pk = me.prim?.id ?? '';
    const sk = me.sec?.id ?? '';
    if (pk && pk !== this.lastPrim) this.localTool = Tool.Primary;
    else if (sk && sk !== this.lastSec && !pk) this.localTool = Tool.Secondary;
    this.lastPrim = pk;
    this.lastSec = sk;
    const opened = (me.viewing && me.viewing !== this.lastViewing) || (me.storage && !this.lastStorageOpen);
    const closed = (!me.viewing && this.lastViewing) || (!me.storage && this.lastStorageOpen);
    this.lastViewing = me.viewing;
    this.lastStorageOpen = me.storage;
    if (opened && !this.invPanel.open) {
      this.craftMenu.toggle(false);
      this.autoOpened = true;
      this.invPanel.toggle(true);
    } else if (closed && !me.viewing && !me.storage && this.autoOpened) {
      this.autoOpened = false;
      this.invPanel.toggle(false, true);
    }
    const ob = me.viewing ? this.world.objects.get(me.viewing) : undefined;
    this.invPanel.update({
      me,
      cont: me.viewing && view.cont[me.viewing] ? { id: me.viewing, name: me.viewing >= VEHICLE.trunkBase ? '車のトランク' : (CONTAINER_NAMES[ob?.kind ?? 'bag'] ?? '入れ物'), slots: view.cont[me.viewing] } : null,
      storage: view.storage ?? this.storage,
      coop: view.players.length > 1,
      allies: view.players.filter((p) => p.id !== me.id && p.status === 'alive' && Math.hypot(p.x - me.x, p.y - me.y) < GIVE_RANGE).map((p) => ({ id: p.id, name: p.name })),
    });
  }

  private nearAllies = new Set<number>();
  private giveHintT = 0;
  /** 仲間がそばに来たら数秒だけ、手渡しの方法を案内する */
  private giveHint(me: PlayerSnap, view: ViewState, dt: number): string | null {
    this.giveHintT = Math.max(0, this.giveHintT - dt);
    const near = new Set(view.players.filter((p) => p.id !== me.id && p.status === 'alive' && Math.hypot(p.x - me.x, p.y - me.y) < GIVE_RANGE).map((p) => p.id));
    for (const id of near) if (!this.nearAllies.has(id)) this.giveHintT = 4;
    this.nearAllies = near;
    return this.giveHintT > 0 && near.size ? '[Tab] 持ち物 → 手渡す相手を選んでアイテムをクリック' : null;
  }

  /** F で操作される対象（ホストの interact と同じ選び方） */
  private nearestUsable(pos: { x: number; y: number }): string | null {
    const ptx = Math.floor(pos.x / TILE);
    const pty = Math.floor(pos.y / TILE);
    let best: string | null = null;
    let bd = 64;
    for (let ty = pty - 2; ty <= pty + 2; ty++)
      for (let tx = ptx - 2; tx <= ptx + 2; tx++) {
        const ob = this.world.objAt(tx, ty);
        if (!ob) continue;
        const usable =
          ob.kind === 'door' ||
          ob.kind === 'stove' ||
          ob.kind === 'radio' ||
          ob.kind === 'sbox' ||
          ob.kind === 'cot' ||
          ob.kind === 'bed' ||
          STORAGE_KINDS.has(ob.kind) ||
          (CONTAINER_KINDS.has(ob.kind) && (ob.kind !== 'car' || ob.hp > 0)) ||
          (BUILD_KINDS.has(ob.kind) && (ob.hp < ob.maxHp || (ob.kind === 'raintank' && ob.ready > 0)));
        if (!usable) continue;
        const d = Math.hypot((tx + 0.5) * TILE - pos.x, (ty + 0.5) * TILE - pos.y) - (ob.kind === 'door' ? 0 : 6);
        if (d < bd) {
          bd = d;
          best = ob.kind;
        }
      }
    if (best) return best;
    return this.nearBench(pos) ? 'bench' : null;
  }

  private nearKind(pos: { x: number; y: number }, kind: string): boolean {
    const r = Math.ceil(BENCH_RANGE / TILE) + 1;
    const ptx = Math.floor(pos.x / TILE);
    const pty = Math.floor(pos.y / TILE);
    for (let ty = pty - r; ty <= pty + r; ty++)
      for (let tx = ptx - r; tx <= ptx + r; tx++) {
        const ob = this.world.objAt(tx, ty);
        if (ob && ob.kind === kind && Math.hypot((tx + 0.5) * TILE - pos.x, (ty + 0.5) * TILE - pos.y) < BENCH_RANGE) return true;
      }
    return false;
  }

  private nearBench(pos: { x: number; y: number }): boolean {
    // 周りのタイルだけを調べる（毎フレーム呼ばれるので、ワールド全体は走査しない）
    const r = Math.ceil(BENCH_RANGE / TILE) + 1;
    const ptx = Math.floor(pos.x / TILE);
    const pty = Math.floor(pos.y / TILE);
    for (let ty = pty - r; ty <= pty + r; ty++)
      for (let tx = ptx - r; tx <= ptx + r; tx++) {
        const ob = this.world.objAt(tx, ty);
        if (ob && (ob.kind === 'bench' || ob.kind === 'wbench') && Math.hypot((tx + 0.5) * TILE - pos.x, (ty + 0.5) * TILE - pos.y) <= BENCH_RANGE) return true;
      }
    return false;
  }

  /** コントローラーの入力を、キー・マウスの入力に置き換えて渡す（ゲーム中だけ。パネルでは画面のカーソル） */
  private applyGamepad(myPos: { x: number; y: number } | null, status: PlayerSnap['status']): void {
    const menu = this.craftMenu.open || this.invPanel.open || this.mapOpen || this.padSettings.open;
    const pad = this.pad;
    if (pad) pad.gameplay = !menu;
    const g = pad?.current() ?? null;
    const release = () => {
      if (this.padMove) this.input.touchMove = null;
      if (this.padFire) this.input.touchFire = false;
      if (this.padRevive) this.input.setKey('KeyE', false);
      this.padMove = this.padFire = this.padRevive = false;
    };
    if (!g || !pad || menu) {
      release();
      return;
    }
    const pr = pad.takePressed();
    // 移動
    if (pad.lx || pad.ly) {
      this.input.touchMove = { x: pad.lx, y: pad.ly };
      this.padMove = true;
    } else if (this.padMove) {
      this.input.touchMove = null;
      this.padMove = false;
    }
    // 射撃（RT）
    const fire = pad.rt > 0.5;
    if (fire || this.padFire) {
      this.input.touchFire = fire;
      this.padFire = fire;
    }
    // 蘇生（LT 長押し。設定で「押すたびに切り替え」：もう一度押すか、動くと止まる）
    let rev = pad.lt > 0.5;
    if (padPrefs.toggle) {
      if (rev && !this.padLtHeld) this.padReviveOn = !this.padReviveOn;
      this.padLtHeld = rev;
      if (pad.lx || pad.ly) this.padReviveOn = false;
      rev = this.padReviveOn;
    }
    if (rev !== this.padRevive) {
      this.input.setKey('KeyE', rev);
      this.padRevive = rev;
    }
    // 照準（右スティック）：自分から見た向きと距離。マウスを最後に使っていたらマウスを優先
    const m = Math.hypot(pad.rx, pad.ry);
    if (m > 0.15) this.padAim = { x: (pad.rx / m) * (90 + m * 230), y: (pad.ry / m) * (90 + m * 230) };
    // エイム補助：狙っている向きの細い範囲に見えているゾンビがいれば、照準をそちらへ寄せる
    if (myPos && padPrefs.assist > 0 && (m > 0.15 || fire) && !this.buildKind) this.padAim = this.aimAssist(myPos, this.padAim);
    if (myPos && pad.usedT > this.input.mouseT) {
      const s = this.renderer.worldToScreen(myPos.x, myPos.y);
      this.input.mouseX = s.x + this.padAim.x;
      this.input.mouseY = s.y + this.padAim.y;
    }
    if (status === 'dead') return;
    const key = (b: number, code: string) => {
      if (pr.has(b)) this.input.press(code);
    };
    // ボタンの割り当ては設定で変えられる（padBtn）。LB/RB・トリガーは固定
    key(padBtn('use'), 'KeyF');
    if (pr.has(padBtn('dash'))) this.input.pressDash();
    key(padBtn('reload'), this.buildKind ? 'KeyX' : 'KeyR');
    if (pr.has(padBtn('next')) || pr.has(PAD.RB)) this.input.wheel += 1;
    if (pr.has(PAD.LB)) this.input.wheel -= 1;
    key(padBtn('inv'), 'Tab');
    key(padBtn('map'), 'KeyB');
    key(padBtn('eat'), 'KeyQ');
    key(padBtn('heal'), 'KeyH');
    key(padBtn('ping'), 'KeyG');
    key(padBtn('build'), 'KeyV');
    key(padBtn('craft'), 'KeyC');
    key(padBtn('ammo'), 'KeyT');
  }

  /** コントローラーで遊んでいる間は、パネルの説明文もボタン名に（戻せるよう元の文を覚えておく） */
  private padified = false;
  private padifyPanels(): void {
    const on = !!this.pad?.active && this.pad.usedT > this.input.mouseT;
    const panels = [this.o.root ? this.o.root.querySelector<HTMLElement>('#inv-panel') : document.getElementById('inv-panel'), this.o.root ? this.o.root.querySelector<HTMLElement>('#craft-panel') : document.getElementById('craft-panel')];
    if (!on && !this.padified) return;
    const g = on ? this.pad!.glyphs() : null;
    for (const panel of panels) {
      if (!panel || panel.classList.contains('hidden')) continue;
      // 閉じ方・操作の一行は丸ごと差し替え
      for (const el of panel.querySelectorAll<HTMLElement>('.modal-hint, .ph-sub')) {
        if (el.dataset.orig === undefined) el.dataset.orig = el.innerHTML;
        const want = g
          ? el.classList.contains('ph-sub')
            ? padText('{A} 移す／使う ・ {X} 使う・装備 ・ {Y} 全部取る（入れ物）／捨てる ・ {LB}/{RB} タブ', g)
            : padText('{B} で閉じる ・ 十字キーで選ぶ ・ 右スティックでカーソル ・ ゲームは止まりません', g)
          : el.dataset.orig;
        if (el.innerHTML !== want) el.innerHTML = want;
      }
      if (!g) continue;
      // それ以外の説明文（作業台の注意書き・アイテムの説明）は語句を置き換え
      const walker = document.createTreeWalker(panel, NodeFilter.SHOW_TEXT);
      for (let n = walker.nextNode(); n; n = walker.nextNode()) {
        const v = n.nodeValue ?? '';
        if (!/\[|クリック|移動キー/.test(v)) continue;
        const t = padText(v, g);
        if (t !== v) n.nodeValue = t;
      }
    }
    this.padified = on;
  }

  /** 画面分割：開いているパネルが枠に収まるよう縮める */
  private fitted = new WeakMap<HTMLElement, string>();
  private fitPanels(): void {
    const root = this.o.root!;
    for (const el of root.querySelectorAll<HTMLElement>('#inv-panel, #craft-panel')) {
      if (el.classList.contains('hidden')) {
        this.fitted.delete(el);
        continue;
      }
      const key = `${root.clientWidth}x${root.clientHeight}|${el.innerHTML.length}`;
      if (this.fitted.get(el) === key) continue;
      el.style.zoom = '1';
      el.style.maxHeight = el.style.maxWidth = el.style.overflow = '';
      const w = el.offsetWidth;
      const h = el.offsetHeight;
      const k = Math.min(1, (root.clientWidth - 16) / Math.max(1, w), (root.clientHeight - 16) / Math.max(1, h));
      // 文字が読める大きさ（0.75 倍）より小さくはしない。はみ出す分はスクロール（十字キーで選ぶと自動で追う）
      const z = Math.max(0.75, k);
      el.style.zoom = String(z);
      if (k < z) {
        el.style.maxHeight = `${Math.floor((root.clientHeight - 16) / z)}px`;
        el.style.maxWidth = `${Math.floor((root.clientWidth - 16) / z)}px`;
        el.style.overflow = 'auto';
      }
      this.fitted.set(el, key);
    }
  }

  /** エイム補助（強さ：弱・中・強で、寄せる範囲と量が増える）。照準の距離は変えず向きだけ寄せる */
  private aimAssist(me: { x: number; y: number }, aim: { x: number; y: number }): { x: number; y: number } {
    const cone = [0, 0.12, 0.2, 0.28][padPrefs.assist];
    const pull = [0, 0.45, 0.7, 0.9][padPrefs.assist];
    const a = Math.atan2(aim.y, aim.x);
    let best = 0;
    let bs = Infinity;
    for (const z of this.prevView?.zombies ?? []) {
      const dx = z.x - me.x;
      const dy = z.y - me.y;
      const d = Math.hypot(dx, dy);
      if (d > 720 || d < 8) continue;
      const diff = Math.atan2(Math.sin(Math.atan2(dy, dx) - a), Math.cos(Math.atan2(dy, dx) - a));
      // 遠いほど小さく見えるので、範囲は「角度」と「横のずれ（最大 60px）」の広いほう
      const lim = Math.max(cone, Math.atan2(cone * 260, d));
      if (Math.abs(diff) > lim) continue;
      if (!this.renderer.canSee(z.x, z.y)) continue;
      const score = Math.abs(diff) / lim + d / 2000;
      if (score < bs) {
        bs = score;
        best = diff;
      }
    }
    if (bs === Infinity) return aim;
    const na = a + best * pull;
    const len = Math.hypot(aim.x, aim.y);
    return { x: Math.cos(na) * len, y: Math.sin(na) * len };
  }

  /** タッチ端末では、キーの名前をボタンの名前に置き換える */
  private touchWords(h: string | null): string | null {
    if (h && this.pad?.active && this.pad.usedT > this.input.mouseT) return padText(h, this.pad.glyphs());
    if (!h || !this.touch) return h;
    return h.replace(/\[F\]/g, '[調べる]').replace(/\[E\] 長押し/g, '[蘇生] 長押し').replace(/\[Q\]/g, '[食事]').replace(/\[C\]/g, '[作業台]').replace(/移動キー/g, '左スティック');
  }

  private interactHint(me: PlayerSnap): string | null {
    if (me.searchId) return null;
    // 車：乗っている間は降りる案内。近くにあれば、位置と状態で何ができるか
    if (me.veh !== undefined) return me.seat === 0 ? '[F] 降りる ・ 移動キーの方向へ走る（後ろへ倒すと U ターン・ぶつかると自動で切り返し）' : '[F] 降りる ・ 窓から撃てる';
    let nv: VehicleSnap | null = null;
    let nd = 62;
    for (const v of this.prevView?.vehicles ?? []) {
      const tp = trunkPos(v);
      const d = Math.min(Math.hypot(v.x - me.x, v.y - me.y), Math.hypot(tp.x - me.x, tp.y - me.y) + 6);
      if (d < nd) {
        nd = d;
        nv = v;
      }
    }
    if (nv) {
      const tp = trunkPos(nv);
      const name = nv.kind === 'pickup' ? 'ピックアップ' : 'セダン';
      if (Math.hypot(tp.x - me.x, tp.y - me.y) < 30 && Math.abs(nv.spd) < 20) return `[F] ${name}のトランクを開ける`;
      if (nv.broken) return `[F] ${name}を修理（鉄くず${VEHICLE.repairCost.scrap}・武器パーツ${VEHICLE.repairCost.parts}）`;
      if (nv.fuel < 65 && countItem(me.bag, 'fuel') > 0 && !nv.seats.some((s) => s >= 0)) return `[F] 給油（ガソリン缶 → 燃料 ${Math.round(nv.fuel)}% +${VEHICLE.fuelPerCan}）`;
      const free = nv.seats.filter((s) => s < 0).length;
      if (!free) return `${name}：満席`;
      return nv.seats[0] < 0 ? `[F] ${name}を運転する（燃料 ${Math.round(nv.fuel)}%・後ろに回るとトランク）` : `[F] 同乗する（あと ${free} 人）`;
    }
    const ptx = Math.floor(me.x / TILE);
    const pty = Math.floor(me.y / TILE);
    let best: string | null = null;
    let bd = 64;
    for (let ty = pty - 2; ty <= pty + 2; ty++)
      for (let tx = ptx - 2; tx <= ptx + 2; tx++) {
        const ob = this.world.objAt(tx, ty);
        if (!ob) continue;
        const d = Math.hypot((tx + 0.5) * TILE - me.x, (ty + 0.5) * TILE - me.y) - (ob.kind === 'door' ? 0 : 6);
        if (d >= bd) continue;
        let h: string | null = null;
        if (ob.kind === 'door') h = ob.ready ? '[F] ドアを閉める' : '[F] ドアを開ける（音が出る）';
        else if (STORAGE_KINDS.has(ob.kind)) h = '[F] 倉庫を開く（個人・共有）';
        else if (ob.kind === 'radio') {
          const ready = (this.prevView?.jobs ?? []).some((j) => !j.done && j.kind === 'fetch' && (j.have ?? 0) >= (j.need ?? 1));
          h = ready ? '[F] 無線で依頼の品を報告する' : '[F] 無線：今日の依頼を確認';
        } else if (ob.kind === 'stove') h = ob.hp < ob.maxHp * 0.6 ? '[F] 料理（かまどが傷んでいる：撤去して建て直せる）' : '[F] 調理かまど：温かい料理を作る';
        else if (ob.kind === 'raintank') h = ob.ready > 0 ? `[F] 水を回収（${ob.ready}/6）` : ob.hp < ob.maxHp ? '[F] 修理（鉄くず1）' : '雨水タンク：雨の日と毎朝に水が貯まる（0/6）';
        else if (BUILD_KINDS.has(ob.kind) && ob.hp < ob.maxHp) h = `[F] 修理（鉄くず1） ${Math.round((ob.hp / ob.maxHp) * 100)}%`;
        else if (ob.kind === 'sbox') h = '[F] 保管箱を開く';
        else if (ob.kind === 'bed' || ob.kind === 'cot') {
          const m = this.prevView?.minute ?? 0;
          h = m >= 20 * 60 || m < 5 * 60 ? (me.sleeping ? null : '[F] 眠る（全員が眠ると朝 6:00 ・ ここが戻る場所になる）') : '眠れるのは夜 20:00〜05:00';
        }
        else if (CONTAINER_KINDS.has(ob.kind) && (ob.kind !== 'car' || ob.hp > 0)) {
          const name = CONTAINER_NAMES[ob.kind] ?? '入れ物';
          h = ob.kind === 'safe' && ob.ready ? '[F] 金庫を開ける — バールを構えて：速いが音が出る／工具セット：遅いが静か' : ob.kind === 'bag' ? `[F] ${name}を調べる` : ob.ready ? `[F] ${name}を探索する` : `[F] ${name}（探索済み）`;
        }
        if (h) {
          bd = d;
          best = h;
        }
      }
    if (best) return best;
    if (this.nearBench(me)) return '[F] / [C] 作業台：クラフト・武器改造';
    if (me.hunger < 30 && countItem(me.bag, 'can') + countItem(me.bag, 'mre') > 0) return '[Q] 食事する';
    return null;
  }

  private drawWaiting(): void {
    const ctx = this.o.canvas.getContext('2d')!;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = '#0b0d10';
    ctx.fillRect(0, 0, this.o.canvas.width, this.o.canvas.height);
    ctx.fillStyle = '#aab4c8';
    ctx.font = '20px sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('ホストからの同期を待っています…', this.o.canvas.width / 2, this.o.canvas.height / 2);
  }

  private onResize = () => this.renderer.resize();
}
