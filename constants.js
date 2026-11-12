// constants.js (経験DB・全機能統合版 + MECE戦術エンジン対応)
export const SUITS = ['♣', '♦', '♥', '♠'];
export const RANKS = ['2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K', 'A'];
export const SV = { '♣': 1, '♦': 2, '♥': 3, '♠': 4, 'NT': 5 };
export const ELO_INIT = 1000;
export const FACE = ['10', 'J', 'Q', 'K', 'A'];

export const CALIBRATION = { 13: 0.62, 14: 0.55, 15: 0.45, 16: 0.35, 17: 0.25, 18: 0.15, 19: 0.08, 20: 0.04 };
export const SWEET_SPOT_BONUS = 2.5;
export const HONEST_BID_FIXED_BONUS = 2.0;
export const ALLY_LOSS_PENALTY = -5;
export const ALLY_WIN_BONUS = 5;
export const ALLY_BLOCK_BONUS = 2;

export const RATING_BASE = { 1: 25, 2: 5, 3: 0, 4: -5, 5: -25 };
export const PLAYOFF_MAX_ITERATIONS = 10;

export const RANK_1_BONUS = 25;
export const RANK_2_BONUS = 5;
export const RANK_4_PENALTY = -5;
export const RANK_5_PENALTY = -25;

export const METRIC_KEYS = [
  'avgValueLoss', 'endgameAccuracy', 'openingAccuracy', 'sameTwoUtilization',
  'trumpEfficiency', 'voidExploitSuccess', 'allTakeAvoidance', 'overtrickAvoidance',
  'bidCalibration', 'bidGap', 'earlyBidQuality', 'deputyCallAccuracy',
  'roleAwareness', 'feedSuccessRate', 'signalCoherence',
];

export const METRIC_DIRECTION = {
  avgValueLoss: false, endgameAccuracy: true, openingAccuracy: true, sameTwoUtilization: true,
  trumpEfficiency: true, voidExploitSuccess: true, allTakeAvoidance: true, overtrickAvoidance: true,
  bidCalibration: false, bidGap: false, earlyBidQuality: true, deputyCallAccuracy: true,
  roleAwareness: true, feedSuccessRate: true, signalCoherence: true,
};

