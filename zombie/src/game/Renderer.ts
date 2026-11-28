// ============================================================
// Renderer: カメラ・マップ・夜の暗闇＆懐中電灯ライティング・建築グリッド・HUD・ミニマップ
//   見た目（キャラ・オブジェクト）の描画は Art.ts の ArtSet に委譲している
// ============================================================
import type { GameMode, ObjSnap, PlayerSnap, VehicleSnap, ViewState, WeaponId, ZombieSnap } from '../types';
import { Tool } from '../types';
import { type ArtSet, type PlayerAnim, type TallQuery, VectorArt, type ZombieAnim } from './Art';
import {
  CHUNK,
  CHUNKS_X,
  CHUNKS_Y,
  BASE_TX,
  BASE_TY,
  CYCLE_SECONDS,
  INDOOR_FLOORS,
  MELEE_STATS,
  type MeleeId,
  DAY_SECONDS,
  MAP_H,
  MAP_W,
  PLAYER,
  PLAYER_COLORS,
  SAFEHOUSE,
  T_BRIDGE,
  T_ROAD,
  T_SHALLOW,
  T_WALL,
  T_WATER,
  T_WINDOW,
  TILE,
  TORCH_LIGHT,
  SLOTS,
  USABLE_SLOTS,
  WORLD_H,
  WORLD_W,
  ZOMBIE,
  BUILD_KINDS,
  BUILDS,
  type BuildKind,
} from './constants';
import type { Decal, Effects } from './Effects';
import { clamp } from './physics';
import { type Viewer, Vision } from './vision';
import { locationAt, type TileWorld } from './world';
import { roofCanvas } from './RoofArt';
import type { TerrainCache } from './TerrainArt';
import { DISTRICT_INFO, districtAt, directionName, EDGE_BAND, edgeDistance, TIER_RINGS, tierAtDistance } from './world';
import { skillMods } from './progression';
import { type Glyphs, padText } from '../ui/Gamepad';
import { TUT_ALL, TUT_STEPS as TUT_STEPS1, TUT2_ALL, TUT2_STEPS } from './tutorial';
import { ATTACHMENTS, capacityOf, CONTAINER_NAMES, countItem, loadKg, QUALITY, weaponLabel, effectiveStats, heldWeapon, ITEMS, type ItemId, WEAPON_STATS as WEAPONS } from './items';
import { CONTAINER_KINDS } from './Engine';

/** 落ち影と側面を持つ「高い」建築物 */
const WALL_KINDS: ReadonlySet<ObjSnap['kind']> = new Set<ObjSnap['kind']>(['stone', 'woodWall', 'ironWall']);

export interface RenderOptions {
  localId: number;
  mode: GameMode;
  roomCode?: string;
  effects: Effects;
  dt: number;
  mouseX: number;
  mouseY: number;
  /** ゲスト自機は射撃/近接アニメをローカルで発生させるので、カウンタ検出をしない */
  skipAnimDetectId: number | null;
  localTool: number;
  /** 全体地図を開いているか（B キー） */
  mapOpen?: boolean;
  /** 持ち物・作業台などのパネルを開いているか（照準や大きな通知を出さない） */
  panelOpen?: boolean;
  reviveHint: boolean;
  interactHint: string | null;
  syncMs?: number;
  muted?: boolean;
  /** 建設モード：置く場所と、置けない理由 */
  build?: { kind: BuildKind; tx: number; ty: number; err: string | null } | null;
  /** タッチ操作の端末 */
  touch?: boolean;
  /** コントローラーで遊んでいる */
  pad?: boolean;
  /** そのコントローラーのボタン表記（Xbox / PlayStation） */
  glyphs?: Glyphs | null;
}

/** 射撃・近接・リロードを検出したときに呼ばれるフック（効果音用） */
/** プレイヤーが手に持っている射撃武器 */
export function weaponOfSnap(p: PlayerSnap): WeaponId {
  return heldWeapon(p)?.id ?? 'pistol';
}

export interface AnimHooks {
  shot(p: PlayerSnap, w: WeaponId): void;
  swing(p: PlayerSnap): void;
  reload(p: PlayerSnap): void;
}

/**
 * 時刻ごとの環境光キーフレーム [分, 暗さ, 色味R, G, B, 色味の強さ]
 * 朝焼け → 昼 → 夕方の黄金色 → 夕焼け → 紫の薄暮 → 青い夜 と色温度が変化する
 */
const AMBIENT: [number, number, number, number, number, number][] = [
  [0, 0.92, 70, 90, 160, 0.3],
  [300, 0.9, 80, 90, 170, 0.3],
  [360, 0.62, 255, 140, 120, 0.22], // 夜明け（ピンク）
  [420, 0.15, 255, 190, 140, 0.14],
  [480, 0, 255, 235, 210, 0.04],
  [900, 0, 255, 245, 230, 0.02], // 昼
  [990, 0, 255, 200, 120, 0.1], // 午後の黄金色
  [1080, 0.08, 255, 150, 70, 0.2], // 夕焼け
  [1150, 0.42, 200, 100, 120, 0.24],
  [1200, 0.72, 120, 90, 170, 0.28], // 紫の薄暮
  [1260, 0.92, 70, 90, 160, 0.3], // 夜
  [1440, 0.92, 70, 90, 160, 0.3],
];

export function ambientAt(m: number): { dark: number; r: number; g: number; b: number; a: number } {
  for (let i = 0; i < AMBIENT.length - 1; i++) {
    const k0 = AMBIENT[i];
    const k1 = AMBIENT[i + 1];
    if (m >= k0[0] && m <= k1[0]) {
      const t = (m - k0[0]) / (k1[0] - k0[0] || 1);
      const L = (j: number) => k0[j] + (k1[j] - k0[j]) * t;
      return { dark: L(1), r: L(2), g: L(3), b: L(4), a: L(5) };
    }
  }
  return { dark: 0.92, r: 70, g: 90, b: 160, a: 0.3 };
}

/** 時刻（分）から暗さ 0..1 を求める */
export function darknessAt(m: number): number {
  return ambientAt(m).dark;
}

export function formatClock(m: number): string {
  const h = Math.floor(m / 60) % 24;
  const mm = Math.floor(m % 60);
  return `${String(h).padStart(2, '0')}:${String(mm).padStart(2, '0')}`;
}

/** 精鋭の特性の名前 */
const TRAIT_NAME = { dash: '突進', regen: '再生', split: '分裂', armor: '重装' } as const;
const NPC_ROLE: Record<string, string> = { cook: '料理人', gunsmith: '銃職人', nurse: '看護師', scav: '回収屋' };

export class Renderer {
  art: ArtSet = new VectorArt();
  private ctx: CanvasRenderingContext2D;
  w = 0;
  h = 0;
  private dpr = 1;
  cam = { x: WORLD_W / 2, y: WORLD_H / 2 };
  private camInit = false;
  private time = 0;
  private terrain: TerrainCache | null = null;
  private miniCanvas: HTMLCanvasElement | null = null;
  private vision = new Vision();
  /** その位置が自分（と仲間）の視界に入っているか（エイム補助用） */
  canSee(x: number, y: number): boolean {
    return this.vision.isVisible(x, y);
  }
  private lightCanvas = document.createElement('canvas');
  private lightCtx = this.lightCanvas.getContext('2d')!;
  private pAnim = new Map<number, PlayerAnim>();
  private zAnim = new Map<number, ZombieAnim>();
  private lastReload = new Map<number, number>();
  hooks: AnimHooks | null = null;
  private fx: Effects | null = null;
  private localId = -1;
  /** 照準の広がり（連射で広がる） */
  private bloom = 0;
  private forest: CanvasPattern | null = null;
  private curLoc: string | null = null;
  private locToast: { text: string; sub: string; sub2?: string; color: string; life: number; kicker?: string } | null = null;

  // ---- 軽量化 ----
  /** HUD のパネル類（時計・チーム・ステータス・ホットバー・ミニマップ）は別キャンバスに描き、約15Hzで更新 */
  private hudCanvas: HTMLCanvasElement;
  /** 毎フレーム描き直す HUD（照準・バナー・ヒント・矢印・ログ） */
  private fastCanvas: HTMLCanvasElement;
  private fastCtx: CanvasRenderingContext2D;
  private hudCtx: CanvasRenderingContext2D;
  private hudT = 0;
  private hudKey = '';
  /** 画面の色調とフィルムグレインは CSS（GPUで合成）で行う */
  private grainEl: HTMLDivElement;
  /** 描画解像度の倍率（重いPCでは自動で下げる） */
  renderScale = 1;
  /** CSS の重ね合わせ（色温度の乗算・周辺減光・追跡時の赤・被弾の赤） */
  private ov: Record<'tint' | 'vig' | 'alert' | 'hurt' | 'tox', HTMLDivElement>;
  private ovCache: Record<string, string> = {};
  private baseDpr = 1;
  private fpsAvg = 60;
  /** 直前のフレームの描画時間の内訳（ms）と描画数（パフォーマンス表示用） */
  perfT = { world: 0, light: 0, over: 0, hud: 0 };
  perfN = { objects: 0, zombiesDrawn: 0, particles: 0 };
  private qTimer = 0;

  /**
   * @param root 画面分割（ローカル協力）のときの表示枠。指定すると HUD・色調の重ね合わせもこの枠の中に作り、枠の大きさで描く
   */
  constructor(
    private canvas: HTMLCanvasElement,
    private world: TileWorld,
    private root: HTMLElement | null = null,
  ) {
    this.ctx = canvas.getContext('2d')!;
    // 枠の中では、同じ見た目（CSS）を使うため同じ id の要素を枠ごとに作る（探すのは枠の中だけ）
    const parent: HTMLElement = root ?? document.body;
    const find = <T extends HTMLElement>(id: string) => (root ? (root.querySelector(`#${id}`) as T | null) : (document.getElementById(id) as T | null));
    this.hudCanvas = find<HTMLCanvasElement>('hud') ?? document.createElement('canvas');
    if (!this.hudCanvas.id) {
      this.hudCanvas.id = 'hud';
      parent.insertBefore(this.hudCanvas, canvas.nextSibling);
    }
    this.hudCtx = this.hudCanvas.getContext('2d')!;
    this.fastCanvas = find<HTMLCanvasElement>('hud-fx') ?? document.createElement('canvas');
    if (!this.fastCanvas.id) {
      this.fastCanvas.id = 'hud-fx';
      parent.insertBefore(this.fastCanvas, this.hudCanvas.nextSibling);
    }
    this.fastCtx = this.fastCanvas.getContext('2d')!;
    this.grainEl = find<HTMLDivElement>('fx-grain') ?? document.createElement('div');
    if (!this.grainEl.id) {
      this.grainEl.id = 'fx-grain';
      parent.insertBefore(this.grainEl, this.hudCanvas);
    }
    this.grainEl.style.backgroundImage = `url(${makeGrainURL()})`;
    const mk = (id: string) => {
      let el = find<HTMLDivElement>(id);
      if (!el) {
        el = document.createElement('div');
        el.id = id;
        el.className = 'fx-ov';
        parent.insertBefore(el, this.grainEl);
      }
      return el;
    };
    this.ov = { tint: mk('fx-tint'), vig: mk('fx-vig'), alert: mk('fx-alert'), hurt: mk('fx-hurt'), tox: mk('fx-tox') };
    this.setActive(true);
    this.resize();
    this.bakeTerrain();
  }

  /** ゲーム中だけ HUD キャンバス・色調フィルター・グレインを有効にする */
  setActive(on: boolean): void {
    for (const el of Object.values(this.ov ?? {})) el.classList.toggle('hidden', !on);
    this.hudCanvas.classList.toggle('hidden', !on);
    this.fastCanvas.classList.toggle('hidden', !on);
    this.grainEl.classList.toggle('hidden', !on);
    this.canvas.classList.toggle('fx', on);
  }

  destroy(): void {
    this.setActive(false);
    this.hudCtx.clearRect(0, 0, this.hudCanvas.width, this.hudCanvas.height);
    this.fastCtx.clearRect(0, 0, this.fastCanvas.width, this.fastCanvas.height);
  }

  /** CSS の重ね合わせのスタイルを（変わったときだけ）更新 */
  private setOv(k: 'tint' | 'vig' | 'alert' | 'hurt' | 'tox', prop: 'opacity' | 'backgroundColor', v: string): void {
    const key = k + prop;
    if (this.ovCache[key] === v) return;
    this.ovCache[key] = v;
    this.ov[k].style[prop] = v;
  }

  /** フレームレートを見て描画解像度を自動調整（落ち続けたら下げ、余裕が続けば戻す） */
  private autoQuality(dt: number): void {
    if (dt <= 0 || dt > 0.5) return;
    this.fpsAvg += (1 / dt - this.fpsAvg) * Math.min(1, dt * 2);
    this.qTimer += dt;
    if (this.fpsAvg < 45 && this.qTimer > 2.5 && this.renderScale > 0.6) {
      this.renderScale = Math.max(0.6, this.renderScale - 0.15);
      this.qTimer = 0;
      this.resize();
    } else if (this.fpsAvg > 57 && this.qTimer > 6 && this.renderScale < 1) {
      this.renderScale = Math.min(1, this.renderScale + 0.15);
      this.qTimer = 0;
      this.resize();
    } else if (this.qTimer > 6) this.qTimer = 0;
  }

  /** パフォーマンス表示用：解像度と地形キャッシュ */
  perfInfo(): { res: string; terrain: string } {
    const t = this.terrain;
    return {
      res: `${this.canvas.width}×${this.canvas.height}（倍率 ${this.dpr.toFixed(2)} / 自動調整 ${Math.round(this.renderScale * 100)}%）`,
      terrain: t ? `${t.size}/24 焼込 ${t.stats.baked}` : '-',
    };
  }

  /** HUD の縮小率（スマホなど小さい画面では 1 未満） */
  uiScale = 1;

