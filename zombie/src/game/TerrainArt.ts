// ============================================================
// 地形のプロシージャル描画（起動時に1回だけオフスクリーンへ焼き込む）
//   1) 半解像度のピクセル単位でノイズ合成：草地・土・アスファルト・床をノイズで色ムラ付け、
//      草地と土の境界はノイズで歪ませて自然になじませる
//   2) 全解像度で細部を描き込み：道路の白線・ひび割れ・マンホール、床の目地、草の葉、小石
//   3) 廃墟の壁：ぼかした落ち影＋南側の側面（2.5D）＋レンガの天面
//   ★ スプライト化する場合はこのファイルの代わりにタイル画像を並べる処理を書けばOK
// ============================================================
import { CHUNK, MAP_H, MAP_W, T_BRIDGE, T_DIRT, T_FENCE, T_FLOOR, T_GRASS, T_ROAD, T_SHALLOW, T_TILE, T_WALL, T_WATER, T_WINDOW, T_WOOD, TILE } from './constants';

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
  // 川も地図の外へ流れ続ける
  if ((e === T_WATER || e === T_SHALLOW || e === T_BRIDGE) && outX !== outY) return T_WATER;
  return fbm(tx / 9, ty / 9, 77, 2) > 0.56 ? T_DIRT : T_GRASS;
}

