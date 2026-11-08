// ===== [app.js Part 1/3 開始] =====
import { matchRatingChanges, computeEloDelta, ELO_INIT, quantizeStrength, rankTierOf, trickPhaseOf, pointsTierOf, isSameColorSuit, sameColorSuitOf, hasBottomTie, PLAYOFF_MAX_ITERATIONS, PLAY_FREE_SECONDS, PLAY_POOL_SECONDS } from './constants.js';
import {
  shouldBid, chooseDiscard, chooseDeputyCall, chooseSoloCall, chooseCardWithMCTS, chooseDeputyCard,
  winningEntry, strongestSuit, colorStrength, ntHandStrength, chooseCardToPlay, handStrength,
  computeProperBid, bidPacing, canSendSignal, countSameColorBidders, detectPartnerSignal,
  isTwoRole, isThreeRole, getRoleCards, evaluateRiskTransfer, analyzeDiscardOptions,
  canDeclareWin,
  determineRole, decideNextBid, inferIntentFromBid, estimateDeputyDPoints,
  computeNScore, computeDScore, computeDPoints, computeSupportLimit
} from './ai-tactics.js';

// ============================================================
// Web Worker（MCTS並列計算 + N33 ホスト端末COM計算）
// ============================================================
const numWorkers = Math.max(2, Math.min(8, (navigator.hardwareConcurrency || 4) - 1));
const aiWorkers = [];
for (let i = 0; i < numWorkers; i++) {
  try { aiWorkers.push(new Worker('./ai-worker.js', { type: 'module' })); } catch (e) { console.warn('[Worker] init failed', e); }
}

const SUITS = ['♣', '♦', '♥', '♠'];
const SV = { '♣': 1, '♦': 2, '♥': 3, '♠': 4, 'NT': 5 };
const RANKS = ['2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K', 'A'];
const FACE = ['10', 'J', 'Q', 'K', 'A'];
const POINT = ['10', 'J', 'Q', 'K', 'A'];
const $ = id => document.getElementById(id);

// ============================================================
// グローバル状態
// ============================================================
const g = {
  round: 1, rate: 1000, comRate: 1000, elo: ELO_INIT, mult: 1, botLevel: 3,
  aiWeights: {
    bidThreshold: 3.5, riskTolerance: 0.5, leadAggression: 0.6, followAggression: 0.4, trumpBonus: 0.6,
    mightyBonus: 2.0, safeAceWeight: 0.7, roleCardPreservation: 0.6, deputyFeedBias: 0.5,
    opponentInferenceWeight: 0.4, suitConflictWeight: 0.6, mightyShadowWeight: 0.3,
    weakOpponentBoost: 0.3, bluffLossMultiplier: 0.6, cooperationBonus: 0.5,
    ntPreference: 0.85, ntSuitLengthBonus: 1.2, ntAceWeight: 1.5, ntMightyBonus: 2.5,
    highBidNtThreshold: 17, aceWeakSuitBonus: 0.3, aceShortBonus: 0.15, aceLongPenalty: 0.15,
    sameTwoAceCounter: 0.3, sameTwoShortBonus: 0.4, sameTwoLongPenalty: 0.25, sameTwoHighBidBonus: 0.2,
    trumpExhaustionThreshold: 3, baitModeWindow: 2, baitMinTrumps: 4, strongTrumpLeadAggression: 0.7,
    aceCashUrgency: 1.0, pointCardSafetyThreshold: 0.5, tenHoldThreshold: 0.6, nonTrumpAceWaiting: 0.5,
    baitBackJWindow: 3, baitBackJChance: 0.6, faceCardOnNapWin: 0.9, preserveNextStronger: 0.9,
    deputyRevealUrgency: 0.5, deputyCoverWeight: 0.5, sameTwoDeputyBonus: 0.5, allyFaceCardBonus: 0.9,
    napWeaknessLeadWeight: 0.8, trumpAvoidWeight: 0.9, sameColorSuitAvoid: 0.8, spadeLeadPriority: 0.7,
    nonDeclaredSuitWeight: 0.6, queenHoardWeight: 0.6, sameTwoHoardWeight: 0.5, allyYieldBonus: 0.5,
    allySameTwoLeadChance: 0.55, allySameTwoWindow: 4,
    teamCooperationWeight: 1.5, feedBonusWeight: 1.0, overkillPenalty: 1.0,
    mctsSimulations: 150, mctsExploration: 1.414, handInferenceWeight: 0.5, rolloutPolicyWeight: 0.8,
    bayesUpdateRate: 0.05,
    ntMightyHoldThreshold: 8, ntMightyShadowWeight: 1.5, ntAceLeadPriority: 1.2, ntVoidExploitWeight: 1.5,
    ntDeputyFeedChance: 0.8, ntEarlyLeadAggression: 0.7, ntLateGameSafety: 1.0,
    ntAceProtectLeadWeight: 1.5, ntSameTwoGuardWeight: 1.2, allyVoidExploitWeight: 1.0,
    deputyBluffWeight: 0.8, ntDeputyMightyHoldThreshold: 8, ntMightyEmergencyTrick: 5,
    napEarlyTrumpLeadWeight: 1.5, napEarlyTrumpLeadMaxTrick: 3, napEarlyTrumpMinCount: 4,
    deputyOvertrumpWeight: 1.8,
    bidTimeBudgetMs: 400, bidMaxSamples: 500, bidSafetyMargin: 0.5, bidSimCount: 30,
    planAccuracyWeight: 1.0, overbidPenalty: 2.0, underbidPenalty: 0.5, planAccuracyBonus: 1.5,
    bidPacingMs: 4000, bidStartValue: 13,
    tossUpSafetyMargin: 0.5, tossUpSafetyMarginBottom: 0.0,
    signalS1Bonus: 1, signalS2Bonus: 2, signalThreeRoleBonus: 4, signalS3Bonus: 2,
    s1RequiredMinorCards: 2, s3RequiredAces: 2,
    sameColorBidderLimit: 2, ntBidderLimit: 2, s2ThreeRoleExtra: 1,
    voidStrategyWeight: 1.0, isolatedFaceDiscardBonus: 0.6, trumpCountForVoid: 5,
    lowBidVoidPenalty: 1.5, midBidVoidPenalty: 0.5, highBidVoidBonus: 0.8,
    voidLeadProbability: 0.55, cutTrickValue: 2.0, isolatedFaceThreshold: 2,
    ntVoidPenalty: 3.0, ntHighBidVoidBonus: 1.5,
    napRoleThreshold1: 22, napRoleThreshold2: 17, napRoleThreshold3: 13,
    deputyRoleThreshold1: 12, deputyRoleThreshold2: 8, deputyRoleThreshold3: 5,
    supportLimitWeight: 0.7, supportLimitDivisor: 2,
    sameSuitRaiseBonus: 1.0, sameColorSupportBonus: 0.8, sameColorSameBidBonus: 0.5, crossColorCompeteBonus: 0.3,
    auctionObservationMs: 2000, auctionRiskTolerance: 0.5, bidStepwiseAggression: 0.6,
    weightBidGap: 3.0, weightBidAccuracy: 2.0, weightDeputySignal: 3.0, weightStageCount: 1.0, weightRoleAccuracy: 2.0
  },
  players: [], kitty: [], discardedKitty: [], allianceKittyPoints: 0,
  auction: null, contract: null, trick: [], trickNo: 0, points: [0, 0, 0, 0, 0],
  matchScores: [0, 0, 0, 0, 0], matchArt: [0, 0, 0, 0, 0],
  matchStats: [], matchContracts: [],
  playoff: false, playoffCount: 0, appealInfo: '',
  roundArt: [0, 0, 0, 0, 0],
  phase: '', bid: 13, suit: '♠', timer: [],
  greenRedraws: 0, selectedCard: null, onlineSelectedCard: null,
  user: null, account: null, sessionToken: null,
  room: null, presenceRoom: null, online: null,
  leaderboardExpanded: false,
  announcedCallRound: null, announcedRound: null,
  localLog: null, matchDebugLog: null,
  playedCards: [], voids: [{}, {}, {}, {}, {}],
  aiExperience: null, humanRoundLog: null,
  waitingAutoPlay: false, autoNextTimer: null,
  reconnecting: false, intentionalLeave: false,
  onlineState: null, privateHand: [], onlineLegal: [],
  mySeat: 0, onlineBid: 13, onlineSuit: '♠', onlineRank: 'A',
  onlineDiscard: new Set(), countdownTimer: null, discard: new Set(), onlineResultTimer: null,
  confirmedCall: false, lastDiscardPhase: false, lastCallPhase: false,
  friendLobby: null,
  turnTimerRAF: null, turnTimerDeadline: null,
  bidHistory: [], winDeclaration: null,
  bidSignals: Array.from({ length: 5 }, () => ({ sent: null, received: [], sameColorCount: 0, lastBidAt: 0 })),
  properBids: [13, 13, 13, 13, 13],
  properPlans: [null, null, null, null, null],
  auctionStartAt: 0,
  // ★ N40: プレイフェーズ時間制限プール（ローカル/オンライン共通表示）
  playPools: [20, 20, 20, 20, 20],
  turnStartAt: 0,
  deadline: 0,
  // ★ A1: チャット
  chatLog: [],
  // ★ A2: ハイロー
  hilo: { current: null, next: null, streak: 0, best: 0, waiting: false, started: false },
  // ★ L2: 待機開始時刻
  queueStartedAt: 0,
  // ★ R7: 同接者
  presenceCount: 0,
  // ★ N33: ホスト端末COM計算用
  hostKeySet: false,
};
let toastTimer;
let lastAuctionDrawHash = '';
try { g.hilo.best = parseInt(localStorage.getItem('napoleon_hilo_best') || '0') || 0; } catch {}

// ============================================================
// ユーティリティ
// ============================================================
function safeJsonParse(str, fallback = null) {
  try { if (typeof str !== 'string' || !str.trim()) return fallback; return JSON.parse(str); }
  catch (e) { return fallback; }
}
function sanitizeMessage(msg) { return String(msg == null ? '' : msg).replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ').slice(0, 500); }
async function readResponse(res) {
  const text = await res.text().catch(() => '');
  let data = null, parseError = null;
  try { data = text ? JSON.parse(text) : null; } catch (e) { parseError = e; }
  return { data, text, parseError, ok: res.ok, status: res.status };
}
function escapeHTML(value) { return String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }

function toast(t) { const e = $('toast'); if (!e) return; e.textContent = t; e.classList.add('show'); clearTimeout(toastTimer); toastTimer = setTimeout(() => e.classList.remove('show'), 2600); }

function screen(id) {
  ['home-screen', 'mode-select-screen', 'profile-screen', 'game-screen', 'records-screen', 'strategy-screen', 'quiz-screen', 'training-screen', 'past-games-screen'].forEach(x => {
    const el = $(x);
    if (el) {
      if (x === id) { el.classList.remove('hidden'); el.style.removeProperty('display'); }
      else { el.classList.add('hidden'); el.style.setProperty('display', 'none', 'important'); }
    }
  });
  if (id === 'mode-select-screen') { loadLeaderboard(); loadAccount(); startPresence(); }
  if (id === 'strategy-screen') loadStrategyLab();
  if (id === 'past-games-screen') openPastGamesScreen();
  if (id !== 'game-screen') stopTurnTimer();
}

function startPresence() {
  if (g.presenceRoom || !window.WebsimSocket?.joinRoom) return;
  const pending = window.WebsimSocket.joinRoom();
  g.presenceRoom = pending;
  pending.then(room => {
    if (g.presenceRoom !== pending) { room.close?.(); return; }
    g.presenceRoom = room;
    room.onmessage = e => { let m; try { m = JSON.parse(e.data); } catch { return; } if (m.type === 'presence') { g.presenceCount = m.count; const el = $('concurrent-count'); if (el) el.textContent = '同接: ' + m.count + '人'; } };
  }).catch(() => { if (g.presenceRoom === pending) g.presenceRoom = null; });
}
async function stopPresence() { const current = g.presenceRoom; g.presenceRoom = null; try { (await current)?.close?.(); } catch {} }

function later(fn, ms) { const t = setTimeout(fn, ms); g.timer.push(t); return t; }
function clearTimers() { g.timer.forEach(clearTimeout); g.timer = []; }

function closeOnline() {
  g.intentionalLeave = true;
  clearTimers();
  clearInterval(g.countdownTimer); g.countdownTimer = null;
  clearInterval(g.onlineResultTimer); // ★ B7: clearInterval
  clearTimeout(g.auction?.humanTimeout);
  clearInterval(g.autoNextTimer);
  stopTurnTimer();
  g.room?.close?.();
  g.room = null; g.online = null; g.onlineState = null;
  g.privateHand = []; g.onlineLegal = []; g.onlineSelectedCard = null;
  g.friendLobby = null; g.mySeat = 0; g.hostKeySet = false;
  hideQueuePanel();
  hideWaitingBanner();
  const ac = $('auction-clock'); if (ac) ac.classList.add('hidden');
  setTimeout(() => { g.intentionalLeave = false; }, 600);
}

function message(t) { const el = $('table-message'); if (el) el.textContent = t; }

function addGameLog(text) {
  if (!g.localLog) g.localLog = [];
  g.localLog.push({ round: g.round, text });
  if (g.localLog.length > 300) g.localLog.shift();
  const cnt = $('game-log-count'); if (cnt) cnt.textContent = String(g.localLog.length);
  if ($('game-log-dialog')?.open) renderGameLog();
}
function renderGameLog() {
  const list = $('game-log-list'); if (!list) return;
  list.innerHTML = g.localLog?.length
    ? g.localLog.map(entry => '<article class="game-log-entry"><small>第' + entry.round + '局</small><span>' + escapeHTML(entry.text) + '</span></article>').join('')
    : '<p class="game-log-empty">まだログはありません</p>';
  list.scrollTop = list.scrollHeight;
}
function openGameLog() { renderGameLog(); $('game-log-dialog')?.showModal(); }

function addDebugLog(type, data) {
  if (!g.matchDebugLog) g.matchDebugLog = [];
  const entry = { t: Date.now(), type };
  if (data && typeof data === 'object') { for (const k in data) { try { entry[k] = data[k]; } catch {} } }
  g.matchDebugLog.push(entry);
  if (g.matchDebugLog.length > 3000) g.matchDebugLog.shift();
}
function sanitizeForLog(obj, depth = 0) {
  if (depth > 6) return '[deep]';
  if (obj === null || obj === undefined) return obj;
  const t = typeof obj;
  if (t === 'function') return '[fn]';
  if (t === 'string' || t === 'number' || t === 'boolean') return obj;
  if (Array.isArray(obj)) return obj.map(x => sanitizeForLog(x, depth + 1));
  if (t === 'object') { const out = {}; for (const k in obj) { try { out[k] = sanitizeForLog(obj[k], depth + 1); } catch { out[k] = '[err]'; } } return out; }
  return String(obj);
}
function buildLogPayload() {
  const contract = g.contract ? { nap: g.contract.nap, num: g.contract.num, suit: g.contract.suit, deputy: g.contract.deputy, solo: g.contract.solo, call: g.contract.call, revealedCall: g.contract.revealedCall, revealTrickNo: g.contract.revealTrickNo, strengthAtBid: g.contract.strengthAtBid, bidPlan: g.contract.bidPlan } : null;
  return {
    version: 'v1.7', timestamp: new Date().toISOString(), userAgent: navigator.userAgent, url: location.href,
    phase: g.phase, round: g.round, botLevel: g.botLevel, aiWeights: sanitizeForLog(g.aiWeights),
    account: g.account ? { id: g.account.id, rating: g.account.rating, com_rating: g.account.com_rating } : null,
    contract, allianceKittyPoints: g.allianceKittyPoints,
    players: (g.players || []).map((p, i) => ({ seat: i, name: p.name, bot: p.bot, handCount: p.hand?.length ?? 0, roundPoints: p.roundPoints ?? 0, taken: (p.taken || []).map(c => c.id) })),
    kitty: (g.kitty || []).map(c => c.id), discardedKitty: (g.discardedKitty || []).map(c => c.id),
    matchScores: g.matchScores, matchArt: g.matchArt, matchContracts: g.matchContracts, bidHistory: g.bidHistory,
    bidSignals: sanitizeForLog(g.bidSignals), properBids: g.properBids,
    trickNo: g.trickNo, trick: (g.trick || []).map(e => ({ seat: e.player, card: e.card?.id })),
    playedCards: g.playedCards, voids: g.voids, localLog: g.localLog, debugLog: g.matchDebugLog, humanRoundLog: g.humanRoundLog
  };
}
function downloadLog() {
  try {
    const payload = buildLogPayload();
    const json = JSON.stringify(payload, null, 2);
    const blob = new Blob([json], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    a.href = url; a.download = 'napoleon-log-' + ts + '.json';
    document.body.appendChild(a); a.click();
    setTimeout(() => { document.body.removeChild(a); URL.revokeObjectURL(url); }, 100);
    toast('ログをダウンロードしました');
  } catch (e) { console.error('download failed', e); toast('ダウンロードに失敗しました: ' + e.message); }
}
function logPlayDecision(seat, card, reasonInfo, context) {
  try { addDebugLog('play-decision', { seat, round: g.round, trickNo: g.trickNo, card: card?.id, reason: reasonInfo?.reason, detail: sanitizeForLog(reasonInfo?.detail), context: sanitizeForLog(context) }); }
  catch (e) { addDebugLog('play-decision-log-error', { message: e?.message }); }
}
function buildPlayContext(seat) {
  return {
    hand: (g.players[seat]?.hand || []).map(c => c.id), trick: (g.trick || []).map(x => ({ seat: x.player, card: x.card?.id })),
    contract: g.contract ? { nap: g.contract.nap, num: g.contract.num, suit: g.contract.suit, solo: g.contract.solo, deputy: g.contract.deputy, call: g.contract.call, revealedCall: g.contract.revealedCall } : null,
    aiWeights: g.aiWeights, points: g.points.slice(), roundPoints: g.players.map(p => p.roundPoints || 0),
    matchScores: g.matchScores.slice(), voids: g.voids, playedCards: g.playedCards, discardedKitty: g.discardedKitty || []
  };
}

function phase(t) {
  const roundTag = g.playoff ? 'プレーオフ · ' : g.round === 9 ? 'ラス前 · ' : g.round >= 10 ? 'オールラスト · ' : '';
  const pl = $('phase-label'); if (pl) pl.textContent = roundTag + t;
  const gs = $('game-screen'); if (gs) gs.classList.toggle('auctioning', g.phase === 'auction');
  renderContractInfo();
}

function name(i) {
  if ((g.onlineState && g.room) && i === g.mySeat) return 'あなた';
  if (!(g.onlineState && g.room) && i === 0) return 'あなた';
  const p = g.players[i];
  if (!p) return 'COM ' + i;
  if (p.abandoned) return (p.originalName || p.username || p.name || ('COM ' + i)) + ' (放棄)';
  let n = p.username || p.name || ('COM ' + i);
  if (n === 'ゲスト' || n === 'プレイヤー' || n === 'player' || n === 'COM' || !n) n = 'ゲスト(席' + i + ')';
  return n;
}

function color(s) { return s === '♥' || s === '♦' ? 'red' : ''; }
function cardEl(c, extra) {
  const e = document.createElement('div');
  e.className = 'card ' + (c ? color(c.suit) : '') + ' ' + (extra || '');
  if (c) e.innerHTML = '<span class="rank">' + c.rank + '</span><span class="suit">' + c.suit + '</span>';
  return e;
}

function renderContractInfo() {
  const box = $('contract-info'); if (!box) return;
  const contract = g.contract;
  if (contract) {
    box.classList.remove('hidden');
    const parts = [];
    const bid = document.createElement('strong'); bid.className = 'contract-bid'; bid.textContent = '宣言 ' + contract.num + contract.suit; parts.push(bid);
    const label = document.createElement('span'); label.className = 'contract-call-label'; label.textContent = '副官札'; parts.push(label);
    if (contract.call) parts.push(cardEl(contract.call, 'contract-card'));
    else { const pending = document.createElement('span'); pending.className = 'contract-pending'; pending.textContent = '指名前'; parts.push(pending); }
    const revealedKitty = (g.discardedKitty || []).filter(c => FACE.includes(c.rank));
    if (g.phase !== 'auction' && g.phase !== 'prep' && g.phase !== 'appeal-offer' && g.phase !== 'appeal-response' && g.phase !== 'redeal') {
      if (revealedKitty.length > 0) {
        const kittyLabel = document.createElement('span'); kittyLabel.className = 'contract-call-label'; kittyLabel.textContent = '捨て札'; parts.push(kittyLabel);
        const kittyWrap = document.createElement('div'); kittyWrap.className = 'contract-kitty-cards';
        revealedKitty.forEach(c => kittyWrap.append(cardEl(c, 'contract-kitty-card')));
        parts.push(kittyWrap);
      }
    }
    if (contract.solo && contract.revealedCall) { const solo = document.createElement('span'); solo.className = 'contract-call-label'; solo.textContent = 'ひとり立ち'; parts.push(solo); }
    box.replaceChildren(...parts);
    return;
  }
  box.classList.add('hidden'); box.replaceChildren();
}

function showOpenKitty() {
  const label = document.createElement('span'); label.className = 'open-label'; label.textContent = 'オープン';
  const el = $('kitty-view'); if (el) { el.classList.remove('hidden'); el.replaceChildren(label, ...g.kitty.map(c => cardEl(c))); }
}
function showDiscardedKitty() { const el = $('kitty-view'); if (el) { el.classList.add('hidden'); el.replaceChildren(); } }

function deck() {
  let d = [];
  SUITS.forEach(s => RANKS.forEach(r => d.push({ suit: s, rank: r, id: s + r })));
  for (let i = d.length - 1; i > 0; i--) { let j = Math.floor(Math.random() * (i + 1));[d[i], d[j]] = [d[j], d[i]]; }
  return d;
}
function sort(h) { h.sort((a, b) => SV[b.suit] - SV[a.suit] || RANKS.indexOf(b.rank) - RANKS.indexOf(a.rank)); }

function soloMinimumBid(gap, mult) { return 13 + Math.floor(Math.max(0, gap) / (10 * Math.max(1, mult))); }
function fmtMinBid(r) { if (!r) return '—'; if (!r.achievable) return '不可'; return Math.min(20, r.rawMin) + '枚'; }
function fmtSoloMinBid(v) { return v > 20 ? '不可' : Math.min(20, v) + '枚'; }

function computeTeamMinBid(scores, mult, napSeat, deputySeat) {
  const ranked = scores.map((s, i) => ({ s, i })).sort((a, b) => a.s - b.s || a.i - b.i);
  const S5 = ranked[0].s, S4 = ranked[1].s, S3 = ranked[2].s;
  const bottomSeat = ranked[0].i, fourthSeat = ranked[1].i;
  const m = Math.max(1, mult);
  const f = (gap, denom) => Math.floor(Math.max(0, gap) / denom);
  if (napSeat === bottomSeat && deputySeat === fourthSeat) {
    const a = 13 + f(S3 - S5, 6 * m), b = 13 + f(S3 - S4, 4 * m), raw = Math.max(a, b), achievable = raw <= 20;
    return { minBid: Math.min(20, raw), rawMin: raw, canOvertake: achievable, achievable, incentiveBroken: !achievable, soloRequired: false, case: 'A', details: { S3, S4, S5, needNapOverThird: a, needDeputyOverThird: b } };
  }
  if (napSeat === fourthSeat && deputySeat === bottomSeat) {
    const a = 13 + f(S3 - S4, 6 * m), b = 13 + f(S3 - S5, 4 * m), c = 13 + f(S4 - S5, 2 * m), raw = Math.max(a, b, c);
    return { minBid: Math.min(20, raw), rawMin: raw, canOvertake: raw <= 20, achievable: raw <= 20, incentiveBroken: a > 20 || b > 20, soloRequired: false, case: 'B', details: { S3, S4, S5, needNapOverThird: a, needDeputyOverThird: b, needDeputyOverNapOnLoss: c } };
  }
  if ((napSeat === bottomSeat && deputySeat !== fourthSeat) || (napSeat === fourthSeat && deputySeat !== bottomSeat)) {
    const raw = 13 + f(S4 - S5, 6 * m);
    return { minBid: Math.min(20, raw), rawMin: raw, canOvertake: raw <= 20, achievable: raw <= 20, incentiveBroken: false, soloRequired: false, case: 'C', details: { S3, S4, S5, needNapOverFourth: raw } };
  }
  return null;
}

function isSoloForced() {
  if (g.round < 10 || !g.contract) return false;
  const ranked = g.matchScores.map((s, i) => ({ s, i })).sort((a, b) => a.s - b.s || a.i - b.i);
  const bottomSeat = ranked[0].i; if (g.contract.nap !== bottomSeat) return false;
  const fourthSeat = ranked[1].i;
  const r = computeTeamMinBid(g.matchScores, g.mult, bottomSeat, fourthSeat);
  return r?.soloRequired === true;
}

function isSafeToCashAce(suit, seat) {
  if (!g.contract) return false;
  if (suit === '♠') return true;
  if (g.trickNo > 0) {
    const twoPlayed = g.playedCards.some(c => c.id === suit + '2') || (g.discardedKitty || []).some(c => c.id === suit + '2');
    if (!twoPlayed) {
      const anyVoid = [0, 1, 2, 3, 4].some(s => s !== seat && g.voids[s] && g.voids[s][suit]);
      if (!anyVoid) return false;
    }
  }
  if (g.contract.suit !== 'NT' && g.contract.suit !== suit) {
    for (let s = 0; s < 5; s++) {
      if (s === seat) continue;
      if (g.contract.revealedCall) { if (s === g.contract.nap || (!g.contract.solo && s === g.contract.deputy)) continue; }
      else { if (s === g.contract.nap) continue; }
      if (g.voids[s] && g.voids[s][suit]) return false;
    }
  }
  return true;
}

async function loadTopStrategy() {
  try {
    const res = await fetch('/api/ai/top-strategy');
    if (!res.ok) return;
    const { data } = await readResponse(res);
    if (data && data.strategy && typeof data.strategy === 'object') {
      for (const [k, v] of Object.entries(data.strategy)) if (typeof v === 'number' && Number.isFinite(v)) g.aiWeights[k] = v;
    }
  } catch (e) { /* ignore */ }
}
async function loadExperience() {
  try {
    const res = await fetch('/api/ai/experience');
    if (!res.ok) return;
    const { data } = await readResponse(res);
    if (data && typeof data === 'object') g.aiExperience = data;
  } catch (e) { /* ignore */ }
}

function sendRoundLearn(wonRound) {
  try {
    if (!g.humanRoundLog) return;
    const payload = { round: g.round, wonRound: wonRound === true, bid: g.humanRoundLog.bid || null, call: g.humanRoundLog.call || null, playDecisions: (g.humanRoundLog.playDecisions || []).filter(d => d.won !== null) };
    if (!payload.bid && !payload.call && !payload.playDecisions.length) return;
    fetch('/api/ai/learn', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) }).then(() => loadExperience()).catch(() => { });
  } catch (e) { /* ignore */ }
}

