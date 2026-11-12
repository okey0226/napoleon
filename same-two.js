// same-two.js — セイム2評価層（既存ファイル修正）
// 既存ファイル修正: A切りリスク動的計算、切札2区別、味方ボイド対応

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
    attackScore: attack.score,
    threatScore: threat.score,
    aCutRiskScore: aCutRisk.score,
    residualScore: residual.score,
  };
}

// ============================================================
// 公開: A切りリスク判定（0.65閾値で回避）
// ============================================================
export function shouldAvoidACut(ctx, situation, params) {
  const p = params || {};
  const sit = situation || {};

  // 1トリック目は完全無効化
  if ((ctx?.trickNo ?? 0) === 0) return { avoid: false, reason: 'trick_no_0', risk: 0 };

  const aCutRisk = evaluateACutRisk(ctx, sit, p);
  const threshold = p.aCutRiskThreshold ?? 0.65;  // ★ 0.65デフォルト
  const avoid = aCutRisk.score >= threshold;

  return {
    avoid,
    reason: avoid ? aCutRisk.primaryReason : 'low_risk',
    risk: aCutRisk.score,
    detail: aCutRisk,
  };
}

// ============================================================
// 公開: 候補戦術の生成
// ============================================================
export function generateSameTwoTactics(ctx, situation, params) {
  const p = params || {};
  const sit = situation || {};
  const tactics = [];

  if (sit.selfHasSameTwo && sit.selfHasSameTwo !== 'none') {
    tactics.push(...generateQ1Tactics(ctx, sit, p));
  }
  if (sit.enemySameTwoEstimate === 'none' && sit.selfHasSameTwo === 'none' && (ctx?.trickNo ?? 0) > 0) {
    tactics.push(...generateQ2Tactics(ctx, sit, p));
  }
  if (sit.enemySameTwoEstimate && sit.enemySameTwoEstimate !== 'none') {
    tactics.push(...generateQ3Tactics(ctx, sit, p));
  }
  if (sit.enemySameTwoEstimate === 'unknown' || ((!sit.selfHasSameTwo || sit.selfHasSameTwo === 'none') && sit.enemySameTwoEstimate === 'none')) {
    tactics.push(...generateQ4Tactics(ctx, sit, p));
  }

  return tactics;
}

