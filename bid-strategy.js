// bid-strategy.js — 立ち精度を極限まで高める戦略エンジン（v3・rollout統合版）
// 修正: 実際のプレイエンジンでロールアウト → 得点分布から pMake を算出
//      弱手（セイム2ゼロ・切札なし等）は pMake[13] < 0.4 で強制PASS

import { SUITS, RANKS, FACE, SV, sameColorSuitOf, defaultStrategy } from './constants.js';

const EPS = 1e-9;

function groupBySuit(hand) {
  const g = {};
  for (const s of SUITS) g[s] = [];
  for (const c of hand) if (g[c.suit]) g[c.suit].push(c);
  for (const s of SUITS) g[s].sort((a, b) => RANKS.indexOf(b.rank) - RANKS.indexOf(a.rank));
  return g;
}

// ============================================================
// 層1: 攻撃資産
// ============================================================
function analyzeOffensive(hand, trump, context) {
  const isNT = trump === 'NT';
  const groups = groupBySuit(hand);
  const playedCards = context.playedCards || [];
  const discardedKitty = context.discardedKitty || [];
  const hasMighty = hand.some(c => c.id === '♠A');
  const hasShadow = hand.some(c => c.id === '♥Q');
  const shadowSafe = playedCards.some(c => c.id === '♥Q') || discardedKitty.some(c => c.id === '♥Q');
  const trumpJ = !isNT ? groups[trump].find(c => c.rank === 'J') : null;
  const sameColorJ = !isNT ? groups[sameColorSuitOf(trump)].find(c => c.rank === 'J') : null;
  const trumps = isNT ? [] : groups[trump];

  const absolute = [];
  const conditional = [];
  const potential = [];

  if (hasMighty) {
    if (!hasShadow && shadowSafe) absolute.push({ cardId: '♠A', type: 'mighty', certainty: 1.0, expectedPoints: 0.3 });
    else if (!hasShadow && !shadowSafe) conditional.push({ cardId: '♠A', type: 'mighty_shadow_risk', certainty: 0.55, expectedPoints: 0.3 });
    else absolute.push({ cardId: '♠A', type: 'mighty_defended', certainty: 1.0, expectedPoints: 0.3 });
  }
  if (trumpJ) absolute.push({ cardId: trumpJ.id, type: 'trumpJ', certainty: 1.0, expectedPoints: 0.5 });
  if (sameColorJ) {
    const risk = trumpJ ? 0 : 0.25;
    conditional.push({ cardId: sameColorJ.id, type: 'sameColorJ', certainty: 1.0 - risk, expectedPoints: 0.5 });
  }
  if (!isNT && trumps.some(c => c.rank === 'A')) absolute.push({ cardId: trump + 'A', type: 'trumpA', certainty: 0.88, expectedPoints: 0.5 });
  if (!isNT && trumps.some(c => c.rank === 'K') && trumps.some(c => c.rank === 'A')) conditional.push({ cardId: trump + 'K', type: 'trumpK', certainty: 0.75, expectedPoints: 0.5 });

  for (const suit of SUITS) {
    if (suit === trump) continue;
    const ace = groups[suit].find(c => c.rank === 'A' && c.id !== '♠A');
    if (!ace) continue;
    const two = groups[suit].find(c => c.rank === '2');
    const twoPlayed = playedCards.some(c => c.id === suit + '2') || discardedKitty.some(c => c.id === suit + '2');
    const cutRisk = two ? 0 : twoPlayed ? 0 : 0.15;
    conditional.push({ cardId: ace.id, type: cutRisk === 0 ? 'sideA_safe' : 'sideA_cut_risk', certainty: 1 - cutRisk, expectedPoints: 0.8 });
  }
  for (const suit of SUITS) {
    if (suit === trump) continue;
    const ace = groups[suit].find(c => c.rank === 'A' && c.id !== '♠A');
    const two = groups[suit].find(c => c.rank === '2');
    if (ace && two) conditional.push({ cardId: two.id, type: 'sameTwoGuard', certainty: 0.7, expectedPoints: 0.4 });
  }
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
    potential.push({ type: 'longRun', suit, effectiveRun, certainty: Math.min(0.85, effectiveRun * 0.28), expectedPoints: effectiveRun * 0.5 });
  }
  if (!isNT) {
    for (const suit of SUITS) {
      if (suit === trump) continue;
      const cnt = groups[suit].length;
      if (cnt <= 1 && trumps.length >= 3) potential.push({ type: 'voidRuff', suit, certainty: 0.7, expectedPoints: 0.4 });
    }
  }
  return {
    absolute, conditional, potential,
    totalAbsolute: absolute.length,
    totalConditional: conditional.reduce((s, w) => s + w.certainty, 0),
    totalPotential: potential.reduce((s, w) => s + w.certainty, 0),
  };
}

