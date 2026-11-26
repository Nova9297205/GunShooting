// ============================================================
// パフォーマンス表示（F3 / P で開閉）
//   FPS・フレーム時間・CPU処理の内訳・描画数・通信量をまとめて表示し、
//   60fps に届かないとき「どこが重いのか」を一目で分かるようにする。
//   表示は DOM（ゲーム画面のキャンバスとは別）で、文字の更新は 1 秒に 4 回だけ。
// ============================================================

/** 計測する処理の区分（表示順） */
export const PERF_KEYS = ['sim', 'world', 'light', 'over', 'hud'] as const;
export type PerfKey = (typeof PERF_KEYS)[number];
const LABEL: Record<PerfKey, string> = { sim: '計算', world: '地形・物体', light: '光・天候', over: '重ね描き', hud: 'HUD' };
const COLOR: Record<PerfKey, string> = { sim: '#6fa0d8', world: '#93b77c', light: '#e0a33a', over: '#c08ad0', hud: '#d6563c' };

export interface PerfCounts {
  zombies: number;
  zombiesDrawn: number;
  objects: number;
  particles: number;
  chunks: string;
  terrain: string;
  res: string;
  net: string;
}

const N = 240; // グラフに残すフレーム数（60fpsで約4秒）
const STORE = 'dn2d.perf';

/** 通信量の集計（NetworkManager が書き込む） */
export const netStats = { out: 0, in: 0, snaps: 0, measure: false };

export class PerfOverlay {
  open = false;
  private el: HTMLDivElement;
  private text: HTMLPreElement;
  private graph: HTMLCanvasElement;
  private g: CanvasRenderingContext2D;
  private frameMs = new Float32Array(N);
  private cpuMs = new Float32Array(N);
  private part: Record<PerfKey, Float32Array>;
  private idx = 0;
  private filled = 0;
  private cur: Record<PerfKey, number>;
  private frameStart = 0;
  private lastFrame = 0;
  private textT = 0;
  private netT = 0;
  private netRate = { out: 0, in: 0, snaps: 0 };
  counts: PerfCounts | null = null;

  constructor() {
    this.part = {} as Record<PerfKey, Float32Array>;
    this.cur = {} as Record<PerfKey, number>;
    for (const k of PERF_KEYS) {
      this.part[k] = new Float32Array(N);
      this.cur[k] = 0;
    }
    this.el = document.createElement('div');
    this.el.id = 'perf';
    this.el.className = 'hidden';
    this.text = document.createElement('pre');
    this.graph = document.createElement('canvas');
    this.graph.width = 300;
    this.graph.height = 70;
    this.g = this.graph.getContext('2d')!;
    this.el.append(this.text, this.graph);
    document.body.appendChild(this.el);
    window.addEventListener('keydown', this.onKey);
    try {
      if (localStorage.getItem(STORE) === '1') this.toggle(true);
    } catch {
      /* 保存できない環境では毎回閉じた状態から */
    }
  }

  destroy(): void {
    window.removeEventListener('keydown', this.onKey);
    netStats.measure = false;
    this.el.remove();
  }

  private onKey = (e: KeyboardEvent): void => {
    if ((e.target as HTMLElement)?.tagName === 'INPUT') return;
    if (e.code === 'F3' || (e.code === 'KeyP' && !e.repeat)) {
      e.preventDefault(); // F3 はブラウザの「ページ内検索」を開かないようにする
      if (!e.repeat) this.toggle();
    }
  };

  toggle(on = !this.open): void {
    this.open = on;
    this.el.classList.toggle('hidden', !on);
    netStats.measure = on;
    try {
      localStorage.setItem(STORE, on ? '1' : '0');
    } catch {
      /* 無視 */
    }
  }

  /** フレームの最初に呼ぶ */
  beginFrame(nowMs: number): void {
    this.frameStart = performance.now();
    const dt = this.lastFrame ? nowMs - this.lastFrame : 16.7;
    this.lastFrame = nowMs;
    this.frameMs[this.idx] = Math.min(200, Math.max(0, dt));
    for (const k of PERF_KEYS) this.cur[k] = 0;
  }

  /** 区分ごとの処理時間を足し込む（ms） */
  add(k: PerfKey, ms: number): void {
    this.cur[k] += ms;
  }

  /** フレームの最後に呼ぶ */
  endFrame(): void {
    const i = this.idx;
    this.cpuMs[i] = performance.now() - this.frameStart;
    for (const k of PERF_KEYS) this.part[k][i] = this.cur[k];
    this.idx = (i + 1) % N;
    this.filled = Math.min(N, this.filled + 1);
    if (!this.open) return;
    const now = performance.now();
    if (now - this.netT >= 1000) {
      const s = (now - this.netT) / 1000;
      if (this.netT) this.netRate = { out: netStats.out / s, in: netStats.in / s, snaps: netStats.snaps / s };
      netStats.out = netStats.in = netStats.snaps = 0;
      this.netT = now;
    }
    this.drawGraph();
    if (now - this.textT >= 250) {
      this.textT = now;
      this.updateText();
    }
  }

