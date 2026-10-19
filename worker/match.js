// ============================================================
// worker/match.js
// 依存: constants.js, ai-tactics.js, worker/rating.js, worker/match-state.js, worker/state.js
// 役割: 試合進行（auction/call/discard/play/result）、bot思考、決済
// ============================================================
import { RANKS, defaultStrategy, shuffledDeck, sortHand } from '../constants.js';
import {
  winningEntry, shouldBid, chooseDiscard, chooseDeputyCall,
  chooseCardToPlay, chooseDeputyCard, strongestSuit, chooseSoloCall,
  colorStrength, ntHandStrength
} from '../ai-tactics.js';
import {
  queues, rankedUsers, conns, matches, connMatch,
  sendSafe, botStrategyCache
} from './state.js';
import {
  finalAuctionRule, computeTeamMinBid, isSoloForcedInMatch,
  legalCards, validBid, artfulCard, publicState
} from './match-state.js';
import { matchRatingChanges } from './rating.js';

// ============================================================
// プロフィール
// ============================================================
export async function getProfile(env, conn) {
  const userId = conn.authUserId || conn.userId;
  if (!userId) {
    return { rating: 1000, games: 0, username: conn.username || 'ゲスト', playerId: conn.username || 'ゲスト' };
  }
  const p = await env.DB.prepare(
    'SELECT player_id,username,rating,games FROM players WHERE user_id=?'
  ).bind(userId).first();
  return p
    ? { rating: p.rating, games: p.games, username: p.username, playerId: p.player_id, userId }
    : { rating: 1000, games: null, username: conn.username || 'player', playerId: conn.username || 'player', userId: null };
}

// ============================================================
// Bot 戦略のロード
// ============================================================
async function loadBotStrategy(env) {
  if (botStrategyCache.value && Date.now() - botStrategyCache.time < 60000) {
    return botStrategyCache.value;
  }
  try {
    const w = await env.DB.prepare('SELECT weights FROM ai_weights WHERE id=1').first();
    if (w?.weights) {
      botStrategyCache.value = { ...defaultStrategy(), ...JSON.parse(w.weights) };
      botStrategyCache.time = Date.now();
      return botStrategyCache.value;
    }
  } catch (e) {
    console.warn('bot strategy load failed', e);
  }
  return defaultStrategy();
}

// ============================================================
// マッチ生成・配札
// ============================================================
export async function beginMatch(kind, roomCode, group, room, env) {
  const id = Math.random().toString(36).slice(2, 12).toUpperCase();
  const seats = group.map(x => ({
    connId: x.id, originalConnId: x.id, player: x.player, bot: false,
    hand: [], points: 0, taken: [], roundTaken: [], roundPoints: 0
  }));
  while (seats.length < 5) {
    seats.push({
      connId: null,
      player: { username: 'COM ' + (seats.length + 1), playerId: 'COM', rating: 1000, games: 0 },
      bot: true, hand: [], points: 0, taken: [], roundTaken: [], roundPoints: 0
    });
  }

  const m = {
    id, kind, code: roomCode, seats: seats.slice(0, 5), created: Date.now(),
    botLevel: 3,
    matchScores: Array(5).fill(0), matchArt: Array(5).fill(0),
    matchContracts: [], bidHistory: [], playoff: false,
    appeal: null, appealInfo: '', botStrategy: defaultStrategy(),
    matchStats: Array.from({ length: 5 }, () => ({
      exactWins: 0, boldExactWins: 0, soloWins: 0, dramaticPlays: 0,
      declarerAttempts: 0, declarerSuccesses: 0, deputyAttempts: 0, deputySuccesses: 0,
      exactAttempts: 0, exactSuccesses: 0, soloAttempts: 0, soloSuccesses: 0,
      artAttempts: 0, allyFeedAttempts: 0, allyFeedSuccesses: 0,
      boldAttempts: 0, boldSuccesses: 0, bidTotal: 0, ntBids: 0, colorBids: 0
    })),
    roundArt: Array(5).fill(0), roundDrama: Array(5).fill(0), roundFeed: Array(5).fill(0),
    phase: 'prep', round: 1, mult: 1, redraws: 0, kitty: [],
    trick: [], trickNo: 0, active: -1, auction: null, contract: null,
    deadline: Date.now() + 7000, lastBot: 0,
    notice: '配札しました。競り開始まで7秒です。',
    playedCards: [], voids: [{}, {}, {}, {}, {}]
  };

  matches.set(id, m);
  m.seats.forEach(x => { if (x.connId) connMatch.set(x.connId, id); });

  if (env?.DB) {
    loadBotStrategy(env).then(s => { m.botStrategy = s; }).catch(() => {});
  }

  const players = m.seats.map((x, seat) => ({
    seat, id: x.player.playerId, username: x.player.username, rating: x.player.rating, bot: x.bot
  }));
  group.forEach((x, seat) => sendSafe(x.conn, {
    type: 'matched', matchId: id, mode: kind, code: roomCode || null,
    players, seat, botCount: 5 - group.length
  }));

  deal(m);
  publish(m, room);
}

