// 저장소 선택: claude.ai 아티팩트로 열면 Claude 계정 저장소(db-cloud.js),
// 그 밖(GitHub Pages, 로컬)에서는 기기 저장소 IndexedDB(db-idb.js).
// 다른 모듈은 이 파일의 함수만 사용합니다.

import * as idb from './db-idb.js';
import * as cloud from './db-cloud.js';

let impl = idb;
/** 'cloud' | 'local' */
export let backend = 'local';

export async function openDB() {
  if (await cloud.tryOpen()) {
    impl = cloud;
    backend = 'cloud';
    await migrateLocalToCloud();
    return;
  }
  await idb.openDB();
}

/** 이 브라우저(기기 저장소)에 적어 둔 기록이 있으면, 계정 저장소가 비어 있을 때 한 번 옮김 */
async function migrateLocalToCloud() {
  if (!cloud.isEmpty()) return;
  try {
    await idb.openDB();
    const data = await idb.exportAll();
    if (data.logs.length || data.foods.length || data.profile || data.weights.length) {
      await cloud.importAll(data);
      console.info(`기기에 있던 기록 ${data.logs.length}줄을 Claude 계정 저장소로 옮겼어요.`);
    }
  } catch (err) {
    // 아티팩트 안에서는 기기 저장소가 막혀 있을 수 있음: 옮길 것이 없다고 봄
  }
}

/** 다른 기기에서 바뀐 내용 다시 읽기 (계정 저장소일 때만 의미 있음) */
export function reload() {
  return backend === 'cloud' ? cloud.reload() : Promise.resolve(false);
}
export function flush() {
  return backend === 'cloud' ? cloud.flush() : Promise.resolve();
}
export function hasPendingWrites() {
  return backend === 'cloud' ? cloud.hasPendingWrites() : false;
}
export function onWriteError(fn) {
  cloud.onWriteError(fn);
}

export const getSetting = (...a) => impl.getSetting(...a);
export const setSetting = (...a) => impl.setSetting(...a);
export const getFoodById = (...a) => impl.getFoodById(...a);
export const getFoodByKey = (...a) => impl.getFoodByKey(...a);
export const upsertFood = (...a) => impl.upsertFood(...a);
export const seedFoods = (...a) => impl.seedFoods(...a);
export const getLogsByDate = (...a) => impl.getLogsByDate(...a);
export const getLogsInRange = (...a) => impl.getLogsInRange(...a);
export const getLogsByStatus = (...a) => impl.getLogsByStatus(...a);
export const getAllLogs = (...a) => impl.getAllLogs(...a);
export const getLog = (...a) => impl.getLog(...a);
export const putLog = (...a) => impl.putLog(...a);
export const deleteLog = (...a) => impl.deleteLog(...a);
export const getProfile = (...a) => impl.getProfile(...a);
export const putProfile = (...a) => impl.putProfile(...a);
export const getWeights = (...a) => impl.getWeights(...a);
export const putWeight = (...a) => impl.putWeight(...a);
export const deleteWeight = (...a) => impl.deleteWeight(...a);
