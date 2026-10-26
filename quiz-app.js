// quiz-app.js — 何切る問題集（ゲーム画面レプリカ）
const $ = id => document.getElementById(id);
const QUIZ_LABELS = { bid: '何で立つ？', call: '誰を指名する？', discard: '何を切る？', play: '何を出す？' };
const CATEGORY_PHASE = { bid: '競り', call: '副官指名', discard: '浮き札の交換', play: 'カードプレイ' };
const BID_SUITS = ['♣', '♦', '♥', '♠', 'NT'];
const SV = { '♣': 1, '♦': 2, '♥': 3, '♠': 4, NT: 5 };

let _bound = false;
let _bidInput = { suit: '♠', num: 13, solo: false };

function sessionToken() { return localStorage.getItem('napoleon_session') || null; }
async function authFetch(url, opts = {}) {
  const token = sessionToken();
  const headers = Object.assign({}, opts.headers || {});
  if (token) headers['x-session-token'] = token;
  if (opts.body && !headers['content-type']) headers['content-type'] = 'application/json';
  return fetch(url, Object.assign({}, opts, { headers }));
}
function encodeBid(bid) {
  if (!bid || bid.pass) return 0;
  const suitIdx = BID_SUITS.indexOf(bid.suit);
  if (suitIdx < 0) return 0;
  const numIdx = bid.num - 13;
  if (numIdx < 0 || numIdx > 7) return 0;
  return 1 + numIdx * 10 + suitIdx + (bid.solo ? 5 : 0);
}
function cardElHTML(id, extra = '') {
  if (!id) return `<div class="card card-back ${extra}"></div>`;
  const suit = id[0], rank = id.slice(1);
  const red = suit === '♦' || suit === '♥';
  return `<div class="card ${red ? 'red ' : ''}${extra}"><span class="rank">${rank}</span><span class="suit">${suit}</span></div>`;
}
function escapeHTML(v) { return String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }

function getSeatName(seat, mySeat) {
  if (seat === mySeat) return 'あなた';
  let comIdx = 0;
  for (let i = 0; i < 5; i++) {
    if (i === mySeat) continue;
    comIdx++;
    if (i === seat) return `COM ${comIdx}`;
  }
  return `COM ${seat}`;
}

export function openQuizScreen() {
  const screen = document.getElementById('quiz-screen');
  if (!screen) return;
  document.querySelectorAll('#app > section').forEach(s => s.classList.add('hidden'));
  screen.classList.remove('hidden');
  if (!_bound) _bound = true;
  loadProgress();
}

async function loadProgress() {
  if (!sessionToken()) return renderAuthRequired();
  try {
    const res = await authFetch('/api/quiz/progress');
    const data = await res.json();
    if (!res.ok) return renderAuthRequired(data.error);
    renderProgress(data);
    if (data.nextQuestionId) loadQuestion(data.nextQuestionId);
    else renderAllDone();
  } catch { renderError('通信に失敗しました'); }
}
async function refreshProgress() {
  try {
    const res = await authFetch('/api/quiz/progress');
    if (!res.ok) return;
    renderProgress(await res.json());
  } catch {}
}
function renderProgress(p) {
  const el = $('quiz-progress'); if (!el) return;
  const pct = p.total ? Math.round(p.answered / p.total * 100) : 0;
  el.innerHTML = `
    <div class="quiz-progress-track"><div class="quiz-progress-fill" style="width:${pct}%"></div></div>
    <div class="quiz-progress-meta">${p.answered} / ${p.total}問（${pct}%）</div>
    <div class="quiz-cat-chips">${Object.entries(p.perCategory).map(([c, v]) => `<span class="quiz-cat-chip">${QUIZ_LABELS[c] || c}: ${v.answered}/${v.total}</span>`).join('')}</div>`;
}

async function loadQuestion(id) {
  renderLoading();
  try {
    const res = await authFetch('/api/quiz/q/' + encodeURIComponent(id));
    const text = await res.text();
    let data;
    try {
      data = JSON.parse(text);
    } catch (err) {
      console.error("Parse error. Status:", res.status, "Body:", text);
      return renderError(`サーバーエラー (${res.status}): 応答がJSONではありません`);
    }
    if (!res.ok) return renderError(data.error || '読み込み失敗');
    renderGameReplica(data, id);
    refreshProgress();
  } catch (e) { 
    console.error(e); 
    renderError('通信失敗: ' + e.message); 
  }
}

