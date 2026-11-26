// ============================================================
// ビジュアル定義（ベクター描画）
//   ★ スプライト画像に差し替えるときは、この ArtSet インターフェースを実装した
//     別クラス（例: ImageArt で ctx.drawImage を使う）を作り、Renderer の `art` を差し替えるだけでOK。
//     Renderer 側はゲームロジック・カメラ・ライティング・HUD のみを担当する。
//   光源は左上。影は右下へ落ちる。
// ============================================================
import type { ObjSnap, PlayerSnap, ZombieSnap } from '../types';
import type { Corpse } from './Effects';
import { Tool } from '../types';
import { TILE, ZOMBIE } from './constants';
import { heldWeapon } from './items';
import { type BakedTerrain, bakeTerrain } from './TerrainArt';
import type { TileWorld } from './world';

export interface PlayerAnim {
  recoil: number;
  recoilV: number;
  flash: number;
  flashSeed: number;
  lastShots: number;
  swing: number; // 0..1 斧の振り進行
  lastSwings: number;
  walk: number;
  lastX: number;
  lastY: number;
  /** 移動速度（0..1、歩行の揺れの大きさ） */
  move: number;
}

export interface ZombieAnim {
  lastAtk: number;
  lunge: number;
  walk: number;
  lastX: number;
  lastY: number;
  move: number;
}

/** 隣のタイルに「高い壁」があるか（側面の描画判定用） */
export type TallQuery = (dx: number, dy: number) => boolean;

export interface ArtSet {
  /** 地形全体の焼き込み（起動時に1回） */
  bakeTerrain(world: TileWorld): BakedTerrain;
  /** 地面レベル（スパイク・焚き火・切り株・クレート・影・壁の側面）。描いたら true */
  drawLowObject(ctx: CanvasRenderingContext2D, o: ObjSnap, t: number, tall: TallQuery): boolean;
  /** 高いオブジェクト（壁の天面・木の葉・車・タレットの砲身） */
  drawTallObject(ctx: CanvasRenderingContext2D, o: ObjSnap, t: number, aim?: { a: number; flash: number }): void;
  drawZombie(ctx: CanvasRenderingContext2D, z: ZombieSnap, anim: ZombieAnim, t: number): void;
  drawPlayer(ctx: CanvasRenderingContext2D, p: PlayerSnap, color: string, anim: PlayerAnim, t: number): void;
  /** 倒れたゾンビの亡骸 */
  drawCorpse(ctx: CanvasRenderingContext2D, c: Corpse): void;
}

// ---------------- ヘルパー ----------------

