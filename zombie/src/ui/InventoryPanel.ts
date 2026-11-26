// ============================================================
// インベントリ／ルート／倉庫パネル（DOM）
//   [Tab] でバックパックを開く。入れ物を探索し終わると自動で中身の一覧が右側に出る
//   ・入れ物のマスをクリック → バックパックへ  ・「全部取る」
//   ・バックパックのマスをクリック → 入れ物／倉庫に入れる（何も開いていなければ使う・装備）
//   ・右クリック → 使う・装備   ・Shift+クリック → 足元に捨てる
// ============================================================
import { effectiveStats, ITEMS, type ItemCat, isWeapon } from '../game/items';
import { levelOf, MAX_SKILL_LV, SKILLS, xpForLevel } from '../game/progression';
import type { PlayerSnap, Slot, StorageState } from '../types';

const ICON: Record<ItemCat, string> = {
  ammo: '⁞',
  med: '✚',
  food: '◍',
  mat: '⚙',
  att: '◎',
  weapon: '▬',
  misc: '◆',
};

export interface InvContext {
  me: PlayerSnap;
  /** 中身を見ている入れ物（名前と中身） */
  cont: { id: number; name: string; slots: (Slot | null)[] } | null;
  storage: StorageState | null;
  /** 近くにいる仲間（直接手渡しできる） */
  allies: { id: number; name: string }[];
  /** 協力プレイ中か（手渡し欄を常に表示してレイアウトがずれないようにする） */
  coop: boolean;
}

export class InventoryPanel {
  open = false;
  private tab: 'personal' | 'shared' = 'personal';
  /** 手渡しモードの相手（-1 = なし） */
  private giveTo = -1;
  private lastKey = '';
  private ctx: InvContext | null = null;
  private body: HTMLElement;
  private desc: HTMLElement;
  private title: HTMLElement;

  constructor(
    private panel: HTMLElement,
    private onOp: (op: string) => void,
    private onToggle: (open: boolean) => void,
  ) {
    this.body = panel.querySelector('#inv-body') as HTMLElement;
    this.desc = panel.querySelector('#inv-desc') as HTMLElement;
    this.title = panel.querySelector('#inv-title') as HTMLElement;
    panel.querySelector('#inv-close')?.addEventListener('click', () => this.toggle(false));
    panel.addEventListener('contextmenu', (e) => e.preventDefault());
    panel.addEventListener('mousedown', (e) => this.onClick(e));
    panel.addEventListener('mouseover', (e) => {
      const el = (e.target as HTMLElement).closest('[data-desc]') as HTMLElement | null;
      this.desc.textContent = el?.dataset.desc ?? '';
    });
  }

  toggle(force?: boolean, silent = false): void {
    const next = force ?? !this.open;
    if (next === this.open) return;
    this.open = next;
    this.panel.classList.toggle('hidden', !next);
    this.lastKey = '';
    if (!silent) this.onToggle(next);
    if (next && this.ctx) this.update(this.ctx);
  }

  destroy(): void {
    this.toggle(false);
  }

  private onClick(e: MouseEvent): void {
    const t = e.target as HTMLElement;
    const btn = t.closest('[data-act]') as HTMLElement | null;
    if (!btn || !this.ctx) return;
    e.preventDefault();
    const act = btn.dataset.act!;
    const i = Number(btn.dataset.i ?? 0);
    const c = this.ctx;
    const right = e.button === 2;
    switch (act) {
      case 'bag': {
        const s = c.me.bag[i];
        if (!s) return;
        if (e.shiftKey) this.onOp(`drop:${i}`);
        else if (right) this.onOp(`use:${i}`);
        else if (this.giveTo >= 0 && c.allies.some((a) => a.id === this.giveTo)) this.onOp(`give:${this.giveTo}:${i}`);
        else if (c.cont) this.onOp(`put:${c.cont.id}:${i}`);
        else if (c.storage && c.me.storage) this.onOp(`st:put:${this.tab}:${i}`);
        else this.onOp(`use:${i}`);
        break;
      }
      case 'equip':
        this.onOp(`unequip:${btn.dataset.slot}`);
        break;
      case 'cont':
        if (c.cont) this.onOp(`take:${c.cont.id}:${i}`);
        break;
      case 'takeall':
        if (c.cont) this.onOp(`takeall:${c.cont.id}`);
        break;
      case 'store':
        this.onOp(`st:take:${this.tab}:${i}`);
        break;
      case 'putall':
        this.onOp(`st:putall:${this.tab}`);
        break;
      case 'give': {
        const id = Number(btn.dataset.id);
        this.giveTo = this.giveTo === id ? -1 : id;
        this.lastKey = '';
        this.update(c);
        return;
      }
      case 'tab':
        this.tab = btn.dataset.tab === 'shared' ? 'shared' : 'personal';
        this.lastKey = '';
        if (this.ctx) this.update(this.ctx);
        return;
    }
  }

