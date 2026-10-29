// ai-worker.js (完全版)
import { getMCTSStats } from './ai-tactics.js';

self.onmessage = function(e) {
  const { type, ctx } = e.data;
  if (type === 'calculate') {
    try {
      // 統計データを計算して返す
      const stats = getMCTSStats(ctx);
      self.postMessage({ type: 'result', stats });
    } catch (error) {
      self.postMessage({ type: 'error', error: error.message });
    }
  }
};
