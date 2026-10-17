import { SUITS, RANKS, SV, defaultStrategy } from './constants.js';

export function isTrump(contract, c) { return contract.suit !== "NT" && c.suit === contract.suit; }

export function cardPower(contract, trickNo, card, trick) {
  const led = trick[0].card.suit, allSame = trick.every(x => x.card.suit === led), mighty = trick.some(x => x.card.id === "♠A");
  if (mighty && card.id === "♥Q") return 10000;
  if (card.id === "♠A") return 9000;
  if (contract.suit !== "NT" && card.rank === "J" && card.suit === contract.suit) return 8000;
  const sameColor = (a, b) => (a === "♣" || a === "♠") === (b === "♣" || b === "♠");
  if (contract.suit !== "NT" && card.rank === "J" && card.suit !== contract.suit && sameColor(card.suit, contract.suit)) return 7000;
  if (allSame && card.suit === led && card.rank === "2") return 6000;
  if (isTrump(contract, card)) return 5000 + RANKS.indexOf(card.rank);
  if (card.suit === led) return 3000 + RANKS.indexOf(card.rank);
  return 1000 + RANKS.indexOf(card.rank);
}

export function winningEntry(contract, trickNo, trick) {
  return trick.reduce((best, x) => cardPower(contract, trickNo, x.card, trick) > cardPower(contract, trickNo, best.card, trick) ? x : best, trick[0]);
}

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

export function shouldBid(hand, currentHigh, minBid, params) {
  const strength = handStrength(hand);
  const bestSuit = strongestSuit(hand);
  const cap = 13 + Math.min(9, Math.floor(strength / 1.3));
  
  if (strength <= params.bidThreshold || cap < minBid) return null;
  if (Math.random() > Math.min(1, (strength - params.bidThreshold) / 3)) return null;

  const num = Math.max(minBid, 13 + Math.min(9, Math.floor((strength - 2) / 1.7)));
  if (currentHigh.num < 13) return { num, suit: bestSuit };
  if (num > currentHigh.num) return { num, suit: bestSuit };

  return null;
}

export function chooseDiscard(hand, trump) {
  const value = c => RANKS.indexOf(c.rank) + (c.suit === trump ? 3 : 0);
  return hand.slice().sort((a, b) => value(a) - value(b)).slice(0, 2);
}

export function chooseDeputyCall(hand, discard, trump, level, bid) {
  const used = new Set([...hand, ...discard].map(c => c.id));
  const cands = [];
  for (const s of SUITS) for (const r of RANKS) if (!used.has(s + r)) cands.push({ suit: s, rank: r, id: s + r });
  if (!cands.length) return { suit: "♠", rank: "A", id: "♠A" };
  
  const score = c => (c.rank === "A" ? 10 : c.rank === "K" ? 6 : c.rank === "Q" ? 3 : 0) - hand.filter(x => x.suit === c.suit).length * 1.5;
  cands.sort((a, b) => score(b) - score(a));
  return cands[0];
}

export function chooseCardToPlay(ctx) {
  const {
    hand, legal, trick, trickNo, contract, playedCards, voids,
    isMySideNap, isCurrentNapWinning, seat, params
  } = ctx;

  const low = cards => cards.slice().sort((a, b) => cardPower(contract, trickNo, a, trick) - cardPower(contract, trickNo, b, trick))[0];

  if (!trick.length) {
    const leadValue = c => cardPower(contract, trickNo, c, trick) + (c.rank === "A" ? 3 : c.rank === "K" ? 1 : 0) + hand.filter(x => x.suit === c.suit).length * .25;
    
    const safeH = legal.filter(c => {
      if (c.rank !== "A" || c.id === "♠A") return true;
      const twoPlayed = playedCards.some(pc => pc.id === c.suit + "2");
      if (trickNo > 0 && !twoPlayed) {
        const anyVoid = [0,1,2,3,4].some(s => s !== seat && voids[s] && voids[s][c.suit]);
        if (!anyVoid) return false;
      }
      return true;
    });

    const candidates = safeH.length ? safeH : legal;
    const strongLead = candidates.filter(c => c.rank === "A" || c.id === "♠A" || (c.rank === "J" && contract.suit !== "NT" && (c.suit === contract.suit || ((c.suit === "♣" || c.suit === "♠") === (contract.suit === "♣" || contract.suit === "♠")))));
    
    if (strongLead.length && Math.random() < params.leadAggression) {
      return strongLead.sort((a, b) => leadValue(b) - leadValue(a))[0];
    }
    const nonAce = candidates.filter(c => c.rank !== "A");
    if (nonAce.length && Math.random() < params.safeAceWeight) {
      return nonAce.sort((a, b) => leadValue(b) - leadValue(a))[0];
    }
    return candidates.sort((a, b) => leadValue(b) - leadValue(a))[0];
  }

  if (isMySideNap && isCurrentNapWinning) {
    const safe = hand.filter(c => winningEntry(contract, trickNo, [...trick, { seat, card: c }]).seat !== seat);
    return low(safe.length ? safe : hand);
  }

  const winningCards = hand.filter(c => winningEntry(contract, trickNo, [...trick, { seat, card: c }]).seat === seat);
  const pointInTrick = trick.some(e => ["10", "J", "Q", "K", "A"].includes(e.card.rank));

  if (winningCards.length && (pointInTrick || trick.length === 4)) {
    return low(winningCards);
  }
  return low(hand);
}

export function chooseDeputyCard(ctx) {
  const { hand, legal, trick, trickNo, contract, nap, call, isNapLeading, lastSeat, seat, deputy, params } = ctx;
  const sideOf = s => s === nap || (!contract.solo && s === deputy) ? "nap" : "alliance";
  const isFace = c => ["10", "J", "Q", "K", "A"].includes(c.rank);
  const sameColor = (a, b) => ["♣", "♠"].includes(a) === ["♣", "♠"].includes(b);
  const isRole = c => c.id === call?.id || c.id === "♠A" || (contract.suit !== "NT" && c.rank === "J" && (c.suit === contract.suit || sameColor(c.suit, contract.suit)));
  
  const low = cards => cards.slice().sort((a, b) => cardPower(contract, trickNo, a, trick) - cardPower(contract, trickNo, b, trick))[0];

  if (isNapLeading) {
    if (lastSeat) {
      const delayed = legal.filter(c => !isRole(c));
      if (delayed.length) {
        const points = delayed.filter(isFace);
        return (points.length ? points : delayed).sort((a, b) => RANKS.indexOf(b.rank) - RANKS.indexOf(a.rank))[0];
      }
    }
    const current = winningEntry(contract, trickNo, trick);
    if (sideOf(current.seat) === "nap") {
      const nonRole = legal.filter(c => !isRole(c));
      if (nonRole.length && Math.random() < params.roleCardPreservation) {
        return low(nonRole);
      }
    }
    const called = legal.find(c => c.id === call?.id);
    if (called) return called;
    const roleCards = legal.filter(isRole);
    if (roleCards.length) {
      return roleCards.sort((a, b) => cardPower(contract, trickNo, b, [...trick, {seat, card: b}]) - cardPower(contract, trickNo, a, [...trick, {seat, card: a}]))[0];
    }
  }

  return chooseCardToPlay(ctx);
}
