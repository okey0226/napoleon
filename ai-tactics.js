// ai-tactics.js (完全版 + 上がり宣言 + 競りEV精緻化 + 全強化項目反映)
// ===== [前半 開始] =====
import { SUITS, RANKS, SV, defaultStrategy, isSameColorSuit, FACE, sameColorSuitOf, playExperienceKey, rankTierOf, trickPhaseOf, pointsTierOf, experienceConfidence, blendWithExperience } from './constants.js';

// ==========================================
// 経験DB用: ハッシュと類似度
// ==========================================

export function getStateHash(ctx) {
  const role = ctx.seat === ctx.contract.nap ? 'N' : ((!ctx.contract.solo && ctx.contract.deputy === ctx.seat) ? 'D' : 'A');
  const rem = 10 - ctx.trickNo;
  const suit = ctx.contract.suit;
  const pointCards = ctx.hand.filter(c => FACE.includes(c.rank) && c.id !== '♠A' && !isRoleJ(c, ctx.contract)).map(c => c.id).sort().join(',');
  const nonPointCounts = SUITS.map(s => ctx.hand.filter(c => c.suit === s && !FACE.includes(c.rank)).length).join('');
  const roleFlags = (ctx.hand.some(c => c.id === '♠A') ? 'M' : '') +
                    (ctx.hand.some(c => isTrumpJ(c, ctx.contract)) ? 'T' : '') +
                    (ctx.hand.some(c => isSameColorJ(c, ctx.contract)) ? 'S' : '');
  const lead = ctx.trick.length ? ctx.trick[0].card.suit : '-';
  const ptsInTrick = ctx.trick.filter(e => FACE.includes(e.card.rank)).length;
  const winnerTeam = ctx.trick.length ? (isTeamNap(winningEntry(ctx.contract, ctx.trickNo, ctx.trick).seat, ctx.contract) ? 'M' : 'E') : '-';
  const legalCount = ctx.legal.length;
  return `${role}_${rem}_${suit}_${pointCards}_${nonPointCounts}_${roleFlags}_${lead}_${ptsInTrick}_${winnerTeam}_${legalCount}`;
}

export function getSimilarityDistance(hash1, hash2) {
  const p1 = hash1.split('_');
  const p2 = hash2.split('_');
  if (p1.length < 10 || p2.length < 10) return 999;
  let dist = 0;
  dist += Math.abs(Number(p1[1]) - Number(p2[1])) * 3.0;
  const p1Points = p1[3] ? p1[3].split(',').length : 0;
  const p2Points = p2[3] ? p2[3].split(',').length : 0;
  dist += Math.abs(p1Points - p2Points) * 2.0;
  const p1Counts = p1[4].split('').map(Number);
  const p2Counts = p2[4].split('').map(Number);
  dist += p1Counts.reduce((sum, c, i) => sum + Math.abs(c - p2Counts[i]), 0) * 0.5;
  dist += Math.abs(Number(p1[7]) - Number(p2[7])) * 1.5;
  if (p1[5] !== p2[5]) dist += 1.0;
  if (p1[6] !== p2[6]) dist += 0.5;
  return dist;
}

// ==========================================
// 基本ロジック（カードパワー等）
// ==========================================

export function isTrump(contract, c) { return contract.suit !== "NT" && c.suit === contract.suit; }
function isRoleJ(c, contract) { return c.rank === 'J' && (isTrumpJ(c, contract) || isSameColorJ(c, contract)); }
function isSameColorJ(c, contract) { return contract.suit !== 'NT' && c.rank === 'J' && c.suit !== contract.suit && isSameColorSuit(c.suit, contract.suit); }
function isTrumpJ(c, contract) { return contract.suit !== 'NT' && c.rank === 'J' && c.suit === contract.suit; }
function isTeamNap(seat, contract) { return seat === contract.nap || (!contract.solo && contract.revealedCall && seat === contract.deputy); }

export function cardPower(contract, trickNo, card, trick, strictAllSame = false) {
  const led = trick.length > 0 ? trick[0].card.suit : card.suit;
  const allSame = trick.every(x => x.card.suit === led);
  const sameTwoEligible = allSame && (!strictAllSame || trick.length >= 5);
  const mighty = trick.some(x => x.card.id === "♠A");
  if (mighty && card.id === "♥Q") return 10000;
  if (card.id === "♠A") return 9000;
  if (contract.suit !== "NT" && card.rank === "J" && card.suit === contract.suit) return 8000;
  if (contract.suit !== "NT" && card.rank === "J" && card.suit !== contract.suit && isSameColorSuit(card.suit, contract.suit)) return 7000;
  if (trickNo > 0 && sameTwoEligible && card.suit === led && card.rank === "2") return 6000;
  if (isTrump(contract, card)) return 5000 + RANKS.indexOf(card.rank);
  if (card.suit === led) return 3000 + RANKS.indexOf(card.rank);
  return 1000 + RANKS.indexOf(card.rank);
}

export function winningEntry(contract, trickNo, trick, strictAllSame = false) {
  if (!trick || !trick.length) return null;
  return trick.reduce((best, x) =>
    cardPower(contract, trickNo, x.card, trick, strictAllSame) > cardPower(contract, trickNo, best.card, trick, strictAllSame) ? x : best, trick[0]
  );
}

function suitValue(hand, suit) {
  const weight = { "10": 1, J: 1.8, Q: 2.6, K: 3.5, A: 4.7 };
  const cards = hand.filter(c => c.suit === suit);
  return cards.reduce((n, c) => n + (weight[c.rank] || 0), 0) + Math.max(0, cards.length - 3) * .75;
}

export function handStrength(hand) {
  if (!Array.isArray(hand) || !hand.length) return 0;
  const base = hand.reduce((n, c) => n + (RANKS.indexOf(c.rank) > 9 ? 1.25 : RANKS.indexOf(c.rank) > 7 ? 0.45 : 0) + (c.rank === "A" ? 0.35 : 0), 0);
  return base + Math.max(...SUITS.map(s => suitValue(hand, s))) * 0.3;
}

export function strongestSuit(hand, suits = SUITS) {
  return suits.slice().sort((a, b) => suitValue(hand, b) - suitValue(hand, a) || SV[b] - SV[a])[0];
}

export function colorStrength(hand, trump, params) {
  const base = handStrength(hand);
  const trumps = hand.filter(c => c.suit === trump);
  let trumpPenalty = trumps.length === 0 ? -5.0 : trumps.length === 1 ? -2.0 : 0;
  return base + trumpPenalty + trumps.length * 0.5 + (params?.trumpBonus || 0.6) * trumps.length * 0.2;
}

export function ntHandStrength(hand, params) {
  const lengths = SUITS.map(s => hand.filter(c => c.suit === s).length);
  const maxLen = Math.max(...lengths), minLen = Math.min(...lengths);
  let score = 0;
  for (const suit of SUITS) {
    const cards = hand.filter(c => c.suit === suit);
    score += cards.length * 0.3;
    if (cards.some(c => c.rank === 'A')) score += (params?.ntAceWeight ?? 1.5);
    if (cards.some(c => c.rank === 'K')) score += 1.0;
    if (cards.some(c => c.rank === 'Q')) score += 0.6;
    if (cards.length >= 4) score += (params?.ntSuitLengthBonus ?? 1.2) * (cards.length - 3) * 0.5;
    if (cards.some(c => c.rank === 'A') && !cards.some(c => c.rank === '2')) {
      const len = cards.length;
      score -= len >= 3 ? 0.5 : len >= 2 ? 0.3 : 0.15;
    }
  }
  if (minLen === 0) score -= 2.5; else if (minLen === 1) score -= 1.0;
  if (maxLen >= 6) score -= 1.5; else if (maxLen >= 5 && minLen <= 2) score -= 0.5;
  if (maxLen <= 4 && minLen >= 2) score += 1.0;
  if (hand.some(c => c.id === '♠A')) score += (params?.ntMightyBonus ?? 2.5);
  return score;
}

export function soloAdjustedStrength(hand, trump) {
  const base = handStrength(hand);
  const trumps = hand.filter(c => c.suit === trump);
  let trumpPenalty = trumps.length === 0 ? -5.0 : trumps.length === 1 ? -2.0 : 0;
  const hasMighty = hand.some(c => c.id === '♠A');
  const hasTrumpJ = trump !== 'NT' && hand.some(c => c.rank === 'J' && c.suit === trump);
  return base + trumpPenalty + trumps.length * 0.5 + (hasMighty ? 1.5 : 0) + (hasTrumpJ ? 1.0 : 0);
}

// ==========================================
// ★ S1: ベイズ手札推定 + B9: アンサンブル + B11: 入札速度
// ==========================================

// 各席のアーキタイプを推定（アンサンブル用）
function getSeatArchetype(seat, bidHistory, params) {
  const theirBids = (bidHistory || []).filter(b => b.seat === seat && b.num >= 13);
  if (theirBids.length === 0) return 'unknown';
  const maxBid = Math.max(...theirBids.map(b => b.num));
  const suits = new Set(theirBids.map(b => b.suit));
  // 高額bidで多スート → 攻撃型
  if (maxBid >= 16 && suits.size >= 2) return 'aggressive';
  // 低額で単一スート → 守備型
  if (maxBid <= 14 && suits.size === 1) return 'conservative';
  return 'balanced';
}

// ベイズ更新: プレイ履歴から各席×スートの尤度を強化
function computeBayesianSuitLikelihood(mySeat, bidHistory, playedCards, voids, params) {
  const likelihood = [{}, {}, {}, {}, {}];
  
  // bid履歴からの尤度
  if (bidHistory) {
    bidHistory.forEach(b => {
      if (b.seat !== mySeat && b.suit !== 'NT') {
        likelihood[b.seat][b.suit] = (likelihood[b.seat][b.suit] || 0) + (b.num - 12) * (params?.bayesBidWeight ?? 1.0);
      }
    });
  }
  
  // プレイ履歴からのベイズ更新
  for (const pc of (playedCards || [])) {
    if (pc.seat === mySeat) continue;
    const seat = pc.seat;
    // フォローしたスートは既に1枚使った → 持っている枚数の期待値を下げる
    likelihood[seat][pc.suit] = (likelihood[seat][pc.suit] || 0) - (params?.bayesFollowWeight ?? 0.5) * 0.3;
  }
  
  // ボイド（持っていないことが確定）→ -Infinity
  for (let s = 0; s < 5; s++) {
    if (s === mySeat) continue;
    for (const suit of SUITS) {
      if (voids?.[s]?.[suit]) likelihood[s][suit] = -Infinity;
    }
  }
  
  return likelihood;
}

// 入札速度ボーナス（bidHistoryにbidAtがある場合のみ有効）
function computeBidSpeedBonus(seat, bidHistory, params) {
  if (!bidHistory) return 0;
  let bonus = 0;
  bidHistory.forEach(b => {
    if (b.seat === seat && b.suit !== 'NT' && b.bidAt && b.roundStartAt) {
      const speed = b.bidAt - b.roundStartAt;
      if (speed < (params?.bidSpeedFastThreshold ?? 500)) bonus += (params?.bidSpeedBonusFast ?? 0.2);
      else if (speed > (params?.bidSpeedSlowThreshold ?? 3000)) bonus += (params?.bidSpeedBonusSlow ?? -0.1);
    }
  });
  return bonus;
}

function sampleOpponentHands(myHand, bidHistory, mySeat, openKitty, playedCards = [], voids = [{},{},{},{},{}], params = {}) {
  const used = new Set(myHand.map(c => c.id));
  (openKitty || []).forEach(c => used.add(c.id));
  (playedCards || []).forEach(c => used.add(c.id));
  const remaining = [];
  for (const s of SUITS) for (const r of RANKS) {
    const id = s + r;
    if (!used.has(id)) remaining.push({ suit: s, rank: r, id });
  }
  const otherSeats = [0, 1, 2, 3, 4].filter(s => s !== mySeat);
  
  // ベイズ尤度テーブル + 入札速度 + アーキタイプ
  const suitLikelihood = computeBayesianSuitLikelihood(mySeat, bidHistory, playedCards, voids, params);
  const usedCardLikelihood = [{}, {}, {}, {}, {}];  // 使ったカードは持っていない確定
  for (const pc of (playedCards || [])) {
    if (pc.seat === mySeat) continue;
    usedCardLikelihood[pc.seat][pc.id] = -Infinity;
  }
  
  // アンサンブル: 各席がランダム型になる確率
  const archetypes = otherSeats.map(s => ({
    seat: s,
    archetype: getSeatArchetype(s, bidHistory, params),
    speedBonus: computeBidSpeedBonus(s, bidHistory, params),
    isRandom: Math.random() < (params?.opponentArchetypeMix ?? 0.3)
  }));
  const archetypeMap = {};
  archetypes.forEach(a => archetypeMap[a.seat] = a);
  
  const handCounts = otherSeats.map(s => Math.max(0, 10 - (playedCards || []).filter(c => c.seat === s).length));
  const others = otherSeats.map(() => []);
  const pool = remaining.slice();
  
  for (let round = 0; round < 10 && pool.length > 0; round++) {
    for (let i = 0; i < otherSeats.length && pool.length > 0; i++) {
      if (others[i].length >= handCounts[i]) continue;
      const seat = otherSeats[i];
      const info = archetypeMap[seat];
      let bestIdx = -1, bestScore = -Infinity;
      for (let k = 0; k < pool.length; k++) {
        const c = pool[k];
        if (usedCardLikelihood[seat][c.id] === -Infinity) continue;
        const like = suitLikelihood[seat][c.suit] || 0;
        if (like === -Infinity) continue;
        let score;
        if (info.isRandom) {
          // アンサンブル: ランダム型は一様分布
          score = Math.random();
        } else if (info.archetype === 'aggressive') {
          // 攻撃型: 高ランクに強く反応
          score = like + RANKS.indexOf(c.rank) * 0.3 + Math.random() * 0.6;
        } else if (info.archetype === 'conservative') {
          // 守備型: 宣言スートのみ強く反応
          const isDeclaredSuit = bidHistory?.some(b => b.seat === seat && b.suit === c.suit);
          score = (isDeclaredSuit ? like * 1.5 : like * 0.5) + Math.random() * 0.6;
        } else {
          score = like + Math.random() * 0.6;
        }
        score += info.speedBonus;
        if (score > bestScore) { bestScore = score; bestIdx = k; }
      }
      if (bestIdx < 0) bestIdx = Math.floor(Math.random() * pool.length);
      others[i].push(pool.splice(bestIdx, 1)[0]);
    }
  }
  while (pool.length > 0) {
    let assigned = false;
    for (let i = 0; i < otherSeats.length && pool.length > 0; i++) {
      if (others[i].length < handCounts[i]) { others[i].push(pool.shift()); assigned = true; }
    }
    if (!assigned) pool.shift();
  }
  return others;
}

// ==========================================
// 競り判断：PIMC
// ==========================================

function computeMECESuitWins(hand, playedCards, suit, trump, voids, seat) {
  const myCards = hand.filter(c => c.suit === suit).sort((a, b) => RANKS.indexOf(b.rank) - RANKS.indexOf(a.rank));
  if (!myCards.length) return 0;
  const playedRanks = new Set(playedCards.filter(c => c.suit === suit).map(c => c.rank));
  const unseenRanks = RANKS.filter(r => !playedRanks.has(r) && !myCards.some(c => c.rank === r)).sort((a, b) => RANKS.indexOf(b) - RANKS.indexOf(a));
  let wins = 0;
  for (let i = 0; i < myCards.length; i++) {
    const myCard = myCards[i];
    const opponentCard = unseenRanks[i];
    if (!opponentCard) wins++;
    else if (RANKS.indexOf(myCard.rank) > RANKS.indexOf(opponentCard)) wins++;
    else { if (trump !== 'NT' && voids[seat]?.[suit]) { if (Math.random() < 0.3) continue; } }
  }
  const myTwo = myCards.find(c => c.rank === '2');
  if (myTwo) {
    const playedInSuit = playedCards.filter(c => c.suit === suit).length;
    const voidCount = [0,1,2,3,4].filter(s => s !== seat && voids[s]?.[suit]).length;
    if (playedInSuit >= 4 && voidCount === 0) wins++;
    else if (playedInSuit >= 4 && trump === 'NT') wins++;
  }
  return wins;
}

function computeSurePoints(hand, trump, openKitty, playedCards = [], voids = [{},{},{},{},{}], seat = 0) {
  let sure = 0;
  const hasMighty = hand.some(c => c.id === '♠A');
  const trumpJ = trump !== 'NT' ? hand.find(c => c.rank === 'J' && c.suit === trump) : null;
  const sameColorJ = trump !== 'NT' ? hand.find(c => c.rank === 'J' && c.suit !== trump && isSameColorSuit(c.suit, trump)) : null;
  if (hasMighty) sure += 1;
  if (trumpJ) sure += 1;
  else if (sameColorJ) sure += 0.6;
  for (const suit of SUITS) {
    if (suit === trump) continue;
    sure += computeMECESuitWins(hand, playedCards, suit, trump, voids, seat);
  }
  if (trump !== 'NT') sure += computeMECESuitWins(hand, playedCards, trump, trump, voids, seat);
  return sure;
}

function smartRolloutPlay(seat, mySeat, allySeat, hand, trick, trump, trickNo) {
  const led = trick.length ? trick[0].card.suit : null;
  let legal = !led ? hand : (hand.some(c => c.suit === led) ? hand.filter(c => c.suit === led) : hand);
  if (!legal.length) return null;
  if (trick.some(e => e.card.id === '♥Q')) {
    const safeLegal = legal.filter(c => c.id !== '♠A');
    if (safeLegal.length > 0) legal = safeLegal;
  }
  const contract = { suit: trump };
  const isMyTeam = seat === mySeat || seat === allySeat;
  const currentWinner = trick.length ? winningEntry(contract, trickNo, trick) : null;
  const isMyTeamWinning = currentWinner && (currentWinner.seat === mySeat || currentWinner.seat === allySeat);
  const powerOf = (card) => cardPower(contract, trickNo, card, [...trick, { seat, card }]);
  if (trick.length === 0) return legal.reduce((best, c) => (powerOf(c) > powerOf(best) ? c : best), legal[0]);
  if (isMyTeam && isMyTeamWinning) {
    const mediumFaces = legal.filter(c => { if (isRoleJ(c, contract)) return false; return ['10', 'J', 'Q'].includes(c.rank); });
    if (mediumFaces.length) return mediumFaces.reduce((best, c) => (powerOf(c) < powerOf(best) ? c : best), mediumFaces[0]);
    const otherCards = legal.filter(c => !['K', 'A'].includes(c.rank) && !isRoleJ(c, contract));
    if (otherCards.length) return otherCards.reduce((best, c) => (powerOf(c) < powerOf(best) ? c : best), otherCards[0]);
    return legal.reduce((best, c) => (powerOf(c) < powerOf(best) ? c : best), legal[0]);
  }
  const winningCards = legal.filter(c => { const testTrick = [...trick, { seat, card: c }]; return winningEntry(contract, trickNo, testTrick).seat === seat; });
  if (winningCards.length) return winningCards.reduce((best, c) => (powerOf(c) < powerOf(best) ? c : best), winningCards[0]);
  return legal.reduce((best, c) => (powerOf(c) < powerOf(best) ? c : best), legal[0]);
}

