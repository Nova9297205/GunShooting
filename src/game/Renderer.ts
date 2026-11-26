// ============================================================
// Canvas 描画：カメラ・マップ・キャラクター（胴体＋タレット）・敵・弾・エフェクト・HUD
// 外部画像は使わず、全てベクター描画
// ============================================================
import type { BulletSnap, EnemySnap, GameMode, PlayerSnap, ViewState } from '../types';
import {
  ENEMY,
  OBSTACLES,
  PLAYER,
  PLAYER_COLORS,
  WORLD_H,
  WORLD_W,
} from './constants';
import type { Effects } from './Effects';
import { clamp, raycast } from './physics';

interface PlayerAnim {
  recoil: number;
  recoilV: number;
  flash: number;
  flashSeed: number;
  lastShots: number;
  trailT: number;
}

export interface RenderOptions {
  localId: number;
  mode: GameMode;
  roomCode?: string;
  effects: Effects;
  dt: number;
  mouseX: number;
  mouseY: number;
  /** この ID のプレイヤーは shots カウンタからの射撃検出をしない（ゲストの自機予測用） */
  skipShotDetectId: number | null;
  reviveHint: boolean;
  /** ゲスト：スナップショット受信間隔(ms) */
  syncMs?: number;
}

export class Renderer {
  private ctx: CanvasRenderingContext2D;
  w = 0;
  h = 0;
  private dpr = 1;
  cam = { x: WORLD_W / 2, y: WORLD_H / 2 };
  private camInit = false;
  private shake = { x: 0, y: 0 };
  private anim = new Map<number, PlayerAnim>();
  private time = 0;

  constructor(private canvas: HTMLCanvasElement) {
    this.ctx = canvas.getContext('2d')!;
    this.resize();
  }

  resize(): void {
    this.dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.w = window.innerWidth;
    this.h = window.innerHeight;
    this.canvas.width = Math.floor(this.w * this.dpr);
    this.canvas.height = Math.floor(this.h * this.dpr);
    this.canvas.style.width = `${this.w}px`;
    this.canvas.style.height = `${this.h}px`;
  }

  screenToWorld(sx: number, sy: number): { x: number; y: number } {
    return { x: sx - this.w / 2 + this.cam.x, y: sy - this.h / 2 + this.cam.y };
  }

  /** 自機の射撃演出（リコイル＋マズルフラッシュ）を即時に発生させる */
  triggerShot(id: number): void {
    const a = this.getAnim(id);
    a.recoil = -7;
    a.recoilV = 0;
    a.flash = 0.06;
    a.flashSeed = Math.random();
  }

  private getAnim(id: number): PlayerAnim {
    let a = this.anim.get(id);
    if (!a) {
      a = { recoil: 0, recoilV: 0, flash: 0, flashSeed: 0, lastShots: -1, trailT: 0 };
      this.anim.set(id, a);
    }
    return a;
  }

  // ------------------------------------------------------------
  render(view: ViewState, o: RenderOptions): void {
    const { ctx } = this;
    const dt = o.dt;
    this.time += dt;

    // ---- アニメーション更新（リコイルのバネ・射撃検出・ダッシュ残像）----
    for (const p of view.players) {
      const a = this.getAnim(p.id);
      if (a.lastShots < 0) a.lastShots = p.shots;
      if (p.id !== o.skipShotDetectId && p.shots !== a.lastShots) this.triggerShot(p.id);
      a.lastShots = p.shots;
      // 減衰付きバネ（少しオーバーシュートして戻る）
      const k = 900;
      const c = 26;
      a.recoilV += (-k * a.recoil - c * a.recoilV) * dt;
      a.recoil += a.recoilV * dt;
      a.flash = Math.max(0, a.flash - dt);
      if (p.dashTime > 0 && p.status === 'alive') {
        a.trailT -= dt;
        if (a.trailT <= 0) {
          a.trailT = 0.015;
          o.effects.burst(p.x, p.y, PLAYER_COLORS[p.id], 2, 60, 0.3, 4, 'dot');
        }
      }
    }
    o.effects.update(dt);

    // ---- カメラ ----
    const me = view.players.find((p) => p.id === o.localId);
    let focus: PlayerSnap | undefined = me;
    if (!focus || focus.status === 'dead') {
      focus = view.players.find((p) => p.status === 'alive') ?? me;
    }
    if (focus) {
      // 照準方向へ少し先読み
      let tx = focus.x;
      let ty = focus.y;
      if (focus === me && me.status !== 'dead') {
        tx += clamp(o.mouseX - this.w / 2, -this.w / 2, this.w / 2) * 0.18;
        ty += clamp(o.mouseY - this.h / 2, -this.h / 2, this.h / 2) * 0.18;
      }
      if (!this.camInit) {
        this.cam.x = tx;
        this.cam.y = ty;
        this.camInit = true;
      }
      const t = 1 - Math.exp(-8 * dt);
      this.cam.x += (tx - this.cam.x) * t;
      this.cam.y += (ty - this.cam.y) * t;
    }
    this.shake = o.effects.shakeOffset();

    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.fillStyle = '#0d1017';
    ctx.fillRect(0, 0, this.w, this.h);

    ctx.save();
    ctx.translate(
      Math.round(this.w / 2 - this.cam.x + this.shake.x),
      Math.round(this.h / 2 - this.cam.y + this.shake.y),
    );
    this.drawFloor();
    this.drawObstacleShadows();
    for (const p of view.players) if (p.status !== 'dead') this.drawLaser(p);
    for (const e of view.enemies) this.drawEnemyShadow(e);
    for (const p of view.players) this.drawPlayer(p, p.id === o.localId);
    for (const e of view.enemies) this.drawEnemy(e);
    this.drawBullets(view.bullets);
    this.drawObstacles();
    this.drawParticles(o.effects);
    for (const p of view.players) this.drawPlayerOverlay(p, p.id === o.localId);
    for (const e of view.enemies) this.drawEnemyOverlay(e);
    this.drawPopups(o.effects);
    ctx.restore();

    this.drawHUD(view, o, me);
  }

