// situation.js — MECE状況分類層（20次元 + 決定論ハッシュ）
// 新規ファイル: AIの意思決定に必要な局面情報を20次元で構造化する
// 純関数のみ。副作用なし。乱数なし（決定論保証）。

import { SUITS, RANKS, FACE, sameColorSuitOf } from './constants.js';

// ============================================================
// 公開: 20次元の状況分類
// ============================================================
export function classifySituation(ctx) {
  if (!ctx || !ctx.contract) {
    return createEmptySituation();
  }

  const contract = ctx.contract;
  const seat = Number.isInteger(ctx.seat) ? ctx.seat : 0;
  const hand = Array.isArray(ctx.hand) ? ctx.hand : [];
  const legal = Array.isArray(ctx.legal) ? ctx.legal : hand;
  const trick = Array.isArray(ctx.trick) ? ctx.trick : [];
  const playedCards = Array.isArray(ctx.playedCards) ? ctx.playedCards : [];
  const discardedKitty = Array.isArray(ctx.discardedKitty) ? ctx.discardedKitty : [];
  const voids = Array.isArray(ctx.voids) ? ctx.voids : [{}, {}, {}, {}, {}];
  const points = Array.isArray(ctx.points) ? ctx.points : [0, 0, 0, 0, 0];
  const trickNo = Number.isInteger(ctx.trickNo) ? ctx.trickNo : 0;
  const round = Number.isInteger(ctx.round) ? ctx.round : 1;

  // ─────────────────────────────────────
  // 次元1: 役割
  // ─────────────────────────────────────
  const role = classifyRole(seat, contract, hand);

  // ─────────────────────────────────────
  // 次元2: フェーズ
  // ─────────────────────────────────────
  const phase = classifyPhase(trickNo);

  // ─────────────────────────────────────
  // 次元3: 手番位置
  // ─────────────────────────────────────
  const turn = classifyTurn(trick, seat, contract);

  // ─────────────────────────────────────
  // 次元4: 場の点札
  // ─────────────────────────────────────
  const trickValue = classifyTrickValue(trick);

  // ─────────────────────────────────────
  // 次元5: 敵切札残
  // 次元6: 自切札残
  // ─────────────────────────────────────
  const isNT = contract.suit === 'NT';
  const trumpInfo = isNT ? { enemy: 'nt', self: 'nt' } : classifyTrumpResidual(hand, playedCards, contract);

  // ─────────────────────────────────────
  // 次元7-9: 役札所在（マイティ/正J/裏J）
  // ─────────────────────────────────────
  const mightyLocation = classifyCardLocation('♠A', hand, playedCards, discardedKitty, trick, contract, seat);
  const trumpJLocation = isNT ? 'nt' : classifyCardLocation(contract.suit + 'J', hand, playedCards, discardedKitty, trick, contract, seat);
  const sameColorJLocation = isNT ? 'nt' : classifyCardLocation(sameColorSuitOf(contract.suit) + 'J', hand, playedCards, discardedKitty, trick, contract, seat);

  // ─────────────────────────────────────
  // 次元10: セイム2状態
  // ─────────────────────────────────────
  const sameTwoStatus = classifySameTwoStatus(hand, trick, trickNo, contract, voids, seat);

  // ─────────────────────────────────────
  // 次元11: ボイド状態
  // ─────────────────────────────────────
  const voidStatus = classifyVoidStatus(voids, seat, contract);

  // ─────────────────────────────────────
  // 次元12: 得点差
  // ─────────────────────────────────────
  const scoreState = classifyScoreState(points, contract, seat, trickNo);

  // ─────────────────────────────────────
  // 次元13: 全部取りリスク
  // ─────────────────────────────────────
  const allTakeRisk = classifyAllTakeRisk(points, contract, seat, trickNo);

  // ─────────────────────────────────────
  // 次元14: オーバーキル状況
  // ─────────────────────────────────────
  const overkillStatus = classifyOverkillStatus(trick, seat, contract);

  // ─────────────────────────────────────
  // 次元15: ラウンド
  // ─────────────────────────────────────
  const roundCategory = classifyRound(round, ctx.playoff === true);

  // ─────────────────────────────────────
  // 次元16: 自セイム2保有
  // 次元17: 敵セイム2保有推定
  // 次元18: セイム2残存2の数
  // ─────────────────────────────────────
  const selfHasSameTwo = detectSelfSameTwo(hand, trickNo);
  const enemySameTwoEstimate = estimateEnemySameTwo(playedCards, discardedKitty, contract, seat);
  const sameTwoRemaining = countRemainingTwos(playedCards, discardedKitty, hand);

  // ─────────────────────────────────────
  // 次元19: 全員フォロー可否（セイム2成立可否）
  // ─────────────────────────────────────
  const followFeasibility = classifyFollowFeasibility(trick, voids, trickNo);

  // ─────────────────────────────────────
  // 次元20: A切りリスク
  // ─────────────────────────────────────
  const aCutRisk = classifyACutRisk(hand, playedCards, discardedKitty, voids, trickNo, contract, seat);

  // 補助情報（次元には含めないが、prior計算等で使う）
  const legalCount = legal.length;
  const handSize = hand.length;
  const isLastSeat = trick.length === 4;
  const trickPointCount = trick.filter(t => t.card && FACE.includes(t.card.rank)).length;

  return {
    // 20次元
    role, phase, turn, trickValue,
    enemyTrump: trumpInfo.enemy, selfTrump: trumpInfo.self,
    mightyLocation, trumpJLocation, sameColorJLocation,
    sameTwoStatus,
    voidStatus,
    scoreState,
    allTakeRisk,
    overkillStatus,
    roundCategory,
    selfHasSameTwo, enemySameTwoEstimate, sameTwoRemaining,
    followFeasibility,
    aCutRisk,

    // 補助情報
    legalCount, handSize, isLastSeat, trickPointCount,
    seat, trickNo,
  };
}

