// ============================================================
// HostSimulation: ホスト権限のゲーム計算（探索・漁り・生還型サバイバル）
//   - 時間経過（昼夜）。強制ウェーブはなく、ゾンビは各建物・危険地帯に潜んでいる
//   - ゾンビAI：視覚（向き・距離・懐中電灯の光）と聴覚（銃声・ドア・走る足音）で
//     徘徊 → 物音を調べる → 追跡 → 見失って捜索、と状態が変わる。閉じたドアは叩き壊す
//   - 入れ物（棚・ロッカー・武器ケースなど）は数秒の「探索」で中身が見られる
//   - バックパックはスロット制。拠点の倉庫に預けたものが「持ち帰った物資」
//   ソロ・ホスト時のみ実行され、ゲストはスナップショットを受け取るだけ
// ============================================================
import type {
  Job,
  SiteSnap,
  VehicleSnap,
  GameEvent,
  GameResult,
  InputFrame,
  LobbyPlayer,
  ObjKind,
  ObjSnap,
  PlayerSnap,
  RescueSnap,
  RunMode,
  Slot,
  Snapshot,
  SoundKey,
  StorageState,
  TimePhase,
  ViewState,
  Weather,
  ZombieSnap,
  ZombieType,
} from '../types';
import { Tool } from '../types';
import {
  AXE,
  BENCH_RANGE,
  BASE_TX,
  BASE_TY,
  BREAKABLE_KINDS,
  BUILD_KINDS,
  BUILD_DAMAGE_MUL,
  RAINTANK_MAX,
  CHUNK,
  CHUNKS_X,
  CHUNKS_Y,
  CAMPFIRE_TILE,
  INDOOR_FLOORS,
  T_ROAD,
  CYCLE_SECONDS,
  DAY_SECONDS,
  MAP_H,
  MAP_W,
  MUZZLE,
  NIGHT_SECONDS,
  PLAYER,
  RECIPES,
  SAFEHOUSE,
  START_MINUTE,
  T_FENCE,
  T_SHALLOW,
  T_WALL,
  T_WATER,
  T_WINDOW,
  TILE,
  USABLE_SLOTS,
  WORLD_H,
  WORLD_W,
  ZOMBIE,
} from './constants';
import { lastCollided, seatPos, stepVehicle, trunkPos, VEHICLE } from './vehicles';
import { jobReward, makeJobs, radioLevel, rewardMul } from './jobs';
import { buildDef, buildSpotError, canAfford } from './build';
import {
  addItem,
  QUALITY,
  rollQuality,
  BACKPACK_SLOTS,
  capacityOf,
  lastAddLimitedByWeight,
  loadKg,
  PACKS,
  setBagLimits,
  slotKg,
  ammoOf,
  ATTACHMENTS,
  bagValue,
  countItem,
  effectiveStats,
  emptyBag,
  freeSlots,
  ITEMS,
  type ItemId,
  isWeapon,
  removeItem,
  WEAPON_STATS,
  type WeaponId,
  heldWeapon,
} from './items';
import { angleDiff, circleOverlapsTile, moveCircle, stepMovement } from './physics';
import { type Facility, FACILITIES, MED_REGEN, SKILLS, levelOf, sanitizeProfile, skillMods, STORAGE_SIZES } from './progression';
import { TUT_ALL, TUT_BUILD, TUT_CRAFT, TUT_JOB, TUT_REWARD, TUT_SEARCH, TUT_SLEEP, TUT_STEPS } from './tutorial';
import { BUILD_ID_START, type DistrictKind, districtAt, directionName, EDGE_BAND, edgeDistance, generateWorld, type Location, locationAt, objIsSolid, tierAtDistance, TileWorld } from './world';

interface SimPlayer extends PlayerSnap {
  queue: InputFrame[];
  /** 骨折が治るまでの秒数 */
  fracT?: number;
  fire: boolean;
  revive: boolean;
  tx: number;
  ty: number;
  fireCd: number;
  swingCd: number;
  warnCd: number;
  useCd: number;
  idle: number;
  reloadSlot: 'prim' | 'sec' | '';
  search: { cid: number; t: number; dur: number; x: number; y: number } | null;
  /** 足音の発生タイマー */
  stepNoiseT: number;
  /** 興奮剤の残り時間 */
  stimT: number;
  /** 汚染の警告を出した段階 */
  toxWarn: number;
  /** 汚染でせき込む（物音）タイマー */
  coughT: number;
  /** レベルアップ表示済みのレベル */
  lv: number[];
}

type ZState = 'idle' | 'investigate' | 'chase' | 'search';

interface SimZombie extends ZombieSnap {
  kx: number;
  ky: number;
  attackCd: number;
  state: ZState;
  stateT: number;
  targetX: number;
  targetY: number;
  homeX: number;
  homeY: number;
  wanderA: number;
  wanderT: number;
  senseT: number;
  speedMul: number;
  stuckT: number;
  /** 巡回ルート（ロケーション間を移動する群れ） */
  route: { x: number; y: number }[] | null;
  routeI: number;
  /** チャンクが非アクティブになっても消さない（補給物資の護衛など） */
  keep: boolean;
  dead: boolean;
}

interface SimObj extends ObjSnap {
  regrowT: number;
}

interface SimBullet {
  id: number;
  owner: number;
  dmg: number;
  knock: number;
  x: number;
  y: number;
  vx: number;
  vy: number;
  life: number;
  /** 残り貫通数 */
  pierce: number;
  ap: boolean;
  /** 当たったゾンビ（同じ敵に2回当たらないように） */
  hit: number[];
  dead: boolean;
}

const r1 = (v: number) => Math.round(v * 10) / 10;
const r2 = (v: number) => Math.round(v * 100) / 100;
/** 全体の安全上限（3人がバラバラに探索しても、それぞれの周りに出せる数） */
const MAX_ZOMBIES = 400;
/** 1人のまわり（アクティブな 5×5 チャンク）に置けるゾンビの上限。先に動いた場所が全体の枠を使い切らないように */
const REGION_MAX = 140;
/** プレイヤーのいるチャンクから何チャンク先までをアクティブにするか（チェビシェフ距離） */
const ACTIVE_R = 2;
/** 天候ごとの効果：ゾンビの視覚距離・音の届く距離 */
const WEATHER_FX: Record<Weather, { sight: number; noise: number; name: string; desc: string }> = {
  clear: { sight: 1, noise: 1, name: '晴れ', desc: '' },
  fog: { sight: 0.55, noise: 1, name: '濃霧', desc: '霧で見通しが悪い。お互いに気づきにくい' },
  rain: { sight: 0.8, noise: 0.75, name: '雨', desc: '雨音が足音や銃声をかき消す' },
  storm: { sight: 0.65, noise: 0.6, name: '嵐', desc: '激しい雨と雷。音は遠くまで届かないが野外は危険' },
};
const BENCH_KINDS: ReadonlySet<ObjKind> = new Set<ObjKind>(['bench', 'wbench']);
const FIRE_KINDS: ReadonlySet<ObjKind> = new Set<ObjKind>(['campfire', 'fire']);

/** 漁れる入れ物 */
export const CONTAINER_KINDS: ReadonlySet<ObjKind> = new Set<ObjKind>(['shelf', 'cabinet', 'locker', 'wcase', 'fridge', 'desk', 'crate', 'mcrate', 'car', 'box', 'bag', 'drop']);
/** 拠点の倉庫 */
export const STORAGE_KINDS: ReadonlySet<ObjKind> = new Set<ObjKind>(['chest', 'stash']);

/** 時刻（分）を計算：サイクル開始は 06:00 */
export function cycleToMinute(cycleT: number): number {
  if (cycleT < DAY_SECONDS) return 360 + (cycleT * 840) / DAY_SECONDS;
  return (1200 + ((cycleT - DAY_SECONDS) * 600) / NIGHT_SECONDS) % 1440;
}

// ---- 体調 ----
/** 疲労：起きている間に 1 秒あたり増える量（丸 1 日強で 60） */
const FATIGUE_RATE = 60 / (CYCLE_SECONDS * 1.1);
/** 疲労がこれを超えると狙いがぶれ、足が遅くなる */
const FATIGUE_BAD = 60;
/** 冷えがこれを超えるとスタミナの回復が落ちる・さらに上は HP が減る */
const COLD_SLOW = 50;
const COLD_HURT = 85;
const WARM_KINDS: ReadonlySet<ObjKind> = new Set<ObjKind>(['campfire', 'torch', 'stove', 'fire']);

/** ホスト側の車：運転手の最後の入力と、エンジン音の間隔 */
type SimVehicle = VehicleSnap & { inp: { mx: number; my: number } | null; noiseT: number };
const trunkId = (v: VehicleSnap) => VEHICLE.trunkBase + v.id;

/** 車の体当たりで壊せる物 */
const RAMMABLE: ReadonlySet<ObjKind> = new Set<ObjKind>(['car', 'tree', 'barrel', 'crate', 'rubble']);
const STOVE_KINDS: ReadonlySet<ObjKind> = new Set<ObjKind>(['stove']);
const BUILD_RANGE_PX = 6 * TILE + 20;

/** 大群の夜が来る日（4日ごと） */
export const isHordeDay = (day: number): boolean => day % 4 === 0;
/** 30 日モードで救助が来る日（その日の朝） */
export const RESCUE_DAY = 30;

/** 拠点の敷地内か（安全地帯） */
export function inBase(x: number, y: number): boolean {
  const sh = SAFEHOUSE;
  return x > sh.x * TILE && y > sh.y * TILE && x < (sh.x + sh.w) * TILE && y < (sh.y + sh.h) * TILE;
}

// ---------------- 物資テーブル [アイテム, 重み, 最小, 最大] ----------------
type LootRow = [ItemId | 'weapon' | 'attach', number, number, number];
const LOOT: Partial<Record<ObjKind, LootRow[]>> = {
  // 序盤の詰まりを減らす：棚・机・木箱・車からも少し弾と包帯が出る。食料は出すぎないように控えめ
  shelf: [['pack1', 0.25, 1, 1], ['can', 4, 1, 2], ['cloth', 3, 1, 3], ['scrap', 3, 1, 3], ['bandage', 1.7, 1, 1], ['ammo9', 2.4, 5, 12], ['gunpowder', 1, 1, 1], ['valuables', 0.5, 1, 1], ['tools', 0.15, 1, 1]],
  fridge: [['can', 4.5, 1, 2], ['mre', 1, 1, 1]],
  cabinet: [['bandage', 5, 1, 2], ['chem', 4, 1, 2], ['medkit', 1.2, 1, 1], ['cloth', 2, 1, 2], ['stim', 0.35, 1, 1]],
  locker: [['pack1', 0.5, 1, 1], ['pack2', 0.15, 1, 1], ['ammo9', 4, 6, 14], ['cloth', 2, 1, 3], ['bandage', 2, 1, 1], ['parts', 1, 1, 1], ['valuables', 1, 1, 1], ['shells', 1, 2, 5], ['ammo9ap', 0.6, 4, 10], ['holo', 0.2, 1, 1]],
  desk: [['valuables', 3, 1, 2], ['electronics', 2, 1, 1], ['ammo9', 2.8, 4, 9], ['gunpowder', 1, 1, 2], ['chem', 1, 1, 1], ['bandage', 0.6, 1, 1]],
  crate: [['scrap', 5, 2, 5], ['gunpowder', 3, 1, 2], ['parts', 1, 1, 1], ['cloth', 2, 1, 3], ['can', 0.8, 1, 1], ['tools', 0.35, 1, 1], ['ammo9', 1, 4, 8], ['shells', 0.5, 2, 4]],
  car: [['fuel', 1.6, 1, 1], ['scrap', 5, 2, 4], ['gunpowder', 2, 1, 2], ['electronics', 1.2, 1, 1], ['can', 0.8, 1, 1], ['valuables', 0.6, 1, 1], ['tools', 0.3, 1, 1], ['ammo9', 1.1, 3, 8], ['bandage', 0.7, 1, 1], ['shells', 0.4, 2, 5]],
  wcase: [['ammo762', 4, 8, 20], ['ammo9', 3, 10, 20], ['shells', 3, 4, 8], ['weapon', 2, 1, 1], ['attach', 1.5, 1, 1], ['parts', 2, 1, 2], ['ammo762ap', 1, 5, 12], ['slug', 0.8, 3, 6]],
  mcrate: [['pack3', 0.35, 1, 1], ['pack2', 0.3, 1, 1], ['ammo762', 5, 10, 25], ['shells', 3, 6, 12], ['mre', 2, 1, 2], ['medkit', 2, 1, 1], ['parts', 3, 1, 2], ['attach', 1.2, 1, 1], ['weapon', 0.8, 1, 1], ['ammo762ap', 1.5, 6, 14], ['stim', 0.6, 1, 1], ['tools', 0.6, 1, 1]],
  box: [['can', 3, 1, 2], ['bandage', 2, 1, 1], ['ammo9', 2, 6, 10], ['cloth', 1, 1, 2]],
  drop: [['ammo762ap', 3, 10, 20], ['weapon', 2.5, 1, 1], ['attach', 3, 1, 1], ['stim', 2, 1, 2], ['medkit', 2, 1, 2], ['tools', 2, 1, 2], ['mre', 1.5, 1, 2], ['electronics', 1.5, 1, 3], ['valuables', 1.5, 1, 3]],
};

// ---------------- 地区ごとの特色（物資の出やすさ・専用品・ゾンビの構成・群れ） ----------------
type LootMul = Partial<Record<ItemId | 'weapon' | 'attach', number>>;
const DISTRICT_LOOT: Record<DistrictKind, { mul: LootMul; extra: LootRow[] }> = {
  residential: { mul: { can: 1.6, cloth: 1.6, bandage: 1.4, valuables: 1.3 }, extra: [] },
  commercial: { mul: { can: 1.7, mre: 1.4, electronics: 1.7, valuables: 1.8, chem: 1.3 }, extra: [] },
  industrial: { mul: { scrap: 2.2, parts: 2, tools: 3, gunpowder: 1.7, electronics: 1.4, can: 0.6 }, extra: [] },
  civic: { mul: { bandage: 1.5, medkit: 2.2, stim: 2, chem: 1.8, ammo9: 1.4, ammo9ap: 1.6 }, extra: [['antitox', 1.6, 1, 1]] },
  military: { mul: { ammo762: 1.6, ammo762ap: 2.2, weapon: 1.7, attach: 1.7, mre: 1.6, slug: 1.6 }, extra: [['intel', 0.9, 1, 1]] },
  forest: { mul: { shells: 2, cloth: 1.3, can: 0.6, valuables: 0.5 }, extra: [['herbs', 3.5, 1, 3]] },
  wild: { mul: { scrap: 1.5, gunpowder: 1.5, valuables: 1.3, parts: 1.2 }, extra: [] },
};
/** 地区ごとのゾンビの出やすさ（危険度ごとの基本の重みに掛ける・足す） */
const DISTRICT_ZOMBIES: Record<DistrictKind, { mul: Partial<Record<ZombieType, number>>; add: Partial<Record<ZombieType, number>>; density: number; pack: number }> = {
  residential: { mul: { walker: 1.7, runner: 1, brute: 0.6, soldier: 0.3 }, add: { screamer: 2 }, density: 1.35, pack: 0.45 },
  commercial: { mul: { walker: 1, runner: 1.9, brute: 0.6, soldier: 0.4 }, add: { screamer: 9 }, density: 1.1, pack: 0.3 },
  industrial: { mul: { walker: 1, runner: 0.6, brute: 2.2, soldier: 0.5 }, add: { bloater: 13 }, density: 1, pack: 0.15 },
  civic: { mul: { walker: 1, runner: 1, brute: 0.8, soldier: 1.5 }, add: { bloater: 8, screamer: 3 }, density: 1.1, pack: 0.2 },
  military: { mul: { walker: 0.5, runner: 0.6, brute: 1.2, soldier: 2.4 }, add: {}, density: 1.2, pack: 0.2 },
  forest: { mul: { walker: 0.9, runner: 2.3, brute: 0.5, soldier: 0.3 }, add: { screamer: 2 }, density: 0.7, pack: 0.1 },
  wild: { mul: { walker: 1.2, runner: 1.2, brute: 1, soldier: 0.7 }, add: { screamer: 7 }, density: 1.15, pack: 0.4 },
};
const BASE_ZOMBIE_WEIGHTS: Record<number, Partial<Record<ZombieType, number>>> = {
  1: { walker: 82, runner: 18 },
  2: { walker: 60, runner: 22, brute: 10, soldier: 8 },
  3: { walker: 12, runner: 20, brute: 18, soldier: 50 },
  4: { walker: 8, runner: 22, brute: 25, soldier: 45 },
};

/** 仲間に手渡しできる距離(px) */
export const GIVE_RANGE = 220;

/** 反動（ばらつき）の戻る速さ／溜まる上限：武器の個性 */
const HEAT_RECOVER: Record<WeaponId, number> = { pistol: 7, smg: 6.5, rifle: 3.6, shotgun: 4, hunting: 3, dmr: 4.2 };
const HEAT_MAX: Record<WeaponId, number> = { pistol: 0.2, smg: 0.24, rifle: 0.34, shotgun: 0.3, hunting: 0.3, dmr: 0.26 };

/** セーブデータ（このブラウザの localStorage に1つだけ保存） */
export interface SaveData {
  v: 1;
  savedAt: number;
  seed: number;
  day: number;
  cycleT: number;
  phase: TimePhase;
  weather: Weather;
  base: Record<Facility, number>;
  storage: StorageState;
  dropAt: number;
  nextObjId: number;
  objs: SimObj[];
  removed: number[];
  contents: [number, (Slot | null)[]][];
  players: {
    id: number;
    name: string;
    x: number;
    y: number;
    hp: number;
    maxHp: number;
    hunger: number;
    tox: number;
    status: PlayerSnap['status'];
    bag: (Slot | null)[];
    prim: Slot | null;
    sec: Slot | null;
    tool: number;
    kills: number;
    xp: number[];
    body?: { fatigue: number; cold: number; bleed: boolean; frac: number; fracT: number; pack?: ItemId; home?: { x: number; y: number }; tut?: number };
  }[];
  extra?: Record<string, unknown>;
}

// ---------------- 小さな二分ヒープ（Dijkstra 用） ----------------
class MinHeap {
  private k: number[] = [];
  private v: number[] = [];
  get size() {
    return this.k.length;
  }
  push(key: number, val: number) {
    const k = this.k;
    const v = this.v;
    k.push(key);
    v.push(val);
    let i = k.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (k[p] <= k[i]) break;
      const tk = k[p];
      k[p] = k[i];
      k[i] = tk;
      const tv = v[p];
      v[p] = v[i];
      v[i] = tv;
      i = p;
    }
  }
  pop(): [number, number] {
    const k = this.k;
    const v = this.v;
    const top: [number, number] = [k[0], v[0]];
    const lk = k.pop()!;
    const lv = v.pop()!;
    if (k.length > 0) {
      k[0] = lk;
      v[0] = lv;
      let i = 0;
      for (;;) {
        const l = i * 2 + 1;
        const r = l + 1;
        let m = i;
        if (l < k.length && k[l] < k[m]) m = l;
        if (r < k.length && k[r] < k[m]) m = r;
        if (m === i) break;
        const tk = k[m];
        k[m] = k[i];
        k[i] = tk;
        const tv = v[m];
        v[m] = v[i];
        v[i] = tv;
        i = m;
      }
    }
    return top;
  }
}

const NEIGHBORS = [
  [1, 0, 1],
  [-1, 0, 1],
  [0, 1, 1],
  [0, -1, 1],
  [1, 1, Math.SQRT2],
  [1, -1, Math.SQRT2],
  [-1, 1, Math.SQRT2],
  [-1, -1, Math.SQRT2],
];

export class HostSimulation {
  readonly seed: number;
  world: TileWorld<SimObj>;
  players: SimPlayer[] = [];
  zombies: SimZombie[] = [];
  bullets: SimBullet[] = [];
  /** 入れ物の中身（初めて探索したときに生成） */
  contents = new Map<number, (Slot | null)[]>();
  storage: StorageState = { ver: 1, shared: emptyBag(STORAGE_SIZES[0].shared), personal: {} };
  /** 拠点設備のレベル */
  base: Record<Facility, number> = { bench: 1, storage: 0, med: 0, supply: 0, garden: 0 };
  /** 大群の夜（3日ごと）：拠点の柵も安全ではなくなる */
  hordeNight = false;
  private hordeWaves = 0;
  private hordeT = 0;
  private hordeReward = false;
  /** 昼の 13:00 に天候が変わることがある（長い昼が単調にならないように） */
  private noonRolled = false;
  private barricadeWarnT = -99;
  // ---- 無線の依頼 ----
  jobs: Job[] = [];
  private jobSeq = 1;
  radioDone = 0;
  private jobCheckT = 0;
  // ---- 車両 ----
  vehicles: SimVehicle[] = [];
  private vehSeq = 1;
  weather: Weather = 'clear';
  /** 天候の強さ（0..1 でなめらかに切り替わる） */
  wx = 0;
  private nextWeather: Weather = 'clear';
  /** 補給物資（空中投下） */
  dropObj: number | null = null;
  private dropAt = -1;

  day = 1;
  cycleT: number;
  phase: TimePhase = 'day';
  time = 0;
  tick = 0;
  result: GameResult | null = null;
  gameOver = false;

  private events: GameEvent[] = [];
  private changed = new Set<number>();
  private removed: number[] = [];
  /** 開始時から変化したオブジェクト・取り除かれたオブジェクト（セーブ・再接続でワールドを再現する） */
  private everChanged = new Set<number>();
  private everRemoved = new Set<number>();
  private nextId = 1;
  private nextObjId = BUILD_ID_START;
  // Float64 で保持する（Float32 だとヒープのキーとの丸め誤差で同じノードが何度も再投入され、計算が爆発する）
  private flow = new Float64Array(MAP_W * MAP_H);
  private flowTimer = 0;
  private spawnTimer = 5;
  private lastStorageSent = -1;
  private pingCd = new Map<number, number>();
  // ---- チャンク管理 ----
  /** アクティブなチャンク（プレイヤーの周辺）。ここだけゾンビの出現・AI・経路計算を行う */
  chunkActive = new Uint8Array(CHUNKS_X * CHUNKS_Y);
  /** 最後にゾンビを配置した時刻（短時間の出入りで湧き直さない） */
  private chunkSeeded = new Float64Array(CHUNKS_X * CHUNKS_Y).fill(-1e9);
  private chunkTimer = 0;
  private flowCost = new Float64Array(MAP_W * MAP_H);
  /** 統計（テスト・デバッグ用） */
  stats = { activations: 0, deactivations: 0, despawned: 0, active: 0 };

  constructor(lobby: LobbyPlayer[], seed: number) {
    this.seed = seed;
    const gen = generateWorld(seed);
    this.world = new TileWorld<SimObj>(gen.terrain);
    for (const o of gen.objs) this.world.setObj({ ...o, regrowT: 0 });
    this.world.locations = gen.locations;
    this.world.buildings = gen.buildings;
    this.world.landmarks = gen.landmarks;
    this.world.districts = gen.districts;
    this.world.features = gen.features;
    this.world.vec = gen.vec;
    this.cycleT = ((START_MINUTE - 360) * DAY_SECONDS) / 840;

    const cx = (CAMPFIRE_TILE.x + 0.5) * TILE;
    const cy = (CAMPFIRE_TILE.y + 0.5) * TILE;
    lobby.forEach((lp, i) => {
      const a = (i / Math.max(1, lobby.length)) * Math.PI * 2;
      const p: SimPlayer = {
        id: lp.id,
        name: lp.name,
        x: cx - 60 + Math.cos(a) * 40,
        y: cy - 60 + Math.sin(a) * 40,
        bodyAngle: 0,
        aim: 0,
        hp: PLAYER.maxHp,
        maxHp: PLAYER.maxHp,
        hunger: 100,
        tut: 0,
        status: 'alive',
        downTimer: 0,
        reviveProgress: 0,
        tool: Tool.Secondary,
        bag: emptyBag(),
        prim: null,
        sec: null,
        reloadT: 0,
        shots: 0,
        swings: 0,
        kills: 0,
        searchId: 0,
        searchP: 0,
        viewing: 0,
        storage: 0,
        ack: 0,
        dashTime: 0,
        dashCd: 0,
        dashDx: 0,
        dashDy: 0,
        stamina: PLAYER.maxStamina,
        staminaDelay: 0,
        queue: [],
        fire: false,
        revive: false,
        tx: 0,
        ty: 0,
        fireCd: 0,
        swingCd: 0,
        warnCd: 0,
        useCd: 0,
        idle: 0,
        reloadSlot: '',
        search: null,
        stepNoiseT: 0,
        stimT: 0,
        tox: 0,
        toxWarn: 0,
        coughT: 0,
        xp: sanitizeProfile(lp.prof).xp,
        lv: [],
        heat: 0,
      };
      p.lv = p.xp.map(levelOf);
      this.applySkills(p);
      p.stamina = p.stmMax ?? PLAYER.maxStamina;
      this.giveStarterKit(p);
      this.players.push(p);
      this.storage.personal[p.id] = emptyBag(STORAGE_SIZES[0].personal);
    });
    this.updateChunks(true);
    this.spawnPatrols(3);
    this.dropAt = DAY_SECONDS * (0.08 + Math.random() * 0.2);
    this.newJobs(true);
    this.spawnVehicles();
    this.setupBase(lobby.length);
    // 最初の夜にすぐ何か建てられるよう、倉庫に少しだけ材料（焚き火・たいまつ・釘の罠が 1 つずつ作れる程度）
    addItem(this.storage.shared, 'scrap', 8);
    addItem(this.storage.shared, 'cloth', 4);
    this.newSites(true);
    this.newRescueSites();
    this.dayTip();
    // 初日の天候はランダム（霧で始まることもある）
    if (Math.random() < 0.3) this.setWeather(Math.random() < 0.5 ? 'fog' : 'rain', true);
    this.events.push({ k: 'banner', t: 'DAY 1', s: '建物を漁って物資を集め、生きて拠点に持ち帰れ', c: '#e0cfa8', snd: 'day' });
  }

