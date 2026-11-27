// 영양값 자동 조회
//  1) IndexedDB foods 캐시 (name_key 완전 일치)
//  2) 프록시 GET {PROXY_URL}/nutrition?q=음식명  → 공공 DB, 없으면 LLM 추정
//  조회는 비동기 큐로 처리해서 입력을 막지 않음. 결과는 줄(meal_log)에 바로 저장.

import { PROXY_URL } from '../config.js';
import * as db from './db.js';
import { nameKey, emitChange, isNum } from './util.js';

const CONCURRENCY = 2;
const TIMEOUT_MS = 15000;
const MAX_CANDIDATES = 3;
const FALLBACK_SERVING_G = 100; // 1회 제공량이 없는 음식을 인분/개로 적었을 때

const queue = [];
const queued = new Set();
let running = 0;

export const proxyConfigured = () => typeof PROXY_URL === 'string' && /^https?:\/\//.test(PROXY_URL);

/* ===== 계산 ===== */

/**
 * 양을 g으로.
 * - 인분: 1회 제공량(serving_g). 없으면 100g으로 보고 approx
 * - 개(알·조각): 1개 무게(piece_g). 없으면 1회 제공량, 그것도 없으면 100g으로 보고 approx
 */
export function amountToGrams(qty, unit, servingG, pieceG) {
  if (!isNum(qty) || qty <= 0) return { grams: null, approx: false };
  if (unit === 'g') return { grams: qty, approx: false };
  if (unit === 'piece') {
    if (isNum(pieceG) && pieceG > 0) return { grams: qty * pieceG, approx: false };
    if (isNum(servingG) && servingG > 0) return { grams: qty * servingG, approx: true };
    return { grams: qty * FALLBACK_SERVING_G, approx: true };
  }
  if (isNum(servingG) && servingG > 0) return { grams: qty * servingG, approx: false };
  return { grams: qty * FALLBACK_SERVING_G, approx: true };
}

function statusFromSource(source) {
  return source === 'ai_estimate' ? 'estimated' : 'found';
}

/** 음식(100g 기준)을 줄에 적용: 양 환산 + 영양값 계산 (log 객체를 직접 수정) */
export function applyFood(log, food, status) {
  const { grams, approx } = amountToGrams(log.amount_qty, log.amount_unit, food.serving_g, food.piece_g);
  log.food_id = food.id ?? null;
  log.amount_g = grams;
  log.approx = approx;
  if (grams == null) {
    log.kcal = log.carb = log.protein = log.fat = null;
  } else {
    const r = grams / 100;
    log.kcal = food.kcal_100g * r;
    log.carb = food.carb_100g * r;
    log.protein = food.protein_100g * r;
    log.fat = food.fat_100g * r;
  }
  log.lookup_status = status || statusFromSource(food.source);
  log.updated_at = Date.now();
  return log;
}

/** 줄의 영양값을 비우고 조회 대기 상태로 */
export function resetForLookup(log) {
  log.food_id = null;
  log.amount_g = null;
  log.approx = false;
  log.kcal = log.carb = log.protein = log.fat = null;
  log.candidates = null;
  log.lookup_status = 'pending';
  log.updated_at = Date.now();
  return log;
}

/** 양이 바뀌었을 때 다시 계산. 연결된 음식이 없으면 조회 대기 */
export async function recalc(log) {
  const food = await db.getFoodById(log.food_id);
  if (food) {
    applyFood(log, food, log.lookup_status === 'estimated' ? 'estimated' : statusFromSource(food.source));
  } else if (isNum(log.kcal) && log.lookup_status === 'found') {
    // 음식 캐시가 없는 옛 기록: 기존 100g당 값을 역산해서 비례 계산
    const per100 = per100FromLog(log);
    const { grams, approx } = amountToGrams(log.amount_qty, log.amount_unit, log.amount_unit === 'g' ? null : servingFromLog(log));
    if (per100 && grams != null) {
      const r = grams / 100;
      Object.assign(log, { amount_g: grams, approx, kcal: per100.kcal * r, carb: per100.carb * r, protein: per100.protein * r, fat: per100.fat * r });
    }
    log.updated_at = Date.now();
  } else {
    resetForLookup(log);
  }
  return log;
}

