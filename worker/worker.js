/**
 * 식단기록 영양 조회 프록시 (Cloudflare Workers)
 *
 * GET /nutrition?q=음식명
 *   1) 공공데이터포털 "식품의약품안전처_식품영양성분DB정보" Open API 조회
 *   2) 없으면 Claude API가 웹 검색으로 공식 영양성분표를 찾아 값 생성, 검색 실패 시 추정 (status 'estimated')
 *   3) 둘 다 없으면 status 'not_found'
 *
 * 응답: { status: 'found'|'estimated'|'not_found',
 *         candidates: [{ name, serving_g, kcal_100g, carb_100g, protein_100g, fat_100g, source, source_ref }] }
 *
 * 환경변수 (wrangler secret / vars)
 *   DATA_GO_KR_KEY   (secret) 공공데이터포털 일반 인증키 (Decoding 값)
 *   LLM_API_KEY      (secret) Anthropic API 키
 *   ALLOWED_ORIGINS  (var)    허용 Origin, 쉼표 구분. 예: "https://myname.github.io,http://localhost:8000"
 *   LLM_MODEL        (var, 선택) 기본 claude-haiku-5-5
 *   LLM_WEB_SEARCH   (var, 선택) "0"이면 웹 검색 없이 추정만. 기본은 웹 검색 사용
 *   WEB_SEARCH_TOOL  (var, 선택) Anthropic 웹 검색 도구 버전. 기본 web_search_20250305
 *   DAILY_LIMIT      (var, 선택) IP당 하루 조회 수 제한. 기본 300
 *   RATE_KV          (KV 바인딩, 선택) 있으면 조회 수 제한을 KV로 정확히 셈. 없으면 인스턴스 메모리로 대략 셈
 *
 * 개인정보: 앱은 음식명(q)만 보낸다. 이 Worker는 q 외의 정보를 외부로 보내지 않고, 저장하지 않는다.
 */

const MFDS_URL = 'https://apis.data.go.kr/1471000/FoodNtrCpntDbInfo02/getFoodNtrCpntDbInq02';
const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';
const DEFAULT_MODEL = 'claude-haiku-5-5';

// 식약처 응답 필드 (출력메세지 문서 기준). 값이 다르면 여기만 고치면 된다.
const F = {
  name: 'FOOD_NM_KR',
  code: 'FOOD_CD',
  group: 'DB_GRP_NM',        // 음식 / 가공식품 / 원재료성 식품
  maker: 'MAKER_NM',         // 제조사·업체명 (브랜드 매칭용)
  basis: 'NUTRI_AMOUNT_SERVING', // 영양성분함량기준량 (예: "100g")
  kcal: 'AMT_NUM1',          // 에너지(kcal)
  protein: 'AMT_NUM3',       // 단백질(g)
  fat: 'AMT_NUM4',           // 지방(g)
  carb: 'AMT_NUM6',          // 탄수화물(g)
  serving: ['SERVING_SIZE', 'Z10500'], // 1회 섭취참고량, 식품중량 (앞에서부터 사용)
};

const CACHE_TTL = { found: 60 * 60 * 24 * 30, estimated: 60 * 60 * 24 * 30, not_found: 60 * 60 * 24 };
const MAX_Q = 50;
const MAX_CANDIDATES = 5;
const memoryCounter = new Map(); // RATE_KV가 없을 때의 대략적인 제한

