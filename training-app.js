// training-app.js — 5人全員を操作するトレーニングモード
import { SUITS, RANKS, SV, defaultStrategy, shuffledDeck, sortHand } from './constants.js';
import { shouldBid, chooseDiscard, chooseDeputyCall, chooseCardToPlay, winningEntry, colorStrength, ntHandStrength } from './ai-tactics.js';

const $ = id => document.getElementById(id);

// ===== 追加: app.js で定義されているユーティリティ関数 =====
function escapeHTML(value) {
  return String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function toast(t) {
  const e = $('toast');
  if (!e) return;
  e.textContent = t;
  e.classList.add('show');
  clearTimeout(e._timer);
  e._timer = setTimeout(() => e.classList.remove('show'), 2600);
}
function dialog(title, text, cb) {
  let d = $('message-dialog'), card = $('dialog-card');
  if (!d || !card) return;
  document.querySelectorAll('dialog[open]').forEach(dlg => { try { if (dlg !== d) dlg.close(); } catch {} });
  try { if (d.open) d.close(); } catch {}
  card.classList.add('hidden'); card.replaceChildren();
  const de = $('dialog-eyebrow'); if (de) { de.classList.remove('hidden'); de.textContent = 'Napoleon'; }
  const dok = $('dialog-ok'); if (dok) dok.textContent = 'OK';
  const dt = $('dialog-title'), db = $('dialog-body');
  if (dt) dt.textContent = title; if (db) db.textContent = text;
  if (dok) dok.onclick = () => { d.close(); if (cb) cb() };
  try { d.showModal(); } catch (e) { console.warn('[dialog] showModal failed', e?.message); }
}
// =========================================================

const g = {
  round: 1, players: [], kitty: [], discardedKitty: [], allianceKittyPoints: 0,
  contract: null, trick: [], trickNo: 0, playedCards: [], voids: [{},{},{},{},{}],
  bidHistory: [], auction: null, selectedCard: null, discard: new Set(),
  selectedBidSuit: '♠', selectedCallSuit: '♠', selectedCallRank: 'A',
  lastTrickWinner: null, matchScores: [0,0,0,0,0], phase: 'prep', active: 0,
  roundLog: { bid: null, call: null, playDecisions: [] } // ★ 学習ログ用
};

function name(i) { return `COM${i + 1}`; }

function screen(id) {
  ['home-screen','mode-select-screen','profile-screen','game-screen','records-screen','strategy-screen','quiz-screen','training-screen'].forEach(x => {
    const el = $(x); if (el) el.classList.toggle('hidden', x !== id);
  });
  if (id === 'mode-select-screen') { loadLeaderboard(); loadAccount(); startPresence(); }
  if (id === 'strategy-screen') { loadStrategyLab(); }
}

export function openTrainingScreen() {
  const screens = ['home-screen','mode-select-screen','profile-screen','game-screen','records-screen','strategy-screen','quiz-screen'];
  screens.forEach(id => {
    const el = $(id);
    if (el) { el.classList.add('hidden'); el.style.setProperty('display', 'none', 'important'); }
  });
  const screen = $('training-screen');
  if (!screen) return;
  screen.classList.remove('hidden');
  screen.style.setProperty('display', 'flex', 'important');
  screen.style.setProperty('position', 'fixed', 'important');
  screen.style.setProperty('inset', '0', 'important');
  screen.style.setProperty('z-index', '99999', 'important');
  screen.style.setProperty('background', '#0b2620', 'important');
  screen.style.setProperty('flex-direction', 'column', 'important');
  
  startTraining();
}

function startTraining() {
  g.round = 1;
  g.matchScores = [0,0,0,0,0];
  g.players = Array.from({ length: 5 }, (_, i) => ({
    name: name(i), username: name(i), originalName: name(i), abandoned: false, bot: false,
    hand: [], taken: [], roundTaken: [], roundPoints: 0
  }));
  roundStart();
}

function roundStart() {
  g.phase = 'prep';
  g.trick = []; g.trickNo = 0; g.playedCards = []; g.voids = [{},{},{},{},{}];
  g.contract = null; g.auction = null; g.bidHistory = []; g.lastTrickWinner = null;
  g.discardedKitty = []; g.allianceKittyPoints = 0; g.selectedCard = null;
  g.discard = new Set();
  g.roundLog = { bid: null, call: null, playDecisions: [] }; // ★ リセット
  
  const d = shuffledDeck();
  g.players.forEach(p => { p.hand = d.splice(0, 10); p.taken = []; p.roundTaken = []; p.roundPoints = 0; sortHand(p.hand); });
  g.kitty = d.splice(0, 2);
  
  renderTraining();
  phase('配札');
  message('手札を確認しています');
  setTimeout(() => prepAuction(), 1000);
}

function prepAuction() {
  g.phase = 'prep';
  let n = 3;
  message(`競り開始まで ${n} 秒`);
  const tick = () => {
    n--;
    if (n <= 0) { auctionStart(); return; }
    message(`競り開始まで ${n} 秒`);
    setTimeout(tick, 1000);
  };
  setTimeout(tick, 1000);
}

function auctionStart() {
  g.phase = 'auction';
  g.selectedBidSuit = '♠';
  g.auction = {
    active: [0, 1, 2, 3, 4],
    minBid: 13,
    high: { num: 12, suit: '', player: -1, solo: false },
    version: 0, botSeen: Array(5).fill(-1)
  };
  g.active = 0;
  enterAuction();
}

function enterAuction() {
  g.phase = 'auction';
  const high = g.auction.high;
  const highStr = high.num >= 13 ? `${high.num}${high.suit} (${name(high.player)})` : 'なし';
  message(`現在の手番: ${name(g.active)} ｜ 最高宣言: ${highStr}`);
  renderTraining();
}

function humanApprove() {
  if (g.phase !== 'auction' || !g.auction.active.includes(g.active)) return;
  
  g.auction.active = g.auction.active.filter(x => x !== g.active);
  g.auction.botSeen[g.active] = g.auction.version;
  message(`${name(g.active)}が承認しました。`);
  
  nextAuctionTurn();
}

function humanSkip() {
  if (g.phase !== 'auction') return;
  if (!g.auction.active.includes(g.active)) return;
  
  message(`${name(g.active)}がスキップしました。`);
  
  if (g.auction.active.length === 1 && g.auction.active[0] === g.active) {
    humanApprove();
    return;
  }
  
  let nextSeat = (g.active + 4) % 5;
  while (!g.auction.active.includes(nextSeat)) {
    nextSeat = (nextSeat + 4) % 5;
  }
  g.active = nextSeat;
  enterAuction();
}

function humanBid() {
  if (g.phase !== 'auction' || !g.auction.active.includes(g.active)) return;
  const numInput = $('training-bid-num');
  const num = numInput ? Number(numInput.value) : 13;
  const suit = g.selectedBidSuit;
  
  if (!beatsBid(num, suit)) { toast('現在の宣言より強い宣言を選んでください'); return; }
  
  g.bidHistory.push({ round: g.round, seat: g.active, num, suit });
  g.auction.high = { num, suit, player: g.active, solo: false };
  g.auction.version++;
  
  // ★ ログに記録
  const cs = colorStrength(g.players[g.active].hand, suit, defaultStrategy());
  const nt = ntHandStrength(g.players[g.active].hand, defaultStrategy());
  const handStr = suit === 'NT' ? nt : cs;
  g.roundLog.bid = { strengthKey: Math.round(handStr * 2) / 2, trumpType: suit === 'NT' ? 'NT' : 'color', num };
  
  if (g.auction.active.length === 1 && g.auction.active[0] === g.active) {
    auctionEnd(g.active);
    return;
  }
  nextAuctionTurn();
}

function beatsBid(n, s) {
  const h = g.auction.high;
  return n >= g.auction.minBid && (n > h.num || (n === h.num && SV[s] > SV[h.suit]));
}

function nextAuctionTurn() {
  if (g.auction.active.length === 0) {
    auctionEnd(g.auction.high.player);
    return;
  }
  
  if (g.auction.active.length === 1) {
    g.active = g.auction.active[0];
  } else {
    let nextSeat = (g.active + 4) % 5;
    while (!g.auction.active.includes(nextSeat)) {
      nextSeat = (nextSeat + 4) % 5;
    }
    g.active = nextSeat;
  }
  enterAuction();
}

function auctionEnd(w) {
  if (w < 0 || g.auction.high.num < 13) {
    dialog('流局', '宣言がありませんでした。配り直します。', roundStart);
    return;
  }
  const suit = g.auction.high.suit;
  const strengthAtBid = suit === 'NT' ? ntHandStrength(g.players[w].hand, defaultStrategy()) : colorStrength(g.players[w].hand, suit, defaultStrategy());
  g.contract = { nap: w, num: g.auction.high.num, suit, deputy: -1, solo: false, revealTrickNo: null, strengthAtBid };
  
  g.players[w].hand.push(...g.kitty);
  sortHand(g.players[w].hand);
  
  g.active = w;
  g.discard = new Set();
  message(`${name(w)}が${g.contract.num}${g.contract.suit}で宣言。オープンを手札に入れて2枚捨ててください。`);
  g.phase = 'discard';
  renderTraining();
}

function submitDiscard() {
  if (g.discard.size !== 2) return;
  const n = g.contract.nap;
  
  const removed = g.players[n].hand.filter(c => g.discard.has(c.id));
  g.players[n].hand = g.players[n].hand.filter(c => !g.discard.has(c.id));
  sortHand(g.players[n].hand);
  
  g.kitty = removed;
  g.discardedKitty = removed.slice();
  g.allianceKittyPoints += removed.filter(c => ['10','J','Q','K','A'].includes(c.rank)).length;
  
  g.discard = new Set();
  g.selectedCard = null;
  g.phase = 'call';
  g.selectedCallSuit = '♠';
  g.selectedCallRank = 'A';
  message(`${name(n)}が捨て札を決めました。副官に指名するカードを選んでください。`);
  renderTraining();
}

function submitCall() {
  const n = g.contract.nap;
  const suit = g.selectedCallSuit;
  const rank = g.selectedCallRank;
  const id = suit + rank;
  
  if (g.kitty.some(c => c.id === id)) { toast('捨て札は指名できません'); return; }
  
  const isOwn = g.players[n].hand.some(c => c.id === id);
  g.contract.call = { suit, rank, id };
  g.contract.solo = isOwn;
  
  const deputy = g.players.findIndex((p, i) => i !== n && p.hand.some(c => c.id === id));
  g.contract.deputy = deputy >= 0 ? deputy : n;
  
  // ★ ログに記録
  g.roundLog.call = { callId: id, trumpSuit: g.contract.suit };
  
  g.kitty = [];
  g.phase = 'play';
  g.active = n;
  g.trick = [];
  g.trickNo = 0;
  g.selectedCard = null;
  message(`${id}を指名しました。カードプレイを開始します。`);
  renderTraining();
  nextPlayTurn();
}

function nextPlayTurn() {
  g.phase = 'play';
  g.selectedCard = null;
  renderTraining();
  message(`現在の手番: ${name(g.active)}`);
}

function playCard(cardId) {
  if (g.phase !== 'play') return;
  const seat = g.active;
  const legalCards = getLegalCards(seat);
  const card = legalCards.find(c => c.id === cardId);
  if (!card) return;
  
  const hand = g.players[seat].hand;
  hand.splice(hand.findIndex(x => x.id === cardId), 1);
  g.trick.push({ player: seat, card });
  g.playedCards.push({ suit: card.suit, rank: card.rank, id: card.id, seat });
  g.selectedCard = null;
  
  if (g.trick.length > 1) {
    const ledSuit = g.trick[0].card.suit;
    if (card.suit !== ledSuit) {
      if (!g.voids[seat]) g.voids[seat] = {};
      g.voids[seat][ledSuit] = true;
    }
  }
  
  const reveal = g.contract.call?.id === card.id && !g.contract.revealedCall;
  if (reveal) {
    g.contract.revealedCall = true;
    g.contract.revealTrickNo = g.trickNo;
  }
  
  // ★ ログに記録
  const role = g.contract.nap === seat ? 'nap' : (!g.contract.solo && g.contract.revealedCall && g.contract.deputy === seat ? 'dep' : 'ally');
  const phase = trickPhaseOf(g.trickNo);
  const pointsTier = pointsTierOf(g.trick.filter(e => ['10','J','Q','K','A'].includes(e.card.rank)).length);
  const rankTier = rankTierOf(card.rank);
  g.roundLog.playDecisions.push({ trickNo: g.trickNo, role, phase, pointsTier, rankTier, won: null });
  
  if (g.trick.length < 5) {
    g.active = (seat + 4) % 5;
    nextPlayTurn();
    return;
  }
  
  const w = winningEntry(g.contract, g.trickNo, g.trick.map(e => ({ seat: e.player, card: e.card }))).seat;
  g.lastTrickWinner = w;
  
  // ★ トリック勝敗をログに記録
  const isNapSideWin = (w === g.contract.nap || (!g.contract.solo && w === g.contract.deputy));
  for (const d of g.roundLog.playDecisions) {
    if (d.trickNo === g.trickNo && d.won === null) {
      const amINapSide = d.role === 'nap' || d.role === 'dep';
      d.won = amINapSide ? isNapSideWin : !isNapSideWin;
    }
  }

  const taken = g.trick.filter(e => ['10','J','Q','K','A'].includes(e.card.rank)).map(e => e.card);
  g.players[w].taken.push(...taken);
  g.players[w].roundTaken.push(...taken);
  g.players[w].roundPoints += taken.length;
  
  g.trickNo++;
  g.trick = [];
  g.active = w;
  
  const c = g.contract;
  const napPoints = g.players.reduce((sum, p, i) => sum + (i === c.nap || (!c.solo && i === c.deputy) ? p.roundPoints : 0), 0);
  const alliancePointsRaw = g.players.reduce((sum, p, i) => sum + (i !== c.nap && (c.solo || i !== c.deputy) ? p.roundPoints : 0), 0);
  const alliancePoints = alliancePointsRaw + (g.allianceKittyPoints || 0);
  
  let earlyFinish = false;
  if (alliancePoints > 20 - c.num) earlyFinish = true;
  else if (napPoints >= c.num && (c.num === 20 || alliancePoints >= 1)) earlyFinish = true;
  else if (napPoints === 20 && c.num < 20) earlyFinish = true;

  if (g.trickNo >= 10 || earlyFinish) {
    finishTrainingRound();
    return;
  }
  
  message(`${name(w)}が場札を取りました。次の勝負です。`);
  renderTraining();
  setTimeout(nextPlayTurn, 1000);
}

function getLegalCards(seat) {
  const h = g.players[seat].hand;
  if (!g.trick.length) return h;
  const ledSuit = g.trick[0].card.suit;
  const follow = h.filter(c => c.suit === ledSuit);
  return follow.length ? follow : h;
}

function finishTrainingRound() {
  const c = g.contract;
  const side = c.solo ? [c.nap] : [c.nap, c.deputy];
  const pts = side.reduce((n, i) => n + g.players[i].roundPoints, 0);
  const success = pts >= c.num && (c.num === 20 || pts < 20);
  
  // ★ AI学習用に正しい勝敗を送信
  const payload = {
    round: g.round, wonRound: success,
    bid: g.roundLog.bid, call: g.roundLog.call,
    playDecisions: g.roundLog.playDecisions.filter(d => d.won !== null)
  };
  if (payload.bid || payload.call || payload.playDecisions.length) {
    fetch('/api/ai/learn', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload)
    }).catch(() => {});
  }

  const unit = Math.max(0, c.num - 12);
  const sign = success ? 1 : -1;
  const scores = [0,0,0,0,0];
  scores[c.nap] = sign * unit * (c.solo ? 4 : 2);
  if (c.solo) {
    g.players.forEach((_, i) => { if (i !== c.nap) scores[i] = -sign * unit; });
  } else {
    scores[c.deputy] = sign * unit;
    g.players.forEach((_, i) => { if (i !== c.nap && i !== c.deputy) scores[i] = -sign * unit; });
  }
  for (let i = 0; i < 5; i++) g.matchScores[i] += scores[i];
  
  const r = $('training-result-panel');
  if (!r) return;
  r.classList.remove('hidden');
  r.innerHTML = `
    <div class="eyebrow">TRAINING RESULT</div>
    <h2>${success ? 'NAP WIN' : 'ALLIANCE WIN'}</h2>
    <p>宣言 ${c.num}${c.suit} · 獲得 ${pts}枚</p>
    <div class="round-score-list">
      ${g.players.map((p, i) => `<div class="round-score-row"><span>${name(i)}</span><strong class="${scores[i] < 0 ? 'score-down' : 'score-up'}">${scores[i] > 0 ? '+' : ''}${scores[i]}<small>TOTAL ${g.matchScores[i]}</small></strong></div>`).join('')}
    </div>
    <button id="training-next-round" class="primary-button">次のラウンドへ</button>
  `;
  $('training-next-round').onclick = () => {
    r.classList.add('hidden');
    g.round++;
    if (g.round > 10) {
      dialog('終了', 'トレーニングを終了します。', () => {
        $('training-screen').classList.add('hidden');
        $('training-screen').style.setProperty('display', 'none', 'important');
        $('mode-select-screen').classList.remove('hidden');
        $('mode-select-screen').style.removeProperty('display');
      });
      return;
    }
    roundStart();
  };
}

