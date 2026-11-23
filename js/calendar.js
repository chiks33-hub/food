// 월간 캘린더 (메인 화면)
// 날짜 칸: 날짜 숫자 + 그날 kcal + 권장 대비 색 점
//   90–110% 초록 / 110% 초과 빨강 / 90% 미만 노랑 / 기록 없음 점 없음

import * as db from './db.js';
import { getTargets } from './profile.js';
import {
  $, el, todayStr, monthStart, monthEnd, addMonths, parseDateStr, formatMonthLabel, fmtInt, isNum,
} from './util.js';

let root;
let month = monthStart(todayStr()); // 표시 중인 달의 1일
let selected = null;
let onPick = () => {};

export function initCalendar(container, { onSelect } = {}) {
  root = container;
  if (onSelect) onPick = onSelect;
  root.replaceChildren(
    el('header', { className: 'cal-header' },
      el('button', { type: 'button', className: 'icon-btn', id: 'cal-prev', 'aria-label': '이전 달', textContent: '‹' }),
      el('h1', { id: 'cal-title', className: 'cal-title' }),
      el('button', { type: 'button', className: 'icon-btn', id: 'cal-next', 'aria-label': '다음 달', textContent: '›' }),
      el('button', { type: 'button', className: 'chip', id: 'cal-today', textContent: '오늘' })),
    el('div', { className: 'scroll cal-scroll' },
      el('p', { id: 'cal-banner', className: 'banner', hidden: true },
        '내 정보에서 키·몸무게·나이를 입력하면 권장 칼로리 대비 색이 표시돼요.'),
      el('div', { className: 'cal-week' }, ...['일', '월', '화', '수', '목', '금', '토'].map((d, i) =>
        el('span', { className: i === 0 ? 'sun' : i === 6 ? 'sat' : '', textContent: d }))),
      el('div', { id: 'cal-grid', className: 'cal-grid', role: 'grid' }),
      el('div', { className: 'cal-legend' },
        el('span', {}, el('i', { className: 'dot ok' }), '권장 90–110%'),
        el('span', {}, el('i', { className: 'dot low' }), '90% 미만'),
        el('span', {}, el('i', { className: 'dot over' }), '110% 초과')),
      el('section', { className: 'card cal-summary' },
        el('div', {}, el('span', { className: 'muted', textContent: '이번 달 평균' }), el('b', { id: 'cal-avg', textContent: '–' })),
        el('div', {}, el('span', { className: 'muted', textContent: '기록한 날' }), el('b', { id: 'cal-days', textContent: '0일' })))));

  $('#cal-prev', root).addEventListener('click', () => { month = addMonths(month, -1); render(); });
  $('#cal-next', root).addEventListener('click', () => { month = addMonths(month, 1); render(); });
  $('#cal-today', root).addEventListener('click', () => { month = monthStart(todayStr()); render(); });
  $('#cal-grid', root).addEventListener('click', (e) => {
    const cell = e.target.closest('.cal-cell[data-date]');
    if (!cell) return;
    selected = cell.dataset.date;
    render();
    onPick(selected);
  });
  render();
}

export function setSelected(date) {
  selected = date;
  month = monthStart(date);
}

function statusOf(kcal, target) {
  if (!target) return '';
  const r = kcal / target;
  if (r > 1.1) return 'over';
  if (r < 0.9) return 'low';
  return 'ok';
}

let renderToken = 0;
export async function render() {
  if (!root) return;
  const token = ++renderToken;
  const start = month;
  const end = monthEnd(month);
  const logs = await db.getLogsInRange(start, end);
  if (token !== renderToken) return;

  // 날짜별 합계 (값 있는 줄만)
  const byDate = new Map();
  for (const l of logs) {
    const d = byDate.get(l.date) || { kcal: 0, rows: 0 };
    d.rows++;
    if (isNum(l.kcal)) d.kcal += l.kcal;
    byDate.set(l.date, d);
  }

  const target = getTargets().target;
  $('#cal-banner', root).hidden = !!target;
  $('#cal-title', root).textContent = formatMonthLabel(month);
  const today = todayStr();
  $('#cal-today', root).hidden = monthStart(today) === month;

  const first = parseDateStr(start);
  const lead = first.getDay();
  const days = parseDateStr(end).getDate();
  const cells = [];
  for (let i = 0; i < lead; i++) cells.push(el('div', { className: 'cal-cell empty', 'aria-hidden': 'true' }));
  for (let d = 1; d <= days; d++) {
    const date = `${month.slice(0, 8)}${String(d).padStart(2, '0')}`;
    const info = byDate.get(date);
    const dow = (lead + d - 1) % 7;
    const st = info ? statusOf(info.kcal, target) : '';
    const cls = ['cal-cell'];
    if (date === today) cls.push('today');
    if (date === selected) cls.push('selected');
    if (dow === 0) cls.push('sun');
    if (dow === 6) cls.push('sat');
    if (date > today) cls.push('future');
    cells.push(el('button', {
      type: 'button',
      className: cls.join(' '),
      dataset: { date },
      'aria-label': `${d}일${info ? `, ${fmtInt(info.kcal)} kcal` : ', 기록 없음'}${date === today ? ', 오늘' : ''}`,
    },
      el('span', { className: 'cal-day', textContent: String(d) }),
      el('span', { className: 'cal-kcal', textContent: info && info.kcal > 0 ? fmtInt(info.kcal) : '' }),
      st ? el('i', { className: `dot ${st}` }) : el('i', { className: 'dot none' })));
  }
  $('#cal-grid', root).replaceChildren(...cells);

  // 이번 달 요약: 기록한 날 = 값이 있는 줄이 1개 이상인 날
  const recorded = [...byDate.values()].filter((d) => d.kcal > 0);
  const total = recorded.reduce((s, d) => s + d.kcal, 0);
  $('#cal-avg', root).textContent = recorded.length ? `${fmtInt(total / recorded.length)} kcal` : '–';
  $('#cal-days', root).textContent = `${recorded.length}일`;
}
