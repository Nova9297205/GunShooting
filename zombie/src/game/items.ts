// ============================================================
// アイテム定義とインベントリ（スロット制）
//   バックパック 16 マス。弾・素材などはスタック可能、武器は1マスに1丁（装填数・アタッチメントを保持）
// ============================================================

export type ItemId =
  | 'ammo9'
  | 'ammo762'
  | 'shells'
  | 'bandage'
  | 'medkit'
  | 'can'
  | 'mre'
  | 'scrap'
  | 'cloth'
  | 'gunpowder'
  | 'parts'
  | 'chem'
  | 'electronics'
  | 'scope'
  | 'suppressor'
  | 'extmag'
  | 'grip'
  | 'pistol'
  | 'smg'
  | 'rifle'
  | 'shotgun'
  | 'hunting'
  | 'valuables';

export type ItemCat = 'ammo' | 'med' | 'food' | 'mat' | 'att' | 'weapon' | 'misc';

export interface ItemDef {
  id: ItemId;
  name: string;
  stack: number;
  cat: ItemCat;
  /** 帰還時の評価額（リザルトの「持ち帰った価値」） */
  value: number;
  desc: string;
}

/** 武器ごとの状態（装填数・アタッチメント） */
export interface WeaponState {
  mag: number;
  /** 取り付けたアタッチメント（1 = 装着） */
  scope?: number;
  suppressor?: number;
  extmag?: number;
  grip?: number;
}

export interface Slot {
  id: ItemId;
  n: number;
  w?: WeaponState;
}

export const ITEMS: Record<ItemId, ItemDef> = {
  ammo9: { id: 'ammo9', name: '9mm弾', stack: 60, cat: 'ammo', value: 1, desc: 'ハンドガン・SMG 用' },
  ammo762: { id: 'ammo762', name: '7.62mm弾', stack: 40, cat: 'ammo', value: 2, desc: 'アサルトライフル・狩猟ライフル用' },
  shells: { id: 'shells', name: '12ゲージ弾', stack: 24, cat: 'ammo', value: 2, desc: 'ショットガン用の散弾' },
  bandage: { id: 'bandage', name: '包帯', stack: 5, cat: 'med', value: 6, desc: 'HP +25' },
  medkit: { id: 'medkit', name: '救急キット', stack: 3, cat: 'med', value: 20, desc: 'HP +65' },
  can: { id: 'can', name: '缶詰', stack: 5, cat: 'food', value: 5, desc: '空腹 +35' },
  mre: { id: 'mre', name: '軍用レーション', stack: 3, cat: 'food', value: 12, desc: '空腹 +70・HP +10' },
  scrap: { id: 'scrap', name: '鉄くず', stack: 20, cat: 'mat', value: 1, desc: 'クラフト素材' },
  cloth: { id: 'cloth', name: '布', stack: 20, cat: 'mat', value: 1, desc: '包帯の材料' },
  gunpowder: { id: 'gunpowder', name: '火薬', stack: 20, cat: 'mat', value: 3, desc: '弾薬の材料' },
  parts: { id: 'parts', name: '武器パーツ', stack: 10, cat: 'mat', value: 12, desc: 'アタッチメントの材料' },
  chem: { id: 'chem', name: '薬品', stack: 10, cat: 'mat', value: 6, desc: '救急キットの材料' },
  electronics: { id: 'electronics', name: '電子部品', stack: 10, cat: 'mat', value: 10, desc: 'スコープの材料' },
  scope: { id: 'scope', name: 'スコープ', stack: 1, cat: 'att', value: 45, desc: '視界が伸び、弾のばらつきが減る' },
  suppressor: { id: 'suppressor', name: 'サプレッサー', stack: 1, cat: 'att', value: 50, desc: '銃声が小さくなりゾンビに気づかれにくい' },
  extmag: { id: 'extmag', name: '拡張マガジン', stack: 1, cat: 'att', value: 35, desc: '装弾数 +60%' },
  grip: { id: 'grip', name: 'フォアグリップ', stack: 1, cat: 'att', value: 30, desc: '反動とばらつきを軽減' },
  pistol: { id: 'pistol', name: 'ハンドガン', stack: 1, cat: 'weapon', value: 40, desc: '9mm・12発・セミオート' },
  smg: { id: 'smg', name: 'サブマシンガン', stack: 1, cat: 'weapon', value: 80, desc: '9mm・25発・フルオート' },
  rifle: { id: 'rifle', name: 'アサルトライフル', stack: 1, cat: 'weapon', value: 140, desc: '7.62mm・30発・フルオート' },
  shotgun: { id: 'shotgun', name: 'ショットガン', stack: 1, cat: 'weapon', value: 90, desc: '12ゲージ・6発・近距離で強力' },
  hunting: { id: 'hunting', name: '狩猟ライフル', stack: 1, cat: 'weapon', value: 120, desc: '7.62mm・5発・一撃が重い' },
  valuables: { id: 'valuables', name: '貴重品', stack: 10, cat: 'misc', value: 25, desc: '時計や貴金属。持ち帰ると評価が上がる' },
};

