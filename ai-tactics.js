// ai-tactics.js (トスアップ戦略対応版 / 完全版)
import { SUITS, RANKS, SV, CALIBRATION, sweetSpotFactor, estimatedWinRate, findMaxHonestBid, SWEET_SPOT_BONUS, HONEST_BID_FIXED_BONUS, ALLY_LOSS_PENALTY, ALLY_WIN_BONUS, ALLY_BLOCK_BONUS, sameColorSuitOf, isSameColorSuit, defaultStrategy, quantizeStrength, bidExperienceKey, callExperienceKey, playExperienceKey, rankTierOf, trickPhaseOf, pointsTierOf, experienceConfidence, blendWithExperience } from './constants.js';

const FACE = ['10', 'J', 'Q', 'K', 'A'];

export function isTrump(contract, c) {
  return contract.suit !== "NT" && c.suit === contract.suit;
}

export function cardPower(contract, trickNo, card, trick, strictAllSame = false) {
  const led = trick.length > 0 ? trick[0].card.suit : card.suit;
  const allSame = trick.every(x => x.card.suit === led);
  const sameTwoEligible = allSame && (!strictAllSame || trick.length >= 5);
  const mighty = trick.some(x => x.card.id === "♠A");
  if (mighty && card.id === "♥Q") return 10000;
  if (card.id === "♠A") return 9000;
  if (contract.suit !== "NT" && card.rank === "J" && card.suit === contract.suit) return 8000;
  if (contract.suit !== "NT" && card.rank === "J" && card.suit !== contract.suit && isSameColorSuit(card.suit, contract.suit)) return 7000;
  if (trickNo > 0 && sameTwoEligible && card.suit === led && card.rank === "2") return 6000;
  if (isTrump(contract, card)) return 5000 + RANKS.indexOf(card.rank);
  if (card.suit === led) return 3000 + RANKS.indexOf(card.rank);
  return 1000 + RANKS.indexOf(card.rank);
}

export function winningEntry(contract, trickNo, trick, strictAllSame = false) {
  if (!trick || !trick.length) return null;
  return trick.reduce((best, x) =>
    cardPower(contract, trickNo, x.card, trick, strictAllSame) > cardPower(contract, trickNo, best.card, trick, strictAllSame) ? x : best, trick[0]
  );
}

function suitValue(hand, suit) {
  const weight = { "10": 1, J: 1.8, Q: 2.6, K: 3.5, A: 4.7 };
  const cards = hand.filter(c => c.suit === suit);
  return cards.reduce((n, c) => n + (weight[c.rank] || 0), 0) + Math.max(0, cards.length - 3) * .75;
}

export function handStrength(hand) {
  if (!Array.isArray(hand) || !hand.length) return 0;
  const base = hand.reduce((n, c) => n + (RANKS.indexOf(c.rank) > 9 ? 1.25 : RANKS.indexOf(c.rank) > 7 ? 0.45 : 0) + (c.rank === "A" ? 0.35 : 0), 0);
  return base + Math.max(...SUITS.map(s => suitValue(hand, s))) * 0.3;
}

export function strongestSuit(hand, suits = SUITS) {
  return suits.slice().sort((a, b) => suitValue(hand, b) - suitValue(hand, a) || SV[b] - SV[a])[0];
}

export function colorStrength(hand, trump, params) {
  const base = handStrength(hand);
  const trumps = hand.filter(c => c.suit === trump);
  let trumpPenalty = trumps.length === 0 ? -5.0 : trumps.length === 1 ? -2.0 : 0;
  return base + trumpPenalty + trumps.length * 0.5 + (params?.trumpBonus || 0.6) * trumps.length * 0.2;
}

export function ntHandStrength(hand, params) {
  const lengths = SUITS.map(s => hand.filter(c => c.suit === s).length);
  const maxLen = Math.max(...lengths), minLen = Math.min(...lengths);
  let score = 0;
  for (const suit of SUITS) {
    const cards = hand.filter(c => c.suit === suit);
    score += cards.length * 0.3;
    if (cards.some(c => c.rank === 'A')) score += (params?.ntAceWeight ?? 1.5);
    if (cards.some(c => c.rank === 'K')) score += 1.0;
    if (cards.some(c => c.rank === 'Q')) score += 0.6;
    if (cards.length >= 4) score += (params?.ntSuitLengthBonus ?? 1.2) * (cards.length - 3) * 0.5;
    if (cards.some(c => c.rank === 'A') && !cards.some(c => c.rank === '2')) {
      const len = cards.length;
      score -= len >= 3 ? 0.5 : len >= 2 ? 0.3 : 0.15;
    }
  }
  if (minLen === 0) score -= 2.5; else if (minLen === 1) score -= 1.0;
  if (maxLen >= 6) score -= 1.5; else if (maxLen >= 5 && minLen <= 2) score -= 0.5;
  if (maxLen <= 4 && minLen >= 2) score += 1.0;
  if (hand.some(c => c.id === '♠A')) score += (params?.ntMightyBonus ?? 2.5);
  return score;
}

export function soloAdjustedStrength(hand, trump) {
  const base = handStrength(hand);
  const trumps = hand.filter(c => c.suit === trump);
  let trumpPenalty = trumps.length === 0 ? -5.0 : trumps.length === 1 ? -2.0 : 0;
  const hasMighty = hand.some(c => c.id === '♠A');
  const hasTrumpJ = trump !== 'NT' && hand.some(c => c.rank === 'J' && c.suit === trump);
  return base + trumpPenalty + trumps.length * 0.5 + (hasMighty ? 1.5 : 0) + (hasTrumpJ ? 1.0 : 0);
}

// ==========================================
// 競り判断：MECEな勝ち周算出 + PIMC
// ==========================================

function computeMECESuitWins(hand, playedCards, suit, trump, voids, seat) {
  const myCards = hand.filter(c => c.suit === suit).sort((a, b) => RANKS.indexOf(b.rank) - RANKS.indexOf(a.rank));
  if (!myCards.length) return 0;

  const playedRanks = new Set(playedCards.filter(c => c.suit === suit).map(c => c.rank));
  const unseenRanks = RANKS.filter(r => !playedRanks.has(r) && !myCards.some(c => c.rank === r)).sort((a, b) => RANKS.indexOf(b) - RANKS.indexOf(a));

  let wins = 0;
  for (let i = 0; i < myCards.length; i++) {
    const myCard = myCards[i];
    const opponentCard = unseenRanks[i];
    if (!opponentCard) {
      wins++;
    } else if (RANKS.indexOf(myCard.rank) > RANKS.indexOf(opponentCard)) {
      wins++;
    } else {
      if (trump !== 'NT' && voids[seat]?.[suit]) {
        if (Math.random() < 0.3) continue;
      }
    }
  }

  const myTwo = myCards.find(c => c.rank === '2');
  if (myTwo) {
    const playedInSuit = playedCards.filter(c => c.suit === suit).length;
    const voidCount = [0,1,2,3,4].filter(s => s !== seat && voids[s]?.[suit]).length;
    if (playedInSuit >= 4 && voidCount === 0) {
      wins++;
    } else if (playedInSuit >= 4 && trump === 'NT') {
      wins++;
    }
  }

  return wins;
}

function computeSurePoints(hand, trump, openKitty, playedCards = [], voids = [{},{},{},{},{}], seat = 0) {
  let sure = 0;
  const hqInPlay = (openKitty || []).some(c => c.id === '♥Q') || hand.some(c => c.id === '♥Q');
  const hasMighty = hand.some(c => c.id === '♠A');
  const trumpJ = trump !== 'NT' ? hand.find(c => c.rank === 'J' && c.suit === trump) : null;
  const sameColorJ = trump !== 'NT' ? hand.find(c => c.rank === 'J' && c.suit !== trump && isSameColorSuit(c.suit, trump)) : null;
  
  if (hasMighty && !hqInPlay) sure += 1;
  if (trumpJ) sure += 1;
  else if (sameColorJ) sure += 0.6;
  
  for (const suit of SUITS) {
    if (suit === trump) continue;
    sure += computeMECESuitWins(hand, playedCards, suit, trump, voids, seat);
  }
  
  if (trump !== 'NT') {
    sure += computeMECESuitWins(hand, playedCards, trump, trump, voids, seat);
  }

  return sure;
}

function smartRolloutPlay(seat, mySeat, allySeat, hand, trick, trump, trickNo) {
  const led = trick.length ? trick[0].card.suit : null;
  const legal = !led ? hand : (hand.some(c => c.suit === led) ? hand.filter(c => c.suit === led) : hand);
  if (!legal.length) return null;
  
  const isMyTeam = seat === mySeat || seat === allySeat;
  const currentWinner = trick.length ? winningEntry({ suit: trump }, trickNo, trick) : null;
  const isMyTeamWinning = currentWinner && (currentWinner.seat === mySeat || currentWinner.seat === allySeat);
  
  if (trick.length === 0) {
    return legal.reduce((best, c) => {
      const cp = cardPower({ suit: trump }, trickNo, c, [{ card: c }]);
      const bp = cardPower({ suit: trump }, trickNo, best, [{ card: best }]);
      return cp > bp ? c : best;
    }, legal[0]);
  }
  
  if (isMyTeam && isMyTeamWinning) {
    return legal.reduce((best, c) => {
      const cp = cardPower({ suit: trump }, trickNo, c, trick);
      const bp = cardPower({ suit: trump }, trickNo, best, trick);
      return cp < bp ? c : best;
    }, legal[0]);
  }
  
  const winning = legal.filter(c => {
    const testTrick = [...trick, { seat, card: c }];
    return winningEntry({ suit: trump }, trickNo, testTrick).seat === seat;
  });
  if (winning.length) {
    return winning.reduce((best, c) => {
      const cp = cardPower({ suit: trump }, trickNo, c, trick);
      const bp = cardPower({ suit: trump }, trickNo, best, trick);
      return cp < bp ? c : best;
    }, winning[0]);
  }
  return legal.reduce((best, c) => {
    const cp = cardPower({ suit: trump }, trickNo, c, trick);
    const bp = cardPower({ suit: trump }, trickNo, best, trick);
    return cp < bp ? c : best;
  }, legal[0]);
}

