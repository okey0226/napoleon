// ===== [tactics.js 前半 開始] =====
// tactics.js — MECE戦術カタログ層（期待値動的化版）
// 修正: W2/W3/W5/W6/W8/W9/C2/C3/C5/C6/C8/G1/G2/PS4 の analytic を動的化

import {
  SUITS, RANKS, FACE, SV, sameColorSuitOf,
  defaultStrategy,
} from './constants.js';
import {
  classifySituation, hashSituation, deriveSeedFromSituation,
} from './situation.js';
import {
  evaluateSameTwo, shouldAvoidACut, generateSameTwoTactics,
} from './same-two.js';
import {
  analyzeCombinations,
} from './combinations.js';

// ============================================================
// 公開: 静的戦術カタログ
// ============================================================
export const TACTIC_CATALOG = buildCatalog();

// ============================================================
// 公開: メイン関数 — 状況から戦術を決定論的に選択
// ============================================================
export function selectTactic(ctx, params, experience) {
  const p = params || defaultStrategy();
  if (p.enableTacticEngine === false) {
    return { tactic: UNIVERSAL_FALLBACK, prior: -Infinity, situation: null, candidates: [], disabled: true };
  }
  const situation = classifySituation(ctx);
  const situationHash = hashSituation(ctx);
  const candidates = generateCandidates(ctx, situation, p, situationHash);
  const scored = candidates.map(t => ({
    ...t,
    prior: calculatePrior(t, situation, ctx, p, experience, situationHash),
  }));
  if (scored.length === 0) {
    return { tactic: UNIVERSAL_FALLBACK, prior: -Infinity, situation, situationHash, candidates: [] };
  }
  scored.sort((a, b) => {
    if (Math.abs(a.prior - b.prior) > 1e-9) return b.prior - a.prior;
    return String(a.id).localeCompare(String(b.id));
  });
  return { tactic: scored[0], prior: scored[0].prior, situation, situationHash, candidates: scored };
}

// ============================================================
// 公開: 全候補のprior一覧
// ============================================================
export function scoreAllTactics(ctx, params, experience) {
  const p = params || defaultStrategy();
  const situation = classifySituation(ctx);
  const situationHash = hashSituation(ctx);
  const candidates = generateCandidates(ctx, situation, p, situationHash);
  return candidates.map(t => ({
    id: t.id,
    name: t.name,
    category: t.category,
    prior: calculatePrior(t, situation, ctx, p, experience, situationHash),
    analyticEV: estimateAnalyticEV(t, situation, ctx, p),
  })).sort((a, b) => b.prior - a.prior);
}

// ============================================================
// 内部: 候補生成
// ============================================================
function generateCandidates(ctx, situation, p, situationHash) {
  const candidates = [];
  for (const t of PRIMITIVE_CATALOG) { if (matchesPreconditions(t, situation, ctx)) candidates.push(t); }
  for (const t of SELECTION_CATALOG) { if (matchesPreconditions(t, situation, ctx)) candidates.push(t); }
  for (const t of COMPOSITE_CATALOG) { if (matchesPreconditions(t, situation, ctx)) candidates.push(t); }
  for (const t of META_CATALOG) { if (matchesPreconditions(t, situation, ctx)) candidates.push(t); }

  const sameTwoTactics = generateSameTwoTactics(ctx, situation, p);
  for (const st of sameTwoTactics) {
    candidates.push({
      id: st.id, name: st.name, category: 'same_two', description: st.description,
      analytic: () => st.score ?? 0,
      roles: ['nap', 'deputy_revealed', 'deputy_hidden', 'alliance'],
      turns: ['lead', 'follow_self_win', 'follow_ally_win', 'follow_enemy_win'],
      phases: ['early', 'mid', 'late', 'final'],
    });
  }

  try {
    const comb = analyzeCombinations(ctx);
    for (const ct of comb.tactics) {
      candidates.push({
        id: ct.id, name: ct.name, category: 'combination', description: '',
        analytic: () => ct.score ?? 0,
        roles: ['nap', 'deputy_revealed', 'deputy_hidden', 'alliance'],
        turns: ['lead', 'follow_self_win', 'follow_ally_win', 'follow_enemy_win'],
        phases: ['early', 'mid', 'late', 'final'],
      });
    }
  } catch (e) { /* スキップ */ }

  candidates.push(UNIVERSAL_FALLBACK);
  return candidates;
}

// ============================================================
// 内部: 前提条件マッチ
// ============================================================
function matchesPreconditions(t, situation, ctx) {
  if (!t.roles || !t.roles.includes(situation.role)) return false;
  if (!t.turns || !t.turns.includes(situation.turn)) return false;
  if (!t.phases || !t.phases.includes(situation.phase)) return false;
  if (typeof t.extraCheck === 'function') {
    try { return t.extraCheck(situation, ctx); } catch { return false; }
  }
  return true;
}

// ============================================================
// 内部: prior計算
// ============================================================
function calculatePrior(tactic, situation, ctx, p, experience, situationHash) {
  const W_MATCH = p.W_MATCH ?? 2.0;
  const W_ANALYTIC = p.W_ANALYTIC ?? 3.0;
  const W_EXPERIENCE = (p.W_EXPERIENCE ?? 1.5) * (p.experienceBlendRatio ?? 0.4);
  const W_RISK = p.W_RISK ?? 1.5;
  const matchScore = evaluateMatchScore(tactic, situation, ctx);
  const analyticEV = estimateAnalyticEV(tactic, situation, ctx, p);
  const expScore = evaluateExperience(tactic, situation, ctx, experience, situationHash);
  const riskScore = evaluateRisk(tactic, situation, ctx, p);
  return matchScore * W_MATCH + analyticEV * W_ANALYTIC + expScore * W_EXPERIENCE - riskScore * W_RISK;
}

function evaluateMatchScore(tactic, situation, ctx) {
  let score = 1.0;
  if (tactic.id.startsWith('W')) score += 0.5;
  if (tactic.id.startsWith('Q3')) score += 0.3;
  if (tactic.id === 'UNIVERSAL') score = 0.01;
  if (tactic.phases && tactic.phases.includes(situation.phase)) score += 0.2;
  return score;
}

function estimateAnalyticEV(tactic, situation, ctx, p) {
  if (typeof tactic.analytic === 'function') {
    try { return Number(tactic.analytic(situation, ctx, p)) || 0; } catch { return 0; }
  }
  return 0;
}

function evaluateExperience(tactic, situation, ctx, experience, situationHash) {
  if (!experience || !experience.tactics) return 0;
  const key = `${tactic.id}:${situationHash}`;
  const exp = experience.tactics[key];
  if (!exp || exp.samples < 3) return 0;
  const winRate = exp.wins / exp.samples;
  return (winRate - 0.5) * 2.0;
}

function evaluateRisk(tactic, situation, ctx, p) {
  let risk = 0;
  if (tactic.id === 'Q3-1' || tactic.id === 'Q3-7') {
    const aRisk = shouldAvoidACut(ctx, situation, p);
    if (aRisk.avoid) risk += aRisk.risk * 2.0;
  }
  if (situation.allTakeRisk === 'urgent') {
    if (tactic.id.startsWith('W')) risk += 2.0;
  }
  if (tactic.id === 'W7' || tactic.id === 'Q3-7') {
    const aRisk = shouldAvoidACut(ctx, situation, p);
    if (aRisk.avoid) risk += aRisk.risk * 1.5;
  }
  return risk;
}

// ============================================================
// 内部: 動的評価ヘルパー（共通）
// ============================================================
function trickPointsInTrick(ctx) {
  return ((ctx?.trick) || []).filter(t => t.card && FACE.includes(t.card.rank)).length;
}

function trickPointBonus(ctx, weight = 0.5) {
  const pts = trickPointsInTrick(ctx);
  if (pts >= 3) return 1.5 * weight * 2;
  if (pts >= 1) return 0.5 * weight * 2;
  return -0.5 * weight * 2;
}

function phaseBonus(situation, earlyW = 0, midW = 0, lateW = 0.5, finalW = 0.5) {
  if (situation.phase === 'early') return earlyW;
  if (situation.phase === 'mid') return midW;
  if (situation.phase === 'late') return lateW;
  return finalW;
}

