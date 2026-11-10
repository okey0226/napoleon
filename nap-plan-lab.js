// nap-plan-lab.js — NAP限定 プラン実行＆乖離測定コーナー（完全版）
// 修正点:
// - COM思考にMCTSを導入
// - 合法手にあるならプランカードを絶対に出す
// - リアルタイム描画とCOM戦互換のテーブルUI
// - 逸脱理由の厳密な判定

import {
  SUITS, RANKS, defaultStrategy, sortHand,
} from './constants.js';
import {
  computeProperBid, chooseCardToPlay, chooseCardWithMCTS, winningEntry,
} from './ai-tactics.js';

const $ = id => document.getElementById(id);
const POINT = ['10', 'J', 'Q', 'K', 'A'];
const STEPS = ['scenario', 'bid', 'discard', 'call', 'expect', 'plan', 'watch', 'report'];

const S = {
  step: 'scenario',
  seed: 0,
  scenario: null,
  bid: null,
  discard: [],
  call: null,
  solo: false,
  expectedCards: [],
  initialPlan: null,
  currentPlan: null,
  revisions: [],
  trickRecords: [],
  currentTrickNo: 0,
  matchState: null,
  pauseResolve: null,
  report: null,
  aborted: false,
  revisionDraft: null,
  selectedUnplacedId: null,
};

function hashSeed(...args) {
  let h = 2166136261 >>> 0;
  const str = args.join(':');
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
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
  return String(v ?? '').replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

function cardElHTML(c, extra = '') {
  if (!c) return `<div class="card card-back ${extra}"></div>`;
  const red = c.suit === '♦' || c.suit === '♥';
  return `<div class="card ${red ? 'red ' : ''}${extra}"><span class="rank">${c.rank}</span><span class="suit">${c.suit}</span></div>`;
}

function toast(msg) {
  const e = $('toast');
  if (!e) { console.warn('[nap-plan-lab]', msg); return; }
  e.textContent = msg;
  e.classList.add('show');
  clearTimeout(toast._timer);
  toast._timer = setTimeout(() => e.classList.remove('show'), 2400);
}

function delay(ms) { return new Promise(r => setTimeout(r, ms)); }

function buildDeck() {
  const d = [];
  for (const s of SUITS) for (const r of RANKS) d.push({ suit: s, rank: r, id: s + r });
  return d;
}

function generateScenario(seed) {
  const rng = mulberry32(seed >>> 0);
  const params = defaultStrategy();
  const MAX_ATTEMPTS = 250;

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const deck = shuffleWithRng(buildDeck(), rng);
    const hand10 = deck.splice(0, 10).map(c => ({ ...c }));
    const openKitty = deck.splice(0, 2).map(c => ({ ...c }));
    sortHand(hand10);

    let bestSuit = null;
    let bestProper = 0;
    for (const suit of SUITS.concat(['NT'])) {
      let r;
      try {
        r = computeProperBid(
          hand10, suit, params, 0, null,
          [0, 0, 0, 0, 0], openKitty, [],
          [{}, {}, {}, {}, {}], [], 1
        );
      } catch { continue; }
      if (r && r.properBid > bestProper) {
        bestProper = r.properBid;
        bestSuit = suit;
      }
    }
    if (bestProper < 14 || !bestSuit) continue;

    if (bestSuit !== 'NT') {
      const trumps = hand10.filter(c => c.suit === bestSuit).length;
      if (trumps < 4) continue;
    }
    const sideAces = hand10.filter(c => c.rank === 'A' && c.id !== '♠A' && c.suit !== bestSuit).length;
    if (sideAces < 1) continue;
    const points = hand10.filter(c => POINT.includes(c.rank)).length;
    if (points < 5) continue;

    const oppHands = [[], [], [], [], []];
    for (let i = 1; i < 5; i++) {
      oppHands[i] = deck.splice(0, 10).map(c => ({ ...c }));
    }

    return { seed, hand10, openKitty, opponents: oppHands };
  }
  return null;
}

