// ============================================================
// worker.js
// 依存: ai-simulator.js, worker/state.js, worker/auth.js, worker/ai.js
// 役割: エントリポイント（schema / fetch ルーティング / scheduled / room 再エクスポート）
// ============================================================
import { runSelfPlayBatch } from './ai-simulator.js';
import { response, botStrategyCache } from './worker/state.js';
import { handleAuth, handleMe, handleRatingTop } from './worker/auth.js';
import {
  handleAiWeights, handleAiReport, handleAiRunSelfPlay,
  handleAiStrategies, handleAiInsights, handleAiGenerations, handleAiTopStrategy
} from './worker/ai.js';

// ---------------- DB スキーマ ----------------
export const schema = [
  "CREATE TABLE IF NOT EXISTS players (user_id TEXT PRIMARY KEY, username TEXT NOT NULL, player_id TEXT NOT NULL UNIQUE, salt TEXT NOT NULL, password_hash TEXT NOT NULL, rating INTEGER NOT NULL DEFAULT 1000, wins INTEGER NOT NULL DEFAULT 0, losses INTEGER NOT NULL DEFAULT 0, games INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)",
  "CREATE TABLE IF NOT EXISTS match_history (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id TEXT NOT NULL, username TEXT NOT NULL, result TEXT NOT NULL, delta INTEGER NOT NULL, rating_after INTEGER NOT NULL, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)",
  "CREATE TABLE IF NOT EXISTS player_stats (user_id TEXT PRIMARY KEY, exact_wins INTEGER NOT NULL DEFAULT 0, bold_exact_wins INTEGER NOT NULL DEFAULT 0, solo_wins INTEGER NOT NULL DEFAULT 0, dramatic_plays INTEGER NOT NULL DEFAULT 0)",
  "CREATE INDEX IF NOT EXISTS match_history_user ON match_history(user_id, id DESC)",
  "CREATE INDEX IF NOT EXISTS players_rating ON players(rating DESC)",
  "CREATE TABLE IF NOT EXISTS player_performance (user_id TEXT PRIMARY KEY, declarer_attempts INTEGER NOT NULL DEFAULT 0, declarer_successes INTEGER NOT NULL DEFAULT 0, deputy_attempts INTEGER NOT NULL DEFAULT 0, deputy_successes INTEGER NOT NULL DEFAULT 0)",
  "CREATE TABLE IF NOT EXISTS player_precision (user_id TEXT PRIMARY KEY, exact_attempts INTEGER NOT NULL DEFAULT 0, exact_successes INTEGER NOT NULL DEFAULT 0, solo_attempts INTEGER NOT NULL DEFAULT 0, solo_successes INTEGER NOT NULL DEFAULT 0)",
  "CREATE TABLE IF NOT EXISTS player_art_rate (user_id TEXT PRIMARY KEY, attempts INTEGER NOT NULL DEFAULT 0, plays INTEGER NOT NULL DEFAULT 0)",
  "CREATE TABLE IF NOT EXISTS player_ally_feed (user_id TEXT PRIMARY KEY, attempts INTEGER NOT NULL DEFAULT 0, successes INTEGER NOT NULL DEFAULT 0)",
  "CREATE TABLE IF NOT EXISTS player_bold_bid_rate (user_id TEXT PRIMARY KEY, attempts INTEGER NOT NULL DEFAULT 0, successes INTEGER NOT NULL DEFAULT 0)",
  "CREATE TABLE IF NOT EXISTS player_match_stats (user_id TEXT PRIMARY KEY, declarer_attempts INTEGER NOT NULL DEFAULT 0, bid_total INTEGER NOT NULL DEFAULT 0, nt_bids INTEGER NOT NULL DEFAULT 0, color_bids INTEGER NOT NULL DEFAULT 0, match_count INTEGER NOT NULL DEFAULT 0, rank_1 INTEGER NOT NULL DEFAULT 0, rank_2 INTEGER NOT NULL DEFAULT 0, rank_3 INTEGER NOT NULL DEFAULT 0, rank_4 INTEGER NOT NULL DEFAULT 0, rank_5 INTEGER NOT NULL DEFAULT 0)",
  "CREATE TABLE IF NOT EXISTS ai_weights (id INTEGER PRIMARY KEY DEFAULT 1, weights TEXT NOT NULL, games INTEGER NOT NULL DEFAULT 0, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)",
  "CREATE TABLE IF NOT EXISTS ai_strategy_log (id INTEGER PRIMARY KEY AUTOINCREMENT, generation INTEGER NOT NULL, params TEXT NOT NULL, nap_win_rate REAL NOT NULL DEFAULT 0, deputy_win_rate REAL NOT NULL DEFAULT 0, alliance_win_rate REAL NOT NULL DEFAULT 0, overall_win_rate REAL NOT NULL DEFAULT 0, avg_rating_delta REAL NOT NULL DEFAULT 0, matches INTEGER NOT NULL DEFAULT 0, avg_bid REAL NOT NULL DEFAULT 0, parent_id INTEGER, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)",
  "CREATE INDEX IF NOT EXISTS ai_strategy_gen ON ai_strategy_log(generation DESC, avg_rating_delta DESC)",
  "CREATE INDEX IF NOT EXISTS ai_strategy_rate ON ai_strategy_log(avg_rating_delta DESC)",
  "CREATE TABLE IF NOT EXISTS sessions (token TEXT PRIMARY KEY, user_id TEXT NOT NULL, expires_at INTEGER NOT NULL, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)",
  "CREATE INDEX IF NOT EXISTS sessions_user ON sessions(user_id)"
];