export const METRIC_WEIGHTS = {
  avgValueLoss: 5.0, endgameAccuracy: 2.0, openingAccuracy: 1.5, sameTwoUtilization: 1.5,
  trumpEfficiency: 2.0, voidExploitSuccess: 1.5, allTakeAvoidance: 2.0, overtrickAvoidance: 1.5,
  bidCalibration: 3.0, bidGap: 2.5, earlyBidQuality: 2.0, deputyCallAccuracy: 2.5,
  roleAwareness: 1.5, feedSuccessRate: 2.0, signalCoherence: 1.0,
};

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
  // ============================================================
  // ★ MECE戦術エンジン用: 期待値目的関数の重み
  // ============================================================
  W_WIN: 10.0,
  W_POINTS: 1.0,
  W_TRICKS: 0.3,
  W_ALLTAKE: 20.0,

  // ============================================================
  // ★ MECE戦術エンジン用: 戦術prior計算の重み
  // ============================================================
  W_MATCH: 2.0,
  W_ANALYTIC: 3.0,
  W_EXPERIENCE: 1.5,
  W_RISK: 1.5,
  priorTemperature: 0.8,
  experienceBlendRatio: 0.4,

  // ============================================================
  // ★ MECE戦術エンジン用: 有効/無効フラグ
  // ============================================================
  enableTacticEngine: true,

  // ============================================================
  // ★ MECE戦術エンジン用: 決定論MCTS
  // ============================================================
  mctsNodeBudget: 5000,
  useDeterministicSeed: 1.0,

  // ============================================================
  // ★ セイム2評価パラメータ（調整済み）
  // ============================================================
  sameTwoThreatWeight: 1.5,
  sameTwoRiskWeight: 1.0,
  sameTwoResidualWeight: 0.8,
  aCutRiskThreshold: 0.65,        // ★ 0.35 → 0.65（デフォルト回避、証拠で許可）
  sameTwoAttackChance: 0.55,
  sameTwoDefenseMargin: 0.25,
  sameTwoTrumpBonus: 1.5,
  sameTwoSideBonus: 1.0,
  sameTwoTimingEarly: 1.5,
  sameTwoTimingMid: 1.2,
  sameTwoTimingLate: 0.8,

  // ============================================================
  // 既存パラメータ
  // ============================================================
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
  teamCooperationWeight: 1.5, feedBonusWeight: 1.0, overkillPenalty: 2.0,
  mctsSimulations: 150, mctsExploration: 1.414, handInferenceWeight: 0.5,
  rolloutPolicyWeight: 0.8, bayesUpdateRate: 0.05,
  ntMightyHoldThreshold: 8, ntMightyShadowWeight: 1.5, ntAceLeadPriority: 1.2,
  ntVoidExploitWeight: 1.5, ntDeputyFeedChance: 0.8, ntEarlyLeadAggression: 0.7, ntLateGameSafety: 1.0,
  ntAceProtectLeadWeight: 1.5, ntSameTwoGuardWeight: 1.2, allyVoidExploitWeight: 1.0,
  deputyBluffWeight: 0.8, ntDeputyMightyHoldThreshold: 8, ntMightyEmergencyTrick: 5,
  napEarlyTrumpLeadWeight: 1.5, napEarlyTrumpLeadMaxTrick: 3, napEarlyTrumpMinCount: 4,
  deputyOvertrumpWeight: 1.8,
  bidTimeBudgetMs: 400, bidMaxSamples: 50, bidSafetyMargin: 0.4, bidSimCount: 30,
  planAccuracyWeight: 2.0, overbidPenalty: 2.0, underbidPenalty: 1.0, planAccuracyBonus: 2.0,
  winPointMap: [0, 2, 4, 6, 8, 10, 12, 14, 16, 18, 20],
  lossPointMap: [0, 2, 4, 5, 7, 9, 11, 13, 15, 17, 20],
  bidPacingMs: 4000, bidStartValue: 13,
  tossUpSafetyMargin: 0.4, tossUpSafetyMarginBottom: 0.2,
  signalS1Bonus: 1, signalS2Bonus: 2, signalThreeRoleBonus: 4, signalS3Bonus: 2,
  s1RequiredMinorCards: 2, s3RequiredAces: 2,
  sameColorBidderLimit: 2, ntBidderLimit: 2, s2ThreeRoleExtra: 1,
  goldenFormationBonus: 3.0, deputyOvertrumpPenalty: 4.0, lastSeatDuckBonus: 2.0,
  det_w_bid: 1.0, det_w_void: 3.0, det_w_follow: 0.5, det_w_feed: 1.0,
  oracleSamples: 200, oracleMctsTimeMs: 200,
  weightPlayQuality: 5.0, weightFeedSuccess: 3.0, weightSignalSuccess: 2.0,
  weightGoldenFormation: 1.0, weightPlanAccuracy: 3.0, weightBiddingQuality: 2.0,
  weightNapAttempts: 4.0, weightMatchQuality: 2.0, weightRoleWinRate: 2.0,
  weightOverkill: 2.0, weightDeputyOvertrump: 3.0, weightOpportunityLoss: 3.0, weightWastedAce: 1.0,
  voidStrategyWeight: 1.0, isolatedFaceDiscardBonus: 0.6, trumpCountForVoid: 5,
  lowBidVoidPenalty: 1.5, midBidVoidPenalty: 0.5, highBidVoidBonus: 0.8,
  voidLeadProbability: 0.55, cutTrickValue: 2.0, isolatedFaceThreshold: 2,
  ntVoidPenalty: 3.0, ntHighBidVoidBonus: 1.5,
  nnWeights: {
    bias: 0.0, handStrength: 0.5, trumpRemaining: 0.3, pointsNeeded: -0.4, trickNo: -0.2,
    isNap: 0.3, isDeputy: 0.1, isAlly: -0.1, hasMighty: 0.8
  },
  expHitWeight: 1.0, similarityThreshold: 5.0,
  bidRolloutRealPolicyRate: 1.0, bidRealPolicyMaxTrick: 10,
  playQualityFactor: 1.0, playQualitySamples: 0, playQualityWins: 0,
  bayesVoidWeight: 3.0, bayesFollowWeight: 0.5, bayesFeedWeight: 1.0,
  bayesBidWeight: 1.0, bayesDecay: 0.95, bayesPrior: 0.3,
  teamSignalStrength: 0.6, teamSignalDecay: 0.9, deputyInferWeight: 0.7,
  experienceBlendWeight: 0.4, experienceMinSamples: 3,
  endgameTrickThreshold: 3, endgameMaxCombinations: 100000,
  openingBookTricks: 3, openingBookMinSamples: 20, openingBookWeight: 0.5,
  allTakeRiskWeight: 1.5, allTakeLookaheadTricks: 3,
  sameTwoAggressiveLeadChance: 0.7,
  deputyCallSuitBonus: 0.5, deputyBidSuitBonus: 0.3,
  opponentArchetypeMix: 0.3,
  positionBonusLast: 0.3, positionBonusFirst: 0.2,
  bidSpeedFastThreshold: 500, bidSpeedSlowThreshold: 3000,
  bidSpeedBonusFast: 0.2, bidSpeedBonusSlow: -0.1,
  humanLogBlendWeight: 0.2,
  mctsRave: true, mctsRaveBias: 100,
  thinkTimeWeight: 0.3,
  elitismCount: 2, championStreak: 3, paretoMargin: 0.0,
  validationSplit: 0.2, significanceLevel: 0.05,
  minSamplesForPromotion: 100, minImprovementThreshold: 0.02,
  rollbackWindow: 5, learningRateEMA: 0.1, matchesPerGeneration: 10,
  banditUCBConstant: 1.414, mutationRate: 0.15, maxParamChangeRate: 0.1,
  metricWeightAvgValueLoss: 5.0, metricWeightEndgameAccuracy: 2.0,
  metricWeightOpeningAccuracy: 1.5, metricWeightSameTwoUtilization: 1.5,
  metricWeightTrumpEfficiency: 2.0, metricWeightVoidExploitSuccess: 1.5,
  metricWeightAllTakeAvoidance: 2.0, metricWeightOvertrickAvoidance: 1.5,
  metricWeightBidCalibration: 3.0, metricWeightBidGap: 2.5,
  metricWeightEarlyBidQuality: 2.0, metricWeightDeputyCallAccuracy: 2.5,
  metricWeightRoleAwareness: 1.5, metricWeightFeedSuccessRate: 2.0,
  metricWeightSignalCoherence: 1.0,
  normalizationValueLoss: 1.0, normalizationBidGap: 7.0, normalizationTrumpEfficiency: 2.0,
  metricMinSamples: 20, compositeScoreMethod: 'weightedSum',
  maxScoreImprovementPerGen: 0.15, maxMetricVariance: 0.3,
  napRoleThreshold1: 22, napRoleThreshold2: 17, napRoleThreshold3: 13,
  deputyRoleThreshold1: 12, deputyRoleThreshold2: 8, deputyRoleThreshold3: 5,
  supportLimitWeight: 0.7, supportLimitDivisor: 2,
  sameSuitRaiseBonus: 1.0, sameColorSupportBonus: 0.8,
  sameColorSameBidBonus: 0.5, crossColorCompeteBonus: 0.3,
  auctionObservationMs: 2000, auctionRiskTolerance: 0.5,
  bidStepwiseAggression: 0.6,
  weightBidGap: 3.0, weightBidAccuracy: 2.0, weightDeputySignal: 3.0,
  weightStageCount: 1.0, weightRoleAccuracy: 2.0,
});

