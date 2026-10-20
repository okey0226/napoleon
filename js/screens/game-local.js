// ============================================================
// js/screens/game-local.js
// 依存: constants.js, js/core.js, js/ui.js, js/bot.js, js/debug.js, js/api.js
// 役割: COM戦（配札・競り・指名・捨て札・プレイ・結果・レート）
// ============================================================
import { SUITS, RANKS, SV, FACE, POINT, CALIBRATION } from '../../constants.js';
import { $, g, screen, toast, message, name, later, clearTimers, closeOnline, deck, sort, escapeHTML } from '../core.js';
import { phase, cardEl, dialog, announceCall, renderContractInfo, showKittyBacks, showOpenKitty, bidHistoryHTML, drawSeats } from '../ui.js';
import {
  cardValue, legal, cardPower, winning, artfulCard,
  chooseBotCall, soloMinimumBid, finalAuctionRule, computeTeamMinBid, isSoloForced,
  strongestBotSuit, chooseLocalBotCard, chooseLocalDeputyCard
} from '../bot.js';
import { addDebugLog, sanitizeForLog, logPlayDecision, buildPlayContext, addGameLog } from '../debug.js';
import { loadTopStrategy, postAiReport } from '../api.js';

// ---------------- 開始 ----------------
export function startLocal() {
  closeOnline();
  g.matchDebugLog = [];
  addDebugLog('match-start', { botLevel: g.botLevel, aiWeights: sanitizeForLog(g.aiWeights) });
  loadTopStrategy();
  g.localLog = [];
  $('game-log-open').classList.remove('hidden');
  $('game-log-count').textContent = '0';
  g.botLevel = 3;
  g.round = 1;
  g.rate = Number.isFinite(Number(g.account?.rating)) ? Number(g.account.rating) : 1000;
  g.mult = 1;
  g.greenRedraws = 0;
  g.playoff = false;
  g.appealInfo = '';
  g.announcedRound = null;
  g.matchScores = Array(5).fill(0);
  g.matchArt = Array(5).fill(0);
  g.matchContracts = [];
  g.bidHistory = [];
  g.lastTrickWinner = null;
  g.playedCards = [];
  g.voids = [{}, {}, {}, {}, {}];
  g.matchStats = Array.from({ length: 5 }, () => ({
    declarerAttempts: 0, declarerSuccesses: 0,
    exactAttempts: 0, exactSuccesses: 0,
    boldAttempts: 0, boldSuccesses: 0,
    soloAttempts: 0, soloSuccesses: 0,
    deputyAttempts: 0, deputySuccesses: 0,
    artAttempts: 0, dramaticPlays: 0,
    allyFeedAttempts: 0, allyFeedSuccesses: 0, bidTotal: 0
  }));
  g.players = Array.from({ length: 5 }, (_, i) => ({
    name: i ? 'COM ' + i : 'あなた',
    bot: i > 0, hand: [], taken: [], roundTaken: [], roundPoints: 0
  }));
  screen('game-screen');
  $('game-mode-label').textContent = 'COM戦';
  $('rating-caption').textContent = 'SIM RATE';
  $('rating-label').textContent = g.rate;
  roundStart();
}

// ---------------- 配札 ----------------
export function roundStart() {
  clearTimers();
  clearTimeout(g.auction?.humanTimeout);
  g.lastTrickWinner = null;
  g.phase = 'deal';
  g.contract = null;
  g.trick = [];
  g.trickNo = 0;
  g.points = [0, 0, 0, 0, 0];
  g.roundArt = Array(5).fill(0);
  g.playedCards = [];
  g.voids = [{}, {}, {}, {}, {}];
  g.players.forEach(p => { p.roundTaken = []; p.roundPoints = 0; });
  addGameLog('配札');
  $('round-label').textContent = g.round;
  $('auction-panel').classList.add('hidden');
  $('call-panel').classList.add('hidden');
  $('play-panel').classList.add('hidden');
  $('result-panel').classList.add('hidden');
  $('trick-cards').replaceChildren();
  $('kitty-view').replaceChildren();
  $('auction-clock').classList.add('hidden');
  const d = deck();
  g.players.forEach(p => { p.hand = d.splice(0, 10); p.taken = []; sort(p.hand); });
  g.kitty = d.splice(0, 2);
  renderHand();
  drawSeats();
  phase('配札');
  message('手札を確認しています');
  later(checkGreen, 900);
}

function checkGreen() {
  const i = g.players.findIndex(p => !p.hand.some(c => FACE.includes(c.rank)));
  if (i >= 0 && g.greenRedraws < 5) {
    if (i === 0) {
      phase('手札確認');
      message('10・J・Q・K・Aがありません。公開して配り直しますか？');
      $('play-panel').classList.remove('hidden');
      $('play-panel').innerHTML = '<div class="panel-title">手札に10・J・Q・K・Aがありません</div>'
        + '<div class="panel-row"><button class="small-action" id="green-ok">公開して配り直す</button>'
        + '<button class="small-action pass" id="green-skip">続ける</button></div>';
      $('green-ok').onclick = () => greenRedraw('あなた');
      $('green-skip').onclick = () => { $('play-panel').classList.add('hidden'); prepAuction(); };
      return;
    }
    greenRedraw(name(i));
    return;
  }
  prepAuction();
}

function greenRedraw(n) {
  addGameLog(n + 'の手札条件により配り直し');
  g.greenRedraws++;
  g.mult = g.mult >= 4 ? 2 : g.mult + 1;
  $('play-panel').classList.add('hidden');
  const d = $('message-dialog');
  $('dialog-title').textContent = '手札を配り直します';
  $('dialog-body').textContent = n + 'の手札に10・J・Q・K・Aがありません。倍率は' + g.mult + '倍です。';
  $('dialog-ok').onclick = () => { d.close(); roundStart(); };
  d.showModal();
}

