// ============================================================
// ビジュアル定義（ベクター描画）
//   ★ スプライト画像に差し替えるときは、この ArtSet インターフェースを実装した
//     別クラス（例: ImageArt で ctx.drawImage を使う）を作り、Renderer の `art` を差し替えるだけでOK。
//     Renderer 側はゲームロジック・カメラ・ライティング・HUD のみを担当する。
//   光源は左上。影は右下へ落ちる。
// ============================================================
import type { ObjSnap, PlayerSnap, ZombieSnap } from '../types';
import type { Corpse } from './Effects';
import { TILE } from './constants';
import { drawCar, drawProp, drawTreeTop } from './PropArt';
import { drawCorpse as drawCorpseNew, drawPlayer as drawPlayerNew, drawZombie as drawZombieNew } from './CharacterArt';
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
  /** 近くのプレイヤーへの近さ 0..1（腕を振り上げる予備動作） */
  near?: number;
  /** 被弾ののけぞり 0..1 */
  hit?: number;
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

/** 建てた設備は、同じ役割の既存の絵で描く（寝床＝ベッド、作業台、保管箱＝倉庫、焚き火） */
const ALIAS: Partial<Record<string, ObjSnap['kind']>> = { cot: 'bed', wbench: 'bench', sbox: 'chest', fire: 'campfire' };
function alias(o: ObjSnap): ObjSnap {
  const k = ALIAS[o.kind];
  return k ? { ...o, kind: k } : o;
}

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


// ============================================================
export class VectorArt implements ArtSet {
  bakeTerrain(world: TileWorld): BakedTerrain {
    return bakeTerrain(world);
  }

