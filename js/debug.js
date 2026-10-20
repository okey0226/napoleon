// ============================================================
// js/debug.js
// 依存: js/core.js のみ
// 役割: デバッグログ、局ログ（ユーザー向け）、ログDL
// ============================================================
import { $, g, escapeHTML, toast } from './core.js';

// ---------------- デバッグログ ----------------
export function addDebugLog(type, data) {
  if (!g.matchDebugLog) g.matchDebugLog = [];
  const entry = { t: Date.now(), type };
  if (data && typeof data === 'object') {
    for (const k in data) { try { entry[k] = data[k]; } catch {} }
  }
  g.matchDebugLog.push(entry);
  if (g.matchDebugLog.length > 3000) g.matchDebugLog.shift();
}

export function sanitizeForLog(obj, depth = 0) {
  if (depth > 6) return '[deep]';
  if (obj === null || obj === undefined) return obj;
  const t = typeof obj;
  if (t === 'function') return '[fn]';
  if (t === 'string' || t === 'number' || t === 'boolean') return obj;
  if (Array.isArray(obj)) return obj.map(x => sanitizeForLog(x, depth + 1));
  if (t === 'object') {
    const out = {};
    for (const k in obj) {
      try { out[k] = sanitizeForLog(obj[k], depth + 1); } catch { out[k] = '[err]'; }
    }
    return out;
  }
  return String(obj);
}

export function buildLogPayload() {
  const contract = g.contract ? {
    nap: g.contract.nap, num: g.contract.num, suit: g.contract.suit,
    deputy: g.contract.deputy, solo: g.contract.solo, call: g.contract.call,
    revealedCall: g.contract.revealedCall, revealTrickNo: g.contract.revealTrickNo
  } : null;
  return {
    version: 'v1', timestamp: new Date().toISOString(),
    userAgent: navigator.userAgent, url: location.href,
    phase: g.phase, round: g.round, botLevel: g.botLevel,
    aiWeights: sanitizeForLog(g.aiWeights),
    account: g.account ? { id: g.account.id, rating: g.account.rating } : null,
    contract,
    players: (g.players || []).map((p, i) => ({
      seat: i, name: p.name, bot: p.bot,
      handCount: p.hand?.length ?? 0,
      roundPoints: p.roundPoints ?? 0,
      taken: (p.taken || []).map(c => c.id)
    })),
    kitty: (g.kitty || []).map(c => c.id),
    matchScores: g.matchScores, matchArt: g.matchArt,
    matchContracts: g.matchContracts, bidHistory: g.bidHistory,
    trickNo: g.trickNo,
    trick: (g.trick || []).map(e => ({ seat: e.player, card: e.card?.id })),
    playedCards: g.playedCards, voids: g.voids,
    localLog: g.localLog, debugLog: g.matchDebugLog
  };
}

export function downloadLog() {
  try {
    const payload = buildLogPayload();
    const json = JSON.stringify(payload, null, 2);
    const blob = new Blob([json], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    a.href = url;
    a.download = 'napoleon-log-' + ts + '.json';
    document.body.appendChild(a);
    a.click();
    setTimeout(() => { document.body.removeChild(a); URL.revokeObjectURL(url); }, 100);
    toast('ログをダウンロードしました');
  } catch (e) {
    console.error('download failed', e);
    toast('ダウンロードに失敗しました: ' + e.message);
  }
}

export function logPlayDecision(seat, card, reasonInfo, context) {
  try {
    addDebugLog('play-decision', {
      seat, round: g.round, trickNo: g.trickNo, card: card?.id,
      reason: reasonInfo?.reason,
      detail: sanitizeForLog(reasonInfo?.detail),
      context: sanitizeForLog(context)
    });
  } catch (e) {
    addDebugLog('play-decision-log-error', { message: e?.message });
  }
}

export function buildPlayContext(seat) {
  return {
    hand: (g.players[seat]?.hand || []).map(c => c.id),
    trick: (g.trick || []).map(x => ({ seat: x.player, card: x.card?.id })),
    contract: g.contract ? {
      nap: g.contract.nap, num: g.contract.num, suit: g.contract.suit,
      solo: g.contract.solo, deputy: g.contract.deputy,
      call: g.contract.call, revealedCall: g.contract.revealedCall
    } : null,
    aiWeights: g.aiWeights,
    points: g.points.slice(),
    roundPoints: g.players.map(p => p.roundPoints || 0),
    matchScores: g.matchScores.slice(),
    voids: g.voids, playedCards: g.playedCards
  };
}

// ---------------- 局ログ（ユーザー向け） ----------------
export function addGameLog(text) {
  if (!g.localLog) return;
  g.localLog.push({ round: g.round, text });
  if (g.localLog.length > 300) g.localLog.shift();
  const countEl = $('game-log-count');
  if (countEl) countEl.textContent = String(g.localLog.length);
  if ($('game-log-dialog').open) renderGameLog();
}

export function renderGameLog() {
  const list = $('game-log-list');
  list.innerHTML = g.localLog?.length
    ? g.localLog.map(entry =>
        '<article class="game-log-entry"><small>第' + entry.round + '局</small><span>' + escapeHTML(entry.text) + '</span></article>'
      ).join('')
    : '<p class="game-log-empty">まだログはありません</p>';
  list.scrollTop = list.scrollHeight;
}

export function openGameLog() {
  renderGameLog();
  $('game-log-dialog').showModal();
}