// ============================================================
// ターンタイマー（N40: プール残量UI）
// ============================================================
function startTurnTimer(deadlineMs, force = false) {
  if (!deadlineMs) { stopTurnTimer(); return; }
  const bar = $('turn-timer-bar'), fill = $('turn-timer-fill'), text = $('turn-timer-text');
  if (!bar || !fill) return;
  const now = Date.now();
  const remaining = Math.max(0, deadlineMs - now);
  const total = Math.max(30000, remaining);
  if (!force && g.turnTimerRAF && g.turnTimerDeadline && Math.abs(g.turnTimerDeadline - deadlineMs) < 200) return;
  stopTurnTimer();
  g.turnTimerDeadline = deadlineMs;
  bar.classList.remove('hidden');
  const end = deadlineMs;
  const tick = () => {
    const r = Math.max(0, end - Date.now());
    const pct = Math.min(100, (r / total) * 100);
    fill.style.width = pct + '%';
    fill.classList.toggle('warning', pct < 50 && pct >= 20);
    fill.classList.toggle('danger', pct < 20);
    if (text) {
      // ★ N40: プール残量表示
      const isPlayPhase = g.phase === 'play';
      const mySeat = (g.onlineState && g.room) ? g.mySeat : 0;
      const pool = isPlayPhase ? (g.playPools?.[mySeat] ?? 20) : null;
      const sec = Math.ceil(r / 1000);
      text.textContent = (pool != null && isPlayPhase) ? `${sec}s (プール${pool.toFixed(0)}s)` : `${sec}s`;
    }
    if (r <= 0) { stopTurnTimer(); return; }
    g.turnTimerRAF = requestAnimationFrame(tick);
  };
  tick();
}
function stopTurnTimer() {
  if (g.turnTimerRAF) { cancelAnimationFrame(g.turnTimerRAF); g.turnTimerRAF = null; }
  g.turnTimerDeadline = null;
  const bar = $('turn-timer-bar');
  if (bar) bar.classList.add('hidden');
}
function syncTurnTimer() {
  const mySeat = (g.onlineState && g.room) ? g.mySeat : 0;
  if (g.phase === 'play' && g.active === mySeat) {
    const dl = (g.onlineState && g.room) ? g.onlineState?.deadline : g.deadline;
    if (dl) startTurnTimer(dl, true);
    return;
  }
  if (g.phase === 'auction' && g.auction?.active?.includes(mySeat)) {
    if (!g.turnTimerRAF) startTurnTimer(Date.now() + 30000);
    return;
  }
  stopTurnTimer();
}
function resetAuctionTimer() {
  const mySeat = (g.onlineState && g.room) ? g.mySeat : 0;
  if (g.phase === 'auction' && g.auction?.active?.includes(mySeat)) {
    startTurnTimer(Date.now() + 30000, true);
  }
}

// ============================================================
// ダイアログ
// ============================================================
function dialog(title, text, cb) {
  let d = $('message-dialog'), card = $('dialog-card');
  if (!d || !card) return;
  document.querySelectorAll('dialog[open]').forEach(dlg => { try { if (dlg !== d) dlg.close(); } catch { } });
  try { if (d.open) d.close(); } catch { }
  card.classList.add('hidden'); card.replaceChildren();
  const de = $('dialog-eyebrow'); if (de) { de.classList.remove('hidden'); de.textContent = 'Napoleon'; }
  const dok = $('dialog-ok'); if (dok) dok.textContent = 'OK';
  const dt = $('dialog-title'), db = $('dialog-body');
  if (dt) dt.textContent = title; if (db) db.textContent = text;
  if (dok) dok.onclick = () => { d.close(); if (cb) cb(); };
  try { d.showModal(); } catch (e) { console.warn('[dialog]', e?.message); }
}

// ============================================================
// ローカルCOM戦：開始（N6/N18/N23修正）
// ============================================================
function startLocal() {
  g.onlineState = null;
  g.room = null;
  g.online = null;
  g.intentionalLeave = true;

  if (!g.friendLobby) closeOnline();
  else {
    clearTimers();
    clearInterval(g.countdownTimer); g.countdownTimer = null;
    clearInterval(g.onlineResultTimer);
    clearTimeout(g.auction?.humanTimeout);
    clearInterval(g.autoNextTimer);
  }

  // ★ N18: auction.humanTimeout クリア
  clearTimeout(g.auction?.humanTimeout);
  // ★ N6: countdownTimer クリア
  clearInterval(g.countdownTimer); g.countdownTimer = null;
  // ★ N23: chatLog クリア
  g.chatLog = [];

  g.privateHand = []; g.onlineLegal = []; g.mySeat = 0;
  g.lastRating = null; g.confirmedCall = false; g.lastDiscardPhase = false; g.lastCallPhase = false;
  g.selectedCard = null; g.active = -1; g.bid = 13; g.suit = '♠'; g.discard = new Set();
  g.winDeclaration = null;
  g.deadline = 0; // ★ N8/N19
  stopTurnTimer();

  g.matchDebugLog = [];
  addDebugLog('match-start', { botLevel: g.botLevel, aiWeights: sanitizeForLog(g.aiWeights) });
  loadTopStrategy();
  g.aiExperience = null;
  loadExperience();
  g.localLog = [];
  const openLogBtn = $('game-log-open'); if (openLogBtn) openLogBtn.classList.remove('hidden');
  const logCnt = $('game-log-count'); if (logCnt) logCnt.textContent = '0';
  g.botLevel = 3;
  g.round = 1;
  g.rate = Number.isFinite(Number(g.account?.rating)) ? Number(g.account.rating) : 1000;
  g.comRate = Number.isFinite(Number(g.account?.com_rating)) ? Number(g.account.com_rating) : 1000;
  g.elo = g.rate;
  g.mult = 1;
  g.greenRedraws = 0;
  g.playoff = false; // ★ N4
  g.playoffCount = 0;
  g.appealInfo = '';
  g.announcedRound = null;
  g.matchScores = Array(5).fill(0);
  g.matchArt = Array(5).fill(0);
  g.matchContracts = [];
  g.bidHistory = [];
  g.lastTrickWinner = null;
  g.playedCards = [];
  g.voids = [{}, {}, {}, {}, {}];
  g.discardedKitty = [];
  g.allianceKittyPoints = 0;
  g.waitingAutoPlay = false;
  clearInterval(g.autoNextTimer);
  g.matchStats = Array.from({ length: 5 }, () => ({ declarerAttempts: 0, declarerSuccesses: 0, exactAttempts: 0, exactSuccesses: 0, boldAttempts: 0, boldSuccesses: 0, soloAttempts: 0, soloSuccesses: 0, deputyAttempts: 0, deputySuccesses: 0, artAttempts: 0, dramaticPlays: 0, allyFeedAttempts: 0, allyFeedSuccesses: 0, bidTotal: 0 }));
  g.players = Array.from({ length: 5 }, (_, i) => ({ name: i ? 'COM ' + i : 'あなた', username: i ? 'COM ' + i : 'あなた', originalName: i ? 'COM ' + i : 'あなた', abandoned: false, bot: i > 0, hand: [], taken: [], roundTaken: [], roundPoints: 0 }));
  g.playPools = [20, 20, 20, 20, 20]; // ★ N40
  g.turnStartAt = 0;
  screen('game-screen');
  const modeLabel = $('game-mode-label'); if (modeLabel) modeLabel.textContent = 'COM戦';
  const ratCap = $('rating-caption'); if (ratCap) ratCap.textContent = 'COM RATE';
  const ratLab = $('rating-label'); if (ratLab) ratLab.textContent = g.comRate;

  setTimeout(() => { g.intentionalLeave = false; }, 1000);
  roundStart();
}

function roundStart() {
  clearTimers();
  clearTimeout(g.auction?.humanTimeout);
  clearInterval(g.autoNextTimer);
  g.waitingAutoPlay = false;
  g.active = -1;
  g.lastTrickWinner = null;
  g.phase = 'deal';
  g.contract = null;
  g.trick = []; g.trickNo = 0;
  g.points = [0, 0, 0, 0, 0];
  g.roundArt = Array(5).fill(0);
  g.playedCards = []; g.voids = [{}, {}, {}, {}, {}];
  g.discardedKitty = [];
  g.allianceKittyPoints = 0;
  g.discard = new Set();
  g.selectedCard = null;
  g.bidHistory = [];
  g.winDeclaration = null;
  g.bidSignals = Array.from({ length: 5 }, () => ({ sent: null, received: [], sameColorCount: 0, lastBidAt: 0 }));
  g.properBids = [13, 13, 13, 13, 13];
  g.properPlans = [null, null, null, null, null];
  g.auctionStartAt = 0;
  g.playPools = [20, 20, 20, 20, 20]; // ★ N40
  g.turnStartAt = 0;
  g.deadline = 0;
  stopTurnTimer();
  $('game-screen')?.classList.remove('discarding');
  $('hand')?.classList.remove('discard-mode');
  g.humanRoundLog = { round: g.round, bid: null, call: null, playDecisions: [] };
  g.players.forEach(p => { p.roundTaken = []; p.roundPoints = 0; });
  addGameLog('配札');
  const roundLab = $('round-label'); if (roundLab) roundLab.textContent = g.round;
  $('auction-panel')?.classList.add('hidden');
  $('call-panel')?.classList.add('hidden');
  $('play-panel')?.classList.add('hidden');
  $('result-panel')?.classList.add('hidden');
  $('trick-cards')?.replaceChildren();
  $('kitty-view')?.replaceChildren();
  $('auction-clock')?.classList.add('hidden');
  let d = deck();
  g.players.forEach(p => { p.hand = d.splice(0, 10); p.taken = []; sort(p.hand); });
  g.kitty = d.splice(0, 2);
  renderHand(); drawSeats();
  phase('配札');
  message('手札を確認しています');
  later(checkGreen, 900);
}

// ★ N16: checkGreen のフェーズ統一
function checkGreen() {
  let i = g.players.findIndex(p => !p.hand.some(c => FACE.includes(c.rank)));
  if (i >= 0 && g.greenRedraws < 5) {
    if (i === 0) {
      phase('配札');
      message('10・J・Q・K・Aがありません。公開して配り直しますか？');
      const pp = $('play-panel');
      if (pp) {
        pp.classList.remove('hidden');
        pp.innerHTML = '<div class="panel-title">手札に10・J・Q・K・Aがありません</div><div class="panel-row"><button class="small-action" id="green-ok">公開して配り直す</button><button class="small-action pass" id="green-skip">続ける</button></div>';
        $('green-ok').onclick = () => greenRedraw('あなた');
        $('green-skip').onclick = () => { pp.classList.add('hidden'); prepAuction(); };
      }
      return;
    }
    greenRedraw(name(i));
    return;
  }
  prepAuction();
}

function greenRedraw(n) {
  addGameLog(n + 'の手札条件により配り直し');
  g.greenRedraws++;
  g.mult = g.mult + 1;
  $('play-panel')?.classList.add('hidden');
  const d = $('message-dialog');
  if (!d) return;
  const dt = $('dialog-title'), db = $('dialog-body'), dok = $('dialog-ok');
  if (dt) dt.textContent = '手札を配り直します';
  if (db) db.textContent = n + 'の手札に10・J・Q・K・Aがありません。倍率は' + g.mult + '倍です。';
  if (dok) dok.onclick = () => { d.close(); roundStart(); };
  try { if (!d.open) d.showModal(); else d.close(); d.showModal(); } catch (e) { console.warn('dialog', e); }
}

function finalAuctionRule(scores, mult = 1) {
  const ranked = scores.map((score, seat) => ({ score, seat })).sort((a, b) => a.score - b.score || a.seat - b.seat);
  const cutoff = ranked[1]?.score ?? 0;
  const gap = Math.max(0, (ranked[1]?.score ?? 0) - (ranked[0]?.score ?? 0));
  const rawMin = 13 + Math.floor(gap / (6 * Math.max(1, mult)));
  return { eligible: ranked.filter(x => x.score <= cutoff).map(x => x.seat), bottomSeat: ranked[0]?.seat, fourthSeat: ranked[1]?.seat, thirdSeat: ranked[2]?.seat, thirdScore: ranked[2]?.score, minBid: Math.min(20, rawMin), canOvertake: rawMin <= 20 };
}

function announceRound(round, rule) {
  if (g.announcedRound === round || round < 9) return;
  g.announcedRound = round;
  const scores = g.matchScores || Array(5).fill(0);
  const ranked = scores.map((score, seat) => ({ score, seat })).sort((a, b) => b.score - a.score || a.seat - b.seat);
  const lines = ranked.map((e, i) => (i + 1) + '位　' + name(e.seat) + '　' + e.score + '点');
  if (round === 9) { dialog('ラス前', ['第9局です。次はいよいよオールラストです。', '', '【現在の順位】', ...lines].join('\n')); return; }
  const bottomSeat = ranked[4].seat, fourthSeat = ranked[3].seat;
  const S3 = ranked[2].score, S4 = ranked[3].score, S5 = ranked[4].score;
  const m = Math.max(1, g.mult || 1);
  const caseA = computeTeamMinBid(scores, m, bottomSeat, fourthSeat);
  const caseB = computeTeamMinBid(scores, m, fourthSeat, bottomSeat);
  const caseC = computeTeamMinBid(scores, m, bottomSeat, bottomSeat);
  const soloRaw = soloMinimumBid(S3 - S5, m);
  const body = ['【現在の順位】', ...lines, '', '【逆転立ちの最低枚数】', '　通常　　　： ' + fmtMinBid(caseC), '　組んだら　： ' + fmtMinBid(caseA), '　逆組み　　： ' + fmtMinBid(caseB), '　ひとり立ち： ' + fmtSoloMinBid(soloRaw)].join('\n');
  dialog(g.playoff ? 'プレーオフ' : 'オールラスト', body);
}

function prepAuction() {
  g.phase = 'prep';
  announceRound(g.round, finalAuctionRule(g.matchScores, g.mult));
  phase('競り準備');
  let n = 7;
  message('競り開始まで ' + n + ' 秒');
  const tick = () => {
    n--;
    if (n <= 0) { auctionStart(); return; }
    message('競り開始まで ' + n + ' 秒');
    later(tick, 1000);
  };
  later(tick, 1000);
}

function scheduleHumanAuctionTimeout() {
  const auction = g.auction; if (!auction) return;
  clearTimeout(auction.humanTimeout);
  const timeoutMs = (g.onlineState && g.room) ? 30000 : 30000; // ローカルも30秒に統一（C5）
  auction.humanTimeout = setTimeout(() => {
    if (g.phase === 'auction' && g.auction === auction) {
      if (g.onlineState && g.room) {
        // サーバー側で自動承認される。クライアントは何もしない（N21）
        stopTurnTimer();
      } else {
        if (!g.auction.active.includes(g.mySeat)) return;
        humanApprove(true); // ローカルも自動保留
      }
    }
  }, timeoutMs);
}

// ★ N7/N21/N22: 宣言成功時のみリセット、スート変更・数字変更では呼ばない
function auctionActivity() {
  if (g.phase !== 'auction' || !g.auction) return;
  if (g.onlineState && g.room) {
    g.room?.send({ type: 'game', action: { type: 'auction-activity' } });
    resetAuctionTimer();
  } else {
    if (g.auction.autoApprove && Array.isArray(g.auction.autoApprove)) g.auction.autoApprove[g.mySeat] = false;
    scheduleHumanAuctionTimeout();
    resetAuctionTimer();
  }
}

function appealDetails(hand) { const held = ['♣J', '♦J', '♥J', '♠J', '♠A'].filter(id => hand.some(c => c.id === id)); return held.length ? held.join(' ') : 'なし'; }

function enterAuction() {
  g.phase = 'auction';
  phase('競り');
  message(g.auction.requiredBidSeat === null ? '順番なし。宣言するか、承認して競りを降りてください' : name(g.auction.requiredBidSeat) + 'が申告せず立つ選択。最低枚数以上で宣言してください');
  $('auction-panel')?.classList.remove('hidden');
  $('auction-clock')?.classList.add('hidden');
  scheduleHumanAuctionTimeout();
  drawAuction(); drawSeats(); scheduleComBids(); syncTurnTimer();
}

function drawAppealOffer() {
  const p = $('auction-panel'); if (!p) return;
  p.classList.remove('hidden');
  p.innerHTML = '<div class="panel-title">オーラス・アピール</div><div class="micro-copy">4位にJ・マイティの所持を尋ねますか？</div><div class="panel-row"><button class="small-action" id="appeal-yes">アピールする</button><button class="small-action pass" id="appeal-no">競りへ進む</button></div>';
  p.querySelector('#appeal-yes').onclick = () => answerLocalAppeal('appeal');
  p.querySelector('#appeal-no').onclick = () => answerLocalAppeal('skip');
}

function drawAppealResponse() {
  const p = $('auction-panel'); if (!p) return;
  p.classList.remove('hidden');
  const rule = finalAuctionRule(g.matchScores, g.mult);
  const fourth = rule.fourthSeat, bottom = rule.bottomSeat;
  const caseB = computeTeamMinBid(g.matchScores, g.mult, fourth, bottom);
  p.innerHTML = '<div class="panel-title">5位からアピール</div>' +
    '<div class="micro-copy">所持するJ・マイティを申告するか、申告せず立つか選んでください。</div>' +
    '<div class="appeal-forecast"><div><span>逆組み（あなた=NAP・5位=副官）</span><b>' + fmtMinBid(caseB) + '</b></div></div>' +
    '<div class="panel-row"><button class="small-action" id="appeal-disclose">札を申告する</button><button class="small-action pass" id="appeal-stand">申告せず立つ</button></div>';
  p.querySelector('#appeal-disclose').onclick = () => answerLocalAppeal('disclose');
  p.querySelector('#appeal-stand').onclick = () => answerLocalAppeal('stand');
}

function answerLocalAppeal(choice) {
  if (g.onlineState && g.room) {
    if (choice === 'skip') g.room?.send({ type: 'game', action: { type: 'skip-appeal' } });
    else if (choice === 'appeal') g.room?.send({ type: 'game', action: { type: 'appeal' } });
    else if (choice === 'disclose') g.room?.send({ type: 'game', action: { type: 'appeal-declare' } });
    else if (choice === 'stand') g.room?.send({ type: 'game', action: { type: 'appeal-stand' } });
    $('auction-panel')?.classList.add('hidden');
    return;
  }
  const rule = finalAuctionRule(g.matchScores, g.mult);
  const bottom = rule.bottomSeat;
  const fourth = rule.fourthSeat;
  if (choice === 'skip') { g.appealInfo = '5位はアピールせず競りへ'; g.auction.high = { num: 12, suit: '', player: -1, solo: false }; g.auction.requiredBidSeat = null; enterAuction(); return; }
  if (choice === 'appeal') {
    g.phase = 'appeal-response'; g.active = fourth;
    if (fourth === g.mySeat) { phase('アピール回答'); message('4位は所持するJ・マイティを申告するか、申告せず立ちます'); drawAppealResponse(); }
    else { later(() => { if (g.phase === 'appeal-response') answerLocalAppeal('disclose'); }, 1000); }
    return;
  }
  if (choice === 'disclose') { g.appealInfo = '4位の申告：' + appealDetails(g.players[fourth].hand); g.auction.high = { num: rule.minBid, suit: '♣', player: bottom, solo: false }; g.auction.requiredBidSeat = null; g.active = bottom; addGameLog(`${name(bottom)}が最低宣言数 ${rule.minBid}♣ で立ちました`); enterAuction(); return; }
  if (choice === 'stand') { g.appealInfo = '4位は申告せず立つことを選択'; g.auction.high = { num: rule.minBid, suit: '♣', player: fourth, solo: false }; g.auction.requiredBidSeat = fourth; g.active = fourth; addGameLog(`${name(fourth)}が最低宣言数 ${rule.minBid}♣ で立ちました`); enterAuction(); return; }
}

// ===== [app.js Part 1/3 終了] =====
// ===== [app.js Part 2/3 開始] =====

// ============================================================
// 競り開始
// ============================================================
function auctionStart() {
  addGameLog('競り開始');
  g.suit = '♠';
  g.bid = 13;
  showOpenKitty();
  g.appealInfo = '';
  const rule = g.round >= 10 ? finalAuctionRule(g.matchScores, g.mult) : null;
  g.auction = {
    active: rule ? rule.eligible : [0, 1, 2, 3, 4],
    approved: Array(5).fill(false),
    minBid: rule?.minBid || 13,
    high: { num: 12, suit: '', player: -1, solo: false },
    version: 0,
    autoApprove: Array(5).fill(false),
    botBids: Array(5).fill(0),
    botSeen: Array(5).fill(-1),
    botAt: Array(5).fill(0),
    lastAction: Array(5).fill(Date.now()),
    requiredBidSeat: null,
    bidPlans: {},
    properRecomputed: false,
    needsHumanConfirm: false
  };
  g.bid = g.auction.minBid;
  g.active = -1;
  g.auctionStartAt = Date.now();
  g.bidSignals = Array.from({ length: 5 }, () => ({ sent: null, received: [], sameColorCount: 0, lastBidAt: g.auctionStartAt }));
  g.properBids = [13, 13, 13, 13, 13];
  g.properPlans = [null, null, null, null, null];

  for (let seat = 0; seat < 5; seat++) {
    try {
      const role = determineRole(g.players[seat].hand, g.aiWeights);
      if (role.role === 'NAP') {
        const proper = computeProperBid(g.players[seat].hand, role.bestSuit || '♠', g.aiWeights, seat, g.bidSignals[seat], g.matchScores, g.kitty, g.playedCards, g.voids, [], g.round);
        g.properBids[seat] = proper.properBid > 0 ? proper.properBid : 13;
        g.properPlans[seat] = proper.plan || null;
      }
    } catch (e) { console.warn('determineRole failed', seat, e?.message); }
  }

  if (!rule) { enterAuction(); return; }
  const bottom = rule.bottomSeat;
  g.phase = 'appeal-offer'; g.active = bottom;
  if (bottom === g.mySeat) { phase('アピール'); message('5位は4位にJ・マイティの所持を尋ねられます'); drawAppealOffer(); }
  else { later(() => { if (g.phase === 'appeal-offer') answerLocalAppeal('appeal'); }, 1000); }
}

function bidHistoryHTML(history, getName) {
  const entries = (history || []).slice(-50).reverse();
  return '<div class="bid-history"><div class="bid-history-title">この対局の立ち履歴</div>' +
    (entries.length
      ? '<div class="bid-history-list">' + entries.map(entry => '<div class="bid-history-row player-color-' + entry.seat + '"><small>第' + entry.round + '局</small><span class="bid-player">' + escapeHTML(getName(entry.seat)) + '</span><strong>' + entry.num + entry.suit + '</strong></div>').join('') + '</div>'
      : '<div class="bid-history-empty">まだありません</div>') + '</div>';
}

function minViableBidAgainst(high, suit, minBid) {
  const minB = Math.max(13, Number(minBid) || 13);
  if (!high || !Number.isFinite(high.num) || high.num < minB) return minB;
  const curSuit = high.suit || '';
  if (!suit || !SV[suit]) return Math.min(20, high.num + 1);
  if (curSuit && SV[suit] > SV[curSuit]) return Math.max(minB, high.num);
  return Math.min(20, high.num + 1);
}

