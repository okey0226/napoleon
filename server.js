import { WebSocketServer } from 'ws';
import http from 'http';
import { SUITS, RANKS, SV, defaultStrategy, shuffledDeck, sortHand, matchRatingChanges, computeEloDelta, ELO_INIT } from './constants.js';
import { winningEntry, shouldBid, chooseDiscard, chooseDeputyCall, chooseCardToPlay, chooseDeputyCard, strongestSuit, chooseSoloCall, colorStrength, ntHandStrength } from './ai-tactics.js';

const conns = new Map();
const matches = new Map();
const connMatch = new Map();
const queues = { ranked: [] };
const friendRooms = new Map();
const rankedUsers = new Map();

function sendSafe(conn, message) {
  if (!conn) return false;
  try { conn.send(message); return true; } catch (e) { return false; }
}
function makeCode() { return Math.random().toString(36).slice(2, 7).toUpperCase(); }

async function getProfile(env, conn) {
  return { rating: 1000, games: 0, username: conn.username || "ゲスト", playerId: conn.username || "ゲスト", userId: conn.authUserId || null };
}

function beginMatch(kind, roomCode, group, room, env) {
  const id = Math.random().toString(36).slice(2, 12).toUpperCase();
  const seats = group.map(x => ({
    connId: x.id, originalConnId: x.id, originalUserId: x.player.userId || null,
    originalPlayerName: x.player.username || "player", originalPlayerId: x.player.playerId || "player",
    disconnectedAt: null, player: x.player, bot: false, hand: [], points: 0, taken: [], roundTaken: [], roundPoints: 0
  }));
  while (seats.length < 5) seats.push({ connId: null, originalConnId: null, originalUserId: null, originalPlayerName: null, originalPlayerId: null, disconnectedAt: null, player: { username: "COM " + (seats.length + 1), playerId: "COM", rating: 1000, games: 0 }, bot: true, hand: [], points: 0, taken: [], roundTaken: [], roundPoints: 0 });
  const m = {
    id, kind, code: roomCode, seats: seats.slice(0, 5), created: Date.now(), botLevel: 3,
    matchScores: Array(5).fill(0), matchArt: Array(5).fill(0), matchContracts: [], bidHistory: [],
    playoff: false, appeal: null, appealInfo: '', botStrategy: defaultStrategy(), botExperience: null,
    matchStats: Array.from({ length: 5 }, () => ({ exactWins: 0, boldExactWins: 0, soloWins: 0, dramaticPlays: 0, declarerAttempts: 0, declarerSuccesses: 0, deputyAttempts: 0, deputySuccesses: 0, exactAttempts: 0, exactSuccesses: 0, soloAttempts: 0, soloSuccesses: 0, artAttempts: 0, allyFeedAttempts: 0, allyFeedSuccesses: 0, boldAttempts: 0, boldSuccesses: 0, bidTotal: 0, ntBids: 0, colorBids: 0 })),
    roundArt: Array(5).fill(0), roundDrama: Array(5).fill(0), roundFeed: Array(5).fill(0),
    phase: "prep", round: 1, mult: 1, redraws: 0, kitty: [], discardedKitty: [], trick: [], trickNo: 0, active: -1,
    auction: null, contract: null, deadline: Date.now() + 7000, lastBot: 0, humanAutoPlayAt: null,
    notice: "配札しました。競り開始まで7秒です。", playedCards: [], voids: [{}, {}, {}, {}, {}], allianceKittyPoints: 0
  };
  matches.set(id, m);
  m.seats.forEach(x => { if (x.connId) connMatch.set(x.connId, id); });
  const players = m.seats.map((x, seat) => ({ seat, id: x.player.playerId, username: x.player.username, rating: x.player.rating, bot: x.bot }));
  group.forEach((x, seat) => sendSafe(x.conn, { type: "matched", matchId: id, mode: kind, code: roomCode || null, players, seat, botCount: 5 - group.length }));
  deal(m);
  publish(m, room);
}

function deal(m) {
  m.lastTrickWinner = null; m.humanAutoPlayAt = null;
  const d = shuffledDeck();
  m.seats.forEach(p => { p.hand = d.splice(0, 10); p.points = 0; p.taken = []; p.roundTaken = []; p.roundPoints = 0; sortHand(p.hand); });
  m.kitty = d.splice(0, 2);
  m.discardedKitty = []; m.trick = []; m.trickNo = 0; m.earlyFinish = false;
  m.roundArt = Array(5).fill(0); m.roundDrama = Array(5).fill(0); m.roundFeed = Array(5).fill(0);
  m.result = null; m.contract = null; m.auction = null; m.active = -1; m.phase = "prep";
  m.deadline = Date.now() + 7000; m.playedCards = []; m.voids = [{}, {}, {}, {}, {}]; m.allianceKittyPoints = 0;
  m.notice = "競り開始まで7秒です。";
  const green = m.seats.findIndex(p => !p.hand.some(c => ["10", "J", "Q", "K", "A"].includes(c.rank)));
  if (green >= 0 && m.redraws < 5) {
    m.redraws++; m.mult = m.mult + 1; m.phase = "redeal";
    m.notice = m.seats[green].player.username + "の手札に10・J・Q・K・Aがありません。倍率" + m.mult + "倍で配り直します。";
    m.deadline = Date.now() + 1800;
  }
}

