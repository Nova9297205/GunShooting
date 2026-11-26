// ============================================================
// 地形のプロシージャル描画（起動時に1回だけオフスクリーンへ焼き込む）
//   1) 半解像度のピクセル単位でノイズ合成：草地・土・アスファルト・床をノイズで色ムラ付け、
//      草地と土の境界はノイズで歪ませて自然になじませる
//   2) 全解像度で細部を描き込み：道路の白線・ひび割れ・マンホール、床の目地、草の葉、小石
//   3) 廃墟の壁：ぼかした落ち影＋南側の側面（2.5D）＋レンガの天面
//   ★ スプライト化する場合はこのファイルの代わりにタイル画像を並べる処理を書けばOK
// ============================================================
import { CHUNK, MAP_H, MAP_W, T_DIRT, T_FENCE, T_FLOOR, T_GRASS, T_ROAD, T_TILE, T_WALL, T_WINDOW, T_WOOD, TILE } from './constants';

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
  /** チャンク単位で焼き込むキャッシュ */
  cache: TerrainCache;
  mini: HTMLCanvasElement;
}

/** 地図の外：道路はそのまま続き、それ以外は荒れ地・草地（描画専用。地図の外へは出られない） */
export function sceneryAt(world: TileWorld, tx: number, ty: number): number {
  if (world.inBounds(tx, ty)) return world.terrainAt(tx, ty);
  const ex = Math.min(MAP_W - 1, Math.max(0, tx));
  const ey = Math.min(MAP_H - 1, Math.max(0, ty));
  const e = world.terrainAt(ex, ey);
  // 外縁の道路が外向きに続いているなら、その先も道路
  const outX = tx < 0 || tx >= MAP_W;
  const outY = ty < 0 || ty >= MAP_H;
  // （幹線は地図の端まで通っているので、端のタイルが道路ならその道は外へ続いている）
  if (e === T_ROAD && outX !== outY) return T_ROAD;
  return fbm(tx / 9, ty / 9, 77, 2) > 0.56 ? T_DIRT : T_GRASS;
}

