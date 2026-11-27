// ============================================================
// 移動・当たり判定（タイル地形 / 建築物 / 資源オブジェクト）
// ============================================================
import type { InputFrame, MoveBody, PlayerStatus, Vec2 } from '../types';
import { PLAYER, TILE, WORLD_H, WORLD_W } from './constants';
import type { TileWorld } from './world';

export const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v);
export const lerp = (a: number, b: number, t: number) => a + (b - a) * t;

export function angleLerp(a: number, b: number, t: number): number {
  let d = (b - a) % (Math.PI * 2);
  if (d > Math.PI) d -= Math.PI * 2;
  if (d < -Math.PI) d += Math.PI * 2;
  return a + d * t;
}

export function angleDiff(a: number, b: number): number {
  let d = (b - a) % (Math.PI * 2);
  if (d > Math.PI) d -= Math.PI * 2;
  if (d < -Math.PI) d += Math.PI * 2;
  return d;
}

/** 円を1つのタイル矩形から押し出す。押し出したら true */
function resolveCircleTile(p: Vec2, r: number, tx: number, ty: number): boolean {
  const x0 = tx * TILE;
  const y0 = ty * TILE;
  const cx = clamp(p.x, x0, x0 + TILE);
  const cy = clamp(p.y, y0, y0 + TILE);
  const dx = p.x - cx;
  const dy = p.y - cy;
  const d2 = dx * dx + dy * dy;
  if (d2 >= r * r) return false;
  if (d2 > 1e-6) {
    const d = Math.sqrt(d2);
    p.x += (dx / d) * (r - d);
    p.y += (dy / d) * (r - d);
  } else {
    const left = p.x - x0;
    const right = x0 + TILE - p.x;
    const top = p.y - y0;
    const bottom = y0 + TILE - p.y;
    const m = Math.min(left, right, top, bottom);
    if (m === left) p.x = x0 - r;
    else if (m === right) p.x = x0 + TILE + r;
    else if (m === top) p.y = y0 - r;
    else p.y = y0 + TILE + r;
  }
  return true;
}

/**
 * 障害物を考慮して円を移動。衝突したタイルを collided に記録（ゾンビの壁攻撃判定に使用）
 */
export function moveCircle(
  p: Vec2,
  dx: number,
  dy: number,
  r: number,
  world: TileWorld,
  collided?: { tx: number; ty: number }[],
): void {
  const steps = Math.max(1, Math.ceil(Math.max(Math.abs(dx), Math.abs(dy)) / 6));
  const sx = dx / steps;
  const sy = dy / steps;
  for (let i = 0; i < steps; i++) {
    p.x += sx;
    p.y += sy;
    const tx0 = Math.floor((p.x - r) / TILE);
    const tx1 = Math.floor((p.x + r) / TILE);
    const ty0 = Math.floor((p.y - r) / TILE);
    const ty1 = Math.floor((p.y + r) / TILE);
    for (let ty = ty0; ty <= ty1; ty++)
      for (let tx = tx0; tx <= tx1; tx++) {
        if (world.solid(tx, ty) && resolveCircleTile(p, r, tx, ty) && collided) collided.push({ tx, ty });
      }
    p.x = clamp(p.x, r, WORLD_W - r);
    p.y = clamp(p.y, r, WORLD_H - r);
  }
}

/** 円がどこかのソリッドタイルに重なっているか */
export function circleBlocked(x: number, y: number, r: number, world: TileWorld): boolean {
  const tx0 = Math.floor((x - r) / TILE);
  const tx1 = Math.floor((x + r) / TILE);
  const ty0 = Math.floor((y - r) / TILE);
  const ty1 = Math.floor((y + r) / TILE);
  for (let ty = ty0; ty <= ty1; ty++)
    for (let tx = tx0; tx <= tx1; tx++) {
      if (!world.solid(tx, ty)) continue;
      const cx = clamp(x, tx * TILE, tx * TILE + TILE);
      const cy = clamp(y, ty * TILE, ty * TILE + TILE);
      if ((x - cx) ** 2 + (y - cy) ** 2 < r * r) return true;
    }
  return false;
}

/** 円とタイルが重なっているか（建築可否判定用） */
export function circleOverlapsTile(x: number, y: number, r: number, tx: number, ty: number): boolean {
  const cx = clamp(x, tx * TILE, tx * TILE + TILE);
  const cy = clamp(y, ty * TILE, ty * TILE + TILE);
  return (x - cx) ** 2 + (y - cy) ** 2 < r * r;
}

/**
 * プレイヤー移動の1ステップ。ホストの権威計算とゲストのクライアント側予測で共通利用。
 */
export function stepMovement(
  b: MoveBody,
  f: Pick<InputFrame, 'mx' | 'my' | 'aim' | 'dash'>,
  rawDt: number,
  status: PlayerStatus,
  world: TileWorld,
): void {
  const dt = clamp(rawDt, 0, 0.1);
  if (status === 'dead') return;
  b.dashCd = Math.max(0, b.dashCd - dt);
  // スタミナ：消費後すこし待ってから回復
  if (b.staminaDelay > 0) b.staminaDelay = Math.max(0, b.staminaDelay - dt);
  else b.stamina = Math.min(b.stmMax ?? PLAYER.maxStamina, b.stamina + PLAYER.staminaRegen * (b.stmRegen ?? 1) * dt);

  let mx = f.mx;
  let my = f.my;
  const len = Math.hypot(mx, my);
  if (len > 1) {
    mx /= len;
    my /= len;
  }

  if (f.dash && status === 'alive' && b.dashCd <= 0 && b.stamina >= PLAYER.dashStamina) {
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
    b.stamina -= PLAYER.dashStamina;
    b.staminaDelay = PLAYER.staminaDelay;
  }

  let vx: number;
  let vy: number;
  if (b.dashTime > 0 && status === 'alive') {
    const wade = world.speedAt(Math.floor(b.x / TILE), Math.floor(b.y / TILE));
    vx = b.dashDx * PLAYER.dashSpeed * wade;
    vy = b.dashDy * PLAYER.dashSpeed * wade;
    b.dashTime = Math.max(0, b.dashTime - dt);
  } else {
    b.dashTime = 0;
    // 浅瀬では足が遅い（ホストとゲストの予測で同じ計算）
    const sp = (status === 'alive' ? PLAYER.speed : PLAYER.downSpeed) * world.speedAt(Math.floor(b.x / TILE), Math.floor(b.y / TILE));
    vx = mx * sp;
    vy = my * sp;
  }

  moveCircle(b, vx * dt, vy * dt, PLAYER.radius, world);

  if (len > 0.01) {
    const target = Math.atan2(my, mx);
    b.bodyAngle = angleLerp(b.bodyAngle, target, 1 - Math.exp(-14 * dt));
  }
}
