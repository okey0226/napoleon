// ============================================================
// worker/match-state.js
// 依存: constants.js のみ
// 役割: マッチ状態 m の投影・判定（mutable 操作は一切なし）
// ============================================================
import { SUITS } from '../constants.js';

// ---------------- 立ち最低枚数の計算 ----------------
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
    return {
      minBid: Math.min(20, raw), rawMin: raw, canOvertake: raw <= 20,
      incentiveBroken: false, soloRequired: false, case: 'C',
      details: { S3, S4, S5, needNapOverFourth: raw }
    };
  }
  if (napSeat === fourthSeat && deputySeat !== bottomSeat) {
    const raw = 13 + f(S4 - S5, 6 * m);
    return {
      minBid: Math.min(20, raw), rawMin: raw, canOvertake: raw <= 20,
      incentiveBroken: false, soloRequired: false, case: 'D',
      details: { S3, S4, S5, needNapLoss: raw }
    };
  }
  return null;
}

export function isSoloForcedInMatch(m) {
  if (m.round < 10 || !m.contract) return false;
  const ranked = m.matchScores.map((s, i) => ({ s, i })).sort((a, b) => a.s - b.s || a.i - b.i);
  const bottomSeat = ranked[0].i;
  if (m.contract.nap !== bottomSeat) return false;
  const fourthSeat = ranked[1].i;
  const r = computeTeamMinBid(m.matchScores, m.mult, bottomSeat, fourthSeat);
  return r?.soloRequired === true;
}

export function isSafeToCashAceInMatch(m, suit, seat) {
  if (!m.contract) return false;
  if (suit === '♠') return true;
  if (m.trickNo > 0) {
    const twoPlayed = m.playedCards.some(c => c.id === suit + '2');
    if (!twoPlayed) {
      const anyVoid = [0, 1, 2, 3, 4].some(s => s !== seat && m.voids[s] && m.voids[s][suit]);
      if (!anyVoid) return false;
    }
  }
  if (m.contract.suit !== 'NT' && m.contract.suit !== suit) {
    for (let s = 0; s < 5; s++) {
      if (s === seat) continue;
      if (m.contract.revealedCall) {
        if (s === m.contract.nap || (!m.contract.solo && s === m.contract.deputy)) continue;
      } else {
        if (s === m.contract.nap) continue;
      }
      if (m.voids[s] && m.voids[s][suit]) return false;
    }
  }
  return true;
}

// ---------------- 状態投影 ----------------
export function legalCards(m, seat) {
  const h = m.seats[seat].hand;
  if (!m.trick.length) return h;
  const led = m.trick[0].card.suit;
  const follow = h.filter(c => c.suit === led);
  return follow.length ? follow : h;
}

export function validBid(m, n, s) {
  const h = m.auction.high;
  return Number.isInteger(n)
    && n >= (m.auction.minBid || 13) && n <= 20
    && (SUITS.includes(s) || s === 'NT')
    && (n > h.num || (n === h.num && SV[s] > SV[h.suit]));
}

export function artfulCard(m, entry, trick) {
  const c = entry.card;
  const led = trick[0].card.suit;
  const black = s => s === '♣' || s === '♠';
  return c.id === '♠A'
    || (c.id === '♥Q' && trick.some(x => x.card.id === '♠A'))
    || (c.rank === 'J' && m.contract.suit !== 'NT'
        && (c.suit === m.contract.suit
            || (c.suit !== m.contract.suit && black(c.suit) === black(m.contract.suit))))
    || (c.rank === '2' && c.suit === led && trick.every(x => x.card.suit === led));
}

export function publicState(m) {
  return {
    matchId: m.id, mode: m.kind, code: m.code, botLevel: m.botLevel,
    phase: m.phase, round: m.round, mult: m.mult,
    matchScores: m.matchScores, bidHistory: m.bidHistory || [],
    playoff: !!m.playoff, appeal: m.appeal, appealInfo: m.appealInfo || '',
    lastTrickWinner: m.lastTrickWinner ?? null,
    finalRoundRule: m.round >= 10 ? finalAuctionRule(m.matchScores, m.mult) : null,
    notice: m.notice, active: m.active,
    players: m.seats.map((p, seat) => ({
      seat,
      name: p.bot ? p.player.username : (p.player.playerId || p.player.username),
      username: p.player.username,
      rating: p.player.rating,
      bot: p.bot,
      handCount: p.hand.length,
      points: p.points,
      taken: p.taken,
      active: m.active,
      approved: m.phase === 'auction' && m.auction && Array.isArray(m.auction.active) && !m.auction.active.includes(seat),
      role: m.contract
        ? (m.contract.nap === seat
            ? (m.contract.revealedCall && m.contract.solo ? 'ナポレオン（ひとり立ち）' : 'ナポレオン')
            : !m.contract.revealedCall ? ''
            : m.contract.deputy === seat ? '副官' : '連合軍')
        : ''
    })),
    kitty: m.phase === 'auction' ? m.kitty : [],
    auction: m.auction ? {
      high: m.auction.high,
      active: m.auction.active,
      minBid: m.auction.minBid || 13,
      requiredBidSeat: m.auction.requiredBidSeat ?? null
    } : null,
    contract: m.contract ? {
      nap: m.contract.nap, num: m.contract.num, suit: m.contract.suit,
      deputy: m.contract.revealedCall ? m.contract.deputy : -1,
      solo: m.contract.revealedCall ? m.contract.solo : null,
      revealedCall: !!m.contract.revealedCall, call: m.contract.call
    } : null,
    trick: m.trick.map(x => ({ seat: x.seat, card: x.card })),
    trickNo: m.trickNo, deadline: m.deadline, result: m.result || null
  };
}
