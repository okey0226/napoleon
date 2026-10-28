import { SUITS, RANKS, SV, CALIBRATION, sweetSpotFactor, estimatedWinRate, findMaxHonestBid, SWEET_SPOT_BONUS, HONEST_BID_FIXED_BONUS, ALLY_LOSS_PENALTY, ALLY_WIN_BONUS, ALLY_BLOCK_BONUS, sameColorSuitOf, isSameColorSuit, defaultStrategy, quantizeStrength, bidExperienceKey, callExperienceKey, playExperienceKey, rankTierOf, trickPhaseOf, pointsTierOf, experienceConfidence, blendWithExperience } from './constants.js';

const FACE = ['10', 'J', 'Q', 'K', 'A'];

// ==========================================
// 1. カード強さ
// ==========================================
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

  if (trickNo > 0) {
    if (sameTwoEligible && card.suit === led && card.rank === "2") return 6000;
  }

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

// ==========================================
// 2. 手札強度
// ==========================================
function suitValue(hand, suit) {
  const weight = { "10": 1, J: 1.8, Q: 2.6, K: 3.5, A: 4.7 };
  const cards = hand.filter(c => c.suit === suit);
  return cards.reduce((n, c) => n + (weight[c.rank] || 0), 0) + Math.max(0, cards.length - 3) * .75;
}

export function handStrength(hand) {
  if (!Array.isArray(hand) || !hand.length) return 0;
  const base = hand.reduce((n, c) =>
    n + (RANKS.indexOf(c.rank) > 9 ? 1.25 : RANKS.indexOf(c.rank) > 7 ? 0.45 : 0)
      + (c.rank === "A" ? 0.35 : 0), 0);
  return base + Math.max(...SUITS.map(s => suitValue(hand, s))) * 0.3;
}

export function strongestSuit(hand, suits = SUITS) {
  return suits.slice().sort((a, b) => suitValue(hand, b) - suitValue(hand, a) || SV[b] - SV[a])[0];
}

export function colorStrength(hand, trump, params) {
  const base = handStrength(hand);
  const trumps = hand.filter(c => c.suit === trump);
  let trumpPenalty = 0;
  if (trumps.length === 0) trumpPenalty = -5.0;
  else if (trumps.length === 1) trumpPenalty = -2.0;
  return base + trumpPenalty + trumps.length * 0.5 + (params?.trumpBonus || 0.6) * trumps.length * 0.2;
}

export function ntHandStrength(hand, params) {
  const lengths = SUITS.map(s => hand.filter(c => c.suit === s).length);
  const maxLen = Math.max(...lengths);
  const minLen = Math.min(...lengths);

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
      if (len >= 3) score -= 0.5;
      else if (len >= 2) score -= 0.3;
      else score -= 0.15;
    }
  }

  if (minLen === 0) score -= 2.5;
  else if (minLen === 1) score -= 1.0;
  if (maxLen >= 6) score -= 1.5;
  else if (maxLen >= 5 && minLen <= 2) score -= 0.5;
  if (maxLen <= 4 && minLen >= 2) score += 1.0;

  if (hand.some(c => c.id === '♠A')) score += (params?.ntMightyBonus ?? 2.5);
  return score;
}

export function soloAdjustedStrength(hand, trump) {
  const base = handStrength(hand);
  const trumps = hand.filter(c => c.suit === trump);
  let trumpPenalty = 0;
  if (trumps.length === 0) trumpPenalty = -5.0;
  else if (trumps.length === 1) trumpPenalty = -2.0;
  const hasMighty = hand.some(c => c.id === '♠A');
  const hasTrumpJ = trump !== 'NT' && hand.some(c => c.rank === 'J' && c.suit === trump);
  return base + trumpPenalty + trumps.length * 0.5
       + (hasMighty ? 1.5 : 0) + (hasTrumpJ ? 1.0 : 0);
}

