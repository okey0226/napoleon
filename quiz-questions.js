// quiz-questions.js — 何切る問題バンク（play特化 / 自己対戦生成版 / v46）
import { SUITS, RANKS, defaultStrategy, sortHand, shuffledDeck } from './constants.js';
import {
  chooseDiscard, chooseDeputyCall, chooseCardToPlay,
  winningEntry, analyzeDiscardOptions, evaluateVoidStrategy,
  colorStrength, ntHandStrength
} from './ai-tactics.js';

export const QUIZ_CATEGORIES = ['play', 'discard'];
export const QUIZ_COUNTS = { play: 40, discard: 10 };
export const QUIZ_LABELS = { play: '何を出す？', discard: '何を捨てる？' };

export function makeQuestionId(category, index) {
  return `${category}-v46-${String(index + 1).padStart(4, '0')}`;
}
export function totalQuestionCount() {
  return QUIZ_CATEGORIES.reduce((n, c) => n + QUIZ_COUNTS[c], 0);
}
export function parseQuestionId(id) {
  if (typeof id !== 'string') return null;
  const m = /^(play|discard)-v46-(\d{1,4})$/.exec(id);
  if (!m) return null;
  const category = m[1], index = Number(m[2]) - 1;
  if (index < 0 || index >= QUIZ_COUNTS[category]) return null;
  return { category, index };
}

// ==========================================
// 決定論的乱数
// ==========================================

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
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}
function buildDeck() {
  const d = [];
  for (const s of SUITS) for (const r of RANKS) d.push({ suit: s, rank: r, id: s + r });
  return d;
}
function cardFromId(id) {
  const safeId = String(id || '♠A');
  return { suit: safeId[0], rank: safeId.slice(1), id: safeId };
}

// ==========================================
// play カテゴリ: 自己対戦シミュレーション
// ==========================================