function trumpStateBonus(situation) {
  if (situation.enemyTrump === 'exhausted') return 0.5;
  if (situation.enemyTrump === 'light') return 0.3;
  if (situation.enemyTrump === 'heavy') return -0.3;
  return 0;
}

// ============================================================
// UNIVERSAL_FALLBACK
// ============================================================
const UNIVERSAL_FALLBACK = {
  id: 'UNIVERSAL',
  name: 'ユニバーサル最弱切り',
  category: 'fallback',
  description: '合法手の中で最弱を切る（最終フォールバック）',
  roles: ['nap', 'deputy_revealed', 'deputy_hidden', 'alliance'],
  turns: ['lead', 'follow_self_win', 'follow_ally_win', 'follow_enemy_win'],
  phases: ['early', 'mid', 'late', 'final'],
  analytic: () => -10.0,
};

// ============================================================
// プリミティブ戦術カタログ（90戦術・期待値動的化）
// ============================================================
const PRIMITIVE_CATALOG = [
  // ─────────────────────────────────────
  // W: WIN/Cash（14戦術）★ 動的化
  // ─────────────────────────────────────
  { id: 'W1', name: '影狩り', category: 'W', roles: ['nap', 'deputy_revealed', 'deputy_hidden', 'alliance'],
    turns: ['follow_enemy_win', 'follow_ally_win', 'follow_self_win'], phases: ['early', 'mid', 'late', 'final'],
    analytic: (s, ctx) => {
      const trick = ctx?.trick || [];
      const hasMightyInTrick = trick.some(t => t.card?.id === '♠A');
      const legalHasShadow = (ctx?.legal || []).some(c => c.id === '♥Q');
      if (!hasMightyInTrick || !legalHasShadow) return -5.0;
      const base = 3.0;
      const pts = trick.filter(t => t.card && FACE.includes(t.card.rank)).length;
      return base + pts * 0.5;
    },
  },
  { id: 'W1b', name: '影狩り抑制', category: 'W', roles: ['nap', 'deputy_revealed', 'deputy_hidden', 'alliance'],
    turns: ['follow_ally_win'], phases: ['early', 'mid', 'late', 'final'],
    extraCheck: (s, ctx) => {
      const trick = ctx?.trick || [];
      return trick.some(t => t.card?.id === '♠A') && (ctx?.legal || []).some(c => c.id === '♥Q');
    },
    analytic: () => 1.0,
  },
  // ★ W2: マイティ確定取り 動的化
  { id: 'W2', name: 'マイティ確定取り', category: 'W', roles: ['nap', 'deputy_revealed', 'alliance'],
    turns: ['lead', 'follow_ally_win'], phases: ['mid', 'late', 'final'],
    analytic: (s, ctx) => {
      const hasMighty = (ctx?.hand || []).some(c => c.id === '♠A');
      const shadowInTrick = (ctx?.trick || []).some(t => t.card?.id === '♥Q');
      if (!hasMighty || shadowInTrick) return -3.0;
      return 2.0 + trickPointBonus(ctx, 0.6) + phaseBonus(s, 0, 0.3, 0.8, 1.0);
    },
  },
  // ★ W3: 正J確定取り 動的化
  { id: 'W3', name: '正J確定取り', category: 'W', roles: ['nap', 'deputy_revealed', 'alliance'],
    turns: ['lead', 'follow_ally_win'], phases: ['mid', 'late', 'final'],
    analytic: (s, ctx) => {
      if (!ctx?.contract || ctx.contract.suit === 'NT') return -3.0;
      const hasTrumpJ = (ctx?.hand || []).some(c => c.rank === 'J' && c.suit === ctx.contract.suit);
      const mightyInTrick = (ctx?.trick || []).some(t => t.card?.id === '♠A');
      if (!hasTrumpJ || mightyInTrick) return -3.0;
      return 1.8 + trickPointBonus(ctx, 0.5) + phaseBonus(s, 0, 0.3, 0.7, 0.9);
    },
  },
  { id: 'W4', name: '裏J確定取り', category: 'W', roles: ['nap', 'deputy_revealed', 'alliance'],
    turns: ['lead', 'follow_ally_win'], phases: ['mid', 'late', 'final'],
    analytic: (s, ctx) => {
      if (!ctx?.contract || ctx.contract.suit === 'NT') return -3.0;
      const scj = sameColorSuitOf(ctx.contract.suit);
      const hasSameColorJ = (ctx?.hand || []).some(c => c.rank === 'J' && c.suit === scj);
      const trumpJInTrick = (ctx?.trick || []).some(t => t.card?.rank === 'J' && t.card?.suit === ctx.contract.suit);
      if (!hasSameColorJ || trumpJInTrick) return -3.0;
      return 1.5 + trickPointBonus(ctx, 0.4) + phaseBonus(s, 0, 0.2, 0.6, 0.8);
    },
  },
  // ★ W5: セイム2確定取り 動的化
  { id: 'W5', name: 'セイム2確定取り', category: 'W', roles: ['nap', 'deputy_revealed', 'alliance'],
    turns: ['lead', 'follow_self_win'], phases: ['early', 'mid', 'late'],
    analytic: (s, ctx) => {
      if ((ctx?.trickNo ?? 0) === 0) return -3.0;
      const two = (ctx?.hand || []).find(c => c.rank === '2');
      const allFollow = (ctx?.trick || []).every(t => t.card?.suit === (ctx?.trick?.[0]?.card?.suit));
      if (!two || !allFollow) return -2.0;
      return 2.5 + trickPointBonus(ctx, 0.5) + phaseBonus(s, 0.3, 0.5, 0.3, 0.1);
    },
  },
  // ★ W6: 切札A確定取り 動的化（固定1.5 → 2.0〜3.5）
  { id: 'W6', name: '切札A確定取り', category: 'W', roles: ['nap', 'deputy_revealed', 'alliance'],
    turns: ['lead', 'follow_ally_win'], phases: ['late', 'final'],
    analytic: (s, ctx) => {
      if (!ctx?.contract || ctx.contract.suit === 'NT') return -2.0;
      const has = (ctx?.hand || []).some(c => c.rank === 'A' && c.suit === ctx.contract.suit);
      if (!has) return -2.0;
      return 2.0 + trickPointBonus(ctx, 0.6) + phaseBonus(s, 0, 0.5, 1.0, 1.5);
    },
  },
  { id: 'W7', name: 'サイドA確定取り', category: 'W', roles: ['nap', 'deputy_revealed'],
    turns: ['lead'], phases: ['early', 'mid', 'late'],
    extraCheck: (s, ctx) => {
      const aRisk = shouldAvoidACut(ctx, s, {});
      return !aRisk.avoid;
    },
    analytic: (s, ctx) => {
      const sideAces = (ctx?.hand || []).filter(c => c.rank === 'A' && c.suit !== ctx?.contract?.suit && c.id !== '♠A');
      if (!sideAces.length) return -2.0;
      return 1.8 + trickPointBonus(ctx, 0.4) + phaseBonus(s, 0.3, 0.5, 0.6, 0.6);
    },
  },
  // ★ W8: フォローハイ確定取り 動的化（固定1.0 → 0.5〜2.5）
  { id: 'W8', name: 'フォローハイ確定取り', category: 'W', roles: ['nap', 'deputy_revealed', 'alliance'],
    turns: ['follow_enemy_win'], phases: ['early', 'mid', 'late', 'final'],
    analytic: (s, ctx) => {
      const legal = ctx?.legal || [];
      if (!legal.length) return -2.0;
      const highest = legal.slice().sort((a, b) => RANKS.indexOf(b.rank) - RANKS.indexOf(a.rank))[0];
      if (RANKS.indexOf(highest.rank) < 10) return -1.0;
      const base = 1.0;
      const trick = ctx?.trick || [];
      const pts = trick.filter(t => t.card && FACE.includes(t.card.rank)).length;
      return base + pts * 0.5 + phaseBonus(s, 0, 0.2, 0.5, 0.7);
    },
  },
  // ★ W9: 切札順位勝ち 動的化（固定1.0 → 1.5〜2.0）
  { id: 'W9', name: '切札順位勝ち', category: 'W', roles: ['nap', 'deputy_revealed', 'alliance'],
    turns: ['follow_enemy_win'], phases: ['mid', 'late'],
    analytic: (s, ctx) => {
      if (ctx?.contract?.suit === 'NT' || !(ctx?.hand || []).some(c => c.suit === ctx.contract.suit)) return -2.0;
      return 1.5 + trickPointBonus(ctx, 0.4) + phaseBonus(s, 0, 0.2, 0.4, 0.5);
    },
  },
  { id: 'W10', name: 'セイム2競り勝ち', category: 'W', roles: ['nap', 'deputy_revealed', 'alliance'],
    turns: ['follow_enemy_win'], phases: ['mid', 'late'],
    analytic: (s, ctx) => {
      const two = (ctx?.hand || []).find(c => c.rank === '2');
      if (!two || (ctx?.trickNo ?? 0) <= 0) return -2.0;
      return 1.5 + trickPointBonus(ctx, 0.4);
    },
  },
  { id: 'W11', name: '最終手番勝ち', category: 'W', roles: ['nap', 'deputy_revealed', 'alliance'],
    turns: ['follow_enemy_win', 'follow_ally_win'], phases: ['late', 'final'],
    extraCheck: (s, ctx) => (ctx?.trick || []).length === 4,
    analytic: (s, ctx) => 1.8 + trickPointBonus(ctx, 0.5) + phaseBonus(s, 0, 0, 0.2, 0.4),
  },
  { id: 'W12', name: 'カウンター影', category: 'W', roles: ['nap', 'deputy_revealed', 'alliance'],
    turns: ['follow_enemy_win'], phases: ['mid', 'late', 'final'],
    analytic: (s, ctx) => {
      const trick = ctx?.trick || [];
      const hasMightyInTrick = trick.some(t => t.card?.id === '♠A');
      const shadowInLegal = (ctx?.legal || []).some(c => c.id === '♥Q');
      if (!hasMightyInTrick || !shadowInLegal) return -3.0;
      return 2.5 + trickPointBonus(ctx, 0.5);
    },
  },
  { id: 'W13', name: '複合絶対勝ち', category: 'W', roles: ['nap'], turns: ['lead'],
    phases: ['mid', 'late', 'final'],
    analytic: (s, ctx) => 2.0 + trickPointBonus(ctx, 0.3) + phaseBonus(s, 0, 0.3, 0.5, 0.6),
  },
  { id: 'W14', name: '余裕勝ち', category: 'W', roles: ['nap', 'deputy_revealed'],
    turns: ['lead'], phases: ['mid'],
    analytic: (s, ctx) => 0.8 + trickPointBonus(ctx, 0.2),
  },

  // ─────────────────────────────────────
  // C: WIN/Challenge（8戦術）★ 動的化
  // ─────────────────────────────────────
  { id: 'C1', name: 'オーバートランプ', category: 'C', roles: ['nap', 'deputy_revealed', 'alliance'],
    turns: ['follow_enemy_win'], phases: ['early', 'mid', 'late', 'final'],
    analytic: (s, ctx) => {
      const ledSuit = ctx?.trick?.[0]?.card?.suit;
      const selfVoid = ctx?.voids?.[ctx?.seat]?.[ledSuit];
      if (!selfVoid) return -2.0;
      return 1.5 + trickPointBonus(ctx, 0.5) + phaseBonus(s, 0, 0.2, 0.4, 0.5);
    },
  },
  // ★ C2: 切札競り 0.8 → 1.5〜1.8
  { id: 'C2', name: '切札競り', category: 'C', roles: ['nap', 'deputy_revealed', 'alliance'],
    turns: ['follow_enemy_win'], phases: ['early', 'mid'],
    analytic: (s, ctx) => 1.6 + trickPointBonus(ctx, 0.4) + trumpStateBonus(s),
  },
  // ★ C3: ハイフォロー競り 0.5 → 1.2〜1.5
  { id: 'C3', name: 'ハイフォロー競り', category: 'C', roles: ['nap', 'deputy_revealed', 'alliance'],
    turns: ['follow_enemy_win'], phases: ['early', 'mid'],
    analytic: (s, ctx) => 1.3 + trickPointBonus(ctx, 0.4),
  },
  { id: 'C4', name: 'セイム2競り', category: 'C', roles: ['alliance'],
    turns: ['follow_enemy_win'], phases: ['mid', 'late'],
    analytic: (s, ctx) => {
      const hasTwo = (ctx?.hand || []).some(c => c.rank === '2');
      if (!hasTwo) return -2.0;
      return 1.2 + trickPointBonus(ctx, 0.4);
    },
  },
  // ★ C5: マイティの影警戒勝ち 動的化 + extraCheck
  { id: 'C5', name: 'マイティの影警戒勝ち', category: 'C', roles: ['nap', 'deputy_revealed'],
    turns: ['lead'], phases: ['mid', 'late'],
    extraCheck: (s, ctx) => {
      const hand = ctx?.hand || [];
      const hasMighty = hand.some(c => c.id === '♠A');
      const hqPlayed = (ctx?.playedCards || []).some(c => c.id === '♥Q');
      const hqInDiscard = (ctx?.discardedKitty || []).some(c => c.id === '♥Q');
      return hasMighty && (hqPlayed || hqInDiscard);
    },
    analytic: (s, ctx) => {
      const base = 2.0;
      const pts = trickPointsInTrick(ctx);
      return base + pts * 0.4 + phaseBonus(s, 0, 0.3, 0.6, 0.8);
    },
  },
  // ★ C6: 中位切札勝ち 0.8 → 1.5
  { id: 'C6', name: '中位切札勝ち', category: 'C', roles: ['nap', 'deputy_revealed', 'alliance'],
    turns: ['follow_enemy_win'], phases: ['early', 'mid'],
    analytic: (s, ctx) => 1.5 + trickPointBonus(ctx, 0.4) + trumpStateBonus(s),
  },
  { id: 'C7', name: '最終手番逆転', category: 'C', roles: ['nap', 'deputy_revealed', 'alliance'],
    turns: ['follow_enemy_win'], phases: ['late', 'final'],
    extraCheck: (s, ctx) => (ctx?.trick || []).length === 4,
    analytic: (s, ctx) => 1.5 + trickPointBonus(ctx, 0.4) + phaseBonus(s, 0, 0, 0.3, 0.5),
  },
  // ★ C8: 同スート競り 0.6 → 1.2
  { id: 'C8', name: '同スート競り', category: 'C', roles: ['nap', 'deputy_revealed', 'alliance'],
    turns: ['follow_enemy_win'], phases: ['early', 'mid'],
    analytic: (s, ctx) => 1.2 + trickPointBonus(ctx, 0.4),
  },

  // ─────────────────────────────────────
  // D: LOSE/Duck（15戦術）
  // ─────────────────────────────────────
  { id: 'D1', name: '最弱ダック', category: 'D', roles: ['nap', 'deputy_revealed', 'deputy_hidden', 'alliance'],
    turns: ['lead', 'follow_enemy_win', 'follow_ally_win'], phases: ['early', 'mid', 'late'],
    analytic: (s) => s.trickValue === 'zero' ? 0.5 : -1.0,
  },
  { id: 'D2', name: '点札回避ダック', category: 'D', roles: ['nap', 'deputy_revealed', 'deputy_hidden', 'alliance'],
    turns: ['follow_enemy_win'], phases: ['early', 'mid'],
    analytic: (s, ctx) => {
      const handPoints = (ctx?.hand || []).filter(c => FACE.includes(c.rank)).length;
      return handPoints >= 3 ? 0.8 : 0;
    },
  },
  { id: 'D3', name: 'マイティ温存ダック', category: 'D', roles: ['nap', 'deputy_revealed'],
    turns: ['lead', 'follow_enemy_win', 'follow_ally_win'], phases: ['early', 'mid'],
    analytic: (s, ctx) => (ctx?.hand || []).some(c => c.id === '♠A') ? 1.0 : 0,
  },
  { id: 'D4', name: '切札温存ダック', category: 'D', roles: ['nap', 'deputy_revealed', 'alliance'],
    turns: ['follow_enemy_win'], phases: ['early'],
    analytic: (s, ctx) => {
      if (!ctx?.contract || ctx.contract.suit === 'NT') return 0;
      return (ctx?.hand || []).filter(c => c.suit === ctx.contract.suit).length >= 3 ? 0.7 : 0;
    },
  },
  { id: 'D5', name: 'A温存ダック', category: 'D', roles: ['nap', 'deputy_revealed'],
    turns: ['lead', 'follow_enemy_win'], phases: ['early', 'mid'],
    analytic: (s, ctx) => {
      const aRisk = shouldAvoidACut(ctx, s, {});
      return aRisk.avoid ? 1.2 : 0.5;
    },
  },
  { id: 'D6', name: '点札保持ダック', category: 'D', roles: ['nap', 'deputy_revealed', 'deputy_hidden', 'alliance'],
    turns: ['follow_enemy_win'], phases: ['early', 'mid', 'late'],
    analytic: () => 0.3,
  },
  { id: 'D7', name: 'ボイド作成捨て', category: 'D', roles: ['nap', 'deputy_revealed'],
    turns: ['lead', 'follow_enemy_win'], phases: ['early', 'mid'],
    analytic: (s, ctx) => {
      if (!ctx?.contract || ctx.contract.suit === 'NT') return 0;
      const trumps = (ctx?.hand || []).filter(c => c.suit === ctx.contract.suit).length;
      return trumps >= 4 ? 1.0 : 0;
    },
  },
  { id: 'D8', name: 'マストフォロー低札', category: 'D', roles: ['nap', 'deputy_revealed', 'deputy_hidden', 'alliance'],
    turns: ['follow_enemy_win'], phases: ['early', 'mid', 'late', 'final'],
    analytic: () => 0.2,
  },
  { id: 'D9', name: '捨て札温存', category: 'D', roles: ['nap', 'deputy_revealed', 'deputy_hidden', 'alliance'],
    turns: ['follow_enemy_win'], phases: ['late', 'final'],
    analytic: () => 0.3,
  },
  { id: 'D10', name: 'ジャミング回避', category: 'D', roles: ['nap', 'deputy_revealed', 'deputy_hidden', 'alliance'],
    turns: ['lead', 'follow_enemy_win'], phases: ['mid', 'late'],
    analytic: () => 0.2,
  },
  { id: 'D11', name: '次主導権放棄', category: 'D', roles: ['nap', 'deputy_revealed', 'deputy_hidden', 'alliance'],
    turns: ['lead'], phases: ['mid', 'late'],
    analytic: () => 0.3,
  },
  { id: 'D12', name: '情報秘匿ダック', category: 'D', roles: ['deputy_hidden'],
    turns: ['follow_enemy_win'], phases: ['early', 'mid'],
    analytic: () => 0.8,
  },
  { id: 'D13', name: '点札ゼロ流し', category: 'D', roles: ['nap', 'deputy_revealed', 'deputy_hidden', 'alliance'],
    turns: ['follow_enemy_win'], phases: ['early', 'mid'],
    analytic: (s) => s.trickValue === 'zero' ? 0.5 : -1.0,
  },
  { id: 'D14', name: '安全ダック', category: 'D', roles: ['nap', 'deputy_revealed', 'deputy_hidden', 'alliance'],
    turns: ['lead', 'follow_enemy_win'], phases: ['mid', 'late'],
    analytic: (s) => s.scoreState === 'massive_ahead' ? 1.0 : 0.3,
  },
  { id: 'D15', name: 'オフ捨て', category: 'D', roles: ['nap', 'deputy_revealed', 'deputy_hidden', 'alliance'],
    turns: ['follow_enemy_win'], phases: ['early', 'mid', 'late'],
    analytic: () => 0.3,
  },

  // ─────────────────────────────────────
  // S: LOSE/Sacrifice（8戦術）
  // ─────────────────────────────────────
  { id: 'S1', name: '高札誘導犠牲', category: 'S', roles: ['alliance', 'deputy_hidden', 'nap'],
    turns: ['follow_enemy_win'], phases: ['early', 'mid'],
    analytic: (s) => s.trickValue === 'low' ? 0.6 : -0.5,
  },
  { id: 'S2', name: '切札枯らし犠牲', category: 'S', roles: ['nap', 'deputy_revealed', 'alliance'],
    turns: ['follow_enemy_win'], phases: ['early', 'mid'],
    analytic: (s, ctx) => {
      const enemyTrumps = 13 - (ctx?.playedCards || []).filter(c => c.suit === ctx?.contract?.suit).length - (ctx?.hand || []).filter(c => c.suit === ctx?.contract?.suit).length;
      return enemyTrumps >= 3 ? 0.8 : -0.3;
    },
  },
  { id: 'S3', name: '点札保護犠牲', category: 'S', roles: ['nap', 'deputy_revealed'],
    turns: ['follow_enemy_win'], phases: ['mid', 'late'],
    analytic: (s) => s.trickValue === 'high' ? 1.2 : 0,
  },
  { id: 'S4', name: 'オーバートランプ誘導', category: 'S', roles: ['nap', 'deputy_revealed', 'alliance'],
    turns: ['follow_enemy_win'], phases: ['mid'],
    analytic: () => 0.4,
  },
  { id: 'S5', name: 'マイティ誘導', category: 'S', roles: ['alliance'],
    turns: ['follow_enemy_win'], phases: ['mid'],
    analytic: (s, ctx) => (ctx?.playedCards || []).some(c => c.id === '♠A') ? 0 : 0.5,
  },
  { id: 'S6', name: '正J誘導', category: 'S', roles: ['alliance'],
    turns: ['follow_enemy_win'], phases: ['mid'],
    analytic: () => 0.4,
  },
  { id: 'S7', name: '連合軍誘導', category: 'S', roles: ['nap'],
    turns: ['follow_enemy_win'], phases: ['mid', 'late'],
    analytic: () => 0.3,
  },
  { id: 'S8', name: 'ベイト', category: 'S', roles: ['nap', 'deputy_revealed', 'alliance'],
    turns: ['lead', 'follow_enemy_win'], phases: ['early', 'mid'],
    analytic: () => 0.5,
  },

  // ─────────────────────────────────────
  // AT: LOSE/AllTakeAvoid（5戦術）
  // ─────────────────────────────────────
  { id: 'AT1', name: '意図的失点', category: 'AT', roles: ['nap', 'deputy_revealed'],
    turns: ['lead', 'follow_ally_win', 'follow_enemy_win'], phases: ['late', 'final'],
    extraCheck: (s) => s.allTakeRisk === 'urgent' || s.allTakeRisk === 'warning',
    analytic: (s) => s.allTakeRisk === 'urgent' ? 5.0 : (s.allTakeRisk === 'warning' ? 2.0 : -10.0),
  },
  { id: 'AT2', name: '点札投棄', category: 'AT', roles: ['nap', 'deputy_revealed'],
    turns: ['lead', 'follow_enemy_win'], phases: ['late', 'final'],
    extraCheck: (s) => s.allTakeRisk === 'urgent',
    analytic: (s) => s.allTakeRisk === 'urgent' ? 4.0 : -10.0,
  },
  { id: 'AT3', name: 'NAP点札抑制', category: 'AT', roles: ['alliance'],
    turns: ['follow_enemy_win', 'follow_ally_win'], phases: ['late', 'final'],
    analytic: () => 1.5,
  },
  { id: 'AT4', name: '副官点札抑制', category: 'AT', roles: ['nap', 'deputy_revealed', 'alliance'],
    turns: ['follow_enemy_win'], phases: ['late', 'final'],
    analytic: () => 0.8,
  },
  { id: 'AT5', name: 'セイム2回避（全部取り防止）', category: 'AT', roles: ['nap', 'deputy_revealed'],
    turns: ['lead'], phases: ['late', 'final'],
    extraCheck: (s) => s.allTakeRisk === 'urgent',
    analytic: (s) => s.allTakeRisk === 'urgent' ? 3.0 : -10.0,
  },

  // ─────────────────────────────────────
  // G: GIVE/Feed（10戦術）★ G1/G2 動的化
  // ─────────────────────────────────────
  // ★ G1: 副官フィード 動的化
  { id: 'G1', name: '副官フィード', category: 'G', roles: ['nap'],
    turns: ['follow_ally_win'], phases: ['early', 'mid', 'late'],
    analytic: (s, ctx) => {
      const deputy = ctx?.contract?.deputy;
      if (deputy < 0 || ctx?.contract?.solo) return 0;
      const base = 1.2;
      const trick = ctx?.trick || [];
      const pts = trick.filter(t => t.card && FACE.includes(t.card.rank)).length;
      const phaseMultiplier = s.phase === 'late' || s.phase === 'final' ? 1.3 : 1.0;
      return (base + pts * 0.7) * phaseMultiplier;
    },
  },
  // ★ G2: NAPフィード 動的化
  { id: 'G2', name: 'NAPフィード', category: 'G', roles: ['deputy_revealed'],
    turns: ['follow_ally_win'], phases: ['early', 'mid', 'late'],
    analytic: (s, ctx) => {
      const base = 1.2;
      const trick = ctx?.trick || [];
      const pts = trick.filter(t => t.card && FACE.includes(t.card.rank)).length;
      const phaseMultiplier = s.phase === 'late' || s.phase === 'final' ? 1.3 : 1.0;
      return (base + pts * 0.7) * phaseMultiplier;
    },
  },
  { id: 'G3', name: '主導権譲渡', category: 'G', roles: ['nap', 'deputy_revealed', 'alliance'],
    turns: ['lead'], phases: ['early', 'mid'],
    analytic: () => 0.5,
  },
  { id: 'G4', name: '連合軍フィード', category: 'G', roles: ['alliance'],
    turns: ['follow_ally_win'], phases: ['early', 'mid', 'late'],
    analytic: (s, ctx) => {
      const base = 0.8;
      const pts = trickPointsInTrick(ctx);
      return base + pts * 0.5;
    },
  },
  { id: 'G5', name: '副官誘導フィード', category: 'G', roles: ['nap'],
    turns: ['lead'], phases: ['mid'],
    analytic: () => 0.7,
  },
  { id: 'G6', name: 'NAP誘導フィード', category: 'G', roles: ['deputy_revealed'],
    turns: ['lead'], phases: ['mid'],
    analytic: () => 0.7,
  },
  { id: 'G7', name: '中札フィード', category: 'G', roles: ['nap', 'deputy_revealed', 'alliance'],
    turns: ['follow_ally_win'], phases: ['early', 'mid', 'late'],
    analytic: () => 0.3,
  },
  { id: 'G8', name: '最終手番フィード', category: 'G', roles: ['nap', 'deputy_revealed', 'alliance'],
    turns: ['follow_ally_win'], phases: ['late', 'final'],
    extraCheck: (s, ctx) => (ctx?.trick || []).length === 4,
    analytic: (s, ctx) => 0.8 + trickPointBonus(ctx, 0.4),
  },
  { id: 'G9', name: 'オーバーキル回避フィード', category: 'G', roles: ['nap', 'deputy_revealed', 'alliance'],
    turns: ['follow_ally_win'], phases: ['early', 'mid', 'late'],
    analytic: (s) => s.overkillStatus === 'ally_winning' ? 1.5 : 0.3,
  },
  { id: 'G10', name: '連合軍協調フィード', category: 'G', roles: ['alliance'],
    turns: ['follow_ally_win'], phases: ['mid', 'late'],
    analytic: () => 0.6,
  },

  // ─────────────────────────────────────
  // OV: GIVE/OvertakeAvoid（6戦術）
  // ─────────────────────────────────────
  { id: 'OV1', name: '味方勝ち保護', category: 'OV', roles: ['nap', 'deputy_revealed', 'alliance'],
    turns: ['follow_ally_win'], phases: ['early', 'mid', 'late', 'final'],
    analytic: (s) => s.overkillStatus === 'ally_winning' ? 2.0 : 0.3,
  },
  { id: 'OV2', name: '味方フィード抑制', category: 'OV', roles: ['nap', 'deputy_revealed', 'alliance'],
    turns: ['follow_ally_win'], phases: ['mid', 'late'],
    analytic: () => 0.8,
  },
  { id: 'OV3', name: 'マイティ温存重ね', category: 'OV', roles: ['nap', 'deputy_revealed'],
    turns: ['follow_ally_win'], phases: ['mid', 'late'],
    analytic: (s, ctx) => (ctx?.hand || []).some(c => c.id === '♠A') ? 1.5 : 0,
  },
  { id: 'OV4', name: '切札温存重ね', category: 'OV', roles: ['nap', 'deputy_revealed', 'alliance'],
    turns: ['follow_ally_win'], phases: ['mid', 'late'],
    analytic: () => 1.0,
  },
  { id: 'OV5', name: '高札温存重ね', category: 'OV', roles: ['nap', 'deputy_revealed', 'alliance'],
    turns: ['follow_ally_win'], phases: ['mid', 'late'],
    analytic: () => 1.0,
  },
  { id: 'OV6', name: '最終手番オーバーキル回避', category: 'OV', roles: ['nap', 'deputy_revealed', 'alliance'],
    turns: ['follow_ally_win'], phases: ['late', 'final'],
    extraCheck: (s, ctx) => (ctx?.trick || []).length === 4,
    analytic: () => 1.5,
  },

  // ─────────────────────────────────────
  // H: HOLD（12戦術）
  // ─────────────────────────────────────
  { id: 'H1', name: 'マイティ温存', category: 'H', roles: ['nap', 'deputy_revealed'],
    turns: ['lead', 'follow_enemy_win', 'follow_ally_win'], phases: ['early', 'mid'],
    analytic: (s, ctx) => (ctx?.hand || []).some(c => c.id === '♠A') ? 1.2 : 0,
  },
  { id: 'H2', name: '正J温存', category: 'H', roles: ['nap', 'deputy_revealed'],
    turns: ['lead', 'follow_ally_win'], phases: ['early', 'mid'],
    analytic: () => 0.8,
  },
  { id: 'H3', name: '裏J温存', category: 'H', roles: ['nap', 'deputy_revealed'],
    turns: ['lead', 'follow_ally_win'], phases: ['early'],
    analytic: () => 0.7,
  },
  { id: 'H4', name: '切札A温存', category: 'H', roles: ['nap', 'deputy_revealed'],
    turns: ['lead'], phases: ['early', 'mid'],
    analytic: () => 0.8,
  },
  { id: 'H5', name: 'サイドA温存', category: 'H', roles: ['nap', 'deputy_revealed'],
    turns: ['lead'], phases: ['early', 'mid'],
    extraCheck: (s, ctx) => shouldAvoidACut(ctx, s, {}).avoid,
    analytic: (s, ctx) => shouldAvoidACut(ctx, s, {}).avoid ? 2.0 : 0.5,
  },
  { id: 'H6', name: 'セイム2温存', category: 'H', roles: ['nap', 'deputy_revealed', 'alliance'],
    turns: ['lead', 'follow_ally_win'], phases: ['early', 'mid'],
    analytic: (s, ctx) => (ctx?.hand || []).some(c => c.rank === '2') ? 0.8 : 0,
  },
  { id: 'H7', name: '点札温存', category: 'H', roles: ['nap', 'deputy_revealed', 'alliance'],
    turns: ['follow_ally_win'], phases: ['early', 'mid'],
    analytic: () => 0.5,
  },
  { id: 'H8', name: '切札温存', category: 'H', roles: ['nap', 'deputy_revealed', 'alliance'],
    turns: ['lead', 'follow_ally_win'], phases: ['early'],
    analytic: () => 0.8,
  },
  { id: 'H9', name: '中位切札温存', category: 'H', roles: ['nap', 'deputy_revealed'],
    turns: ['lead', 'follow_ally_win'], phases: ['early', 'mid'],
    analytic: () => 0.5,
  },
  { id: 'H10', name: 'よろめき温存', category: 'H', roles: ['nap', 'deputy_revealed', 'alliance'],
    turns: ['lead', 'follow_ally_win'], phases: ['early', 'mid'],
    analytic: (s, ctx) => (ctx?.hand || []).some(c => c.id === '♥Q') ? 1.0 : 0,
  },
  { id: 'H11', name: 'リード権温存', category: 'H', roles: ['nap', 'deputy_revealed', 'alliance'],
    turns: ['lead'], phases: ['mid', 'late'],
    analytic: () => 0.6,
  },
  { id: 'H12', name: '手札構成保持', category: 'H', roles: ['nap'],
    turns: ['lead', 'follow_ally_win'], phases: ['early', 'mid'],
    analytic: () => 0.4,
  },

  // ─────────────────────────────────────
  // PR: PROBE（6戦術）
  // ─────────────────────────────────────
  { id: 'PR1', name: '弱点スート探り', category: 'PR', roles: ['nap', 'deputy_revealed', 'alliance'],
    turns: ['lead'], phases: ['early', 'mid'],
    analytic: () => 0.7,
  },
  { id: 'PR2', name: '切札探り', category: 'PR', roles: ['nap', 'deputy_revealed'],
    turns: ['lead'], phases: ['early'],
    analytic: () => 0.5,
  },
  { id: 'PR3', name: 'ボイド探り', category: 'PR', roles: ['nap', 'deputy_revealed', 'alliance'],
    turns: ['lead'], phases: ['early', 'mid'],
    analytic: () => 0.6,
  },
  { id: 'PR4', name: 'セイム2探り', category: 'PR', roles: ['nap', 'deputy_revealed', 'alliance'],
    turns: ['lead'], phases: ['mid'],
    analytic: (s, ctx) => (ctx?.trickNo ?? 0) > 0 ? 0.6 : 0,
  },
  { id: 'PR5', name: '点札反応探り', category: 'PR', roles: ['nap', 'deputy_revealed', 'alliance'],
    turns: ['lead'], phases: ['mid', 'late'],
    analytic: () => 0.4,
  },
  { id: 'PR6', name: '手札構成探り', category: 'PR', roles: ['nap', 'deputy_revealed', 'alliance'],
    turns: ['lead'], phases: ['mid'],
    analytic: () => 0.4,
  },

  // ─────────────────────────────────────
  // P: 特殊（8戦術）
  // ─────────────────────────────────────
  { id: 'P1', name: '上がり宣言', category: 'P', roles: ['nap', 'deputy_revealed', 'alliance'],
    turns: ['lead'], phases: ['late', 'final'],
    extraCheck: (s, ctx) => canDeclareWinTactic(ctx),
    analytic: (s, ctx) => canDeclareWinTactic(ctx) ? 5.0 : -10.0,
  },
  { id: 'P2', name: '最終手番全体最適', category: 'P', roles: ['nap', 'deputy_revealed', 'alliance'],
    turns: ['follow_enemy_win', 'follow_ally_win', 'follow_self_win'], phases: ['final'],
    extraCheck: (s, ctx) => (ctx?.trick || []).length === 4,
    analytic: () => 1.5,
  },
  { id: 'P3', name: 'プレーオフ対応', category: 'P', roles: ['nap', 'deputy_revealed', 'deputy_hidden', 'alliance'],
    turns: ['lead', 'follow_enemy_win', 'follow_ally_win'], phases: ['early', 'mid', 'late', 'final'],
    extraCheck: (s) => s.roundCategory === 'playoff',
    analytic: (s) => s.roundCategory === 'playoff' ? 1.0 : -10.0,
  },
  { id: 'P4', name: 'オールラスト対応', category: 'P', roles: ['nap', 'deputy_revealed', 'deputy_hidden', 'alliance'],
    turns: ['lead', 'follow_enemy_win', 'follow_ally_win'], phases: ['early', 'mid', 'late', 'final'],
    extraCheck: (s) => s.roundCategory === 'all_last',
    analytic: (s) => s.roundCategory === 'all_last' ? 1.5 : -10.0,
  },
  { id: 'P5', name: 'アピール連動', category: 'P', roles: ['nap'],
    turns: ['lead', 'follow_ally_win'], phases: ['early', 'mid'],
    analytic: () => 0.5,
  },
  { id: 'P6', name: '副官判明時再計算', category: 'P', roles: ['nap', 'deputy_revealed'],
    turns: ['lead'], phases: ['early', 'mid'],
    analytic: () => 0.8,
  },
  { id: 'P7', name: '立ち直後捨て札最適', category: 'P', roles: ['nap'],
    turns: ['lead'], phases: ['early'],
    analytic: () => 0.8,
  },
  { id: 'P8', name: 'セイム2最終判断', category: 'P', roles: ['nap', 'deputy_revealed', 'alliance'],
    turns: ['lead', 'follow_enemy_win'], phases: ['final'],
    analytic: (s, ctx) => {
      const hasTwo = (ctx?.hand || []).some(c => c.rank === '2');
      if (!hasTwo) return 0;
      return 1.5 + trickPointBonus(ctx, 0.5);
    },
  },
];

