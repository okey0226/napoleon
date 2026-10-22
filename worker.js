import { SUITS, RANKS, SV, CALIBRATION, defaultStrategy, shuffledDeck, sortHand, sweetSpotFactor, estimatedWinRate, SWEET_SPOT_BONUS, findMaxHonestBid, matchRatingChanges, computeEloDelta, ELO_INIT, PARAM_BOUNDS } from './constants.js';
import { winningEntry, cardPower, shouldBid, chooseDiscard, chooseDeputyCall, chooseCardToPlay, chooseDeputyCard, isTrump, strongestSuit, chooseSoloCall, handStrength, colorStrength, ntHandStrength } from './ai-tactics.js';
import { runSelfPlayBatch, generateInsights } from './ai-simulator.js';

function safeJsonParse(str, fallback = null) {
  try { if (typeof str !== 'string' || !str.trim()) return fallback; return JSON.parse(str); }
  catch (e) { console.warn('worker JSON parse failed:', e.message); return fallback; }
}

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
  "CREATE INDEX IF NOT EXISTS sessions_user ON sessions(user_id)",
  "CREATE TABLE IF NOT EXISTS player_elo (user_id TEXT PRIMARY KEY, elo INTEGER NOT NULL DEFAULT 1000)",
  "CREATE TABLE IF NOT EXISTS human_win_patterns (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id TEXT, player_id TEXT, rank INTEGER NOT NULL DEFAULT 0, won_as_nap INTEGER NOT NULL DEFAULT 0, won_as_deputy INTEGER NOT NULL DEFAULT 0, won_as_ally INTEGER NOT NULL DEFAULT 0, avg_bid REAL NOT NULL DEFAULT 0, exact_wins INTEGER NOT NULL DEFAULT 0, solo_wins INTEGER NOT NULL DEFAULT 0, match_rating_delta REAL NOT NULL DEFAULT 0, contracts_json TEXT, ai_weights_snapshot TEXT, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)",
  "CREATE INDEX IF NOT EXISTS human_win_delta ON human_win_patterns(match_rating_delta DESC)",
  "CREATE TABLE IF NOT EXISTS ai_bid_experience (id INTEGER PRIMARY KEY AUTOINCREMENT, strength_key REAL NOT NULL, trump_type TEXT NOT NULL, num INTEGER NOT NULL, wins INTEGER NOT NULL DEFAULT 0, samples INTEGER NOT NULL DEFAULT 0, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)",
  "CREATE UNIQUE INDEX IF NOT EXISTS ai_bid_exp_key ON ai_bid_experience(strength_key, trump_type, num)",
  "CREATE TABLE IF NOT EXISTS ai_call_experience (id INTEGER PRIMARY KEY AUTOINCREMENT, call_id TEXT NOT NULL, trump_suit TEXT NOT NULL, wins INTEGER NOT NULL DEFAULT 0, samples INTEGER NOT NULL DEFAULT 0, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)",
  "CREATE UNIQUE INDEX IF NOT EXISTS ai_call_exp_key ON ai_call_experience(call_id, trump_suit)",
  "CREATE TABLE IF NOT EXISTS ai_play_experience (id INTEGER PRIMARY KEY AUTOINCREMENT, role TEXT NOT NULL, phase TEXT NOT NULL, points_tier TEXT NOT NULL, rank_tier TEXT NOT NULL, wins INTEGER NOT NULL DEFAULT 0, samples INTEGER NOT NULL DEFAULT 0, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)",
  "CREATE UNIQUE INDEX IF NOT EXISTS ai_play_exp_key ON ai_play_experience(role, phase, points_tier, rank_tier)"
];

const queues = { ranked: [] }, rankedUsers = new Map(), conns = new Map(), friendRooms = new Map(), matches = new Map(), connMatch = new Map();

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