function determineVirtualAlly(myHand, bidHistory, mySeat, contract) {
  const missingStrong = ['♠A', '♠J', '♥J', '♦J', '♣J'].filter(id => !myHand.some(c => c.id === id));
  if (missingStrong.length === 0) return mySeat;
  const otherSeats = [0,1,2,3,4].filter(s => s !== mySeat);
  let bestAlly = otherSeats[Math.floor(Math.random() * otherSeats.length)];
  if (bidHistory) {
    // ★ 副官動的推定強化: 指名札スートにbidした人を優先
    const callSuit = contract?.call?.suit;
    const suitBids = {};
    bidHistory.forEach(b => {
      if (b.seat === mySeat || b.suit === 'NT') return;
      let weight = b.num - 12;
      if (callSuit && b.suit === callSuit) weight += 3.0;
      suitBids[b.seat] = (suitBids[b.seat] || 0) + weight;
    });
    let maxBid = 0;
    for (const s of otherSeats) { if (suitBids[s] && suitBids[s] > maxBid) { maxBid = suitBids[s]; bestAlly = s; } }
  }
  return bestAlly;
}

// ============================================================
// ★ 修正: estimateWinningPointsPIMC（ロールアウトを本番AIに完全一致）
// bidRolloutRealPolicyRate: 1.0, bidRealPolicyMaxTrick: 10 で全トリックを実AIで実行
// bidMaxSamples: 50 で計算コスト抑制
// ============================================================
function estimateWinningPointsPIMC(hand, trump, params, bidHistory, mySeat, openKitty, timeBudgetMs, playedCards, voids, seat, contract) {
  const startTime = Date.now();
  let samples = 0;
  const maxSamples = params?.bidMaxSamples ?? 50;
  const realPolicyRate = params?.bidRolloutRealPolicyRate ?? 1.0;
  const realPolicyMaxTrick = params?.bidRealPolicyMaxTrick ?? 10;
  const loseStats = Array.from({ length: 11 }, () => ({ count: 0, totalEnemyPts: 0 }));
  const winStats = Array.from({ length: 11 }, () => ({ count: 0, totalMyPts: 0 }));
  const mySamplePoints = [];
  let totalMyPts = 0;
  while (samples < maxSamples && Date.now() - startTime < timeBudgetMs) {
    const allySeat = determineVirtualAlly(hand, bidHistory, mySeat, contract);
    const others = sampleOpponentHands(hand, bidHistory, mySeat, openKitty, playedCards, voids, params);
    const hands = [[], [], [], [], []];
    hands[mySeat] = hand.map(c => ({ ...c }));
    let oIdx = 0;
    for (let s = 0; s < 5; s++) { if (s === mySeat) continue; hands[s] = others[oIdx++].map(c => ({ ...c })); }
    let enemyPoints = 0, enemyTricks = 0, teamTricks = 0, teamPoints = 0;
    let active = mySeat;
    const simPoints = [0, 0, 0, 0, 0];
    const trickCount = hand.length;
    for (let t = 0; t < trickCount; t++) {
      if (!hands[mySeat].length) break;
      const trick = [];
      for (let i = 0; i < 5; i++) {
        const seat2 = (active + i) % 5;
        const seatHand = hands[seat2];
        if (!seatHand.length) break;
        let chosen = null;
        if (t < realPolicyMaxTrick && Math.random() < realPolicyRate) {
          try {
            const led = trick.length ? trick[0].card.suit : null;
            const legal = !led ? seatHand : (seatHand.some(c => c.suit === led) ? seatHand.filter(c => c.suit === led) : seatHand);
            const ctx = {
              seat: seat2,
              contract: { suit: trump, nap: mySeat, solo: false, deputy: allySeat, revealedCall: true, call: null },
              legal, hand: seatHand, trick, trickNo: t,
              playedCards, voids, params,
              isCurrentNapWinning: false, isRevealed: true,
              lastSeat: trick.length === 4,
              points: simPoints.slice(),
              allianceKittyPoints: 0
            };
            chosen = chooseCardToPlay(ctx);
          } catch (e) { /* フォールバック */ }
        }
        if (!chosen) chosen = smartRolloutPlay(seat2, mySeat, allySeat, seatHand, trick, trump, t);
        if (!chosen) break;
        trick.push({ seat: seat2, card: chosen });
        hands[seat2] = seatHand.filter(c => c.id !== chosen.id);
      }
      if (trick.length < 5) break;
      const winner = winningEntry({ suit: trump }, t, trick);
      const pts = trick.filter(e => ['10', 'J', 'Q', 'K', 'A'].includes(e.card.rank)).length;
      simPoints[winner.seat] += pts;
      if (winner.seat !== mySeat && winner.seat !== allySeat) { enemyTricks++; enemyPoints += pts; }
      else { teamTricks++; teamPoints += pts; }
      active = winner.seat;
    }
    loseStats[enemyTricks].count++;
    loseStats[enemyTricks].totalEnemyPts += enemyPoints;
    winStats[teamTricks].count++;
    winStats[teamTricks].totalMyPts += teamPoints;
    mySamplePoints.push(teamPoints);
    totalMyPts += teamPoints;
    samples++;
  }
  const lossTable = params.lossPointMap || [0, 2, 4, 5, 7, 9, 11, 13, 15, 17, 20];
  const winTable = params.winPointMap || [0, 2, 4, 6, 8, 10, 12, 14, 16, 18, 20];
  let totalExpectedEnemyPts = 0;
  loseStats.forEach((st, tricks) => {
    if (st.count === 0) return;
    const prob = st.count / samples;
    const mappedLoss = lossTable[tricks] ?? (st.totalEnemyPts / st.count);
    totalExpectedEnemyPts += mappedLoss * prob;
  });
  const expectedFromEnemy = Math.max(0, 20 - totalExpectedEnemyPts);
  let totalExpectedMyPts = 0;
  winStats.forEach((st, tricks) => {
    if (st.count === 0) return;
    const prob = st.count / samples;
    const mappedWin = winTable[tricks] ?? (st.totalMyPts / st.count);
    totalExpectedMyPts += mappedWin * prob;
  });
  const expectedPoints = Math.max(expectedFromEnemy, totalExpectedMyPts);
  const sortedPts = mySamplePoints.slice().sort((a, b) => a - b);
  const cutoff = Math.max(1, Math.floor(samples * 0.1));
  const cvar10 = sortedPts.slice(0, cutoff).reduce((s, v) => s + v, 0) / cutoff;
  const mean = totalMyPts / Math.max(1, samples);
  const variance = mySamplePoints.reduce((s, v) => s + (v - mean) ** 2, 0) / Math.max(1, samples);
  const std = Math.sqrt(variance);
  const pMake = {};
  for (let n = 13; n <= 20; n++) {
    const wins = mySamplePoints.filter(p => n === 20 ? p >= 20 : (p >= n && p < 20)).length;
    pMake[n] = wins / Math.max(1, samples);
  }
  return { expectedPoints, cvar10, mean, std, pMake, loseDetails: loseStats.map((st, tricks) => ({ tricks, prob: st.count / samples, avgPts: st.count ? st.totalEnemyPts / st.count : 0 })), winDetails: winStats.map((st, tricks) => ({ tricks, prob: st.count / samples, avgPts: st.count ? st.totalMyPts / st.count : 0 })), samples };
}

// ============================================================
// ★ 修正: evaluateBidPlan（mean直接使用 + playQualityFactor補正 + 経験DB実質化）
// ============================================================
export function evaluateBidPlan(hand, trump, params, bidHistory, mySeat, openKitty, playedCards = [], voids = [{},{},{},{},{}], contract = null) {
  const sure = computeSurePoints(hand, trump, openKitty, playedCards, voids, mySeat);
  const timeBudget = params?.bidTimeBudgetMs ?? 400;
  const pimcResult = estimateWinningPointsPIMC(hand, trump, params, bidHistory, mySeat, openKitty, timeBudget, playedCards, voids, mySeat, contract);

  // ★ プレイ品質補正係数（サンプル10以上でのみ有効）
  const pqFactor = (params?.playQualitySamples >= 10) ? (params?.playQualityFactor ?? 1.0) : 1.0;
  
  // ★ 経験DB実質化: 同じ局面ハッシュの経験があれば blend
  let experienceAdjust = 1.0;
  if (contract && params?.experienceBlendWeight > 0) {
    const hash = getStateHash({ hand, trick: [], trickNo: 0, contract, playedCards, voids, seat: mySeat, legal: hand });
    const expMap = params?.experienceMap?.[hash];
    if (expMap && expMap.samples >= (params?.experienceMinSamples ?? 3)) {
      const expRate = expMap.wins / expMap.samples;
      experienceAdjust = 1.0 + (expRate - 0.5) * params.experienceBlendWeight;
    }
  }
  
  const adjustedPMake = {};
  for (let n = 13; n <= 20; n++) {
    adjustedPMake[n] = Math.min(0.99, Math.max(0.01, (pimcResult.pMake[n] || 0) * pqFactor * experienceAdjust));
  }
  const baseExpected = pimcResult.mean * Math.min(1.0, pqFactor) * Math.min(1.0, experienceAdjust);

  let bestBidByExpectation = 13;
  let bestAdjustedE = -Infinity;
  const bidExpectations = {};
  for (let n = 13; n <= 20; n++) {
    const p = adjustedPMake[n];
    const E = (2 * p - 1) * (n - 12);
    const riskPenalty = 0.1 * Math.sqrt(Math.max(0, p * (1 - p))) * (n - 12);
    const adjE = E - riskPenalty;
    bidExpectations[n] = { p, E, adjE };
    if (adjE > bestAdjustedE) { bestAdjustedE = adjE; bestBidByExpectation = n; }
  }
  const suitRunValues = [];
  for (const suit of SUITS) {
    if (suit === trump) continue;
    const myCards = hand.filter(c => c.suit === suit).sort((a, b) => RANKS.indexOf(b.rank) - RANKS.indexOf(a.rank));
    if (myCards.length < 3) continue;
    let consecutive = 0;
    for (let i = 0; i < myCards.length; i++) {
      const expectedRank = RANKS[RANKS.length - 1 - i];
      if (myCards[i].rank === expectedRank) consecutive++;
      else break;
    }
    const runValue = consecutive >= 3 ? consecutive * 0.8 : consecutive * 0.4;
    suitRunValues.push({ suit, consecutive, runValue, cardCount: myCards.length });
  }
  suitRunValues.sort((a, b) => b.runValue - a.runValue);
  const runSuits = suitRunValues.filter(x => x.consecutive >= 3).map(x => x.suit);
  const preserveSuits = suitRunValues.filter(x => x.consecutive < 3).map(x => x.suit);
  return {
    trump,
    expectedWins: baseExpected,
    baseExpected,
    sureWins: sure,
    runSuits, preserveSuits, suitRunValues,
    pimcDetail: pimcResult,
    pMake: adjustedPMake,
    rawPMake: pimcResult.pMake,
    bidExpectations,
    bestBidByExpectation,
    bestAdjustedE,
    playQualityFactor: pqFactor,
    experienceAdjust
  };
}

// ==========================================
// 競り判断：MECEな手札分類
// ==========================================

export function getRoleCards(hand, trump) {
  const mighty = hand.some(c => c.id === '♠A');
  const trumpJ = trump !== 'NT' ? hand.some(c => c.rank === 'J' && c.suit === trump) : false;
  const sameColorJ = trump !== 'NT' ? hand.some(c => c.rank === 'J' && c.suit !== trump && isSameColorSuit(c.suit, trump)) : false;
  const count = (mighty ? 1 : 0) + (trumpJ ? 1 : 0) + (sameColorJ ? 1 : 0);
  return { mighty, trumpJ, sameColorJ, count };
}

export function isTwoRole(hand, trump) { return getRoleCards(hand, trump).count >= 2; }
export function isThreeRole(hand, trump) { return getRoleCards(hand, trump).count >= 3; }

export function canSendS1(hand, trump, params) {
  if (trump === 'NT') return false;
  const sameColorSuit = sameColorSuitOf(trump);
  const hasSameColorJ = hand.some(c => c.rank === 'J' && c.suit === sameColorSuit);
  if (!hasSameColorJ) return false;
  const minorCards = hand.filter(c => c.rank === 'A' || c.rank === '2').length;
  return minorCards >= (params?.s1RequiredMinorCards ?? 2);
}

export function canSendS3(hand, params) {
  const nonMightyAces = hand.filter(c => c.rank === 'A' && c.id !== '♠A').length;
  return nonMightyAces >= (params?.s3RequiredAces ?? 2);
}

export function evaluateRiskTransfer(hand, currentHigh, params, matchScores) {
  if (!currentHigh || currentHigh.num !== 17) return { canTransfer: false, targetBid: 0 };
  if (!currentHigh.suit || currentHigh.suit === 'NT') return { canTransfer: false, targetBid: 0 };
  const sameColorSuit = sameColorSuitOf(currentHigh.suit);
  const hasSameColorRole = hand.some(c => c.suit === sameColorSuit && (c.rank === 'J' || c.rank === 'A'));
  if (!hasSameColorRole) return { canTransfer: false, targetBid: 0 };
  return { canTransfer: true, targetBid: 20 };
}

export function bidPacing(pacingMs, elapsed) {
  return Math.max(0, (pacingMs || 4000) - (elapsed || 0));
}

export function countSameColorBidders(bidSignals, bidHistory, trumpSuit) {
  if (!trumpSuit || trumpSuit === 'NT') return 0;
  const sameColor = sameColorSuitOf(trumpSuit);
  const colorSuits = new Set([trumpSuit, sameColor]);
  const bidders = new Set();
  (bidHistory || []).forEach(b => {
    if (colorSuits.has(b.suit)) bidders.add(b.seat);
  });
  return bidders.size;
}

export function detectPartnerSignal(bidSignals, bidHistory, currentHigh, mySeat) {
  if (!currentHigh || currentHigh.num < 13 || currentHigh.player === mySeat) return null;
  const received = bidSignals?.received || [];
  if (!received.length) return null;
  return received[received.length - 1];
}

export function classifyHandArchetype(hand, trump, params) {
  const trumps = hand.filter(c => c.suit === trump);
  const sideAces = hand.filter(c => c.suit !== trump && c.rank === 'A' && c.id !== '♠A');
  const roles = getRoleCards(hand, trump);
  const hasHighTrump = trumps.some(c => ['A', 'K', 'J'].includes(c.rank));
  const runSuits = [];
  for (const suit of SUITS) {
    if (suit === trump) continue;
    const myCards = hand.filter(c => c.suit === suit).sort((a, b) => RANKS.indexOf(b.rank) - RANKS.indexOf(a.rank));
    if (myCards.length < 3) continue;
    let consecutive = 0;
    for (let i = 0; i < myCards.length; i++) {
      if (myCards[i].rank === RANKS[RANKS.length - 1 - i]) consecutive++;
      else break;
    }
    if (consecutive >= 3) runSuits.push(suit);
  }
  if (roles.count >= 3 || (roles.mighty && roles.trumpJ && sideAces.length >= 2)) return 'ROLE_OVERWHELM';
  if (trumps.length >= 6 || (trumps.length >= 5 && hasHighTrump)) return 'TRUMP_DOMINANT';
  if (sideAces.length >= 3 || (sideAces.length >= 2 && trumps.length >= 4)) return 'SIDE_ACE_HEAVY';
  if (runSuits.length > 0) return 'RUN_SUIT';
  if (trumps.length >= 3 || roles.count >= 1) return 'BALANCED';
  return 'WEAK';
}

export function evaluateDeputyValue(hand, trump, mySeat, bidSignals, bidHistory) {
  const candidates = [];
  const isIn = id => hand.some(c => c.id === id);
  if (!isIn('♠A')) candidates.push({ id: '♠A', suit: '♠', rank: 'A', type: 'MIGHTY' });
  if (trump !== 'NT' && !isIn(trump + 'J')) candidates.push({ id: trump + 'J', suit: trump, rank: 'J', type: 'TRUMP_J' });
  if (trump !== 'NT' && !isIn(sameColorSuitOf(trump) + 'J')) candidates.push({ id: sameColorSuitOf(trump) + 'J', suit: sameColorSuitOf(trump), rank: 'J', type: 'SAME_COLOR_J' });
  for (const suit of SUITS) {
    if (suit === trump) continue;
    if (!isIn(suit + 'A') && !(bidSignals || []).some(s => s.suit === suit && s.type === 'S1')) candidates.push({ id: suit + 'A', suit, rank: 'A', type: 'SIDE_ACE' });
  }
  for (const suit of SUITS) {
    if (suit === trump) continue;
    if (!isIn(suit + '2')) candidates.push({ id: suit + '2', suit, rank: '2', type: 'TWO' });
  }
  let best = { card: null, ev: -Infinity };
  for (const cand of candidates) {
    let ev = 0;
    for (let s = 0; s < 5; s++) {
      if (s === mySeat) continue;
      const pSeat = 1 / 4;
      const strength = 1.0;
      const posSynergy = (s === (mySeat + 4) % 5) ? 1.5 : 0;
      const feedComp = cand.suit === trump ? 1.2 : (hand.filter(c => c.suit === cand.suit).length >= 3 ? 1.0 : 0.5);
      ev += pSeat * (strength + posSynergy + feedComp);
    }
    if (ev > best.ev) best = { card: cand, ev };
  }
  return best;
}

export function analyzeBiddingContext(mySeat, matchScores, bidSignals, bidHistory, round) {
  let adjustment = 0;
  let forcePass = false;
  const myScore = matchScores ? matchScores[mySeat] : 0;
  const rank = matchScores ? matchScores.filter(s => s > myScore).length + 1 : 3;
  if (rank === 1) adjustment -= 1;
  if (rank >= 4 && round < 10) adjustment += 1;
  const received = bidSignals?.received || [];
  if (received.some(s => s.type === 'S2') || received.some(s => s.type === 'S4')) forcePass = true;
  return { adjustment, forcePass };
}

export function computeProperBid(hand, trump, params, mySeat, bidSignals, matchScores, openKitty, playedCards, voids, bidHistory, round = 1) {
  const archetype = classifyHandArchetype(hand, trump, params);
  if (archetype === 'WEAK') return { properBid: 0, archetype, plan: null };
  const plan = evaluateBidPlan(hand, trump, params, bidHistory, mySeat, openKitty, playedCards, voids);
  const deputy = evaluateDeputyValue(hand, trump, mySeat, bidSignals?.received || [], bidHistory);
  const context = analyzeBiddingContext(mySeat, matchScores, bidSignals, bidHistory, round);
  if (context.forcePass) return { properBid: 0, archetype, context, plan };
  const baseRanges = {
    ROLE_OVERWHELM: [17, 20],
    TRUMP_DOMINANT: [15, 19],
    SIDE_ACE_HEAVY: [14, 17],
    RUN_SUIT: [14, 16],
    BALANCED: [13, 15]
  };
  const [min, max] = baseRanges[archetype] || [13, 15];
  const expectedRatio = Math.min(1, Math.max(0, (plan.expectedWins - 13) / 7));
  let baseBid = min + Math.round((max - min) * expectedRatio);
  baseBid += Math.min(1, Math.floor(deputy.ev / 3));
  baseBid += context.adjustment;
  const properBid = Math.max(13, Math.min(20, baseBid));
  return { properBid, baseBid, archetype, plan, deputy, context, expected: properBid, pMake20: plan.pMake?.[20] ?? 0, roleCardCount: getRoleCards(hand, trump).count, signalBonus: 0, safetyMargin: params.tossUpSafetyMargin ?? 0.4 };
}

// ==========================================
// 選択関数
// ==========================================