function simulateOneMatch(localRng, startSeat) {
  const deck = shuffleWithRng(buildDeck(), localRng);
  const hands = [];
  for (let i = 0; i < 5; i++) { hands.push(deck.splice(0, 10)); sortHand(hands[i]); }
  const kitty = deck.splice(0, 2);
  const params = defaultStrategy();
  const nap = Math.floor(localRng() * 5);
  const suit = SUITS.concat(['NT'])[Math.floor(localRng() * 5)];
  const num = 13 + Math.floor(localRng() * 4);
  hands[nap].push(...kitty); sortHand(hands[nap]);

  const discarded = chooseDiscard(hands[nap], suit, { num, params });
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

  const trickHistory = [];
  const mySeat = 0;
  let active = startSeat;
  let trickNo = 0;
  const allSnaps = [];

  const matchBidHistory = [];
  const matchScores = [0, 0, 0, 0, 0];

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
          legalCount: legal.length,
          playedCards: playedCards.slice(),
          voids: JSON.parse(JSON.stringify(voids)),
          seat: mySeat,
          call: { suit: call.suit, rank: call.rank, id: call.id },
          discarded: discarded.filter(c => ["10", "J", "Q", "K", "A"].includes(c.rank)).map(c => c.id),
          points: seatPoints.slice(),
          taken: seatTaken.map(arr => arr.slice()),
          trickHistory: JSON.parse(JSON.stringify(trickHistory))
        });
      }

      const ctx = {
        hand, legal, trick, trickNo, contract, playedCards, voids, seat, deputy,
        discardedKitty: discarded, isRevealed: contract.revealedCall, params, call,
        points: seatPoints,
        currentNapPoints: seatPoints[nap] + (solo ? 0 : seatPoints[deputy]),
        experience: null,
        bidHistory: matchBidHistory,
        matchScores: matchScores
      };
      const chosen = chooseCardToPlay(ctx) || legal[0];

      if (led && chosen.suit !== led) { if (!voids[seat]) voids[seat] = {}; voids[seat][led] = true; }
      playedCards.push({ id: chosen.id, suit: chosen.suit, rank: chosen.rank, seat });
      if (chosen.id === call.id) contract.revealedCall = true;
      trick.push({ seat, card: chosen });
      hands[seat] = hand.filter(c => c.id !== chosen.id);
    }

    const w = winningEntry(contract, trickNo, trick);
    const taken = trick.filter(e => ["10", "J", "Q", "K", "A"].includes(e.card.rank)).map(e => e.card);

    trickHistory.push({
      trickNo,
      leadSuit: trick[0].card.suit,
      winner: w.seat,
      points: taken.length
    });

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
  const desiredTurnIndex = idx % 5;

  const buildQuestion = (cap) => {
    const hand = cap.hand.map(cardFromId);
    const trick = (cap.trick || []).map(e => {
      let cid = '';
      if (typeof e.card === 'string') cid = e.card;
      else if (e.card && typeof e.card === 'object') cid = e.card.id;
      else if (e.card) cid = String(e.card);
      return { seat: e.seat, card: cardFromId(cid) };
    });

    const led = trick[0]?.card.suit;
    const legal = !led ? hand : (hand.some(c => c.suit === led) ? hand.filter(c => c.suit === led) : hand);
    if (legal.length < 2) return null;

    const ctx = {
      hand, legal, trick, trickNo: cap.trickNo, contract: cap.contract,
      playedCards: cap.playedCards, voids: cap.voids, seat: cap.seat,
      deputy: cap.contract.deputy, discardedKitty: [], isRevealed: cap.contract.revealedCall,
      params: defaultStrategy(), call: cap.contract.call, currentNapPoints: 0, experience: null,
      bidHistory: [],
      matchScores: [0, 0, 0, 0, 0]
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
        discarded: cap.discarded, points: cap.points, taken: cap.taken,
        trickHistory: cap.trickHistory || []
      },
      options, aiAnswerIndex: correctIdx,
      explanation: `AIは ${aiChoice.id} を選択。`
    };
  };

  const targetStartSeat = desiredTurnIndex;

  let valid = [];
  for (let attempt = 0; attempt < 10; attempt++) {
    const localRng = mulberry32(idx * 7919 + attempt * 9973);
    const snaps = simulateOneMatch(localRng, targetStartSeat);
    valid = snaps.filter(s => s.turnIndex === desiredTurnIndex && s.legalCount >= 2 && s.trickNo < 9);
    if (valid.length > 0) break;
  }

  if (valid.length === 0) {
    for (let attempt = 0; attempt < 10; attempt++) {
      const localRng = mulberry32(idx * 7919 + attempt * 9973 + 999);
      const snaps = simulateOneMatch(localRng, targetStartSeat);
      valid = snaps.filter(s => s.legalCount >= 2 && s.trickNo < 9);
      if (valid.length > 0) break;
    }
  }

  if (valid.length === 0) return null;

  const pickRng = mulberry32(idx * 9973);
  const cap = valid[Math.floor(pickRng() * valid.length)];
  return buildQuestion(cap);
}

// ==========================================
// discard カテゴリ: 捨て札クイズ生成
// ==========================================