let __cachedExperience = null, __cachedExperienceTime = 0;
async function loadExperience(env) {
  if (__cachedExperience && Date.now() - __cachedExperienceTime < 60000) return __cachedExperience;
  const map = { bids: {}, calls: {}, plays: {} };
  try {
    const [bids, calls, plays] = await Promise.all([
      env.DB.prepare("SELECT strength_key, trump_type, num, wins, samples FROM ai_bid_experience WHERE samples > 0").all(),
      env.DB.prepare("SELECT call_id, trump_suit, wins, samples FROM ai_call_experience WHERE samples > 0").all(),
      env.DB.prepare("SELECT role, phase, points_tier, rank_tier, wins, samples FROM ai_play_experience WHERE samples > 0").all()
    ]);
    for (const r of (bids.results || [])) map.bids[`${r.strength_key}:${r.trump_type}:${r.num}`] = { wins: r.wins, samples: r.samples };
    for (const r of (calls.results || [])) map.calls[`${r.call_id}:${r.trump_suit}`] = { wins: r.wins, samples: r.samples };
    for (const r of (plays.results || [])) map.plays[`${r.role}:${r.phase}:${r.points_tier}:${r.rank_tier}`] = { wins: r.wins, samples: r.samples };
  } catch (e) { console.warn("experience load failed", e); }
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

export default {
  async scheduled(event, env, ctx) {
    if (!globalThis.__dbInitialized) { try { await forceInitDB(env); globalThis.__dbInitialized = true; } catch (e) { console.error("DB init failed on cron", e); } }
    ctx.waitUntil(runSelfPlayBatch(env, 1000).catch(e => console.error("scheduled self-play failed", e)));
    ctx.waitUntil(env.DB.prepare("DELETE FROM sessions WHERE expires_at<?").bind(Date.now()).run().catch(e => console.error("session cleanup failed", e)));
  },
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/api/setup-db") {
      try {
        await forceInitDB(env);
        if (url.searchParams.get("reset") === "ai") {
          await env.DB.batch([
            env.DB.prepare("DELETE FROM ai_strategy_log"),
            env.DB.prepare("DELETE FROM ai_weights"),
            env.DB.prepare("DELETE FROM ai_bid_experience"),
            env.DB.prepare("DELETE FROM ai_call_experience"),
            env.DB.prepare("DELETE FROM ai_play_experience")
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
          try { await env.DB.prepare("INSERT INTO players(user_id,username,player_id,salt,password_hash) VALUES(?,?,?,?,?)").bind(userId, id, id, hex(salt), digest).run(); } catch { return response({ error: "そのIDはすでに使われています" }, 409); }
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
          env.DB.prepare("INSERT OR IGNORE INTO player_elo(user_id) VALUES(?)").bind(userId)
        ]);
        const token = hex(crypto.getRandomValues(new Uint8Array(32)));
        const expiresAt = Date.now() + 30 * 24 * 3600 * 1000;
        await env.DB.prepare("INSERT INTO sessions(token,user_id,expires_at) VALUES(?,?,?)").bind(token, userId, expiresAt).run();
        const player = await env.DB.prepare("SELECT player_id AS id,rating,wins,losses,games FROM players WHERE user_id=?").bind(userId).first();
        return response({ ...player, sessionToken: token });
      }
      if (request.method === "GET" && url.pathname === "/api/account/me") {
        const token = request.headers.get("x-session-token");
        let userId = null;
        if (token) { const sess = await env.DB.prepare("SELECT user_id FROM sessions WHERE token=? AND expires_at>?").bind(token, Date.now()).first(); if (sess) userId = sess.user_id; }
        if (!userId) { const who = signed(request); if (who) userId = who.id; }
        if (!userId) return response({ error: "認証情報が必要です" }, 401);
        const p = await env.DB.prepare("SELECT player_id AS id,username,rating,wins,losses,games FROM players WHERE user_id=?").bind(userId).first();
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
        return response({ ...p, performance, precision, artRate, allyFeed, boldBid, ranks: { rating: ratingRank.ahead + 1 }, performanceRanks, matchStats, history: historyPage.results });
      }
      if (request.method === "GET" && url.pathname === "/api/rating/top") {
        const { results } = await env.DB.prepare("SELECT p.player_id AS id, p.username, p.rating, p.wins, p.losses, p.games FROM players p ORDER BY p.rating DESC, p.games DESC LIMIT 50").all();
        return response(results);
      }
      if (request.method === "GET" && url.pathname === "/api/ai/weights") { try { const w = await env.DB.prepare("SELECT weights,games FROM ai_weights WHERE id=1").first(); return response(w || { weights: '{}', games: 0 }); } catch (e) { return response({ weights: '{}', games: 0 }); } }

      if (request.method === "GET" && url.pathname === "/api/ai/experience") {
        try { const exp = await loadExperience(env); return response(exp); }
        catch (e) { return response({ bids: {}, calls: {}, plays: {} }); }
      }

      if (request.method === "POST" && url.pathname === "/api/ai/learn") {
        let body; try { body = await request.json(); } catch { return response({ error: "invalid" }, 400); }
        try {
          const stmts = [];
          const wonRound = body.wonRound === true;
          if (body.bid && Number.isFinite(Number(body.bid.strengthKey)) && body.bid.trumpType) {
            stmts.push(env.DB.prepare(
              "INSERT INTO ai_bid_experience(strength_key,trump_type,num,wins,samples) VALUES(?,?,?,?,1) ON CONFLICT(strength_key,trump_type,num) DO UPDATE SET wins=wins+excluded.wins, samples=samples+1, updated_at=CURRENT_TIMESTAMP"
            ).bind(Number(body.bid.strengthKey), String(body.bid.trumpType), Number(body.bid.num), wonRound ? 1 : 0));
          }
          if (body.call && body.call.callId && body.call.trumpSuit) {
            stmts.push(env.DB.prepare(
              "INSERT INTO ai_call_experience(call_id,trump_suit,wins,samples) VALUES(?,?,?,1) ON CONFLICT(call_id,trump_suit) DO UPDATE SET wins=wins+excluded.wins, samples=samples+1, updated_at=CURRENT_TIMESTAMP"
            ).bind(String(body.call.callId), String(body.call.trumpSuit), wonRound ? 1 : 0));
          }
          if (Array.isArray(body.playDecisions)) {
            for (const d of body.playDecisions) {
              if (!d || !d.role || !d.phase || !d.pointsTier || !d.rankTier) continue;
              stmts.push(env.DB.prepare(
                "INSERT INTO ai_play_experience(role,phase,points_tier,rank_tier,wins,samples) VALUES(?,?,?,?,?,1) ON CONFLICT(role,phase,points_tier,rank_tier) DO UPDATE SET wins=wins+excluded.wins, samples=samples+1, updated_at=CURRENT_TIMESTAMP"
              ).bind(String(d.role), String(d.phase), String(d.pointsTier), String(d.rankTier), d.won ? 1 : 0));
            }
          }
          if (stmts.length) await env.DB.batch(stmts);
          try {
            await env.DB.batch([
              env.DB.prepare("UPDATE ai_bid_experience SET wins=CAST(wins*0.5 AS INTEGER), samples=CAST(samples*0.5 AS INTEGER) WHERE samples > 200"),
              env.DB.prepare("UPDATE ai_call_experience SET wins=CAST(wins*0.5 AS INTEGER), samples=CAST(samples*0.5 AS INTEGER) WHERE samples > 200"),
              env.DB.prepare("UPDATE ai_play_experience SET wins=CAST(wins*0.5 AS INTEGER), samples=CAST(samples*0.5 AS INTEGER) WHERE samples > 200")
            ]);
          } catch { }
          __cachedExperience = null; __cachedExperienceTime = 0;
          return response({ ok: true, applied: stmts.length });
        } catch (e) { console.error("learn failed", e); return response({ error: "learn failed" }, 500); }
      }

      if (request.method === "POST" && url.pathname === "/api/ai/report") {
        let body; try { body = await request.json(); } catch { return response({ error: "invalid" }, 400); }
        try {
          const w = await env.DB.prepare("SELECT weights,games FROM ai_weights WHERE id=1").first();
          const weights = safeJsonParse(w?.weights, {}) || {};
          const base = defaultStrategy();
          const isMatchEnd = body.wonMatch !== undefined;
          const wonMatch = body.wonMatch === true;
          const lr = wonMatch ? 0.02 : 0.005;
          if (body.napoleonWon) {
            weights.bidThreshold = Math.max(2.0, (weights.bidThreshold ?? base.bidThreshold) - lr);
            weights.leadAggression = Math.min(1.0, (weights.leadAggression ?? base.leadAggression) + lr);
            weights.followAggression = Math.min(1.0, (weights.followAggression ?? base.followAggression) + lr * 0.5);
          } else {
            weights.bidThreshold = Math.min(6.0, (weights.bidThreshold ?? base.bidThreshold) + lr);
            weights.leadAggression = Math.max(0.2, (weights.leadAggression ?? base.leadAggression) - lr);
            weights.followAggression = Math.max(0.1, (weights.followAggression ?? base.followAggression) - lr * 0.5);
          }
          if (body.exactWins > 1) { weights.riskTolerance = Math.min(1.0, (weights.riskTolerance ?? base.riskTolerance) + lr * 0.3); weights.trumpBonus = Math.min(1.5, (weights.trumpBonus ?? base.trumpBonus) + lr * 0.2); }
          if (body.lastPlacePenalty > 0) { weights.riskTolerance = Math.max(0.1, (weights.riskTolerance ?? base.riskTolerance) - lr * 0.3); }

          if (isMatchEnd && wonMatch && body.aiWeights && typeof body.aiWeights === "object") {
            const blend = 0.3;
            for (const [k, [lo, hi]] of Object.entries(PARAM_BOUNDS)) {
              const cur = Number(weights[k] ?? base[k]);
              const snap = Number(body.aiWeights[k] ?? cur);
              if (!Number.isFinite(cur) || !Number.isFinite(snap)) continue;
              weights[k] = Math.max(lo, Math.min(hi, cur * (1 - blend) + snap * blend));
            }
            const qualityBoost = Math.max(0.5, Math.min(2.0, (Number(body.matchRatingDelta) || 0) / 10 + 1));
            const roleLR = 0.05 * qualityBoost;
            if ((body.playerWonAsNap || 0) > 0) {
              weights.bidThreshold = Math.max(2.0, (weights.bidThreshold ?? base.bidThreshold) - roleLR);
              weights.riskTolerance = Math.min(1.0, (weights.riskTolerance ?? base.riskTolerance) + roleLR * 0.8);
              weights.leadAggression = Math.min(1.0, (weights.leadAggression ?? base.leadAggression) + roleLR * 0.5);
              weights.strongTrumpLeadAggression = Math.min(1.0, (weights.strongTrumpLeadAggression ?? base.strongTrumpLeadAggression) + roleLR * 0.5);
              weights.aceCashUrgency = Math.min(2.0, (weights.aceCashUrgency ?? base.aceCashUrgency) + roleLR * 0.4);
            }
            if ((body.playerWonAsDeputy || 0) > 0) {
              weights.deputyFeedBias = Math.min(1.0, (weights.deputyFeedBias ?? base.deputyFeedBias) + roleLR);
              weights.faceCardOnNapWin = Math.min(1.0, (weights.faceCardOnNapWin ?? base.faceCardOnNapWin) + roleLR * 0.5);
              weights.deputyCoverWeight = Math.min(1.0, (weights.deputyCoverWeight ?? base.deputyCoverWeight) + roleLR * 0.5);
            }
            if ((body.playerWonAsAlly || 0) > 0) {
              weights.allyFaceCardBonus = Math.min(1.0, (weights.allyFaceCardBonus ?? base.allyFaceCardBonus) + roleLR);
              weights.napWeaknessLeadWeight = Math.min(1.5, (weights.napWeaknessLeadWeight ?? base.napWeaknessLeadWeight) + roleLR);
              weights.allyYieldBonus = Math.min(1.0, (weights.allyYieldBonus ?? base.allyYieldBonus) + roleLR * 0.8);
            }
            if ((body.soloWins || 0) > 0) {
              weights.mightyBonus = Math.min(3.0, (weights.mightyBonus ?? base.mightyBonus) + roleLR * 0.5);
              weights.trumpBonus = Math.min(1.5, (weights.trumpBonus ?? base.trumpBonus) + roleLR * 0.4);
            }
            if ((body.avgBid || 0) >= 16) {
              weights.bidThreshold = Math.max(2.0, (weights.bidThreshold ?? base.bidThreshold) - roleLR * 0.3);
              weights.riskTolerance = Math.min(1.0, (weights.riskTolerance ?? base.riskTolerance) + roleLR * 0.3);
            }
            try {
              await env.DB.prepare(
                "INSERT INTO human_win_patterns(user_id,player_id,rank,won_as_nap,won_as_deputy,won_as_ally,avg_bid,exact_wins,solo_wins,match_rating_delta,contracts_json,ai_weights_snapshot) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)"
              ).bind(body.userId || null, body.playerId || null, body.playerRank || 1, body.playerWonAsNap || 0, body.playerWonAsDeputy || 0, body.playerWonAsAlly || 0, Number(body.avgBid) || 0, Number(body.exactWins) || 0, Number(body.soloWins) || 0, Number(body.matchRatingDelta) || 0, JSON.stringify(body.contracts || []), JSON.stringify(body.aiWeights)).run();
              await env.DB.prepare("DELETE FROM human_win_patterns WHERE id NOT IN (SELECT id FROM human_win_patterns ORDER BY match_rating_delta DESC, id DESC LIMIT 100)").run();
            } catch (e) { console.warn("human_win_patterns save failed", e); }
          }
          await env.DB.prepare("UPDATE ai_weights SET weights=?,games=games+1,updated_at=CURRENT_TIMESTAMP WHERE id=1").bind(JSON.stringify(weights)).run();
          __cachedBotStrategy = null; __cachedBotStrategyTime = 0;
          return response({ ok: true, weights, games: (w?.games || 0) + 1, learned: (isMatchEnd && wonMatch) ? "human_win" : "round" });
        } catch (e) { console.error("report error", e); return response({ error: "save failed" }, 500); }
      }

      if (request.method === "POST" && url.pathname === "/api/ai/run-selfplay") {
        try {
          const body = await request.json().catch(() => ({}));
          const count = Math.max(1, Math.min(5000, Number(body.matches) || 1000));
          const result = await runSelfPlayBatch(env, count);
          __cachedBotStrategy = null; __cachedBotStrategyTime = 0;
          __cachedExperience = null; __cachedExperienceTime = 0;
          return response({ ok: true, ...result });
        } catch (e) { console.error('Self-play error:', e); return response({ error: "self-play failed: " + (e.message || "unknown"), stack: e.stack }, 500); }
      }
      if (request.method === "GET" && url.pathname === "/api/ai/strategies") { try { const limit = Math.max(1, Math.min(50, Number(url.searchParams.get("limit")) || 10)); const { results } = await env.DB.prepare("SELECT * FROM ai_strategy_log ORDER BY avg_rating_delta DESC, id DESC LIMIT ?").bind(limit).all(); return response(results); } catch (e) { return response({ error: "load failed" }, 500); } }
      if (request.method === "GET" && url.pathname === "/api/ai/insights") { try { const { results } = await env.DB.prepare("SELECT * FROM ai_strategy_log ORDER BY avg_rating_delta DESC, id DESC LIMIT 5").all(); return response({ insights: generateInsights(results), strategies: results }); } catch (e) { return response({ error: "load failed" }, 500); } }
      if (request.method === "GET" && url.pathname === "/api/ai/generations") { try { const { results } = await env.DB.prepare("SELECT generation, MAX(overall_win_rate) AS best, MAX(avg_rating_delta) AS best_delta, MAX(nap_win_rate) AS nap, MAX(deputy_win_rate) AS dep, MAX(alliance_win_rate) AS ally, COUNT(*) AS count FROM ai_strategy_log GROUP BY generation ORDER BY generation DESC LIMIT 30").all(); return response(results.reverse()); } catch (e) { return response({ error: "load failed" }, 500); } }
      if (request.method === "GET" && url.pathname === "/api/ai/top-strategy") { try { const row = await env.DB.prepare("SELECT params,avg_rating_delta,generation FROM ai_strategy_log ORDER BY avg_rating_delta DESC, id DESC LIMIT 1").first(); if (!row) return response({ strategy: defaultStrategy(), source: 'default' }); const parsed = safeJsonParse(row.params, null); if (!parsed) return response({ strategy: defaultStrategy(), source: 'default' }); return response({ strategy: parsed, avgRating: row.avg_rating_delta, generation: row.generation, source: 'learned' }); } catch (e) { return response({ strategy: defaultStrategy(), source: 'default' }); } }
      return new Response("Not found", { status: 404 });
    } catch (err) { return response({ error: "Global API error: " + err.message, stack: err.stack }, { status: 500 }); }
  }
};
function makeCode() { return Math.random().toString(36).slice(2, 7).toUpperCase(); }
async function getProfile(env, conn) { const userId = conn.authUserId || conn.userId; if (!userId) return { rating: 1000, games: 0, username: conn.username || "ゲスト", playerId: conn.username || "ゲスト" }; const p = await env.DB.prepare("SELECT player_id,username,rating,games FROM players WHERE user_id=?").bind(userId).first(); return p ? { rating: p.rating, games: p.games, username: p.username, playerId: p.player_id, userId } : { rating: 1000, games: null, username: conn.username || "player", playerId: conn.username || "player", userId: null }; }

