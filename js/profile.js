// 내 정보: BMI, 기초대사량(Mifflin-St Jeor), 1일 권장 칼로리, 탄단지 목표, 체중 기록
// 모든 칸은 바꾸는 즉시 저장. 최신 체중 기록이 몸무게로 쓰임.

import * as db from './db.js';
import {
  $, el, toast, emitChange, round, todayStr, isValidDateStr, parseNum, fmtInt, fmt1, formatDateLabel,
} from './util.js';

export const ACTIVITY = [
  { value: 1.2, label: '거의 안 움직임' },
  { value: 1.375, label: '가벼움 (주 1–3회 운동)' },
  { value: 1.55, label: '보통 (주 3–5회 운동)' },
  { value: 1.725, label: '많이 (거의 매일 운동)' },
];
export const GOALS = [
  { value: 'maintain', label: '유지', adj: 0 },
  { value: 'lose', label: '감량', adj: -500 },
  { value: 'gain', label: '증량', adj: 300 },
];
export const DEFAULT_RATIO = { carb: 50, protein: 20, fat: 30 };

export const BMI_CLASSES = [
  { max: 18.5, label: '저체중', cls: 'bmi-under' },
  { max: 23, label: '정상', cls: 'bmi-normal' },
  { max: 25, label: '비만 전단계', cls: 'bmi-pre' },
  { max: 30, label: '1단계 비만', cls: 'bmi-ob1' },
  { max: 35, label: '2단계 비만', cls: 'bmi-ob2' },
  { max: Infinity, label: '3단계 비만', cls: 'bmi-ob3' },
];
const BMI_MIN = 15;
const BMI_MAX = 40;

const LIMITS = {
  height_cm: [100, 250],
  weight_kg: [20, 300],
  age: [10, 120],
  target_kcal: [800, 6000],
};

let profile = null;
let weights = [];
let root = null;

/* =========================================================
 * 계산
 * ========================================================= */
export function bmiClass(bmi) {
  return BMI_CLASSES.find((c) => bmi < c.max);
}

/** 프로필로 BMI·기초대사량·권장 칼로리·탄단지 g 목표 계산. 정보가 부족하면 해당 값은 null */
export function computeTargets(p) {
  const ratio = (p && p.macro_ratio) || DEFAULT_RATIO;
  const h = p && p.height_cm;
  const w = p && p.weight_kg;
  const age = p && p.age;
  const hasBody = h > 0 && w > 0;
  // 화면에 보이는 값(소수 1자리)으로 분류해야 '23.0 정상'처럼 숫자와 배지가 어긋나지 않음
  const bmi = hasBody ? round(w / ((h / 100) ** 2), 1) : null;

  let bmr = null;
  let recommended = null;
  if (hasBody && age > 0 && (p.sex === 'male' || p.sex === 'female')) {
    bmr = 10 * w + 6.25 * h - 5 * age + (p.sex === 'male' ? 5 : -161);
    const act = Number(p.activity) || 1.2;
    const goal = GOALS.find((g) => g.value === p.goal) || GOALS[0];
    recommended = Math.round((bmr * act + goal.adj) / 10) * 10;
  }
  const locked = !!(p && p.target_kcal_locked && p.target_kcal > 0);
  const target = locked ? p.target_kcal : recommended;

  const grams = target ? {
    carb: (target * ratio.carb) / 100 / 4,
    protein: (target * ratio.protein) / 100 / 4,
    fat: (target * ratio.fat) / 100 / 9,
  } : null;

  return { bmi, bmr, recommended, target, locked, ratio, grams };
}

/** 운동 추천 등에서 쓰는 기본 정보 */
export function getProfileBasics() {
  const p = profile || {};
  return { goal: p.goal || 'maintain', sex: p.sex || null, age: p.age || null, weight_kg: p.weight_kg || null, avoid_foods: p.avoid_foods || '' };
}

/** 평가 등에서 쓰는 목표 이름 (유지/감량/증량) */
export function getGoalLabel() {
  return (GOALS.find((g) => g.value === (profile && profile.goal)) || GOALS[0]).label;
}

/** 다른 화면에서 쓰는 현재 목표 */
export function getTargets() {
  return computeTargets(profile);
}

