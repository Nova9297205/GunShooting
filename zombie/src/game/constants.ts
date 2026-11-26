import type { BuildKind, ObjKind, WeaponId, ZombieType } from '../types';

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
/** 松明の明かりの半径(px) */
export const TORCH_LIGHT = 200;
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
  maxStamina: 100,
  dashStamina: 30,
  meleeStamina: 8,
  staminaRegen: 26,
  staminaDelay: 0.7,
};

/** 共有チェストに入れられるアイテム（表示名・1回で動かす量） */
export const CHEST_ITEMS: { id: string; name: string; step: number }[] = [
  { id: 'ammo', name: '弾薬', step: 12 },
  { id: 'shells', name: 'シェル', step: 6 },
  { id: 'gunpowder', name: '火薬', step: 1 },
  { id: 'food', name: '食料', step: 1 },
  { id: 'medkit', name: '救急キット', step: 1 },
  { id: 'cloth', name: '布', step: 1 },
  { id: 'herb', name: '薬草', step: 1 },
  { id: 'parts', name: '武器パーツ', step: 1 },
  { id: 'kit', name: 'タレットキット', step: 1 },
];

export interface WeaponStats {
  name: string;
  magSize: number;
  fireInterval: number;
  reloadTime: number;
  bulletSpeed: number;
  bulletLife: number;
  damage: number;
  spread: number;
  pellets: number;
  knock: number;
  auto: boolean;
  noiseRadius: number;
  /** 撃ったときのカメラの揺れ */
  kick: number;
}

export const WEAPONS: Record<WeaponId, WeaponStats> = {
  pistol: { name: 'ハンドガン', magSize: 12, fireInterval: 0.2, reloadTime: 1.3, bulletSpeed: 1000, bulletLife: 0.65, damage: 24, spread: 0.035, pellets: 1, knock: 110, auto: false, noiseRadius: 650, kick: 2.5 },
  rifle: { name: 'アサルトライフル', magSize: 30, fireInterval: 0.095, reloadTime: 1.7, bulletSpeed: 1150, bulletLife: 0.7, damage: 20, spread: 0.06, pellets: 1, knock: 80, auto: true, noiseRadius: 800, kick: 2 },
  shotgun: { name: 'ショットガン', magSize: 6, fireInterval: 0.6, reloadTime: 2.0, bulletSpeed: 900, bulletLife: 0.32, damage: 15, spread: 0.32, pellets: 7, knock: 170, auto: false, noiseRadius: 900, kick: 7 },
};

/** 銃口までの距離 */
export const MUZZLE = 26;
/** 互換用（旧コード参照） */
export const GUN = { muzzle: MUZZLE, reloadTime: WEAPONS.pistol.reloadTime, magSize: WEAPONS.pistol.magSize };

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
  torch: 60,
  mcrate: 1,
  bench: 1,
  barbed: 140,
  turret: 320,
  chest: 1,
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
  'mcrate',
  'bench',
  'turret',
  'chest',
]);

/** プレイヤーの弾を止めるオブジェクト（建築壁・石壁の上は撃ち越せる） */
export const BULLET_BLOCK_KINDS: ReadonlySet<ObjKind> = new Set<ObjKind>(['tree', 'car', 'crate', 'box', 'mcrate', 'bench', 'chest']);

/** ゾンビが破壊して進む建築物 */
export const BREAKABLE_KINDS: ReadonlySet<ObjKind> = new Set<ObjKind>(['stone', 'woodWall', 'ironWall', 'turret']);

export const BUILD_COST: Record<BuildKind, { wood: number; scrap: number }> = {
  woodWall: { wood: 5, scrap: 0 },
  ironWall: { wood: 0, scrap: 6 },
  spike: { wood: 4, scrap: 0 },
  torch: { wood: 2, scrap: 0 },
  barbed: { wood: 0, scrap: 3 },
  turret: { wood: 0, scrap: 4 },
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
  crate: 150,
  mcrate: 300,
  box: 0, // 収納箱は毎朝補充
};

