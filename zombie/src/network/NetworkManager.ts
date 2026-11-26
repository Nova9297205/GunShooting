// ============================================================
// NetworkManager: PeerJS によるホスト・ゲスト方式のP2P通信
//   - ホスト: 6桁ルームIDで Peer を作成し、最大2人のゲスト接続を受け付ける
//   - ゲスト: ルームIDへ接続し、名前を名乗ってから入力送信・スナップショット受信
// ============================================================
import { Peer, type DataConnection, type PeerOptions } from 'peerjs';
import type {
  GameResult,
  GuestMessage,
  HostMessage,
  InputFrame,
  LobbyPlayer,
  Snapshot,
  StartInfo,
} from '../types';
import { MAX_PLAYERS, NAME_MAX } from '../game/constants';

const ID_PREFIX = 'deadnights2d-v1-';
const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

// ---------------- 大きなメッセージの分割送信 ----------------
// PeerJS の JSON チャンネルは1メッセージの大きさに上限があるため、
// 大きいもの（開始時の全オブジェクト一覧など）は文字列にして分割し、受信側で組み立て直す。
const CHUNK = 12000;
let chunkSeq = 1;
interface ChunkMsg {
  type: 'chunk';
  cid: number;
  i: number;
  n: number;
  d: string;
}

function sendBig(conn: DataConnection, msg: object): void {
  const s = JSON.stringify(msg);
  if (s.length <= CHUNK) {
    conn.send(msg);
    return;
  }
  const n = Math.ceil(s.length / CHUNK);
  const cid = chunkSeq++;
  for (let i = 0; i < n; i++) conn.send({ type: 'chunk', cid, i, n, d: s.slice(i * CHUNK, (i + 1) * CHUNK) } satisfies ChunkMsg);
}

/** 分割されたメッセージを組み立てる。完成したら元のメッセージを返す */
class ChunkAssembler {
  private parts = new Map<number, string[]>();
  feed(data: unknown): unknown | null {
    const m = data as ChunkMsg;
    if (!m || m.type !== 'chunk') return data;
    let arr = this.parts.get(m.cid);
    if (!arr) {
      arr = new Array(m.n);
      this.parts.set(m.cid, arr);
    }
    arr[m.i] = m.d;
    for (let i = 0; i < m.n; i++) if (arr[i] === undefined) return null;
    this.parts.delete(m.cid);
    return JSON.parse(arr.join(''));
  }
}

function genCode(): string {
  let s = '';
  for (let i = 0; i < 6; i++) s += CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)];
  return s;
}

export function sanitizeName(raw: string, slot: number): string {
  const n = (raw ?? '').replace(/[\u0000-\u001f]/g, '').trim().slice(0, NAME_MAX);
  return n || `P${slot + 1}`;
}

/** シグナリングサーバー設定（.env.local で自前の PeerServer を指定可能） */
function peerOptions(): PeerOptions {
  const env = import.meta.env;
  const opts: PeerOptions = { debug: 1 };
  if (env.VITE_PEER_HOST) {
    opts.host = env.VITE_PEER_HOST;
    opts.port = Number(env.VITE_PEER_PORT || 9000);
    opts.path = env.VITE_PEER_PATH || '/';
    opts.secure = env.VITE_PEER_SECURE === 'true';
  }
  return opts;
}

export interface NetHandlers {
  onLobby: (players: LobbyPlayer[]) => void;
  onStart: (info: StartInfo) => void;
  onSnapshot: (s: Snapshot) => void;
  onGameOver: (r: GameResult) => void;
  onInput: (playerId: number, f: InputFrame) => void;
  onPeerLeft: (playerId: number) => void;
  onHostLost: (reason: string) => void;
}

export class NetworkManager {
  role: 'host' | 'guest' | null = null;
  roomCode = '';
  localId = 0;
  players: LobbyPlayer[] = [];
  inGame = false;
  /** ゲスト：スナップショット受信間隔の移動平均（ms） */
  snapInterval = 0;

  private peer: Peer | null = null;
  private conns = new Map<number, { conn: DataConnection; name: string }>();
  private hostConn: DataConnection | null = null;
  private handlers: Partial<NetHandlers> = {};
  private destroyed = false;
  private hostName = 'P1';

  setHandlers(h: Partial<NetHandlers>): void {
    this.handlers = { ...this.handlers, ...h };
  }

  // ======================== ホスト ========================

  async host(name: string): Promise<string> {
    this.role = 'host';
    this.localId = 0;
    this.hostName = sanitizeName(name, 0);
    this.players = [{ id: 0, name: this.hostName }];
    for (let attempt = 0; attempt < 5; attempt++) {
      const code = genCode();
      try {
        this.peer = await this.openPeer(ID_PREFIX + code);
        this.roomCode = code;
        break;
      } catch (err) {
        if ((err as { type?: string }).type !== 'unavailable-id') throw err;
      }
    }
    if (!this.peer) throw new Error('ルームIDの発行に失敗しました');
    this.peer.on('connection', (conn) => this.acceptGuest(conn));
    this.peer.on('disconnected', () => {
      if (!this.destroyed) this.peer?.reconnect();
    });
    return this.roomCode;
  }