  drawLowObject(ctx: CanvasRenderingContext2D, o: ObjSnap, t: number, tall: TallQuery): boolean {
    o = alias(o);
    const x = o.tx * TILE;
    const y = o.ty * TILE;
    const cx = x + TILE / 2;
    const cy = y + TILE / 2;
    // 細かく描いたプロップ（キャッシュ）＋動く要素（未探索の光る縁）
    if (drawProp(ctx, o)) {
      if (o.ready && (o.kind === 'wcase' || o.kind === 'mcrate')) {
        const pulse = 0.25 + Math.sin(t * 3 + o.id) * 0.15;
        ctx.strokeStyle = `rgba(225,190,110,${pulse})`;
        ctx.lineWidth = 1.5;
        ctx.strokeRect(x + 1, y + (o.kind === 'wcase' ? 9 : 4), 38, o.kind === 'wcase' ? 22 : 32);
      }
      return true;
    }
    switch (o.kind) {
      case 'radio': {
        // 無線機：机の上の無線セットとアンテナ。依頼があるときはランプが点滅
        ctx.fillStyle = 'rgba(0,0,0,0.3)';
        ctx.fillRect(x + 5, y + 10, 34, 28);
        ctx.fillStyle = '#5a4630';
        ctx.fillRect(x + 2, y + 6, 36, 28);
        ctx.fillStyle = '#6e5a3e';
        ctx.fillRect(x + 2, y + 6, 36, 3);
        ctx.fillStyle = '#2f3430';
        ctx.fillRect(x + 7, y + 13, 26, 15);
        ctx.fillStyle = '#4a524a';
        ctx.fillRect(x + 8, y + 14, 24, 4);
        ctx.fillStyle = '#9fd0a0';
        ctx.fillRect(x + 10, y + 21, 10, 4);
        ctx.fillStyle = '#c8c0a0';
        ctx.beginPath();
        ctx.arc(x + 26, y + 23, 3, 0, Math.PI * 2);
        ctx.fill();
        ctx.strokeStyle = '#a0a6aa';
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.moveTo(x + 30, y + 13);
        ctx.lineTo(x + 34, y - 4);
        ctx.stroke();
        const blink = Math.sin(t * 5) > 0;
        ctx.fillStyle = blink ? '#ff6040' : '#602018';
        ctx.beginPath();
        ctx.arc(x + 34, y - 4, 2, 0, Math.PI * 2);
        ctx.fill();
        return true;
      }
      case 'raintank': {
        // 雨水タンク：青いドラム＋じょうご。水位を窓で見せる
        ctx.fillStyle = 'rgba(0,0,0,0.3)';
        ctx.beginPath();
        ctx.ellipse(cx + 4, cy + 9, 16, 8, 0, 0, Math.PI * 2);
        ctx.fill();
        const g = ctx.createLinearGradient(x + 6, 0, x + 34, 0);
        g.addColorStop(0, '#2f5470');
        g.addColorStop(0.5, '#4f7ea0');
        g.addColorStop(1, '#294a62');
        ctx.fillStyle = g;
        ctx.fillRect(x + 7, y + 10, 26, 26);
        ctx.fillStyle = '#5f90b4';
        ctx.beginPath();
        ctx.ellipse(cx, y + 10, 13, 5, 0, 0, Math.PI * 2);
        ctx.fill();
        // じょうご
        ctx.fillStyle = '#7a8088';
        ctx.beginPath();
        ctx.moveTo(cx - 12, y + 2);
        ctx.lineTo(cx + 12, y + 2);
        ctx.lineTo(cx + 4, y + 9);
        ctx.lineTo(cx - 4, y + 9);
        ctx.closePath();
        ctx.fill();
        ctx.fillStyle = 'rgba(0,0,0,0.35)';
        ctx.fillRect(x + 7, y + 22, 26, 2);
        // 水位
        const lv = Math.min(1, o.ready / 6);
        ctx.fillStyle = '#163044';
        ctx.fillRect(cx - 3, y + 14, 6, 18);
        ctx.fillStyle = '#8fd0f0';
        ctx.fillRect(cx - 3, y + 32 - 18 * lv, 6, 18 * lv);
        if (o.ready > 0) {
          ctx.fillStyle = `rgba(160,220,255,${0.25 + Math.sin(t * 3 + o.id) * 0.15})`;
          ctx.beginPath();
          ctx.ellipse(cx, y + 10, 9, 3, 0, 0, Math.PI * 2);
          ctx.fill();
        }
        return true;
      }
      case 'stove': {
        // 調理かまど：石組み＋鍋。湯気
        ctx.fillStyle = 'rgba(0,0,0,0.3)';
        ctx.beginPath();
        ctx.ellipse(cx + 4, cy + 8, 17, 9, 0, 0, Math.PI * 2);
        ctx.fill();
        for (let i = 0; i < 8; i++) {
          const a = (i / 8) * Math.PI * 2;
          ctx.fillStyle = i % 2 ? '#6c665d' : '#888175';
          ctx.beginPath();
          ctx.arc(cx + Math.cos(a) * 13, cy + 2 + Math.sin(a) * 10, 5, 0, Math.PI * 2);
          ctx.fill();
        }
        ctx.fillStyle = '#2a1a10';
        ctx.beginPath();
        ctx.ellipse(cx, cy + 2, 10, 7, 0, 0, Math.PI * 2);
        ctx.fill();
        this.flame(ctx, cx, cy + 4, 0.5, t + o.id);
        ctx.fillStyle = '#3c3f44';
        ctx.beginPath();
        ctx.ellipse(cx, cy - 3, 11, 8, 0, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = '#a07a3e';
        ctx.beginPath();
        ctx.ellipse(cx, cy - 4, 8, 5, 0, 0, Math.PI * 2);
        ctx.fill();
        ctx.strokeStyle = '#6a6e74';
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.arc(cx, cy - 3, 12, Math.PI * 1.1, Math.PI * 1.9);
        ctx.stroke();
        for (let i = 0; i < 2; i++) {
          const k = (t * 0.6 + i * 0.5 + o.id * 0.13) % 1;
          ctx.fillStyle = `rgba(230,230,230,${0.25 * (1 - k)})`;
          ctx.beginPath();
          ctx.arc(cx - 3 + i * 6 + Math.sin(t * 2 + i) * 2, cy - 8 - k * 16, 3 + k * 4, 0, Math.PI * 2);
          ctx.fill();
        }
        if (o.hp < o.maxHp) cracks(ctx, x, y, o.hp / o.maxHp, o.id);
        return true;
      }
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
      case 'bag': {
        // 落ちている袋（ダッフルバッグ）
        ctx.fillStyle = 'rgba(0,0,0,0.3)';
        ctx.beginPath();
        ctx.ellipse(cx + 3, cy + 6, 14, 8, 0.2, 0, Math.PI * 2);
        ctx.fill();
        ctx.save();
        ctx.translate(cx, cy);
        ctx.rotate(((o.id * 37) % 10) / 10 - 0.5);
        ctx.fillStyle = '#4a4a36';
        roundRect(ctx, -13, -7, 26, 14, 6);
        ctx.fill();
        ctx.strokeStyle = '#2c2c20';
        ctx.lineWidth = 1.5;
        ctx.stroke();
        ctx.fillStyle = '#5c5c44';
        ctx.fillRect(-11, -5, 22, 3);
        ctx.strokeStyle = '#8a7a50';
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(-5, -7);
        ctx.quadraticCurveTo(0, -13, 5, -7);
        ctx.stroke();
        ctx.restore();
        const pulse = 0.35 + Math.sin(t * 4 + o.id) * 0.25;
        ctx.strokeStyle = `rgba(230,210,140,${pulse})`;
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.arc(cx, cy, 17, 0, Math.PI * 2);
        ctx.stroke();
        return true;
      }
      case 'drop': {
        // 補給物資：パラシュート付きの金属コンテナ
        ctx.fillStyle = 'rgba(0,0,0,0.35)';
        ctx.fillRect(x + 6, y + 10, 34, 28);
        if (o.ready) {
          ctx.fillStyle = 'rgba(200,190,170,0.55)';
          ctx.beginPath();
          ctx.ellipse(x + 34, y + 30, 18, 9, 0.6, 0, Math.PI * 2);
          ctx.fill();
          ctx.strokeStyle = 'rgba(80,70,60,0.6)';
          ctx.lineWidth = 1;
          ctx.beginPath();
          ctx.moveTo(x + 24, y + 22);
          ctx.lineTo(x + 34, y + 30);
          ctx.moveTo(x + 30, y + 16);
          ctx.lineTo(x + 40, y + 26);
          ctx.stroke();
        }
        const lg = ctx.createLinearGradient(x, y + 4, x, y + 34);
        lg.addColorStop(0, o.ready ? '#6d7a86' : '#4a525a');
        lg.addColorStop(1, o.ready ? '#4a5660' : '#33393f');
        ctx.fillStyle = lg;
        roundRect(ctx, x + 2, y + 4, 36, 30, 3);
        ctx.fill();
        ctx.strokeStyle = '#262c32';
        ctx.lineWidth = 2;
        ctx.stroke();
        ctx.fillStyle = o.ready ? '#c0503a' : '#6b3a30';
        ctx.fillRect(x + 2, y + 16, 36, 5);
        ctx.fillStyle = '#e8e0c8';
        ctx.fillRect(x + 16, y + 8, 8, 3);
        ctx.fillRect(x + 18.5, y + 6, 3, 7);
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
      case 'barrel': {
        // 燃料のドラム缶（赤錆・危険マーク）
        ctx.fillStyle = 'rgba(0,0,0,0.35)';
        ctx.beginPath();
        ctx.ellipse(cx + 5, cy + 7, 15, 13, 0, 0, Math.PI * 2);
        ctx.fill();
        const g = ctx.createRadialGradient(cx - 5, cy - 5, 2, cx, cy, 16);
        g.addColorStop(0, '#b0543a');
        g.addColorStop(1, '#6a2a1c');
        ctx.fillStyle = g;
        ctx.beginPath();
        ctx.arc(cx, cy, 15, 0, Math.PI * 2);
        ctx.fill();
        ctx.strokeStyle = '#3a1810';
        ctx.lineWidth = 2;
        ctx.stroke();
        ctx.strokeStyle = 'rgba(30,14,10,0.6)';
        ctx.lineWidth = 1.2;
        ctx.beginPath();
        ctx.arc(cx, cy, 10, 0, Math.PI * 2);
        ctx.stroke();
        // 注ぎ口
        ctx.fillStyle = '#2a1a14';
        ctx.beginPath();
        ctx.arc(cx + 6, cy - 6, 2.5, 0, Math.PI * 2);
        ctx.fill();
        // 危険マーク（黄色い三角）
        ctx.fillStyle = '#d8b040';
        ctx.beginPath();
        ctx.moveTo(cx - 4, cy + 5);
        ctx.lineTo(cx + 4, cy + 5);
        ctx.lineTo(cx, cy - 2);
        ctx.closePath();
        ctx.fill();
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
          // 2重の影でやわらかい縁（毎フレームなので blur フィルタは使わない）
          ctx.fillStyle = 'rgba(0,0,0,0.2)';
          roundRect(ctx, -23, -14, 46, 28, 9);
          ctx.fill();
          ctx.fillStyle = 'rgba(0,0,0,0.3)';
          roundRect(ctx, -20, -11, 40, 22, 6);
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
    o = alias(o);
    const x = o.tx * TILE;
    const y = o.ty * TILE;
    const cx = x + TILE / 2;
    const cy = y + TILE / 2;
    const ratio = o.hp / o.maxHp;
    switch (o.kind) {
      case 'tree': {
        if (ratio > 0) {
          drawTreeTop(ctx, o, t);
          break;
        }
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
        if (o.ready >= 0) {
          drawCar(ctx, o);
          break;
        }
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
    drawZombieNew(ctx, z, anim, t);
  }

  drawCorpse(ctx: CanvasRenderingContext2D, c: Corpse): void {
    drawCorpseNew(ctx, c);
  }

  // ---------------- プレイヤー ----------------

  drawPlayer(ctx: CanvasRenderingContext2D, p: PlayerSnap, color: string, anim: PlayerAnim, t: number): void {
    drawPlayerNew(ctx, p, color, anim, t);
  }
}