export const sweetSpotFactor = (p) => {
  const target = 0.55, width = 0.4;
  return Math.exp(-Math.pow(p - target, 2) / (2 * Math.pow(width, 2)));
};

export const estimatedWinRate = (strength, num) => {
  const base = CALIBRATION[num] || 0.05;
  return Math.max(0.01, Math.min(0.99, base + (strength - 10) * 0.06));
};

export const findMaxHonestBid = (strength) => {
  let max = 12;
  for (let n = 13; n <= 20; n++) {
    if (estimatedWinRate(strength, n) >= 0.35) max = n;
  }
  return max;
};

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

export const matchRatingChanges = (matchScores, abandonedSeats = [], options = {}) => {
  const abandoned = new Set(Array.isArray(abandonedSeats) ? abandonedSeats : []);
  const forceBreak = options.forceBreakTie === true;

  const sorted = matchScores.map((s, i) => ({ score: s, seat: i }))
    .sort((a, b) => b.score - a.score || a.seat - b.seat);

  const results = Array(5).fill(null);
  let pos = 0;
  while (pos < 5) {
    let end = pos;
    while (end + 1 < 5 && sorted[end + 1].score === sorted[pos].score) end++;
    const ranks = [];
    for (let r = pos + 1; r <= end + 1; r++) ranks.push(r);
    const totalPts = ranks.reduce((sum, r) => sum + RATING_BASE[r], 0);
    const avgPts = totalPts / ranks.length;
    const displayRank = pos + 1;

    for (let i = pos; i <= end; i++) {
      const seat = sorted[i].seat;
      results[seat] = {
        delta: avgPts,
        placement: displayRank,
        tie: ranks.length > 1 ? { group: ranks.slice(), count: ranks.length } : null
      };
    }
    pos = end + 1;
  }

  return matchScores.map((s, i) => {
    const r = results[i];
    const isAbandoned = abandoned.has(i);
    const abandonPenalty = isAbandoned ? -30 : 0;
    const delta = r.delta + abandonPenalty;
    let outcome = 'loss';
    if (r.placement === 1) outcome = 'win';
    else if (r.placement === 2 || r.placement === 3) outcome = 'draw';
    if (isAbandoned) outcome = 'loss';

    return {
      outcome, delta,
      placement: r.placement,
      tie: forceBreak && r.tie ? { ...r.tie, broken: true } : r.tie,
      abandoned: isAbandoned,
      abandonPenalty, baseDelta: r.delta,
      breakdown: { rank: r.placement, rounds: [] }
    };
  });
};

