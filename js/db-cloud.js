// Claude 계정 저장소 백엔드 (claude.ai 아티팩트로 열었을 때만)
//
// window.claude.use('db')의 개인 영역 data/users/<내 id>/ 에 저장합니다.
// 이 영역은 본인만 읽고 쓸 수 있고, 같은 계정이면 PC·폰 어디서 열어도 같은 기록이 보입니다.
//
// 저장 구조
//   data/users/<id>/profile             내 정보 1건
//   data/users/<id>/weights             체중 기록 { list: [...] }
//   data/users/<id>/settings            설정 { values: {key: value} }
//   data/users/<id>/app/days/<날짜>      그날 기록 { date, logs: [...] }  (하루 = 문서 1개)
//   data/users/<id>/app/foods/f<id>     음식 영양값 캐시 1건
//
// 시작할 때 전부 메모리로 읽고(개인 기록 규모라 가벼움), 읽기는 메모리에서,
// 쓰기는 메모리에 바로 반영한 뒤 문서 단위로 모아서(0.4초) 저장합니다.
// 함수 이름·동작은 db-idb.js와 같습니다.

import { nameKey } from './util.js';

const WRITE_DELAY_MS = 400;
const PAGE = 500;

let store = null; // claude db 네임스페이스
let base = '';    // data/users/<id>

const mem = {
  foods: new Map(),   // id → food
  foodKeys: new Map(), // name_key → id
  logs: new Map(),    // id → log
  byDate: new Map(),  // date → Set(id)
  profile: null,
  weights: [],        // [{id, date, weight_kg}]
  settings: {},
};

let lastId = 0;
function newId() {
  // 기기 간 충돌을 피하려고 시각 기반 + 순번
  const t = Date.now() * 100;
  lastId = Math.max(lastId + 1, t);
  return lastId;
}
const clone = (v) => (v == null ? v : structuredClone(v));

/* =========================================================
 * 열기
 * ========================================================= */

/** claude.ai 아티팩트 안이면 저장소를 열고 true, 아니면 false (빠르게) */
export async function tryOpen() {
  if (typeof window === 'undefined' || !window.claude || typeof window.claude.use !== 'function') return false;
  const withTimeout = (p, ms) => Promise.race([p, new Promise((r) => setTimeout(() => r(null), ms))]);
  try {
    const [dbNs, userNs] = await Promise.all([
      withTimeout(Promise.resolve(window.claude.use('db')), 12000),
      withTimeout(Promise.resolve(window.claude.use('user')), 12000),
    ]);
    if (!dbNs || !userNs) return false;
    const uid = await withTimeout(Promise.resolve(userNs.id()), 8000);
    if (!uid) return false;
    store = dbNs;
    base = `data/users/${uid}`;
    await loadAll();
    return true;
  } catch (err) {
    console.warn('Claude 계정 저장소를 열지 못했어요', err);
    store = null;
    return false;
  }
}

async function getAllDocs(collectionPath, orderField) {
  const out = [];
  let last = null;
  for (;;) {
    let q = store.collection(collectionPath).orderBy(orderField);
    if (last != null) q = q.where(orderField, '>', last);
    const snap = await q.limit(PAGE).get();
    for (const d of snap.docs) if (d.exists) out.push(d.data());
    if (snap.size < PAGE) break;
    last = snap.docs[snap.docs.length - 1].data()[orderField];
  }
  return out;
}

async function loadAll() {
  const [profileSnap, weightsSnap, settingsSnap, days, foods] = await Promise.all([
    store.doc(`${base}/profile`).get(),
    store.doc(`${base}/weights`).get(),
    store.doc(`${base}/settings`).get(),
    getAllDocs(`${base}/app/days`, 'date'),
    getAllDocs(`${base}/app/foods`, 'id'),
  ]);
  mem.profile = profileSnap.exists ? clone(profileSnap.data()) : null;
  mem.weights = weightsSnap.exists && Array.isArray(weightsSnap.data().list) ? clone(weightsSnap.data().list) : [];
  mem.settings = settingsSnap.exists && settingsSnap.data().values ? clone(settingsSnap.data().values) : {};
  mem.logs.clear();
  mem.byDate.clear();
  for (const day of days) {
    for (const l of day.logs || []) indexLog(clone(l));
  }
  mem.foods.clear();
  mem.foodKeys.clear();
  for (const f of foods) indexFood(clone(f));
}