// ============================================================
// 選択戦術カタログ（20戦術）★ PS4 動的化
// ============================================================
const SELECTION_CATALOG = [
  { id: 'SS1', name: '弱点スート選択', category: 'SS', roles: ['nap', 'deputy_revealed'], turns: ['lead'], phases: ['early', 'mid'], analytic: () => 0.8 },
  { id: 'SS2', name: '安全スート選択', category: 'SS', roles: ['nap', 'deputy_revealed'], turns: ['lead'], phases: ['mid', 'late'], analytic: () => 0.7 },
  { id: 'SS3', name: '切札スート選択', category: 'SS', roles: ['nap'], turns: ['lead'], phases: ['mid'], analytic: () => 0.8 },
  { id: 'SS4', name: 'A持ちスート優先', category: 'SS', roles: ['nap'], turns: ['lead'], phases: ['early', 'mid'], analytic: () => 0.8 },
  { id: 'SS5', name: 'ボイドスート回避', category: 'SS', roles: ['nap', 'deputy_revealed'], turns: ['lead'], phases: ['early', 'mid', 'late'], analytic: (s) => s.voidStatus === 'enemy_void' ? 1.0 : 0.3 },
  { id: 'SS6', name: '味方ボイド活用', category: 'SS', roles: ['nap'], turns: ['lead'], phases: ['mid', 'late'], analytic: (s) => s.voidStatus === 'ally_void' ? 1.0 : 0 },
  { id: 'SS7', name: 'ロングスート育成', category: 'SS', roles: ['nap', 'deputy_revealed'], turns: ['lead'], phases: ['early', 'mid'], analytic: () => 0.6 },

  { id: 'PS1', name: '最終手番最適化', category: 'PS', roles: ['nap', 'deputy_revealed', 'alliance'], turns: ['follow_enemy_win', 'follow_ally_win'], phases: ['early', 'mid', 'late', 'final'], extraCheck: (s, ctx) => (ctx?.trick || []).length === 4, analytic: () => 1.0 },
  { id: 'PS2', name: '2番手情報活用', category: 'PS', roles: ['nap', 'deputy_revealed', 'alliance'], turns: ['follow_enemy_win', 'follow_ally_win'], phases: ['early', 'mid', 'late'], extraCheck: (s, ctx) => (ctx?.trick || []).length === 1, analytic: () => 0.6 },
  { id: 'PS3', name: '3番手逆転判断', category: 'PS', roles: ['nap', 'deputy_revealed', 'alliance'], turns: ['follow_enemy_win'], phases: ['mid', 'late'], extraCheck: (s, ctx) => (ctx?.trick || []).length === 2, analytic: () => 0.7 },
  // ★ PS4: 4番手オーバーキル回避 動的化
  { id: 'PS4', name: '4番手オーバーキル回避', category: 'PS', roles: ['nap', 'deputy_revealed', 'alliance'],
    turns: ['follow_ally_win'], phases: ['early', 'mid', 'late'],
    extraCheck: (s, ctx) => (ctx?.trick || []).length === 3,
    analytic: (s, ctx) => {
      const base = 1.2;
      const trick = ctx?.trick || [];
      const pts = trick.filter(t => t.card && FACE.includes(t.card.rank)).length;
      if (pts === 0) return base + 0.8;
      if (pts >= 3) return base - 0.2;
      return base + 0.3;
    },
  },
  { id: 'PS5', name: '最終手番ダック', category: 'PS', roles: ['nap', 'deputy_revealed', 'alliance'], turns: ['follow_ally_win'], phases: ['mid', 'late', 'final'], extraCheck: (s, ctx) => (ctx?.trick || []).length === 4, analytic: () => 1.5 },
];

