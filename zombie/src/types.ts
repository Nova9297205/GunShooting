// ============================================================
// 共通型定義（プレイヤー・ゾンビ・弾・オブジェクト・通信パケット）
// ============================================================
import type { ItemId, Slot } from './game/items';
import type { Facility, Profile } from './game/progression';

export type { Slot, WeaponId } from './game/items';

export interface Vec2 {
  x: number;
  y: number;
}

export type PlayerStatus = 'alive' | 'down' | 'dead';
/** walker=徘徊型 / runner=俊敏型 / brute=重装型 / soldier=感染兵士 */
export type ZombieType = 'walker' | 'runner' | 'brute' | 'soldier' | 'bloater' | 'screamer' | 'titan' | 'crawler' | 'spitter';
export type TimePhase = 'day' | 'night';
export type GameMode = 'solo' | 'host' | 'guest';
/** 遊び方：30 日目に救助が来る／期限なし（無線を直して自分で呼ぶ） */
export type RunMode = 'd30' | 'endless';

/** 救助の進み具合 */
export interface RescueSnap {
  mode: RunMode;
  /** 0 = 部品集め・1 = 修理待ち・2 = 呼べる・3 = 呼んだ（救助を待つ） */
  stage: number;
  /** 取り付けた部品（ビット 1,2,4） */
  parts: number;
  /** 救助が来る日（その日の朝） */
  day?: number;
  /** 脅威の段階（0〜3） */
  threat?: number;
}

/** マップ上のオブジェクト種別（設備・家具・入れ物・ドアなど） */
export type ObjKind =
  | 'safe'
  | 'barrel'
  | 'tree'
  | 'car'
  | 'crate'
  | 'box'
  | 'campfire'
  | 'mcrate'
  | 'bench'
  | 'chest'
  | 'door'
  | 'shelf'
  | 'cabinet'
  | 'locker'
  | 'wcase'
  | 'fridge'
  | 'desk'
  | 'bed'
  | 'rubble'
  | 'sandbag'
  | 'stash'
  | 'bag'
  | 'drop'
  // 拠点の無線機（依頼の報告）
  | 'radio'
  // 拠点に建てる物
  | 'raintank'
  | 'stove'
  // どこでも建てられる拠点の設備
  | 'cot'
  | 'wbench'
  | 'sbox'
  | 'fire'
  // 以下は旧バージョンの建築物（描画コードの互換用）
  | 'stone'
  | 'woodWall'
  | 'ironWall'
  | 'spike'
  | 'torch'
  | 'barbed'
  | 'turret';

/** ホットバーのスロット番号（キー 1〜5 に対応） */
export const Tool = {
  Melee: 0,
  Primary: 1,
  Secondary: 2,
  Meds: 3,
  Food: 4,
} as const;

/** 1フレーム分の操作入力（ゲスト→ホストへ送信） */
export interface InputFrame {
  seq: number;
  dt: number;
  mx: number;
  my: number;
  aim: number;
  /** 左クリック押しっぱなし（攻撃・使用） */
  fire: boolean;
  /** E 長押し（蘇生） */
  revive: boolean;
  /** 以下は押した瞬間のみ true */
  dash: boolean;
  interact: boolean;
  reload: boolean;
  eat: boolean;
  heal: boolean;
  ping: boolean;
  /** クラフトするレシピID（なければ空文字） */
  craft: string;
  /** インベントリ操作（例 "take:12:3" / "use:5" / "equip:2"、なければ空文字） */
  op: string;
  /** 選択中のスロット (Tool.*) */
  tool: number;
  /** マウスが指しているタイル座標 */
  tx: number;
  ty: number;
}

