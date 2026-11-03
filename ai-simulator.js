// ai-simulator.js (プレイ品質・高枚数ボーナス統合版)
import { SUITS, RANKS, CALIBRATION, shuffledDeck, sortHand, defaultStrategy, mutateStrategy, crossoverStrategy, PARAM_BOUNDS, sweetSpotFactor, estimatedWinRate, findMaxHonestBid, SWEET_SPOT_BONUS, rateRound, RANK_1_BONUS, RANK_2_BONUS, RANK_4_PENALTY, RANK_5_PENALTY, isSameColorSuit, sameColorSuitOf } from './constants.js';
import {
  shouldBid, chooseDiscard, chooseDeputyCall, chooseSoloCall, chooseCardToPlay, chooseDeputyCard,
  winningEntry, colorStrength, ntHandStrength, handStrength, cardPower,
  computeProperBid, canSendSignal, isTwoRole, isThreeRole, countSameColorBidders, getRoleCards
} from './ai-tactics.js';

function safeJsonParse(str, fallback = null) {
  try { if (typeof str !== 'string' || !str.trim()) return fallback; return JSON.parse(str); }
  catch (e) { return fallback; }
}

function computeBidStrength(hand, suit, params) {
  if (suit === 'NT') return ntHandStrength(hand, params);
  return colorStrength(hand, suit, params);
}

function computePlanAccuracy(plan, actualWins, params) {
  if (!plan || !Number.isFinite(plan.expectedWins)) return 0;
  const diff = plan.expectedWins - actualWins;
  const w = params.planAccuracyWeight ?? 1.0;
  
  if (diff > 1.5) {
    const penaltyWeight = params.overbidPenalty ?? 2.0;
    return -Math.min(penaltyWeight, (diff - 1.5) * 1.5) * w;
  }
  else if (diff < -2.0) {
    const penaltyWeight = params.underbidPenalty ?? 0.5;
    return -Math.min(penaltyWeight, (-diff - 2.0) * 0.5) * w;
  }
  else if (Math.abs(diff) <= 1.0) {
    const bonus = params.planAccuracyBonus ?? 1.5;
    return bonus * w;
  }
  return 0;
}

function computeRoundRating(strengthAtBid, num, won, solo, params, pointsOverBid, revealTrickNo, takenPoints, nap, deputy, plan, actualWins) {
  const pts = takenPoints || [0, 0, 0, 0, 0];
  const roundData = { nap, deputy, solo: !!solo, num, won: !!won, points: (pts[nap] || 0) + (solo ? 0 : (pts[deputy] || 0)), revealTrickNo, takenPoints: pts, strengthAtBid };
  const napDelta = rateRound(nap, roundData, params, 1);
  const deputyDelta = (!solo && deputy !== nap) ? rateRound(deputy, roundData, params, 1) : 0;
  let allySeat = -1;
  for (let s = 0; s < 5; s++) { if (s !== nap && (solo || s !== deputy)) { allySeat = s; break; } }
  const allyDelta = allySeat >= 0 ? rateRound(allySeat, roundData, params, 1) : 0;
  const totalAlliancePoints = pts.reduce((n, v, i) => (i === nap || (!solo && i === deputy)) ? n : n + (v || 0), 0);
  const planAccuracy = computePlanAccuracy(plan, actualWins, params);
  return {
    napDelta, deputyDelta, allyDelta,
    avgAlliancePoints: totalAlliancePoints / (solo ? 4 : 3),
    p: estimatedWinRate(strengthAtBid, num),
    diff: Math.max(0, num - 12),
    planAccuracy,
    expectedWins: plan?.expectedWins ?? null,
    actualWins
  };
}

