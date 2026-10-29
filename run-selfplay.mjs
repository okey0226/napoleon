// run-selfplay.mjs
// GitHub Actionsから呼び出され、自己対戦を実行して結果をCloudflare D1に保存するスクリプト
import { runSelfPlayBatch } from './ai-simulator.js';
import { defaultStrategy } from './constants.js';

// Cloudflare D1のHTTP APIを叩いてSQLを実行する関数
async function executeD1Query(sql, params = []) {
  const token = process.env.CLOUDFLARE_API_TOKEN;
  const accountId = process.env.CLOUDFLARE_ACCOUNT_ID;
  const dbId = process.env.D1_DATABASE_ID;

  if (!token || !accountId || !dbId) {
    throw new Error("環境変数 (CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID, D1_DATABASE_ID) が設定されていません。");
  }

  const url = `https://api.cloudflare.com/client/v4/accounts/${accountId}/d1/database/${dbId}/query`;
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ sql, params })
  });

  const data = await response.json();
  if (!response.ok || !data.success) {
    throw new Error("D1 Query Error: " + JSON.stringify(data.errors || data));
  }

  // Cloudflare D1のレスポンス形式に合わせて結果を返す
  return data.result[0];
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
        return await executeD1Query(this._sql, this._params);
      },
      all: async function() {
        const result = await executeD1Query(this._sql, this._params);
        return { results: result.results || [] };
      },
      first: async function() {
        const result = await executeD1Query(this._sql, this._params);
        return result.results?.[0] || null;
      }
    };
  },
  batch: async (statements) => {
    // バッチ処理は1つずつ実行（D1 APIの制限回避のため）
    for (const stmt of statements) {
      await executeD1Query(stmt._sql, stmt._params);
    }
    return { success: true };
  }
};

async function main() {
  // コマンドライン引数から実行するマッチ数を取得（デフォルトは100マッチ）
  const args = process.argv.slice(2);
  const matchCount = parseInt(args[0], 10) || 100;
  
  console.log(`自己対戦バッチを開始します... (${matchCount}マッチ)`);
  
  const env = { DB: mockDB };
  
  try {
    const result = await runSelfPlayBatch(env, matchCount);
    console.log('自己対戦とD1への保存が完了しました:', result);
  } catch (e) {
    console.error('自己対戦中にエラーが発生しました:', e);
    process.exit(1);
  }
}

main();
