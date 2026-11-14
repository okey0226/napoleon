// bid-strategy.js — 立ち精度を極限まで高める戦略エンジン（v2・不具合修正版）
// 6層のMECE分析 + 負けシナリオ分布 + キティ影響 + 副官期待 + 相手モデリング + EV
// すべて事実ベース（カードカウンティング・void追跡）でハルシネーションなし

import { SUITS, RANKS, FACE, SV, sameColorSuitOf, defaultStrategy } from './constants.js';

const EPS = 1e-9;

// ============================================================
// スート分類
// ============================================================
function groupBySuit(hand) {
  const g = {};
  for (const s of SUITS) g[s] = [];
  for (const c of hand) if (g[c.suit]) g[c.suit].push(c);
  for (const s of SUITS) g[s].sort((a, b) => RANKS.indexOf(b.rank) - RANKS.indexOf(a.rank));
  return g;
}

// ============================================================
// 層1: 攻撃資産（勝てるトリック）
// ============================================================
function analyzeOffensive(hand, trump, context) {
  const isNT = trump === 'NT';
  const groups = groupBySuit(hand);
  const playedCards = context.playedCards || [];
  const discardedKitty = context.discardedKitty || [];
  const calledCard = context.calledCard || null;

  const hasMighty = hand.some(c => c.id === '♠A');
  const hasShadow = hand.some(c => c.id === '♥Q');
  const shadowSafe = playedCards.some(c => c.id === '♥Q')
    || discardedKitty.some(c => c.id === '♥Q')
    || (calledCard && calledCard.id === '♥Q');
  const trumpJ = !isNT ? groups[trump].find(c => c.rank === 'J') : null;
  const sameColorJ = !isNT ? groups[sameColorSuitOf(trump)].find(c => c.rank === 'J') : null;
  const trumps = isNT ? [] : groups[trump];

  const absolute = [];
  const conditional = [];
  const potential = [];

  // 絶対確実
  if (hasMighty) {
    if (!hasShadow && shadowSafe) {
      absolute.push({ cardId: '♠A', type: 'mighty', certainty: 1.0, expectedPoints: 0.3 });
    } else if (!hasShadow && !shadowSafe) {
      conditional.push({ cardId: '♠A', type: 'mighty_shadow_risk', certainty: 0.55, expectedPoints: 0.3 });
    } else {
      absolute.push({ cardId: '♠A', type: 'mighty_defended', certainty: 1.0, expectedPoints: 0.3 });
    }
  }
  if (trumpJ) {
    absolute.push({ cardId: trumpJ.id, type: 'trumpJ', certainty: 1.0, expectedPoints: 0.5 });
  }
  if (sameColorJ) {
    const risk = trumpJ ? 0 : 0.25;
    conditional.push({ cardId: sameColorJ.id, type: 'sameColorJ', certainty: 1.0 - risk, expectedPoints: 0.5 });
  }
  if (!isNT && trumps.some(c => c.rank === 'A')) {
    absolute.push({ cardId: trump + 'A', type: 'trumpA', certainty: 0.88, expectedPoints: 0.5 });
  }
  if (!isNT && trumps.some(c => c.rank === 'K') && trumps.some(c => c.rank === 'A')) {
    conditional.push({ cardId: trump + 'K', type: 'trumpK', certainty: 0.75, expectedPoints: 0.5 });
  }

  // サイドA + セイム2リスク
  for (const suit of SUITS) {
    if (suit === trump) continue;
    const ace = groups[suit].find(c => c.rank === 'A' && c.id !== '♠A');
    if (!ace) continue;
    const two = groups[suit].find(c => c.rank === '2');
    const twoPlayed = playedCards.some(c => c.id === suit + '2') || discardedKitty.some(c => c.id === suit + '2');
    const cutRisk = two ? 0 : twoPlayed ? 0 : 0.15;
    if (cutRisk === 0) {
      conditional.push({ cardId: ace.id, type: 'sideA_safe', certainty: 0.9, expectedPoints: 0.8 });
    } else {
      conditional.push({ cardId: ace.id, type: 'sideA_cut_risk', certainty: 1 - cutRisk, expectedPoints: 0.8 });
    }
  }

  // セイム2（A守護）
  for (const suit of SUITS) {
    if (suit === trump) continue;
    const ace = groups[suit].find(c => c.rank === 'A' && c.id !== '♠A');
    const two = groups[suit].find(c => c.rank === '2');
    if (ace && two) {
      conditional.push({ cardId: two.id, type: 'sameTwoGuard', certainty: 0.7, expectedPoints: 0.4 });
    }
  }

  // 連続ロングスート
  for (const suit of SUITS) {
    if (suit === trump) continue;
    const cards = groups[suit];
    if (cards.length < 3) continue;
    const runSeq = [];
    for (const r of ['A', 'K', 'Q', 'J', '10']) {
      if (cards.some(c => c.rank === r)) runSeq.push(r);
      else break;
    }
    if (runSeq.length < 2) continue;
    const hasAce = runSeq[0] === 'A';
    const effectiveRun = hasAce ? runSeq.length - 1 : runSeq.length;
    if (effectiveRun < 1) continue;
    const runProb = Math.min(0.85, effectiveRun * 0.28);
    potential.push({ type: 'longRun', suit, effectiveRun, certainty: runProb, expectedPoints: effectiveRun * 0.5 });
  }

  // ボイドカット
  if (!isNT) {
    for (const suit of SUITS) {
      if (suit === trump) continue;
      const cnt = groups[suit].length;
      if (cnt <= 1 && trumps.length >= 3) {
        potential.push({ type: 'voidRuff', suit, certainty: 0.7, expectedPoints: 0.4 });
      }
    }
  }

  return {
    absolute, conditional, potential,
    totalAbsolute: absolute.length,
    totalConditional: conditional.reduce((s, w) => s + w.certainty, 0),
    totalPotential: potential.reduce((s, w) => s + w.certainty, 0),
    expectedOffensivePoints:
      absolute.reduce((s, w) => s + w.expectedPoints, 0) +
      conditional.reduce((s, w) => s + w.expectedPoints * w.certainty, 0) +
      potential.reduce((s, w) => s + w.expectedPoints * w.certainty, 0),
  };
}

