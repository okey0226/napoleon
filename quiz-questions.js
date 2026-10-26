// quiz-questions.js — 何切る問題バンク（決定論的生成 / 50問版）
import { SUITS, RANKS, defaultStrategy, sortHand, estimatedWinRate } from './constants.js';
import {
  shouldBid, chooseDiscard, chooseDeputyCall, chooseCardToPlay,
  winningEntry, handStrength, colorStrength, ntHandStrength
} from './ai-tactics.js';

export const QUIZ_CATEGORIES = ['bid', 'call', 'discard', 'play'];
export const QUIZ_COUNTS = { bid: 10, call: 10, discard: 10, play: 20 };
export const QUIZ_LABELS = {
  bid: '何で立つ？',
  call: '誰を指名する？',
  discard: '何を切る？',
  play: '何を出す？'
};

// ===== bid の自由入力エンコード =====
export const BID_SUITS = ['♣', '♦', '♥', '♠', 'NT'];
export function encodeBid(bid) {
  if (!bid || bid.pass) return 0;
  const suitIdx = BID_SUITS.indexOf(bid.suit);
  if (suitIdx < 0) return 0;
  const numIdx = bid.num - 13;
  if (numIdx < 0 || numIdx > 7) return 0;
  return 1 + numIdx * 10 + suitIdx + (bid.solo ? 5 : 0);
}
export function decodeBid(encoded) {
  const e = Number(encoded);
  if (!Number.isFinite(e) || e <= 0) return { pass: true, num: null, suit: null, solo: false, label: 'パス' };
  const v = e - 1;
  const numIdx = Math.floor(v / 10);
  const rem = v % 10;
  const solo = rem >= 5;
  const suitIdx = rem - (solo ? 5 : 0);
  if (numIdx < 0 || numIdx > 7 || suitIdx < 0 || suitIdx > 4) {
    return { pass: true, num: null, suit: null, solo: false, label: 'パス' };
  }
  const num = 13 + numIdx, suit = BID_SUITS[suitIdx];
  return { pass: false, num, suit, solo, label: `${num}${suit}${solo ? '（ソロ）' : ''}` };
}

export function totalQuestionCount() {
  return QUIZ_CATEGORIES.reduce((n, c) => n + QUIZ_COUNTS[c], 0);
}
export function makeQuestionId(category, index) {
  return `${category}-${String(index + 1).padStart(4, '0')}`;
}
export function parseQuestionId(id) {
  if (typeof id !== 'string') return null;
  const m = /^(bid|call|discard|play)-(\d{1,4})$/.exec(id);
  if (!m) return null;
  const category = m[1], index = Number(m[2]) - 1;
  if (index < 0 || index >= QUIZ_COUNTS[category]) return null;
  return { category, index };
}

// --- 決定論的乱数（Mulberry32） ---
function mulberry32(seed) {
  let s = seed | 0;
  return function () {
    s = (s + 0x6D2B79F5) | 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function hashStr(str) {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; }
  return h >>> 0;
}
function shuffleWithRng(arr, rng) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(rng() * (i + 1));[a[i], a[j]] = [a[j], a[i]]; }
  return a;
}
function buildDeck() {
  const d = [];
  for (const s of SUITS) for (const r of RANKS) d.push({ suit: s, rank: r, id: s + r });
  return d;
}
function cardFromId(id) { return { suit: id[0], rank: id.slice(1), id }; }
function SV(s) { return { '♣': 1, '♦': 2, '♥': 3, '♠': 4, NT: 5 }[s] || 0; }

