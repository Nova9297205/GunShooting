import type { ObjKind, ZombieType } from '../types';
import type { ItemId } from './items';

// ---------------- ワールド / 通信 ----------------
export const TILE = 40;
export const MAP_W = 360; // タイル数（広大なオープンワールド：18×14 チャンク）
export const MAP_H = 280;
/** チャンク（区画）の一辺のタイル数。描画・シミュレーションはチャンク単位で動的に管理する */
export const CHUNK = 20;
export const CHUNKS_X = MAP_W / CHUNK;
export const CHUNKS_Y = MAP_H / CHUNK;
export const WORLD_W = MAP_W * TILE;
export const WORLD_H = MAP_H * TILE;

export const TICK_RATE = 60;
export const TICK_DT = 1 / TICK_RATE;
/** 60/2 = 30Hz でスナップショット送信 */
export const SNAPSHOT_EVERY = 2;
export const INTERP_DELAY = 0.1;
export const MAX_PLAYERS = 3;
export const NAME_MAX = 10;

/** プレイヤー識別色（彩度を落としたミリタリー調：スチールブルー / オリーブ / オーカー） */
export const PLAYER_COLORS = ['#7f9cb8', '#93a86a', '#c4a35c'];

// ---------------- 時間（昼夜サイクル） ----------------
/** 06:00〜20:00 の昼（実時間秒）：遠征・探索にじっくり使える長さ */
export const DAY_SECONDS = 660;
/** 20:00〜06:00 の夜（実時間秒）：拠点で休む（ベッドで眠れば朝まで飛ばせる）か、闇の中を進むか */
export const NIGHT_SECONDS = 270;
export const CYCLE_SECONDS = DAY_SECONDS + NIGHT_SECONDS;
/** 松明の明かりの半径(px) */
export const TORCH_LIGHT = 200;
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
  hungerSeconds: 840,
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



/** 銃口までの距離 */
export const MUZZLE = 26;

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
  /** 装甲（通常弾のダメージ軽減率） */
  armor: number;
}

export const ZOMBIE: Record<ZombieType, ZombieStats> = {
  walker: { radius: 14, hp: 60, daySpeed: 42, nightSpeed: 88, damage: 10, wallDamage: 18, attackInterval: 1.0, color: '#565a4a', skin: '#8e9278', armor: 0 },
  runner: { radius: 12, hp: 40, daySpeed: 70, nightSpeed: 150, damage: 7, wallDamage: 10, attackInterval: 0.7, color: '#5c5048', skin: '#a2968a', armor: 0 },
  soldier: { radius: 14, hp: 150, daySpeed: 55, nightSpeed: 92, damage: 16, wallDamage: 30, attackInterval: 0.9, color: '#4a4f3c', skin: '#8a8c76', armor: 0.4 },
  brute: { radius: 22, hp: 280, daySpeed: 35, nightSpeed: 62, damage: 24, wallDamage: 65, attackInterval: 1.3, color: '#46483e', skin: '#7a7e6a', armor: 0.3 },
  /** 膨張体：遅いが倒すと毒ガスを撒く（工業地区・病院） */
  bloater: { radius: 18, hp: 130, daySpeed: 30, nightSpeed: 56, damage: 9, wallDamage: 20, attackInterval: 1.2, color: '#4e5a3a', skin: '#9aa06a', armor: 0 },
  /** 叫び屋：獲物を見つけると叫び、周りのゾンビを呼び寄せる（商業地区・荒野） */
  screamer: { radius: 12, hp: 45, daySpeed: 52, nightSpeed: 112, damage: 5, wallDamage: 6, attackInterval: 0.8, color: '#5a5450', skin: '#b8b0a0', armor: 0 },
  /** 巨像（ボス）：ボスの夜にだけ現れる。突進で壁を破り、地鳴りで周りを吹き飛ばす */
  titan: { radius: 34, hp: 7000, daySpeed: 40, nightSpeed: 58, damage: 30, wallDamage: 160, attackInterval: 1.5, color: '#3a3c34', skin: '#8a7e6a', armor: 0.35 },
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
  door: 110,
  shelf: 1,
  cabinet: 1,
  locker: 1,
  wcase: 1,
  fridge: 1,
  desk: 1,
  bed: 1,
  rubble: 1,
  sandbag: 400,
  stash: 1,
  bag: 1,
  drop: 1,
  barrel: 30,
  raintank: 200,
  stove: 220,
  cot: 150,
  wbench: 300,
  sbox: 300,
  fire: 120,
  radio: 1,
};