// ---------------- 競り前アナウンス ----------------
function announceRound(round) {
  if (g.announcedRound === round || round < 9) return;
  g.announcedRound = round;
  if (round === 9) { dialog('ラス前', '第9局です。次はいよいよオールラストです。'); return; }
  const scores = g.matchScores || Array(5).fill(0);
  const ranked = scores.map((score, seat) => ({ score, seat }))
    .sort((a, b) => b.score - a.score || a.seat - b.seat);
  const lines = ranked.map((e, i) => (i + 1) + '位 ' + name(e.seat) + '  ' + e.score + '点');
  const bottomSeat = ranked[4].seat, fourthSeat = ranked[3].seat;
  const S5 = ranked[4].score, S4 = ranked[3].score;
  const m = Math.max(1, g.mult || 1);
  const caseA = computeTeamMinBid(scores, m, bottomSeat, fourthSeat);
  const caseB = computeTeamMinBid(scores, m, fourthSeat, bottomSeat);
  const caseC = computeTeamMinBid(scores, m, bottomSeat, bottomSeat);
  const caseD = computeTeamMinBid(scores, m, fourthSeat, fourthSeat);
  const caseEraw = soloMinimumBid(S4 - S5, m);
  const caseE = { minBid: Math.min(20, caseEraw), rawMin: caseEraw };
  const fmt = r => {
    if (!r) return '—';
    if (r.soloRequired) return r.soloPossible ? r.soloMinBid + '枚以上（一人立ち）' : '20枚でも不足（一人立ち）';
    if (r.rawMin > 20) return '20枚でも不足（逆転不可）';
    return Math.min(20, r.rawMin) + '枚以上';
  };
  const fmtE = r => r.rawMin > 20 ? '20枚でも不足（逆転不可）' : r.minBid + '枚以上';
  const body = [
    '現在の得点（全員）', lines.join('\n'), '',
    '■ 5位が4位を逆転するための最低立ち（ケース別）', '',
    '【A】5位=ナポレオン / 4位=副官', '  勝った時に5位も4位も3位を超える（4位が勝つインセンティブを保証）', '  → ' + fmt(caseA),
    caseA?.soloRequired ? '  ⚠ 4位が勝っても3位を超えられないため、5位は【一人立ち】が必須です' : '',
    '', '【B】4位=ナポレオン / 5位=副官', '  勝った時に4位も5位も3位を超え、負けた時に5位が4位を逆転', '  → ' + fmt(caseB),
    '', '【C】5位=ナポレオン / 4位=連合軍（副官は別）', '  5位が4位を超えるだけでOK（3位超えは不要）', '  → ' + fmt(caseC),
    '', '【D】4位=ナポレオン / 5位=連合軍', '  ナポレオンが負けると5位が4位を逆転', '  → ' + fmt(caseD),
    '', '【E】5位=ナポレオン（ひとり立ち） / 副官なし（4位以下は全員連合軍）', '  → ' + fmtE(caseE),
    '', '※ アピールで副官が判明しない場合、ゲーム中に指名札が公開された時点で',
    '   上記の該当ケースに合わせて立ちが変更されます。',
    '   立ちが変わった際は画面上部の宣言・卓上メッセージ・局ログに表示されます。',
    '', 'プレーオフ条件：5位が勝利して4位と同点なら再戦'
  ].filter(x => x !== '').join('\n');
  dialog(g.playoff ? 'プレーオフ' : 'オールラスト', body);
}

function prepAuction() {
  g.phase = 'prep';
  announceRound(g.round);
  phase('競り準備');
  let n = 7;
  message('競り開始まで ' + n + ' 秒');
  const tick = () => {
    n--;
    if (n <= 0) { auctionStart(); return; }
    message('競り開始まで ' + n + ' 秒');
    later(tick, 1000);
  };
  later(tick, 1000);
}

// ---------------- 競り ----------------
function scheduleHumanAuctionTimeout() {
  const auction = g.auction;
  clearTimeout(auction.humanTimeout);
  auction.humanTimeout = setTimeout(() => {
    if (g.phase === 'auction' && g.auction === auction) humanApprove(true);
  }, 30000);
}
function auctionActivity() {
  if (g.phase !== 'auction' || !g.auction) return;
  g.auction.autoApprove[0] = false;
  scheduleHumanAuctionTimeout();
}
function appealDetails(hand) {
  const targets = [['♣J', '♣J'], ['♦J', '♦J'], ['♥J', '♥J'], ['♠J', '♠J'], ['マイティ（♠A）', '♠A']];
  return targets.map(([label, id]) => label + '：' + (hand.some(c => c.id === id) ? 'あり' : 'なし')).join(' · ');
}

function enterAuction() {
  g.phase = 'auction';
  phase('競り');
  message(g.auction.requiredBidSeat === null
    ? '順番なし。宣言するか、承認して競りを降りてください'
    : name(g.auction.requiredBidSeat) + 'が申告せず立つ選択。最低枚数以上で宣言してください');
  $('auction-panel').classList.remove('hidden');
  $('auction-clock').classList.add('hidden');
  scheduleHumanAuctionTimeout();
  drawAuction();
  drawSeats();
  scheduleComBids();
}

function drawAppealOffer() {
  const p = $('auction-panel');
  p.classList.remove('hidden');
  p.innerHTML = '<div class="panel-title">オーラス・アピール</div>'
    + '<div class="micro-copy">4位にJ・マイティの所持を尋ねますか？</div>'
    + '<div class="panel-row"><button class="small-action" id="appeal-yes">アピールする</button>'
    + '<button class="small-action pass" id="appeal-no">競りへ進む</button></div>';
  p.querySelector('#appeal-yes').onclick = () => answerLocalAppeal('appeal');
  p.querySelector('#appeal-no').onclick = () => answerLocalAppeal('skip');
}
function drawAppealResponse() {
  const p = $('auction-panel');
  p.classList.remove('hidden');
  p.innerHTML = '<div class="panel-title">5位からアピール</div>'
    + '<div class="micro-copy">所持するJ・マイティを申告するか、申告せず立つか選んでください。</div>'
    + '<div class="panel-row"><button class="small-action" id="appeal-disclose">札を申告する</button>'
    + '<button class="small-action pass" id="appeal-stand">申告せず立つ</button></div>';
  p.querySelector('#appeal-disclose').onclick = () => answerLocalAppeal('disclose');
  p.querySelector('#appeal-stand').onclick = () => answerLocalAppeal('stand');
}
function answerLocalAppeal(choice) {
  const rule = finalAuctionRule(g.matchScores, g.mult);
  const fourth = rule.fourthSeat;
  if (choice === 'skip') { g.appealInfo = '5位はアピールせず競りへ'; enterAuction(); return; }
  if (choice === 'appeal') {
    if (fourth === 0) { g.phase = 'appeal-response'; phase('アピール回答'); message('4位は所持するJ・マイティを申告するか、申告せず立ちます'); drawAppealResponse(); return; }
    g.appealInfo = '4位の申告：' + appealDetails(g.players[fourth].hand);
    enterAuction();
    return;
  }
  if (choice === 'stand') { g.auction.requiredBidSeat = fourth; g.appealInfo = '4位は申告せず立つことを選択'; enterAuction(); return; }
  g.appealInfo = '4位の申告：' + appealDetails(g.players[fourth].hand);
  enterAuction();
}

function auctionStart() {
  addGameLog('競り開始');
  g.suit = '♠';
  showOpenKitty();
  g.appealInfo = '';
  const rule = g.round >= 10 ? finalAuctionRule(g.matchScores, g.mult) : null;
  g.auction = {
    active: rule ? rule.eligible : [0, 1, 2, 3, 4],
    minBid: rule?.minBid || 13,
    high: { num: 12, suit: '', player: -1 },
    version: 0,
    autoApprove: Array(5).fill(false),
    botBids: Array(5).fill(0),
    botSeen: Array(5).fill(-1),
    requiredBidSeat: null
  };
  g.bid = g.auction.minBid;
  g.active = -1;
  if (!rule) { enterAuction(); return; }
  const bottom = rule.bottomSeat, fourth = rule.fourthSeat;
  if (bottom === 0) { g.phase = 'appeal-offer'; phase('アピール'); message('5位は4位にJ・マイティの所持を尋ねられます'); drawAppealOffer(); return; }
  if (fourth === 0) { g.phase = 'appeal-response'; phase('アピール回答'); g.appealInfo = '5位からのアピール'; message('5位がアピールしました。所持する札を申告するか、申告せず立つか選んでください'); drawAppealResponse(); return; }
  g.appealInfo = '4位の申告：' + appealDetails(g.players[fourth].hand);
  enterAuction();
}

