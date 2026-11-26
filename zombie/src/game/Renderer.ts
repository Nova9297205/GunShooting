// ============================================================
// Renderer: カメラ・マップ・夜の暗闇＆懐中電灯ライティング・建築グリッド・HUD・ミニマップ
//   見た目（キャラ・オブジェクト）の描画は Art.ts の ArtSet に委譲している
// ============================================================
import type { GameMode, ObjSnap, PlayerSnap, ViewState, ZombieSnap } from '../types';
import { Tool } from '../types';
import { type ArtSet, type PlayerAnim, type TallQuery, VectorArt, type ZombieAnim } from './Art';
import {
  BREAKABLE_KINDS,
  BUILD_COST,
  CYCLE_SECONDS,
  DAY_SECONDS,
  GUN,
  HORDE_EVERY,
  MAP_H,
  MAP_W,
  PLAYER,
  PLAYER_COLORS,
  T_WALL,
  TILE,
  TORCH_LIGHT,
  TOOL_BUILD,
  TOOLS,
  WORLD_H,
  WORLD_W,
  ZOMBIE,
} from './constants';
import type { Effects } from './Effects';
import { circleOverlapsTile, clamp } from './physics';
import type { TileWorld } from './world';

/** 落ち影と側面を持つ「高い」建築物 */
const WALL_KINDS: ReadonlySet<ObjSnap['kind']> = new Set<ObjSnap['kind']>(['stone', 'woodWall', 'ironWall']);

export interface RenderOptions {
  localId: number;
  mode: GameMode;
  roomCode?: string;
  effects: Effects;
  dt: number;
  mouseX: number;
  mouseY: number;
  /** ゲスト自機は射撃/近接アニメをローカルで発生させるので、カウンタ検出をしない */
  skipAnimDetectId: number | null;
  localTool: number;
  reviveHint: boolean;
  interactHint: string | null;
  syncMs?: number;
  muted?: boolean;
}

/** 射撃・近接・リロードを検出したときに呼ばれるフック（効果音用） */
export interface AnimHooks {
  shot(p: PlayerSnap): void;
  swing(p: PlayerSnap): void;
  reload(p: PlayerSnap): void;
}

/**
 * 時刻ごとの環境光キーフレーム [分, 暗さ, 色味R, G, B, 色味の強さ]
 * 朝焼け → 昼 → 夕方の黄金色 → 夕焼け → 紫の薄暮 → 青い夜 と色温度が変化する
 */
const AMBIENT: [number, number, number, number, number, number][] = [
  [0, 0.92, 70, 90, 160, 0.3],
  [300, 0.9, 80, 90, 170, 0.3],
  [360, 0.62, 255, 140, 120, 0.22], // 夜明け（ピンク）
  [420, 0.15, 255, 190, 140, 0.14],
  [480, 0, 255, 235, 210, 0.04],
  [900, 0, 255, 245, 230, 0.02], // 昼
  [990, 0, 255, 200, 120, 0.1], // 午後の黄金色
  [1080, 0.08, 255, 150, 70, 0.2], // 夕焼け
  [1150, 0.42, 200, 100, 120, 0.24],
  [1200, 0.72, 120, 90, 170, 0.28], // 紫の薄暮
  [1260, 0.92, 70, 90, 160, 0.3], // 夜
  [1440, 0.92, 70, 90, 160, 0.3],
];

export function ambientAt(m: number): { dark: number; r: number; g: number; b: number; a: number } {
  for (let i = 0; i < AMBIENT.length - 1; i++) {
    const k0 = AMBIENT[i];
    const k1 = AMBIENT[i + 1];
    if (m >= k0[0] && m <= k1[0]) {
      const t = (m - k0[0]) / (k1[0] - k0[0] || 1);
      const L = (j: number) => k0[j] + (k1[j] - k0[j]) * t;
      return { dark: L(1), r: L(2), g: L(3), b: L(4), a: L(5) };
    }
  }
  return { dark: 0.92, r: 70, g: 90, b: 160, a: 0.3 };
}

/** 時刻（分）から暗さ 0..1 を求める */
export function darknessAt(m: number): number {
  return ambientAt(m).dark;
}

export function formatClock(m: number): string {
  const h = Math.floor(m / 60) % 24;
  const mm = Math.floor(m % 60);
  return `${String(h).padStart(2, '0')}:${String(mm).padStart(2, '0')}`;
}

export class Renderer {
  art: ArtSet = new VectorArt();
  private ctx: CanvasRenderingContext2D;
  w = 0;
  h = 0;
  private dpr = 1;
  cam = { x: WORLD_W / 2, y: WORLD_H / 2 };
  private camInit = false;
  private time = 0;
  private terrainCanvas: HTMLCanvasElement | null = null;
  private miniCanvas: HTMLCanvasElement | null = null;
  private lightCanvas = document.createElement('canvas');
  private lightCtx = this.lightCanvas.getContext('2d')!;
  private pAnim = new Map<number, PlayerAnim>();
  private zAnim = new Map<number, ZombieAnim>();
  private lastReload = new Map<number, number>();
  hooks: AnimHooks | null = null;

  constructor(
    private canvas: HTMLCanvasElement,
    private world: TileWorld,
  ) {
    this.ctx = canvas.getContext('2d')!;
    this.resize();
    this.bakeTerrain();
  }

  resize(): void {
    this.dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.w = window.innerWidth;
    this.h = window.innerHeight;
    this.canvas.width = Math.floor(this.w * this.dpr);
    this.canvas.height = Math.floor(this.h * this.dpr);
    this.canvas.style.width = `${this.w}px`;
    this.canvas.style.height = `${this.h}px`;
    // ライトマップは半解像度で十分（ぼかし効果も兼ねる）
    this.lightCanvas.width = Math.ceil(this.w / 2);
    this.lightCanvas.height = Math.ceil(this.h / 2);
  }

  /** 地形をオフスクリーンキャンバスに一度だけ描き込む */
  /** 地形をオフスクリーンキャンバスに一度だけ描き込む */
  private bakeTerrain(): void {
    const baked = this.art.bakeTerrain(this.world);
    this.terrainCanvas = baked.canvas;
    this.miniCanvas = baked.mini;
  }

  screenToWorld(sx: number, sy: number): { x: number; y: number } {
    return { x: sx - this.w / 2 + this.cam.x, y: sy - this.h / 2 + this.cam.y };
  }

  private getPAnim(id: number): PlayerAnim {
    let a = this.pAnim.get(id);
    if (!a) {
      a = { recoil: 0, recoilV: 0, flash: 0, flashSeed: 0, lastShots: -1, swing: 0, lastSwings: -1, walk: 0, lastX: NaN, lastY: NaN, move: 0 };
      this.pAnim.set(id, a);
    }
    return a;
  }

  triggerShot(id: number): void {
    const a = this.getPAnim(id);
    a.recoil = -6;
    a.recoilV = 0;
    a.flash = 0.06;
    a.flashSeed = Math.random();
  }

  triggerSwing(id: number): void {
    this.getPAnim(id).swing = 1;
  }

