// quiz-questions.js — 何切る問題バンク（play特化 / 50問版 / v29）
import { SUITS, RANKS, defaultStrategy, sortHand } from './constants.js';
import {
  chooseDiscard, chooseDeputyCall, chooseCardToPlay,
  winningEntry
} from './ai-tactics.js';

export const QUIZ_CATEGORIES = ['play'];
export const QUIZ_COUNTS = { play: 50 };
export const QUIZ_LABELS = { play: '何を出す？' };

export function makeQuestionId(category, index) {
  return `${category}-v29-${String(index + 1).padStart(4, '0')}`;
}
export function totalQuestionCount() {
  return QUIZ_CATEGORIES.reduce((n, c) => n + QUIZ_COUNTS[c], 0);
}
export function parseQuestionId(id) {
  if (typeof id !== 'string') return null;
  const m = /^(play)-v29-(\d{1,4})$/.exec(id);
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

// 1局を最後までシミュレート
function simulateOneMatch(localRng) {
  const deck = shuffleWithRng(buildDeck(), localRng);
  const hands = [];
  for (let i = 0; i < 5; i++) { hands.push(deck.splice(0, 10)); sortHand(hands[i]); }
  const kitty = deck.splice(0, 2);
  const params = defaultStrategy();
  const nap = Math.floor(localRng() * 5);
  const suit = SUITS.concat(['NT'])[Math.floor(localRng() * 5)];
  const num = 13 + Math.floor(localRng() * 4);
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
          // トリックのカードは文字列のIDにする
          trick: trick.map(e => ({ seat: e.seat, card: e.card.id })),
          trickNo,
          turnIndex: trick.length,
          legalCount: legal.length,
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
    
    const napPts = seatPoints[nap] + (solo ? 0 : seatPoints[deputy]);
    const allyPtsRaw = seatPoints.reduce((n, p, i) => n + (i !== nap && (solo || i !== deputy) ? p : 0), 0);
    const allyPts = allyPtsRaw + kittyPoints;
    
    if (napPts >= num && (num === 20 || allyPts >= 1)) break;
    if (allyPts > 20 - num) break;
    
    active = w.seat; 
    trickNo++;
  }
  return allSnaps;
}

function genPlayQuestion(rng, idx) {
  const params = defaultStrategy();
  const desiredTurnIndex = idx % 5;

  const buildQuestion = (cap) => {
    const hand = cap.hand.map(id => ({ suit: id[0], rank: id.slice(1), id }));
    const trick = cap.trick.map(e => ({ seat: e.seat, card: e.card })); // e.card は文字列ID
    const led = trick[0]?.card[0];
    const legal = !led ? hand : (hand.some(c => c.suit === led) ? hand.filter(c => c.suit === led) : hand);
    if (legal.length < 2) return null;

    const ctx = {
      hand, legal, trick: trick.map(e => ({ seat: e.seat, card: { suit: e.card[0], rank: e.card.slice(1), id: e.card } })), 
      trickNo: cap.trickNo, contract: cap.contract,
      playedCards: cap.playedCards, voids: cap.voids, seat: cap.seat,
      deputy: cap.contract.deputy, discardedKitty: [], isRevealed: cap.contract.revealedCall,
      params, call: cap.contract.call, currentNapPoints: 0, experience: null
    };
    const aiChoice = chooseCardToPlay(ctx);
    if (!aiChoice) return null;

    const options = legal.map((c, i) => ({ index: i, label: c.id, value: c.id }));
    const correctIdx = legal.findIndex(c => c.id === aiChoice.id);
    if (correctIdx < 0) return null;

    let roleLabel = '連合軍';
    if (cap.seat === cap.contract.nap) roleLabel = 'ナポレオン';
    else if (cap.seat === cap.contract.deputy && cap.contract.revealedCall) roleLabel = '副官';
    else if (hand.some(c => c.id === cap.contract.call.id)) roleLabel = '副官（未公開）';

    return {
      id: makeQuestionId('play', idx), category: 'play',
      title: `第${cap.trickNo + 1}トリック・${cap.turnIndex + 1}番目：何を出す？（${roleLabel}）`,
      scenario: {
        contract: {
          num: cap.contract.num, suit: cap.contract.suit,
          solo: !!cap.contract.solo, revealedCall: !!cap.contract.revealedCall,
          nap: cap.contract.nap, deputy: cap.contract.deputy
        },
        seat: cap.seat, hand: cap.hand, trick: trick, trickNo: cap.trickNo,
        playedCards: cap.playedCards, voids: cap.voids,
        call: cap.contract.call ? { suit: cap.contract.call.suit, rank: cap.contract.call.rank, id: cap.contract.call.id } : null,
        discarded: cap.discarded, points: cap.points, taken: cap.taken
      },
      options, aiAnswerIndex: correctIdx,
      explanation: `AIは ${aiChoice.id} を選択。`
    };
  };

  const pool = [];
  for (let attempt = 0; attempt < 200; attempt++) {
    const localRng = mulberry32(idx * 7919 + attempt * 9973);
    pool.push(...simulateOneMatch(localRng));
  }

  let valid = pool.filter(s => s.turnIndex === desiredTurnIndex && s.legalCount >= 2 && s.trickNo < 9);
  
  if (valid.length === 0 && desiredTurnIndex > 0) {
    valid = pool.filter(s => s.turnIndex > 0 && s.legalCount >= 2 && s.trickNo < 9);
  }
  if (valid.length === 0) {
    valid = pool.filter(s => s.legalCount >= 2 && s.trickNo < 9);
  }
  if (valid.length === 0) return null;

  const pickRng = mulberry32(idx * 9973);
  const cap = valid[Math.floor(pickRng() * valid.length)];
  return buildQuestion(cap);
}

export function getQuestion(id) {
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