/** 衝突する（通れない）オブジェクト */
export const SOLID_KINDS: ReadonlySet<ObjKind> = new Set<ObjKind>([
  'barrel',
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
  'door',
  'shelf',
  'cabinet',
  'locker',
  'wcase',
  'fridge',
  'desk',
  'bed',
  'sandbag',
  'stash',
  'raintank',
  'stove',
  'radio',
  'cot',
  'wbench',
  'sbox',
]);

/** プレイヤーの弾を止めるオブジェクト（建築壁・石壁の上は撃ち越せる） */
export const BULLET_BLOCK_KINDS: ReadonlySet<ObjKind> = new Set<ObjKind>(['tree', 'car', 'crate', 'box', 'mcrate', 'bench', 'chest', 'door', 'shelf', 'locker', 'fridge', 'sandbag', 'stash', 'barrel']);

/** ゾンビが破壊して進む建築物 */
export const BREAKABLE_KINDS: ReadonlySet<ObjKind> = new Set<ObjKind>(['stone', 'woodWall', 'ironWall', 'turret', 'door']);





/** ホットバー（キー 1〜5。6〜9 は空き） */
export const SLOTS = [
  { id: 0, key: '1', name: '斧（近接）', short: 'MELEE' },
  { id: 1, key: '2', name: 'メイン武器', short: 'PRIMARY' },
  { id: 2, key: '3', name: 'サブ武器', short: 'SIDEARM' },
  { id: 3, key: '4', name: '回復', short: 'MEDS' },
  { id: 4, key: '5', name: '食料', short: 'FOOD' },
  { id: 5, key: '6', name: '', short: '' },
  { id: 6, key: '7', name: '', short: '' },
  { id: 7, key: '8', name: '', short: '' },
  { id: 8, key: '9', name: '', short: '' },
] as const;
/** 中身のある（選択できる）スロット数 */
export const USABLE_SLOTS = 5;




export interface Recipe {
  id: string;
  name: string;
  desc: string;
  /** 作業台の近くでしか作れない */
  bench: boolean;
  cost: Partial<Record<ItemId, number>>;
  out: { id: ItemId; n: number };
  /** 必要な作業台レベル（1〜3） */
  lv?: number;
  /** 作業台ではなく、拠点のかまどの近くで作る（料理） */
  station?: 'stove';
}

