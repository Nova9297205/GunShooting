// ============================================================
// クライアント側の演出（パーティクル・ダメージ数値・画面揺れ・バナー）
// ============================================================
import type { GameEvent, ObjKind, WeaponId, ZombieType } from '../types';
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
  kind: 'spark' | 'dot' | 'ring' | 'chunk' | 'casing' | 'smoke';
  /** 加算合成で描くか（暗闇で光る） */
  glow: boolean;
  rot: number;
}

/** 地面に残る跡（血しぶき・血だまり・焦げ跡） */
export interface Decal {
  x: number;
  y: number;
  r: number;
  rot: number;
  kind: 'blood' | 'pool' | 'scorch' | 'foot';
  life: number;
  maxLife: number;
  seed: number;
}

/** 倒したゾンビの亡骸（吹き飛んで滑り、しばらく残る） */
export interface Corpse {
  x: number;
  y: number;
  vx: number;
  vy: number;
  angle: number;
  spin: number;
  type: ZombieType;
  id: number;
  life: number;
  maxLife: number;
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
  raintank: '#4f7ea0',
  stove: '#888175',
  torch: '#7a5a32',
  car: '#8d97a8',
  ironWall: '#9aa6b8',
  stone: '#8b8f96',
};

const MAX_DECALS = 260;
const MAX_CORPSES = 60;

export class Effects {
  particles: Particle[] = [];
  popups: Popup[] = [];
  decals: Decal[] = [];
  corpses: Corpse[] = [];
  banner: Banner | null = null;
  /** 画面左のイベントログ */
  feed: { t: string; c: string; life: number; cat: string }[] = [];
  trauma = 0;
  hurt = 0;
  /** ヒットストップの残り秒（見た目だけ一瞬止める） */
  hitstop = 0;
  /** 上部の細い帯で知らせる通知（補給物資など。大型バナーは日付の切り替えだけ） */
  notice: { text: string; sub: string; color: string } | null = null;
  /** 自分の弾が当たった／倒したときの照準の×印（残り時間・撃破か） */
  hitMark = { t: 0, kill: false };
  /** 射撃の反動によるカメラのずれ */
  kickX = 0;
  kickY = 0;
  /** 画面揺れの距離減衰の基準（カメラ中心） */
  listener = { x: 0, y: 0 };
  /** タレットごとの最後の射撃方向（見た目用） */
  turretAim = new Map<number, { a: number; flash: number }>();
  /** 朝まで眠ったときの暗転（秒） */
  sleepFade = 0;
  /** 仲間のピン（プレイヤーごとに1つ） */
  pings: { id: number; x: number; y: number; t: 'enemy' | 'loot' | 'go'; life: number }[] = [];

  /** 位置に応じて減衰する画面揺れ */
  shakeAt(x: number, y: number, amount: number): void {
    const d = Math.hypot(x - this.listener.x, y - this.listener.y);
    const k = 1 / (1 + (d / 320) ** 2);
    if (k > 0.03) this.shake(amount * k);
  }

  kick(angle: number, amount: number): void {
    this.kickX -= Math.cos(angle) * amount;
    this.kickY -= Math.sin(angle) * amount;
  }

  decal(x: number, y: number, r: number, kind: Decal['kind'], life = 40): void {
    this.decals.push({ x, y, r, rot: Math.random() * Math.PI * 2, kind, life, maxLife: life, seed: Math.floor(Math.random() * 1e6) });
    if (this.decals.length > MAX_DECALS) this.decals.splice(0, this.decals.length - MAX_DECALS);
  }

  /** 薬莢の排出（銃の右側へ飛び、地面に残る） */
  casing(x: number, y: number, aim: number, w: WeaponId): void {
    const side = aim + Math.PI / 2 + (Math.random() - 0.5) * 0.6;
    const sp = 120 + Math.random() * 90;
    const shell = w === 'shotgun';
    this.particles.push({
      x: x + Math.cos(aim) * 10,
      y: y + Math.sin(aim) * 10,
      vx: Math.cos(side) * sp - Math.cos(aim) * 30,
      vy: Math.sin(side) * sp - Math.sin(aim) * 30,
      life: 6,
      maxLife: 6,
      size: shell ? 4.5 : 3,
      color: shell ? '#c0392b' : '#d8b04a',
      drag: 7,
      kind: 'casing',
      glow: false,
      rot: Math.random() * Math.PI,
    });
    // 銃口の煙
    for (let i = 0; i < (shell ? 4 : 2); i++) {
      const l = 0.6 + Math.random() * 0.4;
      this.particles.push({
        x: x + Math.cos(aim) * 30,
        y: y + Math.sin(aim) * 30,
        vx: Math.cos(aim) * (40 + Math.random() * 40) + (Math.random() - 0.5) * 30,
        vy: Math.sin(aim) * (40 + Math.random() * 40) + (Math.random() - 0.5) * 30,
        life: l,
        maxLife: l,
        size: shell ? 7 : 5,
        color: '#c8c8c8',
        drag: 3,
        kind: 'smoke',
        glow: false,
        rot: 0,
      });
    }
  }

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

