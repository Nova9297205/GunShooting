// ============================================================
// 無線の依頼（遠征の目的）
//   毎朝、拠点の無線に 3 件（信頼度が上がると 4 件）の依頼が届く。
//   ・回収：施設に置かれた物資箱から指定の品を持ち帰り、無線で報告する
//   ・調査：施設まで行って様子を確かめる（着いたら達成）
//   ・救援物資：生存者が隠した物資箱を見つけて開ける（開けたら達成・中身が報酬）
//   依頼は施設の種類（病院・軍事施設など）に合った内容で、遠く・危険なほど報酬が多い。
// ============================================================

import type { Job } from '../types';
import { BASE_TX, BASE_TY } from './constants';
import type { ItemId } from './items';
import type { Location } from './world';

type LocKind = Location['kind'];

/** 施設ごとの「回収」依頼の品（品・個数・依頼文） */
const FETCH: Partial<Record<LocKind, { item: ItemId; n: number; why: string }[]>> = {
  hospital: [
    { item: 'antitox', n: 1, why: '汚染で倒れた生存者がいる。解毒剤を' },
    { item: 'medkit', n: 2, why: '負傷者の手当てに救急キットを' },
  ],
  military: [
    { item: 'intel', n: 1, why: '軍の撤退ルートが書かれた機密書類を' },
    { item: 'ammo762', n: 30, why: '見張り台の防衛に 7.62mm 弾を' },
  ],
  police: [{ item: 'ammo9', n: 40, why: '自警団の補給に 9mm 弾を' }],
  market: [
    { item: 'can', n: 4, why: '子どもたちの食料に缶詰を' },
    { item: 'electronics', n: 2, why: '無線機の修理に電子部品を' },
  ],
  warehouse: [
    { item: 'parts', n: 2, why: '発電機の修理に武器パーツを' },
    { item: 'tools', n: 1, why: '避難所の補強に工具セットを' },
  ],
  gas: [
    { item: 'chem', n: 2, why: '浄水に使う薬品を' },
    { item: 'gunpowder', n: 3, why: '狼煙を上げるための火薬を' },
  ],
  house: [
    { item: 'cloth', n: 4, why: '寒さをしのぐ布を' },
    { item: 'bandage', n: 3, why: '包帯を' },
  ],
};

/** 依頼の報酬（信頼度の倍率をかける前）：tier が上がるほど良い物 */
export function jobReward(tier: number, mul: number): { id: ItemId; n: number }[] {
  const r = (n: number) => Math.max(1, Math.round(n * mul));
  const base: { id: ItemId; n: number }[][] = [
    [],
    [{ id: 'ammo9', n: r(20) }, { id: 'can', n: r(2) }, { id: 'scrap', n: r(4) }],
    [{ id: 'ammo9', n: r(30) }, { id: 'medkit', n: r(1) }, { id: 'scrap', n: r(6) }, { id: 'cloth', n: r(2) }],
    [{ id: 'ammo762', n: r(20) }, { id: 'parts', n: r(2) }, { id: 'gunpowder', n: r(3) }, { id: 'mre', n: r(1) }],
    [{ id: 'ammo762ap', n: r(10) }, { id: 'parts', n: r(3) }, { id: 'tools', n: r(1) }, { id: 'stim', n: r(1) }, { id: 'antitox', n: r(1) }],
  ];
  return base[Math.max(1, Math.min(4, tier))];
}

export const RADIO_MAX_LV = 5;
/** 何件こなすと信頼度が 1 上がるか */
export const JOBS_PER_LV = 3;
export function radioLevel(done: number): number {
  return Math.min(RADIO_MAX_LV, 1 + Math.floor(done / JOBS_PER_LV));
}
/** 信頼度ごとの報酬倍率 */
export function rewardMul(lv: number): number {
  return 1 + (lv - 1) * 0.25;
}

/**
 * 依頼を作る：近い（★1〜2）・中くらい（★2〜3）・遠い（★3〜4）から1件ずつ。信頼度 3 以上で遠い依頼をもう1件。
 * @returns 依頼（物資箱を置く必要がある依頼は crateAt を持つ）
 */
export function makeJobs(locations: Location[], day: number, lv: number, rnd: () => number, startId: number): Job[] {
  const usable = locations.map((l, i) => ({ l, i })).filter(({ l }) => l.kind !== 'base' && l.kind !== 'ruin');
  const bands: [number, number][] = [
    [1, 2],
    [2, 3],
    [3, 4],
  ];
  if (lv >= 3) bands.push([3, 4]);
  const jobs: Job[] = [];
  const used = new Set<number>();
  const usedKinds = new Set<LocKind>();
  const distOf = (l: Location) => Math.hypot(l.x + l.w / 2 - BASE_TX, l.y + l.h / 2 - BASE_TY);
  let id = startId;
  for (const [lo, hi] of bands) {
    // 同じ日に同じ種類の施設が重ならないように。近すぎる施設（往復1分未満）は選ばない
    let pool = usable.filter(({ l, i }) => l.tier >= lo && l.tier <= hi && !used.has(i) && !usedKinds.has(l.kind) && distOf(l) >= 45);
    if (!pool.length) pool = usable.filter(({ l, i }) => l.tier >= lo && l.tier <= hi && !used.has(i) && distOf(l) >= 45);
    if (!pool.length) continue;
    const { l, i } = pool[Math.floor(rnd() * pool.length)];
    used.add(i);
    usedKinds.add(l.kind);
    const tx = Math.floor(l.x + l.w / 2);
    const ty = Math.floor(l.y + l.h / 2);
    const dist = Math.round(Math.hypot(tx - BASE_TX, ty - BASE_TY));
    const place = l.name;
    const fetch = FETCH[l.kind];
    const roll = rnd();
    const tier = Math.max(1, Math.min(4, l.tier + (l.hot ? 1 : 0)));
    if (fetch && roll < 0.5) {
      const f = fetch[Math.floor(rnd() * fetch.length)];
      jobs.push({ id: id++, kind: 'fetch', title: `${place}から回収`, desc: `${f.why}${place}の物資箱から持ち帰って無線で報告してほしい`, loc: i, tx, ty, item: f.item, need: f.n, have: 0, tier, dist, day });
    } else if (roll < 0.78) {
      jobs.push({ id: id++, kind: 'cache', title: `${place}の救援物資`, desc: `生存者が${place}に物資を隠した。見つけて開ければ中身は好きに使っていい`, loc: i, tx, ty, tier, dist, day });
    } else {
      jobs.push({ id: id++, kind: 'scout', title: `${place}の偵察`, desc: `${place}から無線が途絶えた。様子を見てきてほしい（施設に入れば達成）`, loc: i, tx, ty, tier, dist, day });
    }
  }
  return jobs;
}
