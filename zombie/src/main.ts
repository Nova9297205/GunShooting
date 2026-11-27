// ============================================================
// エントリーポイント・UI制御（タイトル / プレイヤー名 / ロビー / リザルト）
// ============================================================
import './style.css';
import { MAX_PLAYERS, PLAYER_COLORS } from './game/constants';
import { audio } from './game/Audio';
import { HostSimulation } from './game/Engine';
import { GameSession } from './game/GameSession';
import { loadRejoin, NetworkManager, sanitizeName } from './network/NetworkManager';
import { levelOf, loadProfile, type Profile, saveProfile, SKILLS } from './game/progression';
import { TitleBackdrop } from './ui/TitleBackdrop';
import { clearSave, describeSave, loadSave } from './game/save';
import type { SaveData } from './game/Engine';
import type { GameMode, ObjKind, GameResult, LobbyPlayer, StartInfo } from './types';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const NAME_KEY = 'deadnights2d.name';

const canvas = $<HTMLCanvasElement>('game');
const screens = {
  title: $('screen-title'),
  lobby: $('screen-lobby'),
  result: $('screen-result'),
};

let net: NetworkManager | null = null;
let session: GameSession | null = null;
let mode: GameMode = 'solo';

// ---------------- プレイヤー名（localStorage に保存） ----------------

const nameInput = $<HTMLInputElement>('input-name');
try {
  nameInput.value = localStorage.getItem(NAME_KEY) ?? '';
} catch {
  /* プライベートモード等では保存できない */
}
nameInput.addEventListener('input', () => {
  try {
    localStorage.setItem(NAME_KEY, nameInput.value.trim().slice(0, 10));
  } catch {
    /* ignore */
  }
});
const playerName = () => nameInput.value.trim().slice(0, 10);

// ---------------- サウンド ----------------

// ブラウザの自動再生制限：最初のクリック/キー入力で音を有効化
const unlockAudio = () => audio.unlock();
window.addEventListener('pointerdown', unlockAudio);
window.addEventListener('keydown', unlockAudio);

const volMusic = $<HTMLInputElement>('vol-music');
const volSfx = $<HTMLInputElement>('vol-sfx');
volMusic.value = String(Math.round(audio.settings.music * 100));
volSfx.value = String(Math.round(audio.settings.sfx * 100));
volMusic.addEventListener('input', () => audio.setMusicVolume(Number(volMusic.value) / 100));
volSfx.addEventListener('input', () => {
  audio.setSfxVolume(Number(volSfx.value) / 100);
});
volSfx.addEventListener('change', () => audio.handleEvent({ k: 'pop', x: 0, y: 0, t: '', c: '', id: -1, s: 'loot' }, -1));


// ---------------- 画面切り替え ----------------

const backdrop = new TitleBackdrop($<HTMLCanvasElement>('title-bg'));

function show(name: keyof typeof screens | null): void {
  for (const [k, el] of Object.entries(screens)) el.classList.toggle('hidden', k !== name);
  backdrop.show(name !== null);
  if (name === 'title') {
    renderProfile();
    renderContinue();
  }
}

/** タイトル：セーブがあれば「続きから」を出す */
function renderContinue(): void {
  const d = loadSave();
  $('continue-box').classList.toggle('hidden', !d);
  if (d) $('continue-desc').textContent = describeSave(d);
}

/** 新しく始めるときは、セーブが上書きされることを確認する */
function confirmOverwrite(): boolean {
  return !loadSave() || window.confirm('新しく始めると、今のセーブ（' + describeSave(loadSave()!) + '）は上書きされます。よろしいですか？');
}

/** 部屋を作って「続きから」を選んだとき、ロビーの開始でセーブを使う */
let continueSave: SaveData | null = null;

/** タイトル：このブラウザに保存されたスキルと記録 */
function renderProfile(): void {
  const prof = loadProfile();
  const box = $('profile-box');
  box.innerHTML = `<div class="pb-title"><span>保存済みの記録</span><span>最長生存 <b>${prof.bestDay}</b> 日 ・ 持ち帰り総額 <b>${prof.banked}</b></span></div>${SKILLS.map(
    (sk, i) => `<div class="pb-skill">${sk.name}<b>Lv${levelOf(prof.xp[i] ?? 0)}</b></div>`,
  ).join('')}`;
}

