// ============================================================
// js/screens/home.js
// 依存: js/core.js, js/api.js, js/screens/profile.js (renderAccount)
// 役割: ホーム画面のランキング・自分のレート・オンライン同接表示
// ============================================================
import { $, g, screen, escapeHTML } from '../core.js';
import { fetchLeaderboard, fetchAccountMe, getSessionToken, clearSessionToken } from '../api.js';
import { renderAccount } from './profile.js';

// ---------------- 自分のレート表示 ----------------
export function renderHomeRating(d) {
  const box = $('my-rating');
  if (!box) return;
  if (!d) { box.classList.add('hidden'); return; }
  box.classList.remove('hidden');
  if (d.unregistered) {
    box.innerHTML = '<div class="rating-signup"><div>'
      + '<div class="eyebrow">YOUR RATING</div>'
      + '<h2>BUILD YOUR RATING</h2>'
      + '<p>REGISTER TO TRACK YOUR RATE AND MATCH HISTORY.</p>'
      + '</div><button id="rating-register" class="secondary-button">REGISTER</button></div>';
    $('rating-register').onclick = () => screen('profile-screen');
    return;
  }
  box.classList.add('hidden');
}

// ---------------- アカウント読込 ----------------
export async function loadAccount() {
  const token = getSessionToken();
  if (!token) {
    renderHomeRating({ unregistered: true });
    return;
  }
  try {
    const acc = await fetchAccountMe(token);
    if (acc) {
      g.account = acc;
      g.sessionToken = token;
      renderAccount();
      renderHomeRating(g.account);
    } else {
      clearSessionToken();
      g.sessionToken = null;
      renderHomeRating({ unregistered: true });
    }
  } catch {}
}

// ---------------- ランキング ----------------
export async function loadLeaderboard() {
  const section = $('leaderboard');
  const box = $('rating-leaders');
  if (!section || !box) return;
  try {
    const data = await fetchLeaderboard();
    if (!data) throw Error();
    const leaders = data.slice(0, g.leaderboardExpanded ? 50 : 3);
    if (!leaders.length) { section.classList.add('hidden'); return; }
    section.classList.remove('hidden');
    box.classList.toggle('expanded', g.leaderboardExpanded);
    $('show-ranking').textContent = g.leaderboardExpanded ? 'TOP 3' : 'VIEW TOP 50';
    $('show-ranking').setAttribute('aria-expanded', String(g.leaderboardExpanded));
    box.innerHTML = leaders.map((player, i) => {
      const username = String(player.username || player.id || 'player');
      const href = 'https://websim.com/@' + encodeURIComponent(username);
      const avatar = 'https://images.websim.com/avatar/' + encodeURIComponent(username);
      return '<article class="rating-leader rank-' + (i + 1) + '">'
        + '<span class="leader-place">' + String(i + 1).padStart(2, '0') + '</span>'
        + '<a class="leader-person" href="' + escapeHTML(href) + '" target="_blank" rel="noopener noreferrer">'
        + '<img src="' + escapeHTML(avatar) + '" alt="" loading="lazy">'
        + '<span>@' + escapeHTML(username) + '</span></a>'
        + '<strong>' + Number(player.rating || 0) + '<small> pt</small></strong>'
        + '</article>';
    }).join('');
  } catch {
    section.classList.add('hidden');
  }
}

export function toggleLeaderboard() {
  g.leaderboardExpanded = !g.leaderboardExpanded;
  loadLeaderboard();
}

// ---------------- 同接数（presence） ----------------
export function startPresence() {
  if (g.presenceRoom || !window.WebsimSocket?.joinRoom) return;
  const pending = window.WebsimSocket.joinRoom();
  g.presenceRoom = pending;
  pending.then(room => {
    if (g.presenceRoom !== pending) { room.close?.(); return; }
    g.presenceRoom = room;
    room.onmessage = e => {
      let m; try { m = JSON.parse(e.data); } catch { return; }
      if (m.type === 'presence') {
        const el = $('concurrent-count');
        if (el) el.textContent = '同接: ' + m.count + '人';
      }
    };
  }).catch(() => { if (g.presenceRoom === pending) g.presenceRoom = null; });
}

export async function stopPresence() {
  const current = g.presenceRoom;
  g.presenceRoom = null;
  try { (await current)?.close?.(); } catch {}
}
