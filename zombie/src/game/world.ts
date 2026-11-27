// ============================================================
// タイルワールド（地形＋オブジェクト）とシード付きマップ生成
//   地形はシードから決定的に生成（ホスト・ゲストで同一）
//   建物は「外壁・内壁・ドア・ガラス窓・床材・家具」を持つ部屋割り構造
//   オブジェクト（ドア・家具・木・車など）はホストが管理し差分同期
// ============================================================
import type { ObjKind, ObjSnap } from '../types';
import {
  BULLET_BLOCK_KINDS,
  BASE_TX,
  BASE_TY,
  CAMPFIRE_TILE,
  CHUNK,
  MAP_H,
  MAP_W,
  OBJ_HP,
  SAFEHOUSE,
  SHALLOW_SPEED,
  SOLID_KINDS,
  T_BRIDGE,
  T_DIRT,
  T_FENCE,
  T_FLOOR,
  T_GRASS,
  T_ROAD,
  T_SHALLOW,
  T_TILE,
  T_WALL,
  T_WATER,
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
  kind: 'house' | 'market' | 'hospital' | 'police' | 'military' | 'gas' | 'base' | 'ruin' | 'warehouse';
  x: number;
  y: number;
  w: number;
  h: number;
  tier: number;
  /** 汚染地帯（毎回ランダムに1か所） */
  hot?: boolean;
}

/** 遠くから見える目印（煙・電波塔・給水塔・炎上する残骸） */
export interface Landmark {
  x: number;
  y: number;
  kind: 'smoke' | 'tower' | 'water' | 'fire';
  name: string;
}

/** 危険度の境目（拠点からの距離・タイル）：★1｜★2｜★3｜★4 */
export const TIER_RINGS = [44, 88, 132] as const;

/** 拠点からの距離（タイル）で決まる危険度 1〜4 */
export function tierAtDistance(d: number): number {
  return d < TIER_RINGS[0] ? 1 : d < TIER_RINGS[1] ? 2 : d < TIER_RINGS[2] ? 3 : 4;
}

// ---------------- 地区（街区のまとまり） ----------------
export type DistrictKind = 'residential' | 'commercial' | 'industrial' | 'civic' | 'military' | 'forest' | 'wild';
export const DISTRICT_INFO: Record<DistrictKind, { name: string; color: string; loot: string; threat: string; advice: string }> = {
  residential: { name: '住宅街', color: '#9fbf7a', loot: '食料・布・包帯', threat: 'ウォーカーの群れ', advice: '弾は節約し斧で各個撃破・サプレッサー推奨' },
  commercial: { name: '商業地区', color: '#d8b862', loot: '食料・電子部品・貴重品', threat: '足の速いランナー・叫び屋', advice: '叫び屋は叫ぶ前に仕留める・SMG／ショットガン' },
  industrial: { name: '工業地区', color: '#a8a090', loot: '鉄くず・武器パーツ・工具', threat: '巨漢・膨張体（毒ガス）', advice: '膨張体は離れて撃つ・ドラム缶の誘爆を利用' },
  civic: { name: '市街中心部', color: '#7fa6d0', loot: '救急キット・興奮剤・解毒剤（専用）', threat: '感染した警官・膨張体', advice: '徹甲弾があると楽・病院で解毒剤を探す' },
  military: { name: '軍用地', color: '#d8644a', loot: '7.62mm・徹甲弾・武器・機密書類（専用）', threat: '装甲の感染兵士', advice: '通常弾は弾かれる：徹甲弾／スラッグ必須・有刺鉄線に注意' },
  forest: { name: '森林', color: '#5f8a48', loot: '薬草（専用）・散弾・狩猟ライフル', threat: '木陰から飛び出すランナー', advice: '見通しが悪い：ショットガンで近距離に備える' },
  wild: { name: '荒野', color: '#a08a5a', loot: '鉄くず・火薬・放置車両の中身', threat: 'うろつく群れ・叫び屋', advice: '開けているので遠くから狙える・群れは迂回' },
};
/** 幹線道路で区切られた1区画と、その区画が属する地区 */
export interface DistrictBlock {
  x: number;
  y: number;
  w: number;
  h: number;
  kind: DistrictKind;
  tier: number;
  /** 地区の名前（例：「北東の住宅街」）。同じ地区の区画は同じ名前 */
  name: string;
  /** 地図に地区名を書く区画（地区の中心に近いもの） */
  label?: boolean;
}

export function districtAt(ds: DistrictBlock[], tx: number, ty: number): DistrictBlock | null {
  for (const d of ds) if (tx >= d.x && ty >= d.y && tx < d.x + d.w && ty < d.y + d.h) return d;
  return null;
}

/** 拠点から見た方角（8方位） */
export function directionName(tx: number, ty: number): string {
  const a = Math.atan2(ty - BASE_TY, tx - BASE_TX);
  const names = ['東', '南東', '南', '南西', '西', '北西', '北', '北東'];
  return names[(Math.round(a / (Math.PI / 4)) + 8) % 8];
}

/** マップの外周からの距離（タイル）。小さいほど外縁の汚染帯に近い */
export function edgeDistance(tx: number, ty: number): number {
  return Math.min(tx, ty, MAP_W - 1 - tx, MAP_H - 1 - ty);
}
/** 外縁の汚染帯の幅（タイル） */
export const EDGE_BAND = 16;

/** 道路網・川の形（描画と地図用。通行の判定は地形タイルで行う） */
export interface RoadFeatures {
  /** 幅の広い国道（at = 最初の行／列、w = 幅のタイル数） */
  highways: { horiz: boolean; at: number; w: number; name: string }[];
  /** 滑らかなカーブを描く旧道（タイル座標の折れ線・幅） */
  curves: { pts: [number, number][]; w: number; name: string }[];
  /** 橋（broken = 崩落していて渡れない） */
  bridges: { x: number; y: number; w: number; h: number; horiz: boolean; name: string; broken?: boolean; hwy?: boolean }[];
  /** 川の中心線（タイル座標） */
  river: { pts: [number, number][]; name: string } | null;
  /** 浅瀬（歩いて渡れる場所） */
  fords: { x: number; y: number }[];
}