  /** スキルを反映（最大スタミナ・回復速度） */
  private applySkills(p: SimPlayer): void {
    const m = skillMods(p.xp);
    p.stmMax = m.staminaMax;
    p.stmRegen = m.staminaRegenMul * (p.stimT > 0 ? 1.8 : 1) * ((p.rested ?? 0) > 0 ? 1.35 : 1) * ((p.cold ?? 0) >= COLD_SLOW ? 0.6 : 1);
  }

  /** スキル経験値を加える（レベルが上がったら知らせる） */
  private gainXp(p: SimPlayer, i: number, n: number): void {
    p.xp[i] = Math.min(1e6, p.xp[i] + n);
    const lv = levelOf(p.xp[i]);
    if (lv > (p.lv[i] ?? 0)) {
      p.lv[i] = lv;
      this.applySkills(p);
      this.events.push({ k: 'feed', cat: 'up', t: `${p.name}：${SKILLS[i].name} Lv${lv}（${SKILLS[i].desc}）`, c: '#c9e08a', id: p.id, snd: 'level' });
      this.pop(p, `${SKILLS[i].name} Lv${lv}!`, '#c9e08a');
    }
  }

  private giveStarterKit(p: SimPlayer): void {
    p.sec = { id: 'pistol', n: 1, w: { mag: WEAPON_STATS.pistol.magSize } };
    p.prim = null;
    p.bag = emptyBag();
    addItem(p.bag, 'ammo9', 30);
    addItem(p.bag, 'bandage', 2);
    addItem(p.bag, 'can', 1);
    p.tool = Tool.Secondary;
  }

  // ======================== 外部API ========================

  /** 開発用：任意のオブジェクトを設置（監査スクリプト用） */
  debugPlace(kind: ObjKind, tx: number, ty: number): void {
    if (!this.world.inBounds(tx, ty) || this.world.solid(tx, ty) || this.world.objAt(tx, ty)) return;
    const o: SimObj = { id: this.nextObjId++, kind, tx, ty, hp: 1, maxHp: 1, ready: 1, regrowT: 0 };
    this.world.setObj(o);
    this.changed.add(o.id);
  }

  /** 開発用：アイテムを渡す */
  debugGive(playerId: number, id: ItemId, n: number): void {
    const p = this.players.find((pl) => pl.id === playerId);
    if (p) addItem(p.bag, id, n, isWeapon(id) ? { mag: WEAPON_STATS[id].magSize } : undefined);
  }

  queueInput(playerId: number, f: InputFrame): void {
    const p = this.players.find((pl) => pl.id === playerId);
    if (!p) return;
    p.queue.push(f);
    if (p.queue.length > 120) p.queue.splice(0, p.queue.length - 120);
  }

  removePlayer(playerId: number): void {
    this.players = this.players.filter((p) => p.id !== playerId);
  }

  /** 通信が切れた仲間：キャラクターは残し、再接続を待つ（その間は狙われず、空腹なども進まない） */
  setAway(playerId: number, away: boolean): void {
    const p = this.players.find((q) => q.id === playerId);
    if (!p || !!p.away === away) return;
    p.away = away;
    p.queue.length = 0;
    p.fire = false;
    p.revive = false;
    this.events.push({ k: 'feed', cat: 'ally', t: away ? `${p.name} の通信が切れた（再接続を待っています）` : `${p.name} が再接続した`, c: away ? '#c9a050' : '#9fc48a' });
  }

  /** 開始時からのワールドの変化すべて（途中から参加するゲスト・続きから用） */
  fullWorldDiff(): { objs: ObjSnap[]; removed: number[] } {
    // 未送信の差分も含める（ただし消費はしない：他のゲストへ送るぶんが消えないように）
    const removed = new Set([...this.everRemoved, ...this.removed]);
    const objs: ObjSnap[] = [];
    for (const id of new Set([...this.everChanged, ...this.changed])) {
      const o = this.world.objects.get(id);
      if (o && !removed.has(id)) objs.push(toObjSnap(o));
    }
    return { objs, removed: [...removed] };
  }

  /** セーブデータ（ソロ・ホスト）。ゾンビは保存しない（チャンクに近づくと湧き直す） */
  toSave(): SaveData {
    const removedNow = new Set([...this.everRemoved, ...this.removed]);
    const objs: SimObj[] = [];
    for (const id of new Set([...this.everChanged, ...this.changed])) {
      const o = this.world.objects.get(id);
      if (o && !removedNow.has(id)) objs.push({ ...o });
    }
    return {
      v: 1,
      savedAt: Date.now(),
      seed: this.seed,
      day: this.day,
      cycleT: this.cycleT,
      phase: this.phase,
      weather: this.weather,
      base: { ...this.base },
      storage: this.storage,
      dropAt: this.dropAt,
      nextObjId: this.nextObjId,
      objs,
      removed: [...removedNow],
      contents: [...this.contents.entries()],
      players: this.players.map((p) => ({
        id: p.id,
        name: p.name,
        x: p.x,
        y: p.y,
        hp: p.hp,
        maxHp: p.maxHp,
        hunger: p.hunger,
        tox: p.tox,
        status: p.status,
        bag: p.bag,
        prim: p.prim,
        sec: p.sec,
        tool: p.tool,
        kills: p.kills,
        xp: p.xp,
        body: { fatigue: p.fatigue ?? 0, cold: p.cold ?? 0, bleed: !!p.bleed, frac: p.frac ?? 0, fracT: p.fracT ?? 0, pack: p.pack, home: p.home, tut: p.tut ?? 0 },
      })),
      extra: this.saveExtra(),
    };
  }

  /** 追加の保存項目（拡張用） */
  protected saveExtra(): Record<string, unknown> {
    return { runMode: this.runMode, rescue: this.rescue, rsites: this.rsites, sites: this.sites, siteSeq: this.siteSeq, jobs: this.jobs, jobSeq: this.jobSeq, radioDone: this.radioDone, vehicles: this.vehicles.map((v) => ({ ...v, seats: [-1, -1, -1], inp: null, spd: 0 })), vehSeq: this.vehSeq };
  }

  /** セーブから再開：同じシードで世界を作り直し、変化と状態を戻す。ロビーの各スロットに保存された人を割り当てる */
  static fromSave(lobby: LobbyPlayer[], data: SaveData): HostSimulation {
    const sim = new HostSimulation(lobby, data.seed);
    sim.events = [];
    const rx = data.extra as { rsites?: (SiteSnap & { guards: boolean })[]; rescue?: { stage: number; parts: number; day: number }; runMode?: RunMode } | undefined;
    if (rx?.rsites) {
      // 生成し直したときの通信塔の箱は捨て、保存してあった物を使う
      for (const st of sim.rsites) {
        sim.world.removeObj(st.crate);
        sim.contents.delete(st.crate);
        sim.changed.delete(st.crate);
      }
      sim.rsites = rx.rsites.map((x) => ({ ...x, guards: false }));
    }
    // 古いセーブは「期限なし」。通信塔は新しく置いたものを使う
    sim.runMode = rx?.runMode ?? 'endless';
    if (rx?.rescue) sim.rescue = { ...rx.rescue };
    for (const id of data.removed) {
      sim.world.removeObj(id);
      sim.everRemoved.add(id);
    }
    for (const o of data.objs) {
      sim.world.setObj({ ...o });
      sim.everChanged.add(o.id);
    }
    sim.contents = new Map(data.contents);
    sim.day = data.day;
    sim.cycleT = data.cycleT;
    sim.phase = data.phase;
    sim.base = { ...sim.base, ...data.base };
    sim.storage = data.storage;
    sim.storage.ver = (sim.storage.ver ?? 1) + 1;
    sim.dropAt = data.dropAt;
    const ex = data.extra as { sites?: (SiteSnap & { guards: boolean })[]; siteSeq?: number; jobs?: Job[]; jobSeq?: number; radioDone?: number; vehicles?: SimVehicle[]; vehSeq?: number } | undefined;
    if (ex?.sites) {
      sim.sites = ex.sites.map((x) => ({ ...x, guards: false }));
      sim.siteSeq = ex.siteSeq ?? sim.siteSeq;
    }
    if (ex?.vehicles) {
      sim.vehicles = ex.vehicles;
      sim.vehSeq = ex.vehSeq ?? sim.vehSeq;
    }
    if (ex?.jobs) {
      sim.jobs = ex.jobs;
      sim.jobSeq = ex.jobSeq ?? sim.jobSeq;
      sim.radioDone = ex.radioDone ?? 0;
    }
    sim.nextObjId = Math.max(sim.nextObjId, data.nextObjId);
    sim.setWeather(data.weather, true);
    for (const p of sim.players) {
      const s = data.players.find((q) => q.id === p.id);
      if (!s) continue;
      Object.assign(p, { x: s.x, y: s.y, hp: s.hp, maxHp: s.maxHp, hunger: s.hunger, tox: s.tox, bag: s.bag, prim: s.prim, sec: s.sec, tool: s.tool, kills: s.kills });
      p.xp = p.xp.map((v, i) => Math.max(v, s.xp[i] ?? 0));
      p.tut = TUT_ALL;
      if (s.body) Object.assign(p, { tut: TUT_ALL, ...s.body });
      p.lv = p.xp.map(levelOf);
      sim.applySkills(p);
      // ダウン・戦闘不能のまま保存されていたら、拠点で起き上がった状態から
      if (s.status !== 'alive') {
        p.status = 'alive';
        p.hp = p.maxHp * 0.6;
        p.x = (CAMPFIRE_TILE.x + 0.5) * TILE - 50;
        p.y = (CAMPFIRE_TILE.y + 0.5) * TILE - 30;
      }
      if (!sim.storage.personal[p.id]) sim.storage.personal[p.id] = emptyBag(STORAGE_SIZES[sim.base.storage]?.personal ?? STORAGE_SIZES[0].personal);
    }
    // 拠点の周りにいたゾンビは消して、保存された位置の周りから湧き直す
    sim.zombies = [];
    sim.chunkActive.fill(0);
    sim.chunkSeeded.fill(-1e9);
    sim.updateChunks(true);
    sim.events.push({ k: 'banner', t: `DAY ${sim.day}`, s: '前回の続きから。物資を集めて生き延びろ', c: '#e0cfa8', snd: 'day' });
    return sim;
  }

  drainEvents(): GameEvent[] {
    const e = this.events;
    this.events = [];
    return e;
  }

  minute(): number {
    return cycleToMinute(this.cycleT);
  }

  // ======================== 睡眠（拠点のベッド） ========================

  /** 夜（20:00〜05:00）に拠点のベッドで眠る。全員が眠ると朝 6:00 まで時間が進む */
  private trySleep(p: SimPlayer, bed?: SimObj): void {
    if (p.status !== 'alive') return;
    const m = this.minute();
    if (!(m >= 20 * 60 || m < 5 * 60)) return this.pop(p, '眠れるのは夜（20:00〜05:00）だけ', '#cccccc');
    if (this.hordeNight) return this.pop(p, '大群の夜は眠れない！', '#e0583e');
    if (p.bleed) return this.pop(p, '出血を止めてから眠ろう（包帯）', '#e0583e');
    if (this.zombies.some((z) => !z.dead && z.state === 'chase' && Math.hypot(z.x - p.x, z.y - p.y) < 700)) return this.pop(p, '近くに敵がいて眠れない', '#e0583e');
    p.sleeping = true;
    this.tutMark(p, TUT_SLEEP);
    // 眠った寝床が、戦闘不能から朝に戻る場所
    if (bed) {
      const free = [[0, 1], [1, 0], [-1, 0], [0, -1]].find(([dx, dy]) => !this.world.solid(bed.tx + dx, bed.ty + dy));
      if (free) p.home = { x: (bed.tx + free[0] + 0.5) * TILE, y: (bed.ty + free[1] + 0.5) * TILE };
    }
    p.search = null;
    p.viewing = 0;
    p.storage = 0;
    const others = this.players.filter((q) => q.status === 'alive' && !q.away);
    const n = others.filter((q) => q.sleeping).length;
    this.pop(p, '眠りについた…（動くと起きる）', '#aab4c8');
    if (others.length > 1) this.events.push({ k: 'feed', cat: 'ally', t: `${p.name} が眠った（${n}/${others.length}）— 全員が拠点のベッドで眠ると朝になる`, c: '#aab4c8' });
  }

  private wake(p: SimPlayer, msg: string): void {
    if (!p.sleeping) return;
    p.sleeping = false;
    this.pop(p, msg, '#aab4c8');
  }

  /** 全員（生きていて通信中の人）が眠っていたら朝まで飛ばす。ダウンした仲間がいるときは飛ばさない */
  private updateSleep(): void {
    if (this.phase !== 'night') {
      for (const p of this.players) if (p.sleeping) p.sleeping = false;
      return;
    }
    const awake = this.players.filter((p) => !p.away && p.status !== 'dead');
    if (!awake.length || awake.some((p) => p.status !== 'alive' || !p.sleeping)) return;
    // 朝まで眠った：残りの夜の時間ぶん、空腹は（ゆっくり）進み、体は回復する
    const skip = Math.max(0, CYCLE_SECONDS - this.cycleT);
    for (const p of awake) {
      p.hunger = Math.max(5, p.hunger - (100 / PLAYER.hungerSeconds) * skip * 0.35);
      p.hp = p.maxHp;
      p.tox = Math.max(0, p.tox - 40);
      p.rested = 480;
      p.fatigue = 0;
      p.cold = 0;
      if (p.frac === 2) p.frac = 0;
      p.sleeping = false;
      this.applySkills(p);
      p.stamina = p.stmMax ?? PLAYER.maxStamina;
    }
    // 入れ物の補充時間も進める
    for (const o of this.world.objects.values()) if (o.regrowT > 0) o.regrowT = Math.max(0.01, o.regrowT - skip);
    // 夜のあいだに拠点の周りをうろついていた雑魚は消える（朝の見張りは静か）
    for (const z of this.zombies) if (!z.keep && z.state !== 'chase' && Math.hypot(z.x - BASE_TX * TILE, z.y - BASE_TY * TILE) < 1200) z.dead = true;
    this.cycleT = CYCLE_SECONDS - 0.001;
    this.events.push({ k: 'sleep' });
    this.events.push({ k: 'feed', cat: 'up', t: '朝まで眠った — HP全快・汚染が抜け、しばらく「休息済み」（スタミナ回復↑・空腹の減り↓）', c: '#c9e08a', snd: 'day' });
  }

  private duskWarnedDay = 0;
  /** 夕方（18:30）に、拠点の外にいる人へ帰還の判断材料を知らせる */
  /** 毎朝のひとこと：その日に試すと良いこと（最初の 1 週間で、すべての遊びに触れられるように） */
  private dayTip(): void {
    const car = this.vehicles[0];
    const carDir = car ? `${directionName(car.x / TILE, car.y / TILE)} ${Math.round(Math.hypot(car.x / TILE - BASE_TX, car.y / TILE - BASE_TY))}m の所` : '近く';
    const tips: Record<number, string> = {
      1: '右上の「はじめの一日」を順にこなそう。日が暮れる前（18:00ごろ）には拠点へ戻ること',
      2: `拠点の${carDir}に壊れたピックアップがある。鉄くず6・武器パーツ2で直すと、遠くの依頼も楽になる`,
      3: '作業台を Lv2 にすると鉄板バリケードが建てられる。明日の夜は大群が来る — 門を塞いで備えよう',
      4: '今夜は大群の夜。門（4か所）をバリケードで塞ぎ、釘の罠を内側に。攻撃された所は [F] で修理',
      5: '無線の信頼度が Lv3 になると、遠くの依頼がもう1件届く。車のトランクで大量に持ち帰ろう',
      6: '雨の日はコート（布6）があると冷えにくい。雨水タンクで水を貯めて、シチューで休息済みに',
      7: '1週間生き延びた。遠くの★4の地区（軍用地・病院）で、良い武器と装備を探そう',
    };
    const t = tips[this.day];
    if (t) this.events.push({ k: 'feed', cat: 'info', t: `DAY ${this.day}：${t}`, c: '#cfe8f6' });
  }

  private updateReturnAdvice(): void {
    const m = this.minute();
    if (m < 18 * 60 || m > 20 * 60 || this.duskWarnedDay === this.day) return;
    this.duskWarnedDay = this.day;
    for (const p of this.players) {
      if (p.status !== 'alive' || inBase(p.x, p.y)) continue;
      const d = Math.round(Math.hypot(p.x / TILE - BASE_TX, p.y / TILE - BASE_TY));
      const secs = Math.round((d * TILE) / PLAYER.speed);
      const horde = isHordeDay(this.day);
      this.events.push({ k: 'feed', cat: 'danger', t: `${horde ? '今夜は大群の夜！ ' : ''}日没まで約2時間：拠点まで ${d}m（走って約${secs}秒）。${horde ? '拠点の柵も破られる。弾と回復を備えて戻れ' : '夜は感染体が速く、多くなる'}`, c: horde ? '#e0583e' : '#e0a33a', id: p.id, snd: 'alarm' });
    }
  }

  /** 開始時に送るオブジェクト：ゲストはシードから同じ世界を再生成するので、生成直後から変化したものだけ（通常は空） */
  initialObjs(): ObjSnap[] {
    const changed: ObjSnap[] = [];
    for (const id of this.changed) {
      const o = this.world.objects.get(id);
      if (o) changed.push(toObjSnap(o));
    }
    return changed;
  }

  takeObjDelta(): { objs: ObjSnap[]; removed: number[] } {
    const objs: ObjSnap[] = [];
    for (const id of this.changed) this.everChanged.add(id);
    for (const id of this.removed) {
      this.everRemoved.add(id);
      this.everChanged.delete(id);
    }
    for (const id of this.changed) {
      const o = this.world.objects.get(id);
      if (o) objs.push(toObjSnap(o));
    }
    const removed = this.removed;
    this.changed.clear();
    this.removed = [];
    return { objs, removed };
  }

  view(withStorage = true): ViewState {
    const cont: Record<number, (Slot | null)[]> = {};
    for (const p of this.players) if (p.viewing) cont[p.viewing] = this.contents.get(p.viewing) ?? [];
    return {
      time: r2(this.time),
      tick: this.tick,
      day: this.day,
      minute: Math.floor(this.minute()),
      phase: this.phase,
      cont,
      ...(withStorage ? { storage: this.storage } : {}),
      weather: this.weather,
      wx: r2(this.wx),
      ...(this.hordeNight ? { horde: true } : {}),
      base: this.base,
      drop: this.dropPos(),
      jobs: this.jobs,
      sites: [...this.sites, ...this.rsites].map((x) => ({ id: x.id, kind: x.kind, name: x.name, tx: x.tx, ty: x.ty, crate: x.crate, ...(x.done ? { done: true } : {}) })),
      rescue: this.rescueSnap(),
      vehicles: this.vehicles.map((v) => ({ id: v.id, kind: v.kind, x: r1(v.x), y: r1(v.y), a: r2(v.a), spd: Math.round(v.spd), fuel: r1(v.fuel), hp: Math.round(v.hp), maxHp: v.maxHp, broken: v.broken, seats: v.seats })),
      radio: { done: this.radioDone, lv: radioLevel(this.radioDone) },
      players: this.players.map((p) => ({
        id: p.id,
        name: p.name,
        ...(p.away ? { away: true } : {}),
        ...(p.sleeping ? { sleeping: true } : {}),
        ...(p.veh !== undefined ? { veh: p.veh, seat: p.seat } : {}),
        ...(p.pack ? { pack: p.pack } : {}),
        ...((p.tut ?? 0) !== TUT_ALL ? { tut: p.tut ?? 0 } : {}),
        ...((p.rested ?? 0) > 0 ? { rested: Math.ceil(p.rested ?? 0) } : {}),
        x: r1(p.x),
        y: r1(p.y),
        bodyAngle: r2(p.bodyAngle),
        aim: r2(p.aim),
        hp: Math.ceil(p.hp),
        maxHp: p.maxHp,
        hunger: r1(p.hunger),
        status: p.status,
        downTimer: r1(p.downTimer),
        reviveProgress: r2(p.reviveProgress),
        tool: p.tool,
        bag: p.bag,
        prim: p.prim,
        sec: p.sec,
        reloadT: r2(p.reloadT),
        shots: p.shots,
        swings: p.swings,
        kills: p.kills,
        searchId: p.search ? p.search.cid : 0,
        searchP: p.search ? r2(p.search.t / p.search.dur) : 0,
        viewing: p.viewing,
        storage: p.storage,
        ack: p.ack,
        dashTime: p.dashTime,
        dashCd: p.dashCd,
        dashDx: p.dashDx,
        dashDy: p.dashDy,
        stamina: r1(p.stamina),
        staminaDelay: r2(p.staminaDelay),
        stmMax: p.stmMax,
        stmRegen: r2(p.stmRegen ?? 1),
        spdMul: p.spdMul ?? 1,
        ...(p.noDash ? { noDash: true } : {}),
        fatigue: Math.round(p.fatigue ?? 0),
        cold: Math.round(p.cold ?? 0),
        ...(p.bleed ? { bleed: true } : {}),
        ...(p.frac ? { frac: p.frac } : {}),
        xp: p.xp.map(Math.floor),
        heat: r2(p.heat),
        tox: r1(p.tox),
      })),
      zombies: this.zombies.filter((z) => this.zActive(z)).map((z) => ({
        id: z.id,
        type: z.type,
        x: r1(z.x),
        y: r1(z.y),
        angle: r2(z.angle),
        hp: Math.ceil(z.hp),
        maxHp: Math.ceil(z.maxHp),
        flash: r2(z.flash),
        alert: z.state === 'chase' ? 2 : z.state === 'investigate' || z.state === 'search' ? 1 : 0,
        atk: z.atk,
        ...(z.elite ? { elite: true } : {}),
      })),
      bullets: this.bullets.map((b) => ({ id: b.id, owner: b.owner, x: r1(b.x), y: r1(b.y), vx: Math.round(b.vx), vy: Math.round(b.vy) })),
    };
  }

  /** スナップショット（倉庫は変化したときだけ載せる） */
  snapshot(events: GameEvent[]): Snapshot {
    const send = this.storage.ver !== this.lastStorageSent;
    this.lastStorageSent = this.storage.ver;
    const d = this.takeObjDelta();
    return { ...this.view(send), events, objs: d.objs, removed: d.removed };
  }

  // ======================== メインステップ ========================

  step(dt: number): void {
    if (this.gameOver) return;
    if (this.winT > 0) {
      this.winT -= dt;
      if (this.winT <= 0) return this.finish(true);
    }
    this.time += dt;
    this.tick++;
    this.updateClock(dt);
    this.updateBuilds(dt);
    this.updateJobs(dt);
    this.updateVehicles(dt);
    this.updateThrowns(dt);
    this.updateSites(dt);
    this.updateSleep();
    this.updateReturnAdvice();
    if (this.hordeNight && this.hordeWaves > 0) {
      this.hordeT -= dt;
      if (this.hordeT <= 0) {
        this.hordeT = 22;
        this.hordeWaves--;
        this.spawnHordeWave();
        if (this.hordeWaves < 2) this.events.push({ k: 'feed', cat: 'danger', t: '次の群れが来る！', c: '#e0583e', snd: 'alarm' });
      }
    }
    for (const p of this.players) this.updatePlayer(p, dt);
    this.updateRevive(dt);
    this.flowTimer -= dt;
    if (this.flowTimer <= 0) {
      this.computeFlow();
      this.flowTimer = 0.4;
    }
    this.updateSpawning(dt);
    this.chunkTimer -= dt;
    if (this.chunkTimer <= 0) {
      this.chunkTimer = 0.5;
      this.updateChunks(false);
    }
    // 非アクティブなチャンクのゾンビは休眠（計算しない）
    for (const z of this.zombies) if (this.zActive(z)) this.updateZombie(z, dt);
    this.separateZombies();
    this.updateBullets(dt);
    this.updateContainers(dt);
    this.updateWeather(dt);
    this.updateAirdrop();
    this.zombies = this.zombies.filter((z) => !z.dead);
    this.bullets = this.bullets.filter((b) => !b.dead);

    if (this.players.length > 0 && !this.players.some((p) => p.status === 'alive' || p.status === 'down')) this.finish(false);
  }

  /** 終わり：救助された（won）／全滅 */
  private finish(won: boolean): void {
    {
      this.gameOver = true;
      this.result = {
        day: this.day,
        won,
        run: this.runMode,
        players: this.players.map((p) => ({
          id: p.id,
          name: p.name,
          kills: p.kills,
          xp: p.xp.map(Math.floor),
          value: bagValue(this.storage.personal[p.id] ?? []) + Math.round(bagValue(this.storage.shared) / Math.max(1, this.players.length)),
        })),
      };
    }
  }

  // ======================== 時間・昼夜 ========================