// ============ 立ち履歴の生成 ============
function generateBidHistory(rng, high, mySeat, numPlayers = 5) {
  if (high.num < 13) return [];
  const suitPool = SUITS.concat(['NT']);
  const otherSeats = [];
  for (let i = 0; i < numPlayers; i++) if (i !== mySeat) otherSeats.push(i);

  const allBids = [];
  for (let n = 13; n <= high.num; n++) {
    for (const s of suitPool) {
      if (n < high.num) allBids.push({ num: n, suit: s });
      else if (SV(s) < SV(high.suit)) allBids.push({ num: n, suit: s });
    }
  }
  if (allBids.length === 0) {
    return [{ seat: high.player, num: high.num, suit: high.suit }];
  }

  const numIntermediate = Math.floor(rng() * 4);
  let finalPicked = [];
  if (numIntermediate > 0) {
    const shuffled = shuffleWithRng(allBids, rng);
    const picked = shuffled.slice(0, numIntermediate);
    picked.sort((a, b) => a.num - b.num || SV(a.suit) - SV(b.suit));
    let last = { num: 12, suit: '' };
    for (const bid of picked) {
      if (bid.num > last.num || (bid.num === last.num && SV(bid.suit) > SV(last.suit))) {
        finalPicked.push(bid);
        last = bid;
      }
    }
  }

  const history = [];
  const seatPool = shuffleWithRng(otherSeats.filter(s => s !== high.player), rng);
  if (seatPool.length === 0) seatPool.push(high.player);
  for (let i = 0; i < finalPicked.length; i++) {
    history.push({ seat: seatPool[i % seatPool.length], num: finalPicked[i].num, suit: finalPicked[i].suit });
  }
  history.push({ seat: high.player, num: high.num, suit: high.suit });
  return history;
}

// ============ 1) bid ============
function genBidQuestion(rng, idx) {
  const deck = shuffleWithRng(buildDeck(), rng);
  const hand = deck.splice(0, 10); sortHand(hand);
  const params = defaultStrategy();
  const mySeat = 0;
  const suitPool = SUITS.concat(['NT']);

  const hasHighBid = rng() < 0.7;
  let high, bidHistory;

  if (hasHighBid) {
    const highNum = 13 + Math.floor(rng() * 5);
    const highSuit = suitPool[Math.floor(rng() * suitPool.length)];
    const highPlayer = 1 + Math.floor(rng() * 4);
    high = { num: highNum, suit: highSuit, player: highPlayer, solo: false };
    bidHistory = generateBidHistory(rng, high, mySeat, 5);
  } else {
    high = { num: 12, suit: '', player: -1, solo: false };
    bidHistory = [];
  }

  const historyForAI = bidHistory.map(b => ({ round: 1, seat: b.seat, num: b.num, suit: b.suit }));
  const aiBid = shouldBid(hand, high, 13, params, historyForAI, mySeat, null);
  const aiEncoded = aiBid ? encodeBid({ num: aiBid.num, suit: aiBid.suit, solo: !!aiBid.solo }) : 0;

  return {
    id: makeQuestionId('bid', idx),
    category: 'bid',
    title: '競り：何で立つ？',
    inputMode: 'bid',
    scenario: {
      hand: hand.map(c => c.id),
      high: { num: high.num, suit: high.suit, player: high.player },
      bidHistory,
      mySeat,
      minBid: 13
    },
    options: [],
    aiAnswerIndex: aiEncoded,
    explanation: aiBid
      ? `AIは ${aiBid.num}${aiBid.suit}${aiBid.solo ? '（ソロ）' : ''} を選択。`
      : 'AIはパスを選択。'
  };
}

