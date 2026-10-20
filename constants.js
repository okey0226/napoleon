export const SUITS = ["♣", "♦", "♥", "♠"];
export const RANKS = ["2", "3", "4", "5", "6", "7", "8", "9", "10", "J", "Q", "K", "A"];
export const SV = { "♣": 1, "♦": 2, "♥": 3, "♠": 4, NT: 5 };

export const CALIBRATION = {
  13: 0.62, 14: 0.55, 15: 0.45, 16: 0.35,
  17: 0.25, 18: 0.15, 19: 0.08, 20: 0.04
};

// ========================================
// スイートスポット（v1.2: 下方シフト + 拡大）
// ========================================
export const SWEET_SPOT_TARGET = 0.50;
export const SWEET_SPOT_WIDTH = 0.55;
export const SWEET_SPOT_BONUS = 2.5;

// ========================================
// ブラフ判定
// ========================================
export const HONEST_THRESHOLD = 0.35;

// ========================================
// 立ち強度テーブル
// ========================================
export const BID_STRENGTH_TABLE = {
  13: 5.0, 14: 6.5, 15: 8.0, 16: 10.0,
  17: 12.0, 18: 14.0, 19: 16.0, 20: 18.0
};

export const STRENGTH_TO_WINRATE = 0.06;

// ========================================
// レート関連の新定数（v1.2）
// ========================================
export const HONEST_BID_FIXED_BONUS = 1.5;   // 勝敗無関係のhonest bid固定ボーナス
export const ALLY_LOSS_PENALTY = -0.9;       // NAP勝利時の連合軍ペナルティ（旧 -0.5）
export const ALLY_WIN_BONUS = 0.5;           // NAP敗北時の連合軍ボーナス
export const ALLY_BLOCK_BONUS = 0.3;         // NAP阻止ボーナス（napPts < num時）
export const RANK_1_BONUS = 1.5;             // 1位（旧 +0.5）
export const RANK_2_BONUS = 0.5;
export const RANK_4_PENALTY = -0.5;
export const RANK_5_PENALTY = -1.5;          // 5位（旧 -0.5）
export const ART_WEIGHT = 0.3;
export const ELO_K = 32;
export const ELO_INIT = 1000;

// ========================================
// パラメータ境界
// ========================================
export const PARAM_BOUNDS = {
  // --- 基礎 ---
  bidThreshold: [2.0, 6.0],
  riskTolerance: [0.1, 1.0],
  leadAggression: [0.2, 1.0],
  followAggression: [0.1, 1.0],
  trumpBonus: [0.2, 1.5],
  mightyBonus: [1.0, 3.0],
  safeAceWeight: [0.0, 1.0],
  roleCardPreservation: [0.0, 1.0],
  deputyFeedBias: [0.0, 1.0],

  // --- 競り: 相手推理（便乗）・ブラフ ---
  opponentInferenceWeight: [0.0, 1.5],
  suitConflictWeight: [0.2, 1.0],
  mightyShadowWeight: [0.0, 1.0],
  weakOpponentBoost: [0.0, 1.0],
  bluffLossMultiplier: [0.3, 1.5],
  cooperationBonus: [0.0, 1.0],

  // --- 競り: NT vs 色立ち ---
  ntPreference: [0.5, 1.5],
  ntSuitLengthBonus: [0.5, 3.0],
  ntAceWeight: [1.0, 3.0],
  ntMightyBonus: [2.0, 5.0],
  highBidNtThreshold: [14, 18],

  // --- 指名: A vs 2 判断 ---
  aceWeakSuitBonus: [0.0, 0.5],
  aceShortBonus: [0.0, 0.3],
  aceLongPenalty: [0.0, 0.3],
  sameTwoAceCounter: [0.0, 0.6],
  sameTwoShortBonus: [0.2, 0.6],
  sameTwoLongPenalty: [0.0, 0.5],
  sameTwoHighBidBonus: [0.0, 0.4],

  // --- ナポレオン打牌 ---
  trumpExhaustionThreshold: [2, 6],
  baitModeWindow: [1, 4],
  baitMinTrumps: [3, 6],
  strongTrumpLeadAggression: [0.3, 1.0],
  aceCashUrgency: [0.5, 2.0],
  pointCardSafetyThreshold: [0.3, 0.8],
  tenHoldThreshold: [0.3, 0.9],
  nonTrumpAceWaiting: [0.0, 1.0],
  baitBackJWindow: [1, 4],
  baitBackJChance: [0.0, 1.0],

  // --- 副官打牌 ---
  faceCardOnNapWin: [0.0, 1.0],
  preserveNextStronger: [0.5, 1.0],
  deputyRevealUrgency: [0.0, 1.0],
  deputyCoverWeight: [0.0, 1.0],
  sameTwoDeputyBonus: [0.0, 1.0],

  // --- 連合軍打牌 ---
  allyFaceCardBonus: [0.0, 1.0],
  napWeaknessLeadWeight: [0.0, 1.5],
  trumpAvoidWeight: [0.5, 1.0],
  sameColorSuitAvoid: [0.0, 1.0],
  spadeLeadPriority: [0.0, 1.0],
  nonDeclaredSuitWeight: [0.0, 1.0],
  queenHoardWeight: [0.0, 1.0],
  sameTwoHoardWeight: [0.0, 1.0],
  allyYieldBonus: [0.0, 1.0]
};

