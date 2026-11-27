// ============================================================
// ローカル協力（画面分割）の準備画面
//   ・1P はキーボード＋マウス（「変更」でコントローラーにもできる）
//   ・コントローラーの A を押すと、空いている 2P / 3P に参加。B で抜ける。START（または「開始」）で出撃
//   ・同じ機器を 2 人が使うことはできない
// ============================================================

import { PLAYER_COLORS } from '../game/constants';
import { gamepad, PAD } from './Gamepad';

export interface LocalPlayerCfg {
  name: string;
  /** 'kbm' = キーボード＋マウス、それ以外はコントローラーの "<番号>|<id>" */
  device: string;
}

const short = (id: string) => id.replace(/\(.*?\)/g, '').replace(/\s+/g, ' ').trim() || 'コントローラー';

export class LocalSetup {
  private el: HTMLDivElement;
  private slots: (LocalPlayerCfg | null)[] = [null, null, null];
  private prev = new Map<number, boolean[]>();
  private raf = 0;
  open = false;
  private onStart: (players: LocalPlayerCfg[], cont: boolean) => void = () => {};
  private hasSave = false;

  constructor() {
    this.el = document.createElement('div');
    this.el.id = 'local-modal';
    this.el.className = 'hidden';
    document.body.appendChild(this.el);
    this.el.addEventListener('click', (e) => {
      const t = (e.target as HTMLElement).closest('button') as HTMLButtonElement | null;
      if (!t || t.disabled) return;
      const i = Number(t.dataset.i);
      if (t.dataset.act === 'close') this.toggle(false);
      else if (t.dataset.act === 'dev') this.cycleDevice(i);
      else if (t.dataset.act === 'drop') {
        this.slots[i] = null;
        this.render();
      } else if (t.dataset.act === 'add') {
        this.slots[i] = { name: `P${i + 1}`, device: this.freeDevices(i)[0] ?? 'kbm' };
        this.render();
      } else if (t.dataset.act === 'start') this.start(false);
      else if (t.dataset.act === 'cont') this.start(true);
    });
    this.el.addEventListener('input', (e) => {
      const t = e.target as HTMLInputElement;
      const i = Number(t.dataset.i);
      if (this.slots[i]) this.slots[i]!.name = t.value.slice(0, 12);
    });
    window.addEventListener('keydown', (e) => {
      if (this.open && e.code === 'Escape') this.toggle(false);
    });
  }

  show(p1Name: string, hasSave: boolean, onStart: (players: LocalPlayerCfg[], cont: boolean) => void): void {
    this.onStart = onStart;
    this.hasSave = hasSave;
    if (!this.slots[0]) this.slots[0] = { name: p1Name, device: 'kbm' };
    else this.slots[0].name = p1Name;
    this.toggle(true);
  }

  toggle(force?: boolean): void {
    this.open = force ?? !this.open;
    this.el.classList.toggle('hidden', !this.open);
    // 準備中は、ふだんのコントローラー操作（カーソル）を止めて、A＝参加として読む
    gamepad.suspended = this.open;
    cancelAnimationFrame(this.raf);
    if (this.open) {
      this.prev.clear();
      // いま押しっぱなしのボタンは「押した瞬間」に数えない
      for (const g of navigator.getGamepads ? navigator.getGamepads() : []) if (g) this.prev.set(g.index, g.buttons.map((b) => b.pressed));
      this.render();
      const tick = () => {
        this.pollJoin();
        // 開始して閉じたら、それ以上は読まない（ゲーム中の START で開始し直さないように）
        if (this.open) this.raf = requestAnimationFrame(tick);
      };
      this.raf = requestAnimationFrame(tick);
    }
  }

  private padKeys(): { key: string; name: string }[] {
    const out: { key: string; name: string }[] = [];
    for (const g of navigator.getGamepads ? navigator.getGamepads() : []) if (g && g.connected) out.push({ key: `${g.index}|${g.id}`, name: `${g.index + 1}. ${short(g.id)}` });
    return out;
  }

  /** i 番目の人が選べる機器（ほかの人が使っていないもの） */
  private freeDevices(i: number): string[] {
    const used = new Set(this.slots.filter((s, j) => s && j !== i).map((s) => s!.device));
    return ['kbm', ...this.padKeys().map((p) => p.key)].filter((d) => !used.has(d));
  }

