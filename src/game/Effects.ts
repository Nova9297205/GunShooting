// ============================================================
// クライアント側の演出（パーティクル・ダメージ数値・画面揺れ・バナー）
// ============================================================
import type { GameEvent } from '../types';
import { PLAYER_COLORS } from './constants';

export interface Particle {
  x: number;
  y: number;
  vx: number;
  vy: number;
  life: number;
  maxLife: number;
  size: number;
  color: string;
  drag: number;
  /** 'spark' は線、'dot' は円、'ring' は広がる輪 */
  kind: 'spark' | 'dot' | 'ring';
}

export interface Popup {
  x: number;
  y: number;
  text: string;
  color: string;
  life: number;
  maxLife: number;
  vy: number;
  size: number;
}

export interface Banner {
  text: string;
  sub: string;
  life: number;
  maxLife: number;
  color: string;
}

const MAX_PARTICLES = 900;

export class Effects {
  particles: Particle[] = [];
  popups: Popup[] = [];
  banner: Banner | null = null;
  trauma = 0;
  hurt = 0;

  burst(
    x: number,
    y: number,
    color: string,
    count: number,
    speed: number,
    life: number,
    size: number,
    kind: Particle['kind'] = 'spark',
    dirAngle?: number,
    spreadAngle = Math.PI * 2,
  ): void {
    for (let i = 0; i < count; i++) {
      const a =
        dirAngle === undefined
          ? Math.random() * Math.PI * 2
          : dirAngle + (Math.random() - 0.5) * spreadAngle;
      const s = speed * (0.3 + Math.random() * 0.7);
      const l = life * (0.6 + Math.random() * 0.4);
      this.particles.push({
        x,
        y,
        vx: Math.cos(a) * s,
        vy: Math.sin(a) * s,
        life: l,
        maxLife: l,
        size: size * (0.6 + Math.random() * 0.6),
        color,
        drag: 4,
        kind,
      });
    }
    if (this.particles.length > MAX_PARTICLES) {
      this.particles.splice(0, this.particles.length - MAX_PARTICLES);
    }
  }

  ring(x: number, y: number, color: string, radius: number, life: number): void {
    this.particles.push({ x, y, vx: 0, vy: 0, life, maxLife: life, size: radius, color, drag: 0, kind: 'ring' });
  }

  popup(x: number, y: number, text: string, color: string, size = 16): void {
    this.popups.push({
      x: x + (Math.random() - 0.5) * 16,
      y,
      text,
      color,
      life: 0.8,
      maxLife: 0.8,
      vy: -70,
      size,
    });
    if (this.popups.length > 120) this.popups.shift();
  }

  shake(amount: number): void {
    this.trauma = Math.min(1, this.trauma + amount);
  }

  showBanner(text: string, sub: string, color: string, life = 2.2): void {
    this.banner = { text, sub, life, maxLife: life, color };
  }

  shakeOffset(): { x: number; y: number } {
    const s = this.trauma * this.trauma * 14;
    return { x: (Math.random() * 2 - 1) * s, y: (Math.random() * 2 - 1) * s };
  }

  update(dt: number): void {
    this.trauma = Math.max(0, this.trauma - dt * 1.8);
    this.hurt = Math.max(0, this.hurt - dt * 2.5);
    for (const p of this.particles) {
      const d = Math.exp(-p.drag * dt);
      p.vx *= d;
      p.vy *= d;
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      p.life -= dt;
    }
    this.particles = this.particles.filter((p) => p.life > 0);
    for (const p of this.popups) {
      p.y += p.vy * dt;
      p.vy *= Math.exp(-3 * dt);
      p.life -= dt;
    }
    this.popups = this.popups.filter((p) => p.life > 0);
    if (this.banner) {
      this.banner.life -= dt;
      if (this.banner.life <= 0) this.banner = null;
    }
  }

  /** ホストから届いた（またはローカルで発生した）イベントを演出に変換 */
  handleEvent(ev: GameEvent, localId: number): void {
    switch (ev.k) {
      case 'hit':
        this.burst(ev.x, ev.y, ev.c, 6, 260, 0.35, 2.5);
        this.burst(ev.x, ev.y, '#ffffff', 3, 200, 0.2, 2);
        break;
      case 'wall':
        this.burst(ev.x, ev.y, '#c9d3e6', 5, 200, 0.25, 2);
        break;
      case 'dmg':
        this.popup(ev.x, ev.y, String(ev.v), ev.p ? '#ff5c5c' : '#ffffff', ev.p ? 18 : 15);
        break;
      case 'kill':
        this.burst(ev.x, ev.y, ev.c, 18 + ev.r, 420, 0.6, 3.5);
        this.burst(ev.x, ev.y, '#ffffff', 6, 300, 0.3, 2.5);
        this.burst(ev.x, ev.y, ev.c, 8, 120, 0.9, 5, 'dot');
        this.ring(ev.x, ev.y, ev.c, ev.r * 2.2, 0.35);
        this.shake(0.12);
        break;
      case 'boom':
        this.burst(ev.x, ev.y, '#ffb347', 60, 700, 0.8, 4);
        this.burst(ev.x, ev.y, '#fff3c4', 20, 500, 0.5, 3);
        this.burst(ev.x, ev.y, '#ff6a3d', 24, 200, 1.1, 8, 'dot');
        this.ring(ev.x, ev.y, '#ffcc66', ev.r, 0.45);
        this.shake(0.6);
        break;
      case 'phit':
        if (ev.id === localId) {
          this.shake(0.35);
          this.hurt = 1;
        }
        break;
      case 'down':
        this.burst(ev.x, ev.y, PLAYER_COLORS[ev.id] ?? '#fff', 26, 300, 0.7, 3);
        this.popup(ev.x, ev.y - 30, 'DOWN!', '#ff5c5c', 22);
        if (ev.id === localId) this.shake(0.5);
        break;
      case 'revive':
        this.burst(ev.x, ev.y, '#7dffb0', 30, 260, 0.8, 3);
        this.ring(ev.x, ev.y, '#7dffb0', 60, 0.5);
        this.popup(ev.x, ev.y - 30, 'REVIVED!', '#7dffb0', 20);
        break;
      case 'dead':
        break;
      case 'wave':
        this.showBanner(`WAVE ${ev.n}`, '敵が出現！', '#ffffff', 2);
        break;
      case 'clear':
        this.showBanner(`WAVE ${ev.n} CLEAR!`, `HP +${25} 回復 / 戦闘不能者は復帰`, '#7dffb0', 2.6);
        break;
      case 'eshot':
        this.burst(ev.x + Math.cos(ev.a) * 18, ev.y + Math.sin(ev.a) * 18, '#ff6b81', 4, 160, 0.2, 2, 'spark', ev.a, 0.8);
        break;
    }
  }
}