function determineVirtualAlly(myHand, bidHistory, mySeat) {
  const missingStrong = ['♠A', '♠J', '♥J', '♦J', '♣J'].filter(id => !myHand.some(c => c.id === id));
  if (missingStrong.length === 0) return mySeat;
  
  const otherSeats = [0,1,2,3,4].filter(s => s !== mySeat);
  let bestAlly = otherSeats[Math.floor(Math.random() * otherSeats.length)];
  
  if (bidHistory) {
    const suitBids = {};
    bidHistory.forEach(b => {
      if (b.seat !== mySeat && b.suit !== 'NT') {
        suitBids[b.seat] = (suitBids[b.seat] || 0) + b.num;
      }
    });
    let maxBid = 0;
    for (const s of otherSeats) {
      if (suitBids[s] && suitBids[s] > maxBid) {
        maxBid = suitBids[s];
        bestAlly = s;
      }
    }
  }
  return bestAlly;
}

function sampleOpponentHands(myHand, bidHistory, mySeat, openKitty) {
  const used = new Set(myHand.map(c => c.id));
  (openKitty || []).forEach(c => used.add(c.id));
  const remaining = [];
  for (const s of SUITS) for (const r of RANKS) {
    const id = s + r;
    if (!used.has(id)) remaining.push({ suit: s, rank: r, id });
  }
  
  const suitWeights = [{}, {}, {}, {}, {}];
  if (bidHistory) {
    bidHistory.forEach(b => {
      if (b.seat !== mySeat && b.suit !== 'NT') {
        suitWeights[b.seat][b.suit] = (suitWeights[b.seat][b.suit] || 0) + (b.num - 12) * 0.4;
      }
    });
  }
  
  const others = [[], [], [], []];
  const otherSeats = [0, 1, 2, 3, 4].filter(s => s !== mySeat);
  const perSeat = Math.floor(remaining.length / 4);
  
  const weighted = remaining.map(c => ({
    card: c,
    weight: otherSeats.reduce((w, s) => w + (suitWeights[s][c.suit] || 0), 0) + Math.random() * 3
  })).sort((a, b) => b.weight - a.weight);
  
  for (let i = 0; i < 4; i++) {
    const seat = otherSeats[i];
    const seatCards = [];
    for (let j = 0; j < perSeat; j++) {
      const idx = weighted.findIndex(w => {
        const ww = suitWeights[seat][w.card.suit] || 0;
        return ww > 0 ? Math.random() < 0.7 : true;
      });
      const pick = idx >= 0 ? weighted.splice(idx, 1)[0] : weighted.shift();
      if (pick) seatCards.push(pick.card);
    }
    others[i] = seatCards;
  }
  
  return others;
}

function estimateWinningPointsPIMC(hand, trump, params, bidHistory, mySeat, openKitty, timeBudgetMs, playedCards, voids, seat) {
  const startTime = Date.now();
  let samples = 0;
  const maxSamples = params?.bidMaxSamples ?? 500;
  
  const loseStats = Array.from({ length: 11 }, () => ({ count: 0, totalEnemyPts: 0 }));
  const winStats = Array.from({ length: 11 }, () => ({ count: 0, totalMyPts: 0 }));
  let totalMyPts = 0;
  
  while (samples < maxSamples && Date.now() - startTime < timeBudgetMs) {
    const allySeat = determineVirtualAlly(hand, bidHistory, mySeat);
    const others = sampleOpponentHands(hand, bidHistory, mySeat, openKitty);
    const hands = [[], [], [], [], []];
    hands[mySeat] = hand.map(c => ({ ...c }));
    
    let oIdx = 0;
    for (let s = 0; s < 5; s++) {
      if (s === mySeat) continue;
      hands[s] = others[oIdx++].map(c => ({ ...c }));
    }

    let enemyPoints = 0;
    let enemyTricks = 0;
    let teamTricks = 0;
    let teamPoints = 0;
    let active = mySeat;
    const trickCount = hand.length;
    
    for (let t = 0; t < trickCount; t++) {
      if (!hands[mySeat].length) break;
      const trick = [];
      for (let i = 0; i < 5; i++) {
        const seat2 = (active + i) % 5;
        const seatHand = hands[seat2];
        if (!seatHand.length) break;
        const chosen = smartRolloutPlay(seat2, mySeat, allySeat, seatHand, trick, trump, t);
        if (!chosen) break;
        trick.push({ seat: seat2, card: chosen });
        hands[seat2] = seatHand.filter(c => c.id !== chosen.id);
      }
      if (trick.length < 5) break;
      const winner = winningEntry({ suit: trump }, t, trick);
      const pts = trick.filter(e => ['10', 'J', 'Q', 'K', 'A'].includes(e.card.rank)).length;
      
      if (winner.seat !== mySeat && winner.seat !== allySeat) {
        enemyTricks++;
        enemyPoints += pts;
      } else {
        teamTricks++;
        teamPoints += pts;
      }
      active = winner.seat;
    }
    
    loseStats[enemyTricks].count++;
    loseStats[enemyTricks].totalEnemyPts += enemyPoints;
    winStats[teamTricks].count++;
    winStats[teamTricks].totalMyPts += teamPoints;
    totalMyPts += teamPoints;
    samples++;
  }
  
  const lossTable = params.lossPointMap || [0, 2, 4, 5, 7, 9, 11, 13, 15, 17, 20];
  const winTable = params.winPointMap || [0, 2, 4, 6, 8, 10, 12, 14, 16, 18, 20];
  
  let totalExpectedEnemyPts = 0;
  loseStats.forEach((st, tricks) => {
    if (st.count === 0) return;
    const prob = st.count / samples;
    const mappedLoss = lossTable[tricks] ?? (st.totalEnemyPts / st.count);
    totalExpectedEnemyPts += mappedLoss * prob;
  });
  const expectedFromEnemy = Math.max(0, 20 - totalExpectedEnemyPts);
  
  let totalExpectedMyPts = 0;
  winStats.forEach((st, tricks) => {
    if (st.count === 0) return;
    const prob = st.count / samples;
    const mappedWin = winTable[tricks] ?? (st.totalMyPts / st.count);
    totalExpectedMyPts += mappedWin * prob;
  });
  
  const expectedPoints = Math.max(expectedFromEnemy, totalExpectedMyPts);
  
  return {
    expectedPoints,
    loseDetails: loseStats.map((st, tricks) => ({ tricks, prob: st.count / samples, avgPts: st.count ? st.totalEnemyPts / st.count : 0 })),
    winDetails: winStats.map((st, tricks) => ({ tricks, prob: st.count / samples, avgPts: st.count ? st.totalMyPts / st.count : 0 })),
    samples
  };
}

export function evaluateBidPlan(hand, trump, params, bidHistory, mySeat, openKitty, playedCards = [], voids = [{},{},{},{},{}]) {
  const sure = computeSurePoints(hand, trump, openKitty, playedCards, voids, mySeat);
  const timeBudget = params?.bidTimeBudgetMs ?? 400;
  const pimcResult = estimateWinningPointsPIMC(hand, trump, params, bidHistory, mySeat, openKitty, timeBudget, playedCards, voids, mySeat);
  
  const baseExpected = Math.max(sure, sure * 0.3 + pimcResult.expectedPoints * 0.7);
  
  const suitRunValues = [];
  for (const suit of SUITS) {
    if (suit === trump) continue;
    const myCards = hand.filter(c => c.suit === suit).sort((a, b) => RANKS.indexOf(b.rank) - RANKS.indexOf(a.rank));
    if (myCards.length < 3) continue;
    let consecutive = 0;
    for (let i = 0; i < myCards.length; i++) {
      const expectedRank = RANKS[RANKS.length - 1 - i];
      if (myCards[i].rank === expectedRank) consecutive++;
      else break;
    }
    const runValue = consecutive >= 3 ? consecutive * 0.8 : consecutive * 0.4;
    suitRunValues.push({ suit, consecutive, runValue, cardCount: myCards.length });
  }
  suitRunValues.sort((a, b) => b.runValue - a.runValue);
  
  const runSuits = suitRunValues.filter(x => x.consecutive >= 3).map(x => x.suit);
  const preserveSuits = suitRunValues.filter(x => x.consecutive < 3).map(x => x.suit);
  
  return {
    trump,
    expectedWins: baseExpected,
    baseExpected,
    sureWins: sure,
    runSuits,
    preserveSuits,
    suitRunValues,
    pimcDetail: pimcResult
  };
}

// ==========================================
// ★ 新規: トスアップ戦略
// ==========================================

