// trick-analysis.js — トリック状況のMECE分析
// 修正: 役札保護 / 味方勝ち時のフィード / セイム2ガード認識 / 弱手札判断

import { SUITS, RANKS, FACE, sameColorSuitOf } from './constants.js';

// ============================================================
// ローカル cardPower（循環import回避）
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
// 役割判定
// ============================================================
function isMyAlly(targetSeat, mySeat, contract) {
  if (!contract) return false;
  const iAmNap = mySeat === contract.nap;
  const iAmDeputy = !contract.solo && contract.deputy >= 0 && mySeat === contract.deputy;
  const targetIsNap = targetSeat === contract.nap;
  const targetIsPublicDeputy = contract.revealedCall && !contract.solo && targetSeat === contract.deputy;
  if (iAmNap || iAmDeputy) return targetIsNap || targetIsPublicDeputy;
  return !targetIsNap && !targetIsPublicDeputy;
}

// ============================================================
// ★ 保護すべき役札の判定（Discard防止）
// ============================================================
function isRoleCardBase(c, contract) {
  if (!contract) return false;
  if (c.id === '♠A') return true;      // マイティ
  if (c.id === '♥Q') return true;      // 影
  if (contract.suit === 'NT') return false;
  if (c.rank === 'J' && c.suit === contract.suit) return true;                       // 正J
  if (c.rank === 'J' && sameColorSuitOf(contract.suit) === c.suit) return true;      // 裏J
  return false;
}

function isSameTwoGuard(c, ctx) {
  if (c.rank !== '2') return false;
  const aceId = c.suit + 'A';
  const playedIds = new Set((ctx.playedCards || []).map(x => x.id));
  const discardedIds = new Set((ctx.discardedKitty || []).map(x => x.id));
  // 同スートAがまだ未プレイ・未捨て → セイム2として機能
  return !playedIds.has(aceId) && !discardedIds.has(aceId);
}

function isProtectedFromDiscard(c, ctx) {
  if (isRoleCardBase(c, ctx.contract)) return true;
  if (isSameTwoGuard(c, ctx)) return true;
  if (c.rank === 'A') return true;     // 非♠Aも含めAは温存
  return false;
}

// ============================================================
// ★ 孤立点札（フィード対象）の判定
// ============================================================
function isIsolatedPointCard(c, ctx) {
  if (!FACE.includes(c.rank)) return false;
  if (isProtectedFromDiscard(c, ctx)) return false;
  const sameSuit = (ctx.hand || []).filter(x => x.suit === c.suit && x.id !== c.id);
  const hasGuard = sameSuit.some(x => x.rank === 'A' || x.rank === 'K');
  if (hasGuard) return false;
  return true; // J/10/QでA/Kの守護なし → 孤立点札
}

// ============================================================
// 事実: 既知・未見カード
// ============================================================
export function collectSeenCardIds(ctx) {
  const seen = new Set();
  (ctx.hand || []).forEach(c => seen.add(c.id));
  (ctx.playedCards || []).forEach(c => seen.add(c.id));
  (ctx.discardedKitty || []).forEach(c => seen.add(c.id));
  (ctx.trick || []).forEach(t => seen.add(t.card.id));
  return seen;
}

export function enumerateUnseenCards(ctx) {
  const seen = collectSeenCardIds(ctx);
  const unseen = [];
  for (const s of SUITS) for (const r of RANKS) {
    const id = s + r;
    if (!seen.has(id)) unseen.push({ suit: s, rank: r, id });
  }
  return unseen;
}

export function getRemainingSeats(ctx) {
  const played = new Set((ctx.trick || []).map(t => t.seat));
  const out = [];
  for (let i = 0; i < 5; i++) {
    if (!played.has(i) && i !== ctx.seat) out.push(i);
  }
  return out;
}

function canSeatPlayCard(seat, card, ctx) {
  const voidMap = ctx.voids?.[seat];
  if (!voidMap) return true;
  return !voidMap[card.suit];
}

function getCurrentWinner(ctx) {
  const { contract, trick, trickNo } = ctx;
  if (!trick || trick.length === 0) return null;
  return trick.reduce((best, x) =>
    cardPowerLocal(contract, trickNo, x.card, trick) > cardPowerLocal(contract, trickNo, best.card, trick) ? x : best,
    trick[0]);
}

// ============================================================
// 絶対勝ち判定
// ============================================================
export function isCurrentWinnerLocked(ctx) {
  const { contract, seat, trick, trickNo } = ctx;
  if (!contract || !trick || trick.length === 0) return { locked: false, reason: 'lead_or_invalid', winnerEntry: null };
  const winnerEntry = getCurrentWinner(ctx);
  const allyWinning = isMyAlly(winnerEntry.seat, seat, contract);
  if (!allyWinning) return { locked: false, reason: 'enemy_winning', winnerEntry };
  if (trick.length >= 4) return { locked: true, reason: 'last_seat', winnerEntry };

  const winnerPower = cardPowerLocal(contract, trickNo, winnerEntry.card, trick);
  const unseen = enumerateUnseenCards(ctx);
  const remainingSeats = getRemainingSeats(ctx);
  const threats = [];
  for (const c of unseen) {
    const testTrick = [...trick, { seat: -1, card: c }];
    const power = cardPowerLocal(contract, trickNo, c, testTrick);
    if (power <= winnerPower) continue;
    let playable = false;
    for (const s of remainingSeats) { if (canSeatPlayCard(s, c, ctx)) { playable = true; break; } }
    if (playable) threats.push(c.id);
  }
  if (threats.length === 0) {
    return { locked: true, reason: 'no_effective_threats', winnerEntry, winnerPower, remainingSeats };
  }
  return { locked: false, reason: 'has_threats', winnerEntry, winnerPower, threats, remainingSeats };
}

