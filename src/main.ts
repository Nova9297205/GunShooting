// ============================================================
// エントリーポイント・UI制御（タイトル / ロビー / ゲーム / リザルト）
// ============================================================
import './style.css';
import { MAX_PLAYERS, PLAYER_COLORS } from './game/constants';
import { GameSession } from './game/GameSession';
import { NetworkManager } from './network/NetworkManager';
import type { GameMode, GameResult, LobbyPlayer } from './types';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

const canvas = $<HTMLCanvasElement>('game');
const screens = {
  title: $('screen-title'),
  lobby: $('screen-lobby'),
  result: $('screen-result'),
};

let net: NetworkManager | null = null;
let session: GameSession | null = null;
let mode: GameMode = 'solo';

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

function startSession(m: GameMode, players: LobbyPlayer[], localId: number): void {
  endSession();
  mode = m;
  show(null);
  session = new GameSession({
    mode: m,
    canvas,
    localId,
    lobby: players,
    net: net ?? undefined,
    roomCode: net?.roomCode,
    onGameOver: (r) => {
      // ホスト / ソロ側のゲームオーバー通知
      endSession();
      showResult(r);
    },
  });
  session.start();
}

function endSession(): void {
  session?.stop();
  session = null;
}

function showResult(r: GameResult): void {
  $('result-wave').textContent = String(r.wave);
  const body = $('result-body');
  body.innerHTML = '';
  for (const p of [...r.players].sort((a, b) => b.kills - a.kills)) {
    const tr = document.createElement('tr');
    const name = document.createElement('td');
    name.textContent = p.name + (net && p.id === net.localId ? ' (YOU)' : '');
    name.style.color = PLAYER_COLORS[p.id] ?? '#fff';
    name.style.fontWeight = '700';
    const kills = document.createElement('td');
    kills.textContent = String(p.kills);
    tr.append(name, kills);
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
  if (net?.role === 'host') {
    setStatus('lobby-status', `参加者 ${players.length}/${MAX_PLAYERS}　準備ができたら開始してください`);
  } else {
    setStatus('lobby-status', `参加者 ${players.length}/${MAX_PLAYERS}　ホストの開始を待っています…`);
  }
}

function showLobby(): void {
  if (!net) return;
  $('room-code').textContent = net.roomCode || '------';
  const isHost = net.role === 'host';
  $('btn-start').classList.toggle('hidden', !isHost);
  renderLobby(net.players);
  show('lobby');
}

// ---------------- ボタン ----------------

$('btn-solo').addEventListener('click', () => {
  net?.destroy();
  net = null;
  startSession('solo', [{ id: 0, name: 'P1' }], 0);
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
    await n.host();
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
    onStart: (players) => startSession('guest', players, n.localId),
    onSnapshot: (s) => session?.receiveSnapshot(s),
    onGameOver: (r) => {
      setTimeout(() => {
        if (net !== n) return;
        endSession();
        showResult(r);
      }, 1500);
    },
    onHostLost: (reason) => goTitle(reason, true),
  });
  try {
    await n.join(code);
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
    toast(`ルームID ${code} をコピーしました`);
  } catch {
    // クリップボードAPIが使えない環境向けのフォールバック
    const ta = document.createElement('textarea');
    ta.value = code;
    document.body.append(ta);
    ta.select();
    document.execCommand('copy');
    ta.remove();
    toast(`ルームID ${code} をコピーしました`);
  }
});

$('btn-start').addEventListener('click', () => {
  if (!net || net.role !== 'host') return;
  net.startGame();
  startSession('host', net.players, 0);
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

// URL に ?room=XXXXXX が付いていれば入力欄に反映
const roomParam = new URLSearchParams(location.search).get('room');
if (roomParam) $<HTMLInputElement>('input-code').value = roomParam.toUpperCase();

show('title');