function per100FromLog(log) {
  if (!(log.amount_g > 0)) return null;
  const k = 100 / log.amount_g;
  return { kcal: (log.kcal || 0) * k, carb: (log.carb || 0) * k, protein: (log.protein || 0) * k, fat: (log.fat || 0) * k };
}
function servingFromLog(log) {
  return log.amount_unit !== 'g' && log.amount_qty > 0 && log.amount_g > 0 ? log.amount_g / log.amount_qty : null;
}

/* ===== 후보 정렬: 완전 일치 > 앞부분 일치 > 짧은 이름 ===== */
export function rankCandidates(query, candidates) {
  const q = nameKey(query);
  const score = (c) => {
    const k = nameKey(c.name);
    if (k === q) return 0;
    if (k.startsWith(q)) return 1;
    if (k.includes(q)) return 2;
    return 3;
  };
  return candidates
    .map((c, i) => ({ c, s: score(c), i }))
    // 이름이 겹치지 않는 후보(브랜드·크기를 떼고 찾은 결과 등)는 프록시가 정한 순서를 유지
    .sort((a, b) => a.s - b.s || (a.s < 3 ? nameKey(a.c.name).length - nameKey(b.c.name).length : 0) || a.i - b.i)
    .map((x) => x.c);
}

function validCandidate(c) {
  return c && typeof c.name === 'string' && c.name.trim()
    && [c.kcal_100g, c.carb_100g, c.protein_100g, c.fat_100g].every((v) => isNum(Number(v)) && Number(v) >= 0);
}

function normalizeCandidate(c) {
  const serving = Number(c.serving_g);
  const piece = Number(c.piece_g);
  return {
    name: c.name.trim(),
    serving_g: isNum(serving) && serving > 0 ? serving : null,
    piece_g: isNum(piece) && piece > 0 && piece < 3000 ? piece : null,
    kcal_100g: Number(c.kcal_100g),
    carb_100g: Number(c.carb_100g),
    protein_100g: Number(c.protein_100g),
    fat_100g: Number(c.fat_100g),
    source: c.source === 'ai_estimate' ? 'ai_estimate' : 'public_api',
    source_ref: c.source_ref ? String(c.source_ref).slice(0, 200) : '',
  };
}

/* ===== 프록시 호출 ===== */
async function fetchProxy(query) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const url = `${PROXY_URL.replace(/\/+$/, '')}/nutrition?q=${encodeURIComponent(query)}`;
    // 음식명만 보냄. 쿠키·인증정보 없음
    const res = await fetch(url, { signal: ctrl.signal, credentials: 'omit', cache: 'no-store' });
    if (res.status >= 500 || res.status === 429) return { retry: true };
    if (!res.ok) return { status: 'not_found', candidates: [] };
    const data = await res.json();
    const list = Array.isArray(data.candidates) ? data.candidates.filter(validCandidate).map(normalizeCandidate) : [];
    if (data.status === 'not_found' || !list.length) return { status: 'not_found', candidates: [] };
    return { status: data.status === 'estimated' ? 'estimated' : 'found', candidates: list };
  } catch (err) {
    return { retry: true }; // 네트워크 오류·시간 초과 → 나중에 재조회
  } finally {
    clearTimeout(timer);
  }
}

/* ===== Claude 화면(아티팩트) 안에서의 추정 =====
 * claude.ai 아티팩트로 열면 window.claude.use('sample')로 Claude에게 물을 수 있음.
 * GitHub Pages 등 일반 브라우저에서는 window.claude가 없어 바로 null. */
let samplerPromise = null;
let samplerDisabled = false;
export function getSampler() {
  if (samplerDisabled || typeof window === 'undefined' || !window.claude || typeof window.claude.use !== 'function') {
    return Promise.resolve(null);
  }
  if (!samplerPromise) samplerPromise = Promise.resolve(window.claude.use('sample')).catch(() => null);
  return samplerPromise;
}