  // ============================================================
  render(view: ViewState, o: RenderOptions): void {
    const { ctx } = this;
    const dt = o.dt;
    this.time += dt;
    const fx = o.effects;

    this.updateAnims(view, o);
    fx.update(dt);

    // ---- カメラ ----
    const me = view.players.find((p) => p.id === o.localId);
    let focus: PlayerSnap | undefined = me;
    if (!focus || focus.status === 'dead') focus = view.players.find((p) => p.status === 'alive') ?? me;
    if (focus) {
      let tx = focus.x;
      let ty = focus.y;
      if (focus === me && me.status === 'alive') {
        tx += clamp(o.mouseX - this.w / 2, -this.w / 2, this.w / 2) * 0.15;
        ty += clamp(o.mouseY - this.h / 2, -this.h / 2, this.h / 2) * 0.15;
      }
      if (!this.camInit) {
        this.cam.x = tx;
        this.cam.y = ty;
        this.camInit = true;
      }
      const k = 1 - Math.exp(-8 * dt);
      this.cam.x += (tx - this.cam.x) * k;
      this.cam.y += (ty - this.cam.y) * k;
    }
    const shake = fx.shakeOffset();
    const ox = Math.round(this.w / 2 - this.cam.x + shake.x);
    const oy = Math.round(this.h / 2 - this.cam.y + shake.y);

    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.fillStyle = '#0b0d10';
    ctx.fillRect(0, 0, this.w, this.h);

    // ---- ワールド ----
    ctx.save();
    ctx.translate(ox, oy);
    const vx0 = this.cam.x - this.w / 2 - TILE * 2;
    const vy0 = this.cam.y - this.h / 2 - TILE * 2;
    const vx1 = vx0 + this.w + TILE * 4;
    const vy1 = vy0 + this.h + TILE * 4;
    if (this.terrainCanvas) {
      const sx = clamp(Math.floor(vx0), 0, WORLD_W);
      const sy = clamp(Math.floor(vy0), 0, WORLD_H);
      const sw = clamp(Math.ceil(vx1), 0, WORLD_W) - sx;
      const sh = clamp(Math.ceil(vy1), 0, WORLD_H) - sy;
      if (sw > 0 && sh > 0) ctx.drawImage(this.terrainCanvas, sx, sy, sw, sh, sx, sy, sw, sh);
    }

    const visible: ObjSnap[] = [];
    for (const ob of this.world.objects.values()) {
      const x = ob.tx * TILE;
      const y = ob.ty * TILE;
      if (x < vx0 || y < vy0 || x > vx1 || y > vy1) continue;
      visible.push(ob);
    }
    // 壁の落ち影（重なっても濃くならないよう1つのパスでまとめて塗る）
    ctx.fillStyle = 'rgba(0,0,0,0.3)';
    ctx.beginPath();
    for (const ob of visible) if (WALL_KINDS.has(ob.kind)) ctx.rect(ob.tx * TILE + 7, ob.ty * TILE + 10, TILE, TILE);
    ctx.fill();
    const tall: ObjSnap[] = [];
    for (const ob of visible) {
      if (!this.art.drawLowObject(ctx, ob, this.time, this.tallQuery(ob.tx, ob.ty))) tall.push(ob);
      // 焚き火・松明から舞い上がる火の粉
      if ((ob.kind === 'campfire' || ob.kind === 'torch') && Math.random() < dt * (ob.kind === 'campfire' ? 9 : 3)) {
        fx.burst((ob.tx + 0.5) * TILE + (Math.random() - 0.5) * 10, (ob.ty + 0.5) * TILE - 6, '#ffb060', 1, 40, 1.4, 1.4, 'dot', true, -Math.PI / 2, 0.9);
      }
    }

    this.drawBuildGhost(o, me);
    this.drawBullets(view, o);
    for (const z of view.zombies) this.art.drawZombie(ctx, z, this.getZAnim(z), this.time);
    for (const p of view.players) this.art.drawPlayer(ctx, p, PLAYER_COLORS[p.id] ?? '#fff', this.getPAnim(p.id), this.time);
    for (const ob of tall) this.art.drawTallObject(ctx, ob, this.time);
    this.drawParticles(fx, false);
    this.drawCloudShadows(view.minute, vx0, vy0, vx1, vy1);
    this.drawStructureBars(visible);
    ctx.restore();

    // ---- ライティング ----
    const dark = darknessAt(view.minute);
    this.drawLighting(view, dark, ox, oy);

    // ---- 光る要素・オーバーレイ ----
    ctx.save();
    ctx.translate(ox, oy);
    this.drawParticles(fx, true);
    this.drawGlows(view, dark);
    for (const p of view.players) this.drawPlayerOverlay(p, p.id === o.localId);
    this.drawZombieOverlays(view.zombies, dark, me);
    this.drawPopups(fx);
    ctx.restore();

    this.drawHUD(view, o, me, dark);
  }

  /** 隣のタイルに高い壁（廃墟の壁・建築壁）があるか */
  private tallQuery(tx: number, ty: number): TallQuery {
    return (dx, dy) => {
      const x = tx + dx;
      const y = ty + dy;
      if (this.world.terrainAt(x, y) === T_WALL) return true;
      const ob = this.world.objAt(x, y);
      return !!ob && WALL_KINDS.has(ob.kind);
    };
  }