  private updateClock(dt: number): void {
    const prev = this.phase;
    this.cycleT += dt;
    if (this.cycleT >= CYCLE_SECONDS) {
      this.cycleT -= CYCLE_SECONDS;
      this.day++;
    }
    this.phase = this.cycleT >= DAY_SECONDS ? 'night' : 'day';
    if (this.phase === 'day' && !this.noonRolled && this.minute() >= 13 * 60) {
      this.noonRolled = true;
      if (Math.random() < 0.5) this.rollWeather();
    }
    if (prev === this.phase) return;
    this.rollWeather();
    if (this.phase === 'night') {
      // 夜：大群が押し寄せるのではなく、闇の中で屋外の感染体が鋭くなる（巡回は少しだけ）
      this.spawnPatrols(1);
      const finalNight = this.rescue.day > 0 && this.day + 1 >= this.rescue.day;
      if (finalNight) {
        // 救助の前の晩：最後の防衛。いつもの大群より多く、長い
        this.hordeNight = true;
        this.hordeWaves = 5;
        this.hordeT = 0;
        this.events.push({ k: 'banner', t: `DAY ${this.day} - 最後の夜`, s: '夜明けに救助ヘリが来る。それまで拠点を守り抜け！', c: '#f0c040', snd: 'horde' });
      } else if (isHordeDay(this.day)) {
        // 大群の夜：拠点の柵も破られる。3回に分けて押し寄せる
        this.hordeNight = true;
        this.hordeWaves = 3;
        this.hordeT = 0;
        this.events.push({ k: 'banner', t: `DAY ${this.day} - 大群の夜`, s: '大群が押し寄せる。今夜は拠点の柵も破られる — 朝まで持ちこたえろ', c: '#e0583e', snd: 'horde' });
      } else this.events.push({ k: 'banner', t: `DAY ${this.day} - 夜`, s: '闇が濃くなった。懐中電灯の光はゾンビにも見えている', c: '#aab4c8', snd: 'night' });
    } else {
      if (this.hordeNight) {
        // 大群の夜を越えた：生き残った人に経験値、拠点の収納箱に特別な補給
        this.hordeNight = false;
        this.hordeWaves = 0;
        this.hordeReward = true;
        for (const z of this.zombies) z.keep = false;
        for (const p of this.players) {
          if (p.status !== 'alive') continue;
          this.gainXp(p, 2, 25);
          this.gainXp(p, 1, 15);
        }
        this.events.push({ k: 'banner', t: `DAY ${this.day}`, s: '大群の夜を越えた！ 拠点の収納箱に特別な補給が届いている', c: '#e0cfa8', snd: 'clear' });
      } else this.events.push({ k: 'banner', t: `DAY ${this.day}`, s: '夜を越えた。物資を集めて拠点へ持ち帰れ', c: '#e0cfa8', snd: 'day' });
      // 夜露：雨水タンクに毎朝少しだけ水が貯まる
      for (const o of this.world.objects.values())
        if (o.kind === 'raintank' && o.ready < RAINTANK_MAX) {
          o.ready++;
          this.changed.add(o.id);
        }
      // 戦闘不能者は拠点で復帰（持ち物は倒れた場所に落ちたまま）
      const cx = (CAMPFIRE_TILE.x + 0.5) * TILE;
      const cy = (CAMPFIRE_TILE.y + 0.5) * TILE;
      for (const p of this.players) {
        if (p.status !== 'dead') continue;
        p.status = 'alive';
        p.hp = p.maxHp * 0.6;
        p.hunger = Math.max(p.hunger, 60);
        p.bleed = false;
        p.frac = 0;
        p.cold = 0;
        // 最後に眠った寝床があればそこ、なければ拠点の焚き火のそば
        p.x = p.home ? p.home.x : cx - 50;
        p.y = p.home ? p.home.y : cy - 30;
        this.giveStarterKit(p);
        this.events.push({ k: 'revive', id: p.id, x: p.x, y: p.y });
      }
      // 拠点の収納箱は毎朝補充（補給所・医務室のレベルで中身が増える）
      for (const o of this.world.objects.values()) {
        if (o.kind === 'box') {
          o.ready = 1;
          this.contents.set(o.id, this.morningSupplies(o));
          this.changed.add(o.id);
        }
      }
      this.hordeReward = false;
      // 救助の朝：生き残っていればクリア（少し間をおいて結果へ）
      if (this.rescue.day > 0 && this.day >= this.rescue.day) {
        this.winT = 7;
        this.events.push({ k: 'banner', t: '救助ヘリが到着！', s: `DAY ${this.day} — 生き延びた。全員、脱出する`, c: '#f0d070', snd: 'clear' });
        return;
      }
      this.checkRescueParts();
      this.announceThreat();
      this.newJobs(true);
      this.newSites(true);
      this.dayTip();
      // 次の補給物資の投下時刻
      this.dropAt = DAY_SECONDS * (0.12 + Math.random() * 0.45);
      this.noonRolled = false;
    }
  }

  // ======================== プレイヤー ========================

  private updatePlayer(p: SimPlayer, dt: number): void {
    // 通信が切れている仲間は、その場で待機（空腹・汚染・ダウンの時間も止める）
    if (p.away) {
      p.queue.length = 0;
      return;
    }
    // バッグの上限（マスと重さ）を、背負っている物・持っている武器から決め直す
    while (p.bag.length < BACKPACK_SLOTS) p.bag.push(null);
    {
      const cap = capacityOf(p.pack);
      setBagLimits(p.bag, cap.slots, cap.kg, slotKg(p.prim) + slotKg(p.sec));
    }
    for (const f of p.queue) {
      // 眠っている人は、動く・撃つ・ダッシュで目を覚ます
      if (p.sleeping) {
        if (Math.hypot(f.mx, f.my) > 0.1 || f.fire || f.dash) this.wake(p, '目を覚ました');
        else continue;
      }
      const px = p.x;
      const py = p.y;
      const dashing = p.dashTime > 0;
      // 車に乗っている間は歩かない（運転手の入力は車へ）
      const veh = p.veh ? this.vehicles.find((v) => v.id === p.veh) : undefined;
      if (veh) {
        if (p.seat === 0) veh.inp = { mx: f.mx, my: f.my };
      } else stepMovement(p, f, f.dt, p.status, this.world);
      if (!dashing && p.dashTime > 0) this.gainXp(p, 1, 1.5);
      if (p.status === 'alive' && p.dashTime > 0) p.stepNoiseT += f.dt * 3;
      else if (Math.hypot(p.x - px, p.y - py) > 0.5) p.stepNoiseT += f.dt;
      p.ack = f.seq;
      p.aim = f.aim;
      // 運転手は撃てない（同乗者は窓から撃てる）
      p.fire = f.fire && !(veh && p.seat === 0);
      p.revive = f.revive;
      p.tx = f.tx;
      p.ty = f.ty;
      if (f.tool >= 0 && f.tool < USABLE_SLOTS && f.tool !== p.tool) {
        p.tool = f.tool;
        p.reloadT = 0;
      }
      if (p.status !== 'alive') continue;
      if (f.op) this.invOp(p, f.op);
      if (f.interact) this.interact(p);
      if (f.reload) this.startReload(p);
      if (f.craft) this.craft(p, f.craft);
      if (f.eat) this.useFood(p, true);
      if (f.heal) this.useMeds(p, true);
      if (f.ping) this.ping(p, f.tx, f.ty);
    }
    if (p.queue.length > 0) p.idle = 0;
    else if ((p.idle += dt) > 0.3) {
      p.fire = false;
      p.revive = false;
    }
    p.queue.length = 0;
    p.warnCd = Math.max(0, p.warnCd - dt);
    // 反動は時間で戻る（武器ごとに戻り方が違う：ハンドガン・SMGは素早く、ライフルはゆっくり）
    {
      const hw = heldWeapon(p);
      const rec = hw ? HEAT_RECOVER[hw.id as WeaponId] : 5;
      p.heat = Math.max(0, p.heat - p.heat * rec * dt - 0.02 * dt);
    }
    if (p.stimT > 0) {
      p.stimT -= dt;
      if (p.stimT <= 0) this.applySkills(p);
    }
    if ((p.rested ?? 0) > 0) {
      p.rested = (p.rested ?? 0) - dt;
      if (p.rested <= 0) {
        p.rested = 0;
        this.applySkills(p);
      }
    }

    if (p.status === 'down') {
      p.search = null;
      p.viewing = 0;
      if (p.reviveProgress <= 0) p.downTimer -= dt;
      if (p.downTimer <= 0) this.killPlayer(p);
      return;
    }
    if (p.status !== 'alive') return;

    // 足音（歩きは小さく、走ると遠くまで聞こえる）
    if (p.stepNoiseT > 0.45) {
      p.stepNoiseT = 0;
      this.makeNoise(p.x, p.y, p.dashTime > 0 ? 220 : 70, false);
    }

    // 空腹（拠点の焚き火のそばで休んでいる間は減らない）
    const cfx = (CAMPFIRE_TILE.x + 0.5) * TILE;
    const cfy = (CAMPFIRE_TILE.y + 0.5) * TILE;
    const resting = Math.hypot(p.x - cfx, p.y - cfy) < 170 || !!this.nearKind(p, FIRE_KINDS, 170);
    if (!resting) p.hunger = Math.max(0, p.hunger - (100 / PLAYER.hungerSeconds) * dt * ((p.rested ?? 0) > 0 ? 0.75 : 1));
    if (p.hunger <= 0) {
      p.hp -= PLAYER.starveDps * dt;
      if (p.warnCd <= 0) {
        this.pop(p, '空腹でHPが減っている！ [Q]で食事', '#c99a5a');
        p.warnCd = 6;
      }
      if (p.hp <= 0) this.downPlayer(p);
      if (p.status !== 'alive') return;
    }
    // 拠点の焚き火のそばで休むと HP が回復
    if (resting && p.hp < p.maxHp) p.hp = Math.min(p.maxHp, p.hp + MED_REGEN[this.base.med] * dt);
    this.updateTox(p, dt);
    if (p.status !== 'alive') return;
    this.updateBody(p, dt);
    if (p.status !== 'alive') return;

    // 探索の進行（動いたり攻撃を受けたら中断）
    if (p.search) {
      const s = p.search;
      const o = this.world.objects.get(s.cid);
      if (!o || Math.hypot(p.x - s.x, p.y - s.y) > 26) {
        p.search = null;
      } else {
        s.t += dt;
        if (s.t >= s.dur) {
          p.search = null;
          this.openContainer(p, o);
        }
      }
    }
    // 中身を見ている入れ物から離れたら閉じる
    if (p.viewing >= VEHICLE.trunkBase) {
      const v = this.vehicles.find((q) => trunkId(q) === p.viewing);
      if (!v || Math.hypot(v.x - p.x, v.y - p.y) > 110 || Math.abs(v.spd) > 40) p.viewing = 0;
    } else if (p.viewing) {
      const o = this.world.objects.get(p.viewing);
      if (!o || Math.hypot((o.tx + 0.5) * TILE - p.x, (o.ty + 0.5) * TILE - p.y) > 100) p.viewing = 0;
    }
    if (p.storage && !this.nearKind(p, STORAGE_KINDS, 110)) p.storage = 0;

    // リロード
    if (p.reloadT > 0) {
      p.reloadT -= dt;
      if (p.reloadT <= 0) this.finishReload(p);
    }

    p.fireCd = Math.max(-1, p.fireCd - dt);
    p.swingCd = Math.max(0, p.swingCd - dt);
    p.useCd = Math.max(0, p.useCd - dt);
    if (!p.fire) {
      if (p.fireCd < 0) p.fireCd = 0;
      return;
    }
    switch (p.tool) {
      case Tool.Melee:
        if (p.swingCd <= 0) {
          this.swingAxe(p);
          p.swingCd = AXE.interval;
        }
        break;
      case Tool.Primary:
      case Tool.Secondary: {
        const slot = p.tool === Tool.Primary ? p.prim : p.sec;
        if (slot && isWeapon(slot.id)) this.fireWeapon(p, slot);
        else if (p.warnCd <= 0) {
          this.pop(p, p.tool === Tool.Primary ? 'メイン武器がない（Tabで装備）' : 'サブ武器がない', '#c87a6a');
          p.warnCd = 1.5;
        }
        break;
      }
      case Tool.Meds:
        if (p.useCd <= 0) {
          this.useMeds(p, true);
          p.useCd = 0.8;
        }
        break;
      case Tool.Food:
        if (p.useCd <= 0) {
          this.useFood(p, true);
          p.useCd = 0.8;
        }
        break;
    }
  }

  /** 汚染度：外縁の汚染帯・最深部・汚染地帯で上がり、離れると下がる。高いと HP が減り、せき込んでゾンビを呼ぶ */
  private updateTox(p: SimPlayer, dt: number): void {
    const tx = Math.floor(p.x / TILE);
    const ty = Math.floor(p.y / TILE);
    const ed = edgeDistance(tx, ty);
    const band = ed < EDGE_BAND ? 1 - ed / EDGE_BAND : 0;
    const loc = locationAt(this.world.locations, tx, ty);
    const deep = tierAtDistance(Math.hypot(tx - BASE_TX, ty - BASE_TY)) >= 4 ? 0.5 : 0;
    // 外縁に近づくほど急激に上がる（地図の端の手前で自然に引き返すことになる）
    const rate = band * band * 34 + band * 4 + deep + (loc?.hot ? 2.2 : 0);
    if (rate > 0.05) p.tox = Math.min(100, p.tox + rate * dt);
    else p.tox = Math.max(0, p.tox - (inBase(p.x, p.y) ? 14 : 3) * dt);
    // 段階ごとの警告
    const stage = p.tox >= 80 ? 3 : p.tox >= 50 ? 2 : p.tox >= 20 ? 1 : 0;
    if (stage > p.toxWarn) {
      const msg = ['', '汚染度が上がっている。長居は危険', '汚染度 50% 超え：HP が減り始めた。引き返せ', '汚染度が危険域。せき込みでゾンビが寄ってくる'][stage];
      this.events.push({ k: 'feed', cat: 'danger', t: `${p.name}：${msg}`, c: '#c0d060', id: p.id, snd: stage >= 2 ? 'alarm' : undefined });
      this.pop(p, `汚染 ${Math.round(p.tox)}%`, '#c0d060');
    }
    p.toxWarn = stage === 0 && p.tox < 10 ? 0 : Math.max(p.toxWarn, stage);
    if (p.tox > 50) {
      p.hp -= ((p.tox - 50) / 18) * dt;
      if (p.hp <= 0) this.downPlayer(p);
    }
    if (p.tox > 70) {
      p.coughT -= dt;
      if (p.coughT <= 0) {
        p.coughT = 5 + Math.random() * 3;
        this.makeNoise(p.x, p.y, 420, false);
        this.pop(p, 'ゴホッ…', '#c0d060');
      }
    }
  }

  /** はじめの一日：ステップを達成（初めての時だけ知らせる。全部そろったら、ごほうび） */
  private tutMark(p: SimPlayer, bit: number): void {
    const cur = p.tut ?? 0;
    if (cur & bit) return;
    p.tut = cur | bit;
    const step = TUT_STEPS.find((x) => x.bit === bit);
    const left = TUT_STEPS.filter((x) => !(p.tut! & x.bit)).length;
    if (step) this.events.push({ k: 'feed', cat: 'up', t: `✓ はじめの一日：${step.title}${left ? `（あと ${left}）` : ''}`, c: '#c9e08a', id: p.id });
    if (p.tut === TUT_ALL) {
      for (const [id, n] of TUT_REWARD) {
        const rest = addItem(p.bag, id as ItemId, n);
        if (rest > 0) addItem(this.storage.shared, id as ItemId, rest);
      }
      this.events.push({ k: 'feed', cat: 'up', t: `はじめの一日を達成！ ごほうび：包帯×2・9mm弾×24・缶詰×2。ここからは自由に生き延びよう`, c: '#e0c060', id: p.id, snd: 'day' });
    }
  }

  private pop(p: SimPlayer, t: string, c: string, s?: SoundKey): void {
    this.events.push({ k: 'pop', x: p.x, y: p.y - 30, t, c, id: p.id, s: s ?? (c === '#c87a6a' ? 'error' : undefined) });
  }

  private fireWeapon(p: SimPlayer, slot: Slot): void {
    if (p.reloadT > 0 || !slot.w || !isWeapon(slot.id)) return;
    const w = effectiveStats(slot.id, slot.w);
    if (slot.w.mag <= 0) {
      if (countItem(p.bag, w.ammo) > 0) this.startReload(p);
      else if (p.warnCd <= 0) {
        this.pop(p, `${ITEMS[w.ammo].name}がない`, '#c87a6a');
        p.warnCd = 1.5;
      }
      return;
    }
    const sk = skillMods(p.xp);
    while (p.fireCd <= 0 && slot.w.mag > 0) {
      const spread = w.spread + p.heat + Math.max(0, (p.fatigue ?? 0) - FATIGUE_BAD) / (100 - FATIGUE_BAD) * 0.07;
      for (let i = 0; i < w.pellets; i++) {
        const a = p.aim + (Math.random() - 0.5) * 2 * spread;
        const sp = w.bulletSpeed * (w.pellets > 1 ? 0.85 + Math.random() * 0.3 : 1);
        this.bullets.push({
          id: this.nextId++,
          owner: p.id,
          dmg: w.damage,
          knock: w.knock,
          x: p.x + Math.cos(p.aim) * MUZZLE,
          y: p.y + Math.sin(p.aim) * MUZZLE,
          vx: Math.cos(a) * sp,
          vy: Math.sin(a) * sp,
          life: w.bulletLife * (w.pellets > 1 ? 0.8 + Math.random() * 0.4 : 1),
          pierce: w.pierce,
          ap: w.armorPierce,
          hit: [],
          dead: false,
        });
      }
      // 反動：連射するほどばらつきが増える（グリップ・スキルで軽減）
      p.heat = Math.min(HEAT_MAX[slot.id as WeaponId] ?? 0.35, p.heat + w.recoil * sk.recoilMul);
      slot.w.mag--;
      p.shots++;
      p.fireCd += w.fireInterval;
      this.makeNoise(p.x, p.y, w.noiseRadius, true);
      // セミオートは1クリック1発（押しっぱなしでも間隔を空けて撃つ）
      if (!w.auto) break;
    }
    if (slot.w.mag <= 0 && countItem(p.bag, w.ammo) > 0) this.startReload(p);
  }

  private startReload(p: SimPlayer): void {
    const key = p.tool === Tool.Primary ? 'prim' : p.tool === Tool.Secondary ? 'sec' : '';
    if (!key || p.reloadT > 0) return;
    const slot = p[key];
    if (!slot || !slot.w || !isWeapon(slot.id)) return;
    const w = effectiveStats(slot.id, slot.w);
    if (slot.w.mag >= w.magSize) return;
    if (countItem(p.bag, w.ammo) <= 0) {
      if (p.warnCd <= 0) {
        this.pop(p, `${ITEMS[w.ammo].name}がない`, '#c87a6a');
        p.warnCd = 1.5;
      }
      return;
    }
    p.reloadT = w.reloadTime * skillMods(p.xp).reloadMul;
    p.reloadSlot = key;
  }

  private finishReload(p: SimPlayer): void {
    p.reloadT = 0;
    const key = p.reloadSlot;
    p.reloadSlot = '';
    if (!key) return;
    const slot = p[key];
    if (!slot || !slot.w || !isWeapon(slot.id)) return;
    const w = effectiveStats(slot.id, slot.w);
    slot.w.mag += removeItem(p.bag, w.ammo, w.magSize - slot.w.mag);
  }

  private eat(p: SimPlayer, id: ItemId): void {
    if (id === 'stew' || id === 'tea') {
      removeItem(p.bag, id, 1);
      const was = (p.rested ?? 0) > 0;
      if (id === 'stew') {
        p.hunger = Math.min(100, p.hunger + 60);
        p.hp = Math.min(p.maxHp, p.hp + 20);
        p.rested = Math.max(p.rested ?? 0, 360);
      } else {
        p.tox = Math.max(0, p.tox - 30);
        p.hp = Math.min(p.maxHp, p.hp + 8);
        p.rested = Math.max(p.rested ?? 0, 120);
      }
      if (!was) this.applySkills(p);
      this.pop(p, id === 'stew' ? '温かいシチュー！ 空腹+60・HP+20・休息済み' : 'ハーブティー：汚染 -30・休息済み', '#e0b25a', 'eat');
      return;
    }
    removeItem(p.bag, id, 1);
    p.hunger = Math.min(100, p.hunger + (id === 'mre' ? 70 : 35));
    if (id === 'mre') p.hp = Math.min(p.maxHp, p.hp + 10);
    // 焚き火のそばで温かい食事：少し回復し、しばらく「休息済み」
    const cfd = Math.hypot((CAMPFIRE_TILE.x + 0.5) * TILE - p.x, (CAMPFIRE_TILE.y + 0.5) * TILE - p.y);
    if (cfd < 170 || this.nearKind(p, FIRE_KINDS, 170)) {
      p.hp = Math.min(p.maxHp, p.hp + 12);
      const was = (p.rested ?? 0) > 0;
      p.rested = Math.max(p.rested ?? 0, 180);
      if (!was) this.applySkills(p);
      this.pop(p, `焚き火で${ITEMS[id].name}を温めて食べた — 休息済み`, '#e0b25a', 'eat');
      return;
    }
    this.pop(p, `${ITEMS[id].name}を食べた`, '#c9a86a', 'eat');
  }

  private heal(p: SimPlayer, id: ItemId): void {
    if (id === 'painkiller' || id === 'salve') {
      removeItem(p.bag, id, 1);
      if (id === 'salve') {
        p.hp = Math.min(p.maxHp, p.hp + 15);
        if (p.bleed) p.bleed = false;
        this.pop(p, '薬草の軟膏：止血・HP +15', '#8fbf8a', 'heal');
      } else {
        p.hp = Math.min(p.maxHp, p.hp + 10);
        p.fatigue = Math.max(0, (p.fatigue ?? 0) - 25);
        this.pop(p, '鎮痛剤：HP +10・疲労 -25', '#8fbf8a', 'heal');
      }
      return;
    }
    if (id === 'splint') {
      removeItem(p.bag, id, 1);
      p.frac = 2;
      p.fracT = 150;
      this.updateMoveMods(p);
      this.pop(p, '添え木を当てた：約2分半で治る', '#8fbf8a', 'heal');
      return;
    }
    removeItem(p.bag, id, 1);
    if ((id === 'bandage' || id === 'medkit') && p.bleed) {
      p.bleed = false;
      this.pop(p, '止血した', '#8fbf8a');
    }
    const v = Math.round((id === 'medkit' ? 65 : id === 'stim' ? 15 : id === 'antitox' ? 10 : id === 'herbs' ? 12 : 25) * skillMods(p.xp).healMul);
    p.hp = Math.min(p.maxHp, p.hp + v);
    if (id === 'medkit') p.tox = Math.max(0, p.tox - 25);
    if (id === 'antitox') p.tox = Math.max(0, p.tox - 60);
    if (id === 'herbs') p.tox = Math.max(0, p.tox - 10);
    if (id === 'stim') {
      p.tox = Math.max(0, p.tox - 15);
      p.stimT = 30;
      this.applySkills(p);
      p.stamina = p.stmMax ?? PLAYER.maxStamina;
      p.staminaDelay = 0;
    }
    this.gainXp(p, 3, id === 'medkit' ? 5 : 2);
    this.pop(p, id === 'stim' ? `興奮剤！ HP +${v}・スタミナ全快` : id === 'antitox' ? '解毒剤：汚染度 -60' : `HP +${v}`, '#8fbf8a', 'heal');
  }

  private useFood(p: SimPlayer, explicit: boolean): boolean {
    const id: ItemId | null = countItem(p.bag, 'can') > 0 ? 'can' : countItem(p.bag, 'mre') > 0 ? 'mre' : null;
    if (!id) {
      if (explicit) this.pop(p, '食料がない', '#c87a6a');
      return false;
    }
    if (p.hunger >= 98) {
      if (explicit) this.pop(p, 'お腹はいっぱい', '#cccccc');
      return false;
    }
    this.eat(p, id);
    return true;
  }

  private useMeds(p: SimPlayer, explicit: boolean): boolean {
    // 出血・骨折の手当てを先に
    if (p.bleed && (countItem(p.bag, 'bandage') > 0 || countItem(p.bag, 'medkit') > 0)) {
      this.heal(p, countItem(p.bag, 'bandage') > 0 ? 'bandage' : 'medkit');
      return true;
    }
    if (p.frac === 1 && countItem(p.bag, 'splint') > 0) {
      this.heal(p, 'splint');
      return true;
    }
    // 汚染が重いときは解毒剤を優先
    if (p.tox >= 45 && countItem(p.bag, 'antitox') > 0) {
      this.heal(p, 'antitox');
      return true;
    }
    if (p.hp >= p.maxHp) {
      if (explicit) this.pop(p, 'HPは満タン', '#cccccc');
      return false;
    }
    // 減りが大きいときは救急キット、少ないときは包帯
    const big = p.maxHp - p.hp > 45;
    const hasK = countItem(p.bag, 'medkit') > 0;
    const hasB = countItem(p.bag, 'bandage') > 0;
    const hasH = countItem(p.bag, 'herbs') > 0;
    const id: ItemId | null = big && hasK ? 'medkit' : hasB ? 'bandage' : hasH ? 'herbs' : hasK ? 'medkit' : null;
    if (!id) {
      if (explicit) this.pop(p, '回復アイテムがない', '#c87a6a');
      return false;
    }
    this.heal(p, id);
    return true;
  }

  // ======================== インベントリ操作 ========================

