// 통계 탭 (주/월 전환)
//  1) 일별 kcal 막대 + 권장 기준선
//  2) 자주 먹은 음식 TOP 10
//  3) 권장 범위(90–110%) 안에 든 날 / 기록한 날
//  4) 체중 추이

import * as db from './db.js';
import { getTargets } from './profile.js';
import {
  $, el, cssVar, loadChart, todayStr, addDays, weekStart, monthStart, monthEnd, addMonths, dateRange, shortDate,
  weekday, formatMonthLabel, fmtInt, fmt1, isNum, parseDateStr,
} from './util.js';

let root;
let mode = 'week';
let anchor = todayStr();
const charts = {};

export function initStats(container) {
  root = container;
  root.replaceChildren(
    el('header', { className: 'st-header' },
      el('div', { className: 'seg st-mode', role: 'group', 'aria-label': '기간' },
        el('button', { type: 'button', dataset: { mode: 'week' }, textContent: '주' }),
        el('button', { type: 'button', dataset: { mode: 'month' }, textContent: '월' })),
      el('div', { className: 'st-nav' },
        el('button', { type: 'button', className: 'icon-btn', id: 'st-prev', 'aria-label': '이전 기간', textContent: '‹' }),
        el('span', { id: 'st-label', className: 'st-label' }),
        el('button', { type: 'button', className: 'icon-btn', id: 'st-next', 'aria-label': '다음 기간', textContent: '›' }))),
    el('div', { className: 'scroll st-scroll' },
      el('section', { className: 'card st-kpis' },
        el('div', {}, el('span', { className: 'muted', textContent: '평균 섭취' }), el('b', { id: 'st-avg', textContent: '–' })),
        el('div', {}, el('span', { className: 'muted', textContent: '권장 범위 안' }), el('b', { id: 'st-inrange', textContent: '–' })),
        el('div', {}, el('span', { className: 'muted', textContent: '기록한 날' }), el('b', { id: 'st-days', textContent: '–' }))),
      card('일별 칼로리', 'st-kcal', '막대: 섭취 · 점선: 권장'),
      card('자주 먹은 음식 TOP 10', 'st-top', null, 'st-top-box'),
      card('체중 추이', 'st-weight')));

  root.querySelector('.st-mode').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-mode]');
    if (!b || b.dataset.mode === mode) return;
    mode = b.dataset.mode;
    render();
  });
  $('#st-prev', root).addEventListener('click', () => { shift(-1); });
  $('#st-next', root).addEventListener('click', () => { shift(1); });
}

function card(title, id, hint, boxClass = '') {
  return el('section', { className: 'card st-card' },
    el('h2', { className: 'card-title', textContent: title }),
    hint ? el('p', { className: 'hint tight', textContent: hint }) : null,
    el('div', { className: `st-box ${boxClass}` },
      el('canvas', { id }),
      el('p', { className: 'st-empty', id: `${id}-empty`, hidden: true, textContent: '이 기간에는 기록이 없어요.' })));
}

function shift(dir) {
  anchor = mode === 'week' ? addDays(weekStart(anchor), dir * 7) : addMonths(anchor, dir);
  render();
}

function period() {
  if (mode === 'week') {
    const start = weekStart(anchor);
    return { start, end: addDays(start, 6) };
  }
  return { start: monthStart(anchor), end: monthEnd(anchor) };
}

function colors() {
  return {
    ok: cssVar('--ok'), low: cssVar('--warn'), over: cssVar('--danger'), muted: cssVar('--muted'),
    line: cssVar('--line'), text: cssVar('--text'), primary: cssVar('--primary'),
    carb: cssVar('--carb'), protein: cssVar('--protein'), fat: cssVar('--fat'), accent: cssVar('--accent'),
  };
}

function make(id, config) {
  if (charts[id]) charts[id].destroy();
  charts[id] = new Chart($(`#${id}`, root), config);
}

function setEmpty(id, empty) {
  $(`#${id}-empty`, root).hidden = !empty;
  $(`#${id}`, root).style.visibility = empty ? 'hidden' : 'visible';
}