  /** HUD の要素を縮小して描く（仮想的な画面の大きさで配置される） */
  /** 車：車体・窓・タイヤ・乗っている人の頭・壊れているときの煙 */
  private drawVehicle(v: VehicleSnap, view: ViewState): void {
    const { ctx } = this;
    const pickup = v.kind === 'pickup';
    const L = pickup ? 64 : 58;
    const W = pickup ? 32 : 30;
    ctx.save();
    ctx.translate(v.x, v.y);
    ctx.rotate(v.a);
    // 影
    ctx.fillStyle = 'rgba(0,0,0,0.35)';
    ctx.fillRect(-L / 2 + 5, -W / 2 + 6, L, W);
    // タイヤ
    ctx.fillStyle = '#151513';
    for (const [tx, ty] of [[L / 2 - 14, -W / 2 - 2], [L / 2 - 14, W / 2 - 4], [-L / 2 + 8, -W / 2 - 2], [-L / 2 + 8, W / 2 - 4]]) ctx.fillRect(tx, ty, 11, 6);
    // 車体
    const body = v.broken ? (pickup ? '#5b4a3a' : '#4a4e56') : pickup ? '#a0522d' : '#3d6e9e';
    const hi = v.broken ? (pickup ? '#6e5c4a' : '#5a5f68') : pickup ? '#c06a3c' : '#5a8cbc';
    ctx.fillStyle = body;
    ctx.beginPath();
    ctx.roundRect(-L / 2, -W / 2, L, W, 6);
    ctx.fill();
    ctx.fillStyle = hi;
    ctx.fillRect(-L / 2 + 3, -W / 2 + 2, L - 6, 3);
    if (pickup) {
      // 荷台
      ctx.fillStyle = 'rgba(0,0,0,0.28)';
      ctx.fillRect(-L / 2 + 3, -W / 2 + 4, L * 0.38, W - 8);
    }
    // 窓
    ctx.fillStyle = v.broken ? '#2a2e30' : '#9cc4d8';
    const wx = pickup ? 2 : -6;
    ctx.fillRect(wx + 8, -W / 2 + 4, 8, W - 8);
    ctx.fillStyle = v.broken ? '#24282a' : '#6c94a8';
    ctx.fillRect(wx - 14, -W / 2 + 4, 6, W - 8);
    if (v.broken) {
      // ひび
      ctx.strokeStyle = 'rgba(255,255,255,0.35)';
      ctx.beginPath();
      ctx.moveTo(wx + 9, -6);
      ctx.lineTo(wx + 14, 2);
      ctx.lineTo(wx + 10, 8);
      ctx.stroke();
    }
    // ライト
    const night = darknessAt(view.minute) > 0.3;
    const driven = v.seats[0] >= 0 && !v.broken;
    ctx.fillStyle = driven ? '#fff6c0' : '#c8c0a0';
    ctx.fillRect(L / 2 - 3, -W / 2 + 3, 3, 6);
    ctx.fillRect(L / 2 - 3, W / 2 - 9, 3, 6);
    ctx.fillStyle = v.spd < -5 ? '#ff4030' : '#7a2018';
    ctx.fillRect(-L / 2, -W / 2 + 3, 2, 5);
    ctx.fillRect(-L / 2, W / 2 - 8, 2, 5);
    if (driven && night) {
      const g = ctx.createRadialGradient(L / 2 + 40, 0, 4, L / 2 + 70, 0, 120);
      g.addColorStop(0, 'rgba(255,245,200,0.28)');
      g.addColorStop(1, 'rgba(255,245,200,0)');
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.moveTo(L / 2, -8);
      ctx.lineTo(L / 2 + 170, -70);
      ctx.lineTo(L / 2 + 170, 70);
      ctx.lineTo(L / 2, 8);
      ctx.fill();
    }
    // 乗っている人の頭
    v.seats.forEach((id, i) => {
      if (id < 0) return;
      const sp = [[4, -8], [4, 8], [-14, 0]][i];
      ctx.fillStyle = '#15170f';
      ctx.beginPath();
      ctx.arc(sp[0], sp[1], 6.5, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = PLAYER_COLORS[id] ?? '#fff';
      ctx.beginPath();
      ctx.arc(sp[0], sp[1], 5, 0, Math.PI * 2);
      ctx.fill();
    });
    ctx.restore();
    // 傷んでいると煙
    if (this.fx && (v.broken || v.hp < v.maxHp * 0.4) && Math.random() < 0.25) this.fx.burst(v.x + Math.cos(v.a) * 22, v.y + Math.sin(v.a) * 22, v.broken ? '#3a3a3a' : '#777', 1, 30, 1.6, 7, 'smoke', false, -Math.PI / 2, 1);
    // 壊れている：直せることを示す
    if (v.broken && Math.sin(this.time * 3 + v.id) > 0) {
      ctx.font = `bold 11px ${UI}`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillStyle = 'rgba(20,16,10,0.8)';
      ctx.fillRect(v.x - 30, v.y - 40, 60, 16);
      ctx.fillStyle = '#e0a33a';
      ctx.fillText('🔧 修理可', v.x, v.y - 32);
    }
  }

  /** 運転中のメーター（速さ・燃料・車体） */
  private drawVehiclePanel(v: VehicleSnap, driver: boolean): void {
    const { ctx } = this;
    const pw = 300;
    const ph = 44;
    const x = this.w / 2 - pw / 2;
    const y = this.h - 150;
    panel(ctx, x, y, pw, ph);
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'left';
    ctx.font = `10px ${MONO}`;
    ctx.fillStyle = '#8ac0e0';
    ctx.fillText(`// ${v.kind === 'pickup' ? 'PICKUP' : 'SEDAN'} ${driver ? 'DRIVER' : 'PASSENGER'}`, x + 10, y + 11);
    ctx.textAlign = 'right';
    ctx.font = `bold 16px ${MONO}`;
    ctx.fillStyle = '#e6e1cc';
    ctx.fillText(`${Math.round(Math.abs(v.spd) * 0.15)}`, x + pw - 40, y + 26);
    ctx.font = `9px ${MONO}`;
    ctx.fillStyle = '#9c967c';
    ctx.fillText('km/h', x + pw - 10, y + 27);
    const bar = (label: string, by: number, r: number, c: string) => {
      ctx.textAlign = 'left';
      ctx.font = `bold 10px ${UI}`;
      ctx.fillStyle = '#bdb79e';
      ctx.fillText(label, x + 10, by);
      segBar(ctx, x + 44, by - 4, 150, 7, clamp(r, 0, 1), c, 15);
    };
    bar('燃料', y + 24, v.fuel / 100, v.fuel < 20 ? '#d0583e' : '#e0b862');
    bar('車体', y + 36, v.hp / v.maxHp, v.hp / v.maxHp < 0.3 ? '#d0583e' : '#93b77c');
  }

  /** 建設モード：拠点の敷地の枠・置く場所の緑/赤の影・建てた物の耐久 */
  private drawBuildGhost(b: NonNullable<RenderOptions['build']>, visible: ObjSnap[]): void {
    const { ctx } = this;
    const sh = SAFEHOUSE;
    ctx.save();
    ctx.setLineDash([8, 6]);
    ctx.lineDashOffset = -this.time * 20;
    ctx.strokeStyle = 'rgba(224,163,58,0.55)';
    ctx.lineWidth = 2;
    ctx.strokeRect(sh.x * TILE + 1, sh.y * TILE + 1, sh.w * TILE - 2, sh.h * TILE - 2);
    ctx.setLineDash([]);
    // 建てた物の耐久バー
    for (const ob of visible) {
      if (!BUILD_KINDS.has(ob.kind)) continue;
      const r = ob.hp / ob.maxHp;
      ctx.fillStyle = 'rgba(0,0,0,0.6)';
      ctx.fillRect(ob.tx * TILE + 4, ob.ty * TILE - 6, TILE - 8, 4);
      ctx.fillStyle = r > 0.6 ? '#93b77c' : r > 0.3 ? '#e0a33a' : '#d0583e';
      ctx.fillRect(ob.tx * TILE + 4, ob.ty * TILE - 6, (TILE - 8) * r, 4);
    }
    const x = b.tx * TILE;
    const y = b.ty * TILE;
    const ok = !b.err;
    ctx.globalAlpha = 0.55 + Math.sin(this.time * 6) * 0.1;
    const ghost: ObjSnap = { id: 0, kind: b.kind, tx: b.tx, ty: b.ty, hp: 1, maxHp: 1, ready: 0 };
    if (!this.art.drawLowObject(ctx, ghost, this.time, () => false)) this.art.drawTallObject(ctx, ghost, this.time);
    ctx.globalAlpha = 1;
    ctx.fillStyle = ok ? 'rgba(120,220,120,0.22)' : 'rgba(230,80,60,0.25)';
    ctx.fillRect(x, y, TILE, TILE);
    ctx.strokeStyle = ok ? '#8fe08a' : '#e0583e';
    ctx.lineWidth = 2;
    ctx.strokeRect(x + 1, y + 1, TILE - 2, TILE - 2);
    if (b.err) {
      ctx.font = `bold 12px ${UI}`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'bottom';
      const tw = ctx.measureText(b.err).width + 12;
      ctx.fillStyle = 'rgba(20,10,8,0.85)';
      ctx.fillRect(x + TILE / 2 - tw / 2, y - 24, tw, 18);
      ctx.fillStyle = '#ef8a70';
      ctx.fillText(b.err, x + TILE / 2, y - 9);
    }
    ctx.restore();
  }

  /** 建設モードの選択バー（画面下） */
  private drawBuildBar(view: ViewState, b: NonNullable<RenderOptions['build']>, me: PlayerSnap, touch: boolean): void {
    const { ctx } = this;
    const n = BUILDS.length;
    const cols = Math.min(n, 5);
    const rows = Math.ceil(n / cols);
    const cw = 108;
    const gap = 6;
    const W = cols * cw + (cols - 1) * gap;
    const x0 = this.w / 2 - W / 2;
    const y0 = this.h - 140 - rows * 72;
    const shared = view.storage?.shared ?? [];
    ctx.save();
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'center';
    ctx.font = `bold 12px ${UI}`;
    ctx.fillStyle = '#e0a33a';
    ctx.fillText(
      this.glyphs ? padText('建設モード — {LB}/{RB} 選ぶ・右スティックで場所・{RT} 建てる・{@reload} 撤去・{@use} 修理・{@build} 終了', this.glyphs) : touch ? '建設モード — [武器] 選ぶ・右スティックで向けて撃つ＝建てる・[建設] 終了' : '建設モード — [1〜9,0]/ホイール 選択・左クリック 建てる・右クリック 撤去・[F] 修理・[V]/Esc 終了',
      this.w / 2,
      y0 - 12,
    );
    BUILDS.forEach((d, i) => {
      const x = x0 + (i % cols) * (cw + gap);
      const yy = y0 + Math.floor(i / cols) * 72;
      const sel = d.kind === b.kind;
      const lock = (d.lv ?? 1) > (view.base.bench ?? 1);
      panel(ctx, x, yy, cw, 66, sel ? 'rgba(60,48,22,0.92)' : undefined, sel ? '#e0a33a' : undefined);
      ctx.textAlign = 'left';
      ctx.font = `bold 11px ${UI}`;
      ctx.fillStyle = lock ? '#77735f' : sel ? '#ffe0a0' : '#d8d2b8';
      ctx.fillText(i < 10 ? `${(i + 1) % 10} ${d.name}` : d.name, x + 8, yy + 12);
      ctx.font = `9px ${UI}`;
      ctx.fillStyle = '#9c967c';
      ctx.fillText(lock ? `🔒 作業台Lv${d.lv}` : d.role, x + 8, yy + 26);
      // 素材（1行に収まらなければ2行目へ）
      let cx = x + 8;
      let cy = yy + 40;
      ctx.font = `9px ${UI}`;
      for (const [m, need] of Object.entries(d.cost) as [ItemId, number][]) {
        const have = countItem(me.bag, m) + countItem(shared, m);
        const t = `${ITEMS[m].name} ${have}/${need}`;
        const tw = ctx.measureText(t).width;
        if (cx + tw > x + cw - 6 && cx > x + 8) {
          cx = x + 8;
          cy += 13;
        }
        ctx.fillStyle = have >= need ? '#93b77c' : '#d0583e';
        ctx.fillText(t, cx, cy);
        cx += tw + 7;
      }
    });
    ctx.restore();
  }

  private withUiScale(fn: () => void): void {
    const s = this.uiScale;
    if (s >= 0.999) return fn();
    const { ctx } = this;
    const w = this.w;
    const h = this.h;
    ctx.save();
    ctx.scale(s, s);
    this.w = w / s;
    this.h = h / s;
    try {
      fn();
    } finally {
      this.w = w;
      this.h = h;
      ctx.restore();
    }
  }

  resize(): void {
    this.baseDpr = Math.min(window.devicePixelRatio || 1, 2);
    // ゲーム画面は最大1.5倍（高解像度ディスプレイで描くピクセル数を抑える）。HUD は baseDpr のままくっきり
    this.dpr = Math.min(this.baseDpr, 1.5) * this.renderScale;
    this.w = this.root ? this.root.clientWidth : window.innerWidth;
    this.h = this.root ? this.root.clientHeight : window.innerHeight;
    // 画面分割の枠は小さいので縮めすぎない（文字が読めなくなる）。入りきらない分は HUD を簡略表示にする
    this.uiScale = clamp(Math.min(this.w / 1280, this.h / 760), this.root ? 0.8 : 0.55, 1);
    this.canvas.width = Math.floor(this.w * this.dpr);
    this.canvas.height = Math.floor(this.h * this.dpr);
    this.hudCanvas.width = Math.floor(this.w * this.baseDpr);
    this.hudCanvas.height = Math.floor(this.h * this.baseDpr);
    this.fastCanvas.width = this.hudCanvas.width;
    this.fastCanvas.height = this.hudCanvas.height;
    this.hudKey = '';
    this.canvas.style.width = `${this.w}px`;
    this.canvas.style.height = `${this.h}px`;
    // ライトマップは半解像度で十分（ぼかし効果も兼ねる）
    this.lightCanvas.width = Math.ceil(this.w / 2);
    this.lightCanvas.height = Math.ceil(this.h / 2);
  }

  /** 地形をオフスクリーンキャンバスに一度だけ描き込む */
  /** 地形をオフスクリーンキャンバスに一度だけ描き込む */
  private bakeTerrain(): void {
    const baked = this.art.bakeTerrain(this.world);
    this.terrain = baked.cache;
    this.miniCanvas = baked.mini;
  }

  worldToScreen(wx: number, wy: number): { x: number; y: number } {
    return { x: wx - this.cam.x + this.w / 2, y: wy - this.cam.y + this.h / 2 };
  }

  screenToWorld(sx: number, sy: number): { x: number; y: number } {
    return { x: sx - this.w / 2 + this.cam.x, y: sy - this.h / 2 + this.cam.y };
  }

  private getPAnim(id: number): PlayerAnim {
    let a = this.pAnim.get(id);
    if (!a) {
      a = { recoil: 0, recoilV: 0, flash: 0, flashSeed: 0, lastShots: -1, swing: 0, lastSwings: -1, walk: 0, lastX: NaN, lastY: NaN, move: 0 };
      this.pAnim.set(id, a);
    }
    return a;
  }

  triggerShot(id: number, w: WeaponId = 'pistol', x?: number, y?: number, aim?: number): void {
    const a = this.getPAnim(id);
    a.recoil = w === 'shotgun' ? -10 : w === 'rifle' ? -5 : -6;
    a.recoilV = 0;
    a.flash = w === 'shotgun' ? 0.08 : 0.06;
    a.flashSeed = Math.random();
    if (this.fx && x !== undefined && y !== undefined && aim !== undefined) {
      this.fx.casing(x, y, aim, w);
      // 銃口の火花と煙（重い銃ほど大きい）
      const heavy = w === 'shotgun' || w === 'hunting' || w === 'dmr';
      const mx = x + Math.cos(aim) * 28;
      const my = y + Math.sin(aim) * 28;
      this.fx.burst(mx, my, '#ffd890', heavy ? 6 : 3, heavy ? 420 : 320, 0.09, 1.6, 'spark', true, aim, 0.5);
      this.fx.burst(mx, my, '#8a8880', heavy ? 4 : 2, 50, heavy ? 0.9 : 0.6, heavy ? 7 : 5, 'smoke', false, aim, 0.9);
      if (id === this.localId) {
        this.fx.kick(aim, WEAPONS[w].kick);
        // 照準の広がり：連射武器は小さく何度も、単発の重い銃は大きく一度
        const bloom: Record<WeaponId, number> = { pistol: 0.3, smg: 0.16, rifle: 0.24, shotgun: 0.8, hunting: 0.9, dmr: 0.5 };
        this.bloom = Math.min(1, this.bloom + bloom[w]);
        const shake: Partial<Record<WeaponId, number>> = { shotgun: 0.18, hunting: 0.14, dmr: 0.08, rifle: 0.03 };
        if (shake[w]) this.fx.shake(shake[w]!);
      }
    }
  }

  triggerSwing(id: number): void {
    this.getPAnim(id).swing = 1;
  }

  // ============================================================
  private hudHidden = false;
  private hudDimmed = false;

  render(view: ViewState, o: RenderOptions): void {
    const { ctx } = this;
    // 全体地図を開いている間は、パネル類の HUD キャンバスを丸ごと隠す（地図の後ろに透けない）
    if (this.hudHidden !== !!o.mapOpen) {
      this.hudHidden = !!o.mapOpen;
      this.hudCanvas.style.visibility = this.hudHidden ? 'hidden' : '';
    }
    // 持ち物・作業台を開いている間は、パネルの後ろの HUD を薄くして文字が重ならないようにする
    const dimHud = !!o.panelOpen && !o.mapOpen;
    if (this.hudDimmed !== dimHud) {
      this.hudDimmed = dimHud;
      this.hudCanvas.style.opacity = dimHud ? '0.15' : '';
    }
    const dt = o.dt;
    this.time += dt;
    const fx = o.effects;

    this.fx = fx;
    this.localId = o.localId;
    for (const p of view.players) this.pingNames.set(p.id, p.name);
    // ヒットストップ中は世界の動き（アニメ・パーティクル）をほぼ止める
    const wdt = fx.hitstop > 0 ? dt * 0.06 : dt;
    fx.hitstop = Math.max(0, fx.hitstop - dt);
    this.bloom = Math.max(0, this.bloom - dt * 2.2);
    this.updateAnims(view, { ...o, dt: wdt });
    fx.update(wdt);

    // ---- カメラ ----
    const me = view.players.find((p) => p.id === o.localId);
    let focus: PlayerSnap | undefined = me;
    if (!focus || focus.status === 'dead') focus = view.players.find((p) => p.status === 'alive') ?? me;
    if (focus) {
      let tx = focus.x;
      let ty = focus.y;
      if (focus === me && me.status === 'alive') {
        tx += clamp(o.mouseX - this.w / 2, -this.w / 2, this.w / 2) * 0.15;
        ty += clamp(o.mouseY - this.h / 2, -this.h / 2, this.h / 2) * 0.15;
      }
      if (!this.camInit) {
        this.cam.x = tx;
        this.cam.y = ty;
        this.camInit = true;
      }
      const k = 1 - Math.exp(-8 * dt);
      this.cam.x += (tx - this.cam.x) * k;
      this.cam.y += (ty - this.cam.y) * k;
    }
    const shake = fx.shakeOffset();
    shake.x += fx.kickX;
    shake.y += fx.kickY;
    const ox = Math.round(this.w / 2 - this.cam.x + shake.x);
    const oy = Math.round(this.h / 2 - this.cam.y + shake.y);

    const t0 = performance.now();
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    // マップの外側は深い森
    // （画面がマップの外にはみ出しているときだけ塗る）
    const outside = this.cam.x - this.w / 2 < 0 || this.cam.y - this.h / 2 < 0 || this.cam.x + this.w / 2 > WORLD_W || this.cam.y + this.h / 2 > WORLD_H;
    if (outside) {
      if (!this.forest) this.forest = makeForestPattern(ctx);
      ctx.save();
      ctx.translate(Math.round(this.w / 2 - this.cam.x), Math.round(this.h / 2 - this.cam.y));
      ctx.fillStyle = this.forest;
      ctx.fillRect(this.cam.x - this.w / 2 - 20, this.cam.y - this.h / 2 - 20, this.w + 40, this.h + 40);
      ctx.restore();
    }

    // ---- ワールド ----
    ctx.save();
    ctx.translate(ox, oy);
    const vx0 = this.cam.x - this.w / 2 - TILE * 2;
    const vy0 = this.cam.y - this.h / 2 - TILE * 2;
    const vx1 = vx0 + this.w + TILE * 4;
    const vy1 = vy0 + this.h + TILE * 4;
    this.drawTerrainChunks(vx0, vy0, vx1, vy1);
    this.drawWaterShimmer(vx0, vy0, vx1, vy1);
    if (view.winter) this.drawSnowGround(view, vx0, vy0, vx1, vy1, o.dt);

    this.drawDecals(fx.decals, vx0, vy0, vx1, vy1);
    this.drawAcid(view);
    if (view.base.garden >= 1) this.drawGarden(view.base.garden);
    for (const c of fx.corpses) if (c.x > vx0 && c.y > vy0 && c.x < vx1 && c.y < vy1) this.art.drawCorpse(ctx, c);
    this.drawParticles(fx, false, true);
    // （地図の端は柵で塞がず、外側の遠景と汚染の霞につなげる）
    // 画面内のオブジェクトはタイルの格子から引く（ワールドが広くても一定の負荷）
    this.vrect = [vx0, vy0, vx1, vy1];
    const visible = this.objsIn(Math.ceil(vx0 / TILE), Math.ceil(vy0 / TILE), Math.floor(vx1 / TILE), Math.floor(vy1 / TILE));
    // 壁の落ち影（重なっても濃くならないよう1つのパスでまとめて塗る）
    ctx.fillStyle = 'rgba(0,0,0,0.3)';
    ctx.beginPath();
    for (const ob of visible) if (WALL_KINDS.has(ob.kind)) ctx.rect(ob.tx * TILE + 7, ob.ty * TILE + 10, TILE, TILE);
    ctx.fill();
    const tall: ObjSnap[] = [];
    for (const ob of visible) {
      if (!this.art.drawLowObject(ctx, ob, this.time, this.tallQuery(ob.tx, ob.ty))) tall.push(ob);
      // 焚き火・松明から舞い上がる火の粉
      if ((ob.kind === 'campfire' || ob.kind === 'fire' || ob.kind === 'torch') && Math.random() < dt * (ob.kind === 'torch' ? 3 : 9)) {
        fx.burst((ob.tx + 0.5) * TILE + (Math.random() - 0.5) * 10, (ob.ty + 0.5) * TILE - 6, '#ffb060', 1, 40, 1.4, 1.4, 'dot', true, -Math.PI / 2, 0.9);
      }
    }

    // ---- 視界（レイキャスト）：自分と仲間の視界を合算 ----
    const dark = darknessAt(view.minute);
    this.updateVision(view, dark);
    const vis = this.vision;
    const zombiesSeen = view.zombies.filter((z) => vis.isVisible(z.x, z.y));

    this.drawSearch(view, me);
    this.drawBullets({ ...view, bullets: view.bullets.filter((b) => vis.isVisible(b.x, b.y)) }, o);
    for (const z of zombiesSeen) this.art.drawZombie(ctx, z, this.getZAnim(z), this.time);
    this.touchUI = !!o.touch;
    this.roofDt = Math.min(0.1, o.dt || 0.016);
    this.padUI = !!o.pad;
    this.glyphs = o.pad ? (o.glyphs ?? null) : null;
    this.vehLights = (view.vehicles ?? []).filter((v) => v.seats[0] >= 0 && !v.broken).map((v) => ({ x: v.x + Math.cos(v.a) * 90, y: v.y + Math.sin(v.a) * 90 }));
    for (const v of view.vehicles ?? []) if (v.x > vx0 - 60 && v.y > vy0 - 60 && v.x < vx1 + 60 && v.y < vy1 + 60) this.drawVehicle(v, view);
    for (const p of view.players) if (p.veh === undefined) this.drawPlayerMarker(p, p.id === o.localId);
    for (const p of view.players) if (p.veh === undefined) this.art.drawPlayer(ctx, p, PLAYER_COLORS[p.id] ?? '#fff', this.getPAnim(p.id), this.time);
    // 生存者（救出を待つ・ついてくる人）
    for (const n of view.npcs ?? []) {
      const fake = { id: 1000 + n.id, x: n.x, y: n.y, bodyAngle: n.a, aim: n.a, status: 'alive', tool: 0, hp: n.hp, maxHp: 100, bag: [], prim: null, sec: null } as unknown as PlayerSnap;
      this.art.drawPlayer(ctx, fake, '#cfc2a0', this.getPAnim(1000 + n.id), this.time);
      ctx.font = `bold 10px ${UI}`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.lineWidth = 3;
      ctx.strokeStyle = 'rgba(0,0,0,0.8)';
      const t = n.follow >= 0 ? `生存者（${NPC_ROLE[n.role] ?? ''}・同行中）` : `生存者（${NPC_ROLE[n.role] ?? ''}）[F]`;
      ctx.strokeText(t, n.x, n.y - 30);
      ctx.fillStyle = '#9fd0f0';
      ctx.fillText(t, n.x, n.y - 30);
      ctx.fillStyle = 'rgba(0,0,0,0.6)';
      ctx.fillRect(n.x - 15, n.y + 22, 30, 4);
      ctx.fillStyle = n.hp > 40 ? '#7fd07f' : '#e07a60';
      ctx.fillRect(n.x - 15, n.y + 22, 30 * Math.max(0, n.hp) / 100, 4);
    }
    for (const ob of tall) this.art.drawTallObject(ctx, ob, this.time, ob.kind === 'turret' ? fx.turretAim.get(ob.id) : undefined);
    this.drawParticles(fx, false);
    if (o.build) this.drawBuildGhost(o.build, visible);
    this.drawCloudShadows(view.minute, vx0, vy0, vx1, vy1);
    this.drawEdgeHaze(vx0, vy0, vx1, vy1);
    this.drawStructureBars(visible);
    // ---- 屋根と霧（見えていない場所を隠す） ----
    // 外壁が見えている建物の屋根は霧の上に（外から屋根として見える）、それ以外は記憶として霧の下に
    this.drawRoofs(me, vx0, vy0, vx1, vy1, false);
    ctx.imageSmoothingEnabled = true;
    {
      // 霧は画面に映る範囲だけ切り出して描く（ワールド全体を毎フレーム拡大しない）
      const k = vis.fog.width / WORLD_W;
      const fx0 = clamp(Math.floor(vx0 / TILE) * TILE, 0, WORLD_W);
      const fy0 = clamp(Math.floor(vy0 / TILE) * TILE, 0, WORLD_H);
      const fx1 = clamp(Math.ceil(vx1 / TILE) * TILE, 0, WORLD_W);
      const fy1 = clamp(Math.ceil(vy1 / TILE) * TILE, 0, WORLD_H);
      if (fx1 > fx0 && fy1 > fy0) ctx.drawImage(vis.fog, fx0 * k, fy0 * k, (fx1 - fx0) * k, (fy1 - fy0) * k, fx0, fy0, fx1 - fx0, fy1 - fy0);
    }
    this.drawRoofs(me, vx0, vy0, vx1, vy1, true);
    ctx.restore();

    const t1 = performance.now();
    this.perfN.objects = visible.length;
    this.perfN.zombiesDrawn = zombiesSeen.length;
    this.perfN.particles = fx.particles.length;
    // ---- ライティング・天候 ----
    this.drawLighting(view, dark, ox, oy);
    this.drawWeather(view, dark, o.dt);

    const t2 = performance.now();
    // ---- 光る要素・オーバーレイ ----
    ctx.save();
    ctx.translate(ox, oy);
    this.drawParticles(fx, true);
    this.drawGlows(view, dark);
    // 仲間と隣り合うと名前が重なるので、重なる分だけ上にずらして積む
    {
      ctx.font = 'bold 12px "Noto Sans JP", "Segoe UI", sans-serif';
      const placed: { x: number; y: number; w: number }[] = [];
      // 車に乗っている人は、車の上にまとめて1行で
      for (const v of view.vehicles ?? []) {
        const names = v.seats.filter((id) => id >= 0).map((id) => view.players.find((q) => q.id === id)).filter((q): q is PlayerSnap => !!q);
        if (!names.length || this.photo) continue;
        const label = names.map((q) => (q.id === o.localId ? `${q.name}(YOU)` : q.name)).join('・');
        ctx.font = `bold 12px ${UI}`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.lineWidth = 3;
        ctx.strokeStyle = 'rgba(8,9,7,0.85)';
        ctx.strokeText(label, v.x, v.y - 40);
        ctx.fillStyle = '#cfe8f6';
        ctx.fillText(label, v.x, v.y - 40);
      }
      for (const p of [...view.players].sort((a, b) => b.y - a.y)) {
        if (p.veh !== undefined || this.photo) continue;
        const label = p.id === o.localId ? `${p.name} (YOU)` : p.name;
        const lw = ctx.measureText(label).width;
        let off = p.status === 'down' ? 16 : 0;
        while (placed.some((q) => Math.abs(q.x - p.x) < (q.w + lw) / 2 + 4 && Math.abs(q.y - (p.y - off)) < 15) && off < 60) off += 15;
        placed.push({ x: p.x, y: p.y - off, w: lw });
        this.drawPlayerOverlay(p, p.id === o.localId, p.status === 'down' ? off - 16 : off);
      }
    }
    this.drawZombieOverlays(zombiesSeen, dark, me);
    this.drawPingMarkers(fx, me);
    this.drawDropBeacon(view);
    this.drawLandmarks(vx0, vy0, vx1, vy1);
    if (!this.photo) this.drawPopups(fx);
    ctx.restore();

    const t3 = performance.now();
    // 色調・グレインは CSS（#game.fx / #fx-grain）で行う
    // 照準・バナー・ヒントなど毎フレーム変わる HUD は、色調フィルターのかからない透明キャンバスへ
    {
      const main = this.ctx;
      const f = this.fastCtx;
      f.setTransform(1, 0, 0, 1, 0, 0);
      f.clearRect(0, 0, this.fastCanvas.width, this.fastCanvas.height);
      f.setTransform(this.baseDpr, 0, 0, this.baseDpr, 0, 0);
      this.ctx = f;
      try {
        // 写真モード（F2）：HUD を消して景色だけ
        if (!this.photo) this.drawHUD(view, o, me, dark);
        else {
          this.hudCtx.setTransform(1, 0, 0, 1, 0, 0);
          this.hudCtx.clearRect(0, 0, this.hudCanvas.width, this.hudCanvas.height);
          this.hudKey = '';
        }
      } finally {
        this.ctx = main;
      }
    }
    const t4 = performance.now();
    this.perfT.world = t1 - t0;
    this.perfT.light = t2 - t1;
    this.perfT.over = t3 - t2;
    this.perfT.hud = t4 - t3;
  }

  /** 視界の計算（昼は広く、夜は懐中電灯の届く範囲だけ） */
  private updateVision(view: ViewState, dark: number): void {
    const viewers: Viewer[] = [];
    for (const p of view.players) {
      if (p.status === 'dead') continue;
      const down = p.status === 'down';
      // 霧・嵐は見通しが悪い。スコープ付きの銃を構えていると照準方向の視界が伸びる
      const wfog = view.weather === 'fog' ? 0.45 : view.weather === 'storm' ? 0.3 : view.weather === 'rain' ? 0.15 : 0;
      const wmul = 1 - wfog * view.wx;
      const held = heldWeapon(p);
      const scope = held?.w.scope ? 1.3 : 1;
      viewers.push({
        x: p.x,
        y: p.y,
        aim: p.aim,
        near: down ? 100 : (330 - dark * 180) * (1 - wfog * 0.5 * view.wx),
        cone: down ? 0 : (820 - dark * 300) * wmul * scope,
        half: down ? 0 : (0.72 - dark * 0.28) * (scope > 1 ? 0.85 : 1),
      });
    }
    this.vision.update(this.world, viewers);
  }

  /** 拠点の菜園：畝と作物（レベルが上がると畝が増え、作物が育つ） */
  private drawGarden(lv: number): void {
    const { ctx } = this;
    const x0 = (SAFEHOUSE.x + 11) * TILE;
    const y0 = (SAFEHOUSE.y + 2) * TILE;
    const rows = lv >= 2 ? 4 : 2;
    for (let r = 0; r < rows; r++) {
      const y = y0 + r * 34;
      ctx.fillStyle = 'rgba(0,0,0,0.25)';
      ctx.fillRect(x0 + 3, y + 5, 200, 20);
      ctx.fillStyle = '#4a3a28';
      ctx.fillRect(x0, y, 200, 20);
      ctx.fillStyle = 'rgba(120,95,60,0.6)';
      ctx.fillRect(x0, y, 200, 3);
      for (let k = 0; k < 10; k++) {
        const px = x0 + 10 + k * 19;
        const py = y + 10;
        const s = lv >= 2 ? 8 : 5;
        ctx.fillStyle = k % 3 === 0 ? '#7a9a48' : '#5e8a3a';
        for (const a of [-0.9, 0, 0.9]) {
          ctx.beginPath();
          ctx.ellipse(px + Math.sin(a) * s * 0.6, py - Math.cos(a) * s * 0.4, s * 0.45, s * 0.9, a, 0, Math.PI * 2);
          ctx.fill();
        }
      }
    }
  }

  /** 水面の揺らぎ：映っている水のタイルに、ゆっくり流れる光の筋（毎フレーム・軽量） */
  private drawWaterShimmer(vx0: number, vy0: number, vx1: number, vy1: number): void {
    const { ctx } = this;
    const tx0 = Math.max(0, Math.floor(vx0 / TILE));
    const ty0 = Math.max(0, Math.floor(vy0 / TILE));
    const tx1 = Math.min(MAP_W - 1, Math.floor(vx1 / TILE));
    const ty1 = Math.min(MAP_H - 1, Math.floor(vy1 / TILE));
    const T = this.time;
    const paths = [new Path2D(), new Path2D(), new Path2D()];
    let any = false;
    for (let ty = ty0; ty <= ty1; ty++)
      for (let tx = tx0; tx <= tx1; tx++) {
        const t = this.world.terrain[ty * MAP_W + tx];
        if (t !== T_WATER && t !== T_SHALLOW) continue;
        any = true;
        const h = ((tx * 73856093) ^ (ty * 19349663)) >>> 0;
        const ph = (h % 1000) / 1000;
        const bucket = Math.floor(((Math.sin(T * 1.3 + ph * 6.28) + 1) / 2) * 2.99);
        const ox = ((T * 9 + ph * 40) % 44) - 2;
        const oy = (h >> 10) % 30 + 5;
        const x = tx * TILE + ox;
        const y = ty * TILE + oy;
        const p = paths[bucket];
        p.moveTo(x - 6, y);
        p.quadraticCurveTo(x, y - 2.5, x + 6, y);
        if (t === T_WATER && ph > 0.5) {
          const y2 = ty * TILE + ((oy + 17) % 34) + 3;
          const x2 = tx * TILE + ((ox + 21) % 40);
          p.moveTo(x2 - 4, y2);
          p.quadraticCurveTo(x2, y2 - 2, x2 + 4, y2);
        }
      }
    if (!any) return;
    ctx.lineWidth = 1.4;
    const alphas = [0.06, 0.13, 0.22];
    for (let i = 0; i < 3; i++) {
      ctx.strokeStyle = `rgba(200,220,215,${alphas[i]})`;
      ctx.stroke(paths[i]);
    }
  }

  /** 自機・仲間の足元の目印：色つきの輪と、向いている方向の矢印（地形に埋もれないように） */
  private drawPlayerMarker(p: PlayerSnap, isLocal: boolean): void {
    if (p.status === 'dead') return;
    const { ctx } = this;
    const col = PLAYER_COLORS[p.id] ?? '#fff';
    ctx.save();
    ctx.translate(p.x, p.y);
    // 暗い縁取りで背景から浮かせる
    ctx.fillStyle = 'rgba(0,0,0,0.28)';
    ctx.beginPath();
    ctx.ellipse(0, 4, 24, 20, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = 'rgba(0,0,0,0.55)';
    ctx.lineWidth = 4;
    ctx.beginPath();
    ctx.ellipse(0, 3, 22, 18, 0, 0, Math.PI * 2);
    ctx.stroke();
    ctx.strokeStyle = col;
    ctx.globalAlpha = isLocal ? 0.85 : 0.6;
    ctx.lineWidth = 2;
    ctx.stroke();
    // 向き（照準方向）の矢印
    if (p.status === 'alive') {
      const a = p.aim;
      ctx.rotate(a);
      ctx.globalAlpha = isLocal ? 0.95 : 0.7;
      ctx.fillStyle = col;
      ctx.strokeStyle = 'rgba(0,0,0,0.6)';
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(30, 0);
      ctx.lineTo(23, -5);
      ctx.lineTo(23, 5);
      ctx.closePath();
      ctx.stroke();
      ctx.fill();
    }
    ctx.restore();
  }

  /**
   * 屋根：建物に近づく（3マス以内）と屋根は消え、中は視界の届く所だけが見える（見えない所は暗闇）。
   * 離れている建物は屋根全体を描く。見えている／いないの境目で屋根を切り抜かないので、ちらつかない。
   */
  private roofAlpha = new Map<number, number>();
  private roofDt = 0.016;
  private drawRoofs(me: PlayerSnap | undefined, x0: number, y0: number, x1: number, y1: number, seenPass: boolean): void {
    const { ctx } = this;
    const mx = me ? me.x / TILE : -999;
    const my = me ? me.y / TILE : -999;
    const k = 1 - Math.exp(-this.roofDt * 9);
    this.world.buildings.forEach((b, i) => {
      if (b.x * TILE > x1 || b.y * TILE > y1 || (b.x + b.w) * TILE < x0 || (b.y + b.h) * TILE < y0) return;
      // 外壁のどこかが見えているか（地図の「探索済み」に使う）
      let seen = false;
      for (let tx = b.x; tx < b.x + b.w && !seen; tx++) seen = this.vision.tileVisible(tx, b.y) || this.vision.tileVisible(tx, b.y + b.h - 1);
      for (let ty = b.y; ty < b.y + b.h && !seen; ty++) seen = this.vision.tileVisible(b.x, ty) || this.vision.tileVisible(b.x + b.w - 1, ty);
      if (seen !== seenPass) return;
      if (seen) this.vision.markExplored(b.x, b.y, b.w, b.h);
      const near = mx > b.x - 3 && mx < b.x + b.w + 3 && my > b.y - 3 && my < b.y + b.h + 3;
      const cur = this.roofAlpha.get(i) ?? (near ? 0 : 1);
      const a = cur + ((near ? 0 : 1) - cur) * k;
      this.roofAlpha.set(i, a);
      // 屋根を外した建物：中の見えていない所は暗闇（タイルごとに少しずつ明暗を変えて、境目をちらつかせない）
      if (a < 0.98) {
        let dark = this.roomDark.get(i);
        if (!dark) {
          dark = new Float32Array(b.w * b.h).fill(1);
          this.roomDark.set(i, dark);
        }
        const kd = 1 - Math.exp(-this.roofDt * 7);
        ctx.fillStyle = '#07080a';
        for (let ty = 0; ty < b.h; ty++)
          for (let tx = 0; tx < b.w; tx++) {
            const j = ty * b.w + tx;
            const target = this.vision.tileVisible(b.x + tx, b.y + ty) ? 0 : 1;
            dark[j] += (target - dark[j]) * kd;
            const v = dark[j] * (1 - a) * 0.93;
            if (v < 0.03) continue;
            ctx.globalAlpha = v;
            ctx.fillRect((b.x + tx) * TILE, (b.y + ty) * TILE, TILE, TILE);
          }
        ctx.globalAlpha = 1;
      }
      if (a < 0.02) return;
      ctx.globalAlpha = a;
      ctx.drawImage(roofCanvas(b), b.x * TILE, b.y * TILE);
      ctx.globalAlpha = 1;
    });
  }
  private roomDark = new Map<number, Float32Array>();

  /** フィルムグレイン＋彩度を落とす色調補正 */


  /** 隣のタイルに高い壁（廃墟の壁・建築壁）があるか */
  private tallQuery(tx: number, ty: number): TallQuery {
    return (dx, dy) => {
      const x = tx + dx;
      const y = ty + dy;
      const tt = this.world.terrainAt(x, y);
      if (tt === T_WALL || tt === T_WINDOW) return true;
      const ob = this.world.objAt(x, y);
      return !!ob && WALL_KINDS.has(ob.kind);
    };
  }

  /** 昼間にゆっくり流れる雲の影 */
  private cloudCanvas = document.createElement('canvas');

  /** 流れる雲の影：1/4解像度の小さなキャンバスに描いて、1回だけ拡大して重ねる（全画面の大きなグラデーションを何枚も塗らない） */
  private drawCloudShadows(minute: number, x0: number, y0: number, x1: number, y1: number): void {
    const amb = ambientAt(minute);
    const k = 1 - Math.min(1, amb.dark * 2.5);
    if (k <= 0.02) return;
    const Q = 4;
    const cw = Math.ceil((x1 - x0) / Q);
    const ch = Math.ceil((y1 - y0) / Q);
    const cc = this.cloudCanvas;
    if (cc.width !== cw || cc.height !== ch) {
      cc.width = cw;
      cc.height = ch;
    }
    const g2 = cc.getContext('2d')!;
    g2.clearRect(0, 0, cw, ch);
    const span = WORLD_W + 1200;
    let any = false;
    for (let i = 0; i < 7; i++) {
      const cx = ((i * 977 + this.time * (10 + i * 2)) % span) - 600;
      const cy = (i * 541) % WORLD_H;
      const r = 260 + (i % 3) * 120;
      if (cx + r * 1.4 < x0 || cx - r * 1.4 > x1 || cy + r < y0 || cy - r > y1) continue;
      any = true;
      const lx = (cx - x0) / Q;
      const ly = (cy - y0) / Q;
      const lr = r / Q;
      const g = g2.createRadialGradient(lx, ly, 0, lx, ly, lr);
      g.addColorStop(0, `rgba(10,20,30,${0.14 * k})`);
      g.addColorStop(0.6, `rgba(10,20,30,${0.08 * k})`);
      g.addColorStop(1, 'rgba(10,20,30,0)');
      g2.fillStyle = g;
      g2.beginPath();
      g2.ellipse(lx, ly, lr * 1.4, lr, 0.3, 0, Math.PI * 2);
      g2.fill();
    }
    if (any) this.ctx.drawImage(cc, x0, y0, cw * Q, ch * Q);
  }


  private getZAnim(z: ZombieSnap): ZombieAnim {
    let a = this.zAnim.get(z.id);
    if (!a) {
      a = { lastAtk: z.atk, lunge: 0, walk: Math.random() * 6, lastX: z.x, lastY: z.y, move: 0 };
      this.zAnim.set(z.id, a);
    }
    return a;
  }

  private updateAnims(view: ViewState, o: RenderOptions): void {
    const dt = o.dt;
    for (const p of view.players) {
      const a = this.getPAnim(p.id);
      if (a.lastShots < 0) a.lastShots = p.shots;
      if (a.lastSwings < 0) a.lastSwings = p.swings;
      if (p.id !== o.skipAnimDetectId) {
        if (p.shots !== a.lastShots) {
          const w = weaponOfSnap(p);
          this.triggerShot(p.id, w, p.x, p.y, p.aim);
          this.hooks?.shot(p, w);
        }
        if (p.swings !== a.lastSwings) {
          this.triggerSwing(p.id);
          this.hooks?.swing(p);
        }
      }
      const lr = this.lastReload.get(p.id) ?? 0;
      if (p.reloadT > 0 && lr <= 0) this.hooks?.reload(p);
      this.lastReload.set(p.id, p.reloadT);
      a.lastShots = p.shots;
      a.lastSwings = p.swings;
      // リコイルのばね：低FPSでも発散しないよう細かく分けて積分し、範囲も制限する
      const sub = Math.max(1, Math.ceil(dt / (1 / 240)));
      const sdt = dt / sub;
      for (let k = 0; k < sub; k++) {
        a.recoilV += (-900 * a.recoil - 26 * a.recoilV) * sdt;
        a.recoil += a.recoilV * sdt;
      }
      a.recoil = clamp(a.recoil, -12, 4);
      a.flash = Math.max(0, a.flash - dt);
      a.swing = Math.max(0, a.swing - dt * 3.2);
      if (!Number.isNaN(a.lastX)) {
        const mv = Math.hypot(p.x - a.lastX, p.y - a.lastY);
        a.walk += mv * 0.18;
        a.move += (Math.min(1, mv / Math.max(1e-3, dt) / 160) - a.move) * Math.min(1, dt * 10);
        // 土や草の上に足跡を残す
        const prevStep = Math.floor((a.walk - mv * 0.18) / Math.PI);
        if (p.status === 'alive' && mv > 0.2 && Math.floor(a.walk / Math.PI) !== prevStep) {
          const t = this.world.terrainAt(Math.floor(p.x / TILE), Math.floor(p.y / TILE));
          if (t === 0 || t === 4) {
            const ang = Math.atan2(p.y - a.lastY, p.x - a.lastX);
            const side = Math.floor(a.walk / Math.PI) % 2 === 0 ? 1 : -1;
            const fd = o.effects;
            fd.decals.push({ x: p.x - Math.sin(ang) * 4 * side, y: p.y + Math.cos(ang) * 4 * side, r: 2.6, rot: ang, kind: 'foot', life: 9, maxLife: 9, seed: 0 });
          }
        }
        if (p.dashTime > 0 && p.status === 'alive') o.effects.burst(p.x, p.y, '#cfc6b0', 1, 40, 0.4, 4, 'dot', false);
      }
      a.lastX = p.x;
      a.lastY = p.y;
    }
    const seen = new Set<number>();
    for (const z of view.zombies) {
      seen.add(z.id);
      const a = this.getZAnim(z);
      if (z.atk !== a.lastAtk) {
        a.lunge = 1;
        a.lastAtk = z.atk;
      }
      a.lunge = Math.max(0, a.lunge - dt * 4);
      // 予備動作：追跡中に近くのプレイヤーへ迫ると腕を振り上げる
      let nd = Infinity;
      if (z.alert === 2) for (const p of view.players) if (p.status === 'alive') nd = Math.min(nd, Math.hypot(p.x - z.x, p.y - z.y));
      const target = nd < 110 ? 1 - Math.max(0, nd - 35) / 75 : 0;
      a.near = (a.near ?? 0) + (target - (a.near ?? 0)) * Math.min(1, dt * 10);
      // 被弾ののけぞり
      a.hit = z.flash > 0 ? 1 : Math.max(0, (a.hit ?? 0) - dt * 6);
      const zm = Math.hypot(z.x - a.lastX, z.y - a.lastY);
      a.walk += zm * 0.2;
      a.move += (Math.min(1, zm / Math.max(1e-3, dt) / 60) - a.move) * Math.min(1, dt * 8);
      a.lastX = z.x;
      a.lastY = z.y;
    }
    if (this.zAnim.size > view.zombies.length + 50) {
      for (const id of this.zAnim.keys()) if (!seen.has(id)) this.zAnim.delete(id);
    }
  }

  // ---------------- 探索（漁り）の表示 ----------------

  /** 近くの未探索の入れ物に印を付け、探索中は進捗バーを出す */
  private drawSearch(view: ViewState, me: PlayerSnap | undefined): void {
    const { ctx } = this;
    if (me && me.status === 'alive') {
      const ptx = Math.floor(me.x / TILE);
      const pty = Math.floor(me.y / TILE);
      for (let ty = pty - 4; ty <= pty + 4; ty++)
        for (let tx = ptx - 4; tx <= ptx + 4; tx++) {
          const ob = this.world.objAt(tx, ty);
          if (!ob || !CONTAINER_KINDS.has(ob.kind) || !this.vision.tileVisible(tx, ty)) continue;
          if (ob.kind === 'car' && ob.hp <= 0) continue;
          const fresh = ob.ready === 1 || ob.kind === 'bag';
          if (!fresh) continue;
          const cx = (tx + 0.5) * TILE;
          const cy = (ty + 0.5) * TILE;
          const d = Math.hypot(cx - me.x, cy - me.y);
          const a = Math.max(0, 1 - d / 170) * (0.55 + Math.sin(this.time * 3 + ob.id) * 0.2);
          if (a <= 0.02) continue;
          ctx.strokeStyle = `rgba(226,204,140,${a})`;
          ctx.lineWidth = 1.5;
          ctx.setLineDash([4, 4]);
          ctx.strokeRect(tx * TILE + 3, ty * TILE + 3, TILE - 6, TILE - 6);
          ctx.setLineDash([]);
        }
    }
    for (const p of view.players) {
      if (!p.searchId || p.status !== 'alive') continue;
      const ob = this.world.objects.get(p.searchId);
      if (!ob) continue;
      const cx = p.x;
      const cy = p.y - 46;
      const w = 64;
      ctx.fillStyle = 'rgba(10,10,8,0.8)';
      ctx.fillRect(cx - w / 2 - 2, cy - 5, w + 4, 10);
      ctx.fillStyle = '#c9b27a';
      ctx.fillRect(cx - w / 2, cy - 3, w * Math.min(1, p.searchP), 6);
      if (p.id === this.localId) this.worldLabel(cx, cy - 12, `${CONTAINER_NAMES[ob.kind] ?? ''}を探索中…`, '#e6dcc0');
    }
  }

  private worldLabel(x: number, y: number, text: string, color: string): void {
    const { ctx } = this;
    ctx.font = 'bold 11px "Noto Sans JP", "Segoe UI", sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.lineWidth = 3;
    ctx.strokeStyle = 'rgba(0,0,0,0.8)';
    ctx.strokeText(text, x, y);
    ctx.fillStyle = color;
    ctx.fillText(text, x, y);
  }

  private drawStructureBars(objs: ObjSnap[]): void {
    const { ctx } = this;
    for (const ob of objs) {
      if (ob.hp >= ob.maxHp || ob.maxHp <= 1) continue;
      if (ob.kind === 'tree' || ob.kind === 'car') {
        if (ob.hp <= 0) continue;
      }
      const r = clamp(ob.hp / ob.maxHp, 0, 1);
      const x = ob.tx * TILE + 4;
      const y = ob.ty * TILE - 6;
      ctx.fillStyle = 'rgba(0,0,0,0.6)';
      ctx.fillRect(x - 1, y - 1, TILE - 6, 5);
      ctx.fillStyle = r > 0.5 ? '#9fb4c2' : r > 0.25 ? '#c9a85a' : '#c0573e';
      ctx.fillRect(x, y, (TILE - 8) * r, 3);
    }
  }

  // ---------------- 弾・パーティクル ----------------

  private drawBullets(view: ViewState, _o: RenderOptions): void {
    const { ctx } = this;
    ctx.save();
    ctx.lineCap = 'round';
    for (const b of view.bullets) {
      ctx.strokeStyle = 'rgba(255,220,140,0.55)';
      ctx.lineWidth = 4;
      ctx.beginPath();
      ctx.moveTo(b.x - b.vx * 0.02, b.y - b.vy * 0.02);
      ctx.lineTo(b.x, b.y);
      ctx.stroke();
      ctx.strokeStyle = '#fffbe8';
      ctx.lineWidth = 1.6;
      ctx.beginPath();
      ctx.moveTo(b.x - b.vx * 0.01, b.y - b.vy * 0.01);
      ctx.lineTo(b.x, b.y);
      ctx.stroke();
    }
    ctx.restore();
  }

  private drawDecals(decals: Decal[], x0: number, y0: number, x1: number, y1: number): void {
    const { ctx } = this;
    for (const d of decals) {
      if (d.x < x0 || d.y < y0 || d.x > x1 || d.y > y1) continue;
      const a = Math.min(1, d.life / 6) * (d.kind === 'scorch' ? 0.55 : 0.75);
      ctx.save();
      ctx.translate(d.x, d.y);
      ctx.rotate(d.rot);
      ctx.globalAlpha = a;
      if (d.kind === 'foot') {
        // 足跡（靴底の形）
        ctx.fillStyle = 'rgba(40,32,24,0.55)';
        ctx.beginPath();
        ctx.ellipse(0, 0, d.r * 1.4, d.r * 0.7, 0, 0, Math.PI * 2);
        ctx.ellipse(-d.r * 1.9, 0, d.r * 0.7, d.r * 0.6, 0, 0, Math.PI * 2);
        ctx.fill();
      } else if (d.kind === 'scorch') {
        const g = ctx.createRadialGradient(0, 0, 0, 0, 0, d.r);
        g.addColorStop(0, 'rgba(10,8,6,0.9)');
        g.addColorStop(1, 'rgba(10,8,6,0)');
        ctx.fillStyle = g;
        ctx.beginPath();
        ctx.arc(0, 0, d.r, 0, Math.PI * 2);
        ctx.fill();
      } else {
        ctx.fillStyle = d.kind === 'pool' ? '#4a0606' : '#6a0a0a';
        ctx.beginPath();
        ctx.ellipse(0, 0, d.r, d.r * 0.7, 0, 0, Math.PI * 2);
        ctx.fill();
        // 飛び散った滴
        for (let i = 0; i < (d.kind === 'pool' ? 5 : 3); i++) {
          const ang = ((d.seed >> (i * 3)) % 628) / 100;
          const dist = d.r * (1 + ((d.seed >> (i * 2)) % 7) / 7);
          ctx.beginPath();
          ctx.arc(Math.cos(ang) * dist, Math.sin(ang) * dist, 1 + (d.r / 6) * (((d.seed >> i) % 5) / 5), 0, Math.PI * 2);
          ctx.fill();
        }
      }
      ctx.restore();
    }
  }

  private drawParticles(fx: Effects, glow: boolean, groundOnly = false): void {
    const { ctx } = this;
    ctx.save();
    if (glow) ctx.globalCompositeOperation = 'lighter';
    ctx.lineCap = 'round';
    for (const p of fx.particles) {
      if (p.glow !== glow) continue;
      if ((p.kind === 'casing') !== groundOnly) continue;
      const t = p.life / p.maxLife;
      ctx.globalAlpha = Math.min(1, t * 1.4);
      if (p.kind === 'ring') {
        ctx.strokeStyle = p.color;
        ctx.lineWidth = 1 + 4 * t;
        ctx.beginPath();
        ctx.arc(p.x, p.y, Math.max(1, p.size * (1 - t * t)), 0, Math.PI * 2);
        ctx.stroke();
      } else if (p.kind === 'spark') {
        ctx.strokeStyle = p.color;
        ctx.lineWidth = p.size * t + 0.5;
        ctx.beginPath();
        ctx.moveTo(p.x, p.y);
        ctx.lineTo(p.x - p.vx * 0.03, p.y - p.vy * 0.03);
        ctx.stroke();
      } else if (p.kind === 'casing') {
        ctx.globalAlpha = Math.min(1, p.life);
        ctx.save();
        ctx.translate(p.x, p.y);
        ctx.rotate(p.rot);
        ctx.fillStyle = p.color;
        ctx.fillRect(-p.size / 2, -p.size / 4, p.size, p.size / 2);
        ctx.fillStyle = 'rgba(255,255,255,0.45)';
        ctx.fillRect(-p.size / 2, -p.size / 4, p.size, 0.8);
        ctx.restore();
      } else if (p.kind === 'smoke') {
        ctx.globalAlpha = t * 0.35;
        ctx.fillStyle = p.color;
        ctx.beginPath();
        ctx.arc(p.x, p.y, p.size, 0, Math.PI * 2);
        ctx.fill();
      } else if (p.kind === 'chunk') {
        ctx.save();
        ctx.translate(p.x, p.y);
        ctx.rotate(p.rot);
        ctx.fillStyle = p.color;
        ctx.fillRect(-p.size / 2, -p.size / 3, p.size, p.size * 0.66);
        ctx.restore();
      } else {
        ctx.fillStyle = p.color;
        ctx.beginPath();
        ctx.arc(p.x, p.y, p.size * (0.5 + 0.5 * t), 0, Math.PI * 2);
        ctx.fill();
      }
    }
    ctx.restore();
  }

  private drawPopups(fx: Effects): void {
    const { ctx } = this;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    for (const p of fx.popups) {
      const t = p.life / p.maxLife;
      ctx.globalAlpha = Math.min(1, t * 2.5);
      ctx.font = `800 ${p.size}px "Noto Sans JP", "Segoe UI", sans-serif`;
      ctx.lineWidth = 3;
      ctx.strokeStyle = 'rgba(0,0,0,0.85)';
      const pt = this.kw(p.text);
      ctx.strokeText(pt, p.x, p.y);
      ctx.fillStyle = p.color;
      ctx.fillText(pt, p.x, p.y);
    }
    ctx.globalAlpha = 1;
  }

  // ---------------- ライティング ----------------

  /** 画面の範囲（ワールド座標）。光源などの検索に使う */
  private vrect = [0, 0, 0, 0];

  /** タイルの矩形の中にあるオブジェクト（上の行から順に） */
  private objsIn(tx0: number, ty0: number, tx1: number, ty1: number): ObjSnap[] {
    const out: ObjSnap[] = [];
    const x0 = Math.max(0, tx0);
    const y0 = Math.max(0, ty0);
    const x1 = Math.min(MAP_W - 1, tx1);
    const y1 = Math.min(MAP_H - 1, ty1);
    for (let ty = y0; ty <= y1; ty++)
      for (let tx = x0; tx <= x1; tx++) {
        const ob = this.world.objAt(tx, ty);
        if (ob) out.push(ob);
      }
    return out;
  }

  private vehLights: { x: number; y: number }[] = [];
  /** 写真モード（HUD・名前・数字を消す） */
  photo = false;
  /** タッチ操作の端末（ボタン名で案内する） */
  private touchUI = false;
  private padUI = false;
  private glyphs: Glyphs | null = null;
  /** 案内文のキー名を、使っている機器のボタン名に */
  private kw(t: string): string {
    return this.glyphs ? padText(t, this.glyphs) : t;
  }
  private lightSources(): { x: number; y: number; r: number; warm: number }[] {
    const out: { x: number; y: number; r: number; warm: number }[] = [];
    for (const l of this.vehLights) out.push({ x: l.x, y: l.y, r: 230, warm: 0.15 });
    // 画面の外でも光が届く範囲（約10タイル）までの焚き火・松明
    const [vx0, vy0, vx1, vy1] = this.vrect;
    for (const ob of this.objsIn(Math.floor(vx0 / TILE) - 10, Math.floor(vy0 / TILE) - 10, Math.ceil(vx1 / TILE) + 10, Math.ceil(vy1 / TILE) + 10)) {
      if (ob.kind === 'campfire' || ob.kind === 'fire') {
        const flick = 1 + Math.sin(this.time * 11) * 0.03 + Math.sin(this.time * 7.3 + 1) * 0.04;
        out.push({ x: (ob.tx + 0.5) * TILE, y: (ob.ty + 0.5) * TILE, r: 300 * flick, warm: 1 });
      } else if (ob.kind === 'flood' && ob.ready) {
        // 電気の通った投光器：白く広い光
        out.push({ x: (ob.tx + 0.5) * TILE, y: (ob.ty + 0.5) * TILE, r: 280, warm: 0 });
      } else if (ob.kind === 'torch') {
        const flick = 1 + Math.sin(this.time * 13 + ob.id) * 0.04 + Math.sin(this.time * 8.1 + ob.id * 2) * 0.04;
        out.push({ x: (ob.tx + 0.5) * TILE, y: (ob.ty + 0.5) * TILE, r: TORCH_LIGHT * flick, warm: 0.8 });
      }
    }
    return out;
  }

  private drawLighting(view: ViewState, dark: number, ox: number, oy: number): void {
    const horde = false;
    const { ctx } = this;
    const amb = ambientAt(view.minute);
    if (horde) {
      // 大襲撃の夜は血のような赤
      amb.r = 255;
      amb.g = 120;
      amb.b = 110;
      amb.a = 0.16;
    }
    // ---- 色温度（乗算で全体に色味をつける） ----
    // （CSS の multiply 重ね合わせで行う：キャンバスに全画面の乗算をしない）
    // 以前は暗闇より先に乗算していたので、夜は弱めて同じ見た目に合わせる
    const mix = (c: number) => Math.round(255 + (c - 255) * Math.min(1, amb.a * 2.2 * (1 - dark * 0.65)));
    this.setOv('tint', 'backgroundColor', amb.a > 0.005 ? `rgb(${mix(amb.r)},${mix(amb.g)},${mix(amb.b)})` : 'rgb(255,255,255)');
    if (dark > 0.01) {
      const l = this.lightCtx;
      const s = 0.5; // ライトマップの縮尺
      l.setTransform(1, 0, 0, 1, 0, 0);
      l.globalCompositeOperation = 'source-over';
      l.clearRect(0, 0, this.lightCanvas.width, this.lightCanvas.height);
      l.fillStyle = horde ? `rgba(30,4,8,${dark})` : `rgba(5,8,24,${dark})`;
      l.fillRect(0, 0, this.lightCanvas.width, this.lightCanvas.height);
      l.globalCompositeOperation = 'destination-out';
      l.setTransform(s, 0, 0, s, ox * s, oy * s);

      const hole = (x: number, y: number, r: number, a: number) => {
        const g = l.createRadialGradient(x, y, 0, x, y, r);
        g.addColorStop(0, `rgba(0,0,0,${a})`);
        g.addColorStop(0.45, `rgba(0,0,0,${a * 0.75})`);
        g.addColorStop(1, 'rgba(0,0,0,0)');
        l.fillStyle = g;
        l.beginPath();
        l.arc(x, y, r, 0, Math.PI * 2);
        l.fill();
      };
      /** 懐中電灯：角度の異なる扇を重ねて縁を柔らかくする */
      const cone = (x: number, y: number, ang: number, len: number) => {
        const layers: [number, number][] = [
          [0.2, 0.5],
          [0.3, 0.28],
          [0.42, 0.18],
          [0.56, 0.1],
        ];
        for (const [half, a] of layers) {
          const g = l.createRadialGradient(x, y, 6, x, y, len);
          g.addColorStop(0, `rgba(0,0,0,${a})`);
          g.addColorStop(0.5, `rgba(0,0,0,${a * 0.85})`);
          g.addColorStop(1, 'rgba(0,0,0,0)');
          l.fillStyle = g;
          l.beginPath();
          l.moveTo(x, y);
          l.arc(x, y, len, ang - half, ang + half);
          l.closePath();
          l.fill();
        }
      };

      for (const p of view.players) {
        if (p.status === 'dead') continue;
        hole(p.x, p.y, p.status === 'down' ? 85 : 120, 0.92);
        if (p.status !== 'alive') continue;
        cone(p.x + Math.cos(p.aim) * 12, p.y + Math.sin(p.aim) * 12, p.aim, 500);
        const a = this.pAnim.get(p.id);
        if (a && a.flash > 0) hole(p.x + Math.cos(p.aim) * 30, p.y + Math.sin(p.aim) * 30, 230, 0.95);
      }
      for (const ls of this.lightSources()) hole(ls.x, ls.y, ls.r, 1);

      ctx.save();
      ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
      ctx.imageSmoothingEnabled = true;
      ctx.drawImage(this.lightCanvas, 0, 0, this.w, this.h);
      ctx.restore();
    }
    // ---- 周辺減光（常時うっすら＋夜は強め）：CSS の重ね合わせ ----
    this.setOv('vig', 'opacity', (0.28 + dark * 0.25).toFixed(2));
  }

  /** 暗闇の上に重ねる光の色（焚き火・松明の暖色、懐中電灯の白色） */
  // ---------------- 地形（チャンク） ----------------

  /** 画面に映るチャンクの焼き込み済み地形を描く。少し先のチャンクも予約して、少しずつ焼き込む */
  private drawTerrainChunks(vx0: number, vy0: number, vx1: number, vy1: number): void {
    const cache = this.terrain;
    if (!cache) return;
    const CW = CHUNK * TILE;
    const cx0 = Math.floor(vx0 / CW);
    const cy0 = Math.floor(vy0 / CW);
    const cx1 = Math.floor(vx1 / CW);
    const cy1 = Math.floor(vy1 / CW);
    const ccx = this.cam.x / CW;
    const ccy = this.cam.y / CW;
    const wants: { cx: number; cy: number; pri: number }[] = [];
    // 画面の外側1チャンク分まで先読み（見えているものを最優先）
    for (let cy = cy0 - 1; cy <= cy1 + 1; cy++)
      for (let cx = cx0 - 1; cx <= cx1 + 1; cx++) {
        const vis = cx >= cx0 && cx <= cx1 && cy >= cy0 && cy <= cy1;
        wants.push({ cx, cy, pri: (vis ? 0 : 100) + Math.hypot(cx + 0.5 - ccx, cy + 0.5 - ccy) });
      }
    cache.want(wants);
    // 見えているのに未完成のチャンクがあれば多めに時間を使う
    let missing = 0;
    for (let cy = cy0; cy <= cy1; cy++)
      for (let cx = cx0; cx <= cx1; cx++) {
        const c = cache.get(cx, cy);
        if (c) this.ctx.drawImage(c, cx * CW, cy * CW, CW, CW);
        else {
          missing++;
          this.drawChunkPlaceholder(cx, cy);
        }
      }
    cache.pump(missing ? 10 : 4);
  }

  /** 焼き込み前のチャンク：ミニマップの色を拡大して仮に描く */
  private drawChunkPlaceholder(cx: number, cy: number): void {
    const CW = CHUNK * TILE;
    const ctx = this.ctx;
    if (this.miniCanvas && cx >= 0 && cy >= 0 && cx < CHUNKS_X && cy < CHUNKS_Y) {
      ctx.imageSmoothingEnabled = true;
      ctx.drawImage(this.miniCanvas, cx * CHUNK * 2, cy * CHUNK * 2, CHUNK * 2, CHUNK * 2, cx * CW, cy * CW, CW, CW);
    } else {
      ctx.fillStyle = '#2a2e20';
      ctx.fillRect(cx * CW, cy * CW, CW, CW);
    }
  }

  /** 外縁の汚染帯：地図の端に近いほど黄緑がかった霞を重ねる（地図の外の遠景につながる） */
  private drawEdgeHaze(vx0: number, vy0: number, vx1: number, vy1: number): void {
    const B = EDGE_BAND * TILE;
    const ctx = this.ctx;
    const band = (x: number, y: number, w: number, h: number, gx0: number, gy0: number, gx1: number, gy1: number) => {
      if (x > vx1 || y > vy1 || x + w < vx0 || y + h < vy0) return;
      const g = ctx.createLinearGradient(gx0, gy0, gx1, gy1);
      g.addColorStop(0, 'rgba(70,78,40,0.55)');
      g.addColorStop(0.5, 'rgba(70,78,40,0.2)');
      g.addColorStop(1, 'rgba(70,78,40,0)');
      ctx.fillStyle = g;
      ctx.fillRect(x, y, w, h);
    };
    band(0, 0, B, WORLD_H, 0, 0, B, 0);
    band(WORLD_W - B, 0, B, WORLD_H, WORLD_W, 0, WORLD_W - B, 0);
    band(0, 0, WORLD_W, B, 0, 0, 0, B);
    band(0, WORLD_H - B, WORLD_W, B, 0, WORLD_H, 0, WORLD_H - B);
  }

  // ---------------- 天候 ----------------

  private rain: { x: number; y: number; s: number }[] = [];
  /** 冬：雪の足跡（見えている人の通った跡。新しいほど濃い） */
  private prints: { x: number; y: number; a: number; t: number; side: number }[] = [];
  private printLast = new Map<number, { x: number; y: number; side: number }>();

  /** 冬：外の地面に雪を積もらせ、足跡を描く */
  private drawSnowGround(view: ViewState, vx0: number, vy0: number, vx1: number, vy1: number, dt: number): void {
    const { ctx } = this;
    const tx0 = Math.max(0, Math.floor(vx0 / TILE));
    const ty0 = Math.max(0, Math.floor(vy0 / TILE));
    const tx1 = Math.min(MAP_W - 1, Math.floor(vx1 / TILE));
    const ty1 = Math.min(MAP_H - 1, Math.floor(vy1 / TILE));
    ctx.fillStyle = 'rgba(228,234,242,0.42)';
    ctx.beginPath();
    for (let ty = ty0; ty <= ty1; ty++)
      for (let tx = tx0; tx <= tx1; tx++) {
        const t = this.world.terrainAt(tx, ty);
        if (t === T_WATER || t === T_SHALLOW || INDOOR_FLOORS.has(t) || t === T_WALL || t === T_WINDOW) continue;
        ctx.rect(tx * TILE, ty * TILE, TILE, TILE);
      }
    ctx.fill();
    // 足跡：歩いた人の後ろに左右交互
    const now = this.time;
    for (const p of view.players) {
      if (p.status === 'dead' || p.veh !== undefined) continue;
      if (INDOOR_FLOORS.has(this.world.terrainAt(Math.floor(p.x / TILE), Math.floor(p.y / TILE)))) continue;
      const last = this.printLast.get(p.id);
      if (!last || Math.hypot(last.x - p.x, last.y - p.y) > 16) {
        const side = last ? -last.side : 1;
        const a = last ? Math.atan2(p.y - last.y, p.x - last.x) : p.bodyAngle;
        this.prints.push({ x: p.x - Math.sin(a) * 5 * side, y: p.y + Math.cos(a) * 5 * side, a, t: now, side });
        this.printLast.set(p.id, { x: p.x, y: p.y, side });
      }
    }
    while (this.prints.length && now - this.prints[0].t > 30) this.prints.shift();
    if (this.prints.length > 900) this.prints.splice(0, this.prints.length - 900);
    for (const f of this.prints) {
      if (f.x < vx0 || f.y < vy0 || f.x > vx1 || f.y > vy1) continue;
      ctx.fillStyle = `rgba(70,78,90,${0.45 * (1 - (now - f.t) / 30)})`;
      ctx.beginPath();
      ctx.ellipse(f.x, f.y, 4.5, 2.6, f.a, 0, Math.PI * 2);
      ctx.fill();
    }
    void dt;
  }

  /** 冬の雪（晴れでも少し、雨・嵐の日は激しく） */
  private drawSnowfall(view: ViewState, dt: number): void {
    const { ctx, w, h } = this;
    const wet = view.weather === 'rain' || view.weather === 'storm' ? view.wx : 0;
    const want = Math.floor(70 + wet * (view.weather === 'storm' ? 420 : 240));
    while (this.rain.length < want) this.rain.push({ x: Math.random() * w, y: Math.random() * h, s: 0.5 + Math.random() * 0.9 });
    if (this.rain.length > want) this.rain.length = want;
    const vx = view.weather === 'storm' ? -160 : -30;
    ctx.fillStyle = 'rgba(240,246,255,0.75)';
    ctx.beginPath();
    for (const r of this.rain) {
      r.x += (vx + Math.sin(this.time * 1.3 + r.s * 9) * 18) * r.s * dt;
      r.y += 70 * r.s * dt;
      if (r.y > h || r.x < -20) {
        r.x = Math.random() * (w + 200);
        r.y = -10;
      }
      ctx.moveTo(r.x + 1.6 * r.s, r.y);
      ctx.arc(r.x, r.y, 1.6 * r.s, 0, Math.PI * 2);
    }
    ctx.fill();
    if (view.weather === 'storm') {
      ctx.fillStyle = `rgba(220,228,240,${0.12 * view.wx})`;
      ctx.fillRect(0, 0, w, h);
    }
  }
  private lightning = 0;

  /** 霧（白いもや）・雨（斜めの雨筋）・嵐（雨＋雷光）を画面に重ねる */
  private drawWeather(view: ViewState, dark: number, dt: number): void {
    const { ctx, w, h } = this;
    const k = view.wx;
    // 冬：雨の代わりに雪（霧の日は霧も重ねる）
    if (view.winter && view.weather !== 'fog') {
      this.lightning = 0;
      this.drawSnowfall(view, dt);
      return;
    }
    if (k <= 0.01) {
      this.lightning = 0;
      return;
    }
    if (view.weather === 'fog') {
      // 流れるもや
      const t = this.time * 0.03;
      ctx.save();
      for (let i = 0; i < 5; i++) {
        const fx = ((i * 0.27 + t * (0.6 + i * 0.15)) % 1.4) - 0.2;
        const fy = 0.15 + ((i * 0.37) % 0.8);
        const g = ctx.createRadialGradient(fx * w, fy * h, 0, fx * w, fy * h, Math.max(w, h) * 0.45);
        const a = (0.16 - dark * 0.08) * k;
        g.addColorStop(0, `rgba(190,196,190,${a})`);
        g.addColorStop(1, 'rgba(190,196,190,0)');
        ctx.fillStyle = g;
        ctx.fillRect(0, 0, w, h);
      }
      ctx.fillStyle = `rgba(150,158,152,${(0.16 - dark * 0.1) * k})`;
      ctx.fillRect(0, 0, w, h);
      ctx.restore();
      return;
    }
    // 雨・嵐
    const storm = view.weather === 'storm';
    ctx.fillStyle = `rgba(20,26,34,${(storm ? 0.22 : 0.12) * k})`;
    ctx.fillRect(0, 0, w, h);
    const want = Math.floor((storm ? 420 : 240) * k);
    while (this.rain.length < want) this.rain.push({ x: Math.random() * w, y: Math.random() * h, s: 0.6 + Math.random() * 0.8 });
    if (this.rain.length > want) this.rain.length = want;
    const vx = storm ? -260 : -120;
    const vy = 1100;
    ctx.strokeStyle = `rgba(190,205,220,${0.28 * k})`;
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (const r of this.rain) {
      r.x += vx * r.s * dt;
      r.y += vy * r.s * dt;
      if (r.y > h || r.x < -20) {
        r.x = Math.random() * (w + 200);
        r.y = -10;
      }
      ctx.moveTo(r.x, r.y);
      ctx.lineTo(r.x + vx * 0.018 * r.s, r.y + vy * 0.018 * r.s);
    }
    ctx.stroke();
    if (storm) {
      this.lightning = Math.max(0, this.lightning - dt * 3);
      if (Math.random() < dt * 0.12 * k) this.lightning = 1;
      if (this.lightning > 0) {
        ctx.fillStyle = `rgba(220,228,255,${this.lightning * 0.35 * (0.4 + dark)})`;
        ctx.fillRect(0, 0, w, h);
      }
    }
  }

  // ---------------- 補給物資 ----------------

  /** 投下地点の赤い発煙（霧の上に描くので遠くからでも見える） */
  private drawDropBeacon(view: ViewState): void {
    if (!view.drop) return;
    const { ctx } = this;
    const { x, y } = view.drop;
    for (let i = 0; i < 9; i++) {
      const ph = (this.time * 0.35 + i / 9) % 1;
      const r = 8 + ph * 34;
      ctx.fillStyle = `rgba(200,70,50,${0.32 * (1 - ph)})`;
      ctx.beginPath();
      ctx.arc(x + Math.sin(i * 2.1 + this.time) * 10 * ph + ph * 30, y - ph * 150, r, 0, Math.PI * 2);
      ctx.fill();
    }
    const pulse = 0.6 + Math.sin(this.time * 9) * 0.4;
    ctx.fillStyle = `rgba(255,90,60,${pulse})`;
    ctx.beginPath();
    ctx.arc(x, y - 4, 4, 0, Math.PI * 2);
    ctx.fill();
  }

  /** 画面外の補給物資の方向 */
  private drawDropIndicator(view: ViewState, me: PlayerSnap | undefined): void {
    if (!view.drop || !me) return;
    const { ctx, w, h } = this;
    const sx = view.drop.x - this.cam.x + w / 2;
    const sy = view.drop.y - this.cam.y + h / 2;
    if (sx > 40 && sy > 40 && sx < w - 40 && sy < h - 40) return;
    const cx = w / 2;
    const cy = h / 2;
    const ang = Math.atan2(sy - cy, sx - cx);
    const rx = w / 2 - 70;
    const ry = h / 2 - 150;
    const k = Math.min(rx / Math.max(1e-3, Math.abs(Math.cos(ang))), ry / Math.max(1e-3, Math.abs(Math.sin(ang))));
    const ex = cx + Math.cos(ang) * k;
    const ey = cy + Math.sin(ang) * k;
    ctx.save();
    ctx.translate(ex, ey);
    ctx.rotate(ang);
    ctx.fillStyle = '#d0603e';
    ctx.beginPath();
    ctx.moveTo(14, 0);
    ctx.lineTo(0, -7);
    ctx.lineTo(0, 7);
    ctx.closePath();
    ctx.fill();
    ctx.restore();
    const dist = Math.round(Math.hypot(view.drop.x - me.x, view.drop.y - me.y) / TILE);
    ctx.font = 'bold 10px "Noto Sans JP", "Segoe UI", sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.lineWidth = 3;
    ctx.strokeStyle = 'rgba(0,0,0,0.8)';
    ctx.strokeText(`補給物資 ${dist}m`, ex - Math.cos(ang) * 30, ey - Math.sin(ang) * 18);
    ctx.fillStyle = '#e8a080';
    ctx.fillText(`補給物資 ${dist}m`, ex - Math.cos(ang) * 30, ey - Math.sin(ang) * 18);
  }

  // ---------------- イベントログ ----------------

  /** 左上（チーム一覧の下）に最近の出来事を表示 */
  private drawFeed(fx: Effects, players: number): void {
    if (!fx.feed.length) return;
    const { ctx } = this;
    const x = 12;
    let y = 12 + 22 + 36 * players + 10;
    const CAT: Record<string, [string, string]> = {
      danger: ['危険', '#d0583e'],
      loot: ['入手', '#e0a33a'],
      up: ['強化', '#93b77c'],
      ally: ['仲間', '#7fa2bf'],
      info: ['情報', '#8c8872'],
    };
    ctx.textBaseline = 'middle';
    for (const f of fx.feed) {
      const [tag, col] = CAT[f.cat] ?? CAT.info;
      const a = Math.min(1, f.life / 1.2, (9 - f.life) * 5);
      ctx.globalAlpha = a;
      ctx.font = `bold 11px ${UI}`;
      const ft = this.kw(f.t);
      const tw = Math.min(430, ctx.measureText(ft).width) + 56;
      ctx.fillStyle = f.cat === 'danger' ? 'rgba(48,16,10,0.82)' : 'rgba(14,15,11,0.8)';
      ctx.fillRect(x, y, tw, 20);
      ctx.fillStyle = col;
      ctx.fillRect(x, y, 2, 20);
      chipBox(ctx, x + 7, y + 3, 34, 14, col, true);
      ctx.font = `bold 9px ${UI}`;
      ctx.fillStyle = '#15170f';
      ctx.textAlign = 'center';
      ctx.fillText(tag, x + 24, y + 10.5);
      ctx.textAlign = 'left';
      ctx.font = `bold 11px ${UI}`;
      ctx.fillStyle = f.cat === 'danger' ? '#f4b4a2' : '#e6e1cc';
      ctx.fillText(ft, x + 48, y + 10.5, 430);
      y += 23;
    }
    ctx.globalAlpha = 1;
  }

  private drawGlows(view: ViewState, dark: number): void {
    if (dark < 0.05) return;
    const { ctx } = this;
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    for (const ls of this.lightSources()) {
      const r = ls.r * 0.85;
      const g = ctx.createRadialGradient(ls.x, ls.y, 0, ls.x, ls.y, r);
      g.addColorStop(0, `rgba(255,150,60,${0.3 * dark * ls.warm})`);
      g.addColorStop(0.5, `rgba(255,110,40,${0.12 * dark * ls.warm})`);
      g.addColorStop(1, 'rgba(255,90,30,0)');
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.arc(ls.x, ls.y, r, 0, Math.PI * 2);
      ctx.fill();
    }
    // 懐中電灯の光束に舞うほこり
    for (const p of view.players) {
      if (p.status !== 'alive') continue;
      for (let i = 0; i < 18; i++) {
        const seed = i * 97.13 + p.id * 13.7;
        const dist = 40 + ((seed * 7.31 + this.time * (18 + (i % 5) * 6)) % 380);
        const off = Math.sin(seed + this.time * 0.6) * 0.32;
        const x = p.x + Math.cos(p.aim + off) * dist;
        const y = p.y + Math.sin(p.aim + off) * dist;
        const a2 = (0.25 + 0.25 * Math.sin(seed * 3 + this.time * 2)) * dark * (1 - dist / 440);
        ctx.fillStyle = `rgba(255,244,220,${Math.max(0, a2)})`;
        ctx.fillRect(x, y, 1.6, 1.6);
      }
    }
    for (const p of view.players) {
      if (p.status !== 'alive') continue;
      for (const [half, a] of [
        [0.22, 0.07],
        [0.4, 0.04],
      ] as const) {
        const len = 460;
        const g = ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, len);
        g.addColorStop(0, `rgba(255,244,210,${a * dark})`);
        g.addColorStop(1, 'rgba(255,244,210,0)');
        ctx.fillStyle = g;
        ctx.beginPath();
        ctx.moveTo(p.x, p.y);
        ctx.arc(p.x, p.y, len, p.aim - half, p.aim + half);
        ctx.closePath();
        ctx.fill();
      }
    }
    ctx.restore();
  }

  // ---------------- オーバーレイ ----------------

  private drawPlayerOverlay(p: PlayerSnap, isLocal: boolean, nameOff = 0): void {
    const { ctx } = this;
    const color = PLAYER_COLORS[p.id] ?? '#fff';
    const y = p.y - 32;
    ctx.font = 'bold 12px "Noto Sans JP", "Segoe UI", sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.lineWidth = 3;
    ctx.strokeStyle = 'rgba(0,0,0,0.8)';
    const label = isLocal ? `${p.name} (YOU)` : p.name;
    // ダウン中は残り時間の丸い表示があるので、名前はその上に出す
    if (p.status === 'down') nameOff += 16;
    ctx.strokeText(label, p.x, y - 10 - nameOff);
    ctx.fillStyle = color;
    ctx.fillText(label, p.x, y - 10 - nameOff);

    if (p.status === 'alive') {
      const w = 32;
      ctx.fillStyle = 'rgba(0,0,0,0.6)';
      ctx.fillRect(p.x - w / 2 - 1, y - 1, w + 2, 5);
      const r = clamp(p.hp / p.maxHp, 0, 1);
      ctx.fillStyle = r > 0.5 ? '#7fa35e' : r > 0.25 ? '#c9a85a' : '#c0573e';
      ctx.fillRect(p.x - w / 2, y, w * r, 3);
      if (p.reloadT > 0) {
        ctx.strokeStyle = '#c9a85a';
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.arc(p.x, p.y, 22, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * (1 - p.reloadT / WEAPONS[weaponOfSnap(p)].reloadTime));
        ctx.stroke();
      }
    } else if (p.status === 'down') {
      const r = clamp(p.downTimer / PLAYER.downTime, 0, 1);
      // 救助中は進み具合の輪だけにする（残り秒数と DOWN の文字は出さない）
      const reviving = p.reviveProgress > 0;
      if (!reviving) {
      ctx.lineWidth = 4;
      ctx.strokeStyle = 'rgba(0,0,0,0.6)';
      ctx.beginPath();
      ctx.arc(p.x, y - 2, 10, 0, Math.PI * 2);
      ctx.stroke();
      ctx.strokeStyle = r > 0.3 ? '#c88a4a' : '#b4483a';
      ctx.beginPath();
      ctx.arc(p.x, y - 2, 10, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * r);
      ctx.stroke();
      ctx.font = 'bold 9px sans-serif';
      ctx.fillStyle = '#fff';
      ctx.fillText(String(Math.ceil(p.downTimer)), p.x, y - 2);
      ctx.font = 'bold 11px sans-serif';
      ctx.fillStyle = Math.sin(this.time * 8) > 0 ? '#c0573e' : '#c9a09a';
      ctx.fillText('DOWN', p.x, p.y + 28);
      }
      if (reviving) {
        const rp = clamp(p.reviveProgress / PLAYER.reviveTime, 0, 1);
        ctx.lineWidth = 5;
        ctx.strokeStyle = 'rgba(125,255,176,0.25)';
        ctx.beginPath();
        ctx.arc(p.x, p.y, 26, 0, Math.PI * 2);
        ctx.stroke();
        ctx.strokeStyle = '#8fbf8a';
        ctx.beginPath();
        ctx.arc(p.x, p.y, 26, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * rp);
        ctx.stroke();
      } else {
        ctx.setLineDash([4, 6]);
        ctx.lineWidth = 1.5;
        ctx.strokeStyle = 'rgba(125,255,176,0.4)';
        ctx.beginPath();
        ctx.arc(p.x, p.y, PLAYER.reviveRange, this.time, this.time + Math.PI * 2);
        ctx.stroke();
        ctx.setLineDash([]);
      }
    } else {
      ctx.font = 'bold 10px sans-serif';
      ctx.fillStyle = '#9aa3b5';
      ctx.fillText('戦闘不能 - 朝に復帰', p.x, y);
    }
  }

  private drawZombieOverlays(zs: ZombieSnap[], dark: number, me: PlayerSnap | undefined): void {
    const { ctx } = this;
    for (const z of zs) {
      const r = ZOMBIE[z.type].radius;
      // 酸を吐く者の構え：喉が緑に光る／這う者の構え：足元に小さな警告
      if (z.tele === 4) {
        const g = 0.5 + Math.sin(this.time * 18) * 0.3;
        ctx.fillStyle = `rgba(160,230,80,${g * 0.5})`;
        ctx.beginPath();
        ctx.arc(z.x + Math.cos(z.angle) * r * 0.6, z.y + Math.sin(z.angle) * r * 0.6, r * 0.9, 0, Math.PI * 2);
        ctx.fill();
      } else if (z.tele === 3) {
        ctx.strokeStyle = `rgba(240,90,60,${0.5 + Math.sin(this.time * 30) * 0.4})`;
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.arc(z.x, z.y, r + 10, 0, Math.PI * 2);
        ctx.stroke();
      }
      // 巨像の予備動作：突進は向きの矢印、地鳴りは広がる輪（どちらも赤く点滅）
      if (z.type === 'titan' && z.tele) {
        const blink = 0.5 + Math.sin(this.time * 22) * 0.35;
        ctx.save();
        ctx.strokeStyle = `rgba(240,80,50,${blink})`;
        ctx.fillStyle = `rgba(240,80,50,${blink * 0.18})`;
        ctx.lineWidth = 4;
        if (z.tele === 2) {
          ctx.beginPath();
          ctx.arc(z.x, z.y, 160, 0, Math.PI * 2);
          ctx.fill();
          ctx.stroke();
        } else {
          const L = 420;
          const ca = Math.cos(z.angle);
          const sa = Math.sin(z.angle);
          ctx.beginPath();
          ctx.moveTo(z.x - sa * 30, z.y + ca * 30);
          ctx.lineTo(z.x - sa * 30 + ca * L, z.y + ca * 30 + sa * L);
          ctx.lineTo(z.x + sa * 30 + ca * L, z.y - ca * 30 + sa * L);
          ctx.lineTo(z.x + sa * 30, z.y - ca * 30);
          ctx.closePath();
          ctx.fill();
          ctx.stroke();
        }
        ctx.restore();
      }
      // 精鋭：紫の光の輪と名札
      if (z.elite) {
        const pulse = 0.55 + Math.sin(this.time * 5 + z.id) * 0.25;
        ctx.strokeStyle = `rgba(192,138,240,${pulse})`;
        ctx.lineWidth = 3;
        ctx.beginPath();
        ctx.arc(z.x, z.y, r + 6, 0, Math.PI * 2);
        ctx.stroke();
        ctx.font = 'bold 10px "Noto Sans JP", sans-serif';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.lineWidth = 3;
        ctx.strokeStyle = 'rgba(0,0,0,0.8)';
        const tag = `精鋭${z.trait ? `・${TRAIT_NAME[z.trait]}` : ''}`;
        ctx.strokeText(tag, z.x, z.y + r + 12);
        ctx.fillStyle = '#d6a8ff';
        ctx.fillText(tag, z.x, z.y + r + 12);
        // 再生中は緑の＋、突進の構えは赤い輪
        if (z.trait === 'regen' && z.hp < z.maxHp) {
          ctx.fillStyle = `rgba(120,230,120,${0.5 + Math.sin(this.time * 6) * 0.3})`;
          ctx.fillText('＋', z.x + r + 6, z.y - r);
        }
      }
      if (z.tele === 5) {
        ctx.strokeStyle = `rgba(240,90,60,${0.5 + Math.sin(this.time * 26) * 0.4})`;
        ctx.lineWidth = 3;
        ctx.beginPath();
        ctx.moveTo(z.x, z.y);
        ctx.lineTo(z.x + Math.cos(z.angle) * 160, z.y + Math.sin(z.angle) * 160);
        ctx.stroke();
      }
      if (z.hp < z.maxHp) {
        const w = z.type === 'titan' ? 0 : z.type === 'brute' ? 40 : 24;
        const y = z.y - r - 10;
        ctx.globalAlpha = dark > 0.5 ? 0.5 : 1;
        ctx.fillStyle = 'rgba(0,0,0,0.6)';
        ctx.fillRect(z.x - w / 2 - 1, y - 1, w + 2, 4);
        ctx.fillStyle = '#c94a3a';
        ctx.fillRect(z.x - w / 2, y, w * clamp(z.hp / z.maxHp, 0, 1), 2);
        ctx.globalAlpha = 1;
      }
      // 気づき具合：? = 物音を調べている / ! = 追跡中
      if (z.alert > 0) {
        const t = z.alert === 2 ? '!' : '?';
        const by = z.y - r - (z.hp < z.maxHp ? 22 : 14) + Math.sin(this.time * 6 + z.id) * 1.5;
        ctx.font = '900 15px "Noto Sans JP", "Segoe UI", sans-serif';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.lineWidth = 3;
        ctx.strokeStyle = 'rgba(0,0,0,0.75)';
        ctx.strokeText(t, z.x, by);
        ctx.fillStyle = z.alert === 2 ? '#e0644a' : '#d8bf6a';
        ctx.fillText(t, z.x, by);
      }
      // 暗闇で光る目
      if (dark > 0.3 && me && Math.hypot(z.x - me.x, z.y - me.y) < 650) {
        const a = Math.cos(z.angle);
        const b = Math.sin(z.angle);
        const ex = z.x + a * r * 0.45;
        const ey = z.y + b * r * 0.45;
        ctx.fillStyle = z.alert === 2 ? `rgba(240,90,60,${0.8 * dark})` : `rgba(230,220,120,${0.5 * dark})`;
        for (const sgn of [-1, 1]) {
          ctx.beginPath();
          ctx.arc(ex - b * r * 0.16 * sgn, ey + a * r * 0.16 * sgn, 1.8, 0, Math.PI * 2);
          ctx.fill();
        }
      }
    }
  }

  // ---------------- HUD ----------------

  private drawHUD(view: ViewState, o: RenderOptions, me: PlayerSnap | undefined, dark: number): void {
    const { ctx, w, h } = this;
    const fx = o.effects;
    // 追われているときは画面端がうっすら赤く脈打つ
    const horde = !!me && me.status === 'alive' && view.zombies.some((z) => z.alert === 2 && Math.hypot(z.x - me.x, z.y - me.y) < 420 && this.vision.isVisible(z.x, z.y));

    // 大襲撃：赤い空と画面端
    // 追われているときの赤い縁・被弾の赤：CSS の重ね合わせ（不透明度だけ毎フレーム変える）
    this.setOv('alert', 'opacity', horde ? (0.38 * (0.55 + Math.sin(this.time * 2.4) * 0.15)).toFixed(2) : '0');
    this.setOv('hurt', 'opacity', fx.hurt > 0 ? (0.35 * fx.hurt).toFixed(2) : '0');
    // 汚染度が高いと視界の縁が黄緑にかすむ
    const tx2 = me && me.status === 'alive' ? me.tox ?? 0 : 0;
    this.setOv('tox', 'opacity', tx2 > 10 ? Math.min(0.75, (tx2 - 10) / 90).toFixed(2) : '0');

    this.updateExplored(o.dt);
    if (!o.panelOpen) this.withUiScale(() => this.drawCompass(view, me, o.localId));
    if (!o.panelOpen) this.withUiScale(() => this.drawBossBar(view));
    // パネルを開いている間は入場通知を出さない（閉じたあとに古い通知が出ないよう捨てる）
    if (o.panelOpen) this.locToast = null;
    // 補給物資などの通知は、入場通知と同じ上部の細い帯で（入場通知が出ていなければすぐ）
    if (fx.notice && !this.locToast && !o.panelOpen) {
      this.locToast = { text: fx.notice.text, sub: fx.notice.sub, color: fx.notice.color, life: 4, kicker: 'NOTICE' };
      fx.notice = null;
    }
    this.toastDim = horde ? 0.4 : 1;
    this.withUiScale(() => this.drawLocationToast(me, o.dt, !!fx.banner));
    if (!o.panelOpen) {
      this.drawAllyIndicators(view, o.localId, o.effects);
      this.drawDropIndicator(view, me);
      this.withUiScale(() => this.drawFeed(fx, view.players.length));
    }
    this.drawHudLayer(view, o, me);
    this.autoQuality(o.dt);

    // ---- 中央メッセージ ----
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    if (me && me.status === 'down') {
      const rp = me.reviveProgress > 0 ? Math.round((me.reviveProgress / PLAYER.reviveTime) * 100) : 0;
      centerCard(ctx, w / 2, h * 0.3, 'DOWN — ダウン中', rp > 0 ? `仲間が救助中… ${rp}%　そのまま待て` : `味方の救助を待て　残り ${Math.ceil(me.downTimer)} 秒`, rp > 0 ? '#93d07c' : '#d0583e', this.time);
    } else if (me && me.sleeping) {
      ctx.fillStyle = 'rgba(4,6,12,0.62)';
      ctx.fillRect(0, 0, w, h);
      const act = view.players.filter((p) => !p.away && p.status !== 'dead');
      const n = act.filter((p) => p.sleeping).length;
      const sub = act.length > 1 ? `全員が眠ると朝になる（${n}/${act.length}人が就寝）　動くと起きる` : '朝まで眠る…　動くと起きる';
      centerCard(ctx, w / 2, h * 0.3, 'Zzz — 眠っている', sub, '#aab4c8', this.time);
    } else if (me && me.status === 'dead') {
      centerCard(ctx, w / 2, h * 0.3, 'K.I.A. — 戦闘不能', '仲間が朝（6:00）まで生き延びれば拠点で復帰する', '#8c8872', this.time);
    } else if (!o.panelOpen) {
      let hint: string | null = null;
      const reviving = !!me && view.players.some((p) => p.status === 'down' && p.reviveProgress > 0 && Math.hypot(p.x - me.x, p.y - me.y) <= PLAYER.reviveRange + 20);
      if (o.reviveHint && !reviving) hint = '[E] 長押しで蘇生';
      else if (o.interactHint) hint = o.interactHint;
      if (hint) keyHint(ctx, w / 2, h * 0.64, hint, o.reviveHint ? '#93b77c' : '#e0a33a', this.time);
    }
    if (me && me.veh !== undefined && !o.mapOpen) {
      const mv = (view.vehicles ?? []).find((v) => v.id === me.veh);
      if (mv) this.withUiScale(() => this.drawVehiclePanel(mv, me.seat === 0));
    }
    if (o.build && me && me.status === 'alive' && !o.mapOpen) {
      const b = o.build;
      this.withUiScale(() => this.drawBuildBar(view, b, me, !!o.touch));
    }

    // 朝まで眠った：暗転してから明ける
    if (fx.sleepFade > 0) {
      const t = fx.sleepFade / 2.2;
      ctx.globalAlpha = clamp(t * 1.6, 0, 1);
      ctx.fillStyle = '#05060a';
      ctx.fillRect(0, 0, w, h);
      ctx.fillStyle = '#c9d0de';
      ctx.font = `bold ${Math.round(22 * this.uiScale)}px ${UI}`;
      ctx.fillText(`DAY ${view.day} — 6:00　朝まで眠った`, w / 2, h * 0.42);
      ctx.globalAlpha = 1;
    }
    if (fx.banner && !o.panelOpen && !me?.sleeping) {
      const b = fx.banner;
      const t = b.life / b.maxLife;
      const appear = clamp((1 - t) * 8, 0, 1);
      const fade = clamp(t * 4, 0, 1);
      // 追われている最中は薄く（敵や地形を隠さない）
      ctx.globalAlpha = Math.min(appear, fade) * (horde ? 0.4 : 1);
      ctx.save();
      // 画面の上寄り・小さめに表示（視界の中央を空ける）
      ctx.translate(w / 2, Math.max(150, h * 0.19));
      const sc = (1 + (1 - appear) * 0.3) * 0.82;
      ctx.scale(sc, sc);
      // 横帯＋見出し
      ctx.font = `bold 15px ${UI}`;
      const bw = Math.max(420, ctx.measureText(b.sub).width + 80);
      const grd = ctx.createLinearGradient(-bw / 2, 0, bw / 2, 0);
      grd.addColorStop(0, 'rgba(12,13,10,0)');
      grd.addColorStop(0.2, 'rgba(12,13,10,0.78)');
      grd.addColorStop(0.8, 'rgba(12,13,10,0.78)');
      grd.addColorStop(1, 'rgba(12,13,10,0)');
      ctx.fillStyle = grd;
      ctx.fillRect(-bw / 2, -34, bw, 84);
      ctx.fillStyle = b.color;
      ctx.fillRect(-bw * 0.3, -34, bw * 0.6, 1);
      ctx.fillRect(-bw * 0.3, 49, bw * 0.6, 1);
      ctx.font = `bold 36px ${HEAD}`;
      ctx.lineWidth = 6;
      ctx.strokeStyle = 'rgba(0,0,0,0.55)';
      ctx.strokeText(b.text, 0, 0);
      ctx.fillStyle = b.color;
      ctx.fillText(b.text, 0, 0);
      ctx.font = `bold 14px ${UI}`;
      ctx.fillStyle = '#e6e1cc';
      ctx.fillText(b.sub, 0, 32);
      ctx.restore();
      ctx.globalAlpha = 1;
    }

    // 地図を開いている間は照準・弾数を描かない（地図の上に重ねない）
    if (o.mapOpen) {
      this.drawWorldMap(view, o.localId);
      return;
    }
    // パネルを開いている間はマウスカーソルで操作するので照準は出さない
    if (o.panelOpen) return;

    // ---- クロスヘア（連射で広がる） ----
    const cx = o.mouseX;
    const cy = o.mouseY;
    // HUD パネルの上では、文字に重ならない小さなカーソルだけにする
    if (this.hudRects.some((r) => cx >= r.x && cx <= r.x + r.w && cy >= r.y && cy <= r.y + r.h)) {
      ctx.strokeStyle = 'rgba(0,0,0,0.7)';
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.arc(cx, cy, 3, 0, Math.PI * 2);
      ctx.stroke();
      ctx.strokeStyle = '#e6e1cc';
      ctx.lineWidth = 1.5;
      ctx.stroke();
      return;
    }
    const alive = me && me.status === 'alive';
    const held = me ? heldWeapon({ ...me, tool: o.localTool }) : null;
    const isGun = !!held;
    const col = alive ? (PLAYER_COLORS[o.localId] ?? '#fff') : '#777';
    ctx.lineWidth = 2;
    ctx.strokeStyle = 'rgba(0,0,0,0.6)';
    const drawCross = () => {
      ctx.beginPath();
      if (isGun) {
        const sg = held?.id === 'shotgun' && !held.w.ap;
        const g = (sg && !held?.w.ap ? 12 : 4) + (held ? (effectiveStats(held.id, held.w).spread + (me?.heat ?? 0)) * 60 : 0) + this.bloom * 8;
        const len = 8;
        ctx.moveTo(cx - g - len, cy);
        ctx.lineTo(cx - g, cy);
        ctx.moveTo(cx + g, cy);
        ctx.lineTo(cx + g + len, cy);
        ctx.moveTo(cx, cy - g - len);
        ctx.lineTo(cx, cy - g);
        ctx.moveTo(cx, cy + g);
        ctx.lineTo(cx, cy + g + len);
        if (sg) {
          ctx.moveTo(cx + g + 4, cy);
          ctx.arc(cx, cy, g + 4, 0, Math.PI * 2);
        }
      } else {
        ctx.arc(cx, cy, 5, 0, Math.PI * 2);
      }
      ctx.stroke();
    };
    ctx.lineWidth = 4;
    drawCross();
    ctx.strokeStyle = col;
    ctx.lineWidth = 2;
    drawCross();
    ctx.fillStyle = '#fff';
    ctx.fillRect(cx - 1, cy - 1, 2, 2);
    // 命中・撃破の×印
    const hm = o.effects.hitMark;
    if (hm.t > 0) {
      const k = hm.kill ? hm.t / 0.32 : hm.t / 0.14;
      const r0 = hm.kill ? 7 : 6;
      const r1 = r0 + (hm.kill ? 9 : 6) * (0.6 + 0.4 * k);
      ctx.globalAlpha = Math.min(1, k * 1.6);
      for (const [col, lw] of [
        ['rgba(0,0,0,0.6)', 4],
        [hm.kill ? '#ff5a3c' : '#ffffff', 2],
      ] as [string, number][]) {
        ctx.strokeStyle = col;
        ctx.lineWidth = lw;
        ctx.beginPath();
        for (const [sx, sy] of [
          [1, 1],
          [1, -1],
          [-1, 1],
          [-1, -1],
        ]) {
          ctx.moveTo(cx + sx * r0, cy + sy * r0);
          ctx.lineTo(cx + sx * r1, cy + sy * r1);
        }
        ctx.stroke();
      }
      ctx.globalAlpha = 1;
    }
    // リロードの進み具合（照準のまわりの輪）
    if (me && held && alive && me.reloadT > 0) {
      const total = effectiveStats(held.id, held.w).reloadTime * skillMods(me.xp).reloadMul;
      const f = clamp(1 - me.reloadT / Math.max(0.01, total), 0, 1);
      ctx.lineWidth = 3;
      ctx.strokeStyle = 'rgba(0,0,0,0.55)';
      ctx.beginPath();
      ctx.arc(cx, cy, 20, 0, Math.PI * 2);
      ctx.stroke();
      ctx.strokeStyle = '#e0a33a';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(cx, cy, 20, -Math.PI / 2, -Math.PI / 2 + f * Math.PI * 2);
      ctx.stroke();
    }
    if (me && held && alive) {
      ctx.font = `12px ${MONO}`;
      ctx.textAlign = 'left';
      ctx.textBaseline = 'middle';
      const st = effectiveStats(held.id, held.w);
      const mag = held.w.mag;
      const res = countItem(me.bag, st.ammo);
      // 残りわずかは黄色、空は赤
      ctx.fillStyle = mag === 0 ? '#e06050' : mag <= Math.ceil(st.magSize * 0.25) ? '#e0b040' : '#e6ebf5';
      const txt = me.reloadT > 0 ? 'RELOAD…' : `${mag}/${res}${held.w.ap ? ' AP' : ''}`;
      // HUD パネルや画面の端に重ならない位置を選ぶ（右下→左下→右上→左上）。どこも重なるなら出さない
      const tw = ctx.measureText(txt).width;
      const hit = (x: number, y: number) =>
        x < 4 || y < 4 || x + tw > this.w - 4 || y + 14 > this.h - 4 || this.hudRects.some((r) => x < r.x + r.w && x + tw > r.x && y < r.y + r.h && y + 14 > r.y);
      const spots: [number, number][] = [
        [cx + 16, cy + 9],
        [cx - 16 - tw, cy + 9],
        [cx + 16, cy - 23],
        [cx - 16 - tw, cy - 23],
      ];
      const spot = spots.find(([x, y]) => !hit(x, y));
      if (spot) {
        ctx.lineWidth = 3;
        ctx.strokeStyle = 'rgba(0,0,0,0.7)';
        ctx.strokeText(txt, spot[0], spot[1] + 7);
        ctx.fillText(txt, spot[0], spot[1] + 7);
      }
    }
    void dark;
  }

  /** HUD のパネル類を別キャンバスに描く。約15Hz、または持ち替え・状態変化のときだけ描き直す */
  /** HUD パネルの矩形（最後に HUD レイヤーを描いたとき） */
  private hudRects: { x: number; y: number; w: number; h: number }[] = [];

  private drawHudLayer(view: ViewState, o: RenderOptions, me: PlayerSnap | undefined): void {
    this.hudT -= o.dt;
    const key = `${o.localTool}|${me?.status}|${this.w}x${this.h}|${view.players.length}|${o.panelOpen ? 1 : 0}`;
    if (this.hudT > 0 && key === this.hudKey) return;
    this.hudT = 1 / 15;
    this.hudKey = key;
    const main = this.ctx;
    const ctx = this.hudCtx;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, this.hudCanvas.width, this.hudCanvas.height);
    ctx.setTransform(this.baseDpr, 0, 0, this.baseDpr, 0, 0);
    this.ctx = ctx;
    panelLog = [];
    // 小さい画面では HUD 全体を縮小して描く（仮想的な大きさ w/s × h/s で配置）
    const us = this.uiScale;
    ctx.scale(us, us);
    const realW = this.w;
    const realH = this.h;
    this.w = realW / us;
    this.h = realH / us;
    try {
      this.drawClock(view, me);
      this.drawTeam(view, o.localId);
      if (me) this.drawSelfPanel(view, me);
      this.drawHotbar(o, view);
      this.drawMinimap(view, o.localId);
      this.tutH = 0;
      // 縦が足りない枠（画面分割）・スマホでは、救助・はじめの一日・依頼を 1 行ずつに
      const slim = !!o.touch || this.h < 600;
      if (!o.mapOpen) this.drawRescue(view, slim);
      if (me && !o.mapOpen) this.drawTutorial(view, me, slim);
      if (me && !o.mapOpen) this.drawJobs(view, me, slim);
      // モード表示
      ctx.font = `10px ${MONO}`;
      ctx.textAlign = 'left';
      ctx.textBaseline = 'middle';
      ctx.fillStyle = 'rgba(189,183,158,0.6)';
      const modeLabel = o.mode === 'solo' ? 'SOLO OPS' : `${o.mode.toUpperCase()} / ROOM ${o.roomCode ?? ''}`;
      const q = this.renderScale < 1 ? `  RES ${Math.round(this.renderScale * 100)}%` : '';
      ctx.fillText(
        `● ${modeLabel}` + (o.syncMs ? `  SYNC ${Math.round(o.syncMs)}ms` : '') + (o.muted ? '  SND OFF [M]' : '  SND ON [M]') + '  PING [G]' + q,
        14,
        this.h - 14,
      );
    } finally {
      this.ctx = main;
      // 上部中央のコンパスも避ける領域に含める（縮小した分を実際の画面の座標に戻す）
      const cw = Math.max(260, Math.min(460, this.w - 640));
      this.hudRects = [...(panelLog ?? []), { x: this.w / 2 - cw / 2, y: 0, w: cw, h: 48 }].map((r) => ({ x: r.x * us, y: r.y * us, w: r.w * us, h: r.h * us }));
      panelLog = null;
      this.w = realW;
      this.h = realH;
    }
  }