// ===== [tactics.js 前半 終了。後半へ続く] =====

// ===== [tactics.js 後半 開始] =====

// ============================================================
// 複合戦術カタログ（12戦術）
// ============================================================
const COMPOSITE_CATALOG = [
  { id: 'M1', name: 'スクイーズ', category: 'M', roles: ['nap', 'deputy_revealed'], turns: ['lead'], phases: ['late', 'final'], analytic: (s) => s.phase === 'late' ? 1.2 : 0.3 },
  { id: 'M2', name: 'エンドプレイ', category: 'M', roles: ['nap', 'deputy_revealed'], turns: ['lead'], phases: ['final'], analytic: () => 1.5 },
  { id: 'M3', name: 'クロスラフ', category: 'M', roles: ['nap', 'deputy_revealed'], turns: ['lead'], phases: ['mid', 'late'], analytic: () => 0.8 },
  { id: 'M4', name: 'フォーシング', category: 'M', roles: ['nap', 'deputy_revealed'], turns: ['lead'], phases: ['mid'], analytic: () => 0.7 },
  { id: 'M5', name: 'カウントアウト', category: 'M', roles: ['nap', 'deputy_revealed'], turns: ['lead'], phases: ['late', 'final'], analytic: () => 1.0 },
  { id: 'M6', name: 'トランププル', category: 'M', roles: ['nap', 'deputy_revealed'], turns: ['lead'], phases: ['mid'], analytic: () => 0.9 },
  { id: 'M7', name: 'ロングスート育成', category: 'M', roles: ['nap', 'deputy_revealed'], turns: ['lead'], phases: ['early', 'mid'], analytic: () => 0.6 },
  { id: 'M8', name: 'アンブロック', category: 'M', roles: ['nap', 'deputy_revealed', 'alliance'], turns: ['lead', 'follow_ally_win'], phases: ['mid', 'late'], analytic: () => 0.5 },
  { id: 'M9', name: 'クロスフィネス', category: 'M', roles: ['nap'], turns: ['lead'], phases: ['mid'], analytic: () => 0.5 },
  { id: 'M10', name: 'デュアルスクイーズ', category: 'M', roles: ['nap', 'deputy_revealed'], turns: ['lead'], phases: ['final'], analytic: () => 1.0 },
  { id: 'M11', name: 'リード誘導', category: 'M', roles: ['nap', 'deputy_revealed', 'alliance'], turns: ['lead'], phases: ['mid', 'late'], analytic: () => 0.5 },
  { id: 'M12', name: 'パスアンドバック', category: 'M', roles: ['nap', 'deputy_revealed'], turns: ['lead'], phases: ['mid'], analytic: () => 0.5 },
];

