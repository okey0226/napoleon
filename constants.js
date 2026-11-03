// constants.js (経験DB・全機能統合版)
export const SUITS = ['♣', '♦', '♥', '♠'];
export const RANKS = ['2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K', 'A'];
export const SV = { '♣': 1, '♦': 2, '♥': 3, '♠': 4, 'NT': 5 };
export const ELO_INIT = 1000;
export const FACE = ['10', 'J', 'Q', 'K', 'A'];

export const shuffledDeck = () => {
  let d = [];
  SUITS.forEach(s => RANKS.forEach(r => d.push({ suit: s, rank: r, id: s + r })));
  for (let i = d.length - 1; i > 0; i--) {
    let j = Math.floor(Math.random() * (i + 1));
    [d[i], d[j]] = [d[j], d[i]];
  }
  return d;
};

export const sortHand = (hand) => {
  hand.sort((a, b) => SV[b.suit] - SV[a.suit] || RANKS.indexOf(b.rank) - RANKS.indexOf(a.rank));
};

export const defaultStrategy = () => ({
  // 競り
  bidThreshold: 2.0, riskTolerance: 0.5, leadAggression: 0.6, followAggression: 0.4,
  trumpBonus: 0.6, mightyBonus: 2.0, safeAceWeight: 0.7, roleCardPreservation: 0.6,
  deputyFeedBias: 0.5, opponentInferenceWeight: 0.4, suitConflictWeight: 0.6,
  mightyShadowWeight: 0.3, weakOpponentBoost: 0.3, bluffLossMultiplier: 0.6,
  cooperationBonus: 0.5, ntPreference: 0.85, ntSuitLengthBonus: 1.2, ntAceWeight: 1.5,
  ntMightyBonus: 2.5, highBidNtThreshold: 17, aceWeakSuitBonus: 0.3, aceShortBonus: 0.15,
  aceLongPenalty: 0.15, sameTwoAceCounter: 0.3, sameTwoShortBonus: 0.4, sameTwoLongPenalty: 0.25,
  sameTwoHighBidBonus: 0.2, trumpExhaustionThreshold: 3, baitModeWindow: 2, baitMinTrumps: 4,
  strongTrumpLeadAggression: 0.7, aceCashUrgency: 1.0, pointCardSafetyThreshold: 0.5,
  tenHoldThreshold: 0.6, nonTrumpAceWaiting: 0.5, baitBackJWindow: 3, baitBackJChance: 0.6,
  faceCardOnNapWin: 0.9, preserveNextStronger: 0.9, deputyRevealUrgency: 0.5,
  deputyCoverWeight: 0.5, sameTwoDeputyBonus: 0.5, allyFaceCardBonus: 0.9,
  napWeaknessLeadWeight: 0.8, trumpAvoidWeight: 0.9, sameColorSuitAvoid: 0.8,
  spadeLeadPriority: 0.7, nonDeclaredSuitWeight: 0.6, queenHoardWeight: 0.6,
  sameTwoHoardWeight: 0.5, allyYieldBonus: 0.5, allySameTwoLeadChance: 0.55, allySameTwoWindow: 4,
  teamCooperationWeight: 1.5, feedBonusWeight: 1.0, overkillPenalty: 1.0,
  mctsSimulations: 150, mctsExploration: 1.414, handInferenceWeight: 0.5,
  rolloutPolicyWeight: 0.8, bayesUpdateRate: 0.05,
  ntMightyHoldThreshold: 8, ntMightyShadowWeight: 1.5, ntAceLeadPriority: 1.2,
  ntVoidExploitWeight: 1.5, ntDeputyFeedChance: 0.8, ntEarlyLeadAggression: 0.7, ntLateGameSafety: 1.0,
  ntAceProtectLeadWeight: 1.5, ntSameTwoGuardWeight: 1.2, allyVoidExploitWeight: 1.0,
  deputyBluffWeight: 0.8, ntDeputyMightyHoldThreshold: 8, ntMightyEmergencyTrick: 5,
  napEarlyTrumpLeadWeight: 1.5, napEarlyTrumpLeadMaxTrick: 3, napEarlyTrumpMinCount: 4,
  deputyOvertrumpWeight: 1.8,
  bidTimeBudgetMs: 600, bidMaxSamples: 800, bidSafetyMargin: 0.4, bidSimCount: 30,
  planAccuracyWeight: 2.0, overbidPenalty: 2.0, underbidPenalty: 1.0, planAccuracyBonus: 2.0,
  winPointMap: [0, 2, 4, 6, 8, 10, 12, 14, 16, 18, 20],
  lossPointMap: [0, 2, 4, 5, 7, 9, 11, 13, 15, 17, 20],
  bidPacingMs: 4000, bidStartValue: 13,
  tossUpSafetyMargin: 0.4, tossUpSafetyMarginBottom: 0.2,
  signalS1Bonus: 1, signalS2Bonus: 2, signalThreeRoleBonus: 4, signalS3Bonus: 2,
  s1RequiredMinorCards: 2, s3RequiredAces: 2,
  sameColorBidderLimit: 2, ntBidderLimit: 2, s2ThreeRoleExtra: 1,
  nnWeights: {
    bias: 0.0, handStrength: 0.5, trumpRemaining: 0.3, pointsNeeded: -0.4, trickNo: -0.2,
    isNap: 0.3, isDeputy: 0.1, isAlly: -0.1, hasMighty: 0.8
  },
  // 経験DB関連
  expHitWeight: 1.0,       // 経験ヒット時の信頼度
  similarityThreshold: 5.0, // 類似度検索の距離閾値
});