  /** 昼間にゆっくり流れる雲の影 */
  private drawCloudShadows(minute: number, x0: number, y0: number, x1: number, y1: number): void {
    const amb = ambientAt(minute);
    const k = 1 - Math.min(1, amb.dark * 2.5);
    if (k <= 0.02) return;
    const { ctx } = this;
    const span = WORLD_W + 1200;
    for (let i = 0; i < 7; i++) {
      const cx = ((i * 977 + this.time * (10 + i * 2)) % span) - 600;
      const cy = (i * 541) % WORLD_H;
      const r = 260 + (i % 3) * 120;
      if (cx + r < x0 || cx - r > x1 || cy + r < y0 || cy - r > y1) continue;
      const g = ctx.createRadialGradient(cx, cy, 0, cx, cy, r);
      g.addColorStop(0, `rgba(10,20,30,${0.14 * k})`);
      g.addColorStop(0.6, `rgba(10,20,30,${0.08 * k})`);
      g.addColorStop(1, 'rgba(10,20,30,0)');
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.ellipse(cx, cy, r * 1.4, r, 0.3, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  private getZAnim(z: ZombieSnap): ZombieAnim {
    let a = this.zAnim.get(z.id);
    if (!a) {
      a = { lastAtk: z.atk, lunge: 0, walk: Math.random() * 6, lastX: z.x, lastY: z.y, move: 0 };
      this.zAnim.set(z.id, a);
    }
    return a;
  }

  private updateAnims(view: ViewState, o: RenderOptions): void {
    const dt = o.dt;
    for (const p of view.players) {
      const a = this.getPAnim(p.id);
      if (a.lastShots < 0) a.lastShots = p.shots;
      if (a.lastSwings < 0) a.lastSwings = p.swings;
      if (p.id !== o.skipAnimDetectId) {
        if (p.shots !== a.lastShots) {
          this.triggerShot(p.id);
          this.hooks?.shot(p);
        }
        if (p.swings !== a.lastSwings) {
          this.triggerSwing(p.id);
          this.hooks?.swing(p);
        }
      }
      const lr = this.lastReload.get(p.id) ?? 0;
      if (p.reloadT > 0 && lr <= 0) this.hooks?.reload(p);
      this.lastReload.set(p.id, p.reloadT);
      a.lastShots = p.shots;
      a.lastSwings = p.swings;
      a.recoilV += (-900 * a.recoil - 26 * a.recoilV) * dt;
      a.recoil += a.recoilV * dt;
      a.flash = Math.max(0, a.flash - dt);
      a.swing = Math.max(0, a.swing - dt * 3.2);
      if (!Number.isNaN(a.lastX)) {
        const mv = Math.hypot(p.x - a.lastX, p.y - a.lastY);
        a.walk += mv * 0.18;
        a.move += (Math.min(1, mv / Math.max(1e-3, dt) / 160) - a.move) * Math.min(1, dt * 10);
        if (p.dashTime > 0 && p.status === 'alive') o.effects.burst(p.x, p.y, '#cfc6b0', 1, 40, 0.4, 4, 'dot', false);
      }
      a.lastX = p.x;
      a.lastY = p.y;
    }
    const seen = new Set<number>();
    for (const z of view.zombies) {
      seen.add(z.id);
      const a = this.getZAnim(z);
      if (z.atk !== a.lastAtk) {
        a.lunge = 1;
        a.lastAtk = z.atk;
      }
      a.lunge = Math.max(0, a.lunge - dt * 4);
      const zm = Math.hypot(z.x - a.lastX, z.y - a.lastY);
      a.walk += zm * 0.2;
      a.move += (Math.min(1, zm / Math.max(1e-3, dt) / 60) - a.move) * Math.min(1, dt * 8);
      a.lastX = z.x;
      a.lastY = z.y;
    }
    if (this.zAnim.size > view.zombies.length + 50) {
      for (const id of this.zAnim.keys()) if (!seen.has(id)) this.zAnim.delete(id);
    }
  }

  // ---------------- 建築グリッド・ゴースト ----------------

  private drawBuildGhost(o: RenderOptions, me: PlayerSnap | undefined): void {
    if (!me || me.status !== 'alive') return;
    const kind = TOOL_BUILD[o.localTool];
    const isRepair = o.localTool === Tool.Repair;
    if (!kind && !isRepair) return;
    const { ctx } = this;
    const mw = this.screenToWorld(o.mouseX, o.mouseY);
    const tx = Math.floor(mw.x / TILE);
    const ty = Math.floor(mw.y / TILE);

    // 周囲のグリッド線
    ctx.strokeStyle = 'rgba(180,220,255,0.10)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let gx = tx - 5; gx <= tx + 6; gx++) {
      ctx.moveTo(gx * TILE + 0.5, (ty - 5) * TILE);
      ctx.lineTo(gx * TILE + 0.5, (ty + 6) * TILE);
    }
    for (let gy = ty - 5; gy <= ty + 6; gy++) {
      ctx.moveTo((tx - 5) * TILE, gy * TILE + 0.5);
      ctx.lineTo((tx + 6) * TILE, gy * TILE + 0.5);
    }
    ctx.stroke();
    // 設置範囲
    ctx.setLineDash([6, 8]);
    ctx.strokeStyle = 'rgba(180,220,255,0.25)';
    ctx.beginPath();
    ctx.arc(me.x, me.y, isRepair ? PLAYER.buildRange * 0.7 : PLAYER.buildRange, 0, Math.PI * 2);
    ctx.stroke();
    ctx.setLineDash([]);

    const cx = (tx + 0.5) * TILE;
    const cy = (ty + 0.5) * TILE;
    const inRange = Math.hypot(cx - me.x, cy - me.y) <= (isRepair ? PLAYER.buildRange * 0.7 : PLAYER.buildRange);
    if (isRepair) {
      const ob = this.world.objAt(tx, ty);
      const ok = !!ob && (BREAKABLE_KINDS.has(ob.kind) || ob.kind === 'spike');
      ctx.strokeStyle = ok && inRange ? (ob!.hp < ob!.maxHp ? '#7dd3ff' : 'rgba(125,211,255,0.4)') : 'rgba(255,255,255,0.25)';
      ctx.lineWidth = 2;
      ctx.strokeRect(tx * TILE + 1, ty * TILE + 1, TILE - 2, TILE - 2);
      return;
    }
    const valid =
      inRange &&
      this.world.inBounds(tx, ty) &&
      this.world.terrainAt(tx, ty) !== T_WALL &&
      !this.world.objAt(tx, ty) &&
      (kind === 'spike' || !circleOverlapsTile(me.x, me.y, PLAYER.radius, tx, ty));
    const ghost: ObjSnap = { id: -1, kind: kind!, tx, ty, hp: 1, maxHp: 1, ready: 1 };
    ctx.globalAlpha = 0.45;
    if (!this.art.drawLowObject(ctx, ghost, this.time, () => false)) this.art.drawTallObject(ctx, ghost, this.time);
    ctx.globalAlpha = 1;
    ctx.fillStyle = valid ? 'rgba(90,255,140,0.18)' : 'rgba(255,70,70,0.25)';
    ctx.fillRect(tx * TILE, ty * TILE, TILE, TILE);
    ctx.strokeStyle = valid ? '#5bff8c' : '#ff4646';
    ctx.lineWidth = 2;
    ctx.strokeRect(tx * TILE + 1, ty * TILE + 1, TILE - 2, TILE - 2);
  }

  private drawStructureBars(objs: ObjSnap[]): void {
    const { ctx } = this;
    for (const ob of objs) {
      if (ob.hp >= ob.maxHp || ob.maxHp <= 1) continue;
      if (ob.kind === 'tree' || ob.kind === 'car') {
        if (ob.hp <= 0) continue;
      }
      const r = clamp(ob.hp / ob.maxHp, 0, 1);
      const x = ob.tx * TILE + 4;
      const y = ob.ty * TILE - 6;
      ctx.fillStyle = 'rgba(0,0,0,0.6)';
      ctx.fillRect(x - 1, y - 1, TILE - 6, 5);
      ctx.fillStyle = r > 0.5 ? '#9fd8ff' : r > 0.25 ? '#ffd84d' : '#ff5c5c';
      ctx.fillRect(x, y, (TILE - 8) * r, 3);
    }
  }

  // ---------------- 弾・パーティクル ----------------

  private drawBullets(view: ViewState, _o: RenderOptions): void {
    const { ctx } = this;
    ctx.save();
    ctx.lineCap = 'round';
    for (const b of view.bullets) {
      ctx.strokeStyle = 'rgba(255,220,140,0.55)';
      ctx.lineWidth = 4;
      ctx.beginPath();
      ctx.moveTo(b.x - b.vx * 0.02, b.y - b.vy * 0.02);
      ctx.lineTo(b.x, b.y);
      ctx.stroke();
      ctx.strokeStyle = '#fffbe8';
      ctx.lineWidth = 1.6;
      ctx.beginPath();
      ctx.moveTo(b.x - b.vx * 0.01, b.y - b.vy * 0.01);
      ctx.lineTo(b.x, b.y);
      ctx.stroke();
    }
    ctx.restore();
  }

  private drawParticles(fx: Effects, glow: boolean): void {
    const { ctx } = this;
    ctx.save();
    if (glow) ctx.globalCompositeOperation = 'lighter';
    ctx.lineCap = 'round';
    for (const p of fx.particles) {
      if (p.glow !== glow) continue;
      const t = p.life / p.maxLife;
      ctx.globalAlpha = Math.min(1, t * 1.4);
      if (p.kind === 'ring') {
        ctx.strokeStyle = p.color;
        ctx.lineWidth = 1 + 4 * t;
        ctx.beginPath();
        ctx.arc(p.x, p.y, Math.max(1, p.size * (1 - t * t)), 0, Math.PI * 2);
        ctx.stroke();
      } else if (p.kind === 'spark') {
        ctx.strokeStyle = p.color;
        ctx.lineWidth = p.size * t + 0.5;
        ctx.beginPath();
        ctx.moveTo(p.x, p.y);
        ctx.lineTo(p.x - p.vx * 0.03, p.y - p.vy * 0.03);
        ctx.stroke();
      } else if (p.kind === 'chunk') {
        ctx.save();
        ctx.translate(p.x, p.y);
        ctx.rotate(p.rot);
        ctx.fillStyle = p.color;
        ctx.fillRect(-p.size / 2, -p.size / 3, p.size, p.size * 0.66);
        ctx.restore();
      } else {
        ctx.fillStyle = p.color;
        ctx.beginPath();
        ctx.arc(p.x, p.y, p.size * (0.5 + 0.5 * t), 0, Math.PI * 2);
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
      ctx.globalAlpha = Math.min(1, t * 2.5);
      ctx.font = `800 ${p.size}px "Segoe UI", sans-serif`;
      ctx.lineWidth = 3;
      ctx.strokeStyle = 'rgba(0,0,0,0.85)';
      ctx.strokeText(p.text, p.x, p.y);
      ctx.fillStyle = p.color;
      ctx.fillText(p.text, p.x, p.y);
    }
    ctx.globalAlpha = 1;
  }

  // ---------------- ライティング ----------------

  private lightSources(): { x: number; y: number; r: number; warm: number }[] {
    const out: { x: number; y: number; r: number; warm: number }[] = [];
    for (const ob of this.world.objects.values()) {
      if (ob.kind === 'campfire') {
        const flick = 1 + Math.sin(this.time * 11) * 0.03 + Math.sin(this.time * 7.3 + 1) * 0.04;
        out.push({ x: (ob.tx + 0.5) * TILE, y: (ob.ty + 0.5) * TILE, r: 300 * flick, warm: 1 });
      } else if (ob.kind === 'torch') {
        const flick = 1 + Math.sin(this.time * 13 + ob.id) * 0.04 + Math.sin(this.time * 8.1 + ob.id * 2) * 0.04;
        out.push({ x: (ob.tx + 0.5) * TILE, y: (ob.ty + 0.5) * TILE, r: TORCH_LIGHT * flick, warm: 0.8 });
      }
    }
    return out;
  }

  private drawLighting(view: ViewState, dark: number, ox: number, oy: number): void {
    const horde = view.phase === 'horde';
    const { ctx } = this;
    const amb = ambientAt(view.minute);
    if (horde) {
      // 大襲撃の夜は血のような赤
      amb.r = 255;
      amb.g = 120;
      amb.b = 110;
      amb.a = 0.16;
    }
    // ---- 色温度（乗算で全体に色味をつける） ----
    if (amb.a > 0.005) {
      ctx.save();
      ctx.globalCompositeOperation = 'multiply';
      const mix = (c: number) => Math.round(255 + (c - 255) * amb.a * 2.2);
      ctx.fillStyle = `rgb(${mix(amb.r)},${mix(amb.g)},${mix(amb.b)})`;
      ctx.fillRect(0, 0, this.w, this.h);
      ctx.restore();
    }
    if (dark > 0.01) {
      const l = this.lightCtx;
      const s = 0.5; // ライトマップの縮尺
      l.setTransform(1, 0, 0, 1, 0, 0);
      l.globalCompositeOperation = 'source-over';
      l.clearRect(0, 0, this.lightCanvas.width, this.lightCanvas.height);
      l.fillStyle = horde ? `rgba(30,4,8,${dark})` : `rgba(5,8,24,${dark})`;
      l.fillRect(0, 0, this.lightCanvas.width, this.lightCanvas.height);
      l.globalCompositeOperation = 'destination-out';
      l.setTransform(s, 0, 0, s, ox * s, oy * s);

      const hole = (x: number, y: number, r: number, a: number) => {
        const g = l.createRadialGradient(x, y, 0, x, y, r);
        g.addColorStop(0, `rgba(0,0,0,${a})`);
        g.addColorStop(0.45, `rgba(0,0,0,${a * 0.75})`);
        g.addColorStop(1, 'rgba(0,0,0,0)');
        l.fillStyle = g;
        l.beginPath();
        l.arc(x, y, r, 0, Math.PI * 2);
        l.fill();
      };
      /** 懐中電灯：角度の異なる扇を重ねて縁を柔らかくする */
      const cone = (x: number, y: number, ang: number, len: number) => {
        const layers: [number, number][] = [
          [0.2, 0.5],
          [0.3, 0.28],
          [0.42, 0.18],
          [0.56, 0.1],
        ];
        for (const [half, a] of layers) {
          const g = l.createRadialGradient(x, y, 6, x, y, len);
          g.addColorStop(0, `rgba(0,0,0,${a})`);
          g.addColorStop(0.5, `rgba(0,0,0,${a * 0.85})`);
          g.addColorStop(1, 'rgba(0,0,0,0)');
          l.fillStyle = g;
          l.beginPath();
          l.moveTo(x, y);
          l.arc(x, y, len, ang - half, ang + half);
          l.closePath();
          l.fill();
        }
      };

      for (const p of view.players) {
        if (p.status === 'dead') continue;
        hole(p.x, p.y, p.status === 'down' ? 85 : 120, 0.92);
        if (p.status !== 'alive') continue;
        cone(p.x + Math.cos(p.aim) * 12, p.y + Math.sin(p.aim) * 12, p.aim, 500);
        const a = this.pAnim.get(p.id);
        if (a && a.flash > 0) hole(p.x + Math.cos(p.aim) * 30, p.y + Math.sin(p.aim) * 30, 230, 0.95);
      }
      for (const ls of this.lightSources()) hole(ls.x, ls.y, ls.r, 1);

      ctx.save();
      ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
      ctx.imageSmoothingEnabled = true;
      ctx.drawImage(this.lightCanvas, 0, 0, this.w, this.h);
      ctx.restore();
    }
    // ---- 周辺減光（常時うっすら＋夜は強め） ----
    const v = ctx.createRadialGradient(this.w / 2, this.h / 2, Math.min(this.w, this.h) * 0.42, this.w / 2, this.h / 2, Math.max(this.w, this.h) * 0.78);
    v.addColorStop(0, 'rgba(0,0,0,0)');
    v.addColorStop(1, `rgba(0,0,0,${0.28 + dark * 0.25})`);
    ctx.fillStyle = v;
    ctx.fillRect(0, 0, this.w, this.h);
  }

  /** 暗闇の上に重ねる光の色（焚き火・松明の暖色、懐中電灯の白色） */
  private drawGlows(view: ViewState, dark: number): void {
    if (dark < 0.05) return;
    const { ctx } = this;
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    for (const ls of this.lightSources()) {
      const r = ls.r * 0.85;
      const g = ctx.createRadialGradient(ls.x, ls.y, 0, ls.x, ls.y, r);
      g.addColorStop(0, `rgba(255,150,60,${0.3 * dark * ls.warm})`);
      g.addColorStop(0.5, `rgba(255,110,40,${0.12 * dark * ls.warm})`);
      g.addColorStop(1, 'rgba(255,90,30,0)');
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.arc(ls.x, ls.y, r, 0, Math.PI * 2);
      ctx.fill();
    }
    for (const p of view.players) {
      if (p.status !== 'alive') continue;
      for (const [half, a] of [
        [0.22, 0.07],
        [0.4, 0.04],
      ] as const) {
        const len = 460;
        const g = ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, len);
        g.addColorStop(0, `rgba(255,244,210,${a * dark})`);
        g.addColorStop(1, 'rgba(255,244,210,0)');
        ctx.fillStyle = g;
        ctx.beginPath();
        ctx.moveTo(p.x, p.y);
        ctx.arc(p.x, p.y, len, p.aim - half, p.aim + half);
        ctx.closePath();
        ctx.fill();
      }
    }
    ctx.restore();
  }

  // ---------------- オーバーレイ ----------------

  private drawPlayerOverlay(p: PlayerSnap, isLocal: boolean): void {
    const { ctx } = this;
    const color = PLAYER_COLORS[p.id] ?? '#fff';
    const y = p.y - 32;
    ctx.font = 'bold 12px "Segoe UI", sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.lineWidth = 3;
    ctx.strokeStyle = 'rgba(0,0,0,0.8)';
    const label = isLocal ? `${p.name} (YOU)` : p.name;
    ctx.strokeText(label, p.x, y - 10);
    ctx.fillStyle = color;
    ctx.fillText(label, p.x, y - 10);

    if (p.status === 'alive') {
      const w = 32;
      ctx.fillStyle = 'rgba(0,0,0,0.6)';
      ctx.fillRect(p.x - w / 2 - 1, y - 1, w + 2, 5);
      const r = clamp(p.hp / p.maxHp, 0, 1);
      ctx.fillStyle = r > 0.5 ? '#5be37d' : r > 0.25 ? '#ffd84d' : '#ff5c5c';
      ctx.fillRect(p.x - w / 2, y, w * r, 3);
      if (p.reloadT > 0) {
        ctx.strokeStyle = '#ffd84d';
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.arc(p.x, p.y, 22, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * (1 - p.reloadT / GUN.reloadTime));
        ctx.stroke();
      }
    } else if (p.status === 'down') {
      const r = clamp(p.downTimer / PLAYER.downTime, 0, 1);
      ctx.lineWidth = 4;
      ctx.strokeStyle = 'rgba(0,0,0,0.6)';
      ctx.beginPath();
      ctx.arc(p.x, y - 2, 10, 0, Math.PI * 2);
      ctx.stroke();
      ctx.strokeStyle = r > 0.3 ? '#ff9a3d' : '#ff4d5e';
      ctx.beginPath();
      ctx.arc(p.x, y - 2, 10, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * r);
      ctx.stroke();
      ctx.font = 'bold 9px sans-serif';
      ctx.fillStyle = '#fff';
      ctx.fillText(String(Math.ceil(p.downTimer)), p.x, y - 2);
      ctx.font = 'bold 11px sans-serif';
      ctx.fillStyle = Math.sin(this.time * 8) > 0 ? '#ff5c5c' : '#ffb3b3';
      ctx.fillText('DOWN', p.x, p.y + 28);
      if (p.reviveProgress > 0) {
        const rp = clamp(p.reviveProgress / PLAYER.reviveTime, 0, 1);
        ctx.lineWidth = 5;
        ctx.strokeStyle = 'rgba(125,255,176,0.25)';
        ctx.beginPath();
        ctx.arc(p.x, p.y, 26, 0, Math.PI * 2);
        ctx.stroke();
        ctx.strokeStyle = '#7dffb0';
        ctx.beginPath();
        ctx.arc(p.x, p.y, 26, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * rp);
        ctx.stroke();
      } else {
        ctx.setLineDash([4, 6]);
        ctx.lineWidth = 1.5;
        ctx.strokeStyle = 'rgba(125,255,176,0.4)';
        ctx.beginPath();
        ctx.arc(p.x, p.y, PLAYER.reviveRange, this.time, this.time + Math.PI * 2);
        ctx.stroke();
        ctx.setLineDash([]);
      }
    } else {
      ctx.font = 'bold 10px sans-serif';
      ctx.fillStyle = '#9aa3b5';
      ctx.fillText('戦闘不能 - 朝に復帰', p.x, y);
    }
  }

  private drawZombieOverlays(zs: ZombieSnap[], dark: number, me: PlayerSnap | undefined): void {
    const { ctx } = this;
    for (const z of zs) {
      const r = ZOMBIE[z.type].radius;
      if (z.hp < z.maxHp) {
        const w = z.type === 'brute' ? 40 : 24;
        const y = z.y - r - 10;
        ctx.globalAlpha = dark > 0.5 ? 0.5 : 1;
        ctx.fillStyle = 'rgba(0,0,0,0.6)';
        ctx.fillRect(z.x - w / 2 - 1, y - 1, w + 2, 4);
        ctx.fillStyle = '#c94a3a';
        ctx.fillRect(z.x - w / 2, y, w * clamp(z.hp / z.maxHp, 0, 1), 2);
        ctx.globalAlpha = 1;
      }
      // 暗闇で光る目
      if (dark > 0.3 && me && Math.hypot(z.x - me.x, z.y - me.y) < 650) {
        const a = Math.cos(z.angle);
        const b = Math.sin(z.angle);
        const ex = z.x + a * r * 0.45;
        const ey = z.y + b * r * 0.45;
        ctx.fillStyle = z.horde ? `rgba(255,40,40,${0.8 * dark})` : `rgba(240,230,120,${0.55 * dark})`;
        for (const sgn of [-1, 1]) {
          ctx.beginPath();
          ctx.arc(ex - b * r * 0.16 * sgn, ey + a * r * 0.16 * sgn, 1.8, 0, Math.PI * 2);
          ctx.fill();
        }
      }
    }
  }

  // ---------------- HUD ----------------

  private drawHUD(view: ViewState, o: RenderOptions, me: PlayerSnap | undefined, dark: number): void {
    const { ctx, w, h } = this;
    const fx = o.effects;
    const horde = view.phase === 'horde';

    // 大襲撃：赤い空と画面端
    if (horde) {
      const pulse = 0.55 + Math.sin(this.time * 2.4) * 0.15;
      const g = ctx.createRadialGradient(w / 2, h / 2, Math.min(w, h) * 0.3, w / 2, h / 2, Math.max(w, h) * 0.75);
      g.addColorStop(0, 'rgba(180,0,0,0)');
      g.addColorStop(1, `rgba(200,0,0,${0.38 * pulse})`);
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, w, h);
    }
    if (fx.hurt > 0) {
      const g = ctx.createRadialGradient(w / 2, h / 2, Math.min(w, h) * 0.35, w / 2, h / 2, Math.max(w, h) * 0.7);
      g.addColorStop(0, 'rgba(255,0,40,0)');
      g.addColorStop(1, `rgba(255,0,40,${0.35 * fx.hurt})`);
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, w, h);
    }

    this.drawClock(view);
    this.drawTeam(view, o.localId);
    if (me) this.drawSelfPanel(view, me);
    this.drawHotbar(o, view);
    this.drawMinimap(view, o.localId);

    // モード表示
    ctx.font = '11px "Segoe UI", sans-serif';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';
    ctx.fillStyle = 'rgba(200,210,225,0.55)';
    const modeLabel = o.mode === 'solo' ? 'SOLO' : `${o.mode.toUpperCase()}  ROOM: ${o.roomCode ?? ''}`;
    ctx.fillText(
      modeLabel + (o.syncMs ? `  SYNC ${Math.round(o.syncMs)}ms` : '') + (o.muted ? '   ♪ OFF [M]' : '   ♪ ON [M]'),
      14,
      h - 18,
    );

    // ---- 中央メッセージ ----
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    if (me && me.status === 'down') {
      ctx.font = '900 28px "Segoe UI", sans-serif';
      ctx.fillStyle = '#ff5c5c';
      ctx.fillText('ダウン中！', w / 2, h * 0.3);
      ctx.font = '15px "Segoe UI", sans-serif';
      ctx.fillStyle = '#ffd0d5';
      ctx.fillText(`味方の蘇生を待て（残り ${Math.ceil(me.downTimer)} 秒）`, w / 2, h * 0.3 + 30);
    } else if (me && me.status === 'dead') {
      ctx.font = '900 26px "Segoe UI", sans-serif';
      ctx.fillStyle = '#9aa3b5';
      ctx.fillText('戦闘不能', w / 2, h * 0.3);
      ctx.font = '15px "Segoe UI", sans-serif';
      ctx.fillText('仲間が朝（6:00）まで生き延びれば復帰します', w / 2, h * 0.3 + 30);
    } else {
      let hint: string | null = null;
      if (o.reviveHint) hint = '[E] 長押しで蘇生';
      else if (o.interactHint) hint = o.interactHint;
      if (hint) {
        const pulse = 0.75 + Math.sin(this.time * 6) * 0.25;
        ctx.font = 'bold 16px "Segoe UI", sans-serif';
        ctx.lineWidth = 4;
        ctx.strokeStyle = 'rgba(0,0,0,0.7)';
        ctx.strokeText(hint, w / 2, h * 0.64);
        ctx.fillStyle = o.reviveHint ? `rgba(125,255,176,${pulse})` : `rgba(255,230,150,${pulse})`;
        ctx.fillText(hint, w / 2, h * 0.64);
      }
    }

    if (fx.banner) {
      const b = fx.banner;
      const t = b.life / b.maxLife;
      const appear = clamp((1 - t) * 8, 0, 1);
      const fade = clamp(t * 4, 0, 1);
      ctx.globalAlpha = Math.min(appear, fade);
      ctx.save();
      ctx.translate(w / 2, h * 0.24);
      const sc = 1 + (1 - appear) * 0.4;
      ctx.scale(sc, sc);
      ctx.font = '900 40px "Segoe UI", sans-serif';
      ctx.lineWidth = 7;
      ctx.strokeStyle = 'rgba(0,0,0,0.65)';
      ctx.strokeText(b.text, 0, 0);
      ctx.fillStyle = b.color;
      ctx.fillText(b.text, 0, 0);
      ctx.font = 'bold 15px "Segoe UI", sans-serif';
      ctx.lineWidth = 4;
      ctx.strokeText(b.sub, 0, 36);
      ctx.fillStyle = '#e6ebf5';
      ctx.fillText(b.sub, 0, 36);
      ctx.restore();
      ctx.globalAlpha = 1;
    }

    // ---- クロスヘア ----
    const cx = o.mouseX;
    const cy = o.mouseY;
    const alive = me && me.status === 'alive';
    ctx.strokeStyle = alive ? (PLAYER_COLORS[o.localId] ?? '#fff') : '#777';
    ctx.lineWidth = 2;
    ctx.beginPath();
    if (o.localTool === Tool.Gun) {
      ctx.arc(cx, cy, 8, 0, Math.PI * 2);
      ctx.moveTo(cx - 14, cy);
      ctx.lineTo(cx - 5, cy);
      ctx.moveTo(cx + 5, cy);
      ctx.lineTo(cx + 14, cy);
      ctx.moveTo(cx, cy - 14);
      ctx.lineTo(cx, cy - 5);
      ctx.moveTo(cx, cy + 5);
      ctx.lineTo(cx, cy + 14);
    } else {
      ctx.arc(cx, cy, 5, 0, Math.PI * 2);
    }
    ctx.stroke();
    if (me && o.localTool === Tool.Gun && alive) {
      ctx.font = 'bold 11px "Segoe UI", sans-serif';
      ctx.textAlign = 'left';
      ctx.fillStyle = me.inv.mag === 0 ? '#ff6b6b' : '#e6ebf5';
      ctx.fillText(me.reloadT > 0 ? 'RELOAD…' : `${me.inv.mag}/${me.inv.ammo}`, cx + 14, cy + 14);
    }
    void dark;
  }