  private acceptGuest(conn: DataConnection): void {
    let slot = -1;
    const reject = (reason: string) => {
      conn.send({ type: 'reject', reason } satisfies HostMessage);
      setTimeout(() => conn.close(), 300);
    };
    const asm = new ChunkAssembler();
    conn.on('data', (raw) => {
      const data = asm.feed(raw);
      if (data === null) return;
      const msg = data as GuestMessage;
      if (!msg) return;
      if (msg.type === 'hello' && slot < 0) {
        if (this.inGame) return reject('ゲーム進行中のため参加できません');
        for (let i = 1; i < MAX_PLAYERS; i++) {
          if (!this.conns.has(i)) {
            slot = i;
            break;
          }
        }
        if (slot < 0) return reject('ルームが満員です（最大3人）');
        this.conns.set(slot, { conn, name: sanitizeName(msg.name, slot) });
        this.rebuildLobby();
        conn.send({ type: 'welcome', slot, players: this.players } satisfies HostMessage);
        this.broadcastLobby();
      } else if (msg.type === 'input' && slot >= 0) {
        this.handlers.onInput?.(slot, msg.f);
      }
    });
    const onLeave = () => {
      if (slot < 0 || this.conns.get(slot)?.conn !== conn) return;
      this.conns.delete(slot);
      this.rebuildLobby();
      this.broadcastLobby();
      this.handlers.onPeerLeft?.(slot);
      slot = -1;
    };
    conn.on('close', onLeave);
    conn.on('error', onLeave);
  }

  private rebuildLobby(): void {
    const ids = [...this.conns.keys()].sort();
    this.players = [{ id: 0, name: this.hostName }, ...ids.map((id) => ({ id, name: this.conns.get(id)!.name }))];
  }

  private broadcastLobby(): void {
    this.broadcast({ type: 'lobby', players: this.players });
    this.handlers.onLobby?.(this.players);
  }

  broadcast(msg: HostMessage): void {
    for (const { conn } of this.conns.values()) if (conn.open) sendBig(conn, msg);
  }

  startGame(info: StartInfo): void {
    this.inGame = true;
    this.broadcast({ type: 'start', info });
  }

  sendSnapshot(s: Snapshot): void {
    this.broadcast({ type: 'snap', s });
  }

  sendGameOver(result: GameResult): void {
    this.broadcast({ type: 'gameover', result });
  }

  returnToLobby(): void {
    this.inGame = false;
    this.broadcastLobby();
  }

  // ======================== ゲスト ========================

  async join(code: string, name: string): Promise<{ slot: number; players: LobbyPlayer[] }> {
    this.role = 'guest';
    this.roomCode = code.toUpperCase().trim();
    this.peer = await this.openPeer(null);

    return new Promise((resolve, reject) => {
      let settled = false;
      const fail = (msg: string) => {
        if (settled) return;
        settled = true;
        reject(new Error(msg));
      };
      const timer = setTimeout(() => fail('接続がタイムアウトしました'), 12000);

      this.peer!.on('error', (err) => {
        const type = (err as { type?: string }).type;
        if (type === 'peer-unavailable') fail('ルームが見つかりません。IDを確認してください');
        else if (!settled) fail(`接続エラー: ${type ?? err}`);
      });

      const conn = this.peer!.connect(ID_PREFIX + this.roomCode, { reliable: true, serialization: 'json' });
      this.hostConn = conn;
      let lastSnapAt = 0;

      conn.on('open', () => conn.send({ type: 'hello', name } satisfies GuestMessage));
      const asm = new ChunkAssembler();
      conn.on('data', (raw) => {
        const data = asm.feed(raw);
        if (data === null) return;
        const msg = data as HostMessage;
        switch (msg.type) {
          case 'welcome':
            this.localId = msg.slot;
            this.players = msg.players;
            clearTimeout(timer);
            if (!settled) {
              settled = true;
              resolve({ slot: msg.slot, players: msg.players });
            }
            break;
          case 'reject':
            clearTimeout(timer);
            fail(msg.reason);
            break;
          case 'lobby':
            this.players = msg.players;
            this.handlers.onLobby?.(msg.players);
            break;
          case 'start':
            this.players = msg.info.players;
            this.handlers.onStart?.(msg.info);
            break;
          case 'snap': {
            const now = performance.now();
            if (lastSnapAt) this.snapInterval = this.snapInterval * 0.9 + (now - lastSnapAt) * 0.1;
            lastSnapAt = now;
            this.handlers.onSnapshot?.(msg.s);
            break;
          }
          case 'gameover':
            this.handlers.onGameOver?.(msg.result);
            break;
        }
      });
      conn.on('close', () => {
        if (!settled) fail('ホストとの接続が閉じられました');
        else if (!this.destroyed) this.handlers.onHostLost?.('ホストとの接続が切断されました');
      });
      conn.on('error', (e) => {
        if (!settled) fail(`接続エラー: ${e}`);
      });
    });
  }

  sendInput(f: InputFrame): void {
    if (this.hostConn?.open) sendBig(this.hostConn, { type: 'input', f } satisfies GuestMessage);
  }

  // ======================== 共通 ========================

  private openPeer(id: string | null): Promise<Peer> {
    return new Promise((resolve, reject) => {
      const peer = id ? new Peer(id, peerOptions()) : new Peer(peerOptions());
      const onOpen = () => {
        peer.off('error', onError);
        resolve(peer);
      };
      const onError = (err: unknown) => {
        peer.off('open', onOpen);
        peer.destroy();
        reject(err);
      };
      peer.once('open', onOpen);
      peer.once('error', onError);
    });
  }

  destroy(): void {
    this.destroyed = true;
    for (const { conn } of this.conns.values()) conn.close();
    this.conns.clear();
    this.hostConn?.close();
    this.hostConn = null;
    this.peer?.destroy();
    this.peer = null;
  }
}
