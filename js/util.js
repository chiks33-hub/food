// 공통 유틸: 날짜, 숫자, 끼니, DOM, 토스트, 데이터 변경 이벤트, Chart.js 지연 로드

import { CHART_JS_URL } from '../config.js';

export const MEALS = [
  { key: 'breakfast', label: '아침', short: '아' },
  { key: 'lunch', label: '점심', short: '점' },
  { key: 'dinner', label: '저녁', short: '저' },
  { key: 'snack', label: '간식', short: '간' },
];
export const MEAL_LABEL = Object.fromEntries(MEALS.map((m) => [m.key, m.label]));
export const MEAL_KEYS = MEALS.map((m) => m.key);

/* ===== 날짜 (모두 로컬 시간 기준 'YYYY-MM-DD') ===== */
const pad2 = (n) => String(n).padStart(2, '0');
const WEEKDAYS = ['일', '월', '화', '수', '목', '금', '토'];

export function toDateStr(d) {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}
export function todayStr() {
  return toDateStr(new Date());
}
export function parseDateStr(s) {
  const [y, m, d] = s.split('-').map(Number);
  return new Date(y, m - 1, d);
}
export function addDays(s, n) {
  const d = parseDateStr(s);
  d.setDate(d.getDate() + n);
  return toDateStr(d);
}
export function isValidDateStr(s) {
  return typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(parseDateStr(s).getTime());
}
/** 그 달의 첫날 'YYYY-MM-01' */
export function monthStart(s) {
  return s.slice(0, 8) + '01';
}
export function monthEnd(s) {
  const d = parseDateStr(monthStart(s));
  d.setMonth(d.getMonth() + 1, 0);
  return toDateStr(d);
}
export function addMonths(s, n) {
  const d = parseDateStr(monthStart(s));
  d.setMonth(d.getMonth() + n);
  return toDateStr(d);
}
/** s가 속한 주의 월요일 */
export function weekStart(s) {
  const d = parseDateStr(s);
  const dow = (d.getDay() + 6) % 7; // 월=0
  d.setDate(d.getDate() - dow);
  return toDateStr(d);
}
/** start~end(포함) 날짜 배열 */
export function dateRange(start, end) {
  const out = [];
  for (let s = start; s <= end; s = addDays(s, 1)) out.push(s);
  return out;
}
export function weekday(s) {
  return WEEKDAYS[parseDateStr(s).getDay()];
}
export function formatDateLabel(s) {
  const d = parseDateStr(s);
  const base = `${d.getMonth() + 1}월 ${d.getDate()}일 (${WEEKDAYS[d.getDay()]})`;
  return d.getFullYear() === new Date().getFullYear() ? base : `${d.getFullYear()}년 ${base}`;
}
export function formatMonthLabel(s) {
  const d = parseDateStr(s);
  return `${d.getFullYear()}년 ${d.getMonth() + 1}월`;
}
export function shortDate(s) {
  const d = parseDateStr(s);
  return `${d.getMonth() + 1}/${d.getDate()}`;
}

/* ===== 숫자 ===== */
export function round(n, digits = 0) {
  const f = 10 ** digits;
  return Math.round((n + Number.EPSILON) * f) / f;
}
export const fmtInt = (n) => Math.round(n).toLocaleString('ko-KR');
export const fmt1 = (n) => round(n, 1).toLocaleString('ko-KR', { maximumFractionDigits: 1 });
export const fmtQty = (n) => round(n, 2).toLocaleString('ko-KR', { maximumFractionDigits: 2 });
export const isNum = (v) => typeof v === 'number' && Number.isFinite(v);

/** 사용자 입력 숫자 파싱 (빈 값·잘못된 값은 NaN) */
export function parseNum(v) {
  if (v == null) return NaN;
  const s = String(v).trim().replace(',', '.');
  if (s === '' || !/^\d*\.?\d+$|^\d+\.$/.test(s)) return NaN;
  return Number(s);
}

/** 음식 캐시 키: 공백 제거 + 소문자 */
export function nameKey(s) {
  return String(s || '').replace(/\s+/g, '').toLowerCase();
}

/** 현재 시각 기준 끼니: 05–10시 아침, 11–15시 점심, 17–21시 저녁, 그 외 간식 */
export function defaultMeal(date = new Date()) {
  const h = date.getHours();
  if (h >= 5 && h <= 10) return 'breakfast';
  if (h >= 11 && h <= 15) return 'lunch';
  if (h >= 17 && h <= 21) return 'dinner';
  return 'snack';
}

/* ===== DOM ===== */
export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

export function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v == null || v === false) continue;
    if (k === 'dataset') Object.assign(node.dataset, v);
    else if (k === 'style' && typeof v === 'object') Object.assign(node.style, v);
    else if (k in node) node[k] = v;
    else node.setAttribute(k, v === true ? '' : v);
  }
  node.append(...children.flat().filter((c) => c != null && c !== false));
  return node;
}

/** CSS 변수 값 읽기 (차트 색상용) */
export function cssVar(name) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

/* ===== 토스트 (선택적으로 버튼 하나) ===== */
let toastTimer = 0;
export function toast(msg, action) {
  const t = $('#toast');
  t.replaceChildren(el('span', { textContent: msg }));
  if (action) {
    const btn = el('button', { type: 'button', className: 'toast-action', textContent: action.label });
    btn.addEventListener('click', () => {
      t.classList.remove('show');
      action.onClick();
    });
    t.append(btn);
  }
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), action ? 4000 : 1800);
}

/* ===== 데이터 변경 알림 =====
 * detail: { kind: 'logs'|'profile'|'weights'|'foods', date? } */
export function emitChange(detail) {
  window.dispatchEvent(new CustomEvent('data-changed', { detail }));
}
export function onChange(fn) {
  window.addEventListener('data-changed', (e) => fn(e.detail || {}));
}

/* ===== Chart.js 지연 로드 (그래프 화면을 처음 열 때 한 번) ===== */
let chartPromise = null;
export function loadChart() {
  if (typeof window.Chart !== 'undefined') return Promise.resolve(window.Chart);
  if (!chartPromise) {
    chartPromise = new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = CHART_JS_URL;
      s.async = true;
      s.onload = () => resolve(window.Chart);
      s.onerror = () => { chartPromise = null; reject(new Error('Chart.js를 불러오지 못했어요')); };
      document.head.append(s);
    });
  }
  return chartPromise;
}