/** タイル座標から決定的な疑似乱数 0..1 */
export function hash2(x: number, y: number, s = 0): number {
  let h = (x * 374761393 + y * 668265263 + s * 1442695041) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

export function shade(hex: string, amt: number): string {
  const h = hex.replace('#', '');
  const n = parseInt(h, 16);
  const f = (c: number) => Math.max(0, Math.min(255, Math.round(amt >= 0 ? c + (255 - c) * amt : c * (1 + amt))));
  return `rgb(${f((n >> 16) & 255)},${f((n >> 8) & 255)},${f(n & 255)})`;
}

function cracks(ctx: CanvasRenderingContext2D, x: number, y: number, ratio: number, seed: number): void {
  if (ratio > 0.7) return;
  ctx.strokeStyle = 'rgba(0,0,0,0.55)';
  ctx.lineWidth = 1.5;
  const n = ratio > 0.4 ? 2 : 4;
  ctx.beginPath();
  for (let i = 0; i < n; i++) {
    let px = x + 8 + hash2(seed, i, 1) * (TILE - 16);
    let py = y + 6 + hash2(seed, i, 2) * (TILE - 12);
    ctx.moveTo(px, py);
    for (let k = 0; k < 3; k++) {
      px += (hash2(seed, i, k + 3) - 0.5) * 16;
      py += (hash2(seed, i, k + 7) - 0.5) * 16;
      ctx.lineTo(px, py);
    }
  }
  ctx.stroke();
}

/** 南側の側面（高さ 10px）。下に壁があれば描かない */
function southFace(ctx: CanvasRenderingContext2D, x: number, y: number, top: string, bottom: string, tall: TallQuery): void {
  if (tall(0, 1)) return;
  const g = ctx.createLinearGradient(0, y + TILE, 0, y + TILE + 10);
  g.addColorStop(0, top);
  g.addColorStop(1, bottom);
  ctx.fillStyle = g;
  ctx.fillRect(x, y + TILE, TILE, 10);
}

// 服の色（ゾンビごとにIDから決定）
const SHIRTS = ['#5b6b7a', '#7a5b4f', '#4f6b55', '#6e6a54', '#7d4a4a', '#4a4f6e', '#8a7a62', '#5e5e5e'];
const PANTS = ['#2f3a4a', '#3b3229', '#2c2c2c', '#41423a'];

// ============================================================
export class VectorArt implements ArtSet {
  bakeTerrain(world: TileWorld): BakedTerrain {
    return bakeTerrain(world);
  }

  drawLowObject(ctx: CanvasRenderingContext2D, o: ObjSnap, t: number, tall: TallQuery): boolean {
    const x = o.tx * TILE;
    const y = o.ty * TILE;
    const cx = x + TILE / 2;
    const cy = y + TILE / 2;
    switch (o.kind) {
      case 'spike': {
        const ratio = o.hp / o.maxHp;
        ctx.fillStyle = 'rgba(0,0,0,0.25)';
        ctx.fillRect(x + 6, y + 8, TILE - 6, TILE - 6);
        ctx.fillStyle = '#4a321c';
        ctx.fillRect(x + 3, y + 3, TILE - 6, TILE - 6);
        ctx.fillStyle = '#5e4126';
        ctx.fillRect(x + 3, y + 3, TILE - 6, 4);
        ctx.fillRect(x + 3, y + TILE - 7, TILE - 6, 4);
        // 斜めに突き出た杭
        ctx.lineCap = 'round';
        for (let i = 0; i < 3; i++) {
          for (const dir of [-1, 1]) {
            const ox = x + 9 + i * 11;
            ctx.strokeStyle = '#3a2614';
            ctx.lineWidth = 4;
            ctx.beginPath();
            ctx.moveTo(ox + 1 - dir * 5, y + 33);
            ctx.lineTo(ox + 1 + dir * 5, y + 9);
            ctx.stroke();
            ctx.strokeStyle = '#c9a26b';
            ctx.lineWidth = 2.5;
            ctx.beginPath();
            ctx.moveTo(ox - dir * 5, y + 32);
            ctx.lineTo(ox + dir * 5, y + 8);
            ctx.stroke();
          }
        }
        ctx.fillStyle = '#efe6d2';
        for (let i = 0; i < 3; i++)
          for (const dir of [-1, 1]) {
            ctx.beginPath();
            ctx.arc(x + 9 + i * 11 + dir * 5, y + 8, 1.6, 0, Math.PI * 2);
            ctx.fill();
          }
        if (ratio < 0.85) {
          // 血の跡
          ctx.fillStyle = `rgba(110,10,10,${0.5 * (1 - ratio)})`;
          ctx.beginPath();
          ctx.ellipse(cx + 3, cy + 4, 12, 7, 0.4, 0, Math.PI * 2);
          ctx.fill();
        }
        return true;
      }
      case 'torch': {
        ctx.fillStyle = 'rgba(0,0,0,0.3)';
        ctx.beginPath();
        ctx.ellipse(cx + 6, cy + 8, 9, 5, 0.5, 0, Math.PI * 2);
        ctx.fill();
        for (let i = 0; i < 5; i++) {
          const a = (i / 5) * Math.PI * 2 + 0.3;
          ctx.fillStyle = i % 2 ? '#6f6b64' : '#86817a';
          ctx.beginPath();
          ctx.arc(cx + Math.cos(a) * 7, cy + Math.sin(a) * 7, 3.2, 0, Math.PI * 2);
          ctx.fill();
        }
        ctx.fillStyle = '#5a3a1e';
        ctx.beginPath();
        ctx.arc(cx, cy, 4, 0, Math.PI * 2);
        ctx.fill();
        this.flame(ctx, cx, cy - 3, 0.75, t + o.id);
        return true;
      }
      case 'campfire': {
        ctx.fillStyle = 'rgba(0,0,0,0.35)';
        ctx.beginPath();
        ctx.ellipse(cx + 4, cy + 5, 19, 15, 0, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = '#2a2420';
        ctx.beginPath();
        ctx.arc(cx, cy, 13, 0, Math.PI * 2);
        ctx.fill();
        for (let i = 0; i < 9; i++) {
          const a = (i / 9) * Math.PI * 2;
          const sx = cx + Math.cos(a) * 15;
          const sy = cy + Math.sin(a) * 15;
          ctx.fillStyle = '#6f6a63';
          ctx.beginPath();
          ctx.arc(sx, sy, 4.4, 0, Math.PI * 2);
          ctx.fill();
          ctx.fillStyle = '#9a948b';
          ctx.beginPath();
          ctx.arc(sx - 1, sy - 1, 2.4, 0, Math.PI * 2);
          ctx.fill();
        }
        ctx.lineCap = 'round';
        for (const [a, b, c2, d] of [
          [-10, -6, 10, 6],
          [10, -6, -10, 6],
          [0, -10, 0, 10],
        ]) {
          ctx.strokeStyle = '#3d2615';
          ctx.lineWidth = 5;
          ctx.beginPath();
          ctx.moveTo(cx + a, cy + b);
          ctx.lineTo(cx + c2, cy + d);
          ctx.stroke();
          ctx.strokeStyle = '#7a4d2a';
          ctx.lineWidth = 2;
          ctx.stroke();
        }
        // 熾火
        ctx.save();
        ctx.globalCompositeOperation = 'lighter';
        for (let i = 0; i < 6; i++) {
          const a = hash2(i, o.id, 3) * Math.PI * 2;
          const r = 3 + hash2(i, o.id, 4) * 7;
          ctx.fillStyle = `rgba(255,${90 + i * 20},30,${0.4 + 0.3 * Math.sin(t * 6 + i)})`;
          ctx.beginPath();
          ctx.arc(cx + Math.cos(a) * r, cy + Math.sin(a) * r, 1.6, 0, Math.PI * 2);
          ctx.fill();
        }
        ctx.restore();
        this.flame(ctx, cx, cy, 1.25, t);
        return true;
      }
      case 'crate': {
        ctx.fillStyle = 'rgba(0,0,0,0.32)';
        ctx.fillRect(x + 10, y + 12, 28, 26);
        const lg = ctx.createLinearGradient(x + 6, y + 6, x + 34, y + 34);
        lg.addColorStop(0, o.ready ? '#b4813f' : '#6e553a');
        lg.addColorStop(1, o.ready ? '#7f5526' : '#4a3a28');
        ctx.fillStyle = lg;
        ctx.fillRect(x + 6, y + 6, 28, 28);
        ctx.strokeStyle = 'rgba(40,25,10,0.6)';
        ctx.lineWidth = 1;
        for (let i = 1; i < 4; i++) {
          ctx.beginPath();
          ctx.moveTo(x + 6, y + 6 + i * 7 + 0.5);
          ctx.lineTo(x + 34, y + 6 + i * 7 + 0.5);
          ctx.stroke();
        }
        ctx.strokeStyle = o.ready ? '#5b3a17' : '#3a2c1d';
        ctx.lineWidth = 3;
        ctx.strokeRect(x + 7.5, y + 7.5, 25, 25);
        ctx.fillStyle = '#9aa0a6';
        for (const [dx, dy] of [[7, 7], [30, 7], [7, 30], [30, 30]]) ctx.fillRect(x + dx - 1, y + dy - 1, 4, 4);
        if (o.ready) {
          const pulse = 0.5 + Math.sin(t * 4 + o.id) * 0.3;
          ctx.fillStyle = `rgba(255,220,120,${pulse})`;
          ctx.beginPath();
          ctx.arc(x + 32, y + 8, 3.5, 0, Math.PI * 2);
          ctx.fill();
        } else {
          ctx.fillStyle = 'rgba(0,0,0,0.4)';
          ctx.fillRect(x + 10, y + 10, 20, 20);
        }
        return true;
      }
      case 'box': {
        ctx.fillStyle = 'rgba(0,0,0,0.32)';
        ctx.fillRect(x + 8, y + 14, 32, 24);
        southFace(ctx, x + 4, y - 8, '#2e3c4a', '#222c36', () => false);
        const lg = ctx.createLinearGradient(x, y + 8, x, y + 32);
        lg.addColorStop(0, o.ready ? '#6a90b3' : '#4b5866');
        lg.addColorStop(1, o.ready ? '#3e5a75' : '#343e48');
        ctx.fillStyle = lg;
        roundRect(ctx, x + 4, y + 6, 32, 26, 3);
        ctx.fill();
        ctx.fillStyle = 'rgba(255,255,255,0.14)';
        ctx.fillRect(x + 6, y + 8, 28, 3);
        ctx.fillStyle = '#2a3440';
        ctx.fillRect(x + 4, y + 16, 32, 2);
        ctx.fillStyle = '#d2b86a';
        ctx.fillRect(x + 17, y + 14, 6, 6);
        if (o.ready) {
          const pulse = 0.4 + Math.sin(t * 3 + o.id) * 0.3;
          ctx.strokeStyle = `rgba(160,220,255,${pulse})`;
          ctx.lineWidth = 2;
          roundRect(ctx, x + 2, y + 4, 36, 30, 4);
          ctx.stroke();
        }
        return true;
      }
      case 'stone':
        southFace(ctx, x, y, '#4f4c48', '#393734', tall);
        return false;
      case 'turret': {
        ctx.fillStyle = 'rgba(0,0,0,0.3)';
        ctx.beginPath();
        ctx.ellipse(cx + 5, cy + 7, 16, 12, 0, 0, Math.PI * 2);
        ctx.fill();
        // 三脚
        ctx.strokeStyle = '#2a2f37';
        ctx.lineWidth = 4;
        ctx.lineCap = 'round';
        ctx.beginPath();
        for (let i = 0; i < 3; i++) {
          const a = (i / 3) * Math.PI * 2 + 0.5;
          ctx.moveTo(cx, cy);
          ctx.lineTo(cx + Math.cos(a) * 16, cy + Math.sin(a) * 16);
        }
        ctx.stroke();
        return false;
      }
      case 'barbed': {
        const ratio = o.hp / o.maxHp;
        ctx.globalAlpha = 0.55 + ratio * 0.45;
        ctx.strokeStyle = '#5b4a3a';
        ctx.lineWidth = 3;
        ctx.beginPath();
        ctx.moveTo(x + 4, y + 8);
        ctx.lineTo(x + 4, y + 34);
        ctx.moveTo(x + TILE - 4, y + 8);
        ctx.lineTo(x + TILE - 4, y + 34);
        ctx.stroke();
        // コイル状の鉄線
        for (const [dy, col] of [
          [0, '#3c4148'],
          [-1, '#a3acb7'],
        ] as const) {
          ctx.strokeStyle = col;
          ctx.lineWidth = 1.4;
          ctx.beginPath();
          for (let i = 0; i <= 28; i++) {
            const px = x + 3 + (i / 28) * (TILE - 6);
            const py = y + 20 + dy + Math.sin(i * 1.35) * 9;
            if (i === 0) ctx.moveTo(px, py);
            else ctx.lineTo(px, py);
          }
          ctx.stroke();
        }
        ctx.fillStyle = '#c3ccd6';
        for (let i = 0; i < 6; i++) ctx.fillRect(x + 6 + i * 5.5, y + 19 + Math.sin(i * 2) * 8, 2, 2);
        ctx.globalAlpha = 1;
        return true;
      }
      case 'mcrate': {
        ctx.fillStyle = 'rgba(0,0,0,0.35)';
        ctx.fillRect(x + 8, y + 12, 32, 26);
        const lg = ctx.createLinearGradient(x, y + 6, x, y + 34);
        lg.addColorStop(0, o.ready ? '#5d6b3c' : '#3f4733');
        lg.addColorStop(1, o.ready ? '#3e4a26' : '#2c3324');
        ctx.fillStyle = lg;
        roundRect(ctx, x + 3, y + 6, 34, 28, 3);
        ctx.fill();
        ctx.strokeStyle = '#2a321b';
        ctx.lineWidth = 2;
        ctx.stroke();
        ctx.fillStyle = 'rgba(0,0,0,0.25)';
        ctx.fillRect(x + 3, y + 18, 34, 3);
        // ステンシル文字風の印
        ctx.fillStyle = o.ready ? '#e8d9a0' : '#7d7a60';
        ctx.fillRect(x + 8, y + 10, 10, 2);
        ctx.fillRect(x + 8, y + 24, 14, 2);
        ctx.fillStyle = o.ready ? '#c0392b' : '#6b2a24';
        ctx.fillRect(x + 26, y + 9, 7, 7);
        if (o.ready) {
          const pulse = 0.5 + Math.sin(t * 4 + o.id) * 0.35;
          ctx.strokeStyle = `rgba(255,180,90,${pulse})`;
          ctx.lineWidth = 2;
          roundRect(ctx, x + 1, y + 4, 38, 32, 4);
          ctx.stroke();
        }
        return true;
      }
      case 'chest': {
        ctx.fillStyle = 'rgba(0,0,0,0.35)';
        ctx.fillRect(x + 7, y + 13, 32, 24);
        const lg = ctx.createLinearGradient(x, y + 6, x, y + 32);
        lg.addColorStop(0, '#8a5a2e');
        lg.addColorStop(1, '#5a3a1e');
        ctx.fillStyle = lg;
        roundRect(ctx, x + 3, y + 7, 34, 25, 4);
        ctx.fill();
        ctx.fillStyle = '#6b4424';
        roundRect(ctx, x + 3, y + 5, 34, 10, 4); // ふた
        ctx.fill();
        ctx.fillStyle = '#c8a24a';
        ctx.fillRect(x + 3, y + 13, 34, 2);
        ctx.fillRect(x + 9, y + 5, 2, 27);
        ctx.fillRect(x + 29, y + 5, 2, 27);
        ctx.fillStyle = '#e8d080';
        ctx.fillRect(x + 17, y + 12, 6, 6);
        ctx.fillStyle = 'rgba(255,255,255,0.15)';
        ctx.fillRect(x + 5, y + 6, 30, 2);
        return true;
      }
      case 'door': {
        // 壁の向き：左右が壁なら横向きのドア
        const horiz = tall(-1, 0) || tall(1, 0);
        const open = o.ready === 1;
        const dmg = o.hp / o.maxHp;
        ctx.save();
        ctx.translate(cx, cy);
        if (!horiz) ctx.rotate(Math.PI / 2);
        // 戸枠
        ctx.fillStyle = '#3d3a35';
        ctx.fillRect(-20, -7, 4, 14);
        ctx.fillRect(16, -7, 4, 14);
        if (open) {
          // 開いた扉：蝶番を軸に90度回転
          ctx.fillStyle = 'rgba(0,0,0,0.3)';
          ctx.fillRect(-14, -2, 6, 32);
          ctx.fillStyle = '#6b5236';
          ctx.fillRect(-17, -2, 6, 32);
          ctx.fillStyle = '#4f3c28';
          ctx.fillRect(-17, -2, 6, 3);
        } else {
          ctx.fillStyle = 'rgba(0,0,0,0.35)';
          ctx.fillRect(-15, 2, 32, 9);
          const g = ctx.createLinearGradient(0, -5, 0, 5);
          g.addColorStop(0, '#7a5e3e');
          g.addColorStop(1, '#5a4430');
          ctx.fillStyle = g;
          ctx.fillRect(-16, -5, 32, 10);
          ctx.strokeStyle = 'rgba(30,20,12,0.6)';
          ctx.lineWidth = 1;
          ctx.strokeRect(-15.5, -4.5, 31, 9);
          ctx.fillStyle = '#b8a888';
          ctx.fillRect(9, -1.5, 3, 3); // ドアノブ
          if (dmg < 0.7) {
            ctx.strokeStyle = 'rgba(10,8,6,0.7)';
            ctx.beginPath();
            ctx.moveTo(-6, -5);
            ctx.lineTo(-2, 0);
            ctx.lineTo(-7, 5);
            ctx.stroke();
          }
        }
        ctx.restore();
        return true;
      }
      case 'shelf': {
        this.propShadow(ctx, x, y);
        ctx.fillStyle = '#3c3a36';
        ctx.fillRect(x + 3, y + 6, 34, 28);
        ctx.fillStyle = '#56524b';
        ctx.fillRect(x + 3, y + 6, 34, 3);
        ctx.fillRect(x + 3, y + 19, 34, 2);
        // 棚の上の箱や缶（探索済みはまばら）
        const n = o.ready ? 6 : 2;
        for (let i = 0; i < n; i++) {
          const hx = hash2(o.id, i, 3);
          ctx.fillStyle = ['#7a6a52', '#6b7058', '#8a7d68', '#5e6a70', '#7d5a48'][i % 5];
          ctx.fillRect(x + 5 + hx * 26, y + (i % 2 ? 22 : 10), 5 + hash2(o.id, i, 4) * 3, 7);
        }
        return true;
      }
      case 'cabinet': {
        this.propShadow(ctx, x, y);
        ctx.fillStyle = '#9a9890';
        ctx.fillRect(x + 6, y + 6, 28, 28);
        ctx.fillStyle = '#b4b1a8';
        ctx.fillRect(x + 6, y + 6, 28, 4);
        ctx.strokeStyle = '#6b6962';
        ctx.lineWidth = 1;
        ctx.strokeRect(x + 6.5, y + 6.5, 27, 27);
        ctx.beginPath();
        ctx.moveTo(x + 20, y + 10);
        ctx.lineTo(x + 20, y + 34);
        ctx.stroke();
        ctx.fillStyle = '#8a3a30';
        ctx.fillRect(x + 16, y + 15, 8, 3);
        ctx.fillRect(x + 18.5, y + 12.5, 3, 8);
        return true;
      }
      case 'locker': {
        this.propShadow(ctx, x, y);
        ctx.fillStyle = '#4f5a4a';
        ctx.fillRect(x + 5, y + 4, 30, 32);
        ctx.fillStyle = '#5f6b58';
        ctx.fillRect(x + 5, y + 4, 30, 3);
        ctx.strokeStyle = '#353d32';
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(x + 20, y + 7);
        ctx.lineTo(x + 20, y + 36);
        ctx.stroke();
        ctx.fillStyle = '#2f362c';
        for (let i = 0; i < 3; i++) {
          ctx.fillRect(x + 9, y + 10 + i * 3, 8, 1);
          ctx.fillRect(x + 23, y + 10 + i * 3, 8, 1);
        }
        ctx.fillStyle = '#a89c80';
        ctx.fillRect(x + 17, y + 22, 2, 4);
        ctx.fillRect(x + 21, y + 22, 2, 4);
        return true;
      }
      case 'wcase': {
        this.propShadow(ctx, x, y);
        ctx.fillStyle = '#3b4030';
        ctx.fillRect(x + 2, y + 11, 36, 18);
        ctx.fillStyle = '#4b5240';
        ctx.fillRect(x + 2, y + 11, 36, 4);
        ctx.fillStyle = '#9a8f70';
        ctx.fillRect(x + 8, y + 18, 4, 4);
        ctx.fillRect(x + 28, y + 18, 4, 4);
        ctx.fillStyle = '#a8a080';
        ctx.fillRect(x + 14, y + 19, 12, 2);
        if (o.ready) {
          const pulse = 0.25 + Math.sin(t * 3 + o.id) * 0.15;
          ctx.strokeStyle = `rgba(210,190,130,${pulse})`;
          ctx.lineWidth = 1.5;
          ctx.strokeRect(x + 1, y + 10, 38, 20);
        }
        return true;
      }
      case 'fridge': {
        this.propShadow(ctx, x, y);
        ctx.fillStyle = '#b0ad9f';
        ctx.fillRect(x + 6, y + 4, 28, 32);
        ctx.fillStyle = '#c6c3b6';
        ctx.fillRect(x + 6, y + 4, 28, 3);
        ctx.strokeStyle = '#7d7a6e';
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(x + 6, y + 15);
        ctx.lineTo(x + 34, y + 15);
        ctx.stroke();
        ctx.fillStyle = '#6b6860';
        ctx.fillRect(x + 28, y + 9, 2, 4);
        ctx.fillRect(x + 28, y + 19, 2, 8);
        ctx.fillStyle = 'rgba(90,70,40,0.35)'; // 錆・汚れ
        ctx.fillRect(x + 8, y + 28, 10, 6);
        return true;
      }
      case 'desk': {
        this.propShadow(ctx, x, y);
        ctx.fillStyle = '#5e4a36';
        ctx.fillRect(x + 2, y + 8, 36, 22);
        ctx.fillStyle = '#6e5840';
        ctx.fillRect(x + 2, y + 8, 36, 3);
        ctx.fillStyle = '#d6d0c0';
        ctx.save();
        ctx.translate(x + 12, y + 18);
        ctx.rotate(hash2(o.id, 1) - 0.5);
        ctx.fillRect(-5, -4, 10, 8);
        ctx.restore();
        ctx.fillStyle = '#3a3a3a';
        ctx.beginPath();
        ctx.arc(x + 30, y + 16, 3, 0, Math.PI * 2);
        ctx.fill();
        return true;
      }
      case 'bed': {
        this.propShadow(ctx, x, y);
        ctx.fillStyle = '#4a4036';
        ctx.fillRect(x + 5, y + 2, 30, 36);
        ctx.fillStyle = '#8a8676';
        ctx.fillRect(x + 7, y + 4, 26, 32);
        ctx.fillStyle = '#b9b3a0';
        ctx.fillRect(x + 9, y + 5, 22, 7); // 枕
        ctx.fillStyle = '#5e6650';
        ctx.fillRect(x + 7, y + 17, 26, 19); // 毛布
        ctx.fillStyle = 'rgba(0,0,0,0.18)';
        ctx.fillRect(x + 7, y + 17, 26, 2);
        if (hash2(o.id, 9) > 0.7) {
          ctx.fillStyle = 'rgba(80,20,15,0.5)';
          ctx.beginPath();
          ctx.ellipse(x + 22, y + 26, 6, 4, 0.5, 0, Math.PI * 2);
          ctx.fill();
        }
        return true;
      }
      case 'rubble': {
        for (let i = 0; i < 7; i++) {
          const hx = hash2(o.id, i, 1);
          const hy = hash2(o.id, i, 2);
          const sz = 4 + hash2(o.id, i, 3) * 7;
          ctx.fillStyle = 'rgba(0,0,0,0.25)';
          ctx.fillRect(x + 4 + hx * 26 + 2, y + 4 + hy * 26 + 3, sz, sz * 0.7);
          ctx.fillStyle = ['#6e6a62', '#5d5952', '#7d776c'][i % 3];
          ctx.fillRect(x + 4 + hx * 26, y + 4 + hy * 26, sz, sz * 0.7);
        }
        return true;
      }
      case 'sandbag': {
        ctx.fillStyle = 'rgba(0,0,0,0.3)';
        ctx.fillRect(x + 4, y + 12, 38, 26);
        for (let row = 0; row < 3; row++)
          for (let k = 0; k < 2; k++) {
            const bx = x + 2 + k * 18 + (row % 2) * 9 - 4;
            ctx.fillStyle = row === 1 ? '#8a7d5e' : '#958866';
            ctx.beginPath();
            ctx.ellipse(bx + 9, y + 10 + row * 9, 9, 5, 0, 0, Math.PI * 2);
            ctx.fill();
            ctx.strokeStyle = 'rgba(50,40,25,0.4)';
            ctx.lineWidth = 1;
            ctx.stroke();
          }
        return true;
      }
      case 'stash': {
        this.propShadow(ctx, x, y);
        ctx.fillStyle = '#4a4f55';
        ctx.fillRect(x + 3, y + 9, 34, 23);
        ctx.fillStyle = '#5c6268';
        ctx.fillRect(x + 3, y + 9, 34, 6);
        ctx.fillStyle = '#8a8270';
        ctx.fillRect(x + 3, y + 14, 34, 2);
        ctx.fillRect(x + 18, y + 13, 4, 5);
        return true;
      }
      case 'bench': {
        ctx.fillStyle = 'rgba(0,0,0,0.35)';
        ctx.fillRect(x + 6, y + 12, 36, 26);
        ctx.fillStyle = '#5a3a1e';
        ctx.fillRect(x + 3, y + 26, 4, 10);
        ctx.fillRect(x + 33, y + 26, 4, 10);
        const lg = ctx.createLinearGradient(x, y + 4, x, y + 28);
        lg.addColorStop(0, '#b07a44');
        lg.addColorStop(1, '#7a5230');
        ctx.fillStyle = lg;
        ctx.fillRect(x + 1, y + 5, 38, 23);
        ctx.strokeStyle = 'rgba(60,35,15,0.5)';
        ctx.lineWidth = 1;
        for (let i = 1; i < 4; i++) {
          ctx.beginPath();
          ctx.moveTo(x + 1, y + 5 + i * 6 + 0.5);
          ctx.lineTo(x + 39, y + 5 + i * 6 + 0.5);
          ctx.stroke();
        }
        // 工具：のこぎり・レンチ・万力
        ctx.fillStyle = '#c3ccd6';
        ctx.beginPath();
        ctx.moveTo(x + 5, y + 9);
        ctx.lineTo(x + 19, y + 9);
        ctx.lineTo(x + 19, y + 14);
        ctx.closePath();
        ctx.fill();
        ctx.fillStyle = '#7a5532';
        ctx.fillRect(x + 19, y + 8, 5, 6);
        ctx.strokeStyle = '#9aa3ad';
        ctx.lineWidth = 2.5;
        ctx.beginPath();
        ctx.moveTo(x + 24, y + 22);
        ctx.lineTo(x + 34, y + 16);
        ctx.stroke();
        ctx.fillStyle = '#4b5563';
        ctx.fillRect(x + 6, y + 18, 8, 7);
        const pulse = 0.35 + Math.sin(t * 2.5) * 0.2;
        ctx.strokeStyle = `rgba(255,216,77,${pulse})`;
        ctx.lineWidth = 2;
        ctx.strokeRect(x, y + 4, 40, 25);
        return true;
      }
      case 'woodWall':
        southFace(ctx, x, y, '#5e3c20', '#3e2614', tall);
        return false;
      case 'ironWall':
        southFace(ctx, x, y, '#4b525c', '#353a42', tall);
        return false;
      case 'tree':
        if (o.hp > 0) {
          // 木の影（葉の下・地面）
          const s = 0.85 + hash2(o.tx, o.ty, 5) * 0.4;
          ctx.fillStyle = 'rgba(0,0,0,0.3)';
          ctx.beginPath();
          ctx.ellipse(cx + 12, cy + 14, 23 * s, 17 * s, 0.4, 0, Math.PI * 2);
          ctx.fill();
          return false;
        }
        ctx.fillStyle = 'rgba(0,0,0,0.25)';
        ctx.beginPath();
        ctx.ellipse(cx + 3, cy + 4, 10, 8, 0, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = '#6b4a2b';
        ctx.beginPath();
        ctx.arc(cx, cy, 9, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = '#c19a6b';
        ctx.beginPath();
        ctx.arc(cx, cy, 6.5, 0, Math.PI * 2);
        ctx.fill();
        ctx.strokeStyle = '#8c6a44';
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.arc(cx, cy, 4, 0, Math.PI * 2);
        ctx.arc(cx, cy, 1.5, 0, Math.PI * 2);
        ctx.stroke();
        return true;
      case 'car': {
        const rot = (hash2(o.tx, o.ty) - 0.5) * 0.9;
        if (o.hp > 0) {
          ctx.save();
          ctx.translate(cx + 7, cy + 9);
          ctx.rotate(rot);
          ctx.fillStyle = 'rgba(0,0,0,0.35)';
          roundRect(ctx, -20, -12, 40, 24, 6);
          ctx.fill();
          ctx.restore();
          return false;
        }
        ctx.save();
        ctx.translate(cx, cy);
        ctx.rotate(rot);
        ctx.fillStyle = 'rgba(0,0,0,0.3)';
        ctx.fillRect(-15, -7, 34, 20);
        ctx.fillStyle = '#3a3530';
        ctx.fillRect(-17, -9, 34, 18);
        ctx.strokeStyle = '#6b5a48';
        ctx.lineWidth = 2;
        ctx.strokeRect(-15, -7, 30, 14);
        ctx.beginPath();
        ctx.moveTo(-15, 0);
        ctx.lineTo(15, 0);
        ctx.stroke();
        ctx.restore();
        return true;
      }
      default:
        return false;
    }
  }

  private propShadow(ctx: CanvasRenderingContext2D, x: number, y: number): void {
    ctx.fillStyle = 'rgba(0,0,0,0.3)';
    ctx.fillRect(x + 8, y + 10, 32, 30);
  }

  /** 揺らめく炎（加算合成） */
  private flame(ctx: CanvasRenderingContext2D, x: number, y: number, s: number, t: number): void {
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    const g = ctx.createRadialGradient(x, y, 0, x, y, 22 * s);
    g.addColorStop(0, 'rgba(255,150,50,0.45)');
    g.addColorStop(1, 'rgba(255,90,20,0)');
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(x, y, 22 * s, 0, Math.PI * 2);
    ctx.fill();
    const cols = ['rgba(255,80,20,0.85)', 'rgba(255,160,40,0.85)', 'rgba(255,235,160,0.95)'];
    for (let i = 0; i < 3; i++) {
      const f = Math.sin(t * 13 + i * 2.1) * 2.2 * s;
      const w = (10 - i * 3) * s;
      const h = w * (2.2 + Math.sin(t * 9 + i) * 0.25);
      ctx.fillStyle = cols[i];
      ctx.beginPath();
      ctx.moveTo(x - w, y + 2);
      ctx.quadraticCurveTo(x - w * 0.6 + f, y - h * 0.6, x + f * 1.4, y - h);
      ctx.quadraticCurveTo(x + w * 0.6 + f, y - h * 0.6, x + w, y + 2);
      ctx.closePath();
      ctx.fill();
    }
    ctx.restore();
  }

  drawTallObject(ctx: CanvasRenderingContext2D, o: ObjSnap, t: number, aim?: { a: number; flash: number }): void {
    const x = o.tx * TILE;
    const y = o.ty * TILE;
    const cx = x + TILE / 2;
    const cy = y + TILE / 2;
    const ratio = o.hp / o.maxHp;
    switch (o.kind) {
      case 'tree': {
        const sway = Math.sin(t * 1.3 + o.id) * 1.6;
        const s = 0.85 + hash2(o.tx, o.ty, 5) * 0.4;
        const hue = hash2(o.tx, o.ty, 9);
        const dark = hue > 0.66 ? '#1f3d22' : hue > 0.33 ? '#24401c' : '#2a3a18';
        const mid = hue > 0.66 ? '#2f5a30' : hue > 0.33 ? '#365a26' : '#3f5222';
        const light = hue > 0.66 ? '#4a7c44' : hue > 0.33 ? '#527c36' : '#5d7432';
        ctx.fillStyle = '#4a321c';
        ctx.beginPath();
        ctx.arc(cx + 2, cy + 3, 5, 0, Math.PI * 2);
        ctx.fill();
        // 葉の塊（外周 → 内側 → ハイライト）
        const lobes = 6;
        ctx.fillStyle = dark;
        for (let i = 0; i < lobes; i++) {
          const a = (i / lobes) * Math.PI * 2 + hash2(o.tx, o.ty, i) * 0.6;
          const r = 13 * s;
          ctx.beginPath();
          ctx.arc(cx + Math.cos(a) * r * 0.75 + sway, cy + Math.sin(a) * r * 0.7, (10 + hash2(o.tx, o.ty, i + 20) * 4) * s, 0, Math.PI * 2);
          ctx.fill();
        }
        ctx.fillStyle = mid;
        ctx.beginPath();
        ctx.arc(cx + sway * 1.2 - 2, cy - 2, 15 * s, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = light;
        for (let i = 0; i < 3; i++) {
          ctx.beginPath();
          ctx.arc(cx + sway * 1.4 - 6 + i * 4 - hash2(o.tx, o.ty, i + 40) * 3, cy - 7 + i * 2, (6 - i) * s, 0, Math.PI * 2);
          ctx.fill();
        }
        ctx.fillStyle = 'rgba(255,255,220,0.12)';
        ctx.beginPath();
        ctx.arc(cx + sway * 1.5 - 7, cy - 9, 4 * s, 0, Math.PI * 2);
        ctx.fill();
        if (ratio < 1) {
          ctx.fillStyle = 'rgba(200,150,90,0.7)';
          ctx.fillRect(cx - 3, cy + 6, 6, 3);
        }
        break;
      }
      case 'car': {
        const palette = ['#8a3e30', '#3e5f7a', '#6d6a3a', '#5a5f66', '#8a6630', '#3d5e48'];
        const col = palette[Math.floor(hash2(o.tx, o.ty, 2) * palette.length)];
        ctx.save();
        ctx.translate(cx, cy);
        ctx.rotate((hash2(o.tx, o.ty) - 0.5) * 0.9);
        // タイヤ
        ctx.fillStyle = '#151515';
        for (const [tx2, ty2] of [[-14, -13], [7, -13], [-14, 9], [7, 9]]) roundRect(ctx, tx2, ty2, 8, 4, 1.5), ctx.fill();
        // 車体
        const bg = ctx.createLinearGradient(0, -11, 0, 11);
        bg.addColorStop(0, shade(col, 0.15));
        bg.addColorStop(1, shade(col, -0.35));
        ctx.fillStyle = bg;
        roundRect(ctx, -20, -11, 40, 22, 6);
        ctx.fill();
        ctx.strokeStyle = shade(col, -0.55);
        ctx.lineWidth = 1;
        ctx.stroke();
        // 錆
        ctx.fillStyle = 'rgba(120,64,30,0.55)';
        for (let i = 0; i < 3; i++) {
          ctx.beginPath();
          ctx.arc(-14 + hash2(o.tx, o.ty, 30 + i) * 28, -7 + hash2(o.tx, o.ty, 40 + i) * 14, 2 + hash2(o.tx, o.ty, 50 + i) * 3, 0, Math.PI * 2);
          ctx.fill();
        }
        // ルーフとガラス
        ctx.fillStyle = shade(col, -0.15);
        roundRect(ctx, -9, -8, 15, 16, 3);
        ctx.fill();
        ctx.fillStyle = '#1b252e';
        ctx.fillRect(6, -8, 5, 16); // フロントガラス
        ctx.fillRect(-13, -7, 4, 14); // リアガラス
        ctx.fillStyle = 'rgba(170,210,230,0.3)';
        ctx.fillRect(7, -7, 1.5, 14);
        if (hash2(o.tx, o.ty, 60) > 0.5) {
          ctx.strokeStyle = 'rgba(220,230,240,0.5)';
          ctx.beginPath();
          ctx.moveTo(7, -6);
          ctx.lineTo(10, 1);
          ctx.lineTo(8, 6);
          ctx.stroke();
        }
        ctx.fillStyle = 'rgba(255,240,200,0.6)';
        ctx.fillRect(18, -9, 2, 4);
        ctx.fillRect(18, 5, 2, 4);
        ctx.fillStyle = 'rgba(255,255,255,0.12)';
        ctx.fillRect(-18, -10, 36, 2);
        if (ratio < 0.7) cracks(ctx, -20, -20, ratio, o.id);
        ctx.restore();
        break;
      }
      case 'turret': {
        const a = aim?.a ?? -Math.PI / 2 + Math.sin(t * 0.8 + o.id) * 0.6;
        ctx.save();
        ctx.translate(cx, cy);
        ctx.rotate(a);
        ctx.fillStyle = '#1b1f26';
        roundRect(ctx, 2, -4, 22, 8, 2);
        ctx.fill();
        ctx.fillStyle = '#4b5563';
        ctx.fillRect(4, -3, 18, 2);
        ctx.fillStyle = '#20252d';
        roundRect(ctx, -9, -9, 18, 18, 4);
        ctx.fill();
        ctx.fillStyle = '#5f6b7a';
        roundRect(ctx, -8, -8, 16, 16, 4);
        ctx.fill();
        ctx.fillStyle = 'rgba(255,255,255,0.18)';
        ctx.fillRect(-7, -7, 14, 2);
        if (aim && aim.flash > 0) {
          ctx.globalCompositeOperation = 'lighter';
          ctx.fillStyle = 'rgba(255,220,130,0.95)';
          ctx.beginPath();
          ctx.moveTo(24, -4);
          ctx.lineTo(36, 0);
          ctx.lineTo(24, 4);
          ctx.closePath();
          ctx.fill();
          ctx.globalCompositeOperation = 'source-over';
        }
        ctx.restore();
        // 残弾ランプ
        const ammo = o.ready / 60;
        ctx.fillStyle = ammo > 0.3 ? '#5bff8c' : ammo > 0 ? '#ffd84d' : '#ff4646';
        ctx.beginPath();
        ctx.arc(cx, cy, 2.5, 0, Math.PI * 2);
        ctx.fill();
        cracks(ctx, x, y, ratio, o.id);
        break;
      }
      case 'stone': {
        ctx.fillStyle = '#6a6762';
        ctx.fillRect(x, y, TILE, TILE);
        for (let i = 0; i < 4; i++) {
          const bx = x + (i % 2) * 20 + 1;
          const by = y + Math.floor(i / 2) * 20 + 1;
          const v = hash2(o.tx * 2 + (i % 2), o.ty * 2 + (i >> 1), 6);
          ctx.fillStyle = `rgb(${120 + v * 20},${116 + v * 18},${110 + v * 16})`;
          ctx.fillRect(bx, by, 18, 18);
          ctx.fillStyle = 'rgba(255,255,255,0.1)';
          ctx.fillRect(bx, by, 18, 2);
          ctx.fillStyle = 'rgba(0,0,0,0.15)';
          ctx.fillRect(bx, by + 16, 18, 2);
        }
        cracks(ctx, x, y, ratio, o.id);
        break;
      }
      case 'woodWall': {
        ctx.fillStyle = '#5a3a1e';
        ctx.fillRect(x, y, TILE, TILE);
        for (let i = 0; i < 4; i++) {
          const v = hash2(o.tx, o.ty * 4 + i, 3);
          ctx.fillStyle = `rgb(${150 + v * 25},${100 + v * 18},${55 + v * 12})`;
          ctx.fillRect(x + 1, y + 1 + i * 10, TILE - 2, 8);
          ctx.strokeStyle = 'rgba(90,55,25,0.45)';
          ctx.lineWidth = 1;
          ctx.beginPath();
          ctx.moveTo(x + 3, y + 4 + i * 10 + v * 3);
          ctx.quadraticCurveTo(x + 20, y + 3 + i * 10, x + TILE - 3, y + 5 + i * 10);
          ctx.stroke();
        }
        ctx.fillStyle = 'rgba(255,230,190,0.15)';
        ctx.fillRect(x, y, TILE, 2);
        ctx.fillStyle = '#cfcfcf';
        for (let i = 0; i < 4; i++) {
          ctx.fillRect(x + 5, y + 4 + i * 10, 2, 2);
          ctx.fillRect(x + TILE - 7, y + 4 + i * 10, 2, 2);
        }
        cracks(ctx, x, y, ratio, o.id);
        break;
      }
      case 'ironWall': {
        const g = ctx.createLinearGradient(x, y, x + TILE, y + TILE);
        g.addColorStop(0, '#a3aebb');
        g.addColorStop(1, '#5d6672');
        ctx.fillStyle = g;
        ctx.fillRect(x, y, TILE, TILE);
        ctx.strokeStyle = '#3d444d';
        ctx.lineWidth = 2;
        ctx.strokeRect(x + 2, y + 2, TILE - 4, TILE - 4);
        ctx.beginPath();
        ctx.moveTo(x + 4, y + TILE / 2);
        ctx.lineTo(x + TILE - 4, y + TILE / 2);
        ctx.stroke();
        ctx.fillStyle = 'rgba(255,255,255,0.25)';
        ctx.fillRect(x + 3, y + 3, TILE - 6, 1.5);
        ctx.fillStyle = '#d8dee6';
        for (const [dx, dy] of [[6, 6], [TILE - 8, 6], [6, TILE - 8], [TILE - 8, TILE - 8]]) {
          ctx.beginPath();
          ctx.arc(x + dx + 1, y + dy + 1, 1.8, 0, Math.PI * 2);
          ctx.fill();
        }
        cracks(ctx, x, y, ratio, o.id);
        break;
      }
      default:
        break;
    }
  }

  // ---------------- ゾンビ ----------------

  drawZombie(ctx: CanvasRenderingContext2D, z: ZombieSnap, anim: ZombieAnim, t: number): void {
    const st = ZOMBIE[z.type];
    const r = st.radius;
    const flash = z.flash > 0;
    const id = z.id;
    const shirt = flash ? '#fff' : SHIRTS[id % SHIRTS.length];
    const pants = PANTS[(id >> 2) % PANTS.length];
    const skinBase = st.skin;
    const skin = flash ? '#fff' : hash2(id, 1) > 0.5 ? skinBase : shade(skinBase, -0.12);
    const outline = 'rgba(15,18,12,0.85)';
    const mv = Math.min(1, anim.move);
    const wcyc = anim.walk;

    ctx.save();
    ctx.translate(z.x, z.y);
    // 影
    ctx.fillStyle = 'rgba(0,0,0,0.32)';
    ctx.beginPath();
    ctx.ellipse(4, 6, r * 1.1, r * 0.85, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.rotate(z.angle);
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';

    if (z.type === 'brute') {
      // ---- ブルート：幅広い肩・巨大な腕と拳 ----
      const step = Math.sin(wcyc) * r * 0.3 * mv;
      ctx.fillStyle = pants;
      ctx.beginPath();
      ctx.ellipse(step - 2, -r * 0.42, r * 0.38, r * 0.24, 0, 0, Math.PI * 2);
      ctx.ellipse(-step - 2, r * 0.42, r * 0.38, r * 0.24, 0, 0, Math.PI * 2);
      ctx.fill();
      const reach = anim.lunge * r * 0.7;
      for (const side of [-1, 1]) {
        const swingA = Math.sin(wcyc + (side > 0 ? Math.PI : 0)) * 0.15 * mv;
        const ax = r * 0.75 + reach + Math.cos(swingA) * 2;
        const ay = side * (r * 0.78 + swingA * r);
        ctx.strokeStyle = outline;
        ctx.lineWidth = r * 0.52 + 2;
        ctx.beginPath();
        ctx.moveTo(0, side * r * 0.62);
        ctx.lineTo(ax, ay);
        ctx.stroke();
        ctx.strokeStyle = skin;
        ctx.lineWidth = r * 0.52;
        ctx.stroke();
        ctx.fillStyle = flash ? '#fff' : shade(skinBase, -0.25);
        ctx.beginPath();
        ctx.arc(ax + 2, ay, r * 0.3, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.fillStyle = outline;
      roundRect(ctx, -r * 0.62, -r * 0.92, r * 1.12, r * 1.84, r * 0.4);
      ctx.fill();
      ctx.fillStyle = flash ? '#fff' : '#3d4630';
      roundRect(ctx, -r * 0.58, -r * 0.88, r * 1.04, r * 1.76, r * 0.38);
      ctx.fill();
      ctx.fillStyle = flash ? '#fff' : 'rgba(0,0,0,0.25)';
      ctx.fillRect(-r * 0.3, -r * 0.7, r * 0.12, r * 1.4); // 背骨の影
      ctx.strokeStyle = 'rgba(120,20,20,0.6)';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(-r * 0.2, -r * 0.5);
      ctx.lineTo(r * 0.2, -r * 0.1);
      ctx.stroke();
      // 小さな頭
      ctx.fillStyle = outline;
      ctx.beginPath();
      ctx.arc(r * 0.38, 0, r * 0.33, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = skin;
      ctx.beginPath();
      ctx.arc(r * 0.38, 0, r * 0.29, 0, Math.PI * 2);
      ctx.fill();
    } else if (z.type === 'runner') {
      // ---- ランナー：細身・前傾・腕を交互に振る ----
      const step = Math.sin(wcyc * 1.3) * r * 0.55 * mv;
      ctx.fillStyle = pants;
      ctx.beginPath();
      ctx.ellipse(step, -r * 0.3, r * 0.42, r * 0.17, 0, 0, Math.PI * 2);
      ctx.ellipse(-step, r * 0.3, r * 0.42, r * 0.17, 0, 0, Math.PI * 2);
      ctx.fill();
      for (const side of [-1, 1]) {
        const swing = Math.sin(wcyc * 1.3 + (side > 0 ? 0 : Math.PI)) * r * 0.7 * mv + anim.lunge * r * 0.9;
        ctx.strokeStyle = outline;
        ctx.lineWidth = r * 0.26 + 2;
        ctx.beginPath();
        ctx.moveTo(r * 0.1, side * r * 0.5);
        ctx.lineTo(r * 0.2 + swing, side * r * 0.62);
        ctx.stroke();
        ctx.strokeStyle = skin;
        ctx.lineWidth = r * 0.26;
        ctx.stroke();
      }
      ctx.fillStyle = outline;
      ctx.beginPath();
      ctx.ellipse(0, 0, r * 0.52, r * 0.72, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = shirt;
      ctx.beginPath();
      ctx.ellipse(0, 0, r * 0.46, r * 0.66, 0, 0, Math.PI * 2);
      ctx.fill();
      // 破れたシャツ
      ctx.fillStyle = flash ? '#fff' : skin;
      ctx.beginPath();
      ctx.moveTo(-r * 0.1, r * 0.2);
      ctx.lineTo(r * 0.15, r * 0.5);
      ctx.lineTo(-r * 0.25, r * 0.55);
      ctx.closePath();
      ctx.fill();
      ctx.fillStyle = outline;
      ctx.beginPath();
      ctx.arc(r * 0.5, 0, r * 0.4, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = skin;
      ctx.beginPath();
      ctx.arc(r * 0.5, 0, r * 0.35, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = flash ? '#fff' : '#2b2018';
      ctx.beginPath();
      ctx.arc(r * 0.4, 0, r * 0.3, Math.PI * 0.55, Math.PI * 1.45);
      ctx.fill();
    } else {
      // ---- ウォーカー：猫背・片腕を前に突き出してよろめく ----
      const step = Math.sin(wcyc) * r * 0.35 * mv;
      const lurch = Math.sin(wcyc * 0.5 + id) * 0.12;
      ctx.rotate(lurch);
      ctx.fillStyle = pants;
      ctx.beginPath();
      ctx.ellipse(step, -r * 0.38, r * 0.36, r * 0.2, 0, 0, Math.PI * 2);
      ctx.ellipse(-step * 0.6, r * 0.38, r * 0.36, r * 0.2, 0, 0, Math.PI * 2);
      ctx.fill();
      const reach = anim.lunge * r * 0.7;
      const sway = Math.sin(t * 2.4 + id) * 2.5;
      const arms: [number, number, number][] = [
        [-1, r * 1.05 + reach, -r * 0.55 + sway],
        [1, r * (hash2(id, 3) > 0.5 ? 0.6 : 1.0) + reach, r * 0.55 - sway],
      ];
      for (const [side, ax, ay] of arms) {
        ctx.strokeStyle = outline;
        ctx.lineWidth = r * 0.3 + 2;
        ctx.beginPath();
        ctx.moveTo(r * 0.05, side * r * 0.58);
        ctx.lineTo(ax, ay);
        ctx.stroke();
        ctx.strokeStyle = skin;
        ctx.lineWidth = r * 0.3;
        ctx.stroke();
      }
      ctx.fillStyle = outline;
      ctx.beginPath();
      ctx.ellipse(-r * 0.12, 0, r * 0.62, r * 0.84, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = shirt;
      ctx.beginPath();
      ctx.ellipse(-r * 0.12, 0, r * 0.56, r * 0.78, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = flash ? '#fff' : 'rgba(100,12,12,0.6)';
      ctx.beginPath();
      ctx.ellipse(-r * 0.2 + (id % 5) - 2, r * 0.25, r * 0.22, r * 0.16, 0.6, 0, Math.PI * 2);
      ctx.fill();
      // 頭（少し傾く）
      const hx = r * 0.18;
      const hy = Math.sin(id) * r * 0.12;
      ctx.fillStyle = outline;
      ctx.beginPath();
      ctx.arc(hx, hy, r * 0.47, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = skin;
      ctx.beginPath();
      ctx.arc(hx, hy, r * 0.42, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = flash ? '#fff' : hash2(id, 7) > 0.5 ? '#3a3026' : '#5a4a36';
      ctx.beginPath();
      ctx.arc(hx - r * 0.08, hy, r * 0.36, Math.PI * 0.6, Math.PI * 1.4);
      ctx.fill();
    }

    // 目
    const ex = z.type === 'brute' ? r * 0.56 : z.type === 'runner' ? r * 0.75 : r * 0.48;
    const ey = z.type === 'brute' ? r * 0.12 : r * 0.15;
    ctx.fillStyle = z.alert === 2 ? '#e86a4a' : '#d8d070';
    ctx.beginPath();
    ctx.arc(ex, -ey, r * 0.08 + 0.5, 0, Math.PI * 2);
    ctx.arc(ex, ey, r * 0.08 + 0.5, 0, Math.PI * 2);
    ctx.fill();

    // 攻撃のひっかき
    if (anim.lunge > 0.35) {
      ctx.strokeStyle = `rgba(255,220,220,${(anim.lunge - 0.35) * 1.2})`;
      ctx.lineWidth = 2;
      for (let i = -1; i <= 1; i++) {
        ctx.beginPath();
        ctx.arc(r * 0.4, i * 4, r * 1.5, -0.5, 0.5);
        ctx.stroke();
      }
    }
    ctx.restore();
  }

  drawCorpse(ctx: CanvasRenderingContext2D, c: Corpse): void {
    const st = ZOMBIE[c.type];
    const r = st.radius;
    const a = Math.min(1, c.life / 3);
    const shirt = c.type === 'brute' ? '#3d4630' : SHIRTS[c.id % SHIRTS.length];
    const skin = shade(st.skin, -0.25);
    ctx.save();
    ctx.globalAlpha = a * 0.9;
    ctx.translate(c.x, c.y);
    ctx.rotate(c.angle);
    ctx.lineCap = 'round';
    // 投げ出された手足
    ctx.strokeStyle = skin;
    ctx.lineWidth = r * 0.3;
    ctx.beginPath();
    ctx.moveTo(0, -r * 0.5);
    ctx.lineTo(r * 0.7, -r * 1.1);
    ctx.moveTo(0, r * 0.5);
    ctx.lineTo(-r * 0.2, r * 1.2);
    ctx.stroke();
    ctx.strokeStyle = PANTS[(c.id >> 2) % PANTS.length];
    ctx.lineWidth = r * 0.36;
    ctx.beginPath();
    ctx.moveTo(-r * 0.4, -r * 0.2);
    ctx.lineTo(-r * 1.3, -r * 0.5);
    ctx.moveTo(-r * 0.4, r * 0.2);
    ctx.lineTo(-r * 1.2, r * 0.6);
    ctx.stroke();
    ctx.fillStyle = shade(shirt.startsWith('#') ? shirt : '#555555', -0.35);
    ctx.beginPath();
    ctx.ellipse(-r * 0.1, 0, r * 0.75, r * 0.85, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = skin;
    ctx.beginPath();
    ctx.arc(r * 0.65, 0, r * 0.4, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }

  // ---------------- プレイヤー ----------------

  drawPlayer(ctx: CanvasRenderingContext2D, p: PlayerSnap, color: string, anim: PlayerAnim, t: number): void {
    const r = 14;
    ctx.save();
    ctx.translate(p.x, p.y);
    if (p.status === 'dead') {
      ctx.globalAlpha = 0.5;
      ctx.strokeStyle = color;
      ctx.lineWidth = 4;
      ctx.beginPath();
      ctx.moveTo(-9, -9);
      ctx.lineTo(9, 9);
      ctx.moveTo(9, -9);
      ctx.lineTo(-9, 9);
      ctx.stroke();
      ctx.restore();
      return;
    }
    const down = p.status === 'down';
    const outline = 'rgba(10,12,18,0.9)';
    ctx.fillStyle = 'rgba(0,0,0,0.35)';
    ctx.beginPath();
    ctx.ellipse(4, 6, 16, 13, 0, 0, Math.PI * 2);
    ctx.fill();

    // 足は移動方向（bodyAngle）、上半身は照準方向
    const mv = Math.min(1, anim.move);
    if (!down) {
      ctx.save();
      ctx.rotate(p.bodyAngle);
      const step = Math.sin(anim.walk) * 6 * mv;
      ctx.fillStyle = '#20252f';
      ctx.beginPath();
      ctx.ellipse(step, -5, 6, 3.6, 0, 0, Math.PI * 2);
      ctx.ellipse(-step, 5, 6, 3.6, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    }
    const bob = 1 + Math.abs(Math.sin(anim.walk)) * 0.04 * mv;
    ctx.rotate(down ? p.bodyAngle + Math.PI / 2 : p.aim);
    ctx.scale(bob, bob);
    const body = down ? '#5d6470' : color;
    const skin = '#e3c7a8';

    // バックパック（寝袋付き）
    ctx.fillStyle = outline;
    roundRect(ctx, -r - 6, -10, 14, 20, 4);
    ctx.fill();
    ctx.fillStyle = '#4e4634';
    roundRect(ctx, -r - 5, -9, 12, 18, 4);
    ctx.fill();
    ctx.fillStyle = '#5e5440';
    ctx.fillRect(-r - 4, -7, 9, 4);
    ctx.fillStyle = '#4a5440';
    roundRect(ctx, -r - 8, -9, 4, 18, 2); // 丸めた寝袋
    ctx.fill();
    ctx.fillStyle = 'rgba(0,0,0,0.25)';
    ctx.fillRect(-r - 8, -3, 4, 1.5);
    ctx.fillRect(-r - 8, 3, 4, 1.5);

    // 武器と腕
    if (!down) this.drawWeapon(ctx, p, anim, body, skin, outline, t);

    // 胴体
    ctx.fillStyle = outline;
    ctx.beginPath();
    ctx.ellipse(0, 0, 10, r + 1, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = shade(body.startsWith('#') ? body : '#888888', -0.3);
    ctx.beginPath();
    ctx.ellipse(0, 0, 9, r, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = body;
    ctx.beginPath();
    ctx.ellipse(1, -1, 7, r - 3, 0, 0, Math.PI * 2);
    ctx.fill();
    // タクティカルベスト（胸のポーチと肩のストラップ）
    if (!down) {
      ctx.fillStyle = 'rgba(30,32,26,0.85)';
      ctx.fillRect(-4, -r + 3, 3, 2 * r - 6);
      ctx.fillStyle = '#3d4234';
      roundRect(ctx, 1, -9, 5, 6, 1.5);
      ctx.fill();
      roundRect(ctx, 1, 3, 5, 6, 1.5);
      ctx.fill();
    }
    // 頭と帽子（プレイヤーごとに違う：ヘルメット / キャップ / ニット帽）
    ctx.fillStyle = outline;
    ctx.beginPath();
    ctx.arc(2, 0, 7.5, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = down ? '#b9a594' : skin;
    ctx.beginPath();
    ctx.arc(2, 0, 6.5, 0, Math.PI * 2);
    ctx.fill();
    const hat = p.id % 3;
    if (hat === 0) {
      // ヘルメット
      ctx.fillStyle = outline;
      ctx.beginPath();
      ctx.arc(0.5, 0, 8.2, 0, Math.PI * 2);
      ctx.fill();
      const hg = ctx.createRadialGradient(-1, -2, 1, 0.5, 0, 8);
      hg.addColorStop(0, '#6e7558');
      hg.addColorStop(1, '#474c38');
      ctx.fillStyle = hg;
      ctx.beginPath();
      ctx.arc(0.5, 0, 7.4, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = 'rgba(0,0,0,0.25)';
      ctx.fillRect(-4, -0.8, 9, 1.6); // ヘルメットのバンド
    } else if (hat === 1) {
      // キャップ（つば付き）
      ctx.fillStyle = shade(body.startsWith('#') ? body : '#888888', -0.4);
      ctx.beginPath();
      ctx.arc(0.5, 0, 6.8, Math.PI * 0.5, Math.PI * 1.5);
      ctx.fill();
      ctx.fillRect(0, -6.8, 3, 13.6);
      ctx.fillRect(4, -4.5, 5, 9);
    } else {
      // ニット帽
      ctx.fillStyle = '#5a4a3c';
      ctx.beginPath();
      ctx.arc(0.5, 0, 7, Math.PI * 0.45, Math.PI * 1.55);
      ctx.fill();
      ctx.fillStyle = 'rgba(255,255,255,0.08)';
      ctx.fillRect(-5, -0.8, 6, 1.6);
    }
    ctx.restore();
  }

  private drawWeapon(ctx: CanvasRenderingContext2D, p: PlayerSnap, anim: PlayerAnim, body: string, skin: string, outline: string, t: number): void {
    const arm = (x1: number, y1: number, x2: number, y2: number) => {
      ctx.strokeStyle = outline;
      ctx.lineWidth = 6;
      ctx.lineCap = 'round';
      ctx.beginPath();
      ctx.moveTo(x1, y1);
      ctx.lineTo(x2, y2);
      ctx.stroke();
      ctx.strokeStyle = shade(body.startsWith('#') ? body : '#888888', -0.15);
      ctx.lineWidth = 4;
      ctx.stroke();
      ctx.fillStyle = skin;
      ctx.beginPath();
      ctx.arc(x2, y2, 2.8, 0, Math.PI * 2);
      ctx.fill();
    };
    const held = heldWeapon(p);
    const gun = held ? (held.id === 'pistol' ? 'pistol' : held.id === 'shotgun' ? 'shotgun' : 'rifle') : null;
    if (gun && held) {
      const rc = anim.recoil;
      const long = gun !== 'pistol';
      arm(0, -8, (long ? 18 : 13) + rc, long ? -1 : -1);
      arm(0, 8, 11 + rc, 2);
      let muzzle = 30;
      if (gun === 'pistol') {
        ctx.fillStyle = outline;
        roundRect(ctx, 9 + rc, -3, 20, 7, 2);
        ctx.fill();
        ctx.fillStyle = '#2b2f37';
        roundRect(ctx, 10 + rc, -2, 18, 5, 1.5);
        ctx.fill();
        ctx.fillStyle = '#55606e';
        ctx.fillRect(12 + rc, -2, 12, 1.5);
      } else if (gun === 'rifle') {
        muzzle = 38;
        ctx.fillStyle = outline;
        roundRect(ctx, 0 + rc, -3.5, 38, 7, 2);
        ctx.fill();
        ctx.fillStyle = '#2a2e35';
        roundRect(ctx, 1 + rc, -2.5, 36, 5, 1.5);
        ctx.fill();
        ctx.fillStyle = '#1c1f24';
        ctx.fillRect(14 + rc, 2, 5, 7); // マガジン
        ctx.fillStyle = '#4b5563';
        ctx.fillRect(10 + rc, -4.5, 9, 2); // 照準器
        if (held.id === 'hunting') {
          // 狩猟ライフル：長い銃身と木製ストック
          ctx.fillStyle = '#6e4a2c';
          roundRect(ctx, 0 + rc, -3, 16, 6, 2);
          ctx.fill();
          ctx.fillStyle = outline;
          ctx.fillRect(36 + rc, -1.5, 8, 3);
          muzzle = 44;
        } else if (held.id === 'smg') {
          ctx.fillStyle = '#1c1f24';
          ctx.fillRect(16 + rc, 2, 3, 9);
        }
      } else {
        muzzle = 36;
        ctx.fillStyle = outline;
        roundRect(ctx, -2 + rc, -4, 38, 8, 2);
        ctx.fill();
        ctx.fillStyle = '#7a5232';
        roundRect(ctx, -1 + rc, -3, 14, 6, 2); // 木製ストック
        ctx.fill();
        ctx.fillStyle = '#6b7380';
        ctx.fillRect(12 + rc, -3, 23, 2.5);
        ctx.fillStyle = '#4b5260';
        ctx.fillRect(12 + rc, 0, 20, 2.5);
        ctx.fillStyle = '#8a5c33';
        ctx.fillRect(20 + rc, 1, 7, 3.5); // ポンプ
      }
      // アタッチメント
      if (held.w.scope) {
        ctx.fillStyle = outline;
        roundRect(ctx, 8 + rc, -5.5, 13, 4, 1.5);
        ctx.fill();
        ctx.fillStyle = 'rgba(150,200,220,0.7)';
        ctx.fillRect(19 + rc, -5, 1.5, 3);
      }
      if (held.w.extmag && gun !== 'shotgun') {
        ctx.fillStyle = '#1c1f24';
        ctx.fillRect((gun === 'pistol' ? 13 : 14) + rc, 3, 5, 9);
      }
      if (held.w.grip && gun !== 'pistol') {
        ctx.fillStyle = '#23262b';
        ctx.fillRect(24 + rc, 2.5, 3, 5);
      }
      if (held.w.suppressor) {
        ctx.fillStyle = outline;
        roundRect(ctx, muzzle - 1 + rc, -2.5, 11, 5, 2);
        ctx.fill();
        ctx.fillStyle = '#3a3f46';
        ctx.fillRect(muzzle + rc, -1.5, 9, 3);
        muzzle += 10;
      }
      if (anim.flash > 0) {
        const s = (0.7 + anim.flashSeed * 0.6) * (gun === 'shotgun' ? 1.5 : 1) * (held.w.suppressor ? 0.35 : 1);
        ctx.save();
        ctx.translate(muzzle + rc, 0.5);
        ctx.globalCompositeOperation = 'lighter';
        ctx.fillStyle = 'rgba(255,210,120,0.95)';
        ctx.beginPath();
        ctx.moveTo(0, -5 * s);
        ctx.lineTo(18 * s, 0);
        ctx.lineTo(0, 5 * s);
        ctx.lineTo(5 * s, 0);
        ctx.closePath();
        ctx.fill();
        if (gun === 'shotgun') {
          ctx.beginPath();
          ctx.moveTo(2, -2);
          ctx.lineTo(12 * s, -9 * s);
          ctx.lineTo(6, 0);
          ctx.lineTo(12 * s, 9 * s);
          ctx.lineTo(2, 2);
          ctx.fill();
        }
        ctx.fillStyle = 'rgba(255,255,255,0.95)';
        ctx.beginPath();
        ctx.arc(2, 0, 3.5 * s, 0, Math.PI * 2);
        ctx.fill();
        ctx.restore();
      }
    } else if (p.tool === Tool.Melee) {
      const prog = anim.swing > 0 ? 1 - anim.swing : -1;
      const ang = prog >= 0 ? -1.2 + prog * 2.4 : 0.6;
      ctx.save();
      ctx.rotate(ang);
      arm(-2, 8, 12, 4);
      ctx.strokeStyle = outline;
      ctx.lineWidth = 5;
      ctx.lineCap = 'round';
      ctx.beginPath();
      ctx.moveTo(8, 4);
      ctx.lineTo(32, 4);
      ctx.stroke();
      ctx.strokeStyle = '#8a6038';
      ctx.lineWidth = 3;
      ctx.stroke();
      ctx.fillStyle = outline;
      ctx.beginPath();
      ctx.moveTo(26, 2);
      ctx.lineTo(35, -7);
      ctx.lineTo(38, 3);
      ctx.lineTo(30, 7);
      ctx.closePath();
      ctx.fill();
      ctx.fillStyle = '#c3ccd6';
      ctx.beginPath();
      ctx.moveTo(27, 2);
      ctx.lineTo(34.5, -5.5);
      ctx.lineTo(36.5, 3);
      ctx.lineTo(30, 6);
      ctx.closePath();
      ctx.fill();
      ctx.restore();
      arm(0, -8, 8, -6);
      if (prog >= 0 && prog < 0.8) {
        ctx.strokeStyle = `rgba(255,255,255,${(1 - prog) * 0.45})`;
        ctx.lineWidth = 3;
        ctx.beginPath();
        ctx.arc(0, 0, 36, -1.2, -1.2 + prog * 2.4);
        ctx.stroke();
      }
    } else if (p.tool === Tool.Food || p.tool === Tool.Meds || p.tool === Tool.Primary || p.tool === Tool.Secondary) {
      arm(0, -8, 12, -4);
      arm(0, 8, 12, 4);
      if (p.tool === Tool.Food) {
        ctx.fillStyle = '#b8c2cc';
        ctx.fillRect(12, -4, 7, 8);
        ctx.fillStyle = '#d9534f';
        ctx.fillRect(12, -2, 7, 4);
      } else if (p.tool === Tool.Meds) {
        ctx.fillStyle = '#e8edf2';
        ctx.fillRect(11, -5, 9, 10);
        ctx.fillStyle = '#d9534f';
        ctx.fillRect(14.5, -3.5, 2, 7);
        ctx.fillRect(12.5, -1, 6, 2);
      }
    } else {
      // ハンマー（建築・修理）
      ctx.save();
      ctx.rotate(0.5 + Math.sin(t * 6) * 0.05);
      arm(-2, 8, 10, 3);
      ctx.strokeStyle = '#7a5532';
      ctx.lineWidth = 3.5;
      ctx.beginPath();
      ctx.moveTo(8, 3);
      ctx.lineTo(26, 3);
      ctx.stroke();
      ctx.fillStyle = outline;
      ctx.fillRect(22, -4, 9, 14);
      ctx.fillStyle = '#9aa3ad';
      ctx.fillRect(23, -3, 7, 12);
      ctx.restore();
      arm(0, -8, 8, -6);
    }
  }
}
