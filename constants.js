import { SUITS, RANKS, CALIBRATION, shuffledDeck, sortHand, defaultStrategy, mutateStrategy, PARAM_BOUNDS, sweetSpotFactor, estimatedWinRate, findMaxHonestBid, SWEET_SPOT_BONUS, rateRound, RANK_1_BONUS, RANK_2_BONUS, RANK_4_PENALTY, RANK_5_PENALTY } from './constants.js';
import { shouldBid, chooseDiscard, chooseDeputyCall, chooseSoloCall, chooseCardToPlay, chooseDeputyCard, winningEntry, colorStrength, ntHandStrength, handStrength } from './ai-tactics.js';

function safeJsonParse(str, fallback = null) {
  try {
    if (typeof str !== 'string' || !str.trim()) return fallback;
    return JSON.parse(str);
  } catch (e) {
    console.warn('JSON parse failed:', e.message, 'Input:', typeof str === 'string' ? str.slice(0, 200) : str);
    return fallback;
  }
}

function computeBidStrength(hand, suit, params) {
  if (suit === 'NT') return ntHandStrength(hand, params);
  return colorStrength(hand, suit, params);
}

function computeRoundRating(strengthAtBid, num, won, solo, params, pointsOverBid, revealTrickNo, takenPoints, nap, deputy) {
  const pts = takenPoints || [0, 0, 0, 0, 0];
  const roundData = {
    nap, deputy, solo: !!solo, num, won: !!won,
    points: (pts[nap] || 0) + (solo ? 0 : (pts[deputy] || 0)),
    revealTrickNo,
    takenPoints: pts,
    strengthAtBid
  };
  const napDelta = rateRound(nap, roundData, params, 1);
  const deputyDelta = (!solo && deputy !== nap) ? rateRound(deputy, roundData, params, 1) : 0;
  let allySeat = -1;
  for (let s = 0; s < 5; s++) {
    if (s !== nap && (solo || s !== deputy)) { allySeat = s; break; }
  }
  const allyDelta = allySeat >= 0 ? rateRound(allySeat, roundData, params, 1) : 0;

  const totalAlliancePoints = pts.reduce((n, v, i) => {
    if (i === nap) return n;
    if (!solo && i === deputy) return n;
    return n + (v || 0);
  }, 0);
  const avgAlliancePoints = totalAlliancePoints / (solo ? 4 : 3);
  return { napDelta, deputyDelta, allyDelta, avgAlliancePoints, p: estimatedWinRate(strengthAtBid, num), diff: Math.max(0, num - 12) };
}