export const emptyFeatures = (): RoadFeatures => ({ highways: [], curves: [], bridges: [], river: null, fords: [] });

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
  landmarks: Landmark[] = [];
  districts: DistrictBlock[] = [];
  features: RoadFeatures = emptyFeatures();
  /** カーブ道路のタイル（地形は道路だが、描画はベクターの道路で行う） */
  vec: Uint8Array = new Uint8Array(MAP_W * MAP_H);
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
    if (t === T_WALL || t === T_WINDOW || t === T_FENCE || t === T_WATER) return true;
    const o = this.objAt(tx, ty);
    return !!o && objIsSolid(o);
  }

  /** そのタイルでの移動速度の倍率（浅瀬・有刺鉄線は遅い） */
  speedAt(tx: number, ty: number): number {
    if (!this.inBounds(tx, ty)) return 1;
    if (this.terrain[ty * MAP_W + tx] === T_SHALLOW) return SHALLOW_SPEED;
    const o = this.objAt(tx, ty);
    return o && o.kind === 'barbed' ? 0.45 : 1;
  }

  /** 2点の間に水（泳げない川・池）がないか。まっすぐ歩いて行けるかの判定に使う */
  lineWalkable(x1: number, y1: number, x2: number, y2: number): boolean {
    const d = Math.hypot(x2 - x1, y2 - y1);
    const steps = Math.ceil(d / (TILE / 2));
    for (let i = 1; i < steps; i++) {
      const t = i / steps;
      const tx = Math.floor((x1 + (x2 - x1) * t) / TILE);
      const ty = Math.floor((y1 + (y2 - y1) * t) / TILE);
      if (this.inBounds(tx, ty) && this.terrain[ty * MAP_W + tx] === T_WATER) return false;
    }
    return true;
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
  landmarks: Landmark[];
  districts: DistrictBlock[];
  features: RoadFeatures;
  vec: Uint8Array;
}

