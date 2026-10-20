// ============================================================
// js/core.js
// 依存: constants.js のみ
// 役割: ゲーム状態 g、画面切替、タイマー、トースト、汎用ユーティリティ
// ============================================================
import { SUITS, RANKS, SV, FACE, POINT } from '../constants.js';

export const $ = id => document.getElementById(id);

export const g = {
  round: 1, rate: 1000, mult: 1, botLevel: 3,
  aiWeights: {
    bidThreshold: 4.0, riskTolerance: 0.5, leadAggression: 0.6, followAggression: 0.4,
    trumpBonus: 0.6, mightyBonus: 2.0, safeAceWeight: 0.7, roleCardPreservation: 0.6,
    deputyFeedBias: 0.5, opponentInferenceWeight: 0.4, suitConflictWeight: 0.6,
    mightyShadowWeight: 0.3, weakOpponentBoost: 0.3, bluffLossMultiplier: 0.6,
    cooperationBonus: 0.5, ntPreference: 1.0, ntSuitLengthBonus: 1.5, ntAceWeight: 2.0,
    ntMightyBonus: 3.5, highBidNtThreshold: 16, aceWeakSuitBonus: 0.3, aceShortBonus: 0.15,
    aceLongPenalty: 0.15, sameTwoAceCounter: 0.3, sameTwoShortBonus: 0.4,
    sameTwoLongPenalty: 0.25, sameTwoHighBidBonus: 0.2, trumpExhaustionThreshold: 3,
    baitModeWindow: 2, baitMinTrumps: 4, strongTrumpLeadAggression: 0.7, aceCashUrgency: 1.0,
    pointCardSafetyThreshold: 0.5, tenHoldThreshold: 0.6, nonTrumpAceWaiting: 0.5,
    baitBackJWindow: 3, baitBackJChance: 0.6, faceCardOnNapWin: 0.9, preserveNextStronger: 0.9,
    deputyRevealUrgency: 0.5, deputyCoverWeight: 0.5, sameTwoDeputyBonus: 0.5,
    allyFaceCardBonus: 0.9, napWeaknessLeadWeight: 0.8, trumpAvoidWeight: 0.9,
    sameColorSuitAvoid: 0.8, spadeLeadPriority: 0.7, nonDeclaredSuitWeight: 0.6,
    queenHoardWeight: 0.6, sameTwoHoardWeight: 0.5, allyYieldBonus: 0.5
  },
  players: [], kitty: [], auction: null, contract: null,
  trick: [], trickNo: 0,
  points: [0, 0, 0, 0, 0],
  matchScores: [0, 0, 0, 0, 0], matchArt: [0, 0, 0, 0, 0],
  matchStats: [], matchContracts: [],
  playoff: false, appealInfo: '', roundArt: [0, 0, 0, 0, 0],
  phase: '', bid: 13, suit: '♠',
  timer: [], greenRedraws: 0,
  selectedCard: null, onlineSelectedCard: null,
  user: null, account: null, sessionToken: null,
  room: null, presenceRoom: null, online: null,
  leaderboardExpanded: false,
  announcedCallRound: null, announcedRound: null,
  localLog: null, matchDebugLog: null,
  playedCards: [], voids: [{}, {}, {}, {}, {}],
  bidHistory: []
};

// ---------------- トースト ----------------
let toastTimer;
export function toast(text) {
  const el = $('toast');
  el.textContent = text;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 2600);
}

// ---------------- 画面切替（フック方式で依存を逆転） ----------------
let screenHooks = {};
export function setScreenHooks(hooks) { Object.assign(screenHooks, hooks); }
export function screen(id) {
  ['home-screen', 'profile-screen', 'game-screen', 'records-screen', 'strategy-screen']
    .forEach(x => $(x).classList.toggle('hidden', x !== id));
  if (id === 'home-screen' && screenHooks.onHome) screenHooks.onHome();
  if (id === 'strategy-screen' && screenHooks.onStrategy) screenHooks.onStrategy();
}

// ---------------- タイマー ----------------
export function later(fn, ms) { g.timer.push(setTimeout(fn, ms)); }
export function clearTimers() { g.timer.forEach(clearTimeout); g.timer = []; }

// ---------------- オンライン切断 ----------------
export function closeOnline() {
  clearTimers();
  clearTimeout(g.auction?.humanTimeout);
  g.room?.close?.();
  g.room = null;
  g.online = null;
  g.onlineState = null;
  g.privateHand = [];
  g.onlineLegal = [];
  g.onlineSelectedCard = null;
  $('auction-clock').classList.add('hidden');
}

// ---------------- 汎用 ----------------
export function message(text) { $('table-message').textContent = text; }
export function name(i) { return i === 0 ? 'あなた' : (g.players[i]?.name || 'COM ' + i); }
export function escapeHTML(value) {
  return String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
export function code() { return Math.random().toString(36).slice(2, 7).toUpperCase(); }

export function sort(hand) {
  hand.sort((a, b) => SV[b.suit] - SV[a.suit] || RANKS.indexOf(b.rank) - RANKS.indexOf(a.rank));
}

export function deck() {
  const d = [];
  SUITS.forEach(s => RANKS.forEach(r => d.push({ suit: s, rank: r, id: s + r })));
  for (let i = d.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [d[i], d[j]] = [d[j], d[i]];
  }
  return d;
}

export async function getUser() {
  try { g.user = await window.websim?.getUser?.() || null; } catch { g.user = null; }
  return g.user;
}

export function sendGame(action) { g.room?.send({ type: 'game', action }); }

// 再エクスポート（子モジュールが constants を直接importせずに済むよう便宜提供）
export { SUITS, RANKS, SV, FACE, POINT };
