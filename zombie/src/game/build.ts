// ============================================================
// 拠点づくり：建てられる場所かどうかの判定
//   ホスト（本当の判定）とクライアント（置く前の緑/赤の表示）で同じ関数を使う。
// ============================================================

import type { ObjSnap } from '../types';
import { BUILD_RANGE, BUILDS, SAFEHOUSE, SOLID_KINDS, TILE, T_FENCE, T_WALL, T_WATER, T_WINDOW, type BuildDef, type BuildKind } from './constants';
import { countItem, type ItemId, type Slot } from './items';

interface WorldLike {
  inBounds(tx: number, ty: number): boolean;
  terrainAt(tx: number, ty: number): number;
  objAt(tx: number, ty: number): ObjSnap | undefined;
}

export function buildDef(kind: string): BuildDef | undefined {
  return BUILDS.find((b) => b.kind === kind);
}

/** 拠点の敷地（柵の上の門も含む）の中か */
export function inBuildArea(tx: number, ty: number): boolean {
  const sh = SAFEHOUSE;
  return tx >= sh.x && ty >= sh.y && tx < sh.x + sh.w && ty < sh.y + sh.h;
}

/**
 * そのマスに建てられないなら理由を返す（建てられるなら null）
 * @param occupants プレイヤー・ゾンビの位置（固い物を体の上に置かない）
 */
export function buildSpotError(world: WorldLike, kind: BuildKind, tx: number, ty: number, px: number, py: number, occupants: { x: number; y: number }[]): string | null {
  // どこにでも建てられる（ゾンボイドのように、好きな建物を拠点にできる）
  if (!world.inBounds(tx, ty)) return 'ここには置けない';
  const t = world.terrainAt(tx, ty);
  if (t === T_WALL || t === T_WINDOW || t === T_FENCE || t === T_WATER) return 'ここには置けない';
  if (world.objAt(tx, ty)) return 'すでに物がある';
  const cx = (tx + 0.5) * TILE;
  const cy = (ty + 0.5) * TILE;
  if (Math.hypot(cx - px, cy - py) > BUILD_RANGE * TILE) return '遠すぎる（近づいて建てる）';
  if (SOLID_KINDS.has(kind)) {
    for (const o of occupants) if (Math.abs(o.x - cx) < TILE / 2 + 15 && Math.abs(o.y - cy) < TILE / 2 + 15) return '人やゾンビがいる';
    // ドアの前を塞がない
    for (const [dx, dy] of [[0, 1], [0, -1], [1, 0], [-1, 0]]) {
      const o = world.objAt(tx + dx, ty + dy);
      if (o && o.kind === 'door') return 'ドアの前は塞げない';
    }
  }
  return null;
}

/** 素材はバックパック → 共有倉庫の順に使う */
export function canAfford(def: BuildDef, bag: (Slot | null)[], shared: (Slot | null)[] | null): ItemId | null {
  for (const [m, n] of Object.entries(def.cost) as [ItemId, number][]) if (countItem(bag, m) + (shared ? countItem(shared, m) : 0) < n) return m;
  return null;
}
