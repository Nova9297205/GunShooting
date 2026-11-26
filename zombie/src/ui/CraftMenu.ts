// ============================================================
// クラフトメニュー（DOMパネル）
//   [C] または作業台で [F] を押すと開く。ゲームは止まらないので安全な場所で！
//   木材・鉄はチーム共有、それ以外は自分の持ち物から消費する
// ============================================================
import { MATERIAL_NAMES, type MaterialId, RECIPES } from '../game/constants';
import type { Inventory, Stash } from '../types';

export class CraftMenu {
  open = false;
  private list: HTMLElement;
  private benchLabel: HTMLElement;
  private lastKey = '';

  constructor(
    private panel: HTMLElement,
    private onCraft: (id: string) => void,
    private onToggle: (open: boolean) => void,
  ) {
    this.list = panel.querySelector('#craft-list') as HTMLElement;
    this.benchLabel = panel.querySelector('#craft-bench') as HTMLElement;
    panel.querySelector('#craft-close')?.addEventListener('click', () => this.toggle(false));
    this.list.addEventListener('click', (e) => {
      const btn = (e.target as HTMLElement).closest('button[data-id]') as HTMLButtonElement | null;
      if (btn && !btn.disabled) this.onCraft(btn.dataset.id!);
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
  update(inv: Inventory, stash: Stash, nearBench: boolean): void {
    if (!this.open) return;
    const key = JSON.stringify([inv, stash, nearBench]);
    if (key === this.lastKey) return;
    this.lastKey = key;
    this.benchLabel.textContent = nearBench ? '作業台：使用可能' : '作業台から離れている（基本レシピのみ）';
    this.benchLabel.className = nearBench ? 'ok' : 'ng';
    const have = (m: MaterialId) => (m === 'wood' || m === 'scrap' ? stash[m] : (inv as unknown as Record<string, number>)[m] ?? 0);
    const owned = (id: string) => (id === 'rifle' && inv.gun >= 1) || (id === 'shotgun' && inv.shotgun > 0) || (id === 'axe' && inv.axe > 0);
    const rows = RECIPES.map((r) => {
      const costs = (Object.entries(r.cost) as [MaterialId, number][]).map(([m, n]) => {
        const ok = have(m) >= n;
        return `<span class="cost ${ok ? 'ok' : 'ng'}">${MATERIAL_NAMES[m]} ${n}<small>/${have(m)}</small></span>`;
      });
      const enough = (Object.entries(r.cost) as [MaterialId, number][]).every(([m, n]) => have(m) >= n);
      const blocked = (r.bench && !nearBench) || owned(r.id);
      const label = owned(r.id) ? '所持済み' : r.bench && !nearBench ? '作業台が必要' : '作成';
      return `<div class="recipe${blocked || !enough ? ' dim' : ''}">
        <div class="r-main"><b>${r.name}</b>${r.bench ? '<span class="tag">作業台</span>' : ''}<p>${r.desc}</p><div class="costs">${costs.join('')}</div></div>
        <button data-id="${r.id}" ${blocked || !enough ? 'disabled' : ''}>${label}</button>
      </div>`;
    });
    const mats = (['wood', 'scrap', 'gunpowder', 'cloth', 'herb', 'parts'] as MaterialId[])
      .map((m) => `<span>${MATERIAL_NAMES[m]} <b>${have(m)}</b></span>`)
      .join('');
    this.list.innerHTML = `<div class="mats">${mats}</div>${rows.join('')}`;
  }
}
