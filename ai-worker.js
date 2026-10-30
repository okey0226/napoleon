// ai-worker.js
import { getMCTSStats } from './ai-tactics.js';

self.onmessage = function(e) {
  const { type, ctx } = e.data;
  if (type === 'calculate') {
    try {
      const stats = getMCTSStats(ctx);
      self.postMessage({ type: 'result', stats });
    } catch (error) {
      self.postMessage({ type: 'error', error: error.message });
    }
  }
};
