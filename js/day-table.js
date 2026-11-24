// 일별 입력 표 (끼니별 구역)
// - 아침·점심·저녁 구역마다 빈 줄 1개. 입력하면 그 구역 아래에 새 빈 줄이 생김
//   간식은 "+ 간식" 버튼으로 열고, 간식 기록이 있으면 항상 보임
// - Enter = 다음 줄(빈 줄에서는 같은 구역 빈 줄에 계속 입력), Tab = 다음 칸
// - 칸을 고치면 즉시 저장, 영양 조회는 비동기(lookup.js)
// - 줄 삭제: × 버튼 / 왼쪽 스와이프 / 음식 칸 비우고 Enter (되돌리기 토스트)
// - kcal은 자동. 길게 누르면 직접 수정(→ 음식 캐시 manual 갱신)
// - 음식 칸 자동완성: 이전 기록 이름 빈도순 최대 5개

import * as db from './db.js';
import * as lookup from './lookup.js';
import { parseEntry, parseAmount, formatAmount } from './parse.js';
import { MEAL_LABEL, el, toast, emitChange, nameKey, isNum, fmtInt, parseNum, round } from './util.js';

const SECTIONS = ['breakfast', 'lunch', 'dinner', 'snack'];
const DEFAULT_SECTIONS = ['breakfast', 'lunch', 'dinner'];
const STATUS = {
  pending: { icon: '', label: '조회 중' },
  found: { icon: '✓', label: '확인됨' },
  estimated: { icon: '≈', label: '추정값' },
  not_found: { icon: '?', label: '못 찾음 – 탭해서 이름 수정' },
  offline: { icon: '↻', label: '오프라인 – 연결되면 다시 조회' },
};
const APPROX_TITLE = '1개 무게나 1회 제공량 정보가 없어 대략 계산했어요. g으로 적으면 정확해요.';
const pieceRechecked = new Set(); // 이번 실행에서 1개 무게를 다시 확인한 줄
const COLS = 4; // 음식 · 양 · kcal · 삭제
const LONG_PRESS_MS = 550;
const SWIPE_DELETE_PX = 90;

const cur = {
  date: null,
  logs: [],          // row_order 순
  snackOpen: false,  // 간식 구역을 열었는지
};
let tbody, tfoot, acBox;
let onUpdateCb = () => {};
const freq = new Map(); // 자동완성용: 음식명 → 기록 횟수
let freqReady = false;

/* =========================================================
 * 초기화
 * ========================================================= */
export function initDayTable(container, { onUpdate } = {}) {
  if (onUpdate) onUpdateCb = onUpdate;
  const table = el('table', { className: 'grid' },
    el('colgroup', {},
      el('col', { className: 'col-food' }), el('col', { className: 'col-amt' }),
      el('col', { className: 'col-kcal' }), el('col', { className: 'col-del' })),
    el('thead', {}, el('tr', {},
      el('th', { textContent: '음식' }), el('th', { textContent: '양' }),
      el('th', { className: 'num', textContent: 'kcal' }), el('th', { 'aria-label': '삭제' }))),
    tbody = el('tbody'),
    tfoot = el('tfoot'));
  container.replaceChildren(table);

  acBox = el('ul', { id: 'ac', className: 'ac', role: 'listbox', hidden: true });
  document.body.append(acBox);

  bindEvents();
}

/** 자동완성 빈도표 (앱 시작 후 한가할 때 전체 기록으로 한 번) */
export function buildFreq(logs) {
  freq.clear();
  for (const l of logs) if (l.food_name) bumpFreq(l.food_name);
  freqReady = true;
}
function bumpFreq(name, d = 1) {
  freq.set(name, Math.max(0, (freq.get(name) || 0) + d));
}

