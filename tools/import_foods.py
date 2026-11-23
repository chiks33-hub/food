#!/usr/bin/env python3
"""공공데이터포털 "전국통합식품영양성분정보(음식)" CSV → foods.json 변환기 (앱 캐시 미리 채우기용).

표준 라이브러리만 사용합니다.

사용 예:
    python tools/import_foods.py 음식DB.csv -o foods.json
    python tools/import_foods.py a.csv b.csv -o foods.json --version 2026-11
    python tools/import_foods.py 음식DB.csv --list-columns
    python tools/import_foods.py 음식DB.csv --kcal-col "에너지(㎉)" --serving-col "식품중량"

동작:
    - 인코딩은 utf-8-sig로 먼저 읽고, 실패하면 cp949로 읽습니다(--encoding으로 지정 가능).
    - 컬럼명은 후보 목록으로 자동 탐지하며, 명령행 옵션으로 직접 지정할 수 있습니다.
    - 영양성분 기준량이 100g이 아니면 100g 기준으로 환산합니다.
    - 같은 이름은 처음 나온 것만 남깁니다(여러 파일을 넣으면 앞 파일이 우선).
"""

import argparse
import csv
import datetime as dt
import io
import json
import re
import sys

# 자동 탐지 후보 (앞쪽이 우선). 비교 시 공백 제거·소문자·단위 기호 통일 후 비교.
CANDIDATES = {
    "name": ["식품명", "음식명", "식품이름", "food_name", "name"],
    "basis": ["영양성분함량기준량", "영양성분기준량", "영양성분기준용량", "함량기준량", "기준량"],
    "kcal": ["에너지(kcal)", "열량(kcal)", "에너지", "열량", "kcal"],
    "carb": ["탄수화물(g)", "탄수화물"],
    "protein": ["단백질(g)", "단백질"],
    "fat": ["지방(g)", "지질(g)", "지방", "지질"],
    "serving": ["1회섭취참고량", "1회제공량", "1회섭취량", "식품중량", "총내용량"],
}

FIELD_LABEL = {
    "name": "식품명",
    "basis": "영양성분함량기준량",
    "kcal": "에너지(kcal)",
    "carb": "탄수화물(g)",
    "protein": "단백질(g)",
    "fat": "지방(g)",
    "serving": "1회 섭취참고량/식품중량",
}

REQUIRED = ("name", "kcal")


def norm_header(s):
    """컬럼명 비교용 정규화."""
    s = (s or "").strip().lower()
    s = s.replace("㎉", "kcal").replace("㎎", "mg").replace("㎍", "ug").replace("ｇ", "g")
    s = s.replace("（", "(").replace("）", ")")
    return re.sub(r"\s+", "", s)


def read_csv_text(path, encoding=None):
    """utf-8-sig → cp949 순으로 시도해서 텍스트와 사용한 인코딩을 돌려줌."""
    with open(path, "rb") as f:
        raw = f.read()
    encodings = [encoding] if encoding else ["utf-8-sig", "cp949"]
    last_err = None
    for enc in encodings:
        try:
            return raw.decode(enc), enc
        except UnicodeDecodeError as e:
            last_err = e
    raise SystemExit(f"[오류] {path}: 인코딩을 판별하지 못했습니다 ({last_err}). --encoding 옵션을 써 보세요.")