function finalAuctionRule(scores, mult = 1) {
  const ranked = scores.map((score, seat) => ({ score, seat })).sort((a, b) => a.score - b.score || a.seat - b.seat);
  const cutoff = ranked[1]?.score ?? 0;
  const gap = Math.max(0, (ranked[1]?.score ?? 0) - (ranked[0]?.score ?? 0));
  const rawMin = 13 + Math.floor(gap / (6 * Math.max(1, mult)));
  return { eligible: ranked.filter(x => x.score <= cutoff).map(x => x.seat), bottomSeat: ranked[0]?.seat, fourthSeat: ranked[1]?.seat, thirdSeat: ranked[2]?.seat, thirdScore: ranked[2]?.score, minBid: Math.min(20, rawMin), canOvertake: rawMin <= 20 };
}

function computeTeamMinBid(scores, mult, napSeat, deputySeat) {
  const ranked = scores.map((s, i) => ({ s, i })).sort((a, b) => a.s - b.s || a.i - b.i);
  const S5 = ranked[0].s, S4 = ranked[1].s, S3 = ranked[2].s;
  const bottomSeat = ranked[0].i, fourthSeat = ranked[1].i;
  const m = Math.max(1, mult);
  const f = (gap, denom) => Math.floor(Math.max(0, gap) / denom);
  if (napSeat === bottomSeat && deputySeat === fourthSeat) {
    const a = 13 + f(S3 - S5, 6 * m); const b = 13 + f(S3 - S4, 4 * m); const raw = Math.max(a, b); const achievable = raw <= 20;
    return { minBid: Math.min(20, raw), rawMin: raw, canOvertake: achievable, achievable, incentiveBroken: !achievable, soloRequired: false, case: 'A' };
  }
  if (napSeat === fourthSeat && deputySeat === bottomSeat) {
    const a = 13 + f(S3 - S4, 6 * m), b = 13 + f(S3 - S5, 4 * m), c = 13 + f(S4 - S5, 2 * m), raw = Math.max(a, b, c);
    return { minBid: Math.min(20, raw), rawMin: raw, canOvertake: raw <= 20, achievable: raw <= 20, incentiveBroken: a > 20 || b > 20, soloRequired: false, case: 'B' };
  }
  if (napSeat === bottomSeat && deputySeat !== fourthSeat) {
    const raw = 13 + f(S4 - S5, 6 * m);
    return { minBid: Math.min(20, raw), rawMin: raw, canOvertake: raw <= 20, achievable: raw <= 20, incentiveBroken: false, soloRequired: false, case: 'C' };
  }
  if (napSeat === fourthSeat && deputySeat !== bottomSeat) {
    const raw = 13 + f(S4 - S5, 6 * m);
    return { minBid: Math.min(20, raw), rawMin: raw, canOvertake: raw <= 20, achievable: raw <= 20, incentiveBroken: false, soloRequired: false, case: 'D' };
  }
  return null;
}

function isSoloForcedInMatch(m) {
  if (m.round < 10 || !m.contract) return false;
  const ranked = m.matchScores.map((s, i) => ({ s, i })).sort((a, b) => a.s - b.s || a.i - b.i);
  const bottomSeat = ranked[0].i; if (m.contract.nap !== bottomSeat) return false;
  const fourthSeat = ranked[1].i;
  const r = computeTeamMinBid(m.matchScores, m.mult, bottomSeat, fourthSeat);
  return r?.soloRequired === true;
}

function publicState(m) {
  return {
    matchId: m.id, mode: m.kind, code: m.code, botLevel: m.botLevel, phase: m.phase, round: m.round, mult: m.mult,
    matchScores: m.matchScores, bidHistory: m.bidHistory || [], playoff: !!m.playoff,
    appeal: m.appeal, appealInfo: m.appealInfo || '', lastTrickWinner: m.lastTrickWinner ?? null,
    notice: m.notice, active: m.active, allianceKittyPoints: m.allianceKittyPoints || 0,
    players: m.seats.map((p, seat) => ({
      seat, name: p.bot ? p.player.username : (p.player.playerId || p.player.username),
      username: p.player.username, rating: p.player.rating, bot: p.bot,
      handCount: p.hand.length, points: p.points, taken: p.taken, active: m.active,
      approved: m.phase === "auction" && m.auction && Array.isArray(m.auction.active) && !m.auction.active.includes(seat),
      role: m.contract ? (m.contract.nap === seat ? "ナポレオン" : !m.contract.revealedCall ? "" : m.contract.deputy === seat ? "副官" : "連合軍") : ""
    })),
    kitty: m.phase === "auction" ? m.kitty : [],
    revealedKitty: (m.phase !== "auction" && m.kitty) ? m.kitty : [],
    auction: m.auction ? { high: m.auction.high, active: m.auction.active, minBid: m.auction.minBid || 13, requiredBidSeat: m.auction.requiredBidSeat ?? null } : null,
    contract: m.contract ? { nap: m.contract.nap, num: m.contract.num, suit: m.contract.suit, deputy: m.contract.revealedCall ? m.contract.deputy : -1, solo: m.contract.revealedCall ? m.contract.solo : false, revealedCall: !!m.contract.revealedCall, call: m.contract.call } : null,
    trick: m.trick.map(x => ({ seat: x.seat, card: x.card })),
    trickNo: m.trickNo, deadline: m.deadline, result: m.result || null
  };
}

function legalCards(m, seat) {
  const h = m.seats[seat].hand;
  if (!m.trick.length) return h;
  const led = m.trick[0].card.suit, follow = h.filter(c => c.suit === led);
  return follow.length ? follow : h;
}

