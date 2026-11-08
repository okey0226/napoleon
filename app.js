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
  lobbyRoom: null, // ★ ロビーチャット・ハイロー用WebSocket
  rankedQueuing: false, // ★ レート待機中フラグ
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
  playPools: [20, 20, 20, 20, 20],
  turnStartAt: 0,
  deadline: 0,
  chatLog: [],
  hilo: { current: null, next: null, streak: 0, best: 0, waiting: false, started: false },
  queueStartedAt: 0,
  presenceCount: 0,
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
  ['home-screen', 'mode-select-screen', 'extra-menu-screen', 'profile-screen', 'game-screen', 'records-screen', 'strategy-screen', 'quiz-screen', 'training-screen', 'past-games-screen'].forEach(x => {
    const el = $(x);
    if (el) {
      if (x === id) { el.classList.remove('hidden'); el.style.removeProperty('display'); }
      else { el.classList.add('hidden'); el.style.setProperty('display', 'none', 'important'); }
    }
  });

  if (id === 'mode-select-screen') {
    loadLeaderboard();
    loadAccount();
    startPresence();
    connectLobby(); // ★ ロビー（チャット・ハイロー）接続
    if (g.rankedQueuing) showQueuePanel();
    else hideQueuePanel();
  } else {
    // モード選択・その他メニュー以外はロビーを切断（ゲーム中など）
    if (g.lobbyRoom && id !== 'extra-menu-screen') {
      g.lobbyRoom.close?.();
      g.lobbyRoom = null;
    }
  }

  if (id === 'strategy-screen') loadStrategyLab();
  if (id === 'past-games-screen') openPastGamesScreen();
  if (id !== 'game-screen') stopTurnTimer();
}

// ★ ロビー接続
async function connectLobby() {
  if (g.lobbyRoom || g.room || g.intentionalLeave) return;
  try {
    const { roomInstance, send, close } = await joinGameRoom();
    if (g.lobbyRoom) { close(); return; }
    g.lobbyRoom = { ws: roomInstance, send, close };
    roomInstance.onmessage = (e) => {
      let m; try { m = JSON.parse(e.data); } catch { return; }
      if (m.type === 'chat-message') addChatMessage(m);
      if (m.type === 'presence') {
        g.presenceCount = m.count;
        const el = $('concurrent-count');
        if (el) el.textContent = '同接: ' + m.count + '人';
      }
    };
    roomInstance.onclose = () => {
      g.lobbyRoom = null;
      if (!g.intentionalLeave && !g.room && g.phase === '') {
        setTimeout(connectLobby, 5000);
      }
    };
    // 待機中UIの初期化
    if (!g.hilo.started) { g.hilo.started = true; hiloStart(); }
    renderChatLog();
  } catch (e) {
    console.warn('Lobby connect failed', e);
  }
}

function startPresence() {
  // connectLobbyに統合済み。互換性のため空関数
}

async function stopPresence() {
  if (g.presenceRoom) {
    const current = g.presenceRoom;
    g.presenceRoom = null;
    try { (await current)?.close?.(); } catch {}
  }
}

function later(fn, ms) { const t = setTimeout(fn, ms); g.timer.push(t); return t; }
function clearTimers() { g.timer.forEach(clearTimeout); g.timer = []; }