export default {
  async fetch(request, env, ctx) {
    const origin = request.headers.get('Origin') || '';
    const allowed = (env.ALLOWED_ORIGINS || '').split(',').map((s) => s.trim()).filter(Boolean);
    const originOk = allowed.includes(origin);
    const cors = originOk
      ? { 'Access-Control-Allow-Origin': origin, 'Vary': 'Origin' }
      : { 'Vary': 'Origin' };

    if (request.method === 'OPTIONS') {
      if (!originOk) return new Response(null, { status: 403, headers: cors });
      return new Response(null, {
        status: 204,
        headers: { ...cors, 'Access-Control-Allow-Methods': 'GET, OPTIONS', 'Access-Control-Max-Age': '86400' },
      });
    }

    const url = new URL(request.url);
    if (url.pathname === '/' || url.pathname === '/health') {
      return json({ ok: true }, 200, cors);
    }
    if (url.pathname !== '/nutrition') return json({ error: 'not_found' }, 404, cors);
    if (request.method !== 'GET') return json({ error: 'method_not_allowed' }, 405, cors);
    // 브라우저 밖(curl 등)에서 Origin 없이 부르는 것도 막음
    if (!originOk) return json({ error: 'forbidden_origin' }, 403, cors);

    const q = cleanQuery(url.searchParams.get('q'));
    if (!q) return json({ error: 'bad_query' }, 400, cors);

    // 캐시 (같은 음식명은 외부 API를 다시 부르지 않음)
    const cache = caches.default;
    const cacheKey = new Request(`https://nutrition-cache.internal/v1?q=${encodeURIComponent(normalize(q))}`);
    const hit = await cache.match(cacheKey);
    if (hit) {
      const body = await hit.text();
      return new Response(body, { status: 200, headers: { ...cors, 'Content-Type': 'application/json; charset=utf-8', 'X-Cache': 'HIT' } });
    }

    // 조회 수 제한 (캐시 적중은 세지 않음)
    const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
    if (!(await allowRequest(env, ip))) {
      return json({ error: 'rate_limited' }, 429, { ...cors, 'Retry-After': '3600' });
    }

    let result;
    try {
      result = await lookup(q, env);
    } catch (err) {
      console.error('lookup failed', err && err.stack ? err.stack : err);
      return json({ error: 'upstream_error' }, 502, cors);
    }

    const body = JSON.stringify(result);
    ctx.waitUntil(cache.put(cacheKey, new Response(body, {
      headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': `max-age=${CACHE_TTL[result.status] || 3600}` },
    })));
    return new Response(body, { status: 200, headers: { ...cors, 'Content-Type': 'application/json; charset=utf-8', 'X-Cache': 'MISS' } });
  },
};

/* ===================== 조회 ===================== */

async function lookup(q, env) {
  let publicError = null;
  if (env.DATA_GO_KR_KEY) {
    // 원래 이름으로 못 찾으면 크기·브랜드를 떼거나 영문 메뉴명을 한글로 바꿔 다시 검색
    const { variants, brand } = queryVariants(q);
    for (const v of variants) {
      try {
        const list = await searchMfds(v, env.DATA_GO_KR_KEY, brand);
        if (list.length) return { status: 'found', candidates: list };
      } catch (err) {
        publicError = err;
        console.warn('MFDS error', v, String(err));
        break; // 키 오류·장애면 나머지 변형도 실패하므로 중단
      }
    }
  }

  if (env.LLM_API_KEY) {
    const est = await estimateWithLlm(q, env);
    if (est) return { status: 'estimated', candidates: [est] };
    return { status: 'not_found', candidates: [] };
  }

  // 공공 API가 오류였고 LLM도 없으면 일시적 오류로 처리(앱이 나중에 재조회)
  if (publicError) throw publicError;
  return { status: 'not_found', candidates: [] };
}

async function searchMfds(q, key, brand = null) {
  const params = new URLSearchParams({
    serviceKey: key,
    pageNo: '1',
    numOfRows: '50',
    type: 'json',
    FOOD_NM_KR: q,
  });
  const res = await fetch(`${MFDS_URL}?${params}`, { headers: { Accept: 'application/json' } });
  const text = await res.text();
  if (!res.ok) throw new Error(`MFDS HTTP ${res.status}: ${text.slice(0, 200)}`);

  let data;
  try {
    data = JSON.parse(text);
  } catch (err) {
    // 인증키 오류 등은 XML로 올 때가 있음
    throw new Error(`MFDS non-JSON: ${text.slice(0, 200)}`);
  }
  const header = data.header || (data.response && data.response.header) || {};
  if (header.resultCode && header.resultCode !== '00') {
    if (header.resultCode === '03') return []; // NODATA_ERROR
    throw new Error(`MFDS ${header.resultCode} ${header.resultMsg || ''}`);
  }
  const bodyObj = data.body || (data.response && data.response.body) || {};
  let items = bodyObj.items;
  if (items && !Array.isArray(items)) items = items.item || [];
  if (items && !Array.isArray(items)) items = [items];
  if (!Array.isArray(items)) items = [];

  const qKey = normalize(q);
  const out = [];
  const seen = new Set();
  for (const it of items) {
    const c = mapMfdsItem(it);
    if (!c) continue;
    const k = normalize(c.name);
    if (seen.has(k)) continue;
    seen.add(k);
    const maker = normalize(`${it[F.maker] || ''} ${it[F.name] || ''}`);
    const brandHit = brand ? brand.keys.some((bk) => maker.includes(bk)) : false;
    out.push({ c, k, group: String(it[F.group] || ''), brandHit });
  }
  // 브랜드 일치 > 완전 일치 > 앞부분 일치 > 음식 분류 > 짧은 이름
  out.sort((a, b) =>
    (b.brandHit - a.brandHit)
    || rank(a.k, qKey) - rank(b.k, qKey)
    || groupRank(a.group) - groupRank(b.group)
    || a.k.length - b.k.length);
  return out.slice(0, MAX_CANDIDATES).map((x) => x.c);
}

