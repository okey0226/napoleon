// ============================================================
// js/api.js
// 依存: js/core.js
// 役割: /api/* への fetch 呼び出しを薄くラップ
// ============================================================
import { g } from './core.js';

const SESSION_KEY = 'napoleon_session';

// ---------------- セッション ----------------
export function getSessionToken() { return localStorage.getItem(SESSION_KEY); }
export function setSessionToken(t) { if (t) localStorage.setItem(SESSION_KEY, t); }
export function clearSessionToken() { localStorage.removeItem(SESSION_KEY); }

// ---------------- アカウント ----------------
export async function registerAccount(id, password) {
  const r = await fetch('/api/account/register', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ id, password })
  });
  const d = await r.json();
  if (!r.ok) throw Error(d.error || '処理できませんでした');
  return d;
}

export async function loginAccount(id, password) {
  const r = await fetch('/api/account/login', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ id, password })
  });
  const d = await r.json();
  if (!r.ok) throw Error(d.error || '処理できませんでした');
  return d;
}

export async function fetchAccountMe(token) {
  if (!token) return null;
  const r = await fetch('/api/account/me', { headers: { 'x-session-token': token } });
  return r.ok ? await r.json() : null;
}

// ---------------- ランキング ----------------
export async function fetchLeaderboard() {
  const r = await fetch('/api/rating/top');
  return r.ok ? await r.json() : null;
}

// ---------------- AI戦略 ----------------
export async function fetchTopStrategy() {
  const r = await fetch('/api/ai/top-strategy');
  return r.ok ? await r.json() : null;
}

export async function loadTopStrategy() {
  try {
    const data = await fetchTopStrategy();
    if (data?.strategy) {
      Object.assign(g.aiWeights, data.strategy);
      if (data.source === 'learned' && data.generation) {
        console.log('[AI] Top strategy loaded: gen ' + data.generation + ', avgRating: ' + data.avgRating);
      }
    }
  } catch {}
}

export async function postAiReport(payload) {
  try {
    const r = await fetch('/api/ai/report', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload)
    });
    return r.ok ? await r.json() : null;
  } catch { return null; }
}

export async function fetchStrategies(limit = 10) {
  const r = await fetch('/api/ai/strategies?limit=' + limit);
  return r.ok ? await r.json() : [];
}

export async function fetchInsights() {
  const r = await fetch('/api/ai/insights');
  return r.ok ? (await r.json()).insights || [] : [];
}

export async function fetchGenerations() {
  const r = await fetch('/api/ai/generations');
  return r.ok ? await r.json() : [];
}

export async function runSelfPlay(matches) {
  const r = await fetch('/api/ai/run-selfplay', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ matches })
  });
  const data = await r.json();
  if (!r.ok || data.error) throw new Error(data.error || `HTTP ${r.status}`);
  return data;
}

export async function setupDb() {
  const r = await fetch('/api/setup-db');
  return r.ok;
}