async function loadNext() {
  try {
    const res = await authFetch('/api/quiz/progress');
    const data = await res.json();
    if (!res.ok) return;
    if (!data.nextQuestionId) return renderAllDone();
    loadQuestion(data.nextQuestionId);
  } catch {}
}

function resolveCategory(q, fallbackId = '') {
  if (q && q.category) return q.category;
  if (q && q.inputMode) return q.inputMode;
  const id = (q && q.id) ? q.id : fallbackId;
  if (typeof id === 'string' && id.includes('-')) return id.split('-')[0];
  return '';
}

function getMySeat(q, category) {
  if (category === 'bid') return q.scenario?.mySeat ?? 0;
  if (category === 'call') return q.scenario?.contract?.seat ?? 0;
  if (category === 'discard') return q.scenario?.contract?.seat ?? 0;
  if (category === 'play') return q.scenario?.seat ?? 0;
  return 0;
}

function renderGameReplica(q, fallbackId = '') {
  const shell = $('quiz-shell'); if (!shell) return;
  const category = resolveCategory(q, fallbackId);
  
  if (category !== 'bid' && (!q.options || !q.options.length)) {
    return renderError('問題データが不正です（Options missing）');
  }

  const mySeat = getMySeat(q, category);
  const disp = actual => (actual - mySeat + 5) % 5;
  const contract = q.scenario?.contract;
  const isPlay = category === 'play';
  const isCall = category === 'call';
  const isDiscard = category === 'discard';
  const isBid = category === 'bid';

  if (isBid && !q.reveal) {
    const high = q.scenario?.high || { num: 12, suit: '' };
    let num = Math.max(13, high.num);
    let suit = '♠';
    if (high.num >= 13) {
      if (num === high.num && SV[suit] <= SV[high.suit]) {
        const candidates = ['NT', '♠', '♥', '♦', '♣'];
        const found = candidates.find(s => SV[s] > SV[high.suit]);
        if (found) suit = found;
        else num = Math.min(20, high.num + 1);
      }
    }
    _bidInput = { suit, num, solo: false };
  }

  let messageText = '';
  if (isBid) {
    const high = q.scenario?.high;
    if (high && high.num >= 13) {
      messageText = `現在の宣言: ${getSeatName(high.player, mySeat)} の ${high.num}${high.suit} ／ あなたの番です`;
    } else {
      messageText = '宣言なし。最初の宣言をしてください。';
    }
  } else if (isCall) messageText = '副官に指名するカードを選んでください';
  else if (isDiscard) messageText = '手札12枚から2枚を選んで捨ててください';
  else if (isPlay) messageText = q.scenario?.trick?.length ? 'あなたの番です。場札に続けてください' : 'あなたが先攻です。カードを出してください';

  let contractInfoHTML = '';
  if (contract) {
    const parts = [`<strong class="contract-bid">宣言 ${contract.num}${contract.suit}${contract.solo ? '（ソロ）' : ''}</strong>`];
    const callId = q.scenario?.call?.id || null;
    if (callId && !isDiscard) parts.push(`<span class="contract-call-label">副官札</span><div class="contract-kitty-cards">${cardElHTML(callId, 'contract-kitty-card')}</div>`);
    const discarded = q.scenario?.discarded || [];
    if (discarded.length && !isDiscard) parts.push(`<span class="contract-call-label">捨て札</span><div class="contract-kitty-cards">${discarded.map(id => cardElHTML(id, 'contract-kitty-card')).join('')}</div>`);
    if (contract.solo && contract.revealedCall) parts.push('<span class="contract-call-label">ひとり立ち</span>');
    contractInfoHTML = `<div class="contract-info">${parts.join('')}</div>`;
  }
  if (isBid && q.scenario?.high && q.scenario.high.num >= 13) {
    const h = q.scenario.high;
    const bidder = getSeatName(h.player, mySeat);
    contractInfoHTML = `<div class="contract-info">
      <strong class="contract-bid">現在の宣言 ${h.num}${h.suit}</strong>
      <span class="contract-call-label">${escapeHTML(bidder)} による</span>
    </div>`;
  }

  const nap = contract?.nap ?? -1;
  const deputy = contract?.deputy ?? -1;
  const revealed = contract?.revealedCall ?? false;
  let activeSeat = -1;
  if (isBid) activeSeat = mySeat;
  if (isCall || isDiscard) activeSeat = contract?.nap ?? -1;
  if (isPlay) activeSeat = q.scenario?.seat ?? -1;

  const seatNames = {};
  seatNames[mySeat] = 'あなた';
  let comIdx = 1;
  for (let i = 0; i < 5; i++) if (i !== mySeat) seatNames[i] = `COM ${comIdx++}`;

  const seatEls = [];
  for (let actual = 0; actual < 5; actual++) {
    const pos = disp(actual);
    let role = '';
    if (!isBid && nap >= 0) {
      if (actual === nap) role = 'ナポレオン';
      else if (revealed && actual === deputy) role = '副官';
      else if (revealed) role = '連合軍';
    }
    seatEls.push(`<div class="player-seat player-color-${pos} pos-${pos} ${actual===mySeat?'me':''} ${activeSeat===actual?'active':''} ${role==='副官'?'deputy-seat':''}">
      <div class="seat-name">${escapeHTML(seatNames[actual])}</div>
      <div class="seat-role ${role==='副官'?'deputy-status':''}">${escapeHTML(role)}</div>
    </div>`);
  }

  let trickCardsHTML = '';
  if (isPlay && q.scenario?.trick?.length) {
    trickCardsHTML = q.scenario.trick.map(e => {
      const pos = disp(e.seat);
      const suit = e.card[0], rank = e.card.slice(1);
      const red = suit === '♦' || suit === '♥';
      return `<div class="card ${red ? 'red ' : ''}trick-card played-seat-${pos}"><span class="rank">${rank}</span><span class="suit">${suit}</span></div>`;
    }).join('');
  }

  // ★オープン2枚（bid用）
  let openKittyHTML = '';
  if (isBid) {
    const openCards = (q.scenario?.kitty || []).map(id => cardElHTML(id));
    openKittyHTML = `<div class="quiz-open-kitty-wrap">
      <span class="open-label">オープン</span>
      <div class="quiz-open-cards">${openCards.join('')}</div>
    </div>`;
  }

  const handCards = q.scenario?.hand || [];
  const handMode = isDiscard ? 'discard-mode' : '';
  const legalIds = isPlay && !q.reveal ? new Set((q.options || []).map(o => o.value || o.label)) : new Set();
  const handHTML = handCards.map(id => cardElHTML(id, legalIds.has(id) ? 'playable' : '')).join('');

  const panelHTML = renderQuestionPanel(q, mySeat, category);
  const bidHistoryOutside = (isBid && !q.reveal) ? renderBidHistory(q, mySeat) : '';

  // ★ bidの時は縦積み専用レイアウト
  if (isBid) {
    shell.innerHTML = `
      <div class="game-screen quiz-game quiz-game-bid">
        <div class="game-head">
          <button class="back-button" id="quiz-inner-back">← メニュー</button>
          <div class="game-meta"><span>${escapeHTML((q.id || fallbackId).toUpperCase())}</span><span class="mode-tag">${QUIZ_LABELS[category]}</span></div>
          <div class="phase-label">${CATEGORY_PHASE[category]}</div>
        </div>
        ${contractInfoHTML}
        <div class="bid-info-area">
          ${openKittyHTML}
          ${bidHistoryOutside}
        </div>
        <div class="bid-input-area">
          ${panelHTML}
        </div>
        <div class="hand-dock">
          <div class="hand-label">あなたの手札 <span>${handCards.length}枚</span> + オープン 2枚</div>
          <div class="hand ${handMode}">${handHTML}</div>
        </div>
      </div>`;
  } else {
    // 既存のレイアウト（play, call, discard）
    shell.innerHTML = `
      <div class="game-screen quiz-game ${isDiscard ? 'discarding' : ''}">
        <div class="game-head">
          <button class="back-button" id="quiz-inner-back">← メニュー</button>
          <div class="game-meta"><span>${escapeHTML((q.id || fallbackId).toUpperCase())}</span><span class="mode-tag">${QUIZ_LABELS[category]}</span></div>
          <div class="phase-label">${CATEGORY_PHASE[category]}</div>
        </div>
        ${contractInfoHTML}
        <div class="table-message">${escapeHTML(messageText)}</div>
        <div class="table-area">
          <div class="players-ring">${seatEls.join('')}</div>
          ${trickCardsHTML ? `<div class="trick-cards">${trickCardsHTML}</div>` : ''}
          <div class="center-table">
            <div class="center-caption">場札</div>
          </div>
          <div class="quiz-panel">${panelHTML}</div>
        </div>
        <div class="hand-dock">
          <div class="hand-label">あなたの手札 <span>${handCards.length}枚</span></div>
          <div class="hand ${handMode}">${handHTML}</div>
        </div>
      </div>`;
  }

  const innerBack = $('quiz-inner-back');
  if (innerBack) innerBack.onclick = () => {
    $('quiz-screen').classList.add('hidden');
    $('mode-select-screen').classList.remove('hidden');
  };
  bindOptionClicks(q);
  if (isBid && !q.reveal) bindBidInput(q);
  if (isPlay && !q.reveal) bindPlayCardClicks(q);
  if (isDiscard && !q.reveal) bindDiscardCardClicks(q);
}