export function shouldBid(hand, currentHigh, minBid, params, bidHistory = [], mySeat = 0, experience = null, matchScores = null, openKitty = null, playedCards = [], voids = [{},{},{},{},{}]) {
  if (!Array.isArray(hand) || !hand.length) return null;
  if (!params) params = defaultStrategy();
  const bidSignals = params.bidSignals || { sent: null, received: [], sameColorCount: 0, lastBidAt: 0 };
  const isFirstBid = (!currentHigh || currentHigh.num < 13);
  const currentHighNum = currentHigh?.num ?? 12;
  const baseStr = handStrength(hand);
  const firstBidThreshold = Math.max(2.3, (params.bidThreshold ?? 3.5) - 1.2);
  if (isFirstBid && baseStr < firstBidThreshold) return null;
  const suitScores = SUITS.map(suit => ({ suit, score: colorStrength(hand, suit, params) }));
  suitScores.sort((a, b) => b.score - a.score);
  const topSuits = suitScores.slice(0, 2).map(x => x.suit);
  const ntScore = ntHandStrength(hand, params);
  const currentRound = Math.max(0, ...(bidHistory || []).map(b => b?.round || 0));
  const currentBids = (bidHistory || []).filter(b => b && b.round === currentRound);
  const candidates = [];
  for (const suit of topSuits) {
    const proper = computeProperBid(hand, suit, params, mySeat, bidSignals, matchScores, openKitty, playedCards, voids, currentBids);
    const minViable = Math.max(minBid, currentHighNum + 1, 13);
    if (proper.properBid >= minViable) candidates.push({ suit, properBid: proper.properBid, expected: proper.expected, baseExpected: proper.baseExpected, plan: proper.plan, isOverwhelming: proper.isOverwhelming });
  }
  if (ntScore > 6) {
    const ntProper = computeProperBid(hand, 'NT', params, mySeat, bidSignals, matchScores, openKitty, playedCards, voids, currentBids);
    const minViable = Math.max(minBid, currentHighNum + 1, 13);
    if (ntProper.properBid >= minViable) candidates.push({ suit: 'NT', properBid: ntProper.properBid, expected: ntProper.expected, baseExpected: ntProper.baseExpected, plan: ntProper.plan, isOverwhelming: ntProper.isOverwhelming });
  }
  if (!candidates.length) {
    if (isFirstBid && baseStr >= firstBidThreshold) return { num: Math.max(minBid, 13), suit: topSuits[0], solo: false, plan: null };
    return null;
  }
  const overwhelming = candidates.find(c => c.isOverwhelming);
  if (overwhelming && currentHighNum < 20) return { num: 20, suit: overwhelming.suit, solo: false, plan: overwhelming.plan };
  candidates.sort((a, b) => b.expected - a.expected);
  const best = candidates[0];
  if (currentHighNum >= 13 && best.properBid <= currentHighNum) {
    if (currentHigh.suit !== best.suit && !isSameColorSuit(currentHigh.suit, best.suit)) return null;
    return { num: Math.min(20, currentHighNum + 1), suit: best.suit, solo: false, plan: best.plan };
  }
  const targetNum = Math.min(best.properBid, Math.max(minBid, currentHighNum + 1));
  return { num: targetNum, suit: best.suit, solo: false, plan: best.plan };
}

// ==========================================
// 捨て札戦略
// ==========================================

const FACE_RANKS = ['10', 'J', 'Q', 'K', 'A'];

function isIsolatedFaceCard(card, hand, trump) {
  if (!FACE_RANKS.includes(card.rank)) return false;
  if (trump !== 'NT' && card.suit === trump) return false;
  if (card.id === '♠A') return false;
  if (trump !== 'NT' && card.rank === 'J' && (card.suit === trump || isSameColorSuit(card.suit, trump))) return false;
  if (card.id === '♥Q' && hand.some(hc => hc.id === '♠A')) return false;
  const sameSuit = hand.filter(hc => hc.suit === card.suit);
  const hasAce = sameSuit.some(hc => hc.rank === 'A');
  const hasTwo = sameSuit.some(hc => hc.rank === '2');
  return !hasAce && !hasTwo && sameSuit.length <= 2;
}

export function evaluateVoidStrategy(voidSuitInfo, context, params = defaultStrategy()) {
  const { trump, num, hasMighty, isDeputyMighty } = context;
  const isNT = trump === 'NT';
  const p = params;
  const faceCount = voidSuitInfo.faceCount;
  const cost = faceCount * 1.0;
  let cutProb = 0;
  if (!isNT) {
    const myTrumps = context.hand.filter(c => c.suit === trump).length;
    cutProb = myTrumps >= 7 ? 0.98 : myTrumps >= 5 ? 0.95 : myTrumps >= 4 ? 0.9 : myTrumps >= 3 ? 0.8 : myTrumps >= 2 ? 0.6 : myTrumps >= 1 ? 0.3 : 0;
  }
  const leadProb = p.voidLeadProbability ?? 0.55;
  const cutValue = p.cutTrickValue ?? 2.0;
  let bidModifier = 0;
  if (num <= 14) bidModifier = -(p.lowBidVoidPenalty ?? 1.5);
  else if (num <= 16) bidModifier = -(p.midBidVoidPenalty ?? 0.5);
  else bidModifier = (p.highBidVoidBonus ?? 0.8);
  let mightyModifier = 0;
  if (isNT) {
    if (hasMighty && num >= 17) mightyModifier = (p.ntHighBidVoidBonus ?? 1.5);
    else if (hasMighty) mightyModifier = 0;
    else if (isDeputyMighty) mightyModifier = -(p.ntVoidPenalty ?? 3.0);
    else mightyModifier = -(p.ntVoidPenalty ?? 3.0) * 0.7;
  } else {
    if (hasMighty) mightyModifier = 0.3;
    else if (isDeputyMighty) mightyModifier = -0.5;
  }
  const isolatedBonus = (p.isolatedFaceDiscardBonus ?? 0.6) * (voidSuitInfo.isolatedFaces || 0);
  const trumpCount = isNT ? 0 : context.hand.filter(c => c.suit === trump).length;
  const trumpThreshold = p.trumpCountForVoid ?? 5;
  const trumpShortPenalty = (!isNT && trumpCount < trumpThreshold) ? (trumpThreshold - trumpCount) * 0.4 : 0;
  const benefit = leadProb * cutProb * cutValue;
  const ev = benefit + bidModifier + mightyModifier + isolatedBonus + trumpShortPenalty - cost;
  return { ev, benefit, cost, leadProb, cutProb, cutValue, bidModifier, mightyModifier, isolatedBonus, trumpShortPenalty, details: { suit: voidSuitInfo.suit, faceCount, isolatedFaces: voidSuitInfo.isolatedFaces || 0, trumpCount, num, hasMighty, isDeputyMighty, isNT } };
}

export function analyzeDiscardOptions(hand, trump, context = {}, params = defaultStrategy()) {
  if (!Array.isArray(hand) || hand.length <= 2) {
    return { bestOption: { type: 'all', cards: hand.slice(), ev: 0 }, options: [] };
  }
  const num = context.num ?? 14;
  const hasMighty = hand.some(c => c.id === '♠A');
  const isDeputyMighty = !hasMighty && context.deputyHasMighty !== false;
  const protectedCallId = context.protectedCallId || null;
  const suitInfo = {};
  for (const s of SUITS) {
    const cards = hand.filter(c => c.suit === s);
    const faces = cards.filter(c => FACE_RANKS.includes(c.rank));
    const isolatedFaces = faces.filter(c => isIsolatedFaceCard(c, hand, trump)).length;
    suitInfo[s] = { suit: s, cards, count: cards.length, faces, faceCount: faces.length, isolatedFaces };
  }
  const isProtected = (c) => {
    if (c.id === '♠A') return true;
    if (trump !== 'NT' && c.rank === 'J' && c.suit === trump) return true;
    if (trump !== 'NT' && c.rank === 'J' && isSameColorSuit(c.suit, trump)) return true;
    if (c.id === '♥Q' && hasMighty) return true;
    if (protectedCallId && c.id === protectedCallId) return true;
    return false;
  };
  const options = [];
  for (const s of SUITS) {
    const info = suitInfo[s];
    if (info.count !== 2) continue;
    if (info.cards.some(isProtected)) continue;
    if (trump !== 'NT' && s === trump) continue;
    if (info.faceCount === 0 && info.cards.every(c => RANKS.indexOf(c.rank) <= 3)) continue;
    const voidEval = evaluateVoidStrategy(info, { trump, num, hasMighty, isDeputyMighty, hand }, params);
    options.push({ type: 'void', cards: info.cards.slice(), suit: s, ev: voidEval.ev, analysis: voidEval });
  }
  const safeCandidates = hand.filter(c => !isProtected(c));
  if (safeCandidates.length >= 2) {
    const scoreCard = (c) => {
      let score = 0;
      if (trump !== 'NT' && c.suit === trump) score += 6000 + RANKS.indexOf(c.rank);
      else if (c.rank === 'A') score += 4000;
      else if (c.rank === 'K') score += 3500;
      else if (c.rank === 'Q') score += 3000;
      else if (c.rank === 'J') score += 2500;
      else if (c.rank === '2') score += 500;
      else score += RANKS.indexOf(c.rank) * 100;
      if (isIsolatedFaceCard(c, hand, trump)) score -= 1500;
      if (suitInfo[c.suit].count <= 2 && c.suit !== trump) score -= 500;
      return score;
    };
    const sorted = safeCandidates.slice().sort((a, b) => scoreCard(a) - scoreCard(b));
    const twoCards = sorted.slice(0, 2);
    const lostValue = twoCards.reduce((sum, c) => sum + scoreCard(c) / 3000, 0);
    const safetyBonus = 0.5;
    const safeEv = safetyBonus - lostValue * 0.3;
    options.push({ type: 'safe', cards: twoCards, ev: safeEv, analysis: { lostValue, safetyBonus, reason: '全スート維持（安定性重視）' } });
  }
  options.sort((a, b) => b.ev - a.ev);
  const bestOption = options[0] || { type: 'all', cards: hand.slice(0, 2), ev: 0 };
  return { bestOption, options, suitInfo };
}

export function chooseDiscard(hand, trump, context = {}) {
  if (!Array.isArray(hand) || hand.length <= 2) return hand.slice();
  const params = context.params || defaultStrategy();
  const { bestOption } = analyzeDiscardOptions(hand, trump, context, params);
  return bestOption.cards;
}

export function chooseSoloCall(hand, trump) {
  if (!Array.isArray(hand) || !hand.length) return null;
  const sorted = hand.slice().sort((a, b) => {
    const diff = RANKS.indexOf(a.rank) - RANKS.indexOf(b.rank);
    if (diff !== 0) return diff;
    return SV[a.suit] - SV[b.suit];
  });
  return { suit: sorted[0].suit, rank: sorted[0].rank, id: sorted[0].id };
}
// ===== [前半 終了] =====

// ai-tactics.js (完全版 + 上がり宣言 + 競りEV精緻化 + 全強化項目反映)
// ===== [後半 開始] =====
// ※ 前半（import〜chooseSoloCall まで）の直後に連結してください

// ==========================================
// プレイ関数群 (MECE構造 / NT・色分離)
// ==========================================

function isFace(c) { return FACE.includes(c.rank); }
function isOnNapSide(ctx) { return ctx.seat === ctx.contract.nap || (!ctx.contract.solo && ctx.contract.deputy === ctx.seat); }
function countVoidSeats(voids, suit, excludeSeat) { let count = 0; for (let s = 0; s < 5; s++) if (s !== excludeSeat && voids[s]?.[suit]) count++; return count; }

// ============================================================
// ★ S2: チーム協調シグナル
// プレイ中の暗黙シグナル（リード選択・フォロー選択）を解釈する
// ============================================================

// 他席が「副官の可能性が高いか」を推定
function estimateDeputyProbability(seat, contract, playedCards, ctx) {
  if (!contract || contract.solo) return 0;
  if (seat === contract.nap) return 0;
  if (contract.revealedCall && seat === contract.deputy) return 1.0;
  
  let p = 0;
  const callSuit = contract.call?.suit;
  const callRank = contract.call?.rank;
  
  // bid履歴で指名札スートを宣言していたら加点
  const history = ctx?.bidHistory || [];
  history.forEach(b => {
    if (b.seat === seat && callSuit && b.suit === callSuit && b.num >= 13) {
      p += (ctx?.params?.deputyBidSuitBonus ?? 0.3);
    }
  });
  
  // 指名札スートをリードしてきたら加点
  if (playedCards && callSuit) {
    const theirLeads = playedCards.filter(c => c.seat === seat && c.suit === callSuit);
    if (theirLeads.length > 0) p += (ctx?.params?.deputyCallSuitBonus ?? 0.5);
  }
  
  return Math.min(0.95, p);
}

// チームメイト（同じ軍）の集合を推定
function estimateTeammates(mySeat, contract, playedCards, ctx) {
  const teammates = new Set([mySeat]);
  if (contract.nap === mySeat) {
    // 私はNAP → 副官を推定
    const probs = [];
    for (let s = 0; s < 5; s++) {
      if (s === mySeat) continue;
      probs.push({ seat: s, p: estimateDeputyProbability(s, contract, playedCards, ctx) });
    }
    probs.sort((a, b) => b.p - a.p);
    if (probs[0] && probs[0].p > 0.5) teammates.add(probs[0].seat);
  } else if (!contract.solo && contract.revealedCall && contract.deputy === mySeat) {
    // 私は副官 → NAPを追加
    teammates.add(contract.nap);
  } else if (contract.revealedCall && !contract.solo) {
    // 私は連合軍 → 副官以外の連合軍を追加
    for (let s = 0; s < 5; s++) {
      if (s === mySeat) continue;
      if (s === contract.nap) continue;
      if (s === contract.deputy) continue;
      teammates.add(s);
    }
  }
  return teammates;
}

// ============================================================
// ★ A4: 終盤全列挙探索
// 残り手札が既知に近い状況で完全探索する
// ============================================================

function enumerateEndgame(ctx, maxCombinations) {
  const myHand = ctx.hand;
  const otherSeats = [0,1,2,3,4].filter(s => s !== ctx.seat);
  
  // 残り手札数
  const handCounts = otherSeats.map(s => {
    if (ctx.players && ctx.players[s] && ctx.players[s].handCount !== undefined) return ctx.players[s].handCount;
    const played = (ctx.playedCards || []).filter(c => c.seat === s).length;
    const inTrick = (ctx.trick || []).some(t => t.seat === s) ? 1 : 0;
    return Math.max(0, 10 - ctx.trickNo - inTrick - played);
  });
  const totalOthers = handCounts.reduce((s, n) => s + n, 0);
  if (totalOthers > 15) return null;  // 組み合わせ爆発防止
  if (totalOthers <= 0) return null;
  
  // 未見カード
  const seen = new Set(myHand.map(c => c.id));
  (ctx.playedCards || []).forEach(c => seen.add(c.id));
  (ctx.discardedKitty || []).forEach(c => seen.add(c.id));
  (ctx.trick || []).forEach(t => seen.add(t.card.id));
  const unseen = [];
  for (const s of SUITS) for (const r of RANKS) {
    const id = s + r;
    if (!seen.has(id)) unseen.push({ suit: s, rank: r, id });
  }
  if (unseen.length !== totalOthers) return null;
  
  // 組み合わせ数を推定
  const C = (n, k) => {
    if (k > n) return 0;
    if (k === 0 || k === n) return 1;
    let r = 1;
    for (let i = 0; i < k; i++) r = r * (n - i) / (i + 1);
    return Math.round(r);
  };
  let totalCombos = 1;
  let remaining = unseen.length;
  for (let i = 0; i < handCounts.length; i++) {
    totalCombos *= C(remaining, handCounts[i]);
    remaining -= handCounts[i];
    if (totalCombos > maxCombinations) return null;
  }
  
  // 全列挙して各手札割り当てでロールアウト
  const results = legalArray(ctx.legal);
  const evMap = {};
  ctx.legal.forEach(c => evMap[c.id] = { wins: 0, total: 0 });
  
  // 全組み合わせを再帰で列挙
  const enumerateAssignments = (idx, pool, current) => {
    if (idx >= otherSeats.length) {
      // 1つの割り当て完了 → 各合法手でロールアウト
      const hands = [[], [], [], [], []];
      hands[ctx.seat] = myHand.slice();
      otherSeats.forEach((s, i) => hands[s] = current[i].slice());
      
      for (const card of ctx.legal) {
        const simHands = hands.map(h => h.slice());
        simHands[ctx.seat] = simHands[ctx.seat].filter(c => c.id !== card.id);
        const simTrick = ctx.trick.map(t => ({ seat: t.seat, card: t.card }));
        simTrick.push({ seat: ctx.seat, card });
        const active = (ctx.seat + 1) % 5;
        const win = simulateWithPolicyCompleteInfo(
          { hands: simHands, trick: simTrick, trickNo: ctx.trickNo, active, points: ctx.points ? ctx.points.slice() : [0,0,0,0,0], voids: ctx.voids, playedCards: ctx.playedCards },
          ctx.seat, ctx.contract, ctx.params, Math.random
        );
        evMap[card.id].wins += win;
        evMap[card.id].total++;
      }
      return;
    }
    const seat = otherSeats[idx];
    const need = handCounts[idx];
    const newPool = pool.slice();
    const combinations = [];
    const choose = (start, picked) => {
      if (picked.length === need) {
        combinations.push(picked.slice());
        return;
      }
      for (let i = start; i < newPool.length; i++) {
        picked.push(newPool[i]);
        choose(i + 1, picked);
        picked.pop();
      }
    };
    choose(0, []);
    
    for (const combo of combinations) {
      const comboIds = new Set(combo.map(c => c.id));
      const remainingPool = newPool.filter(c => !comboIds.has(c.id));
      current.push(combo);
      enumerateAssignments(idx + 1, remainingPool, current);
      current.pop();
    }
  };
  
  enumerateAssignments(0, unseen, []);
  
  // 最高EVの手を返す
  let bestCard = ctx.legal[0];
  let bestRate = -1;
  for (const c of ctx.legal) {
    const ev = evMap[c.id];
    if (ev.total > 0) {
      const rate = ev.wins / ev.total;
      if (rate > bestRate) { bestRate = rate; bestCard = c; }
    }
  }
  return { bestCard, evMap, combinations: totalCombos };
}

function legalArray(legal) { return legal ? legal.slice() : []; }

// ============================================================
// ★ A5: オープニングブック
// 序盤（trick 0〜openingBookTricks-1）の定跡を経験DBから参照
// ============================================================

function lookupOpeningBook(ctx) {
  if (!ctx.experience || !ctx.experience.plays) return null;
  if (ctx.trickNo >= (ctx.params?.openingBookTricks ?? 3)) return null;
  
  const hash = getStateHash(ctx);
  const exp = ctx.experience.plays[hash];
  if (!exp || exp.samples < (ctx.params?.openingBookMinSamples ?? 20)) return null;
  
  // 勝率が高いカードを選択
  const winRate = exp.wins / exp.samples;
  if (winRate < 0.5) return null;
  
  const bestId = exp.bestCard;
  const bestCard = ctx.legal.find(c => c.id === bestId);
  return bestCard || null;
}

// ============================================================
// ★ A6: 全取り負け事前予測
// bid未達成でも「全部取ると20になる」リスクを先読み
// ============================================================

