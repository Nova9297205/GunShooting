// ============================================================
// ゲームパッド（コントローラー）
//   ・接続されているコントローラーの中から、使うものを選べる（設定は保存）
//     「自動」＝最後にボタン・スティックを動かしたもの／「使わない」／特定の1台
//   ・ゲーム中：左スティック移動・右スティック照準・RT 射撃 など（GameSession が読む）
//   ・タイトル画面やパネル（持ち物・作業台・設定）では、画面上のカーソルを動かして A で押す
//   ・振動（被弾・衝突）
// ============================================================

const STORE = 'dn2d.pad';
const DEAD = 0.2;

/** 標準配置（Standard Gamepad）のボタン番号 */
export const PAD = {
  A: 0,
  B: 1,
  X: 2,
  Y: 3,
  LB: 4,
  RB: 5,
  LT: 6,
  RT: 7,
  BACK: 8,
  START: 9,
  L3: 10,
  R3: 11,
  UP: 12,
  DOWN: 13,
  LEFT: 14,
  RIGHT: 15,
} as const;

export interface PadInfo {
  index: number;
  id: string;
  /** 表示用の短い名前 */
  name: string;
  standard: boolean;
}

/** 選んでいるもの：auto / none / "<番号>|<id>" */
type Choice = string;

function shortName(id: string): string {
  // "Xbox Wireless Controller (STANDARD GAMEPAD Vendor: 045e Product: 0b13)" → "Xbox Wireless Controller"
  const s = id.replace(/\(.*?\)/g, '').replace(/\s+/g, ' ').trim();
  return s || id || 'コントローラー';
}

function dz(v: number): number {
  const a = Math.abs(v);
  if (a < DEAD) return 0;
  return (Math.sign(v) * (a - DEAD)) / (1 - DEAD);
}

/**
 * 1台のコントローラーの読み取り：スティック・ボタン（押した瞬間）・メニュー用のカーソル・振動。
 * 通常は「選んだコントローラー」を読む 1 つ（gamepad）だけ。ローカル協力ではプレイヤーごとに 1 つ。
 */
export class PadReader {
  pressed = new Set<number>();
  held = new Set<number>();
  lx = 0;
  ly = 0;
  rx = 0;
  ry = 0;
  lt = 0;
  rt = 0;
  /** 最後に操作した時刻 */
  usedT = 0;
  /** ゲームの操作中（false のときは画面上のカーソルで操作する） */
  gameplay = false;
  /** カーソル操作中に B を押したとき（指定がなければ Esc キーと同じ） */
  onBack: (() => void) | null = null;
  /** カーソルを動かせる範囲（画面分割では自分の枠の中） */
  area: (() => DOMRect) | null = null;
  private prev: boolean[] = [];
  private cursor: HTMLDivElement | null = null;
  cx = typeof window !== 'undefined' ? window.innerWidth / 2 : 0;
  cy = typeof window !== 'undefined' ? window.innerHeight / 2 : 0;
  private cursorShownAt = 0;

  constructor(
    private resolve: () => Gamepad | null,
    private color = '#e0a33a',
    private label = '',
  ) {}

  current(): Gamepad | null {
    return this.resolve();
  }

  /** いま押しっぱなしのボタンを「押した瞬間」に数えないようにする（画面が切り替わった直後など） */
  prime(): void {
    const g = this.resolve();
    this.prev = g ? g.buttons.map((b) => b.pressed || b.value > 0.5) : [];
    this.pressed.clear();
  }
  get active(): boolean {
    return this.resolve() !== null;
  }

  poll(): void {
    this.pressed.clear();
    this.held.clear();
    this.lx = this.ly = this.rx = this.ry = this.lt = this.rt = 0;
    const g = this.resolve();
    if (!g) {
      this.prev = [];
      return;
    }
    const now = g.buttons.map((b) => b.pressed || b.value > 0.5);
    now.forEach((p, i) => {
      if (p) this.held.add(i);
      if (p && !this.prev[i]) this.pressed.add(i);
    });
    this.prev = now;
    this.lx = dz(g.axes[0] ?? 0);
    this.ly = dz(g.axes[1] ?? 0);
    this.rx = dz(g.axes[2] ?? 0);
    this.ry = dz(g.axes[3] ?? 0);
    this.lt = g.buttons[PAD.LT]?.value ?? 0;
    this.rt = g.buttons[PAD.RT]?.value ?? 0;
    if (this.held.size || this.lx || this.ly || this.rx || this.ry) this.usedT = performance.now();
  }

