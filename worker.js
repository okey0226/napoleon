// ===== [worker.js 前半 開始] =====
// worker.js (MECE戦術エンジン統合版・不具合修正版)
// 修正⑦: /api/ai/learn /api/ai/report で tactic_id/situation_hash/intent_category/bid_tactic_id/same_two_risk をバインド
// 修正⑧: loadExperience で各テーブル個別 try/catch

import { SUITS, RANKS, SV, CALIBRATION, defaultStrategy, shuffledDeck, sortHand, sweetSpotFactor, estimatedWinRate, SWEET_SPOT_BONUS, findMaxHonestBid, matchRatingChanges, computeEloDelta, ELO_INIT, PARAM_BOUNDS, isSameColorSuit, sameColorSuitOf } from './constants.js';
import {
  winningEntry, cardPower, shouldBid, chooseDiscard, chooseDeputyCall, chooseCardWithMCTS, chooseDeputyCard,
  isTrump, strongestSuit, chooseSoloCall, handStrength, colorStrength, ntHandStrength,
  computeProperBid, bidPacing, canSendSignal, countSameColorBidders, detectPartnerSignal,
  isTwoRole, isThreeRole, getRoleCards, evaluateRiskTransfer,
  getStateHash, getSimilarityDistance, analyzeDiscardOptions,
  canDeclareWin,
  determineRole, decideNextBid, inferIntentFromBid, estimateDeputyDPoints,
  computeNScore, computeDScore, computeDPoints, computeSupportLimit
} from './ai-tactics.js';
import { runSelfPlayBatch, generateInsights } from './ai-simulator.js';
import { handleQuizRequest, quizSchema } from './quiz-api.js';

function safeJsonParse(str, fallback = null) {
  try { if (!str || typeof str !== 'string' || !str.trim()) return fallback; return JSON.parse(str); }
  catch (e) { console.warn('worker JSON parse failed:', e.message); return fallback; }
}

export const schema = [
  "CREATE TABLE IF NOT EXISTS players (user_id TEXT PRIMARY KEY, username TEXT NOT NULL, player_id TEXT NOT NULL UNIQUE, salt TEXT NOT NULL, password_hash TEXT NOT NULL, rating INTEGER NOT NULL DEFAULT 1000, wins INTEGER NOT NULL DEFAULT 0, losses INTEGER NOT NULL DEFAULT 0, games INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)",
  "CREATE TABLE IF NOT EXISTS match_history (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id TEXT NOT NULL, username TEXT NOT NULL, result TEXT NOT NULL, delta REAL NOT NULL, rating_after INTEGER NOT NULL, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)",
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
  "CREATE INDEX IF NOT EXISTS sessions_user ON sessions(user_id)",
  "CREATE TABLE IF NOT EXISTS player_elo (user_id TEXT PRIMARY KEY, elo INTEGER NOT NULL DEFAULT 1000)",
  "CREATE TABLE IF NOT EXISTS human_win_patterns (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id TEXT, player_id TEXT, rank INTEGER NOT NULL DEFAULT 0, won_as_nap INTEGER NOT NULL DEFAULT 0, won_as_deputy INTEGER NOT NULL DEFAULT 0, won_as_ally INTEGER NOT NULL DEFAULT 0, avg_bid REAL NOT NULL DEFAULT 0, exact_wins INTEGER NOT NULL DEFAULT 0, solo_wins INTEGER NOT NULL DEFAULT 0, match_rating_delta REAL NOT NULL DEFAULT 0, contracts_json TEXT, ai_weights_snapshot TEXT, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)",
  "CREATE INDEX IF NOT EXISTS human_win_delta ON human_win_patterns(match_rating_delta DESC)",
  "CREATE TABLE IF NOT EXISTS ai_bid_experience (id INTEGER PRIMARY KEY AUTOINCREMENT, strength_key REAL NOT NULL, trump_type TEXT NOT NULL, num INTEGER NOT NULL, wins INTEGER NOT NULL DEFAULT 0, samples INTEGER NOT NULL DEFAULT 0, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)",
  "CREATE UNIQUE INDEX IF NOT EXISTS ai_bid_exp_key ON ai_bid_experience(strength_key, trump_type, num)",
  "CREATE TABLE IF NOT EXISTS ai_call_experience (id INTEGER PRIMARY KEY AUTOINCREMENT, call_id TEXT NOT NULL, trump_suit TEXT NOT NULL, wins INTEGER NOT NULL DEFAULT 0, samples INTEGER NOT NULL DEFAULT 0, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)",
  "CREATE UNIQUE INDEX IF NOT EXISTS ai_call_exp_key ON ai_call_experience(call_id, trump_suit)",
  "CREATE TABLE IF NOT EXISTS ai_play_experience (id INTEGER PRIMARY KEY AUTOINCREMENT, role TEXT NOT NULL, phase TEXT NOT NULL, points_tier TEXT NOT NULL, rank_tier TEXT NOT NULL, wins INTEGER NOT NULL DEFAULT 0, samples INTEGER NOT NULL DEFAULT 0, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)",
  "CREATE UNIQUE INDEX IF NOT EXISTS ai_play_exp_key ON ai_play_experience(role, phase, points_tier, rank_tier)",
  "CREATE TABLE IF NOT EXISTS ai_state_experience (state_hash TEXT PRIMARY KEY, card_win_rates TEXT NOT NULL, samples INTEGER NOT NULL DEFAULT 0, generation INTEGER NOT NULL DEFAULT 1, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)",
  "CREATE INDEX IF NOT EXISTS ai_state_exp_gen ON ai_state_experience(generation DESC, samples DESC)",
  "CREATE TABLE IF NOT EXISTS ai_hall_of_fame (id INTEGER PRIMARY KEY AUTOINCREMENT, generation INTEGER NOT NULL, params TEXT NOT NULL, avg_rating_delta REAL NOT NULL DEFAULT 0, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)",
  "CREATE TABLE IF NOT EXISTS quiz_candidates (id TEXT PRIMARY KEY, category TEXT NOT NULL DEFAULT 'play', scenario_json TEXT NOT NULL, options_json TEXT NOT NULL, ai_answer_index INTEGER NOT NULL, reason TEXT NOT NULL, explanation TEXT, generation INTEGER, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)",
  "CREATE INDEX IF NOT EXISTS quiz_candidates_reason ON quiz_candidates(reason)",

  // MECE戦術エンジン用テーブル
  "CREATE TABLE IF NOT EXISTS ai_tactic_experience (id INTEGER PRIMARY KEY AUTOINCREMENT, tactic_id TEXT NOT NULL, situation_hash TEXT NOT NULL, wins INTEGER NOT NULL DEFAULT 0, samples INTEGER NOT NULL DEFAULT 0, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)",
  "CREATE UNIQUE INDEX IF NOT EXISTS ai_tactic_exp_key ON ai_tactic_experience(tactic_id, situation_hash)",
  "CREATE INDEX IF NOT EXISTS ai_tactic_exp_tactic ON ai_tactic_experience(tactic_id, wins DESC)",
  "CREATE TABLE IF NOT EXISTS ai_bid_tactic_experience (id INTEGER PRIMARY KEY AUTOINCREMENT, bid_tactic_id TEXT NOT NULL, situation_hash TEXT NOT NULL, wins INTEGER NOT NULL DEFAULT 0, samples INTEGER NOT NULL DEFAULT 0, same_two_risk REAL DEFAULT 0, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)",
  "CREATE UNIQUE INDEX IF NOT EXISTS ai_bid_tactic_exp_key ON ai_bid_tactic_experience(bid_tactic_id, situation_hash)",
  "CREATE TABLE IF NOT EXISTS ai_same_two_events (id INTEGER PRIMARY KEY AUTOINCREMENT, match_id TEXT NOT NULL, round INTEGER NOT NULL, trick_no INTEGER NOT NULL, holder_seat INTEGER NOT NULL, target_rank TEXT NOT NULL, target_suit TEXT NOT NULL, result TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)",
  "CREATE INDEX IF NOT EXISTS ai_same_two_match ON ai_same_two_events(match_id, round)",
  "CREATE INDEX IF NOT EXISTS ai_same_two_holder ON ai_same_two_events(holder_seat, result)",
  "CREATE TABLE IF NOT EXISTS ai_uncovered_situations (id INTEGER PRIMARY KEY AUTOINCREMENT, situation_hash TEXT NOT NULL, situation_json TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)",
  "CREATE UNIQUE INDEX IF NOT EXISTS ai_uncovered_hash ON ai_uncovered_situations(situation_hash)",
  "CREATE TABLE IF NOT EXISTS ai_tactic_history (id INTEGER PRIMARY KEY AUTOINCREMENT, match_id TEXT NOT NULL, round INTEGER NOT NULL, trick_no INTEGER NOT NULL, situation_hash TEXT NOT NULL, selected_tactic_id TEXT NOT NULL, ev REAL NOT NULL DEFAULT 0, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)",
  "CREATE INDEX IF NOT EXISTS ai_tactic_history_match ON ai_tactic_history(match_id, round, trick_no)",

  // カラム追加
  "ALTER TABLE players ADD COLUMN dorm_period INTEGER DEFAULT 310",
  "ALTER TABLE players ADD COLUMN favorite_song TEXT DEFAULT ''",
  "ALTER TABLE players ADD COLUMN career TEXT DEFAULT ''",
  "ALTER TABLE players ADD COLUMN scary_senior TEXT DEFAULT ''",
  "ALTER TABLE players ADD COLUMN infinite_food TEXT DEFAULT ''",
  "ALTER TABLE players ADD COLUMN favorite_standing TEXT DEFAULT ''",
  "ALTER TABLE players ADD COLUMN com_rating INTEGER DEFAULT 1000",
  "ALTER TABLE ai_strategy_log ADD COLUMN avg_plan_accuracy REAL DEFAULT 0",
  "ALTER TABLE ai_strategy_log ADD COLUMN avg_value_loss REAL DEFAULT 0",
  "ALTER TABLE ai_strategy_log ADD COLUMN value_loss_early REAL DEFAULT 0",
  "ALTER TABLE ai_strategy_log ADD COLUMN value_loss_mid REAL DEFAULT 0",
  "ALTER TABLE ai_strategy_log ADD COLUMN value_loss_late REAL DEFAULT 0",
  "ALTER TABLE ai_strategy_log ADD COLUMN value_loss_nt REAL DEFAULT 0",
  "ALTER TABLE ai_strategy_log ADD COLUMN value_loss_color REAL DEFAULT 0",
  "ALTER TABLE ai_strategy_log ADD COLUMN avg_bid_gap REAL DEFAULT 0",
  "ALTER TABLE ai_strategy_log ADD COLUMN bid_accuracy REAL DEFAULT 0",
  "ALTER TABLE ai_strategy_log ADD COLUMN deputy_signal_success_rate REAL DEFAULT 0",
  "ALTER TABLE ai_strategy_log ADD COLUMN avg_stage_count REAL DEFAULT 0",
  "ALTER TABLE ai_strategy_log ADD COLUMN role_accuracy REAL DEFAULT 0",

  // ★ 修正⑦: ai_play_experience に戦術列
  "ALTER TABLE ai_play_experience ADD COLUMN tactic_id TEXT DEFAULT 'UNKNOWN'",
  "ALTER TABLE ai_play_experience ADD COLUMN situation_hash TEXT DEFAULT ''",
  "ALTER TABLE ai_play_experience ADD COLUMN intent_category TEXT DEFAULT 'UNKNOWN'",
  // ★ 修正⑦: ai_bid_experience に競り戦術列
  "ALTER TABLE ai_bid_experience ADD COLUMN bid_tactic_id TEXT DEFAULT 'UNKNOWN'",
  "ALTER TABLE ai_bid_experience ADD COLUMN same_two_risk REAL DEFAULT 0",

  // COM戦専用
  "CREATE TABLE IF NOT EXISTS player_com_match_history (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id TEXT NOT NULL, username TEXT NOT NULL, result TEXT NOT NULL, delta REAL NOT NULL, rating_after REAL NOT NULL, placement INTEGER NOT NULL, tie_json TEXT, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)",
  "CREATE INDEX IF NOT EXISTS player_com_match_history_user ON player_com_match_history(user_id, id DESC)",
  "CREATE TABLE IF NOT EXISTS player_com_performance (user_id TEXT PRIMARY KEY, declarer_attempts INTEGER NOT NULL DEFAULT 0, declarer_successes INTEGER NOT NULL DEFAULT 0, deputy_attempts INTEGER NOT NULL DEFAULT 0, deputy_successes INTEGER NOT NULL DEFAULT 0)",
  "CREATE TABLE IF NOT EXISTS player_com_precision (user_id TEXT PRIMARY KEY, exact_attempts INTEGER NOT NULL DEFAULT 0, exact_successes INTEGER NOT NULL DEFAULT 0, solo_attempts INTEGER NOT NULL DEFAULT 0, solo_successes INTEGER NOT NULL DEFAULT 0)",
  "CREATE TABLE IF NOT EXISTS player_com_ally_feed (user_id TEXT PRIMARY KEY, attempts INTEGER NOT NULL DEFAULT 0, successes INTEGER NOT NULL DEFAULT 0)",
  "CREATE TABLE IF NOT EXISTS player_com_bold_bid_rate (user_id TEXT PRIMARY KEY, attempts INTEGER NOT NULL DEFAULT 0, successes INTEGER NOT NULL DEFAULT 0)",
  "CREATE TABLE IF NOT EXISTS player_com_match_stats (user_id TEXT PRIMARY KEY, declarer_attempts INTEGER NOT NULL DEFAULT 0, bid_total INTEGER NOT NULL DEFAULT 0, nt_bids INTEGER NOT NULL DEFAULT 0, color_bids INTEGER NOT NULL DEFAULT 0, match_count INTEGER NOT NULL DEFAULT 0, rank_1 INTEGER NOT NULL DEFAULT 0, rank_2 INTEGER NOT NULL DEFAULT 0, rank_3 INTEGER NOT NULL DEFAULT 0, rank_4 INTEGER NOT NULL DEFAULT 0, rank_5 INTEGER NOT NULL DEFAULT 0, streak_current INTEGER NOT NULL DEFAULT 0, streak_best INTEGER NOT NULL DEFAULT 0)",

  // NAPプランラボ
  "CREATE TABLE IF NOT EXISTS nap_lab_sessions (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id TEXT, seed INTEGER, record_json TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)",
  "CREATE INDEX IF NOT EXISTS nap_lab_sessions_user ON nap_lab_sessions(user_id, id DESC)",

  ...quizSchema
];

const queues = { ranked: [] }, rankedUsers = new Map(), conns = new Map(), friendRooms = new Map(), matches = new Map(), connMatch = new Map();

function broadcastQueueStatus() {
  const text = "対戦相手を検索中 · " + queues.ranked.length + "/5人";
  for (const x of queues.ranked) sendSafe(x.conn, { type: "lobby", text });
}

let __cachedBotStrategy = null, __cachedBotStrategyTime = 0;
async function loadBotStrategy(env) {
  if (__cachedBotStrategy && Date.now() - __cachedBotStrategyTime < 60000) return __cachedBotStrategy;
  try {
    const w = await env.DB.prepare("SELECT weights FROM ai_weights WHERE id=1").first();
    if (w?.weights) {
      const parsed = safeJsonParse(w.weights, null);
      if (parsed && typeof parsed === 'object') { __cachedBotStrategy = { ...defaultStrategy(), ...parsed }; __cachedBotStrategyTime = Date.now(); return __cachedBotStrategy; }
    }
  } catch (e) { console.warn("bot strategy load failed", e); }
  return defaultStrategy();
}

// ★ 修正⑧: 各テーブルを個別に try/catch（テーブル不在でも全体が壊れない）
let __cachedExperience = null, __cachedExperienceTime = 0;
async function loadExperience(env) {
  if (__cachedExperience && Date.now() - __cachedExperienceTime < 60000) return __cachedExperience;
  const map = { bids: {}, calls: {}, plays: {}, stateCache: {}, tactics: {} };

  try {
    const { results } = await env.DB.prepare("SELECT strength_key, trump_type, num, wins, samples FROM ai_bid_experience WHERE samples > 0").all();
    for (const r of (results || [])) map.bids[`${r.strength_key}:${r.trump_type}:${r.num}`] = { wins: r.wins, samples: r.samples };
  } catch (e) { console.warn("ai_bid_experience load failed (may not exist)", e.message); }

  try {
    const { results } = await env.DB.prepare("SELECT call_id, trump_suit, wins, samples FROM ai_call_experience WHERE samples > 0").all();
    for (const r of (results || [])) map.calls[`${r.call_id}:${r.trump_suit}`] = { wins: r.wins, samples: r.samples };
  } catch (e) { console.warn("ai_call_experience load failed", e.message); }

  try {
    const { results } = await env.DB.prepare("SELECT role, phase, points_tier, rank_tier, wins, samples FROM ai_play_experience WHERE samples > 0").all();
    for (const r of (results || [])) map.plays[`${r.role}:${r.phase}:${r.points_tier}:${r.rank_tier}`] = { wins: r.wins, samples: r.samples };
  } catch (e) { console.warn("ai_play_experience load failed", e.message); }

  try {
    const { results } = await env.DB.prepare("SELECT state_hash, card_win_rates, samples FROM ai_state_experience ORDER BY updated_at DESC LIMIT 2000").all();
    for (const r of (results || [])) map.stateCache[r.state_hash] = { card_win_rates: r.card_win_rates, samples: r.samples };
  } catch (e) { console.warn("ai_state_experience load failed", e.message); }

  try {
    const { results } = await env.DB.prepare("SELECT tactic_id, situation_hash, wins, samples FROM ai_tactic_experience WHERE samples > 0 ORDER BY updated_at DESC LIMIT 5000").all();
    for (const r of (results || [])) map.tactics[`${r.tactic_id}:${r.situation_hash}`] = { wins: r.wins, samples: r.samples };
  } catch (e) { console.warn("ai_tactic_experience load failed (may not exist in old DB)", e.message); }

  __cachedExperience = map;
  __cachedExperienceTime = Date.now();
  return map;
}

