// combinations.js — カード組み合わせ構造のMECEカタログ
// 新規ファイル: 手札の組み合わせ構造（11クラス×22構造×8機能×24実行戦術）を検出・評価
// 純関数のみ。副作用なし。乱数なし（決定論保証）。

import { SUITS, RANKS, FACE, sameColorSuitOf } from './constants.js';

// ============================================================
// 公開: カード役割の11クラス分類（素材の基礎）
// ============================================================
export function classifyCardRole(card, contract) {
  if (!card) return 'discard';
  const suit = card.suit;
  const rank = card.rank;
  const isNT = contract?.suit === 'NT';
  const trump = isNT ? null : contract?.suit;

  if (card.id === '♠A') return 'mighty';
  if (card.id === '♥Q') return 'shadow'; // よろめき
  if (!isNT && rank === 'J' && suit === trump) return 'trumpJ';
  if (!isNT && rank === 'J' && suit === sameColorSuitOf(trump)) return 'sameColorJ';
  if (rank === '2') return 'two'; // セイム2候補
  if (!isNT && suit === trump && rank === 'A') return 'trumpA';
  if (!isNT && suit === trump && rank === 'K') return 'trumpK';
  if (rank === 'A') return 'sideA';
  if (rank === 'K') return 'sideK';
  if (FACE.includes(rank)) return 'point';
  return 'discard';
}

// ============================================================
// 公開: 手札全体の役割集計
// ============================================================
export function aggregateCardRoles(hand, contract) {
  const counts = {
    mighty: 0, shadow: 0, trumpJ: 0, sameColorJ: 0, two: 0,
    trumpA: 0, trumpK: 0, sideA: 0, sideK: 0, point: 0, discard: 0,
  };
  const cards = { mighty: [], shadow: [], trumpJ: [], sameColorJ: [], two: [],
    trumpA: [], trumpK: [], sideA: [], sideK: [], point: [], discard: [] };
  for (const c of (hand || [])) {
    const role = classifyCardRole(c, contract);
    counts[role]++;
    cards[role].push(c);
  }
  return { counts, cards };
}

