// 진입점: 하단 탭(캘린더|통계|내 정보), 일별 상세 레이어, 뒤로 가기(history), 초기화

import * as db from './db.js';
import * as lookup from './lookup.js';
import { initCalendar, render as renderCalendar, setSelected } from './calendar.js';
import { initDayTable, showDate, handleChange as tableHandleChange, currentLogs, buildFreq } from './day-table.js';
import { SEED_FOODS_JSON } from '../config.js';
import { initDayCharts, updateDayCharts, resetDayCharts } from './day-charts.js';
import { loadProfile, initProfile, refreshProfileView } from './profile.js';
import { initStats, render as renderStats } from './stats.js';
import {
  $, $$, toast, onChange, todayStr, addDays, formatDateLabel, isValidDateStr, nameKey,
} from './util.js';

const state = {
  tab: 'calendar',
  day: null, // 열린 일별 상세 날짜 (없으면 null)
};
const dirty = { calendar: false, stats: true };

/* =========================================================
 * 화면 전환 + 뒤로 가기
 *  history.state = { tab, day }
 *  캘린더 → 다른 탭: push / 다른 탭끼리: replace / 일별 상세 열기: push
 * ========================================================= */
let historyOK = true;
function safeHistory(method, s) {
  if (!historyOK) return;
  try { history[method](s, ''); } catch (err) { historyOK = false; }
}
function currentHistoryState() {
  try { return history.state; } catch (err) { historyOK = false; return null; }
}

function showTab(tab) {
  state.tab = tab;
  for (const v of $$('.view')) {
    const on = v.id === `view-${tab}`;
    v.hidden = !on;
    v.classList.toggle('active', on);
  }
  for (const b of $$('.tabbar button')) b.setAttribute('aria-selected', String(b.dataset.tab === tab));
  if (tab === 'calendar' && dirty.calendar) { dirty.calendar = false; renderCalendar(); }
  if (tab === 'stats' && dirty.stats) { dirty.stats = false; renderStats(); }
  if (tab === 'profile') refreshProfileView();
}

function showDayUI(date) {
  const layer = $('#day-layer');
  const opening = !state.day;
  state.day = date;
  $('#day-title').textContent = formatDateLabel(date);
  $('#day-today').hidden = date !== todayStr();
  layer.classList.add('open');
  layer.inert = false;
  $('.views').inert = true; // 메뉴바는 계속 누를 수 있게 둠
  setSelected(date);
  showDate(date);
  if (opening) $('#day-scroll').scrollTop = 0;
}

function hideDayUI() {
  if (!state.day) return;
  state.day = null;
  const layer = $('#day-layer');
  if (layer.contains(document.activeElement)) document.activeElement.blur();
  layer.classList.remove('open');
  layer.inert = true;
  $('.views').inert = false;
  $('#ac').hidden = true;
  renderCalendar();
}

function applyState(s) {
  const st = s || { tab: 'calendar', day: null };
  showTab(st.tab || 'calendar');
  if (st.day && isValidDateStr(st.day)) showDayUI(st.day);
  else hideDayUI();
}

let pendingTab = null;

function selectTab(tab) {
  // 일별 상세가 열려 있으면 먼저 닫고(뒤로 가기 기록 정리) 그 탭으로
  if (state.day) {
    if (!historyOK) { hideDayUI(); showTab(tab); return; }
    pendingTab = tab === state.tab ? null : tab;
    history.back();
    return;
  }
  if (tab === state.tab) return;
  if (!historyOK) { showTab(tab); return; }
  if (tab === 'calendar') {
    const hs = currentHistoryState();
    if (hs && hs.tab && hs.tab !== 'calendar') { history.back(); return; }
    safeHistory('replaceState', { tab, day: null });
  } else if (state.tab === 'calendar') {
    safeHistory('pushState', { tab, day: null });
  } else {
    safeHistory('replaceState', { tab, day: null });
  }
  showTab(tab);
}

function openDay(date) {
  safeHistory('pushState', { tab: state.tab, day: date });
  showDayUI(date);
}

function moveDay(delta) {
  if (!state.day) return;
  const date = addDays(state.day, delta);
  safeHistory('replaceState', { tab: state.tab, day: date });
  showDayUI(date);
}

function closeDay() {
  if (historyOK) history.back();
  else hideDayUI();
}

/* =========================================================
 * 음식 시드 (선택): tools/import_foods.py로 만든 foods.json이 있으면 캐시에 넣음
 * ========================================================= */
async function seedFromFoodsJson() {
  if (!SEED_FOODS_JSON) return; // config.js에서 켠 경우에만 (없는 파일 요청 방지)
  let res;
  try {
    res = await fetch('./foods.json', { cache: 'no-cache' });
  } catch (err) {
    return;
  }
  if (!res.ok) return;
  let data;
  try { data = await res.json(); } catch (err) { return; }
  if (!data || data.version == null || !Array.isArray(data.foods)) return;
  const version = String(data.version);
  if ((await db.getSetting('seed_version')) === version) return;
  const now = Date.now();
  const list = [];
  const seen = new Set();
  for (const f of data.foods) {
    if (!f || typeof f.name !== 'string') continue;
    const key = nameKey(f.name);
    const kcal = Number(f.kcal_100g);
    if (!key || seen.has(key) || !Number.isFinite(kcal) || kcal < 0) continue;
    seen.add(key);
    const num = (v) => (Number.isFinite(Number(v)) && Number(v) >= 0 ? Number(v) : 0);
    const serving = Number(f.serving_g);
    list.push({
      name: f.name.trim(),
      name_key: key,
      serving_g: Number.isFinite(serving) && serving > 0 ? serving : null,
      kcal_100g: kcal,
      carb_100g: num(f.carb_100g),
      protein_100g: num(f.protein_100g),
      fat_100g: num(f.fat_100g),
      source: f.source === 'ai_estimate' ? 'ai_estimate' : 'public_api',
      source_ref: f.source_ref || `seed:${version}`,
      fetched_at: now,
    });
  }
  const added = await db.seedFoods(list, version);
  if (added) console.info(`foods.json에서 음식 ${added}개를 캐시에 넣었어요.`);
}

