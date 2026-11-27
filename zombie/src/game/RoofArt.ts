// ============================================================
// 屋根のテクスチャ（建物ごとに1回だけオフスクリーンへ焼き込む）
//   0: 錆びた波板トタン  1: 防水シート＋砂利の陸屋根（換気口・室外機）
//   2: 瓦屋根（棟あり）   3: コンクリートの陸屋根（天窓・パラペット）
// ============================================================
import { TILE } from './constants';
import type { Building } from './world';

const cache = new WeakMap<Building, HTMLCanvasElement>();

function h(x: number, y: number, s = 0): number {
  let v = (x * 374761393 + y * 668265263 + s * 1442695041) | 0;
  v = Math.imul(v ^ (v >>> 13), 1274126177);
  v ^= v >>> 16;
  return (v >>> 0) / 4294967296;
}

function speckle(g: CanvasRenderingContext2D, w: number, hh: number, n: number, seed: number, cols: string[], size = 1.4): void {
  for (let i = 0; i < n; i++) {
    g.fillStyle = cols[i % cols.length];
    g.fillRect(h(seed, i, 1) * w, h(seed, i, 2) * hh, size, size);
  }
}

function stain(g: CanvasRenderingContext2D, x: number, y: number, r: number, col: string): void {
  const gr = g.createRadialGradient(x, y, 0, x, y, r);
  gr.addColorStop(0, col);
  gr.addColorStop(1, 'rgba(0,0,0,0)');
  g.fillStyle = gr;
  g.fillRect(x - r, y - r, r * 2, r * 2);
}

/** 屋上の小物（室外機・換気口・天窓） */
function hvac(g: CanvasRenderingContext2D, x: number, y: number): void {
  g.fillStyle = 'rgba(0,0,0,0.35)';
  g.fillRect(x + 3, y + 4, 26, 20);
  g.fillStyle = '#8a8c88';
  g.fillRect(x, y, 26, 20);
  g.fillStyle = '#a2a49f';
  g.fillRect(x, y, 26, 2);
  g.fillStyle = '#3a3c3a';
  g.beginPath();
  g.arc(x + 9, y + 10, 6.5, 0, Math.PI * 2);
  g.fill();
  g.strokeStyle = '#6e706c';
  g.lineWidth = 1;
  for (let k = 0; k < 4; k++) {
    g.beginPath();
    g.moveTo(x + 9, y + 10);
    g.lineTo(x + 9 + Math.cos(k * 1.57 + 0.4) * 6, y + 10 + Math.sin(k * 1.57 + 0.4) * 6);
    g.stroke();
  }
  g.fillStyle = '#5c5e5a';
  for (let k = 0; k < 4; k++) g.fillRect(x + 18, y + 4 + k * 3.5, 6, 1.5);
}

function vent(g: CanvasRenderingContext2D, x: number, y: number): void {
  g.fillStyle = 'rgba(0,0,0,0.35)';
  g.beginPath();
  g.arc(x + 2, y + 3, 6, 0, Math.PI * 2);
  g.fill();
  g.fillStyle = '#7a7670';
  g.beginPath();
  g.arc(x, y, 5.5, 0, Math.PI * 2);
  g.fill();
  g.fillStyle = '#2c2a28';
  g.beginPath();
  g.arc(x, y, 3, 0, Math.PI * 2);
  g.fill();
}