  /** ロケーションに入ったときの表示（例：「警察署 ★★★ 危険」） */
  private curDist: string | null = null;
  private toastDim = 1;

  private drawLocationToast(me: PlayerSnap | undefined, dt: number, bannerShown: boolean): void {
    if (me) {
      const loc = locationAt(this.world.locations, Math.floor(me.x / TILE), Math.floor(me.y / TILE));
      const key = loc ? `${loc.name}${loc.x},${loc.y}` : null;
      if (key !== this.curLoc) {
        this.curLoc = key;
        if (loc) {
          const danger = loc.hot ? '汚染地帯：手強い個体が多いが、レア物資が眠っている' : loc.tier >= 4 ? '最深部：重装の感染兵士が群れる。最高級の物資と、帰り道の危険' : loc.tier >= 3 ? '危険：感染兵士が多数・武器や軍用物資' : loc.tier === 2 ? 'やや危険：弾薬・薬品・パーツが見つかる' : loc.kind === 'base' ? '安全地帯：倉庫・作業台・焚き火' : '比較的安全：食料・布・日用品';
          this.locToast = { text: `${loc.name}  ${'★'.repeat(loc.tier)}`, sub: danger, color: loc.hot ? '#d090c8' : loc.tier >= 4 ? '#e05a40' : loc.tier >= 3 ? '#c98070' : loc.tier === 2 ? '#d8c48a' : '#a9c79c', life: 3.5 };
        } else this.locToast = null; // その場所を出たら古い表示は出さない
      }
      // 地区（住宅街・工業地区など）が変わったら、屋外にいるときだけ知らせる
      const dist = districtAt(this.world.districts, Math.floor(me.x / TILE), Math.floor(me.y / TILE));
      const dkey = dist?.name ?? null;
      if (dkey !== this.curDist) {
        this.curDist = dkey;
        if (dist && !loc) {
          const info = DISTRICT_INFO[dist.kind];
          this.locToast = { text: `${dist.name}  ${'★'.repeat(dist.tier)}`, sub: `物資：${info.loot}　脅威：${info.threat}`, sub2: `推奨：${info.advice}`, color: info.color, life: 4 };
        }
      }
    }
    if (!this.locToast) return;
    // 「DAY 1」などの大きな表示と重ならないよう、それが消えるまで待ってから出す
    if (bannerShown) return;
    const t = this.locToast;
    t.life -= dt;
    if (t.life <= 0) {
      this.locToast = null;
      return;
    }
    const { ctx, w } = this;
    ctx.globalAlpha = Math.min(1, t.life, (4.5 - t.life) * 4) * this.toastDim;
    // 場所に入ったときの表示：上部中央の細い帯
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.font = `bold 12px ${UI}`;
    const bw = Math.max(300, ctx.measureText(t.sub).width + 60, t.sub2 ? ctx.measureText(t.sub2).width + 60 : 0);
    const y = 96;
    const bh = t.sub2 ? 64 : 50;
    ctx.fillStyle = 'rgba(12,13,10,0.78)';
    ctx.fillRect(w / 2 - bw / 2, y - 22, bw, bh);
    brackets(ctx, w / 2 - bw / 2, y - 22, bw, bh, t.color, 8, 1.5);
    ctx.font = `9px ${MONO}`;
    ctx.fillStyle = 'rgba(189,183,158,0.7)';
    ctx.fillText(t.kicker ?? 'ENTERING AREA', w / 2, y - 12);
    ctx.font = `bold 18px ${UI}`;
    ctx.fillStyle = t.color;
    ctx.fillText(t.text, w / 2, y + 4);
    ctx.font = `bold 11px ${UI}`;
    ctx.fillStyle = '#d8d2b8';
    ctx.fillText(this.kw(t.sub), w / 2, y + 19);
    if (t.sub2) {
      ctx.fillStyle = '#e0b862';
      ctx.fillText(t.sub2, w / 2, y + 33);
    }
    ctx.globalAlpha = 1;
  }