function sendSafe(conn, message) { if (!conn) return false; try { conn.send(message); return true; } catch (error) { console.warn("room send failed", conn.id, error); try { conn.close(4004, "Send failed"); } catch { } return false; } }
const hex = b => Array.from(new Uint8Array(b), x => x.toString(16).padStart(2, "0")).join("");
const unhex = s => new Uint8Array((s.match(/.{2}/g) || []).map(x => parseInt(x, 16)));
async function hashPassword(password, salt) { const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(password), "PBKDF2", false, ["deriveBits"]); return hex(await crypto.subtle.deriveBits({ name: "PBKDF2", salt, iterations: 100000, hash: "SHA-256" }, key, 256)); }
const response = (data, status = 200) => Response.json(data, { status });
const identity = req => ({ id: req.headers.get("x-websim-user-id"), username: req.headers.get("x-websim-username") || "player", anonymous: req.headers.get("x-websim-user-is-anonymous") === "true" });
const validId = s => typeof s === "string" && /^[a-zA-Z0-9_-]{3,20}$/.test(s);
const signed = req => { const u = identity(req); return u.id && !u.anonymous ? u : null; };
function metricRank(db, table, successColumn, attemptColumn, successes, attempts) { if (!attempts) return Promise.resolve(null); return db.prepare("SELECT COUNT(*) AS ahead FROM " + table + " WHERE " + attemptColumn + ">0 AND " + successColumn + "*1.0/" + attemptColumn + ">?").bind(successes / attempts).first().then(row => row.ahead + 1); }

async function forceInitDB(env) {
  for (const sql of schema) { try { await env.DB.prepare(sql).run(); } catch (e) { console.error("SQL error:", e.message); } }
}

async function getUserIdByToken(env, token) {
  if (!token) return null;
  try {
    const sess = await env.DB.prepare("SELECT user_id FROM sessions WHERE token=? AND expires_at>?").bind(token, Date.now()).first();
    return sess?.user_id || null;
  } catch { return null; }
}