  private invOp(p: SimPlayer, op: string): void {
    const parts = op.split(':');
    const [cmd, a, b] = parts;
    const n = (v: string | undefined) => Math.max(0, Math.floor(Number(v) || 0));
    switch (cmd) {
      case 'close':
        p.viewing = 0;
        p.storage = 0;
        break;
      case 'take': {
        // 入れ物 → バックパック
        if (n(a) !== p.viewing) return;
        const c = this.contents.get(p.viewing);
        const s = c?.[n(b)];
        if (!c || !s) return;
        const left = addItem(p.bag, s.id, s.n, s.w);
        if (left === s.n) return this.pop(p, this.fullMsg(p), '#c87a6a');
        if (left > 0) s.n = left;
        else c[n(b)] = null;
        this.pop(p, ITEMS[s.id].name, '#d8c48a', 'loot');
        break;
      }
      case 'takeall': {
        if (n(a) !== p.viewing) return;
        const c = this.contents.get(p.viewing);
        if (!c) return;
        let any = false;
        for (let i = 0; i < c.length; i++) {
          const s = c[i];
          if (!s) continue;
          const left = addItem(p.bag, s.id, s.n, s.w);
          if (left < s.n) any = true;
          if (left > 0) s.n = left;
          else c[i] = null;
        }
        if (any) this.pop(p, '回収', '#d8c48a', 'loot');
        if (c.some((s) => s)) this.pop(p, this.fullMsg(p), '#c87a6a');
        break;
      }
      case 'put': {
        // バックパック → 入れ物
        if (n(a) !== p.viewing) return;
        const c = this.contents.get(p.viewing);
        const s = p.bag[n(b)];
        if (!c || !s) return;
        const left = addItem(c, s.id, s.n, s.w);
        if (left > 0) s.n = left;
        else p.bag[n(b)] = null;
        break;
      }
      case 'use': {
        const s = p.bag[n(a)];
        if (!s) return;
        const cat = ITEMS[s.id].cat;
        if (cat === 'food') {
          if (p.hunger >= 98) return this.pop(p, 'お腹はいっぱい', '#cccccc');
          this.eat(p, s.id);
        } else if (cat === 'med') {
          const cleans = s.id === 'antitox' || s.id === 'herbs' || s.id === 'medkit' || s.id === 'stim';
          const treats = (p.bleed && (s.id === 'bandage' || s.id === 'medkit' || s.id === 'salve')) || (s.id === 'splint' && p.frac === 1) || s.id === 'painkiller';
          if (s.id === 'splint' && p.frac !== 1) return this.pop(p, '骨折していない', '#cccccc');
          if (p.hp >= p.maxHp && !(cleans && p.tox > 0) && !treats) return this.pop(p, 'HPは満タン', '#cccccc');
          this.heal(p, s.id);
        } else if (isWeapon(s.id)) this.equip(p, n(a));
        else if (PACKS[s.id]) this.wearPack(p, n(a));
        else if (s.id === 'decoy' || s.id === 'pipebomb') this.throwItem(p, s.id);
        else if (s.id === 'upkit') this.upgradeWeapon(p);
        break;
      }
      case 'equip':
        this.equip(p, n(a));
        break;
      case 'unequip': {
        if (a === 'pack') {
          this.takeOffPack(p);
          break;
        }
        const key = a === 'prim' ? 'prim' : 'sec';
        const s = p[key];
        if (!s) return;
        if (freeSlots(p.bag) <= 0) return this.pop(p, this.fullMsg(p), '#c87a6a');
        addItem(p.bag, s.id, 1, s.w);
        p[key] = null;
        p.reloadT = 0;
        break;
      }
      case 'drop': {
        // 足元に置く（袋に入る）
        const s = p.bag[n(a)];
        if (!s) return;
        const bag = this.groundBag(p.x, p.y);
        if (!bag) return;
        const left = addItem(this.contents.get(bag.id)!, s.id, s.n, s.w);
        if (left > 0) s.n = left;
        else p.bag[n(a)] = null;
        this.changed.add(bag.id);
        break;
      }
      case 'st': {
        // 拠点の倉庫：st:put:shared:<bagIdx> / st:take:personal:<idx> / st:putall:shared
        if (!p.storage) return;
        const dir = parts[1];
        const box = parts[2] === 'shared' ? this.storage.shared : this.storage.personal[p.id];
        if (!box) return;
        const i = n(parts[3]);
        if (dir === 'put') {
          const s = p.bag[i];
          if (!s) return;
          const left = addItem(box, s.id, s.n, s.w);
          if (left === s.n) return this.pop(p, '倉庫がいっぱい', '#c87a6a');
          if (left > 0) s.n = left;
          else p.bag[i] = null;
        } else if (dir === 'putall') {
          // 武器以外を全部預ける
          for (let k = 0; k < p.bag.length; k++) {
            const s = p.bag[k];
            if (!s || isWeapon(s.id)) continue;
            const left = addItem(box, s.id, s.n, s.w);
            if (left > 0) s.n = left;
            else p.bag[k] = null;
          }
        } else if (dir === 'take') {
          const s = box[i];
          if (!s) return;
          const left = addItem(p.bag, s.id, s.n, s.w);
          if (left === s.n) return this.pop(p, this.fullMsg(p), '#c87a6a');
          if (left > 0) s.n = left;
          else box[i] = null;
        }
        this.storage.ver++;
        break;
      }
      case 'build':
        this.build(p, a, n(b), n(parts[3]));
        break;
      case 'unbuild':
        this.unbuild(p, n(a));
        break;
      case 'ammo': {
        // 弾種の切り替え：ammo:prim|sec → 弾倉の中身をバッグに戻し、もう一方の弾で装填し直す
        const key = a === 'prim' ? 'prim' : 'sec';
        const slot = p[key];
        if (!slot || !slot.w || !isWeapon(slot.id)) return;
        const want = slot.w.ap ? 0 : 1;
        const next = ammoOf(slot.id, { ...slot.w, ap: want });
        if (countItem(p.bag, next) <= 0) return this.pop(p, `${ITEMS[next].name}を持っていない`, '#c87a6a');
        const left = addItem(p.bag, ammoOf(slot.id, slot.w), slot.w.mag);
        if (left > 0) return this.pop(p, this.fullMsg(p), '#c87a6a');
        slot.w.mag = 0;
        if (want) slot.w.ap = 1;
        else delete slot.w.ap;
        this.pop(p, `${ITEMS[next].name}に切り替え`, '#d8c48a', 'craft');
        p.tool = key === 'prim' ? Tool.Primary : Tool.Secondary;
        p.reloadT = 0;
        this.startReload(p);
        break;
      }
      case 'give': {
        // 近くの仲間に直接渡す：give:<相手のID>:<バッグの位置>
        const to = this.players.find((q) => q.id === n(a) && q !== p && q.status === 'alive' && Math.hypot(q.x - p.x, q.y - p.y) < GIVE_RANGE);
        const s = p.bag[n(b)];
        if (!to || !s) return this.pop(p, '仲間が近くにいない', '#c87a6a');
        const left = addItem(to.bag, s.id, s.n, s.w);
        if (left === s.n) return this.pop(p, `${to.name}のバッグがいっぱい`, '#c87a6a');
        if (left > 0) s.n = left;
        else p.bag[n(b)] = null;
        this.events.push({ k: 'pop', x: to.x, y: to.y - 30, t: `${p.name}から ${ITEMS[s.id].name}`, c: '#d8c48a', id: to.id, s: 'loot' });
        this.pop(p, `${to.name}に ${ITEMS[s.id].name} を渡した`, '#d8c48a');
        break;
      }
      case 'upg': {
        // 拠点設備の強化：upg:<facility>（バッグ → 共有倉庫の順に素材を使う）
        if (!this.nearKind(p, BENCH_KINDS, BENCH_RANGE)) return this.pop(p, '作業台の近くで行う', '#c87a6a');
        const def = FACILITIES.find((f) => f.id === a);
        if (!def) return;
        const lv = this.base[def.id];
        const cur = def.id === 'bench' ? lv - 1 : lv;
        const cost = def.costs[cur];
        if (!cost) return this.pop(p, 'これ以上強化できない', '#cccccc');
        const entries = Object.entries(cost) as [ItemId, number][];
        for (const [m, need] of entries)
          if (countItem(p.bag, m) + countItem(this.storage.shared, m) < need) return this.pop(p, `素材が足りない（${ITEMS[m].name}）`, '#c87a6a');
        for (const [m, need] of entries) {
          const got = removeItem(p.bag, m, need);
          if (got < need) removeItem(this.storage.shared, m, need - got);
        }
        this.base[def.id] = lv + 1;
        if (def.id === 'storage') this.resizeStorage();
        this.storage.ver++;
        this.events.push({ k: 'feed', cat: 'up', t: `${p.name} が拠点の${def.name}を強化した（Lv${this.base[def.id]}）`, c: '#e0cfa8', snd: 'level' });
        this.pop(p, `${def.name} 強化！`, '#e0cfa8', 'craft');
        break;
      }
      case 'mod': {
        // 武器にアタッチメントを付け外し：mod:prim|sec:<att>
        if (!this.nearKind(p, BENCH_KINDS, BENCH_RANGE)) return this.pop(p, '作業台の近くで行う', '#c87a6a');
        const key = a === 'prim' ? 'prim' : 'sec';
        const slot = p[key];
        const att = ATTACHMENTS.find((x) => x === b);
        if (!slot || !slot.w || !att || !isWeapon(slot.id)) return;
        if (slot.w[att]) {
          if (addItem(p.bag, att, 1) > 0) return this.pop(p, this.fullMsg(p), '#c87a6a');
          delete slot.w[att];
          this.pop(p, `${ITEMS[att].name}を外した`, '#d8c48a', 'craft');
        } else {
          if (removeItem(p.bag, att, 1) < 1) return this.pop(p, `${ITEMS[att].name}を持っていない`, '#c87a6a');
          // 光学サイトは1つだけ（付け替えると外したものはバッグへ）
          const other = att === 'scope' ? 'holo' : att === 'holo' ? 'scope' : null;
          if (other && slot.w[other]) {
            delete slot.w[other];
            if (addItem(p.bag, other, 1) > 0) {
              const bag = this.groundBag(p.x, p.y);
              if (bag) addItem(this.contents.get(bag.id)!, other, 1);
            }
          }
          slot.w[att] = 1;
          this.pop(p, `${ITEMS[att].name}を取り付けた`, '#d8c48a', 'craft');
        }
        slot.w.mag = Math.min(slot.w.mag, effectiveStats(slot.id, slot.w).magSize);
        break;
      }
    }
  }

  // ---- 投げる物（おとり時計・パイプ爆弾） ----
  private throwns: { kind: 'decoy' | 'pipebomb'; x: number; y: number; t: number; pulse: number; owner: number }[] = [];

  /** 狙った所へ投げる（届くのは 7 マスほど。壁があれば手前に落ちる） */
  private throwItem(p: SimPlayer, id: 'decoy' | 'pipebomb'): void {
    const want = Math.min(280, Math.hypot((p.tx + 0.5) * TILE - p.x, (p.ty + 0.5) * TILE - p.y) || 200);
    let x = p.x;
    let y = p.y;
    const dx = Math.cos(p.aim);
    const dy = Math.sin(p.aim);
    for (let d = 0; d < want; d += 10) {
      const nx = p.x + dx * d;
      const ny = p.y + dy * d;
      if (this.world.solid(Math.floor(nx / TILE), Math.floor(ny / TILE))) break;
      x = nx;
      y = ny;
    }
    removeItem(p.bag, id, 1);
    this.throwns.push({ kind: id, x, y, t: id === 'decoy' ? 10 : 2, pulse: 0, owner: p.id });
    this.events.push({ k: 'crash', x, y, hard: 0.15 });
    this.pop(p, id === 'decoy' ? 'おとり時計を投げた — 10 秒鳴り続ける' : 'パイプ爆弾を投げた！ 離れろ', '#e0b25a');
  }

  private updateThrowns(dt: number): void {
    for (const t of this.throwns) {
      t.t -= dt;
      t.pulse -= dt;
      if (t.kind === 'decoy' && t.pulse <= 0) {
        t.pulse = 1.2;
        this.makeNoise(t.x, t.y, 650, true);
      }
      if (t.kind === 'pipebomb') {
        if (t.pulse <= 0) {
          t.pulse = 0.35;
          this.events.push({ k: 'crash', x: t.x, y: t.y, hard: 0.1 });
        }
        // 導火線が尽きたら爆発（音でも寄せる）
        if (t.t <= 0) this.explode(t.x, t.y);
      }
    }
    this.throwns = this.throwns.filter((t) => t.t > 0);
  }

  /** 武器強化キット：手に持っている武器の品質を 1 段上げる（希少まで。それ以上は精鋭・特別な場所で） */
  private upgradeWeapon(p: SimPlayer): void {
    const key = p.tool === Tool.Primary ? 'prim' : p.tool === Tool.Secondary ? 'sec' : null;
    const w = key ? p[key] : null;
    if (!w || !w.w) return this.pop(p, '強化したい銃を手に持ってから使おう', '#c87a6a');
    const q = w.w.q ?? 0;
    if (q >= 2) return this.pop(p, 'キットで上げられるのは「希少」まで（それ以上は精鋭や特別な場所で）', '#c87a6a');
    removeItem(p.bag, 'upkit', 1);
    const keepMag = w.w.mag;
    Object.assign(w.w, { ...rollQuality(q + 1), mag: keepMag });
    this.events.push({ k: 'built', x: p.x, y: p.y, kind: 'bench', id: p.id, repair: true });
    this.pop(p, `${ITEMS[w.id].name}が「${QUALITY[q + 1].name}」になった！`, QUALITY[q + 1].color, 'level');
  }

  /** バッグがいっぱい／重すぎる、の出し分け */
  private fullMsg(p: SimPlayer): string {
    const cap = capacityOf(p.pack);
    return lastAddLimitedByWeight ? `重すぎる（${loadKg(p).toFixed(1)}/${cap.kg}kg）— リュックで増やせる` : `バッグがいっぱい（${cap.slots}マス）`;
  }

  /** リュックを背負う（背負っていた物はバッグへ） */
  private wearPack(p: SimPlayer, idx: number): void {
    const s = p.bag[idx];
    if (!s || !PACKS[s.id]) return;
    const old = p.pack;
    p.bag[idx] = old ? { id: old, n: 1 } : null;
    p.pack = s.id;
    const c = capacityOf(p.pack);
    this.pop(p, `${ITEMS[s.id].name}を背負った：${c.slots}マス・${c.kg}kg`, '#d8c48a', 'craft');
  }

  /** リュックを下ろす：増えていたマスが空で、重さも収まるときだけ */
  private takeOffPack(p: SimPlayer): void {
    if (!p.pack) return;
    const base = capacityOf(null);
    if (p.bag.slice(base.slots).some((x) => x)) return this.pop(p, `下ろす前に、リュックの分のマス（${base.slots + 1}番目以降）を空けよう`, '#c87a6a');
    const kg = loadKg(p) + 0.01;
    if (kg > base.kg) return this.pop(p, `重すぎて下ろせない（${kg.toFixed(1)}/${base.kg}kg）`, '#c87a6a');
    const free = p.bag.slice(0, base.slots).findIndex((x) => !x);
    if (free < 0) return this.pop(p, 'バッグに空きがない', '#c87a6a');
    p.bag[free] = { id: p.pack, n: 1 };
    p.pack = undefined;
    this.pop(p, 'リュックを下ろした', '#d8c48a');
  }

  private equip(p: SimPlayer, idx: number): void {
    const s = p.bag[idx];
    if (!s || !isWeapon(s.id)) return;
    const key = WEAPON_STATS[s.id].secondary ? 'sec' : 'prim';
    const cur = p[key];
    p.bag[idx] = cur ? { ...cur } : null;
    p[key] = { ...s, w: s.w ? { ...s.w } : { mag: 0 } };
    p.tool = key === 'prim' ? Tool.Primary : Tool.Secondary;
    p.reloadT = 0;
    this.pop(p, `${ITEMS[s.id].name}を装備`, '#d8c48a', 'craft');
  }