// ============================================================
// 層2: 防御欠陥
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

  if (!isNT && trumpCount < 5) {
    const deficit = Math.max(0, 5 - trumpCount);
    if (deficit >= 1) {
      losses.push({
        type: 'TRUMP_EXHAUSTED', trickBand: [Math.max(6, 11 - deficit), 10],
        probability: Math.min(0.92, 0.45 + deficit * 0.13),
        expectedPointsLost: Math.min(4, deficit * 0.9), severity: deficit >= 2 ? 'high' : 'mid',
      });
    }
  }
  for (const suit of SUITS) {
    if (suit === trump) continue;
    const hasA = groups[suit].some(c => c.rank === 'A' && c.id !== '♠A');
    const has2 = groups[suit].some(c => c.rank === '2');
    if (!hasA || has2) continue;
    if (playedCards.some(c => c.id === suit + '2') || discardedKitty.some(c => c.id === suit + '2')) continue;
    losses.push({ type: 'SAME_TWO_CUT', suit, trickBand: [2, 6], probability: 0.55, expectedPointsLost: 1.0, severity: 'mid' });
  }
  const hasMighty = hand.some(c => c.id === '♠A');
  const hasShadow = hand.some(c => c.id === '♥Q');
  const shadowPlayed = playedCards.some(c => c.id === '♥Q') || discardedKitty.some(c => c.id === '♥Q');
  if (hasMighty && !hasShadow && !shadowPlayed) {
    losses.push({ type: 'SHADOW_HUNT', trickBand: [1, 4], probability: 0.5, expectedPointsLost: 0.8, severity: 'mid' });
  }
  for (const suit of SUITS) {
    if (suit === trump) continue;
    if (groups[suit].length === 0) {
      const cutAbility = trumpCount >= 3 ? 0.6 : trumpCount >= 1 ? 0.3 : 0;
      if (cutAbility < 0.5) {
        losses.push({ type: 'VOID_LOSS', suit, trickBand: [1, 5], probability: 0.7 - cutAbility * 0.4, expectedPointsLost: 2.0, severity: 'high' });
      }
    }
  }
  if (!isNT && trumpCount > 0) {
    const top = trumps[0];
    const hasJ = trumps.some(c => c.rank === 'J');
    const hasA = trumps.some(c => c.rank === 'A');
    if (!hasJ && !hasA && RANKS.indexOf(top.rank) < RANKS.indexOf('K')) {
      losses.push({ type: 'TRUMP_BATTLE', trickBand: [3, 7], probability: 0.45, expectedPointsLost: 1.2, severity: 'mid' });
    }
  }
  const sideSuits = SUITS.filter(s => s !== trump);
  const myLongest = sideSuits.reduce((best, s) => { const cnt = groups[s].length; return cnt > best.cnt ? { suit: s, cnt } : best; }, { suit: null, cnt: 0 });
  if (!isNT && myLongest.cnt < 3) {
    losses.push({ type: 'LONG_SUIT_RUN', trickBand: [4, 8], probability: 0.4, expectedPointsLost: 1.5, severity: 'mid' });
  }
  return {
    losses: losses.sort((a, b) => b.expectedPointsLost * b.probability - a.expectedPointsLost * a.probability),
    totalExpectedLostPoints: losses.reduce((s, l) => s + l.expectedPointsLost * l.probability, 0),
    myTrumps: trumpCount, enemyTrumps,
  };
}