// ========================================
// デフォルト戦略
// ========================================
export function defaultStrategy() {
  return {
    bidThreshold: 4.0,
    riskTolerance: 0.5,
    leadAggression: 0.6,
    followAggression: 0.4,
    trumpBonus: 0.6,
    mightyBonus: 2.0,
    safeAceWeight: 0.7,
    roleCardPreservation: 0.6,
    deputyFeedBias: 0.5,

    opponentInferenceWeight: 0.4,
    suitConflictWeight: 0.6,
    mightyShadowWeight: 0.3,
    weakOpponentBoost: 0.3,
    bluffLossMultiplier: 0.6,
    cooperationBonus: 0.5,

    ntPreference: 1.0,
    ntSuitLengthBonus: 1.5,
    ntAceWeight: 2.0,
    ntMightyBonus: 3.5,
    highBidNtThreshold: 16,

    aceWeakSuitBonus: 0.3,
    aceShortBonus: 0.15,
    aceLongPenalty: 0.15,
    sameTwoAceCounter: 0.3,
    sameTwoShortBonus: 0.4,
    sameTwoLongPenalty: 0.25,
    sameTwoHighBidBonus: 0.2,

    trumpExhaustionThreshold: 3,
    baitModeWindow: 2,
    baitMinTrumps: 4,
    strongTrumpLeadAggression: 0.7,
    aceCashUrgency: 1.0,
    pointCardSafetyThreshold: 0.5,
    tenHoldThreshold: 0.6,
    nonTrumpAceWaiting: 0.5,
    baitBackJWindow: 3,
    baitBackJChance: 0.6,

    faceCardOnNapWin: 0.9,
    preserveNextStronger: 0.9,
    deputyRevealUrgency: 0.5,
    deputyCoverWeight: 0.5,
    sameTwoDeputyBonus: 0.5,

    allyFaceCardBonus: 0.9,
    napWeaknessLeadWeight: 0.8,
    trumpAvoidWeight: 0.9,
    sameColorSuitAvoid: 0.8,
    spadeLeadPriority: 0.7,
    nonDeclaredSuitWeight: 0.6,
    queenHoardWeight: 0.6,
    sameTwoHoardWeight: 0.5,
    allyYieldBonus: 0.5
  };
}

// ========================================
// 突然変異
// ========================================
export function mutateStrategy(base, rate = 0.12) {
  const out = { ...base };
  for (const [k, [lo, hi]] of Object.entries(PARAM_BOUNDS)) {
    if (Math.random() < rate) {
      const step = (hi - lo) * 0.08;
      out[k] = Math.max(lo, Math.min(hi, out[k] + (Math.random() - 0.5) * step * 2));
    }
  }
  return out;
}

// ========================================
// デッキ操作
// ========================================
export function shuffledDeck() {
  const d = [];
  for (const s of SUITS) for (const r of RANKS) d.push({ suit: s, rank: r, id: s + r });
  for (let i = d.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [d[i], d[j]] = [d[j], d[i]];
  }
  return d;
}

export function sortHand(h) {
  h.sort((a, b) => SV[b.suit] - SV[a.suit] || RANKS.indexOf(b.rank) - RANKS.indexOf(a.rank));
}

// ========================================
// スイートスポット・立ち評価
// ========================================
export function sweetSpotFactor(p) {
  const distance = Math.abs(p - SWEET_SPOT_TARGET);
  if (distance >= SWEET_SPOT_WIDTH) return 0;
  return 1 - distance / SWEET_SPOT_WIDTH;
}

export function estimatedWinRate(strength, num, calibrationOverride = null) {
  const base = calibrationOverride?.[num] ?? CALIBRATION[num];
  const threshold = BID_STRENGTH_TABLE[num] ?? 0;
  const delta = (strength - threshold) * STRENGTH_TO_WINRATE;
  return Math.max(0.05, Math.min(0.95, base + delta));
}

export function findMaxHonestBid(strength) {
  for (let num = 20; num >= 13; num--) {
    if (estimatedWinRate(strength, num) >= HONEST_THRESHOLD) return num;
  }
  return 12;
}

export function computeBluffGap(strength, num) {
  const maxHonest = findMaxHonestBid(strength);
  return Math.max(0, num - maxHonest);
}

export function strengthBucket(strength) {
  return Math.round(strength * 2);
}

// ========================================
// カラー系ヘルパー
// ========================================
export function isSameColorSuit(suit1, suit2) {
  const black = ['♣', '♠'];
  return black.includes(suit1) === black.includes(suit2);
}

