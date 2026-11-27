// ============================================================
// 長期成長：プレイヤーのスキル（永続）と拠点設備のアップグレード（その回のプレイ中）
//   スキル経験値はブラウザ（localStorage）にプレイヤー名ごとに保存され、次回以降も引き継がれる
// ============================================================
import type { ItemId } from './items';

// ---------------- スキル ----------------
export const SKILLS = [
  { id: 'search', name: '探索', desc: '入れ物を漁る速度 +8%/Lv', how: '入れ物を探索する' },
  { id: 'endurance', name: '持久力', desc: '最大スタミナ +8/Lv・回復 +6%/Lv', how: 'ダッシュ・近接攻撃' },
  { id: 'handling', name: '銃の扱い', desc: 'リロード -6%/Lv・反動 -7%/Lv', how: '銃でゾンビを倒す' },
  { id: 'medic', name: '応急処置', desc: '回復量 +10%/Lv・蘇生速度 +12%/Lv', how: '回復・味方の蘇生' },
] as const;
export type SkillId = (typeof SKILLS)[number]['id'];
export const SKILL_INDEX: Record<SkillId, number> = { search: 0, endurance: 1, handling: 2, medic: 3 };
export const MAX_SKILL_LV = 10;

/** レベル n に必要な累計経験値 */
export function xpForLevel(n: number): number {
  // 序盤は早く上がり（Lv1 は入れ物5〜6個ほど）、終盤ほどじっくり
  return Math.round(30 * n + 10 * n * n);
}

export function levelOf(xp: number): number {
  let lv = 0;
  while (lv < MAX_SKILL_LV && xp >= xpForLevel(lv + 1)) lv++;
  return lv;
}

export interface SkillMods {
  searchMul: number;
  staminaMax: number;
  staminaRegenMul: number;
  reloadMul: number;
  recoilMul: number;
  healMul: number;
  reviveMul: number;
}

export function skillMods(xp: readonly number[] | undefined): SkillMods {
  const lv = (i: number) => levelOf(xp?.[i] ?? 0);
  return {
    searchMul: 1 / (1 + 0.08 * lv(0)),
    staminaMax: 100 + 8 * lv(1),
    staminaRegenMul: 1 + 0.06 * lv(1),
    reloadMul: 1 - 0.06 * lv(2),
    recoilMul: 1 - 0.07 * lv(2),
    healMul: 1 + 0.1 * lv(3),
    reviveMul: 1 + 0.12 * lv(3),
  };
}

// ---------------- プロフィール保存 ----------------
export interface Profile {
  xp: number[];
  /** これまでの生還日数の最高 */
  bestDay: number;
  /** 累計で持ち帰った価値 */
  banked: number;
}

const PROFILE_KEY = 'deadnights2d.profile.v1';

export function emptyProfile(): Profile {
  return { xp: [0, 0, 0, 0], bestDay: 0, banked: 0 };
}

export function sanitizeProfile(p: unknown): Profile {
  const o = (p ?? {}) as Partial<Profile>;
  const xp = Array.isArray(o.xp) ? o.xp.slice(0, 4).map((v) => Math.max(0, Math.min(1e6, Number(v) || 0))) : [];
  while (xp.length < 4) xp.push(0);
  return { xp, bestDay: Math.max(0, Number(o.bestDay) || 0), banked: Math.max(0, Number(o.banked) || 0) };
}

export function loadProfile(): Profile {
  try {
    const raw = localStorage.getItem(PROFILE_KEY);
    if (raw) return sanitizeProfile(JSON.parse(raw));
  } catch {
    /* 保存できない環境 */
  }
  return emptyProfile();
}

export function saveProfile(p: Profile): void {
  try {
    localStorage.setItem(PROFILE_KEY, JSON.stringify(p));
  } catch {
    /* 保存できない環境 */
  }
}

// ---------------- 拠点設備 ----------------
export type Facility = 'bench' | 'storage' | 'med' | 'supply' | 'garden';