/** ゲスト用：シードから同じ世界（地形とオブジェクト）を再生成する */
export function generateTerrain(seed: number): GeneratedWorld {
  return generateWorld(seed);
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
  warehouse: [['crate', 5], ['shelf', 4], ['locker', 1], ['desk', 1], ['cabinet', 0.5]],
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

  // ---- 地面のまだら模様（土の斑） ----
  for (let i = 0; i < 46 * 9; i++) {
    const cx = ri(0, MAP_W - 1);
    const cy = ri(0, MAP_H - 1);
    const r = ri(2, 7);
    for (let y = cy - r; y <= cy + r; y++)
      for (let x = cx - r; x <= cx + r; x++)
        if ((x - cx) ** 2 + (y - cy) ** 2 <= r * r && rnd() < 0.8) setT(x, y, T_DIRT);
  }

  // ---- 道路網：拠点を通る十字の幹線＋約40タイルごとの幹線の格子（地図の端まで続く） ----
  //   ＋幅の広い国道（4車線）・川と橋・浅瀬・カーブを描く旧道
  const roadY = sh.y + Math.floor(sh.h / 2);
  const roadX = sh.x + Math.floor(sh.w / 2) - 1;
  const features = emptyFeatures();
  const vec = new Uint8Array(MAP_W * MAP_H);
  const isWater = (x: number, y: number) => inMap(x, y) && (terrain[idx(x, y)] === T_WATER || terrain[idx(x, y)] === T_SHALLOW);
  /** 道路を敷く。bridge = 水の上に橋を架けるか（架けないなら水の手前で途切れる） */
  const road = (x0: number, y0: number, x1: number, y1: number, bridge = false) => {
    for (let y = y0; y <= y1; y++)
      for (let x = x0; x <= x1; x++) {
        if (!inMap(x, y)) continue;
        if (isWater(x, y)) {
          if (!bridge) continue;
          setT(x, y, T_BRIDGE);
        } else if (terrain[idx(x, y)] !== T_BRIDGE) setT(x, y, T_ROAD);
        reserved[idx(x, y)] = 1;
      }
  };
  const hLines = [roadY];
  const vLines = [roadX];
  for (const d of [-1, 1])
    for (let k = 1; k < 6; k++) {
      const y = roadY + d * (k * 40 + ri(-4, 4));
      if (y > 4 && y < MAP_H - 8) hLines.push(y);
      const x = roadX + d * (k * 40 + ri(-4, 4));
      if (x > 4 && x < MAP_W - 8) vLines.push(x);
    }
  hLines.sort((a, b) => a - b);
  vLines.sort((a, b) => a - b);
  // 幹線の幅（国道は4車線）
  const lineW = new Map<string, number>();
  const wH = (y: number) => lineW.get(`h${y}`) ?? 2;
  const wV = (x: number) => lineW.get(`v${x}`) ?? 2;
  const pickHwy = (lines: number[], center: number) => {
    const c = lines.filter((v) => Math.abs(Math.abs(v - center) - 80) < 12);
    return c.length ? c[Math.floor(rnd() * c.length)] : lines[0];
  };
  const hwyY = pickHwy(hLines, roadY);
  lineW.set(`h${hwyY}`, 4);

  // ---- 川：地図を南北に横切る（拠点から離れた幹線どうしの間を蛇行する） ----
  const RIVER_NAMES = ['黒瀬川', '鳴瀬川', '境川', '旧緑川', '霞川'];
  const BRIDGE_NAMES = ['旭橋', '新川橋', '境橋', '中央大橋', '緑橋', '学園橋', '北大橋', '南大橋'];
  let riverCol = -1;
  {
    const pairs: number[] = [];
    for (let b = 0; b + 1 < vLines.length; b++) {
      const mid = (vLines[b] + vLines[b + 1] + 2) / 2;
      if (Math.abs(mid - BASE_TX) > 55 && Math.abs(mid - BASE_TX) < 140) pairs.push(b);
    }
    if (pairs.length) {
      riverCol = pairs[Math.floor(rnd() * pairs.length)];
      const vl = vLines[riverCol] + 2;
      const vr = vLines[riverCol + 1];
      const mid = (vl + vr) / 2;
      const amp = Math.max(3, Math.min(9, (vr - vl) / 2 - 7));
      const ph1 = rnd() * 6.28;
      const ph2 = rnd() * 6.28;
      const ph3 = rnd() * 6.28;
      const pts: [number, number][] = [];
      for (let y = -8; y <= MAP_H + 8; y++) {
        const cx = mid + amp * (0.7 * Math.sin(y / 23 + ph1) + 0.3 * Math.sin(y / 9 + ph2));
        const w = 4 + 1.5 * (Math.sin(y / 31 + ph3) + 1);
        if (y % 4 === 0) pts.push([cx, y]);
        const xa = Math.round(cx - w / 2);
        const xb = Math.round(cx + w / 2);
        for (let x = xa - 2; x <= xb + 2; x++) {
          if (!inMap(x, y)) continue;
          if (x >= xa && x <= xb) setT(x, y, T_WATER);
          else if (x === xa - 1 || x === xb + 1) setT(x, y, T_DIRT); // ぬかるんだ岸
          reserved[idx(x, y)] = 1;
        }
      }
      features.river = { pts, name: RIVER_NAMES[Math.floor(rnd() * RIVER_NAMES.length)] };
      // 浅瀬：幹線から離れた2か所（歩いて渡れるが遅い）
      for (let k = 0; k < 2; k++) {
        for (let t = 0; t < 30; t++) {
          const fy = ri(12, MAP_H - 14);
          if (hLines.some((h) => Math.abs(h - fy) < 10) || features.fords.some((f) => Math.abs(f.y - fy) < 30)) continue;
          for (let y = fy; y < fy + 3; y++) for (let x = vl; x < vr; x++) if (inMap(x, y) && terrain[idx(x, y)] === T_WATER) setT(x, y, T_SHALLOW);
          features.fords.push({ x: Math.round(mid + amp * (0.7 * Math.sin((fy + 1) / 23 + ph1) + 0.3 * Math.sin((fy + 1) / 9 + ph2))), y: fy + 1 });
          break;
        }
      }
    }
  }
  // ---- 幹線を敷く：川を渡る橋は限られる（拠点の道・国道・一部の幹線だけ。残りは崩落） ----
  for (const y of hLines) {
    const w = wH(y);
    const bridged = y === roadY || y === hwyY || rnd() < 0.35;
    road(0, y, MAP_W - 1, y + w - 1, bridged);
    if (riverCol < 0) continue;
    // 川をまたぐ区間を探して、橋（または崩れた橋の残骸）として記録
    let x0 = -1;
    let x1 = -1;
    for (let x = vLines[riverCol]; x <= vLines[riverCol + 1] + 1; x++) {
      const t = terrain[idx(x, y)];
      if (t === T_BRIDGE || isWater(x, y)) {
        if (x0 < 0) x0 = x;
        x1 = x;
      }
    }
    if (x0 < 0) continue;
    const name = bridged ? BRIDGE_NAMES[features.bridges.filter((b) => !b.broken).length % BRIDGE_NAMES.length] : '崩落した橋';
    features.bridges.push({ x: x0, y, w: x1 - x0 + 1, h: w, horiz: true, name, broken: !bridged, hwy: y === hwyY });
    if (!bridged) {
      // 両岸の道路の端に瓦礫と放置車両（行き止まり）
      for (const ex of [x0 - 1, x1 + 1]) {
        if (terrain[idx(ex, y)] === T_ROAD) {
          addObj('rubble', ex, y);
          if (rnd() < 0.6) addObj('car', ex + (ex < x0 ? -2 : 2), y + w - 1);
        }
      }
    }
  }
  // 縦の国道（川とは反対側）
  const vSide = riverCol >= 0 && vLines[riverCol] > BASE_TX ? -1 : 1;
  const hwyXc = vLines.filter((v) => Math.sign(v - roadX) === vSide && Math.abs(Math.abs(v - roadX) - 80) < 12);
  const hwyX = hwyXc.length ? hwyXc[Math.floor(rnd() * hwyXc.length)] : vLines[vSide < 0 ? 0 : vLines.length - 1];
  lineW.set(`v${hwyX}`, 4);
  for (const x of vLines) road(x, 0, x + wV(x) - 1, MAP_H - 1, true);
  features.highways.push({ horiz: true, at: hwyY, w: 4, name: '国道1号' });
  features.highways.push({ horiz: false, at: hwyX, w: 4, name: '国道2号' });

  // 区画の中を通る脇道（幹線どうしをつなぐ。川のある区画では川沿いには通さない）
  for (let a = 0; a + 1 < hLines.length; a++)
    for (let b = 0; b + 1 < vLines.length; b++) {
      if (rnd() < 0.45) continue;
      const x0 = vLines[b] + wV(vLines[b]);
      const x1 = vLines[b + 1] - 1;
      const y0 = hLines[a] + wH(hLines[a]);
      const y1 = hLines[a + 1] - 1;
      if (rnd() < 0.5 || b === riverCol) {
        const y = ri(y0 + 6, y1 - 7);
        if (b === riverCol) {
          // 川のある区画の脇道は、片方の岸の手前で行き止まり（川へ突っ込まない）
          let wa = -1;
          let wb = -1;
          for (let x = x0; x <= x1; x++)
            if (isWater(x, y) || isWater(x, y + 1)) {
              if (wa < 0) wa = x;
              wb = x;
            }
          if (wa < 0) road(x0, y, x1, y + 1);
          else if (rnd() < 0.5) road(x0, y, wa - 3, y + 1);
          else road(wb + 3, y, x1, y + 1);
        } else road(x0, y, x1, y + 1);
      } else {
        const x = ri(x0 + 6, x1 - 7);
        road(x, y0, x + 1, y1);
      }
    }

  // ---- 旧道：交差点から交差点へ、区画を斜めに抜ける滑らかなカーブ ----
  const ROUTE_NAMES = ['県道12号', '県道31号', '旧街道', '県道7号'];
  for (let n = 0, tries = 0; n < 3 && tries < 40; tries++) {
    const i = ri(0, vLines.length - 2);
    const j = ri(0, hLines.length - 2);
    const di = rnd() < 0.5 ? 1 : 2;
    const i2 = Math.min(vLines.length - 1, i + di);
    const j2 = j + 1;
    const flip = rnd() < 0.5;
    const ax = vLines[i] + wV(vLines[i]) / 2;
    const ay = hLines[flip ? j2 : j] + wH(hLines[flip ? j2 : j]) / 2;
    const bx = vLines[i2] + wV(vLines[i2]) / 2;
    const by = hLines[flip ? j : j2] + wH(hLines[flip ? j : j2]) / 2;
    const mx = (ax + bx) / 2;
    const my = (ay + by) / 2;
    const len = Math.hypot(bx - ax, by - ay);
    const k = (rnd() < 0.5 ? -1 : 1) * (0.22 + rnd() * 0.2) * len;
    const cx = mx + (-(by - ay) / len) * k;
    const cy = my + ((bx - ax) / len) * k;
    if (Math.hypot(mx - BASE_TX, my - BASE_TY) < 30) continue;
    const pts: [number, number][] = [];
    let ok = true;
    for (let s2 = 0; s2 <= 1.0001; s2 += 1 / 48) {
      const px = (1 - s2) * (1 - s2) * ax + 2 * (1 - s2) * s2 * cx + s2 * s2 * bx;
      const py = (1 - s2) * (1 - s2) * ay + 2 * (1 - s2) * s2 * cy + s2 * s2 * by;
      for (let yy = Math.floor(py) - 3; yy <= Math.floor(py) + 3 && ok; yy++)
        for (let xx = Math.floor(px) - 3; xx <= Math.floor(px) + 3; xx++) if (isWater(xx, yy) || !inMap(xx, yy)) ok = false;
      // 拠点の敷地（フェンス）を横切らない（あとで敷地のフェンスが道の上に建ってしまう）
      if (px > sh.x - 6 && px < sh.x + sh.w + 6 && py > sh.y - 6 && py < sh.y + sh.h + 6) ok = false;
      pts.push([px, py]);
    }
    if (!ok) continue;
    // 曲線に沿って細かく円を押し付け、中心から1.25タイル以内を道路に（描画はベクターの道で行う）
    const dist2 = new Map<number, number>();
    for (let q = 0; q + 1 < pts.length; q++) {
      const [x1, y1] = pts[q];
      const [x2, y2] = pts[q + 1];
      const steps = Math.max(1, Math.ceil(Math.hypot(x2 - x1, y2 - y1) * 4));
      for (let st = 0; st < steps; st++) {
        const px = x1 + ((x2 - x1) * st) / steps;
        const py = y1 + ((y2 - y1) * st) / steps;
        for (let y = Math.floor(py - 2.4); y <= Math.floor(py + 2.4); y++)
          for (let x = Math.floor(px - 2.4); x <= Math.floor(px + 2.4); x++) {
            if (!inMap(x, y)) continue;
            const d = Math.hypot(x + 0.5 - px, y + 0.5 - py);
            const i2 = idx(x, y);
            const prev = dist2.get(i2);
            if (prev === undefined || d < prev) dist2.set(i2, d);
          }
      }
    }
    for (const [i2, d] of dist2) {
      if (d <= 1.25) {
        if (terrain[i2] !== T_ROAD) {
          terrain[i2] = T_ROAD;
          vec[i2] = 1;
        }
        reserved[i2] = 1;
      } else if (d <= 2.3) reserved[i2] = 1;
    }
    features.curves.push({ pts, w: 2.4, name: ROUTE_NAMES[n % ROUTE_NAMES.length] });
    n++;
  }

  const overlaps = (x: number, y: number, w: number, h: number, m: number) => {
    for (let yy = y - m; yy < y + h + m; yy++)
      for (let xx = x - m; xx < x + w + m; xx++) if (!inMap(xx, yy) || reserved[idx(xx, yy)]) return true;
    return false;
  };
  const reserve = (x: number, y: number, w: number, h: number) => {
    for (let yy = y; yy < y + h; yy++) for (let xx = x; xx < x + w; xx++) if (inMap(xx, yy)) reserved[idx(xx, yy)] = 1;
  };
  /** 目標地点の近くで空いている場所を探す（広い地図なので全体走査はしない） */
  const findSpot = (cx: number, cy: number, w: number, h: number, spread: number): { x: number; y: number } | null => {
    for (let r = 0; r <= spread; r++)
      for (let t = 0; t < 20; t++) {
        const x = cx - Math.floor(w / 2) + ri(-r, r);
        const y = cy - Math.floor(h / 2) + ri(-r, r);
        if (x < 2 || y < 2 || x + w > MAP_W - 2 || y + h > MAP_H - 2) continue;
        if (!overlaps(x, y, w, h, 1)) return { x, y };
      }
    return null;
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
    // 乱数を返す比較関数での sort は、ブラウザによって比較の回数（＝乱数の消費）が変わり
    // ホストとゲストで生成結果がずれるので、決まった回数だけ乱数を使うシャッフルにする
    const sides = [0, 1, 2, 3];
    for (let i = 3; i > 0; i--) {
      const j = Math.floor(rnd() * (i + 1));
      [sides[i], sides[j]] = [sides[j], sides[i]];
    }
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

  // ---- ロケーション：区画ごとに、拠点からの距離（危険度）に応じた施設を置く ----
  const distOf = (x: number, y: number) => Math.hypot(x - BASE_TX, y - BASE_TY);
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
    spread = 10,
  ) => {
    const spot = findSpot(cx, cy, w, h, spread);
    if (!spot) return null;
    const res = makeBuilding(spot.x, spot.y, w, h, kind, floor, opts);
    const full = `${directionName(spot.x + w / 2, spot.y + h / 2)}の${name}`;
    locations.push({ name: full, kind, x: spot.x, y: spot.y, w, h, tier });
    return { ...spot, ...res };
  };
  /** 軍の検問所・基地：フェンスの敷地＋土嚢＋小屋 */
  const checkpoint = (cx: number, cy: number, tier: number, bigWanted: boolean): boolean => {
    let big = bigWanted;
    let spot = findSpot(cx, cy, big ? 22 : 16, big ? 13 : 9, 14);
    if (!spot && big) {
      // 大きな基地が入らなければ検問所にする
      big = false;
      spot = findSpot(cx, cy, 16, 9, 14);
    }
    if (!spot) return false;
    const w = big ? 22 : 16;
    const h = big ? 13 : 9;
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
    setT(x, y + h - 4, T_DIRT);
    locations.push({ name: `${directionName(x + w / 2, y + h / 2)}の${big ? '軍事基地' : '軍事検問所'}`, kind: 'military', x, y, w, h, tier });
    makeBuilding(x + 2, y + 2, 6, 5, 'military', T_FLOOR, { minRoom: 3, doors: 1, windows: 0.2, propRate: 0.6 });
    makeBuilding(x + 9, y + 2, 5, 5, 'military', T_FLOOR, { minRoom: 5, doors: 1, windows: 0.1, propRate: 0.7 });
    if (big) makeBuilding(x + 15, y + 2, 5, 8, 'military', T_FLOOR, { minRoom: 3, doors: 1, windows: 0.1, propRate: 0.65 });
    for (let i = 0; i < 3; i++) addObj('sandbag', x + (big ? 20 : 14), y + 2 + i);
    // 門の前の有刺鉄線（踏むと足が止まる）
    for (let i = 5; i <= 10; i++) if (i !== 7 && i !== 8) addObj('barbed', x + i, y - 2);
    for (let i = 3; i <= 7; i++) addObj('barbed', x + w + 1, y + i);
    for (let i = h - 6; i <= h - 2; i++) addObj('barbed', x - 2, y + i);
    for (let i = 0; i < (big ? 5 : 3); i++) addObj('mcrate', x + 3 + i * 3, y + h - 2);
    landmarks.push({ x: x + w / 2, y: y + h / 2, kind: 'tower', name: big ? '軍事基地の通信塔' : '検問所の通信塔' });
    return true;
  };
  const landmarks: Landmark[] = [];
  // ---- 地区（ゾーニング）：地図に「地区の種」をまき、各区画は近い種の地区になる ----
  //   → 隣り合う区画が同じ地区にまとまり、チャンクをまたいで住宅街・工業地区・森などが続く
  const KIND_WEIGHTS: Record<number, [DistrictKind, number][]> = {
    1: [['residential', 5], ['commercial', 2.5], ['forest', 1.5], ['wild', 1], ['industrial', 0.8]],
    2: [['residential', 3], ['commercial', 2.5], ['industrial', 2], ['civic', 2], ['forest', 1.5], ['wild', 1]],
    3: [['industrial', 2], ['civic', 2], ['military', 1.2], ['residential', 1.5], ['commercial', 1], ['forest', 1.5], ['wild', 1.4]],
    4: [['military', 1.6], ['industrial', 1.4], ['civic', 1], ['forest', 1.8], ['wild', 2], ['residential', 1], ['commercial', 0.6]],
  };
  // 危険度ごとの「山札」から引く（重みの比率どおりに偏りなく配られる）
  const decks: Record<number, DistrictKind[]> = {};
  const pickKind = (tier: number): DistrictKind => {
    let deck = decks[tier];
    if (!deck || deck.length === 0) {
      deck = [];
      for (const [k, w] of KIND_WEIGHTS[tier]) for (let i = 0; i < Math.round(w * 2); i++) deck.push(k);
      for (let i = deck.length - 1; i > 0; i--) {
        const j = Math.floor(rnd() * (i + 1));
        [deck[i], deck[j]] = [deck[j], deck[i]];
      }
      decks[tier] = deck;
    }
    return deck.pop()!;
  };
  // 種は少し揺らした格子に置く（地区の大きさがそろう）
  const seeds: { x: number; y: number; kind: DistrictKind; name: string }[] = [];
  const GX = 7;
  const GY = 5;
  for (let gy = 0; gy < GY; gy++)
    for (let gx = 0; gx < GX; gx++) {
      const x = Math.floor(((gx + 0.15 + rnd() * 0.7) / GX) * MAP_W);
      const y = Math.floor(((gy + 0.15 + rnd() * 0.7) / GY) * MAP_H);
      seeds.push({ x, y, kind: pickKind(tierAtDistance(distOf(x, y))), name: '' });
    }
  // 拠点のまわりは住宅街、深部には必ず軍用地がある
  seeds.push({ x: BASE_TX + ri(-20, 20), y: BASE_TY + ri(-20, 20), kind: 'residential', name: '' });
  if (!seeds.some((q) => q.kind === 'military')) {
    const far = [...seeds].sort((p, q) => distOf(q.x, q.y) - distOf(p.x, p.y))[0];
    far.kind = 'military';
  }
  if (!seeds.some((q) => q.kind === 'civic')) seeds.find((q) => tierAtDistance(distOf(q.x, q.y)) === 2)!.kind = 'civic';
  const usedNames = new Map<string, number>();
  const districts: DistrictBlock[] = [];
  const distGrid = new Int8Array(MAP_W * MAP_H).fill(-1);
  const KIND_IDX: DistrictKind[] = ['residential', 'commercial', 'industrial', 'civic', 'military', 'forest', 'wild'];
  const hB = [-3, ...hLines, MAP_H + 1];
  const vB = [-3, ...vLines, MAP_W + 1];
  const blocks: { x0: number; y0: number; x1: number; y1: number; seed: (typeof seeds)[number]; db: DistrictBlock }[] = [];
  for (let a = 0; a + 1 < hB.length; a++)
    for (let b = 0; b + 1 < vB.length; b++) {
      const bx0 = Math.max(0, vB[b] + wV(vB[b]));
      const bx1 = Math.min(MAP_W - 1, vB[b + 1] - 1);
      const by0 = Math.max(0, hB[a] + wH(hB[a]));
      const by1 = Math.min(MAP_H - 1, hB[a + 1] - 1);
      const bcx = (bx0 + bx1) / 2;
      const bcy = (by0 + by1) / 2;
      let seed = seeds[0];
      let bd = Infinity;
      for (const q of seeds) {
        const dd = (q.x - bcx) ** 2 + (q.y - bcy) ** 2;
        if (dd < bd) {
          bd = dd;
          seed = q;
        }
      }
      const tier = tierAtDistance(distOf(bcx, bcy));
      // 危険度に合わない地区は置き換える（拠点の隣に軍用地は置かない）
      let kind = seed.kind;
      if (kind === 'military' && tier <= 2) kind = tier === 1 ? 'wild' : 'industrial';
      if (distOf(bcx, bcy) < 16) kind = 'residential';
      if (!seed.name) {
        const base = `${directionName(seed.x, seed.y)}の${DISTRICT_INFO[seed.kind].name}`;
        const n = (usedNames.get(base) ?? 0) + 1;
        usedNames.set(base, n);
        seed.name = n === 1 ? base : `${base} 第${n}`;
      }
      const name = kind === seed.kind ? seed.name : `${directionName(bcx, bcy)}の${DISTRICT_INFO[kind].name}`;
      const db: DistrictBlock = { x: bx0, y: by0, w: bx1 - bx0 + 1, h: by1 - by0 + 1, kind, tier, name };
      districts.push(db);
      blocks.push({ x0: bx0, y0: by0, x1: bx1, y1: by1, seed, db });
      const ki = KIND_IDX.indexOf(kind);
      for (let y = by0; y <= by1; y++) distGrid.fill(ki, y * MAP_W + bx0, y * MAP_W + bx1 + 1);
    }
  // 地図に名前を書く区画：同じ名前の区画のうち、まとまりの中心に近いもの
  {
    const groups = new Map<string, DistrictBlock[]>();
    for (const d of districts) groups.set(d.name, [...(groups.get(d.name) ?? []), d]);
    for (const g of groups.values()) {
      const cx = g.reduce((a, d) => a + d.x + d.w / 2, 0) / g.length;
      const cy = g.reduce((a, d) => a + d.y + d.h / 2, 0) / g.length;
      let best = g[0];
      for (const d of g) if (Math.hypot(d.x + d.w / 2 - cx, d.y + d.h / 2 - cy) < Math.hypot(best.x + best.w / 2 - cx, best.y + best.h / 2 - cy)) best = d;
      if (best.w > 14 && best.h > 10) best.label = true;
    }
  }

  // ---- 区画の中身：地区の種類 × 危険度で施設を選ぶ ----
  const house = (tier: number, cx: number, cy: number) => place('住宅', 'house', tier, cx, cy, ri(8, 10), ri(7, 8), T_WOOD, { minRoom: 3, doors: 2 });
  const shop = (tier: number, cx: number, cy: number) => place('商店', 'market', tier, cx, cy, ri(8, 10), 7, T_TILE, { minRoom: 8, windows: 0.4, doors: 1, propRate: 0.5 });
  const market = (tier: number, cx: number, cy: number) => place('スーパーマーケット', 'market', tier, cx, cy, 15, 10, T_TILE, { minRoom: 6, windows: 0.35, doors: 2, propRate: 0.55 + tier * 0.02 });
  const gas = (tier: number, cx: number, cy: number) => place('ガソリンスタンド', 'gas', tier, cx, cy, 7, 5, T_TILE, { minRoom: 7, windows: 0.4, doors: 1 });
  const ruin = (tier: number, cx: number, cy: number) => place(tier >= 4 ? '廃墟' : '廃屋', 'ruin', tier, cx, cy, ri(6, 9), ri(5, 8), T_FLOOR, { minRoom: 3, doors: 2, windows: 0.3, propRate: tier >= 4 ? 0.5 : 0.38 });
  const hospital = (tier: number, cx: number, cy: number, small = false) =>
    place(small ? '診療所' : '病院', 'hospital', tier, cx, cy, small ? 10 : 14, small ? 8 : 10, T_TILE, { minRoom: 4, windows: 0.25, doors: 2, propRate: 0.45 + tier * 0.03 });
  const police = (tier: number, cx: number, cy: number) => place('警察署', 'police', tier, cx, cy, 12, 10, T_FLOOR, { minRoom: 3, windows: 0.18, doors: 2, propRate: 0.45 + tier * 0.03 });
  const warehouse = (tier: number, cx: number, cy: number, factory = false) =>
    place(factory ? '工場' : '倉庫', 'warehouse', tier, cx, cy, factory ? 18 : 16, factory ? 12 : 10, T_FLOOR, { minRoom: factory ? 5 : 8, windows: 0.08, doors: 2, propRate: 0.5, roof: 3 });
  /** 柵で囲った資材置き場（中に木箱が積んである） */
  const yard = (cx: number, cy: number) => {
    const w = ri(9, 12);
    const h = ri(6, 8);
    const spot = findSpot(cx, cy, w, h, 8);
    if (!spot) return;
    const { x, y } = spot;
    reserve(x - 1, y - 1, w + 2, h + 2);
    for (let yy = y; yy < y + h; yy++)
      for (let xx = x; xx < x + w; xx++) {
        const edge = xx === x || yy === y || xx === x + w - 1 || yy === y + h - 1;
        setT(xx, yy, edge ? T_FENCE : T_DIRT);
      }
    setT(x + Math.floor(w / 2), y + h - 1, T_DIRT);
    setT(x + Math.floor(w / 2) + 1, y + h - 1, T_DIRT);
    for (let k = 0; k < ri(4, 7); k++) addObj(rnd() < 0.85 ? 'crate' : 'rubble', ri(x + 1, x + w - 2), ri(y + 1, y + h - 3));
    // 燃料のドラム缶（撃つと爆発する）
    const bx = ri(x + 1, x + w - 4);
    const by = ri(y + 1, y + h - 3);
    for (let k = 0; k < ri(2, 4); k++) addObj('barrel', bx + (k % 2), by + (k >> 1));
  };
  /** 建物の外壁沿いに置くドラム缶の山（工業地区） */
  const barrels = (b: { x: number; y: number } | null, w: number, h: number) => {
    if (!b) return;
    const side = rnd() < 0.5;
    const sx = side ? b.x - 2 : b.x + w + 1;
    const sy = b.y + ri(1, Math.max(1, h - 3));
    for (let k = 0; k < ri(2, 4); k++) addObj('barrel', sx + (k % 2) * (side ? -1 : 1), sy + (k >> 1));
  };
  /** 駐車場（舗装の上に放置車両） */
  const parking = (cx: number, cy: number) => {
    const w = ri(8, 11);
    const h = ri(5, 6);
    const spot = findSpot(cx, cy, w, h, 8);
    if (!spot) return;
    road(spot.x, spot.y, spot.x + w - 1, spot.y + h - 1);
    for (let k = 0; k < ri(2, 5); k++) addObj('car', ri(spot.x, spot.x + w - 1), ri(spot.y, spot.y + h - 1));
  };
  /** 森の小道（土の道。区画を横切って幹線どうしをつなぐ） */
  const trail = (x0: number, y0: number, x1: number, y1: number) => {
    let x = x0;
    let y = y0;
    for (let i = 0; i < 400 && (x !== x1 || y !== y1); i++) {
      if (!isWater(x, y) && terrain[idx(x, y)] !== T_BRIDGE) setT(x, y, T_DIRT);
      if (inMap(x, y)) reserved[idx(x, y)] = 1;
      if (x !== x1 && (y === y1 || rnd() < 0.55)) x += Math.sign(x1 - x);
      else y += Math.sign(y1 - y);
    }
  };

  for (const { x0: bx0, y0: by0, x1: bx1, y1: by1, db } of blocks) {
    const x0 = Math.max(3, bx0 + 1);
    const x1 = Math.min(MAP_W - 4, bx1 - 1);
    const y0 = Math.max(3, by0 + 1);
    const y1 = Math.min(MAP_H - 4, by1 - 1);
    if (x1 - x0 < 12 || y1 - y0 < 10) continue;
    const d = distOf((x0 + x1) / 2, (y0 + y1) / 2);
    if (d < 16) continue; // 拠点の区画
    const { tier, kind } = db;
    const rx = () => ri(x0 + 6, Math.max(x0 + 6, x1 - 6));
    const ry = () => ri(y0 + 5, Math.max(y0 + 5, y1 - 5));
    const rounds = Math.max(1, Math.min(4, Math.floor(((x1 - x0) * (y1 - y0)) / 380)));
    // 住宅街・商業地区には区画の中を通る生活道路（幹線につながる）
    if ((kind === 'residential' || kind === 'commercial' || kind === 'civic') && x1 - x0 > 26 && y1 - y0 > 22) {
      const sy = ri(y0 + 9, y1 - 10);
      // 川をまたぐ生活道路は、片方の岸の手前で行き止まり
      let wa = -1;
      let wb = -1;
      for (let x = bx0; x <= bx1; x++)
        if (isWater(x, sy) || isWater(x, sy + 1)) {
          if (wa < 0) wa = x;
          wb = x;
        }
      if (wa < 0) road(bx0, sy, bx1, sy + 1);
      else if (wa - 3 - bx0 >= bx1 - wb - 3 && wa - bx0 > 8) road(bx0, sy, wa - 3, sy + 1);
      else if (bx1 - wb > 8) road(wb + 3, sy, bx1, sy + 1);
      const sx = ri(x0 + 10, x1 - 11);
      let wet = false;
      for (let y = by0; y <= by1 && !wet; y++) wet = isWater(sx, y) || isWater(sx + 1, y) || isWater(sx - 3, y) || isWater(sx + 4, y);
      if (rnd() < 0.6 && !wet) road(sx, by0, sx + 1, by1);
    }
    if (kind === 'forest' || kind === 'wild') {
      if (rnd() < 0.7) trail(bx0, ri(y0, y1), bx1, ri(y0, y1));
      // 池（浅い縁は歩けるが、真ん中は深い）
      if (rnd() < (kind === 'forest' ? 0.45 : 0.25)) {
        const pw = ri(7, 12);
        const ph = ri(5, 9);
        const spot = findSpot(rx(), ry(), pw, ph, 8);
        if (spot) {
          reserve(spot.x - 1, spot.y - 1, pw + 2, ph + 2);
          const pcx = spot.x + pw / 2;
          const pcy = spot.y + ph / 2;
          for (let y = spot.y; y < spot.y + ph; y++)
            for (let x = spot.x; x < spot.x + pw; x++) {
              const e = ((x + 0.5 - pcx) / (pw / 2)) ** 2 + ((y + 0.5 - pcy) / (ph / 2)) ** 2;
              if (e <= 0.55) setT(x, y, T_WATER);
              else if (e <= 1) setT(x, y, T_SHALLOW);
            }
        }
      }
    }
    for (let round = 0; round < rounds; round++) {
      const r = rnd();
      switch (kind) {
        case 'residential':
          for (let k = 0; k < ri(2, 4); k++) house(tier, rx(), ry());
          if (r < 0.25) shop(tier, rx(), ry());
          else if (r < 0.35 && tier >= 2) ruin(tier, rx(), ry());
          break;
        case 'commercial':
          if (r < 0.35) market(tier, rx(), ry());
          else if (r < 0.65) for (let k = 0; k < 2; k++) shop(tier, rx(), ry());
          else if (r < 0.82) gas(tier, rx(), ry());
          else house(tier, rx(), ry());
          if (rnd() < 0.4) parking(rx(), ry());
          break;
        case 'industrial':
          if (r < 0.45) barrels(warehouse(tier, rx(), ry()), 16, 10);
          else if (r < 0.65) barrels(warehouse(tier, rx(), ry(), true), 18, 12);
          else if (r < 0.85) yard(rx(), ry());
          else gas(tier, rx(), ry());
          if (rnd() < 0.3) parking(rx(), ry());
          break;
        case 'civic':
          if (r < 0.35) hospital(tier, rx(), ry());
          else if (r < 0.65) police(tier, rx(), ry());
          else if (r < 0.8) hospital(tier, rx(), ry(), true);
          else shop(tier, rx(), ry());
          if (rnd() < 0.3) parking(rx(), ry());
          break;
        case 'military':
          if (round === 0 || r < 0.45) checkpoint(rx(), ry(), tier, tier >= 4 || rnd() < 0.3);
          else if (r < 0.75) police(tier, rx(), ry());
          else if (r < 0.9) warehouse(tier, rx(), ry());
          else ruin(tier, rx(), ry());
          break;
        case 'forest':
          if (round === 0 && r < 0.55) place('山小屋', 'house', tier, rx(), ry(), ri(6, 7), ri(5, 6), T_WOOD, { minRoom: 3, doors: 1, windows: 0.3, propRate: 0.5, roof: 2 });
          break;
        case 'wild':
          if (r < 0.5) ruin(tier, rx(), ry());
          else if (r < 0.62) gas(tier, rx(), ry());
          else if (r < 0.75) parking(rx(), ry());
          break;
      }
    }
    // 目印：遠い区画には煙・炎、工業地区の煙突、住宅街の給水塔
    if (tier >= 3 && rnd() < 0.4) landmarks.push({ x: rx(), y: ry(), kind: rnd() < 0.5 ? 'smoke' : 'fire', name: tier >= 4 ? '深部の黒煙' : '燃える残骸' });
    else if (kind === 'industrial' && rnd() < 0.4) landmarks.push({ x: rx(), y: ry(), kind: 'smoke', name: '工場の煙' });
    else if ((kind === 'residential' || kind === 'commercial') && rnd() < 0.3) landmarks.push({ x: rx(), y: ry(), kind: 'water', name: '給水塔' });
  }
  // 荒野は土の斑が多く、工業地区の地面は踏み固められた土
  for (let i = 0; i < 900; i++) {
    const cx = ri(0, MAP_W - 1);
    const cy = ri(0, MAP_H - 1);
    const k = distGrid[idx(cx, cy)];
    if (k !== 6 && k !== 2) continue;
    const r = ri(2, 6);
    for (let y = cy - r; y <= cy + r; y++)
      for (let x = cx - r; x <= cx + r; x++)
        if (inMap(x, y) && !reserved[idx(x, y)] && terrain[idx(x, y)] === T_GRASS && (x - cx) ** 2 + (y - cy) ** 2 <= r * r && rnd() < 0.75) setT(x, y, T_DIRT);
  }
  // 廃屋に瓦礫を散らす
  for (const l of locations) {
    if (l.kind !== 'ruin') continue;
    for (let k = 0; k < 3; k++) {
      const bx = l.x + ri(1, l.w - 2);
      const by = rnd() < 0.5 ? l.y : l.y + l.h - 1;
      setT(bx, by, T_FLOOR);
      addObj('rubble', bx, by);
    }
  }

  // ---- 廃車（道路沿い。遠くの幹線ほど放置車両が多い） ----
  for (let y = 1; y < MAP_H - 1; y++)
    for (let x = 1; x < MAP_W - 1; x++) {
      if (terrain[idx(x, y)] !== T_ROAD) continue;
      if (x >= sh.x - 2 && x <= sh.x + sh.w + 1 && y >= sh.y - 2 && y <= sh.y + sh.h + 1) continue;
      // 橋の上と、橋の前後（渡れる場所が限られるので車でふさがない）
      if (features.bridges.some((bb) => !bb.broken && x >= bb.x - 4 && x <= bb.x + bb.w + 3 && y >= bb.y - 1 && y <= bb.y + bb.h)) continue;
      // 国道は乗り捨てられた車の列が多い
      const onHwy = features.highways.some((h) => (h.horiz ? y >= h.at && y < h.at + h.w : x >= h.at && x < h.at + h.w));
      const p = (0.012 + tierAtDistance(distOf(x, y)) * 0.006) * (onHwy ? 1.8 : 1);
      if (rnd() < p) addObj('car', x, y);
    }

  // ---- 森・林：ノイズで濃淡（拠点のまわりは開けている） ----
  const forest = (x: number, y: number) => {
    const f = (sx: number, sy: number, sc: number) => {
      const xi = Math.floor(x / sc);
      const yi = Math.floor(y / sc);
      const xf = x / sc - xi;
      const yf = y / sc - yi;
      const hh = (a: number, b2: number) => {
        let v = (a * 374761393 + b2 * 668265263 + (seed + sx + sy) * 1442695041) | 0;
        v = Math.imul(v ^ (v >>> 13), 1274126177);
        return ((v ^ (v >>> 16)) >>> 0) / 4294967296;
      };
      const u = xf * xf * (3 - 2 * xf);
      const v2 = yf * yf * (3 - 2 * yf);
      const a0 = hh(xi, yi);
      const b0 = hh(xi + 1, yi);
      const c0 = hh(xi, yi + 1);
      const d0 = hh(xi + 1, yi + 1);
      return a0 + (b0 - a0) * u + (c0 - a0) * v2 + (a0 - b0 - c0 + d0) * u * v2;
    };
    return f(1, 2, 18) * 0.7 + f(3, 4, 6) * 0.3;
  };
  for (let y = 2; y < MAP_H - 2; y++)
    for (let x = 2; x < MAP_W - 2; x++) {
      if (reserved[idx(x, y)]) continue;
      const t = terrain[idx(x, y)];
      if (t !== T_GRASS && t !== T_DIRT) continue;
      if (distOf(x, y) < 14) continue;
      const fz = forest(x, y);
      // 地区ごとの木の密度：森林は深く、市街地はまばら（庭木程度）
      const dk = distGrid[idx(x, y)];
      const dens =
        dk === 5
          ? fz > 0.45
            ? 0.42
            : 0.2
          : dk === 0 || dk === 1 || dk === 3
            ? 0.006
            : dk === 2 || dk === 4
              ? 0.003
              : fz > 0.62
                ? 0.35
                : fz > 0.52
                  ? 0.08
                  : 0.012;
      if (rnd() < dens) addObj('tree', x, y);
    }
  // ---- 野外の木箱・瓦礫 ----
  for (let i = 0, placed = 0; i < 4000 && placed < 120; i++) {
    const x = ri(2, MAP_W - 3);
    const y = ri(2, MAP_H - 3);
    const t = terrain[idx(x, y)];
    if ((t === T_GRASS || t === T_DIRT) && !reserved[idx(x, y)] && distOf(x, y) > 12) {
      if (addObj(rnd() < 0.5 ? 'crate' : 'rubble', x, y)) placed++;
    }
  }

  // 汚染地帯：危険度2〜3の施設のうち1つが汚染され、手強い敵とレア物資が集まる
  const mids = locations.filter((l) => (l.tier === 2 || l.tier === 3) && l.kind !== 'ruin');
  if (mids.length) {
    const hot = mids[Math.floor(rnd() * mids.length)];
    hot.tier = 3;
    hot.hot = true;
    hot.name = `汚染された${hot.name}`;
    landmarks.push({ x: hot.x + hot.w / 2, y: hot.y + hot.h / 2, kind: 'smoke', name: '汚染地帯の煙' });
  }
  void CHUNK;
  // 拠点の無線機（依頼の報告）。既存のセーブと番号がずれないよう、最後に置く
  addObj('radio', SAFEHOUSE.x + 2 + 4, SAFEHOUSE.y + 2 + 1, 1);

  return { terrain, objs, locations, buildings, landmarks, districts, features, vec };
}

/** オブジェクトIDの開始値（実行中に作るオブジェクト用。生成オブジェクトと衝突しない値） */
export const BUILD_ID_START = 100000;
