// ============================================================
// 地形のプロシージャル描画（起動時に1回だけオフスクリーンへ焼き込む）
//   1) 半解像度のピクセル単位でノイズ合成：草地・土・アスファルト・床をノイズで色ムラ付け、
//      草地と土の境界はノイズで歪ませて自然になじませる
//   2) 全解像度で細部を描き込み：道路の白線・ひび割れ・マンホール、床の目地、草の葉、小石
//   3) 廃墟の壁：ぼかした落ち影＋南側の側面（2.5D）＋レンガの天面
//   ★ スプライト化する場合はこのファイルの代わりにタイル画像を並べる処理を書けばOK
// ============================================================
import { MAP_H, MAP_W, T_DIRT, T_FENCE, T_FLOOR, T_GRASS, T_ROAD, T_TILE, T_WALL, T_WINDOW, T_WOOD, TILE, WORLD_H, WORLD_W } from './constants';

const wallLike = (t: number) => t === T_WALL || t === T_WINDOW;
import type { TileWorld } from './world';

// ---------------- ノイズ ----------------

function hash(x: number, y: number, s: number): number {
  let h = (x * 374761393 + y * 668265263 + s * 1442695041) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

/** 値ノイズ（0..1, なめらか） */
function vnoise(x: number, y: number, s: number): number {
  const xi = Math.floor(x);
  const yi = Math.floor(y);
  const xf = x - xi;
  const yf = y - yi;
  const u = xf * xf * (3 - 2 * xf);
  const v = yf * yf * (3 - 2 * yf);
  const a = hash(xi, yi, s);
  const b = hash(xi + 1, yi, s);
  const c = hash(xi, yi + 1, s);
  const d = hash(xi + 1, yi + 1, s);
  return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
}

function fbm(x: number, y: number, s: number, oct = 3): number {
  let sum = 0;
  let amp = 0.5;
  let f = 1;
  let norm = 0;
  for (let i = 0; i < oct; i++) {
    sum += vnoise(x * f, y * f, s + i * 17) * amp;
    norm += amp;
    amp *= 0.5;
    f *= 2.03;
  }
  return sum / norm;
}

const mix = (a: number, b: number, t: number) => a + (b - a) * t;

export interface BakedTerrain {
  canvas: HTMLCanvasElement;
  mini: HTMLCanvasElement;
}

export function bakeTerrain(world: TileWorld): BakedTerrain {
  const terrainAt = (tx: number, ty: number) => world.terrainAt(tx, ty);

  // ---------- 1) 半解像度のベースカラー ----------
  const S = 2; // 縮小率
  const bw = WORLD_W / S;
  const bh = WORLD_H / S;
  const base = document.createElement('canvas');
  base.width = bw;
  base.height = bh;
  const bctx = base.getContext('2d')!;
  const img = bctx.createImageData(bw, bh);
  const d = img.data;
  for (let py = 0; py < bh; py++) {
    for (let px = 0; px < bw; px++) {
      const wx = px * S;
      const wy = py * S;
      let t = terrainAt(Math.floor(wx / TILE), Math.floor(wy / TILE));
      // 自然地形の境界をノイズで歪ませる
      if (t === T_GRASS || t === T_DIRT) {
        const ox = (fbm(wx / 90, wy / 90, 11, 2) - 0.5) * 46;
        const oy = (fbm(wx / 90, wy / 90, 23, 2) - 0.5) * 46;
        const t2 = terrainAt(Math.floor((wx + ox) / TILE), Math.floor((wy + oy) / TILE));
        if (t2 === T_GRASS || t2 === T_DIRT) t = t2;
      }
      let r = 0;
      let g = 0;
      let b = 0;
      const n1 = fbm(wx / 160, wy / 160, 3, 3);
      const n2 = fbm(wx / 26, wy / 26, 7, 2);
      const grain = hash(px, py, 99);
      // 彩度を落とした荒廃パレット（枯れ草・乾いた土・風化したアスファルト・汚れた床）
      switch (t) {
        case T_GRASS: {
          const lush = n1 * 0.8 + n2 * 0.2;
          r = mix(66, 92, lush) + (grain - 0.5) * 14;
          g = mix(70, 90, lush) + (grain - 0.5) * 14;
          b = mix(46, 56, lush) + (grain - 0.5) * 8;
          if (n2 > 0.66) {
            // 枯れ草の斑
            r += 22;
            g += 14;
            b += 4;
          }
          break;
        }
        case T_DIRT:
        case T_FENCE: {
          const k = n1 * 0.6 + n2 * 0.4;
          r = mix(86, 108, k) + (grain - 0.5) * 16;
          g = mix(76, 94, k) + (grain - 0.5) * 14;
          b = mix(62, 74, k) + (grain - 0.5) * 10;
          break;
        }
        case T_ROAD: {
          const k = n1 * 0.5 + n2 * 0.5;
          const v = mix(50, 64, k) + (grain - 0.5) * 20;
          r = v + 2;
          g = v + 1;
          b = v;
          if (n2 < 0.22) {
            r -= 10;
            g -= 10;
            b -= 9;
          }
          break;
        }
        case T_WOOD: {
          // フローリング：板ごとの色ムラ
          const plank = Math.floor(wy / 10);
          const pv = hash(plank, Math.floor((wx + (plank % 3) * 17) / 60), 41);
          const v = mix(74, 96, pv) + (grain - 0.5) * 10 - n2 * 10;
          r = v + 14;
          g = v + 2;
          b = v - 14;
          break;
        }
        case T_TILE: {
          const cx = Math.floor(wx / 20);
          const cy = Math.floor(wy / 20);
          const checker = (cx + cy) % 2 === 0 ? 8 : 0;
          const v = 92 + checker + (grain - 0.5) * 8 - Math.max(0, n2 - 0.55) * 40;
          r = v;
          g = v - 2;
          b = v - 6;
          break;
        }
        case T_FLOOR: {
          const k = n1 * 0.7 + n2 * 0.3;
          const v = mix(78, 96, k) + (grain - 0.5) * 12;
          r = v + 2;
          g = v;
          b = v - 4;
          const dirt = Math.max(0, n2 - 0.58) * 2.2;
          r -= 16 * dirt;
          g -= 18 * dirt;
          b -= 18 * dirt;
          break;
        }
        default: {
          r = 64;
          g = 60;
          b = 56;
        }
      }
      const i = (py * bw + px) * 4;
      d[i] = r;
      d[i + 1] = g;
      d[i + 2] = b;
      d[i + 3] = 255;
    }
  }
  bctx.putImageData(img, 0, 0);

  // ---------- 2) 全解像度キャンバス ----------
  const c = document.createElement('canvas');
  c.width = WORLD_W;
  c.height = WORLD_H;
  const ctx = c.getContext('2d')!;
  ctx.imageSmoothingEnabled = true;
  ctx.drawImage(base, 0, 0, WORLD_W, WORLD_H);

  // 細かい粒状感（全面にうっすら）
  const grainTile = document.createElement('canvas');
  grainTile.width = 96;
  grainTile.height = 96;
  const gctx = grainTile.getContext('2d')!;
  const gimg = gctx.createImageData(96, 96);
  for (let i = 0; i < 96 * 96; i++) {
    const v = Math.floor(hash(i, 7, 5) * 255);
    gimg.data[i * 4] = v;
    gimg.data[i * 4 + 1] = v;
    gimg.data[i * 4 + 2] = v;
    gimg.data[i * 4 + 3] = 255;
  }
  gctx.putImageData(gimg, 0, 0);
  ctx.save();
  ctx.globalAlpha = 0.07;
  ctx.globalCompositeOperation = 'overlay';
  ctx.fillStyle = ctx.createPattern(grainTile, 'repeat')!;
  ctx.fillRect(0, 0, WORLD_W, WORLD_H);
  ctx.restore();

  for (let ty = 0; ty < MAP_H; ty++)
    for (let tx = 0; tx < MAP_W; tx++) {
      const t = terrainAt(tx, ty);
      const x = tx * TILE;
      const y = ty * TILE;
      const r = hash(tx, ty, 1);
      if (t === T_GRASS) {
        // 草の葉
        ctx.lineWidth = 1;
        for (let i = 0; i < 7; i++) {
          const gx = x + hash(tx, ty, i + 10) * TILE;
          const gy = y + hash(tx, ty, i + 30) * TILE;
          const lean = (hash(tx, ty, i + 50) - 0.5) * 4;
          ctx.strokeStyle = hash(tx, ty, i + 70) > 0.5 ? 'rgba(150,145,95,0.32)' : 'rgba(40,40,25,0.32)';
          ctx.beginPath();
          ctx.moveTo(gx, gy);
          ctx.lineTo(gx + lean, gy - 4 - hash(tx, ty, i + 90) * 3);
          ctx.stroke();
        }
        if (r > 0.95) {
          // 小さな花
          ctx.fillStyle = r > 0.975 ? 'rgba(190,180,120,0.6)' : 'rgba(170,150,150,0.5)';
          for (let i = 0; i < 3; i++) ctx.fillRect(x + 8 + hash(tx, ty, i) * 24, y + 8 + hash(tx, ty, i + 4) * 24, 2, 2);
        }
      } else if (t === T_DIRT) {
        for (let i = 0; i < 3; i++) {
          ctx.fillStyle = 'rgba(40,30,22,0.35)';
          ctx.beginPath();
          ctx.ellipse(x + hash(tx, ty, i) * TILE, y + hash(tx, ty, i + 9) * TILE, 1.5 + hash(tx, ty, i + 3) * 2, 1 + hash(tx, ty, i + 5), 0, 0, Math.PI * 2);
          ctx.fill();
          ctx.fillStyle = 'rgba(200,180,150,0.25)';
          ctx.fillRect(x + hash(tx, ty, i + 13) * TILE, y + hash(tx, ty, i + 17) * TILE, 1.5, 1.5);
        }
      } else if (t === T_ROAD) {
        drawRoadDetails(ctx, tx, ty, terrainAt);
      } else if (t === T_WOOD) {
        // 板の継ぎ目
        ctx.strokeStyle = 'rgba(30,18,10,0.35)';
        ctx.lineWidth = 1;
        ctx.beginPath();
        for (let k = 0; k < 4; k++) {
          ctx.moveTo(x, y + k * 10 + 0.5);
          ctx.lineTo(x + TILE, y + k * 10 + 0.5);
          const jx = x + ((tx * 7 + ty * 3 + k * 13) % 4) * 10 + 0.5;
          ctx.moveTo(jx, y + k * 10);
          ctx.lineTo(jx, y + k * 10 + 10);
        }
        ctx.stroke();
        if (r > 0.88) {
          ctx.fillStyle = 'rgba(20,14,10,0.3)';
          ctx.beginPath();
          ctx.ellipse(x + 10 + r * 20, y + 20, 9, 5, r * 3, 0, Math.PI * 2);
          ctx.fill();
        }
      } else if (t === T_TILE) {
        ctx.strokeStyle = 'rgba(40,38,34,0.35)';
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(x + 0.5, y);
        ctx.lineTo(x + 0.5, y + TILE);
        ctx.moveTo(x + 20.5, y);
        ctx.lineTo(x + 20.5, y + TILE);
        ctx.moveTo(x, y + 0.5);
        ctx.lineTo(x + TILE, y + 0.5);
        ctx.moveTo(x, y + 20.5);
        ctx.lineTo(x + TILE, y + 20.5);
        ctx.stroke();
        if (r > 0.86) {
          // ひび割れたタイル・汚れ
          ctx.strokeStyle = 'rgba(30,28,24,0.5)';
          ctx.beginPath();
          ctx.moveTo(x + 4 + r * 10, y + 3);
          ctx.lineTo(x + 14, y + 13);
          ctx.lineTo(x + 9, y + 19);
          ctx.stroke();
        }
      } else if (t === T_FLOOR) {
        // 床タイルの目地
        ctx.strokeStyle = 'rgba(0,0,0,0.16)';
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(x + 0.5, y);
        ctx.lineTo(x + 0.5, y + TILE);
        ctx.moveTo(x, y + 0.5);
        ctx.lineTo(x + TILE, y + 0.5);
        ctx.moveTo(x + TILE / 2 + 0.5, y);
        ctx.lineTo(x + TILE / 2 + 0.5, y + TILE);
        ctx.moveTo(x, y + TILE / 2 + 0.5);
        ctx.lineTo(x + TILE, y + TILE / 2 + 0.5);
        ctx.stroke();
        ctx.strokeStyle = 'rgba(255,255,255,0.05)';
        ctx.beginPath();
        ctx.moveTo(x + 1.5, y + 1);
        ctx.lineTo(x + 1.5, y + TILE);
        ctx.stroke();
        if (r > 0.9) {
          // 割れたタイル
          ctx.fillStyle = 'rgba(30,26,22,0.35)';
          ctx.beginPath();
          ctx.moveTo(x + 20, y + 4);
          ctx.lineTo(x + 38, y + 10);
          ctx.lineTo(x + 26, y + 20);
          ctx.closePath();
          ctx.fill();
        }
        if (r < 0.06) {
          // がれき
          for (let i = 0; i < 5; i++) {
            ctx.fillStyle = `rgba(${110 + i * 8},${100 + i * 6},${90},0.8)`;
            ctx.fillRect(x + hash(tx, ty, i + 40) * 34, y + hash(tx, ty, i + 44) * 34, 3 + hash(tx, ty, i) * 3, 2 + hash(tx, ty, i + 1) * 3);
          }
        }
      }
    }

  // ---------- 3) 壁の落ち影（ぼかし） ----------
  const shadow = document.createElement('canvas');
  shadow.width = WORLD_W;
  shadow.height = WORLD_H;
  const sctx = shadow.getContext('2d')!;
  sctx.fillStyle = '#000';
  for (let ty = 0; ty < MAP_H; ty++)
    for (let tx = 0; tx < MAP_W; tx++) {
      if (!wallLike(terrainAt(tx, ty))) continue;
      sctx.fillRect(tx * TILE + 8, ty * TILE + 12, TILE, TILE);
    }
  ctx.save();
  ctx.globalAlpha = 0.42;
  ctx.filter = 'blur(5px)';
  ctx.drawImage(shadow, 0, 0);
  ctx.restore();

  // ---------- 4) 廃墟の壁（側面＋天面） ----------
  for (let ty = 0; ty < MAP_H; ty++)
    for (let tx = 0; tx < MAP_W; tx++) {
      const t = terrainAt(tx, ty);
      if (t === T_WALL) drawRuinWall(ctx, tx, ty, terrainAt);
      else if (t === T_WINDOW) drawWindow(ctx, tx, ty, terrainAt);
    }
  // ---------- 5) 金網フェンス ----------
  for (let ty = 0; ty < MAP_H; ty++)
    for (let tx = 0; tx < MAP_W; tx++) if (terrainAt(tx, ty) === T_FENCE) drawFence(ctx, tx, ty, terrainAt);

  // ---------- ミニマップ ----------
  const mini = document.createElement('canvas');
  mini.width = MAP_W * 2;
  mini.height = MAP_H * 2;
  const mg = mini.getContext('2d')!;
  mg.imageSmoothingEnabled = true;
  mg.drawImage(base, 0, 0, MAP_W * 2, MAP_H * 2);
  mg.fillStyle = 'rgba(0,0,0,0.25)';
  mg.fillRect(0, 0, MAP_W * 2, MAP_H * 2);
  for (let ty = 0; ty < MAP_H; ty++)
    for (let tx = 0; tx < MAP_W; tx++) {
      if (terrainAt(tx, ty) !== T_WALL) continue;
      mg.fillStyle = '#9a8f84';
      mg.fillRect(tx * 2, ty * 2, 2, 2);
    }
  return { canvas: c, mini };
}

function drawRoadDetails(ctx: CanvasRenderingContext2D, tx: number, ty: number, at: (x: number, y: number) => number): void {
  const x = tx * TILE;
  const y = ty * TILE;
  const up = at(tx, ty - 1) === T_ROAD;
  const down = at(tx, ty + 1) === T_ROAD;
  const left = at(tx - 1, ty) === T_ROAD;
  const right = at(tx + 1, ty) === T_ROAD;
  const r = hash(tx, ty, 2);
  // 路肩（道路の外縁）の白線
  ctx.fillStyle = 'rgba(210,210,200,0.28)';
  if (!up) ctx.fillRect(x, y + 3, TILE, 2);
  if (!down) ctx.fillRect(x, y + TILE - 5, TILE, 2);
  if (!left) ctx.fillRect(x + 3, y, 2, TILE);
  if (!right) ctx.fillRect(x + TILE - 5, y, 2, TILE);
  // 2車線の中央の黄色い破線（横道路：上が道路で下が非道路のペアの境界）
  const horizCenter = down && !up && at(tx, ty + 2) !== T_ROAD;
  const vertCenter = right && !left && at(tx + 2, ty) !== T_ROAD;
  ctx.fillStyle = 'rgba(225,190,80,0.55)';
  if (horizCenter) {
    if (tx % 2 === 0) ctx.fillRect(x + 6, y + TILE - 1.5, TILE - 12, 3);
  }
  if (vertCenter) {
    if (ty % 2 === 0) ctx.fillRect(x + TILE - 1.5, y + 6, 3, TILE - 12);
  }
  // ひび割れ
  if (r > 0.75) {
    ctx.strokeStyle = 'rgba(15,15,15,0.5)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    let cx = x + hash(tx, ty, 3) * TILE;
    let cy = y + hash(tx, ty, 4) * TILE;
    ctx.moveTo(cx, cy);
    for (let i = 0; i < 4; i++) {
      cx += (hash(tx, ty, 10 + i) - 0.5) * 18;
      cy += (hash(tx, ty, 20 + i) - 0.5) * 18;
      ctx.lineTo(cx, cy);
    }
    ctx.stroke();
  }
  // マンホール・油じみ
  if (r < 0.025) {
    ctx.fillStyle = '#2c2c2e';
    ctx.beginPath();
    ctx.arc(x + 20, y + 20, 9, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = 'rgba(120,120,120,0.5)';
    ctx.lineWidth = 1;
    ctx.stroke();
    ctx.beginPath();
    for (let k = -6; k <= 6; k += 3) {
      ctx.moveTo(x + 14, y + 20 + k);
      ctx.lineTo(x + 26, y + 20 + k);
    }
    ctx.stroke();
  } else if (r < 0.08) {
    const g = ctx.createRadialGradient(x + 20, y + 20, 0, x + 20, y + 20, 16);
    g.addColorStop(0, 'rgba(10,10,14,0.45)');
    g.addColorStop(1, 'rgba(10,10,14,0)');
    ctx.fillStyle = g;
    ctx.fillRect(x, y, TILE, TILE);
  }
}

function drawRuinWall(ctx: CanvasRenderingContext2D, tx: number, ty: number, at: (x: number, y: number) => number): void {
  const x = tx * TILE;
  const y = ty * TILE;
  const below = wallLike(at(tx, ty + 1));
  // 南側の側面（高さ表現）
  if (!below) {
    const face = 12;
    const g = ctx.createLinearGradient(0, y + TILE, 0, y + TILE + face);
    g.addColorStop(0, '#3b3935');
    g.addColorStop(1, '#292825');
    ctx.fillStyle = g;
    ctx.fillRect(x, y + TILE, TILE, face);
    ctx.fillStyle = 'rgba(0,0,0,0.25)';
    for (let i = 0; i < 4; i++) ctx.fillRect(x + i * 10 + (ty % 2) * 5, y + TILE + 5, 1, 7);
  }
  // 天面（レンガ）
  ctx.fillStyle = '#45433f';
  ctx.fillRect(x, y, TILE, TILE);
  for (let row = 0; row < 4; row++) {
    const off = (row + ty) % 2 ? 0 : 10;
    for (let col = -1; col < 3; col++) {
      const bx = x + col * 20 + off;
      const x0 = Math.max(x, bx + 1);
      const x1 = Math.min(x + TILE, bx + 19);
      if (x1 <= x0) continue;
      const v = hash(tx * 4 + col, ty * 4 + row, 8);
      ctx.fillStyle = `rgb(${88 + v * 20},${85 + v * 18},${80 + v * 14})`;
      ctx.fillRect(x0, y + row * 10 + 1, x1 - x0, 8);
    }
  }
  // 上辺のハイライトと苔
  if (!wallLike(at(tx, ty - 1))) {
    ctx.fillStyle = 'rgba(255,240,220,0.12)';
    ctx.fillRect(x, y, TILE, 2);
  }
  if (hash(tx, ty, 77) > 0.7) {
    ctx.fillStyle = 'rgba(70,100,50,0.45)';
    ctx.beginPath();
    ctx.ellipse(x + hash(tx, ty, 78) * TILE, y + hash(tx, ty, 79) * TILE, 7, 4, 0, 0, Math.PI * 2);
    ctx.fill();
  }
}

/** ガラス窓：壁の天面に窓枠とくすんだガラス */
function drawWindow(ctx: CanvasRenderingContext2D, tx: number, ty: number, at: (x: number, y: number) => number): void {
  const x = tx * TILE;
  const y = ty * TILE;
  const horiz = wallLike(at(tx - 1, ty)) || wallLike(at(tx + 1, ty));
  if (!wallLike(at(tx, ty + 1))) {
    const g = ctx.createLinearGradient(0, y + TILE, 0, y + TILE + 12);
    g.addColorStop(0, '#3b3935');
    g.addColorStop(1, '#292825');
    ctx.fillStyle = g;
    ctx.fillRect(x, y + TILE, TILE, 12);
  }
  ctx.fillStyle = '#45433f';
  ctx.fillRect(x, y, TILE, TILE);
  // 窓枠
  ctx.fillStyle = '#5a5246';
  if (horiz) ctx.fillRect(x, y + 13, TILE, 14);
  else ctx.fillRect(x + 13, y, 14, TILE);
  // ガラス（くすんだ青灰色＋反射）
  ctx.fillStyle = 'rgba(96,118,124,0.75)';
  if (horiz) ctx.fillRect(x + 2, y + 16, TILE - 4, 8);
  else ctx.fillRect(x + 16, y + 2, 8, TILE - 4);
  ctx.fillStyle = 'rgba(220,230,230,0.25)';
  if (horiz) ctx.fillRect(x + 6, y + 17, 10, 2);
  else ctx.fillRect(x + 17, y + 6, 2, 10);
  // 割れたガラス
  if (hash(tx, ty, 5) > 0.6) {
    ctx.strokeStyle = 'rgba(20,24,26,0.7)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    if (horiz) {
      ctx.moveTo(x + 22, y + 16);
      ctx.lineTo(x + 26, y + 20);
      ctx.lineTo(x + 31, y + 18);
      ctx.moveTo(x + 26, y + 20);
      ctx.lineTo(x + 25, y + 24);
    } else {
      ctx.moveTo(x + 16, y + 22);
      ctx.lineTo(x + 20, y + 26);
      ctx.lineTo(x + 18, y + 31);
      ctx.moveTo(x + 20, y + 26);
      ctx.lineTo(x + 24, y + 25);
    }
    ctx.stroke();
  }
}

/** 金網フェンス：支柱と網目（向こうが見える） */
function drawFence(ctx: CanvasRenderingContext2D, tx: number, ty: number, at: (x: number, y: number) => number): void {
  const x = tx * TILE;
  const y = ty * TILE;
  const horiz = at(tx - 1, ty) === T_FENCE || at(tx + 1, ty) === T_FENCE;
  ctx.save();
  // 影
  ctx.fillStyle = 'rgba(0,0,0,0.18)';
  if (horiz) ctx.fillRect(x, y + 22, TILE, 6);
  else ctx.fillRect(x + 22, y, 6, TILE);
  // 網目
  ctx.strokeStyle = 'rgba(150,150,140,0.55)';
  ctx.lineWidth = 1;
  ctx.beginPath();
  if (horiz) {
    for (let k = -6; k < TILE; k += 6) {
      ctx.moveTo(x + k, y + 14);
      ctx.lineTo(x + k + 6, y + 24);
      ctx.moveTo(x + k + 6, y + 14);
      ctx.lineTo(x + k, y + 24);
    }
  } else {
    for (let k = -6; k < TILE; k += 6) {
      ctx.moveTo(x + 14, y + k);
      ctx.lineTo(x + 24, y + k + 6);
      ctx.moveTo(x + 24, y + k);
      ctx.lineTo(x + 14, y + k + 6);
    }
  }
  ctx.stroke();
  // 支柱と上端のワイヤー
  ctx.strokeStyle = '#6b665c';
  ctx.lineWidth = 2;
  ctx.beginPath();
  if (horiz) {
    ctx.moveTo(x, y + 14);
    ctx.lineTo(x + TILE, y + 14);
  } else {
    ctx.moveTo(x + 14, y);
    ctx.lineTo(x + 14, y + TILE);
  }
  ctx.stroke();
  ctx.fillStyle = '#58534a';
  if ((tx + ty) % 2 === 0) {
    ctx.beginPath();
    ctx.arc(x + (horiz ? 4 : 19), y + (horiz ? 19 : 4), 3, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.restore();
}