  /** 押された瞬間のボタンを受け取る（同じ押下を2回使わないよう空にする） */
  takePressed(): Set<number> {
    const p = new Set(this.pressed);
    this.pressed.clear();
    return p;
  }

  /** 振動（対応していなければ何もしない） */
  rumble(strong: number, weak: number, ms: number): void {
    const g = this.resolve() as (Gamepad & { vibrationActuator?: { playEffect?: (t: string, p: object) => Promise<unknown> } }) | null;
    try {
      void g?.vibrationActuator?.playEffect?.('dual-rumble', { duration: ms, strongMagnitude: strong, weakMagnitude: weak })?.catch?.(() => {});
    } catch {
      /* 非対応 */
    }
  }

  // ---------------- 画面上のカーソル（メニュー・パネル用） ----------------
  updateCursor(dt: number): void {
    const g = this.resolve();
    if (!g || this.gameplay) {
      if (this.cursor) this.cursor.style.display = 'none';
      return;
    }
    if (!this.cursor) {
      this.cursor = document.createElement('div');
      this.cursor.className = 'pad-cursor';
      this.cursor.style.borderColor = this.color;
      if (this.label) this.cursor.dataset.label = this.label;
      document.body.appendChild(this.cursor);
    }
    const r = this.area?.() ?? new DOMRect(0, 0, window.innerWidth, window.innerHeight);
    const sx = this.lx || this.rx;
    const sy = this.ly || this.ry;
    if (sx || sy) {
      const sp = 900 * dt * (0.35 + 0.65 * Math.hypot(sx, sy));
      this.cx += sx * sp;
      this.cy += sy * sp;
      this.cursorShownAt = performance.now();
    }
    // 十字キーでも動かせる（細かい位置合わせ）
    const step = 18;
    if (this.pressed.has(PAD.LEFT)) this.cx -= step;
    if (this.pressed.has(PAD.RIGHT)) this.cx += step;
    if (this.pressed.has(PAD.UP)) this.cy -= step;
    if (this.pressed.has(PAD.DOWN)) this.cy += step;
    this.cx = Math.max(r.left + 2, Math.min(r.right - 2, this.cx));
    this.cy = Math.max(r.top + 2, Math.min(r.bottom - 2, this.cy));
    if (this.pressed.size) this.cursorShownAt = performance.now();
    this.cursor.style.display = 'block';
    this.cursor.style.transform = `translate(${this.cx}px, ${this.cy}px)`;
    this.cursor.style.opacity = performance.now() - this.cursorShownAt < 6000 ? '1' : '0.35';
    const el = document.elementFromPoint(this.cx, this.cy) as HTMLElement | null;
    this.cursor.classList.toggle('over', !!el?.closest('button, a, input, label, [data-slot], .slot, select'));
    if (this.pressed.has(PAD.A)) this.click(el, 0);
    if (this.pressed.has(PAD.X)) this.click(el, 2);
    if (this.pressed.has(PAD.B)) {
      if (this.onBack) this.onBack();
      else {
        // B：閉じる（Esc と同じ）
        window.dispatchEvent(new KeyboardEvent('keydown', { code: 'Escape', key: 'Escape', bubbles: true }));
        window.dispatchEvent(new KeyboardEvent('keyup', { code: 'Escape', key: 'Escape', bubbles: true }));
      }
    }
  }

  /** カーソルの位置を押す（0 = 左クリック、2 = 右クリック） */
  private click(el: HTMLElement | null, button: 0 | 2): void {
    if (!el) return;
    const o = { bubbles: true, cancelable: true, clientX: this.cx, clientY: this.cy, button, buttons: button === 0 ? 1 : 2, view: window };
    el.dispatchEvent(new MouseEvent('mousedown', o));
    el.dispatchEvent(new MouseEvent('mouseup', o));
    if (button === 0) {
      el.dispatchEvent(new MouseEvent('click', o));
      if (el instanceof HTMLInputElement) el.focus();
    } else el.dispatchEvent(new MouseEvent('contextmenu', o));
  }