export async function showDate(date) {
  cur.date = date;
  const logs = await db.getLogsByDate(date);
  if (cur.date !== date) return;
  cur.logs = sortLogs(logs);
  cur.snackOpen = cur.logs.some((l) => l.meal_type === 'snack');
  renderAll();
  for (const l of cur.logs) {
    if (l.lookup_status === 'pending' && !lookup.isQueued(l.id)) lookup.enqueue(l.id);
    // "6개"처럼 개수로 적은 줄: 1개 무게가 없이 계산됐을 수 있으니 한 번 다시 확인
    else if (l.amount_unit === 'piece' && l.approx && !pieceRechecked.has(l.id)) {
      pieceRechecked.add(l.id);
      lookup.enqueue(l.id);
    }
  }
}

export function currentLogs() {
  return cur.logs;
}

/** 다른 곳(조회 큐 등)에서 데이터가 바뀌었을 때 */
export async function handleChange(detail) {
  if (detail.kind !== 'logs' || detail.local || detail.date !== cur.date || !tbody) return;
  if (detail.id == null) { await showDate(cur.date); return; }
  const log = await db.getLog(detail.id);
  const i = cur.logs.findIndex((l) => l.id === detail.id);
  if (!log) {
    if (i >= 0) { cur.logs.splice(i, 1); removeRowEls(detail.id); afterChange(); }
    return;
  }
  if (i >= 0) cur.logs[i] = log;
  else { cur.logs.push(log); cur.logs = sortLogs(cur.logs); }
  if (findTr(log.id)) updateRow(log);
  else insertRow(log);
  afterChange();
}

function sortLogs(logs) {
  return logs.sort((a, b) => (a.row_order - b.row_order) || (a.created_at - b.created_at));
}

function mealOf(log) {
  return SECTIONS.includes(log.meal_type) ? log.meal_type : 'snack';
}

/* =========================================================
 * 렌더링
 * ========================================================= */
function statusBtn(status) {
  const s = STATUS[status] || STATUS.pending;
  return el('button', {
    type: 'button',
    className: `st st-${status}`,
    textContent: s.icon,
    title: s.label,
    'aria-label': s.label,
    tabIndex: -1,
  });
}

function kcalText(v) {
  return isNum(v) ? fmtInt(v) : '';
}

function rowEls(log) {
  const tr = el('tr', { className: 'row', dataset: { id: String(log.id), meal: mealOf(log) } });
  tr.append(el('td', { className: 'td-food' },
    el('div', { className: 'food-wrap' },
      statusBtn(log.lookup_status),
      el('input', {
        className: 'c-food', type: 'text', value: log.food_name, autocomplete: 'off',
        enterKeyHint: 'next', spellcheck: false, 'aria-label': '음식',
      }))));
  tr.append(el('td', { className: `td-amt${log.approx ? ' approx' : ''}`, title: log.approx ? APPROX_TITLE : null },
    el('input', {
      className: 'c-amt', type: 'text', value: formatAmount(log.amount_qty, log.amount_unit),
      autocomplete: 'off', enterKeyHint: 'next', 'aria-label': '양',
    })));
  tr.append(el('td', {
    className: `num${log.lookup_status === 'pending' ? ' loading' : ''}`,
    dataset: { field: 'kcal' },
    textContent: kcalText(log.kcal),
  }));
  tr.append(el('td', { className: 'td-del' },
    el('button', { type: 'button', className: 'row-del', textContent: '×', tabIndex: -1, 'aria-label': `${log.food_name} 삭제` })));
  const out = [tr];
  const chips = chipsRow(log);
  if (chips) out.push(chips);
  return out;
}

function chipsRow(log) {
  if (!Array.isArray(log.candidates) || log.candidates.length < 2) return null;
  const sel = log.candidate_index || 0;
  return el('tr', { className: 'chips-row', dataset: { for: String(log.id) } },
    el('td', { colSpan: COLS },
      el('div', { className: 'chips' },
        el('span', { className: 'chips-label', textContent: '혹시 이것?' }),
        ...log.candidates.map((c, i) => el('button', {
          type: 'button',
          className: `chip-cand${i === sel ? ' on' : ''}${c.source === 'ai_estimate' ? ' est' : ''}`,
          dataset: { idx: String(i) },
          textContent: c.name,
          title: `${Math.round(c.kcal_100g)} kcal/100g`,
        })),
        el('button', { type: 'button', className: 'chip-close', textContent: '×', 'aria-label': '후보 닫기' }))));
}

