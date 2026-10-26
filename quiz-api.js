// quiz-api.js — 何切るAPI（worker.jsから呼ばれる）
import { getQuestion, listQuestions, QUIZ_CATEGORIES, QUIZ_COUNTS, totalQuestionCount } from './quiz-questions.js';

export const quizSchema = [
  "CREATE TABLE IF NOT EXISTS quiz_answers (user_id TEXT NOT NULL, question_id TEXT NOT NULL, choice_index INTEGER NOT NULL, answered_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, PRIMARY KEY (user_id, question_id))",
  "CREATE INDEX IF NOT EXISTS quiz_answers_q ON quiz_answers(question_id)",
  "CREATE INDEX IF NOT EXISTS quiz_answers_u ON quiz_answers(user_id)",
  "CREATE TABLE IF NOT EXISTS quiz_insights (id INTEGER PRIMARY KEY AUTOINCREMENT, question_id TEXT NOT NULL UNIQUE, human_majority INTEGER NOT NULL, ai_answer INTEGER NOT NULL, agreement_rate REAL NOT NULL, total_answers INTEGER NOT NULL, synced_at TEXT, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)"
];

async function getSessionUser(request, env) {
  const token = request.headers.get('x-session-token');
  if (!token) return null;
  try {
    const sess = await env.DB.prepare("SELECT user_id FROM sessions WHERE token=? AND expires_at>?").bind(token, Date.now()).first();
    return sess?.user_id || null;
  } catch { return null; }
}

function inferCategory(id) {
  if (typeof id !== 'string') return '';
  if (id.includes('-')) return id.split('-')[0];
  return '';
}

// キャッシュを無効化するラッパー
function noCacheJson(data, init = {}) {
  const headers = Object.assign({}, init.headers || {}, {
    'content-type': 'application/json',
    'cache-control': 'no-store, max-age=0'
  });
  return new Response(JSON.stringify(data), Object.assign({}, init, { headers }));
}