// ============================================================
// 層3: 点札分布
// ============================================================
function analyzePoints(hand, trump, context) {
  const myFaces = hand.filter(c => FACE.includes(c.rank));
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
  return {
    myFaceCount: myFaces.length, myFaces: myFaces.map(c => c.id),
    deputyExpected, kittyFaces,
  };
}

// ============================================================
// ★ 戦術ロールアウト（playRolloutFn で1局を通す）
// ============================================================
function makeRng(seed) {
  let s = (seed >>> 0) || 1;
  return function () {
    s = (s + 0x6D2B79F5) | 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function hashSeed(...args) {
  let h = 2166136261 >>> 0;
  const str = args.join(':');
  for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; }
  return h >>> 0;
}

function shuffleInPlace(arr, rng) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    const tmp = arr[i]; arr[i] = arr[j]; arr[j] = tmp;
  }
  return arr;
}

function cardPowerLocal(contract, trickNo, card, trick) {
  if (!card) return 0;
  const ledSuit = trick.length > 0 ? trick[0].card.suit : card.suit;
  const allSame = trick.every(x => x.card.suit === ledSuit);
  const sameTwoEligible = allSame && trick.length >= 1;
  const mighty = trick.some(x => x.card.id === '♠A');
  if (mighty && card.id === '♥Q') return 10000;
  if (card.id === '♠A') return 9000;
  const isNT = !contract || contract.suit === 'NT';
  const trump = isNT ? null : contract.suit;
  if (!isNT && card.rank === 'J' && card.suit === trump) return 8000;
  if (!isNT && card.rank === 'J' && card.suit !== trump && sameColorSuitOf(trump) === card.suit) return 7000;
  if (trickNo > 0 && sameTwoEligible && card.rank === '2' && card.suit === ledSuit) return 6000;
  if (!isNT && card.suit === trump) return 5000 + RANKS.indexOf(card.rank);
  if (card.suit === ledSuit) return 3000 + RANKS.indexOf(card.rank);
  return 1000 + RANKS.indexOf(card.rank);
}