export default {
  async scheduled(event, env, ctx) {
    if (!globalThis.__dbInitialized) { try { await forceInitDB(env); globalThis.__dbInitialized = true; } catch (e) { console.error("DB init failed on cron", e); } }
    ctx.waitUntil(runSelfPlayBatch(env, 10).catch(e => console.error("scheduled self-play failed", e)));
    ctx.waitUntil(env.DB.prepare("DELETE FROM sessions WHERE expires_at<?").bind(Date.now()).run().catch(e => console.error("session cleanup failed", e)));
  },
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === "GET" && url.pathname === "/api/dev/run-selfplay") {
      try {
        await forceInitDB(env);
        const result = await runSelfPlayBatch(env, 1);
        return response({ ok: true, message: "Self-play executed", result });
      } catch (e) {
        return response({ error: e.message, stack: e.stack }, { status: 500 });
      }
    }

    if (request.method === "GET" && url.pathname === "/api/setup-db") {
      try {
        await forceInitDB(env);
        if (url.searchParams.get("reset") === "ai") {
          await env.DB.batch([
            env.DB.prepare("DELETE FROM ai_strategy_log"),
            env.DB.prepare("DELETE FROM ai_weights"),
            env.DB.prepare("DELETE FROM ai_bid_experience"),
            env.DB.prepare("DELETE FROM ai_call_experience"),
            env.DB.prepare("DELETE FROM ai_play_experience"),
            env.DB.prepare("DELETE FROM ai_state_experience"),
            env.DB.prepare("DELETE FROM ai_hall_of_fame"),
            env.DB.prepare("DELETE FROM quiz_candidates"),
            env.DB.prepare("DELETE FROM ai_discard_metrics"),
            env.DB.prepare("DELETE FROM ai_tactic_experience"),
            env.DB.prepare("DELETE FROM ai_bid_tactic_experience"),
            env.DB.prepare("DELETE FROM ai_same_two_events"),
            env.DB.prepare("DELETE FROM ai_uncovered_situations"),
            env.DB.prepare("DELETE FROM ai_tactic_history")
          ]);
          __cachedBotStrategy = null; __cachedBotStrategyTime = 0;
          __cachedExperience = null; __cachedExperienceTime = 0;
          return response({ ok: true, message: "AI learning data reset successfully" });
        }
        return response({ ok: true, message: "Database initialized successfully" });
      } catch (e) { console.error("setup-db error:", e.message, e.stack); return response({ error: e.message, stack: e.stack }, { status: 500 }); }
    }
    if (!globalThis.__dbInitialized) { try { await forceInitDB(env); globalThis.__dbInitialized = true; } catch (e) { console.error("DB init failed", e); } }

    try {
      if (url.pathname.startsWith('/api/quiz/')) {
        const quizRes = await handleQuizRequest(request, env, url);
        if (quizRes) return quizRes;
        return response({ error: 'not found' }, { status: 404 });
      }

      // ============================================================
      // NAPプランラボ セッション保存 & AI学習反映
      // ============================================================
      if (request.method === "POST" && url.pathname === "/api/nap-lab/save") {
        const token = request.headers.get("x-session-token");
        const userId = token ? await getUserIdByToken(env, token) : null;
        if (!userId) return response({ error: "auth required" }, { status: 401 });

        let body;
        try { body = await request.json(); } catch { return response({ error: "invalid" }, { status: 400 }); }
        try {
          await env.DB.prepare("INSERT INTO nap_lab_sessions(user_id, seed, record_json) VALUES(?,?,?)")
            .bind(userId, Number(body.seed) || 0, JSON.stringify(body)).run();

          const statements = [];
          const stateExperiences = body.stateExperiences || [];
          for (const exp of stateExperiences) {
            if (!exp.hash || !exp.rates) continue;
            statements.push(
              env.DB.prepare(
                `INSERT INTO ai_state_experience(state_hash, card_win_rates, samples, generation, updated_at) 
                 VALUES(?,?,?,?,CURRENT_TIMESTAMP) 
                 ON CONFLICT(state_hash) DO UPDATE SET 
                   card_win_rates = excluded.card_win_rates,
                   samples = samples + excluded.samples,
                   generation = MAX(generation, excluded.generation),
                   updated_at = CURRENT_TIMESTAMP`
              ).bind(exp.hash, exp.rates, Number(exp.samples) || 1, 1)
            );
          }

          const playDecisions = body.playDecisions || [];
          if (playDecisions.length > 0) {
            const agg = {};
            for (const d of playDecisions) {
              if (d.won === null || d.won === undefined) continue;
              if (!d.role || !d.phase || !d.pointsTier || !d.rankTier) continue;
              const key = `${d.role}:${d.phase}:${d.pointsTier}:${d.rankTier}`;
              if (!agg[key]) agg[key] = { role: d.role, phase: d.phase, pointsTier: d.pointsTier, rankTier: d.rankTier, wins: 0, total: 0, tacticId: 'UNKNOWN', situationHash: '', intentCategory: 'UNKNOWN' };
              agg[key].wins += d.won ? 1 : 0;
              agg[key].total += 1;
              if (d.tacticId && d.tacticId !== 'UNKNOWN') agg[key].tacticId = d.tacticId;
              if (d.situationHash) agg[key].situationHash = d.situationHash;
              if (d.intentCategory) agg[key].intentCategory = d.intentCategory;
            }
            for (const k of Object.keys(agg)) {
              const a = agg[k];
              statements.push(
                env.DB.prepare(
                  "INSERT INTO ai_play_experience(role,phase,points_tier,rank_tier,wins,samples,tactic_id,situation_hash,intent_category) VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(role,phase,points_tier,rank_tier) DO UPDATE SET wins=wins+excluded.wins,samples=samples+excluded.samples,tactic_id=CASE WHEN excluded.tactic_id!='UNKNOWN' THEN excluded.tactic_id ELSE tactic_id END,situation_hash=CASE WHEN excluded.situation_hash!='' THEN excluded.situation_hash ELSE situation_hash END,intent_category=CASE WHEN excluded.intent_category!='UNKNOWN' THEN excluded.intent_category ELSE intent_category END,updated_at=CURRENT_TIMESTAMP"
                ).bind(a.role, a.phase, a.pointsTier, a.rankTier, a.wins, a.total, a.tacticId, a.situationHash, a.intentCategory)
              );
            }
          }

          if (statements.length > 0) {
            await env.DB.batch(statements);
            __cachedExperience = null;
            __cachedExperienceTime = 0;
          }

          return response({ ok: true, learnedStates: stateExperiences.length, learnedPlays: playDecisions.length });
        } catch (e) {
          console.error("nap-lab save failed", e);
          return response({ error: e.message }, { status: 500 });
        }
      }

      if (request.method === "GET" && url.pathname === "/api/nap-lab/learning-stats") {
        const token = request.headers.get("x-session-token");
        const userId = token ? await getUserIdByToken(env, token) : null;
        if (!userId) return response({ error: "auth required" }, { status: 401 });
        try {
          const { results } = await env.DB.prepare("SELECT record_json FROM nap_lab_sessions WHERE user_id=? ORDER BY id DESC LIMIT 100").bind(userId).all();
          let approved = 0, revised = 0;
          for (const row of (results || [])) {
            try {
              const record = JSON.parse(row.record_json);
              if (record.verdict === 'APPROVED') approved++;
              else if (record.verdict === 'REVISED') revised++;
            } catch {}
          }
          return response({ approved, revised, total: approved + revised });
        } catch (e) { return response({ error: e.message }, { status: 500 }); }
      }

      // ============================================================
      // 戦術経験 API
      // ============================================================
      if (request.method === "GET" && url.pathname === "/api/ai/tactic-experience") {
        try {
          const tacticId = url.searchParams.get("tacticId");
          if (tacticId) {
            const { results } = await env.DB.prepare("SELECT * FROM ai_tactic_experience WHERE tactic_id=? ORDER BY samples DESC LIMIT 100").bind(tacticId).all();
            return response(results || []);
          }
          const { results } = await env.DB.prepare("SELECT tactic_id, SUM(wins) AS wins, SUM(samples) AS samples FROM ai_tactic_experience GROUP BY tactic_id ORDER BY samples DESC LIMIT 200").all();
          return response(results || []);
        } catch (e) { return response({ error: e.message }, { status: 500 }); }
      }

      if (request.method === "GET" && url.pathname === "/api/ai/tactic-stats") {
        try {
          const { results } = await env.DB.prepare(
            `SELECT tactic_id, SUM(wins) AS wins, SUM(samples) AS samples, (SUM(wins) * 1.0 / MAX(SUM(samples), 1)) AS win_rate
             FROM ai_tactic_experience WHERE samples >= 5 GROUP BY tactic_id ORDER BY win_rate DESC, samples DESC LIMIT 200`
          ).all();
          return response(results || []);
        } catch (e) { return response({ error: e.message }, { status: 500 }); }
      }

      if (request.method === "GET" && url.pathname === "/api/ai/same-two-events") {
        try {
          const matchId = url.searchParams.get("matchId");
          if (matchId) {
            const { results } = await env.DB.prepare("SELECT * FROM ai_same_two_events WHERE match_id=? ORDER BY round, trick_no").bind(matchId).all();
            return response(results || []);
          }
          const { results } = await env.DB.prepare(
            `SELECT target_rank, target_suit, result, COUNT(*) AS count FROM ai_same_two_events GROUP BY target_rank, target_suit, result ORDER BY count DESC`
          ).all();
          return response(results || []);
        } catch (e) { return response({ error: e.message }, { status: 500 }); }
      }

      if (request.method === "GET" && url.pathname === "/api/ai/uncovered-situations") {
        try {
          const limit = parseInt(url.searchParams.get("limit")) || 50;
          const { results } = await env.DB.prepare("SELECT * FROM ai_uncovered_situations ORDER BY created_at DESC LIMIT ?").bind(limit).all();
          return response(results || []);
        } catch (e) { return response({ error: e.message }, { status: 500 }); }
      }

      if (request.method === "GET" && url.pathname === "/api/ai/tactic-history") {
        try {
          const matchId = url.searchParams.get("matchId");
          if (!matchId) return response({ error: 'matchId required' }, { status: 400 });
          const { results } = await env.DB.prepare("SELECT * FROM ai_tactic_history WHERE match_id=? ORDER BY round, trick_no").bind(matchId).all();
          return response(results || []);
        } catch (e) { return response({ error: e.message }, { status: 500 }); }
      }

      // ============================================================
      // アカウント登録・ログイン
      // ============================================================
      if (request.method === "POST" && (url.pathname === "/api/account/register" || url.pathname === "/api/account/login")) {
        let body; try { body = await request.json(); } catch { return response({ error: "入力を確認してください" }, 400); }
        const id = String(body.id || "").trim(), pass = String(body.password || "");
        if (!validId(id)) return response({ error: "IDは英数字・_・-の3〜20文字です" }, 400);
        if (pass.length < 8 || pass.length > 128) return response({ error: "パスワードは8〜128文字です" }, 400);
        const isRegister = url.pathname.endsWith("register");
        let userId = null;
        if (isRegister) {
          userId = crypto.randomUUID();
          const salt = crypto.getRandomValues(new Uint8Array(16)), digest = await hashPassword(pass, salt);
          const dormPeriod = Number(body.dormPeriod) || 310;
          const favoriteSong = String(body.favoriteSong || "").slice(0, 100);
          const career = String(body.career || "").slice(0, 200);
          const scarySenior = String(body.scarySenior || "").slice(0, 50);
          const infiniteFood = String(body.infiniteFood || "").slice(0, 100);
          const favoriteStanding = String(body.favoriteStanding || "").slice(0, 50);
          try {
            await env.DB.prepare("INSERT INTO players(user_id,username,player_id,salt,password_hash,dorm_period,favorite_song,career,scary_senior,infinite_food,favorite_standing,com_rating) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)")
              .bind(userId, id, id, hex(salt), digest, dormPeriod, favoriteSong, career, scarySenior, infiniteFood, favoriteStanding, 1000).run();
          } catch { return response({ error: "そのIDはすでに使われています" }, 409); }
        } else {
          const p = await env.DB.prepare("SELECT user_id,salt,password_hash FROM players WHERE player_id=?").bind(id).first();
          if (!p || await hashPassword(pass, unhex(p.salt)) !== p.password_hash) return response({ error: "IDまたはパスワードが違います" }, 401);
          userId = p.user_id;
        }
        await env.DB.batch([
          env.DB.prepare("INSERT OR IGNORE INTO player_stats(user_id) VALUES(?)").bind(userId),
          env.DB.prepare("INSERT OR IGNORE INTO player_performance(user_id) VALUES(?)").bind(userId),
          env.DB.prepare("INSERT OR IGNORE INTO player_precision(user_id) VALUES(?)").bind(userId),
          env.DB.prepare("INSERT OR IGNORE INTO player_art_rate(user_id) VALUES(?)").bind(userId),
          env.DB.prepare("INSERT OR IGNORE INTO player_ally_feed(user_id) VALUES(?)").bind(userId),
          env.DB.prepare("INSERT OR IGNORE INTO player_bold_bid_rate(user_id) VALUES(?)").bind(userId),
          env.DB.prepare("INSERT OR IGNORE INTO player_elo(user_id) VALUES(?)").bind(userId),
          env.DB.prepare("INSERT OR IGNORE INTO player_com_performance(user_id) VALUES(?)").bind(userId),
          env.DB.prepare("INSERT OR IGNORE INTO player_com_precision(user_id) VALUES(?)").bind(userId),
          env.DB.prepare("INSERT OR IGNORE INTO player_com_ally_feed(user_id) VALUES(?)").bind(userId),
          env.DB.prepare("INSERT OR IGNORE INTO player_com_bold_bid_rate(user_id) VALUES(?)").bind(userId),
          env.DB.prepare("INSERT OR IGNORE INTO player_com_match_stats(user_id) VALUES(?)").bind(userId)
        ]);
        const token = hex(crypto.getRandomValues(new Uint8Array(32)));
        const expiresAt = Date.now() + 30 * 24 * 3600 * 1000;
        await env.DB.prepare("INSERT INTO sessions(token,user_id,expires_at) VALUES(?,?,?)").bind(token, userId, expiresAt).run();
        const player = await env.DB.prepare("SELECT player_id AS id,rating,wins,losses,games,dorm_period,favorite_song,career,scary_senior,infinite_food,favorite_standing,com_rating FROM players WHERE user_id=?").bind(userId).first();
        return response({ ...player, sessionToken: token });
      }

      if (request.method === "POST" && url.pathname === "/api/account/update-dorm") {
        const token = request.headers.get("x-session-token");
        const userId = await getUserIdByToken(env, token);
        if (!userId) return response({ error: "認証情報が必要です" }, 401);
        let body; try { body = await request.json(); } catch { return response({ error: "invalid" }, 400); }
        try {
          await env.DB.prepare("UPDATE players SET dorm_period=?, favorite_song=?, career=?, scary_senior=?, infinite_food=?, favorite_standing=? WHERE user_id=?")
            .bind(Number(body.dormPeriod) || 310, String(body.favoriteSong || "").slice(0, 100), String(body.career || "").slice(0, 200), String(body.scarySenior || "").slice(0, 50), String(body.infiniteFood || "").slice(0, 100), String(body.favoriteStanding || "").slice(0, 50), userId).run();
          return response({ ok: true });
        } catch (e) { return response({ error: e.message }, 500); }
      }

      if (request.method === "POST" && url.pathname === "/api/account/update-com-rating") {
        const token = request.headers.get("x-session-token");
        const userId = await getUserIdByToken(env, token);
        if (!userId) return response({ error: "認証情報が必要です" }, 401);
        let body; try { body = await request.json(); } catch { return response({ error: "invalid" }, 400); }
        const newComRating = Number(body.comRating);
        if (Number.isFinite(newComRating)) {
          try {
            await env.DB.prepare("UPDATE players SET com_rating=? WHERE user_id=?").bind(newComRating, userId).run();
            return response({ ok: true, comRating: newComRating });
          } catch (e) { return response({ error: e.message }, 500); }
        }
        return response({ error: "invalid" }, 400);
      }

      if (request.method === "GET" && url.pathname === "/api/account/me") {
        const token = request.headers.get("x-session-token");
        let userId = await getUserIdByToken(env, token);
        if (!userId) { const who = signed(request); if (who) userId = who.id; }
        if (!userId) return response({ error: "認証情報が必要です" }, 401);
        const p = await env.DB.prepare("SELECT player_id AS id,username,rating,wins,losses,games,dorm_period,favorite_song,career,scary_senior,infinite_food,favorite_standing,com_rating FROM players WHERE user_id=?").bind(userId).first();
        if (!p) return response({ error: "プレイヤー登録がありません" }, 404);
        const [performanceRow, precisionRow, artRateRow, allyFeedRow, boldBidRow, historyPage, matchStatsRow] = await Promise.all([
          env.DB.prepare("SELECT declarer_attempts,declarer_successes,deputy_attempts,deputy_successes FROM player_performance WHERE user_id=?").bind(userId).first(),
          env.DB.prepare("SELECT exact_attempts,exact_successes,solo_attempts,solo_successes FROM player_precision WHERE user_id=?").bind(userId).first(),
          env.DB.prepare("SELECT attempts,plays FROM player_art_rate WHERE user_id=?").bind(userId).first(),
          env.DB.prepare("SELECT attempts,successes FROM player_ally_feed WHERE user_id=?").bind(userId).first(),
          env.DB.prepare("SELECT attempts,successes FROM player_bold_bid_rate WHERE user_id=?").bind(userId).first(),
          env.DB.prepare("SELECT result,delta,rating_after,created_at FROM match_history WHERE user_id=? ORDER BY id DESC LIMIT 50").bind(userId).all(),
          env.DB.prepare("SELECT declarer_attempts,bid_total,nt_bids,color_bids,match_count,rank_1,rank_2,rank_3,rank_4,rank_5 FROM player_match_stats WHERE user_id=?").bind(userId).first()
        ]);
        const matchStats = matchStatsRow || { declarer_attempts: 0, bid_total: 0, nt_bids: 0, color_bids: 0, match_count: 0, rank_1: 0, rank_2: 0, rank_3: 0, rank_4: 0, rank_5: 0 };
        const performance = performanceRow || { declarer_attempts: 0, declarer_successes: 0, deputy_attempts: 0, deputy_successes: 0 };
        const precision = precisionRow || { exact_attempts: 0, exact_successes: 0, solo_attempts: 0, solo_successes: 0 };
        const artRate = artRateRow || { attempts: 0, plays: 0 };
        const allyFeed = allyFeedRow || { attempts: 0, successes: 0 };
        const boldBid = boldBidRow || { attempts: 0, successes: 0 };
        const [ratingRank, performanceRankValues] = await Promise.all([
          env.DB.prepare("SELECT COUNT(*) AS ahead FROM players WHERE rating>?").bind(p.rating).first(),
          Promise.all([
            metricRank(env.DB, "player_performance", "declarer_successes", "declarer_attempts", performance.declarer_successes, performance.declarer_attempts),
            metricRank(env.DB, "player_performance", "deputy_successes", "deputy_attempts", performance.deputy_successes, performance.deputy_attempts),
            metricRank(env.DB, "player_precision", "exact_successes", "exact_attempts", precision.exact_successes, precision.exact_attempts),
            metricRank(env.DB, "player_precision", "solo_successes", "solo_attempts", precision.solo_successes, precision.solo_attempts),
            metricRank(env.DB, "player_art_rate", "plays", "attempts", artRate.plays, artRate.attempts),
            metricRank(env.DB, "player_ally_feed", "successes", "attempts", allyFeed.successes, allyFeed.attempts),
            metricRank(env.DB, "player_bold_bid_rate", "successes", "attempts", boldBid.successes, boldBid.attempts)
          ])
        ]);
        const performanceRanks = { bid: performanceRankValues[0], deputy: performanceRankValues[1], exact: performanceRankValues[2], solo: performanceRankValues[3], artPlay: performanceRankValues[4], allyFeed: performanceRankValues[5], boldBid: performanceRankValues[6] };
        return response({ ...p, internalUserId: userId, performance, precision, artRate, allyFeed, boldBid, ranks: { rating: ratingRank.ahead + 1 }, performanceRanks, matchStats, history: historyPage.results });
      }

      if (request.method === "POST" && url.pathname === "/api/match/finish") {
        let body; try { body = await request.json(); } catch { return response({ error: 'invalid' }, 400); }
        const { matchId, seats } = body;
        if (!Array.isArray(seats) || !seats.length) return response({ error: 'no seats' }, 400);
        const verified = [];
        for (const s of seats) {
          const delta = Number(s.delta);
          const placement = Number(s.placement);
          if (!Number.isFinite(delta) || delta < -100 || delta > 100) continue;
          if (!Number.isInteger(placement) || placement < 1 || placement > 5) continue;
          if (!s.sessionToken || !s.userId) continue;
          const sess = await env.DB.prepare("SELECT user_id FROM sessions WHERE token=? AND expires_at>?").bind(s.sessionToken, Date.now()).first();
          if (!sess || sess.user_id !== s.userId) continue;
          verified.push({ ...s, delta, placement });
        }
        if (!verified.length) return response({ error: 'no valid sessions' }, 401);
        const statements = [];
        const updates = [];
        try {
          const userIds = verified.map(v => v.userId);
          const ph = userIds.map(() => '?').join(',');
          const profRes = await env.DB.prepare("SELECT user_id,username,rating FROM players WHERE user_id IN (" + ph + ")").bind(...userIds).all();
          const byId = new Map(profRes.results.map(r => [r.user_id, r]));
          for (const v of verified) {
            const profile = byId.get(v.userId);
            if (!profile) continue;
            const newRating = Math.max(100, Math.round((Number(profile.rating) || 1000) + v.delta));
            const roundedDelta = Math.round(v.delta * 10) / 10;
            const outcome = v.outcome || 'loss';
            const stat = v.stats || {};
            statements.push(
              env.DB.prepare("UPDATE players SET rating=?, wins=wins+?, losses=losses+?, games=games+1 WHERE user_id=?").bind(newRating, outcome === 'win' ? 1 : 0, outcome === 'loss' ? 1 : 0, v.userId),
              env.DB.prepare("INSERT INTO match_history(user_id,username,result,delta,rating_after) VALUES(?,?,?,?,?)").bind(v.userId, profile.username, outcome, roundedDelta, newRating),
              env.DB.prepare("INSERT OR IGNORE INTO player_stats(user_id) VALUES(?)").bind(v.userId),
              env.DB.prepare("UPDATE player_stats SET exact_wins=exact_wins+?,bold_exact_wins=bold_exact_wins+?,solo_wins=solo_wins+?,dramatic_plays=dramatic_plays+? WHERE user_id=?").bind(stat.exactWins || 0, stat.boldExactWins || 0, stat.soloWins || 0, stat.dramaticPlays || 0, v.userId),
              env.DB.prepare("INSERT INTO player_performance(user_id,declarer_attempts,declarer_successes,deputy_attempts,deputy_successes) VALUES(?,?,?,?,?) ON CONFLICT(user_id) DO UPDATE SET declarer_attempts=declarer_attempts+excluded.declarer_attempts,declarer_successes=declarer_successes+excluded.declarer_successes,deputy_attempts=deputy_attempts+excluded.deputy_attempts,deputy_successes=deputy_successes+excluded.deputy_successes").bind(v.userId, stat.declarerAttempts || 0, stat.declarerSuccesses || 0, stat.deputyAttempts || 0, stat.deputySuccesses || 0),
              env.DB.prepare("INSERT INTO player_precision(user_id,exact_attempts,exact_successes,solo_attempts,solo_successes) VALUES(?,?,?,?,?) ON CONFLICT(user_id) DO UPDATE SET exact_attempts=exact_attempts+excluded.exact_attempts,exact_successes=exact_successes+excluded.exact_successes,solo_attempts=solo_attempts+excluded.solo_attempts,solo_successes=solo_successes+excluded.solo_successes").bind(v.userId, stat.exactAttempts || 0, stat.exactSuccesses || 0, stat.soloAttempts || 0, stat.soloSuccesses || 0),
              env.DB.prepare("INSERT INTO player_match_stats(user_id,declarer_attempts,bid_total,nt_bids,color_bids,match_count,rank_1,rank_2,rank_3,rank_4,rank_5) VALUES(?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(user_id) DO UPDATE SET declarer_attempts=declarer_attempts+excluded.declarer_attempts,bid_total=bid_total+excluded.bid_total,nt_bids=nt_bids+excluded.nt_bids,color_bids=color_bids+excluded.color_bids,match_count=match_count+1,rank_1=rank_1+excluded.rank_1,rank_2=rank_2+excluded.rank_2,rank_3=rank_3+excluded.rank_3,rank_4=rank_4+excluded.rank_4,rank_5=rank_5+excluded.rank_5").bind(v.userId, stat.declarerAttempts || 0, stat.bidTotal || 0, stat.ntBids || 0, stat.colorBids || 0, 1, v.placement === 1 ? 1 : 0, v.placement === 2 ? 1 : 0, v.placement === 3 ? 1 : 0, v.placement === 4 ? 1 : 0, v.placement === 5 ? 1 : 0)
            );
            updates.push({ userId: v.userId, rating: newRating, delta: roundedDelta, outcome, placement: v.placement });
          }
          if (statements.length) await env.DB.batch(statements);
          return response({ ok: true, matchId, updates });
        } catch (e) {
          console.error('match finish save failed', e);
          return response({ error: e.message }, 500);
        }
      }

      if (request.method === "POST" && url.pathname === "/api/com-match/finish") {
        const token = request.headers.get("x-session-token");
        const userId = await getUserIdByToken(env, token);
        if (!userId) return response({ error: 'auth required' }, 401);
        let body; try { body = await request.json(); } catch { return response({ error: 'invalid' }, 400); }
        const delta = Number(body.delta);
        const placement = Number(body.placement);
        if (!Number.isFinite(delta) || delta < -100 || delta > 100) return response({ error: 'invalid delta' }, 400);
        if (!Number.isInteger(placement) || placement < 1 || placement > 5) return response({ error: 'invalid placement' }, 400);
        const outcome = body.outcome || (placement === 1 ? 'win' : (placement >= 2 && placement <= 3 ? 'draw' : 'loss'));
        const stat = body.stats || {};
        const tie = body.tie ? JSON.stringify(body.tie) : null;
        try {
          const profile = await env.DB.prepare("SELECT username,com_rating FROM players WHERE user_id=?").bind(userId).first();
          if (!profile) return response({ error: 'player not found' }, 404);
          const prev = Number(profile.com_rating) || 1000;
          const newComRating = Math.max(100, Math.round(prev + delta));
          const roundedDelta = Math.round(delta * 10) / 10;
          const msRow = await env.DB.prepare("SELECT streak_current, streak_best FROM player_com_match_stats WHERE user_id=?").bind(userId).first();
          const prevStreak = msRow?.streak_current ?? 0;
          const prevBest = msRow?.streak_best ?? 0;
          let newStreak = prevStreak;
          if (outcome === 'win') newStreak = prevStreak >= 0 ? prevStreak + 1 : 1;
          else newStreak = prevStreak <= 0 ? prevStreak - 1 : -1;
          const newBest = Math.max(prevBest, newStreak);
          await env.DB.batch([
            env.DB.prepare("UPDATE players SET com_rating=? WHERE user_id=?").bind(newComRating, userId),
            env.DB.prepare("INSERT INTO player_com_match_history(user_id,username,result,delta,rating_after,placement,tie_json) VALUES(?,?,?,?,?,?,?)").bind(userId, profile.username, outcome, roundedDelta, newComRating, placement, tie),
            env.DB.prepare("INSERT OR IGNORE INTO player_com_performance(user_id) VALUES(?)").bind(userId),
            env.DB.prepare("UPDATE player_com_performance SET declarer_attempts=declarer_attempts+?,declarer_successes=declarer_successes+?,deputy_attempts=deputy_attempts+?,deputy_successes=deputy_successes+? WHERE user_id=?").bind(stat.declarerAttempts || 0, stat.declarerSuccesses || 0, stat.deputyAttempts || 0, stat.deputySuccesses || 0, userId),
            env.DB.prepare("INSERT OR IGNORE INTO player_com_precision(user_id) VALUES(?)").bind(userId),
            env.DB.prepare("UPDATE player_com_precision SET exact_attempts=exact_attempts+?,exact_successes=exact_successes+?,solo_attempts=solo_attempts+?,solo_successes=solo_successes+? WHERE user_id=?").bind(stat.exactAttempts || 0, stat.exactSuccesses || 0, stat.soloAttempts || 0, stat.soloSuccesses || 0, userId),
            env.DB.prepare("INSERT OR IGNORE INTO player_com_ally_feed(user_id) VALUES(?)").bind(userId),
            env.DB.prepare("UPDATE player_com_ally_feed SET attempts=attempts+?,successes=successes+? WHERE user_id=?").bind(stat.allyFeedAttempts || 0, stat.allyFeedSuccesses || 0, userId),
            env.DB.prepare("INSERT OR IGNORE INTO player_com_bold_bid_rate(user_id) VALUES(?)").bind(userId),
            env.DB.prepare("UPDATE player_com_bold_bid_rate SET attempts=attempts+?,successes=successes+? WHERE user_id=?").bind(stat.boldAttempts || 0, stat.boldSuccesses || 0, userId),
            env.DB.prepare("INSERT OR IGNORE INTO player_com_match_stats(user_id) VALUES(?)").bind(userId),
            env.DB.prepare("UPDATE player_com_match_stats SET declarer_attempts=declarer_attempts+?,bid_total=bid_total+?,nt_bids=nt_bids+?,color_bids=color_bids+?,match_count=match_count+1,rank_1=rank_1+?,rank_2=rank_2+?,rank_3=rank_3+?,rank_4=rank_4+?,rank_5=rank_5+?,streak_current=?,streak_best=? WHERE user_id=?").bind(stat.declarerAttempts || 0, stat.bidTotal || 0, stat.ntBids || 0, stat.colorBids || 0, placement === 1 ? 1 : 0, placement === 2 ? 1 : 0, placement === 3 ? 1 : 0, placement === 4 ? 1 : 0, placement === 5 ? 1 : 0, newStreak, newBest, userId)
          ]);
          return response({ ok: true, comRating: newComRating, delta: roundedDelta, placement, streak: newStreak, bestStreak: newBest });
        } catch (e) {
          console.error('com match finish failed', e);
          return response({ error: e.message }, 500);
        }
      }

      if (request.method === "GET" && url.pathname === "/api/account/me/com") {
        const token = request.headers.get("x-session-token");
        const userId = await getUserIdByToken(env, token);
        if (!userId) return response({ error: 'auth required' }, 401);
        try {
          const [playerRow, perfRow, precRow, feedRow, boldRow, matchStatsRow, historyPage] = await Promise.all([
            env.DB.prepare("SELECT player_id AS id,username,com_rating FROM players WHERE user_id=?").bind(userId).first(),
            env.DB.prepare("SELECT declarer_attempts,declarer_successes,deputy_attempts,deputy_successes FROM player_com_performance WHERE user_id=?").bind(userId).first(),
            env.DB.prepare("SELECT exact_attempts,exact_successes,solo_attempts,solo_successes FROM player_com_precision WHERE user_id=?").bind(userId).first(),
            env.DB.prepare("SELECT attempts,successes FROM player_com_ally_feed WHERE user_id=?").bind(userId).first(),
            env.DB.prepare("SELECT attempts,successes FROM player_com_bold_bid_rate WHERE user_id=?").bind(userId).first(),
            env.DB.prepare("SELECT declarer_attempts,bid_total,nt_bids,color_bids,match_count,rank_1,rank_2,rank_3,rank_4,rank_5,streak_current,streak_best FROM player_com_match_stats WHERE user_id=?").bind(userId).first(),
            env.DB.prepare("SELECT result,delta,rating_after,placement,tie_json,created_at FROM player_com_match_history WHERE user_id=? ORDER BY id DESC LIMIT 50").bind(userId).all()
          ]);
          if (!playerRow) return response({ error: 'no player' }, 404);
          return response({
            id: playerRow.id, username: playerRow.username, comRating: Number(playerRow.com_rating) || 1000,
            performance: perfRow || { declarer_attempts: 0, declarer_successes: 0, deputy_attempts: 0, deputy_successes: 0 },
            precision: precRow || { exact_attempts: 0, exact_successes: 0, solo_attempts: 0, solo_successes: 0 },
            allyFeed: feedRow || { attempts: 0, successes: 0 },
            boldBid: boldRow || { attempts: 0, successes: 0 },
            matchStats: matchStatsRow || { declarer_attempts: 0, bid_total: 0, nt_bids: 0, color_bids: 0, match_count: 0, rank_1: 0, rank_2: 0, rank_3: 0, rank_4: 0, rank_5: 0, streak_current: 0, streak_best: 0 },
            history: (historyPage.results || []).map(r => {
              let tie = null;
              try { if (r.tie_json) tie = JSON.parse(r.tie_json); } catch {}
              return { result: r.result, delta: r.delta, rating_after: r.rating_after, placement: r.placement, tie, created_at: r.created_at };
            })
          });
        } catch (e) { return response({ error: e.message }, 500); }
      }

      // ============================================================
      // ★ 修正⑦: /api/ai/learn — tactic_id / bid_tactic_id / same_two_risk バインド
      // ============================================================
      if (request.method === "POST" && url.pathname === "/api/ai/learn") {
        let body; try { body = await request.json(); } catch { return response({ error: 'invalid' }, 400); }
        const { bid, call, playDecisions } = body || {};
        const statements = [];
        try {
          if (bid && Number.isFinite(bid.strengthKey) && bid.trumpType && Number.isFinite(bid.num)) {
            const sk = Math.round(bid.strengthKey * 2) / 2;
            const won = body.wonRound ? 1 : 0;
            const bidTacticId = bid.bidTacticId || 'UNKNOWN';
            const sameTwoRisk = Number.isFinite(bid.sameTwoRisk) ? bid.sameTwoRisk : 0;
            statements.push(
              env.DB.prepare(
                "INSERT INTO ai_bid_experience(strength_key,trump_type,num,wins,samples,bid_tactic_id,same_two_risk) VALUES(?,?,?,?,1,?,?) ON CONFLICT(strength_key,trump_type,num) DO UPDATE SET wins=wins+excluded.wins,samples=samples+1,bid_tactic_id=CASE WHEN excluded.bid_tactic_id!='UNKNOWN' THEN excluded.bid_tactic_id ELSE bid_tactic_id END,same_two_risk=CASE WHEN excluded.same_two_risk>0 THEN excluded.same_two_risk ELSE same_two_risk END,updated_at=CURRENT_TIMESTAMP"
              ).bind(sk, bid.trumpType, bid.num, won, bidTacticId, sameTwoRisk)
            );
          }
          if (call && call.callId && call.trumpSuit) {
            const won = body.wonRound ? 1 : 0;
            statements.push(
              env.DB.prepare("INSERT INTO ai_call_experience(call_id,trump_suit,wins,samples) VALUES(?,?,?,1) ON CONFLICT(call_id,trump_suit) DO UPDATE SET wins=wins+excluded.wins,samples=samples+1,updated_at=CURRENT_TIMESTAMP")
                .bind(call.callId, call.trumpSuit, won)
            );
          }
          if (Array.isArray(playDecisions) && playDecisions.length) {
            const agg = {};
            for (const d of playDecisions) {
              if (d.won === null || d.won === undefined) continue;
              if (!d.role || !d.phase || !d.pointsTier || !d.rankTier) continue;
              const key = `${d.role}:${d.phase}:${d.pointsTier}:${d.rankTier}`;
              if (!agg[key]) agg[key] = { role: d.role, phase: d.phase, pointsTier: d.pointsTier, rankTier: d.rankTier, wins: 0, total: 0, tacticId: 'UNKNOWN', situationHash: '', intentCategory: 'UNKNOWN' };
              agg[key].wins += d.won ? 1 : 0;
              agg[key].total += 1;
              if (d.tacticId && d.tacticId !== 'UNKNOWN') agg[key].tacticId = d.tacticId;
              if (d.situationHash) agg[key].situationHash = d.situationHash;
              if (d.intentCategory) agg[key].intentCategory = d.intentCategory;
            }
            for (const k of Object.keys(agg)) {
              const a = agg[k];
              statements.push(
                env.DB.prepare(
                  "INSERT INTO ai_play_experience(role,phase,points_tier,rank_tier,wins,samples,tactic_id,situation_hash,intent_category) VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(role,phase,points_tier,rank_tier) DO UPDATE SET wins=wins+excluded.wins,samples=samples+excluded.samples,tactic_id=CASE WHEN excluded.tactic_id!='UNKNOWN' THEN excluded.tactic_id ELSE tactic_id END,situation_hash=CASE WHEN excluded.situation_hash!='' THEN excluded.situation_hash ELSE situation_hash END,intent_category=CASE WHEN excluded.intent_category!='UNKNOWN' THEN excluded.intent_category ELSE intent_category END,updated_at=CURRENT_TIMESTAMP"
                ).bind(a.role, a.phase, a.pointsTier, a.rankTier, a.wins, a.total, a.tacticId, a.situationHash, a.intentCategory)
              );
            }
          }
          if (statements.length) await env.DB.batch(statements);
          __cachedExperience = null; __cachedExperienceTime = 0;
          return response({ ok: true, updated: statements.length });
        } catch (e) {
          console.error('ai/learn failed', e);
          return response({ error: e.message }, 500);
        }
      }

      // ============================================================
      // ★ 修正⑦: /api/ai/report — bid_tactic_id / same_two_risk バインド
      // ============================================================
      if (request.method === "POST" && url.pathname === "/api/ai/report") {
        let body; try { body = await request.json(); } catch { return response({ error: 'invalid' }, 400); }
        const token = request.headers.get("x-session-token");
        const userId = token ? await getUserIdByToken(env, token) : null;
        const statements = [];
        try {
          const contracts = Array.isArray(body.contracts) ? body.contracts : [];
          const bidAgg = {};
          for (const c of contracts) {
            if (!Number.isFinite(c.num) || c.num < 13 || c.num > 20) continue;
            if (!Number.isFinite(c.strengthAtBid)) continue;
            const sk = Math.round(c.strengthAtBid * 2) / 2;
            const tt = c.suit === 'NT' ? 'NT' : 'color';
            const k = `${sk}:${tt}:${c.num}`;
            if (!bidAgg[k]) bidAgg[k] = { sk, tt, num: c.num, wins: 0, total: 0, bidTacticId: c.winningBidTacticId || 'UNKNOWN', sameTwoRisk: Number.isFinite(c.sameTwoRisk) ? c.sameTwoRisk : 0 };
            bidAgg[k].wins += c.napWin ? 1 : 0;
            bidAgg[k].total += 1;
            if (c.winningBidTacticId && c.winningBidTacticId !== 'UNKNOWN') bidAgg[k].bidTacticId = c.winningBidTacticId;
          }
          for (const k of Object.keys(bidAgg)) {
            const a = bidAgg[k];
            statements.push(
              env.DB.prepare(
                "INSERT INTO ai_bid_experience(strength_key,trump_type,num,wins,samples,bid_tactic_id,same_two_risk) VALUES(?,?,?,?,?,?,?) ON CONFLICT(strength_key,trump_type,num) DO UPDATE SET wins=wins+excluded.wins,samples=samples+excluded.samples,bid_tactic_id=CASE WHEN excluded.bid_tactic_id!='UNKNOWN' THEN excluded.bid_tactic_id ELSE bid_tactic_id END,same_two_risk=CASE WHEN excluded.same_two_risk>0 THEN excluded.same_two_risk ELSE same_two_risk END,updated_at=CURRENT_TIMESTAMP"
              ).bind(a.sk, a.tt, a.num, a.wins, a.total, a.bidTacticId, a.sameTwoRisk)
            );
          }

          if (userId && body.playerRank) {
            const contractsJson = JSON.stringify(contracts);
            const aiSnapshot = body.aiWeights ? JSON.stringify(body.aiWeights) : null;
            statements.push(
              env.DB.prepare("INSERT INTO human_win_patterns(user_id,player_id,rank,won_as_nap,won_as_deputy,won_as_ally,avg_bid,exact_wins,solo_wins,match_rating_delta,contracts_json,ai_weights_snapshot) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)")
                .bind(userId, body.playerId || null, Number(body.playerRank) || 0, Number(body.playerWonAsNap) || 0, Number(body.playerWonAsDeputy) || 0, Number(body.playerWonAsAlly) || 0, Number(body.avgBid) || 0, Number(body.exactWins) || 0, Number(body.soloWins) || 0, Number(body.matchRatingDelta) || 0, contractsJson, aiSnapshot)
            );
          }

          if (statements.length) await env.DB.batch(statements);
          __cachedExperience = null; __cachedExperienceTime = 0;

          const w = await env.DB.prepare("SELECT weights FROM ai_weights WHERE id=1").first();
          const weights = w?.weights ? safeJsonParse(w.weights, null) : null;
          return response({ ok: true, updated: statements.length, weights });
        } catch (e) {
          console.error('ai/report failed', e);
          return response({ error: e.message }, 500);
        }
      }

      if (request.method === "GET" && url.pathname === "/api/rating/top") {
        const { results } = await env.DB.prepare("SELECT p.player_id AS id, p.username, p.rating, p.wins, p.losses, p.games FROM players p ORDER BY p.rating DESC, p.games DESC LIMIT 50").all();
        return response(results);
      }

      if (request.method === "GET" && url.pathname === "/api/ai/strategies") {
        const limit = parseInt(url.searchParams.get("limit")) || 10;
        const { results } = await env.DB.prepare("SELECT * FROM ai_strategy_log ORDER BY avg_rating_delta DESC, id DESC LIMIT ?").bind(limit).all();
        return response(results || []);
      }

      if (request.method === "GET" && url.pathname === "/api/ai/insights") {
        const { results } = await env.DB.prepare("SELECT * FROM ai_strategy_log ORDER BY avg_rating_delta DESC, id DESC LIMIT 10").all();
        const insights = generateInsights(results || []);
        return response({ insights });
      }

      if (request.method === "GET" && url.pathname === "/api/ai/generations") {
        const { results } = await env.DB.prepare(`
          SELECT generation, AVG(nap_win_rate) as nap, AVG(alliance_win_rate) as ally, AVG(avg_value_loss) as avg_vl, COUNT(*) as count, MAX(created_at) as time
          FROM ai_strategy_log GROUP BY generation ORDER BY generation ASC LIMIT 20
        `).all();
        return response(results || []);
      }

      if (request.method === "GET" && url.pathname === "/api/ai/top-strategy") {
        const top = await env.DB.prepare("SELECT weights FROM ai_weights WHERE id=1").first();
        return response({ strategy: top?.weights ? safeJsonParse(top.weights, null) : null });
      }

      if (request.method === "GET" && url.pathname === "/api/ai/experience") {
        const exp = await loadExperience(env);
        return response(exp);
      }

      if (request.method === "GET" && url.pathname === "/api/ai/state-experience") {
        const hash = url.searchParams.get("hash");
        if (hash) {
          const row = await env.DB.prepare("SELECT * FROM ai_state_experience WHERE state_hash=?").bind(hash).first();
          return response(row || {});
        }
        const { results } = await env.DB.prepare("SELECT * FROM ai_state_experience ORDER BY updated_at DESC LIMIT 20").all();
        return response(results || []);
      }

      if (request.method === "GET" && url.pathname === "/api/ai/hall-of-fame") {
        const { results } = await env.DB.prepare("SELECT * FROM ai_hall_of_fame ORDER BY generation DESC LIMIT 10").all();
        return response(results || []);
      }

      if (request.method === "GET" && url.pathname === "/api/ai/discard-metrics") {
        const limit = parseInt(url.searchParams.get("limit")) || 20;
        const { results } = await env.DB.prepare("SELECT * FROM ai_discard_metrics ORDER BY generation DESC, avg_ev_loss ASC LIMIT ?").bind(limit).all();
        return response(results || []);
      }

      return new Response("Not found", { status: 404 });
    } catch (err) { return response({ error: "Global API error: " + err.message, stack: err.stack }, { status: 500 }); }
  }
};
// ===== [worker.js 前半 終了] =====
// ===== [worker.js 後半 開始] =====

