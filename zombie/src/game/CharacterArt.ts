// ============================================================
// キャラクターの描き込み（プレイヤー・ゾンビ・亡骸）
//   座標系：キャラクターの中心が原点、+x が向いている方向（上から見下ろし）
//   ・プレイヤー：ブーツと脚（移動方向）／上半身（照準方向）・肩の揺れ・プレートキャリア・
//     バックパック・頭部装備（ヘルメット／キャップ＋ヘッドセット／ニット帽＋ゴーグル）・
//     銃ごとに違うシルエットとアタッチメント・リコイル・ダウン時の倒れ姿勢
//   ・ゾンビ：種類ごとの体格・服装・装備、接近時の腕の振り上げ（予備動作）、被弾ののけぞり
// ============================================================
import type { PlayerSnap, ZombieSnap } from '../types';
import type { PlayerAnim, ZombieAnim } from './Art';
import { ZOMBIE } from './constants';
import type { Corpse } from './Effects';
import { heldWeapon, type WeaponId, type WeaponState } from './items';
import { Tool } from '../types';

// ---------------- 小さなヘルパー ----------------

function h2(x: number, y: number, s = 0): number {
  let h = (x * 374761393 + y * 668265263 + s * 1442695041) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

function shade(hex: string, k: number): string {
  if (!hex.startsWith('#') || hex.length < 7) return hex;
  const n = parseInt(hex.slice(1, 7), 16);
  const f = (c: number) => Math.max(0, Math.min(255, Math.round(k < 0 ? c * (1 + k) : c + (255 - c) * k)));
  return `rgb(${f((n >> 16) & 255)},${f((n >> 8) & 255)},${f(n & 255)})`;
}

function rr(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
  const k = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + k, y);
  ctx.arcTo(x + w, y, x + w, y + h, k);
  ctx.arcTo(x + w, y + h, x, y + h, k);
  ctx.arcTo(x, y + h, x, y, k);
  ctx.arcTo(x, y, x + w, y, k);
  ctx.closePath();
}

/** 輪郭線つきで塗る（上から見たときに形がはっきりする） */
function blob(ctx: CanvasRenderingContext2D, fill: string | CanvasGradient, outline: string, lw = 1.5): void {
  ctx.fillStyle = fill;
  ctx.fill();
  ctx.strokeStyle = outline;
  ctx.lineWidth = lw;
  ctx.stroke();
}

/** 太い線で手足を描く（輪郭＋中身） */
function limb(ctx: CanvasRenderingContext2D, x1: number, y1: number, x2: number, y2: number, w: number, color: string, outline: string): void {
  ctx.lineCap = 'round';
  ctx.strokeStyle = outline;
  ctx.lineWidth = w + 2.2;
  ctx.beginPath();
  ctx.moveTo(x1, y1);
  ctx.lineTo(x2, y2);
  ctx.stroke();
  ctx.strokeStyle = color;
  ctx.lineWidth = w;
  ctx.stroke();
}

function softShadow(ctx: CanvasRenderingContext2D, rx: number, ry: number, a = 0.38): void {
  const g = ctx.createRadialGradient(3, 5, 0, 3, 5, rx);
  g.addColorStop(0, `rgba(0,0,0,${a})`);
  g.addColorStop(0.65, `rgba(0,0,0,${a * 0.6})`);
  g.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.fillStyle = g;
  ctx.beginPath();
  ctx.ellipse(3, 5, rx, ry, 0, 0, Math.PI * 2);
  ctx.fill();
}

const OUT = 'rgba(12,13,10,0.92)';

// ======================================================================
// プレイヤー
// ======================================================================