/** @returns 후보 객체, {retry:true}(잠시 후 재시도), 또는 null(못 찾음/사용 불가) */
async function estimateInPage(name) {
  const sample = await getSampler();
  if (!sample || typeof sample.json !== 'function') return null;
  const prompt = [
    '너는 한국 음식 영양성분 추정기다. 아래 음식 하나의 일반적인 영양성분을 추정해라.',
    '브랜드(예: 서브웨이, 맥도날드)나 크기(예: 15cm, 라지)가 있으면 그 메뉴·크기 기준으로 추정하고,',
    'serving_g는 1인분(1회 먹는 양)의 중량 g, piece_g는 1개(1알·1조각·1줄 등 셀 수 있는 단위 하나)의 중량 g이다.',
    '셀 수 없는 음식(국, 밥 등)은 piece_g를 null로 한다. 예: 방울토마토 serving_g 100, piece_g 15. 값은 모두 100g 기준이다.',
    '반드시 JSON 객체 하나만 답한다. 형식:',
    '{"name": "대표 음식명", "serving_g": 230, "piece_g": null, "kcal_100g": 160, "carb_100g": 25, "protein_100g": 5, "fat_100g": 4.5}',
    '음식이 아니거나 알 수 없으면 {"unknown": true}',
    '',
    `음식명: ${name}`,
  ].join('\n');
  try {
    const v = await sample.json(prompt, { modelTier: 'quick', cache: { gcTime: 24 * 60 * 60 * 1000 } });
    if (!v || typeof v !== 'object' || v.unknown) return null;
    const cand = { ...v, name: typeof v.name === 'string' && v.name.trim() ? v.name : name, source: 'ai_estimate', source_ref: 'claude-artifact' };
    if (!validCandidate(cand)) return null;
    const c = normalizeCandidate(cand);
    if (c.kcal_100g > 900 || c.carb_100g + c.protein_100g + c.fat_100g > 105) return null;
    return c;
  } catch (err) {
    const code = err && err.code;
    if (code === 'rate_limited' || code === 'upstream_error') return { retry: true };
    if (['not_granted', 'sampling_disabled', 'not_declared', 'capability_disabled', 'capability_removed'].includes(code)) {
      samplerDisabled = true; // 이번 화면에서는 다시 묻지 않음
    }
    return null;
  }
}

/* ===== 1개(1알·1조각) 무게 =====
 * "방울토마토 6개"처럼 개수로 적었는데 음식에 1개 무게(piece_g)가 없으면
 * Claude에게 1개 무게만 물어서 캐시에 더해 둠 (한 번만). 물을 수 없으면 기존 방식(1회 제공량)으로 계산. */
async function estimatePieceInPage(name) {
  const sample = await getSampler();
  if (!sample || typeof sample.json !== 'function') return undefined; // 물을 수 없음
  const prompt = [
    '아래 음식 "1개"(1알·1조각·1줄·1마리 등 보통 세는 단위 하나)의 평균 중량을 g으로 답해라.',
    '셀 수 없는 음식이면 null. 반드시 JSON 하나만: {"piece_g": 15}',
    '',
    `음식명: ${name}`,
  ].join('\n');
  try {
    const v = await sample.json(prompt, { modelTier: 'quick', cache: { gcTime: 24 * 60 * 60 * 1000 } });
    const g = Number(v && v.piece_g);
    return isNum(g) && g > 0 && g < 3000 ? g : null;
  } catch (err) {
    const code = err && err.code;
    if (['not_granted', 'sampling_disabled', 'not_declared', 'capability_disabled', 'capability_removed'].includes(code)) {
      samplerDisabled = true;
    }
    return undefined;
  }
}

async function ensurePieceWeight(key, food) {
  if (food.piece_g > 0 || food.piece_checked) return food;
  const g = await estimatePieceInPage(food.name || key);
  if (g === undefined) return food; // 지금은 물을 수 없음: 다음 기회에
  const updated = { ...food, piece_g: g, piece_checked: true };
  updated.id = await db.upsertFood(updated);
  return updated;
}

