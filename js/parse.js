// 음식 칸 입력 파싱: "제육볶음 200g" → { name: '제육볶음', qty: 200, unit: 'g' }
//
// 지원하는 양 표기 (입력 끝부분에서만 인식):
//   200g · 200 g · 200그램 · 0.2kg · 250ml        → g
//   2인분 · 1.5인분 · 1공기 · 1그릇 · (공백 뒤) 숫자만 → 인분
//   1개 · 2조각 · 1줄 · 1알 · 1장 · 1잔 · 1컵 · 1캔 · 1봉 → 개 (1회 제공량 = 1개)
//   반 · 반공기 · 반인분 · 1/2                       → 0.5인분
//   반개 · 반조각 · 1/2개                            → 0.5개
//   한/두/세/네/다섯 + 단위 (예: 두 개, 한 공기)
//   양 표기가 없으면 1인분
// 숫자가 이름에 붙어 있고 단위가 없으면(예: 비타500) 이름의 일부로 봅니다.

const KOR_NUM = { 한: 1, 하나: 1, 두: 2, 둘: 2, 세: 3, 셋: 3, 네: 4, 넷: 4, 다섯: 5, 여섯: 6 };
const PIECE_UNITS = ['개', '조각', '줄', '알', '장', '잔', '컵', '캔', '봉', '봉지', '마리', '쪽'];
const SERVING_UNITS = ['인분', '공기', '그릇', '접시', '인'];
const G_UNITS = { g: 1, 그램: 1, ml: 1, 'mℓ': 1, '㎖': 1, kg: 1000, l: 1000 };

const NUM = '(\\d+(?:\\.\\d+)?|\\d+\\/\\d+)';
const KNUM = `(${Object.keys(KOR_NUM).join('|')})`;
const PIECE_RE = PIECE_UNITS.sort((a, b) => b.length - a.length).join('|');
const SERVING_RE = SERVING_UNITS.join('|');
const G_RE = Object.keys(G_UNITS).sort((a, b) => b.length - a.length).join('|');

function toNumber(s) {
  if (s in KOR_NUM) return KOR_NUM[s];
  if (s.includes('/')) {
    const [a, b] = s.split('/').map(Number);
    return b ? a / b : NaN;
  }
  return Number(s);
}

// 순서가 중요: 앞에서 매칭되면 멈춤. 각 패턴은 문자열 끝($)에서 찾음.
const PATTERNS = [
  // 숫자 + g 계열 (공백 없이 붙어도 허용: 제육볶음200g)
  { re: new RegExp(`${NUM}\\s*(${G_RE})$`, 'i'), unit: 'g', conv: (m) => toNumber(m[1]) * G_UNITS[m[2].toLowerCase()] },
  // 숫자 + 개 계열
  { re: new RegExp(`${NUM}\\s*(${PIECE_RE})$`), unit: 'piece', conv: (m) => toNumber(m[1]) },
  // 숫자 + 인분 계열
  { re: new RegExp(`${NUM}\\s*(${SERVING_RE})$`), unit: 'serving', conv: (m) => toNumber(m[1]) },
  // 한글 수 + 단위 (두 개, 한 공기)
  { re: new RegExp(`(?:^|\\s)${KNUM}\\s*(${PIECE_RE})$`), unit: 'piece', conv: (m) => toNumber(m[1]) },
  { re: new RegExp(`(?:^|\\s)${KNUM}\\s*(${SERVING_RE})$`), unit: 'serving', conv: (m) => toNumber(m[1]) },
  // 반개, 반조각
  { re: new RegExp(`반\\s*(${PIECE_RE})$`), unit: 'piece', conv: () => 0.5 },
  // 반, 반공기, 반인분 (공백 뒤 '반'만: '김밥 반'. '쟁반'처럼 이름 끝 '반'은 제외)
  { re: new RegExp(`(?:^|\\s)반\\s*(${SERVING_RE})?$`), unit: 'serving', conv: () => 0.5 },
  // 공백 뒤 숫자만 → 인분 (라면 2, 김밥 1/2)
  { re: new RegExp(`\\s${NUM}$`), unit: 'serving', conv: (m) => toNumber(m[1]) },
];

/**
 * @returns {{name: string, qty: number, unit: 'g'|'serving'|'piece', explicit: boolean}}
 * explicit=false 이면 양 표기가 없어 기본값(1인분)을 쓴 것
 */
export function parseEntry(text) {
  const raw = String(text || '').trim().replace(/\s+/g, ' ');
  if (!raw) return { name: '', qty: 1, unit: 'serving', explicit: false };

  for (const p of PATTERNS) {
    const m = raw.match(p.re);
    if (!m) continue;
    const name = raw.slice(0, m.index).trim();
    const qty = p.conv(m);
    if (!name || !Number.isFinite(qty) || qty <= 0) continue;
    return { name, qty: cleanQty(qty), unit: p.unit, explicit: true };
  }
  return { name: raw, qty: 1, unit: 'serving', explicit: false };
}

/**
 * 양 칸 입력 파싱: "200g", "2", "1개", "반", "1/2" 등.
 * 해석할 수 없으면 null
 */
export function parseAmount(text) {
  const s = String(text || '').trim();
  if (!s) return null;
  const r = parseEntry(`x ${s}`);
  if (!r.explicit || r.name !== 'x') return null;
  return { qty: r.qty, unit: r.unit };
}

function cleanQty(q) {
  return Math.round(q * 1000) / 1000;
}

/** 표시용: 200g / 1.5인분 / 2개 */
export function formatAmount(qty, unit) {
  if (!Number.isFinite(qty)) return '';
  const q = Math.round(qty * 100) / 100;
  const qs = q.toLocaleString('ko-KR', { maximumFractionDigits: 2 });
  if (unit === 'g') return `${qs}g`;
  if (unit === 'piece') return `${qs}개`;
  return `${qs}인분`;
}