  private cycleDevice(i: number): void {
    const s = this.slots[i];
    if (!s) return;
    const opts = this.freeDevices(i);
    if (!opts.length) return;
    const k = opts.indexOf(s.device);
    s.device = opts[(k + 1) % opts.length];
    this.render();
  }

  /** コントローラーの A で参加・B で抜ける・START で開始 */
  private pollJoin(): void {
    for (const g of navigator.getGamepads ? navigator.getGamepads() : []) {
      if (!g || !g.connected) continue;
      const prev = this.prev.get(g.index) ?? [];
      const now = g.buttons.map((b) => b.pressed || b.value > 0.5);
      const hit = (b: number) => now[b] && !prev[b];
      this.prev.set(g.index, now);
      const key = `${g.index}|${g.id}`;
      const mine = this.slots.findIndex((s) => s?.device === key);
      if (hit(PAD.A) && mine < 0) {
        const free = this.slots.findIndex((s, i) => i > 0 && !s);
        if (free > 0) {
          this.slots[free] = { name: `P${free + 1}`, device: key };
          gamepad.toast(`P${free + 1} が参加：${short(g.id)}`);
          this.render();
        }
      } else if (hit(PAD.B) && mine > 0) {
        this.slots[mine] = null;
        this.render();
      } else if (hit(PAD.START) && mine >= 0) this.start(false);
    }
  }

  private players(): LocalPlayerCfg[] {
    return this.slots.filter((s): s is LocalPlayerCfg => !!s);
  }

  private start(cont: boolean): void {
    const ps = this.players();
    if (ps.length < 2) {
      gamepad.toast('2 人以上で始められます（コントローラーの A で参加）');
      return;
    }
    // 番号を詰める（1P → 2P → 3P）
    this.toggle(false);
    this.onStart(
      ps.map((p, i) => ({ name: p.name.trim() || `P${i + 1}`, device: p.device })),
      cont,
    );
  }

  private render(): void {
    if (!this.open) return;
    const pads = new Map(this.padKeys().map((p) => [p.key, p.name]));
    const devName = (d: string) => (d === 'kbm' ? '⌨ キーボード＋マウス' : `🎮 ${pads.get(d) ?? '（未接続のコントローラー）'}`);
    const rows = this.slots
      .map((s, i) => {
        const c = PLAYER_COLORS[i] ?? '#fff';
        if (!s)
          return `<div class="lp-slot empty" style="--c:${c}"><b>P${i + 1}</b><span>コントローラーの <kbd>A</kbd> を押して参加</span>${i > 0 ? `<button class="btn small ghost" data-act="add" data-i="${i}">追加</button>` : ''}</div>`;
        return `<div class="lp-slot" style="--c:${c}"><b>P${i + 1}</b>
          <input data-i="${i}" value="${s.name.replace(/"/g, '')}" maxlength="12" />
          <button class="btn small" data-act="dev" data-i="${i}" title="クリックで切り替え">${devName(s.device)}</button>
          ${i > 0 ? `<button class="btn small ghost" data-act="drop" data-i="${i}">外す</button>` : ''}</div>`;
      })
      .join('');
    const n = this.players().length;
    this.el.innerHTML = `
      <div class="lp-card">
        <div class="pad-head"><b>👥 ローカル協力（画面分割）</b><button class="btn small ghost" data-act="close">閉じる</button></div>
        <p class="pad-note">1 台の PC で 2〜3 人。コントローラーを持っている人は <kbd>A</kbd> で参加、<kbd>B</kbd> で抜ける、<kbd>START</kbd> で出撃。機器のボタンを押すと使う機器を切り替えられます（同じ機器は 1 人だけ）。</p>
        <div class="lp-slots">${rows}</div>
        <div class="lp-layout">画面：${n >= 3 ? '左（1P）／右上（2P）／右下（3P）' : '左（1P）／右（2P）'}</div>
        <div class="lp-actions">
          ${this.hasSave ? '<button class="btn" data-act="cont">セーブから続ける</button>' : ''}
          <button class="btn primary" data-act="start" ${n < 2 ? 'disabled' : ''}>画面分割で出撃（${n} 人）</button>
        </div>
      </div>`;
  }
}