function rank(k, q) {
  if (k === q) return 0;
  if (k.startsWith(q)) return 1;
  if (k.includes(q)) return 2;
  return 3;
}
function groupRank(g) {
  if (g.includes('음식')) return 0;
  if (g.includes('원재료')) return 1;
  return 2;
}

function mapMfdsItem(it) {
  const name = String(it[F.name] || '').trim();
  const kcal = num(it[F.kcal]);
  if (!name || kcal == null) return null;
  const basis = grams(it[F.basis]) || 100;
  const f = 100 / basis;
  let serving = null;
  for (const key of F.serving) {
    const g = grams(it[key]);
    if (g) { serving = g; break; }
  }
  return {
    name,
    serving_g: serving ? round2(serving) : null,
    kcal_100g: round2(kcal * f),
    carb_100g: round2((num(it[F.carb]) || 0) * f),
    protein_100g: round2((num(it[F.protein]) || 0) * f),
    fat_100g: round2((num(it[F.fat]) || 0) * f),
    source: 'public_api',
    source_ref: `mfds:${it[F.code] || ''}`,
  };
}


/* ===================== 검색어 변형 ===================== */

// 브랜드: 표기 → 비교용 키들 (업체명·식품명에 들어 있는지 확인)
const BRANDS = [
  ['서브웨이', '써브웨이', 'subway'],
  ['맥도날드', 'mcdonalds', '맥날'],
  ['버거킹', 'burgerking'],
  ['롯데리아', 'lotteria'],
  ['맘스터치', 'momstouch'],
  ['kfc', '케이에프씨'],
  ['쉐이크쉑', 'shakeshack'],
  ['스타벅스', 'starbucks'],
  ['투썸플레이스', '투썸'],
  ['이디야', 'ediya'],
  ['메가커피', '메가mgc커피', '메가'],
  ['컴포즈커피', '컴포즈'],
  ['빽다방'],
  ['폴바셋'],
  ['할리스'],
  ['공차', 'gongcha'],
  ['파리바게뜨', '파리바게트'],
  ['뚜레쥬르'],
  ['던킨', '던킨도너츠', 'dunkin'],
  ['크리스피크림', '크리스피크림도넛'],
  ['배스킨라빈스', '베스킨라빈스', '배라'],
  ['교촌', '교촌치킨'],
  ['bbq', '비비큐'],
  ['bhc', '비에이치씨'],
  ['굽네', '굽네치킨'],
  ['네네치킨'],
  ['처갓집'],
  ['푸라닭'],
  ['도미노', '도미노피자'],
  ['피자헛'],
  ['파파존스'],
  ['본죽'],
  ['김밥천국'],
  ['한솥', '한솥도시락'],
  ['cu', '씨유'],
  ['gs25', 'gs', '지에스'],
  ['세븐일레븐', '7eleven', '7-eleven'],
  ['이마트24', 'emart24'],
  ['노브랜드'],
];

// 흔한 영문 메뉴 약어 → 식약처 DB에서 쓰는 한글 표기
const EN_KO = {
  blt: '비엘티',
  bmt: '비엠티',
  bbq: '바비큐',
  egg: '에그',
  ham: '햄',
  tuna: '참치',
  chicken: '치킨',
  bacon: '베이컨',
  cheese: '치즈',
  steak: '스테이크',
  club: '클럽',
  veggie: '베지',
  italian: '이탈리안',
  americano: '아메리카노',
  latte: '라떼',
};

