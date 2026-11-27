// ============================================================
// アイテム定義とインベントリ（スロット制）
//   バックパック 16 マス。弾・素材などはスタック可能、武器は1マスに1丁（装填数・アタッチメントを保持）
// ============================================================

export type ItemId =
  | 'ammo9'
  | 'ammo9ap'
  | 'ammo762'
  | 'ammo762ap'
  | 'shells'
  | 'slug'
  | 'bandage'
  | 'medkit'
  | 'stim'
  | 'can'
  | 'mre'
  | 'scrap'
  | 'cloth'
  | 'gunpowder'
  | 'parts'
  | 'chem'
  | 'electronics'
  | 'tools'
  | 'scope'
  | 'holo'
  | 'suppressor'
  | 'extmag'
  | 'grip'
  | 'pistol'
  | 'smg'
  | 'rifle'
  | 'shotgun'
  | 'hunting'
  | 'dmr'
  | 'valuables'
  | 'antitox'
  | 'herbs'
  | 'intel'
  | 'water'
  | 'stew'
  | 'tea'
  | 'fuel'
  | 'splint'
  | 'coat'
  | 'pack1'
  | 'pack2'
  | 'pack3';

export type ItemCat = 'ammo' | 'med' | 'food' | 'mat' | 'att' | 'weapon' | 'misc';
/** レア度（0=ありふれた 1=普通 2=レア 3=非常にレア）。UIの枠色に使う */
export type Rarity = 0 | 1 | 2 | 3;

export interface ItemDef {
  id: ItemId;
  name: string;
  stack: number;
  cat: ItemCat;
  /** 帰還時の評価額（リザルトの「持ち帰った価値」） */
  value: number;
  desc: string;
  rarity: Rarity;
}

/** 武器ごとの状態（装填数・装填中の弾種・アタッチメント） */
export interface WeaponState {
  mag: number;
  /** 1 = 徹甲弾／スラッグ弾を装填中 */
  ap?: number;
  scope?: number;
  holo?: number;
  suppressor?: number;
  extmag?: number;
  grip?: number;
}

export interface Slot {
  id: ItemId;
  n: number;
  w?: WeaponState;
}

const D = (id: ItemId, name: string, stack: number, cat: ItemCat, value: number, rarity: Rarity, desc: string): ItemDef => ({ id, name, stack, cat, value, rarity, desc });

