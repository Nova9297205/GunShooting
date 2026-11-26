// ============================================================
// タイトル・ロビーの背景演出
//   実際のゲームと同じ生成器で作った荒廃フィールドをゆっくり流し、
//   座標グリッド・レーダースキャン・感染体の反応（赤い点）を重ねる
// ============================================================
import { MAP_H, MAP_W, TILE, WORLD_H, WORLD_W } from '../game/constants';
import { bakeTerrain } from '../game/TerrainArt';
import { generateWorld, TileWorld } from '../game/world';

interface Blip {
  x: number;
  y: number;
  seen: number;
}

export class TitleBackdrop {
  private ctx: CanvasRenderingContext2D;
  private terrain: HTMLCanvasElement | null = null;
  private raf = 0;
  private running = false;
  private t0 = performance.now();
  private blips: Blip[] = [];
  private path: { x: number; y: number }[] = [];
  private noise: CanvasPattern | null = null;

  constructor(private canvas: HTMLCanvasElement) {
    this.ctx = canvas.getContext('2d')!;
    window.addEventListener('resize', () => this.resize());
    this.resize();
  }

  /** 地形の生成は重いので、最初に表示するときに1回だけ行う */
  private build(): void {
    const gen = generateWorld((Math.random() * 1e9) | 0);
    const world = new TileWorld(gen.terrain);
    for (const o of gen.objs) world.setObj(o);
    this.terrain = bakeTerrain(world).canvas;
    // カメラの巡回ルート（ロケーションを順に見て回る）
    this.path = gen.locations.map((l) => ({ x: (l.x + l.w / 2) * TILE, y: (l.y + l.h / 2) * TILE }));
    for (let i = 0; i < 46; i++) this.blips.push({ x: Math.random() * WORLD_W, y: Math.random() * WORLD_H, seen: -9 });
    const n = document.createElement('canvas');
    n.width = n.height = 128;
    const nc = n.getContext('2d')!;
    const img = nc.createImageData(128, 128);
    for (let i = 0; i < img.data.length; i += 4) {
      const v = Math.random() * 255;
      img.data[i] = img.data[i + 1] = img.data[i + 2] = v;
      img.data[i + 3] = 14;
    }
    nc.putImageData(img, 0, 0);
    this.noise = this.ctx.createPattern(n, 'repeat');
  }