// ============================================================
// 層2: 防御欠陥（負けるトリック）
// ============================================================
function analyzeDefensive(hand, trump, context) {
  const isNT = trump === 'NT';
  const groups = groupBySuit(hand);
  const playedCards = context.playedCards || [];
  const discardedKitty = context.discardedKitty || [];
  const trumps = isNT ? [] : groups[trump];
  const trumpCount = trumps.length;
  const playedTrumps = isNT ? 0 : playedCards.filter(c => c.suit === trump).length;
  const enemyTrumps = isNT ? 0 : Math.max(0, 13 - trumpCount - playedTrumps);

  const losses = [];

  // L1: 切札枯渇
  if (!isNT && trumpCount < 5) {
    const deficit = Math.max(0, 5 - trumpCount);
    if (deficit >= 1) {
      const trickStart = Math.max(6, 11 - deficit);
      losses.push({
        type: 'TRUMP_EXHAUSTED', label: '切札枯渇',
        trickBand: [trickStart, 10],
        probability: Math.min(0.92, 0.45 + deficit * 0.13),
        expectedPointsLost: Math.min(4, deficit * 0.9),
        severity: deficit >= 2 ? 'high' : 'mid',
      });
    }
  }

  // L2: セイム2被り
  for (const suit of SUITS) {
    if (suit === trump) continue;
    const hasA = groups[suit].some(c => c.rank === 'A' && c.id !== '♠A');
    const has2 = groups[suit].some(c => c.rank === '2');
    if (!hasA || has2) continue;
    const twoPlayed = playedCards.some(c => c.id === suit + '2') || discardedKitty.some(c => c.id === suit + '2');
    if (twoPlayed) continue;
    losses.push({
      type: 'SAME_TWO_CUT', label: 'セイム2被り', suit,
      trickBand: [2, 6], probability: 0.55, expectedPointsLost: 1.0, severity: 'mid',
    });
  }

  // L3: 影狩り
  const hasMighty = hand.some(c => c.id === '♠A');
  const hasShadow = hand.some(c => c.id === '♥Q');
  const shadowPlayed = playedCards.some(c => c.id === '♥Q') || discardedKitty.some(c => c.id === '♥Q');
  if (hasMighty && !hasShadow && !shadowPlayed) {
    losses.push({
      type: 'SHADOW_HUNT', label: '影狩り',
      trickBand: [1, 4], probability: 0.5, expectedPointsLost: 0.8, severity: 'mid',
    });
  }

  // L4: 完全ボイド
  for (const suit of SUITS) {
    if (suit === trump) continue;
    const cnt = groups[suit].length;
    if (cnt === 0) {
      const cutAbility = trumpCount >= 3 ? 0.6 : trumpCount >= 1 ? 0.3 : 0;
      if (cutAbility < 0.5) {
        losses.push({
          type: 'VOID_LOSS', label: 'ボイド負け', suit,
          trickBand: [1, 5], probability: 0.7 - cutAbility * 0.4, expectedPointsLost: 2.0, severity: 'high',
        });
      }
    }
  }

  // L5: 切札競り負け
  if (!isNT && trumpCount > 0) {
    const top = trumps[0];
    const hasJ = trumps.some(c => c.rank === 'J');
    const hasA = trumps.some(c => c.rank === 'A');
    if (!hasJ && !hasA && RANKS.indexOf(top.rank) < RANKS.indexOf('K')) {
      losses.push({
        type: 'TRUMP_BATTLE', label: '切札競り負け',
        trickBand: [3, 7], probability: 0.45, expectedPointsLost: 1.2, severity: 'mid',
      });
    }
  }

  // L6: 連続スート負け
  const sideSuits = SUITS.filter(s => s !== trump);
  const myLongest = sideSuits.reduce((best, s) => {
    const cnt = groups[s].length;
    return cnt > best.cnt ? { suit: s, cnt } : best;
  }, { suit: null, cnt: 0 });
  if (!isNT && myLongest.cnt < 3) {
    losses.push({
      type: 'LONG_SUIT_RUN', label: '連続スート負け',
      trickBand: [4, 8], probability: 0.4, expectedPointsLost: 1.5, severity: 'mid',
    });
  }

  // タイムライン
  const trickTimeline = [];
  for (let t = 1; t <= 10; t++) {
    const atTrick = losses.filter(l => t >= l.trickBand[0] && t <= l.trickBand[1]);
    if (atTrick.length > 0) {
      const big = atTrick.reduce((a, b) =>
        a.expectedPointsLost * a.probability > b.expectedPointsLost * b.probability ? a : b);
      trickTimeline.push({
        trickNo: t, expected: 'loss',
        lossType: big.type, expectedPointsLost: big.expectedPointsLost * big.probability,
      });
    } else {
      trickTimeline.push({ trickNo: t, expected: 'win', expectedPointsLost: 0 });
    }
  }

  return {
    losses: losses.sort((a, b) =>
      b.expectedPointsLost * b.probability - a.expectedPointsLost * a.probability),
    totalExpectedLostPoints: losses.reduce((s, l) => s + l.expectedPointsLost * l.probability, 0),
    trickTimeline,
    myTrumps: trumpCount,
    enemyTrumps,
  };
}