function sectionHead(meal) {
  return el('tr', { className: 'sec-head', dataset: { meal } },
    el('td', { colSpan: COLS },
      el('div', { className: 'sec-line' },
        el('b', { textContent: MEAL_LABEL[meal] }),
        el('span', { className: 'sec-kcal' }))));
}

function blankRow(meal) {
  const tr = el('tr', { className: 'row blank', dataset: { id: '', meal } });
  tr.append(el('td', { className: 'td-food', colSpan: 2 },
    el('div', { className: 'food-wrap' },
      el('span', { className: 'st st-none', 'aria-hidden': 'true' }),
      el('input', {
        className: 'c-food', type: 'text', value: '', autocomplete: 'off', enterKeyHint: 'next',
        spellcheck: false, placeholder: `${MEAL_LABEL[meal]} 음식 입력 (예: 김밥 반)`, 'aria-label': `${MEAL_LABEL[meal]} 새 음식`,
      }))));
  tr.append(el('td', { className: 'num' }), el('td'));
  return tr;
}

function snackAddRow() {
  return el('tr', { className: 'sec-add' },
    el('td', { colSpan: COLS },
      el('button', { type: 'button', className: 'snack-add', textContent: '+ 간식 추가' })));
}

function visibleSections() {
  return cur.snackOpen ? SECTIONS : DEFAULT_SECTIONS;
}

function renderAll() {
  const parts = [];
  for (const meal of visibleSections()) {
    parts.push(sectionHead(meal));
    for (const l of cur.logs) if (mealOf(l) === meal) parts.push(...rowEls(l));
    parts.push(blankRow(meal));
  }
  if (!cur.snackOpen) parts.push(snackAddRow());
  tbody.replaceChildren(...parts);
  afterChange();
}

function renderTotals() {
  let total = 0;
  let pending = 0;
  const byMeal = Object.fromEntries(SECTIONS.map((m) => [m, 0]));
  for (const l of cur.logs) {
    if (!isNum(l.kcal)) { pending++; continue; }
    total += l.kcal;
    byMeal[mealOf(l)] += l.kcal;
  }
  for (const head of tbody.querySelectorAll('tr.sec-head')) {
    const v = byMeal[head.dataset.meal];
    head.querySelector('.sec-kcal').textContent = v > 0 ? `${fmtInt(v)} kcal` : '';
  }
  tfoot.replaceChildren(el('tr', {},
    el('td', { colSpan: 2, className: 'tot-label' },
      el('b', { textContent: '합계' }),
      pending ? el('span', { className: 'tot-note', textContent: ` (값 없는 ${pending}줄 제외)` }) : null),
    el('td', { className: 'num', textContent: fmtInt(total) }),
    el('td')));
}

function findTr(id) {
  return tbody.querySelector(`tr.row[data-id="${id}"]`);
}
function blankTr(meal) {
  return tbody.querySelector(`tr.row.blank[data-meal="${meal}"]`);
}

/** 줄을 그 끼니 구역의 알맞은 위치(row_order 순)에 넣음 */
function insertRow(log) {
  const meal = mealOf(log);
  if (!blankTr(meal)) { // 닫혀 있던 간식 구역
    cur.snackOpen = true;
    renderAll();
    return;
  }
  const next = cur.logs.find((l) => mealOf(l) === meal && l.row_order > log.row_order && l.id !== log.id);
  const before = (next && findTr(next.id)) || blankTr(meal);
  for (const e of rowEls(log)) tbody.insertBefore(e, before);
}

function removeRowEls(id) {
  findTr(id)?.remove();
  tbody.querySelector(`tr.chips-row[data-for="${id}"]`)?.remove();
}