  private cell(s: Slot | null, act: string, i: number, extra = ''): string {
    if (!s) return `<div class="islot empty" data-act="${act}" data-i="${i}"></div>`;
    const d = ITEMS[s.id];
    let sub = s.n > 1 ? `<span class="n">${s.n}</span>` : '';
    if (s.w && isWeapon(s.id)) {
      const st = effectiveStats(s.id, s.w);
      sub = `<span class="n">${s.w.mag}/${st.magSize}${s.w.ap ? ' AP' : ''}</span>`;
    }
    const atts = s.w ? ['scope', 'holo', 'suppressor', 'extmag', 'grip'].filter((a) => s.w![a as 'scope']).map((a) => ITEMS[a as 'scope'].name) : [];
    const ws = s.w && isWeapon(s.id) ? effectiveStats(s.id, s.w) : null;
    const wtxt = ws
      ? `［威力 ${Math.round(ws.damage * ws.pellets)}・${Math.round(60 / ws.fireInterval)}発/分・精度 ${Math.round(Math.max(0, 1 - ws.spread * 5) * 100)}・反動 ${Math.round(ws.recoil * 1000)}・リロード ${ws.reloadTime.toFixed(1)}秒・音 ${Math.round(ws.noiseRadius)}${ws.armorPierce ? '・装甲貫通' : ''}］`
      : '';
    const desc = `${d.name}${s.n > 1 ? ` ×${s.n}` : ''} — ${d.desc}${wtxt}${atts.length ? `（装着: ${atts.join('・')}）` : ''}　価値 ${d.value * s.n}`;
    return `<div class="islot c-${d.cat} r${d.rarity}${s.w?.ap ? ' ap' : ''}${extra}" data-act="${act}" data-i="${i}" data-desc="${desc}"><span class="ic">${ICON[d.cat]}</span><span class="nm">${d.name}</span>${sub}${atts.length ? '<span class="mod">+' + atts.length + '</span>' : ''}</div>`;
  }

  update(c: InvContext): void {
    this.ctx = c;
    if (!this.open) return;
    const st = c.me.storage && c.storage ? (this.tab === 'shared' ? c.storage.shared : c.storage.personal[c.me.id] ?? []) : null;
    if (this.giveTo >= 0 && !c.allies.some((a) => a.id === this.giveTo)) this.giveTo = -1;
    const key = JSON.stringify([c.me.xp, c.me.bag, c.me.prim, c.me.sec, c.cont, st, this.tab, c.allies, this.giveTo]);
    if (key === this.lastKey) return;
    this.lastKey = key;

    const used = c.me.bag.filter((s) => s).length;
    const equip = (k: 'prim' | 'sec', label: string) => {
      const s = c.me[k];
      return `<div class="eq"><small>${label}</small>${s ? this.cell(s, 'equip', 0, ' wide').replace('data-act="equip"', `data-act="equip" data-slot="${k}"`) : '<div class="islot empty wide"></div>'}</div>`;
    };
    const bag = c.me.bag.map((s, i) => this.cell(s, 'bag', i)).join('');
    let right = '';
    if (c.cont) {
      const any = c.cont.slots.some((s) => s);
      right = `<div class="inv-side">
        <h4>${c.cont.name}</h4>
        <div class="igrid g4">${c.cont.slots.map((s, i) => this.cell(s, 'cont', i)).join('')}</div>
        ${any ? '<button class="inv-btn" data-act="takeall">全部取る</button>' : '<p class="inv-empty">空っぽだ</p>'}
      </div>`;
    } else if (st) {
      right = `<div class="inv-side">
        <div class="tabs"><button data-act="tab" data-tab="personal" class="${this.tab === 'personal' ? 'on' : ''}">個人倉庫</button><button data-act="tab" data-tab="shared" class="${this.tab === 'shared' ? 'on' : ''}">共有倉庫</button></div>
        <div class="igrid g6 scroll">${st.map((s, i) => this.cell(s, 'store', i)).join('')}</div>
        <button class="inv-btn" data-act="putall">武器以外を全部預ける</button>
      </div>`;
    }
    this.title.textContent = c.cont ? 'ルート' : st ? '拠点の倉庫' : 'バックパック';
    this.body.innerHTML = `<div class="inv-main">
        <div class="eqrow">${equip('prim', 'メイン武器')}${equip('sec', 'サブ武器')}</div>
        <h4>バックパック <small>${used}/${c.me.bag.length}</small></h4>
        ${
          c.allies.length
            ? `<div class="give-row"><span>仲間に手渡し:</span>${c.allies
                .map((a) => `<button data-act="give" data-id="${a.id}" class="${this.giveTo === a.id ? 'on' : ''}">${this.giveTo === a.id ? '✔ ' : ''}${a.name}</button>`)
                .join('')}${this.giveTo >= 0 ? '<small>アイテムをクリックで渡す</small>' : ''}</div>`
            : c.coop
              ? '<div class="give-row"><span>仲間に手渡し:</span><small>近くに仲間がいない（すぐそばまで近づくと渡せる）</small></div>'
              : ''
        }
        <div class="igrid g4">${bag}</div>
        <h4>スキル <small>（ブラウザに保存され次回も引き継ぐ）</small></h4>
        <div class="skills">${SKILLS.map((sk, i) => {
          const xp = c.me.xp?.[i] ?? 0;
          const lv = levelOf(xp);
          const lo = xpForLevel(lv);
          const hi = xpForLevel(lv + 1);
          const r = lv >= MAX_SKILL_LV ? 1 : (xp - lo) / Math.max(1, hi - lo);
          return `<div class="skill" data-desc="${sk.name} Lv${lv}：${sk.desc}（上げ方：${sk.how}）"><b>${sk.name}</b><span>Lv${lv}</span><i><u style="width:${Math.round(r * 100)}%"></u></i></div>`;
        }).join('')}</div>
      </div>${right}`;
  }
}