// ============ 2) call ============
function genCallQuestion(rng, idx) {
  const deck = shuffleWithRng(buildDeck(), rng);
  const hands = [];
  for (let i = 0; i < 5; i++) { hands.push(deck.splice(0, 10)); sortHand(hands[i]); }
  const kitty = deck.splice(0, 2);
  const params = defaultStrategy();
  const seat = Math.floor(rng() * 5);
  const twelve = hands[seat].concat(kitty); sortHand(twelve);
  const suit = SUITS.concat(['NT'])[Math.floor(rng() * 5)];
  const num = 13 + Math.floor(rng() * 4);
  const discarded = chooseDiscard(twelve, suit);
  const tenCard = twelve.filter(c => !discarded.some(d => d.id === c.id)); sortHand(tenCard);
  const aiCall = chooseDeputyCall(tenCard, discarded, suit, 3, num, params, null);
  const candidates = [], seenIds = new Set();
  const inHand = new Set(tenCard.map(c => c.id));
  const inDiscard = new Set(discarded.map(c => c.id));
  const push = (s, r) => {
    const id = s + r;
    if (seenIds.has(id) || inHand.has(id) || inDiscard.has(id)) return;
    candidates.push({ suit: s, rank: r, id }); seenIds.add(id);
  };
  push('♠', 'A');
  if (suit !== 'NT') push(suit, 'J');
  const sameColorMap = { '♣': '♠', '♠': '♣', '♦': '♥', '♥': '♦' };
  if (suit !== 'NT') push(sameColorMap[suit], 'J');
  const shuffledSuits = shuffleWithRng(SUITS, rng);
  for (const s of shuffledSuits) push(s, 'A');
  for (const s of shuffledSuits) push(s, '2');
  const allShuf = shuffleWithRng(buildDeck(), rng);
  for (const c of allShuf) { if (candidates.length >= 8) break; push(c.suit, c.rank); }
  if (!seenIds.has(aiCall.id)) candidates.push({ suit: aiCall.suit, rank: aiCall.rank, id: aiCall.id });
  const displayed = shuffleWithRng(candidates.slice(0, 8), rng);
  const correctIdx = displayed.findIndex(c => c.id === aiCall.id);
  return {
    id: makeQuestionId('call', idx), category: 'call',
    title: '副官指名：どのカードを指名する？',
    scenario: { hand: tenCard.map(c => c.id), discarded: discarded.map(c => c.id), contract: { suit, num, seat } },
    options: displayed.map((c, i) => ({ index: i, label: c.id, value: { suit: c.suit, rank: c.rank, id: c.id } })),
    aiAnswerIndex: correctIdx >= 0 ? correctIdx : 0,
    explanation: `AIは ${aiCall.id} を選択。`
  };
}

// ============ 3) discard ============
function genDiscardQuestion(rng, idx) {
  const deck = shuffleWithRng(buildDeck(), rng);
  const hand = deck.splice(0, 12); sortHand(hand);
  const suit = SUITS.concat(['NT'])[Math.floor(rng() * 5)];
  const num = 13 + Math.floor(rng() * 5);
  const params = defaultStrategy();
  const aiDiscard = chooseDiscard(hand, suit);
  const aiIds = new Set(aiDiscard.map(c => c.id));
  const pairs = [];
  const pushPair = (a, b) => {
    if (!a || !b || a.id === b.id) return;
    const ids = [a.id, b.id].sort();
    const key = ids.join('|');
    if (pairs.some(p => p.key === key)) return;
    pairs.push({ key, cards: [a, b] });
  };
  if (aiDiscard.length === 2) pushPair(aiDiscard[0], aiDiscard[1]);
  const lowPool = hand.filter(c => RANKS.indexOf(c.rank) <= 6);
  const shuffledLow = shuffleWithRng(lowPool, rng);
  for (const a of shuffledLow) {
    for (const b of shuffledLow) {
      if (a.id === b.id) continue;
      pushPair(a, b);
      if (pairs.length >= 6) break;
    }
    if (pairs.length >= 6) break;
  }
  const shufHand = shuffleWithRng(hand, rng);
  for (let i = 0; i < shufHand.length && pairs.length < 6; i++)
    for (let j = i + 1; j < shufHand.length && pairs.length < 6; j++) pushPair(shufHand[i], shufHand[j]);
  const displayed = shuffleWithRng(pairs.slice(0, 6), rng);
  const correctIdx = displayed.findIndex(p => p.key === [...aiIds].sort().join('|'));
  return {
    id: makeQuestionId('discard', idx), category: 'discard',
    title: '浮き札の交換：どの2枚を切る？',
    scenario: { hand: hand.map(c => c.id), contract: { suit, num, seat: 0 } },
    options: displayed.map((p, i) => ({ index: i, label: p.cards.map(c => c.id).join(' + '), value: p.cards.map(c => c.id) })),
    aiAnswerIndex: correctIdx >= 0 ? correctIdx : 0,
    explanation: `AIは ${aiDiscard.map(c => c.id).join(' + ')} を選択。`
  };
}