export function getRoleCards(hand, trump) {
  const mighty = hand.some(c => c.id === '♠A');
  const trumpJ = trump !== 'NT' ? hand.some(c => c.rank === 'J' && c.suit === trump) : false;
  const sameColorJ = trump !== 'NT' ? hand.some(c => c.rank === 'J' && c.suit !== trump && isSameColorSuit(c.suit, trump)) : false;
  const count = (mighty ? 1 : 0) + (trumpJ ? 1 : 0) + (sameColorJ ? 1 : 0);
  return { mighty, trumpJ, sameColorJ, count };
}

export function isTwoRole(hand, trump) {
  return getRoleCards(hand, trump).count >= 2;
}

export function isThreeRole(hand, trump) {
  return getRoleCards(hand, trump).count >= 3;
}

export function canSendS1(hand, trump, params) {
  if (trump === 'NT') return false;
  const sameColorSuit = sameColorSuitOf(trump);
  const hasSameColorJ = hand.some(c => c.rank === 'J' && c.suit === sameColorSuit);
  if (!hasSameColorJ) return false;
  const minorCards = hand.filter(c => c.rank === 'A' || c.rank === '2').length;
  return minorCards >= (params?.s1RequiredMinorCards ?? 2);
}

export function canSendS3(hand, params) {
  const nonMightyAces = hand.filter(c => c.rank === 'A' && c.id !== '♠A').length;
  return nonMightyAces >= (params?.s3RequiredAces ?? 2);
}

export function evaluateRiskTransfer(hand, currentHigh, params, matchScores) {
  if (!currentHigh || currentHigh.num !== 17) return { canTransfer: false, targetBid: 0 };
  if (!currentHigh.suit || currentHigh.suit === 'NT') return { canTransfer: false, targetBid: 0 };
  const sameColorSuit = sameColorSuitOf(currentHigh.suit);
  const hasSameColorRole = hand.some(c => c.suit === sameColorSuit && (c.rank === 'J' || c.rank === 'A'));
  if (!hasSameColorRole) return { canTransfer: false, targetBid: 0 };
  return { canTransfer: true, targetBid: 20 };
}

export function countSameColorBidders(bidSignals, bidHistory, trumpSuit) {
  if (!trumpSuit || trumpSuit === 'NT') return 0;
  const sameColor = sameColorSuitOf(trumpSuit);
  const colorSuits = new Set([trumpSuit, sameColor]);
  const bidders = new Set();
  (bidHistory || []).forEach(b => {
    if (colorSuits.has(b.suit)) bidders.add(b.seat);
  });
  return bidders.size;
}

export function detectPartnerSignal(bidSignals, bidHistory, currentHigh, mySeat) {
  if (!currentHigh || currentHigh.num < 13 || currentHigh.player === mySeat) return null;
  const received = bidSignals?.received || [];
  if (!received.length) return null;
  return received[received.length - 1];
}

export function computeProperBid(hand, trump, params, mySeat, bidSignals, matchScores, openKitty, playedCards, voids, bidHistory) {
  const plan = evaluateBidPlan(hand, trump, params, bidHistory, mySeat, openKitty, playedCards, voids);
  const baseExpected = plan.expectedWins;
  
  let signalBonus = 0;
  const received = bidSignals?.received || [];
  const hasS1 = received.some(s => s.type === 'S1');
  const hasS2 = received.some(s => s.type === 'S2');
  const hasThreeRole = received.some(s => s.type === '3ROLE');
  const hasS3 = received.some(s => s.type === 'S3');
  
  if (hasThreeRole) signalBonus = params.signalThreeRoleBonus ?? 4;
  else if (hasS2) signalBonus = params.signalS2Bonus ?? 2;
  else if (hasS3) signalBonus = params.signalS3Bonus ?? 2;
  else if (hasS1) signalBonus = params.signalS1Bonus ?? 1;
  
  let safetyMargin = params.tossUpSafetyMargin ?? 0.5;
  if (matchScores && Array.isArray(matchScores)) {
    const sorted = [...matchScores].sort((a, b) => b - a);
    const myScore = matchScores[mySeat] || 0;
    const rank = sorted.indexOf(myScore) + 1;
    if (rank >= 4) safetyMargin = params.tossUpSafetyMarginBottom ?? 0.0;
  }
  
  const expected = baseExpected + signalBonus - safetyMargin;
  const properBid = Math.max(13, Math.min(20, Math.floor(expected)));
  
  return {
    properBid,
    baseExpected,
    signalBonus,
    safetyMargin,
    expected,
    plan
  };
}

export function bidPacing(currentBid, properBid, lastBidAt, pacingMs) {
  const now = Date.now();
  const elapsed = now - (lastBidAt || 0);
  const shouldWait = elapsed < pacingMs;
  
  if (currentBid >= properBid) {
    return { nextBid: currentBid, shouldWait: false, waitMs: 0, reachedProper: true };
  }
  if (shouldWait) {
    return { nextBid: currentBid, shouldWait: true, waitMs: pacingMs - elapsed, reachedProper: false };
  }
  return { nextBid: Math.min(currentBid + 1, properBid), shouldWait: false, waitMs: 0, reachedProper: false };
}

export function classifySignalType(bidHistory, seat, trump) {
  const seatBids = (bidHistory || []).filter(b => b.seat === seat);
  if (seatBids.length < 2) return null;
  const last = seatBids[seatBids.length - 1];
  const prev = seatBids[seatBids.length - 2];
  if (isSameColorSuit(prev.suit, last.suit) && prev.num === last.num) {
    return 'S2';
  }
  return 'S1';
}

export function canSendSignal(hand, currentHigh, mySeat, bidSignals, params, matchScores) {
  const result = { S1: false, S2: false, S3: false, S4: false, targetSuit: null, targetBid: 0 };
  if (!currentHigh || currentHigh.num < 13 || currentHigh.player === mySeat) return result;
  
  const trump = currentHigh.suit;
  const sameColorBidders = countSameColorBidders(bidSignals, [], trump);
  const limit = trump === 'NT' ? (params.ntBidderLimit ?? 2) : (params.sameColorBidderLimit ?? 2);
  
  const myTwoRole = isTwoRole(hand, trump);
  if (sameColorBidders >= limit && !myTwoRole) return result;
  
  const rt = evaluateRiskTransfer(hand, currentHigh, params, matchScores);
  if (rt.canTransfer) {
    result.S4 = true;
    result.targetSuit = sameColorSuitOf(trump);
    result.targetBid = 20;
    return result;
  }
  
  if (trump === 'NT') {
    if (canSendS3(hand, params)) {
      result.S3 = true;
      result.targetSuit = 'NT';
      result.targetBid = currentHigh.num + 1;
    }
    return result;
  }
  
  if (canSendS1(hand, trump, params)) {
    result.S1 = true;
    result.targetSuit = sameColorSuitOf(trump);
    result.targetBid = currentHigh.num;
    
    if (isTwoRole(hand, trump)) {
      result.S2 = true;
    }
  }
  
  return result;
}

// ==========================================
// shouldBid
// ==========================================

export function shouldBid(hand, currentHigh, minBid, params, bidHistory = [], mySeat = 0, experience = null, matchScores = null, openKitty = null, playedCards = [], voids = [{},{},{},{},{}]) {
  if (!Array.isArray(hand) || !hand.length) return null;
  if (!params) params = defaultStrategy();
  
  const bidSignals = params.bidSignals || { sent: null, received: [], sameColorCount: 0, lastBidAt: 0 };
  const isFirstBid = (!currentHigh || currentHigh.num < 13);
  const currentHighNum = currentHigh?.num ?? 12;
  
  const baseStr = handStrength(hand);
  const bidThreshold = params.bidThreshold ?? 3.5;
  
  if (isFirstBid && baseStr < bidThreshold) return null;
  
  const suitScores = SUITS.map(suit => ({ suit, score: colorStrength(hand, suit, params) }));
  suitScores.sort((a, b) => b.score - a.score);
  const topSuits = suitScores.slice(0, 2).map(x => x.suit);
  const ntScore = ntHandStrength(hand, params);
  
  const currentRound = Math.max(0, ...(bidHistory || []).map(b => b?.round || 0));
  const currentBids = (bidHistory || []).filter(b => b && b.round === currentRound);
  
  const candidates = [];
  for (const suit of topSuits) {
    const proper = computeProperBid(hand, suit, params, mySeat, bidSignals, matchScores, openKitty, playedCards, voids, currentBids);
    const minViable = Math.max(minBid, currentHighNum + 1, 13);
    if (proper.properBid >= minViable) {
      candidates.push({ suit, properBid: proper.properBid, expected: proper.expected, baseExpected: proper.baseExpected, plan: proper.plan });
    }
  }
  
  if (ntScore > 6) {
    const ntProper = computeProperBid(hand, 'NT', params, mySeat, bidSignals, matchScores, openKitty, playedCards, voids, currentBids);
    const minViable = Math.max(minBid, currentHighNum + 1, 13);
    if (ntProper.properBid >= minViable) {
      candidates.push({ suit: 'NT', properBid: ntProper.properBid, expected: ntProper.expected, baseExpected: ntProper.baseExpected, plan: ntProper.plan });
    }
  }
  
  const signal = canSendSignal(hand, currentHigh, mySeat, bidSignals, params, matchScores);
  if (signal.S4 && currentHigh.player !== mySeat) {
    return { num: 20, suit: signal.targetSuit, solo: false, signal: 'S4', plan: null };
  }
  if (signal.S2 && currentHigh.player !== mySeat) {
    return { num: currentHigh.num, suit: signal.targetSuit, solo: false, signal: 'S2', plan: null };
  }
  if (signal.S3 && currentHigh.player !== mySeat) {
    return { num: currentHigh.num + 1, suit: 'NT', solo: false, signal: 'S3', plan: null };
  }
  if (signal.S1 && currentHigh.player !== mySeat) {
    return { num: currentHigh.num, suit: signal.targetSuit, solo: false, signal: 'S1', plan: null };
  }
  
  if (!candidates.length) {
    if (isFirstBid && baseStr >= bidThreshold) {
      const bestSuit = topSuits[0];
      return { num: Math.max(minBid, 13), suit: bestSuit, solo: false, plan: null };
    }
    return null;
  }
  
  candidates.sort((a, b) => b.expected - a.expected);
  const best = candidates[0];
  
  if (currentHighNum >= 13 && best.properBid <= currentHighNum) {
    if (currentHigh.suit !== best.suit && !isSameColorSuit(currentHigh.suit, best.suit)) {
      return null;
    }
    return { num: Math.min(20, currentHighNum + 1), suit: best.suit, solo: false, plan: best.plan };
  }
  
  const targetNum = Math.min(best.properBid, Math.max(minBid, currentHighNum + 1));
  return { num: targetNum, suit: best.suit, solo: false, plan: best.plan };
}