export const hasBottomTie = (matchScores) => {
  const ranked = matchScores.map((s, i) => ({ s, i })).sort((a, b) => b.s - a.s || a.i - b.i);
  if (ranked.length < 5) return false;
  return ranked[3].s === ranked[4].s;
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
    score += won ? (2.0 + (num - 13) * 0.5) : -(0.5 + (num - 13) * 0.1);
    score += (takenPoints[seat] || 0) * 0.05;
  } else {
    score += !won ? (0.5 + (num - 13) * 0.1) : -1.5;
    score += (takenPoints[seat] || 0) * 0.05;
  }
  return Math.max(-3, Math.min(3, score)) * weight;
};

export const updateStrategyFromExperience = (baseParams, stats) => {
  const p = { ...baseParams };
  if (stats.aceHoldWins > 100 && stats.aceHoldWinRate > stats.acePlayWinRate + 0.05) p.safeAceWeight = Math.min(1.0, p.safeAceWeight + 0.1);
  else if (stats.acePlayWins > 100 && stats.acePlayWinRate > stats.aceHoldWinRate + 0.05) p.safeAceWeight = Math.max(0.1, p.safeAceWeight - 0.1);
  if (stats.highBidSuccessRate > 0.6 && stats.highBidAttempts > 50) p.bidThreshold = Math.max(1.5, p.bidThreshold - 0.1);
  else if (stats.highBidSuccessRate < 0.3 && stats.highBidAttempts > 50) p.bidThreshold = Math.min(5.0, p.bidThreshold + 0.1);
  return p;
};

export const isParetoImprovement = (newMetrics, oldMetrics, metricKeys = METRIC_KEYS, margin = 0.0) => {
  let hasImprovement = false;
  for (const key of metricKeys) {
    const newVal = Number(newMetrics[key]);
    const oldVal = Number(oldMetrics[key]);
    if (!Number.isFinite(newVal) || !Number.isFinite(oldVal)) continue;
    const direction = METRIC_DIRECTION[key];
    const improvement = direction ? (newVal - oldVal) : (oldVal - newVal);
    if (improvement < -margin) return false;
    if (improvement > margin) hasImprovement = true;
  }
  return hasImprovement;
};

export const computeCompositeScore = (metrics) => {
  let score = 0;
  let totalWeight = 0;
  for (const key of METRIC_KEYS) {
    const val = Number(metrics[key]);
    if (!Number.isFinite(val)) continue;
    const weight = METRIC_WEIGHTS[key] || 1.0;
    const direction = METRIC_DIRECTION[key];
    const normalized = direction ? Math.min(1, Math.max(0, val)) : Math.min(1, Math.max(0, 1 - val));
    score += normalized * weight;
    totalWeight += weight;
  }
  return totalWeight > 0 ? score / totalWeight : 0;
};

