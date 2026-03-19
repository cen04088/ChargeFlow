"""
실제 공공데이터 CSV로 HighwayNode 전면 갱신 스크립트
======================================================
사용법:
  cd chargeflow  (manage.py 있는 폴더)

  # 미리보기 (DB 수정 없음)
  python scripts/update_nodes_from_csv.py --dry-run

  # 실제 갱신
  python scripts/update_nodes_from_csv.py

  # 특정 노선만
  python scripts/update_nodes_from_csv.py --highway gyeongbu
"""
import os, sys, csv, re, argparse
import django

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
os.environ.setdefault('DJANGO_SETTINGS_MODULE', 'config.settings')
django.setup()

from chargeflow.models import Highway, HighwayNode

# ── 파일 경로 (스크립트와 같은 위치에 csv 폴더를 만들거나 절대경로 지정) ──
BASE_DIR   = os.path.dirname(os.path.abspath(__file__))
IC_CSV     = os.path.join(BASE_DIR, 'data', 'ETC_AI_05_02_623950.csv')
RA_CSV     = os.path.join(BASE_DIR, 'data', '전국휴게소정보표준데이터.csv')

# ── 노선 매핑 ──────────────────────────────────────────────
HW_MAP = {
    '경부선':  'gyeongbu',
    '영동선':  'yeongdong',
    '서해안선': 'seohaeAN',
}

# ── 방향 기준축 (DOWN 기준 정렬 키) ──────────────────────────
# 경부/서해안: 위도 내림차순 (서울→남쪽)
# 영동:       경도 오름차순 (인천→동쪽)
SORT_KEY = {
    'gyeongbu':  lambda lat, lng: -lat,
    'seohaeAN':  lambda lat, lng: -lat,
    'yeongdong': lambda lat, lng:  lng,
}

# ── RA 이름 정제 ───────────────────────────────────────────
def clean_ra_name(raw: str) -> str:
    """'황간(서울)', '서울만남(부산)' → '황간휴게소', '서울만남휴게소'"""
    name = re.sub(r'\([^)]+\)', '', raw).strip()   # 괄호 제거
    if '휴게소' not in name and '만남의광장' not in name:
        name = name + '휴게소'
    # 특수 케이스
    name = name.replace('서울만남휴게소', '만남의광장휴게소')
    return name

# ── IC 이름 정제 ───────────────────────────────────────────
def clean_ic_name(raw: str) -> str:
    return raw.strip()

# ── RA 방향 파싱 ───────────────────────────────────────────
def parse_ra_directions(raw_dir: str):
    """'상행'→['UP'], '하행'→['DOWN'], '양방향'→['UP','DOWN']"""
    d = raw_dir.strip()
    if d == '상행':   return ['UP']
    if d == '하행':   return ['DOWN']
    if '양방향' in d: return ['UP', 'DOWN']
    # 이름에서 힌트 (서울=상행, 부산/목포/강릉=하행)
    return ['UP', 'DOWN']

# ── IC CSV 로드 ────────────────────────────────────────────
def load_ic_data(hw_filter=None):
    """
    반환: { hw_code: [ {name, lat, lng}, ... ] }
    중복 이름은 좌표 평균으로 합침
    """
    result = {code: {} for code in HW_MAP.values()}

    with open(IC_CSV, encoding='cp949') as f:
        for row in csv.DictReader(f):
            route = row['노선명'].strip()
            if route not in HW_MAP:
                continue
            hw_code = HW_MAP[route]
            if hw_filter and hw_code != hw_filter:
                continue

            name = clean_ic_name(row['IC/JC명'])
            try:
                lat = float(row['Y좌표값'])
                lng = float(row['X좌표값'])
            except ValueError:
                continue
            if not lat or not lng:
                continue

            # 중복 시 좌표 평균
            if name in result[hw_code]:
                prev = result[hw_code][name]
                result[hw_code][name] = {
                    'name': name,
                    'lat':  (prev['lat'] + lat) / 2,
                    'lng':  (prev['lng'] + lng) / 2,
                }
            else:
                result[hw_code][name] = {'name': name, 'lat': lat, 'lng': lng}

    return {k: list(v.values()) for k, v in result.items()}

# ── RA CSV 로드 ────────────────────────────────────────────
def load_ra_data(hw_filter=None):
    """
    반환: { (hw_code, direction): [ {name, lat, lng}, ... ] }
    """
    result = {}

    with open(RA_CSV, encoding='cp949') as f:
        for row in csv.DictReader(f):
            route = row['도로노선명'].strip()
            if route not in HW_MAP:
                continue
            hw_code = HW_MAP[route]
            if hw_filter and hw_code != hw_filter:
                continue

            try:
                lat = float(row['위도'])
                lng = float(row['경도'])
            except ValueError:
                continue

            directions = parse_ra_directions(row['도로노선방향'])
            name       = clean_ra_name(row['휴게소명'])

            for direction in directions:
                key = (hw_code, direction)
                if key not in result:
                    result[key] = {}
                if name not in result[key]:
                    result[key][name] = {'name': name, 'lat': lat, 'lng': lng}

    return {k: list(v.values()) for k, v in result.items()}

