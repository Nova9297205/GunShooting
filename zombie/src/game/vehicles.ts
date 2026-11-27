// ============================================================
// 車両：直して燃料を入れると運転できる。運転手 1 人＋同乗者 2 人
//   操作は「行きたい方向にスティック（WASD）を倒す」だけ：車はその方向へハンドルを切って加速する。
//   後ろ向きに倒すと U ターン。前がふさがると自動で少しバックして切り返す。
//   壁・車・木にぶつかると止まり、速いほど車が傷む。川（深い所・浅瀬とも）は橋でしか渡れない。
// ============================================================

import type { VehicleSnap } from '../types';
import { TILE, T_SHALLOW, T_WATER } from './constants';
import { moveCircle } from './physics';
import type { TileWorld } from './world';

export const VEHICLE = {
  /** 当たり判定の半径（車体は細長いが、円で近似） */
  radius: 22,
  /** 前進の最高速（px/秒）：歩き 200 の約 3.2 倍（曲がり角・体当たりで実際は 2.5 倍前後） */
  maxSpeed: 650,
  reverseSpeed: 170,
  accel: 440,
  brake: 900,
  /** 走行中の旋回の速さ（rad/秒） */
  turn: 2.4,
  /** 止まっているときの旋回 */
  pivot: 0.9,
  /** 燃料の減り（全開で 1 秒あたり） */
  fuelPerSec: 0.22,
  /** ガソリン缶 1 本で増える燃料 */
  fuelPerCan: 35,
  /** トランクの大きさ */
  trunkSlots: 10,
  /** トランクの中身の ID（入れ物の ID と重ならない範囲） */
  trunkBase: 900000,
  /** 直すのに必要な素材 */
  repairCost: { scrap: 6, parts: 2 } as Record<string, number>,
};

/** 座席の位置（車の中心からの前後・左右のずれ） */
export const SEATS: [number, number][] = [
  [4, -8], // 運転席
  [4, 8], // 助手席
  [-14, 0], // 荷台・後部座席
];

/** 直前のステップで車がぶつかったマス（体当たりで壊す物の判定に使う） */
export const lastCollided: { tx: number; ty: number }[] = [];

export interface VehicleInput {
  mx: number;
  my: number;
}

function angleDiff(a: number, b: number): number {
  return Math.atan2(Math.sin(a - b), Math.cos(a - b));
}

/**
 * 車を1ステップ動かす。ぶつかったら速さ（ぶつかる直前の）を返す（0 なら衝突なし）
 */
