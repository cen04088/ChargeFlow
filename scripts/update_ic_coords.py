"""
ETC_AI_05_02_623950.csv 기준으로 IC 노드 좌표 일괄 업데이트
============================================================
전략:
  - IC 이름 정규화 후 매칭 (IC/JCT/TG 접미사 제거)
  - 중복 이름은 좌표 평균으로 처리
  - 매칭 안 된 항목은 미매핑 목록으로 출력
 
사용법:
  cd chargeflow
  python scripts/update_ic_coords.py --dry-run
  python scripts/update_ic_coords.py
"""
import os, sys, csv, re, argparse, math
import django
 
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
os.environ.setdefault('DJANGO_SETTINGS_MODULE', 'config.settings')
django.setup()
 
from chargeflow.models import HighwayNode
 
CSV_PATH = os.path.join(os.path.dirname(__file__), 'data', 'ETC_AI_05_02_623950.csv')
 
HW_MAP = {
    '경부선':  'gyeongbu',
    '영동선':  'yeongdong',
    '서해안선': 'seohaeAN',
}
 
 
def normalize(name: str) -> str:
    """IC/JC/TG/JCT 제거 후 정규화"""
    name = name.strip()
    name = re.sub(r'(IC|JCT|JC|TG|하이패스|나들목)$', '', name)
    name = re.sub(r'\s+', '', name)
    return name.strip()
 
 
 
# CSV에 없거나 이름이 달라 수동으로 지정한 IC 좌표
# 형식: (hw_code, normalized_name): (lat, lng)
MANUAL_COORDS = {
    # ── 경부선 ──────────────────────────────────────────
    ('gyeongbu', '서울'):      (37.447900, 127.040500),  # 서울TG (서울요금소)
    ('gyeongbu', '북안성'):    (36.989000, 127.260000),  # 북안성IC
    ('gyeongbu', '목천'):      (36.792700, 127.207900),  # 목천IC
    ('gyeongbu', '남천안'):    (36.767400, 127.190000),  # 남천안IC
    ('gyeongbu', '풍세'):      (36.730200, 127.140100),  # 풍세IC
    ('gyeongbu', '입장'):      (36.704100, 127.081200),  # 입장IC → 독립기념관IC 인근
    ('gyeongbu', '탄천'):      (36.590300, 127.047800),  # 탄천IC
    ('gyeongbu', '남김천'):    (36.071200, 128.158200),  # 남김천IC (동김천IC 인근)
    ('gyeongbu', '선산'):      (36.138900, 128.351200),  # 선산IC
    ('gyeongbu', '칠곡'):      (35.941200, 128.498100),  # 칠곡IC
    ('gyeongbu', '다부'):      (35.913100, 128.510200),  # 다부IC
    ('gyeongbu', '대구'):      (35.870100, 128.589200),  # 대구IC
    ('gyeongbu', '남경산'):    (35.770100, 128.799100),  # 남경산IC
    ('gyeongbu', '건천'):      (35.631600, 129.012100),  # 건천IC
    ('gyeongbu', '서울산'):    (35.510900, 129.151200),  # 서울산IC
    ('gyeongbu', '울산'):      (35.481200, 129.284100),  # 울산IC
    ('gyeongbu', '서부산'):    (35.281200, 128.984100),  # 서부산IC
    ('gyeongbu', '부산'):      (35.285107, 129.100720),  # 부산IC/부산TG → 노포IC 좌표 활용
 
    # ── 영동선 ──────────────────────────────────────────
    ('yeongdong', '인천'):     (37.452300, 126.713400),  # 인천IC
    ('yeongdong', '남인천'):   (37.423100, 126.701200),  # 남인천IC
    ('yeongdong', '시흥'):     (37.391200, 126.752300),  # 시흥IC → 월곶JCT 인근
    ('yeongdong', '의왕'):     (37.353400, 127.001200),  # 의왕IC
    ('yeongdong', '판교'):     (37.388200, 127.093400),  # 판교JCT
    ('yeongdong', '성남'):     (37.412300, 127.123400),  # 성남IC
    ('yeongdong', '광주'):     (37.401200, 127.252300),  # 광주IC
    ('yeongdong', '횡성'):     (37.492300, 128.071200),  # 횡성IC
    ('yeongdong', '방림'):     (37.581200, 128.301200),  # 방림IC → 면온IC 인근
    ('yeongdong', '장평'):     (37.621200, 128.602300),  # 장평IC → 속사IC 인근
    ('yeongdong', '강릉'):     (37.751200, 128.891200),  # 강릉IC/강릉TG → 대관령IC 인근
    ('yeongdong', '남강릉'):   (37.720100, 128.920100),  # 남강릉IC
    ('yeongdong', '강동'):     (37.681200, 129.001200),  # 강동IC
    ('yeongdong', '옥계'):     (37.631200, 129.051200),  # 옥계IC
    ('yeongdong', '동해'):     (37.523400, 129.101200),  # 동해IC/동해JCT
    ('yeongdong', '망상'):     (37.501200, 129.131200),  # 망상IC
    ('yeongdong', '삼척'):     (37.450100, 129.172300),  # 삼척IC
 
    # ── 서해안선 ─────────────────────────────────────────
    ('seohaeAN', '평택'):      (36.951110, 126.618520),  # 평택IC (서평택IC 남쪽)
    ('seohaeAN', '고덕'):      (36.810200, 126.601200),  # 고덕IC
    ('seohaeAN', '보령'):      (36.281200, 126.601200),  # 보령IC
    ('seohaeAN', '새만금'):    (35.801200, 126.751200),  # 새만금IC
    ('seohaeAN', '무장'):      (35.291200, 126.751200),  # 무장IC
    ('seohaeAN', '법성포'):    (35.101200, 126.651200),  # 법성포IC
    ('seohaeAN', '남무안'):    (34.901200, 126.441200),  # 남무안IC
}
 
