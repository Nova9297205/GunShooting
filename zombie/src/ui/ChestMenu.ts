// ============================================================
// 共有チェスト（拠点の収納）DOMパネル
//   チェストの前で [F]。仲間同士で弾薬・救急キット・素材を受け渡せる
// ============================================================
import { CHEST_ITEMS } from '../game/constants';
import type { Inventory } from '../types';

export class ChestMenu {
  open = false;
  private list: HTMLElement;
  private lastKey = '';

  constructor(
    private panel: HTMLElement,
    private onOp: (op: string) => void,
    private onToggle: (open: boolean) => void,
  ) {
    this.list = panel.querySelector('#chest-list') as HTMLElement;
    panel.querySelector('#chest-close')?.addEventListener('click', () => this.toggle(false));
    this.list.addEventListener('click', (e) => {
      const btn = (e.target as HTMLElement).closest('button[data-op]') as HTMLButtonElement | null;
      if (!btn || btn.disabled) return;
      for (const op of btn.dataset.op!.split('|')) this.onOp(op);
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

  update(inv: Inventory, chest: Record<string, number>, near: boolean): void {
    if (!this.open) return;
    if (!near) {
      this.toggle(false);
      return;
    }
    const key = JSON.stringify([inv, chest]);
    if (key === this.lastKey) return;
    this.lastKey = key;
    const mine = inv as unknown as Record<string, number>;
    const rows = CHEST_ITEMS.map((it) => {
      const have = mine[it.id] ?? 0;
      const inChest = chest[it.id] ?? 0;
      return `<div class="chest-row">
        <span class="c-name">${it.name}</span>
        <span class="c-num">${have}</span>
        <button data-op="d:${it.id}:${it.step}" ${have <= 0 ? 'disabled' : ''}>預ける ▶</button>
        <button data-op="w:${it.id}:${it.step}" ${inChest <= 0 ? 'disabled' : ''}>◀ 受け取る</button>
        <span class="c-num chest">${inChest}</span>
      </div>`;
    });
    const mats = ['gunpowder', 'cloth', 'herb', 'parts'].filter((m) => (mine[m] ?? 0) > 0).map((m) => `d:${m}:${mine[m]}`);
    this.list.innerHTML = `<div class="chest-row head"><span class="c-name"></span><span class="c-num">あなた</span><span></span><span></span><span class="c-num chest">チェスト</span></div>
      ${rows.join('')}
      <button class="chest-all" data-op="${mats.join('|')}" ${mats.length ? '' : 'disabled'}>素材（火薬・布・薬草・パーツ）を全部預ける</button>`;
  }
}