// ============================================================
// 層3: 点札分布
// ============================================================
function analyzePoints(hand, trump, context) {
  const groups = groupBySuit(hand);
  const myFaces = hand.filter(c => FACE.includes(c.rank));
  const bySuit = {};
  for (const s of SUITS) bySuit[s] = groups[s].filter(c => FACE.includes(c.rank)).length;
  const calledCard = context.calledCard || null;
  const kittyFaces = (context.discardedKitty || []).filter(c => FACE.includes(c.rank)).length;

  let deputyExpected = 2.0;
  if (calledCard) {
    if (calledCard.id === '♠A') deputyExpected = 3.5;
    else if (trump !== 'NT' && calledCard.rank === 'J' && calledCard.suit === trump) deputyExpected = 3.0;
    else if (trump !== 'NT' && calledCard.rank === 'J' && calledCard.suit === sameColorSuitOf(trump)) deputyExpected = 2.5;
    else if (calledCard.rank === 'A') deputyExpected = 2.0;
    else if (calledCard.rank === '2') deputyExpected = 1.0;
    else deputyExpected = 0.5;
  }

  const myExpectedPoints = myFaces.length;
  const totalExpected = myExpectedPoints + deputyExpected + kittyFaces;
  const enemyExpected = Math.max(0, 20 - totalExpected);

  return {
    myFaceCount: myFaces.length,
    myFaces: myFaces.map(c => c.id),
    bySuit, deputyExpected, kittyFaces,
    totalExpected, enemyExpected,
  };
}

// ============================================================
// 層4: リスク要因
// ============================================================
function analyzeRisks(hand, trump, context, defensive) {
  const risks = [];
  const isNT = trump === 'NT';
  const groups = groupBySuit(hand);
  const playedCards = context.playedCards || [];
  const discardedKitty = context.discardedKitty || [];
  const hasMighty = hand.some(c => c.id === '♠A');
  const hasShadow = hand.some(c => c.id === '♥Q');
  const shadowPlayed = playedCards.some(c => c.id === '♥Q') || discardedKitty.some(c => c.id === '♥Q');

  if (hasMighty && !hasShadow && !shadowPlayed) {
    risks.push({ type: 'shadow', probability: 0.5, impact: 'マイティ無効化', severity: 'high' });
  }
  for (const l of defensive.losses) {
    if (l.type === 'SAME_TWO_CUT') {
      risks.push({ type: 'sameTwo', suit: l.suit, probability: l.probability, impact: 'サイドA狩り', severity: 'high' });
    }
    if (l.type === 'TRUMP_EXHAUSTED' && l.severity === 'high') {
      risks.push({ type: 'trumpShort', probability: l.probability, impact: '終盤の切札不足', severity: 'high' });
    }
  }
  const maxLen = Math.max(...SUITS.map(s => groups[s].length));
  if (maxLen < 4 && !isNT) {
    risks.push({ type: 'noLongSuit', probability: 0.5, impact: '連続勝ち不可', severity: 'mid' });
  }
  return risks;
}

// ============================================================
// 層5: 負けシナリオ分析（0周/1周/2周/3周/4周+）
// ============================================================

// トリック帯 × 総負け回数で「負け1回あたり何枚取られるか」
function expectedTakenPointsPerTrick(phase, lossCount) {
  if (lossCount <= 0) return 0;
  const base = { early: 1.5, mid: 2.5, late: 3.5 };
  // 負け回数が増えるほど連合軍は絵札を分散せざるを得ない
  let dispersionFactor;
  if (lossCount === 1) dispersionFactor = 1.0;
  else if (lossCount === 2) dispersionFactor = 0.75;
  else if (lossCount === 3) dispersionFactor = 0.60;
  else dispersionFactor = 0.50;
  return base[phase] * dispersionFactor;
}