export function sameColorSuitOf(trump) {
  if (trump === 'NT') return null;
  return SUITS.find(s => s !== trump && isSameColorSuit(s, trump));
}

// ========================================
// 共通レート計算（v1.2: 3実装を一本化）
// ai-simulator / worker / app すべてがこの関数を参照する
// ========================================
export function rateRound(seat, roundData, params = null, mult = 1) {
  const {
    nap, deputy, solo, num,
    won, points = 0, revealTrickNo = null,
    takenPoints = [0, 0, 0, 0, 0], strengthAtBid = 8
  } = roundData || {};
  const p = params || defaultStrategy();
  const safeStrength = Number.isFinite(strengthAtBid) ? strengthAtBid : 8;
  const winrate = estimatedWinRate(safeStrength, num);
  const diff = Math.max(0, num - 12) * Math.max(1, mult);
  const highBoost = 1 + 0.5 * Math.max(0, num - 17);
  const soloMult = solo ? 1.5 : 1.0;
  const maxHonest = findMaxHonestBid(safeStrength);
  const bluffGap = Math.max(0, num - maxHonest);
  const isHonest = bluffGap === 0;
  const bluffPenalty = p.bluffLossMultiplier ?? 0.6;

  let delta = 0;

  if (seat === nap) {
    if (won) {
      delta = ((1 - winrate) * diff * 8 + sweetSpotFactor(winrate) * SWEET_SPOT_BONUS * highBoost) * soloMult;
      if (points > num) delta -= (points - num) * 0.3;
    } else {
      delta = -winrate * diff * 8 * soloMult;
      if (!isHonest) delta -= bluffGap * bluffPenalty * 2;
    }
    if (isHonest) delta += HONEST_BID_FIXED_BONUS;
  } else if (!solo && seat === deputy) {
    delta = ((won ? 1 : 0) - winrate) * diff * 3.2;
    if (won && revealTrickNo != null) delta += Math.max(0, revealTrickNo - 3) * 0.3;
  } else {
    const napPts = (takenPoints[nap] || 0) + (solo ? 0 : (takenPoints[deputy] || 0));
    delta = (won ? ALLY_LOSS_PENALTY : ALLY_WIN_BONUS) + (napPts < num ? ALLY_BLOCK_BONUS : 0);
  }

  return Number.isFinite(delta) ? delta : 0;
}

// ========================================
// マッチ全体のレートΔ計算
// scores/art は席順、contracts は各局の結果配列
// ========================================
export function matchRatingChanges(scores, art, ratings, matchStats, contracts, paramsList = null) {
  const meanArt = (art || []).reduce((n, x) => n + x, 0) / 5;
  const cs = contracts || [];
  return scores.map((score, seat) => {
    let delta = 0;
    const rounds = [];
    for (const c of cs) {
      const params = (paramsList && paramsList[seat]) || defaultStrategy();
      const roundDelta = rateRound(seat, {
        nap: c.nap, deputy: c.deputy, solo: !!c.solo, num: c.num,
        won: !!c.napWin, points: c.points || 0,
        revealTrickNo: c.revealTrickNo ?? null,
        takenPoints: c.takenPoints || [0, 0, 0, 0, 0],
        strengthAtBid: c.strengthAtBid ?? 8
      }, params, c.mult || 1);
      delta += roundDelta;
      const role = seat === c.nap ? 'nap' : (!c.solo && seat === c.deputy ? 'dep' : 'ally');
      rounds.push({ bid: c.num, role, delta: Math.round(roundDelta * 100) / 100 });
    }
    delta += (art[seat] - meanArt) * ART_WEIGHT;
    const rank = 1 + scores.filter(x => x > score).length;
    if (rank === 1) delta += RANK_1_BONUS;
    else if (rank === 2) delta += RANK_2_BONUS;
    else if (rank === 4) delta += RANK_4_PENALTY;
    else if (rank === 5) delta += RANK_5_PENALTY;
    const outcome = rank <= 2 ? 'win' : rank >= 4 ? 'loss' : 'draw';
    return {
      seat,
      delta: Math.round(delta * 10) / 10,
      placement: rank,
      art: art[seat] - meanArt,
      outcome,
      breakdown: { rounds, rank }
    };
  });
}

// ========================================
// Elo（スキルレート）: K=32, 標準Elo式
// ========================================
export function computeEloDelta(playerElo, opponentElos, outcome) {
  if (!opponentElos || !opponentElos.length) return 0;
  const oppAvg = opponentElos.reduce((s, e) => s + e, 0) / opponentElos.length;
  const expected = 1 / (1 + Math.pow(10, (oppAvg - playerElo) / 400));
  const actual = outcome === 'win' ? 1 : outcome === 'loss' ? 0 : 0.5;
  return Math.round(ELO_K * (actual - expected));
}
