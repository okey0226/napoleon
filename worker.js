function callCard(m, seat, suit, rank, room) {
  if (m.phase !== "call" || m.active !== seat || !SUITS.includes(suit) || !RANKS.includes(rank)) return;
  const card = { suit, rank, id: suit + rank };
  if (m.kitty.some(x => x.id === card.id)) return;
  const isOwn = m.seats[seat].hand.some(c => c.id === card.id);
  const forceSolo = isSoloForcedInMatch(m);
  if ((m.contract.solo || forceSolo) && !isOwn) {
    m.notice = "ひとり立ちを選択しているため、自分の手札からのみ指名できます。";
    publish(m, room);
    return;
  }
  m.contract.call = card;
  m.contract.solo = isOwn || m.contract.solo;
  m.contract.revealedCall = false;
  m.contract.ready = m.seats.map(p => p.bot);
  m.phase = "call-reveal";
  m.active = seat;
  m.deadline = Date.now() + 15000;
  m.kitty = [];
  m.notice = suit + rank + "が指名されました" + (m.contract.solo ? "（ひとり立ち）" : "") + "。全員の確認後に開始します。";
  publish(m, room);
}

function discardCards(m, seat, ids, room) {
  if (m.phase !== "discard" || m.active !== seat || !Array.isArray(ids) || ids.length !== 2 || new Set(ids).size !== 2) return;
  if (m.contract.solo && m.contract.call && ids.includes(m.contract.call.id)) return;
  const h = m.seats[seat].hand;
  if (ids.some(id => !h.some(c => c.id === id))) return;
  const removed = h.filter(c => ids.includes(c.id));
  m.seats[seat].hand = h.filter(c => !ids.includes(c.id));

  // ============================================================
  // 試合スコア: 捨て札の得点札は「連合軍」に加算（ナポレオン軍には加算しない）
  // ============================================================
  const kittyPoints = removed.filter(c => POINT.includes(c.rank));
  m.kittyAlliancePoints = (m.kittyAlliancePoints || 0) + kittyPoints.length;
  m.kitty = removed;
  sortHand(m.seats[seat].hand);

  m.phase = "call";
  m.active = seat;
  m.deadline = Date.now() + 30000;
  m.notice = "捨て札を決めました（得点札 " + kittyPoints.length + "枚は連合軍に加算）。副官に指名するカードを選んでください。";
  publish(m, room);
  if (m.seats[seat].bot) botAction(m, room);
}