function createMatchState(scenario, bid, discard, call, solo) {
  const hands = [[], [], [], [], []];
  hands[0] = scenario.hand10.concat(scenario.openKitty).filter(
    c => !discard.some(d => d.id === c.id)
  ).map(c => ({ ...c }));
  for (let i = 1; i < 5; i++) {
    hands[i] = scenario.opponents[i].map(c => ({ ...c }));
  }

  const contract = {
    nap: 0,
    num: bid.num,
    suit: bid.suit,
    deputy: solo ? 0 : -1,
    solo,
    revealedCall: false,
    call: { ...call },
  };

  if (!solo) {
    for (let i = 1; i < 5; i++) {
      if (hands[i].some(c => c.id === call.id)) {
        contract.deputy = i;
        break;
      }
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
  if (!Number.isInteger(seat) || seat < 0 || seat > 4) return [];
  const h = state.hands[seat];
  if (!h) return [];
  if (!state.trick.length) return h;
  const led = state.trick[0].card.suit;
  const follow = h.filter(c => c.suit === led);
  return follow.length ? follow : h;
}

function playCardToState(state, seat, card) {
  if (!Number.isInteger(seat) || seat < 0 || seat > 4) return false;
  if (!state.hands[seat] || !card || !card.id) return false;
  const hand = state.hands[seat];
  const idx = hand.findIndex(c => c.id === card.id);
  if (idx < 0) return false;
  hand.splice(idx, 1);
  if (state.trick.length > 0) {
    const led = state.trick[0].card.suit;
    if (card.suit !== led) state.voids[seat][led] = true;
  }
  if (card.id === state.contract.call?.id) state.contract.revealedCall = true;
  state.trick.push({ seat, card });
  state.playedCards.push({
    suit: card.suit,
    rank: card.rank,
    id: card.id,
    seat,
  });
  return true;
}

function buildPlayCtx(state, seat) {
  const deputyPts = !state.contract.solo && state.contract.deputy >= 0
    ? (state.points[state.contract.deputy] || 0)
    : 0;
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
    discardedKitty: S.discard,
    isMySideNap: seat === state.contract.nap
      || (!state.contract.solo && seat === state.contract.deputy),
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

function closestCardToPlan(slot, legal) {
  if (!slot || !legal.length) return legal[0];
  const target = slot.card;

  const sameSuit = legal.filter(c => c.suit === target.suit);
  if (sameSuit.length) {
    if (slot.outcome === 'LOSE') {
      return sameSuit.reduce((b, c) =>
        RANKS.indexOf(c.rank) < RANKS.indexOf(b.rank) ? c : b);
    }
    return sameSuit.reduce((b, c) =>
      RANKS.indexOf(c.rank) > RANKS.indexOf(b.rank) ? c : b);
  }

  const sameRank = legal.filter(c => c.rank === target.rank);
  if (sameRank.length) return sameRank[0];

  if (slot.outcome === 'LOSE') {
    return legal.reduce((b, c) =>
      RANKS.indexOf(c.rank) < RANKS.indexOf(b.rank) ? c : b);
  }
  return legal.reduce((b, c) =>
    RANKS.indexOf(c.rank) > RANKS.indexOf(b.rank) ? c : b);
}

function chooseNapCardWithPlanPriority(state) {
  const plan = S.currentPlan;
  const slot = plan?.sequence?.[state.trickNo];
  const legal = legalCards(state, 0);

  if (!legal.length) return null;

  if (!slot || !slot.card) {
    try { return chooseCardToPlay(buildPlayCtx(state, 0)); }
    catch { return legal[0]; }
  }

  const planCard = slot.card;
  const legalPlan = legal.find(c => c.id === planCard.id);

  // 合法手にあるなら絶対にプランカードを出す
  if (legalPlan) {
    return legalPlan;
  }
  return closestCardToPlan(slot, legal);
}

function chooseComCard(state, seat) {
  const legal = legalCards(state, seat);
  if (!legal.length) return null;
  const ctx = buildPlayCtx(state, seat);
  try {
    // COM戦と同様にMCTSを実行（UIをブロックしないよう計算時間を抑える）
    const chosen = chooseCardWithMCTS({ ...ctx, params: { ...ctx.params, maxThinkTimeMs: 800 } });
    if (chosen && legal.some(c => c.id === chosen.id)) return chosen;
  } catch (e) { /* fallback */ }
  
  try {
    return chooseCardToPlay(ctx);
  } catch {
    return legal[0];
  }
}

async function runWatchSimulation() {
  const state = S.matchState;
  S.currentTrickNo = 0;

  while (!state.finished && !S.aborted) {
    const trickNo = state.trickNo;

    while (state.trick.length < 5 && !state.finished) {
      const lastSeat = state.trick.length > 0 ? state.trick[state.trick.length - 1].seat : null;
      const seat = state.trick.length === 0
        ? state.active
        : (Number.isInteger(lastSeat) ? (lastSeat + 1) % 5 : 0);

      if (!Number.isInteger(seat) || seat < 0 || seat > 4) break;

      const legalBefore = legalCards(state, seat); // 偏差判定用にプレイ前の合法手を保持
      
      const chosen = seat === 0
        ? chooseNapCardWithPlanPriority(state)
        : chooseComCard(state, seat);

      if (!chosen) break;

      const ok = playCardToState(state, seat, chosen);
      if (!ok) break;

      renderWatchStep(); // 1枚出るたびに描画を更新
      await delay(250);
      if (S.aborted) return;
    }

    if (state.trick.length < 5) break;

    const trickSnapshot = state.trick.slice();
    let winnerEntry = null;
    try {
      winnerEntry = winningEntry(state.contract, state.trickNo, state.trick);
    } catch (e) {
      winnerEntry = null;
    }

    let winner = 0;
    if (winnerEntry && Number.isInteger(winnerEntry.seat) && winnerEntry.seat >= 0 && winnerEntry.seat < 5) {
      winner = winnerEntry.seat;
    } else if (state.trick[0] && Number.isInteger(state.trick[0].seat)) {
      winner = state.trick[0].seat;
    }

    const taken = state.trick
      .filter(e => POINT.includes(e.card.rank))
      .map(e => e.card);

    if (!state.taken[winner]) state.taken[winner] = [];
    state.points[winner] += taken.length;
    state.taken[winner].push(...taken);
    state.active = winner;
    
    // トリック終了時のスナップショットを保存（次のトリックが始まるまで表示するため）
    state.lastTrick = trickSnapshot;
    state.lastTrickWinner = winner;

    state.trick = [];
    state.trickNo++;
    if (state.trickNo >= 10) state.finished = true;

    const napCard = trickSnapshot.find(t => t.seat === 0)?.card;
    const slot = S.currentPlan?.sequence?.[trickNo];
    const plannedCard = slot?.card;
    const plannedOutcome = slot?.outcome;
    const actualOutcome = winner === 0 ? 'WIN' : 'LOSE';

    let deviation = null;
    if (plannedCard && napCard) {
      if (plannedCard.id !== napCard.id) {
        // プランカードがプレイ前に合法手だったか確認
        const planWasLegal = legalBefore.some(c => c.id === plannedCard.id);
        
        deviation = {
          type: 'CARD_CHANGED',
          plannedCard: plannedCard.id,
          actualCard: napCard.id,
          reason: planWasLegal ? 'forced_loss_avoided' : 'plan_card_illegal',
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

    if (!state.finished) {
      await new Promise(resolve => { S.pauseResolve = resolve; });
      if (S.aborted) return;
    }
  }

  S.step = 'report';
  S.report = computeReport();
  renderStep();
}

function resumeFromPause() {
  if (S.pauseResolve) {
    const r = S.pauseResolve;
    S.pauseResolve = null;
    r();
  }
}

function computeReport() {
  const records = S.trickRecords;
  const matches = records.filter(r => !r.deviation).length;
  const deviations = records.filter(r => r.deviation);

  const winPreds = records.filter(r => r.plannedOutcome === 'WIN');
  const losePreds = records.filter(r => r.plannedOutcome === 'LOSE');
  const winHits = winPreds.filter(r => r.actualOutcome === 'WIN').length;
  const loseHits = losePreds.filter(r => r.actualOutcome === 'LOSE').length;

  const deputyHand = S.solo
    ? []
    : (S.matchState.hands[S.matchState.contract.deputy] || []);
  const deputyIds = new Set(deputyHand.map(c => c.id));
  const expected = S.expectedCards;
  const hits = expected.filter(id => deputyIds.has(id));

  const finalNapPts = S.matchState.points[0]
    + (S.solo ? 0 : (S.matchState.points[S.matchState.contract.deputy] || 0));
  const made = finalNapPts >= S.bid.num
    && (S.bid.num === 20 || finalNapPts < 20);

  return {
    planExecution: { matched: matches, total: records.length, deviations },
    outcomePrediction: {
      winPred: winPreds.length,
      winHit: winHits,
      losePred: losePreds.length,
      loseHit: loseHits,
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
      finalNapPts,
      bid: S.bid.num,
      made,
      matchPoints: S.matchState.points.slice(),
    },
  };
}

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
    initialPlan: S.initialPlan?.sequence.map(s => ({
      slot: s.slot,
      card: s.card?.id,
      outcome: s.outcome,
    })),
    finalPlan: S.currentPlan?.sequence.map(s => ({
      slot: s.slot,
      card: s.card?.id,
      outcome: s.outcome,
    })),
    revisions: S.revisions,
    trickRecords: S.trickRecords,
    report,
    createdAt: new Date().toISOString(),
  };
  try {
    const token = localStorage.getItem('napoleon_session');
    await fetch('/api/nap-lab/save', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(token ? { 'x-session-token': token } : {}),
      },
      body: JSON.stringify(record),
    });
  } catch (e) {
    console.warn('[nap-plan-lab] save failed:', e);
    try {
      const key = 'nap_lab_unsaved';
      const arr = JSON.parse(localStorage.getItem(key) || '[]');
      arr.push(record);
      localStorage.setItem(key, JSON.stringify(arr.slice(-20)));
    } catch {}
  }
}

// ============================================================
// UI・画面遷移
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
  S.selectedUnplacedId = null;
}

function startNewScenario() {
  resetSession();
  S.seed = Date.now() & 0x7fffffff;
  const sc = generateScenario(S.seed);
  if (!sc) {
    renderError('シナリオ生成に失敗しました。もう一度お試しください。');
    return;
  }
  S.scenario = sc;
  S.step = 'scenario';
  renderStep();
}

function goNext() {
  const idx = STEPS.indexOf(S.step);
  if (idx < 0 || idx >= STEPS.length - 1) return;

  if (S.step === 'bid' && !S.bid) return toast('宣言を選んでください');
  if (S.step === 'discard' && S.discard.length !== 2) return toast('捨て札を2枚選んでください');
  if (S.step === 'call' && !S.call) return toast('指名カードを選んでください');
  if (S.step === 'call' && S.discard.some(d => d.id === S.call.id)) {
    return toast('捨て札は指名できません');
  }
  if (S.step === 'plan') {
    const usedIds = new Set(S.currentPlan.sequence.map(s => s.card?.id).filter(Boolean));
    const allCards = S.scenario.hand10.concat(S.scenario.openKitty).filter(
      c => !S.discard.some(d => d.id === c.id)
    );
    if (allCards.some(c => !usedIds.has(c.id))) {
      return toast('すべてのカードを配置してください');
    }
  }

  S.step = STEPS[idx + 1];
  if (S.step === 'watch') startWatch();
  else renderStep();
}

function goBack() {
  const idx = STEPS.indexOf(S.step);
  if (idx <= 0) return;

  if (S.step === 'watch') {
    if (!confirm('観戦を中断して前のステップに戻りますか？')) return;
    S.aborted = true;
    if (S.pauseResolve) {
      const r = S.pauseResolve;
      S.pauseResolve = null;
      r();
    }
  }

  S.step = STEPS[idx - 1];
  renderStep();
}

function renderStep() {
  const shell = $('nap-plan-lab-shell');
  if (!shell) return;
  switch (S.step) {
    case 'scenario': renderScenarioStep(shell); break;
    case 'bid':      renderBidStep(shell); break;
    case 'discard':  renderDiscardStep(shell); break;
    case 'call':     renderCallStep(shell); break;
    case 'expect':   renderExpectStep(shell); break;
    case 'plan':     renderPlanStep(shell); break;
    case 'watch':    renderWatchStep(); break;
    case 'report':   renderReportStep(shell); break;
  }
}

function stepHeader(title, opts = {}) {
  return `
    <div class="lab-step-header">
      <button class="back-button" id="lab-back" ${opts.noBack ? 'disabled' : ''}>← 戻る</button>
      <div class="lab-step-title">${escapeHTML(title)}</div>
      <button class="primary-button" id="lab-next" ${opts.noNext ? 'disabled' : ''}>次へ →</button>
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
      ${stepHeader('シナリオ', { noBack: true })}
      <div class="lab-body">
        <div class="panel-title">手札10枚</div>
        <div class="lab-hand-grid">${hand}</div>
        <div class="panel-title" style="margin-top:16px;">オープン（浮き札）</div>
        <div class="lab-hand-grid lab-hand-grid-sm">${kitty}</div>
        <p class="subcopy" style="margin-top:20px;">この手札でNAPを務めます。宣言から切り順まで、すべてあなたが決めます。</p>
      </div>
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
      <div class="lab-body">
        <div class="panel-title">スート</div>
        <div class="lab-suit-row">
          ${suits.map(s =>
            `<button class="lab-suit-btn ${s === suit ? 'selected' : ''}" data-bid-suit="${s}">${s}</button>`
          ).join('')}
        </div>

        <div class="panel-title" style="margin-top:18px;">枚数</div>
        <div class="lab-num-row">
          <button class="lab-num-btn" id="bid-minus">−</button>
          <span class="lab-num-display" id="bid-num">${num}</span>
          <button class="lab-num-btn" id="bid-plus">＋</button>
        </div>

        <div class="panel-title" style="margin-top:18px;">手札（参考）</div>
        <div class="lab-hand-grid">${hand}</div>
      </div>
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
  const handHTML = hand12.map(c =>
    cardElHTML(c, selectedIds.has(c.id) ? 'selected playable' : 'playable')
  ).join('');

  shell.innerHTML = `
    <div class="game-screen nap-lab">
      ${stepHeader('捨て札を2枚選ぶ')}
      <div class="lab-body">
        <div class="lab-sticky-info">
          <span>選択: <b>${S.discard.length}/2</b></span>
          <span class="micro-copy" style="color:#e6be72;">カードをタップ</span>
        </div>
        <div class="lab-hand-grid">${handHTML}</div>
        <p class="micro-copy" style="margin-top:12px;color:#e6be72;">点札を捨てると連合軍に点が入ります</p>
      </div>
    </div>`;

  shell.querySelectorAll('.lab-hand-grid .card.playable').forEach((el, i) => {
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
  const myHand = S.scenario.hand10.concat(S.scenario.openKitty).filter(
    c => !S.discard.some(d => d.id === c.id)
  );
  const myHandIds = new Set(myHand.map(c => c.id));
  const discardIds = new Set(S.discard.map(c => c.id));

  const selSuit = S.call?.suit || '♠';
  const selRank = S.call?.rank || 'A';
  const selId = selSuit + selRank;
  const hasSelection = !!S.call;

  const isOwnCard = myHandIds.has(selId);
  const isDiscarded = discardIds.has(selId);

  const suitBtns = SUITS.map(s =>
    `<button class="lab-suit-btn ${s === selSuit ? 'selected' : ''}" data-cs="${s}">${s}</button>`
  ).join('');

  const rankBtns = RANKS.slice().reverse().map(r => {
    const id = selSuit + r;
    const isDis = discardIds.has(id);
    const isHand = myHandIds.has(id);
    const cls = [
      'lab-rank-btn',
      r === selRank ? 'selected' : '',
      isDis ? 'disabled' : '',
      isHand ? 'hand-badge' : '',
    ].filter(Boolean).join(' ');
    return `<button class="${cls}" data-cr="${r}" ${isDis ? 'disabled' : ''}>${r}</button>`;
  }).join('');

  const handHTML = myHand.map(c =>
    cardElHTML(c, c.id === selId ? 'selected' : '')
  ).join('');

  const discardHTML = S.discard.map(c => cardElHTML(c, 'protected')).join('');

  let previewHTML = '';
  if (hasSelection) {
    if (isDiscarded) {
      previewHTML = `
        <div class="lab-selected-card" style="border-color:#e89685;">
          <p class="micro-copy" style="color:#e89685;margin:0;text-align:center;">
            ⚠ ${selId} は捨て札のため指名できません
          </p>
        </div>`;
    } else {
      previewHTML = `
        <div class="lab-selected-card">
          <div class="lab-selected-row">
            ${cardElHTML({ suit: selSuit, rank: selRank, id: selId })}
            <div class="lab-selected-info">
              <strong>${selId}</strong>
              <span class="micro-copy" style="color:${isOwnCard ? '#e6be72' : '#a9d2ae'};">
                ${isOwnCard ? '⚠ 自分の手札 → ひとり立ち' : '副官指名'}
              </span>
            </div>
          </div>
          <button class="primary-button" id="call-confirm"
            style="width:100%;min-height:52px;margin-top:14px;font-size:15px;font-weight:800;">
            この札を指名する
          </button>
        </div>`;
    }
  } else {
    previewHTML = `
      <p class="micro-copy" style="margin-top:16px;text-align:center;color:#e6be72;">
        スートとランクを選んでください
      </p>`;
  }

  shell.innerHTML = `
    <div class="game-screen nap-lab">
      ${stepHeader('指名カードを選ぶ')}
      <div class="lab-body">
        <p class="subcopy" style="margin-bottom:14px;">
          副官に指名するカードを選んでください。<br>
          自分の手札にある札を指名すると「ひとり立ち」になります。
        </p>

        <div class="panel-title">スート</div>
        <div class="lab-suit-row">${suitBtns}</div>

        <div class="panel-title" style="margin-top:16px;">ランク（★ = 自分の手札）</div>
        <div class="lab-rank-grid">${rankBtns}</div>

        <div class="panel-title" style="margin-top:16px;">あなたの手札（参考）</div>
        <div class="lab-hand-grid lab-hand-grid-sm">${handHTML}</div>

        <div class="panel-title" style="margin-top:12px;">捨て札（指名不可）</div>
        <div class="lab-hand-grid lab-hand-grid-sm lab-hand-discard">${discardHTML}</div>

        ${previewHTML}
      </div>
    </div>`;

  shell.querySelectorAll('[data-cs]').forEach(b => b.onclick = () => {
    S.call = { suit: b.dataset.cs, rank: selRank, id: b.dataset.cs + selRank };
    S.solo = myHandIds.has(S.call.id);
    renderCallStep(shell);
  });

  shell.querySelectorAll('[data-cr]:not(.disabled)').forEach(b => b.onclick = () => {
    S.call = { suit: selSuit, rank: b.dataset.cr, id: selSuit + b.dataset.cr };
    S.solo = myHandIds.has(S.call.id);
    renderCallStep(shell);
  });

  const confirmBtn = shell.querySelector('#call-confirm');
  if (confirmBtn) {
    confirmBtn.onclick = () => {
      if (!S.call) return;
      if (discardIds.has(S.call.id)) { toast('捨て札は指名できません'); return; }
      S.solo = myHandIds.has(S.call.id);
      goNext();
    };
  }

  bindHeader(shell);
}

function renderExpectStep(shell) {
  const usedIds = new Set();
  S.scenario.hand10.forEach(c => usedIds.add(c.id));
  S.scenario.openKitty.forEach(c => usedIds.add(c.id));
  S.discard.forEach(c => usedIds.add(c.id));
  if (S.call) usedIds.add(S.call.id);

  const expectedSet = new Set(S.expectedCards);

  const currentHand = S.scenario.hand10.concat(S.scenario.openKitty).filter(
    c => !S.discard.some(d => d.id === c.id)
  );
  const currentHandHTML = currentHand.map(c =>
    cardElHTML(c, c.id === S.call?.id ? 'protected' : '')
  ).join('');

  const blocks = SUITS.map(suit => {
    const ranks = RANKS.slice().reverse();
    const buttons = ranks.map(r => {
      const id = suit + r;
      if (usedIds.has(id)) return '';
      const sel = expectedSet.has(id);
      return `<button class="lab-expect-btn ${sel ? 'selected' : ''}" data-expect="${id}">${r}</button>`;
    }).join('');
    const red = suit === '♦' || suit === '♥';
    return `
      <div class="lab-expect-block">
        <div class="lab-expect-suit ${red ? 'red' : ''}">${suit}</div>
        <div class="lab-expect-row">${buttons}</div>
      </div>`;
  }).join('');

  shell.innerHTML = `
    <div class="game-screen nap-lab">
      ${stepHeader('副官に期待するカード')}
      <div class="lab-body">
        <div class="lab-sticky-info">
          <span>選択中: <b>${S.expectedCards.length}枚</b></span>
          <button class="secondary-button" id="expect-clear"
            style="min-height:40px;padding:6px 12px;font-size:12px;">クリア</button>
        </div>

        <div class="panel-title" style="margin-top:12px;">現在の手札（参考）</div>
        <div class="lab-hand-grid lab-hand-grid-sm">${currentHandHTML}</div>

        <p class="micro-copy" style="margin-top:12px;margin-bottom:10px;">複数可・0枚でもOK</p>
        ${blocks}
      </div>
    </div>`;

  shell.querySelectorAll('[data-expect]').forEach(b => b.onclick = () => {
    const id = b.dataset.expect;
    if (expectedSet.has(id)) S.expectedCards = S.expectedCards.filter(x => x !== id);
    else S.expectedCards.push(id);
    renderExpectStep(shell);
  });
  shell.querySelector('#expect-clear').onclick = () => {
    S.expectedCards = [];
    renderExpectStep(shell);
  };
  bindHeader(shell);
}

function generateInitialPlan(scenario, bid, discard, call, solo) {
  const myHand = scenario.hand10.concat(scenario.openKitty).filter(
    c => !discard.some(d => d.id === c.id)
  );
  const contract = {
    nap: 0,
    num: bid.num,
    suit: bid.suit,
    deputy: solo ? 0 : -1,
    solo,
    revealedCall: false,
    call: { ...call },
  };
  return buildNaivePlan(myHand, contract);
}

function buildNaivePlan(myHand, contract) {
  const scored = myHand.map(c => {
    let score = 0;
    if (c.id === '♠A') score = 100;
    else if (c.id === '♥Q') score = 90;
    else if (contract.suit !== 'NT' && c.rank === 'J' && c.suit === contract.suit) score = 85;
    else if (contract.suit !== 'NT' && c.rank === 'J'
      && (c.suit === '♣' || c.suit === '♠') === (contract.suit === '♣' || contract.suit === '♠')) score = 75;
    else if (c.rank === 'A') score = 70;
    else if (c.rank === 'K') score = 40;
    else if (c.rank === 'Q') score = 35;
    else if (contract.suit !== 'NT' && c.suit === contract.suit) score = 30;
    else if (c.rank === '2') score = 20;
    else score = 10;
    return { card: c, score };
  });
  scored.sort((a, b) => b.score - a.score);
  return {
    sequence: scored.map((e, i) => ({
      slot: i + 1,
      card: e.card,
      outcome: e.score >= 60 ? 'WIN' : 'LOSE',
    })),
  };
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
    <div class="lab-plan-slot ${s.card ? 'filled' : 'empty'}" data-slot="${i}">
      <span class="lab-slot-no">${i + 1}</span>
      <span class="lab-slot-card" data-slot-card="${i}">${s.card ? cardElHTML(s.card) : '未配置'}</span>
      <button class="lab-outcome-btn ${s.outcome === 'WIN' ? 'win' : 'lose'}" data-toggle="${i}">${s.outcome}</button>
    </div>`).join('');

  shell.innerHTML = `
    <div class="game-screen nap-lab">
      ${stepHeader('切り順プラン')}
      <div class="lab-sticky-info">
        <span>予測: <b>${winCount}勝 ${loseCount}敗</b></span>
        <span class="micro-copy" style="color:#e6be72;">スロットをタップ</span>
      </div>
      <div class="lab-body" style="padding-top:0;">
        <div class="lab-plan-slots">${slotsHTML}</div>

        <div class="panel-title" style="margin-top:16px;">未配置のカード（${unplaced.length}枚）</div>
        <div class="lab-hand-grid lab-hand-grid-sm">
          ${unplaced.length
            ? unplaced.map(c => cardElHTML(c, 'playable')).join('')
            : '<p class="micro-copy" style="padding:8px;grid-column:1/-1;text-align:center;">すべて配置済み</p>'}
        </div>
      </div>
    </div>`;

  shell.querySelectorAll('[data-slot-card]').forEach(el => {
    const idx = Number(el.dataset.slotCard);
    el.onclick = () => {
      const current = plan.sequence[idx];
      if (current.card) {
        showSlotMenu(idx, shell);
      } else {
        showSlotCardPicker(idx, shell);
      }
    };
  });

  shell.querySelectorAll('[data-toggle]').forEach(btn => {
    const idx = Number(btn.dataset.toggle);
    btn.onclick = (e) => {
      e.stopPropagation();
      const s = plan.sequence[idx];
      s.outcome = s.outcome === 'WIN' ? 'LOSE' : 'WIN';
      renderPlanStep(shell);
    };
  });

  bindHeader(shell);
}