function makeCode() { return Math.random().toString(36).slice(2, 7).toUpperCase(); }

async function getProfile(env, conn) {
  if (conn.authProfile && conn.authUserId) {
    return {
      rating: Number(conn.authProfile.rating) || 1000,
      games: Number(conn.authProfile.games) || 0,
      username: conn.authProfile.id || conn.username || "player",
      playerId: conn.authProfile.id || conn.username || "player",
      userId: conn.authUserId,
      sessionToken: conn.authSessionToken || null
    };
  }
  return { rating: 1000, games: 0, username: conn.username || "ゲスト", playerId: conn.username || "ゲスト", userId: null, sessionToken: null };
}

async function beginMatch(kind, roomCode, group, room, env) {
  if (kind === "ranked") {
    if (!Array.isArray(group) || group.length !== 5) return;
    const browserIds = new Set();
    const ok = [];
    for (const x of group) {
      if (!x || !x.player || !x.player.userId || !x.id || !conns.has(x.id)) continue;
      if (x.browserId) {
        if (browserIds.has(x.browserId)) continue;
        browserIds.add(x.browserId);
      }
      ok.push(x);
    }
    if (ok.length !== 5) {
      for (const x of group) {
        if (!x || !x.conn || !conns.has(x.id)) continue;
        if (ok.includes(x)) continue;
        sendSafe(x.conn, { type: 'room-error', message: '対戦相手の接続が切れました。再マッチングします' });
      }
      for (const x of ok) {
        if (!queues.ranked.some(q => q.id === x.id)) queues.ranked.push(x);
      }
      broadcastQueueStatus();
      return;
    }
    group = ok;
  }

  const id = Math.random().toString(36).slice(2, 12).toUpperCase();
  const newBidSignals = () => ({ sent: null, received: [], sameColorCount: 0, lastBidAt: 0 });
  const seats = group.map(x => ({
    connId: x.id, originalConnId: x.id,
    originalUserId: x.player.userId || null,
    originalPlayerName: x.player.username || "player",
    originalPlayerId: x.player.playerId || "player",
    browserId: x.browserId || null,
    disconnectedAt: null, abandoned: false,
    player: x.player, bot: false, hand: [], points: 0, taken: [], roundTaken: [], roundPoints: 0,
    bidSignals: newBidSignals(),
    role: null
  }));
  while (seats.length < 5) seats.push({
    connId: null, originalConnId: null, originalUserId: null, originalPlayerName: null, originalPlayerId: null,
    browserId: null, disconnectedAt: null, abandoned: false,
    player: { username: "COM " + (seats.length + 1), playerId: "COM", rating: 1000, games: 0 },
    bot: true, hand: [], points: 0, taken: [], roundTaken: [], roundPoints: 0,
    bidSignals: newBidSignals(),
    role: null
  });
  const m = {
    id, kind, code: roomCode, seats: seats.slice(0, 5), created: Date.now(), botLevel: 3,
    matchScores: Array(5).fill(0), matchArt: Array(5).fill(0), matchContracts: [], bidHistory: [],
    playoff: false, playoffCount: 0, appeal: null, appealInfo: '', botStrategy: defaultStrategy(), botExperience: null,
    matchStats: Array.from({ length: 5 }, () => ({ exactWins: 0, boldExactWins: 0, soloWins: 0, dramaticPlays: 0, declarerAttempts: 0, declarerSuccesses: 0, deputyAttempts: 0, deputySuccesses: 0, exactAttempts: 0, exactSuccesses: 0, soloAttempts: 0, soloSuccesses: 0, artAttempts: 0, allyFeedAttempts: 0, allyFeedSuccesses: 0, boldAttempts: 0, boldSuccesses: 0, bidTotal: 0, ntBids: 0, colorBids: 0 })),
    roundArt: Array(5).fill(0), roundDrama: Array(5).fill(0), roundFeed: Array(5).fill(0),
    phase: "prep", round: 1, mult: 1, redraws: 0, kitty: [], openKitty: [], discardedKitty: [], trick: [], trickNo: 0, active: -1,
    auction: null, contract: null, deadline: Date.now() + 7000, lastBot: 0, botThinkAt: 0, humanAutoPlayAt: null,
    notice: "配札しました。競り開始まで7秒です。",
    playedCards: [], voids: [{}, {}, {}, {}, {}], allianceKittyPoints: 0,
    properBids: [13, 13, 13, 13, 13],
    properPlans: [null, null, null, null, null],
    auctionStartAt: 0,
    properRecomputed: false,
    winDeclaration: null,
    playPools: [20, 20, 20, 20, 20],
    turnStartAt: 0,
    botComputeKeyHex: null,
    hostSeat: -1,
    pendingBotRequest: null
  };
  matches.set(id, m);
  m.seats.forEach(x => { if (x.connId) connMatch.set(x.connId, id); });
  if (env?.DB) {
    loadBotStrategy(env).then(s => { m.botStrategy = s; }).catch(() => {});
    loadExperience(env).then(e => { m.botExperience = e; }).catch(() => {});
  }
  const firstHuman = m.seats.findIndex(s => !s.bot && s.connId);
  if (firstHuman >= 0) {
    m.hostSeat = firstHuman;
    try {
      const keyBytes = crypto.getRandomValues(new Uint8Array(32));
      m.botComputeKeyHex = hex(keyBytes);
      const hostConn = conns.get(m.seats[firstHuman].connId);
      if (hostConn) sendSafe(hostConn, { type: 'bot-compute-key', keyHex: m.botComputeKeyHex });
    } catch (e) { console.warn('key generation failed', e); }
  }
  const players = m.seats.map((x, seat) => ({ seat, id: x.player.playerId, username: x.player.username, rating: x.player.rating, bot: x.bot, abandoned: false }));
  group.forEach((x, seat) => sendSafe(x.conn, { type: "matched", matchId: id, mode: kind, code: roomCode || null, players, seat, botCount: 5 - group.length }));
  deal(m);
  publish(m, room);
}

function deal(m) {
  m.lastTrickWinner = null; m.humanAutoPlayAt = null; m.botThinkAt = null;
  const d = shuffledDeck();
  m.seats.forEach(p => {
    p.hand = d.splice(0, 10); p.points = 0; p.taken = []; p.roundTaken = []; p.roundPoints = 0;
    sortHand(p.hand);
    p.bidSignals = { sent: null, received: [], sameColorCount: 0, lastBidAt: 0 };
    p.role = null;
  });
  m.kitty = d.splice(0, 2);
  m.openKitty = m.kitty.slice();
  m.discardedKitty = [];
  m.trick = []; m.trickNo = 0; m.earlyFinish = false;
  m.roundArt = Array(5).fill(0); m.roundDrama = Array(5).fill(0); m.roundFeed = Array(5).fill(0);
  m.result = null; m.contract = null; m.auction = null; m.active = -1; m.phase = "prep";
  m.deadline = Date.now() + 7000;
  m.playedCards = []; m.voids = [{}, {}, {}, {}, {}]; m.allianceKittyPoints = 0;
  m.notice = "競り開始まで7秒です。";
  m.properBids = [13, 13, 13, 13, 13];
  m.properPlans = [null, null, null, null, null];
  m.auctionStartAt = 0;
  m.properRecomputed = false;
  m.winDeclaration = null;
  m.playPools = [20, 20, 20, 20, 20];
  m.turnStartAt = 0;
  const green = m.seats.findIndex(p => !p.hand.some(c => ["10", "J", "Q", "K", "A"].includes(c.rank)));
  if (green >= 0 && m.redraws < 5) {
    m.redraws++; m.mult = m.mult + 1; m.phase = "redeal";
    m.notice = m.seats[green].player.username + "の手札に10・J・Q・K・Aがありません。倍率" + m.mult + "倍で配り直します。";
    m.deadline = Date.now() + 1800;
  }
}

function finalAuctionRule(scores, mult = 1) {
  const ranked = scores.map((score, seat) => ({ score, seat })).sort((a, b) => a.score - b.score || a.seat - b.seat);
  const cutoff = ranked[1]?.score ?? 0;
  const gap = Math.max(0, (ranked[1]?.score ?? 0) - (ranked[0]?.score ?? 0));
  const rawMin = 13 + Math.floor(gap / (6 * Math.max(1, mult)));
  return { eligible: ranked.filter(x => x.score <= cutoff).map(x => x.seat), bottomSeat: ranked[0]?.seat, fourthSeat: ranked[1]?.seat, thirdSeat: ranked[2]?.seat, thirdScore: ranked[2]?.score, minBid: Math.min(20, rawMin), canOvertake: rawMin <= 20 };
}

