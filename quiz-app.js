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
  
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 15000);
  
  try {
    const res = await fetch(url, Object.assign({}, opts, { headers, signal: controller.signal }));
    return res;
  } finally {
    clearTimeout(timeoutId);
  }
}
function cardElHTML(id, extra = '') {
  if (!id) return `<div class="card card-back ${extra}"></div>`;
  const safeId = String(id);
  const suit = safeId[0], rank = safeId.slice(1);
  const red = suit === '♦' || suit === '♥';
  return `<div class="card ${red ? 'red ' : ''}${extra}"><span class="rank">${rank}</span><span class="suit">${suit}</span></div>`;
}
function escapeHTML(v) { return String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }

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
  } catch (e) { 
    if (e.name === 'AbortError') renderError('通信がタイムアウトしました。再読み込みしてください。');
    else renderError('通信に失敗しました'); 
  }
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
    <div style="display:flex; justify-content:space-between; align-items:center; margin-top:4px;">
      <button id="quiz-reset-btn" style="background:none; border:none; color:#e89685; font-size:10px; text-decoration:underline; cursor:pointer;">最初からやり直す</button>
      <div class="quiz-progress-meta" style="margin:0;">${p.answered} / ${p.total}問（${pct}%）</div>
    </div>
    <div class="quiz-cat-chips">${Object.entries(p.perCategory).map(([c, v]) => `<span class="quiz-cat-chip">${QUIZ_LABELS[c] || c}: ${v.answered}/${v.total}</span>`).join('')}</div>`;
  
  const resetBtn = $('quiz-reset-btn');
  if (resetBtn) {
    resetBtn.onclick = async () => {
      if (!confirm('回答履歴をすべて削除して、最初からやり直しますか？')) return;
      try {
        await authFetch('/api/quiz/reset', { method: 'POST' });
        loadProgress();
      } catch (e) {
        alert('リセットに失敗しました');
      }
    };
  }
}

async function loadQuestion(id) {
  renderLoading();
  try {
    const res = await authFetch('/api/quiz/q/' + encodeURIComponent(id) + '?t=' + Date.now());
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
    if (e.name === 'AbortError') renderError('読み込みがタイムアウトしました。ページを再読み込みしてください。');
    else renderError('通信失敗: ' + e.message); 
  }
}

async function loadNext() {
  try {
    const res = await authFetch('/api/quiz/progress');
    const data = await res.json();
    if (!res.ok) return;
    if (!data.nextQuestionId) return renderAllDone();
    loadQuestion(data.nextQuestionId);
  } catch {
    renderError('次の問題の取得に失敗しました。');
  }
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
  const turnIndex = q.scenario?.trick?.length ?? 0;
  const disp = actual => (actual - mySeat + 5) % 5;
  
  const contract = q.scenario?.contract;
  const points = q.scenario?.points || [0,0,0,0,0];
  const taken = q.scenario?.taken || [[],[],[],[],[]];

  let trumpInfoHTML = '';
  if (contract && contract.suit && contract.suit !== 'NT') {
    const trumpSuit = contract.suit;
    const playedTrumps = (q.scenario.playedCards || []).filter(c => c.suit === trumpSuit).length;
    const myTrumps = (q.scenario.hand || []).filter(id => id[0] === trumpSuit).length;
    const remainingTrumps = Math.max(0, 13 - playedTrumps - myTrumps);
    trumpInfoHTML = `
      <div class="trump-counter" style="display:flex;justify-content:center;align-items:center;gap:12px;margin:4px auto;padding:4px 12px;border:1px solid rgba(225,188,112,.25);border-radius:8px;background:rgba(0,0,0,.4);font-size:11px;color:#dce8df;width:fit-content;">
        <span style="font-size:16px;font-weight:800;color:var(--gold);">${trumpSuit}</span>
        <span>場: <b style="color:#f3d48e;font-size:13px;">${playedTrumps}</b></span>
        <span>自: <b style="color:#f3d48e;font-size:13px;">${myTrumps}</b></span>
        <span>残: <b style="color:#f3d48e;font-size:13px;">${remainingTrumps}</b></span>
      </div>`;
  }

  let messageText = '';
  if (turnIndex === 0) messageText = 'あなたが先攻です。カードを出してください';
  else if (turnIndex === 4) messageText = 'あなたの番です。最後のカードを出してください';
  else messageText = 'あなたの番です。場札に続けてください';

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
    trickCardsHTML = q.scenario.trick.map((e, i) => {
      const seat = e.seat !== undefined ? e.seat : 0;
      const pos = disp(seat);
      let cardId = '';
      if (typeof e.card === 'string') cardId = e.card;
      else if (e.card && typeof e.card === 'object') cardId = e.card.id || '';
      else if (e.card) cardId = String(e.card);
      
      // もしIDが取れなくてもエラーにせず「? ?」を表示
      if (!cardId || cardId.length < 2) cardId = '? ?';
      
      const suit = cardId[0], rank = cardId.slice(1);
      const red = suit === '♦' || suit === '♥';
      
      const styles = {
        0: 'left: 50%; top: 70%;',
        1: 'left: 75%; top: 62%;',
        2: 'left: 75%; top: 38%;',
        3: 'left: 25%; top: 38%;',
        4: 'left: 25%; top: 62%;'
      }[pos] || 'left: 50%; top: 50%;';
      
      // 絶対に最前面に表示させるための超強力なインラインスタイル
      return `<div class="card ${red ? 'red ' : ''}trick-card played-seat-${pos}" style="position: absolute !important; transform: translate(-50%, -50%) !important; ${styles} z-index: 2147483647 !important; width: 48px !important; height: 68px !important; background: #fff !important; color: #000 !important; display: block !important; visibility: visible !important; border-radius: 6px; border: 2px solid #ccc; box-shadow: 0 4px 12px rgba(0,0,0,.6); pointer-events: none;">
        <span class="rank" style="position:absolute; left:4px; top:4px; font-size:16px; font-weight:800;">${rank}</span>
        <span class="suit" style="position:absolute; left:6px; top:22px; font-size:15px;">${suit}</span>
      </div>`;
    }).join('');
  }

  const handCards = q.scenario?.hand || [];
  const legalIds = !q.reveal ? new Set((q.options || []).map(o => o.value || o.label)) : new Set();
  const handHTML = handCards.map(id => cardElHTML(id, legalIds.has(id) ? 'playable' : '')).join('');

  const panelHTML = renderQuestionPanel(q, mySeat);
  const isPlayAndNotReveal = (category === 'play' && !q.reveal);

  shell.innerHTML = `
    <div class="game-screen quiz-game">
      <div class="game-head">
        <button class="back-button" id="quiz-inner-back">← メニュー</button>
        <div class="game-meta"><span>${escapeHTML((q.id || fallbackId).toUpperCase())}</span><span class="mode-tag">${QUIZ_LABELS[category]}</span></div>
        <div class="phase-label">${CATEGORY_PHASE[category]}</div>
      </div>
      ${contractInfoHTML}
      ${trumpInfoHTML}
      <div class="table-message">${escapeHTML(messageText)}</div>
      <div class="table-area">
        <div class="players-ring">${seatEls.join('')}</div>
        ${trickCardsHTML ? `<div class="trick-cards" style="position: absolute; inset: 0; z-index: 50;">${trickCardsHTML}</div>` : ''}
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

  document.querySelectorAll('.quiz-game .player-seat').forEach((el, i) => {
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

  let displayIndices = [];
  if (isReveal && q.stats) {
    const sortedStats = [...q.stats].sort((a, b) => b.count - a.count);
    displayIndices = sortedStats.slice(0, 3).map(s => s.index);
    if (q.myAnswer !== null && q.myAnswer !== undefined && !displayIndices.includes(q.myAnswer)) {
      displayIndices.push(q.myAnswer);
    }
  } else {
    displayIndices = (q.options || []).map(o => o.index);
  }

  const opts = displayIndices.map(idx => {
    const o = q.options.find(opt => opt.index === idx);
    if (!o) return '';
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
  } catch (e) { 
    alert('回答の送信に失敗しました。通信環境を確認してください。'); 
    loadQuestion(questionId); 
  }
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