export interface MoveBody {
  x: number;
  y: number;
  bodyAngle: number;
  dashTime: number;
  dashCd: number;
  dashDx: number;
  dashDy: number;
  /** スタミナ（ダッシュ・近接で消費） */
  stamina: number;
  /** スタミナ回復が始まるまでの待ち時間 */
  staminaDelay: number;
  /** 最大スタミナ（持久力スキル） */
  stmMax?: number;
  /** スタミナ回復倍率（持久力スキル・興奮剤） */
  stmRegen?: number;
  /** 歩く速さの倍率（骨折・疲労） */
  spdMul?: number;
  /** ダッシュできない（骨折） */
  noDash?: boolean;
}

export interface PlayerSnap extends MoveBody {
  id: number;
  name: string;
  /** 通信が切れて再接続を待っている（その間はゾンビに狙われない） */
  away?: boolean;
  /** 拠点のベッドで眠っている */
  sleeping?: boolean;
  /** 体調：疲労 0..100（眠ると 0）・冷え 0..100・出血・骨折（1 = 未処置、2 = 添え木で治りかけ） */
  fatigue?: number;
  cold?: number;
  bleed?: boolean;
  frac?: number;
  /** 寝床（最後に眠った所。戦闘不能から朝に戻る場所） */
  home?: { x: number; y: number };
  /** はじめの一日：達成したステップ（ビット） */
  tut?: number;
  /** 背負っているリュック（バッグのマスと重さが増える） */
  pack?: ItemId;
  /** 装備している近接武器（耐久は w.mag に入れる） */
  mel?: Slot;
  /** 乗っている車の ID と座席（0 = 運転席） */
  veh?: number;
  seat?: number;
  /** 休息済み（眠った・焚き火で食事した）の残り秒数 */
  rested?: number;
  aim: number;
  hp: number;
  maxHp: number;
  hunger: number;
  status: PlayerStatus;
  downTimer: number;
  reviveProgress: number;
  tool: number;
  /** バックパック（16マス） */
  bag: (Slot | null)[];
  /** メイン武器 / サブ武器（ハンドガン） */
  prim: Slot | null;
  sec: Slot | null;
  reloadT: number;
  shots: number;
  swings: number;
  kills: number;
  /** 探索中のコンテナIDと進捗(0..1) */
  searchId: number;
  searchP: number;
  /** 中身を見ているコンテナID（0 = なし） */
  viewing: number;
  /** 拠点の倉庫を開いているか */
  storage: number;
  /** スキル経験値 [探索, 持久力, 銃の扱い, 応急処置] */
  xp: number[];
  /** 連射で溜まる反動（ばらつきに加算） */
  heat: number;
  /** 汚染度 0..100（外縁の汚染帯・汚染地帯で上がる） */
  tox: number;
  ack: number;
}

export interface ZombieSnap {
  id: number;
  type: ZombieType;
  x: number;
  y: number;
  angle: number;
  hp: number;
  maxHp: number;
  flash: number;
  /** 0=徘徊 1=物音を調べている 2=追跡中 */
  alert: number;
  /** 攻撃回数カウンタ（攻撃モーション用） */
  atk: number;
  /** 精鋭（手強く、良い戦利品を落とす） */
  elite?: boolean;
  /** 精鋭の特性：突進・再生・分裂・重装 */
  trait?: 'dash' | 'regen' | 'split' | 'armor';
  /** 予備動作（1 = 巨像の突進・2 = 巨像の地鳴り・3 = 這う者の噛みつき・4 = 酸を吐く者の構え） */
  tele?: number;
}

export interface BulletSnap {
  id: number;
  owner: number;
  x: number;
  y: number;
  vx: number;
  vy: number;
}

/** マップオブジェクト（変化があったものだけ差分で同期） */
export interface ObjSnap {
  id: number;
  kind: ObjKind;
  tx: number;
  ty: number;
  hp: number;
  maxHp: number;
  /** ドア: 1=開 0=閉 ／ 入れ物: 1=未探索 0=探索済み */
  ready: number;
}

/** イベントに付ける効果音の種類 */
export type SoundKey = 'loot' | 'eat' | 'heal' | 'craft' | 'error' | 'day' | 'night' | 'horde' | 'clear' | 'level' | 'alarm';