function simRound(hands, round, matchScores, params, matchBidHistory) {
  const d = shuffledDeck();
  for (let i = 0; i < 5; i++) { hands[i] = d.splice(0, 10); sortHand(hands[i]); }
  const kitty = d.splice(0, 2);

  const currentBids = matchBidHistory.filter(b => b.round === round);

  let high = { num: 12, suit: '', player: -1, solo: false };
  for (let r = 0; r < 2; r++) {
    for (let s = 0; s < 5; s++) {
      const bid = shouldBid(hands[s], high, 13, params[s], currentBids, s);
      if (bid && bid.num > high.num) high = { ...bid, player: s };
    }
  }
  if (high.player < 0) {
    high = { num: 13, suit: SUITS[0], player: matchScores.indexOf(Math.min(...matchScores)), solo: false };
  }

  const nap = high.player, trump = high.suit, num = high.num;
  const isSoloBid = high.solo === true;
  const strengthAtBid = computeBidStrength(hands[nap], trump, params[nap] || defaultStrategy());

  matchBidHistory.push({ round, seat: nap, num, suit: trump, solo: isSoloBid });
  if (matchBidHistory.length > 50) matchBidHistory.shift();

  const contractBase = { nap, suit: trump, solo: isSoloBid, deputy: -1, revealedCall: false };
  hands[nap].push(...kitty); sortHand(hands[nap]);
  const discard = chooseDiscard(hands[nap], trump);
  hands[nap] = hands[nap].filter(c => !discard.some(x => x.id === c.id));
  const kittyPts = discard.filter(c => ['10', 'J', 'Q', 'K', 'A'].includes(c.rank)).length;
  const allianceKittyPts = kittyPts;

  let deputy = -1;
  let call;
  if (isSoloBid) {
    call = chooseSoloCall(hands[nap]);
    deputy = nap;
    contractBase.deputy = nap;
  } else {
    call = chooseDeputyCall(hands[nap], discard, trump, 3, num, params[nap] || defaultStrategy());
    for (let i = 0; i < 5; i++) {
      if (i !== nap && hands[i].some(c => c.id === call.id)) { deputy = i; break; }
    }
    if (deputy < 0) {
      contractBase.solo = true;
      deputy = nap;
      call = chooseSoloCall(hands[nap]);
    }
    contractBase.deputy = deputy;
  }

  const roundPts = [0, 0, 0, 0, 0];

  const played = [], voids = [{}, {}, {}, {}, {}];
  let revealed = contractBase.solo, revealTrickNo = null, active = nap, trickNo = 0;

  while (trickNo < 10 && hands.some(h => h.length > 0)) {
    const trick = [];
    for (let i = 0; i < 5; i++) {
      const seat = (active + i) % 5, hand = hands[seat];
      if (!hand.length) break;
      const legal = trick.length === 0 ? hand
        : hand.filter(c => c.suit === trick[0].card.suit).length
          ? hand.filter(c => c.suit === trick[0].card.suit)
          : hand;

      const currentWinner = trick.length ? winningEntry(contractBase, trickNo, trick) : null;
      const isCurrentNapWinning = currentWinner
        ? (currentWinner.seat === nap || (!contractBase.solo && currentWinner.seat === deputy))
        : false;

      const ctx = {
        hand, legal, trick, trickNo, contract: contractBase,
        playedCards: played, voids, seat, deputy, params: params[seat] || defaultStrategy(),
        discardedKitty: discard,
        isMySideNap: seat === nap || (revealed && seat === deputy),
        isCurrentNapWinning,
        isRevealed: revealed,
        isNapLeading: trick.length > 0 && trick[0].seat === nap,
        lastSeat: trick.length === 4,
        call: call
      };

      let chosen;
      if (!contractBase.solo && revealed && seat === deputy) chosen = chooseDeputyCard(ctx);
      else chosen = chooseCardToPlay(ctx);

      if (!chosen || !legal.some(c => c.id === chosen.id)) {
        chosen = legal[Math.floor(Math.random() * legal.length)];
      }

      if (trick.length && chosen.suit !== trick[0].card.suit) {
        if (!voids[seat]) voids[seat] = {};
        voids[seat][trick[0].card.suit] = true;
      }
      played.push({ suit: chosen.suit, rank: chosen.rank, id: chosen.id, seat });
      if (!revealed && chosen.id === call.id) { revealed = true; revealTrickNo = trickNo; }
      trick.push({ seat, card: chosen });
      hands[seat] = hand.filter(c => c.id !== chosen.id);
    }
    if (trick.length < 5) break;
    const w = winningEntry(contractBase, trickNo, trick);
    const taken = trick.filter(e => ['10', 'J', 'Q', 'K', 'A'].includes(e.card.rank)).length;
    roundPts[w.seat] += taken;
    active = w.seat;
    trickNo++;
    const napPts = roundPts[nap] + (contractBase.solo ? 0 : roundPts[deputy]);
    const allyPtsRaw = roundPts.reduce((n, p, i) => n + (i !== nap && (contractBase.solo || i !== deputy) ? p : 0), 0);
    const allyPts = allyPtsRaw + allianceKittyPts;
    if (allyPts > 20 - num || (napPts >= num && (num === 20 || allyPts >= 1))) break;
  }

  const napPts = roundPts[nap] + (contractBase.solo ? 0 : roundPts[deputy]);
  const made = napPts >= num && (num === 20 || napPts < 20);
  const unit = Math.max(0, num - 12) * (round >= 10 ? 2 : 1);
  const sign = made ? 1 : -1;
  const sc = [0, 0, 0, 0, 0];
  sc[nap] = sign * unit * (contractBase.solo ? 4 : 2);
  if (contractBase.solo) {
    for (let i = 0; i < 5; i++) if (i !== nap) sc[i] = -sign * unit;
  } else {
    sc[deputy] = sign * unit;
    for (let i = 0; i < 5; i++) if (i !== nap && i !== deputy) sc[i] = -sign * unit;
  }
  for (let i = 0; i < 5; i++) matchScores[i] += sc[i];

  return {
    nap, deputy, num, solo: contractBase.solo,
    made, points: napPts, takenPoints: roundPts,
    strengthAtBid, revealTrickNo,
    allianceKittyPoints: allianceKittyPts,
    mult: 1,
    rating: computeRoundRating(strengthAtBid, num, made, contractBase.solo, params[nap] || defaultStrategy(), Math.max(0, napPts - num), revealTrickNo, roundPts, nap, deputy)
  };
}