  private drawClock(view: ViewState): void {
    const { ctx, w } = this;
    const pw = 300;
    const x = w / 2 - pw / 2;
    const horde = view.phase === 'horde';
    panel(ctx, x, 10, pw, 66, horde ? 'rgba(60,0,0,0.8)' : undefined);
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    const icon = view.phase === 'day' ? '☀' : horde ? '☠' : '☾';
    const label = view.phase === 'day' ? '昼' : horde ? '大襲撃' : '夜';
    ctx.font = '900 22px "Segoe UI", sans-serif';
    ctx.fillStyle = horde ? '#ff6b6b' : view.phase === 'night' ? '#b9c8ff' : '#ffe2a8';
    ctx.fillText(`Day ${view.day} - ${formatClock(view.minute)}  ${icon} ${label}`, w / 2, 16);

    // 時間バー（昼=黄 / 夜=青）
    const bx = x + 16;
    const bw = pw - 32;
    const by = 44;
    const dayFrac = DAY_SECONDS / CYCLE_SECONDS;
    ctx.fillStyle = '#6b5a2a';
    ctx.fillRect(bx, by, bw * dayFrac, 4);
    ctx.fillStyle = horde || view.day % HORDE_EVERY === 0 ? '#6b1a1a' : '#26305a';
    ctx.fillRect(bx + bw * dayFrac, by, bw * (1 - dayFrac), 4);
    const m = view.minute;
    const cyc = m >= 360 && m < 1200 ? ((m - 360) / 840) * dayFrac : dayFrac + (((m - 1200 + 1440) % 1440) / 600) * (1 - dayFrac);
    ctx.fillStyle = '#fff';
    ctx.fillRect(bx + bw * clamp(cyc, 0, 1) - 1, by - 3, 3, 10);

    ctx.font = 'bold 12px "Segoe UI", sans-serif';
    let sub: string;
    if (horde) sub = `大襲撃中！ 夜明けまで生き延びろ（残り ${view.hordeLeft} 体）`;
    else if (view.day % HORDE_EVERY === 0) sub = view.phase === 'day' ? '⚠ 今夜 20:00 に大襲撃が来る！' : '⚠ 大襲撃';
    else {
      const left = HORDE_EVERY - (view.day % HORDE_EVERY);
      sub = `次の大襲撃まで あと ${left} 日（Day ${view.day + left} の夜）`;
    }
    ctx.fillStyle = horde || view.day % HORDE_EVERY === 0 ? '#ff8f8f' : '#c3cbe0';
    ctx.fillText(sub, w / 2, 54);
  }

