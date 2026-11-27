// ============================================================
// サウンド：効果音とBGMを Web Audio API でリアルタイム合成（音声ファイル不使用）
//   - 効果音: ノイズ＋オシレーターの組み合わせ。距離で減衰し、左右に定位
//   - BGM   : 昼 / 夜 / 大襲撃 で曲調が変わる自動生成ミュージック
//   ★ 音声ファイルに差し替える場合は、各メソッドの中身を AudioBuffer の再生に置き換えればOK
// ============================================================
import type { GameEvent, SoundKey, ViewState, WeaponId } from '../types';
import { TILE, ZOMBIE } from './constants';
import { gamepad } from '../ui/Gamepad';

export type MusicMood = 'day' | 'night' | 'horde';

interface AudioSettings {
  music: number; // 0..1
  sfx: number; // 0..1
  muted: boolean;
}

const SETTINGS_KEY = 'deadnights2d.audio';
/** これより遠い音は鳴らさない（px） */
const HEAR_RANGE = 1100;

interface ToneOpts {
  type?: OscillatorType;
  f: number;
  /** 終了時の周波数（ピッチを滑らせる） */
  f2?: number;
  dur: number;
  g: number;
  /** アタック秒 */
  a?: number;
  /** 指定するとサステイン付きの包絡（最後の rel 秒で減衰） */
  rel?: number;
  t?: number;
  pan?: number;
  lp?: number;
  detune?: number;
  bus?: AudioNode;
}

interface NoiseOpts {
  dur: number;
  g: number;
  filter?: BiquadFilterType;
  f?: number;
  f2?: number;
  q?: number;
  a?: number;
  t?: number;
  pan?: number;
  rate?: number;
  bus?: AudioNode;
}

const midi = (n: number) => 440 * Math.pow(2, (n - 69) / 12);

export class AudioManager {
  ctx: AudioContext | null = null;
  private master!: GainNode;
  private sfxBus!: GainNode;
  private musicBus!: GainNode;
  private musicSend!: GainNode;
  private noiseBuf!: AudioBuffer;
  private music: MusicEngine | null = null;
  private lastPlayed = new Map<string, number>();
  private focused = true;
  private groanT = 1;
  private rainT = 0;

  settings: AudioSettings = { music: 0.5, sfx: 0.8, muted: false };
  listener = { x: 0, y: 0 };
  /** 鳴らした回数（動作確認用） */
  stats: Record<string, number> = {};

  constructor() {
    try {
      const raw = localStorage.getItem(SETTINGS_KEY);
      if (raw) this.settings = { ...this.settings, ...JSON.parse(raw) };
    } catch {
      /* 保存できない環境 */
    }
    if (typeof window !== 'undefined') {
      // PC1台で複数ウィンドウを開いても音が重ならないよう、操作中のウィンドウだけ鳴らす
      window.addEventListener('focus', () => this.setFocused(true));
      window.addEventListener('blur', () => this.setFocused(false));
    }
  }

  /** ブラウザの自動再生制限のため、最初のクリック/キー入力で呼ぶ */
  unlock(): void {
    if (!this.ctx) {
      const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      if (!Ctor) return;
      const c = new Ctor();
      this.ctx = c;
      this.master = c.createGain();
      const comp = c.createDynamicsCompressor();
      comp.threshold.value = -14;
      comp.ratio.value = 4;
      this.master.connect(comp);
      comp.connect(c.destination);
      this.sfxBus = c.createGain();
      this.sfxBus.connect(this.master);
      this.musicBus = c.createGain();
      this.musicBus.connect(this.master);
      // BGM用のディレイ（空間の広がり）
      this.musicSend = c.createGain();
      this.musicSend.gain.value = 0.32;
      const delay = c.createDelay(1);
      delay.delayTime.value = 0.36;
      const fb = c.createGain();
      fb.gain.value = 0.38;
      const damp = c.createBiquadFilter();
      damp.type = 'lowpass';
      damp.frequency.value = 2200;
      this.musicSend.connect(delay);
      delay.connect(damp);
      damp.connect(fb);
      fb.connect(delay);
      damp.connect(this.musicBus);
      // ホワイトノイズ（1秒）
      const len = c.sampleRate;
      this.noiseBuf = c.createBuffer(1, len, c.sampleRate);
      const d = this.noiseBuf.getChannelData(0);
      for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
      this.music = new MusicEngine(this);
      this.applyVolumes();
    }
    if (this.ctx.state === 'suspended') void this.ctx.resume();
  }

  get ready(): boolean {
    return !!this.ctx && this.ctx.state === 'running';
  }

  // ---------------- 音量設定 ----------------

  private save(): void {
    try {
      localStorage.setItem(SETTINGS_KEY, JSON.stringify(this.settings));
    } catch {
      /* ignore */
    }
  }

  applyVolumes(): void {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    const on = !this.settings.muted && this.focused ? 1 : 0;
    this.master.gain.setTargetAtTime(on * 0.9, t, 0.05);
    this.sfxBus.gain.setTargetAtTime(this.settings.sfx, t, 0.05);
    this.musicBus.gain.setTargetAtTime(this.settings.music * 0.55, t, 0.05);
  }

  setMusicVolume(v: number): void {
    this.settings.music = v;
    this.save();
    this.applyVolumes();
  }

  setSfxVolume(v: number): void {
    this.settings.sfx = v;
    this.save();
    this.applyVolumes();
  }