// ============================================================
// 最弱札選択（保護カードを除外）
// ============================================================
export function pickWeakestNonCovering(ctx, maxPower) {
  const { contract, trick, trickNo, legal } = ctx;
  if (!legal || !legal.length) return null;

  // ★ 役札・A・セイム2ガードを除外
  const unprotected = legal.filter(c => !isProtectedFromDiscard(c, ctx));
  const basePool = unprotected.length > 0 ? unprotected : legal;

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
// ★ 味方確定勝ち時の選択（孤立点札フィード優先）
// ============================================================
function pickForLockedAllyWin(ctx) {
  const legal = ctx.legal || [];
  if (!legal.length) return null;

  const unprotected = legal.filter(c => !isProtectedFromDiscard(c, ctx));
  if (!unprotected.length) return legal[0];

  // 1. 孤立点札があればフィード（最も高いランクを優先 = 最も失うリスクが高い）
  const isolatedPoints = unprotected.filter(c => isIsolatedPointCard(c, ctx));
  if (isolatedPoints.length) {
    return isolatedPoints.reduce((best, c) =>
      RANKS.indexOf(c.rank) > RANKS.indexOf(best.rank) ? c : best,
      isolatedPoints[0]
    );
  }

  // 2. 非点札の最弱
  const nonFace = unprotected.filter(c => !FACE.includes(c.rank));
  const pool = nonFace.length ? nonFace : unprotected;
  return pool.reduce((best, c) => {
    const p = cardPowerLocal(ctx.contract, ctx.trickNo, c, ctx.trick);
    const bp = cardPowerLocal(ctx.contract, ctx.trickNo, best, ctx.trick);
    return p < bp ? c : best;
  }, pool[0]);
}

// ============================================================
// 総合分析
// ============================================================
export function analyzeTrickSituation(ctx) {
  const { contract, seat, legal, trick, trickNo } = ctx;
  if (!trick || trick.length === 0) return { phase: 'lead', shouldDelegateToEngine: true };
  if (!legal || legal.length < 2) return { phase: 'forced', shouldDelegateToEngine: true };

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
      for (const s of remainingAfterMe) { if (canSeatPlayCard(s, u, ctx)) return false; }
    }
    return true;
  });

  let recommendation = null;

  if (allyWinning && lockedInfo.locked) {
    // ★ 味方確定勝ち → フィードまたは最弱（役札保護）
    const card = pickForLockedAllyWin(ctx);
    const isFeed = card && isIsolatedPointCard(card, ctx);
    recommendation = {
      card,
      strategy: isFeed ? 'feed_ally' : 'protect_ally',
      reason: isFeed
        ? `味方(席${currentWinner.seat})の絶対勝ち。孤立点札 ${card.id} をフィード。`
        : `味方(席${currentWinner.seat})の絶対勝ち。役札保護で最弱札。`,
      ev: isFeed ? 1.0 : 0.5,
      locked: true,
      winnerPower,
    };
  } else if (allyWinning && !lockedInfo.locked) {
    if (trickPoints >= 2 && absoluteWinPlays.length > 0) {
      recommendation = {
        card: absoluteWinPlays[0], strategy: 'secure_win',
        reason: `${trickPoints}点トリック。味方勝ちを絶対勝ちで確定。`,
        ev: trickPoints, locked: false,
      };
    } else {
      const card = pickWeakestNonCovering(ctx, winnerPower);
      recommendation = {
        card, strategy: 'protect_ally',
        reason: `味方勝ち。不確定要素${lockedInfo.threats?.length || 0}件あるが役札保護で流す。`,
        ev: 0, locked: false,
      };
    }
  } else if (!allyWinning && trickPoints > 0 && winningPlays.length > 0) {
    const best = absoluteWinPlays[0] || winningPlays.reduce((a, b) => {
      const pa = cardPowerLocal(contract, trickNo, a, trick);
      const pb = cardPowerLocal(contract, trickNo, b, trick);
      return pa < pb ? a : b;
    }, winningPlays[0]);
    recommendation = {
      card: best, strategy: 'fight_win',
      reason: `敵勝ちの${trickPoints}点トリック。${absoluteWinPlays.length > 0 ? '絶対勝ちで' : '勝って'}奪う。`,
      ev: trickPoints, locked: false,
    };
  } else {
    const card = pickWeakestNonCovering(ctx, winnerPower);
    recommendation = {
      card, strategy: 'flow_enemy',
      reason: trickPoints > 0 ? '点札トリックだが勝てないため役札保護で流す。' : '点なしトリック。役札保護で流す。',
      ev: 0, locked: false,
    };
  }

  return {
    phase: 'trick_in_progress',
    currentWinner: currentWinner ? {
      seat: currentWinner.seat, card: currentWinner.card.id,
      power: winnerPower, isAlly: allyWinning,
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
    recommendation,
    shouldDelegateToEngine: false,
  };
}

// ============================================================
// 統合エントリ
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

  // ★ 優先条件を緩和: 役札保護・フィードも含めて幅広く適用
  const shouldPrioritize =
    analysis.allyWinning ||                                                      // 味方勝ち中は常に介入
    (!analysis.allyWinning && analysis.trickPoints >= 2 && analysis.winningPlays.length > 0); // 敵多点は勝ちに行く

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
