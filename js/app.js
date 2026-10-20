// ============================================================
// js/app.js
// 依存: js/core.js, js/debug.js, js/screens/*
// 役割: エントリポイント。画面フック登録と全イベント配線
// ============================================================
window.onerror = function(message, source, lineno, colno, error) {
  alert("JSエラー:\n" + message + "\n\n場所: " + source + "\n行: " + lineno);
};
import { $, g, screen, setScreenHooks, closeOnline, code, toast } from './core.js';
import { openGameLog, downloadLog, addDebugLog } from './debug.js';
import { startLocal } from './screens/game-local.js';
import { online } from './screens/game-online.js';
import { account, records } from './screens/profile.js';
import { loadAccount, loadLeaderboard, toggleLeaderboard, startPresence } from './screens/home.js';
import { loadStrategyLab } from './screens/strategy.js';

// ---------------- 画面遷移フック ----------------
setScreenHooks({
  onHome: () => {
    loadLeaderboard();
    loadAccount();
    startPresence();
  },
  onStrategy: () => loadStrategyLab()
});

// ---------------- ホーム画面 ----------------
$('start-com').onclick = () => startLocal();
$('start-ranked').onclick = () => online('ranked', '', 0);

$('create-friend').onclick = () => {
  const c = code();
  $('friend-code').value = c;
  online('friend', c, Number($('com-count').value), 3);
};
$('join-friend').onclick = () => {
  const c = $('friend-code').value.trim().toUpperCase();
  if (!c) { toast('合言葉を入力してください'); return; }
  online('friend', c, Number($('com-count').value), 3);
};

$('show-ranking').onclick = () => toggleLeaderboard();
$('show-record').onclick = records;
$('profile-open').onclick = () => g.account ? records() : screen('profile-screen');
$('open-strategy-lab').onclick = () => screen('strategy-screen');

// ---------------- ゲーム画面 ----------------
$('leave-game').onclick = () => { closeOnline(); screen('home-screen'); };
$('game-log-open').onclick = openGameLog;
$('game-log-close').onclick = () => $('game-log-dialog').close();
$('game-log-download').onclick = downloadLog;

// ---------------- プロフィール画面 ----------------
$('register-account').onclick = () => account('/api/account/register');
$('login-account').onclick = () => account('/api/account/login');

// ---------------- 戻るボタン ----------------
document.querySelectorAll('[data-go-home]').forEach(b => {
  b.onclick = () => screen('home-screen');
});

// ---------------- グローバルエラー ----------------
window.addEventListener('error', e => {
  try {
    addDebugLog('global-error', {
      message: e.message, stack: e.error?.stack,
      filename: e.filename, line: e.lineno, col: e.colno,
      phase: g.phase, round: g.round
    });
  } catch {}
});
window.addEventListener('unhandledrejection', e => {
  try {
    addDebugLog('unhandled-rejection', {
      message: e.reason?.message || String(e.reason),
      stack: e.reason?.stack,
      phase: g.phase, round: g.round
    });
  } catch {}
});

// ---------------- オンライン競り時計 ----------------
setInterval(() => {
  if (g.onlineState
    && ['prep', 'call', 'discard', 'play'].includes(g.onlineState.phase)
    && g.onlineState.deadline) {
    $('auction-clock').textContent =
      Math.max(0, Math.ceil((g.onlineState.deadline - Date.now()) / 1000)) + '秒';
  }
}, 250);

// ---------------- 初期ロード ----------------
loadAccount();
loadLeaderboard();
