// 오늘의 운동: 요일별 추천(헬스 루틴 + 러닝 km)과 체크박스
//
// - 기본 추천(규칙): 요일별 분할 + 목표(감량/유지/증량)에 따른 러닝 거리.
//   러닝 거리는 최근 2주 동안 완료한 러닝을 기준으로 10%씩 늘림(최대 10km, 장거리 15km).
// - AI 추천(버튼): claude.ai 아티팩트로 열었을 때 Claude가 그날 맞춤 운동을 짜 줌.
// - 체크하거나 AI 추천을 받으면 그날 계획이 저장되어 고정됨(db.putWorkout).

import * as db from './db.js';
import { getSampler } from './lookup.js';
import { getTargets, getGoalLabel, getProfileBasics } from './profile.js';
import { el, toast, todayStr, addDays, parseDateStr, isNum, fmtInt, emitChange } from './util.js';

const WEEKDAY = ['일', '월', '화', '수', '목', '금', '토'];

/* =========================================================
 * 기본 추천 (규칙)
 * ========================================================= */
const ROUTINES = {
  upper: {
    title: '상체 (가슴·어깨·삼두)',
    items: [
      ['벤치프레스', '4세트 × 8–10회'],
      ['인클라인 덤벨 프레스', '3세트 × 10회'],
      ['덤벨 숄더 프레스', '3세트 × 10회'],
      ['케이블 푸시다운', '3세트 × 12회'],
    ],
  },
  lower: {
    title: '하체',
    items: [
      ['스쿼트', '4세트 × 8–10회'],
      ['루마니안 데드리프트', '3세트 × 10회'],
      ['레그 프레스', '3세트 × 12회'],
      ['워킹 런지', '3세트 × 다리당 10회'],
    ],
  },
  back: {
    title: '등·이두 + 코어',
    items: [
      ['랫풀다운', '4세트 × 10회'],
      ['바벨 로우', '3세트 × 10회'],
      ['바벨 컬', '3세트 × 12회'],
      ['플랭크', '3세트 × 45초'],
    ],
  },
};

/** 요일(0=일) → 그날 계획 종류. 목표에 따라 조금 다르게 */
function dayType(dow, goal) {
  const lose = ['rest', 'upper', 'run', 'lower', 'run', 'back', 'long'];
  const keep = ['rest', 'upper', 'run', 'lower', 'rest', 'back', 'long'];
  const gain = ['rest', 'upper', 'lower', 'run', 'back', 'lower', 'rest'];
  return (goal === 'lose' ? lose : goal === 'gain' ? gain : keep)[dow];
}

const round1 = (n) => Math.round(n * 10) / 10;

/** 최근 2주 완료한 러닝으로 다음 러닝 거리 계산 */
async function nextRunKm(date, goal) {
  const recent = await db.getWorkoutsInRange(addDays(date, -14), addDays(date, -1));
  const done = [];
  for (const w of recent) {
    for (const it of (w.plan && w.plan.items) || []) {
      if (it.kind === 'run' && it.done && isNum(it.km) && !it.long) done.push(it.km);
    }
  }
  const base = goal === 'gain' ? 2 : 3;
  if (!done.length) return base;
  const last = Math.max(...done.slice(-3));
  return Math.min(10, round1(Math.max(base, last * 1.1)));
}

function runKcal(km) {
  const { weight_kg: w } = getProfileBasics();
  return w > 0 && km > 0 ? Math.round(w * km) : null; // 러닝 소모 ≈ 체중(kg) × 거리(km)
}

function item(kind, name, detail, extra = {}) {
  return { id: `${kind}-${Math.random().toString(36).slice(2, 8)}`, kind, name, detail, done: false, ...extra };
}

