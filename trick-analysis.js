// trick-analysis.js — トリック状況のMECE分析
// 「出たカードが絶対勝てるか」「味方か敵か」「自分はどうすべきか」を判定
// カードカウンティング + void追跡で物理的に絶対判断する（ハルシネーションなし）

import { SUITS, RANKS, FACE, sameColorSuitOf } from './constants.js';

// ============================================================
// ローカル cardPower（ai-tactics への循環importを避ける）
// ============================================================
function cardPowerLocal(contract, trickNo, card, trick) {
  if (!card) return 0;
  const ledSuit = trick.length > 0 ? trick[0].card.suit : card.suit;
  const allSame = trick.every(x => x.card.suit === ledSuit);
  const sameTwoEligible = allSame && trick.length >= 1;
  const mighty = trick.some(x => x.card.id === '♠A');

  if (mighty && card.id === '♥Q') return 10000;
  if (card.id === '♠A') return 9000;
  const isNT = !contract || contract.suit === 'NT';
  const trump = isNT ? null : contract.suit;
  if (!isNT && card.rank === 'J' && card.suit === trump) return 8000;
  if (!isNT && card.rank === 'J' && card.suit !== trump && sameColorSuitOf(trump) === card.suit) return 7000;
  if (trickNo > 0 && sameTwoEligible && card.rank === '2' && card.suit === ledSuit) return 6000;
  if (!isNT && card.suit === trump) return 5000 + RANKS.indexOf(card.rank);
  if (card.suit === ledSuit) return 3000 + RANKS.indexOf(card.rank);
  return 1000 + RANKS.indexOf(card.rank);
}

// ============================================================
// 役割判定（自分から見た「味方か敵か」）
// ============================================================
function isMyAlly(targetSeat, mySeat, contract) {
  if (!contract) return false;
  const iAmNap = mySeat === contract.nap;
  const iAmDeputy = !contract.solo && contract.deputy >= 0 && mySeat === contract.deputy;

  if (iAmNap || iAmDeputy) {
    const targetIsNap = targetSeat === contract.nap;
    const targetIsPublicDeputy = contract.revealedCall && !contract.solo && targetSeat === contract.deputy;
    if (iAmDeputy) return targetIsNap || targetIsPublicDeputy;
    if (iAmNap) return targetIsNap || targetIsPublicDeputy;
    return false;
  }

  const targetIsNap = targetSeat === contract.nap;
  const targetIsPublicDeputy = contract.revealedCall && !contract.solo && targetSeat === contract.deputy;
  return !targetIsNap && !targetIsPublicDeputy;
}

// ============================================================
// 事実: 既知の牌を列挙
// ============================================================
export function collectSeenCardIds(ctx) {
  const seen = new Set();
  (ctx.hand || []).forEach(c => seen.add(c.id));
  (ctx.playedCards || []).forEach(c => seen.add(c.id));
  (ctx.discardedKitty || []).forEach(c => seen.add(c.id));
  (ctx.trick || []).forEach(t => seen.add(t.card.id));
  return seen;
}

// ============================================================
// 事実: 未見の牌を完全列挙
// ============================================================
export function enumerateUnseenCards(ctx) {
  const seen = collectSeenCardIds(ctx);
  const unseen = [];
  for (const s of SUITS) {
    for (const r of RANKS) {
      const id = s + r;
      if (!seen.has(id)) unseen.push({ suit: s, rank: r, id });
    }
  }
  return unseen;
}

// ============================================================
// 事実: まだ出牌していない座席
// ============================================================
export function getRemainingSeats(ctx) {
  const played = new Set((ctx.trick || []).map(t => t.seat));
  const remaining = [];
  for (let i = 0; i < 5; i++) {
    if (!played.has(i) && i !== ctx.seat) remaining.push(i);
  }
  return remaining;
}

// ============================================================
// 事実: その座位がその牌を物理的に出せるか（voids考慮）
// ============================================================
function canSeatPlayCard(seat, card, ctx) {
  const voidMap = ctx.voids?.[seat];
  if (!voidMap) return true;
  return !voidMap[card.suit];
}

// ============================================================
// 現在の勝者を取得
// ============================================================
function getCurrentWinner(ctx) {
  const { contract, trick, trickNo } = ctx;
  if (!trick || trick.length === 0) return null;
  return trick.reduce((best, x) =>
    cardPowerLocal(contract, trickNo, x.card, trick) > cardPowerLocal(contract, trickNo, best.card, trick) ? x : best,
    trick[0]);
}