  private resize(): void {
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    this.canvas.width = Math.floor(window.innerWidth * dpr);
    this.canvas.height = Math.floor(window.innerHeight * dpr);
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  show(on: boolean): void {
    this.canvas.classList.toggle('hidden', !on);
    if (on && !this.running) {
      if (!this.terrain) this.build();
      this.running = true;
      this.raf = requestAnimationFrame(this.frame);
    } else if (!on) {
      this.running = false;
      cancelAnimationFrame(this.raf);
    }
  }

  private camAt(t: number): { x: number; y: number } {
    const pts = this.path.length >= 2 ? this.path : [{ x: WORLD_W / 2, y: WORLD_H / 2 }, { x: WORLD_W / 3, y: WORLD_H / 3 }];
    const seg = 14; // 1地点あたりの秒数
    const k = t / seg;
    const i = ((Math.floor(k) % pts.length) + pts.length) % pts.length;
    const a = pts[i];
    const b = pts[(i + 1) % pts.length];
    const f = k - Math.floor(k);
    const e = f * f * (3 - 2 * f);
    return { x: a.x + (b.x - a.x) * e, y: a.y + (b.y - a.y) * e };
  }

  private frame = (now: number): void => {
    if (!this.running) return;
    this.raf = requestAnimationFrame(this.frame);
    const { ctx } = this;
    const w = window.innerWidth;
    const h = window.innerHeight;
    // rAF の時刻は生成時より少し前になることがあるので負にしない
    const t = Math.max(0, now - this.t0) / 1000;
    const zoom = 0.62;
    const cam = this.camAt(t);
    const ox = w / 2 - cam.x * zoom;
    const oy = h / 2 - cam.y * zoom;

    ctx.fillStyle = '#0b0c09';
    ctx.fillRect(0, 0, w, h);
    if (this.terrain) {
      ctx.save();
      ctx.filter = 'saturate(0.55) brightness(0.55) contrast(1.1)';
      ctx.drawImage(this.terrain, ox, oy, WORLD_W * zoom, WORLD_H * zoom);
      ctx.filter = 'none';
      ctx.restore();
    }
    // オリーブの色かぶり
    ctx.fillStyle = 'rgba(40,46,22,0.35)';
    ctx.fillRect(0, 0, w, h);

    // 座標グリッド（10タイルごと）
    const g = 10 * TILE * zoom;
    ctx.strokeStyle = 'rgba(200,190,130,0.08)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let x = ((ox % g) + g) % g; x < w; x += g) {
      ctx.moveTo(Math.round(x) + 0.5, 0);
      ctx.lineTo(Math.round(x) + 0.5, h);
    }
    for (let y = ((oy % g) + g) % g; y < h; y += g) {
      ctx.moveTo(0, Math.round(y) + 0.5);
      ctx.lineTo(w, Math.round(y) + 0.5);
    }
    ctx.stroke();
    ctx.font = '10px "Share Tech Mono", monospace';
    ctx.fillStyle = 'rgba(224,163,58,0.35)';
    for (let x = ((ox % g) + g) % g, i = 0; x < w; x += g, i++) {
      const gx = Math.round((x - ox) / zoom / TILE);
      if (gx >= 0 && gx <= MAP_W) ctx.fillText(`E${String(gx).padStart(2, '0')}`, x + 3, 12);
    }
    for (let y = ((oy % g) + g) % g; y < h; y += g) {
      const gy = Math.round((y - oy) / zoom / TILE);
      if (gy >= 0 && gy <= MAP_H) ctx.fillText(`N${String(gy).padStart(2, '0')}`, 3, y - 3);
    }

    // レーダースキャン（画面左寄り）
    const rx = w * 0.3;
    const ry = h * 0.55;
    const R = Math.max(w, h) * 0.55;
    const ang = (t * 0.9) % (Math.PI * 2);
    const sweep = ctx.createConicGradient ? ctx.createConicGradient(ang - 0.6, rx, ry) : null;
    if (sweep) {
      sweep.addColorStop(0, 'rgba(147,183,124,0)');
      sweep.addColorStop(0.09, 'rgba(147,183,124,0.10)');
      sweep.addColorStop(0.0955, 'rgba(147,183,124,0)');
      sweep.addColorStop(1, 'rgba(147,183,124,0)');
      ctx.fillStyle = sweep;
      ctx.beginPath();
      ctx.arc(rx, ry, R, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.strokeStyle = 'rgba(147,183,124,0.10)';
    for (let r = 120; r < R; r += 160) {
      ctx.beginPath();
      ctx.arc(rx, ry, r, 0, Math.PI * 2);
      ctx.stroke();
    }
    // 反応（スキャンが通ると赤く光ってゆっくり消える）
    for (const b of this.blips) {
      const sx = ox + b.x * zoom;
      const sy = oy + b.y * zoom;
      if (sx < -10 || sy < -10 || sx > w + 10 || sy > h + 10) continue;
      const a = Math.atan2(sy - ry, sx - rx);
      const d = ((ang - a) % (Math.PI * 2) + Math.PI * 2) % (Math.PI * 2);
      if (d < 0.05) b.seen = t;
      const life = 1 - (t - b.seen) / 2.6;
      if (life <= 0) continue;
      ctx.fillStyle = `rgba(214,86,60,${0.85 * life})`;
      ctx.beginPath();
      ctx.arc(sx, sy, 3, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = `rgba(214,86,60,${0.4 * life})`;
      ctx.beginPath();
      ctx.arc(sx, sy, 3 + (1 - life) * 14, 0, Math.PI * 2);
      ctx.stroke();
    }

    // 走査線・ノイズ・周辺減光
    ctx.fillStyle = 'rgba(0,0,0,0.16)';
    for (let y = (t * 30) % 3; y < h; y += 3) ctx.fillRect(0, y, w, 1);
    if (this.noise) {
      ctx.save();
      ctx.translate((Math.random() * 128) | 0, (Math.random() * 128) | 0);
      ctx.fillStyle = this.noise;
      ctx.fillRect(-128, -128, w + 256, h + 256);
      ctx.restore();
    }
    const vg = ctx.createRadialGradient(w / 2, h / 2, Math.min(w, h) * 0.25, w / 2, h / 2, Math.max(w, h) * 0.75);
    vg.addColorStop(0, 'rgba(0,0,0,0)');
    vg.addColorStop(1, 'rgba(0,0,0,0.78)');
    ctx.fillStyle = vg;
    ctx.fillRect(0, 0, w, h);
  };
}