/** 줄을 제자리에서 갱신 (입력 중인 칸은 건드리지 않음) */
function updateRow(log) {
  const tr = findTr(log.id);
  if (!tr) return;
  const active = document.activeElement;
  const food = tr.querySelector('.c-food');
  if (food !== active) food.value = log.food_name;
  const amt = tr.querySelector('.c-amt');
  if (amt !== active) amt.value = formatAmount(log.amount_qty, log.amount_unit);
  const amtTd = amt.parentElement;
  amtTd.classList.toggle('approx', !!log.approx);
  amtTd.title = log.approx ? APPROX_TITLE : '';
  tr.querySelector('.st').replaceWith(statusBtn(log.lookup_status));
  const td = tr.querySelector('td.num');
  if (!td.querySelector('input')) {
    td.textContent = kcalText(log.kcal);
    td.classList.toggle('loading', log.lookup_status === 'pending');
  }
  tbody.querySelector(`tr.chips-row[data-for="${log.id}"]`)?.remove();
  const chips = chipsRow(log);
  if (chips) tr.after(chips);
}

function afterChange() {
  renderTotals();
  onUpdateCb(cur.logs);
}

/* =========================================================
 * 저장
 * ========================================================= */
function findLog(id) {
  return cur.logs.find((l) => l.id === id);
}

async function saveLog(log) {
  log.updated_at = Date.now();
  await db.putLog(log);
  emitChange({ kind: 'logs', date: log.date, id: log.id, local: true });
}

function nextOrder() {
  return cur.logs.reduce((m, l) => Math.max(m, l.row_order || 0), 0) + 1;
}

/** 빈 줄에서 새 기록 생성 (text, meal은 Enter 시점에 확정한 값) */
async function createFromBlank(text, meal) {
  const p = parseEntry(text);
  if (!p.name) return null;
  const now = Date.now();
  const date = cur.date;
  const log = {
    date,
    row_order: nextOrder(),
    meal_type: meal,
    raw_text: text,
    food_name: p.name,
    amount_qty: p.qty,
    amount_unit: p.unit,
    amount_g: null,
    food_id: null,
    kcal: null, carb: null, protein: null, fat: null,
    lookup_status: 'pending',
    candidates: null,
    approx: false,
    created_at: now,
    updated_at: now,
  };
  log.id = await db.putLog(log); // 줄을 먼저 저장
  emitChange({ kind: 'logs', date, id: log.id, local: true });
  lookup.enqueue(log.id); // 조회는 기다리지 않음
  bumpFreq(log.food_name);
  if (cur.date !== date) return log; // 그 사이 다른 날로 이동
  cur.logs.push(log);
  insertRow(log); // 구역의 빈 줄 바로 위 = 빈 줄이 한 칸 아래로
  afterChange();
  return log;
}

// 빈 줄 저장은 입력 순서대로 하나씩 처리 (빠르게 연속 입력해도 줄이 빠지지 않게)
let blankChain = Promise.resolve();

/**
 * 음식 칸 확정. via: 'enter' | 'tab' | 'blur'
 * @returns 대상 줄의 id (새로 만들었으면 새 id), 삭제되었으면 'deleted'
 */
async function commitFood(input, via) {
  const tr = input.closest('tr');
  if (!tr || input.dataset.busy) return null;
  const text = input.value.trim();
  const id = tr.dataset.id ? Number(tr.dataset.id) : null;

  if (id == null) {
    if (!text) return null;
    // 입력값을 바로 비워서 다음 줄을 계속 칠 수 있게 하고, 저장은 순서대로
    const meal = tr.dataset.meal;
    input.value = '';
    const job = blankChain.then(() => createFromBlank(text, meal));
    blankChain = job.catch((err) => console.error('줄 저장 실패', err));
    const log = await job;
    return log ? log.id : null;
  }

  const log = findLog(id);
  if (!log) return null;
  if (!text) {
    if (via === 'enter') { await deleteRow(id); return 'deleted'; }
    input.value = log.food_name; // 비우고 다른 곳을 누르면 되돌림
    return id;
  }

  const p = parseEntry(text);
  const nameChanged = nameKey(p.name) !== nameKey(log.food_name);
  const amountChanged = p.explicit && (p.qty !== log.amount_qty || p.unit !== log.amount_unit);
  const retry = !nameChanged && (log.lookup_status === 'not_found' || log.lookup_status === 'offline');
  if (!nameChanged && !amountChanged && !retry) {
    input.value = log.food_name;
    return id;
  }

  input.dataset.busy = '1';
  try {
    if (nameChanged) {
      bumpFreq(log.food_name, -1);
      bumpFreq(p.name);
    }
    log.food_name = p.name;
    log.raw_text = text;
    if (p.explicit) { log.amount_qty = p.qty; log.amount_unit = p.unit; }

    if (nameChanged || retry) lookup.resetForLookup(log);
    else await lookup.recalc(log);
    await saveLog(log);
    input.value = log.food_name;
    updateRow(log);
    afterChange();
    if (log.lookup_status === 'pending' || (log.amount_unit === 'piece' && log.approx)) lookup.enqueue(log.id);
  } finally {
    delete input.dataset.busy;
  }
  return id;
}