// ★ N11: approved は players[i].approved / auction.approved を統一的に参照
function drawAuction() {
  renderContractInfo();
  const p = $('auction-panel'); if (!p) return;
  if (!g.auction) return;

  if (g.auction.needsHumanConfirm && g.auction.high.player === g.mySeat) {
    const h = g.auction.high;
    p.classList.remove('hidden');
    p.innerHTML = `
      <div class="panel-title">他のプレイヤーは全員承認しました</div>
      <div style="text-align:center;font-size:28px;color:#f3d48e;font-weight:900;margin:10px 0;letter-spacing:.05em;">${h.num}${h.suit}</div>
      <div class="micro-copy" style="text-align:center;margin-bottom:12px;">この宣言でよろしければ確定してください</div>
      <div class="panel-row" style="display:flex;gap:8px;">
        <button id="bid-finalize" class="primary-button" style="flex:1;min-height:48px;">この宣言で確定</button>
        <button id="bid-reopen" class="secondary-button" style="flex:1;min-height:48px;">まだ上げる</button>
      </div>
    `;
    const fin = $('bid-finalize');
    if (fin) fin.onclick = () => {
      if (g.onlineState && g.room) {
        g.room?.send({ type: 'game', action: { type: 'confirm-auction' } });
      } else {
        g.auction.needsHumanConfirm = false;
        auctionEnd(g.mySeat, true);
      }
    };
    const reo = $('bid-reopen');
    if (reo) reo.onclick = () => {
      g.auction.needsHumanConfirm = false;
      if (g.onlineState && g.room) {
        g.room?.send({ type: 'game', action: { type: 'reopen-auction' } });
      } else {
        g.auction.approved = Array(5).fill(false);
        g.auction.botSeen = Array(5).fill(g.auction.version);
        drawAuction();
        drawSeats();
      }
    };
    return;
  }

  if ((g.onlineState && g.room) && g.phase === 'auction') {
    const currentHash = JSON.stringify(g.auction.high) + String(g.mySeat) + String(g.bid) + String(g.suit) + JSON.stringify(g.auction.active) + JSON.stringify(g.auction.approved) + String(!!g.auction.needsHumanConfirm);
    if (lastAuctionDrawHash === currentHash && !p.classList.contains('hidden')) return;
    lastAuctionDrawHash = currentHash;
  }
  if (g.auction) { const minV = minViableBidAgainst(g.auction.high, g.suit, g.auction.minBid); if (g.bid < minV) g.bid = minV; if (g.bid > 20) g.bid = 20; }
  let h = g.auction.high, t = h.num < 13 ? 'なし' : name(h.player) + ' · ' + h.num + h.suit;
  const ruleNote = g.round >= 10 ? '<div class="micro-copy">オールラスト · 最低宣言 ' + g.auction.minBid + ' · 得点2倍 · 立ち必須</div>' : '';
  const historyPanel = bidHistoryHTML(g.bidHistory, i => name(i));
  const appealPanel = g.appealInfo ? '<div class="appeal-info">' + escapeHTML(g.appealInfo) + '</div>' : '';
  p.classList.remove('hidden');

  if (g.auction.requiredBidSeat !== null && g.auction.requiredBidSeat !== g.mySeat) {
    p.innerHTML = '<div class="panel-title">4位が申告せず立ちを選択</div><div class="micro-copy">4位の宣言を待っています</div>' + appealPanel + historyPanel;
    return;
  }

  // ★ N25/N26: approved フラグベース（active から除去しない）
  if (g.auction.approved && g.auction.approved[g.mySeat]) {
    p.innerHTML = '<div class="panel-title">現在の宣言　<strong>' + t + '</strong></div>' +
      '<div class="micro-copy">保留中（誰かが上げれば復帰可能）</div>' + ruleNote + appealPanel +
      '<div class="panel-row"><button class="small-action" id="bid-resume">再立候補する</button></div>' + historyPanel;
    const resume = $('bid-resume');
    if (resume) resume.onclick = () => {
      // 承認を解除して再入札可能に（誰かが上げれば復帰する仕様）
      g.auction.approved[g.mySeat] = false;
      drawAuction();
      drawSeats();
    };
    syncTurnTimer();
    return;
  }

  p.innerHTML = '<div class="panel-title">現在の宣言　<strong>' + t + '</strong></div>' + ruleNote + appealPanel +
    '<div class="panel-row">' + SUITS.map(s => '<button class="suit-choice ' + color(s) + ' ' + (g.suit === s ? 'selected' : '') + '" data-suit="' + s + '">' + s + '</button>').join('') +
    '<button class="suit-choice ' + (g.suit === 'NT' ? 'selected' : '') + '" data-suit="NT">NT</button></div>' +
    '<div class="panel-row"><button class="small-action" id="bid-minus">−</button><span class="bid-number">' + g.bid + '</span><button class="small-action" id="bid-plus">＋</button></div>' +
    '<div class="panel-row"><button class="small-action pass" id="bid-approve" ' +
    ((g.auction.high.player === g.mySeat && g.auction.active.length > 1) || (g.round >= 10 && g.auction.high.num < 13) ? 'disabled' : '') +
    '>承認</button><button class="small-action" id="bid-submit">宣言する</button></div>' + historyPanel;

  // ★ N7/N22: スート・数字変更ではタイマーリセットしない
  document.querySelectorAll('[data-suit]').forEach(b => b.onclick = () => { g.suit = b.dataset.suit; drawAuction(); });
  const minus = $('bid-minus'), plus = $('bid-plus'), approve = $('bid-approve'), submit = $('bid-submit');
  if (plus) plus.onclick = () => { g.bid = Math.min(20, g.bid + 1); drawAuction(); };
  if (minus) minus.onclick = () => { const mv = minViableBidAgainst(g.auction.high, g.suit, g.auction.minBid); g.bid = Math.max(g.auction.minBid, mv, g.bid - 1); if (g.bid > 20) g.bid = 20; drawAuction(); };
  if (approve) approve.onclick = () => humanApprove();
  if (submit) submit.onclick = humanBid;
  syncTurnTimer();
}

function beatsBid(n, s) {
  const h = g.auction.high;
  return (n >= g.auction.minBid && n > h.num) || (n === h.num && n >= 13 && SV[s] > SV[h.suit]);
}

function scheduleObservationPeriod(excludeSeat = -1) {
  const obsBase = g.aiWeights?.auctionObservationMs ?? 2000;
  const jitter = 1000 + Math.random() * 2000;
  const delay = obsBase + jitter;
  const now = Date.now();
  for (let i = 0; i < 5; i++) {
    if (i === excludeSeat) continue;
    if (i === g.mySeat) continue;
    if (!g.players[i]?.bot) continue;
    if (!g.auction.active.includes(i)) continue;
    if (!g.auction.botAt) g.auction.botAt = Array(5).fill(now);
    g.auction.botAt[i] = now + delay;
  }
}

function scheduleComBids() {
  if (g.phase !== 'auction') return;
  const version = g.auction.version;
  const pacingMs = g.aiWeights.bidPacingMs ?? 4000;
  for (let i = 0; i < 5; i++) {
    if (!g.auction.active.includes(i)) continue;
    if (i === g.mySeat) continue;
    if (g.auction.approved && g.auction.approved[i]) continue;
    if (g.auction.botSeen[i] >= version) continue;
    const elapsed = Date.now() - (g.bidSignals[i].lastBidAt || g.auctionStartAt);
    const waitMs = Math.max(0, pacingMs - elapsed);
    later(() => comBid(i, version), waitMs);
  }
}

// ★ N13/N21: オンラインはサーバー任せ、ローカルは30秒で自動保留
function humanApprove(forced = false) {
  if (g.onlineState && g.room) {
    if (!forced) {
      g.room?.send({ type: 'game', action: { type: 'approve' } });
      stopTurnTimer(); // ★ N13: 承認はターン終了（リセットしない）
    }
    return;
  }
  if (g.phase !== 'auction' || !g.auction || !g.auction.active.includes(g.mySeat)) return;
  if (g.round >= 10 && g.auction.high.num < 13) {
    if (forced && (g.auction.requiredBidSeat ?? g.auction.active[0]) === g.mySeat) {
      g.bid = g.auction.minBid; g.suit = strongestSuit(g.players[g.mySeat].hand); humanBid();
    }
    return;
  }
  stopTurnTimer(); // ★ N13
  if (g.auction.needsHumanConfirm && g.auction.high.player === g.mySeat) {
    g.auction.needsHumanConfirm = false;
    auctionEnd(g.mySeat, true);
    return;
  }
  if (g.auction.high.player === g.mySeat) {
    const others = g.auction.active.filter(s => s !== g.mySeat);
    const humanPending = g.auction.active.some(s => s !== g.mySeat && !g.players[s]?.bot && !g.auction.approved[s]);
    const allApproved = !humanPending && (others.length === 0 || others.every(s => g.auction.approved[s]));
    if (allApproved) {
      const properBid = g.properBids[g.mySeat] || 13;
      if (g.auction.high.num < properBid) {
        const pacingMs = g.aiWeights.bidPacingMs ?? 4000;
        message(`${name(g.mySeat)}が適正値（${properBid}）まで段階上げ中…`);
        setTimeout(() => {
          if (g.phase !== 'auction') return;
          if (g.auction.high.player !== g.mySeat) return;
          const nextNum = Math.min(properBid, g.auction.high.num + 1);
          const suit = g.auction.high.suit;
          g.bidHistory.push({ round: g.round, seat: g.mySeat, num: nextNum, suit });
          if (g.bidHistory.length > 50) g.bidHistory.shift();
          g.auction.high = { num: nextNum, suit, player: g.mySeat, solo: false };
          g.bidSignals[g.mySeat].lastBidAt = Date.now();
          g.auction.bidPlans[g.mySeat] = g.properPlans[g.mySeat];
          addGameLog(`${name(g.mySeat)}が${nextNum}${suit}を宣言（適正値まで）`);
          message(`${name(g.mySeat)}が${nextNum}${suit}を宣言しました`);
          drawAuction(); drawSeats();
          auctionEnd(g.mySeat);
        }, pacingMs);
        return;
      }
      auctionEnd(g.mySeat);
    } else if (forced) {
      g.auction.autoApprove[g.mySeat] = true;
      message('30秒操作がなかったため、宣言者は自動承認待ちです');
    }
    return;
  }

  // ★ N25/N26: approved = true（activeから除去しない）
  g.auction.approved[g.mySeat] = true;
  addGameLog(forced ? 'あなたが自動保留' : 'あなたが保留（再立候補可）');
  message(forced ? '30秒操作がなかったため、自動で保留しました' : 'あなたは保留しました（誰かが上げれば復帰可能）');

  const others = g.auction.active.filter(s => s !== g.auction.high.player);
  const humanPending = g.auction.active.some(s => !g.players[s]?.bot && s !== g.auction.high.player && !g.auction.approved[s]);
  const allApproved = !humanPending && (others.length === 0 || others.every(s => g.auction.approved[s]));
  if (allApproved && g.auction.high.player >= 0) {
    if (g.auction.high.player === g.mySeat) {
      g.auction.needsHumanConfirm = true;
      message('全員承認しました。あなたの確定を待っています');
      drawAuction(); drawSeats();
      return;
    }
    auctionEnd(g.auction.high.player);
    return;
  }
  g.auction.active.filter(i => i !== g.mySeat).forEach(i => g.auction.botSeen[i] = g.auction.version - 1);
  scheduleObservationPeriod(g.mySeat);
  drawAuction(); drawSeats(); scheduleComBids();
}

// ★ N22: オンラインでも beatsBid チェック、成功時のみリセット
function humanBid() {
  if (g.phase !== 'auction' || !g.auction) return;

  // ★ N22: 有効な宣言のみ通す（オンライン・ローカル共通）
  if (!beatsBid(g.bid, g.suit)) {
    toast('現在の宣言より強い宣言を選んでください');
    return;
  }

  if (g.onlineState && g.room) {
    // 有効な宣言時のみタイマーリセット
    auctionActivity();
    g.room?.send({ type: 'game', action: { type: 'bid', num: g.bid, suit: g.suit } });
    return;
  }

  if (!g.auction.active.includes(g.mySeat) || (g.auction.requiredBidSeat !== null && g.auction.requiredBidSeat !== g.mySeat)) return;
  auctionActivity();

  g.bidHistory.push({ round: g.round, seat: g.mySeat, num: g.bid, suit: g.suit });
  addGameLog('あなたが' + g.bid + g.suit + 'を宣言');
  if (g.bidHistory.length > 50) g.bidHistory.shift();
  const prevBid = { ...g.auction.high };
  g.auction.high = { num: g.bid, suit: g.suit, player: g.mySeat, solo: false };
  if (g.auction.requiredBidSeat === g.mySeat) g.auction.requiredBidSeat = null;
  g.auction.version++;
  // ★ N25/N26: bid で全員復帰
  g.auction.approved = Array(5).fill(false);
  g.auction.needsHumanConfirm = false;
  g.active = g.mySeat;
  g.bidSignals[g.mySeat].lastBidAt = Date.now();

  if (prevBid.num >= 13 && prevBid.player >= 0 && prevBid.player !== g.mySeat) {
    try {
      const intent = inferIntentFromBid(prevBid, { num: g.bid, suit: g.suit, player: g.mySeat }, g.aiWeights);
      for (let i = 0; i < 5; i++) {
        if (i === g.mySeat) continue;
        if (!g.bidSignals[i].received) g.bidSignals[i].received = [];
        g.bidSignals[i].received.push({ from: g.mySeat, intent: intent.intent, strength: intent.strength, num: g.bid, suit: g.suit, reason: intent.reason });
      }
    } catch (e) { console.warn('inferIntentFromBid failed', e?.message); }
  }

  scheduleObservationPeriod(g.mySeat);

  message('あなたが' + g.bid + g.suit + 'を宣言しました');
  if (g.bid === 20 && g.suit === 'NT') { auctionEnd(g.mySeat); return; }
  drawAuction(); drawSeats(); scheduleComBids();
}

// ============================================================
// COM競り（段階上げ＋暗黙シグナル）
// ============================================================
function comBid(i, version) {
  if (g.phase !== 'auction' || version !== g.auction.version || !g.auction.active.includes(i)) return;
  if (g.auction.botSeen[i] >= version) return;
  if (g.auction.requiredBidSeat !== null && g.auction.requiredBidSeat !== i) return;
  if (g.auction.approved && g.auction.approved[i]) return;
  g.auction.botSeen[i] = version;

  if (g.auction.high.player === i) {
    if (g.auction.active.length === 1) auctionEnd(i);
    return;
  }

  const hand = g.players[i].hand;
  const params = g.aiWeights;

  let role;
  try { role = determineRole(hand, params); }
  catch (e) { role = { role: 'ALLIANCE', nScore: 0, dScore: 0, dPoints: 0, bestSuit: null, reason: 'error' }; }

  let decision;
  try { decision = decideNextBid(hand, g.auction.high, role, params, g.bidSignals[i].received || []); }
  catch (e) { decision = { type: 'PASS', reason: 'error' }; }

  if (decision.type === 'BID' && beatsBid(decision.num, decision.suit)) {
    const prevBid = { ...g.auction.high };
    g.bidHistory.push({ round: g.round, seat: i, num: decision.num, suit: decision.suit });
    if (g.bidHistory.length > 50) g.bidHistory.shift();
    g.auction.high = { num: decision.num, suit: decision.suit, player: i, solo: false };
    g.auction.version++;
    g.auction.approved = Array(5).fill(false);
    g.auction.needsHumanConfirm = false;
    g.active = i;
    g.bidSignals[i].lastBidAt = Date.now();

    if (prevBid.num >= 13 && prevBid.player >= 0 && prevBid.player !== i) {
      try {
        const intent = inferIntentFromBid(prevBid, { num: decision.num, suit: decision.suit, player: i }, params);
        for (let s = 0; s < 5; s++) {
          if (s === i) continue;
          if (!g.bidSignals[s].received) g.bidSignals[s].received = [];
          g.bidSignals[s].received.push({ from: i, intent: intent.intent, strength: intent.strength, num: decision.num, suit: decision.suit, reason: intent.reason });
        }
      } catch (e) { console.warn('inferIntentFromBid failed', e?.message); }
    }

    scheduleObservationPeriod(i);
    addGameLog(name(i) + 'が' + decision.num + decision.suit + 'を宣言（' + decision.reason + '）');
    message(name(i) + 'が' + decision.num + decision.suit + 'を宣言しました');

    if (decision.num === 20 && decision.suit === 'NT') { auctionEnd(i); return; }
    drawAuction(); drawSeats(); scheduleComBids();
    return;
  }

  // ★ N25/N26: approved = true
  g.auction.approved[i] = true;
  addGameLog(name(i) + 'が保留');
  message(name(i) + 'は保留しました');

  const others = g.auction.active.filter(s => s !== g.auction.high.player);
  const humanPending = g.auction.active.includes(g.mySeat) && g.mySeat !== g.auction.high.player && !g.auction.approved[g.mySeat];
  const allApproved = !humanPending && (others.length === 0 || others.every(s => g.auction.approved[s]));
  if (allApproved && g.auction.high.player >= 0) {
    if (g.auction.high.player === g.mySeat) {
      g.auction.needsHumanConfirm = true;
      message('全員承認しました。あなたの確定を待っています');
      drawAuction(); drawSeats();
      return;
    }
    auctionEnd(g.auction.high.player);
    return;
  }
  scheduleObservationPeriod(i);
  drawAuction(); drawSeats(); scheduleComBids();
}

function auctionEnd(w, skipProperRaise = false) {
  if (g.auction) g.auction.needsHumanConfirm = false;
  clearTimeout(g.auction?.humanTimeout);
  stopTurnTimer();

  if (w >= 0 && g.auction && !g.auction.properRecomputed) {
    const proper = computeProperBid(g.players[w].hand, g.auction.high.suit, g.aiWeights, w, g.bidSignals[w], g.matchScores, g.kitty, g.playedCards, g.voids, g.bidHistory);
    g.properBids[w] = proper.properBid > 0 ? proper.properBid : 13;
    g.properPlans[w] = proper.plan || null;
    g.auction.properRecomputed = true;
  }

  if (w < 0 || g.auction.high.num < 13) {
    if (g.round >= 10) {
      w = finalAuctionRule(g.matchScores, g.mult).bottomSeat;
      g.auction.high = { num: g.auction.minBid, suit: strongestSuit(g.players[w].hand), player: w, solo: false };
    } else {
      $('auction-panel')?.classList.add('hidden'); showDiscardedKitty(); $('auction-clock')?.classList.add('hidden');
      dialog('流局', '宣言がありませんでした。配り直します。', roundStart);
      return;
    }
  }

  const properBid = g.properBids[w] || 13;
  if (!skipProperRaise && g.auction.high.num < properBid && g.auction.high.player === w) {
    if (!g.auction.active.includes(w)) g.auction.active.push(w);
    const pacingMs = g.aiWeights.bidPacingMs ?? 4000;
    message(`${name(w)}が適正値（${properBid}）まで段階上げ中…`);
    $('auction-panel')?.classList.remove('hidden');
    drawAuction(); drawSeats();
    setTimeout(() => {
      if (g.phase !== 'auction') return;
      if (g.auction.high.player !== w) return;
      const nextNum = Math.min(properBid, g.auction.high.num + 1);
      const suit = g.auction.high.suit;
      g.bidHistory.push({ round: g.round, seat: w, num: nextNum, suit });
      if (g.bidHistory.length > 50) g.bidHistory.shift();
      g.auction.high = { num: nextNum, suit, player: w, solo: false };
      g.bidSignals[w].lastBidAt = Date.now();
      g.auction.bidPlans[w] = g.properPlans[w];
      addGameLog(`${name(w)}が${nextNum}${suit}を宣言（適正値まで）`);
      message(`${name(w)}が${nextNum}${suit}を宣言しました`);
      drawAuction(); drawSeats();
      auctionEnd(w);
    }, pacingMs);
    return;
  }

  $('auction-panel')?.classList.add('hidden'); showDiscardedKitty(); $('auction-clock')?.classList.add('hidden');
  clearTimeout(g.auction?.pacingTimer);

  const suit = g.auction.high.suit;
  const strengthAtBid = suit === 'NT' ? ntHandStrength(g.players[w].hand, g.aiWeights) : colorStrength(g.players[w].hand, suit, g.aiWeights);
  const isSoloBid = g.auction.high.solo === true;
  g.contract = { nap: w, num: g.auction.high.num, suit, deputy: -1, solo: isSoloBid, revealTrickNo: null, strengthAtBid, bidPlan: g.properPlans[w] || g.auction.bidPlans?.[w] || null };
  if (w === g.mySeat && g.humanRoundLog) g.humanRoundLog.bid = { strengthKey: quantizeStrength(strengthAtBid), trumpType: suit === 'NT' ? 'NT' : 'color', num: g.auction.high.num };
  addDebugLog('contract-set', { nap: w, num: g.contract.num, suit: g.contract.suit, solo: g.contract.solo, strengthAtBid, highBid: g.auction.high, bidHistory: sanitizeForLog(g.bidHistory) });
  addGameLog(name(w) + 'が' + g.contract.num + g.contract.suit + 'で宣言を確定');
  phase('浮き札の交換');
  message(name(w) + 'が' + g.contract.num + g.contract.suit + 'で宣言。オープンを手札に入れて2枚捨ててください');
  kittyStart();
}

// ============================================================
// オープン交換・副官指名
// ============================================================
function kittyStart() {
  let n = g.contract.nap;
  if (!(g.onlineState && g.room)) { g.players[n].hand.push(...g.kitty); sort(g.players[n].hand); }
  g.phase = 'discard';
  phase('浮き札の交換');
  if (n === g.mySeat) {
    const cp = $('call-panel'); if (!cp) return;
    const discardAnalysis = analyzeDiscardOptions(g.players[n].hand, g.contract.suit, {
      num: g.contract.num, hasMighty: g.players[n].hand.some(c => c.id === '♠A'),
      deputyHasMighty: true, protectedCallId: null, params: g.aiWeights
    }, g.aiWeights);
    let analysisHint = '';
    if (discardAnalysis && discardAnalysis.options && discardAnalysis.options.length >= 2) {
      const sorted = discardAnalysis.options.slice().sort((a, b) => b.ev - a.ev);
      const evDiff = Math.abs(sorted[0].ev - sorted[1].ev);
      if (evDiff < 0.5) {
        const topType = sorted[0].type === 'void' ? 'ボイド作成' : '全スート維持';
        const secType = sorted[1].type === 'void' ? 'ボイド作成' : '全スート維持';
        analysisHint = `<div class="micro-copy" style="margin-top:8px;color:#e6be72;font-size:11px;">⚖️ 期待値拮抗（差 ${evDiff.toFixed(2)}）<br>${topType} vs ${secType} で迷う局面です</div>`;
      } else if (sorted[0].type === 'void') {
        analysisHint = `<div class="micro-copy" style="margin-top:8px;color:#a9d2ae;font-size:11px;">💡 期待値: ボイド作成が有利（EV ${sorted[0].ev.toFixed(2)}）</div>`;
      } else {
        analysisHint = `<div class="micro-copy" style="margin-top:8px;color:#a9d2ae;font-size:11px;">💡 期待値: 全スート維持が有利（EV ${sorted[0].ev.toFixed(2)}）</div>`;
      }
    }
    cp.classList.remove('hidden');
    cp.innerHTML = '<div class="panel-title">手札から2枚を選んで捨ててください</div>' + analysisHint + '<div class="panel-row"><span class="micro-copy" id="discard-count">0 / 2 SELECTED</span><button class="small-action" id="discard-ok" disabled>決定</button></div>';
    renderHand(true);
    const dc = $('discard-count'), dok = $('discard-ok');
    if (dc) dc.textContent = g.discard.size + ' / 2枚選択';
    if (dok) dok.disabled = g.discard.size !== 2;
    if (dok) dok.onclick = () => {
      if (g.discard.size !== 2) return;
      if (g.onlineState && g.room) { g.room?.send({ type: 'game', action: { type: 'discard', cards: Array.from(g.discard) } }); $('game-screen')?.classList.remove('discarding'); $('hand')?.classList.remove('discard-mode'); cp.classList.add('hidden'); return; }
      g.kitty = g.players[g.mySeat].hand.filter(c => g.discard.has(c.id));
      g.discardedKitty = g.kitty.slice();
      g.allianceKittyPoints += g.kitty.filter(c => POINT.includes(c.rank)).length;
      g.players[g.mySeat].hand = g.players[g.mySeat].hand.filter(c => !g.discard.has(c.id));
      sort(g.players[g.mySeat].hand);
      $('game-screen')?.classList.remove('discarding');
      $('hand')?.classList.remove('discard-mode');
      cp.classList.add('hidden');
      callUi();
    };
    g.lastDiscardPhase = true;
    return;
  }
  if (g.onlineState && g.room) return;
  const comDiscardContext = { num: g.contract.num, hasMighty: g.players[n].hand.some(c => c.id === '♠A'), deputyHasMighty: true, protectedCallId: null, params: g.aiWeights };
  const drop = chooseDiscard(g.players[n].hand, g.contract.suit, comDiscardContext);
  g.players[n].hand = g.players[n].hand.filter(c => !drop.some(x => x.id === c.id));
  g.kitty = drop;
  g.discardedKitty = drop.slice();
  g.allianceKittyPoints += drop.filter(c => POINT.includes(c.rank)).length;
  sort(g.players[n].hand);
  const forceSolo = isSoloForced();
  if (forceSolo) { const chosen = chooseSoloCall(g.players[n].hand, g.contract.suit); g.contract.call = { suit: chosen.suit, rank: chosen.rank, id: chosen.id }; g.contract.solo = true; addGameLog(name(n) + 'が副官指名 ' + g.contract.call.id); }
  else if (g.contract.solo) { const chosen = chooseSoloCall(g.players[n].hand, g.contract.suit); g.contract.call = { suit: chosen.suit, rank: chosen.rank, id: chosen.id }; addGameLog(name(n) + 'が副官指名 ' + g.contract.call.id); }
  else {
    const receivedSignals = (g.bidSignals[n]?.received || []).filter(s => ['S1', 'S2', 'S3', 'S4'].includes(s.intent));
    const call = chooseDeputyCall(g.players[n].hand, g.kitty, g.contract.suit, g.botLevel, g.contract.num, g.aiWeights, g.aiExperience, receivedSignals);
    g.contract.call = { suit: call.suit, rank: call.rank, id: call.id };
    g.contract.solo = g.players[n].hand.some(c => c.id === g.contract.call.id);
    addGameLog(name(n) + 'が副官指名 ' + g.contract.call.id);
  }
  g.contract.revealedCall = false;
  g.kitty = [];
  later(() => { showDiscardedKitty(); announceCall(g.contract.call, playStart); }, 700);
}

