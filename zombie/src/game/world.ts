// ============================================================
// タイルワールド（地形＋オブジェクト）とシード付きマップ生成
//   地形はシードから決定的に生成（ホスト・ゲストで同一）
//   オブジェクト（木・車・クレート・建築物）はホストが管理し差分同期
// ============================================================
import type { ObjKind, ObjSnap } from '../types';
import {
  BULLET_BLOCK_KINDS,
  CAMPFIRE_TILE,
  MAP_H,
  MAP_W,
  OBJ_HP,
  SAFEHOUSE,
  SOLID_KINDS,
  T_DIRT,
  T_FLOOR,
  T_GRASS,
  T_ROAD,
  T_WALL,
  TILE,
} from './constants';

export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** オブジェクトが「存在して」衝突するか（伐採済みの木・解体済みの車は通れる） */
export function objIsSolid(o: ObjSnap): boolean {
  if (!SOLID_KINDS.has(o.kind)) return false;
  if (o.kind === 'tree' || o.kind === 'car') return o.hp > 0;
  return true;
}

export class TileWorld<T extends ObjSnap = ObjSnap> {
  terrain: Uint8Array;
  objects = new Map<number, T>();
  private grid: Int32Array; // タイル → オブジェクトID（0 = なし）

  constructor(terrain: Uint8Array) {
    this.terrain = terrain;
    this.grid = new Int32Array(MAP_W * MAP_H);
  }

  inBounds(tx: number, ty: number): boolean {
    return tx >= 0 && ty >= 0 && tx < MAP_W && ty < MAP_H;
  }

  terrainAt(tx: number, ty: number): number {
    if (!this.inBounds(tx, ty)) return T_WALL;
    return this.terrain[ty * MAP_W + tx];
  }

  objAt(tx: number, ty: number): T | undefined {
    if (!this.inBounds(tx, ty)) return undefined;
    const id = this.grid[ty * MAP_W + tx];
    return id ? this.objects.get(id) : undefined;
  }

  setObj(o: T): void {
    const prev = this.objects.get(o.id);
    if (prev && (prev.tx !== o.tx || prev.ty !== o.ty)) this.grid[prev.ty * MAP_W + prev.tx] = 0;
    this.objects.set(o.id, o);
    this.grid[o.ty * MAP_W + o.tx] = o.id;
  }

  removeObj(id: number): void {
    const o = this.objects.get(id);
    if (!o) return;
    if (this.grid[o.ty * MAP_W + o.tx] === id) this.grid[o.ty * MAP_W + o.tx] = 0;
    this.objects.delete(id);
  }

  /** 移動を遮るタイルか */
  solid(tx: number, ty: number): boolean {
    if (!this.inBounds(tx, ty)) return true;
    if (this.terrain[ty * MAP_W + tx] === T_WALL) return true;
    const o = this.objAt(tx, ty);
    return !!o && objIsSolid(o);
  }

  /** プレイヤーの弾を止めるタイルか */
  blocksBullet(tx: number, ty: number): boolean {
    if (!this.inBounds(tx, ty)) return true;
    if (this.terrain[ty * MAP_W + tx] === T_WALL) return true;
    const o = this.objAt(tx, ty);
    return !!o && BULLET_BLOCK_KINDS.has(o.kind) && objIsSolid(o);
  }

  /** 視線を遮るか（廃墟の壁・建築壁・木・車） */
  blocksSight(tx: number, ty: number): boolean {
    return this.solid(tx, ty);
  }

  /** 2点間の視線チェック（サンプリング） */
  lineClear(x1: number, y1: number, x2: number, y2: number): boolean {
    const d = Math.hypot(x2 - x1, y2 - y1);
    const steps = Math.ceil(d / (TILE / 3));
    for (let i = 1; i < steps; i++) {
      const t = i / steps;
      const tx = Math.floor((x1 + (x2 - x1) * t) / TILE);
      const ty = Math.floor((y1 + (y2 - y1) * t) / TILE);
      if (this.blocksSight(tx, ty)) return false;
    }
    return true;
  }
}

// ---------------- マップ生成 ----------------

export interface GeneratedWorld {
  terrain: Uint8Array;
  objs: ObjSnap[];
}

export function generateTerrain(seed: number): Uint8Array {
  return generateWorld(seed).terrain;
}