function drawAuction() {
  renderContractInfo();
  const h = g.auction.high;
  const t = h.num < 13 ? 'なし' : name(h.player) + ' · ' + h.num + h.suit;
  const p = $('auction-panel');
  const ruleNote = g.round >= 10 ? '<div class="micro-copy">オールラスト · 最低宣言 ' + g.auction.minBid + ' · 得点2倍 · 立ち必須</div>' : '';
  const historyPanel = bidHistoryHTML(g.bidHistory, i => name(i));
  const appealPanel = g.appealInfo ? '<div class="appeal-info">' + escapeHTML(g.appealInfo) + '</div>' : '';
  p.classList.remove('hidden');
  if (g.auction.requiredBidSeat !== null && g.auction.requiredBidSeat !== 0) {
    p.innerHTML = '<div class="panel-title">4位が申告せず立ちを選択</div><div class="micro-copy">4位の宣言を待っています</div>' + appealPanel + historyPanel;
    return;
  }
  if (!g.auction.active.includes(0)) {
    p.innerHTML = '<div class="panel-title">現在の宣言　<strong>' + t + '</strong></div><div class="micro-copy">承認済み</div>' + ruleNote + appealPanel + historyPanel;
    return;
  }
  p.innerHTML = '<div class="panel-title">現在の宣言　<strong>' + t + '</strong></div>' + ruleNote + appealPanel
    + '<div class="panel-row">' + SUITS.map(s => '<button class="suit-choice ' + (s === '♥' || s === '♦' ? 'red' : '') + ' ' + (g.suit === s ? 'selected' : '') + '" data-suit="' + s + '">' + s + '</button>').join('')
    + '<button class="suit-choice ' + (g.suit === 'NT' ? 'selected' : '') + '" data-suit="NT">NT</button></div>'
    + '<div class="panel-row"><button class="small-action" id="bid-minus">−</button><span class="bid-number">' + g.bid + '</span><button class="small-action" id="bid-plus">＋</button></div>'
    + '<div class="panel-row"><button class="small-action pass" id="bid-approve" '
    + (g.auction.high.player === 0 && g.auction.active.length > 1 || g.round >= 10 && g.auction.high.num < 13 ? 'disabled' : '')
    + '>承認</button><button class="small-action" id="bid-submit">宣言する</button></div>'
    + historyPanel;
  document.querySelectorAll('[data-suit]').forEach(b => b.onclick = () => { auctionActivity(); g.suit = b.dataset.suit; drawAuction(); });
  $('bid-plus').onclick = () => { auctionActivity(); g.bid = Math.min(20, g.bid + 1); drawAuction(); };
  $('bid-minus').onclick = () => { auctionActivity(); g.bid = Math.max(g.auction.minBid, g.bid - 1); drawAuction(); };
  $('bid-approve').onclick = () => humanApprove();
  $('bid-submit').onclick = humanBid;
}

function beatsBid(n, s) {
  const h = g.auction.high;
  return (n >= g.auction.minBid && n > h.num) || (n === h.num && n >= 13 && SV[s] > SV[h.suit]);
}
function removeBid(i) { g.auction.active = g.auction.active.filter(x => x !== i); }
function scheduleComBids() {
  if (g.phase !== 'auction') return;
  const version = g.auction.version;
  for (let i = 1; i < 5; i++) {
    if (g.auction.active.includes(i) && g.auction.botSeen[i] < version) {
      later(() => comBid(i, version), 500 + Math.random() * 1800);
    }
  }
}

function humanApprove(forced = false) {
  if (g.phase !== 'auction' || !g.auction || !g.auction.active.includes(0)) return;
  if (!g.auction.active.length) { auctionEnd(-1); return; }
  if (g.round >= 10 && g.auction.high.num < 13) {
    if (forced && (g.auction.requiredBidSeat ?? g.auction.active[0]) === 0) {
      g.bid = g.auction.minBid;
      g.suit = strongestBotSuit(g.players[0].hand);
      humanBid();
    }
    return;
  }
  if (!forced) auctionActivity();
  if (g.auction.high.player === 0) {
    if (g.auction.active.length === 1) auctionEnd(0);
    else if (forced) { g.auction.autoApprove[0] = true; message('30秒操作がなかったため、宣言者は自動承認待ちです'); }
    return;
  }
  removeBid(0);
  addGameLog(forced ? 'あなたが自動承認' : 'あなたが承認');
  message(forced ? '30秒操作がなかったため、自動で承認しました' : 'あなたは承認しました');
  if (!g.auction.active.length) { auctionEnd(-1); return; }
  if (g.auction.active.length === 1 && g.auction.high.player === g.auction.active[0]) {
    const last = g.auction.active[0];
    if (g.auction.autoApprove[last]) { auctionEnd(last); return; }
    message(name(last) + '以外は承認しました。さらに宣言するか、承認して確定してください');
  }
  g.auction.active.filter(i => i > 0).forEach(i => g.auction.botSeen[i] = g.auction.version - 1);
  drawAuction();
  drawSeats();
  scheduleComBids();
}

function humanBid() {
  if (g.phase !== 'auction' || !g.auction.active.includes(0)
    || (g.auction.requiredBidSeat !== null && g.auction.requiredBidSeat !== 0)) return;
  auctionActivity();
  if (!beatsBid(g.bid, g.suit)) { toast('現在の宣言より強い宣言を選んでください'); return; }
  g.bidHistory.push({ round: g.round, seat: 0, num: g.bid, suit: g.suit });
  addGameLog('あなたが' + g.bid + g.suit + 'を宣言');
  if (g.bidHistory.length > 50) g.bidHistory.shift();
  g.auction.high = { num: g.bid, suit: g.suit, player: 0 };
  if (g.auction.requiredBidSeat === 0) g.auction.requiredBidSeat = null;
  g.auction.version++;
  g.active = 0;
  g.bid = g.auction.high.num;
  g.suit = g.auction.high.suit;
  message('あなたが' + g.bid + g.suit + 'を宣言しました');
  if (g.bid === 20 && g.suit === 'NT') { auctionEnd(0); return; }
  drawAuction();
  drawSeats();
  scheduleComBids();
}

