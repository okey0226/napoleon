// same-two.js — セイム2評価層（4象限 × 15戦術 + A切りリスク）
// 新規ファイル: セイム2の攻撃/防御をMECEに評価する
// 純関数のみ。副作用なし。乱数なし（決定論保証）。

import { SUITS, RANKS, FACE } from './constants.js';

// ============================================================
// 公開: セイム2 4象限評価
// ============================================================
export function evaluateSameTwo(ctx, situation, params) {
  const p = params || {};
  const sit = situation || {};

  const attack = evaluateSameTwoAttack(ctx, sit, p);
  const threat = evaluateSameTwoThreat(ctx, sit, p);
  const aCutRisk = evaluateACutRisk(ctx, sit, p);
  const residual = evaluateSameTwoResidual(ctx, sit, p);

  return {
    quadrant: sit.selfHasSameTwo && sit.selfHasSameTwo !== 'none' ? 'Q1_self'
            : sit.enemySameTwoEstimate === 'unknown' ? 'Q4_unknown'
            : sit.enemySameTwoEstimate !== 'none' ? 'Q3_enemy'
            : 'Q4_none',
    attack, threat, aCutRisk, residual,
    // 総合スコア
    attackScore: attack.score,
    threatScore: threat.score,
    aCutRiskScore: aCutRisk.score,
    residualScore: residual.score,
  };
}

// ============================================================
// 公開: Q3（敵セイム2保有）時のA切りリスク判定
// これが「不用心にA切って狩られる」を防ぐ中核関数
// ============================================================
export function shouldAvoidACut(ctx, situation, params) {
  const p = params || {};
  const sit = situation || {};

  // 1トリック目は完全無効化
  if ((ctx?.trickNo ?? 0) === 0) return { avoid: false, reason: 'trick_no_0', risk: 0 };

  const aCutRisk = evaluateACutRisk(ctx, sit, p);
  const threshold = p.aCutRiskThreshold ?? 0.35;
  const avoid = aCutRisk.score >= threshold;

  return {
    avoid,
    reason: avoid ? aCutRisk.primaryReason : 'low_risk',
    risk: aCutRisk.score,
    detail: aCutRisk,
  };
}

// ============================================================
// 公開: 候補戦術の生成（Q1/Q2/Q3/Q4）
// ============================================================
export function generateSameTwoTactics(ctx, situation, params) {
  const p = params || {};
  const sit = situation || {};
  const tactics = [];

  // Q1: 自分がセイム2保有
  if (sit.selfHasSameTwo && sit.selfHasSameTwo !== 'none') {
    tactics.push(...generateQ1Tactics(ctx, sit, p));
  }
  // Q2: 味方がセイム2保有（簡易: 敵保有推定が薄い + 味方連合軍の状況）
  if (sit.enemySameTwoEstimate === 'none' && sit.selfHasSameTwo === 'none' && (ctx?.trickNo ?? 0) > 0) {
    tactics.push(...generateQ2Tactics(ctx, sit, p));
  }
  // Q3: 敵がセイム2保有
  if (sit.enemySameTwoEstimate && sit.enemySameTwoEstimate !== 'none') {
    tactics.push(...generateQ3Tactics(ctx, sit, p));
  }
  // Q4: 誰も持っていない or 不明
  if (sit.enemySameTwoEstimate === 'unknown' || (!sit.selfHasSameTwo || sit.selfHasSameTwo === 'none') && sit.enemySameTwoEstimate === 'none') {
    tactics.push(...generateQ4Tactics(ctx, sit, p));
  }

  return tactics;
}