// ==========================================
// ★ 新規: 欠落していた3関数
// ==========================================

export function chooseDiscard(hand, trump) {
  if (!Array.isArray(hand) || hand.length <= 2) return hand.slice();
  const isTrumpCard = c => trump !== 'NT' && c.suit === trump;
  const score = c => {
    if (c.id === '♠A') return 10000;
    if (trump !== 'NT' && c.rank === 'J' && c.suit === trump) return 9500;
    if (trump !== 'NT' && c.rank === 'J' && c.suit !== trump && isSameColorSuit(c.suit, trump)) return 9000;
    if (c.id === '♥Q') return 8500;
    if (c.rank === 'A' && !isTrumpCard(c)) return 8000;
    if (c.rank === 'K' && !isTrumpCard(c)) return 7000;
    if (isTrumpCard(c)) return 6000 + RANKS.indexOf(c.rank);
    return RANKS.indexOf(c.rank);
  };
  const sorted = hand.slice().sort((a, b) => score(a) - score(b));
  return sorted.slice(0, 2);
}

export function chooseDeputyCall(hand, kitty, trump, level, num, params, experience) {
  const isTrumpSuit = trump !== 'NT';
  const sameColor = isTrumpSuit ? sameColorSuitOf(trump) : '♠';
  const isIn = id => hand.some(c => c.id === id);
  const inKitty = id => (kitty || []).some(c => c.id === id);

  if (!isIn('♠A') && !inKitty('♠A')) return { suit: '♠', rank: 'A', id: '♠A' };
  if (isTrumpSuit && !isIn(trump + 'J') && !inKitty(trump + 'J')) return { suit: trump, rank: 'J', id: trump + 'J' };
  if (isTrumpSuit && !isIn(sameColor + 'J') && !inKitty(sameColor + 'J')) return { suit: sameColor, rank: 'J', id: sameColor + 'J' };

  const weakSuits = SUITS.filter(s => s !== trump).sort((a, b) => {
    const aLen = hand.filter(c => c.suit === a).length;
    const bLen = hand.filter(c => c.suit === b).length;
    return aLen - bLen;
  });
  for (const s of weakSuits) {
    if (!isIn(s + 'A') && !inKitty(s + 'A')) return { suit: s, rank: 'A', id: s + 'A' };
  }
  for (const s of weakSuits) {
    if (!isIn(s + '2') && !inKitty(s + '2')) return { suit: s, rank: '2', id: s + '2' };
  }
  for (const s of SUITS) {
    if (s === trump) continue;
    for (const r of RANKS) {
      const id = s + r;
      if (!isIn(id) && !inKitty(id)) return { suit: s, rank: r, id };
    }
  }
  return { suit: '♠', rank: '2', id: '♠2' };
}

export function chooseSoloCall(hand, trump) {
  if (!Array.isArray(hand) || !hand.length) return null;
  const sorted = hand.slice().sort((a, b) => {
    const diff = RANKS.indexOf(a.rank) - RANKS.indexOf(b.rank);
    if (diff !== 0) return diff;
    return SV[a.suit] - SV[b.suit];
  });
  return { suit: sorted[0].suit, rank: sorted[0].rank, id: sorted[0].id };
}

// ==========================================
// プレイ関数群
// ==========================================

function isFace(c) { return FACE.includes(c.rank); }
function isSameColorJ(c, contract) { return contract.suit !== 'NT' && c.rank === 'J' && c.suit !== contract.suit && isSameColorSuit(c.suit, contract.suit); }
function isTrumpJ(c, contract) { return contract.suit !== 'NT' && c.rank === 'J' && c.suit === contract.suit; }
function isTeamNap(seat, contract) { return seat === contract.nap || (!contract.solo && contract.revealedCall && seat === contract.deputy); }
function countVoidSeats(voids, suit, excludeSeat) { let count = 0; for (let s = 0; s < 5; s++) if (s !== excludeSeat && voids[s]?.[suit]) count++; return count; }

function isAbsoluteWinner(card, contract, trick, playedCards) {
  if (card.id === '♠A' && !trick.some(e => e.card.id === '♥Q')) return true;
  if (isTrumpJ(card, contract)) return true;
  if (isSameColorJ(card, contract) && !trick.some(e => isTrumpJ(e.card, contract))) return true;
  if (card.rank === 'A') {
    const suitPlayed = (playedCards || []).filter(c => c.suit === card.suit).length;
    if (suitPlayed >= 3) return true;
    const ledSuit = trick.length > 0 ? trick[0].card.suit : card.suit;
    if (!trick.every(e => e.card.suit === ledSuit)) return true;
  }
  return false;
}

function pickDumpFace(followCards, contract, currentRank, opts = {}) {
  const { excludeId = null } = opts;
  const dumpable = followCards.filter(c => !(excludeId && c.id === excludeId) && isFace(c) && c.id !== '♠A' && !isTrumpJ(c, contract) && !isSameColorJ(c, contract) && c.rank !== 'A' && c.rank !== 'K');
  return dumpable.length ? dumpable.sort((a, b) => RANKS.indexOf(a.rank) - RANKS.indexOf(b.rank))[0] : null;
}

function keepValue(c, ctx) {
  const { trickNo, contract, playedCards, hand } = ctx;
  if (c.id === '♠A') return 2000;
  if (isTrumpJ(c, contract)) return 1900;
  if (isSameColorJ(c, contract)) return 1800;
  if (c.id === '♥Q') return 1700;
  if (c.rank === '2') {
    if (trickNo >= 8) return 0;
    const playedIds = new Set((playedCards || []).map(pc => pc.id));
    if (['10', 'J', 'Q', 'K', 'A'].every(r => playedIds.has(c.suit + r))) return 0;
    return 50;
  }
  const playedIds = new Set((playedCards || []).map(pc => pc.id));
  const myIds = new Set((hand || []).map(hc => hc.id));
  let isStrongestInSuit = true;
  if (isTrump(contract, c)) isStrongestInSuit = false;
  else {
    for (const r of RANKS.slice().reverse()) {
      const id = c.suit + r;
      if (playedIds.has(id)) continue;
      if (myIds.has(id)) { if (id === c.id) break; else { isStrongestInSuit = false; break; } }
      isStrongestInSuit = false; break;
    }
  }
  if (isStrongestInSuit) return 1000;
  return ['10', 'J', 'Q', 'K', 'A'].includes(c.rank) ? 100 + RANKS.indexOf(c.rank) : RANKS.indexOf(c.rank);
}

function lowX(ctx, cards) {
  if (!cards || !cards.length) return null;
  const sorted = cards.slice().sort((a, b) => {
    const va = keepValue(a, ctx), vb = keepValue(b, ctx);
    if (va !== vb) return va - vb;
    return cardPower(ctx.contract, ctx.trickNo, a, ctx.trick) - cardPower(ctx.contract, ctx.trickNo, b, ctx.trick);
  });
  if (keepValue(sorted[0], ctx) === 0) return sorted[0];
  if (!ctx.experience || sorted.length < 2) return sorted[0];
  const role = ctx.seat === ctx.contract.nap ? 'nap' : ((!ctx.contract.solo && ctx.contract.revealedCall && ctx.seat === ctx.contract.deputy) ? 'dep' : 'ally');
  const look = sorted.slice(0, Math.min(2, sorted.length));
  let best = look[0], bestScore = -Infinity;
  for (const c of look) {
    const exp = ctx.experience.plays?.[playExperienceKey(role, trickPhaseOf(ctx.trickNo), pointsTierOf((ctx.trick || []).filter(e => isFace(e.card)).length), rankTierOf(c.rank))];
    let s = (exp && exp.samples >= 3) ? (exp.wins / exp.samples) * experienceConfidence(exp.samples) : 0;
    if (s > bestScore) { bestScore = s; best = c; }
  }
  return best;
}