export const ITEMS: Record<ItemId, ItemDef> = {
  ammo9: D('ammo9', '9mm弾', 60, 'ammo', 1, 0, 'ハンドガン・SMG 用の通常弾'),
  ammo9ap: D('ammo9ap', '9mm徹甲弾', 40, 'ammo', 3, 2, '装甲を無視し、敵を1体貫通する'),
  ammo762: D('ammo762', '7.62mm弾', 40, 'ammo', 2, 1, 'ライフル用の通常弾'),
  ammo762ap: D('ammo762ap', '7.62mm徹甲弾', 30, 'ammo', 5, 2, '装甲を無視し、敵を2体まで貫通する'),
  shells: D('shells', '12ゲージ散弾', 24, 'ammo', 2, 0, 'ショットガン用。近距離で広く当たる'),
  slug: D('slug', '12ゲージスラッグ', 16, 'ammo', 4, 2, 'ショットガン用の一粒弾。遠くまで届き装甲を抜く'),
  bandage: D('bandage', '包帯', 5, 'med', 6, 0, 'HP +25'),
  medkit: D('medkit', '救急キット', 3, 'med', 20, 1, 'HP +65・汚染度 -25'),
  stim: D('stim', '興奮剤', 3, 'med', 30, 2, 'HP +15・スタミナ全快・汚染度 -15・しばらく疲れにくい'),
  can: D('can', '缶詰', 5, 'food', 5, 0, '空腹 +35'),
  mre: D('mre', '軍用レーション', 3, 'food', 12, 1, '空腹 +70・HP +10'),
  scrap: D('scrap', '鉄くず', 20, 'mat', 1, 0, 'クラフト・拠点強化の素材'),
  cloth: D('cloth', '布', 20, 'mat', 1, 0, '包帯や倉庫拡張の材料'),
  gunpowder: D('gunpowder', '火薬', 20, 'mat', 3, 0, '弾薬の材料'),
  parts: D('parts', '武器パーツ', 10, 'mat', 12, 1, 'アタッチメント・作業台強化の材料'),
  chem: D('chem', '薬品', 10, 'mat', 6, 1, '救急キット・医務室の材料'),
  electronics: D('electronics', '電子部品', 10, 'mat', 10, 1, '光学サイト・設備強化の材料'),
  tools: D('tools', '工具セット', 5, 'mat', 25, 2, '拠点設備の強化に必要な希少素材'),
  scope: D('scope', '4倍スコープ', 1, 'att', 55, 2, '集弾率が大きく上がり、狙う方向の視界が伸びる（光学スロット）'),
  holo: D('holo', 'ホロサイト', 1, 'att', 40, 1, '集弾率と反動が改善（光学スロット）'),
  suppressor: D('suppressor', 'サプレッサー', 1, 'att', 50, 2, '銃声が約1/3になり気づかれにくい。威力 -8%'),
  extmag: D('extmag', '拡張マガジン', 1, 'att', 35, 1, '装弾数 +60%・リロード +12%'),
  grip: D('grip', 'フォアグリップ', 1, 'att', 30, 1, '連射時の反動が大きく減る'),
  pistol: D('pistol', 'ハンドガン', 1, 'weapon', 40, 0, '9mm・12発・セミオート。静かめで扱いやすい'),
  smg: D('smg', 'サブマシンガン', 1, 'weapon', 80, 1, '9mm・25発・フルオート。連射は速いが一発が軽い'),
  rifle: D('rifle', 'アサルトライフル', 1, 'weapon', 140, 2, '7.62mm・30発・フルオート。万能だが反動と音が大きい'),
  shotgun: D('shotgun', 'ショットガン', 1, 'weapon', 90, 1, '12ゲージ・6発。近距離で絶大、遠距離は苦手'),
  hunting: D('hunting', '狩猟ライフル', 1, 'weapon', 120, 1, '7.62mm・5発・ボルトアクション。一撃が重い'),
  dmr: D('dmr', 'マークスマンライフル', 1, 'weapon', 220, 3, '7.62mm・10発・セミオート。高威力・高精度の上位武器'),
  valuables: D('valuables', '貴重品', 10, 'misc', 25, 1, '時計や貴金属。持ち帰ると評価が上がる'),
  antitox: D('antitox', '解毒剤', 3, 'med', 35, 2, '汚染度 -60・HP +10（市街中心部の病院で見つかる）'),
  herbs: D('herbs', '薬草', 8, 'med', 4, 0, 'HP +12・汚染度 -10（森林で採れる）'),
  splint: D('splint', '添え木', 3, 'med', 6, 0, '骨折の手当て。足の遅さが軽くなり、約2分半で治る（布2・鉄くず1で作れる）'),
  pack1: D('pack1', '学生かばん', 1, 'misc', 15, 0, '背負うと バッグ +3マス・+6kg（[X]/右クリックで背負う）'),
  pack2: D('pack2', '登山リュック', 1, 'misc', 40, 1, '背負うと バッグ +6マス・+13kg'),
  pack3: D('pack3', '軍用バックパック', 1, 'misc', 90, 2, '背負うと バッグ +8マス・+21kg（軍用地で見つかる）'),
  coat: D('coat', '防寒コート', 1, 'misc', 20, 1, 'バックパックに入れておくと着ている扱い。雨・夜の冷えが半分になる'),
  fuel: D('fuel', 'ガソリン缶', 3, 'mat', 8, 1, '車の燃料 +35。車の残骸・倉庫・ガソリンスタンドで見つかる'),
  water: D('water', 'きれいな水', 6, 'mat', 2, 0, '雨水タンクに貯まる。かまどで料理に使う'),
  stew: D('stew', '温かいシチュー', 3, 'food', 14, 1, '空腹 +60・HP +20・6分間「休息済み」（かまどで作る）'),
  tea: D('tea', 'ハーブティー', 4, 'food', 8, 1, '汚染度 -30・HP +8・2分間「休息済み」（かまどで作る）'),
  intel: D('intel', '軍の機密書類', 5, 'misc', 90, 3, '軍用地でしか手に入らない。持ち帰ると評価が大きく上がる'),
};

