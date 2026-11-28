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

/** 生き延びる手引き（2〜7 日目）：はじめの一日のあと、主要な遊びに一通り触れる */
export const TUT2_STEPS: TutStep[] = [
  { bit: 32, title: '車を直して運転する', how: '拠点の近くの壊れたピックアップ：鉄くず6・武器パーツ2で直して [F] で乗る', touch: '壊れた車を直して [調べる] で乗る' },
  { bit: 64, title: '拠点か武器を強化する', how: '[C] 作業台の「拠点強化」か「武器改造」タブ', touch: '[作業台] の拠点強化・武器改造' },
  { bit: 128, title: '危険な地区（★3）に入る', how: '地図 [B] の赤い地区。良い物があるが、兵士と精鋭が多い', touch: '地図の赤い地区へ' },
  { bit: 256, title: '大群の夜を越える', how: '4 日目の夜。門をバリケード [V] で塞ぎ、朝まで生き延びる', touch: '4 日目の夜を生き延びる' },
  { bit: 512, title: '救助無線の部品を手に入れる', how: '地図の金色の◆（通信塔など）。見張りを倒して箱を開ける', touch: '金色の◆の箱を開ける' },
];
export const TUT2_ALL = TUT2_STEPS.reduce((a, s) => a | s.bit, 0);
export const TUT_DRIVE = 32;
export const TUT_UPGRADE = 64;
export const TUT_DANGER = 128;
export const TUT_HORDE = 256;
export const TUT_PART = 512;
/** 全部（古いセーブの人は達成済み扱い） */
export const TUT_EVERY = TUT_ALL | TUT2_ALL;
export const TUT2_REWARD: [string, number][] = [
  ['upkit', 1],
  ['ammo762', 20],
  ['medkit', 1],
];
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
