// run-selfplay.mjs
// GitHub Actionsから呼び出され、自己対戦を実行して結果をCloudflare D1に保存するスクリプト
import { runSelfPlayBatch } from './ai-simulator.js';
import { defaultStrategy } from './constants.js';

// Cloudflare D1のHTTP APIを叩いてSQLを一括実行する関数
async function executeD1Request(queries) {
  const token = process.env.CLOUDFLARE_API_TOKEN;
  const accountId = process.env.CLOUDFLARE_ACCOUNT_ID;
  const dbId = process.env.D1_DATABASE_ID;

  if (!token || !accountId || !dbId) {
    throw new Error("環境変数 (CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID, D1_DATABASE_ID) が設定されていません。");
  }

  if (!queries || queries.length === 0) return { success: true, results: [] };

  const url = `https://api.cloudflare.com/client/v4/accounts/${accountId}/d1/database/${dbId}/query`;
  
  // D1 APIのバッチリクエスト形式
  const body = {
    batch: queries.map(q => ({
      sql: q.sql,
      params: q.params || []
    }))
  };

  // タイムアウト設定（60秒）
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 60000);

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(body),
      signal: controller.signal
    });

    const data = await response.json();
    if (!response.ok || !data.success) {
      throw new Error("D1 Batch Query Error: " + JSON.stringify(data.errors || data));
    }
    return data.result;
  } catch (err) {
    if (err.name === 'AbortError') {
      throw new Error("D1 API Timeout (60s)");
    }
    throw err;
  } finally {
    clearTimeout(timeoutId);
  }
}

// ai-simulator.js が期待する env.DB の形をエミュレート（モック化）する
const mockDB = {
  prepare: (query) => {
    return {
      _sql: query,
      _params: [],
      bind: function(...args) {
        this._params = args;
        return this;
      },
      run: async function() {
        const result = await executeD1Request([{ sql: this._sql, params: this._params }]);
        return result[0] || {};
      },
      all: async function() {
        const result = await executeD1Request([{ sql: this._sql, params: this._params }]);
        return { results: result[0]?.results || [] };
      },
      first: async function() {
        const result = await executeD1Request([{ sql: this._sql, params: this._params }]);
        return result[0]?.results?.[0] || null;
      }
    };
  },
  batch: async (statements) => {
    const queries = statements.map(stmt => ({
      sql: stmt._sql,
      params: stmt._params
    }));
    await executeD1Request(queries);
    return { success: true };
  }
};

async function main() {
  const args = process.argv.slice(2);
  const matchCount = parseInt(args[0], 10) || 5; 
  
  console.log(`自己対戦バッチを開始します... (${matchCount}マッチ)`);
  
  const env = { DB: mockDB };
  
  const startTime = Date.now();
  try {
    const result = await runSelfPlayBatch(env, matchCount);
    const duration = ((Date.now() - startTime) / 1000).toFixed(1);
    console.log(`自己対戦とD1への保存が完了しました (${duration}秒):`, result);
  } catch (e) {
    console.error('自己対戦中にエラーが発生しました:', e);
    process.exit(1);
  }
}

main();