# ── 시퀀스 조합 ────────────────────────────────────────────
def build_sequence(hw_code, direction, ic_list, ra_list):
    """
    IC + RA를 지리적 순서로 합쳐 시퀀스 반환
    DOWN: sort_key 오름차순
    UP:   sort_key 내역을 뒤집음 (DOWN의 역방향)
    """
    sort_fn = SORT_KEY[hw_code]

    nodes = []
    for ic in ic_list:
        nodes.append({'type': 'IC', 'name': ic['name'],
                      'lat': ic['lat'], 'lng': ic['lng']})
    for ra in ra_list:
        nodes.append({'type': 'RA', 'name': ra['name'],
                      'lat': ra['lat'], 'lng': ra['lng']})

    # DOWN 기준 정렬
    nodes.sort(key=lambda n: sort_fn(n['lat'], n['lng']))

    if direction == 'UP':
        nodes = list(reversed(nodes))

    # 기점 거리 계산 (첫 노드 기준 haversine)
    import math
    def haversine(lat1, lng1, lat2, lng2):
        R = 6371
        dlat = math.radians(lat2 - lat1)
        dlng = math.radians(lng2 - lng1)
        a = math.sin(dlat/2)**2 + math.cos(math.radians(lat1)) * math.cos(math.radians(lat2)) * math.sin(dlng/2)**2
        return R * 2 * math.asin(math.sqrt(a))

    if nodes:
        base_lat, base_lng = nodes[0]['lat'], nodes[0]['lng']
        for n in nodes:
            n['dist'] = round(haversine(base_lat, base_lng, n['lat'], n['lng']), 1)
    
    for i, n in enumerate(nodes):
        n['sequence'] = i + 1

    return nodes

# ── DB 갱신 ────────────────────────────────────────────────
def update_db(hw_code, direction, nodes, dry_run):
    highway = Highway.objects.get(code=hw_code)

    if not dry_run:
        # 기존 노드 삭제 후 재삽입
        deleted, _ = HighwayNode.objects.filter(
            highway=highway, direction=direction
        ).delete()

    created = 0
    for n in nodes:
        if not dry_run:
            HighwayNode.objects.create(
                highway=highway,
                direction=direction,
                sequence=n['sequence'],
                node_type=n['type'],
                name=n['name'],
                latitude=n['lat'],
                longitude=n['lng'],
                distance_from_start_km=n['dist'],
                is_active=True,
            )
            created += 1

    return created

# ── 메인 ───────────────────────────────────────────────────
def run(hw_filter, dry_run):
    print(f'\n📦 CSV 로드 중...')
    ic_data = load_ic_data(hw_filter)
    ra_data = load_ra_data(hw_filter)

    hw_names = {
        'gyeongbu':  '경부고속도로',
        'yeongdong': '영동고속도로',
        'seohaeAN':  '서해안고속도로',
    }

    total_nodes = 0

    for hw_code, hw_name in hw_names.items():
        if hw_filter and hw_code != hw_filter:
            continue

        ic_list = ic_data.get(hw_code, [])

        for direction in ['DOWN', 'UP']:
            ra_list = ra_data.get((hw_code, direction), [])
            nodes   = build_sequence(hw_code, direction, ic_list, ra_list)

            dir_kor = '하행' if direction == 'DOWN' else '상행'
            ic_cnt  = sum(1 for n in nodes if n['type'] == 'IC')
            ra_cnt  = sum(1 for n in nodes if n['type'] == 'RA')

            print(f'\n▶ {hw_name} {dir_kor} ({direction})  IC:{ic_cnt}  RA:{ra_cnt}  합계:{len(nodes)}개')

            if dry_run:
                print(f'  {"seq":>3}  {"type":4}  {"이름":<22}  {"위도":>9}  {"경도":>10}  {"기점km":>7}')
                print('  ' + '─' * 70)
                for n in nodes:
                    print(f'  {n["sequence"]:>3}  {n["type"]:4}  {n["name"]:<22}  '
                          f'{n["lat"]:>9.4f}  {n["lng"]:>10.4f}  {n["dist"]:>7.1f}km')
            else:
                created = update_db(hw_code, direction, nodes, dry_run)
                print(f'  ✅ {created}개 저장 완료')

            total_nodes += len(nodes)

    print(f'\n{"═"*60}')
    if dry_run:
        print(f'✅ [DRY-RUN] 총 {total_nodes}개 노드 미리보기 완료 (DB 수정 없음)')
    else:
        print(f'✅ 총 {total_nodes}개 노드 갱신 완료!')
    print(f'{"═"*60}')

    if not dry_run:
        print('\n📌 Admin에서 결과 확인:')
        print('   http://localhost:8000/admin/chargeflow/highwaynode/')


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description='공공데이터 CSV로 노드 전면 갱신')
    parser.add_argument('--highway', default=None,
                        help='특정 노선만 (gyeongbu / seohaeAN / yeongdong)')
    parser.add_argument('--dry-run', action='store_true',
                        help='미리보기만 (DB 수정 없음)')
    args = parser.parse_args()

    run(hw_filter=args.highway, dry_run=args.dry_run)