function chooseNapoleonLead(ctx) {
  const { hand, legal, contract, trickNo, playedCards, voids, seat, params, call, discardedKitty, currentNapPoints } = ctx;
  if (!legal || !legal.length) return null;
  const isNT = contract.suit === 'NT';
  const plan = contract.bidPlan;
  
  if (plan && trickNo <= 3) {
    for (const suit of (plan.runSuits || [])) {
      const suitCards = legal.filter(c => c.suit === suit);
      if (suitCards.length) {
        return suitCards.sort((a, b) => RANKS.indexOf(b.rank) - RANKS.indexOf(a.rank))[0];
      }
    }
    const safeLeads = legal.filter(c => c.rank === 'A' && c.suit !== contract.suit);
    if (safeLeads.length) return safeLeads[0];
  }
  
  if (!isNT && trickNo <= (params.napEarlyTrumpLeadMaxTrick ?? 3)) {
    const myTrumps = hand.filter(c => c.suit === contract.suit);
    const playedTrumps = playedCards.filter(c => c.suit === contract.suit).length;
    const remainingTrumps = Math.max(0, 13 - playedTrumps - myTrumps.length);
    
    if (myTrumps.length >= (params.napEarlyTrumpMinCount ?? 4) && remainingTrumps > 0) {
      const trumpLeads = legal.filter(c => c.suit === contract.suit && c.rank !== 'A' && c.rank !== 'K' && c.rank !== 'J' && c.rank !== '2');
      if (trumpLeads.length && Math.random() < (params.napEarlyTrumpLeadWeight ?? 1.5)) {
        return trumpLeads.sort((a, b) => RANKS.indexOf(b.rank) - RANKS.indexOf(a.rank))[0];
      }
      const otherTrumpLeads = legal.filter(c => c.suit === contract.suit && c.rank !== 'A' && c.rank !== 'K' && c.rank !== 'J');
      if (otherTrumpLeads.length && Math.random() < (params.napEarlyTrumpLeadWeight ?? 1.5) * 0.7) {
        return otherTrumpLeads.sort((a, b) => RANKS.indexOf(b.rank) - RANKS.indexOf(a.rank))[0];
      }
    }
  }

  if (isNT && trickNo > 0 && trickNo <= 5) {
    const suitsWithAce = SUITS.filter(s => hand.some(c => c.suit === s && c.rank === 'A'));
    for (const suit of suitsWithAce) {
      const playedInSuit = playedCards.filter(c => c.suit === suit).length;
      const voidCount = countVoidSeats(voids, suit, seat);
      if (playedInSuit < 4 && voidCount === 0) {
        const weakCards = legal.filter(c => c.suit === suit && c.rank !== '2' && ['3','4','5','6','7','8','9'].includes(c.rank));
        if (weakCards.length && Math.random() < (params.ntAceProtectLeadWeight ?? 1.5) * 0.5) {
          return weakCards.sort((a, b) => RANKS.indexOf(a.rank) - RANKS.indexOf(b.rank))[0];
        }
      }
    }
  }

  if (isNT) {
    const mighty = legal.find(c => c.id === '♠A');
    const hqPlayed = playedCards.some(c => c.id === '♥Q');
    const hqInDiscard = (discardedKitty || []).some(c => c.id === '♥Q');
    const isMightySafe = hqPlayed || hqInDiscard;
    
    if (mighty) {
      const holdThreshold = params.ntMightyHoldThreshold ?? 8;
      const emergencyThreshold = params.ntMightyEmergencyTrick ?? 5;
      if (trickNo < holdThreshold && !(trickNo >= emergencyThreshold)) {
        const otherAces = legal.filter(c => c.rank === 'A' && c.id !== '♠A');
        if (otherAces.length) return otherAces[0];
        const lowCards = legal.filter(c => c.rank !== 'A' && c.rank !== 'K' && c.rank !== '2');
        if (lowCards.length) return lowCards.sort((a, b) => RANKS.indexOf(a.rank) - RANKS.indexOf(b.rank))[0];
      }
    }
    
    const safeAces = legal.filter(c => c.rank === 'A' && c.id !== '♠A');
    if (safeAces.length) return safeAces[0];
    if (mighty && isMightySafe && trickNo >= (params.ntMightyHoldThreshold ?? 8)) return mighty;
    
    if (trickNo > 0 && trickNo <= 5) {
      const suitsWithAce = SUITS.filter(s => hand.some(c => c.suit === s && c.rank === 'A'));
      const twosToClear = legal.filter(c => c.rank === '2' && suitsWithAce.includes(c.suit) && !playedCards.some(pc => pc.suit === c.suit && pc.rank === '2'));
      if (twosToClear.length && Math.random() < (params.ntSameTwoGuardWeight ?? 1.2) * 0.5) return twosToClear[0];
    }
    if (trickNo > 0 && trickNo <= 4) {
      const freshTwos = legal.filter(c => c.rank === '2' && !playedCards.some(pc => pc.suit === c.suit));
      if (freshTwos.length) return freshTwos[0];
    }
  }
  
  const allTakeAvoid = contract.num < 20 && (currentNapPoints || 0) >= 19;
  if (allTakeAvoid) {
    const offSuitLow = legal.filter(c => !isTrump(contract, c) && c.id !== '♠A' && c.rank !== 'A' && !(c.rank === 'J' && (c.suit === contract.suit || isSameColorSuit(c.suit, contract.suit))));
    if (offSuitLow.length) return offSuitLow.slice().sort((a, b) => RANKS.indexOf(a.rank) - RANKS.indexOf(b.rank))[0];
    return lowX(ctx, legal);
  }
  if (trickNo === 0) {
    const safeAces = legal.filter(c => c.rank === 'A' && c.suit !== contract.suit);
    if (safeAces.length) {
      const nonMightyAces = safeAces.filter(c => c.id !== '♠A');
      if (nonMightyAces.length) return nonMightyAces[0];
      if (playedCards.some(c => c.id === '♥Q') || (discardedKitty || []).some(c => c.id === '♥Q')) return safeAces.find(c => c.id === '♠A');
    }
    const candidates = legal.filter(c => c.rank !== '2');
    return (candidates.length ? candidates : legal).sort((a, b) => cardPower(contract, trickNo, a, []) - cardPower(contract, trickNo, b, []) )[0];
  }
  if (trickNo <= 3) {
    const tj = legal.find(c => isTrumpJ(c, contract));
    if (tj) return tj;
    const scj = legal.find(c => isSameColorJ(c, contract));
    if (scj) return scj;
  }
  if (trickNo >= 6) {
    const sureWinners = legal.filter(c => isAbsoluteWinner(c, contract, [], playedCards));
    if (sureWinners.length) return sureWinners[0];
  }
  const safeAces = legal.filter(c => {
    if (c.rank !== 'A' || c.suit === contract.suit) return false;
    if (c.id === '♠A') return playedCards.some(pc => pc.id === '♥Q') || countVoidSeats(voids, '♠', seat) === 0;
    if (hand.some(hc => hc.suit === c.suit && hc.rank === '2')) return true;
    if ((discardedKitty || []).some(k => k.id === c.suit + '2')) return true;
    if (playedCards.some(pc => pc.suit === c.suit && pc.rank === '2')) return countVoidSeats(voids, c.suit, seat) === 0;
    return false;
  });
  if (safeAces.length) return safeAces.sort((a, b) => playedCards.filter(pc => pc.suit === b.suit).length - playedCards.filter(pc => pc.suit === a.suit).length)[0];
  const suitLens = SUITS.filter(s => s !== contract.suit).map(s => ({ suit: s, count: legal.filter(c => c.suit === s).length })).sort((a, b) => b.count - a.count);
  for (const sl of suitLens) {
    if (sl.count >= 3) {
      const low = legal.filter(c => c.suit === sl.suit && !isFace(c) && c.rank !== '2').sort((a, b) => RANKS.indexOf(a.rank) - RANKS.indexOf(b.rank))[0];
      if (low) return low;
    }
  }
  const finalCandidates = legal.filter(c => c.rank !== '2');
  return (finalCandidates.length ? finalCandidates : legal).sort((a, b) => cardPower(contract, trickNo, a, []) - cardPower(contract, trickNo, b, []) )[0];
}

