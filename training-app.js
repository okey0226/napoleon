// training-app.js — 5人全員を操作するトレーニングモード
import { SUITS, RANKS, SV, defaultStrategy, shuffledDeck, sortHand } from './constants.js';
import { shouldBid, chooseDiscard, chooseDeputyCall, chooseCardToPlay, winningEntry, colorStrength, ntHandStrength } from './ai-tactics.js';

const $ = id => document.getElementById(id);
const g = {
  round: 1, players: [], kitty: [], discardedKitty: [], allianceKittyPoints: 0,
  contract: null, trick: [], trickNo: 0, active: 0, phase: 'prep',
  matchScores: [0,0,0,0,0], playedCards: [], voids: [{},{},{},{},{}],
  bidHistory: [], auction: null, selectedCard: null, discard: new Set(),
};

function name(i) {
  return `COM${i + 1}`;
}

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
  g.contract = null; g.auction = null; g.bidHistory = [];
  g.discardedKitty = []; g.allianceKittyPoints = 0;
  g.selectedCard = null; g.discard = new Set();
  
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
  g.auction = {
    active: [0, 1, 2, 3, 4],
    minBid: 13,
    high: { num: 12, suit: '', player: -1, solo: false },
    version: 0, botSeen: Array(5).fill(-1)
  };
  enterAuction();
}

function enterAuction() {
  g.phase = 'auction';
  message(`${name(g.active)}の番です。宣言するか、承認してください。`);
  renderTraining();
}

function humanApprove() {
  if (g.phase !== 'auction' || !g.auction.active.includes(g.active)) return;
  if (!g.auction.active.length) { auctionEnd(-1); return; }
  g.auction.active = g.auction.active.filter(x => x !== g.active);
  g.auction.botSeen[g.active] = g.auction.version;
  message(`${name(g.active)}が承認しました。`);
  if (!g.auction.active.length) { auctionEnd(-1); return; }
  nextAuctionTurn();
}

function humanBid() {
  if (g.phase !== 'auction' || !g.auction.active.includes(g.active)) return;
  const num = Number($('training-bid-num').value);
  const suit = $('training-bid-suit').value;
  if (!beatsBid(num, suit)) { toast('現在の宣言より強い宣言を選んでください'); return; }
  
  g.bidHistory.push({ round: g.round, seat: g.active, num, suit });
  g.auction.high = { num, suit, player: g.active, solo: false };
  g.auction.version++;
  message(`${name(g.active)}が${num}${suit}を宣言しました。`);
  
  // 学習データ送信
  const cs = colorStrength(g.players[g.active].hand, suit, defaultStrategy());
  const nt = ntHandStrength(g.players[g.active].hand, defaultStrategy());
  const handStr = suit === 'NT' ? nt : cs;
  const trumpType = suit === 'NT' ? 'NT' : 'color';
  teachAI('bid', g.active, { handStr, trumpType, num });
  
  nextAuctionTurn();
}

function beatsBid(n, s) {
  const h = g.auction.high;
  return n >= g.auction.minBid && (n > h.num || (n === h.num && SV[s] > SV[h.suit]));
}

function nextAuctionTurn() {
  if (g.auction.active.length === 1) {
    auctionEnd(g.auction.active[0]);
    return;
  }
  if (g.auction.active.length === 0) {
    auctionEnd(-1);
    return;
  }
  g.active = g.auction.active[Math.floor(Math.random() * g.auction.active.length)];
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
  g.active = w;
  message(`${name(w)}が${g.contract.num}${g.contract.suit}で宣言。オープンを手札に入れて2枚捨ててください。`);
  g.phase = 'discard';
  renderTraining();
}

function submitDiscard() {
  if (g.discard.size !== 2) return;
  const n = g.contract.nap;
  g.players[n].hand.push(...g.kitty);
  sortHand(g.players[n].hand);
  
  const removed = g.players[n].hand.filter(c => g.discard.has(c.id));
  g.players[n].hand = g.players[n].hand.filter(c => !g.discard.has(c.id));
  sortHand(g.players[n].hand);
  g.kitty = removed;
  g.discardedKitty = removed.slice();
  g.allianceKittyPoints += removed.filter(c => ['10','J','Q','K','A'].includes(c.rank)).length;
  
  teachAI('discard', n, { cardIds: Array.from(g.discard) });
  
  g.discard = new Set();
  g.selectedCard = null;
  g.phase = 'call';
  message(`${name(n)}が捨て札を決めました。副官に指名するカードを選んでください。`);
  renderTraining();
}