export function stepVehicle(v: VehicleSnap, inp: VehicleInput | null, dt: number, world: TileWorld): number {
  const mag = inp ? Math.min(1, Math.hypot(inp.mx, inp.my)) : 0;
  const canDrive = !v.broken && v.fuel > 0 && inp !== null;
  if (canDrive && mag > 0.15) {
    const target = Math.atan2(inp!.my, inp!.mx);
    const d = angleDiff(target, v.a);
    let throttle: number;
    // 前がふさがって切り返し中：ハンドルを切りながら少しバック
    if ((v.revT ?? 0) > 0) {
      v.revT = (v.revT ?? 0) - dt;
      throttle = -mag * 0.8;
    } else {
      // 後ろ向きに倒したら、その場で U ターン（前進しながら大きく曲がる）
      throttle = mag * Math.max(0.3, Math.cos(d));
    }
    // 低速でも小回りが利く（狭い路地・切り返し）
    const turnRate = Math.abs(v.spd) > 30 ? VEHICLE.turn * Math.min(1, Math.max(0.55, Math.abs(v.spd) / 160)) : VEHICLE.pivot;
    v.a += Math.max(-turnRate * dt, Math.min(turnRate * dt, d));
    if (throttle > 0) {
      if (v.spd < 0) v.spd = Math.min(0, v.spd + VEHICLE.brake * dt);
      else v.spd = Math.min(VEHICLE.maxSpeed * throttle, v.spd + VEHICLE.accel * dt);
    } else {
      if (v.spd > 0) v.spd = Math.max(0, v.spd - VEHICLE.brake * dt);
      else v.spd = Math.max(-VEHICLE.reverseSpeed * -throttle, v.spd - VEHICLE.accel * 0.6 * dt);
    }
    v.fuel = Math.max(0, v.fuel - VEHICLE.fuelPerSec * Math.abs(throttle) * dt);
  } else {
    // 手を離すと自然に止まる
    const f = Math.exp(-2.2 * dt);
    v.spd *= f;
    if (Math.abs(v.spd) < 4) v.spd = 0;
  }
  v.a = Math.atan2(Math.sin(v.a), Math.cos(v.a));
  if (v.spd === 0) {
    // 押し付けたまま動けない（壁に密着）も、切り返しの合図にする
    if (canDrive && mag > 0.15) {
      v.blockT = (v.blockT ?? 0) + dt;
      if (v.blockT > 0.3) {
        v.blockT = 0;
        v.revT = (v.revT ?? 0) > 0 ? 0 : 0.7;
      }
    }
    return 0;
  }
  const px = v.x;
  const py = v.y;
  const want = v.spd * dt;
  const body = { x: v.x, y: v.y };
  lastCollided.length = 0;
  moveCircle(body, Math.cos(v.a) * want, Math.sin(v.a) * want, VEHICLE.radius, world, lastCollided);
  // 川（深い所・浅瀬）には入れない：前の位置に戻す
  const tt = world.terrainAt(Math.floor(body.x / TILE), Math.floor(body.y / TILE));
  const fx = world.terrainAt(Math.floor((body.x + Math.cos(v.a) * 18 * Math.sign(v.spd)) / TILE), Math.floor((body.y + Math.sin(v.a) * 18 * Math.sign(v.spd)) / TILE));
  if (tt === T_WATER || tt === T_SHALLOW || fx === T_WATER || fx === T_SHALLOW) {
    body.x = px;
    body.y = py;
  }
  v.x = body.x;
  v.y = body.y;
  const moved = Math.hypot(v.x - px, v.y - py);
  const ratio = moved / Math.max(0.001, Math.abs(want));
  // 進もうとして進めない状態が続いたら、自動で切り返す（前進中→バック、バック中→前進）
  if (inp && ratio < 0.2) {
    v.blockT = (v.blockT ?? 0) + dt;
    if (v.blockT > 0.3) {
      v.blockT = 0;
      v.revT = (v.revT ?? 0) > 0 ? 0 : 0.7;
    }
  } else v.blockT = 0;
  // ほとんど進めない＝正面からぶつかった：止まって、速さに応じて傷む
  if (ratio < 0.2) {
    const hit = Math.abs(v.spd);
    v.spd = 0;
    return hit;
  }
  // 壁や障害物に沿ってこすれた：進めた分だけ速さを残し、車体を進んだ向きにそろえる（狭い道で詰まらない）
  if (ratio < 0.9) {
    v.spd *= Math.max(0.5, ratio);
    const ma = Math.atan2(v.y - py, v.x - px) + (v.spd < 0 ? Math.PI : 0);
    v.a += angleDiff(ma, v.a) * 0.25;
  }
  return 0;
}

/** 座席の位置（ワールド座標） */
export function seatPos(v: VehicleSnap, seat: number): { x: number; y: number } {
  const [f, s] = SEATS[seat] ?? SEATS[0];
  const c = Math.cos(v.a);
  const n = Math.sin(v.a);
  return { x: v.x + c * f - n * s, y: v.y + n * f + c * s };
}

/** 車の後ろ（トランク）の位置 */
export function trunkPos(v: VehicleSnap): { x: number; y: number } {
  return { x: v.x - Math.cos(v.a) * 34, y: v.y - Math.sin(v.a) * 34 };
}