// ============================================================
// メタ戦術カタログ（29戦術）
// ============================================================
const META_CATALOG = [
  // BS: 宣言枚数別
  { id: 'BS1', name: '低宣言確実取り', category: 'BS', roles: ['nap', 'deputy_revealed', 'alliance'], turns: ['lead', 'follow_enemy_win', 'follow_ally_win'], phases: ['early', 'mid', 'late', 'final'], extraCheck: (s, ctx) => (ctx?.contract?.num ?? 0) <= 14, analytic: (s, ctx) => (ctx?.contract?.num ?? 0) <= 14 ? 1.0 : 0 },
  { id: 'BS2', name: '中宣言バランス', category: 'BS', roles: ['nap', 'deputy_revealed', 'alliance'], turns: ['lead', 'follow_enemy_win', 'follow_ally_win'], phases: ['early', 'mid', 'late', 'final'], extraCheck: (s, ctx) => { const n = ctx?.contract?.num ?? 0; return n >= 15 && n <= 16; }, analytic: () => 0.5 },
  { id: 'BS3', name: '高宣言攻め', category: 'BS', roles: ['nap', 'deputy_revealed'], turns: ['lead', 'follow_enemy_win', 'follow_ally_win'], phases: ['early', 'mid', 'late', 'final'], extraCheck: (s, ctx) => { const n = ctx?.contract?.num ?? 0; return n >= 17 && n <= 18; }, analytic: () => 0.8 },
  { id: 'BS4', name: '最高宣言全力', category: 'BS', roles: ['nap', 'deputy_revealed'], turns: ['lead', 'follow_enemy_win', 'follow_ally_win'], phases: ['early', 'mid', 'late', 'final'], extraCheck: (s, ctx) => (ctx?.contract?.num ?? 0) >= 19, analytic: () => 1.5 },
  { id: 'BS5', name: '宣言ちょうど狙い', category: 'BS', roles: ['nap', 'deputy_revealed'], turns: ['lead', 'follow_ally_win'], phases: ['mid', 'late', 'final'], analytic: () => 0.6 },

  // SC: 得点差別
  { id: 'SC1', name: 'ビハインド攻勢', category: 'SC', roles: ['nap', 'deputy_revealed', 'deputy_hidden', 'alliance'], turns: ['lead', 'follow_enemy_win', 'follow_ally_win'], phases: ['early', 'mid', 'late', 'final'], extraCheck: (s) => s.scoreState === 'massive_behind' || s.scoreState === 'behind', analytic: (s) => s.scoreState === 'massive_behind' ? 1.5 : (s.scoreState === 'behind' ? 0.8 : 0) },
  { id: 'SC2', name: 'リード安全策', category: 'SC', roles: ['nap', 'deputy_revealed', 'deputy_hidden', 'alliance'], turns: ['lead', 'follow_enemy_win', 'follow_ally_win'], phases: ['early', 'mid', 'late', 'final'], extraCheck: (s) => s.scoreState === 'massive_ahead' || s.scoreState === 'ahead', analytic: (s) => s.scoreState === 'massive_ahead' ? 1.2 : (s.scoreState === 'ahead' ? 0.6 : 0) },
  { id: 'SC3', name: '大量リード流し', category: 'SC', roles: ['nap', 'deputy_revealed', 'deputy_hidden', 'alliance'], turns: ['lead', 'follow_ally_win'], phases: ['mid', 'late'], extraCheck: (s) => s.scoreState === 'massive_ahead', analytic: (s) => s.scoreState === 'massive_ahead' ? 1.0 : 0 },
  { id: 'SC4', name: '僅差最適化', category: 'SC', roles: ['nap', 'deputy_revealed', 'deputy_hidden', 'alliance'], turns: ['lead', 'follow_enemy_win', 'follow_ally_win'], phases: ['late', 'final'], extraCheck: (s) => s.scoreState === 'even', analytic: (s) => s.scoreState === 'even' ? 1.2 : 0 },
  { id: 'SC5', name: '終盤得点計算', category: 'SC', roles: ['nap', 'deputy_revealed'], turns: ['lead'], phases: ['final'], analytic: () => 1.0 },

  // MM: マッチ全体
  { id: 'MM1', name: '順位逆算', category: 'MM', roles: ['nap', 'deputy_revealed', 'deputy_hidden', 'alliance'], turns: ['lead'], phases: ['early', 'mid', 'late', 'final'], analytic: () => 0.5 },
  { id: 'MM2', name: '局目標設定', category: 'MM', roles: ['nap', 'deputy_revealed'], turns: ['lead'], phases: ['early'], analytic: () => 0.5 },
  { id: 'MM3', name: 'ラス前戦略', category: 'MM', roles: ['nap', 'deputy_revealed', 'deputy_hidden', 'alliance'], turns: ['lead', 'follow_enemy_win', 'follow_ally_win'], phases: ['early', 'mid', 'late', 'final'], extraCheck: (s) => s.roundCategory === 'last_prev', analytic: (s) => s.roundCategory === 'last_prev' ? 1.0 : -10.0 },
  { id: 'MM4', name: 'オールラスト戦略', category: 'MM', roles: ['nap', 'deputy_revealed', 'deputy_hidden', 'alliance'], turns: ['lead', 'follow_enemy_win', 'follow_ally_win'], phases: ['early', 'mid', 'late', 'final'], extraCheck: (s) => s.roundCategory === 'all_last', analytic: (s) => s.roundCategory === 'all_last' ? 1.5 : -10.0 },
  { id: 'MM5', name: 'プレーオフ戦略', category: 'MM', roles: ['nap', 'deputy_revealed', 'deputy_hidden', 'alliance'], turns: ['lead', 'follow_enemy_win', 'follow_ally_win'], phases: ['early', 'mid', 'late', 'final'], extraCheck: (s) => s.roundCategory === 'playoff', analytic: (s) => s.roundCategory === 'playoff' ? 1.2 : -10.0 },

  // EV: 情報公開イベント
  { id: 'EV1', name: '副官判明再計算', category: 'EV', roles: ['nap', 'deputy_revealed'], turns: ['lead'], phases: ['early', 'mid'], analytic: () => 0.5 },
  { id: 'EV2', name: '捨て札公開活用', category: 'EV', roles: ['nap', 'deputy_revealed', 'deputy_hidden', 'alliance'], turns: ['lead', 'follow_enemy_win', 'follow_ally_win'], phases: ['early', 'mid'], analytic: () => 0.5 },
  { id: 'EV3', name: '上がり宣言対応', category: 'EV', roles: ['nap', 'deputy_revealed', 'deputy_hidden', 'alliance'], turns: ['lead', 'follow_enemy_win', 'follow_ally_win'], phases: ['final'], analytic: () => 0.8 },
  { id: 'EV4', name: 'プレーオフ突入準備', category: 'EV', roles: ['nap', 'deputy_revealed', 'deputy_hidden', 'alliance'], turns: ['lead'], phases: ['final'], analytic: () => 0.5 },

  // RC: リード制約
  { id: 'RC1', name: '初手最適リード', category: 'RC', roles: ['nap', 'deputy_revealed', 'deputy_hidden', 'alliance'], turns: ['lead'], phases: ['early'], extraCheck: (s, ctx) => (ctx?.trickNo ?? 0) === 0, analytic: () => 1.0 },
  { id: 'RC2', name: '2リード禁止対応', category: 'RC', roles: ['nap', 'deputy_revealed', 'deputy_hidden', 'alliance'], turns: ['lead'], phases: ['early'], extraCheck: (s, ctx) => (ctx?.trickNo ?? 0) === 0, analytic: () => 0.8 },
  { id: 'RC3', name: 'マストフォロー最適', category: 'RC', roles: ['nap', 'deputy_revealed', 'deputy_hidden', 'alliance'], turns: ['follow_enemy_win', 'follow_ally_win', 'follow_self_win'], phases: ['early', 'mid', 'late', 'final'], analytic: () => 0.3 },

  // TS: タイミング切替
  { id: 'TS1', name: '温存→攻撃切替', category: 'TS', roles: ['nap', 'deputy_revealed', 'deputy_hidden', 'alliance'], turns: ['lead'], phases: ['late', 'final'], analytic: () => 0.8 },
  { id: 'TS2', name: '攻撃→温存切替', category: 'TS', roles: ['nap', 'deputy_revealed'], turns: ['lead'], phases: ['mid', 'late'], extraCheck: (s) => s.scoreState === 'massive_ahead', analytic: (s) => s.scoreState === 'massive_ahead' ? 0.8 : 0 },
  { id: 'TS3', name: '勝負どころ見極め', category: 'TS', roles: ['nap', 'deputy_revealed', 'alliance'], turns: ['lead', 'follow_enemy_win'], phases: ['late'], analytic: () => 0.6 },

  // AI: 味方意図読み
  { id: 'AI1', name: '味方意図読み', category: 'AI', roles: ['nap', 'deputy_revealed', 'alliance'], turns: ['follow_ally_win'], phases: ['mid', 'late'], analytic: () => 0.5 },
  { id: 'AI2', name: '味方弱点補完', category: 'AI', roles: ['nap', 'deputy_revealed'], turns: ['lead', 'follow_enemy_win'], phases: ['mid', 'late'], analytic: () => 0.6 },
  { id: 'AI3', name: '味方役割分担', category: 'AI', roles: ['nap'], turns: ['lead'], phases: ['mid'], analytic: () => 0.5 },
];

