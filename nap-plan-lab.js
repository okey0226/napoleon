// nap-plan-lab.js — NAP限定 プラン実行＆乖離測定コーナー（統括）
//
// 1セッション1シナリオ。人間が宣言・捨て札・指名・副官期待・切り順を確定し、
// AIがプラン優先モードでプレイ。観戦中にスロット単位でプラン修正可能。
// 終了時に3層乖離（プラン実行 / 結果予測 / 副官期待的中）をレポート。
//
// 依存: constants.js, ai-tactics.js
// 公開: openNapPlanLabScreen()

import {
  SUITS, RANKS, SV, defaultStrategy, shuffledDeck, sortHand,
} from './constants.js';
import {
  computeProperBid, chooseDiscard, chooseDeputyCall, chooseCardToPlay,
  winningEntry, colorStrength, ntHandStrength,
} from './ai-tactics.js';

const $ = id => document.getElementById(id);
const FACE = ['10', 'J', 'Q', 'K', 'A'];
const POINT = FACE;

const STEPS = ['scenario', 'bid', 'discard', 'call', 'expect', 'plan', 'watch', 'report'];

// ============================================================
// セッション状態（1セッション = 1シナリオ）
// ============================================================
const S = {
  step: 'scenario',
  seed: 0,
  scenario: null,        // { hand10, openKitty2, opponents }
  bid: null,             // { suit, num }
  discard: [],           // card[2]
  call: null,            // card
  solo: false,           // 自分の手札を指名した場合
  expectedCards: [],     // id[]
  initialPlan: null,     // { sequence: [{slot, card, outcome}] }
  currentPlan: null,
  revisions: [],         // PlanRevision[]
  trickRecords: [],      // TrickRecord[]
  currentTrickNo: 0,
  matchState: null,      // シミュレーション中の試合状態
  pauseResolve: null,    // 「次のトリックへ」待ちの resolver
  report: null,
  aborted: false,
};