  /** ピンの目印（世界座標） */
  /** ピンを立てた人の名前（id → 名前） */
  private pingNames = new Map<number, string>();

  private drawPingMarkers(fx: Effects, me?: PlayerSnap): void {
    const { ctx } = this;
    for (const p of fx.pings) {
      const col = p.t === 'enemy' ? '#c0573e' : p.t === 'loot' ? '#c9a85a' : (PLAYER_COLORS[p.id] ?? '#fff');
      const a = Math.min(1, p.life);
      const bounce = Math.abs(Math.sin(this.time * 4)) * 6;
      ctx.globalAlpha = a;
      ctx.strokeStyle = col;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.ellipse(p.x, p.y, 16 + Math.sin(this.time * 5) * 3, 9, 0, 0, Math.PI * 2);
      ctx.stroke();
      // 逆さのしずく型のピン
      const py = p.y - 26 - bounce;
      ctx.fillStyle = col;
      ctx.beginPath();
      ctx.moveTo(p.x, p.y - 6 - bounce);
      ctx.arc(p.x, py, 9, Math.PI * 0.25, Math.PI * 0.75, true);
      ctx.closePath();
      ctx.fill();
      ctx.fillStyle = '#111';
      ctx.font = 'bold 10px sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(p.t === 'enemy' ? '!' : p.t === 'loot' ? '$' : '▼', p.x, py);
      // 何のピンか・誰が立てたか・どれくらい離れているか
      const who = this.pingNames.get(p.id) ?? '';
      const dist = me ? `${Math.round(Math.hypot(p.x - me.x, p.y - me.y) / TILE)}m` : '';
      const label = `${p.t === 'enemy' ? '敵！' : p.t === 'loot' ? '物資' : 'ここへ'}${who ? `（${who}）` : ''} ${dist}`;
      ctx.font = `bold 11px ${UI}`;
      ctx.lineWidth = 3;
      ctx.strokeStyle = 'rgba(0,0,0,0.75)';
      ctx.strokeText(label, p.x, py - 18);
      ctx.fillStyle = col;
      ctx.fillText(label, p.x, py - 18);
      ctx.globalAlpha = 1;
    }
  }

