// ============================================================
// js/bot.js
// 依存: constants.js, js/core.js
// 役割: ローカルCOM戦で使う思考ロジック・ルール計算（カード強度・勝者判定・立ち・指名）
// ============================================================
import { SUITS, RANKS, SV, POINT, sameColorSuitOf } from '../constants.js';
import { g } from './core.js';

// ---------------- カード基本 ----------------
export function cardValue(c) {
  return RANKS.indexOf(c.rank) + (c.suit === g.contract?.suit ? 3 : 0);
}

export function legal(i) {
  const h = g.players[i].hand;
  if (!g.trick.length) return h;
  const suit = g.trick[0].card.suit;
  const follow = h.filter(c => c.suit === suit);
  return follow.length ? follow : h;
}

export function trump(c) {
  return g.contract.suit !== 'NT' && c.suit === g.contract.suit;
}

export function cardPower(entry, trick, trickNo = 0) {
  const c = entry.card;
  const led = trick[0].card.suit;
  const allSame = trick.every(x => x.card.suit === led);
  const mighty = trick.some(x => x.card.id === '♠A');
  // マイティ・正J・裏Jは1トリック目から有効
  if (mighty && c.id === '♥Q') return 10000;
  if (c.id === '♠A') return 9000;
  if (g.contract.suit !== 'NT' && c.rank === 'J' && c.suit === g.contract.suit) return 8000;
  const black = s => s === '♣' || s === '♠';
  if (g.contract.suit !== 'NT' && c.rank === 'J' && c.suit !== g.contract.suit && black(c.suit) === black(g.contract.suit)) return 7000;
  // セイム2のみ2トリック目から有効
  if (trickNo > 0) {
    if (allSame && c.suit === led && c.rank === '2') return 6000;
  }
  if (trump(c)) return 5000 + RANKS.indexOf(c.rank);
  if (c.suit === led) return 3000 + RANKS.indexOf(c.rank);
  return 1000 + RANKS.indexOf(c.rank);
}

export function winning(trick = g.trick) {
  return trick.reduce((best, e) =>
    cardPower(e, trick, g.trickNo) > cardPower(best, trick, g.trickNo) ? e : best, trick[0]);
}

export function artfulCard(entry, trick) {
  const c = entry.card;
  const led = trick[0].card.suit;
  const black = s => s === '♣' || s === '♠';
  return c.id === '♠A'
    || (c.id === '♥Q' && trick.some(x => x.card.id === '♠A'))
    || (c.rank === 'J' && g.contract.suit !== 'NT'
        && (c.suit === g.contract.suit
            || (c.suit !== g.contract.suit && black(c.suit) === black(g.contract.suit))))
    || (c.rank === '2' && c.suit === led && trick.every(x => x.card.suit === led));
}

// ---------------- 立ち・指名 ----------------
export function soloMinimumBid(gap, mult) {
  return 13 + Math.floor(Math.max(0, gap) / (10 * Math.max(1, mult)));
}

export function finalAuctionRule(scores, mult = 1) {
  const ranked = scores.map((score, seat) => ({ score, seat }))
    .sort((a, b) => a.score - b.score || a.seat - b.seat);
  const cutoff = ranked[1]?.score ?? 0;
  const gap = Math.max(0, (ranked[1]?.score ?? 0) - (ranked[0]?.score ?? 0));
  const rawMin = 13 + Math.floor(gap / (6 * Math.max(1, mult)));
  return {
    eligible: ranked.filter(x => x.score <= cutoff).map(x => x.seat),
    bottomSeat: ranked[0]?.seat,
    fourthSeat: ranked[1]?.seat,
    thirdSeat: ranked[2]?.seat,
    thirdScore: ranked[2]?.score,
    minBid: Math.min(20, rawMin),
    canOvertake: rawMin <= 20
  };
}