function publish(m, room) {
  const pub = publicState(m);
  for (let seat = 0; seat < m.seats.length; seat++) {
    const p = m.seats[seat]; if (!p.connId) continue;
    const c = conns.get(p.connId); if (!c) continue;
    const view = m.phase === "call" && seat === m.active ? { ...pub, kitty: m.kitty } : pub;
    sendSafe(c, { type: "game-state", state: view, you: seat });
    sendSafe(c, { type: "private-hand", hand: p.hand, legal: m.phase === "play" && m.active === seat ? legalCards(m, seat).map(x => x.id) : [] });
  }
}

function validBid(m, n, s) {
  const h = m.auction.high;
  return Number.isInteger(n) && n >= (m.auction.minBid || 13) && n <= 20 && (SUITS.includes(s) || s === "NT") && (n > h.num || (n === h.num && SV[s] > SV[h.suit]));
}

function doApprove(m, seat, room, forced = false) {
  if (m.phase !== "auction" || !m.auction.active.includes(seat)) return;
  if (m.auction.requiredBidSeat !== null && m.auction.high.num < 13) { if (forced && seat === m.auction.requiredBidSeat) doBid(m, seat, m.auction.minBid || 13, strongestSuit(m.seats[seat].hand), room); return; }
  if (m.round >= 10 && m.auction.high.num < 13) { const forcedSeat = m.auction.requiredBidSeat ?? m.auction.active[0]; if (forced && seat === forcedSeat) doBid(m, seat, m.auction.minBid || 13, strongestSuit(m.seats[seat].hand), room); return; }
  if (m.auction.high.player === seat) { if (m.auction.active.length === 1) auctionDone(m, seat, room); else if (forced && !m.auction.autoApprove[seat]) { m.auction.autoApprove[seat] = true; m.notice = m.seats[seat].player.username + "は30秒操作がなかったため、自動承認待ちです。"; publish(m, room); } return; }
  m.auction.lastAction[seat] = Date.now(); m.auction.autoApprove[seat] = false;
  m.auction.active = m.auction.active.filter(x => x !== seat);
  m.notice = forced ? m.seats[seat].player.username + "は30秒操作がなかったため、自動で承認しました。" : m.seats[seat].player.username + "が承認しました。";
  if (!m.auction.active.length) { auctionDone(m, -1, room); return; }
  if (m.auction.active.length === 1 && m.auction.high.player === m.auction.active[0]) {
    const last = m.auction.active[0];
    if (m.auction.autoApprove[last]) { auctionDone(m, last, room); return; }
    m.notice = m.seats[last].player.username + "以外は承認しました。さらに宣言するか、承認して確定できます。";
  }
  m.auction.active.forEach(i => { if (m.seats[i].bot) { m.auction.botSeen[i] = Math.min(m.auction.botSeen[i], m.auction.version - 1); m.auction.botAt[i] = Date.now() + 500 + Math.random() * 1300; } });
  publish(m, room);
}

function doBid(m, seat, n, s, room, solo = false) {
  if (m.phase !== "auction" || !m.auction.active.includes(seat) || m.auction.requiredBidSeat !== null && m.auction.requiredBidSeat !== seat || !validBid(m, n, s)) return;
  m.bidHistory.push({ round: m.round, seat, num: n, suit: s }); if (m.bidHistory.length > 50) m.bidHistory.shift();
  m.auction.lastAction[seat] = Date.now(); m.auction.autoApprove[seat] = false;
  m.auction.high = { num: n, suit: s, player: seat, solo: solo === true };
  if (m.auction.requiredBidSeat === seat) m.auction.requiredBidSeat = null;
  m.auction.version++; m.active = seat;
  m.auction.botAt.forEach((_, i) => { if (m.seats[i].bot && i !== seat && m.auction.active.includes(i)) m.auction.botAt[i] = Date.now() + 400 + Math.random() * 1600; });
  for (const i of m.auction.active.slice()) if (i !== seat && m.auction.autoApprove[i]) doApprove(m, i, room, true);
  if (m.phase !== "auction") return;
  m.notice = m.seats[seat].player.username + "が" + n + s + "を宣言しました。";
  if (n === 20 && s === "NT") { auctionDone(m, seat, room); return; }
  publish(m, room);
}

function appealDetails(hand) {
  const held = ['♣J', '♦J', '♥J', '♠J', '♠A'].filter(id => hand.some(card => card.id === id));
  return held.length ? held.join(' ') : 'なし';
}

function enterAuctionAfterAppeal(m, room, requiredBidSeat = null) {
  m.auction.requiredBidSeat = requiredBidSeat; m.phase = 'auction'; m.active = -1; m.deadline = 0;
  m.notice = m.appealInfo || '競り開始です。宣言するか、承認して競りを降りてください。'; publish(m, room);
}

function answerAppealOffer(m, seat, appeal, room) {
  if (m.phase !== 'appeal-offer' || seat !== m.appeal?.bottomSeat) return;
  if (!appeal) { m.appealInfo = '5位はアピールせず競りへ'; enterAuctionAfterAppeal(m, room); return; }
  m.phase = 'appeal-response'; m.active = m.appeal.fourthSeat; m.deadline = Date.now() + 30000;
  m.notice = '5位がアピールしました。4位はJ・マイティを申告するか、申告せず立てます。'; publish(m, room);
  if (m.seats[m.active].bot) answerAppealResponse(m, m.active, 'declare', room);
}

function answerAppealResponse(m, seat, choice, room) {
  if (m.phase !== 'appeal-response' || seat !== m.appeal?.fourthSeat) return;
  if (choice === 'declare') { m.appealInfo = (m.seats[seat].player.playerId || m.seats[seat].player.username) + 'の申告：' + appealDetails(m.seats[seat].hand); enterAuctionAfterAppeal(m, room); return; }
  m.appealInfo = (m.seats[seat].player.playerId || m.seats[seat].player.username) + 'は申告せず立つことを選択。';
  enterAuctionAfterAppeal(m, room, seat);
}

