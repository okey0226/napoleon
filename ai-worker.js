// ai-worker.js
import { chooseCardWithMCTS } from './ai-tactics.js';

self.onmessage = function(e) {
  const { type, ctx } = e.data;
  if (type === 'calculate') {
    try {
      // 裏のスレッドで重い計算を実行（画面はフリーズしない）
      const chosen = chooseCardWithMCTS(ctx);
      self.postMessage({ type: 'result', card: chosen });
    } catch (error) {
      self.postMessage({ type: 'error', error: error.message });
    }
  }
};