export interface FacilityDef {
  id: Facility;
  name: string;
  /** レベルごとの効果説明（index = レベル） */
  levels: string[];
  /** 次のレベルへのコスト（index = 現在のレベル） */
  costs: Partial<Record<ItemId, number>>[];
}

export const FACILITIES: FacilityDef[] = [
  {
    id: 'bench',
    name: '作業台',
    levels: ['基本の弾薬・包帯', 'Lv2：徹甲弾・スラッグ・ホロサイト・興奮剤を作れる', 'Lv3：スコープ・サプレッサー・工具を作れる'],
    costs: [
      { scrap: 12, parts: 2 },
      { scrap: 20, parts: 4, electronics: 2, tools: 1 },
    ],
  },
  {
    id: 'storage',
    name: '倉庫',
    levels: ['共有40・個人24マス', 'Lv2：共有60・個人32マス', 'Lv3：共有80・個人40マス'],
    costs: [
      { scrap: 10, cloth: 6 },
      { scrap: 18, cloth: 10, tools: 1 },
    ],
  },
  {
    id: 'med',
    name: '医務室',
    levels: ['焚き火のそばで HP +2/秒', 'Lv1：HP +4/秒・毎朝 包帯を補給', 'Lv2：HP +7/秒・毎朝 救急キットを補給'],
    costs: [
      { cloth: 8, chem: 3 },
      { chem: 6, electronics: 2, tools: 1 },
    ],
  },
  {
    id: 'supply',
    name: '補給所',
    levels: ['毎朝 収納箱に少しの物資', 'Lv1：毎朝の物資が増える（弾薬・食料）', 'Lv2：さらに増え、ときどき火薬・パーツも届く'],
    costs: [
      { scrap: 10, gunpowder: 4, can: 3 },
      { scrap: 16, parts: 3, tools: 1, mre: 1 },
    ],
  },
  {
    id: 'garden',
    name: '菜園',
    levels: ['未設置（森林の薬草を植えて始める）', 'Lv1：毎朝 缶詰2・薬草1が採れる', 'Lv2：毎朝 缶詰4・薬草2・軍用レーション1'],
    costs: [
      { cloth: 6, scrap: 8, herbs: 2 },
      { scrap: 14, chem: 3, tools: 1 },
    ],
  },
];

export const STORAGE_SIZES = [
  { shared: 40, personal: 24 },
  { shared: 60, personal: 32 },
  { shared: 80, personal: 40 },
];
export const MED_REGEN = [2, 4, 7];

// ---------------- 戦績（このブラウザに上位10件） ----------------
export interface RunRecord {
  at: number;
  name: string;
  day: number;
  kills: number;
  value: number;
  mode: string;
  players: number;
  /** 救助されてクリア */
  won?: boolean;
  run?: 'd30' | 'endless';
  /** 読んだ手記の数 */
  notes?: number;
}
const REC_KEY = 'deadnights2d.records';

export function loadRecords(): RunRecord[] {
  try {
    const r = JSON.parse(localStorage.getItem(REC_KEY) ?? '[]') as RunRecord[];
    return Array.isArray(r) ? r.filter((x) => x && typeof x.day === 'number') : [];
  } catch {
    return [];
  }
}

/** 記録を追加して順位を返す（生存日数 → 持ち帰った価値 → 撃破数の順）。best = 1位になった */
export function addRecord(rec: RunRecord): { rank: number; best: boolean } {
  const list = [...loadRecords(), rec].sort((a, b) => Number(!!b.won) - Number(!!a.won) || b.day - a.day || b.value - a.value || b.kills - a.kills);
  const rank = list.indexOf(rec) + 1;
  try {
    localStorage.setItem(REC_KEY, JSON.stringify(list.slice(0, 10)));
  } catch {
    /* ignore */
  }
  return { rank, best: rank === 1 };
}