  private drawTeam(view: ViewState, localId: number): void {
    const { ctx } = this;
    const pw = 200;
    const rowH = 40;
    const x = 12;
    const y0 = 12;
    panel(ctx, x, y0, pw, 10 + rowH * view.players.length);
    view.players.forEach((p, i) => {
      const y = y0 + 8 + i * rowH;
      const color = PLAYER_COLORS[p.id];
      ctx.fillStyle = color;
      ctx.beginPath();
      ctx.arc(x + 14, y + 9, 5, 0, Math.PI * 2);
      ctx.fill();
      ctx.font = 'bold 12px "Segoe UI", sans-serif';
      ctx.textAlign = 'left';
      ctx.textBaseline = 'top';
      ctx.fillStyle = '#fff';
      ctx.fillText(p.name + (p.id === localId ? ' (YOU)' : ''), x + 24, y + 2);
      ctx.textAlign = 'right';
      ctx.fillStyle = '#aab4c8';
      ctx.font = '11px "Segoe UI", sans-serif';
      ctx.fillText(`☠${p.kills}  ⌂${p.builds}`, x + pw - 10, y + 3);
      const bw = pw - 36;
      ctx.fillStyle = 'rgba(255,255,255,0.1)';
      ctx.fillRect(x + 24, y + 19, bw, 5);
      ctx.fillRect(x + 24, y + 27, bw, 3);
      if (p.status === 'alive') {
        ctx.fillStyle = color;
        ctx.fillRect(x + 24, y + 19, bw * clamp(p.hp / p.maxHp, 0, 1), 5);
        ctx.fillStyle = '#e0a050';
        ctx.fillRect(x + 24, y + 27, bw * clamp(p.hunger / 100, 0, 1), 3);
      } else if (p.status === 'down') {
        ctx.fillStyle = '#ff4d5e';
        ctx.fillRect(x + 24, y + 19, bw * clamp(p.downTimer / PLAYER.downTime, 0, 1), 5);
        ctx.font = 'bold 10px sans-serif';
        ctx.fillStyle = '#ff9aa5';
        ctx.textAlign = 'right';
        ctx.fillText(`DOWN ${Math.ceil(p.downTimer)}s`, x + pw - 10, y + 26);
      } else {
        ctx.font = 'bold 10px sans-serif';
        ctx.fillStyle = '#9aa3b5';
        ctx.textAlign = 'left';
        ctx.fillText('戦闘不能', x + 24, y + 18);
      }
    });
  }

