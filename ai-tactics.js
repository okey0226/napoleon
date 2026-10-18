import { SUITS, RANKS, SV, CALIBRATION, defaultStrategy, sweetSpotFactor, estimatedWinRate, SWEET_SPOT_BONUS } from './constants.js';

// ==========================================
// 1. 基本ルールとカードの強さ判定
// ==========================================
export function isTrump(contract, c) {
  return contract.suit !== "NT" && c.suit === contract.suit;
}

export function cardPower(contract, trickNo, card, trick) {
  const led = trick.length > 0 ? trick[0].card.suit : card.suit;
  const allSame = trick.every(x => x.card.suit === led);
  const mighty = trick.some(x => x.card.id === "♠A");

  if (trickNo > 0) {
    if (mighty && card.id === "♥Q") return 10000;
    if (card.id === "♠A") return 9000;
    if (contract.suit !== "NT" && card.rank === "J" && card.suit === contract.suit) return 8000;
    const sameColor = (a, b) => (a === "♣" || a === "♠") === (b === "♣" || b === "♠");
    if (contract.suit !== "NT" && card.rank === "J" && card.suit !== contract.suit && sameColor(card.suit, contract.suit)) return 7000;
    if (allSame && card.suit === led && card.rank === "2") return 6000;
  }

  if (isTrump(contract, card)) return 5000 + RANKS.indexOf(card.rank);
  if (card.suit === led) return 3000 + RANKS.indexOf(card.rank);
  return 1000 + RANKS.indexOf(card.rank);
}

export function winningEntry(contract, trickNo, trick) {
  if (!trick || !trick.length) return null;
  return trick.reduce((best, x) => 
    cardPower(contract, trickNo, x.card, trick) > cardPower(contract, trickNo, best.card, trick) ? x : best, trick[0]
  );
}

// ==========================================
// 2. 手札評価
// ==========================================
function suitValue(hand, suit) {
  const weight = { "10": 1, J: 1.8, Q: 2.6, K: 3.5, A: 4.7 };
  const cards = hand.filter(c => c.suit === suit);
  return cards.reduce((n, c) => n + (weight[c.rank] || 0), 0) + Math.max(0, cards.length - 3) * .75;
}

export function strongestSuit(hand, suits = SUITS) {
  return suits.slice().sort((a, b) => suitValue(hand, b) - suitValue(hand, a) || SV[b] - SV[a])[0];
}

export function handStrength(hand) {
  return hand.reduce((n, c) => n + (RANKS.indexOf(c.rank) > 9 ? 1.25 : RANKS.indexOf(c.rank) > 7 ? 0.45 : 0) + (c.rank === "A" ? 0.35 : 0), 0) + suitValue(hand, strongestSuit(hand)) * 0.3;
}

// ▼ 新規: solo用の手札強度
// 役札（♠A・切札J）を独占していると、副官協力なしでも戦える
export function soloAdjustedStrength(hand, trump) {
  const base = handStrength(hand);
  const hasMighty = hand.some(c => c.id === '♠A');
  const hasTrumpJ = trump !== 'NT' && hand.some(c => c.rank === 'J' && c.suit === trump);
  const roleBonus = (hasMighty ? 1.5 : 0) + (hasTrumpJ ? 1.0 : 0);
  return base + roleBonus;
}

