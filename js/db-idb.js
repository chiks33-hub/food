// 기기 저장소(IndexedDB) 백엔드 (DB 'diet-log' 버전 2) — js/db.js가 골라서 씀
//
// foods       : 영양값 캐시. name_key(unique)로 조회
// meal_logs   : 일별 표의 한 줄. date, lookup_status 인덱스
// profile     : 내 정보 1건 (id = 'me')
// weight_logs : 체중 기록. date(unique)
// settings    : key-value (seed_version, migrated_from, evals 등)
// workouts    : 하루 운동 계획과 체크 (keyPath date)

import { nameKey } from './util.js';

const DB_NAME = 'diet-log';
const DB_VERSION = 3; // v3: workouts(운동 체크) 추가

let db = null;

/* ===== 열기 + 업그레이드 ===== */
export function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = (e) => upgrade(req.result, req.transaction, e.oldVersion);
    req.onsuccess = () => {
      db = req.result;
      db.onversionchange = () => { db.close(); location.reload(); };
      resolve(db);
    };
    req.onerror = () => reject(req.error);
    req.onblocked = () => reject(new Error('다른 탭에서 앱이 열려 있어 저장소를 업그레이드할 수 없어요. 다른 탭을 닫아 주세요.'));
  });
}

function upgrade(d, tx, oldVersion) {
  // foods
  let foods;
  if (!d.objectStoreNames.contains('foods')) {
    foods = d.createObjectStore('foods', { keyPath: 'id', autoIncrement: true });
  } else {
    foods = tx.objectStore('foods');
    for (const idx of Array.from(foods.indexNames)) {
      if (idx !== 'name_key') foods.deleteIndex(idx); // v1의 source, name 인덱스 제거
    }
  }

  // meal_logs
  let logs;
  if (!d.objectStoreNames.contains('meal_logs')) {
    logs = d.createObjectStore('meal_logs', { keyPath: 'id', autoIncrement: true });
    logs.createIndex('date', 'date');
  } else {
    logs = tx.objectStore('meal_logs');
    if (logs.indexNames.contains('created_at')) logs.deleteIndex('created_at');
  }
  if (!logs.indexNames.contains('lookup_status')) logs.createIndex('lookup_status', 'lookup_status');

  if (!d.objectStoreNames.contains('profile')) d.createObjectStore('profile', { keyPath: 'id' });
  if (!d.objectStoreNames.contains('weight_logs')) {
    const w = d.createObjectStore('weight_logs', { keyPath: 'id', autoIncrement: true });
    w.createIndex('date', 'date', { unique: true });
  }
  if (!d.objectStoreNames.contains('settings')) d.createObjectStore('settings', { keyPath: 'key' });
  if (!d.objectStoreNames.contains('workouts')) d.createObjectStore('workouts', { keyPath: 'date' });

  if (oldVersion === 1) {
    migrateV1(foods, logs, tx.objectStore('settings'));
  } else if (!foods.indexNames.contains('name_key')) {
    foods.createIndex('name_key', 'name_key', { unique: true });
  }
}

/** v1 → v2: 내 음식은 manual로, 샘플·공공 음식은 삭제, 기록은 새 형식으로 */
function migrateV1(foods, logs, settings) {
  const keptIds = new Set();
  const seenKeys = new Set();
  const now = Date.now();

  foods.openCursor().onsuccess = (e) => {
    const cur = e.target.result;
    if (cur) {
      const f = cur.value;
      const key = nameKey(f.name);
      if (f.source !== 'custom' || !key || seenKeys.has(key)) {
        cur.delete();
      } else {
        seenKeys.add(key);
        keptIds.add(f.id);
        cur.update({
          id: f.id,
          name: f.name,
          name_key: key,
          serving_g: f.serving_g ?? null,
          kcal_100g: f.kcal_100g,
          carb_100g: f.carb_100g,
          protein_100g: f.protein_100g,
          fat_100g: f.fat_100g,
          source: 'manual',
          source_ref: 'v1-custom',
          fetched_at: now,
        });
      }
      cur.continue();
      return;
    }
    // 음식 정리가 끝난 뒤 unique 인덱스 생성 + 기록 변환
    foods.createIndex('name_key', 'name_key', { unique: true });
    const orderByDate = new Map();
    logs.openCursor().onsuccess = (ev) => {
      const c = ev.target.result;
      if (!c) {
        settings.put({ key: 'migrated_from', value: 1 });
        return;
      }
      const l = c.value;
      const order = (orderByDate.get(l.date) || 0) + 1;
      orderByDate.set(l.date, order);
      const unit = l.amount_unit === 'serving' ? 'serving' : 'g';
      const qtyText = unit === 'serving' ? `${l.amount_qty}인분` : `${l.amount_g}g`;
      c.update({
        id: l.id,
        date: l.date,
        row_order: order,
        meal_type: l.meal_type,
        raw_text: `${l.food_name} ${qtyText}`,
        food_name: l.food_name,
        amount_qty: l.amount_qty,
        amount_unit: unit,
        amount_g: l.amount_g,
        food_id: keptIds.has(l.food_id) ? l.food_id : null,
        kcal: l.kcal,
        carb: l.carb,
        protein: l.protein,
        fat: l.fat,
        lookup_status: 'found',
        created_at: l.created_at || now,
        updated_at: l.created_at || now,
      });
      c.continue();
    };
  };
}