  /** 直近 n フレーム（新しい順） */
  private recent(arr: Float32Array, n: number): number[] {
    const out: number[] = [];
    for (let j = 1; j <= Math.min(n, this.filled); j++) out.push(arr[(this.idx - j + N) % N]);
    return out;
  }

  private updateText(): void {
    const n = 120; // 直近 約2秒
    const ft = this.recent(this.frameMs, n);
    if (!ft.length) return;
    const avg = (a: number[]) => a.reduce((s, v) => s + v, 0) / Math.max(1, a.length);
    const fAvg = avg(ft);
    const sorted = [...ft].sort((a, b) => b - a);
    const worst1 = sorted.slice(0, Math.max(1, Math.round(sorted.length / 100)));
    const low1 = 1000 / avg(worst1);
    const fMax = sorted[0];
    const cpu = avg(this.recent(this.cpuMs, n));
    const parts = PERF_KEYS.map((k) => [k, avg(this.recent(this.part[k], n))] as const);
    const fps = 1000 / fAvg;
    const other = Math.max(0, cpu - parts.reduce((s, [, v]) => s + v, 0));
    const wait = Math.max(0, fAvg - cpu);

    // 判定：何が 60fps を妨げているか
    let verdict: string;
    const top = [...parts].sort((a, b) => b[1] - a[1])[0];
    if (fps >= 57) verdict = '<b class="ok">◎ 60fps 出ています</b>';
    else if (cpu >= fAvg * 0.6) verdict = `<b class="ng">△ CPU が重い：いちばん重いのは「${LABEL[top[0]]}」</b>`;
    else
      verdict =
        '<b class="warn">△ GPU・待ちが大きい → 画面の合成・解像度か、他のアプリ/タブが重い可能性</b>' +
        (cpu > 14 ? `\n<b class="warn">　CPU も重め：いちばん重いのは「${LABEL[top[0]]}」</b>` : '');

    const c = this.counts;
    const pad = (v: number, d = 1) => v.toFixed(d).padStart(5);
    const lines = [
      `<span class="big ${fps >= 57 ? 'ok' : fps >= 40 ? 'warn' : 'ng'}">${fps.toFixed(1)} FPS</span>  1% low ${low1.toFixed(0)}  最大 ${fMax.toFixed(1)}ms`,
      verdict,
      `フレーム ${pad(fAvg)}ms = CPU ${pad(cpu)}ms + GPU・待ち ${pad(wait)}ms`,
      ...parts.map(([k, v]) => `<i style="color:${COLOR[k]}">■</i> ${LABEL[k].padEnd(6, '　')} ${pad(v, 2)}ms`),
      `<i style="color:#666">■</i> その他　　 ${pad(other, 2)}ms`,
    ];
    if (c) {
      lines.push(
        `解像度 ${c.res}`,
        `ゾンビ ${c.zombies}（描画 ${c.zombiesDrawn}）  物体 ${c.objects}  粒子 ${c.particles}`,
        `チャンク ${c.chunks}  地形キャッシュ ${c.terrain}`,
        `通信 ${c.net}  ↑${(this.netRate.out / 1024).toFixed(1)}KB/s ↓${(this.netRate.in / 1024).toFixed(1)}KB/s  状態 ${this.netRate.snaps.toFixed(0)}回/s`,
      );
    }
    lines.push('<span class="dim">[F3] / [P] で閉じる ・ 緑線 60fps / 赤線 30fps</span>');
    this.text.innerHTML = lines.join('\n');
  }

  private drawGraph(): void {
    const { g } = this;
    const W = this.graph.width;
    const H = this.graph.height;
    const scale = H / 50; // 縦軸 0〜50ms
    g.clearRect(0, 0, W, H);
    g.fillStyle = 'rgba(0,0,0,0.35)';
    g.fillRect(0, 0, W, H);
    const bw = W / N;
    for (let j = 0; j < this.filled; j++) {
      const i = (this.idx - this.filled + j + N) % N;
      const x = (N - this.filled + j) * bw;
      const f = this.frameMs[i];
      // 全体（フレーム時間）
      g.fillStyle = f > 33.4 ? 'rgba(214,86,60,0.55)' : f > 17.5 ? 'rgba(224,163,58,0.45)' : 'rgba(147,183,124,0.35)';
      const fh = Math.min(H, f * scale);
      g.fillRect(x, H - fh, Math.max(1, bw), fh);
      // CPU の内訳を積み上げ
      let y = H;
      for (const k of PERF_KEYS) {
        const h = this.part[k][i] * scale;
        if (h <= 0) continue;
        g.fillStyle = COLOR[k];
        g.fillRect(x, y - h, Math.max(1, bw), h);
        y -= h;
      }
    }
    const line = (ms: number, col: string) => {
      g.strokeStyle = col;
      g.beginPath();
      g.moveTo(0, H - ms * scale + 0.5);
      g.lineTo(W, H - ms * scale + 0.5);
      g.stroke();
    };
    line(16.7, 'rgba(147,220,124,0.8)');
    line(33.3, 'rgba(214,86,60,0.8)');
  }
}