export async function loadProfile() {
  profile = (await db.getProfile()) || {
    id: 'me',
    height_cm: null,
    weight_kg: null,
    age: null,
    sex: null,
    activity: 1.55,
    goal: 'maintain',
    target_kcal: null,
    target_kcal_locked: false,
    macro_ratio: { ...DEFAULT_RATIO },
  };
  weights = await db.getWeights();
  syncWeightFromLogs();
  return profile;
}

/** 최신 체중 기록을 몸무게로 반영 */
function syncWeightFromLogs() {
  const latest = weights[weights.length - 1];
  if (latest) profile.weight_kg = latest.weight_kg;
}

async function saveProfile() {
  const t = computeTargets(profile);
  if (!profile.target_kcal_locked) profile.target_kcal = t.recommended;
  await db.putProfile(profile);
  emitChange({ kind: 'profile' });
}

export function getWeightsCache() {
  return weights;
}

/* =========================================================
 * 화면
 * ========================================================= */
export function initProfile(container) {
  root = container;
  root.replaceChildren(buildForm());
  bind();
  render();
}

function field(label, input, suffix) {
  return el('label', { className: 'pf-field' },
    el('span', { className: 'pf-label', textContent: label }),
    el('span', { className: 'pf-input' }, input, suffix ? el('span', { className: 'pf-suffix', textContent: suffix }) : null));
}
function numInput(name, placeholder) {
  return el('input', { name, type: 'text', inputMode: 'decimal', autocomplete: 'off', placeholder });
}
function segRadio(name, options) {
  return el('div', { className: 'seg', role: 'radiogroup' },
    ...options.map((o) => el('label', {},
      el('input', { type: 'radio', name, value: o.value }),
      el('span', { textContent: o.label }))));
}

function buildForm() {
  return el('form', { id: 'profile-form', className: 'pf', novalidate: true },
    el('section', { className: 'card' },
      el('h2', { className: 'card-title', textContent: '신체 정보' }),
      el('div', { className: 'pf-grid' },
        field('키', numInput('height_cm', '170'), 'cm'),
        field('몸무게', numInput('weight_kg', '65'), 'kg'),
        field('나이', numInput('age', '30'), '세'),
        el('div', { className: 'pf-field' },
          el('span', { className: 'pf-label', textContent: '성별' }),
          segRadio('sex', [{ value: 'male', label: '남' }, { value: 'female', label: '여' }]))),
      el('p', { className: 'hint', id: 'pf-weight-hint' }),
      el('label', { className: 'pf-field' },
        el('span', { className: 'pf-label', textContent: '활동량' }),
        el('select', { name: 'activity' },
          ...ACTIVITY.map((a) => el('option', { value: String(a.value), textContent: `${a.label} · ${a.value}` })))),
      el('div', { className: 'pf-field' },
        el('span', { className: 'pf-label', textContent: '목표' }),
        segRadio('goal', GOALS))),

    el('section', { className: 'card', id: 'pf-bmi' },
      el('div', { className: 'bmi-head' },
        el('span', { className: 'card-title', textContent: 'BMI' }),
        el('b', { id: 'bmi-value', textContent: '–' }),
        el('span', { id: 'bmi-badge', className: 'bmi-badge' })),
      el('div', { className: 'bmi-bar' },
        ...BMI_CLASSES.map((c, i) => {
          const lo = i === 0 ? BMI_MIN : BMI_CLASSES[i - 1].max;
          const hi = Math.min(c.max, BMI_MAX);
          return el('span', { className: `bmi-seg ${c.cls}`, style: { flexGrow: String(hi - lo) }, title: c.label });
        }),
        el('i', { id: 'bmi-marker', className: 'bmi-marker', hidden: true })),
      el('div', { className: 'bmi-ticks' },
        ...['18.5', '23', '25', '30', '35'].map((v) => el('span', {
          textContent: v, style: { left: `${((Number(v) - BMI_MIN) / (BMI_MAX - BMI_MIN)) * 100}%` },
        })))),

    el('section', { className: 'card' },
      el('h2', { className: 'card-title', textContent: '1일 권장 칼로리' }),
      el('p', { className: 'kcal-line' },
        el('span', { id: 'pf-bmr', textContent: '기초대사량 –' }),
        el('span', { className: 'arrow', textContent: ' → ' }),
        el('b', { id: 'pf-target', textContent: '–' })),
      el('div', { className: 'pf-field' },
        el('span', { className: 'pf-label', textContent: '설정 방식' }),
        segRadio('target_mode', [{ value: 'auto', label: '자동 계산' }, { value: 'manual', label: '직접 입력' }])),
      field('권장 칼로리', numInput('target_kcal', '2000'), 'kcal'),
      el('p', { className: 'hint', id: 'pf-target-hint' }),
      el('p', { className: 'error', id: 'pf-error', role: 'alert' })),

    el('section', { className: 'card' },
      el('h2', { className: 'card-title', textContent: '메뉴 추천 설정' }),
      el('label', { className: 'pf-field' },
        el('span', { className: 'pf-label', textContent: '피할 음식 (알레르기·싫어하는 음식, 쉼표로 구분)' }),
        el('input', { name: 'avoid_foods', type: 'text', maxLength: 200, autocomplete: 'off', placeholder: '예: 땅콩, 새우, 오이' })),
      el('p', { className: 'hint', textContent: '점심·저녁 추천에서 이 음식은 빼고 추천해요.' })),

    el('section', { className: 'card' },
      el('h2', { className: 'card-title', textContent: '체중 기록' }),
      el('div', { className: 'weight-add' },
        el('input', { type: 'date', name: 'w_date', 'aria-label': '날짜' }),
        el('span', { className: 'pf-input' }, numInput('w_kg', 'kg'), el('span', { className: 'pf-suffix', textContent: 'kg' })),
        el('button', { type: 'button', id: 'w-add', className: 'small-btn', textContent: '기록' })),
      el('ul', { id: 'w-list', className: 'w-list' })),

    el('p', { className: 'disclaimer', textContent: '※ 참고용 계산치이며 의료적 판단이 아닙니다.' }));
}