/* ===== 공통 헬퍼 ===== */
function reqP(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
function txDone(tx) {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error || new Error('트랜잭션이 중단되었습니다.'));
  });
}
function store(name, mode = 'readonly') {
  return db.transaction(name, mode).objectStore(name);
}
async function put(name, value) {
  const tx = db.transaction(name, 'readwrite');
  const done = txDone(tx);
  const key = await reqP(tx.objectStore(name).put(value));
  await done;
  return key;
}
async function del(name, key) {
  const tx = db.transaction(name, 'readwrite');
  const done = txDone(tx);
  tx.objectStore(name).delete(key);
  await done;
}

/* ===== settings ===== */
export async function getSetting(key) {
  const row = await reqP(store('settings').get(key));
  return row ? row.value : undefined;
}
export function setSetting(key, value) {
  return put('settings', { key, value });
}

/* ===== foods (영양값 캐시) ===== */
export function getFoodById(id) {
  return id == null ? Promise.resolve(undefined) : reqP(store('foods').get(id));
}
export function getFoodByKey(key) {
  return reqP(store('foods').index('name_key').get(key));
}

/**
 * name_key 기준 upsert. 같은 키가 있으면 그 id에 덮어씀.
 * opts.keepManual: 기존 값이 manual이면 덮어쓰지 않음
 */
export async function upsertFood(food, opts = {}) {
  const key = food.name_key || nameKey(food.name);
  const tx = db.transaction('foods', 'readwrite');
  const done = txDone(tx);
  const s = tx.objectStore('foods');
  const existing = await reqP(s.index('name_key').get(key));
  let id;
  if (existing && opts.keepManual && existing.source === 'manual') {
    id = existing.id;
  } else {
    const rec = { ...food, name_key: key, fetched_at: food.fetched_at || Date.now() };
    if (existing) rec.id = existing.id;
    else delete rec.id;
    id = await reqP(s.put(rec));
  }
  await done;
  return id;
}

/** foods.json 시드를 한 트랜잭션으로 넣음 (manual·ai_estimate·이미 있는 public_api는 유지) */
export async function seedFoods(list, version) {
  const tx = db.transaction(['foods', 'settings'], 'readwrite');
  const done = txDone(tx);
  const s = tx.objectStore('foods');
  const idx = s.index('name_key');
  let added = 0;
  for (const f of list) {
    const r = idx.getKey(f.name_key);
    r.onsuccess = () => {
      if (r.result === undefined) { s.add(f); added++; }
    };
  }
  tx.objectStore('settings').put({ key: 'seed_version', value: version });
  await done;
  return added;
}

/* ===== meal_logs ===== */
export function getLogsByDate(date) {
  return reqP(store('meal_logs').index('date').getAll(IDBKeyRange.only(date)));
}
export function getLogsInRange(start, end) {
  return reqP(store('meal_logs').index('date').getAll(IDBKeyRange.bound(start, end)));
}
export function getLogsByStatus(status) {
  return reqP(store('meal_logs').index('lookup_status').getAll(IDBKeyRange.only(status)));
}
export function getAllLogs() {
  return reqP(store('meal_logs').getAll());
}
export function getLog(id) {
  return reqP(store('meal_logs').get(id));
}
export function putLog(log) {
  return put('meal_logs', log);
}
export function deleteLog(id) {
  return del('meal_logs', id);
}

/* ===== profile ===== */
export function getProfile() {
  return reqP(store('profile').get('me'));
}
export function putProfile(p) {
  return put('profile', { ...p, id: 'me' });
}

/* ===== weight_logs ===== */
export async function getWeights() {
  const all = await reqP(store('weight_logs').getAll());
  return all.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
}
/** 같은 날짜가 있으면 덮어씀 */
export async function putWeight(date, weightKg) {
  const tx = db.transaction('weight_logs', 'readwrite');
  const done = txDone(tx);
  const s = tx.objectStore('weight_logs');
  const existing = await reqP(s.index('date').get(date));
  const rec = { date, weight_kg: weightKg };
  if (existing) rec.id = existing.id;
  s.put(rec);
  await done;
}
export function deleteWeight(id) {
  return del('weight_logs', id);
}

/* ===== workouts (하루 운동 계획 + 체크) ===== */
export function getWorkout(date) {
  return reqP(store('workouts').get(date));
}
export function getWorkoutsInRange(start, end) {
  return reqP(store('workouts').getAll(IDBKeyRange.bound(start, end)));
}
export function putWorkout(rec) {
  return put('workouts', rec);
}

/* ===== 전체 읽기 (Claude 계정 저장소로 옮길 때 사용) ===== */
export async function exportAll() {
  const [foods, logs, profile, weights, settings, workouts] = await Promise.all([
    reqP(store('foods').getAll()),
    reqP(store('meal_logs').getAll()),
    reqP(store('profile').get('me')),
    getWeights(),
    reqP(store('settings').getAll()),
    reqP(store('workouts').getAll()),
  ]);
  return { foods, logs, profile: profile || null, weights, settings, workouts };
}