  private drawSelfPanel(view: ViewState, me: PlayerSnap): void {
    const { ctx, h } = this;
    const x = 12;
    const pw = 230;
    const ph = 118;
    const y = h - ph - 28;
    panel(ctx, x, y, pw, ph);
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    const bar = (label: string, by: number, ratio: number, color: string, text: string) => {
      ctx.font = 'bold 11px "Segoe UI", sans-serif';
      ctx.fillStyle = '#aab4c8';
      ctx.fillText(label, x + 10, by + 5);
      ctx.fillStyle = 'rgba(255,255,255,0.1)';
      ctx.fillRect(x + 46, by, pw - 58, 10);
      ctx.fillStyle = color;
      ctx.fillRect(x + 46, by, (pw - 58) * clamp(ratio, 0, 1), 10);
      ctx.font = 'bold 9px "Segoe UI", sans-serif';
      ctx.fillStyle = '#fff';
      ctx.textAlign = 'center';
      ctx.fillText(text, x + 46 + (pw - 58) / 2, by + 5);
      ctx.textAlign = 'left';
    };
    const hr = me.hp / me.maxHp;
    bar('HP', y + 10, hr, hr > 0.5 ? '#5be37d' : hr > 0.25 ? '#ffd84d' : '#ff5c5c', `${Math.max(0, Math.ceil(me.hp))} / ${me.maxHp}`);
    bar('空腹', y + 26, me.hunger / 100, me.hunger > 25 ? '#e0a050' : '#ff5c5c', `${Math.ceil(me.hunger)}%`);
    bar('DASH', y + 42, 1 - me.dashCd / PLAYER.dashCooldown, '#4da3ff', me.dashCd <= 0 ? 'READY [Shift]' : '');

    ctx.font = '12px "Segoe UI", sans-serif';
    const items: [string, string, string][] = [
      ['弾', `${me.inv.mag}/${me.inv.ammo}`, '#ffd84d'],
      ['火薬', String(me.inv.gunpowder), '#d0a070'],
      ['食料', String(me.inv.food), '#ffcf6b'],
      ['救急', String(me.inv.medkit), '#7dffb0'],
    ];
    items.forEach(([k, v, c], i) => {
      const ix = x + 10 + i * 55;
      ctx.fillStyle = '#8f9bb3';
      ctx.font = '10px "Segoe UI", sans-serif';
      ctx.fillText(k, ix, y + 64);
      ctx.fillStyle = c;
      ctx.font = 'bold 13px "Segoe UI", sans-serif';
      ctx.fillText(v, ix, y + 78);
    });
    ctx.fillStyle = '#8f9bb3';
    ctx.font = '10px "Segoe UI", sans-serif';
    ctx.fillText('共有資材', x + 10, y + 98);
    ctx.font = 'bold 13px "Segoe UI", sans-serif';
    ctx.fillStyle = '#d9a66b';
    ctx.fillText(`木材 ${view.stash.wood}`, x + 64, y + 98);
    ctx.fillStyle = '#c9d3e6';
    ctx.fillText(`鉄 ${view.stash.scrap}`, x + 140, y + 98);
    ctx.font = '9px "Segoe UI", sans-serif';
    ctx.fillStyle = '#6f7a90';
    ctx.fillText('[F]調べる/使う [R]リロード [C]弾薬作成 [Q]食事 [H]救急', x + 10, y + ph - 6);
  }

