// ============================================================
// js/screens/game-online.js
// 依存: constants.js, js/core.js, js/ui.js, js/debug.js, js/api.js
// 役割: オンライン対戦（WebSocket 通信・状態描画・操作送信）
// ============================================================
import { RANKS } from '../../constants.js';
import { $, g, screen, toast, message, sendGame, closeOnline, escapeHTML, code } from '../core.js';
import { phase, cardEl, announceCall, bidHistoryHTML, addTakenCards } from '../ui.js';
import { loadTopStrategy } from '../api.js';

// ---------------- 接続 ----------------
export async function online(mode, roomCode, bots, botLevel = 3) {
  $('game-log-open').classList.add('hidden');
  if (mode === 'ranked' && !localStorage.getItem('napoleon_session')) {
    toast('先にプレイヤー登録をしてください');
    screen('profile-screen');
    return;
  }
  loadTopStrategy();
  try {
    g.room = await new Promise((resolve, reject) => {
      const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
      const ws = new WebSocket(proto + '//' + location.host + '/ws');
      ws.onopen = () => resolve({ ws, send: m => ws.send(JSON.stringify(m)), close: () => ws.close() });
      ws.onerror = reject;
    });
    g.mySeat = -1;
    g.privateHand = [];
    g.onlineState = null;
    g.onlineDiscard = new Set();
    g.onlineSelectedCard = null;
    g.onlineBid = 13;
    g.onlineSuit = '♠';
    g.onlineRank = 'A';
    g.announcedCallRound = null;
    g.announcedRound = null;
    ['auction-panel', 'call-panel', 'play-panel', 'result-panel'].forEach(id => $(id).classList.add('hidden'));
    screen('game-screen');
    $('game-mode-label').textContent = mode === 'ranked' ? 'RANKED' : 'FRIEND MATCH';
    $('rating-caption').textContent = 'RATE';
    phase(mode === 'ranked' ? '対戦相手を検索' : '部屋を準備中');
    message(mode === 'ranked' ? '最後の入室から90秒経過するとCOMが参加します' : '合言葉 ' + roomCode + ' で参加を待っています');

    g.room.ws.onmessage = e => {
      let m; try { m = JSON.parse(e.data); } catch { return; }
      if (m.type === 'lobby') {
        message(m.text);
        const qs = $('queue-status');
        if (qs) qs.textContent = m.text;
      }
      if (m.type === 'matched') {
        g.online = m;
        g.mySeat = m.seat;
        g.players = m.players.map(p => ({ name: p.id, hand: [] }));
        g.active = -1;
        drawOnlineSeats({ players: g.players, phase: 'prep', active: -1 });
        phase('対戦開始');
        message('配札しました。競り開始まで7秒です。' + (m.botCount ? ' COM ' + m.botCount + '人が参加します。' : ''));
      }
      if (m.type === 'game-state') {
        g.onlineState = m.state;
        g.mySeat = m.you;
        g.active = m.state.active;
        g.phase = m.state.phase;
        g.players = m.state.players.map(p => ({ name: p.name, hand: Array(p.handCount).fill(null) }));
        renderOnline();
      }
      if (m.type === 'private-hand') {
        g.privateHand = m.hand;
        g.onlineLegal = m.legal;
        drawOnlineHand();
        if (g.onlineState) drawOnlineControls(g.onlineState);
      }
      if (m.type === 'rating-updated') {
        g.lastRating = m;
        g.account = Object.assign({}, g.account, { rating: m.rating });
        $('rating-label').textContent = m.rating;
        toast('RATE Δ ' + m.delta);
        if (g.onlineState?.phase === 'result') showOnlineResult(g.onlineState);
      }
      if (m.type === 'room-error') toast(m.message);
    };
    g.room.send({
      type: 'join', mode, code: roomCode, bots,
      botLevel: Number(botLevel) || 3,
      sessionToken: localStorage.getItem('napoleon_session'),
      playerId: g.account?.id || 'プレイヤー'
    });
  } catch (e) {
    toast('対戦に接続できませんでした');
    screen('home-screen');
  }
}