export async function runSelfPlayBatch(env, matchCount = 1000) {
  let existing = [];
  try {
    const { results } = await env.DB.prepare("SELECT * FROM ai_strategy_log ORDER BY avg_rating_delta DESC LIMIT 5").all();
    existing = results || [];
  } catch { }

  const sanitizeParams = (raw) => {
    const base = defaultStrategy();
    const parsed = safeJsonParse(raw, null);
    if (!parsed || typeof parsed !== 'object') return base;
    const clean = { ...base };
    for (const k of Object.keys(base)) {
      const v = parsed[k];
      if (typeof v === 'number' && Number.isFinite(v)) clean[k] = v;
    }
    return clean;
  };

  const baseline = existing.length
    ? existing.map(r => sanitizeParams(r.params))
    : [defaultStrategy()];

  const generation = existing.length ? Math.max(...existing.map(r => Number(r.generation) || 0)) + 1 : 1;

  const challengers = baseline.map(b => mutateStrategy(b, 0.2));
  while (challengers.length < 5) challengers.push(mutateStrategy(baseline[0] || defaultStrategy(), 0.15));
  const pool = [...baseline.slice(0, 3), ...challengers.slice(0, 5)];

  const stats = pool.map(() => ({
    n: 0, totalRating: 0,
    napN: 0, napW: 0, depN: 0, depW: 0, alN: 0, alW: 0,
    bidSum: 0, bidN: 0, soloBidN: 0
  }));

  for (let i = 0; i < matchCount; i++) {
    const seatIdx = [], seatParams = [];
    for (let s = 0; s < 5; s++) {
      const idx = Math.floor(Math.random() * pool.length);
      seatIdx.push(idx);
      seatParams.push(pool[idx]);
    }

    const hands = [[], [], [], [], []];
    const matchScores = [0, 0, 0, 0, 0];
    const matchBidHistory = [];
    const contracts = [];
    for (let r = 1; r <= 10; r++) contracts.push(simRound(hands, r, matchScores, seatParams, matchBidHistory));

    const sorted = [...matchScores].sort((a, b) => b - a);
    const placement = [0, 0, 0, 0, 0];
    for (let s = 0; s < 5; s++) placement[s] = 1 + sorted.filter(x => x > matchScores[s]).length;

    for (let seat = 0; seat < 5; seat++) {
      const st = stats[seatIdx[seat]];
      st.n++;
      let matchRating = 0;

      for (const c of contracts) {
        if (c.nap === seat) {
          st.napN++; st.bidSum += c.num; st.bidN++;
          if (c.made) st.napW++;
          if (c.solo) st.soloBidN++;
          matchRating += c.rating.napDelta || 0;
        } else if (!c.solo && c.deputy === seat) {
          st.depN++;
          if (c.made) st.depW++;
          matchRating += c.rating.deputyDelta || 0;
        } else {
          st.alN++;
          if (!c.made) st.alW++;
          matchRating += c.rating.allyDelta || 0;
        }
      }

      if (placement[seat] === 1) matchRating += RANK_1_BONUS;
      else if (placement[seat] === 2) matchRating += RANK_2_BONUS;
      else if (placement[seat] === 4) matchRating += RANK_4_PENALTY;
      else if (placement[seat] === 5) matchRating += RANK_5_PENALTY;

      st.totalRating += Number.isFinite(matchRating) ? matchRating : 0;
    }
  }

  const statements = [];
  const parentIds = existing.slice(0, 3).map(r => r.id);
  for (let i = 0; i < pool.length; i++) {
    const st = stats[i];
    if (!st.n) continue;

    const avgRating = Number.isFinite(st.totalRating / st.n) ? st.totalRating / st.n : 0;
    const napRate = Number.isFinite(st.napN ? st.napW / st.napN : 0) ? (st.napN ? st.napW / st.napN : 0) : 0;
    const depRate = Number.isFinite(st.depN ? st.depW / st.depN : 0) ? (st.depN ? st.depW / st.depN : 0) : 0;
    const alRate = Number.isFinite(st.alN ? st.alW / st.alN : 0) ? (st.alN ? st.alW / st.alN : 0) : 0;
    const overall = napRate;
    const avgBid = Number.isFinite(st.bidN ? st.bidSum / st.bidN : 0) ? (st.bidN ? st.bidSum / st.bidN : 0) : 0;

    statements.push(
      env.DB.prepare(
        "INSERT INTO ai_strategy_log(generation,params,nap_win_rate,deputy_win_rate,alliance_win_rate,overall_win_rate,avg_rating_delta,matches,avg_bid,parent_id) VALUES(?,?,?,?,?,?,?,?,?,?)"
      ).bind(generation, JSON.stringify(pool[i]), napRate, depRate, alRate, overall, avgRating, st.n, avgBid, parentIds[i] || null)
    );
  }
  if (statements.length) await env.DB.batch(statements);

  try {
    const top = await env.DB.prepare("SELECT params FROM ai_strategy_log ORDER BY avg_rating_delta DESC, id DESC LIMIT 1").first();
    if (top) {
      const parsedTop = safeJsonParse(top.params, null);
      if (parsedTop && typeof parsedTop === 'object') {
        await env.DB.prepare(
          "INSERT INTO ai_weights(id,weights,games,updated_at) VALUES(1,?,1,CURRENT_TIMESTAMP) ON CONFLICT(id) DO UPDATE SET weights=excluded.weights, games=games+1, updated_at=CURRENT_TIMESTAMP"
        ).bind(JSON.stringify(parsedTop)).run();
      }
    }
  } catch (e) { console.error("failed to update ai_weights", e); }

  try {
    await env.DB.prepare(
      "DELETE FROM ai_strategy_log WHERE id NOT IN (SELECT id FROM ai_strategy_log ORDER BY avg_rating_delta DESC, id DESC LIMIT 50)"
    ).run();
  } catch { }

  return { generation, size: pool.length, matches: matchCount };
}