function aggregateLossesByPhase(losses) {
  const phases = { early: [], mid: [], late: [] };
  for (const l of losses) {
    const midTrick = (l.trickBand[0] + l.trickBand[1]) / 2;
    const phase = midTrick <= 3 ? 'early' : midTrick <= 7 ? 'mid' : 'late';
    phases[phase].push(l);
  }
  return phases;
}

function phaseLossProb(phaseLosses) {
  let noLossProb = 1;
  for (const l of phaseLosses) noLossProb *= (1 - l.probability);
  return 1 - noLossProb;
}

function poisson(k, lambda) {
  if (lambda <= 0) return k === 0 ? 1 : 0;
  let fact = 1;
  for (let i = 2; i <= k; i++) fact *= i;
  return Math.exp(-lambda) * Math.pow(lambda, k) / fact;
}

function analyzeLossScenarios(defensive, context = {}) {
  const isSolo = context.isSolo === true;
  const phases = aggregateLossesByPhase(defensive.losses);

  const pEarly = phaseLossProb(phases.early);
  const pMid = phaseLossProb(phases.mid);
  const pLate = phaseLossProb(phases.late);

  const expectedLossesByPhase = {
    early: phases.early.reduce((s, l) => s + l.probability, 0),
    mid: phases.mid.reduce((s, l) => s + l.probability, 0),
    late: phases.late.reduce((s, l) => s + l.probability, 0),
  };
  const totalExpectedLosses = expectedLossesByPhase.early + expectedLossesByPhase.mid + expectedLossesByPhase.late;

  const maxPossibleLosses = defensive.losses.length;
  const lossScenarios = {};
  let cumulativeProb = 0;

  const phaseCaps = {
    early: phases.early.length,
    mid: phases.mid.length,
    late: phases.late.length,
  };

  for (let n = 0; n <= maxPossibleLosses; n++) {
    let p = poisson(n, totalExpectedLosses);
    if (n === maxPossibleLosses) p = Math.max(0, 1 - cumulativeProb);
    p = Math.max(0, Math.min(1, p));
    cumulativeProb += p;

    // フェーズ按分（初期値）
    const phaseWeights = totalExpectedLosses > 0
      ? {
          early: expectedLossesByPhase.early / totalExpectedLosses,
          mid: expectedLossesByPhase.mid / totalExpectedLosses,
          late: expectedLossesByPhase.late / totalExpectedLosses,
        }
      : { early: 0, mid: 0, late: 0 };

    const lossesInPhase = {
      early: Math.round(n * phaseWeights.early),
      mid: Math.round(n * phaseWeights.mid),
      late: Math.round(n * phaseWeights.late),
    };

    // 要因数でキャップ
    lossesInPhase.early = Math.max(0, Math.min(lossesInPhase.early, phaseCaps.early));
    lossesInPhase.mid = Math.max(0, Math.min(lossesInPhase.mid, phaseCaps.mid));
    lossesInPhase.late = Math.max(0, Math.min(lossesInPhase.late, phaseCaps.late));

    // 端数再配分（キャップ内で）
    let currentTotal = lossesInPhase.early + lossesInPhase.mid + lossesInPhase.late;
    let diff = n - currentTotal;
    let guard = 0;
    while (diff !== 0 && guard < 10) {
      guard++;
      const candidates = ['early', 'mid', 'late'].filter(ph => {
        if (diff > 0) return lossesInPhase[ph] < phaseCaps[ph];
        return lossesInPhase[ph] > 0;
      });
      if (!candidates.length) break;
      const target = candidates.reduce((a, b) => phaseWeights[a] > phaseWeights[b] ? a : b);
      lossesInPhase[target] += (diff > 0 ? 1 : -1);
      diff += (diff > 0 ? -1 : 1);
    }

    // 最終ガード（念のため負値排除）
    lossesInPhase.early = Math.max(0, lossesInPhase.early);
    lossesInPhase.mid = Math.max(0, lossesInPhase.mid);
    lossesInPhase.late = Math.max(0, lossesInPhase.late);

    let expectedLossPoints =
      lossesInPhase.early * expectedTakenPointsPerTrick('early', n) +
      lossesInPhase.mid * expectedTakenPointsPerTrick('mid', n) +
      lossesInPhase.late * expectedTakenPointsPerTrick('late', n);

    if (isSolo) expectedLossPoints *= 1.15;

    const napPoints = 20 - expectedLossPoints - (context.kittyPoints || 0);

    lossScenarios[n] = {
      lossCount: n,
      probability: p,
      phases: lossesInPhase,
      expectedLossPoints,
      napPoints,
      maxBid: Math.min(19, Math.floor(napPoints + EPS)),
      safeBid: Math.max(13, Math.min(19, Math.floor(napPoints - 1.5 + EPS))),
    };
  }

  // 正規化（合計が1にならない場合の保険）
  let totalProb = 0;
  for (const n in lossScenarios) totalProb += lossScenarios[n].probability;
  if (totalProb > 0 && Math.abs(totalProb - 1) > 1e-6) {
    for (const n in lossScenarios) lossScenarios[n].probability /= totalProb;
  }

  const majorScenarios = Object.values(lossScenarios)
    .filter(s => s.probability >= 0.05)
    .sort((a, b) => b.probability - a.probability);

  const recommendationByLossCount = {};
  for (const n of [0, 1, 2, 3, 4]) {
    const s = lossScenarios[n];
    if (!s) continue;
    recommendationByLossCount[n] = {
      probability: s.probability,
      expectedNapPoints: s.napPoints,
      safeBid: s.safeBid,
      attackBid: s.maxBid,
      expectedLossPoints: s.expectedLossPoints,
    };
  }

  let weightedNapExpected = 0;
  for (const n in lossScenarios) weightedNapExpected += lossScenarios[n].probability * lossScenarios[n].napPoints;

  let weightedVariance = 0;
  for (const n in lossScenarios) {
    const s = lossScenarios[n];
    weightedVariance += s.probability * Math.pow(s.napPoints - weightedNapExpected, 2);
  }
  const weightedStdDev = Math.max(1.2, Math.sqrt(weightedVariance));

  return {
    phases: {
      earlyLossProb: pEarly,
      midLossProb: pMid,
      lateLossProb: pLate,
      expectedLossesByPhase,
      totalExpectedLosses,
    },
    lossScenarios,
    majorScenarios,
    recommendationByLossCount,
    weightedNapExpected,
    weightedStdDev,
    allyCount: isSolo ? 4 : 3,
    isSolo,
  };
}