// ---------------- 状態描画 ----------------
function renderOnline() {
  const s = g.onlineState;
  if (!s) return;
  g.round = s.round || 1;
  g.playoff = !!s.playoff;
  g.appealInfo = s.appealInfo || '';
  if (s.phase !== 'play' || s.active !== g.mySeat) g.onlineSelectedCard = null;
  g.matchScores = s.matchScores || g.matchScores;
  g.players = s.players.map(p => ({
    name: p.name, bot: p.bot,
    hand: Array(p.handCount).fill(null),
    taken: p.taken || []
  }));
  g.active = s.players.findIndex(p => p.active === s.active);
  g.contract = s.contract ? {
    nap: s.contract.nap, deputy: s.contract.deputy, num: s.contract.num,
    suit: s.contract.suit, solo: s.contract.solo,
    call: s.contract.call, revealedCall: s.contract.revealedCall
  } : null;
  phase(({
    prep: '競り準備', auction: '競り',
    'appeal-offer': 'アピール', 'appeal-response': 'アピール回答',
    call: '指名札選び', 'call-reveal': '指名カード確認',
    discard: '浮き札の交換', play: 'カードプレイ',
    result: '結果', 'round-result': '局結果',
    redeal: '配り直し', 'trick-end': '勝負の結果'
  })[s.phase] || '対戦中');
  $('round-label').textContent = s.round || 1;
  $('game-mode-label').textContent = s.mode === 'ranked'
    ? 'RANKED' + (s.players.some(p => p.bot) ? ' · COM ' + s.players.filter(p => p.bot).length : '')
    : 'FRIEND MATCH' + (s.players.some(p => p.bot) ? ' · COM ' + s.players.filter(p => p.bot).length : '');
  $('rating-label').textContent = g.account?.rating ?? '—';
  message(s.notice || '');
  drawOnlineSeats(s);
  $('trick-cards').replaceChildren(...s.trick.map(x => {
    const e = cardEl(x.card, 'trick-card played-seat-' + x.seat);
    e.title = s.players[x.seat].name;
    return e;
  }));
  const kittyCards = (s.kitty || []).map(c => cardEl(c));
  if (['auction', 'call'].includes(s.phase)) {
    const label = document.createElement('span');
    label.className = 'open-label';
    label.textContent = s.phase === 'auction' ? 'オープン' : '捨て札';
    if (kittyCards.length) kittyCards.unshift(label);
    else kittyCards.push(label, cardEl(null, 'card-back'), cardEl(null, 'card-back'));
  }
  $('kitty-view').replaceChildren(...kittyCards);
  const clock = $('auction-clock');
  if (['prep', 'call', 'discard', 'play'].includes(s.phase) && s.deadline) {
    clock.classList.remove('hidden');
    clock.textContent = Math.max(0, Math.ceil((s.deadline - Date.now()) / 1000)) + '秒';
  } else {
    clock.classList.add('hidden');
  }
  drawOnlineHand();
  drawOnlineControls(s);
  if (s.phase === 'call-reveal') {
    if (g.announcedCallRound !== s.round) {
      g.announcedCallRound = s.round;
      announceCall(g.contract.call, () => sendGame({ type: 'confirm-call' }), true);
    }
  } else {
    if (g.announcedCallRound !== null) {
      const d = $('message-dialog'), slot = $('dialog-card');
      if (d.open) d.close();
      slot.classList.add('hidden');
      slot.replaceChildren();
      $('dialog-eyebrow').classList.remove('hidden');
      $('dialog-eyebrow').textContent = 'Napoleon';
      $('dialog-ok').textContent = 'OK';
      g.announcedCallRound = null;
    }
    if (['result', 'round-result'].includes(s.phase)) showOnlineResult(s);
    else $('result-panel').classList.add('hidden');
  }
}