/** イベントログの重要度（色分け） */
export type FeedCat = 'danger' | 'loot' | 'up' | 'ally' | 'info';

/** 天候 */
export type Weather = 'clear' | 'fog' | 'rain' | 'storm';

/** 一度きりの演出イベント */
export type GameEvent =
  | { k: 'hit'; x: number; y: number; o: number; a: number; m?: number }
  | { k: 'wall'; x: number; y: number; o: number }
  | { k: 'dmg'; x: number; y: number; v: number; p: boolean }
  | { k: 'kill'; x: number; y: number; r: number; o: number; t: ZombieType; id: number; a: number; dx: number; dy: number }
  | { k: 'phit'; id: number }
  | { k: 'down'; id: number; x: number; y: number }
  | { k: 'revive'; id: number; x: number; y: number }
  | { k: 'dead'; id: number }
  | { k: 'chop'; x: number; y: number; kind: ObjKind }
  | { k: 'build'; x: number; y: number; kind: ObjKind }
  | { k: 'smash'; x: number; y: number; kind: ObjKind }
  /** 車：ゾンビを轢いた・ぶつかった */
  | { k: 'crash'; x: number; y: number; hard: number }
  /** 依頼を達成した */
  | { k: 'job'; t: string; lvUp?: number }
  /** 拠点に建てた・修理した */
  | { k: 'built'; x: number; y: number; kind: ObjKind; id: number; repair?: boolean }
  | { k: 'break'; x: number; y: number; kind: ObjKind }
  | { k: 'pop'; x: number; y: number; t: string; c: string; id: number; s?: SoundKey }
  | { k: 'banner'; t: string; s: string; c: string; snd?: SoundKey }
  | { k: 'burn'; x: number; y: number }
  | { k: 'noise'; x: number; y: number; r: number }
  | { k: 'tshot'; x: number; y: number; a: number; id: number }
  | { k: 'ping'; id: number; x: number; y: number; t: 'enemy' | 'loot' | 'go' }
  | { k: 'door'; x: number; y: number; open: boolean }
  | { k: 'search'; id: number; x: number; y: number; done: boolean }
  | { k: 'alert'; x: number; y: number }
  /** 画面左のイベントログ（仲間のダウン・スキル上昇・補給物資など） */
  | { k: 'feed'; t: string; c: string; id?: number; snd?: SoundKey; cat?: FeedCat }
  /** 弾が装甲に弾かれた */
  | { k: 'ricochet'; x: number; y: number }
  /** 膨張体が破裂して毒ガスを撒いた */
  | { k: 'gas'; x: number; y: number }
  /** 叫び屋が叫んだ（周りのゾンビが集まる） */
  | { k: 'scream'; x: number; y: number }
  /** ドラム缶の爆発 */
  | { k: 'boom'; x: number; y: number }
  /** 全員が眠って朝まで時間が進んだ（画面を暗転） */
  | { k: 'sleep' };

/** 描画に必要なワールドの状態（オブジェクトは TileWorld 側で保持） */
export interface ViewState {
  /** 大群の夜 */
  horde?: boolean;
  time: number;
  tick: number;
  day: number;
  /** その日の時刻（分, 0..1439） */
  minute: number;
  phase: TimePhase;
  players: PlayerSnap[];
  zombies: ZombieSnap[];
  bullets: BulletSnap[];
  /** 誰かが中身を見ているコンテナの中身 */
  cont: Record<number, (Slot | null)[]>;
  /** 拠点の倉庫（共有倉庫と各プレイヤーの個人倉庫）。変化したときだけ届く */
  storage?: StorageState;
  weather: Weather;
  /** 天候の強さ 0..1（切り替わりをなめらかにする） */
  wx: number;
  /** 拠点設備のレベル */
  base: Record<Facility, number>;
  /** 補給物資の投下地点（なければ null） */
  drop: { x: number; y: number } | null;
  /** 無線の依頼（その日の分） */
  jobs?: Job[];
  /** 車両 */
  vehicles?: VehicleSnap[];
  /** 異変（特定の場所のイベント） */
  sites?: SiteSnap[];
  /** 救助の進み具合（モード） */
  rescue?: RescueSnap;
  /** 冬（雪・足跡） */
  winter?: boolean;
  /** 酸だまり（地面）と、飛んでいる酸 */
  acid?: { x: number; y: number; r: number; t: number }[];
  spits?: { sx: number; sy: number; tx: number; ty: number; p: number }[];
  /** 無線の信頼度：達成した依頼の数とレベル */
  radio?: { done: number; lv: number };
}

