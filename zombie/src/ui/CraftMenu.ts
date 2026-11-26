// ============================================================
// クラフト・改造メニュー（DOMパネル）
//   [C] で開く。作業台のそばでは弾薬・救急キット・アタッチメントの作成と、
//   装備中の武器へのアタッチメント取り付け（改造）ができる
// ============================================================
import { RECIPES } from '../game/constants';
import { countItem, ITEMS, type ItemId, isWeapon, effectiveStats } from '../game/items';
import type { Slot } from '../types';

const ATTS = ['scope', 'suppressor', 'extmag', 'grip'] as const;

export class CraftMenu {
  open = false;
  private list: HTMLElement;
  private benchLabel: HTMLElement;
  private lastKey = '';

  constructor(
    private panel: HTMLElement,
    private onCraft: (id: string) => void,
    private onToggle: (open: boolean) => void,
    private onMod: (slot: 'prim' | 'sec', att: string) => void = () => {},
  ) {
    this.list = panel.querySelector('#craft-list') as HTMLElement;
    this.benchLabel = panel.querySelector('#craft-bench') as HTMLElement;
    panel.querySelector('#craft-close')?.addEventListener('click', () => this.toggle(false));
    this.list.addEventListener('click', (e) => {
      const btn = (e.target as HTMLElement).closest('button') as HTMLButtonElement | null;
      if (!btn || btn.disabled) return;
      if (btn.dataset.id) this.onCraft(btn.dataset.id);
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
  }

  destroy(): void {
    this.toggle(false);
  }

  /** 持ち物が変わったときだけ描き直す */
  update(bag: (Slot | null)[], prim: Slot | null, sec: Slot | null, nearBench: boolean): void {
    if (!this.open) return;
    const key = JSON.stringify([bag, prim, sec, nearBench]);
    if (key === this.lastKey) return;
    this.lastKey = key;
    this.benchLabel.textContent = nearBench ? '作業台：使用可能（改造もできる）' : '作業台から離れている（包帯のみ作れる）';
    this.benchLabel.className = nearBench ? 'ok' : 'ng';
    const have = (m: ItemId) => countItem(bag, m);

    // ---- 武器改造 ----
    const modRow = (key: 'prim' | 'sec', s: Slot | null) => {
      if (!s || !isWeapon(s.id)) return `<div class="mod-row dim"><b>${key === 'prim' ? 'メイン' : 'サブ'}</b><span>未装備</span></div>`;
      const st = effectiveStats(s.id, s.w);
      const btns = ATTS.map((a) => {
        const on = !!s.w?.[a];
        const can = nearBench && (on || have(a) > 0);
        return `<button class="att ${on ? 'on' : ''}" data-mod="${key}:${a}" ${can ? '' : 'disabled'} title="${ITEMS[a].desc}">${on ? '✔ ' : ''}${ITEMS[a].name}${on ? '' : ` <small>${have(a)}</small>`}</button>`;
      }).join('');
      return `<div class="mod-row"><b>${ITEMS[s.id].name}</b><span class="stat">装弾 ${st.magSize}・精度 ${Math.round((1 - st.spread * 6) * 100)}%・音 ${Math.round(st.noiseRadius)}</span><div class="atts">${btns}</div></div>`;
    };
    const mods = `<h4>武器改造 <small>アタッチメントを付け外し（作業台）</small></h4>${modRow('prim', prim)}${modRow('sec', sec)}`;

    // ---- レシピ ----
    const rows = RECIPES.map((r) => {
      const cost = Object.entries(r.cost) as [ItemId, number][];
      const costs = cost.map(([m, n]) => `<span class="cost ${have(m) >= n ? 'ok' : 'ng'}">${ITEMS[m].name} ${n}<small>/${have(m)}</small></span>`);
      const enough = cost.every(([m, n]) => have(m) >= n);
      const blocked = r.bench && !nearBench;
      const label = blocked ? '作業台が必要' : '作成';
      return `<div class="recipe${blocked || !enough ? ' dim' : ''}">
        <div class="r-main"><b>${r.name}${r.out.n > 1 ? ` ×${r.out.n}` : ''}</b>${r.bench ? '<span class="tag">作業台</span>' : ''}<p>${r.desc}</p><div class="costs">${costs.join('')}</div></div>
        <button data-id="${r.id}" ${blocked || !enough ? 'disabled' : ''}>${label}</button>
      </div>`;
    });
    const mats = (['scrap', 'cloth', 'gunpowder', 'parts', 'chem', 'electronics'] as ItemId[]).map((m) => `<span>${ITEMS[m].name} <b>${have(m)}</b></span>`).join('');
    this.list.innerHTML = `${mods}<h4>クラフト</h4><div class="mats">${mats}</div>${rows.join('')}`;
  }
}