export function roofCanvas(b: Building): HTMLCanvasElement {
  let c = cache.get(b);
  if (c) return c;
  c = document.createElement('canvas');
  const W = b.w * TILE;
  const H = b.h * TILE;
  c.width = W;
  c.height = H;
  const g = c.getContext('2d')!;
  const seed = b.x * 131 + b.y * 17 + b.roof;
  const style = b.roof % 4;
  const horiz = W >= H;

  if (style === 0) {
    // 波板トタン：凹凸の縞・継ぎ目・ボルト・錆の筋
    const base = ['#5d5f5a', '#606a5e', '#6a5e52'][seed % 3];
    g.fillStyle = base;
    g.fillRect(0, 0, W, H);
    const pitch = 6;
    for (let k = 0; k < (horiz ? H : W); k += pitch) {
      const gr = horiz ? g.createLinearGradient(0, k, 0, k + pitch) : g.createLinearGradient(k, 0, k + pitch, 0);
      gr.addColorStop(0, 'rgba(255,255,240,0.14)');
      gr.addColorStop(0.5, 'rgba(0,0,0,0.05)');
      gr.addColorStop(1, 'rgba(0,0,0,0.28)');
      g.fillStyle = gr;
      if (horiz) g.fillRect(0, k, W, pitch);
      else g.fillRect(k, 0, pitch, H);
    }
    // 板の継ぎ目とボルト
    g.fillStyle = 'rgba(0,0,0,0.35)';
    for (let k = 72; k < (horiz ? W : H); k += 72) {
      if (horiz) g.fillRect(k, 0, 2, H);
      else g.fillRect(0, k, W, 2);
    }
    g.fillStyle = 'rgba(200,200,190,0.35)';
    for (let k = 36; k < (horiz ? W : H); k += 72)
      for (let j = 6; j < (horiz ? H : W); j += 24) {
        if (horiz) g.fillRect(k, j, 1.5, 1.5);
        else g.fillRect(j, k, 1.5, 1.5);
      }
    // 錆の筋（流れ落ちる方向）
    for (let i = 0; i < 14; i++) {
      const x = h(seed, i, 3) * W;
      const y = h(seed, i, 4) * H;
      const len = 20 + h(seed, i, 5) * 50;
      const gr = horiz ? g.createLinearGradient(x, y, x + 4, y + len) : g.createLinearGradient(x, y, x + len, y + 4);
      gr.addColorStop(0, 'rgba(130,64,28,0.55)');
      gr.addColorStop(1, 'rgba(130,64,28,0)');
      g.fillStyle = gr;
      if (horiz) g.fillRect(x, y, 4 + h(seed, i, 6) * 8, len);
      else g.fillRect(x, y, len, 4 + h(seed, i, 6) * 8);
    }
    // 穴の空いた箇所
    if (h(seed, 9) > 0.4) {
      g.fillStyle = '#16140f';
      g.beginPath();
      const x = W * (0.25 + h(seed, 10) * 0.5);
      const y = H * (0.25 + h(seed, 11) * 0.5);
      g.moveTo(x, y);
      g.lineTo(x + 14, y + 4);
      g.lineTo(x + 9, y + 15);
      g.lineTo(x - 4, y + 11);
      g.closePath();
      g.fill();
    }
  } else if (style === 1) {
    // 防水シート＋砂利
    g.fillStyle = '#4a4943';
    g.fillRect(0, 0, W, H);
    speckle(g, W, H, Math.floor((W * H) / 18), seed, ['#5e5c55', '#3a3934', '#6a675e', '#2f2e2a'], 1.6);
    for (let i = 0; i < 6; i++) stain(g, h(seed, i, 7) * W, h(seed, i, 8) * H, 18 + h(seed, i, 9) * 28, 'rgba(20,22,18,0.35)');
    // 補修パッチ
    for (let i = 0; i < 3; i++) {
      g.fillStyle = 'rgba(30,30,28,0.6)';
      g.save();
      g.translate(h(seed, i, 12) * W, h(seed, i, 13) * H);
      g.rotate((h(seed, i, 14) - 0.5) * 0.4);
      g.fillRect(-14, -9, 28, 18);
      g.restore();
    }
    vent(g, W * 0.25, H * 0.3);
    vent(g, W * 0.7, H * 0.65);
    if (W > 200 || H > 200) hvac(g, W * 0.55, H * 0.2);
  } else if (style === 2) {
    // 瓦屋根：段ごとにずらした瓦・中央の棟
    const base = ['#5a3e34', '#4c4a42', '#5a4a3a'][seed % 3];
    g.fillStyle = base;
    g.fillRect(0, 0, W, H);
    const rowH = 7;
    const tabW = 11;
    for (let r = 0; r * rowH < (horiz ? H : W); r++) {
      for (let k = -1; k * tabW < (horiz ? W : H); k++) {
        const off = (r % 2) * (tabW / 2);
        const v = h(r, k, seed);
        const col = `rgba(${v > 0.5 ? '255,240,220' : '0,0,0'},${0.04 + Math.abs(v - 0.5) * 0.16})`;
        g.fillStyle = col;
        if (horiz) g.fillRect(k * tabW + off, r * rowH, tabW - 1, rowH - 1);
        else g.fillRect(r * rowH, k * tabW + off, rowH - 1, tabW - 1);
      }
      g.fillStyle = 'rgba(0,0,0,0.3)';
      if (horiz) g.fillRect(0, r * rowH + rowH - 1.5, W, 1.5);
      else g.fillRect(r * rowH + rowH - 1.5, 0, 1.5, H);
    }
    // 棟と、日が当たる面・陰になる面
    const shadeG = horiz ? g.createLinearGradient(0, 0, 0, H) : g.createLinearGradient(0, 0, W, 0);
    shadeG.addColorStop(0, 'rgba(255,240,210,0.12)');
    shadeG.addColorStop(0.49, 'rgba(255,240,210,0.02)');
    shadeG.addColorStop(0.51, 'rgba(0,0,0,0.18)');
    shadeG.addColorStop(1, 'rgba(0,0,0,0.3)');
    g.fillStyle = shadeG;
    g.fillRect(0, 0, W, H);
    g.fillStyle = 'rgba(30,24,20,0.8)';
    if (horiz) g.fillRect(0, H / 2 - 3, W, 6);
    else g.fillRect(W / 2 - 3, 0, 6, H);
    g.fillStyle = 'rgba(255,240,220,0.15)';
    if (horiz) g.fillRect(0, H / 2 - 3, W, 1.5);
    else g.fillRect(W / 2 - 3, 0, 1.5, H);
    // 剥がれた瓦・苔
    for (let i = 0; i < 6; i++) {
      g.fillStyle = i % 2 ? 'rgba(25,20,16,0.7)' : 'rgba(70,90,50,0.45)';
      g.fillRect(h(seed, i, 20) * W, h(seed, i, 21) * H, 9 + h(seed, i, 22) * 8, 6);
    }
  } else {
    // コンクリートの陸屋根
    g.fillStyle = '#6a6862';
    g.fillRect(0, 0, W, H);
    speckle(g, W, H, Math.floor((W * H) / 30), seed, ['#75736c', '#5a5852', '#807d75'], 1.2);
    // 打ち継ぎ目地
    g.strokeStyle = 'rgba(0,0,0,0.2)';
    g.lineWidth = 1;
    for (let x = 80; x < W; x += 80) {
      g.beginPath();
      g.moveTo(x, 0);
      g.lineTo(x, H);
      g.stroke();
    }
    for (let y = 80; y < H; y += 80) {
      g.beginPath();
      g.moveTo(0, y);
      g.lineTo(W, y);
      g.stroke();
    }
    for (let i = 0; i < 5; i++) stain(g, h(seed, i, 30) * W, h(seed, i, 31) * H, 16 + h(seed, i, 32) * 26, 'rgba(40,46,30,0.35)');
    // 天窓
    const sx = W * 0.3;
    const sy = H * 0.35;
    g.fillStyle = 'rgba(0,0,0,0.35)';
    g.fillRect(sx + 3, sy + 4, 30, 22);
    g.fillStyle = '#4a4c48';
    g.fillRect(sx, sy, 30, 22);
    g.fillStyle = '#2a3a44';
    g.fillRect(sx + 3, sy + 3, 24, 16);
    g.fillStyle = 'rgba(180,210,230,0.25)';
    g.fillRect(sx + 4, sy + 4, 10, 2);
    if (W > 160) hvac(g, W * 0.65, H * 0.55);
    vent(g, W * 0.8, H * 0.25);
  }

  // ---- 縁（パラペット）：外側の暗い線・上辺のハイライト・内側の影 ----
  g.strokeStyle = 'rgba(10,10,8,0.8)';
  g.lineWidth = 2;
  g.strokeRect(1, 1, W - 2, H - 2);
  g.strokeStyle = 'rgba(255,245,225,0.18)';
  g.lineWidth = 2;
  g.beginPath();
  g.moveTo(3, H - 3);
  g.lineTo(3, 3);
  g.lineTo(W - 3, 3);
  g.stroke();
  g.strokeStyle = 'rgba(0,0,0,0.3)';
  g.beginPath();
  g.moveTo(3, H - 4);
  g.lineTo(W - 4, H - 4);
  g.lineTo(W - 4, 3);
  g.stroke();
  const inner = g.createLinearGradient(0, 0, 0, 10);
  inner.addColorStop(0, 'rgba(0,0,0,0.25)');
  inner.addColorStop(1, 'rgba(0,0,0,0)');
  g.fillStyle = inner;
  g.fillRect(4, 4, W - 8, 8);
  cache.set(b, c);
  return c;
}