export type WeaponId = 'pistol' | 'smg' | 'rifle' | 'shotgun' | 'hunting' | 'dmr';

export interface WeaponStats {
  name: string;
  /** 通常弾 */
  ammo: ItemId;
  /** 特殊弾（徹甲弾／スラッグ） */
  apAmmo: ItemId;
  magSize: number;
  fireInterval: number;
  reloadTime: number;
  bulletSpeed: number;
  bulletLife: number;
  damage: number;
  /** 基本のばらつき(rad) */
  spread: number;
  /** 1発ごとに溜まる反動（ばらつきに加算、時間で戻る） */
  recoil: number;
  pellets: number;
  knock: number;
  auto: boolean;
  noiseRadius: number;
  /** 画面の揺れ（演出） */
  kick: number;
  /** 貫通できる敵の数 */
  pierce: number;
  /** 装甲を無視するか */
  armorPierce: boolean;
  /** サブ武器スロットに入るか（ハンドガン） */
  secondary: boolean;
}

const W = (o: Omit<WeaponStats, 'pierce' | 'armorPierce'>): WeaponStats => ({ ...o, pierce: 0, armorPierce: false });

export const WEAPON_STATS: Record<WeaponId, WeaponStats> = {
  pistol: W({ name: 'ハンドガン', ammo: 'ammo9', apAmmo: 'ammo9ap', magSize: 12, fireInterval: 0.2, reloadTime: 1.25, bulletSpeed: 1000, bulletLife: 0.6, damage: 24, spread: 0.03, recoil: 0.025, pellets: 1, knock: 110, auto: false, noiseRadius: 560, kick: 2.5, secondary: true }),
  smg: W({ name: 'サブマシンガン', ammo: 'ammo9', apAmmo: 'ammo9ap', magSize: 25, fireInterval: 0.075, reloadTime: 1.7, bulletSpeed: 980, bulletLife: 0.55, damage: 15, spread: 0.06, recoil: 0.016, pellets: 1, knock: 60, auto: true, noiseRadius: 540, kick: 1.5, secondary: false }),
  rifle: W({ name: 'アサルトライフル', ammo: 'ammo762', apAmmo: 'ammo762ap', magSize: 30, fireInterval: 0.1, reloadTime: 2.0, bulletSpeed: 1150, bulletLife: 0.75, damage: 30, spread: 0.035, recoil: 0.03, pellets: 1, knock: 90, auto: true, noiseRadius: 860, kick: 2.4, secondary: false }),
  shotgun: W({ name: 'ショットガン', ammo: 'shells', apAmmo: 'slug', magSize: 6, fireInterval: 0.65, reloadTime: 2.3, bulletSpeed: 900, bulletLife: 0.3, damage: 15, spread: 0.3, recoil: 0.05, pellets: 8, knock: 180, auto: false, noiseRadius: 900, kick: 7, secondary: false }),
  hunting: W({ name: '狩猟ライフル', ammo: 'ammo762', apAmmo: 'ammo762ap', magSize: 5, fireInterval: 1.0, reloadTime: 2.6, bulletSpeed: 1500, bulletLife: 0.9, damage: 100, spread: 0.008, recoil: 0.06, pellets: 1, knock: 240, auto: false, noiseRadius: 1000, kick: 6, secondary: false }),
  dmr: W({ name: 'マークスマンライフル', ammo: 'ammo762', apAmmo: 'ammo762ap', magSize: 10, fireInterval: 0.32, reloadTime: 2.2, bulletSpeed: 1450, bulletLife: 0.9, damage: 62, spread: 0.012, recoil: 0.045, pellets: 1, knock: 170, auto: false, noiseRadius: 950, kick: 4.5, secondary: false }),
};

export const BACKPACK_SLOTS = 20;