export function computeTeamMinBid(scores, mult, napSeat, deputySeat) {
  const ranked = scores.map((s, i) => ({ s, i })).sort((a, b) => a.s - b.s || a.i - b.i);
  const S5 = ranked[0].s, S4 = ranked[1].s, S3 = ranked[2].s;
  const bottomSeat = ranked[0].i, fourthSeat = ranked[1].i;
  const m = Math.max(1, mult);
  const f = (gap, denom) => Math.floor(Math.max(0, gap) / denom);

  if (napSeat === bottomSeat && deputySeat === fourthSeat) {
    const a = 13 + f(S4 - S5, 2 * m), b = 13 + f(S3 - S4, 4 * m), raw = Math.max(a, b);
    const broken = b > 20, soloBid = soloMinimumBid(S4 - S5, m);
    return {
      minBid: broken ? Math.min(20, soloBid) : Math.min(20, raw),
      rawMin: broken ? soloBid : raw,
      canOvertake: (broken ? soloBid : raw) <= 20,
      incentiveBroken: broken,
      soloRequired: broken,
      soloMinBid: Math.min(20, soloBid),
      soloRawMin: soloBid,
      soloPossible: soloBid <= 20,
      case: 'A',
      details: { S3, S4, S5, needNapOverDeputy: a, needDeputyOverThird: b, soloNeed: soloBid }
    };
  }
  if (napSeat === fourthSeat && deputySeat === bottomSeat) {
    const a = 13 + f(S3 - S4, 6 * m), b = 13 + f(S3 - S5, 4 * m), c = 13 + f(S4 - S5, 2 * m);
    const raw = Math.max(a, b, c);
    return {
      minBid: Math.min(20, raw), rawMin: raw, canOvertake: raw <= 20,
      incentiveBroken: a > 20 || b > 20, soloRequired: false, case: 'B',
      details: { S3, S4, S5, needNapOverThird: a, needDeputyOverThird: b, needDeputyOverNapOnLoss: c }
    };
  }
  if (napSeat === bottomSeat && deputySeat !== fourthSeat) {
    const raw = 13 + f(S4 - S5, 6 * m);
    return { minBid: Math.min(20, raw), rawMin: raw, canOvertake: raw <= 20, incentiveBroken: false, soloRequired: false, case: 'C', details: { S3, S4, S5, needNapOverFourth: raw } };
  }
  if (napSeat === fourthSeat && deputySeat !== bottomSeat) {
    const raw = 13 + f(S4 - S5, 6 * m);
    return { minBid: Math.min(20, raw), rawMin: raw, canOvertake: raw <= 20, incentiveBroken: false, soloRequired: false, case: 'D', details: { S3, S4, S5, needNapLoss: raw } };
  }
  return null;
}

export function isSoloForced() {
  if (g.round < 10 || !g.contract) return false;
  const ranked = g.matchScores.map((s, i) => ({ s, i })).sort((a, b) => a.s - b.s || a.i - b.i);
  const bottomSeat = ranked[0].i;
  if (g.contract.nap !== bottomSeat) return false;
  const fourthSeat = ranked[1].i;
  const r = computeTeamMinBid(g.matchScores, g.mult, bottomSeat, fourthSeat);
  return r?.soloRequired === true;
}

export function isSafeToCashAce(suit, seat) {
  if (!g.contract) return false;
  if (suit === '♠') return true;
  if (g.trickNo > 0) {
    const twoPlayed = g.playedCards.some(c => c.id === suit + '2');
    if (!twoPlayed) {
      const anyVoid = [0, 1, 2, 3, 4].some(s => s !== seat && g.voids[s] && g.voids[s][suit]);
      if (!anyVoid) return false;
    }
  }
  if (g.contract.suit !== 'NT' && g.contract.suit !== suit) {
    for (let s = 0; s < 5; s++) {
      if (s === seat) continue;
      if (g.contract.revealedCall) {
        if (s === g.contract.nap || (!g.contract.solo && s === g.contract.deputy)) continue;
      } else {
        if (s === g.contract.nap) continue;
      }
      if (g.voids[s] && g.voids[s][suit]) return false;
    }
  }
  return true;
}

export function botSuitValue(hand, suit) {
  const weight = { 10: 1, J: 1.8, Q: 2.6, K: 3.5, A: 4.7 };
  const cards = hand.filter(c => c.suit === suit);
  return cards.reduce((n, c) => n + (weight[c.rank] || 0), 0) + Math.max(0, cards.length - 3) * .75;
}

export function strongestBotSuit(hand, suits = SUITS) {
  return suits.slice().sort((a, b) => botSuitValue(hand, b) - botSuitValue(hand, a) || SV[b] - SV[a])[0];
}

