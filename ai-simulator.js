import { SUITS, RANKS, CALIBRATION, shuffledDeck, sortHand, defaultStrategy, mutateStrategy } from './constants.js';
import { shouldBid, chooseDiscard, chooseDeputyCall, chooseCardToPlay, chooseDeputyCard, winningEntry } from './ai-tactics.js';

function simRound(hands, round, matchScores, params) {
  const d = shuffledDeck();
  for (let i = 0; i < 5; i++) { hands[i] = d.splice(0, 10); sortHand(hands[i]); }
  const kitty = d.splice(0, 2);

  let high = { num: 12, suit: '', player: -1 };
  for (let r = 0; r < 2; r++) {
    for (let s = 0; s < 5; s++) {
      const bid = shouldBid(hands[s], high, 13, params[s]);
      if (bid && bid.num > high.num) high = { ...bid, player: s };
    }
  }
  if (high.player < 0) high = { num: 13, suit: SUITS[0], player: matchScores.indexOf(Math.min(...matchScores)) };

  const nap = high.player, trump = high.suit, num = high.num;
  const contractBase = { nap, suit: trump, solo: false, deputy: -1 }; // 基本契約
  hands[nap].push(...kitty); sortHand(hands[nap]);
  const discard = chooseDiscard(hands[nap], trump);
  hands[nap] = hands[nap].filter(c => !discard.some(x => x.id === c.id));
  const kittyPts = discard.filter(c => ['10', 'J', 'Q', 'K', 'A'].includes(c.rank)).length;
  
  const call = chooseDeputyCall(hands[nap], discard, trump, 3, num);
  let deputy = -1;
  for (let i = 0; i < 5; i++) { if (i !== nap && hands[i].some(c => c.id === call.id)) { deputy = i; break; } }
  const solo = deputy < 0;
  if (solo) deputy = nap;
  contractBase.deputy = deputy;
  contractBase.solo = solo;

  const roundPts = [0, 0, 0, 0, 0];
  roundPts[nap] += kittyPts;
  const played = [], voids = [{}, {}, {}, {}, {}];
  let revealed = solo, active = nap, trickNo = 0;

  while (trickNo < 10 && hands.some(h => h.length > 0)) {
    const trick = [];
    for (let i = 0; i < 5; i++) {
      const seat = (active + i) % 5, hand = hands[seat];
      if (!hand.length) break;
      const legal = trick.length === 0 ? hand : hand.filter(c => c.suit === trick[0].card.suit).length ? hand.filter(c => c.suit === trick[0].card.suit) : hand;
      
      const currentWinner = trick.length ? winningEntry(contractBase, trickNo, trick) : null;
      const isCurrentNapWinning = currentWinner ? (currentWinner.seat === nap || (!solo && currentWinner.seat === deputy)) : false;

      const ctx = {
        hand, legal, trick, trickNo, contract: contractBase,
        playedCards: played, voids, seat, deputy, params: params[seat],
        isMySideNap: seat === nap || (revealed && seat === deputy),
        isCurrentNapWinning,
        isRevealed: revealed,
        isNapLeading: trick.length > 0 && trick[0].seat === nap,
        lastSeat: trick.length === 4
      };

      let chosen;
      if (!solo && revealed && seat === deputy) chosen = chooseDeputyCard(ctx);
      else chosen = chooseCardToPlay(ctx);

      if (trick.length && chosen.suit !== trick[0].card.suit) {
        if (!voids[seat]) voids[seat] = {};
        voids[seat][trick[0].card.suit] = true;
      }
      played.push({ suit: chosen.suit, rank: chosen.rank, id: chosen.id });
      if (!revealed && chosen.id === call.id) revealed = true;
      trick.push({ seat, card: chosen });
      hands[seat] = hand.filter(c => c.id !== chosen.id);
    }
    if (trick.length < 5) break;
    const w = winningEntry(contractBase, trickNo, trick);
    const taken = trick.filter(e => ['10', 'J', 'Q', 'K', 'A'].includes(e.card.rank)).length;
    roundPts[w.seat] += taken;
    active = w.seat;
    trickNo++;
    const napPts = roundPts[nap] + (solo ? 0 : roundPts[deputy]);
    const allyPts = roundPts.reduce((n, p, i) => n + (i !== nap && (solo || i !== deputy) ? p : 0), 0);
    if (allyPts > 20 - num || (napPts >= num && (num === 20 || allyPts >= 1))) break;
  }

  const napPts = roundPts[nap] + (solo ? 0 : roundPts[deputy]);
  const made = napPts >= num && (num === 20 || napPts < 20);
  const unit = Math.max(0, num - 12) * (round >= 10 ? 2 : 1);
  const sign = made ? 1 : -1;
  const sc = [0, 0, 0, 0, 0];
  sc[nap] = sign * unit * (solo ? 4 : 2);
  if (solo) { for (let i = 0; i < 5; i++) if (i !== nap) sc[i] = -sign * unit; }
  else { sc[deputy] = sign * unit; for (let i = 0; i < 5; i++) if (i !== nap && i !== deputy) sc[i] = -sign * unit; }
  for (let i = 0; i < 5; i++) matchScores[i] += sc[i];

  return { nap, deputy, num, solo, made, points: napPts, takenPoints: roundPts };
}