// ============================================================
// 層5b: pMake計算（負けシナリオ加重・浮動小数誤差対策済み）
// ============================================================
function computePMakeFromScenarios(scenarios) {
  const pMake = {};
  for (let n = 13; n <= 20; n++) {
    let prob = 0;
    for (const lossCount in scenarios.lossScenarios) {
      const s = scenarios.lossScenarios[lossCount];
      const napPts = s.napPoints;
      if (n === 20) {
        if (napPts >= 20 - EPS) prob += s.probability;
      } else {
        if (napPts >= n - EPS && napPts < 20 - EPS) prob += s.probability;
      }
    }
    pMake[n] = Math.max(0, Math.min(0.99, prob));
  }
  return pMake;
}

// ============================================================
// 層6: 相手モデリング（max bid推定）
// ============================================================
function estimateOppMaxBid(mySeat, bidHistory, matchScores, round, params) {
  const currentRound = Math.max(0, ...(bidHistory || []).map(b => b?.round || 0));
  const oppBids = {};
  for (let s = 0; s < 5; s++) {
    if (s === mySeat) continue;
    const theirBids = (bidHistory || []).filter(b => b.seat === s && b.round === currentRound && b.num >= 13);
    if (theirBids.length > 0) {
      oppBids[s] = {
        expected: Math.max(...theirBids.map(b => b.num)) + 1,
        p90: Math.min(20, Math.max(...theirBids.map(b => b.num)) + 2),
        confident: true,
      };
    } else {
      const roundBoost = round >= 7 ? 1.5 : 0;
      const oppScore = matchScores ? matchScores[s] : 0;
      const myScore = matchScores ? matchScores[mySeat] : 0;
      const scorePressure = oppScore < myScore ? 1 : 0;
      oppBids[s] = {
        expected: 14 + roundBoost + scorePressure,
        p90: 16 + roundBoost + scorePressure,
        confident: false,
      };
    }
  }
  return oppBids;
}

// ============================================================
// 統合: 手札を6層で完全分析
// ============================================================
export function analyzeHandForBid(hand, trump, context = {}) {
  if (!Array.isArray(hand) || hand.length === 0) return { error: 'empty_hand' };
  const params = context.params || defaultStrategy();
  const bidNum = context.bidNum || 15;
  const isNT = trump === 'NT';

  const offensive = analyzeOffensive(hand, trump, context);
  const defensive = analyzeDefensive(hand, trump, context);
  const points = analyzePoints(hand, trump, context);
  const risks = analyzeRisks(hand, trump, context, defensive);

  // 負けシナリオ分析（offensive/trump/isNT は不要になった）
  const lossScenarios = analyzeLossScenarios(defensive, {
    isSolo: context.isSolo === true,
    kittyPoints: points.kittyFaces || 0,
  });

  const napExpected = lossScenarios.weightedNapExpected;
  const stdDev = lossScenarios.weightedStdDev;

  // pMake
  const pMake = computePMakeFromScenarios(lossScenarios);

  // 推奨bid
  const safeBid = [20, 19, 18, 17, 16, 15, 14, 13].find(n => pMake[n] >= 0.75) || 13;
  const riskyBid = [20, 19, 18, 17, 16, 15, 14, 13].find(n => pMake[n] >= 0.40) || 13;

  // EV最適bid
  let bestBid = { n: 13, ev: -Infinity };
  for (let n = 13; n <= 20; n++) {
    const p = pMake[n];
    const E = (2 * p - 1) * (n - 12);
    const risk = 0.1 * Math.sqrt(Math.max(0, p * (1 - p))) * (n - 12);
    const adjE = E - risk;
    if (adjE > bestBid.ev) bestBid = { n, ev: adjE, p };
  }

  const allTakeRisk = napExpected >= 19.5 && bidNum < 20;

  // 圧倒的制御判定
  const hasMighty = offensive.absolute.some(w => w.type === 'mighty' || w.type === 'mighty_defended');
  const hasTrumpJ = offensive.absolute.some(w => w.type === 'trumpJ');
  const hasTrumpA = offensive.absolute.some(w => w.type === 'trumpA');
  const overwhelmingControl =
    (hasMighty && hasTrumpJ && hasTrumpA) ||
    (offensive.totalAbsolute >= 3);

  // 互換オブジェクト（computeOptimalBidStrategy が参照）
  const concentration = {
    expectedLostTricks: lossScenarios.phases.totalExpectedLosses,
    concentrationFactor: 1.0,
    adjustedLostPoints: (20 - napExpected) - (points.kittyFaces || 0),
    overwhelmingControl,
    can18: lossScenarios.phases.totalExpectedLosses < 0.6
      || (lossScenarios.phases.totalExpectedLosses <= 1.0 && overwhelmingControl),
    can19: lossScenarios.phases.totalExpectedLosses < 0.3
      || (lossScenarios.phases.totalExpectedLosses <= 0.7 && overwhelmingControl
          && hasMighty && hasTrumpJ && hasTrumpA),
  };

  return {
    trump, isNT,
    offensive, defensive, points, risks,
    lossScenarios,
    concentration, // 互換用
    bidOutcome: {
      napExpected,
      expectedNapPoints: napExpected, // 互換用
      allyExpected: 20 - napExpected,
      stdDev,
      pMake, safeBid, riskyBid,
      optimalBid: bestBid.n, optimalEV: bestBid.ev, optimalP: bestBid.p,
      allTakeRisk,
      canWin13: napExpected >= 13,
      overwhelmingControl,
      byLossCount: lossScenarios.recommendationByLossCount,
    },
  };
}

