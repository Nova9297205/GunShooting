// ============================================================
// キーボード・マウス入力
// ============================================================

/** 押した瞬間だけ拾いたいキー */
const EDGE_CODES = ['KeyF', 'KeyR', 'KeyC', 'KeyQ', 'KeyH', 'KeyB', 'Digit1', 'Digit2', 'Digit3', 'Digit4', 'Digit5', 'Digit6'];

export class InputController {
  private keys = new Set<string>();
  private edges = new Set<string>();
  mouseX = 0;
  mouseY = 0;
  mouseDown = false;
  private dashQueued = false;
  /** フレーム間で押して離した短いクリックも取りこぼさない */
  private clickQueued = false;
  /** ホイールで選択ツールを変える量（+1 / -1） */
  wheel = 0;

  constructor(private target: HTMLCanvasElement) {}

  attach(): void {
    window.addEventListener('keydown', this.onKeyDown);
    window.addEventListener('keyup', this.onKeyUp);
    window.addEventListener('blur', this.onBlur);
    this.target.addEventListener('mousemove', this.onMouseMove);
    this.target.addEventListener('mousedown', this.onMouseDown);
    window.addEventListener('mouseup', this.onMouseUp);
    this.target.addEventListener('contextmenu', this.onContext);
    this.target.addEventListener('wheel', this.onWheel, { passive: false });
  }

  detach(): void {
    window.removeEventListener('keydown', this.onKeyDown);
    window.removeEventListener('keyup', this.onKeyUp);
    window.removeEventListener('blur', this.onBlur);
    this.target.removeEventListener('mousemove', this.onMouseMove);
    this.target.removeEventListener('mousedown', this.onMouseDown);
    window.removeEventListener('mouseup', this.onMouseUp);
    this.target.removeEventListener('contextmenu', this.onContext);
    this.target.removeEventListener('wheel', this.onWheel);
    this.keys.clear();
    this.edges.clear();
    this.mouseDown = false;
  }

  getMove(): { x: number; y: number } {
    let x = 0;
    let y = 0;
    if (this.keys.has('KeyW') || this.keys.has('ArrowUp')) y -= 1;
    if (this.keys.has('KeyS') || this.keys.has('ArrowDown')) y += 1;
    if (this.keys.has('KeyA') || this.keys.has('ArrowLeft')) x -= 1;
    if (this.keys.has('KeyD') || this.keys.has('ArrowRight')) x += 1;
    if (x && y) {
      x *= Math.SQRT1_2;
      y *= Math.SQRT1_2;
    }
    return { x, y };
  }

  isDown(code: string): boolean {
    return this.keys.has(code);
  }

  /** 押した瞬間のキーを1回だけ取得 */
  consume(code: string): boolean {
    if (!this.edges.has(code)) return false;
    this.edges.delete(code);
    return true;
  }

  /** 左ボタンが押されている、またはこのフレームまでにクリックがあった */
  consumeFire(): boolean {
    const f = this.mouseDown || this.clickQueued;
    this.clickQueued = false;
    return f;
  }

  consumeDash(): boolean {
    const d = this.dashQueued;
    this.dashQueued = false;
    return d;
  }

  consumeWheel(): number {
    const w = this.wheel;
    this.wheel = 0;
    return w;
  }

  private onKeyDown = (e: KeyboardEvent) => {
    if ((e.target as HTMLElement)?.tagName === 'INPUT') return;
    if (!e.repeat) {
      if (e.code === 'ShiftLeft' || e.code === 'ShiftRight' || e.code === 'Space') this.dashQueued = true;
      if (EDGE_CODES.includes(e.code)) this.edges.add(e.code);
    }
    this.keys.add(e.code);
    if (e.code === 'Space' || e.code.startsWith('Arrow') || e.code === 'Tab') e.preventDefault();
  };

  private onKeyUp = (e: KeyboardEvent) => {
    this.keys.delete(e.code);
  };

  private onBlur = () => {
    this.keys.clear();
    this.mouseDown = false;
  };

  private onMouseMove = (e: MouseEvent) => {
    const r = this.target.getBoundingClientRect();
    this.mouseX = e.clientX - r.left;
    this.mouseY = e.clientY - r.top;
  };

  private onMouseDown = (e: MouseEvent) => {
    if (e.button === 0) {
      this.mouseDown = true;
      this.clickQueued = true;
    }
    this.onMouseMove(e);
  };

  private onMouseUp = (e: MouseEvent) => {
    if (e.button === 0) this.mouseDown = false;
  };

  private onWheel = (e: WheelEvent) => {
    e.preventDefault();
    this.wheel += e.deltaY > 0 ? 1 : -1;
  };

  private onContext = (e: Event) => e.preventDefault();
}