let token = 0;
export async function render() {
  if (!root) return;
  const my = ++token;
  for (const b of root.querySelectorAll('.st-mode button')) b.setAttribute('aria-pressed', String(b.dataset.mode === mode));
  const { start, end } = period();
  $('#st-label', root).textContent = mode === 'week'
    ? `${shortDate(start)} – ${shortDate(end)}`
    : formatMonthLabel(start);
  $('#st-next', root).disabled = start > todayStr();

  const [logs, weights] = await Promise.all([db.getLogsInRange(start, end), db.getWeights()]);
  try { await loadChart(); } catch (err) { return; }
  if (my !== token) return;

  const t = getTargets();
  const target = t.target;
  const c = colors();
  Chart.defaults.color = c.muted;
  Chart.defaults.font.family = getComputedStyle(document.body).fontFamily;

  // 날짜별 합계
  const days = new Map();
  for (const l of logs) {
    if (!isNum(l.kcal)) continue;
    const d = days.get(l.date) || { kcal: 0 };
    d.kcal += l.kcal;
    days.set(l.date, d);
  }
  const dates = dateRange(start, end);
  const labels = dates.map((d) => (mode === 'week' ? `${shortDate(d)}(${weekday(d)})` : String(parseDateStr(d).getDate())));
  const inPeriod = dates.map((d) => days.get(d)).filter((d) => d && d.kcal > 0);

  // KPI
  const recorded = inPeriod.length;
  const avg = recorded ? inPeriod.reduce((s, d) => s + d.kcal, 0) / recorded : 0;
  const inRange = target ? inPeriod.filter((d) => d.kcal >= target * 0.9 && d.kcal <= target * 1.1).length : null;
  $('#st-avg', root).textContent = recorded ? `${fmtInt(avg)} kcal` : '–';
  $('#st-inrange', root).textContent = target ? `${inRange} / ${recorded}일` : '권장 미설정';
  $('#st-days', root).textContent = `${recorded}일`;

  // 1) 일별 kcal + 권장 기준선
  const kcalData = dates.map((d) => (days.get(d)?.kcal > 0 ? days.get(d).kcal : null));
  const barColors = kcalData.map((v) => {
    if (v == null || !target) return c.primary;
    const r = v / target;
    return r > 1.1 ? c.over : r < 0.9 ? c.low : c.ok;
  });
  make('st-kcal', {
    data: {
      labels,
      datasets: [
        { type: 'bar', label: '섭취', data: kcalData, backgroundColor: barColors, borderRadius: 3, order: 3, maxBarThickness: 26 },
        ...(target ? [{ type: 'line', label: '권장', data: dates.map(() => target), borderColor: c.muted, borderDash: [6, 4], borderWidth: 1.5, pointRadius: 0, order: 2 }] : []),
      ],
    },
    options: chartOpts(c, { legend: true, yTitle: 'kcal' }),
  });
  setEmpty('st-kcal', recorded === 0);

  // 2) TOP 10 (기간 안의 줄 수 기준)
  const counts = new Map();
  for (const l of logs) {
    if (!l.food_name) continue;
    counts.set(l.food_name, (counts.get(l.food_name) || 0) + 1);
  }
  const top = [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], 'ko')).slice(0, 10);
  $('#st-top', root).parentElement.style.height = `${Math.max(120, top.length * 30 + 30)}px`;
  make('st-top', {
    type: 'bar',
    data: {
      labels: top.map((x) => x[0]),
      datasets: [{ label: '횟수', data: top.map((x) => x[1]), backgroundColor: c.primary, borderRadius: 4, maxBarThickness: 18 }],
    },
    options: {
      ...chartOpts(c, {}),
      indexAxis: 'y',
      scales: {
        x: { beginAtZero: true, ticks: { precision: 0 }, grid: { color: c.line } },
        y: { grid: { display: false }, ticks: { autoSkip: false } },
      },
      plugins: { legend: { display: false }, tooltip: { callbacks: { label: (ctx) => `${ctx.raw}회` } } },
    },
  });
  setEmpty('st-top', top.length === 0);

  // 4) 체중 추이 (기간 안의 기록)
  const wIn = weights.filter((w) => w.date >= start && w.date <= end);
  const wMap = new Map(wIn.map((w) => [w.date, w.weight_kg]));
  make('st-weight', {
    type: 'line',
    data: {
      labels,
      datasets: [{
        label: '체중', data: dates.map((d) => wMap.get(d) ?? null), borderColor: c.accent, backgroundColor: c.accent,
        spanGaps: true, tension: 0.25, pointRadius: 3,
      }],
    },
    options: {
      ...chartOpts(c, { yTitle: 'kg' }),
      scales: {
        x: { grid: { display: false }, ticks: { maxRotation: 0, autoSkip: true, maxTicksLimit: mode === 'week' ? 7 : 10 } },
        y: { grid: { color: c.line }, ticks: { callback: (v) => fmt1(v) } },
      },
      plugins: { legend: { display: false }, tooltip: { callbacks: { label: (ctx) => `${fmt1(ctx.raw)} kg` } } },
    },
  });
  const wEmpty = $('#st-weight-empty', root);
  wEmpty.textContent = '이 기간에는 체중 기록이 없어요. 내 정보에서 기록할 수 있어요.';
  setEmpty('st-weight', wIn.length === 0);
}

function chartOpts(c, { legend = false, stacked = false, yTitle } = {}) {
  return {
    responsive: true,
    maintainAspectRatio: false,
    animation: { duration: 250 },
    interaction: { mode: 'index', intersect: false },
    scales: {
      x: { stacked, grid: { display: false }, ticks: { maxRotation: 0, autoSkip: true, maxTicksLimit: mode === 'week' ? 7 : 10 } },
      y: { stacked, beginAtZero: true, grid: { color: c.line }, ticks: { maxTicksLimit: 5 }, title: yTitle ? { display: false, text: yTitle } : undefined },
    },
    plugins: {
      legend: { display: legend, position: 'bottom', labels: { boxWidth: 12, boxHeight: 12 } },
      tooltip: { callbacks: { label: (ctx) => (ctx.raw == null ? null : `${ctx.dataset.label} ${fmtInt(ctx.raw)}`) } },
    },
  };
}