  /** 足元の袋（なければ作る） */
  private groundBag(x: number, y: number): SimObj | null {
    const tx = Math.floor(x / TILE);
    const ty = Math.floor(y / TILE);
    for (let dy = -1; dy <= 1; dy++)
      for (let dx = -1; dx <= 1; dx++) {
        const o = this.world.objAt(tx + dx, ty + dy);
        if (o && o.kind === 'bag') return o;
      }
    for (const [dx, dy] of [[0, 0], [1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [-1, -1], [1, -1], [-1, 1]]) {
      const ox = tx + dx;
      const oy = ty + dy;
      if (!this.world.inBounds(ox, oy) || this.world.solid(ox, oy) || this.world.objAt(ox, oy)) continue;
      const o: SimObj = { id: this.nextObjId++, kind: 'bag', tx: ox, ty: oy, hp: 1, maxHp: 1, ready: 0, regrowT: 0 };
      this.world.setObj(o);
      this.contents.set(o.id, emptyBag(16));
      this.changed.add(o.id);
      return o;
    }
    return null;
  }

  // ======================== 体調（疲労・冷え・ケガ） ========================

  /** ケガ：fracChance で骨折、bleedChance で出血 */
  private injure(p: SimPlayer, fracChance: number, bleedChance: number): void {
    if (p.status !== 'alive') return;
    if (!p.frac && Math.random() < fracChance) {
      p.frac = 1;
      p.fracT = 600;
      this.updateMoveMods(p);
      this.pop(p, '骨折！ 足が遅くダッシュできない — 添え木（布2・鉄くず1）を [H] で', '#e0583e', 'alarm');
    } else if (!p.bleed && Math.random() < bleedChance) {
      p.bleed = true;
      this.pop(p, '出血！ HP が減り続ける — 包帯で止血 [H]', '#e0583e', 'alarm');
    }
  }

  /** 歩く速さの倍率とダッシュ可否（ゲストの予測でも同じ値を使う） */
  private updateMoveMods(p: SimPlayer): void {
    const k = Math.max(0, ((p.fatigue ?? 0) - FATIGUE_BAD) / (100 - FATIGUE_BAD));
    p.spdMul = r2((p.frac === 1 ? 0.7 : p.frac === 2 ? 0.88 : 1) * (1 - 0.18 * k));
    p.noDash = p.frac === 1;
  }

  private updateBody(p: SimPlayer, dt: number): void {
    // 疲労：起きている間に増える（休息済みならゆっくり）
    const fatBefore = p.fatigue ?? 0;
    if (!p.sleeping) p.fatigue = Math.min(100, fatBefore + FATIGUE_RATE * dt * ((p.rested ?? 0) > 0 ? 0.6 : 1));
    if (fatBefore < FATIGUE_BAD && (p.fatigue ?? 0) >= FATIGUE_BAD) this.pop(p, '疲れ切っている：狙いがぶれ、足が遅い — 夜に拠点のベッドで眠ろう', '#e0a33a');
    // 冷え：雨・嵐・夜の屋外で冷える。焚き火・たいまつ・かまどのそば、屋内、車の中で温まる。コートで半分
    const tx = Math.floor(p.x / TILE);
    const ty = Math.floor(p.y / TILE);
    let warm = false;
    for (let y = ty - 4; y <= ty + 4 && !warm; y++)
      for (let x = tx - 4; x <= tx + 4; x++) {
        const o = this.world.objAt(x, y);
        if (o && WARM_KINDS.has(o.kind) && Math.hypot((x + 0.5) * TILE - p.x, (y + 0.5) * TILE - p.y) < (o.kind === 'campfire' ? 180 : 130)) {
          warm = true;
          break;
        }
      }
    const indoor = INDOOR_FLOORS.has(this.world.terrainAt(tx, ty));
    let gain = 0;
    if (!indoor && !p.veh) {
      if (this.weather === 'storm') gain += 0.38 * this.wx;
      else if (this.weather === 'rain') gain += 0.26 * this.wx;
      if (this.phase === 'night') gain += 0.1;
    }
    if (countItem(p.bag, 'coat') > 0) gain *= 0.5;
    const coldBefore = p.cold ?? 0;
    let c = coldBefore;
    if (warm) c -= 5 * dt;
    else if (gain > 0) c += gain * dt;
    else c -= (indoor || p.veh ? 0.8 : 0.35) * dt;
    p.cold = Math.max(0, Math.min(100, c));
    if ((coldBefore >= COLD_SLOW) !== (p.cold >= COLD_SLOW)) {
      this.applySkills(p);
      if (p.cold >= COLD_SLOW) this.pop(p, '体が冷えている：スタミナの回復が遅い — 焚き火・屋内で温まろう', '#8ac0e0');
    }
    if (p.cold >= COLD_HURT) {
      p.hp -= 0.35 * dt;
      if (p.hp <= 0) return this.downPlayer(p);
    }
    // 出血：止血するまで HP が減る
    if (p.bleed) {
      p.hp -= 0.7 * dt;
      if (p.hp <= 0) return this.downPlayer(p);
    }
    // 骨折：添え木を当てると早く治る（当てないと 10 分）
    if (p.frac) {
      p.fracT = (p.fracT ?? 600) - dt;
      if (p.fracT <= 0) {
        p.frac = 0;
        this.pop(p, '骨折が治った', '#8fbf8a');
      }
    }
    this.updateMoveMods(p);
  }

  /** 拠点の初期配置：ベッドは参加人数分。倉庫は 1 つ（個人・共有はタブで切り替え） */
  private setupBase(n: number): void {
    const bx = SAFEHOUSE.x + 2;
    const by = SAFEHOUSE.y + 2;
    const inHouse = (o: SimObj) => o.tx > bx && o.ty > by && o.tx < bx + 7 && o.ty < by + 5;
    const drop = (o: SimObj) => {
      this.world.removeObj(o.id);
      this.changed.delete(o.id);
      this.removed.push(o.id);
    };
    for (const o of [...this.world.objects.values()]) if (o.kind === 'stash' && inHouse(o)) drop(o);
    const beds = [...this.world.objects.values()].filter((o) => o.kind === 'bed' && inHouse(o)).sort((a, b) => a.tx - b.tx);
    for (let i = Math.max(1, n); i < beds.length; i++) drop(beds[i]);
    for (let i = beds.length; i < n; i++) {
      const tx = bx + 1 + i;
      const ty = by + 4;
      if (this.world.objAt(tx, ty) || this.world.solid(tx, ty)) continue;
      const o: SimObj = { id: this.nextObjId++, kind: 'bed', tx, ty, hp: 1, maxHp: 1, ready: 0, regrowT: 0 };
      this.world.setObj(o);
      this.changed.add(o.id);
    }
  }

  // ======================== 車両 ========================

  /** 道路の上に車を置く：拠点の近くに1台（最初の目標）、遠くに数台 */
  private spawnVehicles(): void {
    const roads: { x: number; y: number; d: number; horiz: boolean }[] = [];
    for (let y = 4; y < MAP_H - 4; y += 2)
      for (let x = 4; x < MAP_W - 4; x += 2) {
        if (this.world.terrainAt(x, y) !== T_ROAD) continue;
        const horiz = this.world.terrainAt(x - 1, y) === T_ROAD && this.world.terrainAt(x + 1, y) === T_ROAD;
        const vert = this.world.terrainAt(x, y - 1) === T_ROAD && this.world.terrainAt(x, y + 1) === T_ROAD;
        if (horiz === vert) continue; // 交差点・端は避ける
        let clear = true;
        for (let dy = -1; dy <= 1 && clear; dy++) for (let dx = -1; dx <= 1 && clear; dx++) if (this.world.solid(x + dx, y + dy) || this.world.objAt(x + dx, y + dy)) clear = false;
        if (!clear) continue;
        roads.push({ x, y, d: Math.hypot(x - BASE_TX, y - BASE_TY), horiz });
      }
    const picked: typeof roads = [];
    const pick = (lo: number, hi: number) => {
      const pool = roads.filter((r) => r.d >= lo && r.d < hi && picked.every((q) => Math.hypot(q.x - r.x, q.y - r.y) > 30));
      if (!pool.length) return null;
      const r = pool[Math.floor(Math.random() * pool.length)];
      picked.push(r);
      return r;
    };
    const make = (r: (typeof roads)[number] | null, kind: 'sedan' | 'pickup', fuel: number) => {
      if (!r) return;
      const maxHp = kind === 'pickup' ? 360 : 280;
      this.vehicles.push({ id: this.vehSeq++, kind, x: (r.x + 0.5) * TILE, y: (r.y + 0.5) * TILE, a: r.horiz ? 0 : Math.PI / 2, spd: 0, fuel, hp: maxHp * 0.35, maxHp, broken: true, seats: [-1, -1, -1], inp: null, noiseT: 0 });
    };
    make(pick(14, 30), 'pickup', 18);
    for (const [lo, hi] of [[35, 70], [50, 100], [70, 130], [90, 160], [110, 190]] as [number, number][]) make(pick(lo, hi), Math.random() < 0.4 ? 'pickup' : 'sedan', Math.round(5 + Math.random() * 30));
  }

  /** 近くの車（車体のまわり 1 マスちょっと） */
  private nearVehicle(p: SimPlayer): SimVehicle | null {
    let best: SimVehicle | null = null;
    let bd = 62;
    for (const v of this.vehicles) {
      const d = Math.min(Math.hypot(v.x - p.x, v.y - p.y), Math.hypot(trunkPos(v).x - p.x, trunkPos(v).y - p.y) + 6);
      if (d < bd) {
        bd = d;
        best = v;
      }
    }
    return best;
  }

  /** [F]：後ろならトランク、壊れていたら修理、燃料が少なければ給油、それ以外は乗る */
  private useVehicle(p: SimPlayer, v: SimVehicle): void {
    const tp = trunkPos(v);
    const name = v.kind === 'pickup' ? 'ピックアップトラック' : 'セダン';
    if (Math.hypot(tp.x - p.x, tp.y - p.y) < 30 && Math.abs(v.spd) < 20) {
      const id = trunkId(v);
      if (!this.contents.has(id)) this.contents.set(id, emptyBag(VEHICLE.trunkSlots));
      p.viewing = id;
      this.pop(p, 'トランクを開けた', '#d8c48a', 'loot');
      return;
    }
    if (v.broken) {
      const cost = VEHICLE.repairCost as Partial<Record<ItemId, number>>;
      for (const [m, n] of Object.entries(cost) as [ItemId, number][])
        if (countItem(p.bag, m) + countItem(this.storage.shared, m) < n) return this.pop(p, `${name}は壊れている：直すには 鉄くず${cost.scrap}・武器パーツ${cost.parts}（足りない：${ITEMS[m].name}）`, '#c87a6a', 'error');
      this.payCost(p, cost);
      v.broken = false;
      v.hp = Math.max(v.hp, v.maxHp * 0.7);
      this.events.push({ k: 'built', x: v.x, y: v.y, kind: 'car', id: p.id, repair: true });
      this.gainXp(p, 2, 10);
      this.pop(p, `${name}を修理した！ 燃料 ${Math.round(v.fuel)}% — [F] で乗る`, '#93d07c', 'craft');
      return;
    }
    if (v.fuel < 65 && countItem(p.bag, 'fuel') > 0 && !v.seats.some((s) => s >= 0 && s !== p.id)) {
      removeItem(p.bag, 'fuel', 1);
      v.fuel = Math.min(100, v.fuel + VEHICLE.fuelPerCan);
      this.pop(p, `給油した：燃料 ${Math.round(v.fuel)}%`, '#e0b862', 'craft');
      return;
    }
    if (v.hp < v.maxHp * 0.5 && countItem(p.bag, 'scrap') >= 3) {
      removeItem(p.bag, 'scrap', 3);
      v.hp = Math.min(v.maxHp, v.hp + v.maxHp * 0.3);
      this.pop(p, `${name}を補修した（${Math.round((v.hp / v.maxHp) * 100)}%）`, '#93d07c', 'craft');
      return;
    }
    const seat = v.seats[0] < 0 ? 0 : v.seats.findIndex((s) => s < 0);
    if (seat < 0) return this.pop(p, '満席', '#c87a6a', 'error');
    v.seats[seat] = p.id;
    p.veh = v.id;
    p.seat = seat;
    p.search = null;
    p.dashTime = 0;
    const sp = seatPos(v, seat);
    p.x = sp.x;
    p.y = sp.y;
    this.pop(p, seat === 0 ? (v.fuel > 0 ? `運転席に乗った — 行きたい方向へ移動キー・[F] で降りる（燃料 ${Math.round(v.fuel)}%）` : '燃料がない！ ガソリン缶を探そう') : '同乗した — 窓から撃てる・[F] で降りる', '#8ac0e0');
  }

  private exitVehicle(p: SimPlayer, force = false): void {
    const v = this.vehicles.find((q) => q.id === p.veh);
    p.veh = undefined;
    p.seat = undefined;
    if (!v) return;
    const i = v.seats.indexOf(p.id);
    if (i >= 0) v.seats[i] = -1;
    if (i === 0) v.inp = null;
    if (!force && Math.abs(v.spd) > 120) v.spd *= 0.5;
    // 車の横（空いている側）に降りる
    const c = Math.cos(v.a);
    const n = Math.sin(v.a);
    for (const [f, s] of [[0, -40], [0, 40], [-50, 0], [50, 0], [0, -64], [0, 64]]) {
      const x = v.x + c * f - n * s;
      const y = v.y + n * f + c * s;
      if (!this.world.solid(Math.floor(x / TILE), Math.floor(y / TILE))) {
        p.x = x;
        p.y = y;
        break;
      }
    }
  }

  private updateVehicles(dt: number): void {
    for (const v of this.vehicles) {
      // 席の確認：降りた・ダウンした・通信が切れた人は席から外す
      for (let i = 0; i < 3; i++) {
        const id = v.seats[i];
        if (id < 0) continue;
        const p = this.players.find((q) => q.id === id);
        if (!p || p.veh !== v.id || p.status !== 'alive' || p.away) {
          v.seats[i] = -1;
          if (p && p.veh === v.id && (p.status !== 'alive' || p.away)) {
            p.veh = undefined;
            p.seat = undefined;
          }
        }
      }
      const driver = v.seats[0] >= 0 ? this.players.find((q) => q.id === v.seats[0]) : undefined;
      const pushing = !!driver && !!v.inp && Math.hypot(v.inp.mx, v.inp.my) > 0.15;
      const spdBefore = v.spd;
      const hit = stepVehicle(v, driver ? v.inp : null, dt, this.world);
      // 体当たり：道の残骸・木・ドラム缶・木箱は、ぶつかると壊れる（速いほど一撃。押し続けても少しずつ）
      if (pushing)
        for (const c of lastCollided) {
          const o = this.world.objAt(c.tx, c.ty);
          if (!o || !RAMMABLE.has(o.kind) || !objIsSolid(o)) continue;
          o.hp -= hit > 0 ? hit * 0.6 : 45 * dt;
          if (Math.random() < 0.2 || hit > 0) this.changed.add(o.id);
          if (hit > 0) this.events.push({ k: 'smash', x: (o.tx + 0.5) * TILE, y: (o.ty + 0.5) * TILE, kind: o.kind });
          if (o.hp <= 0) {
            // 木は倒れ、残骸は脇へ押しのけられる（通れるようになる）。勢いがあればそのまま突き抜ける
            this.destroyObj(o);
            v.spd = hit > 0 ? spdBefore * 0.7 : v.spd * 0.75;
          }
        }
      if (hit > 180) {
        v.hp -= (hit - 180) * 0.12;
        this.events.push({ k: 'crash', x: v.x + Math.cos(v.a) * 26, y: v.y + Math.sin(v.a) * 26, hard: Math.min(1, hit / VEHICLE.maxSpeed) });
        if (hit > 400)
          for (const id of v.seats) {
            if (id < 0) continue;
            const q = this.players.find((r) => r.id === id)!;
            this.damagePlayer(q, 6);
            this.injure(q, 0.25, 0.15);
          }
      }
      const speed = Math.abs(v.spd);
      // ゾンビを轢く：速ければ大ダメージ。車も傷んで少し遅くなる
      for (const z of this.zombies) {
        if (z.dead) continue;
        const dx = z.x - v.x;
        const dy = z.y - v.y;
        if (Math.abs(dx) > 60 || Math.abs(dy) > 60) continue;
        const r = VEHICLE.radius + ZOMBIE[z.type].radius;
        const d = Math.hypot(dx, dy);
        if (d >= r) continue;
        if (speed > 110) {
          const heavy = z.type === 'brute' ? 22 : z.type === 'soldier' || z.type === 'bloater' ? 8 : 3;
          this.damageZombie(z, speed * 0.42, v.seats[0] >= 0 ? v.seats[0] : -1, Math.cos(v.a), Math.sin(v.a), 260, true);
          v.hp -= heavy;
          v.spd *= z.type === 'brute' ? 0.55 : 0.88;
          this.events.push({ k: 'crash', x: z.x, y: z.y, hard: 0.3 });
        } else if (d > 0.01) {
          z.x = v.x + (dx / d) * r;
          z.y = v.y + (dy / d) * r;
        }
      }
      // 歩いている人は押しのける
      for (const p of this.players) {
        if (p.veh || p.status === 'dead') continue;
        const dx = p.x - v.x;
        const dy = p.y - v.y;
        const d = Math.hypot(dx, dy);
        const r = VEHICLE.radius + PLAYER.radius;
        if (d < r && d > 0.01) {
          p.x = v.x + (dx / d) * r;
          p.y = v.y + (dy / d) * r;
        }
      }
      // エンジン音：走っている間はゾンビが寄ってくる
      if (speed > 20) {
        v.noiseT -= dt;
        if (v.noiseT <= 0) {
          v.noiseT = 0.6;
          this.makeNoise(v.x, v.y, 280 + speed * 0.7, false);
        }
      }
      if (v.hp <= 0 && !v.broken) {
        v.hp = 0;
        v.broken = true;
        v.spd = 0;
        this.events.push({ k: 'break', x: v.x, y: v.y, kind: 'car' });
        this.events.push({ k: 'feed', cat: 'danger', t: `車が壊れた！ 直すには 鉄くず${VEHICLE.repairCost.scrap}・武器パーツ${VEHICLE.repairCost.parts}`, c: '#e0583e' });
        for (const id of [...v.seats]) if (id >= 0) this.exitVehicle(this.players.find((q) => q.id === id)!, true);
      }
      // 乗っている人を座席の位置へ
      v.seats.forEach((id, i) => {
        if (id < 0) return;
        const p = this.players.find((q) => q.id === id);
        if (!p) return;
        const sp = seatPos(v, i);
        p.x = sp.x;
        p.y = sp.y;
      });
    }
  }

  // ======================== 異変（特定の場所のイベント） ========================
  sites: (SiteSnap & { guards: boolean })[] = [];
  private siteSeq = 1;
  private siteT = 0;

  /** その日の異変を 1〜2 か所に起こす（危険な場所・依頼と重ならない所） */
  private newSites(announce: boolean): void {
    const used = new Set(this.jobs.map((j) => j.loc));
    const cands = this.world.locations.map((l, i) => ({ l, i })).filter(({ l, i }) => l.tier >= 2 && l.kind !== 'base' && l.kind !== 'ruin' && !used.has(i));
    const n = 1 + (Math.random() < 0.5 ? 1 : 0);
    const out: (SiteSnap & { guards: boolean })[] = [];
    for (let k = 0; k < n && cands.length; k++) {
      const { l, i } = cands.splice(Math.floor(Math.random() * cands.length), 1)[0];
      const kind: SiteSnap['kind'] = l.kind === 'military' || l.kind === 'police' ? 'armory' : Math.random() < 0.5 ? 'heli' : 'nest';
      const spot = this.crateSpot(i);
      if (!spot) continue;
      const o: SimObj = { id: this.nextObjId++, kind: kind === 'heli' ? 'drop' : kind === 'armory' ? 'wcase' : 'mcrate', tx: spot[0], ty: spot[1], hp: 1, maxHp: 1, ready: 1, regrowT: 0 };
      this.world.setObj(o);
      this.changed.add(o.id);
      // 中身：遠い・危険なほど良い。伝説級が出ることも
      const c = emptyBag(8);
      const pool: WeaponId[] = kind === 'armory' ? ['dmr', 'rifle', 'hunting'] : ['smg', 'rifle', 'shotgun', 'hunting', 'dmr'];
      const wid = pool[Math.floor(Math.random() * pool.length)];
      addItem(c, wid, 1, { mag: 0, ...rollQuality(Math.random() < 0.25 ? 4 : 3) });
      addItem(c, ammoOf(wid), 20 + Math.floor(Math.random() * 20));
      addItem(c, ATTACHMENTS[Math.floor(Math.random() * ATTACHMENTS.length)], 1);
      addItem(c, kind === 'nest' ? 'antitox' : kind === 'heli' ? 'pack3' : 'upkit', 1);
      if (Math.random() < 0.5) addItem(c, 'stim', 1);
      this.contents.set(o.id, c);
      const name = kind === 'heli' ? `${l.name}に墜落したヘリ` : kind === 'nest' ? `${l.name}の感染体の巣` : `${l.name}の封鎖された武器庫`;
      out.push({ id: this.siteSeq++, kind, name, tx: spot[0], ty: spot[1], crate: o.id, guards: false });
    }
    this.sites = out;
    if (announce && out.length)
      this.events.push({ k: 'feed', cat: 'danger', t: `無線：異変 — ${out.map((x) => x.name).join('／')}。見張りは手強いが、良い物がある（地図に◆）`, c: '#c08af0', snd: 'alarm' });
  }

  private updateSites(dt: number): void {
    this.siteT -= dt;
    if (this.siteT > 0) return;
    this.siteT = 0.5;
    for (const st of [...this.sites, ...this.rsites]) {
      if (st.done) continue;
      const crate = this.world.objects.get(st.crate);
      if (!crate || !crate.ready) {
        st.done = true;
        if (st.kind === 'tower') this.events.push({ k: 'feed', cat: 'up', t: `${st.name}を制圧 — 救助無線の部品を拠点の無線へ持ち帰れ`, c: '#f0d070', snd: 'clear' });
        else this.events.push({ k: 'feed', cat: 'up', t: `異変を制圧：${st.name}`, c: '#c08af0', snd: 'clear' });
        for (const p of this.players) if (p.status === 'alive') this.gainXp(p, 1, 30);
        continue;
      }
      // 誰かが近づいたら見張りを出す（精鋭を含む）
      if (!st.guards && this.players.some((p) => p.status === 'alive' && Math.hypot(p.x / TILE - st.tx, p.y / TILE - st.ty) < 40)) {
        st.guards = true;
        const tier = this.tierAt(st.tx, st.ty);
        const types: ZombieType[] = st.kind === 'tower' ? (['soldier', 'runner', 'brute', 'walker', 'runner', 'soldier', 'brute', 'runner'] as ZombieType[]).slice(0, 4 + tier) : st.kind === 'nest' ? ['walker', 'runner', 'walker', 'runner', 'bloater', 'walker', 'runner', 'brute'] : st.kind === 'armory' ? ['soldier', 'soldier', 'brute', 'soldier'] : ['soldier', 'runner', 'brute', 'soldier', 'runner'];
        types.forEach((t, k) => {
          const a = (k / types.length) * Math.PI * 2;
          for (let r = 2; r < 7; r++) {
            const x = st.tx + 0.5 + Math.cos(a) * r;
            const y = st.ty + 0.5 + Math.sin(a) * r;
            if (this.world.solid(Math.floor(x), Math.floor(y))) continue;
            const z = this.spawnZombie(t, x * TILE, y * TILE, k < (st.kind === 'tower' ? Math.max(1, tier - 2) : st.kind === 'nest' ? 1 : 2));
            z.keep = true;
            z.homeX = (st.tx + 0.5) * TILE;
            z.homeY = (st.ty + 0.5) * TILE;
            break;
          }
        });
      }
    }
  }

  // ======================== 救助（モード・エンディング） ========================
  /** 遊び方：30 日目の朝に救助が来る／期限なし */
  runMode: RunMode = 'endless';
  /** 救助の進み具合：stage 0 部品集め・1 修理待ち・2 呼べる・3 呼んだ。day = 救助が来る日（0 = 未定） */
  rescue = { stage: 0, parts: 0, day: 0 };
  /** 救助無線の部品がある場所（通信塔など）。毎朝入れ替わる異変とは別で、ずっと残る */
  rsites: (SiteSnap & { guards: boolean })[] = [];
  /** 救助ヘリが着くまでの演出の残り秒 */
  private winT = 0;
  /** 救助を呼ぶ前の確認（もう一度 [F]） */
  private callConfirm = new Map<number, number>();

  /** 新しいゲームの遊び方を決める（ソロ・ホスト・ローカル協力の開始時） */
  setRunMode(m: RunMode): void {
    this.runMode = m;
    if (m === 'd30' && !this.rescue.day) this.rescue.day = RESCUE_DAY;
    this.events.push({
      k: 'feed',
      cat: 'info',
      t: m === 'd30' ? `30日モード：DAY ${RESCUE_DAY} の朝に救助が来る。前の晩が最後の防衛。無線を直せば早く呼べる` : '期限なしモード：救助は来ない。無線の部品を3つ集めて直せば、自分で救助を呼べる',
      c: '#f0d070',
    });
  }

  private rescueSnap(): RescueSnap {
    return { mode: this.runMode, stage: this.rescue.stage, parts: this.rescue.parts, threat: this.threat(), ...(this.rescue.day ? { day: this.rescue.day } : {}) };
  }

  /** 部品の置き場所：近い・中くらい・遠いの 3 か所（危険度 2・3・4 の施設） */
  private newRescueSites(only?: number): void {
    const used = new Set<number>();
    const locOf = (st: SiteSnap) => this.world.locations.findIndex((l) => st.tx >= l.x && st.ty >= l.y && st.tx < l.x + l.w && st.ty < l.y + l.h);
    for (const st of [...this.sites, ...this.rsites]) used.add(locOf(st));
    for (const j of this.jobs) used.add(j.loc);
    const names = ['通信塔', '無線基地', '発電所跡'];
    for (let k = 0; k < 3; k++) {
      if (only !== undefined && k !== only) continue;
      const want = 2 + k;
      const cands = this.world.locations
        .map((l, i) => ({ l, i }))
        .filter(({ l, i }) => l.kind !== 'base' && l.kind !== 'ruin' && !used.has(i))
        .sort((a, b) => Math.abs(a.l.tier - want) - Math.abs(b.l.tier - want) + (Math.random() - 0.5) * 0.9);
      for (const { l, i } of cands) {
        const spot = this.crateSpot(i);
        if (!spot) continue;
        used.add(i);
        const o: SimObj = { id: this.nextObjId++, kind: 'mcrate', tx: spot[0], ty: spot[1], hp: 1, maxHp: 1, ready: 1, regrowT: 0 };
        this.world.setObj(o);
        this.changed.add(o.id);
        const c = emptyBag(8);
        addItem(c, (['rpart1', 'rpart2', 'rpart3'] as ItemId[])[k], 1);
        addItem(c, 'ammo762', 10 + k * 10);
        if (k >= 1) addItem(c, 'medkit', 1);
        if (k >= 2) addItem(c, 'upkit', 1);
        this.contents.set(o.id, c);
        const st = { id: this.siteSeq++, kind: 'tower' as const, name: `${l.name}の${names[k]}`, tx: spot[0], ty: spot[1], crate: o.id, guards: false };
        this.rsites = [...this.rsites, st];
        break;
      }
    }
  }

  /** その部品がどこかに残っているか（持ち物・倉庫・箱・落とした袋・トランク） */
  private partExists(id: ItemId): boolean {
    for (const p of this.players) if (countItem(p.bag, id) > 0) return true;
    if (countItem(this.storage.shared, id) > 0) return true;
    for (const b of Object.values(this.storage.personal)) if (countItem(b, id) > 0) return true;
    for (const c of this.contents.values()) if (countItem(c, id) > 0) return true;
    return false;
  }

  /** 毎朝：失くした部品があれば、新しい場所に置き直す（進行不能にしない） */
  private checkRescueParts(): void {
    if (this.rescue.stage > 0) return;
    (['rpart1', 'rpart2', 'rpart3'] as ItemId[]).forEach((id, k) => {
      if (this.rescue.parts & (1 << k)) return;
      if (this.partExists(id)) return;
      // 古い置き場所（箱の中身が入れ替わった・制圧済み）は地図から消す
      this.rsites = this.rsites.filter((x) => !x.name.endsWith(['通信塔', '無線基地', '発電所跡'][k]));
      this.newRescueSites(k);
      this.events.push({ k: 'feed', cat: 'info', t: `無線：失くした「${ITEMS[id].name}」の代わりが見つかった（地図に◆）`, c: '#f0d070' });
    });
  }

  /** 拠点の無線：部品の取り付け → 修理 → 救助を呼ぶ */
  private rescueRadio(p: SimPlayer): boolean {
    const r = this.rescue;
    if (r.stage === 0) {
      const got: string[] = [];
      (['rpart1', 'rpart2', 'rpart3'] as ItemId[]).forEach((id, k) => {
        if (r.parts & (1 << k)) return;
        if (countItem(p.bag, id) + countItem(this.storage.shared, id) < 1) return;
        this.payCost(p, { [id]: 1 });
        r.parts |= 1 << k;
        got.push(ITEMS[id].name);
      });
      if (!got.length) return false;
      const n = [1, 2, 4].filter((b) => r.parts & b).length;
      if (n >= 3) r.stage = 1;
      this.events.push({ k: 'feed', cat: 'up', t: `${p.name} が救助無線に ${got.join('・')} を取り付けた（${n}/3）${n >= 3 ? ' — 部品がそろった！ 修理には 工具セット1・電子部品2' : ''}`, c: '#f0d070', snd: 'clear' });
      return true;
    }
    if (r.stage === 1) {
      const need: Partial<Record<ItemId, number>> = { tools: 1, electronics: 2 };
      const short = (Object.entries(need) as [ItemId, number][]).find(([m, n]) => countItem(p.bag, m) + countItem(this.storage.shared, m) < n);
      if (short) {
        this.pop(p, `救助無線の修理に必要：工具セット1・電子部品2（足りない：${ITEMS[short[0]].name}）`, '#f0d070', 'error');
        return true;
      }
      this.payCost(p, need);
      r.stage = 2;
      this.events.push({ k: 'feed', cat: 'up', t: `${p.name} が救助無線を直した！ もう一度 無線で [F] — 救助を呼べる`, c: '#f0d070', snd: 'clear' });
      return true;
    }
    if (r.stage === 2) {
      // 呼ぶと次の朝に救助（夜に呼んだら翌々日の朝）。その前の晩が最後の防衛
      const rd = this.phase === 'night' ? this.day + 2 : this.day + 1;
      const last = this.callConfirm.get(p.id) ?? -99;
      if (this.time - last > 4) {
        this.callConfirm.set(p.id, this.time);
        this.pop(p, `もう一度 [F] で救助を呼ぶ — DAY ${rd} の朝に救助。前の晩は最後の防衛（大群）`, '#f0d070');
        return true;
      }
      r.stage = 3;
      r.day = r.day ? Math.min(r.day, rd) : rd;
      this.announceThreat();
      this.events.push({ k: 'banner', t: '救助を呼んだ', s: `救助ヘリは DAY ${r.day} の朝に来る。それまで生き延びろ — 前の晩は最後の防衛`, c: '#f0d070', snd: 'alarm' });
      return true;
    }
    this.pop(p, `救助は DAY ${r.day} の朝に来る`, '#f0d070');
    return true;
  }

  // ======================== 無線の依頼 ========================

  /** その日の依頼を作り直す（物資箱を施設に置く） */
  private newJobs(announce: boolean): void {
    const lv = radioLevel(this.radioDone);
    const jobs = makeJobs(this.world.locations, this.day, lv, Math.random, this.jobSeq);
    this.jobSeq += jobs.length;
    for (const j of jobs) {
      if (j.kind === 'scout') continue;
      const spot = this.crateSpot(j.loc);
      if (!spot) {
        j.kind = 'scout';
        j.title = j.title.replace(/から回収|の救援物資/, 'の偵察');
        j.desc = `${this.world.locations[j.loc].name}の様子を見てきてほしい（施設に入れば達成）`;
        delete j.item;
        delete j.need;
        continue;
      }
      const o: SimObj = { id: this.nextObjId++, kind: 'mcrate', tx: spot[0], ty: spot[1], hp: 1, maxHp: 1, ready: 1, regrowT: 0 };
      this.world.setObj(o);
      this.changed.add(o.id);
      const c = emptyBag(8);
      if (j.kind === 'fetch' && j.item && j.need) addItem(c, j.item, j.need);
      else for (const r of jobReward(j.tier, rewardMul(lv) * 1.3)) addItem(c, r.id, r.n);
      if (Math.random() < 0.5) addItem(c, 'can', 1);
      this.contents.set(o.id, c);
      j.crate = o.id;
    }
    this.jobs = jobs;
    if (announce) this.events.push({ k: 'feed', cat: 'info', t: `無線：今日の依頼が ${jobs.length} 件届いた — 画面右の一覧と、コンパス・地図 [B] の印を見よう`, c: '#8ac0e0', snd: 'alarm' });
  }

  /** 施設の中の、物資箱を置ける床 */
  private crateSpot(locIdx: number): [number, number] | null {
    const l = this.world.locations[locIdx];
    if (!l) return null;
    const cand: [number, number][] = [];
    for (let y = l.y + 1; y < l.y + l.h - 1; y++)
      for (let x = l.x + 1; x < l.x + l.w - 1; x++) {
        if (this.world.solid(x, y) || this.world.objAt(x, y)) continue;
        // 通路を塞がないよう、壁ぎわ（隣に固いマスがある所）を優先
        const wall = this.world.solid(x + 1, y) || this.world.solid(x - 1, y) || this.world.solid(x, y + 1) || this.world.solid(x, y - 1);
        if (wall) cand.push([x, y]);
      }
    return cand.length ? cand[Math.floor(Math.random() * cand.length)] : null;
  }

  private updateJobs(dt: number): void {
    this.jobCheckT -= dt;
    if (this.jobCheckT > 0) return;
    this.jobCheckT = 0.5;
    for (const j of this.jobs) {
      if (j.done) continue;
      if (j.kind === 'scout') {
        const l = this.world.locations[j.loc];
        const p = this.players.find((q) => q.status === 'alive' && !q.away && q.x / TILE >= l.x && q.y / TILE >= l.y && q.x / TILE < l.x + l.w && q.y / TILE < l.y + l.h);
        if (p) this.completeJob(j, p);
      } else if (j.kind === 'fetch' && j.item) {
        let have = countItem(this.storage.shared, j.item);
        for (const p of this.players) if (p.status !== 'dead') have += countItem(p.bag, j.item);
        j.have = Math.min(j.need ?? 1, have);
      }
    }
  }

  /** 無線で報告：回収の依頼の品を（バックパック → 共有倉庫の順に）渡す */
  private useRadio(p: SimPlayer): void {
    let reported = 0;
    for (const j of this.jobs) {
      if (j.done || j.kind !== 'fetch' || !j.item || !j.need) continue;
      if (countItem(p.bag, j.item) + countItem(this.storage.shared, j.item) < j.need) continue;
      this.payCost(p, { [j.item]: j.need });
      this.completeJob(j, p);
      reported++;
    }
    if (reported) return;
    if (this.rescueRadio(p)) return;
    const open = this.jobs.filter((j) => !j.done);
    if (!open.length) return this.pop(p, '無線：今日の依頼はすべて達成した。明日の朝に新しい依頼が届く', '#8ac0e0');
    const f = open.find((j) => j.kind === 'fetch');
    this.pop(p, f && f.item ? `無線：「${ITEMS[f.item].name} ×${f.need} を待っている」` : '無線：報告する品はまだない', '#8ac0e0', 'error');
  }

  private completeJob(j: Job, by: SimPlayer): void {
    j.done = true;
    this.tutMark(by, TUT_JOB);
    const lvBefore = radioLevel(this.radioDone);
    this.radioDone++;
    const lv = radioLevel(this.radioDone);
    // 報酬：救援物資は箱の中身。それ以外は共有倉庫（入りきらなければ収納箱）へ
    let where = '物資箱の中身が報酬';
    if (j.kind !== 'cache') {
      const box = [...this.world.objects.values()].find((o) => o.kind === 'box');
      for (const r of jobReward(j.tier, rewardMul(lvBefore))) {
        let left = addItem(this.storage.shared, r.id, r.n);
        if (left > 0 && box) {
          if (!this.contents.has(box.id)) this.contents.set(box.id, emptyBag(12));
          left = addItem(this.contents.get(box.id)!, r.id, left);
          box.ready = 1;
          this.changed.add(box.id);
        }
      }
      this.storage.ver++;
      where = '報酬は拠点の共有倉庫へ';
    }
    // 協力：生きている全員に経験値
    for (const p of this.players) if (p.status === 'alive') this.gainXp(p, 0, 8 + j.tier * 8);
    this.events.push({ k: 'job', t: `依頼達成：${j.title}（${by.name}） — ${where}`, lvUp: lv > lvBefore ? lv : undefined });
    this.events.push({ k: 'feed', cat: 'up', t: `★${j.tier} 依頼達成：${j.title} — ${where}`, c: '#e0cfa8', snd: 'clear' });
    if (lv > lvBefore) this.events.push({ k: 'feed', cat: 'up', t: `無線の信頼度が Lv${lv} に上がった！ 依頼の報酬 +${Math.round((rewardMul(lv) - 1) * 100)}%${lv === 3 ? '・遠い依頼がもう1件届くように' : ''}`, c: '#e0b25a', snd: 'level' });
  }

  // ======================== 拠点づくり ========================

  /** 素材をバックパック → 共有倉庫の順に払う */
  private payCost(p: SimPlayer, cost: Partial<Record<ItemId, number>>): void {
    for (const [m, need] of Object.entries(cost) as [ItemId, number][]) {
      const got = removeItem(p.bag, m, need);
      if (got < need) removeItem(this.storage.shared, m, need - got);
    }
    this.storage.ver++;
  }

  private build(p: SimPlayer, kind: string, tx: number, ty: number): void {
    if (p.status !== 'alive') return;
    const def = buildDef(kind);
    if (!def) return;
    if ((def.lv ?? 1) > this.base.bench) return this.pop(p, `作業台 Lv${def.lv} が必要`, '#c87a6a', 'error');
    const occ = [...this.players.filter((q) => q.status !== 'dead' && !q.away), ...this.zombies.filter((z) => !z.dead)];
    const err = buildSpotError(this.world, def.kind, tx, ty, p.x, p.y, occ);
    if (err) return this.pop(p, err, '#c87a6a', 'error');
    const short = canAfford(def, p.bag, this.storage.shared);
    if (short) return this.pop(p, `素材が足りない（${ITEMS[short].name}）`, '#c87a6a', 'error');
    this.payCost(p, def.cost);
    const o: SimObj = { id: this.nextObjId++, kind: def.kind, tx, ty, hp: def.hp, maxHp: def.hp, ready: 0, regrowT: 0 };
    this.world.setObj(o);
    this.changed.add(o.id);
    this.flowTimer = Math.min(this.flowTimer, 0.1);
    this.events.push({ k: 'built', x: (tx + 0.5) * TILE, y: (ty + 0.5) * TILE, kind: def.kind, id: p.id });
    this.tutMark(p, TUT_BUILD);
    this.gainXp(p, 2, 2);
    this.makeNoise((tx + 0.5) * TILE, (ty + 0.5) * TILE, 120, false);
  }

  /** 建てた物を撤去：素材の半分が戻る */
  private unbuild(p: SimPlayer, id: number): void {
    const o = this.world.objects.get(id);
    if (!o || !BUILD_KINDS.has(o.kind) || p.status !== 'alive') return;
    if (Math.hypot((o.tx + 0.5) * TILE - p.x, (o.ty + 0.5) * TILE - p.y) > BUILD_RANGE_PX) return this.pop(p, '遠すぎる', '#c87a6a', 'error');
    const def = buildDef(o.kind)!;
    if (o.kind === 'sbox' && (this.contents.get(o.id) ?? []).some((x) => x)) return this.pop(p, '中身を空にしてから撤去しよう', '#c87a6a', 'error');
    for (const [m, n] of Object.entries(def.cost) as [ItemId, number][]) {
      const back = Math.floor((n * o.hp) / o.maxHp / 2);
      if (back > 0) {
        const left = addItem(p.bag, m, back);
        if (left > 0) {
          const bag = this.groundBag(p.x, p.y);
          if (bag) addItem(this.contents.get(bag.id)!, m, left);
        }
      }
    }
    if (o.kind === 'raintank' && o.ready > 0) addItem(p.bag, 'water', o.ready);
    this.world.removeObj(o.id);
    this.changed.delete(o.id);
    this.removed.push(o.id);
    this.flowTimer = Math.min(this.flowTimer, 0.1);
    this.pop(p, `${def.name}を撤去（素材が半分戻った）`, '#d8c48a', 'craft');
  }

  /** [F]：雨水タンクの水を回収／傷んだ物を修理 */
  private useBuilt(p: SimPlayer, o: SimObj): void {
    const def = buildDef(o.kind)!;
    if (o.kind === 'raintank' && o.ready > 0) {
      const left = addItem(p.bag, 'water', o.ready);
      const got = o.ready - left;
      if (got <= 0) return this.pop(p, 'バックパックがいっぱい', '#c87a6a', 'error');
      o.ready = left;
      this.changed.add(o.id);
      this.pop(p, `きれいな水 ×${got} を回収`, '#8ac0e0', 'loot');
      return;
    }
    if (o.hp >= o.maxHp) return;
    if (countItem(p.bag, 'scrap') + countItem(this.storage.shared, 'scrap') < 1) return this.pop(p, '修理には鉄くずが1つ必要', '#c87a6a', 'error');
    this.payCost(p, { scrap: 1 });
    o.hp = Math.min(o.maxHp, o.hp + o.maxHp * 0.4);
    this.changed.add(o.id);
    this.events.push({ k: 'built', x: (o.tx + 0.5) * TILE, y: (o.ty + 0.5) * TILE, kind: o.kind, id: p.id, repair: true });
    this.pop(p, `${def.name}を修理（${Math.round((o.hp / o.maxHp) * 100)}%）`, '#d8c48a', 'craft');
  }

  /** 雨水タンクに水が貯まる */
  private updateBuilds(dt: number): void {
    const rate = this.weather === 'storm' ? 1 / 25 : this.weather === 'rain' ? 1 / 45 : 0;
    if (!rate) return;
    for (const o of this.world.objects.values()) {
      if (o.kind !== 'raintank' || o.ready >= RAINTANK_MAX) continue;
      o.regrowT += rate * dt;
      if (o.regrowT >= 1) {
        o.regrowT -= 1;
        o.ready++;
        this.changed.add(o.id);
      }
    }
  }

  private craft(p: SimPlayer, id: string): void {
    const r = RECIPES.find((x) => x.id === id);
    if (!r) return;
    if (r.station === 'stove' && !this.nearKind(p, STOVE_KINDS, BENCH_RANGE)) {
      this.pop(p, '調理かまどの近くで作る（拠点に建てられる）', '#c87a6a');
      return;
    }
    if (r.bench && !this.nearKind(p, BENCH_KINDS, BENCH_RANGE)) {
      this.pop(p, '作業台の近くでないと作れない', '#c87a6a');
      return;
    }
    if ((r.lv ?? 1) > this.base.bench) {
      this.pop(p, `作業台 Lv${r.lv} が必要`, '#c87a6a');
      return;
    }
    const cost = Object.entries(r.cost) as [ItemId, number][];
    for (const [m, need] of cost) {
      if (countItem(p.bag, m) < need) {
        this.pop(p, '素材が足りない', '#c87a6a');
        return;
      }
    }
    for (const [m, need] of cost) removeItem(p.bag, m, need);
    const left = addItem(p.bag, r.out.id, r.out.n);
    if (left > 0) {
      // 入りきらない分は足元へ
      const bag = this.groundBag(p.x, p.y);
      if (bag) addItem(this.contents.get(bag.id)!, r.out.id, left);
    }
    this.pop(p, `${r.name} を作成`, '#c9a85a', 'craft');
    this.tutMark(p, TUT_CRAFT);
    this.gainXp(p, 2, 1);
  }

  private ping(p: SimPlayer, tx: number, ty: number): void {
    if ((this.pingCd.get(p.id) ?? -9) > this.time - 0.8) return;
    this.pingCd.set(p.id, this.time);
    const x = (tx + 0.5) * TILE;
    const y = (ty + 0.5) * TILE;
    let t: 'enemy' | 'loot' | 'go' = 'go';
    if (this.zombies.some((z) => Math.hypot(z.x - x, z.y - y) < 90)) t = 'enemy';
    else {
      for (let dy = -1; dy <= 1; dy++)
        for (let dx = -1; dx <= 1; dx++) {
          const o = this.world.objAt(tx + dx, ty + dy);
          if (o && CONTAINER_KINDS.has(o.kind)) t = 'loot';
        }
    }
    this.events.push({ k: 'ping', id: p.id, x, y, t });
  }

  private nearKind(p: { x: number; y: number }, kinds: ReadonlySet<ObjKind>, range: number): SimObj | null {
    const ptx = Math.floor(p.x / TILE);
    const pty = Math.floor(p.y / TILE);
    const r = Math.ceil(range / TILE) + 1;
    for (let ty = pty - r; ty <= pty + r; ty++)
      for (let tx = ptx - r; tx <= ptx + r; tx++) {
        const o = this.world.objAt(tx, ty);
        if (o && kinds.has(o.kind) && Math.hypot((o.tx + 0.5) * TILE - p.x, (o.ty + 0.5) * TILE - p.y) <= range) return o;
      }
    return null;
  }

  // ======================== ドア・探索 ========================

  private toggleDoor(p: SimPlayer, d: SimObj): void {
    if (d.ready === 1) {
      const blocked =
        this.players.some((pl) => pl.status !== 'dead' && circleOverlapsTile(pl.x, pl.y, PLAYER.radius - 2, d.tx, d.ty)) ||
        this.zombies.some((z) => circleOverlapsTile(z.x, z.y, ZOMBIE[z.type].radius - 2, d.tx, d.ty));
      if (blocked) {
        this.pop(p, 'ふさがっていて閉められない', '#aaaaaa');
        return;
      }
    }
    d.ready = d.ready ? 0 : 1;
    this.changed.add(d.id);
    const x = (d.tx + 0.5) * TILE;
    const y = (d.ty + 0.5) * TILE;
    this.events.push({ k: 'door', x, y, open: d.ready === 1 });
    this.makeNoise(x, y, 230, false);
    this.flowTimer = Math.min(this.flowTimer, 0.1);
  }

  /** F キー：いちばん近いドア／入れ物／倉庫を操作。何もなければ回復/食事 */
  private interact(p: SimPlayer): void {
    if (p.viewing || p.storage) {
      p.viewing = 0;
      p.storage = 0;
      return;
    }
    if (p.veh) {
      this.exitVehicle(p);
      return;
    }
    const nv = this.nearVehicle(p);
    if (nv) {
      this.useVehicle(p, nv);
      return;
    }
    if (p.search) {
      p.search = null;
      return;
    }
    let best: SimObj | null = null;
    let bd = 64;
    const ptx = Math.floor(p.x / TILE);
    const pty = Math.floor(p.y / TILE);
    for (let ty = pty - 2; ty <= pty + 2; ty++)
      for (let tx = ptx - 2; tx <= ptx + 2; tx++) {
        const o = this.world.objAt(tx, ty);
        if (!o) continue;
        const usable =
          o.kind === 'door' ||
          STORAGE_KINDS.has(o.kind) ||
          (CONTAINER_KINDS.has(o.kind) && (o.kind !== 'car' || o.hp > 0)) ||
          o.kind === 'bed' ||
          o.kind === 'cot' ||
          o.kind === 'sbox' ||
          o.kind === 'radio' ||
          (BUILD_KINDS.has(o.kind) && (o.hp < o.maxHp || (o.kind === 'raintank' && o.ready > 0)));
        if (!usable) continue;
        const d = Math.hypot((o.tx + 0.5) * TILE - p.x, (o.ty + 0.5) * TILE - p.y) - (o.kind === 'door' ? 0 : 6);
        if (d < bd) {
          bd = d;
          best = o;
        }
      }
    if (best && (best.kind === 'bed' || best.kind === 'cot')) {
      this.trySleep(p, best);
      return;
    }
    if (best && best.kind === 'sbox') {
      // 保管箱：探索なしですぐ開く。中身はずっと残る
      if (!this.contents.has(best.id)) this.contents.set(best.id, emptyBag(16));
      p.viewing = best.id;
      return;
    }
    if (best && best.kind === 'radio') {
      this.useRadio(p);
      return;
    }
    if (best && BUILD_KINDS.has(best.kind)) {
      this.useBuilt(p, best);
      return;
    }
    if (!best) {
      if (p.hp < p.maxHp - 25 && this.useMeds(p, false)) return;
      if (p.hunger < 70) this.useFood(p, false);
      return;
    }
    if (best.kind === 'door') return this.toggleDoor(p, best);
    if (STORAGE_KINDS.has(best.kind)) {
      p.storage = 1;
      return;
    }
    // 探索開始：未探索なら時間がかかる（危険な場所・武器ケースほど長い）
    const tier = this.tierAt(best.tx, best.ty);
    const fresh = best.ready === 1 && best.kind !== 'bag';
    const base = fresh ? 1.5 + tier * 0.15 + (best.kind === 'wcase' || best.kind === 'mcrate' || best.kind === 'drop' ? 0.5 : 0) : 0.3;
    const dur = base * skillMods(p.xp).searchMul;
    p.search = { cid: best.id, t: 0, dur, x: p.x, y: p.y };
    if (fresh) this.events.push({ k: 'search', id: p.id, x: (best.tx + 0.5) * TILE, y: (best.ty + 0.5) * TILE, done: false });
  }

  private openContainer(p: SimPlayer, o: SimObj): void {
    if (!this.contents.has(o.id)) this.contents.set(o.id, this.rollLoot(o));
    const cj = this.jobs.find((j) => j.crate === o.id && j.kind === 'cache' && !j.done);
    if (cj) this.completeJob(cj, p);
    if (o.ready && o.kind !== 'bag') this.gainXp(p, 0, 4 + this.tierAt(o.tx, o.ty) * 3 + (o.kind === 'drop' ? 15 : 0));
    if (o.id === this.dropObj && o.ready) {
      this.dropObj = null;
      this.events.push({ k: 'feed', cat: 'loot', t: `${p.name} が補給物資を開けた`, c: '#e0b070' });
    }
    if (o.ready && o.kind !== 'bag') {
      o.ready = 0;
      // 探索済みの入れ物は 2〜3日ほどで中身が戻る（長い1日でも同じ所を回るだけにならない）
      o.regrowT = CYCLE_SECONDS * (2 + Math.random());
      this.changed.add(o.id);
      this.events.push({ k: 'search', id: p.id, x: (o.tx + 0.5) * TILE, y: (o.ty + 0.5) * TILE, done: true });
      this.tutMark(p, TUT_SEARCH);
    }
    p.viewing = o.id;
  }

  private tierAt(tx: number, ty: number): number {
    const loc = locationAt(this.world.locations, tx, ty);
    if (loc) return loc.kind === 'base' ? 0 : loc.tier;
    return tierAtDistance(Math.hypot(tx - BASE_TX, ty - BASE_TY));
  }

  /** 入れ物の中身を生成（遠く危険な場所ほど多く・レアに） */
  /** 品質を決める：遠く・危険な所ほど良い物が出やすい */
  private rollQ(tier: number, bonus = 0): number {
    const r = Math.random();
    const t = Math.min(4, tier + bonus);
    // 最も危険な地区（と補給物資）だけ、ごくまれに伝説
    if (t >= 4 && r < 0.008) return 4;
    if (r < 0.01 + t * 0.012) return 4 <= t + 1 ? 3 : 2;
    if (r < 0.05 + t * 0.04) return 2;
    if (r < 0.25 + t * 0.06) return 1;
    return 0;
  }

  /** レアドロップ：まれに、どの入れ物からも良い物が出る */
  private rareDrop(out: (Slot | null)[], tier: number): void {
    if (Math.random() > 0.02 + tier * 0.01) return;
    const r = Math.random();
    if (r < 0.45) {
      const pool: WeaponId[] = tier >= 3 ? ['rifle', 'hunting', 'dmr', 'shotgun'] : ['smg', 'shotgun', 'pistol', 'rifle'];
      const wid = pool[Math.floor(Math.random() * pool.length)];
      addItem(out, wid, 1, { mag: 0, ...rollQuality(2 + (Math.random() < 0.25 ? 1 : 0)) });
    } else if (r < 0.75) addItem(out, ATTACHMENTS[Math.floor(Math.random() * ATTACHMENTS.length)], 1);
    else addItem(out, tier >= 3 ? 'pack3' : 'pack2', 1);
  }

  private rollLoot(o: SimObj): (Slot | null)[] {
    // 拠点の収納箱は毎朝の補給・菜園の収穫・褒美がまとめて入るので広め
    const out = emptyBag(o.kind === 'box' ? 12 : o.kind === 'mcrate' || o.kind === 'wcase' || o.kind === 'drop' ? 8 : 6);
    let table = LOOT[o.kind];
    if (!table) return out;
    const tier = o.kind === 'box' ? 0 : o.kind === 'drop' ? 4 : this.tierAt(o.tx, o.ty);
    const R = Math.random;
    let rolls = 1 + Math.floor(R() * 2) + (tier >= 2 ? 1 : 0) + (tier >= 3 ? 1 : 0) + (o.kind === 'drop' ? 2 : 0);
    // まれに「当たり」の入れ物がある（同じ場所でも毎回中身が違う）
    if (R() < 0.06 + tier * 0.02) rolls += 2;
    const rare = (id: string) => id === 'weapon' || id === 'attach' || id === 'parts' || id === 'valuables';
    // 地区の特色：出やすい物資と、その地区だけの専用品
    const dist = o.kind === 'box' || o.kind === 'drop' ? null : districtAt(this.world.districts, o.tx, o.ty);
    const dl = dist ? DISTRICT_LOOT[dist.kind] : null;
    if (dl && dl.extra.length && o.kind !== 'car') table = [...table, ...dl.extra];
    const weights = table.map(([id, w]) => (rare(id) ? w * (0.6 + tier * 0.5) : w) * ((dl?.mul as Record<string, number> | undefined)?.[id] ?? 1));
    const total = weights.reduce((a, b) => a + b, 0);
    for (let r = 0; r < rolls; r++) {
      if (R() < 0.18 - tier * 0.04) continue; // 空振り
      let x = R() * total;
      let row = table[0];
      for (let i = 0; i < table.length; i++) {
        x -= weights[i];
        if (x <= 0) {
          row = table[i];
          break;
        }
      }
      const [id, , min, max] = row;
      if (id === 'weapon') {
        const pool: WeaponId[] = dist?.kind === 'forest' ? ['hunting', 'shotgun', 'hunting', 'pistol'] :
          tier >= 4 ? ['dmr', 'rifle', 'dmr', 'hunting'] : tier >= 3 ? ['rifle', 'shotgun', 'hunting', 'smg', 'dmr'] : tier === 2 ? ['smg', 'shotgun', 'pistol', 'hunting'] : ['pistol', 'smg', 'shotgun'];
        const wid = pool[Math.floor(R() * pool.length)];
        addItem(out, wid, 1, { mag: Math.floor(WEAPON_STATS[wid].magSize * R()), ...rollQuality(this.rollQ(tier, o.kind === 'drop' ? 1 : 0)) });
      } else if (id === 'attach') {
        // 危険な場所ほどレアなアタッチメント（スコープ・サプレッサー）が出やすい
        const pool: ItemId[] = tier >= 3 ? ['scope', 'suppressor', 'holo', 'extmag', 'grip', 'scope', 'suppressor'] : ['holo', 'extmag', 'grip', 'holo', 'suppressor', 'scope'];
        addItem(out, pool[Math.floor(R() * pool.length)], 1);
      } else {
        addItem(out, id, min + Math.floor(R() * (max - min + 1)));
      }
    }
    if (o.kind !== 'box' && o.kind !== 'bag') this.rareDrop(out, tier);
    return out;
  }

  /** 入れ物は長い時間がたつと（誰も近くにいなければ）中身が補充される。空の袋は消える */
  private updateContainers(dt: number): void {
    if (this.tick % 30 !== 0) return;
    const step = dt * 30;
    for (const o of [...this.world.objects.values()]) {
      if (o.kind === 'bag') {
        const c = this.contents.get(o.id);
        if ((!c || c.every((s) => !s)) && !this.players.some((p) => p.viewing === o.id || p.search?.cid === o.id)) {
          this.world.removeObj(o.id);
          this.contents.delete(o.id);
          this.changed.delete(o.id);
          this.removed.push(o.id);
        }
        continue;
      }
      if (!CONTAINER_KINDS.has(o.kind) || o.kind === 'box' || o.kind === 'drop' || o.ready || o.regrowT <= 0) continue;
      o.regrowT -= step;
      if (o.regrowT > 0) continue;
      const x = (o.tx + 0.5) * TILE;
      const y = (o.ty + 0.5) * TILE;
      if (this.players.some((p) => Math.hypot(p.x - x, p.y - y) < 600)) {
        o.regrowT = 30;
        continue;
      }
      o.ready = 1;
      this.contents.delete(o.id);
      this.changed.add(o.id);
    }
  }

  // ======================== 近接・ダウン・蘇生 ========================

  private swingAxe(p: SimPlayer): void {
    if (p.stamina < PLAYER.meleeStamina) {
      if (p.warnCd <= 0) {
        this.pop(p, 'スタミナ切れ！', '#c99a5a');
        p.warnCd = 1;
      }
      return;
    }
    p.stamina -= PLAYER.meleeStamina;
    p.staminaDelay = PLAYER.staminaDelay;
    p.swings++;
    this.makeNoise(p.x, p.y, AXE.noiseRadius, false);
    let hits = 0;
    for (const z of this.zombies) {
      if (z.dead || hits >= 3) continue;
      const r = ZOMBIE[z.type].radius;
      const dx = z.x - p.x;
      const dy = z.y - p.y;
      const d = Math.hypot(dx, dy);
      if (d > AXE.range + r) continue;
      if (Math.abs(angleDiff(p.aim, Math.atan2(dy, dx))) > AXE.arc / 2 && d > r + PLAYER.radius) continue;
      // 気づいていない相手への奇襲は大ダメージ
      const sneak = z.state !== 'chase' ? 2.2 : 1;
      this.events.push({ k: 'hit', x: z.x - (dx / (d || 1)) * r * 0.6, y: z.y - (dy / (d || 1)) * r * 0.6, o: p.id, a: Math.atan2(dy, dx), m: 1 });
      this.damageZombie(z, AXE.damage * sneak, p.id, dx, dy, 260);
      hits++;
    }
  }

  private updateRevive(dt: number): void {
    for (const d of this.players) {
      if (d.status !== 'down') continue;
      const reviver = this.players.find((p) => p !== d && p.status === 'alive' && p.revive && Math.hypot(p.x - d.x, p.y - d.y) <= PLAYER.reviveRange);
      if (reviver) {
        d.reviveProgress += dt * skillMods(reviver.xp).reviveMul;
        if (d.reviveProgress >= PLAYER.reviveTime) {
          d.status = 'alive';
          d.hp = d.maxHp * PLAYER.reviveHpRatio;
          d.hunger = Math.max(d.hunger, 30);
          d.reviveProgress = 0;
          d.downTimer = 0;
          this.events.push({ k: 'revive', id: d.id, x: d.x, y: d.y });
          this.events.push({ k: 'feed', cat: 'ally', t: `${reviver.name} が ${d.name} を救助した`, c: '#9fc48a' });
          this.gainXp(reviver, 3, 15);
        }
      } else {
        d.reviveProgress = Math.max(0, d.reviveProgress - dt * 1.5);
      }
    }
  }

  private damagePlayer(p: SimPlayer, dmg: number): void {
    if (p.status !== 'alive' || p.away) return;
    if (p.sleeping) this.wake(p, '襲われて飛び起きた！');
    if (p.veh) dmg *= 0.5; // 車の中は守られている
    p.hp -= dmg;
    p.search = null; // 攻撃されたら探索は中断
    this.events.push({ k: 'phit', id: p.id });
    this.events.push({ k: 'dmg', x: p.x, y: p.y - 20, v: Math.round(dmg), p: true });
    if (p.hp <= 0) this.downPlayer(p);
  }

  private downPlayer(p: SimPlayer): void {
    if (p.veh) this.exitVehicle(p, true);
    p.hp = 0;
    p.status = 'down';
    p.downTimer = PLAYER.downTime;
    p.reviveProgress = 0;
    p.fire = false;
    p.dashTime = 0;
    p.reloadT = 0;
    p.viewing = 0;
    p.storage = 0;
    this.events.push({ k: 'down', id: p.id, x: p.x, y: p.y });
    const where = locationAt(this.world.locations, Math.floor(p.x / TILE), Math.floor(p.y / TILE))?.name ?? `拠点の${directionName(p.x / TILE, p.y / TILE)}・${Math.round(Math.hypot(p.x / TILE - BASE_TX, p.y / TILE - BASE_TY))}m`;
    if (this.players.length > 1) this.events.push({ k: 'feed', cat: 'danger', t: `${p.name} がダウン！（${where}）コンパスの SOS へ。[E] 長押しで救助（${PLAYER.downTime}秒以内）`, c: '#e07a60', snd: 'alarm' });
  }

  /** 戦闘不能：持ち物をすべてその場の袋に落とす（仲間が回収できる） */
  private killPlayer(p: SimPlayer): void {
    p.status = 'dead';
    p.downTimer = 0;
    p.reviveProgress = 0;
    const bag = this.groundBag(p.x, p.y);
    if (bag) {
      const c = this.contents.get(bag.id)!;
      while (c.length < 20) c.push(null);
      for (const s of p.bag) if (s) addItem(c, s.id, s.n, s.w);
      if (p.prim) addItem(c, p.prim.id, 1, p.prim.w);
      if (p.sec) addItem(c, p.sec.id, 1, p.sec.w);
    }
    p.bag = emptyBag();
    p.prim = null;
    p.sec = null;
    this.events.push({ k: 'dead', id: p.id });
    this.events.push({ k: 'pop', x: p.x, y: p.y - 30, t: '持ち物を落とした', c: '#c98070', id: p.id });
  }

  // ======================== 騒音（ゾンビの聴覚） ========================

  /** 音を立てる：範囲内のゾンビが音のした場所を調べに来る（近い銃声は即追跡） */
  private makeNoise(x: number, y: number, radius: number, gunshot: boolean): void {
    radius *= this.weatherMul('noise');
    // 夜の静けさ：屋外の物音は遠くまで響き、感染体も鋭くなる
    if (this.phase === 'night' && !INDOOR_FLOORS.has(this.world.terrainAt(Math.floor(x / TILE), Math.floor(y / TILE)))) radius *= 1.25;
    if (gunshot && radius >= 300) this.events.push({ k: 'noise', x, y, r: radius });
    for (const z of this.zombies) {
      if (z.state === 'chase') continue;
      const d = Math.hypot(z.x - x, z.y - y);
      if (d > radius) continue;
      // 壁越しの小さな音は届きにくい
      if (!gunshot && d > radius * 0.5 && !this.world.lineClear(z.x, z.y, x, y)) continue;
      z.state = 'investigate';
      z.stateT = 12;
      z.targetX = x + (Math.random() - 0.5) * 60;
      z.targetY = y + (Math.random() - 0.5) * 60;
      if (gunshot && d < radius * 0.35) this.startChase(z);
    }
  }

  private lastScream = new Map<number, number>();

  private startChase(z: SimZombie): void {
    if (z.state !== 'chase') this.events.push({ k: 'alert', x: z.x, y: z.y });
    // 叫び屋：獲物を見つけると叫び、遠くのゾンビまで呼び寄せる（10秒に1回）
    if (z.type === 'screamer' && z.state !== 'chase' && this.time - (this.lastScream.get(z.id) ?? -99) > 10) {
      this.lastScream.set(z.id, this.time);
      this.events.push({ k: 'scream', x: z.x, y: z.y });
      z.state = 'chase';
      this.makeNoise(z.x, z.y, 760, true);
      for (const p of this.players)
        if (p.status === 'alive' && Math.hypot(p.x - z.x, p.y - z.y) < 900) this.events.push({ k: 'feed', t: '叫び屋が叫んだ — 周りのゾンビが集まってくる', c: '#e0905e', id: p.id, cat: 'danger' });
    }
    z.state = 'chase';
    z.stateT = 6;
  }

  // ======================== フローフィールド（追跡用の経路） ========================

  private enterCost(i: number): number {
    const t = this.world.terrain[i];
    // 経路計算はアクティブなチャンクの中だけ（広い地図全体を毎回たどらない）
    {
      const x = i % MAP_W;
      const y = (i - x) / MAP_W;
      if (!this.chunkActive[Math.floor(y / CHUNK) * CHUNKS_X + Math.floor(x / CHUNK)]) return -1;
    }
    if (t === T_WALL || t === T_WINDOW || t === T_FENCE || t === T_WATER) return -1;
    const x = i % MAP_W;
    const y = (i - x) / MAP_W;
    // 拠点（安全地帯）にはゾンビは入らない
    const sh = SAFEHOUSE;
    if (!this.hordeNight && x >= sh.x && y >= sh.y && x < sh.x + sh.w && y < sh.y + sh.h) return -1;
    const o = this.world.objAt(x, y);
    // 浅瀬は遅いので遠回りでも橋を選びがち
    if (!o) return t === T_SHALLOW ? 2.5 : 1;
    if (BREAKABLE_KINDS.has(o.kind) && objIsSolid(o)) return 3 + o.hp / 35;
    return objIsSolid(o) ? -1 : 1;
  }

  private computeFlow(): void {
    const flow = this.flow;
    flow.fill(Infinity);
    const heap = new MinHeap();
    for (const p of this.players) {
      if (p.status !== 'alive' || p.away || this.safeIn(p.x, p.y)) continue;
      const i = Math.floor(p.y / TILE) * MAP_W + Math.floor(p.x / TILE);
      flow[i] = 0;
      heap.push(0, i);
    }
    if (heap.size === 0) return;
    const cost = this.flowCost;
    cost.fill(-2);
    const getCost = (i: number) => {
      if (cost[i] === -2) cost[i] = this.enterCost(i);
      return cost[i];
    };
    while (heap.size > 0) {
      const [d, i] = heap.pop();
      if (d > flow[i]) continue;
      const x = i % MAP_W;
      const y = (i - x) / MAP_W;
      for (const [dx, dy, w] of NEIGHBORS) {
        const nx = x + dx;
        const ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= MAP_W || ny >= MAP_H) continue;
        const j = ny * MAP_W + nx;
        const c = getCost(j);
        if (c < 0) continue;
        if (dx && dy && (getCost(y * MAP_W + nx) !== 1 || getCost(ny * MAP_W + x) !== 1)) continue;
        const nd = d + c * w;
        if (nd < flow[j]) {
          flow[j] = nd;
          heap.push(nd, j);
        }
      }
    }
  }