  toggleMute(): boolean {
    this.settings.muted = !this.settings.muted;
    this.save();
    this.applyVolumes();
    return this.settings.muted;
  }

  private setFocused(f: boolean): void {
    this.focused = f;
    this.applyVolumes();
  }

  setMood(m: MusicMood | null): void {
    this.music?.setMood(m);
  }

  // ---------------- 合成の基本部品 ----------------

  /** 同じ音の連打を間引く（大群で音が飽和しないように） */
  private gate(key: string, gap: number): boolean {
    if (!this.ctx) return false;
    const now = this.ctx.currentTime;
    const last = this.lastPlayed.get(key) ?? -1;
    if (now - last < gap) return false;
    this.lastPlayed.set(key, now);
    this.stats[key] = (this.stats[key] ?? 0) + 1;
    return true;
  }

  /** 位置から音量倍率と左右定位を求める（聞こえない距離なら null） */
  private spatial(x: number, y: number): { k: number; pan: number } | null {
    const dx = x - this.listener.x;
    const dy = y - this.listener.y;
    const d = Math.hypot(dx, dy);
    if (d > HEAR_RANGE) return null;
    return { k: 1 / (1 + (d / 380) ** 2), pan: Math.max(-0.8, Math.min(0.8, dx / 700)) };
  }

  private route(node: AudioNode, pan: number | undefined, bus: AudioNode): void {
    const c = this.ctx!;
    if (pan && c.createStereoPanner) {
      const p = c.createStereoPanner();
      p.pan.value = pan;
      node.connect(p);
      p.connect(bus);
    } else node.connect(bus);
  }

  private envelope(g: GainNode, t: number, peak: number, a: number, dur: number, rel?: number): void {
    const p = Math.max(0.0002, peak);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(p, t + a);
    if (rel !== undefined) {
      g.gain.setValueAtTime(p, t + Math.max(a, dur - rel));
      g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    } else {
      g.gain.exponentialRampToValueAtTime(0.0001, t + Math.max(a + 0.01, dur));
    }
  }

  tone(o: ToneOpts): void {
    const c = this.ctx;
    if (!c) return;
    const t = o.t ?? c.currentTime;
    const osc = c.createOscillator();
    osc.type = o.type ?? 'sine';
    osc.frequency.setValueAtTime(o.f, t);
    if (o.f2) osc.frequency.exponentialRampToValueAtTime(Math.max(20, o.f2), t + o.dur);
    if (o.detune) osc.detune.value = o.detune;
    const g = c.createGain();
    this.envelope(g, t, o.g, o.a ?? 0.004, o.dur, o.rel);
    let node: AudioNode = osc;
    if (o.lp) {
      const f = c.createBiquadFilter();
      f.type = 'lowpass';
      f.frequency.value = o.lp;
      node.connect(f);
      node = f;
    }
    node.connect(g);
    this.route(g, o.pan, o.bus ?? this.sfxBus);
    osc.start(t);
    osc.stop(t + o.dur + 0.05);
  }

  noise(o: NoiseOpts): void {
    const c = this.ctx;
    if (!c) return;
    const t = o.t ?? c.currentTime;
    const src = c.createBufferSource();
    src.buffer = this.noiseBuf;
    src.playbackRate.value = o.rate ?? 1;
    const g = c.createGain();
    this.envelope(g, t, o.g, o.a ?? 0.002, o.dur);
    let node: AudioNode = src;
    if (o.filter) {
      const f = c.createBiquadFilter();
      f.type = o.filter;
      f.frequency.setValueAtTime(o.f ?? 1000, t);
      if (o.f2) f.frequency.exponentialRampToValueAtTime(o.f2, t + o.dur);
      f.Q.value = o.q ?? 0.8;
      node.connect(f);
      node = f;
    }
    node.connect(g);
    this.route(g, o.pan, o.bus ?? this.sfxBus);
    const offset = Math.random() * 0.5;
    src.start(t, offset, o.dur + 0.05);
  }

  /** 位置付きで鳴らすヘルパー：k=音量倍率, pan=定位 */
  private at(x: number, y: number, local: boolean): { k: number; pan: number } | null {
    if (local) return { k: 1, pan: 0 };
    return this.spatial(x, y);
  }

  // ======================== 効果音 ========================