function comBid(i, version) {
  if (g.phase !== 'auction' || version !== g.auction.version || !g.auction.active.includes(i)
    || g.auction.botSeen[i] >= version
    || (g.auction.requiredBidSeat !== null && g.auction.requiredBidSeat !== i)) return;
  g.auction.botSeen[i] = version;
  const level = g.botLevel || 3;
  const h = g.players[i].hand;
  const strength = h.reduce((n, c) =>
    n + (RANKS.indexOf(c.rank) > 9 ? 1.25 : RANKS.indexOf(c.rank) > 7 ? .45 : 0)
    + (c.rank === 'A' ? .35 : 0), 0)
    + (function () {
      const w = { 10: 1, J: 1.8, Q: 2.6, K: 3.5, A: 4.7 };
      const cards = h.filter(c => c.suit === strongestBotSuit(h));
      return cards.reduce((n, c) => n + (w[c.rank] || 0), 0) + Math.max(0, cards.length - 3) * .75;
    })() * .3;
  const high = g.auction.high;
  let b = null;
  const openingChance = [.5, 1, 1][level - 1];
  const raiseChance = [.4, .95, 1][level - 1];
  const minStrength = [Math.max(1.0, g.aiWeights.bidThreshold + 0.2), Math.max(1.0, g.aiWeights.bidThreshold - 2.2), Math.max(1.0, g.aiWeights.bidThreshold - 3.0)][level - 1];
  const divisor = [2.8, 1.7, 1.3][level - 1];
  const cap = 13 + Math.min(level === 1 ? 3 : level === 2 ? 8 : 9, Math.floor(strength / divisor));
  const bestSuit = strongestBotSuit(h);
  const hasMighty = h.some(c => c.id === '♠A');
  const hasTrumpJ = h.some(c => c.rank === 'J' && c.suit === bestSuit);
  const partnerIsNapoleon = i === g.contract?.deputy;
  if (partnerIsNapoleon && high.num >= 13) return doApprove(i, version);
  if (g.auction.botBids[i] < 2 && high.num < 13 && strength > minStrength && cap >= g.auction.minBid && Math.random() < openingChance) {
    b = { num: Math.max(g.auction.minBid, 13 + Math.min(level === 1 ? 1 : level === 2 ? 3 : 6, Math.max(0, Math.floor((strength - 2) / 1.7)))), suit: level === 1 ? SUITS[Math.floor(Math.random() * 4)] : bestSuit };
  } else if (g.auction.botBids[i] < 2 && high.num >= 13 && high.num < cap && Math.random() < raiseChance) {
    const suits = SUITS.filter(s => SV[s] > SV[high.suit]).sort((a, b) => {
      const w = { 10: 1, J: 1.8, Q: 2.6, K: 3.5, A: 4.7 };
      const va = h.filter(c => c.suit === b).reduce((n, c) => n + (w[c.rank] || 0), 0);
      const vb = h.filter(c => c.suit === a).reduce((n, c) => n + (w[c.rank] || 0), 0);
      return va - vb;
    });
    if (suits.length && (hasMighty || hasTrumpJ || strength > 5)) b = { num: high.num, suit: suits[0] };
    else if (high.num + 1 <= cap) b = { num: high.num + 1, suit: bestSuit };
  }
  if (b && g.auction.high.num < 13) b.num = Math.max(g.auction.minBid, b.num);
  if (g.auction.requiredBidSeat === i || (g.round >= 10 && high.num < 13 && g.auction.active[0] === i)) {
    b = { num: g.auction.minBid, suit: bestSuit };
  }
  if (b) b.num = Math.max(g.auction.minBid, b.num);
  if (b && beatsBid(b.num, b.suit)) {
    g.bidHistory.push({ round: g.round, seat: i, num: b.num, suit: b.suit });
    addGameLog(name(i) + 'が' + b.num + b.suit + 'を宣言');
    if (g.bidHistory.length > 50) g.bidHistory.shift();
    g.auction.botBids[i]++;
    g.auction.high = { ...b, player: i };
    if (g.auction.requiredBidSeat === i) g.auction.requiredBidSeat = null;
    g.auction.version++;
    g.active = i;
    if (g.auction.autoApprove[0] && g.auction.active.includes(0)) { humanApprove(true); return; }
    message(name(i) + 'が' + b.num + b.suit + 'を宣言しました');
    if (b.num === 20 && b.suit === 'NT') { auctionEnd(i); return; }
    drawAuction();
    drawSeats();
    scheduleComBids();
    return;
  }
  if (g.auction.high.player === i) {
    if (g.auction.active.length === 1) auctionEnd(i);
    return;
  }
  removeBid(i);
  addGameLog(name(i) + 'が承認');
  message(name(i) + 'は承認しました');
  if (!g.auction.active.length) { auctionEnd(-1); return; }
  if (g.auction.active.length === 1 && g.auction.high.player === g.auction.active[0]) {
    const last = g.auction.active[0];
    if (g.auction.autoApprove[last]) { auctionEnd(last); return; }
    message(name(last) + '以外は承認しました。さらに宣言するか、承認して確定してください');
  }
  g.auction.active.filter(j => j > 0).forEach(j => g.auction.botSeen[j] = g.auction.version - 1);
  drawAuction();
  drawSeats();
  scheduleComBids();
}

function doApprove(i, version) {
  if (!g.auction.active.includes(i)) return;
  if (g.auction.high.player === i) { if (g.auction.active.length === 1) auctionEnd(i); return; }
  removeBid(i);
  addGameLog(name(i) + 'が承認');
  message(name(i) + 'は承認しました');
  if (!g.auction.active.length) { auctionEnd(-1); return; }
  g.auction.active.filter(j => j > 0).forEach(j => g.auction.botSeen[j] = g.auction.version - 1);
  drawAuction();
  drawSeats();
  scheduleComBids();
}

function auctionEnd(w) {
  clearTimeout(g.auction?.humanTimeout);
  $('auction-panel').classList.add('hidden');
  showKittyBacks();
  $('auction-clock').classList.add('hidden');
  if (w < 0 || g.auction.high.num < 13) {
    if (g.round >= 10) {
      w = finalAuctionRule(g.matchScores, g.mult).bottomSeat;
      g.auction.high = { num: g.auction.minBid, suit: strongestBotSuit(g.players[w].hand), player: w };
    } else {
      dialog('流局', '宣言がありませんでした。配り直します。', roundStart);
      return;
    }
  }
  g.contract = { nap: w, num: g.auction.high.num, suit: g.auction.high.suit, deputy: -1, solo: false, revealTrickNo: null };
  addDebugLog('contract-set', { nap: w, num: g.contract.num, suit: g.contract.suit, highBid: g.auction.high, bidHistory: sanitizeForLog(g.bidHistory) });
  addGameLog(name(w) + 'が' + g.contract.num + g.contract.suit + 'で宣言を確定');
  phase('浮き札の交換');
  message(name(w) + 'が' + g.contract.num + g.contract.suit + 'で宣言。オープンを手札に入れて2枚捨ててください');
  kittyStart();
}

