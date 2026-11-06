// quiz-api.js — 何切るAPI（worker.jsから呼ばれる）
import { getQuestion, listQuestions, QUIZ_CATEGORIES, QUIZ_COUNTS, totalQuestionCount, makeQuestionId } from './quiz-questions.js';

export const quizSchema = [
  "CREATE TABLE IF NOT EXISTS quiz_answers (user_id TEXT NOT NULL, question_id TEXT NOT NULL, choice_index INTEGER NOT NULL, answered_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, PRIMARY KEY (user_id, question_id))",
  "CREATE INDEX IF NOT EXISTS quiz_answers_q ON quiz_answers(question_id)",
  "CREATE INDEX IF NOT EXISTS quiz_answers_u ON quiz_answers(user_id)",
  "CREATE TABLE IF NOT EXISTS quiz_insights (id INTEGER PRIMARY KEY AUTOINCREMENT, question_id TEXT NOT NULL UNIQUE, human_majority INTEGER NOT NULL, ai_answer INTEGER NOT NULL, agreement_rate REAL NOT NULL, total_answers INTEGER NOT NULL, synced_at TEXT, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)",
  "CREATE TABLE IF NOT EXISTS quiz_candidates (id TEXT PRIMARY KEY, category TEXT NOT NULL DEFAULT 'play', scenario_json TEXT NOT NULL, options_json TEXT NOT NULL, ai_answer_index INTEGER NOT NULL, reason TEXT NOT NULL, explanation TEXT, generation INTEGER, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)",
  "CREATE INDEX IF NOT EXISTS quiz_candidates_reason ON quiz_candidates(reason)",
  // ★ 新規: 捨て札戦略評価指標テーブル
  "CREATE TABLE IF NOT EXISTS ai_discard_metrics (id INTEGER PRIMARY KEY AUTOINCREMENT, generation INTEGER NOT NULL, strategy_index INTEGER NOT NULL, avg_ev_loss REAL NOT NULL DEFAULT 0, optimal_rate REAL NOT NULL DEFAULT 0, void_choice_rate REAL NOT NULL DEFAULT 0, close_call_rate REAL NOT NULL DEFAULT 0, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)",
  "CREATE INDEX IF NOT EXISTS ai_discard_metrics_gen ON ai_discard_metrics(generation DESC)"
];

async function getSessionUser(request, env) {
  const token = request.headers.get('x-session-token');
  if (!token) return null;
  try {
    const sess = await env.DB.prepare("SELECT user_id FROM sessions WHERE token=? AND expires_at>?").bind(token, Date.now()).first();
    return sess?.user_id || null;
  } catch { return null; }
}

function noCacheJson(data, init = {}) {
  const headers = Object.assign({}, init.headers || {}, {
    'content-type': 'application/json',
    'cache-control': 'no-store, max-age=0'
  });
  return new Response(JSON.stringify(data), Object.assign({}, init, { headers }));
}

// ★ 修正: 静的クイズと動的候補を統合して解決する関数
async function resolveQuestion(id, env) {
  if (!id) return null;
  if (id.startsWith('gen-')) {
    try {
      const row = await env.DB.prepare("SELECT * FROM quiz_candidates WHERE id=?").bind(id).first();
      if (!row) return null;
      const scenario = JSON.parse(row.scenario_json);
      if (!scenario.contract || scenario.contract.num === undefined) {
        return null;
      }
      return {
        id: row.id,
        category: row.category || 'play',
        scenario: scenario,
        options: JSON.parse(row.options_json),
        aiAnswerIndex: row.ai_answer_index,
        explanation: row.explanation || '',
        generated: true
      };
    } catch (e) {
      console.error('resolveQuestion (dynamic) error:', e);
      return null;
    }
  }
  try {
    return getQuestion(id);
  } catch (e) {
    console.error('resolveQuestion (static) error:', e);
    return null;
  }
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
      const unanswered = [];
      let grandTotal = 0;
      let grandAnswered = 0;

      // 静的クイズの集計
      for (const c of QUIZ_CATEGORIES) {
        let answered = 0;
        let validTotal = 0;
        for (let i = 0; i < QUIZ_COUNTS[c]; i++) {
          const id = makeQuestionId(c, i);
          // ★ 修正: discard カテゴリは生成失敗する可能性があるため、存在チェック
          if (c === 'discard' && !getQuestion(id)) continue;
          validTotal++;
          if (answeredIds.has(id)) answered++;
          else unanswered.push(id);
        }
        perCategory[c] = { answered, total: validTotal };
        grandTotal += validTotal;
        grandAnswered += answered;
      }

      // 動的候補問題の集計（playカテゴリに加算）
      let candidateTotal = 0;
      let candidateAnswered = 0;
      try {
        const { results: candRows } = await env.DB.prepare(
          "SELECT id FROM quiz_candidates ORDER BY created_at ASC"
        ).all();
        candidateTotal = (candRows || []).length;
        for (const r of (candRows || [])) {
          if (answeredIds.has(r.id)) candidateAnswered++;
          else unanswered.push(r.id);
        }
      } catch (e) {
        console.warn('quiz_candidates query failed', e);
      }

      if (perCategory['play']) {
        perCategory['play'].total += candidateTotal;
        perCategory['play'].answered += candidateAnswered;
      }
      grandTotal += candidateTotal;
      grandAnswered += candidateAnswered;

      const nextId = unanswered.length > 0
        ? unanswered[Math.floor(Math.random() * unanswered.length)]
        : null;

      return noCacheJson({
        total: grandTotal,
        answered: grandAnswered,
        perCategory,
        nextQuestionId: nextId,
        candidateTotal,
        candidateAnswered
      });
    } catch (e) { return noCacheJson({ error: e.message }, { status: 500 }); }
  }

  // GET /api/quiz/q/:id
  const mQ = /^\/api\/quiz\/q\/([a-zA-Z0-9\-]+)$/.exec(url.pathname);
  if (mQ && request.method === 'GET') {
    const userId = await getSessionUser(request, env);

    let question = null;
    try {
      question = await resolveQuestion(mQ[1], env);
    } catch (e) {
      return noCacheJson({ error: '問題生成エラー: ' + e.message }, { status: 500 });
    }

    if (!question) {
      return noCacheJson({ error: 'not found' }, { status: 404 });
    }

    const category = question.category || 'play';
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
      explanation: reveal ? (question.explanation || '') : null,
      generated: !!question.generated
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

    const question = await resolveQuestion(questionId, env);
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

  // POST /api/quiz/reset (履歴リセット)
  if (url.pathname === '/api/quiz/reset' && request.method === 'POST') {
    const userId = await getSessionUser(request, env);
    if (!userId) return noCacheJson({ error: 'auth required' }, { status: 401 });
    try {
      await env.DB.prepare("DELETE FROM quiz_answers WHERE user_id=?").bind(userId).run();
      return noCacheJson({ ok: true });
    } catch (e) {
      return noCacheJson({ error: e.message }, { status: 500 });
    }
  }

  return null;
}
