// ============================================================
// js/screens/profile.js
// 依存: js/core.js, js/api.js
// 役割: アカウント登録・ログイン・プロフィールサマリ・マイページ統計
// ============================================================
import { $, g, screen, escapeHTML, toast } from '../core.js';
import {
  registerAccount, loginAccount, fetchAccountMe,
  getSessionToken, setSessionToken
} from '../api.js';

// ---------------- トップバー + プロフィールサマリ ----------------
export function renderAccount() {
  if (!g.account) return;
  $('profile-open').textContent = 'PROFILE';
  $('account-chip').textContent = 'ID ' + g.account.id + ' · ' + g.account.rating;
  $('account-chip').classList.remove('hidden');
  $('account-chip').onclick = records;
  $('profile-form').classList.add('hidden');
  $('profile-summary').classList.remove('hidden');
  $('profile-summary').innerHTML = '<div class="profile-emblem">♠</div>'
    + '<div><div class="eyebrow">PLAYER CARD</div>'
    + '<div class="profile-summary-id">' + escapeHTML(g.account.id) + '</div>'
    + '<div class="micro-copy">RATE ' + g.account.rating + ' · ' + g.account.wins + 'W · ' + g.account.losses + 'L</div>'
    + '</div><button type="button" id="open-my-page" class="secondary-button">VIEW PROFILE</button>';
  document.getElementById('open-my-page').onclick = records;
}

// ---------------- 登録 / ログイン ----------------
// path は '/api/account/register' または '/api/account/login'
export async function account(path) {
  const id = $('account-id').value.trim();
  const password = $('account-password').value;
  if (!id || !password) { toast('IDとパスワードを入力してください'); return; }
  try {
    const isRegister = path.endsWith('register');
    const d = isRegister
      ? await registerAccount(id, password)
      : await loginAccount(id, password);
    g.account = d;
    g.sessionToken = d.sessionToken || null;
    if (d.sessionToken) setSessionToken(d.sessionToken);
    renderAccount();
    toast(isRegister ? '登録しました' : 'ログインしました');
    records();
  } catch (e) {
    toast(e.message);
  }
}