function callUi() {
  g.phase = 'call';
  phase('副官指名');
  if (!(g.onlineState && g.room)) showDiscardedKitty();
  else {
    const label = document.createElement('span'); label.className = 'open-label'; label.textContent = '捨て札(絵札)';
    const cards = (g.discardedKitty || []).map(c => cardEl(c));
    const el = $('kitty-view');
    if (el) { if (cards.length) el.replaceChildren(label, ...cards); else el.replaceChildren(); }
  }
  const bidSolo = g.contract.solo;
  const forceSolo = isSoloForced() || bidSolo;
  message(forceSolo ? '⚠ 一人立ちが必須です。自分の手札から指名札を選んでください' : '捨て札を決めました。副官に指名するカードを選んでください');
  let p = $('call-panel'); if (!p) return;
  p.classList.remove('hidden');
  let s = '♠', r = 'A';
  p.innerHTML = '<div class="panel-title">' + (forceSolo ? '⚠ 一人立ち（指名札）' : '副官に指名するカード') + '</div>' +
    '<div class="call-card-preview"><div id="call-preview"></div><div><div class="micro-copy">' + (forceSolo ? '一人立ち札' : '今回の指名') + '</div><strong id="call-val">♠A</strong><div id="call-warning" class="call-warning"></div></div></div>' +
    '<div class="panel-row">' + SUITS.map(x => '<button class="suit-choice ' + color(x) + '" data-cs="' + x + '">' + x + '</button>').join('') + '</div>' +
    '<div class="panel-row call-ranks">' + RANKS.map(x => '<button class="small-action call-rank-choice" data-cr="' + x + '">' + x + '</button>').join('') + '</div>' +
    '<div class="panel-row"><span class="micro-copy">' + (forceSolo ? '自分の手札のカードのみ指名可能' : '自分の手札にある札を選ぶと、ひとり立ちになります') + '</span><button class="small-action" id="call-ok">決定</button></div>';
  const ownCards = new Set((g.players[g.contract.nap]?.hand || []).map(c => c.id));
  const update = () => {
    p.querySelectorAll('[data-cs]').forEach(b => b.classList.toggle('selected', b.dataset.cs === s));
    p.querySelectorAll('[data-cr]').forEach(b => b.classList.toggle('selected', b.dataset.cr === r));
    const cv = $('call-val'); if (cv) cv.textContent = s + r;
    const cp = $('call-preview'); if (cp) cp.replaceChildren(cardEl({ suit: s, rank: r }, 'call-preview-card'));
    const discarded = g.kitty.some(c => c.suit === s && c.rank === r);
    const isOwn = ownCards.has(s + r);
    const cw = $('call-warning'), co = $('call-ok');
    if (forceSolo) { if (cw) cw.textContent = !isOwn ? '⚠ 自分の手札のカードを選んでください' : ''; if (co) co.disabled = !isOwn || discarded; }
    else { if (cw) cw.textContent = discarded ? '捨て札は指名できません' : ''; if (co) co.disabled = discarded; }
  };
  p.querySelectorAll('[data-cs]').forEach(b => b.onclick = () => { s = b.dataset.cs; update(); });
  p.querySelectorAll('[data-cr]').forEach(b => b.onclick = () => { r = b.dataset.cr; update(); });
  const cok = $('call-ok');
  if (cok) cok.onclick = () => {
    if (g.kitty.some(c => c.suit === s && c.rank === r)) return;
    if (forceSolo && !ownCards.has(s + r)) return;
    if (g.onlineState && g.room) { g.room?.send({ type: 'game', action: { type: 'call', suit: s, rank: r } }); p.classList.add('hidden'); return; }
    g.contract.call = { suit: s, rank: r, id: s + r };
    g.contract.solo = g.players[g.mySeat].hand.some(c => c.suit === s && c.rank === r);
    if (forceSolo && !g.contract.solo) return;
    if (g.contract.nap === g.mySeat && g.humanRoundLog) g.humanRoundLog.call = { callId: s + r, trumpSuit: g.contract.suit === 'NT' ? 'NT' : g.contract.suit };
    addGameLog('副官指名 ' + s + r);
    g.contract.revealedCall = false;
    g.kitty = [];
    renderContractInfo();
    message(s + r + 'を指名しました');
    p.classList.add('hidden');
    announceCall(g.contract.call, playStart);
  };
  update();
}

function drawOnlineCallReveal() {
  const p = $('call-panel'); if (!p) return;
  p.classList.remove('hidden');
  const call = g.contract?.call;
  p.innerHTML = '<div class="panel-title">副官指名</div>' + (call ? '<div class="call-card-preview"><div id="online-reveal-preview"></div></div>' : '') + '<div class="micro-copy">全員が確認すると最初のトリックが始まります。</div><div class="panel-row"><button class="small-action" id="online-confirm-call">確認しました</button></div>';
  const rp = $('online-reveal-preview'); if (rp && call) rp.replaceChildren(cardEl(call, 'announcement-card'));
  const ok = $('online-confirm-call');
  if (ok) {
    if (g.confirmedCall) { ok.disabled = true; ok.textContent = '確認待ち...'; }
    else { ok.onclick = () => { g.confirmedCall = true; g.room?.send({ type: 'game', action: { type: 'confirm-call' } }); ok.disabled = true; ok.textContent = '確認待ち...'; }; }
  }
}

function renderHand(discard = false) {
  let box = $('hand'); if (!box) return;
  box.classList.toggle('discard-mode', discard);
  $('game-screen')?.classList.toggle('discarding', discard);
  box.replaceChildren();
  const handCards = (g.onlineState && g.room) ? (g.privateHand || g.players[g.mySeat]?.hand || []) : (g.players[0]?.hand || []);
  handCards.forEach(c => {
    let e = cardEl(c, discard ? 'playable' : '');
    if (discard) {
      const protectedCall = g.contract?.solo && g.contract.call?.id === c.id;
      e.classList.toggle('protected', protectedCall);
      e.classList.toggle('selected', g.discard.has(c.id));
      e.setAttribute('aria-pressed', String(g.discard.has(c.id)));
      e.onclick = () => {
        if (protectedCall) { toast('指名札は捨てられません'); return; }
        if (g.discard.has(c.id)) g.discard.delete(c.id);
        else if (g.discard.size < 2) g.discard.add(c.id);
        const selected = g.discard.has(c.id);
        e.classList.toggle('selected', selected);
        e.setAttribute('aria-pressed', String(selected));
        const dc = $('discard-count'), dok = $('discard-ok');
        if (dc) dc.textContent = g.discard.size + ' / 2枚選択';
        if (dok) dok.disabled = g.discard.size !== 2;
      };
    } else if (g.phase === 'play' && ((g.onlineState && g.room) ? g.active === g.mySeat : g.active === 0)) {
      const ok = legal(g.mySeat).some(x => x.id === c.id);
      e.classList.toggle('playable', ok && !g.waitingAutoPlay);
      e.classList.toggle('selected', g.selectedCard === c.id);
      if (ok && !g.waitingAutoPlay) e.onclick = () => { g.selectedCard = g.selectedCard === c.id ? null : c.id; renderHand(); drawLocalPlayControls(); };
    }
    box.append(e);
  });
  const hc = $('hand-count'); if (hc) hc.textContent = (handCards.length || 0) + '枚';
}

function drawLocalPlayControls() {
  const p = $('play-panel'); if (!p) return;
  if (g.phase !== 'play' || g.active !== g.mySeat || g.waitingAutoPlay) { p.classList.add('hidden'); return; }
  const card = g.players[g.mySeat].hand.find(c => c.id === g.selectedCard && legal(g.mySeat).some(x => x.id === c.id));
  const canWin = g.trick.length === 0 && canDeclareWin({
    hand: g.players[g.mySeat].hand, trick: g.trick, trickNo: g.trickNo, contract: g.contract,
    playedCards: g.playedCards, voids: g.voids, seat: g.mySeat,
    discardedKitty: g.discardedKitty,
    players: g.players.map(pl => ({ handCount: pl.hand.length })),
    points: g.points, allianceKittyPoints: g.allianceKittyPoints,
  });

  if (!card && !canWin) { g.selectedCard = null; p.classList.add('hidden'); p.replaceChildren(); return; }
  p.classList.remove('hidden');

  let html = '';
  if (card) {
    html += '<div class="panel-title">このカードを出しますか？</div><div class="play-confirm-preview"><div id="local-play-card"></div><span class="micro-copy">選択中</span></div><div class="play-confirm-actions"><button id="cancel-local-play" class="small-action">選び直す</button><button id="confirm-local-play" class="primary-button">出す</button></div>';
  }
  if (canWin) {
    html += '<div class="panel-title" style="color:#f3d48e; margin-top:10px;">✨ 手札がすべて絶対勝ちです</div><div class="panel-row"><button id="declare-win-btn" class="primary-button" style="width:100%; background:linear-gradient(135deg,#f3d48e,#d4a850); color:#17211a; font-size:16px; padding:12px;">上がり宣言（勝利）</button></div>';
  }
  p.innerHTML = html;

  const lpc = $('local-play-card'); if (lpc && card) lpc.replaceChildren(cardEl(card, 'play-confirm-card'));
  const cancel = $('cancel-local-play'); if (cancel) cancel.onclick = () => { g.selectedCard = null; renderHand(); drawLocalPlayControls(); };
  const confirm = $('confirm-local-play'); if (confirm) confirm.onclick = () => {
    if (g.onlineState && g.room) { g.room?.send({ type: 'game', action: { type: 'play', card: card.id } }); g.selectedCard = null; p.classList.add('hidden'); return; }
    const chosen = card; g.selectedCard = null; p.classList.add('hidden'); play(g.mySeat, chosen);
  };

  const winBtn = $('declare-win-btn');
  if (winBtn) winBtn.onclick = () => {
    if (g.onlineState && g.room) { g.room.send({ type: 'game', action: { type: 'declare-win' } }); p.classList.add('hidden'); }
    else {
      g.winDeclaration = { seat: g.mySeat, hand: [...g.players[g.mySeat].hand], expiresAt: Date.now() + 5000 };
      g.phase = 'win-declaration';
      p.innerHTML = `<div class="panel-title" style="color:#f3d48e;font-size:16px;">✨ あなたが上がり宣言しました</div><div class="micro-copy" style="margin-bottom:10px;">手札を確認してください（5秒後に確定）</div><div class="win-declaration-hand" style="display:flex;flex-wrap:wrap;gap:4px;justify-content:center;">${g.players[g.mySeat].hand.map(c => cardEl(c).outerHTML).join('')}</div>`;
      let remain = 5;
      const cd = setInterval(() => {
        remain--;
        if (remain <= 0) {
          clearInterval(cd);
          let allTaken = [];
          g.players.forEach(pl => allTaken.push(...pl.hand));
          const taken = allTaken.filter(c => ['10', 'J', 'Q', 'K', 'A'].includes(c.rank));
          g.points[g.mySeat] += taken.length;
          g.players[g.mySeat].taken.push(...taken);
          g.players[g.mySeat].roundTaken.push(...taken);
          g.players[g.mySeat].roundPoints = (g.players[g.mySeat].roundPoints || 0) + taken.length;
          g.players.forEach(pl => pl.hand = []);
          g.trickNo = 10;
          finishGame();
        } else {
          const el = p.querySelector('.micro-copy');
          if (el) el.textContent = `手札を確認してください（${remain}秒後に確定）`;
        }
      }, 1000);
    }
  };
}

function playStart() {
  g.selectedCard = null;
  g.lastTrickWinner = null;
  g.waitingAutoPlay = false;
  g.phase = 'play';
  let c = g.contract;
  if (c.solo) c.deputy = c.nap;
  else { g.contract.deputy = g.players.findIndex(p => p.hand.some(x => x.suit === c.call.suit && x.rank === c.call.rank)); if (g.contract.deputy < 0) g.contract.deputy = c.nap; }
  g.contract.revealedCall = false;
  g.contract.revealTrickNo = null;
  g.active = c.nap;
  g.trickNo = 0;
  g.trick = [];
  // ★ N40: プール初期化・ターン開始
  g.playPools = [20, 20, 20, 20, 20];
  g.turnStartAt = Date.now();
  const free = PLAY_FREE_SECONDS;
  const pool = g.playPools[g.active] || PLAY_POOL_SECONDS;
  g.deadline = Date.now() + (free + Math.max(0, pool)) * 1000;
  addGameLog(name(c.nap) + 'が先攻');
  phase('カードプレイ');
  message(name(c.nap) + 'が先攻です');
  $('call-panel')?.classList.add('hidden');
  $('kitty-view')?.replaceChildren();
  renderHand();
  drawSeats();
  playTurn();
}

function legal(i) { let h = g.players[i].hand; if (!g.trick.length) return h; let suit = g.trick[0].card.suit, follow = h.filter(c => c.suit === suit); return follow.length ? follow : h; }
function trump(c) { return g.contract.suit !== 'NT' && c.suit === g.contract.suit; }

function cardPower(entry, trick, trickNo = 0, strictAllSame = false) {
  let c = entry.card, led = trick[0].card.suit, allSame = trick.every(x => x.card.suit === led), mighty = trick.some(x => x.card.id === '♠A');
  const sameTwoEligible = allSame && (!strictAllSame || trick.length >= 5);
  if (mighty && c.id === '♥Q') return 10000;
  if (c.id === '♠A') return 9000;
  if (g.contract.suit !== 'NT' && c.rank === 'J' && c.suit === g.contract.suit) return 8000;
  let black = s => s === '♣' || s === '♠';
  if (g.contract.suit !== 'NT' && c.rank === 'J' && c.suit !== g.contract.suit && black(c.suit) === black(g.contract.suit)) return 7000;
  if (trickNo > 0) { if (sameTwoEligible && c.suit === led && c.rank === '2') return 6000; }
  if (trump(c)) return 5000 + RANKS.indexOf(c.rank);
  if (c.suit === led) return 3000 + RANKS.indexOf(c.rank);
  return 1000 + RANKS.indexOf(c.rank);
}
function winning(trick = g.trick, strictAllSame = false) { return trick.reduce((best, e) => cardPower(e, trick, g.trickNo, strictAllSame) > cardPower(best, trick, g.trickNo, strictAllSame) ? e : best, trick[0]); }

async function computeBotPlay(seat) {
  const hand = g.players[seat].hand;
  const legalCardsList = legal(seat);
  if (!legalCardsList.length) return { card: null, source: 'エラー(手札なし)' };

  const contract = { nap: g.contract.nap, num: g.contract.num, suit: g.contract.suit, solo: g.contract.solo, deputy: g.contract.deputy, revealedCall: g.contract.revealedCall, call: g.contract.call, bidPlan: g.contract.bidPlan };
  const trick = g.trick.map(x => ({ seat: x.player, card: x.card }));
  const deputyPts = (!g.contract.solo && g.contract.deputy >= 0) ? (g.points[g.contract.deputy] || 0) : 0;
  const currentNapPoints = (g.points[g.contract.nap] || 0) + deputyPts;

  const ctx = {
    hand, legal: legalCardsList, trick, trickNo: g.trickNo, contract, playedCards: g.playedCards, voids: g.voids, seat, deputy: g.contract.deputy,
    params: g.aiWeights, call: g.contract.call, discardedKitty: g.discardedKitty || [],
    isMySideNap: seat === contract.nap || (contract.revealedCall && seat === contract.deputy),
    isCurrentNapWinning: false, isRevealed: contract.revealedCall, isNapLeading: false, lastSeat: trick.length === 4, currentNapPoints,
    experience: g.aiExperience,
    points: g.players.map(p => p.roundPoints || 0),
    allianceKittyPoints: g.allianceKittyPoints || 0,
    bidHistory: g.bidHistory || [],
    matchScores: g.matchScores || [0, 0, 0, 0, 0],
    players: g.players.map(pl => ({ handCount: pl.hand.length }))
  };
  if (trick.length > 0) {
    const winner = winningEntry(contract, g.trickNo, trick);
    if (winner) {
      ctx.isCurrentNapWinning = winner.seat === contract.nap || (!contract.solo && winner.seat === contract.deputy);
      ctx.isNapLeading = trick[0].seat === contract.nap;
    }
  }

  return new Promise((resolve) => {
    let isResolved = false;
    let completed = 0;
    const results = [];
    const handlers = [];

    const timeoutTimer = setTimeout(() => {
      if (isResolved) return;
      isResolved = true;
      handlers.forEach(({ worker, handler }) => worker.removeEventListener('message', handler));
      const randomCard = legalCardsList[Math.floor(Math.random() * legalCardsList.length)];
      resolve({ card: randomCard, source: 'タイムアウト(ランダム)' });
    }, 6500);

    const handleAllResults = () => {
      if (isResolved) return;
      if (completed < aiWorkers.length) return;
      isResolved = true;
      clearTimeout(timeoutTimer);

      const mergedN = {}, mergedW = {};
      legalCardsList.forEach(c => { mergedN[c.id] = 0; mergedW[c.id] = 0; });
      let totalIterations = 0;
      for (const res of results) {
        if (!res || !res.N || !res.W) continue;
        totalIterations += res.iterations || 0;
        for (const c of legalCardsList) {
          mergedN[c.id] += res.N[c.id] || 0;
          mergedW[c.id] += res.W[c.id] || 0;
        }
      }

      let bestCard = legalCardsList[0];
      let bestScore = -1;
      for (const c of legalCardsList) {
        if (mergedN[c.id] === 0) continue;
        const winRate = mergedW[c.id] / mergedN[c.id];
        const confidence = Math.min(1.0, mergedN[c.id] / (totalIterations / legalCardsList.length));
        const adjustedScore = winRate * (0.8 + 0.2 * confidence);
        if (adjustedScore > bestScore) { bestScore = adjustedScore; bestCard = c; }
      }

      if (bestScore === -1) {
        const fallback = chooseCardToPlay(ctx);
        resolve({ card: fallback || legalCardsList[0], source: '並列MCTS(フォールバック)' });
      } else {
        resolve({ card: bestCard, source: `並列MCTS(${numWorkers}Threads)` });
      }
    };

    const workerCtx = { ...ctx, params: { ...ctx.params, maxThinkTimeMs: 6000 } };
    aiWorkers.forEach((worker) => {
      const handler = (e) => {
        if (isResolved) return;
        if (e.data.type === 'result') { worker.removeEventListener('message', handler); results.push(e.data.stats); completed++; handleAllResults(); }
        else if (e.data.type === 'error') { worker.removeEventListener('message', handler); results.push(null); completed++; handleAllResults(); }
      };
      handlers.push({ worker, handler });
      worker.addEventListener('message', handler);
      try { worker.postMessage({ type: 'calculate', ctx: workerCtx }); }
      catch (err) { results.push(null); completed++; handleAllResults(); }
    });
  });
}

function playTurn() {
  if (g.phase !== 'play') return;
  drawSeats();
  renderHand();
  if (g.active === g.mySeat) {
    const myLegal = legal(g.mySeat);
    if (myLegal.length === 1 && !g.waitingAutoPlay) {
      g.waitingAutoPlay = true;
      message('出すカードが1枚しかないため、自動で出します');
      $('play-panel')?.classList.add('hidden');
      renderHand();
      syncTurnTimer();
      later(() => { g.waitingAutoPlay = false; if (g.phase === 'play' && g.active === g.mySeat) { const stillLegal = legal(g.mySeat); if (stillLegal.length === 1) play(g.mySeat, stillLegal[0]); } }, 900);
      return;
    }
    message(g.trick.length ? 'あなたの番です。場札のマークに続けてください。' : 'あなたが先攻です。カードを出してください。');
    drawLocalPlayControls();
    syncTurnTimer();
    return;
  }
  // ★ N17: オンライン経路はサーバーが進行
  if (g.onlineState && g.room) { g.humanAutoPlayAt = null; g.botThinkAt = 0; return; }

  stopTurnTimer();
  message(name(g.active) + 'がカードを選んでいます');
  const seatAtSchedule = g.active;
  const trickLengthAtSchedule = g.trick.length;

  later(async () => {
    if (g.phase !== 'play' || g.active !== seatAtSchedule || g.trick.length !== trickLengthAtSchedule) return;
    try {
      const seat = g.active;
      if (seat === g.mySeat) return;
      const legalCardsList = legal(seat);
      if (!legalCardsList.length) { addDebugLog('play-no-legal', { seat }); g.active = (seat + 1) % 5; playTurn(); return; }

      if (g.trick.length === 0) {
        const canWin = canDeclareWin({
          hand: g.players[seat].hand, trick: g.trick, trickNo: g.trickNo, contract: g.contract,
          playedCards: g.playedCards, voids: g.voids, seat,
          discardedKitty: g.discardedKitty,
          players: g.players.map(pl => ({ handCount: pl.hand.length })),
          points: g.points, allianceKittyPoints: g.allianceKittyPoints,
        });
        if (canWin) {
          g.winDeclaration = { seat, hand: [...g.players[seat].hand], expiresAt: Date.now() + 5000 };
          g.phase = 'win-declaration';
          addGameLog(name(seat) + 'が上がり宣言！');
          const p = $('play-panel');
          if (p) {
            p.classList.remove('hidden');
            p.innerHTML = `<div class="panel-title" style="color:#f3d48e;font-size:16px;">✨ ${name(seat)} が上がり宣言しました</div><div class="micro-copy" style="margin-bottom:10px;">手札を確認してください（5秒後に確定）</div><div class="win-declaration-hand" style="display:flex;flex-wrap:wrap;gap:4px;justify-content:center;">${g.players[seat].hand.map(c => cardEl(c).outerHTML).join('')}</div>`;
          }
          let remain = 5;
          const cd = setInterval(() => {
            remain--;
            if (remain <= 0) {
              clearInterval(cd);
              let allTaken = [];
              g.players.forEach(pl => allTaken.push(...pl.hand));
              const taken = allTaken.filter(c => ['10', 'J', 'Q', 'K', 'A'].includes(c.rank));
              g.points[seat] += taken.length;
              g.players[seat].taken.push(...taken);
              g.players[seat].roundTaken.push(...taken);
              g.players[seat].roundPoints = (g.players[seat].roundPoints || 0) + taken.length;
              g.players.forEach(pl => pl.hand = []);
              g.trickNo = 10;
              finishGame();
            } else {
              const el = p?.querySelector('.micro-copy');
              if (el) el.textContent = `手札を確認してください（${remain}秒後に確定）`;
            }
          }, 1000);
          return;
        }
      }

      const result = await computeBotPlay(seat);
      if (g.phase !== 'play' || g.active !== seat) return;
      if (result && result.card && legalCardsList.some(x => x.id === result.card.id)) {
        addGameLog(`[COM思考] ${name(seat)} : ${result.source}`);
        logPlayDecision(seat, result.card, { reason: 'ai-tactics-' + result.source }, buildPlayContext(seat));
        play(seat, result.card);
      } else {
        const fallback = legalCardsList[Math.floor(Math.random() * legalCardsList.length)];
        addDebugLog('play-fallback-random', { seat, fallback: fallback.id });
        addGameLog(`[COM思考] ${name(seat)} : ランダム(エラー)`);
        play(seat, fallback);
      }
    } catch (e) {
      console.error("Bot Error:", e);
      const errSeat = g.active;
      addDebugLog('bot-error', { seat: errSeat, message: e?.message });
      addGameLog("⚠️ COM思考エラー: " + (e?.message || String(e)));
      const l = legal(errSeat);
      if (l.length) { const random = l[Math.floor(Math.random() * l.length)]; play(errSeat, random); }
      else { g.active = (errSeat + 1) % 5; playTurn(); }
    }
  }, 650 + Math.random() * 550);
}

function artfulCard(entry, trick) { const c = entry.card, led = trick[0].card.suit, black = s => s === '♣' || s === '♠'; return c.id === '♠A' || c.id === '♥Q' && trick.some(x => x.card.id === '♠A') || c.rank === 'J' && g.contract.suit !== 'NT' && (c.suit === g.contract.suit || c.suit !== g.contract.suit && black(c.suit) === black(g.contract.suit)) || c.rank === '2' && c.suit === led && trick.every(x => x.card.suit === led); }