function computeTeamMinBid(scores, mult, napSeat, deputySeat) {
  const ranked = scores.map((s, i) => ({ s, i })).sort((a, b) => a.s - b.s || a.i - b.i);
  const S5 = ranked[0].s, S4 = ranked[1].s, S3 = ranked[2].s;
  const bottomSeat = ranked[0].i, fourthSeat = ranked[1].i;
  const m = Math.max(1, mult);
  const f = (gap, denom) => Math.floor(Math.max(0, gap) / denom);
  if (napSeat === bottomSeat && deputySeat === fourthSeat) {
    const a = 13 + f(S3 - S5, 6 * m), b = 13 + f(S3 - S4, 4 * m), raw = Math.max(a, b), achievable = raw <= 20;
    return { minBid: Math.min(20, raw), rawMin: raw, canOvertake: achievable, achievable, incentiveBroken: !achievable, soloRequired: false, case: 'A', details: { S3, S4, S5, needNapOverThird: a, needDeputyOverThird: b } };
  }
  if (napSeat === fourthSeat && deputySeat === bottomSeat) {
    const a = 13 + f(S3 - S4, 6 * m), b = 13 + f(S3 - S5, 4 * m), c = 13 + f(S4 - S5, 2 * m), raw = Math.max(a, b, c);
    return { minBid: Math.min(20, raw), rawMin: raw, canOvertake: raw <= 20, achievable: raw <= 20, incentiveBroken: a > 20 || b > 20, soloRequired: false, case: 'B', details: { S3, S4, S5, needNapOverThird: a, needDeputyOverThird: b, needDeputyOverNapOnLoss: c } };
  }
  if ((napSeat === bottomSeat && deputySeat !== fourthSeat) || (napSeat === fourthSeat && deputySeat !== bottomSeat)) {
    const raw = 13 + f(S4 - S5, 6 * m);
    return { minBid: Math.min(20, raw), rawMin: raw, canOvertake: raw <= 20, achievable: raw <= 20, incentiveBroken: false, soloRequired: false, case: 'C', details: { S3, S4, S5, needNapOverFourth: raw } };
  }
  return null;
}

function isSoloForcedInMatch(m) {
  if (m.round < 10 || !m.contract) return false;
  const ranked = m.matchScores.map((s, i) => ({ s, i })).sort((a, b) => a.s - b.s || a.i - b.i);
  const bottomSeat = ranked[0].i;
  if (m.contract.nap !== bottomSeat) return false;
  const fourthSeat = ranked[1].i;
  const r = computeTeamMinBid(m.matchScores, m.mult, bottomSeat, fourthSeat);
  return r?.soloRequired === true;
}

function publicState(m) {
  return {
    matchId: m.id, mode: m.kind, code: m.code, botLevel: m.botLevel, phase: m.phase, round: m.round, mult: m.mult,
    matchScores: m.matchScores, matchArt: m.matchArt, bidHistory: m.bidHistory || [], playoff: !!m.playoff, playoffCount: m.playoffCount || 0,
    appeal: m.appeal, appealInfo: m.appealInfo || '', lastTrickWinner: m.lastTrickWinner ?? null,
    finalRoundRule: m.round >= 10 ? finalAuctionRule(m.matchScores, m.mult) : null,
    notice: m.notice, active: m.active, allianceKittyPoints: m.allianceKittyPoints || 0,
    winDeclaration: m.winDeclaration || null,
    playPools: m.playPools || [20, 20, 20, 20, 20],
    players: m.seats.map((p, seat) => ({
      seat,
      name: p.bot ? (p.abandoned ? (p.originalPlayerName || p.player.username) + " (放棄)" : p.player.username) : (p.player.playerId || p.player.username),
      username: p.originalPlayerName || p.player.username,
      originalName: p.originalPlayerName || p.player.username,
      abandoned: !!p.abandoned,
      rating: p.player.rating, bot: p.bot,
      handCount: p.hand.length, points: p.points, taken: p.taken, active: m.active,
      approved: m.phase === "auction" && m.auction && Array.isArray(m.auction.active) ? !m.auction.active.includes(seat) : false,
      role: m.contract ? (m.contract.nap === seat ? "ナポレオン" : !m.contract.revealedCall ? "" : m.contract.deputy === seat ? "副官" : "連合軍") : ""
    })),
    kitty: m.phase === "auction" ? m.kitty : [],
    revealedKitty: (m.phase !== "auction" && m.phase !== "prep" && m.phase !== "discard" && m.discardedKitty) ? m.discardedKitty.filter(c => ["10", "J", "Q", "K", "A"].includes(c.rank)) : [],
    auction: m.auction ? {
      high: m.auction.high,
      active: m.auction.active,
      approved: m.auction.approved,
      minBid: m.auction.minBid || 13,
      requiredBidSeat: m.auction.requiredBidSeat ?? null,
      autoApprove: m.auction.autoApprove,
      needsHumanConfirm: m.auction.needsHumanConfirm === true
    } : null,
    contract: m.contract ? { nap: m.contract.nap, num: m.contract.num, suit: m.contract.suit, deputy: m.contract.revealedCall ? m.contract.deputy : -1, solo: m.contract.revealedCall ? m.contract.solo : false, revealedCall: !!m.contract.revealedCall, call: m.contract.call, bidPlan: m.contract.bidPlan } : null,
    trick: m.trick.map(x => ({ seat: x.seat, card: x.card })),
    trickNo: m.trickNo, deadline: m.deadline, result: m.result || null
  };
}

function legalCards(m, seat) {
  const h = m.seats[seat].hand;
  if (!m.trick.length) return h;
  const led = m.trick[0].card.suit, follow = h.filter(c => c.suit === led);
  return follow.length ? follow : h;
}

function publish(m, room) {
  const pub = publicState(m);
  for (let seat = 0; seat < m.seats.length; seat++) {
    const p = m.seats[seat]; if (!p.connId) continue;
    const c = conns.get(p.connId); if (!c) continue;
    const view = m.phase === "call" && seat === m.active ? { ...pub, kitty: m.kitty } : pub;
    try {
      sendSafe(c, { type: "game-state", state: view, you: seat });
      sendSafe(c, { type: "private-hand", hand: p.hand, legal: m.phase === "play" && m.active === seat ? legalCards(m, seat).map(x => x.id) : [] });
    } catch (error) { console.warn("match publish failed", m.id, c.id, error); }
  }
}

function validBid(m, n, s) {
  const h = m.auction.high;
  return Number.isInteger(n) && n >= (m.auction.minBid || 13) && n <= 20 && (SUITS.includes(s) || s === "NT") && (n > h.num || (n === h.num && SV[s] > SV[h.suit]));
}

function scheduleObservationPeriod(m, excludeSeat = -1) {
  const obsBase = m.botStrategy?.auctionObservationMs ?? 2000;
  const jitter = 1000 + Math.random() * 2000;
  const delay = obsBase + jitter;
  const now = Date.now();
  for (let i = 0; i < 5; i++) {
    if (i === excludeSeat) continue;
    if (!m.seats[i].bot) continue;
    if (!m.auction.active.includes(i)) continue;
    m.auction.botAt[i] = now + delay;
  }
}

function doApprove(m, seat, room, forced = false) {
  if (m.phase !== "auction" || !m.auction.active.includes(seat)) return;
  if (m.auction.requiredBidSeat !== null && m.auction.high.num < 13) {
    if (forced && seat === m.auction.requiredBidSeat) doBid(m, seat, m.auction.minBid || 13, strongestSuit(m.seats[seat].hand), room);
    return;
  }
  if (m.round >= 10 && m.auction.high.num < 13) {
    const forcedSeat = m.auction.requiredBidSeat ?? m.auction.active[0];
    if (forced && seat === forcedSeat) doBid(m, seat, m.auction.minBid || 13, strongestSuit(m.seats[seat].hand), room);
    return;
  }
  if (m.auction.high.player === seat) {
    if (m.auction.needsHumanConfirm) {
      m.auction.needsHumanConfirm = false;
      auctionDone(m, seat, room, true);
      return;
    }
    const others = m.auction.active.filter(s => s !== seat);
    const humanPending = m.auction.active.some(s => !m.seats[s].bot && s !== seat && !m.auction.approved[s]);
    const allApproved = !humanPending && (others.length === 0 || others.every(s => m.auction.approved[s]));
    if (allApproved) {
      const proper = computeProperBid(m.seats[seat].hand, m.auction.high.suit, m.botStrategy || defaultStrategy(), seat, m.seats[seat].bidSignals, m.matchScores, m.openKitty, m.playedCards, m.voids, m.bidHistory, m.round);
      const properBid = proper.properBid > 0 ? proper.properBid : 13;
      if (m.auction.high.num < properBid) {
        const pacingMs = (m.botStrategy?.bidPacingMs) ?? 4000;
        m.auction.botAt[seat] = Date.now() + pacingMs;
        m.auction.botSeen[seat] = -1;
        m.notice = m.seats[seat].player.username + "が適正値まで段階上げ中…";
        publish(m, room);
        return;
      }
      auctionDone(m, seat, room);
    } else if (forced && !m.auction.autoApprove[seat]) {
      m.auction.autoApprove[seat] = true;
      m.notice = m.seats[seat].player.username + "は30秒操作がなかったため、自動承認待ちです。";
      publish(m, room);
    }
    return;
  }
  m.auction.approved[seat] = true;
  m.auction.lastAction[seat] = Date.now();
  m.auction.autoApprove[seat] = false;
  m.notice = forced
    ? m.seats[seat].player.username + "は30秒操作がなかったため、自動で保留しました。"
    : m.seats[seat].player.username + "が保留しました（誰かが上げれば復帰可能）。";
  const others = m.auction.active.filter(s => s !== m.auction.high.player);
  const humanPending = m.auction.active.some(s => !m.seats[s].bot && s !== m.auction.high.player && !m.auction.approved[s]);
  const allApproved = !humanPending && (others.length === 0 || others.every(s => m.auction.approved[s]));
  if (allApproved) {
    if (!m.seats[m.auction.high.player].bot) {
      m.auction.needsHumanConfirm = true;
      m.auction.lastAction[m.auction.high.player] = Date.now();
      m.notice = m.seats[m.auction.high.player].player.username + ' の確定を待っています';
      publish(m, room);
      return;
    }
    auctionDone(m, m.auction.high.player, room);
    return;
  }
  m.auction.active.forEach(i => {
    if (m.seats[i].bot && i !== seat && !m.auction.approved[i]) {
      m.auction.botSeen[i] = Math.min(m.auction.botSeen[i], m.auction.version - 1);
    }
  });
  scheduleObservationPeriod(m, seat);
  publish(m, room);
}

function doBid(m, seat, n, s, room, solo = false) {
  if (m.phase !== "auction" || !m.auction.active.includes(seat) || (m.auction.requiredBidSeat !== null && m.auction.requiredBidSeat !== seat) || !validBid(m, n, s)) return;
  const prevBid = { ...m.auction.high };
  m.bidHistory.push({ round: m.round, seat, num: n, suit: s });
  if (m.bidHistory.length > 50) m.bidHistory.shift();
  m.auction.lastAction[seat] = Date.now();
  m.auction.autoApprove[seat] = false;
  m.auction.high = { num: n, suit: s, player: seat, solo: solo === true };
  if (m.auction.requiredBidSeat === seat) m.auction.requiredBidSeat = null;
  m.auction.version++;
  m.auction.approved = Array(5).fill(false);
  m.auction.needsHumanConfirm = false;
  m.active = seat;

  const params = m.botStrategy || defaultStrategy();
  if (prevBid.num >= 13 && prevBid.player >= 0 && prevBid.player !== seat) {
    try {
      const intent = inferIntentFromBid(prevBid, { num: n, suit: s, player: seat }, params);
      for (let i = 0; i < 5; i++) {
        if (i === seat) continue;
        if (!m.seats[i].bidSignals) m.seats[i].bidSignals = { sent: null, received: [], sameColorCount: 0, lastBidAt: 0 };
        if (!Array.isArray(m.seats[i].bidSignals.received)) m.seats[i].bidSignals.received = [];
        m.seats[i].bidSignals.received.push({ from: seat, intent: intent.intent, strength: intent.strength, num: n, suit: s, reason: intent.reason });
      }
    } catch (e) { console.warn("inferIntentFromBid failed", e?.message); }
  }
  if (m.seats[seat].bidSignals) m.seats[seat].bidSignals.lastBidAt = Date.now();

  scheduleObservationPeriod(m, seat);

  for (const i of m.auction.active.slice()) if (i !== seat && m.auction.autoApprove[i]) doApprove(m, i, room, true);
  if (m.phase !== "auction") return;
  m.notice = m.seats[seat].player.username + "が" + n + s + "を宣言しました。";
  if (n === 20 && s === "NT") { auctionDone(m, seat, room); return; }
  publish(m, room);
}

function appealDetails(hand) {
  const held = ['♣J', '♦J', '♥J', '♠J', '♠A'].filter(id => hand.some(card => card.id === id));
  return held.length ? held.join(' ') : 'なし';
}

function enterAuctionAfterAppeal(m, room, requiredBidSeat = null) {
  m.auction.requiredBidSeat = requiredBidSeat; m.phase = 'auction'; m.active = -1; m.deadline = 0;
  m.notice = m.appealInfo || '競り開始です。宣言するか、承認して競りを降りてください。'; publish(m, room);
}

function answerAppealOffer(m, seat, appeal, room) {
  if (m.phase !== 'appeal-offer' || seat !== m.appeal?.bottomSeat) return;
  if (!appeal) { m.appealInfo = '5位はアピールせず競りへ'; m.phase = 'auction'; m.active = -1; m.notice = '競り開始です。'; m.auction.high = { num: 12, suit: '', player: -1, solo: false }; m.auction.requiredBidSeat = null; publish(m, room); return; }
  m.phase = 'appeal-response'; m.active = m.appeal.fourthSeat; m.deadline = Date.now() + 30000; m.notice = '5位がアピールしました。4位はJ・マイティを申告するか、申告せず立てます。'; publish(m, room);
  if (m.seats[m.active].bot) answerAppealResponse(m, m.active, 'declare', room);
}

function answerAppealResponse(m, seat, choice, room) {
  if (m.phase !== 'appeal-response' || seat !== m.appeal?.fourthSeat) return;
  const bottom = m.appeal.bottomSeat, fourth = m.appeal.fourthSeat, rule = finalAuctionRule(m.matchScores, m.mult);
  if (choice === 'declare') { m.appealInfo = (m.seats[seat].player.playerId || m.seats[seat].player.username) + 'の申告：' + appealDetails(m.seats[seat].hand); m.auction.high = { num: rule.minBid, suit: '♣', player: bottom, solo: false }; m.auction.requiredBidSeat = null; m.active = bottom; m.notice = m.appealInfo + '。' + m.seats[bottom].player.username + 'が最低宣言数 ' + rule.minBid + '♣ で立ちました。'; }
  else { m.appealInfo = (m.seats[seat].player.playerId || m.seats[seat].player.username) + 'は申告せず立つことを選択。'; m.auction.high = { num: rule.minBid, suit: '♣', player: fourth, solo: false }; m.auction.requiredBidSeat = fourth; m.active = fourth; m.notice = m.appealInfo + '。' + m.seats[fourth].player.username + 'が最低宣言数 ' + rule.minBid + '♣ で立ちました。'; }
  m.phase = 'auction'; m.deadline = 0; publish(m, room);
}

function auctionDone(m, seat, room, skipProperRaise = false) {
  if (m.auction) m.auction.needsHumanConfirm = false;
  if (seat < 0 || m.auction.high.num < 13) {
    if (m.round >= 10) {
      seat = finalAuctionRule(m.matchScores, m.mult).bottomSeat;
      m.auction.high = { num: m.auction.minBid || 13, suit: strongestSuit(m.seats[seat].hand), player: seat, solo: false };
      m.notice = "オールラストは立ち必須。最下位が最低枚数で立ちます。";
    } else {
      m.notice = "宣言なし。配り直します。";
      m.phase = "redeal"; m.deadline = Date.now() + 1800; publish(m, room); return;
    }
  }

  const params = m.botStrategy || defaultStrategy();
  if (!m.properRecomputed) {
    const proper = computeProperBid(m.seats[seat].hand, m.auction.high.suit, params, seat, m.seats[seat].bidSignals, m.matchScores, m.openKitty || [], m.playedCards, m.voids, m.bidHistory, m.round);
    m.properBids[seat] = proper.properBid > 0 ? proper.properBid : 13;
    m.properPlans[seat] = proper.plan;
    m.properRecomputed = true;
  }

  const properBid = m.properBids[seat] || 13;
  if (!skipProperRaise && m.auction.high.num < properBid && m.auction.high.player === seat) {
    if (!m.auction.active.includes(seat)) m.auction.active.push(seat);
    const pacingMs = (params.bidPacingMs) ?? 4000;
    m.auction.botAt[seat] = Date.now() + pacingMs;
    m.auction.botSeen[seat] = -1;
    m.notice = m.seats[seat].player.username + "が適正値（" + properBid + "）まで段階上げ中…";
    publish(m, room);
    return;
  }

  const bs = params;
  const strengthAtBid = m.auction.high.suit === 'NT' ? ntHandStrength(m.seats[seat].hand, bs) : colorStrength(m.seats[seat].hand, m.auction.high.suit, bs);
  const isSoloBid = m.auction.high.solo === true;
  m.contract = {
    nap: seat, num: m.auction.high.num, suit: m.auction.high.suit, deputy: -1, call: null,
    solo: isSoloBid, revealedCall: false, revealTrickNo: null, strengthAtBid,
    bidPlan: m.properPlans[seat] || null
  };
  beginDiscard(m, seat, room);
}

function startPlay(m, room) {
  const c = m.contract;
  if (!c) return;
  if (c.solo) c.deputy = c.nap;
  else {
    for (let i = 0; i < 5; i++) {
      const found = m.seats[i].hand.some(x => x.id === c.call.id);
      if (found) { c.deputy = i; break; }
    }
    if (c.deputy < 0) c.deputy = c.nap;
  }
  m.phase = "play"; m.trick = []; m.trickNo = 0; m.active = c.nap;
  m.playPools = [20, 20, 20, 20, 20];
  m.turnStartAt = Date.now();
  const mySeat = m.active;
  const free = 5;
  const pool = m.playPools[mySeat] || 20;
  m.deadline = Date.now() + (free + Math.max(0, pool)) * 1000;
  m.humanAutoPlayAt = null; m.botThinkAt = null;
  m.notice = "カードを出してください。マストフォローです。"; publish(m, room);
  if (m.seats[m.active].bot) botAction(m, room);
}

