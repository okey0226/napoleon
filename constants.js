export const SUITS = ["♣", "♦", "♥", "♠"];
export const RANKS = ["2", "3", "4", "5", "6", "7", "8", "9", "10", "J", "Q", "K", "A"];
export const SV = { "♣": 1, "♦": 2, "♥": 3, "♠": 4, NT: 5 };
export const CALIBRATION = { 13: 0.82, 14: 0.75, 15: 0.65, 16: 0.55, 17: 0.42, 18: 0.30, 19: 0.18, 20: 0.08 };

// ========================================
// Sweet Spot: 最適な立ち宣言の目標勝率
// 50-60%で勝てる立ちが最もレートを稼げる設計
// ========================================
export const SWEET_SPOT_TARGET = 0.55;
export const SWEET_SPOT_WIDTH = 0.40;
export const SWEET_SPOT_BONUS = 2.5;

// ========================================
// 立ち強度テーブル
// CALIBRATION[num]の勝率を達成するのに必要な手札強度
// シミュレーションで自動校正される初期値
// ========================================
export const BID_STRENGTH_TABLE = {
  13: 2.0,
  14: 5.5,
  15: 7.5,
  16: 9.5,
  17: 11.5,
  18: 13.5,
  19: 15.5,
  20: 17.5
};

// 強度1ポイントあたりの勝率増加
export const STRENGTH_TO_WINRATE = 0.06;

// ========================================
// パラメータ境界とデフォルト
// ========================================
export const PARAM_BOUNDS = {
  bidThreshold: [2.0, 6.0],
  riskTolerance: [0.1, 1.0],
  leadAggression: [0.2, 1.0],
  followAggression: [0.1, 1.0],
  trumpBonus: [0.2, 1.5],
  mightyBonus: [1.0, 3.0],
  safeAceWeight: [0.0, 1.0],
  roleCardPreservation: [0.0, 1.0],
  deputyFeedBias: [0.0, 1.0]
};

export function defaultStrategy() {
  return {
    bidThreshold: 4.0,
    riskTolerance: 0.5,
    leadAggression: 0.6,
    followAggression: 0.4,
    trumpBonus: 0.6,
    mightyBonus: 2.0,
    safeAceWeight: 0.7,
    roleCardPreservation: 0.6,
    deputyFeedBias: 0.5
  };
}

export function mutateStrategy(base, rate = 0.15) {
  const out = { ...base };
  for (const [k, [lo, hi]] of Object.entries(PARAM_BOUNDS)) {
    if (Math.random() < rate) {
      const step = (hi - lo) * 0.08;
      out[k] = Math.max(lo, Math.min(hi, out[k] + (Math.random() - 0.5) * step * 2));
    }
  }
  return out;
}

export function shuffledDeck() {
  const d = [];
  for (const s of SUITS) for (const r of RANKS) d.push({ suit: s, rank: r, id: s + r });
  for (let i = d.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [d[i], d[j]] = [d[j], d[i]];
  }
  return d;
}

export function sortHand(h) {
  h.sort((a, b) => SV[b.suit] - SV[a.suit] || RANKS.indexOf(b.rank) - RANKS.indexOf(a.rank));
}

// ========================================
// Sweet Spot ヘルパー
// ========================================

/**
 * 勝ったときのボーナス係数（0〜1）。
 * p=0.55で最大1.0、|p-0.55|>=0.40で0。
 */
export function sweetSpotFactor(p) {
  const distance = Math.abs(p - SWEET_SPOT_TARGET);
  if (distance >= SWEET_SPOT_WIDTH) return 0;
  return 1 - distance / SWEET_SPOT_WIDTH;
}

/**
 * 手札強度 → 各立ち枚数での推定勝率
 * calibrationOverride (DB校正値) があればそちらを優先
 */
export function estimatedWinRate(strength, num, calibrationOverride = null) {
  const base = calibrationOverride?.[num] ?? CALIBRATION[num];
  const threshold = BID_STRENGTH_TABLE[num] ?? 0;
  const delta = (strength - threshold) * STRENGTH_TO_WINRATE;
  return Math.max(0.05, Math.min(0.95, base + delta));
}
