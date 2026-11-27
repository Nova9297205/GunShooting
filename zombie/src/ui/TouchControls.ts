// ============================================================
// スマホ・タブレット用のタッチ操作
//   左半分：触れた場所に出る移動スティック
//   右半分：触れた場所に出る照準スティック（倒すと照準、外側まで倒すと射撃）
//   右端のボタン：ダッシュ・リロード・調べる・蘇生（長押し）・回復・食事・ピン・武器切替
//   キーボード・マウスの入力（InputController）に流し込むので、ゲーム側の処理は共通
// ============================================================
import type { InputController } from '../game/Input';

export const isTouchDevice = (): boolean =>
  typeof window !== 'undefined' && ('ontouchstart' in window || (window.matchMedia?.('(pointer: coarse)').matches ?? false));

interface Stick {
  id: number;
  ox: number;
  oy: number;
  dx: number;
  dy: number;
  base: HTMLDivElement;
  knob: HTMLDivElement;
}

const BUTTONS: { label: string; act: string; hold?: boolean }[] = [
  { label: 'ダッシュ', act: 'dash' },
  { label: 'リロード', act: 'KeyR' },
  { label: '調べる', act: 'KeyF' },
  { label: '蘇生', act: 'KeyE', hold: true },
  { label: '回復', act: 'KeyH' },
  { label: '食事', act: 'KeyQ' },
  { label: 'ピン', act: 'KeyG' },
  { label: '建設', act: 'KeyV' },
  { label: '武器', act: 'wheel' },
];

export class TouchControls {
  private root: HTMLDivElement;
  private move: Stick | null = null;
  private aim: Stick | null = null;
  private R = 56; // スティックの半径(px)

  constructor(private input: InputController) {
    this.root = document.createElement('div');
    this.root.id = 'touch';
    this.root.className = 'hidden';
    const btns = document.createElement('div');
    btns.className = 'tc-btns';
    for (const b of BUTTONS) {
      const el = document.createElement('button');
      el.className = 'tc-btn';
      el.textContent = b.label;
      el.addEventListener('touchstart', (e) => {
        e.preventDefault();
        e.stopPropagation();
        el.classList.add('on');
        if (b.act === 'dash') this.input.pressDash();
        else if (b.act === 'wheel') this.input.wheel += 1;
        else if (b.hold) this.input.setKey(b.act, true);
        else this.input.press(b.act);
      });
      const up = (e: TouchEvent) => {
        e.preventDefault();
        el.classList.remove('on');
        if (b.hold) this.input.setKey(b.act, false);
      };
      el.addEventListener('touchend', up);
      el.addEventListener('touchcancel', up);
      btns.append(el);
    }
    this.root.append(btns);
    document.body.append(this.root);
    // スティックは画面全体（HUD のボタン以外）で受ける
    this.root.addEventListener('touchstart', this.onStart, { passive: false });
    window.addEventListener('touchmove', this.onMove, { passive: false });
    window.addEventListener('touchend', this.onEnd, { passive: false });
    window.addEventListener('touchcancel', this.onEnd, { passive: false });
  }

  private shown = false;
  show(on: boolean): void {
    if (on === this.shown) return;
    this.shown = on;
    this.root.classList.toggle('hidden', !on);
    if (!on) this.reset();
  }

  destroy(): void {
    this.reset();
    window.removeEventListener('touchmove', this.onMove);
    window.removeEventListener('touchend', this.onEnd);
    window.removeEventListener('touchcancel', this.onEnd);
    this.root.remove();
  }

  private reset(): void {
    for (const s of [this.move, this.aim]) s?.base.remove();
    this.move = null;
    this.aim = null;
    this.input.touchMove = null;
    this.input.touchFire = false;
  }

  private makeStick(id: number, x: number, y: number, cls: string): Stick {
    const base = document.createElement('div');
    base.className = `tc-stick ${cls}`;
    base.style.left = `${x}px`;
    base.style.top = `${y}px`;
    const knob = document.createElement('div');
    knob.className = 'tc-knob';
    base.append(knob);
    this.root.append(base);
    return { id, ox: x, oy: y, dx: 0, dy: 0, base, knob };
  }

  private onStart = (e: TouchEvent): void => {
    if ((e.target as HTMLElement).closest('.tc-btn')) return;
    e.preventDefault();
    for (const t of Array.from(e.changedTouches)) {
      const left = t.clientX < window.innerWidth / 2;
      if (left && !this.move) this.move = this.makeStick(t.identifier, t.clientX, t.clientY, 'move');
      else if (!left && !this.aim) this.aim = this.makeStick(t.identifier, t.clientX, t.clientY, 'aim');
    }
  };

  private onMove = (e: TouchEvent): void => {
    if (!this.move && !this.aim) return;
    for (const t of Array.from(e.changedTouches)) {
      const s = this.move?.id === t.identifier ? this.move : this.aim?.id === t.identifier ? this.aim : null;
      if (!s) continue;
      e.preventDefault();
      let dx = t.clientX - s.ox;
      let dy = t.clientY - s.oy;
      const l = Math.hypot(dx, dy);
      if (l > this.R) {
        dx = (dx / l) * this.R;
        dy = (dy / l) * this.R;
      }
      s.dx = dx / this.R;
      s.dy = dy / this.R;
      s.knob.style.transform = `translate(${dx}px, ${dy}px)`;
      if (s === this.move) {
        const m = Math.hypot(s.dx, s.dy);
        this.input.touchMove = m > 0.15 ? { x: s.dx, y: s.dy } : null;
      } else {
        const m = Math.hypot(s.dx, s.dy);
        if (m > 0.2) {
          // 照準：画面中央（自分のいる辺り）から倒した方向へ
          this.input.mouseX = window.innerWidth / 2 + s.dx * 260;
          this.input.mouseY = window.innerHeight / 2 + s.dy * 260;
        }
        // 外側まで倒すと撃つ
        this.input.touchFire = m > 0.75;
        s.base.classList.toggle('firing', m > 0.75);
      }
    }
  };

  private onEnd = (e: TouchEvent): void => {
    for (const t of Array.from(e.changedTouches)) {
      if (this.move?.id === t.identifier) {
        this.move.base.remove();
        this.move = null;
        this.input.touchMove = null;
      } else if (this.aim?.id === t.identifier) {
        this.aim.base.remove();
        this.aim = null;
        this.input.touchFire = false;
      }
    }
  };
}
