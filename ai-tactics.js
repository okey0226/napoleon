// ai-tactics.js 内の該当箇所を以下のように書き換え

function computeSurePoints(hand, trump, openKitty) {
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
    if (hand.some(c => c.suit === suit && c.rank === 'A')) sure += 0.8;
  }
  if (trump !== 'NT' && hand.some(c => c.suit === trump && c.rank === 'A')) sure += 1;
  
  sure += computeSuitRunWins(hand, trump) * 0.5;
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

// 仮想の副官（味方）を決定する
function determineVirtualAlly(myHand, bidHistory, mySeat) {
  // 自分が持っていない強いカード（A, J）を探す
  const missingStrong = ['♠A', '♠J', '♥J', '♦J', '♣J'].filter(id => !myHand.some(c => c.id === id));
  if (missingStrong.length === 0) return mySeat; // 全部持ってるならソロ
  
  // ビッド履歴から、そのスートをビッドしたプレイヤーを優先的に味方と仮定する
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

function estimateWinningPointsPIMC(hand, trump, params, bidHistory, mySeat, openKitty, timeBudgetMs) {
  const startTime = Date.now();
  let totalPoints = 0;
  let samples = 0;
  const maxSamples = params?.bidMaxSamples ?? 500;
  
  while (samples < maxSamples && Date.now() - startTime < timeBudgetMs) {
    const allySeat = determineVirtualAlly(hand, bidHistory, mySeat);
    const others = sampleOpponentHands(hand, bidHistory, mySeat, openKitty);
    const hands = [[], [], [], [], []];
    hands[mySeat] = hand.map(c => ({ ...c }));
    
    // 他のプレイヤーに手札を割り当てる
    let oIdx = 0;
    for (let s = 0; s < 5; s++) {
      if (s === mySeat) continue;
      hands[s] = others[oIdx++].map(c => ({ ...c }));
    }

    let myPoints = 0;
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
      if (winner.seat === mySeat || winner.seat === allySeat) {
        // 味方が勝ったら、そのトリックの得点札をカウント
        const pts = trick.filter(e => ['10', 'J', 'Q', 'K', 'A'].includes(e.card.rank)).length;
        myPoints += pts;
      }
      active = winner.seat;
    }
    totalPoints += myPoints;
    samples++;
  }
  
  return samples > 0 ? totalPoints / samples : 0;
}

export function evaluateBidPlan(hand, trump, params, bidHistory, mySeat, openKitty) {
  const sure = computeSurePoints(hand, trump, openKitty);
  const pimc = estimateWinningPointsPIMC(hand, trump, params, bidHistory, mySeat, openKitty, 200);
  const expected = Math.max(sure, pimc * 0.85 + sure * 0.15);
  
  // 以下は既存のまま
  const suitRunValues = [];
  // ...
  return {
    trump,
    expectedWins: expected, // 名前はそのまま（内部的にはポイント）
    sureWins: sure,
    runSuits,
    preserveSuits,
    suitRunValues
  };
}

export function shouldBid(hand, currentHigh, minBid, params, bidHistory = [], mySeat = 0, experience = null, matchScores = null, openKitty = null) {
  if (!Array.isArray(hand) || !hand.length) return null;
  if (!params) params = defaultStrategy();
  
  // ★ 修正: 強さの足切りを少し緩める (6.0 -> 4.5)
  const baseStr = handStrength(hand);
  const bidThreshold = params.bidThreshold ?? 4.5;
  if (!Number.isFinite(baseStr) || baseStr < bidThreshold) return null;
  
  const isFirstBid = (!currentHigh || currentHigh.num < 13);
  // 最初の競りで少し慎重にするのは残す
  if (isFirstBid && baseStr < bidThreshold + 1.0) return null;
  
  const currentHighNum = currentHigh?.num ?? 12;
  if (currentHighNum >= 15 && baseStr < bidThreshold + 2.0) return null;
  if (currentHighNum >= 17 && baseStr < bidThreshold + 4.0) return null;

  let safetyMargin = params.bidSafetyMargin ?? 1.5;
  if (matchScores && Array.isArray(matchScores)) {
    const sorted = [...matchScores].sort((a, b) => b - a);
    const myScore = matchScores[mySeat] || 0;
    const rank = sorted.indexOf(myScore) + 1;
    if (rank >= 4) safetyMargin = Math.max(0.5, safetyMargin - 0.5);
    else if (rank === 1) safetyMargin += 0.5;
  }

  const currentRound = Math.max(0, ...(bidHistory || []).map(b => b?.round || 0));
  const currentBids = (bidHistory || []).filter(b => b && b.round === currentRound);
  const targetMin = Math.max(minBid, (currentHigh?.num ?? 12) + 1, 13);
  if (targetMin > 20) return null;

  const suitScores = SUITS.map(suit => ({ suit, score: colorStrength(hand, suit, params) }));
  suitScores.sort((a, b) => b.score - a.score);
  const topSuits = suitScores.slice(0, 2).map(x => x.suit);
  const ntScore = ntHandStrength(hand, params);
  
  const timeBudget = (params.bidTimeBudgetMs ?? 400) / (topSuits.length + 1);
  const candidates = [];
  
  for (const suit of topSuits) {
    const plan = evaluateBidPlan(hand, suit, params, currentBids, mySeat, openKitty);
    const maxBid = Math.floor(plan.expectedWins - safetyMargin);
    for (let num = targetMin; num <= Math.min(20, maxBid); num++) {
      // 期待得点から勝率を推定（既存の estimatedWinRate は強さベースなので、expectedWins を渡す）
      const p = estimatedWinRate(plan.expectedWins, num);
      candidates.push({ num, suit, solo: false, expected: plan.expectedWins, p, plan });
    }
  }
  
  if (ntScore > 8) {
    const ntPlan = evaluateBidPlan(hand, 'NT', params, currentBids, mySeat, openKitty);
    const ntMaxBid = Math.floor(ntPlan.expectedWins - safetyMargin);
    for (let num = targetMin; num <= Math.min(20, ntMaxBid); num++) {
      const p = estimatedWinRate(ntPlan.expectedWins, num);
      const ntBonus = num >= (params.highBidNtThreshold ?? 17) ? 1.1 : 1.0;
      candidates.push({ num, suit: 'NT', solo: false, expected: ntPlan.expectedWins, p: p * ntBonus, plan: ntPlan });
    }
  }
  
  for (const suit of topSuits) {
    const trumps = hand.filter(c => c.suit === suit);
    if (trumps.length < 5) continue;
    const plan = evaluateBidPlan(hand, suit, params, currentBids, mySeat, openKitty);
    // ソロの場合は副官がいないので、期待得点を少し下げて評価する
    const expected = plan.expectedWins * 0.9 + 0.5;
    const maxBid = Math.floor(expected - safetyMargin - 1.0);
    if (maxBid < targetMin) continue;
    for (let num = targetMin; num <= Math.min(20, maxBid); num++) {
      const p = estimatedWinRate(expected, num);
      if (p < 0.60) continue;
      candidates.push({ num, suit, solo: true, expected, p, plan });
    }
  }

  if (!candidates.length) return null;

  candidates.sort((a, b) => {
    const diff = b.expected - a.expected;
    if (Math.abs(diff) < 0.3) return a.num - b.num;
    return diff;
  });

  const best = candidates[0];
  if (best && best.expected >= best.num + safetyMargin) {
    return { num: best.num, suit: best.suit, solo: best.solo, plan: best.plan };
  }
  return null;
}
