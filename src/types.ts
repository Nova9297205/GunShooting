// ============================================================
// 共通型定義（プレイヤー・敵・弾・通信パケット）
// ============================================================

export interface Vec2 {
  x: number;
  y: number;
}

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export type PlayerStatus = 'alive' | 'down' | 'dead';
export type EnemyType = 'chaser' | 'shooter' | 'tank';
export type Phase = 'intermission' | 'combat' | 'gameover';
export type GameMode = 'solo' | 'host' | 'guest';

/** 1フレーム分の操作入力（ゲスト→ホストへ送信される） */
export interface InputFrame {
  /** 連番。ホストが処理済みの番号を ack として返し、ゲストはそれ以降を再適用（リコンシリエーション）する */
  seq: number;
  /** このフレームの経過秒 */
  dt: number;
  /** 移動ベクトル (-1..1) */
  mx: number;
  my: number;
  /** 照準角度 (rad) */
  aim: number;
  shoot: boolean;
  revive: boolean;
  /** ダッシュキーが押された瞬間のみ true */
  dash: boolean;
}

/** 移動計算に必要な状態（ホストとゲスト予測で共通利用） */
export interface MoveBody {
  x: number;
  y: number;
  bodyAngle: number;
  dashTime: number;
  dashCd: number;
  dashDx: number;
  dashDy: number;
}

export interface PlayerSnap extends MoveBody {
  id: number;
  name: string;
  aim: number;
  hp: number;
  maxHp: number;
  status: PlayerStatus;
  downTimer: number;
  reviveProgress: number;
  shots: number;
  kills: number;
  /** ホストが処理した最後の入力 seq */
  ack: number;
}

export interface EnemySnap {
  id: number;
  type: EnemyType;
  x: number;
  y: number;
  angle: number;
  hp: number;
  maxHp: number;
  flash: number;
}

export interface BulletSnap {
  id: number;
  /** p = プレイヤー弾, e = 敵弾 */
  team: 'p' | 'e';
  owner: number;
  x: number;
  y: number;
  vx: number;
  vy: number;
}

/** 一度きりの演出イベント（パーティクル・ダメージ数値など） */
export type GameEvent =
  | { k: 'hit'; x: number; y: number; c: string; o: number }
  | { k: 'wall'; x: number; y: number; o: number }
  | { k: 'dmg'; x: number; y: number; v: number; p: boolean }
  | { k: 'kill'; x: number; y: number; c: string; r: number }
  | { k: 'boom'; x: number; y: number; r: number }
  | { k: 'phit'; id: number }
  | { k: 'down'; id: number; x: number; y: number }
  | { k: 'revive'; id: number; x: number; y: number }
  | { k: 'dead'; id: number }
  | { k: 'wave'; n: number }
  | { k: 'clear'; n: number }
  | { k: 'eshot'; x: number; y: number; a: number };

/** 描画に必要なワールドの状態 */
export interface ViewState {
  time: number;
  tick: number;
  phase: Phase;
  wave: number;
  phaseTimer: number;
  enemiesLeft: number;
  players: PlayerSnap[];
  enemies: EnemySnap[];
  bullets: BulletSnap[];
}

/** ホスト→ゲストへ約30Hzで送るスナップショット */
export interface Snapshot extends ViewState {
  events: GameEvent[];
}

export interface LobbyPlayer {
  id: number; // = スロット番号 (0: ホスト, 1-2: ゲスト)
  name: string;
}

export interface GameResult {
  wave: number;
  players: { id: number; name: string; kills: number }[];
}

// ---------------- 通信パケット ----------------

export type GuestMessage = { type: 'input'; f: InputFrame };

export type HostMessage =
  | { type: 'welcome'; slot: number; players: LobbyPlayer[] }
  | { type: 'reject'; reason: string }
  | { type: 'lobby'; players: LobbyPlayer[] }
  | { type: 'start'; players: LobbyPlayer[] }
  | { type: 'snap'; s: Snapshot }
  | { type: 'gameover'; result: GameResult };
