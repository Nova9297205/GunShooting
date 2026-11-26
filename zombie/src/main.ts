// ============================================================
// エントリーポイント・UI制御（タイトル / プレイヤー名 / ロビー / リザルト）
// ============================================================
import './style.css';
import { MAX_PLAYERS, PLAYER_COLORS } from './game/constants';
import { audio } from './game/Audio';
import { HostSimulation } from './game/Engine';
import { GameSession } from './game/GameSession';
import { NetworkManager, sanitizeName } from './network/NetworkManager';
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

function show(name: keyof typeof screens | null): void {
  for (const [k, el] of Object.entries(screens)) el.classList.toggle('hidden', k !== name);
}

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
}

/** ソロ/ホスト：シミュレーションを作って開始 */
function startAsHost(m: 'solo' | 'host', players: LobbyPlayer[]): void {
  const seed = (Math.random() * 0x7fffffff) | 0;
  const sim = new HostSimulation(players, seed);
  const info: StartInfo = { players, seed, objs: sim.initialObjs() };
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
      const dot = document.createElement('span');
      dot.className = 'dot';
      dot.style.background = PLAYER_COLORS[i];
      const name = document.createElement('span');
      name.textContent = p.name + (net && p.id === net.localId ? ' (YOU)' : '');
      const tag = document.createElement('span');
      tag.className = 'tag';
      tag.textContent = i === 0 ? 'HOST' : 'GUEST';
      li.append(dot, name, tag);
    } else {
      li.className = 'empty';
      li.textContent = `P${i + 1} — 空き`;
    }
    list.append(li);
  }
  setStatus(
    'lobby-status',
    net?.role === 'host'
      ? `参加者 ${players.length}/${MAX_PLAYERS}　準備ができたら開始してください`
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
  net?.destroy();
  net = null;
  startAsHost('solo', [{ id: 0, name: sanitizeName(playerName(), 0) }]);
});

$('btn-host').addEventListener('click', async () => {
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
      session?.removePlayer(id);
      toast(`P${id + 1} が切断しました`);
    },
  });
  try {
    await n.host(playerName());
    if (net !== n) return;
    showLobby();
  } catch (err) {
    goTitle(`ルーム作成に失敗しました: ${(err as Error).message ?? err}`, true);
  }
});

async function joinRoom(): Promise<void> {
  const code = $<HTMLInputElement>('input-code').value.trim().toUpperCase();
  if (code.length !== 6) {
    setStatus('title-status', '6桁のルームIDを入力してください', true);
    return;
  }
  setTitleButtonsDisabled(true);
  setStatus('title-status', `ルーム ${code} に接続中…`);
  net?.destroy();
  const n = new NetworkManager();
  net = n;
  n.setHandlers({
    onLobby: (players) => {
      if (!session && !screens.lobby.classList.contains('hidden')) renderLobby(players);
    },
    onStart: (info) => startSession('guest', info, n.localId),
    onSnapshot: (s) => session?.receiveSnapshot(s),
    onGameOver: (r) => {
      setTimeout(() => {
        if (net !== n) return;
        endSession();
        showResult(r);
      }, 1800);
    },
    onHostLost: (reason) => goTitle(reason, true),
  });
  try {
    await n.join(code, playerName());
    if (net !== n) return;
    showLobby();
  } catch (err) {
    if (net === n) goTitle((err as Error).message ?? String(err), true);
  }
}

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
  startAsHost('host', net.players);
});

$('btn-leave').addEventListener('click', () => goTitle());

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
