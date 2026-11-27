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
  GameEvent,
  GameResult,
  InputFrame,
  LobbyPlayer,
  ObjKind,
  ObjSnap,
  PlayerSnap,
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
import { buildDef, buildSpotError, canAfford } from './build';
import {
  addItem,
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
import { BUILD_ID_START, type DistrictKind, districtAt, directionName, EDGE_BAND, edgeDistance, generateWorld, type Location, locationAt, objIsSolid, tierAtDistance, TileWorld } from './world';

interface SimPlayer extends PlayerSnap {
  queue: InputFrame[];
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
const BENCH_KINDS: ReadonlySet<ObjKind> = new Set<ObjKind>(['bench']);

/** 漁れる入れ物 */
export const CONTAINER_KINDS: ReadonlySet<ObjKind> = new Set<ObjKind>(['shelf', 'cabinet', 'locker', 'wcase', 'fridge', 'desk', 'crate', 'mcrate', 'car', 'box', 'bag', 'drop']);
/** 拠点の倉庫 */
export const STORAGE_KINDS: ReadonlySet<ObjKind> = new Set<ObjKind>(['chest', 'stash']);

/** 時刻（分）を計算：サイクル開始は 06:00 */
export function cycleToMinute(cycleT: number): number {
  if (cycleT < DAY_SECONDS) return 360 + (cycleT * 840) / DAY_SECONDS;
  return (1200 + ((cycleT - DAY_SECONDS) * 600) / NIGHT_SECONDS) % 1440;
}

const STOVE_KINDS: ReadonlySet<ObjKind> = new Set<ObjKind>(['stove']);
const BUILD_RANGE_PX = 6 * TILE + 20;

/** 大群の夜が来る日（4日ごと） */
export const isHordeDay = (day: number): boolean => day % 4 === 0;

/** 拠点の敷地内か（安全地帯） */
export function inBase(x: number, y: number): boolean {
  const sh = SAFEHOUSE;
  return x > sh.x * TILE && y > sh.y * TILE && x < (sh.x + sh.w) * TILE && y < (sh.y + sh.h) * TILE;
}

// ---------------- 物資テーブル [アイテム, 重み, 最小, 最大] ----------------
type LootRow = [ItemId | 'weapon' | 'attach', number, number, number];
const LOOT: Partial<Record<ObjKind, LootRow[]>> = {
  // 序盤の詰まりを減らす：棚・机・木箱・車からも少し弾と包帯が出る。食料は出すぎないように控えめ
  shelf: [['can', 4, 1, 2], ['cloth', 3, 1, 3], ['scrap', 3, 1, 3], ['bandage', 1.7, 1, 1], ['ammo9', 2.4, 5, 12], ['gunpowder', 1, 1, 1], ['valuables', 0.5, 1, 1], ['tools', 0.15, 1, 1]],
  fridge: [['can', 4.5, 1, 2], ['mre', 1, 1, 1]],
  cabinet: [['bandage', 5, 1, 2], ['chem', 4, 1, 2], ['medkit', 1.2, 1, 1], ['cloth', 2, 1, 2], ['stim', 0.35, 1, 1]],
  locker: [['ammo9', 4, 6, 14], ['cloth', 2, 1, 3], ['bandage', 2, 1, 1], ['parts', 1, 1, 1], ['valuables', 1, 1, 1], ['shells', 1, 2, 5], ['ammo9ap', 0.6, 4, 10], ['holo', 0.2, 1, 1]],
  desk: [['valuables', 3, 1, 2], ['electronics', 2, 1, 1], ['ammo9', 2.8, 4, 9], ['gunpowder', 1, 1, 2], ['chem', 1, 1, 1], ['bandage', 0.6, 1, 1]],
  crate: [['scrap', 5, 2, 5], ['gunpowder', 3, 1, 2], ['parts', 1, 1, 1], ['cloth', 2, 1, 3], ['can', 0.8, 1, 1], ['tools', 0.35, 1, 1], ['ammo9', 1, 4, 8], ['shells', 0.5, 2, 4]],
  car: [['scrap', 5, 2, 4], ['gunpowder', 2, 1, 2], ['electronics', 1.2, 1, 1], ['can', 0.8, 1, 1], ['valuables', 0.6, 1, 1], ['tools', 0.3, 1, 1], ['ammo9', 1.1, 3, 8], ['bandage', 0.7, 1, 1], ['shells', 0.4, 2, 5]],
  wcase: [['ammo762', 4, 8, 20], ['ammo9', 3, 10, 20], ['shells', 3, 4, 8], ['weapon', 2, 1, 1], ['attach', 1.5, 1, 1], ['parts', 2, 1, 2], ['ammo762ap', 1, 5, 12], ['slug', 0.8, 3, 6]],
  mcrate: [['ammo762', 5, 10, 25], ['shells', 3, 6, 12], ['mre', 2, 1, 2], ['medkit', 2, 1, 1], ['parts', 3, 1, 2], ['attach', 1.2, 1, 1], ['weapon', 0.8, 1, 1], ['ammo762ap', 1.5, 6, 14], ['stim', 0.6, 1, 1], ['tools', 0.6, 1, 1]],
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
    // 初日の天候はランダム（霧で始まることもある）
    if (Math.random() < 0.3) this.setWeather(Math.random() < 0.5 ? 'fog' : 'rain', true);
    this.events.push({ k: 'banner', t: 'DAY 1', s: '建物を漁って物資を集め、生きて拠点に持ち帰れ', c: '#e0cfa8', snd: 'day' });
  }

  /** スキルを反映（最大スタミナ・回復速度） */
  private applySkills(p: SimPlayer): void {
    const m = skillMods(p.xp);
    p.stmMax = m.staminaMax;
    p.stmRegen = m.staminaRegenMul * (p.stimT > 0 ? 1.8 : 1) * ((p.rested ?? 0) > 0 ? 1.35 : 1);
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
      })),
      extra: this.saveExtra(),
    };
  }

  /** 追加の保存項目（拡張用） */
  protected saveExtra(): Record<string, unknown> {
    return {};
  }

  /** セーブから再開：同じシードで世界を作り直し、変化と状態を戻す。ロビーの各スロットに保存された人を割り当てる */
  static fromSave(lobby: LobbyPlayer[], data: SaveData): HostSimulation {
    const sim = new HostSimulation(lobby, data.seed);
    sim.events = [];
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
    sim.nextObjId = Math.max(sim.nextObjId, data.nextObjId);
    sim.setWeather(data.weather, true);
    for (const p of sim.players) {
      const s = data.players.find((q) => q.id === p.id);
      if (!s) continue;
      Object.assign(p, { x: s.x, y: s.y, hp: s.hp, maxHp: s.maxHp, hunger: s.hunger, tox: s.tox, bag: s.bag, prim: s.prim, sec: s.sec, tool: s.tool, kills: s.kills });
      p.xp = p.xp.map((v, i) => Math.max(v, s.xp[i] ?? 0));
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
  private trySleep(p: SimPlayer): void {
    if (p.status !== 'alive') return;
    const m = this.minute();
    if (!(m >= 20 * 60 || m < 5 * 60)) return this.pop(p, '眠れるのは夜（20:00〜05:00）だけ', '#cccccc');
    if (this.hordeNight) return this.pop(p, '大群の夜は眠れない！', '#e0583e');
    if (this.zombies.some((z) => !z.dead && z.state === 'chase' && Math.hypot(z.x - p.x, z.y - p.y) < 700)) return this.pop(p, '近くに敵がいて眠れない', '#e0583e');
    p.sleeping = true;
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
      players: this.players.map((p) => ({
        id: p.id,
        name: p.name,
        ...(p.away ? { away: true } : {}),
        ...(p.sleeping ? { sleeping: true } : {}),
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
    this.time += dt;
    this.tick++;
    this.updateClock(dt);
    this.updateBuilds(dt);
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

    if (this.players.length > 0 && !this.players.some((p) => p.status === 'alive' || p.status === 'down')) {
      this.gameOver = true;
      this.result = {
        day: this.day,
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
      if (isHordeDay(this.day)) {
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
        p.x = cx - 50;
        p.y = cy - 30;
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
    for (const f of p.queue) {
      // 眠っている人は、動く・撃つ・ダッシュで目を覚ます
      if (p.sleeping) {
        if (Math.hypot(f.mx, f.my) > 0.1 || f.fire || f.dash) this.wake(p, '目を覚ました');
        else continue;
      }
      const px = p.x;
      const py = p.y;
      const dashing = p.dashTime > 0;
      stepMovement(p, f, f.dt, p.status, this.world);
      if (!dashing && p.dashTime > 0) this.gainXp(p, 1, 1.5);
      if (p.status === 'alive' && p.dashTime > 0) p.stepNoiseT += f.dt * 3;
      else if (Math.hypot(p.x - px, p.y - py) > 0.5) p.stepNoiseT += f.dt;
      p.ack = f.seq;
      p.aim = f.aim;
      p.fire = f.fire;
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
    const resting = Math.hypot(p.x - cfx, p.y - cfy) < 170;
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
    if (p.viewing) {
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
      const spread = w.spread + p.heat;
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
    if (cfd < 170) {
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
    removeItem(p.bag, id, 1);
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
        if (left === s.n) return this.pop(p, 'バックパックがいっぱい', '#c87a6a');
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
        if (c.some((s) => s)) this.pop(p, 'バックパックがいっぱい', '#c87a6a');
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
          if (p.hp >= p.maxHp && !(cleans && p.tox > 0)) return this.pop(p, 'HPは満タン', '#cccccc');
          this.heal(p, s.id);
        } else if (isWeapon(s.id)) this.equip(p, n(a));
        break;
      }
      case 'equip':
        this.equip(p, n(a));
        break;
      case 'unequip': {
        const key = a === 'prim' ? 'prim' : 'sec';
        const s = p[key];
        if (!s) return;
        if (freeSlots(p.bag) <= 0) return this.pop(p, 'バックパックがいっぱい', '#c87a6a');
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
          if (left === s.n) return this.pop(p, 'バックパックがいっぱい', '#c87a6a');
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
        if (left > 0) return this.pop(p, 'バックパックがいっぱい', '#c87a6a');
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
          if (addItem(p.bag, att, 1) > 0) return this.pop(p, 'バックパックがいっぱい', '#c87a6a');
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
    this.gainXp(p, 2, 2);
    this.makeNoise((tx + 0.5) * TILE, (ty + 0.5) * TILE, 120, false);
  }

  /** 建てた物を撤去：素材の半分が戻る */
  private unbuild(p: SimPlayer, id: number): void {
    const o = this.world.objects.get(id);
    if (!o || !BUILD_KINDS.has(o.kind) || p.status !== 'alive') return;
    if (Math.hypot((o.tx + 0.5) * TILE - p.x, (o.ty + 0.5) * TILE - p.y) > BUILD_RANGE_PX) return this.pop(p, '遠すぎる', '#c87a6a', 'error');
    const def = buildDef(o.kind)!;
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
          (o.kind === 'bed' && inBase((o.tx + 0.5) * TILE, (o.ty + 0.5) * TILE)) ||
          (BUILD_KINDS.has(o.kind) && (o.hp < o.maxHp || (o.kind === 'raintank' && o.ready > 0)));
        if (!usable) continue;
        const d = Math.hypot((o.tx + 0.5) * TILE - p.x, (o.ty + 0.5) * TILE - p.y) - (o.kind === 'door' ? 0 : 6);
        if (d < bd) {
          bd = d;
          best = o;
        }
      }
    if (best && best.kind === 'bed') {
      this.trySleep(p);
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
    }
    p.viewing = o.id;
  }

  private tierAt(tx: number, ty: number): number {
    const loc = locationAt(this.world.locations, tx, ty);
    if (loc) return loc.kind === 'base' ? 0 : loc.tier;
    return tierAtDistance(Math.hypot(tx - BASE_TX, ty - BASE_TY));
  }

  /** 入れ物の中身を生成（遠く危険な場所ほど多く・レアに） */
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
        addItem(out, wid, 1, { mag: Math.floor(WEAPON_STATS[wid].magSize * R()) });
      } else if (id === 'attach') {
        // 危険な場所ほどレアなアタッチメント（スコープ・サプレッサー）が出やすい
        const pool: ItemId[] = tier >= 3 ? ['scope', 'suppressor', 'holo', 'extmag', 'grip', 'scope', 'suppressor'] : ['holo', 'extmag', 'grip', 'holo', 'suppressor', 'scope'];
        addItem(out, pool[Math.floor(R() * pool.length)], 1);
      } else {
        addItem(out, id, min + Math.floor(R() * (max - min + 1)));
      }
    }
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
    p.hp -= dmg;
    p.search = null; // 攻撃されたら探索は中断
    this.events.push({ k: 'phit', id: p.id });
    this.events.push({ k: 'dmg', x: p.x, y: p.y - 20, v: Math.round(dmg), p: true });
    if (p.hp <= 0) this.downPlayer(p);
  }

  private downPlayer(p: SimPlayer): void {
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

  private typeForTier(tier: number): ZombieType {
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
    const per = (this.phase === 'night' ? 1.4 : 0.9) + this.day * 0.05 + (this.weather === 'storm' ? 0.4 : 0);
    const want = Math.round(this.stats.active * per);
    if (outdoor < want) this.spawnOutdoor(650);
  }

  private spawnZombie(type: ZombieType, x: number, y: number): SimZombie {
    // 汚染地帯の個体は少し手強い
    const loc = locationAt(this.world.locations, Math.floor(x / TILE), Math.floor(y / TILE));
    const elite = loc?.hot ? 1.3 : 1;
    const hp = ZOMBIE[type].hp * (1 + 0.06 * (this.day - 1)) * elite;
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
      speedMul: 0.85 + Math.random() * 0.3,
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
    const total = Math.min(48, 10 + this.day * 2);
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
      this.damagePlayer(near.p, st.damage);
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
