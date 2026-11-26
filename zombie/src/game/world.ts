// ============================================================
// タイルワールド（地形＋オブジェクト）とシード付きマップ生成
//   地形はシードから決定的に生成（ホスト・ゲストで同一）
//   建物は「外壁・内壁・ドア・ガラス窓・床材・家具」を持つ部屋割り構造
//   オブジェクト（ドア・家具・木・車など）はホストが管理し差分同期
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
  T_FENCE,
  T_FLOOR,
  T_GRASS,
  T_ROAD,
  T_TILE,
  T_WALL,
  T_WINDOW,
  T_WOOD,
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

/** オブジェクトが通行を妨げるか（開いたドア・伐採済みの木・解体済みの車は通れる） */
export function objIsSolid(o: ObjSnap): boolean {
  if (!SOLID_KINDS.has(o.kind)) return false;
  if (o.kind === 'tree' || o.kind === 'car') return o.hp > 0;
  if (o.kind === 'door') return o.ready === 0;
  return true;
}

/** 名前付きロケーション（探索先）。tier が高いほど遠く危険でレア物資が出る */
export interface Location {
  name: string;
  kind: 'house' | 'market' | 'hospital' | 'police' | 'military' | 'gas' | 'base' | 'ruin';
  x: number;
  y: number;
  w: number;
  h: number;
  tier: number;
  /** 汚染地帯（毎回ランダムに1か所） */
  hot?: boolean;
}

/** 屋根を持つ建物（中に入るまで屋根で覆う） */
export interface Building {
  x: number;
  y: number;
  w: number;
  h: number;
  /** 屋根の色の種類 */
  roof: number;
}

export class TileWorld<T extends ObjSnap = ObjSnap> {
  terrain: Uint8Array;
  locations: Location[] = [];
  buildings: Building[] = [];
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

  /** 移動を遮るタイルか（壁・窓・フェンス・閉じたドア・家具） */
  solid(tx: number, ty: number): boolean {
    if (!this.inBounds(tx, ty)) return true;
    const t = this.terrain[ty * MAP_W + tx];
    if (t === T_WALL || t === T_WINDOW || t === T_FENCE) return true;
    const o = this.objAt(tx, ty);
    return !!o && objIsSolid(o);
  }

  /** 弾を止めるタイルか（窓・フェンス越しには撃てる） */
  blocksBullet(tx: number, ty: number): boolean {
    if (!this.inBounds(tx, ty)) return true;
    if (this.terrain[ty * MAP_W + tx] === T_WALL) return true;
    const o = this.objAt(tx, ty);
    return !!o && BULLET_BLOCK_KINDS.has(o.kind) && objIsSolid(o);
  }

  /** 視線を遮るか（壁と閉じたドアだけ。窓・フェンス・家具越しには見える） */
  blocksSight(tx: number, ty: number): boolean {
    if (!this.inBounds(tx, ty)) return true;
    if (this.terrain[ty * MAP_W + tx] === T_WALL) return true;
    const o = this.objAt(tx, ty);
    return !!o && o.kind === 'door' && o.ready === 0;
  }