// ============================================================
// 決定論ハッシュ: 状況 + 手札 + 場 + 履歴から固定文字列を生成
// ============================================================
export function hashSituation(ctx) {
  const s = classifySituation(ctx);
  const hand = (Array.isArray(ctx?.hand) ? ctx.hand : []).map(c => c.id).sort().join(',');
  const trick = (Array.isArray(ctx?.trick) ? ctx.trick : []).map(t => `${t.seat}:${t.card?.id || '?'}`).join(',');
  const played = (Array.isArray(ctx?.playedCards) ? ctx.playedCards : []).map(c => c.id).sort().join(',');
  const discarded = (Array.isArray(ctx?.discardedKitty) ? ctx.discardedKitty : []).map(c => c.id).sort().join(',');
  const legal = (Array.isArray(ctx?.legal) ? ctx.legal : []).map(c => c.id).sort().join(',');
  const voidsSig = (Array.isArray(ctx?.voids) ? ctx.voids : [{}, {}, {}, {}, {}])
    .map((v, i) => `${i}:${Object.keys(v || {}).sort().join('|')}`).join(',');
  const bidSig = (Array.isArray(ctx?.bidHistory) ? ctx.bidHistory : [])
    .map(b => `${b.seat}:${b.num}:${b.suit}`).join(',');
  const matchSig = (Array.isArray(ctx?.matchScores) ? ctx.matchScores : []).join(',');

  const payload = [
    s.role, s.phase, s.turn, s.trickValue,
    s.enemyTrump, s.selfTrump,
    s.mightyLocation, s.trumpJLocation, s.sameColorJLocation,
    s.sameTwoStatus, s.voidStatus, s.scoreState,
    s.allTakeRisk, s.overkillStatus, s.roundCategory,
    s.selfHasSameTwo, s.enemySameTwoEstimate, s.sameTwoRemaining,
    s.followFeasibility, s.aCutRisk,
    s.seat, s.trickNo, s.legalCount,
    '|H:', hand, '|T:', trick, '|P:', played, '|D:', discarded,
    '|L:', legal, '|V:', voidsSig, '|B:', bidSig, '|M:', matchSig,
  ].join('|');

  return fnv1a(payload);
}