export async function rulePlan(date) {
  const { goal } = getProfileBasics();
  const type = dayType(parseDateStr(date).getDay(), goal || 'maintain');
  const items = [];
  let title;
  if (type === 'rest') {
    title = '회복의 날';
    items.push(item('walk', '가볍게 걷기', '30분, 편한 속도'));
    items.push(item('stretch', '전신 스트레칭', '10분'));
  } else if (type === 'run' || type === 'long') {
    const km = await nextRunKm(date, goal);
    const long = type === 'long';
    const dist = long ? Math.min(15, round1(km * 1.5)) : km;
    title = long ? '장거리 러닝' : '러닝';
    items.push(item('stretch', '준비 운동', '동적 스트레칭 5분'));
    items.push(item('run', `러닝 ${dist}km`, long ? '천천히 길게, 대화할 수 있는 속도' : '편한 속도로 꾸준히', { km: dist, long }));
    items.push(item('stretch', '마무리 스트레칭', '종아리·햄스트링 5분'));
  } else {
    const r = ROUTINES[type];
    title = r.title;
    items.push(item('stretch', '준비 운동', '가벼운 유산소 5분'));
    for (const [name, detail] of r.items) items.push(item('strength', name, detail));
    if (goal === 'lose') {
      const km = round1(Math.max(1.5, (await nextRunKm(date, goal)) / 2));
      items.push(item('run', `마무리 러닝 ${km}km`, '편한 속도', { km }));
    }
  }
  return { title, items, source: 'rule' };
}

/* =========================================================
 * AI 추천
 * ========================================================= */
async function aiPlan(date) {
  const sampler = await getSampler();
  if (!sampler) throw { code: 'unavailable' };
  const b = getProfileBasics();
  const t = getTargets();
  const recent = await db.getWorkoutsInRange(addDays(date, -7), addDays(date, -1));
  const history = recent.map((w) => {
    const done = ((w.plan && w.plan.items) || []).filter((i) => i.done).map((i) => i.name);
    return `${w.date.slice(5)}: ${done.length ? done.join(', ') : '안 함'}`;
  });
  const logs = await db.getLogsByDate(date);
  const eaten = logs.reduce((s, l) => s + (isNum(l.kcal) ? l.kcal : 0), 0);
  const prompt = [
    '너는 헬스 트레이너다. 아래 사람의 오늘 운동을 헬스장 운동과 러닝 위주로 짜라.',
    `목표: ${getGoalLabel()}${b.sex ? `, 성별: ${b.sex === 'male' ? '남' : '여'}` : ''}${b.age ? `, 나이: ${b.age}` : ''}${b.weight_kg ? `, 체중: ${b.weight_kg}kg` : ''}${t.bmi ? `, BMI: ${t.bmi}` : ''}`,
    `오늘: ${date} (${WEEKDAY[parseDateStr(date).getDay()]}요일), 오늘 섭취 ${fmtInt(eaten)} kcal / 권장 ${t.target ? fmtInt(t.target) : '모름'} kcal`,
    `최근 7일 완료한 운동: ${history.length ? history.join(' / ') : '기록 없음'}`,
    '규칙: 최근에 한 부위는 피해서 고르게. 러닝 거리는 최근 기록보다 10% 넘게 늘리지 말 것(기록 없으면 3km 이하). 무리한 강도·부상 위험 동작은 피할 것.',
    '반드시 JSON 하나만: {"title": "오늘 운동 이름", "items": [{"kind": "strength|run|walk|stretch", "name": "운동 이름", "detail": "세트×횟수나 시간", "km": 러닝일 때 거리 숫자 또는 null}], "note": "한 줄 조언"}',
    'items는 3~7개, 이름과 설명은 짧은 한국어로.',
  ].join('\n');
  const v = await sampler.json(prompt, { modelTier: 'default', cache: false });
  const kinds = ['strength', 'run', 'walk', 'stretch'];
  const items = (Array.isArray(v && v.items) ? v.items : []).slice(0, 7)
    .filter((i) => i && typeof i.name === 'string' && i.name.trim())
    .map((i) => {
      const kind = kinds.includes(i.kind) ? i.kind : 'strength';
      const km = Number(i.km);
      return item(kind, i.name.trim().slice(0, 40), typeof i.detail === 'string' ? i.detail.trim().slice(0, 60) : '',
        kind === 'run' && km > 0 && km <= 21 ? { km: round1(km) } : {});
    });
  if (!items.length) throw { code: 'invalid_json' };
  return {
    title: typeof v.title === 'string' && v.title.trim() ? v.title.trim().slice(0, 40) : '오늘의 운동',
    items,
    note: typeof v.note === 'string' ? v.note.trim().slice(0, 120) : '',
    source: 'ai',
  };
}

/* =========================================================
 * 카드
 * ========================================================= */
let renderToken = 0;