/** クラフトレシピ（素材はバックパックから消費し、完成品はバックパックへ） */
export const RECIPES: Recipe[] = [
  { id: 'bandage', name: '包帯', desc: '布から包帯を作る', bench: false, cost: { cloth: 2 }, out: { id: 'bandage', n: 1 } },
  { id: 'ammo9', name: '9mm弾 ×15', desc: 'ハンドガン・SMG 用', bench: true, cost: { gunpowder: 1, scrap: 1 }, out: { id: 'ammo9', n: 15 } },
  { id: 'ammo762', name: '7.62mm弾 ×10', desc: 'ライフル用', bench: true, cost: { gunpowder: 2, scrap: 2 }, out: { id: 'ammo762', n: 10 } },
  { id: 'shells', name: '12ゲージ散弾 ×6', desc: 'ショットガン用', bench: true, cost: { gunpowder: 2, scrap: 1 }, out: { id: 'shells', n: 6 } },
  { id: 'medkit', name: '救急キット', desc: '包帯と薬品を調合', bench: true, cost: { bandage: 2, chem: 1 }, out: { id: 'medkit', n: 1 } },
  { id: 'grip', name: 'フォアグリップ', desc: '連射時の反動を大きく軽減', bench: true, cost: { parts: 1, scrap: 3 }, out: { id: 'grip', n: 1 } },
  { id: 'extmag', name: '拡張マガジン', desc: '装弾数 +60%', bench: true, cost: { parts: 2, scrap: 3 }, out: { id: 'extmag', n: 1 } },
  { id: 'ammo9ap', name: '9mm徹甲弾 ×10', desc: '装甲を無視し1体貫通', bench: true, lv: 2, cost: { gunpowder: 2, scrap: 2, parts: 1 }, out: { id: 'ammo9ap', n: 10 } },
  { id: 'ammo762ap', name: '7.62mm徹甲弾 ×8', desc: '装甲を無視し2体まで貫通', bench: true, lv: 2, cost: { gunpowder: 3, scrap: 2, parts: 1 }, out: { id: 'ammo762ap', n: 8 } },
  { id: 'slug', name: 'スラッグ弾 ×5', desc: 'ショットガンの一粒弾', bench: true, lv: 2, cost: { gunpowder: 2, scrap: 2 }, out: { id: 'slug', n: 5 } },
  { id: 'holo', name: 'ホロサイト', desc: '集弾率と反動を改善', bench: true, lv: 2, cost: { parts: 1, electronics: 1, scrap: 2 }, out: { id: 'holo', n: 1 } },
  { id: 'stim', name: '興奮剤', desc: 'HP +15・スタミナ全快', bench: true, lv: 2, cost: { chem: 2, medkit: 1 }, out: { id: 'stim', n: 1 } },
  { id: 'suppressor', name: 'サプレッサー', desc: '銃声を約1/3に抑える', bench: true, lv: 3, cost: { parts: 2, scrap: 4, tools: 1 }, out: { id: 'suppressor', n: 1 } },
  { id: 'scope', name: '4倍スコープ', desc: '集弾率が大きく上がり視界が伸びる', bench: true, lv: 3, cost: { parts: 2, electronics: 2, scrap: 2 }, out: { id: 'scope', n: 1 } },
  { id: 'splint', name: '添え木', desc: '骨折の手当て（足が遅い・ダッシュできない状態を治す）', bench: false, cost: { cloth: 2, scrap: 1 }, out: { id: 'splint', n: 1 } },
  { id: 'salve', name: '薬草の軟膏', desc: '出血を止める・HP +15', bench: false, cost: { herbs: 2, cloth: 1 }, out: { id: 'salve', n: 1 } },
  { id: 'painkiller', name: '鎮痛剤', desc: 'HP +10・疲労 -25', bench: true, cost: { chem: 1, herbs: 1 }, out: { id: 'painkiller', n: 1 } },
  { id: 'decoy', name: 'おとり時計', desc: '投げた所で10秒鳴り、ゾンビを引き寄せる', bench: true, cost: { electronics: 1, scrap: 1 }, out: { id: 'decoy', n: 1 } },
  { id: 'pipebomb', name: 'パイプ爆弾', desc: '投げて2秒後に爆発。群れをまとめて倒す', bench: true, lv: 2, cost: { gunpowder: 3, scrap: 2, chem: 1 }, out: { id: 'pipebomb', n: 1 } },
  { id: 'upkit', name: '武器強化キット', desc: '手に持っている武器の品質を1段上げる（希少まで）', bench: true, lv: 2, cost: { parts: 3, scrap: 4, tools: 1 }, out: { id: 'upkit', n: 1 } },
  { id: 'heartkit', name: '強化キット ×2', desc: '巨像の心臓から武器強化キットを作る', bench: true, lv: 2, cost: { bheart: 1 }, out: { id: 'upkit', n: 2 } },
  { id: 'pack1', name: '学生かばん', desc: '背負うとバッグ +3マス・+6kg', bench: false, cost: { cloth: 5, scrap: 1 }, out: { id: 'pack1', n: 1 } },
  { id: 'pack2', name: '登山リュック', desc: '背負うとバッグ +6マス・+13kg', bench: true, lv: 2, cost: { cloth: 9, scrap: 4, parts: 1 }, out: { id: 'pack2', n: 1 } },
  { id: 'coat', name: '防寒コート', desc: '持っているだけで雨・夜の冷えが半分に', bench: true, cost: { cloth: 6, scrap: 1 }, out: { id: 'coat', n: 1 } },
  { id: 'stew', name: '温かいシチュー', desc: '空腹 +60・HP +20・6分間 休息済み', bench: false, station: 'stove', cost: { water: 1, can: 1, herbs: 1 }, out: { id: 'stew', n: 1 } },
  { id: 'tea', name: 'ハーブティー', desc: '汚染度 -30・HP +8・2分間 休息済み', bench: false, station: 'stove', cost: { water: 1, herbs: 1 }, out: { id: 'tea', n: 1 } },
  { id: 'tools', name: '工具セット', desc: '拠点強化の素材', bench: true, lv: 3, cost: { scrap: 10, parts: 2 }, out: { id: 'tools', n: 1 } },
];

