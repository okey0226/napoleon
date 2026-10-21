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
          await env.DB.prepare("UPDATE ai_weights SET weights=?,games=games+1,updated_at=CURRENT