// ---------------- 浮き札・指名 ----------------
function kittyStart() {
  const n = g.contract.nap;
  $('kitty-view').replaceChildren();
  g.players[n].hand.push(...g.kitty);
  sort(g.players[n].hand);
  g.phase = 'discard';
  phase('浮き札の交換');
  if (n === 0) {
    g.discard = new Set();
    $('call-panel').classList.remove('hidden');
    $('call-panel').innerHTML = '<div class="panel-title">手札から2枚を選んで捨ててください</div>'
      + '<div class="panel-row"><span class="micro-copy" id="discard-count">0 / 2 SELECTED</span>'
      + '<button class="small-action" id="discard-ok" disabled>決定</button></div>';
    renderHand(true);
    $('discard-ok').onclick = () => {
      if (g.discard.size !== 2) return;
      g.kitty = g.players[0].hand.filter(c => g.discard.has(c.id));
      const kittyPoints = g.kitty.filter(c => POINT.includes(c.rank));
      g.points[g.contract.nap] += kittyPoints.length;
      g.players[g.contract.nap].taken.push(...kittyPoints);
      g.players[0].hand = g.players[0].hand.filter(c => !g.discard.has(c.id));
      sort(g.players[0].hand);
      $('game-screen').classList.remove('discarding');
      $('hand').classList.remove('discard-mode');
      $('call-panel').classList.add('hidden');
      callUi();
    };
    return;
  }
  const discardPool = g.players[n].hand.slice();
  discardPool.sort((a, b) => cardValue(a) - cardValue(b));
  const drop = discardPool.slice(0, 2);
  g.players[n].hand = g.players[n].hand.filter(c => !drop.includes(c));
  g.kitty = drop;
  const kittyPoints = drop.filter(c => POINT.includes(c.rank));
  g.points[n] += kittyPoints.length;
  g.players[n].taken.push(...kittyPoints);
  sort(g.players[n].hand);
  const forceSolo = isSoloForced();
  if (forceSolo) {
    const hand = g.players[n].hand;
    const chosen = hand.slice().sort((a, b) => cardValue(a) - cardValue(b))[0];
    g.contract.call = { suit: chosen.suit, rank: chosen.rank, id: chosen.id };
    g.contract.solo = true;
    addGameLog(name(n) + 'が副官指名 ' + g.contract.call.id + '（ひとり立ち・強制）');
  } else {
    g.contract.call = chooseBotCall(g.players[n].hand, g.kitty, g.contract.suit, g.botLevel, g.contract.num);
    g.contract.solo = g.players[n].hand.some(c => c.id === g.contract.call.id);
    addGameLog(name(n) + 'が副官指名 ' + g.contract.call.id + (g.contract.solo ? '（ひとり立ち）' : ''));
  }
  g.contract.revealedCall = false;
  g.kitty = [];
  later(() => announceCall(g.contract.call, playStart), 700);
}

function callUi() {
  g.phase = 'call';
  phase('副官指名');
  const forceSolo = isSoloForced();
  message(forceSolo ? '⚠ Case A破綻：一人立ちが必須です。自分の手札から指名札を選んでください' : '捨て札を決めました。副官に指名するカードを選んでください');
  const p = $('call-panel');
  p.classList.remove('hidden');
  let s = '♠', r = 'A';
  p.innerHTML = '<div class="panel-title">' + (forceSolo ? '⚠ 一人立ち（指名札）' : '副官に指名するカード') + '</div>'
    + '<div class="call-card-preview"><div id="call-preview"></div><div><div class="micro-copy">' + (forceSolo ? '一人立ち札' : '今回の指名') + '</div><strong id="call-val">♠A</strong><div id="call-warning" class="call-warning"></div></div></div>'
    + '<div class="panel-row">' + SUITS.map(x => '<button class="suit-choice ' + (x === '♥' || x === '♦' ? 'red' : '') + '" data-cs="' + x + '">' + x + '</button>').join('') + '</div>'
    + '<div class="panel-row call-ranks">' + RANKS.map(x => '<button class="small-action call-rank-choice" data-cr="' + x + '">' + x + '</button>').join('') + '</div>'
    + '<div class="panel-row"><span class="micro-copy">' + (forceSolo ? '自分の手札のカードのみ指名可能' : '自分の手札にある札を選ぶと、ひとり立ちになります') + '</span><button class="small-action" id="call-ok">決定</button></div>';
  const ownCards = new Set((g.players[g.contract.nap]?.hand || []).map(c => c.id));
  const update = () => {
    p.querySelectorAll('[data-cs]').forEach(b => b.classList.toggle('selected', b.dataset.cs === s));
    p.querySelectorAll('[data-cr]').forEach(b => b.classList.toggle('selected', b.dataset.cr === r));
    $('call-val').textContent = s + r;
    $('call-preview').replaceChildren(cardEl({ suit: s, rank: r }, 'call-preview-card'));
    const discarded = g.kitty.some(c => c.suit === s && c.rank === r);
    const isOwn = ownCards.has(s + r);
    if (forceSolo) {
      $('call-warning').textContent = !isOwn ? '⚠ 自分の手札のカードを選んでください' : '';
      $('call-ok').disabled = !isOwn || discarded;
    } else {
      $('call-warning').textContent = discarded ? '捨て札は指名できません' : '';
      $('call-ok').disabled = discarded;
    }
  };
  p.querySelectorAll('[data-cs]').forEach(b => b.onclick = () => { s = b.dataset.cs; update(); });
  p.querySelectorAll('[data-cr]').forEach(b => b.onclick = () => { r = b.dataset.cr; update(); });
  $('call-ok').onclick = () => {
    if (g.kitty.some(c => c.suit === s && c.rank === r)) return;
    if (forceSolo && !ownCards.has(s + r)) return;
    g.contract.call = { suit: s, rank: r, id: s + r };
    g.contract.solo = g.players[0].hand.some(c => c.suit === s && c.rank === r);
    if (forceSolo && !g.contract.solo) return;
    addGameLog('副官指名 ' + s + r + (g.contract.solo ? '（ひとり立ち' + (forceSolo ? '・強制' : '') + '）' : ''));
    g.contract.revealedCall = false;
    g.kitty = [];
    renderContractInfo();
    message(s + r + 'を指名しました' + (forceSolo ? '（一人立ち強制）' : ''));
    p.classList.add('hidden');
    announceCall(g.contract.call, playStart);
  };
  update();
}

// ---------------- プレイ開始 ----------------
function playStart() {
  g.selectedCard = null;
  g.lastTrickWinner = null;
  g.phase = 'play';
  const c = g.contract;
  if (c.solo) c.deputy = c.nap;
  else {
    g.contract.deputy = g.players.findIndex(p => p.hand.some(x => x.suit === c.call.suit && x.rank === c.call.rank));
    if (g.contract.deputy < 0) g.contract.deputy = c.nap;
  }
  g.contract.revealedCall = false;
  g.contract.revealTrickNo = null;
  g.active = c.nap;
  g.trickNo = 0;
  g.trick = [];
  addGameLog(name(c.nap) + 'が先攻');
  phase('カードプレイ');
  message(name(c.nap) + 'が先攻です');
  $('call-panel').classList.add('hidden');
  $('kitty-view').replaceChildren();
  renderHand();
  drawSeats();
  playTurn();
}

