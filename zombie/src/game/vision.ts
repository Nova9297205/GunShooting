// ============================================================
// 視界（Fog of War）：タイル単位のレイキャスト
//   - 各プレイヤーの「周囲の浅い視界（全方向）」＋「照準方向の長い視界コーン」
//   - 壁・閉じたドアで遮られる（窓・フェンス・家具越しには見える）
//   - 一度見たタイルは「記憶」として薄暗く残る。敵や動くものは視界内だけ描く
//   - 味方の視界は合算（協力プレイで視界を共有）
// ============================================================
import { MAP_H, MAP_W, TILE } from './constants';
import type { TileWorld } from './world';

export interface Viewer {
  x: number;
  y: number;
  aim: number;
  /** 全方向の浅い視界(px) */
  near: number;
  /** 照準方向の視界コーンの長さ(px)と半角(rad) */
  cone: number;
  half: number;
}

const FOG_UNSEEN = 238;
const FOG_MEMORY = 120;

export class Vision {
  visible = new Uint8Array(MAP_W * MAP_H);
  explored = new Uint8Array(MAP_W * MAP_H);
  /** 1タイル=1ピクセルの霧テクスチャ */
  private raw: HTMLCanvasElement;
  /** 2段階で拡大してぼかした霧（柔らかく丸い境界になる） */
  fog: HTMLCanvasElement;
  private fogUpCtx: CanvasRenderingContext2D;
  private fogCtx: CanvasRenderingContext2D;
  private img: ImageData;

  constructor() {
    this.raw = document.createElement('canvas');
    this.raw.width = MAP_W;
    this.raw.height = MAP_H;
    this.fogCtx = this.raw.getContext('2d')!;
    this.fog = document.createElement('canvas');
    this.fog.width = MAP_W * 4;
    this.fog.height = MAP_H * 4;
    this.fogUpCtx = this.fog.getContext('2d')!;
    this.fogUpCtx.imageSmoothingEnabled = true;
    this.img = this.fogCtx.createImageData(MAP_W, MAP_H);
  }

  update(world: TileWorld, viewers: Viewer[]): void {
    this.visible.fill(0);
    for (const v of viewers) {
      // 周囲（全方向）
      const nNear = 96;
      for (let i = 0; i < nNear; i++) this.cast(world, v.x, v.y, (i / nNear) * Math.PI * 2, v.near);
      // 照準方向のコーン（遠端で1タイル以下の間隔になるようにレイを並べる）
      const step = (0.6 * TILE) / v.cone;
      for (let a = -v.half; a <= v.half; a += step) this.cast(world, v.x, v.y, v.aim + a, v.cone);
    }
    // 霧テクスチャを更新
    const d = this.img.data;
    for (let i = 0; i < MAP_W * MAP_H; i++) {
      const a = this.visible[i] ? 0 : this.explored[i] ? FOG_MEMORY : FOG_UNSEEN;
      const k = i * 4;
      d[k] = 6;
      d[k + 1] = 7;
      d[k + 2] = 8;
      d[k + 3] = a;
    }
    this.fogCtx.putImageData(this.img, 0, 0);
    this.fogUpCtx.clearRect(0, 0, this.fog.width, this.fog.height);
    this.fogUpCtx.drawImage(this.raw, 0, 0, this.fog.width, this.fog.height);
  }

  markExplored(x: number, y: number, w: number, h: number): void {
    for (let ty = y; ty < y + h; ty++) for (let tx = x; tx < x + w; tx++) if (tx >= 0 && ty >= 0 && tx < MAP_W && ty < MAP_H) this.explored[ty * MAP_W + tx] = 1;
  }

  isVisible(x: number, y: number): boolean {
    const tx = Math.floor(x / TILE);
    const ty = Math.floor(y / TILE);
    if (tx < 0 || ty < 0 || tx >= MAP_W || ty >= MAP_H) return false;
    return this.visible[ty * MAP_W + tx] === 1;
  }

  tileVisible(tx: number, ty: number): boolean {
    if (tx < 0 || ty < 0 || tx >= MAP_W || ty >= MAP_H) return false;
    return this.visible[ty * MAP_W + tx] === 1;
  }

  /** DDA でタイルをたどり、視線を遮るタイル（自身も見える）で止まる */
  private cast(world: TileWorld, ox: number, oy: number, ang: number, maxDist: number): void {
    const dx = Math.cos(ang);
    const dy = Math.sin(ang);
    let tx = Math.floor(ox / TILE);
    let ty = Math.floor(oy / TILE);
    const stepX = dx > 0 ? 1 : -1;
    const stepY = dy > 0 ? 1 : -1;
    const tDeltaX = dx !== 0 ? Math.abs(TILE / dx) : Infinity;
    const tDeltaY = dy !== 0 ? Math.abs(TILE / dy) : Infinity;
    let tMaxX = dx > 0 ? ((tx + 1) * TILE - ox) / dx : dx < 0 ? (ox - tx * TILE) / -dx : Infinity;
    let tMaxY = dy > 0 ? ((ty + 1) * TILE - oy) / dy : dy < 0 ? (oy - ty * TILE) / -dy : Infinity;
    let t = 0;
    let first = true;
    while (t <= maxDist) {
      if (tx < 0 || ty < 0 || tx >= MAP_W || ty >= MAP_H) return;
      const i = ty * MAP_W + tx;
      this.visible[i] = 1;
      this.explored[i] = 1;
      if (!first && world.blocksSight(tx, ty)) return;
      first = false;
      if (tMaxX < tMaxY) {
        t = tMaxX;
        tMaxX += tDeltaX;
        tx += stepX;
      } else {
        t = tMaxY;
        tMaxY += tDeltaY;
        ty += stepY;
      }
    }
  }
}
