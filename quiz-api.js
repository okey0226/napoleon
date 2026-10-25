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

export async function handleQuizRequest(request, env, url) {
  // GET /api/quiz/progress
  if (url.pathname === '/api/quiz/progress' && request.method === 'GET') {
    const userId = await getSessionUser(request, env);
    if (!userId) return Response.json({ error: 'auth required' }, { status: 401 });
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
      return Response.json({ total: totalQuestionCount(), answered: answeredIds.size, perCategory, nextQuestionId: nextId });
    } catch (e) { return Response.json({ error: e.message }, { status: 500 }); }
  }

  // GET /api/quiz/q/:id
  const mQ = /^\/api\/quiz\/q\/([a-z]+-\d{1,4})$/.exec(url.pathname);
  if (mQ && request.method === 'GET') {
    const userId = await getSessionUser(request, env);
    const question = getQuestion(mQ[1]);
    if (!question) return Response.json({ error: 'not found' }, { status: 404 });
    let myAnswer = null;
    try {
      if (userId) {
        const row = await env.DB.prepare("SELECT choice_index FROM quiz_answers WHERE user_id=? AND question_id=?").bind(userId, question.id).first();
        myAnswer = row ? row.choice_index : null;
      }
    } catch {}
    const reveal = myAnswer !== null;
    let stats = [], totalAnswers = 0;
    if (reveal) {
      try {
        const { results } = await env.DB.prepare("SELECT choice_index, COUNT(*) AS c FROM quiz_answers WHERE question_id=? GROUP BY choice_index").bind(question.id).all();
        const map = new Map((results || []).map(r => [Number(r.choice_index), Number(r.c)]));
        stats = question.options.map(o => ({ index: o.index, count: map.get(o.index) || 0 }));
        totalAnswers = stats.reduce((n, s) => n + s.count, 0);
      } catch {}
    }
    return Response.json({
      id: question.id, category: question.category, title: question.title,
      scenario: question.scenario, options: question.options,
      myAnswer, reveal,
      stats: reveal ? stats : null,
      totalAnswers: reveal ? totalAnswers : null,
      aiAnswerIndex: reveal ? question.aiAnswerIndex : null,
      explanation: reveal ? question.explanation : null
    });
  }

  // POST /api/quiz/answer
  if (url.pathname === '/api/quiz/answer' && request.method === 'POST') {
    const userId = await getSessionUser(request, env);
    if (!userId) return Response.json({ error: 'auth required' }, { status: 401 });
    let body;
    try { body = await request.json(); } catch { return Response.json({ error: 'invalid' }, { status: 400 }); }
    const questionId = String(body.questionId || '');
    const choice = Number(body.choiceIndex);
    const question = getQuestion(questionId);
    if (!question) return Response.json({ error: 'question not found' }, { status: 404 });
    if (!Number.isInteger(choice) || choice < 0 || choice >= question.options.length) return Response.json({ error: 'invalid choice' }, { status: 400 });
    try {
      await env.DB.prepare("INSERT INTO quiz_answers(user_id, question_id, choice_index) VALUES(?,?,?)").bind(userId, questionId, choice).run();
    } catch (e) {
      const msg = String(e.message || '').toLowerCase();
      if (msg.includes('unique') || msg.includes('primary key')) return Response.json({ error: 'already answered' }, { status: 409 });
      return Response.json({ error: e.message }, { status: 500 });
    }
    const { results } = await env.DB.prepare("SELECT choice_index, COUNT(*) AS c FROM quiz_answers WHERE question_id=? GROUP BY choice_index").bind(questionId).all();
    const map = new Map((results || []).map(r => [Number(r.choice_index), Number(r.c)]));
    const stats = question.options.map(o => ({ index: o.index, count: map.get(o.index) || 0 }));
    const totalAnswers = stats.reduce((n, s) => n + s.count, 0);
    return Response.json({ ok: true, myAnswer: choice, aiAnswerIndex: question.aiAnswerIndex, stats, totalAnswers, explanation: question.explanation });
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
          distribution: question.options.map((o, i) => ({ index: i, label: o.label, count: dist.find(d => d.index === i)?.count || 0, isAI: i === question.aiAnswerIndex }))
        });
      }
      out.sort((a, b) => b.total - a.total);
      return Response.json({ all: out.slice(0, 50), disagreements: out.filter(o => !o.aiAgrees && o.agreement >= 0.5) });
    } catch (e) { return Response.json({ error: e.message }, { status: 500 }); }
  }

  // GET /api/quiz/questions
  if (url.pathname === '/api/quiz/questions' && request.method === 'GET') {
    const category = url.searchParams.get('category') || null;
    const offset = Math.max(0, Number(url.searchParams.get('offset')) || 0);
    const limit = Math.min(50, Math.max(1, Number(url.searchParams.get('limit')) || 20));
    const userId = await getSessionUser(request, env);
    const list = listQuestions({ category, offset, limit });
    let answeredIds = new Set();
    try {
      if (userId && list.length) {
        const ids = list.map(q => q.id);
        const ph = ids.map(() => '?').join(',');
        const { results } = await env.DB.prepare(`SELECT question_id FROM quiz_answers WHERE user_id=? AND question_id IN (${ph})`).bind(userId, ...ids).all();
        answeredIds = new Set((results || []).map(r => r.question_id));
      }
    } catch {}
    return Response.json({ total: totalQuestionCount(), items: list.map(q => ({ ...q, answered: answeredIds.has(q.id) })) });
  }

  return null;
}