  /** 方向付きの血しぶき */
  bloodSpray(x: number, y: number, angle: number, amount: number): void {
    this.burst(x, y, '#8a0f0f', Math.round(6 * amount), 260 * Math.sqrt(amount), 0.5, 3, 'dot', false, angle, 0.9);
    this.burst(x, y, '#5a0808', Math.round(3 * amount), 140, 0.6, 4, 'dot', false, angle, 1.6);
    this.decal(x + Math.cos(angle) * (10 + Math.random() * 18), y + Math.sin(angle) * (10 + Math.random() * 18), 4 + amount * 4, 'blood', 30);
  }

  ring(x: number, y: number, color: string, radius: number, life: number): void {
    this.particles.push({ x, y, vx: 0, vy: 0, life, maxLife: life, size: radius, color, drag: 0, kind: 'ring', glow: true, rot: 0 });
  }

  popup(x: number, y: number, text: string, color: string, size = 15): void {
    // 同じ場所に短時間で出た数値は合算して1つにまとめる
    const n = Number(text);
    if (!Number.isNaN(n)) {
      for (const p of this.popups) {
        if (p.color !== color || p.maxLife - p.life > 0.35) continue;
        if (Math.abs(p.x - x) > 34 || Math.abs(p.y - y) > 40) continue;
        const v = Number(p.text);
        if (Number.isNaN(v)) continue;
        p.text = String(v + n);
        p.life = p.maxLife;
        p.size = Math.min(26, p.size + 1.5);
        p.vy = -60;
        return;
      }
    }
    this.popups.push({ x: x + (Math.random() - 0.5) * 12, y, text, color, life: 1, maxLife: 1, vy: -60, size });
    if (this.popups.length > 120) this.popups.shift();
  }

  shake(amount: number): void {
    this.trauma = Math.min(1, this.trauma + amount);
  }

  showBanner(text: string, sub: string, color: string, life = 2.6): void {
    this.banner = { text, sub, life, maxLife: life, color };
  }

  shakeOffset(): { x: number; y: number } {
    const s = this.trauma * this.trauma * 12;
    return { x: (Math.random() * 2 - 1) * s, y: (Math.random() * 2 - 1) * s };
  }

  update(dt: number): void {
    this.hitMark.t = Math.max(0, this.hitMark.t - dt);
    if (this.hitMark.t <= 0) this.hitMark.kill = false;
    this.trauma = Math.max(0, this.trauma - dt * 1.8);
    this.hurt = Math.max(0, this.hurt - dt * 2.5);
    for (const p of this.particles) {
      const d = Math.exp(-p.drag * dt);
      p.vx *= d;
      p.vy *= d;
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      if (p.kind === 'casing') p.rot += dt * Math.hypot(p.vx, p.vy) * 0.15;
      else if (p.kind === 'smoke') p.size += dt * 14;
      else p.rot += dt * 6;
      p.life -= dt;
    }
    for (const d of this.decals) d.life -= dt;
    this.decals = this.decals.filter((d) => d.life > 0);
    for (const c of this.corpses) {
      const k = Math.exp(-6 * dt);
      c.vx *= k;
      c.vy *= k;
      c.spin *= k;
      c.x += c.vx * dt;
      c.y += c.vy * dt;
      c.angle += c.spin * dt;
      c.life -= dt;
    }
    this.corpses = this.corpses.filter((c) => c.life > 0);
    for (const t of this.turretAim.values()) t.flash = Math.max(0, t.flash - dt);
    this.sleepFade = Math.max(0, this.sleepFade - dt);
    for (const p of this.pings) p.life -= dt;
    this.pings = this.pings.filter((p) => p.life > 0);
    const kk = Math.exp(-14 * dt);
    this.kickX *= kk;
    this.kickY *= kk;
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
    for (const f of this.feed) f.life -= dt;
    this.feed = this.feed.filter((f) => f.life > 0);
  }