async function commitAmount(input) {
  const tr = input.closest('tr');
  const id = tr && tr.dataset.id ? Number(tr.dataset.id) : null;
  const log = id != null ? findLog(id) : null;
  if (!log) return;
  const a = parseAmount(input.value);
  if (!a) {
    if (input.value.trim()) toast('양은 200g, 1.5, 2개, 반 처럼 적어 주세요');
    input.value = formatAmount(log.amount_qty, log.amount_unit);
    return;
  }
  if (a.qty === log.amount_qty && a.unit === log.amount_unit) {
    input.value = formatAmount(log.amount_qty, log.amount_unit);
    return;
  }
  log.amount_qty = a.qty;
  log.amount_unit = a.unit;
  log.raw_text = `${log.food_name} ${formatAmount(a.qty, a.unit)}`;
  await lookup.recalc(log);
  await saveLog(log);
  input.value = formatAmount(log.amount_qty, log.amount_unit);
  updateRow(log);
  afterChange();
  if (log.lookup_status === 'pending' || (log.amount_unit === 'piece' && log.approx)) lookup.enqueue(log.id);
}

async function deleteRow(id) {
  const log = findLog(id);
  if (!log) return;
  await db.deleteLog(id);
  emitChange({ kind: 'logs', date: log.date, id, local: true });
  cur.logs = cur.logs.filter((l) => l.id !== id);
  bumpFreq(log.food_name, -1);
  removeRowEls(id);
  afterChange();
  toast(`"${log.food_name}" 삭제`, {
    label: '되돌리기',
    onClick: async () => {
      await db.putLog(log);
      bumpFreq(log.food_name);
      emitChange({ kind: 'logs', date: log.date, id: log.id, local: true });
      if (log.date === cur.date) {
        cur.logs.push(log);
        cur.logs = sortLogs(cur.logs);
        insertRow(log);
        afterChange();
      }
    },
  });
}

/* =========================================================
 * 포커스 이동
 * ========================================================= */
/** 편집 가능한 칸 목록 (Tab 순서) */
function focusables() {
  return Array.from(tbody.querySelectorAll('tr.row .c-food, tr.row .c-amt'));
}

function focusEl(node) {
  if (!node) return;
  node.focus({ preventScroll: false });
  if (node.select && node.tagName === 'INPUT') node.select();
  node.scrollIntoView({ block: 'nearest' });
}

/** 다음 줄(빈 줄 포함)의 음식 칸으로 */
function focusFoodOfRowAfter(tr) {
  let next = tr ? tr.nextElementSibling : null;
  while (next && !next.classList.contains('row')) next = next.nextElementSibling;
  if (next) focusEl(next.querySelector('.c-food'));
}

function moveTab(fromEl, back) {
  const list = focusables();
  const i = list.indexOf(fromEl);
  focusEl(list[i + (back ? -1 : 1)] || null);
}

/* =========================================================
 * 자동완성
 * ========================================================= */
let acInput = null;
let acIndex = -1;

function acSuggest(text) {
  const p = parseEntry(text);
  const key = nameKey(p.name);
  if (!key) return [];
  const list = [];
  for (const [name, count] of freq) {
    if (count <= 0) continue;
    const k = nameKey(name);
    if (k === key || !k.includes(key)) continue;
    list.push({ name, count, starts: k.startsWith(key) });
  }
  list.sort((a, b) => b.count - a.count || (b.starts - a.starts) || a.name.length - b.name.length);
  return list.slice(0, 5).map((x) => x.name);
}