// ============================================================
// ★ 核心: 現在の勝者が「絶対勝ち」か物理判定
// ============================================================
export function isCurrentWinnerLocked(ctx) {
  const { contract, seat, trick, trickNo } = ctx;
  if (!contract || !trick || trick.length === 0) {
    return { locked: false, reason: 'lead_or_invalid', winnerEntry: null };
  }

  const winnerEntry = getCurrentWinner(ctx);

  // 味方が勝っているか
  const allyWinning = isMyAlly(winnerEntry.seat, seat, contract);
  if (!allyWinning) {
    return { locked: false, reason: 'enemy_winning', winnerEntry };
  }

  // 自分が最後手番 → 出した瞬間に確定
  if (trick.length >= 4) {
    return { locked: true, reason: 'last_seat', winnerEntry };
  }

  // 未見牌 × voids で物理判定
  const winnerPower = cardPowerLocal(contract, trickNo, winnerEntry.card, trick);
  const unseen = enumerateUnseenCards(ctx);
  const remainingSeats = getRemainingSeats(ctx);

  const threats = [];
  for (const c of unseen) {
    const testTrick = [...trick, { seat: -1, card: c }];
    const power = cardPowerLocal(contract, trickNo, c, testTrick);
    if (power <= winnerPower) continue;

    let playableBySomeone = false;
    for (const s of remainingSeats) {
      if (canSeatPlayCard(s, c, ctx)) { playableBySomeone = true; break; }
    }
    if (playableBySomeone) threats.push(c.id);
  }

  if (threats.length === 0) {
    return {
      locked: true,
      reason: 'no_effective_threats',
      winnerEntry,
      winnerPower,
      remainingSeats,
      unseenCount: unseen.length,
    };
  }

  return {
    locked: false,
    reason: 'has_threats',
    winnerEntry,
    winnerPower,
    threats,
    remainingSeats,
  };
}

// ============================================================
// 役札判定
// ============================================================
function isRoleCard(c, contract) {
  if (!contract) return false;
  if (c.id === '♠A') return true;
  if (c.id === '♥Q') return true;
  if (contract.suit === 'NT') return false;
  if (c.rank === 'J' && c.suit === contract.suit) return true;
  if (c.rank === 'J' && sameColorSuitOf(contract.suit) === c.suit) return true;
  return false;
}

// ============================================================
// 事実ベースの最弱札選択（maxPower 以下で役札・点札を避ける）
// ============================================================
export function pickWeakestNonCovering(ctx, maxPower) {
  const { contract, trick, trickNo, legal } = ctx;
  if (!legal || !legal.length) return null;

  const nonRole = legal.filter(c => !isRoleCard(c, contract));
  const basePool = nonRole.length > 0 ? nonRole : legal;

  let pool = basePool;
  if (typeof maxPower === 'number') {
    const below = basePool.filter(c => {
      const testTrick = [...trick, { seat: ctx.seat, card: c }];
      return cardPowerLocal(contract, trickNo, c, testTrick) <= maxPower;
    });
    if (below.length > 0) pool = below;
  }

  const nonFace = pool.filter(c => !FACE.includes(c.rank));
  const finalPool = nonFace.length > 0 ? nonFace : pool;

  return finalPool.reduce((best, c) => {
    const p = cardPowerLocal(contract, trickNo, c, trick);
    const bp = cardPowerLocal(contract, trickNo, best, trick);
    return p < bp ? c : best;
  }, finalPool[0]);
}