  /** 画面外の仲間・ピンを画面端の矢印で示す。ダウン中の仲間は SOS */
  private drawAllyIndicators(view: ViewState, localId: number, fx: Effects): void {
    const { ctx, w, h } = this;
    const me = view.players.find((p) => p.id === localId);
    const margin = 46;
    const edge = (wx: number, wy: number): { x: number; y: number; ang: number; off: boolean } => {
      const sx = wx - this.cam.x + w / 2;
      const sy = wy - this.cam.y + h / 2;
      const off = sx < 20 || sy < 20 || sx > w - 20 || sy > h - 20;
      // HUD（上のチーム一覧・時計・ミニマップ、下のホットバー・ステータス）を避けた安全な矩形
      const top = 240;
      const bottom = h - 175;
      const left = margin;
      const right = w - margin;
      const cx = w / 2;
      const cy = (top + bottom) / 2;
      const ang = Math.atan2(sy - cy, sx - cx);
      const kx = ((right - left) / 2) / Math.max(1e-3, Math.abs(Math.cos(ang)));
      const ky = ((bottom - top) / 2) / Math.max(1e-3, Math.abs(Math.sin(ang)));
      const k = Math.min(kx, ky);
      return { x: cx + Math.cos(ang) * k, y: cy + Math.sin(ang) * k, ang, off };
    };
    for (const p of view.players) {
      if (p.id === localId || p.status === 'dead') continue;
      const e = edge(p.x, p.y);
      const down = p.status === 'down';
      if (!e.off && !down) continue;
      const col = PLAYER_COLORS[p.id] ?? '#fff';
      const dist = me ? Math.round(Math.hypot(p.x - me.x, p.y - me.y) / TILE) : 0;
      if (e.off) {
        ctx.save();
        ctx.translate(e.x, e.y);
        const pulse = down ? 1 + Math.sin(this.time * 8) * 0.15 : 1;
        ctx.scale(pulse, pulse);
        ctx.rotate(e.ang);
        ctx.fillStyle = down ? '#b03a2e' : col;
        ctx.beginPath();
        ctx.moveTo(22, 0);
        ctx.lineTo(10, -8);
        ctx.lineTo(10, 8);
        ctx.closePath();
        ctx.fill();
        ctx.restore();
        ctx.fillStyle = 'rgba(10,12,16,0.8)';
        ctx.beginPath();
        ctx.arc(e.x, e.y, 14, 0, Math.PI * 2);
        ctx.fill();
        ctx.strokeStyle = down ? '#b03a2e' : col;
        ctx.lineWidth = 2;
        ctx.stroke();
        ctx.font = 'bold 11px "Noto Sans JP", "Segoe UI", sans-serif';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillStyle = down ? '#c98070' : col;
        ctx.fillText(down ? 'SOS' : p.name.slice(0, 2), e.x, e.y);
        ctx.font = 'bold 10px "Noto Sans JP", "Segoe UI", sans-serif';
        ctx.lineWidth = 3;
        ctx.strokeStyle = 'rgba(0,0,0,0.8)';
        const label = down ? `${p.name} 助けて！ ${dist}m・残り${Math.ceil(p.downTimer)}s` : `${p.name} ${dist}m`;
        ctx.strokeText(label, e.x, e.y + 24);
        ctx.fillStyle = '#fff';
        ctx.fillText(label, e.x, e.y + 24);
      } else {
        // 画面内のダウン中の仲間：頭上に大きな SOS
        const sx = p.x - this.cam.x + w / 2;
        const sy = p.y - this.cam.y + h / 2 - 84;
        // すぐそばにいるときは画面下の「[E] 長押しで蘇生」と重複するので進捗だけ出す
        if (me && Math.hypot(p.x - me.x, p.y - me.y) <= PLAYER.reviveRange && p.reviveProgress <= 0) continue;
        // 救助中は足元の輪が進み具合を示すので、頭上の文字は出さない（情報を詰め込みすぎない）
        if (p.reviveProgress > 0) continue;
        const pulse = 0.7 + Math.sin(this.time * 8) * 0.3;
        ctx.font = '900 16px "Noto Sans JP", "Segoe UI", sans-serif';
        ctx.textAlign = 'center';
        ctx.lineWidth = 4;
        ctx.strokeStyle = 'rgba(0,0,0,0.8)';
        const txt = p.reviveProgress > 0 ? `救助中… ${Math.round((p.reviveProgress / PLAYER.reviveTime) * 100)}%` : `SOS [E]長押しで蘇生 ${dist}m`;
        ctx.strokeText(txt, sx, sy);
        ctx.fillStyle = p.reviveProgress > 0 ? '#9fe08a' : `rgba(255,90,90,${pulse})`;
        ctx.fillText(txt, sx, sy);
      }
    }
    // 画面外のピン
    for (const p of fx.pings) {
      const e = edge(p.x, p.y);
      if (!e.off) continue;
      const col = p.t === 'enemy' ? '#c0573e' : p.t === 'loot' ? '#c9a85a' : (PLAYER_COLORS[p.id] ?? '#fff');
      ctx.globalAlpha = Math.min(1, p.life);
      ctx.save();
      ctx.translate(e.x, e.y);
      ctx.rotate(e.ang);
      ctx.strokeStyle = col;
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.moveTo(4, -7);
      ctx.lineTo(14, 0);
      ctx.lineTo(4, 7);
      ctx.stroke();
      ctx.restore();
      ctx.font = 'bold 10px "Noto Sans JP", "Segoe UI", sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillStyle = col;
      ctx.fillText(p.t === 'enemy' ? '敵！' : p.t === 'loot' ? '物資' : 'ここ', e.x, e.y - 14);
      ctx.globalAlpha = 1;
    }
  }

  private drawClock(view: ViewState, me?: PlayerSnap): void {
    const { ctx, w } = this;
    const pw = 300;
    const ph = 62;
    const x = w - pw - 12;
    const y = 12;
    panel(ctx, x, y, pw, ph);
    // 時刻（等幅）と昼夜
    const night = view.phase === 'night';
    ctx.textBaseline = 'alphabetic';
    ctx.textAlign = 'left';
    ctx.font = `22px ${MONO}`;
    ctx.fillStyle = night ? '#b4c0d4' : '#efe6c4';
    ctx.fillText(formatClock(view.minute), x + 12, y + 28);
    ctx.font = `11px ${MONO}`;
    ctx.fillStyle = '#8c8872';
    ctx.fillText(`DAY ${String(view.day).padStart(2, '0')}`, x + 84, y + 27);
    // 右上のバッジ：昼夜・天候
    let bx = x + pw - 10;
    const badge = (t: string, c: string, fill = false) => {
      ctx.font = `bold 10px ${UI}`;
      const tw = ctx.measureText(t).width + 12;
      bx -= tw;
      chipBox(ctx, bx, y + 11, tw, 17, c, fill);
      ctx.fillStyle = fill ? '#15170f' : c;
      ctx.textAlign = 'center';
      ctx.fillText(t, bx + tw / 2, y + 23);
      ctx.textAlign = 'left';
      bx -= 4;
    };
    if (view.horde) badge('大群', '#e0583e', Math.sin(this.time * 6) > 0);
    if (view.wx > 0.3 && view.weather !== 'clear') badge({ fog: '霧', rain: '雨', storm: '嵐', clear: '' }[view.weather], '#9fb4c8');
    badge(night ? '☾ 夜' : '☀ 昼', night ? '#9fb4c8' : '#e0a33a', !night);

    // 時間バー（昼=アンバー / 夜=青）＋目盛り
    const bx0 = x + 12;
    const bw = pw - 24;
    const by = y + 36;
    const dayFrac = DAY_SECONDS / CYCLE_SECONDS;
    ctx.fillStyle = 'rgba(224,163,58,0.35)';
    ctx.fillRect(bx0, by, bw * dayFrac, 3);
    ctx.fillStyle = 'rgba(110,140,190,0.4)';
    ctx.fillRect(bx0 + bw * dayFrac, by, bw * (1 - dayFrac), 3);
    ctx.fillStyle = 'rgba(230,225,204,0.3)';
    for (let k = 0; k <= 12; k++) ctx.fillRect(bx0 + (bw * k) / 12, by + 4, 1, k % 3 === 0 ? 3 : 2);
    const m = view.minute;
    const cyc = m >= 360 && m < 1200 ? ((m - 360) / 840) * dayFrac : dayFrac + (((m - 1200 + 1440) % 1440) / 600) * (1 - dayFrac);
    const px = bx0 + bw * clamp(cyc, 0, 1);
    ctx.fillStyle = '#efe6c4';
    ctx.beginPath();
    ctx.moveTo(px, by - 1);
    ctx.lineTo(px - 4, by - 6);
    ctx.lineTo(px + 4, by - 6);
    ctx.closePath();
    ctx.fill();

    // 現在地と危険度、拠点までの距離と方角（帰還の判断用）
    let sub = '野外';
    let col = '#bdb79e';
    let tag = '';
    if (me) {
      const tx = Math.floor(me.x / TILE);
      const ty = Math.floor(me.y / TILE);
      const loc = locationAt(this.world.locations, tx, ty);
      const d = Math.hypot(tx - BASE_TX, ty - BASE_TY);
      const tier = loc && loc.kind !== 'base' ? loc.tier : tierAtDistance(d);
      const edge = edgeDistance(tx, ty) < EDGE_BAND;
      if (loc?.kind === 'base' && view.horde) {
        sub = '拠点 — 大群が侵入してくる';
        col = '#e0583e';
        tag = 'DANGER';
      } else if (loc?.kind === 'base') {
        sub = '拠点 — 安全地帯';
        col = '#93b77c';
        tag = 'SAFE';
      } else {
        const dist = districtAt(this.world.districts, tx, ty);
        const tt = this.world.terrainAt(tx, ty);
        const F = this.world.features;
        const onRoad = tt === T_ROAD;
        const bridge = tt === T_BRIDGE ? F.bridges.find((b) => tx >= b.x && tx < b.x + b.w && ty >= b.y && ty < b.y + b.h) : undefined;
        const hwy = onRoad || tt === T_BRIDGE ? F.highways.find((h) => (h.horiz ? ty >= h.at && ty < h.at + h.w : tx >= h.at && tx < h.at + h.w)) : undefined;
        const stars = '★'.repeat(tier);
        sub = loc
          ? loc.name
          : edge
            ? '外縁の汚染帯'
            : bridge
              ? `${bridge.name}（${F.river?.name ?? '川'}）${stars}`
              : tt === T_SHALLOW
                ? '浅瀬 — 足が遅くなる'
                : hwy
                  ? `${hwy.name} ${stars}`
                  : onRoad && this.world.vec[ty * MAP_W + tx]
                    ? `旧道 ${stars}`
                    : dist
                      ? `${dist.name} ${stars}`
                      : `${onRoad ? '幹線道路' : '野外'} ${stars}`;
        col = edge || loc?.hot ? '#c8d070' : tier >= 4 ? '#e05a40' : tier >= 3 ? '#e07a5e' : tier === 2 ? '#e0b862' : '#bdb79e';
        // 拠点はどっち？（拠点から見た自分の方角の逆）
        const back = directionName(BASE_TX * 2 - tx, BASE_TY * 2 - ty);
        tag = `⌂ ${Math.round(d)}m ${back}`;
      }
    }
    ctx.font = `bold 11px ${UI}`;
    ctx.fillStyle = col;
    ctx.fillText(sub, x + 12, y + 55, pw - 80);
    if (tag) {
      ctx.textAlign = 'right';
      ctx.fillText(tag, x + pw - 12, y + 55);
      ctx.textAlign = 'left';
    }
  }

  private drawTeam(view: ViewState, localId: number): void {
    const { ctx } = this;
    const pw = 224;
    const rowH = 36;
    const x = 12;
    const y0 = 12;
    panel(ctx, x, y0, pw, 22 + rowH * view.players.length);
    ctx.font = `10px ${MONO}`;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = '#e0a33a';
    ctx.fillText('// SQUAD', x + 10, y0 + 11);
    ctx.fillStyle = '#8c8872';
    ctx.textAlign = 'right';
    ctx.fillText(`${view.players.filter((p) => p.status !== 'dead').length}/${view.players.length} ACTIVE`, x + pw - 10, y0 + 11);
    view.players.forEach((p, i) => {
      const y = y0 + 22 + i * rowH;
      const color = PLAYER_COLORS[p.id];
      ctx.fillStyle = 'rgba(255,255,240,0.03)';
      ctx.fillRect(x + 6, y, pw - 12, rowH - 4);
      ctx.fillStyle = color;
      ctx.fillRect(x + 6, y, 3, rowH - 4);
      // 右側のキル数・所持数の幅を先に測り、名前と「YOU」はその手前に収める
      const stat = `K${p.kills} ▣${p.bag.filter((b) => b).length}`;
      ctx.font = `10px ${MONO}`;
      const statW = ctx.measureText(stat).width;
      ctx.font = `9px ${MONO}`;
      const youW = p.id === localId ? ctx.measureText('YOU').width + 8 : 0;
      const nameMax = pw - 15 - 12 - statW - 10 - youW;
      ctx.textAlign = 'left';
      ctx.font = `bold 12px ${UI}`;
      ctx.fillStyle = '#e6e1cc';
      ctx.fillText(p.name, x + 15, y + 9, nameMax);
      const nameW = Math.min(nameMax, ctx.measureText(p.name).width);
      if (p.id === localId) {
        ctx.font = `9px ${MONO}`;
        ctx.fillStyle = '#93b77c';
        ctx.fillText('YOU', x + 15 + nameW + 6, y + 9.5);
      }
      ctx.textAlign = 'right';
      ctx.font = `10px ${MONO}`;
      ctx.fillStyle = '#8c8872';
      ctx.fillText(stat, x + pw - 12, y + 9);
      const bw = pw - 30;
      if (p.sleeping && p.status === 'alive') {
        ctx.textAlign = 'left';
        ctx.font = `bold 10px ${UI}`;
        ctx.fillStyle = '#aab4c8';
        ctx.fillText('💤 拠点のベッドで就寝中', x + 15, y + 22);
      } else if (p.away) {
        ctx.textAlign = 'left';
        ctx.font = `bold 10px ${UI}`;
        ctx.fillStyle = '#c9a050';
        ctx.fillText(`通信切断中 — 再接続を待っています${'.'.repeat(1 + (Math.floor(this.time * 2) % 3))}`, x + 15, y + 22);
      } else if (p.status === 'alive') {
        segBar(ctx, x + 15, y + 18, bw, 5, p.hp / p.maxHp, p.hp / p.maxHp > 0.3 ? color : '#d0583e', 20);
        ctx.fillStyle = 'rgba(255,255,255,0.08)';
        ctx.fillRect(x + 15, y + 26, bw, 2);
        ctx.fillStyle = '#b08a50';
        ctx.fillRect(x + 15, y + 26, bw * clamp(p.hunger / 100, 0, 1), 2);
      } else if (p.status === 'down') {
        const pulse = 0.6 + Math.sin(this.time * 8) * 0.4;
        segBar(ctx, x + 15, y + 18, bw, 5, p.downTimer / PLAYER.downTime, `rgba(208,88,62,${pulse})`, 20);
        ctx.textAlign = 'left';
        ctx.font = `bold 9px ${MONO}`;
        ctx.fillStyle = '#ef8a70';
        ctx.fillText(`DOWN ${Math.ceil(p.downTimer)}s — 救助を！`, x + 15, y + 30);
      } else {
        ctx.textAlign = 'left';
        ctx.font = `bold 10px ${UI}`;
        ctx.fillStyle = '#8c8872';
        ctx.fillText('K.I.A. — 夜明けに拠点で復帰', x + 15, y + 22);
      }
    });
  }

