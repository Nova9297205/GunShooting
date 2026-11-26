// ============================================================
// GameSession: ゲームループ本体（モード別の更新・同期・描画を統括）
//   solo  : ローカルで HostSimulation を回すだけ
//   host  : HostSimulation を回し、約30Hzでスナップショットを全ゲストへ送信
//   guest : 入力をホストへ送信しつつ、自機はクライアント側予測で即時反映、
//           他プレイヤーと敵はスナップショットを線形補間して描画
// ============================================================
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
  ViewState,
} from '../types';
import { ENEMY, INTERP_DELAY, PLAYER, SNAPSHOT_EVERY, TICK_DT } from './constants';
import { Effects } from './Effects';
import { HostSimulation } from './Engine';
import { InputController } from './Input';
import { angleLerp, lerp, pointInObstacle, stepMovement } from './physics';
import { Renderer } from './Renderer';
import type { NetworkManager } from '../network/NetworkManager';

export interface SessionOptions {
  mode: GameMode;
  canvas: HTMLCanvasElement;
  localId: number;
  lobby: LobbyPlayer[];
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
  private running = false;
  private rafId = 0;
  private pumpTimer = 0;
  private lastFrame = 0;
  private seq = 0;

  // host / solo
  private sim: HostSimulation | null = null;
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
  private localBullets: LocalBullet[] = [];
  private localBulletId = -1;
  private localAim = 0;

  constructor(private o: SessionOptions) {
    this.renderer = new Renderer(o.canvas);
    this.input = new InputController(o.canvas);
    if (o.mode !== 'guest') this.sim = new HostSimulation(o.lobby);
  }

  start(): void {
    this.running = true;
    this.input.attach();
    window.addEventListener('resize', this.onResize);
    this.lastFrame = performance.now();
    this.lastPump = performance.now();
    if (this.sim) {
      // rAF はタブが非表示だと止まるため、シミュレーションは setInterval でも回す。
      // （さらにゲスト入力受信時にも pump するので、ホストタブが裏にあっても進行する）
      this.pumpTimer = window.setInterval(this.pump, 8);
    }
    this.rafId = requestAnimationFrame(this.frame);
  }

  stop(): void {
    this.running = false;
    cancelAnimationFrame(this.rafId);
    clearInterval(this.pumpTimer);
    this.input.detach();
    window.removeEventListener('resize', this.onResize);
  }

  // ---------------- ネットワークからの呼び出し ----------------

  /** ホスト：ゲスト入力を受信 */
  receiveInput(playerId: number, f: InputFrame): void {
    this.sim?.queueInput(playerId, f);
    this.pump();
  }

  /** ホスト：ゲスト切断 */
  removePlayer(playerId: number): void {
    this.sim?.removePlayer(playerId);
  }