  private drawHotbar(o: RenderOptions, view: ViewState): void {
    const { ctx, w, h } = this;
    const size = 54;
    const gap = 6;
    const total = TOOLS.length * size + (TOOLS.length - 1) * gap;
    const x0 = w / 2 - total / 2;
    const y = h - size - 14;
    TOOLS.forEach((t, i) => {
      const x = x0 + i * (size + gap);
      const sel = o.localTool === t.id;
      panel(ctx, x, y, size, size, sel ? 'rgba(60,90,130,0.9)' : undefined);
      if (sel) {
        ctx.strokeStyle = '#9fd8ff';
        ctx.lineWidth = 2;
        roundRectPath(ctx, x + 1, y + 1, size - 2, size - 2, 7);
        ctx.stroke();
      }
      drawToolIcon(ctx, t.id, x + size / 2, y + size / 2 - 4);
      ctx.font = 'bold 10px "Segoe UI", sans-serif';
      ctx.textAlign = 'left';
      ctx.textBaseline = 'top';
      ctx.fillStyle = '#ffffff';
      ctx.fillText(t.key, x + 5, y + 4);
      ctx.textAlign = 'center';
      ctx.font = '9px "Segoe UI", sans-serif';
      const kind = TOOL_BUILD[t.id];
      let label: string = t.short;
      let affordable = true;
      if (kind) {
        const c = BUILD_COST[kind];
        label = c.wood ? `木${c.wood}` : `鉄${c.scrap}`;
        affordable = view.stash.wood >= c.wood && view.stash.scrap >= c.scrap;
      }
      ctx.fillStyle = affordable ? '#c3cbe0' : '#ff7070';
      ctx.fillText(label, x + size / 2, y + size - 13);
    });
    const cur = TOOLS[o.localTool];
    if (cur) {
      ctx.font = 'bold 12px "Segoe UI", sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'bottom';
      ctx.fillStyle = '#e6ebf5';
      ctx.fillText(`${cur.name}  （1〜6 / ホイール / B で切替）`, w / 2, y - 6);
    }
  }