export function chooseBotCall(hand, discard, trump, level, bid) {
  const used = new Set([...hand, ...discard].map(c => c.id));
  const p = g.aiWeights;

  // 優先1: ♠A
  if (!used.has('♠A')) return { suit: '♠', rank: 'A', id: '♠A' };

  // 優先2: 正J → 裏J
  if (trump !== 'NT') {
    const sc = sameColorSuitOf(trump);
    const hasBackJ = sc && hand.some(c => c.suit === sc && c.rank === 'J');
    const hasTrumpJ = hand.some(c => c.suit === trump && c.rank === 'J');
    if (!hasTrumpJ && !used.has(trump + 'J')) {
      return { suit: trump, rank: 'J', id: trump + 'J' };
    }
    if (sc && !hasBackJ && !used.has(sc + 'J')) {
      return { suit: sc, rank: 'J', id: sc + 'J' };
    }
  }

  // 優先3: A vs 2 スコアリング
  let bestCard = null, bestScore = -Infinity;
  for (const suit of SUITS) {
    if (trump !== 'NT' && suit === trump) continue;
    const cards = hand.filter(c => c.suit === suit);
    const hasA = cards.some(c => c.rank === 'A');
    const has2 = cards.some(c => c.rank === '2');
    const len = cards.length;
    const isShort = len <= 2, isLong = len >= 4;

    if (!hasA && !used.has(suit + 'A')) {
      let score = 0.5;
      if (len >= 1 && len <= 3) score += (p.aceWeakSuitBonus ?? 0.3);
      if (isShort) score += (p.aceShortBonus ?? 0.15);
      if (isLong) score -= (p.aceLongPenalty ?? 0.15);
      if (trump === 'NT') score += 0.3;
      if (score > bestScore) { bestScore = score; bestCard = { suit, rank: 'A', id: suit + 'A' }; }
    }

    if (!has2 && !hasA && !used.has(suit + '2')) {
      let score = (p.sameTwoAceCounter ?? 0.3);
      if (isShort) score += (p.sameTwoShortBonus ?? 0.4);
      if (isLong) score -= (p.sameTwoLongPenalty ?? 0.25);
      if (bid >= 16) score += (p.sameTwoHighBidBonus ?? 0.2);
      if (trump === 'NT') score -= 0.1;
      if (score > bestScore) { bestScore = score; bestCard = { suit, rank: '2', id: suit + '2' }; }
    }
  }
  if (bestCard) return bestCard;

  const cands = [];
  for (const s of SUITS) for (const r of RANKS) {
    if (!used.has(s + r) && (trump === 'NT' || s !== trump)) cands.push({ suit: s, rank: r, id: s + r });
  }
  return cands[0] || { suit: '♠', rank: 'A', id: '♠A' };
}