export function generateWorld(seed: number): GeneratedWorld {
  const rnd = mulberry32(seed);
  const ri = (a: number, b: number) => a + Math.floor(rnd() * (b - a + 1));
  const terrain = new Uint8Array(MAP_W * MAP_H);
  const objs: ObjSnap[] = [];
  const occupied = new Uint8Array(MAP_W * MAP_H);
  let nextId = 1;
  const idx = (x: number, y: number) => y * MAP_W + x;
  const setT = (x: number, y: number, v: number) => {
    if (x >= 0 && y >= 0 && x < MAP_W && y < MAP_H) terrain[idx(x, y)] = v;
  };
  const addObj = (kind: ObjKind, tx: number, ty: number) => {
    if (tx < 1 || ty < 1 || tx >= MAP_W - 1 || ty >= MAP_H - 1) return;
    if (occupied[idx(tx, ty)] || terrain[idx(tx, ty)] === T_WALL) return;
    occupied[idx(tx, ty)] = 1;
    const hp = OBJ_HP[kind];
    objs.push({ id: nextId++, kind, tx, ty, hp, maxHp: hp, ready: 1 });
  };
  const sh = SAFEHOUSE;
  const nearSafehouse = (x: number, y: number, m: number) =>
    x >= sh.x - m && x < sh.x + sh.w + m && y >= sh.y - m && y < sh.y + sh.h + m;

  // 土のまだら模様
  for (let i = 0; i < 40; i++) {
    const cx = ri(0, MAP_W - 1);
    const cy = ri(0, MAP_H - 1);
    const r = ri(2, 5);
    for (let y = cy - r; y <= cy + r; y++)
      for (let x = cx - r; x <= cx + r; x++)
        if ((x - cx) ** 2 + (y - cy) ** 2 <= r * r && rnd() < 0.8) setT(x, y, T_DIRT);
  }

  // 道路（十字＋ランダム1本）
  const roadY = sh.y + Math.floor(sh.h / 2) - 1;
  const roadX = sh.x + Math.floor(sh.w / 2) - 1;
  for (let x = 0; x < MAP_W; x++) for (let k = 0; k < 2; k++) setT(x, roadY + k, T_ROAD);
  for (let y = 0; y < MAP_H; y++) for (let k = 0; k < 2; k++) setT(roadX + k, y, T_ROAD);
  const extraY = rnd() < 0.5 ? ri(6, 14) : ri(MAP_H - 15, MAP_H - 7);
  for (let x = 0; x < MAP_W; x++) for (let k = 0; k < 2; k++) setT(x, extraY + k, T_ROAD);
  const extraX = rnd() < 0.5 ? ri(8, 18) : ri(MAP_W - 19, MAP_W - 9);
  for (let y = 0; y < MAP_H; y++) for (let k = 0; k < 2; k++) setT(extraX + k, y, T_ROAD);

  // ---- 廃墟の建物 ----
  const ruins: { x: number; y: number; w: number; h: number }[] = [];
  for (let attempt = 0; attempt < 400 && ruins.length < 12; attempt++) {
    const w = ri(6, 11);
    const h = ri(5, 9);
    const x = ri(2, MAP_W - w - 3);
    const y = ri(2, MAP_H - h - 3);
    if (nearSafehouse(x, y, 6) || nearSafehouse(x + w, y + h, 6) || nearSafehouse(x + w, y, 6) || nearSafehouse(x, y + h, 6)) continue;
    if (ruins.some((r) => x < r.x + r.w + 3 && x + w + 3 > r.x && y < r.y + r.h + 3 && y + h + 3 > r.y)) continue;
    // 道路を塞がない
    let onRoad = false;
    for (let yy = y; yy < y + h && !onRoad; yy++)
      for (let xx = x; xx < x + w; xx++) if (terrain[idx(xx, yy)] === T_ROAD) { onRoad = true; break; }
    if (onRoad) continue;
    ruins.push({ x, y, w, h });
  }
  for (const r of ruins) {
    for (let yy = r.y; yy < r.y + r.h; yy++)
      for (let xx = r.x; xx < r.x + r.w; xx++) {
        const edge = xx === r.x || yy === r.y || xx === r.x + r.w - 1 || yy === r.y + r.h - 1;
        // 壁の一部は崩れている
        setT(xx, yy, edge && rnd() > 0.16 ? T_WALL : T_FLOOR);
      }
    // 入口を確実に2つ開ける
    for (let d = 0; d < 2; d++) {
      const side = ri(0, 3);
      const p = side < 2 ? ri(r.x + 1, r.x + r.w - 3) : ri(r.y + 1, r.y + r.h - 3);
      for (let k = 0; k < 2; k++) {
        if (side === 0) setT(p + k, r.y, T_FLOOR);
        if (side === 1) setT(p + k, r.y + r.h - 1, T_FLOOR);
        if (side === 2) setT(r.x, p + k, T_FLOOR);
        if (side === 3) setT(r.x + r.w - 1, p + k, T_FLOOR);
      }
    }
    // 内部の仕切り
    if (r.w >= 8 && rnd() < 0.6) {
      const mx = r.x + Math.floor(r.w / 2);
      for (let yy = r.y + 1; yy < r.y + r.h - 1; yy++) if (yy !== r.y + Math.floor(r.h / 2)) setT(mx, yy, T_WALL);
    }
    // 物資クレート
    const n = ri(1, 3);
    for (let i = 0; i < n; i++) addObj('crate', ri(r.x + 1, r.x + r.w - 2), ri(r.y + 1, r.y + r.h - 2));
  }

  // ---- セーフハウス ----
  for (let yy = sh.y; yy < sh.y + sh.h; yy++) for (let xx = sh.x; xx < sh.x + sh.w; xx++) setT(xx, yy, T_FLOOR);
  for (let yy = sh.y; yy < sh.y + sh.h; yy++)
    for (let xx = sh.x; xx < sh.x + sh.w; xx++) {
      const edge = xx === sh.x || yy === sh.y || xx === sh.x + sh.w - 1 || yy === sh.y + sh.h - 1;
      if (!edge) continue;
      // 入口（道路が通る位置）と壊れた区間は空ける
      const doorH = yy >= roadY - 1 && yy <= roadY + 2;
      const doorV = xx >= roadX - 1 && xx <= roadX + 2;
      if (doorH || doorV) continue;
      const broken = (xx + yy * 3) % 7 === 0;
      if (broken) continue;
      addObj('stone', xx, yy);
    }
  occupied[idx(CAMPFIRE_TILE.x, CAMPFIRE_TILE.y)] = 0;
  addObj('campfire', CAMPFIRE_TILE.x, CAMPFIRE_TILE.y);
  addObj('box', sh.x + 2, sh.y + 2);
  addObj('box', sh.x + sh.w - 3, sh.y + sh.h - 3);
  addObj('crate', sh.x + sh.w - 3, sh.y + 2);

  // ---- 廃車（道路沿い） ----
  let cars = 0;
  for (let attempt = 0; attempt < 600 && cars < 30; attempt++) {
    const x = ri(1, MAP_W - 2);
    const y = ri(1, MAP_H - 2);
    if (terrain[idx(x, y)] !== T_ROAD || nearSafehouse(x, y, 3)) continue;
    const before = objs.length;
    addObj('car', x, y);
    if (objs.length > before) cars++;
  }

  // ---- 森（木のクラスター） ----
  for (let c = 0; c < 22; c++) {
    const cx = ri(2, MAP_W - 3);
    const cy = ri(2, MAP_H - 3);
    if (nearSafehouse(cx, cy, 5)) continue;
    const n = ri(5, 14);
    for (let i = 0; i < n; i++) {
      const x = cx + ri(-4, 4);
      const y = cy + ri(-4, 4);
      if (x < 1 || y < 1 || x >= MAP_W - 1 || y >= MAP_H - 1) continue;
      const t = terrain[idx(x, y)];
      if ((t === T_GRASS || t === T_DIRT) && !nearSafehouse(x, y, 3)) addObj('tree', x, y);
    }
  }
  // ---- 野外のクレート ----
  for (let i = 0, placed = 0; i < 300 && placed < 10; i++) {
    const x = ri(2, MAP_W - 3);
    const y = ri(2, MAP_H - 3);
    const t = terrain[idx(x, y)];
    if ((t === T_GRASS || t === T_DIRT) && !nearSafehouse(x, y, 4)) {
      const before = objs.length;
      addObj('crate', x, y);
      if (objs.length > before) placed++;
    }
  }

  return { terrain, objs };
}

/** オブジェクトIDの開始値（建築物用。生成オブジェクトと衝突しない値） */
export const BUILD_ID_START = 100000;
