// ============================================================
// 建物内外のプロップ（家具・入れ物・土嚢など）の描き込み
//   1つずつ細かく描くと重いので、種類・状態・柄違いごとにオフスクリーンへ
//   2倍解像度で焼き込み（キャッシュ）して、毎フレームは drawImage するだけ。
//   光源は左上。天面の縁にハイライト、右下に落ち影。
// ============================================================
import type { ObjSnap } from '../types';
import { TILE } from './constants';

const PAD = 8;
const SIZE = TILE + PAD * 2;
const RES = 2;
const cache = new Map<string, HTMLCanvasElement>();

function h(x: number, y: number, s = 0): number {
  let v = (x * 374761393 + y * 668265263 + s * 1442695041) | 0;
  v = Math.imul(v ^ (v >>> 13), 1274126177);
  v ^= v >>> 16;
  return (v >>> 0) / 4294967296;
}

function rr(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, hh: number, r: number): void {
  const k = Math.min(r, w / 2, hh / 2);
  ctx.beginPath();
  ctx.moveTo(x + k, y);
  ctx.arcTo(x + w, y, x + w, y + hh, k);
  ctx.arcTo(x + w, y + hh, x, y + hh, k);
  ctx.arcTo(x, y + hh, x, y, k);
  ctx.arcTo(x, y, x + w, y, k);
  ctx.closePath();
}

function grad(ctx: CanvasRenderingContext2D, x0: number, y0: number, x1: number, y1: number, a: string, b: string): CanvasGradient {
  const g = ctx.createLinearGradient(x0, y0, x1, y1);
  g.addColorStop(0, a);
  g.addColorStop(1, b);
  return g;
}

/** 右下へのぼかした落ち影 */
function shadow(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, hh: number, a = 0.45): void {
  ctx.save();
  ctx.filter = 'blur(2.5px)';
  ctx.fillStyle = `rgba(0,0,0,${a})`;
  rr(ctx, x + 4, y + 5, w, hh, 3);
  ctx.fill();
  ctx.restore();
}

/** 天面の箱：縁のハイライト＋下辺の暗い縁＋輪郭 */
function box(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, hh: number, top: string, bottom: string, r = 2, edge = 'rgba(12,12,10,0.85)'): void {
  rr(ctx, x, y, w, hh, r);
  ctx.fillStyle = grad(ctx, x, y, x + w * 0.3, y + hh, top, bottom);
  ctx.fill();
  ctx.strokeStyle = edge;
  ctx.lineWidth = 1;
  ctx.stroke();
  ctx.fillStyle = 'rgba(255,250,230,0.16)';
  ctx.fillRect(x + 1.5, y + 1, w - 3, 1);
  ctx.fillRect(x + 1, y + 1.5, 1, hh - 3);
  ctx.fillStyle = 'rgba(0,0,0,0.25)';
  ctx.fillRect(x + 1.5, y + hh - 2, w - 3, 1.2);
}

function scratches(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, hh: number, seed: number, n: number, color = 'rgba(255,255,255,0.08)'): void {
  ctx.strokeStyle = color;
  ctx.lineWidth = 0.6;
  for (let i = 0; i < n; i++) {
    const sx = x + h(seed, i, 1) * w;
    const sy = y + h(seed, i, 2) * hh;
    ctx.beginPath();
    ctx.moveTo(sx, sy);
    ctx.lineTo(sx + (h(seed, i, 3) - 0.5) * 8, sy + (h(seed, i, 4) - 0.5) * 4);
    ctx.stroke();
  }
}

function rust(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, hh: number, seed: number, n = 3): void {
  for (let i = 0; i < n; i++) {
    const g = ctx.createRadialGradient(0, 0, 0, 0, 0, 4 + h(seed, i, 5) * 4);
    g.addColorStop(0, 'rgba(120,60,25,0.45)');
    g.addColorStop(1, 'rgba(120,60,25,0)');
    ctx.save();
    ctx.translate(x + h(seed, i, 6) * w, y + h(seed, i, 7) * hh);
    ctx.fillStyle = g;
    ctx.fillRect(-8, -8, 16, 16);
    ctx.restore();
  }
}

// ---------------- 種類ごとの描画（タイル左上 = 0,0） ----------------