// ============================================================
// ユーティリティ
// ============================================================
function hashSeed(...args) {
  let h = 2166136261 >>> 0;
  const str = args.join(':');
  for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; }
  return h >>> 0;
}
function mulberry32(seed) {
  let s = seed | 0;
  return () => {
    s = (s + 0x6D2B79F5) | 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function shuffleWithRng(arr, rng) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}
function cardById(id) {
  const s = String(id || '♠A');
  return { suit: s[0], rank: s.slice(1), id: s };
}
function escapeHTML(v) {
  return String(v ?? '').replace(/[&<>"']/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));
}
function cardElHTML(c, extra = '') {
  if (!c) return `<div class="card card-back ${extra}"></div>`;
  const red = c.suit === '♦' || c.suit === '♥';
  return `<div class="card ${red ? 'red ' : ''}${extra}"><span class="rank">${c.rank}</span><span class="suit">${c.suit}</span></div>`;
}
function delay(ms) { return new Promise(r => setTimeout(r, ms)); }

// ============================================================
// シナリオ生成（properBid >= 14 の手札のみ採用）
// ============================================================
function buildDeck() {
  const d = [];
  for (const s of SUITS) for (const r of RANKS) d.push({ suit: s, rank: r, id: s + r });
  return d;
}

function generateScenario(seed) {
  const rng = mulberry32(seed >>> 0);
  const params = defaultStrategy();
  const MAX_ATTEMPTS = 200;

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const deck = shuffleWithRng(buildDeck(), rng);
    const hand10 = deck.splice(0, 10).map(c => ({ ...c }));
    const openKitty = deck.splice(0, 2).map(c => ({ ...c }));
    sortHand(hand10);

    // 14枚以上立てられるスートを探す
    let bestSuit = null, bestProper = 0;
    for (const suit of SUITS.concat(['NT'])) {
      const r = computeProperBid(hand10, suit, params, 0, null, [0,0,0,0,0], openKitty, [], [{},{},{},{},{}], [], 1);
      if (r && r.properBid > bestProper) { bestProper = r.properBid; bestSuit = suit; }
    }
    if (bestProper < 14 || !bestSuit) continue;

    // 追加条件: 切札4枚以上（NTは除く）、サイドA 1枚以上、点札5枚以上
    if (bestSuit !== 'NT') {
      const trumps = hand10.filter(c => c.suit === bestSuit).length;
      if (trumps < 4) continue;
    }
    const sideAces = hand10.filter(c => c.rank === 'A' && c.id !== '♠A' && c.suit !== bestSuit).length;
    if (sideAces < 1) continue;
    const points = hand10.filter(c => POINT.includes(c.rank)).length;
    if (points < 5) continue;

    // 残り40枚を4人に分配（10枚ずつ）。シナリオ固定のためopponentも保存
    const oppHands = [[], [], [], [], []];
    for (let i = 1; i < 5; i++) oppHands[i] = deck.splice(0, 10).map(c => ({ ...c }));

    return {
      seed,
      hand10,
      openKitty,
      opponents: oppHands,
      suggestedSuit: bestSuit,  // 参考表示用（決定には使わない）
      suggestedProper: bestProper,
    };
  }
  return null;
}

// ============================================================
// 切り順プラン生成（AIの初期案）
// 既存の chooseCardToPlay をシミュレーションで走らせて、各トリックで
// 「もし全員が最善を尽くしたら何が出るか」を予測する簡易版
// ============================================================
function generateInitialPlan(scenario, bid, discard, call, solo) {
  const params = defaultStrategy();
  const myHand = scenario.hand10.concat(scenario.openKitty).filter(
    c => !discard.some(d => d.id === c.id)
  );
  const contract = {
    nap: 0, num: bid.num, suit: bid.suit,
    deputy: solo ? 0 : -1, solo, revealedCall: false,
    call: { ...call },
  };

  // 簡易シミュレーション: NAP手札を「強い順に勝ち、弱い順に負ける」素朴な仮定で計画
  // 実装は後で差し替え可能なように関数分離
  return buildNaivePlan(myHand, contract, scenario.opponents, params);
}

function buildNaivePlan(myHand, contract, oppHands, params) {
  // 手札をスート別に整理し、各カードが「勝てる見込み」を推定
  // 勝てそうなカード（A, 正J, 裏J, マイティ）をWIN枠に、
  // それ以外をLOSE枠に振り分ける素朴な方式
  const scored = myHand.map(c => {
    let score = 0;
    if (c.id === '♠A') score = 100;
    else if (c.id === '♥Q') score = 90;
    else if (contract.suit !== 'NT' && c.rank === 'J' && c.suit === contract.suit) score = 85;
    else if (contract.suit !== 'NT' && c.rank === 'J' && (c.suit === '♣' || c.suit === '♠') === (contract.suit === '♣' || contract.suit === '♠')) score = 75;
    else if (c.rank === 'A') score = 70;
    else if (c.rank === 'K') score = 40;
    else if (c.rank === 'Q') score = 35;
    else if (contract.suit !== 'NT' && c.suit === contract.suit) score = 30;
    else if (c.rank === '2') score = 20;
    else score = 10;
    return { card: c, score };
  });
  scored.sort((a, b) => b.score - a.score);

  const sequence = [];
  let seq = 1;
  for (const entry of scored) {
    const isWin = entry.score >= 60;
    sequence.push({ slot: seq, card: entry.card, outcome: isWin ? 'WIN' : 'LOSE' });
    seq++;
  }
  return { sequence };
}

// ============================================================
// 試合状態のセットアップ
// ============================================================
function createMatchState(scenario, bid, discard, call, solo) {
  const hands = [[], [], [], [], []];
  hands[0] = scenario.hand10.concat(scenario.openKitty).filter(
    c => !discard.some(d => d.id === c.id)
  ).map(c => ({ ...c }));
  for (let i = 1; i < 5; i++) {
    hands[i] = scenario.opponents[i].map(c => ({ ...c }));
  }

  const contract = {
    nap: 0, num: bid.num, suit: bid.suit,
    deputy: solo ? 0 : -1, solo, revealedCall: false,
    call: { ...call },
  };

  // 副官の特定
  if (!solo) {
    for (let i = 1; i < 5; i++) {
      if (hands[i].some(c => c.id === call.id)) { contract.deputy = i; break; }
    }
    if (contract.deputy < 0) contract.deputy = 0;
  }

  return {
    hands,
    contract,
    trick: [],
    trickNo: 0,
    active: 0,
    points: [0, 0, 0, 0, 0],
    taken: [[], [], [], [], []],
    voids: [{}, {}, {}, {}, {}],
    playedCards: [],
    allianceKittyPoints: discard.filter(c => POINT.includes(c.rank)).length,
    finished: false,
  };
}

function legalCards(state, seat) {
  const h = state.hands[seat];
  if (!state.trick.length) return h;
  const led = state.trick[0].card.suit;
  const follow = h.filter(c => c.suit === led);
  return follow.length ? follow : h;
}

function playCardToState(state, seat, card) {
  const hand = state.hands[seat];
  hand.splice(hand.findIndex(c => c.id === card.id), 1);
  if (state.trick.length > 0) {
    const led = state.trick[0].card.suit;
    if (card.suit !== led) state.voids[seat][led] = true;
  }
  if (card.id === state.contract.call?.id) state.contract.revealedCall = true;
  state.trick.push({ seat, card });
  state.playedCards.push({ suit: card.suit, rank: card.rank, id: card.id, seat });
}

function resolveTrickIfFull(state) {
  if (state.trick.length < 5) return false;
  const winner = winningEntry(state.contract, state.trickNo, state.trick);
  const taken = state.trick.filter(e => POINT.includes(e.card.rank)).map(e => e.card);
  state.points[winner.seat] += taken.length;
  state.taken[winner.seat].push(...taken);
  state.active = winner.seat;
  state.trick = [];
  state.trickNo++;
  if (state.trickNo >= 10) state.finished = true;
  return true;
}

// ============================================================
// プラン優先プレイ — NAPの手番のみインターセプト
// ============================================================
function buildPlayCtx(state, seat) {
  const deputyPts = !state.contract.solo && state.contract.deputy >= 0
    ? (state.points[state.contract.deputy] || 0) : 0;
  return {
    hand: state.hands[seat],
    legal: legalCards(state, seat),
    trick: state.trick.map(t => ({ seat: t.seat, card: t.card })),
    trickNo: state.trickNo,
    contract: state.contract,
    playedCards: state.playedCards,
    voids: state.voids,
    seat,
    deputy: state.contract.deputy,
    params: defaultStrategy(),
    call: state.contract.call,
    discardedKitty: [],
    isMySideNap: seat === state.contract.nap || (!state.contract.solo && seat === state.contract.deputy),
    isCurrentNapWinning: false,
    isRevealed: state.contract.revealedCall,
    isNapLeading: state.trick.length > 0 && state.trick[0].seat === state.contract.nap,
    lastSeat: state.trick.length === 4,
    currentNapPoints: (state.points[state.contract.nap] || 0) + deputyPts,
    points: state.points,
    allianceKittyPoints: state.allianceKittyPoints,
    players: state.hands.map(h => ({ handCount: h.length })),
  };
}

function detectForcedLoss(state, card) {
  // プランはWINなのに、このカードで勝てない → 即敗北確定の簡易判定
  const testTrick = [...state.trick, { seat: 0, card }];
  const winner = winningEntry(state.contract, state.trickNo, testTrick);
  if (winner && winner.seat !== 0) {
    // このトリックを落とすと残りで必要点に届かないか
    const napPts = state.points[0] + (state.contract.solo ? 0 : (state.points[state.contract.deputy] || 0));
    const remaining = 10 - state.trickNo - 1;
    const maxFuture = remaining * 5;
    if (napPts + maxFuture < state.contract.num) return true;
  }
  return false;
}

function closestCardToPlan(planSlot, legal) {
  if (!planSlot || !legal.length) return legal[0];
  const target = planSlot.card;
  // 1. 同スート
  const sameSuit = legal.filter(c => c.suit === target.suit);
  if (sameSuit.length) {
    // アクション種別に合う最弱/最強
    if (planSlot.outcome === 'LOSE') {
      return sameSuit.reduce((b, c) => RANKS.indexOf(c.rank) < RANKS.indexOf(b.rank) ? c : b);
    }
    return sameSuit.reduce((b, c) => RANKS.indexOf(c.rank) > RANKS.indexOf(b.rank) ? c : b);
  }
  // 2. 同ランク
  const sameRank = legal.filter(c => c.rank === target.rank);
  if (sameRank.length) return sameRank[0];
  // 3. フォールバック: LOSEなら最弱、WINなら最強
  if (planSlot.outcome === 'LOSE') {
    return legal.reduce((b, c) => RANKS.indexOf(c.rank) < RANKS.indexOf(b.rank) ? c : b);
  }
  return legal.reduce((b, c) => RANKS.indexOf(c.rank) > RANKS.indexOf(b.rank) ? c : b);
}

function chooseNapCardWithPlanPriority(state) {
  const plan = S.currentPlan;
  const slot = plan?.sequence?.[state.trickNo];
  const legal = legalCards(state, 0);

  if (!slot) {
    // プランにスロットがない（異常） → ヒューリスティック
    return chooseCardToPlay(buildPlayCtx(state, 0));
  }

  const planCard = slot.card;
  const legalPlan = legal.find(c => c.id === planCard.id);
  if (legalPlan && !detectForcedLoss(state, legalPlan)) {
    return legalPlan;  // プラン通り
  }
  // プランカードが使えない or 即敗北 → 最も近いカード
  return closestCardToPlan(slot, legal);
}

function chooseComCard(state, seat) {
  return chooseCardToPlay(buildPlayCtx(state, seat));
}

// ============================================================
// 観戦実行ループ
// ============================================================
async function runWatchSimulation() {
  const state = S.matchState;
  S.currentTrickNo = 0;

  while (!state.finished && !S.aborted) {
    const trickNo = state.trickNo;
    const trickStartPoints = state.points.slice();

    // 1トリック分を実行
    while (state.trick.length < 5 && !state.finished) {
      const seat = state.trick.length === 0
        ? state.active
        : (state.trick[state.trick.length - 1].seat + 1) % 5;
      // NAPの手番（seat === 0）だけプラン優先
      const chosen = seat === 0
        ? chooseNapCardWithPlanPriority(state)
        : chooseComCard(state, seat);
      playCardToState(state, seat, chosen);
      await delay(250);
    }

    // トリック解決
    const trickSnapshot = state.trick.slice();
    const winnerEntry = winningEntry(state.contract, state.trickNo, state.trick);
    const winner = winnerEntry.seat;
    const taken = state.trick.filter(e => POINT.includes(e.card.rank)).map(e => e.card);
    state.points[winner.seat] += taken.length;
    state.taken[winner.seat].push(...taken);
    state.active = winner;
    state.trick = [];
    state.trickNo++;
    if (state.trickNo >= 10) state.finished = true;

    // TrickRecord
    const napCard = trickSnapshot.find(t => t.seat === 0)?.card;
    const slot = S.currentPlan?.sequence?.[trickNo];
    const plannedCard = slot?.card;
    const plannedOutcome = slot?.outcome;
    const actualOutcome = winner === 0 ? 'WIN' : 'LOSE';
    let deviation = null;
    if (plannedCard && napCard) {
      if (plannedCard.id !== napCard.id) {
        deviation = {
          type: 'CARD_CHANGED',
          plannedCard: plannedCard.id,
          actualCard: napCard.id,
          reason: legalCards(state, 0).some(c => c.id === plannedCard.id)
            ? 'forced_loss_avoided' : 'plan_card_illegal',
        };
      } else if (plannedOutcome !== actualOutcome) {
        deviation = {
          type: 'OUTCOME_MISMATCH',
          plannedOutcome,
          actualOutcome,
          reason: 'opponent_unexpected',
        };
      }
    }
    S.trickRecords.push({
      seq: trickNo + 1,
      plannedCard: plannedCard?.id || null,
      plannedOutcome: plannedOutcome || null,
      actualCard: napCard?.id || null,
      actualOutcome,
      trickWinner: winner,
      takenPoints: taken.length,
      pointsAfter: state.points.slice(),
      deviation,
    });

    S.currentTrickNo = state.trickNo;
    renderWatchStep();

    // ここで一時停止（ユーザーがプラン修正できる）
    if (!state.finished) {
      await new Promise(resolve => { S.pauseResolve = resolve; });
    }
  }

  S.step = 'report';
  computeReport();
  renderStep();
}

function resumeFromPause() {
  if (S.pauseResolve) {
    const r = S.pauseResolve;
    S.pauseResolve = null;
    r();
  }
}

// ============================================================
// プラン修正
// ============================================================
function openRevisionMode() {
  // 修正モードに入る。現在のトリック以降のスロットを「通り／修正」トグル可能に
  S.revisionDraft = {
    slots: S.currentPlan.sequence.map((s, i) => ({
      slot: i + 1,
      original: { card: s.card, outcome: s.outcome },
      current: { card: s.card, outcome: s.outcome },
      decision: i < S.currentTrickNo ? 'EXECUTED' : 'KEEP',
    })),
  };
  renderRevisionModal();
}

function applyRevision() {
  const draft = S.revisionDraft;
  const revisedSlots = draft.slots.filter(s => s.decision === 'REVISED');
  if (!revisedSlots.length) {
    S.revisionDraft = null;
    closeModal();
    return;
  }
  // 修正理由入力へ
  showRevisionReasonModal(revisedSlots);
}

function finalizeRevision(trigger, reason) {
  const draft = S.revisionDraft;
  const revisedSlots = draft.slots.filter(s => s.decision === 'REVISED');
  const newSequence = draft.slots.map((s, i) => ({
    slot: i + 1,
    card: s.current.card,
    outcome: s.current.outcome,
  }));

  // PlanRevisionレコード
  const revision = {
    atTrickNo: S.currentTrickNo,
    originalPlan: S.currentPlan.sequence.map(s => ({ slot: s.slot, card: s.card, outcome: s.outcome })),
    revisedPlan: newSequence.map(s => ({ slot: s.slot, card: s.card, outcome: s.outcome })),
    slotRevisions: revisedSlots.map(s => ({
      slot: s.slot,
      decision: 'REVISED',
      from: s.original,
      to: s.current,
    })),
    trigger,
    reason,
  };
  S.revisions.push(revision);
  S.currentPlan = { sequence: newSequence };
  S.revisionDraft = null;
  closeModal();
  resumeFromPause();
}

// ============================================================
// 乖離レポート
// ============================================================
function computeReport() {
  const records = S.trickRecords;
  // プラン実行乖離
  const matches = records.filter(r => !r.deviation).length;
  const deviations = records.filter(r => r.deviation);
  // 結果予測精度
  const winPreds = records.filter(r => r.plannedOutcome === 'WIN');
  const losePreds = records.filter(r => r.plannedOutcome === 'LOSE');
  const winHits = winPreds.filter(r => r.actualOutcome === 'WIN').length;
  const loseHits = losePreds.filter(r => r.actualOutcome === 'LOSE').length;
  // 副官期待的中
  const deputyHand = S.solo ? [] : (S.matchState.hands[S.matchState.contract.deputy] || []);
  const deputyIds = new Set(deputyHand.map(c => c.id));
  const expected = S.expectedCards;
  const hits = expected.filter(id => deputyIds.has(id));
  // 最終スコア
  const finalNapPts = S.matchState.points[0] + (S.solo ? 0 : (S.matchState.points[S.matchState.contract.deputy] || 0));
  const made = finalNapPts >= S.bid.num && (S.bid.num === 20 || finalNapPts < 20);

  return {
    planExecution: {
      matched: matches,
      total: records.length,
      deviations,
    },
    outcomePrediction: {
      winPred: winPreds.length, winHit: winHits,
      losePred: losePreds.length, loseHit: loseHits,
      accuracy: records.length ? (winHits + loseHits) / records.length : 0,
    },
    deputyExpectation: {
      expected,
      actual: [...deputyIds],
      hits,
      hitRate: expected.length ? hits.length / expected.length : null,
    },
    revisions: S.revisions.length,
    result: {
      finalNapPts, bid: S.bid.num, made,
      matchPoints: S.matchState.points.slice(),
    },
  };
}

// ============================================================
// 学習データ保存（非同期・失敗してもコーナーは止めない）
// ============================================================
async function persistSessionRecord(report) {
  const record = {
    scenarioId: `nap-lab-${S.seed}`,
    seed: S.seed,
    scenario: {
      hand: S.scenario.hand10.map(c => c.id),
      openKitty: S.scenario.openKitty.map(c => c.id),
    },
    bid: S.bid,
    discard: S.discard.map(c => c.id),
    call: S.call.id,
    solo: S.solo,
    expectedCards: S.expectedCards,
    initialPlan: S.initialPlan.sequence.map(s => ({ slot: s.slot, card: s.card.id, outcome: s.outcome })),
    finalPlan: S.currentPlan.sequence.map(s => ({ slot: s.slot, card: s.card.id, outcome: s.outcome })),
    revisions: S.revisions,
    trickRecords: S.trickRecords,
    report,
    createdAt: new Date().toISOString(),
  };
  try {
    const token = localStorage.getItem('napoleon_session');
    await fetch('/api/nap-lab/save', {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(token ? { 'x-session-token': token } : {}) },
      body: JSON.stringify(record),
    });
  } catch (e) {
    console.warn('[nap-plan-lab] save failed:', e);
    // ローカル保存にフォールバック
    try {
      const key = 'nap_lab_unsaved';
      const arr = JSON.parse(localStorage.getItem(key) || '[]');
      arr.push(record);
      localStorage.setItem(key, JSON.stringify(arr.slice(-20)));
    } catch {}
  }
}

// ============================================================
// 画面遷移
// ============================================================
function resetSession() {
  S.step = 'scenario';
  S.seed = 0;
  S.scenario = null;
  S.bid = null;
  S.discard = [];
  S.call = null;
  S.solo = false;
  S.expectedCards = [];
  S.initialPlan = null;
  S.currentPlan = null;
  S.revisions = [];
  S.trickRecords = [];
  S.currentTrickNo = 0;
  S.matchState = null;
  S.pauseResolve = null;
  S.report = null;
  S.aborted = false;
  S.revisionDraft = null;
}

function startNewScenario() {
  resetSession();
  S.seed = Date.now() & 0x7fffffff;
  const sc = generateScenario(S.seed);
  if (!sc) {
    renderError('シナリオ生成に失敗しました（条件を満たす手札が見つかりませんでした）');
    return;
  }
  S.scenario = sc;
  S.step = 'scenario';
  renderStep();
}

function goNext() {
  const idx = STEPS.indexOf(S.step);
  if (idx < 0 || idx >= STEPS.length - 1) return;
  // バリデーション
  if (S.step === 'bid' && !S.bid) return toast('宣言を選んでください');
  if (S.step === 'discard' && S.discard.length !== 2) return toast('捨て札を2枚選んでください');
  if (S.step === 'call' && !S.call) return toast('指名カードを選んでください');
  if (S.step === 'plan' && S.initialPlan?.sequence?.some(s => !s.card)) {
    return toast('全10枚を配置してください');
  }
  S.step = STEPS[idx + 1];
  if (S.step === 'watch') startWatch();
  else renderStep();
}

function goBack() {
  const idx = STEPS.indexOf(S.step);
  if (idx <= 0) return;
  S.step = STEPS[idx - 1];
  renderStep();
}

// ============================================================
// レンダリング（各ステップ）
// ============================================================
function renderStep() {
  const shell = $('nap-plan-lab-shell');
  if (!shell) return;
  switch (S.step) {
    case 'scenario': renderScenarioStep(shell); break;
    case 'bid': renderBidStep(shell); break;
    case 'discard': renderDiscardStep(shell); break;
    case 'call': renderCallStep(shell); break;
    case 'expect': renderExpectStep(shell); break;
    case 'plan': renderPlanStep(shell); break;
    case 'watch': renderWatchStep(); break;
    case 'report': renderReportStep(shell); break;
  }
}

function stepHeader(title) {
  return `
    <div class="game-head">
      <button class="back-button" id="lab-back">← 戻る</button>
      <div class="game-meta"><span>${escapeHTML(title)}</span></div>
      <button class="primary-button" id="lab-next">次へ →</button>
    </div>`;
}

function bindHeader(shell) {
  shell.querySelector('#lab-back')?.addEventListener('click', goBack);
  shell.querySelector('#lab-next')?.addEventListener('click', goNext);
}

function renderScenarioStep(shell) {
  const sc = S.scenario;
  const hand = sc.hand10.map(c => cardElHTML(c)).join('');
  const kitty = sc.openKitty.map(c => cardElHTML(c)).join('');
  shell.innerHTML = `
    <div class="game-screen nap-lab">
      ${stepHeader('シナリオ')}
      <div class="panel-title">手札10枚</div>
      <div class="hand">${hand}</div>
      <div class="panel-title" style="margin-top:12px;">オープン（浮き札）</div>
      <div class="hand">${kitty}</div>
      <p class="subcopy" style="margin-top:20px;">この手札でNAPを務めます。宣言から切り順まで、すべてあなたが決めます。</p>
    </div>`;
  bindHeader(shell);
}

function renderBidStep(shell) {
  const sc = S.scenario;
  const hand = sc.hand10.concat(sc.openKitty).map(c => cardElHTML(c)).join('');
  const suits = SUITS.concat(['NT']);
  const num = S.bid?.num ?? 13;
  const suit = S.bid?.suit ?? '♠';
  shell.innerHTML = `
    <div class="game-screen nap-lab">
      ${stepHeader('宣言を選ぶ')}
      <div class="panel-title">スート</div>
      <div class="panel-row">${suits.map(s => `<button class="suit-choice ${s === suit ? 'selected' : ''}" data-bid-suit="${s}">${s}</button>`).join('')}</div>
      <div class="panel-title" style="margin-top:16px;">枚数</div>
      <div class="panel-row">
        <button class="small-action" id="bid-minus">−</button>
        <span class="bid-number" id="bid-num">${num}</span>
        <button class="small-action" id="bid-plus">＋</button>
      </div>
      <div class="panel-title" style="margin-top:16px;">手札（参考）</div>
      <div class="hand">${hand}</div>
    </div>`;
  shell.querySelectorAll('[data-bid-suit]').forEach(b => b.onclick = () => {
    S.bid = { suit: b.dataset.bidSuit, num: S.bid?.num ?? 13 };
    renderBidStep(shell);
  });
  shell.querySelector('#bid-minus').onclick = () => {
    S.bid = { suit: S.bid?.suit ?? '♠', num: Math.max(13, (S.bid?.num ?? 13) - 1) };
    renderBidStep(shell);
  };
  shell.querySelector('#bid-plus').onclick = () => {
    S.bid = { suit: S.bid?.suit ?? '♠', num: Math.min(20, (S.bid?.num ?? 13) + 1) };
    renderBidStep(shell);
  };
  bindHeader(shell);
}

function renderDiscardStep(shell) {
  const hand12 = S.scenario.hand10.concat(S.scenario.openKitty);
  const selectedIds = new Set(S.discard.map(c => c.id));
  const handHTML = hand12.map(c => cardElHTML(c, selectedIds.has(c.id) ? 'selected playable' : 'playable')).join('');
  shell.innerHTML = `
    <div class="game-screen nap-lab">
      ${stepHeader('捨て札を2枚選ぶ')}
      <p class="subcopy">手札12枚から2枚を捨てます（${S.discard.length}/2）</p>
      <div class="hand">${handHTML}</div>
      <p class="micro-copy" style="margin-top:12px;color:#e6be72;">点札を捨てると連合軍に点が入ります</p>
    </div>`;
  shell.querySelectorAll('.hand .card.playable').forEach((el, i) => {
    el.onclick = () => {
      const card = hand12[i];
      if (selectedIds.has(card.id)) {
        S.discard = S.discard.filter(c => c.id !== card.id);
      } else if (S.discard.length < 2) {
        S.discard.push(card);
      }
      renderDiscardStep(shell);
    };
  });
  bindHeader(shell);
}

function renderCallStep(shell) {
  const hand10 = S.scenario.hand10.concat(S.scenario.openKitty).filter(
    c => !S.discard.some(d => d.id === c.id)
  );
  const selectedId = S.call?.id;
  const handHTML = hand10.map(c => cardElHTML(c, c.id === selectedId ? 'selected playable' : 'playable')).join('');
  const discardHTML = S.discard.map(c => cardElHTML(c, 'protected')).join('');
  shell.innerHTML = `
    <div class="game-screen nap-lab">
      ${stepHeader('指名カードを選ぶ')}
      <div class="hand">${handHTML}</div>
      <div class="panel-title" style="margin-top:16px;">捨て札（指名不可）</div>
      <div class="hand" style="opacity:.5;">${discardHTML}</div>
      <p class="micro-copy" style="margin-top:8px;">自分の手札を選ぶと「ひとり立ち」になります</p>
    </div>`;
  shell.querySelectorAll('.hand .card.playable').forEach((el, i) => {
    el.onclick = () => {
      const card = hand10[i];
      const isOwn = true;  // 候補はすべて自分の手札
      S.call = card;
      S.solo = isOwn;
      if (isOwn) {
        if (!confirm('自分の手札を指名すると「ひとり立ち」になります。よろしいですか？')) {
          S.call = null; S.solo = false;
          renderCallStep(shell);
          return;
        }
      }
      renderCallStep(shell);
    };
  });
  bindHeader(shell);
}

function renderExpectStep(shell) {
  const allIds = new Set();
  S.scenario.hand10.forEach(c => allIds.add(c.id));
  S.scenario.openKitty.forEach(c => allIds.add(c.id));
  const excluded = new Set(allIds);
  S.discard.forEach(c => excluded.add(c.id));
  if (S.call) excluded.add(S.call.id);

  const expectedSet = new Set(S.expectedCards);
  const blocks = SUITS.map(suit => {
    const ranks = RANKS.slice().reverse();
    const buttons = ranks.map(r => {
      const id = suit + r;
      if (excluded.has(id)) return '';
      const sel = expectedSet.has(id);
      return `<button class="small-action ${sel ? 'selected' : ''}" data-expect="${id}">${r}</button>`;
    }).join('');
    return `<div class="expect-suit-block"><div class="panel-title">${suit}</div><div class="panel-row">${buttons}</div></div>`;
  }).join('');

  shell.innerHTML = `
    <div class="game-screen nap-lab">
      ${stepHeader('副官に期待するカード')}
      <p class="subcopy">複数選択可・0枚でもOK（選択中: ${S.expectedCards.length}枚）</p>
      <div style="position:sticky;top:0;z-index:5;background:rgba(7,23,19,.95);padding:8px 0;margin-bottom:8px;">
        <button class="secondary-button" id="expect-clear">選択をクリア</button>
      </div>
      ${blocks}
    </div>`;
  shell.querySelectorAll('[data-expect]').forEach(b => b.onclick = () => {
    const id = b.dataset.expect;
    if (expectedSet.has(id)) S.expectedCards = S.expectedCards.filter(x => x !== id);
    else S.expectedCards.push(id);
    renderExpectStep(shell);
  });
  shell.querySelector('#expect-clear').onclick = () => { S.expectedCards = []; renderExpectStep(shell); };
  bindHeader(shell);
}

function renderPlanStep(shell) {
  if (!S.initialPlan) {
    S.initialPlan = generateInitialPlan(S.scenario, S.bid, S.discard, S.call, S.solo);
    S.currentPlan = { sequence: S.initialPlan.sequence.map(s => ({ ...s })) };
  }
  const plan = S.currentPlan;
  const usedIds = new Set(plan.sequence.map(s => s.card?.id).filter(Boolean));
  const allMyCards = S.scenario.hand10.concat(S.scenario.openKitty).filter(
    c => !S.discard.some(d => d.id === c.id)
  );
  const unplaced = allMyCards.filter(c => !usedIds.has(c.id));
  const winCount = plan.sequence.filter(s => s.outcome === 'WIN').length;
  const loseCount = plan.sequence.filter(s => s.outcome === 'LOSE').length;

  const slotsHTML = plan.sequence.map((s, i) => `
    <div class="plan-slot ${s.card ? 'filled' : 'empty'}" data-slot="${i}">
      <span class="slot-no">${i + 1}</span>
      <span class="slot-card">${s.card ? cardElHTML(s.card) : '未配置'}</span>
      <button class="small-action" data-toggle="${i}">${s.outcome === 'WIN' ? 'WIN' : 'LOSE'}</button>
    </div>`).join('');

  shell.innerHTML = `
    <div class="game-screen nap-lab">
      ${stepHeader('切り順プラン')}
      <p class="subcopy">予測: ${winCount}勝 / ${loseCount}敗</p>
      <div class="plan-slots">${slotsHTML}</div>
      <div class="panel-title" style="margin-top:16px;">未配置の手札</div>
      <div class="hand">${unplaced.map(c => cardElHTML(c, 'playable')).join('')}</div>
    </div>`;

  // スロットのカード欄タップ → 未配置選択肢を出す簡易実装
  shell.querySelectorAll('.plan-slot').forEach(el => {
    const idx = Number(el.dataset.slot);
    el.querySelector('.slot-card').onclick = () => {
      const current = plan.sequence[idx];
      // 既に配置済み → 外す
      if (current.card) {
        plan.sequence[idx] = { slot: idx + 1, card: null, outcome: current.outcome };
        renderPlanStep(shell);
        return;
      }
      // 未配置 → 選択肢
      if (!unplaced.length) { toast('配置できるカードがありません'); return; }
      const picked = unplaced[0];
      if (picked) { plan.sequence[idx] = { slot: idx + 1, card: picked, outcome: current.outcome }; }
      renderPlanStep(shell);
    };
    el.querySelector('[data-toggle]').onclick = () => {
      const s = plan.sequence[idx];
      s.outcome = s.outcome === 'WIN' ? 'LOSE' : 'WIN';
      renderPlanStep(shell);
    };
  });

  bindHeader(shell);
}

function renderWatchStep() {
  const shell = $('nap-plan-lab-shell');
  if (!shell) return;
  const state = S.matchState;
  if (!state) return;
  const trickNo = Math.min(state.trickNo + (state.trick.length > 0 ? 0 : 0), 9);
  const slot = S.currentPlan?.sequence?.[Math.min(state.trickNo, 9)];
  const lastRecord = S.trickRecords[S.trickRecords.length - 1];
  const recordHTML = lastRecord
    ? `<div class="panel-title">${lastRecord.seq}トリック目</div>
       <p class="subcopy">プラン: ${lastRecord.plannedCard || '—'} ${lastRecord.plannedOutcome || ''}</p>
       <p class="subcopy">実際: ${lastRecord.actualCard} ${lastRecord.actualOutcome}</p>
       ${lastRecord.deviation ? `<p style="color:#e89685;">⚠ 逸脱: ${lastRecord.deviation.reason}</p>` : '<p style="color:#a9d2ae;">✓ プラン通り</p>'}`
    : '';

  const trickCardsHTML = state.trick.map(t => cardElHTML(t.card, 'trick-card')).join('');

  shell.innerHTML = `
    <div class="game-screen nap-lab">
      <div class="game-head">
        <button class="back-button" disabled>観戦中</button>
        <div class="game-meta">トリック ${state.trickNo + (state.trick.length > 0 ? 1 : 0)} / 10</div>
        <button class="primary-button" id="lab-revise">✎ プラン修正</button>
      </div>
      ${recordHTML}
      <div class="table-area">
        <div class="trick-cards">${trickCardsHTML}</div>
      </div>
      <div class="hand">${state.hands[0].map(c => cardElHTML(c)).join('')}</div>
      <div class="panel-row" style="margin-top:12px;">
        <button class="primary-button" id="lab-continue">次のトリックへ</button>
      </div>
    </div>`;

  shell.querySelector('#lab-revise').onclick = () => { openRevisionMode(); };
  shell.querySelector('#lab-continue').onclick = () => { resumeFromPause(); };
}

function renderReportStep(shell) {
  const r = S.report || computeReport();
  const rev = r.revisions;
  const plan = r.planExecution;
  const pred = r.outcomePrediction;
  const dep = r.deputyExpectation;

  shell.innerHTML = `
    <div class="game-screen nap-lab">
      <div class="game-head">
        <button class="back-button" id="lab-finish">終了</button>
        <div class="game-meta">乖離レポート</div>
        <div></div>
      </div>
      <div class="panel">
        <div class="panel-title">プラン実行</div>
        <p class="subcopy">一致: ${plan.matched}/${plan.total}トリック</p>
        ${plan.deviations.length ? `<p class="subcopy">逸脱: ${plan.deviations.map(d => d.seq + '（' + d.deviation.reason + '）').join(', ')}</p>` : ''}
      </div>
      <div class="panel" style="margin-top:12px;">
        <div class="panel-title">結果予測</div>
        <p class="subcopy">WIN的中: ${pred.winHit}/${pred.winPred}</p>
        <p class="subcopy">LOSE的中: ${pred.loseHit}/${pred.losePred}</p>
        <p class="subcopy">精度: ${(pred.accuracy * 100).toFixed(1)}%</p>
      </div>
      <div class="panel" style="margin-top:12px;">
        <div class="panel-title">副官期待の的中</div>
        <p class="subcopy">期待: ${dep.expected.length}枚 / 実際: ${dep.actual.length}枚</p>
        <p class="subcopy">的中: ${dep.hits.length}枚（${dep.hitRate !== null ? (dep.hitRate * 100).toFixed(1) + '%' : '—'}）</p>
      </div>
      <div class="panel" style="margin-top:12px;">
        <div class="panel-title">プラン修正</div>
        <p class="subcopy">修正回数: ${rev}回</p>
        ${S.revisions.map((r, i) => `<p class="micro-copy">#${i + 1} トリック${r.atTrickNo}時点 / ${r.trigger}</p>`).join('')}
      </div>
      <div class="panel" style="margin-top:12px;">
        <div class="panel-title">結果</div>
        <p class="subcopy">宣言 ${r.result.bid} / 獲得 ${r.result.finalNapPts} / ${r.result.made ? 'NAP WIN' : 'ALLY WIN'}</p>
      </div>
      <button class="primary-button" id="lab-save-finish" style="width:100%;margin-top:16px;">保存して終了</button>
    </div>`;

  shell.querySelector('#lab-finish').onclick = () => closeNapPlanLab();
  shell.querySelector('#lab-save-finish').onclick = async () => {
    await persistSessionRecord(r);
    closeNapPlanLab();
  };
}

// ============================================================
// プラン修正モーダル
// ============================================================
function renderRevisionModal() {
  const draft = S.revisionDraft;
  if (!draft) return;
  const html = draft.slots.map(s => {
    const executed = s.decision === 'EXECUTED';
    const revised = s.decision === 'REVISED';
    return `
      <div class="revision-slot ${executed ? 'executed' : ''}">
        <span class="slot-no">${s.slot}</span>
        <span class="slot-card">${s.current.card ? cardElHTML(s.current.card) : ''}</span>
        <span class="slot-outcome">${s.current.outcome}</span>
        ${executed ? '<span class="micro-copy">実行済み</span>' : `
          <button class="small-action ${!revised ? 'selected' : ''}" data-keep="${s.slot}">通り</button>
          <button class="small-action ${revised ? 'selected' : ''}" data-revise="${s.slot}">修正</button>
        `}
      </div>`;
  }).join('');

  showModal(`
    <div class="panel-title">プラン修正</div>
    <p class="subcopy">トリック${S.currentTrickNo}まで実行済み</p>
    <div class="revision-list">${html}</div>
    <div class="panel-row" style="margin-top:16px;">
      <button class="secondary-button" id="rev-cancel">元のプランに戻す</button>
      <button class="primary-button" id="rev-apply">確定</button>
    </div>`);

  document.querySelectorAll('[data-keep]').forEach(b => b.onclick = () => {
    const slot = Number(b.dataset.keep);
    const s = draft.slots[slot - 1];
    s.decision = 'KEEP';
    s.current = { ...s.original };
    renderRevisionModal();
  });
  document.querySelectorAll('[data-revise]').forEach(b => b.onclick = () => {
    const slot = Number(b.dataset.revise);
    const s = draft.slots[slot - 1];
    s.decision = 'REVISED';
    renderRevisionModal();
  });
  // 修正スロットのカード・WIN/LOSE変更は省略（Phase 2で詳細UI追加）
  document.querySelector('#rev-cancel').onclick = () => { S.revisionDraft = null; closeModal(); };
  document.querySelector('#rev-apply').onclick = () => { applyRevision(); };
}

function showRevisionReasonModal(revisedSlots) {
  const categories = [
    ['opponent_unexpected', '相手が予想外の手を打った'],
    ['void_discovered', '相手のボイドが判明した'],
    ['plan_card_illegal', 'プランカードが合法手にない'],
    ['plan_error', 'プランの誤りに気づいた'],
    ['hand_change', '手札の状況が変わった'],
    ['other', 'その他'],
  ];
  showModal(`
    <div class="panel-title">修正の理由</div>
    <p class="subcopy">修正スロット: ${revisedSlots.map(s => s.slot).join(', ')}</p>
    <div class="reason-list">
      ${categories.map(([k, label]) => `<button class="small-action" data-reason="${k}">${label}</button>`).join('')}
    </div>
    <textarea id="rev-free" placeholder="具体的に（任意）" style="width:100%;margin-top:8px;"></textarea>
    <div class="panel-row" style="margin-top:8px;">
      <button class="secondary-button" id="rev-r-cancel">キャンセル</button>
    </div>`);
  document.querySelectorAll('[data-reason]').forEach(b => b.onclick = () => {
    const reason = document.querySelector('#rev-free')?.value || '';
    finalizeRevision(b.dataset.reason, reason);
  });
  document.querySelector('#rev-r-cancel').onclick = () => closeModal();
}

// ============================================================
// モーダルヘルパー
// ============================================================
function showModal(innerHTML) {
  let m = document.getElementById('nap-lab-modal');
  if (!m) {
    m = document.createElement('div');
    m.id = 'nap-lab-modal';
    m.className = 'modal-overlay';
    m.style.cssText = 'position:fixed;inset:0;z-index:100000;background:rgba(0,0,0,.8);display:flex;align-items:center;justify-content:center;padding:20px;';
    document.body.appendChild(m);
  }
  m.innerHTML = `<div class="modal-card" style="max-width:480px;width:100%;background:#112a23;border:1px solid #476356;border-radius:14px;padding:20px;max-height:85vh;overflow-y:auto;">${innerHTML}</div>`;
}
function closeModal() {
  const m = document.getElementById('nap-lab-modal');
  if (m) m.remove();
}

// ============================================================
// 観戦開始
// ============================================================
function startWatch() {
  S.matchState = createMatchState(S.scenario, S.bid, S.discard, S.call, S.solo);
  S.currentTrickNo = 0;
  S.trickRecords = [];
  S.aborted = false;
  renderWatchStep();
  // 非同期でシミュレーション開始
  runWatchSimulation().catch(e => {
    console.error('[nap-plan-lab] simulation error:', e);
    renderError('シミュレーション中にエラーが発生しました: ' + e.message);
  });
}

// ============================================================
// 画面開閉
// ============================================================
export function openNapPlanLabScreen() {
  const screens = ['home-screen','mode-select-screen','profile-screen','game-screen','records-screen','strategy-screen','quiz-screen','training-screen','extra-menu-screen','past-games-screen'];
  screens.forEach(id => {
    const el = $(id);
    if (el) { el.classList.add('hidden'); el.style.setProperty('display', 'none', 'important'); }
  });

  let screen = $('nap-plan-lab-screen');
  if (!screen) {
    screen = document.createElement('section');
    screen.id = 'nap-plan-lab-screen';
    screen.className = 'screen nap-plan-lab-screen';
    screen.style.cssText = 'position:fixed;inset:0;z-index:99999;background:#0b2620;display:flex;flex-direction:column;';
    screen.innerHTML = `<div id="nap-plan-lab-shell" style="flex:1;overflow-y:auto;-webkit-overflow-scrolling:touch;"></div>`;
    document.body.appendChild(screen);
  }
  screen.classList.remove('hidden');
  screen.style.setProperty('display', 'flex', 'important');
  screen.style.setProperty('position', 'fixed', 'important');
  screen.style.setProperty('inset', '0', 'important');

  startNewScenario();
}

function closeNapPlanLab() {
  S.aborted = true;
  if (S.pauseResolve) { const r = S.pauseResolve; S.pauseResolve = null; r(); }
  closeModal();
  const screen = $('nap-plan-lab-screen');
  if (screen) { screen.classList.add('hidden'); screen.style.setProperty('display', 'none', 'important'); }
  $('mode-select-screen')?.classList.remove('hidden');
  $('mode-select-screen')?.style.removeProperty('display');
}

function renderError(msg) {
  const shell = $('nap-plan-lab-shell');
  if (!shell) return;
  shell.innerHTML = `<div class="quiz-error" style="padding:40px;text-align:center;color:#e89685;">${escapeHTML(msg)}</div>
    <div class="panel-row" style="margin-top:16px;"><button class="primary-button" id="lab-error-close">戻る</button></div>`;
  document.getElementById('lab-error-close').onclick = closeNapPlanLab;
}

// ============================================================
// デバッグ・テスト用エクスポート
// ============================================================
export function __debugState() { return JSON.parse(JSON.stringify(S)); }
export function __setScenarioForTest(handIds, kittyIds) {
  // テスト用: 手札を手動で設定
  const hand10 = handIds.map(cardById);
  const openKitty = kittyIds.map(cardById);
  const remaining = buildDeck().filter(c => !handIds.includes(c.id) && !kittyIds.includes(c.id));
  const oppHands = [[], [], [], [], []];
  for (let i = 1; i < 5; i++) oppHands[i] = remaining.splice(0, 10);
  S.scenario = { seed: 0, hand10, openKitty, opponents: oppHands };
  S.step = 'scenario';
  renderStep();
}