/** 1チャンク分の地形を、何回かに分けて焼き込む（1フレームで固まらないように yield する） */
export function* bakeChunkSteps(world: TileWorld, ccx: number, ccy: number, out: { canvas?: HTMLCanvasElement }): Generator<void> {
  const terrainAt = (tx: number, ty: number) => sceneryAt(world, tx, ty);
  const tx0 = ccx * CHUNK;
  const ty0 = ccy * CHUNK;
  const tx1 = tx0 + CHUNK;
  const ty1 = ty0 + CHUNK;
  const X0 = tx0 * TILE;
  const Y0 = ty0 * TILE;
  const CW = CHUNK * TILE;

  // ---------- 1) 半解像度のベースカラー ----------
  const S = 2; // 縮小率
  const bw = CW / S;
  const bh = CW / S;
  const base = document.createElement('canvas');
  base.width = bw;
  base.height = bh;
  const bctx = base.getContext('2d')!;
  const img = bctx.createImageData(bw, bh);
  const d = img.data;
  for (let py = 0; py < bh; py++) {
    if (py % 50 === 49) yield;
    for (let px = 0; px < bw; px++) {
      const wx = X0 + px * S;
      const wy = Y0 + py * S;
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

  yield;
  // ---------- 2) 全解像度キャンバス（ワールド座標で描けるよう平行移動） ----------
  const c = document.createElement('canvas');
  c.width = CW;
  c.height = CW;
  const ctx = c.getContext('2d')!;
  ctx.translate(-X0, -Y0);
  ctx.imageSmoothingEnabled = true;
  ctx.drawImage(base, X0, Y0, CW, CW);

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
  ctx.fillRect(X0, Y0, CW, CW);
  ctx.restore();
  yield;

  for (let ty = ty0 - 1; ty <= ty1; ty++)
    for (let tx = tx0 - 1; tx <= tx1; tx++) {
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

  yield;
  detailPass(ctx, world, terrainAt, tx0 - 1, ty0 - 1, tx1 + 1, ty1 + 1);
  yield;

  // ---------- 3) 壁の落ち影（ぼかし） ----------
  const shadow = document.createElement('canvas');
  shadow.width = CW;
  shadow.height = CW;
  const sctx = shadow.getContext('2d')!;
  sctx.translate(-X0, -Y0);
  sctx.fillStyle = '#000';
  for (let ty = ty0 - 1; ty <= ty1; ty++)
    for (let tx = tx0 - 1; tx <= tx1; tx++) {
      if (!wallLike(terrainAt(tx, ty))) continue;
      sctx.fillRect(tx * TILE + 8, ty * TILE + 12, TILE, TILE);
    }
  ctx.save();
  ctx.globalAlpha = 0.42;
  ctx.filter = 'blur(5px)';
  ctx.drawImage(shadow, X0, Y0);
  ctx.restore();
  yield;

  // ---------- 4) 廃墟の壁（側面＋天面） ----------
  for (let ty = ty0 - 1; ty <= ty1; ty++)
    for (let tx = tx0 - 1; tx <= tx1; tx++) {
      const t = terrainAt(tx, ty);
      if (t === T_WALL) drawRuinWall(ctx, tx, ty, terrainAt);
      else if (t === T_WINDOW) drawWindow(ctx, tx, ty, terrainAt);
    }
  wallWear(ctx, terrainAt, tx0 - 1, ty0 - 1, tx1 + 1, ty1 + 1);
  // ---------- 5) 金網フェンス ----------
  for (let ty = ty0 - 1; ty <= ty1; ty++)
    for (let tx = tx0 - 1; tx <= tx1; tx++) if (terrainAt(tx, ty) === T_FENCE) drawFence(ctx, tx, ty, terrainAt);

  // ---------- 6) 地図の外：雑木林と廃墟のシルエット、汚染された霞 ----------
  if (!world.inBounds(tx0, ty0) || !world.inBounds(tx1 - 1, ty1 - 1)) {
    yield;
    outskirts(ctx, world, tx0, ty0, tx1, ty1);
  }
  out.canvas = c;
}

/** 地図の外側の遠景：木の茂み・崩れた建物の影・道路の先の放置車両。外へ行くほど汚染の霞が濃い */
function outskirts(ctx: CanvasRenderingContext2D, world: TileWorld, tx0: number, ty0: number, tx1: number, ty1: number): void {
  for (let ty = ty0; ty < ty1; ty++)
    for (let tx = tx0; tx < tx1; tx++) {
      if (world.inBounds(tx, ty)) continue;
      const x = tx * TILE;
      const y = ty * TILE;
      const h = hash(tx, ty, 901);
      const t = sceneryAt(world, tx, ty);
      if (t === T_ROAD) {
        if (h < 0.04) {
          ctx.fillStyle = '#3a3630';
          ctx.save();
          ctx.translate(x + 20, y + 20);
          ctx.rotate(h * 40);
          ctx.fillRect(-18, -10, 36, 20);
          ctx.fillStyle = 'rgba(0,0,0,0.35)';
          ctx.fillRect(-8, -8, 16, 16);
          ctx.restore();
        }
        continue;
      }
      // 雑木林（地図の外の森はやや濃い）
      const f = fbm(tx / 7, ty / 7, 313, 2);
      if (f > 0.5 && h < 0.55) {
        const r = 12 + hash(tx, ty, 902) * 10;
        ctx.fillStyle = 'rgba(10,16,8,0.35)';
        ctx.beginPath();
        ctx.arc(x + 26, y + 28, r, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = f > 0.62 ? '#24321c' : '#2e3a20';
        ctx.beginPath();
        ctx.arc(x + 20 + (hash(tx, ty, 903) - 0.5) * 10, y + 20 + (hash(tx, ty, 904) - 0.5) * 10, r, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = 'rgba(120,140,80,0.18)';
        ctx.beginPath();
        ctx.arc(x + 15, y + 15, r * 0.45, 0, Math.PI * 2);
        ctx.fill();
      }
    }
  // 崩れた建物のシルエット（チャンクに1〜2棟）
  for (let k = 0; k < 2; k++) {
    const bx = tx0 + 2 + Math.floor(hash(tx0, ty0, 910 + k) * (CHUNK - 10));
    const by = ty0 + 2 + Math.floor(hash(tx0, ty0, 920 + k) * (CHUNK - 9));
    if (world.inBounds(bx, by) || hash(tx0, ty0, 930 + k) < 0.4 || sceneryAt(world, bx, by) === T_ROAD) continue;
    const w = 5 + Math.floor(hash(tx0, ty0, 940 + k) * 5);
    const h = 4 + Math.floor(hash(tx0, ty0, 950 + k) * 4);
    ctx.fillStyle = 'rgba(0,0,0,0.35)';
    ctx.fillRect(bx * TILE + 10, by * TILE + 14, w * TILE, h * TILE);
    ctx.fillStyle = '#3a3834';
    ctx.fillRect(bx * TILE, by * TILE, w * TILE, h * TILE);
    ctx.fillStyle = '#2a2926';
    ctx.fillRect(bx * TILE + 10, by * TILE + 10, w * TILE - 20, h * TILE - 20);
    // 崩れた角
    ctx.fillStyle = '#5a564c';
    ctx.beginPath();
    ctx.moveTo(bx * TILE + w * TILE, by * TILE);
    ctx.lineTo(bx * TILE + w * TILE - 60, by * TILE);
    ctx.lineTo(bx * TILE + w * TILE, by * TILE + 50);
    ctx.closePath();
    ctx.fill();
  }
  // 汚染の霞：地図の端から離れるほど濃く、黄緑がかった灰色
  for (let ty = ty0; ty < ty1; ty++)
    for (let tx = tx0; tx < tx1; tx++) {
      if (world.inBounds(tx, ty)) continue;
      const ox = tx < 0 ? -tx : tx >= MAP_W ? tx - MAP_W + 1 : 0;
      const oy = ty < 0 ? -ty : ty >= MAP_H ? ty - MAP_H + 1 : 0;
      const d = Math.max(ox, oy);
      const a = Math.min(0.85, 0.25 + d * 0.06);
      ctx.fillStyle = `rgba(48,52,30,${a})`;
      ctx.fillRect(tx * TILE, ty * TILE, TILE, TILE);
    }
}

/** ミニマップ・全体地図用の小さな地形画像（1タイル = 2px） */
export function bakeMini(world: TileWorld): HTMLCanvasElement {
  const mini = document.createElement('canvas');
  mini.width = MAP_W * 2;
  mini.height = MAP_H * 2;
  const mg = mini.getContext('2d')!;
  const img = mg.createImageData(MAP_W * 2, MAP_H * 2);
  const col: Record<number, [number, number, number]> = {
    [T_GRASS]: [64, 72, 46],
    [T_DIRT]: [84, 76, 60],
    [T_ROAD]: [52, 52, 50],
    [T_FLOOR]: [80, 78, 72],
    [T_WOOD]: [86, 70, 54],
    [T_TILE]: [92, 90, 84],
    [T_WALL]: [150, 142, 130],
    [T_WINDOW]: [140, 150, 150],
    [T_FENCE]: [120, 120, 110],
  };
  for (let ty = 0; ty < MAP_H; ty++)
    for (let tx = 0; tx < MAP_W; tx++) {
      const c = col[world.terrainAt(tx, ty)] ?? [60, 60, 60];
      const n = (hash(tx, ty, 5) - 0.5) * 8;
      for (let k = 0; k < 4; k++) {
        const i = ((ty * 2 + (k >> 1)) * MAP_W * 2 + tx * 2 + (k & 1)) * 4;
        img.data[i] = c[0] + n;
        img.data[i + 1] = c[1] + n;
        img.data[i + 2] = c[2] + n;
        img.data[i + 3] = 255;
      }
    }
  mg.putImageData(img, 0, 0);
  return mini;
}

/** チャンクごとの焼き込みキャッシュ。近いチャンクから少しずつ焼き、遠いものは捨てる */
export class TerrainCache {
  private done = new Map<string, HTMLCanvasElement>();
  private job: { key: string; it: Generator<void>; out: { canvas?: HTMLCanvasElement } } | null = null;
  private wanted: { cx: number; cy: number; pri: number }[] = [];
  /** 統計（テスト用） */
  stats = { baked: 0, evicted: 0 };
  constructor(
    private world: TileWorld,
    private max = 24,
  ) {}

  get(cx: number, cy: number): HTMLCanvasElement | undefined {
    const k = `${cx},${cy}`;
    const c = this.done.get(k);
    if (c) {
      // 最近使ったものを末尾へ（LRU）
      this.done.delete(k);
      this.done.set(k, c);
    }
    return c;
  }

  /** 欲しいチャンク（pri が小さいほど優先）を登録 */
  want(list: { cx: number; cy: number; pri: number }[]): void {
    this.wanted = list.filter((w) => !this.done.has(`${w.cx},${w.cy}`)).sort((a, b) => a.pri - b.pri);
  }

  get size(): number {
    return this.done.size;
  }

  /** 時間予算内で焼き込みを進める */
  pump(budgetMs: number): void {
    const t0 = performance.now();
    while (performance.now() - t0 < budgetMs) {
      if (!this.job) {
        const w = this.wanted.shift();
        if (!w) return;
        const key = `${w.cx},${w.cy}`;
        if (this.done.has(key)) continue;
        const out: { canvas?: HTMLCanvasElement } = {};
        this.job = { key, it: bakeChunkSteps(this.world, w.cx, w.cy, out), out };
      }
      const r = this.job.it.next();
      if (r.done) {
        if (this.job.out.canvas) {
          this.done.set(this.job.key, this.job.out.canvas);
          this.stats.baked++;
          while (this.done.size > this.max) {
            const oldest = this.done.keys().next().value as string;
            this.done.delete(oldest);
            this.stats.evicted++;
          }
        }
        this.job = null;
      }
    }
  }
}

/** 互換用：キャッシュとミニマップを作る（実際の焼き込みは表示に合わせて少しずつ） */
export function bakeTerrain(world: TileWorld): BakedTerrain {
  return { cache: new TerrainCache(world), mini: bakeMini(world) };
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

// ======================================================================
// 細部の描き込み（焼き込み時に1回だけ）
//   道路：骨材の粒・亀甲状のひび・補修跡・ポットホール・油染み・タイヤ痕・路肩の雑草
//   草地：枯れ草の株・小石・落ち葉・ごみ　土：小石・乾いた泥のひび
//   床：木目と節・板の段差／タイルの面取りと目地の汚れ・欠け／コンクリートのヘアクラック
//   壁際の床に環境遮蔽（暗がり）、壁の天面にひびと欠け、汚染地帯の染み
// ======================================================================
export function detailPass(ctx: CanvasRenderingContext2D, world: TileWorld, at: (x: number, y: number) => number, rx0: number, ry0: number, rx1: number, ry1: number): void {
  const indoor = (t: number) => t === T_WOOD || t === T_TILE || t === T_FLOOR;
  for (let ty = ry0; ty < ry1; ty++)
    for (let tx = rx0; tx < rx1; tx++) {
      const t = at(tx, ty);
      const x = tx * TILE;
      const y = ty * TILE;
      const r = hash(tx, ty, 301);
      const R = (i: number) => hash(tx, ty, 400 + i);
      if (t === T_ROAD) {
        // 骨材の粒
        for (let i = 0; i < 26; i++) {
          ctx.fillStyle = i % 3 ? 'rgba(0,0,0,0.18)' : 'rgba(200,198,190,0.13)';
          ctx.fillRect(x + R(i) * TILE, y + R(i + 40) * TILE, 1.2, 1.2);
        }
        // 亀甲状のひび
        if (r > 0.82) {
          ctx.strokeStyle = 'rgba(10,10,10,0.42)';
          ctx.lineWidth = 0.8;
          ctx.beginPath();
          const cx = x + 8 + R(1) * 24;
          const cy = y + 8 + R(2) * 24;
          for (let k = 0; k < 6; k++) {
            const a = (k / 6) * Math.PI * 2 + R(3);
            const d = 6 + R(k + 4) * 5;
            ctx.moveTo(cx, cy);
            ctx.lineTo(cx + Math.cos(a) * d, cy + Math.sin(a) * d);
            ctx.lineTo(cx + Math.cos(a + 1) * d * 1.3, cy + Math.sin(a + 1) * d * 1.3);
          }
          ctx.stroke();
        }
        // 補修跡（色の違うアスファルト）
        if (r > 0.6 && r < 0.66) {
          ctx.fillStyle = 'rgba(20,20,22,0.35)';
          ctx.fillRect(x + R(5) * 14, y + R(6) * 14, 16 + R(7) * 14, 12 + R(8) * 10);
          ctx.strokeStyle = 'rgba(0,0,0,0.3)';
          ctx.strokeRect(x + R(5) * 14 + 0.5, y + R(6) * 14 + 0.5, 16 + R(7) * 14, 12 + R(8) * 10);
        }
        // ポットホール
        if (r > 0.5 && r < 0.515) {
          const px = x + 10 + R(9) * 20;
          const py = y + 10 + R(10) * 20;
          ctx.fillStyle = 'rgba(14,14,14,0.85)';
          ctx.beginPath();
          ctx.ellipse(px, py, 6 + R(11) * 3, 4 + R(12) * 2, R(13) * 3, 0, Math.PI * 2);
          ctx.fill();
          ctx.strokeStyle = 'rgba(150,145,135,0.35)';
          ctx.lineWidth = 1;
          ctx.stroke();
        }
        // 油染み（不規則な重なり）
        if (r < 0.06) {
          for (let k = 0; k < 4; k++) {
            const g = ctx.createRadialGradient(0, 0, 0, 0, 0, 7 + R(k + 20) * 7);
            g.addColorStop(0, 'rgba(8,8,12,0.4)');
            g.addColorStop(1, 'rgba(8,8,12,0)');
            ctx.save();
            ctx.translate(x + 10 + R(k + 24) * 20, y + 10 + R(k + 28) * 20);
            ctx.scale(1, 0.6 + R(k + 32) * 0.6);
            ctx.fillStyle = g;
            ctx.fillRect(-15, -15, 30, 30);
            ctx.restore();
          }
        }
        // タイヤ痕（道路の向きに沿って）
        if (r > 0.92) {
          const horiz = at(tx - 1, ty) === T_ROAD && at(tx + 1, ty) === T_ROAD;
          ctx.strokeStyle = 'rgba(12,12,12,0.28)';
          ctx.lineWidth = 2.5;
          ctx.beginPath();
          for (const off of [0, 7]) {
            if (horiz) {
              ctx.moveTo(x, y + 12 + off);
              ctx.quadraticCurveTo(x + 20, y + 12 + off + (R(14) - 0.5) * 8, x + TILE, y + 14 + off);
            } else {
              ctx.moveTo(x + 12 + off, y);
              ctx.quadraticCurveTo(x + 12 + off + (R(14) - 0.5) * 8, y + 20, x + 14 + off, y + TILE);
            }
          }
          ctx.stroke();
        }
        // 路肩：道路の外側の縁石と、はみ出した雑草
        for (const [dx, dy] of [
          [0, -1],
          [0, 1],
          [-1, 0],
          [1, 0],
        ]) {
          const n = at(tx + dx, ty + dy);
          if (n === T_ROAD || n === T_WALL || n === T_WINDOW) continue;
          ctx.fillStyle = 'rgba(150,145,130,0.28)';
          if (dy) ctx.fillRect(x, dy < 0 ? y : y + TILE - 2, TILE, 2);
          else ctx.fillRect(dx < 0 ? x : x + TILE - 2, y, 2, TILE);
          if (n === T_GRASS) {
            ctx.strokeStyle = 'rgba(95,105,60,0.55)';
            ctx.lineWidth = 1;
            ctx.beginPath();
            for (let k = 0; k < 5; k++) {
              const bx = dy ? x + R(k + 50) * TILE : dx < 0 ? x + 1 : x + TILE - 1;
              const by = dx ? y + R(k + 55) * TILE : dy < 0 ? y + 1 : y + TILE - 1;
              ctx.moveTo(bx, by);
              ctx.lineTo(bx + (dx ? -dx * 4 : (R(k) - 0.5) * 3), by + (dy ? -dy * 4 : (R(k) - 0.5) * 3));
            }
            ctx.stroke();
          }
        }
      } else if (t === T_GRASS) {
        // 枯れ草の株（扇状の葉）
        if (r > 0.45) {
          const gx = x + 6 + R(1) * 28;
          const gy = y + 6 + R(2) * 28;
          const dry = R(3) > 0.5;
          ctx.lineWidth = 1;
          for (let k = 0; k < 7; k++) {
            const a = -Math.PI / 2 + (k - 3) * 0.32 + (R(k + 4) - 0.5) * 0.2;
            const l = 5 + R(k + 11) * 5;
            ctx.strokeStyle = dry ? `rgba(${160 + k * 4},${145 + k * 3},90,0.55)` : `rgba(${70 + k * 5},${95 + k * 4},50,0.6)`;
            ctx.beginPath();
            ctx.moveTo(gx, gy);
            ctx.lineTo(gx + Math.cos(a) * l, gy + Math.sin(a) * l);
            ctx.stroke();
          }
          ctx.fillStyle = 'rgba(0,0,0,0.18)';
          ctx.beginPath();
          ctx.ellipse(gx + 1, gy + 1, 4, 1.6, 0, 0, Math.PI * 2);
          ctx.fill();
        }
        // 小石（影とハイライト付き）
        for (let i = 0; i < 2; i++) {
          if (R(i + 20) < 0.55) continue;
          const px = x + R(i + 22) * TILE;
          const py = y + R(i + 24) * TILE;
          const s = 1.5 + R(i + 26) * 2;
          ctx.fillStyle = 'rgba(0,0,0,0.3)';
          ctx.beginPath();
          ctx.ellipse(px + 1, py + 1, s, s * 0.7, 0, 0, Math.PI * 2);
          ctx.fill();
          ctx.fillStyle = '#8a8476';
          ctx.beginPath();
          ctx.ellipse(px, py, s, s * 0.7, 0, 0, Math.PI * 2);
          ctx.fill();
          ctx.fillStyle = 'rgba(255,250,230,0.3)';
          ctx.fillRect(px - s * 0.5, py - s * 0.5, s * 0.6, 0.8);
        }
        // 落ち葉・ごみ
        if (r < 0.12) {
          for (let i = 0; i < 4; i++) {
            ctx.fillStyle = ['rgba(150,90,40,0.6)', 'rgba(120,80,40,0.55)', 'rgba(170,130,60,0.5)'][i % 3];
            ctx.beginPath();
            ctx.ellipse(x + R(i + 30) * TILE, y + R(i + 34) * TILE, 2, 1.1, R(i + 38) * 3, 0, Math.PI * 2);
            ctx.fill();
          }
        } else if (r < 0.14) {
          ctx.save();
          ctx.translate(x + R(40) * 30 + 5, y + R(41) * 30 + 5);
          ctx.rotate(R(42) * 3);
          ctx.fillStyle = 'rgba(210,205,190,0.7)';
          ctx.fillRect(-3, -2, 6, 4);
          ctx.restore();
        }
      } else if (t === T_DIRT) {
        // 乾いた泥のひび
        if (fbm(x / 70, y / 70, 91, 2) > 0.58) {
          ctx.strokeStyle = 'rgba(40,30,20,0.35)';
          ctx.lineWidth = 0.8;
          ctx.beginPath();
          for (let k = 0; k < 4; k++) {
            let cx = x + R(k) * TILE;
            let cy = y + R(k + 5) * TILE;
            ctx.moveTo(cx, cy);
            for (let s = 0; s < 3; s++) {
              cx += (R(k * 3 + s + 10) - 0.5) * 14;
              cy += (R(k * 3 + s + 20) - 0.5) * 14;
              ctx.lineTo(cx, cy);
            }
          }
          ctx.stroke();
        }
        for (let i = 0; i < 3; i++) {
          const px = x + R(i + 30) * TILE;
          const py = y + R(i + 33) * TILE;
          const s = 1.2 + R(i + 36) * 2.2;
          ctx.fillStyle = 'rgba(0,0,0,0.28)';
          ctx.fillRect(px + 0.8, py + 0.8, s, s * 0.8);
          ctx.fillStyle = '#968a76';
          ctx.fillRect(px, py, s, s * 0.8);
        }
      } else if (t === T_WOOD) {
        // 木目（板ごとに細い波線）と節、板の段差のハイライト
        ctx.lineWidth = 0.6;
        for (let k = 0; k < 4; k++) {
          const py = y + k * 10;
          ctx.fillStyle = 'rgba(255,235,200,0.07)';
          ctx.fillRect(x, py + 1, TILE, 1);
          ctx.strokeStyle = 'rgba(40,24,12,0.22)';
          for (let l = 0; l < 2; l++) {
            const ly = py + 3.5 + l * 3;
            ctx.beginPath();
            ctx.moveTo(x, ly);
            ctx.bezierCurveTo(x + 13, ly + (R(k * 2 + l) - 0.5) * 2.5, x + 27, ly - (R(k * 2 + l + 9) - 0.5) * 2.5, x + TILE, ly);
            ctx.stroke();
          }
          if (R(k + 20) > 0.85) {
            ctx.fillStyle = 'rgba(50,28,14,0.45)';
            ctx.beginPath();
            ctx.ellipse(x + R(k + 24) * 34 + 3, py + 5, 2.2, 1.3, 0, 0, Math.PI * 2);
            ctx.fill();
          }
        }
        if (r > 0.8) {
          // 擦り傷
          ctx.strokeStyle = 'rgba(220,200,170,0.12)';
          ctx.beginPath();
          ctx.moveTo(x + R(30) * 30, y + R(31) * 30);
          ctx.lineTo(x + R(32) * 40, y + R(33) * 40);
          ctx.stroke();
        }
      } else if (t === T_TILE) {
        // 1枚ごとの色ムラと面取り、目地の汚れ
        for (let k = 0; k < 4; k++) {
          const ox = x + (k % 2) * 20;
          const oy = y + Math.floor(k / 2) * 20;
          const v = R(k + 60);
          ctx.fillStyle = v > 0.5 ? `rgba(255,250,240,${(v - 0.5) * 0.12})` : `rgba(0,0,0,${(0.5 - v) * 0.12})`;
          ctx.fillRect(ox + 1, oy + 1, 19, 19);
          ctx.fillStyle = 'rgba(255,255,250,0.1)';
          ctx.fillRect(ox + 1, oy + 1, 18, 1);
          ctx.fillRect(ox + 1, oy + 1, 1, 18);
          ctx.fillStyle = 'rgba(0,0,0,0.12)';
          ctx.fillRect(ox + 1, oy + 19, 19, 1);
          ctx.fillRect(ox + 19, oy + 1, 1, 19);
          if (R(k + 70) > 0.96) {
            // 剥がれたタイル
            ctx.fillStyle = '#5a5852';
            ctx.fillRect(ox + 1, oy + 1, 19, 19);
            for (let s = 0; s < 6; s++) {
              ctx.fillStyle = 'rgba(0,0,0,0.25)';
              ctx.fillRect(ox + 2 + R(k * 6 + s) * 15, oy + 2 + R(k * 6 + s + 3) * 15, 1.5, 1.5);
            }
          }
        }
      } else if (t === T_FLOOR) {
        // コンクリートのヘアクラックと染み
        if (r > 0.7) {
          ctx.strokeStyle = 'rgba(20,18,16,0.35)';
          ctx.lineWidth = 0.7;
          ctx.beginPath();
          let cx = x + R(1) * TILE;
          let cy = y + R(2) * TILE;
          ctx.moveTo(cx, cy);
          for (let s = 0; s < 5; s++) {
            cx += (R(s + 3) - 0.5) * 16;
            cy += (R(s + 9) - 0.5) * 16;
            ctx.lineTo(cx, cy);
          }
          ctx.stroke();
        }
        if (r < 0.1) {
          const g = ctx.createRadialGradient(x + 20, y + 20, 0, x + 20, y + 20, 18);
          g.addColorStop(0, 'rgba(50,40,28,0.3)');
          g.addColorStop(1, 'rgba(50,40,28,0)');
          ctx.fillStyle = g;
          ctx.fillRect(x, y, TILE, TILE);
        }
      }

      // 壁際の床の暗がり（環境遮蔽）
      if (indoor(t)) {
        const ao = (dx: number, dy: number) => {
          if (!wallLike(at(tx + dx, ty + dy))) return;
          const g =
            dx === 0
              ? ctx.createLinearGradient(0, dy < 0 ? y : y + TILE, 0, dy < 0 ? y + 12 : y + TILE - 12)
              : ctx.createLinearGradient(dx < 0 ? x : x + TILE, 0, dx < 0 ? x + 12 : x + TILE - 12, 0);
          g.addColorStop(0, 'rgba(0,0,0,0.38)');
          g.addColorStop(1, 'rgba(0,0,0,0)');
          ctx.fillStyle = g;
          if (dx === 0) ctx.fillRect(x, dy < 0 ? y : y + TILE - 12, TILE, 12);
          else ctx.fillRect(dx < 0 ? x : x + TILE - 12, y, 12, TILE);
        };
        ao(0, -1);
        ao(-1, 0);
        ao(1, 0);
        ao(0, 1);
      }
    }

  // 汚染地帯：黄緑色の染み・水たまり・枯れた地面
  for (const loc of world.locations ?? []) {
    if (!loc.hot) continue;
    if (loc.x + loc.w + 4 < rx0 || loc.y + loc.h + 4 < ry0 || loc.x - 4 > rx1 || loc.y - 4 > ry1) continue;
    const x0 = (loc.x - 3) * TILE;
    const y0 = (loc.y - 3) * TILE;
    const w = (loc.w + 6) * TILE;
    const hh = (loc.h + 6) * TILE;
    for (let i = 0; i < 26; i++) {
      const px = x0 + hash(i, loc.x, 501) * w;
      const py = y0 + hash(i, loc.y, 502) * hh;
      const rad = 14 + hash(i, 3, 503) * 34;
      const g = ctx.createRadialGradient(px, py, 0, px, py, rad);
      g.addColorStop(0, 'rgba(120,140,40,0.32)');
      g.addColorStop(0.6, 'rgba(90,100,30,0.16)');
      g.addColorStop(1, 'rgba(90,100,30,0)');
      ctx.fillStyle = g;
      ctx.fillRect(px - rad, py - rad, rad * 2, rad * 2);
      if (i % 4 === 0) {
        // 毒々しい水たまり
        ctx.fillStyle = 'rgba(110,135,50,0.45)';
        ctx.beginPath();
        ctx.ellipse(px, py, rad * 0.35, rad * 0.22, hash(i, 9, 504) * 3, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = 'rgba(220,240,150,0.25)';
        ctx.fillRect(px - rad * 0.15, py - rad * 0.08, rad * 0.18, 1.2);
      }
    }
  }
}

/** 壁の天面のひび・欠け・すす（壁を描いたあとに重ねる） */
export function wallWear(ctx: CanvasRenderingContext2D, at: (x: number, y: number) => number, rx0: number, ry0: number, rx1: number, ry1: number): void {
  for (let ty = ry0; ty < ry1; ty++)
    for (let tx = rx0; tx < rx1; tx++) {
      if (at(tx, ty) !== T_WALL) continue;
      const x = tx * TILE;
      const y = ty * TILE;
      const r = hash(tx, ty, 611);
      const R = (i: number) => hash(tx, ty, 620 + i);
      // レンガの目地の陰
      ctx.fillStyle = 'rgba(0,0,0,0.18)';
      for (let row = 1; row < 4; row++) ctx.fillRect(x, y + row * 10, TILE, 1);
      if (r > 0.72) {
        ctx.strokeStyle = 'rgba(15,14,12,0.6)';
        ctx.lineWidth = 1;
        ctx.beginPath();
        let cx = x + R(1) * TILE;
        let cy = y + 2;
        ctx.moveTo(cx, cy);
        for (let s = 0; s < 4; s++) {
          cx += (R(s + 2) - 0.5) * 10;
          cy += 8 + R(s + 6) * 3;
          ctx.lineTo(cx, cy);
        }
        ctx.stroke();
      }
      if (r < 0.2) {
        // 欠けた角（下地が見える）
        ctx.fillStyle = '#2e2c28';
        ctx.beginPath();
        const cx = x + (R(10) > 0.5 ? TILE : 0);
        const cy = y + (R(11) > 0.5 ? TILE : 0);
        ctx.moveTo(cx, cy);
        ctx.lineTo(cx + (cx > x ? -9 : 9), cy);
        ctx.lineTo(cx, cy + (cy > y ? -7 : 7));
        ctx.closePath();
        ctx.fill();
      }
      if (r > 0.3 && r < 0.4) {
        const g = ctx.createRadialGradient(x + 20, y + 20, 0, x + 20, y + 20, 22);
        g.addColorStop(0, 'rgba(10,8,6,0.35)');
        g.addColorStop(1, 'rgba(10,8,6,0)');
        ctx.fillStyle = g;
        ctx.fillRect(x, y, TILE, TILE);
      }
    }
}