export const isStatisticallySignificant = (newScores, oldScores, alpha = 0.05) => {
  if (!Array.isArray(newScores) || !Array.isArray(oldScores)) return false;
  if (newScores.length < 5 || oldScores.length < 5) return false;
  const mean = arr => arr.reduce((s, v) => s + v, 0) / arr.length;
  const variance = arr => {
    const m = mean(arr);
    return arr.reduce((s, v) => s + (v - m) ** 2, 0) / (arr.length - 1);
  };
  const n1 = newScores.length, n2 = oldScores.length;
  const m1 = mean(newScores), m2 = mean(oldScores);
  const v1 = variance(newScores), v2 = variance(oldScores);
  if (v1 === 0 && v2 === 0) return m1 > m2;
  const se = Math.sqrt(v1 / n1 + v2 / n2);
  if (se === 0) return m1 > m2;
  const t = (m1 - m2) / se;
  const df = n1 + n2 - 2;
  const threshold = df < 30 ? 2.0 : df < 100 ? 1.70 : 1.66;
  return t > threshold;
};

export const sampleMean = (arr) => arr.length ? arr.reduce((s, v) => s + v, 0) / arr.length : 0;
export const sampleStd = (arr) => {
  if (arr.length < 2) return 0;
  const m = sampleMean(arr);
  return Math.sqrt(arr.reduce((s, v) => s + (v - m) ** 2, 0) / (arr.length - 1));
};

export const clampToBounds = (key, value) => {
  const bounds = PARAM_BOUNDS[key];
  if (!bounds) return value;
  return Math.max(bounds[0], Math.min(bounds[1], value));
};