function closeOnline() {
  g.intentionalLeave = true;
  clearTimers();
  clearInterval(g.countdownTimer); g.countdownTimer = null;
  clearInterval(g.onlineResultTimer);
  clearTimeout(g.auction?.humanTimeout);
  clearInterval(g.autoNextTimer);
  stopTurnTimer();
  g.room?.close?.();
  g.room = null; g.online = null; g.onlineState = null;
  g.privateHand = []; g.onlineLegal = []; g.onlineSelectedCard = null;
  g.friendLobby = null; g.mySeat = 0; g.hostKeySet = false;
  g.rankedQueuing = false;
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
// タイマー（プール残量UI）
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
// チャット・ハイロー
// ============================================================
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
  const name = g.account?.id || 'ゲスト';
  
  // 待機中/対戦中はg.room、ロビーはg.lobbyRoomを使う
  const conn = g.room || g.lobbyRoom;
  if (!conn || !conn.send) { toast('接続中です…'); return; }
  
  try { conn.send({ type: 'chat', text, name }); }
  catch { toast('送信に失敗しました'); return; }
  
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
// 待機中UI
// ============================================================
function showQueuePanel() {
  const area = $('queue-status-area');
  if (area) area.classList.remove('hidden');
  g.queueStartedAt = Date.now();
  if (!g.hilo.started) { g.hilo.started = true; hiloStart(); }
  renderChatLog();
  const qc = $('queue-count'); if (qc) qc.textContent = '1 / 5 人';
  updateQueueElapsed();
  if (window.__rebindChatFocus) window.__rebindChatFocus();
  renderQuickStats();
}
function hideQueuePanel() {
  const area = $('queue-status-area');
  if (area) area.classList.add('hidden');
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
  if (g.rankedQueuing) setTimeout(updateQueueElapsed, 1000);
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

// ===== [app.js Part 1/3 終了] =====

// ===== [app.js Part 2/3 開始] =====

// ============================================================
// ★ COM戦開始（レート待機中でも並行可能）
// ============================================================
function startLocal() {
  const wasRankedQueuing = g.rankedQueuing;

  if (!wasRankedQueuing) {
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
  } else {
    // ★ レート待機中は g.room を維持し、COM戦だけ並行する
    clearTimers();
    clearInterval(g.countdownTimer); g.countdownTimer = null;
    clearTimeout(g.auction?.humanTimeout);
    clearInterval(g.autoNextTimer);
    // ロビーソケットは閉じる（g.room でマッチング継続）
    if (g.lobbyRoom) { try { g.lobbyRoom.close?.(); } catch {} g.lobbyRoom = null; }
  }

  clearTimeout(g.auction?.humanTimeout);
  clearInterval(g.countdownTimer); g.countdownTimer = null;
  g.chatLog = g.chatLog.slice(-30); // 直近のみ保持

  g.privateHand = []; g.onlineLegal = []; g.mySeat = 0;
  g.lastRating = null; g.confirmedCall = false; g.lastDiscardPhase = false; g.lastCallPhase = false;
  g.selectedCard = null; g.active = -1; g.bid = 13; g.suit = '♠'; g.discard = new Set();
  g.winDeclaration = null;
  g.deadline = 0;
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
  g.playoff = false;
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
  g.playPools = [20, 20, 20, 20, 20];
  g.turnStartAt = 0;
  screen('game-screen');
  const modeLabel = $('game-mode-label'); if (modeLabel) modeLabel.textContent = wasRankedQueuing ? 'COM戦 (レート待機中)' : 'COM戦';
  const ratCap = $('rating-caption'); if (ratCap) ratCap.textContent = 'COM RATE';
  const ratLab = $('rating-label'); if (ratLab) ratLab.textContent = g.comRate;

  if (!wasRankedQueuing) setTimeout(() => { g.intentionalLeave = false; }, 1000);
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
  g.playPools = [20, 20, 20, 20, 20];
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
  const timeoutMs = 30000;
  auction.humanTimeout = setTimeout(() => {
    if (g.phase === 'auction' && g.auction === auction) {
      if (g.onlineState && g.room) {
        stopTurnTimer();
      } else {
        if (!g.auction.active.includes(g.mySeat)) return;
        humanApprove(true);
      }
    }
  }, timeoutMs);
}

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

  if (g.auction.approved && g.auction.approved[g.mySeat]) {
    p.innerHTML = '<div class="panel-title">現在の宣言　<strong>' + t + '</strong></div>' +
      '<div class="micro-copy">保留中（誰かが上げれば復帰可能）</div>' + ruleNote + appealPanel +
      '<div class="panel-row"><button class="small-action" id="bid-resume">再立候補する</button></div>' + historyPanel;
    const resume = $('bid-resume');
    if (resume) resume.onclick = () => {
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

function humanApprove(forced = false) {
  if (g.onlineState && g.room) {
    if (!forced) {
      g.room?.send({ type: 'game', action: { type: 'approve' } });
      stopTurnTimer();
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
  stopTurnTimer();
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

function humanBid() {
  if (g.phase !== 'auction' || !g.auction) return;

  if (!beatsBid(g.bid, g.suit)) {
    toast('現在の宣言より強い宣言を選んでください');
    return;
  }

  if (g.onlineState && g.room) {
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
    g.turnStartAt = Date.now();
    const free = PLAY_FREE_SECONDS;
    const pool = g.playPools[g.active] || PLAY_POOL_SECONDS;
    g.deadline = Date.now() + (free + Math.max(0, pool)) * 1000;
    message(name(w) + 'から次の勝負');
    playTurn();
  }, 1250);
}

function finishGame() {
  g.phase = 'result';
  clearTimeout(g.trickResetTimer);
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

  const art = g.roundArt.slice();
  if (success && pts === c.num) { art[c.nap] += 2; if (!c.solo) art[c.deputy] += 1; if (c.num >= 15) { art[c.nap] += 2; if (!c.solo) art[c.deputy] += 1; } }
  if (c.solo) art[c.nap] += success ? 4 : 2;
  if (!success && !c.solo && c.num - pts >= 3) { art[c.nap] -= 2; art[c.deputy] -= 1; }
  for (let i = 0; i < 5; i++) { g.matchScores[i] += scores[i]; g.matchArt[i] += art[i]; }
  g.matchContracts.push({ round: g.round, nap: c.nap, deputy: c.deputy, num: c.num, suit: c.suit, solo: c.solo, points: pts, napWin: success, revealTrickNo: c.revealTrickNo ?? null, takenPoints: g.players.map(p => p.roundPoints || 0), allianceKittyPoints: g.allianceKittyPoints, strengthAtBid: c.strengthAtBid ?? 8, mult: g.mult || 1 });

  const replayAllLast = !!(finalRule && scores[finalRule.bottomSeat] > 0 && g.matchScores[finalRule.bottomSeat] === g.matchScores[finalRule.fourthSeat]);

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
    let role = g.contract
      ? (g.contract.nap === i ? 'ナポレオン' : !g.contract.revealedCall ? '' : g.contract.deputy === i ? '副官' : '連合軍')
      : (g.phase === 'auction' && g.auction && g.auction.approved && g.auction.approved[i]) ? '保留中' : '';
    e.classList.toggle('deputy-seat', role === '副官');
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