function chooseNapoleonFollow(ctx) {
  const { hand, legal, trick, trickNo, contract, playedCards, voids, seat, currentNapPoints, params, call } = ctx;
  if (!legal || !legal.length) return null;
  const current = winningEntry(contract, trickNo, trick, trick.length < 5);
  const isTeamWinning = current && isTeamNap(current.seat, contract);
  const pointsInTrick = trick.filter(e => isFace(e.card)).length;
  const winningCards = legal.filter(c => winningEntry(contract, trickNo, [...trick, { seat, card: c }], trick.length < 4)?.seat === seat);
  const low = cards => cards.slice().sort((a, b) => cardPower(contract, trickNo, a, trick) - cardPower(contract, trickNo, b, trick))[0];
  const napPoints = currentNapPoints || 0;
  
  if (contract.suit === 'NT' && trickNo > 0 && trickNo <= 5) {
    const ledSuit = trick[0].card.suit;
    const hasAceInLed = hand.some(c => c.suit === ledSuit && c.rank === 'A');
    if (hasAceInLed && countVoidSeats(voids, ledSuit, seat) === 0) {
      const weakFollow = legal.filter(c => c.suit === ledSuit && c.rank !== '2' && ['3','4','5','6','7','8','9'].includes(c.rank));
      if (weakFollow.length) return weakFollow[0];
    }
  }

  if (contract.num < 20 && napPoints >= 19) {
    const nonWinning = legal.filter(c => !winningCards.includes(c));
    return lowX(ctx, nonWinning.length ? nonWinning : legal);
  }
  const remainingTricks = Math.max(1, 10 - trickNo - (trick.length >= 4 ? 1 : 0));
  const needed = Math.max(0, contract.num - napPoints);
  const urgency = needed / remainingTricks;
  
  if (isTeamWinning) {
    const safeCards = legal.filter(c => c.rank !== 'A' && c.rank !== 'K' && c.id !== call?.id && !isTrumpJ(c, contract) && !isSameColorJ(c, contract) && c.rank !== '2');
    if (safeCards.length) {
      const dumpFaces = safeCards.filter(c => isFace(c));
      if (dumpFaces.length) return dumpFaces.sort((a,b) => RANKS.indexOf(a.rank) - RANKS.indexOf(b.rank))[0];
      return lowX(ctx, safeCards);
    }
    return lowX(ctx, legal);
  }
  
  if (pointsInTrick > 0 && winningCards.length) {
    if (legal[0]?.suit !== trick[0].card.suit) {
      const trumps = winningCards.filter(c => isTrump(contract, c));
      if (trumps.length) return low(trumps);
    }
    return low(winningCards);
  }
  if (trickNo >= 6 && winningCards.length) return low(winningCards);
  if (urgency >= 1.2 && winningCards.length) return low(winningCards);
  return lowX(ctx, legal);
}

export function chooseDeputyCard(ctx) {
  const { hand, legal, trick, trickNo, contract, call, seat, playedCards, voids, params, discardedKitty } = ctx;
  if (!legal || !legal.length) return null;
  const low = cards => cards.slice().sort((a, b) => cardPower(contract, trickNo, a, trick) - cardPower(contract, trickNo, b, trick))[0];
  const winningCards = legal.filter(c => winningEntry(contract, trickNo, [...trick, { seat, card: c }], trick.length < 4)?.seat === seat);
  
  const current = winningEntry(contract, trickNo, trick, trick.length < 5);
  const isTeamWinning = current && isTeamNap(current.seat, contract);
  const pointsInTrick = trick.filter(e => isFace(e.card)).length;
  
  const myCalledCard = legal.find(c => c.id === call?.id);
  if (myCalledCard) {
    if (trick.length === 4 && pointsInTrick === 0 && isTeamWinning) {
      const others = legal.filter(c => c.id !== call.id);
      if (others.length) return low(others);
    }
    return myCalledCard;
  }

  if (contract.suit === 'NT' && trickNo < (params?.ntDeputyMightyHoldThreshold ?? 8)) {
    const mighty = legal.find(c => c.id === '♠A');
    if (mighty) {
      const napWinning = trick.length > 0 && isTeamNap(winningEntry(contract, trickNo, trick, trick.length < 5)?.seat, contract);
      if (!napWinning && pointsInTrick >= 3) {
        // 緊急時は切る
      } else {
        const otherWins = winningCards.filter(c => c.id !== '♠A');
        if (otherWins.length) return low(otherWins);
        const nonMighty = legal.filter(c => c.id !== '♠A');
        if (nonMighty.length) return lowX(ctx, nonMighty);
      }
    }
  }

  if (!trick.length) {
    if (contract.suit === 'NT') {
      const suitScores = {};
      SUITS.forEach(s => suitScores[s] = 0);
      const napWeakLeads = (playedCards || []).filter(c => c.seat === contract.nap && ['3','4','5','6','7','8','9'].includes(c.rank)).map(c => c.suit);
      napWeakLeads.forEach(s => { suitScores[s] += 2.0; });
      const kittyTwos = (discardedKitty || []).filter(c => c.rank === '2').map(c => c.suit);
      kittyTwos.forEach(s => { suitScores[s] += 1.5; });
      SUITS.forEach(s => {
        if (!playedCards.some(c => c.id === s + 'A') && !hand.some(c => c.id === s + 'A') && !(discardedKitty || []).some(c => c.id === s + 'A')) suitScores[s] += 1.0;
      });
      SUITS.forEach(s => { if (voids[contract.nap]?.[s]) suitScores[s] = -999; });
      const sortedSuits = SUITS.slice().sort((a, b) => suitScores[b] - suitScores[a]);
      for (const suit of sortedSuits) {
        if (suitScores[suit] <= 0) break;
        const lowCards = legal.filter(c => c.suit === suit && !isFace(c) && c.rank !== '2');
        if (lowCards.length) return lowCards.sort((a, b) => RANKS.indexOf(a.rank) - RANKS.indexOf(b.rank))[0];
      }
    }
    const napCanWinSuit = (suit) => voids[contract.nap]?.[suit] && (contract.suit !== 'NT' ? 13 - (playedCards || []).filter(c => c.suit === contract.suit).length : 0) > 0;
    const secureAces = legal.filter(c => c.rank === 'A' && !isTrumpJ(c, contract) && !isSameColorJ(c, contract));
    if (secureAces.length) {
      const ace = secureAces[0];
      if (napCanWinSuit(ace.suit)) {
        if (trickNo >= 4) return ace;
        const lowCards = legal.filter(c => c.rank !== 'A' && c.suit !== contract.suit);
        if (lowCards.length) return low(lowCards);
      } else return ace;
    }
    const winningLeads = legal.filter(c => c.rank === 'A' || isTrumpJ(c, contract) || isSameColorJ(c, contract));
    if (winningLeads.length) return winningLeads[0];
    if (contract.suit !== 'NT') {
      const trumps = legal.filter(c => isTrump(contract, c));
      if (trumps.length) return low(trumps);
    }
    const candidates = trickNo === 0 ? legal.filter(c => c.rank !== '2') : legal;
    return lowX(ctx, candidates.length ? candidates : legal);
  }
  
  const ledSuit = trick[0].card.suit;
  const napCard = trick.find(e => e.seat === contract.nap)?.card;
  const isEnemyWinning = current && !isTeamNap(current.seat, contract);
  
  if (isTeamWinning) {
    const nonCalled = legal.filter(c => c.id !== call?.id);
    return lowX(ctx, nonCalled.length ? nonCalled : legal);
  }

  if (contract.suit !== 'NT' && trick[0].seat === contract.nap && ledSuit === contract.suit && isEnemyWinning && pointsInTrick > 0) {
    const isVoidInLed = !legal.some(c => c.suit === ledSuit);
    if (isVoidInLed) {
      const trumpWins = winningCards.filter(c => isTrump(contract, c));
      if (trumpWins.length) {
        const myCalledTrump = trumpWins.find(c => c.id === call?.id);
        if (myCalledTrump) return myCalledTrump;
        if (Math.random() < (params?.deputyOvertrumpWeight ?? 1.8) * 0.6) {
          return trumpWins.sort((a, b) => RANKS.indexOf(a.rank) - RANKS.indexOf(b.rank))[0];
        }
      }
    }
  }

  if (napCard && isAbsoluteWinner(napCard, contract, trick, playedCards)) {
    const followCards = legal.filter(c => c.suit === ledSuit);
    if (followCards.length > 0) {
      const safeFollow = followCards.filter(c => !isTrumpJ(c, contract) && !isSameColorJ(c, contract) && c.id !== '♠A');
      if (safeFollow.length > 0) {
        if (trickNo < 3 && Math.random() < (params?.deputyBluffWeight ?? 0.8) * 0.3) {
           return safeFollow.slice().sort((a, b) => RANKS.indexOf(a.rank) - RANKS.indexOf(b.rank))[0];
        }
        return safeFollow.slice().sort((a, b) => RANKS.indexOf(a.rank) - RANKS.indexOf(b.rank))[0];
      }
      const dump = pickDumpFace(followCards, contract, napCard.rank, { excludeId: call?.id });
      if (dump) return dump;
      return followCards[0];
    }
    return lowX(ctx, legal);
  }
  
  if (!isTeamNap(current.seat, contract) && pointsInTrick > 0) {
    if (winningCards.length) {
      const scoreWins = winningCards.filter(c => isFace(c));
      if (scoreWins.length) return scoreWins.sort((a, b) => RANKS.indexOf(b.rank) - RANKS.indexOf(a.rank))[0];
      return low(winningCards);
    } else {
      const nonScore = legal.filter(c => !isFace(c));
      if (nonScore.length) return lowX(ctx, nonScore);
    }
  }
  if (pointsInTrick > 0 && winningCards.length) return low(winningCards);
  if (call?.suit && call.suit !== contract.suit && ledSuit === call.suit) {
    const myAce = legal.find(c => c.suit === call.suit && c.rank === 'A');
    if (myAce && winningCards.includes(myAce)) return myAce;
  }
  return lowX(ctx, legal);
}

function estimateNapWeakSuit(playedCards, contract) {
  const counts = {};
  for (const c of (playedCards || []).filter(c => c.seat === contract.nap)) counts[c.suit] = (counts[c.suit] || 0) + 1;
  const entries = Object.entries(counts).sort((a, b) => b[1] - a[1]);
  return entries[0]?.[0] || null;
}