function drawOnlineSeats(s) {
  const box = $('players-ring');
  box.replaceChildren();
  const leadSeat = s.phase === 'play' && s.trick?.length ? s.trick[0].seat : s.lastTrickWinner;
  s.players.forEach((p, i) => {
    const e = document.createElement('div');
    e.className = 'player-seat player-color-' + i + ' pos-' + i
      + (i === g.mySeat ? ' me' : '')
      + (i === s.active ? ' active' : '')
      + (leadSeat === i ? ' trick-winner' : '');
    const role = p.approved ? '承認済み' : (p.role || '');
    e.classList.toggle('deputy-seat', role === '副官');
    e.innerHTML = '<div class="seat-name">' + p.name + (p.bot ? '<span class="com-badge">COM</span>' : '') + '</div>'
      + (leadSeat === i ? '<div class="lead-badge" role="img" aria-label="トリック先攻"><i></i></div>' : '')
      + '<div class="seat-role ' + (role === '副官' ? 'deputy-status' : '') + '">' + role + '</div>';
    addTakenCards(e, p.taken);
    box.append(e);
  });
}

function drawOnlineHand() {
  const box = $('hand');
  const scrollLeft = box.scrollLeft;
  const discarding = g.onlineState?.phase === 'discard' && g.mySeat === g.onlineState.active;
  box.classList.toggle('discard-mode', discarding);
  $('game-screen').classList.toggle('discarding', discarding);
  box.replaceChildren();
  (g.privateHand || []).forEach(c => {
    const e = cardEl(c, '');
    const legal = (g.onlineLegal || []).includes(c.id);
    if (g.onlineState?.phase === 'discard' && g.mySeat === g.onlineState.active) {
      const protectedCall = g.mySeat === g.onlineState.contract?.nap && g.onlineState.contract?.call?.id === c.id;
      e.classList.add('playable');
      e.classList.toggle('protected', protectedCall);
      e.classList.toggle('selected', g.onlineDiscard?.has(c.id));
      e.onclick = () => {
        if (protectedCall) { toast('指名札は捨てられません'); return; }
        g.onlineDiscard = g.onlineDiscard || new Set();
        if (g.onlineDiscard.has(c.id)) g.onlineDiscard.delete(c.id);
        else if (g.onlineDiscard.size < 2) g.onlineDiscard.add(c.id);
        const selected = g.onlineDiscard.has(c.id);
        e.classList.toggle('selected', selected);
        e.setAttribute('aria-pressed', String(selected));
        const count = $('online-discard-count'), confirm = $('online-discard');
        if (count) count.textContent = g.onlineDiscard.size + ' / 2 SELECTED';
        if (confirm) confirm.disabled = g.onlineDiscard.size !== 2;
      };
    } else if (g.onlineState?.phase === 'play' && g.mySeat === g.onlineState.active && legal) {
      e.classList.add('playable');
      e.classList.toggle('selected', g.onlineSelectedCard === c.id);
      e.onclick = () => {
        g.onlineSelectedCard = g.onlineSelectedCard === c.id ? null : c.id;
        drawOnlineHand();
        drawOnlineControls(g.onlineState);
      };
    }
    box.append(e);
  });
  if (discarding) box.scrollLeft = scrollLeft;
  $('hand-count').textContent = (g.privateHand || []).length + '枚';
}