  shot(x: number, y: number, local: boolean, w: WeaponId = 'pistol'): void {
    if (!this.ready || !this.gate(local ? `shot-${w}` : `shot${Math.round(x)}`, w === 'rifle' ? 0.04 : 0.05)) return;
    const s = this.at(x, y, local);
    if (!s) return;
    const k = s.k * (local ? 1 : 0.75);
    if (w === 'shotgun') {
      // 重く低いドン
      this.noise({ dur: 0.35, g: 0.7 * k, filter: 'lowpass', f: 1400, f2: 180, pan: s.pan });
      this.noise({ dur: 0.08, g: 0.45 * k, filter: 'bandpass', f: 2600, q: 0.5, pan: s.pan });
      this.tone({ type: 'square', f: 110, f2: 32, dur: 0.22, g: 0.32 * k, lp: 600, pan: s.pan });
      if (local) {
        // ポンプアクション
        const t = this.ctx!.currentTime;
        this.noise({ dur: 0.05, g: 0.16, filter: 'bandpass', f: 1500, q: 2, t: t + 0.3 });
        this.noise({ dur: 0.05, g: 0.18, filter: 'bandpass', f: 1100, q: 2, t: t + 0.42 });
      }
    } else if (w === 'rifle') {
      this.noise({ dur: 0.08, g: 0.45 * k, filter: 'bandpass', f: 2300, q: 0.7, pan: s.pan });
      this.noise({ dur: 0.16, g: 0.38 * k, filter: 'lowpass', f: 900, f2: 250, pan: s.pan });
      this.tone({ type: 'square', f: 200, f2: 60, dur: 0.06, g: 0.2 * k, lp: 1000, pan: s.pan });
    } else {
      this.noise({ dur: 0.11, g: 0.55 * k, filter: 'bandpass', f: 1900, q: 0.6, pan: s.pan });
      this.noise({ dur: 0.22, g: 0.45 * k, filter: 'lowpass', f: 700, f2: 200, pan: s.pan });
      this.tone({ type: 'square', f: 170, f2: 45, dur: 0.09, g: 0.25 * k, lp: 900, pan: s.pan });
    }
    // 薬莢が地面に落ちる音
    if (local && Math.random() < 0.7) {
      const t = this.ctx!.currentTime + 0.25 + Math.random() * 0.15;
      this.tone({ f: w === 'shotgun' ? 1900 : 3800 + Math.random() * 800, dur: 0.06, g: 0.035, t });
      this.tone({ f: w === 'shotgun' ? 2300 : 4600, dur: 0.04, g: 0.02, t: t + 0.07 });
    }
  }

  /** UI のクリック音 */
  click(): void {
    if (!this.ready || !this.gate('click', 0.04)) return;
    this.tone({ type: 'triangle', f: 1250, f2: 900, dur: 0.045, g: 0.08 });
    this.noise({ dur: 0.015, g: 0.05, filter: 'highpass', f: 4000 });
  }

  private turretShot(x: number, y: number): void {
    if (!this.gate('tshot', 0.06)) return;
    const s = this.spatial(x, y);
    if (!s) return;
    this.noise({ dur: 0.07, g: 0.3 * s.k, filter: 'bandpass', f: 2600, q: 0.8, pan: s.pan });
    this.tone({ type: 'square', f: 260, f2: 90, dur: 0.06, g: 0.12 * s.k, lp: 1400, pan: s.pan });
    this.tone({ f: 3200, dur: 0.03, g: 0.03 * s.k, pan: s.pan });
  }

  emptyClick(): void {
    if (!this.ready || !this.gate('empty', 0.2)) return;
    this.tone({ type: 'square', f: 1400, dur: 0.025, g: 0.08 });
  }

  swing(x: number, y: number, local: boolean): void {
    if (!this.ready || !this.gate(`swing${local ? 'L' : Math.round(x)}`, 0.15)) return;
    const s = this.at(x, y, local);
    if (!s) return;
    this.noise({ dur: 0.2, g: 0.22 * s.k, filter: 'bandpass', f: 700, f2: 2600, q: 1.4, a: 0.07, pan: s.pan });
  }

  reload(x: number, y: number, local: boolean): void {
    if (!this.ready || !this.gate(`reload${local ? 'L' : Math.round(x)}`, 0.5)) return;
    const s = this.at(x, y, local);
    if (!s) return;
    const t = this.ctx!.currentTime;
    const k = s.k * 0.9;
    this.tone({ type: 'square', f: 900, dur: 0.03, g: 0.1 * k, t, lp: 3000, pan: s.pan });
    this.noise({ dur: 0.04, g: 0.18 * k, filter: 'highpass', f: 2500, t, pan: s.pan });
    this.noise({ dur: 0.05, g: 0.2 * k, filter: 'bandpass', f: 1800, t: t + 0.45, pan: s.pan });
    this.tone({ type: 'square', f: 600, dur: 0.04, g: 0.1 * k, t: t + 1.15, lp: 2500, pan: s.pan });
    this.tone({ type: 'square', f: 1100, dur: 0.03, g: 0.1 * k, t: t + 1.25, lp: 3000, pan: s.pan });
  }

  private fleshHit(x: number, y: number): void {
    if (!this.gate('hit', 0.04)) return;
    const s = this.spatial(x, y);
    if (!s) return;
    this.noise({ dur: 0.09, g: 0.3 * s.k, filter: 'lowpass', f: 900, pan: s.pan });
    this.tone({ f: 130, f2: 60, dur: 0.1, g: 0.28 * s.k, pan: s.pan });
  }

  private meleeHit(x: number, y: number): void {
    if (!this.gate('melee', 0.05)) return;
    const s = this.spatial(x, y);
    if (!s) return;
    this.noise({ dur: 0.12, g: 0.45 * s.k, filter: 'lowpass', f: 1100, pan: s.pan });
    this.tone({ type: 'triangle', f: 160, f2: 70, dur: 0.14, g: 0.4 * s.k, pan: s.pan });
    this.noise({ dur: 0.05, g: 0.2 * s.k, filter: 'bandpass', f: 600, q: 2, pan: s.pan });
  }

  private ricochet(x: number, y: number): void {
    if (!this.gate('ricochet', 0.05)) return;
    const s = this.spatial(x, y);
    if (!s) return;
    this.noise({ dur: 0.05, g: 0.12 * s.k, filter: 'highpass', f: 3000, pan: s.pan });
    this.tone({ f: 2600 + Math.random() * 800, f2: 1600, dur: 0.08, g: 0.04 * s.k, pan: s.pan });
  }