function beginDiscard(m, seat, room) {
  m.seats[seat].hand.push(...m.kitty); m.openKitty = m.kitty.slice(); m.kitty = [];
  sortHand(m.seats[seat].hand);
  m.phase = "discard"; m.active = seat; m.deadline = Date.now() + 30000;
  m.humanAutoPlayAt = null; m.botThinkAt = null;
  m.notice = "オープンの2枚を手札に入れ、2枚を捨ててください。"; publish(m, room);
  if (m.seats[seat].bot) botAction(m, room);
}

function callCard(m, seat, suit, rank, room) {
  if (m.phase !== "call" || m.active !== seat || !SUITS.includes(suit) || !RANKS.includes(rank)) return;
  const card = { suit, rank, id: suit + rank };
  if (m.kitty.some(x => x.id === card.id)) return;
  const isOwn = m.seats[seat].hand.some(c => c.id === card.id);
  const forceSolo = isSoloForcedInMatch(m);
  if ((m.contract.solo || forceSolo) && !isOwn) { m.notice = "ひとり立ちを選択しているため、自分の手札からのみ指名できます。"; publish(m, room); return; }
  m.contract.call = card; m.contract.solo = isOwn || m.contract.solo; m.contract.revealedCall = false;
  m.contract.ready = m.seats.map(p => p.bot);
  m.phase = "call-reveal"; m.active = seat; m.deadline = Date.now() + 15000; m.kitty = [];
  m.notice = suit + rank + "が指名されました。全員の確認後に開始します。"; publish(m, room);
}

function discardCards(m, seat, ids, room) {
  if (m.phase !== "discard" || m.active !== seat || !Array.isArray(ids) || ids.length !== 2 || new Set(ids).size !== 2) return;
  const h = m.seats[seat].hand; if (ids.some(id => !h.some(c => c.id === id))) return;
  const removed = h.filter(c => ids.includes(c.id));
  m.seats[seat].hand = h.filter(c => !ids.includes(c.id));
  const kittyPoints = removed.filter(c => ["10", "J", "Q", "K", "A"].includes(c.rank));
  m.allianceKittyPoints = (m.allianceKittyPoints || 0) + kittyPoints.length;
  m.kitty = removed; m.openKitty = removed.slice(); m.discardedKitty = removed.slice();
  sortHand(m.seats[seat].hand);
  m.phase = "call"; m.active = seat; m.deadline = Date.now() + 30000;
  m.humanAutoPlayAt = null;
  m.notice = "捨て札を決めました。副官に指名するカードを選んでください。";
  publish(m, room);
  if (m.seats[seat].bot) botAction(m, room);
}

async function finish(m, room, env) {
  m.matchScores = m.matchScores || Array(5).fill(0);
  m.matchArt = m.matchArt || Array(5).fill(0);
  m.matchContracts = m.matchContracts || [];
  m.matchStats = m.matchStats || Array.from({ length: 5 }, () => ({ exactWins: 0, boldExactWins: 0, soloWins: 0, dramaticPlays: 0, declarerAttempts: 0, declarerSuccesses: 0, deputyAttempts: 0, deputySuccesses: 0, exactAttempts: 0, exactSuccesses: 0, soloAttempts: 0, soloSuccesses: 0, artAttempts: 0, allyFeedAttempts: 0, allyFeedSuccesses: 0, boldAttempts: 0, boldSuccesses: 0, bidTotal: 0, ntBids: 0, colorBids: 0 }));
  m.matchStats.forEach(stat => { for (const k of Object.keys(stat)) stat[k] = stat[k] || 0; });
  m.roundArt = m.roundArt || Array(5).fill(0);
  const finalRule = m.round >= 10 ? finalAuctionRule(m.matchScores, m.mult) : null;
  const nap = m.contract.nap, unit = Math.max(0, m.contract.num - 12) * m.mult * (m.round >= 10 ? 2 : 1);
  const team = m.contract.solo ? [nap] : Array.from(new Set([nap, m.contract.deputy]));
  const points = team.reduce((n, i) => n + m.seats[i].points, 0);
  const allianceKitty = m.allianceKittyPoints || 0;
  const made = points >= m.contract.num && (m.contract.num === 20 || points < 20);
  const sign = made ? 1 : -1;
  const scores = Array(5).fill(0);
  m.matchStats[nap].declarerAttempts++; m.matchStats[nap].bidTotal = (m.matchStats[nap].bidTotal || 0) + m.contract.num;
  if (m.contract.suit === "NT") m.matchStats[nap].ntBids = (m.matchStats[nap].ntBids || 0) + 1;
  else m.matchStats[nap].colorBids = (m.matchStats[nap].colorBids || 0) + 1;
  m.matchStats[nap].exactAttempts++;
  if (m.contract.num >= 15) { m.matchStats[nap].boldAttempts++; if (made && points === m.contract.num) m.matchStats[nap].boldSuccesses++; }
  if (made) m.matchStats[nap].declarerSuccesses++;
  if (!m.contract.solo) { m.matchStats[m.contract.deputy].deputyAttempts++; if (made) m.matchStats[m.contract.deputy].deputySuccesses++; }
  if (m.contract.solo) { m.matchStats[nap].soloAttempts++; if (made) m.matchStats[nap].soloSuccesses++; }
  scores[nap] = sign * unit * (m.contract.solo ? 4 : 2);
  if (m.contract.solo) { for (let i = 0; i < 5; i++) if (i !== nap) scores[i] = -sign * unit; }
  else { scores[m.contract.deputy] = sign * unit; for (let i = 0; i < 5; i++) if (i !== nap && i !== m.contract.deputy) scores[i] = -sign * unit; }
  const art = m.roundArt.slice();
  if (made && points === m.contract.num) {
    art[nap] += 2; m.matchStats[nap].exactWins++; m.matchStats[nap].exactSuccesses++;
    if (!m.contract.solo) art[m.contract.deputy] += 1;
    if (m.contract.num >= 15) { art[nap] += 2; m.matchStats[nap].boldExactWins++; if (!m.contract.solo) art[m.contract.deputy] += 1; }
  }
  if (m.contract.solo) { art[nap] += made ? 4 : 2; if (made) m.matchStats[nap].soloWins++; }
  if (!made && !m.contract.solo && m.contract.num - points >= 3) { art[nap] -= 2; art[m.contract.deputy] -= 1; }
  for (let i = 0; i < 5; i++) { m.matchScores[i] += scores[i]; m.matchArt[i] += art[i]; }
  m.matchContracts.push({ round: m.round, nap, deputy: m.contract.deputy, num: m.contract.num, suit: m.contract.suit, solo: !!m.contract.solo, points, napWin: made, revealTrickNo: m.contract.revealTrickNo ?? null, takenPoints: m.seats.map(s => s.roundPoints || 0), strengthAtBid: m.contract.strengthAtBid ?? 8, allianceKittyPoints: allianceKitty, mult: m.mult || 1 });
  const replayAllLast = !!(finalRule && scores[finalRule.bottomSeat] > 0 && m.matchScores[finalRule.bottomSeat] === m.matchScores[finalRule.fourthSeat]);

  let lastRound = m.round >= 10 && !replayAllLast;
  let forceBreak = false;
  if (replayAllLast) {
    m.playoff = true;
    m.playoffCount = (m.playoffCount || 0) + 1;
    if (m.playoffCount >= 10) { forceBreak = true; lastRound = true; m.notice = "プレーオフ10回上限。席番号順でタイブレークします。"; }
  } else if (m.playoff && m.round >= 10) {
    m.playoff = false;
  }

  const abandonedSeats = m.seats.map((s, i) => s.abandoned ? i : -1).filter(i => i >= 0);
  const rankingResult = matchRatingChanges(m.matchScores, abandonedSeats, { forceBreakTie: forceBreak });
  m.result = {
    round: m.round, made, points, bid: m.contract.num, suit: m.contract.suit, solo: !!m.contract.solo, stake: unit,
    nap, deputy: m.contract.deputy,
    allianceKittyPoints: allianceKitty,
    lastTrickWinner: m.lastTrickWinner ?? null,
    lastTrickWinnerName: m.lastTrickWinner != null ? (m.seats[m.lastTrickWinner]?.bot ? (m.seats[m.lastTrickWinner]?.originalPlayerName || m.seats[m.lastTrickWinner]?.player.username) : (m.seats[m.lastTrickWinner]?.player.playerId || m.seats[m.lastTrickWinner]?.player.username)) : null,
    scoreChanges: scores.map((delta, seat) => ({ seat, delta, role: seat === nap ? "ナポレオン" : !m.contract.solo && seat === m.contract.deputy ? "副官" : "連合軍" })),
    artChanges: art.map((delta, seat) => ({ seat, delta })),
    winners: made ? team : m.seats.map((_, i) => i).filter(i => !team.includes(i)),
    matchScores: m.matchScores.slice(), matchArt: m.matchArt.slice(),
    placements: rankingResult.map(r => r.placement),
    ties: rankingResult.map(r => r.tie),
    allLastReplay: replayAllLast, playoff: !!m.playoff, playoffCount: m.playoffCount || 0,
    ratingChanges: rankingResult
  };
  m.phase = lastRound ? "result" : "round-result"; m.active = -1; m.deadline = lastRound ? 0 : Date.now() + 8000;
  m.humanAutoPlayAt = null;
  m.notice = replayAllLast ? (forceBreak ? "プレーオフ10回上限。席番号順でタイブレークします。" : "5位が4位に並びました。プレーオフを行います。") : lastRound ? "オールラスト終了。レートを集計しています。" : "第" + m.round + "局が終了しました。";
  if (!lastRound) { publish(m, room); return; }

  try {
    if (m.kind === "ranked") {
      const seatPayloads = [];
      for (let seat = 0; seat < 5; seat++) {
        const s = m.seats[seat];
        const change = rankingResult[seat];
        const stat = m.matchStats[seat] || {};
        seatPayloads.push({
          seat, userId: s.player?.userId || s.originalUserId || null, sessionToken: s.player?.sessionToken || null,
          outcome: change.outcome, delta: change.delta, placement: change.placement,
          stats: {
            declarerAttempts: stat.declarerAttempts || 0, declarerSuccesses: stat.declarerSuccesses || 0,
            deputyAttempts: stat.deputyAttempts || 0, deputySuccesses: stat.deputySuccesses || 0,
            exactAttempts: stat.exactAttempts || 0, exactSuccesses: stat.exactSuccesses || 0,
            soloAttempts: stat.soloAttempts || 0, soloSuccesses: stat.soloSuccesses || 0,
            boldAttempts: stat.boldAttempts || 0, boldSuccesses: stat.boldSuccesses || 0,
            artAttempts: stat.artAttempts || 0, dramaticPlays: stat.dramaticPlays || 0,
            allyFeedAttempts: stat.allyFeedAttempts || 0, allyFeedSuccesses: stat.allyFeedSuccesses || 0,
            bidTotal: stat.bidTotal || 0, ntBids: stat.ntBids || 0, colorBids: stat.colorBids || 0,
            exactWins: stat.exactWins || 0, boldExactWins: stat.boldExactWins || 0, soloWins: stat.soloWins || 0
          }
        });
      }
      const verified = seatPayloads.filter(s => s.userId);
      if (verified.length) {
        try {
          const userIds = verified.map(v => v.userId);
          const ph = userIds.map(() => '?').join(',');
          const profRes = await env.DB.prepare("SELECT user_id,username,rating FROM players WHERE user_id IN (" + ph + ")").bind(...userIds).all();
          const byId = new Map(profRes.results.map(r => [r.user_id, r]));
          const statements = [];
          const updates = [];
          for (const v of verified) {
            const profile = byId.get(v.userId);
            if (!profile) continue;
            const newRating = Math.max(100, Math.round((Number(profile.rating) || 1000) + v.delta));
            const roundedDelta = Math.round(v.delta * 10) / 10;
            const outcome = v.outcome || 'loss';
            const stat = v.stats || {};
            statements.push(
              env.DB.prepare("UPDATE players SET rating=?, wins=wins+?, losses=losses+?, games=games+1 WHERE user_id=?").bind(newRating, outcome === 'win' ? 1 : 0, outcome === 'loss' ? 1 : 0, v.userId),
              env.DB.prepare("INSERT INTO match_history(user_id,username,result,delta,rating_after) VALUES(?,?,?,?,?)").bind(v.userId, profile.username, outcome, roundedDelta, newRating),
              env.DB.prepare("INSERT OR IGNORE INTO player_stats(user_id) VALUES(?)").bind(v.userId),
              env.DB.prepare("UPDATE player_stats SET exact_wins=exact_wins+?,bold_exact_wins=bold_exact_wins+?,solo_wins=solo_wins+?,dramatic_plays=dramatic_plays+? WHERE user_id=?").bind(stat.exactWins || 0, stat.boldExactWins || 0, stat.soloWins || 0, stat.dramaticPlays || 0, v.userId),
              env.DB.prepare("INSERT INTO player_performance(user_id,declarer_attempts,declarer_successes,deputy_attempts,deputy_successes) VALUES(?,?,?,?,?) ON CONFLICT(user_id) DO UPDATE SET declarer_attempts=declarer_attempts+excluded.declarer_attempts,declarer_successes=declarer_successes+excluded.declarer_successes,deputy_attempts=deputy_attempts+excluded.deputy_attempts,deputy_successes=deputy_successes+excluded.deputy_successes").bind(v.userId, stat.declarerAttempts || 0, stat.declarerSuccesses || 0, stat.deputyAttempts || 0, stat.deputySuccesses || 0),
              env.DB.prepare("INSERT INTO player_precision(user_id,exact_attempts,exact_successes,solo_attempts,solo_successes) VALUES(?,?,?,?,?) ON CONFLICT(user_id) DO UPDATE SET exact_attempts=exact_attempts+excluded.exact_attempts,exact_successes=exact_successes+excluded.exact_successes,solo_attempts=solo_attempts+excluded.solo_attempts,solo_successes=solo_successes+excluded.solo_successes").bind(v.userId, stat.exactAttempts || 0, stat.exactSuccesses || 0, stat.soloAttempts || 0, stat.soloSuccesses || 0),
              env.DB.prepare("INSERT INTO player_match_stats(user_id,declarer_attempts,bid_total,nt_bids,color_bids,match_count,rank_1,rank_2,rank_3,rank_4,rank_5) VALUES(?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(user_id) DO UPDATE SET declarer_attempts=declarer_attempts+excluded.declarer_attempts,bid_total=bid_total+excluded.bid_total,nt_bids=nt_bids+excluded.nt_bids,color_bids=color_bids+excluded.color_bids,match_count=match_count+1,rank_1=rank_1+excluded.rank_1,rank_2=rank_2+excluded.rank_2,rank_3=rank_3+excluded.rank_3,rank_4=rank_4+excluded.rank_4,rank_5=rank_5+excluded.rank_5").bind(v.userId, stat.declarerAttempts || 0, stat.bidTotal || 0, stat.ntBids || 0, stat.colorBids || 0, 1, v.placement === 1 ? 1 : 0, v.placement === 2 ? 1 : 0, v.placement === 3 ? 1 : 0, v.placement === 4 ? 1 : 0, v.placement === 5 ? 1 : 0)
            );
            updates.push({ userId: v.userId, rating: newRating, delta: roundedDelta, outcome, placement: v.placement });
          }
          if (statements.length) await env.DB.batch(statements);
          for (const update of updates) {
            const seat = m.seats.findIndex(s => (s.player?.userId || s.originalUserId) === update.userId);
            if (seat >= 0 && m.seats[seat].connId && conns.has(m.seats[seat].connId)) {
              sendSafe(conns.get(m.seats[seat].connId), { type: "rating-updated", result: update.outcome, delta: update.delta, rating: update.rating, placement: update.placement });
            }
          }
        } catch (e) {
          console.error('ranked settlement failed', m.id, e);
          m.result.rateSaveFailed = true;
          for (let seat = 0; seat < 5; seat++) {
            if (m.seats[seat].connId && conns.has(m.seats[seat].connId)) {
              sendSafe(conns.get(m.seats[seat].connId), { type: 'rate-save-failed', message: 'レート保存に失敗しました。次回ログイン時に再同期されます' });
            }
          }
        }
      }
    }
  } finally {
    try { publish(m, room); } catch (e) { console.warn('final publish failed', e); }
    matches.delete(m.id);
    for (const seat of m.seats) {
      if (seat.connId) connMatch.delete(seat.connId);
      const uid = seat.player?.userId || seat.originalUserId;
      if (uid && rankedUsers.get(uid) === seat.connId) rankedUsers.delete(uid);
      if (uid) rankedUsers.delete(uid);
    }
  }
}

function artfulCard(m, entry, trick) {
  const c = entry.card, led = trick[0].card.suit, black = s => s === "♣" || s === "♠";
  return c.id === "♠A" || c.id === "♥Q" && trick.some(x => x.card.id === "♠A") || c.rank === "J" && m.contract.suit !== "NT" && (c.suit === m.contract.suit || c.suit !== m.contract.suit && black(c.suit) === black(m.contract.suit)) || c.rank === "2" && c.suit === led && trick.every(x => x.card.suit === led);
}

