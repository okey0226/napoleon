// quiz-app.js — 何切る問題集（play特化）
const $ = id => document.getElementById(id);
const QUIZ_LABELS = { play: '何を出す？' };
const CATEGORY_PHASE = { play: 'カードプレイ' };
const SV = { '♣': 1, '♦': 2, '♥': 3, '♠': 4, NT: 5 };
const RANKS = ['2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K', 'A'];

let _bound = false;

function sessionToken() { return localStorage.getItem('napoleon_session') || null; }
async function authFetch(url, opts = {}) {
  const token = sessionToken();
  const headers = Object.assign({}, opts.headers || {});
  if (token) headers['x-session-token'] = token;
  if (opts.body && !headers['content-type']) headers['content-type'] = 'application/json';
  return fetch(url, Object.assign({}, opts, { headers }));
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

// 獲得したカードを表示する関数
function addTakenCards(seatEl, cards) {
  if (!cards || !cards.length) return;
  const row = document.createElement('div');
  row.className = 'taken-cards';
  
  const label = document.createElement('span');
  label.className = 'taken-label';
  label.textContent = '獲得 ' + cards.length;
  row.append(label);
  
  cards.slice().sort((a, b) => {
    const sa = a[0], ra = a.slice(1);
    const sb = b[0], rb = b.slice(1);
    return SV[sa] - SV[sb] || RANKS.indexOf(ra) - RANKS.indexOf(rb);
  }).forEach(id => {
    const suit = id[0], rank = id.slice(1);
    const isRed = suit === '♦' || suit === '♥';
    const tag = document.createElement('span');
    tag.className = 'taken-card ' + (isRed ? 'red' : '');
    tag.textContent = suit + rank;
    row.append(tag);
  });
  
  seatEl.append(row);
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

function getMySeat(q) {
  return q.scenario?.seat ?? 0;
}

function renderGameReplica(q, fallbackId = '') {
  const shell = $('quiz-shell'); if (!shell) return;
  const category = 'play';
  if (!q.options || !q.options.length) {
    return renderError('問題データが不正です（Options missing）');
  }

  const mySeat = getMySeat(q);
  const disp = actual => (actual - mySeat + 5) % 5;
  const contract = q.scenario?.contract;
  const points = q.scenario?.points || [0,0,0,0,0];
  const taken = q.scenario?.taken || [[],[],[],[],[]];

  let messageText = q.scenario?.trick?.length ? 'あなたの番です。場札に続けてください' : 'あなたが先攻です。カードを出してください';

  let contractInfoHTML = '';
  if (contract) {
    const parts = [`<strong class="contract-bid">宣言 ${contract.num}${contract.suit}${contract.solo ? '（ソロ）' : ''}</strong>`];
    const callId = q.scenario?.call?.id || null;
    if (callId) parts.push(`<span class="contract-call-label">副官札</span><div class="contract-kitty-cards">${cardElHTML(callId, 'contract-kitty-card')}</div>`);
    const discarded = q.scenario?.discarded || [];
    if (discarded.length) parts.push(`<span class="contract-call-label">捨て札</span><div class="contract-kitty-cards">${discarded.map(id => cardElHTML(id, 'contract-kitty-card')).join('')}</div>`);
    if (contract.solo && contract.revealedCall) parts.push('<span class="contract-call-label">ひとり立ち</span>');
    contractInfoHTML = `<div class="contract-info">${parts.join('')}</div>`;
  }

  const nap = contract?.nap ?? -1;
  const deputy = contract?.deputy ?? -1;
  const revealed = contract?.revealedCall ?? false;
  let activeSeat = q.scenario?.seat ?? -1;

  const seatNames = {};
  seatNames[mySeat] = 'あなた';
  let comIdx = 1;
  for (let i = 0; i < 5; i++) if (i !== mySeat) seatNames[i] = `COM ${comIdx++}`;

  const seatEls = [];
  for (let actual = 0; actual < 5; actual++) {
    const pos = disp(actual);
    let role = '';
    if (nap >= 0) {
      if (actual === nap) role = 'ナポレオン';
      else if (revealed && actual === deputy) role = '副官';
      else if (revealed) role = '連合軍';
    }
    const seatHtml = `<div class="player-seat player-color-${pos} pos-${pos} ${actual===mySeat?'me':''} ${activeSeat===actual?'active':''} ${role==='副官'?'deputy-seat':''}">
      <div class="seat-name">${escapeHTML(seatNames[actual])}</div>
      <div class="seat-role ${role==='副官'?'deputy-status':''}">${escapeHTML(role)}</div>
    </div>`;
    seatEls.push(seatHtml);
  }

  let trickCardsHTML = '';
  if (q.scenario?.trick?.length) {
    trickCardsHTML = q.scenario.trick.map(e => {
      const pos = disp(e.seat);
      const suit = e.card[0], rank = e.card.slice(1);
      const red = suit === '♦' || suit === '♥';
      return `<div class="card ${red ? 'red ' : ''}trick-card played-seat-${pos}"><span class="rank">${rank}</span><span class="suit">${suit}</span></div>`;
    }).join('');
  }

  const handCards = q.scenario?.hand || [];
  const legalIds = !q.reveal ? new Set((q.options || []).map(o => o.value || o.label)) : new Set();
  const handHTML = handCards.map(id => cardElHTML(id, legalIds.has(id) ? 'playable' : '')).join('');

  const panelHTML = renderQuestionPanel(q, mySeat);

  // 回答前の play ではパネルを出さない
  const isPlayAndNotReveal = (category === 'play' && !q.reveal);

  shell.innerHTML = `
    <div class="game-screen quiz-game">
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
        ${isPlayAndNotReveal ? '' : `<div class="quiz-panel">${panelHTML}</div>`}
      </div>
      <div class="hand-dock">
        <div class="hand-label">あなたの手札 <span>${handCards.length}枚</span></div>
        <div class="hand">${handHTML}</div>
      </div>
    </div>`;

  // 座席に獲得カードを追加
  document.querySelectorAll('.quiz-game .player-seat').forEach((el, i) => {
    // posクラスから元の座席を特定
    const actualSeat = (mySeat + i) % 5;
    addTakenCards(el, taken[actualSeat]);
  });

  const innerBack = $('quiz-inner-back');
  if (innerBack) innerBack.onclick = () => {
    $('quiz-screen').classList.add('hidden');
    $('mode-select-screen').classList.remove('hidden');
  };
  bindOptionClicks(q);
  if (!q.reveal) bindPlayCardClicks(q);
}

function renderQuestionPanel(q, mySeat) {
  const isReveal = q.reveal;
  const nextBtn = `<button class="primary-button quiz-next-btn" id="quiz-next">次の問題へ →</button>`;

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

function bindOptionClicks(q) {
  document.querySelectorAll('.quiz-panel button[data-choice]').forEach(btn => {
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
async function submitAnswer(questionId, choiceIndex) {
  document.querySelectorAll('.quiz-panel button, .quiz-panel input').forEach(b => b.disabled = true);
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