  private zombieDie(x: number, y: number, big: boolean): void {
    if (!this.gate('zdie', 0.06)) return;
    const s = this.spatial(x, y);
    if (!s) return;
    const f = big ? 90 : 150 + Math.random() * 40;
    this.tone({ type: 'sawtooth', f, f2: f * 0.4, dur: 0.55, g: 0.16 * s.k, lp: 650, a: 0.02, pan: s.pan });
    this.noise({ dur: 0.3, g: 0.25 * s.k, filter: 'lowpass', f: 500, pan: s.pan });
  }

  groan(x: number, y: number, horde: boolean, big: boolean): void {
    if (!this.ready || !this.gate('groan', 0.25)) return;
    const s = this.spatial(x, y);
    if (!s) return;
    const base = (big ? 60 : 85) + Math.random() * 40;
    const dur = 0.7 + Math.random() * 0.6;
    const g = (horde ? 0.12 : 0.1) * s.k;
    this.tone({ type: 'sawtooth', f: base, f2: base * 0.75, dur, g, a: 0.15, lp: 480, detune: 12, pan: s.pan });
    this.tone({ type: 'sawtooth', f: base * 1.01, f2: base * 0.7, dur, g: g * 0.7, a: 0.2, lp: 420, detune: -14, pan: s.pan });
    this.noise({ dur: dur * 0.8, g: g * 0.6, filter: 'bandpass', f: 600, q: 3, a: 0.2, pan: s.pan });
  }

  private hurt(): void {
    if (!this.gate('hurt', 0.12)) return;
    this.tone({ type: 'square', f: 240, f2: 90, dur: 0.16, g: 0.18, lp: 1100 });
    this.noise({ dur: 0.12, g: 0.28, filter: 'lowpass', f: 700 });
  }

  private down(x: number, y: number, local: boolean): void {
    const s = this.at(x, y, local) ?? { k: 0.4, pan: 0 };
    this.tone({ type: 'triangle', f: 440, f2: 110, dur: 0.8, g: 0.25 * Math.max(0.4, s.k), pan: s.pan });
    this.tone({ type: 'triangle', f: 330, f2: 82, dur: 0.9, g: 0.15 * Math.max(0.4, s.k), pan: s.pan, t: this.ctx!.currentTime + 0.05 });
  }

  private revive(): void {
    const t = this.ctx!.currentTime;
    [523, 659, 784, 1046].forEach((f, i) => this.tone({ type: 'triangle', f, dur: 0.3, g: 0.16, t: t + i * 0.08 }));
  }

  private toll(): void {
    this.tone({ f: 98, dur: 2, g: 0.25, a: 0.01 });
    this.tone({ f: 196, dur: 1.4, g: 0.08, a: 0.01 });
  }

  private chop(x: number, y: number, kind: string): void {
    if (!this.gate('chop', 0.08)) return;
    const s = this.spatial(x, y);
    if (!s) return;
    if (kind === 'car') {
      this.tone({ type: 'square', f: 620, f2: 590, dur: 0.18, g: 0.09 * s.k, lp: 3000, pan: s.pan });
      this.tone({ f: 1390, dur: 0.3, g: 0.07 * s.k, pan: s.pan });
      this.noise({ dur: 0.05, g: 0.18 * s.k, filter: 'highpass', f: 2000, pan: s.pan });
    } else {
      this.tone({ type: 'triangle', f: 320, f2: 170, dur: 0.09, g: 0.35 * s.k, pan: s.pan });
      this.noise({ dur: 0.06, g: 0.25 * s.k, filter: 'bandpass', f: 1300, pan: s.pan });
    }
  }

  private hammer(x: number, y: number): void {
    if (!this.gate('hammer', 0.1)) return;
    const s = this.spatial(x, y);
    if (!s) return;
    const t = this.ctx!.currentTime;
    for (const dt of [0, 0.11]) {
      this.tone({ type: 'triangle', f: 560, f2: 300, dur: 0.07, g: 0.3 * s.k, t: t + dt, pan: s.pan });
      this.noise({ dur: 0.03, g: 0.16 * s.k, filter: 'bandpass', f: 2200, t: t + dt, pan: s.pan });
    }
  }

  private smash(x: number, y: number, kind: string): void {
    if (!this.gate('smash', 0.07)) return;
    const s = this.spatial(x, y);
    if (!s) return;
    if (kind === 'ironWall') {
      this.tone({ type: 'square', f: 310, dur: 0.22, g: 0.1 * s.k, lp: 2200, pan: s.pan });
      this.tone({ f: 870, dur: 0.3, g: 0.06 * s.k, pan: s.pan });
    } else if (kind === 'stone') {
      this.noise({ dur: 0.2, g: 0.35 * s.k, filter: 'lowpass', f: 650, pan: s.pan });
    } else {
      this.noise({ dur: 0.14, g: 0.32 * s.k, filter: 'lowpass', f: 1300, pan: s.pan });
      this.tone({ f: 115, f2: 70, dur: 0.12, g: 0.28 * s.k, pan: s.pan });
    }
  }