/** 異変：墜落したヘリ・感染体の巣・封鎖された武器庫。見張りを倒して箱を開けると制圧 */
export interface SiteSnap {
  id: number;
  kind: 'heli' | 'nest' | 'armory' | 'tower';
  name: string;
  tx: number;
  ty: number;
  crate: number;
  done?: boolean;
}

/** 車両 */
export interface VehicleSnap {
  id: number;
  kind: 'sedan' | 'pickup';
  x: number;
  y: number;
  /** 向き（rad） */
  a: number;
  /** 速さ（px/秒、マイナスはバック） */
  spd: number;
  /** 燃料 0..100 */
  fuel: number;
  hp: number;
  maxHp: number;
  /** 壊れていて動かない（素材で直す） */
  broken: boolean;
  /** 座席ごとのプレイヤー ID（-1 = 空席）。0 番が運転席 */
  seats: number[];
  /** ホストだけが使う：切り返しの残り時間・ふさがっている時間 */
  revT?: number;
  blockT?: number;
}

/** 無線の依頼 */
export interface Job {
  id: number;
  kind: 'fetch' | 'scout' | 'cache';
  title: string;
  desc: string;
  /** 目的の施設（world.locations の番号） */
  loc: number;
  tx: number;
  ty: number;
  /** 回収する品と数（fetch） */
  item?: ItemId;
  need?: number;
  /** 持っている数（全員の合計・表示用） */
  have?: number;
  /** 危険度 1〜4 */
  tier: number;
  /** 拠点からの距離（m） */
  dist: number;
  day: number;
  /** 目的の物資箱のオブジェクトID */
  crate?: number;
  done?: boolean;
}

export interface StorageState {
  ver: number;
  shared: (Slot | null)[];
  personal: Record<number, (Slot | null)[]>;
}

/** ホスト→ゲストへ約30Hzで送るスナップショット */
export interface Snapshot extends ViewState {
  events: GameEvent[];
  /** 前回から変化したオブジェクト */
  objs: ObjSnap[];
  /** 前回から削除されたオブジェクトID */
  removed: number[];
}

export interface LobbyPlayer {
  id: number; // スロット番号 (0: ホスト, 1-2: ゲスト)
  name: string;
  /** 各自のブラウザに保存されたスキル経験値など */
  prof?: Profile;
}

/** ゲーム開始時の初期情報 */
export interface StartInfo {
  players: LobbyPlayer[];
  seed: number;
  objs: ObjSnap[];
  /** 生成直後から取り除かれたオブジェクト（続きから・再接続のとき） */
  removed?: number[];
}

export interface GameResult {
  day: number;
  /** 救助されてクリア */
  won?: boolean;
  run?: RunMode;
  players: { id: number; name: string; kills: number; value: number; xp: number[] }[];
}

// ---------------- 通信パケット ----------------

/** rejoin：通信が切れたゲストが、同じスロットに戻るための合言葉 */
export type GuestMessage = { type: 'hello'; name: string; prof?: Profile; rejoin?: { slot: number; token: string } } | { type: 'input'; f: InputFrame };

export type HostMessage =
  | { type: 'welcome'; slot: number; players: LobbyPlayer[]; token?: string }
  | { type: 'reject'; reason: string }
  | { type: 'lobby'; players: LobbyPlayer[] }
  | { type: 'start'; info: StartInfo }
  | { type: 'snap'; s: Snapshot }
  | { type: 'gameover'; result: GameResult };