// ==========================================
// 自己対戦用のトスアップ競りシミュレーション
// ==========================================
function simulateAuction(hands, params, seatParams, openKitty, bidHistoryOut) {
  const bidSignals = Array.from({ length: 5 }, () => ({
    sent: null,
    received: [],
    sameColorCount: 0,
    lastBidAt: 0
  }));

  let high = { num: 12, suit: '', player: -1, solo: false, plan: null, bidPlan: null };
  
  const properBids = [];
  for (let seat = 0; seat < 5; seat++) {
    const p = seatParams[seat];
    const suitScores = SUITS.map(suit => ({ suit, score: colorStrength(hands[seat], suit, p) }));
    suitScores.sort((a, b) => b.score - a.score);
    const topSuits = suitScores.slice(0, 2).map(x => x.suit);
    const ntScore = ntHandStrength(hands[seat], p);
    const candidates = [];
    for (const suit of topSuits) {
      const proper = computeProperBid(hands[seat], suit, p, seat, bidSignals[seat], null, openKitty, [], [{},{},{},{},{}], []);
      candidates.push({ suit, properBid: proper.properBid, expected: proper.expected, plan: proper.plan });
    }
    if (ntScore > 6) {
      const ntProper = computeProperBid(hands[seat], 'NT', p, seat, bidSignals[seat], null, openKitty, [], [{},{},{},{},{}], []);
      candidates.push({ suit: 'NT', properBid: ntProper.properBid, expected: ntProper.expected, plan: ntProper.plan });
    }
    candidates.sort((a, b) => b.expected - a.expected);
    properBids.push({ candidates, baseStr: handStrength(hands[seat]), topSuits, ntScore });
  }

  for (let seat = 0; seat < 5; seat++) {
    const p = seatParams[seat];
    if (properBids[seat].baseStr < (p.bidThreshold ?? 3.5)) continue;
    const bestSuit = properBids[seat].topSuits[0];
    if (properBids[seat].candidates.length === 0) {
      if (13 > high.num || (13 === high.num && bestSuit && high.suit && SUITS.indexOf(bestSuit) > SUITS.indexOf(high.suit))) {
        high = { num: 13, suit: bestSuit, player: seat, solo: false, plan: null, bidPlan: null };
      }
      continue;
    }
    const cand = properBids[seat].candidates[0];
    const targetNum = Math.max(13, Math.min(20, cand.properBid));
    if (targetNum > high.num || (targetNum === high.num && high.suit && SUITS.indexOf(cand.suit) > SUITS.indexOf(high.suit))) {
      high = { num: 13, suit: cand.suit, player: seat, solo: false, plan: cand.plan, bidPlan: cand.plan };
    }
  }

  for (let iter = 0; iter < 4; iter++) {
    let acted = false;
    for (let seat = 0; seat < 5; seat++) {
      if (high.player === seat) continue;
      const p = seatParams[seat];
      const signal = canSendSignal(hands[seat], high, seat, bidSignals[seat], p, null);
      const sameColorCount = countSameColorBidders({}, (bidHistoryOut || []), high.suit);
      const myTwoRole = high.suit !== 'NT' && isTwoRole(hands[seat], high.suit);
      const limit = high.suit === 'NT' ? (p.ntBidderLimit ?? 2) : (p.sameColorBidderLimit ?? 2);
      
      if (signal.S4 && high.num === 17) {
        high = { num: 20, suit: signal.targetSuit, player: seat, solo: false, plan: null, bidPlan: null };
        bidSignals[seat].sent = { type: 'S4', suit: signal.targetSuit, num: 20 };
        bidHistoryOut.push({ round: 0, seat, num: 20, suit: signal.targetSuit });
        acted = true;
        continue;
      }
      
      if (sameColorCount >= limit && !myTwoRole) continue;
      
      if (signal.S3 && high.suit === 'NT') {
        const targetNum = high.num + 1;
        if (targetNum <= 20) {
          high = { num: targetNum, suit: 'NT', player: seat, solo: false, plan: null, bidPlan: null };
          bidSignals[seat].sent = { type: 'S3', suit: 'NT', num: targetNum };
          bidHistoryOut.push({ round: 0, seat, num: targetNum, suit: 'NT' });
          acted = true;
          continue;
        }
      }
      
      if (signal.S2 && signal.targetSuit) {
        if (high.num < 20) {
          high = { num: high.num, suit: signal.targetSuit, player: seat, solo: false, plan: null, bidPlan: null };
          bidSignals[seat].sent = { type: 'S2', suit: signal.targetSuit, num: high.num };
          bidHistoryOut.push({ round: 0, seat, num: high.num, suit: signal.targetSuit });
          acted = true;
          continue;
        }
      }
      
      if (signal.S1 && signal.targetSuit) {
        if (high.num < 20) {
          high = { num: high.num, suit: signal.targetSuit, player: seat, solo: false, plan: null, bidPlan: null };
          bidSignals[seat].sent = { type: 'S1', suit: signal.targetSuit, num: high.num };
          bidHistoryOut.push({ round: 0, seat, num: high.num, suit: signal.targetSuit });
          acted = true;
          continue;
        }
      }
      
      const candidates = properBids[seat].candidates;
      if (!candidates.length) continue;
      const best = candidates[0];
      const targetNum = Math.min(20, Math.max(high.num + 1, Math.min(best.properBid, high.num + 1)));
      if (targetNum <= high.num) continue;
      
      if (high.suit && high.suit !== 'NT' && best.suit && !isSameColorSuit(high.suit, best.suit)) {
        if (targetNum > best.properBid) continue;
      }
      
      high = { num: targetNum, suit: best.suit, player: seat, solo: false, plan: best.plan, bidPlan: best.plan };
      bidHistoryOut.push({ round: 0, seat, num: targetNum, suit: best.suit });
      acted = true;
    }
    if (!acted) break;
  }
  
  return high;
}