/** 다른 기기에서 바뀐 내용을 다시 읽음 (저장 대기 중이면 건너뜀) */
export async function reload() {
  if (!store || hasPendingWrites()) return false;
  await loadAll();
  return true;
}

export function isEmpty() {
  return mem.logs.size === 0 && mem.foods.size === 0 && !mem.profile && mem.weights.length === 0;
}

/** 기기 저장소에 있던 기록을 한 번에 옮겨 넣음 */
export async function importAll({ foods = [], logs = [], profile = null, weights = [], settings = [] }) {
  for (const f of foods) { indexFood(clone(f)); schedule(foodPath(f.id), () => foodBody(f.id)); }
  for (const l of logs) { indexLog(clone(l)); scheduleDay(l.date); }
  if (profile) { mem.profile = clone(profile); schedule(`${base}/profile`, () => mem.profile); }
  if (weights.length) { mem.weights = clone(weights); scheduleWeights(); }
  for (const s of settings) mem.settings[s.key] = s.value;
  scheduleSettings();
  await flush();
}

/* =========================================================
 * 쓰기 큐: 문서마다 한 번에 하나, 연달아 바뀌면 마지막 상태만 저장
 * ========================================================= */
const queue = new Map(); // path → {timer, inflight, dirty, body: () => object|null}
let onErrorCb = () => {};
export function onWriteError(fn) { onErrorCb = fn; }

export function hasPendingWrites() {
  for (const q of queue.values()) if (q.timer || q.inflight || q.dirty) return true;
  return false;
}

function schedule(path, body) {
  let q = queue.get(path);
  if (!q) { q = { timer: 0, inflight: false, dirty: false, body }; queue.set(path, q); }
  q.body = body;
  q.dirty = true;
  if (!q.timer && !q.inflight) q.timer = setTimeout(() => run(path), WRITE_DELAY_MS);
}

async function run(path) {
  const q = queue.get(path);
  if (!q) return;
  q.timer = 0;
  if (q.inflight || !q.dirty) return;
  q.dirty = false;
  q.inflight = true;
  const body = clone(q.body());
  try {
    await writeOnce(path, body);
  } catch (err) {
    if (err && err.code === 'unavailable') {
      // 잠깐의 장애: 한 번만 다시 시도
      await new Promise((r) => setTimeout(r, 800 + Math.random() * 800));
      try { await writeOnce(path, body); } catch (err2) { q.dirty = true; onErrorCb(err2); }
    } else {
      onErrorCb(err);
    }
  } finally {
    q.inflight = false;
    if (q.dirty) q.timer = setTimeout(() => run(path), WRITE_DELAY_MS);
    else queue.delete(path);
  }
}

function writeOnce(path, body) {
  const ref = store.doc(path);
  return body ? ref.set(body) : ref.delete();
}

/** 화면을 떠날 때 등: 대기 중인 저장을 바로 실행하고 끝날 때까지 기다림 */
export async function flush() {
  const paths = [...queue.keys()];
  for (const p of paths) {
    const q = queue.get(p);
    if (q && q.timer) { clearTimeout(q.timer); q.timer = 0; }
  }
  await Promise.all(paths.map((p) => run(p)));
  // 실행 중에 다시 바뀐 것까지
  let guard = 0;
  while (hasPendingWrites() && guard++ < 20) await new Promise((r) => setTimeout(r, 150));
}

const dayPath = (date) => `${base}/app/days/${date}`;
const foodPath = (id) => `${base}/app/foods/f${id}`;

function dayBody(date) {
  const ids = mem.byDate.get(date);
  if (!ids || !ids.size) return null; // 빈 날은 문서 삭제
  return { date, logs: [...ids].map((id) => mem.logs.get(id)) };
}
function foodBody(id) {
  return mem.foods.get(id) || null;
}
function scheduleDay(date) {
  schedule(dayPath(date), () => dayBody(date));
}
function scheduleWeights() {
  schedule(`${base}/weights`, () => ({ list: mem.weights }));
}
function scheduleSettings() {
  schedule(`${base}/settings`, () => ({ values: mem.settings }));
}

