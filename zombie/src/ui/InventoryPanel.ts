// ============================================================
// インベントリ／ルート／倉庫パネル（DOM）
//   [Tab] でバックパックを開く。入れ物を探索し終わると自動で中身の一覧が右側に出る
//   ・入れ物のマスをクリック → バックパックへ  ・「全部取る」
//   ・バックパックのマスをクリック → 入れ物／倉庫に入れる（何も開いていなければ使う・装備）
//   ・右クリック → 使う・装備   ・Shift+クリック → 足元に捨てる
//   マスにカーソルを合わせると右端の詳細欄に種類・効果・数値が出る
// ============================================================
import { MELEE_STATS, type MeleeId } from '../game/constants';
import { AFFIX_NAMES, ATTACHMENTS, QUALITY, weaponLabel, capacityOf, effectiveStats, ITEMS, type ItemCat, type ItemId, isWeapon, loadKg, slotKg, WEAPON_STATS, type WeaponId } from '../game/items';
import { PERKS, levelOf, MAX_SKILL_LV, SKILLS, xpForLevel } from '../game/progression';
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
const CAT_NAME: Record<ItemCat, string> = {
  ammo: '弾薬',
  med: '医療品',
  food: '食料',
  mat: '素材',
  att: 'アタッチメント',
  weapon: '武器',
  misc: '貴重品',
};
const RARITY_NAME = ['COMMON', 'UNCOMMON', 'RARE', 'EPIC'];