function simRound(hands, round, matchScores, params, matchBidHistory) {
  const d = shuffledDeck();
  for (let i = 0; i < 5; i++) { hands[i] = d.splice(0, 10); sortHand(hands[i]); }
  const kitty = d.splice(0, 2);
  const currentBids = matchBidHistory.filter(b => b.round === round);
  
  const bidHistoryLocal = [];
  const high = simulateAuction(hands, params, params, kitty, bidHistoryLocal);
  
  let nap, trump, num, isSoloBid, plan;
  if (high.player < 0) {
    nap = matchScores.indexOf(Math.min(...matchScores));
    trump = SUITS[0];
    num = 13;
    isSoloBid = false;
    plan = null;
  } else {
    nap = high.player;
    trump = high.suit;
    num = high.num;
    isSoloBid = high.solo === true;
    plan = high.bidPlan || high.plan || null;
  }
  
  const strengthAtBid = computeBidStrength(hands[nap], trump, params[nap] || defaultStrategy());
  matchBidHistory.push({ round, seat: nap, num, suit: trump, solo: isSoloBid });
  if (matchBidHistory.length > 50) matchBidHistory.shift();

  const contractBase = { nap, suit: trump, solo: isSoloBid, deputy: -1, revealedCall: false, bidPlan: plan };
  hands[nap].push(...kitty); sortHand(hands[nap]);
  const discard = chooseDiscard(hands[nap], trump);
  hands[nap] = hands[nap].filter(c => !discard.some(x => x.id === c.id));
  const kittyPts = discard.filter(c => ['10', 'J', 'Q', 'K', 'A'].includes(c.rank)).length;
  const allianceKittyPts = kittyPts;

  let deputy = -1, call;
  if (isSoloBid) {
    call = chooseSoloCall(hands[nap]);
    deputy = nap; contractBase.deputy = nap;
  } else {
    call = chooseDeputyCall(hands[nap], discard, trump, 3, num, params[nap] || defaultStrategy());
    for (let i = 0; i < 5; i++) { if (i !== nap && hands[i].some(c => c.id === call.id)) { deputy = i; break; } }
    if (deputy < 0) { contractBase.solo = true; deputy = nap; call = chooseSoloCall(hands[nap]); }
    contractBase.deputy = deputy;
  }

  const roundPts = [0, 0, 0, 0, 0];
  const played = [], voids = [{}, {}, {}, {}, {}];
  let revealed = contractBase.solo, revealTrickNo = null, active = nap, trickNo = 0;
  let napTricks = 0;
  let deputyTricks = 0;
  let overkillCount = 0;
  let feedSuccessCount = 0;

  while (trickNo < 10 && hands.some(h => h.length > 0)) {
    const trick = [];
    let pointsInTrick = 0;
    for (let i = 0; i < 5; i++) {
      const seat = (active + i) % 5, hand = hands[seat];
      if (!hand.length) break;
      const legal = trick.length === 0 ? hand : (hand.filter(c => c.suit === trick[0].card.suit).length ? hand.filter(c => c.suit === trick[0].card.suit) : hand);
      const currentWinner = trick.length ? winningEntry(contractBase, trickNo, trick) : null;
      const isMyTeam = seat === nap || (!contractBase.solo && seat === deputy);
      const isCurrentWinnerMyTeam = currentWinner ? (currentWinner.seat === nap || (!contractBase.solo && currentWinner.seat === deputy)) : false;
      
      const ctx = {
        hand, legal, trick, trickNo, contract: contractBase, playedCards: played, voids, seat, deputy,
        params: params[seat] || defaultStrategy(),
        discardedKitty: discard,
        isMySideNap: isMyTeam,
        isCurrentNapWinning: isCurrentWinnerMyTeam,
        isRevealed: revealed,
        isNapLeading: trick.length > 0 && trick[0].seat === nap,
        lastSeat: trick.length === 4,
        call,
        bidHistory: matchBidHistory,
        matchScores: matchScores,
        points: roundPts,
        allianceKittyPoints: allianceKittyPts
      };
      
      let chosen;
      if (!contractBase.solo && revealed && seat === deputy) chosen = chooseDeputyCard(ctx);
      else chosen = chooseCardToPlay(ctx);
      if (!chosen || !legal.some(c => c.id === chosen.id)) chosen = legal[Math.floor(Math.random() * legal.length)];
      
      if (trick.length > 0) {
        const isWinnerMyTeam = currentWinner && (currentWinner.seat === nap || (!contractBase.solo && currentWinner.seat === deputy));
        const winnerMyTeam = winnerSeat => winnerSeat === nap || (!contractBase.solo && winnerSeat === deputy);
        
        if (currentWinner) {
          const powerBefore = cardPower(contractBase, trickNo, currentWinner.card, trick);
          const powerAfter = cardPower(contractBase, trickNo, chosen, [...trick, { seat, card: chosen }]);
          
          if (winnerMyTeam(currentWinner.seat) === isMyTeam && powerAfter > powerBefore) {
            if (pointsInTrick === 0 || ['K', 'A'].includes(chosen.rank)) overkillCount++;
          }
          if (winnerMyTeam(currentWinner.seat) === isMyTeam && ['10', 'J', 'Q'].includes(chosen.rank)) {
            feedSuccessCount++;
          }
        }
      }

      if (trick.length && chosen.suit !== trick[0].card.suit) { if (!voids[seat]) voids[seat] = {}; voids[seat][trick[0].card.suit] = true; }
      played.push({ suit: chosen.suit, rank: chosen.rank, id: chosen.id, seat });
      if (!revealed && chosen.id === call.id) { revealed = true; revealTrickNo = trickNo; }
      trick.push({ seat, card: chosen });
      hands[seat] = hand.filter(c => c.id !== chosen.id);

      pointsInTrick = trick.filter(e => ['10', 'J', 'Q', 'K', 'A'].includes(e.card.rank)).length;
    }
    if (trick.length < 5) break;
    const w = winningEntry(contractBase, trickNo, trick);
    const taken = trick.filter(e => ['10', 'J', 'Q', 'K', 'A'].includes(e.card.rank)).length;
    roundPts[w.seat] += taken;
    if (w.seat === nap) napTricks++;
    else if (!contractBase.solo && w.seat === deputy) deputyTricks++;
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
  if (contractBase.solo) { for (let i = 0; i < 5; i++) if (i !== nap) sc[i] = -sign * unit; }
  else { sc[deputy] = sign * unit; for (let i = 0; i < 5; i++) if (i !== nap && i !== deputy) sc[i] = -sign * unit; }
  for (let i = 0; i < 5; i++) matchScores[i] += sc[i];

  const actualWins = napTricks + deputyTricks;
  
  return {
    nap, deputy, num, solo: contractBase.solo, made, points: napPts, takenPoints: roundPts,
    strengthAtBid, revealTrickNo, allianceKittyPoints: allianceKittyPts, mult: 1,
    plan, expectedWins: plan?.expectedWins ?? null, actualWins,
    overkillCount, feedSuccessCount,
    rating: computeRoundRating(strengthAtBid, num, made, contractBase.solo, params[nap] || defaultStrategy(), Math.max(0, napPts - num), revealTrickNo, roundPts, nap, deputy, plan, actualWins)
  };
}

export async function runSelfPlayBatch(env, matchCount = 1000) {
  let existing = [];
  try { const { results } = await env.DB.prepare("SELECT * FROM ai_strategy_log ORDER BY avg_rating_delta DESC LIMIT 10").all(); existing = results || []; } catch { }

  const sanitizeParams = (raw) => {
    const base = defaultStrategy();
    const parsed = safeJsonParse(raw, null);
    if (!parsed || typeof parsed !== 'object') return base;
    const clean = { ...base };
    for (const k of Object.keys(base)) {
      if (k === 'nnWeights') { clean.nnWeights = { ...base.nnWeights, ...(parsed.nnWeights || {}) }; continue; }
      const v = parsed[k]; if (typeof v === 'number' && Number.isFinite(v)) clean[k] = v;
    }
    return clean;
  };

  const baseline = existing.length ? existing.map(r => sanitizeParams(r.params)) : [defaultStrategy()];
  const generation = existing.length ? Math.max(...existing.map(r => Number(r.generation) || 0)) + 1 : 1;

  const nextPool = [];
  const eliteCount = Math.max(1, Math.floor(baseline.length * 0.2));
  for (let i = 0; i < eliteCount; i++) nextPool.push(baseline[i]);
  
  while (nextPool.length < 10) {
    const pA = baseline[Math.floor(Math.random() * baseline.length)];
    const pB = baseline[Math.floor(Math.random() * baseline.length)];
    let child = crossoverStrategy(pA, pB);
    child = mutateStrategy(child, 0.15);
    nextPool.push(child);
  }

  const speedUpForSimulation = (p) => {
    const sp = { ...p };
    sp.bidTimeBudgetMs = Math.min(sp.bidTimeBudgetMs || 600, 50);
    sp.bidMaxSamples = Math.min(sp.bidMaxSamples || 800, 50);
    sp.maxThinkTimeMs = Math.min(sp.maxThinkTimeMs || 3000, 50);
    sp.mctsSimulations = Math.min(sp.mctsSimulations || 150, 50);
    return sp;
  };

  const pool = nextPool.map(p => speedUpForSimulation(p));

  const stats = pool.map(() => ({ n: 0, totalRating: 0, napN: 0, napW: 0, depN: 0, depW: 0, alN: 0, alW: 0, bidSum: 0, bidN: 0, soloBidN: 0, planAccSum: 0, planAccN: 0, overbidN: 0, underbidN: 0 }));

  for (let i = 0; i < matchCount; i++) {
    const seatIdx = [], seatParams = [];
    for (let s = 0; s < 5; s++) { const idx = Math.floor(Math.random() * pool.length); seatIdx.push(idx); seatParams.push(pool[idx]); }
    const hands = [[], [], [], [], []], matchScores = [0, 0, 0, 0, 0], matchBidHistory = [], contracts = [];
    for (let r = 1; r <= 10; r++) contracts.push(simRound(hands, r, matchScores, seatParams, matchBidHistory));
    const sorted = [...matchScores].sort((a, b) => b - a);
    const placement = [0, 0, 0, 0, 0];
    for (let s = 0; s < 5; s++) placement[s] = 1 + sorted.filter(x => x > matchScores[s]).length;

    for (let seat = 0; seat < 5; seat++) {
      const st = stats[seatIdx[seat]];
      st.n++;
      let matchRating = 0;
      let totalOverkills = 0;
      let totalFeeds = 0;

      for (const c of contracts) {
        totalOverkills += c.overkillCount || 0;
        totalFeeds += c.feedSuccessCount || 0;
        
        if (c.nap === seat) {
          st.napN++; st.bidSum += c.num; st.bidN++;
          if (c.made) {
            st.napW++;
            const highBidSuccessBonus = Math.max(0, c.num - 13) * 1.5;
            matchRating += highBidSuccessBonus;
          }
          if (c.solo) st.soloBidN++;
          matchRating += c.rating.napDelta || 0;
          matchRating += c.rating.planAccuracy || 0;
          if (c.expectedWins != null && c.actualWins != null) {
            const diff = c.expectedWins - c.actualWins;
            st.planAccSum += (Math.abs(diff) <= 1.0 ? 1 : 0);
            st.planAccN++;
            if (diff > 1.5) st.overbidN++;
            if (diff < -2.0) st.underbidN++;
          }
        }
        else if (!c.solo && c.deputy === seat) { st.depN++; if (c.made) st.depW++; matchRating += c.rating.deputyDelta || 0; }
        else { st.alN++; if (!c.made) st.alW++; matchRating += c.rating.allyDelta || 0; }
      }
      
      matchRating += (totalFeeds * 2.0) - (totalOverkills * 2.0);

      if (placement[seat] === 1) matchRating += RANK_1_BONUS;
      else if (placement[seat] === 2) matchRating += RANK_2_BONUS;
      else if (placement[seat] === 4) matchRating += RANK_4_PENALTY;
      else if (placement[seat] === 5) matchRating += RANK_5_PENALTY;
      
      const napWins = contracts.filter(c => c.nap === seat && c.made).length;
      matchRating += napWins * 3.0;

      st.totalRating += Number.isFinite(matchRating) ? matchRating : 0;
    }
  }

  const statements = [];
  const parentIds = existing.slice(0, 3).map(r => r.id);
  for (let i = 0; i < pool.length; i++) {
    const st = stats[i];
    if (!st.n) continue;
    const avgRating = Number.isFinite(st.totalRating / st.n) ? st.totalRating / st.n : 0;
    const napRate = st.napN ? st.napW / st.napN : 0;
    const depRate = st.depN ? st.depW / st.depN : 0;
    const alRate = st.alN ? st.alW / st.alN : 0;
    const avgBid = st.bidN ? st.bidSum / st.bidN : 0;
    const avgPlanAcc = st.planAccN ? st.planAccSum / st.planAccN : 0;

    statements.push(env.DB.prepare("INSERT INTO ai_strategy_log(generation,params,nap_win_rate,deputy_win_rate,alliance_win_rate,overall_win_rate,avg_rating_delta,matches,avg_bid,parent_id,avg_plan_accuracy) VALUES(?,?,?,?,?,?,?,?,?,?,?)").bind(generation, JSON.stringify(nextPool[i]), napRate, depRate, alRate, napRate, avgRating, st.n, avgBid, parentIds[i] || null, avgPlanAcc));
  }
  if (statements.length) await env.DB.batch(statements);

  try {
    const top = await env.DB.prepare("SELECT params FROM ai_strategy_log ORDER BY avg_rating_delta DESC, id DESC LIMIT 1").first();
    if (top) {
      const parsedTop = safeJsonParse(top.params, null);
      if (parsedTop) await env.DB.prepare("INSERT INTO ai_weights(id,weights,games,updated_at) VALUES(1,?,1,CURRENT_TIMESTAMP) ON CONFLICT(id) DO UPDATE SET weights=excluded.weights, games=games+1, updated_at=CURRENT_TIMESTAMP").bind(JSON.stringify(parsedTop)).run();
    }
  } catch (e) { console.error("failed to update ai_weights", e); }

  try { await env.DB.prepare("DELETE FROM ai_strategy_log WHERE id NOT IN (SELECT id FROM ai_strategy_log ORDER BY avg_rating_delta DESC, id DESC LIMIT 100)").run(); } catch { }

  return { generation, size: pool.length, matches: matchCount };
}

export function generateInsights(strategies) {
  if (!strategies || !strategies.length) return [];
  const base = defaultStrategy();
  const topParams = safeJsonParse(strategies[0].params, {}) || {};
  const top = { ...base, ...topParams };
  const names = {
    bidThreshold: '立ち強度', riskTolerance: 'リスク許容', leadAggression: 'リード積極性', followAggression: 'フォロー積極性',
    trumpBonus: '切り札評価', mightyBonus: 'マイティ評価', safeAceWeight: 'A温存', roleCardPreservation: '役札温存',
    deputyFeedBias: '副官の絵札回し', teamCooperationWeight: 'チーム連携', feedBonusWeight: 'エサやり', overkillPenalty: 'オーバーキル抑制',
    mctsSimulations: 'MCTS探索回数', mctsExploration: 'MCTS探索幅', handInferenceWeight: '手札推測', rolloutPolicyWeight: 'ロールアウト方策',
    planAccuracyWeight: '計画精度の重み', overbidPenalty: '過大評価ペナルティ', underbidPenalty: '過小評価ペナルティ', planAccuracyBonus: '計画精度ボーナス',
    bidPacingMs: '段階上げ間隔', bidStartValue: 'スタート枚数',
    tossUpSafetyMargin: '安全マージン', tossUpSafetyMarginBottom: '最下位安全マージン',
    signalS1Bonus: 'S1ボーナス', signalS2Bonus: 'S2ボーナス', signalThreeRoleBonus: '3役ボーナス', signalS3Bonus: 'S3ボーナス',
    s1RequiredMinorCards: 'S1必要A/2枚数', s3RequiredAces: 'S3必要A枚数',
    sameColorBidderLimit: '同色立会い上限', ntBidderLimit: 'NT立会い上限',
    s2ThreeRoleExtra: '3役追加上げ幅'
  };
  const deltas = Object.entries(PARAM_BOUNDS).map(([k, [lo, hi]]) => { const cur = top[k] ?? base[k]; return { key: k, name: names[k] || k, delta: (cur - base[k]) / (hi - lo || 1), cur, baseVal: base[k] }; }).sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta));
  const insights = deltas.slice(0, 3).map(d => ({ title: `${d.name}（${d.delta > 0 ? '増加' : '減少'}）`, detail: `初期値 ${d.baseVal.toFixed(2)} → ${d.cur.toFixed(2)}。改善に寄与した主要パラメータ。` }));
  insights.push({ title: '役割別勝率（最上位戦略）', detail: `ナポレオン時 ${(Number(strategies[0].nap_win_rate || 0) * 100).toFixed(1)}% / 副官時 ${(Number(strategies[0].deputy_win_rate || 0) * 100).toFixed(1)}% / 連合軍時 ${(Number(strategies[0].alliance_win_rate || 0) * 100).toFixed(1)}%` });
  if (strategies[0].avg_plan_accuracy != null) {
    insights.push({ title: '計画精度', detail: `競りで立てた計画と実績の一致率: ${(Number(strategies[0].avg_plan_accuracy || 0) * 100).toFixed(1)}%` });
  }
  const delta = Number(strategies[0].avg_rating_delta || 0);
  insights.push({ title: '平均レート上昇', detail: `1マッチあたり ${delta > 0 ? '+' : ''}${delta.toFixed(2)} pt（${strategies[0].matches}マッチの平均）。` });
  return insights;
}