  private drawMinimap(view: ViewState, localId: number): void {
    const { ctx } = this;
    if (!this.miniCanvas) return;
    const s = 2.2;
    const mw = MAP_W * s;
    const mh = MAP_H * s;
    const mx = this.w - mw - 12;
    const my = this.h - mh - 12;
    panel(ctx, mx - 4, my - 4, mw + 8, mh + 8);
    ctx.drawImage(this.miniCanvas, mx, my, mw, mh);
    const k = s / TILE;
    for (const ob of this.world.objects.values()) {
      let c: string | null = null;
      if (ob.kind === 'woodWall') c = '#c08a50';
      else if (ob.kind === 'ironWall') c = '#b8c4d4';
      else if (ob.kind === 'stone') c = '#9a968f';
      else if (ob.kind === 'spike') c = '#8a6a3a';
      else if (ob.kind === 'campfire' || ob.kind === 'torch') c = '#ff9a3d';
      else if (ob.kind === 'crate' && ob.ready) c = '#ffe08a';
      if (!c) continue;
      ctx.fillStyle = c;
      ctx.fillRect(mx + ob.tx * s, my + ob.ty * s, s, s);
    }
    const me = view.players.find((p) => p.id === localId);
    for (const z of view.zombies) {
      if (!z.horde && me && Math.hypot(z.x - me.x, z.y - me.y) > 700) continue;
      ctx.fillStyle = z.horde ? '#ff3030' : '#d05050';
      ctx.fillRect(mx + z.x * k - 1, my + z.y * k - 1, 2, 2);
    }
    for (const p of view.players) {
      if (p.status === 'dead') continue;
      ctx.fillStyle = PLAYER_COLORS[p.id];
      ctx.beginPath();
      ctx.arc(mx + p.x * k, my + p.y * k, p.id === localId ? 3.5 : 2.5, 0, Math.PI * 2);
      ctx.fill();
      if (p.status === 'down') {
        ctx.strokeStyle = '#ff4d5e';
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.arc(mx + p.x * k, my + p.y * k, 6 + Math.sin(this.time * 8) * 1.5, 0, Math.PI * 2);
        ctx.stroke();
      }
    }
    ctx.strokeStyle = 'rgba(255,255,255,0.35)';
    ctx.lineWidth = 1;
    ctx.strokeRect(mx + (this.cam.x - this.w / 2) * k, my + (this.cam.y - this.h / 2) * k, this.w * k, this.h * k);
  }
}

// ---------------- ヘルパー ----------------

function roundRectPath(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

function panel(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, fill?: string): void {
  ctx.fillStyle = fill ?? 'rgba(10,12,16,0.72)';
  roundRectPath(ctx, x, y, w, h, 8);
  ctx.fill();
  ctx.strokeStyle = 'rgba(255,255,255,0.08)';
  ctx.lineWidth = 1;
  ctx.stroke();
}

/** ホットバーのアイコン（ベクター） */
function drawToolIcon(ctx: CanvasRenderingContext2D, id: number, x: number, y: number): void {
  ctx.save();
  ctx.translate(x, y);
  ctx.lineCap = 'round';
  switch (id) {
    case Tool.Gun:
      ctx.fillStyle = '#cfd6df';
      ctx.fillRect(-12, -6, 22, 6);
      ctx.fillRect(-12, -6, 7, 14);
      ctx.fillStyle = '#7a8594';
      ctx.fillRect(-4, 0, 3, 4);
      break;
    case Tool.Axe:
      ctx.strokeStyle = '#a77d4f';
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.moveTo(-10, 10);
      ctx.lineTo(8, -8);
      ctx.stroke();
      ctx.fillStyle = '#cfd6df';
      ctx.beginPath();
      ctx.moveTo(3, -12);
      ctx.lineTo(13, -4);
      ctx.lineTo(8, 2);
      ctx.lineTo(1, -6);
      ctx.closePath();
      ctx.fill();
      break;
    case Tool.WoodWall:
      for (let i = 0; i < 3; i++) {
        ctx.fillStyle = i % 2 ? '#a06d3e' : '#8a5c33';
        ctx.fillRect(-12, -11 + i * 8, 24, 7);
      }
      break;
    case Tool.IronWall:
      ctx.fillStyle = '#8d99a8';
      ctx.fillRect(-12, -11, 24, 22);
      ctx.strokeStyle = '#3d444d';
      ctx.lineWidth = 2;
      ctx.strokeRect(-11, -10, 22, 20);
      ctx.fillStyle = '#e0e6ee';
      ctx.fillRect(-9, -8, 2, 2);
      ctx.fillRect(7, -8, 2, 2);
      ctx.fillRect(-9, 6, 2, 2);
      ctx.fillRect(7, 6, 2, 2);
      break;
    case Tool.Spike:
      ctx.strokeStyle = '#c9a26b';
      ctx.lineWidth = 2.5;
      ctx.beginPath();
      for (let i = -1; i <= 1; i++) {
        ctx.moveTo(i * 8 - 4, 10);
        ctx.lineTo(i * 8 + 4, -10);
        ctx.moveTo(i * 8 + 4, 10);
        ctx.lineTo(i * 8 - 4, -10);
      }
      ctx.stroke();
      break;
    case Tool.Repair:
      ctx.strokeStyle = '#a77d4f';
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.moveTo(-9, 10);
      ctx.lineTo(6, -5);
      ctx.stroke();
      ctx.fillStyle = '#9aa3ad';
      ctx.save();
      ctx.translate(7, -6);
      ctx.rotate(Math.PI / 4);
      ctx.fillRect(-9, -4, 18, 8);
      ctx.restore();
      break;
  }
  ctx.restore();
}
