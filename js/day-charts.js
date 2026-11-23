// 일별 상세 상단 그래프 2개 (Chart.js, vendor/chart.umd.min.js 전역 Chart 사용)
//  1) 권장 대비 섭취 칼로리 반원 게이지
//  2) 끼니별 칼로리 막대

import { getTargets } from './profile.js';
import { $, cssVar, fmtInt, isNum, MEALS, loadChart } from './util.js';

let gauge = null;
let meal = null;
let root = null;

export function initDayCharts(container) {
  root = container;
  root.innerHTML = `
    <div class="dc-gauge">
      <canvas id="dc-gauge" aria-label="권장 대비 섭취 칼로리"></canvas>
      <div class="dc-gauge-text">
        <b id="dc-gauge-main">0</b>
        <span id="dc-gauge-target"></span>
        <span id="dc-gauge-sub" class="dc-gauge-sub"></span>
      </div>
    </div>
    <div class="dc-box dc-meal"><canvas id="dc-meal" aria-label="끼니별 칼로리"></canvas></div>`;
}

function colors() {
  return {
    ok: cssVar('--ok'),
    low: cssVar('--warn'),
    over: cssVar('--danger'),
    track: cssVar('--line'),
    text: cssVar('--text'),
    muted: cssVar('--muted'),
    carb: cssVar('--carb'),
    protein: cssVar('--protein'),
    fat: cssVar('--fat'),
    primary: cssVar('--primary'),
  };
}

function baseOptions() {
  const c = colors();
  return {
    responsive: true,
    maintainAspectRatio: false,
    animation: { duration: 250 },
    plugins: { legend: { display: false }, tooltip: { enabled: true } },
    color: c.muted,
    font: { family: getComputedStyle(document.body).fontFamily },
  };
}

function ensureCharts() {
  if (gauge || typeof Chart === 'undefined') return;
  const c = colors();
  Chart.defaults.font.family = getComputedStyle(document.body).fontFamily;
  Chart.defaults.color = c.muted;

  gauge = new Chart($('#dc-gauge', root), {
    type: 'doughnut',
    data: { labels: ['섭취', '남음'], datasets: [{ data: [0, 1], backgroundColor: [c.ok, c.track], borderWidth: 0 }] },
    options: {
      ...baseOptions(),
      rotation: -90,
      circumference: 180,
      cutout: '74%',
      plugins: { legend: { display: false }, tooltip: { enabled: false } },
    },
  });

  meal = new Chart($('#dc-meal', root), {
    type: 'bar',
    data: {
      labels: MEALS.map((m) => m.label),
      datasets: [{ label: 'kcal', data: [0, 0, 0, 0], backgroundColor: c.primary, borderRadius: 4, maxBarThickness: 28 }],
    },
    options: {
      ...baseOptions(),
      scales: {
        x: { grid: { display: false } },
        y: { beginAtZero: true, grid: { color: c.track }, ticks: { maxTicksLimit: 4 } },
      },
      plugins: { legend: { display: false }, tooltip: { callbacks: { label: (ctx) => `${fmtInt(ctx.raw)} kcal` } } },
    },
  });
}

/** 표의 기록으로 그래프 갱신 */
let lastLogs = [];
export function updateDayCharts(logs) {
  if (!root) return;
  lastLogs = logs;
  if (typeof Chart === 'undefined') {
    // 숫자는 바로 보여 주고, 그래프는 Chart.js를 불러온 뒤 그림
    loadChart().then(() => updateDayCharts(lastLogs)).catch(() => {});
  } else {
    ensureCharts();
  }
  const t = getTargets();
  const sum = { kcal: 0 };
  const byMeal = Object.fromEntries(MEALS.map((m) => [m.key, 0]));
  for (const l of logs) {
    if (!isNum(l.kcal)) continue;
    sum.kcal += l.kcal;
    byMeal[l.meal_type] = (byMeal[l.meal_type] || 0) + l.kcal;
  }

  // 게이지 텍스트
  const target = t.target;
  $('#dc-gauge-main', root).textContent = fmtInt(sum.kcal);
  $('#dc-gauge-target', root).textContent = target ? `/ ${fmtInt(target)} kcal` : 'kcal';
  const sub = $('#dc-gauge-sub', root);
  if (!target) {
    sub.textContent = '내 정보에서 권장 칼로리 설정';
    sub.className = 'dc-gauge-sub';
  } else if (sum.kcal <= target) {
    sub.textContent = `${fmtInt(target - sum.kcal)} kcal 남음`;
    sub.className = 'dc-gauge-sub';
  } else {
    sub.textContent = `${fmtInt(sum.kcal - target)} kcal 초과`;
    sub.className = 'dc-gauge-sub over';
  }

  if (!gauge) return; // Chart.js를 못 불러온 경우 텍스트만
  const c = colors();
  const ratio = target ? sum.kcal / target : 0;
  const color = !target ? c.primary : ratio > 1.1 ? c.over : ratio < 0.9 ? c.low : c.ok;
  if (!target) {
    gauge.data.datasets[0].data = [sum.kcal > 0 ? 1 : 0, sum.kcal > 0 ? 0 : 1];
  } else {
    const eaten = Math.min(sum.kcal, target);
    gauge.data.datasets[0].data = [eaten, Math.max(0, target - eaten)];
  }
  gauge.data.datasets[0].backgroundColor = [color, c.track];
  gauge.update();

  meal.data.datasets[0].data = MEALS.map((m) => byMeal[m.key]);
  meal.update();
}

/** 테마(다크 모드) 변경 시 색 다시 적용 */
export function resetDayCharts() {
  for (const ch of [gauge, meal]) ch?.destroy();
  gauge = meal = null;
}