// 크기 표기: 15cm, 30 cm, 6인치, 12inch, 15센치, 라지/레귤러 등
const SIZE_RE = /\(?\s*\d+(?:\.\d+)?\s*(?:cm|센치|센티|인치|inch|in|")\s*\)?/gi;
const SIZE_WORD_RE = /\s(?:라지|레귤러|미디엄|스몰|톨|그란데|벤티|large|regular|medium|small|tall|grande|venti)(?=\s|$)/gi;

function findBrand(q) {
  const lower = q.toLowerCase();
  for (const names of BRANDS) {
    for (const name of [...names].sort((a, b) => b.length - a.length)) {
      // 맨 앞 단어가 브랜드인 경우만 (예: "서브웨이 BLT", "CU 삼각김밥")
      // 한글 브랜드는 붙여 써도 인정(서브웨이BLT), 영문 브랜드는 띄어 쓴 경우만(cucumber 오인 방지)
      const tail = /^[a-z0-9-]+$/i.test(name) ? '\\s+' : '(?:\\s+|(?=[가-힣a-z0-9]))';
      const re = new RegExp(`^${escapeRe(name)}${tail}`, 'i');
      const m = lower.match(re);
      if (m && q.length > m[0].length) {
        return { label: names[0], keys: names.map(normalize), rest: q.slice(m[0].length).trim() };
      }
    }
  }
  return null;
}

function transliterate(s) {
  return s.replace(/[A-Za-z]+/g, (w) => EN_KO[w.toLowerCase()] || w);
}

function tidy(s) {
  return s.replace(/\s+/g, ' ').replace(/^[\s\-_/]+|[\s\-_/]+$/g, '').trim();
}

/** 검색어 변형 목록 (앞에서부터 시도, 최대 4개) */
function queryVariants(q) {
  const brand = findBrand(q);
  const noSize = tidy(q.replace(SIZE_RE, ' ').replace(SIZE_WORD_RE, ' '));
  const menu = brand ? tidy(brand.rest.replace(SIZE_RE, ' ').replace(SIZE_WORD_RE, ' ')) : noSize;
  const list = [q, noSize, menu, transliterate(menu), transliterate(noSize)];
  const seen = new Set();
  const variants = [];
  for (const v of list) {
    const k = normalize(v);
    if (!k || k.length < 2 || seen.has(k)) continue;
    seen.add(k);
    variants.push(v);
    if (variants.length >= 4) break;
  }
  return { variants, brand };
}

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/* ===================== LLM 추정 ===================== */

async function estimateWithLlm(q, env) {
  // 1차: 웹 검색으로 공식 영양성분표를 찾아보게 함 (LLM_WEB_SEARCH="0"이면 생략)
  if (env.LLM_WEB_SEARCH !== '0') {
    try {
      const r = await callClaude(q, env, true);
      if (r) return r;
    } catch (err) {
      console.warn('web search estimate failed, falling back', String(err));
    }
  }
  // 2차: 검색 없이 추정
  return callClaude(q, env, false);
}

async function callClaude(q, env, withWeb) {
  const model = env.LLM_MODEL || DEFAULT_MODEL;
  const lines = [
    '너는 한국 음식 영양성분 조사원이다. 사용자가 준 음식명 하나의 영양성분을 구한다.',
    '브랜드(예: 서브웨이, 맥도날드, 스타벅스)나 크기(예: 15cm, 30cm, 라지, 톨)가 있으면 그 브랜드의 해당 메뉴·크기 기준으로 하고,',
    'serving_g는 그 크기 1개의 중량으로 한다 (예: 서브웨이 15cm 샌드위치 1개의 g). name에는 브랜드와 크기를 포함한다.',
    '값은 모두 100g 기준으로 환산한다 (1개 기준 값만 있으면 serving_g로 나눠 100g 기준으로 바꾼다).',
  ];
  if (withWeb) {
    lines.push(
      '먼저 web_search로 공식 영양성분표(브랜드 공식 홈페이지, 식품안전나라 등 공공 자료)를 찾아 그 값을 쓴다.',
      '공식 자료가 없으면 신뢰할 만한 자료를 쓰고, 그래도 없으면 일반적인 값으로 추정한다.',
      '검색은 꼭 필요한 만큼만 한다.',
    );
  }
  lines.push(
    '마지막 답은 JSON 객체 하나만 출력한다. 설명, 마크다운, 코드블록 금지.',
    '형식: {"name": 음식명, "serving_g": 숫자 또는 null, "kcal_100g": 숫자, "carb_100g": 숫자, "protein_100g": 숫자, "fat_100g": 숫자'
      + (withWeb ? ', "source_url": 값을 가져온 페이지 주소 또는 null' : '') + '}',
    '음식이 아니거나 알 수 없으면 {"unknown": true} 만 출력한다.',
  );

  const body = {
    model,
    max_tokens: withWeb ? 1500 : 300,
    system: lines.join('\n'),
    messages: [{ role: 'user', content: `음식명: ${q}` }],
  };
  if (withWeb) {
    body.tools = [{ type: env.WEB_SEARCH_TOOL || 'web_search_20250305', name: 'web_search', max_uses: 3 }];
  } else {
    body.temperature = 0;
  }

  const res = await fetch(ANTHROPIC_URL, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': env.LLM_API_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const t = await res.text();
    throw new Error(`LLM HTTP ${res.status}: ${t.slice(0, 200)}`);
  }
  const data = await res.json();
  const textBlocks = (data.content || []).filter((b) => b.type === 'text');
  const text = textBlocks.map((b) => b.text).join('');
  // 검색을 쓰면 앞에 설명이 섞일 수 있으므로 마지막 JSON 객체를 사용
  const objs = text.match(/\{[^{}]*\}/g);
  if (!objs) return null;
  let o;
  try { o = JSON.parse(objs[objs.length - 1]); } catch (err) { return null; }
  if (!o || o.unknown) return null;

  const kcal = num(o.kcal_100g);
  const carb = num(o.carb_100g) ?? 0;
  const protein = num(o.protein_100g) ?? 0;
  const fat = num(o.fat_100g) ?? 0;
  // 말이 안 되는 값은 버림
  if (kcal == null || kcal < 0 || kcal > 900) return null;
  if ([carb, protein, fat].some((v) => v < 0 || v > 100) || carb + protein + fat > 105) return null;
  const serving = num(o.serving_g);

  // 출처: 모델이 적은 주소 > 답변 인용의 첫 주소
  let url = typeof o.source_url === 'string' && /^https?:\/\//.test(o.source_url) ? o.source_url : null;
  if (!url && withWeb) {
    for (const b of textBlocks) {
      const c = (b.citations || []).find((x) => x && typeof x.url === 'string');
      if (c) { url = c.url; break; }
    }
  }
  return {
    name: typeof o.name === 'string' && o.name.trim() ? o.name.trim().slice(0, 50) : q,
    serving_g: serving && serving > 0 && serving < 3000 ? round2(serving) : null,
    kcal_100g: round2(kcal),
    carb_100g: round2(carb),
    protein_100g: round2(protein),
    fat_100g: round2(fat),
    source: 'ai_estimate',
    source_ref: url ? `web:${url.slice(0, 180)}` : `llm:${model}`,
  };
}

/* ===================== 조회 수 제한 ===================== */

async function allowRequest(env, ip) {
  const limit = Number(env.DAILY_LIMIT) || 300;
  const day = new Date().toISOString().slice(0, 10);
  const key = `rl:${day}:${ip}`;
  if (env.RATE_KV) {
    const n = Number(await env.RATE_KV.get(key)) || 0;
    if (n >= limit) return false;
    await env.RATE_KV.put(key, String(n + 1), { expirationTtl: 60 * 60 * 26 });
    return true;
  }
  // KV 없음: 같은 인스턴스 안에서만 세는 대략적인 제한
  if (memoryCounter.size > 5000) memoryCounter.clear();
  const n = memoryCounter.get(key) || 0;
  if (n >= limit) return false;
  memoryCounter.set(key, n + 1);
  return true;
}

/* ===================== 유틸 ===================== */

function cleanQuery(s) {
  if (typeof s !== 'string') return '';
  // 제어문자 제거, 공백 정리, 길이 제한
  const t = s.replace(/[\u0000-\u001f\u007f]/g, '').replace(/\s+/g, ' ').trim();
  if (!t || t.length > MAX_Q) return '';
  return t;
}
function normalize(s) {
  return String(s).replace(/\s+/g, '').toLowerCase();
}
function num(v) {
  if (v == null) return null;
  const s = String(v).replace(/,/g, '').trim();
  if (!s || s === '-' || s.toLowerCase() === 'n/a') return null;
  if (s.toLowerCase() === 'tr') return 0;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}
function grams(v) {
  if (v == null) return null;
  const m = String(v).replace(/,/g, '').match(/(\d+(?:\.\d+)?)\s*(kg|g|ml|mℓ|㎖|l)?/i);
  if (!m) return null;
  const n = Number(m[1]);
  const u = (m[2] || 'g').toLowerCase();
  const g = u === 'kg' || u === 'l' ? n * 1000 : n;
  return g > 0 ? g : null;
}
function round2(n) {
  return Math.round(n * 100) / 100;
}
function json(obj, status, headers) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { ...headers, 'Content-Type': 'application/json; charset=utf-8' },
  });
}