function play(i, c) {
  if (g.onlineState && g.room) { g.room?.send({ type: 'game', action: { type: 'play', card: c.id } }); g.selectedCard = null; $('play-panel')?.classList.add('hidden'); stopTurnTimer(); return; }
  if (g.phase !== 'play' || g.active !== i || !legal(i).some(x => x.id === c.id)) return;

  // ★ N40: プール消費
  if (i === g.mySeat && g.turnStartAt) {
    const elapsed = (Date.now() - g.turnStartAt) / 1000;
    const consumed = Math.max(0, elapsed - PLAY_FREE_SECONDS);
    g.playPools[i] = Math.max(0, (g.playPools[i] || PLAY_POOL_SECONDS) - consumed);
  }

  if (!g.trick.length) g.lastTrickWinner = null;
  const previous = g.trick.length ? winning() : null;
  g.selectedCard = null;
  g.waitingAutoPlay = false;
  $('play-panel')?.classList.add('hidden');
  let h = g.players[i].hand;
  h.splice(h.findIndex(x => x.id === c.id), 1);
  g.trick.push({ player: i, card: c });
  g.playedCards.push({ suit: c.suit, rank: c.rank, id: c.id, seat: i });
  if (i === g.mySeat && g.humanRoundLog && g.contract) {
    const role = g.contract.nap === g.mySeat ? 'nap' : (!g.contract.solo && g.contract.revealedCall && g.contract.deputy === g.mySeat ? 'dep' : 'ally');
    const phase = trickPhaseOf(g.trickNo);
    const pointsTier = pointsTierOf(g.trick.filter(e => POINT.includes(e.card.rank)).length);
    const rankTier = rankTierOf(c.rank);
    g.humanRoundLog.playDecisions.push({ trickNo: g.trickNo, role, phase, pointsTier, rankTier, won: null });
  }
  if (g.trick.length > 1) { const ledSuit = g.trick[0].card.suit; if (c.suit !== ledSuit) { if (!g.voids[i]) g.voids[i] = {}; g.voids[i][ledSuit] = true; } }
  if (artfulCard({ player: i, card: c }, g.trick)) g.matchStats[i].artAttempts = (g.matchStats[i].artAttempts || 0) + 1;
  const reveal = g.contract.call?.id === c.id && !g.contract.revealedCall;
  addGameLog(name(i) + 'が' + c.id + 'を出した' + (reveal ? '（指名札）' : ''));
  if (reveal) {
    g.contract.revealedCall = true;
    g.contract.revealTrickNo = g.trickNo;
    if (g.contract.solo) addGameLog('指名札公開、ひとり立ち');
    else addGameLog('指名札公開、副官は' + name(g.contract.deputy));
    if (g.round >= 10 && !g.contract.solo) {
      const r = computeTeamMinBid(g.matchScores, g.mult, g.contract.nap, g.contract.deputy);
      if (r !== null) {
        const oldBid = g.contract.num;
        const caseLabel = { A: '組んだら', B: '逆組み', C: '通常' }[r.case];
        if (!r.achievable) { toast('副官判明（' + caseLabel + '）：20枚でも逆転不可能（不可）'); message('副官判明：20枚でも逆転不可能'); }
        else if (r.minBid > oldBid) { g.contract.num = r.minBid; renderContractInfo(); drawSeats(); toast('副官判明：立ちを ' + oldBid + '枚 → ' + r.minBid + '枚 に引き上げ（' + caseLabel + '）'); message('副官判明により立ちを ' + r.minBid + '枚へ引き上げました'); }
        else { addGameLog('副官判明：立ち ' + oldBid + '枚は最低条件 ' + r.minBid + '枚を満たしています（' + caseLabel + '）'); }
      }
    }
  }
  if (previous && g.contract.revealedCall) { const team = seat => seat === g.contract.nap || seat === g.contract.deputy ? 'nap' : 'alliance'; if (team(i) === team(previous.player) && winning().player === i) g.roundArt[i]--; }
  $('trick-cards')?.append(cardEl(c, 'trick-card played-seat-' + i));

  if (g.trick.length < 5) {
    g.active = (i + 1) % 5;
    // ★ N40: 次ターン開始
    g.turnStartAt = Date.now();
    const free = PLAY_FREE_SECONDS;
    const pool = g.playPools[g.active] || PLAY_POOL_SECONDS;
    g.deadline = Date.now() + (free + Math.max(0, pool)) * 1000;
    playTurn();
    return;
  }

  g.phase = 'trick-end';
  stopTurnTimer();
  const winningEntryObj = winning(), w = winningEntryObj.player, taken = g.trick.filter(e => POINT.includes(e.card.rank)).map(e => e.card);
  if (taken.length >= 3 && artfulCard(winningEntryObj, g.trick)) { g.matchStats[w].dramaticPlays = (g.matchStats[w].dramaticPlays || 0) + 1; if (g.roundArt[w] < 2) g.roundArt[w]++; }
  g.points[w] += taken.length;
  g.players[w].taken.push(...taken);
  g.players[w].roundTaken.push(...taken);
  g.players[w].roundPoints = (g.players[w].roundPoints || 0) + taken.length;
  if (!g.contract.solo && g.contract.deputy >= 0 && g.contract.deputy !== g.contract.nap) {
    const deputyEntry = g.trick.find(e => e.player === g.contract.deputy);
    if (deputyEntry && POINT.includes(deputyEntry.card.rank)) {
      g.matchStats[g.contract.deputy].allyFeedAttempts = (g.matchStats[g.contract.deputy].allyFeedAttempts || 0) + 1;
      if (w === g.contract.nap || w === g.contract.deputy) { g.matchStats[g.contract.deputy].allyFeedSuccesses = (g.matchStats[g.contract.deputy].allyFeedSuccesses || 0) + 1; }
    }
  }
  addGameLog(name(w) + 'が第' + (g.trickNo + 1) + '勝負を獲得（' + taken.length + '点札）');
  g.lastTrickWinner = w;
  g.active = w;
  if (g.humanRoundLog && g.contract) {
    const humanIsNapSide = g.contract.nap === g.mySeat || (!g.contract.solo && g.contract.deputy === g.mySeat);
    const napTeamWon = w === g.contract.nap || (!g.contract.solo && w === g.contract.deputy);
    const humanWonTrick = humanIsNapSide ? napTeamWon : !napTeamWon;
    for (const d of g.humanRoundLog.playDecisions) if (d.trickNo === g.trickNo && d.won === null) d.won = humanWonTrick;
  }
  const alliancePointsRaw = g.points.reduce((n, points, idx) => n + (idx !== g.contract.nap && (g.contract.solo || idx !== g.contract.deputy) ? points : 0), 0);
  const alliancePoints = alliancePointsRaw + (g.allianceKittyPoints || 0);
  const napPoints = g.points.reduce((n, points, idx) => n + (idx === g.contract.nap || (!g.contract.solo && idx === g.contract.deputy) ? points : 0), 0);
  const isEarlyFinish = alliancePoints > 20 - g.contract.num || (napPoints >= g.contract.num && (g.contract.num === 20 || alliancePoints >= 1));
  const isFinalTrick = g.trickNo >= 9;
  const willFinish = isEarlyFinish || isFinalTrick;

  if (willFinish) {
    message(name(w) + 'が' + (isFinalTrick ? '最終トリック' : '決着トリック') + 'を獲得');
    drawSeats();
    addGameLog((isFinalTrick ? '最終トリック' : '決着トリック') + '勝者: ' + name(w));
    later(() => finishGame(), 2200);
    return;
  }
  message(name(w) + 'が場札を取りました');
  drawSeats();

  if (g.trickResetTimer) clearTimeout(g.trickResetTimer);
  const expectedTrickNo = g.trickNo;
  g.trickResetTimer = setTimeout(() => {
    g.trickResetTimer = null;
    if (g.phase !== 'trick-end' || g.trickNo !== expectedTrickNo) return;
    g.trickNo++;
    if (g.trickNo >= 10) { finishGame(); return; }
    g.trick = [];
    $('trick-cards')?.replaceChildren();
    g.phase = 'play';
    // ★ N40: 次ターン開始
    g.turnStartAt = Date.now();
    const free = PLAY_FREE_SECONDS;
    const pool = g.playPools[g.active] || PLAY_POOL_SECONDS;
    g.deadline = Date.now() + (free + Math.max(0, pool)) * 1000;
    message(name(w) + 'から次の勝負');
    playTurn();
  }, 1250);
}

// ============================================================
// 結果処理（★ D1-D7: ART廃止、順位点のみ、COM戦レート送信）
// ============================================================
function finishGame() {
  g.phase = 'result';
  clearTimeout(g.trickResetTimer);
  // ★ N20: autoNextTimer 防御
  clearInterval(g.autoNextTimer);
  stopTurnTimer();
  const c = g.contract;
  const side = c.solo ? [c.nap] : [c.nap, c.deputy];
  const pts = side.reduce((n, i) => n + g.points[i], 0);
  const success = pts >= c.num && (c.num === 20 || pts < 20);
  const exact = success && pts === c.num;
  const bold = c.num >= 15;
  const napStat = g.matchStats[c.nap];
  napStat.declarerAttempts++; napStat.bidTotal += c.num;
  if (success) napStat.declarerSuccesses++;
  napStat.exactAttempts++;
  if (exact) napStat.exactSuccesses++;
  if (bold) { napStat.boldAttempts++; if (exact) napStat.boldSuccesses++; }
  if (c.solo) { napStat.soloAttempts++; if (success) napStat.soloSuccesses++; }
  if (!c.solo && c.deputy !== c.nap) { const depStat = g.matchStats[c.deputy]; depStat.deputyAttempts++; if (success) depStat.deputySuccesses++; }
  sendRoundLearn(success);

  let finalRule = g.round >= 10 ? finalAuctionRule(g.matchScores, g.mult) : null, sign = success ? 1 : -1, unit = Math.max(0, c.num - 12) * g.mult * (g.round >= 10 ? 2 : 1), scores = Array(5).fill(0);
  scores[c.nap] = sign * unit * (c.solo ? 4 : 2);
  if (c.solo) { g.players.forEach((_, i) => { if (i !== c.nap) scores[i] = -sign * unit; }); }
  else { scores[c.deputy] = sign * unit; g.players.forEach((_, i) => { if (i !== c.nap && i !== c.deputy) scores[i] = -sign * unit; }); }

  // ★ D1: ART廃止（内部記録のみ保持、スコアには不使用）
  const art = g.roundArt.slice();
  if (success && pts === c.num) { art[c.nap] += 2; if (!c.solo) art[c.deputy] += 1; if (c.num >= 15) { art[c.nap] += 2; if (!c.solo) art[c.deputy] += 1; } }
  if (c.solo) art[c.nap] += success ? 4 : 2;
  if (!success && !c.solo && c.num - pts >= 3) { art[c.nap] -= 2; art[c.deputy] -= 1; }
  for (let i = 0; i < 5; i++) { g.matchScores[i] += scores[i]; g.matchArt[i] += art[i]; }
  g.matchContracts.push({ round: g.round, nap: c.nap, deputy: c.deputy, num: c.num, suit: c.suit, solo: c.solo, points: pts, napWin: success, revealTrickNo: c.revealTrickNo ?? null, takenPoints: g.players.map(p => p.roundPoints || 0), allianceKittyPoints: g.allianceKittyPoints, strengthAtBid: c.strengthAtBid ?? 8, mult: g.mult || 1 });

  const replayAllLast = !!(finalRule && scores[finalRule.bottomSeat] > 0 && g.matchScores[finalRule.bottomSeat] === g.matchScores[finalRule.fourthSeat]);

  // ★ N3/N4/N9: プレーオフカウント管理と上限判定
  let final = g.round >= 10 && !replayAllLast;
  let forceBreak = false;
  if (replayAllLast) {
    g.playoff = true;
    g.playoffCount = (g.playoffCount || 0) + 1;
    if (g.playoffCount >= PLAYOFF_MAX_ITERATIONS) {
      forceBreak = true;
      final = true;
    }
  } else if (g.playoff && g.round >= 10) {
    g.playoff = false;
  }

  const format = n => (n > 0 ? '+' : '') + (Number.isInteger(n) ? n : n.toFixed(1));
  const role = i => i === c.nap ? 'NAP' : (!c.solo && i === c.deputy ? 'DEPUTY' : 'ALLY');
  const rows = g.players.map((_, i) => '<div class="round-score-row"><span>' + name(i) + ' · ' + role(i) + '</span><strong class="' + (scores[i] < 0 ? 'score-down' : 'score-up') + '">ROUND Δ ' + format(scores[i]) + '<small>TOTAL ' + format(g.matchScores[i]) + '</small></strong></div>').join('');

  const ratings = final ? matchRatingChanges(g.matchScores, [], { forceBreakTie: forceBreak }) : null;
  let combinedDelta = 0;

  if (final && ratings) {
    combinedDelta = ratings[g.mySeat].delta;
    if (!g.onlineState) {
      // ★ COM戦: 独立レート + 非公開（/api/com-match/finish）
      g.comRate = Math.max(100, Math.round(g.comRate + combinedDelta));
      const rl = $('rating-label'); if (rl) rl.textContent = g.comRate;
      if (g.sessionToken) {
        const stat = g.matchStats[g.mySeat] || {};
        const payload = {
          delta: combinedDelta, placement: ratings[g.mySeat].placement, outcome: ratings[g.mySeat].outcome,
          tie: ratings[g.mySeat].tie,
          stats: {
            declarerAttempts: stat.declarerAttempts || 0, declarerSuccesses: stat.declarerSuccesses || 0,
            deputyAttempts: stat.deputyAttempts || 0, deputySuccesses: stat.deputySuccesses || 0,
            exactAttempts: stat.exactAttempts || 0, exactSuccesses: stat.exactSuccesses || 0,
            soloAttempts: stat.soloAttempts || 0, soloSuccesses: stat.soloSuccesses || 0,
            boldAttempts: stat.boldAttempts || 0, boldSuccesses: stat.boldSuccesses || 0,
            allyFeedAttempts: stat.allyFeedAttempts || 0, allyFeedSuccesses: stat.allyFeedSuccesses || 0,
            bidTotal: stat.bidTotal || 0, ntBids: stat.ntBids || 0, colorBids: stat.colorBids || 0
          }
        };
        fetch('/api/com-match/finish', {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-session-token': g.sessionToken },
          body: JSON.stringify(payload)
        }).then(r => r.json()).then(d => {
          if (d && d.ok) {
            g.comRate = d.comRating;
            if (g.account) g.account.com_rating = d.comRating;
          }
        }).catch(e => console.warn('COM戦レート保存失敗', e));
      }
      if (g.account) g.account.com_rating = g.comRate;
    } else {
      g.rate += combinedDelta;
      g.elo = g.rate;
      const rl = $('rating-label'); if (rl) rl.textContent = g.rate;
    }
    ratings[g.mySeat].delta = combinedDelta;
  }

  phase('結果');
  addGameLog((success ? 'ナポレオン軍成功' : '連合軍成功') + ' · 宣言 ' + c.num + '枚 / 獲得 ' + pts + '枚（捨て札連合軍' + g.allianceKittyPoints + 'pt）' + (c.solo ? ' · ひとり立ち' : ''));
  message(replayAllLast ? (forceBreak ? 'プレーオフ10回上限：タイブレーク' : 'プレーオフ') : success ? 'NAP TEAM WINS' : 'ALLIANCE WINS');
  drawSeats();

  const finalTrickWinnerName = g.lastTrickWinner != null ? name(g.lastTrickWinner) : null;
  const finalRows = final ? g.players.map((_, i) => {
    const result = ratings[i];
    const rankLabel = result.tie ? result.placement + '位（' + result.tie.count + '人同着）' : result.placement + '位';
    return '<div class="round-score-row"><span>' + name(i) + ' · MATCH ' + format(g.matchScores[i]) + '</span><strong class="' + (result.delta < 0 ? 'score-down' : 'score-up') + '">RATE Δ ' + format(result.delta) + '<small>順位 ' + rankLabel + (forceBreak && result.tie?.broken ? ' · タイブレーク' : '') + '</small></strong></div>';
  }).join('') : '';

  const r = $('result-panel');
  if (!r) return;
  r.classList.remove('hidden');
  r.innerHTML = '<div class="eyebrow">' + (g.playoff ? 'プレーオフ' : g.round === 9 ? 'ラス前' : g.round >= 10 ? 'オールラスト' : 'ROUND ' + String(g.round).padStart(2, '0')) + ' · RESULT</div>' +
    '<h2>' + (success ? 'NAP TEAM WINS' : 'ALLIANCE WINS') + '</h2>' +
    '<p>BID ' + c.num + c.suit + ' · POINTS ' + pts + (c.solo ? ' · ひとり立ち' : '') + '<br>NAP ' + name(c.nap) + (c.solo ? '' : ' · DEPUTY ' + name(c.deputy)) + (g.allianceKittyPoints > 0 ? '<br>捨て札: ' + g.allianceKittyPoints + 'pt（連合軍共有）' : '') + '</p>' +
    (finalTrickWinnerName ? '<p class="micro-copy">最終トリック勝者: ' + finalTrickWinnerName + '</p>' : '') +
    (replayAllLast ? '<p>' + (forceBreak ? 'プレーオフ10回上限。席番号順でタイブレークします。' : '5位が4位に並びました。プレーオフを行います。') + '</p>' : '') +
    '<div class="round-score-list"><div class="micro-copy">ROUND SCORE</div>' + rows + '</div>' +
    (final ? '<div class="round-score-list"><div class="micro-copy">MATCH COMPLETE</div>' + finalRows + '</div>' : '') +
    '<button id="next-round" class="primary-button">' + (final ? 'MENU' : replayAllLast ? (forceBreak ? 'タイブレーク結果へ' : 'プレーオフ再戦') : 'NEXT ROUND') + '</button>' +
    '<div id="auto-next-countdown" class="micro-copy" style="margin-top:8px;min-height:14px;"></div>';

  clearInterval(g.autoNextTimer);
  const nr = $('next-round');
  if (nr) nr.onclick = () => {
    clearInterval(g.autoNextTimer);
    r.classList.add('hidden');
    if (final) { screen('home-screen'); return; }
    if (g.onlineState && g.room) g.room?.send({ type: 'game', action: { type: 'next-round' } });
    else {
      // ★ N3: プレーオフ中は round 据え置き
      if (!g.playoff) { g.round++; g.playoffCount = 0; }
      g.mult = 1; g.greenRedraws = 0;
      roundStart();
    }
  };
  if (!final) {
    let remain = 6;
    const cd = $('auto-next-countdown');
    if (cd) cd.textContent = remain + '秒後に次の局へ…';
    g.autoNextTimer = setInterval(() => {
      if (r.classList.contains('hidden')) { clearInterval(g.autoNextTimer); return; }
      remain--;
      if (remain <= 0) {
        clearInterval(g.autoNextTimer);
        r.classList.add('hidden');
        if (g.onlineState && g.room) g.room?.send({ type: 'game', action: { type: 'next-round' } });
        else {
          if (!g.playoff) { g.round++; g.playoffCount = 0; }
          g.mult = 1; g.greenRedraws = 0;
          roundStart();
        }
      } else if (cd) cd.textContent = remain + '秒後に次の局へ…';
    }, 1000);
  }
}

function showOnlineResult() {
  const r = $('result-panel');
  if (!r || !(g.onlineState && g.room) || !g.onlineState.result) return;
  const res = g.onlineState.result;
  const success = res.made;
  const format = n => (n > 0 ? '+' : '') + n;
  const role = i => i === res.nap ? 'NAP' : (!res.solo && i === res.deputy ? 'DEPUTY' : 'ALLY');

  const rows = res.scoreChanges.map(sc => {
    return `<div class="round-score-row"><span>${escapeHTML(name(sc.seat))} · ${role(sc.seat)}</span><strong class="${sc.delta < 0 ? 'score-down' : 'score-up'}">ROUND Δ ${format(sc.delta)}<small>TOTAL ${format(res.matchScores[sc.seat])}</small></strong></div>`;
  }).join('');

  const final = g.onlineState.phase === 'result';
  const placements = res.placements || [];
  const ties = res.ties || [];
  const isRanked = g.onlineState.mode === 'ranked';

  let rankingHtml = '';
  let ratingHtml = '';
  if (final) {
    const rankRows = res.matchScores.map((score, seat) => ({ seat, score, rank: placements[seat] || 0, tie: ties[seat] }))
      .sort((a, b) => a.rank - b.rank).map(item => {
        const medal = item.rank === 1 ? '🥇' : item.rank === 2 ? '🥈' : item.rank === 3 ? '🥉' : '';
        const tieLabel = item.tie ? `（${item.tie.count}人同着）` : '';
        return `<div class="round-score-row"><span>${item.rank}位 ${medal} ${escapeHTML(name(item.seat))}${tieLabel}</span><strong>${format(item.score)} pt</strong></div>`;
      }).join('');
    rankingHtml = `<div class="round-score-list"><div class="micro-copy">FINAL RANKING</div>${rankRows}</div>`;
    if (isRanked && Array.isArray(res.ratingChanges) && res.ratingChanges[g.mySeat]) {
      const my = res.ratingChanges[g.mySeat];
      const sign = my.delta >= 0 ? '+' : '';
      const color = my.delta >= 0 ? '#a9d2ae' : '#e89685';
      const sub = my.abandoned ? `（順位 ${my.placement}位 ${format(my.baseDelta)} + 放棄 ${my.abandonPenalty}）` : `（順位 ${my.placement}位${my.tie ? ' ' + my.tie.count + '人同着' : ''}）`;
      ratingHtml = `<p style="font-size:16px;color:${color};margin-top:12px;font-weight:700;">RATE Δ ${sign}${my.delta} <small style="font-weight:400;color:#a3b1a8;">${sub}</small></p>`;
    }
  }

  r.classList.remove('hidden');
  r.innerHTML = `
    <div class="eyebrow">${final ? 'MATCH COMPLETE' : 'ROUND ' + res.round} · RESULT</div>
    <h2>${success ? 'NAP TEAM WINS' : 'ALLIANCE WINS'}</h2>
    <p>BID ${res.bid}${res.suit} · POINTS ${res.points}${res.solo ? ' · ひとり立ち' : ''}<br>
    NAP ${escapeHTML(name(res.nap))}${res.solo ? '' : ` · DEPUTY ${escapeHTML(name(res.deputy))}`}
    ${res.allianceKittyPoints > 0 ? `<br>捨て札: ${res.allianceKittyPoints}pt（連合軍共有）` : ''}</p>
    ${res.lastTrickWinner != null ? `<p class="micro-copy">最終トリック勝者: ${escapeHTML(name(res.lastTrickWinner))}</p>` : ''}
    ${res.allLastReplay ? '<p>5位が4位に並びました。プレーオフを行います。</p>' : ''}
    <div class="round-score-list"><div class="micro-copy">ROUND SCORE</div>${rows}</div>
    ${rankingHtml}
    ${ratingHtml}
    <button id="next-online-round" class="primary-button" style="margin-top:14px;">${final ? 'MENU' : res.allLastReplay ? 'プレーオフ再戦' : 'NEXT ROUND'}</button>
  `;

  const nr = $('next-online-round');
  if (nr) nr.onclick = () => {
    r.classList.add('hidden');
    if (final) { g.intentionalLeave = true; closeOnline(); screen('home-screen'); }
    else g.room.send({ type: 'game', action: { type: 'next-round' } });
  };

  if (!final) {
    clearInterval(g.onlineResultTimer);
    let remain = 8;
    const div = document.createElement('div');
    div.className = 'micro-copy online-countdown';
    div.style.marginTop = '8px';
    div.style.minHeight = '14px';
    div.textContent = remain + '秒後に次の局へ…';
    r.appendChild(div);
    g.onlineResultTimer = setInterval(() => {
      if (r.classList.contains('hidden')) { clearInterval(g.onlineResultTimer); return; }
      remain--;
      if (remain <= 0) { clearInterval(g.onlineResultTimer); r.classList.add('hidden'); }
      else div.textContent = remain + '秒後に次の局へ…';
    }, 1000);
  }
}

function addTakenCards(seat, cards = []) {
  const row = document.createElement('div');
  row.className = 'taken-cards';
  const label = document.createElement('span');
  label.className = 'taken-label';
  label.textContent = '獲得 ' + cards.length;
  row.append(label);
  cards.slice().sort((a, b) => SV[a.suit] - SV[b.suit] || RANKS.indexOf(a.rank) - RANKS.indexOf(b.rank)).forEach(c => {
    const tag = document.createElement('span');
    tag.className = 'taken-card ' + color(c.suit);
    tag.textContent = c.suit + c.rank;
    row.append(tag);
  });
  seat.append(row);
}

function drawSeats() {
  let box = $('players-ring'); if (!box) return;
  box.replaceChildren();
  const leadSeat = g.phase === 'play' && g.trick.length ? g.trick[0].player : g.lastTrickWinner;
  g.players.forEach((p, i) => {
    let e = document.createElement('div');
    e.className = 'player-seat player-color-' + i + ' pos-' + i + (i === g.mySeat ? ' me' : '') + (i === g.active ? ' active' : '') + (i === leadSeat ? ' trick-winner' : '');
    // ★ N11: approved は auction.approved から参照
    let role = g.contract
      ? (g.contract.nap === i ? 'ナポレオン' : !g.contract.revealedCall ? '' : g.contract.deputy === i ? '副官' : '連合軍')
      : (g.phase === 'auction' && g.auction && g.auction.approved && g.auction.approved[i]) ? '保留中' : '';
    e.classList.toggle('deputy-seat', role === '副官');
    // ★ N42: プレイフェーズ中はプール残量を小さく表示（自分以外）
    let poolBadge = '';
    if (g.phase === 'play' && i !== g.mySeat && g.playPools && typeof g.playPools[i] === 'number') {
      poolBadge = `<div class="pool-badge">${Math.max(0, g.playPools[i]).toFixed(0)}s</div>`;
    }
    e.innerHTML = '<div class="seat-name">' + name(i) + (p.bot && !p.abandoned ? '<span class="com-badge">COM</span>' : '') + '</div>' +
      (i === leadSeat ? '<div class="lead-badge" role="img" aria-label="トリック先攻"><i></i></div>' : '') +
      '<div class="seat-role ' + (role === '副官' ? 'deputy-status' : '') + '">' + role + '</div>' + poolBadge;
    addTakenCards(e, p.taken || []);
    box.append(e);
  });
}