function auctionDone(m, seat, room) {
  if (seat < 0 || m.auction.high.num < 13) {
    if (m.round >= 10) { seat = finalAuctionRule(m.matchScores, m.mult).bottomSeat; m.auction.high = { num: m.auction.minBid || 13, suit: strongestSuit(m.seats[seat].hand), player: seat, solo: false }; m.notice = "オールラストは立ち必須。最下位が最低枚数で立ちます。"; }
    else { m.notice = "宣言なし。配り直します。"; m.phase = "redeal"; m.deadline = Date.now() + 1800; publish(m, room); return; }
  }
  const bs = defaultStrategy();
  const strengthAtBid = m.auction.high.suit === 'NT' ? ntHandStrength(m.seats[seat].hand, bs) : colorStrength(m.seats[seat].hand, m.auction.high.suit, bs);
  m.contract = { nap: seat, num: m.auction.high.num, suit: m.auction.high.suit, deputy: -1, call: null, solo: m.auction.high.solo === true, revealedCall: false, revealTrickNo: null, strengthAtBid };
  beginDiscard(m, seat, room);
}

function startPlay(m, room) {
  const c = m.contract;
  if (c.solo) c.deputy = c.nap;
  else { for (let i = 0; i < 5; i++) { const found = m.seats[i].hand.some(x => x.id === c.call.id); if (found) { c.deputy = i; break; } } if (c.deputy < 0) c.deputy = c.nap; }
  m.phase = "play"; m.trick = []; m.trickNo = 0; m.active = c.nap; m.deadline = Date.now() + 30000; m.humanAutoPlayAt = null;
  m.notice = "カードを出してください。マストフォローです。"; publish(m, room);
  if (m.seats[m.active].bot) botAction(m, room);
}

function beginDiscard(m, seat, room) {
  m.seats[seat].hand.push(...m.kitty); m.kitty = []; sortHand(m.seats[seat].hand);
  m.phase = "discard"; m.active = seat; m.deadline = Date.now() + 30000; m.humanAutoPlayAt = null;
  m.notice = "オープンの2枚を手札に入れ、2枚を捨ててください。"; publish(m, room);
  if (m.seats[seat].bot) botAction(m, room);
}

function callCard(m, seat, suit, rank, room) {
  if (m.phase !== "call" || m.active !== seat || !SUITS.includes(suit) || !RANKS.includes(rank)) return;
  const card = { suit, rank, id: suit + rank };
  if (m.kitty.some(x => x.id === card.id)) return;
  const isOwn = m.seats[seat].hand.some(c => c.id === card.id);
  const forceSolo = isSoloForcedInMatch(m);
  if ((m.contract.solo || forceSolo) && !isOwn) { m.notice = "ひとり立ちを選択しているため、自分の手札からのみ指名できます。"; publish(m, room); return; }
  m.contract.call = card; m.contract.solo = isOwn || m.contract.solo; m.contract.revealedCall = false;
  m.contract.ready = m.seats.map(p => p.bot);
  m.phase = "call-reveal"; m.active = seat; m.deadline = Date.now() + 15000; m.kitty = [];
  m.notice = suit + rank + "が指名されました。全員の確認後に開始します。"; publish(m, room);
}

function discardCards(m, seat, ids, room) {
  if (m.phase !== "discard" || m.active !== seat || !Array.isArray(ids) || ids.length !== 2 || new Set(ids).size !== 2 || (m.contract.solo && m.contract.call && ids.includes(m.contract.call.id))) return;
  const h = m.seats[seat].hand; if (ids.some(id => !h.some(c => c.id === id))) return;
  const removed = h.filter(c => ids.includes(c.id));
  m.seats[seat].hand = h.filter(c => !ids.includes(c.id));
  m.allianceKittyPoints = (m.allianceKittyPoints || 0) + removed.filter(c => ["10", "J", "Q", "K", "A"].includes(c.rank)).length;
  m.kitty = removed; m.discardedKitty = removed.slice(); sortHand(m.seats[seat].hand);
  m.phase = "call"; m.active = seat; m.deadline = Date.now() + 30000; m.humanAutoPlayAt = null;
  m.notice = "捨て札を決めました。副官に指名するカードを選んでください。"; publish(m, room);
  if (m.seats[seat].bot) botAction(m, room);
}