function render() {
  const f = $('#profile-form', root).elements;
  const p = profile;
  const setIfIdle = (input, v) => { if (document.activeElement !== input) input.value = v ?? ''; };
  setIfIdle(f.height_cm, p.height_cm);
  setIfIdle(f.weight_kg, p.weight_kg);
  setIfIdle(f.age, p.age);
  for (const r of f.sex) r.checked = r.value === p.sex;
  f.activity.value = String(p.activity || 1.55);
  setIfIdle(f.avoid_foods, p.avoid_foods || '');
  for (const r of f.goal) r.checked = r.value === (p.goal || 'maintain');
  for (const r of f.target_mode) r.checked = r.value === (p.target_kcal_locked ? 'manual' : 'auto');
  if (!f.w_date.value) f.w_date.value = todayStr();

  const t = computeTargets(p);
  // 권장 칼로리 입력: 직접 설정일 때만 수정 가능
  f.target_kcal.readOnly = !p.target_kcal_locked;
  f.target_kcal.classList.toggle('readonly', !p.target_kcal_locked);
  setIfIdle(f.target_kcal, t.target ?? '');

  // BMI
  const bmiValue = $('#bmi-value', root);
  const badge = $('#bmi-badge', root);
  const marker = $('#bmi-marker', root);
  if (t.bmi) {
    const c = bmiClass(t.bmi);
    bmiValue.textContent = fmt1(t.bmi);
    badge.textContent = c.label;
    badge.className = `bmi-badge ${c.cls}`;
    const pos = Math.min(1, Math.max(0, (t.bmi - BMI_MIN) / (BMI_MAX - BMI_MIN)));
    marker.style.left = `${pos * 100}%`;
    marker.hidden = false;
  } else {
    bmiValue.textContent = '–';
    badge.textContent = '키·몸무게를 입력하세요';
    badge.className = 'bmi-badge';
    marker.hidden = true;
  }

  $('#pf-bmr', root).textContent = t.bmr ? `기초대사량 ${fmtInt(t.bmr)} kcal` : '기초대사량 – (키·몸무게·나이·성별 필요)';
  $('#pf-target', root).textContent = t.target ? `권장 ${fmtInt(t.target)} kcal${t.locked ? ' (직접 입력)' : ''}` : '–';
  $('#pf-target-hint', root).textContent = p.target_kcal_locked
    ? `직접 입력한 값을 써요.${t.recommended ? ` (자동 계산값은 ${fmtInt(t.recommended)} kcal)` : ''}`
    : '키·몸무게·나이·성별·활동량·목표로 자동 계산해요. 체중을 기록하면 함께 바뀌어요.';

  const latest = weights[weights.length - 1];
  $('#pf-weight-hint', root).textContent = latest
    ? `몸무게는 최신 체중 기록(${formatDateLabel(latest.date)})에서 자동으로 반영돼요.`
    : '몸무게를 입력하면 오늘 날짜의 체중 기록으로도 저장돼요.';

  renderWeights();
}