function announceCall(card, onConfirm, online = false) {
  const d = $('message-dialog'), slot = $('dialog-card');
  if (!d || !slot) return;
  $('dialog-eyebrow')?.classList.add('hidden');
  const dt = $('dialog-title'); if (dt) dt.textContent = 'DEPUTY CALL';
  slot.classList.remove('hidden');
  slot.replaceChildren(cardEl(card, 'announcement-card'));
  const db = $('dialog-body');
  if (db) db.textContent = online ? '全員が確認すると最初のトリックが始まります。' : '確認して、最初のトリックを始めます。';
  const dok = $('dialog-ok');
  if (dok) dok.textContent = online ? '確認' : '最初のトリックへ';
  if (dok) dok.onclick = () => {
    d.close(); slot.classList.add('hidden'); slot.replaceChildren();
    $('dialog-eyebrow')?.classList.remove('hidden');
    const de = $('dialog-eyebrow'); if (de) de.textContent = 'Napoleon';
    if (dok) dok.textContent = 'OK';
    if (onConfirm) onConfirm();
  };
  try { if (d.open) d.close(); } catch { }
  d.showModal();
}

// ===== [app.js Part 2/3 終了] =====
// ===== [app.js Part 3/3 開始] =====

// ============================================================
// ★ N33: ホスト端末COM計算のWorkerバインド
// ============================================================
function bindHostBotWorker() {
  const w = aiWorkers[0];
  if (!w || w.__botResultBound) return;
  w.__botResultBound = true;
  w.addEventListener('message', (e) => {
    if (!e.data || !e.data.type) return;
    if (e.data.type === 'compute-bot-result') {
      if (g.room && g.room.send) {
        try { g.room.send({ type: 'game', action: { type: 'bot-move-result', requestId: e.data.requestId, cardId: e.data.cardId } }); } catch {}
      }
    } else if (e.data.type === 'compute-bot-error') {
      console.warn('[host bot compute error]', e.data.error);
    }
  });
}
bindHostBotWorker();

function broadcastKeyToWorkers(keyHex) {
  aiWorkers.forEach(w => { try { w.postMessage({ type: 'set-key', keyHex }); } catch {} });
}