// ============================================================
// 公開: 手札の組み合わせ構造検出（22構造 × 6グループ）
// ============================================================
export function detectCombinations(hand, contract) {
  if (!Array.isArray(hand) || hand.length === 0) return [];
  const isNT = contract?.suit === 'NT';
  const trump = isNT ? null : contract?.suit;
  const result = [];

  // ─────────────────────────────────────
  // グループ1: 同スート連続（ST1-ST5）
  // ─────────────────────────────────────
  for (const suit of SUITS) {
    const suitCards = hand.filter(c => c.suit === suit).sort((a, b) => RANKS.indexOf(b.rank) - RANKS.indexOf(a.rank));
    if (suitCards.length < 2) continue;

    const ranks = suitCards.map(c => c.rank);
    if (ranks.includes('A') && ranks.includes('K')) {
      if (ranks.includes('Q') && ranks.includes('J') && ranks.includes('10')) {
        result.push({ id: 'ST5', suit, cards: suitCards.filter(c => ['A','K','Q','J','10'].includes(c.rank)), guaranteed: 5, group: 'ST' });
      } else if (ranks.includes('Q') && ranks.includes('J')) {
        result.push({ id: 'ST4', suit, cards: suitCards.filter(c => ['A','K','Q','J'].includes(c.rank)), guaranteed: 4, group: 'ST' });
      } else if (ranks.includes('Q')) {
        result.push({ id: 'ST3', suit, cards: suitCards.filter(c => ['A','K','Q'].includes(c.rank)), guaranteed: 3, group: 'ST' });
      } else {
        result.push({ id: 'ST1', suit, cards: suitCards.filter(c => ['A','K'].includes(c.rank)), guaranteed: 2, group: 'ST' });
      }
    } else if (ranks.includes('K') && ranks.includes('Q')) {
      result.push({ id: 'ST2', suit, cards: suitCards.filter(c => ['K','Q'].includes(c.rank)), guaranteed: 1.5, group: 'ST' });
    }
  }

  // ─────────────────────────────────────
  // グループ2: 同スート非連続（SN1-SN3）
  // ─────────────────────────────────────
  for (const suit of SUITS) {
    const suitCards = hand.filter(c => c.suit === suit);
    const ranks = suitCards.map(c => c.rank);
    if (ranks.includes('A') && ranks.includes('Q') && !ranks.includes('K')) {
      result.push({ id: 'SN1', suit, cards: suitCards.filter(c => ['A','Q'].includes(c.rank)), guaranteed: 0, group: 'SN', function: 'finesse' });
    }
    if (ranks.includes('A') && ranks.includes('J') && !ranks.includes('K') && !ranks.includes('Q')) {
      result.push({ id: 'SN2', suit, cards: suitCards.filter(c => ['A','J'].includes(c.rank)), guaranteed: 0, group: 'SN', function: 'finesse' });
    }
    if (ranks.includes('K') && ranks.includes('J') && !ranks.includes('A') && !ranks.includes('Q')) {
      result.push({ id: 'SN3', suit, cards: suitCards.filter(c => ['K','J'].includes(c.rank)), guaranteed: 0, group: 'SN', function: 'finesse' });
    }
  }

  // ─────────────────────────────────────
  // グループ3: 異スート同ランク（SR1-SR3）
  // ─────────────────────────────────────
  for (const rank of ['A', 'K', 'Q']) {
    const rankCards = hand.filter(c => c.rank === rank && c.suit !== trump && c.id !== '♠A');
    if (rankCards.length >= 2) {
      result.push({ id: 'SR' + ({ A: 1, K: 2, Q: 3 }[rank]), rank, cards: rankCards, guaranteed: rankCards.length, group: 'SR' });
    }
  }

  // ─────────────────────────────────────
  // グループ4: 特殊異スート（SX1-SX5）
  // ─────────────────────────────────────
  const hasMighty = hand.some(c => c.id === '♠A');
  const hasShadow = hand.some(c => c.id === '♥Q');
  if (hasMighty && hasShadow) {
    result.push({ id: 'SX1', cards: hand.filter(c => c.id === '♠A' || c.id === '♥Q'), group: 'SX', function: 'shadow_hunt_setup' });
  }
  if (!isNT) {
    const trumpJ = hand.find(c => c.rank === 'J' && c.suit === trump);
    const sameColorJ = hand.find(c => c.rank === 'J' && c.suit === sameColorSuitOf(trump));
    if (hasMighty && trumpJ) {
      result.push({ id: 'SX2', cards: [hand.find(c => c.id === '♠A'), trumpJ], group: 'SX', function: 'two_strong_hold' });
    }
    if (trumpJ && sameColorJ) {
      result.push({ id: 'SX3', cards: [trumpJ, sameColorJ], group: 'SX', function: 'trump_two_stage' });
    }
    const trumpA = hand.find(c => c.rank === 'A' && c.suit === trump);
    if (trumpJ && trumpA) {
      result.push({ id: 'SX4', cards: [trumpJ, trumpA], group: 'SX', function: 'trump_two_stage_low' });
    }
    if (hasMighty && trumpJ && sameColorJ) {
      result.push({ id: 'SX5', cards: [hand.find(c => c.id === '♠A'), trumpJ, sameColorJ], group: 'SX', function: 'three_role' });
    }
  }

  // ─────────────────────────────────────
  // グループ5: 機能組み合わせ（SF1-SF4）
  // ─────────────────────────────────────
  for (const suit of SUITS) {
    const suitCards = hand.filter(c => c.suit === suit);
    const ranks = suitCards.map(c => c.rank);
    if (ranks.includes('A') && ranks.includes('2')) {
      result.push({ id: 'SF1', suit, cards: suitCards.filter(c => ['A','2'].includes(c.rank)), group: 'SF', function: 'same_two_guard' });
    }
    if (ranks.includes('A') && ranks.includes('2') && ranks.includes('K')) {
      result.push({ id: 'SF2', suit, cards: suitCards.filter(c => ['A','2','K'].includes(c.rank)), group: 'SF', function: 'same_two_guard_plus' });
    }
    if (suitCards.length >= 4 && ranks.includes('A')) {
      result.push({ id: 'SF4', suit, cards: suitCards.filter(c => ['A','K','Q','J','10','9','8','7','6','5','4','3','2'].includes(c.rank)).slice(0, 4), group: 'SF', function: 'long_suit_growth' });
    }
  }
  // SF3: クロスラフ体制（切札複数 + 異スートボイド）
  if (!isNT) {
    const trumps = hand.filter(c => c.suit === trump);
    if (trumps.length >= 3) {
      const shortSuits = SUITS.filter(s => s !== trump && hand.filter(c => c.suit === s).length <= 1);
      if (shortSuits.length >= 1) {
        result.push({ id: 'SF3', cards: trumps, shortSuits, group: 'SF', function: 'cross_ruff_setup' });
      }
    }
  }

  // ─────────────────────────────────────
  // グループ6: 点札組み合わせ（SP1-SP2）
  // ─────────────────────────────────────
  for (const suit of SUITS) {
    const pointCards = hand.filter(c => c.suit === suit && FACE.includes(c.rank));
    if (pointCards.length >= 3) {
      result.push({ id: 'SP1', suit, cards: pointCards, group: 'SP', function: 'point_concentration' });
    }
  }
  const totalPointCards = hand.filter(c => FACE.includes(c.rank));
  if (totalPointCards.length >= 2 && new Set(totalPointCards.map(c => c.suit)).size >= 2) {
    result.push({ id: 'SP2', cards: totalPointCards, group: 'SP', function: 'point_dispersion' });
  }

  return result;
}