/* =========================================================
 * 메모리 색인
 * ========================================================= */
function indexLog(l) {
  const prev = mem.logs.get(l.id);
  if (prev && prev.date !== l.date) mem.byDate.get(prev.date)?.delete(l.id);
  mem.logs.set(l.id, l);
  if (!mem.byDate.has(l.date)) mem.byDate.set(l.date, new Set());
  mem.byDate.get(l.date).add(l.id);
  if (typeof l.id === 'number') lastId = Math.max(lastId, l.id);
  return prev;
}
function indexFood(f) {
  const prev = mem.foods.get(f.id);
  if (prev && prev.name_key !== f.name_key && mem.foodKeys.get(prev.name_key) === f.id) mem.foodKeys.delete(prev.name_key);
  mem.foods.set(f.id, f);
  mem.foodKeys.set(f.name_key, f.id);
  if (typeof f.id === 'number') lastId = Math.max(lastId, f.id);
}

/* =========================================================
 * db-idb.js와 같은 함수들
 * ========================================================= */
export async function getSetting(key) {
  return clone(mem.settings[key]);
}
export async function setSetting(key, value) {
  mem.settings[key] = clone(value);
  scheduleSettings();
}

export async function getFoodById(id) {
  return id == null ? undefined : clone(mem.foods.get(id));
}
export async function getFoodByKey(key) {
  const id = mem.foodKeys.get(key);
  return id == null ? undefined : clone(mem.foods.get(id));
}
export async function upsertFood(food, opts = {}) {
  const key = food.name_key || nameKey(food.name);
  const existingId = mem.foodKeys.get(key);
  const existing = existingId != null ? mem.foods.get(existingId) : null;
  if (existing && opts.keepManual && existing.source === 'manual') return existing.id;
  const rec = { ...clone(food), name_key: key, fetched_at: food.fetched_at || Date.now() };
  rec.id = existing ? existing.id : newId();
  indexFood(rec);
  schedule(foodPath(rec.id), () => foodBody(rec.id));
  return rec.id;
}
export async function seedFoods(list, version) {
  let added = 0;
  for (const f of list) {
    if (mem.foodKeys.has(f.name_key)) continue;
    const rec = { ...clone(f), id: newId() };
    indexFood(rec);
    schedule(foodPath(rec.id), () => foodBody(rec.id));
    added++;
  }
  mem.settings.seed_version = version;
  scheduleSettings();
  return added;
}

export async function getLogsByDate(date) {
  return [...(mem.byDate.get(date) || [])].map((id) => clone(mem.logs.get(id)));
}
export async function getLogsInRange(start, end) {
  const out = [];
  for (const [date, ids] of mem.byDate) {
    if (date < start || date > end) continue;
    for (const id of ids) out.push(clone(mem.logs.get(id)));
  }
  return out.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
}
export async function getLogsByStatus(status) {
  return [...mem.logs.values()].filter((l) => l.lookup_status === status).map(clone);
}
export async function getAllLogs() {
  return [...mem.logs.values()].map(clone);
}
export async function getLog(id) {
  return clone(mem.logs.get(id));
}
export async function putLog(log) {
  const rec = clone(log);
  if (rec.id == null) rec.id = newId();
  const prev = indexLog(rec);
  scheduleDay(rec.date);
  if (prev && prev.date !== rec.date) scheduleDay(prev.date);
  return rec.id;
}
export async function deleteLog(id) {
  const l = mem.logs.get(id);
  if (!l) return;
  mem.logs.delete(id);
  mem.byDate.get(l.date)?.delete(id);
  scheduleDay(l.date);
}

export async function getProfile() {
  return clone(mem.profile) || undefined;
}
export async function putProfile(p) {
  mem.profile = { ...clone(p), id: 'me' };
  schedule(`${base}/profile`, () => mem.profile);
}

export async function getWeights() {
  return clone(mem.weights).sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
}
export async function putWeight(date, weightKg) {
  const existing = mem.weights.find((w) => w.date === date);
  if (existing) existing.weight_kg = weightKg;
  else mem.weights.push({ id: newId(), date, weight_kg: weightKg });
  scheduleWeights();
}
export async function deleteWeight(id) {
  mem.weights = mem.weights.filter((w) => w.id !== id);
  scheduleWeights();
}