/** ロビーのカード用：スキルのレベル表示 */
function skillPips(prof: Profile | undefined): string {
  return SKILLS.map((sk, i) => {
    const lv = levelOf(prof?.xp[i] ?? 0);
    return `<div class="op-skill">${sk.name} <span>Lv${lv}</span><div class="pipbar">${Array.from({ length: 10 }, (_, k) => `<i class="${k < lv ? 'on' : ''}"></i>`).join('')}</div></div>`;
  }).join('');
}

const esc = (t: string) => t.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

function setStatus(id: string, text: string, error = false): void {
  const el = $(id);
  el.textContent = text;
  el.classList.toggle('error', error);
}

let toastTimer = 0;
function toast(text: string): void {
  const el = $('toast');
  el.textContent = text;
  el.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => el.classList.add('hidden'), 2500);
}

function setTitleButtonsDisabled(disabled: boolean): void {
  for (const id of ['btn-solo', 'btn-host', 'btn-join']) $<HTMLButtonElement>(id).disabled = disabled;
}

function goTitle(message = '', error = false): void {
  endSession();
  net?.destroy();
  net = null;
  show('title');
  setTitleButtonsDisabled(false);
  setStatus('title-status', message, error);
}

// ---------------- ゲームセッション ----------------

function startSession(m: GameMode, info: StartInfo, localId: number, sim?: HostSimulation): void {
  endSession();
  mode = m;
  show(null);
  session = new GameSession({
    mode: m,
    canvas,
    localId,
    info,
    sim,
    net: net ?? undefined,
    roomCode: net?.roomCode,
    onGameOver: (r) => {
      endSession();
      showResult(r);
    },
  });
  session.start();
  if (import.meta.env.DEV) Object.assign(window, { __session: session, __net: net });
}

/** ソロ/ホスト：シミュレーションを作って開始 */
function startAsHost(m: 'solo' | 'host', players: LobbyPlayer[], save: SaveData | null = null): void {
  const sim = save ? HostSimulation.fromSave(players, save) : new HostSimulation(players, (Math.random() * 0x7fffffff) | 0);
  // 続きからのときは、生成直後からの変化をすべてゲストに渡す
  const info: StartInfo = save ? { players, seed: sim.seed, ...sim.fullWorldDiff() } : { players, seed: sim.seed, objs: sim.initialObjs() };
  if (m === 'host') net?.startGame(info);
  // 開発時のみ：コンソールから時間を進めるなどのデバッグ用
  if (import.meta.env.DEV) Object.assign(window, { __sim: sim, __audio: audio, __place: (k: ObjKind, x: number, y: number) => sim.debugPlace(k, x, y) });
  startSession(m, info, 0, sim);
}

function endSession(): void {
  session?.stop();
  session = null;
}

function showResult(r: GameResult): void {
  audio.gameOver();
  // 自分のスキル経験値・記録を保存（次回に引き継ぐ）
  const mine = r.players.find((p) => p.id === (net?.localId ?? 0));
  if (mine) {
    const prof = loadProfile();
    prof.xp = mine.xp.map((v, i) => Math.max(v, prof.xp[i] ?? 0));
    prof.bestDay = Math.max(prof.bestDay, r.day);
    prof.banked += mine.value;
    saveProfile(prof);
  }
  $('result-day').textContent = String(r.day);
  const body = $('result-body');
  body.innerHTML = '';
  for (const p of [...r.players].sort((a, b) => b.value - a.value)) {
    const tr = document.createElement('tr');
    const name = document.createElement('td');
    name.textContent = p.name + (p.id === (net?.localId ?? 0) ? ' (YOU)' : '');
    name.style.color = PLAYER_COLORS[p.id] ?? '#fff';
    name.style.fontWeight = '700';
    const kills = document.createElement('td');
    kills.textContent = String(p.kills);
    const value = document.createElement('td');
    value.textContent = String(p.value);
    tr.append(name, kills, value);
    body.append(tr);
  }
  $('btn-result-back').textContent = mode === 'solo' ? 'タイトルへ戻る' : 'ロビーへ戻る';
  show('result');
}

// ---------------- ロビー ----------------