async function finish(m, room, env) {
  const finalRule = m.round >= 10 ? finalAuctionRule(m.matchScores, m.mult) : null;
  const nap = m.contract.nap, unit = Math.max(0, m.contract.num - 12) * m.mult * (m.round >= 10 ? 2 : 1);
  const team = m.contract.solo ? [nap] : Array.from(new Set([nap, m.contract.deputy]));
  const points = team.reduce((n, i) => n + m.seats[i].points, 0);
  const made = points >= m.contract.num && (m.contract.num === 20 || points < 20);
  const sign = made ? 1 : -1; const scores = Array(5).fill(0);

  m.matchStats[nap].declarerAttempts++;
  if (made) m.matchStats[nap].declarerSuccesses++;
  if (!m.contract.solo) { m.matchStats[m.contract.deputy].deputyAttempts++; if (made) m.matchStats[m.contract.deputy].deputySuccesses++; }
  if (m.contract.solo) { m.matchStats[nap].soloAttempts++; if (made) m.matchStats[nap].soloSuccesses++; }

  scores[nap] = sign * unit * (m.contract.solo ? 4 : 2);
  if (m.contract.solo) { for (let i = 0; i < 5; i++) if (i !== nap) scores[i] = -sign * unit; }
  else { scores[m.contract.deputy] = sign * unit; for (let i = 0; i < 5; i++) if (i !== nap && i !== m.contract.deputy) scores[i] = -sign * unit; }

  const art = m.roundArt.slice();
  if (made && points === m.contract.num) { art[nap] += 2; if (!m.contract.solo) art[m.contract.deputy] += 1; if (m.contract.num >= 15) { art[nap] += 2; if (!m.contract.solo) art[m.contract.deputy] += 1; } }
  if (m.contract.solo) { art[nap] += made ? 4 : 2; }
  if (!made && !m.contract.solo && m.contract.num - points >= 3) { art[nap] -= 2; art[m.contract.deputy] -= 1; }
  for (let i = 0; i < 5; i++) { m.matchScores[i] += scores[i]; m.matchArt[i] += art[i]; }

  m.matchContracts.push({ round: m.round, nap, deputy: m.contract.deputy, num: m.contract.num, suit: m.contract.suit, solo: !!m.contract.solo, points, napWin: made, revealTrickNo: m.contract.revealTrickNo ?? null, takenPoints: m.seats.map(s => s.roundPoints || 0), strengthAtBid: m.contract.strengthAtBid ?? 8, allianceKittyPoints: m.allianceKittyPoints || 0, mult: m.mult || 1 });
  const replayAllLast = !!(finalRule && scores[finalRule.bottomSeat] > 0 && m.matchScores[finalRule.bottomSeat] === m.matchScores[finalRule.fourthSeat]);
  const lastRound = m.round >= 10 && !replayAllLast;
  if (replayAllLast) m.playoff = true;

  m.result = {
    round: m.round, made, points, bid: m.contract.num, suit: m.contract.suit, solo: !!m.contract.solo, stake: unit,
    allianceKittyPoints: m.allianceKittyPoints || 0, lastTrickWinner: m.lastTrickWinner ?? null,
    lastTrickWinnerName: m.lastTrickWinner != null ? (m.seats[m.lastTrickWinner]?.bot ? m.seats[m.lastTrickWinner].player.username : (m.seats[m.lastTrickWinner]?.player.playerId || m.seats[m.lastTrickWinner]?.player.username)) : null,
    scoreChanges: scores.map((delta, seat) => ({ seat, delta, role: seat === nap ? "ナポレオン" : !m.contract.solo && seat === m.contract.deputy ? "副官" : "連合軍" })),
    artChanges: art.map((delta, seat) => ({ seat, delta })),
    winners: made ? team : m.seats.map((_, i) => i).filter(i => !team.includes(i)),
    matchScores: m.matchScores.slice(), matchArt: m.matchArt.slice(),
    allLastReplay: replayAllLast, playoff: !!m.playoff
  };

  m.phase = lastRound ? "result" : "round-result"; m.active = -1; m.deadline = lastRound ? 0 : Date.now() + 8000; m.humanAutoPlayAt = null;
  m.notice = replayAllLast ? "5位が4位に並びました。プレーオフを行います。" : lastRound ? "オールラスト終了。レートを集計しています。" : "第" + m.round + "局が終了しました。";
  if (!lastRound) { publish(m, room); return; }
  
  // ※Render無料版ではDB保存はスキップ
  publish(m, room); matches.delete(m.id);
  for (const seat of m.seats) { if (seat.connId) connMatch.delete(seat.connId); const userId = seat.player.userId; if (userId && rankedUsers.get(userId) === seat.originalConnId) rankedUsers.delete(userId); }
}

function playCard(m, seat, id, room, env) {
  if (m.phase !== "play" || m.active !== seat) return;
  const legal = legalCards(m, seat), card = legal.find(x => x.id === id);
  if (!card) return;
  if (!m.trick.length) m.lastTrickWinner = null;
  const hand = m.seats[seat].hand;
  hand.splice(hand.findIndex(x => x.id === id), 1);
  m.trick.push({ seat, card });
  m.playedCards.push({ suit: card.suit, rank: card.rank, id: card.id, seat: seat });

  if (m.trick.length > 1) { const ledSuit = m.trick[0].card.suit; if (card.suit !== ledSuit) { if (!m.voids[seat]) m.voids[seat] = {}; m.voids[seat][ledSuit] = true; } }
  const reveal = m.contract.call?.id === card.id && !m.contract.revealedCall;
  if (reveal) { m.contract.revealedCall = true; m.contract.revealTrickNo = m.trickNo; }

  m.humanAutoPlayAt = null;
  if (m.trick.length < 5) { m.active = (seat + 4) % 5; m.deadline = Date.now() + 30000; m.notice = "カードを出してください。"; publish(m, room); if (m.seats[m.active].bot) botAction(m, room); return; }

  const winningEntryObj = winningEntry(m.contract, m.trickNo, m.trick), w = winningEntryObj.seat;
  const taken = m.trick.filter(x => ["10", "J", "Q", "K", "A"].includes(x.card.rank)).map(x => x.card);
  
  m.seats[w].points += taken.length; m.seats[w].taken.push(...taken); m.seats[w].roundTaken.push(...taken);
  m.lastTrickWinner = w; m.active = w;
  const alliancePointsRaw = m.seats.reduce((n, p, i) => n + (i !== m.contract.nap && (m.contract.solo || i !== m.contract.deputy) ? p.points : 0), 0);
  const alliancePoints = alliancePointsRaw + (m.allianceKittyPoints || 0);
  const napPoints = m.seats.reduce((n, p, i) => n + (i === m.contract.nap || !m.contract.solo && i === m.contract.deputy ? p.points : 0), 0);
  m.earlyFinish = alliancePoints > 20 - m.contract.num || napPoints >= m.contract.num && (m.contract.num === 20 || alliancePoints >= 1);
  const isFinalTrick = m.trickNo >= 9;
  const willFinish = m.earlyFinish || isFinalTrick;

  m.notice = m.seats[w].player.username + "が場札を取りました。";
  m.phase = "trick-end"; m.deadline = willFinish ? Date.now() + 2200 : Date.now() + 1250; publish(m, room);
}