// ============ 4) play ============
function simulateOnePlayScenario(rng) {
  const deck = shuffleWithRng(buildDeck(), rng);
  const hands = [];
  for (let i = 0; i < 5; i++) { hands.push(deck.splice(0, 10)); sortHand(hands[i]); }
  const kitty = deck.splice(0, 2);
  const params = defaultStrategy();
  const nap = Math.floor(rng() * 5);
  const suit = SUITS.concat(['NT'])[Math.floor(rng() * 5)];
  const num = 13 + Math.floor(rng() * 4);
  hands[nap].push(...kitty); sortHand(hands[nap]);
  const discarded = chooseDiscard(hands[nap], suit);
  hands[nap] = hands[nap].filter(c => !discarded.some(d => d.id === c.id)); sortHand(hands[nap]);
  const call = chooseDeputyCall(hands[nap], discarded, suit, 3, num, params, null);
  let deputy = -1;
  for (let i = 0; i < 5; i++) if (i !== nap && hands[i].some(c => c.id === call.id)) { deputy = i; break; }
  const solo = deputy < 0; if (solo) deputy = nap;
  const contract = { nap, num, suit, deputy, solo, call, revealedCall: false };
  const playedCards = [];
  const voids = [{}, {}, {}, {}, {}];
  let active = nap, trickNo = 0;
  const targetTrick = 1 + Math.floor(rng() * 5);
  const targetSeat = Math.floor(rng() * 5);
  let captured = null;
  while (trickNo <= targetTrick && !captured) {
    const trick = [];
    for (let i = 0; i < 5; i++) {
      const seat = (active + i) % 5;
      const hand = hands[seat];
      const led = trick.length ? trick[0].card.suit : null;
      const legal = !led ? hand : (hand.some(c => c.suit === led) ? hand.filter(c => c.suit === led) : hand);
      if (trickNo === targetTrick && seat === targetSeat) {
        captured = {
          contract: JSON.parse(JSON.stringify(contract)),
          hand: hand.map(c => c.id),
          trick: trick.map(e => ({ seat: e.seat, card: e.card.id })),
          trickNo, playedCards: playedCards.slice(), voids: JSON.parse(JSON.stringify(voids)),
          seat: targetSeat, call: { suit: call.suit, rank: call.rank, id: call.id },
          discarded: discarded.map(c => c.id)
        };
        break;
      }
      const ctx = { hand, legal, trick, trickNo, contract, playedCards, voids, seat, deputy, discardedKitty: discarded, isRevealed: contract.revealedCall, params, call, currentNapPoints: 0, experience: null };
      const chosen = chooseCardToPlay(ctx) || legal[0];
      if (led && chosen.suit !== led) { if (!voids[seat]) voids[seat] = {}; voids[seat][led] = true; }
      playedCards.push({ id: chosen.id, suit: chosen.suit, rank: chosen.rank, seat });
      if (chosen.id === call.id) contract.revealedCall = true;
      trick.push({ seat, card: chosen });
      hands[seat] = hand.filter(c => c.id !== chosen.id);
    }
    if (captured) break;
    const w = winningEntry(contract, trickNo, trick);
    active = w.seat; trickNo++;
  }
  return captured;
}