async function beginMatch(kind, roomCode, group, room, env) {
  const id = Math.random().toString(36).slice(2, 12).toUpperCase();
  const seats = group.map(x => ({ connId: x.id, originalConnId: x.id, player: x.player, bot: false, hand: [], points: 0, taken: [], roundTaken: [], roundPoints: 0 }));
  while (seats.length < 5) seats.push({ connId: null, player: { username: "COM " + (seats.length + 1), playerId: "COM", rating: 1000, games: 0 }, bot: true, hand: [], points: 0, taken: [], roundTaken: [], roundPoints: 0 });
  const m = {
    id, kind, code: roomCode, seats: seats.slice(0, 5), created: Date.now(), botLevel: 3,
    matchScores: Array(5).fill(0), matchArt: Array(5).fill(0), matchContracts: [], bidHistory: [],
    playoff: false, appeal: null, appealInfo: '', botStrategy: defaultStrategy(), botExperience: null,
    matchStats: Array.from({ length: 5 }, () => ({ exactWins: 0, boldExactWins: 0, soloWins: 0, dramaticPlays: 0, declarerAttempts: 0, declarerSuccesses: 0, deputyAttempts: 0, deputySuccesses: 0, exactAttempts: 0, exactSuccesses: 0, soloAttempts: 0, soloSuccesses: 0, artAttempts: 0, allyFeedAttempts: 0, allyFeedSuccesses: 0, boldAttempts: 0, boldSuccesses: 0, bidTotal: 0, ntBids: 0, colorBids: 0 })),
    roundArt: Array(5).fill(0), roundDrama: Array(5).fill(0), roundFeed: Array(5).fill(0),
    phase: "prep", round: 1, mult: 1, redraws: 0, kitty: [], discardedKitty: [], trick: [], trickNo: 0, active: -1,
    auction: null, contract: null, deadline: Date.now() + 7000, lastBot: 0, humanAutoPlayAt: null,
    notice: "配札しました。競り開始まで7秒です。",
    playedCards: [], voids: [{}, {}, {}, {}, {}], allianceKittyPoints: 0
  };
  matches.set(id, m);
  m.seats.forEach(x => { if (x.connId) connMatch.set(x.connId, id); });
  if (env?.DB) { loadBotStrategy(env).then(s => { m.botStrategy = s; }).catch(() => {}); loadExperience(env).then(e => { m.botExperience = e; }).catch(() => {}); }
  const players = m.seats.map((x, seat) => ({ seat, id: x.player.playerId, username: x.player.username, rating: x.player.rating, bot: x.bot }));
  group.forEach((x, seat) => sendSafe(x.conn, { type: "matched", matchId: id, mode: kind, code: roomCode || null, players, seat, botCount: 5 - group.length }));
  deal(m);
  publish(m, room);
}
function deal(m) {
  m.lastTrickWinner = null;
  m.humanAutoPlayAt = null;
  const d = shuffledDeck();
  m.seats.forEach(p => { p.hand = d.splice(0, 10); p.points = 0; p.taken = []; p.roundTaken = []; p.roundPoints = 0; sortHand(p.hand); });
  m.kitty = d.splice(0, 2);
  m.discardedKitty = [];
  m.trick = []; m.trickNo = 0; m.earlyFinish = false;
  m.roundArt = Array(5).fill(0); m.roundDrama = Array(5).fill(0); m.roundFeed = Array(5).fill(0);
  m.result = null; m.contract = null; m.auction = null; m.active = -1; m.phase = "prep";
  m.deadline = Date.now() + 7000;
  m.playedCards = []; m.voids = [{}, {}, {}, {}, {}]; m.allianceKittyPoints = 0;
  m.notice = "競り開始まで7秒です。";
  const green = m.seats.findIndex(p => !p.hand.some(c => ["10", "J", "Q", "K", "A"].includes(c.rank)));
  if (green >= 0 && m.redraws < 5) {
    m.redraws++; m.mult = m.mult + 1; m.phase = "redeal";
    m.notice = m.seats[green].player.username + "の手札に10・J・Q・K・Aがありません。倍率" + m.mult + "倍で配り直します。";
    m.deadline = Date.now() + 1800;
  }
}
function finalAuctionRule(scores, mult = 1) { const ranked = scores.map((score, seat) => ({ score, seat })).sort((a, b) => a.score - b.score || a.seat - b.seat), cutoff = ranked[1]?.score ?? 0, gap = Math.max(0, (ranked[1]?.score ?? 0) - (ranked[0]?.score ?? 0)), rawMin = 13 + Math.floor(gap / (6 * Math.max(1, mult))); return { eligible: ranked.filter(x => x.score <= cutoff).map(x => x.seat), bottomSeat: ranked[0]?.seat, fourthSeat: ranked[1]?.seat, thirdSeat: ranked[2]?.seat, thirdScore: ranked[2]?.score, minBid: Math.min(20, rawMin), canOvertake: rawMin <= 20 }; }
function soloMinimumBid(gap, mult) { return 13 + Math.floor(Math.max(0, gap) / (10 * Math.max(1, mult))); }
function computeTeamMinBid(scores, mult, napSeat, deputySeat) { const ranked = scores.map((s, i) => ({ s, i })).sort((a, b) => a.s - b.s || a.i - b.i); const S5 = ranked[0].s, S4 = ranked[1].s, S3 = ranked[2].s; const bottomSeat = ranked[0].i, fourthSeat = ranked[1].i; const m = Math.max(1, mult); const f = (gap, denom) => Math.floor(Math.max(0, gap) / denom); if (napSeat === bottomSeat && deputySeat === fourthSeat) { const a = 13 + f(S4 - S5, 2 * m), b = 13 + f(S3 - S4, 4 * m), raw = Math.max(a, b); const broken = b > 20, soloBid = soloMinimumBid(S4 - S5, m); return { minBid: broken ? Math.min(20, soloBid) : Math.min(20, raw), rawMin: broken ? soloBid : raw, canOvertake: (broken ? soloBid : raw) <= 20, incentiveBroken: broken, soloRequired: broken, soloMinBid: Math.min(20, soloBid), soloRawMin: soloBid, soloPossible: soloBid <= 20, case: 'A', details: { S3, S4, S5, needNapOverDeputy: a, needDeputyOverThird: b, soloNeed: soloBid } }; } if (napSeat === fourthSeat && deputySeat === bottomSeat) { const a = 13 + f(S3 - S4, 6 * m), b = 13 + f(S3 - S5, 4 * m), c = 13 + f(S4 - S5, 2 * m), raw = Math.max(a, b, c); return { minBid: Math.min(20, raw), rawMin: raw, canOvertake: raw <= 20, incentiveBroken: a > 20 || b > 20, soloRequired: false, case: 'B', details: { S3, S4, S5, needNapOverThird: a, needDeputyOverThird: b, needDeputyOverNapOnLoss: c } }; } if (napSeat === bottomSeat && deputySeat !== fourthSeat) { const raw = 13 + f(S4 - S5, 6 * m); return { minBid: Math.min(20, raw), rawMin: raw, canOvertake: raw <= 20, incentiveBroken: false, soloRequired: false, case: 'C', details: { S3, S4, S5, needNapOverFourth: raw } }; } if (napSeat === fourthSeat && deputySeat !== bottomSeat) { const raw = 13 + f(S4 - S5, 6 * m); return { minBid: Math.min(20, raw), rawMin: raw, canOvertake: raw <= 20, incentiveBroken: false, soloRequired: false, case: 'D', details: { S3, S4, S5, needNapLoss: raw } }; } return null; }
function isSoloForcedInMatch(m) { if (m.round < 10 || !m.contract) return false; const ranked = m.matchScores.map((s, i) => ({ s, i })).sort((a, b) => a.s - b.s || a.i - b.i); const bottomSeat = ranked[0].i; if (m.contract.nap !== bottomSeat) return false; const fourthSeat = ranked[1].i; const r = computeTeamMinBid(m.matchScores, m.mult, bottomSeat, fourthSeat); return r?.soloRequired === true; }
function isSafeToCashAceInMatch(m, suit, seat) { if (!m.contract) return false; if (suit === '♠') return true; if (m.trickNo > 0) { const twoPlayed = m.playedCards.some(c => c.id === suit + '2') || (m.discardedKitty || []).some(c => c.id === suit + '2'); if (!twoPlayed) { const anyVoid = [0, 1, 2, 3, 4].some(s => s !== seat && m.voids[s] && m.voids[s][suit]); if (!anyVoid) return false; } } if (m.contract.suit !== 'NT' && m.contract.suit !== suit) { for (let s = 0; s < 5; s++) { if (s === seat) continue; if (m.contract.revealedCall) { if (s === m.contract.nap || (!m.contract.solo && s === m.contract.deputy)) continue; } else { if (s === m.contract.nap) continue; } if (m.voids[s] && m.voids[s][suit]) return false; } } return true; }
function publicState(m) {
  return {
    matchId: m.id, mode: m.kind, code: m.code, botLevel: m.botLevel, phase: m.phase, round: m.round, mult: m.mult,
    matchScores: m.matchScores, bidHistory: m.bidHistory || [], playoff: !!m.playoff,
    appeal: m.appeal, appealInfo: m.appealInfo || '', lastTrickWinner: m.lastTrickWinner ?? null,
    finalRoundRule: m.round >= 10 ? finalAuctionRule(m.matchScores, m.mult) : null,
    notice: m.notice, active: m.active, allianceKittyPoints: m.allianceKittyPoints || 0,
    players: m.seats.map((p, seat) => ({
      seat, name: p.bot ? p.player.username : (p.player.playerId || p.player.username),
      username: p.player.username, rating: p.player.rating, bot: p.bot,
      handCount: p.hand.length, points: p.points, taken: p.taken, active: m.active,
      approved: m.phase === "auction" && m.auction && Array.isArray(m.auction.active) && !m.auction.active.includes(seat),
      role: m.contract ? (m.contract.nap === seat ? "ナポレオン" : !m.contract.revealedCall ? "" : m.contract.deputy === seat ? "副官" : "連合軍") : ""
    })),
    kitty: m.phase === "auction" ? m.kitty : [],
    revealedKitty: (m.phase !== "auction" && m.kitty) ? m.kitty : [],
    auction: m.auction ? { high: m.auction.high, active: m.auction.active, minBid: m.auction.minBid || 13, requiredBidSeat: m.auction.requiredBidSeat ?? null } : null,
    contract: m.contract ? { nap: m.contract.nap, num: m.contract.num, suit: m.contract.suit, deputy: m.contract.revealedCall ? m.contract.deputy : -1, solo: m.contract.revealedCall ? m.contract.solo : false, revealedCall: !!m.contract.revealedCall, call: m.contract.call } : null,
    trick: m.trick.map(x => ({ seat: x.seat, card: x.card })),
    trickNo: m.trickNo, deadline: m.deadline, result: m.result || null
  };
}
function legalCards(m, seat) { const h = m.seats[seat].hand; if (!m.trick.length) return h; const led = m.trick[0].card.suit, follow = h.filter(c => c.suit === led); return follow.length ? follow : h; }
function publish(m, room) { const pub = publicState(m); for (let seat = 0; seat < m.seats.length; seat++) { const p = m.seats[seat]; if (!p.connId) continue; const c = conns.get(p.connId); if (!c) continue; const view = m.phase === "call" && seat === m.active ? { ...pub, kitty: m.kitty } : pub; try { sendSafe(c, { type: "game-state", state: view, you: seat }); sendSafe(c, { type: "private-hand", hand: p.hand, legal: m.phase === "play" && m.active === seat ? legalCards(m, seat).map(x => x.id) : [] }); } catch (error) { console.warn("match publish failed", m.id, c.id, error); } } }
function tell(m, room, text) { m.notice = text; publish(m, room); }
function validBid(m, n, s) { const h = m.auction.high; return Number.isInteger(n) && n >= (m.auction.minBid || 13) && n <= 20 && (SUITS.includes(s) || s === "NT") && (n > h.num || (n === h.num && SV[s] > SV[h.suit])); }
function doApprove(m, seat, room, forced = false) { if (m.phase !== "auction" || !m.auction.active.includes(seat)) return; if (m.auction.requiredBidSeat !== null && m.auction.high.num < 13) { if (forced && seat === m.auction.requiredBidSeat) doBid(m, seat, m.auction.minBid || 13, strongestSuit(m.seats[seat].hand), room); return; } if (m.round >= 10 && m.auction.high.num < 13) { const forcedSeat = m.auction.requiredBidSeat ?? m.auction.active[0]; if (forced && seat === forcedSeat) doBid(m, seat, m.auction.minBid || 13, strongestSuit(m.seats[seat].hand), room); return; } if (m.auction.high.player === seat) { if (m.auction.active.length === 1) auctionDone(m, seat, room); else if (forced && !m.auction.autoApprove[seat]) { m.auction.autoApprove[seat] = true; m.notice = m.seats[seat].player.username + "は30秒操作がなかったため、自動承認待ちです。"; publish(m, room); } return; } m.auction.lastAction[seat] = Date.now(); m.auction.autoApprove[seat] = false; m.auction.active = m.auction.active.filter(x => x !== seat); m.notice = forced ? m.seats[seat].player.username + "は30秒操作がなかったため、自動で承認しました。" : m.seats[seat].player.username + "が承認しました。"; if (!m.auction.active.length) { auctionDone(m, -1, room); return; } if (m.auction.active.length === 1 && m.auction.high.player === m.auction.active[0]) { const last = m.auction.active[0]; if (m.auction.autoApprove[last]) { auctionDone(m, last, room); return; } m.notice = m.seats[last].player.username + "以外は承認しました。さらに宣言するか、承認して確定できます。"; } m.auction.active.forEach(i => { if (m.seats[i].bot) { m.auction.botSeen[i] = Math.min(m.auction.botSeen[i], m.auction.version - 1); m.auction.botAt[i] = Date.now() + 500 + Math.random() * 1300; } }); publish(m, room); }
function doBid(m, seat, n, s, room, solo = false) { if (m.phase !== "auction" || !m.auction.active.includes(seat) || m.auction.requiredBidSeat !== null && m.auction.requiredBidSeat !== seat || !validBid(m, n, s)) return; m.bidHistory.push({ round: m.round, seat, num: n, suit: s }); if (m.bidHistory.length > 50) m.bidHistory.shift(); m.auction.lastAction[seat] = Date.now(); m.auction.autoApprove[seat] = false; m.auction.high = { num: n, suit: s, player: seat, solo: solo === true }; if (m.auction.requiredBidSeat === seat) m.auction.requiredBidSeat = null; m.auction.version++; m.active = seat; m.auction.botAt.forEach((_, i) => { if (m.seats[i].bot && i !== seat && m.auction.active.includes(i)) m.auction.botAt[i] = Date.now() + 400 + Math.random() * 1600; }); for (const i of m.auction.active.slice()) if (i !== seat && m.auction.autoApprove[i]) doApprove(m, i, room, true); if (m.phase !== "auction") return; m.notice = m.seats[seat].player.username + "が" + n + s + "を宣言しました。"; if (n === 20 && s === "NT") { auctionDone(m, seat, room); return; } publish(m, room); }
function appealDetails(hand) { const held = ['♣J', '♦J', '♥J', '♠J', '♠A'].filter(id => hand.some(card => card.id === id)); return held.length ? held.join(' ') : 'なし'; }
function enterAuctionAfterAppeal(m, room, requiredBidSeat = null) { m.auction.requiredBidSeat = requiredBidSeat; m.phase = 'auction'; m.active = -1; m.deadline = 0; m.notice = m.appealInfo || '競り開始です。宣言するか、承認して競りを降りてください。'; publish(m, room); }
function answerAppealOffer(m, seat, appeal, room) { if (m.phase !== 'appeal-offer' || seat !== m.appeal?.bottomSeat) return; if (!appeal) { m.appealInfo = '5位はアピールせず競りへ'; enterAuctionAfterAppeal(m, room); return; } m.phase = 'appeal-response'; m.active = m.appeal.fourthSeat; m.deadline = Date.now() + 30000; m.notice = '5位がアピールしました。4位はJ・マイティを申告するか、申告せず立てます。'; publish(m, room); if (m.seats[m.active].bot) answerAppealResponse(m, m.active, 'declare', room); }
function answerAppealResponse(m, seat, choice, room) { if (m.phase !== 'appeal-response' || seat !== m.appeal?.fourthSeat) return; if (choice === 'declare') { const player = m.seats[seat].player; m.appealInfo = (player.playerId || player.username) + 'の申告：' + appealDetails(m.seats[seat].hand); enterAuctionAfterAppeal(m, room); return; } const player = m.seats[seat].player; m.appealInfo = (player.playerId || player.username) + 'は申告せず立つことを選択。'; enterAuctionAfterAppeal(m, room, seat); }
function auctionDone(m, seat, room) {
  if (seat < 0 || m.auction.high.num < 13) {
    if (m.round >= 10) {
      seat = finalAuctionRule(m.matchScores, m.mult).bottomSeat;
      m.auction.high = { num: m.auction.minBid || 13, suit: strongestSuit(m.seats[seat].hand), player: seat, solo: false };
      m.notice = "オールラストは立ち必須。最下位が最低枚数で立ちます。";
    } else { m.notice = "宣言なし。配り直します。"; m.phase = "redeal"; m.deadline = Date.now() + 1800; publish(m, room); return; }
  }
  const bs = defaultStrategy();
  const strengthAtBid = m.auction.high.suit === 'NT' ? ntHandStrength(m.seats[seat].hand, bs) : colorStrength(m.seats[seat].hand, m.auction.high.suit, bs);
  const isSoloBid = m.auction.high.solo === true;
  m.contract = { nap: seat, num: m.auction.high.num, suit: m.auction.high.suit, deputy: -1, call: null, solo: isSoloBid, revealedCall: false, revealTrickNo: null, strengthAtBid };
  beginDiscard(m, seat, room);
}
function startPlay(m, room) { const c = m.contract; if (c.solo) c.deputy = c.nap; else { for (let i = 0; i < 5; i++) { const found = m.seats[i].hand.some(x => x.id === c.call.id); if (found) { c.deputy = i; break; } } if (c.deputy < 0) c.deputy = c.nap; } m.phase = "play"; m.trick = []; m.trickNo = 0; m.active = c.nap; m.deadline = Date.now() + 30000; m.humanAutoPlayAt = null; m.notice = "カードを出してください。マストフォローです。"; publish(m, room); if (m.seats[m.active].bot) botAction(m, room); }
function beginDiscard(m, seat, room) { m.seats[seat].hand.push(...m.kitty); m.kitty = []; sortHand(m.seats[seat].hand); m.phase = "discard"; m.active = seat; m.deadline = Date.now() + 30000; m.humanAutoPlayAt = null; m.notice = "オープンの2枚を手札に入れ、2枚を捨ててください。"; publish(m, room); if (m.seats[seat].bot) botAction(m, room); }
function callCard(m, seat, suit, rank, room) { if (m.phase !== "call" || m.active !== seat || !SUITS.includes(suit) || !RANKS.includes(rank)) return; const card = { suit, rank, id: suit + rank }; if (m.kitty.some(x => x.id === card.id)) return; const isOwn = m.seats[seat].hand.some(c => c.id === card.id); const forceSolo = isSoloForcedInMatch(m); if ((m.contract.solo || forceSolo) && !isOwn) { m.notice = "ひとり立ちを選択しているため、自分の手札からのみ指名できます。"; publish(m, room); return; } m.contract.call = card; m.contract.solo = isOwn || m.contract.solo; m.contract.revealedCall = false; m.contract.ready = m.seats.map(p => p.bot); m.phase = "call-reveal"; m.active = seat; m.deadline = Date.now() + 15000; m.kitty = []; m.notice = suit + rank + "が指名されました。全員の確認後に開始します。"; publish(m, room); }
function discardCards(m, seat, ids, room) {
  if (m.phase !== "discard" || m.active !== seat || !Array.isArray(ids) || ids.length !== 2 || new Set(ids).size !== 2 || (m.contract.solo && m.contract.call && ids.includes(m.contract.call.id))) return;
  const h = m.seats[seat].hand; if (ids.some(id => !h.some(c => c.id === id))) return;
  const removed = h.filter(c => ids.includes(c.id));
  m.seats[seat].hand = h.filter(c => !ids.includes(c.id));
  const kittyPoints = removed.filter(c => ["10", "J", "Q", "K", "A"].includes(c.rank));
  m.allianceKittyPoints = (m.allianceKittyPoints || 0) + kittyPoints.length;
  m.kitty = removed;
  m.discardedKitty = removed.slice();
  sortHand(m.seats[seat].hand);
  m.phase = "call"; m.active = seat; m.deadline = Date.now() + 30000;
  m.humanAutoPlayAt = null;
  m.notice = "捨て札を決めました。副官に指名するカードを選んでください。";
  publish(m, room);
  if (m.seats[seat].bot) botAction(m, room);
}

