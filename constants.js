export const SUITS = ["♣", "♦", "♥", "♠"];
export const RANKS = ["2", "3", "4", "5", "6", "7", "8", "9", "10", "J", "Q", "K", "A"];
export const SV = { "♣": 1, "♦": 2, "♥": 3, "♠": 4, NT: 5 };
export const CALIBRATION = { 13: 0.82, 14: 0.75, 15: 0.65, 16: 0.55, 17: 0.42, 18: 0.30, 19: 0.18, 20: 0.08 };

export const PARAM_BOUNDS = {
  bidThreshold: [2.0, 6.0], riskTolerance: [0.1, 1.0], leadAggression: [0.2, 1.0],
  followAggression: [0.1, 1.0], trumpBonus: [0.2, 1.5], mightyBonus: [1.0, 3.0],
  safeAceWeight: [0.0, 1.0], roleCardPreservation: [0.0, 1.0], deputyFeedBias: [0.0, 1.0]
};

export function defaultStrategy() {
  return {
    bidThreshold: 4.0, riskTolerance: 0.5, leadAggression: 0.6, followAggression: 0.4,
    trumpBonus: 0.6, mightyBonus: 2.0, safeAceWeight: 0.7, roleCardPreservation: 0.6, deputyFeedBias: 0.5
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