export function deal(m) {
  m.lastTrickWinner = null;
  const d = shuffledDeck();
  m.seats.forEach(p => {
    p.hand = d.splice(0, 10);
    p.points = 0; p.taken = []; p.roundTaken = []; p.roundPoints = 0;
    sortHand(p.hand);
  });
  m.kitty = d.splice(0, 2);
  m.trick = []; m.trickNo = 0; m.earlyFinish = false;
  m.roundArt = Array(5).fill(0);
  m.roundDrama = Array(5).fill(0);
  m.roundFeed = Array(5).fill(0);
  m.result = null; m.contract = null; m.auction = null; m.active = -1;
  m.phase = 'prep';
  m.deadline = Date.now() + 7000;
  m.playedCards = [];
  m.voids = [{}, {}, {}, {}, {}];
  m.notice = '競り開始まで7秒です。';

  const green = m.seats.findIndex(p => !p.hand.some(c => ['10', 'J', 'Q', 'K', 'A'].includes(c.rank)));
  if (green >= 0 && m.redraws < 5) {
    m.redraws++;
    m.mult = m.mult >= 4 ? 2 : m.mult + 1;
    m.phase = 'redeal';
    m.notice = m.seats[green].player.username + 'の手札に10・J・Q・K・Aがありません。倍率' + m.mult + '倍で配り直します。';
    m.deadline = Date.now() + 1800;
  }
}

// ============================================================
// 状態配信
// ============================================================
export function publish(m, room) {
  const pub = publicState(m);
  for (let seat = 0; seat < m.seats.length; seat++) {
    const p = m.seats[seat];
    if (!p.connId) continue;
    const c = conns.get(p.connId);
    if (!c) continue;
    const view = (m.phase === 'call' && seat === m.active) ? { ...pub, kitty: m.kitty } : pub;
    try {
      sendSafe(c, { type: 'game-state', state: view, you: seat });
      sendSafe(c, {
        type: 'private-hand',
        hand: p.hand,
        legal: m.phase === 'play' && m.active === seat ? legalCards(m, seat).map(x => x.id) : []
      });
    } catch (error) {
      console.warn('match publish failed', m.id, c.id, error);
    }
  }
}

// ============================================================
// 競り
// ============================================================
export function doApprove(m, seat, room, forced = false) {
  if (m.phase !== 'auction' || !m.auction.active.includes(seat)) return;

  if (m.auction.requiredBidSeat !== null && m.auction.high.num < 13) {
    if (forced && seat === m.auction.requiredBidSeat) {
      doBid(m, seat, m.auction.minBid || 13, strongestSuit(m.seats[seat].hand), room);
    }
    return;
  }
  if (m.round >= 10 && m.auction.high.num < 13) {
    const forcedSeat = m.auction.requiredBidSeat ?? m.auction.active[0];
    if (forced && seat === forcedSeat) {
      doBid(m, seat, m.auction.minBid || 13, strongestSuit(m.seats[seat].hand), room);
    }
    return;
  }
  if (m.auction.high.player === seat) {
    if (m.auction.active.length === 1) auctionDone(m, seat, room);
    else if (forced && !m.auction.autoApprove[seat]) {
      m.auction.autoApprove[seat] = true;
      m.notice = m.seats[seat].player.username + 'は30秒操作がなかったため、自動承認待ちです。';
      publish(m, room);
    }
    return;
  }

  m.auction.lastAction[seat] = Date.now();
  m.auction.autoApprove[seat] = false;
  m.auction.active = m.auction.active.filter(x => x !== seat);
  m.notice = forced
    ? m.seats[seat].player.username + 'は30秒操作がなかったため、自動で承認しました。'
    : m.seats[seat].player.username + 'が承認しました。';

  if (!m.auction.active.length) { auctionDone(m, -1, room); return; }

  if (m.auction.active.length === 1 && m.auction.high.player === m.auction.active[0]) {
    const last = m.auction.active[0];
    if (m.auction.autoApprove[last]) { auctionDone(m, last, room); return; }
    m.notice = m.seats[last].player.username + '以外は承認しました。さらに宣言するか、承認して確定できます。';
  }
  m.auction.active.forEach(i => {
    if (m.seats[i].bot) {
      m.auction.botSeen[i] = Math.min(m.auction.botSeen[i], m.auction.version - 1);
      m.auction.botAt[i] = Date.now() + 500 + Math.random() * 1300;
    }
  });
  publish(m, room);
}

function doBid(m, seat, n, s, room, solo = false) {
  if (m.phase !== 'auction' || !m.auction.active.includes(seat)
    || (m.auction.requiredBidSeat !== null && m.auction.requiredBidSeat !== seat)
    || !validBid(m, n, s)) return;

  m.bidHistory.push({ round: m.round, seat, num: n, suit: s, solo });
  if (m.bidHistory.length > 50) m.bidHistory.shift();
  m.auction.lastAction[seat] = Date.now();
  m.auction.autoApprove[seat] = false;
  m.auction.high = { num: n, suit: s, player: seat, solo: solo === true };
  if (m.auction.requiredBidSeat === seat) m.auction.requiredBidSeat = null;
  m.auction.version++;
  m.active = seat;

  m.auction.botAt.forEach((_, i) => {
    if (m.seats[i].bot && i !== seat && m.auction.active.includes(i)) {
      m.auction.botAt[i] = Date.now() + 400 + Math.random() * 1600;
    }
  });

  for (const i of m.auction.active.slice()) {
    if (i !== seat && m.auction.autoApprove[i]) doApprove(m, i, room, true);
  }
  if (m.phase !== 'auction') return;

  m.notice = m.seats[seat].player.username + 'が' + n + s + (solo ? '（ひとり立ち）' : '') + 'を宣言しました。';
  if (n === 20 && s === 'NT') { auctionDone(m, seat, room); return; }
  publish(m, room);
}