function simulateFullRoundWithTactics(myHand, trump, context, playRolloutFn, rng) {
  const calledCard = context.calledCard || null;
  const isSolo = context.isSolo === true || !calledCard;
  const bidNum = context.bidNum || 15;
  const kittyPoints = (context.discardedKitty || []).filter(c => FACE.includes(c.rank)).length;

  const seen = new Set(myHand.map(c => c.id));
  (context.discardedKitty || []).forEach(c => seen.add(c.id));
  const unseen = [];
  for (const s of SUITS) for (const r of RANKS) {
    const id = s + r;
    if (!seen.has(id)) unseen.push({ suit: s, rank: r, id });
  }
  shuffleInPlace(unseen, rng);

  const hands = [[], [], [], [], []];
  hands[0] = myHand.map(c => ({ ...c }));
  let poolIdx = 0;
  for (let s = 1; s < 5; s++) {
    for (let k = 0; k < 10 && poolIdx < unseen.length; k++) hands[s].push(unseen[poolIdx++]);
  }

  let deputy = -1;
  if (!isSolo && calledCard) {
    for (let s = 1; s < 5; s++) {
      if (hands[s].some(c => c.id === calledCard.id)) { deputy = s; break; }
    }
  }
  const napSide = isSolo ? new Set([0]) : new Set([0, deputy].filter(x => x >= 0));
  const contract = { nap: 0, num: bidNum, suit: trump, solo: isSolo, deputy: isSolo ? 0 : deputy, revealedCall: true, call: calledCard };

  const points = [0, 0, 0, 0, 0];
  const played = [];
  const voids = [{}, {}, {}, {}, {}];
  let active = 0;

  for (let t = 0; t < 10; t++) {
    if (hands.every(h => h.length === 0)) break;
    const trick = [];
    for (let i = 0; i < 5; i++) {
      const seat = (active + i) % 5;
      const hand = hands[seat];
      if (!hand.length) break;
      const led = trick.length ? trick[0].card.suit : null;
      const legal = !led ? hand : (hand.some(c => c.suit === led) ? hand.filter(c => c.suit === led) : hand);
      if (!legal.length) break;

      const ctx = {
        hand, legal, trick, trickNo: t, contract, playedCards: played, voids, seat,
        deputy: contract.deputy,
        params: { ...(context.params || defaultStrategy()), enableTrickAnalysis: true, enableEndgameSearch: false },
        call: calledCard, discardedKitty: context.discardedKitty || [],
        isRevealed: true, isRollout: true,
        currentNapPoints: points[0] + (isSolo ? 0 : (points[deputy] || 0)),
        points: points.slice(), allianceKittyPoints: kittyPoints,
        players: hands.map(h => ({ handCount: h.length })),
      };

      let chosen = null;
      try { chosen = playRolloutFn(ctx); } catch (e) { chosen = null; }
      if (!chosen || !legal.some(c => c.id === chosen.id)) {
        chosen = legal.reduce((b, c) => cardPowerLocal(contract, t, c, trick) < cardPowerLocal(contract, t, b, trick) ? c : b, legal[0]);
      }
      hands[seat] = hand.filter(c => c.id !== chosen.id);
      if (trick.length > 0) {
        const ledSuit = trick[0].card.suit;
        if (chosen.suit !== ledSuit) { if (!voids[seat]) voids[seat] = {}; voids[seat][ledSuit] = true; }
      }
      played.push({ id: chosen.id, suit: chosen.suit, rank: chosen.rank, seat });
      trick.push({ seat, card: chosen });
    }
    if (trick.length < 5) break;
    const wEntry = trick.reduce((best, x) => cardPowerLocal(contract, t, x.card, trick) > cardPowerLocal(contract, t, best.card, trick) ? x : best, trick[0]);
    const w = wEntry.seat;
    const taken = trick.filter(e => FACE.includes(e.card.rank)).length;
    points[w] += taken;
    active = w;
    const napPts = points[0] + (isSolo ? 0 : (points[deputy] || 0));
    const allyPts = points.reduce((sum, p, i) => sum + (napSide.has(i) ? 0 : p), 0) + kittyPoints;
    if (napPts >= bidNum && (bidNum === 20 || allyPts >= 1)) break;
    if (allyPts > 20 - bidNum) break;
  }
  const finalNap = points[0] + (isSolo ? 0 : (points[deputy] || 0));
  return { napPoints: finalNap, made: finalNap >= bidNum && (bidNum === 20 || finalNap < 20) };
}

function computePMakeFromRollouts(myHand, trump, context, playRolloutFn, sampleCount) {
  const n = Math.max(4, Math.min(20, sampleCount || 6));
  const results = [];
  const key = myHand.map(c => c.id).sort().join('|') + '|' + trump + '|' + (context.bidNum || 15);
  const baseSeed = hashSeed(key);

  for (let i = 0; i < n; i++) {
    const rng = makeRng((baseSeed + i * 8191) >>> 0);
    try { results.push(simulateFullRoundWithTactics(myHand, trump, context, playRolloutFn, rng).napPoints); }
    catch (e) { /* skip */ }
  }

  if (!results.length) return { pMake: {}, avgNapPoints: 0, stdDev: 0, sampleCount: 0 };

  const pMake = {};
  for (let b = 13; b <= 20; b++) {
    let wins = 0;
    for (const pts of results) {
      if (b === 20) { if (pts >= 20) wins++; }
      else { if (pts >= b && pts < 20) wins++; }
    }
    pMake[b] = wins / results.length;
  }

  const avg = results.reduce((s, v) => s + v, 0) / results.length;
  const variance = results.reduce((s, v) => s + (v - avg) ** 2, 0) / results.length;
  return {
    pMake, sampleScores: results, avgNapPoints: avg,
    stdDev: Math.max(1.2, Math.sqrt(variance)), sampleCount: results.length,
  };
}

