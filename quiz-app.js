// quiz-app.js — 何切る問題集（ゲーム画面レプリカ）
const $ = id => document.getElementById(id);
const QUIZ_LABELS = { bid:'何で立つ？', call:'誰を指名する？', discard:'何を切る？', play:'何を出す？' };
const CATEGORY_PHASE = { bid:'競り', call:'副官指名', discard:'浮き札の交換', play:'カードプレイ' };
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
function escapeHTML(v) { return String(v ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }

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
    <div class="quiz-cat-chips">${Object.entries(p.perCategory).map(([c,v]) => `<span class="quiz-cat-chip">${QUIZ_LABELS[c]||c}: ${v.answered}/${v.total}</span>`).join('')}</div>`;
}
async function loadQuestion(id) {
  renderLoading();
  try {
    const res = await authFetch('/api/quiz/q/' + encodeURIComponent(id));
    const data = await res.json();
    if (!res.ok) return renderError(data.error || '読み込み失敗');
    renderGameReplica(data);
    refreshProgress();
  } catch { renderError('通信失敗'); }
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
  if (q.category === 'bid') return 0;
  if (q.category === 'call') return q.scenario.contract?.seat ?? 0;
  if (q.category === 'discard') return q.scenario.contract?.seat ?? 0;
  if (q.category === 'play') return q.scenario.seat ?? 0;
  return 0;
}

function renderGameReplica(q) {
  const shell = $('quiz-shell'); if (!shell) return;
  if (!q.options || !q.options.length) return renderError('問題データが不正です');
  const mySeat = getMySeat(q);
  const disp = actual => (actual - mySeat + 5) % 5;
  const contract = q.scenario.contract;
  const isPlay = q.category === 'play';
  const isCall = q.category === 'call';
  const isDiscard = q.category === 'discard';
  const isBid = q.category === 'bid';

  let messageText = '';
  if (isBid) messageText = q.scenario.high?.num >= 13 ? `現在の宣言: ${q.scenario.high.num}${q.scenario.high.suit} ／ あなたの番です` : '宣言なし。最初の宣言をしてください。';
  else if (isCall) messageText = '副官に指名するカードを選んでください';
  else if (isDiscard) messageText = '手札12枚から2枚を選んで捨ててください';
  else if (isPlay) messageText = q.scenario.trick?.length ? 'あなたの番です。場札に続けてください' : 'あなたが先攻です。カードを出してください';

  let contractInfoHTML = '';
  if (contract) {
    const parts = [`<strong class="contract-bid">宣言 ${contract.num}${contract.suit}${contract.solo ? '（ソロ）' : ''}</strong>`];
    const callId = q.scenario.call?.id || null;
    if (callId && !isDiscard) parts.push(`<span class="contract-call-label">副官札</span><div class="contract-kitty-cards">${cardElHTML(callId, 'contract-kitty-card')}</div>`);
    const discarded = q.scenario.discarded || [];
    if (discarded.length && !isDiscard) parts.push(`<span class="contract-call-label">捨て札</span><div class="contract-kitty-cards">${discarded.map(id => cardElHTML(id, 'contract-kitty-card')).join('')}</div>`);
    if (contract.solo && contract.revealedCall) parts.push('<span class="contract-call-label">ひとり立ち</span>');
    contractInfoHTML = `<div class="contract-info">${parts.join('')}</div>`;
  }

  const nap = contract?.nap ?? -1;
  const deputy = contract?.deputy ?? -1;
  const revealed = contract?.revealedCall ?? false;
  let activeSeat = -1;
  if (isCall || isDiscard) activeSeat = contract?.nap ?? -1;
  if (isPlay) activeSeat = q.scenario.seat ?? -1;

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
    seatEls.push(`<div class="player-seat player-color-${pos} pos-${pos} ${actual===mySeat?'me':''} ${activeSeat===actual?'active':''} ${role==='副官'?'deputy-seat':''}">
      <div class="seat-name">${escapeHTML(seatNames[actual])}</div>
      <div class="seat-role ${role==='副官'?'deputy-status':''}">${escapeHTML(role)}</div>
    </div>`);
  }

  let trickCardsHTML = '';
  if (isPlay && q.scenario.trick?.length) {
    trickCardsHTML = q.scenario.trick.map(e => {
      const pos = disp(e.seat);
      const suit = e.card[0], rank = e.card.slice(1);
      const red = suit === '♦' || suit === '♥';
      return `<div class="card ${red?'red ':''}trick-card played-seat-${pos}"><span class="rank">${rank}</span><span class="suit">${suit}</span></div>`;
    }).join('');
  }

  let kittyHTML = isBid ? `<span class="open-label">オープン</span>${cardElHTML(null)}${cardElHTML(null)}` : '';

  const handCards = q.scenario.hand || [];
  const handMode = isDiscard ? 'discard-mode' : '';
  const legalIds = isPlay && !q.reveal ? new Set(q.options.map(o => o.value || o.label)) : new Set();
  const handHTML = handCards.map(id => cardElHTML(id, legalIds.has(id) ? 'playable' : '')).join('');

  const panelHTML = renderQuestionPanel(q);

  shell.innerHTML = `
    <div class="game-screen quiz-game ${isDiscard?'discarding':''}">
      <div class="game-head">
        <button class="back-button" id="quiz-inner-back">← メニュー</button>
        <div class="game-meta"><span>${escapeHTML(q.id.toUpperCase())}</span><span class="mode-tag">${QUIZ_LABELS[q.category]}</span></div>
        <div class="phase-label">${CATEGORY_PHASE[q.category]}</div>
      </div>
      ${contractInfoHTML}
      <div class="table-message">${escapeHTML(messageText)}</div>
      <div class="table-area">
        <div class="players-ring">${seatEls.join('')}</div>
        ${trickCardsHTML ? `<div class="trick-cards">${trickCardsHTML}</div>` : ''}
        <div class="center-table">
          <div class="center-caption">場札</div>
          ${kittyHTML ? `<div class="kitty-view">${kittyHTML}</div>` : ''}
        </div>
        <div class="quiz-panel">${panelHTML}</div>
      </div>
      <div class="hand-dock">
        <div class="hand-label">あなたの手札 <span>${handCards.length}枚</span></div>
        <div class="hand ${handMode}">${handHTML}</div>
      </div>
    </div>`;

  const innerBack = $('quiz-inner-back');
  if (innerBack) innerBack.onclick = () => { $('quiz-screen').classList.add('hidden'); $('home-screen').classList.remove('hidden'); };
  bindOptionClicks(q);
  if (isPlay && !q.reveal) bindPlayCardClicks(q);
  if (isDiscard && !q.reveal) bindDiscardCardClicks(q);
}

function renderQuestionPanel(q) {
  const isReveal = q.reveal;
  if (q.category === 'bid') {
    const opts = q.options.map(o => {
      const isAI = isReveal && q.aiAnswerIndex === o.index;
      const isMine = q.myAnswer === o.index;
      const stat = isReveal ? (q.stats?.find(s => s.index === o.index)?.count || 0) : 0;
      const total = q.totalAnswers || 0;
      const pct = total ? Math.round(stat / total * 100) : 0;
      return `<button class="quiz-bid-btn ${isMine?'is-mine':''} ${isAI?'is-ai':''}" data-choice="${o.index}" ${isReveal?'disabled':''}>
        <span class="quiz-bid-label">${escapeHTML(o.label)}</span>
        ${isReveal ? `<span class="quiz-bid-stat"><span class="quiz-bid-bar" style="width:${pct}%"></span><span class="quiz-bid-pct">${stat}人 ${pct}%</span></span>` : ''}
        ${isAI ? '<span class="quiz-tag-ai">AI</span>' : ''}
        ${isMine ? '<span class="quiz-tag-mine">あなた</span>' : ''}
      </button>`;
    }).join('');
    return `<div class="quiz-panel-title">現在の宣言: ${q.scenario.high?.num >= 13 ? `${q.scenario.high.num}${q.scenario.high.suit}` : 'なし'} ／ 何で立つ？</div>
      <div class="quiz-bid-list">${opts}</div>
      ${isReveal ? `<div class="quiz-explanation">${escapeHTML(q.explanation)}</div><button class="primary-button quiz-next-btn" id="quiz-next">次の問題へ</button>` : ''}`;
  }
  if (q.category === 'call') {
    const opts = q.options.map(o => {
      const id = o.value?.id || o.label;
      const isAI = isReveal && q.aiAnswerIndex === o.index;
      const isMine = q.myAnswer === o.index;
      const stat = isReveal ? (q.stats?.find(s => s.index === o.index)?.count || 0) : 0;
      const total = q.totalAnswers || 0;
      const pct = total ? Math.round(stat / total * 100) : 0;
      return `<button class="quiz-call-card-btn ${isMine?'is-mine':''} ${isAI?'is-ai':''}" data-choice="${o.index}" ${isReveal?'disabled':''}>
        ${cardElHTML(id)}
        ${isReveal ? `<div class="quiz-card-stat-bar"><div class="quiz-card-stat-fill" style="height:${pct}%"></div></div><span class="quiz-card-pct">${pct}%</span><small>${stat}人</small>` : ''}
        ${isAI ? '<span class="quiz-card-tag-ai">AI</span>' : ''}
        ${isMine ? '<span class="quiz-card-tag-mine">あなた</span>' : ''}
      </button>`;
    }).join('');
    return `<div class="quiz-panel-title">副官に指名するカードを選んでください</div>
      <div class="quiz-call-grid">${opts}</div>
      ${isReveal ? `<div class="quiz-explanation">${escapeHTML(q.explanation)}</div><button class="primary-button quiz-next-btn" id="quiz-next">次の問題へ</button>` : ''}`;
  }
  if (q.category === 'discard') {
    const opts = q.options.map(o => {
      const ids = o.value || [];
      const isAI = isReveal && q.aiAnswerIndex === o.index;
      const isMine = q.myAnswer === o.index;
      const stat = isReveal ? (q.stats?.find(s => s.index === o.index)?.count || 0) : 0;
      const total = q.totalAnswers || 0;
      const pct = total ? Math.round(stat / total * 100) : 0;
      return `<button class="quiz-discard-pair-btn ${isMine?'is-mine':''} ${isAI?'is-ai':''}" data-choice="${o.index}" ${isReveal?'disabled':''}>
        <div class="quiz-discard-pair-cards">${ids.map(id=>cardElHTML(id)).join('')}</div>
        ${isReveal ? `<span class="quiz-bid-stat"><span class="quiz-bid-bar" style="width:${pct}%"></span><span class="quiz-bid-pct">${stat}人 ${pct}%</span></span>` : ''}
        ${isAI ? '<span class="quiz-tag-ai">AI</span>' : ''}
        ${isMine ? '<span class="quiz-tag-mine">あなた</span>' : ''}
      </button>`;
    }).join('');
    return `<div class="quiz-panel-title">捨てる組み合わせを選ぶ（手札を2枚クリックでもOK）</div>
      <div class="quiz-discard-grid">${opts}</div>
      ${isReveal ? `<div class="quiz-explanation">${escapeHTML(q.explanation)}</div><button class="primary-button quiz-next-btn" id="quiz-next">次の問題へ</button>` : ''}`;
  }
  if (q.category === 'play') {
    const opts = q.options.map(o => {
      const id = o.value || o.label;
      const isAI = isReveal && q.aiAnswerIndex === o.index;
      const isMine = q.myAnswer === o.index;
      const stat = isReveal ? (q.stats?.find(s => s.index === o.index)?.count || 0) : 0;
      const total = q.totalAnswers || 0;
      const pct = total ? Math.round(stat / total * 100) : 0;
      return `<button class="quiz-play-card-btn ${isMine?'is-mine':''} ${isAI?'is-ai':''}" data-choice="${o.index}" ${isReveal?'disabled':''}>
        ${cardElHTML(id)}
        ${isReveal ? `<div class="quiz-card-stat-bar"><div class="quiz-card-stat-fill" style="height:${pct}%"></div></div><span class="quiz-card-pct">${pct}%</span><small>${stat}人</small>` : ''}
        ${isAI ? '<span class="quiz-card-tag-ai">AI</span>' : ''}
        ${isMine ? '<span class="quiz-card-tag-mine">あなた</span>' : ''}
      </button>`;
    }).join('');
    return `<div class="quiz-panel-title">出すカードを選んでください（手札のハイライトからもOK）</div>
      <div class="quiz-play-grid">${opts}</div>
      ${isReveal ? `<div class="quiz-explanation">${escapeHTML(q.explanation)}</div><button class="primary-button quiz-next-btn" id="quiz-next">次の問題へ</button>` : ''}`;
  }
  return '';
}

function bindOptionClicks(q) {
  document.querySelectorAll('.quiz-panel button[data-choice]').forEach(btn => {
    btn.onclick = () => submitAnswer(q.id, Number(btn.dataset.choice));
  });
  const next = $('quiz-next'); if (next) next.onclick = () => loadNext();
}
function bindPlayCardClicks(q) {
  const hand = document.querySelector('.quiz-game .hand'); if (!hand) return;
  const legalIds = new Set(q.options.map(o => o.value || o.label));
  const handCards = q.scenario.hand || [];
  hand.querySelectorAll('.card').forEach((el, idx) => {
    const id = handCards[idx];
    if (!legalIds.has(id)) return;
    el.onclick = () => { const opt = q.options.find(o => (o.value || o.label) === id); if (opt) submitAnswer(q.id, opt.index); };
  });
}
function bindDiscardCardClicks(q) {
  const hand = document.querySelector('.quiz-game .hand'); if (!hand) return;
  const handCards = q.scenario.hand || [];
  const cards = hand.querySelectorAll('.card');
  const selected = new Set();
  cards.forEach((el, idx) => {
    const id = handCards[idx];
    el.onclick = () => {
      if (selected.has(id)) { selected.delete(id); el.classList.remove('selected'); }
      else if (selected.size < 2) { selected.add(id); el.classList.add('selected'); }
      if (selected.size === 2) {
        const chosen = [...selected].sort();
        const opt = q.options.find(o => { const ids = (o.value || []).slice().sort(); return ids.length === 2 && ids[0] === chosen[0] && ids[1] === chosen[1]; });
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
  document.querySelectorAll('.quiz-panel button[data-choice]').forEach(b => b.disabled = true);
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
function renderAllDone() { const s = $('quiz-shell'); if (s) s.innerHTML = `<div class="quiz-done"><div class="eyebrow">COMPLETE</div><h2>全ての問題に回答しました</h2><p>引き続きデータが集まるとAI戦略に反映されます。</p></div>`; }
function renderAuthRequired(msg) {
  const s = $('quiz-shell'); if (!s) return;
  s.innerHTML = `<div class="quiz-auth-required"><div class="eyebrow">QUIZ</div><h2>プレイヤー登録が必要です</h2><p>${escapeHTML(msg || '何切る問題集は1アカウント1回の回答を保証するため、ログインが必要です。')}</p><button class="primary-button" id="quiz-go-register">プレイヤー登録へ</button></div>`;
  const b = $('quiz-go-register');
  if (b) b.onclick = () => { $('quiz-screen').classList.add('hidden'); $('profile-screen').classList.remove('hidden'); };
}