export function drawPlayer(ctx: CanvasRenderingContext2D, p: PlayerSnap, color: string, anim: PlayerAnim, t: number): void {
  ctx.save();
  ctx.translate(p.x, p.y);
  if (p.status === 'dead') {
    // 戦闘不能：落ちたヘルメットと血だまり
    ctx.globalAlpha = 0.75;
    ctx.fillStyle = 'rgba(70,12,10,0.55)';
    ctx.beginPath();
    ctx.ellipse(0, 2, 16, 11, 0.4, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#4b5238';
    ctx.beginPath();
    ctx.arc(-3, -2, 7, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = color;
    ctx.lineWidth = 2;
    ctx.stroke();
    ctx.restore();
    return;
  }
  if (p.status === 'down') {
    drawDownedPlayer(ctx, p, color, anim, t);
    ctx.restore();
    return;
  }
  softShadow(ctx, 20, 16);
  const mv = Math.min(1, anim.move);

  // ---- 脚（移動方向） ----
  ctx.save();
  ctx.rotate(p.bodyAngle);
  const step = Math.sin(anim.walk) * 7 * mv;
  for (const side of [-1, 1]) {
    const fx = step * side;
    limb(ctx, -1, side * 5, fx * 0.8, side * 6, 6, '#3b3f30', OUT);
    // ブーツ
    ctx.save();
    ctx.translate(fx + 1.5, side * 6);
    rr(ctx, -4, -3, 9, 6, 2.5);
    blob(ctx, '#2a2620', OUT, 1.2);
    ctx.fillStyle = 'rgba(255,255,255,0.08)';
    ctx.fillRect(-2, -2, 5, 1.2);
    ctx.restore();
  }
  ctx.restore();

  // ---- 上半身（照準方向）：歩調で肩が揺れ、撃つと少し後ろへ ----
  ctx.rotate(p.aim + Math.sin(anim.walk) * 0.07 * mv);
  ctx.translate(anim.recoil * 0.18, 0);
  const jacket = color;
  const jDark = shade(color, -0.45);

  // バックパック（背中側 = -x）
  drawBackpack(ctx, p.id);

  // 胴体（肩幅が広い楕円）＋ジャケット
  ctx.beginPath();
  ctx.ellipse(-1, 0, 9.5, 15, 0, 0, Math.PI * 2);
  const tg = ctx.createLinearGradient(-8, -14, 8, 14);
  tg.addColorStop(0, shade(jacket, 0.08));
  tg.addColorStop(1, jDark);
  blob(ctx, tg, OUT, 1.6);
  // 肩パッド（チームカラーの腕章）
  for (const side of [-1, 1]) {
    ctx.beginPath();
    ctx.ellipse(0, side * 11.5, 4.5, 3.6, 0, 0, Math.PI * 2);
    blob(ctx, shade(jacket, -0.15), OUT, 1);
    ctx.fillStyle = color;
    ctx.fillRect(-2.5, side * 11.5 - 1, 4, 2);
  }
  // プレートキャリア（前面のマガジンポーチ）
  rr(ctx, -4, -9, 10, 18, 3);
  blob(ctx, '#3e4433', OUT, 1);
  ctx.fillStyle = '#4c5340';
  for (let i = -1; i <= 1; i++) {
    rr(ctx, 2.2, i * 5.2 - 2, 4, 4, 1);
    ctx.fill();
  }
  ctx.fillStyle = 'rgba(0,0,0,0.3)';
  for (let i = -1; i <= 1; i++) ctx.fillRect(2.2, i * 5.2 + 1.2, 4, 0.8);
  // 肩ストラップ
  ctx.strokeStyle = '#2b2f24';
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(-6, -8);
  ctx.lineTo(-1, -9);
  ctx.moveTo(-6, 8);
  ctx.lineTo(-1, 9);
  ctx.stroke();

  // 武器と腕
  drawHeldItem(ctx, p, anim, jacket, t);

  // 頭部
  drawHead(ctx, p.id, color);
  ctx.restore();
}

function drawBackpack(ctx: CanvasRenderingContext2D, id: number): void {
  const pack = ['#4a4532', '#3f4536', '#4d4338'][id % 3];
  // 本体
  rr(ctx, -21, -10, 14, 20, 4);
  const g = ctx.createLinearGradient(-21, -10, -7, 10);
  g.addColorStop(0, shade(pack, 0.12));
  g.addColorStop(1, shade(pack, -0.25));
  blob(ctx, g, OUT, 1.4);
  // 雨蓋とバックル
  rr(ctx, -12, -8, 5, 16, 2);
  ctx.fillStyle = shade(pack, -0.12);
  ctx.fill();
  ctx.fillStyle = '#1e1f1a';
  ctx.fillRect(-11, -4, 3, 1.5);
  ctx.fillRect(-11, 3, 3, 1.5);
  // サイドポケット
  rr(ctx, -19, -13, 8, 4, 1.5);
  blob(ctx, shade(pack, -0.08), OUT, 1);
  rr(ctx, -19, 9, 8, 4, 1.5);
  blob(ctx, shade(pack, -0.08), OUT, 1);
  // 丸めた寝袋（上端）
  rr(ctx, -25, -9, 5, 18, 2.5);
  blob(ctx, '#55604a', OUT, 1.2);
  ctx.fillStyle = 'rgba(0,0,0,0.35)';
  ctx.fillRect(-25, -4, 5, 1.3);
  ctx.fillRect(-25, 3, 5, 1.3);
  // 無線のアンテナ（1人目）
  if (id % 3 === 0) {
    ctx.strokeStyle = '#1c1c1a';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(-17, -9);
    ctx.lineTo(-27, -18);
    ctx.stroke();
  }
}

function drawHead(ctx: CanvasRenderingContext2D, id: number, color: string): void {
  const kind = id % 3;
  // 顔（少し前に）
  ctx.beginPath();
  ctx.arc(2, 0, 6.8, 0, Math.PI * 2);
  blob(ctx, '#d8b896', OUT, 1.4);
  if (kind === 0) {
    // ヘルメット＋暗視装置マウント
    ctx.beginPath();
    ctx.arc(0.8, 0, 7.8, 0, Math.PI * 2);
    const hg = ctx.createRadialGradient(-1.5, -2.5, 1, 0.8, 0, 8);
    hg.addColorStop(0, '#76805c');
    hg.addColorStop(1, '#3f4630');
    blob(ctx, hg, OUT, 1.5);
    ctx.fillStyle = '#2c3024';
    ctx.fillRect(-1, -8, 3, 16); // サイドレール
    ctx.fillStyle = '#1f2119';
    rr(ctx, 6, -2.5, 3.5, 5, 1);
    ctx.fill();
    ctx.fillStyle = 'rgba(255,255,255,0.12)';
    ctx.beginPath();
    ctx.arc(-1.5, -3, 2.5, 0, Math.PI * 2);
    ctx.fill();
  } else if (kind === 1) {
    // キャップ（つばは前）＋ヘッドセット
    ctx.beginPath();
    ctx.arc(0.5, 0, 7, Math.PI * 0.5, Math.PI * 1.5);
    ctx.lineTo(4, -7);
    ctx.lineTo(4, 7);
    ctx.closePath();
    blob(ctx, '#3a3d33', OUT, 1.3);
    rr(ctx, 4, -5, 6, 10, 2.5);
    blob(ctx, '#2f322a', OUT, 1);
    for (const side of [-1, 1]) {
      ctx.beginPath();
      ctx.ellipse(0, side * 7, 3, 2.2, 0, 0, Math.PI * 2);
      blob(ctx, '#1d1e1a', OUT, 1);
    }
    ctx.strokeStyle = '#1d1e1a';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(0, -7);
    ctx.lineTo(0, 7);
    ctx.stroke();
  } else {
    // ニット帽＋ゴーグル
    ctx.beginPath();
    ctx.arc(0.5, 0, 7.2, Math.PI * 0.42, Math.PI * 1.58);
    ctx.closePath();
    blob(ctx, '#5a4a3a', OUT, 1.3);
    ctx.strokeStyle = 'rgba(255,255,255,0.1)';
    ctx.lineWidth = 1;
    for (let k = -2; k <= 2; k++) {
      ctx.beginPath();
      ctx.moveTo(-4, k * 2.4);
      ctx.lineTo(1, k * 2.4);
      ctx.stroke();
    }
    ctx.strokeStyle = '#1f1f1c';
    ctx.lineWidth = 1.6;
    ctx.beginPath();
    ctx.arc(1.5, 0, 6.6, -1.2, 1.2);
    ctx.stroke();
    rr(ctx, 6, -4.5, 3, 9, 1.4);
    ctx.fillStyle = '#6f8a8c';
    ctx.fill();
  }
  // チームカラーの小さなIRマーカー
  ctx.fillStyle = color;
  ctx.fillRect(-4.5, -1, 2, 2);
}

// ---------------- 武器 ----------------

interface GunSpec {
  /** 床尾（肩）の位置 */
  back: number;
  /** 銃口の位置 */
  muzzle: number;
  /** 右手（グリップ）と左手（ハンドガード）の位置 */
  grip: number;
  fore: number;
  y: number;
}

const GUNS: Record<WeaponId, GunSpec> = {
  pistol: { back: 10, muzzle: 27, grip: 14, fore: 15, y: 0 },
  smg: { back: 1, muzzle: 30, grip: 11, fore: 22, y: 2 },
  rifle: { back: -3, muzzle: 40, grip: 10, fore: 26, y: 2.5 },
  dmr: { back: -4, muzzle: 46, grip: 10, fore: 28, y: 2.5 },
  hunting: { back: -5, muzzle: 45, grip: 9, fore: 27, y: 2.5 },
  shotgun: { back: -4, muzzle: 38, grip: 9, fore: 24, y: 2.5 },
};

function drawHeldItem(ctx: CanvasRenderingContext2D, p: PlayerSnap, anim: PlayerAnim, jacket: string, t: number): void {
  const sleeve = shade(jacket, -0.42);
  const glove = '#2b2a24';
  const held = heldWeapon(p);
  if (held) {
    const g = GUNS[held.id];
    const rc = anim.recoil;
    const y = g.y;
    // 腕：右手はグリップ、左手はハンドガード（ハンドガンは両手で前に突き出す）
    // 肘を少し外へ張る（上腕→前腕の2本で描く）
    const ex1 = (g.grip + rc) * 0.45;
    const ex2 = (g.fore + rc) * 0.5;
    limb(ctx, 0, 10, ex1, 10.5, 4, sleeve, OUT);
    limb(ctx, ex1, 10.5, g.grip + rc - 1, y + 4, 3.6, sleeve, OUT);
    limb(ctx, 0, -10, ex2, -9, 4, sleeve, OUT);
    limb(ctx, ex2, -9, g.fore + rc - 1, y - 2.2, 3.6, sleeve, OUT);
    drawGun(ctx, held.id, held.w, rc, anim, t);
    for (const [hx, hy] of [
      [g.grip + rc, y + 3.5],
      [g.fore + rc, y - 2],
    ]) {
      ctx.beginPath();
      ctx.arc(hx, hy, 2.9, 0, Math.PI * 2);
      blob(ctx, glove, OUT, 1);
    }
    return;
  }
  if (p.tool === Tool.Melee) {
    // 斧：振りかぶり → 振り抜き
    const prog = anim.swing > 0 ? 1 - anim.swing : -1;
    const ang = prog >= 0 ? -1.3 + prog * 2.6 : 0.55 + Math.sin(t * 2) * 0.03;
    ctx.save();
    ctx.rotate(ang);
    limb(ctx, -2, 9, 13, 4, 4.6, sleeve, OUT);
    // 柄
    ctx.lineCap = 'round';
    ctx.strokeStyle = OUT;
    ctx.lineWidth = 5;
    ctx.beginPath();
    ctx.moveTo(8, 4);
    ctx.lineTo(34, 4);
    ctx.stroke();
    const hg = ctx.createLinearGradient(0, 2, 0, 6);
    hg.addColorStop(0, '#a27448');
    hg.addColorStop(1, '#6a4728');
    ctx.strokeStyle = hg;
    ctx.lineWidth = 3;
    ctx.stroke();
    // 刃
    ctx.beginPath();
    ctx.moveTo(27, 1.5);
    ctx.lineTo(36, -8);
    ctx.quadraticCurveTo(41, -2, 39, 4);
    ctx.lineTo(31, 6.5);
    ctx.closePath();
    const bg = ctx.createLinearGradient(27, -8, 40, 6);
    bg.addColorStop(0, '#d9dfe4');
    bg.addColorStop(1, '#7d868f');
    blob(ctx, bg, OUT, 1.2);
    ctx.strokeStyle = 'rgba(255,255,255,0.6)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(36.5, -7);
    ctx.quadraticCurveTo(40.5, -1.5, 38.5, 3.5);
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(13, 4, 2.9, 0, Math.PI * 2);
    blob(ctx, glove, OUT, 1);
    ctx.restore();
    limb(ctx, 0, -10, 9, -6, 4.6, sleeve, OUT);
    if (prog >= 0 && prog < 0.85) {
      ctx.strokeStyle = `rgba(255,250,235,${(1 - prog) * 0.5})`;
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.arc(0, 0, 38, -1.3, -1.3 + prog * 2.6);
      ctx.stroke();
    }
    return;
  }
  // 回復・食料・素手：両手で持つ
  limb(ctx, 0, 10, 13, 4, 4.6, sleeve, OUT);
  limb(ctx, 0, -10, 13, -4, 4.6, sleeve, OUT);
  if (p.tool === Tool.Meds) {
    rr(ctx, 11, -6, 10, 12, 2);
    blob(ctx, '#d8d4c8', OUT, 1);
    ctx.fillStyle = '#b03a2e';
    ctx.fillRect(15, -4, 2, 8);
    ctx.fillRect(12, -1, 8, 2);
  } else if (p.tool === Tool.Food) {
    rr(ctx, 12, -4.5, 8, 9, 1.5);
    blob(ctx, '#9da3a8', OUT, 1);
    ctx.fillStyle = '#a5552f';
    ctx.fillRect(12, -2, 8, 4);
  }
  for (const s of [-1, 1]) {
    ctx.beginPath();
    ctx.arc(13, s * 4, 2.9, 0, Math.PI * 2);
    blob(ctx, glove, OUT, 1);
  }
}

/** 銃のシルエット（種類ごとに違う形）とアタッチメント・発砲炎 */
function drawGun(ctx: CanvasRenderingContext2D, id: WeaponId, w: WeaponState, rc: number, anim: PlayerAnim, t: number): void {
  const g = GUNS[id];
  ctx.save();
  ctx.translate(rc, g.y);
  const metal = '#2a2d31';
  const metal2 = '#3c4046';
  const poly = '#26282a';
  const wood = '#7a5130';
  const woodL = '#9a6a40';
  let muzzle = g.muzzle;
  const body = (x: number, y: number, w2: number, h: number, c: string | CanvasGradient, r = 1.5) => {
    rr(ctx, x, y, w2, h, r);
    blob(ctx, c, OUT, 1.1);
  };
  const lg = (y0: number, y1: number, a: string, b: string) => {
    const gr = ctx.createLinearGradient(0, y0, 0, y1);
    gr.addColorStop(0, a);
    gr.addColorStop(1, b);
    return gr;
  };
  switch (id) {
    case 'pistol':
      body(10, -2.6, 17, 5.2, lg(-2.6, 2.6, metal2, metal));
      ctx.fillStyle = 'rgba(255,255,255,0.18)';
      ctx.fillRect(13, -2, 12, 1);
      ctx.fillStyle = '#16181a';
      for (let k = 0; k < 4; k++) ctx.fillRect(12 + k * 1.6, -2.2, 0.7, 4.4); // スライドのセレーション
      break;
    case 'smg':
      ctx.strokeStyle = '#1b1c1e';
      ctx.lineWidth = 1.6;
      ctx.strokeRect(1.5, -2, 8, 4); // 折りたたみストック
      body(8, -3, 15, 6, lg(-3, 3, metal2, metal));
      body(22, -2, 6, 4, poly, 1);
      body(27, -1, 3, 2, metal, 0.5);
      body(14, 2.5, 4, w.extmag ? 11 : 7, '#1c1d1f', 0.8); // マガジン
      break;
    case 'rifle':
      body(-3, -2.6, 10, 5.2, lg(-2.6, 2.6, '#33363a', poly), 2); // ストック
      body(6, -3, 14, 6, lg(-3, 3, metal2, metal));
      body(19, -2.8, 15, 5.6, lg(-2.8, 2.8, '#3a3d34', '#2a2c25'), 1.2); // ハンドガード
      ctx.fillStyle = 'rgba(0,0,0,0.35)';
      for (let k = 0; k < 6; k++) ctx.fillRect(21 + k * 2.2, -2.6, 0.9, 5.2); // レール
      body(33, -1, 7, 2, metal, 0.6);
      ctx.save();
      ctx.translate(14, 2.5);
      ctx.rotate(0.18);
      body(-2, 0, 4.5, w.extmag ? 12 : 8, '#1c1d1f', 1); // 湾曲マガジン
      ctx.restore();
      break;
    case 'dmr':
      body(-4, -2.8, 11, 5.6, lg(-2.8, 2.8, '#34372f', '#22241f'), 2.2);
      body(6, -3.2, 15, 6.4, lg(-3.2, 3.2, '#3f4338', '#2a2d27'));
      body(20, -2.8, 17, 5.6, lg(-2.8, 2.8, '#3a3e33', '#272a23'), 1.2);
      body(36, -1.1, 10, 2.2, metal, 0.6);
      body(13, 2.8, 4.5, w.extmag ? 11 : 7, '#1c1d1f', 1);
      // 折りたたんだ二脚
      ctx.strokeStyle = '#1a1b1d';
      ctx.lineWidth = 1.2;
      ctx.beginPath();
      ctx.moveTo(30, -2.5);
      ctx.lineTo(24, -3.5);
      ctx.moveTo(30, 2.5);
      ctx.lineTo(24, 3.5);
      ctx.stroke();
      break;
    case 'hunting':
      body(-5, -3, 24, 6, lg(-3, 3, woodL, wood), 2.5); // 木製ストック
      ctx.strokeStyle = 'rgba(40,24,12,0.45)';
      ctx.lineWidth = 0.7;
      ctx.beginPath();
      ctx.moveTo(-3, -1);
      ctx.quadraticCurveTo(6, 0.5, 16, -1.2);
      ctx.moveTo(-2, 1.4);
      ctx.quadraticCurveTo(7, 2.4, 15, 1);
      ctx.stroke();
      body(14, -2.2, 10, 4.4, metal2, 1);
      body(23, -1.1, 22, 2.2, metal, 0.6);
      ctx.beginPath();
      ctx.arc(17, 4, 1.8, 0, Math.PI * 2); // ボルトハンドル
      blob(ctx, '#8a8e94', OUT, 0.8);
      break;
    case 'shotgun':
      body(-4, -3, 14, 6, lg(-3, 3, woodL, wood), 2.5);
      body(9, -3, 11, 6, lg(-3, 3, metal2, metal));
      body(19, -1.6, 19, 3.2, metal, 0.8); // 銃身
      body(19, 1.4, 15, 2.2, '#24262a', 0.6); // チューブマガジン
      body(21, -3.3, 9, 7, lg(-3.3, 3.7, woodL, wood), 2); // ポンプ
      ctx.fillStyle = 'rgba(30,18,8,0.5)';
      for (let k = 0; k < 4; k++) ctx.fillRect(22.5 + k * 2, -3, 0.8, 6.4);
      break;
  }
  // ---- アタッチメント ----
  if (w.grip && id !== 'pistol') body(g.fore - 4, 2.6, 3.5, 5.5, '#1e1f1d', 1);
  if (w.holo) {
    body(id === 'pistol' ? 15 : 10, -3.8, 6.5, 5.2, '#1e2022', 1);
    ctx.fillStyle = 'rgba(120,200,220,0.55)';
    ctx.fillRect(id === 'pistol' ? 16 : 11, -2.6, 4.5, 2.8);
    ctx.fillStyle = '#ff5a3c';
    ctx.fillRect(id === 'pistol' ? 18 : 13, -1.7, 1.2, 1.2);
  }
  if (w.scope) {
    const sx = id === 'pistol' ? 12 : 7;
    const sl = id === 'pistol' ? 12 : 17;
    body(sx, -3, sl, 6, lg(-3, 3, '#3a3e43', '#18191b'), 2.5);
    body(sx - 1.5, -3.6, 3.5, 7.2, '#141516', 1.2);
    body(sx + sl - 2, -3.6, 3.5, 7.2, '#141516', 1.2);
    ctx.fillStyle = 'rgba(140,190,230,0.75)';
    ctx.fillRect(sx + sl, -2.2, 1.2, 4.4);
    ctx.fillStyle = 'rgba(255,255,255,0.18)';
    ctx.fillRect(sx + 2, -2.4, sl - 4, 1);
  }
  if (w.suppressor) {
    body(muzzle - 1, -2.4, 13, 4.8, lg(-2.4, 2.4, '#44484d', '#1b1c1e'), 2.2);
    ctx.fillStyle = 'rgba(0,0,0,0.35)';
    ctx.fillRect(muzzle + 3, -2.3, 0.8, 4.6);
    ctx.fillRect(muzzle + 7, -2.3, 0.8, 4.6);
    muzzle += 12;
  }
  if (w.ap) {
    // 特殊弾を装填している印（マガジンの色帯）
    ctx.fillStyle = '#e08a4a';
    ctx.fillRect(g.grip + 2, 3, 3, 1.2);
  }
  // ---- 発砲炎 ----
  if (anim.flash > 0) {
    const sup = !!w.suppressor;
    const s = (0.75 + anim.flashSeed * 0.55) * (id === 'shotgun' && !w.ap ? 1.6 : 1) * (sup ? 0.35 : 1);
    ctx.save();
    ctx.translate(muzzle, 0);
    ctx.globalCompositeOperation = 'lighter';
    const fg = ctx.createRadialGradient(4 * s, 0, 0, 4 * s, 0, 16 * s);
    fg.addColorStop(0, 'rgba(255,240,200,0.95)');
    fg.addColorStop(0.35, 'rgba(255,180,80,0.75)');
    fg.addColorStop(1, 'rgba(255,120,40,0)');
    ctx.fillStyle = fg;
    ctx.beginPath();
    ctx.moveTo(0, -5 * s);
    ctx.lineTo(20 * s, -1.2 * s);
    ctx.lineTo(24 * s, 0);
    ctx.lineTo(20 * s, 1.2 * s);
    ctx.lineTo(0, 5 * s);
    ctx.lineTo(5 * s, 0);
    ctx.closePath();
    ctx.fill();
    // 横に散る炎（スター型）
    ctx.fillStyle = 'rgba(255,200,120,0.7)';
    for (const sgn of [-1, 1]) {
      ctx.beginPath();
      ctx.moveTo(2, 0);
      ctx.lineTo(7 * s, sgn * 9 * s);
      ctx.lineTo(5 * s, 0);
      ctx.fill();
    }
    ctx.fillStyle = 'rgba(255,255,255,0.95)';
    ctx.beginPath();
    ctx.arc(2, 0, 3.2 * s, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }
  void t;
  ctx.restore();
}

/** ダウン中：仰向けに倒れ、片腕で這う。下に血だまり */
function drawDownedPlayer(ctx: CanvasRenderingContext2D, p: PlayerSnap, color: string, anim: PlayerAnim, t: number): void {
  const pulse = 0.5 + Math.sin(t * 3) * 0.08;
  ctx.fillStyle = `rgba(90,14,10,${pulse})`;
  ctx.beginPath();
  ctx.ellipse(-2, 3, 19, 13, p.bodyAngle, 0, Math.PI * 2);
  ctx.fill();
  ctx.rotate(p.bodyAngle);
  const crawl = Math.sin(anim.walk * 0.8) * 4 * Math.min(1, anim.move);
  const jacket = shade(color, -0.3);
  // 脚（投げ出す）
  limb(ctx, -6, 4, -20, 9 + crawl * 0.4, 5.5, '#363a2c', OUT);
  limb(ctx, -6, -4, -21, -6 - crawl * 0.4, 5.5, '#363a2c', OUT);
  // 胴体（仰向け：バックパックは下敷き）
  ctx.beginPath();
  ctx.ellipse(0, 0, 13, 9, 0, 0, Math.PI * 2);
  blob(ctx, jacket, OUT, 1.5);
  rr(ctx, -4, -6, 10, 12, 3);
  blob(ctx, '#3a3f30', OUT, 1);
  // 腕：片方は這うように前へ、もう片方は傷口を押さえる
  limb(ctx, 4, -7, 18 + crawl, -12, 4.4, shade(color, -0.2), OUT);
  limb(ctx, 4, 7, 2, 2, 4.4, shade(color, -0.2), OUT);
  ctx.beginPath();
  ctx.arc(18 + crawl, -12, 2.8, 0, Math.PI * 2);
  blob(ctx, '#2b2a24', OUT, 1);
  // 頭
  ctx.beginPath();
  ctx.arc(14, 1, 6.5, 0, Math.PI * 2);
  blob(ctx, '#c9a98a', OUT, 1.3);
  ctx.beginPath();
  ctx.arc(15, 1, 6.8, Math.PI * 0.6, Math.PI * 1.4);
  ctx.closePath();
  ctx.fillStyle = '#3f4630';
  ctx.fill();
}

// ======================================================================
// ゾンビ
// ======================================================================

const SHIRTS = ['#5d5a4c', '#4d5560', '#6b5a48', '#55604c', '#6a4d4a', '#4a4a52', '#76705c'];
const PANTS = ['#2f3238', '#3b3a30', '#2c2f28', '#40372e'];

export function drawZombie(ctx: CanvasRenderingContext2D, z: ZombieSnap, anim: ZombieAnim, t: number): void {
  const st = ZOMBIE[z.type];
  const r = st.radius;
  const flash = z.flash > 0;
  const id = z.id;
  const mv = Math.min(1, anim.move);
  const wc = anim.walk;
  const W = (c: string) => (flash ? '#ffffff' : c);
  const skinBase = h2(id, 1) > 0.5 ? st.skin : shade(st.skin, -0.12);
  const skin = W(skinBase);
  const skinD = W(shade(skinBase, -0.3));
  // 予備動作（近いほど腕を上げる）と被弾ののけぞり
  const near = anim.near ?? 0;
  const hit = anim.hit ?? 0;

  ctx.save();
  ctx.translate(z.x, z.y);
  softShadow(ctx, r * 1.35, r * 1.05, (z.type === 'brute' || z.type === 'titan') ? 0.45 : 0.36);
  // 被弾：小刻みに揺れる
  if (hit > 0) ctx.translate((h2(id, Math.floor(t * 40)) - 0.5) * 3 * hit, (h2(id, Math.floor(t * 40), 3) - 0.5) * 3 * hit);
  ctx.rotate(z.angle - hit * 0.25);
  // 這う者：床に伏せて平たい。待ち伏せ中は暗がりに溶けて見えにくい（構えるとぴくっと動く）
  if (z.type === 'crawler') {
    if (z.tele === 3) ctx.translate((h2(id, Math.floor(t * 50)) - 0.5) * 4, (h2(id, Math.floor(t * 50), 2) - 0.5) * 4);
    else if (z.alert !== 2) ctx.globalAlpha *= 0.55;
    ctx.scale(1.5, 0.78);
  }
  ctx.lineJoin = 'round';

  // ---- 脚（引きずる歩き方） ----
  const stride = z.type === 'runner' ? 1.3 : (z.type === 'brute' || z.type === 'titan') ? 0.7 : 1;
  const step = Math.sin(wc * stride) * r * (z.type === 'runner' ? 0.55 : 0.32) * mv;
  const pants = W(z.type === 'soldier' ? '#3d4230' : PANTS[(id >> 2) % PANTS.length]);
  for (const side of [-1, 1]) {
    const fx = step * side - (z.type === 'walker' && side > 0 ? r * 0.15 : 0); // ウォーカーは片足を引きずる
    limb(ctx, -r * 0.15, side * r * 0.3, fx, side * r * 0.4, r * ((z.type === 'brute' || z.type === 'titan') ? 0.42 : 0.34), pants, OUT);
    ctx.beginPath();
    ctx.ellipse(fx + r * 0.12, side * r * 0.4, r * 0.24, r * 0.17, 0, 0, Math.PI * 2);
    ctx.fillStyle = W(z.type === 'soldier' ? '#26241f' : '#1f1d1a');
    ctx.fill();
  }

  // 上半身は前かがみ（ランナーは強く前傾）
  const lean = z.type === 'runner' ? r * 0.22 : z.type === 'walker' ? r * 0.1 : 0;
  ctx.translate(lean - hit * r * 0.25, 0);

  // ---- 腕 ----
  const lunge = anim.lunge;
  const raise = Math.max(near, lunge); // 0=だらり 1=前に突き出す
  const swing = (side: number) => Math.sin(wc * stride + (side > 0 ? Math.PI : 0)) * mv;
  const arm = (side: number, wid: number, len: number, dangle: number) => {
    const sx = 0;
    const sy = side * r * ((z.type === 'brute' || z.type === 'titan') ? 0.75 : 0.62);
    // だらりとした位置と、前に突き出した位置を補間
    const relaxX = r * 0.25 + swing(side) * r * 0.25;
    const relaxY = side * r * (0.85 + dangle);
    const reachX = r * (len + 0.35 * lunge) + Math.sin(t * 9 + side) * near * 1.5;
    const reachY = side * r * 0.42;
    const hx = relaxX + (reachX - relaxX) * raise;
    const hy = relaxY + (reachY - relaxY) * raise;
    limb(ctx, sx, sy, hx, hy, r * wid, skin, OUT);
    return [hx, hy];
  };

  if ((z.type === 'brute' || z.type === 'titan')) {
    // ---- ブルート：巨体・膨れた上半身・こん棒のような拳・小さな頭 ----
    const hands = [-1, 1].map((s) => arm(s, 0.55, 1.05, 0.15));
    for (const [hx, hy] of hands) {
      ctx.beginPath();
      ctx.arc(hx + 1, hy, r * 0.34, 0, Math.PI * 2);
      blob(ctx, skinD, OUT, 1.5);
    }
    ctx.beginPath();
    ctx.ellipse(-r * 0.05, 0, r * 0.7, r * 0.98, 0, 0, Math.PI * 2);
    const bg = ctx.createRadialGradient(r * 0.1, -r * 0.3, 2, 0, 0, r);
    bg.addColorStop(0, W('#8a7466'));
    bg.addColorStop(1, W('#4a3a34'));
    blob(ctx, bg, OUT, 2);
    // 破れた作業着の帯と膿疱
    ctx.fillStyle = W('#3a4430');
    ctx.beginPath();
    ctx.ellipse(-r * 0.25, 0, r * 0.35, r * 0.9, 0, 0, Math.PI * 2);
    ctx.fill();
    if (!flash) {
      for (let i = 0; i < 6; i++) {
        const px = (h2(id, i, 5) - 0.3) * r * 0.9;
        const py = (h2(id, i, 6) - 0.5) * r * 1.5;
        ctx.fillStyle = 'rgba(170,150,70,0.85)';
        ctx.beginPath();
        ctx.arc(px, py, 1.5 + h2(id, i, 7) * 2, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.strokeStyle = 'rgba(110,30,40,0.55)';
      ctx.lineWidth = 1.2;
      ctx.beginPath();
      ctx.moveTo(-r * 0.1, -r * 0.6);
      ctx.quadraticCurveTo(r * 0.2, -r * 0.2, r * 0.05, r * 0.3);
      ctx.moveTo(r * 0.1, r * 0.5);
      ctx.lineTo(r * 0.35, r * 0.2);
      ctx.stroke();
    }
    ctx.beginPath();
    ctx.arc(r * 0.45, 0, r * 0.3, 0, Math.PI * 2);
    blob(ctx, skinD, OUT, 1.5);
  } else if (z.type === 'runner') {
    // ---- ランナー：細身・長い腕・タンクトップ・はげ頭 ----
    arm(-1, 0.24, 1.15, -0.1);
    arm(1, 0.24, 1.15, -0.1);
    ctx.beginPath();
    ctx.ellipse(-r * 0.05, 0, r * 0.48, r * 0.7, 0, 0, Math.PI * 2);
    blob(ctx, W(shade(SHIRTS[id % SHIRTS.length], -0.1)), OUT, 1.4);
    // 肋骨が見える
    if (!flash) {
      ctx.strokeStyle = 'rgba(30,20,15,0.45)';
      ctx.lineWidth = 1;
      for (let k = -2; k <= 2; k++) {
        ctx.beginPath();
        ctx.moveTo(-r * 0.05, k * r * 0.17);
        ctx.lineTo(r * 0.3, k * r * 0.2);
        ctx.stroke();
      }
    }
    ctx.beginPath();
    ctx.arc(r * 0.35, 0, r * 0.38, 0, Math.PI * 2);
    blob(ctx, skin, OUT, 1.3);
    ctx.fillStyle = W('rgba(60,30,30,0.5)');
    ctx.beginPath();
    ctx.arc(r * 0.3, 0, r * 0.2, 0, Math.PI * 2);
    ctx.fill();
    // 速いときは残像の筋
    if (mv > 0.6 && !flash) {
      ctx.strokeStyle = 'rgba(200,190,170,0.18)';
      ctx.lineWidth = 1.5;
      for (const s of [-1, 0, 1]) {
        ctx.beginPath();
        ctx.moveTo(-r * 0.8, s * r * 0.4);
        ctx.lineTo(-r * 1.8, s * r * 0.45);
        ctx.stroke();
      }
    }
  } else if (z.type === 'soldier') {
    // ---- 感染兵士：迷彩服・プレートキャリア・ヘルメット ----
    arm(-1, 0.3, 0.95, 0);
    arm(1, 0.3, 0.95, 0);
    ctx.beginPath();
    ctx.ellipse(-r * 0.1, 0, r * 0.62, r * 0.88, 0, 0, Math.PI * 2);
    blob(ctx, W('#4a5038'), OUT, 1.6);
    if (!flash) {
      // 迷彩の斑
      for (let i = 0; i < 6; i++) {
        ctx.fillStyle = i % 2 ? 'rgba(40,44,30,0.6)' : 'rgba(110,100,70,0.45)';
        ctx.beginPath();
        ctx.ellipse((h2(id, i, 8) - 0.6) * r, (h2(id, i, 9) - 0.5) * r * 1.4, r * 0.2, r * 0.13, h2(id, i) * 3, 0, Math.PI * 2);
        ctx.fill();
      }
    }
    rr(ctx, -r * 0.45, -r * 0.6, r * 0.8, r * 1.2, r * 0.18);
    blob(ctx, W('#353a2a'), OUT, 1.2);
    ctx.fillStyle = W('#2a2e21');
    for (let k = -1; k <= 1; k++) ctx.fillRect(r * 0.12, k * r * 0.36 - r * 0.13, r * 0.22, r * 0.26);
    // 無線
    ctx.fillStyle = W('#1c1d1a');
    ctx.fillRect(-r * 0.62, -r * 0.62, r * 0.25, r * 0.18);
    // ヘルメット（ゴーグル付き）
    ctx.beginPath();
    ctx.arc(r * 0.18, 0, r * 0.5, 0, Math.PI * 2);
    const hg = ctx.createRadialGradient(0, -r * 0.2, 1, r * 0.18, 0, r * 0.5);
    hg.addColorStop(0, W('#6a7350'));
    hg.addColorStop(1, W('#3a4029'));
    blob(ctx, hg, OUT, 1.5);
    ctx.fillStyle = W('#1b1c18');
    rr(ctx, r * 0.5, -r * 0.3, r * 0.18, r * 0.6, 1.5);
    ctx.fill();
    ctx.fillStyle = flash ? '#fff' : 'rgba(150,170,160,0.6)';
    ctx.fillRect(r * 0.55, -r * 0.24, r * 0.1, r * 0.48);
  } else if (z.type === 'bloater') {
    // ---- 膨張体：ぱんぱんに膨れた緑がかった胴・破れそうな皮膚・漂うガス ----
    arm(-1, 0.32, 0.8, 0.1);
    arm(1, 0.32, 0.8, 0.1);
    const pulse = 1 + Math.sin(t * 3 + id) * 0.04;
    ctx.beginPath();
    ctx.ellipse(-r * 0.1, 0, r * 0.95 * pulse, r * 1.0 * pulse, 0, 0, Math.PI * 2);
    const bg = ctx.createRadialGradient(r * 0.15, -r * 0.3, 2, 0, 0, r);
    bg.addColorStop(0, W('#b8b878'));
    bg.addColorStop(0.6, W('#7c8650'));
    bg.addColorStop(1, W('#465032'));
    blob(ctx, bg, OUT, 2);
    if (!flash) {
      // 浮き出た血管と膿疱
      ctx.strokeStyle = 'rgba(70,40,60,0.55)';
      ctx.lineWidth = 1.2;
      ctx.beginPath();
      for (let k = 0; k < 4; k++) {
        const a0 = h2(id, k, 3) * Math.PI * 2;
        ctx.moveTo(Math.cos(a0) * r * 0.2, Math.sin(a0) * r * 0.2);
        ctx.quadraticCurveTo(Math.cos(a0 + 0.5) * r * 0.6, Math.sin(a0 + 0.5) * r * 0.6, Math.cos(a0 + 0.2) * r * 0.85, Math.sin(a0 + 0.2) * r * 0.85);
      }
      ctx.stroke();
      for (let i = 0; i < 7; i++) {
        ctx.fillStyle = 'rgba(200,200,90,0.85)';
        ctx.beginPath();
        ctx.arc((h2(id, i, 5) - 0.5) * r * 1.3, (h2(id, i, 6) - 0.5) * r * 1.5, 1.5 + h2(id, i, 7) * 2.5, 0, Math.PI * 2);
        ctx.fill();
      }
      // 体から漏れる毒ガス
      for (let i = 0; i < 3; i++) {
        const ph = (t * 0.6 + i / 3 + h2(id, i)) % 1;
        ctx.fillStyle = `rgba(160,190,80,${0.22 * (1 - ph)})`;
        ctx.beginPath();
        ctx.arc(-r * 0.4 - ph * r, (i - 1) * r * 0.5, r * (0.3 + ph * 0.5), 0, Math.PI * 2);
        ctx.fill();
      }
    }
    ctx.beginPath();
    ctx.arc(r * 0.62, 0, r * 0.3, 0, Math.PI * 2);
    blob(ctx, skinD, OUT, 1.3);
  } else if (z.type === 'spitter') {
    // ---- 酸を吐く者：痩せた体・膨らんだ緑の喉袋（構えると光る） ----
    arm(-1, 0.24, 0.9, 0.1);
    arm(1, 0.24, 0.9, 0.1);
    ctx.beginPath();
    ctx.ellipse(-r * 0.1, 0, r * 0.5, r * 0.7, 0, 0, Math.PI * 2);
    blob(ctx, W('#4a5838'), OUT, 1.3);
    const sw = 1 + (z.tele === 4 ? 0.35 + Math.sin(t * 20) * 0.1 : Math.sin(t * 2 + id) * 0.05);
    ctx.beginPath();
    ctx.arc(r * 0.35, 0, r * 0.42 * sw, 0, Math.PI * 2);
    blob(ctx, flash ? '#fff' : z.tele === 4 ? '#c8f070' : '#9ab860', OUT, 1.2);
    ctx.beginPath();
    ctx.arc(r * 0.62, 0, r * 0.3, 0, Math.PI * 2);
    blob(ctx, skin, OUT, 1.3);
  } else if (z.type === 'screamer') {
    // ---- 叫び屋：痩せこけた体・異様に大きく開いた口 ----
    arm(-1, 0.22, 1.0, -0.2);
    arm(1, 0.22, 1.0, -0.2);
    ctx.beginPath();
    ctx.ellipse(-r * 0.1, 0, r * 0.45, r * 0.68, 0, 0, Math.PI * 2);
    blob(ctx, W('#6e6a62'), OUT, 1.3);
    if (!flash) {
      ctx.strokeStyle = 'rgba(30,20,15,0.5)';
      ctx.lineWidth = 1;
      for (let k = -2; k <= 2; k++) {
        ctx.beginPath();
        ctx.moveTo(-r * 0.1, k * r * 0.18);
        ctx.lineTo(r * 0.2, k * r * 0.2);
        ctx.stroke();
      }
    }
    ctx.beginPath();
    ctx.arc(r * 0.38, 0, r * 0.42, 0, Math.PI * 2);
    blob(ctx, skin, OUT, 1.3);
    // 長い髪
    ctx.fillStyle = W('#2a2622');
    ctx.beginPath();
    ctx.arc(r * 0.25, 0, r * 0.44, Math.PI * 0.55, Math.PI * 1.45);
    ctx.fill();
    // 叫ぶ口（追跡中は大きく開く）
    ctx.fillStyle = W('#1a0c0c');
    ctx.beginPath();
    ctx.ellipse(r * 0.62, 0, r * (z.alert === 2 ? 0.2 : 0.1), r * (z.alert === 2 ? 0.26 : 0.12), 0, 0, Math.PI * 2);
    ctx.fill();
    if (z.alert === 2 && !flash) {
      ctx.strokeStyle = `rgba(230,200,170,${0.3 + Math.sin(t * 20) * 0.15})`;
      ctx.lineWidth = 1.5;
      for (let k = 1; k <= 2; k++) {
        ctx.beginPath();
        ctx.arc(r * 0.7, 0, r * 0.4 * k + ((t * 30) % 6), -0.7, 0.7);
        ctx.stroke();
      }
    }
  } else {
    // ---- ウォーカー：猫背・ぼろぼろの服・片腕を突き出す ----
    arm(-1, 0.3, 1.05, 0.05);
    arm(1, 0.3, 0.75 + h2(id, 3) * 0.3, 0.1);
    ctx.beginPath();
    ctx.ellipse(-r * 0.12, 0, r * 0.62, r * 0.84, 0, 0, Math.PI * 2);
    const shirt = SHIRTS[id % SHIRTS.length];
    const sg = ctx.createLinearGradient(-r, -r, r, r);
    sg.addColorStop(0, W(shade(shirt, 0.08)));
    sg.addColorStop(1, W(shade(shirt, -0.3)));
    blob(ctx, sg, OUT, 1.6);
    if (!flash) {
      // 破れ目（肌が見える）・血のしみ
      ctx.fillStyle = skinBase;
      ctx.beginPath();
      ctx.moveTo(-r * 0.2, r * 0.2);
      ctx.lineTo(r * 0.15, r * 0.55);
      ctx.lineTo(-r * 0.35, r * 0.6);
      ctx.closePath();
      ctx.fill();
      ctx.fillStyle = 'rgba(95,16,14,0.6)';
      ctx.beginPath();
      ctx.ellipse(-r * 0.15 + (id % 5) - 2, -r * 0.25, r * 0.24, r * 0.16, 0.6, 0, Math.PI * 2);
      ctx.fill();
      // ネクタイ（会社員だった個体）
      if (h2(id, 11) > 0.7) {
        ctx.fillStyle = '#5a2626';
        ctx.fillRect(r * 0.1, -r * 0.08, r * 0.38, r * 0.16);
      }
    }
    const hy = Math.sin(id) * r * 0.14;
    ctx.beginPath();
    ctx.arc(r * 0.2, hy, r * 0.44, 0, Math.PI * 2);
    blob(ctx, skin, OUT, 1.4);
    ctx.fillStyle = W(h2(id, 7) > 0.5 ? '#3a3026' : '#5a4a36');
    ctx.beginPath();
    ctx.arc(r * 0.12, hy, r * 0.38, Math.PI * 0.6, Math.PI * 1.4);
    ctx.fill();
  }

  // ---- 目（追跡中は赤く光る）と口 ----
  const ex = (z.type === 'brute' || z.type === 'titan') ? r * 0.62 : z.type === 'runner' ? r * 0.62 : r * 0.5;
  const ey = (z.type === 'brute' || z.type === 'titan') ? r * 0.12 : r * 0.16;
  if (z.type !== 'soldier') {
    ctx.fillStyle = z.alert === 2 ? '#f07050' : z.alert === 1 ? '#e8d070' : '#bdb68a';
    ctx.beginPath();
    ctx.arc(ex, -ey, r * 0.07 + 0.6, 0, Math.PI * 2);
    ctx.arc(ex, ey, r * 0.07 + 0.6, 0, Math.PI * 2);
    ctx.fill();
  }
  // ---- 攻撃：ひっかきの軌跡 ----
  if (lunge > 0.3) {
    ctx.strokeStyle = `rgba(255,225,215,${(lunge - 0.3) * 1.1})`;
    ctx.lineWidth = 1.8;
    for (let i = -1; i <= 1; i++) {
      ctx.beginPath();
      ctx.arc(r * 0.3, i * 4, r * 1.55, -0.55, 0.55);
      ctx.stroke();
    }
  }
  ctx.restore();
}

/** 倒したゾンビの亡骸（種類ごとの服装を残す） */
export function drawCorpse(ctx: CanvasRenderingContext2D, c: Corpse): void {
  const st = ZOMBIE[c.type];
  const r = st.radius;
  const a = Math.min(1, c.life / 3);
  const skin = shade(st.skin, -0.3);
  const cloth = (c.type === 'brute' || c.type === 'titan') ? '#4a3a34' : c.type === 'soldier' ? '#3f4430' : c.type === 'bloater' ? '#5a6440' : c.type === 'screamer' ? '#55524c' : shade(SHIRTS[c.id % SHIRTS.length], -0.3);
  ctx.save();
  ctx.globalAlpha = a * 0.92;
  ctx.translate(c.x, c.y);
  ctx.rotate(c.angle);
  // 血だまり
  ctx.fillStyle = 'rgba(70,10,8,0.5)';
  ctx.beginPath();
  ctx.ellipse(r * 0.1, r * 0.1, r * 1.25, r * 0.95, 0.3, 0, Math.PI * 2);
  ctx.fill();
  // 投げ出された手足
  limb(ctx, 0, -r * 0.5, r * 0.75, -r * 1.15, r * 0.28, skin, 'rgba(10,10,8,0.7)');
  limb(ctx, 0, r * 0.5, -r * 0.15, r * 1.25, r * 0.28, skin, 'rgba(10,10,8,0.7)');
  const pants = c.type === 'soldier' ? '#30352a' : PANTS[(c.id >> 2) % PANTS.length];
  limb(ctx, -r * 0.4, -r * 0.2, -r * 1.35, -r * 0.55, r * 0.34, pants, 'rgba(10,10,8,0.7)');
  limb(ctx, -r * 0.4, r * 0.2, -r * 1.25, r * 0.65, r * 0.34, pants, 'rgba(10,10,8,0.7)');
  ctx.beginPath();
  ctx.ellipse(-r * 0.1, 0, r * 0.75, r * 0.86, 0, 0, Math.PI * 2);
  blob(ctx, cloth, 'rgba(10,10,8,0.7)', 1.2);
  ctx.beginPath();
  ctx.arc(r * 0.68, 0, r * 0.4, 0, Math.PI * 2);
  blob(ctx, c.type === 'soldier' ? '#3a4029' : skin, 'rgba(10,10,8,0.7)', 1.2);
  ctx.restore();
}
