// ai-tactics.js (完全版)
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

function adjustStrengthForOpponents(base, mySuit, currentBids, params, mySeat, type) {
  let adj = 0;
  if (!Array.isArray(currentBids)) return base;
  const oppBids = currentBids.filter(b => b && b.seat !== mySeat && Number.isFinite(b.num));
  for (const bid of oppBids) {
    if (bid.suit === mySuit && bid.num >= 15) adj -= params.suitConflictWeight * Math.max(0, bid.num - 14) * 0.15;
    if (bid.num >= 16) { adj -= (params.opponentInferenceWeight ?? 0.4) * 0.6; adj -= (params.weakOpponentBoost ?? 0.3) * 0.4; }
    else if (bid.num >= 14) adj -= (params.weakOpponentBoost ?? 0.3) * 0.25;
    else if (bid.num >= 13) adj -= (params.weakOpponentBoost ?? 0.3) * 0.1;
  }
  adj = Math.max(-2.0, Math.min(2.0, adj));
  return base + adj * (1 + (params.opponentInferenceWeight ?? 0.4) * 0.5);
}

function computeBidEV(p, num, strength, params) {
  if (!Number.isFinite(p)) p = 0.5;
  const maxHonest = findMaxHonestBid(strength);
  const bluffGap = Math.max(0, num - maxHonest);
  const diff = Math.max(0, num - 12);
  const highBoost = 1 + 0.5 * Math.max(0, num - 17);
  const winGain = diff * 8, lossGain = -diff * 8;
  const sweetBonus = sweetSpotFactor(p) * SWEET_SPOT_BONUS * highBoost;
  const bluffPenalty = bluffGap > 0 ? -bluffGap * params.bluffLossMultiplier * 2 * (1 + bluffGap * 0.6) : 0;
  const honestBonus = bluffGap === 0 ? HONEST_BID_FIXED_BONUS * Math.max(0, (p - 0.30) / 0.20) : 0;
  const numRiskPenalty = Math.max(0, num - 13) * 0.10;
  const napoleonEV = p * (winGain + sweetBonus) + (1 - p) * (lossGain + bluffPenalty) + honestBonus - numRiskPenalty;
  const allyEV = p * ALLY_LOSS_PENALTY + (1 - p) * (ALLY_WIN_BONUS + ALLY_BLOCK_BONUS);
  return Number.isFinite(napoleonEV - allyEV) ? napoleonEV - allyEV : 0;
}