// ---------------- 打牌 ----------------
export function chooseLocalBotCard(i) {
  const h = legal(i);
  const level = g.botLevel || 3;
  const low = cards => cards.slice().sort((a, b) => cardValue(a) - cardValue(b))[0];
  const napSide = i === g.contract.nap
    || (g.contract.revealedCall && i === g.contract.deputy)
    || (!g.contract.revealedCall && !g.contract.solo && g.contract.call && g.players[i].hand.some(c => c.id === g.contract.call.id));
  const napPoints = g.points.reduce((n, x, seat) => n + ((seat === g.contract.nap || (!g.contract.solo && seat === g.contract.deputy)) ? x : 0), 0);
  const alliancePoints = g.points.reduce((n, x, seat) => n + ((seat !== g.contract.nap && (g.contract.solo || seat !== g.contract.deputy)) ? x : 0), 0);
  const isDeputy = i !== g.contract.nap && !g.contract.solo
    && (g.contract.revealedCall ? i === g.contract.deputy : g.players[i].hand.some(c => c.id === g.contract.call?.id));
  const calledLead = isDeputy && g.trick.length > 0 && g.trick[0].player === g.contract.nap
    && (g.trick[0].card.suit === g.contract.call?.suit || (g.contract.suit !== 'NT' && g.trick[0].card.suit === g.contract.suit));

  if (calledLead) {
    const dep = chooseLocalDeputyCard(i, h);
    if (dep) return { card: dep.card, reason: 'delegate-called-lead', detail: dep };
  }
  if (level >= 2 && napSide && g.contract.num < 20 && napPoints >= g.contract.num && alliancePoints === 0) {
    if (!g.trick.length) {
      const c = low(h);
      return { card: c, reason: 'nap-secured-lead-low', detail: { napPoints, contractNum: g.contract.num } };
    }
    const safe = h.filter(c => winning(g.trick.concat([{ player: i, card: c }])).player !== i);
    const c = low(safe.length ? safe : h);
    return { card: c, reason: 'nap-secured-passive-low', detail: { safeCount: safe.length, handCount: h.length } };
  }
  if (isDeputy) {
    const dep = chooseLocalDeputyCard(i, h);
    if (dep) return { card: dep.card, reason: 'delegate-deputy', detail: dep };
  }
  if (level === 1) {
    const c = h[Math.floor(Math.random() * h.length)];
    return { card: c, reason: 'bot-level-1-random', detail: { handSize: h.length } };
  }

  if (!g.trick.length) {
    const leadValue = c => cardValue(c) + (c.rank === 'A' ? 3 : c.rank === 'K' ? 1 : 0) + g.players[i].hand.filter(x => x.suit === c.suit).length * .25;
    const safeH = h.filter(c => {
      if (c.rank !== 'A') return true;
      if (c.id === '♠A') return true;
      return isSafeToCashAce(c.suit, i);
    });
    const candidates = safeH.length ? safeH : h;
    const legalCandidates = g.trickNo === 0 ? candidates.filter(c => c.rank !== '2') : candidates;
    const finalCands = legalCandidates.length ? legalCandidates : candidates;

    const strongLead = finalCands.filter(c => c.rank === 'A' || c.id === '♠A'
      || (c.rank === 'J' && g.contract.suit !== 'NT'
          && (c.suit === g.contract.suit || (c.suit === '♣' || c.suit === '♠') === (g.contract.suit === '♣' || g.contract.suit === '♠'))));
    if (strongLead.length && Math.random() < g.aiWeights.leadAggression) {
      const c = strongLead.sort((a, b) => leadValue(b) - leadValue(a))[0];
      return { card: c, reason: 'lead-strong', detail: { leadAggression: g.aiWeights.leadAggression, strongCount: strongLead.length, strongCards: strongLead.map(x => x.id) } };
    }
    const nonAce = finalCands.filter(c => c.rank !== 'A');
    if (nonAce.length && Math.random() < g.aiWeights.safeAceWeight) {
      const c = nonAce.slice().sort((a, b) => leadValue(b) - leadValue(a))[0];
      return { card: c, reason: 'lead-non-ace', detail: { safeAceWeight: g.aiWeights.safeAceWeight, nonAceCount: nonAce.length } };
    }
    const c = finalCands.slice().sort((a, b) => leadValue(b) - leadValue(a))[0];
    return { card: c, reason: 'lead-fallback', detail: { candidateCount: finalCands.length, safeHCount: safeH.length } };
  }

  const winningCards = h.filter(c => winning(g.trick.concat([{ player: i, card: c }])).player === i);
  const current = winning().player;
  const points = g.trick.filter(e => POINT.includes(e.card.rank)).length;
  const team = seat => seat === g.contract.nap ? 'nap' : g.contract.revealedCall ? (seat === g.contract.deputy ? 'nap' : 'alliance') : (g.players[seat].hand.some(c => c.id === g.contract.call.id) ? 'nap' : 'alliance');
  const teammate = team(i) === team(current);

  if (teammate) {
    const safe = h.filter(c => winning(g.trick.concat([{ player: i, card: c }])).player !== i);
    const c = low(safe.length ? safe : h);
    return { card: c, reason: 'teammate-win-low', detail: { teammate: current, safeCount: safe.length } };
  }
  if (winningCards.length && (points > 0 || g.trick.length === 4 || (level === 3 && points >= 2))) {
    const c = low(winningCards);
    return { card: c, reason: 'win-points', detail: { points, trickLength: g.trick.length, winningCards: winningCards.map(x => x.id) } };
  }
  if (level === 3 && points === 0 && g.trick.length < 4) {
    const c = low(h);
    return { card: c, reason: 'passive-low-no-points', detail: { points, trickLength: g.trick.length } };
  }
  const c = low(h);
  return { card: c, reason: 'default-low', detail: { points, trickLength: g.trick.length } };
}