export function generateInsights(strategies) {
  if (!strategies || !strategies.length) return [];
  const base = defaultStrategy();
  const topParams = safeJsonParse(strategies[0].params, {}) || {};
  const top = { ...base, ...topParams };
  const names = {
    bidThreshold: '立ち強度', riskTolerance: 'リスク許容', leadAggression: 'リード積極性',
    followAggression: 'フォロー積極性', trumpBonus: '切り札評価', mightyBonus: 'マイティ評価',
    safeAceWeight: 'A温存', roleCardPreservation: '役札温存', deputyFeedBias: '副官の絵札回し',
    opponentInferenceWeight: '相手推論（便乗）', suitConflictWeight: 'スート衝突回避',
    mightyShadowWeight: 'マイティ影', weakOpponentBoost: '弱相手ブースト',
    bluffLossMultiplier: 'ブラフ罰',
    cooperationBonus: '協力ボーナス',
    ntPreference: 'NT選好', ntSuitLengthBonus: 'NT長さ', ntAceWeight: 'NT A評価',
    ntMightyBonus: 'NTマイティ', highBidNtThreshold: 'NT移行閾値',
    aceWeakSuitBonus: '弱点A', aceShortBonus: '短A', aceLongPenalty: '長Aペナ',
    sameTwoAceCounter: 'セイム2 A対策', sameTwoShortBonus: 'セイム2短', sameTwoLongPenalty: 'セイム2長ペナ',
    sameTwoHighBidBonus: 'セイム2高bid',
    trumpExhaustionThreshold: 'トランプ枯渇閾値', baitModeWindow: '釣り窓',
    baitMinTrumps: '釣り最小トランプ', strongTrumpLeadAggression: '押し切り',
    aceCashUrgency: 'A早期', pointCardSafetyThreshold: 'ポイント安全',
    tenHoldThreshold: '10温存', nonTrumpAceWaiting: 'A待ち',
    baitBackJWindow: '裏J釣り窓', baitBackJChance: '裏J釣り確率',
    faceCardOnNapWin: 'NAP勝ち絵札', preserveNextStronger: '次強温存',
    deputyRevealUrgency: '判明緊急', deputyCoverWeight: '弱点カバー', sameTwoDeputyBonus: 'セイム2副官',
    allyFaceCardBonus: '連合絵札', napWeaknessLeadWeight: 'NAP弱点リード',
    trumpAvoidWeight: 'トランプ回避', sameColorSuitAvoid: '裏J回避',
    spadeLeadPriority: 'スペード優先', nonDeclaredSuitWeight: '非宣言スート',
    queenHoardWeight: 'Q温存', sameTwoHoardWeight: '2温存',
    allyYieldBonus: '味方譲り'
  };
  const deltas = Object.entries(PARAM_BOUNDS)
    .map(([k, [lo, hi]]) => {
      const cur = top[k] ?? base[k];
      return { key: k, name: names[k] || k, delta: (cur - base[k]) / (hi - lo), cur, baseVal: base[k] };
    })
    .sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta));
  const insights = deltas.slice(0, 3).map(d => ({
    title: `${d.name}（${d.delta > 0 ? '増加' : '減少'}）`,
    detail: `初期値 ${d.baseVal.toFixed(2)} → ${d.cur.toFixed(2)}。改善に寄与した主要パラメータ。`
  }));
  insights.push({
    title: '役割別勝率（最上位戦略）',
    detail: `ナポレオン時 ${(Number(strategies[0].nap_win_rate || 0) * 100).toFixed(1)}% / 副官時 ${(Number(strategies[0].deputy_win_rate || 0) * 100).toFixed(1)}% / 連合軍時 ${(Number(strategies[0].alliance_win_rate || 0) * 100).toFixed(1)}%`
  });
  const delta = Number(strategies[0].avg_rating_delta || 0);
  insights.push({
    title: '平均レート上昇',
    detail: `1マッチあたり ${delta > 0 ? '+' : ''}${delta.toFixed(2)} pt（${strategies[0].matches}マッチの平均）。`
  });
  return insights;
}
