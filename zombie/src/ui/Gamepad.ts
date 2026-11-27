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

/** ボタン番号 → 表記の名前（Glyphs のキー） */
export const BTN_NAME = ['A', 'B', 'X', 'Y', 'LB', 'RB', 'LT', 'RT', 'BACK', 'START', 'L3', 'R3', 'UP', 'DOWN', 'LEFT', 'RIGHT'] as const;
/** 割り当てを変えられるボタン（トリガー・LB/RB はメニューのタブ切り替えや射撃に使うので固定） */
export const REMAPPABLE: number[] = [PAD.A, PAD.B, PAD.X, PAD.Y, PAD.BACK, PAD.START, PAD.L3, PAD.R3, PAD.UP, PAD.DOWN, PAD.LEFT, PAD.RIGHT];

/** ゲーム中の操作（ボタンの割り当てを変えられる）。key は案内文のキー表記 [F] など */
export const PAD_ACTIONS = [
  { id: 'use', label: '調べる・乗る・眠る', key: 'F', def: PAD.A },
  { id: 'dash', label: 'ダッシュ', key: '', def: PAD.B },
  { id: 'reload', label: 'リロード（建設中は撤去）', key: 'R', def: PAD.X },
  { id: 'next', label: '次の武器', key: '', def: PAD.Y },
  { id: 'inv', label: '持ち物', key: 'Tab', def: PAD.START },
  { id: 'map', label: '地図', key: 'B', def: PAD.BACK },
  { id: 'eat', label: '食事', key: 'Q', def: PAD.L3 },
  { id: 'heal', label: '回復', key: 'H', def: PAD.R3 },
  { id: 'ping', label: 'ピン', key: 'G', def: PAD.UP },
  { id: 'build', label: '建設モード', key: 'V', def: PAD.DOWN },
  { id: 'craft', label: '作業台', key: 'C', def: PAD.LEFT },
  { id: 'ammo', label: '弾種の切り替え', key: 'T', def: PAD.RIGHT },
] as const;
export type PadAction = (typeof PAD_ACTIONS)[number]['id'];

/**
 * 設定：デッドゾーン（0.05〜0.35）・エイム補助の強さ（0=オフ〜3=強）・
 * ボタンの割り当て（変えた物だけ）・長押し操作を「押すたびに切り替え」にするか
 */
export const padPrefs = { dead: DEAD, assist: 2, map: {} as Partial<Record<PadAction, number>>, toggle: false };
try {
  const v = JSON.parse(localStorage.getItem('dn2d.padprefs') || '{}');
  if (typeof v.dead === 'number') padPrefs.dead = Math.max(0.05, Math.min(0.35, v.dead));
  if (typeof v.assist === 'number') padPrefs.assist = Math.max(0, Math.min(3, Math.round(v.assist)));
  if (typeof v.toggle === 'boolean') padPrefs.toggle = v.toggle;
  if (v.map && typeof v.map === 'object') {
    for (const a of PAD_ACTIONS) {
      const b = v.map[a.id];
      if (typeof b === 'number' && REMAPPABLE.includes(b)) padPrefs.map[a.id] = b;
    }
  }
} catch {
  /* 既定値 */
}
export function savePadPrefs(): void {
  try {
    localStorage.setItem('dn2d.padprefs', JSON.stringify(padPrefs));
  } catch {
    /* 無視 */
  }
}

/** その操作に割り当てたボタン番号 */
export function padBtn(id: PadAction): number {
  return padPrefs.map[id] ?? PAD_ACTIONS.find((a) => a.id === id)!.def;
}

/** 割り当てを変える。すでにそのボタンを使っている操作とは入れ替える */
export function remapPad(id: PadAction, btn: number): void {
  if (!REMAPPABLE.includes(btn)) return;
  const old = padBtn(id);
  const other = PAD_ACTIONS.find((a) => a.id !== id && padBtn(a.id) === btn);
  padPrefs.map[id] = btn;
  if (other) padPrefs.map[other.id] = old;
  for (const a of PAD_ACTIONS) if (padPrefs.map[a.id] === a.def) delete padPrefs.map[a.id];
  savePadPrefs();
}