function renderLobby(players: LobbyPlayer[]): void {
  const list = $('lobby-list');
  list.innerHTML = '';
  for (let i = 0; i < MAX_PLAYERS; i++) {
    const p = players.find((pl) => pl.id === i);
    const li = document.createElement('li');
    if (p) {
      const me = (net?.localId ?? 0) === p.id;
      li.className = 'op-card';
      li.style.setProperty('--op', PLAYER_COLORS[i]);
      li.innerHTML = `
        <div class="op-slot"><span>P${i + 1} / OPERATOR</span><span>${p.prof?.bestDay ? `最長 ${p.prof.bestDay}日` : 'NEW'}</span></div>
        <div class="op-name" style="color:${PLAYER_COLORS[i]}">${esc(p.name)}</div>
        <div class="chips">${i === 0 ? '<span class="chip host">HOST</span>' : '<span class="chip">GUEST</span>'}${me ? '<span class="chip you">YOU</span>' : ''}<span class="chip ok">● 接続中</span></div>
        <div class="op-skills">${skillPips(p.prof)}</div>`;
    } else {
      li.className = 'op-card empty';
      li.innerHTML = `<div class="scan"></div>P${i + 1} — 接続待機中<br /><small>ルームIDで参加できます</small>`;
    }
    list.append(li);
  }
  setStatus(
    'lobby-status',
    net?.role === 'host'
      ? `参加者 ${players.length}/${MAX_PLAYERS}　準備ができたら開始してください${continueSave ? `（続きから：${describeSave(continueSave)}）` : ''}`
      : `参加者 ${players.length}/${MAX_PLAYERS}　ホストの開始を待っています…`,
  );
}

function showLobby(): void {
  if (!net) return;
  $('room-code').textContent = net.roomCode || '------';
  $('btn-start').classList.toggle('hidden', net.role !== 'host');
  renderLobby(net.players);
  show('lobby');
}

// ---------------- ボタン ----------------

$('btn-solo').addEventListener('click', () => {
  if (!confirmOverwrite()) return;
  net?.destroy();
  net = null;
  startAsHost('solo', [{ id: 0, name: sanitizeName(playerName(), 0), prof: loadProfile() }]);
});

$('btn-host').addEventListener('click', () => {
  if (!confirmOverwrite()) return;
  continueSave = null;
  void openRoom();
});

$('btn-cont-solo').addEventListener('click', () => {
  const d = loadSave();
  if (!d) return renderContinue();
  net?.destroy();
  net = null;
  startAsHost('solo', [{ id: 0, name: sanitizeName(playerName(), 0), prof: loadProfile() }], d);
});

$('btn-cont-host').addEventListener('click', () => {
  continueSave = loadSave();
  if (!continueSave) return renderContinue();
  void openRoom();
});

$('btn-cont-del').addEventListener('click', () => {
  if (!window.confirm('セーブを消しますか？（元に戻せません）')) return;
  clearSave();
  renderContinue();
});

async function openRoom(): Promise<void> {
  setTitleButtonsDisabled(true);
  setStatus('title-status', 'ルームを作成中…（シグナリングサーバーに接続しています）');
  net?.destroy();
  const n = new NetworkManager();
  net = n;
  n.setHandlers({
    onLobby: (players) => {
      if (!session) renderLobby(players);
    },
    onInput: (id, f) => session?.receiveInput(id, f),
    onPeerLeft: (id) => {
      // ゲーム中なら席を残して再接続を待つ
      session?.setAway(id, true);
      toast(`P${id + 1} の通信が切れました（再接続を待っています）`);
    },
    onRejoin: (id) => {
      const info = session?.rejoinInfo(n.players);
      if (!info) return;
      n.sendStartTo(id, info);
      session?.setAway(id, false);
      toast(`P${id + 1} が再接続しました`);
    },
  });
  try {
    await n.host(playerName());
    if (net !== n) return;
    showLobby();
  } catch (err) {
    goTitle(`ルーム作成に失敗しました: ${(err as Error).message ?? err}`, true);
  }
}

async function joinRoom(): Promise<void> {
  const code = $<HTMLInputElement>('input-code').value.trim().toUpperCase();
  if (code.length !== 6) {
    setStatus('title-status', '6桁のルームIDを入力してください', true);
    return;
  }
  setTitleButtonsDisabled(true);
  setStatus('title-status', `ルーム ${code} に接続中…`);
  try {
    await connectGuest(code, null);
    showLobby();
  } catch (err) {
    goTitle((err as Error).message ?? String(err), true);
  }
}