  // ======================== ゾンビの配置と補充 ========================

  private locTarget(loc: Location): number {
    // 拠点近く（★1）は少なめ、遠いほど多い
    return Math.round(((loc.w * loc.h) / 28) * (0.45 + 0.42 * loc.tier));
  }

  // ======================== チャンク管理 ========================

  private chunkOf(x: number, y: number): number {
    const cx = Math.min(CHUNKS_X - 1, Math.max(0, Math.floor(x / TILE / CHUNK)));
    const cy = Math.min(CHUNKS_Y - 1, Math.max(0, Math.floor(y / TILE / CHUNK)));
    return cy * CHUNKS_X + cx;
  }

  /** ゾンビがアクティブなチャンクにいるか */
  zActive(z: { x: number; y: number }): boolean {
    return this.chunkActive[this.chunkOf(z.x, z.y)] === 1;
  }

  /** プレイヤーの周囲のチャンクをアクティブにし、新しく入ったチャンクにはゾンビを配置、離れたチャンクの雑魚は片付ける */
  private updateChunks(initial: boolean): void {
    const next = new Uint8Array(CHUNKS_X * CHUNKS_Y);
    for (const p of this.players) {
      if (p.status === 'dead') continue;
      const c = this.chunkOf(p.x, p.y);
      const pcx = c % CHUNKS_X;
      const pcy = (c - pcx) / CHUNKS_X;
      for (let dy = -ACTIVE_R; dy <= ACTIVE_R; dy++)
        for (let dx = -ACTIVE_R; dx <= ACTIVE_R; dx++) {
          const x = pcx + dx;
          const y = pcy + dy;
          if (x >= 0 && y >= 0 && x < CHUNKS_X && y < CHUNKS_Y) next[y * CHUNKS_X + x] = 1;
        }
    }
    let active = 0;
    for (let i = 0; i < next.length; i++) {
      if (next[i]) active++;
      if (next[i] && !this.chunkActive[i]) {
        this.chunkActive[i] = 1;
        this.stats.activations++;
        // 長く離れていたチャンクだけ湧き直す
        if (this.time - this.chunkSeeded[i] > 150) {
          this.chunkSeeded[i] = this.time;
          this.seedChunk(i, initial);
        }
      } else if (!next[i] && this.chunkActive[i]) {
        this.chunkActive[i] = 0;
        this.stats.deactivations++;
        this.chunkSeeded[i] = this.time; // 離れた時刻から数える
      }
    }
    this.stats.active = active;
    // 非アクティブなチャンクの、追跡していない雑魚は片付ける（数を抑える）
    let removed = 0;
    for (const z of this.zombies) {
      if (z.dead || z.keep || z.state === 'chase' || this.zActive(z)) continue;
      z.dead = true;
      removed++;
    }
    this.stats.despawned += removed;
    if (initial) this.flowTimer = 0;
  }

