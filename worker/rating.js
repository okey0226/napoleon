// ============================================================
// worker/rating.js
// 依存: constants.js のみ（純粋関数）
// 役割: マッチ終了時のレート変動計算
// ============================================================
import { estimatedWinRate, sweetSpotFactor, findMaxHonestBid, SWEET_SPOT_BONUS } from '../constants.js';

export function matchRatingChanges(scores, art, ratings, matchStats, contracts) {
  const meanArt = art.reduce((n, x) => n + x, 0) / 5;
  const cs = contracts || [];

  return scores.map((score, seat) => {
    let delta = 0;
    const rounds = [];

    for (const c of cs) {
      const safeStrength = Number.isFinite(c.strengthAtBid) ? c.strengthAtBid : 8;
      const p = estimatedWinRate(safeStrength, c.num);
      const diff = Math.max(0, c.num - 12);
      const highBoost = 1 + 0.5 * Math.max(0, c.num - 17);
      const soloMult = c.solo ? 1.5 : 1.0;
      const maxHonest = findMaxHonestBid(safeStrength);
      const bluffGap = Math.max(0, c.num - maxHonest);
      const isHonest = bluffGap === 0;
      const actual = c.napWin ? 1 : 0;

      let roundDelta = 0;
      let role = 'ally';

      if (seat === c.nap) {
        role = 'nap';
        if (c.napWin) {
          roundDelta = ((1 - p) * diff * 8 + sweetSpotFactor(p) * SWEET_SPOT_BONUS * highBoost) * soloMult;
          if (c.points > c.num) roundDelta -= (c.points - c.num) * 0.3;
          if (isHonest) roundDelta += 0.75;
        } else {
          roundDelta = -p * diff * 8 * soloMult;
          if (!isHonest) roundDelta -= bluffGap * 2.0;
        }
      } else if (!c.solo && seat === c.deputy) {
        role = 'dep';
        roundDelta = (actual - p) * diff * 3.2;
        if (c.napWin && c.revealTrickNo != null) roundDelta += Math.max(0, c.revealTrickNo - 3) * 0.3;
      } else {
        role = 'ally';
        roundDelta = (c.napWin ? -0.5 : 0.5) + (c.points < c.num ? 0.3 : 0);
      }

      delta += Number.isFinite(roundDelta) ? roundDelta : 0;
      rounds.push({ bid: c.num, role, delta: Math.round(roundDelta * 100) / 100 });
    }

    delta += (art[seat] - meanArt) * 0.3;
    const rank = 1 + scores.filter(x => x > score).length;
    if (rank === 1) delta += 0.5;
    else if (rank === 5) delta -= 0.5;
    delta -= 0.05 * cs.length;

    const outcome = score > 0 ? 'win' : score < 0 ? 'loss' : 'draw';
    return {
      seat,
      delta: Math.round(delta * 10) / 10,
      placement: rank,
      art: art[seat] - meanArt,
      outcome,
      breakdown: { rounds, rank }
    };
  });
}
