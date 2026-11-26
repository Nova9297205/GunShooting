// ============================================================
// Renderer: カメラ・マップ・夜の暗闇＆懐中電灯ライティング・建築グリッド・HUD・ミニマップ
//   見た目（キャラ・オブジェクト）の描画は Art.ts の ArtSet に委譲している
// ============================================================
import type { GameMode, ObjSnap, PlayerSnap, ViewState, WeaponId, ZombieSnap } from '../types';
import { Tool } from '../types';
import { type ArtSet, type PlayerAnim, type TallQuery, VectorArt, type ZombieAnim } from './Art';
import {
  CYCLE_SECONDS,
  DAY_SECONDS,
  MAP_H,
  MAP_W,
  PLAYER,
  PLAYER_COLORS,
  T_WALL,
  T_WINDOW,
  TILE,
  TORCH_LIGHT,
  SLOTS,
  USABLE_SLOTS,
  WORLD_H,
  WORLD_W,
  ZOMBIE,
} from './constants';
import type { Decal, Effects } from './Effects';
import { clamp } from './physics';
import { type Viewer, Vision } from './vision';
import { locationAt, type TileWorld } from './world';
import { CONTAINER_NAMES, countItem, effectiveStats, heldWeapon, ITEMS, WEAPON_STATS as WEAPONS } from './items';
import { CONTAINER_KINDS } from './Engine';

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
/** プレイヤーが手に持っている射撃武器 */
export function weaponOfSnap(p: PlayerSnap): WeaponId {
  return heldWeapon(p)?.id ?? 'pistol';
}

export interface AnimHooks {
  shot(p: PlayerSnap, w: WeaponId): void;
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
  private vision = new Vision();
  private grain: CanvasPattern | null = null;
  private lightCanvas = document.createElement('canvas');
  private lightCtx = this.lightCanvas.getContext('2d')!;
  private pAnim = new Map<number, PlayerAnim>();
  private zAnim = new Map<number, ZombieAnim>();
  private lastReload = new Map<number, number>();
  hooks: AnimHooks | null = null;
  private fx: Effects | null = null;
  private localId = -1;
  /** 照準の広がり（連射で広がる） */
  private bloom = 0;
  private forest: CanvasPattern | null = null;
  private curLoc: string | null = null;
  private locToast: { text: string; sub: string; color: string; life: number } | null = null;

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

  triggerShot(id: number, w: WeaponId = 'pistol', x?: number, y?: number, aim?: number): void {
    const a = this.getPAnim(id);
    a.recoil = w === 'shotgun' ? -10 : w === 'rifle' ? -5 : -6;
    a.recoilV = 0;
    a.flash = w === 'shotgun' ? 0.08 : 0.06;
    a.flashSeed = Math.random();
    if (this.fx && x !== undefined && y !== undefined && aim !== undefined) {
      this.fx.casing(x, y, aim, w);
      if (id === this.localId) {
        this.fx.kick(aim, WEAPONS[w].kick);
        this.bloom = Math.min(1, this.bloom + (w === 'shotgun' ? 0.8 : 0.28));
        if (w === 'shotgun') this.fx.shake(0.18);
      }
    }
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

    this.fx = fx;
    this.localId = o.localId;
    // ヒットストップ中は世界の動き（アニメ・パーティクル）をほぼ止める
    const wdt = fx.hitstop > 0 ? dt * 0.06 : dt;
    fx.hitstop = Math.max(0, fx.hitstop - dt);
    this.bloom = Math.max(0, this.bloom - dt * 2.2);
    this.updateAnims(view, { ...o, dt: wdt });
    fx.update(wdt);

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
    shake.x += fx.kickX;
    shake.y += fx.kickY;
    const ox = Math.round(this.w / 2 - this.cam.x + shake.x);
    const oy = Math.round(this.h / 2 - this.cam.y + shake.y);

    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    // マップの外側は深い森
    if (!this.forest) this.forest = makeForestPattern(ctx);
    ctx.save();
    ctx.translate(Math.round(this.w / 2 - this.cam.x), Math.round(this.h / 2 - this.cam.y));
    ctx.fillStyle = this.forest;
    ctx.fillRect(this.cam.x - this.w / 2 - 20, this.cam.y - this.h / 2 - 20, this.w + 40, this.h + 40);
    ctx.restore();

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

    this.drawDecals(fx.decals, vx0, vy0, vx1, vy1);
    for (const c of fx.corpses) if (c.x > vx0 && c.y > vy0 && c.x < vx1 && c.y < vy1) this.art.drawCorpse(ctx, c);
    this.drawParticles(fx, false, true);
    // 森との境界（柵と影）
    ctx.strokeStyle = 'rgba(0,0,0,0.45)';
    ctx.lineWidth = 10;
    ctx.strokeRect(-5, -5, WORLD_W + 10, WORLD_H + 10);
    ctx.strokeStyle = '#5a4630';
    ctx.lineWidth = 3;
    ctx.setLineDash([14, 6]);
    ctx.strokeRect(-1, -1, WORLD_W + 2, WORLD_H + 2);
    ctx.setLineDash([]);
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

    // ---- 視界（レイキャスト）：自分と仲間の視界を合算 ----
    const dark = darknessAt(view.minute);
    this.updateVision(view, dark);
    const vis = this.vision;
    const zombiesSeen = view.zombies.filter((z) => vis.isVisible(z.x, z.y));

    this.drawSearch(view, me);
    this.drawBullets({ ...view, bullets: view.bullets.filter((b) => vis.isVisible(b.x, b.y)) }, o);
    for (const z of zombiesSeen) this.art.drawZombie(ctx, z, this.getZAnim(z), this.time);
    for (const p of view.players) this.art.drawPlayer(ctx, p, PLAYER_COLORS[p.id] ?? '#fff', this.getPAnim(p.id), this.time);
    for (const ob of tall) this.art.drawTallObject(ctx, ob, this.time, ob.kind === 'turret' ? fx.turretAim.get(ob.id) : undefined);
    this.drawParticles(fx, false);
    this.drawCloudShadows(view.minute, vx0, vy0, vx1, vy1);
    this.drawStructureBars(visible);
    // ---- 屋根と霧（見えていない場所を隠す） ----
    // 外壁が見えている建物の屋根は霧の上に（外から屋根として見える）、それ以外は記憶として霧の下に
    this.drawRoofs(me, vx0, vy0, vx1, vy1, false);
    ctx.imageSmoothingEnabled = true;
    ctx.drawImage(vis.fog, 0, 0, WORLD_W, WORLD_H);
    this.drawRoofs(me, vx0, vy0, vx1, vy1, true);
    ctx.restore();

    // ---- ライティング ----
    this.drawLighting(view, dark, ox, oy);

    // ---- 光る要素・オーバーレイ ----
    ctx.save();
    ctx.translate(ox, oy);
    this.drawParticles(fx, true);
    this.drawGlows(view, dark);
    for (const p of view.players) this.drawPlayerOverlay(p, p.id === o.localId);
    this.drawZombieOverlays(zombiesSeen, dark, me);
    this.drawPingMarkers(fx);
    this.drawPopups(fx);
    ctx.restore();

    this.drawPostFx();
    this.drawHUD(view, o, me, dark);
  }