// ---------------- 拠点に建てる物 ----------------
export type BuildKind = 'woodWall' | 'ironWall' | 'spike' | 'torch' | 'raintank' | 'stove' | 'cot' | 'wbench' | 'sbox' | 'fire';
export interface BuildDef {
  kind: BuildKind;
  name: string;
  /** 役割（防御・罠・明かり・生産・調理） */
  role: string;
  desc: string;
  cost: Partial<Record<ItemId, number>>;
  hp: number;
  /** 必要な作業台レベル */
  lv?: number;
}
export const BUILDS: BuildDef[] = [
  { kind: 'woodWall', name: '木のバリケード', role: '防御', desc: '門や隙間を塞ぐ。大群はこれを壊して入ろうとする', cost: { scrap: 4, cloth: 1 }, hp: 750 },
  { kind: 'ironWall', name: '鉄板バリケード', role: '防御', desc: '木の約2.5倍の耐久。作業台Lv2', cost: { scrap: 7, parts: 1 }, hp: 1800, lv: 2 },
  { kind: 'spike', name: '釘の罠', role: '罠', desc: '踏んだゾンビに大ダメージ・足止め。使うほど傷む', cost: { scrap: 4 }, hp: 300 },
  { kind: 'torch', name: 'たいまつ', role: '明かり', desc: '夜の拠点を照らす。光の中は敵が見える', cost: { cloth: 2, scrap: 1 }, hp: 80 },
  { kind: 'raintank', name: '雨水タンク', role: '生産', desc: '雨・嵐で水が貯まる（毎朝も少し）。[F] で回収', cost: { scrap: 6, cloth: 2 }, hp: 200 },
  { kind: 'stove', name: '調理かまど', role: '調理', desc: '水・缶詰・薬草で温かい料理。[F] で料理メニュー', cost: { scrap: 5, parts: 1 }, hp: 220 },
  { kind: 'cot', name: '寝床', role: '睡眠', desc: 'どこでも夜に眠れる。最後に眠った寝床が、戦闘不能から戻る場所になる', cost: { cloth: 6, scrap: 2 }, hp: 150 },
  { kind: 'wbench', name: '作業台', role: 'クラフト', desc: '拠点の外でもクラフト・改造ができる（レベルは拠点の作業台と同じ）', cost: { scrap: 10, parts: 1 }, hp: 300 },
  { kind: 'sbox', name: '保管箱', role: '収納', desc: '16 マスの箱。中身はずっと残る（撤去は空にしてから）', cost: { scrap: 6 }, hp: 300 },
  { kind: 'fire', name: '焚き火', role: '暖・明かり', desc: '体が温まり、そばで食べると休息済み。夜は明るい', cost: { scrap: 2, cloth: 1 }, hp: 120 },
];
export const BUILD_KINDS: ReadonlySet<ObjKind> = new Set<ObjKind>(BUILDS.map((b) => b.kind));
/** 建てた物は補強されていて、ゾンビの攻撃で受けるダメージがこの倍率になる */
export const BUILD_DAMAGE_MUL = 0.25;
/** 建てられる距離（タイル） */
export const BUILD_RANGE = 6;
/** 雨水タンクに貯まる水の上限 */
export const RAINTANK_MAX = 6;

/** 作業台を使える距離(px) */
export const BENCH_RANGE = 110;

// ---------------- 地形 ----------------
export const T_GRASS = 0;
export const T_WALL = 1; // 廃墟の壁（破壊不可）
export const T_ROAD = 2;
export const T_FLOOR = 3;
export const T_DIRT = 4;
export const T_WINDOW = 5; // ガラス窓（通れないが、見通せて撃ち抜ける）
export const T_WOOD = 6; // フローリング
export const T_TILE = 7; // タイル床
export const T_FENCE = 8; // 金網フェンス（通れないが見通せる）
export const T_WATER = 9; // 川・池（泳いで渡れない。見通せて、弾は水面を越えて飛ぶ）
export const T_SHALLOW = 10; // 浅瀬（歩いて渡れるが足が遅くなる）
export const T_BRIDGE = 11; // 橋（道路と同じく通れる）
/** 浅瀬での移動速度の倍率 */
export const SHALLOW_SPEED = 0.55;

/** 屋内の床 */
export const INDOOR_FLOORS: ReadonlySet<number> = new Set([T_FLOOR, T_WOOD, T_TILE]);

/** 倉庫の大きさ */
export const STORAGE_SHARED = 40;
export const STORAGE_PERSONAL = 24;

/** 拠点の敷地（タイル座標）：フェンスで囲まれた安全地帯（ゾンビは入ってこない） */
/** 拠点（地図の中心）のタイル座標：危険度は拠点からの距離で決まる */
export const BASE_TX = MAP_W / 2;
export const BASE_TY = MAP_H / 2;
export const SAFEHOUSE = { x: BASE_TX - 9, y: BASE_TY - 9, w: 18, h: 17 };
export const CAMPFIRE_TILE = { x: BASE_TX + 4, y: BASE_TY + 3 };