/* =========================================================
 * 이벤트
 * ========================================================= */
let calTimer = 0;
function scheduleCalendar() {
  clearTimeout(calTimer);
  calTimer = setTimeout(() => {
    if (state.tab === 'calendar') renderCalendar();
    else dirty.calendar = true;
  }, 150);
}
let statsTimer = 0;
function scheduleStats() {
  clearTimeout(statsTimer);
  statsTimer = setTimeout(() => {
    if (state.tab === 'stats' && !state.day) renderStats();
    else dirty.stats = true;
  }, 300);
}

function bindEvents() {
  window.addEventListener('popstate', (e) => {
    applyState(e.state);
    if (pendingTab) {
      const t = pendingTab;
      pendingTab = null;
      selectTab(t);
    }
  });

  // 입력 칸에 포커스가 있는 동안(키보드 표시 중) 메뉴바 숨김
  const isTextField = (n) => n && ((n.tagName === 'INPUT' && !['checkbox', 'radio', 'button', 'date'].includes(n.type)) || n.tagName === 'TEXTAREA');
  document.addEventListener('focusin', (e) => {
    if (isTextField(e.target) && matchMedia('(pointer: coarse)').matches) document.body.classList.add('typing');
  });
  document.addEventListener('focusout', () => {
    setTimeout(() => { if (!isTextField(document.activeElement)) document.body.classList.remove('typing'); }, 50);
  });

  for (const b of $$('.tabbar button')) b.addEventListener('click', () => selectTab(b.dataset.tab));
  $('#day-back').addEventListener('click', closeDay);
  $('#day-prev').addEventListener('click', () => moveDay(-1));
  $('#day-next').addEventListener('click', () => moveDay(1));

  onChange((detail) => {
    if (detail.kind === 'logs') {
      tableHandleChange(detail);
      scheduleCalendar();
      scheduleStats();
    } else if (detail.kind === 'profile' || detail.kind === 'weights') {
      scheduleCalendar();
      scheduleStats();
      if (state.day) updateDayCharts(currentLogs());
    }
  });

  const setOnline = () => document.body.classList.toggle('is-offline', !navigator.onLine);
  window.addEventListener('online', () => {
    setOnline();
    lookup.retryPending(); // 밀린 줄 자동 재조회
  });
  window.addEventListener('offline', () => {
    setOnline();
    toast('오프라인이에요. 입력은 계속할 수 있어요');
  });
  setOnline();

  // 다크 모드 전환 시 차트 색 다시 적용
  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
    resetDayCharts();
    if (state.day) updateDayCharts(currentLogs());
    dirty.stats = true;
    if (state.tab === 'stats') { dirty.stats = false; renderStats(); }
  });

  // 앱을 켜 둔 채 날짜가 바뀌면 캘린더 갱신
  let lastToday = todayStr();
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible') return;
    if (todayStr() !== lastToday) {
      lastToday = todayStr();
      renderCalendar();
    }
  });
}

function showFatal(msg) {
  const box = $('#fatal');
  box.textContent = msg;
  box.hidden = false;
}

function registerServiceWorker() {
  if (!('serviceWorker' in navigator)) return;
  navigator.serviceWorker.register('./sw.js').catch((err) => console.warn('서비스 워커 등록 실패', err));
}

/* =========================================================
 * 초기화
 * ========================================================= */
async function init() {
  try {
    await db.openDB();
  } catch (err) {
    console.error(err);
    showFatal(err && err.message && err.message.includes('탭')
      ? err.message
      : '기기 저장소(IndexedDB)를 열 수 없어요. 시크릿 모드가 아닌지 확인해 주세요.');
    return;
  }

  await loadProfile();

  initCalendar($('#view-calendar'), { onSelect: openDay });
  initProfile($('#profile-root'));
  initStats($('#view-stats'));
  initDayCharts($('#day-charts'));
  initDayTable($('#day-table'), { onUpdate: (logs) => updateDayCharts(logs) });

  bindEvents();

  const hs = currentHistoryState();
  if (hs && (hs.tab || hs.day)) applyState(hs);
  else safeHistory('replaceState', { tab: 'calendar', day: null });

  registerServiceWorker();
  if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});

  await seedFromFoodsJson().catch((err) => console.warn('foods.json 시드 실패', err));
  lookup.retryPending();
  // 자동완성 빈도표는 첫 화면을 그린 뒤 한가할 때 만듦 (입력이 먼저 오면 그때 만듦)
  const idle = window.requestIdleCallback || ((fn) => setTimeout(fn, 1200));
  idle(() => db.getAllLogs().then(buildFreq).catch(() => {}));
  if (!lookup.proxyConfigured()) console.info('config.js의 PROXY_URL이 비어 있어 기기 캐시로만 조회합니다.');
}

init();