function renderWeights() {
  const list = $('#w-list', root);
  const recent = weights.slice(-10).reverse();
  if (!recent.length) {
    list.replaceChildren(el('li', { className: 'empty', textContent: '아직 체중 기록이 없어요.' }));
    return;
  }
  list.replaceChildren(...recent.map((w) => el('li', {},
    el('span', { textContent: formatDateLabel(w.date) }),
    el('b', { textContent: `${fmt1(w.weight_kg)} kg` }),
    el('button', { type: 'button', className: 'w-del', dataset: { id: String(w.id) }, textContent: '×', 'aria-label': `${w.date} 체중 기록 삭제` }))));
}

function inRange(name, v) {
  const [lo, hi] = LIMITS[name];
  return Number.isFinite(v) && v >= lo && v <= hi;
}

function showError(msg) {
  $('#pf-error', root).textContent = msg || '';
}

async function addWeight(date, kg) {
  await db.putWeight(date, kg);
  weights = await db.getWeights();
  syncWeightFromLogs();
  await saveProfile();
  emitChange({ kind: 'weights' });
}

function bind() {
  const form = $('#profile-form', root);
  form.addEventListener('submit', (e) => e.preventDefault());

  form.addEventListener('change', async (e) => {
    const t = e.target;
    const name = t.name;
    const v = parseNum(t.value);
    showError('');

    if (name === 'height_cm' || name === 'age') {
      if (t.value.trim() === '') profile[name] = null;
      else if (!inRange(name, v)) { showError(name === 'age' ? '나이는 10–120 사이로 입력하세요.' : '키는 100–250cm 사이로 입력하세요.'); return; }
      else profile[name] = name === 'age' ? Math.round(v) : v;
    } else if (name === 'weight_kg') {
      if (!inRange('weight_kg', v)) { showError('몸무게는 20–300kg 사이로 입력하세요.'); return; }
      await addWeight(todayStr(), v); // 몸무게 입력 = 오늘 체중 기록
      render();
      toast('오늘 체중으로 기록했어요');
      return;
    } else if (name === 'sex' || name === 'goal') {
      profile[name] = t.value;
    } else if (name === 'avoid_foods') {
      profile.avoid_foods = t.value.trim().slice(0, 200);
    } else if (name === 'activity') {
      profile.activity = Number(t.value);
    } else if (name === 'target_mode') {
      profile.target_kcal_locked = t.value === 'manual';
      if (profile.target_kcal_locked) {
        if (!profile.target_kcal) profile.target_kcal = computeTargets(profile).recommended || 2000;
        setTimeout(() => { form.elements.target_kcal.focus(); form.elements.target_kcal.select(); }, 0);
      }
    } else if (name === 'target_kcal') {
      if (!profile.target_kcal_locked) return;
      if (!inRange('target_kcal', v)) { showError('권장 칼로리는 800–6000 kcal 사이로 입력하세요.'); return; }
      profile.target_kcal = Math.round(v);
    } else {
      return; // 체중 기록 입력칸 등
    }
    await saveProfile();
    render();
  });

  $('#w-add', root).addEventListener('click', async () => {
    const f = form.elements;
    const date = f.w_date.value;
    const kg = parseNum(f.w_kg.value);
    if (!isValidDateStr(date)) { showError('날짜를 선택하세요.'); return; }
    if (!inRange('weight_kg', kg)) { showError('체중은 20–300kg 사이로 입력하세요.'); return; }
    showError('');
    await addWeight(date, kg);
    f.w_kg.value = '';
    render();
    toast('체중을 기록했어요');
  });

  $('#w-list', root).addEventListener('click', async (e) => {
    const btn = e.target.closest('.w-del');
    if (!btn) return;
    await db.deleteWeight(Number(btn.dataset.id));
    weights = await db.getWeights();
    syncWeightFromLogs();
    await saveProfile();
    emitChange({ kind: 'weights' });
    render();
  });
}

/** 다른 탭에서 돌아올 때 최신 값으로 */
export function refreshProfileView() {
  if (root) render();
}