// ============================================================
// フォールバック: シナリオベース pMake
// ============================================================
function computePMakeFromScenarios(defensiveLosses) {
  const pMake = {};
  const exp = defensiveLosses.totalExpectedLostPoints;
  const napExpected = 20 - exp;
  const stdDev = Math.max(1.2, Math.sqrt(exp + 1.5));
  for (let n = 13; n <= 20; n++) {
    const z = (n - napExpected) / stdDev;
    let p = 1 - 0.5 * (1 + erf(z / Math.sqrt(2)));
    if (n < 20) {
      const z20 = (20 - napExpected) / stdDev;
      p -= (1 - 0.5 * (1 + erf(z20 / Math.sqrt(2))));
    }
    pMake[n] = Math.max(0, Math.min(0.99, p));
  }
  return { pMake, avgNapPoints: napExpected, stdDev, sampleCount: 0 };
}

function erf(x) {
  const sign = x < 0 ? -1 : 1;
  x = Math.abs(x);
  const a1 = 0.254829592, a2 = -0.284496736, a3 = 1.421413741, a4 = -1.453152027, a5 = 1.061405429, p = 0.3275911;
  const t = 1 / (1 + p * x);
  const y = 1 - (((((a5 * t + a4) * t + a3) * t + a2) * t + a1) * t) * Math.exp(-x * x);
  return sign * y;
}

// ============================================================
// 統合: analyzeHandForBid
// ============================================================
export function analyzeHandForBid(hand, trump, context = {}) {
  if (!Array.isArray(hand) || hand.length === 0) return { error: 'empty_hand' };
  const bidNum = context.bidNum || 15;
  const playRolloutFn = context.playRolloutFn || null;

  const offensive = analyzeOffensive(hand, trump, context);
  const defensive = analyzeDefensive(hand, trump, context);
  const points = analyzePoints(hand, trump, context);

  let rollout = null;
  if (playRolloutFn) {
    try {
      rollout = computePMakeFromRollouts(hand, trump,
        { ...context, bidNum, calledCard: context.calledCard || null, isSolo: context.isSolo === true,
          discardedKitty: context.discardedKitty || [], playedCards: context.playedCards || [] },
        playRolloutFn, context.sampleCount || 6
      );
    } catch (e) { rollout = null; }
  }

  let pMake, napExpected, stdDev, usedRollout = false;
  if (rollout && rollout.sampleCount >= 4) {
    pMake = rollout.pMake;
    napExpected = rollout.avgNapPoints;
    stdDev = rollout.stdDev;
    usedRollout = true;
  } else {
    const scen = computePMakeFromScenarios(defensive);
    pMake = scen.pMake;
    napExpected = scen.avgNapPoints;
    stdDev = scen.stdDev;
  }

  const safeBid = [20, 19, 18, 17, 16, 15, 14, 13].find(n => pMake[n] >= 0.75) || 13;
  const riskyBid = [20, 19, 18, 17, 16, 15, 14, 13].find(n => pMake[n] >= 0.40) || 13;

  let bestBid = { n: 13, ev: -Infinity };
  for (let n = 13; n <= 20; n++) {
    const p = pMake[n];
    const E = (2 * p - 1) * (n - 12);
    const risk = 0.1 * Math.sqrt(Math.max(0, p * (1 - p))) * (n - 12);
    const adjE = E - risk;
    if (adjE > bestBid.ev) bestBid = { n, ev: adjE, p };
  }

  const hasMighty = offensive.absolute.some(w => w.type === 'mighty' || w.type === 'mighty_defended');
  const hasTrumpJ = offensive.absolute.some(w => w.type === 'trumpJ');
  const hasTrumpA = offensive.absolute.some(w => w.type === 'trumpA');
  const overwhelmingControl = (hasMighty && hasTrumpJ && hasTrumpA) || offensive.totalAbsolute >= 3;

  return {
    trump, isNT: trump === 'NT', offensive, defensive, points, rollout,
    bidOutcome: {
      napExpected, stdDev, pMake, safeBid, riskyBid,
      optimalBid: bestBid.n, optimalEV: bestBid.ev, optimalP: bestBid.p,
      canWin13: napExpected >= 13, overwhelmingControl, usedRollout,
      sampleCount: rollout?.sampleCount ?? 0,
    },
  };
}