def detect_columns(headers, overrides):
    """필드별 실제 컬럼명을 찾음. overrides: {field: 컬럼명 or None}."""
    normed = {norm_header(h): h for h in headers if h is not None}
    result = {}
    for field, cands in CANDIDATES.items():
        forced = overrides.get(field)
        if forced:
            key = norm_header(forced)
            if key not in normed:
                raise SystemExit(f"[오류] 지정한 컬럼 '{forced}'이(가) 없습니다. --list-columns로 확인하세요.")
            result[field] = normed[key]
            continue
        found = None
        # 1차: 정확히 일치
        for c in cands:
            if norm_header(c) in normed:
                found = normed[norm_header(c)]
                break
        # 2차: 후보로 시작하고 바로 뒤가 괄호인 경우 (예: "지방(g/100g)")
        #      "포화지방산(g)"처럼 다른 성분이 걸리지 않도록 접두 일치만 허용
        if not found:
            for c in cands:
                nc = norm_header(c)
                for nh, original in normed.items():
                    if nh.startswith(nc) and nh[len(nc):].startswith("("):
                        found = original
                        break
                if found:
                    break
        result[field] = found

    # 1회 제공량은 여러 후보 컬럼을 순서대로 보고, 행마다 처음으로 값이 있는 컬럼을 씀
    # (예: "1회 섭취참고량"이 비어 있으면 "식품중량")
    if overrides.get("serving"):
        result["serving_list"] = [result["serving"]]
    else:
        lst = []
        for c in CANDIDATES["serving"]:
            h = normed.get(norm_header(c))
            if h and h not in lst:
                lst.append(h)
        result["serving_list"] = lst
    return result


def parse_number(value):
    """'1,234.5' → 1234.5, 'tr'/'Tr'(미량) → 0, 빈 값/'-' → None."""
    if value is None:
        return None
    s = str(value).strip().replace(",", "")
    if s == "" or s in {"-", "−", "N/A", "NA", "null", "None"}:
        return None
    if s.lower() == "tr":
        return 0.0
    m = re.search(r"-?\d+(?:\.\d+)?", s)
    if not m:
        return None
    try:
        return float(m.group())
    except ValueError:
        return None


def parse_amount_g(value):
    """'100g', '100 g', '250ml', '1인분(250g)', '100' → g 숫자. 실패 시 None.

    ml는 밀도 1로 보고 g과 같게 취급합니다.
    """
    if value is None:
        return None
    s = str(value).strip().replace(",", "")
    if not s:
        return None
    m = re.search(r"(\d+(?:\.\d+)?)\s*(g|ml|㎖|mℓ|그램|kg)", s, re.IGNORECASE)
    if m:
        n = float(m.group(1))
        return n * 1000 if m.group(2).lower() == "kg" else n
    return parse_number(s)


def clean_name(s):
    return re.sub(r"\s+", " ", (s or "").strip())


def r2(x):
    return round(x + 0.0, 2)


def convert_file(path, args, seen, out, stats):
    text, enc = read_csv_text(path, args.encoding)
    reader = csv.DictReader(io.StringIO(text, newline=""))
    headers = reader.fieldnames or []

    if args.list_columns:
        print(f"== {path} ({enc}) ==")
        for h in headers:
            print(f"  - {h}")
        return

    overrides = {
        "name": args.name_col,
        "basis": args.basis_col,
        "kcal": args.kcal_col,
        "carb": args.carb_col,
        "protein": args.protein_col,
        "fat": args.fat_col,
        "serving": args.serving_col,
    }
    cols = detect_columns(headers, overrides)
    missing = [FIELD_LABEL[f] for f in REQUIRED if not cols.get(f)]
    if missing:
        raise SystemExit(
            f"[오류] {path}: 필수 컬럼({', '.join(missing)})을 찾지 못했습니다. "
            "--list-columns로 컬럼명을 확인하고 --name-col/--kcal-col 등으로 지정하세요."
        )

    print(f"[{path}] 인코딩: {enc}", file=sys.stderr)
    for field in CANDIDATES:
        shown = " → ".join(cols["serving_list"]) if field == "serving" else cols.get(field)
        print(f"  {FIELD_LABEL[field]:<22} ← {shown or '(없음)'}", file=sys.stderr)
    if not cols.get("basis"):
        print("  * 기준량 컬럼이 없어 모든 값을 100g 기준으로 간주합니다.", file=sys.stderr)

    for row in reader:
        stats["rows"] += 1
        name = clean_name(row.get(cols["name"]))
        if not name:
            stats["no_name"] += 1
            continue
        if name in seen:
            stats["dup"] += 1
            continue

        kcal = parse_number(row.get(cols["kcal"]))
        if kcal is None or kcal < 0:
            stats["no_kcal"] += 1
            continue

        basis = parse_amount_g(row.get(cols["basis"])) if cols.get("basis") else None
        if basis is None or basis <= 0:
            basis = 100.0
        factor = 100.0 / basis

        def macro(field):
            if not cols.get(field):
                return 0.0
            v = parse_number(row.get(cols[field]))
            return v if v is not None and v >= 0 else 0.0

        serving = None
        for col in cols["serving_list"]:
            v = parse_amount_g(row.get(col))
            if v is not None and v > 0:
                serving = v
                break

        seen.add(name)
        out.append({
            "name": name,
            "serving_g": r2(serving) if serving is not None else None,
            "kcal_100g": r2(kcal * factor),
            "carb_100g": r2(macro("carb") * factor),
            "protein_100g": r2(macro("protein") * factor),
            "fat_100g": r2(macro("fat") * factor),
            "source": args.source,
        })
        stats["ok"] += 1
        if basis != 100.0:
            stats["converted"] += 1