function showSlotCardPicker(slotIdx, shell) {
  const plan = S.currentPlan;
  const usedIds = new Set(plan.sequence.map(s => s.card?.id).filter(Boolean));
  const allMyCards = S.scenario.hand10.concat(S.scenario.openKitty).filter(
    c => !S.discard.some(d => d.id === c.id)
  );
  const unplaced = allMyCards.filter(c => !usedIds.has(c.id));

  if (!unplaced.length) {
    toast('配置できるカードがありません');
    return;
  }

  const html = unplaced.map(c => `
    <button class="lab-swap-option" data-pick="${c.id}">
      ${cardElHTML(c)}
    </button>
  `).join('');

  showModal(`
    <div class="panel-title">スロット ${slotIdx + 1} に配置するカード</div>
    <div class="lab-swap-grid" style="grid-template-columns:repeat(4,1fr);">${html}</div>
    <div class="lab-modal-actions">
      <button class="secondary-button" id="slot-pick-cancel" style="flex:1;min-height:48px;">キャンセル</button>
    </div>
  `);

  document.querySelectorAll('[data-pick]').forEach(btn => {
    btn.onclick = () => {
      const cardId = btn.dataset.pick;
      const card = unplaced.find(c => c.id === cardId);
      if (card) {
        plan.sequence[slotIdx] = { slot: slotIdx + 1, card, outcome: plan.sequence[slotIdx].outcome };
        closeModal();
        renderPlanStep(shell);
      }
    };
  });
  document.querySelector('#slot-pick-cancel').onclick = () => closeModal();
}