export type WeaponId = 'pistol' | 'smg' | 'rifle' | 'shotgun' | 'hunting';

export interface WeaponStats {
  name: string;
  ammo: ItemId;
  magSize: number;
  fireInterval: number;
  reloadTime: number;
  bulletSpeed: number;
  bulletLife: number;
  damage: number;
  spread: number;
  pellets: number;
  knock: number;
  auto: boolean;
  noiseRadius: number;
  kick: number;
  /** サブ武器スロットに入るか（ハンドガン） */
  secondary: boolean;
}

export const WEAPON_STATS: Record<WeaponId, WeaponStats> = {
  pistol: { name: 'ハンドガン', ammo: 'ammo9', magSize: 12, fireInterval: 0.2, reloadTime: 1.3, bulletSpeed: 1000, bulletLife: 0.65, damage: 24, spread: 0.035, pellets: 1, knock: 110, auto: false, noiseRadius: 620, kick: 2.5, secondary: true },
  smg: { name: 'サブマシンガン', ammo: 'ammo9', magSize: 25, fireInterval: 0.085, reloadTime: 1.6, bulletSpeed: 1000, bulletLife: 0.6, damage: 16, spread: 0.07, pellets: 1, knock: 70, auto: true, noiseRadius: 600, kick: 1.6, secondary: false },
  rifle: { name: 'アサルトライフル', ammo: 'ammo762', magSize: 30, fireInterval: 0.1, reloadTime: 1.8, bulletSpeed: 1150, bulletLife: 0.75, damage: 28, spread: 0.055, pellets: 1, knock: 90, auto: true, noiseRadius: 850, kick: 2.2, secondary: false },
  shotgun: { name: 'ショットガン', ammo: 'shells', magSize: 6, fireInterval: 0.6, reloadTime: 2.0, bulletSpeed: 900, bulletLife: 0.32, damage: 14, spread: 0.32, pellets: 7, knock: 170, auto: false, noiseRadius: 900, kick: 7, secondary: false },
  hunting: { name: '狩猟ライフル', ammo: 'ammo762', magSize: 5, fireInterval: 0.9, reloadTime: 2.4, bulletSpeed: 1500, bulletLife: 0.9, damage: 95, spread: 0.006, pellets: 1, knock: 220, auto: false, noiseRadius: 1000, kick: 6, secondary: false },
};

export const BACKPACK_SLOTS = 16;

/** アタッチメントの効果を反映した武器性能 */
export function effectiveStats(wid: WeaponId, w?: WeaponState): WeaponStats {
  const s = { ...WEAPON_STATS[wid] };
  if (!w) return s;
  if (w.scope) s.spread *= 0.6;
  if (w.grip) {
    s.spread *= 0.75;
    s.kick *= 0.6;
  }
  if (w.suppressor) {
    s.noiseRadius *= 0.3;
    s.damage *= 0.92;
  }
  if (w.extmag) s.magSize = Math.round(s.magSize * 1.6);
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
  let left = n;
  if (def.stack > 1) {
    for (const s of bag) {
      if (!s || s.id !== id || s.n >= def.stack) continue;
      const k = Math.min(left, def.stack - s.n);
      s.n += k;
      left -= k;
      if (left <= 0) return 0;
    }
  }
  for (let i = 0; i < bag.length && left > 0; i++) {
    if (bag[i]) continue;
    const k = Math.min(left, def.stack);
    bag[i] = { id, n: k, ...(w ? { w: { ...w } } : {}) };
    left -= k;
  }
  return left;
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
};