function submitCall() {
  const n = g.contract.nap;
  const suit = $('training-call-suit').value;
  const rank = $('training-call-rank').value;
  const id = suit + rank;
  
  if (g.kitty.some(c => c.id === id)) { toast('捨て札は指名できません'); return; }
  
  const isOwn = g.players[n].hand.some(c => c.id === id);
  g.contract.call = { suit, rank, id };
  g.contract.solo = isOwn;
  
  const deputy = g.players.findIndex((p, i) => i !== n && p.hand.some(c => c.id === id));
  g.contract.deputy = deputy >= 0 ? deputy : n;
  
  teachAI('call', n, { callId: id, trumpSuit: g.contract.suit });
  
  g.kitty = [];
  g.phase = 'play';
  g.active = n;
  g.trick = [];
  g.trickNo = 0;
  message(`${id}を指名しました。カードプレイを開始します。`);
  renderTraining();
  nextPlayTurn();
}

function nextPlayTurn() {
  g.phase = 'play';
  renderTraining();
  message(`${name(g.active)}の番です。カードを出してください。`);
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
  
  // 学習データ送信
  const role = g.contract.nap === seat ? 'nap' : (!g.contract.solo && g.contract.revealedCall && g.contract.deputy === seat ? 'dep' : 'ally');
  const phase = trickPhaseOf(g.trickNo);
  const pointsTier = pointsTierOf(g.trick.filter(e => ['10','J','Q','K','A'].includes(e.card.rank)).length);
  const rankTier = rankTierOf(card.rank);
  teachAI('play', seat, { role, phase, pointsTier, rankTier, cardId });
  
  if (g.trick.length < 5) {
    g.active = (seat - 1 + 5) % 5;
    nextPlayTurn();
    return;
  }
  
  const w = winningEntry(g.contract, g.trickNo, g.trick.map(e => ({ seat: e.player, card: e.card }))).seat;
  const taken = g.trick.filter(e => ['10','J','Q','K','A'].includes(e.card.rank)).map(e => e.card);
  g.players[w].taken.push(...taken);
  g.players[w].roundTaken.push(...taken);
  g.players[w].roundPoints += taken.length;
  
  g.trickNo++;
  g.trick = [];
  g.active = w;
  
  if (g.trickNo >= 10) {
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

function teachAI(action, seat, data) {
  const payload = { action, seat, ...data };
  fetch('/api/ai/teach', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload)
  }).catch(e => console.warn('teach failed', e));
}