  private crash(x: number, y: number, kind: string): void {
    if (!this.gate('crash', 0.08)) return;
    const s = this.spatial(x, y);
    if (!s) return;
    if (kind === 'tree') {
      this.tone({ type: 'sawtooth', f: 210, f2: 110, dur: 0.45, g: 0.07 * s.k, lp: 900, a: 0.05, pan: s.pan });
      this.noise({ dur: 0.9, g: 0.35 * s.k, filter: 'lowpass', f: 900, f2: 200, a: 0.25, pan: s.pan });
    } else {
      this.noise({ dur: 0.65, g: 0.5 * s.k, filter: 'lowpass', f: 1900, f2: 260, pan: s.pan });
      this.tone({ f: 85, f2: 40, dur: 0.45, g: 0.35 * s.k, pan: s.pan });
      if (kind === 'ironWall' || kind === 'car') this.tone({ type: 'square', f: 420, f2: 300, dur: 0.4, g: 0.06 * s.k, lp: 2500, pan: s.pan });
    }
  }

  private burn(x: number, y: number): void {
    if (!this.gate('burn', 0.1)) return;
    const s = this.spatial(x, y);
    if (!s) return;
    this.noise({ dur: 0.9, g: 0.12 * s.k, filter: 'highpass', f: 1500, a: 0.1, pan: s.pan });
  }

  private ui(key: SoundKey): void {
    if (!this.gate(`ui-${key}`, 0.08)) return;
    const t = this.ctx!.currentTime;
    switch (key) {
      case 'loot':
        this.tone({ f: 880, dur: 0.12, g: 0.13, t });
        this.tone({ f: 1320, dur: 0.18, g: 0.13, t: t + 0.07 });
        break;
      case 'eat':
        for (let i = 0; i < 3; i++) this.noise({ dur: 0.05, g: 0.2, filter: 'bandpass', f: 1400 + i * 200, q: 2, t: t + i * 0.13 });
        break;
      case 'heal':
        this.tone({ f: 660, f2: 990, dur: 0.35, g: 0.12, t });
        this.tone({ f: 990, f2: 1320, dur: 0.4, g: 0.1, t: t + 0.15 });
        break;
      case 'level':
        [523, 659, 784, 1046].forEach((f, i) => this.tone({ type: 'triangle', f, dur: 0.16, g: 0.09, t: t + i * 0.07 }));
        break;
      case 'alarm':
        for (let i = 0; i < 3; i++) this.tone({ type: 'square', f: 880, f2: 660, dur: 0.14, g: 0.07, lp: 2400, t: t + i * 0.2 });
        break;
      case 'craft':
        [400, 600, 900].forEach((f, i) => this.tone({ type: 'square', f, dur: 0.06, g: 0.07, lp: 3000, t: t + i * 0.08 }));
        break;
      case 'error':
        this.tone({ type: 'square', f: 180, dur: 0.1, g: 0.1, lp: 1200, t });
        this.tone({ type: 'square', f: 160, dur: 0.12, g: 0.1, lp: 1200, t: t + 0.13 });
        break;
      case 'day':
        [784, 1046, 1318].forEach((f, i) => this.tone({ f, dur: 1.4, g: 0.1, a: 0.01, t: t + i * 0.18 }));
        break;
      case 'night':
        this.tone({ f: 110, dur: 3.2, g: 0.22, a: 0.9, rel: 1.5, t });
        this.tone({ f: 164.8, dur: 3.2, g: 0.12, a: 1.1, rel: 1.5, t });
        this.tone({ f: 130.8, dur: 3.2, g: 0.08, a: 1.3, rel: 1.5, t });
        break;
      case 'horde': {
        // サイレン＋低いホーン
        const c = this.ctx!;
        const osc = c.createOscillator();
        osc.type = 'sawtooth';
        const g = c.createGain();
        const f = c.createBiquadFilter();
        f.type = 'lowpass';
        f.frequency.value = 1400;
        for (let i = 0; i < 2; i++) {
          osc.frequency.setValueAtTime(300, t + i * 2.4);
          osc.frequency.linearRampToValueAtTime(640, t + i * 2.4 + 1.2);
          osc.frequency.linearRampToValueAtTime(300, t + i * 2.4 + 2.4);
        }
        this.envelope(g, t, 0.11, 0.4, 4.8, 0.8);
        osc.connect(f);
        f.connect(g);
        g.connect(this.sfxBus);
        osc.start(t);
        osc.stop(t + 4.9);
        this.tone({ type: 'sawtooth', f: 55, dur: 2.5, g: 0.22, a: 0.3, rel: 0.8, lp: 380, t });
        this.tone({ type: 'sawtooth', f: 82.4, dur: 2.5, g: 0.14, a: 0.3, rel: 0.8, lp: 380, t });
        break;
      }
      case 'clear':
        [523, 659, 784].forEach((f, i) => this.tone({ type: 'triangle', f, dur: 0.25, g: 0.16, t: t + i * 0.13 }));
        this.tone({ type: 'triangle', f: 1046, dur: 1.2, g: 0.18, a: 0.01, rel: 0.6, t: t + 0.39 });
        this.tone({ type: 'triangle', f: 784, dur: 1.2, g: 0.1, a: 0.01, rel: 0.6, t: t + 0.39 });
        break;
    }
  }

  gameOver(): void {
    if (!this.ready) return;
    this.setMood(null);
    const t = this.ctx!.currentTime;
    [392, 349, 311, 262].forEach((f, i) => this.tone({ type: 'triangle', f, dur: 0.7, g: 0.18, a: 0.01, t: t + i * 0.38 }));
    this.tone({ type: 'sawtooth', f: 65, dur: 3, g: 0.12, a: 0.5, rel: 1.5, lp: 300, t });
  }