// ---------------- 手札描画 ----------------
function renderHand(discard = false) {
  const box = $('hand');
  box.classList.toggle('discard-mode', discard);
  $('game-screen').classList.toggle('discarding', discard);
  box.replaceChildren();
  (g.players[0]?.hand || []).forEach(c => {
    const e = cardEl(c, discard ? 'playable' : '');
    if (discard) {
      const protectedCall = g.contract?.solo && g.contract.call?.id === c.id;
      e.classList.toggle('protected', protectedCall);
      e.classList.toggle('selected', g.discard.has(c.id));
      e.setAttribute('aria-pressed', String(g.discard.has(c.id)));
      e.onclick = () => {
        if (protectedCall) { toast('指名札は捨てられません'); return; }
        if (g.discard.has(c.id)) g.discard.delete(c.id);
        else if (g.discard.size < 2) g.discard.add(c.id);
        const selected = g.discard.has(c.id);
        e.classList.toggle('selected', selected);
        e.setAttribute('aria-pressed', String(selected));
        $('discard-count').textContent = g.discard.size + ' / 2枚選択';
        $('discard-ok').disabled = g.discard.size !== 2;
      };
    } else if (g.phase === 'play' && g.active === 0) {
      const ok = legal(0).some(x => x.id === c.id);
      e.classList.toggle('playable', ok);
      e.classList.toggle('selected', g.selectedCard === c.id);
      if (ok) e.onclick = () => { g.selectedCard = g.selectedCard === c.id ? null : c.id; renderHand(); drawLocalPlayControls(); };
    }
    box.append(e);
  });
  $('hand-count').textContent = (g.players[0]?.hand.length || 0) + '枚';
}

function drawLocalPlayControls() {
  const p = $('play-panel');
  if (g.phase !== 'play' || g.active !== 0) { p.classList.add('hidden'); return; }
  const card = g.players[0].hand.find(c => c.id === g.selectedCard && legal(0).some(x => x.id === c.id));
  if (!card) {
    g.selectedCard = null;
    p.classList.remove('hidden');
    p.innerHTML = '<div class="panel-title">出すカードを手札から選んでください</div>';
    return;
  }
  p.classList.remove('hidden');
  p.innerHTML = '<div class="panel-title">このカードを出しますか？</div>'
    + '<div class="play-confirm-preview"><div id="local-play-card"></div><span class="micro-copy">選択中</span></div>'
    + '<div class="play-confirm-actions"><button id="cancel-local-play" class="small-action">選び直す</button>'
    + '<button id="confirm-local-play" class="primary-button">出す</button></div>';
  p.querySelector('#local-play-card').replaceChildren(cardEl(card, 'play-confirm-card'));
  p.querySelector('#cancel-local-play').onclick = () => { g.selectedCard = null; renderHand(); drawLocalPlayControls(); };
  p.querySelector('#confirm-local-play').onclick = () => {
    const chosen = card;
    g.selectedCard = null;
    p.classList.add('hidden');
    play(0, chosen);
  };
}

// ---------------- 手番 ----------------
function playTurn() {
  if (g.phase !== 'play') return;
  drawSeats();
  renderHand();
  if (g.active === 0) {
    message(g.trick.length ? 'あなたの番です。場札のマークに続けてください。' : 'あなたが先攻です。カードを出してください。');
    drawLocalPlayControls();
    return;
  }
  message(name(g.active) + 'がカードを選んでいます');
  later(() => {
    try {
      if (g.phase !== 'play') return;
      const seat = g.active;
      const result = chooseLocalBotCard(seat);
      const chosen = result?.card;
      const legalCardsList = legal(seat);
      if (chosen && legalCardsList.some(x => x.id === chosen.id)) {
        logPlayDecision(seat, chosen, result, buildPlayContext(seat));
        play(seat, chosen);
      } else if (legalCardsList.length) {
        const fallback = legalCardsList[Math.floor(Math.random() * legalCardsList.length)];
        addDebugLog('play-fallback-random', { seat, expected: chosen?.id || null, result, fallback: fallback.id, legalIds: legalCardsList.map(x => x.id), context: sanitizeForLog(buildPlayContext(seat)) });
        play(seat, fallback);
      } else {
        addDebugLog('play-no-legal', { seat, context: sanitizeForLog(buildPlayContext(seat)) });
        g.active = (seat + 4) % 5;
        playTurn();
      }
    } catch (e) {
      console.error('Bot Error:', e);
      const errSeat = g.active;
      addDebugLog('bot-error', { seat: errSeat, message: e?.message, stack: e?.stack, phase: g.phase, round: g.round, trickNo: g.trickNo, context: sanitizeForLog(buildPlayContext(errSeat)) });
      const errMsg = e && e.message ? e.message : String(e);
      addGameLog('⚠️ COM思考エラー: ' + errMsg + ' → ランダムなカードを出しました');
      const l = legal(errSeat);
      if (l.length) {
        const random = l[Math.floor(Math.random() * l.length)];
        addDebugLog('bot-error-fallback-random', { seat: errSeat, fallback: random.id, legalIds: l.map(x => x.id) });
        play(errSeat, random);
      } else {
        g.active = (errSeat + 4) % 5;
        playTurn();
      }
    }
  }, 650 + Math.random() * 550);
}