function showSlotMenu(slotIdx, shell) {
  showModal(`
    <div class="panel-title">スロット ${slotIdx + 1} の操作</div>
    <div class="lab-modal-actions" style="flex-direction:column;">
      <button class="secondary-button" id="slot-change" style="width:100%;min-height:48px;">カードを変更する</button>
      <button class="secondary-button" id="slot-remove" style="width:100%;min-height:48px;background:#49302b;">配置を外す</button>
      <button class="secondary-button" id="slot-menu-cancel" style="width:100%;min-height:48px;">キャンセル</button>
    </div>
  `);
  document.querySelector('#slot-change').onclick = () => {
    closeModal();
    showSlotCardPicker(slotIdx, shell);
  };
  document.querySelector('#slot-remove').onclick = () => {
    const plan = S.currentPlan;
    const outcome = plan.sequence[slotIdx].outcome;
    plan.sequence[slotIdx] = { slot: slotIdx + 1, card: null, outcome };
    closeModal();
    renderPlanStep(shell);
  };
  document.querySelector('#slot-menu-cancel').onclick = () => closeModal();
}

function renderWatchStep() {
  const shell = $('nap-plan-lab-shell');
  if (!shell) return;
  const state = S.matchState;
  if (!state) return;

  const lastRecord = S.trickRecords[S.trickRecords.length - 1];
  const trickNoDisplay = Math.min(state.trickNo + 1, 10);

  // 現在の場札
  const trickCardsHTML = state.trick.map(t => {
    return `<div class="trick-card played-seat-${t.seat}">${cardElHTML(t.card)}</div>`;
  }).join('');

  // 直前のトリック勝者（ハイライト用）
  const lastWinner = state.lastTrickWinner;

  // 前トリックの結果カード
  const recordHTML = lastRecord
    ? `
      <div class="lab-record-card ${lastRecord.deviation ? 'deviation' : 'ok'}" style="margin: 0; padding: 8px 10px;">
        <div class="lab-record-row" style="font-size: 12px;">
          <span>プラン: <b>${lastRecord.plannedCard || '—'} ${lastRecord.plannedOutcome || ''}</b></span>
          <span>実際: <b>${lastRecord.actualCard} ${lastRecord.actualOutcome}</b></span>
        </div>
        <div class="lab-record-row" style="font-size: 11px; margin-top: 4px;">
          <span>トリック勝者: <b>${lastRecord.trickWinner === 0 ? 'あなた' : 'COM '+lastRecord.trickWinner}</b></span>
          ${lastRecord.deviation
            ? `<span style="color:#e89685;">⚠ 逸脱: ${escapeHTML(lastRecord.deviation.reason)}</span>`
            : `<span style="color:#a9d2ae;">✓ プラン通り</span>`}
        </div>
      </div>`
    : `<div class="lab-record-card ok" style="margin: 0; padding: 8px 10px;"><div class="lab-record-row" style="font-size: 12px;"><span>シミュレーション開始</span></div></div>`;

  // プレイヤー席の描画
  const playersHTML = state.hands.map((_, i) => {
    const isActive = state.active === i;
    const isWinner = lastWinner === i;
    const role = state.contract.nap === i ? 'ナポレオン' : (!state.contract.solo && state.contract.revealedCall && state.contract.deputy === i ? '副官' : '連合軍');
    const name = i === 0 ? 'あなた' : `COM ${i}`;
    const points = state.taken[i] ? state.taken[i].length : 0;
    return `
      <div class="player-seat player-color-${i} pos-${i} ${isActive ? 'active' : ''} ${isWinner ? 'trick-winner' : ''} ${i === 0 ? 'me' : ''}" style="padding: 6px 8px;">
        <div class="seat-name" style="font-size: 11px;">${name}</div>
        <div class="seat-role ${role === '副官' ? 'deputy-status' : ''}" style="font-size: 8px;">${role}</div>
        <div class="taken-cards"><span class="taken-label">獲得 ${points}</span></div>
      </div>`;
  }).join('');

  // 全体レイアウト（COM戦の game-screen を踏襲）
  shell.innerHTML = `
    <div class="game-screen nap-lab" style="height: 100dvh; overflow: hidden; padding: 0; background: #0b2620;">
      <div class="lab-step-header" style="flex-shrink: 0;">
        <button class="back-button" id="lab-back" disabled>観戦中</button>
        <div class="lab-step-title">トリック ${trickNoDisplay} / 10</div>
        <div style="width:60px;"></div>
      </div>
      
      <div style="flex-shrink: 0; padding: 8px 12px;">
        ${recordHTML}
      </div>

      <!-- テーブルエリア -->
      <div class="table-area" style="flex: 1; min-height: 0; margin: 0; position: relative; display: block;">
        <div class="players-ring">${playersHTML}</div>
        <div class="trick-cards">${trickCardsHTML}</div>
        <div class="center-table">
          <div class="center-caption">場札</div>
        </div>
      </div>

      <!-- 自分の手札 -->
      <div style="flex-shrink: 0; padding: 0 12px; padding-bottom: env(safe-area-inset-bottom, 0);">
        <div class="panel-title" style="margin-bottom: 4px;">手札（${state.hands[0].length}枚）</div>
        <div class="lab-hand-grid lab-hand-grid-sm" style="max-height: 110px; overflow-y: auto; padding: 4px; margin-bottom: 8px;">
          ${state.hands[0].map(c => cardElHTML(c)).join('')}
        </div>
      </div>

      <div class="lab-bottom-bar" style="flex-shrink: 0; position: static; padding: 8px 12px;">
        <button class="secondary-button" id="lab-revise" style="flex:1;min-height:48px;">✎ プラン修正</button>
        <button class="primary-button" id="lab-continue" style="flex:2;min-height:48px;">次のトリックへ</button>
      </div>
    </div>`;

  shell.querySelector('#lab-revise').onclick = () => { openRevisionMode(); };
  shell.querySelector('#lab-continue').onclick = () => { resumeFromPause(); };
}