  /** 視界の計算（昼は広く、夜は懐中電灯の届く範囲だけ） */
  private updateVision(view: ViewState, dark: number): void {
    const viewers: Viewer[] = [];
    for (const p of view.players) {
      if (p.status === 'dead') continue;
      const down = p.status === 'down';
      viewers.push({
        x: p.x,
        y: p.y,
        aim: p.aim,
        near: down ? 100 : 330 - dark * 180,
        cone: down ? 0 : 820 - dark * 300,
        half: down ? 0 : 0.72 - dark * 0.28,
      });
    }
    this.vision.update(this.world, viewers);
  }

  /** 屋根：プレイヤーが中に入っていない建物の、見えていない部分を覆う */
  private drawRoofs(me: PlayerSnap | undefined, x0: number, y0: number, x1: number, y1: number, seenPass: boolean): void {
    const { ctx } = this;
    const mtx = me ? Math.floor(me.x / TILE) : -1;
    const mty = me ? Math.floor(me.y / TILE) : -1;
    const cols = [
      ['#4a4038', '#55493f'],
      ['#3e4044', '#46484c'],
      ['#4a5040', '#535946'],
      ['#5a5248', '#625a4f'],
    ];
    for (const b of this.world.buildings) {
      if (b.x * TILE > x1 || b.y * TILE > y1 || (b.x + b.w) * TILE < x0 || (b.y + b.h) * TILE < y0) continue;
      const inside = mtx > b.x && mty > b.y && mtx < b.x + b.w - 1 && mty < b.y + b.h - 1;
      if (inside) continue;
      // 外壁のどこかが見えているか
      let seen = false;
      for (let tx = b.x; tx < b.x + b.w && !seen; tx++) seen = this.vision.tileVisible(tx, b.y) || this.vision.tileVisible(tx, b.y + b.h - 1);
      for (let ty = b.y; ty < b.y + b.h && !seen; ty++) seen = this.vision.tileVisible(b.x, ty) || this.vision.tileVisible(b.x + b.w - 1, ty);
      if (seen !== seenPass) continue;
      if (seen) this.vision.markExplored(b.x, b.y, b.w, b.h);
      const [c0, c1] = cols[b.roof % cols.length];
      for (let ty = b.y; ty < b.y + b.h; ty++)
        for (let tx = b.x; tx < b.x + b.w; tx++) {
          const edge = tx === b.x || ty === b.y || tx === b.x + b.w - 1 || ty === b.y + b.h - 1;
          if (this.vision.tileVisible(tx, ty) && (edge || !seenPass)) continue;
          if (this.vision.tileVisible(tx, ty) && seenPass && !edge) continue;
          // 波板の屋根（列ごとに明暗）
          ctx.fillStyle = (tx + ty * 0) % 2 === 0 ? c0 : c1;
          ctx.fillRect(tx * TILE, ty * TILE, TILE, TILE);
          ctx.fillStyle = 'rgba(0,0,0,0.12)';
          ctx.fillRect(tx * TILE, ty * TILE + 36, TILE, 4);
        }
      // 屋根の縁と錆
      ctx.strokeStyle = 'rgba(0,0,0,0.35)';
      ctx.lineWidth = 2;
      ctx.strokeRect(b.x * TILE + 1, b.y * TILE + 1, b.w * TILE - 2, b.h * TILE - 2);
    }
  }

  /** フィルムグレイン＋彩度を落とす色調補正 */
  private drawPostFx(): void {
    const { ctx, w, h } = this;
    ctx.save();
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    // 彩度ダウン（全体をくすんだ色調に）
    ctx.globalCompositeOperation = 'saturation';
    ctx.globalAlpha = 0.32;
    ctx.fillStyle = 'hsl(0,0%,50%)';
    ctx.fillRect(0, 0, w, h);
    // ほんのり暖色の色かぶり
    ctx.globalCompositeOperation = 'soft-light';
    ctx.globalAlpha = 0.12;
    ctx.fillStyle = '#8a7a5a';
    ctx.fillRect(0, 0, w, h);
    // フィルムグレイン
    if (!this.grain) this.grain = makeGrain(ctx);
    ctx.globalCompositeOperation = 'overlay';
    ctx.globalAlpha = 0.09;
    ctx.translate(-Math.floor(Math.random() * 128), -Math.floor(Math.random() * 128));
    ctx.fillStyle = this.grain;
    ctx.fillRect(0, 0, w + 128, h + 128);
    ctx.restore();
  }