  // ---------------- ワールド ----------------

  private drawFloor(): void {
    const { ctx } = this;
    const x0 = this.cam.x - this.w / 2 - 40;
    const y0 = this.cam.y - this.h / 2 - 40;
    const x1 = x0 + this.w + 80;
    const y1 = y0 + this.h + 80;
    ctx.fillStyle = '#151a24';
    ctx.fillRect(0, 0, WORLD_W, WORLD_H);

    const g = 80;
    ctx.strokeStyle = 'rgba(120,140,180,0.07)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let x = Math.max(0, Math.floor(x0 / g) * g); x <= Math.min(WORLD_W, x1); x += g) {
      ctx.moveTo(x + 0.5, Math.max(0, y0));
      ctx.lineTo(x + 0.5, Math.min(WORLD_H, y1));
    }
    for (let y = Math.max(0, Math.floor(y0 / g) * g); y <= Math.min(WORLD_H, y1); y += g) {
      ctx.moveTo(Math.max(0, x0), y + 0.5);
      ctx.lineTo(Math.min(WORLD_W, x1), y + 0.5);
    }
    ctx.stroke();

    // 中央のサークル装飾
    ctx.strokeStyle = 'rgba(120,160,255,0.08)';
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.arc(WORLD_W / 2, WORLD_H / 2, 180, 0, Math.PI * 2);
    ctx.stroke();