  /** ゲームイベント → 効果音 */
  handleEvent(ev: GameEvent, localId: number): void {
    if (!this.ready) return;
    switch (ev.k) {
      case 'hit':
        if (ev.m) this.meleeHit(ev.x, ev.y);
        else this.fleshHit(ev.x, ev.y);
        // 自分の弾が当たった：小さく高い命中音（ヒットマーカー）
        if (ev.o === localId && !ev.m && this.gate('hitconf', 0.03)) this.tone({ type: 'square', f: 1850, dur: 0.035, g: 0.045, lp: 4000 });
        break;
      case 'wall':
        this.ricochet(ev.x, ev.y);
        break;
      case 'kill':
        this.zombieDie(ev.x, ev.y, ev.r >= ZOMBIE.brute.radius);
        // 自分が倒した：低く短い「手応え」の音
        if (ev.o === localId && this.gate('killconf', 0.05)) this.tone({ type: 'triangle', f: 220, f2: 110, dur: 0.12, g: 0.14 });
        break;
      case 'phit':
        if (ev.id === localId) {
          this.hurt();
          gamepad.rumble(0.6, 0.4, 160);
        }
        break;
      case 'down':
        this.down(ev.x, ev.y, ev.id === localId);
        break;
      case 'revive':
        this.revive();
        break;
      case 'dead':
        if (ev.id === localId) this.toll();
        break;
      case 'chop':
        this.chop(ev.x, ev.y, ev.kind);
        break;
      case 'built':
        this.hammer(ev.x, ev.y);
        break;
      case 'crash':
        this.crash(ev.x, ev.y, 'car');
        if (Math.hypot(ev.x - this.listener.x, ev.y - this.listener.y) < 200) gamepad.rumble(0.3 + ev.hard * 0.7, 0.3, 120 + ev.hard * 200);
        break;
      case 'smash':
        this.smash(ev.x, ev.y, ev.kind);
        break;
      case 'break':
        this.crash(ev.x, ev.y, ev.kind);
        break;
      case 'burn':
        this.burn(ev.x, ev.y);
        break;
      case 'boom': {
        const s = this.spatial(ev.x, ev.y);
        if (s) {
          this.noise({ dur: 1.4, g: 0.8 * s.k, filter: 'lowpass', f: 1400, f2: 120, pan: s.pan });
          this.tone({ f: 70, f2: 28, dur: 0.9, g: 0.6 * s.k, pan: s.pan });
        }
        break;
      }
      case 'gas': {
        const s = this.spatial(ev.x, ev.y);
        if (s) {
          this.tone({ type: 'sawtooth', f: 120, f2: 60, dur: 0.4, g: 0.12 * s.k, lp: 500, pan: s.pan });
          this.noise({ dur: 1.6, g: 0.25 * s.k, filter: 'bandpass', f: 900, f2: 400, a: 0.05, pan: s.pan });
        }
        break;
      }
      case 'scream': {
        const s = this.spatial(ev.x, ev.y);
        if (s) {
          this.tone({ type: 'sawtooth', f: 620, f2: 980, dur: 1.1, g: 0.14 * s.k, lp: 3200, a: 0.05, rel: 0.6, pan: s.pan });
          this.tone({ type: 'square', f: 455, f2: 700, dur: 1.0, g: 0.05 * s.k, lp: 2400, a: 0.08, pan: s.pan });
        }
        break;
      }
      case 'tshot':
        this.turretShot(ev.x, ev.y);
        break;
      case 'door': {
        const s = this.spatial(ev.x, ev.y);
        if (!s || !this.gate('door', 0.1)) break;
        const t = this.ctx!.currentTime;
        if (ev.open) {
          // きしむ音
          this.tone({ type: 'sawtooth', f: 180, f2: 240, dur: 0.35, g: 0.05 * s.k, lp: 900, a: 0.05, pan: s.pan, t });
          this.noise({ dur: 0.08, g: 0.12 * s.k, filter: 'bandpass', f: 900, q: 2, pan: s.pan, t });
        } else {
          // バタンと閉まる音
          this.noise({ dur: 0.14, g: 0.35 * s.k, filter: 'lowpass', f: 700, pan: s.pan, t });
          this.tone({ f: 110, f2: 60, dur: 0.12, g: 0.3 * s.k, pan: s.pan, t });
        }
        break;
      }
      case 'feed':
        if (ev.snd && (ev.id === undefined || ev.id === localId || ev.snd === 'alarm')) this.ui(ev.snd);
        break;
      case 'ricochet': {
        const s = this.spatial(ev.x, ev.y);
        if (!s || !this.gate('rico', 0.08)) break;
        this.tone({ type: 'triangle', f: 2400 + Math.random() * 900, f2: 1500, dur: 0.12, g: 0.05 * s.k, pan: s.pan });
        break;
      }
      case 'search': {
        const s = this.spatial(ev.x, ev.y);
        if (!s) break;
        const t = this.ctx!.currentTime;
        if (!ev.done) {
          // ガサゴソと漁る音
          for (let i = 0; i < 5; i++) this.noise({ dur: 0.12, g: (0.08 + Math.random() * 0.05) * s.k, filter: 'bandpass', f: 1400 + Math.random() * 1400, q: 1.5, pan: s.pan, t: t + i * 0.28 + Math.random() * 0.08 });
        } else if (ev.id === localId) {
          this.tone({ type: 'triangle', f: 660, dur: 0.08, g: 0.07, t });
          this.tone({ type: 'triangle', f: 990, dur: 0.12, g: 0.07, t: t + 0.07 });
        }
        break;
      }
      case 'alert': {
        // 気づかれた！（短い叫び声）
        const s = this.spatial(ev.x, ev.y);
        if (!s || !this.gate('alert', 0.35)) break;
        const t = this.ctx!.currentTime;
        this.tone({ type: 'sawtooth', f: 240 + Math.random() * 60, f2: 140, dur: 0.45, g: 0.16 * s.k, lp: 1300, a: 0.03, pan: s.pan, t });
        this.noise({ dur: 0.3, g: 0.1 * s.k, filter: 'bandpass', f: 900, q: 1, pan: s.pan, t });
        break;
      }
      case 'ping': {
        const t = this.ctx!.currentTime;
        const [a, b] = ev.t === 'enemy' ? [880, 660] : ev.t === 'loot' ? [988, 1318] : [784, 1046];
        this.tone({ type: 'triangle', f: a, dur: 0.12, g: 0.12, t });
        this.tone({ type: 'triangle', f: b, dur: 0.18, g: 0.12, t: t + 0.1 });
        break;
      }
      case 'pop':
        // 自分宛ての通知音だけ鳴らす
        if (ev.s && ev.id === localId) this.ui(ev.s);
        break;
      case 'banner':
        if (ev.snd) this.ui(ev.snd);
        break;
      default:
        break;
    }
  }