function appealDetails(hand) {
  const targets = [['♣J', '♣J'], ['♦J', '♦J'], ['♥J', '♥J'], ['♠J', '♠J'], ['マイティ（♠A）', '♠A']];
  return targets.map(([label, id]) => label + '：' + (hand.some(c => c.id === id) ? 'あり' : 'なし')).join(' · ');
}

function enterAuctionAfterAppeal(m, room, requiredBidSeat = null) {
  m.auction.requiredBidSeat = requiredBidSeat;
  m.phase = 'auction';
  m.active = -1;
  m.deadline = 0;
  m.notice = m.appealInfo || '競り開始です。宣言するか、承認して競りを降りてください。';
  publish(m, room);
}

export function answerAppealOffer(m, seat, appeal, room) {
  if (m.phase !== 'appeal-offer' || seat !== m.appeal?.bottomSeat) return;
  if (!appeal) {
    m.appealInfo = '5位はアピールせず競りへ';
    enterAuctionAfterAppeal(m, room);
    return;
  }
  m.phase = 'appeal-response';
  m.active = m.appeal.fourthSeat;
  m.deadline = Date.now() + 30000;
  m.notice = '5位がアピールしました。4位はJ・マイティを申告するか、申告せず立てます。';
  publish(m, room);
  if (m.seats[m.active].bot) answerAppealResponse(m, m.active, 'declare', room);
}

export function answerAppealResponse(m, seat, choice, room) {
  if (m.phase !== 'appeal-response' || seat !== m.appeal?.fourthSeat) return;
  if (choice === 'declare') {
    const player = m.seats[seat].player;
    m.appealInfo = (player.playerId || player.username) + 'の申告：' + appealDetails(m.seats[seat].hand);
    enterAuctionAfterAppeal(m, room);
    return;
  }
  const player = m.seats[seat].player;
  m.appealInfo = (player.playerId || player.username) + 'は申告せず立つことを選択。';
  enterAuctionAfterAppeal(m, room, seat);
}

function auctionDone(m, seat, room) {
  if (seat < 0 || m.auction.high.num < 13) {
    if (m.round >= 10) {
      seat = finalAuctionRule(m.matchScores, m.mult).bottomSeat;
      m.auction.high = {
        num: m.auction.minBid || 13,
        suit: strongestSuit(m.seats[seat].hand),
        player: seat, solo: false
      };
      m.notice = 'オールラストは立ち必須。最下位が最低枚数で立ちます。';
    } else {
      m.notice = '宣言なし。配り直します。';
      m.phase = 'redeal';
      m.deadline = Date.now() + 1800;
      publish(m, room);
      return;
    }
  }

  const botParams = m.botStrategy || defaultStrategy();
  const strengthAtBid = m.auction.high.suit === 'NT'
    ? ntHandStrength(m.seats[seat].hand, botParams)
    : colorStrength(m.seats[seat].hand, m.auction.high.suit, botParams);

  const isSoloBid = m.auction.high.solo === true;
  m.contract = {
    nap: seat, num: m.auction.high.num, suit: m.auction.high.suit,
    deputy: -1, call: null, solo: isSoloBid,
    revealedCall: false, revealTrickNo: null, strengthAtBid
  };
  beginDiscard(m, seat, room);
}

// ============================================================
// 捨て札・指名
// ============================================================
function beginDiscard(m, seat, room) {
  m.seats[seat].hand.push(...m.kitty);
  m.kitty = [];
  sortHand(m.seats[seat].hand);
  m.phase = 'discard';
  m.active = seat;
  m.deadline = Date.now() + 30000;
  m.notice = 'オープンの2枚を手札に入れ、2枚を捨ててください。';
  publish(m, room);
  if (m.seats[seat].bot) botAction(m, room);
}

function callCard(m, seat, suit, rank, room) {
  if (m.phase !== 'call' || m.active !== seat || !SUITS.includes(suit) || !RANKS.includes(rank)) return;
  const card = { suit, rank, id: suit + rank };
  if (m.kitty.some(x => x.id === card.id)) return;
  const isOwn = m.seats[seat].hand.some(c => c.id === card.id);
  const forceSolo = isSoloForcedInMatch(m);
  if ((m.contract.solo || forceSolo) && !isOwn) {
    m.notice = 'ひとり立ちを選択しているため、自分の手札からのみ指名できます。';
    publish(m, room);
    return;
  }
  m.contract.call = card;
  m.contract.solo = isOwn || m.contract.solo;
  m.contract.revealedCall = false;
  m.contract.ready = m.seats.map(p => p.bot);
  m.phase = 'call-reveal';
  m.active = seat;
  m.deadline = Date.now() + 15000;
  m.kitty = [];
  m.notice = suit + rank + 'が指名されました' + (m.contract.solo ? '（ひとり立ち）' : '') + '。全員の確認後に開始します。';
  publish(m, room);
}

function discardCards(m, seat, ids, room) {
  if (m.phase !== 'discard' || m.active !== seat || !Array.isArray(ids) || ids.length !== 2
    || new Set(ids).size !== 2
    || (m.contract.solo && m.contract.call && ids.includes(m.contract.call.id))) return;
  const h = m.seats[seat].hand;
  if (ids.some(id => !h.some(c => c.id === id))) return;
  const removed = h.filter(c => ids.includes(c.id));
  m.seats[seat].hand = h.filter(c => !ids.includes(c.id));
  const kittyPoints = removed.filter(c => ['10', 'J', 'Q', 'K', 'A'].includes(c.rank));
  m.seats[m.contract.nap].points += kittyPoints.length;
  m.seats[m.contract.nap].taken.push(...kittyPoints);
  m.kitty = removed;
  sortHand(m.seats[seat].hand);
  m.phase = 'call';
  m.active = seat;
  m.deadline = Date.now() + 30000;
  m.notice = '捨て札を決めました。副官に指名するカードを選んでください。';
  publish(m, room);
  if (m.seats[seat].bot) botAction(m, room);
}