export function shouldBid(hand, currentHigh, minBid, params, bidHistory = [], mySeat = 0, experience = null) {
  if (!Array.isArray(hand) || !hand.length) return null;
  if (!params) params = defaultStrategy();
  const baseStr = handStrength(hand);
  if (!Number.isFinite(baseStr) || baseStr < params.bidThreshold) return null;
  const currentRound = Math.max(0, ...(bidHistory || []).map(b => b?.round || 0));
  const currentBids = (bidHistory || []).filter(b => b && b.round === currentRound);
  const targetMin = Math.max(minBid, (currentHigh?.num ?? 12) + 1, 13);
  const candidates = [];
  const isBidViable = (num, p) => {
    if (num >= 19 && p < 0.65) return false;
    if (num >= 18 && p < 0.60) return false;
    if (num >= 17 && p < 0.55) return false;
    if (num >= 16 && p < 0.50) return false;
    if (num >= 15 && p < 0.45) return false;
    if (num >= 14 && p < 0.40) return false;
    return true;
  };
  const SUIT_ORDER = SUITS.slice().sort(() => Math.random() - 0.5);
  for (const suit of SUIT_ORDER) {
    const cs = colorStrength(hand, suit, params);
    const adj = adjustStrengthForOpponents(cs, suit, currentBids, params, mySeat, 'color');
    const strengthKey = quantizeStrength(cs);
    for (let num = targetMin; num <= 20; num++) {
      const baseP = estimatedWinRate(adj, num);
      const expEntry = experience?.bids?.[bidExperienceKey(strengthKey, 'color', num)];
      const p = blendWithExperience(baseP, expEntry);
      if (!isBidViable(num, p)) continue;
      const ev = computeBidEV(p, num, adj, params);
      if (Number.isFinite(ev)) candidates.push({ num, suit, solo: false, ev });
    }
  }
  const ntStr = ntHandStrength(hand, params);
  const ntAdj = adjustStrengthForOpponents(ntStr, 'NT', currentBids, params, mySeat, 'nt');
  const ntStrengthKey = quantizeStrength(ntStr);
  for (let num = targetMin; num <= 20; num++) {
    const baseP = estimatedWinRate(ntAdj, num);
    const expEntry = experience?.bids?.[bidExperienceKey(ntStrengthKey, 'NT', num)];
    const p = blendWithExperience(baseP, expEntry);
    if (!isBidViable(num, p)) continue;
    const boost = num >= params.highBidNtThreshold ? 1.15 : 1.0;
    const ev = computeBidEV(p, num, ntAdj, params) * params.ntPreference * boost;
    if (Number.isFinite(ev)) candidates.push({ num, suit: 'NT', solo: false, ev });
  }
  for (const suit of SUIT_ORDER) {
    const trumps = hand.filter(c => c.suit === suit);
    if (trumps.length < 4) continue;
    const ss = soloAdjustedStrength(hand, suit);
    if (ss < 15.5) continue;
    for (let num = targetMin; num <= 20; num++) {
      const p = estimatedWinRate(ss, num);
      if (!isBidViable(num, p)) continue;
      if (num >= 17 && p < 0.75) continue;
      if (num >= 16 && p < 0.70) continue;
      if (num >= 15 && p < 0.65) continue;
      if (num >= 14 && p < 0.60) continue;
      const ev = computeBidEV(p, num, ss, params);
      if (Number.isFinite(ev)) candidates.push({ num, suit, solo: true, ev });
    }
  }
  if (!candidates.length) return null;
  candidates.sort((a, b) => {
    const evDiff = b.ev - a.ev;
    if (Math.abs(evDiff) < 0.15) return a.num - b.num;
    return evDiff;
  });
  const best = candidates[0];
  const evThreshold = Math.max(0.8, 1.5 - params.riskTolerance);
  if (best && Number.isFinite(best.ev) && best.ev >= evThreshold) return { num: best.num, suit: best.suit, solo: best.solo };
  return null;
}

export function chooseDiscard(hand, trump) {
  if (!Array.isArray(hand)) return [];
  const value = c => RANKS.indexOf(c.rank) + (c.suit === trump ? 20 : 0);
  return hand.slice().sort((a, b) => value(a) - value(b)).slice(0, 2);
}

export function chooseDeputyCall(hand, discard, trump, level, bid, params, experience = null) {
  const p = params || { aceWeakSuitBonus: 0.3, aceShortBonus: 0.15, aceLongPenalty: 0.15, sameTwoAceCounter: 0.3, sameTwoShortBonus: 0.4, sameTwoLongPenalty: 0.25, sameTwoHighBidBonus: 0.2 };
  const used = new Set([...(hand || []), ...(discard || [])].map(c => c.id));
  if (!used.has('♠A')) return { suit: '♠', rank: 'A', id: '♠A' };
  if (trump !== 'NT') {
    const sc = sameColorSuitOf(trump);
    if (!hand.some(c => c.suit === sc && c.rank === 'J') && !used.has(trump + 'J')) return { suit: trump, rank: 'J', id: trump + 'J' };
    if (!hand.some(c => c.suit === sc && c.rank === 'J') && !used.has(sc + 'J')) return { suit: sc, rank: 'J', id: sc + 'J' };
  }
  let bestCard = null, bestScore = -Infinity;
  for (const suit of SUITS) {
    if (trump !== 'NT' && suit === trump) continue;
    const cards = hand.filter(c => c.suit === suit);
    const len = cards.length;
    if (!cards.some(c => c.rank === 'A') && !used.has(suit + 'A')) {
      let score = 0.5 + (len >= 1 && len <= 3 ? p.aceWeakSuitBonus : 0) + (len <= 2 ? p.aceShortBonus : 0) - (len >= 4 ? p.aceLongPenalty : 0);
      if (trump === 'NT') score += 0.3;
      if (score > bestScore) { bestScore = score; bestCard = { suit, rank: 'A', id: suit + 'A' }; }
    }
    if (!cards.some(c => c.rank === '2') && !cards.some(c => c.rank === 'A') && !used.has(suit + '2')) {
      let score = p.sameTwoAceCounter + (len <= 2 ? p.sameTwoShortBonus : 0) - (len >= 4 ? p.sameTwoLongPenalty : 0) + (bid >= 16 ? p.sameTwoHighBidBonus : 0);
      if (trump === 'NT') score -= 0.1;
      if (score > bestScore) { bestScore = score; bestCard = { suit, rank: '2', id: suit + '2' }; }
    }
  }
  if (bestCard) return bestCard;
  const cands = [];
  for (const s of SUITS) for (const r of RANKS) if (!used.has(s + r) && (trump === 'NT' || s !== trump)) cands.push({ suit: s, rank: r, id: s + r });
  return cands[0] || { suit: '♠', rank: 'A', id: '♠A' };
}

