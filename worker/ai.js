// ============================================================
// worker/ai.js
// 依存: constants.js, ai-simulator.js, worker/state.js
// 役割: AI 戦略系 API ハンドラ
// ============================================================
import { defaultStrategy } from '../constants.js';
import { runSelfPlayBatch, generateInsights } from '../ai-simulator.js';
import { response, botStrategyCache } from './state.js';

// ---------------- 現在の重み ----------------
export async function handleAiWeights(request, env) {
  try {
    const w = await env.DB.prepare('SELECT weights,games FROM ai_weights WHERE id=1').first();
    return response(w || { weights: '{}', games: 0 });
  } catch {
    return response({ weights: '{}', games: 0 });
  }
}

// ---------------- 手動フィードバック ----------------
export async function handleAiReport(request, env) {
  let body;
  try { body = await request.json(); }
  catch { return response({ error: 'invalid' }, 400); }

  try {
    const w = await env.DB.prepare('SELECT weights,games FROM ai_weights WHERE id=1').first();
    const weights = JSON.parse(w?.weights || '{}');
    const lr = 0.005;

    if (body.napoleonWon) {
      weights.bidThreshold = Math.max(2.0, (weights.bidThreshold || 4.0) - lr);
      weights.leadAggression = Math.min(1.0, (weights.leadAggression || 0.6) + lr);
      weights.followAggression = Math.min(1.0, (weights.followAggression || 0.4) + lr * 0.5);
    } else {
      weights.bidThreshold = Math.min(6.0, (weights.bidThreshold || 4.0) + lr);
      weights.leadAggression = Math.max(0.2, (weights.leadAggression || 0.6) - lr);
      weights.followAggression = Math.max(0.1, (weights.followAggression || 0.4) - lr * 0.5);
    }
    if (body.exactWins > 1) {
      weights.riskTolerance = Math.min(1.0, (weights.riskTolerance || 0.5) + lr * 0.3);
      weights.trumpBonus = Math.min(1.5, (weights.trumpBonus || 0.6) + lr * 0.2);
    }
    if (body.lastPlacePenalty > 0) {
      weights.riskTolerance = Math.max(0.1, (weights.riskTolerance || 0.5) - lr * 0.3);
    }

    await env.DB.prepare(
      'UPDATE ai_weights SET weights=?,games=games+1,updated_at=CURRENT_TIMESTAMP WHERE id=1'
    ).bind(JSON.stringify(weights)).run();

    botStrategyCache.value = null;
    botStrategyCache.time = 0;
    return response({ ok: true, weights, games: (w?.games || 0) + 1 });
  } catch {
    return response({ error: 'save failed' }, 500);
  }
}

// ---------------- 自己対戦 ----------------
export async function handleAiRunSelfPlay(request, env) {
  try {
    const body = await request.json().catch(() => ({}));
    const count = Math.max(1, Math.min(5000, Number(body.matches) || 1000));
    const result = await runSelfPlayBatch(env, count);
    botStrategyCache.value = null;
    botStrategyCache.time = 0;
    return response({ ok: true, ...result });
  } catch (e) {
    return response({ error: 'self-play failed: ' + (e.message || 'unknown') }, 500);
  }
}

// ---------------- 戦略一覧 ----------------
export async function handleAiStrategies(request, env, url) {
  try {
    const limit = Math.max(1, Math.min(50, Number(url.searchParams.get('limit')) || 10));
    const { results } = await env.DB.prepare(
      'SELECT * FROM ai_strategy_log ORDER BY avg_rating_delta DESC, id DESC LIMIT ?'
    ).bind(limit).all();
    return response(results);
  } catch {
    return response({ error: 'load failed' }, 500);
  }
}

// ---------------- インサイト ----------------
export async function handleAiInsights(request, env) {
  try {
    const { results } = await env.DB.prepare(
      'SELECT * FROM ai_strategy_log ORDER BY avg_rating_delta DESC, id DESC LIMIT 5'
    ).all();
    return response({ insights: generateInsights(results), strategies: results });
  } catch {
    return response({ error: 'load failed' }, 500);
  }
}

// ---------------- 世代推移 ----------------
export async function handleAiGenerations(request, env) {
  try {
    const { results } = await env.DB.prepare(
      'SELECT generation, MAX(overall_win_rate) AS best, MAX(avg_rating_delta) AS best_delta, '
      + 'MAX(nap_win_rate) AS nap, MAX(deputy_win_rate) AS dep, MAX(alliance_win_rate) AS ally, '
      + 'COUNT(*) AS count FROM ai_strategy_log GROUP BY generation ORDER BY generation DESC LIMIT 30'
    ).all();
    return response(results.reverse());
  } catch {
    return response({ error: 'load failed' }, 500);
  }
}

// ---------------- トップ戦略 ----------------
export async function handleAiTopStrategy(request, env) {
  try {
    const row = await env.DB.prepare(
      'SELECT params,avg_rating_delta,generation FROM ai_strategy_log ORDER BY avg_rating_delta DESC, id DESC LIMIT 1'
    ).first();
    if (!row) return response({ strategy: defaultStrategy(), source: 'default' });
    return response({
      strategy: JSON.parse(row.params),
      avgRating: row.avg_rating_delta,
      generation: row.generation,
      source: 'learned'
    });
  } catch {
    return response({ strategy: defaultStrategy(), source: 'default' });
  }
}