/* ===== 큐 ===== */
export function enqueue(logId) {
  if (logId == null || queued.has(logId)) return;
  queued.add(logId);
  queue.push(logId);
  pump();
}

function pump() {
  while (running < CONCURRENCY && queue.length) {
    const id = queue.shift();
    running++;
    lookupRow(id)
      .catch((err) => console.error('조회 실패', err))
      .finally(() => {
        running--;
        queued.delete(id);
        pump();
      });
  }
}

export function isQueued(logId) {
  return queued.has(logId);
}

/** 앱 시작·online 이벤트 때 밀린 줄 재조회 */
export async function retryPending() {
  const [offline, pending] = await Promise.all([db.getLogsByStatus('offline'), db.getLogsByStatus('pending')]);
  for (const l of [...pending, ...offline]) enqueue(l.id);
}

/** 상태만 바꿔 저장 (조회 도중 줄이 수정·삭제됐으면 저장하지 않음) */
async function saveIfUnchanged(logId, key, started, mutate) {
  const log = await db.getLog(logId);
  if (!log || nameKey(log.food_name) !== key) return null;
  // 조회하는 사이 사용자가 kcal을 직접 넣었으면 그 값을 그대로 둠
  if (log.manual_at && log.manual_at >= started) return null;
  mutate(log);
  await db.putLog(log);
  emitChange({ kind: 'logs', date: log.date, id: log.id });
  return log;
}

async function lookupRow(logId) {
  const log = await db.getLog(logId);
  if (!log || !log.food_name) return;
  const key = nameKey(log.food_name);
  const started = Date.now();

  // 1) 캐시
  const cached = await db.getFoodByKey(key);
  if (cached) {
    const food = log.amount_unit === 'piece' ? await ensurePieceWeight(key, cached) : cached;
    await saveIfUnchanged(logId, key, started, (l) => { applyFood(l, food); l.candidates = null; });
    return;
  }

  // 2) 프록시가 없을 때: Claude 화면(아티팩트) 안에서 열렸으면 Claude에게 직접 추정을 요청
  if (!proxyConfigured()) {
    if (!navigator.onLine) {
      await saveIfUnchanged(logId, key, started, (l) => { resetForLookup(l); l.lookup_status = 'offline'; });
      return;
    }
    const est = await estimateInPage(log.food_name);
    if (est && est.retry) {
      await saveIfUnchanged(logId, key, started, (l) => { resetForLookup(l); l.lookup_status = 'offline'; });
    } else if (est) {
      let food = await cacheChoice(key, est);
      if (log.amount_unit === 'piece') food = await ensurePieceWeight(key, food);
      await saveIfUnchanged(logId, key, started, (l) => { applyFood(l, food, 'estimated'); l.candidates = null; });
    } else {
      await saveIfUnchanged(logId, key, started, (l) => { resetForLookup(l); l.lookup_status = 'not_found'; });
    }
    return;
  }
  if (!navigator.onLine) {
    await saveIfUnchanged(logId, key, started, (l) => { resetForLookup(l); l.lookup_status = 'offline'; });
    return;
  }
  // 조회 중 표시
  if (log.lookup_status !== 'pending') {
    await saveIfUnchanged(logId, key, started, (l) => resetForLookup(l));
  }

  const result = await fetchProxy(log.food_name);
  if (result.retry) {
    await saveIfUnchanged(logId, key, started, (l) => { l.lookup_status = 'offline'; l.updated_at = Date.now(); });
    return;
  }
  if (result.status === 'not_found') {
    await saveIfUnchanged(logId, key, started, (l) => { l.lookup_status = 'not_found'; l.candidates = null; l.updated_at = Date.now(); });
    return;
  }

  const ranked = rankCandidates(log.food_name, result.candidates).slice(0, MAX_CANDIDATES);
  const chosen = ranked[0];
  let food = await cacheChoice(key, chosen);
  if (log.amount_unit === 'piece') food = await ensurePieceWeight(key, food);
  await saveIfUnchanged(logId, key, started, (l) => {
    applyFood(l, food, result.status === 'estimated' || chosen.source === 'ai_estimate' ? 'estimated' : 'found');
    l.candidates = ranked.length > 1 ? ranked : null;
    l.candidate_index = 0;
  });
}

