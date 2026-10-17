import { SUITS, RANKS, SV, defaultStrategy } from './constants.js';

// ==========================================
// 1. 基本ルールとカードの強さ判定
// ==========================================
export function isTrump(contract, c) {
  return contract.suit !== "NT" && c.suit === contract.suit;
}

export function cardPower(contract, trickNo, card, trick) {
  const led = trick[0].card.suit;
  const allSame = trick.every(x => x.card.suit === led);
  const mighty = trick.some(x => x.card.id === "♠A");

  // ★修正: 1周目(trickNo === 0)は特殊札（マイティ、正裏J、セイム2）を無効化
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
  return trick.reduce((best, x) => 
    cardPower(contract, trickNo, x.card, trick) > cardPower(contract, trickNo, best.card, trick) ? x : best, trick[0]
  );
}

// ==========================================
// 2. 手札評価と競り
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

// ==========================================
// 3. 通常の打牌（ナポレオン・連合軍共通）
// ==========================================
export function chooseCardToPlay(ctx) {
  const {
    hand, legal, trick, trickNo, contract, playedCards, voids,
    isMySideNap, isCurrentNapWinning, seat, params
  } = ctx;

  const isNapoleon = seat === contract.nap;
  const low = cards => cards.slice().sort((a, b) => cardPower(contract, trickNo, a, trick) - cardPower(contract, trickNo, b, trick))[0];
  
  // --- リード時 ---
  if (!trick.length) {
    if (isNapoleon) {
      // ナポレオンのリード戦略
      const twos = legal.filter(c => c.rank === '2');
      if (twos.length && trickNo > 0) {
        const playedSuitCount = playedCards.filter(pc => pc.suit === twos[0].suit).length;
        if (playedSuitCount === 0) return twos[0]; // 局中初めてのスートなら2で確実に取る
      }
      
      const strongLead = legal.filter(c => c.rank === 'A' || c.id === '♠A' || (c.rank === 'J' && contract.suit !== 'NT' && (c.suit === contract.suit || ((c.suit === '♣' || c.suit === '♠') === (contract.suit === '♣' || contract.suit === '♠')))));
      if (strongLead.length && Math.random() < params.leadAggression) {
        return strongLead.sort((a, b) => cardPower(contract, trickNo, b, [{seat, card: b}]) - cardPower(contract, trickNo, a, [{seat, card: a}]))[0];
      }
      
      const safeAces = legal.filter(c => {
        if (c.rank !== 'A' || c.id === '♠A') return false;
        const twoPlayed = playedCards.some(pc => pc.id === c.suit + "2");
        const anyVoid = [0,1,2,3,4].some(s => voids[s] && voids[s][c.suit]);
        return !(!twoPlayed && !anyVoid);
      });
      if (safeAces.length && Math.random() < params.safeAceWeight) return safeAces[0];
      
      return low(legal);
    } else {
      // 連合軍のリード戦略
      // 切り札の自発リードは原則禁止（どうしても他になければ除く）
      const nonTrumps = legal.filter(c => c.suit !== contract.suit || contract.suit === 'NT');
      const candidates = nonTrumps.length ? nonTrumps : legal;
      
      // 2でセイム2を狙う
      const twos = candidates.filter(c => c.rank === '2');
      if (twos.length && trickNo > 0) {
        const playedSuitCount = playedCards.filter(pc => pc.suit === twos[0].suit).length;
        if (playedSuitCount === 0) return twos[0];
      }
      
      // 弱点スートのヒラ回し（最も弱いカード）
      return low(candidates);
    }
  }

  // --- フォロー時 ---
  // ナポレオンの「2」出し（そのスートが局中初めて場に出た時）
  if (isNapoleon && trickNo > 0) {
    const twos = legal.filter(c => c.rank === '2');
    if (twos.length) {
      const led = trick[0].card.suit;
      if (twos.some(t => t.suit === led)) {
        const playedSuitCount = playedCards.filter(pc => pc.suit === led).length;
        if (trick.every(e => e.card.suit !== led) && playedSuitCount === 0) {
          if (!trick.some(e => e.card.rank === '2' && e.card.suit === led)) {
            return twos.find(t => t.suit === led);
          }
        }
      }
    }
  }

  // ナポレオン軍が勝っていて、副官でないなら安全札
  if (isMySideNap && isCurrentNapWinning && !(seat === contract.deputy && !contract.solo)) {
    const safe = legal.filter(c => winningEntry(contract, trickNo, [...trick, { seat, card: c }]).seat !== seat);
    return low(safe.length ? safe : legal);
  }

  const pointInTrick = trick.some(e => ["10", "J", "Q", "K", "A"].includes(e.card.rank));
  const winningCards = legal.filter(c => winningEntry(contract, trickNo, [...trick, { seat, card: c }]).seat === seat);
  
  if (winningCards.length && (pointInTrick || trick.length === 4 || (isNapoleon && !isCurrentNapWinning))) {
    return low(winningCards);
  }
  
  return low(legal);
}