  /** カーソルを枠の中央へ */
  centerCursor(): void {
    const r = this.area?.() ?? new DOMRect(0, 0, window.innerWidth, window.innerHeight);
    this.cx = r.left + r.width / 2;
    this.cy = r.top + r.height / 2;
  }

  hideCursor(): void {
    this.cursor?.remove();
    this.cursor = null;
  }
}

export class GamepadManager extends PadReader {
  /** 選択（保存される） */
  choice: Choice = 'auto';
  /** 「自動」で最後に操作されたコントローラー */
  private lastActive: number | null = null;
  private prevButtons = new Map<number, boolean[]>();
  /** ローカル協力中など：選択したコントローラーを（このリーダーでは）使わない */
  suspended = false;
  /** プレイヤーごとのリーダー（ローカル協力） */
  private readers = new Set<PadReader>();
  private raf = 0;
  private lastT = 0;
  private listeners = new Set<() => void>();
  private toastEl: HTMLDivElement | null = null;
  private knownIds = new Set<string>();

  constructor() {
    super(() => this.resolveChoice());
    try {
      this.choice = localStorage.getItem(STORE) || 'auto';
    } catch {
      /* 保存できない環境 */
    }
    if (typeof window === 'undefined') return;
    window.addEventListener('gamepadconnected', (e) => this.onConnect(e as GamepadEvent));
    window.addEventListener('gamepaddisconnected', (e) => this.onDisconnect(e as GamepadEvent));
    this.raf = requestAnimationFrame(this.loop);
  }

  /** 設定画面などが一覧の変化を知るため */
  onChange(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }
  private emit(): void {
    for (const fn of this.listeners) fn();
  }

  pads(): PadInfo[] {
    const out: PadInfo[] = [];
    const list = typeof navigator !== 'undefined' && navigator.getGamepads ? navigator.getGamepads() : [];
    for (const g of list) if (g && g.connected) out.push({ index: g.index, id: g.id, name: shortName(g.id), standard: g.mapping === 'standard' });
    return out;
  }

  setChoice(c: Choice): void {
    this.choice = c;
    this.lastActive = null;
    try {
      localStorage.setItem(STORE, c);
    } catch {
      /* 無視 */
    }
    this.emit();
  }

  /** "<番号>|<id>" で指定したコントローラー（差し直して番号が変わっても同じ名前のものを探す） */
  static byKey(key: string): Gamepad | null {
    const list = navigator.getGamepads ? navigator.getGamepads() : [];
    const [idx, ...rest] = key.split('|');
    const id = rest.join('|');
    const byIdx = list[Number(idx)];
    if (byIdx && byIdx.connected && byIdx.id === id) return byIdx;
    for (const g of list) if (g && g.connected && g.id === id) return g;
    return null;
  }

  private resolveChoice(): Gamepad | null {
    if (this.suspended || this.choice === 'none') return null;
    if (this.choice === 'auto') {
      if (this.lastActive === null) return null;
      const g = (navigator.getGamepads ? navigator.getGamepads() : [])[this.lastActive];
      return g && g.connected ? g : null;
    }
    return GamepadManager.byKey(this.choice);
  }

  /** ローカル協力：特定のコントローラーを読むリーダーを作る */
  forPad(key: string, color: string, label: string): PadReader {
    const r = new PadReader(() => GamepadManager.byKey(key), color, label);
    r.prime();
    this.readers.add(r);
    return r;
  }
  drop(r: PadReader): void {
    r.hideCursor();
    this.readers.delete(r);
  }

  private onConnect(e: GamepadEvent): void {
    const g = e.gamepad;
    if (!this.knownIds.has(`${g.index}|${g.id}`)) {
      this.knownIds.add(`${g.index}|${g.id}`);
      const many = this.pads().length > 1;
      this.toast(`🎮 コントローラーを接続：${shortName(g.id)}${many ? '（複数あります — 🎮 ボタンで使うものを選べます）' : ''}`);
    }
    this.emit();
  }
  private onDisconnect(e: GamepadEvent): void {
    const g = e.gamepad;
    this.knownIds.delete(`${g.index}|${g.id}`);
    if (this.lastActive === g.index) this.lastActive = null;
    this.toast(`🎮 コントローラーが外れました：${shortName(g.id)}`);
    this.emit();
  }