// ==========================================
// 3. 競り（shouldBid）: p=55-60%を狙う + solo判定 + 18以上対応
// ==========================================
export function shouldBid(hand, currentHigh, minBid, params) {
  const strength = handStrength(hand);
  const bestSuit = strongestSuit(hand);
  const soloStrength = soloAdjustedStrength(hand, bestSuit);

  let bestBid = null;
  let maxEV = 0;

  const targetMin = Math.max(minBid, (currentHigh.num ?? 12) + 1, 13);

  // 通常立ちを評価
  for (let num = targetMin; num <= 20; num++) {
    const p = estimatedWinRate(strength, num);
    const bonus = sweetSpotFactor(p);
    const highBoost = 1 + 0.5 * Math.max(0, num - 17);
    const ev = p * bonus * SWEET_SPOT_BONUS * highBoost;
    if (ev > maxEV) {
      maxEV = ev;
      bestBid = { num, suit: bestSuit, solo: false };
    }
  }

  // 一人立ちを評価（1.5倍のEV補正）
  for (let num = targetMin; num <= 20; num++) {
    const p = estimatedWinRate(soloStrength, num);
    const bonus = sweetSpotFactor(p);
    const highBoost = 1 + 0.5 * Math.max(0, num - 17);
    const ev = p * bonus * SWEET_SPOT_BONUS * highBoost * 1.5;
    if (ev > maxEV) {
      maxEV = ev;
      bestBid = { num, suit: bestSuit, solo: true };
    }
  }

  // 期待値が閾値以上なら宣言
  const threshold = Math.max(0.3, 1.0 - params.riskTolerance);
  if (bestBid && maxEV >= threshold) {
    return bestBid;
  }
  return null;
}

// ==========================================
// 4. 捨て札・指名
// ==========================================
export function chooseDiscard(hand, trump) {
  const value = c => {
    let v = RANKS.indexOf(c.rank);
    if (c.suit === trump) v += 20;
    return v;
  };
  return hand.slice().sort((a, b) => value(a) - value(b)).slice(0, 2);
}

export function chooseDeputyCall(hand, discard, trump, level, bid) {
  const used = new Set([...hand, ...discard].map(c => c.id));
  const sameColor = (a, b) => (a === '♣' || a === '♠') === (b === '♣' || b === '♠');

  const roleCards = [];
  if (!used.has('♠A')) roleCards.push({ suit: '♠', rank: 'A', id: '♠A' });
  if (trump !== 'NT') {
    if (!used.has(trump + 'J')) roleCards.push({ suit: trump, rank: 'J', id: trump + 'J' });
    const sameColorSuit = SUITS.find(s => s !== trump && sameColor(s, trump));
    if (sameColorSuit && !used.has(sameColorSuit + 'J')) roleCards.push({ suit: sameColorSuit, rank: 'J', id: sameColorSuit + 'J' });
  }

  if (roleCards.length > 0) return roleCards[0];

  const myAces = hand.filter(c => c.rank === 'A');
  for (const ace of myAces) {
    const suitCount = hand.filter(c => c.suit === ace.suit).length;
    if (suitCount >= 2) {
      const two = { suit: ace.suit, rank: '2', id: ace.suit + '2' };
      if (!used.has(two.id)) return two;
    }
  }
  for (const suit of SUITS) {
    if (hand.some(c => c.suit === suit && c.rank === 'A')) continue;
    if (hand.some(c => c.suit === suit && c.rank === '2')) {
      const two = { suit, rank: '2', id: suit + '2' };
      if (!used.has(two.id)) return two;
    }
  }
  for (const suit of SUITS) {
    if (hand.some(c => c.suit === suit && c.rank === 'A')) continue;
    const ace = { suit, rank: 'A', id: suit + 'A' };
    if (!used.has(ace.id)) return ace;
  }

  const cands = [];
  for (const s of SUITS) for (const r of RANKS) if (!used.has(s + r)) cands.push({ suit: s, rank: r, id: s + r });
  if (!cands.length) return { suit: "♠", rank: "A", id: "♠A" };
  return cands[0];
}

// ▼ 新規: 意図的solo用の指名（自分の手札から価値の低い札を選ぶ）
export function chooseSoloCall(hand) {
  if (!hand.length) return { suit: "♠", rank: "A", id: "♠A" };
  // 弱い札から選ぶ（使い道の少ない札を指名札に）
  return hand.slice().sort((a, b) => RANKS.indexOf(a.rank) - RANKS.indexOf(b.rank))[0];
}

// ==========================================
// 5. カウンティング
// ==========================================
function isSameColor(suit1, suit2) {
  const black = ['♣', '♠'];
  return black.includes(suit1) === black.includes(suit2);
}