function renderQuestionPanel(q, mySeat, category) {
  const isReveal = q.reveal;
  const nextBtn = `<button class="primary-button quiz-next-btn" id="quiz-next">次の問題へ →</button>`;

  if (category === 'bid') {
    return isReveal ? renderBidReveal(q, mySeat) : renderBidInput(q, mySeat);
  }

  if (category === 'call') {
    const opts = (q.options || []).map(o => {
      const id = o.value?.id || o.label;
      const isAI = isReveal && q.aiAnswerIndex === o.index;
      const isMine = q.myAnswer === o.index;
      const stat = isReveal ? (q.stats?.find(s => s.index === o.index)?.count || 0) : 0;
      const total = q.totalAnswers || 0;
      const pct = total ? Math.round(stat / total * 100) : 0;
      return `<button class="quiz-call-card-btn ${isMine ? 'is-mine' : ''} ${isAI ? 'is-ai' : ''}" data-choice="${o.index}" ${isReveal ? 'disabled' : ''}>
        ${cardElHTML(id)}
        ${isReveal ? `<div class="quiz-card-stat-bar"><div class="quiz-card-stat-fill" style="height:${pct}%"></div></div><span class="quiz-card-pct">${pct}%</span><small>${stat}人</small>` : ''}
        ${isAI ? '<span class="quiz-card-tag-ai">AI</span>' : ''}
        ${isMine ? '<span class="quiz-card-tag-mine">あなた</span>' : ''}
      </button>`;
    }).join('');
    return `<div class="quiz-panel-title">副官に指名するカードを選んでください</div>
      <div class="quiz-call-grid">${opts}</div>
      ${isReveal ? `<div class="quiz-explanation">${escapeHTML(q.explanation || '')}</div>${nextBtn}` : ''}`;
  }

  if (category === 'discard') {
    const opts = (q.options || []).map(o => {
      const ids = o.value || [];
      const isAI = isReveal && q.aiAnswerIndex === o.index;
      const isMine = q.myAnswer === o.index;
      const stat = isReveal ? (q.stats?.find(s => s.index === o.index)?.count || 0) : 0;
      const total = q.totalAnswers || 0;
      const pct = total ? Math.round(stat / total * 100) : 0;
      return `<button class="quiz-discard-pair-btn ${isMine ? 'is-mine' : ''} ${isAI ? 'is-ai' : ''}" data-choice="${o.index}" ${isReveal ? 'disabled' : ''}>
        <div class="quiz-discard-pair-cards">${ids.map(id => cardElHTML(id)).join('')}</div>
        ${isReveal ? `<span class="quiz-bid-stat"><span class="quiz-bid-bar" style="width:${pct}%"></span><span class="quiz-bid-pct">${stat}人 ${pct}%</span></span>` : ''}
        ${isAI ? '<span class="quiz-tag-ai">AI</span>' : ''}
        ${isMine ? '<span class="quiz-tag-mine">あなた</span>' : ''}
      </button>`;
    }).join('');
    return `<div class="quiz-panel-title">捨てる組み合わせを選ぶ（手札を2枚クリックでもOK）</div>
      <div class="quiz-discard-grid">${opts}</div>
      ${isReveal ? `<div class="quiz-explanation">${escapeHTML(q.explanation || '')}</div>${nextBtn}` : ''}`;
  }

  if (category === 'play') {
    const opts = (q.options || []).map(o => {
      const id = o.value || o.label;
      const isAI = isReveal && q.aiAnswerIndex === o.index;
      const isMine = q.myAnswer === o.index;
      const stat = isReveal ? (q.stats?.find(s => s.index === o.index)?.count || 0) : 0;
      const total = q.totalAnswers || 0;
      const pct = total ? Math.round(stat / total * 100) : 0;
      return `<button class="quiz-play-card-btn ${isMine ? 'is-mine' : ''} ${isAI ? 'is-ai' : ''}" data-choice="${o.index}" ${isReveal ? 'disabled' : ''}>
        ${cardElHTML(id)}
        ${isReveal ? `<div class="quiz-card-stat-bar"><div class="quiz-card-stat-fill" style="height:${pct}%"></div></div><span class="quiz-card-pct">${pct}%</span><small>${stat}人</small>` : ''}
        ${isAI ? '<span class="quiz-card-tag-ai">AI</span>' : ''}
        ${isMine ? '<span class="quiz-card-tag-mine">あなた</span>' : ''}
      </button>`;
    }).join('');
    return `<div class="quiz-panel-title">出すカードを選んでください（手札のハイライトからもOK）</div>
      <div class="quiz-play-grid">${opts}</div>
      ${isReveal ? `<div class="quiz-explanation">${escapeHTML(q.explanation || '')}</div>${nextBtn}` : ''}`;
  }
  return '';
}