export async function handleQuizRequest(request, env, url) {
  // GET /api/quiz/progress
  if (url.pathname === '/api/quiz/progress' && request.method === 'GET') {
    const userId = await getSessionUser(request, env);
    if (!userId) return noCacheJson({ error: 'auth required' }, { status: 401 });
    try {
      const { results } = await env.DB.prepare("SELECT question_id FROM quiz_answers WHERE user_id=?").bind(userId).all();
      const answeredIds = new Set((results || []).map(r => r.question_id));
      const perCategory = {};
      let nextId = null;
      for (const c of QUIZ_CATEGORIES) {
        let answered = 0;
        for (let i = 0; i < QUIZ_COUNTS[c]; i++) {
          const id = `${c}-${String(i + 1).padStart(4, '0')}`;
          if (answeredIds.has(id)) answered++;
          else if (!nextId) nextId = id;
        }
        perCategory[c] = { answered, total: QUIZ_COUNTS[c] };
      }
      return noCacheJson({ total: totalQuestionCount(), answered: answeredIds.size, perCategory, nextQuestionId: nextId });
    } catch (e) { return noCacheJson({ error: e.message }, { status: 500 }); }
  }

  // GET /api/quiz/q/:id
  const mQ = /^\/api\/quiz\/q\/([a-z]+-\d{1,4})$/.exec(url.pathname);
  if (mQ && request.method === 'GET') {
    const userId = await getSessionUser(request, env);
    
    let question = null;
    try {
      question = getQuestion(mQ[1]);
    } catch (e) {
      return noCacheJson({ error: '問題生成エラー: ' + e.message }, { status: 500 });
    }

    if (!question) {
      const cat = inferCategory(mQ[1]);
      if (!cat) return noCacheJson({ error: 'not found' }, { status: 404 });
      question = { id: mQ[1], category: cat, title: '不明', scenario: {}, options: [], aiAnswerIndex: 0, explanation: '' };
    }

    const category = question.category || inferCategory(question.id);

    let myAnswer = null;
    try {
      if (userId) {
        const row = await env.DB.prepare("SELECT choice_index FROM quiz_answers WHERE user_id=? AND question_id=?").bind(userId, question.id).first();
        myAnswer = row ? Number(row.choice_index) : null;
      }
    } catch {}
    const reveal = myAnswer !== null;

    let stats = [], totalAnswers = 0;
    if (reveal) {
      try {
        const { results } = await env.DB.prepare("SELECT choice_index, COUNT(*) AS c FROM quiz_answers WHERE question_id=? GROUP BY choice_index").bind(question.id).all();
        const map = new Map((results || []).map(r => [Number(r.choice_index), Number(r.c)]));
        stats = (question.options || []).map(o => ({ index: o.index, count: map.get(o.index) || 0 }));
        totalAnswers = stats.reduce((n, s) => n + s.count, 0);
      } catch {}
    }
    return noCacheJson({
      id: question.id, 
      category: category,
      title: question.title || '',
      scenario: question.scenario || {}, 
      options: question.options || [],
      myAnswer, reveal,
      stats: reveal ? stats : null,
      totalAnswers: reveal ? totalAnswers : null,
      aiAnswerIndex: reveal ? (question.aiAnswerIndex ?? 0) : null,
      explanation: reveal ? (question.explanation || '') : null
    });
  }

  // POST /api/quiz/answer
  if (url.pathname === '/api/quiz/answer' && request.method === 'POST') {
    const userId = await getSessionUser(request, env);
    if (!userId) return noCacheJson({ error: 'auth required' }, { status: 401 });
    let body;
    try { body = await request.json(); } catch { return noCacheJson({ error: 'invalid' }, { status: 400 }); }
    const questionId = String(body.questionId || '');
    const choice = Number(body.choiceIndex);
    
    const question = getQuestion(questionId);
    if (!question) return noCacheJson({ error: 'question not found' }, { status: 404 });
    if (!Number.isInteger(choice) || choice < 0 || choice >= (question.options?.length || 0)) {
      return noCacheJson({ error: 'invalid choice' }, { status: 400 });
    }

    try {
      await env.DB.prepare("INSERT INTO quiz_answers(user_id, question_id, choice_index) VALUES(?,?,?)").bind(userId, questionId, choice).run();
    } catch (e) {
      const msg = String(e.message || '').toLowerCase();
      if (msg.includes('unique') || msg.includes('primary key')) return noCacheJson({ error: 'already answered' }, { status: 409 });
      return noCacheJson({ error: e.message }, { status: 500 });
    }
    return noCacheJson({ ok: true, myAnswer: choice });
  }

  // GET /api/quiz/insights
  if (url.pathname === '/api/quiz/insights' && request.method === 'GET') {
    try {
      const { results } = await env.DB.prepare(`SELECT question_id, choice_index, COUNT(*) AS c FROM quiz_answers GROUP BY question_id, choice_index`).all();
      const byQ = new Map();
      for (const r of (results || [])) {
        if (!byQ.has(r.question_id)) byQ.set(r.question_id, []);
        byQ.get(r.question_id).push({ index: Number(r.choice_index), count: Number(r.c) });
      }
      const out = [];
      for (const [qid, dist] of byQ) {
        const total = dist.reduce((n, d) => n + d.count, 0);
        if (total < 5) continue;
        const question = getQuestion(qid);
        if (!question) continue;
        const sorted = dist.slice().sort((a, b) => b.count - a.count);
        const majorityIdx = sorted[0].index;
        const agreement = sorted[0].count / total;
        out.push({
          questionId: qid, category: question.category, title: question.title, total, majorityIdx, agreement,
          aiAnswerIndex: question.aiAnswerIndex, aiAgrees: majorityIdx === question.aiAnswerIndex,
          distribution: (question.options || []).map((o, i) => ({ index: i, label: o.label, count: dist.find(d => d.index === i)?.count || 0, isAI: i === question.aiAnswerIndex }))
        });
      }
      out.sort((a, b) => b.total - a.total);
      return noCacheJson({ all: out.slice(0, 50), disagreements: out.filter(o => !o.aiAgrees && o.agreement >= 0.5) });
    } catch (e) { return noCacheJson({ error: e.message }, { status: 500 }); }
  }

  return null;
}