async function acShow(input) {
  if (!freqReady) buildFreq(await db.getAllLogs());
  const items = acSuggest(input.value);
  if (!items.length || document.activeElement !== input) { acHide(); return; }
  acInput = input;
  acIndex = -1;
  acBox.replaceChildren(...items.map((name, i) =>
    el('li', { role: 'option', dataset: { idx: String(i) }, textContent: name })));
  const r = input.getBoundingClientRect();
  acBox.style.left = `${Math.max(8, r.left - 20)}px`;
  acBox.style.top = `${r.bottom + 2}px`;
  acBox.style.minWidth = `${Math.max(160, r.width + 20)}px`;
  acBox.hidden = false;
}

function acHide() {
  acBox.hidden = true;
  acInput = null;
  acIndex = -1;
}

function acMove(d) {
  const items = acBox.querySelectorAll('li');
  if (!items.length) return;
  acIndex = (acIndex + d + items.length) % items.length;
  items.forEach((li, i) => li.classList.toggle('on', i === acIndex));
}

async function acPick(name) {
  const input = acInput;
  if (!input) return;
  const tr = input.closest('tr');
  const text = input.value.trim();
  const p = parseEntry(text);
  const amountPart = p.explicit ? text.slice(p.name.length).trim() : '';
  input.value = amountPart ? `${name} ${amountPart}` : name;
  acHide();
  const res = await commitFood(input, 'enter');
  if (res === 'deleted') return;
  if (!tr.dataset.id) focusEl(input); // 빈 줄이면 같은 빈 줄에 계속
  else focusFoodOfRowAfter(tr);
}

/* =========================================================
 * kcal 직접 수정 (길게 누르기)
 * ========================================================= */
function openNumEditor(td) {
  const tr = td.closest('tr');
  const id = tr && tr.dataset.id ? Number(tr.dataset.id) : null;
  const log = id != null ? findLog(id) : null;
  if (!log || td.querySelector('input')) return;
  const input = el('input', {
    className: 'c-num', type: 'text', inputMode: 'decimal',
    value: isNum(log.kcal) ? String(round(log.kcal, 1)) : '',
    'aria-label': 'kcal 직접 수정',
  });
  td.replaceChildren(input);
  td.classList.add('editing');
  input.focus();
  input.select();
  let done = false;
  const finish = async (save) => {
    if (done) return;
    done = true;
    td.classList.remove('editing');
    const v = parseNum(input.value);
    if (save && Number.isFinite(v) && v >= 0 && v !== round(log.kcal ?? NaN, 1)) {
      td.textContent = kcalText(v);
      await lookup.setManualValue(log.id, 'kcal', v);
      const fresh = await db.getLog(log.id);
      if (fresh) {
        Object.assign(log, fresh);
        updateRow(log);
        afterChange();
      }
      toast('값을 고쳤어요. 이 음식의 다음 기록에도 적용돼요');
    } else {
      td.textContent = kcalText(log.kcal);
    }
  };
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); finish(true); }
    if (e.key === 'Escape') { e.preventDefault(); finish(false); }
  });
  input.addEventListener('blur', () => finish(true));
}

/* =========================================================
 * 이벤트
 * ========================================================= */
const lastEnter = { el: null, at: 0 };

async function onStatusClick(st) {
  const tr = st.closest('tr');
  const log = findLog(Number(tr.dataset.id));
  if (!log) return;
  const input = tr.querySelector('.c-food');
  if (log.lookup_status === 'not_found') {
    focusEl(input);
    toast('이름을 고쳐서 Enter를 누르면 다시 찾아요');
  } else if (log.lookup_status === 'offline') {
    lookup.enqueue(log.id);
    toast(navigator.onLine ? '다시 조회할게요' : '오프라인이에요. 연결되면 자동으로 조회해요');
  } else if (log.lookup_status === 'estimated') {
    const food = log.food_id != null ? await db.getFoodById(log.food_id) : null;
    const ref = food && food.source_ref ? String(food.source_ref) : '';
    const m = ref.match(/^web:(https?:\/\/\S+)/);
    let host = '';
    if (m) { try { host = new URL(m[1]).hostname.replace(/^www\./, ''); } catch (err) { host = ''; } }
    toast(host
      ? `웹 검색으로 찾은 값이에요 (${host}). 길게 눌러 고칠 수 있어요`
      : 'AI 추정값이에요. kcal을 길게 눌러 고칠 수 있어요');
  } else if (log.lookup_status === 'found') {
    toast('영양값이 확인된 음식이에요');
  }
}