function drawOnlineControls(s) {
  ['auction-panel', 'call-panel', 'play-panel'].forEach(id => $(id).classList.add('hidden'));

  if (s.phase === 'appeal-offer' || s.phase === 'appeal-response') {
    const p = $('auction-panel');
    p.classList.remove('hidden');
    if (s.phase === 'appeal-offer') {
      p.innerHTML = g.mySeat === s.active
        ? '<div class="panel-title">オーラス・アピール</div><div class="micro-copy">4位に各J・マイティの所持を尋ねますか？</div><div class="panel-row"><button id="online-appeal" class="small-action">アピールする</button><button id="online-appeal-skip" class="small-action pass">競りへ進む</button></div>'
        : '<div class="panel-title">5位のアピール選択待ち</div>';
      if (g.mySeat === s.active) {
        $('online-appeal').onclick = () => sendGame({ type: 'appeal' });
        $('online-appeal-skip').onclick = () => sendGame({ type: 'skip-appeal' });
      }
    } else {
      p.innerHTML = g.mySeat === s.active
        ? '<div class="panel-title">5位からアピール</div><div class="micro-copy">所持するJ・マイティを申告するか、申告せず立つか選んでください。</div><div class="panel-row"><button id="online-appeal-disclose" class="small-action">札を申告する</button><button id="online-appeal-stand" class="small-action pass">申告せず立つ</button></div>'
        : '<div class="panel-title">4位のアピール回答待ち</div>';
      if (g.mySeat === s.active) {
        $('online-appeal-disclose').onclick = () => sendGame({ type: 'appeal-declare' });
        $('online-appeal-stand').onclick = () => sendGame({ type: 'appeal-stand' });
      }
    }
    return;
  }

  if (s.phase === 'auction') {
    const p = $('auction-panel');
    p.classList.remove('hidden');
    const high = s.auction.high;
    const minBid = s.auction.minBid || 13;
    const historyPanel = bidHistoryHTML(s.bidHistory, seat => s.players[seat]?.name || 'COM');
    const ruleNote = s.round >= 10 ? '<div class="micro-copy">オールラスト · 最低宣言 ' + minBid + ' · 得点2倍 · 立ち必須</div>' : '';
    if (!s.auction.active.includes(g.mySeat)) {
      p.innerHTML = '<div class="panel-title">現在の宣言　<strong>' + (high.num < 13 ? 'なし' : s.players[high.player].name + ' · ' + high.num + high.suit) + '</strong></div><div class="micro-copy">承認済み</div>' + ruleNote + historyPanel;
      return;
    }
    const suit = g.onlineSuit || '♠';
    const bid = Math.max(minBid, g.onlineBid || 13);
    g.onlineBid = bid;
    p.innerHTML = '<div class="panel-title">現在の宣言　<strong>' + (high.num < 13 ? 'なし' : s.players[high.player].name + ' · ' + high.num + high.suit) + '</strong></div>'
      + ruleNote
      + '<div class="panel-row">' + ['♣', '♦', '♥', '♠', 'NT'].map(x => '<button class="suit-choice ' + (x === suit ? 'selected' : '') + '" data-osuit="' + x + '">' + x + '</button>').join('') + '</div>'
      + '<div class="panel-row"><button class="small-action" id="online-minus">−</button><span class="bid-number">' + bid + '</span><button class="small-action" id="online-plus">＋</button></div>'
      + '<div class="panel-row"><button class="small-action pass" id="online-approve" '
      + (high.player === g.mySeat && s.auction.active.length > 1 || s.round >= 10 && high.num < 13 ? 'disabled' : '')
      + '>承認</button><button class="small-action" id="online-bid">宣言する</button></div>'
      + historyPanel;
    p.querySelectorAll('[data-osuit]').forEach(b => b.onclick = () => { g.onlineSuit = b.dataset.osuit; sendGame({ type: 'auction-activity' }); drawOnlineControls(s); });
    $('online-minus').onclick = () => { g.onlineBid = Math.max(minBid, bid - 1); sendGame({ type: 'auction-activity' }); drawOnlineControls(s); };
    $('online-plus').onclick = () => { g.onlineBid = Math.min(20, bid + 1); sendGame({ type: 'auction-activity' }); drawOnlineControls(s); };
    $('online-approve').onclick = () => { sendGame({ type: 'auction-activity' }); sendGame({ type: 'approve' }); };
    $('online-bid').onclick = () => { sendGame({ type: 'auction-activity' }); sendGame({ type: 'bid', num: bid, suit }); };
    return;
  }

  if (s.phase === 'call' && s.active === g.mySeat) {
    const p = $('call-panel');
    p.classList.remove('hidden');
    const suit = g.onlineSuit || '♠';
    const rank = g.onlineRank || 'A';
    const discarded = (s.kitty || []).some(c => c.suit === suit && c.rank === rank);
    p.innerHTML = '<div class="panel-title">副官に指名するカード</div>'
      + '<div class="call-card-preview"><div id="online-call-preview"></div><div><div class="micro-copy">今回の指名</div><strong>' + suit + rank + '</strong><div class="call-warning">' + (discarded ? '捨て札は指名できません' : '自分の手札ならひとり立ち') + '</div></div></div>'
      + '<div class="panel-row">' + ['♣', '♦', '♥', '♠'].map(x => '<button class="suit-choice ' + (x === suit ? 'selected ' : '') + (x === '♥' || x === '♦' ? 'red' : '') + '" data-csuit="' + x + '">' + x + '</button>').join('') + '</div>'
      + '<div class="panel-row call-ranks">' + RANKS.map(x => '<button class="small-action call-rank-choice ' + (x === rank ? 'selected' : '') + '" data-crank="' + x + '">' + x + '</button>').join('') + '</div>'
      + '<div class="panel-row"><button id="online-call" class="small-action" ' + (discarded ? 'disabled' : '') + '>決定</button></div>';
    p.querySelector('#online-call-preview').replaceChildren(cardEl({ suit, rank }, 'call-preview-card'));
    p.querySelectorAll('[data-csuit]').forEach(b => b.onclick = () => { g.onlineSuit = b.dataset.csuit; drawOnlineControls(s); });
    p.querySelectorAll('[data-crank]').forEach(b => b.onclick = () => { g.onlineRank = b.dataset.crank; drawOnlineControls(s); });
    $('online-call').onclick = () => sendGame({ type: 'call', suit, rank });
    return;
  }

  if (s.phase === 'discard' && s.active === g.mySeat) {
    const p = $('call-panel');
    p.classList.remove('hidden');
    p.innerHTML = '<div class="panel-title">手札から2枚を選んで捨ててください</div>'
      + '<div class="panel-row"><span class="micro-copy" id="online-discard-count">' + (g.onlineDiscard?.size || 0) + ' / 2 SELECTED</span>'
      + '<button id="online-discard" class="small-action" ' + (g.onlineDiscard?.size === 2 ? '' : 'disabled') + '>決定</button></div>';
    $('online-discard').onclick = () => sendGame({ type: 'discard', cards: Array.from(g.onlineDiscard || []) });
    return;
  }

  if (s.phase === 'play' && s.active === g.mySeat) {
    const p = $('play-panel');
    p.classList.remove('hidden');
    const card = (g.privateHand || []).find(c => c.id === g.onlineSelectedCard && (g.onlineLegal || []).includes(c.id));
    if (!card) {
      g.onlineSelectedCard = null;
      p.innerHTML = '<div class="panel-title">出すカードを手札から選んでください</div>';
      return;
    }
    p.innerHTML = '<div class="panel-title">このカードを出しますか？</div>'
      + '<div class="play-confirm-preview"><div id="online-play-card"></div><span class="micro-copy">選択中</span></div>'
      + '<div class="play-confirm-actions"><button id="cancel-online-play" class="small-action">選び直す</button>'
      + '<button id="confirm-online-play" class="primary-button">出す</button></div>';
    p.querySelector('#online-play-card').replaceChildren(cardEl(card, 'play-confirm-card'));
    p.querySelector('#cancel-online-play').onclick = () => { g.onlineSelectedCard = null; drawOnlineHand(); drawOnlineControls(s); };
    p.querySelector('#confirm-online-play').onclick = () => {
      const id = g.onlineSelectedCard;
      if (!id || !(g.onlineLegal || []).includes(id)) return;
      g.onlineSelectedCard = null;
      p.innerHTML = '<div class="panel-title">カードを送信中…</div>';
      drawOnlineHand();
      sendGame({ type: 'play', card: id });
    };
    return;
  }
}