// ============================================================
// レート計算（SIM RATE）— 試合スコアとは独立
// ナポレオン・副官は旧式のまま（AIの目指す強さを変えない）
// 連合軍のみ -(nap+deputy)/人数 でゼロサム化。旧4.4項は廃止。
// マッチ全体で平均を引いて丸め誤差を吸収（合計0を保証）。
// ============================================================
function matchRatingChanges(scores, art, ratings, matchStats, contracts) {
  const meanArt = art.reduce((n, x) => n + x, 0) / 5;
  const cs = contracts || [];
  const raw = scores.map((score, seat) => {
    let delta = 0;
    const rounds = [];
    for (const c of cs) {
      const safeStrength = Number.isFinite(c.strengthAtBid) ? c.strengthAtBid : 8;
      const p = estimatedWinRate(safeStrength, c.num);
      const diff = Math.max(0, c.num - 12);
      const highBoost = 1 + 0.5 * Math.max(0, c.num - 17);
      const soloMult = c.solo ? 1.5 : 1.0;
      const maxHonest = findMaxHonestBid(safeStrength);
      const bluffGap = Math.max(0, c.num - maxHonest);
      const isHonest = bluffGap === 0;
      const actual = c.napWin ? 1 : 0;

      // --- ナポレオン（旧式維持）---
      let napDelta;
      if (c.napWin) {
        napDelta = ((1 - p) * diff * 8 + sweetSpotFactor(p) * SWEET_SPOT_BONUS * highBoost) * soloMult;
        if (c.points > c.num) napDelta -= (c.points - c.num) * 0.3;
        if (isHonest) napDelta += 0.75;
      } else {
        napDelta = -p * diff * 8 * soloMult;
        if (!isHonest) napDelta -= bluffGap * 2.0;
      }

      // --- 副官（旧式維持）---
      let deputyDelta = 0;
      if (!c.solo) {
        deputyDelta = (actual - p) * diff * 3.2;
        if (c.napWin && c.revealTrickNo != null) deputyDelta += Math.max(0, c.revealTrickNo - 3) * 0.3;
      }

      // --- 連合軍（ゼロサム化）---
      const allianceCount = c.solo ? 4 : 3;
      const allyDelta = -(napDelta + deputyDelta) / allianceCount;

      let roundDelta = 0;
      let role = 'ally';
      if (seat === c.nap) { roundDelta = napDelta; role = 'nap'; }
      else if (!c.solo && seat === c.deputy) { roundDelta = deputyDelta; role = 'dep'; }
      else { roundDelta = allyDelta; role = 'ally'; }

      delta += Number.isFinite(roundDelta) ? roundDelta : 0;
      rounds.push({ bid: c.num, role, delta: Math.round(roundDelta * 100) / 100 });
    }
    delta += (art[seat] - meanArt) * 0.3;
    const rank = 1 + scores.filter(x => x > score).length;
    if (rank === 1) delta += 0.5;
    else if (rank === 5) delta -= 0.5;
    const outcome = score > 0 ? 'win' : score < 0 ? 'loss' : 'draw';
    return { seat, delta, placement: rank, art: art[seat] - meanArt, outcome, breakdown: { rounds, rank } };
  });

  // ゼロサム化: 平均を引いて丸め誤差を吸収
  const total = raw.reduce((s, d) => s + d.delta, 0);
  const adj = total / 5;
  return raw.map(d => ({ ...d, delta: Math.round((d.delta - adj) * 10) / 10 }));
}