  /** チャンクにゾンビを配置：中にあるロケーションの見張り＋野外の徘徊者（遠いほど多く強い） */
  private seedChunk(i: number, initial: boolean): void {
    const cx = i % CHUNKS_X;
    const cy = (i - cx) / CHUNKS_X;
    const x0 = cx * CHUNK;
    const y0 = cy * CHUNK;
    const minDist = initial ? 420 : 560;
    let room = REGION_MAX - this.regionCount(i);
    for (const loc of this.world.locations) {
      if (loc.kind === 'base') continue;
      const lcx = loc.x + loc.w / 2;
      const lcy = loc.y + loc.h / 2;
      if (lcx < x0 || lcy < y0 || lcx >= x0 + CHUNK || lcy >= y0 + CHUNK) continue;
      const n = this.locTarget(loc);
      for (let k = 0; k < n && this.zombies.length < MAX_ZOMBIES && room > 0; k++, room--) this.spawnIn(loc, minDist);
    }
    const mid = Math.hypot(x0 + CHUNK / 2 - BASE_TX, y0 + CHUNK / 2 - BASE_TY);
    const tier = tierAtDistance(mid);
    const edge = edgeDistance(x0 + CHUNK / 2, y0 + CHUNK / 2) < EDGE_BAND ? 2 : 0;
    const cd = districtAt(this.world.districts, x0 + CHUNK / 2, y0 + CHUNK / 2);
    const dens = cd ? DISTRICT_ZOMBIES[cd.kind].density : 1;
    const wanderers = mid < 16 ? 0 : Math.round((tier + edge + (this.phase === 'night' ? 1 : 0)) * dens);
    for (let k = 0; k < wanderers && this.zombies.length < MAX_ZOMBIES && room > 0; k++, room--) this.spawnOutdoorIn(i, minDist);
  }

  /** チャンク i のまわり（±ACTIVE_R チャンク）にいるゾンビの数 */
  private regionCount(i: number): number {
    const cx = i % CHUNKS_X;
    const cy = (i - cx) / CHUNKS_X;
    const W = CHUNK * TILE;
    const x0 = (cx - ACTIVE_R) * W;
    const y0 = (cy - ACTIVE_R) * W;
    const x1 = (cx + ACTIVE_R + 1) * W;
    const y1 = (cy + ACTIVE_R + 1) * W;
    let n = 0;
    for (const z of this.zombies) if (!z.dead && z.x >= x0 && z.y >= y0 && z.x < x1 && z.y < y1) n++;
    return n;
  }



  /** 危険度と地区からゾンビの種類を選ぶ（例：軍用地は感染兵士、工業地区は巨漢と膨張体） */
  private typeAt(tier: number, tx: number, ty: number): ZombieType {
    const d = districtAt(this.world.districts, tx, ty);
    if (!d) return this.typeForTier(tier);
    tier = this.boostTier(tier);
    const tr = DISTRICT_ZOMBIES[d.kind];
    const base = BASE_ZOMBIE_WEIGHTS[Math.max(1, Math.min(4, tier))];
    const w: [ZombieType, number][] = [];
    for (const t of ['walker', 'runner', 'brute', 'soldier', 'bloater', 'screamer'] as ZombieType[]) {
      const v = (base[t] ?? 0) * (tr.mul[t] ?? 1) + (tr.add[t] ?? 0) * (tier >= 2 ? 1 : 0.4);
      if (v > 0) w.push([t, v]);
    }
    let r = Math.random() * w.reduce((a, [, v]) => a + v, 0);
    for (const [t, v] of w) if ((r -= v) <= 0) return t;
    return 'walker';
  }

  // ======================== 脅威の段階（日数と救助の進み具合で難しくなる） ========================
  /** 0 = 1〜10 日・1 = 11〜20 日・2 = 21 日〜。救助を呼ぶと +1（無線の電波に寄ってくる） */
  threat(): number {
    const band = this.day <= 10 ? 0 : this.day <= 20 ? 1 : 2;
    return Math.min(3, band + (this.rescue.stage >= 3 ? 1 : 0));
  }
  /** 体力の倍率：段階ごとに少しずつ。30 日目でも 1 日目の 2 倍未満（弾を撃ち込むだけの作業にしない） */
  private hpMul(): number {
    return [1, 1.2, 1.4, 1.6][this.threat()] * (1 + 0.02 * ((Math.max(1, this.day) - 1) % 10));
  }
  /** 出てくる種類：段階が上がるほど、危険な地区の顔ぶれに近づく */
  private boostTier(tier: number): number {
    const t = this.threat();
    const up = t >= 3 ? (Math.random() < 0.3 ? 2 : 1) : t >= 2 ? 1 : t >= 1 ? (Math.random() < 0.35 ? 1 : 0) : 0;
    return Math.max(1, Math.min(4, tier + up));
  }
  private lastThreat = 0;
  /** 段階が上がったら知らせる（朝・救助を呼んだとき） */
  private announceThreat(): void {
    const t = this.threat();
    if (t <= this.lastThreat) {
      this.lastThreat = t;
      return;
    }
    this.lastThreat = t;
    const msg = ['', '感染が広がった — 走る個体・大男が増え、群れも大きくなる', '感染が拠点の近くまで来た — 精鋭がどこにでも現れる', '無線の電波に感染体が集まってくる — 救助まで持ちこたえろ'][t];
    this.events.push({ k: 'feed', cat: 'danger', t: `脅威 Lv${t + 1}：${msg}`, c: '#e0583e', snd: 'alarm' });
  }

  private typeForTier(tier: number): ZombieType {
    tier = this.boostTier(tier);
    const r = Math.random();
    if (tier >= 4) return r < 0.45 ? 'soldier' : r < 0.7 ? 'brute' : r < 0.92 ? 'runner' : 'walker';
    if (tier >= 3) return r < 0.5 ? 'soldier' : r < 0.68 ? 'brute' : r < 0.88 ? 'runner' : 'walker';
    if (tier === 2) return r < 0.1 ? 'brute' : r < 0.32 ? 'runner' : r < 0.4 ? 'soldier' : 'walker';
    return r < 0.18 ? 'runner' : 'walker';
  }

  private spawnIn(loc: Location, minDist = 420): void {
    for (let t = 0; t < 20; t++) {
      const tx = loc.x + 1 + Math.floor(Math.random() * Math.max(1, loc.w - 2));
      const ty = loc.y + 1 + Math.floor(Math.random() * Math.max(1, loc.h - 2));
      if (this.world.solid(tx, ty)) continue;
      const x = (tx + 0.5) * TILE;
      const y = (ty + 0.5) * TILE;
      if (inBase(x, y) || this.players.some((p) => Math.hypot(p.x - x, p.y - y) < minDist)) continue;
      this.spawnZombie(this.typeAt(loc.tier, tx, ty), x, y);
      return;
    }
  }

  /** アクティブなチャンクのどこかの野外に1体 */
  private spawnOutdoor(minDist: number): void {
    const act: number[] = [];
    for (let i = 0; i < this.chunkActive.length; i++) if (this.chunkActive[i]) act.push(i);
    if (!act.length) return;
    const i = act[Math.floor(Math.random() * act.length)];
    if (this.regionCount(i) < REGION_MAX) this.spawnOutdoorIn(i, minDist);
  }

  private spawnOutdoorIn(chunk: number, minDist: number): void {
    const cx = chunk % CHUNKS_X;
    const cy = (chunk - cx) / CHUNKS_X;
    for (let t = 0; t < 25; t++) {
      const tx = cx * CHUNK + Math.floor(Math.random() * CHUNK);
      const ty = cy * CHUNK + Math.floor(Math.random() * CHUNK);
      if (tx < 1 || ty < 1 || tx >= MAP_W - 1 || ty >= MAP_H - 1) continue;
      if (this.world.solid(tx, ty) || this.world.buildingAt(tx, ty)) continue;
      const d = Math.hypot(tx - BASE_TX, ty - BASE_TY);
      if (d < 15) continue;
      const x = (tx + 0.5) * TILE;
      const y = (ty + 0.5) * TILE;
      if (this.players.some((p) => Math.hypot(p.x - x, p.y - y) < minDist)) continue;
      const deep = edgeDistance(tx, ty) < EDGE_BAND ? 1 : 0;
      const type = this.typeAt(Math.min(4, tierAtDistance(d) + deep), tx, ty);
      this.spawnZombie(type, x, y);
      // 群れ：住宅街・荒野では数体まとまってうろつく
      const dist = districtAt(this.world.districts, tx, ty);
      if (dist && Math.random() < DISTRICT_ZOMBIES[dist.kind].pack) {
        const n = 1 + Math.floor(Math.random() * 3);
        for (let k = 0; k < n && this.zombies.length < MAX_ZOMBIES; k++) {
          const px = x + (Math.random() - 0.5) * 120;
          const py = y + (Math.random() - 0.5) * 120;
          if (this.world.solid(Math.floor(px / TILE), Math.floor(py / TILE))) continue;
          const zz = this.spawnZombie(type === 'screamer' || type === 'bloater' ? 'walker' : type, px, py);
          zz.wanderA = this.zombies[this.zombies.length - 1 - (k + 1)]?.wanderA ?? zz.wanderA;
        }
      }
      return;
    }
  }


  /** 誰もいない場所には少しずつゾンビが戻ってくる。夜は野外の徘徊者が増える */
  private updateSpawning(dt: number): void {
    this.spawnTimer -= dt;
    if (this.spawnTimer > 0 || this.zombies.length >= MAX_ZOMBIES) return;
    this.spawnTimer = 6;
    for (const loc of this.world.locations) {
      if (loc.kind === 'base') continue;
      const cx = (loc.x + loc.w / 2) * TILE;
      const cy = (loc.y + loc.h / 2) * TILE;
      if (!this.chunkActive[this.chunkOf(cx, cy)]) continue;
      if (this.players.some((p) => Math.hypot(p.x - cx, p.y - cy) < 900)) continue;
      const x0 = loc.x * TILE;
      const y0 = loc.y * TILE;
      const x1 = (loc.x + loc.w) * TILE;
      const y1 = (loc.y + loc.h) * TILE;
      const inside = this.zombies.filter((z) => z.x > x0 && z.y > y0 && z.x < x1 && z.y < y1).length;
      if (inside < this.locTarget(loc) * 0.7 && Math.random() < 0.35 && this.regionCount(this.chunkOf(cx, cy)) < REGION_MAX) this.spawnIn(loc);
    }
    const outdoor = this.zombies.filter((z) => this.zActive(z) && !this.world.buildingAt(Math.floor(z.x / TILE), Math.floor(z.y / TILE))).length;
    // アクティブな範囲の広さに比例（仲間と離れて探索していると、それぞれの周りに湧く）
    const per = (this.phase === 'night' ? 1.4 : 0.9) + Math.min(0.6, this.day * 0.03) + this.threat() * 0.2 + (this.weather === 'storm' ? 0.4 : 0);
    const want = Math.round(this.stats.active * per);
    if (outdoor < want) this.spawnOutdoor(650);
  }

  private spawnZombie(type: ZombieType, x: number, y: number, forceElite = false): SimZombie {
    // 汚染地帯の個体は少し手強い
    const loc = locationAt(this.world.locations, Math.floor(x / TILE), Math.floor(y / TILE));
    const elite = loc?.hot ? 1.3 : 1;
    // 精鋭（ハクスラ）：まれに現れる手強い個体。倒すと良い戦利品を必ず落とす
    const tier = this.tierAt(Math.floor(x / TILE), Math.floor(y / TILE));
    const th = this.threat();
    const isElite = forceElite || (tier >= 2 || th >= 2) && type !== 'screamer' && type !== 'bloater' && Math.random() < 0.015 + tier * 0.008 + th * 0.008 + (this.phase === 'night' ? 0.01 : 0);
    const hp = ZOMBIE[type].hp * this.hpMul() * elite * (isElite ? 3.2 : 1);
    this.zombies.push({
      id: this.nextId++,
      type,
      x,
      y,
      angle: Math.random() * Math.PI * 2,
      hp,
      maxHp: hp,
      flash: 0,
      alert: 0,
      atk: 0,
      kx: 0,
      ky: 0,
      attackCd: 0,
      state: 'idle',
      stateT: 0,
      targetX: x,
      targetY: y,
      homeX: x,
      homeY: y,
      wanderA: Math.random() * Math.PI * 2,
      wanderT: Math.random() * 3,
      senseT: Math.random() * 0.3,
      speedMul: (0.85 + Math.random() * 0.3) * (isElite ? 1.15 : 1),
      ...(isElite ? { elite: true } : {}),
      stuckT: 0,
      route: null,
      routeI: 0,
      keep: false,
      dead: false,
    });
    return this.zombies[this.zombies.length - 1];
  }

  /** 巡回する群れを出す：いくつかのロケーションを順に回る */
  private spawnPatrols(groups: number): void {
    // 巡回はアクティブな範囲（プレイヤーの周辺チャンク）のロケーション間で
    const locs = this.world.locations.filter((l) => l.kind !== 'base' && this.chunkActive[this.chunkOf((l.x + l.w / 2) * TILE, (l.y + l.h / 2) * TILE)]);
    for (let g = 0; g < groups && locs.length >= 2; g++) {
      const pts: { x: number; y: number }[] = [];
      const n = 2 + Math.floor(Math.random() * 2);
      for (let i = 0; i < n; i++) {
        const l = locs[Math.floor(Math.random() * locs.length)];
        // 建物の出入口付近（外周の少し外）を通る
        pts.push({ x: (l.x + l.w / 2) * TILE + (Math.random() - 0.5) * 80, y: (l.y + l.h + 1.5) * TILE });
      }
      const start = pts[0];
      if (this.players.some((p) => Math.hypot(p.x - start.x, p.y - start.y) < 600) || inBase(start.x, start.y)) continue;
      const tier = Math.max(...locs.map((l) => l.tier)) >= 3 && Math.random() < 0.4 ? 3 : 2;
      const size = 3 + Math.floor(Math.random() * 3);
      for (let i = 0; i < size; i++) {
        const z = this.spawnZombie(this.typeForTier(tier), start.x + (Math.random() - 0.5) * 70, start.y + (Math.random() - 0.5) * 70);
        moveCircle(z, 0, 0, ZOMBIE[z.type].radius, this.world);
        z.route = pts.map((p) => ({ x: p.x + (Math.random() - 0.5) * 50, y: p.y + (Math.random() - 0.5) * 50 }));
      }
    }
  }

  // ======================== 天候 ========================

  /** 天候による倍率（切り替わり中は wx でなめらかに補間） */
  private weatherMul(k: 'sight' | 'noise'): number {
    return 1 + (WEATHER_FX[this.weather][k] - 1) * this.wx;
  }

  /** 朝と夕方に天候が変わる */
  private rollWeather(): void {
    const r = Math.random();
    const next: Weather = r < 0.45 ? 'clear' : r < 0.65 ? 'fog' : r < 0.87 ? 'rain' : 'storm';
    this.setWeather(next, false);
  }

  private setWeather(w: Weather, instant: boolean): void {
    if (w === this.weather && w === this.nextWeather) return;
    this.nextWeather = w;
    if (instant) {
      this.weather = w;
      this.wx = w === 'clear' ? 0 : 1;
    }
    if (w !== 'clear') this.events.push({ k: 'feed', cat: 'info', t: `天候：${WEATHER_FX[w].name} — ${WEATHER_FX[w].desc}`, c: '#aab8c8' });
    else if (this.weather !== 'clear') this.events.push({ k: 'feed', cat: 'info', t: '天候：晴れてきた', c: '#aab8c8' });
  }

  private updateWeather(dt: number): void {
    if (this.nextWeather !== this.weather) {
      // いったん弱まってから次の天候へ
      this.wx = Math.max(0, this.wx - dt / 8);
      if (this.wx <= 0) this.weather = this.nextWeather;
    } else if (this.weather !== 'clear') this.wx = Math.min(1, this.wx + dt / 8);
  }

  // ======================== 補給物資（空中投下） ========================

  private dropPos(): { x: number; y: number } | null {
    if (this.dropObj === null) return null;
    const o = this.world.objects.get(this.dropObj);
    return o ? { x: (o.tx + 0.5) * TILE, y: (o.ty + 0.5) * TILE } : null;
  }