// ---------------- 結果表示 ----------------
function showOnlineResult(s) {
  const r = $('result-panel');
  const result = s.result;
  const final = s.phase === 'result';
  const format = n => (n > 0 ? '+' : '') + (Number.isInteger(n) ? n : n.toFixed(1));
  const scores = result.scoreChanges || [];
  r.classList.remove('hidden');
  let content;
  if (final) {
    const rating = result.ratingChanges?.[g.mySeat];
    const rows = s.players.map((p, i) => {
      const change = result.ratingChanges?.[i];
      const roundDelta = Number((result.scoreChanges || []).find(x => x.seat === i)?.delta || 0);
      const rawArt = Number((result.matchArt || [])[i] || 0);
      const delta = change ? format(change.delta) : '—';
      const b = change?.breakdown || {};
      const roundStr = (b.rounds || []).map(rr => (rr.role === 'nap' ? 'N' : rr.role === 'dep' ? 'D' : 'A') + rr.bid + ':' + format(rr.delta)).join(' ');
      return '<div class="round-score-row"><span>' + p.name + ' · ROUND Δ ' + format(roundDelta) + ' · MATCH ' + format((result.matchScores || [])[i] || 0) + ' / ART ' + format(rawArt) + '</span>'
        + '<strong class="' + (change?.delta < 0 ? 'score-down' : 'score-up') + '">' + (s.mode === 'ranked' ? 'RATE Δ ' : '') + delta
        + '<small>順位 ' + (b.rank || '—') + ' · ' + roundStr + '</small></strong></div>';
    }).join('');
    const summary = s.mode === 'ranked' && rating
      ? '<p>NEW RATE ' + rating.rating + ' · Δ ' + format(rating.delta) + '</p>'
      : '<p>MATCH COMPLETE</p>';
    content = '<div class="eyebrow">MATCH COMPLETE</div><h2>RATE BREAKDOWN</h2>' + summary + '<div class="round-score-list">' + rows + '</div><button id="online-home" class="primary-button">BACK TO MENU</button>';
  } else {
    const rows = s.players.map((p, i) => {
      const score = scores.find(x => x.seat === i);
      const role = score?.role === 'ナポレオン' ? 'NAP' : score?.role === '副官' ? 'DEPUTY' : 'ALLY';
      return '<div class="round-score-row"><span>' + p.name + ' · ' + role + '</span>'
        + '<strong>ROUND Δ ' + format(score?.delta || 0) + '<small>TOTAL ' + format((result.matchScores || [])[i] || 0) + '</small></strong></div>';
    }).join('');
    content = '<div class="eyebrow">ROUND ' + String(result.round).padStart(2, '0') + ' · RESULT</div>'
      + '<h2>' + (result.made ? 'NAP TEAM WINS' : 'ALLIANCE WINS') + '</h2>'
      + '<p>BID ' + result.bid + result.suit + ' · POINTS ' + result.points + (result.solo ? ' · SOLO' : '') + '</p>'
      + '<div class="round-score-list"><div class="micro-copy">ROUND SCORE</div>' + rows + '</div>'
      + '<button id="next-online-round" class="primary-button">' + (result.allLastReplay ? 'ALL-LAST AGAIN' : 'NEXT ROUND') + '</button>';
  }
  r.innerHTML = content;
  if (final) $('online-home').onclick = () => { closeOnline(); screen('home-screen'); };
  else $('next-online-round').onclick = () => sendGame({ type: 'next-round' });
}
