// ============================================================
// js/ui.js
// 依存: js/core.js
// 役割: カード・座席・ダイアログ・フェーズラベル・契約情報・キティ表示
// ============================================================
import { $, g, name, escapeHTML } from './core.js';

function color(s) { return s === '♥' || s === '♦' ? 'red' : ''; }

// ---------------- カード ----------------
export function cardEl(c, extra) {
  const e = document.createElement('div');
  e.className = 'card ' + (c ? color(c.suit) : '') + ' ' + (extra || '');
  if (c) e.innerHTML = '<span class="rank">' + c.rank + '</span><span class="suit">' + c.suit + '</span>';
  return e;
}

// ---------------- 契約情報 ----------------
export function renderContractInfo() {
  const box = $('contract-info');
  if (!box) return;
  const contract = g.contract;
  if (contract) {
    box.classList.remove('hidden');
    const bid = document.createElement('strong');
    bid.className = 'contract-bid';
    bid.textContent = '宣言 ' + contract.num + contract.suit;
    const label = document.createElement('span');
    label.className = 'contract-call-label';
    label.textContent = '副官札';
    box.replaceChildren(
      bid,
      label,
      contract.call
        ? cardEl(contract.call, 'contract-card')
        : Object.assign(document.createElement('span'), { className: 'contract-pending', textContent: '指名前' })
    );
    return;
  }
  box.classList.add('hidden');
  box.replaceChildren();
}

// ---------------- キティ ----------------
export function showKittyBacks() {
  $('kitty-view').replaceChildren(cardEl(null, 'card-back'), cardEl(null, 'card-back'));
}

export function showOpenKitty() {
  const label = document.createElement('span');
  label.className = 'open-label';
  label.textContent = 'オープン';
  $('kitty-view').replaceChildren(label, ...g.kitty.map(c => cardEl(c)));
}

// ---------------- フェーズラベル ----------------
export function phase(t) {
  const roundTag = g.playoff ? 'プレーオフ · ' : g.round === 9 ? 'ラス前 · ' : g.round >= 10 ? 'オールラスト · ' : '';
  $('phase-label').textContent = roundTag + t;
  $('game-screen').classList.toggle('auctioning', g.phase === 'auction');
  renderContractInfo();
}

// ---------------- 立ち履歴 ----------------
export function bidHistoryHTML(history, getName) {
  const entries = (history || []).slice(-50).reverse();
  return '<div class="bid-history"><div class="bid-history-title">この対局の立ち履歴</div>'
    + (entries.length
      ? '<div class="bid-history-list">' + entries.map(entry =>
          '<div class="bid-history-row player-color-' + entry.seat + '"><small>第' + entry.round + '局</small>'
          + '<span class="bid-player">' + escapeHTML(getName(entry.seat)) + '</span>'
          + '<strong>' + entry.num + entry.suit + '</strong></div>'
        ).join('') + '</div>'
      : '<div class="bid-history-empty">まだありません</div>')
    + '</div>';
}

// ---------------- 獲得カード ----------------
export function addTakenCards(seat, cards = []) {
  const row = document.createElement('div');
  row.className = 'taken-cards';
  const label = document.createElement('span');
  label.className = 'taken-label';
  label.textContent = '獲得 ' + cards.length;
  row.append(label);
  cards.forEach(c => {
    const tag = document.createElement('span');
    tag.className = 'taken-card ' + color(c.suit);
    tag.textContent = c.suit + c.rank;
    row.append(tag);
  });
  seat.append(row);
}

// ---------------- 座席（ローカル用） ----------------
export function drawSeats() {
  const box = $('players-ring');
  box.replaceChildren();
  const leadSeat = g.phase === 'play' && g.trick.length ? g.trick[0].player : g.lastTrickWinner;
  g.players.forEach((p, i) => {
    const e = document.createElement('div');
    e.className = 'player-seat player-color-' + i + ' pos-' + i
      + (i === 0 ? ' me' : '')
      + (i === g.active ? ' active' : '')
      + (i === leadSeat ? ' trick-winner' : '');
    const role = g.contract
      ? (g.contract.nap === i
          ? (g.contract.revealedCall && g.contract.solo ? 'ナポレオン（ひとり立ち）' : 'ナポレオン')
          : !g.contract.revealedCall ? ''
          : g.contract.deputy === i ? '副官' : '連合軍')
      : (g.phase === 'auction' && g.auction && !g.auction.active.includes(i) ? '承認済み' : '');
    e.classList.toggle('deputy-seat', role === '副官');
    e.innerHTML = '<div class="seat-name">' + name(i) + (p.bot ? '<span class="com-badge">COM</span>' : '') + '</div>'
      + (i === leadSeat ? '<div class="lead-badge" role="img" aria-label="トリック先攻"><i></i></div>' : '')
      + '<div class="seat-role ' + (role === '副官' ? 'deputy-status' : '') + '">' + role + '</div>';
    addTakenCards(e, p.taken);
    box.append(e);
  });
}

// ---------------- ダイアログ ----------------
export function dialog(title, text, cb) {
  const d = $('message-dialog');
  const card = $('dialog-card');
  card.classList.add('hidden');
  card.replaceChildren();
  $('dialog-eyebrow').classList.remove('hidden');
  $('dialog-eyebrow').textContent = 'Napoleon';
  $('dialog-ok').textContent = 'OK';
  $('dialog-title').textContent = title;
  $('dialog-body').textContent = text;
  $('dialog-ok').onclick = () => { d.close(); if (cb) cb(); };
  d.showModal();
}

export function announceCall(card, onConfirm, online = false) {
  const d = $('message-dialog');
  const slot = $('dialog-card');
  $('dialog-eyebrow').classList.add('hidden');
  $('dialog-title').textContent = 'DEPUTY CALL';
  slot.classList.remove('hidden');
  slot.replaceChildren(cardEl(card, 'announcement-card'));
  $('dialog-body').textContent = online
    ? '全員が確認すると最初のトリックが始まります。'
    : '確認して、最初のトリックを始めます。';
  $('dialog-ok').textContent = online ? '確認' : '最初のトリックへ';
  $('dialog-ok').onclick = () => {
    d.close();
    slot.classList.add('hidden');
    slot.replaceChildren();
    $('dialog-eyebrow').classList.remove('hidden');
    $('dialog-eyebrow').textContent = 'Napoleon';
    $('dialog-ok').textContent = 'OK';
    if (onConfirm) onConfirm();
  };
  d.showModal();
}