  /** 昼のどこかで、拠点から遠い野外に補給物資が落ちてくる（感染兵士が群がる） */
  private updateAirdrop(): void {
    if (this.dropAt < 0 || this.phase !== 'day' || this.cycleT < this.dropAt) return;
    this.dropAt = -1;
    if (this.dropObj !== null && this.world.objects.has(this.dropObj)) return;
    const alive = this.players.filter((p) => p.status === 'alive');
    for (let t = 0; t < 300 && alive.length; t++) {
      // 誰かから 30〜60 タイルほど離れた、拠点から遠めの野外（外縁の汚染帯は避ける）
      const who = alive[Math.floor(Math.random() * alive.length)];
      const a = Math.random() * Math.PI * 2;
      const r = 30 + Math.random() * 30;
      const tx = Math.floor(who.x / TILE + Math.cos(a) * r);
      const ty = Math.floor(who.y / TILE + Math.sin(a) * r);
      if (tx < 3 || ty < 3 || tx >= MAP_W - 3 || ty >= MAP_H - 3 || edgeDistance(tx, ty) < EDGE_BAND) continue;
      if (Math.hypot(tx - BASE_TX, ty - BASE_TY) < 30) continue;
      if (this.world.solid(tx, ty) || this.world.objAt(tx, ty) || this.world.buildingAt(tx, ty)) continue;
      const x = (tx + 0.5) * TILE;
      const y = (ty + 0.5) * TILE;
      if (this.players.some((p) => Math.hypot(p.x - x, p.y - y) < 500)) continue;
      const o: SimObj = { id: this.nextObjId++, kind: 'drop', tx, ty, hp: 1, maxHp: 1, ready: 1, regrowT: 0 };
      this.world.setObj(o);
      this.changed.add(o.id);
      this.dropObj = o.id;
      const guards = 3 + Math.floor(Math.random() * 3) + Math.min(3, Math.floor(this.day / 3));
      for (let i = 0; i < guards; i++) {
        const a = (i / guards) * Math.PI * 2;
        const z = this.spawnZombie(Math.random() < 0.6 ? 'soldier' : Math.random() < 0.5 ? 'brute' : 'runner', x + Math.cos(a) * 90, y + Math.sin(a) * 90);
        moveCircle(z, 0, 0, ZOMBIE[z.type].radius, this.world);
        z.keep = true;
        z.homeX = x;
        z.homeY = y;
      }
      this.events.push({ k: 'banner', t: '補給物資が投下された', s: '赤い発煙筒の場所へ。レア物資と、それを狙う感染兵士がいる', c: '#e0b070', snd: 'alarm' });
      this.events.push({ k: 'feed', cat: 'loot', t: '補給物資が投下された（地図に赤く表示）', c: '#e0b070' });
      return;
    }
  }

  // ======================== 拠点設備 ========================

  /** 朝の収納箱の中身（補給所・医務室のレベルで増える） */
  private morningSupplies(o: SimObj): (Slot | null)[] {
    const c = this.rollLoot(o);
    const sup = this.base.supply;
    if (sup >= 1) {
      addItem(c, 'can', 1 + Math.floor(Math.random() * 2));
      addItem(c, Math.random() < 0.5 ? 'ammo9' : 'ammo762', 10 + Math.floor(Math.random() * 10));
    }
    if (sup >= 2) {
      addItem(c, 'gunpowder', 2);
      if (Math.random() < 0.5) addItem(c, 'parts', 1);
      if (Math.random() < 0.4) addItem(c, 'mre', 1);
    }
    if (this.base.med >= 1) addItem(c, 'bandage', 2);
    if (this.base.med >= 2) addItem(c, 'medkit', 1);
    // 菜園の収穫
    if (this.base.garden >= 1) {
      addItem(c, 'can', this.base.garden >= 2 ? 4 : 2);
      addItem(c, 'herbs', this.base.garden >= 2 ? 2 : 1);
      if (this.base.garden >= 2) addItem(c, 'mre', 1);
    }
    // 大群の夜を越えた褒美
    if (this.hordeReward) {
      addItem(c, 'ammo9', 20);
      addItem(c, 'ammo762', 15);
      addItem(c, 'medkit', 1);
      addItem(c, 'mre', 1);
    }
    return c;
  }

  private resizeStorage(): void {
    const sz = STORAGE_SIZES[Math.min(STORAGE_SIZES.length - 1, this.base.storage)];
    while (this.storage.shared.length < sz.shared) this.storage.shared.push(null);
    for (const k of Object.keys(this.storage.personal)) {
      const b = this.storage.personal[Number(k)];
      while (b.length < sz.personal) b.push(null);
    }
  }

  // ======================== ゾンビAI ========================

  /** 視覚：向いている方向の視野・距離・昼夜・懐中電灯の光で判定 */
  private canSee(z: SimZombie, p: SimPlayer): boolean {
    const dx = p.x - z.x;
    const dy = p.y - z.y;
    const d = Math.hypot(dx, dy);
    if (d < 56) return true; // すぐそばなら気配で気づく
    const night = this.phase === 'night';
    let range = (night ? 170 : 320) * this.weatherMul('sight');
    // 夜は懐中電灯の光が目立つ：プレイヤーの光の円錐の中にいると遠くからでも気づく
    if (night && d < 520 && Math.abs(angleDiff(p.aim, Math.atan2(-dy, -dx))) < 0.45) range = 520;
    if (d > range) return false;
    const fov = z.state === 'chase' || z.state === 'search' ? Math.PI : Math.PI * 0.4;
    if (Math.abs(angleDiff(z.angle, Math.atan2(dy, dx))) > fov) return false;
    return this.world.lineClear(z.x, z.y, p.x, p.y);
  }

  /** 拠点の中で、いまゾンビから守られているか（大群の夜は守られない） */
  private safeIn(x: number, y: number): boolean {
    return !this.hordeNight && inBase(x, y);
  }

  /** 大群：各プレイヤーの周り（画面の外）から一斉に押し寄せる */
  private spawnHordeWave(): void {
    const alive = this.players.filter((p) => p.status === 'alive' && !p.away);
    if (!alive.length) return;
    const total = Math.min(56, 10 + Math.min(19, this.day) * 2 + this.threat() * 4);
    for (const p of alive) {
      const n = Math.ceil(total / alive.length);
      for (let k = 0; k < n && this.zombies.length < MAX_ZOMBIES; k++) {
        for (let t = 0; t < 12; t++) {
          const a = Math.random() * Math.PI * 2;
          const d = 650 + Math.random() * 350;
          const x = p.x + Math.cos(a) * d;
          const y = p.y + Math.sin(a) * d;
          const tx = Math.floor(x / TILE);
          const ty = Math.floor(y / TILE);
          if (this.world.solid(tx, ty) || inBase(x, y)) continue;
          const tier = Math.min(4, tierAtDistance(Math.hypot(tx - BASE_TX, ty - BASE_TY)) + 1);
          const z = this.spawnZombie(this.typeAt(tier, tx, ty), x, y);
          z.keep = true;
          z.state = 'chase';
          z.stateT = 40;
          z.targetX = p.x;
          z.targetY = p.y;
          break;
        }
      }
    }
    this.flowTimer = 0;
  }

  private nearestAlive(x: number, y: number): { p: SimPlayer; d: number } | null {
    let best: SimPlayer | null = null;
    let bd = Infinity;
    for (const p of this.players) {
      if (p.status !== 'alive' || p.away) continue;
      const d = Math.hypot(p.x - x, p.y - y);
      if (d < bd) {
        bd = d;
        best = p;
      }
    }
    return best ? { p: best, d: bd } : null;
  }

  private updateZombie(z: SimZombie, dt: number): void {
    const st = ZOMBIE[z.type];
    const night = this.phase === 'night';
    z.flash = Math.max(0, z.flash - dt);
    z.attackCd = Math.max(0, z.attackCd - dt);
    z.stateT -= dt;

    // ---- 知覚（0.2秒ごと） ----
    z.senseT -= dt;
    if (z.senseT <= 0) {
      z.senseT = 0.2;
      for (const p of this.players) {
        if (p.status !== 'alive' || p.away || this.safeIn(p.x, p.y)) continue;
        if (this.canSee(z, p)) {
          this.startChase(z);
          z.targetX = p.x;
          z.targetY = p.y;
          break;
        }
      }
    }
    // 状態の遷移
    if (z.state === 'chase' && z.stateT <= 0) {
      z.state = 'search';
      z.stateT = 7;
    } else if ((z.state === 'investigate' || z.state === 'search') && z.stateT <= 0) {
      z.state = 'idle';
      z.homeX = z.x;
      z.homeY = z.y;
    }

    const near = this.nearestAlive(z.x, z.y);
    let speed = (night ? st.nightSpeed : st.daySpeed) * z.speedMul * this.world.speedAt(Math.floor(z.x / TILE), Math.floor(z.y / TILE));
    let dx = 0;
    let dy = 0;
    let wantAttack: SimObj | null = null;

    if (z.state === 'chase' && near) {
      if (near.d < 260 && this.world.lineClear(z.x, z.y, near.p.x, near.p.y) && this.world.lineWalkable(z.x, z.y, near.p.x, near.p.y)) {
        dx = (near.p.x - z.x) / (near.d || 1);
        dy = (near.p.y - z.y) / (near.d || 1);
        z.stateT = Math.max(z.stateT, 3);
        z.targetX = near.p.x;
        z.targetY = near.p.y;
      } else {
        const step = this.flowStep(z);
        if (step) {
          dx = step.dx;
          dy = step.dy;
          wantAttack = step.obstacle;
        } else {
          const l = Math.hypot(z.targetX - z.x, z.targetY - z.y) || 1;
          dx = (z.targetX - z.x) / l;
          dy = (z.targetY - z.y) / l;
        }
      }
    } else if (z.state === 'investigate' || z.state === 'search') {
      const l = Math.hypot(z.targetX - z.x, z.targetY - z.y);
      if (l < 30) {
        // 着いたらあたりを見回す
        z.wanderT -= dt;
        if (z.wanderT <= 0) {
          z.wanderT = 1 + Math.random() * 1.5;
          z.wanderA = Math.random() * Math.PI * 2;
        }
        dx = Math.cos(z.wanderA) * 0.4;
        dy = Math.sin(z.wanderA) * 0.4;
      } else {
        dx = (z.targetX - z.x) / l;
        dy = (z.targetY - z.y) / l;
      }
      speed *= 0.7;
    } else if (z.route) {
      // 巡回：ロケーションの間を群れで歩く
      const wp = z.route[z.routeI];
      const l = Math.hypot(wp.x - z.x, wp.y - z.y);
      if (l < 40) z.routeI = (z.routeI + 1) % z.route.length;
      dx = (wp.x - z.x) / (l || 1);
      dy = (wp.y - z.y) / (l || 1);
      speed *= night ? 0.55 : 0.42;
    } else {
      // 徘徊（住処の近くをうろつく）
      z.wanderT -= dt;
      if (z.wanderT <= 0) {
        z.wanderT = 2 + Math.random() * 4;
        const back = Math.hypot(z.homeX - z.x, z.homeY - z.y) > 200;
        z.wanderA = back ? Math.atan2(z.homeY - z.y, z.homeX - z.x) : Math.random() < 0.4 ? NaN : Math.random() * Math.PI * 2;
      }
      if (!Number.isNaN(z.wanderA)) {
        dx = Math.cos(z.wanderA);
        dy = Math.sin(z.wanderA);
      }
      speed *= night ? 0.45 : 0.32;
    }

    if (dx || dy) z.angle = Math.atan2(dy, dx);
    const decay = Math.exp(-6 * dt);
    z.kx *= decay;
    z.ky *= decay;
    const px = z.x;
    const py = z.y;
    const collided: { tx: number; ty: number }[] = [];
    // 釘の罠：踏むと大きなダメージと足止め。罠は使うほど傷む
    const trap = this.world.objAt(Math.floor(z.x / TILE), Math.floor(z.y / TILE));
    if (trap && trap.kind === 'spike') {
      speed *= 0.4;
      trap.hp -= 9 * dt;
      if (Math.random() < dt * 4) this.changed.add(trap.id);
      this.damageZombie(z, 60 * dt, -1, 0, 0, 0, true);
      if (trap.hp <= 0) this.destroyObj(trap);
      if (z.dead) return;
    }
    moveCircle(z, (dx * speed + z.kx) * dt, (dy * speed + z.ky) * dt, st.radius, this.world, collided);
    // 拠点（安全地帯）には入れない（大群の夜は除く）
    if (this.safeIn(z.x, z.y)) {
      z.x = px;
      z.y = py;
      if (z.state !== 'chase') {
        z.wanderA = Math.atan2(z.y - (SAFEHOUSE.y + SAFEHOUSE.h / 2) * TILE, z.x - (SAFEHOUSE.x + SAFEHOUSE.w / 2) * TILE);
        z.state = 'idle';
      }
    }
    // 引っかかったら向きを変える
    if ((dx || dy) && Math.hypot(z.x - px, z.y - py) < speed * dt * 0.2) {
      z.stuckT += dt;
      if (z.stuckT > 1.2 && z.state !== 'chase') {
        z.stuckT = 0;
        z.wanderA = Math.random() * Math.PI * 2;
        if (z.state === 'investigate') z.stateT = Math.min(z.stateT, 1.5);
      }
    } else z.stuckT = 0;

    if (z.attackCd > 0) return;
    if (near && near.d < st.radius + PLAYER.radius + 6) {
      this.damagePlayer(near.p, st.damage * (z.elite ? 1.4 : 1));
      this.injure(near.p, z.type === 'brute' ? 0.35 : 0, st.damage >= 10 ? 0.2 : 0.08);
      z.attackCd = st.attackInterval;
      z.atk++;
      this.startChase(z);
      return;
    }
    if (z.state !== 'chase' && z.state !== 'investigate') return;
    let target: SimObj | null = null;
    if (wantAttack && this.distToTile(z, wantAttack.tx, wantAttack.ty) < st.radius + 8) target = wantAttack;
    if (!target) {
      for (const c of collided) {
        const o = this.world.objAt(c.tx, c.ty);
        if (o && BREAKABLE_KINDS.has(o.kind) && objIsSolid(o)) {
          target = o;
          break;
        }
      }
    }
    if (target) {
      const built = BUILD_KINDS.has(target.kind);
      target.hp -= st.wallDamage * (built ? BUILD_DAMAGE_MUL : 1);
      // 拠点のバリケードが攻撃されている：仲間に知らせる（修理・迎撃の合図）
      if (built && this.time - this.barricadeWarnT > 10) {
        this.barricadeWarnT = this.time;
        const dir = directionName(target.tx, target.ty);
        this.events.push({ k: 'feed', cat: 'danger', t: `拠点の${dir}側のバリケードが攻撃されている！（残り ${Math.round((Math.max(0, target.hp) / target.maxHp) * 100)}%）[F] で修理`, c: '#e0583e' });
      }
      this.changed.add(target.id);
      z.attackCd = st.attackInterval;
      z.atk++;
      z.angle = Math.atan2((target.ty + 0.5) * TILE - z.y, (target.tx + 0.5) * TILE - z.x);
      const cx = (target.tx + 0.5) * TILE;
      const cy = (target.ty + 0.5) * TILE;
      this.events.push({ k: 'smash', x: cx, y: cy, kind: target.kind });
      if (target.hp <= 0) this.destroyObj(target);
    }
  }

  private distToTile(z: { x: number; y: number }, tx: number, ty: number): number {
    const cx = Math.max(tx * TILE, Math.min(z.x, tx * TILE + TILE));
    const cy = Math.max(ty * TILE, Math.min(z.y, ty * TILE + TILE));
    return Math.hypot(z.x - cx, z.y - cy);
  }

  private flowStep(z: SimZombie): { dx: number; dy: number; obstacle: SimObj | null } | null {
    const tx = Math.floor(z.x / TILE);
    const ty = Math.floor(z.y / TILE);
    let best = this.flow[ty * MAP_W + tx];
    let bx = -1;
    let by = -1;
    for (const [dx, dy] of NEIGHBORS) {
      const nx = tx + dx;
      const ny = ty + dy;
      if (nx < 0 || ny < 0 || nx >= MAP_W || ny >= MAP_H) continue;
      if (dx && dy && (this.world.solid(tx + dx, ty) || this.world.solid(tx, ty + dy))) continue;
      const v = this.flow[ny * MAP_W + nx];
      if (v < best) {
        best = v;
        bx = nx;
        by = ny;
      }
    }
    if (bx < 0 || !Number.isFinite(best)) return null;
    const cx = (bx + 0.5) * TILE;
    const cy = (by + 0.5) * TILE;
    const d = Math.hypot(cx - z.x, cy - z.y) || 1;
    const o = this.world.objAt(bx, by);
    return { dx: (cx - z.x) / d, dy: (cy - z.y) / d, obstacle: o && BREAKABLE_KINDS.has(o.kind) && objIsSolid(o) ? o : null };
  }

  private separateZombies(): void {
    const zs = this.zombies;
    for (let i = 0; i < zs.length; i++) {
      const a = zs[i];
      const ra = ZOMBIE[a.type].radius;
      for (let j = i + 1; j < zs.length; j++) {
        const b = zs[j];
        const dx = b.x - a.x;
        const dy = b.y - a.y;
        if (Math.abs(dx) > 50 || Math.abs(dy) > 50) continue;
        const min = ra + ZOMBIE[b.type].radius;
        const d2 = dx * dx + dy * dy;
        if (d2 < min * min && d2 > 1e-4) {
          const d = Math.sqrt(d2);
          const push = (min - d) * 0.5;
          a.x -= (dx / d) * push;
          a.y -= (dy / d) * push;
          b.x += (dx / d) * push;
          b.y += (dy / d) * push;
        }
      }
      moveCircle(a, 0, 0, ra, this.world);
    }
  }

  private damageZombie(z: SimZombie, dmg: number, owner: number, dirX: number, dirY: number, knock: number, ap = true): void {
    if (z.dead) return;
    // 装甲：通常弾は軽減される（徹甲弾・近接は無視）
    const armor = ZOMBIE[z.type].armor;
    if (!ap && armor > 0) {
      dmg *= 1 - armor;
      this.events.push({ k: 'ricochet', x: z.x, y: z.y });
    }
    z.hp -= dmg;
    z.flash = 0.08;
    const l = Math.hypot(dirX, dirY) || 1;
    const resist = z.type === 'brute' ? 0.25 : z.type === 'soldier' ? 0.6 : z.type === 'bloater' ? 0.5 : 1;
    z.kx += (dirX / l) * knock * resist;
    z.ky += (dirY / l) * knock * resist;
    const shooter = this.players.find((p) => p.id === owner);
    if (shooter) {
      z.targetX = shooter.x;
      z.targetY = shooter.y;
    }
    this.startChase(z);
    this.events.push({ k: 'dmg', x: z.x, y: z.y - ZOMBIE[z.type].radius, v: Math.round(dmg), p: false });
    if (z.hp <= 0) this.killZombie(z, owner, dirX / l, dirY / l);
  }

  private killZombie(z: SimZombie, owner: number, dx = 0, dy = 0): void {
    z.dead = true;
    const killer = this.players.find((p) => p.id === owner);
    if (killer) {
      killer.kills++;
      const xp = z.type === 'brute' ? 12 : z.type === 'soldier' ? 9 : z.type === 'bloater' ? 7 : z.type === 'runner' || z.type === 'screamer' ? 4 : 3;
      this.gainXp(killer, killer.tool === Tool.Melee ? 1 : 2, xp);
    }
    this.events.push({ k: 'kill', x: z.x, y: z.y, r: ZOMBIE[z.type].radius, o: owner, t: z.type, id: z.id, a: z.angle, dx: r2(dx), dy: r2(dy) });
    // 膨張体：破裂して毒ガス。近くにいると汚染度が一気に上がる（離れて倒すのが鉄則）
    if (z.type === 'bloater') {
      this.events.push({ k: 'gas', x: z.x, y: z.y });
      for (const p of this.players) {
        if (p.status !== 'alive') continue;
        const d = Math.hypot(p.x - z.x, p.y - z.y);
        if (d > 150) continue;
        p.tox = Math.min(100, p.tox + 32 * (1 - d / 220));
        this.damagePlayer(p, 10 * (1 - d / 200));
        this.pop(p, '毒ガス！ 汚染度上昇', '#b8d070');
      }
      for (const o of this.zombies) if (!o.dead && o !== z && Math.hypot(o.x - z.x, o.y - z.y) < 120) this.damageZombie(o, 25, -1, o.x - z.x, o.y - z.y, 120, true);
    }
    // 精鋭：良い武器・アタッチメント・リュックを必ず落とす
    if (z.elite) {
      const bag = this.groundBag(z.x, z.y);
      if (bag) {
        const c = this.contents.get(bag.id)!;
        const pool: WeaponId[] = ['smg', 'rifle', 'shotgun', 'hunting', 'dmr'];
        const wid = pool[Math.floor(Math.random() * pool.length)];
        const q = Math.random() < 0.18 ? 4 : Math.random() < 0.5 ? 3 : 2;
        addItem(c, wid, 1, { mag: 0, ...rollQuality(q) });
        if (Math.random() < 0.5) addItem(c, ATTACHMENTS[Math.floor(Math.random() * ATTACHMENTS.length)], 1);
        if (Math.random() < 0.25) addItem(c, Math.random() < 0.5 ? 'pack3' : 'upkit', 1);
        addItem(c, ammoOf(wid), 12 + Math.floor(Math.random() * 20));
      }
      this.events.push({ k: 'feed', cat: 'loot', t: `精鋭を倒した！ ${QUALITY[3].name}級の戦利品が落ちた`, c: '#c08af0', snd: 'level' });
    } else if (Math.random() < 0.05) {
      // ふつうのゾンビも、たまに持ち物を落とす
      const bag = this.groundBag(z.x, z.y);
      if (bag) addItem(this.contents.get(bag.id)!, (['ammo9', 'can', 'bandage', 'cloth', 'scrap'] as ItemId[])[Math.floor(Math.random() * 5)], Math.random() < 0.5 ? 1 : 2);
    }
    // 感染兵士は装備を落とすことがある
    if (z.type === 'soldier' && Math.random() < 0.45) {
      const bag = this.groundBag(z.x, z.y);
      if (bag) {
        const c = this.contents.get(bag.id)!;
        addItem(c, Math.random() < 0.6 ? 'ammo762' : 'ammo9', 6 + Math.floor(Math.random() * 12));
        if (Math.random() < 0.25) addItem(c, 'bandage', 1);
        if (Math.random() < 0.08) addItem(c, ATTACHMENTS[Math.floor(Math.random() * ATTACHMENTS.length)], 1);
      }
    }
  }

  // ======================== 弾 ========================

  private updateBullets(dt: number): void {
    for (const b of this.bullets) {
      if (b.dead) continue;
      for (let s = 0; s < 3 && !b.dead; s++) {
        b.x += (b.vx * dt) / 3;
        b.y += (b.vy * dt) / 3;
        if (b.x < 0 || b.y < 0 || b.x > WORLD_W || b.y > WORLD_H) {
          b.dead = true;
          break;
        }
        if (this.world.blocksBullet(Math.floor(b.x / TILE), Math.floor(b.y / TILE))) {
          b.dead = true;
          // ドラム缶は撃つと爆発する
          const ob = this.world.objAt(Math.floor(b.x / TILE), Math.floor(b.y / TILE));
          if (ob && ob.kind === 'barrel') {
            this.destroyObj(ob);
            break;
          }
          this.events.push({ k: 'wall', x: b.x - b.vx * 0.005, y: b.y - b.vy * 0.005, o: b.owner });
          break;
        }
        for (const z of this.zombies) {
          if (z.dead || b.hit.includes(z.id)) continue;
          const r = ZOMBIE[z.type].radius + 3;
          if ((z.x - b.x) ** 2 + (z.y - b.y) ** 2 < r * r) {
            b.hit.push(z.id);
            this.events.push({ k: 'hit', x: b.x, y: b.y, o: b.owner, a: Math.atan2(b.vy, b.vx) });
            this.damageZombie(z, b.dmg, b.owner, b.vx, b.vy, b.knock, b.ap);
            // 貫通：威力を落としながら次の敵へ
            if (b.pierce > 0) {
              b.pierce--;
              b.dmg *= 0.75;
            } else b.dead = true;
            break;
          }
        }
      }
      b.life -= dt;
      if (b.life <= 0) b.dead = true;
    }
  }

  private destroyObj(o: SimObj): void {
    if (!this.world.objects.has(o.id)) return;
    this.world.removeObj(o.id);
    this.changed.delete(o.id);
    this.removed.push(o.id);
    this.events.push({ k: 'break', x: (o.tx + 0.5) * TILE, y: (o.ty + 0.5) * TILE, kind: o.kind });
    this.flowTimer = Math.min(this.flowTimer, 0.1);
    if (o.kind === 'barrel') this.explode((o.tx + 0.5) * TILE, (o.ty + 0.5) * TILE);
  }

  /** ドラム缶の爆発：周りのゾンビを吹き飛ばす（プレイヤーも巻き込む）。隣のドラム缶に誘爆 */
  private explode(x: number, y: number): void {
    const R = 130;
    this.events.push({ k: 'boom', x, y });
    this.makeNoise(x, y, 650, true);
    for (const z of this.zombies) {
      if (z.dead) continue;
      const d = Math.hypot(z.x - x, z.y - y);
      if (d < R) this.damageZombie(z, 130 * (1 - d / (R * 1.4)), -1, z.x - x, z.y - y, 420, true);
    }
    for (const p of this.players) {
      const d = Math.hypot(p.x - x, p.y - y);
      if (d < R) this.damagePlayer(p, 38 * (1 - d / (R * 1.3)));
    }
    const tx = Math.floor(x / TILE);
    const ty = Math.floor(y / TILE);
    for (let yy = ty - 3; yy <= ty + 3; yy++)
      for (let xx = tx - 3; xx <= tx + 3; xx++) {
        const ob = this.world.objAt(xx, yy);
        if (ob && ob.kind === 'barrel') this.destroyObj(ob);
      }
  }
}

function toObjSnap(o: ObjSnap): ObjSnap {
  return { id: o.id, kind: o.kind, tx: o.tx, ty: o.ty, hp: Math.ceil(o.hp), maxHp: o.maxHp, ready: o.ready };
}