  /** ゲスト：スナップショット受信 */
  receiveSnapshot(s: Snapshot): void {
    const now = performance.now() / 1000;
    const est = s.time - now;
    if (this.timeOffset === null || Math.abs(est - this.timeOffset) > 1) this.timeOffset = est;
    else this.timeOffset += (est - this.timeOffset) * 0.05;

    this.snaps.push({ snap: s, fired: false });
    this.latest = s;

    // 古いスナップショットを破棄（未発火イベントは捨てる前に発火）
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

  private pump = (): void => {
    const sim = this.sim;
    if (!sim || !this.running) return;
    const now = performance.now();
    this.acc += Math.min(0.25, (now - this.lastPump) / 1000);
    this.lastPump = now;
    while (this.acc >= TICK_DT) {
      this.acc -= TICK_DT;
      sim.step(TICK_DT);
      const evs = sim.drainEvents();
      for (const ev of evs) this.effects.handleEvent(ev, this.o.localId);
      if (this.o.mode === 'host' && this.o.net) {
        this.pendingEvents.push(...evs);
        if (sim.tick % SNAPSHOT_EVERY === 0 || sim.phase === 'gameover') {
          this.o.net.sendSnapshot(sim.snapshot(this.pendingEvents));
          this.pendingEvents = [];
        }
      }
      if (sim.phase === 'gameover' && !this.gameOverHandled && sim.result) {
        this.gameOverHandled = true;
        const result = sim.result;
        this.o.net?.sendGameOver(result);
        setTimeout(() => this.o.onGameOver(result), 1500);
        break;
      }
    }
  };

  // ---------------- ゲスト：予測とリコンシリエーション ----------------

  private reconcile(s: Snapshot): void {
    const me = s.players.find((p) => p.id === this.o.localId);
    if (!me) return;
    this.pendingInputs = this.pendingInputs.filter((f) => f.seq > me.ack);
    const before = this.pred ? { x: this.pred.x, y: this.pred.y } : null;
    // サーバー確定状態から、未処理入力を再適用
    const pred: MoveBody = {
      x: me.x,
      y: me.y,
      bodyAngle: me.bodyAngle,
      dashTime: me.dashTime,
      dashCd: me.dashCd,
      dashDx: me.dashDx,
      dashDy: me.dashDy,
    };
    for (const f of this.pendingInputs) stepMovement(pred, f, f.dt, me.status);
    if (before) {
      // 補正のズレは見た目上なめらかに吸収する
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
      // 自分の弾の壁ヒットはローカル予測弾で表現済み
      if (ev.k === 'wall' && ev.o === this.o.localId) continue;
      this.effects.handleEvent(ev, this.o.localId);
    }
  }

  /** スナップショットバッファから補間されたビューを作る */
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
      } else {
        if (i === 0) {
          a = s;
          b = s;
        }
        break;
      }
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

    const enemies = b.enemies.map((eb) => {
      const ea = a.enemies.find((e) => e.id === eb.id);
      if (!ea) return eb;
      return {
        ...eb,
        x: lerp(ea.x, eb.x, t),
        y: lerp(ea.y, eb.y, t),
        angle: angleLerp(ea.angle, eb.angle, t),
      };
    });