    // ワールド境界
    ctx.strokeStyle = 'rgba(255,80,100,0.5)';
    ctx.lineWidth = 4;
    ctx.strokeRect(-2, -2, WORLD_W + 4, WORLD_H + 4);
  }

  private drawObstacleShadows(): void {
    const { ctx } = this;
    ctx.fillStyle = 'rgba(0,0,0,0.35)';
    for (const o of OBSTACLES) ctx.fillRect(o.x + 8, o.y + 10, o.w, o.h);
  }

  private drawObstacles(): void {
    const { ctx } = this;
    for (const o of OBSTACLES) {
      ctx.fillStyle = '#2b3345';
      ctx.fillRect(o.x, o.y, o.w, o.h);
      ctx.fillStyle = '#39445c';
      ctx.fillRect(o.x, o.y, o.w, 5);
      ctx.strokeStyle = '#4a5672';
      ctx.lineWidth = 2;
      ctx.strokeRect(o.x + 1, o.y + 1, o.w - 2, o.h - 2);
      // ハッチング装飾
      ctx.save();
      ctx.beginPath();
      ctx.rect(o.x + 4, o.y + 8, o.w - 8, o.h - 12);
      ctx.clip();
      ctx.strokeStyle = 'rgba(255,255,255,0.04)';
      ctx.lineWidth = 6;
      ctx.beginPath();
      for (let d = -o.h; d < o.w; d += 18) {
        ctx.moveTo(o.x + d, o.y + o.h);
        ctx.lineTo(o.x + d + o.h, o.y);
      }
      ctx.stroke();
      ctx.restore();
    }
  }

  // ---------------- プレイヤー ----------------

  private drawLaser(p: PlayerSnap): void {
    if (p.status !== 'alive') return;
    const { ctx } = this;
    const color = PLAYER_COLORS[p.id] ?? '#fff';
    const sx = p.x + Math.cos(p.aim) * PLAYER.muzzle;
    const sy = p.y + Math.sin(p.aim) * PLAYER.muzzle;
    const len = raycast(sx, sy, p.aim, 650);
    const ex = sx + Math.cos(p.aim) * len;
    const ey = sy + Math.sin(p.aim) * len;
    const grad = ctx.createLinearGradient(sx, sy, ex, ey);
    grad.addColorStop(0, hexA(color, 0.35));
    grad.addColorStop(1, hexA(color, 0.03));
    ctx.strokeStyle = grad;
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(sx, sy);
    ctx.lineTo(ex, ey);
    ctx.stroke();
    if (len < 650) {
      ctx.fillStyle = hexA(color, 0.5);
      ctx.beginPath();
      ctx.arc(ex, ey, 2.5, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  private drawPlayer(p: PlayerSnap, isLocal: boolean): void {
    const { ctx } = this;
    const base = PLAYER_COLORS[p.id] ?? '#ffffff';
    const color = p.status === 'alive' ? base : '#6b7280';
    const a = this.getAnim(p.id);

    if (p.status === 'dead') {
      ctx.save();
      ctx.translate(p.x, p.y);
      ctx.globalAlpha = 0.45;
      ctx.strokeStyle = base;
      ctx.lineWidth = 4;
      ctx.beginPath();
      ctx.moveTo(-10, -10);
      ctx.lineTo(10, 10);
      ctx.moveTo(10, -10);
      ctx.lineTo(-10, 10);
      ctx.stroke();
      ctx.restore();
      return;
    }

    ctx.save();
    ctx.translate(p.x, p.y);

    // 影
    ctx.fillStyle = 'rgba(0,0,0,0.35)';
    ctx.beginPath();
    ctx.ellipse(4, 7, 20, 16, 0, 0, Math.PI * 2);
    ctx.fill();

    // 自機の足元リング
    if (isLocal) {
      ctx.strokeStyle = hexA(base, 0.35);
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(0, 0, 24, 0, Math.PI * 2);
      ctx.stroke();
    }

    // ---- 胴体（移動方向へ回転）----
    ctx.save();
    ctx.rotate(p.bodyAngle);
    // キャタピラ
    ctx.fillStyle = '#1c2230';
    roundRect(ctx, -17, -16, 34, 8, 3);
    ctx.fill();
    roundRect(ctx, -17, 8, 34, 8, 3);
    ctx.fill();
    // 履帯のスクロール模様
    ctx.strokeStyle = 'rgba(255,255,255,0.12)';
    ctx.lineWidth = 1.5;
    const scroll = ((p.x + p.y) * 0.3) % 6;
    ctx.beginPath();
    for (let i = -17 + scroll; i < 17; i += 6) {
      ctx.moveTo(i, -15);
      ctx.lineTo(i, -9);
      ctx.moveTo(i, 9);
      ctx.lineTo(i, 15);
    }
    ctx.stroke();
    // 車体
    ctx.fillStyle = shade(color, -0.25);
    roundRect(ctx, -14, -11, 28, 22, 5);
    ctx.fill();
    ctx.fillStyle = color;
    roundRect(ctx, -12, -9, 24, 18, 4);
    ctx.fill();
    // 前方インジケータ
    ctx.fillStyle = shade(color, 0.35);
    ctx.beginPath();
    ctx.moveTo(13, 0);
    ctx.lineTo(7, -5);
    ctx.lineTo(7, 5);
    ctx.closePath();
    ctx.fill();
    ctx.restore();

    // ---- タレット（照準方向へ独立回転＋リコイル）----
    ctx.save();
    ctx.rotate(p.aim);
    const rc = a.recoil;
    ctx.fillStyle = '#2a3140';
    roundRect(ctx, 2 + rc, -4.5, 26, 9, 2);
    ctx.fill();
    ctx.fillStyle = shade(color, 0.15);
    roundRect(ctx, 4 + rc, -3, 22, 6, 2);
    ctx.fill();
    ctx.fillStyle = '#20263a';
    ctx.fillRect(24 + rc, -4.5, 4, 9);

    // マズルフラッシュ
    if (a.flash > 0) {
      const s = 0.7 + a.flashSeed * 0.6;
      ctx.save();
      ctx.translate(30 + rc, 0);
      ctx.globalCompositeOperation = 'lighter';
      ctx.fillStyle = 'rgba(255,230,140,0.9)';
      ctx.beginPath();
      ctx.moveTo(0, -6 * s);
      ctx.lineTo(18 * s, 0);
      ctx.lineTo(0, 6 * s);
      ctx.lineTo(5 * s, 0);
      ctx.closePath();
      ctx.fill();
      ctx.fillStyle = 'rgba(255,255,255,0.95)';
      ctx.beginPath();
      ctx.arc(2, 0, 4 * s, 0, Math.PI * 2);
      ctx.fill();
      const g = ctx.createRadialGradient(4, 0, 0, 4, 0, 22 * s);
      g.addColorStop(0, hexA(base, 0.6));
      g.addColorStop(1, hexA(base, 0));
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.arc(4, 0, 22 * s, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    }
    // 砲塔ドーム
    ctx.fillStyle = shade(color, -0.1);
    ctx.beginPath();
    ctx.arc(0, 0, 9.5, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = shade(color, 0.3);
    ctx.beginPath();
    ctx.arc(-2, -2, 4.5, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();

    ctx.restore();
  }

  private drawPlayerOverlay(p: PlayerSnap, isLocal: boolean): void {
    const { ctx } = this;
    const color = PLAYER_COLORS[p.id] ?? '#fff';
    const y = p.y - 36;

    // 名前
    ctx.font = 'bold 13px "Segoe UI", sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.lineWidth = 3;
    ctx.strokeStyle = 'rgba(0,0,0,0.75)';
    const label = isLocal ? `${p.name} (YOU)` : p.name;
    ctx.strokeText(label, p.x, y - 12);
    ctx.fillStyle = color;
    ctx.fillText(label, p.x, y - 12);

    if (p.status === 'alive') {
      // HPバー
      const w = 36;
      ctx.fillStyle = 'rgba(0,0,0,0.6)';
      ctx.fillRect(p.x - w / 2 - 1, y - 1, w + 2, 6);
      const r = clamp(p.hp / p.maxHp, 0, 1);
      ctx.fillStyle = r > 0.5 ? '#5be37d' : r > 0.25 ? '#ffd84d' : '#ff5c5c';
      ctx.fillRect(p.x - w / 2, y, w * r, 4);
    } else if (p.status === 'down') {
      // ダウン：カウントダウンゲージ
      const r = clamp(p.downTimer / PLAYER.downTime, 0, 1);
      ctx.lineWidth = 4;
      ctx.strokeStyle = 'rgba(0,0,0,0.6)';
      ctx.beginPath();
      ctx.arc(p.x, y - 2, 11, 0, Math.PI * 2);
      ctx.stroke();
      ctx.strokeStyle = r > 0.3 ? '#ff9a3d' : '#ff4d5e';
      ctx.beginPath();
      ctx.arc(p.x, y - 2, 11, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * r);
      ctx.stroke();
      ctx.font = 'bold 10px sans-serif';
      ctx.fillStyle = '#fff';
      ctx.fillText(String(Math.ceil(p.downTimer)), p.x, y - 2);
      const blink = Math.sin(this.time * 8) > 0;
      ctx.font = 'bold 11px sans-serif';
      ctx.fillStyle = blink ? '#ff5c5c' : '#ffb3b3';
      ctx.fillText('DOWN', p.x, p.y + 30);

      // 蘇生プログレスリング
      if (p.reviveProgress > 0) {
        const rp = clamp(p.reviveProgress / PLAYER.reviveTime, 0, 1);
        ctx.lineWidth = 5;
        ctx.strokeStyle = 'rgba(125,255,176,0.25)';
        ctx.beginPath();
        ctx.arc(p.x, p.y, 28, 0, Math.PI * 2);
        ctx.stroke();
        ctx.strokeStyle = '#7dffb0';
        ctx.beginPath();
        ctx.arc(p.x, p.y, 28, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * rp);
        ctx.stroke();
      } else {
        // 蘇生可能範囲
        ctx.setLineDash([4, 6]);
        ctx.lineWidth = 1.5;
        ctx.strokeStyle = 'rgba(125,255,176,0.35)';
        ctx.beginPath();
        ctx.arc(p.x, p.y, PLAYER.reviveRange, this.time, this.time + Math.PI * 2);
        ctx.stroke();
        ctx.setLineDash([]);
      }
    } else {
      ctx.font = 'bold 11px sans-serif';
      ctx.fillStyle = '#9aa3b5';
      ctx.fillText('DEAD - 次ウェーブで復帰', p.x, y);
    }
  }

  // ---------------- 敵 ----------------

  private drawEnemyShadow(e: EnemySnap): void {
    const { ctx } = this;
    const r = ENEMY[e.type].radius;
    ctx.fillStyle = 'rgba(0,0,0,0.3)';
    ctx.beginPath();
    ctx.ellipse(e.x + 4, e.y + 7, r, r * 0.8, 0, 0, Math.PI * 2);
    ctx.fill();
  }

  private drawEnemy(e: EnemySnap): void {
    const { ctx } = this;
    const st = ENEMY[e.type];
    const r = st.radius;
    const flash = e.flash > 0;
    const fill = flash ? '#ffffff' : st.color;
    ctx.save();
    ctx.translate(e.x, e.y);
    ctx.shadowColor = st.color;
    ctx.shadowBlur = 14;

    if (e.type === 'chaser') {
      ctx.rotate(e.angle);
      ctx.fillStyle = fill;
      ctx.beginPath();
      ctx.moveTo(r + 4, 0);
      ctx.lineTo(-r * 0.8, -r * 0.9);
      ctx.lineTo(-r * 0.4, 0);
      ctx.lineTo(-r * 0.8, r * 0.9);
      ctx.closePath();
      ctx.fill();
      ctx.shadowBlur = 0;
      ctx.fillStyle = flash ? '#fff' : '#ffd0d5';
      ctx.beginPath();
      ctx.arc(r * 0.25, 0, 3, 0, Math.PI * 2);
      ctx.fill();
    } else if (e.type === 'shooter') {
      ctx.rotate(e.angle);
      ctx.fillStyle = fill;
      ctx.beginPath();
      ctx.moveTo(r + 3, 0);
      ctx.lineTo(0, -r);
      ctx.lineTo(-r - 3, 0);
      ctx.lineTo(0, r);
      ctx.closePath();
      ctx.fill();
      ctx.shadowBlur = 0;
      ctx.strokeStyle = flash ? '#fff' : '#e3c8ff';
      ctx.lineWidth = 2;
      ctx.stroke();
      const pulse = 3.5 + Math.sin(this.time * 10 + e.id) * 1.5;
      ctx.fillStyle = '#ff5a7a';
      ctx.beginPath();
      ctx.arc(0, 0, pulse, 0, Math.PI * 2);
      ctx.fill();
    } else {
      ctx.rotate(e.angle);
      ctx.fillStyle = fill;
      hexPath(ctx, r);
      ctx.fill();
      ctx.shadowBlur = 0;
      ctx.strokeStyle = flash ? '#fff' : '#ffd2a1';
      ctx.lineWidth = 3;
      ctx.stroke();
      ctx.rotate(-e.angle * 2);
      ctx.fillStyle = flash ? '#fff' : '#b8581b';
      hexPath(ctx, r * 0.55);
      ctx.fill();
      ctx.fillStyle = '#ffe1b8';
      ctx.beginPath();
      ctx.arc(0, 0, 4, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();
  }

  private drawEnemyOverlay(e: EnemySnap): void {
    if (e.hp >= e.maxHp && e.type !== 'tank') return;
    const { ctx } = this;
    const r = ENEMY[e.type].radius;
    const w = e.type === 'tank' ? 56 : 28;
    const y = e.y - r - 12;
    ctx.fillStyle = 'rgba(0,0,0,0.6)';
    ctx.fillRect(e.x - w / 2 - 1, y - 1, w + 2, 5);
    ctx.fillStyle = ENEMY[e.type].color;
    ctx.fillRect(e.x - w / 2, y, w * clamp(e.hp / e.maxHp, 0, 1), 3);
  }

  // ---------------- 弾 ----------------

  private drawBullets(bullets: BulletSnap[]): void {
    const { ctx } = this;
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    ctx.lineCap = 'round';
    for (const b of bullets) {
      if (b.team === 'p') {
        const color = PLAYER_COLORS[b.owner] ?? '#fff';
        const tx = b.x - b.vx * 0.022;
        const ty = b.y - b.vy * 0.022;
        ctx.strokeStyle = hexA(color, 0.55);
        ctx.lineWidth = 6;
        ctx.beginPath();
        ctx.moveTo(tx, ty);
        ctx.lineTo(b.x, b.y);
        ctx.stroke();
        ctx.strokeStyle = '#ffffff';
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(b.x - b.vx * 0.012, b.y - b.vy * 0.012);
        ctx.lineTo(b.x, b.y);
        ctx.stroke();
      } else {
        const g = ctx.createRadialGradient(b.x, b.y, 0, b.x, b.y, 14);
        g.addColorStop(0, 'rgba(255,90,110,0.9)');
        g.addColorStop(1, 'rgba(255,40,60,0)');
        ctx.fillStyle = g;
        ctx.beginPath();
        ctx.arc(b.x, b.y, 14, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = '#ffd6dc';
        ctx.beginPath();
        ctx.arc(b.x, b.y, 4, 0, Math.PI * 2);
        ctx.fill();
      }
    }
    ctx.restore();
  }

  // ---------------- エフェクト ----------------

  private drawParticles(fx: Effects): void {
    const { ctx } = this;
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    ctx.lineCap = 'round';
    for (const p of fx.particles) {
      const t = p.life / p.maxLife;
      if (p.kind === 'ring') {
        const r = p.size * (1 - t * t);
        ctx.strokeStyle = hexA(p.color, t * 0.8);
        ctx.lineWidth = 2 + 6 * t;
        ctx.beginPath();
        ctx.arc(p.x, p.y, Math.max(1, r), 0, Math.PI * 2);
        ctx.stroke();
      } else if (p.kind === 'spark') {
        ctx.strokeStyle = hexA(p.color, t);
        ctx.lineWidth = p.size * t + 0.5;
        ctx.beginPath();
        ctx.moveTo(p.x, p.y);
        ctx.lineTo(p.x - p.vx * 0.035, p.y - p.vy * 0.035);
        ctx.stroke();
      } else {
        ctx.fillStyle = hexA(p.color, t * 0.7);
        ctx.beginPath();
        ctx.arc(p.x, p.y, p.size * (0.4 + 0.6 * t), 0, Math.PI * 2);
        ctx.fill();
      }
    }
    ctx.restore();
  }

  private drawPopups(fx: Effects): void {
    const { ctx } = this;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    for (const p of fx.popups) {
      const t = p.life / p.maxLife;
      const scale = t > 0.8 ? 1 + (t - 0.8) * 2.5 : 1;
      ctx.globalAlpha = Math.min(1, t * 2);
      ctx.font = `900 ${Math.round(p.size * scale)}px "Segoe UI", sans-serif`;
      ctx.lineWidth = 3;
      ctx.strokeStyle = 'rgba(0,0,0,0.8)';
      ctx.strokeText(p.text, p.x, p.y);
      ctx.fillStyle = p.color;
      ctx.fillText(p.text, p.x, p.y);
    }
    ctx.globalAlpha = 1;
  }

  // ---------------- HUD ----------------

  private drawHUD(view: ViewState, o: RenderOptions, me: PlayerSnap | undefined): void {
    const { ctx, w, h } = this;
    const fx = o.effects;

    // 被弾時の赤いビネット
    if (fx.hurt > 0) {
      const g = ctx.createRadialGradient(w / 2, h / 2, Math.min(w, h) * 0.35, w / 2, h / 2, Math.max(w, h) * 0.7);
      g.addColorStop(0, 'rgba(255,0,40,0)');
      g.addColorStop(1, `rgba(255,0,40,${0.35 * fx.hurt})`);
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, w, h);
    }
    if (me && me.status !== 'alive') {
      ctx.fillStyle = 'rgba(40,0,10,0.25)';
      ctx.fillRect(0, 0, w, h);
    }

    // ---- 左上：ウェーブ情報 ----
    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';
    panel(ctx, 14, 14, 200, 62);
    ctx.fillStyle = '#ffffff';
    ctx.font = '900 24px "Segoe UI", sans-serif';
    ctx.fillText(`WAVE ${view.wave}`, 26, 20);
    ctx.font = '13px "Segoe UI", sans-serif';
    ctx.fillStyle = '#aab4c8';
    const sub =
      view.phase === 'intermission'
        ? `次のウェーブまで ${Math.ceil(view.phaseTimer)}s`
        : `残りの敵: ${view.enemiesLeft}`;
    ctx.fillText(sub, 26, 50);

    // モード表示
    ctx.font = '12px "Segoe UI", sans-serif';
    ctx.fillStyle = '#6f7a90';
    const modeLabel =
      o.mode === 'solo' ? 'SOLO' : o.mode === 'host' ? `HOST  ROOM: ${o.roomCode ?? ''}` : `GUEST  ROOM: ${o.roomCode ?? ''}`;
    ctx.fillText(modeLabel + (o.syncMs ? `  SYNC: ${Math.round(o.syncMs)}ms` : ''), 16, 82);

    // ---- 右上：チーム一覧 ----
    const pw = 210;
    const rowH = 38;
    const px = w - pw - 14;
    panel(ctx, px, 14, pw, 12 + rowH * view.players.length);
    view.players.forEach((p, i) => {
      const y = 22 + i * rowH;
      const color = PLAYER_COLORS[p.id];
      ctx.fillStyle = color;
      ctx.beginPath();
      ctx.arc(px + 16, y + 10, 6, 0, Math.PI * 2);
      ctx.fill();
      ctx.font = 'bold 13px "Segoe UI", sans-serif';
      ctx.fillStyle = '#fff';
      ctx.textAlign = 'left';
      ctx.fillText(p.name + (p.id === o.localId ? ' (YOU)' : ''), px + 28, y + 2);
      ctx.textAlign = 'right';
      ctx.fillStyle = '#aab4c8';
      ctx.font = '12px "Segoe UI", sans-serif';
      ctx.fillText(`KILL ${p.kills}`, px + pw - 12, y + 3);
      ctx.textAlign = 'left';
      const bw = pw - 40;
      ctx.fillStyle = 'rgba(255,255,255,0.1)';
      ctx.fillRect(px + 28, y + 20, bw, 6);
      if (p.status === 'alive') {
        ctx.fillStyle = color;
        ctx.fillRect(px + 28, y + 20, bw * clamp(p.hp / p.maxHp, 0, 1), 6);
      } else if (p.status === 'down') {
        ctx.fillStyle = '#ff4d5e';
        ctx.fillRect(px + 28, y + 20, bw * clamp(p.downTimer / PLAYER.downTime, 0, 1), 6);
        ctx.font = 'bold 10px sans-serif';
        ctx.fillStyle = '#ff9aa5';
        ctx.textAlign = 'right';
        ctx.fillText(`DOWN ${Math.ceil(p.downTimer)}s`, px + pw - 12, y + 19);
        ctx.textAlign = 'left';
      } else {
        ctx.font = 'bold 10px sans-serif';
        ctx.fillStyle = '#9aa3b5';
        ctx.fillText('DEAD', px + 28, y + 18);
      }
    });

    // ---- 下中央：自分のHP・ダッシュ ----
    if (me) {
      const bw = Math.min(360, w - 40);
      const bx = w / 2 - bw / 2;
      const by = h - 58;
      panel(ctx, bx - 12, by - 12, bw + 24, 52);
      ctx.fillStyle = 'rgba(255,255,255,0.1)';
      ctx.fillRect(bx, by, bw, 14);
      const r = clamp(me.hp / me.maxHp, 0, 1);
      ctx.fillStyle = me.status === 'alive' ? (r > 0.5 ? '#5be37d' : r > 0.25 ? '#ffd84d' : '#ff5c5c') : '#ff4d5e';
      ctx.fillRect(bx, by, bw * r, 14);
      ctx.font = 'bold 11px "Segoe UI", sans-serif';
      ctx.fillStyle = '#fff';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(`HP ${Math.max(0, Math.ceil(me.hp))} / ${me.maxHp}`, w / 2, by + 7);
      // ダッシュ
      const dr = 1 - clamp(me.dashCd / PLAYER.dashCooldown, 0, 1);
      ctx.fillStyle = 'rgba(255,255,255,0.1)';
      ctx.fillRect(bx, by + 20, bw, 6);
      ctx.fillStyle = dr >= 1 ? '#4da3ff' : '#2d5a8a';
      ctx.fillRect(bx, by + 20, bw * dr, 6);
      ctx.font = '10px "Segoe UI", sans-serif';
      ctx.fillStyle = '#aab4c8';
      ctx.textAlign = 'left';
      ctx.fillText(dr >= 1 ? 'DASH [Shift] READY' : 'DASH 充電中', bx, by + 34);
    }

    // ---- 中央メッセージ ----
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    if (me && me.status === 'down') {
      ctx.font = '900 28px "Segoe UI", sans-serif';
      ctx.fillStyle = '#ff5c5c';
      ctx.fillText('ダウン中！', w / 2, h * 0.28);
      ctx.font = '15px "Segoe UI", sans-serif';
      ctx.fillStyle = '#ffd0d5';
      ctx.fillText(`味方の蘇生を待て（残り ${Math.ceil(me.downTimer)} 秒）`, w / 2, h * 0.28 + 30);
    } else if (me && me.status === 'dead') {
      ctx.font = '900 26px "Segoe UI", sans-serif';
      ctx.fillStyle = '#9aa3b5';
      ctx.fillText('戦闘不能', w / 2, h * 0.28);
      ctx.font = '15px "Segoe UI", sans-serif';
      ctx.fillText('味方が次のウェーブまで生き残れば復帰します', w / 2, h * 0.28 + 30);
    } else if (o.reviveHint) {
      const pulse = 0.75 + Math.sin(this.time * 6) * 0.25;
      ctx.font = 'bold 18px "Segoe UI", sans-serif';
      ctx.fillStyle = `rgba(125,255,176,${pulse})`;
      ctx.fillText('[E] 長押しで蘇生', w / 2, h * 0.62);
    }

    if (view.phase === 'intermission' && !fx.banner) {
      ctx.font = '900 40px "Segoe UI", sans-serif';
      ctx.lineWidth = 6;
      ctx.strokeStyle = 'rgba(0,0,0,0.6)';
      ctx.strokeText(`WAVE ${view.wave}`, w / 2, h * 0.2);
      ctx.fillStyle = '#fff';
      ctx.fillText(`WAVE ${view.wave}`, w / 2, h * 0.2);
      ctx.font = 'bold 18px "Segoe UI", sans-serif';
      ctx.fillStyle = '#ffd84d';
      ctx.fillText(`開始まで ${Math.ceil(view.phaseTimer)}`, w / 2, h * 0.2 + 38);
    }

    if (fx.banner) {
      const b = fx.banner;
      const t = b.life / b.maxLife;
      const appear = clamp((1 - t) * 8, 0, 1);
      const fade = clamp(t * 4, 0, 1);
      ctx.globalAlpha = Math.min(appear, fade);
      const scale = 1 + (1 - appear) * 0.5;
      ctx.save();
      ctx.translate(w / 2, h * 0.2);
      ctx.scale(scale, scale);
      ctx.font = '900 46px "Segoe UI", sans-serif';
      ctx.lineWidth = 7;
      ctx.strokeStyle = 'rgba(0,0,0,0.6)';
      ctx.strokeText(b.text, 0, 0);
      ctx.fillStyle = b.color;
      ctx.fillText(b.text, 0, 0);
      ctx.font = 'bold 16px "Segoe UI", sans-serif';
      ctx.fillStyle = '#dfe6f3';
      ctx.fillText(b.sub, 0, 40);
      ctx.restore();
      ctx.globalAlpha = 1;
    }

    if (view.phase === 'gameover') {
      ctx.fillStyle = 'rgba(0,0,0,0.45)';
      ctx.fillRect(0, 0, w, h);
      ctx.font = '900 54px "Segoe UI", sans-serif';
      ctx.fillStyle = '#ff4d5e';
      ctx.fillText('GAME OVER', w / 2, h / 2);
    }

    this.drawMinimap(view, o.localId);

    // ---- クロスヘア ----
    const me2 = me && me.status === 'alive';
    const cx = o.mouseX;
    const cy = o.mouseY;
    ctx.strokeStyle = me2 ? (PLAYER_COLORS[o.localId] ?? '#fff') : '#777';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(cx, cy, 9, 0, Math.PI * 2);
    ctx.moveTo(cx - 15, cy);
    ctx.lineTo(cx - 5, cy);
    ctx.moveTo(cx + 5, cy);
    ctx.lineTo(cx + 15, cy);
    ctx.moveTo(cx, cy - 15);
    ctx.lineTo(cx, cy - 5);
    ctx.moveTo(cx, cy + 5);
    ctx.lineTo(cx, cy + 15);
    ctx.stroke();
    ctx.fillStyle = '#fff';
    ctx.fillRect(cx - 1, cy - 1, 2, 2);
  }

  private drawMinimap(view: ViewState, localId: number): void {
    const { ctx } = this;
    const mw = 180;
    const mh = (mw * WORLD_H) / WORLD_W;
    const mx = this.w - mw - 14;
    const my = this.h - mh - 14;
    const s = mw / WORLD_W;
    panel(ctx, mx - 4, my - 4, mw + 8, mh + 8);
    ctx.fillStyle = '#4a5672';
    for (const o of OBSTACLES) ctx.fillRect(mx + o.x * s, my + o.y * s, Math.max(1, o.w * s), Math.max(1, o.h * s));
    for (const e of view.enemies) {
      ctx.fillStyle = ENEMY[e.type].color;
      const r = e.type === 'tank' ? 3 : 2;
      ctx.fillRect(mx + e.x * s - r / 2, my + e.y * s - r / 2, r, r);
    }
    for (const p of view.players) {
      if (p.status === 'dead') continue;
      ctx.fillStyle = PLAYER_COLORS[p.id];
      ctx.beginPath();
      ctx.arc(mx + p.x * s, my + p.y * s, p.id === localId ? 4 : 3, 0, Math.PI * 2);
      ctx.fill();
      if (p.status === 'down') {
        ctx.strokeStyle = '#ff4d5e';
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.arc(mx + p.x * s, my + p.y * s, 6 + Math.sin(this.time * 8) * 1.5, 0, Math.PI * 2);
        ctx.stroke();
      }
    }
    // 視界枠
    ctx.strokeStyle = 'rgba(255,255,255,0.3)';
    ctx.lineWidth = 1;
    ctx.strokeRect(
      mx + (this.cam.x - this.w / 2) * s,
      my + (this.cam.y - this.h / 2) * s,
      this.w * s,
      this.h * s,
    );
  }
}

// ---------------- 描画ヘルパー ----------------

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

function hexPath(ctx: CanvasRenderingContext2D, r: number): void {
  ctx.beginPath();
  for (let i = 0; i < 6; i++) {
    const a = (Math.PI / 3) * i;
    const x = Math.cos(a) * r;
    const y = Math.sin(a) * r;
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  }
  ctx.closePath();
}

function panel(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number): void {
  ctx.fillStyle = 'rgba(10,14,22,0.72)';
  roundRect(ctx, x, y, w, h, 8);
  ctx.fill();
  ctx.strokeStyle = 'rgba(255,255,255,0.08)';
  ctx.lineWidth = 1;
  ctx.stroke();
}

function parseHex(hex: string): [number, number, number] {
  const h = hex.replace('#', '');
  const n = parseInt(h.length === 3 ? h.split('').map((c) => c + c).join('') : h, 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

const hexACache = new Map<string, string>();
function hexA(hex: string, a: number): string {
  const key = hex + (Math.round(a * 100) / 100);
  let v = hexACache.get(key);
  if (!v) {
    const [r, g, b] = parseHex(hex);
    v = `rgba(${r},${g},${b},${Math.round(a * 100) / 100})`;
    if (hexACache.size > 4000) hexACache.clear();
    hexACache.set(key, v);
  }
  return v;
}

/** 明度調整（amt: -1..1） */
function shade(hex: string, amt: number): string {
  const [r, g, b] = parseHex(hex);
  const f = (c: number) => Math.round(amt >= 0 ? c + (255 - c) * amt : c * (1 + amt));
  return `rgb(${f(r)},${f(g)},${f(b)})`;
}
