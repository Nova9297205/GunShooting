// ============================================================
// はじめの一日：最初の 15 分で、このゲームの 1 日の流れ（漁る → 作る → 建てる → 依頼 → 眠る）を
// 一度ずつ体験させるチェックリスト。プレイヤーごとに進み、順番は自由（できた物から ✓）。
// ============================================================

export interface TutStep {
  /** 達成フラグのビット */
  bit: number;
  /** チェックリストの 1 行 */
  title: string;
  /** まだのときに出す「どうやるか」（キー名は Renderer がコントローラーのボタン名に置き換える） */
  how: string;
  /** タッチ端末向けの言い方 */
  touch: string;
}

export const TUT_STEPS: TutStep[] = [
  { bit: 1, title: '家の棚や箱を漁る', how: '近くの家に入り、棚・冷蔵庫の前で [F]', touch: '棚の前で [調べる]' },
  { bit: 2, title: 'クラフトで何か作る', how: '[C] で作業台を開く（包帯は布2でどこでも作れる）', touch: '[作業台] を開く（包帯は布2でどこでも）' },
  { bit: 4, title: '拠点に何か建てる', how: '[V] で建設（材料は拠点の倉庫にも少しある）', touch: '[建設] → 右スティックで向けて撃つ' },
  { bit: 8, title: '無線の依頼を 1 つ達成', how: '右上の依頼の場所へ（コンパスの青い印）', touch: '画面上の依頼の場所へ' },
  { bit: 16, title: '夜、ベッドで眠る', how: '20:00 を過ぎたら拠点のベッドで [F]', touch: '20:00 を過ぎたらベッドで [調べる]' },
];

export const TUT_ALL = TUT_STEPS.reduce((a, s) => a | s.bit, 0);
export const TUT_SEARCH = 1;
export const TUT_CRAFT = 2;
export const TUT_BUILD = 4;
export const TUT_JOB = 8;
export const TUT_SLEEP = 16;

/** 全部終えたときのごほうび */
export const TUT_REWARD: [string, number][] = [
  ['bandage', 2],
  ['ammo9', 24],
  ['can', 2],
];