function genPlayQuestion(rng, idx) {
  const params = defaultStrategy();
  for (let attempt = 0; attempt < 30; attempt++) {
    const cap = simulateOnePlayScenario(rng);
    if (!cap || !cap.trick.length) continue;
    const hand = cap.hand.map(cardFromId);
    const trick = cap.trick.map(e => ({ seat: e.seat, card: cardFromId(e.card) }));
    const led = trick[0]?.card.suit;
    const legal = !led ? hand : (hand.some(c => c.suit === led) ? hand.filter(c => c.suit === led) : hand);
    if (legal.length < 2) continue;
    const ctx = { hand, legal, trick, trickNo: cap.trickNo, contract: cap.contract, playedCards: cap.playedCards, voids: cap.voids, seat: cap.seat, deputy: cap.contract.deputy, discardedKitty: [], isRevealed: cap.contract.revealedCall, params, call: cap.contract.call, currentNapPoints: 0, experience: null };
    const aiChoice = chooseCardToPlay(ctx);
    if (!aiChoice) continue;
    const options = legal.map((c, i) => ({ index: i, label: c.id, value: c.id }));
    const correctIdx = legal.findIndex(c => c.id === aiChoice.id);
    let roleLabel = '連合軍';
    if (cap.seat === cap.contract.nap) roleLabel = 'ナポレオン';
    else if (cap.seat === cap.contract.deputy && cap.contract.revealedCall) roleLabel = '副官';
    else if (hand.some(c => c.id === cap.contract.call.id)) roleLabel = '副官（未公開）';
    return {
      id: makeQuestionId('play', idx), category: 'play',
      title: `第${cap.trickNo + 1}トリック：何を出す？（${roleLabel}）`,
      scenario: {
        contract: { num: cap.contract.num, suit: cap.contract.suit, solo: !!cap.contract.solo, revealedCall: !!cap.contract.revealedCall, nap: cap.contract.nap, deputy: cap.contract.deputy },
        seat: cap.seat, hand: cap.hand, trick: cap.trick, trickNo: cap.trickNo,
        playedCards: cap.playedCards, voids: cap.voids,
        call: cap.contract.call ? { suit: cap.contract.call.suit, rank: cap.contract.call.rank, id: cap.contract.call.id } : null,
        discarded: cap.discarded
      },
      options, aiAnswerIndex: correctIdx >= 0 ? correctIdx : 0,
      explanation: `AIは ${aiChoice.id} を選択。`
    };
  }
  return null;
}

// ============ public API ============
const _cache = new Map();
export function getQuestion(id) {
  if (_cache.has(id)) return _cache.get(id);
  const parsed = parseQuestionId(id);
  if (!parsed) return null;
  const seed = hashStr(id);
  const rng = mulberry32(seed);
  let q = null;
  if (parsed.category === 'bid') q = genBidQuestion(rng, parsed.index);
  else if (parsed.category === 'call') q = genCallQuestion(rng, parsed.index);
  else if (parsed.category === 'discard') q = genDiscardQuestion(rng, parsed.index);
  else if (parsed.category === 'play') q = genPlayQuestion(rng, parsed.index);
  if (!q) {
    const fallbackRng = mulberry32(seed ^ 0xDEADBEEF);
    q = genBidQuestion(fallbackRng, parsed.index);
    if (q) q.id = id;
  }
  if (q) _cache.set(id, q);
  return q;
}
export function listQuestions({ category = null, offset = 0, limit = 20 } = {}) {
  const cats = category ? [category] : QUIZ_CATEGORIES;
  const out = [];
  for (const c of cats) for (let i = 0; i < QUIZ_COUNTS[c]; i++) out.push({ id: makeQuestionId(c, i), category: c });
  return out.slice(offset, offset + limit);
}
export function allQuestionIds() {
  const out = [];
  for (const c of QUIZ_CATEGORIES) for (let i = 0; i < QUIZ_COUNTS[c]; i++) out.push(makeQuestionId(c, i));
  return out;
}
