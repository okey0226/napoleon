// ai-tactics.js (トスアップ戦略対応版 / Part 1)
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
        const seat = (active + i) % 5;
        const seatHand = hands[seat];
        if (!seatHand.length) break;
        const chosen = smartRolloutPlay(seat, mySeat, allySeat, seatHand, trick, trump, t);
        if (!chosen) break;
        trick.push({ seat, card: chosen });
        hands[seat] = seatHand.filter(c => c.id !== chosen.id);
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

// ★ 修正: deputyBonus=2.0 を削除。副官期待ボーナスは computeProperBid 側で加算。
export function evaluateBidPlan(hand, trump, params, bidHistory, mySeat, openKitty, playedCards = [], voids = [{},{},{},{},{}]) {
  const sure = computeSurePoints(hand, trump, openKitty, playedCards, voids, mySeat);
  const timeBudget = params?.bidTimeBudgetMs ?? 400;
  const pimcResult = estimateWinningPointsPIMC(hand, trump, params, bidHistory, mySeat, openKitty, timeBudget, playedCards, voids, mySeat);
  
  // ★ 変更: deputyBonus を削除。baseExpected はシグナルなしの素の期待値。
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
    expectedWins: baseExpected,      // ★ シグナルなしの素の期待値（副官ボーナスなし）
    baseExpected,                    // 明示的エイリアス
    sureWins: sure,
    runSuits,
    preserveSuits,
    suitRunValues,
    pimcDetail: pimcResult
  };
}

// ==========================================
// ★ 新規: トスアップ戦略（シグナル検知・適正値・ペーシング）
// ==========================================

// 役カードの判定（黒・赤共通）
export function getRoleCards(hand, trump) {
  const mighty = hand.some(c => c.id === '♠A');
  const trumpJ = trump !== 'NT' ? hand.some(c => c.rank === 'J' && c.suit === trump) : false;
  const sameColorJ = trump !== 'NT' ? hand.some(c => c.rank === 'J' && c.suit !== trump && isSameColorSuit(c.suit, trump)) : false;
  const count = (mighty ? 1 : 0) + (trumpJ ? 1 : 0) + (sameColorJ ? 1 : 0);
  return { mighty, trumpJ, sameColorJ, count };
}

// 2役判定：正J+裏J / マイティ+正J / マイティ+裏J のいずれか2枚
export function isTwoRole(hand, trump) {
  return getRoleCards(hand, trump).count >= 2;
}

// 3役判定：マイティ+正J+裏J の3枚
export function isThreeRole(hand, trump) {
  return getRoleCards(hand, trump).count >= 3;
}

// S1発動条件：同色のJ所持 + A/2を合計2枚以上（スート問わず）
export function canSendS1(hand, trump, params) {
  if (trump === 'NT') return false;
  const sameColorSuit = sameColorSuitOf(trump);
  const hasSameColorJ = hand.some(c => c.rank === 'J' && c.suit === sameColorSuit);
  if (!hasSameColorJ) return false;
  const minorCards = hand.filter(c => c.rank === 'A' || c.rank === '2').length;
  return minorCards >= (params?.s1RequiredMinorCards ?? 2);
}

// S3発動条件：マイティ以外のAを2枚以上（色不問）
export function canSendS3(hand, params) {
  const nonMightyAces = hand.filter(c => c.rank === 'A' && c.id !== '♠A').length;
  return nonMightyAces >= (params?.s3RequiredAces ?? 2);
}

// S4発動条件：同色異スートで20を宣言可能（17検知時）
export function evaluateRiskTransfer(hand, currentHigh, params, matchScores) {
  if (!currentHigh || currentHigh.num !== 17) return { canTransfer: false, targetBid: 0 };
  if (!currentHigh.suit || currentHigh.suit === 'NT') return { canTransfer: false, targetBid: 0 };
  // 同色異スートで20が宣言可能か（自分の手札に同色の役があるか）
  const sameColorSuit = sameColorSuitOf(currentHigh.suit);
  const hasSameColorRole = hand.some(c => c.suit === sameColorSuit && (c.rank === 'J' || c.rank === 'A'));
  if (!hasSameColorRole) return { canTransfer: false, targetBid: 0 };
  return { canTransfer: true, targetBid: 20 };
}

// 同色立会い人数のカウント（♠♣ / ♥♦ を同一色として扱う）
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

// 受信シグナルの検知（最新の受信シグナルを返す）
export function detectPartnerSignal(bidSignals, bidHistory, currentHigh, mySeat) {
  if (!currentHigh || currentHigh.num < 13 || currentHigh.player === mySeat) return null;
  const received = bidSignals?.received || [];
  if (!received.length) return null;
  const latest = received[received.length - 1];
  return latest;
}