async function finish(m, room, env) {
  m.matchScores = m.matchScores || Array(5).fill(0); m.matchArt = m.matchArt || Array(5).fill(0); m.matchContracts = m.matchContracts || [];
  m.matchStats = m.matchStats || Array.from({ length: 5 }, () => ({ exactWins: 0, boldExactWins: 0, soloWins: 0, dramaticPlays: 0, declarerAttempts: 0, declarerSuccesses: 0, deputyAttempts: 0, deputySuccesses: 0, exactAttempts: 0, exactSuccesses: 0, soloAttempts: 0, soloSuccesses: 0, artAttempts: 0, allyFeedAttempts: 0, allyFeedSuccesses: 0, boldAttempts: 0, boldSuccesses: 0, bidTotal: 0, ntBids: 0, colorBids: 0 }));
  m.matchStats.forEach(stat => { stat.declarerAttempts = stat.declarerAttempts || 0; stat.declarerSuccesses = stat.declarerSuccesses || 0; stat.deputyAttempts = stat.deputyAttempts || 0; stat.deputySuccesses = stat.deputySuccesses || 0; stat.exactAttempts = stat.exactAttempts || 0; stat.exactSuccesses = stat.exactSuccesses || 0; stat.soloAttempts = stat.soloAttempts || 0; stat.soloSuccesses = stat.soloSuccesses || 0; stat.artAttempts = stat.artAttempts || 0; stat.allyFeedAttempts = stat.allyFeedAttempts || 0; stat.allyFeedSuccesses = stat.allyFeedSuccesses || 0; stat.boldAttempts = stat.boldAttempts || 0; stat.boldSuccesses = stat.boldSuccesses || 0; stat.bidTotal = stat.bidTotal || 0; stat.ntBids = stat.ntBids || 0; stat.colorBids = stat.colorBids || 0; });
  m.roundArt = m.roundArt || Array(5).fill(0);
  const finalRule = m.round >= 10 ? finalAuctionRule(m.matchScores, m.mult) : null;
  const nap = m.contract.nap, unit = Math.max(0, m.contract.num - 12) * m.mult * (m.round >= 10 ? 2 : 1);
  const team = m.contract.solo ? [nap] : Array.from(new Set([nap, m.contract.deputy]));
  const points = team.reduce((n, i) => n + m.seats[i].points, 0);
  const allianceKitty = m.allianceKittyPoints || 0;
  const made = points >= m.contract.num && (m.contract.num === 20 || points < 20);
  const sign = made ? 1 : -1; const scores = Array(5).fill(0);
  m.matchStats[nap].declarerAttempts++; m.matchStats[nap].bidTotal = (m.matchStats[nap].bidTotal || 0) + m.contract.num;
  if (m.contract.suit === "NT") m.matchStats[nap].ntBids = (m.matchStats[nap].ntBids || 0) + 1; else m.matchStats[nap].colorBids = (m.matchStats[nap].colorBids || 0) + 1;
  m.matchStats[nap].exactAttempts++;
  if (m.contract.num >= 15) { m.matchStats[nap].boldAttempts++; if (made && points === m.contract.num) m.matchStats[nap].boldSuccesses++; }
  if (made) m.matchStats[nap].declarerSuccesses++;
  if (!m.contract.solo) { m.matchStats[m.contract.deputy].deputyAttempts++; if (made) m.matchStats[m.contract.deputy].deputySuccesses++; }
  if (m.contract.solo) { m.matchStats[nap].soloAttempts++; if (made) m.matchStats[nap].soloSuccesses++; }
  scores[nap] = sign * unit * (m.contract.solo ? 4 : 2);
  if (m.contract.solo) { for (let i = 0; i < 5; i++) if (i !== nap) scores[i] = -sign * unit; }
  else { scores[m.contract.deputy] = sign * unit; for (let i = 0; i < 5; i++) if (i !== nap && i !== m.contract.deputy) scores[i] = -sign * unit; }
  const art = m.roundArt.slice();
  if (made && points === m.contract.num) { art[nap] += 2; m.matchStats[nap].exactWins++; m.matchStats[nap].exactSuccesses++; if (!m.contract.solo) art[m.contract.deputy] += 1; if (m.contract.num >= 15) { art[nap] += 2; m.matchStats[nap].boldExactWins++; if (!m.contract.solo) art[m.contract.deputy] += 1; } }
  if (m.contract.solo) { art[nap] += made ? 4 : 2; if (made) { m.matchStats[nap].soloWins++; } }
  if (!made && !m.contract.solo && m.contract.num - points >= 3) { art[nap] -= 2; art[m.contract.deputy] -= 1; }
  for (let i = 0; i < 5; i++) { m.matchScores[i] += scores[i]; m.matchArt[i] += art[i]; }
  m.matchContracts.push({ round: m.round, nap, deputy: m.contract.deputy, num: m.contract.num, suit: m.contract.suit, solo: !!m.contract.solo, points, napWin: made, revealTrickNo: m.contract.revealTrickNo ?? null, takenPoints: m.seats.map(s => s.roundPoints || 0), strengthAtBid: m.contract.strengthAtBid ?? 8, allianceKittyPoints: allianceKitty, mult: m.mult || 1 });
  const replayAllLast = !!(finalRule && scores[finalRule.bottomSeat] > 0 && m.matchScores[finalRule.bottomSeat] === m.matchScores[finalRule.fourthSeat]);
  const lastRound = m.round >= 10 && !replayAllLast;
  if (replayAllLast) m.playoff = true;
  m.result = {
    round: m.round, made, points, bid: m.contract.num, suit: m.contract.suit, solo: !!m.contract.solo, stake: unit,
    allianceKittyPoints: allianceKitty,
    lastTrickWinner: m.lastTrickWinner ?? null,
    lastTrickWinnerName: m.lastTrickWinner != null ? (m.seats[m.lastTrickWinner]?.bot ? m.seats[m.lastTrickWinner].player.username : (m.seats[m.lastTrickWinner]?.player.playerId || m.seats[m.lastTrickWinner]?.player.username)) : null,
    scoreChanges: scores.map((delta, seat) => ({ seat, delta, role: seat === nap ? "ナポレオン" : !m.contract.solo && seat === m.contract.deputy ? "副官" : "連合軍" })),
    artChanges: art.map((delta, seat) => ({ seat, delta })),
    winners: made ? team : m.seats.map((_, i) => i).filter(i => !team.includes(i)),
    matchScores: m.matchScores.slice(), matchArt: m.matchArt.slice(),
    allLastReplay: replayAllLast, playoff: !!m.playoff
  };
  m.phase = lastRound ? "result" : "round-result"; m.active = -1; m.deadline = lastRound ? 0 : Date.now() + 8000;
  m.humanAutoPlayAt = null;
  m.notice = replayAllLast ? "5位が4位に並びました。プレーオフを行います。" : lastRound ? "オールラスト終了。レートを集計しています。" : "第" + m.round + "局が終了しました。";
  if (!lastRound) { publish(m, room); return; }
  const ratingChanges = matchRatingChanges(m.matchScores, m.matchArt, m.seats.map(seat => Number(seat.player.rating) || 1000), m.matchStats, m.matchContracts);
  m.result.ratingChanges = ratingChanges;
  const placementOrder = m.matchScores.map((score, seat) => ({ score, seat })).sort((a, b) => b.score - a.score || a.seat - b.seat);
  const placementBySeat = []; placementOrder.forEach((entry, index) => placementBySeat[entry.seat] = index + 1);
  if (m.kind === "ranked") {
    const userIds = [...new Set(m.seats.map(seat => seat.player.userId).filter(Boolean))]; const updates = [];
    if (userIds.length) {
      try {
        const placeholders = userIds.map(() => "?").join(",");
        const [profileRes, eloRes] = await Promise.all([
          env.DB.prepare("SELECT user_id,username,rating FROM players WHERE user_id IN (" + placeholders + ")").bind(...userIds).all(),
          env.DB.prepare("SELECT user_id, elo FROM player_elo WHERE user_id IN (" + placeholders + ")").bind(...userIds).all()
        ]);
        const byId = new Map(profileRes.results.map(profile => [profile.user_id, profile]));
        const eloMap = new Map((eloRes.results || []).map(row => [row.user_id, row.elo]));
        const statements = [];
        for (let seat = 0; seat < m.seats.length; seat++) {
          const player = m.seats[seat], userId = player.player.userId, profile = userId && byId.get(userId);
          if (!profile) continue;
          const change = ratingChanges[seat], outcome = change.outcome;
          const currentElo = eloMap.get(userId) ?? ELO_INIT;
          const oppElos = m.seats.filter((_, i) => i !== seat).map(s => { if (!s.player.userId) return ELO_INIT; return eloMap.get(s.player.userId) ?? ELO_INIT; });
          const eloDelta = computeEloDelta(currentElo, oppElos, outcome);
          const combinedDelta = change.delta + eloDelta;
          const rating = Math.max(100, (Number(profile.rating) || 1000) + combinedDelta);
          change.rating = rating; change.eloDelta = eloDelta;
          const stat = m.matchStats[seat];
          statements.push(
            env.DB.prepare("UPDATE players SET rating=?,wins=wins+?,losses=losses+?,games=games+1 WHERE user_id=?").bind(rating, outcome === "win" ? 1 : 0, outcome === "loss" ? 1 : 0, profile.user_id),
            env.DB.prepare("INSERT INTO match_history(user_id,username,result,delta,rating_after) VALUES(?,?,?,?,?)").bind(profile.user_id, profile.username, outcome, combinedDelta, rating),
            env.DB.prepare("INSERT OR IGNORE INTO player_stats(user_id) VALUES(?)").bind(profile.user_id),
            env.DB.prepare("UPDATE player_stats SET exact_wins=exact_wins+?,bold_exact_wins=bold_exact_wins+?,solo_wins=solo_wins+?,dramatic_plays=dramatic_plays+? WHERE user_id=?").bind(stat.exactWins, stat.boldExactWins, stat.soloWins, stat.dramaticPlays, profile.user_id),
            env.DB.prepare("INSERT INTO player_performance(user_id,declarer_attempts,declarer_successes,deputy_attempts,deputy_successes) VALUES(?,?,?,?,?) ON CONFLICT(user_id) DO UPDATE SET declarer_attempts=declarer_attempts+excluded.declarer_attempts,declarer_successes=declarer_successes+excluded.declarer_successes,deputy_attempts=deputy_attempts+excluded.deputy_attempts,deputy_successes=deputy_successes+excluded.deputy_successes").bind(profile.user_id, stat.declarerAttempts, stat.declarerSuccesses, stat.deputyAttempts, stat.deputySuccesses),
            env.DB.prepare("INSERT INTO player_precision(user_id,exact_attempts,exact_successes,solo_attempts,solo_successes) VALUES(?,?,?,?,?) ON CONFLICT(user_id) DO UPDATE SET exact_attempts=exact_attempts+excluded.exact_attempts,exact_successes=exact_successes+excluded.exact_successes,solo_attempts=solo_attempts+excluded.solo_attempts,solo_successes=solo_successes+excluded.solo_successes").bind(profile.user_id, stat.exactAttempts, stat.exactSuccesses, stat.soloAttempts, stat.soloSuccesses),
            env.DB.prepare("INSERT INTO player_art_rate(user_id,attempts,plays) VALUES(?,?,?) ON CONFLICT(user_id) DO UPDATE SET attempts=attempts+excluded.attempts,plays=plays+excluded.plays").bind(profile.user_id, stat.artAttempts, stat.dramaticPlays),
            env.DB.prepare("INSERT INTO player_ally_feed(user_id,attempts,successes) VALUES(?,?,?) ON CONFLICT(user_id) DO UPDATE SET attempts=attempts+excluded.attempts,successes=successes+excluded.successes").bind(profile.user_id, stat.allyFeedAttempts, stat.allyFeedSuccesses),
            env.DB.prepare("INSERT INTO player_bold_bid_rate(user_id,attempts,successes) VALUES(?,?,?) ON CONFLICT(user_id) DO UPDATE SET attempts=attempts+excluded.attempts,successes=successes+excluded.successes").bind(profile.user_id, stat.boldAttempts, stat.boldSuccesses),
            env.DB.prepare("INSERT INTO player_match_stats(user_id,declarer_attempts,bid_total,nt_bids,color_bids,match_count,rank_1,rank_2,rank_3,rank_4,rank_5) VALUES(?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(user_id) DO UPDATE SET declarer_attempts=declarer_attempts+excluded.declarer_attempts,bid_total=bid_total+excluded.bid_total,nt_bids=nt_bids+excluded.nt_bids,color_bids=color_bids+excluded.color_bids,match_count=match_count+1,rank_1=rank_1+excluded.rank_1,rank_2=rank_2+excluded.rank_2,rank_3=rank_3+excluded.rank_3,rank_4=rank_4+excluded.rank_4,rank_5=rank_5+excluded.rank_5").bind(profile.user_id, stat.declarerAttempts, stat.bidTotal || 0, stat.ntBids || 0, stat.colorBids || 0, 1, ...Array.from({ length: 5 }, (_, index) => placementBySeat[seat] === index + 1 ? 1 : 0)),
            env.DB.prepare("INSERT INTO player_elo(user_id, elo) VALUES(?, ?) ON CONFLICT(user_id) DO UPDATE SET elo=excluded.elo").bind(userId, rating)
          );
          updates.push({ connId: player.connId, change, rating, outcome, combinedDelta, eloDelta });
        }
        if (statements.length) await env.DB.batch(statements);
      } catch (error) { console.error("ranked match settlement failed", m.id, error); m.result.rateSaveFailed = true; }
      if (!m.result.rateSaveFailed) for (const update of updates) { try { sendSafe(conns.get(update.connId), { type: "rating-updated", result: update.outcome, delta: update.combinedDelta, rating: update.rating, eloDelta: update.eloDelta, placement: update.change.placement, art: update.change.art, breakdown: update.change.breakdown }); } catch (error) { console.warn("rating notification failed", m.id, error); } }
    }
  }
  publish(m, room); matches.delete(m.id);
  for (const seat of m.seats) { if (seat.connId) connMatch.delete(seat.connId); const userId = seat.player.userId; if (userId && rankedUsers.get(userId) === seat.originalConnId) rankedUsers.delete(userId); }
}
function artfulCard(m, entry, trick) { const c = entry.card, led = trick[0].card.suit, black = s => s === "♣" || s === "♠"; return c.id === "♠A" || c.id === "♥Q" && trick.some(x => x.card.id === "♠A") || c.rank === "J" && m.contract.suit !== "NT" && (c.suit === m.contract.suit || c.suit !== m.contract.suit && black(c.suit) === black(m.contract.suit)) || c.rank === "2" && c.suit === led && trick.every(x => x.card.suit === led); }
function playCard(m, seat, id, room, env) {
  if (m.phase !== "play" || m.active !== seat) return;
  const legal = legalCards(m, seat), card = legal.find(x => x.id === id);
  if (!card) return;
  if (!m.trick.length) m.lastTrickWinner = null;
  const previous = m.trick.length ? winningEntry(m.contract, m.trickNo, m.trick) : null, hand = m.seats[seat].hand, teamOf = i => i === m.contract.nap || !m.contract.solo && i === m.contract.deputy ? "nap" : "alliance", feedOpportunity = !!(previous && previous.seat !== seat && m.contract.revealedCall && teamOf(previous.seat) === teamOf(seat) && legal.some(x => ["10", "J", "Q", "K", "A"].includes(x.rank))), feedCard = feedOpportunity && ["10", "J", "Q", "K", "A"].includes(card.rank);
  hand.splice(hand.findIndex(x => x.id === id), 1);
  m.trick.push({ seat, card, feedOpportunity, feedCard });
  m.playedCards.push({ suit: card.suit, rank: card.rank, id: card.id, seat: seat });
  if (m.trick.length > 1) { const ledSuit = m.trick[0].card.suit; if (card.suit !== ledSuit) { if (!m.voids[seat]) m.voids[seat] = {}; m.voids[seat][ledSuit] = true; } }
  const reveal = m.contract.call?.id === card.id && !m.contract.revealedCall; let raisedNotice = "";
  if (reveal) {
    m.contract.revealedCall = true; m.contract.revealTrickNo = m.trickNo;
    if (m.round >= 10 && !m.contract.solo) {
      const r = computeTeamMinBid(m.matchScores, m.mult, m.contract.nap, m.contract.deputy);
      if (r !== null) {
        const forcedMin = r.minBid, oldBid = m.contract.num;
        const caseLabel = { A: '組んだら', B: '逆組み', C: '通常', D: '逆立ち' }[r.case];
        if (forcedMin > oldBid) { m.contract.num = forcedMin; raisedNotice = '副官判明（' + caseLabel + '）。立ちを ' + oldBid + '枚 → ' + forcedMin + '枚 に引き上げました。'; }
        else { raisedNotice = '副官判明（' + caseLabel + '）。立ち ' + oldBid + '枚は最低条件を満たしています。'; }
        if (r.incentiveBroken) raisedNotice += ' ⚠ 20枚でも4位が3位を超えられないため、副官に勝つインセンティブがありません。';
      }
    }
  }
  if (previous && m.contract.revealedCall) { const team = x => x === m.contract.nap || x === m.contract.deputy ? "nap" : "alliance"; if (team(seat) === team(previous.seat) && winningEntry(m.contract, m.trickNo, m.trick).seat === seat) m.roundArt[seat]--; }
  const revealNotice = m.contract.solo ? "ひとり立ちが判明しました。" : "副官が判明しました。";
  m.humanAutoPlayAt = null;
  if (m.trick.length < 5) { m.active = (seat + 4) % 5; m.deadline = Date.now() + 30000; m.notice = raisedNotice || (reveal ? revealNotice : "カードを出してください。"); publish(m, room); if (m.seats[m.active].bot) botAction(m, room); return; }
  const winningEntryObj = winningEntry(m.contract, m.trickNo, m.trick), w = winningEntryObj.seat, taken = m.trick.filter(x => ["10", "J", "Q", "K", "A"].includes(x.card.rank)).map(x => x.card);
  for (const entry of m.trick) { if (!entry.feedOpportunity) continue; const stat = m.matchStats[entry.seat]; stat.allyFeedAttempts++; if (entry.feedCard && teamOf(w) === teamOf(entry.seat)) { stat.allyFeedSuccesses++; m.roundFeed[entry.seat]++; m.roundArt[entry.seat]++; } }
  if (taken.length >= 3 && m.roundDrama[w] < 2) { m.matchStats[w].artAttempts++; if (artfulCard(m, winningEntryObj, m.trick)) { m.roundArt[w]++; m.roundDrama[w]++; m.matchStats[w].dramaticPlays++; } }
  m.seats[w].points += taken.length; m.seats[w].taken.push(...taken); m.seats[w].roundTaken.push(...taken); m.seats[w].roundPoints = (m.seats[w].roundPoints || 0) + taken.length;
  m.lastTrickWinner = w; m.active = w;
  const alliancePointsRaw = m.seats.reduce((n, p, i) => n + (i !== m.contract.nap && (m.contract.solo || i !== m.contract.deputy) ? p.points : 0), 0);
  const alliancePoints = alliancePointsRaw + (m.allianceKittyPoints || 0);
  const napPoints = m.seats.reduce((n, p, i) => n + (i === m.contract.nap || !m.contract.solo && i === m.contract.deputy ? p.points : 0), 0);
  m.earlyFinish = alliancePoints > 20 - m.contract.num || napPoints >= m.contract.num && (m.contract.num === 20 || alliancePoints >= 1);
  const isFinalTrick = m.trickNo >= 9;
  const willFinish = m.earlyFinish || isFinalTrick;
  m.notice = raisedNotice || (napPoints >= m.contract.num ? "ナポレオン軍が立ちを達成しました。" : m.earlyFinish ? "連合軍の獲得得点札で立ちが成立不能になりました。" : reveal ? revealNotice : m.seats[w].player.username + "が場札を取りました。");
  if (willFinish) {
    m.notice = (isFinalTrick ? '最終トリック' : '決着トリック') + '勝者: ' + m.seats[w].player.username;
  }
  m.phase = "trick-end"; m.deadline = willFinish ? Date.now() + 2200 : Date.now() + 1250; publish(m, room);
}

