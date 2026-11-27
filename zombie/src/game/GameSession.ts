// ============================================================
// GameSession: ゲームループ本体（モード別の更新・同期・描画）
//   solo  : ローカルで HostSimulation を回す
//   host  : HostSimulation を回し、約30Hzでスナップショット（オブジェクトは差分）を配信
//   guest : 入力を送りつつ自機の移動・照準・射撃エフェクトをクライアント側予測で即時反映、
//           他プレイヤー・ゾンビ・弾はスナップショット間を線形補間して描画
// ============================================================
import { isTouchDevice, TouchControls } from '../ui/TouchControls';
import { clearSave, writeSave } from './save';
import { PerfOverlay, type PerfCounts } from './PerfOverlay';
import type {
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
import { AXE, BENCH_RANGE, INTERP_DELAY, MUZZLE, PLAYER, SNAPSHOT_EVERY, TICK_DT, TILE, USABLE_SLOTS, ZOMBIE } from './constants';
import { CONTAINER_KINDS, GIVE_RANGE, inBase, STORAGE_KINDS } from './Engine';
import { CONTAINER_NAMES, countItem, effectiveStats, heldWeapon } from './items';
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
    this.renderer = new Renderer(o.canvas, this.world);
    this.input = new InputController(o.canvas);
    if (isTouchDevice()) this.touch = new TouchControls(this.input);
    // 効果音：射撃・斧・リロードは描画側のカウンタ検出から鳴らす
    this.renderer.hooks = {
      shot: (p, w) => audio.shot(p.x, p.y, p.id === o.localId, w),
      swing: (p) => audio.swing(p.x, p.y, p.id === o.localId),
      reload: (p) => audio.reload(p.x, p.y, p.id === o.localId),
    };
    this.craftMenu = new CraftMenu(
      document.getElementById('craft-panel')!,
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
    );
    this.invPanel = new InventoryPanel(
      document.getElementById('inv-panel')!,
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
    this.input.attach();
    this.touch?.show(true);
    window.addEventListener('resize', this.onResize);
    this.lastFrame = performance.now();
    this.lastPump = performance.now();
    if (this.sim) this.pumpTimer = window.setInterval(this.pump, 8);
    this.rafId = requestAnimationFrame(this.frame);
    this.hudButtons.classList.remove('hidden');
    document.getElementById('btn-craft')!.onclick = () => this.craftMenu.toggle();
    document.getElementById('btn-inv')!.onclick = () => this.invPanel.toggle();
    document.getElementById('btn-map')!.onclick = () => {
      this.mapOpen = !this.mapOpen;
      audio.click();
    };
    this.muteBtn.onclick = () => {
      audio.toggleMute();
      audio.click();
    };
  }

  stop(): void {
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
    };
    for (const f of this.pendingInputs) stepMovement(pred, f, f.dt, me.status, this.world);
    if (before) {
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
      const me: PlayerSnap = {
        ...meLatest,
        x: this.pred.x + this.predErr.x,
        y: this.pred.y + this.predErr.y,
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
    const prevTool = this.localTool;
    this.handleToolKeys();
    if (this.localTool !== prevTool) audio.click();
    if (this.input.consume('KeyM')) audio.toggleMute();
    this.muteBtn.textContent = audio.settings.muted ? '🔇' : '🔊';
    // Esc を先に処理する（重くて Esc と Tab/C が同じフレームに入っても、後から押したほうが効く）
    if (this.input.consume('Escape')) {
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
    const frame: InputFrame = {
      seq: ++this.seq,
      dt,
      mx: mv.x,
      my: mv.y,
      aim,
      fire: this.input.consumeFire(),
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
      this.pump();
      view = this.sim.view();
    } else {
      if (this.pred && this.latest && myStatus !== 'dead') {
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
      this.craftMenu.update(me.bag, me.prim, me.sec, this.nearBench(me), view.base, view.storage ?? this.storage);
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
    this.hudButtons.style.visibility = this.mapOpen ? 'hidden' : '';
    // パネル・地図を開いている間は、タッチのスティックを止めてパネルを触れるようにする
    this.touch?.show(!this.mapOpen && !this.craftMenu.open && !this.invPanel.open);
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
      interactHint: me && me.status === 'alive' ? (this.interactHint(me) ?? this.giveHint(me, view, dt)) : null,
      syncMs: this.o.mode === 'guest' ? this.o.net?.snapInterval : undefined,
      muted: audio.settings.muted,
    });
    const pt = this.renderer.perfT;
    this.perf.add('world', pt.world);
    this.perf.add('light', pt.light);
    this.perf.add('over', pt.over);
    this.perf.add('hud', pt.hud);
    if (this.perf.open) this.perf.counts = this.perfCounts(view);
    // 聞き手の位置＝カメラ中心。BGMの曲調と環境音を更新
    audio.listener.x = this.renderer.cam.x;
    audio.listener.y = this.renderer.cam.y;
    audio.update(dt, view, this.campfires);
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
      cont: me.viewing && view.cont[me.viewing] ? { id: me.viewing, name: CONTAINER_NAMES[ob?.kind ?? 'bag'] ?? '入れ物', slots: view.cont[me.viewing] } : null,
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
        const usable = ob.kind === 'door' || STORAGE_KINDS.has(ob.kind) || (CONTAINER_KINDS.has(ob.kind) && (ob.kind !== 'car' || ob.hp > 0));
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

  private nearBench(pos: { x: number; y: number }): boolean {
    // 周りのタイルだけを調べる（毎フレーム呼ばれるので、ワールド全体は走査しない）
    const r = Math.ceil(BENCH_RANGE / TILE) + 1;
    const ptx = Math.floor(pos.x / TILE);
    const pty = Math.floor(pos.y / TILE);
    for (let ty = pty - r; ty <= pty + r; ty++)
      for (let tx = ptx - r; tx <= ptx + r; tx++) {
        const ob = this.world.objAt(tx, ty);
        if (ob && ob.kind === 'bench' && Math.hypot((tx + 0.5) * TILE - pos.x, (ty + 0.5) * TILE - pos.y) <= BENCH_RANGE) return true;
      }
    return false;
  }

  private interactHint(me: PlayerSnap): string | null {
    if (me.searchId) return null;
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
        else if (ob.kind === 'bed' && inBase((tx + 0.5) * TILE, (ty + 0.5) * TILE)) {
          const m = this.latest?.minute ?? 0;
          h = m >= 20 * 60 || m < 5 * 60 ? (me.sleeping ? null : '[F] ベッドで眠る（全員が眠ると朝 6:00 まで進む）') : '眠れるのは夜 20:00〜05:00';
        }
        else if (CONTAINER_KINDS.has(ob.kind) && (ob.kind !== 'car' || ob.hp > 0)) {
          const name = CONTAINER_NAMES[ob.kind] ?? '入れ物';
          h = ob.kind === 'bag' ? `[F] ${name}を調べる` : ob.ready ? `[F] ${name}を探索する` : `[F] ${name}（探索済み）`;
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