// ===== 立ち履歴 =====
function renderBidHistory(q, mySeat) {
  const history = q.scenario?.bidHistory || [];
  if (history.length === 0) return '';
  const rows = history.map((b, i) => {
    const pos = (b.seat - mySeat + 5) % 5;
    const isHigh = (i === history.length - 1);
    return `<div class="quiz-bid-history-row player-color-${pos} ${isHigh ? 'is-high' : ''}">
      <span class="bid-player">${escapeHTML(getSeatName(b.seat, mySeat))}</span>
      <strong>${b.num}${b.suit}</strong>
    </div>`;
  }).join('');
  return `<div class="quiz-bid-history-wrapper">
    <div class="quiz-bid-history">
      <div class="quiz-bid-history-title">この競りの立ち履歴</div>
      <div class="quiz-bid-history-list">${rows}</div>
    </div>
  </div>`;
}

// ===== bid 入力 (コンパクト化) =====
function renderBidInput(q, mySeat) {
  const high = q.scenario?.high || { num: 12, suit: '', player: -1 };
  const state = _bidInput;
  const isValid = high.num < 13 || (state.num > high.num) || (state.num === high.num && high.suit && SV[state.suit] > SV[high.suit]);

  const titleText = high.num >= 13
    ? `現在の宣言: ${getSeatName(high.player, mySeat)} の ${high.num}${high.suit} ／ 何で立つ？`
    : '宣言なし ／ 最初の宣言をしてください';

  const suitBtns = BID_SUITS.map(s =>
    `<button class="quiz-input-btn quiz-suit-btn ${state.suit === s ? 'selected' : ''}" data-bid-suit="${s}">${s}</button>`
  ).join('');

  const numBtns = [13, 14, 15, 16, 17, 18, 19, 20].map(n =>
    `<button class="quiz-input-btn quiz-num-btn ${state.num === n ? 'selected' : ''}" data-bid-num="${n}">${n}</button>`
  ).join('');

  return `<div class="quiz-panel-title" style="margin-bottom:6px">${escapeHTML(titleText)}</div>
    <div class="quiz-input-section">
      <div class="quiz-input-row">${suitBtns}</div>
      <div class="quiz-input-row" style="margin-top:4px">${numBtns}</div>
    </div>
    <div class="quiz-bid-controls">
      <label class="quiz-solo-label"><input type="checkbox" id="quiz-solo" ${state.solo ? 'checked' : ''}> ソロ</label>
      <div class="quiz-input-preview">
        <strong>${state.num}${state.suit}${state.solo ? '（ソロ）' : ''}</strong>
        ${!isValid ? '<span class="quiz-input-warning">※宣言より強く</span>' : ''}
      </div>
    </div>
    <div class="quiz-input-actions">
      <button class="small-action pass" id="quiz-pass">パス</button>
      <button class="primary-button" id="quiz-submit-bid" ${!isValid ? 'disabled' : ''}>決定</button>
    </div>`;
}