function fnv1a(str) {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

// ============================================================
// 決定論シード: 状況ハッシュから 32bit 整数を生成
// ============================================================
export function deriveSeedFromSituation(ctx, salt = 0) {
  const h = hashSituation(ctx);
  const seed = (parseInt(h, 16) ^ (salt >>> 0)) >>> 0;
  return seed === 0 ? 1 : seed;
}

// ============================================================
// 各次元の分類ヘルパー
// ============================================================
function createEmptySituation() {
  return {
    role: 'alliance', phase: 'early', turn: 'lead', trickValue: 'zero',
    enemyTrump: 'nt', selfTrump: 'nt',
    mightyLocation: 'unknown', trumpJLocation: 'unknown', sameColorJLocation: 'unknown',
    sameTwoStatus: 'unknown', voidStatus: 'none', scoreState: 'even',
    allTakeRisk: 'none', overkillStatus: 'none', roundCategory: 'normal',
    selfHasSameTwo: 'none', enemySameTwoEstimate: 'unknown', sameTwoRemaining: 4,
    followFeasibility: 'high', aCutRisk: 'low',
    legalCount: 0, handSize: 0, isLastSeat: false, trickPointCount: 0, seat: 0, trickNo: 0,
  };
}

function classifyRole(seat, contract, hand) {
  if (!contract) return 'alliance';
  if (seat === contract.nap) return 'nap';
  if (contract.solo) return 'alliance';
  if (contract.revealedCall && seat === contract.deputy) return 'deputy_revealed';
  // 未公開副官の判定: 手札に指名カードがある
  if (!contract.revealedCall && contract.call && hand.some(c => c.id === contract.call.id)) {
    return 'deputy_hidden';
  }
  return 'alliance';
}

function classifyPhase(trickNo) {
  if (trickNo <= 2) return 'early';
  if (trickNo <= 5) return 'mid';
  if (trickNo <= 8) return 'late';
  return 'final';
}

function classifyTurn(trick, seat, contract) {
  if (!trick || trick.length === 0) return 'lead';
  // 現在の勝者を判定（簡易: 最強カードを推定せず、暫定でカード強度推定）
  const currentWinner = estimateCurrentWinner(trick, contract);
  if (!currentWinner) return 'follow_enemy_win';
  const isWinnerAlly = currentWinner === seat
    || (contract && currentWinner === contract.nap)
    || (contract && !contract.solo && currentWinner === contract.deputy);
  if (currentWinner === seat) return 'follow_self_win';
  return isWinnerAlly ? 'follow_ally_win' : 'follow_enemy_win';
}

function estimateCurrentWinner(trick, contract) {
  if (!trick || !trick.length) return -1;
  const ledSuit = trick[0].card?.suit;
  if (!ledSuit) return trick[0].seat;
  let best = trick[0];
  let bestPower = simpleCardPower(best.card, trick, contract);
  for (let i = 1; i < trick.length; i++) {
    const p = simpleCardPower(trick[i].card, trick, contract);
    if (p > bestPower) { bestPower = p; best = trick[i]; }
  }
  return best.seat;
}

function simpleCardPower(card, trick, contract) {
  if (!card) return 0;
  const suit = card.suit;
  const rank = card.rank;
  const isNT = contract?.suit === 'NT';
  const trump = isNT ? null : contract?.suit;
  const ledSuit = trick[0]?.card?.suit || suit;
  const hasMightyInTrick = trick.some(t => t.card?.id === '♠A');
  if (hasMightyInTrick && card.id === '♥Q') return 10000;
  if (card.id === '♠A') return 9000;
  if (!isNT && rank === 'J' && suit === trump) return 8000;
  if (!isNT && rank === 'J' && sameColorSuitOf(trump) === suit) return 7000;
  const allFollow = trick.every(t => t.card?.suit === ledSuit);
  if (allFollow && rank === '2' && suit === ledSuit) return 6000;
  if (!isNT && suit === trump) return 5000 + RANKS.indexOf(rank);
  if (suit === ledSuit) return 3000 + RANKS.indexOf(rank);
  return 1000 + RANKS.indexOf(rank);
}

function classifyTrickValue(trick) {
  const count = (trick || []).filter(t => t.card && FACE.includes(t.card.rank)).length;
  if (count === 0) return 'zero';
  if (count <= 2) return 'low';
  return 'high';
}

function classifyTrumpResidual(hand, playedCards, contract) {
  const trumpSuit = contract.suit;
  const selfTrumps = hand.filter(c => c.suit === trumpSuit).length;
  const playedTrumps = playedCards.filter(c => c.suit === trumpSuit).length;
  const enemyTrumps = Math.max(0, 13 - playedTrumps - selfTrumps);
  return {
    enemy: enemyTrumps >= 5 ? 'heavy' : enemyTrumps >= 3 ? 'mid' : enemyTrumps >= 1 ? 'light' : 'exhausted',
    self: selfTrumps >= 5 ? 'heavy' : selfTrumps >= 3 ? 'mid' : selfTrumps >= 1 ? 'light' : 'none',
  };
}

function classifyCardLocation(cardId, hand, playedCards, discardedKitty, trick, contract, seat) {
  if (!cardId || cardId.length < 2) return 'unknown';
  if (hand.some(c => c.id === cardId)) return 'self';
  if (trick.some(t => t.card?.id === cardId)) return 'played';
  if (playedCards.some(c => c.id === cardId)) return 'played';
  if (discardedKitty.some(c => c.id === cardId)) return 'played';
  // 味方の可能性を推定: NAP視点で副官判明済みなら副官、連合軍視点でNAP軍が味方
  if (contract) {
    const isNap = seat === contract.nap;
    const isDeputy = contract.revealedCall && seat === contract.deputy;
    if (isNap && contract.revealedCall) return 'enemy'; // 副官以外は敵
    if (isDeputy) return 'enemy'; // NAP軍から見て残りは敵
    if (!isNap && !isDeputy) {
      // 連合軍視点: NAP軍（NAP+副官）が敵
      return 'enemy';
    }
  }
  return 'unknown';
}

function classifySameTwoStatus(hand, trick, trickNo, contract, voids, seat) {
  if (trickNo === 0) return 'used'; // 1トリック目は無効
  const selfHas = hand.some(c => c.rank === '2');
  if (!selfHas) {
    // 自分に2がない → 敵か味方が保有
    return 'enemy_capable';
  }
  // 場の状況から成立可否を判定
  const allFollow = trick.length === 0 || trick.every(t => t.card?.suit === trick[0].card?.suit);
  if (trick.length === 0) return 'self_capable';
  if (allFollow) return 'self_capable';
  return 'blocked';
}

function classifyVoidStatus(voids, seat, contract) {
  const selfVoids = Object.keys(voids[seat] || {}).filter(s => voids[seat][s]);
  if (selfVoids.length > 0) return 'self_void';
  const isNap = seat === contract.nap;
  const isDeputy = contract.revealedCall && seat === contract.deputy;
  if (isNap || isDeputy) {
    // 敵（連合軍）のボイドを確認
    for (let s = 0; s < 5; s++) {
      if (s === seat || s === contract.nap || (!contract.solo && s === contract.deputy)) continue;
      if (Object.keys(voids[s] || {}).some(v => voids[s][v])) return 'enemy_void';
    }
    return 'none';
  }
  // 連合軍視点: 味方連合軍のボイド確認
  for (let s = 0; s < 5; s++) {
    if (s === seat || s === contract.nap) continue;
    if (!contract.solo && s === contract.deputy) continue;
    if (Object.keys(voids[s] || {}).some(v => voids[s][v])) return 'ally_void';
  }
  return 'none';
}

function classifyScoreState(points, contract, seat, trickNo) {
  const isNapSide = seat === contract.nap || (!contract.solo && seat === contract.deputy);
  const napPoints = (points[contract.nap] || 0) + (contract.solo ? 0 : (points[contract.deputy] || 0));
  const allyPoints = points.reduce((sum, p, i) => {
    if (i === contract.nap) return sum;
    if (!contract.solo && i === contract.deputy) return sum;
    return sum + (p || 0);
  }, 0);
  const myPoints = isNapSide ? napPoints : allyPoints;
  const oppPoints = isNapSide ? allyPoints : napPoints;
  const diff = myPoints - oppPoints;
  if (diff <= -5) return 'massive_behind';
  if (diff <= -2) return 'behind';
  if (diff < 2) return 'even';
  if (diff < 5) return 'ahead';
  return 'massive_ahead';
}

function classifyAllTakeRisk(points, contract, seat, trickNo) {
  const isNapSide = seat === contract.nap || (!contract.solo && seat === contract.deputy);
  if (!isNapSide) return 'none';
  if (contract.num >= 20) return 'none';
  const napPoints = (points[contract.nap] || 0) + (contract.solo ? 0 : (points[contract.deputy] || 0));
  if (napPoints >= 19) return 'urgent';
  if (napPoints >= 17) return 'warning';
  return 'none';
}

function classifyOverkillStatus(trick, seat, contract) {
  if (!trick || trick.length === 0) return 'none';
  const currentWinner = estimateCurrentWinner(trick, contract);
  if (currentWinner === seat) return 'self_winning';
  const isWinnerAlly = currentWinner === contract.nap
    || (!contract.solo && currentWinner === contract.deputy);
  const amIAlly = seat !== contract.nap && (contract.solo || seat !== contract.deputy);
  if (isWinnerAlly && amIAlly) return 'ally_winning';
  if (!isWinnerAlly && !amIAlly) return 'ally_winning'; // 連合軍同士
  return 'none';
}

function classifyRound(round, isPlayoff) {
  if (isPlayoff) return 'playoff';
  if (round >= 10) return 'all_last';
  if (round === 9) return 'last_prev';
  return 'normal';
}

function detectSelfSameTwo(hand, trickNo) {
  if (trickNo === 0) return 'none';
  const sideTwos = hand.filter(c => c.rank === '2' && c.suit !== '♠' && c.suit !== 'NT');
  if (sideTwos.length === 0) return 'none';
  const trumpTwo = hand.find(c => c.rank === '2' && c.suit !== '♠' && c.suit !== 'NT' && c.suit !== '♣' && c.suit !== '♦' && c.suit !== '♥' && c.suit !== '♠');
  // 切札2の判定は contract に依存するため簡略化。ここではサイド2のみ判定
  return sideTwos.length > 0 ? 'side' : 'none';
}

function estimateEnemySameTwo(playedCards, discardedKitty, contract, seat) {
  const played2Ids = new Set([
    ...playedCards.filter(c => c.rank === '2').map(c => c.id),
    ...discardedKitty.filter(c => c.rank === '2').map(c => c.id),
  ]);
  const remaining = ['♣2', '♦2', '♥2', '♠2'].filter(id => !played2Ids.has(id));
  if (remaining.length === 0) return 'none';
  if (remaining.length >= 3) return 'unknown';
  return 'side';
}

function countRemainingTwos(playedCards, discardedKitty, hand) {
  const consumed = new Set([
    ...playedCards.filter(c => c.rank === '2').map(c => c.id),
    ...discardedKitty.filter(c => c.rank === '2').map(c => c.id),
    ...hand.filter(c => c.rank === '2').map(c => c.id),
  ]);
  return Math.max(0, 4 - consumed.size);
}

function classifyFollowFeasibility(trick, voids, trickNo) {
  if (!trick || trick.length === 0) return 'high';
  const ledSuit = trick[0].card?.suit;
  if (!ledSuit) return 'high';
  const voidCount = [0, 1, 2, 3, 4].filter(s => voids[s] && voids[s][ledSuit]).length;
  if (voidCount >= 2) return 'impossible';
  if (voidCount >= 1) return 'uncertain';
  return 'high';
}

function classifyACutRisk(hand, playedCards, discardedKitty, voids, trickNo, contract, seat) {
  const selfAces = hand.filter(c => c.rank === 'A' && c.suit !== contract.suit);
  if (selfAces.length === 0) return 'low';
  if (trickNo === 0) return 'low'; // 1トリック目はセイム2無効

  // 各Aの安全度を評価
  let maxRisk = 0;
  for (const ace of selfAces) {
    const suit = ace.suit;
    const twoId = suit + '2';
    const twoPlayed = playedCards.some(c => c.id === twoId) || discardedKitty.some(c => c.id === twoId);
    if (twoPlayed) continue;
    // 敵ボイド確認
    const enemyVoids = [0, 1, 2, 3, 4].filter(s => {
      if (s === seat) return false;
      if (s === contract.nap) return false;
      if (!contract.solo && s === contract.deputy) return false;
      return voids[s] && voids[s][suit];
    }).length;
    let risk = 0.5;
    if (enemyVoids > 0) risk = 0.1; // 敵ボイドあり = セイム2不成立
    if (enemyVoids === 0) risk = 0.6;
    maxRisk = Math.max(maxRisk, risk);
  }
  if (maxRisk >= 0.55) return 'dangerous';
  if (maxRisk >= 0.4) return 'high';
  if (maxRisk >= 0.2) return 'mid';
  return 'low';
}

// ============================================================
// 次元値の言語化（デバッグ・ログ用）
// ============================================================
export const DIMENSION_LABELS = {
  role: { nap: 'ナポレオン', deputy_revealed: '副官(公開)', deputy_hidden: '副官(未公開)', alliance: '連合軍' },
  phase: { early: '序盤', mid: '中盤', late: '終盤', final: '最終' },
  turn: { lead: 'リード', follow_self_win: 'フォロー(自分勝ち)', follow_ally_win: 'フォロー(味方勝ち)', follow_enemy_win: 'フォロー(敵勝ち)' },
  trickValue: { zero: '点札0', low: '点札1-2', high: '点札3+' },
  enemyTrump: { heavy: '敵切札5+', mid: '敵切札3-4', light: '敵切札1-2', exhausted: '敵切札0', nt: 'NT' },
  selfTrump: { heavy: '自切札5+', mid: '自切札3-4', light: '自切札1-2', none: '自切札0', nt: 'NT' },
  mightyLocation: { self: 'マイティ自', ally: 'マイティ味方', enemy: 'マイティ敵', played: 'マイティ場', unknown: 'マイティ不明' },
  trumpJLocation: { self: '正J自', ally: '正J味方', enemy: '正J敵', played: '正J場', unknown: '正J不明', nt: 'NT' },
  sameColorJLocation: { self: '裏J自', ally: '裏J味方', enemy: '裏J敵', played: '裏J場', unknown: '裏J不明', nt: 'NT' },
  sameTwoStatus: { self_capable: 'セイム2可', self_blocked: 'セイム2不可(自)', blocked: 'セイム2不成立', enemy_capable: '敵セイム2警戒', used: 'セイム2無効', unknown: '不明' },
  voidStatus: { self_void: '自ボイド', ally_void: '味方ボイド', enemy_void: '敵ボイド', none: 'なし' },
  scoreState: { massive_behind: '大劣勢', behind: '劣勢', even: '互角', ahead: '優勢', massive_ahead: '大優勢' },
  allTakeRisk: { none: 'なし', warning: '警戒', urgent: '緊急' },
  overkillStatus: { self_winning: '自勝ち中', ally_winning: '味方勝ち中', none: 'なし' },
  roundCategory: { normal: '通常', last_prev: 'ラス前', all_last: 'オールラスト', playoff: 'プレオフ' },
  selfHasSameTwo: { none: '自セイム2なし', side: '自セイム2(サイド)', trump: '自セイム2(切札)' },
  enemySameTwoEstimate: { none: '敵セイム2なし', side: '敵セイム2(サイド)', trump: '敵セイム2(切札)', unknown: '敵セイム2不明' },
  followFeasibility: { high: '全員フォロー高', uncertain: '不確実', impossible: '全員フォロー不可', confirmed: '確定' },
  aCutRisk: { low: 'Aリスク低', mid: 'Aリスク中', high: 'Aリスク高', dangerous: 'Aリスク危険' },
};

export function describeSituation(situation) {
  if (!situation) return '';
  const parts = [];
  for (const dim of Object.keys(DIMENSION_LABELS)) {
    const val = situation[dim];
    const label = DIMENSION_LABELS[dim]?.[val] || val;
    if (label) parts.push(label);
  }
  return parts.join(' / ');
}

// ============================================================
// デバッグ用: 全次元を展開
// ============================================================
export function debugSituation(ctx) {
  const s = classifySituation(ctx);
  return {
    ...s,
    hash: hashSituation(ctx),
    description: describeSituation(s),
  };
}

