// 식단 평가
// - 기본 평가(항상): 권장 칼로리 대비, 빠진 끼니, 한 끼 쏠림, 추정값 비중 / 기간이면 평균·권장 범위 일수
// - AI 평가(버튼): claude.ai 아티팩트로 열었을 때 Claude에게 점수·총평·잘한 점·아쉬운 점·다음 제안을 받음
//   결과는 설정(evals)에 저장해 두고, 기록이 바뀌면 "다시 평가"를 안내
//
// 일별 상세(그날)와 통계 탭(주·월)에서 같은 카드를 씀.

import * as db from './db.js';
import { getSampler } from './lookup.js';
import { getTargets, getGoalLabel } from './profile.js';
import { el, fmtInt, isNum, MEAL_LABEL, todayStr, formatDateLabel, shortDate } from './util.js';

const MAIN_MEALS = ['breakfast', 'lunch', 'dinner'];
const MAX_SAVED = 60; // 저장해 두는 평가 수 (오래된 것부터 지움)

/* =========================================================
 * 입력 정리
 * ========================================================= */
function sumKcal(logs) {
  return logs.reduce((s, l) => s + (isNum(l.kcal) ? l.kcal : 0), 0);
}

/** 하루 기록 → 평가 입력 */
export function dayContext(date, logs) {
  return { kind: 'day', key: `day:${date}`, date, label: formatDateLabel(date), logs };
}

/** 기간 기록 → 평가 입력 (dates: 기간의 모든 날짜) */
export function periodContext(label, start, end, dates, logs) {
  return { kind: 'period', key: `period:${start}:${end}`, start, end, dates, label, logs };
}

/** 기록이 바뀌었는지 비교하기 위한 지문 */
function fingerprint(ctx) {
  const t = getTargets();
  const s = JSON.stringify([
    t.target || 0,
    ctx.logs.map((l) => [l.date, l.meal_type, l.food_name, Math.round(l.amount_g || 0), Math.round(l.kcal || 0)]),
  ]);
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h * 33) ^ s.charCodeAt(i)) >>> 0;
  return h.toString(36);
}

/* =========================================================
 * 기본 평가 (규칙)
 * ========================================================= */
function dayRules(ctx) {
  const t = getTargets();
  const out = [];
  const logs = ctx.logs;
  const valued = logs.filter((l) => isNum(l.kcal));
  const total = sumKcal(logs);
  const isToday = ctx.date === todayStr();
  const isPast = ctx.date < todayStr();

  if (!logs.length) return [{ tone: 'info', text: '아직 기록이 없어요.' }];

  if (t.target) {
    const r = total / t.target;
    const pct = Math.round(r * 100);
    if (r >= 0.9 && r <= 1.1) out.push({ tone: 'ok', text: `권장 칼로리의 ${pct}%로 적정 범위 안이에요.` });
    else if (r > 1.1) out.push({ tone: 'bad', text: `권장보다 ${fmtInt(total - t.target)} kcal 많아요 (${pct}%).` });
    else if (isToday) out.push({ tone: 'info', text: `지금까지 ${pct}%, ${fmtInt(t.target - total)} kcal 남았어요.` });
    else if (r < 0.7) out.push({ tone: 'bad', text: `권장의 ${pct}%로 너무 적게 먹었어요. 기록을 빠뜨린 건 아닌지 확인해 보세요.` });
    else out.push({ tone: 'warn', text: `권장보다 ${fmtInt(t.target - total)} kcal 적어요 (${pct}%).` });
  } else {
    out.push({ tone: 'info', text: `합계 ${fmtInt(total)} kcal. 내 정보를 입력하면 권장 대비로 평가해요.` });
  }

  if (isPast || isToday) {
    const hour = new Date().getHours();
    const due = { breakfast: 11, lunch: 16, dinner: 22 };
    const missing = MAIN_MEALS.filter((m) => !logs.some((l) => l.meal_type === m) && (isPast || hour >= due[m]));
    if (missing.length) out.push({ tone: 'warn', text: `${missing.map((m) => MEAL_LABEL[m]).join('·')} 기록이 없어요.` });
  }

  if (total > 0) {
    const byMeal = {};
    for (const l of valued) byMeal[l.meal_type] = (byMeal[l.meal_type] || 0) + l.kcal;
    const [topMeal, topKcal] = Object.entries(byMeal).sort((a, b) => b[1] - a[1])[0] || [];
    if (topMeal && valued.length > 1 && topKcal / total >= 0.5) {
      out.push({ tone: 'warn', text: `${MEAL_LABEL[topMeal] || topMeal}이 하루의 ${Math.round((topKcal / total) * 100)}%예요. 끼니를 고르게 나누면 좋아요.` });
    }
  }

  const est = logs.filter((l) => l.lookup_status === 'estimated' || l.approx).length;
  const none = logs.length - valued.length;
  if (none) out.push({ tone: 'info', text: `값이 없는 ${none}줄은 평가에서 빠졌어요.` });
  else if (est && est * 2 >= logs.length) out.push({ tone: 'info', text: '추정값이 많아 실제와 차이가 있을 수 있어요.' });
  return out;
}