function botAuctionBid(m, seat, room) {
  m.botLevel = 3; const a = m.auction, version = a.version;
  if (a.botSeen[seat] >= version || !a.active.includes(seat)) return;
  a.botSeen[seat] = version;

  if (a.high.player === seat) {
    if (a.active.length === 1) auctionDone(m, seat, room);
    return;
  }

  const h = m.seats[seat].hand;
  const params = m.botStrategy || defaultStrategy();
  const currentBids = (m.bidHistory || []).filter(b => b.round === m.round);
  const bid = shouldBid(h, a.high, a.minBid || 13, params, currentBids, seat, m.botExperience || null);
  if (bid && validBid(m, bid.num, bid.suit)) {
    a.botBids[seat]++;
    doBid(m, seat, bid.num, bid.suit, room, bid.solo === true);
    if (m.phase === "auction") a.botAt[seat] = Date.now() + 2500 + Math.random() * 1800;
    return;
  }
  if (a.high.player === seat) { if (a.active.length === 1) doApprove(m, seat, room); return; }
  doApprove(m, seat, room);
}

function botAction(m, room) {
  if (!m || m.phase === "result") return;
  m.botLevel = 3; const i = m.active, p = m.seats[i];
  if (!p?.bot) return;
  m.lastBot = Date.now();
  const params = m.botStrategy || defaultStrategy();
  const experience = m.botExperience || null;
  if (m.phase === "auction") { botAuctionBid(m, i, room); return; }
  if (m.phase === "call") {
    if (m.contract.solo) { const chosen = chooseSoloCall(p.hand); if (chosen) callCard(m, i, chosen.suit, chosen.rank, room); return; }
    const forceSolo = isSoloForcedInMatch(m);
    if (forceSolo) { const chosen = p.hand.slice().sort((a, b) => RANKS.indexOf(a.rank) - RANKS.indexOf(b.rank))[0]; if (chosen) callCard(m, i, chosen.suit, chosen.rank, room); }
    else {
      const x = chooseDeputyCall(p.hand, m.kitty, m.contract.suit, m.botLevel || 2, m.contract.num, params, experience);
      if (x) callCard(m, i, x.suit, x.rank, room);
    }
    return;
  }
  if (m.phase === "discard") { const drop = chooseDiscard(p.hand, m.contract.suit).map(x => x.id); discardCards(m, i, drop, room); return; }
  if (m.phase === "play") {
    const legal = legalCards(m, i);
    const deputyPts = (!m.contract.solo && m.contract.deputy >= 0) ? (m.seats[m.contract.deputy].points || 0) : 0;
    const currentNapPoints = (m.seats[m.contract.nap].points || 0) + deputyPts;
    const ctx = {
      hand: p.hand, legal, trick: m.trick, trickNo: m.trickNo, contract: m.contract,
      playedCards: m.playedCards, voids: m.voids, seat: i, deputy: m.contract.deputy,
      discardedKitty: m.discardedKitty || [],
      isMySideNap: i === m.contract.nap || (m.contract.revealedCall && i === m.contract.deputy),
      isCurrentNapWinning: m.trick.length ? (winningEntry(m.contract, m.trickNo, m.trick).seat === m.contract.nap || (!m.contract.solo && winningEntry(m.contract, m.trickNo, m.trick).seat === m.contract.deputy)) : false,
      isRevealed: m.contract.revealedCall, isNapLeading: m.trick.length > 0 && m.trick[0].seat === m.contract.nap,
      lastSeat: m.trick.length === 4, params, call: m.contract.call, currentNapPoints,
      experience
    };
    let c;
    if (i === m.contract.deputy && !m.contract.solo && m.contract.revealedCall) c = chooseDeputyCard(ctx);
    else c = chooseCardToPlay(ctx);
    if (!c || !legal.some(x => x.id === c.id)) c = legal[Math.floor(Math.random() * legal.length)];
    playCard(m, i, c.id, room, null);
  }
}
function nextRound(m, room) { if (m.phase !== "round-result") return; m.round++; m.mult = 1; m.redraws = 0; deal(m); publish(m, room); }
async function processAction(conn, msg, room, env) { const id = connMatch.get(conn.id), m = id && matches.get(id); if (!m) return; const seat = m.seats.findIndex(s => s.connId === conn.id); if (seat < 0) return; const a = msg.action || {}; if (a.type === "appeal") return answerAppealOffer(m, seat, true, room); if (a.type === "skip-appeal") return answerAppealOffer(m, seat, false, room); if (a.type === "appeal-declare") return answerAppealResponse(m, seat, "declare", room); if (a.type === "appeal-stand") return answerAppealResponse(m, seat, "stand", room); if (a.type === "next-round") return nextRound(m, room); if (a.type === "auction-activity") { if (m.phase === "auction" && m.auction.active.includes(seat)) { m.auction.lastAction[seat] = Date.now(); m.auction.autoApprove[seat] = false; } return; } if (a.type === "confirm-call") { if (m.phase !== "call-reveal" || m.contract.ready[seat]) return; m.contract.ready[seat] = true; if (m.contract.ready.every((ready, i) => ready || m.seats[i].bot)) startPlay(m, room); else { m.notice = "指名カードの確認中です。"; publish(m, room); } return; } if (a.type === "approve" || a.type === "pass") doApprove(m, seat, room); else if (a.type === "bid") doBid(m, seat, Number(a.num), a.suit, room, a.solo === true); else if (a.type === "call") callCard(m, seat, a.suit, a.rank, room); else if (a.type === "discard") discardCards(m, seat, a.cards, room); else if (a.type === "play") playCard(m, seat, a.card, room, env); }
async function saveEnd(m, room, env) { await finish(m, room, env); }
function timeoutAction(m, room) { const i = m.active, p = m.seats[i]; const params = m.botStrategy || defaultStrategy(); const experience = m.botExperience || null; if (m.phase === "call") { if (m.contract.solo) { const chosen = chooseSoloCall(p.hand); if (chosen) callCard(m, i, chosen.suit, chosen.rank, room); return; } const forceSolo = isSoloForcedInMatch(m); if (forceSolo) { const chosen = p.hand.slice().sort((a, b) => RANKS.indexOf(a.rank) - RANKS.indexOf(b.rank))[0]; if (chosen) callCard(m, i, chosen.suit, chosen.rank, room); } else { const x = chooseDeputyCall(p.hand, m.kitty, m.contract.suit, m.botLevel || 2, m.contract.num, params, experience); if (x) callCard(m, i, x.suit, x.rank, room); } } else if (m.phase === "discard") { const ids = p.hand.slice().sort((a, b) => RANKS.indexOf(a.rank) - RANKS.indexOf(b.rank)).slice(0, 2).map(x => x.id); discardCards(m, i, ids, room); } else if (m.phase === "play") { const c = legalCards(m, i).slice().sort((a, b) => RANKS.indexOf(a.rank) - RANKS.indexOf(b.rank))[0]; if (c) playCard(m, i, c.id, room, null); } }