  /** 毎フレーム：リスナー位置の更新と環境音（ゾンビのうめき声・焚き火） */
  private engineT = 0;
  update(dt: number, view: ViewState, campfires: { x: number; y: number }[]): void {
    if (!this.ready) return;
    // 車のエンジン音（近くの走っている車ごとに、速さで音程が上がる低いうなり）
    this.engineT -= dt;
    if (this.engineT <= 0) {
      this.engineT = 0.12;
      for (const v of view.vehicles ?? []) {
        const occupied = v.seats.some((id) => id >= 0);
        if (!occupied || v.broken) continue;
        const s = this.spatial(v.x, v.y);
        if (!s) continue;
        const sp = Math.min(1, Math.abs(v.spd) / 560);
        this.tone({ type: 'sawtooth', f: 46 + sp * 70, f2: 48 + sp * 74, dur: 0.16, g: (0.02 + sp * 0.035) * s.k, lp: 380 + sp * 500, pan: s.pan, a: 0.02 });
      }
    }
    // 追われているときは緊迫した曲調に
    const chased = view.zombies.some((z) => z.alert === 2 && Math.hypot(z.x - this.listener.x, z.y - this.listener.y) < 650);
    this.music?.setMood(chased ? 'horde' : view.phase);
    // 雨音・雷鳴
    if (view.weather === 'rain' || view.weather === 'storm') {
      this.rainT -= dt;
      if (this.rainT <= 0) {
        this.rainT = 0.3;
        const k = view.wx * (view.weather === 'storm' ? 1.4 : 1);
        this.noise({ dur: 0.45, g: 0.05 * k, filter: 'bandpass', f: 2600 + Math.random() * 1200, q: 0.4, a: 0.1 });
        this.noise({ dur: 0.45, g: 0.035 * k, filter: 'lowpass', f: 600, a: 0.1 });
        if (view.weather === 'storm' && Math.random() < 0.012 * view.wx * 10) {
          const t = this.ctx!.currentTime + 0.2 + Math.random() * 0.6;
          this.noise({ dur: 2.4, g: 0.3 * view.wx, filter: 'lowpass', f: 300, f2: 60, a: 0.05, t });
        }
      }
    }
    // うめき声：近くのゾンビが多いほど頻繁に
    this.groanT -= dt;
    if (this.groanT <= 0) {
      const near = view.zombies.filter((z) => Math.hypot(z.x - this.listener.x, z.y - this.listener.y) < 750);
      if (near.length > 0) {
        const z = near[Math.floor(Math.random() * near.length)];
        this.groan(z.x, z.y, z.alert === 2, z.type === 'brute');
        const base = near.some((z) => z.alert === 2) ? 0.6 : 1.6;
        this.groanT = (base + Math.random() * base * 1.5) / Math.sqrt(near.length);
      } else this.groanT = 0.8;
    }
    // 焚き火のパチパチ音
    for (const f of campfires) {
      const d = Math.hypot(f.x - this.listener.x, f.y - this.listener.y);
      if (d < TILE * 8 && Math.random() < dt * 9) {
        const s = this.spatial(f.x, f.y);
        if (s) this.noise({ dur: 0.015 + Math.random() * 0.02, g: 0.12 * s.k, filter: 'bandpass', f: 2500 + Math.random() * 2500, q: 2, pan: s.pan });
      }
    }
  }

  /** BGM 用の出力先 */
  get musicOut(): { dry: AudioNode; send: AudioNode } {
    return { dry: this.musicBus, send: this.musicSend };
  }
}

// ============================================================
// 自動生成BGM（16分音符単位のステップシーケンサー）
// ============================================================
class MusicEngine {
  private mood: MusicMood | null = null;
  private nextMood: MusicMood | null = null;
  private step = 0;
  private bar = 0;
  private nextTime = 0;
  private timer = 0;

  constructor(private a: AudioManager) {}