function getStrongestUnplayedTrump(playedCards, trumpSuit) {
  if (trumpSuit === 'NT') return null;
  const playedIds = new Set(playedCards.map(c => c.id));
  const candidates = [];
  if (!playedIds.has('♠A')) candidates.push({ suit: '♠', rank: 'A', id: '♠A' });
  if (!playedIds.has(trumpSuit + 'J')) candidates.push({ suit: trumpSuit, rank: 'J', id: trumpSuit + 'J' });
  const allSuits = ['♣', '♦', '♥', '♠'];
  const sameColorSuit = allSuits.find(s => s !== trumpSuit && isSameColor(s, trumpSuit));
  if (sameColorSuit && !playedIds.has(sameColorSuit + 'J')) candidates.push({ suit: sameColorSuit, rank: 'J', id: sameColorSuit + 'J' });
  const RANKS_NO_J = ['A', 'K', 'Q', '10', '9', '8', '7', '6', '5', '4', '3', '2'];
  for (const r of RANKS_NO_J) {
    const id = trumpSuit + r;
    if (!playedIds.has(id)) candidates.push({ suit: trumpSuit, rank: r, id });
  }
  return candidates.sort((a, b) => cardPower({ suit: trumpSuit }, 1, b, [{ card: b }]) - cardPower({ suit: trumpSuit }, 1, a, [{ card: a }]))[0];
}

function countAllianceTrumps(ctx) {
  const { hand, playedCards, contract, seat, deputy } = ctx;
  if (contract.suit === 'NT') return null;
  const trumpSuit = contract.suit;
  const allTrumps = 13;
  const myTrumps = hand.filter(c => c.suit === trumpSuit).length;
  const playedTrumps = playedCards.filter(c => c.suit === trumpSuit);
  const deputyPlayedTrumps = deputy >= 0 ? playedTrumps.filter(c => c.seat === deputy).length : 0;
  const deputyRemainingTrumps = deputy >= 0 ? Math.max(0, 2.5 - deputyPlayedTrumps) : 0;
  const remainingTrumps = allTrumps - myTrumps - playedTrumps.length;
  const allianceTrumps = remainingTrumps - deputyRemainingTrumps;
  return { remainingTrumps, allianceTrumps };
}