  /** 2点間の視線チェック（サンプリング） */
  lineClear(x1: number, y1: number, x2: number, y2: number): boolean {
    const d = Math.hypot(x2 - x1, y2 - y1);
    const steps = Math.ceil(d / (TILE / 3));
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

  /** タイルが屋内か（屋根の下） */
  buildingAt(tx: number, ty: number): Building | null {
    for (const b of this.buildings) if (tx > b.x && ty > b.y && tx < b.x + b.w - 1 && ty < b.y + b.h - 1) return b;
    return null;
  }
}

/** タイルがどのロケーションに含まれるか */
export function locationAt(locs: Location[], tx: number, ty: number): Location | null {
  for (const l of locs) if (tx >= l.x && ty >= l.y && tx < l.x + l.w && ty < l.y + l.h) return l;
  return null;
}

// ============================================================
// マップ生成
// ============================================================

export interface GeneratedWorld {
  terrain: Uint8Array;
  objs: ObjSnap[];
  locations: Location[];
  buildings: Building[];
}

export function generateTerrain(seed: number): { terrain: Uint8Array; locations: Location[]; buildings: Building[] } {
  const g = generateWorld(seed);
  return { terrain: g.terrain, locations: g.locations, buildings: g.buildings };
}

type BuildingKind = Location['kind'];

/** 建物の種類ごとの家具の出現表 [種類, 重み] */
const PROPS: Record<string, [ObjKind, number][]> = {
  house: [['shelf', 3], ['bed', 2], ['fridge', 1], ['desk', 2], ['locker', 2], ['cabinet', 1], ['crate', 1]],
  market: [['shelf', 6], ['fridge', 3], ['crate', 2], ['desk', 1]],
  hospital: [['bed', 4], ['cabinet', 4], ['desk', 2], ['locker', 2], ['shelf', 1]],
  police: [['locker', 4], ['desk', 3], ['wcase', 2], ['cabinet', 1], ['shelf', 1]],
  military: [['wcase', 3], ['locker', 3], ['mcrate', 3], ['crate', 2], ['bed', 1]],
  gas: [['shelf', 4], ['fridge', 2], ['desk', 1], ['crate', 1]],
  base: [],
  ruin: [['crate', 2], ['shelf', 1], ['rubble', 3]],
};

export function generateWorld(seed: number): GeneratedWorld {
  const rnd = mulberry32(seed);
  const ri = (a: number, b: number) => a + Math.floor(rnd() * (b - a + 1));
  const terrain = new Uint8Array(MAP_W * MAP_H);
  const objs: ObjSnap[] = [];
  const occupied = new Uint8Array(MAP_W * MAP_H);
  const reserved = new Uint8Array(MAP_W * MAP_H); // 建物・道路の予約
  const locations: Location[] = [];
  const buildings: Building[] = [];
  let nextId = 1;
  const idx = (x: number, y: number) => y * MAP_W + x;
  const inMap = (x: number, y: number) => x >= 0 && y >= 0 && x < MAP_W && y < MAP_H;
  const setT = (x: number, y: number, v: number) => {
    if (inMap(x, y)) terrain[idx(x, y)] = v;
  };
  const tAt = (x: number, y: number) => (inMap(x, y) ? terrain[idx(x, y)] : T_WALL);
  const addObj = (kind: ObjKind, tx: number, ty: number, ready = 1): ObjSnap | null => {
    if (tx < 1 || ty < 1 || tx >= MAP_W - 1 || ty >= MAP_H - 1) return null;
    if (occupied[idx(tx, ty)]) return null;
    const t = terrain[idx(tx, ty)];
    if (t === T_WALL || t === T_WINDOW || t === T_FENCE) return null;
    occupied[idx(tx, ty)] = 1;
    const hp = OBJ_HP[kind];
    const o: ObjSnap = { id: nextId++, kind, tx, ty, hp, maxHp: hp, ready };
    objs.push(o);
    return o;
  };
  const sh = SAFEHOUSE;

  // ---- 地面のまだら模様 ----
  for (let i = 0; i < 46; i++) {
    const cx = ri(0, MAP_W - 1);
    const cy = ri(0, MAP_H - 1);
    const r = ri(2, 6);
    for (let y = cy - r; y <= cy + r; y++)
      for (let x = cx - r; x <= cx + r; x++)
        if ((x - cx) ** 2 + (y - cy) ** 2 <= r * r && rnd() < 0.8) setT(x, y, T_DIRT);
  }

  // ---- 道路（十字＋北と南の横道＋東の縦道） ----
  const roadY = sh.y + Math.floor(sh.h / 2);
  const roadX = sh.x + Math.floor(sh.w / 2) - 1;
  const road = (x0: number, y0: number, x1: number, y1: number) => {
    for (let y = y0; y <= y1; y++)
      for (let x = x0; x <= x1; x++) {
        setT(x, y, T_ROAD);
        if (inMap(x, y)) reserved[idx(x, y)] = 1;
      }
  };
  road(0, roadY, MAP_W - 1, roadY + 1);
  road(roadX, 0, roadX + 1, MAP_H - 1);
  road(3, 18, MAP_W - 4, 19);
  road(3, 46, MAP_W - 4, 47);
  road(60, 0, 61, MAP_H - 1);

  const overlaps = (x: number, y: number, w: number, h: number, m: number) => {
    for (let yy = y - m; yy < y + h + m; yy++)
      for (let xx = x - m; xx < x + w + m; xx++) if (!inMap(xx, yy) || reserved[idx(xx, yy)]) return true;
    return false;
  };
  const reserve = (x: number, y: number, w: number, h: number) => {
    for (let yy = y; yy < y + h; yy++) for (let xx = x; xx < x + w; xx++) if (inMap(xx, yy)) reserved[idx(xx, yy)] = 1;
  };
  /** 目標地点の近くで空いている場所を探す */
  const findSpot = (cx: number, cy: number, w: number, h: number, spread: number): { x: number; y: number } | null => {
    for (let r = 0; r <= spread; r++)
      for (let t = 0; t < 16; t++) {
        const x = cx - Math.floor(w / 2) + ri(-r, r);
        const y = cy - Math.floor(h / 2) + ri(-r, r);
        if (x < 2 || y < 2 || x + w > MAP_W - 2 || y + h > MAP_H - 2) continue;
        if (!overlaps(x, y, w, h, 1)) return { x, y };
      }
    // 近くに空きがなければ、地図全体から目標にいちばん近い空き地を探す（拠点のすぐそばは避ける）
    let best: { x: number; y: number } | null = null;
    let bd = Infinity;
    for (let y = 2; y + h <= MAP_H - 2; y++)
      for (let x = 2; x + w <= MAP_W - 2; x++) {
        const d = (x + w / 2 - cx) ** 2 + (y + h / 2 - cy) ** 2;
        if (d >= bd || Math.hypot(x + w / 2 - 40, y + h / 2 - 30) < 13) continue;
        if (!overlaps(x, y, w, h, 1)) {
          bd = d;
          best = { x, y };
        }
      }
    return best;
  };

  // ---- 建物を刻む：外壁・BSPで部屋割り・内壁のドア・外のドア・窓・家具 ----
  const makeBuilding = (
    x: number,
    y: number,
    w: number,
    h: number,
    kind: BuildingKind,
    floor: number,
    opts: { minRoom?: number; windows?: number; doors?: number; propRate?: number; roof?: number } = {},
  ) => {
    reserve(x - 1, y - 1, w + 2, h + 2);
    buildings.push({ x, y, w, h, roof: opts.roof ?? ri(0, 3) });
    for (let yy = y; yy < y + h; yy++)
      for (let xx = x; xx < x + w; xx++) {
        const edge = xx === x || yy === y || xx === x + w - 1 || yy === y + h - 1;
        setT(xx, yy, edge ? T_WALL : floor);
      }
    const doorTiles: [number, number][] = [];
    // BSPで部屋を分割（内壁には必ずドアを1つ）
    const rooms: { x: number; y: number; w: number; h: number }[] = [];
    const minRoom = opts.minRoom ?? 4;
    const split = (rx: number, ry: number, rw: number, rh: number, depth: number) => {
      const canV = rw >= minRoom * 2 + 1;
      const canH = rh >= minRoom * 2 + 1;
      if (depth > 3 || (!canV && !canH) || (depth > 0 && rnd() < 0.2)) {
        rooms.push({ x: rx, y: ry, w: rw, h: rh });
        return;
      }
      const vertical = canV && (!canH || rw > rh || (rw === rh && rnd() < 0.5));
      if (vertical) {
        const sx = rx + ri(minRoom, rw - minRoom - 1);
        for (let yy = ry; yy < ry + rh; yy++) setT(sx, yy, T_WALL);
        const dy = ri(ry, ry + rh - 1);
        setT(sx, dy, floor);
        doorTiles.push([sx, dy]);
        split(rx, ry, sx - rx, rh, depth + 1);
        split(sx + 1, ry, rx + rw - sx - 1, rh, depth + 1);
      } else {
        const sy = ry + ri(minRoom, rh - minRoom - 1);
        for (let xx = rx; xx < rx + rw; xx++) setT(xx, sy, T_WALL);
        const dx = ri(rx, rx + rw - 1);
        setT(dx, sy, floor);
        doorTiles.push([dx, sy]);
        split(rx, ry, rw, sy - ry, depth + 1);
        split(rx, sy + 1, rw, ry + rh - sy - 1, depth + 1);
      }
    };
    split(x + 1, y + 1, w - 2, h - 2, 0);
    // 外のドア
    const nDoors = opts.doors ?? 2;
    const sides = [0, 1, 2, 3].sort(() => rnd() - 0.5);
    for (let d = 0; d < nDoors; d++) {
      const side = sides[d % 4];
      for (let tries = 0; tries < 12; tries++) {
        const px = side < 2 ? ri(x + 1, x + w - 2) : side === 2 ? x : x + w - 1;
        const py = side >= 2 ? ri(y + 1, y + h - 2) : side === 0 ? y : y + h - 1;
        const ix = side === 2 ? px + 1 : side === 3 ? px - 1 : px;
        const iy = side === 0 ? py + 1 : side === 1 ? py - 1 : py;
        if (tAt(ix, iy) === T_WALL) continue;
        setT(px, py, floor);
        doorTiles.push([px, py]);
        break;
      }
    }
    // ガラス窓
    const winRate = opts.windows ?? 0.22;
    for (let yy = y; yy < y + h; yy++)
      for (let xx = x; xx < x + w; xx++) {
        const corner = (xx === x || xx === x + w - 1) && (yy === y || yy === y + h - 1);
        const edge = xx === x || yy === y || xx === x + w - 1 || yy === y + h - 1;
        if (!edge || corner || tAt(xx, yy) !== T_WALL) continue;
        if (doorTiles.some(([dx, dy]) => Math.abs(dx - xx) + Math.abs(dy - yy) <= 1)) continue;
        const ix = xx === x ? xx + 1 : xx === x + w - 1 ? xx - 1 : xx;
        const iy = yy === y ? yy + 1 : yy === y + h - 1 ? yy - 1 : yy;
        if (tAt(ix, iy) === T_WALL) continue;
        if ((xx + yy) % 3 === 0 && rnd() < winRate * 3) setT(xx, yy, T_WINDOW);
      }
    // ドア（閉じた状態で生成）
    for (const [dx, dy] of doorTiles) addObj('door', dx, dy, 0);
    // 家具：部屋の壁際に並べる（ドアの前は空ける）
    const table = PROPS[kind];
    const total = table.reduce((a, [, w2]) => a + w2, 0);
    const pick = (): ObjKind => {
      let r = rnd() * total;
      for (const [k, w2] of table) {
        r -= w2;
        if (r <= 0) return k;
      }
      return table[0][0];
    };
    const rate = opts.propRate ?? 0.38;
    for (const rm of rooms) {
      if (table.length === 0) break;
      for (let yy = rm.y; yy < rm.y + rm.h; yy++)
        for (let xx = rm.x; xx < rm.x + rm.w; xx++) {
          const nearWall = tAt(xx - 1, yy) === T_WALL || tAt(xx + 1, yy) === T_WALL || tAt(xx, yy - 1) === T_WALL || tAt(xx, yy + 1) === T_WALL;
          if (!nearWall) continue;
          if (doorTiles.some(([dx, dy]) => Math.abs(dx - xx) + Math.abs(dy - yy) <= 1)) continue;
          if (rnd() < rate) addObj(pick(), xx, yy);
        }
      if (rm.w >= 5 && rm.h >= 5 && rnd() < 0.5) addObj(pick(), rm.x + Math.floor(rm.w / 2), rm.y + Math.floor(rm.h / 2));
    }
    return { rooms, doorTiles };
  };

  // ---- 拠点（フェンスで囲まれた安全地帯） ----
  {
    reserve(sh.x - 1, sh.y - 1, sh.w + 2, sh.h + 2);
    for (let yy = sh.y; yy < sh.y + sh.h; yy++)
      for (let xx = sh.x; xx < sh.x + sh.w; xx++) {
        const edge = xx === sh.x || yy === sh.y || xx === sh.x + sh.w - 1 || yy === sh.y + sh.h - 1;
        if (tAt(xx, yy) === T_ROAD && !edge) continue;
        setT(xx, yy, edge ? T_FENCE : T_DIRT);
      }
    // 門（道路の位置）
    for (let k = 0; k < 2; k++) {
      setT(roadX + k, sh.y, T_ROAD);
      setT(roadX + k, sh.y + sh.h - 1, T_ROAD);
      setT(sh.x, roadY + k, T_ROAD);
      setT(sh.x + sh.w - 1, roadY + k, T_ROAD);
    }
    // 拠点の建物（左上の区画）：作業台・共有倉庫・個人倉庫・ベッド
    const bx = sh.x + 2;
    const by = sh.y + 2;
    const bw = 8;
    const bh = 6;
    for (let yy = by; yy < by + bh; yy++)
      for (let xx = bx; xx < bx + bw; xx++) {
        const edge = xx === bx || yy === by || xx === bx + bw - 1 || yy === by + bh - 1;
        setT(xx, yy, edge ? T_WALL : T_WOOD);
      }
    buildings.push({ x: bx, y: by, w: bw, h: bh, roof: 0 });
    setT(bx + 4, by + bh - 1, T_WOOD);
    addObj('door', bx + 4, by + bh - 1, 1);
    setT(bx + bw - 1, by + 2, T_WINDOW);
    setT(bx + 2, by, T_WINDOW);
    setT(bx + 5, by, T_WINDOW);
    addObj('bench', bx + 1, by + 1);
    addObj('chest', bx + 3, by + 1);
    addObj('stash', bx + 6, by + 1);
    addObj('bed', bx + 1, by + 4);
    addObj('bed', bx + 2, by + 4);
    addObj('box', bx + 6, by + 4);
    addObj('campfire', CAMPFIRE_TILE.x, CAMPFIRE_TILE.y);
    for (let i = 0; i < 4; i++) addObj('sandbag', CAMPFIRE_TILE.x - 3 + i, CAMPFIRE_TILE.y + 3);
    locations.push({ name: '拠点', kind: 'base', x: sh.x, y: sh.y, w: sh.w, h: sh.h, tier: 0 });
  }

  // ---- ロケーション（中心から遠いほど危険） ----
  const place = (
    name: string,
    kind: BuildingKind,
    tier: number,
    cx: number,
    cy: number,
    w: number,
    h: number,
    floor: number,
    opts: Parameters<typeof makeBuilding>[6] = {},
  ) => {
    const spot = findSpot(cx, cy, w, h, 8);
    if (!spot) return null;
    const res = makeBuilding(spot.x, spot.y, w, h, kind, floor, opts);
    locations.push({ name, kind, x: spot.x, y: spot.y, w, h, tier });
    return { ...spot, ...res };
  };
  // 毎回ちがう町並み：大きな施設の場所をシャッフルし、住宅の数と位置も変える
  const shuffle = <T,>(a: T[]): T[] => {
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(rnd() * (i + 1));
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  };
  const bigSpots = shuffle([
    [49, 9],
    [12, 38],
    [68, 40],
    [20, 9],
  ]);
  place('スーパーマーケット', 'market', 2, bigSpots[0][0], bigSpots[0][1], 15, 10, T_TILE, { minRoom: 6, windows: 0.35, doors: 2, propRate: 0.55 });
  place('病院', 'hospital', 2, bigSpots[1][0], bigSpots[1][1], 14, 10, T_TILE, { minRoom: 4, windows: 0.25, doors: 2, propRate: 0.45 });
  place('ガソリンスタンド', 'gas', 2, rnd() < 0.5 ? 70 : 6, roadY - 4, 7, 5, T_TILE, { minRoom: 7, windows: 0.4, doors: 1 });
  const policeSpot = rnd() < 0.6 ? [72, 7] : [8, 8];
  place('警察署', 'police', 3, policeSpot[0], policeSpot[1], 12, 10, T_FLOOR, { minRoom: 3, windows: 0.18, doors: 2, propRate: 0.45 });
  // 軍事検問所（南西の角）：フェンスの敷地＋土嚢＋小屋
  {
    const w = 16;
    const h = 9;
    const spot = rnd() < 0.5 ? findSpot(10, 53, w, h, 4) : findSpot(70, 53, w, h, 4);
    if (spot) {
      const { x, y } = spot;
      reserve(x - 1, y - 1, w + 2, h + 2);
      for (let yy = y; yy < y + h; yy++)
        for (let xx = x; xx < x + w; xx++) {
          const edge = xx === x || yy === y || xx === x + w - 1 || yy === y + h - 1;
          setT(xx, yy, edge ? T_FENCE : T_DIRT);
        }
      setT(x + 7, y, T_DIRT);
      setT(x + 8, y, T_DIRT);
      setT(x + w - 1, y + 5, T_DIRT);
      locations.push({ name: '軍事検問所', kind: 'military', x, y, w, h, tier: 3 });
      makeBuilding(x + 2, y + 2, 6, 5, 'military', T_FLOOR, { minRoom: 3, doors: 1, windows: 0.2, propRate: 0.6 });
      makeBuilding(x + 9, y + 2, 5, 5, 'military', T_FLOOR, { minRoom: 5, doors: 1, windows: 0.1, propRate: 0.7 });
      for (let i = 0; i < 3; i++) addObj('sandbag', x + 14, y + 2 + i);
      for (let i = 0; i < 3; i++) addObj('mcrate', x + 3 + i * 3, y + 7);
    }
  }
  // 住宅街
  const houseSpots = shuffle([
    [11, 9],
    [22, 9],
    [16, 26],
    [24, 39],
    [52, 52],
    [70, 52],
    [52, 40],
    [58, 24],
    [8, 24],
    [36, 52],
    [64, 10],
  ]);
  const houses = ri(6, 8);
  let placedHouses = 0;
  for (const [cx, cy] of houseSpots) {
    if (placedHouses >= houses) break;
    if (place('住宅', 'house', 1, cx, cy, ri(8, 10), ri(7, 8), T_WOOD, { minRoom: 3, doors: 2 })) placedHouses++;
  }
  // 廃屋（ランダム）
  for (let i = 0, made = 0; i < 80 && made < 5; i++) {
    const w = ri(6, 8);
    const h = ri(5, 7);
    const cx = ri(6, MAP_W - 7);
    const cy = ri(6, MAP_H - 7);
    if (Math.hypot(cx - 40, cy - 30) < 14) continue;
    const res = place('廃屋', 'ruin', Math.hypot(cx - 40, cy - 30) > 28 ? 2 : 1, cx, cy, w, h, T_FLOOR, { minRoom: 3, doors: 2, windows: 0.3 });
    if (res) {
      made++;
      for (let k = 0; k < 3; k++) {
        const bx = res.x + ri(1, w - 2);
        const by = rnd() < 0.5 ? res.y : res.y + h - 1;
        setT(bx, by, T_FLOOR);
        addObj('rubble', bx, by);
      }
    }
  }

  // ---- 廃車（道路沿い） ----
  for (let attempt = 0, cars = 0; attempt < 800 && cars < 34; attempt++) {
    const x = ri(1, MAP_W - 2);
    const y = ri(1, MAP_H - 2);
    if (terrain[idx(x, y)] !== T_ROAD) continue;
    if (x >= sh.x - 2 && x <= sh.x + sh.w + 1 && y >= sh.y - 2 && y <= sh.y + sh.h + 1) continue;
    if (addObj('car', x, y)) cars++;
  }

  // ---- 森（木のクラスター） ----
  for (let c = 0; c < 26; c++) {
    const cx = ri(2, MAP_W - 3);
    const cy = ri(2, MAP_H - 3);
    if (Math.hypot(cx - 40, cy - 30) < 12) continue;
    const n = ri(5, 14);
    for (let i = 0; i < n; i++) {
      const x = cx + ri(-4, 4);
      const y = cy + ri(-4, 4);
      if (!inMap(x, y) || reserved[idx(x, y)]) continue;
      const t = terrain[idx(x, y)];
      if (t === T_GRASS || t === T_DIRT) addObj('tree', x, y);
    }
  }
  // ---- 野外の木箱・瓦礫 ----
  for (let i = 0, placed = 0; i < 400 && placed < 14; i++) {
    const x = ri(2, MAP_W - 3);
    const y = ri(2, MAP_H - 3);
    const t = terrain[idx(x, y)];
    if ((t === T_GRASS || t === T_DIRT) && !reserved[idx(x, y)] && Math.hypot(x - 40, y - 30) > 12) {
      if (addObj(rnd() < 0.5 ? 'crate' : 'rubble', x, y)) placed++;
    }
  }

  // 汚染地帯：危険度2の施設のうち1つがランダムに危険度3になる（手強い敵とレア物資）
  const mids = locations.filter((l) => l.tier === 2 && l.kind !== 'ruin');
  if (mids.length) {
    const hot = mids[Math.floor(rnd() * mids.length)];
    hot.tier = 3;
    hot.hot = true;
    hot.name = `汚染された${hot.name}`;
  }

  return { terrain, objs, locations, buildings };
}

/** オブジェクトIDの開始値（実行中に作るオブジェクト用。生成オブジェクトと衝突しない値） */
export const BUILD_ID_START = 100000;