  toast(text: string): void {
    if (!this.toastEl) {
      this.toastEl = document.createElement('div');
      this.toastEl.id = 'pad-toast';
      document.body.appendChild(this.toastEl);
    }
    this.toastEl.textContent = text;
    this.toastEl.classList.add('show');
    clearTimeout((this.toastEl as unknown as { t: number }).t);
    (this.toastEl as unknown as { t: number }).t = window.setTimeout(() => this.toastEl?.classList.remove('show'), 4000);
  }

  private loop = (t: number): void => {
    this.raf = requestAnimationFrame(this.loop);
    const dt = Math.min(0.05, this.lastT ? (t - this.lastT) / 1000 : 0.016);
    this.lastT = t;
    this.detect();
    this.poll();
    this.updateCursor(dt);
    for (const r of this.readers) {
      r.poll();
      r.updateCursor(dt);
    }
  };

  /** 「自動」の切り替えと、接続イベントより先に見つかったコントローラーの通知 */
  private detect(): void {
    const list = navigator.getGamepads ? navigator.getGamepads() : [];
    for (const g of list) {
      if (!g || !g.connected) continue;
      const prev = this.prevButtons.get(g.index) ?? [];
      const now = g.buttons.map((b) => b.pressed || b.value > 0.5);
      const moved = g.axes.some((a) => Math.abs(a) > 0.5);
      if (this.choice === 'auto' && (moved || now.some((p, i) => p && !prev[i]))) this.lastActive = g.index;
      this.prevButtons.set(g.index, now);
      if (!this.knownIds.has(`${g.index}|${g.id}`)) {
        this.knownIds.add(`${g.index}|${g.id}`);
        const many = list.filter((q) => q && q.connected).length > 1;
        this.toast(`🎮 コントローラーを接続：${shortName(g.id)}${many ? '（複数あります — 🎮 ボタンで使うものを選べます）' : ''}`);
        this.emit();
      }
    }
  }

  destroy(): void {
    cancelAnimationFrame(this.raf);
  }
}

export const gamepad = new GamepadManager();


// ============================================================
// 設定画面：使うコントローラーを選ぶ・ボタンの反応を確かめる
// ============================================================
export class GamepadSettings {
  private el: HTMLDivElement;
  private list: HTMLDivElement;
  private test: HTMLDivElement;
  private raf = 0;
  open = false;

  constructor() {
    this.el = document.createElement('div');
    this.el.id = 'pad-modal';
    this.el.className = 'hidden';
    this.el.innerHTML = `
      <div class="pad-card">
        <div class="pad-head"><b>🎮 コントローラー設定</b><button class="btn small ghost" data-close>閉じる</button></div>
        <p class="pad-note">使うコントローラーを選んでください。複数つないでいるときは、ここで選んだ 1 台だけで操作します（設定は保存されます）。</p>
        <div class="pad-list"></div>
        <div class="pad-test"></div>
        <table class="pad-map">
          <tr><th>左スティック</th><td>移動</td><th>右スティック</th><td>照準</td></tr>
          <tr><th>RT</th><td>射撃・建てる</td><th>LT（長押し）</th><td>蘇生</td></tr>
          <tr><th>A</th><td>調べる・乗る・眠る</td><th>B</th><td>ダッシュ／閉じる</td></tr>
          <tr><th>X</th><td>リロード（建設中は撤去）</td><th>Y / RB / LB</th><td>武器・建てる物の切り替え</td></tr>
          <tr><th>START</th><td>持ち物</td><th>BACK</th><td>地図</td></tr>
          <tr><th>十字 ↑</th><td>ピン</td><th>十字 ↓</th><td>建設モード</td></tr>
          <tr><th>十字 ←</th><td>作業台</td><th>十字 →</th><td>弾種の切り替え</td></tr>
          <tr><th>L3</th><td>食事</td><th>R3</th><td>回復</td></tr>
        </table>
        <p class="pad-note">メニューや持ち物では画面のカーソルをスティックで動かし、A で押す・X で右クリック・B で閉じる。</p>
      </div>`;
    document.body.appendChild(this.el);
    this.list = this.el.querySelector('.pad-list') as HTMLDivElement;
    this.test = this.el.querySelector('.pad-test') as HTMLDivElement;
    this.el.addEventListener('click', (e) => {
      const t = e.target as HTMLElement;
      if (t === this.el || t.closest('[data-close]')) this.toggle(false);
      const pick = t.closest('[data-pick]') as HTMLElement | null;
      if (pick) gamepad.setChoice(pick.dataset.pick!);
    });
    window.addEventListener('keydown', (e) => {
      if (this.open && e.code === 'Escape') this.toggle(false);
    });
    gamepad.onChange(() => this.render());
  }