export async function runSelfPlayBatch(env, matchCount = 1000) {
  let existing = [];
  try { const { results } = await env.DB.prepare("SELECT * FROM ai_strategy_log ORDER BY avg_rating_delta DESC LIMIT 5").all(); existing = results; } catch { }
  const baseline = existing.length ? existing.map(r => JSON.parse(r.params)) : [defaultStrategy()];
  const generation = existing.length ? Math.max(...existing.map(r => r.generation || 0)) + 1 : 1;
  
  const challengers = baseline.map(b => mutateStrategy(b, 0.2));
  while (challengers.length < 5) challengers.push(mutateStrategy(baseline[0] || defaultStrategy(), 0.15));
  const pool = [...baseline.slice(0, 3), ...challengers.slice(0, 5)];
  
  const stats = pool.map(() => ({ n: 0, totalRating: 0, wins: 0, napN: 0, napW: 0, depN: 0, depW: 0, alN: 0, alW: 0, bidSum: 0, bidN: 0 }));

  for (let i = 0; i < matchCount; i++) {
    const seatIdx = [], seatParams = [];
    for (let s = 0; s < 5; s++) { const idx = Math.floor(Math.random() * pool.length); seatIdx.push(idx); seatParams.push(pool[idx]); }
    
    const hands = [[], [], [], [], []];
    const matchScores = [0, 0, 0, 0, 0];
    const contracts = [];
    for (let r = 1; r <= 10; r++) contracts.push(simRound(hands, r, matchScores, seatParams));

    const max = Math.max(...matchScores);
    for (let s = 0; s < 5; s++) {
      const st = stats[seatIdx[s]];
      st.n++;
      const rank = 1 + matchScores.filter(x => x > matchScores[s]).length;
      st.totalRating += (rank === 1 ? 0.5 : rank === 5 ? -0.5 : 0);
      if (matchScores[s] === max) st.wins++;
      for (const c of contracts) {
        if (c.nap === s) { st.napN++; st.bidSum += c.num; st.bidN++; if (c.made) st.napW++; }
        else if (!c.solo && c.deputy === s) { st.depN++; if (c.made) st.depW++; }
        else { st.alN++; if (!c.made) st.alW++; }
      }
    }
  }

  const statements = [];
  const parentIds = existing.slice(0, 3).map(r => r.id);
  for (let i = 0; i < pool.length; i++) {
    const st = stats[i];
    if (!st.n) continue;
    const avgRating = st.totalRating / st.n;
    const napRate = st.napN ? st.napW / st.napN : 0;
    const depRate = st.depN ? st.depW / st.depN : 0;
    const alRate = st.alN ? st.alW / st.alN : 0;
    const overall = st.wins / st.n;
    const avgBid = st.bidN ? st.bidSum / st.bidN : 0;
    statements.push(env.DB.prepare("INSERT INTO ai_strategy_log(generation,params,nap_win_rate,deputy_win_rate,alliance_win_rate,overall_win_rate,avg_rating_delta,matches,avg_bid,parent_id) VALUES(?,?,?,?,?,?,?,?,?,?)").bind(generation, JSON.stringify(pool[i]), napRate, depRate, alRate, overall, avgRating, st.n, avgBid, parentIds[i] || null));
  }
  if (statements.length) await env.DB.batch(statements);

  try {
    const top = await env.DB.prepare("SELECT params FROM ai_strategy_log ORDER BY avg_rating_delta DESC, id DESC LIMIT 1").first();
    if (top) {
      await env.DB.prepare("INSERT INTO ai_weights(id,weights,games,updated_at) VALUES(1,?,1,CURRENT_TIMESTAMP) ON CONFLICT(id) DO UPDATE SET weights=excluded.weights, games=games+1, updated_at=CURRENT_TIMESTAMP").bind(JSON.stringify(JSON.parse(top.params))).run();
    }
  } catch (e) { console.error("failed to update ai_weights", e); }

  try { await env.DB.prepare("DELETE FROM ai_strategy_log WHERE id NOT IN (SELECT id FROM ai_strategy_log ORDER BY avg_rating_delta DESC, id DESC LIMIT 50)").run(); } catch { }
  return { generation, size: pool.length, matches: matchCount };
}

export function generateInsights(strategies) {
  if (!strategies.length) return [];
  const base = defaultStrategy();
  const top = { ...base, ...JSON.parse(strategies[0].params || '{}') };
  const names = { bidThreshold: '立ち強度', riskTolerance: 'リスク許容', leadAggression: 'リード積極性', followAggression: 'フォロー積極性', trumpBonus: '切り札評価', mightyBonus: 'マイティ評価', safeAceWeight: 'A温存', roleCardPreservation: '役札温存', deputyFeedBias: '副官の絵札回し' };
  const deltas = Object.entries(PARAM_BOUNDS).map(([k, [lo, hi]]) => { const cur = top[k] ?? base[k]; return { key: k, name: names[k] || k, delta: (cur - base[k]) / (hi - lo), cur, baseVal: base[k] }; }).sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta));
  const insights = deltas.slice(0, 3).map(d => ({ title: `${d.name}（${d.delta > 0 ? '増加' : '減少'}）`, detail: `初期値 ${d.baseVal.toFixed(2)} → ${d.cur.toFixed(2)}。改善に寄与した主要パラメータ。` }));
  insights.push({ title: '役割別勝率（最上位戦略）', detail: `ナポレオン時 ${(Number(strategies[0].nap_win_rate || 0) * 100).toFixed(1)}% / 副官時 ${(Number(strategies[0].deputy_win_rate || 0) * 100).toFixed(1)}% / 連合軍時 ${(Number(strategies[0].alliance_win_rate || 0) * 100).toFixed(1)}%` });
  insights.push({ title: '平均レート上昇', detail: `1局あたり +${Number(strategies[0].avg_rating_delta || 0).toFixed(2)} pt（${strategies[0].matches}試合の平均）。` });
  return insights;
}