export function chooseSoloCall(hand, trump = 'NT') {
  if (!Array.isArray(hand) || !hand.length) return { suit: "♠", rank: "A", id: "♠A" };
  if (hand.some(c => c.id === '♠A')) return { suit: '♠', rank: 'A', id: '♠A' };
  if (trump !== 'NT') {
    if (hand.some(c => c.id === trump + 'J')) return { suit: trump, rank: 'J', id: trump + 'J' };
    const sc = sameColorSuitOf(trump);
    if (sc && hand.some(c => c.id === sc + 'J')) return { suit: sc, rank: 'J', id: sc + 'J' };
  }
  const aces = hand.filter(c => c.rank === 'A' && (trump === 'NT' || c.suit !== trump));
  if (aces.length) { aces.sort((a, b) => SV[a.suit] - SV[b.suit]); return { suit: aces[0].suit, rank: 'A', id: aces[0].id }; }
  const twos = hand.filter(c => c.rank === '2' && (trump === 'NT' || c.suit !== trump));
  if (twos.length) { twos.sort((a, b) => SV[a.suit] - SV[b.suit]); return { suit: twos[0].suit, rank: '2', id: twos[0].id }; }
  const fallback = hand.slice().sort((a, b) => RANKS.indexOf(a.rank) - RANKS.indexOf(b.rank))[0];
  return { suit: fallback.suit, rank: fallback.rank, id: fallback.id };
}

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
  const key = playExperienceKey(role, trickPhaseOf(ctx.trickNo), pointsTierOf((ctx.trick || []).filter(e => isFace(e.card)).length), rankTierOf(sorted[0].rank));
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

  if (isNT) {
    const mighty = legal.find(c => c.id === '♠A');
    const hqPlayed = playedCards.some(c => c.id === '♥Q');
    const hqInDiscard = (discardedKitty || []).some(c => c.id === '♥Q');
    const isMightySafe = hqPlayed || hqInDiscard;

    if (mighty && !isMightySafe && trickNo < (params.ntMightyHoldThreshold ?? 7)) {
      const otherAces = legal.filter(c => c.rank === 'A' && c.id !== '♠A');
      if (otherAces.length) return otherAces[0];
      const lowCards = legal.filter(c => c.rank !== 'A' && c.rank !== 'K');
      if (lowCards.length) return lowCards[0];
    }

    const safeAces = legal.filter(c => c.rank === 'A' && c.id !== '♠A');
    if (safeAces.length) return safeAces[0];

    if (mighty && isMightySafe) return mighty;

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
    return (candidates.length ? candidates : legal).sort((a, b) => cardPower(contract, trickNo, a, []) - cardPower(contract, trickNo, b, []))[0];
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
  return (finalCandidates.length ? finalCandidates : legal).sort((a, b) => cardPower(contract, trickNo, a, []) - cardPower(contract, trickNo, b, [])).slice(-1)[0];
}