// ---------------- 持てる量：マスと重さ ----------------
/** 何も背負っていないときのバッグ */
export const BASE_SLOTS = 12;
export const BASE_KG = 15;
export const PACKS: Partial<Record<ItemId, { slots: number; kg: number }>> = {
  pack1: { slots: 3, kg: 6 },
  pack2: { slots: 6, kg: 13 },
  pack3: { slots: 8, kg: 21 },
};
export function capacityOf(pack: ItemId | null | undefined): { slots: number; kg: number } {
  const p = pack ? PACKS[pack] : undefined;
  return { slots: BASE_SLOTS + (p?.slots ?? 0), kg: BASE_KG + (p?.kg ?? 0) };
}
/** 1 個あたりの重さ（kg） */
const KG: Partial<Record<ItemId, number>> = {
  ammo9: 0.012, ammo9ap: 0.014, ammo762: 0.025, ammo762ap: 0.028, shells: 0.045, slug: 0.05,
  bandage: 0.05, medkit: 0.6, stim: 0.1, antitox: 0.15, herbs: 0.05, splint: 0.3,
  can: 0.4, mre: 0.5, stew: 0.6, tea: 0.3, water: 0.8,
  scrap: 0.35, cloth: 0.12, gunpowder: 0.15, parts: 0.3, chem: 0.3, electronics: 0.2, tools: 1.2, fuel: 3,
  scope: 0.3, holo: 0.2, suppressor: 0.35, extmag: 0.25, grip: 0.2,
  pistol: 0.9, smg: 2.4, rifle: 3.6, shotgun: 3.4, hunting: 3.3, dmr: 4.3,
  valuables: 0.1, intel: 0.1, coat: 1.6, pack1: 0.5, pack2: 1.2, pack3: 1.8,
};
export function unitKg(id: ItemId): number {
  return KG[id] ?? 0.3;
}
export function slotKg(s: Slot | null): number {
  return s ? unitKg(s.id) * s.n : 0;
}
export function bagKg(bag: (Slot | null)[]): number {
  let w = 0;
  for (const s of bag) w += slotKg(s);
  return w;
}
/** 背負っている物・装備も含めた重さ */
export function loadKg(p: { bag: (Slot | null)[]; prim: Slot | null; sec: Slot | null }): number {
  return bagKg(p.bag) + slotKg(p.prim) + slotKg(p.sec);
}
/** プレイヤーのバッグの上限（ホストが毎ステップ更新）。入れ物・倉庫の配列には付かない */
const LIMITS = new WeakMap<(Slot | null)[], { slots: number; kg: number; extra: number }>();
export function setBagLimits(bag: (Slot | null)[], slots: number, kg: number, extraKg: number): void {
  LIMITS.set(bag, { slots, kg, extra: extraKg });
}
/** 重さのせいで入らなかったか（メッセージの出し分け用） */
export let lastAddLimitedByWeight = false;
export const ATTACHMENTS = ['scope', 'holo', 'suppressor', 'extmag', 'grip'] as const;
export type AttachmentId = (typeof ATTACHMENTS)[number];

/** 弾の種類を反映した、使用する弾薬のアイテム */
export function ammoOf(wid: WeaponId, w?: WeaponState): ItemId {
  const s = WEAPON_STATS[wid];
  return w?.ap ? s.apAmmo : s.ammo;
}

/** アタッチメントと弾種の効果を反映した武器性能 */
export function effectiveStats(wid: WeaponId, w?: WeaponState): WeaponStats {
  const s = { ...WEAPON_STATS[wid] };
  if (!w) return s;
  if (w.scope) {
    s.spread *= 0.45;
    s.recoil *= 0.9;
  }
  if (w.holo) {
    s.spread *= 0.7;
    s.recoil *= 0.85;
  }
  if (w.grip) {
    s.spread *= 0.85;
    s.recoil *= 0.5;
    s.kick *= 0.6;
  }
  if (w.suppressor) {
    s.noiseRadius *= 0.32;
    s.damage *= 0.92;
  }
  if (w.extmag) {
    s.magSize = Math.round(s.magSize * 1.6);
    s.reloadTime *= 1.12;
  }
  if (w.ap) {
    s.armorPierce = true;
    if (wid === 'shotgun') {
      // スラッグ：一粒の重い弾
      s.pellets = 1;
      s.damage = 85;
      s.spread = Math.min(s.spread, 0.04);
      s.bulletLife = 0.6;
      s.pierce = 1;
    } else {
      s.pierce = s.ammo === 'ammo762' ? 2 : 1;
      s.damage *= 1.05;
    }
  }
  s.ammo = ammoOf(wid, w);
  return s;
}

