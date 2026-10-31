// constants.js (完全版)
export const SUITS = ['♣', '♦', '♥', '♠'];
export const RANKS = ['2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K', 'A'];
export const SV = { '♣': 1, '♦': 2, '♥': 3, '♠': 4, 'NT': 5 };
export const ELO_INIT = 1000;

export const CALIBRATION = { 13: 0.62, 14: 0.55, 15: 0.45, 16: 0.35, 17: 0.25, 18: 0.15, 19: 0.08, 20: 0.04 };
export const SWEET_SPOT_BONUS = 2.5;
export const HONEST_BID_FIXED_BONUS = 2.0;
export const ALLY_LOSS_PENALTY = -5;
export const ALLY_WIN_BONUS = 5;
export const ALLY_BLOCK_BONUS = 2;

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
  bidThreshold: 6.0, riskTolerance: 0.5, leadAggression: 0.6, followAggression: 0.4,
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
  // NT特殊戦略
  ntAceProtectLeadWeight: 1.5, ntSameTwoGuardWeight: 1.2, allyVoidExploitWeight: 1.0,
  deputyBluffWeight: 0.8, ntDeputyMightyHoldThreshold: 8, ntMightyEmergencyTrick: 5,
  // ナポレオンの序盤切り札リード
  napEarlyTrumpLeadWeight: 1.5, napEarlyTrumpLeadMaxTrick: 3, napEarlyTrumpMinCount: 4,
  // 副官のオーバートランプ
  deputyOvertrumpWeight: 1.8,
  // ビッドシミュレーション（PIMC）
  bidTimeBudgetMs: 400, bidMaxSamples: 500, bidSafetyMargin: 1.5, bidSimCount: 30,
  // 計画精度評価（自己対戦学習用）
  planAccuracyWeight: 1.0, overbidPenalty: 2.0, underbidPenalty: 0.5, planAccuracyBonus: 1.5,
  nnWeights: {
    bias: 0.0, handStrength: 0.5, trumpRemaining: 0.3, pointsNeeded: -0.4, trickNo: -0.2,
    isNap: 0.3, isDeputy: 0.1, isAlly: -0.1, hasMighty: 0.8
  }
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
    score += won ? (1.5 + (num - 13) * 0.15) : -(0.8 + (num - 13) * 0.1);
    score += (takenPoints[seat] || 0) * 0.05;
  } else {
    score += !won ? (0.8 + (num - 13) * 0.1) : -1.2;
    score += (takenPoints[seat] || 0) * 0.05;
  }
  return Math.max(-3, Math.min(3, score)) * weight;
};

export const PARAM_BOUNDS = {
  bidThreshold: [2, 10], riskTolerance: [0.1, 1.0], leadAggression: [0.1, 1.0],
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
  mctsSimulations: [10, 1000], mctsExploration: [0.5, 2.0], handInferenceWeight: [0.0, 1.0],
  rolloutPolicyWeight: [0.0, 1.0], bayesUpdateRate: [0.01, 0.5],
  ntMightyHoldThreshold: [0, 9], ntMightyShadowWeight: [0.0, 3.0], ntAceLeadPriority: [0.5, 2.0],
  ntVoidExploitWeight: [0.5, 3.0], ntDeputyFeedChance: [0.0, 1.0], ntEarlyLeadAggression: [0.1, 1.0],
  ntLateGameSafety: [0.5, 2.0],
  ntAceProtectLeadWeight: [0.0, 3.0], ntSameTwoGuardWeight: [0.0, 3.0],
  allyVoidExploitWeight: [0.0, 2.0], deputyBluffWeight: [0.0, 1.0],
  ntDeputyMightyHoldThreshold: [3, 9], ntMightyEmergencyTrick: [3, 9],
  napEarlyTrumpLeadWeight: [0.0, 3.0], napEarlyTrumpLeadMaxTrick: [0, 5],
  napEarlyTrumpMinCount: [2, 8], deputyOvertrumpWeight: [0.0, 3.0],
  bidTimeBudgetMs: [100, 1000], bidMaxSamples: [50, 1000], bidSafetyMargin: [0.5, 3.0], bidSimCount: [10, 100],
  planAccuracyWeight: [0.0, 3.0], overbidPenalty: [0.0, 5.0],
  underbidPenalty: [0.0, 2.0], planAccuracyBonus: [0.0, 3.0]
};

export const mutateStrategy = (base, rate) => {
  const out = { ...base };
  for (const k of Object.keys(out)) {
    if (k === 'nnWeights') {
      out.nnWeights = { ...out.nnWeights };
      for (const nk of Object.keys(out.nnWeights)) {
        if (Math.random() < 0.1) out.nnWeights[nk] += (Math.random() * 2 - 1) * rate * 0.5;
      }
      continue;
    }
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
      for (const nk of Object.keys(parentA.nnWeights)) {
        child.nnWeights[nk] = Math.random() < 0.5 ? parentA.nnWeights[nk] : parentB.nnWeights[nk];
      }
      continue;
    }
    if (Math.random() < 0.5) child[k] = parentB[k];
  }
  return child;
};

export const RANK_1_BONUS = 25;
export const RANK_2_BONUS = 5;
export const RANK_4_PENALTY = -5;
export const RANK_5_PENALTY = -25;