function chooseNapoleonFollow(ctx) {
  const { hand, legal, trick, trickNo, contract, playedCards, voids, seat, currentNapPoints } = ctx;
  if (!legal || !legal.length) return null;
  const current = winningEntry(contract, trickNo, trick, trick.length < 5);
  const isNapWinning = current && isTeamNap(current.seat, contract);
  const pointsInTrick = trick.filter(e => isFace(e.card)).length;
  const winningCards = legal.filter(c => winningEntry(contract, trickNo, [...trick, { seat, card: c }], trick.length < 4)?.seat === seat);
  const low = cards => cards.slice().sort((a, b) => cardPower(contract, trickNo, a, trick) - cardPower(contract, trickNo, b, trick))[0];
  const napPoints = currentNapPoints || 0;
  if (contract.num < 20 && napPoints >= 19) {
    const nonWinning = legal.filter(c => !winningCards.includes(c));
    return lowX(ctx, nonWinning.length ? nonWinning : legal);
  }
  const remainingTricks = Math.max(1, 10 - trickNo - (trick.length >= 4 ? 1 : 0));
  const needed = Math.max(0, contract.num - napPoints);
  const urgency = needed / remainingTricks;
  if (isNapWinning) {
    if (trick.length === 3) {
      const highNonWin = legal.filter(c => isFace(c) && !winningCards.includes(c));
      if (highNonWin.length) return highNonWin.sort((a, b) => RANKS.indexOf(b.rank) - RANKS.indexOf(a.rank))[0];
    }
    if (pointsInTrick > 0) {
      const dumpFaces = legal.filter(c => isFace(c) && !winningCards.includes(c));
      if (dumpFaces.length) return dumpFaces[0];
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
  const { hand, legal, trick, trickNo, contract, call, seat, playedCards, voids } = ctx;
  if (!legal || !legal.length) return null;
  const low = cards => cards.slice().sort((a, b) => cardPower(contract, trickNo, a, trick) - cardPower(contract, trickNo, b, trick))[0];
  const winningCards = legal.filter(c => winningEntry(contract, trickNo, [...trick, { seat, card: c }], trick.length < 4)?.seat === seat);
  if (!trick.length) {
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
  if (ledSuit === call?.suit && call?.rank === '2') {
    const myCalledTwo = legal.find(c => c.id === call.id);
    if (myCalledTwo) return myCalledTwo;
  }
  const current = winningEntry(contract, trickNo, trick, trick.length < 5);
  const pointsInTrick = trick.filter(e => isFace(e.card)).length;
  if (napCard && isAbsoluteWinner(napCard, contract, trick, playedCards)) {
    const followCards = legal.filter(c => c.suit === ledSuit);
    if (followCards.length > 0) {
      const dump = pickDumpFace(followCards, contract, napCard.rank, { excludeId: call?.id });
      if (dump) return dump;
      const scoreCards = followCards.filter(c => isFace(c) && c.id !== '♠A' && !isTrumpJ(c, contract) && !isSameColorJ(c, contract));
      if (scoreCards.length) return scoreCards.sort((a, b) => RANKS.indexOf(b.rank) - RANKS.indexOf(a.rank))[0];
    }
    return lowX(ctx, legal);
  }
  if (current && isTeamNap(current.seat, contract)) return lowX(ctx, legal);
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

  if (isNT) {
    const napVoidSuits = SUITS.filter(s => voids[contract.nap]?.[s]);
    if (napVoidSuits.length > 0) {
      const exploitSuit = napVoidSuits[0];
      const exploitCards = legal.filter(c => c.suit === exploitSuit);
      if (exploitCards.length) {
        return exploitCards.sort((a, b) => RANKS.indexOf(a.rank) - RANKS.indexOf(b.rank))[0];
      }
    }
    const myAces = legal.filter(c => c.rank === 'A');
    if (myAces.length) return myAces[0];
    const allyWinningSuit = SUITS.find(s => s !== contract.suit && !voids[seat]?.[s]);
    if (allyWinningSuit) {
      const lowCards = legal.filter(c => c.suit === allyWinningSuit && !isFace(c));
      if (lowCards.length) return lowCards[0];
    }
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
  return (finalCandidates.length ? finalCandidates : legal).slice().sort((a, b) => cardPower(contract, trickNo, a, []) - cardPower(contract, trickNo, b, [])).slice(-1)[0];
}

function chooseAllianceFollow(ctx) {
  const { legal, trick, trickNo, contract, params, seat, playedCards } = ctx;
  if (!legal || !legal.length) return null;
  const low = cards => cards.slice().sort((a, b) => cardPower(contract, trickNo, a, trick) - cardPower(contract, trickNo, b, trick))[0];
  const ledSuit = trick[0].card.suit;
  const current = winningEntry(contract, trickNo, trick, trick.length < 5);
  const pointsInTrick = trick.filter(e => isFace(e.card)).length;
  const isAllyWinning = current && current.seat !== contract.nap && (!contract.solo && current.seat !== contract.deputy);
  const isEnemyWinning = !isAllyWinning;
  const winningCards = legal.filter(c => winningEntry(contract, trickNo, [...trick, { seat, card: c }], trick.length < 4)?.seat === seat);
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
// MCTS & 推測
// ==========================================
function getUnseenCards(ctx) {
  const allIds = [];
  for (const s of SUITS) for (const r of RANKS) allIds.push(s + r);
  const seen = new Set();
  (ctx.hand || []).forEach(c => seen.add(c.id));
  (ctx.playedCards || []).forEach(c => seen.add(c.id));
  (ctx.discardedKitty || []).forEach(c => seen.add(c.id));
  (ctx.trick || []).forEach(t => seen.add(t.card.id));
  return allIds.filter(id => !seen.has(id)).map(id => ({ suit: id[0], rank: id.slice(1), id }));
}

function evaluateValueNetwork(state, seat, contract, params) {
  const nn = params?.nnWeights || defaultStrategy().nnWeights;
  let score = nn.bias;
  const hand = state.hands[seat] || [];
  const hStr = handStrength(hand) / 10;
  const myTrumps = hand.filter(c => c.suit === contract.suit).length;
  const isNap = seat === contract.nap ? 1 : 0;
  const isDep = (!contract.solo && seat === contract.deputy) ? 1 : 0;
  const isAlly = (!isNap && !isDep) ? 1 : 0;
  const hasMighty = hand.some(c => c.id === '♠A') ? 1 : 0;
  const napPoints = state.points[contract.nap] + (contract.solo ? 0 : state.points[contract.deputy]);
  const needed = Math.max(0, contract.num - napPoints);
  score += nn.handStrength * hStr;
  score += nn.trumpRemaining * (myTrumps / 10);
  score += nn.pointsNeeded * (needed / 10);
  score += nn.trickNo * (state.trickNo / 10);
  score += nn.isNap * isNap;
  score += nn.isDeputy * isDep;
  score += nn.isAlly * isAlly;
  score += nn.hasMighty * hasMighty;
  return 1 / (1 + Math.exp(-score));
}

function determinizeState(ctx) {
  const unseen = [];
  for (const s of SUITS) for (const r of RANKS) unseen.push(s + r);
  const seen = new Set();
  (ctx.hand || []).forEach(c => seen.add(c.id));
  (ctx.playedCards || []).forEach(c => seen.add(c.id));
  (ctx.discardedKitty || []).forEach(c => seen.add(c.id));
  (ctx.trick || []).forEach(t => seen.add(t.card.id));
  const unseens = unseen.filter(id => !seen.has(id)).map(id => ({ suit: id[0], rank: id.slice(1), id }));
  unseens.sort(() => Math.random() - 0.5);
  const hands = [[], [], [], [], []];
  hands[ctx.seat] = ctx.hand.slice();
  
  const handCounts = [0,0,0,0,0];
  for (let s = 0; s < 5; s++) {
    if (s === ctx.seat) {
      handCounts[s] = ctx.hand.length;
    } else {
      const hasPlayed = ctx.trick.some(t => t.seat === s);
      handCounts[s] = 10 - ctx.trickNo - (hasPlayed ? 1 : 0);
    }
  }
  
  let idx = 0;
  for (let s = 0; s < 5; s++) {
    if (s === ctx.seat) continue;
    const voidInfo = ctx.voids?.[s] || {};
    let assigned = 0;
    const tempHand = [];
    const targetCount = handCounts[s];
    
    for (let i = idx; i < unseens.length && assigned < targetCount; i++) {
      const c = unseens[i];
      if (voidInfo[c.suit]) continue;
      tempHand.push(c);
      unseens.splice(i, 1);
      i--;
      assigned++;
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
  let loopGuard = 0;
  while (trickNo < 10) {
    loopGuard++;
    if (loopGuard > 100) break;
    
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
  const myTeamWon = myTeamIsNap ? made : !made;
  return myTeamWon ? 1.0 : 0.0;
}

export function chooseCardWithMCTS(ctx) {
  const legal = ctx.legal;
  if (!legal || legal.length <= 1) return legal[0];
  const params = ctx.params || defaultStrategy();
  if (ctx.trickNo > 8 && Math.random() > 0.3) return chooseCardToPlay(ctx);
  const N = {};
  const W = {};
  legal.forEach(c => { N[c.id] = 0; W[c.id] = 0; });
  const maxIterations = params.mctsSimulations || 40;
  const cParam = params.mctsExploration || 1.414;
  for (let i = 0; i < maxIterations; i++) {
    let bestCard = null;
    let bestUcb = -Infinity;
    for (const card of legal) {
      if (N[card.id] === 0) { bestCard = card; break; }
      const ucb = W[card.id] / N[card.id] + cParam * Math.sqrt(Math.log(i + 1) / N[card.id]);
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
  }
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