function predictAllTakeRisk(ctx) {
  const c = ctx.contract;
  if (!c || c.num >= 20) return false;
  const pts = ctx.points || [0, 0, 0, 0, 0];
  const napPts = (pts[c.nap] || 0) + (c.solo ? 0 : (pts[c.deputy] || 0));
  
  // 既にbid達成済みで、残り全部取ると20以上 → 全取りリスク
  const scoredFace = (ctx.playedCards || []).filter(pc => ['10','J','Q','K','A'].includes(pc.rank)).length;
  const remainingPoints = 20 - scoredFace;
  
  // 現在の得点 + 未来の獲得可能点 = 20以上になる危険
  const lookahead = ctx.params?.allTakeLookaheadTricks ?? 3;
  const futureTricks = Math.min(lookahead, 10 - ctx.trickNo);
  const expectedFuturePts = futureTricks * 1.5;
  
  return (napPts + remainingPoints >= 20) || (napPts + expectedFuturePts >= 20 && napPts >= c.num - 2);
}

// ============================================================
// ★ A7: セイム2積極活用（逆方向）
// 自分がリードする時に、相手のフォロー状況を確認して2で狩る
// ============================================================

function shouldLeadSameTwo(ctx) {
  if (ctx.trickNo === 0) return false;
  const ledSuit = ctx.trick.length > 0 ? ctx.trick[0].card.suit : null;
  if (ledSuit) return false;  // リード時のみ
  
  // 各スートで2を持っているか
  for (const suit of SUITS) {
    const two = ctx.hand.find(c => c.suit === suit && c.rank === '2');
    if (!two) continue;
    
    // 相手のボイド状況を確認
    const voidCount = countVoidSeats(ctx.voids || [], suit, ctx.seat);
    const facePlayedInSuit = (ctx.playedCards || []).filter(c => c.suit === suit && isFace(c)).length;
    
    // セイム2が有効になりそう: 全員フォロー見込み & 絵札がまだ残っている
    const isEffective = voidCount === 0 && facePlayedInSuit < 4;
    if (isEffective && Math.random() < (ctx.params?.sameTwoAggressiveLeadChance ?? 0.7)) {
      return two;
    }
  }
  return null;
}

// ============================================================
// ★ B10: ポジション最適化
// 自分が最初/最後の席かで戦略を変える
// ============================================================

function getPositionBonus(ctx) {
  const trick = ctx.trick || [];
  const trickLen = trick.length;
  
  // 最初の席（リード）: 情報優位
  if (trickLen === 0) {
    return -(ctx.params?.positionBonusFirst ?? 0.2);  // リードは情報優位なので「慎重さ」を下げる（＝攻める）
  }
  // 最後の席（5番手）: 情報劣位だが「安全ダック」が可能
  if (trickLen === 4) {
    return -(ctx.params?.positionBonusLast ?? 0.3);  // 最後は安全ダック可能
  }
  return 0;
}

// ============================================================
// 既存の基本ヘルパー
// ============================================================

function isSameTwoTrap(ctx) {
  if (ctx.trickNo === 0) return false;
  if (!ctx.trick || ctx.trick.length === 0) return false;
  if (ctx.trick[0].card.rank !== '2') return false;
  const ledSuit = ctx.trick[0].card.suit;
  if (!ctx.trick.every(t => t.card.suit === ledSuit)) return false;
  return true;
}

function chooseSafeFollowForSameTwo(ctx) {
  const ledSuit = ctx.trick[0].card.suit;
  const followCards = ctx.legal.filter(c => c.suit === ledSuit);
  if (!followCards.length) return null;
  const safeCards = followCards.filter(c => !isFace(c));
  const pool = safeCards.length ? safeCards : followCards;
  return pool.reduce((best, c) =>
    cardPower(ctx.contract, ctx.trickNo, c, ctx.trick) < cardPower(ctx.contract, ctx.trickNo, best, ctx.trick) ? c : best
  , pool[0]);
}

function isAbsoluteWinner(card, contract, trick, playedCards) {
  if (trick.some(e => e.card.id === '♠A') && card.id === '♥Q') return true;
  if (card.id === '♠A' && !trick.some(e => e.card.id === '♥Q')) return true;
  if (isTrumpJ(card, contract)) return true;
  if (isSameColorJ(card, contract) && !trick.some(e => isTrumpJ(e.card, contract))) return true;
  if (card.rank === 'A') {
    const suitPlayed = (playedCards || []).filter(c => c.suit === card.suit).length;
    if (suitPlayed >= 3) return true;
    const ledSuit = trick.length > 0 ? trick[0].card.suit : card.suit;
    if (!trick.every(e => e.card.suit === ledSuit)) return true;
  }
  return false;
}

function countNTControlCards(hand, playedCards) {
  let count = 0;
  const playedIds = new Set((playedCards || []).map(c => c.id));
  if (hand.some(c => c.id === '♠A')) count++;
  for (const suit of SUITS) {
    if (suit === '♠') continue;
    if (hand.some(c => c.id === suit + 'A') && !playedIds.has(suit + 'A')) count++;
    if (hand.some(c => c.id === suit + 'K') && playedIds.has(suit + 'A')) count++;
  }
  return count;
}

function keepValue(c, ctx) {
  const { trickNo, contract, playedCards, hand } = ctx;
  if (c.id === '♠A') return 2000;
  if (isTrumpJ(c, contract)) return 1900;
  if (isSameColorJ(c, contract)) return 1800;
  if (c.id === '♥Q') return 1700;
  if (c.rank === '2') {
    if (trickNo >= 8) return 0;
    const playedIds = new Set((playedCards || []).map(pc => pc.id));
    if (['10', 'J', 'Q', 'K', 'A'].every(r => playedIds.has(c.suit + r))) return 0;
    return 50;
  }
  const playedIds = new Set((playedCards || []).map(pc => pc.id));
  const myIds = new Set((hand || []).map(hc => hc.id));
  let isStrongestInSuit = true;
  if (isTrump(contract, c)) isStrongestInSuit = false;
  else {
    for (const r of RANKS.slice().reverse()) {
      const id = c.suit + r;
      if (playedIds.has(id)) continue;
      if (myIds.has(id)) { if (id === c.id) break; else { isStrongestInSuit = false; break; } }
      isStrongestInSuit = false; break;
    }
  }
  if (isStrongestInSuit) return 1000;
  return ['10', 'J', 'Q', 'K', 'A'].includes(c.rank) ? 100 + RANKS.indexOf(c.rank) : RANKS.indexOf(c.rank);
}

function lowX(ctx, cards) {
  if (!cards || !cards.length) return null;
  const sorted = cards.slice().sort((a, b) => {
    const va = keepValue(a, ctx), vb = keepValue(b, ctx);
    if (va !== vb) return va - vb;
    return cardPower(ctx.contract, ctx.trickNo, a, ctx.trick) - cardPower(ctx.contract, ctx.trickNo, b, ctx.trick);
  });
  if (keepValue(sorted[0], ctx) === 0) return sorted[0];
  if (!ctx.experience || sorted.length < 2) return sorted[0];
  const role = ctx.seat === ctx.contract.nap ? 'nap' : ((!ctx.contract.solo && ctx.contract.revealedCall && ctx.seat === ctx.contract.deputy) ? 'dep' : 'ally');
  const look = sorted.slice(0, Math.min(2, sorted.length));
  let best = look[0], bestScore = -Infinity;
  for (const c of look) {
    const exp = ctx.experience.plays?.[playExperienceKey(role, trickPhaseOf(ctx.trickNo), pointsTierOf((ctx.trick || []).filter(e => isFace(e.card)).length), rankTierOf(c.rank))];
    let s = (exp && exp.samples >= 3) ? (exp.wins / exp.samples) * experienceConfidence(exp.samples) : 0;
    if (s > bestScore) { bestScore = s; best = c; }
  }
  return best;
}

function detectGameOutcome(ctx) {
  const c = ctx.contract;
  if (!c) return 'ongoing';
  const pts = ctx.points || [0, 0, 0, 0, 0];
  const napPoints = (pts[c.nap] || 0) + (c.solo ? 0 : (pts[c.deputy] || 0));
  const allyKitty = ctx.allianceKittyPoints || 0;
  const allyPoints = pts.reduce((sum, p, i) => {
    if (i === c.nap) return sum;
    if (!c.solo && i === c.deputy) return sum;
    return sum + (p || 0);
  }, 0) + allyKitty;
  const remaining = 10 - (ctx.trickNo || 0);
  if (napPoints >= c.num && (c.num === 20 || allyPoints >= 1)) return 'nap_win';
  if (allyPoints > 20 - c.num) return 'ally_win';
  if (napPoints + remaining * 5 < c.num) return 'nap_lose';
  if (c.num < 20 && allyPoints + remaining * 5 < 20 - c.num) return 'ally_lose';
  return 'ongoing';
}

function chooseCardAfterOutcome(ctx, outcome) {
  const { contract, legal } = ctx;
  const myTeamNap = isOnNapSide(ctx);
  if (outcome === 'ally_win') {
    if (myTeamNap) return lowX(ctx, legal);
    return legal.slice().sort((a, b) => cardPower(contract, ctx.trickNo, b, ctx.trick) - cardPower(contract, ctx.trickNo, a, ctx.trick))[0];
  }
  if (outcome === 'nap_win' || outcome === 'nap_lose' || outcome === 'ally_lose') return lowX(ctx, legal);
  return null;
}

function followWhenTeamWinning(legal, contract, call, trick, trickNo, lowXFunc, ctx) {
  const hasMighty = trick.some(e => e.card.id === '♠A');
  const feedCards = legal.filter(c => !isRoleJ(c, contract) && ['10', 'J', 'Q'].includes(c.rank) && c.id !== call?.id && !(hasMighty && c.id === '♥Q'));
  if (feedCards.length) return feedCards.sort((a, b) => cardPower(contract, trickNo, a, trick) - cardPower(contract, trickNo, b, trick))[0];
  const safeCards = legal.filter(c => !['K', 'A'].includes(c.rank) && !isRoleJ(c, contract) && c.id !== call?.id && c.id !== '♠A' && c.id !== '♥Q');
  if (safeCards.length) return lowXFunc(ctx, safeCards);
  return lowXFunc(ctx, legal);
}

// --- NT戦略群 ---
function chooseNTNapoleonLead(ctx) {
  const { hand, legal, trickNo, playedCards, voids, seat, params, discardedKitty } = ctx;
  if (!legal || !legal.length) return null;
  if (trickNo > 0 && trickNo <= 5) {
    const suitsWithAce = SUITS.filter(s => hand.some(c => c.suit === s && c.rank === 'A'));
    for (const suit of suitsWithAce) {
      const playedInSuit = playedCards.filter(c => c.suit === suit).length;
      const voidCount = countVoidSeats(voids, suit, seat);
      if (playedInSuit < 4 && voidCount === 0) {
        const weakCards = legal.filter(c => c.suit === suit && c.rank !== '2' && ['3','4','5','6','7','8','9'].includes(c.rank));
        if (weakCards.length && Math.random() < (params.ntAceProtectLeadWeight ?? 1.5) * 0.5) return weakCards.sort((a, b) => RANKS.indexOf(a.rank) - RANKS.indexOf(b.rank))[0];
      }
    }
  }
  const mighty = legal.find(c => c.id === '♠A');
  const hqPlayed = playedCards.some(c => c.id === '♥Q');
  const hqInDiscard = (discardedKitty || []).some(c => c.id === '♥Q');
  const isMightySafe = hqPlayed || hqInDiscard;
  if (mighty) {
    const holdThreshold = params.ntMightyHoldThreshold ?? 8;
    const emergencyThreshold = params.ntMightyEmergencyTrick ?? 5;
    if (trickNo < holdThreshold && !(trickNo >= emergencyThreshold)) {
      const otherAces = legal.filter(c => c.rank === 'A' && c.id !== '♠A');
      if (otherAces.length) return otherAces[0];
      const lowCards = legal.filter(c => c.rank !== 'A' && c.rank !== 'K' && c.rank !== '2');
      if (lowCards.length) return lowCards.sort((a, b) => RANKS.indexOf(a.rank) - RANKS.indexOf(b.rank))[0];
    }
  }
  const safeAces = legal.filter(c => c.rank === 'A' && c.id !== '♠A');
  if (safeAces.length) return safeAces[0];
  if (mighty && isMightySafe && trickNo >= (params.ntMightyHoldThreshold ?? 8)) return mighty;
  if (trickNo > 0 && trickNo <= 5) {
    const suitsWithAce = SUITS.filter(s => hand.some(c => c.suit === s && c.rank === 'A'));
    const twosToClear = legal.filter(c => c.rank === '2' && suitsWithAce.includes(c.suit) && !playedCards.some(pc => pc.suit === c.suit && pc.rank === '2'));
    if (twosToClear.length && Math.random() < (params.ntSameTwoGuardWeight ?? 1.2) * 0.5) return twosToClear[0];
  }
  if (trickNo > 0 && trickNo <= 4) {
    const freshTwos = legal.filter(c => c.rank === '2' && !playedCards.some(pc => pc.suit === c.suit));
    if (freshTwos.length) return freshTwos[0];
  }
  // ★ A6: 全取り負け回避（bid達成前でも先読み）
  const allTakeRisk = predictAllTakeRisk(ctx);
  if (allTakeRisk) {
    const offSuitLow = legal.filter(c => c.id !== '♠A' && c.rank !== 'A' && !isRoleJ(c, ctx.contract));
    if (offSuitLow.length) return offSuitLow.slice().sort((a, b) => RANKS.indexOf(a.rank) - RANKS.indexOf(b.rank))[0];
  }
  // ★ A7: セイム2積極活用
  const sameTwo = shouldLeadSameTwo(ctx);
  if (sameTwo) return sameTwo;
  if (trickNo === 0) {
    const safeAcesFirst = legal.filter(c => c.rank === 'A' && c.suit !== ctx.contract.suit);
    if (safeAcesFirst.length) {
      const nonMightyAces = safeAcesFirst.filter(c => c.id !== '♠A');
      if (nonMightyAces.length) return nonMightyAces[0];
      if (hqPlayed || hqInDiscard) return safeAcesFirst.find(c => c.id === '♠A');
    }
    const candidates = legal.filter(c => c.rank !== '2');
    return (candidates.length ? candidates : legal).sort((a, b) => cardPower(ctx.contract, trickNo, a, []) - cardPower(ctx.contract, trickNo, b, []) )[0];
  }
  if (trickNo >= 6) {
    const sureWinners = legal.filter(c => isAbsoluteWinner(c, ctx.contract, [], playedCards));
    if (sureWinners.length) return sureWinners[0];
  }
  const finalCandidates = legal.filter(c => c.rank !== '2');
  return (finalCandidates.length ? finalCandidates : legal).sort((a, b) => cardPower(ctx.contract, trickNo, a, []) - cardPower(ctx.contract, trickNo, b, []) )[0];
}

function chooseNTNapoleonFollow(ctx) {
  const { hand, legal: originalLegal, trick, trickNo, contract, playedCards, voids, seat, currentNapPoints } = ctx;
  if (!originalLegal || !originalLegal.length) return null;
  let legal = originalLegal;
  if (trick.some(e => e.card.id === '♥Q')) { const safeLegal = legal.filter(c => c.id !== '♠A'); if (safeLegal.length > 0) legal = safeLegal; }
  const current = winningEntry(contract, trickNo, trick, trick.length < 5);
  const isTeamWinning = current && isTeamNap(current.seat, contract);
  const pointsInTrick = trick.filter(e => isFace(e.card)).length;
  const winningCards = legal.filter(c => winningEntry(contract, trickNo, [...trick, { seat, card: c }], trick.length < 4)?.seat === seat);
  const low = cards => cards.slice().sort((a, b) => cardPower(contract, trickNo, a, trick) - cardPower(contract, trickNo, b, trick))[0];
  const napPoints = currentNapPoints || 0;
  const remainingTricks = Math.max(1, 10 - trickNo - (trick.length >= 4 ? 1 : 0));
  if (isTeamWinning) return followWhenTeamWinning(legal, contract, ctx.call, trick, trickNo, lowX, ctx);
  if (trickNo > 0 && trickNo <= 5) {
    const ledSuit = trick[0].card.suit;
    const hasAceInLed = hand.some(c => c.suit === ledSuit && c.rank === 'A');
    if (hasAceInLed && countVoidSeats(voids, ledSuit, seat) === 0) {
      const weakFollow = legal.filter(c => c.suit === ledSuit && c.rank !== '2' && ['3','4','5','6','7','8','9'].includes(c.rank));
      if (weakFollow.length) return weakFollow[0];
    }
  }
  if (trickNo <= 6 && pointsInTrick <= 1 && trick.length > 0) {
    const myControls = countNTControlCards(hand, playedCards);
    const needed = Math.max(0, contract.num - (currentNapPoints || 0));
    const buffer = remainingTricks - needed - myControls;
    if (buffer >= 1) {
      const isSafeToDuck = !legal.some(c => c.id === '♠A' || c.rank === 'A' || (c.rank === 'K' && playedCards.some(pc => pc.suit === c.suit && pc.rank === 'A')));
      if (isSafeToDuck) return lowX(ctx, legal);
    }
  }
  // ★ A6: 全取りリスク先読み
  if (predictAllTakeRisk(ctx)) {
    const nonWinning = legal.filter(c => !winningCards.includes(c));
    if (nonWinning.length) return lowX(ctx, nonWinning);
  }
  if (contract.num < 20 && napPoints >= contract.num) {
    const scoredFace = (playedCards || []).filter(c => ['10','J','Q','K','A'].includes(c.rank)).length
      + trick.filter(e => isFace(e.card)).length;
    const remainingPoints = 20 - scoredFace;
    if (napPoints + remainingPoints >= 20) {
      const nonWinning = legal.filter(c => !winningCards.includes(c));
      if (nonWinning.length) return lowX(ctx, nonWinning);
    }
  }
  if (contract.num < 20 && napPoints >= 19) {
    const nonWinning = legal.filter(c => !winningCards.includes(c));
    return lowX(ctx, nonWinning.length ? nonWinning : legal);
  }
  if (!isTeamWinning && winningCards.length === 0) {
    const nonFaces = legal.filter(c => !isFace(c));
    if (nonFaces.length) return lowX(ctx, nonFaces);
  }
  if (pointsInTrick > 0 && winningCards.length) return low(winningCards);
  if (trickNo >= 7 && winningCards.length) {
    const absoluteWins = winningCards.filter(c => isAbsoluteWinner(c, contract, trick, playedCards));
    if (absoluteWins.length) return absoluteWins[0];
  }
  const needed = Math.max(0, contract.num - napPoints);
  const urgency = needed / remainingTricks;
  if (trickNo >= 5 && urgency >= 1.0 && winningCards.length) return low(winningCards);
  return lowX(ctx, legal);
}