type Painter = (ctx: CanvasRenderingContext2D, ready: number, v: number, seed: number) => void;

const PAINT: Record<string, Painter> = {
  shelf(ctx, ready, _v, seed) {
    shadow(ctx, 3, 5, 34, 30);
    box(ctx, 3, 5, 34, 30, '#5b574d', '#3a3833');
    // 3段の棚板
    for (let k = 0; k < 3; k++) {
      ctx.fillStyle = '#2a2925';
      ctx.fillRect(5, 9 + k * 9, 30, 7);
      ctx.fillStyle = 'rgba(255,240,210,0.12)';
      ctx.fillRect(5, 15 + k * 9, 30, 1);
    }
    // 商品（未探索だと多い）
    const n = ready ? 9 : 3;
    const cols = ['#8a7656', '#6b7a5a', '#9a8a6a', '#5e6e78', '#8d5a46', '#b0a070', '#6a5a4a'];
    for (let i = 0; i < n; i++) {
      const row = i % 3;
      const px = 6 + h(seed, i, 3) * 23;
      const w = 3 + h(seed, i, 4) * 4;
      ctx.fillStyle = cols[i % cols.length];
      ctx.fillRect(px, 10 + row * 9, w, 5.5);
      ctx.fillStyle = 'rgba(255,255,255,0.22)';
      ctx.fillRect(px, 10 + row * 9, w, 1);
      if (i % 3 === 0) {
        ctx.fillStyle = '#c8c2b0';
        ctx.fillRect(px + 1, 12 + row * 9, w - 2, 1.5); // ラベル
      }
    }
    // 柱
    ctx.fillStyle = '#6a665c';
    ctx.fillRect(3, 5, 2, 30);
    ctx.fillRect(35, 5, 2, 30);
  },
  cabinet(ctx, ready, _v, seed) {
    shadow(ctx, 5, 5, 30, 30);
    box(ctx, 5, 5, 30, 30, '#c9c6ba', '#8f8c82');
    ctx.strokeStyle = 'rgba(60,58,52,0.55)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(20, 7);
    ctx.lineTo(20, 33);
    ctx.stroke();
    // ガラス戸越しの薬瓶
    ctx.fillStyle = 'rgba(120,150,150,0.35)';
    ctx.fillRect(8, 8, 10, 14);
    ctx.fillRect(22, 8, 10, 14);
    const n = ready ? 6 : 2;
    for (let i = 0; i < n; i++) {
      ctx.fillStyle = ['#d9d4c0', '#c46a4a', '#e0b860', '#7aa0a8'][i % 4];
      ctx.beginPath();
      ctx.arc(10 + (i % 3) * 3.5 + (i > 2 ? 14 : 0), 12 + h(seed, i) * 7, 1.4, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.fillStyle = 'rgba(255,255,255,0.35)';
    ctx.fillRect(9, 9, 1, 12);
    ctx.fillRect(23, 9, 1, 12);
    // 赤十字
    ctx.fillStyle = '#9e3a2e';
    ctx.fillRect(17, 25, 6, 2);
    ctx.fillRect(19, 23, 2, 6);
    ctx.fillStyle = '#6a685f';
    ctx.fillRect(18, 15, 1, 4);
    ctx.fillRect(21, 15, 1, 4);
    rust(ctx, 5, 26, 30, 8, seed, 2);
  },
  locker(ctx, ready, _v, seed) {
    shadow(ctx, 4, 3, 32, 34);
    box(ctx, 4, 3, 32, 34, '#68745e', '#3e4639');
    // 2枚扉
    ctx.strokeStyle = 'rgba(20,24,18,0.7)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(20, 4);
    ctx.lineTo(20, 36);
    ctx.stroke();
    // 通気スリット
    ctx.fillStyle = '#262c22';
    for (let i = 0; i < 4; i++) {
      ctx.fillRect(8, 8 + i * 2.6, 9, 1.1);
      ctx.fillRect(23, 8 + i * 2.6, 9, 1.1);
    }
    // 名札と取っ手
    ctx.fillStyle = '#d8d2bc';
    ctx.fillRect(9, 20, 6, 3);
    ctx.fillRect(25, 20, 6, 3);
    ctx.fillStyle = '#b8ae90';
    ctx.fillRect(17, 25, 1.6, 5);
    ctx.fillRect(21.5, 25, 1.6, 5);
    if (!ready) {
      // 開けっぱなしの扉
      ctx.fillStyle = '#1b1e18';
      ctx.fillRect(21, 5, 13, 30);
      ctx.fillStyle = '#525c49';
      ctx.fillRect(33, 4, 3, 32);
    }
    scratches(ctx, 6, 6, 28, 28, seed, 6);
    rust(ctx, 4, 3, 32, 34, seed, 2);
  },
  wcase(ctx, ready, _v, seed) {
    shadow(ctx, 2, 10, 36, 20);
    box(ctx, 2, 10, 36, 20, '#4e5640', '#2c3124', 3);
    // 補強リブ
    ctx.fillStyle = 'rgba(0,0,0,0.3)';
    ctx.fillRect(4, 19, 32, 1.5);
    ctx.fillStyle = 'rgba(255,255,255,0.08)';
    ctx.fillRect(4, 18, 32, 1);
    // 留め金と取っ手
    for (const x of [8, 28]) {
      ctx.fillStyle = '#9a9278';
      ctx.fillRect(x, 17, 4, 5);
      ctx.fillStyle = '#5a5444';
      ctx.fillRect(x + 1, 18, 2, 3);
    }
    ctx.fillStyle = '#1d2018';
    rr(ctx, 15, 26, 10, 3, 1.5);
    ctx.fill();
    // ステンシル
    ctx.fillStyle = 'rgba(220,210,170,0.6)';
    ctx.font = 'bold 5px monospace';
    ctx.fillText('ARMS', 14, 15.5);
    if (!ready) {
      ctx.fillStyle = 'rgba(0,0,0,0.5)';
      ctx.fillRect(4, 12, 32, 6);
    }
    scratches(ctx, 3, 11, 34, 18, seed, 5);
  },
  fridge(ctx, ready, _v, seed) {
    shadow(ctx, 5, 3, 30, 34);
    box(ctx, 5, 3, 30, 34, '#d2cfc2', '#9c998d', 3);
    ctx.strokeStyle = 'rgba(70,68,60,0.6)';
    ctx.beginPath();
    ctx.moveTo(6, 14);
    ctx.lineTo(34, 14);
    ctx.stroke();
    ctx.fillStyle = '#7a776c';
    ctx.fillRect(29, 6, 2, 6);
    ctx.fillRect(29, 17, 2, 10);
    // 汚れ・錆・貼り紙
    rust(ctx, 5, 24, 30, 12, seed, 3);
    ctx.fillStyle = '#e8dca0';
    ctx.save();
    ctx.translate(12, 20);
    ctx.rotate((h(seed, 2) - 0.5) * 0.5);
    ctx.fillRect(-3, -3, 6, 6);
    ctx.restore();
    if (!ready) {
      ctx.fillStyle = 'rgba(20,20,18,0.55)';
      ctx.fillRect(7, 15, 20, 20);
    }
  },
  desk(ctx, ready, _v, seed) {
    shadow(ctx, 2, 7, 36, 24);
    // 木目の天板
    box(ctx, 2, 7, 36, 24, '#7a6046', '#4f3d2b', 2);
    ctx.strokeStyle = 'rgba(40,26,14,0.35)';
    ctx.lineWidth = 0.7;
    for (let i = 0; i < 6; i++) {
      ctx.beginPath();
      ctx.moveTo(3, 10 + i * 3.5);
      ctx.bezierCurveTo(14, 9 + i * 3.5 + h(seed, i) * 2, 26, 11 + i * 3.5, 37, 10 + i * 3.5);
      ctx.stroke();
    }
    // 書類・マグカップ・モニター
    ctx.save();
    ctx.translate(12, 18);
    ctx.rotate(h(seed, 1) - 0.5);
    ctx.fillStyle = '#e2dccb';
    ctx.fillRect(-6, -4.5, 12, 9);
    ctx.fillStyle = 'rgba(60,60,60,0.5)';
    for (let i = 0; i < 4; i++) ctx.fillRect(-4, -2.5 + i * 1.8, 8 - (i % 2) * 3, 0.6);
    ctx.restore();
    if (ready) {
      ctx.fillStyle = '#2b2d30';
      rr(ctx, 24, 10, 11, 7, 1);
      ctx.fill();
      ctx.fillStyle = '#3e4a52';
      ctx.fillRect(25, 11, 9, 5);
    }
    ctx.fillStyle = '#d8d2c0';
    ctx.beginPath();
    ctx.arc(30, 25, 2.6, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#4a3020';
    ctx.beginPath();
    ctx.arc(30, 25, 1.6, 0, Math.PI * 2);
    ctx.fill();
  },
  bed(ctx, _r, v, seed) {
    shadow(ctx, 5, 1, 30, 38);
    box(ctx, 5, 1, 30, 38, '#5a4c3e', '#3a3028', 3);
    // マットレス
    rr(ctx, 7, 3, 26, 34, 3);
    ctx.fillStyle = '#9c9888';
    ctx.fill();
    // 枕
    rr(ctx, 9, 4.5, 22, 7, 3);
    ctx.fillStyle = grad(ctx, 9, 4, 9, 12, '#d6d0bc', '#a9a390');
    ctx.fill();
    // 毛布（くしゃっとした折り目）
    const cols = ['#5e6650', '#5a5068', '#6a5446'];
    rr(ctx, 7, 15, 26, 22, 3);
    ctx.fillStyle = grad(ctx, 7, 15, 30, 37, shadeHex(cols[v % 3], 0.1), shadeHex(cols[v % 3], -0.3));
    ctx.fill();
    ctx.strokeStyle = 'rgba(0,0,0,0.25)';
    ctx.lineWidth = 1;
    for (let i = 0; i < 3; i++) {
      ctx.beginPath();
      ctx.moveTo(8, 19 + i * 6);
      ctx.quadraticCurveTo(20, 17 + i * 6 + h(seed, i) * 4, 32, 20 + i * 6);
      ctx.stroke();
    }
    ctx.fillStyle = 'rgba(255,255,255,0.1)';
    ctx.fillRect(7, 15, 26, 1.5);
    if (h(seed, 9) > 0.65) {
      ctx.fillStyle = 'rgba(80,16,12,0.55)';
      ctx.beginPath();
      ctx.ellipse(22, 27, 6, 4, 0.5, 0, Math.PI * 2);
      ctx.fill();
    }
  },
  crate(ctx, ready, _v, seed) {
    shadow(ctx, 4, 5, 32, 30);
    box(ctx, 4, 5, 32, 30, ready ? '#a47a48' : '#7a5a38', ready ? '#6c4c2a' : '#4e3a24', 1.5);
    // 板と木目
    ctx.strokeStyle = 'rgba(40,24,10,0.55)';
    ctx.lineWidth = 1;
    for (let i = 1; i < 4; i++) {
      ctx.beginPath();
      ctx.moveTo(5, 5 + i * 7.5);
      ctx.lineTo(35, 5 + i * 7.5);
      ctx.stroke();
    }
    ctx.strokeStyle = 'rgba(40,24,10,0.25)';
    ctx.lineWidth = 0.6;
    for (let i = 0; i < 8; i++) {
      const y = 7 + i * 3.6;
      ctx.beginPath();
      ctx.moveTo(6, y);
      ctx.quadraticCurveTo(20, y + (h(seed, i) - 0.5) * 2.5, 34, y);
      ctx.stroke();
    }
    // 対角の補強材と釘
    ctx.strokeStyle = ready ? '#8a6238' : '#5e4428';
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.moveTo(7, 8);
    ctx.lineTo(33, 32);
    ctx.stroke();
    ctx.fillStyle = '#3a3a38';
    for (const [x, y] of [
      [7, 8],
      [33, 8],
      [7, 32],
      [33, 32],
    ]) {
      ctx.beginPath();
      ctx.arc(x, y, 1.1, 0, Math.PI * 2);
      ctx.fill();
    }
    if (!ready) {
      ctx.fillStyle = 'rgba(0,0,0,0.45)';
      ctx.fillRect(8, 10, 24, 20);
    }
  },
  box(ctx, ready) {
    shadow(ctx, 5, 8, 30, 24);
    box(ctx, 5, 8, 30, 24, '#b39a6e', '#7e6a48', 1.5);
    // 段ボールのフラップとガムテープ
    ctx.strokeStyle = 'rgba(70,52,30,0.6)';
    ctx.beginPath();
    ctx.moveTo(20, 9);
    ctx.lineTo(20, 31);
    ctx.stroke();
    ctx.fillStyle = ready ? 'rgba(210,190,140,0.75)' : 'rgba(90,70,40,0.6)';
    ctx.fillRect(18.5, 8, 3, 24);
    ctx.fillStyle = 'rgba(50,40,30,0.7)';
    ctx.font = 'bold 5px monospace';
    ctx.fillText('SUPPLY', 7, 16);
  },
  mcrate(ctx, ready, _v, seed) {
    shadow(ctx, 3, 6, 34, 28);
    box(ctx, 3, 6, 34, 28, ready ? '#5f6d3e' : '#414a31', ready ? '#3b4625' : '#2a3022', 2);
    ctx.fillStyle = 'rgba(0,0,0,0.3)';
    ctx.fillRect(4, 19, 32, 2);
    // 縁の金具
    ctx.fillStyle = '#7a7a66';
    for (const [x, y] of [
      [3, 6],
      [33, 6],
      [3, 30],
      [33, 30],
    ])
      ctx.fillRect(x, y, 4, 4);
    ctx.fillStyle = ready ? '#e3d6a0' : '#7d7a60';
    ctx.font = 'bold 5px monospace';
    ctx.fillText('7.62 AMMO', 6, 15);
    ctx.fillText('LOT 24-B', 6, 28.5);
    ctx.fillStyle = ready ? '#b0392b' : '#6b2a24';
    ctx.fillRect(27, 23, 7, 6);
    scratches(ctx, 4, 7, 32, 26, seed, 6);
  },
  chest(ctx) {
    shadow(ctx, 4, 7, 32, 26);
    box(ctx, 4, 7, 32, 26, '#8e6034', '#5a3b1f', 3);
    ctx.fillStyle = '#4a4a46';
    ctx.fillRect(4, 13, 32, 2.5);
    ctx.fillRect(4, 26, 32, 2.5);
    ctx.fillStyle = '#c0a050';
    ctx.fillRect(18, 15, 4, 6);
    ctx.fillStyle = '#3a2a18';
    ctx.fillRect(19.2, 17, 1.6, 2.5);
  },
  stash(ctx, _r, _v, seed) {
    shadow(ctx, 3, 8, 34, 25);
    box(ctx, 3, 8, 34, 25, '#5c6470', '#3a4048', 2);
    ctx.fillStyle = '#2a2e34';
    ctx.fillRect(3, 15, 34, 2);
    ctx.fillStyle = '#a89c78';
    ctx.fillRect(17, 13, 6, 6);
    ctx.fillStyle = 'rgba(230,220,180,0.55)';
    ctx.font = 'bold 5px monospace';
    ctx.fillText('STORAGE', 8, 28);
    rust(ctx, 3, 8, 34, 25, seed, 3);
  },
  sandbag(ctx, _r, _v, seed) {
    ctx.save();
    ctx.filter = 'blur(2px)';
    ctx.fillStyle = 'rgba(0,0,0,0.4)';
    ctx.fillRect(4, 12, 38, 26);
    ctx.restore();
    for (let row = 0; row < 3; row++)
      for (let k = 0; k < 3; k++) {
        const bx = -4 + k * 16 + (row % 2) * 8;
        const by = 9 + row * 9;
        ctx.beginPath();
        ctx.ellipse(bx + 8, by, 8.5, 5, (h(seed, row * 3 + k) - 0.5) * 0.2, 0, Math.PI * 2);
        ctx.fillStyle = grad(ctx, bx, by - 5, bx, by + 5, row === 1 ? '#a39470' : '#aa9b76', '#6e6248');
        ctx.fill();
        ctx.strokeStyle = 'rgba(40,32,20,0.55)';
        ctx.lineWidth = 1;
        ctx.stroke();
        // 縫い目
        ctx.strokeStyle = 'rgba(60,48,30,0.45)';
        ctx.setLineDash([1.5, 1.5]);
        ctx.beginPath();
        ctx.moveTo(bx + 2, by);
        ctx.lineTo(bx + 14, by);
        ctx.stroke();
        ctx.setLineDash([]);
      }
  },
  rubble(ctx, _r, _v, seed) {
    for (let i = 0; i < 11; i++) {
      const x = 4 + h(seed, i, 1) * 28;
      const y = 4 + h(seed, i, 2) * 28;
      const s = 3 + h(seed, i, 3) * 8;
      const rot = h(seed, i, 4) * 3;
      ctx.save();
      ctx.translate(x, y);
      ctx.rotate(rot);
      ctx.fillStyle = 'rgba(0,0,0,0.3)';
      ctx.fillRect(-s / 2 + 2, -s / 3 + 2, s, s * 0.7);
      ctx.beginPath();
      ctx.moveTo(-s / 2, -s / 3);
      ctx.lineTo(s / 2, -s / 2.5);
      ctx.lineTo(s / 2.2, s / 3);
      ctx.lineTo(-s / 2.5, s / 2.6);
      ctx.closePath();
      ctx.fillStyle = ['#7d776c', '#6a655c', '#8a8478', '#5d5952', '#8a6a52'][i % 5];
      ctx.fill();
      ctx.fillStyle = 'rgba(255,250,235,0.18)';
      ctx.fillRect(-s / 2, -s / 3, s * 0.8, 1);
      ctx.restore();
    }
    // 鉄筋
    ctx.strokeStyle = '#5a3a28';
    ctx.lineWidth = 1.2;
    ctx.beginPath();
    ctx.moveTo(8, 30);
    ctx.lineTo(24, 14 + h(seed, 9) * 6);
    ctx.stroke();
  },
};

function shadeHex(hex: string, k: number): string {
  const n = parseInt(hex.slice(1, 7), 16);
  const f = (c: number) => Math.max(0, Math.min(255, Math.round(k < 0 ? c * (1 + k) : c + (255 - c) * k)));
  return `rgb(${f((n >> 16) & 255)},${f((n >> 8) & 255)},${f(n & 255)})`;
}

/** キャッシュしたプロップを描く。対応していない種類なら false */
export function drawProp(ctx: CanvasRenderingContext2D, o: ObjSnap): boolean {
  const paint = PAINT[o.kind];
  if (!paint) return false;
  const v = Math.floor(h(o.id, 3) * 3);
  const ready = o.ready ? 1 : 0;
  const key = `${o.kind}:${ready}:${v}`;
  let c = cache.get(key);
  if (!c) {
    c = document.createElement('canvas');
    c.width = SIZE * RES;
    c.height = SIZE * RES;
    const g = c.getContext('2d')!;
    g.scale(RES, RES);
    g.translate(PAD, PAD);
    // 柄違いは3種類まで（キャッシュを増やしすぎない）
    paint(g, ready, v, v * 977 + 13);
    cache.set(key, c);
  }
  ctx.drawImage(c, o.tx * TILE - PAD, o.ty * TILE - PAD, SIZE, SIZE);
  return true;
}

// ======================================================================
// 廃車・木（向きと揺れだけ毎フレーム。中身はキャッシュ）
// ======================================================================

const CAR_COLS = ['#8a3e30', '#3e5f7a', '#6d6a3a', '#5a5f66', '#8a6630', '#3d5e48'];

function carSprite(variant: number, wrecked: boolean): HTMLCanvasElement {
  const key = `car:${variant}:${wrecked ? 1 : 0}`;
  let c = cache.get(key);
  if (c) return c;
  c = document.createElement('canvas');
  const W = 60;
  const H = 40;
  c.width = W * RES;
  c.height = H * RES;
  const g = c.getContext('2d')!;
  g.scale(RES, RES);
  g.translate(W / 2, H / 2);
  const col = CAR_COLS[variant % CAR_COLS.length];
  const seed = variant * 31 + 7;
  // 落ち影は地面の層（Art.drawLowObject）で描く
  // タイヤ（フェンダーから少しはみ出す）
  g.fillStyle = '#121212';
  for (const [x, y] of [
    [-15, -13],
    [8, -13],
    [-15, 9],
    [8, 9],
  ]) {
    rr(g, x, y, 9, 4.5, 1.5);
    g.fill();
  }
  // 車体
  rr(g, -21, -11.5, 42, 23, 6.5);
  g.fillStyle = grad(g, 0, -11.5, 0, 11.5, shadeHex(col, 0.18), shadeHex(col, -0.42));
  g.fill();
  g.strokeStyle = 'rgba(10,10,10,0.8)';
  g.lineWidth = 1;
  g.stroke();
  // ボンネットとトランクの線・ドアの継ぎ目
  g.strokeStyle = 'rgba(0,0,0,0.35)';
  g.lineWidth = 0.8;
  g.beginPath();
  g.moveTo(11, -10);
  g.quadraticCurveTo(13, 0, 11, 10);
  g.moveTo(-14, -10);
  g.quadraticCurveTo(-16, 0, -14, 10);
  g.moveTo(-3, -11.3);
  g.lineTo(-3, -8);
  g.moveTo(-3, 11.3);
  g.lineTo(-3, 8);
  g.moveTo(15, -4);
  g.lineTo(20, -4);
  g.moveTo(15, 4);
  g.lineTo(20, 4);
  g.stroke();
  // 屋根
  rr(g, -10, -8.5, 18, 17, 3.5);
  g.fillStyle = grad(g, -10, -8.5, 8, 8.5, shadeHex(col, 0.05), shadeHex(col, -0.3));
  g.fill();
  // ガラス（フロント・リア・サイド）
  g.fillStyle = '#17212a';
  g.beginPath();
  g.moveTo(8, -8);
  g.lineTo(12.5, -9.5);
  g.lineTo(12.5, 9.5);
  g.lineTo(8, 8);
  g.closePath();
  g.fill();
  g.beginPath();
  g.moveTo(-10, -7.5);
  g.lineTo(-13.5, -8.5);
  g.lineTo(-13.5, 8.5);
  g.lineTo(-10, 7.5);
  g.closePath();
  g.fill();
  g.fillRect(-8, -10.5, 14, 2);
  g.fillRect(-8, 8.5, 14, 2);
  g.fillStyle = 'rgba(170,210,230,0.32)';
  g.fillRect(9, -7, 1.4, 13);
  g.fillRect(-6, -10.2, 9, 0.8);
  // ひび割れたフロントガラス
  if (h(seed, 1) > 0.4) {
    g.strokeStyle = 'rgba(220,230,240,0.55)';
    g.lineWidth = 0.6;
    g.beginPath();
    g.moveTo(10, -2);
    for (let i = 0; i < 5; i++) {
      const a = (i / 5) * Math.PI * 2;
      g.moveTo(10, -2);
      g.lineTo(10 + Math.cos(a) * 3.5, -2 + Math.sin(a) * 5);
    }
    g.stroke();
  }
  // サイドミラー・ライト
  g.fillStyle = shadeHex(col, -0.35);
  g.fillRect(6, -13, 3, 2);
  g.fillRect(6, 11, 3, 2);
  g.fillStyle = 'rgba(240,230,190,0.75)';
  g.fillRect(19, -9, 1.8, 4);
  g.fillRect(19, 5, 1.8, 4);
  g.fillStyle = 'rgba(160,40,30,0.8)';
  g.fillRect(-21, -9, 1.6, 3.5);
  g.fillRect(-21, 5.5, 1.6, 3.5);
  // 錆・汚れ・ほこり
  rust(g, -20, -11, 40, 22, seed, 5);
  g.fillStyle = 'rgba(170,150,110,0.15)';
  g.fillRect(-20, -11, 40, 4);
  g.fillStyle = 'rgba(255,255,255,0.14)';
  g.fillRect(-18, -10.5, 36, 1.2);
  if (wrecked) {
    g.fillStyle = 'rgba(20,16,12,0.5)';
    g.fillRect(-21, -11.5, 42, 23);
  }
  cache.set(key, c);
  return c;
}

export function drawCar(ctx: CanvasRenderingContext2D, o: ObjSnap): void {
  const variant = Math.floor(h(o.tx, o.ty, 2) * CAR_COLS.length);
  const s = carSprite(variant, o.hp <= 0);
  ctx.save();
  ctx.translate((o.tx + 0.5) * TILE, (o.ty + 0.5) * TILE);
  ctx.rotate((h(o.tx, o.ty) - 0.5) * 0.9);
  ctx.drawImage(s, -30, -20, 60, 40);
  ctx.restore();
}

const TREE_PAL = [
  ['#1f3a20', '#2e5530', '#4a7a44'],
  ['#24401c', '#365a26', '#527c36'],
  ['#2b3818', '#435422', '#66763a'],
  ['#3a3a1c', '#5a5228', '#7d7038'], // 枯れかけ
];

function treeSprite(variant: number): HTMLCanvasElement {
  const key = `tree:${variant}`;
  let c = cache.get(key);
  if (c) return c;
  c = document.createElement('canvas');
  const S = 72;
  c.width = S * RES;
  c.height = S * RES;
  const g = c.getContext('2d')!;
  g.scale(RES, RES);
  g.translate(S / 2, S / 2);
  const [dark, mid, light] = TREE_PAL[variant % TREE_PAL.length];
  const seed = variant * 17 + 3;
  const R = 17 + h(seed, 1) * 6;
  // 葉の塊：外周の暗い房 → 中間 → 明るい房（左上が明るい）
  const cluster = (n: number, rad: number, size: number, col: string, ox: number, oy: number) => {
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2 + h(seed, i, n) * 0.8;
      const rr2 = rad * (0.55 + h(seed, i, n + 1) * 0.45);
      g.fillStyle = col;
      g.beginPath();
      g.arc(ox + Math.cos(a) * rr2, oy + Math.sin(a) * rr2, size * (0.75 + h(seed, i, n + 2) * 0.5), 0, Math.PI * 2);
      g.fill();
    }
  };
  g.save();
  g.filter = 'blur(0.4px)';
  cluster(11, R, R * 0.48, dark, 0, 0);
  cluster(8, R * 0.65, R * 0.42, mid, -2, -2);
  cluster(6, R * 0.38, R * 0.32, light, -5, -5);
  g.restore();
  // 葉の細かい粒（明暗の点）
  for (let i = 0; i < 70; i++) {
    const a = h(seed, i, 50) * Math.PI * 2;
    const d = Math.sqrt(h(seed, i, 51)) * R;
    const x = Math.cos(a) * d;
    const y = Math.sin(a) * d;
    const lit = x + y < -4;
    g.fillStyle = lit ? 'rgba(200,220,150,0.22)' : 'rgba(0,0,0,0.22)';
    g.fillRect(x, y, 1.6, 1.6);
  }
  // 内側の陰影（右下が暗い）
  const sg = g.createRadialGradient(-6, -6, 2, 0, 0, R * 1.2);
  sg.addColorStop(0, 'rgba(255,255,220,0.1)');
  sg.addColorStop(0.6, 'rgba(0,0,0,0)');
  sg.addColorStop(1, 'rgba(0,0,0,0.35)');
  g.fillStyle = sg;
  g.globalCompositeOperation = 'source-atop';
  g.fillRect(-S / 2, -S / 2, S, S);
  cache.set(key, c);
  return c;
}

/** 木：地面の幹と影は低い層、葉の塊は高い層（揺れる） */
export function drawTreeTop(ctx: CanvasRenderingContext2D, o: ObjSnap, t: number): void {
  const variant = Math.floor(h(o.tx, o.ty, 9) * TREE_PAL.length);
  const s = 0.85 + h(o.tx, o.ty, 5) * 0.35;
  const sway = Math.sin(t * 1.3 + o.id) * 1.5;
  const cx = (o.tx + 0.5) * TILE;
  const cy = (o.ty + 0.5) * TILE;
  // 木陰は地面の層（Art.drawLowObject）で描く
  ctx.fillStyle = '#3e2a18';
  ctx.beginPath();
  ctx.arc(cx + 2, cy + 3, 5, 0, Math.PI * 2);
  ctx.fill();
  const S = 72 * s;
  ctx.drawImage(treeSprite(variant), cx - S / 2 + sway, cy - S / 2 - 2, S, S);
}
