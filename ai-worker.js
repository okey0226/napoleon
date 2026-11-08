// ai-worker.js
// N29/N30修正後の ai-tactics.js を参照
// N33: ホスト端末COM計算（暗号化されたbot手札を復号してMCTS実行）
import { getMCTSStats, chooseCardWithMCTS, chooseCardToPlay } from './ai-tactics.js';

// ============================================================
// ★ N33: 暗号鍵保持（メインスレッドには一切の平文を残さない）
// ============================================================
let __aesKey = null;

async function importAesKey(keyHex) {
  if (!keyHex || typeof keyHex !== 'string' || keyHex.length !== 64) {
    throw new Error('invalid key hex');
  }
  const bytes = new Uint8Array(keyHex.match(/.{2}/g).map(x => parseInt(x, 16)));
  return crypto.subtle.importKey('raw', bytes, { name: 'AES-GCM' }, false, ['decrypt']);
}

async function decryptPayload(encrypted) {
  if (!__aesKey) throw new Error('no key set');
  if (!encrypted || !encrypted.iv || !encrypted.ciphertext) throw new Error('invalid payload');
  const iv = new Uint8Array(encrypted.iv.match(/.{2}/g).map(x => parseInt(x, 16)));
  const ciphertext = new Uint8Array(encrypted.ciphertext.match(/.{2}/g).map(x => parseInt(x, 16)));
  const plaintext = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, __aesKey, ciphertext);
  return JSON.parse(new TextDecoder().decode(plaintext));
}

// ============================================================
// ★ メッセージハンドラ
// ============================================================
self.onmessage = async function (e) {
  const data = e.data;
  if (!data || !data.type) return;

  // --- 鍵設定（マッチ開始時にホスト端末へ送られる） ---
  if (data.type === 'set-key') {
    try {
      __aesKey = await importAesKey(data.keyHex);
      self.postMessage({ type: 'key-set-ok' });
    } catch (err) {
      __aesKey = null;
      self.postMessage({ type: 'key-set-error', error: String(err && err.message || err) });
    }
    return;
  }

  // --- ホスト端末COM計算（N33案A） ---
  if (data.type === 'compute-bot-turn') {
    const requestId = data.requestId;
    try {
      const ctx = await decryptPayload(data.encrypted);
      if (!ctx || !Array.isArray(ctx.legal) || !ctx.legal.length) {
        self.postMessage({ type: 'compute-bot-error', requestId, error: 'empty legal' });
        return;
      }
      // MCTSで最善手を決定（2秒budgetはctx.paramsに含まれて送られてくる）
      let chosen = null;
      try {
        chosen = chooseCardWithMCTS(ctx);
      } catch (err) {
        // MCTSで失敗したらヒューリスティックにフォールバック
        try { chosen = chooseCardToPlay(ctx); } catch {}
      }
      if (!chosen || !ctx.legal.some(c => c.id === chosen.id)) {
        chosen = ctx.legal[Math.floor(Math.random() * ctx.legal.length)];
      }
      self.postMessage({
        type: 'compute-bot-result',
        requestId,
        cardId: chosen.id,
        source: 'host-mcts'
      });
    } catch (err) {
      self.postMessage({ type: 'compute-bot-error', requestId, error: String(err && err.message || err) });
    }
    return;
  }

  // --- 既存: 並列MCTS計算（app.js の computeBotPlay から呼ばれる） ---
  if (data.type === 'calculate') {
    try {
      const stats = getMCTSStats(data.ctx);
      self.postMessage({ type: 'result', stats });
    } catch (error) {
      self.postMessage({ type: 'error', error: String(error && error.message || error) });
    }
    return;
  }
};