function playCard(m, seat, id, room, env) {
  if (m.phase !== "play" || m.active !== seat) return;
  const legal = legalCards(m, seat), card = legal.find(x => x.id === id);
  if (!card) return;
  if (!m.trick.length) m.lastTrickWinner = null;
  const previous = m.trick.length ? winningEntry(m.contract, m.trickNo, m.trick) : null;
  const hand = m.seats[seat].hand;
  const teamOf = i => i === m.contract.nap || (!m.contract.solo && i === m.contract.deputy) ? "nap" : "alliance";
  const feedOpportunity = !!(previous && previous.seat !== seat && m.contract.revealedCall && teamOf(previous.seat) === teamOf(seat) && legal.some(x => ["10", "J", "Q", "K", "A"].includes(x.rank)));
  const feedCard = feedOpportunity && ["10", "J", "Q", "K", "A"].includes(card.rank);

  if (!m.seats[seat].bot && m.turnStartAt) {
    const elapsed = (Date.now() - m.turnStartAt) / 1000;
    const consumed = Math.max(0, elapsed - 5);
    if (m.playPools) m.playPools[seat] = Math.max(0, (m.playPools[seat] || 20) - consumed);
  }

  hand.splice(hand.findIndex(x => x.id === id), 1);
  m.trick.push({ seat, card, feedOpportunity, feedCard });
  m.playedCards.push({ suit: card.suit, rank: card.rank, id: card.id, seat: seat });
  if (m.trick.length > 1) {
    const ledSuit = m.trick[0].card.suit;
    if (card.suit !== ledSuit) { if (!m.voids[seat]) m.voids[seat] = {}; m.voids[seat][ledSuit] = true; }
  }
  const reveal = m.contract.call?.id === card.id && !m.contract.revealedCall;
  let raisedNotice = "";
  if (reveal) {
    m.contract.revealedCall = true; m.contract.revealTrickNo = m.trickNo;
    if (m.round >= 10 && !m.contract.solo) {
      const r = computeTeamMinBid(m.matchScores, m.mult, m.contract.nap, m.contract.deputy);
      if (r !== null) {
        const oldBid = m.contract.num, caseLabel = { A: '組んだら', B: '逆組み', C: '通常' }[r.case];
        if (!r.achievable) raisedNotice = '副官判明（' + caseLabel + '）。20枚でも逆転不可能（不可）です。';
        else if (r.minBid > oldBid) { m.contract.num = r.minBid; raisedNotice = '副官判明（' + caseLabel + '）。立ちを ' + oldBid + '枚 → ' + r.minBid + '枚 に引き上げました。'; }
        else raisedNotice = '副官判明（' + caseLabel + '）。立ち ' + oldBid + '枚は最低条件を満たしています。';
      }
    }
  }
  if (previous && m.contract.revealedCall) {
    const team = x => x === m.contract.nap || x === m.contract.deputy ? "nap" : "alliance";
    if (team(seat) === team(previous.seat) && winningEntry(m.contract, m.trickNo, m.trick).seat === seat) m.roundArt[seat]--;
  }
  const revealNotice = m.contract.solo ? "ひとり立ちが判明しました。" : "副官が判明しました。";
  m.humanAutoPlayAt = null;
  m.botThinkAt = null;

  if (m.trick.length < 5) {
    m.active = (seat + 1) % 5;
    m.turnStartAt = Date.now();
    const nextSeat = m.active;
    const free = 5;
    const pool = (m.playPools && m.playPools[nextSeat]) || 20;
    m.deadline = Date.now() + (free + Math.max(0, pool)) * 1000;
    m.notice = raisedNotice || (reveal ? revealNotice : "カードを出してください。");
    publish(m, room);
    if (m.seats[m.active].bot) botAction(m, room);
    return;
  }
  const winningEntryObj = winningEntry(m.contract, m.trickNo, m.trick), w = winningEntryObj.seat;
  const taken = m.trick.filter(x => ["10", "J", "Q", "K", "A"].includes(x.card.rank)).map(x => x.card);
  for (const entry of m.trick) {
    if (!entry.feedOpportunity) continue;
    const stat = m.matchStats[entry.seat];
    stat.allyFeedAttempts++;
    if (entry.feedCard && teamOf(w) === teamOf(entry.seat)) { stat.allyFeedSuccesses++; m.roundFeed[entry.seat]++; m.roundArt[entry.seat]++; }
  }
  if (taken.length >= 3 && m.roundDrama[w] < 2) { m.matchStats[w].artAttempts++; if (artfulCard(m, winningEntryObj, m.trick)) { m.roundArt[w]++; m.roundDrama[w]++; m.matchStats[w].dramaticPlays++; } }
  m.seats[w].points += taken.length; m.seats[w].taken.push(...taken); m.seats[w].roundTaken.push(...taken); m.seats[w].roundPoints = (m.seats[w].roundPoints || 0) + taken.length;
  m.lastTrickWinner = w; m.active = w;
  const alliancePointsRaw = m.seats.reduce((n, p, i) => n + (i !== m.contract.nap && (m.contract.solo || i !== m.contract.deputy) ? p.points : 0), 0);
  const alliancePoints = alliancePointsRaw + (m.allianceKittyPoints || 0);
  const napPoints = m.seats.reduce((n, p, i) => n + (i === m.contract.nap || (!m.contract.solo && i === m.contract.deputy) ? p.points : 0), 0);
  m.earlyFinish = alliancePoints > 20 - m.contract.num || (napPoints >= m.contract.num && (m.contract.num === 20 || alliancePoints >= 1));
  const isFinalTrick = m.trickNo >= 9;
  const willFinish = m.earlyFinish || isFinalTrick;
  m.notice = raisedNotice || (napPoints >= m.contract.num ? "ナポレオン軍が立ちを達成しました。" : m.earlyFinish ? "連合軍の獲得得点札で立ちが成立不能になりました。" : reveal ? revealNotice : m.seats[w].player.username + "が場札を取りました。");
  if (willFinish) m.notice = (isFinalTrick ? '最終トリック' : '決着トリック') + '勝者: ' + (m.seats[w].originalPlayerName || m.seats[w].player.username);
  m.phase = "trick-end"; m.deadline = willFinish ? Date.now() + 2200 : Date.now() + 1250;
  publish(m, room);
}

function botAuctionBid(m, seat, room) {
  m.botLevel = 3;
  const a = m.auction, version = a.version;
  if (a.botSeen[seat] >= version || !a.active.includes(seat)) return;
  a.botSeen[seat] = version;
  m.botThinkAt = 0;

  if (a.high.player === seat && a.active.length === 1) {
    auctionDone(m, seat, room);
    return;
  }

  const hand = m.seats[seat].hand;
  const params = m.botStrategy || defaultStrategy();
  const bidSignals = m.seats[seat].bidSignals || { sent: null, received: [], sameColorCount: 0, lastBidAt: 0 };

  let role;
  try {
    role = determineRole(hand, params);
    m.seats[seat].role = role;
  } catch (e) {
    role = { role: 'ALLIANCE', nScore: 0, dScore: 0, dPoints: 0, bestSuit: null, reason: 'error' };
  }

  let decision;
  try {
    decision = decideNextBid(hand, a.high, role, params, bidSignals.received || [], {
      bidHistory: m.bidHistory, mySeat: seat, openKitty: m.openKitty, playedCards: m.playedCards, voids: m.voids, matchScores: m.matchScores, round: m.round
    });
  } catch (e) {
    decision = { type: 'PASS', reason: 'error' };
  }

  if (decision.type === 'BID' && validBid(m, decision.num, decision.suit)) {
    doBid(m, seat, decision.num, decision.suit, room, false);
  } else {
    doApprove(m, seat, room);
  }
}

async function requestHostBotCompute(m, seat, room) {
  if (m.pendingBotRequest) return;
  if (m.hostSeat < 0 || !m.botComputeKeyHex) {
    return serverBotAction(m, seat, room);
  }
  const hostConn = m.seats[m.hostSeat].connId && conns.get(m.seats[m.hostSeat].connId);
  if (!hostConn) return serverBotAction(m, seat, room);

  try {
    const ctx = buildBotContext(m, seat);
    const plaintext = JSON.stringify(ctx);
    const keyBytes = unhex(m.botComputeKeyHex);
    const key = await crypto.subtle.importKey('raw', keyBytes, { name: 'AES-GCM' }, false, ['encrypt']);
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const encrypted = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, new TextEncoder().encode(plaintext));
    const requestId = Math.random().toString(36).slice(2, 10);
    m.pendingBotRequest = {
      seat, requestId, sentAt: Date.now(),
      fallbackTimer: setTimeout(() => {
        if (m.pendingBotRequest && m.pendingBotRequest.requestId === requestId) {
          m.pendingBotRequest = null;
          serverBotAction(m, seat, room);
        }
      }, 8000)
    };
    sendSafe(hostConn, { type: 'compute-bot-turn', requestId, seat, encrypted: { iv: hex(iv), ciphertext: hex(encrypted) } });
  } catch (e) {
    console.warn('requestHostBotCompute failed', e);
    serverBotAction(m, seat, room);
  }
}

function buildBotContext(m, seat) {
  const p = m.seats[seat];
  const legal = legalCards(m, seat);
  const contract = { ...m.contract };
  const params = { ...(m.botStrategy || defaultStrategy()), maxThinkTimeMs: 2000, enableTacticEngine: true };
  return {
    hand: p.hand, legal, trick: m.trick, trickNo: m.trickNo, contract,
    playedCards: m.playedCards, voids: m.voids, seat, deputy: m.contract.deputy,
    discardedKitty: m.discardedKitty || [],
    isMySideNap: seat === contract.nap || (contract.revealedCall && seat === contract.deputy),
    isCurrentNapWinning: false,
    isRevealed: contract.revealedCall,
    isNapLeading: m.trick.length > 0 && m.trick[0].seat === contract.nap,
    lastSeat: m.trick.length === 4,
    params,
    call: m.contract.call,
    currentNapPoints: (m.seats[m.contract.nap].points || 0) + (contract.solo ? 0 : (m.seats[m.contract.deputy]?.points || 0)),
    experience: m.botExperience,
    points: m.seats.map(s => s.points || 0),
    allianceKittyPoints: m.allianceKittyPoints || 0,
    bidHistory: m.bidHistory || [],
    matchScores: m.matchScores || [0, 0, 0, 0, 0],
    round: m.round || 1,
    playoff: m.playoff === true,
    playoffCount: m.playoffCount || 0,
    players: m.seats.map(s => ({ handCount: s.hand.length }))
  };
}

function serverBotAction(m, seat, room) {
  if (m.phase === "play") {
    const legal = legalCards(m, seat);
    if (!legal.length) return;
    const ctx = buildBotContext(m, seat);
    let chosen = null;
    try {
      chosen = chooseCardWithMCTS({ ...ctx, params: { ...ctx.params, maxThinkTimeMs: 2000 } });
    } catch (e) { /* fallback */ }
    if (!chosen || !legal.some(x => x.id === chosen.id)) {
      try { chosen = chooseCardToPlay(ctx); } catch (e) {}
    }
    if (!chosen) chosen = legal[Math.floor(Math.random() * legal.length)];
    playCard(m, seat, chosen.id, room, null);
  }
}

function botAction(m, room) {
  if (!m || m.phase === "result") return;
  m.botLevel = 3;
  const i = m.active, p = m.seats[i];
  if (!p?.bot) return;
  m.lastBot = Date.now();
  m.botThinkAt = 0;
  const params = m.botStrategy || defaultStrategy();

  if (m.phase === "auction") { botAuctionBid(m, i, room); return; }
  if (m.phase === "call") {
    if (m.contract.solo) { const chosen = chooseSoloCall(p.hand); if (chosen) callCard(m, i, chosen.suit, chosen.rank, room); return; }
    const forceSolo = isSoloForcedInMatch(m);
    if (forceSolo) { const chosen = p.hand.slice().sort((a, b) => RANKS.indexOf(a.rank) - RANKS.indexOf(b.rank))[0]; if (chosen) callCard(m, i, chosen.suit, chosen.rank, room); }
    else {
      const receivedSignals = (p.bidSignals?.received || []).filter(s => ['S1', 'S2', 'S3', 'S4'].includes(s.intent));
      const x = chooseDeputyCall(p.hand, m.kitty, m.contract.suit, m.botLevel || 2, m.contract.num, params, m.botExperience, receivedSignals);
      if (x) callCard(m, i, x.suit, x.rank, room);
    }
    return;
  }
  if (m.phase === "discard") {
    const discardContext = {
      num: m.contract.num,
      hasMighty: p.hand.some(c => c.id === '♠A'),
      deputyHasMighty: true,
      protectedCallId: (m.contract.solo && m.contract.call) ? m.contract.call.id : null,
      params
    };
    const drop = chooseDiscard(p.hand, m.contract.suit, discardContext).map(x => x.id);
    discardCards(m, i, drop, room);
    return;
  }
  if (m.phase === "play") {
    requestHostBotCompute(m, i, room);
  }
}

function nextRound(m, room) {
  if (m.phase !== "round-result") return;
  if (!m.playoff || m.playoffCount === 0) {
    m.round++;
  }
  if (m.round > 10 && !m.playoff) m.round = 1;
  m.mult = 1; m.redraws = 0;
  deal(m);
  publish(m, room);
}

async function processAction(conn, msg, room, env) {
  const id = connMatch.get(conn.id), m = id && matches.get(id); if (!m) return;
  const seat = m.seats.findIndex(s => s.connId === conn.id); if (seat < 0) return;
  const a = msg.action || {};

  if (a.type === "bot-move-result" || msg.type === "bot-move-result") {
    if (!m.pendingBotRequest) return;
    if (m.pendingBotRequest.requestId !== (a.requestId || msg.requestId)) return;
    const seatToMove = m.pendingBotRequest.seat;
    const cardId = a.cardId || msg.cardId;
    clearTimeout(m.pendingBotRequest.fallbackTimer);
    m.pendingBotRequest = null;
    if (!cardId) { serverBotAction(m, seatToMove, room); return; }
    const legal = legalCards(m, seatToMove);
    if (!legal.some(x => x.id === cardId)) { serverBotAction(m, seatToMove, room); return; }
    playCard(m, seatToMove, cardId, room, env);
    return;
  }

  if (a.type === "declare-win") {
    if (m.phase !== "play" || m.active !== seat || m.trick.length > 0) return;
    const deputyPts = (!m.contract.solo && m.contract.deputy >= 0) ? (m.seats[m.contract.deputy].points || 0) : 0;
    const currentNapPoints = (m.seats[m.contract.nap].points || 0) + deputyPts;
    const ctx = {
      hand: m.seats[seat].hand, trick: [], trickNo: m.trickNo, contract: m.contract,
      playedCards: m.playedCards, voids: m.voids, seat,
      discardedKitty: m.discardedKitty,
      players: m.seats.map(s => ({ handCount: s.hand.length })),
      points: m.seats.map(s => s.points || 0),
      allianceKittyPoints: m.allianceKittyPoints || 0,
      currentNapPoints,
    };
    if (canDeclareWin(ctx)) {
      m.winDeclaration = { seat, hand: [...m.seats[seat].hand], declaredAt: Date.now(), expiresAt: Date.now() + 5000 };
      m.phase = "win-declaration"; m.deadline = Date.now() + 5000;
      m.notice = (m.seats[seat].originalPlayerName || m.seats[seat].player.username) + " が上がり宣言！手札を確認してください。";
      publish(m, room);
    } else {
      sendSafe(conn, { type: "room-error", message: "上がり宣言の条件を満たしていません。" });
    }
    return;
  }

  if (a.type === "appeal") return answerAppealOffer(m, seat, true, room);
  if (a.type === "skip-appeal") return answerAppealOffer(m, seat, false, room);
  if (a.type === "appeal-declare") return answerAppealResponse(m, seat, "declare", room);
  if (a.type === "appeal-stand") return answerAppealResponse(m, seat, "stand", room);
  if (a.type === "next-round") return nextRound(m, room);
  if (a.type === "auction-activity") {
    if (m.phase === "auction" && m.auction.active.includes(seat)) { m.auction.lastAction[seat] = Date.now(); m.auction.autoApprove[seat] = false; }
    return;
  }
  if (a.type === "confirm-call") {
    if (m.phase !== "call-reveal" || m.contract.ready[seat]) return;
    m.contract.ready[seat] = true;
    if (m.contract.ready.every((ready, i) => ready || m.seats[i].bot)) startPlay(m, room);
    else { m.notice = "指名カードの確認中です。"; publish(m, room); }
    return;
  }
  if (a.type === "confirm-auction") {
    if (m.phase === "auction" && m.auction.needsHumanConfirm && m.auction.high.player === seat) {
      m.auction.needsHumanConfirm = false;
      auctionDone(m, seat, room, true);
    }
    return;
  }
  if (a.type === "reopen-auction") {
    if (m.phase === "auction" && m.auction.needsHumanConfirm && m.auction.high.player === seat) {
      m.auction.needsHumanConfirm = false;
      m.auction.approved = Array(5).fill(false);
      m.auction.botSeen = Array(5).fill(-1);
      const now = Date.now();
      m.auction.botAt = m.seats.map(() => now + 4000);
      m.notice = m.seats[seat].player.username + ' がまだ上げることを選びました';
      publish(m, room);
    }
    return;
  }
  if (a.type === "approve" || a.type === "pass") doApprove(m, seat, room);
  else if (a.type === "bid") doBid(m, seat, Number(a.num), a.suit, room, a.solo === true);
  else if (a.type === "call") callCard(m, seat, a.suit, a.rank, room);
  else if (a.type === "discard") discardCards(m, seat, a.cards, room);
  else if (a.type === "play") playCard(m, seat, a.card, room, env);
}

async function saveEnd(m, room, env) { await finish(m, room, env); }

function timeoutAction(m, room) {
  const i = m.active, p = m.seats[i], params = m.botStrategy || defaultStrategy(), experience = m.botExperience || null;
  if (m.phase === "call") {
    if (m.contract.solo) { const chosen = chooseSoloCall(p.hand); if (chosen) callCard(m, i, chosen.suit, chosen.rank, room); return; }
    const forceSolo = isSoloForcedInMatch(m);
    if (forceSolo) { const chosen = p.hand.slice().sort((a, b) => RANKS.indexOf(a.rank) - RANKS.indexOf(b.rank))[0]; if (chosen) callCard(m, i, chosen.suit, chosen.rank, room); }
    else {
      const receivedSignals = (p.bidSignals?.received || []).filter(s => ['S1', 'S2', 'S3', 'S4'].includes(s.intent));
      const x = chooseDeputyCall(p.hand, m.kitty, m.contract.suit, m.botLevel || 2, m.contract.num, params, experience, receivedSignals);
      if (x) callCard(m, i, x.suit, x.rank, room);
    }
  } else if (m.phase === "discard") {
    const discardContext = {
      num: m.contract.num,
      hasMighty: p.hand.some(c => c.id === '♠A'),
      deputyHasMighty: true,
      protectedCallId: (m.contract.solo && m.contract.call) ? m.contract.call.id : null,
      params
    };
    const ids = chooseDiscard(p.hand, m.contract.suit, discardContext).map(x => x.id);
    discardCards(m, i, ids, room);
  } else if (m.phase === "play") {
    const c = legalCards(m, i).slice().sort((a, b) => RANKS.indexOf(a.rank) - RANKS.indexOf(b.rank))[0];
    if (c) playCard(m, i, c.id, room, null);
  }
}