// ============================================================
// ★ 過去対局（IndexedDB）E1〜E7
// ============================================================
const HISTORY_DB_NAME = 'napoleon-history';
const HISTORY_DB_VERSION = 1;
function openHistoryDB() {
  return new Promise((resolve, reject) => {
    if (!window.indexedDB) { reject(new Error('IndexedDB unsupported')); return; }
    const req = indexedDB.open(HISTORY_DB_NAME, HISTORY_DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('matches')) {
        const store = db.createObjectStore('matches', { keyPath: 'id' });
        store.createIndex('mode', 'mode', { unique: false });
        store.createIndex('timestamp', 'timestamp', { unique: false });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
async function saveMatchHistory(record) {
  try {
    const db = await openHistoryDB();
    await new Promise((resolve, reject) => {
      const tx = db.transaction('matches', 'readwrite');
      tx.objectStore('matches').put(record);
      tx.oncomplete = resolve; tx.onerror = () => reject(tx.error);
    });
    // FIFO: モードごとに10件まで
    const all = await getAllMatchHistory(record.mode);
    if (all.length > 10) {
      all.sort((a, b) => a.timestamp - b.timestamp);
      const toDelete = all.slice(0, all.length - 10);
      const tx = db.transaction('matches', 'readwrite');
      const store = tx.objectStore('matches');
      for (const m of toDelete) store.delete(m.id);
    }
  } catch (e) { console.warn('saveMatchHistory failed', e); }
}
async function getAllMatchHistory(mode = null) {
  try {
    const db = await openHistoryDB();
    return await new Promise((resolve, reject) => {
      const tx = db.transaction('matches', 'readonly');
      const store = tx.objectStore('matches');
      const req = mode ? store.index('mode').getAll(mode) : store.getAll();
      req.onsuccess = () => resolve(req.result || []);
      req.onerror = () => reject(req.error);
    });
  } catch (e) { return []; }
}
async function getMatchHistory(id) {
  try {
    const db = await openHistoryDB();
    return await new Promise((resolve, reject) => {
      const tx = db.transaction('matches', 'readonly');
      const req = tx.objectStore('matches').get(id);
      req.onsuccess = () => resolve(req.result || null);
      req.onerror = () => reject(req.error);
    });
  } catch (e) { return null; }
}
async function deleteMatchHistory(id) {
  try {
    const db = await openHistoryDB();
    await new Promise((resolve, reject) => {
      const tx = db.transaction('matches', 'readwrite');
      tx.objectStore('matches').delete(id);
      tx.oncomplete = resolve; tx.onerror = () => reject(tx.error);
    });
  } catch (e) {}
}

function computeAIAnalysis() {
  const decisions = g.humanRoundLog?.playDecisions || [];
  const total = decisions.length;
  const wins = decisions.filter(d => d.won === true).length;
  const winRate = total ? wins / total : 0;
  return {
    totalDecisions: total,
    wins, losses: total - wins, winRate,
    avgValueLoss: total ? (1 - winRate) : 0,
    recommendation: !total ? 'データ不足' : winRate >= 0.7 ? '良好：判断は安定しています' : winRate >= 0.5 ? '標準：やや改善の余地あり' : '改善推奨：リード選択を見直しましょう'
  };
}

function buildMatchRecord(mode) {
  const isFinal = (g.round >= 10) || g.phase === 'result';
  const finalRatings = isFinal ? matchRatingChanges(g.matchScores, [], { forceBreakTie: g.playoffCount >= PLAYOFF_MAX_ITERATIONS }) : null;
  const myDelta = finalRatings ? finalRatings[g.mySeat || 0] : null;
  return {
    id: `m-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    mode, timestamp: Date.now(), date: new Date().toISOString(),
    round: g.round, matchScores: [...g.matchScores], matchArt: [...g.matchArt],
    placements: finalRatings ? finalRatings.map(r => r.placement) : [],
    ties: finalRatings ? finalRatings.map(r => r.tie) : [],
    ratingDelta: myDelta ? myDelta.delta : 0,
    contracts: (g.matchContracts || []).map(c => ({ ...c })),
    players: (g.players || []).map((p, i) => ({ name: p.username || p.name || ('COM ' + i), bot: !!p.bot, abandoned: !!p.abandoned })),
    finalResult: finalRatings ? { placements: finalRatings.map(r => r.placement), deltas: finalRatings.map(r => r.delta), ties: finalRatings.map(r => r.tie) } : null,
    playDecisions: (g.humanRoundLog?.playDecisions || []).map(d => ({ ...d })),
    aiAnalysis: computeAIAnalysis(),
  };
}

// ★ finishGame ラップ（final 保存）
const __origFinishGame = finishGame;
finishGame = function () {
  const before = g.phase;
  try { __origFinishGame.apply(this, arguments); } catch (e) { console.error(e); }
  if (g.phase === 'result' && before !== 'result') {
    const mode = (g.onlineState && g.room) ? (g.onlineState.mode === 'ranked' ? 'ranked' : 'friend') : 'local';
    if (mode === 'local') {
      try { saveMatchHistory(buildMatchRecord('local')); } catch (e) {}
    }
  }
};
const __origShowOnlineResult = showOnlineResult;
showOnlineResult = function () {
  const before = g.onlineState?.phase;
  try { __origShowOnlineResult.apply(this, arguments); } catch (e) { console.error(e); }
  if (g.onlineState?.phase === 'result' && before !== 'result') {
    const mode = g.onlineState.mode === 'ranked' ? 'ranked' : 'friend';
    try { saveMatchHistory(buildMatchRecord(mode)); } catch (e) {}
  }
};

// ============================================================
// 過去対局画面
// ============================================================
let __pastGamesTab = 'local';
async function openPastGamesScreen() {
  const wrap = $('past-games-content');
  if (!wrap) return;
  wrap.innerHTML = '<p class="subcopy">読み込み中…</p>';
  await renderPastGames();
}
async function renderPastGames() {
  const wrap = $('past-games-content');
  if (!wrap) return;
  const all = await getAllMatchHistory();
  const modeLabel = { local: 'COM戦', ranked: 'レート戦', friend: '友人戦' };
  const grouped = { local: [], ranked: [], friend: [] };
  for (const m of all) if (grouped[m.mode]) grouped[m.mode].push(m);
  for (const k in grouped) grouped[k].sort((a, b) => b.timestamp - a.timestamp);

  const tabHTML = ['local', 'ranked', 'friend'].map(m => `<button class="tab-btn ${__pastGamesTab === m ? 'active' : ''}" data-past-tab="${m}">${modeLabel[m]}（${grouped[m].length}）</button>`).join('');
  const list = grouped[__pastGamesTab] || [];
  const listHTML = list.length ? list.map(m => {
    const date = new Date(m.timestamp);
    const dateStr = `${date.getMonth() + 1}/${date.getDate()} ${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
    const myRank = m.placements?.[0] || '—';
    const delta = m.ratingDelta || 0;
    const sign = delta >= 0 ? '+' : '';
    return `<article class="past-match-card" data-past-id="${m.id}"><div class="past-match-head"><span class="past-date">${dateStr}</span><span class="past-rank">順位 ${myRank}位</span><span class="past-delta ${delta >= 0 ? 'score-up' : 'score-down'}">Δ ${sign}${delta.toFixed(1)}</span></div><div class="past-match-body"><span>スコア: ${(m.matchScores || []).join(' / ')}</span></div></article>`;
  }).join('') : '<p class="subcopy" style="text-align:center;padding:24px 0;">まだ履歴はありません</p>';

  wrap.innerHTML = `<div class="past-tabs">${tabHTML}</div><div class="past-list">${listHTML}</div>`;
  wrap.querySelectorAll('[data-past-tab]').forEach(b => b.onclick = () => { __pastGamesTab = b.dataset.pastTab; renderPastGames(); });
  wrap.querySelectorAll('[data-past-id]').forEach(el => el.onclick = () => openPastGameDetail(el.dataset.pastId));
}
async function openPastGameDetail(id) {
  const m = await getMatchHistory(id);
  if (!m) { toast('履歴が見つかりません'); return; }
  const wrap = $('past-games-content');
  if (!wrap) return;
  const date = new Date(m.timestamp).toLocaleString();
  const contracts = (m.contracts || []).map((c, i) => {
    const result = c.napWin ? 'NAP WIN' : 'ALLY WIN';
    return `<div class="round-score-row"><span>第${i + 1}局 ${c.num}${c.suit}${c.solo ? ' (solo)' : ''}</span><strong>${result} · ${c.points}枚</strong></div>`;
  }).join('');
  const analysis = m.aiAnalysis || {};
  wrap.innerHTML = `<button class="back-button" id="past-back">← 一覧へ</button>
    <div class="past-detail">
      <div class="eyebrow">MATCH DETAIL</div>
      <h2>${date}</h2>
      <div class="past-detail-meta">モード: ${m.mode} | 順位: ${m.placements?.[0] || '—'}位 | Δ ${(m.ratingDelta || 0).toFixed(1)}</div>
      <h3 class="section-title">局別結果</h3>
      <div class="round-score-list">${contracts || '<p class="subcopy">記録なし</p>'}</div>
      <h3 class="section-title">AI分析</h3>
      <div class="performance-grid">
        <article class="performance-card"><span>総プレイ判断</span><strong>${analysis.totalDecisions || 0}</strong><small>勝ち ${analysis.wins || 0} / 負け ${analysis.losses || 0}</small></article>
        <article class="performance-card"><span>判断一致率</span><strong>${((analysis.winRate || 0) * 100).toFixed(1)}%</strong><small>${analysis.recommendation || '—'}</small></article>
      </div>
      <div class="panel-row" style="margin-top:16px;">
        <button class="primary-button" id="past-dl-json">AI分析用JSONをDL</button>
        <button class="secondary-button" id="past-delete">この履歴を削除</button>
      </div>
    </div>`;
  $('past-back').onclick = () => renderPastGames();
  $('past-dl-json').onclick = () => downloadAIJson(m);
  $('past-delete').onclick = async () => { if (confirm('この履歴を削除しますか？')) { await deleteMatchHistory(m.id); toast('削除しました'); renderPastGames(); } };
}
function downloadAIJson(match) {
  try {
    const payload = {
      version: 'ai-analysis-v1', generatedAt: new Date().toISOString(), match: {
        id: match.id, mode: match.mode, date: match.date, round: match.round,
        matchScores: match.matchScores, placements: match.placements, ties: match.ties,
        ratingDelta: match.ratingDelta, contracts: match.contracts, players: match.players,
        finalResult: match.finalResult, playDecisions: match.playDecisions, aiAnalysis: match.aiAnalysis
      }
    };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = `napoleon-analysis-${match.mode}-${Date.now()}.json`;
    document.body.appendChild(a); a.click();
    setTimeout(() => { document.body.removeChild(a); URL.revokeObjectURL(url); }, 100);
    toast('AI分析用JSONをダウンロードしました');
  } catch (e) { toast('ダウンロード失敗: ' + e.message); }
}

// ============================================================
// ★ A1: チャット + L1/L2/L3/L5: 待機中UI
// ============================================================
function showQueuePanel() {
  const area = $('queue-area');
  if (area) area.classList.remove('hidden');
  const inner = document.querySelector('.mode-select-inner');
  if (inner) inner.classList.add('queue-active');
  g.queueStartedAt = Date.now();
  if (!g.hilo.started) { g.hilo.started = true; hiloStart(); }
  renderChatLog();
  const qc = $('queue-count'); if (qc) qc.textContent = '1 / 5 人';
  updateQueueElapsed();
  if (window.__rebindChatFocus) window.__rebindChatFocus();
  // L5: 簡易戦績サマリ
  renderQuickStats();
  // L3: COMエスカレーション（30秒後）
  setTimeout(() => {
    if (!document.querySelector('.mode-select-inner.queue-active')) return;
    const esc = $('queue-escalation'); if (esc) esc.classList.remove('hidden');
  }, 30000);
}
function hideQueuePanel() {
  const area = $('queue-area');
  if (area) area.classList.add('hidden');
  const inner = document.querySelector('.mode-select-inner');
  if (inner) { inner.classList.remove('queue-active'); inner.style.removeProperty('height'); }
  const inp = $('chat-input');
  if (inp) { inp.value = ''; try { inp.blur(); } catch {} }
  const esc = $('queue-escalation'); if (esc) esc.classList.add('hidden');
}
function updateQueueElapsed() {
  const el = $('queue-elapsed');
  if (!el || !g.queueStartedAt) return;
  const sec = Math.floor((Date.now() - g.queueStartedAt) / 1000);
  const m = Math.floor(sec / 60), s = sec % 60;
  el.textContent = `待機中 ${m}:${String(s).padStart(2, '0')}`;
  if (document.querySelector('.mode-select-inner.queue-active')) setTimeout(updateQueueElapsed, 1000);
}
async function renderQuickStats() {
  const el = $('queue-stats');
  if (!el) return;
  try {
    const token = g.sessionToken || localStorage.getItem('napoleon_session');
    if (!token) { el.textContent = '戦績取得にはログインが必要です'; return; }
    const res = await fetch('/api/account/me', { headers: { 'x-session-token': token } });
    if (!res.ok) { el.textContent = ''; return; }
    const data = await res.json();
    const history = (data.history || []).slice(0, 5);
    if (!history.length) { el.textContent = '直近の対戦履歴はありません'; return; }
    el.innerHTML = '<div class="micro-copy" style="margin-bottom:4px;">直近5戦:</div>' + history.map(h => {
      const isWin = h.result === 'win', isLoss = h.result === 'loss';
      const cls = isWin ? 'score-up' : isLoss ? 'score-down' : '';
      const sign = h.delta >= 0 ? '+' : '';
      return `<span class="quick-stat ${cls}">${h.result === 'win' ? '○' : h.result === 'loss' ? '×' : '△'} ${sign}${h.delta}</span>`;
    }).join(' ');
  } catch { el.textContent = ''; }
}
function addChatMessage(m) {
  g.chatLog.push(m);
  if (g.chatLog.length > 100) g.chatLog.shift();
  renderChatLog();
}
function renderChatLog() {
  const el = $('chat-log');
  if (!el) return;
  if (!g.chatLog.length) {
    el.innerHTML = '<div style="color:rgba(160,175,210,.5);text-align:center;padding:20px 0;font-size:11px;">まだメッセージはありません<br>気軽に話しかけてみましょう</div>';
    return;
  }
  el.innerHTML = g.chatLog.slice(-50).map(m => `<div class="chat-message"><span class="chat-from">${escapeHTML(m.from)}</span><span class="chat-text">${escapeHTML(m.text)}</span></div>`).join('');
  el.scrollTop = el.scrollHeight;
}
function sendChat() {
  const inp = $('chat-input');
  if (!inp) return;
  const text = inp.value.trim();
  if (!text) return;
  if (!g.room) { toast('接続中です…'); return; }
  // ★ N10: 一意な名前
  const name = g.account?.id || ('ゲスト' + String((g.account?.id ? '' : (g.chatLog.length + 1))).slice(0, 3) + (g.room?.id?.slice(0, 4) || ''));
  try { g.room.send({ type: 'chat', text, name }); } catch { toast('送信に失敗しました'); return; }
  inp.value = '';
  inp.focus();
}
function bindChatInputFocus() {
  const inp = $('chat-input');
  if (!inp || inp._boundFocus) return;
  inp._boundFocus = true;
  inp.addEventListener('focus', () => {
    setTimeout(() => {
      try { inp.scrollIntoView({ behavior: 'smooth', block: 'nearest' }); } catch {}
      const log = $('chat-log');
      if (log) log.scrollTop = log.scrollHeight;
    }, 350);
  });
}
window.__rebindChatFocus = bindChatInputFocus;

// ============================================================
// ★ A2: ハイロー
// ============================================================
function hiloDraw() {
  const suits = ['♣', '♦', '♥', '♠'];
  const ranks = ['2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K', 'A'];
  return { suit: suits[Math.floor(Math.random() * 4)], rank: ranks[Math.floor(Math.random() * 13)] };
}
function hiloRankValue(c) { return ['2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K', 'A'].indexOf(c.rank); }
function hiloStart() { g.hilo.current = hiloDraw(); g.hilo.next = null; g.hilo.waiting = false; renderHilo(null); }
function hiloGuess(direction) {
  if (g.hilo.waiting || !g.hilo.current) return;
  g.hilo.waiting = true;
  const next = hiloDraw();
  g.hilo.next = next;
  const curV = hiloRankValue(g.hilo.current), nextV = hiloRankValue(next);
  let result;
  if (nextV === curV) result = 'tie';
  else if (direction === 'higher' && nextV > curV) result = 'win';
  else if (direction === 'lower' && nextV < curV) result = 'win';
  else result = 'lose';
  if (result === 'win') {
    g.hilo.streak++;
    if (g.hilo.streak > g.hilo.best) { g.hilo.best = g.hilo.streak; try { localStorage.setItem('napoleon_hilo_best', String(g.hilo.best)); } catch {} }
  } else if (result === 'lose') g.hilo.streak = 0;
  renderHilo(result);
  setTimeout(() => {
    if (!g.hilo.next) return;
    g.hilo.current = g.hilo.next; g.hilo.next = null; g.hilo.waiting = false;
    renderHilo(null);
  }, 1000);
}
function renderHilo(result) {
  const curEl = $('hilo-current'), nextEl = $('hilo-next');
  const streakEl = $('hilo-streak'), bestEl = $('hilo-best'), resultEl = $('hilo-result');
  const isRed = c => c && (c.suit === '♦' || c.suit === '♥');
  if (curEl && g.hilo.current) { curEl.className = 'hilo-card' + (isRed(g.hilo.current) ? ' red' : ''); curEl.innerHTML = `<span class="rank">${g.hilo.current.rank}</span><span class="suit">${g.hilo.current.suit}</span>`; }
  if (nextEl) {
    if (g.hilo.next) { nextEl.classList.remove('hidden'); nextEl.className = 'hilo-card' + (isRed(g.hilo.next) ? ' red' : ''); nextEl.innerHTML = `<span class="rank">${g.hilo.next.rank}</span><span class="suit">${g.hilo.next.suit}</span>`; }
    else nextEl.classList.add('hidden');
  }
  if (streakEl) streakEl.textContent = g.hilo.streak;
  if (bestEl) bestEl.textContent = g.hilo.best;
  if (resultEl) {
    if (!result) resultEl.textContent = '';
    else if (result === 'win') resultEl.innerHTML = '<span style="color:#a9d2ae">✓ 正解！</span>';
    else if (result === 'lose') resultEl.innerHTML = '<span style="color:#e89685">✗ 不正解…</span>';
    else resultEl.innerHTML = '<span style="color:#f3d48e">ー 引き分け</span>';
  }
}

// ============================================================
// ★ U2: 通知音・振動
// ============================================================
function notifyTurn() {
  try {
    if (navigator.vibrate) navigator.vibrate(80);
    const AC = window.AudioContext || window.webkitAudioContext;
    if (AC) {
      const ctx = new AC();
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'sine'; osc.frequency.value = 660;
      gain.gain.value = 0.05;
      osc.connect(gain); gain.connect(ctx.destination);
      osc.start(); osc.stop(ctx.currentTime + 0.08);
    }
  } catch {}
}

// ============================================================
// アカウント・プロフィール
// ============================================================
async function getUser() { try { g.user = await window.websim?.getUser?.() || null; } catch (e) { g.user = null; } return g.user; }

function renderAccount() {
  if (!g.account) return;
  const po = $('profile-open'); if (po) po.textContent = 'PROFILE';
  const ac = $('account-chip');
  if (ac) { ac.textContent = 'ID ' + g.account.id + ' · RATE ' + g.account.rating; ac.classList.remove('hidden'); ac.onclick = () => records('ranked'); }
  const pf = $('profile-form'); if (pf) pf.classList.add('hidden');
  const ps = $('profile-summary');
  if (ps) {
    ps.classList.remove('hidden');
    ps.innerHTML = '<div class="profile-emblem">♠</div><div><div class="eyebrow">PLAYER CARD</div><div class="profile-summary-id">' + g.account.id + '</div><div class="micro-copy">RATE ' + g.account.rating + ' · ' + g.account.wins + 'W · ' + g.account.losses + 'L</div></div><button type="button" id="open-my-page" class="secondary-button">VIEW PROFILE</button>';
    const omp = $('open-my-page'); if (omp) omp.onclick = () => records('ranked');
  }
}

async function account(path) {
  const idEl = $('account-id'), passEl = $('account-password');
  if (!idEl || !passEl) return;
  const id = idEl.value.trim(), password = passEl.value;
  if (!id || !password) { toast('IDとパスワードを入力してください'); return; }
  const payload = {
    id, password,
    dormPeriod: Number($('reg-dorm-period')?.value) || 310,
    favoriteSong: $('reg-favorite-song')?.value || '',
    career: $('reg-career')?.value || '',
    scarySenior: $('reg-scary-senior')?.value || '',
    infiniteFood: $('reg-infinite-food')?.value || '',
    favoriteStanding: $('reg-favorite-standing')?.value || ''
  };
  try {
    const r = await fetch(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) });
    const { data: d, parseError } = await readResponse(r);
    if (!r.ok || parseError) throw Error((d && d.error) || (parseError && 'JSON parse error') || '処理できませんでした');
    g.account = d; g.sessionToken = d.sessionToken || null;
    if (d.sessionToken) localStorage.setItem('napoleon_session', d.sessionToken);
    if (d.rating) g.rate = d.rating;
    if (d.com_rating) g.comRate = d.com_rating;
    renderAccount(); toast(path.endsWith('register') ? '登録しました' : 'ログインしました');
    records('ranked');
  } catch (e) { toast(sanitizeMessage(e.message) || '処理できませんでした'); }
}

async function loadAccount() {
  const token = localStorage.getItem('napoleon_session');
  if (!token) { g.sessionToken = null; renderHomeRating({ unregistered: true }); return; }
  g.sessionToken = token;
  try {
    const r = await fetch('/api/account/me', { headers: { 'x-session-token': token } });
    const { data } = await readResponse(r);
    if (r.ok && data) {
      g.account = data; g.sessionToken = token;
      if (data.rating) g.rate = data.rating;
      if (data.com_rating) g.comRate = data.com_rating;
      renderAccount(); renderHomeRating(g.account);
    } else if (r.status === 401 || r.status === 404) {
      localStorage.removeItem('napoleon_session'); g.sessionToken = null; renderHomeRating({ unregistered: true });
    }
  } catch {}
}

function renderHomeRating(d) {
  const box = $('my-rating'); if (!box) return;
  if (!d) { box.classList.add('hidden'); return; }
  box.classList.remove('hidden');
  if (d.unregistered) {
    box.innerHTML = '<div class="rating-signup"><div><div class="eyebrow">YOUR RATING</div><h2>BUILD YOUR RATING</h2><p>REGISTER TO TRACK YOUR RATE AND MATCH HISTORY.</p></div><button id="rating-register" class="secondary-button">REGISTER</button></div>';
    const rr = $('rating-register'); if (rr) rr.onclick = () => screen('profile-screen');
    return;
  }
  box.classList.add('hidden');
}

// ============================================================
// ★ マイページタブ（R1〜R7: レート/COM戦切替）
// ============================================================
let __recordsTab = 'ranked';
async function records(tab = 'ranked') {
  __recordsTab = tab;
  screen('records-screen');
  const rc = $('records-content'); if (!rc) return;
  const token = localStorage.getItem('napoleon_session');
  if (!token) {
    rc.innerHTML = '<p class="subcopy">REGISTER TO UNLOCK PLAYER STATS.</p><button id="records-register" class="primary-button">プレイヤー登録</button>';
    const rr = $('records-register'); if (rr) rr.onclick = () => screen('profile-screen');
    return;
  }
  rc.innerHTML = '<div class="records-tabs"><button class="tab-btn ' + (__recordsTab === 'ranked' ? 'active' : '') + '" data-records-tab="ranked">レートバトル</button><button class="tab-btn ' + (__recordsTab === 'com' ? 'active' : '') + '" data-records-tab="com">COM戦（非公開）</button></div><div id="records-tab-content"><p class="subcopy">読み込み中…</p></div>';
  rc.querySelectorAll('[data-records-tab]').forEach(b => b.onclick = () => records(b.dataset.recordsTab));
  const body = $('records-tab-content');
  if (__recordsTab === 'com') await renderComRecords(body, token);
  else await renderRankedRecords(body, token);
}
async function renderRankedRecords(rc, token) {
  try {
    const response = await fetch('/api/account/me', { headers: { 'x-session-token': token } });
    const { data: d, parseError } = await readResponse(response);
    if (!response.ok || parseError || !d) throw Error('UNABLE TO LOAD');
    g.account = d; if (d.rating) g.rate = d.rating; renderAccount();
    const perf = d.performance || {}, prec = d.precision || {}, ally = d.allyFeed || {}, bold = d.boldBid || {}, art = d.artRate || {}, ms = d.matchStats || {};
    const napAtt = Number(perf.declarer_attempts) || 0, napWins = Number(perf.declarer_successes) || 0, napWinRate = napAtt ? napWins / napAtt : 0;
    const bidTotal = Number(ms.bid_total) || 0, avgBid = napAtt ? bidTotal / napAtt : 0, matchCount = Number(ms.match_count) || 0, napRatio = matchCount ? (napAtt / (matchCount * 10)) : 0;
    const r1 = Number(ms.rank_1) || 0, r2 = Number(ms.rank_2) || 0, r3 = Number(ms.rank_3) || 0, r4 = Number(ms.rank_4) || 0, r5 = Number(ms.rank_5) || 0;
    const totalRanks = r1 + r2 + r3 + r4 + r5, avgRank = totalRanks ? ((r1 * 1 + r2 * 2 + r3 * 3 + r4 * 4 + r5 * 5) / totalRanks) : 0;
    const pct = v => (v * 100).toFixed(1) + '%';
    const dormPeriod = d.dorm_period || 310;
    const favoriteSong = d.favorite_song || '';
    const career = d.career || '';
    const scarySenior = d.scary_senior || '';
    const infiniteFood = d.infinite_food || '';
    const favoriteStanding = d.favorite_standing || '';
    const hist = (d.history || []).slice(0, 10).reverse();
    const ratings = hist.map(h => h.rating_after);
    const minR = Math.min(...ratings, d.rating || 1000);
    const maxR = Math.max(...ratings, d.rating || 1000);
    const range = Math.max(1, maxR - minR);
    const rateBarsHTML = hist.map(h => {
      const hPercent = 10 + ((h.rating_after - minR) / range) * 90;
      const isUp = h.delta >= 0;
      return `<div class="rate-bar-container"><div class="rate-bar ${isUp ? 'positive' : 'negative'}" style="height: ${hPercent}%"></div><div class="rate-label">${h.delta > 0 ? '+' : ''}${h.delta}</div></div>`;
    }).join('');
    const rankDistHTML = [1, 2, 3, 4, 5].map(r => {
      const count = [0, r1, r2, r3, r4, r5][r];
      const rate = totalRanks ? count / totalRanks : 0;
      return `<div class="rank-dist-row"><div class="rank-dist-label">${r}位</div><div class="rank-dist-bar-bg"><div class="rank-dist-bar" style="width: ${rate * 100}%"></div></div><div class="rank-dist-val">${pct(rate)} (${count})</div></div>`;
    }).join('');
    rc.innerHTML = `
      <div class="mypage-head"><div class="profile-emblem large">♠</div><div class="mypage-identity"><div class="eyebrow">RANKED RATE</div><h2>${escapeHTML(d.id)}</h2></div><div class="mypage-rating"><span>RATE</span><strong>${d.rating}</strong></div></div>
      <div class="record-stats"><div class="record-stat"><span>MATCHES</span><b>${d.games}</b></div><div class="record-stat"><span>WINS</span><b>${d.wins}</b></div><div class="record-stat"><span>LOSSES</span><b>${d.losses}</b></div></div>
      <section class="dorm-section"><div class="section-header"><h3 class="section-title">恵迪寮プロフィール</h3><button id="edit-dorm-btn" class="small-action">編集</button></div>
        <div id="dorm-profile-display" class="dorm-display">
          <div class="dorm-row"><span>入寮期</span><b>${dormPeriod}期</b></div>
          <div class="dorm-row"><span>好きな寮歌</span><b>${escapeHTML(favoriteSong || '未設定')}</b></div>
          <div class="dorm-row"><span>主な経歴</span><b>${escapeHTML(career || '未設定')}</b></div>
          <div class="dorm-row"><span>怖い上の年目の「改め」</span><b>${escapeHTML(scarySenior || '未設定')}</b></div>
          <div class="dorm-row"><span>無限にたべられるもの</span><b>${escapeHTML(infiniteFood || '未設定')}</b></div>
          <div class="dorm-row"><span>好きな立ち</span><b>${escapeHTML(favoriteStanding || '未設定')}</b></div>
        </div>
        <div id="dorm-profile-edit" class="dorm-edit hidden"><div class="form-card">
          <label>入寮期<select id="edit-dorm-period">${Array.from({ length: 81 }, (_, i) => 250 + i).map(p => `<option value="${p}" ${p === dormPeriod ? 'selected' : ''}>${p}期</option>`).join('')}</select></label>
          <label>好きな寮歌<input id="edit-favorite-song" value="${escapeHTML(favoriteSong)}"></label>
          <label>主な経歴<input id="edit-career" value="${escapeHTML(career)}"></label>
          <label>怖い上の年目の「改め」<input id="edit-scary-senior" value="${escapeHTML(scarySenior)}"></label>
          <label>無限にたべられるもの<input id="edit-infinite-food" value="${escapeHTML(infiniteFood)}"></label>
          <label>好きな立ち<input id="edit-favorite-standing" value="${escapeHTML(favoriteStanding)}"></label>
          <div class="form-actions"><button id="save-dorm-btn" class="primary-button">保存</button><button id="cancel-dorm-btn" class="secondary-button">キャンセル</button></div>
        </div></div>
      </section>
      <section class="performance-section"><h3 class="section-title">パフォーマンス指標</h3><div class="performance-grid">
        <article class="performance-card"><span>平均立ち成功率</span><strong>${napAtt > 0 ? pct(napWinRate) : '—'}</strong><small>${napWins} / ${napAtt}</small></article>
        <article class="performance-card"><span>平均宣言数</span><strong>${avgBid > 0 ? avgBid.toFixed(1) + '枚' : '—'}</strong><small>${napAtt > 0 ? napAtt + '回の立ち' : '実績なし'}</small></article>
        <article class="performance-card"><span>ナポレオン率</span><strong>${matchCount > 0 ? pct(napRatio) : '—'}</strong><small>${matchCount > 0 ? (matchCount * 10) + '局中' + napAtt + '回' : '実績なし'}</small></article>
      </div></section>
      <section class="rate-history-section"><h3 class="section-title">レート遷移（直近10試合）</h3>${hist.length ? `<div class="rate-history-list">${rateBarsHTML}</div>` : '<p class="subcopy" style="padding:10px 0;">データなし</p>'}</section>
      <section class="rank-distribution-section"><h3 class="section-title">順位率割合</h3>${totalRanks > 0 ? `<div class="rank-dist-list">${rankDistHTML}</div>` : '<p class="subcopy" style="padding:10px 0;">データなし</p>'}</section>
    `;
    const editBtn = $('edit-dorm-btn'); if (editBtn) editBtn.onclick = () => { $('dorm-profile-display')?.classList.add('hidden'); $('dorm-profile-edit')?.classList.remove('hidden'); };
    const cancelBtn = $('cancel-dorm-btn'); if (cancelBtn) cancelBtn.onclick = () => { $('dorm-profile-display')?.classList.remove('hidden'); $('dorm-profile-edit')?.classList.add('hidden'); };
    const saveBtn = $('save-dorm-btn'); if (saveBtn) saveBtn.onclick = async () => {
      const payload = { dormPeriod: Number($('edit-dorm-period')?.value) || 310, favoriteSong: $('edit-favorite-song')?.value || '', career: $('edit-career')?.value || '', scarySenior: $('edit-scary-senior')?.value || '', infiniteFood: $('edit-infinite-food')?.value || '', favoriteStanding: $('edit-favorite-standing')?.value || '' };
      try { const res = await fetch('/api/account/update-dorm', { method: 'POST', headers: { 'content-type': 'application/json', 'x-session-token': token }, body: JSON.stringify(payload) }); if (!res.ok) throw new Error('保存に失敗しました'); toast('プロフィールを保存しました'); records('ranked'); }
      catch (e) { toast(e.message); }
    };
  } catch (e) { rc.textContent = 'UNABLE TO LOAD'; }
}

async function renderComRecords(rc, token) {
  try {
    const response = await fetch('/api/account/me/com', { headers: { 'x-session-token': token } });
    const { data: d, parseError } = await readResponse(response);
    if (!response.ok || parseError || !d) throw Error('UNABLE TO LOAD COM STATS');
    const perf = d.performance || {}, prec = d.precision || {}, ally = d.allyFeed || {}, bold = d.boldBid || {}, ms = d.matchStats || {};
    const napAtt = Number(perf.declarer_attempts) || 0, napWins = Number(perf.declarer_successes) || 0, napWinRate = napAtt ? napWins / napAtt : 0;
    const bidTotal = Number(ms.bid_total) || 0, avgBid = napAtt ? bidTotal / napAtt : 0, matchCount = Number(ms.match_count) || 0, napRatio = matchCount ? (napAtt / (matchCount * 10)) : 0;
    const r1 = Number(ms.rank_1) || 0, r2 = Number(ms.rank_2) || 0, r3 = Number(ms.rank_3) || 0, r4 = Number(ms.rank_4) || 0, r5 = Number(ms.rank_5) || 0;
    const totalRanks = r1 + r2 + r3 + r4 + r5;
    const streakCur = Number(ms.streak_current) || 0, streakBest = Number(ms.streak_best) || 0;
    const pct = v => (v * 100).toFixed(1) + '%';
    const hist = (d.history || []).slice(0, 10).reverse();
    const ratings = hist.map(h => h.rating_after);
    const minR = Math.min(...ratings, d.comRating || 1000);
    const maxR = Math.max(...ratings, d.comRating || 1000);
    const range = Math.max(1, maxR - minR);
    const rateBarsHTML = hist.map(h => {
      const hPercent = 10 + ((h.rating_after - minR) / range) * 90;
      const isUp = h.delta >= 0;
      return `<div class="rate-bar-container"><div class="rate-bar ${isUp ? 'positive' : 'negative'}" style="height: ${hPercent}%"></div><div class="rate-label">${h.delta > 0 ? '+' : ''}${h.delta}</div></div>`;
    }).join('');
    const rankDistHTML = [1, 2, 3, 4, 5].map(r => {
      const count = [0, r1, r2, r3, r4, r5][r];
      const rate = totalRanks ? count / totalRanks : 0;
      return `<div class="rank-dist-row"><div class="rank-dist-label">${r}位</div><div class="rank-dist-bar-bg"><div class="rank-dist-bar" style="width: ${rate * 100}%"></div></div><div class="rank-dist-val">${pct(rate)} (${count})</div></div>`;
    }).join('');
    rc.innerHTML = `
      <div class="mypage-head" style="border-color:rgba(180,160,255,.35);"><div class="profile-emblem large">🤖</div><div class="mypage-identity"><div class="eyebrow">COM RATE（非公開）</div><h2>${escapeHTML(d.username || d.id)}</h2></div><div class="mypage-rating"><span>COM RATE</span><strong>${d.comRating}</strong></div></div>
      <div class="record-stats"><div class="record-stat"><span>MATCHES</span><b>${matchCount}</b></div><div class="record-stat"><span>STREAK</span><b>${streakCur >= 0 ? '+' : ''}${streakCur}</b></div><div class="record-stat"><span>BEST</span><b>${streakBest}</b></div></div>
      <section class="performance-section"><h3 class="section-title">パフォーマンス指標</h3><div class="performance-grid">
        <article class="performance-card"><span>平均立ち成功率</span><strong>${napAtt > 0 ? pct(napWinRate) : '—'}</strong><small>${napWins} / ${napAtt}</small></article>
        <article class="performance-card"><span>平均宣言数</span><strong>${avgBid > 0 ? avgBid.toFixed(1) + '枚' : '—'}</strong><small>${napAtt > 0 ? napAtt + '回の立ち' : '実績なし'}</small></article>
        <article class="performance-card"><span>ナポレオン率</span><strong>${matchCount > 0 ? pct(napRatio) : '—'}</strong><small>${matchCount > 0 ? (matchCount * 10) + '局中' + napAtt + '回' : '実績なし'}</small></article>
      </div></section>
      <section class="rate-history-section"><h3 class="section-title">COMレート遷移（直近10試合）</h3>${hist.length ? `<div class="rate-history-list">${rateBarsHTML}</div>` : '<p class="subcopy" style="padding:10px 0;">データなし</p>'}</section>
      <section class="rank-distribution-section"><h3 class="section-title">順位率割合</h3>${totalRanks > 0 ? `<div class="rank-dist-list">${rankDistHTML}</div>` : '<p class="subcopy" style="padding:10px 0;">データなし</p>'}</section>
      <p class="micro-copy" style="margin-top:16px;text-align:center;">※ COM戦レートはあなた専用です。ランキングや他人のプロフィールには表示されません。</p>
    `;
  } catch (e) { rc.textContent = 'UNABLE TO LOAD COM STATS'; }
}

// ============================================================
// ランキング・戦略ラボ
// ============================================================
async function loadLeaderboard() {
  const section = $('leaderboard'), box = $('rating-leaders');
  if (!section || !box) return;
  try {
    const response = await fetch('/api/rating/top');
    if (!response.ok) throw Error();
    const { data: leaders } = await readResponse(response);
    if (!Array.isArray(leaders)) throw Error();
    const list = leaders.slice(0, g.leaderboardExpanded ? 50 : 3);
    if (!list.length) { section.classList.add('hidden'); return; }
    section.classList.remove('hidden');
    box.classList.toggle('expanded', g.leaderboardExpanded);
    const sr = $('show-ranking');
    if (sr) { sr.textContent = g.leaderboardExpanded ? 'TOP 3' : 'VIEW TOP 50'; sr.setAttribute('aria-expanded', String(g.leaderboardExpanded)); }
    box.innerHTML = list.map((player, i) => {
      const username = String(player.username || player.id || 'player');
      const href = 'https://websim.com/@' + encodeURIComponent(username);
      const avatar = 'https://images.websim.com/avatar/' + encodeURIComponent(username);
      return '<article class="rating-leader rank-' + (i + 1) + '"><span class="leader-place">' + String(i + 1).padStart(2, '0') + '</span><a class="leader-person" href="' + escapeHTML(href) + '" target="_blank" rel="noopener noreferrer"><img src="' + escapeHTML(avatar) + '" alt="" loading="lazy"><span>@' + escapeHTML(username) + '</span></a><strong>' + Number(player.rating || 0) + '<small> pt</small></strong></article>';
    }).join('');
  } catch { section.classList.add('hidden'); }
}

function genLineChart(generations) {
  if (!generations || generations.length < 1) return '<p class="subcopy" style="padding:20px 0; text-align:center;">まだ学習データがありません。</p>';
  const data = generations.slice(-20);
  const W = 600, H = 200, padX = 40, padY = 20;
  const innerW = W - padX * 2, innerH = H - padY * 2;
  const xStep = data.length > 1 ? innerW / (data.length - 1) : innerW;
  const pointsNap = data.map((d, i) => { const x = padX + i * xStep; const y = H - padY - (Number(d.nap || 0) * innerH); return `${x},${y}`; }).join(' ');
  const pointsAlly = data.map((d, i) => { const x = padX + i * xStep; const y = H - padY - (Number(d.ally || 0) * innerH); return `${x},${y}`; }).join(' ');
  const labels = data.map((d, i) => {
    const x = padX + i * xStep;
    let timeStr = d.time ? (d.time.split(' ')[1]?.slice(0, 5) || `Gen ${d.generation}`) : `Gen ${d.generation}`;
    return `<text x="${x}" y="${H - 2}" font-size="9" fill="#8fa69a" text-anchor="middle">${timeStr}</text>`;
  }).join('');
  const grids = [0, 0.25, 0.5, 0.75, 1].map(p => {
    const y = H - padY - (p * innerH);
    return `<line x1="${padX}" y1="${y}" x2="${W - padX}" y2="${y}" stroke="rgba(255,255,255,0.1)" stroke-dasharray="3 3" /><text x="${padX - 5}" y="${y + 4}" font-size="9" fill="#8fa69a" text-anchor="end">${p * 100}%</text>`;
  }).join('');
  return `<div style="position:relative;width:100%;overflow-x:auto;background:rgba(20,42,33,.6);padding:15px 10px;border-radius:10px;border:1px solid rgba(225,188,112,.2);"><div style="display:flex;gap:16px;margin-bottom:12px;justify-content:center;"><div style="display:flex;align-items:center;gap:6px;font-size:11px;color:#f3d48e;"><div style="width:12px;height:3px;background:#f3d48e;"></div>NAP勝率</div><div style="display:flex;align-items:center;gap:6px;font-size:11px;color:#a9d2ae;"><div style="width:12px;height:3px;background:#a9d2ae;"></div>連合軍勝率</div></div><svg viewBox="0 0 ${W} ${H}" style="width:100%;min-width:400px;height:200px;display:block;">${grids}<polyline fill="none" stroke="#a9d2ae" stroke-width="2" points="${pointsAlly}" /><polyline fill="none" stroke="#f3d48e" stroke-width="2" points="${pointsNap}" />${labels}</svg></div>`;
}

function renderStrategyLab({ strategies, insights, generations }) {
  const wrap = $('strategy-content'); if (!wrap) return;
  let latestGen = 0, latestDelta = 0, totalMatches = 0;
  if (strategies.length > 0) { latestGen = strategies[0].generation; latestDelta = Number(strategies[0].avg_rating_delta || 0); }
  if (generations.length > 0) totalMatches = generations.reduce((sum, g) => sum + (Number(g.count) * 5), 0);
  const chartHTML = genLineChart(generations);
  const insightCards = insights.length > 0 ? insights.map(ins => `<article class="insight-card"><h3>${escapeHTML(ins.title)}</h3><p>${escapeHTML(ins.detail)}</p></article>`).join('') : '<p class="subcopy">データなし</p>';
  wrap.innerHTML = `
    <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:10px;margin-bottom:20px;">
      <div class="performance-card" style="padding:15px;"><span>最新世代</span><strong>Gen ${latestGen}</strong><small>1時間ごとに自動更新</small></div>
      <div class="performance-card" style="padding:15px;"><span>平均レート上昇値</span><strong style="color:${latestDelta > 0 ? '#a9d2ae' : '#e89685'}">${latestDelta > 0 ? '+' : ''}${latestDelta.toFixed(2)}</strong><small>上位戦略の1試合あたり</small></div>
      <div class="performance-card" style="padding:15px;"><span>総学習マッチ数</span><strong>${totalMatches > 0 ? totalMatches : '-'}</strong><small>累計自己対戦数</small></div>
    </div>
    <section class="strategy-section"><h2 style="margin-bottom:10px;font-size:15px;color:#e8d7a9;">世代ごとの勝率推移</h2>${chartHTML}</section>
    <section class="strategy-section" style="margin-top:20px;"><h2 style="margin-bottom:10px;font-size:15px;color:#e8d7a9;">学習インサイト</h2><div class="insight-list">${insightCards}</div></section>
    <section class="strategy-section" style="margin-top:20px;"><h2 style="margin-bottom:10px;font-size:15px;color:#e8d7a9;">最近のトップ戦略</h2><div class="strategy-list">${strategies.slice(0, 5).map((s, i) => `<article class="strategy-card rank-${i + 1}"><div class="strategy-rank">#${i + 1}</div><div class="strategy-meta"><span class="eyebrow">GEN ${s.generation} · ${s.matches}試合</span><strong>${Number(s.avg_rating_delta || 0) > 0 ? '+' : ''}${Number(s.avg_rating_delta || 0).toFixed(2)} <small>pt/試合</small></strong></div><div class="strategy-roles"><span>NAP ${(Number(s.nap_win_rate) * 100).toFixed(1)}%</span><span>DEP ${(Number(s.deputy_win_rate) * 100).toFixed(1)}%</span><span>ALLI ${(Number(s.alliance_win_rate) * 100).toFixed(1)}%</span></div></article>`).join('')}</div></section>
  `;
}
async function loadStrategyLab() {
  const wrap = $('strategy-content'); if (!wrap) return;
  wrap.innerHTML = '<p class="subcopy">データを読み込み中…</p>';
  try {
    const [stratRes, insightRes, genRes] = await Promise.all([
      fetch('/api/ai/strategies?limit=10').then(r => r.json()).catch(() => null),
      fetch('/api/ai/insights').then(r => r.json()).catch(() => null),
      fetch('/api/ai/generations').then(r => r.json()).catch(() => null)
    ]);
    const strategies = Array.isArray(stratRes) ? stratRes : [];
    const insights = (insightRes && Array.isArray(insightRes.insights)) ? insightRes.insights : [];
    const generations = Array.isArray(genRes) ? genRes : [];
    renderStrategyLab({ strategies, insights, generations });
  } catch (e) { wrap.innerHTML = '<p class="subcopy">データを読み込めませんでした。</p>'; }
}

// ============================================================
// フレンドロビー
// ============================================================
function code() { return Math.random().toString(36).slice(2, 7).toUpperCase(); }
function getBrowserId() {
  try {
    let id = localStorage.getItem('napoleon_browser_id');
    if (!id) { id = (typeof crypto !== 'undefined' && crypto.randomUUID && crypto.randomUUID()) || (Date.now().toString(36) + Math.random().toString(36).slice(2, 10)); localStorage.setItem('napoleon_browser_id', id); }
    return id;
  } catch { return null; }
}
function showFriendLobby(m) {
  g.friendLobby = m;
  let overlay = document.getElementById('friend-lobby-overlay');
  if (!overlay) { overlay = document.createElement('div'); overlay.id = 'friend-lobby-overlay'; overlay.style.cssText = 'position:fixed;inset:0;z-index:100;display:grid;place-items:center;background:rgba(3,5,15,.85);backdrop-filter:blur(6px);'; document.body.appendChild(overlay); }
  overlay.classList.remove('hidden');
  overlay.innerHTML = `<div style="max-width:380px;width:90%;padding:28px;border-radius:18px;border:1px solid rgba(180,160,255,.5);background:rgba(18,22,48,.95);text-align:center;"><div class="eyebrow">WAITING ROOM</div><h2 style="font-size:36px;letter-spacing:.25em;margin:15px 0;color:#fff;">${m.code}</h2><p class="micro-copy" style="margin-bottom:12px;font-size:12px;">この合言葉を友達に共有してください</p><p style="margin-bottom:24px;color:#a3b1a8;font-size:14px;">参加者: <b style="color:#f3d48e;">${m.count} / 5 人</b></p><button class="primary-button" id="wait-close" style="width:100%;margin-bottom:12px;min-height:48px;font-size:14px;background:#3e9b65;color:#fff;">裏で待機してCOM戦をする</button>${m.host ? `<button class="primary-button" id="start-now" style="width:100%;margin-bottom:12px;min-height:48px;font-size:14px;">今すぐ開始（COMで埋める）</button>` : ''}<button class="secondary-button" id="leave-lobby" style="width:100%;min-height:48px;font-size:14px;">キャンセル</button></div>`;
  overlay.querySelector('#wait-close').onclick = () => { overlay.classList.add('hidden'); startLocal(); showWaitingBanner(m); };
  overlay.querySelector('#leave-lobby').onclick = () => { overlay.classList.add('hidden'); g.room?.send({ type: 'leave-room' }); g.room?.close?.(); g.room = null; g.friendLobby = null; hideWaitingBanner(); screen('mode-select-screen'); };
  if (m.host) overlay.querySelector('#start-now').onclick = () => { g.room?.send({ type: 'start-now' }); };
}
function showWaitingBanner(m) {
  let banner = document.getElementById('friend-waiting-banner');
  if (!banner) { banner = document.createElement('div'); banner.id = 'friend-waiting-banner'; banner.style.cssText = 'position:fixed;top:48px;left:50%;transform:translateX(-50%);z-index:1000;background:#1a2e28;border:1px solid #e1bc70;color:#e1bc70;padding:8px 16px;border-radius:99px;font-size:12px;display:flex;align-items:center;gap:12px;box-shadow:0 4px 12px rgba(0,0,0,0.5);cursor:pointer;'; document.body.appendChild(banner); }
  banner.innerHTML = `<span>友人戦待機中: ${m.code} (${m.count}/5人)</span>${m.host ? '<button id="banner-start" class="small-action" style="padding:2px 8px;font-size:10px;min-height:24px;">開始</button>' : ''}<button id="banner-return" class="small-action" style="padding:2px 8px;font-size:10px;min-height:24px;">ロビーに戻る</button>`;
  banner.onclick = (e) => { if (e.target.id === 'banner-start') g.room?.send({ type: 'start-now' }); else { showFriendLobby(g.friendLobby); banner.classList.add('hidden'); } };
  banner.classList.remove('hidden');
}
function hideWaitingBanner() { const b = document.getElementById('friend-waiting-banner'); if (b) b.remove(); }

// ============================================================
// オンライン接続
// ============================================================
async function joinGameRoom() {
  const WS_URL = window.NAPOLEON_WS_URL || null;
  if (!WS_URL) {
    if (window.WebsimSocket?.joinRoom) { const roomInstance = await window.WebsimSocket.joinRoom(); return { roomInstance, send: (m) => roomInstance.send(typeof m === 'string' ? m : JSON.stringify(m)), close: () => { try { roomInstance.close?.(); } catch {} } }; }
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const url = proto + '//' + location.host + '/ws';
    const ws = new WebSocket(url);
    await new Promise((res, rej) => { const timer = setTimeout(() => rej(new Error('timeout')), 30000); ws.onopen = () => { clearTimeout(timer); res(); }; ws.onerror = () => { clearTimeout(timer); rej(new Error('ws error')); }; });
    return { roomInstance: ws, send: (m) => ws.send(typeof m === 'string' ? m : JSON.stringify(m)), close: () => ws.close() };
  }
  const healthUrl = WS_URL.replace(/^wss:/, 'https:').replace(/^ws:/, 'http:').replace(/\/ws$/, '/healthz');
  try { await fetch(healthUrl, { mode: 'no-cors', cache: 'no-store' }); } catch { }
  let lastErr;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const ws = new WebSocket(WS_URL);
      await new Promise((resolve, reject) => { const timer = setTimeout(() => reject(new Error('timeout')), 60000); ws.onopen = () => { clearTimeout(timer); resolve(); }; ws.onerror = () => { clearTimeout(timer); reject(new Error('ws error')); }; });
      return { roomInstance: ws, send: (m) => ws.send(typeof m === 'string' ? m : JSON.stringify(m)), close: () => ws.close() };
    } catch (e) { lastErr = e; if (attempt < 3) await new Promise(r => setTimeout(r, 2000)); }
  }
  throw lastErr;
}
function bindOnlineWs(ws) {
  ws.onmessage = (e) => { let m; try { m = JSON.parse(e.data); } catch { return; } handleOnlineMessage(m); };
  ws.onclose = () => {
    if (g.intentionalLeave) return;
    if (!g.sessionToken) return;
    if (g.reconnecting) return;
    toast('接続が切れました。再接続中…');
    setTimeout(() => onlineReconnect(), 1500);
  };
}

function handleOnlineMessage(m) {
  if (g.intentionalLeave) return;

  // ★ A1: チャット
  if (m.type === 'chat-message') { addChatMessage(m); return; }

  if (m.type === 'lobby') {
    const match = String(m.text || '').match(/(\d+)\/5人/);
    if (match) { const qc = $('queue-count'); if (qc) qc.textContent = match[1] + ' / 5 人'; }
    if (g.onlineState === null) { /* queuing */ } else { message(m.text); }
    return;
  }
  if (m.type === 'queue-cancelled') {
    hideQueuePanel();
    g.mySeat = 0; g.onlineState = null;
    toast('待機をキャンセルしました');
    closeOnline();
    screen('mode-select-screen');
    return;
  }
  if (m.type === 'friend-lobby') {
    g.friendLobby = m;
    const banner = document.getElementById('friend-waiting-banner');
    const overlay = document.getElementById('friend-lobby-overlay');
    if (banner && !banner.classList.contains('hidden')) showWaitingBanner(m);
    else if (overlay && !overlay.classList.contains('hidden')) showFriendLobby(m);
    else showFriendLobby(m);
    return;
  }
  if (m.type === 'matched') {
    hideQueuePanel();
    screen('game-screen');
    document.getElementById('friend-lobby-overlay')?.classList.add('hidden');
    hideWaitingBanner();
    g.friendLobby = null;
    if (g.phase === 'play' || g.phase === 'auction' || g.phase === 'discard' || g.phase === 'call' || g.phase === 'prep') {
      clearTimers(); clearInterval(g.autoNextTimer); clearTimeout(g.auction?.humanTimeout);
      toast('マッチが開始されました。移行します。');
    }
    g.online = m; g.mySeat = m.seat;
    g.players = m.players.map(p => ({ name: p.username || p.id, username: p.username, originalName: p.username, abandoned: false, hand: [], taken: [], roundPoints: 0, rating: p.rating }));
    g.phase = ''; g.active = -1; g.discard = new Set(); g.selectedCard = null;
    g.privateHand = []; g.onlineLegal = []; g.bid = 13; g.suit = '♠'; g.lastRating = null;
    g.auction = null; g.contract = null; g.localLog = [];
    g.matchScores = [0, 0, 0, 0, 0]; g.matchArt = [0, 0, 0, 0, 0];
    g.matchStats = Array.from({ length: 5 }, () => ({ declarerAttempts: 0, declarerSuccesses: 0, exactAttempts: 0, exactSuccesses: 0, boldAttempts: 0, boldSuccesses: 0, soloAttempts: 0, soloSuccesses: 0, deputyAttempts: 0, deputySuccesses: 0, artAttempts: 0, dramaticPlays: 0, allyFeedAttempts: 0, allyFeedSuccesses: 0, bidTotal: 0 }));
    g.matchContracts = []; g.playedCards = []; g.voids = [{}, {}, {}, {}, {}];
    g.discardedKitty = []; g.allianceKittyPoints = 0; g.waitingAutoPlay = false;
    g.round = 1; g.mult = 1; g.playoff = false; g.playoffCount = 0; g.announcedRound = null;
    g.confirmedCall = false; g.lastDiscardPhase = false; g.lastCallPhase = false;
    g.winDeclaration = null;
    g.playPools = [20, 20, 20, 20, 20]; g.turnStartAt = 0;
    stopTurnTimer();
    const openLogBtn = $('game-log-open'); if (openLogBtn) openLogBtn.classList.remove('hidden');
    const logCnt = $('game-log-count'); if (logCnt) logCnt.textContent = '0';
    phase('対戦開始');
    message('配札しました。競り開始まで7秒です。');
    // ★ R2: 相手レート表示
    try {
      const others = m.players.filter((p, i) => i !== m.seat && !p.bot).map(p => `${p.username || p.id}: ${p.rating}`).join(' / ');
      if (others) addGameLog('相手: ' + others);
    } catch {}
    // ★ R4: 放棄罰則明示
    if (m.mode === 'ranked') toast('※ 途中退出は放棄扱い（-30pt）になります');
    return;
  }
  if (m.type === 'game-state') {
    const prevPhase = g.phase;
    const prevTrick = g.onlineState?.trick || [];
    g.onlineState = m.state; g.mySeat = m.you;
    g.active = m.state.active; g.phase = m.state.phase;
    g.round = m.state.round; g.mult = m.state.mult; g.playoff = m.state.playoff; g.playoffCount = m.state.playoffCount || 0;
    g.matchScores = m.state.matchScores;
    g.matchArt = m.state.matchArt || g.matchArt;
    g.bidHistory = m.state.bidHistory || [];
    g.allianceKittyPoints = m.state.allianceKittyPoints;
    g.contract = m.state.contract;
    g.appealInfo = m.state.appealInfo;
    g.kitty = m.state.kitty || [];
    g.discardedKitty = m.state.revealedKitty || [];
    g.auction = m.state.auction;
    g.winDeclaration = m.state.winDeclaration || null;
    g.playPools = m.state.playPools || g.playPools || [20, 20, 20, 20, 20];
    g.turnStartAt = Date.now();
    if (g.auction) { if (!g.suit) g.suit = '♠'; if (!g.bid || g.bid < g.auction.minBid) g.bid = g.auction.minBid; }

    m.state.players.forEach((p, i) => {
      g.players[i] = { ...g.players[i], ...p, abandoned: !!p.abandoned, originalName: p.originalName || p.username, hand: (i === g.mySeat) ? g.players[i].hand : Array(p.handCount).fill(null), taken: p.taken, roundPoints: p.points };
    });
    g.trick = (m.state.trick || []).map(x => ({ player: x.seat, card: { suit: x.card.suit, rank: x.card.rank, id: x.card.suit + x.card.rank } }));
    const tc = $('trick-cards');
    if (tc) { tc.replaceChildren(); g.trick.forEach(x => tc.append(cardEl(x.card, 'trick-card played-seat-' + x.player))); }
    if (m.state.trick) {
      if (m.state.trick.length > prevTrick.length) {
        const newCards = m.state.trick.slice(prevTrick.length);
        for (const nc of newCards) { const cardId = nc.card.suit + nc.card.rank; addGameLog(name(nc.seat) + 'が' + cardId + 'を出した'); }
      } else if (m.state.trick.length === 0 && prevTrick.length > 0) {
        if (m.state.lastTrickWinner != null) addGameLog(name(m.state.lastTrickWinner) + 'がトリックを獲得');
      }
    }
    if (m.state.notice) { if (!g.localLog) g.localLog = []; if (g.localLog[g.localLog.length - 1]?.text !== m.state.notice) addGameLog(m.state.notice); }

    if (prevPhase !== g.phase) {
      if (g.phase === 'prep') {
        const displayRound = (g.playoff && g.round > 10) ? '10 (再戦)' : String(g.round);
        const roundLab = $('round-label'); if (roundLab) roundLab.textContent = displayRound;
        g.bid = 13; g.suit = '♠'; lastAuctionDrawHash = ''; g.discard = new Set();
        $('game-screen')?.classList.remove('discarding'); $('hand')?.classList.remove('discard-mode');
        $('call-panel')?.classList.add('hidden'); $('play-panel')?.classList.add('hidden'); $('result-panel')?.classList.add('hidden');
        g.confirmedCall = false; g.lastDiscardPhase = false; g.lastCallPhase = false;
        stopTurnTimer();
        if (!g.countdownTimer) {
          let n = 7;
          g.countdownTimer = setInterval(() => {
            if (g.phase !== 'prep') { clearInterval(g.countdownTimer); g.countdownTimer = null; return; }
            n--;
            if (n > 0) message('競り開始まで ' + n + ' 秒');
            else { clearInterval(g.countdownTimer); g.countdownTimer = null; }
          }, 1000);
        }
      }
      if (g.phase === 'call-reveal') g.confirmedCall = false;
      if (g.phase === 'discard') { g.discard = new Set(); g.lastDiscardPhase = false; }
      if (g.phase === 'prep' && g.round >= 9) announceRound(g.round, finalAuctionRule(g.matchScores, g.mult));
    }

    phase({ prep: '準備中', auction: '競り', call: '副官指名', discard: '浮き札の交換', 'call-reveal': '指名確認', play: 'カードプレイ', 'trick-end': 'トリック', 'round-result': '局結果', result: '結果', redeal: '配り直し', 'appeal-offer': 'アピール', 'appeal-response': 'アピール回答', 'win-declaration': '上がり宣言' }[g.phase] || '進行中');
    if (m.state.notice) message(m.state.notice);
    renderContractInfo(); drawSeats(); renderHand(g.phase === 'discard'); drawOnlineKitty(); drawOnlineControls();
    syncTurnTimer();
    return;
  }
  if (m.type === 'private-hand') {
    g.privateHand = m.hand; g.onlineLegal = m.legal;
    if (g.onlineState && g.onlineState.phase === 'play') { g.players[g.mySeat].hand = m.hand; g.active = g.onlineState.active; if (g.active === g.mySeat) drawLocalPlayControls(); }
    renderHand(g.phase === 'discard');
    syncTurnTimer();
    return;
  }
  if (m.type === 'rating-updated') {
    g.lastRating = m; g.rate = m.rating; g.elo = m.rating;
    if (g.account) g.account.rating = m.rating;
    const rl = $('rating-label'); if (rl) rl.textContent = m.rating;
    const combined = m.delta || 0;
    toast('RATE Δ ' + (combined >= 0 ? '+' : '') + combined + ' → ' + m.rating);
    if (g.onlineState && g.onlineState.phase === 'result') showOnlineResult();
    return;
  }
  if (m.type === 'rate-save-failed') { toast(m.message || 'レート保存に失敗しました'); return; }
  if (m.type === 'room-error') { toast(m.message); return; }
  if (m.type === 'reconnected') { g.reconnecting = false; toast('再接続しました'); g.online = { matchId: m.matchId, mode: m.mode, seat: m.seat }; g.phase = ''; screen('game-screen'); return; }
  if (m.type === 'reconnect-failed') { g.reconnecting = false; toast('復帰できませんでした'); screen('home-screen'); return; }
  if (m.type === 'presence') { g.presenceCount = m.count; const el = $('concurrent-count'); if (el) el.textContent = '同接: ' + m.count + '人'; return; }

  // ★ N33: 暗号鍵受信 → 全Workerへ
  if (m.type === 'bot-compute-key') {
    if (m.keyHex) { broadcastKeyToWorkers(m.keyHex); g.hostKeySet = true; }
    return;
  }
  // ★ N33: ホスト端末でCOM計算 → Workerへ転送
  if (m.type === 'compute-bot-turn') {
    const w = aiWorkers[0];
    if (!w) return;
    try { w.postMessage({ type: 'compute-bot-turn', requestId: m.requestId, seat: m.seat, encrypted: m.encrypted }); } catch (e) { console.warn('[compute-bot-turn forward]', e); }
    return;
  }
}

function drawOnlineKitty() {
  const el = $('kitty-view'); if (!el) return;
  if (g.phase === 'auction' && g.kitty && g.kitty.length) { el.classList.remove('hidden'); el.replaceChildren(...g.kitty.map(c => cardEl(c))); }
  else if (g.phase === 'auction') { el.classList.remove('hidden'); el.replaceChildren(cardEl(null, 'card-back'), cardEl(null, 'card-back')); }
  else { el.classList.add('hidden'); el.replaceChildren(); }
}

function drawOnlineControls() {
  ['auction-panel', 'call-panel', 'play-panel', 'result-panel'].forEach(id => { const el = $(id); if (el) el.classList.add('hidden'); });
  if (g.phase === 'result' || g.phase === 'round-result') { showOnlineResult(); stopTurnTimer(); return; }
  if (g.phase === 'appeal-offer' && g.onlineState?.appeal?.bottomSeat === g.mySeat) { drawAppealOffer(); return; }
  if (g.phase === 'appeal-response' && g.onlineState?.appeal?.fourthSeat === g.mySeat) { drawAppealResponse(); return; }
  if (g.phase === 'win-declaration') {
    const p = $('play-panel'); if (!p) return;
    p.classList.remove('hidden');
    const wd = g.winDeclaration;
    if (!wd) return;
    const remaining = Math.max(0, Math.ceil((wd.expiresAt - Date.now()) / 1000));
    p.innerHTML = `<div class="panel-title" style="color:#f3d48e;font-size:16px;">✨ ${escapeHTML(name(wd.seat))} が上がり宣言しました</div><div class="micro-copy" style="margin-bottom:10px;">手札を確認してください（${remaining}秒後に確定）</div><div class="win-declaration-hand" style="display:flex;flex-wrap:wrap;gap:4px;justify-content:center;margin-bottom:10px;">${wd.hand.map(c => cardEl(c).outerHTML).join('')}</div>`;
    clearInterval(g.countdownTimer);
    g.countdownTimer = setInterval(() => {
      if (g.phase !== 'win-declaration') { clearInterval(g.countdownTimer); return; }
      const r = Math.max(0, Math.ceil((wd.expiresAt - Date.now()) / 1000));
      const el = p.querySelector('.micro-copy');
      if (el) el.textContent = `手札を確認してください（${r}秒後に確定）`;
      if (r <= 0) { clearInterval(g.countdownTimer); }
    }, 1000);
    return;
  }
  if (g.phase === 'auction' && g.onlineState?.auction?.active?.includes(g.mySeat)) { drawAuction(); return; }
  if (g.phase === 'call' && g.active === g.mySeat) { if (!g.lastCallPhase) { callUi(); g.lastCallPhase = true; } return; }
  if (g.phase === 'discard' && g.active === g.mySeat) { const cp = $('call-panel'); if (!g.lastDiscardPhase || !cp || cp.classList.contains('hidden')) kittyStart(); return; }
  if (g.phase === 'call-reveal') { drawOnlineCallReveal(); return; }
  if (g.phase === 'play' && g.active === g.mySeat) { drawLocalPlayControls(); notifyTurn(); return; }
}

async function onlineReconnect() {
  if (!g.sessionToken || g.reconnecting) return;
  g.reconnecting = true;
  try {
    await stopPresence();
    const { roomInstance, send, close } = await joinGameRoom();
    g.room = { ws: roomInstance, send, close };
    bindOnlineWs(roomInstance);
    g.room.send({ type: 'reconnect', sessionToken: g.sessionToken, playerId: g.account?.id || null });
  } catch (e) { g.reconnecting = false; toast('再接続に失敗しました'); screen('home-screen'); }
}

async function online(mode, roomCode, bots, botLevel = 3) {
  $('game-log-open')?.classList.add('hidden');
  if (mode === 'ranked' && !localStorage.getItem('napoleon_session')) { toast('先にプレイヤー登録をしてください'); screen('profile-screen'); return; }
  g.intentionalLeave = false;
  g.reconnecting = false;
  if (g.room) { try { g.room.close?.(); } catch {} g.room = null; }
  loadTopStrategy();
  try {
    await stopPresence();
    const beforeJoin = g.intentionalLeave;
    const { roomInstance, send, close } = await joinGameRoom();
    if (g.intentionalLeave && !beforeJoin) { try { close?.(); } catch {} return; }
    g.room = { ws: roomInstance, send, close };
    g.mySeat = -1; g.privateHand = []; g.onlineState = null; g.onlineDiscard = new Set(); g.onlineSelectedCard = null;
    g.onlineBid = 13; g.onlineSuit = '♠'; g.onlineRank = 'A'; g.announcedCallRound = null; g.announcedRound = null;
    g.auction = null; g.contract = null; g.matchScores = [0, 0, 0, 0, 0];
    g.confirmedCall = false; g.lastDiscardPhase = false; g.lastCallPhase = false;
    g.winDeclaration = null; g.bid = 13; g.suit = '♠'; g.selectedCard = null; g.discard = new Set();
    g.phase = ''; g.active = -1; g.lastRating = null;
    g.bidSignals = Array.from({ length: 5 }, () => ({ sent: null, received: [], sameColorCount: 0, lastBidAt: 0 }));
    g.properBids = [13, 13, 13, 13, 13];
    g.properPlans = [null, null, null, null, null];
    g.playPools = [20, 20, 20, 20, 20]; g.turnStartAt = 0;
    g.auctionStartAt = 0;
    stopTurnTimer();
    ['auction-panel', 'call-panel', 'play-panel', 'result-panel'].forEach(id => { const el = $(id); if (el) el.classList.add('hidden'); });

    if (mode === 'ranked') {
      screen('mode-select-screen');
      showQueuePanel();
      const qc = $('queue-count'); if (qc) qc.textContent = '1 / 5 人';
    } else {
      screen('game-screen');
      const gml = $('game-mode-label'); if (gml) gml.textContent = 'FRIEND MATCH';
      const rc = $('rating-caption'); if (rc) rc.textContent = 'RATE';
      phase('部屋を準備中');
      message('合言葉 ' + roomCode + ' で参加を待っています');
    }

    bindOnlineWs(roomInstance);
    const pId = g.account?.id || null;
    g.room.send({ type: 'join', mode: mode, code: roomCode, bots, botLevel: Number(botLevel) || 3, sessionToken: localStorage.getItem('napoleon_session'), playerId: pId, browserId: getBrowserId() });
  } catch (e) {
    console.warn('[online] connect failed:', e?.message);
    toast('対戦に接続できませんでした（サーバー起動待ちの可能性があります。少し待って再試行してください）');
    screen('home-screen');
  }
}

// ============================================================
// ★ U1: 離脱確認
// ============================================================
function confirmLeaveGame() {
  if (g.phase === 'play' || g.phase === 'auction' || g.phase === 'discard' || g.phase === 'call' || g.phase === 'prep' || g.phase === 'call-reveal' || g.phase === 'trick-end') {
    if (!confirm('対戦中です。退出すると放棄扱いになります（レート戦は -30pt）。退出しますか？')) return;
  }
  g.intentionalLeave = true;
  closeOnline();
  screen('home-screen');
}

// ============================================================
// イベントバインド
// ============================================================
const regDormPeriod = $('reg-dorm-period');
if (regDormPeriod && !regDormPeriod.options.length) {
  for (let p = 250; p <= 330; p++) { const opt = document.createElement('option'); opt.value = p; opt.textContent = p + '期'; if (p === 310) opt.selected = true; regDormPeriod.appendChild(opt); }
}

$('home-start')?.addEventListener('click', () => screen('mode-select-screen'));
$('start-com')?.addEventListener('click', () => startLocal());
$('game-log-open')?.addEventListener('click', openGameLog);
$('game-log-close')?.addEventListener('click', () => $('game-log-dialog').close());
$('game-log-download')?.addEventListener('click', downloadLog);
$('create-friend')?.addEventListener('click', () => { let c = code(); const fc = $('friend-code'); if (fc) fc.value = c; online('friend', c, 0, 3); });
$('join-friend')?.addEventListener('click', () => { const fc = $('friend-code'); if (!fc) return; let c = fc.value.trim().toUpperCase(); if (!c) { toast('合言葉を入力してください'); return; } online('friend', c, 0, 3); });
$('start-ranked')?.addEventListener('click', () => online('ranked', '', 0));
$('profile-open')?.addEventListener('click', () => g.account ? records('ranked') : screen('profile-screen'));
$('show-record')?.addEventListener('click', () => records('ranked'));
$('show-ranking')?.addEventListener('click', () => { g.leaderboardExpanded = !g.leaderboardExpanded; loadLeaderboard(); });
$('open-quiz')?.addEventListener('click', async () => {
  try { const mod = await import('./quiz-app.js?v=46'); mod.openQuizScreen(); }
  catch (err) { alert('何切る問題集の読み込みに失敗しました: ' + err.message); }
});
$('start-training')?.addEventListener('click', async () => {
  try { const mod = await import('./training-app.js?v=1'); mod.openTrainingScreen(); }
  catch (err) { alert('トレーニングモードの読み込みに失敗しました: ' + err.message); }
});
$('open-strategy-lab')?.addEventListener('click', () => screen('strategy-screen'));
$('open-past-games')?.addEventListener('click', () => screen('past-games-screen'));
$('leave-game')?.addEventListener('click', confirmLeaveGame);
$('register-account')?.addEventListener('click', () => account('/api/account/register'));
$('login-account')?.addEventListener('click', () => account('/api/account/login'));

document.querySelectorAll('[data-go-home]').forEach(b => b.addEventListener('click', () => screen('home-screen')));

// チャット・ハイロー・キャンセル（デリゲート: DOM再構築対応）
document.addEventListener('click', (e) => {
  const t = e.target;
  if (!t) return;
  if (t.id === 'chat-send') { e.preventDefault(); sendChat(); }
  else if (t.id === 'hilo-higher') hiloGuess('higher');
  else if (t.id === 'hilo-lower') hiloGuess('lower');
  else if (t.id === 'cancel-queue-btn') {
    try { g.room?.send({ type: 'cancel-queue' }); } catch {}
    hideQueuePanel();
    closeOnline();
    screen('mode-select-screen');
  }
  else if (t.id === 'queue-com-escape') {
    try { g.room?.send({ type: 'cancel-queue' }); } catch {}
    hideQueuePanel();
    closeOnline();
    startLocal();
  }
});
document.addEventListener('keydown', (e) => {
  if (e.target && e.target.id === 'chat-input' && e.key === 'Enter') { e.preventDefault(); sendChat(); }
});

// iOS/Android キーボード補正
if (window.visualViewport) {
  const adjustQueueHeight = () => {
    const inner = document.querySelector('.mode-select-inner.queue-active');
    if (!inner) return;
    const vv = window.visualViewport;
    inner.style.setProperty('height', vv.height + 'px', 'important');
    const log = $('chat-log');
    if (log) log.scrollTop = log.scrollHeight;
  };
  window.visualViewport.addEventListener('resize', adjustQueueHeight);
  window.visualViewport.addEventListener('scroll', adjustQueueHeight);
}

window.addEventListener('error', (e) => { try { addDebugLog('global-error', { message: e.message, stack: e.error?.stack, filename: e.filename, line: e.lineno, col: e.colno, phase: g.phase, round: g.round }); } catch {} });
window.addEventListener('unhandledrejection', (e) => { try { addDebugLog('unhandled-rejection', { message: e.reason?.message || String(e.reason), phase: g.phase, round: g.round }); } catch {} });

// 起動処理
(async () => {
  try { await getUser(); } catch {}
  try { await loadAccount(); } catch {}
  try { await loadLeaderboard(); } catch {}
  bindChatInputFocus();
  screen('home-screen');
})();

// ===== [app.js 完全版 終わり] =====