export function isWeapon(id: ItemId): id is WeaponId {
  return ITEMS[id].cat === 'weapon';
}

export function emptyBag(n = BACKPACK_SLOTS): (Slot | null)[] {
  return new Array(n).fill(null);
}

export function countItem(bag: (Slot | null)[], id: ItemId): number {
  let n = 0;
  for (const s of bag) if (s && s.id === id) n += s.n;
  return n;
}

/** アイテムを入れる。入りきらなかった数を返す */
export function addItem(bag: (Slot | null)[], id: ItemId, n: number, w?: WeaponState): number {
  const def = ITEMS[id];
  const lim = LIMITS.get(bag);
  let refused = 0;
  lastAddLimitedByWeight = false;
  if (lim) {
    // 重さ：入る数だけ入れ、残りは返す
    const room = lim.kg - bagKg(bag) - lim.extra;
    const can = Math.max(0, Math.floor((room + 1e-6) / unitKg(id)));
    if (can < n) {
      refused = n - can;
      n = can;
      lastAddLimitedByWeight = true;
    }
  }
  const maxSlot = lim ? Math.min(bag.length, lim.slots) : bag.length;
  let left = n;
  if (def.stack > 1) {
    for (const s of bag) {
      if (!s || s.id !== id || s.n >= def.stack) continue;
      const k = Math.min(left, def.stack - s.n);
      s.n += k;
      left -= k;
      if (left <= 0) return refused;
    }
  }
  for (let i = 0; i < maxSlot && left > 0; i++) {
    if (bag[i]) continue;
    const k = Math.min(left, def.stack);
    bag[i] = { id, n: k, ...(w ? { w: { ...w } } : {}) };
    left -= k;
  }
  if (left > 0) lastAddLimitedByWeight = false;
  return left + refused;
}

/** アイテムを取り除く。取り除けた数を返す */
export function removeItem(bag: (Slot | null)[], id: ItemId, n: number): number {
  let need = n;
  for (let i = bag.length - 1; i >= 0 && need > 0; i--) {
    const s = bag[i];
    if (!s || s.id !== id) continue;
    const k = Math.min(need, s.n);
    s.n -= k;
    need -= k;
    if (s.n <= 0) bag[i] = null;
  }
  return n - need;
}

export function freeSlots(bag: (Slot | null)[]): number {
  const lim = LIMITS.get(bag);
  if (lim) return bag.slice(0, lim.slots).filter((s) => !s).length;
  return bag.filter((s) => !s).length;
}

export function bagValue(bag: (Slot | null)[]): number {
  let v = 0;
  for (const s of bag) if (s) v += ITEMS[s.id].value * s.n;
  return v;
}

/** 手に持っている武器（ホットバーの選択が メイン=1 / サブ=2 のとき） */
export function heldWeapon(p: { tool: number; prim: Slot | null; sec: Slot | null }): (Slot & { id: WeaponId; w: WeaponState }) | null {
  const s = p.tool === 1 ? p.prim : p.tool === 2 ? p.sec : null;
  if (!s || !s.w || !isWeapon(s.id)) return null;
  return s as Slot & { id: WeaponId; w: WeaponState };
}

/** 入れ物の表示名 */
export const CONTAINER_NAMES: Record<string, string> = {
  shelf: '棚',
  cabinet: '薬品棚',
  locker: 'ロッカー',
  wcase: '武器ケース',
  fridge: '冷蔵庫',
  desk: '机',
  crate: '物資クレート',
  mcrate: '軍用クレート',
  car: '廃車のトランク',
  box: '拠点の収納箱',
  bag: '落ちている袋',
  drop: '補給物資（空中投下）',
};
