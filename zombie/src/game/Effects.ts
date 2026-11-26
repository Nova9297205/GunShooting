// ============================================================
// クライアント側の演出（パーティクル・ダメージ数値・画面揺れ・バナー）
// ============================================================
import type { GameEvent, ObjKind } from '../types';
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
  kind: 'spark' | 'dot' | 'ring' | 'chunk';
  /** 加算合成で描くか（暗闇で光る） */
  glow: boolean;
  rot: number;
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

const MAX_PARTICLES = 1000;

const DEBRIS_COLOR: Partial<Record<ObjKind, string>> = {
  tree: '#8a5a32',
  woodWall: '#a8743f',
  spike: '#a8743f',
  car: '#8d97a8',
  ironWall: '#9aa6b8',
  stone: '#8b8f96',
};

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
    glow = true,
    dirAngle?: number,
    spreadAngle = Math.PI * 2,
  ): void {
    for (let i = 0; i < count; i++) {
      const a = dirAngle === undefined ? Math.random() * Math.PI * 2 : dirAngle + (Math.random() - 0.5) * spreadAngle;
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
        drag: kind === 'chunk' ? 5 : 4,
        kind,
        glow,
        rot: Math.random() * Math.PI,
      });
    }
    if (this.particles.length > MAX_PARTICLES) this.particles.splice(0, this.particles.length - MAX_PARTICLES);
  }

  ring(x: number, y: number, color: string, radius: number, life: number): void {
    this.particles.push({ x, y, vx: 0, vy: 0, life, maxLife: life, size: radius, color, drag: 0, kind: 'ring', glow: true, rot: 0 });
  }

  popup(x: number, y: number, text: string, color: string, size = 15): void {
    this.popups.push({ x: x + (Math.random() - 0.5) * 12, y, text, color, life: 1, maxLife: 1, vy: -60, size });
    if (this.popups.length > 120) this.popups.shift();
  }

  shake(amount: number): void {
    this.trauma = Math.min(1, this.trauma + amount);
  }

  showBanner(text: string, sub: string, color: string, life = 3.2): void {
    this.banner = { text, sub, life, maxLife: life, color };
  }

  shakeOffset(): { x: number; y: number } {
    const s = this.trauma * this.trauma * 12;
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
      p.rot += dt * 6;
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
        this.burst(ev.x, ev.y, '#7a1010', 7, 220, 0.45, 3, 'dot', false);
        this.burst(ev.x, ev.y, '#ffdca8', 3, 240, 0.18, 2);
        break;
      case 'wall':
        this.burst(ev.x, ev.y, '#d9d2c0', 5, 200, 0.25, 2);
        break;
      case 'dmg':
        this.popup(ev.x, ev.y, String(ev.v), ev.p ? '#ff5c5c' : '#ffffff', ev.p ? 17 : 14);
        break;
      case 'kill':
        this.burst(ev.x, ev.y, '#6b0d0d', 16 + ev.r, 260, 0.8, 4, 'dot', false);
        this.burst(ev.x, ev.y, '#3f5a2f', 8, 200, 0.7, 4, 'chunk', false);
        this.shake(0.08);
        break;
      case 'phit':
        if (ev.id === localId) {
          this.shake(0.3);
          this.hurt = 1;
        }
        break;
      case 'down':
        this.burst(ev.x, ev.y, PLAYER_COLORS[ev.id] ?? '#fff', 24, 260, 0.7, 3);
        this.popup(ev.x, ev.y - 30, 'DOWN!', '#ff5c5c', 22);
        if (ev.id === localId) this.shake(0.5);
        break;
      case 'revive':
        this.burst(ev.x, ev.y, '#7dffb0', 28, 240, 0.8, 3);
        this.ring(ev.x, ev.y, '#7dffb0', 60, 0.5);
        this.popup(ev.x, ev.y - 30, 'REVIVED!', '#7dffb0', 20);
        break;
      case 'dead':
        break;
      case 'chop': {
        const c = DEBRIS_COLOR[ev.kind] ?? '#999';
        this.burst(ev.x, ev.y, c, 7, 220, 0.5, 4, 'chunk', false);
        if (ev.kind === 'car') this.burst(ev.x, ev.y, '#ffe9a8', 5, 260, 0.2, 2);
        break;
      }
      case 'smash': {
        const c = DEBRIS_COLOR[ev.kind] ?? '#999';
        this.burst(ev.x, ev.y, c, 5, 160, 0.45, 4, 'chunk', false);
        break;
      }
      case 'break': {
        const c = DEBRIS_COLOR[ev.kind] ?? '#999';
        this.burst(ev.x, ev.y, c, 22, 300, 0.8, 5, 'chunk', false);
        this.burst(ev.x, ev.y, '#bfb6a5', 10, 120, 1.0, 9, 'dot', false);
        this.shake(0.12);
        break;
      }
      case 'build':
        this.burst(ev.x, ev.y, '#e0f0ff', 8, 140, 0.35, 2);
        this.ring(ev.x, ev.y, '#9fd8ff', 30, 0.3);
        break;
      case 'pop':
        this.popup(ev.x, ev.y, ev.t, ev.c, ev.id === localId ? 15 : 12);
        break;
      case 'banner':
        this.showBanner(ev.t, ev.s, ev.c);
        if (ev.c === '#ff3b3b') this.shake(0.5);
        break;
      case 'burn':
        this.burst(ev.x, ev.y, '#ff9a3d', 16, 120, 1.0, 4, 'spark', true, -Math.PI / 2, 1.2);
        this.burst(ev.x, ev.y, '#555', 10, 60, 1.4, 8, 'dot', false, -Math.PI / 2, 1);
        break;
      case 'noise':
        this.ring(ev.x, ev.y, '#5a6270', 46, 0.25); // 銃声（騒音）の小さな波紋
        break;
    }
  }
}