function play(i, c) {
  if (g.phase !== 'play' || g.active !== i || !legal(i).some(x => x.id === c.id)) return;
  if (!g.trick.length) g.lastTrickWinner = null;
  const previous = g.trick.length ? winning() : null;
  g.selectedCard = null;
  $('play-panel').classList.add('hidden');
  const h = g.players[i].hand;
  h.splice(h.findIndex(x => x.id === c.id), 1);
  g.trick.push({ player: i, card: c });
  g.playedCards.push({ suit: c.suit, rank: c.rank, id: c.id, seat: i });
  if (g.trick.length > 1) {
    const ledSuit = g.trick[0].card.suit;
    if (c.suit !== ledSuit) {
      if (!g.voids[i]) g.voids[i] = {};
      g.voids[i][ledSuit] = true;
    }
  }
  if (artfulCard({ player: i, card: c }, g.trick)) {
    g.matchStats[i].artAttempts = (g.matchStats[i].artAttempts || 0) + 1;
  }
  const reveal = g.contract.call?.id === c.id && !g.contract.revealedCall;
  addGameLog(name(i) + 'が' + c.id + 'を出した' + (reveal ? '（指名札）' : ''));
  if (reveal) {
    g.contract.revealedCall = true;
    g.contract.revealTrickNo = g.trickNo;
    addGameLog('指名札公開、副官は' + name(g.contract.deputy));
    if (g.round >= 10 && !g.contract.solo) {
      const r = computeTeamMinBid(g.matchScores, g.mult, g.contract.nap, g.contract.deputy);
      if (r !== null) {
        const oldBid = g.contract.num, forcedMin = r.minBid;
        const caseLabel = { A: '5位=ナポレオン / 4位=副官', B: '4位=ナポレオン / 5位=副官', C: '5位=ナポレオン / 4位=連合軍', D: '4位=ナポレオン / 5位=連合軍' }[r.case];
        if (forcedMin > oldBid) {
          g.contract.num = forcedMin;
          renderContractInfo();
          drawSeats();
          toast('副官判明：最低立ち条件が変わりました。立ちを ' + oldBid + '枚 → ' + forcedMin + '枚 に引き上げます（' + caseLabel + '）');
          addGameLog('★副官判明による立ち変更：' + oldBid + '枚 → ' + forcedMin + '枚（' + caseLabel + '）');
          message('副官が判明したため、最低立ち条件に合わせて立ちを ' + forcedMin + '枚へ引き上げました');
        } else {
          addGameLog('副官判明：現在の立ち ' + oldBid + '枚は最低条件 ' + forcedMin + '枚を満たしています（' + caseLabel + '）');
          toast('副官判明：立ち ' + oldBid + '枚は最低条件を満たしています（' + caseLabel + '）');
        }
        if (r.incentiveBroken) {
          const warnMsg = '⚠ 20枚でも4位が3位を超えられません。副官に勝つインセンティブがなく、わざと負ける行動が最適になります';
          toast(warnMsg);
          addGameLog('⚠ ' + warnMsg + '（' + caseLabel + '）');
          message(warnMsg);
        }
      }
    }
  }
  if (previous && g.contract.revealedCall) {
    const team = seat => (seat === g.contract.nap || seat === g.contract.deputy) ? 'nap' : 'alliance';
    if (team(i) === team(previous.player) && winning().player === i) g.roundArt[i]--;
  }
  $('trick-cards').append(cardEl(c, 'trick-card played-seat-' + i));
  if (g.trick.length < 5) { g.active = (i + 4) % 5; playTurn(); return; }
  addDebugLog('trick-end', {
    trickNo: g.trickNo, winner: winning().player,
    cards: g.trick.map(x => ({ seat: x.player, card: x.card.id })),
    roundPoints: g.players.map(p => p.roundPoints || 0),
    roundArt: g.roundArt.slice(), scores: g.matchScores.slice()
  });
  g.phase = 'trick-end';
  const winningEntry = winning(), w = winningEntry.player;
  const taken = g.trick.filter(e => POINT.includes(e.card.rank)).map(e => e.card);
  if (taken.length >= 3 && artfulCard(winningEntry, g.trick)) {
    g.matchStats[w].dramaticPlays = (g.matchStats[w].dramaticPlays || 0) + 1;
    if (g.roundArt[w] < 2) g.roundArt[w]++;
  }
  g.points[w] += taken.length;
  g.players[w].taken.push(...taken);
  g.players[w].roundTaken.push(...taken);
  g.players[w].roundPoints = (g.players[w].roundPoints || 0) + taken.length;
  if (!g.contract.solo && g.contract.deputy >= 0 && g.contract.deputy !== g.contract.nap) {
    const deputyEntry = g.trick.find(e => e.player === g.contract.deputy);
    if (deputyEntry && POINT.includes(deputyEntry.card.rank)) {
      g.matchStats[g.contract.deputy].allyFeedAttempts = (g.matchStats[g.contract.deputy].allyFeedAttempts || 0) + 1;
      if (w === g.contract.nap || w === g.contract.deputy) {
        g.matchStats[g.contract.deputy].allyFeedSuccesses = (g.matchStats[g.contract.deputy].allyFeedSuccesses || 0) + 1;
      }
    }
  }
  addGameLog(name(w) + 'が第' + (g.trickNo + 1) + '勝負を獲得（' + taken.length + '点札）');
  g.lastTrickWinner = w;
  g.active = w;
  const alliancePoints = g.points.reduce((n, points, i) => n + ((i !== g.contract.nap && (g.contract.solo || i !== g.contract.deputy)) ? points : 0), 0);
  const napPoints = g.points.reduce((n, points, i) => n + ((i === g.contract.nap || (!g.contract.solo && i === g.contract.deputy)) ? points : 0), 0);
  if (alliancePoints > 20 - g.contract.num || (napPoints >= g.contract.num && (g.contract.num === 20 || alliancePoints >= 1))) { finishGame(); return; }
  message(name(w) + 'が場札を取りました');
  drawSeats();
  later(() => {
    g.trickNo++;
    if (g.trickNo >= 10) { finishGame(); return; }
    g.trick = [];
    $('trick-cards').replaceChildren();
    g.phase = 'play';
    message(name(w) + 'から次の勝負');
    playTurn();
  }, 1250);
}

// ---------------- 結果 ----------------
function finalRatingDeltas(scores, art, ratings, matchStats, contracts) {
  const meanArt = art.reduce((n, x) => n + x, 0) / 5;
  const cs = contracts || [];
  return scores.map((score, seat) => {
    let delta = 0;
    const rounds = [];
    for (const c of cs) {
      const p = CALIBRATION[Math.min(20, Math.max(13, c.num))] ?? 0.5;
      const diff = c.num - 12;
      const actual = c.napWin ? 1 : 0;
      let roundDelta = 0, role = 'ally';
      if (seat === c.nap) {
        role = 'nap';
        roundDelta = (actual - p) * diff * 8;
        if (c.napWin && c.points > c.num) roundDelta -= (c.points - c.num) * 0.3;
        if (c.solo) roundDelta *= 1.5;
      } else if (!c.solo && seat === c.deputy) {
        role = 'dep';
        roundDelta = (actual - p) * diff * 3.2;
        if (c.napWin && c.revealTrickNo != null) roundDelta += Math.max(0, c.revealTrickNo - 3) * 0.3;
      } else {
        role = 'ally';
        const pts = (c.takenPoints && c.takenPoints[seat]) || 0;
        roundDelta = (pts - 4.4) * 0.4;
        roundDelta += c.napWin ? -0.5 : +0.5;
      }
      delta += roundDelta;
      rounds.push({ bid: c.num, role, delta: Math.round(roundDelta * 100) / 100 });
    }
    delta += (art[seat] - meanArt) * 0.3;
    const rank = 1 + scores.filter(x => x > score).length;
    if (rank === 1) delta += 0.5;
    else if (rank === 5) delta -= 0.5;
    delta -= 0.05 * cs.length;
    return { seat, delta: Math.round(delta * 10) / 10, placement: rank, art: art[seat] - meanArt, breakdown: { rounds, rank } };
  });
}

