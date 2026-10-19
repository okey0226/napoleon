// ============================================================
// worker/auth.js
// 依存: worker/state.js
// 役割: アカウント登録・ログイン・マイページ・ランキング
// ============================================================
import { response } from './state.js';

// ---------------- crypto ヘルパー ----------------
const hex = b => Array.from(new Uint8Array(b), x => x.toString(16).padStart(2, '0')).join('');
const unhex = s => new Uint8Array((s.match(/.{2}/g) || []).map(x => parseInt(x, 16)));

async function hashPassword(password, salt) {
  const key = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveBits']
  );
  return hex(await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt, iterations: 100000, hash: 'SHA-256' }, key, 256
  ));
}

const validId = s => typeof s === 'string' && /^[a-zA-Z0-9_-]{3,20}$/.test(s);
const identity = req => ({
  id: req.headers.get('x-websim-user-id'),
  username: req.headers.get('x-websim-username') || 'player',
  anonymous: req.headers.get('x-websim-user-is-anonymous') === 'true'
});
const signed = req => { const u = identity(req); return u.id && !u.anonymous ? u : null; };

function metricRank(db, table, successColumn, attemptColumn, successes, attempts) {
  if (!attempts) return Promise.resolve(null);
  return db.prepare(
    'SELECT COUNT(*) AS ahead FROM ' + table
    + ' WHERE ' + attemptColumn + '>0 AND ' + successColumn + '*1.0/' + attemptColumn + '>?'
  ).bind(successes / attempts).first().then(row => row.ahead + 1);
}

// ---------------- 登録 / ログイン ----------------
// url.pathname が /api/account/register か /api/account/login で分岐
export async function handleAuth(request, env, url) {
  let body;
  try { body = await request.json(); }
  catch { return response({ error: '入力を確認してください' }, 400); }

  const id = String(body.id || '').trim();
  const pass = String(body.password || '');
  if (!validId(id)) return response({ error: 'IDは英数字・_・-の3〜20文字です' }, 400);
  if (pass.length < 8 || pass.length > 128) return response({ error: 'パスワードは8〜128文字です' }, 400);

  const isRegister = url.pathname.endsWith('register');
  let userId = null;

  if (isRegister) {
    userId = crypto.randomUUID();
    const salt = crypto.getRandomValues(new Uint8Array(16));
    const digest = await hashPassword(pass, salt);
    try {
      await env.DB.prepare(
        'INSERT INTO players(user_id,username,player_id,salt,password_hash) VALUES(?,?,?,?,?)'
      ).bind(userId, id, id, hex(salt), digest).run();
    } catch {
      return response({ error: 'そのIDはすでに使われています' }, 409);
    }
  } else {
    const p = await env.DB.prepare(
      'SELECT user_id,salt,password_hash FROM players WHERE player_id=?'
    ).bind(id).first();
    if (!p || await hashPassword(pass, unhex(p.salt)) !== p.password_hash) {
      return response({ error: 'IDまたはパスワードが違います' }, 401);
    }
    userId = p.user_id;
  }

  await env.DB.batch([
    env.DB.prepare('INSERT OR IGNORE INTO player_stats(user_id) VALUES(?)').bind(userId),
    env.DB.prepare('INSERT OR IGNORE INTO player_performance(user_id) VALUES(?)').bind(userId),
    env.DB.prepare('INSERT OR IGNORE INTO player_precision(user_id) VALUES(?)').bind(userId),
    env.DB.prepare('INSERT OR IGNORE INTO player_art_rate(user_id) VALUES(?)').bind(userId),
    env.DB.prepare('INSERT OR IGNORE INTO player_ally_feed(user_id) VALUES(?)').bind(userId),
    env.DB.prepare('INSERT OR IGNORE INTO player_bold_bid_rate(user_id) VALUES(?)').bind(userId)
  ]);

  const token = hex(crypto.getRandomValues(new Uint8Array(32)));
  const expiresAt = Date.now() + 30 * 24 * 3600 * 1000;
  await env.DB.prepare(
    'INSERT INTO sessions(token,user_id,expires_at) VALUES(?,?,?)'
  ).bind(token, userId, expiresAt).run();

  const player = await env.DB.prepare(
    'SELECT player_id AS id,rating,wins,losses,games FROM players WHERE user_id=?'
  ).bind(userId).first();
  return response({ ...player, sessionToken: token });
}