// ============================================================
// プレイ開始
// ============================================================
export function startPlay(m, room) {
  const c = m.contract;
  if (c.solo) c.deputy = c.nap;
  else {
    for (let i = 0; i < 5; i++) {
      if (m.seats[i].hand.some(x => x.id === c.call.id)) { c.deputy = i; break; }
    }
    if (c.deputy < 0) c.deputy = c.nap;
  }
  m.phase = 'play';
  m.trick = [];
  m.trickNo = 0;
  m.active = c.nap;
  m.deadline = Date.now() + 30000;
  m.notice = 'カードを出してください。マストフォローです。';
  publish(m, room);
  if (m.seats[m.active].bot) botAction(m, room);
}

// ============================================================
// カードプレイ
// ============================================================
export function playCard(m, seat, id, room, env) {
  if (m.phase !== 'play' || m.active !== seat) return;
  const legal = legalCards(m, seat);
  const card = legal.find(x => x.id === id);
  if (!card) return;

  if (!m.trick.length) m.lastTrickWinner = null;
  const previous = m.trick.length ? winningEntry(m.contract, m.trickNo, m.trick) : null;
  const hand = m.seats[seat].hand;
  const teamOf = i => (i === m.contract.nap || (!m.contract.solo && i === m.contract.deputy)) ? 'nap' : 'alliance';
  const feedOpportunity = !!(previous && previous.seat !== seat && m.contract.revealedCall
    && teamOf(previous.seat) === teamOf(seat)
    && legal.some(x => ['10', 'J', 'Q', 'K', 'A'].includes(x.rank)));
  const feedCard = feedOpportunity && ['10', 'J', 'Q', 'K', 'A'].includes(card.rank);

  hand.splice(hand.findIndex(x => x.id === id), 1);
  m.trick.push({ seat, card, feedOpportunity, feedCard });
  m.playedCards.push({ suit: card.suit, rank: card.rank, id: card.id, seat });

  if (m.trick.length > 1) {
    const ledSuit = m.trick[0].card.suit;
    if (card.suit !== ledSuit) {
      if (!m.voids[seat]) m.voids[seat] = {};
      m.voids[seat][ledSuit] = true;
    }
  }

  const reveal = m.contract.call?.id === card.id && !m.contract.revealedCall;
  let raisedNotice = '';
  if (reveal) {
    m.contract.revealedCall = true;
    m.contract.revealTrickNo = m.trickNo;
    if (m.round >= 10 && !m.contract.solo) {
      const r = computeTeamMinBid(m.matchScores, m.mult, m.contract.nap, m.contract.deputy);
      if (r !== null) {
        const forcedMin = r.minBid, oldBid = m.contract.num;
        const caseLabel = {
          A: '5位=ナポレオン / 4位=副官', B: '4位=ナポレオン / 5位=副官',
          C: '5位=ナポレオン / 4位=連合軍', D: '4位=ナポレオン / 5位=連合軍'
        }[r.case];
        if (forcedMin > oldBid) {
          m.contract.num = forcedMin;
          raisedNotice = '副官判明（' + caseLabel + '）。立ちを ' + oldBid + '枚 → ' + forcedMin + '枚 に引き上げました。';
        } else {
          raisedNotice = '副官判明（' + caseLabel + '）。立ち ' + oldBid + '枚は最低条件を満たしています。';
        }
        if (r.incentiveBroken) raisedNotice += ' ⚠ 20枚でも4位が3位を超えられないため、副官に勝つインセンティブがありません。';
      }
    }
  }

  if (previous && m.contract.revealedCall) {
    const team = x => (x === m.contract.nap || x === m.contract.deputy) ? 'nap' : 'alliance';
    if (team(seat) === team(previous.seat) && winningEntry(m.contract, m.trickNo, m.trick).seat === seat) {
      m.roundArt[seat]--;
    }
  }

  const revealNotice = m.contract.solo ? 'ひとり立ちが判明しました。' : '副官が判明しました。';

  if (m.trick.length < 5) {
    m.active = (seat + 4) % 5;
    m.deadline = Date.now() + 30000;
    m.notice = raisedNotice || (reveal ? revealNotice : 'カードを出してください。');
    publish(m, room);
    if (m.seats[m.active].bot) botAction(m, room);
    return;
  }

  const winningEntryObj = winningEntry(m.contract, m.trickNo, m.trick);
  const w = winningEntryObj.seat;
  const taken = m.trick.filter(x => ['10', 'J', 'Q', 'K', 'A'].includes(x.card.rank)).map(x => x.card);

  for (const entry of m.trick) {
    if (!entry.feedOpportunity) continue;
    const stat = m.matchStats[entry.seat];
    stat.allyFeedAttempts++;
    if (entry.feedCard && teamOf(w) === teamOf(entry.seat)) {
      stat.allyFeedSuccesses++;
      m.roundFeed[entry.seat]++;
      m.roundArt[entry.seat]++;
    }
  }

  if (taken.length >= 3 && m.roundDrama[w] < 2) {
    m.matchStats[w].artAttempts++;
    if (artfulCard(m, winningEntryObj, m.trick)) {
      m.roundArt[w]++;
      m.roundDrama[w]++;
      m.matchStats[w].dramaticPlays++;
    }
  }

  m.seats[w].points += taken.length;
  m.seats[w].taken.push(...taken);
  m.seats[w].roundTaken.push(...taken);
  m.seats[w].roundPoints = (m.seats[w].roundPoints || 0) + taken.length;
  m.lastTrickWinner = w;
  m.active = w;

  const alliancePoints = m.seats.reduce((n, p, i) =>
    n + ((i !== m.contract.nap && (m.contract.solo || i !== m.contract.deputy)) ? p.points : 0), 0);
  const napPoints = m.seats.reduce((n, p, i) =>
    n + ((i === m.contract.nap || (!m.contract.solo && i === m.contract.deputy)) ? p.points : 0), 0);
  m.earlyFinish = alliancePoints > 20 - m.contract.num
    || (napPoints >= m.contract.num && (m.contract.num === 20 || alliancePoints >= 1));

  m.notice = raisedNotice
    || (napPoints >= m.contract.num ? 'ナポレオン軍が立ちを達成しました。'
        : m.earlyFinish ? '連合軍の獲得得点札で立ちが成立不能になりました。'
        : reveal ? revealNotice
        : m.seats[w].player.username + 'が場札を取りました。');
  m.phase = 'trick-end';
  m.deadline = m.earlyFinish ? Date.now() : Date.now() + 1250;
  publish(m, room);
}

