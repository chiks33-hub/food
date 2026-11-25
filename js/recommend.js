// 점심·저녁 메뉴 추천 (claude.ai 아티팩트로 열었을 때)
// 누를 때마다 새로 추천: 오늘 먹은 것·남은 칼로리·목표·어제 메뉴·오늘 운동·피할 음식을 보고 3개.
// 이미 보여 준 메뉴는 다시 추천하지 않도록 함께 보냄.

import * as db from './db.js';
import { getSampler } from './lookup.js';
import { getTargets, getGoalLabel, getProfileBasics } from './profile.js';
import { MEAL_LABEL, isNum, fmtInt, addDays, nameKey } from './util.js';

/** 끼니별로 쓰기 좋은 몫 (권장 칼로리 대비) */
const SHARE = { breakfast: 0.25, lunch: 0.35, dinner: 0.3, snack: 0.1 };

export async function canRecommend() {
  return !!(await getSampler());
}

/**
 * @param {string} date
 * @param {'lunch'|'dinner'} meal
 * @param {Array} logs 그날 기록
 * @param {string[]} shown 이번에 이미 보여 준 메뉴 이름
 * @returns {Promise<{budget:number|null, options:Array<{name, amount, kcal, reason}>}>}
 */
export async function recommendMeal(date, meal, logs, shown = []) {
  const sampler = await getSampler();
  if (!sampler) throw { code: 'unavailable' };
  const t = getTargets();
  const b = getProfileBasics();
  const eaten = logs.reduce((s, l) => s + (isNum(l.kcal) ? l.kcal : 0), 0);

  // 이 끼니에 쓸 수 있는 칼로리: 남은 양과 끼니 몫 중 작은 쪽(저녁은 남은 양 위주)
  // 이 끼니에 쓸 칼로리: 남은 양과 끼니 몫(점심 35%, 저녁 40%) 중 작은 쪽.
  // 저녁을 추천하는데 점심 기록이 아직 없으면 점심 몫은 남겨 둠
  let budget = null;
  if (t.target) {
    let left = Math.max(0, t.target - eaten);
    if (meal === 'dinner' && !logs.some((l) => l.meal_type === 'lunch')) left -= t.target * SHARE.lunch;
    const cap = t.target * (meal === 'dinner' ? 0.4 : SHARE[meal]);
    budget = Math.max(250, Math.round(Math.min(left, cap))); // 너무 작게 잡지 않음
  }

  const [yLogs, workout] = await Promise.all([
    db.getLogsByDate(addDays(date, -1)),
    db.getWorkout(date),
  ]);
  const todayList = ['breakfast', 'lunch', 'dinner', 'snack']
    .map((m) => {
      const r = logs.filter((l) => l.meal_type === m);
      return r.length ? `${MEAL_LABEL[m]}: ${r.map((l) => `${l.food_name}${isNum(l.kcal) ? ` ${Math.round(l.kcal)}kcal` : ''}`).join(', ')}` : null;
    })
    .filter(Boolean);
  const yNames = [...new Set(yLogs.map((l) => l.food_name))].slice(0, 15);
  const wo = workout && workout.plan ? `${workout.plan.title} (${(workout.plan.items || []).filter((i) => i.done).length}/${(workout.plan.items || []).length} 완료)` : '없음';

  const prompt = [
    `너는 한국인 식단 코치다. 오늘 ${MEAL_LABEL[meal]} 메뉴를 3개 추천해라.`,
    `목표: ${getGoalLabel()}, 하루 권장 ${t.target ? `${fmtInt(t.target)} kcal` : '모름'}, 지금까지 ${fmtInt(eaten)} kcal 먹음`,
    budget ? `이번 ${MEAL_LABEL[meal]}에 쓸 칼로리: 약 ${fmtInt(budget)} kcal (각 메뉴는 이 이하로)` : '',
    `오늘 먹은 것: ${todayList.length ? todayList.join(' / ') : '아직 없음'}`,
    `어제 먹은 메뉴: ${yNames.length ? yNames.join(', ') : '기록 없음'}`,
    `오늘 운동: ${wo}`,
    b.avoid_foods ? `피해야 할 음식(알레르기·기피, 절대 포함 금지): ${b.avoid_foods}` : '',
    shown.length ? `이미 보여 준 메뉴(다시 추천 금지): ${shown.join(', ')}` : '',
    '규칙: 한국에서 쉽게 구할 수 있는 현실적인 메뉴(식당·편의점·집밥을 섞어서). 오늘·어제와 겹치지 않게, 부족한 영양(채소·단백질 등)을 채우는 방향.',
    '극단적으로 적은 양은 피하고 한 끼로 충분한 양으로.',
    '반드시 JSON 하나만: {"options": [{"name": "메뉴 이름", "amount": "양 (예: 1인분, 300g, 2개)", "g": 그 양의 총중량 g, "kcal": 숫자, "carb": g, "protein": g, "fat": g, "reason": "추천 이유 한 줄"}]}',
    'kcal·carb·protein·fat은 그 양 전체 기준.',
    'name은 기록용 음식 이름으로 짧게(예: "닭가슴살 샐러드"), reason은 30자 이내.',
  ].filter(Boolean).join('\n');

  const v = await sampler.json(prompt, { modelTier: 'quick', cache: false });
  const options = (Array.isArray(v && v.options) ? v.options : [])
    .filter((o) => o && typeof o.name === 'string' && o.name.trim())
    .slice(0, 3)
    .map((o) => {
      const num = (x) => (Number.isFinite(Number(x)) && Number(x) >= 0 ? Number(x) : null);
      const g = num(o.g);
      return {
        name: o.name.trim().slice(0, 30),
        amount: typeof o.amount === 'string' ? o.amount.trim().slice(0, 15) : '',
        g: g && g > 0 && g < 3000 ? g : null,
        kcal: num(o.kcal) != null ? Math.round(num(o.kcal)) : null,
        carb: num(o.carb),
        protein: num(o.protein),
        fat: num(o.fat),
        reason: typeof o.reason === 'string' ? o.reason.trim().slice(0, 60) : '',
      };
    });
  if (!options.length) throw { code: 'invalid_json' };
  return { budget, options };
}

/**
 * 추천 메뉴를 기록에 넣기 전에, 추천과 함께 받은 영양값을 음식 캐시에 넣어 둠
 * (그 메뉴 1인분 = 추천한 양). 이미 직접 고친 값(manual)이 있으면 그대로 둠.
 * @returns 기록할 텍스트
 */
export async function prepareRecommended(o) {
  if (o.g > 0 && o.kcal != null) {
    const r = 100 / o.g;
    await db.upsertFood({
      name: o.name,
      name_key: nameKey(o.name),
      serving_g: o.g,
      piece_g: null,
      kcal_100g: o.kcal * r,
      carb_100g: (o.carb || 0) * r,
      protein_100g: (o.protein || 0) * r,
      fat_100g: (o.fat || 0) * r,
      source: 'ai_estimate',
      source_ref: 'claude-recommend',
    }, { keepManual: true });
    return `${o.name} 1인분`;
  }
  return `${o.name}${o.amount ? ` ${o.amount}` : ''}`;
}
