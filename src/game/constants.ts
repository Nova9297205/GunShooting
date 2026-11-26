import type { EnemyType, Rect, Vec2 } from '../types';

// ---------------- ワールド / 通信 ----------------
export const WORLD_W = 2400;
export const WORLD_H = 1600;

export const TICK_RATE = 60;
export const TICK_DT = 1 / TICK_RATE;
/** 何tickごとにスナップショットを送るか（60/2 = 30Hz ≒ 33ms） */
export const SNAPSHOT_EVERY = 2;
/** ゲスト側の補間遅延（秒） */
export const INTERP_DELAY = 0.1;
export const MAX_PLAYERS = 3;

export const PLAYER_COLORS = ['#4da3ff', '#5be37d', '#ffd84d'];

// ---------------- プレイヤー ----------------
export const PLAYER = {
  radius: 16,
  speed: 250,
  downSpeed: 35,
  maxHp: 100,
  dashSpeed: 760,
  dashTime: 0.16,
  dashCooldown: 1.2,
  fireInterval: 0.1,
  bulletSpeed: 950,
  bulletDamage: 10,
  bulletLife: 0.8,
  bulletRadius: 4,
  spread: 0.045,
  muzzle: 28,
  downTime: 30,
  reviveTime: 2.5,
  reviveRange: 64,
  reviveHpRatio: 0.5,
  waveHeal: 25,
};

// ---------------- 敵 ----------------
export interface EnemyStats {
  radius: number;
  hp: number;
  speed: number;
  damage: number;
  color: string;
  knockResist: number;
}

export const ENEMY: Record<EnemyType, EnemyStats> = {
  chaser: { radius: 14, hp: 30, speed: 160, damage: 12, color: '#ff4d5e', knockResist: 1 },
  shooter: { radius: 15, hp: 24, speed: 115, damage: 9, color: '#b06bff', knockResist: 1 },
  tank: { radius: 30, hp: 220, speed: 62, damage: 25, color: '#ff9a3d', knockResist: 0.15 },
};

export const SHOOTER = {
  fireInterval: 1.7,
  bulletSpeed: 400,
  bulletRadius: 6,
  bulletLife: 3,
  preferMin: 260,
  preferMax: 380,
  range: 700,
};

export const TANK_EXPLOSION = {
  radius: 170,
  force: 750,
  damage: 30,
};

// ---------------- マップ（遮蔽物） ----------------
export const OBSTACLES: Rect[] = [
  // 中央を囲む壁
  { x: 1000, y: 450, w: 400, h: 50 },
  { x: 1000, y: 1100, w: 400, h: 50 },
  { x: 850, y: 700, w: 50, h: 200 },
  { x: 1500, y: 700, w: 50, h: 200 },
  // 四隅寄りの L 字的な遮蔽
  { x: 500, y: 300, w: 220, h: 60 },
  { x: 300, y: 600, w: 60, h: 300 },
  { x: 1680, y: 300, w: 220, h: 60 },
  { x: 2040, y: 600, w: 60, h: 300 },
  { x: 500, y: 1240, w: 220, h: 60 },
  { x: 1680, y: 1240, w: 220, h: 60 },
  // コンテナ
  { x: 150, y: 150, w: 80, h: 80 },
  { x: 2170, y: 150, w: 80, h: 80 },
  { x: 150, y: 1370, w: 80, h: 80 },
  { x: 2170, y: 1370, w: 80, h: 80 },
  { x: 1150, y: 200, w: 100, h: 100 },
  { x: 1150, y: 1300, w: 100, h: 100 },
  { x: 620, y: 760, w: 70, h: 70 },
  { x: 1710, y: 760, w: 70, h: 70 },
];

export const PLAYER_SPAWNS: Vec2[] = [
  { x: 1200, y: 800 },
  { x: 1140, y: 860 },
  { x: 1260, y: 860 },
];