function chooseNTAllianceLead(ctx) {
  const { hand, legal, trickNo, contract, params, playedCards, voids, seat } = ctx;
  if (!legal || !legal.length) return null;
  const napVoidSuits = SUITS.filter(s => voids[contract.nap]?.[s]);
  if (napVoidSuits.length > 0) {
    const exploitSuit = napVoidSuits[0];
    const exploitCards = legal.filter(c => c.suit === exploitSuit);
    if (exploitCards.length) return exploitCards.sort((a, b) => RANKS.indexOf(a.rank) - RANKS.indexOf(b.rank))[0];
  }
  const myAces = legal.filter(c => c.rank === 'A');
  if (myAces.length) return myAces[0];
  const allyVoidSuits = SUITS.filter(s => s !== contract.suit && [0,1,2,3,4].some(i => i !== seat && i !== contract.nap && voids[i]?.[s]));
  if (allyVoidSuits.length > 0 && Math.random() < (params.allyVoidExploitWeight ?? 1.0) * 0.3) {
    const exploit = legal.filter(c => allyVoidSuits.includes(c.suit) && !isFace(c));
    if (exploit.length) return exploit[0];
  }
  const spadeLow = legal.filter(c => c.suit === '♠' && !isFace(c) && (trickNo > 0 || c.rank !== '2'));
  if (spadeLow.length && trickNo <= 3 && Math.random() < (params.spadeLeadPriority || 0.7) + 0.2) return spadeLow.sort((a, b) => RANKS.indexOf(a.rank) - RANKS.indexOf(b.rank))[0];
  const weakSuit = estimateNapWeakSuit(playedCards, contract);
  if (weakSuit) {
    const weakLow = legal.filter(c => c.suit === weakSuit && !isFace(c) && (trickNo > 0 || c.rank !== '2'));
    if (weakLow.length) return weakLow[0];
  }
  // ★ A7: セイム2積極活用
  const sameTwo = shouldLeadSameTwo(ctx);
  if (sameTwo) return sameTwo;
  const suitLens = SUITS.map(s => ({ suit: s, cards: legal.filter(c => c.suit === s) })).filter(x => x.suit !== contract.suit && x.cards.length >= 3).sort((a, b) => b.cards.length - a.cards.length);
  for (const sl of suitLens) { const lowCard = sl.cards.filter(c => !isFace(c) && (trickNo > 0 || c.rank !== '2'))[0]; if (lowCard) return lowCard; }
  const finalCandidates = trickNo === 0 ? legal.filter(c => c.rank !== '2') : legal;
  return (finalCandidates.length ? finalCandidates : legal).slice().sort((a, b) => cardPower(contract, trickNo, a, []) - cardPower(contract, trickNo, b, []) )[0];
}

function estimateNapWeakSuit(playedCards, contract) {
  const avoid = [contract.suit, sameColorSuitOf(contract.suit)].filter(Boolean);
  const candidates = SUITS.filter(s => !avoid.includes(s));
  if (!candidates.length) return null;
  const playedCount = {};
  candidates.forEach(s => playedCount[s] = (playedCards || []).filter(c => c.suit === s).length);
  return candidates.sort((a, b) => playedCount[a] - playedCount[b])[0];
}

function chooseNTAllianceFollow(ctx) {
  const { legal: originalLegal, trick, trickNo, contract, playedCards, hand, voids } = ctx;
  if (!originalLegal || !originalLegal.length) return null;
  let legal = originalLegal;
  if (trick.some(e => e.card.id === '♥Q')) { const safeLegal = legal.filter(c => c.id !== '♠A'); if (safeLegal.length > 0) legal = safeLegal; }
  if (isSameTwoTrap(ctx)) {
    const safe = chooseSafeFollowForSameTwo(ctx);
    if (safe) return safe;
  }
  const current = winningEntry(contract, trickNo, trick, trick.length < 5);
  const isAllyWinning = current && current.seat !== contract.nap && (!contract.solo && current.seat !== contract.deputy);
  const pointsInTrick = trick.filter(e => isFace(e.card)).length;
  const winningCards = legal.filter(c => winningEntry(contract, trickNo, [...trick, { seat: ctx.seat, card: c }], trick.length < 4)?.seat === ctx.seat);
  const low = cards => cards.slice().sort((a, b) => cardPower(contract, trickNo, a, trick) - cardPower(contract, trickNo, b, trick))[0];
  if (isAllyWinning) return followWhenTeamWinning(legal, contract, null, trick, trickNo, lowX, ctx);
  if (!isAllyWinning && pointsInTrick > 0) {
    if (winningCards.length) {
      const scoreWins = winningCards.filter(c => isFace(c));
      if (scoreWins.length) return scoreWins.sort((a, b) => RANKS.indexOf(b.rank) - RANKS.indexOf(a.rank))[0];
      return low(winningCards);
    } else {
      const nonScore = legal.filter(c => !isFace(c));
      if (nonScore.length) return lowX(ctx, nonScore);
    }
  }
  if (trickNo >= 7 && winningCards.length) { const absoluteWins = winningCards.filter(c => isAbsoluteWinner(c, contract, trick, playedCards)); if (absoluteWins.length) return absoluteWins[0]; }
  if (!isAllyWinning && winningCards.length === 0) { const nonFaces = legal.filter(c => !isFace(c)); if (nonFaces.length) return lowX(ctx, nonFaces); }
  return lowX(ctx, legal);
}

function chooseNTDeputyPlay(ctx) {
  const { hand, legal: originalLegal, trick, trickNo, contract, call, seat, playedCards, currentNapPoints } = ctx;
  if (!originalLegal || !originalLegal.length) return null;
  let legal = originalLegal;
  if (trick.some(e => e.card.id === '♥Q')) { const safeLegal = legal.filter(c => c.id !== '♠A'); if (safeLegal.length > 0) legal = safeLegal; }
  const low = cards => cards.slice().sort((a, b) => cardPower(contract, trickNo, a, trick) - cardPower(contract, trickNo, b, trick))[0];
  const winningCards = legal.filter(c => winningEntry(contract, trickNo, [...trick, { seat, card: c }], trick.length < 4)?.seat === seat);
  const current = winningEntry(contract, trickNo, trick, trick.length < 5);
  const isTeamWinning = current && isTeamNap(current.seat, contract);
  const pointsInTrick = trick.filter(e => isFace(e.card)).length;
  const remainingTricks = Math.max(1, 10 - trickNo - (trick.length >= 4 ? 1 : 0));
  const myCalledCard = legal.find(c => c.id === call?.id);
  if (myCalledCard) {
    if (trick.length === 4 && pointsInTrick === 0 && isTeamWinning) { const others = legal.filter(c => c.id !== call.id); if (others.length) return low(others); }
    return myCalledCard;
  }
  if (isTeamWinning) return followWhenTeamWinning(legal, contract, call, trick, trickNo, lowX, ctx);
  if (trickNo <= 6 && pointsInTrick <= 1 && trick.length > 0) {
    const myControls = countNTControlCards(legal, playedCards);
    const needed = Math.max(0, contract.num - (currentNapPoints || 0));
    const buffer = remainingTricks - needed - myControls;
    if (buffer >= 1) {
      const isSafeToDuck = !legal.some(c => c.id === '♠A' || c.rank === 'A' || (c.rank === 'K' && playedCards.some(pc => pc.suit === c.suit && pc.rank === 'A')));
      if (isSafeToDuck) return lowX(ctx, legal);
    }
  }
  if (predictAllTakeRisk(ctx)) {
    const nonWinning = legal.filter(c => !winningCards.includes(c));
    if (nonWinning.length) return lowX(ctx, nonWinning);
  }
  if (!isTeamWinning && pointsInTrick > 0) {
    if (winningCards.length) { const scoreWins = winningCards.filter(c => isFace(c)); if (scoreWins.length) return scoreWins.sort((a, b) => RANKS.indexOf(b.rank) - RANKS.indexOf(a.rank))[0]; return low(winningCards); }
    else { const nonScore = legal.filter(c => !isFace(c)); if (nonScore.length) return lowX(ctx, nonScore); }
  }
  if (trickNo >= 7 && winningCards.length) { const absoluteWins = winningCards.filter(c => isAbsoluteWinner(c, contract, trick, playedCards)); if (absoluteWins.length) return absoluteWins[0]; }
  if (!isTeamWinning && winningCards.length === 0) { const nonFaces = legal.filter(c => !isFace(c)); if (nonFaces.length) return lowX(ctx, nonFaces); }
  return lowX(ctx, legal);
}

// --- 色（スート）戦略群 ---
function chooseColorNapoleonLead(ctx) {
  const { hand, legal, contract, trickNo, playedCards, voids, seat, params, discardedKitty, currentNapPoints } = ctx;
  if (!legal || !legal.length) return null;
  const plan = contract.bidPlan;
  const sideAces = hand.filter(c => c.suit !== contract.suit && c.rank === 'A' && c.id !== '♠A').length;
  const myTrumps = hand.filter(c => c.suit === contract.suit);
  const playedTrumps = playedCards.filter(c => c.suit === contract.suit).length;
  const remainingTrumps = Math.max(0, 13 - playedTrumps - myTrumps.length);
  const enemyTrumpsLeft = remainingTrumps >= 3;
  const trumpAdvantage = myTrumps.length >= remainingTrumps;
  if (sideAces >= 2 && trumpAdvantage && enemyTrumpsLeft && trickNo > 0 && trickNo <= 4) {
    const trumpLeads = legal.filter(c => c.suit === contract.suit && c.rank !== 'A' && c.rank !== 'K' && c.rank !== 'J' && c.rank !== '2');
    if (trumpLeads.length) return trumpLeads.sort((a, b) => RANKS.indexOf(b.rank) - RANKS.indexOf(a.rank))[0];
  }
  if (plan && trickNo <= 3) {
    for (const suit of (plan.runSuits || [])) { const suitCards = legal.filter(c => c.suit === suit); if (suitCards.length) return suitCards.sort((a, b) => RANKS.indexOf(b.rank) - RANKS.indexOf(a.rank))[0]; }
    const safeLeads = legal.filter(c => c.rank === 'A' && c.suit !== contract.suit);
    if (safeLeads.length) return safeLeads[0];
  }
  if (trickNo <= (params.napEarlyTrumpLeadMaxTrick ?? 3)) {
    const playedTrumps = playedCards.filter(c => c.suit === contract.suit).length;
    const remainingTrumps = Math.max(0, 13 - playedTrumps - myTrumps.length);
    if (myTrumps.length >= (params.napEarlyTrumpMinCount ?? 4) && remainingTrumps > 0) {
      const trumpLeads = legal.filter(c => c.suit === contract.suit && c.rank !== 'A' && c.rank !== 'K' && c.rank !== 'J' && c.rank !== '2');
      if (trumpLeads.length && (sideAces >= 1 || Math.random() < (params.napEarlyTrumpLeadWeight ?? 1.5))) return trumpLeads.sort((a, b) => RANKS.indexOf(b.rank) - RANKS.indexOf(a.rank))[0];
    }
  }
  // ★ A6: 全取りリスク先読み
  if (predictAllTakeRisk(ctx)) {
    const offSuitLow = legal.filter(c => !isTrump(contract, c) && c.id !== '♠A' && c.rank !== 'A' && !isRoleJ(c, contract));
    if (offSuitLow.length) return offSuitLow.slice().sort((a, b) => RANKS.indexOf(a.rank) - RANKS.indexOf(b.rank))[0];
    return lowX(ctx, legal);
  }
  if (contract.num < 20 && (currentNapPoints || 0) >= 19) {
    const offSuitLow = legal.filter(c => !isTrump(contract, c) && c.id !== '♠A' && c.rank !== 'A' && !isRoleJ(c, contract));
    if (offSuitLow.length) return offSuitLow.slice().sort((a, b) => RANKS.indexOf(a.rank) - RANKS.indexOf(b.rank))[0];
    return lowX(ctx, legal);
  }
  // ★ A7: セイム2積極活用
  const sameTwo = shouldLeadSameTwo(ctx);
  if (sameTwo) return sameTwo;
  if (trickNo === 0) {
    const safeAces = legal.filter(c => c.rank === 'A' && c.suit !== contract.suit);
    if (safeAces.length) {
      const nonMightyAces = safeAces.filter(c => c.id !== '♠A');
      if (nonMightyAces.length) return nonMightyAces[0];
      if (playedCards.some(c => c.id === '♥Q') || (discardedKitty || []).some(c => c.id === '♥Q')) return safeAces.find(c => c.id === '♠A');
    }
    const candidates = legal.filter(c => c.rank !== '2');
    return (candidates.length ? candidates : legal).sort((a, b) => cardPower(contract, trickNo, a, []) - cardPower(contract, trickNo, b, []) )[0];
  }
  if (trickNo <= 3) {
    const tj = legal.find(c => isTrumpJ(c, contract));
    if (tj) return tj;
    const scj = legal.find(c => isSameColorJ(c, contract));
    if (scj) return scj;
  }
  if (trickNo >= 6) {
    const sureWinners = legal.filter(c => isAbsoluteWinner(c, contract, [], playedCards));
    if (sureWinners.length) return sureWinners[0];
  }
  const safeAces = legal.filter(c => {
    if (c.rank !== 'A' || c.suit === contract.suit) return false;
    if (c.id === '♠A') return playedCards.some(pc => pc.id === '♥Q') || countVoidSeats(voids, '♠', seat) === 0;
    if (hand.some(hc => hc.suit === c.suit && hc.rank === '2')) return true;
    if ((discardedKitty || []).some(k => k.id === c.suit + '2')) return true;
    if (playedCards.some(pc => pc.suit === c.suit && pc.rank === '2')) return countVoidSeats(voids, c.suit, seat) === 0;
    return false;
  });
  if (safeAces.length) return safeAces.sort((a, b) => playedCards.filter(pc => pc.suit === b.suit).length - playedCards.filter(pc => pc.suit === a.suit).length)[0];
  const suitLens = SUITS.filter(s => s !== contract.suit).map(s => ({ suit: s, count: legal.filter(c => c.suit === s).length })).sort((a, b) => b.count - a.count);
  for (const sl of suitLens) { if (sl.count >= 3) { const low = legal.filter(c => c.suit === sl.suit && !isFace(c) && c.rank !== '2').sort((a, b) => RANKS.indexOf(a.rank) - RANKS.indexOf(b.rank))[0]; if (low) return low; } }
  const finalCandidates = legal.filter(c => c.rank !== '2');
  return (finalCandidates.length ? finalCandidates : legal).sort((a, b) => cardPower(contract, trickNo, a, []) - cardPower(contract, trickNo, b, []) )[0];
}

function chooseColorNapoleonFollow(ctx) {
  const { hand, legal: originalLegal, trick, trickNo, contract, playedCards, voids, seat, currentNapPoints, params, call } = ctx;
  if (!originalLegal || !originalLegal.length) return null;
  let legal = originalLegal;
  if (trick.some(e => e.card.id === '♥Q')) { const safeLegal = legal.filter(c => c.id !== '♠A'); if (safeLegal.length > 0) legal = safeLegal; }
  const current = winningEntry(contract, trickNo, trick, trick.length < 5);
  const isTeamWinning = current && isTeamNap(current.seat, contract);
  const pointsInTrick = trick.filter(e => isFace(e.card)).length;
  const winningCards = legal.filter(c => winningEntry(contract, trickNo, [...trick, { seat, card: c }], trick.length < 4)?.seat === seat);
  const low = cards => cards.slice().sort((a, b) => cardPower(contract, trickNo, a, trick) - cardPower(contract, trickNo, b, trick))[0];
  const napPoints = currentNapPoints || 0;
  const remainingTricks = Math.max(1, 10 - trickNo - (trick.length >= 4 ? 1 : 0));
  const isLastSeat = trick.length === 4;
  if (isTeamWinning) return followWhenTeamWinning(legal, contract, call, trick, trickNo, lowX, ctx);
  if (isLastSeat && pointsInTrick === 0 && trickNo < 9) { const nonFaces = legal.filter(c => !isFace(c)); if (nonFaces.length) return lowX(ctx, nonFaces); }
  // ★ A6: 全取りリスク先読み
  if (predictAllTakeRisk(ctx)) {
    const nonWinning = legal.filter(c => !winningCards.includes(c));
    if (nonWinning.length) return lowX(ctx, nonWinning);
  }
  if (contract.num < 20 && napPoints >= 19) { const nonWinning = legal.filter(c => !winningCards.includes(c)); return lowX(ctx, nonWinning.length ? nonWinning : legal); }
  if (!isTeamWinning && winningCards.length === 0) { const nonFaces = legal.filter(c => !isFace(c)); if (nonFaces.length) return lowX(ctx, nonFaces); }
  const needed = Math.max(0, contract.num - napPoints);
  const urgency = needed / remainingTricks;
  if (pointsInTrick > 0 && winningCards.length) {
    if (legal[0]?.suit !== trick[0].card.suit) { const trumps = winningCards.filter(c => isTrump(contract, c)); if (trumps.length) return low(trumps); }
    return low(winningCards);
  }
  if (trickNo >= 6 && winningCards.length) return low(winningCards);
  if (urgency >= 1.2 && winningCards.length) return low(winningCards);
  return lowX(ctx, legal);
}

function chooseColorAllianceLead(ctx) {
  const { hand, legal, trickNo, contract, params, playedCards, voids, seat } = ctx;
  if (!legal || !legal.length) return null;
  for (const suit of SUITS) {
    if (suit === contract.suit) continue;
    if (voids[contract.nap]?.[suit] && !voids[seat]?.[suit]) {
      const attackLeads = legal.filter(c => c.suit === suit && !isFace(c) && c.rank !== '2');
      if (attackLeads.length) return attackLeads.sort((a, b) => RANKS.indexOf(a.rank) - RANKS.indexOf(b.rank))[0];
    }
  }
  const allyVoidSuits = SUITS.filter(s => s !== contract.suit && [0,1,2,3,4].some(i => i !== seat && i !== contract.nap && voids[i]?.[s]));
  if (allyVoidSuits.length > 0 && Math.random() < (params.allyVoidExploitWeight ?? 1.0) * 0.3) {
    const exploit = legal.filter(c => allyVoidSuits.includes(c.suit) && !isFace(c));
    if (exploit.length) return exploit[0];
  }
  const p = params || {};
  if (trickNo > 0 && trickNo <= (p.allySameTwoWindow ?? 4)) {
    const faceRanks = ['10', 'J', 'Q', 'K', 'A'];
    const playedIds = new Set((playedCards || []).map(pc => pc.id));
    const freshTwos = legal.filter(c => c.rank === '2' && (contract.suit === 'NT' || c.suit !== contract.suit) && !(playedCards || []).some(pc => pc.suit === c.suit) && countVoidSeats(voids, c.suit, seat) === 0 && (contract.suit === 'NT' || !voids[contract.nap]?.[c.suit]) && !faceRanks.every(r => playedIds.has(c.suit + r)));
    if (freshTwos.length && Math.random() < (p.allySameTwoLeadChance ?? 0.55)) return freshTwos[0];
  }
  if (contract.suit !== 'NT') {
    const trump = contract.suit, sc = sameColorSuitOf(trump), avoidSuits = [trump, sc].filter(Boolean);
    const leadable = legal.filter(c => !avoidSuits.includes(c.suit) && !isFace(c) && (trickNo > 0 || c.rank !== '2'));
    if (leadable.length && Math.random() < Math.min(1.0, p.napWeaknessLeadWeight ?? 0.8)) {
      const bySuitLen = SUITS.filter(s => !avoidSuits.includes(s)).map(s => ({ suit: s, cards: leadable.filter(c => c.suit === s) })).filter(x => x.cards.length > 0).sort((a, b) => b.cards.length - a.cards.length);
      if (bySuitLen.length) return bySuitLen[0].cards.sort((a, b) => RANKS.indexOf(a.rank) - RANKS.indexOf(b.rank))[0];
    }
  }
  const suitLens = SUITS.map(s => ({ suit: s, cards: legal.filter(c => c.suit === s) })).filter(x => x.suit !== contract.suit && x.cards.length >= 3).sort((a, b) => b.cards.length - a.cards.length);
  for (const sl of suitLens) { const lowCard = sl.cards.filter(c => !isFace(c) && (trickNo > 0 || c.rank !== '2'))[0]; if (lowCard) return lowCard; }
  const finalCandidates = trickNo === 0 ? legal.filter(c => c.rank !== '2') : legal;
  return (finalCandidates.length ? finalCandidates : legal).slice().sort((a, b) => cardPower(contract, trickNo, a, []) - cardPower(contract, trickNo, b, []) )[0];
}