async function forceInitDB(env) {
  for (const sql of schema) {
    try { await env.DB.prepare(sql).run(); }
    catch (e) { console.error('SQL error:', e.message); }
  }
}

// ---------------- エントリポイント ----------------
export default {
  async scheduled(event, env, ctx) {
    if (!globalThis.__dbInitialized) {
      try { await forceInitDB(env); globalThis.__dbInitialized = true; }
      catch (e) { console.error('DB init failed on cron', e); }
    }
    ctx.waitUntil(runSelfPlayBatch(env, 1000).catch(e => console.error('scheduled self-play failed', e)));
    ctx.waitUntil(
      env.DB.prepare('DELETE FROM sessions WHERE expires_at<?')
        .bind(Date.now()).run()
        .catch(e => console.error('session cleanup failed', e))
    );
  },

  async fetch(request, env) {
    const url = new URL(request.url);

    // ---- DB 初期化 ----
    if (!globalThis.__dbInitialized) {
      try { await forceInitDB(env); globalThis.__dbInitialized = true; }
      catch (e) { console.error('DB init failed', e); }
    }

    // ---- setup-db ----
    if (request.method === 'GET' && url.pathname === '/api/setup-db') {
      try {
        await forceInitDB(env);
        if (url.searchParams.get('reset') === 'ai') {
          await env.DB.batch([
            env.DB.prepare('DELETE FROM ai_strategy_log'),
            env.DB.prepare('DELETE FROM ai_weights')
          ]);
          botStrategyCache.value = null;
          botStrategyCache.time = 0;
          return response({ ok: true, message: 'AI learning data reset successfully' });
        }
        return response({ ok: true, message: 'Database initialized successfully' });
      } catch (e) {
        console.error('setup-db error:', e.message, e.stack);
        return response({ error: e.message, stack: e.stack }, { status: 500 });
      }
    }

    try {
      // ---- 認証 ----
      if (request.method === 'POST'
        && (url.pathname === '/api/account/register' || url.pathname === '/api/account/login')) {
        return await handleAuth(request, env, url);
      }
      if (request.method === 'GET' && url.pathname === '/api/account/me') {
        return await handleMe(request, env);
      }
      if (request.method === 'GET' && url.pathname === '/api/rating/top') {
        return await handleRatingTop(request, env);
      }

      // ---- AI ----
      if (request.method === 'GET'  && url.pathname === '/api/ai/weights')      return await handleAiWeights(request, env);
      if (request.method === 'POST' && url.pathname === '/api/ai/report')       return await handleAiReport(request, env);
      if (request.method === 'POST' && url.pathname === '/api/ai/run-selfplay') return await handleAiRunSelfPlay(request, env);
      if (request.method === 'GET'  && url.pathname === '/api/ai/strategies')   return await handleAiStrategies(request, env, url);
      if (request.method === 'GET'  && url.pathname === '/api/ai/insights')     return await handleAiInsights(request, env);
      if (request.method === 'GET'  && url.pathname === '/api/ai/generations')  return await handleAiGenerations(request, env);
      if (request.method === 'GET'  && url.pathname === '/api/ai/top-strategy') return await handleAiTopStrategy(request, env);

      return new Response('Not found', { status: 404 });
    } catch (err) {
      return response({ error: 'Global API error: ' + err.message, stack: err.stack }, { status: 500 });
    }
  }
};

// ---------------- WebSocket Room（別ファイルから再エクスポート） ----------------
// 循環回避のため room はここで re-export するだけ。
export { room } from './worker/room.js';