export const room = { tickMs: 500, async onConnect(conn, room) { if (conns.size >= 180) { conn.close(4003, "Room capacity reached"); return; } conns.set(conn.id, conn); sendSafe(conn, { type: "connected" }); const presence = { type: "presence", count: conns.size }; sendSafe(conn, presence); room.broadcast(presence, { except: [conn.id] }); }, async onMessage(conn, raw, room, env) {
  let msg; try { msg = typeof raw === "string" ? JSON.parse(raw) : raw; } catch { return; }
  if (msg.type === "join") {
    if (msg.sessionToken) { const sess = await env.DB.prepare("SELECT user_id FROM sessions WHERE token=? AND expires_at>?").bind(msg.sessionToken, Date.now()).first(); if (sess) conn.authUserId = sess.user_id; }
    const mode = msg.mode === "ranked" ? "ranked" : "friend";
    if (mode === "ranked" && conn.authUserId && rankedUsers.has(conn.authUserId)) { sendSafe(conn, { type: "room-error", message: "このアカウントはすでに待機中または対戦中です" }); return; }
    if (mode === "ranked" && conn.authUserId) rankedUsers.set(conn.authUserId, conn.id);
    if (connMatch.has(conn.id)) { if (mode === "ranked" && conn.authUserId && rankedUsers.get(conn.authUserId) === conn.id) rankedUsers.delete(conn.authUserId); return; }
    let player; try { player = await getProfile(env, conn); } catch (error) { if (mode === "ranked" && conn.authUserId && rankedUsers.get(conn.authUserId) === conn.id) rankedUsers.delete(conn.authUserId); sendSafe(conn, { type: "room-error", message: "プレイヤー情報を確認できませんでした。再度お試しください" }); return; }
    if (!conns.has(conn.id)) { if (mode === "ranked" && conn.authUserId && rankedUsers.get(conn.authUserId) === conn.id) rankedUsers.delete(conn.authUserId); return; }
    const entry = { id: conn.id, player, conn, joined: Date.now(), code: String(msg.code || "").toUpperCase().slice(0, 8), bots: Math.max(1, Math.min(4, Number(msg.bots) || 4)), botLevel: Math.max(1, Math.min(3, Math.floor(Number(msg.botLevel) || 2))) };
    if (mode === "ranked") { queues.ranked.push(entry); queues.ranked.sort((a, b) => a.joined - b.joined); sendSafe(conn, { type: "lobby", text: "対戦相手を検索中 · " + queues.ranked.length + "/5人" }); if (queues.ranked.length >= 5) beginMatch("ranked", "", queues.ranked.splice(0, 5), room, env); return; }
    if (!entry.code) entry.code = makeCode();
    let l = friendRooms.get(entry.code);
    if (!l) { l = { code: entry.code, host: conn.id, bots: entry.bots, botLevel: entry.botLevel, players: [], created: Date.now() }; friendRooms.set(entry.code, l); }
    if (l.players.some(x => x.id === conn.id || player.userId && x.player.userId === player.userId)) { sendSafe(conn, { type: "room-error", message: "このプレイヤーはすでに部屋にいます" }); return; }
    const cap = Math.max(1, 5 - l.bots);
    if (l.players.length >= cap) { sendSafe(conn, { type: "room-error", message: "この部屋は満員です" }); return; }
    l.players.push(entry);
    l.players.forEach(x => sendSafe(x.conn, { type: "friend-lobby", code: l.code, count: l.players.length, capacity: cap, bots: l.bots, host: x.id === l.host }));
    sendSafe(conn, { type: "lobby", text: "合言葉 " + l.code + " · " + l.players.length + "/" + cap + "人" });
    if (l.players.length >= cap) { friendRooms.delete(l.code); beginMatch("friend", l.code, l.players, room, env); }
    return;
  }
  if (msg.type === "cancel-queue") { const queueIndex = queues.ranked.findIndex(x => x.id === conn.id); if (queueIndex >= 0) { queues.ranked.splice(queueIndex, 1); if (conn.authUserId && rankedUsers.get(conn.authUserId) === conn.id) rankedUsers.delete(conn.authUserId); } sendSafe(conn, { type: "queue-cancelled" }); return; }
  if (msg.type === "game") return processAction(conn, msg, room, env);
}, async onTick(room, env) { const now = Date.now(), rankedQueue = queues.ranked; if (rankedQueue.length && now - rankedQueue[rankedQueue.length - 1].joined >= 90000) { const group = rankedQueue.splice(0, Math.min(4, rankedQueue.length)); beginMatch("ranked", "", group, room, env); } for (const [c, l] of friendRooms) if (now - l.created > 900000) friendRooms.delete(c); for (const m of matches.values()) { if (m.phase === "prep" && now >= m.deadline) { const rule = m.round >= 10 ? finalAuctionRule(m.matchScores, m.mult) : null; m.phase = "auction"; m.auction = { active: rule ? rule.eligible : [0, 1, 2, 3, 4], minBid: rule?.minBid || 13, high: { num: 12, suit: "", player: -1, solo: false }, version: 0, startedAt: now, lastAction: Array(5).fill(now), autoApprove: Array(5).fill(false), botBids: Array(5).fill(0), botSeen: Array(5).fill(-1), botAt: m.seats.map(() => now + 500 + Math.random() * 2200), requiredBidSeat: null }; m.active = -1; m.deadline = 0; if (rule) { m.appeal = { bottomSeat: rule.bottomSeat, fourthSeat: rule.fourthSeat }; m.appealInfo = ""; m.phase = "appeal-offer"; m.active = rule.bottomSeat; m.deadline = now + 30000; m.notice = "5位は4位にJ・マイティの所持を尋ねられます。"; publish(m, room); if (m.seats[rule.bottomSeat].bot) answerAppealOffer(m, rule.bottomSeat, true, room); } else { m.appeal = null; m.appealInfo = ""; m.notice = "競り開始です。宣言するか、承認して競りを降りてください。"; publish(m, room); } } else if (m.phase === "appeal-offer") { if (now >= m.deadline) answerAppealOffer(m, m.appeal.bottomSeat, false, room); } else if (m.phase === "appeal-response") { if (m.seats[m.active]?.bot) answerAppealResponse(m, m.active, "declare", room); else if (now >= m.deadline) answerAppealResponse(m, m.active, "stand", room); } else if (m.phase === "auction") { for (const seat of m.auction.active.slice()) { if (!m.seats[seat].bot && !m.auction.autoApprove[seat] && now - (m.auction.lastAction[seat] || m.auction.startedAt) >= 30000) doApprove(m, seat, room, true); if (m.phase !== "auction") break; } for (let seat = 0; seat < m.seats.length && m.phase === "auction"; seat++) { if (m.seats[seat].bot && m.auction.active.includes(seat) && m.auction.botSeen[seat] < m.auction.version && now >= m.auction.botAt[seat]) botAuctionBid(m, seat, room); } } else if (m.phase === "call-reveal") { if (now >= m.deadline) startPlay(m, room); } else if (m.phase === "call" || m.phase === "discard") { if (m.seats[m.active]?.bot && now - m.lastBot > 850) botAction(m, room); else if (m.deadline && now >= m.deadline) { m.notice = "持ち時間が切れたため、自動で進行します。"; timeoutAction(m, room); } } else if (m.phase === "play") { const activeSeat = m.active; if (m.seats[activeSeat]?.bot) { if (now - m.lastBot > 850) botAction(m, room); } else { const legal = legalCards(m, activeSeat); if (legal.length === 1) { if (!m.humanAutoPlayAt) m.humanAutoPlayAt = now + 1500; else if (now >= m.humanAutoPlayAt) { m.humanAutoPlayAt = null; m.notice = "出すカードが1枚しかないため、自動で出します。"; publish(m, room); playCard(m, activeSeat, legal[0].id, room, env); } } else { m.humanAutoPlayAt = null; if (m.deadline && now >= m.deadline) { m.notice = "持ち時間が切れたため、自動で進行します。"; timeoutAction(m, room); } } } } else if (m.phase === "round-result" && now >= m.deadline) { nextRound(m, room); } else if (m.phase === "trick-end" && now >= m.deadline) { if (m.earlyFinish) { await saveEnd(m, room, env); continue; } m.trickNo++; if (m.trickNo >= 10) await saveEnd(m, room, env); else { m.trick = []; m.phase = "play"; m.deadline = Date.now() + 30000; m.humanAutoPlayAt = null; m.notice = "次の勝負です。"; publish(m, room); if (m.seats[m.active].bot) botAction(m, room); } } else if (m.phase === "redeal" && now >= m.deadline) { deal(m); publish(m, room); } } }, async onClose(conn, room) { const id = connMatch.get(conn.id); conns.delete(conn.id); queues.ranked.splice(0, queues.ranked.length, ...queues.ranked.filter(x => x.id !== conn.id)); const uid = conn.authUserId || conn.userId; if (uid && rankedUsers.get(uid) === conn.id) rankedUsers.delete(uid); for (const [c, l] of friendRooms) { l.players = l.players.filter(x => x.id !== conn.id); if (!l.players.length) friendRooms.delete(c); } connMatch.delete(conn.id); if (id) { const m = matches.get(id); if (m) { const s = m.seats.find(x => x.connId === conn.id); if (s) { s.bot = true; s.connId = null; s.player.username = "COM"; s.player.playerId = "COM"; if (m.kind === "ranked") s.player.userId = null; } publish(m, room); } } const presence = { type: "presence", count: conns.size }; room.broadcast(presence); } };