// ==========================================
// 4. 副官の打牌（専用ロジック）
// ==========================================
export function chooseDeputyCard(ctx) {
  const { hand, legal, trick, trickNo, contract, nap, call, isNapLeading, lastSeat, seat, params } = ctx;
  const isFace = c => ["10", "J", "Q", "K", "A"].includes(c.rank);
  const sameColor = (a, b) => ["♣", "♠"].includes(a) === ["♣", "♠"].includes(b);
  const isRole = c => c.id === call?.id || c.id === "♠A" || (contract.suit !== "NT" && c.rank === "J" && (c.suit === contract.suit || sameColor(c.suit, contract.suit)));
  
  const roleCards = legal.filter(isRole);
  const low = cards => cards.slice().sort((a, b) => cardPower(contract, trickNo, a, trick) - cardPower(contract, trickNo, b, trick))[0];

  // 副官がリードを握った時
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

  // ナポレオンがリードしてきた場合
  if (isNapLeading) {
    // ナポレオンが切り札（指定スート）を振ってきた場合
    if (trick[0].card.suit === contract.suit) {
      // 1〜3番手なら役札を即出しして副官を開示
      if (trick.length <= 3 && roleCards.length) {
        return roleCards.sort((a, b) => cardPower(contract, trickNo, b, [...trick, {seat, card: b}]) - cardPower(contract, trickNo, a, [...trick, {seat, card: a}]))[0];
      }
      // 大トリ（5番手）なら安全札で勝てるなら勝つ（ディレイ）
      if (lastSeat) {
        const winningCards = legal.filter(c => winningEntry(contract, trickNo, [...trick, { seat, card: c }]).seat === seat);
        const safeWinning = winningCards.filter(c => !isRole(c));
        if (safeWinning.length) return safeWinning.sort((a, b) => cardPower(contract, trickNo, b, [...trick, {seat, card: b}]) - cardPower(contract, trickNo, a, [...trick, {seat, card: a}]))[0];
        if (winningCards.length) return winningCards.sort((a, b) => cardPower(contract, trickNo, b, [...trick, {seat, card: b}]) - cardPower(contract, trickNo, a, [...trick, {seat, card: a}]))[0];
      }
    } else {
      // 切り札以外が回ってきた場合、ナポレオンが勝っているなら役札温存
      const current = winningEntry(contract, trickNo, trick);
      if (current.seat === nap) {
        const nonRole = legal.filter(c => !isRole(c));
        if (nonRole.length && Math.random() < params.roleCardPreservation) {
          return low(nonRole);
        }
      }
    }
    
    const called = legal.find(c => c.id === call?.id);
    if (called) return called;
    if (roleCards.length) {
      return roleCards.sort((a, b) => cardPower(contract, trickNo, b, [...trick, {seat, card: b}]) - cardPower(contract, trickNo, a, [...trick, {seat, card: a}]))[0];
    }
  }

  // それ以外は通常のフォロー
  const pointInTrick = trick.some(e => ["10", "J", "Q", "K", "A"].includes(e.card.rank));
  const winningCards = legal.filter(c => winningEntry(contract, trickNo, [...trick, { seat, card: c }]).seat === seat);
  
  if (winningCards.length && (pointInTrick || trick.length === 4)) {
    return low(winningCards);
  }
  
  return low(legal);
}