  /** ホストから届いた（またはローカルで発生した）イベントを演出に変換 */
  handleEvent(ev: GameEvent, localId: number): void {
    switch (ev.k) {
      case 'hit':
        this.bloodSpray(ev.x, ev.y, ev.a, ev.m ? 1.8 : 1);
        if (ev.o === localId && !this.hitMark.kill) this.hitMark = { t: 0.14, kill: false };
        if (ev.m) {
          this.burst(ev.x, ev.y, '#ffffff', 4, 200, 0.15, 2);
          if (ev.o === localId) {
            this.hitstop = Math.max(this.hitstop, 0.045);
            this.shake(0.12);
          }
        }
        break;
      case 'wall':
        this.burst(ev.x, ev.y, '#ffd27a', 6, 320, 0.18, 1.6);
        this.burst(ev.x, ev.y, '#a59c8a', 4, 60, 0.5, 4, 'smoke', false);
        break;
      case 'dmg':
        this.popup(ev.x, ev.y, String(ev.v), ev.p ? '#c0573e' : '#ffffff', ev.p ? 17 : 14);
        break;
      case 'kill': {
        const big = ev.r >= 20;
        const dl = Math.hypot(ev.dx, ev.dy);
        const ang = dl > 0 ? Math.atan2(ev.dy, ev.dx) : Math.random() * Math.PI * 2;
        this.bloodSpray(ev.x, ev.y, ang, big ? 3 : 2);
        this.burst(ev.x, ev.y, '#3f5a2f', big ? 12 : 7, 220, 0.7, 4, 'chunk', false, ang, 1.4);
        this.decal(ev.x + Math.cos(ang) * 16, ev.y + Math.sin(ang) * 16, ev.r * 1.3, 'pool', 45);
        const push = big ? 120 : 260;
        this.corpses.push({
          x: ev.x,
          y: ev.y,
          vx: (dl > 0 ? ev.dx : 0) * push,
          vy: (dl > 0 ? ev.dy : 0) * push,
          angle: ev.a,
          spin: (Math.random() - 0.5) * 6,
          type: ev.t,
          id: ev.id,
          life: 22,
          maxLife: 22,
        });
        if (this.corpses.length > MAX_CORPSES) this.corpses.shift();
        if (ev.o === localId) {
          this.hitstop = Math.max(this.hitstop, big ? 0.09 : 0.05);
          this.hitMark = { t: 0.32, kill: true };
        }
        this.shakeAt(ev.x, ev.y, big ? 0.3 : 0.12);
        break;
      }
      case 'phit':
        if (ev.id === localId) {
          this.shake(0.3);
          this.hurt = 1;
        }
        break;
      case 'down':
        this.burst(ev.x, ev.y, PLAYER_COLORS[ev.id] ?? '#fff', 24, 260, 0.7, 3);
        this.popup(ev.x, ev.y - 30, 'DOWN!', '#c0573e', 22);
        if (ev.id === localId) this.shake(0.5);
        break;
      case 'revive':
        this.burst(ev.x, ev.y, '#8fbf8a', 28, 240, 0.8, 3);
        this.ring(ev.x, ev.y, '#8fbf8a', 60, 0.5);
        this.popup(ev.x, ev.y - 30, 'REVIVED!', '#8fbf8a', 20);
        break;
      case 'dead':
        break;
      case 'chop': {
        const c = DEBRIS_COLOR[ev.kind] ?? '#999';
        this.burst(ev.x, ev.y, c, 7, 220, 0.5, 4, 'chunk', false);
        if (ev.kind === 'car') this.burst(ev.x, ev.y, '#ffe9a8', 5, 260, 0.2, 2);
        break;
      }
      case 'job':
        this.notice = { text: ev.lvUp ? `依頼達成！ 無線の信頼度 Lv${ev.lvUp}` : '依頼達成！', sub: ev.t, color: '#8ac0e0' };
        break;
      case 'built': {
        // 建てた・直した：木くず・土ぼこりと、置いた場所に光る枠
        const c = DEBRIS_COLOR[ev.kind] ?? '#b0a080';
        this.burst(ev.x, ev.y, c, ev.repair ? 6 : 12, 120, 0.5, 3, 'chunk', false);
        this.burst(ev.x, ev.y + 8, '#8a7a60', 8, 60, 0.9, 8, 'smoke', false, -Math.PI / 2, 1.2);
        this.ring(ev.x, ev.y, ev.repair ? '#93b77c' : '#e0c080', 46, 0.35);
        break;
      }
      case 'smash': {
        const c = DEBRIS_COLOR[ev.kind] ?? '#999';
        this.burst(ev.x, ev.y, c, 5, 160, 0.45, 4, 'chunk', false);
        this.shakeAt(ev.x, ev.y, 0.05);
        break;
      }
      case 'break': {
        const c = DEBRIS_COLOR[ev.kind] ?? '#999';
        this.burst(ev.x, ev.y, c, 22, 300, 0.8, 5, 'chunk', false);
        this.burst(ev.x, ev.y, '#bfb6a5', 10, 120, 1.0, 9, 'smoke', false);
        this.shakeAt(ev.x, ev.y, 0.25);
        break;
      }
      case 'build':
        this.burst(ev.x, ev.y, '#e0f0ff', 8, 140, 0.35, 2);
        this.ring(ev.x, ev.y, '#9fb4c2', 30, 0.3);
        break;
      case 'pop':
        this.popup(ev.x, ev.y, ev.t, ev.c, ev.id === localId ? 15 : 12);
        break;
      case 'banner':
        // 大きな中央バナーは日付・昼夜の切り替えだけ。それ以外は上部の細い帯に
        if (!ev.t.startsWith('DAY')) {
          this.notice = { text: ev.t, sub: ev.s, color: ev.c };
          break;
        }
        this.showBanner(ev.t, ev.s, ev.c);
        if (ev.c === '#b03a2e') this.shake(0.5);
        break;
      case 'burn':
        this.burst(ev.x, ev.y, '#c88a4a', 16, 120, 1.0, 4, 'spark', true, -Math.PI / 2, 1.2);
        this.burst(ev.x, ev.y, '#555', 10, 60, 1.4, 8, 'smoke', false, -Math.PI / 2, 1);
        this.decal(ev.x, ev.y, 18, 'scorch', 40);
        break;
      case 'door':
        this.burst(ev.x, ev.y, '#8a8070', 5, 60, 0.6, 5, 'smoke', false);
        break;
      case 'feed':
        this.feed.push({ t: ev.t, c: ev.c, life: 9, cat: ev.cat ?? 'info' });
        if (this.feed.length > 6) this.feed.shift();
        break;
      case 'ricochet':
        // 装甲に弾かれた火花
        this.burst(ev.x, ev.y, '#e8e0b0', 4, 260, 0.15, 1.4, 'spark', true);
        break;
      case 'tshot':
        this.turretAim.set(ev.id, { a: ev.a, flash: 0.06 });
        this.burst(ev.x + Math.cos(ev.a) * 24, ev.y + Math.sin(ev.a) * 24, '#ffd27a', 3, 180, 0.12, 1.5, 'spark', true, ev.a, 0.6);
        this.casing(ev.x - Math.cos(ev.a) * 12, ev.y - Math.sin(ev.a) * 12, ev.a, 'rifle');
        break;
      case 'ping':
        this.pings = this.pings.filter((p) => p.id !== ev.id);
        this.pings.push({ id: ev.id, x: ev.x, y: ev.y, t: ev.t, life: 7 });
        this.ring(ev.x, ev.y, ev.t === 'enemy' ? '#c0573e' : ev.t === 'loot' ? '#c9a85a' : PLAYER_COLORS[ev.id] ?? '#fff', 60, 0.6);
        break;
      case 'noise':
        this.ring(ev.x, ev.y, '#5a6270', 46, 0.25); // 銃声（騒音）の小さな波紋
        break;
      case 'gas':
        // 膨張体の破裂：黄緑の毒ガスが広がる
        this.burst(ev.x, ev.y, '#a8c060', 26, 120, 2.2, 14, 'smoke', false);
        this.burst(ev.x, ev.y, '#d0e070', 12, 220, 0.5, 3, 'dot', false);
        this.ring(ev.x, ev.y, '#b8d070', 150, 0.6);
        this.decal(ev.x, ev.y, 34, 'scorch', 50);
        break;
      case 'scream':
        // 叫び声の大きな波紋
        this.ring(ev.x, ev.y, '#e8c8b0', 220, 0.9);
        this.ring(ev.x, ev.y, '#e09070', 120, 0.6);
        break;
      case 'sleep':
        this.sleepFade = 2.2;
        break;
      case 'boom':
        this.burst(ev.x, ev.y, '#ffb050', 30, 380, 0.5, 4, 'spark', true);
        this.burst(ev.x, ev.y, '#ff7030', 14, 160, 0.7, 10, 'smoke', true, -Math.PI / 2, 2);
        this.burst(ev.x, ev.y, '#3a3632', 18, 90, 2.4, 16, 'smoke', false, -Math.PI / 2, 1.6);
        this.ring(ev.x, ev.y, '#ffc070', 140, 0.4);
        this.decal(ev.x, ev.y, 40, 'scorch', 80);
        this.shake(0.7);
        break;
    }
  }
}