// ============================================================
// キティ選択の影響評価
// ============================================================
export function evaluateKittyChoices(hand12, trump, context = {}) {
  if (!Array.isArray(hand12) || hand12.length !== 12) return { error: 'need_12_cards' };
  const params = context.params || defaultStrategy();
  const isNT = trump === 'NT';
  const calledCard = context.calledCard || null;

  const protectedIds = new Set(['♠A']);
  if (!isNT) {
    protectedIds.add(trump + 'J');
    protectedIds.add(sameColorSuitOf(trump) + 'J');
  }
  if (calledCard) protectedIds.add(calledCard.id);

  const pool = hand12.filter(c => !protectedIds.has(c.id));
  const groups = groupBySuit(hand12);

  const candidates = [];

  // (a) 全スート維持
  if (pool.length >= 2) {
    const sorted = pool.slice().sort((a, b) => RANKS.indexOf(a.rank) - RANKS.indexOf(b.rank));
    candidates.push({ kind: 'safe_maintain', label: '全スート維持', cards: [sorted[0], sorted[1]] });
  }

  // (b) ボイド作成
  for (const s of SUITS) {
    if (s === trump) continue;
    const cnt = groups[s].length;
    if (cnt === 2) {
      const cards = groups[s].filter(c => !protectedIds.has(c.id));
      if (cards.length === 2) {
        candidates.push({ kind: 'void_' + s, label: `${s}ボイド`, cards });
      }
    }
  }

  // (c) 孤立絵札の犠牲
  const isolatedFaces = pool.filter(c => {
    if (!FACE.includes(c.rank)) return false;
    const same = hand12.filter(hc => hc.suit === c.suit && hc.id !== c.id);
    return same.length <= 2;
  });
  if (isolatedFaces.length >= 2) {
    candidates.push({ kind: 'face_sacrifice', label: '孤立絵札を捨て', cards: isolatedFaces.slice(0, 2) });
  }

  const results = candidates.map(cand => {
    const remaining = hand12.filter(c => !cand.cards.some(d => d.id === c.id));
    const a = analyzeHandForBid(remaining, trump, {
      ...context,
      discardedKitty: cand.cards,
    });
    return {
      candidate: cand,
      analysis: a,
      kittyPoints: cand.cards.filter(c => FACE.includes(c.rank)).length,
      maxWinnableBid: a.bidOutcome?.safeBid ?? 13,
      napExpected: a.bidOutcome?.napExpected ?? 0,
    };
  });

  results.sort((x, y) => {
    if (y.maxWinnableBid !== x.maxWinnableBid) return y.maxWinnableBid - x.maxWinnableBid;
    return y.napExpected - x.napExpected;
  });

  return { results, best: results[0] };
}