// ==========================================
// 3. 立ち判断
// ==========================================
function adjustStrengthForOpponents(base, mySuit, currentBids, params, mySeat, type) {
  let adj = 0;
  if (!Array.isArray(currentBids)) return base;
  const oppBids = currentBids.filter(b => b && b.seat !== mySeat && Number.isFinite(b.num));

  for (const bid of oppBids) {
    if (bid.suit === mySuit && bid.num >= 15) {
      adj -= params.suitConflictWeight * Math.max(0, bid.num - 14) * 0.15;
    }
    if (bid.num >= 16) {
      adj -= (params.opponentInferenceWeight ?? 0.4) * 0.6;
      adj -= (params.weakOpponentBoost ?? 0.3) * 0.4;
    } else if (bid.num >= 14) {
      adj -= (params.weakOpponentBoost ?? 0.3) * 0.25;
    } else if (bid.num >= 13) {
      adj -= (params.weakOpponentBoost ?? 0.3) * 0.1;
    }
  }

  const MAX_ADJ = 2.0;
  if (adj > MAX_ADJ) adj = MAX_ADJ;
  if (adj < -MAX_ADJ) adj = -MAX_ADJ;

  if (!Number.isFinite(adj)) adj = 0;
  return base + adj * (1 + (params.opponentInferenceWeight ?? 0.4) * 0.5);
}

function computeBidEV(p, num, strength, params) {
  if (!Number.isFinite(p)) p = 0.5;
  const maxHonest = findMaxHonestBid(strength);
  const bluffGap = Math.max(0, num - maxHonest);
  const isHonest = bluffGap === 0;
  const diff = Math.max(0, num - 12);
  const highBoost = 1 + 0.5 * Math.max(0, num - 17);
  const winGain = diff * 8;
  const lossGain = -diff * 8;
  const sweetBonus = sweetSpotFactor(p) * SWEET_SPOT_BONUS * highBoost;
  const bluffPenalty = bluffGap > 0
    ? -bluffGap * params.bluffLossMultiplier * 2 * (1 + bluffGap * 0.6)
    : 0;
  const honestBonus = isHonest
    ? HONEST_BID_FIXED_BONUS * Math.max(0, (p - 0.30) / 0.20)
    : 0;
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
  if (best && Number.isFinite(best.ev) && best.ev >= evThreshold) {
    return { num: best.num, suit: best.suit, solo: best.solo };
  }
  return null;
}

// ==========================================
// 4. 捨て札
// ==========================================
export function chooseDiscard(hand, trump) {
  if (!Array.isArray(hand)) return [];
  const value = c => RANKS.indexOf(c.rank) + (c.suit === trump ? 20 : 0);
  return hand.slice().sort((a, b) => value(a) - value(b)).slice(0, 2);
}

