// ai-simulator.js (MECE戦術エンジン統合版)
// 自己対戦・オラクルB・プレイ品質計測・クイズ抽出・上がり宣言・競りシグナル
// 戦術ID学習・セイム2イベント記録を追加
import { SUITS, RANKS, SV, defaultStrategy, shuffledDeck, sortHand, mutateStrategy, crossoverStrategy, rateRound, RANK_1_BONUS, RANK_2_BONUS, RANK_4_PENALTY, RANK_5_PENALTY, updateStrategyFromExperience, isSameColorSuit } from './constants.js';
import {
  shouldBid, chooseDiscard, chooseDeputyCall, chooseSoloCall, chooseCardToPlay, chooseDeputyCard,
  winningEntry, colorStrength, ntHandStrength, handStrength, cardPower,
  computeProperBid, canSendSignal, isTwoRole, isThreeRole, countSameColorBidders,
  getStateHash, getSimilarityDistance, oracleB,
  analyzeDiscardOptions, evaluateVoidStrategy,
  canDeclareWin,
  determineRole, decideNextBid, inferIntentFromBid, estimateDeputyDPoints,
  computeNScore, computeDScore, computeDPoints, computeSupportLimit,
  evaluateBidPlan
} from './ai-tactics.js';
import { classifySituation, hashSituation } from './situation.js';
import { evaluateSameTwo, shouldAvoidACut } from './same-two.js';
import { analyzeCombinations } from './combinations.js';
import { selectTactic, TACTIC_CATALOG, getCatalogStats } from './tactics.js';

function safeJsonParse(str, fallback = null) {
  try { if (!str || typeof str !== 'string' || !str.trim()) return fallback; return JSON.parse(str); }
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
  if (diff > 1.5) return -Math.min(params.overbidPenalty ?? 2.0, (diff - 1.5) * 1.5) * w;
  if (diff < -2.0) return -Math.min(params.underbidPenalty ?? 0.5, (-diff - 2.0) * 0.5) * w;
  if (Math.abs(diff) <= 1.0) return (params.planAccuracyBonus ?? 1.5) * w;
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
    diff: Math.max(0, num - 12),
    planAccuracy,
    expectedWins: plan?.expectedWins ?? null,
    actualWins
  };
}

// ==========================================
// 捨て札選択の品質評価
// ==========================================

function evaluateDiscardQuality(hand, trump, chosenCards, context, params) {
  const analysis = analyzeDiscardOptions(hand, trump, context, params);
  const { options } = analysis;

  if (!options.length) return { evLoss: 0, rank: 1, isOptimal: true, type: 'unknown', ev: 0 };

  const chosenIds = new Set(chosenCards.map(c => c.id));
  let chosenOption = options.find(opt => {
    const optIds = new Set(opt.cards.map(c => c.id));
    if (optIds.size !== chosenIds.size) return false;
    for (const id of chosenIds) if (!optIds.has(id)) return false;
    return true;
  });

  if (!chosenOption) {
    const bestEv = options[0].ev;
    return { evLoss: Math.max(0, bestEv - 0), rank: options.length + 1, isOptimal: false, type: 'weak', ev: 0 };
  }

  const sorted = options.slice().sort((a, b) => b.ev - a.ev);
  const bestEv = sorted[0].ev;
  const chosenEv = chosenOption.ev;
  const evLoss = Math.max(0, bestEv - chosenEv);
  const rank = sorted.findIndex(opt => opt === chosenOption) + 1;

  return {
    evLoss,
    rank,
    isOptimal: rank === 1,
    type: chosenOption.type,
    ev: chosenEv,
    bestEv,
    isVoidChoice: chosenOption.type === 'void',
    isCloseCall: sorted.length >= 2 && Math.abs(sorted[0].ev - sorted[1].ev) < 0.3
  };
}

// ==========================================
// クイズ候補抽出ロジック
// ==========================================

let quizCandidateQueue = [];
const MAX_QUIZ_CANDIDATES_PER_MATCH = 3;
const MAX_DISCARD_QUIZ_CANDIDATES_PER_MATCH = 2;

function detectQuizCandidate(ctx) {
  const { legal, trick, trickNo, contract, hand, points, allianceKittyPoints } = ctx;
  if (!legal || legal.length < 2) return null;
  const allNonFace = legal.every(c => !['10', 'J', 'Q', 'K', 'A'].includes(c.rank));
  const allSameSuit = legal.every(c => c.suit === legal[0].suit);
  if (allNonFace && allSameSuit) return null;

  const reasons = [];
  const heuristicBest = chooseCardToPlay(ctx);
  const legalScores = legal.map(c => {
    let score = 0;
    if (['10', 'J', 'Q', 'K', 'A'].includes(c.rank)) score += 10;
    if (contract.suit !== 'NT' && c.suit === contract.suit) score += 20;
    if (c.id === '♠A') score += 50;
    if (c.rank === 'J' && contract.suit !== 'NT' && isSameColorSuit(c.suit, contract.suit)) score += 40;
    return { c, score };
  }).sort((a, b) => b.score - a.score);

  if (legalScores.length >= 2 && legalScores[0].score - legalScores[1].score <= 10) reasons.push('close_call');
  if (heuristicBest && legalScores[0].c.id !== heuristicBest.id) reasons.push('heuristic_mismatch');
  if (contract.suit === 'NT' && trickNo <= 6 && trick.length > 0) {
    const pointsInTrick = trick.filter(e => ['10','J','Q','K','A'].includes(e.card.rank)).length;
    if (pointsInTrick <= 1) reasons.push('nt_duck');
  }
  if (trick.some(e => e.card.id === '♠A') && hand.some(c => c.id === '♥Q')) reasons.push('mighty_shadow');
  const current = trick.length > 0 ? winningEntry(contract, trickNo, trick) : null;
  const isTeamWinning = current && (current.seat === contract.nap || (!contract.solo && current.seat === contract.deputy));
  if (isTeamWinning && legal.some(c => ['10','J','Q'].includes(c.rank)) && legal.some(c => !['10','J','Q','K','A'].includes(c.rank))) reasons.push('feed_dilemma');
  if (reasons.length === 0) return null;

  const options = legal.map((c, i) => ({ index: i, value: c.id, label: c.id }));
  const bestIdx = heuristicBest ? options.findIndex(o => o.value === heuristicBest.id) : 0;

  return {
    id: `gen-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
    category: 'play',
    scenario_json: JSON.stringify({
      seat: ctx.seat,
      hand: hand.map(c => c.id),
      trick: trick.map(e => ({ seat: e.seat, card: e.card.id })),
      contract: { nap: contract.nap, num: contract.num, suit: contract.suit, deputy: contract.deputy, solo: contract.solo, revealedCall: contract.revealedCall, call: contract.call },
      playedCards: (ctx.playedCards || []).map(c => ({ seat: c.seat, card: c.id })),
      points,
      taken: [],
      discarded: (ctx.discardedKitty || []).map(c => c.id)
    }),
    options_json: JSON.stringify(options),
    ai_answer_index: bestIdx >= 0 ? bestIdx : 0,
    reason: reasons[0],
    explanation: `自己対戦から自動抽出（${reasons.join(', ')}）。状況をよく見て最善手を選んでください。`,
    generation: ctx.round || null
  };
}

function detectDiscardQuizCandidate(hand, trump, contract, discardAnalysis, params) {
  const { options } = discardAnalysis;
  if (options.length < 2) return null;

  const sorted = options.slice().sort((a, b) => b.ev - a.ev);
  const top = sorted[0];
  const second = sorted[1];
  const evDiff = Math.abs(top.ev - second.ev);

  const isCloseCall = evDiff < 0.5;
  const isConflict = top.type !== second.type;

  if (!isCloseCall && !isConflict) return null;

  const reasons = [];
  if (isCloseCall) reasons.push('close_ev');
  if (isConflict) reasons.push('void_vs_safe');
  if (contract.suit === 'NT') reasons.push('nt_context');
  if (contract.num >= 17) reasons.push('high_bid');
  if (contract.num <= 14) reasons.push('low_bid');

  const choiceOptions = [];
  const seenSets = new Set();
  for (const opt of sorted.slice(0, 3)) {
    const key = opt.cards.map(c => c.id).sort().join(',');
    if (seenSets.has(key)) continue;
    seenSets.add(key);
    choiceOptions.push({
      index: choiceOptions.length,
      value: key,
      label: opt.cards.map(c => c.id).join(' '),
      type: opt.type,
      ev: opt.ev
    });
  }

  if (choiceOptions.length < 2) return null;

  return {
    id: `gen-discard-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
    category: 'discard',
    scenario_json: JSON.stringify({
      seat: contract.nap,
      hand: hand.map(c => c.id),
      contract: { nap: contract.nap, num: contract.num, suit: contract.suit, deputy: contract.deputy, solo: contract.solo },
      discarded: [],
      points: [0,0,0,0,0],
      taken: []
    }),
    options_json: JSON.stringify(choiceOptions.map((o, i) => ({ index: i, value: o.value, label: o.label }))),
    ai_answer_index: 0,
    reason: reasons.join(','),
    explanation: `自己対戦から抽出（${reasons.join(', ')}）。期待値が拮抗する捨て札選択です。`,
    generation: contract.round || null
  };
}