  setMood(m: MusicMood | null): void {
    if (m === this.nextMood) return;
    this.nextMood = m;
    if (m && !this.timer) {
      this.mood = m;
      this.step = 0;
      this.bar = 0;
      this.nextTime = this.a.ctx!.currentTime + 0.1;
      this.timer = window.setInterval(() => this.schedule(), 25);
    }
    if (!m && this.timer) {
      clearInterval(this.timer);
      this.timer = 0;
      this.mood = null;
    }
  }

  private bpm(): number {
    return this.mood === 'horde' ? 132 : this.mood === 'night' ? 62 : 76;
  }

  private schedule(): void {
    const ctx = this.a.ctx;
    if (!ctx || !this.mood) return;
    // タブが裏で止まっていた場合は追いつこうとせず現在時刻から再開
    if (this.nextTime < ctx.currentTime - 0.3) this.nextTime = ctx.currentTime + 0.05;
    while (this.nextTime < ctx.currentTime + 0.15) {
      if (this.step % 16 === 0 && this.nextMood && this.nextMood !== this.mood) {
        this.mood = this.nextMood;
        this.bar = 0;
      }
      this.playStep(this.step % 16, this.nextTime);
      this.nextTime += 60 / this.bpm() / 4;
      this.step++;
      if (this.step % 16 === 0) this.bar++;
    }
  }

  private playStep(s: number, t: number): void {
    const { dry, send } = this.a.musicOut;
    const beat = 60 / this.bpm();
    const barDur = beat * 4;
    const note = (n: number, o: Partial<ToneOpts> & { dur: number; g: number }, wet = false) =>
      this.a.tone({ f: midi(n), t, bus: wet ? send : dry, ...o });

    if (this.mood === 'day') {
      // C - Am - F - G の穏やかな進行
      const prog = [
        [48, 52, 55],
        [45, 48, 52],
        [41, 45, 48],
        [43, 47, 50],
      ];
      const ch = prog[this.bar % 4];
      if (s === 0) {
        for (const n of ch) {
          note(n + 12, { type: 'triangle', dur: barDur * 1.05, g: 0.035, a: 0.6, rel: 0.8, lp: 1400 });
          note(n + 12, { type: 'sine', dur: barDur * 1.05, g: 0.03, a: 0.6, rel: 0.8, detune: 7 });
        }
      }
      if (s === 0 || s === 8) note(ch[0] - 12, { type: 'sine', dur: beat * 1.6, g: 0.1, a: 0.02, rel: 0.4 });
      if (s % 2 === 0 && Math.random() < 0.3) {
        const n = ch[Math.floor(Math.random() * 3)] + 24;
        note(n, { type: 'triangle', dur: 0.45, g: 0.04 }, true);
      }
    } else if (this.mood === 'night') {
      // Am - Am - F - E の暗い進行＋心音
      const prog = [
        [45, 48, 52],
        [45, 48, 52],
        [41, 45, 48],
        [40, 44, 47],
      ];
      const ch = prog[this.bar % 4];
      if (s === 0) {
        for (const n of ch) note(n, { type: 'sine', dur: barDur * 1.1, g: 0.04, a: 1.2, rel: 1.2 });
        note(ch[0] - 24, { type: 'sawtooth', dur: barDur * 1.05, g: 0.035, a: 0.8, rel: 0.8, lp: 220 });
      }
      if (s === 0 || s === 3 || s === 8 || s === 11) {
        const soft = s === 3 || s === 11 ? 0.6 : 1;
        this.a.tone({ f: 62, f2: 40, dur: 0.18, g: 0.12 * soft, t, bus: dry });
      }
      if (s % 4 === 2 && Math.random() < 0.18) {
        const pent = [69, 72, 74, 76, 79, 81];
        note(pent[Math.floor(Math.random() * pent.length)], { type: 'sine', dur: 1.6, g: 0.035, a: 0.01 }, true);
      }
    } else if (this.mood === 'horde') {
      // Dm - Dm - Bb - A の緊迫したビート
      const prog = [
        [50, 53, 57],
        [50, 53, 57],
        [46, 50, 53],
        [45, 49, 52],
      ];
      const ch = prog[this.bar % 4];
      if (s % 2 === 0) {
        const oct = s % 8 === 6 ? 12 : 0;
        note(ch[0] - 12 + oct, { type: 'sawtooth', dur: 0.13, g: 0.07, lp: 520 });
      }
      if (s % 4 === 0) this.a.tone({ f: 150, f2: 42, dur: 0.22, g: 0.3, t, bus: dry });
      if (s === 4 || s === 12) {
        this.a.noise({ dur: 0.16, g: 0.14, filter: 'bandpass', f: 1800, t, bus: dry });
        this.a.tone({ f: 210, f2: 150, dur: 0.08, g: 0.07, t, bus: dry });
      }
      if (s % 2 === 1) this.a.noise({ dur: 0.03, g: 0.035, filter: 'highpass', f: 7000, t, bus: dry });
      if (s === 0) for (const n of ch) note(n + 12, { type: 'square', dur: 0.3, g: 0.022, lp: 1700 });
      if (this.bar % 2 === 1 && (s === 0 || s === 3 || s === 6 || s === 10)) {
        note(ch[(s / 3) % 3 | 0] + 24, { type: 'sawtooth', dur: 0.22, g: 0.025, lp: 2200 }, true);
      }
    }
  }
}

/** アプリ全体で1つのサウンドマネージャ */
export const audio = new AudioManager();