function cardElHTML(c, extra = '', style = '', dataAttrs = '') {
  if (!c) return `<div class="card card-back ${extra}" style="${style}" ${dataAttrs}></div>`;
  const red = c.suit === '♦' || c.suit === '♥';
  return `<div class="card ${red ? 'red ' : ''}${extra}" style="${style}" ${dataAttrs}><span class="rank">${c.rank}</span><span class="suit">${c.suit}</span></div>`;
}

function renderTraining() {
  const shell = $('training-shell');
  if (!shell) return;
  
  const mySeat = g.active;
  const handCards = g.players[mySeat].hand || [];
  const legalIds = getLegalCards(mySeat).map(c => c.id);
  const isDiscardPhase = (g.phase === 'discard' && g.active === g.contract?.nap);
  
  let trickHTML = '';
  if (g.trick.length) {
    trickHTML = g.trick.map(e => {
      const pos = (e.player - mySeat + 5) % 5;
      return `<div class="trick-card played-seat-${pos}">${cardElHTML(e.card)}</div>`;
    }).join('');
  }
  
  let discardHTML = '';
  if (isDiscardPhase) {
    discardHTML = `
      <div class="training-discard-panel" style="display:flex; flex-direction:column; gap:8px; align-items:center; margin-top:10px;">
        <div class="training-discard-hint" style="font-size:16px; font-weight:700; color:#e8d7a9;">捨て札を2枚選んでください (${g.discard.size}/2)</div>
        <button id="training-discard-submit" class="primary-button" style="min-height:48px; width:200px;" ${g.discard.size !== 2 ? 'disabled' : ''}>決定</button>
      </div>
    `;
  }
  
  let auctionHTML = '';
  if (g.phase === 'auction') {
    const high = g.auction.high;
    const highStr = high.num >= 13 ? `<strong>${high.num}${high.suit}</strong> (${name(high.player)})` : 'なし';
    const highBidHTML = `<div class="panel-title" style="margin-bottom:10px;">現在の宣言: ${highStr}</div>`;

    if (!g.auction.active.includes(g.active)) {
      auctionHTML = `<div class="training-auction-panel" style="text-align:center; color:#a3b1a8; padding:20px;">${highBidHTML}このプレイヤーは承認済みです。<br>席をタップして操作を切り替えてください。</div>`;
    } else {
      const suitBtns = SUITS.concat(['NT']).map(s => 
        `<button class="suit-choice ${g.selectedBidSuit === s ? 'selected' : ''}" data-suit="${s}">${s}</button>`
      ).join('');
      
      const currentBid = $('training-bid-num') ? Number($('training-bid-num').value) : 13;
      
      auctionHTML = `
        <div class="training-auction-panel">
          ${highBidHTML}
          <div class="panel-row">${suitBtns}</div>
          <div class="panel-row" style="display:flex; gap:8px; align-items:center; justify-content:center; margin-top:8px;">
            <button id="training-bid-minus" class="small-action" style="font-size:24px; width:48px; height:48px;">−</button>
            <input type="number" id="training-bid-num" min="13" max="20" value="${currentBid}" style="width:60px; text-align:center; font-size:24px; font-weight:800; background:#0c211c; color:#f3d48e; border:1px solid #35534a; border-radius:6px; padding:6px;">
            <button id="training-bid-plus" class="small-action" style="font-size:24px; width:48px; height:48px;">＋</button>
          </div>
          <div class="panel-row" style="margin-top:10px; display:flex; gap:8px;">
            <button id="training-bid-submit" class="primary-button" style="flex:1; min-height:48px;">宣言する</button>
            <button id="training-approve" class="secondary-button" style="flex:1; min-height:48px;">承認する</button>
            <button id="training-skip" class="secondary-button" style="flex:1; min-height:48px; background:#49302b; color:#fff;">スキップ</button>
          </div>
        </div>
      `;
    }
  }
  
  let callHTML = '';
  if (g.phase === 'call' && g.active === g.contract?.nap) {
    const suitBtns = SUITS.map(s => 
      `<button class="suit-choice ${g.selectedCallSuit === s ? 'selected' : ''}" data-cs="${s}">${s}</button>`
    ).join('');
    const rankBtns = RANKS.map(r => 
      `<button class="small-action call-rank-choice ${g.selectedCallRank === r ? 'selected' : ''}" data-cr="${r}">${r}</button>`
    ).join('');

    callHTML = `
      <div class="training-call-panel">
        <div class="panel-row">${suitBtns}</div>
        <div class="panel-row">${rankBtns}</div>
        <div class="panel-row">
          <button id="training-call-submit" class="primary-button">指名する</button>
        </div>
      </div>
    `;
  }

  let playPanelHTML = '';
  if (g.phase === 'play' && g.selectedCard && legalIds.includes(g.selectedCard)) {
    const c = handCards.find(x => x.id === g.selectedCard);
    playPanelHTML = `
      <div class="action-panel" style="position:relative; margin-top:10px; width:min(400px, 92%); z-index:40; display:flex; flex-direction:column; align-items:center;">
        <div class="panel-title">このカードを出しますか？</div>
        <div class="play-confirm-preview" style="margin:10px 0; transform:scale(1.2);">
          ${cardElHTML(c)}
        </div>
        <div class="play-confirm-actions" style="display:flex; gap:8px; width:100%;">
          <button id="training-cancel-play" class="small-action" style="flex:1; min-height:44px;">選び直す</button>
          <button id="training-confirm-play" class="primary-button" style="flex:1; min-height:44px;">出す</button>
        </div>
      </div>
    `;
  }

  let openKittyHTML = '';
  if ((g.phase === 'auction') && g.kitty && g.kitty.length > 0) {
    const cardsHTML = g.kitty.map(c => cardElHTML(c, 'contract-kitty-card')).join('');
    openKittyHTML = `<div style="position:absolute; top:15px; left:50%; transform:translateX(-50%); z-index:20; display:flex; flex-direction:row; align-items:center; gap:8px;">
      <span style="font-size:12px;color:var(--gold);font-weight:700; white-space:nowrap; writing-mode:horizontal-tb;">オープン</span>
      <div style="display:flex; gap:4px;">${cardsHTML}</div>
    </div>`;
  }
  
  const leadSeat = g.phase === 'play' && g.trick.length ? g.trick[0].player : g.lastTrickWinner;
  const overlap = handCards.length <= 6 ? '4px' : '-18px';
  const handHTML = handCards.map((c, idx) => {
    let extra = '';
    if (isDiscardPhase) extra = g.discard.has(c.id) ? 'selected' : 'playable';
    else if (legalIds.includes(c.id) && g.phase === 'play') extra = (g.selectedCard === c.id) ? 'playable selected' : 'playable';
    
    const style = idx === 0 ? '' : `margin-left: ${overlap};`;
    return cardElHTML(c, extra, style, `data-card-id="${c.id}"`);
  }).join('');

  shell.innerHTML = `
    <div class="game-screen training-game">
      <div class="game-head">
        <button class="back-button" id="training-back">← メニュー</button>
        <div class="game-meta">
          <span>ROUND ${g.round} / 10</span>
          <select id="training-seat-select" class="mode-tag" style="background:#112a23;color:#fff;border:1px solid #e1bc70; padding:2px 6px; border-radius:4px; font-size:12px;">
            ${g.players.map((p, i) => `<option value="${i}" ${i === g.active ? 'selected' : ''}>操作席: COM${i + 1}</option>`).join('')}
          </select>
        </div>
        <div class="phase-label">${g.phase.toUpperCase()}</div>
      </div>
      ${g.contract ? `<div class="contract-info">宣言 ${g.contract.num}${g.contract.suit} ${g.contract.call ? '· 指名 '+g.contract.call.id : ''}
        ${(g.phase !== 'auction' && g.phase !== 'prep' && g.phase !== 'discard') && g.discardedKitty ? `
          <span class="contract-call-label" style="margin-left:8px;">捨て札</span>
          <div class="contract-kitty-cards">${g.discardedKitty.filter(c => ['10','J','Q','K','A'].includes(c.rank)).map(c => cardElHTML(c, 'contract-kitty-card')).join('')}</div>
        ` : ''}
      </div>` : ''}
      <div class="table-message">${escapeHTML($('table-message')?.textContent || '')}</div>
      <div class="table-area" style="position: relative; overflow: visible;">
        ${trickHTML}
        ${openKittyHTML}
        <div class="players-ring">
          ${g.players.map((p, i) => {
            const pos = (i - mySeat + 5) % 5;
            const isApproved = g.phase === 'auction' && g.auction && g.auction.active && !g.auction.active.includes(i);
            
            let role = '';
            if (g.contract) {
               if (g.contract.nap === i) role = 'ナポレオン';
               else if (g.contract.revealedCall && g.contract.deputy === i) role = '副官';
               else if (g.contract.revealedCall) role = '連合軍';
            } else if (g.phase === 'auction' && isApproved) {
               role = '承認済み';
            }

            let takenHTML = '';
            const taken = p.taken || [];
            if (taken.length) {
              const tags = taken.slice().sort((a,b)=>SV[a.suit]-SV[b.suit]||RANKS.indexOf(a.rank)-RANKS.indexOf(b.rank)).map(c => {
                const isRed = c.suit === '♦' || c.suit === '♥';
                return `<span class="taken-card ${isRed ? 'red' : ''}">${c.suit}${c.rank}</span>`;
              }).join('');
              takenHTML = `<div class="taken-cards"><span class="taken-label">獲得 ${taken.length}</span>${tags}</div>`;
            }

            return `<div class="player-seat player-color-${i} pos-${pos} ${i === g.active ? 'active' : ''} ${i === leadSeat ? 'trick-winner' : ''} ${role==='副官'?'deputy-seat':''}" data-seat="${i}" style="cursor: pointer; pointer-events: auto; opacity: ${isApproved ? 0.5 : 1};">
              <div class="seat-name">${name(i)}</div>
              <div class="seat-role ${role==='副官'?'deputy-status':''}">${role}</div>
              ${takenHTML}
            </div>`;
          }).join('')}
        </div>
        <div class="center-table"><div class="center-caption">場札</div></div>
      </div>
      ${auctionHTML}
      ${callHTML}
      ${discardHTML}
      ${playPanelHTML}
      <div class="hand-dock">
        <div class="hand-label">${name(mySeat)}の手札 <span>${handCards.length}枚</span></div>
        <div class="hand ${isDiscardPhase ? 'discard-mode' : ''}">
          ${handHTML}
        </div>
      </div>
      <div id="training-result-panel" class="result-panel hidden"></div>
    </div>
  `;
  
  // イベントバインド
  const backBtn = $('training-back');
  if (backBtn) backBtn.onclick = () => {
    $('training-screen').classList.add('hidden');
    $('training-screen').style.setProperty('display', 'none', 'important');
    $('mode-select-screen').classList.remove('hidden');
    $('mode-select-screen').style.removeProperty('display');
  };

  const seatSelect = $('training-seat-select');
  if (seatSelect) {
    seatSelect.onchange = (e) => {
      g.active = Number(e.target.value);
      g.selectedCard = null;
      renderTraining();
    };
  }

  document.querySelectorAll('.player-seat[data-seat]').forEach(el => {
    el.onclick = () => {
      const seat = Number(el.dataset.seat);
      if (g.active !== seat) {
        g.active = seat;
        g.selectedCard = null;
        renderTraining();
        toast(`操作席を ${name(seat)} に切り替えました`);
      }
    };
  });
  
  if (g.phase === 'auction') {
    if (g.auction.active.includes(g.active)) {
      document.querySelectorAll('[data-suit]').forEach(btn => {
        btn.onclick = () => {
          g.selectedBidSuit = btn.dataset.suit;
          document.querySelectorAll('[data-suit]').forEach(b => b.classList.remove('selected'));
          btn.classList.add('selected');
        };
      });
      
      const minusBtn = $('training-bid-minus');
      const plusBtn = $('training-bid-plus');
      const numInput = $('training-bid-num');
      if (minusBtn) minusBtn.onclick = () => { if (numInput) numInput.value = Math.max(13, Number(numInput.value) - 1); };
      if (plusBtn) plusBtn.onclick = () => { if (numInput) numInput.value = Math.min(20, Number(numInput.value) + 1); };
      
      const submitBtn = $('training-bid-submit');
      if (submitBtn) submitBtn.onclick = humanBid;
      const approveBtn = $('training-approve');
      if (approveBtn) approveBtn.onclick = humanApprove;
      const skipBtn = $('training-skip');
      if (skipBtn) skipBtn.onclick = humanSkip;
    }
  }
  
  if (g.phase === 'call' && g.active === g.contract?.nap) {
    document.querySelectorAll('[data-cs]').forEach(btn => {
      btn.onclick = () => { 
        g.selectedCallSuit = btn.dataset.cs;
        document.querySelectorAll('[data-cs]').forEach(b => b.classList.remove('selected')); 
        btn.classList.add('selected');
      };
    });
    document.querySelectorAll('[data-cr]').forEach(btn => {
      btn.onclick = () => { 
        g.selectedCallRank = btn.dataset.cr;
        document.querySelectorAll('[data-cr]').forEach(b => b.classList.remove('selected'));
        btn.classList.add('selected');
      };
    });
    const submitBtn = $('training-call-submit');
    if (submitBtn) submitBtn.onclick = submitCall;
  }
  
  if (g.phase === 'play') {
    document.querySelectorAll('.hand .card.playable').forEach(el => {
      el.onclick = () => {
        const id = el.dataset.cardId;
        g.selectedCard = id;
        renderTraining();
      };
    });

    const cancelPlayBtn = $('training-cancel-play');
    if (cancelPlayBtn) cancelPlayBtn.onclick = () => {
      g.selectedCard = null;
      renderTraining();
    };

    const confirmPlayBtn = $('training-confirm-play');
    if (confirmPlayBtn) confirmPlayBtn.onclick = () => {
      if (g.selectedCard) playCard(g.selectedCard);
    };
  }
  
  if (isDiscardPhase) {
    document.querySelectorAll('.hand .card').forEach(el => {
      el.onclick = () => {
        const id = el.dataset.cardId;
        if (g.discard.has(id)) g.discard.delete(id);
        else if (g.discard.size < 2) g.discard.add(id);
        renderTraining();
      };
    });
    const submitBtn = $('training-discard-submit');
    if (submitBtn) submitBtn.onclick = submitDiscard;
  }
}

function phase(t) {
  const el = $('training-phase');
  if (el) el.textContent = t;
}

function message(t) {
  const el = $('training-message');
  if (el) el.textContent = t;
}

function trickPhaseOf(n) { return n < 3 ? 'early' : n < 7 ? 'mid' : 'late'; }
function pointsTierOf(pts) { return pts === 0 ? 'zero' : pts < 3 ? 'mid' : 'high'; }
function rankTierOf(rank) { return RANKS.indexOf(rank) > 9 ? 'high' : RANKS.indexOf(rank) > 5 ? 'mid' : 'low'; }
