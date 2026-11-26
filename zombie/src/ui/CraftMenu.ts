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
    this.benchLabel.textContent = nearBench ? `作業台 Lv${base.bench}：使用可能` : '作業台から離れている（包帯のみ作れる）';
    this.benchLabel.className = nearBench ? 'ok' : 'ng';
    const have = (m: ItemId) => countItem(bag, m);
    const tabs = (['mod', 'craft', 'base'] as Tab[])
      .map((t) => `<button data-tab="${t}" class="${this.tab === t ? 'on' : ''}">${t === 'mod' ? '武器改造' : t === 'craft' ? 'クラフト' : '拠点強化'}</button>`)
      .join('');
    let body = '';

    if (this.tab === 'mod') {
      const modRow = (key: 'prim' | 'sec', s: Slot | null) => {
        if (!s || !isWeapon(s.id)) return `<div class="mod-row dim"><b>${key === 'prim' ? 'メイン' : 'サブ'}</b><span>未装備</span></div>`;
        const st = effectiveStats(s.id, s.w);
        const btns = ATTACHMENTS.map((a) => {
          const on = !!s.w?.[a];
          const can = nearBench && (on || have(a) > 0);
          return `<button class="att ${on ? 'on' : ''}" data-mod="${key}:${a}" ${can ? '' : 'disabled'} title="${ITEMS[a].desc}">${on ? '✔ ' : ''}${ITEMS[a].name}${on ? '' : ` <small>${have(a)}</small>`}</button>`;
        }).join('');
        const bar = (label: string, v: number) => `<span class="sbar"><i>${label}</i><b style="width:${Math.round(Math.max(0.04, Math.min(1, v)) * 100)}%"></b></span>`;
        return `<div class="mod-row"><b>${ITEMS[s.id].name}</b><span class="stat">弾: ${ITEMS[st.ammo].name}（[T]で切替）</span>
          <div class="sbars">${bar('威力', (st.damage * st.pellets) / 110)}${bar('連射', 0.07 / st.fireInterval)}${bar('精度', 1 - st.spread * 6)}${bar('反動の小ささ', 1 - st.recoil * 14)}${bar('装弾数', st.magSize / 40)}${bar('静かさ', 1 - st.noiseRadius / 1050)}</div>
          <div class="atts">${btns}</div></div>`;
      };
      body = `<p class="note">作業台のそばで付け外し。光学サイト（スコープ／ホロ）はどちらか1つ。</p>${modRow('prim', prim)}${modRow('sec', sec)}`;
    } else if (this.tab === 'craft') {
      const rows = RECIPES.map((r) => {
        const cost = Object.entries(r.cost) as [ItemId, number][];
        const costs = cost.map(([m, n]) => `<span class="cost ${have(m) >= n ? 'ok' : 'ng'}">${ITEMS[m].name} ${n}<small>/${have(m)}</small></span>`);
        const enough = cost.every(([m, n]) => have(m) >= n);
        const lvLock = (r.lv ?? 1) > base.bench;
        const blocked = (r.bench && !nearBench) || lvLock;
        const label = lvLock ? `作業台Lv${r.lv}` : r.bench && !nearBench ? '作業台が必要' : '作成';
        return `<div class="recipe${blocked || !enough ? ' dim' : ''}">
          <div class="r-main"><b>${r.name}</b>${r.bench ? `<span class="tag">作業台${r.lv && r.lv > 1 ? ` Lv${r.lv}` : ''}</span>` : ''}<p>${r.desc}</p><div class="costs">${costs.join('')}</div></div>
          <button data-id="${r.id}" ${blocked || !enough ? 'disabled' : ''}>${label}</button>
        </div>`;
      });
      const mats = (['scrap', 'cloth', 'gunpowder', 'parts', 'chem', 'electronics', 'tools'] as ItemId[]).map((m) => `<span>${ITEMS[m].name} <b>${have(m)}</b></span>`).join('');
      body = `<div class="mats">${mats}</div>${rows.join('')}`;
    } else {
      const shared = storage?.shared ?? [];
      const rows = FACILITIES.map((f) => {
        const lv = base[f.id];
        const cur = f.id === 'bench' ? lv - 1 : lv;
        const cost = f.costs[cur];
        const maxed = !cost;
        const entries = (cost ? Object.entries(cost) : []) as [ItemId, number][];
        const owned = (m: ItemId) => have(m) + countItem(shared, m);
        const enough = entries.every(([m, n]) => owned(m) >= n);
        const costs = entries.map(([m, n]) => `<span class="cost ${owned(m) >= n ? 'ok' : 'ng'}">${ITEMS[m].name} ${n}<small>/${owned(m)}</small></span>`);
        const pips = Array.from({ length: f.levels.length }, (_, i) => `<i class="${i <= cur ? 'on' : ''}"></i>`).join('');
        return `<div class="recipe${maxed || !enough || !nearBench ? ' dim' : ''}">
          <div class="r-main"><b>${f.name}</b><span class="pips">${pips}</span><p>現在：${f.levels[cur]}</p>${maxed ? '<p>最大レベル</p>' : `<p>次：${f.levels[cur + 1]}</p><div class="costs">${costs.join('')}</div>`}</div>
          <button data-upg="${f.id}" ${maxed || !enough || !nearBench ? 'disabled' : ''}>${maxed ? '最大' : !nearBench ? '作業台へ' : '強化'}</button>
        </div>`;
      });
      body = `<p class="note">素材はバックパック → 共有倉庫の順に使われる。持ち帰った物資を拠点に投資しよう。</p>${rows.join('')}`;
    }
    this.list.innerHTML = `<div class="tabs ctabs">${tabs}</div>${body}`;
  }
}