  /** 体調の札：何が悪いのかと、何を使えば治るのか（体の状態パネルの上に積む） */
  private drawConditions(me: PlayerSnap, x: number, bottom: number): void {
    const { ctx } = this;
    const items: { t: string; fix: string; c: string; bad: boolean }[] = [];
    const has = (id: ItemId) => countItem(me.bag, id) > 0;
    const H = this.touchUI && !this.padUI ? '[回復]' : '[H]';
    if (me.bleed) items.push({ t: '出血', fix: has('bandage') || has('medkit') ? `${H} 包帯で止血` : '包帯がない！ 布2で作れる', c: '#e0583e', bad: true });
    if (me.frac === 1) items.push({ t: '骨折', fix: has('splint') ? `${H} 添え木を当てる` : '添え木（布2・鉄くず1）を作る', c: '#e0583e', bad: true });
    else if (me.frac === 2) items.push({ t: '骨折（手当て済み）', fix: '少し足が遅い・じきに治る', c: '#c9a050', bad: false });
    const f = me.fatigue ?? 0;
    if (f >= 40) items.push({ t: `疲労 ${f}%`, fix: f >= 60 ? '狙いがぶれる・足が遅い → 夜に拠点のベッドで眠る' : '夜は拠点のベッドで眠ろう', c: f >= 60 ? '#e0a33a' : '#9c967c', bad: f >= 60 });
    const c = me.cold ?? 0;
    if (c >= 25) items.push({ t: `冷え ${c}%`, fix: c >= 50 ? 'スタミナ回復↓ → 焚き火・屋内・車・コート' : '雨と夜は冷える：焚き火・屋内', c: c >= 85 ? '#e0583e' : c >= 50 ? '#8ac0e0' : '#7f9aaa', bad: c >= 50 });
    if (!items.length) return;
    ctx.save();
    ctx.textBaseline = 'middle';
    let y = bottom;
    for (const it of items) {
      y -= 22;
      it.fix = this.kw(it.fix);
      ctx.font = `bold 11px ${UI}`;
      const tw = ctx.measureText(it.t).width;
      ctx.font = `10px ${UI}`;
      const fw = ctx.measureText(it.fix).width;
      const w = tw + fw + 26;
      ctx.fillStyle = 'rgba(14,15,11,0.82)';
      ctx.fillRect(x, y, w, 19);
      ctx.fillStyle = it.c;
      ctx.fillRect(x, y, 3, 19);
      const blink = it.bad && Math.sin(this.time * 6) > 0.3;
      ctx.font = `bold 11px ${UI}`;
      ctx.fillStyle = blink ? '#ffffff' : it.c;
      ctx.textAlign = 'left';
      ctx.fillText(it.t, x + 9, y + 10);
      ctx.font = `10px ${UI}`;
      ctx.fillStyle = '#d8d2b8';
      ctx.fillText(it.fix, x + 17 + tw, y + 10);
    }
    ctx.restore();
  }

  private drawSelfPanel(view: ViewState, me: PlayerSnap): void {
    const { ctx, h } = this;
    const x = 12;
    const pw = 262;
    const ph = 166;
    const y = h - ph - 30;
    this.drawConditions(me, x, y - 4);
    const low = me.hp / me.maxHp < 0.3;
    const hungry = me.hunger < 25;
    const tired = me.stamina < PLAYER.dashStamina;
    panel(ctx, x, y, pw, ph, undefined, low ? `rgba(208,88,62,${0.55 + Math.sin(this.time * 7) * 0.35})` : undefined);
    ctx.textBaseline = 'middle';
    // ヘッダー
    ctx.textAlign = 'left';
    ctx.font = `10px ${MONO}`;
    ctx.fillStyle = '#e0a33a';
    ctx.fillText('// VITALS', x + 10, y + 11);
    // 警告チップ
    let cx = x + pw - 10;
    const warn = (t: string, c: string) => {
      ctx.font = `bold 9px ${UI}`;
      const tw = ctx.measureText(t).width + 10;
      cx -= tw;
      const blink = Math.sin(this.time * 7) > -0.2;
      chipBox(ctx, cx, y + 4, tw, 14, c, blink);
      ctx.fillStyle = blink ? '#15170f' : c;
      ctx.textAlign = 'center';
      ctx.fillText(t, cx + tw / 2, y + 11.5);
      ctx.textAlign = 'left';
      cx -= 4;
    };
    if (low) warn('出血・HP低下', '#d0583e');
    if (hungry) warn('空腹', '#e0a33a');
    if (tired) warn('息切れ', '#7fa2bf');
    if ((me.tox ?? 0) > 50) warn('汚染', '#c8d050');
    // バッグがほぼ満杯：これ以上は拾えない＝帰還の合図
    if (me.bag.filter((s) => s).length >= me.bag.length - 1) warn('バッグ満杯', '#93b77c');
    // 休息済み（良い状態なので点滅させない）
    if ((me.rested ?? 0) > 0) {
      const t = `休息済み ${Math.ceil((me.rested ?? 0) / 60)}分`;
      ctx.font = `bold 9px ${UI}`;
      const tw = ctx.measureText(t).width + 10;
      cx -= tw;
      chipBox(ctx, cx, y + 4, tw, 14, '#aab4c8', false);
      ctx.fillStyle = '#aab4c8';
      ctx.textAlign = 'center';
      ctx.fillText(t, cx + tw / 2, y + 11.5);
      ctx.textAlign = 'left';
      cx -= 4;
    }

    // 数値の列は幅を固定して右揃え（バーの長さはどの行も同じ）
    const VAL_W = 46;
    const BAR_W = pw - 50 - 10 - VAL_W - 8;
    const bar = (label: string, by: number, ratio: number, color: string, val: string, flash: boolean) => {
      ctx.font = `bold 10px ${UI}`;
      ctx.fillStyle = flash ? `rgba(239,138,112,${0.6 + Math.sin(this.time * 9) * 0.4})` : '#bdb79e';
      ctx.textAlign = 'left';
      ctx.fillText(label, x + 10, by + 5);
      segBar(ctx, x + 50, by, BAR_W, 10, Math.max(0, Math.min(1, ratio)), color, 20);
      ctx.font = `12px ${MONO}`;
      // 長すぎる値は列に収まるまで縮める
      let fs = 12;
      while (fs > 8 && ctx.measureText(val).width > VAL_W) ctx.font = `${--fs}px ${MONO}`;
      ctx.fillStyle = flash ? '#ef8a70' : '#e6e1cc';
      ctx.textAlign = 'right';
      ctx.fillText(val, x + pw - 10, by + 5.5);
    };
    const num = (v: number) => (v >= 10000 ? '∞' : `${Math.max(0, Math.ceil(v))}`);
    const hr = me.hp / me.maxHp;
    bar('HP', y + 24, hr, hr > 0.5 ? '#93b77c' : hr > 0.3 ? '#e0a33a' : '#d0583e', num(me.hp), low);
    const smax = me.stmMax ?? PLAYER.maxStamina;
    bar('体力', y + 40, me.stamina / smax, tired ? '#3d5a78' : '#7fa2bf', num(me.stamina), false);
    // ダッシュに必要な量の目盛り
    ctx.fillStyle = 'rgba(255,255,255,0.6)';
    ctx.fillRect(x + 50 + BAR_W * (PLAYER.dashStamina / smax), y + 39, 1, 12);
    bar('空腹', y + 56, me.hunger / 100, me.hunger > 25 ? '#b08a50' : '#d0583e', `${Math.ceil(me.hunger)}%`, hungry);
    const tox = me.tox ?? 0;
    bar('汚染', y + 72, tox / 100, tox > 50 ? '#c8d050' : '#8a9a50', `${Math.round(tox)}%`, tox > 50);

    // 区切り
    ctx.fillStyle = 'rgba(190,180,130,0.18)';
    ctx.fillRect(x + 10, y + 88, pw - 20, 1);
    // 装備
    const wline = (key: 'prim' | 'sec', label: string, iy: number) => {
      const s = heldWeapon({ ...me, tool: key === 'prim' ? Tool.Primary : Tool.Secondary });
      ctx.textAlign = 'left';
      ctx.font = `9px ${MONO}`;
      ctx.fillStyle = '#8c8872';
      ctx.fillText(label, x + 10, iy);
      if (!s) {
        ctx.font = `bold 11px ${UI}`;
        ctx.fillStyle = '#5e5c4c';
        ctx.fillText('— 未装備 —', x + 50, iy);
        return;
      }
      const st = effectiveStats(s.id, s.w);
      const mods = ATTACHMENTS.filter((a) => s.w[a]).length;
      ctx.font = `bold 12px ${UI}`;
      const q = s.w.q ?? 0;
      ctx.fillStyle = q > 0 ? QUALITY[q].color : '#e6e1cc';
      const wn = weaponLabel(s);
      ctx.fillText(wn, x + 50, iy, 120);
      let ax = x + 50 + Math.min(120, ctx.measureText(wn).width) + 6;
      if (mods) {
        ctx.font = `10px ${MONO}`;
        ctx.fillStyle = '#93b77c';
        ctx.fillText(`+${mods}`, ax, iy);
        ax += 18;
      }
      if (s.w.ap) ammoBadge(ctx, ax, iy - 7, s.id === 'shotgun' ? 'SLG' : 'AP');
      ctx.textAlign = 'right';
      ctx.font = `13px ${MONO}`;
      ctx.fillStyle = s.w.mag === 0 ? '#ef8a70' : '#e0b862';
      ctx.fillText(`${String(s.w.mag).padStart(2, '0')}/${countItem(me.bag, st.ammo)}`, x + pw - 10, iy);
    };
    wline('prim', 'PRI', y + 102);
    wline('sec', 'SEC', y + 120);
    // バッグの使用状況
    // バッグ：マス（左）と重さ（右）
    const cap = capacityOf(me.pack);
    const used = me.bag.slice(0, cap.slots).filter((b) => b).length;
    const kg = loadKg(me);
    ctx.textAlign = 'left';
    ctx.font = `9px ${MONO}`;
    ctx.fillStyle = '#8c8872';
    ctx.fillText('BAG', x + 10, y + 138);
    const cw = (pw - 150) / cap.slots;
    for (let i = 0; i < cap.slots; i++) {
      ctx.fillStyle = me.bag[i] ? '#b8a878' : 'rgba(255,255,255,0.1)';
      ctx.fillRect(x + 40 + i * cw, y + 134, cw - 1.5, 8);
    }
    ctx.textAlign = 'right';
    ctx.font = `11px ${MONO}`;
    ctx.fillStyle = used >= cap.slots ? '#ef8a70' : '#e6e1cc';
    ctx.fillText(`${used}/${cap.slots}`, x + pw - 58, y + 138);
    ctx.fillStyle = kg > cap.kg * 0.9 ? '#ef8a70' : '#bdb79e';
    ctx.fillText(`${kg.toFixed(1)}/${cap.kg}kg`, x + pw - 8, y + 138);
    ctx.textAlign = 'left';
    ctx.font = `9px ${UI}`;
    ctx.fillStyle = '#6f6c5a';
    ctx.fillText(this.glyphs ? padText('{@use} 調べる ・ {@inv} 持ち物 ・ {@reload} 装填 ・ {@craft} 作業台 ・ {@build} 建設 ・ {@map} 地図', this.glyphs) : 'F 探索/乗る ・ Tab 持ち物 ・ R 装填 ・ C 作業台 ・ V 建設 ・ B 地図', x + 10, y + ph - 9, pw - 20);
    void view;
  }

  private drawHotbar(o: RenderOptions, view: ViewState): void {
    const { ctx, w, h } = this;
    const me = view.players.find((p) => p.id === o.localId);
    const gap = 4;
    // 左のステータス（約285px）・右のボタン（約250px）と重ならない大きさにする
    const avail = w - 2 * 292;
    const size = Math.max(38, Math.min(54, Math.floor((avail - gap * (SLOTS.length - 1)) / SLOTS.length)));
    const total = SLOTS.length * size + (SLOTS.length - 1) * gap;
    // 狭い枠（画面分割）では、左下のステータスと重ならないよう右へ寄せる
    const x0 = Math.round(Math.max(w / 2 - total / 2, Math.min(286, w - total - 12)));
    const y = h - size - 14;
    this.hotbarCX = x0 + total / 2;
    this.hotbarTop = y;
    SLOTS.forEach((t, i) => {
      const x = x0 + i * (size + gap);
      const sel = o.localTool === t.id;
      const usable = i < USABLE_SLOTS;
      const yy = sel ? y - 4 : y;
      // 枠
      ctx.fillStyle = usable ? (sel ? 'rgba(56,62,38,0.92)' : 'rgba(17,19,14,0.82)') : 'rgba(10,11,8,0.5)';
      ctx.fillRect(x, yy, size, size);
      ctx.strokeStyle = sel ? '#e0a33a' : usable ? 'rgba(190,180,130,0.25)' : 'rgba(190,180,130,0.1)';
      ctx.lineWidth = 1;
      ctx.strokeRect(x + 0.5, yy + 0.5, size - 1, size - 1);
      if (sel) brackets(ctx, x - 2, yy - 2, size + 4, size + 4, '#e0a33a', 9, 2);
      // キー番号
      ctx.font = `10px ${MONO}`;
      ctx.textAlign = 'left';
      ctx.textBaseline = 'top';
      ctx.fillStyle = sel ? '#e0a33a' : usable ? '#bdb79e' : 'rgba(190,180,130,0.25)';
      ctx.fillText(t.key, x + 4, yy + 3);
      if (!usable) {
        // 未解放スロット：錠前
        ctx.strokeStyle = 'rgba(190,180,130,0.25)';
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.arc(x + size / 2, yy + size / 2 - 4, 5, Math.PI, 0);
        ctx.stroke();
        ctx.fillStyle = 'rgba(190,180,130,0.22)';
        ctx.fillRect(x + size / 2 - 7, yy + size / 2 - 4, 14, 10);
        return;
      }
      if (!me) return;
      let label = '';
      let warn = false;
      let locked = false;
      let badge = '';
      const cx = x + size / 2;
      const cy = yy + size / 2 - 4;
      switch (t.id) {
        case Tool.Melee: {
          drawSlotIcon(ctx, 'axe', cx, cy);
          // 近接武器：名前と耐久（残り%）
          const mm = me.mel ? MELEE_STATS[me.mel.id as MeleeId] : null;
          if (mm) {
            const pct = Math.round(((me.mel!.w?.mag ?? mm.dur) / mm.dur) * 100);
            label = `${mm.name} ${pct}%`;
            warn = pct <= 20;
          } else label = 'MELEE';
          break;
        }
        case Tool.Primary:
        case Tool.Secondary: {
          const s = heldWeapon({ ...me, tool: t.id });
          locked = !s;
          const icon = !s ? (t.id === Tool.Primary ? 'rifle' : 'pistol') : s.id === 'pistol' ? 'pistol' : s.id === 'shotgun' ? 'shotgun' : 'rifle';
          drawSlotIcon(ctx, icon, cx, cy, locked);
          if (s) {
            label = `${s.w.mag}/${countItem(me.bag, effectiveStats(s.id, s.w).ammo)}`;
            warn = s.w.mag === 0;
            if (s.w.ap) badge = s.id === 'shotgun' ? 'SLG' : 'AP';
          } else label = 'EMPTY';
          break;
        }
        case Tool.Meds: {
          const n = countItem(me.bag, 'bandage') + countItem(me.bag, 'medkit') + countItem(me.bag, 'stim') + countItem(me.bag, 'herbs') + countItem(me.bag, 'antitox');
          drawSlotIcon(ctx, 'medkit', cx, cy, n <= 0);
          label = `×${n}`;
          warn = n <= 0;
          break;
        }
        case Tool.Food: {
          const n = countItem(me.bag, 'can') + countItem(me.bag, 'mre');
          drawSlotIcon(ctx, 'food', cx, cy, n <= 0);
          label = `×${n}`;
          warn = n <= 0;
          break;
        }
      }
      if (badge) ammoBadge(ctx, x + size - 24, yy + 3, badge);
      ctx.textAlign = 'center';
      ctx.textBaseline = 'alphabetic';
      ctx.font = `11px ${MONO}`;
      ctx.fillStyle = locked ? '#5e5c4c' : warn ? '#ef8a70' : '#e6e1cc';
      ctx.fillText(label, cx, yy + size - 5);
      // 下辺の状態ライン
      ctx.fillStyle = locked ? 'rgba(90,90,70,0.4)' : warn ? '#d0583e' : sel ? '#e0a33a' : 'rgba(147,183,124,0.5)';
      ctx.fillRect(x + 1, yy + size - 2, size - 2, 1);
    });

    const cur = SLOTS[o.localTool];
    if (cur && me && !o.panelOpen) {
      const s = heldWeapon({ ...me, tool: o.localTool });
      const name: string = s ? ITEMS[s.id].name : cur.name;
      ctx.font = `bold 12px ${UI}`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'alphabetic';
      const txt = `${name}`;
      const tw = ctx.measureText(txt).width + 60;
      ctx.fillStyle = 'rgba(12,13,10,0.65)';
      ctx.fillRect(w / 2 - tw / 2, y - 30, tw, 18);
      ctx.fillStyle = '#e6e1cc';
      ctx.fillText(txt, w / 2, y - 16);
    }
  }

  // ---------------- 地図まわり（探索済みのマスク・ミニマップ・全体地図・コンパス） ----------------

  private exploredCanvas = document.createElement('canvas');
  private exploredT = 0;

  /** 一度見た場所だけ地図に出す（未探索は暗く）。0.5秒ごとに更新 */
  private updateExplored(dt: number): void {
    this.exploredT -= dt;
    if (this.exploredT > 0 && this.exploredCanvas.width) return;
    this.exploredT = 0.5;
    const c = this.exploredCanvas;
    if (c.width !== MAP_W) {
      c.width = MAP_W;
      c.height = MAP_H;
    }
    const g = c.getContext('2d')!;
    const img = g.createImageData(MAP_W, MAP_H);
    const ex = this.vision.explored;
    for (let i = 0; i < ex.length; i++) {
      const k = i * 4;
      img.data[k] = 10;
      img.data[k + 1] = 11;
      img.data[k + 2] = 8;
      img.data[k + 3] = ex[i] ? 0 : 205;
    }
    g.putImageData(img, 0, 0);
  }

  private locExplored(l: { x: number; y: number; w: number; h: number }): boolean {
    const cx = Math.floor(l.x + l.w / 2);
    const cy = Math.floor(l.y + l.h / 2);
    return this.vision.explored[cy * MAP_W + cx] === 1 || this.vision.explored[l.y * MAP_W + l.x] === 1;
  }

  private miniBottom = 250;
  private locConts: number[][] | null = null;
  private searchCache: { t: number; ratio: (number | undefined)[]; done: number; total: number } | null = null;

  /** 施設ごとの「漁った割合」（入れ物のうち探索済みの割合）。1秒ごとに数え直す */
  private searchStats(): { ratio: (number | undefined)[]; done: number; total: number } {
    if (this.searchCache && this.time - this.searchCache.t < 1) return this.searchCache;
    const locs = this.world.locations;
    if (!this.locConts) {
      this.locConts = locs.map(() => []);
      for (const ob of this.world.objects.values()) {
        if (!CONTAINER_KINDS.has(ob.kind) || ob.kind === 'car' || ob.kind === 'bag' || ob.kind === 'box') continue;
        const i = locs.findIndex((l) => ob.tx >= l.x && ob.ty >= l.y && ob.tx < l.x + l.w && ob.ty < l.y + l.h);
        if (i >= 0 && locs[i].kind !== 'base') this.locConts[i].push(ob.id);
      }
    }
    let done = 0;
    let total = 0;
    const ratio = this.locConts.map((ids, i) => {
      if (!ids.length || locs[i].kind === 'base') return undefined;
      total++;
      let n = 0;
      for (const id of ids) {
        const ob = this.world.objects.get(id);
        if (!ob || !ob.ready) n++;
      }
      const r = n / ids.length;
      if (r >= 0.8) done++;
      return r;
    });
    this.searchCache = { t: this.time, ratio, done, total };
    return this.searchCache;
  }

  /** 無線の依頼の一覧（画面右・ミニマップの下）。タッチ端末では一番近い依頼だけを上部に */
  /** はじめの一日のパネルの高さ（依頼パネルをその下にずらす） */
  private tutH = 0;
  /** 武器欄の中央と上端（狭い枠では 1 行の案内をその上に出す） */
  private hotbarCX = 0;
  private hotbarTop = 0;
  /** 1 行表示の置き場所：スマホは上部中央、画面分割の枠は武器欄の上 */
  private slimPos(row: number): { cx: number; y: number } {
    if (this.touchUI || this.h >= 600) return { cx: this.w / 2, y: row === 0 ? 58 : row === 1 ? 82 : 106 };
    return { cx: this.hotbarCX, y: this.hotbarTop - 56 - row * 24 };
  }
  /** はじめの一日：最初の数日、やることのチェックリスト。今やると良い 1 つに「どうやるか」を添える */
  private drawTutorial(view: ViewState, me: PlayerSnap, touch: boolean): void {
    const done = me.tut;
    if (done === undefined) return;
    // 1 段目：はじめの一日（4 日目まで）→ 2 段目：生き延びる手引き（8 日目まで）
    const first = (done & TUT_ALL) !== TUT_ALL && view.day <= 4;
    const second = !first && (done & TUT2_ALL) !== TUT2_ALL && view.day <= 8;
    if (!first && !second) return;
    const TUT_STEPS = first ? TUT_STEPS1 : TUT2_STEPS;
    const label = first ? 'はじめの一日' : '生き延びる手引き';
    const { ctx } = this;
    const next = TUT_STEPS.find((s) => !(done & s.bit));
    if (!next) return;
    const n = TUT_STEPS.filter((s) => done & s.bit).length;
    if (touch) {
      const t = `${label} ${n}/${TUT_STEPS.length}：${next.title} — ${this.touchUI ? next.touch : this.kw(next.how)}`;
      ctx.font = `bold 11px ${UI}`;
      const tw = ctx.measureText(t).width + 16;
      const { cx, y } = this.slimPos(1);
      const x = cx - tw / 2;
      panel(ctx, x, y, tw, 20);
      ctx.fillStyle = '#e0c060';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(t, cx, y + 10.5);
      return;
    }
    const pw = 236;
    const x = this.w - pw - 12;
    const y = this.miniBottom + 10 + this.tutH;
    const rowH = 16;
    // 「どうやるか」は 2 行まで折り返す（切れると肝心の数字が読めない）
    ctx.font = `10px ${UI}`;
    const howLines: string[] = [];
    {
      let rest = this.kw(next.how);
      while (rest && howLines.length < 2) {
        let k = rest.length;
        while (k > 1 && ctx.measureText(rest.slice(0, k)).width > pw - 20) k--;
        let line = rest.slice(0, k);
        rest = rest.slice(k);
        if (howLines.length === 1 && rest) line = line.slice(0, -1) + '…';
        howLines.push(line);
      }
    }
    const ph = 22 + TUT_STEPS.length * rowH + 6 + howLines.length * 13;
    panel(ctx, x, y, pw, ph);
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'left';
    ctx.font = `10px ${MONO}`;
    ctx.fillStyle = '#e0c060';
    ctx.fillText(`// ${label}`, x + 10, y + 11);
    ctx.textAlign = 'right';
    ctx.font = `bold 10px ${UI}`;
    ctx.fillStyle = '#bdb79e';
    ctx.fillText(`${n}/${TUT_STEPS.length}`, x + pw - 10, y + 11);
    TUT_STEPS.forEach((s, i) => {
      const ry = y + 22 + i * rowH + 6;
      const ok = !!(done & s.bit);
      const cur = s === next;
      ctx.textAlign = 'left';
      ctx.font = `${cur ? 'bold ' : ''}11px ${UI}`;
      ctx.fillStyle = ok ? '#93b77c' : cur ? '#f0e6c0' : '#9c967c';
      ctx.globalAlpha = ok ? 0.6 : 1;
      ctx.fillText(`${ok ? '✓' : cur ? '▶' : '・'} ${s.title}`, x + 10, ry);
      ctx.globalAlpha = 1;
    });
    ctx.font = `10px ${UI}`;
    ctx.fillStyle = '#e0c060';
    howLines.forEach((ln, k) => ctx.fillText(ln, x + 10, y + 22 + TUT_STEPS.length * rowH + 7 + k * 13));
    this.tutH += ph + 8;
  }

  /** 救助の進み具合（モード・残り日数・次にやること） */
  private drawRescue(view: ViewState, slim: boolean): void {
    const r = view.rescue;
    if (!r) return;
    const { ctx } = this;
    const n = [1, 2, 4].filter((b) => r.parts & b).length;
    const left = r.day ? r.day - view.day : 0;
    const when = r.day ? (left <= 0 ? '今朝' : left === 1 ? '明日の朝' : `あと ${left} 日（DAY ${r.day} の朝）`) : '';
    const step =
      r.stage === 0
        ? `無線の部品 ${n}/3 — 地図の金色の◆へ`
        : r.stage === 1
          ? '部品がそろった：拠点の無線を修理（工具1・電子部品2）'
          : r.stage === 2
            ? '無線が直った：拠点の無線で救助を呼べる'
            : '救助を呼んだ — 前の晩は最後の防衛';
    const head = r.day ? `救助まで ${when}` : '救助：まだ呼んでいない';
    if (slim) {
      const t = `${head} ・ ${step}`;
      ctx.font = `bold 11px ${UI}`;
      const tw = ctx.measureText(t).width + 16;
      const { cx, y } = this.slimPos(2);
      panel(ctx, cx - tw / 2, y, tw, 20);
      ctx.fillStyle = '#f0d070';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(t, cx, y + 10.5);
      return;
    }
    const pw = 236;
    const x = this.w - pw - 12;
    const y = this.miniBottom + 10;
    const ph = 50;
    panel(ctx, x, y, pw, ph);
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'left';
    ctx.font = `10px ${MONO}`;
    ctx.fillStyle = '#f0d070';
    ctx.fillText('// RESCUE 救助', x + 10, y + 11);
    ctx.textAlign = 'right';
    ctx.font = `bold 10px ${UI}`;
    ctx.fillStyle = '#bdb79e';
    ctx.fillText(`${r.mode === 'd30' ? '30日モード' : '期限なし'}・脅威 Lv${(r.threat ?? 0) + 1}`, x + pw - 10, y + 11);
    ctx.textAlign = 'left';
    ctx.font = `bold 11px ${UI}`;
    ctx.fillStyle = r.day && left <= 1 ? '#f0a040' : '#f0e6c0';
    ctx.fillText(head, x + 10, y + 26);
    let t = step;
    ctx.font = `10px ${UI}`;
    while (ctx.measureText(t).width > pw - 20 && t.length > 4) t = t.slice(0, -2) + '…';
    ctx.fillStyle = '#c9c2a0';
    ctx.fillText(t, x + 10, y + 41);
    this.tutH += ph + 8;
  }

  private drawJobs(view: ViewState, me: PlayerSnap, touch: boolean): void {
    const jobs = view.jobs ?? [];
    if (!jobs.length) return;
    const { ctx } = this;
    const lv = view.radio?.lv ?? 1;
    const what = (j: (typeof jobs)[number]) =>
      j.kind === 'fetch' && j.item ? `${ITEMS[j.item].name} ${Math.min(j.have ?? 0, j.need ?? 1)}/${j.need}` : j.kind === 'cache' ? '物資箱を開ける' : '施設に入る';
    const distTo = (j: (typeof jobs)[number]) => {
      const ready = j.kind === 'fetch' && (j.have ?? 0) >= (j.need ?? 1);
      const tx = ready ? BASE_TX : j.tx;
      const ty = ready ? BASE_TY : j.ty;
      return Math.round(Math.hypot(tx - me.x / TILE, ty - me.y / TILE));
    };
    if (touch) {
      const open = jobs.map((j, i) => ({ j, i })).filter(({ j }) => !j.done);
      if (!open.length) return;
      open.sort((a, b) => distTo(a.j) - distTo(b.j));
      const { j, i } = open[0];
      const ready = j.kind === 'fetch' && (j.have ?? 0) >= (j.need ?? 1);
      const t = `依頼${i + 1} ${'★'.repeat(j.tier)} ${ready ? '無線で報告' : what(j)} ・ ${distTo(j)}m　（残り${open.length}件）`;
      ctx.font = `bold 11px ${UI}`;
      const tw = ctx.measureText(t).width + 16;
      const { cx, y } = this.slimPos(0);
      const x = cx - tw / 2;
      panel(ctx, x, y, tw, 20);
      ctx.fillStyle = '#cfe8f6';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(t, cx, y + 10.5);
      return;
    }
    const pw = 236;
    const x = this.w - pw - 12;
    const y = this.miniBottom + 10 + this.tutH;
    const rowH = 30;
    const ph = 22 + jobs.length * rowH + 4;
    panel(ctx, x, y, pw, ph);
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'left';
    ctx.font = `10px ${MONO}`;
    ctx.fillStyle = '#8ac0e0';
    ctx.fillText('// RADIO 依頼', x + 10, y + 11);
    ctx.textAlign = 'right';
    ctx.font = `bold 10px ${UI}`;
    ctx.fillStyle = '#bdb79e';
    ctx.fillText(`信頼 Lv${lv}${lv < 5 ? `（次まで ${3 - ((view.radio?.done ?? 0) % 3)}件）` : ''}`, x + pw - 10, y + 11);
    jobs.forEach((j, i) => {
      const ry = y + 22 + i * rowH;
      const ready = !j.done && j.kind === 'fetch' && (j.have ?? 0) >= (j.need ?? 1);
      ctx.globalAlpha = j.done ? 0.45 : 1;
      ctx.textAlign = 'left';
      ctx.font = `bold 11px ${UI}`;
      ctx.fillStyle = j.done ? '#93b77c' : '#e6e1cc';
      const kindTag = j.kind === 'fetch' ? '回収' : j.kind === 'cache' ? '救援' : '偵察';
      let title = `${j.done ? '✓' : `${i + 1}.`} [${kindTag}] ${j.title.replace(/(から回収|の救援物資|の偵察)$/, '')}`;
      while (ctx.measureText(title).width > pw - 70 && title.length > 4) title = title.slice(0, -2) + '…';
      ctx.fillText(title, x + 10, ry + 8);
      ctx.textAlign = 'right';
      ctx.font = `10px ${MONO}`;
      ctx.fillStyle = '#e0a33a';
      ctx.fillText('★'.repeat(j.tier), x + pw - 10, ry + 8);
      ctx.textAlign = 'left';
      ctx.font = `10px ${UI}`;
      ctx.fillStyle = ready ? '#8fe08a' : '#9c967c';
      ctx.fillText(j.done ? '達成' : ready ? `そろった！ 拠点の無線で報告 ・ ${distTo(j)}m` : `${what(j)} ・ ${distTo(j)}m`, x + 22, ry + 21);
      ctx.globalAlpha = 1;
    });
  }