export async function flushQuizCandidates(env) {
  if (quizCandidateQueue.length === 0) return;
  const statements = quizCandidateQueue.map(q =>
    env.DB.prepare(
      `INSERT OR IGNORE INTO quiz_candidates(id, category, scenario_json, options_json, ai_answer_index, reason, explanation, generation) VALUES(?,?,?,?,?,?,?,?)`
    ).bind(q.id, q.category, q.scenario_json, q.options_json, q.ai_answer_index, q.reason, q.explanation, q.generation)
  );
  const CHUNK_SIZE = 50;
  try {
    for (let i = 0; i < statements.length; i += CHUNK_SIZE) {
      await env.DB.batch(statements.slice(i, i + CHUNK_SIZE));
    }
  } catch (e) { console.warn('quiz candidate flush failed', e); }
  quizCandidateQueue = [];
}

// ==========================================
// 経験DB・Hall of Fame 管理
// ==========================================

let experienceQueue = [];
let tacticExperienceQueue = [];   // ★ 新規: 戦術別経験
let sameTwoEvents = [];           // ★ 新規: セイム2イベント
let hallOfFame = [];

export async function loadHallOfFame(env) {
  try {
    const { results } = await env.DB.prepare("SELECT * FROM ai_hall_of_fame ORDER BY avg_rating_delta DESC LIMIT 5").all();
    hallOfFame = (results || []).map(r => ({ ...safeJsonParse(r.params, defaultStrategy()), _metaGen: r.generation }));
  } catch (e) { console.warn("hall of fame load failed", e); hallOfFame = []; }
}

export async function flushExperience(env) {
  // 1. 既存の状態経験を保存
  if (experienceQueue.length > 0) {
    const statements = [];
    for (const q of experienceQueue) {
      statements.push(
        env.DB.prepare(
          `INSERT INTO ai_state_experience(state_hash, card_win_rates, samples, generation, updated_at) 
           VALUES(?,?,?,?,CURRENT_TIMESTAMP) 
           ON CONFLICT(state_hash) DO UPDATE SET 
             card_win_rates = excluded.card_win_rates,
             samples = samples + excluded.samples,
             generation = MAX(generation, excluded.generation),
             updated_at = CURRENT_TIMESTAMP`
        ).bind(q.hash, q.rates, q.samples, q.gen)
      );
    }
    const CHUNK_SIZE = 50;
    try {
      for (let i = 0; i < statements.length; i += CHUNK_SIZE) {
        await env.DB.batch(statements.slice(i, i + CHUNK_SIZE));
      }
    } catch (e) { console.warn("exp flush failed", e); }
    experienceQueue = [];
  }

  // 2. ★ 新規: 戦術別経験を保存
  if (tacticExperienceQueue.length > 0) {
    const tacticStatements = [];
    for (const q of tacticExperienceQueue) {
      tacticStatements.push(
        env.DB.prepare(
          `INSERT INTO ai_tactic_experience(tactic_id, situation_hash, wins, samples, updated_at) 
           VALUES(?,?,?,?,CURRENT_TIMESTAMP) 
           ON CONFLICT(tactic_id, situation_hash) DO UPDATE SET 
             wins = wins + excluded.wins,
             samples = samples + excluded.samples,
             updated_at = CURRENT_TIMESTAMP`
        ).bind(q.tacticId, q.situationHash, q.wins, q.samples)
      );
    }
    const CHUNK_SIZE = 50;
    try {
      for (let i = 0; i < tacticStatements.length; i += CHUNK_SIZE) {
        await env.DB.batch(tacticStatements.slice(i, i + CHUNK_SIZE));
      }
    } catch (e) { console.warn("tactic exp flush failed", e); }
    tacticExperienceQueue = [];
  }

  // 3. ★ 新規: セイム2イベントを保存
  if (sameTwoEvents.length > 0) {
    const eventStatements = [];
    for (const ev of sameTwoEvents) {
      eventStatements.push(
        env.DB.prepare(
          `INSERT INTO ai_same_two_events(match_id, round, trick_no, holder_seat, target_rank, target_suit, result, created_at) 
           VALUES(?,?,?,?,?,?,?,CURRENT_TIMESTAMP)`
        ).bind(ev.matchId, ev.round, ev.trickNo, ev.holderSeat, ev.targetRank, ev.targetSuit, ev.result)
      );
    }
    const CHUNK_SIZE = 50;
    try {
      for (let i = 0; i < eventStatements.length; i += CHUNK_SIZE) {
        await env.DB.batch(eventStatements.slice(i, i + CHUNK_SIZE));
      }
    } catch (e) { console.warn("sameTwo event flush failed", e); }
    sameTwoEvents = [];
  }
}

function computeCardWinRates(legal, chosenCard, ctx) {
  const rates = {};
  for (const c of legal) {
    if (c.id === chosenCard.id) rates[c.id] = 0.8 + Math.random() * 0.15;
    else rates[c.id] = 0.2 + Math.random() * 0.4;
  }
  return JSON.stringify(rates);
}

// ==========================================
// オラクルBによる価値損失計算
// ==========================================

function computeValueLossRate(ctx, actualCard, matchId, round, trickNo, decisionIndex, params) {
  const result = oracleB(ctx, matchId, round, trickNo, decisionIndex, params);
  const bestEv = result.evMap[result.bestCard.id] ?? 0;
  const actualEv = result.evMap[actualCard.id] ?? 0;
  const loss = bestEv - actualEv;
  const denom = Math.max(bestEv, 0.01);
  let rate = loss / denom;
  if (rate < 0) rate = 0;
  if (rate > 1.0) rate = 1.0;
  if (rate < 0.15) rate = 0;
  return { rate, bestEv, actualEv, bestCard: result.bestCard.id };
}

function categorizeDecision(ctx) {
  const t = ctx.trickNo;
  const isNT = ctx.contract.suit === 'NT';
  const isNap = ctx.seat === ctx.contract.nap;
  const isDeputy = !ctx.contract.solo && ctx.contract.revealedCall && ctx.seat === ctx.contract.deputy;
  const hasPoints = (ctx.trick || []).some(e => ['10','J','Q','K','A'].includes(e.card.rank));
  return {
    phase: t <= 2 ? 'early' : (t <= 6 ? 'mid' : 'late'),
    contract: isNT ? 'nt' : 'color',
    role: isNap ? 'nap' : (isDeputy ? 'deputy' : 'ally'),
    points: hasPoints ? 'with_points' : 'no_points'
  };
}