// ============================================================
// ★ 状況の総合分析（MECE）
// ============================================================
export function analyzeTrickSituation(ctx) {
  const { contract, seat, legal, trick, trickNo } = ctx;

  if (!trick || trick.length === 0) {
    return { phase: 'lead', shouldDelegateToEngine: true };
  }
  if (!legal || legal.length < 2) {
    return { phase: 'forced', shouldDelegateToEngine: true };
  }

  const currentWinner = getCurrentWinner(ctx);
  const lockedInfo = isCurrentWinnerLocked(ctx);
  const allyWinning = currentWinner ? isMyAlly(currentWinner.seat, seat, contract) : false;
  const trickPoints = trick.filter(t => FACE.includes(t.card.rank)).length;
  const trickPointCards = trick.filter(t => FACE.includes(t.card.rank)).map(t => t.card.id);
  const winnerPower = currentWinner ? cardPowerLocal(contract, trickNo, currentWinner.card, trick) : 0;

  const winningPlays = legal.filter(c => {
    const testTrick = [...trick, { seat, card: c }];
    return cardPowerLocal(contract, trickNo, c, testTrick) > winnerPower;
  });

  const unseen = enumerateUnseenCards(ctx);
  const remainingAfterMe = getRemainingSeats(ctx);
  const absoluteWinPlays = winningPlays.filter(c => {
    const testTrick = [...trick, { seat, card: c }];
    const myPower = cardPowerLocal(contract, trickNo, c, testTrick);
    for (const u of unseen) {
      if (u.id === c.id) continue;
      const testTrick2 = [...testTrick, { seat: -1, card: u }];
      if (cardPowerLocal(contract, trickNo, u, testTrick2) <= myPower) continue;
      for (const s of remainingAfterMe) {
        if (canSeatPlayCard(s, u, ctx)) return false;
      }
    }
    return true;
  });

  const strategies = [];

  if (allyWinning) {
    strategies.push({
      type: 'protect_ally',
      description: '味方が勝っている → 絶対に被せず流す',
      ev: lockedInfo.locked ? 0.5 : 0,
    });
    if (!lockedInfo.locked && trickPoints >= 2 && absoluteWinPlays.length > 0) {
      strategies.push({
        type: 'secure_win',
        description: '多点トリックで不確定要素あり → 絶対勝ちで確定',
        ev: trickPoints,
      });
    }
  } else {
    strategies.push({
      type: 'flow_enemy',
      description: '敵が勝っている → 温存して流す',
      ev: trickPoints > 0 ? -trickPoints : 0,
    });
    if (winningPlays.length > 0 && trickPoints > 0) {
      strategies.push({
        type: 'fight_win',
        description: '敵の点札を奪える → 勝ちに行く',
        ev: trickPoints,
      });
    }
  }

  let recommendation = null;

  if (allyWinning && lockedInfo.locked) {
    const card = pickWeakestNonCovering(ctx, winnerPower);
    recommendation = {
      card,
      strategy: 'protect_ally',
      reason: `味方(席${currentWinner.seat})の絶対勝ち (${lockedInfo.reason})。被せず最弱で流す。`,
      ev: 0.5,
      locked: true,
      winnerPower,
    };
  } else if (allyWinning && !lockedInfo.locked) {
    if (trickPoints >= 2 && absoluteWinPlays.length > 0) {
      recommendation = {
        card: absoluteWinPlays[0],
        strategy: 'secure_win',
        reason: `${trickPoints}点トリック。味方勝ちを絶対勝ちで確定。`,
        ev: trickPoints,
        locked: false,
      };
    } else {
      const card = pickWeakestNonCovering(ctx, winnerPower);
      recommendation = {
        card,
        strategy: 'protect_ally',
        reason: `味方勝ち。不確定要素${lockedInfo.threats?.length || 0}件あるが被せず流す。`,
        ev: 0,
        locked: false,
      };
    }
  } else if (!allyWinning && trickPoints > 0 && winningPlays.length > 0) {
    const best = absoluteWinPlays[0] || winningPlays.reduce((a, b) => {
      const pa = cardPowerLocal(contract, trickNo, a, trick);
      const pb = cardPowerLocal(contract, trickNo, b, trick);
      return pa < pb ? a : b;
    }, winningPlays[0]);
    recommendation = {
      card: best,
      strategy: 'fight_win',
      reason: `敵勝ちの${trickPoints}点トリック。${absoluteWinPlays.length > 0 ? '絶対勝ちで' : '勝って'}奪う。`,
      ev: trickPoints,
      locked: false,
    };
  } else {
    const card = pickWeakestNonCovering(ctx, winnerPower);
    recommendation = {
      card,
      strategy: 'flow_enemy',
      reason: trickPoints > 0 ? '点札トリックだが勝てないため流す。' : '点なしトリック。流す。',
      ev: 0,
      locked: false,
    };
  }

  return {
    phase: 'trick_in_progress',
    currentWinner: currentWinner ? {
      seat: currentWinner.seat,
      card: currentWinner.card.id,
      power: winnerPower,
      isAlly: allyWinning,
    } : null,
    locked: lockedInfo.locked,
    lockedReason: lockedInfo.reason,
    threats: lockedInfo.threats || [],
    allyWinning,
    enemyWinning: !allyWinning,
    trickPoints,
    trickPointCards,
    position: trick.length,
    isLastSeat: trick.length >= 4,
    legalCount: legal.length,
    winningPlays: winningPlays.map(c => c.id),
    absoluteWinPlays: absoluteWinPlays.map(c => c.id),
    unseenCount: unseen.length,
    remainingSeats: lockedInfo.remainingSeats || getRemainingSeats(ctx),
    strategies,
    recommendation,
    shouldDelegateToEngine: false,
  };
}

// ============================================================
// ★ 統合エントリ: 戦術エンジンより優先すべき状況のみ返す
// ============================================================
export function decidePlayFromTrickAnalysis(ctx) {
  if (!ctx.trick || ctx.trick.length === 0) return null;
  if (!ctx.legal || ctx.legal.length < 2) return null;

  let analysis;
  try { analysis = analyzeTrickSituation(ctx); }
  catch (e) { return null; }

  if (!analysis || !analysis.recommendation || !analysis.recommendation.card) return null;

  const card = analysis.recommendation.card;
  if (!ctx.legal.some(c => c.id === card.id)) return null;

  const shouldPrioritize =
    (analysis.allyWinning && analysis.locked) ||
    (!analysis.allyWinning && analysis.trickPoints >= 2 && analysis.winningPlays.length > 0);

  if (!shouldPrioritize) return null;

  return {
    card,
    analysis,
    strategy: analysis.recommendation.strategy,
    reason: analysis.recommendation.reason,
    ev: analysis.recommendation.ev,
    locked: analysis.locked,
  };
}

// ============================================================
// デバッグ用
// ============================================================
export function debugTrickAnalysis(ctx) {
  const a = analyzeTrickSituation(ctx);
  return {
    ...a,
    recommendationCard: a.recommendation?.card?.id || null,
    summary: a.recommendation
      ? `${a.recommendation.strategy}: ${a.recommendation.reason}`
      : '(リード or 対象外)',
  };
}