// ============================================================
// Bot
// ============================================================
export function botAuctionBid(m, seat, room) {
  m.botLevel = 3;
  const a = m.auction, version = a.version;
  if (a.botSeen[seat] >= version || !a.active.includes(seat)) return;
  a.botSeen[seat] = version;

  const h = m.seats[seat].hand;
  const params = m.botStrategy || defaultStrategy();
  const currentBids = (m.bidHistory || []).filter(b => b.round === m.round);
  const bid = shouldBid(h, a.high, a.minBid || 13, params, currentBids, seat);

  if (bid && validBid(m, bid.num, bid.suit)) {
    a.botBids[seat]++;
    doBid(m, seat, bid.num, bid.suit, room, bid.solo === true);
    if (m.phase === 'auction') a.botAt[seat] = Date.now() + 2500 + Math.random() * 1800;
    return;
  }
  if (a.high.player === seat) {
    if (a.active.length === 1) doApprove(m, seat, room);
    return;
  }
  doApprove(m, seat, room);
}

export function botAction(m, room) {
  if (!m || m.phase === 'result') return;
  m.botLevel = 3;
  const i = m.active, p = m.seats[i];
  if (!p?.bot) return;
  m.lastBot = Date.now();
  const params = m.botStrategy || defaultStrategy();

  if (m.phase === 'auction') { botAuctionBid(m, i, room); return; }

  if (m.phase === 'call') {
    if (m.contract.solo) {
      const chosen = chooseSoloCall(p.hand);
      if (chosen) callCard(m, i, chosen.suit, chosen.rank, room);
      return;
    }
    const forceSolo = isSoloForcedInMatch(m);
    if (forceSolo) {
      const chosen = p.hand.slice().sort((a, b) => RANKS.indexOf(a.rank) - RANKS.indexOf(b.rank))[0];
      callCard(m, i, chosen.suit, chosen.rank, room);
    } else {
      const x = chooseDeputyCall(p.hand, m.kitty, m.contract.suit, m.botLevel || 2, m.contract.num, params);
      if (x) callCard(m, i, x.suit, x.rank, room);
    }
    return;
  }

  if (m.phase === 'discard') {
    const drop = chooseDiscard(p.hand, m.contract.suit).map(x => x.id);
    discardCards(m, i, drop, room);
    return;
  }

  if (m.phase === 'play') {
    const legal = legalCards(m, i);
    const ctx = {
      hand: p.hand, legal, trick: m.trick, trickNo: m.trickNo, contract: m.contract,
      playedCards: m.playedCards, voids: m.voids, seat: i, deputy: m.contract.deputy,
      isMySideNap: i === m.contract.nap || (m.contract.revealedCall && i === m.contract.deputy),
      isCurrentNapWinning: m.trick.length
        ? (winningEntry(m.contract, m.trickNo, m.trick).seat === m.contract.nap
            || (!m.contract.solo && winningEntry(m.contract, m.trickNo, m.trick).seat === m.contract.deputy))
        : false,
      isRevealed: m.contract.revealedCall,
      isNapLeading: m.trick.length > 0 && m.trick[0].seat === m.contract.nap,
      lastSeat: m.trick.length === 4,
      params, call: m.contract.call
    };
    let c;
    if (i === m.contract.deputy && !m.contract.solo && m.contract.revealedCall) {
      c = chooseDeputyCard(ctx);
    } else {
      c = chooseCardToPlay(ctx);
    }
    if (!c || !legal.some(x => x.id === c.id)) {
      c = legal[Math.floor(Math.random() * legal.length)];
    }
    playCard(m, i, c.id, room, null);
  }
}