// ============================================================
// 公開: 構造から機能の導出（8機能）
// ============================================================
export function deriveFunctions(combinations) {
  const functions = {
    FN1_guaranteed_tricks: { value: 0, sources: [] },   // 確定Nトリック
    FN2_probability_boost: { value: 0, sources: [] },   // 確率向上
    FN3_shadow_hunt: { value: 0, sources: [] },         // 影狩り体制
    FN4_trump_two_stage: { value: 0, sources: [] },     // 切札二段構え
    FN5_same_two_guard: { value: 0, sources: [] },      // セイム2ガード
    FN6_cross_ruff: { value: 0, sources: [] },          // クロスラフ体制
    FN7_suit_dominance: { value: 0, sources: [] },      // スート支配
    FN8_point_concentration: { value: 0, sources: [] }, // 点札集中
  };

  for (const combo of (combinations || [])) {
    if (combo.group === 'ST' || combo.id === 'SR1') {
      functions.FN1_guaranteed_tricks.value += combo.guaranteed || 0;
      functions.FN1_guaranteed_tricks.sources.push(combo.id);
    }
    if (combo.group === 'SN') {
      functions.FN2_probability_boost.value += 0.5;
      functions.FN2_probability_boost.sources.push(combo.id);
    }
    if (combo.id === 'SX1') {
      functions.FN3_shadow_hunt.value += 1.0;
      functions.FN3_shadow_hunt.sources.push(combo.id);
    }
    if (combo.id === 'SX3' || combo.id === 'SX4') {
      functions.FN4_trump_two_stage.value += 0.8;
      functions.FN4_trump_two_stage.sources.push(combo.id);
    }
    if (combo.id === 'SF1' || combo.id === 'SF2') {
      functions.FN5_same_two_guard.value += 0.7;
      functions.FN5_same_two_guard.sources.push(combo.id);
    }
    if (combo.id === 'SF3') {
      functions.FN6_cross_ruff.value += 0.8;
      functions.FN6_cross_ruff.sources.push(combo.id);
    }
    if (combo.id === 'SR1' || combo.id === 'SR2' || combo.id === 'SF2') {
      functions.FN7_suit_dominance.value += 0.6;
      functions.FN7_suit_dominance.sources.push(combo.id);
    }
    if (combo.id === 'SP1' || combo.id === 'SP2') {
      functions.FN8_point_concentration.value += 0.5;
      functions.FN8_point_concentration.sources.push(combo.id);
    }
  }
  return functions;
}