// ============================================================
// 内部: カタログビルダー
// ============================================================
function buildCatalog() {
  return [
    ...PRIMITIVE_CATALOG,
    ...SELECTION_CATALOG,
    ...COMPOSITE_CATALOG,
    ...META_CATALOG,
    UNIVERSAL_FALLBACK,
  ];
}

// ============================================================
// 内部: 上がり宣言判定（軽量版）
// ============================================================
function canDeclareWinTactic(ctx) {
  const hand = ctx?.hand || [];
  if (!hand.length) return false;
  if ((ctx?.trick || []).length > 0) return false;
  const allUnseen = hand.every(c => {
    const power = simpleCardPower(c, ctx?.contract);
    return power >= 5000;
  });
  return allUnseen && hand.length <= 3;
}

function simpleCardPower(card, contract) {
  if (!card) return 0;
  const isNT = contract?.suit === 'NT';
  const trump = isNT ? null : contract?.suit;
  if (card.id === '♠A') return 9000;
  if (card.id === '♥Q') return 8500;
  if (!isNT && card.rank === 'J' && card.suit === trump) return 8000;
  if (!isNT && card.rank === 'J' && card.suit === sameColorSuitOf(trump)) return 7000;
  if (!isNT && card.suit === trump) return 5000 + RANKS.indexOf(card.rank);
  return 3000 + RANKS.indexOf(card.rank);
}