// ==========================================
// 6. 通常の打牌
// ==========================================
export function chooseCardToPlay(ctx) {
  const {
    hand, legal, trick, trickNo, contract, playedCards, voids,
    isMySideNap, isCurrentNapWinning, seat, deputy, params
  } = ctx;

  const isNapoleon = seat === contract.nap;
  const low = cards => cards.slice().sort((a, b) => cardPower(contract, trickNo, a, trick) - cardPower(contract, trickNo, b, trick))[0];
  const safeLow = cards => cards.slice().sort((a, b) => cardPower(contract, trickNo, a, trick) - cardPower(contract, trickNo, b, trick)).filter(c => winningEntry(contract, trickNo, [...trick, { seat, card: c }]).seat !== seat)[0];

  if (!trick.length) {
    if (isNapoleon) {
      const isSuitContract = contract.suit !== 'NT';
      if (trickNo === 0 && isSuitContract) {
        const otherAces = legal.filter(c => c.rank === 'A' && c.id !== '♠A' && c.suit !== contract.suit);
        if (otherAces.length) return otherAces[0];
      }
      const twos = legal.filter(c => c.rank === '2' && c.suit !== contract.suit);
      if (twos.length && trickNo > 0) {
        const playedSuitCount = playedCards.filter(pc => pc.suit === twos[0].suit).length;
        if (playedSuitCount === 0) return twos[0];
      }
      if (isSuitContract) {
        const trumpSuit = contract.suit;
        const trumps = legal.filter(c => c.suit === trumpSuit);
        const counting = countAllianceTrumps(ctx);
        if (trumps.length) {
          if (counting && counting.allianceTrumps <= 0) {
            const nonTrumps = legal.filter(c => c.suit !== trumpSuit);
            if (nonTrumps.length) {
              return nonTrumps.sort((a, b) => cardPower(contract, trickNo, a, trick) - cardPower(contract, trickNo, b, trick))[0];
            }
          }
          const strongestUnplayed = getStrongestUnplayedTrump(playedCards, trumpSuit);
          const myStrongest = trumps.sort((a, b) => cardPower(contract, trickNo, b, [{ seat, card: b }]) - cardPower(contract, trickNo, a, [{ seat, card: a }]))[0];
          if (strongestUnplayed && myStrongest.id === strongestUnplayed.id) return myStrongest;
          return trumps.sort((a, b) => cardPower(contract, trickNo, a, [{ seat, card: a }]) - cardPower(contract, trickNo, b, [{ seat, card: b }]))[0];
        }
      } else {
        const strongLeads = legal.filter(c => c.rank === 'A' || c.rank === '2' || c.id === '♠A');
        const weakLeads = legal.filter(c => !strongLeads.includes(c));
        if (trickNo >= 4 && strongLeads.length) {
          return strongLeads.sort((a, b) => cardPower(contract, trickNo, b, [{ seat, card: b }]) - cardPower(contract, trickNo, a, [{ seat, card: a }]))[0];
        }
        if (weakLeads.length) return low(weakLeads);
        return low(legal);
      }
      const bestSuit = strongestSuit(hand, isSuitContract ? SUITS.filter(s => s !== contract.suit) : SUITS);
      const bestSuitCards = legal.filter(c => c.suit === bestSuit);
      if (bestSuitCards.length) {
        if (Math.random() < params.leadAggression) {
          return bestSuitCards.sort((a, b) => cardPower(contract, trickNo, b, [{ seat, card: b }]) - cardPower(contract, trickNo, a, [{ seat, card: a }]))[0];
        } else {
          return bestSuitCards.sort((a, b) => cardPower(contract, trickNo, a, [{ seat, card: a }]) - cardPower(contract, trickNo, b, [{ seat, card: b }]))[0];
        }
      }
      return low(legal);
    } else {
      let candidates = legal;
      if (contract.suit !== 'NT' && legal.some(c => c.suit !== contract.suit)) {
        candidates = legal.filter(c => c.suit !== contract.suit);
      }
      const twos = candidates.filter(c => c.rank === '2');
      if (twos.length && trickNo > 0) {
        const playedSuitCount = playedCards.filter(pc => pc.suit === twos[0].suit).length;
        if (playedSuitCount === 0) return twos[0];
      }
      const safeH = candidates.filter(c => !voids[seat] || !voids[seat][c.suit]);
      const finalCands = safeH.length ? safeH : candidates;
      return low(finalCands);
    }
  }

  if (isNapoleon && trickNo > 0) {
    const twos = legal.filter(c => c.rank === '2' && c.suit !== contract.suit);
    if (twos.length) {
      const led = trick[0].card.suit;
      if (twos.some(t => t.suit === led)) {
        const playedSuitCount = playedCards.filter(pc => pc.suit === led).length;
        if (!trick.some(e => e.card.rank === '2' && e.card.suit === led) && playedSuitCount === 0) {
          return twos.find(t => t.suit === led);
        }
      }
    }
  }

  if (isMySideNap && isCurrentNapWinning && !(seat === contract.deputy && !contract.solo)) {
    const safe = safeLow(legal);
    if (safe) return safe;
    return low(legal);
  }

  const pointInTrick = trick.some(e => ["10", "J", "Q", "K", "A"].includes(e.card.rank));
  const winningCards = legal.filter(c => winningEntry(contract, trickNo, [...trick, { seat, card: c }]).seat === seat);

  if (isNapoleon && contract.suit === 'NT') {
    const current = winningEntry(contract, trickNo, trick);
    const isEnemyWinning = current && current.seat !== contract.nap && (!contract.solo && current.seat !== contract.deputy);
    if (isEnemyWinning && !pointInTrick && trickNo >= 4) {
      if (winningCards.length) return low(winningCards);
    }
    if (isEnemyWinning && !pointInTrick && trickNo < 4) return low(legal);
    if (isEnemyWinning && pointInTrick) {
      if (winningCards.length) return low(winningCards);
    }
  }

  if (winningCards.length && (pointInTrick || trick.length === 4 || (isNapoleon && !isCurrentNapWinning))) {
    return low(winningCards);
  }
  return low(legal);
}