// ============================================================
// 内部: Q1 自分がセイム2保有（5戦術）
// ============================================================
function generateQ1Tactics(ctx, sit, p) {
  const tactics = [];
  const trickNo = ctx?.trickNo ?? 0;
  const contract = ctx?.contract;
  const hand = ctx?.hand || [];

  // Q1-0: 切札セイム2温存（切札2を保有している場合の最優先）
  const trumpTwo = contract && contract.suit !== 'NT' && hand.some(c => c.rank === '2' && c.suit === contract.suit);
  if (trumpTwo) {
    tactics.push({
      id: 'Q1-0',
      name: '切札セイム2温存',
      description: '切札スートの2を温存し、終盤の主導権奪取に使う',
      score: 3.0 * (p.sameTwoTrumpBonus ?? 1.5),
      situation: 'trump_two_hold',
    });
  }

  // Q1-1: セイム2温存（A狩り待ち）
  const enemyAcesRemain = countEnemyAces(ctx);
  if (enemyAcesRemain > 0 && trickNo > 0) {
    tactics.push({
      id: 'Q1-1',
      name: 'セイム2温存（A狩り待ち）',
      description: '敵のA温存中。全員フォロー確認できればA狩りに使う',
      score: 2.5 + 0.5 * enemyAcesRemain,
      situation: 'wait_for_ace',
    });
  }

  // Q1-2: セイム2即切り（主導権）
  if (trickNo >= 1 && trickNo <= 4) {
    tactics.push({
      id: 'Q1-2',
      name: 'セイム2即切り（主導権）',
      description: '序盤に主導権を握るためセイム2を使う',
      score: 1.5 * (p.sameTwoTimingEarly ?? 1.5),
      situation: 'early_initiative',
    });
  }

  // Q1-3: セイム2終盤温存
  if (trickNo <= 6) {
    tactics.push({
      id: 'Q1-3',
      name: 'セイム2終盤温存',
      description: '終盤（trick 7-9）の主導権奪取用に温存',
      score: 1.8 * (p.sameTwoTimingLate ?? 0.8) + 0.5,
      situation: 'late_hold',
    });
  }

  // Q1-4: セイム2安全切り（全員フォロー確定後）
  if (sit.followFeasibility === 'high' || sit.followFeasibility === 'confirmed') {
    tactics.push({
      id: 'Q1-4',
      name: 'セイム2安全切り',
      description: '全員フォローが確定。確実に勝てるタイミング',
      score: 2.2,
      situation: 'safe_cut',
    });
  }

  // Q1-5: セイム2回避
  if (sit.followFeasibility === 'impossible' || sit.followFeasibility === 'uncertain') {
    tactics.push({
      id: 'Q1-5',
      name: 'セイム2回避',
      description: '敵ボイドあり・全員フォロー不確実。セイム2を使わない',
      score: 1.0,
      situation: 'avoid_use',
    });
  }

  return tactics;
}

// ============================================================
// 内部: Q2 味方がセイム2保有（3戦術）
// ============================================================
function generateQ2Tactics(ctx, sit, p) {
  return [
    {
      id: 'Q2-1',
      name: '味方セイム2支援',
      description: '味方がセイム2を発動できるようリードで誘導',
      score: 1.2,
      situation: 'ally_support',
    },
    {
      id: 'Q2-2',
      name: '味方セイム2隠蔽',
      description: '味方の2を守るため低札で流す',
      score: 1.0,
      situation: 'ally_cover',
    },
    {
      id: 'Q2-3',
      name: '味方セイム2活用',
      description: '味方に任せて自分は別行動（主導権争い等）',
      score: 0.8,
      situation: 'ally_delegate',
    },
  ];
}