function chooseAllianceLead(ctx) {
  const { hand, legal, trickNo, contract, params, playedCards, voids, seat } = ctx;
  if (!legal || !legal.length) return null;
  const isNT = contract.suit === 'NT';
  
  if (isNT && trickNo > 0 && trickNo <= 5) {
    const suitsWithAce = SUITS.filter(s => hand.some(c => c.suit === s && c.rank === 'A'));
    for (const suit of suitsWithAce) {
      const playedInSuit = playedCards.filter(c => c.suit === suit).length;
      if (playedInSuit < 4 && countVoidSeats(voids, suit, seat) === 0) {
        const weakCards = legal.filter(c => c.suit === suit && c.rank !== '2' && ['3','4','5','6','7','8','9'].includes(c.rank));
        if (weakCards.length && Math.random() < (params.ntAceProtectLeadWeight ?? 1.5) * 0.5) {
          return weakCards.sort((a, b) => RANKS.indexOf(a.rank) - RANKS.indexOf(b.rank))[0];
        }
      }
    }
  }

  if (isNT) {
    const napVoidSuits = SUITS.filter(s => voids[contract.nap]?.[s]);
    if (napVoidSuits.length > 0) {
      const exploitSuit = napVoidSuits[0];
      const exploitCards = legal.filter(c => c.suit === exploitSuit);
      if (exploitCards.length) return exploitCards.sort((a, b) => RANKS.indexOf(a.rank) - RANKS.indexOf(b.rank))[0];
    }
    const myAces = legal.filter(c => c.rank === 'A');
    if (myAces.length) return myAces[0];
    const allyWinningSuit = SUITS.find(s => s !== contract.suit && !voids[seat]?.[s]);
    if (allyWinningSuit) {
      const lowCards = legal.filter(c => c.suit === allyWinningSuit && !isFace(c));
      if (lowCards.length) return lowCards[0];
    }
  }
  
  const allyVoidSuits = SUITS.filter(s => s !== contract.suit && [0,1,2,3,4].some(i => i !== seat && i !== contract.nap && voids[i]?.[s]));
  if (allyVoidSuits.length > 0 && Math.random() < (params.allyVoidExploitWeight ?? 1.0) * 0.3) {
    const exploit = legal.filter(c => allyVoidSuits.includes(c.suit) && !isFace(c));
    if (exploit.length) return exploit[0];
  }

  const p = params || {};
  if (trickNo > 0 && trickNo <= (p.allySameTwoWindow ?? 4)) {
    const faceRanks = ['10', 'J', 'Q', 'K', 'A'];
    const playedIds = new Set((playedCards || []).map(pc => pc.id));
    const freshTwos = legal.filter(c => c.rank === '2' && (contract.suit === 'NT' || c.suit !== contract.suit) && !(playedCards || []).some(pc => pc.suit === c.suit) && countVoidSeats(voids, c.suit, seat) === 0 && (contract.suit === 'NT' || !voids[contract.nap]?.[c.suit]) && !faceRanks.every(r => playedIds.has(c.suit + r)));
    if (freshTwos.length && Math.random() < (p.allySameTwoLeadChance ?? 0.55)) return freshTwos[0];
  }
  if (contract.suit !== 'NT') {
    const trump = contract.suit, sc = sameColorSuitOf(trump), avoidSuits = [trump, sc].filter(Boolean);
    const leadable = legal.filter(c => !avoidSuits.includes(c.suit) && !isFace(c) && (trickNo > 0 || c.rank !== '2'));
    if (leadable.length && Math.random() < Math.min(1.0, p.napWeaknessLeadWeight ?? 0.8)) {
      const bySuitLen = SUITS.filter(s => !avoidSuits.includes(s)).map(s => ({ suit: s, cards: leadable.filter(c => c.suit === s) })).filter(x => x.cards.length > 0).sort((a, b) => b.cards.length - a.cards.length);
      if (bySuitLen.length) return bySuitLen[0].cards.sort((a, b) => RANKS.indexOf(a.rank) - RANKS.indexOf(b.rank))[0];
    }
  }
  if (contract.suit === 'NT') {
    const spadeLow = legal.filter(c => c.suit === '♠' && !isFace(c) && (trickNo > 0 || c.rank !== '2'));
    if (spadeLow.length && trickNo <= 3 && Math.random() < (p.spadeLeadPriority || 0.7) + 0.2) return spadeLow.sort((a, b) => RANKS.indexOf(a.rank) - RANKS.indexOf(b.rank))[0];
    const weakSuit = estimateNapWeakSuit(playedCards, contract);
    if (weakSuit) {
      const weakLow = legal.filter(c => c.suit === weakSuit && !isFace(c) && (trickNo > 0 || c.rank !== '2'));
      if (weakLow.length) return weakLow[0];
    }
  }
  const suitLens = SUITS.map(s => ({ suit: s, cards: legal.filter(c => c.suit === s) })).filter(x => x.suit !== contract.suit && x.cards.length >= 3).sort((a, b) => b.cards.length - a.cards.length);
  for (const sl of suitLens) {
    const lowCard = sl.cards.filter(c => !isFace(c) && (trickNo > 0 || c.rank !== '2'))[0];
    if (lowCard) return lowCard;
  }
  const finalCandidates = trickNo === 0 ? legal.filter(c => c.rank !== '2') : legal;
  return (finalCandidates.length ? finalCandidates : legal).slice().sort((a, b) => cardPower(contract, trickNo, a, []) - cardPower(contract, trickNo, b, []) )[0];
}

function chooseAllianceFollow(ctx) {
  const { legal, trick, trickNo, contract, params, seat, playedCards, hand, voids } = ctx;
  if (!legal || !legal.length) return null;
  const low = cards => cards.slice().sort((a, b) => cardPower(contract, trickNo, a, trick) - cardPower(contract, trickNo, b, trick))[0];
  const ledSuit = trick[0].card.suit;
  const current = winningEntry(contract, trickNo, trick, trick.length < 5);
  const pointsInTrick = trick.filter(e => isFace(e.card)).length;
  const isAllyWinning = current && current.seat !== contract.nap && (!contract.solo && current.seat !== contract.deputy);
  const isEnemyWinning = !isAllyWinning;
  const winningCards = legal.filter(c => winningEntry(contract, trickNo, [...trick, { seat, card: c }], trick.length < 4)?.seat === seat);
  
  if (contract.suit === 'NT' && trickNo > 0 && trickNo <= 5) {
    const hasAceInLed = hand.some(c => c.suit === ledSuit && c.rank === 'A');
    if (hasAceInLed && countVoidSeats(voids, ledSuit, seat) === 0) {
      const weakFollow = legal.filter(c => c.suit === ledSuit && c.rank !== '2' && ['3','4','5','6','7','8','9'].includes(c.rank));
      if (weakFollow.length) return weakFollow[0];
    }
  }

  if (trickNo > 0) {
    const myTwo = legal.find(c => c.rank === '2' && c.suit === ledSuit);
    if (myTwo) {
      const isFirstRound = (playedCards || []).filter(pc => pc.suit === ledSuit).length === 0;
      if (isFirstRound) {
        if (contract.suit !== 'NT') return myTwo;
        else {
          const napCard = trick.find(e => e.seat === contract.nap)?.card;
          const napIsFace = napCard && isFace(napCard);
          const napOrder = trick.findIndex(e => e.seat === contract.nap);
          const myOrder = trick.length;
          const isBeforeNap = napOrder === -1 || myOrder < napOrder;
          if (isBeforeNap || napIsFace || pointsInTrick >= 2) return myTwo;
          const dumpFaces = legal.filter(c => isFace(c) && c.id !== myTwo.id);
          if (dumpFaces.length) return dumpFaces[0];
        }
      }
    }
  }
  if (isAllyWinning) {
    const followCards = legal.filter(c => c.suit === ledSuit);
    if (followCards.length > 0) {
      const dump = pickDumpFace(followCards, contract, current.card.rank);
      if (dump) return dump;
      const scoreCards = followCards.filter(c => isFace(c) && c.id !== '♠A');
      if (scoreCards.length) return scoreCards.sort((a, b) => RANKS.indexOf(b.rank) - RANKS.indexOf(a.rank))[0];
    }
    return lowX(ctx, legal);
  }
  if (isEnemyWinning && pointsInTrick > 0) {
    if (winningCards.length) {
      const scoreWins = winningCards.filter(c => isFace(c));
      if (scoreWins.length) return scoreWins.sort((a, b) => RANKS.indexOf(b.rank) - RANKS.indexOf(a.rank))[0];
      return low(winningCards);
    } else {
      const nonScore = legal.filter(c => !isFace(c));
      if (nonScore.length) return lowX(ctx, nonScore);
    }
  }
  if (trickNo >= 1 && pointsInTrick >= 1) {
    const sameTwo = winningCards.find(c => c.rank === '2' && c.suit === ledSuit);
    if (sameTwo) return sameTwo;
  }
  if (pointsInTrick > 0 && winningCards.length) return low(winningCards);
  if (isEnemyWinning && winningCards.length && (pointsInTrick > 0 || trickNo >= 3)) return low(winningCards);
  if (contract.suit !== 'NT' && pointsInTrick > 0 && legal[0]?.suit !== ledSuit && isEnemyWinning) {
    const trumps = legal.filter(c => isTrump(contract, c));
    if (trumps.length) return low(trumps);
  }
  return lowX(ctx, legal);
}