// ============================================================
// キティ選択の影響評価
// ============================================================
export function evaluateKittyChoices(hand12, trump, context = {}) {
  if (!Array.isArray(hand12) || hand12.length !== 12) return { error: 'need_12_cards' };
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

  if (pool.length >= 2) {
    const sorted = pool.slice().sort((a, b) => RANKS.indexOf(a.rank) - RANKS.indexOf(b.rank));
    candidates.push({ kind: 'safe_maintain', label: '全スート維持', cards: [sorted[0], sorted[1]] });
  }
  for (const s of SUITS) {
    if (s === trump) continue;
    const cnt = groups[s].length;
    if (cnt === 2) {
      const cards = groups[s].filter(c => !protectedIds.has(c.id));
      if (cards.length === 2) candidates.push({ kind: 'void_' + s, label: `${s}ボイド`, cards });
    }
  }
  const isolatedFaces = pool.filter(c => {
    if (!FACE.includes(c.rank)) return false;
    const same = hand12.filter(hc => hc.suit === c.suit && hc.id !== c.id);
    return same.length <= 2;
  });
  if (isolatedFaces.length >= 2) candidates.push({ kind: 'face_sacrifice', label: '孤立絵札を捨て', cards: isolatedFaces.slice(0, 2) });

  const results = candidates.map(cand => {
    const remaining = hand12.filter(c => !cand.cards.some(d => d.id === c.id));
    const a = analyzeHandForBid(remaining, trump, { ...context, discardedKitty: cand.cards });
    return {
      candidate: cand, analysis: a,
      kittyPoints: cand.cards.filter(c => FACE.includes(c.rank)).length,
      maxWinnableBid: a.bidOutcome?.safeBid ?? 13,
      napExpected: a.bidOutcome?.napExpected ?? 0,
    };
  });
  results.sort((x, y) => y.maxWinnableBid !== x.maxWinnableBid ? y.maxWinnableBid - x.maxWinnableBid : y.napExpected - x.napExpected);
  return { results, best: results[0] };
}

export function evaluateDeputyCallForBid(hand, trump, context = {}) {
  const isNT = trump === 'NT';
  const groups = groupBySuit(hand);
  const playedCards = context.playedCards || [];
  const discardedKitty = context.discardedKitty || [];
  const isIn = id => hand.some(c => c.id === id);
  const isPlayed = id => playedCards.some(c => c.id === id) || discardedKitty.some(c => c.id === id);
  const candidates = [];
  if (!isIn('♠A') && !isPlayed('♠A')) candidates.push({ id: '♠A', suit: '♠', rank: 'A', value: 3.5, type: 'MIGHTY' });
  if (!isNT && !isIn(trump + 'J') && !isPlayed(trump + 'J')) candidates.push({ id: trump + 'J', suit: trump, rank: 'J', value: 3.0, type: 'TRUMP_J' });
  if (!isNT && !isIn(sameColorSuitOf(trump) + 'J') && !isPlayed(sameColorSuitOf(trump) + 'J')) {
    candidates.push({ id: sameColorSuitOf(trump) + 'J', suit: sameColorSuitOf(trump), rank: 'J', value: 2.5, type: 'SAME_COLOR_J' });
  }
  for (const suit of SUITS) {
    if (suit === trump) continue;
    if (isIn(suit + 'A')) continue;
    if (isPlayed(suit + 'A')) continue;
    const suitLen = groups[suit].length;
    candidates.push({ id: suit + 'A', suit, rank: 'A', value: suitLen <= 1 ? 2.5 : suitLen <= 2 ? 2.0 : 1.5, type: 'SIDE_ACE' });
  }
  candidates.sort((a, b) => b.value - a.value);
  return { candidates, best: candidates[0] || { id: '♠2', suit: '♠', rank: '2', value: 0.5, type: 'FALLBACK' } };
}