/** アタッチメントの効果（詳細欄用） */
const ATT_FX: Record<string, [string, string, boolean][]> = {
  scope: [['集弾率', '+55%', true], ['反動', '-10%', true], ['照準方向の視界', '+30%', true], ['光学スロット', '使用', false]],
  holo: [['集弾率', '+30%', true], ['反動', '-15%', true], ['光学スロット', '使用', false]],
  suppressor: [['銃声の届く距離', '-68%', true], ['威力', '-8%', false]],
  extmag: [['装弾数', '+60%', true], ['リロード時間', '+12%', false]],
  grip: [['連射時の反動', '-50%', true], ['集弾率', '+15%', true]],
};
const AMMO_FOR: Partial<Record<ItemId, string>> = {
  ammo9: 'ハンドガン・SMG',
  ammo9ap: 'ハンドガン・SMG（[T]で切替）',
  ammo762: 'アサルトライフル・狩猟ライフル・マークスマン',
  ammo762ap: 'アサルトライフル・狩猟ライフル・マークスマン（[T]で切替）',
  shells: 'ショットガン',
  slug: 'ショットガン（[T]で切替）',
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
  private detail: HTMLElement;
  private title: HTMLElement;
  private hoverKey = '';

  constructor(
    private panel: HTMLElement,
    private onOp: (op: string) => void,
    private onToggle: (open: boolean) => void,
  ) {
    this.body = panel.querySelector('#inv-body') as HTMLElement;
    this.detail = panel.querySelector('#inv-desc') as HTMLElement;
    this.title = panel.querySelector('#inv-title') as HTMLElement;
    panel.querySelector('#inv-close')?.addEventListener('click', () => this.toggle(false));
    panel.addEventListener('contextmenu', (e) => e.preventDefault());
    // タッチ：長押しで右クリックと同じ操作（使う・装備）。直後に届く「タップのクリック」は無視する
    let lpTimer = 0;
    let lpFired = false;
    let suppressUntil = 0;
    panel.addEventListener('mousedown', (e) => {
      if (performance.now() < suppressUntil) return;
      this.onClick(e);
    });
    panel.addEventListener('touchstart', (e) => {
      const t = e.target as HTMLElement;
      lpFired = false;
      clearTimeout(lpTimer);
      lpTimer = window.setTimeout(() => {
        lpFired = true;
        suppressUntil = performance.now() + 700;
        this.onClick({ target: t, button: 2, shiftKey: false, preventDefault: () => {} } as unknown as MouseEvent);
      }, 450);
    });
    const lpEnd = (e: TouchEvent) => {
      clearTimeout(lpTimer);
      // 長押しが成立したら、続けて来るクリック（左クリック扱い）は出さない
      if (lpFired) e.preventDefault();
    };
    panel.addEventListener('touchend', lpEnd);
    panel.addEventListener('touchmove', () => clearTimeout(lpTimer));
    panel.addEventListener('touchcancel', lpEnd);
    panel.addEventListener('mouseover', (e) => {
      const el = (e.target as HTMLElement).closest('[data-act]') as HTMLElement | null;
      if (!el || !this.ctx) return;
      const s = this.slotOf(el.dataset.act!, Number(el.dataset.i ?? 0), el.dataset.slot);
      if (s) {
        this.hoverKey = `${el.dataset.act}:${el.dataset.i ?? ''}:${el.dataset.slot ?? ''}`;
        this.renderDetail(s);
      } else if (el.dataset.skill) this.renderSkill(Number(el.dataset.skill));
    });
  }

  toggle(force?: boolean, silent = false): void {
    const next = force ?? !this.open;
    if (next === this.open) return;
    this.open = next;
    this.panel.classList.toggle('hidden', !next);
    this.lastKey = '';
    this.hoverKey = '';
    if (!silent) this.onToggle(next);
    if (next && this.ctx) this.update(this.ctx);
  }

  destroy(): void {
    this.toggle(false);
  }

  private storageBox(c: InvContext): (Slot | null)[] | null {
    return c.me.storage && c.storage ? (this.tab === 'shared' ? c.storage.shared : c.storage.personal[c.me.id] ?? []) : null;
  }

  private slotOf(act: string, i: number, slot?: string): Slot | null {
    const c = this.ctx;
    if (!c) return null;
    if (act === 'bag') return c.me.bag[i] ?? null;
    if (act === 'cont') return c.cont?.slots[i] ?? null;
    if (act === 'store') return this.storageBox(c)?.[i] ?? null;
    if (act === 'equip') return slot === 'prim' ? c.me.prim : slot === 'sec' ? c.me.sec : slot === 'pack' && c.me.pack ? { id: c.me.pack, n: 1 } : slot === 'mel' && c.me.mel ? c.me.mel : null;
    return null;
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
        if (btn.dataset.slot) this.onOp(`unequip:${btn.dataset.slot}`);
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
        this.update(c);
        return;
    }
  }

  private cell(s: Slot | null, act: string, i: number, extra = '', slotKey = ''): string {
    const sk = slotKey ? ` data-slot="${slotKey}"` : '';
    if (!s) return `<div class="islot empty${extra}" data-act="${act}" data-i="${i}"${sk}>${extra ? '— 空き —' : ''}</div>`;
    const d = ITEMS[s.id];
    let sub = s.n > 1 ? `<span class="n">${s.n}</span>` : '';
    let badge = '';
    if (s.w && isWeapon(s.id)) {
      const st = effectiveStats(s.id, s.w);
      sub = `<span class="n">${s.w.mag}/${st.magSize}</span>`;
      if (s.w.ap) badge = `<span class="badge">${s.id === 'shotgun' ? 'SLG' : 'AP'}</span>`;
    }
    // 近接武器：耐久（%）
    const ms = MELEE_STATS[s.id as MeleeId];
    if (ms) sub = `<span class="n">${Math.round(((s.w?.mag ?? ms.dur) / ms.dur) * 100)}%</span>`;
    const mods = s.w ? ATTACHMENTS.filter((a) => s.w![a]).length : 0;
    // 武器の品質（ハクスラ）：枠と名前の色
    const q = s.w?.q ?? 0;
    const qs = q > 0 ? ` style="--q:${QUALITY[q].color}" data-q="${q}"` : '';
    return `<div class="islot c-${d.cat} r${d.rarity}${q > 0 ? ' qual' : ''}${extra}" data-act="${act}" data-i="${i}"${sk}${qs}><span class="ic">${ICON[d.cat]}</span><span class="nm">${q > 0 ? `<b style="color:${QUALITY[q].color}">${QUALITY[q].name}</b> ` : ''}${d.name}</span>${sub}${badge}${mods ? `<span class="mod">+${mods}</span>` : ''}</div>`;
  }

  /** 詳細欄：種類・効果・数値 */
  private renderDetail(s: Slot): void {
    const d = ITEMS[s.id];
    const chips = [`<span class="chip">${CAT_NAME[d.cat]}</span>`, `<span class="chip r${d.rarity}">${RARITY_NAME[d.rarity]}</span>`];
    let rows: [string, string, string][] = [];
    if (s.w && isWeapon(s.id)) {
      const wid = s.id as WeaponId;
      const st = effectiveStats(wid, s.w);
      const base = WEAPON_STATS[wid];
      const cls = (a: number, b: number, higherBetter: boolean) => (Math.abs(a - b) < 1e-6 ? '' : a > b === higherBetter ? 'up' : 'down');
      if (s.w.ap) chips.push(`<span class="chip warn">${wid === 'shotgun' ? 'スラッグ装填' : '徹甲弾装填'}</span>`);
      if (s.w.q) chips.unshift(`<span class="chip" style="color:${QUALITY[s.w.q].color};border-color:${QUALITY[s.w.q].color}">${QUALITY[s.w.q].name}</span>`);
      rows = [
        ['威力', `${Math.round(st.damage)}${st.pellets > 1 ? ` ×${st.pellets}` : ''}`, cls(st.damage * st.pellets, base.damage * base.pellets, true)],
        ['連射速度', `${Math.round(60 / st.fireInterval)} 発/分`, ''],
        ['集弾率', `${Math.round(Math.max(0, 1 - st.spread * 5) * 100)}`, cls(-st.spread, -base.spread, true)],
        ['反動', `${Math.round(st.recoil * 1000)}`, cls(-st.recoil, -base.recoil, true)],
        ['装弾数', `${s.w.mag} / ${st.magSize}`, cls(st.magSize, base.magSize, true)],
        ['リロード', `${st.reloadTime.toFixed(1)} 秒`, cls(-st.reloadTime, -base.reloadTime, true)],
        ['銃声の距離', `${Math.round(st.noiseRadius)}`, cls(-st.noiseRadius, -base.noiseRadius, true)],
        ['弾薬', ITEMS[st.ammo].name, ''],
      ];
      if (st.armorPierce) rows.push(['装甲', '貫通', 'up']);
      if (st.pierce) rows.push(['貫通', `${st.pierce} 体`, 'up']);
      const atts = ATTACHMENTS.filter((a) => s.w![a]).map((a) => ITEMS[a].name);
      if (atts.length) rows.push(['装着', atts.join('・'), '']);
      for (const a of s.w.aff ?? []) rows.push(['追加性能', AFFIX_NAMES[a], 'up']);
    } else if (ATT_FX[s.id]) {
      rows = ATT_FX[s.id].map(([k, v, good]) => [k, v, good ? 'up' : 'down']);
    } else if (AMMO_FOR[s.id]) {
      rows = [['対応', AMMO_FOR[s.id]!, ''], ['所持数', `${s.n}`, '']];
      if (s.id === 'ammo9ap' || s.id === 'ammo762ap' || s.id === 'slug') rows.push(['特性', '装甲を無視・貫通', 'up']);
    } else rows = [['所持数', `${s.n} / ${d.stack}`, '']];
    rows.push(['価値', `${d.value * s.n}`, '']);
    this.detail.innerHTML = `<div class="d-name"${s.w?.q ? ` style="color:${QUALITY[s.w.q].color}"` : ''}>${s.w ? weaponLabel(s) : d.name}${s.n > 1 ? ` <small>×${s.n}</small>` : ''}</div>
      <div class="d-chips">${chips.join('')}</div>
      <p class="d-desc">${d.desc}</p>
      <dl>${rows.map(([k, v, c]) => `<dt>${k}</dt><dd class="${c}">${v}</dd>`).join('')}</dl>`;
  }

  private renderSkill(i: number): void {
    const sk = SKILLS[i];
    const xp = this.ctx?.me.xp?.[i] ?? 0;
    const lv = levelOf(xp);
    this.hoverKey = `skill:${i}`;
    this.detail.innerHTML = `<div class="d-name">${sk.name}</div>
      <div class="d-chips"><span class="chip ok">Lv${lv}</span><span class="chip">SKILL</span></div>
      <p class="d-desc">${sk.desc}</p>
      <dl><dt>上げ方</dt><dd>${sk.how}</dd><dt>経験値</dt><dd>${Math.floor(xp)} / ${lv >= MAX_SKILL_LV ? 'MAX' : xpForLevel(lv + 1)}</dd>${PERKS.filter((q) => q.skill === i).map((q) => `<dt>${lv >= q.lv ? '✓' : `Lv${q.lv}`} ${q.name}</dt><dd style="opacity:${lv >= q.lv ? 1 : 0.55}">${q.desc}</dd>`).join('')}</dl>`;
  }

  private emptyDetail(): void {
    this.detail.innerHTML = `<div class="sec-head">アイテム詳細</div><p class="d-empty">マスにカーソルを合わせると、種類・効果・性能の数値が表示されます。<br /><br />左クリック：移す／使う<br />右クリック：使う・装備<br />Shift+クリック：足元に捨てる</p>`;
  }

  update(c: InvContext): void {
    this.ctx = c;
    if (!this.open) return;
    const st = this.storageBox(c);
    if (this.giveTo >= 0 && !c.allies.some((a) => a.id === this.giveTo)) this.giveTo = -1;
    const key = JSON.stringify([c.me.xp, c.me.bag, c.me.prim, c.me.sec, c.me.pack, c.me.mel, c.cont, st, this.tab, c.allies, this.giveTo]);
    if (key === this.lastKey) return;
    this.lastKey = key;

    const cap = capacityOf(c.me.pack);
    const used = c.me.bag.slice(0, cap.slots).filter((s) => s).length;
    const kg = loadKg(c.me);
    const equip = (k: 'prim' | 'sec', label: string) => `<div class="eq"><small>${label}</small>${this.cell(c.me[k], 'equip', 0, ' wide', k)}</div>`;
    const packCell = `<div class="eq"><small>PACK / リュック</small>${this.cell(c.me.pack ? { id: c.me.pack, n: 1 } : null, 'equip', 0, ' wide', 'pack')}</div>`;
    const melCell = `<div class="eq"><small>MELEE / 近接</small>${this.cell(c.me.mel ?? null, 'equip', 0, ' wide', 'mel')}</div>`;
    // リュックの分を超えたマスは鍵（はみ出した物があれば赤で見せ、取り出せる）
    const bag = c.me.bag
      .map((s, i) => (i < cap.slots ? this.cell(s, 'bag', i) : s ? this.cell(s, 'bag', i).replace('class="islot', 'class="islot over') : '<div class="islot locked" title="リュックを背負うと使える">🔒</div>'))
      .join('');
    const kgR = Math.min(1, kg / cap.kg);
    const kgBar = `<div class="kgbar ${kgR > 0.9 ? 'hi' : ''}"><i style="width:${Math.round(kgR * 100)}%"></i><span>${kg.toFixed(1)} / ${cap.kg} kg</span></div>`;
    void slotKg;
    let right = '';
    if (c.cont) {
      const any = c.cont.slots.some((s) => s);
      right = `<div class="inv-col inv-side box">
        <div class="sec-head">${c.cont.name}<small class="right">${c.cont.slots.filter((s) => s).length} 点</small></div>
        <div class="igrid g4">${c.cont.slots.map((s, i) => this.cell(s, 'cont', i)).join('')}</div>
        ${any ? '<button class="btn primary inv-btn" data-act="takeall">全部取る</button>' : '<p class="inv-empty">— 空っぽだ —</p>'}
      </div>`;
    } else if (st) {
      right = `<div class="inv-col inv-side box">
        <div class="sec-head">拠点の倉庫<small class="right">${st.filter((s) => s).length}/${st.length}</small></div>
        <div class="tabs"><button data-act="tab" data-tab="personal" class="${this.tab === 'personal' ? 'on' : ''}">個人倉庫</button><button data-act="tab" data-tab="shared" class="${this.tab === 'shared' ? 'on' : ''}">共有倉庫</button></div>
        <div class="igrid g6 scroll">${st.map((s, i) => this.cell(s, 'store', i)).join('')}</div>
        <button class="btn inv-btn" data-act="putall">武器以外を全部預ける</button>
      </div>`;
    }
    const give = c.allies.length
      ? `<div class="give-row"><span>手渡し:</span>${c.allies
          .map((a) => `<button data-act="give" data-id="${a.id}" class="${this.giveTo === a.id ? 'on' : ''}">${this.giveTo === a.id ? '✔ ' : ''}${a.name}</button>`)
          .join('')}${this.giveTo >= 0 ? '<small>アイテムをクリックで渡す</small>' : ''}</div>`
      : c.coop
        ? '<div class="give-row"><span>手渡し:</span><small>近くに仲間がいない（すぐそばで渡せる）</small></div>'
        : '';
    const skills = SKILLS.map((sk, i) => {
      const xp = c.me.xp?.[i] ?? 0;
      const lv = levelOf(xp);
      const lo = xpForLevel(lv);
      const hi = xpForLevel(lv + 1);
      const r = lv >= MAX_SKILL_LV ? 1 : (xp - lo) / Math.max(1, hi - lo);
      return `<div class="skill" data-act="skill" data-skill="${i}"><b>${sk.name}</b><span>Lv${lv}</span><i><u style="width:${Math.round(r * 100)}%"></u></i></div>`;
    }).join('');

    this.title.textContent = c.cont ? 'ルート' : st ? '拠点の倉庫' : 'バックパック';
    this.body.innerHTML = `<div class="inv-col">
        <div class="box">
          <div class="sec-head">装備<small class="right">EQUIPMENT</small></div>
          <div class="eqrow">${equip('prim', 'PRIMARY / メイン')}${equip('sec', 'SIDEARM / サブ')}${packCell}${melCell}</div>
        </div>
        <div class="box">
          <div class="sec-head">バッグ<small class="right">${used}/${cap.slots} マス</small></div>
          ${kgBar}
          ${give ? `<div style="margin-bottom:6px">${give}</div>` : ''}
          <div class="igrid g4">${bag}</div>
        </div>
        <div class="box">
          <div class="sec-head">スキル<small class="right">保存・引き継ぎ</small></div>
          <div class="skills">${skills}</div>
        </div>
      </div>${right}`;
    // 詳細欄：見ていたものがまだあれば更新、なければ案内
    const [act, i, slot] = this.hoverKey.split(':');
    const s = act ? this.slotOf(act, Number(i), slot || undefined) : null;
    if (s) this.renderDetail(s);
    else if (act === 'skill') this.renderSkill(Number(i));
    else this.emptyDetail();
  }
}