function chooseColorAllianceFollow(ctx) {
  const { legal: originalLegal, trick, trickNo, contract, playedCards, hand, voids } = ctx;
  if (!originalLegal || !originalLegal.length) return null;
  let legal = originalLegal;
  if (trick.some(e => e.card.id === '♥Q')) { const safeLegal = legal.filter(c => c.id !== '♠A'); if (safeLegal.length > 0) legal = safeLegal; }
  if (isSameTwoTrap(ctx)) {
    const safe = chooseSafeFollowForSameTwo(ctx);
    if (safe) return safe;
  }
  const ledSuit = trick[0].card.suit;
  const current = winningEntry(contract, trickNo, trick, trick.length < 5);
  const isAllyWinning = current && current.seat !== contract.nap && (!contract.solo && current.seat !== contract.deputy);
  const pointsInTrick = trick.filter(e => isFace(e.card)).length;
  const winningCards = legal.filter(c => winningEntry(contract, trickNo, [...trick, { seat: ctx.seat, card: c }], trick.length < 4)?.seat === ctx.seat);
  const low = cards => cards.slice().sort((a, b) => cardPower(contract, trickNo, a, trick) - cardPower(contract, trickNo, b, trick))[0];
  if (isAllyWinning) return followWhenTeamWinning(legal, contract, null, trick, trickNo, lowX, ctx);
  if (!isAllyWinning && pointsInTrick > 0) {
    if (winningCards.length) { const scoreWins = winningCards.filter(c => isFace(c)); if (scoreWins.length) return scoreWins.sort((a, b) => RANKS.indexOf(b.rank) - RANKS.indexOf(a.rank))[0]; return low(winningCards); }
    else { const nonScore = legal.filter(c => !isFace(c)); if (nonScore.length) return lowX(ctx, nonScore); }
  }
  if (trickNo >= 7 && winningCards.length) { const absoluteWins = winningCards.filter(c => isAbsoluteWinner(c, contract, trick, playedCards)); if (absoluteWins.length) return absoluteWins[0]; }
  if (legal[0]?.suit !== ledSuit && !isAllyWinning) { const nonTrump = legal.filter(c => !isTrump(contract, c)); if (nonTrump.length) return lowX(ctx, nonTrump); }
  if (!isAllyWinning && winningCards.length === 0) { const nonFaces = legal.filter(c => !isFace(c)); if (nonFaces.length) return lowX(ctx, nonFaces); }
  return lowX(ctx, legal);
}

function chooseColorDeputyPlay(ctx) {
  const { hand, legal: originalLegal, trick, trickNo, contract, call, seat, playedCards, voids, params, discardedKitty, currentNapPoints } = ctx;
  if (!originalLegal || !originalLegal.length) return null;
  let legal = originalLegal;
  if (trick.some(e => e.card.id === '♥Q')) { const safeLegal = legal.filter(c => c.id !== '♠A'); if (safeLegal.length > 0) legal = safeLegal; }
  const low = cards => cards.slice().sort((a, b) => cardPower(contract, trickNo, a, trick) - cardPower(contract, trickNo, b, trick))[0];
  const winningCards = legal.filter(c => winningEntry(contract, trickNo, [...trick, { seat, card: c }], trick.length < 4)?.seat === seat);
  const current = winningEntry(contract, trickNo, trick, trick.length < 5);
  const isTeamWinning = current && isTeamNap(current.seat, contract);
  const pointsInTrick = trick.filter(e => isFace(e.card)).length;
  const remainingTricks = Math.max(1, 10 - trickNo - (trick.length >= 4 ? 1 : 0));
  const myCalledCard = legal.find(c => c.id === call?.id);
  if (myCalledCard) {
    if (trick.length === 4 && pointsInTrick === 0 && isTeamWinning) { const others = legal.filter(c => c.id !== call.id); if (others.length) return low(others); }
    return myCalledCard;
  }
  if (isTeamWinning) return followWhenTeamWinning(legal, contract, call, trick, trickNo, lowX, ctx);
  if (predictAllTakeRisk(ctx)) {
    const nonWinning = legal.filter(c => !winningCards.includes(c));
    if (nonWinning.length) return lowX(ctx, nonWinning);
  }
  if (!isTeamWinning && pointsInTrick > 0) {
    if (winningCards.length) { const scoreWins = winningCards.filter(c => isFace(c)); if (scoreWins.length) return scoreWins.sort((a, b) => RANKS.indexOf(b.rank) - RANKS.indexOf(a.rank))[0]; return low(winningCards); }
    else { const nonScore = legal.filter(c => !isFace(c)); if (nonScore.length) return lowX(ctx, nonScore); }
  }
  if (trickNo >= 7 && winningCards.length) { const absoluteWins = winningCards.filter(c => isAbsoluteWinner(c, contract, trick, playedCards)); if (absoluteWins.length) return absoluteWins[0]; }
  if (!isTeamWinning && winningCards.length === 0) { const nonFaces = legal.filter(c => !isFace(c)); if (nonFaces.length) return lowX(ctx, nonFaces); }
  return lowX(ctx, legal);
}

// ==========================================
// 互換性ラッパー + エントリーポイント
// ==========================================

export function chooseDeputyCard(ctx) {
  const { contract } = ctx;
  if (!contract) return null;
  if (contract.suit === 'NT') return chooseNTDeputyPlay(ctx);
  return chooseColorDeputyPlay(ctx);
}

// ============================================================
// ★ chooseCardToPlay: 強化項目を統合
// 優先順位: A5(定跡) > A4(終盤全列挙) > MECE戦略
// ============================================================
export function chooseCardToPlay(ctx) {
  const { seat, contract, legal, hand } = ctx;
  if (!legal || !legal.length) return null;
  
  // 終局判定（既に勝敗確定している場合）
  const outcome = detectGameOutcome(ctx);
  if (outcome !== 'ongoing') {
    const fast = chooseCardAfterOutcome(ctx, outcome);
    if (fast) return fast;
  }
  
  // ★ A5: オープニングブック参照（序盤のみ）
  const bookCard = lookupOpeningBook(ctx);
  if (bookCard) return bookCard;
  
  // ★ A4: 終盤全列挙探索（残り手札が少ない場合）
  if (ctx.trickNo >= (10 - (ctx.params?.endgameTrickThreshold ?? 3))) {
    try {
      const endgameResult = enumerateEndgame(ctx, ctx.params?.endgameMaxCombinations ?? 100000);
      if (endgameResult && endgameResult.bestCard) {
        return endgameResult.bestCard;
      }
    } catch (e) { /* fallback */ }
  }
  
  // 通常のMECE戦略
  const isHiddenDeputy = !contract.solo && !contract.revealedCall && contract.call && hand.some(c => c.id === contract.call.id);
  if (contract.suit === 'NT') {
    if (isHiddenDeputy) return chooseNTDeputyPlay(ctx);
    if (seat === contract.nap) return ctx.trick.length === 0 ? chooseNTNapoleonLead(ctx) : chooseNTNapoleonFollow(ctx);
    if (!contract.solo && contract.revealedCall && seat === contract.deputy) return chooseNTDeputyPlay(ctx);
    return ctx.trick.length === 0 ? chooseNTAllianceLead(ctx) : chooseNTAllianceFollow(ctx);
  } else {
    if (isHiddenDeputy) return chooseColorDeputyPlay(ctx);
    if (seat === contract.nap) return ctx.trick.length === 0 ? chooseColorNapoleonLead(ctx) : chooseColorNapoleonFollow(ctx);
    if (!contract.solo && contract.revealedCall && seat === contract.deputy) return chooseColorDeputyPlay(ctx);
    return ctx.trick.length === 0 ? chooseColorAllianceLead(ctx) : chooseColorAllianceFollow(ctx);
  }
}

// ==========================================
// MCTS
// ==========================================

function determinizeState(ctx, rng = Math.random) {
  const unseen = [];
  for (const s of SUITS) for (const r of RANKS) unseen.push(s + r);
  const seen = new Set();
  (ctx.hand || []).forEach(c => seen.add(c.id));
  (ctx.playedCards || []).forEach(c => seen.add(c.id));
  (ctx.discardedKitty || []).forEach(c => seen.add(c.id));
  (ctx.trick || []).forEach(t => seen.add(t.card.id));
  const unseens = unseen.filter(id => !seen.has(id)).map(id => ({ suit: id[0], rank: id.slice(1), id }));
  const otherSeats = [0, 1, 2, 3, 4].filter(s => s !== ctx.seat);
  
  // ベイズ尤度（S1と同じ計算）
  const score = computeBayesianSuitLikelihood(ctx.seat, ctx.bidHistory, ctx.playedCards, ctx.voids, ctx.params);
  
  const handCounts = otherSeats.map(s => {
    const playedBySeat = (ctx.playedCards || []).filter(c => c.seat === s).length;
    const inTrick = ctx.trick.some(t => t.seat === s) ? 1 : 0;
    return Math.max(0, 10 - ctx.trickNo - inTrick - playedBySeat);
  });
  const MAX_ATTEMPTS = 100;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const pool = unseens.slice();
    const others = otherSeats.map(() => []);
    let success = true;
    for (let i = 0; i < otherSeats.length; i++) {
      const seat = otherSeats[i];
      const need = handCounts[i];
      for (let k = 0; k < need; k++) {
        if (pool.length === 0) { success = false; break; }
        const weights = pool.map(c => {
          const sc = score[seat]?.[c.suit];
          if (sc === -Infinity) return 0;
          return Math.exp(sc || 0);
        });
        const totalWeight = weights.reduce((a, b) => a + b, 0);
        if (totalWeight === 0) { const idx = Math.floor(rng() * pool.length); others[i].push(pool.splice(idx, 1)[0]); continue; }
        let r = rng() * totalWeight;
        let idx = -1;
        for (let j = 0; j < pool.length; j++) { r -= weights[j]; if (r <= 0) { idx = j; break; } }
        if (idx < 0) idx = pool.length - 1;
        others[i].push(pool.splice(idx, 1)[0]);
      }
      if (!success) break;
    }
    if (success && pool.length === 0) {
      const hands = [[], [], [], [], []];
      hands[ctx.seat] = ctx.hand.slice();
      otherSeats.forEach((seat, i) => { hands[seat] = others[i]; });
      return hands;
    }
  }
  const hands = [[], [], [], [], []];
  hands[ctx.seat] = ctx.hand.slice();
  const pool = unseens.slice();
  for (let i = 0; i < otherSeats.length; i++) {
    for (let k = 0; k < handCounts[i]; k++) {
      if (pool.length === 0) break;
      const idx = Math.floor(rng() * pool.length);
      hands[otherSeats[i]].push(pool.splice(idx, 1)[0]);
    }
  }
  return hands;
}

function simulateWithPolicy(state, mySeat, contract, params) {
  let active = state.active;
  let trick = state.trick.slice();
  let trickNo = state.trickNo;
  let hands = state.hands.map(h => h.slice());
  let points = state.points.slice();
  let voids = JSON.parse(JSON.stringify(state.voids || [{},{},{},{},{}]));
  const getLegal = (seat) => { const h = hands[seat]; if (!trick.length) return h; const ledSuit = trick[0].card.suit; const follow = h.filter(c => c.suit === ledSuit); return follow.length ? follow : h; };
  let loopSafety = 0;
  while (trickNo < 10) {
    loopSafety++;
    if (loopSafety > 100) break;
    if (trick.length < 5) {
      const legal = getLegal(active);
      if (!legal.length) break;
      let chosen = null;
      if (Math.random() < (params.rolloutPolicyWeight ?? 0.8)) {
        const playCtx = { seat: active, contract, legal, hand: hands[active], trick, trickNo, playedCards: state.playedCards || [], voids, params, isCurrentNapWinning: false, isRevealed: contract.revealedCall, lastSeat: trick.length === 4, points };
        chosen = chooseCardToPlay(playCtx);
      }
      if (!chosen) chosen = legal[Math.floor(Math.random() * legal.length)];
      hands[active] = hands[active].filter(c => c.id !== chosen.id);
      if (trick.length > 0) { const ledSuit = trick[0].card.suit; if (chosen.suit !== ledSuit) { if (!voids[active]) voids[active] = {}; voids[active][ledSuit] = true; } }
      trick.push({ seat: active, card: chosen });
      if (trick.length === 5) {
        const wEntry = winningEntry(contract, trickNo, trick);
        const w = wEntry.seat;
        const taken = trick.filter(e => FACE.includes(e.card.rank)).length;
        points[w] += taken;
        active = w;
        trick = [];
        trickNo++;
        const napPoints = points[contract.nap] + (contract.solo ? 0 : points[contract.deputy]);
        const allyPoints = points.reduce((sum, p, i) => sum + (i !== contract.nap && (contract.solo || i !== contract.deputy) ? p : 0), 0);
        const remaining = 10 - trickNo;
        if (napPoints >= contract.num && (contract.num === 20 || allyPoints >= 1)) break;
        if (allyPoints > 20 - contract.num) break;
        if (napPoints + remaining * 5 < contract.num) break;
      } else { active = (active + 1) % 5; }
    }
  }
  const nap = contract.nap, deputy = contract.deputy, isSolo = contract.solo, num = contract.num;
  const napPoints = points[nap] + (isSolo ? 0 : points[deputy]);
  const allyPoints = points.reduce((sum, p, i) => sum + (i !== nap && (isSolo || i !== deputy) ? p : 0), 0);
  const made = napPoints >= num && (num === 20 || napPoints < 20);
  const myTeamIsNap = mySeat === nap || (!isSolo && mySeat === deputy);
  let score = 0;
  if (myTeamIsNap) {
    if (made) {
      score = 1.0;
      const overkill = napPoints - num;
      if (overkill > 0 && num < 20) { const allyGap = 20 - allyPoints; if (allyGap <= 2) score -= overkill * 0.01; else score -= overkill * 0.05; }
      if (num < 20 && napPoints === num) score += 0.1;
    } else {
      score = 0.0;
      const gap = num - napPoints;
      score += Math.max(0, 0.5 - gap * 0.1);
      score += Math.min(0.2, napPoints * 0.02);
    }
  } else {
    if (!made) {
      score = 1.0;
      score += Math.max(0, (num - napPoints) * 0.02);
      score += Math.min(0.2, points[mySeat] * 0.05);
    } else {
      const overshoot = Math.max(0, napPoints - num);
      score = Math.max(0, 0.5 - overshoot * 0.05);
    }
  }
  return Math.max(0, Math.min(1.5, score));
}

// ============================================================
// ★ C13: MCTS RAVE
// 各手の N/W に加えて、N_rave/W_rave（浅い探索での統計）を保持
// ============================================================
export function getMCTSStats(ctx) {
  const legal = ctx.legal;
  const N = {}, W = {}, Nrave = {}, Wrave = {};
  legal.forEach(c => { N[c.id] = 0; W[c.id] = 0; Nrave[c.id] = 0; Wrave[c.id] = 0; });
  
  if (ctx.experience && ctx.experience.stateCache) {
    const exp = ctx.experience.stateCache;
    if (exp && exp.card_win_rates) {
      try {
        const rates = JSON.parse(exp.card_win_rates);
        const sampleW = Math.min(20, exp.samples);
        for (const c of legal) { if (rates[c.id] !== undefined) { N[c.id] = sampleW; W[c.id] = rates[c.id] * sampleW; } }
      } catch (e) {}
    }
  }
  if (!legal || legal.length <= 1) return { N, W, iterations: 0, Nrave, Wrave };
  
  const params = ctx.params || defaultStrategy();
  const cParam = params.mctsExploration || 1.414;
  const raveBias = params.mctsRaveBias ?? 100;
  const useRave = params.mctsRave ?? true;
  const startTime = Date.now();
  const maxTimeMs = params.maxThinkTimeMs || 3000;
  let iterations = 0;
  while (iterations < 100000) {
    if (Date.now() - startTime > maxTimeMs) break;
    let bestCard = null;
    let bestUcb = -Infinity;
    for (const card of legal) {
      if (N[card.id] === 0) { bestCard = card; break; }
      const exploit = W[card.id] / N[card.id];
      const explore = cParam * Math.sqrt(Math.log(iterations + 1) / N[card.id]);
      let ucb = exploit + explore;
      
      // ★ RAVE 項の追加
      if (useRave && Nrave[card.id] > 0) {
        const raveRate = Wrave[card.id] / Nrave[card.id];
        const raveWeight = raveBias / (raveBias + N[card.id]);
        ucb = (1 - raveWeight) * ucb + raveWeight * raveRate;
      }
      
      if (ucb > bestUcb) { bestUcb = ucb; bestCard = card; }
    }
    if (!bestCard) bestCard = legal[0];
    
    const hands = determinizeState(ctx);
    let trick = ctx.trick.map(t => ({ seat: t.seat, card: t.card }));
    hands[ctx.seat] = hands[ctx.seat].filter(c => c.id !== bestCard.id);
    trick.push({ seat: ctx.seat, card: bestCard });
    let active = (ctx.seat + 1) % 5;
    let trickNo = ctx.trickNo;
    const points = ctx.points ? ctx.points.slice() : [0, 0, 0, 0, 0];
    const win = simulateWithPolicy({ hands, trick, trickNo, active, points, voids: ctx.voids, playedCards: ctx.playedCards }, ctx.seat, ctx.contract, params);
    
    N[bestCard.id]++;
    W[bestCard.id] += win;
    
    // ★ RAVE 更新（全合法手に同じ結果を反映）
    if (useRave) {
      for (const c of legal) {
        Nrave[c.id]++;
        Wrave[c.id] += win;
      }
    }
    iterations++;
  }
  return { N, W, iterations, Nrave, Wrave };
}

export function chooseCardWithMCTS(ctx) {
  const legal = ctx.legal;
  if (!legal || legal.length <= 1) return legal[0];
  const isAllySide = ctx.seat !== ctx.contract.nap
    && (ctx.contract.solo || ctx.seat !== ctx.contract.deputy || !ctx.contract.revealedCall);
  if (isAllySide && isSameTwoTrap(ctx)) {
    const safe = chooseSafeFollowForSameTwo(ctx);
    if (safe) return safe;
  }
  const isNapSide = ctx.seat === ctx.contract.nap || (!ctx.contract.solo && ctx.contract.revealedCall && ctx.seat === ctx.contract.deputy);
  if (isNapSide) ctx.params = { ...ctx.params, maxThinkTimeMs: 4000 };
  if (ctx.trickNo > 8 && legal.length <= 2) return chooseCardToPlay(ctx);
  
  // ★ A4: 終盤は全列挙を優先
  if (ctx.trickNo >= (10 - (ctx.params?.endgameTrickThreshold ?? 3))) {
    try {
      const endgameResult = enumerateEndgame(ctx, ctx.params?.endgameMaxCombinations ?? 100000);
      if (endgameResult && endgameResult.bestCard) return endgameResult.bestCard;
    } catch (e) {}
  }
  
  const { N, W, iterations } = getMCTSStats(ctx);
  if (iterations < 80 && !ctx.experience?.stateCache) return chooseCardToPlay(ctx);
  let bestCard = legal[0];
  let bestWinRate = -1;
  let bestN = 0;
  for (const c of legal) {
    if (N[c.id] < 5) continue;
    const winRate = W[c.id] / N[c.id];
    if (winRate > bestWinRate) { bestWinRate = winRate; bestCard = c; bestN = N[c.id]; }
  }
  if (bestWinRate < 0) return chooseCardToPlay(ctx);
  const heuristicBest = chooseCardToPlay(ctx);
  if (heuristicBest && heuristicBest.id === bestCard.id) return bestCard;
  // ★ 予測と実績の一致率向上: サンプル数少ない場合はヒューリスティック優先
  if (bestN < 30) return heuristicBest || bestCard;
  return bestCard;
}