// ============================================================
// タイムアウト
// ============================================================
export function timeoutAction(m, room) {
  const i = m.active, p = m.seats[i];
  const params = m.botStrategy || defaultStrategy();

  if (m.phase === 'call') {
    if (m.contract.solo) {
      const chosen = chooseSoloCall(p.hand);
      if (chosen) callCard(m, i, chosen.suit, chosen.rank, room);
      return;
    }
    const forceSolo = isSoloForcedInMatch(m);
    if (forceSolo) {
      const chosen = p.hand.slice().sort((a, b) => RANKS.indexOf(a.rank) - RANKS.indexOf(b.rank))[0];
      if (chosen) callCard(m, i, chosen.suit, chosen.rank, room);
    } else {
      const x = chooseDeputyCall(p.hand, m.kitty, m.contract.suit, m.botLevel || 2, m.contract.num, params);
      if (x) callCard(m, i, x.suit, x.rank, room);
    }
    return;
  }
  if (m.phase === 'discard') {
    const ids = p.hand.slice().sort((a, b) => RANKS.indexOf(a.rank) - RANKS.indexOf(b.rank)).slice(0, 2).map(x => x.id);
    discardCards(m, i, ids, room);
    return;
  }
  if (m.phase === 'play') {
    const c = legalCards(m, i).slice().sort((a, b) => RANKS.indexOf(a.rank) - RANKS.indexOf(b.rank))[0];
    if (c) playCard(m, i, c.id, room, null);
  }
}

// ============================================================
// 次ラウンド・アクション処理
// ============================================================
export function nextRound(m, room) {
  if (m.phase !== 'round-result') return;
  m.round++;
  m.mult = 1;
  m.redraws = 0;
  deal(m);
  publish(m, room);
}

export async function processAction(conn, msg, room, env) {
  const id = connMatch.get(conn.id);
  const m = id && matches.get(id);
  if (!m) return;
  const seat = m.seats.findIndex(s => s.connId === conn.id);
  if (seat < 0) return;
  const a = msg.action || {};

  if (a.type === 'appeal') return answerAppealOffer(m, seat, true, room);
  if (a.type === 'skip-appeal') return answerAppealOffer(m, seat, false, room);
  if (a.type === 'appeal-declare') return answerAppealResponse(m, seat, 'declare', room);
  if (a.type === 'appeal-stand') return answerAppealResponse(m, seat, 'stand', room);
  if (a.type === 'next-round') return nextRound(m, room);
  if (a.type === 'auction-activity') {
    if (m.phase === 'auction' && m.auction.active.includes(seat)) {
      m.auction.lastAction[seat] = Date.now();
      m.auction.autoApprove[seat] = false;
    }
    return;
  }
  if (a.type === 'confirm-call') {
    if (m.phase !== 'call-reveal' || m.contract.ready[seat]) return;
    m.contract.ready[seat] = true;
    if (m.contract.ready.every((ready, i) => ready || m.seats[i].bot)) startPlay(m, room);
    else { m.notice = '指名カードの確認中です。'; publish(m, room); }
    return;
  }
  if (a.type === 'approve' || a.type === 'pass') doApprove(m, seat, room);
  else if (a.type === 'bid') doBid(m, seat, Number(a.num), a.suit, room, a.solo === true);
  else if (a.type === 'call') callCard(m, seat, a.suit, a.rank, room);
  else if (a.type === 'discard') discardCards(m, seat, a.cards, room);
  else if (a.type === 'play') playCard(m, seat, a.card, room, env);
}