// ============================================================
// 公開: カタログ統計
// ============================================================
export function getCatalogStats() {
  const stats = {};
  for (const t of TACTIC_CATALOG) {
    if (t.id === 'UNIVERSAL') continue;
    stats[t.category] = (stats[t.category] || 0) + 1;
  }
  return {
    total: TACTIC_CATALOG.length - 1,
    byCategory: stats,
  };
}

// ============================================================
// 公開: カバレッジテスト用の完全リスト
// ============================================================
export function getFullCatalogForStats() {
  const staticIds = new Set();
  for (const t of TACTIC_CATALOG) {
    if (t.id === 'UNIVERSAL') continue;
    staticIds.add(t.id);
  }
  const dynamicIds = new Set([
    'Q1-0', 'Q1-1', 'Q1-2', 'Q1-3', 'Q1-4', 'Q1-5',
    'Q2-1', 'Q2-2', 'Q2-3',
    'Q3-1', 'Q3-2', 'Q3-3', 'Q3-4', 'Q3-5', 'Q3-6', 'Q3-7',
    'Q4-1',
    'E1-1', 'E1-2', 'E1-3', 'E1-4', 'E1-5', 'E1-6',
    'E2-1', 'E2-2', 'E2-3', 'E2-4',
    'E3-1', 'E3-2', 'E3-3',
    'E4-1', 'E4-2', 'E4-3',
    'E5-1', 'E5-2', 'E5-3',
    'E6-1', 'E6-2',
    'E7-1', 'E7-2',
    'E8-1',
  ]);
  return {
    staticIds: [...staticIds],
    dynamicIds: [...dynamicIds],
    staticCount: staticIds.size,
    dynamicCount: dynamicIds.size,
    totalCount: staticIds.size + dynamicIds.size,
  };
}

// ============================================================
// 公開: デバッグ用
// ============================================================
export function debugSelectTactic(ctx, params, experience) {
  const result = selectTactic(ctx, params, experience);
  const allScores = scoreAllTactics(ctx, params, experience);
  return {
    selected: { id: result.tactic.id, name: result.tactic.name, prior: result.prior },
    situation: result.situation,
    situationHash: result.situationHash,
    top10: allScores.slice(0, 10),
    candidateCount: result.candidates.length,
    fallbackUsed: result.tactic.id === 'UNIVERSAL',
    disabled: result.disabled === true,
  };
}
// ===== [tactics.js 完成] =====
