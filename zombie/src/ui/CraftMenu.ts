// ============================================================
// クラフト・改造・拠点強化メニュー（DOMパネル）
//   [C] で開く。タブで「武器改造」「クラフト」「拠点強化」を切り替える
//   ・作業台のそばでは弾薬・医療品・アタッチメントの作成、装備中の武器の改造ができる
//   ・拠点強化は バックパック → 共有倉庫 の順に素材を使う（作業台のそばで）
// ============================================================
import { RECIPES } from '../game/constants';
import { ATTACHMENTS, countItem, effectiveStats, ITEMS, type ItemId, isWeapon } from '../game/items';
import { type Facility, FACILITIES } from '../game/progression';
import type { Slot, StorageState } from '../types';

type Tab = 'mod' | 'craft' | 'base';

export class CraftMenu {
  open = false;
  private tab: Tab = 'craft';
  private list: HTMLElement;
  private benchLabel: HTMLElement;
  private lastKey = '';
  private last: Parameters<CraftMenu['update']> | null = null;

  constructor(
    private panel: HTMLElement,
    private onCraft: (id: string) => void,
    private onToggle: (open: boolean) => void,
    private onMod: (slot: 'prim' | 'sec', att: string) => void = () => {},
    private onUpgrade: (fac: Facility) => void = () => {},
  ) {
    this.list = panel.querySelector('#craft-list') as HTMLElement;
    this.benchLabel = panel.querySelector('#craft-bench') as HTMLElement;
    panel.querySelector('#craft-close')?.addEventListener('click', () => this.toggle(false));
    this.list.addEventListener('click', (e) => {
      const btn = (e.target as HTMLElement).closest('button') as HTMLButtonElement | null;
      if (!btn || btn.disabled) return;
      if (btn.dataset.tab) {
        this.tab = btn.dataset.tab as Tab;
        this.lastKey = '';
        if (this.last) this.update(...this.last);
      } else if (btn.dataset.id) this.onCraft(btn.dataset.id);
      else if (btn.dataset.upg) this.onUpgrade(btn.dataset.upg as Facility);
      else if (btn.dataset.mod) {
        const [slot, att] = btn.dataset.mod.split(':');
        this.onMod(slot as 'prim' | 'sec', att);
      }
    });
  }

  toggle(force?: boolean): void {
    const next = force ?? !this.open;
    if (next === this.open) return;
    this.open = next;
    this.panel.classList.toggle('hidden', !next);
    this.lastKey = '';
    this.onToggle(next);
    if (next && this.last) this.update(...this.last);
  }

  destroy(): void {
    this.toggle(false);
  }