function botAuctionBid(m, seat, room) {
  m.botLevel = 3; const a = m.auction, version = a.version;
  if (a.botSeen[seat] >= version || !a.active.includes(seat)) return;
  a.botSeen[seat] = version;
  if (a.high.player === seat) { if (a.active.length === 1) auctionDone(m, seat, room); return; }
  const h = m.seats[seat].hand;
  const params = m.botStrategy || defaultStrategy();
  const currentBids = (m.bidHistory || []).filter(b => b.round === m.round);
  const bid = shouldBid(h, a.high, a.minBid || 13, params, currentBids, seat, null);
  if (bid && validBid(m, bid.num, bid.suit)) { a.botBids[seat]++; doBid(m, seat, bid.num, bid.suit, room, bid.solo === true); if (m.phase === "auction") a.botAt[seat] = Date.now() + 2500 + Math.random() * 1800; return; }
  if (a.high.player === seat) { if (a.active.length === 1) doApprove(m, seat, room); return; }
  doApprove(m, seat, room);
}

function botAction(m, room) {
  if (!m || m.phase === "result") return;
  m.botLevel = 3; const i = m.active, p = m.seats[i];
  if (!p?.bot) return;
  m.lastBot = Date.now();
  const params = m.botStrategy || defaultStrategy();
  
  if (m.phase === "auction") { botAuctionBid(m, i, room); return; }
  if (m.phase === "call") {
    if (m.contract.solo) { const chosen = chooseSoloCall(p.hand); if (chosen) callCard(m, i, chosen.suit, chosen.rank, room); return; }
    const forceSolo = isSoloForcedInMatch(m);
    if (forceSolo) { const chosen = p.hand.slice().sort((a, b) => RANKS.indexOf(a.rank) - RANKS.indexOf(b.rank))[0]; if (chosen) callCard(m, i, chosen.suit, chosen.rank, room); }
    else { const x = chooseDeputyCall(p.hand, m.kitty, m.contract.suit, m.botLevel || 2, m.contract.num, params, null); if (x) callCard(m, i, x.suit, x.rank, room); }
    return;
  }
  if (m.phase === "discard") { const drop = chooseDiscard(p.hand, m.contract.suit).map(x => x.id); discardCards(m, i, drop, room); return; }
  if (m.phase === "play") {
    const legal = legalCards(m, i);
    const deputyPts = (!m.contract.solo && m.contract.deputy >= 0) ? (m.seats[m.contract.deputy].points || 0) : 0;
    const currentNapPoints = (m.seats[m.contract.nap].points || 0) + deputyPts;
    const ctx = {
      hand: p.hand, legal, trick: m.trick, trickNo: m.trickNo, contract: m.contract,
      playedCards: m.playedCards, voids: m.voids, seat: i, deputy: m.contract.deputy,
      discardedKitty: m.discardedKitty || [], isMySideNap: i === m.contract.nap || (m.contract.revealedCall && i === m.contract.deputy),
      isCurrentNapWinning: m.trick.length ? (winningEntry(m.contract, m.trickNo, m.trick).seat === m.contract.nap || (!m.contract.solo && winningEntry(m.contract, m.trickNo, m.trick).seat === m.contract.deputy)) : false,
      isRevealed: m.contract.revealedCall, isNapLeading: m.trick.length > 0 && m.trick[0].seat === m.contract.nap,
      lastSeat: m.trick.length === 4, params, call: m.contract.call, currentNapPoints, experience: null
    };
    let c;
    if (i === m.contract.deputy && !m.contract.solo && m.contract.revealedCall) c = chooseDeputyCard(ctx);
    else c = chooseCardToPlay(ctx);
    if (!c || !legal.some(x => x.id === c.id)) c = legal[Math.floor(Math.random() * legal.length)];
    playCard(m, i, c.id, room, null);
  }
}

function nextRound(m, room) { if (m.phase !== "round-result") return; m.round++; m.mult = 1; m.redraws = 0; deal(m); publish(m, room); }

async function processAction(conn, msg, room, env) {
  const id = connMatch.get(conn.id), m = id && matches.get(id); if (!m) return;
  const seat = m.seats.findIndex(s => s.connId === conn.id); if (seat < 0) return;
  const a = msg.action || {};
  if (a.type === "appeal") return answerAppealOffer(m, seat, true, room);
  if (a.type === "skip-appeal") return answerAppealOffer(m, seat, false, room);
  if (a.type === "appeal-declare") return answerAppealResponse(m, seat, "declare", room);
  if (a.type === "appeal-stand") return answerAppealResponse(m, seat, "stand", room);
  if (a.type === "next-round") return nextRound(m, room);
  if (a.type === "auction-activity") { if (m.phase === "auction" && m.auction.active.includes(seat)) { m.auction.lastAction[seat] = Date.now(); m.auction.autoApprove[seat] = false; } return; }
  if (a.type === "confirm-call") { if (m.phase !== "call-reveal" || m.contract.ready[seat]) return; m.contract.ready[seat] = true; if (m.contract.ready.every((ready, i) => ready || m.seats[i].bot)) startPlay(m, room); else { m.notice = "指名カードの確認中です。"; publish(m, room); } return; }
  if (a.type === "approve" || a.type === "pass") doApprove(m, seat, room);
  else if (a.type === "bid") doBid(m, seat, Number(a.num), a.suit, room, a.solo === true);
  else if (a.type === "call") callCard(m, seat, a.suit, a.rank, room);
  else if (a.type === "discard") discardCards(m, seat, a.cards, room);
  else if (a.type === "play") playCard(m, seat, a.card, room, env);
}