// 適正値の計算
export function computeProperBid(hand, trump, params, mySeat, bidSignals, matchScores, openKitty, playedCards, voids, bidHistory) {
  const plan = evaluateBidPlan(hand, trump, params, bidHistory, mySeat, openKitty, playedCards, voids);
  const baseExpected = plan.expectedWins;
  
  // シグナルボーナス
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
  
  // 安全マージン（順位補正）
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

// ペーシング制御（4秒間隔で+1ずつ）
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

// シグナル種別の分類（送信履歴から）
export function classifySignalType(bidHistory, seat, trump) {
  const seatBids = (bidHistory || []).filter(b => b.seat === seat);
  if (seatBids.length < 2) return null;
  const last = seatBids[seatBids.length - 1];
  const prev = seatBids[seatBids.length - 2];
  // 2スート連続（S2）
  if (isSameColorSuit(prev.suit, last.suit) && prev.num === last.num) {
    // 3回目（3役）の判定は呼び出し側で行う
    return 'S2';
  }
  return 'S1';
}

// シグナル送信可否の総合判定
export function canSendSignal(hand, currentHigh, mySeat, bidSignals, params, matchScores) {
  const result = { S1: false, S2: false, S3: false, S4: false, targetSuit: null, targetBid: 0 };
  if (!currentHigh || currentHigh.num < 13 || currentHigh.player === mySeat) return result;
  
  const trump = currentHigh.suit;
  const sameColorBidders = countSameColorBidders(bidSignals, [], trump);
  const limit = trump === 'NT' ? (params.ntBidderLimit ?? 2) : (params.sameColorBidderLimit ?? 2);
  
  // 自分が2役を持つ時のみ3人でも許容
  const myTwoRole = isTwoRole(hand, trump);
  if (sameColorBidders >= limit && !myTwoRole) return result;
  
  // S4（17検知時）
  const rt = evaluateRiskTransfer(hand, currentHigh, params, matchScores);
  if (rt.canTransfer) {
    result.S4 = true;
    result.targetSuit = sameColorSuitOf(trump);
    result.targetBid = 20;
    return result;
  }
  
  // NT立会い時はS3優先
  if (trump === 'NT') {
    if (canSendS3(hand, params)) {
      result.S3 = true;
      result.targetSuit = 'NT';
      result.targetBid = currentHigh.num + 1;
    }
    return result;
  }
  
  // スート立会い時はS1/S2
  if (canSendS1(hand, trump, params)) {
    result.S1 = true;
    result.targetSuit = sameColorSuitOf(trump);
    result.targetBid = currentHigh.num;
    
    // 2役ならS2
    if (isTwoRole(hand, trump)) {
      result.S2 = true;
    }
  }
  
  return result;
}

// ==========================================
// 競り判断（shouldBid 修正版）
// ==========================================

export function shouldBid(hand, currentHigh, minBid, params, bidHistory = [], mySeat = 0, experience = null, matchScores = null, openKitty = null, playedCards = [], voids = [{},{},{},{},{}]) {
  if (!Array.isArray(hand) || !hand.length) return null;
  if (!params) params = defaultStrategy();
  
  const bidSignals = params.bidSignals || { sent: null, received: [], sameColorCount: 0, lastBidAt: 0 };
  const isFirstBid = (!currentHigh || currentHigh.num < 13);
  const currentHighNum = currentHigh?.num ?? 12;
  
  // 13スタートの判断：手札強度が閾値以上なら立つ（適正値が13未満でも情報収集のため立つ）
  const baseStr = handStrength(hand);
  const bidThreshold = params.bidThreshold ?? 3.5;
  
  // 初回：手札が弱すぎる場合は立たない（勝ち周2-3枚程度）
  if (isFirstBid && baseStr < bidThreshold) return null;
  
  // 適正値計算（上位スート候補）
  const suitScores = SUITS.map(suit => ({ suit, score: colorStrength(hand, suit, params) }));
  suitScores.sort((a, b) => b.score - a.score);
  const topSuits = suitScores.slice(0, 2).map(x => x.suit);
  const ntScore = ntHandStrength(hand, params);
  
  const currentRound = Math.max(0, ...(bidHistory || []).map(b => b?.round || 0));
  const currentBids = (bidHistory || []).filter(b => b && b.round === currentRound);
  
  // 各候補スートの適正値を計算
  const candidates = [];
  for (const suit of topSuits) {
    const proper = computeProperBid(hand, suit, params, mySeat, bidSignals, matchScores, openKitty, playedCards, voids, currentBids);
    // 現在のhighを超える最低枚数
    const minViable = Math.max(minBid, currentHighNum + 1, 13);
    if (proper.properBid >= minViable) {
      candidates.push({ suit, properBid: proper.properBid, expected: proper.expected, baseExpected: proper.baseExpected, plan: proper.plan });
    }
  }
  
  // NT候補
  if (ntScore > 6) {
    const ntProper = computeProperBid(hand, 'NT', params, mySeat, bidSignals, matchScores, openKitty, playedCards, voids, currentBids);
    const minViable = Math.max(minBid, currentHighNum + 1, 13);
    if (ntProper.properBid >= minViable) {
      candidates.push({ suit: 'NT', properBid: ntProper.properBid, expected: ntProper.expected, baseExpected: ntProper.baseExpected, plan: ntProper.plan });
    }
  }
  
  // シグナル送信の判断（自分が立つより、サポートに回る方が良い場合）
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
  
  // 自分が立つ場合
  if (!candidates.length) {
    // 初回で立つべきだが候補がない → 13で立つ（情報収集）
    if (isFirstBid && baseStr >= bidThreshold) {
      const bestSuit = topSuits[0];
      return { num: Math.max(minBid, 13), suit: bestSuit, solo: false, plan: null };
    }
    return null;
  }
  
  candidates.sort((a, b) => b.expected - a.expected);
  const best = candidates[0];
  
  // 現在のhighを超えられない場合は承認
  if (currentHighNum >= 13 && best.properBid <= currentHighNum) {
    // 異色の相手が適正値を超えている → 撤退
    if (currentHigh.suit !== best.suit && !isSameColorSuit(currentHigh.suit, best.suit)) {
      return null;
    }
    // 同色/シグナルの場合は応戦（適正値+1）
    const signalBonus = params.signalS1Bonus ?? 1;
    return { num: Math.min(20, currentHighNum + 1), suit: best.suit, solo: false, plan: best.plan };
  }
  
  // 適正値まで段階上げ（現在のbid+1）
  const targetNum = Math.min(best.properBid, Math.max(minBid, currentHighNum + 1));
  return { num: targetNum, suit: best.suit, solo: false, plan: best.plan };
}
