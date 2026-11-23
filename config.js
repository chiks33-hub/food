// 배포 환경 설정. 이 파일만 고치면 됩니다.

// Cloudflare Workers에 worker/worker.js를 배포한 뒤 그 주소를 넣으세요. (끝에 / 없이)
// 예: export const PROXY_URL = 'https://diet-proxy.myname.workers.dev';
// 비워 두면 기기 캐시(foods)에 있는 음식만 자동으로 채워집니다.
export const PROXY_URL = '';

// tools/import_foods.py로 만든 foods.json을 index.html 옆에 두었다면 true로 바꾸세요.
// (true일 때만 앱 시작 시 foods.json을 읽어 기기 캐시를 채웁니다)
export const SEED_FOODS_JSON = false;

// 그래프 라이브러리 위치 (그래프 화면을 처음 열 때 불러옴)
export const CHART_JS_URL = './vendor/chart.umd.min.js';