// ============================================================
// 公開: 実行戦術の候補生成（24戦術）
// ============================================================
export function generateCombinationTactics(ctx, combinations, functions) {
  const tactics = [];
  const trickNo = ctx?.trickNo ?? 0;
  const phase = trickNo <= 2 ? 'early' : trickNo <= 5 ? 'mid' : trickNo <= 8 ? 'late' : 'final';
  const trickValue = (ctx?.trick || []).filter(t => t.card && FACE.includes(t.card.rank)).length;

  // ─────────────────────────────────────
  // FN1: 確定Nトリック系（6戦術）
  // ─────────────────────────────────────
  if (functions.FN1_guaranteed_tricks.value > 0) {
    const hasST2 = combinations.some(c => c.id === 'ST2');
    const hasST1 = combinations.some(c => c.id === 'ST1');
    const hasLongRun = combinations.some(c => c.id === 'ST4' || c.id === 'ST5');
    const hasDoubleA = combinations.some(c => c.id === 'SR1');

    if (hasST1 && trickValue > 0 && phase === 'early') {
      tactics.push({ id: 'E1-1', name: '連続即切り', score: 2.5, source: 'ST1' });
    }
    if (hasLongRun && phase !== 'final') {
      tactics.push({ id: 'E1-2', name: '連続温存', score: 2.8, source: 'ST4/ST5' });
    }
    if (hasST1 && !hasST2) {
      tactics.push({ id: 'E1-3', name: 'A-K分割使用', score: 1.8, source: 'ST1' });
    }
    if (hasST2 && !hasST1) {
      tactics.push({ id: 'E1-4', name: 'K-Q温存', score: 1.5, source: 'ST2' });
    }
    if (hasDoubleA && phase !== 'final') {
      tactics.push({ id: 'E1-5', name: 'ダブルA連続', score: 2.2, source: 'SR1' });
    }
    if (hasLongRun && phase === 'final') {
      tactics.push({ id: 'E1-6', name: '長連続総出し', score: 3.0, source: 'ST4/ST5' });
    }
  }

  // ─────────────────────────────────────
  // FN2: 確率向上系（4戦術）
  // ─────────────────────────────────────
  if (functions.FN2_probability_boost.value > 0) {
    const hasFinesse = combinations.some(c => c.group === 'SN');
    if (hasFinesse) {
      tactics.push({ id: 'E2-1', name: 'フィネス実行', score: 1.8, source: 'SN' });
      tactics.push({ id: 'E2-2', name: 'フィネス回避', score: 1.2, source: 'SN' });
    }
    tactics.push({ id: 'E2-3', name: 'セーフティプレイ', score: 1.5, source: 'FN2' });
    if (combinations.filter(c => c.group === 'SN').length >= 2) {
      tactics.push({ id: 'E2-4', name: 'クロスフィネス', score: 2.0, source: 'SN×2' });
    }
  }

  // ─────────────────────────────────────
  // FN3: 影狩り体制系（3戦術）
  // ─────────────────────────────────────
  if (functions.FN3_shadow_hunt.value > 0) {
    const enemyMightyPlayed = (ctx?.playedCards || []).some(c => c.id === '♠A');
    const enemyMightyInTrick = (ctx?.trick || []).some(t => t.card?.id === '♠A');
    if (enemyMightyInTrick) {
      tactics.push({ id: 'E3-2', name: '影狩り発動', score: 3.5, source: 'SX1+trick' });
    } else if (enemyMightyPlayed) {
      tactics.push({ id: 'E3-3', name: 'よろめき温存', score: 1.0, source: 'SX1' });
    } else {
      tactics.push({ id: 'E3-1', name: '影狩り待機', score: 2.0, source: 'SX1' });
    }
  }

  // ─────────────────────────────────────
  // FN4: 切札二段構え系（3戦術）
  // ─────────────────────────────────────
  if (functions.FN4_trump_two_stage.value > 0) {
    tactics.push({ id: 'E4-1', name: '正J先行', score: 2.0, source: 'SX3' });
    tactics.push({ id: 'E4-2', name: '裏J先行', score: 1.8, source: 'SX3' });
    if (phase !== 'final') {
      tactics.push({ id: 'E4-3', name: '二段温存', score: 2.2, source: 'SX3/SX4' });
    }
  }

  // ─────────────────────────────────────
  // FN5: セイム2ガード系（3戦術）
  // ─────────────────────────────────────
  if (functions.FN5_same_two_guard.value > 0) {
    const enemyTwosRemain = countRemainingTwos(ctx);
    if (enemyTwosRemain > 0) {
      tactics.push({ id: 'E5-1', name: 'A温存ガード', score: 2.2, source: 'SF1' });
    } else {
      tactics.push({ id: 'E5-2', name: 'A先行切り', score: 2.0, source: 'SF1' });
    }
    tactics.push({ id: 'E5-3', name: '2先行処理', score: 1.5, source: 'SF1' });
  }

  // ─────────────────────────────────────
  // FN6: クロスラフ体制系（2戦術）
  // ─────────────────────────────────────
  if (functions.FN6_cross_ruff.value > 0) {
    if (phase === 'early' || phase === 'mid') {
      tactics.push({ id: 'E6-1', name: 'クロスラフ準備', score: 2.0, source: 'SF3' });
    }
    if (phase === 'mid' || phase === 'late') {
      tactics.push({ id: 'E6-2', name: 'クロスラフ発動', score: 2.5, source: 'SF3' });
    }
  }

  // ─────────────────────────────────────
  // FN7: スート支配系（2戦術）
  // ─────────────────────────────────────
  if (functions.FN7_suit_dominance.value > 0) {
    tactics.push({ id: 'E7-1', name: '支配スート攻め', score: 2.0, source: 'SR1/SR2' });
    if (phase !== 'final') {
      tactics.push({ id: 'E7-2', name: '支配スート温存', score: 1.8, source: 'SR1/SR2' });
    }
  }

  // ─────────────────────────────────────
  // FN8: 点札集中系（1戦術）
  // ─────────────────────────────────────
  if (functions.FN8_point_concentration.value > 0) {
    tactics.push({ id: 'E8-1', name: '点札集中回収', score: 2.0, source: 'SP1/SP2' });
  }

  return tactics;
}