// ---------------- マイページ統計 ----------------
export async function records() {
  screen('records-screen');
  const token = getSessionToken();
  if (!token) {
    $('records-content').innerHTML =
      '<p class="subcopy">REGISTER TO UNLOCK PLAYER STATS.</p>'
      + '<button id="records-register" class="primary-button">プレイヤー登録</button>';
    $('records-register').onclick = () => screen('profile-screen');
    return;
  }
  try {
    const d = await fetchAccountMe(token);
    if (!d) throw Error('UNABLE TO LOAD PLAYER STATS.');
    g.account = d;
    renderAccount();

    const perf = d.performance || {}, prec = d.precision || {}, ally = d.allyFeed || {};
    const bold = d.boldBid || {}, art = d.artRate || {}, ms = d.matchStats || {};

    const napAtt = Number(perf.declarer_attempts) || 0;
    const napWins = Number(perf.declarer_successes) || 0;
    const napWinRate = napAtt ? napWins / napAtt : 0;
    const exactAtt = Number(prec.exact_attempts) || 0;
    const exactWins = Number(prec.exact_successes) || 0;
    const exactRate = exactAtt ? exactWins / exactAtt : 0;
    const boldAtt = Number(bold.attempts) || 0;
    const boldWins = Number(bold.successes) || 0;
    const boldRate = boldAtt ? boldWins / boldAtt : 0;
    const soloAtt = Number(prec.solo_attempts) || 0;
    const soloWins = Number(prec.solo_successes) || 0;
    const soloRate = soloAtt ? soloWins / soloAtt : 0;
    const depAtt = Number(perf.deputy_attempts) || 0;
    const depWins = Number(perf.deputy_successes) || 0;
    const depWinRate = depAtt ? depWins / depAtt : 0;
    const feedAtt = Number(ally.attempts) || 0;
    const feedWins = Number(ally.successes) || 0;
    const feedRate = feedAtt ? feedWins / feedAtt : 0;
    const artAtt = Number(art.attempts) || 0;
    const artPlays = Number(art.plays) || 0;
    const artRate = artAtt ? artPlays / artAtt : 0;
    const bidTotal = Number(ms.bid_total) || 0;
    const avgBid = napAtt ? bidTotal / napAtt : 0;
    const matchCount = Number(ms.match_count) || 0;
    const napRatio = matchCount ? napAtt / (matchCount * 10) : 0;

    const r1 = Number(ms.rank_1) || 0, r2 = Number(ms.rank_2) || 0, r3 = Number(ms.rank_3) || 0;
    const r4 = Number(ms.rank_4) || 0, r5 = Number(ms.rank_5) || 0;
    const totalRanks = r1 + r2 + r3 + r4 + r5;
    const avgRank = totalRanks ? (r1 * 1 + r2 * 2 + r3 * 3 + r4 * 4 + r5 * 5) / totalRanks : 0;
    const rankScore = totalRanks ? Math.max(0, Math.min(1, (5 - avgRank) / 4)) : 0;
    const napScore = napAtt > 0 ? Math.round((napWinRate * 0.65 + exactRate * 0.25 + boldRate * 0.05 + soloRate * 0.05) * 100) : null;
    const depScore = depAtt > 0 ? Math.round((depWinRate * 0.75 + feedRate * 0.25) * 100) : null;
    const allScore = totalRanks > 0 ? Math.round((rankScore * 0.7 + artRate * 0.3) * 100) : null;
    const pct = v => (v * 100).toFixed(1) + '%';
    const scoreText = s => s === null ? '—' : String(s);
    const barW = s => s === null ? 0 : s;
    const scoreUnit = s => s === null ? '' : '<small>/100</small>';

    $('records-content').innerHTML = `
      <div class="mypage-head">
        <div class="profile-emblem large">♠</div>
        <div class="mypage-identity"><div class="eyebrow">PLAYER CARD</div><h2>${escapeHTML(d.id)}</h2></div>
        <div class="mypage-rating"><span>RATE</span><strong>${d.rating}</strong></div>
      </div>
      <div class="record-stats">
        <div class="record-stat"><span>MATCHES</span><b>${d.games}</b></div>
        <div class="record-stat"><span>WINS</span><b>${d.wins}</b></div>
        <div class="record-stat"><span>LOSSES</span><b>${d.losses}</b></div>
      </div>
      <section class="performance-section"><h3 class="section-title">パフォーマンス指標</h3>
        <div class="performance-grid">
          <article class="performance-card"><span>平均立ち成功率</span><strong>${napAtt > 0 ? pct(napWinRate) : '—'}</strong><small>${napWins} / ${napAtt}</small></article>
          <article class="performance-card"><span>平均宣言数</span><strong>${avgBid > 0 ? avgBid.toFixed(1) + '枚' : '—'}</strong><small>${napAtt > 0 ? napAtt + '回の立ち' : '実績なし'}</small></article>
          <article class="performance-card"><span>ナポレオン率</span><strong>${matchCount > 0 ? pct(napRatio) : '—'}</strong><small>${matchCount > 0 ? (matchCount * 10) + '局中' + napAtt + '回' : '実績なし'}</small></article>
        </div>
      </section>
      <section class="role-skill-section"><h3 class="section-title">役割別実力</h3>
        <div class="role-skill-grid">
          <article class="role-skill role-nap">
            <div class="role-skill-head"><div class="role-emblem">♠</div><div class="role-title"><span class="eyebrow">NAPOLEON</span><div class="role-score">${scoreText(napScore)}${scoreUnit(napScore)}</div></div></div>
            <div class="skill-bar"><div style="width:${barW(napScore)}%"></div></div>
            <div class="skill-rows">
              <div><span>立ち成功率</span><b>${napAtt > 0 ? pct(napWinRate) : '—'}</b></div>
              <div><span>EXACT率</span><b>${exactAtt > 0 ? pct(exactRate) : '—'}</b></div>
              <div><span>BOLD成功率</span><b>${boldAtt > 0 ? pct(boldRate) : '—'}</b></div>
              <div><span>SOLO成功率</span><b>${soloAtt > 0 ? pct(soloRate) : '—'}</b></div>
            </div>
          </article>
          <article class="role-skill role-dep">
            <div class="role-skill-head"><div class="role-emblem">♣</div><div class="role-title"><span class="eyebrow">DEPUTY</span><div class="role-score">${scoreText(depScore)}${scoreUnit(depScore)}</div></div></div>
            <div class="skill-bar"><div style="width:${barW(depScore)}%"></div></div>
            <div class="skill-rows">
              <div><span>副官成功率</span><b>${depAtt > 0 ? pct(depWinRate) : '—'}</b></div>
              <div><span>絵札回し成功率</span><b>${feedAtt > 0 ? pct(feedRate) : '—'}</b></div>
              <div><span>副官経験</span><b>${depAtt > 0 ? depAtt + '回' : '—'}</b></div>
            </div>
          </article>
          <article class="role-skill role-all">
            <div class="role-skill-head"><div class="role-emblem">♥</div><div class="role-title"><span class="eyebrow">ALLIANCE</span><div class="role-score">${scoreText(allScore)}${scoreUnit(allScore)}</div></div></div>
            <div class="skill-bar"><div style="width:${barW(allScore)}%"></div></div>
            <div class="skill-rows">
              <div><span>平均順位</span><b>${totalRanks > 0 ? avgRank.toFixed(2) + '位' : '—'}</b></div>
              <div><span>1位率</span><b>${totalRanks > 0 ? pct(r1 / totalRanks) : '—'}</b></div>
              <div><span>4〜5位率</span><b>${totalRanks > 0 ? pct((r4 + r5) / totalRanks) : '—'}</b></div>
              <div><span>アート成功率</span><b>${artAtt > 0 ? pct(artRate) : '—'}</b></div>
            </div>
          </article>
        </div>
      </section>
    `;
  } catch (e) {
    $('records-content').textContent = 'UNABLE TO LOAD PLAYER STATS.';
  }
}
