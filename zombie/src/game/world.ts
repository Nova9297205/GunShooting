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
  locations: Location[] = [];
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
    // 始点・終点のタイル自体（タレットや壁際のゾンビ）は判定しない
    const sx = Math.floor(x1 / TILE);
    const sy = Math.floor(y1 / TILE);
    const ex = Math.floor(x2 / TILE);
    const ey = Math.floor(y2 / TILE);
    for (let i = 1; i < steps; i++) {
      const t = i / steps;
      const tx = Math.floor((x1 + (x2 - x1) * t) / TILE);
      const ty = Math.floor((y1 + (y2 - y1) * t) / TILE);
      if ((tx === sx && ty === sy) || (tx === ex && ty === ey)) continue;
      if (this.blocksSight(tx, ty)) return false;
    }
    return true;
  }
}

// ---------------- マップ生成 ----------------

/** 名前付きロケーション（探索先）。tier が高いほど遠く危険でレア物資が出る */
export interface Location {
  name: string;
  kind: 'house' | 'gas' | 'police' | 'military' | 'ruin';
  x: number;
  y: number;
  w: number;
  h: number;
  tier: number;
}

export interface GeneratedWorld {
  terrain: Uint8Array;
  objs: ObjSnap[];
  locations: Location[];
}

export function generateTerrain(seed: number): { terrain: Uint8Array; locations: Location[] } {
  const g = generateWorld(seed);
  return { terrain: g.terrain, locations: g.locations };
}