export const room = {
  tickMs: 500,
  async onConnect(conn, room) {
    if (conns.size >= 180) { conn.close(4003, "Room capacity reached"); return; }
    conns.set(conn.id, conn);
    sendSafe(conn, { type: "connected" });
    const presence = { type: "presence", count: conns.size };
    sendSafe(conn, presence);
    room.broadcast(presence, { except: [conn.id] });
  },
  async onMessage(conn, raw, room, env) {
    let msg; try { msg = typeof raw === "string" ? JSON.parse(raw) : raw; } catch { return; }

    if (msg.type === "chat") {
      const text = String(msg.text || "").slice(0, 200).trim();
      const name = String(msg.name || "ゲスト").slice(0, 20);
      if (!text) return;
      const now = Date.now();
      if (now - (conn._lastChatAt || 0) < 1500) {
        sendSafe(conn, { type: "room-error", message: "チャットは少し間隔をあけてください" });
        return;
      }
      conn._lastChatAt = now;
      const chatMsg = { type: "chat-message", from: name, fromId: conn.id, text, at: now };
      for (const c of conns.values()) sendSafe(c, chatMsg);
      return;
    }

    if (msg.type === "reconnect") {
      if (!msg.sessionToken) { sendSafe(conn, { type: "reconnect-failed" }); return; }
      try {
        const sess = await env.DB.prepare("SELECT user_id FROM sessions WHERE token=? AND expires_at>?").bind(msg.sessionToken, Date.now()).first();
        if (!sess) { sendSafe(conn, { type: "reconnect-failed" }); return; }
        const userId = sess.user_id;
        conn.authUserId = userId;
        conn.authSessionToken = msg.sessionToken;
        const oldMatchId = connMatch.get(conn.id);
        if (oldMatchId) connMatch.delete(conn.id);
        let foundMatch = null, foundSeat = -1;
        for (const m of matches.values()) {
          if (m.phase === "result") continue;
          for (let i = 0; i < m.seats.length; i++) {
            const s = m.seats[i];
            if (s.originalUserId === userId && s.bot === true && s.connId === null) { foundMatch = m; foundSeat = i; break; }
          }
          if (foundMatch) break;
        }
        if (!foundMatch) { sendSafe(conn, { type: "reconnect-failed" }); return; }
        const seat = foundMatch.seats[foundSeat];
        seat.connId = conn.id;
        seat.bot = false;
        seat.abandoned = false;
        seat.player.username = seat.originalPlayerName || "player";
        seat.player.playerId = seat.originalPlayerId || "player";
        if (foundMatch.kind === "ranked") seat.player.userId = userId;
        seat.player.sessionToken = msg.sessionToken;
        seat.disconnectedAt = null;
        connMatch.set(conn.id, foundMatch.id);
        if (foundMatch.kind === "ranked") rankedUsers.set(userId, conn.id);
        sendSafe(conn, { type: "reconnected", matchId: foundMatch.id, mode: foundMatch.kind, seat: foundSeat });
        publish(foundMatch, room);
        return;
      } catch (e) { console.error("reconnect failed", e); sendSafe(conn, { type: "reconnect-failed" }); return; }
    }

    if (msg.type === "join") {
      if (msg.sessionToken) {
        const sess = await env.DB.prepare("SELECT user_id FROM sessions WHERE token=? AND expires_at>?").bind(msg.sessionToken, Date.now()).first();
        if (sess) {
          conn.authUserId = sess.user_id;
          conn.authSessionToken = msg.sessionToken;
          const prof = await env.DB.prepare("SELECT player_id AS id,rating,games FROM players WHERE user_id=?").bind(sess.user_id).first();
          if (prof) conn.authProfile = prof;
        }
      }
      const mode = msg.mode === "ranked" ? "ranked" : "friend";
      const browserId = (typeof msg.browserId === "string" && msg.browserId) ? msg.browserId.slice(0, 64) : null;

      if (mode === "ranked") {
        if (!conn.authUserId) { sendSafe(conn, { type: "room-error", message: "レートバトルはプレイヤー登録（ログイン）が必要です" }); return; }
        if (rankedUsers.has(conn.authUserId)) { sendSafe(conn, { type: "room-error", message: "このアカウントはすでに待機中または対戦中です" }); return; }
        if (connMatch.has(conn.id)) { sendSafe(conn, { type: "room-error", message: "既に対戦中です" }); return; }
        if (browserId && queues.ranked.some(x => x.browserId === browserId)) { sendSafe(conn, { type: "room-error", message: "同じブラウザから複数のタブで待機することはできません" }); return; }
        let player;
        try { player = await getProfile(env, conn); }
        catch (error) { sendSafe(conn, { type: "room-error", message: "プレイヤー情報を確認できませんでした。再度お試しください" }); return; }
        if (!conns.has(conn.id)) return;
        const entry = { id: conn.id, player, conn, joined: Date.now(), browserId };
        rankedUsers.set(conn.authUserId, conn.id);
        queues.ranked.push(entry);
        queues.ranked.sort((a, b) => a.joined - b.joined);
        broadcastQueueStatus();
        return;
      }

      if (connMatch.has(conn.id)) { sendSafe(conn, { type: "room-error", message: "既に対戦中です" }); return; }
      let entryCode = String(msg.code || "").toUpperCase().slice(0, 8);
      if (!entryCode) entryCode = makeCode();
      let l = friendRooms.get(entryCode);
      if (!l) { l = { code: entryCode, host: conn.id, players: [], created: Date.now(), timeoutAt: Date.now() + 300000 }; friendRooms.set(entryCode, l); }
      let player; try { player = await getProfile(env, conn); } catch (error) { sendSafe(conn, { type: "room-error", message: "プレイヤー情報を確認できませんでした。再度お試しください" }); return; }
      if (!conns.has(conn.id)) return;
      if (l.players.some(x => x.id === conn.id || (player.userId && x.player.userId === player.userId))) { sendSafe(conn, { type: "room-error", message: "このプレイヤーはすでに部屋にいます" }); return; }
      if (browserId && l.players.some(x => x.browserId === browserId)) { sendSafe(conn, { type: "room-error", message: "同じブラウザから複数のタブで同じ部屋に参加することはできません" }); return; }
      if (l.players.length >= 5) { sendSafe(conn, { type: "room-error", message: "この部屋は満員です" }); return; }
      const entry = { id: conn.id, player, conn, joined: Date.now(), code: entryCode, browserId };
      l.players.push(entry);
      l.players.forEach(x => sendSafe(x.conn, { type: "friend-lobby", code: l.code, count: l.players.length, host: x.id === l.host }));
      sendSafe(conn, { type: "lobby", text: "合言葉 " + l.code + " · " + l.players.length + "/5人" });
      if (l.players.length >= 5) { friendRooms.delete(l.code); beginMatch("friend", l.code, l.players, room, env); }
      return;
    }

    if (msg.type === "start-now") {
      let roomCode = null;
      for (const [code, l] of friendRooms) if (l.host === conn.id) { roomCode = code; break; }
      if (roomCode) { const l = friendRooms.get(roomCode); friendRooms.delete(roomCode); beginMatch("friend", l.code, l.players, room, env); }
      return;
    }

    if (msg.type === "leave-room") {
      for (const [c, l] of friendRooms) {
        l.players = l.players.filter(x => x.id !== conn.id);
        if (!l.players.length) { friendRooms.delete(c); continue; }
        if (l.host === conn.id) l.host = l.players[0].id;
        l.players.forEach(x => sendSafe(x.conn, { type: "friend-lobby", code: l.code, count: l.players.length, host: x.id === l.host }));
      }
      return;
    }

    if (msg.type === "cancel-queue") {
      const queueIndex = queues.ranked.findIndex(x => x.id === conn.id);
      if (queueIndex >= 0) {
        queues.ranked.splice(queueIndex, 1);
        if (conn.authUserId && rankedUsers.get(conn.authUserId) === conn.id) rankedUsers.delete(conn.authUserId);
      }
      sendSafe(conn, { type: "queue-cancelled" });
      broadcastQueueStatus();
      return;
    }
    if (msg.type === "game") return processAction(conn, msg, room, env);
  },
  async onTick(room, env) {
    const now = Date.now(), rankedQueue = queues.ranked;

    for (const [code, l] of friendRooms) {
      if (now >= l.timeoutAt) {
        friendRooms.delete(code);
        if (l.players.length > 0) beginMatch("friend", l.code, l.players, room, env);
      }
    }

    if (rankedQueue.length >= 5) {
      const live = rankedQueue.filter(x => conns.has(x.id) && x.player.userId);
      const seenUsers = new Set(), seenBrowsers = new Set(), dedup = [];
      for (const x of live) {
        if (seenUsers.has(x.player.userId)) continue;
        if (x.browserId && seenBrowsers.has(x.browserId)) continue;
        seenUsers.add(x.player.userId);
        if (x.browserId) seenBrowsers.add(x.browserId);
        dedup.push(x);
      }
      queues.ranked = dedup;
      if (dedup.length >= 5) {
        const group = queues.ranked.splice(0, 5);
        beginMatch("ranked", "", group, room, env);
        broadcastQueueStatus();
      }
    }

    for (const [c, l] of friendRooms) if (now - l.created > 900000) friendRooms.delete(c);

    for (const [id, m] of matches) {
      if (now - m.created > 3 * 60 * 60 * 1000) {
        matches.delete(id);
        for (const s of m.seats) { if (s.originalUserId) rankedUsers.delete(s.originalUserId); if (s.connId) connMatch.delete(s.connId); }
      }
    }

    for (const m of matches.values()) {
      if (m.phase === "prep" && now >= m.deadline) {
        const rule = m.round >= 10 ? finalAuctionRule(m.matchScores, m.mult) : null;
        m.phase = "auction";
        m.auction = {
          active: rule ? rule.eligible : [0, 1, 2, 3, 4],
          approved: Array(5).fill(false),
          minBid: rule?.minBid || 13,
          high: { num: 12, suit: "", player: -1, solo: false },
          version: 0, startedAt: now,
          lastAction: Array(5).fill(now),
          autoApprove: Array(5).fill(false),
          botBids: Array(5).fill(0),
          botSeen: Array(5).fill(-1),
          botAt: m.seats.map(() => now + 4000),
          requiredBidSeat: null,
          bidPlans: {},
          needsHumanConfirm: false
        };
        m.properBids = [13, 13, 13, 13, 13];
        m.properPlans = [null, null, null, null, null];
        m.auctionStartAt = now;
        m.properRecomputed = false;

        const params = m.botStrategy || defaultStrategy();
        for (let seat = 0; seat < 5; seat++) {
          try {
            const role = determineRole(m.seats[seat].hand, params);
            m.seats[seat].role = role;
            if (role.role === 'NAP') {
              const proper = computeProperBid(m.seats[seat].hand, role.bestSuit || '♠', params, seat, m.seats[seat].bidSignals, m.matchScores, m.openKitty, m.playedCards, m.voids, [], m.round);
              m.properBids[seat] = proper.properBid > 0 ? proper.properBid : 13;
              m.properPlans[seat] = proper.plan;
            }
          } catch (e) { console.warn("determineRole failed for seat", seat, e?.message); }
        }

        m.active = -1; m.deadline = 0;
        if (rule) {
          m.appeal = { bottomSeat: rule.bottomSeat, fourthSeat: rule.fourthSeat };
          m.appealInfo = ""; m.phase = "appeal-offer"; m.active = rule.bottomSeat; m.deadline = now + 30000;
          m.notice = "5位は4位にJ・マイティの所持を尋ねられます。";
          publish(m, room);
          if (m.seats[rule.bottomSeat].bot) answerAppealOffer(m, rule.bottomSeat, true, room);
        } else {
          m.appeal = null; m.appealInfo = "";
          m.notice = "競り開始です。宣言するか、承認して競りを降りてください。";
          publish(m, room);
        }
      } else if (m.phase === "appeal-offer") {
        if (now >= m.deadline) answerAppealOffer(m, m.appeal.bottomSeat, false, room);
      } else if (m.phase === "appeal-response") {
        if (m.seats[m.active]?.bot) answerAppealResponse(m, m.active, "declare", room);
        else if (now >= m.deadline) answerAppealResponse(m, m.active, "stand", room);
      } else if (m.phase === "auction") {
        for (const seat of m.auction.active.slice()) {
          if (!m.seats[seat].bot && !m.auction.approved[seat] && !m.auction.autoApprove[seat] && now - (m.auction.lastAction[seat] || m.auction.startedAt) >= 30000) {
            if (m.auction.needsHumanConfirm && seat === m.auction.high.player) {
              m.auction.needsHumanConfirm = false;
              auctionDone(m, seat, room, true);
              break;
            }
            doApprove(m, seat, room, true);
          }
          if (m.phase !== "auction") break;
        }
        for (let seat = 0; seat < m.seats.length && m.phase === "auction"; seat++) {
          if (m.seats[seat].bot && m.auction.active.includes(seat) && !m.auction.approved[seat] && m.auction.botSeen[seat] < m.auction.version && now >= m.auction.botAt[seat]) {
            botAuctionBid(m, seat, room);
          }
        }
        if (m.phase === "auction" && m.auction.active.length === 0 && m.auction.high.player >= 0) {
          auctionDone(m, m.auction.high.player, room);
        }
      } else if (m.phase === "call-reveal") {
        if (now >= m.deadline) startPlay(m, room);
      } else if (m.phase === "call" || m.phase === "discard") {
        if (m.seats[m.active]?.bot) {
          if (!m.botThinkAt) m.botThinkAt = now + 1000 + Math.random() * 1500;
          if (now >= m.botThinkAt) { m.botThinkAt = 0; botAction(m, room); }
        }
        else if (m.deadline && now >= m.deadline) { m.notice = "持ち時間が切れたため、自動で進行します。"; timeoutAction(m, room); }
      } else if (m.phase === "play") {
        const activeSeat = m.active;
        if (m.seats[activeSeat]?.bot) {
          if (!m.botThinkAt) m.botThinkAt = now + 1000 + Math.random() * 1500;
          if (now >= m.botThinkAt) { m.botThinkAt = 0; botAction(m, room); }
        } else {
          const legal = legalCards(m, activeSeat);
          if (legal.length === 1) {
            if (!m.humanAutoPlayAt) m.humanAutoPlayAt = now + 1500;
            else if (now >= m.humanAutoPlayAt) { m.humanAutoPlayAt = null; m.notice = "出すカードが1枚しかないため、自動で出します。"; publish(m, room); playCard(m, activeSeat, legal[0].id, room, env); }
          } else {
            m.humanAutoPlayAt = null;
            if (m.deadline && now >= m.deadline) { m.notice = "持ち時間が切れたため、自動で進行します。"; timeoutAction(m, room); }
          }
        }
      } else if (m.phase === "win-declaration" && now >= m.deadline) {
        const winSeat = m.winDeclaration.seat;
        let allTaken = [];
        m.seats.forEach(s => allTaken.push(...s.hand));
        const taken = allTaken.filter(c => ["10", "J", "Q", "K", "A"].includes(c.rank));
        m.seats[winSeat].points += taken.length;
        m.seats[winSeat].taken.push(...taken);
        m.seats[winSeat].roundTaken.push(...taken);
        m.seats[winSeat].roundPoints = (m.seats[winSeat].roundPoints || 0) + taken.length;
        m.seats.forEach(s => s.hand = []);
        m.trickNo = 10;
        m.phase = "trick-end";
        m.deadline = Date.now() + 2200;
        m.notice = "上がり宣言により、残りのトリックをすべて獲得しました。";
        publish(m, room);
      } else if (m.phase === "round-result" && now >= m.deadline) {
        nextRound(m, room);
      } else if (m.phase === "trick-end" && now >= m.deadline) {
        if (m.earlyFinish) { await saveEnd(m, room, env); continue; }
        m.trickNo++;
        if (m.trickNo >= 10) await saveEnd(m, room, env);
        else {
          m.trick = []; m.phase = "play";
          m.turnStartAt = Date.now();
          const free = 5;
          const pool = (m.playPools && m.playPools[m.active]) || 20;
          m.deadline = Date.now() + (free + Math.max(0, pool)) * 1000;
          m.humanAutoPlayAt = null; m.botThinkAt = null; m.notice = "次の勝負です。";
          publish(m, room);
          if (m.seats[m.active].bot) botAction(m, room);
        }
      } else if (m.phase === "redeal" && now >= m.deadline) {
        deal(m); publish(m, room);
      }
    }
  },
  async onClose(conn, room) {
    const id = connMatch.get(conn.id);
    conns.delete(conn.id);
    queues.ranked = queues.ranked.filter(x => x.id !== conn.id);
    const uid = conn.authUserId || conn.userId;
    if (!id && uid && rankedUsers.get(uid) === conn.id) rankedUsers.delete(uid);
    for (const [c, l] of friendRooms) {
      l.players = l.players.filter(x => x.id !== conn.id);
      if (!l.players.length) { friendRooms.delete(c); continue; }
      if (l.host === conn.id) l.host = l.players[0].id;
      l.players.forEach(x => sendSafe(x.conn, { type: "friend-lobby", code: l.code, count: l.players.length, host: x.id === l.host }));
    }
    connMatch.delete(conn.id);
    if (id) {
      const m = matches.get(id);
      if (m) {
        const s = m.seats.find(x => x.connId === conn.id);
        if (s) {
          if (!s.originalUserId) s.originalUserId = s.player.userId || (conn.authUserId || null);
          if (!s.originalPlayerName) s.originalPlayerName = s.player.username;
          if (!s.originalPlayerId) s.originalPlayerId = s.player.playerId;
          s.disconnectedAt = Date.now();
          s.bot = true;
          s.abandoned = true;
          s.connId = null;
          s.player.username = "COM";
          s.player.playerId = "COM";
          if (m.phase !== "result") m.notice = (s.originalPlayerName || "プレイヤー") + "が切断しました。COM操作になります。";
          if (m.hostSeat === m.seats.indexOf(s)) {
            const newHost = m.seats.findIndex(seat => seat.connId && !seat.bot);
            m.hostSeat = newHost;
            if (newHost >= 0 && m.botComputeKeyHex) {
              try {
                const hostConn = conns.get(m.seats[newHost].connId);
                if (hostConn) sendSafe(hostConn, { type: 'bot-compute-key', keyHex: m.botComputeKeyHex });
              } catch (e) { console.warn('host key transfer failed', e); }
            }
          }
        }
        publish(m, room);
      }
    }
    broadcastQueueStatus();
    const presence = { type: "presence", count: conns.size };
    room.broadcast(presence);
  }
};
// ===== [worker.js 完成] =====

