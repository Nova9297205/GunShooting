// ============================================================
// キーボード・マウス入力
// ============================================================

/** 押した瞬間だけ拾いたいキー */
const EDGE_CODES = ['KeyF', 'KeyR', 'KeyC', 'KeyQ', 'KeyH', 'KeyB', 'KeyM', 'KeyG', 'Escape', 'Tab', 'KeyT', 'KeyV', 'KeyX', 'F2', 'Digit1', 'Digit2', 'Digit3', 'Digit4', 'Digit5', 'Digit6', 'Digit7', 'Digit8', 'Digit9'];

export class InputController {
  private keys = new Set<string>();
  private edges = new Set<string>();
  // マウスを動かす前は画面の中央（左上の HUD に照準が重ならないように）
  mouseX = typeof window !== 'undefined' ? window.innerWidth / 2 : 0;
  mouseY = typeof window !== 'undefined' ? window.innerHeight / 2 : 0;
  mouseDown = false;
  /** 右ボタン押しっぱなし */
  altDown = false;
  private dashQueued = false;
  /** フレーム間で押して離した短いクリックも取りこぼさない */
  private clickQueued = false;
  /** ホイールで選択ツールを変える量（+1 / -1） */
  wheel = 0;
  /** タッチ操作：移動スティックの向き（-1..1）と、照準スティックを外側まで倒しているか */
  touchMove: { x: number; y: number } | null = null;
  touchFire = false;

  /** タッチのボタン：押した瞬間のキーとして渡す */
  press(code: string): void {
    this.edges.add(code);
  }

  /** タッチのボタン：押しっぱなしのキー（蘇生など） */
  setKey(code: string, down: boolean): void {
    if (down) this.keys.add(code);
    else this.keys.delete(code);
  }

  pressDash(): void {
    this.dashQueued = true;
  }

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
    if (this.touchMove) return { ...this.touchMove };
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

  private clickEdge = false;
  private altEdge = false;
  /** 左クリックの押した瞬間だけ（建設などで連打にならないように） */
  consumeClick(): boolean {
    const c = this.clickEdge;
    this.clickEdge = false;
    return c;
  }
  /** 右クリックの押した瞬間だけ */
  consumeAltClick(): boolean {
    const c = this.altEdge;
    this.altEdge = false;
    return c;
  }

  /** 左ボタンが押されている、またはこのフレームまでにクリックがあった */
  consumeFire(): boolean {
    const f = this.mouseDown || this.clickQueued || this.touchFire;
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
    if (e.code === 'Space' || e.code.startsWith('Arrow') || e.code === 'Tab' || e.code === 'F2') e.preventDefault();
  };

  private onKeyUp = (e: KeyboardEvent) => {
    this.keys.delete(e.code);
  };

  private onBlur = () => {
    this.keys.clear();
    this.mouseDown = false;
    this.altDown = false;
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
      this.clickEdge = true;
    }
    if (e.button === 2) {
      this.altDown = true;
      this.altEdge = true;
    }
    if (e.button === 1) {
      e.preventDefault();
      this.edges.add('KeyG'); // 中クリックでもピン
    }
    this.onMouseMove(e);
  };

  private onMouseUp = (e: MouseEvent) => {
    if (e.button === 0) this.mouseDown = false;
    if (e.button === 2) this.altDown = false;
  };

  private onWheel = (e: WheelEvent) => {
    e.preventDefault();
    this.wheel += e.deltaY > 0 ? 1 : -1;
  };

  private onContext = (e: Event) => e.preventDefault();
}