/** タイルがどのロケーションに含まれるか */
export function locationAt(locs: Location[], tx: number, ty: number): Location | null {
  for (const l of locs) if (tx >= l.x && ty >= l.y && tx < l.x + l.w && ty < l.y + l.h) return l;
  return null;
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

  // ---- 名前付きロケーション（中心から遠いほど高ランク） ----
  const locations: Location[] = [];
  const overlapsLoc = (x: number, y: number, w: number, h: number, m: number) =>
    locations.some((r) => x < r.x + r.w + m && x + w + m > r.x && y < r.y + r.h + m && y + h + m > r.y);
  /** 建物を刻む：外周を壁、内側を床。崩れた壁と入口を作る */
  const building = (x: number, y: number, w: number, h: number, broken: number, doors: number, part: boolean) => {
    for (let yy = y; yy < y + h; yy++)
      for (let xx = x; xx < x + w; xx++) {
        const edge = xx === x || yy === y || xx === x + w - 1 || yy === y + h - 1;
        setT(xx, yy, edge && rnd() > broken ? T_WALL : T_FLOOR);
      }
    for (let d = 0; d < doors; d++) {
      const side = d % 4 === 0 ? ri(0, 3) : (d + ri(0, 3)) % 4;
      const p = side < 2 ? ri(x + 1, x + w - 3) : ri(y + 1, y + h - 3);
      for (let k = 0; k < 2; k++) {
        if (side === 0) setT(p + k, y, T_FLOOR);
        if (side === 1) setT(p + k, y + h - 1, T_FLOOR);
        if (side === 2) setT(x, p + k, T_FLOOR);
        if (side === 3) setT(x + w - 1, p + k, T_FLOOR);
      }
    }
    if (part && w >= 7) {
      const mx = x + Math.floor(w / 2);
      const gap = y + 1 + ri(0, h - 4);
      for (let yy = y + 1; yy < y + h - 1; yy++) if (yy !== gap && yy !== gap + 1) setT(mx, yy, T_WALL);
    }
  };
  const fillCrates = (x: number, y: number, w: number, h: number, n: number, kind: ObjKind) => {
    for (let i = 0, tries = 0; i < n && tries < 40; tries++) {
      const cx = ri(x + 1, x + w - 2);
      const cy = ri(y + 1, y + h - 2);
      if (terrain[idx(cx, cy)] !== T_FLOOR || occupied[idx(cx, cy)]) continue;
      addObj(kind, cx, cy);
      i++;
    }
  };

  // 警察署（北東の角・★★★）
  {
    const w = 13;
    const h = 9;
    const x = ri(MAP_W - w - 6, MAP_W - w - 3);
    const y = ri(3, 5);
    building(x, y, w, h, 0.08, 3, true);
    for (let xx = x + 1; xx < x + w - 1; xx++) if (xx !== x + 3 && xx !== x + 4) setT(xx, y + 4, T_WALL);
    locations.push({ name: '警察署', kind: 'police', x, y, w, h, tier: 3 });
    fillCrates(x, y, w, h, 4, 'mcrate');
  }
  // 軍の野営地（南西の角・★★★）：フェンスで囲まれた敷地と土嚢
  {
    const w = 15;
    const h = 11;
    const x = ri(3, 6);
    const y = ri(MAP_H - h - 5, MAP_H - h - 3);
    building(x, y, w, h, 0.25, 3, false);
    for (let yy = y + 1; yy < y + h - 1; yy++) for (let xx = x + 1; xx < x + w - 1; xx++) setT(xx, yy, T_DIRT);
    // テント（小さな建物）
    building(x + 2, y + 2, 4, 3, 0, 1, false);
    building(x + 9, y + 6, 4, 3, 0, 1, false);
    locations.push({ name: '軍の野営地', kind: 'military', x, y, w, h, tier: 3 });
    for (let i = 0; i < 6; i++) addObj('stone', x + 7 + (i % 3), y + 3 + Math.floor(i / 3) * 4);
    for (let i = 0, tries = 0; i < 5 && tries < 60; tries++) {
      const cx = ri(x + 1, x + w - 2);
      const cy = ri(y + 1, y + h - 2);
      if (terrain[idx(cx, cy)] === T_WALL || occupied[idx(cx, cy)]) continue;
      addObj('mcrate', cx, cy);
      i++;
    }
  }
  // ガソリンスタンド（幹線道路沿い・★★）
  {
    const east = rnd() < 0.5;
    const x = east ? ri(52, 58) : ri(12, 18);
    const y = roadY + 2;
    // 給油エリア（屋根の下の床）
    for (let yy = y; yy < y + 5; yy++) for (let xx = x; xx < x + 6; xx++) setT(xx, yy, T_FLOOR);
    building(x + 6, y, 5, 5, 0.05, 1, false);
    for (let yy = y + 1; yy < y + 4; yy++) setT(x + 6, yy, T_FLOOR); // 店の入口
    locations.push({ name: 'ガソリンスタンド', kind: 'gas', x, y, w: 11, h: 5, tier: 2 });
    fillCrates(x + 6, y, 5, 5, 2, 'crate');
    addObj('crate', x + 2, y + 2);
    addObj('car', x + 1, y + 1);
    addObj('car', x + 4, y + 3);
  }
  // 住宅跡（近場・★）
  const houseSpots = [
    [22, 15],
    [54, 44],
    [22, 44],
    [52, 13],
  ];
  for (const [hx, hy] of houseSpots) {
    for (let tries = 0; tries < 12; tries++) {
      const w = ri(7, 9);
      const h = ri(6, 7);
      const x = hx + ri(-4, 4) - Math.floor(w / 2);
      const y = hy + ri(-3, 3) - Math.floor(h / 2);
      if (x < 2 || y < 2 || x + w > MAP_W - 2 || y + h > MAP_H - 2) continue;
      if (nearSafehouse(x, y, 5) || nearSafehouse(x + w, y + h, 5) || overlapsLoc(x, y, w, h, 3)) continue;
      let road = 0;
      for (let yy = y; yy < y + h; yy++) for (let xx = x; xx < x + w; xx++) if (terrain[idx(xx, yy)] === T_ROAD) road++;
      if (road > 0 && tries < 11) continue;
      building(x, y, w, h, 0.12, 2, true);
      locations.push({ name: '住宅跡', kind: 'house', x, y, w, h, tier: 1 });
      fillCrates(x, y, w, h, 2, 'crate');
      break;
    }
  }
  // 名もない廃墟（ランダム）
  for (let attempt = 0, made = 0; attempt < 300 && made < 4; attempt++) {
    const w = ri(6, 9);
    const h = ri(5, 7);
    const x = ri(2, MAP_W - w - 3);
    const y = ri(2, MAP_H - h - 3);
    if (nearSafehouse(x, y, 6) || nearSafehouse(x + w, y + h, 6) || nearSafehouse(x + w, y, 6) || nearSafehouse(x, y + h, 6)) continue;
    if (overlapsLoc(x, y, w, h, 3)) continue;
    let onRoad = false;
    for (let yy = y; yy < y + h && !onRoad; yy++) for (let xx = x; xx < x + w; xx++) if (terrain[idx(xx, yy)] === T_ROAD) onRoad = true;
    if (onRoad) continue;
    building(x, y, w, h, 0.2, 2, rnd() < 0.5);
    const d = Math.hypot(x + w / 2 - 40, y + h / 2 - 30);
    locations.push({ name: '廃墟', kind: 'ruin', x, y, w, h, tier: d > 26 ? 2 : 1 });
    fillCrates(x, y, w, h, 1, 'crate');
    made++;
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
  addObj('bench', sh.x + 2, sh.y + sh.h - 3);

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
  for (let i = 0, placed = 0; i < 300 && placed < 6; i++) {
    const x = ri(2, MAP_W - 3);
    const y = ri(2, MAP_H - 3);
    const t = terrain[idx(x, y)];
    if ((t === T_GRASS || t === T_DIRT) && !nearSafehouse(x, y, 4)) {
      const before = objs.length;
      addObj('crate', x, y);
      if (objs.length > before) placed++;
    }
  }

  return { terrain, objs, locations };
}

/** オブジェクトIDの開始値（建築物用。生成オブジェクトと衝突しない値） */
export const BUILD_ID_START = 100000;