// ============================================================
// 内部ヘルパー
// ============================================================
function countRemainingTwos(ctx) {
  const played = ctx?.playedCards || [];
  const discarded = ctx?.discardedKitty || [];
  const hand = ctx?.hand || [];
  const consumed = new Set([
    ...played.filter(c => c.rank === '2').map(c => c.id),
    ...discarded.filter(c => c.rank === '2').map(c => c.id),
    ...hand.filter(c => c.rank === '2').map(c => c.id),
  ]);
  return Math.max(0, 4 - consumed.size);
}

// ============================================================
// 公開: 統合エントリ（構造検出 + 機能導出 + 戦術生成）
// ============================================================
export function analyzeCombinations(ctx) {
  const hand = ctx?.hand || [];
  const contract = ctx?.contract;
  const combinations = detectCombinations(hand, contract);
  const functions = deriveFunctions(combinations);
  const tactics = generateCombinationTactics(ctx, combinations, functions);
  return { combinations, functions, tactics };
}

// ============================================================
// 公開: デバッグ用情報
// ============================================================
export function debugCombinations(ctx) {
  const analysis = analyzeCombinations(ctx);
  const roles = aggregateCardRoles(ctx?.hand || [], ctx?.contract);
  return {
    ...analysis,
    roles,
    structureCount: analysis.combinations.length,
    tacticCount: analysis.tactics.length,
    functionValues: Object.fromEntries(
      Object.entries(analysis.functions).map(([k, v]) => [k, v.value])
    ),
  };
}

// ============================================================
// 公開: 構造・機能・戦術のラベル辞書
// ============================================================
export const STRUCTURE_LABELS = {
  ST1: 'A-K連続', ST2: 'K-Q連続', ST3: 'A-K-Q連続', ST4: 'A-K-Q-J連続', ST5: 'A-K-Q-J-10連続',
  SN1: 'A-Q非連続', SN2: 'A-J非連続', SN3: 'K-J非連続',
  SR1: 'ダブルA', SR2: 'ダブルK', SR3: 'ダブルQ',
  SX1: 'マイティ+よろめき', SX2: 'マイティ+正J', SX3: '正J+裏J', SX4: '正J+切札A', SX5: '3役',
  SF1: 'A+2（セイム2ガード）', SF2: 'A+2+K', SF3: 'クロスラフ体制', SF4: 'ロングスート育成',
  SP1: '点札集中（同スート3+）', SP2: '点札分散（複数スート）',
};

export const FUNCTION_LABELS = {
  FN1_guaranteed_tricks: '確定Nトリック',
  FN2_probability_boost: '確率向上',
  FN3_shadow_hunt: '影狩り体制',
  FN4_trump_two_stage: '切札二段構え',
  FN5_same_two_guard: 'セイム2ガード',
  FN6_cross_ruff: 'クロスラフ体制',
  FN7_suit_dominance: 'スート支配',
  FN8_point_concentration: '点札集中',
};