// ============================================================
// 内部: Q1 自分がセイム2保有（切札/サイド区別）
// ============================================================
function generateQ1Tactics(ctx, sit, p) {
  const tactics = [];
  const trickNo = ctx?.trickNo ?? 0;
  const contract = ctx?.contract;

  // ★ 修正: sit.selfHasSameTwo で切札/サイドを区別
  const isTrump2 = sit.selfHasSameTwo === 'trump';
  const isSide2 = sit.selfHasSameTwo === 'side';

  // Q1-0: 切札セイム2温存（切札2のみ）
  if (isTrump2) {
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
      score: 2.5 + 0.5 * enemyAcesRemain + (isTrump2 ? 0.5 : 0),
      situation: 'wait_for_ace',
    });
  }

  // Q1-2: セイム2即切り（主導権）
  if (trickNo >= 1 && trickNo <= 4) {
    tactics.push({
      id: 'Q1-2',
      name: 'セイム2即切り（主導権）',
      description: '序盤に主導権を握るためセイム2を使う',
      score: 1.5 * (p.sameTwoTimingEarly ?? 1.5) + (isTrump2 ? 0.3 : 0),
      situation: 'early_initiative',
    });
  }

  // Q1-3: セイム2終盤温存
  if (trickNo <= 6) {
    tactics.push({
      id: 'Q1-3',
      name: 'セイム2終盤温存',
      description: '終盤（trick 7-9）の主導権奪取用に温存',
      score: 1.8 * (p.sameTwoTimingLate ?? 0.8) + 0.5 + (isTrump2 ? 0.3 : 0),
      situation: 'late_hold',
    });
  }

  // Q1-4: セイム2安全切り（全員フォロー確定後）
  if (sit.followFeasibility === 'high' || sit.followFeasibility === 'confirmed') {
    tactics.push({
      id: 'Q1-4',
      name: 'セイム2安全切り',
      description: '全員フォローが確定。確実に勝てるタイミング',
      score: 2.2 + (isTrump2 ? 0.3 : 0),
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
// 内部: Q2 味方がセイム2保有
// ============================================================
function generateQ2Tactics(ctx, sit, p) {
  return [
    { id: 'Q2-1', name: '味方セイム2支援', description: '味方がセイム2を発動できるようリードで誘導', score: 1.2, situation: 'ally_support' },
    { id: 'Q2-2', name: '味方セイム2隠蔽', description: '味方の2を守るため低札で流す', score: 1.0, situation: 'ally_cover' },
    { id: 'Q2-3', name: '味方セイム2活用', description: '味方に任せて自分は別行動（主導権争い等）', score: 0.8, situation: 'ally_delegate' },
  ];
}

// ============================================================
// 内部: Q3 敵がセイム2保有（7戦術）
// ============================================================
function generateQ3Tactics(ctx, sit, p) {
  const tactics = [];
  const trickNo = ctx?.trickNo ?? 0;
  const aCutRisk = evaluateACutRisk(ctx, sit, p);
  const threshold = p.aCutRiskThreshold ?? 0.65;

  // Q3-1: trickNo=0でA先行切り（完全無効化）
  if (trickNo === 0 && countSelfAces(ctx) > 0) {
    tactics.push({ id: 'Q3-1', name: 'trickNo=0でA先行切り', description: '1トリック目でAを切る。セイム2は完全無効化される', score: 3.5, situation: 'trick0_ace_cut' });
  }

  // Q3-2: ボイド作成後にA切り
  if (sit.followFeasibility === 'impossible' || sit.followFeasibility === 'uncertain') {
    tactics.push({ id: 'Q3-2', name: 'ボイド作成後にA切り', description: '敵がボイドしてからAを切る。セイム2不成立', score: 3.0, situation: 'void_then_ace' });
  }

  // Q3-3: 2先行処理
  if (trickNo > 0 && countEnemyTwos(ctx) > 0) {
    tactics.push({ id: 'Q3-3', name: '2先行処理', description: '2をリードして敵に消費させる', score: 2.0, situation: 'two_consume' });
  }

  // Q3-4: A温存（★ 修正: 新閾値で判定）
  if (aCutRisk.score >= threshold) {
    tactics.push({ id: 'Q3-4', name: 'A温存', description: '終盤までAを切らない。セイム2狩りリスク回避', score: 2.5 + aCutRisk.score, situation: 'ace_hold' });
  }

  // Q3-5: セイム2持ちsuit回避
  const dangerSuits = detectDangerSuits(ctx, sit);
  if (dangerSuits.length > 0) {
    tactics.push({ id: 'Q3-5', name: 'セイム2持ちsuit回避', description: `危険suit(${dangerSuits.join(' ')})のAを切らない`, score: 2.0 + 0.3 * dangerSuits.length, situation: 'avoid_suit' });
  }

  // Q3-6: セイム2持ちsuitに切札カット（フォロー時の代替）
  if (trickNo > 0 && dangerSuits.length > 0 && hasVoidOpportunity(ctx, dangerSuits)) {
    tactics.push({ id: 'Q3-6', name: 'セイム2持ちsuitに切札カット', description: '危険suitでフォローせず切札でカット', score: 1.8, situation: 'cut_danger_suit' });
  }

  // Q3-7: セイム2持ち推定後のA切り
  if (dangerSuits.length > 0 && aCutRisk.score < threshold) {
    tactics.push({ id: 'Q3-7', name: 'セイム2持ち推定後のA切り', description: '危険suitを特定済み。安全なsuitのAを切る', score: 1.5, situation: 'safe_ace_cut' });
  }

  return tactics;
}

// ============================================================
// 内部: Q4 誰も持っていない or 不明
// ============================================================
function generateQ4Tactics(ctx, sit, p) {
  return [{ id: 'Q4-1', name: 'セイム2無関係（通常戦術）', description: 'セイム2の脅威なし。通常のプレイ戦術を選ぶ', score: 0.5, situation: 'no_same_two' }];
}

// ============================================================
// 内部: セイム2攻撃力評価（Q1用、★ 切札2/サイド2区別）
// ============================================================
function evaluateSameTwoAttack(ctx, sit, p) {
  const hand = ctx?.hand || [];
  const contract = ctx?.contract;
  const trickNo = ctx?.trickNo ?? 0;

  if (trickNo === 0) return { score: 0, reason: 'trick_no_0' };
  if (!sit.selfHasSameTwo || sit.selfHasSameTwo === 'none') return { score: 0, reason: 'no_self_two' };

  // ★ 修正: sit.selfHasSameTwo を直接参照
  const isTrump = sit.selfHasSameTwo === 'trump';
  const selfTwos = hand.filter(c => c.rank === '2');
  if (selfTwos.length === 0) return { score: 0, reason: 'no_self_two_hand' };

  let bestScore = 0;
  let bestSuit = null;
  for (const two of selfTwos) {
    const suit = two.suit;
    const isThisTrump = contract && contract.suit !== 'NT' && suit === contract.suit;
    const trumpBonus = isThisTrump ? (p.sameTwoTrumpBonus ?? 1.5) : (p.sameTwoSideBonus ?? 1.0);

    const voidCount = countVoidsInSuit(ctx, suit);
    const followProb = voidCount === 0 ? 0.9 : voidCount === 1 ? 0.6 : 0.2;

    const enemyAcesInSuit = countEnemyAcesInSuit(ctx, suit);
    const pointCardsInSuit = countPointCardsInSuit(ctx, suit);
    const targetValue = enemyAcesInSuit * 3.0 + pointCardsInSuit * 1.0;

    const timingValue = trickNo <= 3 ? (p.sameTwoTimingEarly ?? 1.5)
                      : trickNo <= 6 ? (p.sameTwoTimingMid ?? 1.2)
                      : (p.sameTwoTimingLate ?? 0.8);

    const score = trumpBonus * followProb * (targetValue + 1.0) * timingValue;
    if (score > bestScore) { bestScore = score; bestSuit = suit; }
  }
  return { score: bestScore, bestSuit, isTrump, reason: 'attack_potential' };
}

// ============================================================
// 内部: セイム2脅威評価（Q3用）
// ============================================================
function evaluateSameTwoThreat(ctx, sit, p) {
  const played2 = countPlayedTwos(ctx);
  const hand2 = countSelfTwos(ctx);
  const remainingTwos = 4 - played2 - hand2;
  if (remainingTwos <= 0) return { score: 0, reason: 'no_remaining_twos' };

  const enemyProb = Math.min(1.0, remainingTwos / 4);
  const trumpBonus = (sit.enemySameTwoEstimate === 'trump') ? (p.sameTwoTrumpBonus ?? 1.5) : 1.0;
  const threatWeight = p.sameTwoThreatWeight ?? 1.5;

  return {
    score: enemyProb * threatWeight * trumpBonus,
    reason: 'enemy_threat',
    remainingTwos,
    enemyProb,
  };
}

// ============================================================
// ★ 修正: A切りリスク評価（動的確率計算）
// ============================================================
function evaluateACutRisk(ctx, sit, p) {
  const hand = ctx?.hand || [];
  const contract = ctx?.contract;
  const trickNo = ctx?.trickNo ?? 0;
  const voids = ctx?.voids || [{}, {}, {}, {}, {}];
  const playedCards = ctx?.playedCards || [];
  const discardedKitty = ctx?.discardedKitty || [];
  const seat = ctx?.seat ?? 0;

  if (trickNo === 0) return { score: 0, reason: 'trick_no_0', primaryReason: 'trick_no_0' };
  if (!contract) return { score: 0, reason: 'no_contract', primaryReason: 'no_contract' };

  const selfAces = hand.filter(c => c.rank === 'A' && c.suit !== contract.suit);
  if (selfAces.length === 0) return { score: 0, reason: 'no_self_ace', primaryReason: 'no_self_ace' };

  // ★ 修正: 役割に応じた敵手札数の動的計算
  const isNapSide = seat === contract.nap || (!contract.solo && seat === contract.deputy);
  let enemyHands;
  if (isNapSide) {
    // NAP側: 副官判明なら3、不明なら4（保守的）
    enemyHands = (contract.revealedCall && !contract.solo) ? 3 : 4;
  } else {
    // 連合軍側: NAP + 副官 = 2
    enemyHands = 2;
  }
  const enemy2Prob = enemyHands / 4;

  const details = [];
  let maxRisk = 0;
  let primaryReason = 'low';

  for (const ace of selfAces) {
    const suit = ace.suit;
    const twoId = suit + '2';
    const isTrump2 = contract.suit === suit && contract.suit !== 'NT';

    // 2が既に場/捨て札にある
    if (playedCards.some(c => c.id === twoId) || discardedKitty.some(c => c.id === twoId)) {
      details.push({ suit, risk: 0, reason: 'two_played' });
      continue;
    }
    // 2が自分の手札にある
    if (hand.some(c => c.id === twoId)) {
      details.push({ suit, risk: 0, reason: 'two_in_self' });
      continue;
    }
    // ★ 修正: 誰か（味方含む）がボイド → セイム2不成立
    let anyVoidInSuit = 0;
    for (let s = 0; s < 5; s++) {
      if (s === seat) continue;
      if (voids[s] && voids[s][suit]) anyVoidInSuit++;
    }
    if (anyVoidInSuit > 0) {
      details.push({ suit, risk: 0, reason: 'any_void_breaks_same_two' });
      continue;
    }

    // ★ 修正: 動的リスク計算
    const riskWeight = p.sameTwoRiskWeight ?? 1.0;
    const trumpBonus = isTrump2 ? (p.sameTwoTrumpBonus ?? 1.5) : 1.0;
    const risk = riskWeight * enemy2Prob * trumpBonus;

    details.push({ suit, risk, enemy2Prob, isTrump2, reason: isTrump2 ? 'trump_two_threat' : 'side_two_threat' });
    if (risk > maxRisk) {
      maxRisk = risk;
      primaryReason = isTrump2 ? 'trump_two_in_' + suit : 'side_two_in_' + suit;
    }
  }

  return { score: maxRisk, reason: 'a_cut_risk', primaryReason, details };
}

// ============================================================
// 内部: セイム2残存度評価
// ============================================================
function evaluateSameTwoResidual(ctx, sit, p) {
  const played2 = countPlayedTwos(ctx);
  const hand = ctx?.hand || [];
  const self2 = hand.filter(c => c.rank === '2').length;
  const remaining = Math.max(0, 4 - played2);

  return { score: remaining / 4, reason: 'residual', remaining, self2, played2 };
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
    if (aceId === '♠A') continue;
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

function countSelfTwos(ctx) {
  const hand = ctx?.hand || [];
  return hand.filter(c => c.rank === '2').length;
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
    if (rank === 'A') continue;
    const id = suit + rank;
    if (hand.some(c => c.id === id)) continue;
    if (played.some(c => c.id === id)) continue;
    if (discarded.some(c => c.id === id)) continue;
    count++;
  }
  return count;
}

// ★ 修正: 危険suit検出で切札2を優先
function detectDangerSuits(ctx, sit) {
  const contract = ctx?.contract;
  if (!contract) return [];
  const hand = ctx?.hand || [];
  const played = ctx?.playedCards || [];
  const discarded = ctx?.discardedKitty || [];
  const danger = [];
  const trumpDanger = [];

  for (const suit of SUITS) {
    if (suit === contract.suit) continue;
    const aceId = suit + 'A';
    if (aceId === '♠A') continue;
    if (!hand.some(c => c.id === aceId)) continue;
    const twoId = suit + '2';
    if (played.some(c => c.id === twoId) || discarded.some(c => c.id === twoId)) continue;
    if (hand.some(c => c.id === twoId)) continue;  // 自分の2は安全
    danger.push(suit);
  }

  // 切札2が残存する場合、切札suitも危険
  if (contract.suit !== 'NT') {
    const trumpTwoId = contract.suit + '2';
    const twoPlayed = played.some(c => c.id === trumpTwoId) || discarded.some(c => c.id === trumpTwoId);
    const inHand = hand.some(c => c.id === trumpTwoId);
    if (!twoPlayed && !inHand) {
      trumpDanger.push(contract.suit);
    }
  }

  return [...trumpDanger, ...danger];
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