/** ホットバー（9スロット） */
export const SLOTS = [
  { id: 0, key: '1', name: '斧（近接・解体）', short: 'MELEE' },
  { id: 1, key: '2', name: '銃', short: 'GUN' },
  { id: 2, key: '3', name: 'ショットガン', short: 'SHOTGUN' },
  { id: 3, key: '4', name: '建築・修理', short: 'BUILD' },
  { id: 4, key: '5', name: '食料', short: 'FOOD' },
  { id: 5, key: '6', name: '救急キット', short: 'MED' },
  { id: 6, key: '7', name: '', short: '' },
  { id: 7, key: '8', name: '', short: '' },
  { id: 8, key: '9', name: '', short: '' },
] as const;
/** 中身のある（選択できる）スロット数 */
export const USABLE_SLOTS = 6;

/** 建築ツールの設計図（B キーで切替） */
export const BLUEPRINTS: { kind: BuildKind; name: string }[] = [
  { kind: 'woodWall', name: '木の壁' },
  { kind: 'ironWall', name: '鉄の壁' },
  { kind: 'spike', name: 'ウッドスパイク' },
  { kind: 'torch', name: '松明' },
  { kind: 'barbed', name: '有刺鉄線' },
  { kind: 'turret', name: '自動タレット' },
];

/** 有刺鉄線：上を通るゾンビを大きく減速＋少しダメージ */
export const BARBED = { dps: 9, slow: 0.32, wearPerSec: 3 };

/** 自動タレット */
export const TURRET = { range: 340, fireInterval: 0.3, damage: 17, maxAmmo: 60, startAmmo: 30, noise: 260 };

/** クラフト素材の名前 */
export const MATERIAL_NAMES = {
  wood: '木材',
  scrap: '鉄',
  gunpowder: '火薬',
  cloth: '布',
  herb: '薬草',
  parts: '武器パーツ',
} as const;
export type MaterialId = keyof typeof MATERIAL_NAMES;

export interface Recipe {
  id: string;
  name: string;
  desc: string;
  /** 作業台の近くでしか作れない */
  bench: boolean;
  cost: Partial<Record<MaterialId, number>>;
}

/** クラフトレシピ（木材・鉄はチーム共有、それ以外は個人の持ち物から消費） */
export const RECIPES: Recipe[] = [
  { id: 'ammo', name: '弾薬 ×10', desc: 'ハンドガン・ライフル用の弾', bench: false, cost: { gunpowder: 1, scrap: 1 } },
  { id: 'shells', name: 'ショットガンシェル ×6', desc: 'ショットガン用の散弾', bench: false, cost: { gunpowder: 2, scrap: 1 } },
  { id: 'medkit', name: '救急キット', desc: 'HPを55回復する', bench: false, cost: { cloth: 2, herb: 1 } },
  { id: 'kit', name: 'タレットキット', desc: '建築ツールで設置。近づくゾンビを自動で撃つ（[F]で弾を補充）', bench: true, cost: { scrap: 8, parts: 2, gunpowder: 2 } },
  { id: 'rifle', name: 'アサルトライフル', desc: '銃をフルオート30連発に強化', bench: true, cost: { parts: 3, scrap: 10 } },
  { id: 'shotgun', name: 'ショットガン', desc: '近距離の群れを一掃する散弾銃', bench: true, cost: { parts: 2, scrap: 8, wood: 4 } },
  { id: 'axe', name: '鋼の斧', desc: '近接ダメージ1.6倍・採取量2倍', bench: true, cost: { scrap: 6, parts: 1 } },
];

/** 作業台を使える距離(px) */
export const BENCH_RANGE = 110;

// ---------------- 地形 ----------------
export const T_GRASS = 0;
export const T_WALL = 1; // 廃墟の壁（破壊不可）
export const T_ROAD = 2;
export const T_FLOOR = 3;
export const T_DIRT = 4;

/** セーフハウス（タイル座標） */
export const SAFEHOUSE = { x: 34, y: 25, w: 12, h: 10 };
export const CAMPFIRE_TILE = { x: 40, y: 30 };