function bindEvents() {
  // 키보드: Enter / Tab / 자동완성
  tbody.addEventListener('keydown', async (e) => {
    const t = e.target;
    const isFood = t.matches('.c-food');
    const isAmt = t.matches('.c-amt');
    if (!isFood && !isAmt) return;
    const tr = t.closest('tr');

    if (isFood && !acBox.hidden && acInput === t) {
      if (e.key === 'ArrowDown') { e.preventDefault(); acMove(1); return; }
      if (e.key === 'ArrowUp') { e.preventDefault(); acMove(-1); return; }
      if (e.key === 'Enter' && acIndex >= 0) {
        e.preventDefault();
        const li = acBox.querySelectorAll('li')[acIndex];
        if (li) acPick(li.textContent);
        return;
      }
      if (e.key === 'Escape') { acHide(); return; }
    }

    if (e.key === 'Enter') {
      e.preventDefault();
      // 한글 조합 중 Enter가 두 번 들어오는 IME 대응 (기존 줄에서 한 줄 건너뛰지 않게).
      // 빈 줄은 두 번째 Enter 때 이미 비어 있어 무시되므로 검사하지 않음
      const now = Date.now();
      if (tr.dataset.id && t === lastEnter.el && now - lastEnter.at < 80) return;
      lastEnter.el = t;
      lastEnter.at = now;
      acHide();
      if (isFood) {
        const wasBlank = !tr.dataset.id;
        const meal = tr.dataset.meal;
        const res = await commitFood(t, 'enter');
        if (wasBlank) { focusEl(blankTr(meal)?.querySelector('.c-food')); return; } // 같은 구역에 계속
        if (res === 'deleted') { focusEl(blankTr(meal)?.querySelector('.c-food')); return; }
        focusFoodOfRowAfter(tr);
      } else {
        await commitAmount(t);
        focusFoodOfRowAfter(tr);
      }
      return;
    }

    if (e.key === 'Tab') {
      e.preventDefault();
      acHide();
      if (isFood) {
        const wasBlank = !tr.dataset.id;
        const res = await commitFood(t, 'tab');
        if (wasBlank && typeof res === 'number' && !e.shiftKey) {
          focusEl(findTr(res)?.querySelector('.c-amt')); // 새로 만든 줄의 양 칸으로
          return;
        }
      } else {
        await commitAmount(t);
      }
      moveTab(t, e.shiftKey);
      return;
    }

    if (e.key === 'Escape') {
      const log = tr.dataset.id ? findLog(Number(tr.dataset.id)) : null;
      t.value = log ? (isFood ? log.food_name : formatAmount(log.amount_qty, log.amount_unit)) : '';
      t.blur();
    }
  });

  // 다른 칸으로 이동(포커스 아웃) 시 확정
  tbody.addEventListener('focusout', (e) => {
    const t = e.target;
    if (t.matches('.c-food')) {
      setTimeout(() => { if (acInput === t && document.activeElement !== t) acHide(); }, 150);
      commitFood(t, 'blur');
    } else if (t.matches('.c-amt')) {
      commitAmount(t);
    }
  });

  // 자동완성
  tbody.addEventListener('input', (e) => {
    if (e.target.matches('.c-food')) acShow(e.target);
  });
  acBox.addEventListener('pointerdown', (e) => e.preventDefault()); // 입력 칸 포커스 유지
  acBox.addEventListener('click', (e) => {
    const li = e.target.closest('li');
    if (li) acPick(li.textContent);
  });
  document.addEventListener('scroll', () => acHide(), true);

  // 버튼들: 삭제, 상태 아이콘, 후보 칩, 간식 열기
  tbody.addEventListener('click', async (e) => {
    const del = e.target.closest('.row-del');
    if (del) { await deleteRow(Number(del.closest('tr').dataset.id)); return; }

    const st = e.target.closest('.st');
    if (st && !st.classList.contains('st-none')) { await onStatusClick(st); return; }

    const chip = e.target.closest('.chip-cand');
    if (chip) {
      const id = Number(chip.closest('tr').dataset.for);
      await lookup.chooseCandidate(id, Number(chip.dataset.idx));
      await refreshRow(id);
      return;
    }
    const close = e.target.closest('.chip-close');
    if (close) {
      const id = Number(close.closest('tr').dataset.for);
      await lookup.dismissCandidates(id);
      await refreshRow(id);
      return;
    }
    if (e.target.closest('.snack-add')) {
      cur.snackOpen = true;
      renderAll();
      focusEl(blankTr('snack')?.querySelector('.c-food'));
    }
  });

  // kcal 칸 길게 누르기
  let pressTimer = 0;
  let pressStart = null;
  const cancelPress = () => { clearTimeout(pressTimer); pressStart = null; };
  tbody.addEventListener('pointerdown', (e) => {
    const td = e.target.closest('td.num');
    if (!td || !td.closest('tr.row:not(.blank)') || td.querySelector('input')) return;
    pressStart = { x: e.clientX, y: e.clientY };
    clearTimeout(pressTimer);
    pressTimer = setTimeout(() => {
      pressStart = null;
      openNumEditor(td);
    }, LONG_PRESS_MS);
  });
  tbody.addEventListener('pointerup', cancelPress);
  tbody.addEventListener('pointercancel', cancelPress);
  tbody.addEventListener('pointermove', (e) => {
    if (pressStart && Math.hypot(e.clientX - pressStart.x, e.clientY - pressStart.y) > 10) cancelPress();
  });
  tbody.addEventListener('contextmenu', (e) => {
    if (e.target.closest('td.num')) e.preventDefault();
  });

  // 왼쪽 스와이프 삭제
  let sw = null;
  tbody.addEventListener('touchstart', (e) => {
    const tr = e.target.closest('tr.row:not(.blank)');
    if (!tr || e.touches.length !== 1) { sw = null; return; }
    const t = e.touches[0];
    sw = { tr, x: t.clientX, y: t.clientY, dx: 0, active: false };
  }, { passive: true });
  tbody.addEventListener('touchmove', (e) => {
    if (!sw) return;
    const t = e.touches[0];
    const dx = t.clientX - sw.x;
    const dy = t.clientY - sw.y;
    if (!sw.active) {
      if (Math.abs(dy) > 12 && Math.abs(dy) > Math.abs(dx)) { sw = null; return; }
      if (dx < -12 && Math.abs(dx) > Math.abs(dy) * 1.5) {
        sw.active = true;
        cancelPress();
        sw.tr.classList.add('swiping');
      } else return;
    }
    e.preventDefault();
    sw.dx = Math.max(-160, Math.min(0, dx));
    sw.tr.style.transform = `translateX(${sw.dx}px)`;
    sw.tr.classList.toggle('swipe-armed', sw.dx <= -SWIPE_DELETE_PX);
  }, { passive: false });
  const endSwipe = () => {
    if (!sw) return;
    const { tr, dx, active } = sw;
    sw = null;
    if (!active) return;
    tr.classList.remove('swiping', 'swipe-armed');
    tr.style.transform = '';
    if (dx <= -SWIPE_DELETE_PX) deleteRow(Number(tr.dataset.id));
  };
  tbody.addEventListener('touchend', endSwipe);
  tbody.addEventListener('touchcancel', endSwipe);
}

async function refreshRow(id) {
  const log = await db.getLog(id);
  const i = cur.logs.findIndex((l) => l.id === id);
  if (!log || i < 0) return;
  cur.logs[i] = log;
  updateRow(log);
  afterChange();
}
