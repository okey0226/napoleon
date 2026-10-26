// quiz-questions.js — 何切る問題バンク（play特化 / 50問版）
import { SUITS, RANKS, defaultStrategy, sortHand } from './constants.js';
import {
  chooseDiscard, chooseDeputyCall, chooseCardToPlay,
  winningEntry
} from './ai-tactics.js';

export const QUIZ_CATEGORIES = ['play'];
export const QUIZ_COUNTS = { play: 50 };
export const QUIZ_LABELS = { play: '何を出す？' };

export function totalQuestionCount() {
  return QUIZ_CATEGORIES.reduce((n, c) => n + QUIZ_COUNTS[c], 0);
}
export function makeQuestionId(category, index) {
  return `${category}-${String(index + 1).padStart(4, '0')}`;
}
export function parseQuestionId(id) {
  if (typeof id !== 'string') return null;
  const m = /^(play)-(\d{1,4})$/.exec(id);
  if (!m) return null;
  const category = m[1], index = Number(m[2]) - 1;
  if (index < 0 || index >= QUIZ_COUNTS[category]) return null;
  return { category, index };
}

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
  const seatPoints = [0, 0, 0, 0, 0];
  const seatTaken = [[], [], [], [], []];
  
  const kittyPoints = discarded.filter(c => ["10", "J", "Q", "K", "A"].includes(c.rank)).length;
  
  const mySeat = 0;
  let active = nap;
  let trickNo = 0;
  const allSnaps = [];

  while (trickNo < 10 && hands.some(h => h.length > 0)) {
    const trick = [];
    for (let i = 0; i < 5; i++) {
      const seat = (active + i) % 5;
      const hand = hands[seat];
      const led = trick.length ? trick[0].card.suit : null;
      const legal = !led ? hand : (hand.some(c => c.suit === led) ? hand.filter(c => c.suit === led) : hand);
      
      if (seat === mySeat) {
        allSnaps.push({
          contract: JSON.parse(JSON.stringify(contract)),
          hand: hand.map(c => c.id),
          trick: trick.map(e => ({ seat: e.seat, card: e.card.id })),
          trickNo,
          turnIndex: trick.length,
          playedCards: playedCards.slice(),
          voids: JSON.parse(JSON.stringify(voids)),
          seat: mySeat, 
          call: { suit: call.suit, rank: call.rank, id: call.id },
          discarded: discarded.filter(c => ["10", "J", "Q", "K", "A"].includes(c.rank)).map(c => c.id),
          points: seatPoints.slice(),
          taken: seatTaken.map(arr => arr.slice())
        });
      }
      
      const ctx = { hand, legal, trick, trickNo, contract, playedCards, voids, seat, deputy, discardedKitty: discarded, isRevealed: contract.revealedCall, params, call, currentNapPoints: 0, experience: null };
      const chosen = chooseCardToPlay(ctx) || legal[0];
      
      if (led && chosen.suit !== led) { if (!voids[seat]) voids[seat] = {}; voids[seat][led] = true; }
      playedCards.push({ id: chosen.id, suit: chosen.suit, rank: chosen.rank, seat });
      if (chosen.id === call.id) contract.revealedCall = true;
      trick.push({ seat, card: chosen });
      hands[seat] = hand.filter(c => c.id !== chosen.id);
    }
    
    const w = winningEntry(contract, trickNo, trick);
    const taken = trick.filter(e => ["10", "J", "Q", "K", "A"].includes(e.card.rank)).map(e => e.card);
    seatPoints[w.seat] += taken.length;
    seatTaken[w.seat].push(...taken.map(c => c.id));
    
    // 早期終了判定
    const napPts = seatPoints[nap] + (solo ? 0 : seatPoints[deputy]);
    const allyPtsRaw = seatPoints.reduce((n, p, i) => n + (i !== nap && (solo || i !== deputy) ? p : 0), 0);
    const allyPts = allyPtsRaw + kittyPoints;
    
    if (napPts >= num && (num === 20 || allyPts >= 1)) {
      break;
    }
    if (allyPts > 20 - num) {
      break;
    }
    
    active = w.seat; 
    trickNo++;
  }
  return allSnaps;
}

function genPlayQuestion(rng, idx) {
  const params = defaultStrategy();
  
  const desiredTurnIndex = idx % 5;
  const desiredTrick = Math.floor(idx / 5) % 10;
  
  for (let attempt = 0; attempt < 100; attempt++) {
    const allSnaps = simulateOnePlayScenario(rng);
    
    let validSnaps = allSnaps.filter(s => s.turnIndex === desiredTurnIndex && s.trickNo === desiredTrick);
    
    if (!validSnaps.length) {
      validSnaps = allSnaps.filter(s => s.turnIndex === desiredTurnIndex && Math.abs(s.trickNo - desiredTrick) <= 2);
    }
    
    if (!validSnaps.length) {
      validSnaps = allSnaps.filter(s => s.turnIndex === desiredTurnIndex);
    }
    
    if (!validSnaps.length) continue;
    
    const cap = validSnaps[Math.floor(rng() * validSnaps.length)];

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
        discarded: cap.discarded,
        points: cap.points,
        taken: cap.taken
      },
      options, aiAnswerIndex: correctIdx >= 0 ? correctIdx : 0,
      explanation: `AIは ${aiChoice.id} を選択。`
    };
  }
  
  return null;
}

const _cache = new Map();
export function getQuestion(id) {
  if (_cache.has(id)) return _cache.get(id);
  const parsed = parseQuestionId(id);
  if (!parsed) return null;
  const seed = hashStr(id);
  const rng = mulberry32(seed);
  let q = null;
  if (parsed.category === 'play') q = genPlayQuestion(rng, parsed.index);
  if (!q) {
    const fallbackRng = mulberry32(seed ^ 0xDEADBEEF);
    q = genPlayQuestion(fallbackRng, parsed.index);
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