function timeoutAction(m, room) {
  const i = m.active, p = m.seats[i]; const params = m.botStrategy || defaultStrategy();
  if (m.phase === "call") {
    if (m.contract.solo) { const chosen = chooseSoloCall(p.hand); if (chosen) callCard(m, i, chosen.suit, chosen.rank, room); return; }
    const forceSolo = isSoloForcedInMatch(m);
    if (forceSolo) { const chosen = p.hand.slice().sort((a, b) => RANKS.indexOf(a.rank) - RANKS.indexOf(b.rank))[0]; if (chosen) callCard(m, i, chosen.suit, chosen.rank, room); }
    else { const x = chooseDeputyCall(p.hand, m.kitty, m.contract.suit, m.botLevel || 2, m.contract.num, params, null); if (x) callCard(m, i, x.suit, x.rank, room); }
  } else if (m.phase === "discard") {
    const ids = p.hand.slice().sort((a, b) => RANKS.indexOf(a.rank) - RANKS.indexOf(b.rank)).slice(0, 2).map(x => x.id);
    discardCards(m, i, ids, room);
  } else if (m.phase === "play") {
    const c = legalCards(m, i).slice().sort((a, b) => RANKS.indexOf(a.rank) - RANKS.indexOf(b.rank))[0];
    if (c) playCard(m, i, c.id, room, null);
  }
}

// ==========================================
// WebSocket サーバーの起動
// ==========================================
const server = http.createServer((req, res) => {
  if (req.url === '/healthz') { res.writeHead(200, { 'content-type': 'text/plain' }); res.end('OK'); return; }
  res.writeHead(404); res.end();
});

const wss = new WebSocketServer({ server, path: '/ws' });

wss.on('connection', (ws) => {
  const id = crypto.randomUUID();
  const conn = {
    id,
    send: (msg) => { try { ws.send(typeof msg === 'string' ? msg : JSON.stringify(msg)); } catch {} },
    close: (code, reason) => { try { ws.close(code, reason); } catch {} }
  };
  conns.set(id, conn);
  sendSafe(conn, { type: "connected" });
  sendSafe(conn, { type: "presence", count: conns.size });

  ws.on('message', async (raw) => {
    const env = {}; // DBなしのダミー環境
    let msg; try { msg = JSON.parse(raw.toString()); } catch { return; }

    if (msg.type === "join") {
      const mode = msg.mode === "ranked" ? "ranked" : "friend";
      let player;
      try { player = await getProfile(env, conn); } catch (e) { sendSafe(conn, { type: "room-error", message: "エラー" }); return; }
      
      const entry = { id: conn.id, player, conn, joined: Date.now(), code: String(msg.code || "").toUpperCase().slice(0, 8), bots: 0, botLevel: 3 };
      
      if (mode === "ranked") {
        queues.ranked.push(entry);
        sendSafe(conn, { type: "lobby", text: "対戦相手を検索中 · " + queues.ranked.length + "/5人" });
        if (queues.ranked.length >= 5) beginMatch("ranked", "", queues.ranked.splice(0, 5), null, env);
        return;
      }
      
      // 友達対戦（待機部屋）
      if (!entry.code) entry.code = makeCode();
      let l = friendRooms.get(entry.code);
      if (!l) {
        l = { code: entry.code, host: conn.id, players: [], created: Date.now(), timeoutAt: Date.now() + 60000 }; // 60秒タイムアウト
        friendRooms.set(entry.code, l);
      }
      
      if (l.players.length >= 5) { sendSafe(conn, { type: "room-error", message: "この部屋は満員です" }); return; }
      
      l.players.push(entry);
      
      // ロビー状態の更新を全員に送る
      l.players.forEach(x => sendSafe(x.conn, { type: "friend-lobby", code: l.code, count: l.players.length, host: x.id === l.host }));
      
      // 5人揃ったら即開始
      if (l.players.length >= 5) {
        friendRooms.delete(l.code);
        beginMatch("friend", l.code, l.players, null, env);
      }
      return;
    }

    if (msg.type === "start-now") {
      let roomCode = null;
      for (const [code, l] of friendRooms) {
        if (l.host === conn.id) { roomCode = code; break; }
      }
      if (roomCode) {
        const l = friendRooms.get(roomCode);
        friendRooms.delete(roomCode);
        beginMatch("friend", l.code, l.players, null, env);
      }
      return;
    }

    if (msg.type === "leave-room") {
      for (const [c, l] of friendRooms) {
        l.players = l.players.filter(x => x.id !== conn.id);
        if (!l.players.length) friendRooms.delete(c);
        else l.players.forEach(x => sendSafe(x.conn, { type: "friend-lobby", code: l.code, count: l.players.length, host: x.id === l.host }));
      }
      return;
    }

    if (msg.type === "game") return processAction(conn, msg, null, env);
  });

  ws.on('close', () => {
    conns.delete(conn.id);
    const id = connMatch.get(conn.id);
    if (id) {
      const m = matches.get(id);
      if (m) {
        const s = m.seats.find(x => x.connId === conn.id);
        if (s) { s.bot = true; s.connId = null; s.player.username = "COM"; }
        publish(m, null);
      }
    }
  });
});