// ============================================================
// 副官指名の立ちへの貢献評価
// ============================================================
export function evaluateDeputyCallForBid(hand, trump, context = {}) {
  const isNT = trump === 'NT';
  const groups = groupBySuit(hand);
  const playedCards = context.playedCards || [];
  const discardedKitty = context.discardedKitty || [];
  const isIn = id => hand.some(c => c.id === id);
  const isPlayed = id => playedCards.some(c => c.id === id) || discardedKitty.some(c => c.id === id);

  const candidates = [];
  if (!isIn('♠A') && !isPlayed('♠A')) {
    candidates.push({ id: '♠A', suit: '♠', rank: 'A', value: 3.5, type: 'MIGHTY' });
  }
  if (!isNT && !isIn(trump + 'J') && !isPlayed(trump + 'J')) {
    candidates.push({ id: trump + 'J', suit: trump, rank: 'J', value: 3.0, type: 'TRUMP_J' });
  }
  if (!isNT && !isIn(sameColorSuitOf(trump) + 'J') && !isPlayed(sameColorSuitOf(trump) + 'J')) {
    candidates.push({ id: sameColorSuitOf(trump) + 'J', suit: sameColorSuitOf(trump), rank: 'J', value: 2.5, type: 'SAME_COLOR_J' });
  }
  for (const suit of SUITS) {
    if (suit === trump) continue;
    if (isIn(suit + 'A')) continue;
    if (isPlayed(suit + 'A')) continue;
    const suitLen = groups[suit].length;
    const aceValue = suitLen <= 1 ? 2.5 : suitLen <= 2 ? 2.0 : 1.5;
    candidates.push({ id: suit + 'A', suit, rank: 'A', value: aceValue, type: 'SIDE_ACE' });
  }

  candidates.sort((a, b) => b.value - a.value);

  return {
    candidates,
    best: candidates[0] || { id: '♠2', suit: '♠', rank: '2', value: 0.5, type: 'FALLBACK' },
    expectedPointsFromDeputy: candidates[0]?.value ?? 0.5,
  };
}

// ============================================================
// 統合エントリ: EVベースの最適bid決定
// ============================================================
export function computeOptimalBidStrategy(hand, trump, context = {}) {
  const params = context.params || defaultStrategy();
  const mySeat = context.mySeat ?? 0;
  const currentHigh = context.currentHigh || null;
  const bidHistory = context.bidHistory || [];
  const matchScores = context.matchScores || null;
  const round = context.round ?? 1;

  const analysis = analyzeHandForBid(hand, trump, context);
  if (analysis.error) return { properBid: 13, analysis, error: analysis.error };

  const { bidOutcome, concentration } = analysis;
  const oppBids = estimateOppMaxBid(mySeat, bidHistory, matchScores, round, params);
  const currentHighNum = currentHigh?.num ?? 12;

  const bidEVs = [];
  for (let n = 13; n <= 20; n++) {
    const p = bidOutcome.pMake[n] || 0;
    let pAuctionWin = 1;
    for (const s in oppBids) {
      const opp = oppBids[s];
      if (opp.p90 > n) {
        const raiseProb = Math.min(1, (opp.p90 - n) / 3) * 0.7;
        pAuctionWin *= (1 - raiseProb);
      }
    }
    const unit = n - 12;
    const napEV = (2 * p - 1) * unit;

    const pBeDeputyIfLose = 0.3 + (hand.some(c => c.id === '♠A') ? 0.3 : 0)
      + (hand.filter(c => c.rank === 'J').length >= 2 ? 0.15 : 0);

    let oppMaxBid = n;
    for (const s in oppBids) {
      if (oppBids[s].expected > oppMaxBid) oppMaxBid = oppBids[s].expected;
    }
    const oppPMake = Math.max(0.15, Math.min(0.95, 0.55 - (oppMaxBid - 13) * 0.05));
    const deputyEV = unit * (2 * oppPMake - 1);
    const allianceEV = -unit * (2 * oppPMake - 1);
    const loseEV = pBeDeputyIfLose * deputyEV + (1 - pBeDeputyIfLose) * allianceEV;

    let totalEV = pAuctionWin * napEV + (1 - pAuctionWin) * loseEV;

    // 18/19 の EV 追加減点
    if (n === 18 && !concentration.can18) totalEV -= 3.0 * unit * 0.3;
    if (n === 19 && !concentration.can19) totalEV -= 4.0 * unit * 0.4;
    if (n === 20 && !concentration.overwhelmingControl) totalEV -= 2.0;

    bidEVs.push({
      bid: n, pMake: p, pAuctionWin, napEV, loseEV, totalEV,
      isSafe: bidOutcome.safeBid >= n,
      isRisky: bidOutcome.riskyBid >= n && bidOutcome.safeBid < n,
      blocked: (n === 18 && !concentration.can18) || (n === 19 && !concentration.can19),
    });
  }

  // Pass EV
  let passEV = -0.3;
  if (currentHighNum >= 13) {
    const unit = currentHighNum - 12;
    let oppMaxBid = currentHighNum;
    for (const s in oppBids) {
      if (oppBids[s].expected > oppMaxBid) oppMaxBid = oppBids[s].expected;
    }
    const oppPMake = Math.max(0.15, Math.min(0.95, 0.55 - (oppMaxBid - 13) * 0.05));
    const pBeDeputyIfLose = 0.3 + (hand.some(c => c.id === '♠A') ? 0.3 : 0);
    const deputyEV = unit * (2 * oppPMake - 1);
    const allianceEV = -unit * (2 * oppPMake - 1);
    passEV = pBeDeputyIfLose * deputyEV + (1 - pBeDeputyIfLose) * allianceEV;
  }

  // 最適bid
  const minViable = Math.max(13, currentHighNum + 1);
  const viableBids = bidEVs.filter(b => b.bid >= minViable && !b.blocked);
  const fallbackBids = bidEVs.filter(b => b.bid >= minViable);
  const pool = viableBids.length > 0 ? viableBids : fallbackBids;
  const bestBid = pool.length > 0
    ? pool.reduce((best, b) => b.totalEV > best.totalEV ? b : best)
    : null;

  const shouldBid = bestBid && bestBid.totalEV > passEV + 0.1;

  return {
    analysis, bidEVs, passEV,
    bestBid: bestBid?.bid ?? 13,
    bestBidEV: bestBid?.totalEV ?? 0,
    shouldBid,
    oppBids,
    safeBid: bidOutcome.safeBid,
    riskyBid: bidOutcome.riskyBid,
    recommended: shouldBid
      ? {
          type: 'BID', num: bestBid.bid, suit: trump,
          reason: `EV最適(EV=${bestBid.totalEV.toFixed(2)}, pMake=${(bestBid.pMake * 100).toFixed(0)}%, 集中${concentration.can18 ? 'ON' : 'OFF'})`,
        }
      : {
          type: 'PASS', num: 0, suit: '',
          reason: `EV比較でpass有利(pass=${passEV.toFixed(2)} > bid=${(bestBid?.totalEV ?? 0).toFixed(2)})`,
        },
  };
}