function openRevisionMode() {
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

function renderRevisionModal() {
  const draft = S.revisionDraft;
  if (!draft) return;

  const html = draft.slots.map(s => {
    const executed = s.decision === 'EXECUTED';
    const revised = s.decision === 'REVISED';
    return `
      <div class="lab-revision-slot ${executed ? 'executed' : ''}">
        <div class="lab-revision-head">
          <span class="lab-slot-no">${s.slot}</span>
          <span class="lab-revision-card">${s.current.card ? cardElHTML(s.current.card) : ''}</span>
          <span class="lab-revision-outcome">${s.current.outcome}</span>
        </div>
        ${executed
          ? '<span class="micro-copy">実行済み</span>'
          : `
            <div class="lab-revision-actions">
              <button class="lab-toggle-btn ${!revised ? 'active' : ''}" data-keep="${s.slot}">通り</button>
              <button class="lab-toggle-btn ${revised ? 'active' : ''}" data-revise="${s.slot}">修正</button>
            </div>
            ${revised ? `
              <div class="lab-revision-edit">
                <button class="secondary-button" data-swap="${s.slot}" style="min-height:40px;padding:6px 10px;font-size:12px;">カードを入れ替え</button>
                <button class="lab-outcome-btn ${s.current.outcome === 'WIN' ? 'win' : 'lose'}" data-rev-outcome="${s.slot}" style="min-height:40px;">${s.current.outcome}</button>
              </div>
            ` : ''}
          `}
      </div>`;
  }).join('');

  showModal(`
    <div class="panel-title">プラン修正</div>
    <p class="micro-copy" style="margin-bottom:10px;">トリック ${S.currentTrickNo} まで実行済み。「修正」を選んだスロットだけ編集できます。</p>
    <div class="lab-revision-list">${html}</div>
    <div class="lab-modal-actions">
      <button class="secondary-button" id="rev-cancel" style="flex:1;min-height:48px;">キャンセル</button>
      <button class="primary-button" id="rev-apply" style="flex:1;min-height:48px;">確定</button>
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
    draft.slots[slot - 1].decision = 'REVISED';
    renderRevisionModal();
  });
  document.querySelectorAll('[data-rev-outcome]').forEach(b => b.onclick = () => {
    const slot = Number(b.dataset.revOutcome);
    const s = draft.slots[slot - 1];
    s.current.outcome = s.current.outcome === 'WIN' ? 'LOSE' : 'WIN';
    renderRevisionModal();
  });
  document.querySelectorAll('[data-swap]').forEach(b => b.onclick = () => {
    const slot = Number(b.dataset.swap);
    showSwapPicker(slot);
  });
  document.querySelector('#rev-cancel').onclick = () => {
    S.revisionDraft = null;
    closeModal();
    resumeFromPause();
  };
  document.querySelector('#rev-apply').onclick = () => { applyRevision(); };
}

function showSwapPicker(sourceSlot) {
  const draft = S.revisionDraft;
  if (!draft) return;
  const candidates = draft.slots
    .map((s, i) => ({ ...s, idx: i }))
    .filter(s => s.decision !== 'EXECUTED' && s.slot !== sourceSlot && s.current.card);

  if (!candidates.length) {
    toast('入れ替えできるカードがありません');
    return;
  }

  const html = candidates.map(s => `
    <button class="lab-swap-option" data-pick="${s.slot}">
      ${cardElHTML(s.current.card)}
      <span class="micro-copy">スロット ${s.slot}</span>
    </button>`).join('');

  showModal(`
    <div class="panel-title">スロット ${sourceSlot} と入れ替えるカードを選択</div>
    <div class="lab-swap-grid">${html}</div>
    <div class="lab-modal-actions">
      <button class="secondary-button" id="swap-cancel" style="flex:1;min-height:48px;">キャンセル</button>
    </div>`);

  document.querySelectorAll('[data-pick]').forEach(b => b.onclick = () => {
    const targetSlot = Number(b.dataset.pick);
    const target = draft.slots[sourceSlot - 1];
    const other = draft.slots[targetSlot - 1];
    const temp = { ...target.current };
    target.current = { ...other.current };
    other.current = { ...temp };
    renderRevisionModal();
  });
  document.querySelector('#swap-cancel').onclick = () => { renderRevisionModal(); };
}

function applyRevision() {
  const draft = S.revisionDraft;
  if (!draft) return;
  const revisedSlots = draft.slots.filter(s => s.decision === 'REVISED');
  if (!revisedSlots.length) {
    S.revisionDraft = null;
    closeModal();
    resumeFromPause();
    return;
  }
  showRevisionReasonModal(revisedSlots);
}

function showRevisionReasonModal(revisedSlots) {
  const categories = [
    ['opponent_unexpected', '相手が予想外の手'],
    ['void_discovered', '相手のボイド判明'],
    ['plan_card_illegal', 'プランカードが合法手にない'],
    ['plan_error', 'プランの誤り'],
    ['hand_change', '手札の状況変化'],
    ['other', 'その他'],
  ];

  showModal(`
    <div class="panel-title">修正の理由</div>
    <p class="micro-copy" style="margin-bottom:10px;">修正スロット: ${revisedSlots.map(s => s.slot).join(', ')}</p>
    <div class="lab-reason-list">
      ${categories.map(([k, label]) =>
        `<button class="lab-reason-btn" data-reason="${k}">${label}</button>`
      ).join('')}
    </div>
    <textarea id="rev-free" placeholder="具体的に（任意）" class="lab-textarea"></textarea>
    <div class="lab-modal-actions">
      <button class="secondary-button" id="rev-r-cancel" style="flex:1;min-height:48px;">キャンセル</button>
    </div>`);

  document.querySelectorAll('[data-reason]').forEach(b => b.onclick = () => {
    const reason = document.querySelector('#rev-free')?.value || '';
    finalizeRevision(b.dataset.reason, reason);
  });
  document.querySelector('#rev-r-cancel').onclick = () => { renderRevisionModal(); };
}

function finalizeRevision(trigger, reason) {
  const draft = S.revisionDraft;
  if (!draft) return;
  const revisedSlots = draft.slots.filter(s => s.decision === 'REVISED');
  const newSequence = draft.slots.map((s, i) => ({
    slot: i + 1,
    card: s.current.card,
    outcome: s.current.outcome,
  }));

  S.revisions.push({
    atTrickNo: S.currentTrickNo,
    originalPlan: S.currentPlan.sequence.map(s => ({
      slot: s.slot, card: s.card, outcome: s.outcome,
    })),
    revisedPlan: newSequence.map(s => ({
      slot: s.slot, card: s.card, outcome: s.outcome,
    })),
    slotRevisions: revisedSlots.map(s => ({
      slot: s.slot,
      decision: 'REVISED',
      from: s.original,
      to: s.current,
    })),
    trigger,
    reason,
  });
  S.currentPlan = { sequence: newSequence };
  S.revisionDraft = null;
  closeModal();
  renderWatchStep();
  resumeFromPause();
}

function renderReportStep(shell) {
  const r = S.report || computeReport();
  const plan = r.planExecution;
  const pred = r.outcomePrediction;
  const dep = r.deputyExpectation;

  shell.innerHTML = `
    <div class="game-screen nap-lab">
      <div class="lab-step-header">
        <button class="back-button" id="lab-finish">終了</button>
        <div class="lab-step-title">乖離レポート</div>
        <div style="width:60px;"></div>
      </div>
      <div class="lab-body">
        <div class="lab-report-card">
          <div class="panel-title">プラン実行</div>
          <p class="subcopy">一致: ${plan.matched}/${plan.total}トリック</p>
          ${plan.deviations.length
            ? `<p class="subcopy" style="color:#e89685;">逸脱: ${plan.deviations.map(d => d.seq + '（' + d.deviation.reason + '）').join(', ')}</p>`
            : ''}
        </div>

        <div class="lab-report-card">
          <div class="panel-title">結果予測</div>
          <p class="subcopy">WIN的中: ${pred.winHit}/${pred.winPred}</p>
          <p class="subcopy">LOSE的中: ${pred.loseHit}/${pred.losePred}</p>
          <p class="subcopy">精度: ${(pred.accuracy * 100).toFixed(1)}%</p>
        </div>

        <div class="lab-report-card">
          <div class="panel-title">副官期待の的中</div>
          <p class="subcopy">期待: ${dep.expected.length}枚 / 実際: ${dep.actual.length}枚</p>
          <p class="subcopy">的中: ${dep.hits.length}枚${dep.hitRate !== null ? '（' + (dep.hitRate * 100).toFixed(1) + '%）' : ''}</p>
        </div>

        <div class="lab-report-card">
          <div class="panel-title">プラン修正</div>
          <p class="subcopy">修正回数: ${r.revisions}回</p>
          ${S.revisions.map((rv, i) =>
            `<p class="micro-copy">#${i + 1} トリック${rv.atTrickNo}時点 / ${rv.trigger}</p>`
          ).join('')}
        </div>

        <div class="lab-report-card">
          <div class="panel-title">結果</div>
          <p class="subcopy">宣言 ${r.result.bid} / 獲得 ${r.result.finalNapPts} / ${r.result.made ? 'NAP WIN' : 'ALLY WIN'}</p>
        </div>
      </div>
      <div class="lab-bottom-bar">
        <button class="primary-button" id="lab-save-finish" style="flex:1;min-height:56px;">保存して終了</button>
      </div>
    </div>`;

  shell.querySelector('#lab-finish').onclick = () => closeNapPlanLab();
  shell.querySelector('#lab-save-finish').onclick = async () => {
    const btn = shell.querySelector('#lab-save-finish');
    if (btn) { btn.disabled = true; btn.textContent = '保存中…'; }
    await persistSessionRecord(r);
    closeNapPlanLab();
  };
}

function startWatch() {
  S.matchState = createMatchState(S.scenario, S.bid, S.discard, S.call, S.solo);
  S.currentTrickNo = 0;
  S.trickRecords = [];
  S.aborted = false;
  renderWatchStep();
  runWatchSimulation().catch(e => {
    console.error('[nap-plan-lab] simulation error:', e);
    renderError('シミュレーション中にエラー: ' + e.message);
  });
}

function showModal(innerHTML) {
  let m = document.getElementById('nap-lab-modal');
  if (!m) {
    m = document.createElement('div');
    m.id = 'nap-lab-modal';
    m.className = 'lab-modal-overlay';
    document.body.appendChild(m);
  }
  m.innerHTML = `<div class="lab-modal-card">${innerHTML}</div>`;
}

function closeModal() {
  const m = document.getElementById('nap-lab-modal');
  if (m) m.remove();
}

export function openNapPlanLabScreen() {
  const screenIds = [
    'home-screen', 'mode-select-screen', 'extra-menu-screen', 'profile-screen',
    'game-screen', 'records-screen', 'strategy-screen', 'quiz-screen',
    'training-screen', 'past-games-screen',
  ];
  screenIds.forEach(id => {
    const el = $(id);
    if (el) {
      el.classList.add('hidden');
      el.style.setProperty('display', 'none', 'important');
    }
  });

  let screen = $('nap-plan-lab-screen');
  if (!screen) {
    screen = document.createElement('section');
    screen.id = 'nap-plan-lab-screen';
    screen.className = 'screen nap-lab-screen';
    screen.innerHTML = `<div id="nap-plan-lab-shell"></div>`;
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
  if (S.pauseResolve) {
    const r = S.pauseResolve;
    S.pauseResolve = null;
    r();
  }
  closeModal();
  const screen = $('nap-plan-lab-screen');
  if (screen) {
    screen.classList.add('hidden');
    screen.style.setProperty('display', 'none', 'important');
  }
  const ms = $('mode-select-screen');
  if (ms) {
    ms.classList.remove('hidden');
    ms.style.removeProperty('display');
  }
}

function renderError(msg) {
  const shell = $('nap-plan-lab-shell');
  if (!shell) return;
  shell.innerHTML = `
    <div class="game-screen nap-lab">
      <div class="lab-body" style="padding:40px 20px;text-align:center;">
        <p style="color:#e89685;font-size:15px;line-height:1.6;">${escapeHTML(msg)}</p>
        <button class="primary-button" id="lab-error-close" style="margin-top:20px;min-height:48px;">モード選択へ戻る</button>
      </div>
    </div>`;
  document.getElementById('lab-error-close').onclick = closeNapPlanLab;
}

export function __debugState() { return JSON.parse(JSON.stringify(S)); }

export function __setScenarioForTest(handIds, kittyIds) {
  const hand10 = handIds.map(cardById);
  const openKitty = kittyIds.map(cardById);
  const remaining = buildDeck().filter(c =>
    !handIds.includes(c.id) && !kittyIds.includes(c.id)
  );
  const oppHands = [[], [], [], [], []];
  for (let i = 1; i < 5; i++) oppHands[i] = remaining.splice(0, 10);
  S.scenario = { seed: 0, hand10, openKitty, opponents: oppHands };
  S.step = 'scenario';
  renderStep();
}