// ============================================================
// 内部: Q3 敵がセイム2保有（7戦術）
// ============================================================
function generateQ3Tactics(ctx, sit, p) {
  const tactics = [];
  const trickNo = ctx?.trickNo ?? 0;

  // Q3-1: trickNo=0でA先行切り（完全無効化）
  if (trickNo === 0 && countSelfAces(ctx) > 0) {
    tactics.push({
      id: 'Q3-1',
      name: 'trickNo=0でA先行切り',
      description: '1トリック目でAを切る。セイム2は完全無効化される',
      score: 3.5,
      situation: 'trick0_ace_cut',
    });
  }

  // Q3-2: ボイド作成後にA切り
  if (sit.followFeasibility === 'impossible' || sit.followFeasibility === 'uncertain') {
    tactics.push({
      id: 'Q3-2',
      name: 'ボイド作成後にA切り',
      description: '敵がボイドしてからAを切る。セイム2不成立',
      score: 3.0,
      situation: 'void_then_ace',
    });
  }

  // Q3-3: 2先行処理
  if (trickNo > 0 && countEnemyTwos(ctx) > 0) {
    tactics.push({
      id: 'Q3-3',
      name: '2先行処理',
      description: '2をリードして敵に消費させる',
      score: 2.0,
      situation: 'two_consume',
    });
  }

  // Q3-4: A温存
  const aCutRisk = evaluateACutRisk(ctx, sit, p);
  if (aCutRisk.score >= (p.aCutRiskThreshold ?? 0.35)) {
    tactics.push({
      id: 'Q3-4',
      name: 'A温存',
      description: '終盤までAを切らない。セイム2狩りリスク回避',
      score: 2.5 + aCutRisk.score,
      situation: 'ace_hold',
    });
  }

  // Q3-5: セイム2持ちsuit回避
  const dangerSuits = detectDangerSuits(ctx, sit);
  if (dangerSuits.length > 0) {
    tactics.push({
      id: 'Q3-5',
      name: 'セイム2持ちsuit回避',
      description: `危険suit(${dangerSuits.join(' ')})のAを切らない`,
      score: 2.0 + 0.3 * dangerSuits.length,
      situation: 'avoid_suit',
    });
  }

  // Q3-6: セイム2持ちsuitに切札カット
  if (trickNo > 0 && dangerSuits.length > 0 && hasVoidOpportunity(ctx, dangerSuits)) {
    tactics.push({
      id: 'Q3-6',
      name: 'セイム2持ちsuitに切札カット',
      description: '危険suitをリードしてフォロー崩し',
      score: 1.8,
      situation: 'cut_danger_suit',
    });
  }

  // Q3-7: セイム2持ち推定後のA切り
  if (dangerSuits.length > 0 && aCutRisk.score < (p.aCutRiskThreshold ?? 0.35)) {
    tactics.push({
      id: 'Q3-7',
      name: 'セイム2持ち推定後のA切り',
      description: '危険suitを特定済み。安全なsuitのAを切る',
      score: 1.5,
      situation: 'safe_ace_cut',
    });
  }

  return tactics;
}

// ============================================================
// 内部: Q4 誰も持っていない or 不明（通常戦術への誘導）
// ============================================================
function generateQ4Tactics(ctx, sit, p) {
  return [
    {
      id: 'Q4-1',
      name: 'セイム2無関係（通常戦術）',
      description: 'セイム2の脅威なし。通常のプレイ戦術を選ぶ',
      score: 0.5,
      situation: 'no_same_two',
    },
  ];
}

// ============================================================
// 内部: セイム2攻撃力評価（Q1用）
// ============================================================
function evaluateSameTwoAttack(ctx, sit, p) {
  const hand = ctx?.hand || [];
  const contract = ctx?.contract;
  const trickNo = ctx?.trickNo ?? 0;

  if (trickNo === 0) return { score: 0, reason: 'trick_no_0' };
  const selfTwos = hand.filter(c => c.rank === '2');
  if (selfTwos.length === 0) return { score: 0, reason: 'no_self_two' };

  let bestScore = 0;
  let bestSuit = null;
  for (const two of selfTwos) {
    const suit = two.suit;
    const isTrump = contract && contract.suit !== 'NT' && suit === contract.suit;
    const trumpBonus = isTrump ? (p.sameTwoTrumpBonus ?? 1.5) : (p.sameTwoSideBonus ?? 1.0);

    // 全員フォロー確率
    const voidCount = countVoidsInSuit(ctx, suit);
    const followProb = voidCount === 0 ? 0.9 : voidCount === 1 ? 0.6 : 0.2;

    // 狩れる対象の価値
    const enemyAcesInSuit = countEnemyAcesInSuit(ctx, suit);
    const pointCardsInSuit = countPointCardsInSuit(ctx, suit);
    const targetValue = enemyAcesInSuit * 3.0 + pointCardsInSuit * 1.0;

    // タイミング価値
    const timingValue = trickNo <= 3 ? (p.sameTwoTimingEarly ?? 1.5)
                      : trickNo <= 6 ? (p.sameTwoTimingMid ?? 1.2)
                      : (p.sameTwoTimingLate ?? 0.8);

    const score = trumpBonus * followProb * (targetValue + 1.0) * timingValue;
    if (score > bestScore) {
      bestScore = score;
      bestSuit = suit;
    }
  }
  return { score: bestScore, bestSuit, reason: 'attack_potential' };
}