function periodDays(ctx) {
  const byDate = new Map();
  for (const l of ctx.logs) {
    if (!isNum(l.kcal)) continue;
    byDate.set(l.date, (byDate.get(l.date) || 0) + l.kcal);
  }
  return ctx.dates.filter((d) => byDate.get(d) > 0).map((d) => ({ date: d, kcal: byDate.get(d) }));
}

function periodRules(ctx) {
  const t = getTargets();
  const days = periodDays(ctx);
  if (!days.length) return [{ tone: 'info', text: '이 기간에는 기록이 없어요.' }];
  const out = [];
  const avg = days.reduce((s, d) => s + d.kcal, 0) / days.length;
  const elapsed = ctx.dates.filter((d) => d <= todayStr()).length;
  out.push({ tone: 'info', text: `${elapsed}일 중 ${days.length}일 기록, 하루 평균 ${fmtInt(avg)} kcal.` });
  if (t.target) {
    const inRange = days.filter((d) => d.kcal >= t.target * 0.9 && d.kcal <= t.target * 1.1).length;
    const over = days.filter((d) => d.kcal > t.target * 1.1).length;
    // 오늘은 아직 하루가 끝나지 않았으니 '부족'으로 세지 않음
    const under = days.filter((d) => d.kcal < t.target * 0.9 && d.date !== todayStr()).length;
    out.push({ tone: inRange * 2 >= days.length ? 'ok' : 'warn', text: `권장 범위 안 ${inRange}일 · 초과 ${over}일 · 부족 ${under}일.` });
    const diff = avg - t.target;
    if (Math.abs(diff) > t.target * 0.1) {
      out.push({ tone: 'warn', text: `평균이 권장보다 ${fmtInt(Math.abs(diff))} kcal ${diff > 0 ? '많아요' : '적어요'}.` });
    }
  }
  if (days.length < elapsed && elapsed - days.length >= 2) {
    out.push({ tone: 'info', text: `기록하지 않은 날이 ${elapsed - days.length}일 있어요.` });
  }
  return out;
}

/* =========================================================
 * AI 평가
 * ========================================================= */
function logLine(l) {
  const kcal = isNum(l.kcal) ? `${Math.round(l.kcal)}kcal` : '값 없음';
  const g = isNum(l.amount_g) ? `${Math.round(l.amount_g)}g` : '';
  const mac = isNum(l.kcal) ? ` 탄${Math.round(l.carb || 0)} 단${Math.round(l.protein || 0)} 지${Math.round(l.fat || 0)}g` : '';
  const est = l.lookup_status === 'estimated' || l.approx ? ' (추정)' : '';
  return `${l.food_name} ${g} ${kcal}${mac}${est}`.replace(/\s+/g, ' ').trim();
}