// ============================================================
// ★ 統合エントリ: EVベースの最適bid決定
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

  const { bidOutcome } = analysis;
  const currentHighNum = currentHigh?.num ?? 12;

  // ★ 弱手強制PASS: 初手で pMake[13] < 0.4 なら立たない
  if ((!currentHigh || currentHigh.num < 13) && (bidOutcome.pMake[13] || 0) < 0.4) {
    return {
      analysis, bidEVs: [], passEV: 0, bestBid: 13, bestBidEV: 0,
      shouldBid: false,
      safeBid: bidOutcome.safeBid, riskyBid: bidOutcome.riskyBid,
      recommended: {
        type: 'PASS', num: 0, suit: '',
        reason: `弱手強制PASS: pMake[13]=${((bidOutcome.pMake[13] || 0) * 100).toFixed(0)}% < 40%`,
      },
    };
  }

  const oppBids = {};
  for (let s = 0; s < 5; s++) {
    if (s === mySeat) continue;
    const theirBids = (bidHistory || []).filter(b => b.seat === s && b.num >= 13);
    if (theirBids.length > 0) {
      oppBids[s] = { expected: Math.max(...theirBids.map(b => b.num)) + 1, p90: Math.min(20, Math.max(...theirBids.map(b => b.num)) + 2) };
    } else {
      const roundBoost = round >= 7 ? 1.5 : 0;
      oppBids[s] = { expected: 14 + roundBoost, p90: 16 + roundBoost };
    }
  }

  const bidEVs = [];
  for (let n = 13; n <= 20; n++) {
    const p = bidOutcome.pMake[n] || 0;
    let pAuctionWin = 1;
    for (const s in oppBids) {
      const opp = oppBids[s];
      if (opp.p90 > n) pAuctionWin *= (1 - Math.min(1, (opp.p90 - n) / 3) * 0.7);
    }
    const unit = n - 12;
    const napEV = (2 * p - 1) * unit;
    const pBeDeputyIfLose = 0.3 + (hand.some(c => c.id === '♠A') ? 0.3 : 0) + (hand.filter(c => c.rank === 'J').length >= 2 ? 0.15 : 0);
    let oppMaxBid = n;
    for (const s in oppBids) { if (oppBids[s].expected > oppMaxBid) oppMaxBid = oppBids[s].expected; }
    const oppPMake = Math.max(0.15, Math.min(0.95, 0.55 - (oppMaxBid - 13) * 0.05));
    const deputyEV = unit * (2 * oppPMake - 1);
    const allianceEV = -unit * (2 * oppPMake - 1);
    const loseEV = pBeDeputyIfLose * deputyEV + (1 - pBeDeputyIfLose) * allianceEV;
    const totalEV = pAuctionWin * napEV + (1 - pAuctionWin) * loseEV;
    bidEVs.push({ bid: n, pMake: p, pAuctionWin, napEV, loseEV, totalEV });
  }

  let passEV = -0.3;
  if (currentHighNum >= 13) {
    const unit = currentHighNum - 12;
    let oppMaxBid = currentHighNum;
    for (const s in oppBids) { if (oppBids[s].expected > oppMaxBid) oppMaxBid = oppBids[s].expected; }
    const oppPMake = Math.max(0.15, Math.min(0.95, 0.55 - (oppMaxBid - 13) * 0.05));
    const pBeDeputyIfLose = 0.3 + (hand.some(c => c.id === '♠A') ? 0.3 : 0);
    const deputyEV = unit * (2 * oppPMake - 1);
    const allianceEV = -unit * (2 * oppPMake - 1);
    passEV = pBeDeputyIfLose * deputyEV + (1 - pBeDeputyIfLose) * allianceEV;
  }

  const minViable = Math.max(13, currentHighNum + 1);
  const viableBids = bidEVs.filter(b => b.bid >= minViable);
  const bestBid = viableBids.length > 0
    ? viableBids.reduce((best, b) => b.totalEV > best.totalEV ? b : best)
    : bidEVs[bidEVs.length - 1];
  const shouldBid = bestBid && bestBid.totalEV > passEV + 0.1;

  return {
    analysis, bidEVs, passEV,
    bestBid: bestBid?.bid ?? 13, bestBidEV: bestBid?.totalEV ?? 0, shouldBid,
    safeBid: bidOutcome.safeBid, riskyBid: bidOutcome.riskyBid,
    recommended: shouldBid
      ? { type: 'BID', num: bestBid.bid, suit: trump, reason: `EV最適(EV=${bestBid.totalEV.toFixed(2)}, pMake=${(bestBid.pMake * 100).toFixed(0)}%)` }
      : { type: 'PASS', num: 0, suit: '', reason: `EV比較でpass有利(pass=${passEV.toFixed(2)} > bid=${(bestBid?.totalEV ?? 0).toFixed(2)})` },
  };
}