  toggle(force?: boolean): void {
    this.open = force ?? !this.open;
    this.el.classList.toggle('hidden', !this.open);
    cancelAnimationFrame(this.raf);
    if (this.open) {
      this.render();
      const tick = () => {
        this.renderTest();
        this.raf = requestAnimationFrame(tick);
      };
      tick();
    }
  }

  private render(): void {
    if (!this.open) return;
    const pads = gamepad.pads();
    const cur = gamepad.current();
    const row = (key: string, label: string, sub: string, connected = true) =>
      `<button class="pad-row ${gamepad.choice === key ? 'on' : ''}" data-pick="${key}" ${connected ? '' : 'disabled'}><i></i><span><b>${label}</b><small>${sub}</small></span>${cur && key.startsWith(`${cur.index}|`) ? '<em>使用中</em>' : ''}</button>`;
    let html = row('auto', '自動', cur && gamepad.choice === 'auto' ? `いま：${pads.find((p) => p.index === cur.index)?.name ?? ''}` : '最後にボタンを押したコントローラーを使う');
    html += row('none', '使わない', 'キーボード・マウス（タッチ）だけで遊ぶ');
    if (!pads.length) html += '<p class="pad-empty">コントローラーが見つかりません。つないでから、どれかのボタンを押してください。</p>';
    for (const p of pads) html += row(`${p.index}|${p.id}`, `${p.index + 1}. ${p.name}`, p.standard ? '標準配置' : '標準配置ではない（ボタンの位置が違うことがあります）');
    // 保存してある 1 台が今つながっていない
    if (gamepad.choice !== 'auto' && gamepad.choice !== 'none' && !pads.some((p) => `${p.index}|${p.id}` === gamepad.choice)) {
      html += row(gamepad.choice, `${shortName(gamepad.choice.split('|').slice(1).join('|'))}（未接続）`, 'つなぐと自動で使われます', false);
    }
    this.list.innerHTML = html;
  }

  private renderTest(): void {
    const g = gamepad.current();
    if (!g) {
      this.test.innerHTML = '<span class="dim">ボタンの反応：選んだコントローラーがつながると、ここに表示されます</span>';
      return;
    }
    const names = ['A', 'B', 'X', 'Y', 'LB', 'RB', 'LT', 'RT', 'BACK', 'START', 'L3', 'R3', '↑', '↓', '←', '→'];
    const btns = names.map((n, i) => `<i class="${g.buttons[i]?.pressed || (g.buttons[i]?.value ?? 0) > 0.5 ? 'on' : ''}">${n}</i>`).join('');
    const stick = (x: number, y: number) => `<s><u style="transform:translate(${(x * 14).toFixed(1)}px,${(y * 14).toFixed(1)}px)"></u></s>`;
    this.test.innerHTML = `<span>反応：</span>${stick(g.axes[0] ?? 0, g.axes[1] ?? 0)}${stick(g.axes[2] ?? 0, g.axes[3] ?? 0)}<span class="pad-btns">${btns}</span>`;
  }
}

let settingsInstance: GamepadSettings | null = null;
/** 設定画面は 1 つだけ（タイトルとゲーム中で共有） */
export function padSettings(): GamepadSettings {
  if (!settingsInstance) settingsInstance = new GamepadSettings();
  return settingsInstance;
}

if (import.meta.env?.DEV && typeof window !== 'undefined') Object.assign(window, { __pad: gamepad });