export const sameColorSuitOf = (suit) => {
  if (suit === '♣') return '♠';
  if (suit === '♠') return '♣';
  if (suit === '♦') return '♥';
  if (suit === '♥') return '♦';
  return 'NT';
};

export const isSameColorSuit = (s1, s2) => sameColorSuitOf(s1) === s2;

export const quantizeStrength = (s) => Math.round(s * 2) / 2;
export const bidExperienceKey = (strength, type, num) => `${strength}:${type}:${num}`;
export const callExperienceKey = (id, suit) => `${id}:${suit}`;
export const playExperienceKey = (role, phase, points, rank) => `${role}:${phase}:${points}:${rank}`;

export const rankTierOf = (rank) => RANKS.indexOf(rank) > 9 ? 'high' : RANKS.indexOf(rank) > 5 ? 'mid' : 'low';
export const trickPhaseOf = (trickNo) => trickNo < 3 ? 'early' : trickNo < 7 ? 'mid' : 'late';
export const pointsTierOf = (pts) => pts === 0 ? 'zero' : pts < 3 ? 'mid' : 'high';

export const experienceConfidence = (samples) => Math.min(1, samples / 10);
export const blendWithExperience = (p, exp) => exp && exp.samples >= 3 ? (p * 0.7 + (exp.wins / exp.samples) * 0.3) : p;

// ★ 評価関数フィードバック（5世代ごとに呼び出される想定）
export const updateStrategyFromExperience = (baseParams, stats) => {
  const p = { ...baseParams };
  // 例: 「A温存」と「A切り」の勝率差から safeAceWeight を調整
  if (stats.aceHoldWins > 100 && stats.aceHoldWinRate > stats.acePlayWinRate + 0.05) {
    p.safeAceWeight = Math.min(1.0, p.safeAceWeight + 0.1);
  } else if (stats.acePlayWins > 100 && stats.acePlayWinRate > stats.aceHoldWinRate + 0.05) {
    p.safeAceWeight = Math.max(0.1, p.safeAceWeight - 0.1);
  }
  // 例: 高枚数立ち成功率から bidThreshold を調整
  if (stats.highBidSuccessRate > 0.6 && stats.highBidAttempts > 50) {
    p.bidThreshold = Math.max(1.5, p.bidThreshold - 0.1);
  } else if (stats.highBidSuccessRate < 0.3 && stats.highBidAttempts > 50) {
    p.bidThreshold = Math.min(5.0, p.bidThreshold + 0.1);
  }
  return p;
};

export const matchRatingChanges = (matchScores, abandonedSeats = []) => {
  const abandoned = new Set(Array.isArray(abandonedSeats) ? abandonedSeats : []);
  const ranked = matchScores.map((s, i) => ({ s, i })).sort((a, b) => b.s - a.s || a.i - b.i);
  const placementBySeat = [];
  ranked.forEach((entry, idx) => { placementBySeat[entry.i] = idx + 1; });
  
  const baseDeltas = { 1: 25, 2: 5, 3: 0, 4: -5, 5: -25 };
  
  return matchScores.map((s, i) => {
    const isAbandoned = abandoned.has(i);
    const rank = placementBySeat[i];
    const baseDelta = baseDeltas[rank] ?? 0;
    const abandonPenalty = isAbandoned ? -30 : 0;
    const delta = baseDelta + abandonPenalty;
    let outcome = 'loss';
    if (rank === 1) outcome = 'win';
    else if (rank === 2 || rank === 3) outcome = 'draw';
    return { outcome, delta, placement: rank, abandoned: isAbandoned, abandonPenalty, baseDelta, breakdown: { rank, rounds: [] } };
  });
};

export const computeEloDelta = (myElo, oppElos, outcome) => {
  if (!Array.isArray(oppElos) || !oppElos.length) return 0;
  let expected = 0;
  for (const elo of oppElos) expected += 1 / (1 + Math.pow(10, (elo - myElo) / 400));
  expected /= oppElos.length;
  const score = outcome === 'win' ? 1 : 0;
  return Math.round(32 * (score - expected));
};

export const rateRound = (seat, roundData, params, weight = 1) => {
  const { nap, deputy, solo, num, won, takenPoints } = roundData;
  if (!Number.isFinite(seat) || seat < 0 || seat > 4) return 0;
  const isNapSide = seat === nap || (!solo && seat === deputy);
  let score = 0;
  if (isNapSide) {
    score += won ? (1.5 + (num - 13) * 0.4) : -(0.8 + (num - 13) * 0.1);
    score += (takenPoints[seat] || 0) * 0.05;
  } else {
    score += !won ? (0.8 + (num - 13) * 0.1) : -1.2;
    score += (takenPoints[seat] || 0) * 0.05;
  }
  return Math.max(-3, Math.min(3, score)) * weight;
};

export const RANK_1_BONUS = 25;
export const RANK_2_BONUS = 5;
export const RANK_4_PENALTY = -5;
export const RANK_5_PENALTY = -25;