export const PARAM_BOUNDS = {
  // 期待値目的関数
  W_WIN: [5.0, 30.0], W_POINTS: [0.5, 5.0], W_TRICKS: [0.1, 2.0], W_ALLTAKE: [10.0, 50.0],
  // 戦術prior
  W_MATCH: [0.5, 5.0], W_ANALYTIC: [1.0, 8.0], W_EXPERIENCE: [0.5, 5.0], W_RISK: [0.5, 5.0],
  priorTemperature: [0.3, 2.0], experienceBlendRatio: [0.0, 1.0],
  // 決定論MCTS
  mctsNodeBudget: [1000, 20000], useDeterministicSeed: [0.0, 1.0],
  // セイム2
  sameTwoThreatWeight: [0.5, 3.0], sameTwoRiskWeight: [0.5, 2.0], sameTwoResidualWeight: [0.3, 1.5],
  aCutRiskThreshold: [0.1, 0.9],  // ★ 拡張
  sameTwoAttackChance: [0.3, 0.8],
  sameTwoDefenseMargin: [0.1, 0.5], sameTwoTrumpBonus: [0.5, 3.0], sameTwoSideBonus: [0.3, 2.0],
  sameTwoTimingEarly: [0.5, 2.5], sameTwoTimingMid: [0.5, 2.0], sameTwoTimingLate: [0.3, 1.5],

  // 既存パラメータ
  bidThreshold: [2, 3.5], riskTolerance: [0.1, 1.0], leadAggression: [0.1, 1.0],
  followAggression: [0.1, 1.0], trumpBonus: [0.1, 2.0], mightyBonus: [0.5, 5.0],
  safeAceWeight: [0.1, 1.0], roleCardPreservation: [0.1, 1.0], deputyFeedBias: [0.1, 1.0],
  opponentInferenceWeight: [0.0, 1.0], suitConflictWeight: [0.0, 2.0],
  mightyShadowWeight: [0.0, 1.0], weakOpponentBoost: [0.0, 1.0], bluffLossMultiplier: [0.1, 2.0],
  cooperationBonus: [0.0, 1.0], ntPreference: [0.5, 1.5], ntSuitLengthBonus: [0.0, 3.0],
  ntAceWeight: [0.5, 3.0], ntMightyBonus: [1.0, 5.0], highBidNtThreshold: [13, 20],
  aceWeakSuitBonus: [0.0, 1.0], aceShortBonus: [0.0, 1.0], aceLongPenalty: [0.0, 1.0],
  sameTwoAceCounter: [0.0, 1.0], sameTwoShortBonus: [0.0, 1.0], sameTwoLongPenalty: [0.0, 1.0],
  sameTwoHighBidBonus: [0.0, 1.0], trumpExhaustionThreshold: [1, 10], baitModeWindow: [0, 10],
  baitMinTrumps: [1, 10], strongTrumpLeadAggression: [0.0, 1.0], aceCashUrgency: [0.0, 2.0],
  pointCardSafetyThreshold: [0.0, 1.0], tenHoldThreshold: [0.0, 1.0], nonTrumpAceWaiting: [0.0, 1.0],
  baitBackJWindow: [0, 10], baitBackJChance: [0.0, 1.0], faceCardOnNapWin: [0.0, 1.0],
  preserveNextStronger: [0.0, 1.0], deputyRevealUrgency: [0.0, 1.0], deputyCoverWeight: [0.0, 1.0],
  sameTwoDeputyBonus: [0.0, 1.0], allyFaceCardBonus: [0.0, 1.0], napWeaknessLeadWeight: [0.0, 2.0],
  trumpAvoidWeight: [0.0, 2.0], sameColorSuitAvoid: [0.0, 2.0], spadeLeadPriority: [0.0, 1.0],
  nonDeclaredSuitWeight: [0.0, 2.0], queenHoardWeight: [0.0, 2.0], sameTwoHoardWeight: [0.0, 2.0],
  allyYieldBonus: [0.0, 1.0], allySameTwoLeadChance: [0.0, 1.0], allySameTwoWindow: [0, 10],
  teamCooperationWeight: [0.0, 5.0], feedBonusWeight: [0.0, 3.0], overkillPenalty: [0.0, 3.0],
  mctsSimulations: [10, 2000], mctsExploration: [0.5, 2.0], handInferenceWeight: [0.0, 1.0],
  rolloutPolicyWeight: [0.0, 1.0], bayesUpdateRate: [0.01, 0.5],
  ntMightyHoldThreshold: [0, 9], ntMightyShadowWeight: [0.0, 3.0], ntAceLeadPriority: [0.5, 2.0],
  ntVoidExploitWeight: [0.5, 3.0], ntDeputyFeedChance: [0.0, 1.0], ntEarlyLeadAggression: [0.1, 1.0],
  ntLateGameSafety: [0.5, 2.0], ntAceProtectLeadWeight: [0.0, 3.0], ntSameTwoGuardWeight: [0.0, 3.0],
  allyVoidExploitWeight: [0.0, 2.0], deputyBluffWeight: [0.0, 1.0],
  ntDeputyMightyHoldThreshold: [3, 9], ntMightyEmergencyTrick: [3, 9],
  napEarlyTrumpLeadWeight: [0.0, 3.0], napEarlyTrumpLeadMaxTrick: [0, 5],
  napEarlyTrumpMinCount: [2, 8], deputyOvertrumpWeight: [0.0, 3.0],
  bidTimeBudgetMs: [100, 1500], bidMaxSamples: [20, 200], bidSafetyMargin: [0.5, 3.0], bidSimCount: [10, 100],
  planAccuracyWeight: [0.0, 3.0], overbidPenalty: [0.0, 5.0], underbidPenalty: [0.0, 2.0], planAccuracyBonus: [0.0, 3.0],
  bidPacingMs: [2000, 6000], bidStartValue: [13, 13],
  tossUpSafetyMargin: [0, 1], tossUpSafetyMarginBottom: [0, 1],
  signalS1Bonus: [0, 3], signalS2Bonus: [0, 4], signalThreeRoleBonus: [0, 6], signalS3Bonus: [0, 4],
  s1RequiredMinorCards: [1, 4], s3RequiredAces: [1, 4],
  sameColorBidderLimit: [1, 3], ntBidderLimit: [1, 3], s2ThreeRoleExtra: [1, 2],
  expHitWeight: [0.0, 2.0], similarityThreshold: [1.0, 10.0],
  bidRolloutRealPolicyRate: [0.8, 1.0], bidRealPolicyMaxTrick: [8, 10],
  goldenFormationBonus: [0.0, 5.0], deputyOvertrumpPenalty: [0.0, 5.0], lastSeatDuckBonus: [0.0, 5.0],
  det_w_bid: [0.0, 3.0], det_w_void: [1.0, 6.0], det_w_follow: [0.0, 2.0], det_w_feed: [0.0, 3.0],
  oracleSamples: [50, 500], oracleMctsTimeMs: [50, 500],
  weightPlayQuality: [0.0, 10.0], weightFeedSuccess: [0.0, 5.0], weightSignalSuccess: [0.0, 5.0],
  weightGoldenFormation: [0.0, 5.0], weightPlanAccuracy: [0.0, 5.0], weightBiddingQuality: [0.0, 5.0],
  weightNapAttempts: [0.0, 8.0], weightMatchQuality: [0.0, 5.0], weightRoleWinRate: [0.0, 5.0],
  weightOverkill: [0.0, 5.0], weightDeputyOvertrump: [0.0, 5.0], weightOpportunityLoss: [0.0, 5.0],
  weightWastedAce: [0.0, 3.0],
  voidStrategyWeight: [0.0, 2.0], isolatedFaceDiscardBonus: [0.0, 1.5], trumpCountForVoid: [3, 8],
  lowBidVoidPenalty: [0.5, 3.0], midBidVoidPenalty: [0.0, 1.5], highBidVoidBonus: [0.0, 2.0],
  voidLeadProbability: [0.3, 0.8], cutTrickValue: [1.0, 3.5], isolatedFaceThreshold: [1, 3],
  ntVoidPenalty: [1.0, 5.0], ntHighBidVoidBonus: [0.0, 3.0],
  napRoleThreshold1: [18, 26], napRoleThreshold2: [14, 20], napRoleThreshold3: [11, 15],
  deputyRoleThreshold1: [8, 16], deputyRoleThreshold2: [5, 11], deputyRoleThreshold3: [3, 7],
  supportLimitWeight: [0.4, 1.0], supportLimitDivisor: [1.5, 3.0],
  sameSuitRaiseBonus: [0.5, 1.5], sameColorSupportBonus: [0.3, 1.2],
  sameColorSameBidBonus: [0.2, 0.9], crossColorCompeteBonus: [0.1, 0.7],
  auctionObservationMs: [1000, 4000], auctionRiskTolerance: [0.2, 0.9],
  bidStepwiseAggression: [0.3, 1.0],
  weightBidGap: [0.0, 5.0], weightBidAccuracy: [0.0, 5.0], weightDeputySignal: [0.0, 5.0],
  weightStageCount: [0.0, 3.0], weightRoleAccuracy: [0.0, 5.0],
  playQualityFactor: [0.5, 1.2], playQualitySamples: [0, 10000], playQualityWins: [0, 10000],
  bayesVoidWeight: [1.0, 6.0], bayesFollowWeight: [0.0, 2.0], bayesFeedWeight: [0.0, 3.0],
  bayesBidWeight: [0.0, 3.0], bayesDecay: [0.8, 1.0], bayesPrior: [0.05, 0.6],
  teamSignalStrength: [0.1, 1.5], teamSignalDecay: [0.5, 1.0], deputyInferWeight: [0.0, 1.5],
  experienceBlendWeight: [0.0, 1.0], experienceMinSamples: [1, 20],
  endgameTrickThreshold: [1, 5], endgameMaxCombinations: [1000, 1000000],
  openingBookTricks: [0, 5], openingBookMinSamples: [5, 100], openingBookWeight: [0.0, 1.0],
  allTakeRiskWeight: [0.0, 3.0], allTakeLookaheadTricks: [1, 5],
  sameTwoAggressiveLeadChance: [0.0, 1.0],
  deputyCallSuitBonus: [0.0, 1.0], deputyBidSuitBonus: [0.0, 1.0],
  opponentArchetypeMix: [0.0, 1.0],
  positionBonusLast: [0.0, 1.0], positionBonusFirst: [0.0, 1.0],
  bidSpeedFastThreshold: [100, 2000], bidSpeedSlowThreshold: [1000, 8000],
  bidSpeedBonusFast: [0.0, 0.5], bidSpeedBonusSlow: [-0.5, 0.0],
  humanLogBlendWeight: [0.0, 1.0],
  mctsRaveBias: [10, 500],
  thinkTimeWeight: [0.0, 1.0],
  elitismCount: [1, 5], championStreak: [1, 10], paretoMargin: [0.0, 0.1],
  validationSplit: [0.1, 0.4], significanceLevel: [0.01, 0.10],
  minSamplesForPromotion: [30, 500], minImprovementThreshold: [0.0, 0.1],
  rollbackWindow: [2, 10], learningRateEMA: [0.05, 0.3],
  matchesPerGeneration: [5, 50], banditUCBConstant: [0.5, 2.0],
  mutationRate: [0.05, 0.3], maxParamChangeRate: [0.05, 0.3],
  metricWeightAvgValueLoss: [0.0, 10.0], metricWeightEndgameAccuracy: [0.0, 5.0],
  metricWeightOpeningAccuracy: [0.0, 5.0], metricWeightSameTwoUtilization: [0.0, 5.0],
  metricWeightTrumpEfficiency: [0.0, 5.0], metricWeightVoidExploitSuccess: [0.0, 5.0],
  metricWeightAllTakeAvoidance: [0.0, 5.0], metricWeightOvertrickAvoidance: [0.0, 5.0],
  metricWeightBidCalibration: [0.0, 5.0], metricWeightBidGap: [0.0, 5.0],
  metricWeightEarlyBidQuality: [0.0, 5.0], metricWeightDeputyCallAccuracy: [0.0, 5.0],
  metricWeightRoleAwareness: [0.0, 5.0], metricWeightFeedSuccessRate: [0.0, 5.0],
  metricWeightSignalCoherence: [0.0, 5.0],
  normalizationValueLoss: [0.5, 2.0], normalizationBidGap: [3.0, 10.0], normalizationTrumpEfficiency: [1.0, 5.0],
  metricMinSamples: [5, 100],
  maxScoreImprovementPerGen: [0.05, 0.5],
  maxMetricVariance: [0.1, 1.0],
};