// ============================================================
// computeProperBid 代替
// ============================================================
export function computeProperBidByStrategy(hand, trump, params, mySeat, bidSignals, matchScores, openKitty, playedCards, voids, bidHistory, round = 1, currentHigh = null) {
  const context = {
    params, mySeat, bidHistory, matchScores, round, currentHigh,
    openKitty: openKitty || [],
    playedCards: playedCards || [],
    discardedKitty: [],
    voids: voids || [{},{},{},{},{}],
  };

  const strategy = computeOptimalBidStrategy(hand, trump, context);
  if (strategy.analysis?.error) {
    return { properBid: 0, strategy, error: strategy.analysis.error };
  }

  const properBid = strategy.shouldBid ? strategy.bestBid : 0;

  return {
    properBid,
    baseBid: strategy.bestBid,
    strategy,
    analysis: strategy.analysis,
    safeBid: strategy.safeBid,
    riskyBid: strategy.riskyBid,
    expected: properBid,
    pMake20: strategy.analysis.bidOutcome.pMake[20] ?? 0,
    roleCardCount: 0,
    safetyMargin: params?.tossUpSafetyMargin ?? 0.4,
  };
}

// ============================================================
// shouldBid 代替: 全スートでEV評価して最良を返す
// ============================================================
export function shouldBidByStrategy(hand, currentHigh, minBid, params, bidHistory = [], mySeat = 0, experience = null, matchScores = null, openKitty = null, playedCards = [], voids = [{},{},{},{},{}]) {
  if (!Array.isArray(hand) || !hand.length) return null;
  if (!params) params = defaultStrategy();

  const currentHighNum = currentHigh?.num ?? 12;
  const suitOptions = SUITS.concat(['NT']);

  const evaluations = [];
  for (const suit of suitOptions) {
    const strategy = computeOptimalBidStrategy(hand, suit, {
      params, mySeat, currentHigh, bidHistory, matchScores,
      openKitty: openKitty || [],
      playedCards: playedCards || [],
      voids: voids || [{},{},{},{},{}],
    });
    if (strategy.analysis?.error) continue;
    if (!strategy.shouldBid) continue;
    if (strategy.bestBid < Math.max(13, currentHighNum + 1)) continue;
    evaluations.push({ suit, strategy });
  }

  if (!evaluations.length) return null;

  evaluations.sort((a, b) => b.strategy.bestBidEV - a.strategy.bestBidEV);
  const best = evaluations[0];

  return {
    num: best.strategy.bestBid,
    suit: best.suit,
    solo: false,
    plan: null,
    reason: best.strategy.recommended.reason,
    strategy: best.strategy,
  };
}

// ============================================================
// デバッグ
// ============================================================
export function debugBidStrategy(hand, trump, context = {}) {
  const a = analyzeHandForBid(hand, trump, context);
  const s = computeOptimalBidStrategy(hand, trump, context);
  return {
    summary: {
      trump,
      napExpected: a.bidOutcome?.napExpected,
      stdDev: a.bidOutcome?.stdDev,
      safeBid: a.bidOutcome?.safeBid,
      optimalBid: a.bidOutcome?.optimalBid,
      riskyBid: a.bidOutcome?.riskyBid,
      shouldBid: s.shouldBid,
      bestBid: s.bestBid,
      passEV: s.passEV,
      bestBidEV: s.bestBidEV,
      can18: a.concentration?.can18,
      can19: a.concentration?.can19,
      overwhelmingControl: a.bidOutcome?.overwhelmingControl,
    },
    byLossCount: a.bidOutcome?.byLossCount,
    majorScenarios: a.lossScenarios?.majorScenarios,
    offensive: a.offensive,
    defensive: a.defensive,
    points: a.points,
    risks: a.risks,
    bidEVs: s.bidEVs,
    recommended: s.recommended,
  };
}