export function chooseCardToPlay(ctx) {
  const { seat, contract, legal, hand } = ctx;
  if (!legal || !legal.length) return null;
  if (seat === contract.nap) {
    if (!ctx.trick.length) return chooseNapoleonLead(ctx);
    return chooseNapoleonFollow(ctx);
  }
  if (!contract.solo && contract.revealedCall && seat === contract.deputy) return chooseDeputyCard(ctx);
  if (!contract.solo && !contract.revealedCall && contract.call && hand.some(c => c.id === contract.call.id)) return chooseDeputyCard(ctx);
  if (!ctx.trick.length) return chooseAllianceLead(ctx);
  return chooseAllianceFollow(ctx);
}

// ==========================================
// MCTS
// ==========================================
function determinizeState(ctx) {
  const unseen = [];
  for (const s of SUITS) for (const r of RANKS) unseen.push(s + r);
  const seen = new Set();
  (ctx.hand || []).forEach(c => seen.add(c.id));
  (ctx.playedCards || []).forEach(c => seen.add(c.id));
  (ctx.discardedKitty || []).forEach(c => seen.add(c.id));
  (ctx.trick || []).forEach(t => seen.add(t.card.id));
  const unseens = unseen.filter(id => !seen.has(id)).map(id => ({ suit: id[0], rank: id.slice(1), id }));
  
  const hands = [[], [], [], [], []];
  hands[ctx.seat] = ctx.hand.slice();
  
  const handCounts = [0,0,0,0,0];
  for (let s = 0; s < 5; s++) {
    if (s === ctx.seat) handCounts[s] = ctx.hand.length;
    else {
      const hasPlayed = ctx.trick.some(t => t.seat === s);
      handCounts[s] = 10 - ctx.trickNo - (hasPlayed ? 1 : 0);
    }
  }
  
  const suitWeights = [{}, {}, {}, {}, {}];
  if (ctx.bidHistory) {
    ctx.bidHistory.forEach(b => {
      if (b.seat !== ctx.seat && b.suit !== 'NT') suitWeights[b.seat][b.suit] = (suitWeights[b.seat][b.suit] || 0) + b.num - 12;
    });
  }

  for (let s = 0; s < 5; s++) {
    if (s === ctx.seat) continue;
    const voidInfo = ctx.voids?.[s] || {};
    let assigned = 0;
    const tempHand = [];
    const targetCount = handCounts[s];
    
    const sortedUnseens = unseens.slice().sort((a, b) => {
      const wa = suitWeights[s][a.suit] || 0;
      const wb = suitWeights[s][b.suit] || 0;
      return (wb + Math.random() * 2) - (wa + Math.random() * 2);
    });

    for (let i = 0; i < sortedUnseens.length && assigned < targetCount; i++) {
      const c = sortedUnseens[i];
      if (voidInfo[c.suit]) continue;
      let weight = 1.0;
      const playedInSuit = (ctx.playedCards || []).filter(pc => pc.seat === s && pc.suit === c.suit).length;
      if (playedInSuit === 0 && ctx.trickNo > 3) weight = 0.8;
      if (Math.random() < weight) {
        tempHand.push(c);
        const idx = unseens.findIndex(u => u.id === c.id);
        if (idx >= 0) unseens.splice(idx, 1);
        assigned++;
      }
    }
    while (assigned < targetCount && unseens.length > 0) {
      tempHand.push(unseens.shift());
      assigned++;
    }
    hands[s] = tempHand;
  }
  return hands;
}

function simulateWithPolicy(state, mySeat, contract, params) {
  let active = state.active;
  let trick = state.trick.slice();
  let trickNo = state.trickNo;
  let hands = state.hands.map(h => h.slice());
  let points = state.points.slice();
  let voids = JSON.parse(JSON.stringify(state.voids || [{},{},{},{},{}]));
  
  const getLegal = (seat) => {
    const h = hands[seat];
    if (!trick.length) return h;
    const ledSuit = trick[0].card.suit;
    const follow = h.filter(c => c.suit === ledSuit);
    return follow.length ? follow : h;
  };
  
  let loopSafety = 0;
  while (trickNo < 10) {
    loopSafety++;
    if (loopSafety > 100) break;
    if (trick.length < 5) {
      const legal = getLegal(active);
      if (!legal.length) break;
      let chosen = null;
      if (Math.random() < (params.rolloutPolicyWeight ?? 0.8)) {
        const playCtx = { seat: active, contract, legal, hand: hands[active], trick, trickNo, playedCards: state.playedCards || [], voids, params, isCurrentNapWinning: false };
        chosen = chooseCardToPlay(playCtx);
      }
      if (!chosen) chosen = legal[Math.floor(Math.random() * legal.length)];
      hands[active] = hands[active].filter(c => c.id !== chosen.id);
      if (trick.length > 0) {
        const ledSuit = trick[0].card.suit;
        if (chosen.suit !== ledSuit) {
          if (!voids[active]) voids[active] = {};
          voids[active][ledSuit] = true;
        }
      }
      trick.push({ seat: active, card: chosen });
      if (trick.length === 5) {
        const wEntry = winningEntry(contract, trickNo, trick);
        const w = wEntry.seat;
        const taken = trick.filter(e => FACE.includes(e.card.rank)).length;
        points[w] += taken;
        active = w;
        trick = [];
        trickNo++;
      } else {
        active = (active + 4) % 5;
      }
    }
  }
  
  const nap = contract.nap, deputy = contract.deputy, isSolo = contract.solo, num = contract.num;
  const napPoints = points[nap] + (isSolo ? 0 : points[deputy]);
  const allyPoints = points.reduce((sum, p, i) => sum + (i !== nap && (isSolo || i !== deputy) ? p : 0), 0);
  const made = napPoints >= num && (num === 20 || napPoints < 20);
  const myTeamIsNap = mySeat === nap || (!isSolo && mySeat === deputy);
  
  let score = 0;
  if (myTeamIsNap) {
    if (made) {
      score = 1.0;
      const overkill = napPoints - num;
      if (overkill > 0 && num < 20) {
        const allyGap = 20 - allyPoints;
        if (allyGap <= 2) score -= overkill * 0.01;
        else score -= overkill * 0.05;
      }
      if (num < 20 && napPoints === num) score += 0.1; 
    } else {
      score = 0.0;
      const gap = num - napPoints;
      score += Math.max(0, 0.5 - gap * 0.1);
      score += Math.min(0.2, napPoints * 0.02);
    }
  } else {
    if (!made) {
      score = 1.0;
      const gap = num - napPoints;
      if (gap >= 3) score += 0.1;
      score += Math.min(0.2, points[mySeat] * 0.05);
    } else {
      score = 0.0;
      const overkill = napPoints - num;
      if (overkill === 0 && allyPoints >= 2) score += 0.3; 
    }
  }
  return Math.max(0, Math.min(1.5, score));
}

export function getMCTSStats(ctx) {
  const legal = ctx.legal;
  const N = {}, W = {};
  legal.forEach(c => { N[c.id] = 0; W[c.id] = 0; });
  if (!legal || legal.length <= 1) return { N, W, iterations: 0 };

  const params = ctx.params || defaultStrategy();
  const cParam = params.mctsExploration || 1.414;
  const startTime = Date.now();
  const maxTimeMs = params.maxThinkTimeMs || 3000; 
  
  let iterations = 0;
  while (iterations < 100000) { 
    if (Date.now() - startTime > maxTimeMs) break;

    let bestCard = null;
    let bestUcb = -Infinity;
    for (const card of legal) {
      if (N[card.id] === 0) { bestCard = card; break; }
      const ucb = W[card.id] / N[card.id] + cParam * Math.sqrt(Math.log(iterations + 1) / N[card.id]);
      if (ucb > bestUcb) { bestUcb = ucb; bestCard = card; }
    }
    if (!bestCard) bestCard = legal[0];
    
    const hands = determinizeState(ctx);
    let trick = ctx.trick.map(t => ({ seat: t.seat, card: t.card }));
    hands[ctx.seat] = hands[ctx.seat].filter(c => c.id !== bestCard.id);
    trick.push({ seat: ctx.seat, card: bestCard });
    let active = (ctx.seat + 4) % 5;
    let trickNo = ctx.trickNo;
    const points = ctx.points ? ctx.points.slice() : [0,0,0,0,0];
    
    const win = simulateWithPolicy({ hands, trick, trickNo, active, points, voids: ctx.voids, playedCards: ctx.playedCards }, ctx.seat, ctx.contract, params);
    
    N[bestCard.id]++;
    W[bestCard.id] += win;
    iterations++;
  }
  return { N, W, iterations };
}

export function chooseCardWithMCTS(ctx) {
  const legal = ctx.legal;
  if (!legal || legal.length <= 1) return legal[0];
  if (ctx.trickNo > 8 && Math.random() > 0.3) return chooseCardToPlay(ctx);
  const { N, W } = getMCTSStats(ctx);
  let bestCard = legal[0];
  let bestWinRate = -1;
  for (const c of legal) {
    const winRate = N[c.id] > 0 ? W[c.id] / N[c.id] : 0;
    if (N[c.id] < 3) continue;
    if (winRate > bestWinRate) { bestWinRate = winRate; bestCard = c; }
  }
  if (bestWinRate === -1) return chooseCardToPlay(ctx);
  return bestCard;
}