// ==========================================
// 5. 副官指名
// ==========================================
export function chooseDeputyCall(hand, discard, trump, level, bid, params, experience = null) {
  const p = params || {
    aceWeakSuitBonus: 0.3, aceShortBonus: 0.15, aceLongPenalty: 0.15,
    sameTwoAceCounter: 0.3, sameTwoShortBonus: 0.4, sameTwoLongPenalty: 0.25, sameTwoHighBidBonus: 0.2
  };
  const used = new Set([...(hand || []), ...(discard || [])].map(c => c.id));

  if (!used.has('♠A')) return { suit: '♠', rank: 'A', id: '♠A' };

  if (trump !== 'NT') {
    const sc = sameColorSuitOf(trump);
    const hasBackJ = hand.some(c => c.suit === sc && c.rank === 'J');
    const hasTrumpJ = hand.some(c => c.suit === trump && c.rank === 'J');

    if (!hasTrumpJ && !used.has(trump + 'J')) {
      return { suit: trump, rank: 'J', id: trump + 'J' };
    }
    if (sc && !hasBackJ && !used.has(sc + 'J')) {
      return { suit: sc, rank: 'J', id: sc + 'J' };
    }
  }

  let bestCard = null;
  let bestScore = -Infinity;

  for (const suit of SUITS) {
    if (trump !== 'NT' && suit === trump) continue;
    const cards = hand.filter(c => c.suit === suit);
    const hasA = cards.some(c => c.rank === 'A');
    const has2 = cards.some(c => c.rank === '2');
    const len = cards.length;
    const isShort = len <= 2;
    const isLong = len >= 4;

    if (!hasA && !used.has(suit + 'A')) {
      let score = 0.5;
      if (len >= 1 && len <= 3) score += p.aceWeakSuitBonus;
      if (isShort) score += p.aceShortBonus;
      if (isLong) score -= p.aceLongPenalty;
      if (trump === 'NT') score += 0.3;
      const exp = experience?.calls?.[callExperienceKey(suit + 'A', trump)];
      if (exp && exp.samples >= 3) {
        const expRate = exp.wins / exp.samples;
        score += (expRate - 0.5) * experienceConfidence(exp.samples) * 2;
      }
      if (score > bestScore) { bestScore = score; bestCard = { suit, rank: 'A', id: suit + 'A' }; }
    }

    if (!has2 && !hasA && !used.has(suit + '2')) {
      let score = p.sameTwoAceCounter;
      if (isShort) score += p.sameTwoShortBonus;
      if (isLong) score -= p.sameTwoLongPenalty;
      if (bid >= 16) score += p.sameTwoHighBidBonus;
      if (trump === 'NT') score -= 0.1;
      const exp = experience?.calls?.[callExperienceKey(suit + '2', trump)];
      if (exp && exp.samples >= 3) {
        const expRate = exp.wins / exp.samples;
        score += (expRate - 0.5) * experienceConfidence(exp.samples) * 2;
      }
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

// ==========================================
// 5b. ソロ指名
// ==========================================
export function chooseSoloCall(hand, trump = 'NT') {
  if (!Array.isArray(hand) || !hand.length) return { suit: "♠", rank: "A", id: "♠A" };
  if (hand.some(c => c.id === '♠A')) return { suit: '♠', rank: 'A', id: '♠A' };
  if (trump !== 'NT') {
    if (hand.some(c => c.id === trump + 'J')) return { suit: trump, rank: 'J', id: trump + 'J' };
    const sc = sameColorSuitOf(trump);
    if (sc && hand.some(c => c.id === sc + 'J')) return { suit: sc, rank: 'J', id: sc + 'J' };
  }
  const aces = hand.filter(c => c.rank === 'A' && (trump === 'NT' || c.suit !== trump));
  if (aces.length) {
    aces.sort((a, b) => SV[a.suit] - SV[b.suit]);
    return { suit: aces[0].suit, rank: 'A', id: aces[0].id };
  }
  const twos = hand.filter(c => c.rank === '2' && (trump === 'NT' || c.suit !== trump));
  if (twos.length) {
    twos.sort((a, b) => SV[a.suit] - SV[b.suit]);
    return { suit: twos[0].suit, rank: '2', id: twos[0].id };
  }
  const fallback = hand.slice().sort((a, b) => RANKS.indexOf(a.rank) - RANKS.indexOf(b.rank))[0];
  return { suit: fallback.suit, rank: fallback.rank, id: fallback.id };
}

// ==========================================
// 6. ユーティリティ
// ==========================================
function isFace(c) { return FACE.includes(c.rank); }
function isSameColorJ(c, contract) {
  if (contract.suit === 'NT') return false;
  return c.rank === 'J' && c.suit !== contract.suit && isSameColorSuit(c.suit, contract.suit);
}
function isTrumpJ(c, contract) {
  return contract.suit !== 'NT' && c.rank === 'J' && c.suit === contract.suit;
}
function remainingTrumps(playedCards, trumpSuit) {
  if (trumpSuit === 'NT') return 0;
  return 13 - (playedCards || []).filter(c => c.suit === trumpSuit).length;
}
function myTrumps(hand, trumpSuit) {
  if (trumpSuit === 'NT') return [];
  return (hand || []).filter(c => c.suit === trumpSuit);
}
function isTeamNap(seat, contract) {
  if (seat === contract.nap) return true;
  if (!contract.solo && contract.revealedCall && seat === contract.deputy) return true;
  return false;
}

function isAbsoluteWinner(card, contract, trick, playedCards) {
  if (card.id === '♠A' && !trick.some(e => e.card.id === '♥Q')) return true;
  if (isTrumpJ(card, contract)) return true;
  if (isSameColorJ(card, contract) && !trick.some(e => isTrumpJ(e.card, contract))) return true;
  if (card.rank === 'A') {
    const suitPlayed = (playedCards || []).filter(c => c.suit === card.suit).length;
    if (suitPlayed >= 3) return true;
    const ledSuit = trick.length > 0 ? trick[0].card.suit : card.suit;
    const allFollowed = trick.every(e => e.card.suit === ledSuit);
    if (!allFollowed) return true;
  }
  return false;
}

function countVoidSeats(voids, suit, excludeSeat) {
  let count = 0;
  for (let s = 0; s < 5; s++) {
    if (s === excludeSeat) continue;
    if (voids[s]?.[suit]) count++;
  }
  return count;
}

function iHoldStrongestTrump(hand, playedCards, trumpSuit) {
  if (trumpSuit === 'NT') return false;
  const played = new Set((playedCards || []).map(c => c.id));
  const myTr = (hand || []).filter(c => c.suit === trumpSuit);
  if (!played.has(trumpSuit + 'J') && myTr.some(c => c.rank === 'J')) return true;
  if (!played.has(trumpSuit + 'A') && myTr.some(c => c.rank === 'A')) return true;
  if (!played.has(trumpSuit + 'K') && myTr.some(c => c.rank === 'K')) {
    if (played.has(trumpSuit + 'J') && played.has(trumpSuit + 'A')) return true;
  }
  return false;
}

function pickDumpFace(followCards, contract, currentRank, opts = {}) {
  const { excludeId = null } = opts;
  const dumpable = followCards.filter(c => {
    if (excludeId && c.id === excludeId) return false;
    if (!isFace(c)) return false;
    if (c.id === '♠A') return false;
    if (isTrumpJ(c, contract)) return false;
    if (isSameColorJ(c, contract)) return false;
    if (c.rank === 'A') return false;
    if (c.rank === 'K') return false;
    return true;
  });
  if (!dumpable.length) return null;
  return dumpable.sort((a, b) => RANKS.indexOf(a.rank) - RANKS.indexOf(b.rank))[0];
}

function keepValue(c, ctx) {
  const { trickNo, contract, playedCards, hand } = ctx;
  
  if (c.id === '♠A') return 2000;
  if (contract.suit !== 'NT' && c.rank === 'J' && c.suit === contract.suit) return 1900;
  if (contract.suit !== 'NT' && c.rank === 'J' && c.suit !== contract.suit && isSameColorSuit(c.suit, contract.suit)) return 1800;
  if (c.id === '♥Q') return 1700;

  if (c.rank === '2') {
    if (trickNo >= 8) return 0;
    const faceRanks = ['10', 'J', 'Q', 'K', 'A'];
    const playedIds = new Set((playedCards || []).map(pc => pc.id));
    const allFacePlayed = faceRanks.every(r => playedIds.has(c.suit + r));
    if (allFacePlayed) return 0;
    return 50;
  }

  const playedIds = new Set((playedCards || []).map(pc => pc.id));
  const myIds = new Set((hand || []).map(hc => hc.id));
  let isStrongestInSuit = true;
  if (contract.suit !== 'NT' && c.suit === contract.suit) {
    isStrongestInSuit = false;
  } else {
    for (const r of RANKS.slice().reverse()) {
      const id = c.suit + r;
      if (playedIds.has(id)) continue;
      if (myIds.has(id)) {
        if (id === c.id) break;
        else { isStrongestInSuit = false; break; }
      }
      isStrongestInSuit = false;
      break;
    }
  }

  if (isStrongestInSuit) return 1000;

  if (['10', 'J', 'Q', 'K', 'A'].includes(c.rank)) {
    return 100 + RANKS.indexOf(c.rank);
  }

  return RANKS.indexOf(c.rank);
}

function lowX(ctx, cards) {
  if (!cards || !cards.length) return null;
  const sorted = cards.slice().sort((a, b) => {
    const va = keepValue(a, ctx);
    const vb = keepValue(b, ctx);
    if (va !== vb) return va - vb;
    return cardPower(ctx.contract, ctx.trickNo, a, ctx.trick) - cardPower(ctx.contract, ctx.trickNo, b, ctx.trick);
  });
  
  if (keepValue(sorted[0], ctx) === 0) return sorted[0];

  if (!ctx.experience || sorted.length < 2) return sorted[0];

  const role = ctx.seat === ctx.contract.nap
    ? 'nap'
    : ((!ctx.contract.solo && ctx.contract.revealedCall && ctx.seat === ctx.contract.deputy) ? 'dep' : 'ally');
  const phase = trickPhaseOf(ctx.trickNo);
  const pointsTier = pointsTierOf((ctx.trick || []).filter(e => isFace(e.card)).length);

  const look = sorted.slice(0, Math.min(2, sorted.length));
  let best = look[0], bestScore = -Infinity;
  for (const c of look) {
    const key = playExperienceKey(role, phase, pointsTier, rankTierOf(c.rank));
    const exp = ctx.experience.plays?.[key];
    let s = 0;
    if (exp && exp.samples >= 3) s = (exp.wins / exp.samples) * experienceConfidence(exp.samples);
    if (s > bestScore) { bestScore = s; best = c; }
  }
  return best;
}

// ==========================================
// 7. ナポレオン打牌（定石の強化）
// ==========================================
function chooseNapoleonLead(ctx) {
  const { hand, legal, contract, trickNo, playedCards, voids, seat, params, call, discardedKitty, currentNapPoints } = ctx;
  if (!legal || !legal.length) return null;

  const allTakeAvoid = contract.num < 20 && (currentNapPoints || 0) >= 19;
  if (allTakeAvoid) {
    const offSuitLow = legal.filter(c =>
      !isTrump(contract, c) &&
      c.id !== '♠A' &&
      c.rank !== 'A' &&
      !(c.rank === 'J' && (c.suit === contract.suit || isSameColorSuit(c.suit, contract.suit)))
    );
    if (offSuitLow.length) {
      return offSuitLow.slice().sort((a, b) => RANKS.indexOf(a.rank) - RANKS.indexOf(b.rank))[0];
    }
    return lowX(ctx, legal);
  }

  if (trickNo === 0) {
    const safeAces = legal.filter(c => c.rank === 'A' && c.suit !== contract.suit);
    if (safeAces.length) {
      const nonMightyAces = safeAces.filter(c => c.id !== '♠A');
      if (nonMightyAces.length) return nonMightyAces[0];
      if (safeAces.some(c => c.id === '♠A')) {
        const hqPlayed = playedCards.some(c => c.id === '♥Q');
        const hqInDiscard = (discardedKitty || []).some(c => c.id === '♥Q');
        if (hqPlayed || hqInDiscard) return safeAces.find(c => c.id === '♠A');
      }
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
    if (c.id === '♠A') {
      if (playedCards.some(pc => pc.id === '♥Q')) return true;
      return countVoidSeats(voids, '♠', seat) === 0;
    }
    if (hand.some(hc => hc.suit === c.suit && hc.rank === '2')) return true;
    if ((discardedKitty || []).some(k => k.id === c.suit + '2')) return true;
    if (playedCards.some(pc => pc.suit === c.suit && pc.rank === '2')) {
      return countVoidSeats(voids, c.suit, seat) === 0;
    }
    return false;
  });
  if (safeAces.length) {
    return safeAces.sort((a, b) => playedCards.filter(pc => pc.suit === b.suit).length - playedCards.filter(pc => pc.suit === a.suit).length)[0];
  }

  const suitLens = SUITS.filter(s => s !== contract.suit)
    .map(s => ({ suit: s, count: legal.filter(c => c.suit === s).length }))
    .sort((a, b) => b.count - a.count);
  for (const sl of suitLens) {
    if (sl.count >= 3) {
      const low = legal.filter(c => c.suit === sl.suit && !isFace(c) && c.rank !== '2')
        .sort((a, b) => RANKS.indexOf(a.rank) - RANKS.indexOf(b.rank))[0];
      if (low) return low;
    }
  }

  const finalCandidates = legal.filter(c => c.rank !== '2');
  return (finalCandidates.length ? finalCandidates : legal).sort((a, b) => cardPower(contract, trickNo, a, []) - cardPower(contract, trickNo, b, []))[0];
}

function chooseNapoleonFollow(ctx) {
  const { hand, legal, trick, trickNo, contract, playedCards, voids, seat, params, currentNapPoints } = ctx;
  if (!legal || !legal.length) return null;

  const current = winningEntry(contract, trickNo, trick, trick.length < 5);
  const isNapWinning = current && isTeamNap(current.seat, contract);
  const pointsInTrick = trick.filter(e => isFace(e.card)).length;

  const winningCards = legal.filter(c =>
    winningEntry(contract, trickNo, [...trick, { seat, card: c }], trick.length < 4)?.seat === seat
  );
  const low = cards => cards.slice().sort((a, b) =>
    cardPower(contract, trickNo, a, trick) - cardPower(contract, trickNo, b, trick))[0];

  const napPoints = currentNapPoints || 0;

  const allTakeAvoid = contract.num < 20 && napPoints >= 19;
  if (allTakeAvoid) {
    const nonWinning = legal.filter(c => !winningCards.includes(c));
    const pool = nonWinning.length ? nonWinning : legal;
    return lowX(ctx, pool);
  }

  const remainingTricks = Math.max(1, 10 - trickNo - (trick.length >= 4 ? 1 : 0));
  const needed = Math.max(0, contract.num - napPoints);
  const urgency = needed / remainingTricks;

  if (isNapWinning) {
    if (trick.length === 3) {
      const highNonWin = legal.filter(c => isFace(c) && !winningCards.includes(c));
      if (highNonWin.length) {
        return highNonWin.sort((a, b) => RANKS.indexOf(b.rank) - RANKS.indexOf(a.rank))[0];
      }
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

// ==========================================
// 8. 副官打牌
// ==========================================
export function chooseDeputyCard(ctx) {
  const { hand, legal, trick, trickNo, contract, call, seat, params, playedCards, voids } = ctx;
  if (!legal || !legal.length) return null;
  const low = cards => cards.slice().sort((a, b) =>
    cardPower(contract, trickNo, a, trick) - cardPower(contract, trickNo, b, trick))[0];

  const winningCards = legal.filter(c =>
    winningEntry(contract, trickNo, [...trick, { seat, card: c }], trick.length < 4)?.seat === seat
  );

  if (!trick.length) {
    const napCanWinSuit = (suit) => {
      const napHasVoid = voids[contract.nap]?.[suit];
      const remainingTrumpsCount = contract.suit !== 'NT' ? 13 - (playedCards || []).filter(c => c.suit === contract.suit).length : 0;
      return napHasVoid && remainingTrumpsCount > 0;
    };

    const secureAces = legal.filter(c => c.rank === 'A' && !isTrumpJ(c, contract) && !isSameColorJ(c, contract));
    if (secureAces.length) {
      const ace = secureAces[0];
      if (napCanWinSuit(ace.suit)) {
        if (trickNo >= 4) return ace;
        const lowCards = legal.filter(c => c.rank !== 'A' && c.suit !== contract.suit);
        if (lowCards.length) return low(lowCards);
      } else {
        return ace;
      }
    }

    const winningLeads = legal.filter(c =>
      c.rank === 'A' || isTrumpJ(c, contract) || isSameColorJ(c, contract)
    );
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
      
      const dumpHighCard = followCards.filter(c =>
        (c.rank === 'Q' || c.rank === '10' || (c.rank === 'J' && !isTrumpJ(c, contract) && !isSameColorJ(c, contract))) &&
        c.id !== call?.id &&
        c.id !== '♠A' && !isTrumpJ(c, contract) && !isSameColorJ(c, contract)
      );
      if (dumpHighCard.length) {
        dumpHighCard.sort((a, b) => RANKS.indexOf(a.rank) - RANKS.indexOf(b.rank));
        return dumpHighCard[0];
      }
    }
    return lowX(ctx, legal);
  }

  if (current && isTeamNap(current.seat, contract)) return lowX(ctx, legal);

  if (pointsInTrick > 0 && winningCards.length) return low(winningCards);

  if (call?.suit && call.suit !== contract.suit && ledSuit === call.suit) {
    const myAce = legal.find(c => c.suit === call.suit && c.rank === 'A');
    if (myAce && winningCards.includes(myAce)) {
      return myAce;
    }
  }

  return lowX(ctx, legal);
}

// ==========================================
// 9. 連合軍打牌（セイム2定石の実装）
// ==========================================
function estimateNapWeakSuit(playedCards, contract) {
  const napDiscards = (playedCards || []).filter(c => c.seat === contract.nap);
  const counts = {};
  for (const c of napDiscards) counts[c.suit] = (counts[c.suit] || 0) + 1;
  const entries = Object.entries(counts).sort((a, b) => b[1] - a[1]);
  return entries[0]?.[0] || null;
}

function chooseAllianceLead(ctx) {
  const { hand, legal, trickNo, contract, params, playedCards, voids, seat } = ctx;
  if (!legal || !legal.length) return null;
  const p = params || {};

  if (trickNo > 0 && trickNo <= (p.allySameTwoWindow ?? 4)) {
    const faceRanks = ['10', 'J', 'Q', 'K', 'A'];
    const playedIds = new Set((playedCards || []).map(pc => pc.id));
    
    const freshTwos = legal.filter(c => {
      if (c.rank !== '2') return false;
      if (contract.suit !== 'NT' && c.suit === contract.suit) return false;
      if ((playedCards || []).some(pc => pc.suit === c.suit)) return false;
      if (countVoidSeats(voids, c.suit, seat) > 0) return false;
      if (contract.suit !== 'NT' && voids[contract.nap]?.[c.suit]) return false;
      if (faceRanks.every(r => playedIds.has(c.suit + r))) return false;
      return true;
    });
    if (freshTwos.length && Math.random() < (p.allySameTwoLeadChance ?? 0.55)) {
      return freshTwos[0];
    }
  }

  if (contract.suit !== 'NT') {
    const trump = contract.suit;
    const sc = sameColorSuitOf(trump);
    const avoidSuits = [trump, sc].filter(Boolean);

    const leadable = legal.filter(c => !avoidSuits.includes(c.suit) && !isFace(c) && (trickNo > 0 || c.rank !== '2'));
    if (leadable.length && Math.random() < Math.min(1.0, p.napWeaknessLeadWeight ?? 0.8)) {
      const bySuitLen = SUITS.filter(s => !avoidSuits.includes(s))
        .map(s => ({ suit: s, cards: leadable.filter(c => c.suit === s) }))
        .filter(x => x.cards.length > 0)
        .sort((a, b) => b.cards.length - a.cards.length);
      if (bySuitLen.length) {
        return bySuitLen[0].cards.sort((a, b) => RANKS.indexOf(a.rank) - RANKS.indexOf(b.rank))[0];
      }
    }
  }

  if (contract.suit === 'NT') {
    const spadeLow = legal.filter(c => c.suit === '♠' && !isFace(c) && (trickNo > 0 || c.rank !== '2'));
    if (spadeLow.length && trickNo <= 3 && Math.random() < (p.spadeLeadPriority || 0.7) + 0.2) {
      return spadeLow.sort((a, b) => RANKS.indexOf(a.rank) - RANKS.indexOf(b.rank))[0];
    }
    const weakSuit = estimateNapWeakSuit(playedCards, contract);
    if (weakSuit) {
      const weakLow = legal.filter(c => c.suit === weakSuit && !isFace(c) && (trickNo > 0 || c.rank !== '2'));
      if (weakLow.length) return weakLow[0];
    }
  }

  const suitLens = SUITS.map(s => ({ suit: s, cards: legal.filter(c => c.suit === s) }))
    .filter(x => x.suit !== contract.suit && x.cards.length >= 3)
    .sort((a, b) => b.cards.length - a.cards.length);
  for (const sl of suitLens) {
    const lowCard = sl.cards.filter(c => !isFace(c) && (trickNo > 0 || c.rank !== '2'))[0];
    if (lowCard) return lowCard;
  }

  const finalCandidates = trickNo === 0 ? legal.filter(c => c.rank !== '2') : legal;
  return (finalCandidates.length ? finalCandidates : legal).slice().sort((a, b) => cardPower(contract, trickNo, a, []) - cardPower(contract, trickNo, b, []) )[0];
}

function chooseAllianceFollow(ctx) {
  const { legal, trick, trickNo, contract, params, seat, playedCards } = ctx;
  if (!legal || !legal.length) return null;
  const low = cards => cards.slice().sort((a, b) =>
    cardPower(contract, trickNo, a, trick) - cardPower(contract, trickNo, b, trick))[0];

  const ledSuit = trick[0].card.suit;
  const current = winningEntry(contract, trickNo, trick, trick.length < 5);
  const pointsInTrick = trick.filter(e => isFace(e.card)).length;
  const currentIsEnemy = isTeamNap(current.seat, contract);

  const winningCards = legal.filter(c =>
    winningEntry(contract, trickNo, [...trick, { seat, card: c }], trick.length < 4)?.seat === seat
  );

  // ★ セイム2の定石（第1トリック以外）
  if (trickNo > 0) {
    const myTwo = legal.find(c => c.rank === '2' && c.suit === ledSuit);
    if (myTwo) {
      const suitPlayedCount = (playedCards || []).filter(pc => pc.suit === ledSuit).length;
      const isFirstRound = suitPlayedCount === 0;

      if (isFirstRound) {
        if (contract.suit !== 'NT') {
          return myTwo;
        } else {
          const napEntry = trick.find(e => e.seat === contract.nap);
          const napCard = napEntry?.card;
          const napIsFace = napCard && isFace(napCard);
          const napOrder = trick.findIndex(e => e.seat === contract.nap);
          const myOrder = trick.length;
          const isBeforeNap = napOrder === -1 || myOrder < napOrder;

          if (isBeforeNap) {
            return myTwo;
          } else {
            if (napIsFace) {
              return myTwo;
            }
            if (pointsInTrick >= 2) {
              return myTwo;
            }
            const dumpFaces = legal.filter(c => isFace(c) && c.id !== myTwo.id);
            if (dumpFaces.length) return dumpFaces[0];
          }
        }
      }
    }
  }

  if (!currentIsEnemy && current.seat !== seat) {
    const followCards = legal.filter(c => c.suit === ledSuit);
    if (followCards.length > 0) {
      const dumpHighCard = followCards.filter(c =>
        (c.rank === 'Q' || c.rank === '10' || (c.rank === 'J' && !isTrumpJ(c, contract) && !isSameColorJ(c, contract))) &&
        c.id !== '♠A' && !isTrumpJ(c, contract) && !isSameColorJ(c, contract)
      );
      if (dumpHighCard.length) {
        dumpHighCard.sort((a, b) => RANKS.indexOf(a.rank) - RANKS.indexOf(b.rank));
        return dumpHighCard[0];
      }

      const dump = pickDumpFace(followCards, contract, current.card.rank);
      if (dump) return dump;
    }
    return lowX(ctx, legal);
  }

  if (trickNo >= 1 && pointsInTrick >= 1) {
    const sameTwo = winningCards.find(c => c.rank === '2' && c.suit === ledSuit);
    if (sameTwo) return sameTwo;
  }

  if (pointsInTrick > 0 && winningCards.length) return low(winningCards);
  if (currentIsEnemy && winningCards.length && (pointsInTrick > 0 || trickNo >= 3)) return low(winningCards);

  if (contract.suit !== 'NT' && pointsInTrick > 0
      && legal[0]?.suit !== ledSuit && currentIsEnemy) {
    const trumps = legal.filter(c => isTrump(contract, c));
    if (trumps.length) return low(trumps);
  }

  return lowX(ctx, legal);
}

// ==========================================
// 10. メインディスパッチャー
// ==========================================
export function chooseCardToPlay(ctx) {
  const { seat, contract, legal, hand } = ctx;
  if (!legal || !legal.length) return null;
  if (seat === contract.nap) {
    if (!ctx.trick.length) return chooseNapoleonLead(ctx);
    return chooseNapoleonFollow(ctx);
  }
  if (!contract.solo && contract.revealedCall && seat === contract.deputy) {
    return chooseDeputyCard(ctx);
  }
  if (!contract.solo && !contract.revealedCall && contract.call && hand.some(c => c.id === contract.call.id)) {
    return chooseDeputyCard(ctx);
  }
  if (!ctx.trick.length) return chooseAllianceLead(ctx);
  return chooseAllianceFollow(ctx);
}
