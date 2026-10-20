// ============================================================
// js/screens/strategy.js
// 依存: js/core.js, js/api.js
// 役割: AI 自己対戦戦略の表示・自己対戦実行
// ============================================================
import { $, escapeHTML } from '../core.js';
import {
  fetchStrategies, fetchInsights, fetchGenerations,
  loadTopStrategy, runSelfPlay, setupDb
} from '../api.js';

const PARAM_NAMES = {
  bidThreshold: '立ち強度', riskTolerance: 'リスク許容', leadAggression: 'リード積極性',
  followAggression: 'フォロー積極性', trumpBonus: '切り札評価', mightyBonus: 'マイティ評価',
  safeAceWeight: 'A温存', roleCardPreservation: '役札温存', deputyFeedBias: '副官の絵札回し'
};

export async function loadStrategyLab() {
  const wrap = $('strategy-content');
  if (!wrap) return;
  wrap.innerHTML = '<p class="subcopy">戦略を読み込み中…</p>';
  try {
    const [strategies, insights, generations] = await Promise.all([
      fetchStrategies(10),
      fetchInsights(),
      fetchGenerations()
    ]);
    renderStrategyLab({ strategies, insights, generations });
  } catch {
    wrap.innerHTML = '<p class="subcopy">戦略を読み込めませんでした。</p>';
  }
}

function renderStrategyLab({ strategies, insights, generations }) {
  const wrap = $('strategy-content');

  // 戦略カード
  let cards = '';
  if (!strategies.length) {
    cards = '<p class="subcopy" style="padding:10px 0;">まだ学習データがありません。上の「自己対戦を実行」ボタンから学習を開始してください。</p>';
  } else {
    cards = strategies.slice(0, 5).map((s, i) => {
      const rank = i + 1;
      const delta = Number(s.avg_rating_delta || 0);
      return `<article class="strategy-card rank-${rank}">
        <div class="strategy-rank">#${rank}</div>
        <div class="strategy-meta">
          <span class="eyebrow">GEN ${s.generation} · ${s.matches}試合</span>
          <strong>${delta > 0 ? '+' : ''}${delta.toFixed(2)} <small>pt/試合</small></strong>
        </div>
        <div class="strategy-roles">
          <span>NAP ${(Number(s.nap_win_rate) * 100).toFixed(1)}%</span>
          <span>DEP ${(Number(s.deputy_win_rate) * 100).toFixed(1)}%</span>
          <span>ALLI ${(Number(s.alliance_win_rate) * 100).toFixed(1)}%</span>
        </div>
      </article>`;
    }).join('');
  }

  // パラメータ
  let paramRows = '<p class="subcopy" style="padding:10px 0;">データなし</p>';
  if (strategies.length > 0) {
    const params = JSON.parse(strategies[0].params || '{}');
    paramRows = Object.entries(params).map(([k, v]) =>
      `<div class="param-row"><span>${PARAM_NAMES[k] || k}</span><b>${Number(v).toFixed(2)}</b></div>`
    ).join('');
  }

  // インサイト
  const insightCards = insights.length > 0
    ? insights.map(ins => `<article class="insight-card"><h3>${escapeHTML(ins.title)}</h3><p>${escapeHTML(ins.detail)}</p></article>`).join('')
    : '<p class="subcopy" style="padding:10px 0;">データなし</p>';

  // 世代推移
  const genRows = generations.length > 0
    ? generations.slice(-10).map(gg => {
        const delta = Number(gg.best_delta || 0);
        return `<div class="gen-row">
          <span>Gen ${gg.generation}</span>
          <b>${delta > 0 ? '+' : ''}${delta.toFixed(2)}pt</b>
          <small>NAP ${(Number(gg.nap) * 100).toFixed(0)} / DEP ${(Number(gg.dep) * 100).toFixed(0)} / ALLI ${(Number(gg.ally) * 100).toFixed(0)}</small>
        </div>`;
      }).join('')
    : '<p class="subcopy" style="padding:10px 0;">データなし</p>';

  wrap.innerHTML = `
    <div class="strategy-actions">
      <button id="run-selfplay" class="primary-button">自己対戦を実行（100局）</button>
      <button id="refresh-strategy" class="secondary-button">再読み込み</button>
      <span id="selfplay-status" class="micro-copy"></span>
    </div>
    <section class="strategy-section"><h2>TOP STRATEGIES（レート上昇順）</h2><div class="strategy-list">${cards}</div></section>
    <section class="strategy-section"><h2>最上位戦略のパラメータ</h2><div class="param-table">${paramRows}</div></section>
    <section class="strategy-section"><h2>学習インサイト</h2><div class="insight-list">${insightCards}</div></section>
    <section class="strategy-section"><h2>世代推移</h2><div class="gen-list">${genRows}</div></section>
  `;

  $('run-selfplay').onclick = async () => {
    const btn = $('run-selfplay'), status = $('selfplay-status');
    btn.disabled = true;
    status.textContent = '自己対戦100局を実行中…（数秒かかります）';
    try {
      let data;
      try {
        data = await runSelfPlay(100);
      } catch (e) {
        if (e.message && e.message.includes('no such table')) {
          status.textContent = '初回データベースセットアップ中…';
          const ok = await setupDb();
          if (!ok) throw new Error('データベースの初期化に失敗しました');
          status.textContent = '自己対戦100局を実行中…（再試行）';
          data = await runSelfPlay(100);
        } else {
          throw e;
        }
      }
      status.textContent = `Gen ${data.generation} 完了（${data.matches}試合）`;
      await loadTopStrategy();
      await loadStrategyLab();
    } catch (e) {
      status.textContent = '実行できませんでした: ' + (e.message || 'ネットワークエラー');
    } finally {
      btn.disabled = false;
    }
  };

  $('refresh-strategy').onclick = () => loadStrategyLab();
}
