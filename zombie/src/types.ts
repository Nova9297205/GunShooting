// ============================================================
// 共通型定義（プレイヤー・ゾンビ・弾・オブジェクト・通信パケット）
// ============================================================

export interface Vec2 {
  x: number;
  y: number;
}

export type PlayerStatus = 'alive' | 'down' | 'dead';
export type ZombieType = 'walker' | 'runner' | 'brute';
export type TimePhase = 'day' | 'night' | 'horde';
export type GameMode = 'solo' | 'host' | 'guest';

/** マップ上のオブジェクト種別（資源・設備・建築物） */
export type ObjKind =
  | 'tree'
  | 'car'
  | 'crate'
  | 'box'
  | 'campfire'
  | 'stone'
  | 'woodWall'
  | 'ironWall'
  | 'spike'
  | 'torch'
  | 'mcrate'
  | 'bench'
  | 'barbed'
  | 'turret'
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
  | 'stash';

export type BuildKind = 'woodWall' | 'ironWall' | 'spike' | 'torch' | 'barbed' | 'turret';

/** ホットバーのスロット番号（キー 1〜9 に対応） */
export const Tool = {
  Melee: 0,
  Gun: 1,
  Shotgun: 2,
  Build: 3,
  Food: 4,
  Medkit: 5,
} as const;

/** 武器の種類（射撃系） */
export type WeaponId = 'pistol' | 'rifle' | 'shotgun';

/** 1フレーム分の操作入力（ゲスト→ホストへ送信） */
export interface InputFrame {
  seq: number;
  dt: number;
  mx: number;
  my: number;
  aim: number;
  /** 左クリック押しっぱなし（射撃 / 近接 / 建築 / 修理） */
  fire: boolean;
  /** E 長押し（蘇生） */
  revive: boolean;
  /** 以下は押した瞬間のみ true */
  dash: boolean;
  interact: boolean;
  reload: boolean;
  /** クラフトするレシピID（なければ空文字） */
  craft: string;
  eat: boolean;
  heal: boolean;
  /** 選択中のスロット (Tool.*) */
  tool: number;
  /** 建築ツールで選んでいる設計図の番号（BLUEPRINTS のインデックス） */
  bp: number;
  /** 右クリック押しっぱなし（建築ツールでは修理） */
  alt: boolean;
  /** G キー：マウス位置にピンを立てる（押した瞬間のみ） */
  ping: boolean;
  /** 共有チェストの操作（例 "d:ammo:10" = 預ける / "w:ammo:10" = 受け取る、なければ空文字） */
  chest: string;
  /** マウスが指しているタイル座標（建築・修理対象） */
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
}

export interface Inventory {
  /** 予備弾薬（拳銃・ライフル共通） */
  ammo: number;
  /** 拳銃/ライフルのマガジン内の弾 */
  mag: number;
  /** 予備のショットガンシェル */
  shells: number;
  /** ショットガンの装填数 */
  smag: number;
  /** 銃のランク：0=拳銃 1=アサルトライフル */
  gun: number;
  /** ショットガン所持 0/1 */
  shotgun: number;
  /** 布・薬草・武器パーツ（クラフト素材） */
  cloth: number;
  herb: number;
  parts: number;
  /** タレットキット（クラフトして設置） */
  kit: number;
  /** 斧のランク：0=斧 1=鋼の斧 */
  axe: number;
  gunpowder: number;
  food: number;
  medkit: number;
}

export interface PlayerSnap extends MoveBody {
  id: number;
  name: string;
  aim: number;
  hp: number;
  maxHp: number;
  hunger: number;
  status: PlayerStatus;
  downTimer: number;
  reviveProgress: number;
  tool: number;
  inv: Inventory;
  reloadT: number;
  shots: number;
  swings: number;
  kills: number;
  builds: number;
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
  horde: boolean;
  /** 攻撃回数カウンタ（攻撃モーション用） */
  atk: number;
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
  /** クレート/収納箱: 1=物資あり 0=回収済み ／ タレット: 残弾数 */
  ready: number;
}

export interface Stash {
  wood: number;
  scrap: number;
}

/** イベントに付ける効果音の種類 */
export type SoundKey = 'loot' | 'eat' | 'heal' | 'craft' | 'error' | 'day' | 'night' | 'horde' | 'clear';

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
  | { k: 'break'; x: number; y: number; kind: ObjKind }
  | { k: 'pop'; x: number; y: number; t: string; c: string; id: number; s?: SoundKey }
  | { k: 'banner'; t: string; s: string; c: string; snd?: SoundKey }
  | { k: 'burn'; x: number; y: number }
  | { k: 'noise'; x: number; y: number; r: number }
  | { k: 'tshot'; x: number; y: number; a: number; id: number }
  | { k: 'ping'; id: number; x: number; y: number; t: 'enemy' | 'loot' | 'go' }
  | { k: 'door'; x: number; y: number; open: boolean };

/** 描画に必要なワールドの状態（オブジェクトは TileWorld 側で保持） */
export interface ViewState {
  time: number;
  tick: number;
  day: number;
  /** その日の時刻（分, 0..1439） */
  minute: number;
  phase: TimePhase;
  stash: Stash;
  /** 拠点の共有チェストの中身 */
  chest: Record<string, number>;
  hordeLeft: number;
  players: PlayerSnap[];
  zombies: ZombieSnap[];
  bullets: BulletSnap[];
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
}

/** ゲーム開始時の初期情報 */
export interface StartInfo {
  players: LobbyPlayer[];
  seed: number;
  objs: ObjSnap[];
}

export interface GameResult {
  day: number;
  players: { id: number; name: string; kills: number; builds: number }[];
}

// ---------------- 通信パケット ----------------

export type GuestMessage = { type: 'hello'; name: string } | { type: 'input'; f: InputFrame };

export type HostMessage =
  | { type: 'welcome'; slot: number; players: LobbyPlayer[] }
  | { type: 'reject'; reason: string }
  | { type: 'lobby'; players: LobbyPlayer[] }
  | { type: 'start'; info: StartInfo }
  | { type: 'snap'; s: Snapshot }
  | { type: 'gameover'; result: GameResult };