/**
 * 円形のデッドゾーン：スティックを倒した「量」で判定し、その先を 0〜1 になめらかにつなぎ直す
 * （軸ごとに切ると斜めがすべり、照準の向きがずれる）
 */
export function radial(x: number, y: number, dead = padPrefs.dead): [number, number] {
  const m = Math.hypot(x, y);
  if (m < dead) return [0, 0];
  const k = Math.min(1, (m - dead) / (1 - dead)) / m;
  return [x * k, y * k];
}

// ---------------- ボタン表記（Xbox / PlayStation） ----------------
export type Glyphs = Record<'A' | 'B' | 'X' | 'Y' | 'LB' | 'RB' | 'LT' | 'RT' | 'START' | 'BACK' | 'L3' | 'R3' | 'UP' | 'DOWN' | 'LEFT' | 'RIGHT', string>;
const XBOX: Glyphs = { A: 'A', B: 'B', X: 'X', Y: 'Y', LB: 'LB', RB: 'RB', LT: 'LT', RT: 'RT', START: 'START', BACK: 'BACK', L3: 'L3', R3: 'R3', UP: '十字↑', DOWN: '十字↓', LEFT: '十字←', RIGHT: '十字→' };
const PS: Glyphs = { A: '✕', B: '○', X: '□', Y: '△', LB: 'L1', RB: 'R1', LT: 'L2', RT: 'R2', START: 'OPTIONS', BACK: 'CREATE', L3: 'L3', R3: 'R3', UP: '十字↑', DOWN: '十字↓', LEFT: '十字←', RIGHT: '十字→' };
/** コントローラーの名前から、ボタンの表記を選ぶ */
export function glyphsFor(id: string | undefined): Glyphs {
  return id && /054c|dualsense|dualshock|playstation|ps4|ps5/i.test(id) ? PS : XBOX;
}
/** キーボード・マウスの案内文を、コントローラーのボタン名に置き換える */
/** キー表記 → ボタン（ゲーム中の操作は、いまの割り当てに合わせる） */
function kb2pad(): [RegExp, string][] {
  const act = (id: PadAction): string => `{${BTN_NAME[padBtn(id)]}}`;
  return [
  ...PAD_ACTIONS.filter((a) => a.key).map((a): [RegExp, string] => [new RegExp(`\\[${a.key}\\]`, 'g'), act(a.id)]),
  [/\[E\] ?長押し/g, padPrefs.toggle ? '{LT} で切り替え' : '{LT} 長押し'],
  [/\[Esc\]/g, '{B}'],
  [/\[1〜6\]\/ホイール/g, '{LB}/{RB}'],
  [/移動キー/g, '左スティック'],
  [/Shift\+クリック/g, '{Y}'],
  [/右クリック/g, '{X}'],
  [/左クリック/g, '{A}'],
  [/クリック/g, '{A}'],
  ];
}
export function padText(t: string, g: Glyphs): string {
  let s = t;
  for (const [re, to] of kb2pad()) s = s.replace(re, to);
  // {@use} などは、その操作に割り当てたボタン
  s = s.replace(/\{@(\w+)\}/g, (_, id: PadAction) => (PAD_ACTIONS.some((a) => a.id === id) ? `{${BTN_NAME[padBtn(id)]}}` : ''));
  // 置き換えたボタン名には見えない印（U+2060）を付け、もう一度通しても変わらないようにする（[B] ボタン ≠ キーボードの [B]）
  return s.replace(/\{(\w+)\}/g, (_, k: keyof Glyphs) => `[\u2060${g[k] ?? k}]`);
}