def main(argv=None):
    p = argparse.ArgumentParser(
        description="전국통합식품영양성분정보(음식) CSV를 식단기록 앱의 foods.json으로 변환합니다.")
    p.add_argument("csv", nargs="+", help="입력 CSV 파일 (여러 개 가능, 앞 파일이 우선)")
    p.add_argument("-o", "--output", default="foods.json", help="출력 파일 (기본: foods.json)")
    p.add_argument("--version", help="foods.json version 값 (기본: public-YYYYMMDD-HHMM)")
    p.add_argument("--source", default="public_api", choices=["public_api", "ai_estimate"],
                   help="음식 source 값 (기본: public_api)")
    p.add_argument("--encoding", help="입력 인코딩 강제 지정 (예: cp949)")
    p.add_argument("--list-columns", action="store_true", help="CSV 컬럼명만 출력하고 종료")
    p.add_argument("--name-col", help="식품명 컬럼")
    p.add_argument("--basis-col", help="영양성분함량기준량 컬럼")
    p.add_argument("--kcal-col", help="에너지(kcal) 컬럼")
    p.add_argument("--carb-col", help="탄수화물(g) 컬럼")
    p.add_argument("--protein-col", help="단백질(g) 컬럼")
    p.add_argument("--fat-col", help="지방(g) 컬럼")
    p.add_argument("--serving-col", help="1회 섭취참고량 또는 식품중량 컬럼")
    args = p.parse_args(argv)

    seen = set()
    foods = []
    stats = {"rows": 0, "ok": 0, "dup": 0, "no_name": 0, "no_kcal": 0, "converted": 0}
    for path in args.csv:
        convert_file(path, args, seen, foods, stats)

    if args.list_columns:
        return 0

    version = args.version or dt.datetime.now().strftime("public-%Y%m%d-%H%M")
    with open(args.output, "w", encoding="utf-8", newline="\n") as f:
        f.write('{\n  "version": ' + json.dumps(version, ensure_ascii=False) + ',\n  "foods": [\n')
        for i, food in enumerate(foods):
            line = json.dumps(food, ensure_ascii=False, separators=(", ", ": "))
            f.write("    " + line + ("," if i < len(foods) - 1 else "") + "\n")
        f.write("  ]\n}\n")

    print(
        f"\n완료: {args.output} (version={version})\n"
        f"  읽은 행 {stats['rows']} / 저장 {stats['ok']} / 중복 이름 제외 {stats['dup']} / "
        f"이름 없음 {stats['no_name']} / 칼로리 없음 {stats['no_kcal']} / 100g 환산 {stats['converted']}",
        file=sys.stderr,
    )
    print("  * foods.json을 앱 폴더(index.html 옆)에 두고 sw.js의 CACHE_VERSION을 올려 배포하면,", file=sys.stderr)
    print("    앱이 기기 캐시(foods)에 미리 넣어 오프라인에서도 바로 채웁니다.", file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main())