export const mutateStrategy = (base, rate) => {
  const out = { ...base };
  for (const k of Object.keys(out)) {
    if (k === 'nnWeights') {
      out.nnWeights = { ...out.nnWeights };
      for (const nk of Object.keys(out.nnWeights)) if (Math.random() < 0.1) out.nnWeights[nk] += (Math.random() * 2 - 1) * rate * 0.5;
      continue;
    }
    if (k === 'lossPointMap' || k === 'winPointMap') {
      out[k] = [...out[k]];
      for (let i = 1; i < out[k].length; i++) {
        if (Math.random() < 0.1) {
          const delta = (Math.random() * 2 - 1) * rate;
          let val = out[k][i] + delta;
          const [min, max] = PARAM_BOUNDS[`${k}_${i}`] || [0, 20];
          val = Math.max(min, Math.min(max, val));
          out[k][i] = Math.round(val);
        }
      }
      continue;
    }
    if (typeof out[k] === 'boolean') continue;
    if (Math.random() < 0.1) {
      const delta = (Math.random() * 2 - 1) * rate;
      let val = out[k] * (1 + delta);
      if (PARAM_BOUNDS[k]) {
        const [min, max] = PARAM_BOUNDS[k];
        val = Math.max(min, Math.min(max, val));
      }
      out[k] = val;
    }
  }
  return out;
};

export const crossoverStrategy = (parentA, parentB) => {
  const child = { ...parentA };
  for (const k of Object.keys(parentA)) {
    if (k === 'nnWeights') {
      child.nnWeights = {};
      for (const nk of Object.keys(parentA.nnWeights)) child.nnWeights[nk] = Math.random() < 0.5 ? parentA.nnWeights[nk] : parentB.nnWeights[nk];
      continue;
    }
    if (k === 'lossPointMap' || k === 'winPointMap') {
      child[k] = parentA[k].map((v, i) => Math.random() < 0.5 ? v : parentB[k][i]);
      continue;
    }
    if (typeof parentA[k] === 'boolean') continue;
    if (Math.random() < 0.5) child[k] = parentB[k];
  }
  return child;
};

export const PLAY_FREE_SECONDS = 5;
export const PLAY_POOL_SECONDS = 20;