  /** 酸だまり（地面の緑の泡）と、放物線で飛ぶ酸 */
  private drawAcid(view: ViewState): void {
    const { ctx } = this;
    for (const a of view.acid ?? []) {
      const fade = Math.min(1, a.t / 1.5);
      const g = ctx.createRadialGradient(a.x, a.y, 4, a.x, a.y, a.r);
      g.addColorStop(0, `rgba(170,230,70,${0.55 * fade})`);
      g.addColorStop(0.7, `rgba(120,190,50,${0.35 * fade})`);
      g.addColorStop(1, 'rgba(100,160,40,0)');
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.ellipse(a.x, a.y, a.r, a.r * 0.8, 0, 0, Math.PI * 2);
      ctx.fill();
      // 泡
      for (let i = 0; i < 5; i++) {
        const ph = (this.time * 0.8 + i * 0.37 + a.x * 0.01) % 1;
        ctx.fillStyle = `rgba(210,250,130,${0.6 * (1 - ph) * fade})`;
        ctx.beginPath();
        ctx.arc(a.x + Math.cos(i * 2.4) * a.r * 0.5, a.y + Math.sin(i * 1.7) * a.r * 0.4, 2 + ph * 3, 0, Math.PI * 2);
        ctx.fill();
      }
    }
    for (const q of view.spits ?? []) {
      const x = q.sx + (q.tx - q.sx) * q.p;
      const y = q.sy + (q.ty - q.sy) * q.p - Math.sin(q.p * Math.PI) * 70;
      // 落ちる所の印（よければ避けられる）
      ctx.strokeStyle = `rgba(170,230,70,${0.25 + q.p * 0.5})`;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.ellipse(q.tx, q.ty, 40, 32, 0, 0, Math.PI * 2);
      ctx.stroke();
      ctx.fillStyle = '#b8f060';
      ctx.beginPath();
      ctx.arc(x, y, 6, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  /** ボスの体力（画面上部・コンパスの下） */
  private drawBossBar(view: ViewState): void {
    const z = view.zombies.find((q) => q.type === 'titan');
    if (!z) return;
    const { ctx } = this;
    const w = Math.min(420, this.w - 120);
    const x = this.w / 2 - w / 2;
    const y = 58;
    ctx.fillStyle = 'rgba(10,10,8,0.75)';
    ctx.fillRect(x - 2, y - 2, w + 4, 12);
    ctx.fillStyle = '#5a1e14';
    ctx.fillRect(x, y, w, 8);
    ctx.fillStyle = z.tele ? '#f07a3a' : '#d0402a';
    ctx.fillRect(x, y, w * clamp(z.hp / z.maxHp, 0, 1), 8);
    ctx.font = `bold 11px ${UI}`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    ctx.lineWidth = 3;
    ctx.strokeStyle = 'rgba(0,0,0,0.8)';
    const t = `巨像 ${z.tele === 1 ? '— 突進の構え！' : z.tele === 2 ? '— 地鳴りの構え！' : ''}`;
    ctx.strokeText(t, this.w / 2, y + 12);
    ctx.fillStyle = '#f0c8a0';
    ctx.fillText(t, this.w / 2, y + 12);
  }

  /** ミニマップ：自分の周り（約 96×72 マス）だけを追従表示。地図の外は霞 */
  private drawMinimap(view: ViewState, localId: number): void {
    const { ctx } = this;
    if (!this.miniCanvas) return;
    const me = view.players.find((p) => p.id === localId);
    const s = 2;
    const RW = 48;
    const RH = 36;
    const mw = RW * 2 * s;
    const mh = RH * 2 * s;
    const mx = this.w - mw - 16;
    const my = 98;
    const ctr = me ?? { x: this.cam.x, y: this.cam.y };
    const ctx0 = ctr.x / TILE - RW;
    const cty0 = ctr.y / TILE - RH;
    panel(ctx, mx - 4, my - 18, mw + 8, mh + 22);
    this.miniBottom = my + mh + 4;
    ctx.font = `9px ${MONO}`;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = '#e0a33a';
    ctx.fillText('// TAC-MAP', mx, my - 10);
    ctx.textAlign = 'right';
    ctx.fillStyle = '#8c8872';
    ctx.fillText('[B] 地図  N▲', mx + mw, my - 10);
    ctx.save();
    ctx.beginPath();
    ctx.rect(mx, my, mw, mh);
    ctx.clip();
    ctx.fillStyle = '#2c3020';
    ctx.fillRect(mx, my, mw, mh);
    // 地形（miniCanvas は 1マス = 2px）と未探索のマスク
    const X = (tx: number) => mx + (tx - ctx0) * s;
    const Y = (ty: number) => my + (ty - cty0) * s;
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(this.miniCanvas, X(0), Y(0), MAP_W * s, MAP_H * s);
    ctx.drawImage(this.exploredCanvas, X(0), Y(0), MAP_W * s, MAP_H * s);
    ctx.imageSmoothingEnabled = true;
    // 地図の外縁（汚染帯）
    ctx.strokeStyle = 'rgba(170,190,80,0.55)';
    ctx.setLineDash([3, 3]);
    ctx.strokeRect(X(EDGE_BAND), Y(EDGE_BAND), (MAP_W - EDGE_BAND * 2) * s, (MAP_H - EDGE_BAND * 2) * s);
    ctx.setLineDash([]);
    ctx.fillStyle = 'rgba(70,78,40,0.45)';
    ctx.fillRect(X(-200), Y(-200), (MAP_W + 400) * s, 200 * s);
    ctx.fillRect(X(-200), Y(MAP_H), (MAP_W + 400) * s, 200 * s);
    ctx.fillRect(X(-200), Y(0), 200 * s, MAP_H * s);
    ctx.fillRect(X(MAP_W), Y(0), 200 * s, MAP_H * s);
    // ロケーション（探索済みのみ）
    for (const loc of this.world.locations) {
      if (loc.kind === 'ruin' || !this.locExplored(loc)) continue;
      if (loc.x + loc.w < ctx0 || loc.y + loc.h < cty0 || loc.x > ctx0 + RW * 2 || loc.y > cty0 + RH * 2) continue;
      const col = loc.hot ? '#d070c0' : loc.tier >= 4 ? '#e05a40' : loc.tier >= 3 ? '#c06050' : loc.tier === 2 ? '#c9a85a' : loc.kind === 'base' ? '#93b77c' : '#9fe08a';
      ctx.strokeStyle = col;
      ctx.lineWidth = 1;
      ctx.strokeRect(X(loc.x) - 0.5, Y(loc.y) - 0.5, loc.w * s + 1, loc.h * s + 1);
      if (loc.kind !== 'base') {
        ctx.font = `bold 8px ${UI}`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'bottom';
        ctx.fillStyle = col;
        ctx.fillText(loc.hot ? '☣' : '★'.repeat(loc.tier), X(loc.x + loc.w / 2), Y(loc.y) - 1);
      }
    }
    // 目印・拠点・補給物資
    for (const lm of this.world.landmarks) this.landmarkIcon(ctx, X(lm.x), Y(lm.y), lm.kind, 1);
    this.baseIcon(ctx, X(BASE_TX), Y(BASE_TY));
    const k = s / TILE;
    if (view.drop && Math.sin(this.time * 8) > -0.3) {
      ctx.fillStyle = '#e05a3a';
      ctx.beginPath();
      ctx.arc(X(0) + view.drop.x * k, Y(0) + view.drop.y * k, 3.5, 0, Math.PI * 2);
      ctx.fill();
    }
    for (const v of view.vehicles ?? []) {
      if (!this.vision.explored[Math.floor(v.y / TILE) * MAP_W + Math.floor(v.x / TILE)]) continue;
      ctx.fillStyle = v.broken ? '#8a7a60' : '#8ac0e0';
      ctx.save();
      ctx.translate(X(v.x / TILE), Y(v.y / TILE));
      ctx.rotate(v.a);
      ctx.fillRect(-4, -2.5, 8, 5);
      ctx.restore();
    }
    for (const st of view.sites ?? []) {
      if (st.done) continue;
      const sx = X(st.tx + 0.5);
      const sy = Y(st.ty + 0.5);
      ctx.fillStyle = st.kind === 'tower' ? '#f0c040' : st.kind === 'stash' ? '#7fd8d0' : '#c08af0';
      ctx.beginPath();
      ctx.moveTo(sx, sy - 5);
      ctx.lineTo(sx + 5, sy);
      ctx.lineTo(sx, sy + 5);
      ctx.lineTo(sx - 5, sy);
      ctx.closePath();
      ctx.fill();
    }
    for (const j of view.jobs ?? []) {
      if (j.done) continue;
      const jx = X(j.tx + 0.5);
      const jy = Y(j.ty + 0.5);
      ctx.strokeStyle = '#8ac0e0';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(jx, jy, 4 + Math.sin(this.time * 4) * 1, 0, Math.PI * 2);
      ctx.stroke();
      ctx.lineWidth = 1;
    }
    for (const z of view.zombies) {
      if (!this.vision.isVisible(z.x, z.y)) continue;
      ctx.fillStyle = z.alert === 2 ? '#e05a40' : z.alert === 1 ? '#c9a050' : '#a05050';
      ctx.fillRect(X(0) + z.x * k - 1, Y(0) + z.y * k - 1, 2, 2);
    }
    if (this.fx) {
      for (const p of this.fx.pings) {
        ctx.strokeStyle = p.t === 'enemy' ? '#c0573e' : p.t === 'loot' ? '#c9a85a' : '#ffffff';
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.arc(X(0) + p.x * k, Y(0) + p.y * k, 4 + Math.sin(this.time * 6) * 1.5, 0, Math.PI * 2);
        ctx.stroke();
      }
    }
    ctx.restore();
    // 仲間：枠の外なら縁に矢印
    for (const p of view.players) {
      if (p.status === 'dead') continue;
      let px = X(0) + p.x * k;
      let py = Y(0) + p.y * k;
      const out = px < mx || py < my || px > mx + mw || py > my + mh;
      px = clamp(px, mx + 3, mx + mw - 3);
      py = clamp(py, my + 3, my + mh - 3);
      ctx.fillStyle = PLAYER_COLORS[p.id];
      ctx.beginPath();
      if (out) {
        ctx.moveTo(px, py - 4);
        ctx.lineTo(px + 4, py + 3);
        ctx.lineTo(px - 4, py + 3);
        ctx.closePath();
      } else ctx.arc(px, py, p.id === localId ? 3.5 : 2.5, 0, Math.PI * 2);
      ctx.fill();
      if (p.status === 'down') {
        ctx.strokeStyle = '#d0583e';
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.arc(px, py, 6 + Math.sin(this.time * 8) * 1.5, 0, Math.PI * 2);
        ctx.stroke();
      }
    }
    if (me) {
      // 自分の向き
      ctx.strokeStyle = '#efe6c4';
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(mx + mw / 2, my + mh / 2);
      ctx.lineTo(mx + mw / 2 + Math.cos(me.aim) * 9, my + mh / 2 + Math.sin(me.aim) * 9);
      ctx.stroke();
    }
  }

  private baseIcon(ctx: CanvasRenderingContext2D, x: number, y: number, sc = 1): void {
    ctx.save();
    ctx.translate(x, y);
    ctx.scale(sc, sc);
    ctx.fillStyle = '#93b77c';
    ctx.strokeStyle = '#15170f';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(0, -6);
    ctx.lineTo(6, 0);
    ctx.lineTo(4, 0);
    ctx.lineTo(4, 5);
    ctx.lineTo(-4, 5);
    ctx.lineTo(-4, 0);
    ctx.lineTo(-6, 0);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
    ctx.restore();
  }

  private landmarkIcon(ctx: CanvasRenderingContext2D, x: number, y: number, kind: string, sc: number): void {
    ctx.save();
    ctx.translate(x, y);
    ctx.scale(sc, sc);
    if (kind === 'tower') {
      // 通信塔：裾の広い鉄骨の塔＋筋交い＋アンテナと赤い航空灯（文字の「A」に見えないように）
      const mast = () => {
        ctx.beginPath();
        ctx.moveTo(-4, 5);
        ctx.lineTo(-1.2, -5);
        ctx.moveTo(4, 5);
        ctx.lineTo(1.2, -5);
        ctx.moveTo(-3.2, 2);
        ctx.lineTo(2.4, -1.5);
        ctx.moveTo(3.2, 2);
        ctx.lineTo(-2.4, -1.5);
        ctx.moveTo(-4, 5);
        ctx.lineTo(4, 5);
        ctx.moveTo(0, -5);
        ctx.lineTo(0, -9);
        ctx.stroke();
      };
      ctx.strokeStyle = 'rgba(0,0,0,0.7)';
      ctx.lineWidth = 2.6;
      mast();
      ctx.strokeStyle = '#c8c2a8';
      ctx.lineWidth = 1;
      mast();
      ctx.fillStyle = Math.sin(this.time * 4) > 0 ? '#ff5a3c' : '#7a2a20';
      ctx.beginPath();
      ctx.arc(0, -9, 1.4, 0, Math.PI * 2);
      ctx.fill();
    } else if (kind === 'water') {
      ctx.fillStyle = '#9aa4a8';
      ctx.fillRect(-3.5, -4, 7, 4);
      ctx.fillRect(-0.5, 0, 1, 4);
    } else {
      ctx.fillStyle = kind === 'fire' ? '#e07a3a' : '#8a8a80';
      ctx.beginPath();
      ctx.arc(-1, 1, 2.5, 0, Math.PI * 2);
      ctx.arc(1.5, -2, 2, 0, Math.PI * 2);
      ctx.arc(-0.5, -4.5, 1.6, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();
  }

  /** コンパス：照準方向を中心に方位を表示。拠点・仲間・補給物資・ピン・目印の方角と距離 */
  private drawCompass(view: ViewState, me: PlayerSnap | undefined, localId: number): void {
    if (!me) return;
    const { ctx, w } = this;
    let cw = Math.max(260, Math.min(460, w - 640));
    let x0 = Math.round(w / 2 - cw / 2);
    // 狭い枠：左上の仲間一覧と右上の時計のあいだに収める
    if (w < 1000) {
      x0 = 246;
      cw = Math.max(180, w - 320 - x0);
    }
    const y0 = 8;
    const hh = 30;
    const FOV = Math.PI * 0.62; // 片側の表示角
    ctx.fillStyle = 'rgba(14,15,11,0.72)';
    ctx.fillRect(x0, y0, cw, hh);
    brackets(ctx, x0, y0, cw, hh, 'rgba(224,163,58,0.7)', 6, 1.5);
    const head = me.aim;
    const toX = (ang: number) => {
      const d = Math.atan2(Math.sin(ang - head), Math.cos(ang - head));
      return { x: x0 + cw / 2 + (d / FOV) * (cw / 2), d };
    };
    ctx.save();
    ctx.beginPath();
    ctx.rect(x0, y0, cw, hh);
    ctx.clip();
    // 目盛り（15°ごと）と方位
    const names: Record<number, string> = { 0: 'E', 45: 'SE', 90: 'S', 135: 'SW', 180: 'W', 225: 'NW', 270: 'N', 315: 'NE' };
    for (let deg = 0; deg < 360; deg += 15) {
      const { x, d } = toX((deg * Math.PI) / 180);
      if (Math.abs(d) > FOV) continue;
      const nm = names[deg];
      ctx.fillStyle = nm ? 'rgba(230,225,204,0.7)' : 'rgba(230,225,204,0.3)';
      ctx.fillRect(Math.round(x), y0 + hh - (nm ? 8 : 5), 1, nm ? 8 : 5);
      if (nm) {
        ctx.font = `${nm.length === 1 ? 'bold 12px' : '10px'} ${MONO}`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillStyle = nm === 'N' ? '#e0a33a' : '#d8d2b8';
        ctx.fillText(nm, x, y0 + 10);
      }
    }
    // 目標の方角
    const marker = (wx: number, wy: number, color: string, label: string, kind: 'base' | 'dot' | 'drop' | 'lm', lmKind = '') => {
      const dx = wx - me.x;
      const dy = wy - me.y;
      const dist = Math.round(Math.hypot(dx, dy) / TILE);
      const { x, d } = toX(Math.atan2(dy, dx));
      const px = clamp(x, x0 + 8, x0 + cw - 8);
      const edge = Math.abs(d) > FOV;
      ctx.globalAlpha = edge ? 0.6 : 1;
      if (kind === 'base') this.baseIcon(ctx, px, y0 + 21, 0.85);
      else if (kind === 'lm') this.landmarkIcon(ctx, px, y0 + 21, lmKind, 1);
      else {
        ctx.fillStyle = color;
        ctx.beginPath();
        if (kind === 'drop') ctx.rect(px - 3, y0 + 18, 6, 6);
        else ctx.arc(px, y0 + 21, 3.2, 0, Math.PI * 2);
        ctx.fill();
      }
      if (label && !edge) {
        ctx.font = `9px ${MONO}`;
        ctx.textAlign = 'center';
        ctx.fillStyle = color;
        ctx.fillText(`${label}${dist}m`, px, y0 + hh + 8);
      }
      ctx.globalAlpha = 1;
    };
    ctx.restore();
    ctx.save();
    ctx.beginPath();
    ctx.rect(x0 - 2, y0, cw + 4, hh + 16);
    ctx.clip();
    for (const lm of this.world.landmarks) if (Math.hypot(lm.x * TILE - me.x, lm.y * TILE - me.y) < 110 * TILE) marker(lm.x * TILE, lm.y * TILE, '#a8a490', '', 'lm', lm.kind);
    marker((BASE_TX + 0.5) * TILE, (BASE_TY + 0.5) * TILE, '#93b77c', '⌂', 'base');
    // 川の近くにいるときは、いちばん近い（渡れる）橋の方角
    const rv = this.world.features.river;
    if (rv && rv.pts.some(([x, y]) => Math.hypot(x * TILE - me.x, y * TILE - me.y) < 45 * TILE)) {
      let best: { x: number; y: number } | null = null;
      let bd = 90 * TILE;
      for (const b of this.world.features.bridges) {
        if (b.broken) continue;
        const bx = (b.x + b.w / 2) * TILE;
        const by = (b.y + b.h / 2) * TILE;
        const d = Math.hypot(bx - me.x, by - me.y);
        if (d < bd) {
          bd = d;
          best = { x: bx, y: by };
        }
      }
      if (best) marker(best.x, best.y, '#7fa6d0', '橋 ', 'dot');
    }
    if (view.drop) marker(view.drop.x, view.drop.y, '#e07050', '', 'drop');
    for (const st of view.sites ?? []) if (!st.done) marker((st.tx + 0.5) * TILE, (st.ty + 0.5) * TILE, st.kind === 'tower' ? '#f0c040' : st.kind === 'stash' ? '#7fd8d0' : '#c08af0', '◆ ', 'dot');
    if (me.veh === undefined) {
      let best: VehicleSnap | null = null;
      let bd = 70 * TILE;
      for (const v of view.vehicles ?? []) {
        if (!this.vision.explored[Math.floor(v.y / TILE) * MAP_W + Math.floor(v.x / TILE)]) continue;
        const d = Math.hypot(v.x - me.x, v.y - me.y);
        if (d < bd && d > 3 * TILE) {
          bd = d;
          best = v;
        }
      }
      if (best) marker(best.x, best.y, best.broken ? '#c0a070' : '#8ac0e0', best.broken ? '車(故障) ' : '車 ', 'dot');
    }
    (view.jobs ?? []).forEach((j, i) => {
      if (j.done) return;
      // 回収の品がそろったら、行き先は拠点の無線
      if (j.kind === 'fetch' && (j.have ?? 0) >= (j.need ?? 1)) marker((BASE_TX + 0.5) * TILE, (BASE_TY - 5) * TILE, '#8ac0e0', `報告${i + 1} `, 'dot');
      else {
        // 近くまで来たら、施設の中の物資箱を指す
        const cr = j.crate ? this.world.objects.get(j.crate) : undefined;
        if (cr && cr.ready && Math.hypot((cr.tx + 0.5) * TILE - me.x, (cr.ty + 0.5) * TILE - me.y) < 30 * TILE) marker((cr.tx + 0.5) * TILE, (cr.ty + 0.5) * TILE, '#8ac0e0', `箱${i + 1} `, 'dot');
        else marker((j.tx + 0.5) * TILE, (j.ty + 0.5) * TILE, '#8ac0e0', `依${i + 1} `, 'dot');
      }
    });
    if (this.fx) for (const p of this.fx.pings) marker(p.x, p.y, p.t === 'enemy' ? '#d0583e' : p.t === 'loot' ? '#e0a33a' : (PLAYER_COLORS[p.id] ?? '#fff'), '', 'dot');
    for (const p of view.players) if (p.id !== localId && p.status !== 'dead') marker(p.x, p.y, p.status === 'down' ? '#ff6a50' : (PLAYER_COLORS[p.id] ?? '#fff'), p.status === 'down' ? 'SOS ' : '', 'dot');
    ctx.restore();
    // 中心の照準マーク
    ctx.fillStyle = '#e0a33a';
    ctx.beginPath();
    ctx.moveTo(x0 + cw / 2, y0 + hh - 1);
    ctx.lineTo(x0 + cw / 2 - 4, y0 + hh + 5);
    ctx.lineTo(x0 + cw / 2 + 4, y0 + hh + 5);
    ctx.closePath();
    ctx.fill();
  }

  /** 全体地図（B）：探索済みの地形・施設、危険度の輪、目印、仲間 */
  private drawWorldMap(view: ViewState, localId: number): void {
    const { ctx, w, h } = this;
    if (!this.miniCanvas) return;
    const LEG = 50; // 凡例の高さ
    const s = Math.min((w - 120) / MAP_W, (h - 110 - LEG) / MAP_H);
    const mw = MAP_W * s;
    const mh = MAP_H * s;
    const mx = Math.round(w / 2 - mw / 2);
    const my = Math.round((h - mh - LEG) / 2 + 14);
    // 背後の HUD が透けないよう、ほぼ不透明な暗幕を敷く
    ctx.fillStyle = '#070806';
    ctx.fillRect(0, 0, w, h);
    panel(ctx, mx - 12, my - 34, mw + 24, mh + 34 + LEG + 8);
    ctx.font = `10px ${MONO}`;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = '#e0a33a';
    ctx.fillText('// AREA MAP', mx, my - 18);
    ctx.font = `bold 14px ${UI}`;
    ctx.fillStyle = '#e6e1cc';
    ctx.fillText('地図', mx + 90, my - 18);
    ctx.font = `11px ${UI}`;
    ctx.textAlign = 'right';
    ctx.fillStyle = '#8c8872';
    ctx.fillText('[B] / [Esc] で閉じる ・ 拠点から離れるほど危険（★）・ 外縁は汚染帯', mx + mw, my - 18);
    {
      const st = this.searchStats();
      ctx.textAlign = 'left';
      ctx.font = `bold 11px ${UI}`;
      ctx.fillStyle = '#cfe8f6';
      ctx.fillText(`漁った施設 ${st.done}/${st.total}（${st.total ? Math.round((st.done / st.total) * 100) : 0}%）`, mx + 140, my - 18);
    }
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(this.miniCanvas, mx, my, mw, mh);
    ctx.drawImage(this.exploredCanvas, mx, my, mw, mh);
    ctx.imageSmoothingEnabled = true;
    const X = (tx: number) => mx + tx * s;
    const Y = (ty: number) => my + ty * s;
    const k = s / TILE;

    // ---- 図形（下から順に） ----
    for (const d of this.world.districts) {
      ctx.globalAlpha = 0.16;
      ctx.fillStyle = DISTRICT_INFO[d.kind].color;
      ctx.fillRect(X(d.x), Y(d.y), d.w * s, d.h * s);
    }
    ctx.globalAlpha = 1;
    ctx.save();
    ctx.beginPath();
    ctx.rect(mx, my, mw, mh);
    ctx.clip();
    for (const r of TIER_RINGS) {
      ctx.strokeStyle = 'rgba(224,163,58,0.32)';
      ctx.setLineDash([6, 6]);
      ctx.beginPath();
      ctx.arc(X(BASE_TX), Y(BASE_TY), r * s, 0, Math.PI * 2);
      ctx.stroke();
    }
    ctx.setLineDash([]);
    ctx.fillStyle = 'rgba(150,170,60,0.22)';
    const B = EDGE_BAND * s;
    ctx.fillRect(mx, my, mw, B);
    ctx.fillRect(mx, my + mh - B, mw, B);
    ctx.fillRect(mx, my + B, B, mh - 2 * B);
    ctx.fillRect(mx + mw - B, my + B, B, mh - 2 * B);
    ctx.restore();
    this.drawMapRoutes(ctx, X, Y, s);
    const searched = this.searchStats();
    this.world.locations.forEach((loc, i) => {
      if (loc.kind === 'base' || !this.locExplored(loc)) return;
      // 漁った割合で塗り分け：未探索＝明るい枠、途中＝橙、ほぼ漁った＝灰色で✓
      const r = searched.ratio[i];
      if (r !== undefined) {
        ctx.fillStyle = r >= 0.8 ? 'rgba(120,120,110,0.45)' : r > 0 ? 'rgba(224,163,58,0.25)' : 'rgba(255,240,200,0.12)';
        ctx.fillRect(X(loc.x), Y(loc.y), loc.w * s, loc.h * s);
      }
      ctx.strokeStyle = r !== undefined && r >= 0.8 ? '#7a776a' : this.locColor(loc);
      ctx.lineWidth = r === 0 ? 1.5 : 1;
      ctx.strokeRect(X(loc.x), Y(loc.y), loc.w * s, loc.h * s);
      if (r !== undefined && r >= 0.8 && s >= 1.6) {
        ctx.fillStyle = '#c8c4b0';
        ctx.font = `bold 10px ${UI}`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText('✓', X(loc.x + loc.w / 2), Y(loc.y + loc.h / 2));
      }
    });
    // 異変
    for (const st of view.sites ?? []) {
      const sx = X(st.tx + 0.5);
      const sy = Y(st.ty + 0.5);
      ctx.globalAlpha = st.done ? 0.35 : 1;
      ctx.fillStyle = st.kind === 'tower' ? '#f0c040' : st.kind === 'stash' ? '#7fd8d0' : '#c08af0';
      ctx.strokeStyle = '#140a1c';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(sx, sy - 8);
      ctx.lineTo(sx + 8, sy);
      ctx.lineTo(sx, sy + 8);
      ctx.lineTo(sx - 8, sy);
      ctx.closePath();
      ctx.stroke();
      ctx.fill();
      ctx.globalAlpha = 1;
      ctx.lineWidth = 1;
    }
    // 見つけた車
    for (const v of view.vehicles ?? []) {
      if (!this.vision.explored[Math.floor(v.y / TILE) * MAP_W + Math.floor(v.x / TILE)]) continue;
      ctx.save();
      ctx.translate(X(v.x / TILE), Y(v.y / TILE));
      ctx.rotate(v.a);
      ctx.fillStyle = v.broken ? '#a08a60' : '#8ac0e0';
      ctx.strokeStyle = '#0c0d0a';
      ctx.fillRect(-6, -3.5, 12, 7);
      ctx.strokeRect(-6, -3.5, 12, 7);
      ctx.restore();
    }
    // 無線の依頼の目的地
    (view.jobs ?? []).forEach((j, i) => {
      const jx = X(j.tx + 0.5);
      const jy = Y(j.ty + 0.5);
      ctx.globalAlpha = j.done ? 0.35 : 1;
      ctx.strokeStyle = '#8ac0e0';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(jx, jy, 9 + (j.done ? 0 : Math.sin(this.time * 4) * 2), 0, Math.PI * 2);
      ctx.stroke();
      ctx.fillStyle = 'rgba(20,40,60,0.9)';
      ctx.beginPath();
      ctx.arc(jx, jy, 7, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = '#cfe8f6';
      ctx.font = `bold 10px ${MONO}`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(j.done ? '✓' : `${i + 1}`, jx, jy + 0.5);
      ctx.lineWidth = 1;
      ctx.globalAlpha = 1;
    });
    for (const lm of this.world.landmarks) this.landmarkIcon(ctx, X(lm.x), Y(lm.y), lm.kind, 1.6);
    this.baseIcon(ctx, X(BASE_TX), Y(BASE_TY), 1.6);
    if (view.drop) {
      ctx.fillStyle = '#e05a3a';
      ctx.fillRect(mx + view.drop.x * k - 4, my + view.drop.y * k - 4, 8, 8);
    }
    if (this.fx)
      for (const p of this.fx.pings) {
        ctx.strokeStyle = p.t === 'enemy' ? '#e0583e' : p.t === 'loot' ? '#e0b862' : (PLAYER_COLORS[p.id] ?? '#fff');
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.arc(mx + p.x * k, my + p.y * k, 6 + Math.sin(this.time * 6) * 2, 0, Math.PI * 2);
        ctx.stroke();
        ctx.lineWidth = 1;
      }
    for (const p of view.players) {
      if (p.status === 'dead') continue;
      ctx.fillStyle = PLAYER_COLORS[p.id];
      ctx.beginPath();
      ctx.arc(mx + p.x * k, my + p.y * k, p.id === localId ? 5 : 4, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = '#15170f';
      ctx.stroke();
    }

    // ---- ラベル：優先度の高いものから置き、すでに置いたものと重なるラベルは位置をずらすか省く ----
    const placed: { x: number; y: number; w: number; h: number }[] = [];
    const PAD = 5;
    const fits = (x: number, y: number, bw: number, bh: number) =>
      x >= mx && y >= my && x + bw <= mx + mw && y + bh <= my + mh && !placed.some((r) => x < r.x + r.w + PAD && x + bw + PAD > r.x && y < r.y + r.h + PAD && y + bh + PAD > r.y);
    // アイコン（目印・橋・補給物資・仲間・ピン）の上にもラベルを重ねない
    const icon = (x: number, y: number, r: number) => placed.push({ x: x - r, y: y - r, w: r * 2, h: r * 2 });
    for (const lm of this.world.landmarks) icon(X(lm.x), Y(lm.y), 7);
    for (const j of view.jobs ?? []) icon(X(j.tx + 0.5), Y(j.ty + 0.5), 10);
    for (const st of view.sites ?? []) icon(X(st.tx + 0.5), Y(st.ty + 0.5), 10);
    for (const b of this.world.features.bridges) icon(X(b.x + b.w / 2), Y(b.y + b.h / 2), 6);
    if (view.drop) icon(mx + view.drop.x * k, my + view.drop.y * k, 6);
    for (const p of view.players) if (p.status !== 'dead') icon(mx + p.x * k, my + p.y * k, 6);
    if (this.fx) for (const p of this.fx.pings) icon(mx + p.x * k, my + p.y * k, 8);
    type Lb = { text: string; x: number; y: number; fg: string; bg?: string; font: string; align?: 'center' | 'left' };
    const put = (lb: Lb, tries: [number, number][] = [[0, 0]]): boolean => {
      ctx.font = lb.font;
      const tw = ctx.measureText(lb.text).width + (lb.bg ? 8 : 2);
      const th = lb.bg ? 14 : 13;
      for (const [dx, dy] of tries) {
        const lx = (lb.align === 'left' ? lb.x : lb.x - tw / 2) + dx;
        const ly = lb.y - th / 2 + dy;
        if (!fits(lx, ly, tw, th)) continue;
        placed.push({ x: lx, y: ly, w: tw, h: th });
        ctx.textAlign = 'left';
        ctx.textBaseline = 'middle';
        if (lb.bg) {
          ctx.fillStyle = lb.bg;
          ctx.fillRect(lx, ly, tw, th);
          ctx.fillStyle = lb.fg;
          ctx.fillText(lb.text, lx + 4, ly + th / 2 + 0.5);
        } else {
          ctx.lineWidth = 3;
          ctx.strokeStyle = 'rgba(8,9,7,0.85)';
          ctx.strokeText(lb.text, lx + 1, ly + th / 2);
          ctx.fillStyle = lb.fg;
          ctx.fillText(lb.text, lx + 1, ly + th / 2);
        }
        return true;
      }
      return false;
    };
    const around: [number, number][] = [[0, 0], [0, -16], [0, 16], [-30, 0], [30, 0], [0, -30], [0, 30], [-30, -16], [30, 16]];
    // 1) 仲間の名前（いちばん大事）
    for (const p of view.players) {
      if (p.status === 'dead') continue;
      put({ text: p.name + (p.status === 'down' ? ' SOS' : ''), x: mx + p.x * k + 8, y: my + p.y * k, fg: p.status === 'down' ? '#ff7a60' : '#ffffff', font: `bold 11px ${UI}`, align: 'left' }, [[0, 0], [0, -12], [0, 12], [-60, 0]]);
    }
    placed.push({ x: X(BASE_TX) - 10, y: Y(BASE_TY) - 10, w: 20, h: 20 });
    for (const st of view.sites ?? []) {
      if (st.done) continue;
      const tw = st.kind === 'tower';
      put({ text: `◆ ${st.kind === 'survivor' ? '生存者' : st.kind === 'convoy' ? '物資の車列（18:00 まで）' : st.kind === 'stash' ? '隠し物資' : tw ? `救助無線の部品（${st.name}）` : st.kind === 'heli' ? '墜落ヘリ' : st.kind === 'nest' ? '感染体の巣' : '封鎖された武器庫'}`, x: X(st.tx + 0.5), y: Y(st.ty + 0.5) - 20, fg: '#140a1c', bg: tw ? 'rgba(240,192,64,0.94)' : st.kind === 'stash' ? 'rgba(127,216,208,0.92)' : 'rgba(192,138,240,0.92)', font: `bold 10px ${UI}` }, [[0, 0], [0, 40], [70, 20], [-70, 20]]);
    }
    // 依頼の目的地の名前
    (view.jobs ?? []).forEach((j, i) => {
      if (j.done) return;
      const what = j.kind === 'fetch' && j.item ? `回収：${ITEMS[j.item].name}` : j.kind === 'cache' ? '救援物資' : '偵察';
      put({ text: `依頼${i + 1} ${'★'.repeat(j.tier)} ${what}`, x: X(j.tx + 0.5), y: Y(j.ty + 0.5) - 25, fg: '#0e1a22', bg: 'rgba(138,192,224,0.92)', font: `bold 10px ${UI}` }, [[0, 0], [0, 50], [0, -14], [70, 25], [-70, 25]]);
    });
    // 2) 川の名前・国道の標識（1本につき見える所に2枚まで）
    const F = this.world.features;
    if (F.river) {
      const n = F.river.pts.length;
      for (const f of [0.3, 0.6, 0.15, 0.8]) {
        const [x, y] = F.river.pts[Math.floor(n * f)];
        if (put({ text: F.river.name, x: X(x), y: Y(y), fg: '#8fc0e0', font: `bold 12px ${UI}` }, [[0, 0], [22, 0], [-22, 0]])) break;
      }
    }
    for (const hw of F.highways) {
      let n = 0;
      for (const f of [0.3, 0.7, 0.15, 0.85, 0.5]) {
        if (n >= 2) break;
        const along = (hw.horiz ? MAP_W : MAP_H) * f;
        const x = hw.horiz ? X(along) : X(hw.at + hw.w / 2);
        const y = hw.horiz ? Y(hw.at + hw.w / 2) : Y(along);
        // 標識は道に沿って少しずらしても良い（交差する地区名などを避ける）
        const slide: [number, number][] = hw.horiz ? [[0, 0], [30, 0], [-30, 0], [60, 0], [-60, 0]] : [[0, 0], [0, 24], [0, -24], [0, 48], [0, -48]];
        if (put({ text: hw.name, x, y, fg: '#ffffff', bg: 'rgba(40,80,140,0.92)', font: `bold 10px ${UI}` }, slide)) n++;
      }
    }
    // 3) 橋の名前
    if (s >= 2)
      for (const b of F.bridges) {
        if (b.broken) continue;
        put({ text: b.name, x: X(b.x + b.w) + 4, y: Y(b.y + b.h / 2), fg: '#d8cfb0', font: `bold 9px ${UI}`, align: 'left' }, [[0, 0], [0, -11], [0, 11], [-X(b.x + b.w) + X(b.x) - 48, 0]]);
      }
    // 4) 地区名
    for (const d of this.world.districts) {
      if (!d.label) continue;
      put({ text: d.name.replace(/^.*?の/, '').replace(/ 第\d+$/, ''), x: X(d.x + d.w / 2), y: Y(d.y + d.h / 2), fg: DISTRICT_INFO[d.kind].color, font: `bold ${s >= 2.5 ? 12 : 10}px ${UI}` }, around);
    }
    // 5) 探索済みの施設名
    if (s >= 2.2)
      for (const loc of this.world.locations) {
        if (loc.kind === 'base' || loc.kind === 'ruin' || !this.locExplored(loc)) continue;
        put({ text: `${loc.hot ? '☣' : '★'.repeat(loc.tier)} ${loc.name.replace(/^.*?の/, '')}`, x: X(loc.x + loc.w / 2), y: Y(loc.y) - 7, fg: this.locColor(loc), font: `bold 9px ${UI}` }, [[0, 0], [0, Y(loc.y + loc.h) - Y(loc.y) + 14]]);
      }
    // 6) 旧道・浅瀬・危険度の輪
    for (const c of F.curves) {
      const [x, y] = c.pts[Math.floor(c.pts.length / 2)];
      put({ text: c.name, x: X(x), y: Y(y), fg: '#2a2418', bg: 'rgba(210,195,150,0.85)', font: `bold 9px ${UI}` }, around);
    }
    for (const f of F.fords) put({ text: '浅瀬', x: X(f.x), y: Y(f.y), fg: '#a8d0d8', font: `bold 9px ${UI}` }, [[0, 0], [26, 0], [-26, 0]]);
    TIER_RINGS.forEach((r, i) => put({ text: '★'.repeat(i + 2), x: X(BASE_TX), y: Y(BASE_TY) - r * s - 6, fg: 'rgba(224,163,58,0.8)', font: `bold 10px ${UI}` }, [[0, 0], [40, 0], [-40, 0]]));

    // ---- 凡例（2段：記号／地区の色） ----
    const ly1 = my + mh + 16;
    const ly2 = ly1 + 20;
    let lx = mx;
    ctx.font = `10px ${UI}`;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    const item = (draw: (x: number, y: number) => void, text: string) => {
      draw(lx + 6, ly1);
      ctx.font = `10px ${UI}`;
      ctx.textAlign = 'left';
      ctx.textBaseline = 'middle';
      ctx.fillStyle = '#bdb79e';
      ctx.fillText(text, lx + 15, ly1);
      lx += 15 + ctx.measureText(text).width + 14;
    };
    item((x, y) => this.baseIcon(ctx, x, y, 1), '拠点');
    item((x, y) => this.landmarkIcon(ctx, x, y, 'tower', 1), '通信塔');
    item((x, y) => this.landmarkIcon(ctx, x, y, 'smoke', 1), '煙・炎');
    item((x, y) => {
      ctx.fillStyle = '#e05a3a';
      ctx.fillRect(x - 4, y - 4, 8, 8);
    }, '補給物資');
    item((x, y) => {
      ctx.strokeStyle = '#ffffff';
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.arc(x, y, 5, 0, Math.PI * 2);
      ctx.stroke();
    }, 'ピン');
    item((x, y) => {
      ctx.fillStyle = '#d8cfb0';
      ctx.fillRect(x - 6, y - 4, 12, 8);
    }, '橋');
    item((x, y) => {
      ctx.strokeStyle = '#e0583e';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(x - 4, y - 4);
      ctx.lineTo(x + 4, y + 4);
      ctx.moveTo(x + 4, y - 4);
      ctx.lineTo(x - 4, y + 4);
      ctx.stroke();
    }, '崩落した橋');
    item((x, y) => {
      ctx.fillStyle = 'rgba(40,80,140,0.92)';
      ctx.fillRect(x - 6, y - 5, 12, 10);
    }, '国道');
    item((x, y) => {
      ctx.strokeStyle = 'rgba(224,163,58,0.7)';
      ctx.setLineDash([3, 3]);
      ctx.beginPath();
      ctx.moveTo(x - 6, y);
      ctx.lineTo(x + 6, y);
      ctx.stroke();
      ctx.setLineDash([]);
    }, '危険度の境目');
    lx = mx;
    for (const kd of Object.keys(DISTRICT_INFO) as (keyof typeof DISTRICT_INFO)[]) {
      const info = DISTRICT_INFO[kd];
      ctx.fillStyle = info.color;
      ctx.fillRect(lx, ly2 - 4, 10, 8);
      ctx.fillStyle = '#bdb79e';
      ctx.font = `10px ${UI}`;
      ctx.fillText(info.name, lx + 14, ly2);
      lx += 14 + ctx.measureText(info.name).width + 16;
    }
  }

  private locColor(loc: { hot?: boolean; tier: number }): string {
    return loc.hot ? '#d070c0' : loc.tier >= 4 ? '#e05a40' : loc.tier >= 3 ? '#d07a5e' : loc.tier === 2 ? '#d8b862' : '#9fc48a';
  }

  /** 全体地図：旧道の線と橋の記号（名前はラベルの段で置く） */
  private drawMapRoutes(ctx: CanvasRenderingContext2D, X: (t: number) => number, Y: (t: number) => number, s: number): void {
    const F = this.world.features;
    ctx.save();
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    for (const c of F.curves) {
      ctx.beginPath();
      c.pts.forEach(([x, y], i) => (i ? ctx.lineTo(X(x), Y(y)) : ctx.moveTo(X(x), Y(y))));
      ctx.strokeStyle = 'rgba(200,190,150,0.55)';
      ctx.lineWidth = Math.max(2, c.w * s * 0.8);
      ctx.stroke();
    }
    for (const b of F.bridges) {
      const x = X(b.x + b.w / 2);
      const y = Y(b.y + b.h / 2);
      if (b.broken) {
        ctx.strokeStyle = '#e0583e';
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(x - 4, y - 4);
        ctx.lineTo(x + 4, y + 4);
        ctx.moveTo(x + 4, y - 4);
        ctx.lineTo(x - 4, y + 4);
        ctx.stroke();
      } else {
        ctx.fillStyle = '#d8cfb0';
        ctx.fillRect(x - 6, y - 4, 12, 8);
        ctx.strokeStyle = '#2a2418';
        ctx.lineWidth = 1;
        ctx.strokeRect(x - 6, y - 4, 12, 8);
      }
    }
    ctx.restore();
  }

  /** 遠くから見える目印（霧の上に描く）：煙の柱・炎・通信塔の赤いランプ・給水塔 */
  private drawLandmarks(vx0: number, vy0: number, vx1: number, vy1: number): void {
    const { ctx } = this;
    for (const lm of this.world.landmarks) {
      const x = lm.x * TILE;
      const y = lm.y * TILE;
      if (x < vx0 - 300 || x > vx1 + 300 || y < vy0 - 100 || y > vy1 + 500) continue;
      if (lm.kind === 'smoke' || lm.kind === 'fire') {
        for (let i = 0; i < 12; i++) {
          const ph = (this.time * 0.18 + i / 12) % 1;
          const r = 14 + ph * 60;
          const dark = lm.kind === 'smoke' ? 30 : 55;
          ctx.fillStyle = `rgba(${dark},${dark},${dark - 4},${0.3 * (1 - ph)})`;
          ctx.beginPath();
          ctx.arc(x + Math.sin(i * 1.7 + this.time * 0.6) * 18 * ph + ph * 70, y - ph * 320, r, 0, Math.PI * 2);
          ctx.fill();
        }
        if (lm.kind === 'fire') {
          const f = 0.6 + Math.sin(this.time * 11 + lm.x) * 0.25;
          const g = ctx.createRadialGradient(x, y, 0, x, y, 70);
          g.addColorStop(0, `rgba(255,170,70,${0.55 * f})`);
          g.addColorStop(1, 'rgba(255,120,40,0)');
          ctx.fillStyle = g;
          ctx.fillRect(x - 70, y - 70, 140, 140);
        }
      } else if (lm.kind === 'tower') {
        // 格子の通信塔（上から見ると細長い影）と赤いランプ
        ctx.strokeStyle = 'rgba(40,40,36,0.8)';
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(x - 10, y + 10);
        ctx.lineTo(x + 10, y - 10);
        ctx.moveTo(x - 10, y - 10);
        ctx.lineTo(x + 10, y + 10);
        ctx.stroke();
        ctx.strokeStyle = 'rgba(0,0,0,0.35)';
        ctx.lineWidth = 4;
        ctx.beginPath();
        ctx.moveTo(x, y);
        ctx.lineTo(x + 140, y + 160);
        ctx.stroke();
        const on = Math.sin(this.time * 3.5) > 0.2;
        if (on) {
          const g = ctx.createRadialGradient(x, y, 0, x, y, 26);
          g.addColorStop(0, 'rgba(255,70,50,0.9)');
          g.addColorStop(1, 'rgba(255,70,50,0)');
          ctx.fillStyle = g;
          ctx.fillRect(x - 26, y - 26, 52, 52);
        }
      } else {
        ctx.fillStyle = 'rgba(0,0,0,0.3)';
        ctx.beginPath();
        ctx.ellipse(x + 40, y + 50, 34, 26, 0.5, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = '#7a7c74';
        ctx.beginPath();
        ctx.arc(x, y, 26, 0, Math.PI * 2);
        ctx.fill();
        ctx.strokeStyle = '#4a4c46';
        ctx.lineWidth = 3;
        ctx.stroke();
        ctx.fillStyle = 'rgba(255,255,255,0.12)';
        ctx.beginPath();
        ctx.arc(x - 8, y - 8, 10, 0, Math.PI * 2);
        ctx.fill();
      }
    }
  }

}

// ---------------- ヘルパー ----------------


const UI = '"Noto Sans JP", "Segoe UI", sans-serif';
const MONO = '"Share Tech Mono", ui-monospace, Consolas, monospace';
const HEAD = '"Oswald", "Noto Sans JP", sans-serif';

/** タクティカルパネル：ダークガラス＋1px枠＋四隅のL字ブラケット */
/** HUD レイヤーに描いたパネルの位置（照準の弾数表示がパネルに重ならないように使う） */
let panelLog: { x: number; y: number; w: number; h: number }[] | null = null;

function panel(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, fill?: string, accent?: string): void {
  x = Math.round(x);
  y = Math.round(y);
  panelLog?.push({ x, y, w, h });
  const g = ctx.createLinearGradient(0, y, 0, y + h);
  g.addColorStop(0, fill ?? 'rgba(28,31,22,0.84)');
  g.addColorStop(1, fill ?? 'rgba(13,14,10,0.84)');
  ctx.fillStyle = g;
  ctx.fillRect(x, y, w, h);
  ctx.strokeStyle = accent ?? 'rgba(190,180,130,0.22)';
  ctx.lineWidth = 1;
  ctx.strokeRect(x + 0.5, y + 0.5, w - 1, h - 1);
  brackets(ctx, x, y, w, h, accent ?? 'rgba(224,163,58,0.75)', 7, 1.5);
}

/** 四隅のL字 */
function brackets(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, color: string, len: number, lw: number): void {
  ctx.fillStyle = color;
  ctx.fillRect(x, y, len, lw);
  ctx.fillRect(x, y, lw, len);
  ctx.fillRect(x + w - len, y, len, lw);
  ctx.fillRect(x + w - lw, y, lw, len);
  ctx.fillRect(x, y + h - lw, len, lw);
  ctx.fillRect(x, y + h - len, lw, len);
  ctx.fillRect(x + w - len, y + h - lw, len, lw);
  ctx.fillRect(x + w - lw, y + h - len, lw, len);
}

/** 区切り目盛り付きのゲージ */
function segBar(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, ratio: number, color: string, segs: number): void {
  ctx.fillStyle = 'rgba(255,255,240,0.07)';
  ctx.fillRect(x, y, w, h);
  ctx.fillStyle = color;
  ctx.fillRect(x, y, w * clamp(ratio, 0, 1), h);
  ctx.fillStyle = 'rgba(10,11,8,0.55)';
  for (let i = 1; i < segs; i++) ctx.fillRect(Math.round(x + (w * i) / segs), y, 1, h);
  ctx.fillStyle = 'rgba(255,255,255,0.12)';
  ctx.fillRect(x, y, w * clamp(ratio, 0, 1), 1);
}

/** 小さな枠（チップ） */
function chipBox(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, color: string, fill: boolean): void {
  if (fill) {
    ctx.fillStyle = color;
    ctx.fillRect(x, y, w, h);
  } else {
    ctx.strokeStyle = color;
    ctx.lineWidth = 1;
    ctx.strokeRect(x + 0.5, y + 0.5, w - 1, h - 1);
  }
}

/** 弾種バッジ（AP / SLG） */
function ammoBadge(ctx: CanvasRenderingContext2D, x: number, y: number, t: string): void {
  ctx.font = `9px ${MONO}`;
  const tw = ctx.measureText(t).width + 6;
  ctx.fillStyle = '#e08a4a';
  ctx.fillRect(x, y, tw, 12);
  ctx.fillStyle = '#15170f';
  const ta = ctx.textAlign;
  const tb = ctx.textBaseline;
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  ctx.fillText(t, x + 3, y + 6.5);
  ctx.textAlign = ta;
  ctx.textBaseline = tb;
}

/** 操作ヒント：キーキャップ風 */
function keyHint(ctx: CanvasRenderingContext2D, x: number, y: number, text: string, color: string, t: number): void {
  const m = /^\[([^\]]+)\]\s*(.*)$/.exec(text);
  const key = m ? m[1] : '';
  const body = m ? m[2] : text;
  ctx.font = `bold 14px ${UI}`;
  const bw = ctx.measureText(body).width;
  ctx.font = `bold 12px ${MONO}`;
  const kw = key ? ctx.measureText(key).width + 14 : 0;
  const total = kw + (kw ? 8 : 0) + bw + 24;
  const x0 = x - total / 2;
  const pulse = 0.7 + Math.sin(t * 5) * 0.3;
  ctx.fillStyle = 'rgba(12,13,10,0.78)';
  ctx.fillRect(x0, y - 15, total, 30);
  ctx.strokeStyle = color;
  ctx.globalAlpha = 0.35 + pulse * 0.4;
  ctx.strokeRect(x0 + 0.5, y - 14.5, total - 1, 29);
  ctx.globalAlpha = 1;
  brackets(ctx, x0, y - 15, total, 30, color, 6, 1.5);
  let cx = x0 + 12;
  ctx.textBaseline = 'middle';
  if (key) {
    ctx.fillStyle = color;
    ctx.fillRect(cx, y - 9, kw, 18);
    ctx.fillStyle = '#15170f';
    ctx.textAlign = 'center';
    ctx.fillText(key, cx + kw / 2, y + 1);
    cx += kw + 8;
  }
  ctx.font = `bold 14px ${UI}`;
  ctx.textAlign = 'left';
  ctx.fillStyle = '#e6e1cc';
  ctx.fillText(body, cx, y + 1);
  ctx.textAlign = 'center';
}

/** ダウン・戦闘不能などの中央カード */
function centerCard(ctx: CanvasRenderingContext2D, x: number, y: number, title: string, sub: string, color: string, t: number): void {
  ctx.font = `bold 13px ${UI}`;
  const w = Math.max(360, ctx.measureText(sub).width + 60);
  const pulse = 0.6 + Math.sin(t * 6) * 0.4;
  ctx.fillStyle = 'rgba(14,12,10,0.82)';
  ctx.fillRect(x - w / 2, y - 30, w, 64);
  ctx.fillStyle = color;
  ctx.globalAlpha = pulse;
  ctx.fillRect(x - w / 2, y - 30, w, 2);
  ctx.globalAlpha = 1;
  brackets(ctx, x - w / 2, y - 30, w, 64, color, 10, 2);
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.font = `bold 24px ${HEAD}`;
  ctx.fillStyle = color;
  ctx.fillText(title, x, y - 6);
  ctx.font = `bold 13px ${UI}`;
  ctx.fillStyle = '#e6e1cc';
  ctx.fillText(sub, x, y + 20);
}

/** ホットバーのアイコン（ベクター） */
function drawSlotIcon(ctx: CanvasRenderingContext2D, kind: 'axe' | 'pistol' | 'rifle' | 'shotgun' | 'food' | 'medkit', x: number, y: number, dim = false): void {
  ctx.save();
  ctx.translate(x, y);
  if (dim) ctx.globalAlpha = 0.35;
  ctx.lineCap = 'round';
  switch (kind) {
    case 'axe':
      ctx.strokeStyle = '#a77d4f';
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.moveTo(-10, 10);
      ctx.lineTo(8, -8);
      ctx.stroke();
      ctx.fillStyle = '#cfd6df';
      ctx.beginPath();
      ctx.moveTo(3, -12);
      ctx.lineTo(13, -4);
      ctx.lineTo(8, 2);
      ctx.lineTo(1, -6);
      ctx.closePath();
      ctx.fill();
      break;
    case 'pistol':
      ctx.fillStyle = '#cfd6df';
      ctx.fillRect(-11, -6, 20, 6);
      ctx.fillRect(-11, -6, 6, 13);
      ctx.fillStyle = '#7a8594';
      ctx.fillRect(-4, 0, 3, 4);
      break;
    case 'rifle':
      ctx.fillStyle = '#cfd6df';
      ctx.fillRect(-15, -4, 30, 5);
      ctx.fillStyle = '#8a6a48';
      ctx.fillRect(-17, -4, 7, 8);
      ctx.fillStyle = '#7a8594';
      ctx.fillRect(-2, 1, 4, 8);
      ctx.fillRect(8, -6, 3, 2);
      break;
    case 'shotgun':
      ctx.fillStyle = '#9aa3ad';
      ctx.fillRect(-12, -5, 28, 3);
      ctx.fillRect(-12, -2, 24, 3);
      ctx.fillStyle = '#8a5c33';
      ctx.fillRect(-18, -4, 9, 8);
      ctx.fillRect(0, 1, 7, 3);
      if (dim) {
        ctx.globalAlpha = 1;
        ctx.fillStyle = '#c3cbe0';
        ctx.fillRect(-5, -2, 10, 8);
        ctx.strokeStyle = '#c3cbe0';
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.arc(0, -3, 4, Math.PI, 0);
        ctx.stroke();
      }
      break;
    case 'food':
      ctx.fillStyle = '#b8c2cc';
      ctx.fillRect(-7, -9, 14, 18);
      ctx.fillStyle = '#d9534f';
      ctx.fillRect(-7, -4, 14, 8);
      ctx.fillStyle = '#d8c48a';
      ctx.fillRect(-4, -2, 8, 4);
      break;
    case 'medkit':
      ctx.fillStyle = '#e8edf2';
      ctx.fillRect(-10, -8, 20, 16);
      ctx.fillStyle = '#d9534f';
      ctx.fillRect(-2, -6, 4, 12);
      ctx.fillRect(-6, -2, 12, 4);
      break;
  }
  ctx.restore();
}


/** マップ外の森（繰り返しパターン） */
function makeForestPattern(ctx: CanvasRenderingContext2D): CanvasPattern {
  const c = document.createElement('canvas');
  c.width = 160;
  c.height = 160;
  const g = c.getContext('2d')!;
  g.fillStyle = '#12200f';
  g.fillRect(0, 0, 160, 160);
  let seed = 7;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  for (let i = 0; i < 26; i++) {
    const x = rnd() * 160;
    const y = rnd() * 160;
    const r = 14 + rnd() * 16;
    for (const [dx, dy] of [[0, 0], [160, 0], [-160, 0], [0, 160], [0, -160]]) {
      g.fillStyle = 'rgba(0,0,0,0.35)';
      g.beginPath();
      g.arc(x + dx + 6, y + dy + 8, r, 0, Math.PI * 2);
      g.fill();
      g.fillStyle = ['#1a3218', '#203a1c', '#16291a'][i % 3];
      g.beginPath();
      g.arc(x + dx, y + dy, r, 0, Math.PI * 2);
      g.fill();
      g.fillStyle = 'rgba(90,130,70,0.18)';
      g.beginPath();
      g.arc(x + dx - r * 0.3, y + dy - r * 0.3, r * 0.45, 0, Math.PI * 2);
      g.fill();
    }
  }
  return ctx.createPattern(c, 'repeat')!;
}

/** フィルムグレイン用のノイズパターン */
/** CSS 用のフィルムグレイン画像（data URL） */
function makeGrainURL(): string {
  const c = document.createElement('canvas');
  c.width = c.height = 160;
  const g = c.getContext('2d')!;
  const img = g.createImageData(160, 160);
  for (let i = 0; i < img.data.length; i += 4) {
    const v = Math.random() * 255;
    img.data[i] = img.data[i + 1] = img.data[i + 2] = v;
    img.data[i + 3] = 255;
  }
  g.putImageData(img, 0, 0);
  return c.toDataURL('image/png');
}

