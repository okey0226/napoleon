// ============================================================
// worker/room.js
// 依存: worker/state.js, worker/match.js, worker/match-state.js
// 役割: WebSocket 接続・メッセージ・tick・切断の処理
// ============================================================
import {
  queues, rankedUsers, conns, friendRooms, matches, connMatch,
  sendSafe, makeCode
} from './state.js';
import {
  beginMatch, processAction, publish, getProfile,
  answerAppealOffer, answerAppealResponse, doApprove,
  botAuctionBid, startPlay, botAction, timeoutAction,
  nextRound, finish, deal
} from './match.js';
import { finalAuctionRule } from './match-state.js';

export const room = {
  tickMs: 500,

  async onConnect(conn, room) {
    if (conns.size >= 180) {
      conn.close(4003, 'Room capacity reached');
      return;
    }
    conns.set(conn.id, conn);
    sendSafe(conn, { type: 'connected' });
    const presence = { type: 'presence', count: conns.size };
    sendSafe(conn, presence);
    room.broadcast(presence, { except: [conn.id] });
  },

  async onMessage(conn, raw, room, env) {
    let msg;
    try { msg = typeof raw === 'string' ? JSON.parse(raw) : raw; }
    catch { return; }

    if (msg.type === 'join') {
      if (msg.sessionToken) {
        const sess = await env.DB.prepare(
          'SELECT user_id FROM sessions WHERE token=? AND expires_at>?'
        ).bind(msg.sessionToken, Date.now()).first();
        if (sess) conn.authUserId = sess.user_id;
      }
      const mode = msg.mode === 'ranked' ? 'ranked' : 'friend';

      if (mode === 'ranked' && conn.authUserId && rankedUsers.has(conn.authUserId)) {
        sendSafe(conn, { type: 'room-error', message: 'このアカウントはすでに待機中または対戦中です' });
        return;
      }
      if (mode === 'ranked' && conn.authUserId) rankedUsers.set(conn.authUserId, conn.id);
      if (connMatch.has(conn.id)) {
        if (mode === 'ranked' && conn.authUserId && rankedUsers.get(conn.authUserId) === conn.id) {
          rankedUsers.delete(conn.authUserId);
        }
        return;
      }

      let player;
      try { player = await getProfile(env, conn); }
      catch (error) {
        if (mode === 'ranked' && conn.authUserId && rankedUsers.get(conn.authUserId) === conn.id) {
          rankedUsers.delete(conn.authUserId);
        }
        sendSafe(conn, { type: 'room-error', message: 'プレイヤー情報を確認できませんでした。再度お試しください' });
        return;
      }
      if (!conns.has(conn.id)) {
        if (mode === 'ranked' && conn.authUserId && rankedUsers.get(conn.authUserId) === conn.id) {
          rankedUsers.delete(conn.authUserId);
        }
        return;
      }

      const entry = {
        id: conn.id, player, conn, joined: Date.now(),
        code: String(msg.code || '').toUpperCase().slice(0, 8),
        bots: Math.max(1, Math.min(4, Number(msg.bots) || 4)),
        botLevel: Math.max(1, Math.min(3, Math.floor(Number(msg.botLevel) || 2)))
      };

      if (mode === 'ranked') {
        queues.ranked.push(entry);
        queues.ranked.sort((a, b) => a.joined - b.joined);
        sendSafe(conn, { type: 'lobby', text: '対戦相手を検索中 · ' + queues.ranked.length + '/5人' });
        if (queues.ranked.length >= 5) beginMatch('ranked', '', queues.ranked.splice(0, 5), room, env);
        return;
      }

      if (!entry.code) entry.code = makeCode();
      let l = friendRooms.get(entry.code);
      if (!l) {
        l = { code: entry.code, host: conn.id, bots: entry.bots, botLevel: entry.botLevel, players: [], created: Date.now() };
        friendRooms.set(entry.code, l);
      }
      if (l.players.some(x => x.id === conn.id || (player.userId && x.player.userId === player.userId))) {
        sendSafe(conn, { type: 'room-error', message: 'このプレイヤーはすでに部屋にいます' });
        return;
      }
      const cap = Math.max(1, 5 - l.bots);
      if (l.players.length >= cap) {
        sendSafe(conn, { type: 'room-error', message: 'この部屋は満員です' });
        return;
      }
      l.players.push(entry);
      l.players.forEach(x => sendSafe(x.conn, {
        type: 'friend-lobby', code: l.code, count: l.players.length,
        capacity: cap, bots: l.bots, host: x.id === l.host
      }));
      sendSafe(conn, { type: 'lobby', text: '合言葉 ' + l.code + ' · ' + l.players.length + '/' + cap + '人' });
      if (l.players.length >= cap) {
        friendRooms.delete(l.code);
        beginMatch('friend', l.code, l.players, room, env);
      }
      return;
    }

    if (msg.type === 'cancel-queue') {
      const idx = queues.ranked.findIndex(x => x.id === conn.id);
      if (idx >= 0) {
        queues.ranked.splice(idx, 1);
        if (conn.authUserId && rankedUsers.get(conn.authUserId) === conn.id) rankedUsers.delete(conn.authUserId);
      }
      sendSafe(conn, { type: 'queue-cancelled' });
      return;
    }

    if (msg.type === 'game') return processAction(conn, msg, room, env);
  },

  async onTick(room, env) {
    const now = Date.now();

    // ランキング待機の自動マッチ
    const rq = queues.ranked;
    if (rq.length && now - rq[rq.length - 1].joined >= 90000) {
      const group = rq.splice(0, Math.min(4, rq.length));
      beginMatch('ranked', '', group, room, env);
    }

    // 友達部屋の期限切れ
    for (const [c, l] of friendRooms) {
      if (now - l.created > 900000) friendRooms.delete(c);
    }

    // 各マッチの進行
    for (const m of matches.values()) {
      if (m.phase === 'prep' && now >= m.deadline) {
        const rule = m.round >= 10 ? finalAuctionRule(m.matchScores, m.mult) : null;
        m.phase = 'auction';
        m.auction = {
          active: rule ? rule.eligible : [0, 1, 2, 3, 4],
          minBid: rule?.minBid || 13,
          high: { num: 12, suit: '', player: -1, solo: false },
          version: 0, startedAt: now,
          lastAction: Array(5).fill(now),
          autoApprove: Array(5).fill(false),
          botBids: Array(5).fill(0),
          botSeen: Array(5).fill(-1),
          botAt: m.seats.map(() => now + 500 + Math.random() * 2200),
          requiredBidSeat: null
        };
        m.active = -1;
        m.deadline = 0;
        if (rule) {
          m.appeal = { bottomSeat: rule.bottomSeat, fourthSeat: rule.fourthSeat };
          m.appealInfo = '';
          m.phase = 'appeal-offer';
          m.active = rule.bottomSeat;
          m.deadline = now + 30000;
          m.notice = '5位は4位にJ・マイティの所持を尋ねられます。';
          publish(m, room);
          if (m.seats[rule.bottomSeat].bot) answerAppealOffer(m, rule.bottomSeat, true, room);
        } else {
          m.appeal = null;
          m.appealInfo = '';
          m.notice = '競り開始です。宣言するか、承認して競りを降りてください。';
          publish(m, room);
        }
      }
      else if (m.phase === 'appeal-offer') {
        if (now >= m.deadline) answerAppealOffer(m, m.appeal.bottomSeat, false, room);
      }
      else if (m.phase === 'appeal-response') {
        if (m.seats[m.active]?.bot) answerAppealResponse(m, m.active, 'declare', room);
        else if (now >= m.deadline) answerAppealResponse(m, m.active, 'stand', room);
      }
      else if (m.phase === 'auction') {
        for (const seat of m.auction.active.slice()) {
          if (!m.seats[seat].bot && !m.auction.autoApprove[seat]
            && now - (m.auction.lastAction[seat] || m.auction.startedAt) >= 30000) {
            doApprove(m, seat, room, true);
          }
          if (m.phase !== 'auction') break;
        }
        for (let seat = 0; seat < m.seats.length && m.phase === 'auction'; seat++) {
          if (m.seats[seat].bot && m.auction.active.includes(seat)
            && m.auction.botSeen[seat] < m.auction.version
            && now >= m.auction.botAt[seat]) {
            botAuctionBid(m, seat, room);
          }
        }
      }
      else if (m.phase === 'call-reveal') {
        if (now >= m.deadline) startPlay(m, room);
      }
      else if (m.phase === 'call' || m.phase === 'discard' || m.phase === 'play') {
        if (m.seats[m.active]?.bot && now - m.lastBot > 850) botAction(m, room);
        else if (m.deadline && now >= m.deadline) {
          m.notice = '持ち時間が切れたため、自動で進行します。';
          timeoutAction(m, room);
        }
      }
      else if (m.phase === 'round-result' && now >= m.deadline) {
        nextRound(m, room);
      }
      else if (m.phase === 'trick-end' && now >= m.deadline) {
        if (m.earlyFinish) { await finish(m, room, env); continue; }
        m.trickNo++;
        if (m.trickNo >= 10) {
          await finish(m, room, env);
        } else {
          m.trick = [];
          m.phase = 'play';
          m.deadline = Date.now() + 30000;
          m.notice = '次の勝負です。';
          publish(m, room);
          if (m.seats[m.active].bot) botAction(m, room);
        }
      }
      else if (m.phase === 'redeal' && now >= m.deadline) {
        deal(m);
        publish(m, room);
      }
    }
  },

  async onClose(conn, room) {
    const id = connMatch.get(conn.id);
    conns.delete(conn.id);
    queues.ranked.splice(0, queues.ranked.length, ...queues.ranked.filter(x => x.id !== conn.id));
    const uid = conn.authUserId || conn.userId;
    if (uid && rankedUsers.get(uid) === conn.id) rankedUsers.delete(uid);
    for (const [c, l] of friendRooms) {
      l.players = l.players.filter(x => x.id !== conn.id);
      if (!l.players.length) friendRooms.delete(c);
    }
    connMatch.delete(conn.id);
    if (id) {
      const m = matches.get(id);
      if (m) {
        const s = m.seats.find(x => x.connId === conn.id);
        if (s) {
          s.bot = true;
          s.connId = null;
          s.player.username = 'COM';
          s.player.playerId = 'COM';
          if (m.kind === 'ranked') s.player.userId = null;
        }
        publish(m, room);
      }
    }
    const presence = { type: 'presence', count: conns.size };
    room.broadcast(presence);
  }
};