// ==========================================
// オラクルB
// ==========================================

function hashSeed(...args) {
  let h = 2166136261 >>> 0;
  const str = args.join(':');
  for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; }
  return h >>> 0;
}

function mulberry32(seed) {
  let s = seed | 0;
  return function () {
    s = (s + 0x6D2B79F5) | 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function simulateWithPolicyCompleteInfo(state, mySeat, contract, params, rng) {
  let active = state.active;
  let trick = state.trick.slice();
  let trickNo = state.trickNo;
  let hands = state.hands.map(h => h.slice());
  let points = state.points.slice();
  let voids = JSON.parse(JSON.stringify(state.voids || [{},{},{},{},{}]));
  const getLegal = (seat) => {
    const h = hands[seat];
    if (!trick.length) return h;
    const ledSuit = trick[0].card.suit;
    const follow = h.filter(c => c.suit === ledSuit);
    return follow.length ? follow : h;
  };
  let loopSafety = 0;
  while (trickNo < 10) {
    loopSafety++;
    if (loopSafety > 100) break;
    if (trick.length < 5) {
      const legal = getLegal(active);
      if (!legal.length) break;
      const currentWinner = trick.length ? winningEntry(contract, trickNo, trick) : null;
      const isTeamNap = active === contract.nap || (!contract.solo && active === contract.deputy);
      const winnerIsTeamNap = currentWinner ? (currentWinner.seat === contract.nap || (!contract.solo && currentWinner.seat === contract.deputy)) : false;
      let chosen = null;
      if (currentWinner && isTeamNap === winnerIsTeamNap) {
        const feedCards = legal.filter(c => ['10', 'J', 'Q'].includes(c.rank) && !isRoleJ(c, contract));
        if (feedCards.length) chosen = feedCards[0];
      }
      if (!chosen) {
        const winningCards = legal.filter(c => winningEntry(contract, trickNo, [...trick, { seat: active, card: c }])?.seat === active);
        if (winningCards.length) {
          chosen = winningCards.reduce((best, c) => cardPower(contract, trickNo, c, trick) < cardPower(contract, trickNo, best, trick) ? c : best);
        } else {
          const nonFaces = legal.filter(c => !['10', 'J', 'Q', 'K', 'A'].includes(c.rank));
          chosen = (nonFaces.length ? nonFaces : legal).reduce((best, c) => cardPower(contract, trickNo, c, trick) < cardPower(contract, trickNo, best, trick) ? c : best);
        }
      }
      if (!chosen) chosen = legal[Math.floor(rng() * legal.length)];
      hands[active] = hands[active].filter(c => c.id !== chosen.id);
      if (trick.length > 0) {
        const ledSuit = trick[0].card.suit;
        if (chosen.suit !== ledSuit) { if (!voids[active]) voids[active] = {}; voids[active][ledSuit] = true; }
      }
      trick.push({ seat: active, card: chosen });
      if (trick.length === 5) {
        const wEntry = winningEntry(contract, trickNo, trick);
        const w = wEntry.seat;
        const taken = trick.filter(e => FACE.includes(e.card.rank)).length;
        points[w] += taken;
        active = w;
        trick = [];
        trickNo++;
        const napPoints = points[contract.nap] + (contract.solo ? 0 : points[contract.deputy]);
        const allyPoints = points.reduce((sum, p, i) => sum + (i !== contract.nap && (contract.solo || i !== contract.deputy) ? p : 0), 0);
        const remaining = 10 - trickNo;
        if (napPoints >= contract.num && (contract.num === 20 || allyPoints >= 1)) break;
        if (allyPoints > 20 - contract.num) break;
        if (napPoints + remaining * 5 < contract.num) break;
      } else { active = (active + 1) % 5; }
    }
  }
  const nap = contract.nap, deputy = contract.deputy, isSolo = contract.solo, num = contract.num;
  const napPoints = points[nap] + (isSolo ? 0 : points[deputy]);
  const allyPoints = points.reduce((sum, p, i) => sum + (i !== nap && (isSolo || i !== deputy) ? p : 0), 0);
  const made = napPoints >= num && (num === 20 || napPoints < 20);
  const myTeamIsNap = mySeat === nap || (!isSolo && mySeat === deputy);
  let score = 0;
  if (myTeamIsNap) {
    if (made) { score = 1.0; const o = napPoints - num; if (o > 0 && num < 20) { const ag = 20 - allyPoints; if (ag <= 2) score -= o * 0.01; else score -= o * 0.05; } if (num < 20 && napPoints === num) score += 0.1; }
    else { score = 0.0; const gap = num - napPoints; score += Math.max(0, 0.5 - gap * 0.1); score += Math.min(0.2, napPoints * 0.02); }
  } else {
    if (!made) { score = 1.0; score += Math.max(0, (num - napPoints) * 0.02); score += Math.min(0.2, points[mySeat] * 0.05); }
    else { score = Math.max(0, 0.5 - (napPoints - num) * 0.05); }
  }
  return Math.max(0, Math.min(1.5, score));
}

function oracleMCTS(ctx, hands, timeMs, rng, params) {
  const legal = ctx.legal;
  const N = {}, W = {};
  legal.forEach(c => { N[c.id] = 0; W[c.id] = 0; });
  const cParam = 1.414;
  const startTime = Date.now();
  const maxSims = 2000;
  let iterations = 0;
  while (Date.now() - startTime < timeMs && iterations < maxSims) {
    let bestCard = null;
    let bestUcb = -Infinity;
    for (const card of legal) {
      if (N[card.id] === 0) { bestCard = card; break; }
      const ucb = W[card.id] / N[card.id] + cParam * Math.sqrt(Math.log(iterations + 1) / N[card.id]);
      if (ucb > bestUcb) { bestUcb = ucb; bestCard = card; }
    }
    if (!bestCard) bestCard = legal[0];
    const simHands = hands.map(h => h.slice());
    simHands[ctx.seat] = simHands[ctx.seat].filter(c => c.id !== bestCard.id);
    const simTrick = ctx.trick.map(t => ({ seat: t.seat, card: t.card }));
    simTrick.push({ seat: ctx.seat, card: bestCard });
    const simActive = (ctx.seat + 1) % 5;
    const win = simulateWithPolicyCompleteInfo(
      { hands: simHands, trick: simTrick, trickNo: ctx.trickNo, active: simActive, points: ctx.points ? ctx.points.slice() : [0,0,0,0,0], voids: ctx.voids, playedCards: ctx.playedCards },
      ctx.seat, ctx.contract, params, rng
    );
    N[bestCard.id]++;
    W[bestCard.id] += win;
    iterations++;
  }
  const winRates = {};
  for (const c of legal) winRates[c.id] = N[c.id] > 0 ? W[c.id] / N[c.id] : 0;
  return winRates;
}

export function oracleB(ctx, matchId, round, trickNo, decisionIndex, params = {}) {
  const ORACLE_SAMPLES = params.oracleSamples ?? 200;
  const ORACLE_MCTS_TIME_MS = params.oracleMctsTimeMs ?? 200;
  const legal = ctx.legal;
  if (!legal || legal.length <= 1) {
    return { bestCard: legal[0], evMap: legal.reduce((m, c) => ({ ...m, [c.id]: 1.0 }), {}), votes: {} };
  }
  const EV = {};
  const votes = {};
  legal.forEach(c => { EV[c.id] = 0; votes[c.id] = 0; });
  for (let i = 0; i < ORACLE_SAMPLES; i++) {
    const seed = hashSeed(matchId || 'm', round || 0, trickNo || 0, decisionIndex || 0, i);
    const rng = mulberry32(seed);
    const hands = determinizeState(ctx, rng);
    const winRates = oracleMCTS(ctx, hands, ORACLE_MCTS_TIME_MS, rng, params);
    let bestId = legal[0].id;
    let bestRate = -1;
    for (const c of legal) {
      EV[c.id] += winRates[c.id];
      if (winRates[c.id] > bestRate) { bestRate = winRates[c.id]; bestId = c.id; }
    }
    votes[bestId]++;
  }
  for (const c of legal) EV[c.id] /= ORACLE_SAMPLES;
  let bestCard = legal[0];
  let bestEv = -1;
  for (const c of legal) { if (EV[c.id] > bestEv) { bestEv = EV[c.id]; bestCard = c; } }
  const tied = legal.filter(c => Math.abs(EV[c.id] - bestEv) < 1e-9);
  if (tied.length > 1) bestCard = tied.reduce((best, c) => votes[c.id] > votes[best.id] ? c : best, tied[0]);
  return { bestCard, evMap: EV, votes };
}

// ==========================================
// 上がり宣言
// ==========================================

export function canDeclareWin(ctx) {
  const { hand, contract, playedCards, discardedKitty, voids, trick, seat, players, points, allianceKittyPoints } = ctx;
  if (!hand || hand.length === 0) return false;
  if (trick && trick.length > 0) return false;
  const seen = new Set();
  hand.forEach(c => seen.add(c.id));
  (playedCards || []).forEach(c => seen.add(c.id));
  (discardedKitty || []).forEach(c => seen.add(c.id));
  (trick || []).forEach(t => seen.add(t.card.id));
  const unseen = [];
  for (const s of SUITS) for (const r of RANKS) { const id = s + r; if (!seen.has(id)) unseen.push({ suit: s, rank: r, id }); }
  const otherSeats = [0, 1, 2, 3, 4].filter(s => s !== seat);
  const oppHandCounts = otherSeats.map(s => {
    if (players && players[s] && players[s].handCount !== undefined) return players[s].handCount;
    const played = (playedCards || []).filter(c => c.seat === s).length;
    const inTrick = (trick || []).some(t => t.seat === s) ? 1 : 0;
    return Math.max(0, 10 - played - inTrick);
  });
  for (const c of hand) {
    if (c.id === '♠A' && unseen.some(u => u.id === '♥Q')) return false;
    if (c.id === '♥Q' && unseen.some(u => u.id === '♠A')) return false;
    if (contract.suit !== 'NT') {
      if (c.rank === 'J' && c.suit === contract.suit) { if (unseen.some(u => u.id === '♠A')) return false; }
      if (c.rank === 'J' && isSameColorSuit(c.suit, contract.suit)) {
        if (unseen.some(u => u.id === '♠A')) return false;
        if (unseen.some(u => u.rank === 'J' && u.suit === contract.suit)) return false;
      }
    }
    if (c.rank !== '2') {
      const suit2 = c.suit + '2';
      if (unseen.some(u => u.id === suit2)) {
        let canSameTwo = true;
        for (let i = 0; i < otherSeats.length; i++) {
          const s = otherSeats[i];
          if (oppHandCounts[i] === 0) continue;
          if (voids && voids[s] && voids[s][c.suit]) { canSameTwo = false; break; }
        }
        if (canSameTwo) return false;
      }
    }
    for (const u of unseen) {
      if (u.rank === '2' && u.suit === c.suit && c.rank !== '2') continue;
      const powerC = cardPower(contract, 1, c, [{ seat: 0, card: c }]);
      const powerU = cardPower(contract, 1, u, [{ seat: 1, card: u }]);
      if (powerU > powerC) return false;
    }
  }
  const isNapSide = seat === contract.nap || (!contract.solo && seat === contract.deputy);
  const currentNapPts = points ? (points[contract.nap] || 0) + (contract.solo ? 0 : (points[contract.deputy] || 0)) : 0;
  const currentAlliancePts = points ? points.reduce((sum, p, i) => sum + (i !== contract.nap && (contract.solo || i !== contract.deputy) ? p : 0), 0) + (allianceKittyPoints || 0) : 0;
  const remainingPoints = unseen.filter(c => ['10','J','Q','K','A'].includes(c.rank)).length;
  if (isNapSide) {
    const finalNapPts = currentNapPts + remainingPoints;
    if (finalNapPts === 20 && contract.num < 20) return false;
    if (!(finalNapPts >= contract.num && (contract.num === 20 || finalNapPts < 20))) return false;
  } else {
    const finalAlliancePts = currentAlliancePts + remainingPoints;
    if (!(finalAlliancePts > 20 - contract.num)) return false;
  }
  return true;
}

// ==========================================
// 競りロジック: N-Score / D-Score / D-Points
// ==========================================

export function computeNScore(hand, trump, params = defaultStrategy()) {
  if (!Array.isArray(hand) || !hand.length) return 0;
  let expectedWins = 0;
  try { expectedWins = evaluateBidPlan(hand, trump, params, [], 0, [], [], [{},{},{},{},{}]).expectedWins || 0; }
  catch (e) { expectedWins = handStrength(hand) * 0.8; }
  const roles = getRoleCards(hand, trump);
  const sideAces = hand.filter(c => c.suit !== trump && c.rank === 'A' && c.id !== '♠A').length;
  const trumpCount = trump !== 'NT' ? hand.filter(c => c.suit === trump).length : 0;
  let runBonus = 0;
  for (const suit of SUITS) {
    if (suit === trump) continue;
    const myCards = hand.filter(c => c.suit === suit).sort((a, b) => RANKS.indexOf(b.rank) - RANKS.indexOf(a.rank));
    if (myCards.length < 3) continue;
    let consecutive = 0;
    for (let i = 0; i < myCards.length; i++) { if (myCards[i].rank === RANKS[RANKS.length - 1 - i]) consecutive++; else break; }
    if (consecutive >= 5) runBonus = Math.max(runBonus, 6.0);
    else if (consecutive >= 4) runBonus = Math.max(runBonus, 4.0);
    else if (consecutive >= 3) runBonus = Math.max(runBonus, 2.0);
  }
  return 2.0 * expectedWins + 2.5 * roles.count + 1.5 * sideAces + 0.5 * trumpCount + 1.0 * runBonus;
}

export function computeDScore(hand, declaredSuit, params = defaultStrategy()) {
  if (!Array.isArray(hand) || !hand.length) return 0;
  let dScore = 0;
  const hasMighty = hand.some(c => c.id === '♠A');
  const hasTrumpJ = declaredSuit !== 'NT' && hand.some(c => c.rank === 'J' && c.suit === declaredSuit);
  const sameColor = declaredSuit !== 'NT' ? sameColorSuitOf(declaredSuit) : null;
  const hasSameColorJ = sameColor && hand.some(c => c.rank === 'J' && c.suit === sameColor);
  if (hasMighty) dScore += 4.0;
  if (hasTrumpJ) dScore += 3.5;
  if (hasSameColorJ) dScore += 3.0;
  const sideAces = hand.filter(c => c.suit !== declaredSuit && c.rank === 'A' && c.id !== '♠A').length;
  dScore += sideAces * 1.5;
  const sideTwos = hand.filter(c => c.suit !== declaredSuit && c.rank === '2').length;
  dScore += sideTwos * 1.0;
  const declaredSuitCount = hand.filter(c => c.suit === declaredSuit).length;
  if (declaredSuit === 'NT') { }
  else if (declaredSuitCount === 0) dScore += 3.0;
  else if (declaredSuitCount === 1) dScore += 2.0;
  else if (declaredSuitCount === 2) dScore += 1.0;
  for (const suit of SUITS) {
    if (suit === declaredSuit) continue;
    const suitCards = hand.filter(c => c.suit === suit);
    const hasAce = suitCards.some(c => c.rank === 'A');
    const hasKing = suitCards.some(c => c.rank === 'K');
    if (hasAce && hasKing) dScore += 3.0;
    else if (hasAce) dScore += 1.5;
    else if (hasKing) dScore += 0.5;
  }
  return dScore;
}

export function computeDPoints(hand, declaredSuit, params = defaultStrategy()) {
  if (!Array.isArray(hand) || !hand.length) return 0;
  let dPoints = 0;
  const hasMighty = hand.some(c => c.id === '♠A');
  const hasTrumpJ = declaredSuit !== 'NT' && hand.some(c => c.rank === 'J' && c.suit === declaredSuit);
  const sameColor = declaredSuit !== 'NT' ? sameColorSuitOf(declaredSuit) : null;
  const hasSameColorJ = sameColor && hand.some(c => c.rank === 'J' && c.suit === sameColor);
  if (hasMighty) dPoints += 2.0;
  if (hasTrumpJ) dPoints += 2.0;
  if (hasSameColorJ) dPoints += 2.0;
  const sideAces = hand.filter(c => c.suit !== declaredSuit && c.rank === 'A' && c.id !== '♠A').length;
  dPoints += sideAces * 1.0;
  const trumpCards = declaredSuit !== 'NT' ? hand.filter(c => c.suit === declaredSuit) : [];
  const effectiveTrumps = trumpCards.filter(c => !['A', 'K', 'J'].includes(c.rank)).length;
  dPoints += effectiveTrumps * 0.8;
  const declaredSuitCount = hand.filter(c => c.suit === declaredSuit).length;
  if (declaredSuit === 'NT') { }
  else if (declaredSuitCount === 0) dPoints += 1.0;
  else if (declaredSuitCount === 1) dPoints += 0.7;
  else if (declaredSuitCount === 2) dPoints += 0.4;
  const midCards = hand.filter(c => ['10', 'Q'].includes(c.rank) && !isRoleJ(c, { suit: declaredSuit }));
  dPoints += midCards.length * 0.3;
  for (const suit of SUITS) {
    if (suit === declaredSuit) continue;
    const suitCards = hand.filter(c => c.suit === suit);
    const hasAce = suitCards.some(c => c.rank === 'A');
    const hasKing = suitCards.some(c => c.rank === 'K');
    const hasQueen = suitCards.some(c => c.rank === 'Q');
    if (hasAce && hasKing) dPoints += 0.5;
    if (hasAce && hasKing && hasQueen) dPoints += 0.5;
  }
  return dPoints;
}

export function determineRole(hand, params = defaultStrategy()) {
  const suitCandidates = SUITS.concat(['NT']).map(suit => ({ suit, nScore: computeNScore(hand, suit, params) }));
  const bestSuit = suitCandidates.sort((a, b) => b.nScore - a.nScore)[0];
  const nScore = bestSuit.nScore;
  const dScores = SUITS.concat(['NT']).map(s => computeDScore(hand, s, params));
  const dPointsList = SUITS.concat(['NT']).map(s => computeDPoints(hand, s, params));
  const maxDScore = Math.max(...dScores);
  const maxDPoints = Math.max(...dPointsList);
  const t1 = params.napRoleThreshold1 ?? 22;
  const t2 = params.napRoleThreshold2 ?? 17;
  const t3 = params.napRoleThreshold3 ?? 13;
  const dt1 = params.deputyRoleThreshold1 ?? 12;
  const dt2 = params.deputyRoleThreshold2 ?? 8;
  const dt3 = params.deputyRoleThreshold3 ?? 5;
  if (nScore >= t1) return { role: 'NAP', nScore, dScore: maxDScore, dPoints: maxDPoints, bestSuit: bestSuit.suit, reason: '3役級' };
  if (nScore >= t2 && maxDScore < dt2) return { role: 'NAP', nScore, dScore: maxDScore, dPoints: maxDPoints, bestSuit: bestSuit.suit, reason: '2役級' };
  if (nScore >= t3 && maxDScore < dt3) return { role: 'NAP', nScore, dScore: maxDScore, dPoints: maxDPoints, bestSuit: bestSuit.suit, reason: '1役級' };
  if (maxDScore >= dt1) return { role: 'DEPUTY', nScore, dScore: maxDScore, dPoints: maxDPoints, reason: '指名必須級' };
  if (maxDScore >= dt2) return { role: 'DEPUTY', nScore, dScore: maxDScore, dPoints: maxDPoints, reason: '副官十分' };
  if (maxDScore >= dt3 && nScore < t3) return { role: 'DEPUTY', nScore, dScore: maxDScore, dPoints: maxDPoints, reason: '副官候補' };
  return { role: 'ALLIANCE', nScore, dScore: maxDScore, dPoints: maxDPoints, reason: '不適' };
}

export function inferIntentFromBid(prevBid, newBid, params = defaultStrategy()) {
  if (!prevBid || !newBid || newBid.num < 13) return { intent: 'UNKNOWN', strength: 0 };
  if (prevBid.suit === newBid.suit && newBid.num > prevBid.num) return { intent: 'S1', strength: params.sameSuitRaiseBonus ?? 1.0, suit: newBid.suit, num: newBid.num, reason: '同スート＋枚数上げ' };
  if (prevBid.suit !== newBid.suit && isSameColorSuit(prevBid.suit, newBid.suit)) {
    if (newBid.num > prevBid.num) return { intent: 'S3', strength: params.sameColorSupportBonus ?? 0.8, suit: newBid.suit, num: newBid.num, reason: '同色＋枚数上げ' };
    return { intent: 'S2', strength: params.sameColorSameBidBonus ?? 0.5, suit: newBid.suit, num: newBid.num, reason: '同色同枚数' };
  }
  if (prevBid.suit !== newBid.suit && !isSameColorSuit(prevBid.suit, newBid.suit)) {
    if (newBid.num > prevBid.num) return { intent: 'C2', strength: params.crossColorCompeteBonus ?? 0.3, suit: newBid.suit, num: newBid.num, reason: '非同色＋枚数上げ' };
    return { intent: 'C1', strength: params.crossColorCompeteBonus ?? 0.3, suit: newBid.suit, num: newBid.num, reason: '非同色同枚数' };
  }
  if (prevBid.suit === 'NT' && newBid.suit === 'NT' && newBid.num > prevBid.num) return { intent: 'S4', strength: params.sameSuitRaiseBonus ?? 1.0, suit: 'NT', num: newBid.num, reason: 'NT＋枚数上げ' };
  return { intent: 'UNKNOWN', strength: 0 };
}

export function estimateDeputyDPoints(receivedSignals) {
  if (!Array.isArray(receivedSignals) || !receivedSignals.length) return 0;
  const latest = receivedSignals[receivedSignals.length - 1];
  const baseDPoints = { 'S1': 8, 'S2': 7, 'S3': 10, 'S4': 9, 'C1': 2, 'C2': 3 };
  return baseDPoints[latest.intent] || 0;
}

export function computeSupportLimit(hand, napSuit, params = defaultStrategy()) {
  let expectedWins = 0;
  try { expectedWins = evaluateBidPlan(hand, napSuit, params, [], 0, [], [], [{},{},{},{},{}]).expectedWins; }
  catch (e) { expectedWins = handStrength(hand); }
  const supportPower = Math.floor(expectedWins * 0.7);
  return Math.min(20, Math.max(13, 12 + supportPower));
}

// ==========================================
// 競りEV精緻化モジュール
// ==========================================

function sampleVirtualHand(params) {
  const deck = [];
  for (const s of SUITS) for (const r of RANKS) deck.push({ suit: s, rank: r, id: s + r });
  for (let i = deck.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [deck[i], deck[j]] = [deck[j], deck[i]];
  }
  return deck.slice(0, 10);
}

function archetypeRank(arch) {
  return { 'ROLE_OVERWHELM': 6, 'TRUMP_DOMINANT': 5, 'SIDE_ACE_HEAVY': 4, 'RUN_SUIT': 3, 'BALANCED': 2, 'WEAK': 1 }[arch] || 0;
}

function predictOpponentMaxBidFromHand(hand, params) {
  let bestArch = 'WEAK';
  let bestSuit = '♠';
  for (const suit of SUITS) {
    const arch = classifyHandArchetype(hand, suit, params);
    if (archetypeRank(arch) > archetypeRank(bestArch)) { bestArch = arch; bestSuit = suit; }
  }
  const ranges = { ROLE_OVERWHELM: [17, 20], TRUMP_DOMINANT: [15, 19], SIDE_ACE_HEAVY: [14, 17], RUN_SUIT: [14, 16], BALANCED: [13, 15], WEAK: [0, 13] };
  const [min, max] = ranges[bestArch] || [13, 15];
  const baseStr = handStrength(hand);
  const ratio = Math.min(1, Math.max(0, (baseStr - 3) / 5));
  const predicted = Math.min(20, Math.max(13, Math.round(min + (max - min) * ratio)));
  return { maxBid: predicted, suit: bestSuit };
}

function estimateOpponentMaxBids(mySeat, bidHistory, currentHigh, params, nSamples = 30) {
  const opponents = [0,1,2,3,4].filter(s => s !== mySeat);
  const results = {};
  for (const oppSeat of opponents) {
    const theirBids = (bidHistory || []).filter(b => b.seat === oppSeat && b.num >= 13);
    if (theirBids.length > 0) {
      const knownMax = Math.max(...theirBids.map(b => b.num));
      results[oppSeat] = { expectedMaxBid: knownMax + 1, p90MaxBid: Math.min(20, knownMax + 2), p10MaxBid: knownMax, knownMaxBid: knownMax, confident: true };
    } else {
      const samples = [];
      for (let i = 0; i < nSamples; i++) {
        const virtualHand = sampleVirtualHand(params);
        const pred = predictOpponentMaxBidFromHand(virtualHand, params);
        samples.push(pred.maxBid);
      }
      samples.sort((a, b) => a - b);
      results[oppSeat] = { expectedMaxBid: samples[Math.floor(nSamples * 0.5)], p90MaxBid: samples[Math.min(nSamples - 1, Math.floor(nSamples * 0.9))], p10MaxBid: samples[Math.floor(nSamples * 0.1)], knownMaxBid: 13, confident: false };
    }
  }
  return results;
}

function estimateAuctionWinProb(myBid, oppMaxBids, params) {
  let pWin = 1;
  for (const oppSeat in oppMaxBids) {
    const opp = oppMaxBids[oppSeat];
    if (opp.p90MaxBid > myBid) {
      const raiseProb = Math.min(1, (opp.p90MaxBid - myBid) / 3) * 0.7;
      pWin *= (1 - raiseProb);
    }
  }
  return Math.max(0.05, pWin);
}

function estimateOpponentMakeProb(myBid, oppMaxBids, params) {
  let expectedOppBid = myBid + 1;
  for (const oppSeat in oppMaxBids) {
    const opp = oppMaxBids[oppSeat];
    if (opp.expectedMaxBid > myBid) expectedOppBid = Math.max(expectedOppBid, opp.expectedMaxBid);
  }
  const baseP = 0.55 - (expectedOppBid - 13) * 0.05;
  return Math.min(0.95, Math.max(0.15, baseP));
}

function estimatePDeputyIfLose(myHand, mySeat, oppMaxBids, params) {
  const hasMighty = myHand.some(c => c.id === '♠A');
  const allJ = SUITS.filter(s => myHand.some(c => c.rank === 'J' && c.suit === s));
  const sideAces = myHand.filter(c => c.suit !== '♠' && c.rank === 'A' && c.id !== '♠A').length;
  let pDeputy = 0.10;
  if (hasMighty) pDeputy += 0.30;
  if (allJ.length >= 2) pDeputy += 0.15;
  else if (allJ.length === 1) pDeputy += 0.08;
  if (sideAces >= 2) pDeputy += 0.10;
  return Math.min(0.65, pDeputy);
}

function computeBidEVFull(bid, suit, pMake, oppMaxBids, myHand, mySeat, params) {
  const unit = bid - 12;
  const pWin = estimateAuctionWinProb(bid, oppMaxBids, params);
  const napEV = 2 * unit * (2 * pMake - 1);
  const oppPMake = estimateOpponentMakeProb(bid, oppMaxBids, params);
  const pDeputy = estimatePDeputyIfLose(myHand, mySeat, oppMaxBids, params);
  const deputyEV = unit * (2 * oppPMake - 1);
  const allianceEV = -unit * (2 * oppPMake - 1);
  const loseEV = pDeputy * deputyEV + (1 - pDeputy) * allianceEV;
  return pWin * napEV + (1 - pWin) * loseEV;
}

function computePassEV(currentHigh, oppMaxBids, myHand, mySeat, params) {
  if (!currentHigh || currentHigh.num < 13) return -0.3;
  const unit = currentHigh.num - 12;
  const oppPMake = estimateOpponentMakeProb(currentHigh.num, oppMaxBids, params);
  const pDeputy = estimatePDeputyIfLose(myHand, mySeat, oppMaxBids, params);
  const deputyEV = unit * (2 * oppPMake - 1);
  const allianceEV = -unit * (2 * oppPMake - 1);
  return pDeputy * deputyEV + (1 - pDeputy) * allianceEV;
}

export function evaluateBidOptionsPrecise(hand, currentHigh, params, bidHistory, mySeat, openKitty, playedCards, voids, signals, matchScores, round) {
  const currentHighNum = currentHigh?.num ?? 12;
  const minViable = Math.max(13, currentHighNum + 1);
  const suitScores = SUITS.concat(['NT']).map(suit => ({
    suit,
    score: suit === 'NT' ? ntHandStrength(hand, params) : colorStrength(hand, suit, params)
  })).sort((a, b) => b.score - a.score);
  const topSuits = suitScores.slice(0, 3).map(x => x.suit);
  const suitPIMC = {};
  for (const suit of topSuits) {
    try { suitPIMC[suit] = evaluateBidPlan(hand, suit, params, bidHistory, mySeat, openKitty, playedCards, voids); }
    catch (e) { console.warn('[EV] PIMC failed for', suit, e?.message); }
  }
  const oppMaxBids = estimateOpponentMaxBids(mySeat, bidHistory, currentHigh, params);
  const options = [];
  for (const suit of topSuits) {
    const pimc = suitPIMC[suit];
    if (!pimc) continue;
    for (let bid = minViable; bid <= 20; bid++) {
      const pMake = pimc.pMake[bid] || 0;
      if (pMake < 0.08) continue;
      const ev = computeBidEVFull(bid, suit, pMake, oppMaxBids, hand, mySeat, params);
      const pWin = estimateAuctionWinProb(bid, oppMaxBids, params);
      options.push({ bid, suit, ev, pMake, pWin, pimc });
    }
  }
  const passEV = computePassEV(currentHigh, oppMaxBids, hand, mySeat, params);
  options.sort((a, b) => b.ev - a.ev);
  return { bestOption: options[0] || null, options, passEV, oppMaxBids, suitPIMC, topSuits };
}

// ============================================================
// decideNextBid: EV精緻化 + 多重サポート検知 + 初期bid最適化
// ============================================================
export function decideNextBid(hand, currentHigh, role, params = defaultStrategy(), signals = [], context = {}) {
  const { bidHistory = [], mySeat = 0, openKitty = [], playedCards = [], voids = [{},{},{},{},{}], matchScores = null, round = 1 } = context;

  if (!currentHigh || currentHigh.num < 13) {
    if (role.role === 'NAP' && role.bestSuit) {
      let optimalBid = 13;
      try {
        const plan = evaluateBidPlan(hand, role.bestSuit, params, bidHistory, mySeat, openKitty, playedCards, voids);
        optimalBid = plan.bestBidByExpectation || 13;
      } catch (e) {}
      const safeBid = Math.max(13, Math.min(optimalBid, 16));
      return { type: 'BID', num: safeBid, suit: role.bestSuit, intent: 'OPEN', reason: `EV最適(${optimalBid})で初期宣言` };
    }
    return { type: 'PASS', num: 0, suit: '', intent: 'PASS', reason: '初期宣言なし' };
  }

  if (role.role === 'NAP') {
    if (currentHigh.player === mySeat) {
      let properBid = 13;
      try { properBid = computeProperBid(hand, currentHigh.suit, params, mySeat, null, matchScores, openKitty, playedCards, voids, bidHistory, round).properBid || 13; }
      catch (e) {}
      if (currentHigh.num >= properBid) return { type: 'PASS', num: 0, suit: '', intent: 'PASS', reason: `適正値(${properBid})に到達` };
      return { type: 'BID', num: Math.min(20, currentHigh.num + 1), suit: currentHigh.suit, intent: 'S1', reason: `適正値(${properBid})まで段階上げ` };
    }
    let proper = { properBid: 13, suit: currentHigh.suit };
    try { proper = computeProperBid(hand, currentHigh.suit, params, mySeat, null, matchScores, openKitty, playedCards, voids, bidHistory, round); }
    catch (e) { console.warn('[EV] computeProperBid failed', e?.message); }
    const myProperBid = proper.properBid > 0 ? proper.properBid : 13;
    if (myProperBid <= currentHigh.num) {
      return { type: 'PASS', num: 0, suit: '', intent: 'PASS', reason: `適正値(${myProperBid})が現宣言(${currentHigh.num})以下で降りる` };
    }
    // ★ 「仕方なく立った」検出
    const wasMyInitialBid = bidHistory.length > 0 && bidHistory[0].seat === mySeat && bidHistory[0].num === 13;
    const someoneRaised = currentHigh.player !== mySeat && currentHigh.num > 13;
    if (wasMyInitialBid && someoneRaised && currentHigh.num >= myProperBid) {
      return { type: 'PASS', num: 0, suit: '', intent: 'PASS', reason: `仕方なく立った後のサポート(${currentHigh.num})は適正値(${myProperBid})以上で譲る` };
    }
    const gap = myProperBid - currentHigh.num;
    const isCritical = (gap <= 2) || (round >= 8) || (matchScores && (Math.max(...matchScores) - Math.min(...matchScores) > 30));
    const isLateGame = round >= 7;
    if (isCritical || isLateGame) {
      try {
        const evResult = evaluateBidOptionsPrecise(hand, currentHigh, params, bidHistory, mySeat, openKitty, playedCards, voids, signals, matchScores, round);
        if (evResult.bestOption && evResult.bestOption.ev > evResult.passEV + 0.2) {
          const best = evResult.bestOption;
          return { type: 'BID', num: best.bid, suit: best.suit, intent: 'S1', reason: `EV最適(bid=${best.bid}${best.suit}, EV=${best.ev.toFixed(2)} > pass=${evResult.passEV.toFixed(2)})` };
        }
        return { type: 'PASS', num: 0, suit: '', intent: 'PASS', reason: `EV最適でもpass有利 (best=${evResult.bestOption?.ev.toFixed(2)}, pass=${evResult.passEV.toFixed(2)})` };
      } catch (e) { console.warn('[EV] precise evaluation failed', e?.message); }
    }
    if (currentHigh.num < myProperBid) {
      const targetSuit = (currentHigh.suit === proper.suit || SV[proper.suit] > SV[currentHigh.suit]) ? proper.suit : currentHigh.suit;
      return { type: 'BID', num: Math.min(20, currentHigh.num + 1), suit: targetSuit, intent: 'S1', reason: `適正値(${myProperBid})まで段階上げ` };
    }
    return { type: 'PASS', num: 0, suit: '', intent: 'PASS', reason: `適正値(${myProperBid})に到達` };
  }

  if (role.role === 'DEPUTY') {
    const supportLimit = computeSupportLimit(hand, currentHigh.suit, params);
    const sameSuitSupporters = (signals || []).filter(s => ['S1', 'S2', 'S3', 'S4'].includes(s.intent) && s.suit === currentHigh.suit).length;
    const supportLimitThreshold = params.sameSuitBidderLimit ?? 2;
    const strongHandThreshold = 17;
    if (sameSuitSupporters >= supportLimitThreshold && (proper?.properBid || 13) < strongHandThreshold) {
      return { type: 'PASS', num: 0, suit: '', intent: 'PASS', reason: `多重サポート(${sameSuitSupporters + 1}人)では適正値不足で降りる` };
    }
    let evImprovement = 0;
    const plan = proper?.plan;
    if (plan?.bidExpectations) {
      const curEV = plan.bidExpectations[currentHigh.num]?.adjE ?? 0;
      const raiseEV = plan.bidExpectations[currentHigh.num + 1]?.adjE ?? -Infinity;
      evImprovement = raiseEV - curEV;
    }
    const evMargin = (params.bidStepwiseAggression ?? 0.6) * 0.05;
    if (currentHigh.num < supportLimit && currentHigh.num < 20 && evImprovement >= evMargin) {
      const targetNum = Math.min(supportLimit, currentHigh.num + 1);
      return { type: 'BID', num: targetNum, suit: currentHigh.suit, intent: 'S1', reason: `サポート上限(${supportLimit})・EV改善(${evImprovement.toFixed(3)})まで段階上げ` };
    }
    return { type: 'PASS', num: 0, suit: '', intent: 'PASS', reason: `EV改善(${evImprovement.toFixed(3)})が閾値未満で保留` };
  }

  return { type: 'PASS', num: 0, suit: '', intent: 'PASS', reason: '連合軍（降り）' };
}

// ============================================================
// chooseDeputyCall（役札網羅を原則）
// ============================================================
export function chooseDeputyCall(hand, kitty, trump, level, num, params, experience, receivedSignals = []) {
  const isTrumpSuit = trump !== 'NT';
  const sameColor = isTrumpSuit ? sameColorSuitOf(trump) : '♠';
  const isIn = id => hand.some(c => c.id === id);
  const inKitty = id => (kitty || []).some(c => c.id === id);

  const roleCards = [];
  if (!isIn('♠A') && !inKitty('♠A')) roleCards.push({ suit: '♠', rank: 'A', id: '♠A' });
  if (isTrumpSuit && !isIn(trump + 'J') && !inKitty(trump + 'J')) roleCards.push({ suit: trump, rank: 'J', id: trump + 'J' });
  if (isTrumpSuit && !isIn(sameColor + 'J') && !inKitty(sameColor + 'J')) roleCards.push({ suit: sameColor, rank: 'J', id: sameColor + 'J' });

  if (roleCards.length > 0) { const best = roleCards[0]; return { suit: best.suit, rank: best.rank, id: best.id }; }

  const deputyAppeals = (receivedSignals || []).filter(s => ['S1', 'S2', 'S3', 'S4'].includes(s.intent));
  for (const appeal of deputyAppeals) {
    const targetSuit = appeal.suit || (appeal.intent === 'S1' ? trump : sameColor);
    if (targetSuit === 'NT') continue;
    if (!isIn(targetSuit + 'A') && !inKitty(targetSuit + 'A')) return { suit: targetSuit, rank: 'A', id: targetSuit + 'A' };
  }
  const weakSuits = SUITS.filter(s => s !== trump).sort((a, b) => hand.filter(c => c.suit === a).length - hand.filter(c => c.suit === b).length);
  for (const s of weakSuits) { if (!isIn(s + 'A') && !inKitty(s + 'A')) return { suit: s, rank: 'A', id: s + 'A' }; }
  for (const s of weakSuits) { if (!isIn(s + '2') && !inKitty(s + '2')) return { suit: s, rank: '2', id: s + '2' }; }
  for (const s of SUITS) {
    if (s === trump) continue;
    for (const r of RANKS) { const id = s + r; if (!isIn(id) && !inKitty(id)) return { suit: s, rank: r, id }; }
  }
  return { suit: '♠', rank: '2', id: '♠2' };
}

export function canSendSignal(hand, currentHigh, seat, bidSignals, params, matchScores, role = null) {
  const myRole = role || determineRole(hand, params);
  if (!currentHigh || currentHigh.num < 13) return { intent: 'NONE', reason: '競り未開始' };
  return decideNextBid(hand, currentHigh, myRole, params, bidSignals?.received || []);
}
// ===== [後半 終了] =====
