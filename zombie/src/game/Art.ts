// ============================================================
// ビジュアル定義（ベクター描画）
//   ★ スプライト画像に差し替えるときは、この ArtSet インターフェースを実装した
//     別クラス（例: ImageArt で ctx.drawImage を使う）を作り、Renderer の `art` を差し替えるだけでOK。
//     Renderer 側はゲームロジック・カメラ・ライティング・HUD のみを担当する。
// ============================================================
import type { ObjSnap, PlayerSnap, ZombieSnap } from '../types';
import { Tool } from '../types';
import { T_DIRT, T_FLOOR, T_GRASS, T_ROAD, T_WALL, TILE, ZOMBIE } from './constants';

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
}

export interface ZombieAnim {
  lastAtk: number;
  lunge: number;
  walk: number;
  lastX: number;
  lastY: number;
}

export interface ArtSet {
  /** 地形タイル（起動時に1回だけオフスクリーンへ焼き込む） */
  drawTerrainTile(ctx: CanvasRenderingContext2D, kind: number, tx: number, ty: number, neighbors: (dx: number, dy: number) => number): void;
  /** 地面に置かれる低いオブジェクト（スパイク・焚き火・切り株・クレート等） */
  drawLowObject(ctx: CanvasRenderingContext2D, o: ObjSnap, t: number): boolean;
  /** 高いオブジェクト（壁・木・車） */
  drawTallObject(ctx: CanvasRenderingContext2D, o: ObjSnap, t: number): void;
  drawZombie(ctx: CanvasRenderingContext2D, z: ZombieSnap, anim: ZombieAnim, t: number): void;
  drawPlayer(ctx: CanvasRenderingContext2D, p: PlayerSnap, color: string, anim: PlayerAnim, t: number): void;
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
  const f = (c: number) => Math.round(amt >= 0 ? c + (255 - c) * amt : c * (1 + amt));
  return `rgb(${f((n >> 16) & 255)},${f((n >> 8) & 255)},${f(n & 255)})`;
}