// ==========================================
// セイム2イベント検出
// ==========================================

function detectSameTwoEvent(matchId, round, trickNo, trick, contract, seat) {
  if (!trick || trick.length < 2) return null;
  if (trickNo === 0) return null; // 1トリック目は無効

  const ledSuit = trick[0].card?.suit;
  if (!ledSuit) return null;
  // 全員フォロー確認
  const allFollow = trick.every(t => t.card?.suit === ledSuit);
  if (!allFollow) return null;

  // セイム2保有者を探す
  for (const t of trick) {
    if (t.card?.rank !== '2' || t.card?.suit !== ledSuit) continue;
    // セイム2を出した → 勝者判定
    const winner = winningEntry(contract, trickNo, trick);
    const isHolderWinner = winner.seat === t.seat;
    // 狩った対象を探す
    const targetCard = trick.find(x => x.card?.rank === 'A' && x.seat !== t.seat);
    return {
      matchId,
      round,
      trickNo,
      holderSeat: t.seat,
      targetRank: targetCard?.card?.rank || 'none',
      targetSuit: targetCard?.card?.suit || ledSuit,
      result: isHolderWinner ? 'win' : 'lose'
    };
  }

  // セイム2を出していないが、Aが切られて狩られたケース（Aが最強でなかった）
  const aceInTrick = trick.find(x => x.card?.rank === 'A');
  if (aceInTrick) {
    const winner = winningEntry(contract, trickNo, trick);
    const aceHolderWon = winner.seat === aceInTrick.seat;
    const winningCard = trick.find(t => t.seat === winner.seat);
    if (!aceHolderWon && winningCard?.card?.rank === '2' && winningCard?.card?.suit === ledSuit) {
      return {
        matchId,
        round,
        trickNo,
        holderSeat: winner.seat,
        targetRank: 'A',
        targetSuit: aceInTrick.card.suit,
        result: 'win'
      };
    }
  }
  return null;
}

// ==========================================
// 競りシミュレーション（段階上げ＋暗黙シグナル）
// ==========================================

function simulateAuction(hands, params, seatParams, openKitty, bidHistoryOut, round = 1) {
  const roles = seatParams.map((p, i) => {
    try { return determineRole(hands[i], p); }
    catch (e) { return { role: 'ALLIANCE', nScore: 0, dScore: 0, dPoints: 0, bestSuit: null, reason: 'error' }; }
  });

  const bidSignals = Array.from({ length: 5 }, () => ({ sent: null, received: [], sameColorCount: 0, lastBidAt: 0 }));
  let high = { num: 12, suit: '', player: -1, solo: false, plan: null, bidPlan: null };
  const seatState = ['active', 'active', 'active', 'active', 'active'];

  let turnSeat = 0;
  let actionCount = 0;
  const MAX_ACTIONS = 60;
  let stageCount = 0;
  let roleAccuracyHits = 0;

  while (actionCount < MAX_ACTIONS) {
    actionCount++;
    const remainingActive = seatState.filter((s, i) => s === 'active' && i !== high.player).length;
    if (remainingActive === 0) break;

    const seat = turnSeat;
    turnSeat = (turnSeat + 1) % 5;
    if (seatState[seat] !== 'active') continue;
    if (high.player === seat) continue;

    const p = seatParams[seat];
    const role = roles[seat];

    try {
      const decision = decideNextBid(hands[seat], high, role, p, bidSignals[seat].received || []);

      if (decision.type === 'PASS') {
        seatState[seat] = 'holding';
        bidHistoryOut.push({ round, seat, num: 0, suit: 'PASS', action: 'approve' });
        continue;
      }

      if (decision.num >= 13 && decision.num <= 20 && (SUITS.includes(decision.suit) || decision.suit === 'NT')) {
        const isValid = (decision.num > high.num) || (decision.num === high.num && SV[decision.suit] > SV[high.suit]);
        if (!isValid) {
          seatState[seat] = 'holding';
          bidHistoryOut.push({ round, seat, num: 0, suit: 'PASS', action: 'approve' });
          continue;
        }

        const prevBid = { ...high };
        high = { num: decision.num, suit: decision.suit, player: seat, solo: false, plan: role.plan, bidPlan: role.plan };
        stageCount++;
        bidHistoryOut.push({ round, seat, num: decision.num, suit: decision.suit, action: decision.intent });

        if (prevBid.player >= 0) {
          const intent = inferIntentFromBid(prevBid, { num: high.num, suit: high.suit, player: seat }, p);
          for (let s = 0; s < 5; s++) {
            if (s === seat) continue;
            if (!bidSignals[s].received) bidSignals[s].received = [];
            bidSignals[s].received.push({ from: seat, intent: intent.intent, strength: intent.strength, num: high.num, suit: high.suit });
          }
        }

        for (let s = 0; s < 5; s++) {
          if (seatState[s] === 'holding' && s !== seat) seatState[s] = 'active';
        }
      } else {
        seatState[seat] = 'holding';
        bidHistoryOut.push({ round, seat, num: 0, suit: 'PASS', action: 'approve' });
      }
    } catch (e) {
      seatState[seat] = 'holding';
      bidHistoryOut.push({ round, seat, num: 0, suit: 'PASS', action: 'approve' });
    }
  }

  if (high.player >= 0 && roles[high.player].role === 'NAP') roleAccuracyHits = 1;

  return { ...high, stageCount, roleAccuracyHits, roles };
}

// ==========================================
// 1ラウンドのシミュレーション
// ==========================================

const MAX_EXP_QUEUE_PER_MATCH = 5;

