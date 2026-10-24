export const SUITS = ['♣', '♦', '♥', '♠'];
export const RANKS = ['2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K', 'A'];
export const SV = { '♣': 1, '♦': 2, '♥': 3, '♠': 4, 'NT': 5 };
export const ELO_INIT = 1000;

export const CALIBRATION = { 13: 0.62, 14: 0.55, 15: 0.45, 16: 0.35, 17: 0.25, 18: 0.15, 19: 0.08, 20: 0.04 };
export const SWEET_SPOT_BONUS = 2.5;
export const HONEST_BID_FIXED_BONUS = 2.0;
export const ALLY_LOSS_PENALTY = -5;
export const ALLY_WIN_BONUS = 5;
export const ALLY_BLOCK_BONUS = 2; // ←これがなくてエラーになってました

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
  bidThreshold: 4.0, riskTolerance: 0.5, leadAggression: 0.6, followAggression: 0.4,
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
  sameTwoHoardWeight: 0.5, allyYieldBonus: 0.5, allySameTwoLeadChance: 0.55, allySameTwoWindow: 4
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

export const matchRatingChanges = (matchScores, matchArt, rates, matchStats, matchContracts) => {
   const sorted = matchScores.map((s, i) => ({ s, i })).sort((a, b) => b.s - a.s);
   return matchScores.map((s, i) => ({
     outcome: i === sorted[0].i ? 'win' : 'loss',
     delta: i === sorted[0].i ? 10 : -10,
     breakdown: { rank: i + 1, rounds: [] }
   }));
};

export const computeEloDelta = (myElo, oppElos, outcome) => {
   let expected = 0;
   for (const elo of oppElos) {
      expected += 1 / (1 + Math.pow(10, (elo - myElo) / 400));
   }
   expected /= oppElos.length;
   const score = outcome === 'win' ? 1 : 0;
   return Math.round(32 * (score - expected));
};

// --- ai-simulator.js 用のダミー定義（エラー防止） ---
export const PARAM_BOUNDS = {
  bidThreshold: [2, 6], riskTolerance: [0.1, 1.0], leadAggression: [0.2, 1.0],
  followAggression: [0.1, 1.0], trumpBonus: [0.1, 1.5], mightyBonus: [0.5, 3.0],
  safeAceWeight: [0.1, 1.0], roleCardPreservation: [0.1, 1.0], deputyFeedBias: [0.1, 1.0]
};
export const mutateStrategy = (base, rate) => {
  const out = { ...base };
  for (const k of Object.keys(out)) {
    if (Math.random() < 0.1) out[k] = out[k] * (1 + (Math.random() * 2 - 1) * rate);
  }
  return out;
};
export const rateRound = () => 0;
export const RANK_1_BONUS = 5;
export const RANK_2_BONUS = 2;
export const RANK_4_PENALTY = -2;
export const RANK_5_PENALTY = -5;