function buildPrompt(ctx, workoutLine = '') {
  const t = getTargets();
  const head = [
    '너는 친절하지만 솔직한 영양 코치다. 아래 식단 기록을 평가해라.',
    `목표: ${getGoalLabel()}, 하루 권장 칼로리: ${t.target ? `${t.target} kcal` : '모름'}`,
    '규칙: 의학적 진단이나 처방은 하지 말 것. 굶기나 극단적인 절식은 권하지 말 것.',
    '권장의 70% 미만으로 먹은 날은 너무 적게 먹은 것도 지적할 것. (추정) 표시는 대략치임을 감안할 것.',
    '반드시 JSON 하나만 답한다: {"score": 0~100 정수, "summary": "한 문장 총평", "good": ["잘한 점"], "improve": ["아쉬운 점"], "tips": ["다음 끼니나 내일 바로 실천할 구체적 제안"]}',
    '각 배열은 1~3개, 각 항목은 45자 이내 한국어 한 문장.',
    '',
  ];
  if (ctx.kind === 'day') {
    const lines = [`[${ctx.label}${ctx.date === todayStr() ? ', 오늘(아직 하루가 안 끝남)' : ''}]`];
    for (const m of ['breakfast', 'lunch', 'dinner', 'snack']) {
      const rows = ctx.logs.filter((l) => l.meal_type === m);
      lines.push(`${MEAL_LABEL[m]}: ${rows.length ? rows.map(logLine).join(', ') : '기록 없음'}`);
    }
    lines.push(`합계: ${fmtInt(sumKcal(ctx.logs))} kcal`);
    if (workoutLine) lines.push(`운동: ${workoutLine}`);
    return [...head, ...lines].join('\n');
  }
  const lines = [`[기간: ${ctx.label}]`];
  for (const d of ctx.dates) {
    if (d > todayStr()) continue;
    const rows = ctx.logs.filter((l) => l.date === d);
    if (!rows.length) { lines.push(`${shortDate(d)}: 기록 없음`); continue; }
    const meals = ['breakfast', 'lunch', 'dinner', 'snack']
      .map((m) => {
        const r = rows.filter((l) => l.meal_type === m);
        return r.length ? `${MEAL_LABEL[m]} ${r.map((l) => l.food_name).join('·')}` : null;
      })
      .filter(Boolean)
      .join(' / ');
    lines.push(`${shortDate(d)}: ${fmtInt(sumKcal(rows))} kcal — ${meals}`);
  }
  return [...head, ...lines].join('\n').slice(0, 60000);
}

function cleanResult(v) {
  if (!v || typeof v !== 'object') return null;
  const arr = (x) => (Array.isArray(x) ? x.filter((s) => typeof s === 'string' && s.trim()).map((s) => s.trim().slice(0, 120)).slice(0, 3) : []);
  const score = Math.round(Number(v.score));
  return {
    score: Number.isFinite(score) ? Math.max(0, Math.min(100, score)) : null,
    summary: typeof v.summary === 'string' ? v.summary.trim().slice(0, 200) : '',
    good: arr(v.good),
    improve: arr(v.improve),
    tips: arr(v.tips),
  };
}

async function loadSaved(key) {
  const all = (await db.getSetting('evals')) || {};
  return all[key] || null;
}
async function save(key, entry) {
  const all = (await db.getSetting('evals')) || {};
  all[key] = entry;
  const keys = Object.keys(all).sort((a, b) => (all[b].at || 0) - (all[a].at || 0));
  for (const k of keys.slice(MAX_SAVED)) delete all[k];
  await db.setSetting('evals', all);
}

const ERROR_TEXT = {
  not_granted: 'Claude 사용이 허용되지 않았어요.',
  rate_limited: '잠시 후 다시 시도해 주세요. (사용량 제한)',
  invalid_json: '평가 결과를 읽지 못했어요. 다시 시도해 주세요.',
  sampling_disabled: '이 계정에서는 AI 평가를 쓸 수 없어요.',
};

/* =========================================================
 * 카드 렌더링
 * ========================================================= */
const running = new Map(); // key → 진행 중