  /** 隣のタイルに高い壁（廃墟の壁・建築壁）があるか */
  private tallQuery(tx: number, ty: number): TallQuery {
    return (dx, dy) => {
      const x = tx + dx;
      const y = ty + dy;
      const tt = this.world.terrainAt(x, y);
      if (tt === T_WALL || tt === T_WINDOW) return true;
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
          const w = weaponOfSnap(p);
          this.triggerShot(p.id, w, p.x, p.y, p.aim);
          this.hooks?.shot(p, w);
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
        // 土や草の上に足跡を残す
        const prevStep = Math.floor((a.walk - mv * 0.18) / Math.PI);
        if (p.status === 'alive' && mv > 0.2 && Math.floor(a.walk / Math.PI) !== prevStep) {
          const t = this.world.terrainAt(Math.floor(p.x / TILE), Math.floor(p.y / TILE));
          if (t === 0 || t === 4) {
            const ang = Math.atan2(p.y - a.lastY, p.x - a.lastX);
            const side = Math.floor(a.walk / Math.PI) % 2 === 0 ? 1 : -1;
            const fd = o.effects;
            fd.decals.push({ x: p.x - Math.sin(ang) * 4 * side, y: p.y + Math.cos(ang) * 4 * side, r: 2.6, rot: ang, kind: 'foot', life: 9, maxLife: 9, seed: 0 });
          }
        }
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

  // ---------------- 探索（漁り）の表示 ----------------

  /** 近くの未探索の入れ物に印を付け、探索中は進捗バーを出す */
  private drawSearch(view: ViewState, me: PlayerSnap | undefined): void {
    const { ctx } = this;
    if (me && me.status === 'alive') {
      const ptx = Math.floor(me.x / TILE);
      const pty = Math.floor(me.y / TILE);
      for (let ty = pty - 4; ty <= pty + 4; ty++)
        for (let tx = ptx - 4; tx <= ptx + 4; tx++) {
          const ob = this.world.objAt(tx, ty);
          if (!ob || !CONTAINER_KINDS.has(ob.kind) || !this.vision.tileVisible(tx, ty)) continue;
          if (ob.kind === 'car' && ob.hp <= 0) continue;
          const fresh = ob.ready === 1 || ob.kind === 'bag';
          if (!fresh) continue;
          const cx = (tx + 0.5) * TILE;
          const cy = (ty + 0.5) * TILE;
          const d = Math.hypot(cx - me.x, cy - me.y);
          const a = Math.max(0, 1 - d / 170) * (0.55 + Math.sin(this.time * 3 + ob.id) * 0.2);
          if (a <= 0.02) continue;
          ctx.strokeStyle = `rgba(226,204,140,${a})`;
          ctx.lineWidth = 1.5;
          ctx.setLineDash([4, 4]);
          ctx.strokeRect(tx * TILE + 3, ty * TILE + 3, TILE - 6, TILE - 6);
          ctx.setLineDash([]);
        }
    }
    for (const p of view.players) {
      if (!p.searchId || p.status !== 'alive') continue;
      const ob = this.world.objects.get(p.searchId);
      if (!ob) continue;
      const cx = p.x;
      const cy = p.y - 46;
      const w = 64;
      ctx.fillStyle = 'rgba(10,10,8,0.8)';
      ctx.fillRect(cx - w / 2 - 2, cy - 5, w + 4, 10);
      ctx.fillStyle = '#c9b27a';
      ctx.fillRect(cx - w / 2, cy - 3, w * Math.min(1, p.searchP), 6);
      if (p.id === this.localId) this.worldLabel(cx, cy - 12, `${CONTAINER_NAMES[ob.kind] ?? ''}を探索中…`, '#e6dcc0');
    }
  }

  private worldLabel(x: number, y: number, text: string, color: string): void {
    const { ctx } = this;
    ctx.font = 'bold 11px "Segoe UI", sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.lineWidth = 3;
    ctx.strokeStyle = 'rgba(0,0,0,0.8)';
    ctx.strokeText(text, x, y);
    ctx.fillStyle = color;
    ctx.fillText(text, x, y);
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
      ctx.fillStyle = r > 0.5 ? '#9fb4c2' : r > 0.25 ? '#c9a85a' : '#c0573e';
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

  private drawDecals(decals: Decal[], x0: number, y0: number, x1: number, y1: number): void {
    const { ctx } = this;
    for (const d of decals) {
      if (d.x < x0 || d.y < y0 || d.x > x1 || d.y > y1) continue;
      const a = Math.min(1, d.life / 6) * (d.kind === 'scorch' ? 0.55 : 0.75);
      ctx.save();
      ctx.translate(d.x, d.y);
      ctx.rotate(d.rot);
      ctx.globalAlpha = a;
      if (d.kind === 'foot') {
        // 足跡（靴底の形）
        ctx.fillStyle = 'rgba(40,32,24,0.55)';
        ctx.beginPath();
        ctx.ellipse(0, 0, d.r * 1.4, d.r * 0.7, 0, 0, Math.PI * 2);
        ctx.ellipse(-d.r * 1.9, 0, d.r * 0.7, d.r * 0.6, 0, 0, Math.PI * 2);
        ctx.fill();
      } else if (d.kind === 'scorch') {
        const g = ctx.createRadialGradient(0, 0, 0, 0, 0, d.r);
        g.addColorStop(0, 'rgba(10,8,6,0.9)');
        g.addColorStop(1, 'rgba(10,8,6,0)');
        ctx.fillStyle = g;
        ctx.beginPath();
        ctx.arc(0, 0, d.r, 0, Math.PI * 2);
        ctx.fill();
      } else {
        ctx.fillStyle = d.kind === 'pool' ? '#4a0606' : '#6a0a0a';
        ctx.beginPath();
        ctx.ellipse(0, 0, d.r, d.r * 0.7, 0, 0, Math.PI * 2);
        ctx.fill();
        // 飛び散った滴
        for (let i = 0; i < (d.kind === 'pool' ? 5 : 3); i++) {
          const ang = ((d.seed >> (i * 3)) % 628) / 100;
          const dist = d.r * (1 + ((d.seed >> (i * 2)) % 7) / 7);
          ctx.beginPath();
          ctx.arc(Math.cos(ang) * dist, Math.sin(ang) * dist, 1 + (d.r / 6) * (((d.seed >> i) % 5) / 5), 0, Math.PI * 2);
          ctx.fill();
        }
      }
      ctx.restore();
    }
  }

  private drawParticles(fx: Effects, glow: boolean, groundOnly = false): void {
    const { ctx } = this;
    ctx.save();
    if (glow) ctx.globalCompositeOperation = 'lighter';
    ctx.lineCap = 'round';
    for (const p of fx.particles) {
      if (p.glow !== glow) continue;
      if ((p.kind === 'casing') !== groundOnly) continue;
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
      } else if (p.kind === 'casing') {
        ctx.globalAlpha = Math.min(1, p.life);
        ctx.save();
        ctx.translate(p.x, p.y);
        ctx.rotate(p.rot);
        ctx.fillStyle = p.color;
        ctx.fillRect(-p.size / 2, -p.size / 4, p.size, p.size / 2);
        ctx.fillStyle = 'rgba(255,255,255,0.45)';
        ctx.fillRect(-p.size / 2, -p.size / 4, p.size, 0.8);
        ctx.restore();
      } else if (p.kind === 'smoke') {
        ctx.globalAlpha = t * 0.35;
        ctx.fillStyle = p.color;
        ctx.beginPath();
        ctx.arc(p.x, p.y, p.size, 0, Math.PI * 2);
        ctx.fill();
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
    const horde = false;
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
    // 懐中電灯の光束に舞うほこり
    for (const p of view.players) {
      if (p.status !== 'alive') continue;
      for (let i = 0; i < 18; i++) {
        const seed = i * 97.13 + p.id * 13.7;
        const dist = 40 + ((seed * 7.31 + this.time * (18 + (i % 5) * 6)) % 380);
        const off = Math.sin(seed + this.time * 0.6) * 0.32;
        const x = p.x + Math.cos(p.aim + off) * dist;
        const y = p.y + Math.sin(p.aim + off) * dist;
        const a2 = (0.25 + 0.25 * Math.sin(seed * 3 + this.time * 2)) * dark * (1 - dist / 440);
        ctx.fillStyle = `rgba(255,244,220,${Math.max(0, a2)})`;
        ctx.fillRect(x, y, 1.6, 1.6);
      }
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
      ctx.fillStyle = r > 0.5 ? '#7fa35e' : r > 0.25 ? '#c9a85a' : '#c0573e';
      ctx.fillRect(p.x - w / 2, y, w * r, 3);
      if (p.reloadT > 0) {
        ctx.strokeStyle = '#c9a85a';
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.arc(p.x, p.y, 22, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * (1 - p.reloadT / WEAPONS[weaponOfSnap(p)].reloadTime));
        ctx.stroke();
      }
    } else if (p.status === 'down') {
      const r = clamp(p.downTimer / PLAYER.downTime, 0, 1);
      ctx.lineWidth = 4;
      ctx.strokeStyle = 'rgba(0,0,0,0.6)';
      ctx.beginPath();
      ctx.arc(p.x, y - 2, 10, 0, Math.PI * 2);
      ctx.stroke();
      ctx.strokeStyle = r > 0.3 ? '#c88a4a' : '#b4483a';
      ctx.beginPath();
      ctx.arc(p.x, y - 2, 10, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * r);
      ctx.stroke();
      ctx.font = 'bold 9px sans-serif';
      ctx.fillStyle = '#fff';
      ctx.fillText(String(Math.ceil(p.downTimer)), p.x, y - 2);
      ctx.font = 'bold 11px sans-serif';
      ctx.fillStyle = Math.sin(this.time * 8) > 0 ? '#c0573e' : '#c9a09a';
      ctx.fillText('DOWN', p.x, p.y + 28);
      if (p.reviveProgress > 0) {
        const rp = clamp(p.reviveProgress / PLAYER.reviveTime, 0, 1);
        ctx.lineWidth = 5;
        ctx.strokeStyle = 'rgba(125,255,176,0.25)';
        ctx.beginPath();
        ctx.arc(p.x, p.y, 26, 0, Math.PI * 2);
        ctx.stroke();
        ctx.strokeStyle = '#8fbf8a';
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
      // 気づき具合：? = 物音を調べている / ! = 追跡中
      if (z.alert > 0) {
        const t = z.alert === 2 ? '!' : '?';
        const by = z.y - r - (z.hp < z.maxHp ? 22 : 14) + Math.sin(this.time * 6 + z.id) * 1.5;
        ctx.font = '900 15px "Segoe UI", sans-serif';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.lineWidth = 3;
        ctx.strokeStyle = 'rgba(0,0,0,0.75)';
        ctx.strokeText(t, z.x, by);
        ctx.fillStyle = z.alert === 2 ? '#e0644a' : '#d8bf6a';
        ctx.fillText(t, z.x, by);
      }
      // 暗闇で光る目
      if (dark > 0.3 && me && Math.hypot(z.x - me.x, z.y - me.y) < 650) {
        const a = Math.cos(z.angle);
        const b = Math.sin(z.angle);
        const ex = z.x + a * r * 0.45;
        const ey = z.y + b * r * 0.45;
        ctx.fillStyle = z.alert === 2 ? `rgba(240,90,60,${0.8 * dark})` : `rgba(230,220,120,${0.5 * dark})`;
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
    // 追われているときは画面端がうっすら赤く脈打つ
    const horde = !!me && me.status === 'alive' && view.zombies.some((z) => z.alert === 2 && Math.hypot(z.x - me.x, z.y - me.y) < 420 && this.vision.isVisible(z.x, z.y));

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

    this.drawClock(view, me);
    this.drawLocationToast(me, o.dt, !!fx.banner);
    this.drawAllyIndicators(view, o.localId, o.effects);
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
      modeLabel + (o.syncMs ? `  SYNC ${Math.round(o.syncMs)}ms` : '') + (o.muted ? '   ♪ OFF [M]' : '   ♪ ON [M]') + '   ピン [G]/中クリック',
      14,
      h - 18,
    );

    // ---- 中央メッセージ ----
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    if (me && me.status === 'down') {
      ctx.font = '900 28px "Segoe UI", sans-serif';
      ctx.fillStyle = '#c0573e';
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

    // ---- クロスヘア（連射で広がる） ----
    const cx = o.mouseX;
    const cy = o.mouseY;
    const alive = me && me.status === 'alive';
    const held = me ? heldWeapon({ ...me, tool: o.localTool }) : null;
    const isGun = !!held;
    const col = alive ? (PLAYER_COLORS[o.localId] ?? '#fff') : '#777';
    ctx.lineWidth = 2;
    ctx.strokeStyle = 'rgba(0,0,0,0.6)';
    const drawCross = () => {
      ctx.beginPath();
      if (isGun) {
        const sg = held?.id === 'shotgun';
        const g = (sg ? 12 : 4) + (held ? effectiveStats(held.id, held.w).spread * 60 : 0) + this.bloom * 12;
        const len = 8;
        ctx.moveTo(cx - g - len, cy);
        ctx.lineTo(cx - g, cy);
        ctx.moveTo(cx + g, cy);
        ctx.lineTo(cx + g + len, cy);
        ctx.moveTo(cx, cy - g - len);
        ctx.lineTo(cx, cy - g);
        ctx.moveTo(cx, cy + g);
        ctx.lineTo(cx, cy + g + len);
        if (sg) {
          ctx.moveTo(cx + g + 4, cy);
          ctx.arc(cx, cy, g + 4, 0, Math.PI * 2);
        }
      } else {
        ctx.arc(cx, cy, 5, 0, Math.PI * 2);
      }
      ctx.stroke();
    };
    ctx.lineWidth = 4;
    drawCross();
    ctx.strokeStyle = col;
    ctx.lineWidth = 2;
    drawCross();
    ctx.fillStyle = '#fff';
    ctx.fillRect(cx - 1, cy - 1, 2, 2);
    if (me && held && alive) {
      ctx.font = 'bold 11px "Segoe UI", sans-serif';
      ctx.textAlign = 'left';
      ctx.textBaseline = 'middle';
      const st = effectiveStats(held.id, held.w);
      const mag = held.w.mag;
      const res = countItem(me.bag, st.ammo);
      ctx.fillStyle = mag === 0 ? '#c06050' : '#e6ebf5';
      const txt = me.reloadT > 0 ? 'RELOAD…' : `${mag}/${res}`;
      ctx.lineWidth = 3;
      ctx.strokeStyle = 'rgba(0,0,0,0.7)';
      ctx.strokeText(txt, cx + 16, cy + 16);
      ctx.fillText(txt, cx + 16, cy + 16);
    }
    void dark;
  }

  /** ロケーションに入ったときの表示（例：「警察署 ★★★ 危険」） */
  private drawLocationToast(me: PlayerSnap | undefined, dt: number, bannerShown: boolean): void {
    if (me) {
      const loc = locationAt(this.world.locations, Math.floor(me.x / TILE), Math.floor(me.y / TILE));
      const key = loc ? `${loc.name}${loc.x},${loc.y}` : null;
      if (key !== this.curLoc) {
        this.curLoc = key;
        if (loc) {
          const danger = loc.tier >= 3 ? '危険：感染兵士が多数・武器や軍用物資' : loc.tier === 2 ? 'やや危険：弾薬・薬品・パーツが見つかる' : loc.kind === 'base' ? '安全地帯：倉庫・作業台・焚き火' : '比較的安全：食料・布・日用品';
          this.locToast = { text: `${loc.name}  ${'★'.repeat(loc.tier)}`, sub: danger, color: loc.tier >= 3 ? '#c98070' : loc.tier === 2 ? '#d8c48a' : '#a9c79c', life: 3.5 };
        }
      }
    }
    if (!this.locToast) return;
    // 「DAY 1」などの大きな表示と重ならないよう、それが消えるまで待ってから出す
    if (bannerShown) return;
    const t = this.locToast;
    t.life -= dt;
    if (t.life <= 0) {
      this.locToast = null;
      return;
    }
    const { ctx, w } = this;
    ctx.globalAlpha = Math.min(1, t.life, (3.5 - t.life) * 4);
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    ctx.font = '900 22px "Segoe UI", sans-serif';
    ctx.lineWidth = 5;
    ctx.strokeStyle = 'rgba(0,0,0,0.7)';
    ctx.strokeText(t.text, w / 2, 90);
    ctx.fillStyle = t.color;
    ctx.fillText(t.text, w / 2, 90);
    ctx.font = 'bold 12px "Segoe UI", sans-serif';
    ctx.lineWidth = 4;
    ctx.strokeText(t.sub, w / 2, 118);
    ctx.fillStyle = '#e6ebf5';
    ctx.fillText(t.sub, w / 2, 118);
    ctx.globalAlpha = 1;
  }

  /** ピンの目印（世界座標） */
  private drawPingMarkers(fx: Effects): void {
    const { ctx } = this;
    for (const p of fx.pings) {
      const col = p.t === 'enemy' ? '#c0573e' : p.t === 'loot' ? '#c9a85a' : (PLAYER_COLORS[p.id] ?? '#fff');
      const a = Math.min(1, p.life);
      const bounce = Math.abs(Math.sin(this.time * 4)) * 6;
      ctx.globalAlpha = a;
      ctx.strokeStyle = col;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.ellipse(p.x, p.y, 16 + Math.sin(this.time * 5) * 3, 9, 0, 0, Math.PI * 2);
      ctx.stroke();
      // 逆さのしずく型のピン
      const py = p.y - 26 - bounce;
      ctx.fillStyle = col;
      ctx.beginPath();
      ctx.moveTo(p.x, p.y - 6 - bounce);
      ctx.arc(p.x, py, 9, Math.PI * 0.25, Math.PI * 0.75, true);
      ctx.closePath();
      ctx.fill();
      ctx.fillStyle = '#111';
      ctx.font = 'bold 10px sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(p.t === 'enemy' ? '!' : p.t === 'loot' ? '$' : '▼', p.x, py);
      ctx.globalAlpha = 1;
    }
  }

  /** 画面外の仲間・ピンを画面端の矢印で示す。ダウン中の仲間は SOS */
  private drawAllyIndicators(view: ViewState, localId: number, fx: Effects): void {
    const { ctx, w, h } = this;
    const me = view.players.find((p) => p.id === localId);
    const margin = 46;
    const edge = (wx: number, wy: number): { x: number; y: number; ang: number; off: boolean } => {
      const sx = wx - this.cam.x + w / 2;
      const sy = wy - this.cam.y + h / 2;
      const off = sx < 20 || sy < 20 || sx > w - 20 || sy > h - 20;
      // HUD（上のチーム一覧・時計・ミニマップ、下のホットバー・ステータス）を避けた安全な矩形
      const top = 240;
      const bottom = h - 175;
      const left = margin;
      const right = w - margin;
      const cx = w / 2;
      const cy = (top + bottom) / 2;
      const ang = Math.atan2(sy - cy, sx - cx);
      const kx = ((right - left) / 2) / Math.max(1e-3, Math.abs(Math.cos(ang)));
      const ky = ((bottom - top) / 2) / Math.max(1e-3, Math.abs(Math.sin(ang)));
      const k = Math.min(kx, ky);
      return { x: cx + Math.cos(ang) * k, y: cy + Math.sin(ang) * k, ang, off };
    };
    for (const p of view.players) {
      if (p.id === localId || p.status === 'dead') continue;
      const e = edge(p.x, p.y);
      const down = p.status === 'down';
      if (!e.off && !down) continue;
      const col = PLAYER_COLORS[p.id] ?? '#fff';
      const dist = me ? Math.round(Math.hypot(p.x - me.x, p.y - me.y) / TILE) : 0;
      if (e.off) {
        ctx.save();
        ctx.translate(e.x, e.y);
        const pulse = down ? 1 + Math.sin(this.time * 8) * 0.15 : 1;
        ctx.scale(pulse, pulse);
        ctx.rotate(e.ang);
        ctx.fillStyle = down ? '#b03a2e' : col;
        ctx.beginPath();
        ctx.moveTo(22, 0);
        ctx.lineTo(10, -8);
        ctx.lineTo(10, 8);
        ctx.closePath();
        ctx.fill();
        ctx.restore();
        ctx.fillStyle = 'rgba(10,12,16,0.8)';
        ctx.beginPath();
        ctx.arc(e.x, e.y, 14, 0, Math.PI * 2);
        ctx.fill();
        ctx.strokeStyle = down ? '#b03a2e' : col;
        ctx.lineWidth = 2;
        ctx.stroke();
        ctx.font = 'bold 11px "Segoe UI", sans-serif';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillStyle = down ? '#c98070' : col;
        ctx.fillText(down ? 'SOS' : p.name.slice(0, 2), e.x, e.y);
        ctx.font = 'bold 10px "Segoe UI", sans-serif';
        ctx.lineWidth = 3;
        ctx.strokeStyle = 'rgba(0,0,0,0.8)';
        const label = down ? `${p.name} 助けて！ ${Math.ceil(p.downTimer)}s` : `${p.name} ${dist}m`;
        ctx.strokeText(label, e.x, e.y + 24);
        ctx.fillStyle = '#fff';
        ctx.fillText(label, e.x, e.y + 24);
      } else {
        // 画面内のダウン中の仲間：頭上に大きな SOS
        const sx = p.x - this.cam.x + w / 2;
        const sy = p.y - this.cam.y + h / 2 - 60;
        const pulse = 0.7 + Math.sin(this.time * 8) * 0.3;
        ctx.font = '900 16px "Segoe UI", sans-serif';
        ctx.textAlign = 'center';
        ctx.lineWidth = 4;
        ctx.strokeStyle = 'rgba(0,0,0,0.8)';
        ctx.strokeText('SOS [E]で蘇生', sx, sy);
        ctx.fillStyle = `rgba(255,90,90,${pulse})`;
        ctx.fillText('SOS [E]で蘇生', sx, sy);
      }
    }
    // 画面外のピン
    for (const p of fx.pings) {
      const e = edge(p.x, p.y);
      if (!e.off) continue;
      const col = p.t === 'enemy' ? '#c0573e' : p.t === 'loot' ? '#c9a85a' : (PLAYER_COLORS[p.id] ?? '#fff');
      ctx.globalAlpha = Math.min(1, p.life);
      ctx.save();
      ctx.translate(e.x, e.y);
      ctx.rotate(e.ang);
      ctx.strokeStyle = col;
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.moveTo(4, -7);
      ctx.lineTo(14, 0);
      ctx.lineTo(4, 7);
      ctx.stroke();
      ctx.restore();
      ctx.font = 'bold 10px "Segoe UI", sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillStyle = col;
      ctx.fillText(p.t === 'enemy' ? '敵！' : p.t === 'loot' ? '物資' : 'ここ', e.x, e.y - 14);
      ctx.globalAlpha = 1;
    }
  }

  private drawClock(view: ViewState, me?: PlayerSnap): void {
    const { ctx, w } = this;
    const pw = 300;
    const x = w - pw - 12;
    const cxm = x + pw / 2;
    panel(ctx, x, 10, pw, 66);
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    const icon = view.phase === 'day' ? '☀' : '☾';
    const label = view.phase === 'day' ? '昼' : '夜';
    ctx.font = '900 22px "Segoe UI", sans-serif';
    ctx.fillStyle = view.phase === 'night' ? '#aab4c8' : '#e0cfa8';
    ctx.fillText(`Day ${view.day} - ${formatClock(view.minute)}  ${icon} ${label}`, cxm, 16);

    // 時間バー（昼=黄 / 夜=青）
    const bx = x + 16;
    const bw = pw - 32;
    const by = 44;
    const dayFrac = DAY_SECONDS / CYCLE_SECONDS;
    ctx.fillStyle = '#6b5a2a';
    ctx.fillRect(bx, by, bw * dayFrac, 4);
    ctx.fillStyle = '#26305a';
    ctx.fillRect(bx + bw * dayFrac, by, bw * (1 - dayFrac), 4);
    const m = view.minute;
    const cyc = m >= 360 && m < 1200 ? ((m - 360) / 840) * dayFrac : dayFrac + (((m - 1200 + 1440) % 1440) / 600) * (1 - dayFrac);
    ctx.fillStyle = '#fff';
    ctx.fillRect(bx + bw * clamp(cyc, 0, 1) - 1, by - 3, 3, 10);

    // 現在地の危険度
    ctx.font = 'bold 12px "Segoe UI", sans-serif';
    let sub = '野外';
    let col = '#c3cbe0';
    if (me) {
      const loc = locationAt(this.world.locations, Math.floor(me.x / TILE), Math.floor(me.y / TILE));
      if (loc?.kind === 'base') {
        sub = '拠点（安全地帯）— 焚き火のそばで回復';
        col = '#9fc48a';
      } else if (loc) {
        sub = `${loc.name}  ${'★'.repeat(loc.tier)}${loc.tier >= 3 ? ' 危険' : ''}`;
        col = loc.tier >= 3 ? '#c98070' : loc.tier === 2 ? '#d8b870' : '#c3cbe0';
      } else if (view.phase === 'night') {
        sub = '野外（夜は徘徊者が増える）';
      }
    }
    ctx.fillStyle = col;
    ctx.fillText(sub, cxm, 54);
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
      ctx.fillText(`☠${p.kills}  ▣${p.bag.filter((b) => b).length}/${p.bag.length}`, x + pw - 10, y + 3);
      const bw = pw - 36;
      ctx.fillStyle = 'rgba(255,255,255,0.1)';
      ctx.fillRect(x + 24, y + 19, bw, 5);
      ctx.fillRect(x + 24, y + 27, bw, 3);
      if (p.status === 'alive') {
        ctx.fillStyle = color;
        ctx.fillRect(x + 24, y + 19, bw * clamp(p.hp / p.maxHp, 0, 1), 5);
        ctx.fillStyle = '#b08a50';
        ctx.fillRect(x + 24, y + 27, bw * clamp(p.hunger / 100, 0, 1), 3);
      } else if (p.status === 'down') {
        ctx.fillStyle = '#b4483a';
        ctx.fillRect(x + 24, y + 19, bw * clamp(p.downTimer / PLAYER.downTime, 0, 1), 5);
        ctx.font = 'bold 10px sans-serif';
        ctx.fillStyle = '#c98a80';
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
    const ph = 132;
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
    bar('HP', y + 10, hr, hr > 0.5 ? '#7fa35e' : hr > 0.25 ? '#c9a85a' : '#c0573e', `${Math.max(0, Math.ceil(me.hp))} / ${me.maxHp}`);
    const st = me.stamina / PLAYER.maxStamina;
    bar('体力', y + 26, st, st >= PLAYER.dashStamina / PLAYER.maxStamina ? '#6f93b0' : '#2d5a8a', me.stamina >= PLAYER.dashStamina && me.dashCd <= 0 ? 'スタミナ  DASH OK [Shift]' : 'スタミナ');
    // ダッシュに必要な量の目盛り
    ctx.fillStyle = 'rgba(255,255,255,0.5)';
    ctx.fillRect(x + 46 + (pw - 58) * (PLAYER.dashStamina / PLAYER.maxStamina), y + 26, 1, 10);
    bar('空腹', y + 42, me.hunger / 100, me.hunger > 25 ? '#b08a50' : '#c0573e', `${Math.ceil(me.hunger)}%`);

    // 装備と持ち物の要約
    const held = heldWeapon({ ...me, tool: Tool.Primary }) ?? null;
    const side = heldWeapon({ ...me, tool: Tool.Secondary }) ?? null;
    const wtxt = (s: typeof held, label: string, iy: number) => {
      ctx.font = '10px "Segoe UI", sans-serif';
      ctx.fillStyle = '#8f9bb3';
      ctx.fillText(label, x + 10, iy);
      ctx.font = 'bold 12px "Segoe UI", sans-serif';
      if (!s) {
        ctx.fillStyle = '#6f7a90';
        ctx.fillText('—', x + 46, iy);
        return;
      }
      const st = effectiveStats(s.id, s.w);
      const mods = (['scope', 'suppressor', 'extmag', 'grip'] as const).filter((a) => s.w[a]).length;
      ctx.fillStyle = '#e6dcc0';
      ctx.fillText(`${ITEMS[s.id].name}${mods ? ` +${mods}` : ''}`, x + 46, iy);
      ctx.textAlign = 'right';
      ctx.fillStyle = s.w.mag === 0 ? '#c06a5a' : '#c9a85a';
      ctx.fillText(`${s.w.mag}/${countItem(me.bag, st.ammo)}`, x + pw - 10, iy);
      ctx.textAlign = 'left';
    };
    wtxt(held, 'メイン', y + 66);
    wtxt(side, 'サブ', y + 84);
    const used = me.bag.filter((b) => b).length;
    ctx.font = '10px "Segoe UI", sans-serif';
    ctx.fillStyle = '#8f9bb3';
    ctx.fillText('バッグ', x + 10, y + 102);
    for (let i = 0; i < me.bag.length; i++) {
      ctx.fillStyle = me.bag[i] ? '#b8a878' : 'rgba(255,255,255,0.12)';
      ctx.fillRect(x + 46 + i * 9, y + 98, 7, 8);
    }
    ctx.textAlign = 'right';
    ctx.fillStyle = used >= me.bag.length ? '#c06a5a' : '#c3cbe0';
    ctx.font = 'bold 10px "Segoe UI", sans-serif';
    ctx.fillText(`${used}/${me.bag.length}`, x + pw - 10, y + 102);
    ctx.textAlign = 'left';
    ctx.font = '9px "Segoe UI", sans-serif';
    ctx.fillStyle = '#6f7a90';
    ctx.fillText('[F]探索/ドア [Tab]持ち物 [R]リロード [C]クラフト [Q]食事 [H]回復', x + 10, y + ph - 7);
    void view;
  }

  private drawHotbar(o: RenderOptions, view: ViewState): void {
    const { ctx, w, h } = this;
    const me = view.players.find((p) => p.id === o.localId);
    const size = 50;
    const gap = 5;
    const total = SLOTS.length * size + (SLOTS.length - 1) * gap;
    const x0 = w / 2 - total / 2;
    const y = h - size - 14;
    SLOTS.forEach((t, i) => {
      const x = x0 + i * (size + gap);
      const sel = o.localTool === t.id;
      const usable = i < USABLE_SLOTS;
      panel(ctx, x, y, size, size, sel ? 'rgba(60,90,130,0.92)' : usable ? undefined : 'rgba(10,12,16,0.4)');
      if (sel) {
        ctx.strokeStyle = '#9fb4c2';
        ctx.lineWidth = 2;
        roundRectPath(ctx, x + 1, y + 1, size - 2, size - 2, 7);
        ctx.stroke();
      }
      ctx.font = 'bold 10px "Segoe UI", sans-serif';
      ctx.textAlign = 'left';
      ctx.textBaseline = 'top';
      ctx.fillStyle = usable ? '#ffffff' : 'rgba(255,255,255,0.3)';
      ctx.fillText(t.key, x + 5, y + 4);
      if (!usable || !me) return;
      let label = '';
      let warn = false;
      let locked = false;
      const cx = x + size / 2;
      const cy = y + size / 2 - 3;
      switch (t.id) {
        case Tool.Melee:
          drawSlotIcon(ctx, 'axe', cx, cy);
          label = '斧';
          break;
        case Tool.Primary:
        case Tool.Secondary: {
          const s = heldWeapon({ ...me, tool: t.id });
          locked = !s;
          const icon = !s ? (t.id === Tool.Primary ? 'rifle' : 'pistol') : s.id === 'pistol' ? 'pistol' : s.id === 'shotgun' ? 'shotgun' : 'rifle';
          drawSlotIcon(ctx, icon, cx, cy, locked);
          if (s) {
            label = `${s.w.mag}/${countItem(me.bag, effectiveStats(s.id, s.w).ammo)}`;
            warn = s.w.mag === 0;
          } else label = 'なし';
          break;
        }
        case Tool.Meds: {
          const n = countItem(me.bag, 'bandage') + countItem(me.bag, 'medkit');
          drawSlotIcon(ctx, 'medkit', cx, cy, n <= 0);
          label = `×${n}`;
          warn = n <= 0;
          break;
        }
        case Tool.Food: {
          const n = countItem(me.bag, 'can') + countItem(me.bag, 'mre');
          drawSlotIcon(ctx, 'food', cx, cy, n <= 0);
          label = `×${n}`;
          warn = n <= 0;
          break;
        }
      }
      ctx.textAlign = 'center';
      ctx.font = 'bold 9px "Segoe UI", sans-serif';
      ctx.fillStyle = locked ? '#7d8597' : warn ? '#c06a5a' : '#dfe6f3';
      ctx.fillText(label, x + size / 2, y + size - 12);
    });

    const cur = SLOTS[o.localTool];
    if (cur && me) {
      ctx.font = 'bold 12px "Segoe UI", sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'bottom';
      ctx.fillStyle = '#e6ebf5';
      const s = heldWeapon({ ...me, tool: o.localTool });
      const name: string = s ? ITEMS[s.id].name : cur.name;
      ctx.fillText(`${name}  （1〜5 / ホイールで切替）`, w / 2, y - 6);
    }
    void view;
  }

  private drawMinimap(view: ViewState, localId: number): void {
    const { ctx } = this;
    if (!this.miniCanvas) return;
    const s = 2.2;
    const mw = MAP_W * s;
    const mh = MAP_H * s;
    const mx = this.w - mw - 12;
    const my = 86;
    panel(ctx, mx - 4, my - 4, mw + 8, mh + 8);
    ctx.drawImage(this.miniCanvas, mx, my, mw, mh);
    // ロケーション（★の数で危険度）
    for (const loc of this.world.locations) {
      if (loc.kind === 'ruin') continue;
      const col = loc.tier >= 3 ? '#c06050' : loc.tier === 2 ? '#c9a85a' : '#9fe08a';
      ctx.strokeStyle = col;
      ctx.lineWidth = 1;
      ctx.strokeRect(mx + loc.x * s - 1, my + loc.y * s - 1, loc.w * s + 2, loc.h * s + 2);
      ctx.font = 'bold 8px "Segoe UI", sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'bottom';
      ctx.fillStyle = col;
      ctx.fillText('★'.repeat(loc.tier), mx + (loc.x + loc.w / 2) * s, my + loc.y * s - 1);
    }
    const k = s / TILE;
    for (const ob of this.world.objects.values()) {
      let c: string | null = null;
      if (ob.kind === 'woodWall') c = '#c08a50';
      else if (ob.kind === 'ironWall') c = '#b8c4d4';
      else if (ob.kind === 'stone') c = '#9a968f';
      else if (ob.kind === 'spike') c = '#8a6a3a';
      else if (ob.kind === 'campfire' || ob.kind === 'torch') c = '#c88a4a';
      else if (ob.kind === 'bag') c = '#e0d090';
      else if (ob.kind === 'mcrate' && ob.ready) c = '#c98a50';
      else if (ob.kind === 'bench' || ob.kind === 'chest' || ob.kind === 'stash') c = '#c9a85a';
      else if (ob.kind === 'turret') c = '#9fb4c2';
      else if (ob.kind === 'barbed') c = '#8a8f96';
      if (!c) continue;
      ctx.fillStyle = c;
      ctx.fillRect(mx + ob.tx * s, my + ob.ty * s, s, s);
    }
    for (const z of view.zombies) {
      if (!this.vision.isVisible(z.x, z.y)) continue;
      ctx.fillStyle = z.alert === 2 ? '#e05a40' : z.alert === 1 ? '#c9a050' : '#a05050';
      ctx.fillRect(mx + z.x * k - 1, my + z.y * k - 1, 2, 2);
    }
    for (const p of view.players) {
      if (p.status === 'dead') continue;
      ctx.fillStyle = PLAYER_COLORS[p.id];
      ctx.beginPath();
      ctx.arc(mx + p.x * k, my + p.y * k, p.id === localId ? 3.5 : 2.5, 0, Math.PI * 2);
      ctx.fill();
      if (p.status === 'down') {
        ctx.strokeStyle = '#b4483a';
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.arc(mx + p.x * k, my + p.y * k, 6 + Math.sin(this.time * 8) * 1.5, 0, Math.PI * 2);
        ctx.stroke();
      }
    }
    if (this.fx) {
      for (const p of this.fx.pings) {
        ctx.strokeStyle = p.t === 'enemy' ? '#c0573e' : p.t === 'loot' ? '#c9a85a' : '#ffffff';
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.arc(mx + p.x * k, my + p.y * k, 4 + Math.sin(this.time * 6) * 1.5, 0, Math.PI * 2);
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
function drawSlotIcon(ctx: CanvasRenderingContext2D, kind: 'axe' | 'pistol' | 'rifle' | 'shotgun' | 'food' | 'medkit', x: number, y: number, dim = false): void {
  ctx.save();
  ctx.translate(x, y);
  if (dim) ctx.globalAlpha = 0.35;
  ctx.lineCap = 'round';
  switch (kind) {
    case 'axe':
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
    case 'pistol':
      ctx.fillStyle = '#cfd6df';
      ctx.fillRect(-11, -6, 20, 6);
      ctx.fillRect(-11, -6, 6, 13);
      ctx.fillStyle = '#7a8594';
      ctx.fillRect(-4, 0, 3, 4);
      break;
    case 'rifle':
      ctx.fillStyle = '#cfd6df';
      ctx.fillRect(-15, -4, 30, 5);
      ctx.fillStyle = '#8a6a48';
      ctx.fillRect(-17, -4, 7, 8);
      ctx.fillStyle = '#7a8594';
      ctx.fillRect(-2, 1, 4, 8);
      ctx.fillRect(8, -6, 3, 2);
      break;
    case 'shotgun':
      ctx.fillStyle = '#9aa3ad';
      ctx.fillRect(-12, -5, 28, 3);
      ctx.fillRect(-12, -2, 24, 3);
      ctx.fillStyle = '#8a5c33';
      ctx.fillRect(-18, -4, 9, 8);
      ctx.fillRect(0, 1, 7, 3);
      if (dim) {
        ctx.globalAlpha = 1;
        ctx.fillStyle = '#c3cbe0';
        ctx.fillRect(-5, -2, 10, 8);
        ctx.strokeStyle = '#c3cbe0';
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.arc(0, -3, 4, Math.PI, 0);
        ctx.stroke();
      }
      break;
    case 'food':
      ctx.fillStyle = '#b8c2cc';
      ctx.fillRect(-7, -9, 14, 18);
      ctx.fillStyle = '#d9534f';
      ctx.fillRect(-7, -4, 14, 8);
      ctx.fillStyle = '#d8c48a';
      ctx.fillRect(-4, -2, 8, 4);
      break;
    case 'medkit':
      ctx.fillStyle = '#e8edf2';
      ctx.fillRect(-10, -8, 20, 16);
      ctx.fillStyle = '#d9534f';
      ctx.fillRect(-2, -6, 4, 12);
      ctx.fillRect(-6, -2, 12, 4);
      break;
  }
  ctx.restore();
}


/** マップ外の森（繰り返しパターン） */
function makeForestPattern(ctx: CanvasRenderingContext2D): CanvasPattern {
  const c = document.createElement('canvas');
  c.width = 160;
  c.height = 160;
  const g = c.getContext('2d')!;
  g.fillStyle = '#12200f';
  g.fillRect(0, 0, 160, 160);
  let seed = 7;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  for (let i = 0; i < 26; i++) {
    const x = rnd() * 160;
    const y = rnd() * 160;
    const r = 14 + rnd() * 16;
    for (const [dx, dy] of [[0, 0], [160, 0], [-160, 0], [0, 160], [0, -160]]) {
      g.fillStyle = 'rgba(0,0,0,0.35)';
      g.beginPath();
      g.arc(x + dx + 6, y + dy + 8, r, 0, Math.PI * 2);
      g.fill();
      g.fillStyle = ['#1a3218', '#203a1c', '#16291a'][i % 3];
      g.beginPath();
      g.arc(x + dx, y + dy, r, 0, Math.PI * 2);
      g.fill();
      g.fillStyle = 'rgba(90,130,70,0.18)';
      g.beginPath();
      g.arc(x + dx - r * 0.3, y + dy - r * 0.3, r * 0.45, 0, Math.PI * 2);
      g.fill();
    }
  }
  return ctx.createPattern(c, 'repeat')!;
}

/** フィルムグレイン用のノイズパターン */
function makeGrain(ctx: CanvasRenderingContext2D): CanvasPattern {
  const c = document.createElement('canvas');
  c.width = 256;
  c.height = 256;
  const g = c.getContext('2d')!;
  const img = g.createImageData(256, 256);
  for (let i = 0; i < 256 * 256; i++) {
    const v = Math.floor(Math.random() * 255);
    img.data[i * 4] = v;
    img.data[i * 4 + 1] = v;
    img.data[i * 4 + 2] = v;
    img.data[i * 4 + 3] = 255;
  }
  g.putImageData(img, 0, 0);
  return ctx.createPattern(c, 'repeat')!;
}