    // 弾：両スナップショットに存在するものを補間（自分の弾はローカル予測弾で描画）
    const bullets: BulletSnap[] = [];
    const aMap = new Map(a.bullets.map((x) => [x.id, x]));
    for (const bb of b.bullets) {
      if (bb.team === 'p' && bb.owner === this.o.localId) continue;
      const ba = aMap.get(bb.id);
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
        aim: this.localAim,
      };
      if (idx >= 0) players[idx] = me;
      else players.push(me);
    }

    for (const lb of this.localBullets) bullets.push(lb);

    return {
      time: rt,
      tick: b.tick,
      phase: this.latest.phase,
      wave: this.latest.wave,
      phaseTimer: this.latest.phaseTimer,
      enemiesLeft: this.latest.enemiesLeft,
      players,
      enemies,
      bullets,
    };
  }

  private updateLocalBullets(dt: number, view: ViewState | null): void {
    for (const b of this.localBullets) {
      b.x += b.vx * dt;
      b.y += b.vy * dt;
      b.life -= dt;
      if (pointInObstacle(b.x, b.y)) {
        b.life = 0;
        this.effects.handleEvent({ k: 'wall', x: b.x - b.vx * 0.006, y: b.y - b.vy * 0.006, o: this.o.localId }, this.o.localId);
        continue;
      }
      if (view) {
        for (const e of view.enemies) {
          const r = ENEMY[e.type].radius + PLAYER.bulletRadius;
          if ((e.x - b.x) ** 2 + (e.y - b.y) ** 2 < r * r) {
            b.life = 0; // 見た目上の消滅のみ。ダメージはホストが判定
            break;
          }
        }
      }
    }
    this.localBullets = this.localBullets.filter((b) => b.life > 0);
  }

  // ---------------- メインフレーム ----------------

  private frame = (nowMs: number): void => {
    if (!this.running) return;
    this.rafId = requestAnimationFrame(this.frame);
    const dt = Math.min(0.1, Math.max(0, (nowMs - this.lastFrame) / 1000));
    this.lastFrame = nowMs;
    const localId = this.o.localId;

    // ---- 自機の現在位置（照準計算用）----
    let myPos: { x: number; y: number } | null = null;
    let myStatus: PlayerSnap['status'] = 'alive';
    if (this.sim) {
      const p = this.sim.players.find((pl) => pl.id === localId);
      if (p) {
        myPos = p;
        myStatus = p.status;
      }
    } else if (this.pred && this.latest) {
      myPos = { x: this.pred.x + this.predErr.x, y: this.pred.y + this.predErr.y };
      myStatus = this.latest.players.find((p) => p.id === localId)?.status ?? 'dead';
    }

    // ---- 入力サンプリング ----
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
      shoot: this.input.mouseDown,
      revive: this.input.isDown('KeyE'),
      dash: this.input.consumeDash(),
    };

    let view: ViewState | null = null;
    if (this.sim) {
      // ---- ソロ / ホスト ----
      this.sim.queueInput(localId, frame);
      this.pump();
      view = this.sim.view();
    } else {
      // ---- ゲスト：クライアント側予測 ----
      if (this.pred && this.latest && myStatus !== 'dead') {
        stepMovement(this.pred, frame, dt, myStatus);
        this.pendingInputs.push(frame);
        if (this.pendingInputs.length > 240) this.pendingInputs.shift();
      }
      this.o.net?.sendInput(frame);
      const decay = Math.exp(-10 * dt);
      this.predErr.x *= decay;
      this.predErr.y *= decay;

      // 射撃エフェクトの即時反映（見た目のみ。当たり判定はホスト）
      this.localFireCd -= dt;
      if (frame.shoot && myStatus === 'alive' && this.pred) {
        while (this.localFireCd <= 0) {
          this.localFireCd += PLAYER.fireInterval;
          const a = aim + (Math.random() - 0.5) * 2 * PLAYER.spread;
          const px = this.pred.x + this.predErr.x;
          const py = this.pred.y + this.predErr.y;
          this.localBullets.push({
            id: this.localBulletId--,
            team: 'p',
            owner: localId,
            x: px + Math.cos(aim) * PLAYER.muzzle,
            y: py + Math.sin(aim) * PLAYER.muzzle,
            vx: Math.cos(a) * PLAYER.bulletSpeed,
            vy: Math.sin(a) * PLAYER.bulletSpeed,
            life: PLAYER.bulletLife,
          });
          this.renderer.triggerShot(localId);
        }
      } else if (this.localFireCd < 0) {
        this.localFireCd = 0;
      }
      view = this.buildGuestView(nowMs / 1000);
      this.updateLocalBullets(dt, view);
    }

    if (!view) {
      this.drawWaiting();
      return;
    }

    // ---- 蘇生ヒント ----
    const me = view.players.find((p) => p.id === localId);
    const reviveHint =
      !!me &&
      me.status === 'alive' &&
      view.players.some(
        (p) => p.id !== localId && p.status === 'down' && Math.hypot(p.x - me.x, p.y - me.y) <= PLAYER.reviveRange,
      );

    this.renderer.render(view, {
      localId,
      mode: this.o.mode,
      roomCode: this.o.roomCode,
      effects: this.effects,
      dt,
      mouseX: this.input.mouseX,
      mouseY: this.input.mouseY,
      skipShotDetectId: this.o.mode === 'guest' ? localId : null,
      reviveHint,
      syncMs: this.o.mode === 'guest' ? this.o.net?.snapInterval : undefined,
    });
  };

  private drawWaiting(): void {
    const ctx = this.o.canvas.getContext('2d')!;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = '#0d1017';
    ctx.fillRect(0, 0, this.o.canvas.width, this.o.canvas.height);
    ctx.fillStyle = '#aab4c8';
    ctx.font = '20px sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('ホストからの同期を待っています…', this.o.canvas.width / 2, this.o.canvas.height / 2);
  }

  private onResize = () => this.renderer.resize();
}