/** 1チャンク分の地形を、何回かに分けて焼き込む（1フレームで固まらないように yield する） */
export function* bakeChunkSteps(world: TileWorld, ccx: number, ccy: number, out: { canvas?: HTMLCanvasElement }): Generator<void> {
  const terrainAt = (tx: number, ty: number) => sceneryAt(world, tx, ty);
  // 見た目用の地形：カーブ道路は下地を草地として描き（道はベクターで上に描く）、橋の下は水
  const visualAt = (tx: number, ty: number) => {
    const t = terrainAt(tx, ty);
    if (t === T_BRIDGE) return T_WATER;
    if (t === T_ROAD && world.inBounds(tx, ty) && world.vec[ty * MAP_W + tx]) return T_GRASS;
    return t;
  };
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
  // 水らしさ（3×3 でぼかした値）をタイルの中心に置き、ピクセルごとに補間して岸の形を決める
  const WM = 3;
  const WW = CHUNK + WM * 2;
  const wetRaw = new Float32Array(WW * WW);
  const wetBlur = new Float32Array(WW * WW);
  const deepRaw = new Float32Array(WW * WW);
  const deepBlur = new Float32Array(WW * WW);
  let anyWet = false;
  for (let y = 0; y < WW; y++)
    for (let x = 0; x < WW; x++) {
      const v = visualAt(tx0 - WM + x, ty0 - WM + y);
      const w = v === T_WATER || v === T_SHALLOW ? 1 : 0;
      wetRaw[y * WW + x] = w;
      deepRaw[y * WW + x] = v === T_WATER ? 1 : 0;
      if (w) anyWet = true;
    }
  const blur = (src: Float32Array, dst: Float32Array) => {
    for (let y = 1; y < WW - 1; y++)
      for (let x = 1; x < WW - 1; x++) {
        let sum = 0;
        for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) sum += src[(y + dy) * WW + x + dx] * (dx === 0 && dy === 0 ? 2 : 1);
        dst[y * WW + x] = sum / 10;
      }
  };
  if (anyWet) {
    blur(wetRaw, wetBlur);
    blur(deepRaw, deepBlur);
  }
  const fieldAt = (raw: Float32Array, bl: Float32Array, x: number, y: number) => {
    const lx = x - tx0 + WM;
    const ly = y - ty0 + WM;
    return lx < 1 || ly < 1 || lx >= WW - 1 || ly >= WW - 1 ? raw[Math.max(0, Math.min(WW - 1, ly)) * WW + Math.max(0, Math.min(WW - 1, lx))] : bl[ly * WW + lx];
  };
  const wetAt = (x: number, y: number) => fieldAt(wetRaw, wetBlur, x, y);
  const deepAt = (x: number, y: number) => fieldAt(deepRaw, deepBlur, x, y);
  for (let py = 0; py < bh; py++) {
    if (py % 50 === 49) yield;
    for (let px = 0; px < bw; px++) {
      const wx = X0 + px * S;
      const wy = Y0 + py * S;
      let t = visualAt(Math.floor(wx / TILE), Math.floor(wy / TILE));
      // 自然地形の境界をノイズで歪ませる
      const natural = (v: number) => v === T_GRASS || v === T_DIRT || v === T_WATER || v === T_SHALLOW;
      let shore = 9;
      if (natural(t)) {
        const ox = (fbm(wx / 90, wy / 90, 11, 2) - 0.5) * 46;
        const oy = (fbm(wx / 90, wy / 90, 23, 2) - 0.5) * 46;
        const t2 = visualAt(Math.floor((wx + ox) / TILE), Math.floor((wy + oy) / TILE));
        const wetA = t === T_WATER || t === T_SHALLOW;
        const wetB = t2 === T_WATER || t2 === T_SHALLOW;
        if (natural(t2) && !wetA && !wetB) t = t2;
        // 水辺：ぼかした「水らしさ」を補間して岸の形を決める（階段状にならず、なめらかな岸になる）
        if (anyWet) {
          const fx = wx / TILE - 0.5;
          const fy = wy / TILE - 0.5;
          const ix = Math.floor(fx);
          const iy = Math.floor(fy);
          const w00 = wetAt(ix, iy);
          const w10 = wetAt(ix + 1, iy);
          const w01 = wetAt(ix, iy + 1);
          const w11 = wetAt(ix + 1, iy + 1);
          if (w00 + w10 + w01 + w11 > 0 && w00 + w10 + w01 + w11 < 4) {
            const ax = fx - ix;
            const ay = fy - iy;
            const wet = (w00 * (1 - ax) + w10 * ax) * (1 - ay) + (w01 * (1 - ax) + w11 * ax) * ay;
            const thr = 0.5 + (fbm(wx / 50, wy / 50, 71, 2) - 0.5) * 0.25;
            shore = wet - thr;
            if (wet > thr && !wetA) t = T_SHALLOW;
            else if (wet <= thr && wetA) t = T_DIRT;
          }
          // 深みと浅瀬の境目も同じようになめらかに
          if (t === T_WATER || t === T_SHALLOW) {
            const d00 = deepAt(ix, iy);
            const d10 = deepAt(ix + 1, iy);
            const d01 = deepAt(ix, iy + 1);
            const d11 = deepAt(ix + 1, iy + 1);
            if (d00 + d10 + d01 + d11 > 0) {
              const ax = fx - ix;
              const ay = fy - iy;
              const deep = (d00 * (1 - ax) + d10 * ax) * (1 - ay) + (d01 * (1 - ax) + d11 * ax) * ay;
              t = deep > 0.5 + (fbm(wx / 40, wy / 40, 83, 2) - 0.5) * 0.3 ? T_WATER : T_SHALLOW;
            } else t = T_SHALLOW;
          }
        }
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
        case T_WATER: {
          // 濁った深い水：流れの筋と深さのムラ
          const k = n1 * 0.6 + fbm(wx / 40, wy / 120, 61, 2) * 0.4;
          r = mix(26, 40, k) + (grain - 0.5) * 6;
          g = mix(40, 56, k) + (grain - 0.5) * 6;
          b = mix(44, 58, k) + (grain - 0.5) * 6;
          break;
        }
        case T_SHALLOW: {
          // 浅瀬：川底の砂利が透けて見える
          const k = n2;
          r = mix(52, 70, k) + (grain - 0.5) * 14;
          g = mix(72, 88, k) + (grain - 0.5) * 12;
          b = mix(76, 90, k) + (grain - 0.5) * 10;
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
      // 岸辺：水側は白い泡、陸側は湿った黒い土
      if (shore < 0.07 && shore > 0 && (t === T_WATER || t === T_SHALLOW)) {
        const k2 = 1 - shore / 0.07;
        r += 34 * k2 * (grain > 0.4 ? 1 : 0.4);
        g += 36 * k2 * (grain > 0.4 ? 1 : 0.4);
        b += 32 * k2 * (grain > 0.4 ? 1 : 0.4);
      } else if (shore <= 0 && shore > -0.12) {
        const k2 = 1 + shore / 0.12;
        r -= 26 * k2;
        g -= 24 * k2;
        b -= 20 * k2;
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
      const t = visualAt(tx, ty);
      const x = tx * TILE;
      const y = ty * TILE;
      const r = hash(tx, ty, 1);
      if (t === T_WATER || t === T_SHALLOW) {
        drawWaterDetails(ctx, tx, ty, t);
        continue;
      }
      // 岸辺：水に面した陸のタイルに葦と小石
      if (t === T_GRASS || t === T_DIRT) {
        const wetN = (dx: number, dy: number) => {
          const v = visualAt(tx + dx, ty + dy);
          return v === T_WATER || v === T_SHALLOW;
        };
        const sides = [
          [0, -1],
          [0, 1],
          [-1, 0],
          [1, 0],
        ].filter(([dx, dy]) => wetN(dx, dy));
        for (const [dx, dy] of sides) {
          // 水際に寄せた位置
          const px = (f: number) => (dx ? (dx < 0 ? x + 2 + f * 12 : x + TILE - 2 - f * 12) : x + f * TILE);
          const py = (f: number) => (dy ? (dy < 0 ? y + 2 + f * 12 : y + TILE - 2 - f * 12) : y + f * TILE);
          ctx.lineWidth = 1.2;
          for (let i = 0; i < 9; i++) {
            const a = hash(tx, ty, 700 + i + dx * 13 + dy * 29);
            const b = hash(tx, ty, 720 + i + dx * 13 + dy * 29);
            const bx = dx ? px(b) : px(a);
            const by = dy ? py(b) : py(a);
            ctx.strokeStyle = i % 3 === 0 ? 'rgba(150,140,80,0.7)' : 'rgba(70,88,44,0.75)';
            ctx.beginPath();
            ctx.moveTo(bx, by);
            ctx.lineTo(bx + (a - 0.5) * 5, by - 6 - b * 7);
            ctx.stroke();
          }
          for (let i = 0; i < 3; i++) {
            const a = hash(tx, ty, 740 + i + dx * 7 + dy * 11);
            const b = hash(tx, ty, 760 + i + dx * 7 + dy * 11);
            ctx.fillStyle = i % 2 ? 'rgba(140,134,120,0.85)' : 'rgba(96,92,84,0.85)';
            ctx.beginPath();
            ctx.ellipse(dx ? px(b * 0.6) : px(a), dy ? py(b * 0.6) : py(a), 2 + a * 2.5, 1.5 + b * 1.5, a * 3, 0, Math.PI * 2);
            ctx.fill();
          }
        }
      }
      if (t === T_GRASS) {
        // 草の葉（控えめ：自機や敵のシルエットが埋もれないように）
        ctx.lineWidth = 1;
        for (let i = 0; i < 5; i++) {
          const gx = x + hash(tx, ty, i + 10) * TILE;
          const gy = y + hash(tx, ty, i + 30) * TILE;
          const lean = (hash(tx, ty, i + 50) - 0.5) * 4;
          ctx.strokeStyle = hash(tx, ty, i + 70) > 0.5 ? 'rgba(150,145,95,0.24)' : 'rgba(40,40,25,0.24)';
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
        for (let i = 0; i < 2; i++) {
          ctx.fillStyle = 'rgba(40,30,22,0.35)';
          ctx.beginPath();
          ctx.ellipse(x + hash(tx, ty, i) * TILE, y + hash(tx, ty, i + 9) * TILE, 1.5 + hash(tx, ty, i + 3) * 2, 1 + hash(tx, ty, i + 5), 0, 0, Math.PI * 2);
          ctx.fill();
          ctx.fillStyle = 'rgba(200,180,150,0.25)';
          ctx.fillRect(x + hash(tx, ty, i + 13) * TILE, y + hash(tx, ty, i + 17) * TILE, 1.5, 1.5);
        }
      } else if (t === T_ROAD) {
        drawRoadDetails(ctx, tx, ty, visualAt);
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
  detailPass(ctx, world, visualAt, tx0 - 1, ty0 - 1, tx1 + 1, ty1 + 1);
  yield;
  // カーブの旧道・橋・国道の車線（タイルに縛られないベクターで描く）
  drawRoadFeatures(ctx, world, terrainAt, tx0, ty0, tx1, ty1);
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
    [T_WATER]: [42, 70, 86],
    [T_SHALLOW]: [76, 104, 106],
    [T_BRIDGE]: [128, 118, 100],
  };
  const hwy = (tx: number, ty: number) => world.features.highways.some((h) => (h.horiz ? ty >= h.at && ty < h.at + h.w : tx >= h.at && tx < h.at + h.w));
  for (let ty = 0; ty < MAP_H; ty++)
    for (let tx = 0; tx < MAP_W; tx++) {
      const t = world.terrainAt(tx, ty);
      // 国道は明るく太く見えるように
      const c = t === T_ROAD && hwy(tx, ty) ? [104, 100, 88] : (col[t] ?? [60, 60, 60]);
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
    // 欲しいものの総数がキャッシュの容量を超えると、焼いては捨てるを繰り返して重くなる。
    // 優先度の高いものから容量-4個までに絞る（見えているチャンクは常に最優先）
    const top = list.sort((a, b) => a.pri - b.pri).slice(0, this.max - 4);
    this.wanted = top.filter((w) => !this.done.has(`${w.cx},${w.cy}`));
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


/** 水面：さざ波・浅瀬の小石（岸の泡と湿った土は下地の色で描く） */
function drawWaterDetails(ctx: CanvasRenderingContext2D, tx: number, ty: number, t: number): void {
  const x = tx * TILE;
  const y = ty * TILE;
  const R = (i: number) => hash(tx, ty, 600 + i);
  // さざ波（流れに沿った短い光の筋）
  ctx.strokeStyle = t === T_WATER ? 'rgba(150,175,170,0.16)' : 'rgba(190,200,180,0.18)';
  ctx.lineWidth = 1;
  ctx.beginPath();
  for (let i = 0; i < 3; i++) {
    const px = x + R(i) * TILE;
    const py = y + R(i + 5) * TILE;
    ctx.moveTo(px - 5, py);
    ctx.quadraticCurveTo(px, py - 2, px + 5, py);
  }
  ctx.stroke();
  if (t === T_SHALLOW) {
    for (let i = 0; i < 5; i++) {
      ctx.fillStyle = i % 2 ? 'rgba(150,140,115,0.45)' : 'rgba(40,46,40,0.4)';
      ctx.beginPath();
      ctx.ellipse(x + R(i + 10) * TILE, y + R(i + 20) * TILE, 2 + R(i + 30) * 2, 1.5 + R(i + 40), R(i + 50) * 3, 0, Math.PI * 2);
      ctx.fill();
    }
  }
}

/** 折れ線を両端から len だけ短くする（交差点の中に車線の線を描かない） */
function trimPolyline(pts: [number, number][], len: number): [number, number][] {
  const out = pts.slice();
  for (const end of [0, 1]) {
    let left = len;
    while (out.length > 2 && left > 0) {
      const a = end ? out[out.length - 1] : out[0];
      const b = end ? out[out.length - 2] : out[1];
      const d = Math.hypot(b[0] - a[0], b[1] - a[1]);
      if (d <= left) {
        if (end) out.pop();
        else out.shift();
        left -= d;
      } else {
        const k = left / d;
        const p: [number, number] = [a[0] + (b[0] - a[0]) * k, a[1] + (b[1] - a[1]) * k];
        if (end) out[out.length - 1] = p;
        else out[0] = p;
        left = 0;
      }
    }
  }
  return out;
}

/** カーブの旧道・橋・国道の車線をチャンクに描く */
function drawRoadFeatures(ctx: CanvasRenderingContext2D, world: TileWorld, at: (x: number, y: number) => number, tx0: number, ty0: number, tx1: number, ty1: number): void {
  const F = world.features;
  const roadLike = (t: number) => t === T_ROAD || t === T_BRIDGE;
  const M = 4;
  // ---- カーブの旧道 ----
  for (const c of F.curves) {
    if (!c.pts.some(([x, y]) => x > tx0 - M && x < tx1 + M && y > ty0 - M && y < ty1 + M)) continue;
    const W = c.w * TILE;
    const path = (pts: [number, number][]) => {
      ctx.beginPath();
      pts.forEach(([x, y], i) => (i ? ctx.lineTo(x * TILE, y * TILE) : ctx.moveTo(x * TILE, y * TILE)));
    };
    ctx.save();
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    path(c.pts);
    ctx.strokeStyle = 'rgba(72,70,58,0.9)'; // 路肩の砂利
    ctx.lineWidth = W + 10;
    ctx.stroke();
    ctx.strokeStyle = '#3b3b39';
    ctx.lineWidth = W;
    ctx.stroke();
    // 骨材のムラ（細い筋を何本か）
    ctx.lineWidth = W * 0.35;
    ctx.strokeStyle = 'rgba(70,70,66,0.25)';
    ctx.setLineDash([30, 50]);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.lineCap = 'butt';
    const inner = trimPolyline(c.pts, 1.8);
    path(inner);
    ctx.strokeStyle = 'rgba(210,210,200,0.32)';
    ctx.lineWidth = W - 8;
    ctx.stroke();
    ctx.strokeStyle = '#3b3b39';
    ctx.lineWidth = W - 12;
    ctx.stroke();
    ctx.strokeStyle = 'rgba(225,190,80,0.55)';
    ctx.lineWidth = 3;
    ctx.setLineDash([16, 20]);
    ctx.stroke();
    ctx.restore();
  }
  // ---- 橋（崩落したものは岸から突き出た残骸だけ） ----
  for (const b of F.bridges) {
    if (b.x + b.w < tx0 - 1 || b.x > tx1 + 1 || b.y + b.h < ty0 - 1 || b.y > ty1 + 1) continue;
    const x0 = b.x * TILE;
    const y0 = b.y * TILE;
    const w = b.w * TILE;
    const h = b.h * TILE;
    if (b.broken) {
      for (const side of [0, 1]) {
        const ex = side ? x0 + w : x0;
        const dir = side ? -1 : 1;
        const len = TILE * (1 + hash(b.x, b.y, side) * 0.8);
        ctx.fillStyle = 'rgba(0,0,0,0.3)';
        ctx.fillRect(Math.min(ex, ex + dir * len) + 6, y0 + 10, len, h);
        ctx.fillStyle = '#5a5750';
        ctx.beginPath();
        ctx.moveTo(ex, y0 - 6);
        ctx.lineTo(ex + dir * len, y0 - 6);
        for (let k = 0; k <= 6; k++) ctx.lineTo(ex + dir * (len - 4 - hash(b.x + k, b.y, side + 3) * 16), y0 - 6 + ((h + 12) * k) / 6);
        ctx.lineTo(ex, y0 + h + 6);
        ctx.closePath();
        ctx.fill();
        // 鉄筋
        ctx.strokeStyle = 'rgba(120,80,50,0.8)';
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        for (let k = 1; k < 5; k++) {
          const yy = y0 - 6 + ((h + 12) * k) / 5;
          ctx.moveTo(ex + dir * (len - 10), yy);
          ctx.lineTo(ex + dir * (len + 6 + hash(k, b.x, 9) * 8), yy + (hash(k, b.y, 8) - 0.5) * 8);
        }
        ctx.stroke();
      }
      // 川に落ちたコンクリート片
      for (let k = 0; k < 5; k++) {
        ctx.fillStyle = 'rgba(90,88,80,0.85)';
        ctx.beginPath();
        ctx.ellipse(x0 + w * (0.3 + hash(b.x, k, 4) * 0.4), y0 + h * hash(b.y, k, 5), 8 + hash(k, b.x, 6) * 8, 5 + hash(k, b.y, 7) * 5, hash(k, k, 8) * 3, 0, Math.PI * 2);
        ctx.fill();
      }
      continue;
    }
    const ext = TILE * 0.5;
    // 橋脚（水面から立ち上がる柱：床版の両脇に少し見え、周りに波紋）
    for (let px = x0 + TILE * 1.5; px < x0 + w - TILE; px += TILE * 3) {
      ctx.strokeStyle = 'rgba(190,200,190,0.25)';
      ctx.lineWidth = 1.5;
      for (const py of [y0 - 18, y0 + h + 18]) {
        ctx.beginPath();
        ctx.ellipse(px, py, 16, 7, 0, 0, Math.PI * 2);
        ctx.stroke();
      }
      ctx.fillStyle = '#4a4740';
      ctx.fillRect(px - 9, y0 - 22, 18, h + 44);
      ctx.fillStyle = '#5e5a52';
      ctx.fillRect(px - 9, y0 - 22, 18, 5);
    }
    // 水面に落ちる影（ぼかし）
    ctx.save();
    ctx.filter = 'blur(5px)';
    ctx.fillStyle = 'rgba(0,0,0,0.55)';
    ctx.fillRect(x0 - ext + 10, y0 + 18, w + ext * 2, h + 4);
    ctx.restore();
    // 橋台（両岸のコンクリートの土台と袖壁）
    for (const side of [0, 1]) {
      const ax = side ? x0 + w + ext - 6 : x0 - ext - 22;
      ctx.fillStyle = '#56534b';
      ctx.fillRect(ax, y0 - 16, 28, h + 32);
      ctx.fillStyle = '#6c685e';
      ctx.fillRect(ax, y0 - 16, 28, 5);
      ctx.fillStyle = 'rgba(0,0,0,0.3)';
      ctx.fillRect(ax, y0 + h + 12, 28, 4);
      // 袖壁（斜めに広がる）
      ctx.strokeStyle = '#4a4740';
      ctx.lineWidth = 5;
      ctx.beginPath();
      const ox = side ? ax + 28 : ax;
      const d = side ? 1 : -1;
      ctx.moveTo(ox, y0 - 14);
      ctx.lineTo(ox + d * 18, y0 - 30);
      ctx.moveTo(ox, y0 + h + 14);
      ctx.lineTo(ox + d * 18, y0 + h + 30);
      ctx.stroke();
    }
    // 床版（コンクリート）：側面の厚みを見せる
    ctx.fillStyle = '#3a3833';
    ctx.fillRect(x0 - ext, y0 + h + 8, w + ext * 2, 6);
    ctx.fillStyle = '#5b5850';
    ctx.fillRect(x0 - ext, y0 - 10, w + ext * 2, h + 20);
    ctx.fillStyle = '#44433f';
    ctx.fillRect(x0 - ext, y0, w + ext * 2, h);
    // 縁石の影
    ctx.fillStyle = 'rgba(0,0,0,0.3)';
    ctx.fillRect(x0 - ext, y0, w + ext * 2, 3);
    ctx.fillStyle = 'rgba(255,255,255,0.06)';
    ctx.fillRect(x0 - ext, y0 + h - 3, w + ext * 2, 3);
    // 伸縮継手
    ctx.fillStyle = 'rgba(20,20,20,0.6)';
    for (let xx = x0; xx <= x0 + w; xx += TILE * 2) ctx.fillRect(xx - 1, y0, 2, h);
    // 欄干（柱＋手すり。上面は明るく、外側に影）
    for (const [ry, outer] of [
      [y0 - 10, -1],
      [y0 + h + 3, 1],
    ] as [number, number][]) {
      ctx.fillStyle = 'rgba(0,0,0,0.35)';
      ctx.fillRect(x0 - ext, outer < 0 ? ry - 3 : ry + 7, w + ext * 2, 3);
      ctx.fillStyle = '#8f8a7e';
      ctx.fillRect(x0 - ext, ry, w + ext * 2, 7);
      ctx.fillStyle = '#b4ad9e';
      ctx.fillRect(x0 - ext, ry, w + ext * 2, 2);
      ctx.fillStyle = '#2f2e2a';
      for (let xx = x0 - ext; xx <= x0 + w + ext; xx += 14) ctx.fillRect(xx, ry + 2, 3, 5);
    }
    if (!b.hwy) {
      ctx.fillStyle = 'rgba(225,190,80,0.55)';
      for (let xx = x0; xx < x0 + w; xx += TILE) ctx.fillRect(xx + 6, y0 + h / 2 - 1.5, TILE - 12, 3);
    }
  }
  // ---- 国道：路肩の実線・車線の破線・中央の黄色の二重線 ----
  for (const hw of F.highways) {
    const a0 = hw.at;
    if (hw.horiz ? a0 + hw.w < ty0 - 1 || a0 > ty1 + 1 : a0 + hw.w < tx0 - 1 || a0 > tx1 + 1) continue;
    const W = hw.w * TILE;
    const P = a0 * TILE;
    const from = hw.horiz ? tx0 - 1 : ty0 - 1;
    const to = hw.horiz ? tx1 + 1 : ty1 + 1;
    for (let k = from; k < to; k++) {
      // 交差点（横から道路が入ってくる所）には線を引かない
      const side1 = hw.horiz ? at(k, a0 - 1) : at(a0 - 1, k);
      const side2 = hw.horiz ? at(k, a0 + hw.w) : at(a0 + hw.w, k);
      if (roadLike(side1) || roadLike(side2)) continue;
      const self = hw.horiz ? at(k, a0) : at(a0, k);
      if (!roadLike(self)) continue;
      const Q = k * TILE;
      const rect = (off: number, len0: number, thick: number, len: number) => {
        if (hw.horiz) ctx.fillRect(Q + len0, P + off - thick / 2, len, thick);
        else ctx.fillRect(P + off - thick / 2, Q + len0, thick, len);
      };
      // 路肩（少し明るい帯）
      ctx.fillStyle = 'rgba(150,145,130,0.12)';
      rect(6, 0, 12, TILE);
      rect(W - 6, 0, 12, TILE);
      ctx.fillStyle = 'rgba(215,215,205,0.5)';
      rect(12, 0, 2.5, TILE);
      rect(W - 12, 0, 2.5, TILE);
      // 車線の破線
      if (k % 2 === 0) {
        ctx.fillStyle = 'rgba(215,215,205,0.42)';
        rect(W * 0.28, 8, 2.5, TILE - 16);
        rect(W * 0.72, 8, 2.5, TILE - 16);
      }
      ctx.fillStyle = 'rgba(225,185,70,0.6)';
      rect(W / 2 - 3, 0, 2.5, TILE);
      rect(W / 2 + 3, 0, 2.5, TILE);
    }
  }
}