// ---------------- マイページ ----------------
export async function handleMe(request, env) {
  const token = request.headers.get('x-session-token');
  let userId = null;

  if (token) {
    const sess = await env.DB.prepare(
      'SELECT user_id FROM sessions WHERE token=? AND expires_at>?'
    ).bind(token, Date.now()).first();
    if (sess) userId = sess.user_id;
  }
  if (!userId) {
    const who = signed(request);
    if (who) userId = who.id;
  }
  if (!userId) return response({ error: '認証情報が必要です' }, 401);

  const p = await env.DB.prepare(
    'SELECT player_id AS id,username,rating,wins,losses,games FROM players WHERE user_id=?'
  ).bind(userId).first();
  if (!p) return response({ error: 'プレイヤー登録がありません' }, 404);

  const [performanceRow, precisionRow, artRateRow, allyFeedRow, boldBidRow, historyPage, matchStatsRow] =
    await Promise.all([
      env.DB.prepare('SELECT declarer_attempts,declarer_successes,deputy_attempts,deputy_successes FROM player_performance WHERE user_id=?').bind(userId).first(),
      env.DB.prepare('SELECT exact_attempts,exact_successes,solo_attempts,solo_successes FROM player_precision WHERE user_id=?').bind(userId).first(),
      env.DB.prepare('SELECT attempts,plays FROM player_art_rate WHERE user_id=?').bind(userId).first(),
      env.DB.prepare('SELECT attempts,successes FROM player_ally_feed WHERE user_id=?').bind(userId).first(),
      env.DB.prepare('SELECT attempts,successes FROM player_bold_bid_rate WHERE user_id=?').bind(userId).first(),
      env.DB.prepare('SELECT result,delta,rating_after,created_at FROM match_history WHERE user_id=? ORDER BY id DESC LIMIT 50').bind(userId).all(),
      env.DB.prepare('SELECT declarer_attempts,bid_total,nt_bids,color_bids,match_count,rank_1,rank_2,rank_3,rank_4,rank_5 FROM player_match_stats WHERE user_id=?').bind(userId).first()
    ]);

  const matchStats = matchStatsRow || { declarer_attempts: 0, bid_total: 0, nt_bids: 0, color_bids: 0, match_count: 0, rank_1: 0, rank_2: 0, rank_3: 0, rank_4: 0, rank_5: 0 };
  const performance = performanceRow || { declarer_attempts: 0, declarer_successes: 0, deputy_attempts: 0, deputy_successes: 0 };
  const precision = precisionRow || { exact_attempts: 0, exact_successes: 0, solo_attempts: 0, solo_successes: 0 };
  const artRate = artRateRow || { attempts: 0, plays: 0 };
  const allyFeed = allyFeedRow || { attempts: 0, successes: 0 };
  const boldBid = boldBidRow || { attempts: 0, successes: 0 };

  const [ratingRank, performanceRankValues] = await Promise.all([
    env.DB.prepare('SELECT COUNT(*) AS ahead FROM players WHERE rating>?').bind(p.rating).first(),
    Promise.all([
      metricRank(env.DB, 'player_performance', 'declarer_successes', 'declarer_attempts', performance.declarer_successes, performance.declarer_attempts),
      metricRank(env.DB, 'player_performance', 'deputy_successes', 'deputy_attempts', performance.deputy_successes, performance.deputy_attempts),
      metricRank(env.DB, 'player_precision', 'exact_successes', 'exact_attempts', precision.exact_successes, precision.exact_attempts),
      metricRank(env.DB, 'player_precision', 'solo_successes', 'solo_attempts', precision.solo_successes, precision.solo_attempts),
      metricRank(env.DB, 'player_art_rate', 'plays', 'attempts', artRate.plays, artRate.attempts),
      metricRank(env.DB, 'player_ally_feed', 'successes', 'attempts', allyFeed.successes, allyFeed.attempts),
      metricRank(env.DB, 'player_bold_bid_rate', 'successes', 'attempts', boldBid.successes, boldBid.attempts)
    ])
  ]);

  const performanceRanks = {
    bid: performanceRankValues[0], deputy: performanceRankValues[1],
    exact: performanceRankValues[2], solo: performanceRankValues[3],
    artPlay: performanceRankValues[4], allyFeed: performanceRankValues[5],
    boldBid: performanceRankValues[6]
  };

  return response({
    ...p, performance, precision, artRate, allyFeed, boldBid,
    ranks: { rating: ratingRank.ahead + 1 },
    performanceRanks, matchStats, history: historyPage.results
  });
}

// ---------------- ランキング ----------------
export async function handleRatingTop(request, env) {
  const { results } = await env.DB.prepare(
    'SELECT player_id AS id,username,rating,wins,losses,games FROM players ORDER BY rating DESC,games DESC LIMIT 50'
  ).all();
  return response(results);
}