function bindBidInput(q) {
  const state = _bidInput;
  document.querySelectorAll('[data-bid-suit]').forEach(btn => {
    btn.onclick = () => { state.suit = btn.dataset.bidSuit; rerenderBidPanel(q); };
  });
  document.querySelectorAll('[data-bid-num]').forEach(btn => {
    btn.onclick = () => { state.num = Number(btn.dataset.bidNum); rerenderBidPanel(q); };
  });
  const soloCb = $('quiz-solo');
  if (soloCb) soloCb.onchange = () => { state.solo = soloCb.checked; rerenderBidPanel(q); };
  const passBtn = $('quiz-pass');
  if (passBtn) passBtn.onclick = () => submitAnswer(q.id, 0);
  const submitBtn = $('quiz-submit-bid');
  if (submitBtn) submitBtn.onclick = () => {
    const encoded = encodeBid({ num: state.num, suit: state.suit, solo: state.solo });
    if (encoded === 0) return;
    submitAnswer(q.id, encoded);
  };
}

function rerenderBidPanel(q) {
  const panel = document.querySelector('.bid-input-area');
  if (!panel) return;
  const mySeat = getMySeat(q, 'bid');
  panel.innerHTML = renderBidInput(q, mySeat);
  bindBidInput(q);
}

// ===== bid 結果表示 =====
function renderBidReveal(q, mySeat) {
  const dist = q.distribution || [];
  const total = q.totalAnswers || 0;
  const myEncoded = q.myAnswer;
  const aiEncoded = q.aiAnswerIndex;

  let distHTML;
  if (dist.length === 0) {
    distHTML = '<div class="quiz-dist-empty">まだ他の人の回答がありません</div>';
  } else {
    distHTML = dist.map(d => {
      const pct = total ? Math.round(d.count / total * 100) : 0;
      const isMine = d.encoded === myEncoded;
      const isAI = d.encoded === aiEncoded;
      return `<div class="quiz-dist-row ${isMine ? 'is-mine' : ''} ${isAI ? 'is-ai' : ''}">
        <span class="quiz-dist-label">${escapeHTML(d.label)}</span>
        <div class="quiz-dist-bar-wrap"><div class="quiz-dist-bar" style="width:${pct}%"></div></div>
        <span class="quiz-dist-count">${d.count}人 ${pct}%</span>
        <span class="quiz-dist-tags">
          ${isMine ? '<span class="quiz-tag-mine">あなた</span>' : ''}
          ${isAI ? '<span class="quiz-tag-ai">AI</span>' : ''}
        </span>
      </div>`;
    }).join('');
  }

  const aiLabel = aiEncoded != null ? (dist.find(d => d.encoded === aiEncoded)?.label || (aiEncoded === 0 ? 'パス' : '—')) : '—';
  const myLabel = myEncoded != null ? (dist.find(d => d.encoded === myEncoded)?.label || (myEncoded === 0 ? 'パス' : '—')) : '—';

  return `<div class="quiz-panel-title">みんなの回答（全 ${total} 人）</div>
    <div class="quiz-bid-answers-summary">
      <div class="quiz-answer-pill is-mine">あなた: <strong>${escapeHTML(myLabel)}</strong></div>
      <div class="quiz-answer-pill is-ai">AI: <strong>${escapeHTML(aiLabel)}</strong></div>
    </div>
    <div class="quiz-dist-list">${distHTML}</div>
    <div class="quiz-explanation">${escapeHTML(q.explanation || '')}</div>
    <button class="primary-button quiz-next-btn" id="quiz-next">次の問題へ →</button>`;
}