/** ゲストとして接続（rejoin があれば、通信が切れる前の自分のスロットに戻る） */
async function connectGuest(code: string, rejoin: ReturnType<typeof loadRejoin>): Promise<void> {
  net?.destroy();
  const n = new NetworkManager();
  net = n;
  n.setHandlers({
    onLobby: (players) => {
      if (!session && !screens.lobby.classList.contains('hidden')) renderLobby(players);
    },
    onStart: (info) => {
      hideReconnect();
      startSession('guest', info, n.localId);
    },
    onSnapshot: (s) => session?.receiveSnapshot(s),
    onGameOver: (r) => {
      setTimeout(() => {
        if (net !== n) return;
        endSession();
        showResult(r);
      }, 1800);
    },
    onHostLost: (reason) => {
      if (net !== n) return;
      // ゲーム中に切れたら、自動で再接続を試みる
      if (session && mode === 'guest') void reconnect(code);
      else goTitle(reason, true);
    },
  });
  await n.join(code, playerName(), rejoin);
  if (net !== n) throw new Error('接続が取り消されました');
}

// ---------------- ゲスト：再接続 ----------------

let reconnecting = false;
function hideReconnect(): void {
  reconnecting = false;
  $('reconnect').classList.add('hidden');
}
async function reconnect(code: string): Promise<void> {
  if (reconnecting) return;
  reconnecting = true;
  endSession();
  $('reconnect').classList.remove('hidden');
  for (let i = 1; i <= 20 && reconnecting; i++) {
    $('reconnect-msg').textContent = `ホストとの接続が切れました。再接続しています…（${i}/20）`;
    await new Promise((r) => setTimeout(r, 2500));
    if (!reconnecting) return;
    try {
      await connectGuest(code, loadRejoin());
      $('reconnect-msg').textContent = 'つながりました。ワールドを受け取っています…';
      return; // 開始情報（onStart）が届くとゲームに戻る
    } catch (err) {
      const msg = (err as Error).message ?? String(err);
      // ホストに断られた（席が空けられた等）ならあきらめる
      if (msg.includes('進行中') || msg.includes('満員')) {
        hideReconnect();
        goTitle(`再接続できませんでした：${msg}`, true);
        return;
      }
    }
  }
  if (reconnecting) {
    hideReconnect();
    goTitle('再接続できませんでした（ホストが見つかりません）', true);
  }
}
$('reconnect-cancel').addEventListener('click', () => {
  hideReconnect();
  goTitle();
});

$('btn-join').addEventListener('click', joinRoom);
$<HTMLInputElement>('input-code').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') joinRoom();
});

$('btn-copy').addEventListener('click', async () => {
  const code = net?.roomCode ?? '';
  try {
    await navigator.clipboard.writeText(code);
  } catch {
    const ta = document.createElement('textarea');
    ta.value = code;
    document.body.append(ta);
    ta.select();
    document.execCommand('copy');
    ta.remove();
  }
  toast(`ルームID ${code} をコピーしました`);
});

$('btn-start').addEventListener('click', () => {
  if (!net || net.role !== 'host') return;
  startAsHost('host', net.players, continueSave);
  continueSave = null;
});

$('btn-leave').addEventListener('click', () => goTitle());

// ゲーム中の「終了」：ソロ・ホストは保存してタイトルへ（ゲストは退出）
$('btn-quit').addEventListener('click', () => {
  const msg = mode === 'guest' ? 'ルームから退出してタイトルに戻りますか？' : mode === 'host' ? '保存してルームを閉じ、タイトルに戻りますか？（仲間も切断されます）' : '保存してタイトルに戻りますか？';
  if (!window.confirm(msg)) return;
  hideReconnect();
  goTitle(mode === 'guest' ? '' : 'セーブしました。「続きから」で再開できます');
});

$('btn-result-back').addEventListener('click', () => {
  if (mode === 'solo' || !net) {
    goTitle();
    return;
  }
  if (net.role === 'host') net.returnToLobby();
  showLobby();
});

const roomParam = new URLSearchParams(location.search).get('room');
if (roomParam) $<HTMLInputElement>('input-code').value = roomParam.toUpperCase();

show('title');
