// ============================================================
// セーブデータ（このブラウザの localStorage に1つだけ）
//   ソロ・ホストのワールドを30秒ごとと終了時に保存し、タイトルの「続きから」で再開する。
//   全滅したら消える（やり直し）。保存できない環境では何もしない。
// ============================================================
import type { SaveData } from './Engine';

const KEY = 'deadnights2d.save';

export function loadSave(): SaveData | null {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return null;
    const d = JSON.parse(raw) as SaveData;
    return d && d.v === 1 && typeof d.seed === 'number' ? d : null;
  } catch {
    return null;
  }
}

export function writeSave(d: SaveData): boolean {
  try {
    localStorage.setItem(KEY, JSON.stringify(d));
    return true;
  } catch {
    return false;
  }
}

export function clearSave(): void {
  try {
    localStorage.removeItem(KEY);
  } catch {
    /* ignore */
  }
}

/** タイトルに出す要約（例：「DAY 4・3人・2時間前」） */
export function describeSave(d: SaveData): string {
  const mins = Math.max(0, Math.round((Date.now() - d.savedAt) / 60000));
  const ago = mins < 1 ? 'たった今' : mins < 60 ? `${mins}分前` : mins < 60 * 24 ? `${Math.round(mins / 60)}時間前` : `${Math.round(mins / 1440)}日前`;
  return `DAY ${d.day}・${d.players.length}人・${ago}`;
}