/**
 * 고른 후보를 캐시에 저장.
 * - 입력한 이름(name_key = 질의 키)으로 저장 → 다음에 같은 이름을 적으면 즉시 채움
 * - 후보 자체 이름으로도 저장 (이미 manual 값이 있으면 유지)
 */
async function cacheChoice(queryKey, cand) {
  const base = { ...cand, fetched_at: Date.now() };
  const id = await db.upsertFood({ ...base, name_key: queryKey });
  const candKey = nameKey(cand.name);
  if (candKey !== queryKey) await db.upsertFood({ ...base, name_key: candKey }, { keepManual: true });
  return { ...base, id, name_key: queryKey };
}

/** 칩에서 다른 후보를 고름 */
export async function chooseCandidate(logId, index) {
  const log = await db.getLog(logId);
  if (!log || !Array.isArray(log.candidates) || !log.candidates[index]) return;
  const key = nameKey(log.food_name);
  const cand = log.candidates[index];
  const food = await cacheChoice(key, cand);
  applyFood(log, food, cand.source === 'ai_estimate' ? 'estimated' : 'found');
  log.candidate_index = index;
  await db.putLog(log);
  emitChange({ kind: 'logs', date: log.date, id: log.id });
}

export async function dismissCandidates(logId) {
  const log = await db.getLog(logId);
  if (!log) return;
  log.candidates = null;
  await db.putLog(log);
  emitChange({ kind: 'logs', date: log.date, id: log.id });
}

/**
 * kcal·탄단지 값 직접 수정(길게 누르기).
 * 줄의 값을 바꾸고, 그 줄의 양(g)으로 100g당 값을 역산해 음식 캐시를 manual로 갱신.
 */
export async function setManualValue(logId, field, value) {
  const log = await db.getLog(logId);
  if (!log || !['kcal', 'carb', 'protein', 'fat'].includes(field) || !isNum(value) || value < 0) return;
  const key = nameKey(log.food_name);
  const existing = (await db.getFoodById(log.food_id)) || (await db.getFoodByKey(key));

  if (!(log.amount_g > 0)) {
    const servingG = existing ? existing.serving_g : null;
    const { grams, approx } = amountToGrams(log.amount_qty, log.amount_unit, servingG, existing ? existing.piece_g : null);
    log.amount_g = grams;
    log.approx = approx;
  }
  for (const f of ['kcal', 'carb', 'protein', 'fat']) {
    if (!isNum(log[f])) log[f] = 0;
  }
  log[field] = value;

  if (log.amount_g > 0 && key) {
    const k = 100 / log.amount_g;
    const food = {
      name: existing ? existing.name : log.food_name,
      name_key: key,
      serving_g: existing ? existing.serving_g : (log.amount_unit === 'serving' && !log.approx ? log.amount_g / log.amount_qty : null),
      piece_g: existing ? (existing.piece_g ?? null) : (log.amount_unit === 'piece' && !log.approx ? log.amount_g / log.amount_qty : null),
      piece_checked: existing ? !!existing.piece_checked : false,
      kcal_100g: log.kcal * k,
      carb_100g: log.carb * k,
      protein_100g: log.protein * k,
      fat_100g: log.fat * k,
      source: 'manual',
      source_ref: existing && existing.source_ref ? `manual(${existing.source_ref})` : 'manual',
      fetched_at: Date.now(),
    };
    log.food_id = await db.upsertFood(food);
  }
  log.lookup_status = 'found';
  log.candidates = null;
  log.manual_at = Date.now();
  log.updated_at = Date.now();
  await db.putLog(log);
  emitChange({ kind: 'logs', date: log.date, id: log.id });
  emitChange({ kind: 'foods' });
}