function renderTraining() {
  const shell = $('training-shell');
  if (!shell) return;
  
  const mySeat = g.active;
  const handCards = g.players[mySeat].hand || [];
  const legalIds = getLegalCards(mySeat).map(c => c.id);
  
  let trickHTML = '';
  if (g.trick.length) {
    trickHTML = g.trick.map(e => {
      const pos = (e.player - mySeat + 5) % 5;
      return `<div class="trick-card played-seat-${pos}">${cardElHTML(e.card)}</div>`;
    }).join('');
  }
  
  let discardHTML = '';
  if (g.phase === 'discard') {
    discardHTML = `<div class="training-discard-hint">捨て札を2枚選んでください</div>`;
  }
  
  let auctionHTML = '';
  if (g.phase === 'auction') {
    auctionHTML = `
      <div class="training-auction-panel">
        <div class="panel-row">
          ${SUITS.map(s => `<button class="suit-choice" data-suit="${s}">${s}</button>`).join('')}
          <button class="suit-choice" data-suit="NT">NT</button>
        </div>
        <div class="panel-row">
          <input type="number" id="training-bid-num" min="13" max="20" value="13">
          <button id="training-bid-submit" class="primary-button">宣言する</button>
          <button id="training-approve" class="secondary-button">承認する</button>
        </div>
      </div>
    `;
  }
  
  let callHTML = '';
  if (g.phase === 'call') {
    callHTML = `
      <div class="training-call-panel">
        <div class="panel-row">
          ${SUITS.map(s => `<button class="suit-choice" data-cs="${s}">${s}</button>`).join('')}
        </div>
        <div class="panel-row">
          ${RANKS.map(r => `<button class="small-action call-rank-choice" data-cr="${r}">${r}</button>`).join('')}
        </div>
        <div class="panel-row">
          <button id="training-call-submit" class="primary-button">指名する</button>
        </div>
      </div>
    `;
  }
  
  shell.innerHTML = `
    <div class="game-screen training-game">
      <div class="game-head">
        <button class="back-button" id="training-back">← メニュー</button>
        <div class="game-meta"><span>ROUND ${g.round} / 10</span><span class="mode-tag">操作席: ${name(g.active)}</span></div>
        <div class="phase-label">${g.phase.toUpperCase()}</div>
      </div>
      ${g.contract ? `<div class="contract-info">宣言 ${g.contract.num}${g.contract.suit} ${g.contract.call ? '· 指名 '+g.contract.call.id : ''}</div>` : ''}
      <div class="table-message">${escapeHTML($('table-message')?.textContent || '')}</div>
      <div class="table-area" style="position: relative; overflow: visible;">
        ${trickHTML}
        <div class="players-ring">
          ${g.players.map((p, i) => `<div class="player-seat player-color-${i} pos-${i} ${i === g.active ? 'active' : ''}"><div class="seat-name">${name(i)}</div></div>`).join('')}
        </div>
        <div class="center-table"><div class="center-caption">場札</div></div>
      </div>
      ${auctionHTML}
      ${callHTML}
      ${discardHTML}
      <div class="hand-dock">
        <div class="hand-label">${name(mySeat)}の手札 <span>${handCards.length}枚</span></div>
        <div class="hand">
          ${handCards.map(c => cardElHTML(c, legalIds.includes(c.id) ? 'playable' : '')).join('')}
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
  
  if (g.phase === 'auction') {
    document.querySelectorAll('[data-suit]').forEach(btn => {
      btn.onclick = () => {
        document.querySelectorAll('[data-suit]').forEach(b => b.classList.remove('selected'));
        btn.classList.add('selected');
      };
    });
    const submitBtn = $('training-bid-submit');
    if (submitBtn) submitBtn.onclick = humanBid;
    const approveBtn = $('training-approve');
    if (approveBtn) approveBtn.onclick = humanApprove;
  }
  
  if (g.phase === 'call') {
    let selSuit = '♠', selRank = 'A';
    document.querySelectorAll('[data-cs]').forEach(btn => {
      btn.onclick = () => { selSuit = btn.dataset.cs; document.querySelectorAll('[data-cs]').forEach(b => b.classList.toggle('selected', b.dataset.cs === selSuit)); };
    });
    document.querySelectorAll('[data-cr]').forEach(btn => {
      btn.onclick = () => { selRank = btn.dataset.cr; document.querySelectorAll('[data-cr]').forEach(b => b.classList.toggle('selected', b.dataset.cr === selRank)); };
    });
    const submitBtn = $('training-call-submit');
    if (submitBtn) submitBtn.onclick = () => {
      $('training-call-suit').value = selSuit;
      $('training-call-rank').value = selRank;
      submitCall();
    };
  }
  
  if (g.phase === 'play') {
    document.querySelectorAll('.hand .card.playable').forEach(el => {
      el.onclick = () => {
        const id = el.querySelector('.suit').textContent + el.querySelector('.rank').textContent;
        playCard(id);
      };
    });
  }
  
  if (g.phase === 'discard') {
    document.querySelectorAll('.hand .card').forEach(el => {
      el.onclick = () => {
        const id = el.querySelector('.suit').textContent + el.querySelector('.rank').textContent;
        if (g.discard.has(id)) g.discard.delete(id);
        else if (g.discard.size < 2) g.discard.add(id);
        renderTraining();
      };
    });
    const submitBtn = $('training-discard-submit');
    if (submitBtn) submitBtn.onclick = submitDiscard;
  }
}

function cardElHTML(c, extra = '') {
  if (!c) return `<div class="card card-back ${extra}"></div>`;
  const red = c.suit === '♦' || c.suit === '♥';
  return `<div class="card ${red ? 'red ' : ''}${extra}"><span class="rank">${c.rank}</span><span class="suit">${c.suit}</span></div>`;
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
