import type { InputFrame, MoveBody, PlayerStatus, Rect, Vec2 } from '../types';
import { OBSTACLES, PLAYER, WORLD_H, WORLD_W } from './constants';

export const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v);
export const lerp = (a: number, b: number, t: number) => a + (b - a) * t;

/** 角度の最短経路補間 */
export function angleLerp(a: number, b: number, t: number): number {
  let d = (b - a) % (Math.PI * 2);
  if (d > Math.PI) d -= Math.PI * 2;
  if (d < -Math.PI) d += Math.PI * 2;
  return a + d * t;
}

export function pointInRect(x: number, y: number, r: Rect): boolean {
  return x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h;
}

export function pointInObstacle(x: number, y: number): boolean {
  for (const o of OBSTACLES) if (pointInRect(x, y, o)) return true;
  return false;
}

export function circleHitsObstacle(x: number, y: number, r: number): boolean {
  for (const o of OBSTACLES) {
    const cx = clamp(x, o.x, o.x + o.w);
    const cy = clamp(y, o.y, o.y + o.h);
    if ((x - cx) ** 2 + (y - cy) ** 2 < r * r) return true;
  }
  return false;
}

/** 円を矩形から押し出す */
function resolveCircleRect(p: Vec2, r: number, o: Rect): void {
  const cx = clamp(p.x, o.x, o.x + o.w);
  const cy = clamp(p.y, o.y, o.y + o.h);
  const dx = p.x - cx;
  const dy = p.y - cy;
  const d2 = dx * dx + dy * dy;
  if (d2 >= r * r) return;
  if (d2 > 1e-6) {
    const d = Math.sqrt(d2);
    p.x += (dx / d) * (r - d);
    p.y += (dy / d) * (r - d);
  } else {
    // 中心が矩形内部：最小貫通軸で押し出す
    const left = p.x - o.x;
    const right = o.x + o.w - p.x;
    const top = p.y - o.y;
    const bottom = o.y + o.h - p.y;
    const m = Math.min(left, right, top, bottom);
    if (m === left) p.x = o.x - r;
    else if (m === right) p.x = o.x + o.w + r;
    else if (m === top) p.y = o.y - r;
    else p.y = o.y + o.h + r;
  }
}

/** 障害物とワールド境界を考慮して円を移動（サブステップでトンネリング防止） */
export function moveCircle(p: Vec2, dx: number, dy: number, r: number): void {
  const steps = Math.max(1, Math.ceil(Math.max(Math.abs(dx), Math.abs(dy)) / 8));
  const sx = dx / steps;
  const sy = dy / steps;
  for (let i = 0; i < steps; i++) {
    p.x += sx;
    p.y += sy;
    for (const o of OBSTACLES) resolveCircleRect(p, r, o);
    p.x = clamp(p.x, r, WORLD_W - r);
    p.y = clamp(p.y, r, WORLD_H - r);
  }
}

/** 線分と矩形の交差（Liang–Barsky）。交差する場合は 0..1 の t を返す */
export function segmentRect(x1: number, y1: number, x2: number, y2: number, r: Rect): number | null {
  const dx = x2 - x1;
  const dy = y2 - y1;
  let t0 = 0;
  let t1 = 1;
  const p = [-dx, dx, -dy, dy];
  const q = [x1 - r.x, r.x + r.w - x1, y1 - r.y, r.y + r.h - y1];
  for (let i = 0; i < 4; i++) {
    if (p[i] === 0) {
      if (q[i] < 0) return null;
    } else {
      const t = q[i] / p[i];
      if (p[i] < 0) {
        if (t > t1) return null;
        if (t > t0) t0 = t;
      } else {
        if (t < t0) return null;
        if (t < t1) t1 = t;
      }
    }
  }
  return t0;
}

/** 視線を遮る最初の障害物 */
export function firstBlocking(x1: number, y1: number, x2: number, y2: number): Rect | null {
  let best: Rect | null = null;
  let bestT = Infinity;
  for (const o of OBSTACLES) {
    const t = segmentRect(x1, y1, x2, y2, o);
    if (t !== null && t < bestT) {
      bestT = t;
      best = o;
    }
  }
  return best;
}

export function hasLineOfSight(x1: number, y1: number, x2: number, y2: number): boolean {
  return firstBlocking(x1, y1, x2, y2) === null;
}

/** 角度方向にレイを飛ばし、障害物/ワールド端までの距離を返す */
export function raycast(x: number, y: number, angle: number, maxDist: number): number {
  const x2 = x + Math.cos(angle) * maxDist;
  const y2 = y + Math.sin(angle) * maxDist;
  let best = 1;
  for (const o of OBSTACLES) {
    const t = segmentRect(x, y, x2, y2, o);
    if (t !== null && t < best) best = t;
  }
  return best * maxDist;
}

/**
 * プレイヤー移動の1ステップ。
 * ホストの権威計算とゲストのクライアント側予測で全く同じ関数を使うことで、
 * 入力が同じなら同じ結果になる（＝リコンシリエーション時のズレが最小になる）。
 */
export function stepMovement(
  b: MoveBody,
  f: Pick<InputFrame, 'mx' | 'my' | 'aim' | 'dash'>,
  rawDt: number,
  status: PlayerStatus,
): void {
  const dt = clamp(rawDt, 0, 0.1);
  if (status === 'dead') return;
  b.dashCd = Math.max(0, b.dashCd - dt);

  let mx = f.mx;
  let my = f.my;
  const len = Math.hypot(mx, my);
  if (len > 1) {
    mx /= len;
    my /= len;
  }

  if (f.dash && status === 'alive' && b.dashCd <= 0) {
    let dx = Math.cos(f.aim);
    let dy = Math.sin(f.aim);
    if (len > 0.01) {
      const l = Math.hypot(mx, my);
      dx = mx / l;
      dy = my / l;
    }
    b.dashDx = dx;
    b.dashDy = dy;
    b.dashTime = PLAYER.dashTime;
    b.dashCd = PLAYER.dashCooldown;
  }

  let vx: number;
  let vy: number;
  if (b.dashTime > 0 && status === 'alive') {
    vx = b.dashDx * PLAYER.dashSpeed;
    vy = b.dashDy * PLAYER.dashSpeed;
    b.dashTime = Math.max(0, b.dashTime - dt);
  } else {
    b.dashTime = 0;
    const sp = status === 'alive' ? PLAYER.speed : PLAYER.downSpeed;
    vx = mx * sp;
    vy = my * sp;
  }

  moveCircle(b, vx * dt, vy * dt, PLAYER.radius);

  if (len > 0.01) {
    const target = Math.atan2(my, mx);
    b.bodyAngle = angleLerp(b.bodyAngle, target, 1 - Math.exp(-14 * dt));
  }
}