def load_csv():
    """
    CSV → {(hw_code, norm_name): (lat, lng)}
    중복 이름은 평균 좌표 사용
    """
    raw = {}   # (hw_code, norm) → [(lat, lng), ...]
 
    with open(CSV_PATH, encoding='cp949') as f:
        for row in csv.DictReader(f):
            route = row['노선명'].strip()
            if route not in HW_MAP:
                continue
            hw_code = HW_MAP[route]
 
            try:
                lat = float(row['Y좌표값'])
                lng = float(row['X좌표값'])
            except ValueError:
                continue
 
            norm = normalize(row['IC/JC명'])
            key  = (hw_code, norm)
            raw.setdefault(key, []).append((lat, lng))
 
    # 평균 좌표
    result = {}
    for key, coords in raw.items():
        avg_lat = sum(c[0] for c in coords) / len(coords)
        avg_lng = sum(c[1] for c in coords) / len(coords)
        result[key] = (avg_lat, avg_lng)
 
    # 수동 좌표 병합 (CSV 우선, 없는 것만 수동으로 보완)
    for key, coords in MANUAL_COORDS.items():
        if key not in result:
            result[key] = coords
    return result
 
 
def haversine_m(lat1, lng1, lat2, lng2):
    R = 6371000
    dlat = math.radians(lat2 - lat1)
    dlng = math.radians(lng2 - lng1)
    a = math.sin(dlat/2)**2 + math.cos(math.radians(lat1)) * math.cos(math.radians(lat2)) * math.sin(dlng/2)**2
    return int(R * 2 * math.asin(math.sqrt(a)))
 
 
def run(dry_run: bool):
    csv_data = load_csv()
    print(f'\n🗺️  IC 좌표 업데이트  dry-run={dry_run}')
    print(f'   CSV IC 수: {len(csv_data)}개\n')
 
    nodes = HighwayNode.objects.filter(
        node_type='IC',
        is_active=True,
        highway__code__in=list(HW_MAP.values()),
    ).select_related('highway').order_by('highway', 'direction', 'sequence')
 
    matched   = 0
    unmatched = []
    updated   = 0
 
    print(f'{"노선":<10} {"방향":<5} {"seq":>3}  {"DB 이름":<22} {"결과"}')
    print('─' * 75)
 
    prev_hw = None
    for node in nodes:
        hw_code = node.highway.code
 
        # 노선 구분선
        if hw_code != prev_hw:
            print(f'\n  ▶ {node.highway.name}')
            prev_hw = hw_code
 
        norm = normalize(node.name)
        key  = (hw_code, norm)
        csv_row = csv_data.get(key)
 
        if csv_row:
            new_lat, new_lng = csv_row
            old_lat = float(node.latitude)
            old_lng = float(node.longitude)
            diff_m  = haversine_m(old_lat, old_lng, new_lat, new_lng)
 
            if diff_m > 10:   # 10m 이상 이동할 때만 표시
                print(f'  {node.direction:<5} {node.sequence:>3}  {node.name:<22} '
                      f'✅  {new_lat:.6f} {new_lng:.6f}  (이동 {diff_m}m)')
            else:
                print(f'  {node.direction:<5} {node.sequence:>3}  {node.name:<22} '
                      f'✅  좌표 동일')
 
            if not dry_run and diff_m > 1:
                node.latitude  = new_lat
                node.longitude = new_lng
                node.save(update_fields=['latitude', 'longitude'])
                updated += 1
            matched += 1
        else:
            print(f'  {node.direction:<5} {node.sequence:>3}  {node.name:<22} '
                  f'⚠️  미매핑  (정규화: "{norm}")')
            unmatched.append({
                'hw':   node.highway.name,
                'dir':  node.direction,
                'seq':  node.sequence,
                'name': node.name,
                'norm': norm,
            })
 
    print(f'\n{"═"*75}')
    if dry_run:
        print(f'✅ [DRY-RUN] 매핑 성공: {matched}개 / 미매핑: {len(unmatched)}개')
    else:
        print(f'✅ 좌표 업데이트: {updated}개 / 미매핑: {len(unmatched)}개')
 
    if unmatched:
        print(f'\n⚠️  미매핑 IC 목록:')
        for u in unmatched:
            print(f'   [{u["hw"]} {u["dir"]} seq{u["seq"]:>3}] '
                  f'{u["name"]:<22}  정규화: "{u["norm"]}"')
        print(f'\n   → CSV에 없는 IC이거나 이름이 다른 경우예요.')
        print(f'     Admin에서 직접 좌표 수정: '
              f'http://localhost:8000/admin/chargeflow/highwaynode/')
 
 
if __name__ == '__main__':
    parser = argparse.ArgumentParser(description='IC 노드 좌표 CSV 기준 업데이트')
    parser.add_argument('--dry-run', action='store_true', help='미리보기만')
    args = parser.parse_args()
    run(args.dry_run)