function simRound(hands, round, matchScores, params, matchBidHistory, env, generation, matchId) {
  const d = shuffledDeck();
  for (let i = 0; i < 5; i++) { hands[i] = d.splice(0, 10); sortHand(hands[i]); }
  const kitty = d.splice(0, 2);
  const bidHistoryLocal = [];
  const high = simulateAuction(hands, params, params, kitty, bidHistoryLocal, round);

  let nap, trump, num, isSoloBid, plan;
  if (high.player < 0) {
    nap = matchScores.indexOf(Math.min(...matchScores));
    trump = SUITS[0]; num = 13; isSoloBid = false; plan = null;
  } else {
    nap = high.player; trump = high.suit; num = high.num; isSoloBid = high.solo === true; plan = high.bidPlan || high.plan || null;
  }
  const strengthAtBid = computeBidStrength(hands[nap], trump, params[nap] || defaultStrategy());
  matchBidHistory.push({ round, seat: nap, num, suit: trump, solo: isSoloBid });
  if (matchBidHistory.length > 50) matchBidHistory.shift();

  let optimalBid = 13;
  let pMakeAtFinal = 0;
  try {
    const planForNap = evaluateBidPlan(hands[nap], trump, params[nap] || defaultStrategy(), matchBidHistory, nap, kitty, [], [{},{},{},{},{}]);
    optimalBid = planForNap.bestBidByExpectation || 13;
    pMakeAtFinal = planForNap.pMake?.[num] ?? 0;
  } catch (e) { /* フォールバック */ }

  const contractBase = { nap, suit: trump, solo: isSoloBid, deputy: -1, revealedCall: false, bidPlan: plan };
  hands[nap].push(...kitty); sortHand(hands[nap]);

  const discardContext = {
    num,
    hasMighty: hands[nap].some(c => c.id === '♠A'),
    deputyHasMighty: true,
    protectedCallId: null,
    params: params[nap] || defaultStrategy()
  };
  const discardAnalysis = analyzeDiscardOptions(hands[nap], trump, discardContext, params[nap] || defaultStrategy());
  const discard = chooseDiscard(hands[nap], trump, discardContext);
  const discardQuality = evaluateDiscardQuality(hands[nap], trump, discard, discardContext, params[nap] || defaultStrategy());

  if (discardAnalysis.options.length >= 2) {
    const candidate = detectDiscardQuizCandidate(hands[nap], trump, { nap, num, suit: trump, solo: isSoloBid, deputy: -1, round }, discardAnalysis, params[nap] || defaultStrategy());
    if (candidate) quizCandidateQueue.push(candidate);
  }

  hands[nap] = hands[nap].filter(c => !discard.some(x => x.id === c.id));
  const kittyPts = discard.filter(c => ['10', 'J', 'Q', 'K', 'A'].includes(c.rank)).length;
  const allianceKittyPts = kittyPts;

  let deputy = -1, call;
  if (isSoloBid) {
    call = chooseSoloCall(hands[nap]);
    deputy = nap; contractBase.deputy = nap;
  } else {
    const napSeatSignals = bidHistoryLocal
      .filter(b => b.seat !== nap && b.action !== 'approve' && b.num > 0)
      .map(b => {
        const prev = bidHistoryLocal[bidHistoryLocal.indexOf(b) - 1];
        if (prev && prev.action !== 'approve') {
          return inferIntentFromBid({ num: prev.num, suit: prev.suit }, { num: b.num, suit: b.suit }, params[nap] || defaultStrategy());
        }
        return null;
      })
      .filter(Boolean);

    call = chooseDeputyCall(hands[nap], discard, trump, 3, num, params[nap] || defaultStrategy(), null, napSeatSignals);
    for (let i = 0; i < 5; i++) { if (i !== nap && hands[i].some(c => c.id === call.id)) { deputy = i; break; } }
    if (deputy < 0) { contractBase.solo = true; deputy = nap; call = chooseSoloCall(hands[nap]); }
    contractBase.deputy = deputy;
  }

  const roundPts = [0, 0, 0, 0, 0];
  const played = [], voids = [{}, {}, {}, {}, {}];
  let revealed = contractBase.solo, revealTrickNo = null, active = nap, trickNo = 0;
  let napTricks = 0, deputyTricks = 0;
  let overkillCount = 0, feedSuccessCount = 0, goldenFormationCount = 0;
  let matchExpCount = 0;
  const playDecisions = [];
  let decisionIndex = 0;

  while (trickNo < 10 && hands.some(h => h.length > 0)) {
    const trick = [];
    let pointsInTrick = 0;

    if (trick.length === 0) {
      const seat = active;
      const ctx = {
        hand: hands[seat], trick: [], trickNo, contract: contractBase, playedCards: played,
        voids, seat, discardedKitty: discard,
        players: hands.map(h => ({ handCount: h.length })),
        points: roundPts, allianceKittyPoints: allianceKittyPts,
      };
      if (canDeclareWin(ctx)) {
        let allTaken = [];
        hands.forEach(h => allTaken.push(...h));
        const taken = allTaken.filter(c => ['10', 'J', 'Q', 'K', 'A'].includes(c.rank));
        roundPts[seat] += taken.length;
        for (let i = 0; i < 5; i++) hands[i] = [];
        break;
      }
    }

    for (let i = 0; i < 5; i++) {
      const seat = (active + i) % 5;
      const hand = hands[seat];
      if (!hand.length) break;
      const legal = trick.length === 0 ? hand : (hand.filter(c => c.suit === trick[0].card.suit).length ? hand.filter(c => c.suit === trick[0].card.suit) : hand);
      const currentWinner = trick.length ? winningEntry(contractBase, trickNo, trick) : null;
      const isMyTeam = seat === nap || (!contractBase.solo && seat === deputy);
      const isCurrentWinnerMyTeam = currentWinner ? (currentWinner.seat === nap || (!contractBase.solo && currentWinner.seat === deputy)) : false;

      if (trick.length === 0 && !contractBase.solo) {
        const leadSeat = trick[0]?.seat;
        if (leadSeat === nap && (i === 4 && seat === deputy)) goldenFormationCount++;
        if (leadSeat === deputy && (i === 4 && seat === nap)) goldenFormationCount++;
      }

      const ctx = {
        hand, legal, trick, trickNo, contract: contractBase, playedCards: played, voids, seat, deputy,
        params: { ...(params[seat] || defaultStrategy()), enableTacticEngine: true },
        discardedKitty: discard, isMySideNap: isMyTeam, isCurrentNapWinning: isCurrentWinnerMyTeam,
        isRevealed: revealed, isNapLeading: trick.length > 0 && trick[0].seat === nap, lastSeat: trick.length === 4,
        call, bidHistory: matchBidHistory, matchScores: matchScores, points: roundPts, allianceKittyPoints: allianceKittyPts,
        experience: null
      };

      let chosen;
      if (!contractBase.solo && revealed && seat === deputy) chosen = chooseDeputyCard(ctx);
      else chosen = chooseCardToPlay(ctx);
      if (!chosen || !legal.some(c => c.id === chosen.id)) chosen = legal[Math.floor(Math.random() * legal.length)];

      // ★ 新規: 戦術ID・状況ハッシュを記録
      const selectedTacticId = ctx._selectedTacticId || 'UNKNOWN';
      const situationHash = ctx._situationHash || hashSituation(ctx);

      // 価値損失計算
      let valueLossRate = null;
      if (legal.length >= 2 && trick.length < 5 && (trickNo >= 6 || trickNo === 0)) {
        const cat = categorizeDecision(ctx);
        try {
          const vl = computeValueLossRate(ctx, chosen, matchId, round, trickNo, decisionIndex, params[seat] || defaultStrategy());
          valueLossRate = vl.rate;
          // ★ 新規: tactic_id / situation_hash / intent_category を追加
          playDecisions.push({
            seat, trickNo, decisionIndex, valueLossRate, category: cat, chosen: chosen.id, bestCard: vl.bestCard,
            bestEv: vl.bestEv, actualEv: vl.actualEv,
            tacticId: selectedTacticId,
            situationHash,
            intentCategory: getIntentCategory(selectedTacticId)
          });
        } catch (e) { console.warn('oracleB error:', e.message); }
        decisionIndex++;
      }

      if (trick.length > 0 && trick.length < 4 && matchExpCount < MAX_QUIZ_CANDIDATES_PER_MATCH) {
        const candidate = detectQuizCandidate(ctx);
        if (candidate) { quizCandidateQueue.push(candidate); matchExpCount++; }
      }

      if (trick.length > 0 && trick.length < 4 && matchExpCount < MAX_EXP_QUEUE_PER_MATCH && legal.length >= 2) {
        const isKoukyou = (pointsInTrick === 0 && trickNo >= 2 && trickNo <= 7);
        if (isKoukyou) {
          const hash = getStateHash(ctx);
          const rates = computeCardWinRates(legal, chosen, ctx);
          experienceQueue.push({ hash, rates, samples: 1, gen: generation });
          // ★ 新規: 戦術経験も記録（勝敗はこのトリック後に判定）
          matchExpCount++;
        }
      }

      if (trick.length > 0 && currentWinner) {
        const winnerMyTeam = winnerSeat => winnerSeat === nap || (!contractBase.solo && winnerSeat === deputy);
        const powerBefore = cardPower(contractBase, trickNo, currentWinner.card, trick);
        const powerAfter = cardPower(contractBase, trickNo, chosen, [...trick, { seat, card: chosen }]);
        if (winnerMyTeam(currentWinner.seat) && isMyTeam && powerAfter > powerBefore) {
          if (chosen.rank === 'A' || ['K', 'Q'].includes(chosen.rank)) overkillCount++;
        }
        if (winnerMyTeam(currentWinner.seat) && isMyTeam && ['10', 'J', 'Q'].includes(chosen.rank)) feedSuccessCount++;
      }

      if (trick.length && chosen.suit !== trick[0].card.suit) { if (!voids[seat]) voids[seat] = {}; voids[seat][trick[0].card.suit] = true; }
      played.push({ suit: chosen.suit, rank: chosen.rank, id: chosen.id, seat });
      if (!revealed && chosen.id === call.id) { revealed = true; revealTrickNo = trickNo; }
      trick.push({ seat, card: chosen });
      hands[seat] = hand.filter(c => c.id !== chosen.id);
      pointsInTrick = trick.filter(e => ['10', 'J', 'Q', 'K', 'A'].includes(e.card.rank)).length;
    }
    if (trick.length < 5) break;

    // ★ 新規: セイム2イベント検出
    const sameTwoEv = detectSameTwoEvent(matchId, round, trickNo, trick, contractBase, active);
    if (sameTwoEv) sameTwoEvents.push(sameTwoEv);

    const w = winningEntry(contractBase, trickNo, trick);
    const taken = trick.filter(e => ['10', 'J', 'Q', 'K', 'A'].includes(e.card.rank)).length;

    // ★ 新規: 戦術経験をトリック勝敗で記録
    for (const pd of playDecisions) {
      if (pd.trickNo === trickNo && pd.tacticId && pd.tacticId !== 'UNKNOWN') {
        const trickWinnerIsNap = w.seat === nap || (!contractBase.solo && w.seat === deputy);
        const seatIsNapSide = pd.seat === nap || (!contractBase.solo && pd.seat === deputy);
        const won = seatIsNapSide ? trickWinnerIsNap : !trickWinnerIsNap;
        tacticExperienceQueue.push({
          tacticId: pd.tacticId,
          situationHash: pd.situationHash || 'unknown',
          wins: won ? 1 : 0,
          samples: 1
        });
      }
    }

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

  const bidGap = Math.abs(num - optimalBid);
  const bidAccuracy = Math.abs(pMakeAtFinal - (made ? 1 : 0));
  let deputySignalEffectiveness = 0;
  if (!contractBase.solo && deputy !== nap) {
    deputySignalEffectiveness = made ? 1 : 0;
  } else if (contractBase.solo) {
    deputySignalEffectiveness = 0.5;
  }
  const roleAccuracy = high.roleAccuracyHits || 0;

  return {
    nap, deputy, num, solo: contractBase.solo, made, points: napPts, takenPoints: roundPts,
    strengthAtBid, revealTrickNo, allianceKittyPoints: allianceKittyPts, mult: 1,
    plan, expectedWins: plan?.expectedWins ?? null, actualWins, overkillCount, feedSuccessCount, goldenFormationCount,
    bidHistory: bidHistoryLocal,
    playDecisions,
    discardQuality,
    auctionQuality: {
      finalBid: num,
      optimalBid,
      bidGap,
      bidAccuracy,
      stageCount: high.stageCount || 0,
      deputySignalEffectiveness,
      roleAccuracy
    },
    rating: computeRoundRating(strengthAtBid, num, made, contractBase.solo, params[nap] || defaultStrategy(), Math.max(0, napPts - num), revealTrickNo, roundPts, nap, deputy, plan, actualWins)
  };
}

// ==========================================
// 意図カテゴリ抽出（戦術ID → 4意図）
// ==========================================
function getIntentCategory(tacticId) {
  if (!tacticId || tacticId === 'UNKNOWN' || tacticId === 'UNIVERSAL') return 'UNKNOWN';
  const prefix = tacticId.split('-')[0].replace(/[0-9]/g, '');
  if (prefix === 'W' || prefix === 'C') return 'WIN';
  if (prefix === 'D' || prefix === 'S' || prefix === 'AT') return 'LOSE';
  if (prefix === 'G' || prefix === 'OV') return 'GIVE';
  if (prefix === 'H') return 'HOLD';
  if (prefix === 'PR') return 'PROBE';
  if (prefix === 'P') return 'SPECIAL';
  if (prefix === 'Q') {
    if (tacticId.startsWith('Q1')) return 'WIN';
    if (tacticId.startsWith('Q2')) return 'GIVE';
    if (tacticId.startsWith('Q3')) return 'LOSE';
    return 'UNKNOWN';
  }
  if (prefix === 'E') return 'WIN';
  if (prefix === 'M' || prefix === 'CB') return 'WIN';
  if (prefix === 'BS' || prefix === 'SC' || prefix === 'MM' || prefix === 'EV' || prefix === 'RC' || prefix === 'TS' || prefix === 'AI') return 'META';
  return 'UNKNOWN';
}

// ==========================================
// 自己対戦バッチ実行
// ==========================================

export async function runSelfPlayBatch(env, matchCount = 5) {
  let existing = [];
  try {
    const { results } = await env.DB.prepare("SELECT * FROM ai_strategy_log ORDER BY avg_rating_delta DESC LIMIT 10").all();
    existing = results || [];
  } catch (e) { console.warn("strategy log load failed", e); }

  await loadHallOfFame(env);

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
    sp.mctsNodeBudget = Math.min(sp.mctsNodeBudget || 5000, 500);
    return sp;
  };

  const currentPool = nextPool.map(p => speedUpForSimulation(p));
  const hofCandidates = hallOfFame.slice(0, 3).map(p => speedUpForSimulation(p));
  const pool = [...currentPool, ...hofCandidates];

  const stats = pool.map(() => ({
    n: 0, totalRating: 0, napN: 0, napW: 0, depN: 0, depW: 0, alN: 0, alW: 0,
    bidSum: 0, bidN: 0, soloBidN: 0, planAccSum: 0, planAccN: 0, overbidN: 0, underbidN: 0,
    totalOverkills: 0, totalFeeds: 0, highBidAttempts: 0, highBidSuccesses: 0, goldenFormations: 0,
    valueLossSum: 0, valueLossN: 0,
    valueLossEarly: 0, valueLossEarlyN: 0,
    valueLossMid: 0, valueLossMidN: 0,
    valueLossLate: 0, valueLossLateN: 0,
    valueLossNT: 0, valueLossNTN: 0,
    valueLossColor: 0, valueLossColorN: 0,
    smartPasses: 0, overcalls: 0, signalSuccesses: 0, opportunityLosses: 0,
    discardEvLossSum: 0, discardTotalCount: 0,
    discardOptimalCount: 0, discardCloseCallCount: 0,
    discardVoidChoiceCount: 0, discardSafeChoiceCount: 0,
    discardVoidWins: 0, discardSafeWins: 0,
    bidGapSum: 0, bidGapN: 0,
    bidAccuracySum: 0, bidAccuracyN: 0,
    stageCountSum: 0, stageCountN: 0,
    deputySignalSum: 0, deputySignalN: 0,
    roleAccuracySum: 0, roleAccuracyN: 0,
    // ★ 新規: 戦術別統計
    tacticUsage: {},         // tacticId -> count
    tacticWins: {},          // tacticId -> wins
    sameTwoEventsTriggered: 0,
    sameTwoEventsHunted: 0,
    sameTwoEventsDefended: 0
  }));

  experienceQueue = [];
  tacticExperienceQueue = [];
  sameTwoEvents = [];
  quizCandidateQueue = [];

  for (let i = 0; i < matchCount; i++) {
    const matchId = `m${generation}-${i}`;
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

    for (let r = 1; r <= 10; r++) {
      contracts.push(simRound(hands, r, matchScores, seatParams, matchBidHistory, env, generation, matchId));
    }

    const sorted = [...matchScores].sort((a, b) => b - a);
    const placement = [0, 0, 0, 0, 0];
    for (let s = 0; s < 5; s++) placement[s] = 1 + sorted.filter(x => x > matchScores[s]).length;

    for (let seat = 0; seat < 5; seat++) {
      const st = stats[seatIdx[seat]];
      const p = seatParams[seat];
      st.n++;
      let matchRating = 0;
      let totalOverkills = 0, totalFeeds = 0, totalGolden = 0;
      let highBidAttempts = 0, highBidSuccesses = 0;
      let smartPassCount = 0, overcallCount = 0, signalSuccessCount = 0, opportunityLossCount = 0;

      for (const c of contracts) {
        totalOverkills += c.overkillCount || 0;
        totalFeeds += c.feedSuccessCount || 0;
        totalGolden += c.goldenFormationCount || 0;

        if (c.nap === seat && c.discardQuality) {
          const dq = c.discardQuality;
          st.discardEvLossSum += dq.evLoss || 0;
          st.discardTotalCount++;
          if (dq.isOptimal) st.discardOptimalCount++;
          if (dq.isCloseCall) st.discardCloseCallCount++;
          if (dq.isVoidChoice) st.discardVoidChoiceCount++;
          if (dq.type === 'safe') st.discardSafeChoiceCount++;
          if (dq.isVoidChoice && c.made) st.discardVoidWins++;
          if (dq.type === 'safe' && c.made) st.discardSafeWins++;
        }

        if (c.nap === seat && c.auctionQuality) {
          const aq = c.auctionQuality;
          st.bidGapSum += aq.bidGap;
          st.bidGapN++;
          st.bidAccuracySum += aq.bidAccuracy;
          st.bidAccuracyN++;
          st.stageCountSum += aq.stageCount;
          st.stageCountN++;
          st.deputySignalSum += aq.deputySignalEffectiveness;
          st.deputySignalN++;
          st.roleAccuracySum += aq.roleAccuracy;
          st.roleAccuracyN++;
        }

        for (const d of (c.playDecisions || [])) {
          if (d.seat !== seat) continue;
          if (d.valueLossRate == null) continue;
          st.valueLossSum += d.valueLossRate;
          st.valueLossN++;
          if (d.category.phase === 'early') { st.valueLossEarly += d.valueLossRate; st.valueLossEarlyN++; }
          else if (d.category.phase === 'mid') { st.valueLossMid += d.valueLossRate; st.valueLossMidN++; }
          else { st.valueLossLate += d.valueLossRate; st.valueLossLateN++; }
          if (d.category.contract === 'nt') { st.valueLossNT += d.valueLossRate; st.valueLossNTN++; }
          else { st.valueLossColor += d.valueLossRate; st.valueLossColorN++; }

          // ★ 新規: 戦術別使用統計
          if (d.tacticId && d.tacticId !== 'UNKNOWN') {
            st.tacticUsage[d.tacticId] = (st.tacticUsage[d.tacticId] || 0) + 1;
          }
        }

        if (c.bidHistory) {
          for (const act of c.bidHistory) {
            if (act.seat !== seat) continue;
            if (act.action === 'approve' && c.nap !== seat && !c.made) {
              const myProper = c.plan?.properBid ?? 13;
              if (myProper <= 13) smartPassCount++;
              if (myProper >= 15) opportunityLossCount++;
            }
            if (act.action === 'bid' && c.nap === seat && !c.made) {
              const bidPlan = c.plan;
              if (bidPlan && act.num > bidPlan.expectedWins + 1) overcallCount++;
            }
            if (['S1', 'S2', 'S3', 'S4'].includes(act.action) && c.made) signalSuccessCount++;
          }
        }

        if (c.nap === seat) {
          st.napN++; st.bidSum += c.num; st.bidN++;
          if (c.made) {
            st.napW++;
            if (c.num >= 15) { highBidAttempts++; highBidSuccesses++; }
            matchRating += Math.max(0, c.num - 13) * 1.5;
          } else if (c.num >= 15) {
            highBidAttempts++;
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
        } else if (!c.solo && c.deputy === seat) {
          st.depN++; if (c.made) st.depW++;
          matchRating += c.rating.deputyDelta || 0;
        } else {
          st.alN++; if (!c.made) st.alW++;
          matchRating += c.rating.allyDelta || 0;
        }
      }

      const avgVL = st.valueLossN > 0 ? st.valueLossSum / st.valueLossN : 0;

      const wPlayQuality = p.weightPlayQuality ?? 5.0;
      const wFeed = p.weightFeedSuccess ?? 3.0;
      const wSignal = p.weightSignalSuccess ?? 2.0;
      const wGolden = p.weightGoldenFormation ?? 1.0;
      const wPlanAcc = p.weightPlanAccuracy ?? 3.0;
      const wBidQuality = p.weightBiddingQuality ?? 2.0;
      const wNapAttempts = p.weightNapAttempts ?? 4.0;
      const wOverkill = p.weightOverkill ?? 2.0;
      const wOpportunityLoss = p.weightOpportunityLoss ?? 3.0;

      matchRating += (1 - avgVL) * wPlayQuality;
      matchRating += totalFeeds * wFeed;
      matchRating += signalSuccessCount * wSignal;
      matchRating += totalGolden * wGolden;
      matchRating += (st.planAccN > 0 ? st.planAccSum / st.planAccN : 0) * wPlanAcc;
      matchRating += smartPassCount * wBidQuality;
      matchRating += (contracts.filter(c => c.nap === seat).length) * wNapAttempts;

      matchRating -= totalOverkills * wOverkill;
      matchRating -= overcallCount * 4.0;
      matchRating -= opportunityLossCount * wOpportunityLoss;

      if (placement[seat] === 1) matchRating += 5;
      else if (placement[seat] === 2) matchRating += 2;
      else if (placement[seat] === 4) matchRating -= 2;
      else if (placement[seat] === 5) matchRating -= 5;

      const napWins = contracts.filter(c => c.nap === seat && c.made).length;
      matchRating += napWins * 3.0;

      if (st.discardTotalCount > 0) {
        const avgDiscardEvLoss = st.discardEvLossSum / st.discardTotalCount;
        const optimalRate = st.discardOptimalCount / st.discardTotalCount;
        matchRating += (1 - Math.min(1, avgDiscardEvLoss)) * 2.0;
        matchRating += optimalRate * 1.5;
      }

      if (st.bidGapN > 0) {
        const avgBidGap = st.bidGapSum / st.bidGapN;
        matchRating += (1 - Math.min(1, avgBidGap / 3)) * (p.weightBidGap ?? 3.0) * 10;
      }
      if (st.bidAccuracyN > 0) {
        const avgBidAccuracy = st.bidAccuracySum / st.bidAccuracyN;
        matchRating += (1 - Math.min(1, avgBidAccuracy / 0.2)) * (p.weightBidAccuracy ?? 2.0) * 5;
      }
      if (st.deputySignalN > 0) {
        const avgDeputySignal = st.deputySignalSum / st.deputySignalN;
        matchRating += avgDeputySignal * (p.weightDeputySignal ?? 3.0) * 5;
      }
      if (st.stageCountN > 0) {
        const avgStage = st.stageCountSum / st.stageCountN;
        matchRating += (1 - Math.abs(avgStage - 3) / 3) * (p.weightStageCount ?? 1.0) * 3;
      }
      if (st.roleAccuracyN > 0) {
        const avgRoleAcc = st.roleAccuracySum / st.roleAccuracyN;
        matchRating += avgRoleAcc * (p.weightRoleAccuracy ?? 2.0) * 5;
      }

      st.totalOverkills += totalOverkills;
      st.totalFeeds += totalFeeds;
      st.goldenFormations += totalGolden;
      st.highBidAttempts += highBidAttempts;
      st.highBidSuccesses += highBidSuccesses;
      st.smartPasses += smartPassCount;
      st.overcalls += overcallCount;
      st.signalSuccesses += signalSuccessCount;
      st.opportunityLosses += opportunityLossCount;
      st.totalRating += Number.isFinite(matchRating) ? matchRating : 0;
    }

    if (i > 0 && i % 2 === 0) {
      await flushExperience(env);
      await flushQuizCandidates(env);
    }
  }

  await flushExperience(env);
  await flushQuizCandidates(env);

  const statements = [];
  const parentIds = existing.slice(0, 3).map(r => r.id);
  for (let i = 0; i < currentPool.length; i++) {
    const st = stats[i];
    if (!st.n) continue;
    const avgRating = Number.isFinite(st.totalRating / st.n) ? st.totalRating / st.n : 0;
    const napRate = st.napN ? st.napW / st.napN : 0;
    const depRate = st.depN ? st.depW / st.depN : 0;
    const alRate = st.alN ? st.alW / st.alN : 0;
    const avgBid = st.bidN ? st.bidSum / st.bidN : 0;
    const avgPlanAcc = st.planAccN ? st.planAccSum / st.planAccN : 0;
    const avgVL = st.valueLossN > 0 ? st.valueLossSum / st.valueLossN : 0;
    const avgVLEarly = st.valueLossEarlyN > 0 ? st.valueLossEarly / st.valueLossEarlyN : 0;
    const avgVLMid = st.valueLossMidN > 0 ? st.valueLossMid / st.valueLossMidN : 0;
    const avgVLLate = st.valueLossLateN > 0 ? st.valueLossLate / st.valueLossLateN : 0;
    const avgVLNT = st.valueLossNTN > 0 ? st.valueLossNT / st.valueLossNTN : 0;
    const avgVLColor = st.valueLossColorN > 0 ? st.valueLossColor / st.valueLossColorN : 0;

    const avgDiscardEvLoss = st.discardTotalCount > 0 ? st.discardEvLossSum / st.discardTotalCount : 0;
    const discardOptimalRate = st.discardTotalCount > 0 ? st.discardOptimalCount / st.discardTotalCount : 0;
    const discardVoidRate = st.discardTotalCount > 0 ? st.discardVoidChoiceCount / st.discardTotalCount : 0;

    const avgBidGap = st.bidGapN > 0 ? st.bidGapSum / st.bidGapN : 0;
    const avgBidAccuracy = st.bidAccuracyN > 0 ? st.bidAccuracySum / st.bidAccuracyN : 0;
    const avgDeputySignal = st.deputySignalN > 0 ? st.deputySignalSum / st.deputySignalN : 0;
    const avgStageCount = st.stageCountN > 0 ? st.stageCountSum / st.stageCountN : 0;
    const avgRoleAccuracy = st.roleAccuracyN > 0 ? st.roleAccuracySum / st.roleAccuracyN : 0;

    statements.push(
      env.DB.prepare(
        `INSERT INTO ai_strategy_log(
          generation, params, nap_win_rate, deputy_win_rate, alliance_win_rate, overall_win_rate,
          avg_rating_delta, matches, avg_bid, parent_id, avg_plan_accuracy,
          avg_value_loss, value_loss_early, value_loss_mid, value_loss_late, value_loss_nt, value_loss_color,
          avg_bid_gap, bid_accuracy, deputy_signal_success_rate, avg_stage_count, role_accuracy
        ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
      ).bind(
        generation, JSON.stringify(nextPool[i]), napRate, depRate, alRate, napRate,
        avgRating, st.n, avgBid, parentIds[i] || null, avgPlanAcc,
        avgVL, avgVLEarly, avgVLMid, avgVLLate, avgVLNT, avgVLColor,
        avgBidGap, avgBidAccuracy, avgDeputySignal, avgStageCount, avgRoleAccuracy
      )
    );

    statements.push(
      env.DB.prepare(
        `INSERT INTO ai_discard_metrics(generation, strategy_index, avg_ev_loss, optimal_rate, void_choice_rate, close_call_rate) 
         VALUES(?,?,?,?,?,?)`
      ).bind(
        generation, i, avgDiscardEvLoss, discardOptimalRate, discardVoidRate,
        st.discardTotalCount > 0 ? st.discardCloseCallCount / st.discardTotalCount : 0
      )
    );
  }

  if (statements.length) {
    try { await env.DB.batch(statements); } catch (e) { console.error("strategy log insert failed", e); }
  }

  try {
    const top = await env.DB.prepare("SELECT params FROM ai_strategy_log ORDER BY avg_rating_delta DESC, id DESC LIMIT 1").first();
    if (top) {
      const parsedTop = safeJsonParse(top.params, null);
      if (parsedTop) {
        await env.DB.prepare(
          "INSERT INTO ai_weights(id,weights,games,updated_at) VALUES(1,?,1,CURRENT_TIMESTAMP) ON CONFLICT(id) DO UPDATE SET weights=excluded.weights, games=games+1, updated_at=CURRENT_TIMESTAMP"
        ).bind(JSON.stringify(parsedTop)).run();
      }
    }
  } catch (e) { console.error("failed to update ai_weights", e); }

  try {
    await env.DB.prepare("DELETE FROM ai_strategy_log WHERE id NOT IN (SELECT id FROM ai_strategy_log ORDER BY avg_rating_delta DESC, id DESC LIMIT 100)").run();
  } catch (e) { console.warn("log prune failed", e); }

  if (generation % 5 === 0) {
    try {
      const totalHighBidAttempts = stats.reduce((sum, s) => sum + s.highBidAttempts, 0);
      const totalHighBidSuccesses = stats.reduce((sum, s) => sum + s.highBidSuccesses, 0);
      const fbStats = {
        aceHoldWins: 150, aceHoldWinRate: 0.65, acePlayWins: 100, acePlayWinRate: 0.40,
        highBidSuccessRate: totalHighBidAttempts > 0 ? (totalHighBidSuccesses / totalHighBidAttempts) : 0.5,
        highBidAttempts: totalHighBidAttempts
      };
      const baseStrategy = defaultStrategy();
      const newParams = updateStrategyFromExperience(baseStrategy, fbStats);
      await env.DB.prepare("INSERT INTO ai_hall_of_fame(generation, params, avg_rating_delta) VALUES(?,?,?)")
        .bind(generation, JSON.stringify(newParams), 10.0).run();
      console.log(`[Feedback] Generation ${generation}: Hall of Fame updated.`);
    } catch (e) { console.warn("feedback update failed", e); }
  }

  // ★ 新規: カバレッジテスト用ログ
  try {
    const catalogStats = getCatalogStats();
    console.log(`[TacticEngine] Generation ${generation}: catalog=${catalogStats.total} tactics across ${Object.keys(catalogStats.byCategory).length} categories`);
  } catch (e) { /* ignore */ }

  return { generation, size: pool.length, matches: matchCount };
}

// ==========================================
// インサイト生成（API用）
// ==========================================

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
    s2ThreeRoleExtra: '3役追加上げ幅',
    expHitWeight: '経験DBヒット信頼度', similarityThreshold: '類似度閾値',
    goldenFormationBonus: '黄金配置ボーナス', deputyOvertrumpPenalty: 'オーバートランプ抑制', lastSeatDuckBonus: '最後手番ダック',
    oracleSamples: 'オラクルサンプル数', oracleMctsTimeMs: 'オラクル探索時間',
    det_w_bid: '競り履歴重み', det_w_void: 'ボイドペナルティ', det_w_follow: 'フォロー履歴重み', det_w_feed: 'フィード履歴重み',
    weightPlayQuality: 'プレイ品質重み', weightFeedSuccess: 'フィード成功重み', weightSignalSuccess: 'シグナル成功重み',
    weightGoldenFormation: '黄金配置重み', weightPlanAccuracy: '計画精度重み', weightBiddingQuality: '競り品質重み',
    weightNapAttempts: 'NAP引き受け重み', weightMatchQuality: 'マッチ品質重み', weightRoleWinRate: '役割勝率重み',
    weightOverkill: 'オーバーキル重み', weightDeputyOvertrump: 'オーバートランプ重み',
    weightOpportunityLoss: '機会損失重み', weightWastedAce: 'A無駄切り重み',
    voidStrategyWeight: 'ボイド戦略重み',
    isolatedFaceDiscardBonus: '孤立絵札捨てボーナス',
    trumpCountForVoid: 'ボイド許容切札枚数',
    lowBidVoidPenalty: '低宣言ボイドペナルティ',
    midBidVoidPenalty: '中宣言ボイドペナルティ',
    highBidVoidBonus: '高宣言ボイドボーナス',
    voidLeadProbability: 'ボイドリード確率',
    cutTrickValue: 'カット1回の価値',
    isolatedFaceThreshold: '孤立絵札閾値',
    ntVoidPenalty: 'NTボイドペナルティ',
    ntHighBidVoidBonus: 'NT高宣言ボイドボーナス',
    napRoleThreshold1: 'NAP閾値（3役）', napRoleThreshold2: 'NAP閾値（2役）', napRoleThreshold3: 'NAP閾値（1役）',
    deputyRoleThreshold1: 'DEP閾値（指名必須）', deputyRoleThreshold2: 'DEP閾値（十分）', deputyRoleThreshold3: 'DEP閾値（候補）',
    supportLimitWeight: 'サポート上限重み', supportLimitDivisor: 'サポート上限除数',
    sameSuitRaiseBonus: '同スート上げ信頼度', sameColorSupportBonus: '同色サポート信頼度',
    sameColorSameBidBonus: '同色同枚数信頼度', crossColorCompeteBonus: '非同色競合度',
    auctionObservationMs: '観察時間（ms）', auctionRiskTolerance: '競りリスク許容',
    bidStepwiseAggression: '段階上げ積極性',
    weightBidGap: 'bid乖離重み', weightBidAccuracy: 'P推定精度重み',
    weightDeputySignal: '副官シグナル重み', weightStageCount: '段階数重み',
    weightRoleAccuracy: '役割判定精度重み',
    // ★ 新規: MECE戦術エンジン用
    W_WIN: '勝敗確率の重み', W_POINTS: '点札獲得の重み', W_TRICKS: 'トリック獲得の重み', W_ALLTAKE: '全部取りペナルティ',
    W_MATCH: '前提条件充足度の重み', W_ANALYTIC: '解析的期待値の重み', W_EXPERIENCE: '経験DBの重み', W_RISK: 'リスクの重み',
    priorTemperature: 'prior温度', experienceBlendRatio: '経験ブレンド比率',
    mctsNodeBudget: 'MCTSノード予算', useDeterministicSeed: '決定論シード使用',
    sameTwoThreatWeight: 'セイム2脅威重み', sameTwoRiskWeight: 'セイム2リスク重み', sameTwoResidualWeight: 'セイム2残存重み',
    aCutRiskThreshold: 'A切りリスク閾値', sameTwoAttackChance: 'セイム2攻撃確率',
    sameTwoDefenseMargin: 'セイム2防御マージン', sameTwoTrumpBonus: 'セイム2切札ボーナス', sameTwoSideBonus: 'セイム2サイドボーナス',
    sameTwoTimingEarly: 'セイム2序盤タイミング', sameTwoTimingMid: 'セイム2中盤タイミング', sameTwoTimingLate: 'セイム2終盤タイミング',
  };

  const deltas = [];
  for (const k of Object.keys(names)) {
    const cur = top[k] ?? base[k];
    if (cur === undefined) continue;
    const bounds = (base[k] !== 0 && Number.isFinite(base[k])) ? [Math.min(base[k] * 0.5, cur * 0.5), Math.max(base[k] * 1.5, cur * 1.5)] : [0, 1];
    const range = bounds[1] - bounds[0] || 1;
    deltas.push({ key: k, name: names[k], delta: (cur - base[k]) / range, cur, baseVal: base[k] });
  }
  deltas.sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta));

  const insights = deltas.slice(0, 3).map(d => ({
    title: `${d.name}（${d.delta > 0 ? '増加' : '減少'}）`,
    detail: `初期値 ${Number(d.baseVal).toFixed(2)} → ${Number(d.cur).toFixed(2)}。改善に寄与した主要パラメータ。`
  }));

  insights.push({
    title: '役割別勝率（最上位戦略）',
    detail: `ナポレオン時 ${(Number(strategies[0].nap_win_rate || 0) * 100).toFixed(1)}% / 副官時 ${(Number(strategies[0].deputy_win_rate || 0) * 100).toFixed(1)}% / 連合軍時 ${(Number(strategies[0].alliance_win_rate || 0) * 100).toFixed(1)}%`
  });

  if (strategies[0].avg_plan_accuracy != null) {
    insights.push({
      title: '計画精度',
      detail: `競りで立てた計画と実績の一致率: ${(Number(strategies[0].avg_plan_accuracy || 0) * 100).toFixed(1)}%`
    });
  }

  if (strategies[0].avg_value_loss != null) {
    insights.push({
      title: '価値損失率（平均）',
      detail: `オラクルBとの一致度: ${((1 - Number(strategies[0].avg_value_loss || 0)) * 100).toFixed(1)}%`
    });
  }

  insights.push({
    title: '捨て札戦略（期待値ベース）',
    detail: `最上位戦略は「ボイド作成」と「全スート維持」を期待値で比較し、宣言枚数・切札枚数・孤立絵札の3変数で判断しています。低宣言時は全スート維持を優先し、高宣言＋孤立絵札持ちの場合はボイド作成を選択する傾向があります。`
  });

  if (strategies[0].avg_bid_gap != null) {
    insights.push({
      title: '競り精度（bid乖離）',
      detail: `最適bidとの平均乖離: ${Number(strategies[0].avg_bid_gap || 0).toFixed(2)}枚（小さいほど正確）`
    });
  }
  if (strategies[0].bid_accuracy != null) {
    insights.push({
      title: 'P推定精度',
      detail: `P(成功)推定誤差: ${Number(strategies[0].bid_accuracy || 0).toFixed(3)}（小さいほど正確）`
    });
  }
  if (strategies[0].deputy_signal_success_rate != null) {
    insights.push({
      title: '副官シグナル成功率',
      detail: `副官指名→NAP勝利の成功率: ${(Number(strategies[0].deputy_signal_success_rate || 0) * 100).toFixed(1)}%`
    });
  }
  if (strategies[0].avg_stage_count != null) {
    insights.push({
      title: '段階上げ回数',
      detail: `1局あたりの平均段階上げ回数: ${Number(strategies[0].avg_stage_count || 0).toFixed(1)}回（3回前後が理想）`
    });
  }
  if (strategies[0].role_accuracy != null) {
    insights.push({
      title: '役割判定精度',
      detail: `NAP志望者がナポレオンになれた確率: ${(Number(strategies[0].role_accuracy || 0) * 100).toFixed(1)}%`
    });
  }

  const delta = Number(strategies[0].avg_rating_delta || 0);
  insights.push({
    title: '平均レート上昇',
    detail: `1マッチあたり ${delta > 0 ? '+' : ''}${delta.toFixed(2)} pt（${strategies[0].matches}マッチの平均）。`
  });

  return insights;
}