function finishGame() {
  g.phase = 'result';
  const c = g.contract;
  const side = c.solo ? [c.nap] : [c.nap, c.deputy];
  const pts = side.reduce((n, i) => n + g.points[i], 0);
  const success = pts >= c.num && (c.num === 20 || pts < 20);
  const exact = success && pts === c.num;
  const bold = c.num >= 15;
  const napStat = g.matchStats[c.nap];
  napStat.declarerAttempts++;
  napStat.bidTotal += c.num;
  if (success) napStat.declarerSuccesses++;
  napStat.exactAttempts++;
  if (exact) napStat.exactSuccesses++;
  if (bold) { napStat.boldAttempts++; if (exact) napStat.boldSuccesses++; }
  if (c.solo) { napStat.soloAttempts++; if (success) napStat.soloSuccesses++; }
  if (!c.solo && c.deputy !== c.nap) {
    const depStat = g.matchStats[c.deputy];
    depStat.deputyAttempts++;
    if (success) depStat.deputySuccesses++;
  }

  // AI学習レポート送信
  postAiReport({
    napoleonWon: (() => {
      const cc = g.contract;
      const side = cc.solo ? [cc.nap] : [cc.nap, cc.deputy];
      const pts = side.reduce((n, i) => n + g.points[i], 0);
      return pts >= cc.num;
    })(),
    exactWins: g.roundArt.filter(a => a >= 4).length,
    lastPlacePenalty: g.matchScores.filter(s => s > g.matchScores[0]).length === 4 ? 1 : 0
  }).then(d => { if (d?.weights) Object.assign(g.aiWeights, d.weights); }).catch(() => {});

  const finalRule = g.round >= 10 ? finalAuctionRule(g.matchScores, g.mult) : null;
  const sign = success ? 1 : -1;
  const unit = Math.max(0, c.num - 12) * g.mult * (g.round >= 10 ? 2 : 1);
  const scores = Array(5).fill(0);
  scores[c.nap] = sign * unit * (c.solo ? 4 : 2);
  if (c.solo) {
    g.players.forEach((_, i) => { if (i !== c.nap) scores[i] = -sign * unit; });
  } else {
    scores[c.deputy] = sign * unit;
    g.players.forEach((_, i) => { if (i !== c.nap && i !== c.deputy) scores[i] = -sign * unit; });
  }
  const art = g.roundArt.slice();
  if (success && pts === c.num) {
    art[c.nap] += 2;
    if (!c.solo) art[c.deputy] += 1;
    if (c.num >= 15) { art[c.nap] += 2; if (!c.solo) art[c.deputy] += 1; }
  }
  if (c.solo) art[c.nap] += success ? 4 : 2;
  if (!success && !c.solo && c.num - pts >= 3) { art[c.nap] -= 2; art[c.deputy] -= 1; }
  for (let i = 0; i < 5; i++) { g.matchScores[i] += scores[i]; g.matchArt[i] += art[i]; }
  g.matchContracts.push({
    round: g.round, nap: c.nap, deputy: c.deputy, num: c.num, suit: c.suit,
    solo: c.solo, points: pts, napWin: success, revealTrickNo: c.revealTrickNo ?? null,
    takenPoints: g.players.map(p => p.roundPoints || 0)
  });
  const replayAllLast = !!(finalRule && scores[finalRule.bottomSeat] > 0 && g.matchScores[finalRule.bottomSeat] === g.matchScores[finalRule.fourthSeat]);
  if (replayAllLast) g.playoff = true;
  const format = n => (n > 0 ? '+' : '') + (Number.isInteger(n) ? n : n.toFixed(1));
  const role = i => i === c.nap ? 'NAP' : (!c.solo && i === c.deputy) ? 'DEPUTY' : 'ALLY';
  const rows = g.players.map((_, i) =>
    '<div class="round-score-row"><span>' + name(i) + ' · ' + role(i) + '</span>'
    + '<strong class="' + (scores[i] < 0 ? 'score-down' : 'score-up') + '">ROUND Δ ' + format(scores[i])
    + '<small>TOTAL ' + format(g.matchScores[i]) + '</small></strong></div>'
  ).join('');
  const final = g.round >= 10 && !replayAllLast;
  const ratings = final ? finalRatingDeltas(g.matchScores, g.matchArt, [g.rate, 1000, 1000, 1000, 1000], g.matchStats, g.matchContracts) : null;
  if (final) { g.rate += ratings[0].delta; $('rating-label').textContent = g.rate; }
  phase('結果');
  addGameLog((success ? 'ナポレオン軍成功' : '連合軍成功') + ' · 宣言 ' + c.num + '枚 / 獲得 ' + pts + '枚');
  message(replayAllLast ? 'プレーオフ' : success ? 'NAP TEAM WINS' : 'ALLIANCE WINS');
  drawSeats();
  const finalRows = final ? g.players.map((_, i) => {
    const result = ratings[i], b = result.breakdown;
    const roundStr = (b.rounds || []).map(r => (r.role === 'nap' ? 'N' : r.role === 'dep' ? 'D' : 'A') + r.bid + ':' + format(r.delta)).join(' ');
    return '<div class="round-score-row"><span>' + name(i) + ' · MATCH ' + format(g.matchScores[i]) + ' / ART ' + format(g.matchArt[i]) + '</span>'
      + '<strong class="' + (result.delta < 0 ? 'score-down' : 'score-up') + '">SIM RATE Δ ' + format(result.delta)
      + '<small>順位 ' + b.rank + ' · ' + roundStr + '</small></strong></div>';
  }).join('') : '';
  const r = $('result-panel');
  r.classList.remove('hidden');
  r.innerHTML = '<div class="eyebrow">' + (g.playoff ? 'プレーオフ' : g.round === 9 ? 'ラス前' : g.round >= 10 ? 'オールラスト' : 'ROUND ' + String(g.round).padStart(2, '0')) + ' · RESULT</div>'
    + '<h2>' + (success ? 'NAP TEAM WINS' : 'ALLIANCE WINS') + '</h2>'
    + '<p>BID ' + c.num + c.suit + ' · POINTS ' + pts + (c.solo ? ' · SOLO' : '')
    + '<br>NAP ' + name(c.nap) + (c.solo ? '' : ' · DEPUTY ' + name(c.deputy)) + '</p>'
    + (replayAllLast ? '<p>5位が4位に並びました。プレーオフを行います。</p>' : '')
    + '<div class="round-score-list"><div class="micro-copy">ROUND SCORE</div>' + rows + '</div>'
    + (final ? '<div class="round-score-list"><div class="micro-copy">MATCH COMPLETE · SIM RATE ' + g.rate + '</div>' + finalRows + '</div>' : '')
    + '<button id="next-round" class="primary-button">' + (final ? 'MENU' : replayAllLast ? 'プレーオフ再戦' : 'NEXT ROUND') + '</button>';
  $('next-round').onclick = () => {
    r.classList.add('hidden');
    if (final) { screen('home-screen'); return; }
    g.round++;
    g.mult = 1;
    g.greenRedraws = 0;
    roundStart();
  };
}