// ============================================================
// computeProperBid / shouldBid ラッパー
// ============================================================
export function computeProperBidByStrategy(hand, trump, params, mySeat, bidSignals, matchScores, openKitty, playedCards, voids, bidHistory, round = 1, currentHigh = null, playRolloutFn = null) {
  const strategy = computeOptimalBidStrategy(hand, trump, {
    params, mySeat, bidHistory, matchScores, round, currentHigh,
    openKitty: openKitty || [], playedCards: playedCards || [], discardedKitty: [],
    voids: voids || [{},{},{},{},{}], playRolloutFn,
  });
  if (strategy.analysis?.error) return { properBid: 0, strategy, error: strategy.analysis.error };

  const properBid = strategy.shouldBid ? strategy.bestBid : 0;
  return {
    properBid, baseBid: strategy.bestBid, strategy, analysis: strategy.analysis,
    safeBid: strategy.safeBid, riskyBid: strategy.riskyBid, expected: properBid,
    pMake20: strategy.analysis.bidOutcome.pMake[20] ?? 0,
    roleCardCount: 0, safetyMargin: params?.tossUpSafetyMargin ?? 0.4,
  };
}

export function shouldBidByStrategy(hand, currentHigh, minBid, params, bidHistory = [], mySeat = 0, experience = null, matchScores = null, openKitty = null, playedCards = [], voids = [{},{},{},{},{}], playRolloutFn = null) {
  if (!Array.isArray(hand) || !hand.length) return null;
  if (!params) params = defaultStrategy();
  const currentHighNum = currentHigh?.num ?? 12;
  const suitOptions = SUITS.concat(['NT']);
  const evaluations = [];
  for (const suit of suitOptions) {
    const strategy = computeOptimalBidStrategy(hand, suit, {
      params, mySeat, currentHigh, bidHistory, matchScores,
      openKitty: openKitty || [], playedCards: playedCards || [],
      voids: voids || [{},{},{},{},{}], playRolloutFn,
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
    num: best.strategy.bestBid, suit: best.suit, solo: false, plan: null,
    reason: best.strategy.recommended.reason, strategy: best.strategy,
  };
}

export function debugBidStrategy(hand, trump, context = {}) {
  const a = analyzeHandForBid(hand, trump, context);
  const s = computeOptimalBidStrategy(hand, trump, context);
  return {
    summary: {
      trump, napExpected: a.bidOutcome?.napExpected, stdDev: a.bidOutcome?.stdDev,
      safeBid: a.bidOutcome?.safeBid, optimalBid: a.bidOutcome?.optimalBid, riskyBid: a.bidOutcome?.riskyBid,
      usedRollout: a.bidOutcome?.usedRollout, sampleCount: a.bidOutcome?.sampleCount,
      shouldBid: s.shouldBid, bestBid: s.bestBid, passEV: s.passEV, bestBidEV: s.bestBidEV,
      pMake13: a.bidOutcome?.pMake[13],
    },
    offensive: a.offensive, defensive: a.defensive, points: a.points,
    rollout: a.rollout, bidEVs: s.bidEVs, recommended: s.recommended,
  };
}