async function finish(m, room, env) {
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

  // 試合スコア: napPts はトリック点のみ（捨て札の得点札は含まれない）
  const points = team.reduce((n, i) => n + m.seats[i].points, 0);
  const made = points >= m.contract.num && (m.contract.num === 20 || points < 20);

  const sign = made ? 1 : -1;
  const scores = Array(5).fill(0);

  m.matchStats[nap].declarerAttempts++;
  m.matchStats[nap].bidTotal = (m.matchStats[nap].bidTotal || 0) + m.contract.num;
  if (m.contract.suit === "NT") m.matchStats[nap].ntBids = (m.matchStats[nap].ntBids || 0) + 1;
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
    round: m.round, nap, deputy: m.contract.deputy,
    num: m.contract.num, suit: m.contract.suit, solo: !!m.contract.solo,
    points, napWin: made,
    revealTrickNo: m.contract.revealTrickNo ?? null,
    takenPoints: m.seats.map(s => s.roundPoints || 0),
    kittyAlliancePoints: m.kittyAlliancePoints || 0,
    strengthAtBid: m.contract.strengthAtBid ?? 8
  });

  const replayAllLast = !!(finalRule && scores[finalRule.bottomSeat] > 0 && m.matchScores[finalRule.bottomSeat] === m.matchScores[finalRule.fourthSeat]);
  const lastRound = m.round >= 10 && !replayAllLast;
  if (replayAllLast) m.playoff = true;

  m.result = {
    round: m.round, made, points,
    bid: m.contract.num, suit: m.contract.suit, solo: !!m.contract.solo,
    stake: unit,
    kittyAlliancePoints: m.kittyAlliancePoints || 0,
    scoreChanges: scores.map((delta, seat) => ({
      seat, delta,
      role: seat === nap ? "ナポレオン" : !m.contract.solo && seat === m.contract.deputy ? "副官" : "連合軍"
    })),
    artChanges: art.map((delta, seat) => ({ seat, delta })),
    winners: made ? team : m.seats.map((_, i) => i).filter(i => !team.includes(i)),
    matchScores: m.matchScores.slice(),
    matchArt: m.matchArt.slice(),
    allLastReplay: replayAllLast,
    playoff: !!m.playoff
  };

  m.phase = lastRound ? "result" : "round-result";
  m.active = -1;
  m.deadline = lastRound ? 0 : Date.now() + 8000;
  m.notice = replayAllLast
    ? "5位が4位に並びました。プレーオフを行います。"
    : lastRound
      ? "オールラスト終了。レートを集計しています。"
      : "第" + m.round + "局が終了しました。";

  if (!lastRound) { publish(m, room); return; }

  const ratingChanges = matchRatingChanges(
    m.matchScores, m.matchArt,
    m.seats.map(seat => Number(seat.player.rating) || 1000),
    m.matchStats, m.matchContracts
  );
  m.result.ratingChanges = ratingChanges;

  const placementOrder = m.matchScores.map((score, seat) => ({ score, seat })).sort((a, b) => b.score - a.score || a.seat - b.seat);
  const placementBySeat = [];
  placementOrder.forEach((entry, index) => placementBySeat[entry.seat] = index + 1);

  if (m.kind === "ranked") {
    const userIds = [...new Set(m.seats.map(seat => seat.player.userId).filter(Boolean))];
    const updates = [];
    if (userIds.length) {
      try {
        const placeholders = userIds.map(() => "?").join(",");
        const { results: profiles } = await env.DB.prepare("SELECT user_id,username,rating FROM players WHERE user_id IN (" + placeholders + ")").bind(...userIds).all();
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
            env.DB.prepare("UPDATE players SET rating=?,wins=wins+?,losses=losses+?,games=games+1 WHERE user_id=?").bind(rating, outcome === "win" ? 1 : 0, outcome === "loss" ? 1 : 0, profile.user_id),
            env.DB.prepare("INSERT INTO match_history(user_id,username,result,delta,rating_after) VALUES(?,?,?,?,?)").bind(profile.user_id, profile.username, outcome, change.delta, rating),
            env.DB.prepare("INSERT OR IGNORE INTO player_stats(user_id) VALUES(?)").bind(profile.user_id),
            env.DB.prepare("UPDATE player_stats SET exact_wins=exact_wins+?,bold_exact_wins=bold_exact_wins+?,solo_wins=solo_wins+?,dramatic_plays=dramatic_plays+? WHERE user_id=?").bind(stat.exactWins, stat.boldExactWins, stat.soloWins, stat.dramaticPlays, profile.user_id),
            env.DB.prepare("INSERT INTO player_performance(user_id,declarer_attempts,declarer_successes,deputy_attempts,deputy_successes) VALUES(?,?,?,?,?) ON CONFLICT(user_id) DO UPDATE SET declarer_attempts=declarer_attempts+excluded.declarer_attempts,declarer_successes=declarer_successes+excluded.declarer_successes,deputy_attempts=deputy_attempts+excluded.deputy_attempts,deputy_successes=deputy_successes+excluded.deputy_successes").bind(profile.user_id, stat.declarerAttempts, stat.declarerSuccesses, stat.deputyAttempts, stat.deputySuccesses),
            env.DB.prepare("INSERT INTO player_precision(user_id,exact_attempts,exact_successes,solo_attempts,solo_successes) VALUES(?,?,?,?,?) ON CONFLICT(user_id) DO UPDATE SET exact_attempts=exact_attempts+excluded.exact_attempts,exact_successes=exact_successes+excluded.exact_successes,solo_attempts=solo_attempts+excluded.solo_attempts,solo_successes=solo_successes+excluded.solo_successes").bind(profile.user_id, stat.exactAttempts, stat.exactSuccesses, stat.soloAttempts, stat.soloSuccesses),
            env.DB.prepare("INSERT INTO player_art_rate(user_id,attempts,plays) VALUES(?,?,?) ON CONFLICT(user_id) DO UPDATE SET attempts=attempts+excluded.attempts,plays=plays+excluded.plays").bind(profile.user_id, stat.artAttempts, stat.dramaticPlays),
            env.DB.prepare("INSERT INTO player_ally_feed(user_id,attempts,successes) VALUES(?,?,?) ON CONFLICT(user_id) DO UPDATE SET attempts=attempts+excluded.attempts,successes=successes+excluded.successes").bind(profile.user_id, stat.allyFeedAttempts, stat.allyFeedSuccesses),
            env.DB.prepare("INSERT INTO player_bold_bid_rate(user_id,attempts,successes) VALUES(?,?,?) ON CONFLICT(user_id) DO UPDATE SET attempts=attempts+excluded.attempts,successes=successes+excluded.successes").bind(profile.user_id, stat.boldAttempts, stat.boldSuccesses),
            env.DB.prepare("INSERT INTO player_match_stats(user_id,declarer_attempts,bid_total,nt_bids,color_bids,match_count,rank_1,rank_2,rank_3,rank_4,rank_5) VALUES(?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(user_id) DO UPDATE SET declarer_attempts=declarer_attempts+excluded.declarer_attempts,bid_total=bid_total+excluded.bid_total,nt_bids=nt_bids+excluded.nt_bids,color_bids=color_bids+excluded.color_bids,match_count=match_count+1,rank_1=rank_1+excluded.rank_1,rank_2=rank_2+excluded.rank_2,rank_3=rank_3+excluded.rank_3,rank_4=rank_4+excluded.rank_4,rank_5=rank_5+excluded.rank_5").bind(profile.user_id, stat.declarerAttempts, stat.bidTotal || 0, stat.ntBids || 0, stat.colorBids || 0, 1, ...Array.from({ length: 5 }, (_, index) => placementBySeat[seat] === index + 1 ? 1 : 0))
          );
          updates.push({ connId: player.connId, change, rating, outcome });
        }
        if (statements.length) await env.DB.batch(statements);
      } catch (error) {
        console.error("ranked match settlement failed", m.id, error);
        m.result.rateSaveFailed = true;
      }
      if (!m.result.rateSaveFailed) for (const update of updates) {
        try {
          sendSafe(conns.get(update.connId), {
            type: "rating-updated",
            result: update.outcome,
            delta: update.change.delta,
            rating: update.rating,
            placement: update.change.placement,
            art: update.change.art,
            breakdown: update.change.breakdown
          });
        } catch (error) { console.warn("rating notification failed", m.id, error); }
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

function artfulCard(m, entry, trick) {
  const c = entry.card;
  const led = trick[0].card.suit;
  const black = s => s === "♣" || s === "♠";
  return c.id === "♠A"
    || c.id === "♥Q" && trick.some(x => x.card.id === "♠A")
    || c.rank === "J" && m.contract.suit !== "NT" && (c.suit === m.contract.suit || c.suit !== m.contract.suit && black(c.suit) === black(m.contract.suit))
    || c.rank === "2" && c.suit === led && trick.every(x => x.card.suit === led);
}

function playCard(m, seat, id, room, env) {
  if (m.phase !== "play" || m.active !== seat) return;
  const legal = legalCards(m, seat);
  const card = legal.find(x => x.id === id);
  if (!card) return;
  if (!m.trick.length) m.lastTrickWinner = null;
  const previous = m.trick.length ? winningEntry(m.contract, m.trickNo, m.trick) : null;
  const hand = m.seats[seat].hand;
  const teamOf = i => i === m.contract.nap || !m.contract.solo && i === m.contract.deputy ? "nap" : "alliance";
  const feedOpportunity = !!(previous && previous.seat !== seat && m.contract.revealedCall
    && teamOf(previous.seat) === teamOf(seat)
    && legal.some(x => FACE.includes(x.rank)));
  const feedCard = feedOpportunity && FACE.includes(card.rank);

  hand.splice(hand.findIndex(x => x.id === id), 1);
  m.trick.push({ seat, card, feedOpportunity, feedCard });
  m.playedCards.push({ suit: card.suit, rank: card.rank, id: card.id, seat: seat });
  if (m.trick.length > 1) {
    const ledSuit = m.trick[0].card.suit;
    if (card.suit !== ledSuit) {
      if (!m.voids[seat]) m.voids[seat] = {};
      m.voids[seat][ledSuit] = true;
    }
  }

  const reveal = m.contract.call?.id === card.id && !m.contract.revealedCall;
  let raisedNotice = "";
  if (reveal) {
    m.contract.revealedCall = true;
    m.contract.revealTrickNo = m.trickNo;
    if (m.round >= 10 && !m.contract.solo) {
      const r = computeTeamMinBid(m.matchScores, m.mult, m.contract.nap, m.contract.deputy);
      if (r !== null) {
        const forcedMin = r.minBid, oldBid = m.contract.num;
        const caseLabel = { A: '5位=ナポレオン / 4位=副官', B: '4位=ナポレオン / 5位=副官', C: '5位=ナポレオン / 4位=連合軍', D: '4位=ナポレオン / 5位=連合軍' }[r.case];
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
    const team = x => x === m.contract.nap || x === m.contract.deputy ? "nap" : "alliance";
    if (team(seat) === team(previous.seat) && winningEntry(m.contract, m.trickNo, m.trick).seat === seat) m.roundArt[seat]--;
  }

  const revealNotice = m.contract.solo ? "ひとり立ちが判明しました。" : "副官が判明しました。";

  if (m.trick.length < 5) {
    m.active = (seat + 4) % 5;
    m.deadline = Date.now() + 30000;
    m.notice = raisedNotice || (reveal ? revealNotice : "カードを出してください。");
    publish(m, room);
    if (m.seats[m.active].bot) botAction(m, room);
    return;
  }

  const winningEntryObj = winningEntry(m.contract, m.trickNo, m.trick);
  const w = winningEntryObj.seat;
  const taken = m.trick.filter(x => FACE.includes(x.card.rank)).map(x => x.card);

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

  // ============================================================
  // 試合スコア: 早期終了判定
  // 連合軍合計には捨て札の得点札 (m.kittyAlliancePoints) を加算
  // ============================================================
  const allianceTrickPoints = m.seats.reduce((n, p, i) =>
    n + (i !== m.contract.nap && (m.contract.solo || i !== m.contract.deputy) ? p.points : 0), 0);
  const alliancePoints = allianceTrickPoints + (m.kittyAlliancePoints || 0);
  const napPoints = m.seats.reduce((n, p, i) =>
    n + (i === m.contract.nap || !m.contract.solo && i === m.contract.deputy ? p.points : 0), 0);

  m.earlyFinish = alliancePoints > 20 - m.contract.num
    || napPoints >= m.contract.num && (m.contract.num === 20 || alliancePoints >= 1);

  m.notice = raisedNotice
    || (napPoints >= m.contract.num
      ? "ナポレオン軍が立ちを達成しました。"
      : m.earlyFinish
        ? "連合軍の獲得得点札で立ちが成立不能になりました。"
        : reveal
          ? revealNotice
          : m.seats[w].player.username + "が場札を取りました。");

  m.phase = "trick-end";
  m.deadline = m.earlyFinish ? Date.now() : Date.now() + 1250;
  publish(m, room);
}

function botAuctionBid(m, seat, room) {
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
    if (m.phase === "auction") a.botAt[seat] = Date.now() + 2500 + Math.random() * 1800;
    return;
  }
  if (a.high.player === seat) {
    if (a.active.length === 1) doApprove(m, seat, room);
    return;
  }
  doApprove(m, seat, room);
}

function botAction(m, room) {
  if (!m || m.phase === "result") return;
  m.botLevel = 3;
  const i = m.active, p = m.seats[i];
  if (!p?.bot) return;
  m.lastBot = Date.now();
  const params = m.botStrategy || defaultStrategy();

  if (m.phase === "auction") { botAuctionBid(m, i, room); return; }

  if (m.phase === "call") {
    if (m.contract.solo) {
      const chosen = chooseSoloCall(p.hand);
      if (chosen) callCard(m, i, chosen.suit, chosen.rank, room);
      return;
    }
    const forceSolo = isSoloForcedInMatch(m);
    if (forceSolo) {
      const hand = p.hand;
      const chosen = hand.slice().sort((a, b) => RANKS.indexOf(a.rank) - RANKS.indexOf(b.rank))[0];
      callCard(m, i, chosen.suit, chosen.rank, room);
    } else {
      const x = chooseDeputyCall(p.hand, m.kitty, m.contract.suit, m.botLevel || 2, m.contract.num, params);
      if (x) callCard(m, i, x.suit, x.rank, room);
    }
    return;
  }

  if (m.phase === "discard") {
    const drop = chooseDiscard(p.hand, m.contract.suit).map(x => x.id);
    discardCards(m, i, drop, room);
    return;
  }

  if (m.phase === "play") {
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
      params,
      call: m.contract.call
    };
    let c;
    if (i === m.contract.deputy && !m.contract.solo && m.contract.revealedCall) c = chooseDeputyCard(ctx);
    else c = chooseCardToPlay(ctx);
    if (!c || !legal.some(x => x.id === c.id)) {
      c = legal[Math.floor(Math.random() * legal.length)];
    }
    playCard(m, i, c.id, room, null);
  }
}

function nextRound(m, room) {
  if (m.phase !== "round-result") return;
  m.round++; m.mult = 1; m.redraws = 0;
  deal(m);
  publish(m, room);
}

async function processAction(conn, msg, room, env) {
  const id = connMatch.get(conn.id), m = id && matches.get(id);
  if (!m) return;
  const seat = m.seats.findIndex(s => s.connId === conn.id);
  if (seat < 0) return;
  const a = msg.action || {};
  if (a.type === "appeal") return answerAppealOffer(m, seat, true, room);
  if (a.type === "skip-appeal") return answerAppealOffer(m, seat, false, room);
  if (a.type === "appeal-declare") return answerAppealResponse(m, seat, "declare", room);
  if (a.type === "appeal-stand") return answerAppealResponse(m, seat, "stand", room);
  if (a.type === "next-round") return nextRound(m, room);
  if (a.type === "auction-activity") {
    if (m.phase === "auction" && m.auction.active.includes(seat)) {
      m.auction.lastAction[seat] = Date.now();
      m.auction.autoApprove[seat] = false;
    }
    return;
  }
  if (a.type === "confirm-call") {
    if (m.phase !== "call-reveal" || m.contract.ready[seat]) return;
    m.contract.ready[seat] = true;
    if (m.contract.ready.every((ready, i) => ready || m.seats[i].bot)) startPlay(m, room);
    else { m.notice = "指名カードの確認中です。"; publish(m, room); }
    return;
  }
  if (a.type === "approve" || a.type === "pass") doApprove(m, seat, room);
  else if (a.type === "bid") doBid(m, seat, Number(a.num), a.suit, room, a.solo === true);
  else if (a.type === "call") callCard(m, seat, a.suit, a.rank, room);
  else if (a.type === "discard") discardCards(m, seat, a.cards, room);
  else if (a.type === "play") playCard(m, seat, a.card, room, env);
}

async function saveEnd(m, room, env) { await finish(m, room, env); }

function timeoutAction(m, room) {
  const i = m.active, p = m.seats[i];
  const params = m.botStrategy || defaultStrategy();
  if (m.phase === "call") {
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
  } else if (m.phase === "discard") {
    const ids = p.hand.slice().sort((a, b) => RANKS.indexOf(a.rank) - RANKS.indexOf(b.rank)).slice(0, 2).map(x => x.id);
    discardCards(m, i, ids, room);
  } else if (m.phase === "play") {
    const c = legalCards(m, i).slice().sort((a, b) => RANKS.indexOf(a.rank) - RANKS.indexOf(b.rank))[0];
    if (c) playCard(m, i, c.id, room, null);
  }
}

export const room = {
  tickMs: 500,
  async onConnect(conn, room) {
    if (conns.size >= 180) { conn.close(4003, "Room capacity reached"); return; }
    conns.set(conn.id, conn);
    sendSafe(conn, { type: "connected" });
    const presence = { type: "presence", count: conns.size };
    sendSafe(conn, presence);
    room.broadcast(presence, { except: [conn.id] });
  },
  async onMessage(conn, raw, room, env) {
    let msg;
    try { msg = typeof raw === "string" ? JSON.parse(raw) : raw; } catch { return; }

    if (msg.type === "join") {
      if (msg.sessionToken) {
        const sess = await env.DB.prepare("SELECT user_id FROM sessions WHERE token=? AND expires_at>?").bind(msg.sessionToken, Date.now()).first();
        if (sess) conn.authUserId = sess.user_id;
      }
      const mode = msg.mode === "ranked" ? "ranked" : "friend";
      if (mode === "ranked" && conn.authUserId && rankedUsers.has(conn.authUserId)) {
        sendSafe(conn, { type: "room-error", message: "このアカウントはすでに待機中または対戦中です" });
        return;
      }
      if (mode === "ranked" && conn.authUserId) rankedUsers.set(conn.authUserId, conn.id);
      if (connMatch.has(conn.id)) {
        if (mode === "ranked" && conn.authUserId && rankedUsers.get(conn.authUserId) === conn.id) rankedUsers.delete(conn.authUserId);
        return;
      }
      let player;
      try { player = await getProfile(env, conn); } catch (error) {
        if (mode === "ranked" && conn.authUserId && rankedUsers.get(conn.authUserId) === conn.id) rankedUsers.delete(conn.authUserId);
        sendSafe(conn, { type: "room-error", message: "プレイヤー情報を確認できませんでした。再度お試しください" });
        return;
      }
      if (!conns.has(conn.id)) {
        if (mode === "ranked" && conn.authUserId && rankedUsers.get(conn.authUserId) === conn.id) rankedUsers.delete(conn.authUserId);
        return;
      }
      const entry = {
        id: conn.id, player, conn, joined: Date.now(),
        code: String(msg.code || "").toUpperCase().slice(0, 8),
        bots: Math.max(1, Math.min(4, Number(msg.bots) || 4)),
        botLevel: Math.max(1, Math.min(3, Math.floor(Number(msg.botLevel) || 2)))
      };
      if (mode === "ranked") {
        queues.ranked.push(entry);
        queues.ranked.sort((a, b) => a.joined - b.joined);
        sendSafe(conn, { type: "lobby", text: "対戦相手を検索中 · " + queues.ranked.length + "/5人" });
        if (queues.ranked.length >= 5) beginMatch("ranked", "", queues.ranked.splice(0, 5), room, env);
        return;
      }
      if (!entry.code) entry.code = makeCode();
      let l = friendRooms.get(entry.code);
      if (!l) {
        l = { code: entry.code, host: conn.id, bots: entry.bots, botLevel: entry.botLevel, players: [], created: Date.now() };
        friendRooms.set(entry.code, l);
      }
      if (l.players.some(x => x.id === conn.id || player.userId && x.player.userId === player.userId)) {
        sendSafe(conn, { type: "room-error", message: "このプレイヤーはすでに部屋にいます" });
        return;
      }
      const cap = Math.max(1, 5 - l.bots);
      if (l.players.length >= cap) {
        sendSafe(conn, { type: "room-error", message: "この部屋は満員です" });
        return;
      }
      l.players.push(entry);
      l.players.forEach(x => sendSafe(x.conn, { type: "friend-lobby", code: l.code, count: l.players.length, capacity: cap, bots: l.bots, host: x.id === l.host }));
      sendSafe(conn, { type: "lobby", text: "合言葉 " + l.code + " · " + l.players.length + "/" + cap + "人" });
      if (l.players.length >= cap) { friendRooms.delete(l.code); beginMatch("friend", l.code, l.players, room, env); }
      return;
    }

    if (msg.type === "cancel-queue") {
      const queueIndex = queues.ranked.findIndex(x => x.id === conn.id);
      if (queueIndex >= 0) {
        queues.ranked.splice(queueIndex, 1);
        if (conn.authUserId && rankedUsers.get(conn.authUserId) === conn.id) rankedUsers.delete(conn.authUserId);
      }
      sendSafe(conn, { type: "queue-cancelled" });
      return;
    }

    if (msg.type === "game") return processAction(conn, msg, room, env);
  },
  async onTick(room, env) {
    const now = Date.now(), rankedQueue = queues.ranked;

    if (rankedQueue.length && now - rankedQueue[rankedQueue.length - 1].joined >= 90000) {
      const group = rankedQueue.splice(0, Math.min(4, rankedQueue.length));
      beginMatch("ranked", "", group, room, env);
    }

    for (const [c, l] of friendRooms) if (now - l.created > 900000) friendRooms.delete(c);

    for (const m of matches.values()) {
      if (m.phase === "prep" && now >= m.deadline) {
        const rule = m.round >= 10 ? finalAuctionRule(m.matchScores, m.mult) : null;
        m.phase = "auction";
        m.auction = {
          active: rule ? rule.eligible : [0, 1, 2, 3, 4],
          minBid: rule?.minBid || 13,
          high: { num: 12, suit: "", player: -1, solo: false },
          version: 0,
          startedAt: now,
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
          m.appealInfo = "";
          m.phase = "appeal-offer";
          m.active = rule.bottomSeat;
          m.deadline = now + 30000;
          m.notice = "5位は4位にJ・マイティの所持を尋ねられます。";
          publish(m, room);
          if (m.seats[rule.bottomSeat].bot) answerAppealOffer(m, rule.bottomSeat, true, room);
        } else {
          m.appeal = null;
          m.appealInfo = "";
          m.notice = "競り開始です。宣言するか、承認して競りを降りてください。";
          publish(m, room);
        }
      } else if (m.phase === "appeal-offer") {
        if (now >= m.deadline) answerAppealOffer(m, m.appeal.bottomSeat, false, room);
      } else if (m.phase === "appeal-response") {
        if (m.seats[m.active]?.bot) answerAppealResponse(m, m.active, "declare", room);
        else if (now >= m.deadline) answerAppealResponse(m, m.active, "stand", room);
      } else if (m.phase === "auction") {
        for (const seat of m.auction.active.slice()) {
          if (!m.seats[seat].bot && !m.auction.autoApprove[seat] && now - (m.auction.lastAction[seat] || m.auction.startedAt) >= 30000) doApprove(m, seat, room, true);
          if (m.phase !== "auction") break;
        }
        for (let seat = 0; seat < m.seats.length && m.phase === "auction"; seat++) {
          if (m.seats[seat].bot && m.auction.active.includes(seat) && m.auction.botSeen[seat] < m.auction.version && now >= m.auction.botAt[seat]) botAuctionBid(m, seat, room);
        }
      } else if (m.phase === "call-reveal") {
        if (now >= m.deadline) startPlay(m, room);
      } else if (m.phase === "call" || m.phase === "discard" || m.phase === "play") {
        if (m.seats[m.active]?.bot && now - m.lastBot > 850) botAction(m, room);
        else if (m.deadline && now >= m.deadline) {
          m.notice = "持ち時間が切れたため、自動で進行します。";
          timeoutAction(m, room);
        }
      } else if (m.phase === "round-result" && now >= m.deadline) {
        nextRound(m, room);
      } else if (m.phase === "trick-end" && now >= m.deadline) {
        if (m.earlyFinish) { await saveEnd(m, room, env); continue; }
        m.trickNo++;
        if (m.trickNo >= 10) await saveEnd(m, room, env);
        else {
          m.trick = [];
          m.phase = "play";
          m.deadline = Date.now() + 30000;
          m.notice = "次の勝負です。";
          publish(m, room);
          if (m.seats[m.active].bot) botAction(m, room);
        }
      } else if (m.phase === "redeal" && now >= m.deadline) {
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
          s.player.username = "COM";
          s.player.playerId = "COM";
          if (m.kind === "ranked") s.player.userId = null;
        }
        publish(m, room);
      }
    }
    const presence = { type: "presence", count: conns.size };
    room.broadcast(presence);
  }
};