  /** 持ち物が変わったときだけ描き直す */
  update(bag: (Slot | null)[], prim: Slot | null, sec: Slot | null, nearBench: boolean, base: Record<Facility, number>, storage: StorageState | null): void {
    this.last = [bag, prim, sec, nearBench, base, storage];
    if (!this.open) return;
    const key = JSON.stringify([bag, prim, sec, nearBench, base, storage?.ver, this.tab]);
    if (key === this.lastKey) return;
    this.lastKey = key;
    this.benchLabel.textContent = nearBench ? `BENCH Lv${base.bench} ● ONLINE` : 'BENCH OUT OF RANGE ― 包帯のみ作成可';
    this.benchLabel.className = nearBench ? 'ok' : 'ng';
    const have = (m: ItemId) => countItem(bag, m);
    const tabName = { mod: '武器改造', craft: 'クラフト', base: '拠点強化' };
    const readyCount = RECIPES.filter((r) => !((r.lv ?? 1) > base.bench) && (!r.bench || nearBench) && (Object.entries(r.cost) as [ItemId, number][]).every(([m, n]) => have(m) >= n)).length;
    const tabs = (['mod', 'craft', 'base'] as Tab[])
      .map((t) => `<button data-tab="${t}" class="${this.tab === t ? 'on' : ''}">${tabName[t]}${t === 'craft' ? `<small>${readyCount} 作成可</small>` : ''}</button>`)
      .join('');
    const costChips = (entries: [ItemId, number][], owned: (m: ItemId) => number) =>
      entries.map(([m, n]) => `<span class="cost ${owned(m) >= n ? 'ok' : 'ng'}">${ITEMS[m].name} <small>${owned(m)}/${n}</small></span>`).join('');
    let body = '';

    if (this.tab === 'mod') {
      const modCard = (key: 'prim' | 'sec', s: Slot | null) => {
        const label = key === 'prim' ? 'PRIMARY / メイン' : 'SIDEARM / サブ';
        if (!s || !isWeapon(s.id)) return `<div class="mod-card dim"><div class="m-top"><span class="m-slot">${label}</span><span class="m-name">未装備</span></div><p class="note">バックパックから武器を右クリックで装備できる</p></div>`;
        const st = effectiveStats(s.id, s.w);
        const btns = ATTACHMENTS.map((a) => {
          const on = !!s.w?.[a];
          const can = nearBench && (on || have(a) > 0);
          return `<button class="att ${on ? 'on' : ''}" data-mod="${key}:${a}" ${can ? '' : 'disabled'} title="${ITEMS[a].desc}"><b>${ITEMS[a].name}</b><small>${on ? '装着中 ▸ 外す' : `所持 ${have(a)}`}</small></button>`;
        }).join('');
        const bar = (label: string, v: number, txt: string) =>
          `<div class="sbar"><div class="sb-top"><span>${label}</span><b>${txt}</b></div><div class="sb-track"><div class="sb-fill" style="width:${Math.round(Math.max(0.04, Math.min(1, v)) * 100)}%"></div></div></div>`;
        return `<div class="mod-card"><div class="m-top"><span class="m-slot">${label}</span><span class="m-name">${ITEMS[s.id].name}</span><span class="chip ${s.w?.ap ? 'warn' : ''}">${ITEMS[st.ammo].name}</span><span class="chip">[T] 弾種切替</span></div>
          <div class="sbars">${bar('威力', (st.damage * st.pellets) / 110, `${Math.round(st.damage * st.pellets)}`)}${bar('連射', 0.07 / st.fireInterval, `${Math.round(60 / st.fireInterval)}/分`)}${bar('集弾率', 1 - st.spread * 6, `${Math.round(Math.max(0, 1 - st.spread * 5) * 100)}`)}${bar('反動の小ささ', 1 - st.recoil * 14, `${Math.round(st.recoil * 1000)}`)}${bar('装弾数', st.magSize / 40, `${st.magSize}`)}${bar('静かさ', 1 - st.noiseRadius / 1050, `${Math.round(st.noiseRadius)}`)}</div>
          <div class="att-grid">${btns}</div></div>`;
      };
      body = `<p class="note">作業台のそばで付け外し。光学サイト（スコープ／ホロ）はどちらか1つ。外したアタッチメントはバックパックに戻る。</p>${modCard('prim', prim)}${modCard('sec', sec)}`;
    } else if (this.tab === 'craft') {
      const cards = RECIPES.map((r) => {
        const cost = Object.entries(r.cost) as [ItemId, number][];
        const enough = cost.every(([m, n]) => have(m) >= n);
        const lvLock = (r.lv ?? 1) > base.bench;
        const benchLock = r.bench && !nearBench;
        const state = lvLock ? 'locked' : enough && !benchLock ? 'ready' : enough ? '' : 'short';
        const chip = lvLock ? `<span class="chip">🔒 作業台Lv${r.lv}</span>` : benchLock ? '<span class="chip warn">作業台へ</span>' : enough ? '<span class="chip ok">作成可能</span>' : '<span class="chip ng">素材不足</span>';
        return `<div class="ccard ${state}">
          <div class="c-top"><span class="c-name">${r.name}</span>${chip}</div>
          <p>${r.desc}</p>
          <div class="c-act"><div class="costs">${costChips(cost, have)}</div><button class="btn small ${state === 'ready' ? 'go' : ''}" data-id="${r.id}" ${state === 'ready' ? '' : 'disabled'}>作成</button></div>
        </div>`;
      });
      const mats = (['scrap', 'cloth', 'gunpowder', 'parts', 'chem', 'electronics', 'tools'] as ItemId[]).map((m) => `<span class="mat">${ITEMS[m].name}<b>${have(m)}</b></span>`).join('');
      body = `<div class="mats">${mats}</div><div class="cards">${cards.join('')}</div>`;
    } else {
      const shared = storage?.shared ?? [];
      const owned = (m: ItemId) => have(m) + countItem(shared, m);
      const cards = FACILITIES.map((f) => {
        const lv = base[f.id];
        const cur = f.id === 'bench' ? lv - 1 : lv;
        const cost = f.costs[cur];
        const entries = (cost ? Object.entries(cost) : []) as [ItemId, number][];
        const enough = entries.every(([m, n]) => owned(m) >= n);
        const state = !cost ? 'locked' : enough && nearBench ? 'ready' : enough ? '' : 'short';
        const chip = !cost ? '<span class="chip ok">MAX</span>' : !enough ? '<span class="chip ng">素材不足</span>' : nearBench ? '<span class="chip ok">強化可能</span>' : '<span class="chip warn">作業台へ</span>';
        const pips = Array.from({ length: f.levels.length }, (_, i) => `<i class="${i <= cur ? 'on' : ''}"></i>`).join('');
        return `<div class="ccard ${state}">
          <div class="c-top"><span class="c-name">${f.name}</span><span class="pips">${pips}</span>${chip}</div>
          <p>現在：${f.levels[cur]}</p>
          ${cost ? `<p class="next">▸ 次：${f.levels[cur + 1]}</p>` : '<p class="next">最大レベルに達している</p>'}
          ${cost ? `<div class="c-act"><div class="costs">${costChips(entries, owned)}</div><button class="btn small ${state === 'ready' ? 'go' : ''}" data-upg="${f.id}" ${state === 'ready' ? '' : 'disabled'}>強化</button></div>` : ''}
        </div>`;
      });
      body = `<p class="note">素材はバックパック → 共有倉庫の順に使われる（所持数は両方の合計）。持ち帰った物資を拠点に投資しよう。</p><div class="cards">${cards.join('')}</div>`;
    }
    this.list.innerHTML = `<div class="tabs">${tabs}</div>${body}`;
  }
}
