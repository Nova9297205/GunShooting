// ============================================================
// NetworkManager: PeerJS によるホスト・ゲスト方式のP2P通信
//   - ホスト: 6桁ルームIDで Peer を作成し、最大2人のゲスト接続を受け付ける
//   - ゲスト: ルームIDへ接続し、入力を送信・スナップショットを受信する
// ============================================================
import { Peer, type DataConnection, type PeerOptions } from 'peerjs';
import type {
  GameResult,
  GuestMessage,
  HostMessage,
  InputFrame,
  LobbyPlayer,
  Snapshot,
} from '../types';
import { MAX_PLAYERS } from '../game/constants';

const ID_PREFIX = 'gs2d-coop-v1-';
const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // 紛らわしい文字(0,O,1,I)は除外

function genCode(): string {
  let s = '';
  for (let i = 0; i < 6; i++) s += CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)];
  return s;
}

/** シグナリングサーバー設定（.env で自前の PeerServer を指定可能。未指定なら PeerJS 公開サーバー） */
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
  /** ロビーの参加者が変化した */
  onLobby: (players: LobbyPlayer[]) => void;
  /** ゲーム開始（ゲスト側） */
  onStart: (players: LobbyPlayer[]) => void;
  /** スナップショット受信（ゲスト側） */
  onSnapshot: (s: Snapshot) => void;
  /** ゲームオーバー受信（ゲスト側） */
  onGameOver: (r: GameResult) => void;
  /** ゲストの入力受信（ホスト側） */
  onInput: (playerId: number, f: InputFrame) => void;
  /** ゲストが切断（ホスト側） */
  onPeerLeft: (playerId: number) => void;
  /** ホストとの接続が切れた（ゲスト側） */
  onHostLost: (reason: string) => void;
}

export class NetworkManager {
  role: 'host' | 'guest' | null = null;
  roomCode = '';
  localId = 0;
  players: LobbyPlayer[] = [];
  inGame = false;
  /** ゲスト側：スナップショット受信間隔の移動平均（ms、同期状況の目安） */
  snapInterval = 0;

  private peer: Peer | null = null;
  private conns = new Map<number, DataConnection>();
  private hostConn: DataConnection | null = null;
  private handlers: Partial<NetHandlers> = {};
  private destroyed = false;

  setHandlers(h: Partial<NetHandlers>): void {
    this.handlers = { ...this.handlers, ...h };
  }

  // ======================== ホスト ========================

  async host(): Promise<string> {
    this.role = 'host';
    this.localId = 0;
    this.players = [{ id: 0, name: 'P1' }];
    for (let attempt = 0; attempt < 5; attempt++) {
      const code = genCode();
      try {
        this.peer = await this.openPeer(ID_PREFIX + code);
        this.roomCode = code;
        break;
      } catch (err) {
        const type = (err as { type?: string }).type;
        if (type !== 'unavailable-id') throw err;
      }
    }
    if (!this.peer) throw new Error('ルームIDの発行に失敗しました');

    this.peer.on('connection', (conn) => this.acceptGuest(conn));
    this.peer.on('disconnected', () => {
      // シグナリングサーバーから切れても既存のP2P接続は維持される。新規参加用に再接続を試みる
      if (!this.destroyed) this.peer?.reconnect();
    });
    return this.roomCode;
  }

  private acceptGuest(conn: DataConnection): void {
    let slot = -1;
    conn.on('open', () => {
      if (this.inGame) {
        conn.send({ type: 'reject', reason: 'ゲーム進行中のため参加できません' } satisfies HostMessage);
        setTimeout(() => conn.close(), 300);
        return;
      }
      for (let i = 1; i < MAX_PLAYERS; i++) {
        if (!this.conns.has(i)) {
          slot = i;
          break;
        }
      }
      if (slot < 0) {
        conn.send({ type: 'reject', reason: 'ルームが満員です（最大3人）' } satisfies HostMessage);
        setTimeout(() => conn.close(), 300);
        return;
      }
      this.conns.set(slot, conn);
      this.rebuildLobby();
      conn.send({ type: 'welcome', slot, players: this.players } satisfies HostMessage);
      this.broadcastLobby();
    });
    conn.on('data', (data) => {
      if (slot < 0) return;
      const msg = data as GuestMessage;
      if (msg && msg.type === 'input') this.handlers.onInput?.(slot, msg.f);
    });
    const onLeave = () => {
      if (slot < 0 || this.conns.get(slot) !== conn) return;
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
    const ids = [0, ...[...this.conns.keys()].sort()];
    this.players = ids.map((id) => ({ id, name: `P${id + 1}` }));
  }

  private broadcastLobby(): void {
    this.broadcast({ type: 'lobby', players: this.players });
    this.handlers.onLobby?.(this.players);
  }

  broadcast(msg: HostMessage): void {
    for (const c of this.conns.values()) {
      if (c.open) c.send(msg);
    }
  }

  startGame(): void {
    this.inGame = true;
    this.broadcast({ type: 'start', players: this.players });
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

  async join(code: string): Promise<{ slot: number; players: LobbyPlayer[] }> {
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

      const conn = this.peer!.connect(ID_PREFIX + this.roomCode, {
        reliable: true,
        serialization: 'json',
      });
      this.hostConn = conn;
      let lastSnapAt = 0;

      conn.on('data', (data) => {
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
            this.players = msg.players;
            this.handlers.onStart?.(msg.players);
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
    if (this.hostConn?.open) this.hostConn.send({ type: 'input', f } satisfies GuestMessage);
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
    for (const c of this.conns.values()) c.close();
    this.conns.clear();
    this.hostConn?.close();
    this.hostConn = null;
    this.peer?.destroy();
    this.peer = null;
  }
}