export async function renderWorkoutCard(container, date) {
  if (!container) return;
  const my = ++renderToken;
  const saved = await db.getWorkout(date);
  const plan = saved && saved.plan ? saved.plan : await rulePlan(date);
  const sampler = await getSampler();
  if (my !== renderToken) return;

  const isToday = date === todayStr();
  const doneCount = plan.items.filter((i) => i.done).length;
  const runDone = plan.items.filter((i) => i.kind === 'run' && i.done).reduce((s, i) => s + (i.km || 0), 0);
  const burn = runKcal(runDone);

  const persist = async () => {
    await db.putWorkout({ date, plan, updated_at: Date.now() });
    emitChange({ kind: 'workouts', date });
  };

  const list = el('ul', { className: 'wo-list' }, ...plan.items.map((it) => {
    const cb = el('input', { type: 'checkbox', checked: !!it.done, 'aria-label': `${it.name} 완료` });
    cb.addEventListener('change', async () => {
      it.done = cb.checked;
      await persist();
      renderWorkoutCard(container, date);
      if (cb.checked && plan.items.every((i) => i.done)) toast('오늘 운동 완료! 수고했어요');
    });
    const kcal = it.kind === 'run' && it.km ? runKcal(it.km) : null;
    return el('li', { className: `wo-item kind-${it.kind}${it.done ? ' done' : ''}` },
      el('label', {},
        cb,
        el('span', { className: 'wo-text' },
          el('b', { textContent: it.name }),
          el('small', { textContent: [it.detail, kcal ? `약 ${fmtInt(kcal)} kcal` : ''].filter(Boolean).join(' · ') }))));
  }));

  const aiBtn = el('button', { type: 'button', className: 'wo-ai', textContent: 'AI 추천', hidden: !sampler });
  const status = el('p', { className: 'eval-status', 'aria-live': 'polite' });
  aiBtn.addEventListener('click', async () => {
    const hasChecks = plan.items.some((i) => i.done);
    if (hasChecks && !aiBtn.dataset.armed) {
      aiBtn.dataset.armed = '1';
      aiBtn.textContent = '체크가 지워져요. 한 번 더';
      setTimeout(() => { if (aiBtn.isConnected) { delete aiBtn.dataset.armed; aiBtn.textContent = 'AI 추천'; } }, 3000);
      return;
    }
    aiBtn.disabled = true;
    status.textContent = 'Claude가 오늘 운동을 짜는 중… (10~30초)';
    try {
      const next = await aiPlan(date);
      await db.putWorkout({ date, plan: next, updated_at: Date.now() });
      emitChange({ kind: 'workouts', date });
      renderWorkoutCard(container, date);
    } catch (err) {
      if (aiBtn.isConnected) {
        status.textContent = err && err.code === 'not_granted' ? 'Claude 사용이 허용되지 않았어요.' : '추천을 받지 못했어요. 잠시 후 다시 시도해 주세요.';
        aiBtn.disabled = false;
      }
    }
  });

  const resetBtn = el('button', { type: 'button', className: 'wo-reset', textContent: '기본 추천으로', hidden: plan.source !== 'ai' });
  resetBtn.addEventListener('click', async () => {
    const base = await rulePlan(date);
    await db.putWorkout({ date, plan: base, updated_at: Date.now() });
    emitChange({ kind: 'workouts', date });
    renderWorkoutCard(container, date);
  });

  container.replaceChildren(...[
    el('div', { className: 'eval-title' },
      el('h2', { className: 'card-title', textContent: isToday ? '오늘의 운동' : `${WEEKDAY[parseDateStr(date).getDay()]}요일 운동` }),
      aiBtn),
    el('div', { className: 'wo-sub' },
      el('span', { className: 'wo-plan', textContent: `${plan.title}${plan.source === 'ai' ? ' · AI 추천' : ''}` }),
      el('span', { className: `wo-progress${doneCount === plan.items.length ? ' all' : ''}`, textContent: `${doneCount}/${plan.items.length} 완료${burn ? ` · 러닝 약 ${fmtInt(burn)} kcal` : ''}` })),
    list,
    plan.note ? el('p', { className: 'wo-note', textContent: plan.note }) : null,
    status,
    el('div', { className: 'wo-foot' },
      el('p', { className: 'eval-note', textContent: '몸 상태에 맞게 조절하고, 통증이 있으면 멈추세요.' }),
      resetBtn),
  ].filter(Boolean));
}