function cracks(ctx: CanvasRenderingContext2D, x: number, y: number, ratio: number, seed: number): void {
  if (ratio > 0.66) return;
  ctx.strokeStyle = 'rgba(0,0,0,0.55)';
  ctx.lineWidth = 1.5;
  const n = ratio > 0.33 ? 2 : 4;
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

// ============================================================
export class VectorArt implements ArtSet {
  drawTerrainTile(ctx: CanvasRenderingContext2D, kind: number, tx: number, ty: number, nb: (dx: number, dy: number) => number): void {
    const x = tx * TILE;
    const y = ty * TILE;
    const r = hash2(tx, ty);
    switch (kind) {
      case T_GRASS: {
        const g = 52 + Math.floor(r * 10);
        ctx.fillStyle = `rgb(${g - 14},${g + 18},${g - 22})`;
        ctx.fillRect(x, y, TILE, TILE);
        for (let i = 0; i < 6; i++) {
          ctx.fillStyle = hash2(tx, ty, i) > 0.5 ? 'rgba(120,160,80,0.25)' : 'rgba(20,40,15,0.25)';
          ctx.fillRect(x + hash2(tx, ty, i + 10) * TILE, y + hash2(tx, ty, i + 20) * TILE, 2, 3);
        }
        break;
      }
      case T_DIRT: {
        ctx.fillStyle = `rgb(${86 + r * 10},${72 + r * 8},${52})`;
        ctx.fillRect(x, y, TILE, TILE);
        for (let i = 0; i < 5; i++) {
          ctx.fillStyle = 'rgba(40,30,20,0.3)';
          ctx.beginPath();
          ctx.arc(x + hash2(tx, ty, i) * TILE, y + hash2(tx, ty, i + 9) * TILE, 1 + hash2(tx, ty, i + 3) * 2, 0, Math.PI * 2);
          ctx.fill();
        }
        break;
      }
      case T_ROAD: {
        const v = 44 + Math.floor(r * 6);
        ctx.fillStyle = `rgb(${v},${v},${v + 4})`;
        ctx.fillRect(x, y, TILE, TILE);
        // 車線（道路の中央に破線）
        ctx.fillStyle = 'rgba(220,200,120,0.35)';
        if (nb(0, 1) === T_ROAD && nb(0, -1) !== T_ROAD && (tx % 3) !== 0) ctx.fillRect(x + 4, y + TILE - 2, TILE - 8, 3);
        if (nb(1, 0) === T_ROAD && nb(-1, 0) !== T_ROAD && (ty % 3) !== 0) ctx.fillRect(x + TILE - 2, y + 4, 3, TILE - 8);
        if (r > 0.85) {
          ctx.strokeStyle = 'rgba(0,0,0,0.35)';
          ctx.beginPath();
          ctx.moveTo(x + r * 30, y + 5);
          ctx.lineTo(x + 20, y + 22);
          ctx.lineTo(x + 34, y + 30);
          ctx.stroke();
        }
        break;
      }
      case T_FLOOR: {
        const v = 78 + Math.floor(r * 8);
        ctx.fillStyle = `rgb(${v},${v - 4},${v - 10})`;
        ctx.fillRect(x, y, TILE, TILE);
        ctx.strokeStyle = 'rgba(0,0,0,0.18)';
        ctx.lineWidth = 1;
        ctx.strokeRect(x + 0.5, y + 0.5, TILE / 2, TILE / 2);
        ctx.strokeRect(x + TILE / 2 + 0.5, y + TILE / 2 + 0.5, TILE / 2 - 1, TILE / 2 - 1);
        if (r > 0.94) {
          // まばらな汚れ
          ctx.fillStyle = 'rgba(30,25,20,0.18)';
          ctx.beginPath();
          ctx.ellipse(x + 8 + hash2(tx, ty, 4) * 24, y + 8 + hash2(tx, ty, 6) * 24, 4 + r * 5, 3 + r * 3, r * 3, 0, Math.PI * 2);
          ctx.fill();
        }
        break;
      }
      case T_WALL: {
        ctx.fillStyle = '#4b4540';
        ctx.fillRect(x, y, TILE, TILE);
        // レンガ模様
        ctx.fillStyle = '#5d554d';
        for (let row = 0; row < 4; row++) {
          const off = row % 2 ? 0 : 10;
          for (let col = -1; col < 2; col++) {
            const bx = x + col * 20 + off;
            const bw = 18;
            const cx0 = Math.max(x, bx);
            const cx1 = Math.min(x + TILE, bx + bw);
            if (cx1 > cx0) ctx.fillRect(cx0, y + row * 10 + 1, cx1 - cx0, 8);
          }
        }
        ctx.fillStyle = 'rgba(255,255,255,0.06)';
        ctx.fillRect(x, y, TILE, 3);
        ctx.fillStyle = 'rgba(0,0,0,0.3)';
        if (nb(0, 1) !== T_WALL) ctx.fillRect(x, y + TILE - 4, TILE, 4);
        break;
      }
    }
  }

  drawLowObject(ctx: CanvasRenderingContext2D, o: ObjSnap, t: number): boolean {
    const x = o.tx * TILE;
    const y = o.ty * TILE;
    const cx = x + TILE / 2;
    const cy = y + TILE / 2;
    switch (o.kind) {
      case 'spike': {
        const ratio = o.hp / o.maxHp;
        ctx.globalAlpha = 0.5 + ratio * 0.5;
        ctx.fillStyle = '#5a3d22';
        ctx.fillRect(x + 3, y + 3, TILE - 6, TILE - 6);
        ctx.strokeStyle = '#c9a26b';
        ctx.lineWidth = 3;
        ctx.lineCap = 'round';
        ctx.beginPath();
        for (let i = 0; i < 3; i++) {
          const ox = x + 8 + i * 12;
          ctx.moveTo(ox - 5, y + 32);
          ctx.lineTo(ox + 5, y + 8);
          ctx.moveTo(ox + 5, y + 32);
          ctx.lineTo(ox - 5, y + 8);
        }
        ctx.stroke();
        ctx.fillStyle = '#e8e0d0';
        for (let i = 0; i < 3; i++) {
          ctx.beginPath();
          ctx.arc(x + 13 + i * 12, y + 8, 1.8, 0, Math.PI * 2);
          ctx.arc(x + 3 + i * 12, y + 8, 1.8, 0, Math.PI * 2);
          ctx.fill();
        }
        ctx.globalAlpha = 1;
        return true;
      }
      case 'campfire': {
        ctx.fillStyle = 'rgba(0,0,0,0.3)';
        ctx.beginPath();
        ctx.arc(cx, cy, 16, 0, Math.PI * 2);
        ctx.fill();
        // 石の輪
        for (let i = 0; i < 8; i++) {
          const a = (i / 8) * Math.PI * 2;
          ctx.fillStyle = i % 2 ? '#7d7a74' : '#8f8b84';
          ctx.beginPath();
          ctx.arc(cx + Math.cos(a) * 14, cy + Math.sin(a) * 14, 4, 0, Math.PI * 2);
          ctx.fill();
        }
        ctx.strokeStyle = '#5a3a20';
        ctx.lineWidth = 4;
        ctx.beginPath();
        ctx.moveTo(cx - 9, cy - 6);
        ctx.lineTo(cx + 9, cy + 6);
        ctx.moveTo(cx + 9, cy - 6);
        ctx.lineTo(cx - 9, cy + 6);
        ctx.stroke();
        // 炎
        ctx.save();
        ctx.globalCompositeOperation = 'lighter';
        for (let i = 0; i < 3; i++) {
          const f = Math.sin(t * 13 + i * 2.1) * 2;
          ctx.fillStyle = ['rgba(255,90,20,0.9)', 'rgba(255,170,40,0.85)', 'rgba(255,240,170,0.9)'][i];
          const s = 10 - i * 3;
          ctx.beginPath();
          ctx.moveTo(cx - s, cy + 2);
          ctx.quadraticCurveTo(cx + f, cy - s * 2.2, cx + s, cy + 2);
          ctx.closePath();
          ctx.fill();
        }
        ctx.restore();
        return true;
      }
      case 'crate': {
        ctx.fillStyle = 'rgba(0,0,0,0.3)';
        ctx.fillRect(x + 8, y + 10, 28, 26);
        ctx.fillStyle = o.ready ? '#9a6a35' : '#5e4630';
        ctx.fillRect(x + 6, y + 6, 28, 28);
        ctx.strokeStyle = o.ready ? '#6e4a22' : '#3f2f20';
        ctx.lineWidth = 3;
        ctx.strokeRect(x + 7.5, y + 7.5, 25, 25);
        ctx.beginPath();
        ctx.moveTo(x + 8, y + 8);
        ctx.lineTo(x + 32, y + 32);
        ctx.stroke();
        if (o.ready) {
          const pulse = 0.5 + Math.sin(t * 4 + o.id) * 0.3;
          ctx.fillStyle = `rgba(255,220,120,${pulse})`;
          ctx.beginPath();
          ctx.arc(x + 32, y + 8, 3.5, 0, Math.PI * 2);
          ctx.fill();
        } else {
          ctx.fillStyle = 'rgba(0,0,0,0.35)';
          ctx.fillRect(x + 10, y + 10, 20, 20);
        }
        return true;
      }
      case 'box': {
        ctx.fillStyle = 'rgba(0,0,0,0.3)';
        ctx.fillRect(x + 6, y + 12, 32, 24);
        ctx.fillStyle = o.ready ? '#4c6a85' : '#3a4654';
        roundRect(ctx, x + 4, y + 8, 32, 24, 3);
        ctx.fill();
        ctx.fillStyle = o.ready ? '#5f84a6' : '#46525f';
        ctx.fillRect(x + 4, y + 8, 32, 8);
        ctx.fillStyle = '#c8b06a';
        ctx.fillRect(x + 17, y + 14, 6, 5);
        if (o.ready) {
          const pulse = 0.4 + Math.sin(t * 3 + o.id) * 0.3;
          ctx.strokeStyle = `rgba(160,220,255,${pulse})`;
          ctx.lineWidth = 2;
          roundRect(ctx, x + 2, y + 6, 36, 28, 4);
          ctx.stroke();
        }
        return true;
      }
      case 'tree':
        if (o.hp > 0) return false;
        // 切り株
        ctx.fillStyle = '#6b4a2b';
        ctx.beginPath();
        ctx.arc(cx, cy, 8, 0, Math.PI * 2);
        ctx.fill();
        ctx.strokeStyle = '#a77d4f';
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.arc(cx, cy, 5, 0, Math.PI * 2);
        ctx.arc(cx, cy, 2, 0, Math.PI * 2);
        ctx.stroke();
        return true;
      case 'car':
        if (o.hp > 0) return false;
        // 解体後の残骸
        ctx.save();
        ctx.translate(cx, cy);
        ctx.rotate(hash2(o.tx, o.ty) * 0.6 - 0.3);
        ctx.fillStyle = '#3a3530';
        ctx.fillRect(-16, -9, 32, 18);
        ctx.strokeStyle = '#5a524a';
        ctx.lineWidth = 2;
        ctx.strokeRect(-14, -7, 28, 14);
        ctx.restore();
        return true;
      default:
        return false;
    }
  }

  drawTallObject(ctx: CanvasRenderingContext2D, o: ObjSnap, t: number): void {
    const x = o.tx * TILE;
    const y = o.ty * TILE;
    const cx = x + TILE / 2;
    const cy = y + TILE / 2;
    const ratio = o.hp / o.maxHp;
    switch (o.kind) {
      case 'tree': {
        const sway = Math.sin(t * 1.3 + o.id) * 1.5;
        const s = 0.85 + hash2(o.tx, o.ty, 5) * 0.4;
        ctx.fillStyle = 'rgba(0,0,0,0.3)';
        ctx.beginPath();
        ctx.ellipse(cx + 6, cy + 8, 20 * s, 15 * s, 0, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = '#5a3d22';
        ctx.beginPath();
        ctx.arc(cx, cy, 6, 0, Math.PI * 2);
        ctx.fill();
        const greens = ['#24461f', '#2f5a28', '#3b6e31'];
        for (let i = 0; i < 3; i++) {
          ctx.fillStyle = greens[i];
          const rr = (20 - i * 5) * s;
          ctx.beginPath();
          ctx.arc(cx + sway * (i + 1) * 0.5 - i * 2, cy - i * 3, rr, 0, Math.PI * 2);
          ctx.fill();
        }
        if (ratio < 1) {
          ctx.fillStyle = 'rgba(160,110,60,0.6)';
          ctx.fillRect(cx - 3, cy + 2, 6, 4);
        }
        break;
      }
      case 'car': {
        const palette = ['#7a3b2e', '#3e5a72', '#6d6a3a', '#5a5f66', '#7d5b2a'];
        const col = palette[Math.floor(hash2(o.tx, o.ty, 2) * palette.length)];
        ctx.save();
        ctx.translate(cx, cy);
        ctx.rotate((hash2(o.tx, o.ty) - 0.5) * 0.9);
        ctx.fillStyle = 'rgba(0,0,0,0.35)';
        ctx.fillRect(-17, -8, 38, 22);
        ctx.fillStyle = '#1b1b1b';
        ctx.fillRect(-14, -13, 8, 4);
        ctx.fillRect(7, -13, 8, 4);
        ctx.fillRect(-14, 9, 8, 4);
        ctx.fillRect(7, 9, 8, 4);
        ctx.fillStyle = col;
        roundRect(ctx, -19, -11, 38, 22, 5);
        ctx.fill();
        ctx.fillStyle = 'rgba(120,70,40,0.5)'; // 錆
        ctx.beginPath();
        ctx.arc(-8 + hash2(o.tx, o.ty, 3) * 16, -4, 5, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = '#1f2a33';
        roundRect(ctx, -8, -8, 15, 16, 3);
        ctx.fill();
        ctx.fillStyle = 'rgba(160,200,220,0.25)';
        ctx.fillRect(-6, -7, 3, 14);
        if (ratio < 0.6) cracks(ctx, -20, -20, ratio, o.id);
        ctx.restore();
        break;
      }
      case 'stone': {
        ctx.fillStyle = '#6f6c68';
        ctx.fillRect(x, y, TILE, TILE);
        ctx.fillStyle = '#85827c';
        for (let i = 0; i < 4; i++) {
          const bx = x + (i % 2) * 20 + 1;
          const by = y + Math.floor(i / 2) * 20 + 1;
          ctx.fillRect(bx, by, 18, 18);
        }
        ctx.fillStyle = 'rgba(255,255,255,0.08)';
        ctx.fillRect(x, y, TILE, 3);
        cracks(ctx, x, y, ratio, o.id);
        break;
      }
      case 'woodWall': {
        ctx.fillStyle = '#7a5230';
        ctx.fillRect(x + 1, y + 1, TILE - 2, TILE - 2);
        for (let i = 0; i < 4; i++) {
          ctx.fillStyle = i % 2 ? '#a06d3e' : '#946437';
          ctx.fillRect(x + 2, y + 2 + i * 9, TILE - 4, 8);
        }
        ctx.fillStyle = '#d0d0d0';
        for (let i = 0; i < 4; i++) {
          ctx.fillRect(x + 5, y + 5 + i * 9, 2, 2);
          ctx.fillRect(x + TILE - 7, y + 5 + i * 9, 2, 2);
        }
        ctx.strokeStyle = '#4b301a';
        ctx.lineWidth = 2;
        ctx.strokeRect(x + 1, y + 1, TILE - 2, TILE - 2);
        cracks(ctx, x, y, ratio, o.id);
        break;
      }
      case 'ironWall': {
        const g = ctx.createLinearGradient(x, y, x + TILE, y + TILE);
        g.addColorStop(0, '#8d99a8');
        g.addColorStop(1, '#5d6672');
        ctx.fillStyle = g;
        ctx.fillRect(x + 1, y + 1, TILE - 2, TILE - 2);
        ctx.strokeStyle = '#3d444d';
        ctx.lineWidth = 2;
        ctx.strokeRect(x + 2, y + 2, TILE - 4, TILE - 4);
        ctx.beginPath();
        ctx.moveTo(x + 4, y + TILE / 2);
        ctx.lineTo(x + TILE - 4, y + TILE / 2);
        ctx.stroke();
        ctx.fillStyle = '#c8d0da';
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

  drawZombie(ctx: CanvasRenderingContext2D, z: ZombieSnap, anim: ZombieAnim, t: number): void {
    const st = ZOMBIE[z.type];
    const r = st.radius;
    const flash = z.flash > 0;
    ctx.save();
    ctx.translate(z.x, z.y);
    ctx.fillStyle = 'rgba(0,0,0,0.3)';
    ctx.beginPath();
    ctx.ellipse(3, 5, r * 1.05, r * 0.85, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.rotate(z.angle);
    const step = Math.sin(anim.walk) * r * 0.35;
    // 足
    ctx.fillStyle = '#2b2b2b';
    ctx.beginPath();
    ctx.ellipse(step, -r * 0.4, r * 0.35, r * 0.22, 0, 0, Math.PI * 2);
    ctx.ellipse(-step, r * 0.4, r * 0.35, r * 0.22, 0, 0, Math.PI * 2);
    ctx.fill();
    // 腕（前に突き出す＋攻撃時に突進）
    const reach = r * 0.9 + anim.lunge * r * 0.6;
    ctx.strokeStyle = flash ? '#fff' : st.skin;
    ctx.lineWidth = r * 0.32;
    ctx.lineCap = 'round';
    const sway = Math.sin(t * 3 + z.id) * 2;
    ctx.beginPath();
    ctx.moveTo(r * 0.1, -r * 0.6);
    ctx.lineTo(reach, -r * 0.45 + sway);
    ctx.moveTo(r * 0.1, r * 0.6);
    ctx.lineTo(reach - 2, r * 0.45 - sway);
    ctx.stroke();
    // 胴体
    ctx.fillStyle = flash ? '#fff' : st.color;
    ctx.beginPath();
    ctx.ellipse(-r * 0.1, 0, r * 0.62, r * 0.85, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = 'rgba(90,10,10,0.55)'; // 血の染み
    ctx.beginPath();
    ctx.arc(-r * 0.2 + (z.id % 5), r * 0.2, r * 0.22, 0, Math.PI * 2);
    ctx.fill();
    // 頭
    ctx.fillStyle = flash ? '#fff' : st.skin;
    ctx.beginPath();
    ctx.arc(r * 0.15, 0, r * 0.45, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = 'rgba(0,0,0,0.25)';
    ctx.beginPath();
    ctx.arc(r * 0.05, -r * 0.12, r * 0.2, 0, Math.PI * 2);
    ctx.fill();
    // 目
    ctx.fillStyle = z.horde ? '#ff2a2a' : '#e8e070';
    ctx.beginPath();
    ctx.arc(r * 0.45, -r * 0.16, r * 0.09, 0, Math.PI * 2);
    ctx.arc(r * 0.45, r * 0.16, r * 0.09, 0, Math.PI * 2);
    ctx.fill();
    if (z.type === 'brute') {
      ctx.strokeStyle = 'rgba(0,0,0,0.35)';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(-r * 0.1, 0, r * 0.7, -1, 1);
      ctx.stroke();
    }
    ctx.restore();
  }

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
    ctx.fillStyle = 'rgba(0,0,0,0.35)';
    ctx.beginPath();
    ctx.ellipse(3, 5, 16, 13, 0, 0, Math.PI * 2);
    ctx.fill();

    ctx.rotate(down ? p.bodyAngle + Math.PI / 2 : p.aim);
    const body = down ? '#5d6470' : color;
    const step = Math.sin(anim.walk) * 5;
    // 足
    ctx.fillStyle = '#2a2f3a';
    ctx.beginPath();
    ctx.ellipse(step, -6, 6, 4, 0, 0, Math.PI * 2);
    ctx.ellipse(-step, 6, 6, 4, 0, 0, Math.PI * 2);
    ctx.fill();
    // バックパック
    ctx.fillStyle = '#4a3b2a';
    roundRect(ctx, -r - 3, -8, 9, 16, 3);
    ctx.fill();

    // 武器
    if (!down) {
      if (p.tool === Tool.Gun) {
        const rc = anim.recoil;
        ctx.fillStyle = shade(color, -0.2);
        ctx.beginPath();
        ctx.arc(10, 6, 4, 0, Math.PI * 2); // 手
        ctx.fill();
        ctx.fillStyle = '#23262d';
        roundRect(ctx, 8 + rc, 2, 18, 6, 2);
        ctx.fill();
        ctx.fillStyle = '#3a3f48';
        ctx.fillRect(10 + rc, 6, 5, 6);
      } else if (p.tool === Tool.Axe) {
        // 振りかぶり → 振り抜き
        const sw = anim.swing > 0 ? Math.sin((1 - anim.swing) * Math.PI) : 0;
        const ang = -1.1 + (1 - anim.swing) * 2.2 * (anim.swing > 0 ? 1 : 0);
        ctx.save();
        ctx.rotate(anim.swing > 0 ? ang : 0.5);
        ctx.strokeStyle = '#7a5532';
        ctx.lineWidth = 4;
        ctx.lineCap = 'round';
        ctx.beginPath();
        ctx.moveTo(6, 0);
        ctx.lineTo(28 + sw * 4, 0);
        ctx.stroke();
        ctx.fillStyle = '#b8c2cc';
        ctx.beginPath();
        ctx.moveTo(24, -2);
        ctx.lineTo(32, -9);
        ctx.lineTo(34, 1);
        ctx.closePath();
        ctx.fill();
        ctx.restore();
        if (anim.swing > 0.2) {
          ctx.strokeStyle = `rgba(255,255,255,${anim.swing * 0.4})`;
          ctx.lineWidth = 3;
          ctx.beginPath();
          ctx.arc(0, 0, 34, -1.1, -1.1 + (1 - anim.swing) * 2.2);
          ctx.stroke();
        }
      } else {
        // ハンマー（建築・修理）
        ctx.save();
        ctx.rotate(0.4 + Math.sin(t * 6) * 0.05);
        ctx.strokeStyle = '#7a5532';
        ctx.lineWidth = 3.5;
        ctx.beginPath();
        ctx.moveTo(6, 0);
        ctx.lineTo(24, 0);
        ctx.stroke();
        ctx.fillStyle = '#9aa3ad';
        ctx.fillRect(21, -6, 7, 12);
        ctx.restore();
      }
    }
    // 胴体（肩）
    ctx.fillStyle = shade(body.startsWith('#') ? body : '#888888', -0.25);
    ctx.beginPath();
    ctx.ellipse(0, 0, 9, r, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = body;
    ctx.beginPath();
    ctx.ellipse(0, 0, 7, r - 2, 0, 0, Math.PI * 2);
    ctx.fill();
    // 頭
    ctx.fillStyle = down ? '#b9a594' : '#e3c7a8';
    ctx.beginPath();
    ctx.arc(2, 0, 6.5, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#3a2a1e';
    ctx.beginPath();
    ctx.arc(0, 0, 6.5, Math.PI * 0.6, Math.PI * 1.4);
    ctx.fill();

    // マズルフラッシュ
    if (anim.flash > 0 && p.tool === Tool.Gun) {
      const s = 0.7 + anim.flashSeed * 0.6;
      ctx.translate(28 + anim.recoil, 5);
      ctx.globalCompositeOperation = 'lighter';
      ctx.fillStyle = 'rgba(255,220,130,0.95)';
      ctx.beginPath();
      ctx.moveTo(0, -5 * s);
      ctx.lineTo(16 * s, 0);
      ctx.lineTo(0, 5 * s);
      ctx.lineTo(4 * s, 0);
      ctx.closePath();
      ctx.fill();
      ctx.fillStyle = 'rgba(255,255,255,0.95)';
      ctx.beginPath();
      ctx.arc(2, 0, 3.5 * s, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();
  }
}