setInterval(async () => {
  const now = Date.now();
  
  // ★待機部屋のタイムアウト処理
  for (const [code, l] of friendRooms) {
    if (now >= l.timeoutAt) {
      friendRooms.delete(code);
      if (l.players.length > 0) {
        beginMatch("friend", l.code, l.players, null, {}); // 足りない席はCOMで埋まる
      }
    }
  }

  if (queues.ranked.length && now - queues.ranked[queues.ranked.length - 1].joined >= 90000) { const group = queues.ranked.splice(0, Math.min(4, queues.ranked.length)); beginMatch("ranked", "", group, null, {}); }
  
  for (const m of matches.values()) {
    if (m.phase === "prep" && now >= m.deadline) {
      const rule = m.round >= 10 ? finalAuctionRule(m.matchScores, m.mult) : null;
      m.phase = "auction";
      m.auction = { active: rule ? rule.eligible : [0, 1, 2, 3, 4], minBid: rule?.minBid || 13, high: { num: 12, suit: "", player: -1, solo: false }, version: 0, startedAt: now, lastAction: Array(5).fill(now), autoApprove: Array(5).fill(false), botBids: Array(5).fill(0), botSeen: Array(5).fill(-1), botAt: m.seats.map(() => now + 500 + Math.random() * 2200), requiredBidSeat: null };
      m.active = -1; m.deadline = 0;
      if (rule) { m.appeal = { bottomSeat: rule.bottomSeat, fourthSeat: rule.fourthSeat }; m.appealInfo = ""; m.phase = "appeal-offer"; m.active = rule.bottomSeat; m.deadline = now + 30000; m.notice = "5位は4位にJ・マイティの所持を尋ねられます。"; publish(m, null); if (m.seats[rule.bottomSeat].bot) answerAppealOffer(m, rule.bottomSeat, true, null); }
      else { m.appeal = null; m.appealInfo = ""; m.notice = "競り開始です。宣言するか、承認して競りを降りてください。"; publish(m, null); }
    } else if (m.phase === "appeal-offer") { if (now >= m.deadline) answerAppealOffer(m, m.appeal.bottomSeat, false, null); }
    else if (m.phase === "appeal-response") { if (m.seats[m.active]?.bot) answerAppealResponse(m, m.active, "declare", null); else if (now >= m.deadline) answerAppealResponse(m, m.active, "stand", null); }
    else if (m.phase === "auction") {
      for (const seat of m.auction.active.slice()) { if (!m.seats[seat].bot && !m.auction.autoApprove[seat] && now - (m.auction.lastAction[seat] || m.auction.startedAt) >= 30000) doApprove(m, seat, null, true); if (m.phase !== "auction") break; }
      for (let seat = 0; seat < m.seats.length && m.phase === "auction"; seat++) { if (m.seats[seat].bot && m.auction.active.includes(seat) && m.auction.botSeen[seat] < m.auction.version && now >= m.auction.botAt[seat]) botAuctionBid(m, seat, null); }
    } else if (m.phase === "call-reveal") { if (now >= m.deadline) startPlay(m, null); }
    else if (m.phase === "call" || m.phase === "discard") {
      if (m.seats[m.active]?.bot && now - m.lastBot > 850) botAction(m, null);
      else if (m.deadline && now >= m.deadline) { m.notice = "持ち時間が切れたため、自動で進行します。"; timeoutAction(m, null); }
    } else if (m.phase === "play") {
      const activeSeat = m.active;
      if (m.seats[activeSeat]?.bot) { if (now - m.lastBot > 850) botAction(m, null); }
      else {
        const legal = legalCards(m, activeSeat);
        if (legal.length === 1) {
          if (!m.humanAutoPlayAt) m.humanAutoPlayAt = now + 1500;
          else if (now >= m.humanAutoPlayAt) { m.humanAutoPlayAt = null; m.notice = "出すカードが1枚しかないため、自動で出します。"; publish(m, null); playCard(m, activeSeat, legal[0].id, null, {}); }
        } else {
          m.humanAutoPlayAt = null;
          if (m.deadline && now >= m.deadline) { m.notice = "持ち時間が切れたため、自動で進行します。"; timeoutAction(m, null); }
        }
      }
    } else if (m.phase === "round-result" && now >= m.deadline) { nextRound(m, null); }
    else if (m.phase === "trick-end" && now >= m.deadline) {
      if (m.earlyFinish) { await finish(m, null, {}); continue; }
      m.trickNo++;
      if (m.trickNo >= 10) await finish(m, null, {});
      else { m.trick = []; m.phase = "play"; m.deadline = Date.now() + 30000; m.humanAutoPlayAt = null; m.notice = "次の勝負です。"; publish(m, null); if (m.seats[m.active].bot) botAction(m, null); }
    } else if (m.phase === "redeal" && now >= m.deadline) { deal(m); publish(m, null); }
  }
}, 500);

const SELF_URL = process.env.RENDER_EXTERNAL_URL || `http://localhost:${process.env.PORT || 3000}`;
setInterval(() => { fetch(`${SELF_URL}/healthz`).catch(() => {}); }, 10 * 60 * 1000);

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`WebSocket server listening on port ${PORT}`));