function genDiscardQuestion(rng, idx) {
  const params = defaultStrategy();
  const trumpChoices = ['♣', '♦', '♥', '♠', 'NT'];
  const numChoices = [13, 14, 15, 16, 17, 18, 19, 20];

  const buildQuestion = (hand, trump, num, analysis) => {
    const { options } = analysis;
    if (!options || options.length < 2) return null;

    // 期待値上位2〜3パターンを選択肢に
    const sorted = options.slice().sort((a, b) => b.ev - a.ev);
    const topOptions = [];
    const seenSets = new Set();
    for (const opt of sorted) {
      const key = opt.cards.map(c => c.id).sort().join(',');
      if (seenSets.has(key)) continue;
      seenSets.add(key);
      topOptions.push(opt);
      if (topOptions.length >= 3) break;
    }
    if (topOptions.length < 2) return null;

    // 期待値が拮抗しているかチェック（差が0.5未満）
    const evDiff = Math.abs(topOptions[0].ev - topOptions[1].ev);
    if (evDiff > 0.8) return null; // 拮抗していない場合はスキップ

    const quizOptions = topOptions.map((opt, i) => ({
      index: i,
      value: opt.cards.map(c => c.id).sort().join(','),
      label: opt.cards.map(c => c.id).join(' ')
    }));

    // 正解 = 期待値最大の選択肢
    const correctIdx = 0;

    // シナリオに「ボイド作成 vs 全スート維持」の情報を含める
    const handIds = hand.map(c => c.id);
    const suitCounts = {};
    for (const s of SUITS) suitCounts[s] = hand.filter(c => c.suit === s).length;

    return {
      id: makeQuestionId('discard', idx),
      category: 'discard',
      title: `宣言${num}${trump}：12枚から2枚を捨てる（${idx % 2 === 0 ? 'ボイド作成 vs 全スート維持' : '期待値拮抗'}）`,
      scenario: {
        contract: {
          num,
          suit: trump,
          nap: 0,
          solo: false,
          deputy: -1,
          revealedCall: false
        },
        seat: 0,
        hand: handIds,
        trick: [],
        trickNo: 0,
        playedCards: [],
        voids: [{},{},{},{},{}],
        call: null,
        discarded: [],
        points: [0,0,0,0,0],
        taken: [[],[],[],[],[]],
        trickHistory: [],
        // 捨て札クイズ専用のメタ情報
        discardMeta: {
          options: topOptions.map(opt => ({
            type: opt.type,
            cards: opt.cards.map(c => c.id),
            ev: opt.ev,
            analysis: opt.analysis
          })),
          evDiff,
          suitCounts
        }
      },
      options: quizOptions,
      aiAnswerIndex: correctIdx,
      explanation: generateDiscardExplanation(topOptions, num, trump)
    };
  };

  // ランダムな手札を生成し、期待値が拮抗するシチュエーションを探す
  for (let attempt = 0; attempt < 50; attempt++) {
    const localRng = mulberry32(idx * 7919 + attempt * 9973 + 13);
    const deck = shuffleWithRng(buildDeck(), localRng);
    const hand = deck.splice(0, 12); // 12枚（オープン2枚を含む想定）
    sortHand(hand);

    const trump = trumpChoices[Math.floor(localRng() * trumpChoices.length)];
    const num = numChoices[Math.floor(localRng() * numChoices.length)];

    const context = {
      num,
      hasMighty: hand.some(c => c.id === '♠A'),
      deputyHasMighty: true,
      protectedCallId: null,
      params
    };

    const analysis = analyzeDiscardOptions(hand, trump, context, params);
    if (!analysis || !analysis.options || analysis.options.length < 2) continue;

    // 期待値が拮抗しているかチェック
    const sorted = analysis.options.slice().sort((a, b) => b.ev - a.ev);
    const evDiff = Math.abs(sorted[0].ev - sorted[1].ev);
    if (evDiff > 0.8) continue;

    // 「ボイド作成 vs 全スート維持」の対立があるか優先
    const hasConflict = sorted[0].type !== sorted[1].type;
    if (!hasConflict && evDiff > 0.4) continue;

    const q = buildQuestion(hand, trump, num, analysis);
    if (q) return q;
  }

  return null;
}

function generateDiscardExplanation(topOptions, num, trump) {
  const lines = [];
  lines.push(`宣言${num}${trump}での捨て札選択。`);
  for (let i = 0; i < Math.min(topOptions.length, 3); i++) {
    const opt = topOptions[i];
    const cardsStr = opt.cards.map(c => c.id).join(' ');
    const typeStr = opt.type === 'void' ? 'ボイド作成' : '全スート維持';
    lines.push(`${i === 0 ? '【最善】' : '【次善】'} ${cardsStr}（${typeStr} / EV ${opt.ev.toFixed(2)}）`);
  }
  lines.push('期待値が拮抗する場合は、切札枚数・宣言枚数・孤立絵札の3変数で判断します。');
  return lines.join('\n');
}

// ==========================================
// 公開 API
// ==========================================

export function getQuestion(id) {
  const parsed = parseQuestionId(id);
  if (!parsed) return null;
  const seed = hashStr(id);
  const rng = mulberry32(seed);
  let q = null;
  if (parsed.category === 'play') q = genPlayQuestion(rng, parsed.index);
  else if (parsed.category === 'discard') q = genDiscardQuestion(rng, parsed.index);
  if (!q) {
    const fallbackRng = mulberry32(seed ^ 0xDEADBEEF);
    if (parsed.category === 'play') q = genPlayQuestion(fallbackRng, parsed.index);
    else if (parsed.category === 'discard') q = genDiscardQuestion(fallbackRng, parsed.index);
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