function bindOptionClicks(q) {
  document.querySelectorAll('.quiz-panel button[data-choice], .bid-input-area button[data-choice]').forEach(btn => {
    btn.onclick = () => submitAnswer(q.id, Number(btn.dataset.choice));
  });
  const next = $('quiz-next');
  if (next) next.onclick = () => loadNext();
}
function bindPlayCardClicks(q) {
  const hand = document.querySelector('.quiz-game .hand'); if (!hand) return;
  const legalIds = new Set((q.options || []).map(o => o.value || o.label));
  const handCards = q.scenario?.hand || [];
  hand.querySelectorAll('.card').forEach((el, idx) => {
    const id = handCards[idx];
    if (!legalIds.has(id)) return;
    el.onclick = () => { const opt = (q.options || []).find(o => (o.value || o.label) === id); if (opt) submitAnswer(q.id, opt.index); };
  });
}
function bindDiscardCardClicks(q) {
  const hand = document.querySelector('.quiz-game .hand'); if (!hand) return;
  const handCards = q.scenario?.hand || [];
  const cards = hand.querySelectorAll('.card');
  const selected = new Set();
  cards.forEach((el, idx) => {
    const id = handCards[idx];
    el.onclick = () => {
      if (selected.has(id)) { selected.delete(id); el.classList.remove('selected'); }
      else if (selected.size < 2) { selected.add(id); el.classList.add('selected'); }
      if (selected.size === 2) {
        const chosen = [...selected].sort();
        const opt = (q.options || []).find(o => { const ids = (o.value || []).slice().sort(); return ids.length === 2 && ids[0] === chosen[0] && ids[1] === chosen[1]; });
        if (opt) submitAnswer(q.id, opt.index);
        else {
          cards.forEach(c => c.classList.remove('selected'));
          selected.clear();
          const msg = document.querySelector('.quiz-game .table-message');
          if (msg) { const orig = msg.textContent; msg.textContent = 'その組み合わせは選択肢にありません'; setTimeout(() => { msg.textContent = orig; }, 1600); }
        }
      }
    };
  });
}
async function submitAnswer(questionId, choiceIndex) {
  document.querySelectorAll('.quiz-panel button, .bid-input-area button, .quiz-panel input, .bid-input-area input').forEach(b => b.disabled = true);
  try {
    const res = await authFetch('/api/quiz/answer', { method: 'POST', body: JSON.stringify({ questionId, choiceIndex }) });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      if (res.status === 409) return loadQuestion(questionId);
      alert(data.error || '回答の保存に失敗しました');
      return;
    }
    loadQuestion(questionId);
  } catch { alert('回答の送信に失敗しました'); loadQuestion(questionId); }
}
function renderLoading() { const s = $('quiz-shell'); if (s) s.innerHTML = '<div class="quiz-loading">読み込み中…</div>'; }
function renderError(msg) { const s = $('quiz-shell'); if (s) s.innerHTML = `<div class="quiz-error">${escapeHTML(msg)}</div>`; }
function renderAllDone() {
  const s = $('quiz-shell');
  if (s) s.innerHTML = `<div class="quiz-done"><div class="eyebrow">COMPLETE</div><h2>全ての問題に回答しました</h2><p>引き続きデータが集まるとAI戦略に反映されます。</p><button class="primary-button" id="quiz-go-select" style="margin-top:16px;">モード選択へ戻る</button></div>`;
  const b = $('quiz-go-select'); if (b) b.onclick = () => { $('quiz-screen').classList.add('hidden'); $('mode-select-screen').classList.remove('hidden'); };
}
function renderAuthRequired(msg) {
  const s = $('quiz-shell'); if (!s) return;
  s.innerHTML = `<div class="quiz-auth-required"><div class="eyebrow">QUIZ</div><h2>プレイヤー登録が必要です</h2><p>${escapeHTML(msg || '何切る問題集は1アカウント1回の回答を保証するため、ログインが必要です。')}</p><button class="primary-button" id="quiz-go-register">プレイヤー登録へ</button></div>`;
  const b = $('quiz-go-register');
  if (b) b.onclick = () => { $('quiz-screen').classList.add('hidden'); $('profile-screen').classList.remove('hidden'); };
}
