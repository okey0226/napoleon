// ============================================================
// worker/state.js
// 依存: なし
// 役割: 全モジュール共有の Map・キャッシュ・汎用ユーティリティ
// ============================================================

// ---------------- 共有 Map ----------------
export const queues = { ranked: [] };
export const rankedUsers = new Map();
export const conns = new Map();
export const friendRooms = new Map();
export const matches = new Map();
export const connMatch = new Map();

// ---------------- Bot 戦略キャッシュ ----------------
// { value: strategy | null, time: number } の形で 60 秒キャッシュ
export const botStrategyCache = { value: null, time: 0 };

// ---------------- JSON レスポンスヘルパー ----------------
export const response = (data, status = 200) => Response.json(data, { status });

// ---------------- 安全送信 ----------------
export function sendSafe(conn, message) {
  if (!conn) return false;
  try { conn.send(message); return true; }
  catch (error) {
    console.warn('room send failed', conn.id, error);
    try { conn.close(4004, 'Send failed'); } catch {}
    return false;
  }
}

// ---------------- 合言葉コード生成 ----------------
export function makeCode() {
  return Math.random().toString(36).slice(2, 7).toUpperCase();
}