/** メニュー・パネルで、十字キー／左スティックで選べる要素 */
const FOCUSABLE = '.ccard, [data-act], [data-tab], [data-id], [data-build], [data-upg], [data-mod], [data-pick], button:not([disabled]), input, select';

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
  /** 十字キーで選ぶ範囲（開いているパネル）。null なら画面に出ているメニューを探す */
  scope: (() => HTMLElement | null) | null = null;
  /** 選択中の要素（十字キーの選択） */
  focusEl: HTMLElement | null = null;
  private focusKey = '';
  private navT = 0;
  private navHeld = '';
  /** 最後に使ったのが十字キーの選択か、カーソルか */
  private useCursor = false;
  /** 選択を自動で決めた（まだ本人が動かしていない） */
  private focusAuto = true;
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

  /** このコントローラーのボタン表記 */
  glyphs(): Glyphs {
    return glyphsFor(this.resolve()?.id);
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
    [this.lx, this.ly] = radial(g.axes[0] ?? 0, g.axes[1] ?? 0);
    [this.rx, this.ry] = radial(g.axes[2] ?? 0, g.axes[3] ?? 0);
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

  // ---------------- メニュー・パネルの操作 ----------------
  //   十字キー／左スティック：選ぶ（明るい枠）・A 決定・X 右クリック・Y 捨てる・LB/RB タブ・B 戻る
  //   右スティック：自由に動くカーソル（マス目でない所を押したいとき）
  updateCursor(dt: number): void {
    const g = this.resolve();
    if (!g || this.gameplay) {
      if (this.cursor) this.cursor.style.display = 'none';
      this.setFocus(null);
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
    const scope = this.scope ? this.scope() : defaultScope();
    // 右スティック：カーソル
    if (this.rx || this.ry) {
      const sp = 900 * dt * (0.35 + 0.65 * Math.hypot(this.rx, this.ry));
      this.cx += this.rx * sp;
      this.cy += this.ry * sp;
      this.cursorShownAt = performance.now();
      this.useCursor = true;
    }
    this.cx = Math.max(r.left + 2, Math.min(r.right - 2, this.cx));
    this.cy = Math.max(r.top + 2, Math.min(r.bottom - 2, this.cy));
    // 十字キー・左スティック：選ぶ（押しっぱなしで連続）
    const dir = this.pressed.has(PAD.LEFT) ? 'L' : this.pressed.has(PAD.RIGHT) ? 'R' : this.pressed.has(PAD.UP) ? 'U' : this.pressed.has(PAD.DOWN) ? 'D' : '';
    const ax = Math.abs(this.lx) > 0.55 || Math.abs(this.ly) > 0.55 ? (Math.abs(this.lx) > Math.abs(this.ly) ? (this.lx > 0 ? 'R' : 'L') : this.ly > 0 ? 'D' : 'U') : '';
    const heldDir = this.held.has(PAD.LEFT) ? 'L' : this.held.has(PAD.RIGHT) ? 'R' : this.held.has(PAD.UP) ? 'U' : this.held.has(PAD.DOWN) ? 'D' : ax;
    let move = dir;
    if (!move && heldDir) {
      if (heldDir !== this.navHeld) {
        move = heldDir;
        this.navT = 0.38;
      } else {
        this.navT -= dt;
        if (this.navT <= 0) {
          move = heldDir;
          this.navT = 0.11;
        }
      }
    }
    if (dir) this.navT = 0.38;
    this.navHeld = heldDir;
    if (scope) {
      const items = focusables(scope);
      // 自動で選んだのが「閉じる」やタブなら、中身が描かれた時点で中身に移す
      const weak = (e: HTMLElement | null) => !e || e.classList.contains('x-btn') || !!e.dataset.tab;
      if (this.focusAuto && weak(this.focusEl) && items.some((e) => !weak(e))) this.setFocus(null);
      // 描き直しで要素が入れ替わっても、同じ物を選び続ける
      if (!this.focusEl || !this.focusEl.isConnected || !scope.contains(this.focusEl)) {
        this.focusAuto = !(this.focusKey && items.some((e) => keyOf(e) === this.focusKey));
        const again = this.focusKey ? items.find((e) => keyOf(e) === this.focusKey) : undefined;
        // 最初は中身（持ち物のマス・作成ボタン）を選ぶ。閉じるボタン（✕）やタブからは始めない
        this.setFocus(
          again ??
            // 設定画面などは、いま選ばれている項目から（A を押しても選択が変わらない）
            items.find((e) => e.dataset.pick !== undefined && e.classList.contains('on')) ??
            items.find((e) => e.dataset.act === 'cont') ??
            items.find((e) => e.dataset.act === 'bag') ??
            items.find((e) => e.classList.contains('ccard') && e.classList.contains('ready')) ??
            items.find((e) => e.classList.contains('ccard')) ??
            items.find((e) => e.dataset.id || e.dataset.build || e.dataset.upg || e.dataset.mod || e.dataset.pick) ??
            items.find((e) => !e.classList.contains('x-btn') && !e.dataset.tab) ??
            items[0] ??
            null,
        );
      }
      // スライダー（音量など）は、左右で値を変える
      const rng = this.focusEl instanceof HTMLInputElement && this.focusEl.type === 'range' ? this.focusEl : null;
      if (rng && (move === 'L' || move === 'R')) {
        const step = Number(rng.step) || Math.max(1, (Number(rng.max) - Number(rng.min)) / 20);
        rng.value = String(Number(rng.value) + (move === 'R' ? step : -step));
        rng.dispatchEvent(new Event('input', { bubbles: true }));
        rng.dispatchEvent(new Event('change', { bubbles: true }));
        move = '';
      }
      if (move && this.focusEl) {
        const next = nearestIn(this.focusEl, items, move);
        if (next) this.setFocus(next);
        this.useCursor = false;
        this.focusAuto = false;
      } else if (move && !this.focusEl && items[0]) this.setFocus(items[0]);
      // LB / RB：タブの切り替え
      if (this.pressed.has(PAD.LB) || this.pressed.has(PAD.RB)) {
        const tabs = [...scope.querySelectorAll<HTMLElement>('[data-tab]')].filter(visible);
        if (tabs.length) {
          const cur = Math.max(0, tabs.findIndex((t) => t.classList.contains('on') || t.classList.contains('active')));
          const t = tabs[(cur + (this.pressed.has(PAD.RB) ? 1 : -1) + tabs.length) % tabs.length];
          this.click(t, 0);
          this.setFocus(null);
          this.focusKey = '';
        }
      }
    } else this.setFocus(null);
    this.focusEl?.classList.toggle('pad-focus-cur', !this.useCursor);
    if (this.pressed.size) this.cursorShownAt = performance.now();
    // カーソルは右スティックを使ったときだけ見せる（十字キーで選んでいる間は選択の枠が目印）
    const showCursor = this.useCursor || !scope;
    this.cursor.style.display = showCursor ? 'block' : 'none';
    this.cursor.style.transform = `translate(${this.cx}px, ${this.cy}px)`;
    this.cursor.style.opacity = performance.now() - this.cursorShownAt < 6000 ? '1' : '0.35';
    const under = document.elementFromPoint(this.cx, this.cy) as HTMLElement | null;
    this.cursor.classList.toggle('over', !!under?.closest('button, a, input, label, [data-act], select'));
    const target = !showCursor || (!this.useCursor && this.focusEl) ? this.focusEl : under;
    if (!scope && !this.useCursor && (this.lx || this.ly)) {
      // メニューが見つからない画面では、左スティックもカーソル
      const sp = 900 * dt * (0.35 + 0.65 * Math.hypot(this.lx, this.ly));
      this.cx += this.lx * sp;
      this.cy += this.ly * sp;
    }
    if (this.pressed.has(PAD.A)) this.click(target, 0);
    if (this.pressed.has(PAD.X)) this.click(target, 2);
    if (this.pressed.has(PAD.Y)) {
      // Y：入れ物を開いているときは「全部取る」、それ以外は選んだ物を捨てる
      const all = scope?.querySelector<HTMLElement>('[data-act="takeall"]');
      if (all && visible(all)) this.click(all, 0);
      else if (target) this.click(target, 0, true);
    }
    if (this.pressed.has(PAD.B)) {
      if (this.onBack) this.onBack();
      else {
        // B：閉じる（Esc と同じ）
        window.dispatchEvent(new KeyboardEvent('keydown', { code: 'Escape', key: 'Escape', bubbles: true }));
        window.dispatchEvent(new KeyboardEvent('keyup', { code: 'Escape', key: 'Escape', bubbles: true }));
      }
    }
  }

  /** 選択を移す：明るい枠を付け、マウスを乗せたときと同じ説明を出す */
  private setFocus(el: HTMLElement | null): void {
    if (el === this.focusEl) return;
    this.focusEl?.classList.remove('pad-focus', 'pad-focus-cur');
    this.focusEl = el;
    if (!el) return;
    this.focusKey = keyOf(el);
    el.classList.add('pad-focus');
    el.style.setProperty('--pad-c', this.color);
    el.scrollIntoView?.({ block: 'nearest', inline: 'nearest' });
    const b = el.getBoundingClientRect();
    el.dispatchEvent(new MouseEvent('mouseover', { bubbles: true, clientX: b.x + b.width / 2, clientY: b.y + b.height / 2 }));
  }

  /** カーソルの位置を押す（0 = 左クリック、2 = 右クリック） */
  private click(el: HTMLElement | null, button: 0 | 2, shift = false): void {
    if (!el) return;
    // レシピなどのカードは、中の（押せる）ボタンを押す
    if (el.classList.contains('ccard')) {
      const b = el.querySelector<HTMLElement>('button:not([disabled])');
      if (!b) return;
      el = b;
    }
    const useFocus = el === this.focusEl && !this.useCursor;
    const bb = el.getBoundingClientRect();
    const x = useFocus ? bb.x + bb.width / 2 : this.cx;
    const y = useFocus ? bb.y + bb.height / 2 : this.cy;
    const o = { bubbles: true, cancelable: true, clientX: x, clientY: y, button, buttons: button === 0 ? 1 : 2, shiftKey: shift, view: window };
    el.dispatchEvent(new MouseEvent('mousedown', o));
    el.dispatchEvent(new MouseEvent('mouseup', o));
    // 文字の入力欄：コントローラーでは画面上のキーボードを出す
    if (button === 0 && el instanceof HTMLInputElement && (el.type === 'text' || el.type === '')) {
      osk().open(el, this.color);
      return;
    }
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
        <table class="pad-map"></table>
        <div class="pad-prefs"></div>
        <p class="pad-note">メニューや持ち物：十字キー／左スティックで選び（明るい枠）、決定・右クリック・捨てる・閉じるは右下の 4 つのボタン。LB/RB でタブ。右スティックで自由に動くカーソル。</p>
      </div>`;
    document.body.appendChild(this.el);
    this.list = this.el.querySelector('.pad-list') as HTMLDivElement;
    this.test = this.el.querySelector('.pad-test') as HTMLDivElement;
    this.el.addEventListener('click', (e) => {
      const t = e.target as HTMLElement;
      if (t === this.el || t.closest('[data-close]')) this.toggle(false);
      const pick = t.closest('[data-pick]') as HTMLElement | null;
      if (pick) gamepad.setChoice(pick.dataset.pick!);
      const rm = t.closest('[data-remap]') as HTMLElement | null;
      if (rm) this.startCapture(rm.dataset.remap as PadAction);
      if (t.closest('[data-remapreset]')) {
        padPrefs.map = {};
        savePadPrefs();
        this.render();
      }
      const tg = t.closest('[data-toggle]') as HTMLElement | null;
      if (tg) {
        padPrefs.toggle = tg.dataset.toggle === '1';
        savePadPrefs();
        this.render();
      }
      const as = t.closest('[data-assist]') as HTMLElement | null;
      const de = t.closest('[data-dead]') as HTMLElement | null;
      if (as || de) {
        if (as) padPrefs.assist = Number(as.dataset.assist);
        if (de) padPrefs.dead = Number(de.dataset.dead);
        savePadPrefs();
        this.render();
      }
    });
    window.addEventListener('keydown', (e) => {
      if (!this.open || e.code !== 'Escape') return;
      if (this.capture) this.endCapture();
      else this.toggle(false);
    });
    gamepad.onChange(() => this.render());
  }

  /** ボタンの割り当て：次に押されたボタンを、この操作に割り当てる */
  private capture: { id: PadAction; pad: number; base: Set<number>; t: number; wasSuspended: boolean } | null = null;
  private startCapture(id: PadAction): void {
    const g = gamepad.current();
    if (!g) {
      gamepad.toast('割り当てを変えるには、先にコントローラーを選んでください');
      return;
    }
    // 割り当て中はメニュー操作を止める（B で閉じたりしないように）
    const base = new Set(g.buttons.map((b, i) => (b.pressed || b.value > 0.5 ? i : -1)).filter((i) => i >= 0));
    this.capture = { id, pad: g.index, base, t: performance.now(), wasSuspended: gamepad.suspended };
    gamepad.suspended = true;
    this.render();
  }
  private endCapture(): void {
    if (!this.capture) return;
    gamepad.suspended = this.capture.wasSuspended;
    // 割り当てに使ったボタンが、閉じた直後にメニューで反応しないように
    gamepad.prime();
    this.capture = null;
    this.render();
  }
  private pollCapture(): void {
    const c = this.capture;
    if (!c) return;
    if (performance.now() - c.t > 6000) return this.endCapture();
    const g = (navigator.getGamepads ? navigator.getGamepads() : [])[c.pad];
    if (!g) return this.endCapture();
    for (let i = 0; i < Math.min(16, g.buttons.length); i++) {
      const on = g.buttons[i].pressed || g.buttons[i].value > 0.5;
      if (!on) {
        c.base.delete(i);
        continue;
      }
      if (c.base.has(i)) continue;
      if (REMAPPABLE.includes(i)) {
        remapPad(c.id, i);
        this.endCapture();
      }
      return;
    }
  }

  toggle(force?: boolean): void {
    if (this.capture && force === false) this.endCapture();
    this.open = force ?? !this.open;
    this.el.classList.toggle('hidden', !this.open);
    cancelAnimationFrame(this.raf);
    if (this.open) {
      this.render();
      const tick = () => {
        this.pollCapture();
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
    // ボタン表は、使っているコントローラーの表記で
    const g = glyphsFor(cur?.id);
    const fixed: [string, string, string, string][] = [
      ['左スティック', '移動', '右スティック', '照準（エイム補助つき）'],
      [`${g.RT}`, '射撃・建てる', `${g.LT}`, padPrefs.toggle ? '蘇生（押すたびに切り替え）' : '蘇生（長押し）'],
      [`${g.LB} / ${g.RB}`, '武器・建てる物の切り替え', '', ''],
    ];
    const cap = this.capture;
    const cell = (a: (typeof PAD_ACTIONS)[number]) =>
      `<td>${a.label}</td><th><button class="btn small ${cap?.id === a.id ? 'primary' : 'ghost'} pad-remap" data-remap="${a.id}">${cap?.id === a.id ? 'ボタンを押す…' : g[BTN_NAME[padBtn(a.id)]]}${padPrefs.map[a.id] !== undefined ? ' *' : ''}</button></th>`;
    let map = fixed.map((r) => `<tr><th>${r[0]}</th><td>${r[1]}</td><th>${r[2]}</th><td>${r[3]}</td></tr>`).join('');
    for (let i = 0; i < PAD_ACTIONS.length; i += 2) map += `<tr>${cell(PAD_ACTIONS[i])}${PAD_ACTIONS[i + 1] ? cell(PAD_ACTIONS[i + 1]) : ''}</tr>`;
    map += `<tr><td colspan="4" class="pad-remap-note">${cap ? '割り当てたいボタンを押してください（6 秒で取り消し）' : 'ボタンを選んで A → 割り当てたいボタンを押す（使っている操作とは入れ替え）'} <button class="btn small ghost" data-remapreset>元に戻す</button></td></tr>`;
    (this.el.querySelector('.pad-map') as HTMLElement).innerHTML = map;
    const lv = ['オフ', '弱', '中', '強'];
    (this.el.querySelector('.pad-prefs') as HTMLElement).innerHTML = `
      <div class="pad-pref"><span>エイム補助</span>${lv.map((n, i) => `<button class="btn small ${padPrefs.assist === i ? 'primary' : 'ghost'}" data-assist="${i}">${n}</button>`).join('')}</div>
      <div class="pad-pref"><span>長押し操作（蘇生）</span><button class="btn small ${padPrefs.toggle ? 'ghost' : 'primary'}" data-toggle="0">長押し</button><button class="btn small ${padPrefs.toggle ? 'primary' : 'ghost'}" data-toggle="1">押すたびに切り替え</button></div>
      <div class="pad-pref"><span>スティックの遊び</span>${[0.08, 0.14, 0.2, 0.28].map((d) => `<button class="btn small ${Math.abs(padPrefs.dead - d) < 0.01 ? 'primary' : 'ghost'}" data-dead="${d}">${d === 0.08 ? '小' : d === 0.14 ? 'やや小' : d === 0.2 ? '標準' : '大'}</button>`).join('')}</div>`;
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

if (import.meta.env?.DEV && typeof window !== 'undefined') Object.assign(window, { __pad: gamepad, __padPrefs: padPrefs });

// ---------------- 十字キーで選ぶ（空間ナビゲーション） ----------------
function visible(el: HTMLElement): boolean {
  const r = el.getBoundingClientRect();
  if (r.width < 4 || r.height < 4) return false;
  return !el.closest('.hidden') && getComputedStyle(el).visibility !== 'hidden';
}

function focusables(scope: HTMLElement): HTMLElement[] {
  const out: HTMLElement[] = [];
  for (const el of scope.querySelectorAll<HTMLElement>(FOCUSABLE)) {
    // ボタンの中の要素など、入れ子は外側だけ
    if (el.parentElement?.closest(FOCUSABLE) && scope.contains(el.parentElement.closest(FOCUSABLE))) continue;
    if ((el as HTMLButtonElement).disabled) continue;
    if (visible(el)) out.push(el);
  }
  return out;
}

/** 描き直しても同じ物を指す鍵 */
function keyOf(el: HTMLElement): string {
  const d = el.dataset;
  return [d.act, d.i, d.slot, d.tab, d.id, d.build, d.upg, d.mod, d.pick, d.remap, d.toggle, d.assist, d.dead, el.id, el.tagName === 'INPUT' ? 'in' : '', (el.textContent ?? '').trim().slice(0, 24)].join('|');
}

/** その方向で、いちばん近い要素（向きのずれは重く数える） */
function nearestIn(from: HTMLElement, items: HTMLElement[], dir: string): HTMLElement | null {
  const a = from.getBoundingClientRect();
  const ax = a.x + a.width / 2;
  const ay = a.y + a.height / 2;
  let best: HTMLElement | null = null;
  let bs = Infinity;
  for (const el of items) {
    if (el === from) continue;
    const b = el.getBoundingClientRect();
    const bx = b.x + b.width / 2;
    const by = b.y + b.height / 2;
    const dx = bx - ax;
    const dy = by - ay;
    const main = dir === 'R' ? dx : dir === 'L' ? -dx : dir === 'D' ? dy : -dy;
    // 横のずれは「辺と辺のすき間」（重なっていれば 0）：2 列に並んだボタンも、真下・真横として選べる
    const side = dir === 'R' || dir === 'L' ? Math.max(0, b.top - a.bottom, a.top - b.bottom) : Math.max(0, b.left - a.right, a.left - b.right);
    // 進む方向の「辺のすき間」も見る（大きな要素どうしでも近い順に）
    const gap = dir === 'R' ? b.left - a.right : dir === 'L' ? a.left - b.right : dir === 'D' ? b.top - a.bottom : a.top - b.bottom;
    if (main <= 4 || gap < -Math.min(a.width, a.height) * 0.5) continue;
    const score = Math.max(0, gap) + main * 0.15 + side * 2.5;
    if (score < bs) {
      bs = score;
      best = el;
    }
  }
  return best;
}

/** 画面に出ているメニュー（設定・準備画面・パネル・タイトル） */
function defaultScope(): HTMLElement | null {
  for (const sel of ['#osk:not(.hidden) .osk-card', '#pad-modal:not(.hidden) .pad-card', '#local-modal:not(.hidden) .lp-card', 'body > .modal:not(.hidden)', '.screen:not(.hidden)']) {
    const el = document.querySelector<HTMLElement>(sel);
    if (el && visible(el)) return el;
  }
  return null;
}

// ---------------- 画面上のキーボード（名前・ルームID をコントローラーで入力） ----------------
const OSK_PAGES: string[][] = [
  ['1234567890', 'ABCDEFGHIJ', 'KLMNOPQRST', 'UVWXYZ-_.!'],
  ['あいうえおかきくけこ', 'さしすせそたちつてと', 'なにぬねのはひふへほ', 'まみむめもやゆよらり', 'るれろわをんーゃゅょ', 'がぎぐげござじずぜぞ', 'だぢづでどばびぶべぼ', 'ぱぴぷぺぽっぁぃぅぇ'],
];
class OnScreenKeyboard {
  private el: HTMLDivElement;
  private target: HTMLInputElement | null = null;
  private page = 0;
  open = false;

  constructor() {
    this.el = document.createElement('div');
    this.el.id = 'osk';
    this.el.className = 'hidden';
    document.body.appendChild(this.el);
    this.el.addEventListener('click', (e) => {
      const b = (e.target as HTMLElement).closest('button') as HTMLButtonElement | null;
      if (!b || !this.target) return;
      const t = this.target;
      const k = b.dataset.k;
      if (k !== undefined) this.set(t.value + k);
      else if (b.dataset.cmd === 'bs') this.set(t.value.slice(0, -1));
      else if (b.dataset.cmd === 'sp') this.set(t.value + ' ');
      else if (b.dataset.cmd === 'page') {
        this.page = (this.page + 1) % OSK_PAGES.length;
        this.render();
      } else if (b.dataset.cmd === 'ok') this.close();
    });
    // Esc（コントローラーの B）で閉じる。ほかの画面の Esc より先に受け取る
    window.addEventListener(
      'keydown',
      (e) => {
        if (!this.open || e.code !== 'Escape') return;
        e.stopImmediatePropagation();
        this.close();
      },
      true,
    );
  }

  private set(v: string): void {
    const t = this.target!;
    const max = t.maxLength > 0 ? t.maxLength : 32;
    // ルームID のような英数字だけの欄は大文字に
    if (t.classList.contains('code-input')) v = v.toUpperCase().replace(/[^A-Z0-9]/g, '');
    t.value = v.slice(0, max);
    t.dispatchEvent(new Event('input', { bubbles: true }));
    (this.el.querySelector('.osk-val') as HTMLElement).textContent = t.value || ' ';
    (this.el.querySelector('.osk-head small') as HTMLElement).textContent = `${t.value.length}/${max}`;
  }

  openFor(t: HTMLInputElement, color: string): void {
    this.target = t;
    this.open = true;
    if (t.classList.contains('code-input')) this.page = 0;
    this.el.style.setProperty('--pad-c', color);
    this.el.classList.remove('hidden');
    this.render();
  }

  private render(): void {
    const t = this.target;
    if (!t) return;
    const code = t.classList.contains('code-input');
    const rows = OSK_PAGES[code ? 0 : this.page];
    const keys = rows.map((r) => `<div class="osk-row">${[...r].map((c) => `<button class="osk-k" data-k="${c}">${c}</button>`).join('')}</div>`).join('');
    this.el.innerHTML = `<div class="osk-card">
      <div class="osk-head"><span>${t.placeholder || '入力'}</span><b class="osk-val">${t.value || ' '}</b><small>${t.value.length}/${t.maxLength > 0 ? t.maxLength : 32}</small></div>
      ${keys}
      <div class="osk-row osk-cmd">${code ? '' : `<button data-cmd="page">${this.page === 0 ? 'かな' : '英数'}</button><button data-cmd="sp">空白</button>`}<button data-cmd="bs">⌫ 1文字消す</button><button data-cmd="ok" class="primary">決定</button></div>
    </div>`;
  }

  close(): void {
    this.open = false;
    this.el.classList.add('hidden');
    this.target = null;
  }
}
let oskInstance: OnScreenKeyboard | null = null;
function osk(): { open: (t: HTMLInputElement, color: string) => void } {
  if (!oskInstance) oskInstance = new OnScreenKeyboard();
  const k = oskInstance;
  return { open: (t, c) => k.openFor(t, c) };
}