// ============================================================
// 内部: セイム2脅威評価（Q3用）
// ============================================================
function evaluateSameTwoThreat(ctx, sit, p) {
  const played2 = countPlayedTwos(ctx);
  const remainingTwos = 4 - played2;
  if (remainingTwos <= 0) return { score: 0, reason: 'no_remaining_twos' };

  // 敵保有確率（簡易: 残り2の枚数 / 4）
  const enemyProb = Math.min(1.0, remainingTwos / 4);
  const trumpBonus = p.sameTwoTrumpBonus ?? 1.5;
  const threatWeight = p.sameTwoThreatWeight ?? 1.5;

  return {
    score: enemyProb * threatWeight * trumpBonus,
    reason: 'enemy_threat',
    remainingTwos,
    enemyProb,
  };
}

// ============================================================
// 内部: A切りリスク評価
// ============================================================
function evaluateACutRisk(ctx, sit, p) {
  const hand = ctx?.hand || [];
  const contract = ctx?.contract;
  const trickNo = ctx?.trickNo ?? 0;

  if (trickNo === 0) return { score: 0, reason: 'trick_no_0', primaryReason: 'trick_no_0' };
  if (!contract) return { score: 0, reason: 'no_contract', primaryReason: 'no_contract' };

  const selfAces = hand.filter(c => c.rank === 'A' && c.suit !== contract.suit);
  if (selfAces.length === 0) return { score: 0, reason: 'no_self_ace', primaryReason: 'no_self_ace' };

  let maxRisk = 0;
  let primaryReason = 'low';
  const details = [];

  for (const ace of selfAces) {
    const suit = ace.suit;
    const twoId = suit + '2';
    const twoPlayed = (ctx?.playedCards || []).some(c => c.id === twoId)
                   || (ctx?.discardedKitty || []).some(c => c.id === twoId);
    if (twoPlayed) {
      details.push({ suit, risk: 0, reason: 'two_played' });
      continue;
    }

    // 敵ボイド確認
    const voids = ctx?.voids || [{}, {}, {}, {}, {}];
    const seat = ctx?.seat ?? 0;
    let enemyVoids = 0;
    for (let s = 0; s < 5; s++) {
      if (s === seat) continue;
      if (s === contract.nap) continue;
      if (!contract.solo && s === contract.deputy) continue;
      if (voids[s] && voids[s][suit]) enemyVoids++;
    }
    if (enemyVoids > 0) {
      details.push({ suit, risk: 0, reason: 'enemy_void' });
      continue;
    }

    // リスク計算
    const riskWeight = p.sameTwoRiskWeight ?? 1.0;
    const twoRemainingProb = 0.6; // 残り2保有確率（簡易）
    const allFollowProb = 0.9;
    const risk = riskWeight * twoRemainingProb * allFollowProb;

    details.push({ suit, risk, reason: 'potential_same_two' });
    if (risk > maxRisk) {
      maxRisk = risk;
      primaryReason = 'potential_same_two_in_' + suit;
    }
  }

  return {
    score: maxRisk,
    reason: 'a_cut_risk',
    primaryReason,
    details,
  };
}

// ============================================================
// 内部: セイム2残存度評価
// ============================================================
function evaluateSameTwoResidual(ctx, sit, p) {
  const played2 = countPlayedTwos(ctx);
  const hand = ctx?.hand || [];
  const self2 = hand.filter(c => c.rank === '2').length;
  const remaining = Math.max(0, 4 - played2);

  return {
    score: remaining / 4,
    reason: 'residual',
    remaining,
    self2,
    played2,
  };
}