/** container에 평가 카드를 그림 (ctx가 바뀔 때마다 다시 호출) */
export async function renderEvalCard(container, ctx) {
  if (!container) return;
  const rules = ctx.kind === 'day' ? dayRules(ctx) : periodRules(ctx);
  const hasData = ctx.logs.some((l) => isNum(l.kcal));
  const fp = fingerprint(ctx);
  const [saved, sampler] = await Promise.all([loadSaved(ctx.key), getSampler()]);

  const ruleList = el('ul', { className: 'eval-rules' },
    ...rules.map((r) => el('li', { className: `tone-${r.tone}`, textContent: r.text })));

  const aiBox = el('div', { className: 'eval-ai' });
  const btn = el('button', { type: 'button', className: 'eval-btn' });
  const status = el('p', { className: 'eval-status', 'aria-live': 'polite' });

  const showResult = (res, stale) => {
    const parts = [];
    parts.push(el('div', { className: 'eval-head' },
      res.score != null ? el('span', { className: `eval-score ${res.score >= 80 ? 'good' : res.score >= 60 ? 'mid' : 'low'}`, textContent: String(res.score) }) : null,
      el('p', { className: 'eval-summary', textContent: res.summary || '평가를 받았어요.' })));
    const section = (title, items, cls) => (items.length
      ? el('div', { className: `eval-sec ${cls}` }, el('h4', { textContent: title }), el('ul', {}, ...items.map((s) => el('li', { textContent: s }))))
      : null);
    parts.push(section('잘한 점', res.good, 'sec-good'));
    parts.push(section('아쉬운 점', res.improve, 'sec-improve'));
    parts.push(section('이렇게 해 보세요', res.tips, 'sec-tips'));
    if (stale) parts.push(el('p', { className: 'eval-stale', textContent: '평가 뒤에 기록이 바뀌었어요. 다시 평가하면 반영돼요.' }));
    aiBox.replaceChildren(...parts.filter(Boolean));
  };

  if (saved && saved.result) showResult(saved.result, saved.hash !== fp);

  if (!sampler) {
    btn.hidden = true;
    status.textContent = saved ? '' : 'AI 평가는 claude.ai 링크로 앱을 열었을 때 쓸 수 있어요.';
  } else if (!hasData) {
    btn.hidden = true;
  } else {
    btn.textContent = saved ? '다시 평가' : (ctx.kind === 'day' ? 'AI 평가 받기' : '이 기간 AI 평가 받기');
    if (running.has(ctx.key)) { btn.disabled = true; status.textContent = 'Claude가 평가하는 중… (보통 10~30초)'; }
    btn.addEventListener('click', async () => {
      if (running.has(ctx.key)) return;
      running.set(ctx.key, true);
      btn.disabled = true;
      status.textContent = 'Claude가 평가하는 중… (보통 10~30초)';
      try {
        let workoutLine = '';
        if (ctx.kind === 'day') {
          const w = await db.getWorkout(ctx.date);
          const done = ((w && w.plan && w.plan.items) || []).filter((i) => i.done).map((i) => i.name);
          workoutLine = done.length ? `${done.join(', ')} 완료` : '기록 없음';
        }
        const v = await sampler.json(buildPrompt(ctx, workoutLine), { modelTier: 'default', cache: false });
        const res = cleanResult(v);
        if (!res || (!res.summary && !res.good.length && !res.improve.length)) throw { code: 'invalid_json' };
        await save(ctx.key, { hash: fp, result: res, at: Date.now() });
        if (btn.isConnected) {
          showResult(res, false);
          status.textContent = '';
          btn.textContent = '다시 평가';
        }
      } catch (err) {
        if (btn.isConnected) status.textContent = ERROR_TEXT[err && err.code] || '평가를 받지 못했어요. 잠시 후 다시 시도해 주세요.';
      } finally {
        running.delete(ctx.key);
        if (btn.isConnected) btn.disabled = false;
      }
    });
  }

  container.replaceChildren(
    el('div', { className: 'eval-title' },
      el('h2', { className: 'card-title', textContent: ctx.kind === 'day' ? '오늘의 식단 평가' : '기간 식단 평가' }),
      btn),
    ruleList,
    aiBox,
    status,
    el('p', { className: 'eval-note', textContent: '참고용 평가이며 의료적 판단이 아닙니다.' }));
  if (ctx.kind === 'day' && ctx.date !== todayStr()) container.querySelector('.card-title').textContent = '식단 평가';
}