// ============================================================
// 決済
// ============================================================
export async function finish(m, room, env) {
  m.matchScores = m.matchScores || Array(5).fill(0);
  m.matchArt = m.matchArt || Array(5).fill(0);
  m.matchContracts = m.matchContracts || [];
  m.matchStats = m.matchStats || Array.from({ length: 5 }, () => ({
    exactWins: 0, boldExactWins: 0, soloWins: 0, dramaticPlays: 0,
    declarerAttempts: 0, declarerSuccesses: 0, deputyAttempts: 0, deputySuccesses: 0,
    exactAttempts: 0, exactSuccesses: 0, soloAttempts: 0, soloSuccesses: 0,
    artAttempts: 0, allyFeedAttempts: 0, allyFeedSuccesses: 0,
    boldAttempts: 0, boldSuccesses: 0, bidTotal: 0, ntBids: 0, colorBids: 0
  }));
  m.matchStats.forEach(stat => {
    stat.declarerAttempts = stat.declarerAttempts || 0;
    stat.declarerSuccesses = stat.declarerSuccesses || 0;
    stat.deputyAttempts = stat.deputyAttempts || 0;
    stat.deputySuccesses = stat.deputySuccesses || 0;
    stat.exactAttempts = stat.exactAttempts || 0;
    stat.exactSuccesses = stat.exactSuccesses || 0;
    stat.soloAttempts = stat.soloAttempts || 0;
    stat.soloSuccesses = stat.soloSuccesses || 0;
    stat.artAttempts = stat.artAttempts || 0;
    stat.allyFeedAttempts = stat.allyFeedAttempts || 0;
    stat.allyFeedSuccesses = stat.allyFeedSuccesses || 0;
    stat.boldAttempts = stat.boldAttempts || 0;
    stat.boldSuccesses = stat.boldSuccesses || 0;
    stat.bidTotal = stat.bidTotal || 0;
    stat.ntBids = stat.ntBids || 0;
    stat.colorBids = stat.colorBids || 0;
  });
  m.roundArt = m.roundArt || Array(5).fill(0);

  const finalRule = m.round >= 10 ? finalAuctionRule(m.matchScores, m.mult) : null;
  const nap = m.contract.nap;
  const unit = Math.max(0, m.contract.num - 12) * m.mult * (m.round >= 10 ? 2 : 1);
  const team = m.contract.solo ? [nap] : Array.from(new Set([nap, m.contract.deputy]));
  const points = team.reduce((n, i) => n + m.seats[i].points, 0);
  const made = points >= m.contract.num && (m.contract.num === 20 || points < 20);
  const sign = made ? 1 : -1;
  const scores = Array(5).fill(0);

  m.matchStats[nap].declarerAttempts++;
  m.matchStats[nap].bidTotal = (m.matchStats[nap].bidTotal || 0) + m.contract.num;
  if (m.contract.suit === 'NT') m.matchStats[nap].ntBids = (m.matchStats[nap].ntBids || 0) + 1;
  else m.matchStats[nap].colorBids = (m.matchStats[nap].colorBids || 0) + 1;
  m.matchStats[nap].exactAttempts++;
  if (m.contract.num >= 15) {
    m.matchStats[nap].boldAttempts++;
    if (made && points === m.contract.num) m.matchStats[nap].boldSuccesses++;
  }
  if (made) m.matchStats[nap].declarerSuccesses++;
  if (!m.contract.solo) {
    m.matchStats[m.contract.deputy].deputyAttempts++;
    if (made) m.matchStats[m.contract.deputy].deputySuccesses++;
  }
  if (m.contract.solo) {
    m.matchStats[nap].soloAttempts++;
    if (made) m.matchStats[nap].soloSuccesses++;
  }

  scores[nap] = sign * unit * (m.contract.solo ? 4 : 2);
  if (m.contract.solo) {
    for (let i = 0; i < 5; i++) if (i !== nap) scores[i] = -sign * unit;
  } else {
    scores[m.contract.deputy] = sign * unit;
    for (let i = 0; i < 5; i++) if (i !== nap && i !== m.contract.deputy) scores[i] = -sign * unit;
  }

  const art = m.roundArt.slice();
  if (made && points === m.contract.num) {
    art[nap] += 2;
    m.matchStats[nap].exactWins++;
    m.matchStats[nap].exactSuccesses++;
    if (!m.contract.solo) art[m.contract.deputy] += 1;
    if (m.contract.num >= 15) {
      art[nap] += 2;
      m.matchStats[nap].boldExactWins++;
      if (!m.contract.solo) art[m.contract.deputy] += 1;
    }
  }
  if (m.contract.solo) {
    art[nap] += made ? 4 : 2;
    if (made) m.matchStats[nap].soloWins++;
  }
  if (!made && !m.contract.solo && m.contract.num - points >= 3) {
    art[nap] -= 2;
    art[m.contract.deputy] -= 1;
  }
  for (let i = 0; i < 5; i++) {
    m.matchScores[i] += scores[i];
    m.matchArt[i] += art[i];
  }
  m.matchContracts.push({
    round: m.round, nap, deputy: m.contract.deputy, num: m.contract.num,
    suit: m.contract.suit, solo: !!m.contract.solo, points, napWin: made,
    revealTrickNo: m.contract.revealTrickNo ?? null,
    takenPoints: m.seats.map(s => s.roundPoints || 0),
    strengthAtBid: m.contract.strengthAtBid ?? 8
  });

  const replayAllLast = !!(finalRule && scores[finalRule.bottomSeat] > 0
    && m.matchScores[finalRule.bottomSeat] === m.matchScores[finalRule.fourthSeat]);
  const lastRound = m.round >= 10 && !replayAllLast;
  if (replayAllLast) m.playoff = true;

  m.result = {
    round: m.round, made, points,
    bid: m.contract.num, suit: m.contract.suit, solo: !!m.contract.solo, stake: unit,
    scoreChanges: scores.map((delta, seat) => ({
      seat, delta,
      role: seat === nap ? 'ナポレオン'
        : (!m.contract.solo && seat === m.contract.deputy) ? '副官' : '連合軍'
    })),
    artChanges: art.map((delta, seat) => ({ seat, delta })),
    winners: made ? team : m.seats.map((_, i) => i).filter(i => !team.includes(i)),
    matchScores: m.matchScores.slice(), matchArt: m.matchArt.slice(),
    allLastReplay: replayAllLast, playoff: !!m.playoff
  };
  m.phase = lastRound ? 'result' : 'round-result';
  m.active = -1;
  m.deadline = lastRound ? 0 : Date.now() + 8000;
  m.notice = replayAllLast
    ? '5位が4位に並びました。プレーオフを行います。'
    : lastRound ? 'オールラスト終了。レートを集計しています。'
    : '第' + m.round + '局が終了しました。';

  if (!lastRound) { publish(m, room); return; }

  const ratingChanges = matchRatingChanges(
    m.matchScores, m.matchArt,
    m.seats.map(seat => Number(seat.player.rating) || 1000),
    m.matchStats, m.matchContracts
  );
  m.result.ratingChanges = ratingChanges;

  const placementOrder = m.matchScores.map((score, seat) => ({ score, seat }))
    .sort((a, b) => b.score - a.score || a.seat - b.seat);
  const placementBySeat = [];
  placementOrder.forEach((entry, index) => placementBySeat[entry.seat] = index + 1);

  if (m.kind === 'ranked') {
    const userIds = [...new Set(m.seats.map(seat => seat.player.userId).filter(Boolean))];
    const updates = [];
    if (userIds.length) {
      try {
        const placeholders = userIds.map(() => '?').join(',');
        const { results: profiles } = await env.DB.prepare(
          'SELECT user_id,username,rating FROM players WHERE user_id IN (' + placeholders + ')'
        ).bind(...userIds).all();
        const byId = new Map(profiles.map(profile => [profile.user_id, profile]));
        const statements = [];

        for (let seat = 0; seat < m.seats.length; seat++) {
          const player = m.seats[seat];
          const userId = player.player.userId;
          const profile = userId && byId.get(userId);
          if (!profile) continue;
          const change = ratingChanges[seat];
          const rating = profile.rating + change.delta;
          const outcome = change.outcome;
          change.rating = rating;
          const stat = m.matchStats[seat];

          statements.push(
            env.DB.prepare('UPDATE players SET rating=?,wins=wins+?,losses=losses+?,games=games+1 WHERE user_id=?')
              .bind(rating, outcome === 'win' ? 1 : 0, outcome === 'loss' ? 1 : 0, profile.user_id),
            env.DB.prepare('INSERT INTO match_history(user_id,username,result,delta,rating_after) VALUES(?,?,?,?,?)')
              .bind(profile.user_id, profile.username, outcome, change.delta, rating),
            env.DB.prepare('INSERT OR IGNORE INTO player_stats(user_id) VALUES(?)').bind(profile.user_id),
            env.DB.prepare('UPDATE player_stats SET exact_wins=exact_wins+?,bold_exact_wins=bold_exact_wins+?,solo_wins=solo_wins+?,dramatic_plays=dramatic_plays+? WHERE user_id=?')
              .bind(stat.exactWins, stat.boldExactWins, stat.soloWins, stat.dramaticPlays, profile.user_id),
            env.DB.prepare('INSERT INTO player_performance(user_id,declarer_attempts,declarer_successes,deputy_attempts,deputy_successes) VALUES(?,?,?,?,?) ON CONFLICT(user_id) DO UPDATE SET declarer_attempts=declarer_attempts+excluded.declarer_attempts,declarer_successes=declarer_successes+excluded.declarer_successes,deputy_attempts=deputy_attempts+excluded.deputy_attempts,deputy_successes=deputy_successes+excluded.deputy_successes')
              .bind(profile.user_id, stat.declarerAttempts, stat.declarerSuccesses, stat.deputyAttempts, stat.deputySuccesses),
            env.DB.prepare('INSERT INTO player_precision(user_id,exact_attempts,exact_successes,solo_attempts,solo_successes) VALUES(?,?,?,?,?) ON CONFLICT(user_id) DO UPDATE SET exact_attempts=exact_attempts+excluded.exact_attempts,exact_successes=exact_successes+excluded.exact_successes,solo_attempts=solo_attempts+excluded.solo_attempts,solo_successes=solo_successes+excluded.solo_successes')
              .bind(profile.user_id, stat.exactAttempts, stat.exactSuccesses, stat.soloAttempts, stat.soloSuccesses),
            env.DB.prepare('INSERT INTO player_art_rate(user_id,attempts,plays) VALUES(?,?,?) ON CONFLICT(user_id) DO UPDATE SET attempts=attempts+excluded.attempts,plays=plays+excluded.plays')
              .bind(profile.user_id, stat.artAttempts, stat.dramaticPlays),
            env.DB.prepare('INSERT INTO player_ally_feed(user_id,attempts,successes) VALUES(?,?,?) ON CONFLICT(user_id) DO UPDATE SET attempts=attempts+excluded.attempts,successes=successes+excluded.successes')
              .bind(profile.user_id, stat.allyFeedAttempts, stat.allyFeedSuccesses),
            env.DB.prepare('INSERT INTO player_bold_bid_rate(user_id,attempts,successes) VALUES(?,?,?) ON CONFLICT(user_id) DO UPDATE SET attempts=attempts+excluded.attempts,successes=successes+excluded.successes')
              .bind(profile.user_id, stat.boldAttempts, stat.boldSuccesses),
            env.DB.prepare('INSERT INTO player_match_stats(user_id,declarer_attempts,bid_total,nt_bids,color_bids,match_count,rank_1,rank_2,rank_3,rank_4,rank_5) VALUES(?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(user_id) DO UPDATE SET declarer_attempts=declarer_attempts+excluded.declarer_attempts,bid_total=bid_total+excluded.bid_total,nt_bids=nt_bids+excluded.nt_bids,color_bids=color_bids+excluded.color_bids,match_count=match_count+1,rank_1=rank_1+excluded.rank_1,rank_2=rank_2+excluded.rank_2,rank_3=rank_3+excluded.rank_3,rank_4=rank_4+excluded.rank_4,rank_5=rank_5+excluded.rank_5')
              .bind(profile.user_id, stat.declarerAttempts, stat.bidTotal || 0, stat.ntBids || 0, stat.colorBids || 0, 1,
                ...Array.from({ length: 5 }, (_, index) => placementBySeat[seat] === index + 1 ? 1 : 0))
          );
          updates.push({ connId: player.connId, change, rating, outcome });
        }
        if (statements.length) await env.DB.batch(statements);
      } catch (error) {
        console.error('ranked match settlement failed', m.id, error);
        m.result.rateSaveFailed = true;
      }
      if (!m.result.rateSaveFailed) {
        for (const update of updates) {
          try {
            sendSafe(conns.get(update.connId), {
              type: 'rating-updated', result: update.outcome,
              delta: update.change.delta, rating: update.rating,
              placement: update.change.placement, art: update.change.art,
              breakdown: update.change.breakdown
            });
          } catch (error) {
            console.warn('rating notification failed', m.id, error);
          }
        }
      }
    }
  }

  publish(m, room);
  matches.delete(m.id);
  for (const seat of m.seats) {
    if (seat.connId) connMatch.delete(seat.connId);
    const userId = seat.player.userId;
    if (userId && rankedUsers.get(userId) === seat.originalConnId) rankedUsers.delete(userId);
  }
}