export function chooseLocalDeputyCard(i, h) {
  const contract = g.contract, nap = contract.nap, call = contract.call, trumpSuit = contract.suit;
  const ownSide = 'nap', led = g.trick[0]?.card.suit, lastSeat = g.trick.length === 4;
  const sideOf = seat => (seat === nap || (!contract.solo && (contract.revealedCall ? seat === contract.deputy : g.players[seat].hand.some(c => c.id === call?.id)))) ? 'nap' : 'alliance';
  const isFace = card => POINT.includes(card.rank);
  const sameColor = (a, b) => ['♣', '♠'].includes(a) === ['♣', '♠'].includes(b);
  const isRole = card => card.id === call?.id || card.id === '♠A'
    || (trumpSuit !== 'NT' && card.rank === 'J' && (card.suit === trumpSuit || sameColor(card.suit, trumpSuit)));
  const winnerWith = card => winning(g.trick.concat([{ player: i, card }]));
  const low = cards => cards.slice().sort((a, b) => cardValue(a) - cardValue(b))[0];
  const teamWinningCards = h.filter(card => sideOf(winnerWith(card).player) === ownSide);
  const canEnemyOvertake = card => {
    const trial = g.trick.concat([{ player: i, card }]);
    const current = winning(trial);
    const remaining = 4 - g.trick.length;
    for (let step = 1; step <= remaining; step++) {
      const seat = (i + step) % 5;
      if (sideOf(seat) === ownSide) continue;
      const hand = g.players[seat].hand;
      const follow = hand.filter(x => x.suit === led);
      const options = follow.length ? follow : hand;
      for (const response of options) {
        if (sideOf(winning(trial.concat([{ player: seat, card: response }])).player) !== ownSide) return true;
      }
    }
    return sideOf(current.player) !== ownSide;
  };
  const safeTeamWins = teamWinningCards.filter(card => !canEnemyOvertake(card));

  if (!g.trick.length) {
    const napHand = g.players[nap].hand;
    const napHasTrump = trumpSuit !== 'NT' && napHand.some(card => card.suit === trumpSuit);
    const napAces = SUITS.filter(suit => napHand.some(card => card.suit === suit && card.rank === 'A'));
    const napCanWinSuit = (suit) => {
      const napHasVoid = g.voids[nap]?.[suit];
      return (napHasVoid && napHasTrump) || napAces.includes(suit);
    };

    const secureAces = h.filter(c => c.rank === 'A' && !isRole(c));
    if (secureAces.length) {
      const ace = secureAces[0];
      if (napCanWinSuit(ace.suit)) {
        const lowCards = h.filter(c => c.rank !== 'A' && c.suit !== trumpSuit);
        if (lowCards.length) return { card: low(lowCards), reason: 'dep-preserve-ace', detail: { ace: ace.id } };
      } else {
        return { card: ace, reason: 'dep-secure-ace' };
      }
    }

    const returnSuit = napAces.find(suit => h.some(card => card.suit === suit));
    if (returnSuit) {
      const c = low(h.filter(card => card.suit === returnSuit));
      return { card: c, reason: 'dep-lead-return-suit', detail: { returnSuit, napAces } };
    }
    if (trumpSuit !== 'NT' && napHand.some(card => card.suit === trumpSuit) && h.some(card => card.suit === trumpSuit)) {
      const c = low(h.filter(card => card.suit === trumpSuit));
      return { card: c, reason: 'dep-lead-trump', detail: { trumpSuit } };
    }
    if (napHasTrump) {
      const voidSuit = SUITS.find(suit => !napHand.some(card => card.suit === suit) && h.some(card => card.suit === suit));
      if (voidSuit) {
        const c = low(h.filter(card => card.suit === voidSuit));
        return { card: c, reason: 'dep-lead-void-suit', detail: { voidSuit } };
      }
    }
    const secureAce = h.filter(card => card.rank === 'A' && (() => {
      const trial = [{ player: i, card }];
      for (let offset = 1; offset < 5; offset++) {
        const seat = (i + offset) % 5;
        const hand = g.players[seat].hand;
        const follow = hand.filter(x => x.suit === card.suit);
        const options = follow.length ? follow : hand;
        for (const response of options) {
          if (sideOf(winning(trial.concat([{ player: seat, card: response }])).player) !== ownSide) return false;
        }
      }
      return true;
    })());
    if (secureAce.length) {
      const c = secureAce.sort((a, b) => cardValue(b) - cardValue(a))[0];
      return { card: c, reason: 'dep-lead-secure-ace', detail: { aces: secureAce.map(x => x.id) } };
    }
    const sharedSuit = SUITS.filter(suit => h.some(card => card.suit === suit) && napHand.some(card => card.suit === suit))
      .sort((a, b) => napHand.filter(card => card.suit === b).length - napHand.filter(card => card.suit === a).length)[0];
    if (sharedSuit) {
      const c = low(h.filter(card => card.suit === sharedSuit));
      return { card: c, reason: 'dep-lead-shared-suit', detail: { sharedSuit } };
    }
    const leadValue = card => cardValue(card) + (card.rank === 'A' ? 3 : card.rank === 'K' ? 1 : 0) + g.players[i].hand.filter(x => x.suit === card.suit).length * .25;
    const finalCandidates = g.trickNo === 0 ? h.filter(c => c.rank !== '2') : h;
    const c = finalCandidates.slice().sort((a, b) => leadValue(b) - leadValue(a))[0];
    return { card: c, reason: 'dep-lead-fallback', detail: {} };
  }

  const calledLead = g.trick[0].player === nap && (led === call?.suit || (trumpSuit !== 'NT' && led === trumpSuit));
  if (calledLead) {
    if (lastSeat) {
      const delayed = safeTeamWins.filter(card => !isRole(card));
      if (delayed.length) {
        const points = delayed.filter(isFace);
        const c = (points.length ? points : delayed).sort((a, b) => cardValue(b) - cardValue(a))[0];
        return { card: c, reason: 'dep-called-lead-last-safe-win', detail: { delayed: delayed.map(x => x.id) } };
      }
    }
    const current = winning();
    if (sideOf(current.player) === ownSide) {
      const nonRole = h.filter(c => !isRole(c));
      if (nonRole.length && Math.random() < g.aiWeights.roleCardPreservation) {
        const candidate = low(nonRole);
        if (!canEnemyOvertake(candidate)) {
          return { card: candidate, reason: 'dep-called-lead-preserve-role', detail: { roleCardPreservation: g.aiWeights.roleCardPreservation } };
        }
      }
    }
    if (trumpSuit === 'NT' && call?.rank === 'A' && call.id !== '♠A' && led === call.suit && g.trickNo > 0) {
      const allFollowed = g.trick.every(entry => entry.card.suit === led);
      const alreadyWonByTwo = g.trick.some(entry => entry.card.suit === led && entry.card.rank === '2') && sideOf(winning().player) !== ownSide;
      const enemyTwoAfter = Array.from({ length: 4 - g.trick.length }, (_, index) => (i + index + 1) % 5)
        .some(seat => sideOf(seat) !== ownSide && g.players[seat].hand.some(card => card.suit === led && card.rank === '2'));
      if (alreadyWonByTwo || (allFollowed && enemyTwoAfter)) {
        const shelter = h.filter(card => card.id !== call.id);
        if (shelter.length) {
          const c = low(shelter);
          return { card: c, reason: 'dep-called-lead-shelter', detail: { alreadyWonByTwo, enemyTwoAfter } };
        }
      }
    }
    if (trumpSuit === 'NT' && call?.rank === '2') {
      const called = h.find(card => card.id === call.id);
      if (called) return { card: called, reason: 'dep-called-lead-nt-two', detail: {} };
    }
    const called = h.find(card => card.id === call?.id);
    if (called) return { card: called, reason: 'dep-called-lead-call-card', detail: { callId: call.id } };
    const roleCards = h.filter(isRole);
    if (roleCards.length) {
      const c = roleCards.sort((a, b) =>
        cardPower({ player: i, card: b }, g.trick.concat([{ player: i, card: b }]))
        - cardPower({ player: i, card: a }, g.trick.concat([{ player: i, card: a }])))[0];
      return { card: c, reason: 'dep-called-lead-role-card', detail: { roleCards: roleCards.map(x => x.id) } };
    }
  }

  if (g.trick.length) {
    const current = winning();
    const currentSide = sideOf(current.player);
    const pointCards = safeTeamWins.filter(isFace);
    if (currentSide === ownSide && pointCards.length) {
      const c = pointCards.sort((a, b) => cardValue(b) - cardValue(a))[0];
      return { card: c, reason: 'dep-team-winning-points', detail: { pointCards: pointCards.map(x => x.id) } };
    }
    if (currentSide !== ownSide && teamWinningCards.length) {
      const c = teamWinningCards.sort((a, b) =>
        cardPower({ player: i, card: b }, g.trick.concat([{ player: i, card: b }]))
        - cardPower({ player: i, card: a }, g.trick.concat([{ player: i, card: a }])))[0];
      return { card: c, reason: 'dep-enemy-winning-take', detail: { winningCards: teamWinningCards.map(x => x.id) } };
    }
    if (currentSide === ownSide) {
      const safe = h.filter(card => sideOf(winnerWith(card).player) === ownSide);
      if (safe.length) {
        const c = low(safe);
        return { card: c, reason: 'dep-team-safe-low', detail: { safeCount: safe.length } };
      }
    }
  }
  const c = low(h);
  return { card: c, reason: 'dep-default-low', detail: {} };
}