// ============================================================
// 内部ヘルパー
// ============================================================
function countEnemyAces(ctx) {
  const contract = ctx?.contract;
  const played = ctx?.playedCards || [];
  const discarded = ctx?.discardedKitty || [];
  const hand = ctx?.hand || [];
  if (!contract) return 0;
  let count = 0;
  for (const suit of SUITS) {
    if (suit === contract.suit) continue;
    const aceId = suit + 'A';
    if (aceId === '♠A') continue; // マイティは別扱い
    if (hand.some(c => c.id === aceId)) continue;
    if (played.some(c => c.id === aceId)) continue;
    if (discarded.some(c => c.id === aceId)) continue;
    count++;
  }
  return count;
}

function countSelfAces(ctx) {
  const contract = ctx?.contract;
  const hand = ctx?.hand || [];
  if (!contract) return 0;
  return hand.filter(c => c.rank === 'A' && c.suit !== contract.suit).length;
}

function countEnemyTwos(ctx) {
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

function countPlayedTwos(ctx) {
  const played = ctx?.playedCards || [];
  const discarded = ctx?.discardedKitty || [];
  return [...played, ...discarded].filter(c => c.rank === '2').length;
}

function countVoidsInSuit(ctx, suit) {
  const voids = ctx?.voids || [{}, {}, {}, {}, {}];
  const seat = ctx?.seat ?? 0;
  let count = 0;
  for (let s = 0; s < 5; s++) {
    if (s === seat) continue;
    if (voids[s] && voids[s][suit]) count++;
  }
  return count;
}

function countEnemyAcesInSuit(ctx, suit) {
  const contract = ctx?.contract;
  if (!contract) return 0;
  const aceId = suit + 'A';
  if (aceId === '♠A') return 0;
  const played = ctx?.playedCards || [];
  const discarded = ctx?.discardedKitty || [];
  const hand = ctx?.hand || [];
  if (hand.some(c => c.id === aceId)) return 0;
  if (played.some(c => c.id === aceId)) return 0;
  if (discarded.some(c => c.id === aceId)) return 0;
  return 1;
}

function countPointCardsInSuit(ctx, suit) {
  const played = ctx?.playedCards || [];
  const discarded = ctx?.discardedKitty || [];
  const hand = ctx?.hand || [];
  let count = 0;
  for (const rank of FACE) {
    if (rank === 'A') continue; // Aは別カウント
    const id = suit + rank;
    if (hand.some(c => c.id === id)) continue;
    if (played.some(c => c.id === id)) continue;
    if (discarded.some(c => c.id === id)) continue;
    count++;
  }
  return count;
}

function detectDangerSuits(ctx, sit) {
  const contract = ctx?.contract;
  if (!contract) return [];
  const hand = ctx?.hand || [];
  const played = ctx?.playedCards || [];
  const discarded = ctx?.discardedKitty || [];
  const danger = [];
  for (const suit of SUITS) {
    if (suit === contract.suit) continue;
    const aceId = suit + 'A';
    if (aceId === '♠A') continue;
    if (!hand.some(c => c.id === aceId)) continue;
    const twoId = suit + '2';
    if (played.some(c => c.id === twoId) || discarded.some(c => c.id === twoId)) continue;
    danger.push(suit);
  }
  return danger;
}

function hasVoidOpportunity(ctx, dangerSuits) {
  const voids = ctx?.voids || [{}, {}, {}, {}, {}];
  const seat = ctx?.seat ?? 0;
  return dangerSuits.some(suit => voids[seat] && voids[seat][suit]);
}

// ============================================================
// 公開: デバッグ用情報
// ============================================================
export function debugSameTwo(ctx, situation, params) {
  const result = evaluateSameTwo(ctx, situation, params);
  const avoid = shouldAvoidACut(ctx, situation, params);
  return {
    ...result,
    avoid,
    detail: {
      attack: result.attack,
      threat: result.threat,
      aCutRisk: result.aCutRisk,
      residual: result.residual,
    },
  };
}
