import type { BuildKind, ObjKind, ZombieType } from '../types';

// ---------------- ワールド / 通信 ----------------
export const TILE = 40;
export const MAP_W = 80; // タイル数
export const MAP_H = 60;
export const WORLD_W = MAP_W * TILE;
export const WORLD_H = MAP_H * TILE;

export const TICK_RATE = 60;
export const TICK_DT = 1 / TICK_RATE;
/** 60/2 = 30Hz でスナップショット送信 */
export const SNAPSHOT_EVERY = 2;
export const INTERP_DELAY = 0.1;
export const MAX_PLAYERS = 3;
export const NAME_MAX = 10;

export const PLAYER_COLORS = ['#4da3ff', '#5be37d', '#ffd84d'];

// ---------------- 時間（昼夜サイクル） ----------------
/** 06:00〜20:00 の昼（実時間秒） */
export const DAY_SECONDS = 90;
/** 20:00〜06:00 の夜（実時間秒） */
export const NIGHT_SECONDS = 45;
export const CYCLE_SECONDS = DAY_SECONDS + NIGHT_SECONDS;
/** 何日ごとに大襲撃（ホード）が来るか */
export const HORDE_EVERY = 5;
/** ゲーム開始時刻（分） */
export const START_MINUTE = 8 * 60;

// ---------------- プレイヤー ----------------
export const PLAYER = {
  radius: 14,
  speed: 200,
  downSpeed: 30,
  maxHp: 100,
  dashSpeed: 620,
  dashTime: 0.16,
  dashCooldown: 1.6,
  downTime: 40,
  reviveTime: 2.5,
  reviveRange: 60,
  reviveHpRatio: 0.5,
  interactRange: 62,
  buildRange: 170,
  /** 空腹ゲージが 100→0 になるまでの秒数 */
  hungerSeconds: 260,
  /** 空腹0のときのHP減少/秒 */
  starveDps: 1.5,
  foodValue: 40,
  medkitValue: 55,
};

export const GUN = {
  magSize: 12,
  fireInterval: 0.17,
  reloadTime: 1.4,
  bulletSpeed: 1000,
  bulletLife: 0.65,
  damage: 22,
  spread: 0.04,
  muzzle: 26,
  noiseRadius: 700,
};

export const AXE = {
  interval: 0.45,
  range: 58,
  arc: Math.PI * 0.6,
  damage: 28,
  harvestDamage: 20,
  noiseRadius: 160,
};

/** 火薬 → 弾薬クラフト */
export const CRAFT = { gunpowder: 2, ammo: 12 };

// ---------------- ゾンビ ----------------
export interface ZombieStats {
  radius: number;
  hp: number;
  daySpeed: number;
  nightSpeed: number;
  damage: number;
  wallDamage: number;
  attackInterval: number;
  color: string;
  skin: string;
}

export const ZOMBIE: Record<ZombieType, ZombieStats> = {
  walker: { radius: 14, hp: 60, daySpeed: 42, nightSpeed: 88, damage: 10, wallDamage: 18, attackInterval: 1.0, color: '#5f7d4a', skin: '#9bb07a' },
  runner: { radius: 12, hp: 40, daySpeed: 70, nightSpeed: 150, damage: 7, wallDamage: 10, attackInterval: 0.7, color: '#7a5a4a', skin: '#c2a080' },
  brute: { radius: 22, hp: 280, daySpeed: 35, nightSpeed: 62, damage: 24, wallDamage: 65, attackInterval: 1.3, color: '#4f5b3c', skin: '#7f9160' },
};

export const ZOMBIE_SENSE = {
  dayRange: 230,
  nightRange: 360,
  aggroMemory: 7,
};

// ---------------- オブジェクト / 建築 ----------------
export const OBJ_HP: Record<ObjKind, number> = {
  tree: 60,
  car: 140,
  crate: 1,
  box: 1,
  campfire: 1,
  stone: 1600,
  woodWall: 320,
  ironWall: 950,
  spike: 160,
};

/** 衝突する（通れない）オブジェクト */
export const SOLID_KINDS: ReadonlySet<ObjKind> = new Set<ObjKind>([
  'tree',
  'car',
  'crate',
  'box',
  'stone',
  'woodWall',
  'ironWall',
]);

/** プレイヤーの弾を止めるオブジェクト（建築壁・石壁の上は撃ち越せる） */
export const BULLET_BLOCK_KINDS: ReadonlySet<ObjKind> = new Set<ObjKind>(['tree', 'car', 'crate', 'box']);

/** ゾンビが破壊して進む建築物 */
export const BREAKABLE_KINDS: ReadonlySet<ObjKind> = new Set<ObjKind>(['stone', 'woodWall', 'ironWall']);

export const BUILD_COST: Record<BuildKind, { wood: number; scrap: number }> = {
  woodWall: { wood: 5, scrap: 0 },
  ironWall: { wood: 0, scrap: 6 },
  spike: { wood: 4, scrap: 0 },
};

export const SPIKE = {
  dps: 30,
  slow: 0.45,
  wearPerSec: 7,
};

export const REPAIR = {
  interval: 0.35,
  amount: 70,
};

export const REGROW = {
  tree: 150,
  car: 220,
  crate: 110,
  box: 0, // 収納箱は毎朝補充
};

export const TOOLS = [
  { id: 0, key: '1', name: '拳銃', short: 'GUN' },
  { id: 1, key: '2', name: '斧（近接/解体）', short: 'AXE' },
  { id: 2, key: '3', name: '木の壁', short: 'WOOD' },
  { id: 3, key: '4', name: '鉄の壁', short: 'IRON' },
  { id: 4, key: '5', name: 'ウッドスパイク', short: 'SPIKE' },
  { id: 5, key: '6', name: '修理', short: 'FIX' },
] as const;

export const TOOL_BUILD: Record<number, BuildKind | undefined> = {
  2: 'woodWall',
  3: 'ironWall',
  4: 'spike',
};

// ---------------- 地形 ----------------
export const T_GRASS = 0;
export const T_WALL = 1; // 廃墟の壁（破壊不可）
export const T_ROAD = 2;
export const T_FLOOR = 3;
export const T_DIRT = 4;

/** セーフハウス（タイル座標） */
export const SAFEHOUSE = { x: 34, y: 25, w: 12, h: 10 };
export const CAMPFIRE_TILE = { x: 40, y: 30 };