// ==========================================
// 7. 副官の打牌
// ==========================================
export function chooseDeputyCard(ctx) {
  const { hand, legal, trick, trickNo, contract, call, isNapLeading, lastSeat, seat, params } = ctx;
  const isFace = c => ["10", "J", "Q", "K", "A"].includes(c.rank);
  const isSameColor = (a, b) => ["♣", "♠"].includes(a) === ["♣", "♠"].includes(b);
  const isRole = c => c.id === call?.id || c.id === "♠A" || (contract.suit !== "NT" && c.rank === "J" && (c.suit === contract.suit || isSameColor(c.suit, contract.suit)));

  const roleCards = legal.filter(isRole);
  const low = cards => cards.slice().sort((a, b) => cardPower(contract, trickNo, a, trick) - cardPower(contract, trickNo, b, trick))[0];
  const safeLow = cards => cards.slice().sort((a, b) => cardPower(contract, trickNo, a, trick) - cardPower(contract, trickNo, b, trick)).filter(c => winningEntry(contract, trickNo, [...trick, { seat, card: c }]).seat !== seat)[0];

  if (!trick.length) {
    const winningLeads = legal.filter(c => c.rank === 'A' || c.rank === '2' || (contract.suit !== 'NT' && c.suit === contract.suit && c.rank === 'J'));
    if (winningLeads.length) {
      return winningLeads.sort((a, b) => cardPower(contract, trickNo, b, [{seat, card: b}]) - cardPower(contract, trickNo, a, [{seat, card: a}]))[0];
    }
    if (contract.suit !== 'NT') {
      const trumpLeads = legal.filter(c => c.suit === contract.suit);
      if (trumpLeads.length) return low(trumpLeads);
    }
    return low(legal);
  }

  if (isNapLeading) {
    const current = winningEntry(contract, trickNo, trick);
    const isAllyWinning = current && (current.seat === contract.nap || current.seat === seat);
    if (isAllyWinning) {
      const nonRole = legal.filter(c => !isRole(c));
      if (nonRole.length && Math.random() < params.roleCardPreservation) {
        return low(nonRole);
      }
    }
    if (trick[0].card.suit === contract.suit) {
      if (trick.length <= 3 && !isAllyWinning) {
        const winningCards = legal.filter(c => winningEntry(contract, trickNo, [...trick, { seat, card: c }]).seat === seat);
        const safeWinning = winningCards.filter(c => !isRole(c));
        if (safeWinning.length) return low(safeWinning);
        if (roleCards.length) return roleCards.sort((a, b) => cardPower(contract, trickNo, b, [...trick, {seat, card: b}]) - cardPower(contract, trickNo, a, [...trick, {seat, card: a}]))[0];
      }
      if (lastSeat) {
        const winningCards = legal.filter(c => winningEntry(contract, trickNo, [...trick, { seat, card: c }]).seat === seat);
        const safeWinning = winningCards.filter(c => !isRole(c));
        if (safeWinning.length) return low(safeWinning);
        if (winningCards.length) return low(winningCards);
      }
    }
    const called = legal.find(c => c.id === call?.id);
    if (called) return called;
    if (roleCards.length && !isAllyWinning) {
      return roleCards.sort((a, b) => cardPower(contract, trickNo, b, [...trick, {seat, card: b}]) - cardPower(contract, trickNo, a, [...trick, {seat, card: a}]))[0];
    }
  }

  const pointInTrick = trick.some(e => ["10", "J", "Q", "K", "A"].includes(e.card.rank));
  const winningCards = legal.filter(c => winningEntry(contract, trickNo, [...trick, { seat, card: c }]).seat === seat);

  if (winningCards.length && (pointInTrick || trick.length === 4)) {
    return low(winningCards);
  }
  return low(legal);
}
