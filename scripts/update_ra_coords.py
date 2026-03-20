"""
전국휴게소정보표준데이터.csv 기준으로 RA 좌표 일괄 업데이트
============================================================
사용법:
  cd chargeflow
  python scripts/update_ra_coords.py --dry-run
  python scripts/update_ra_coords.py
"""
import os, sys, csv, re, argparse
import django

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
os.environ.setdefault('DJANGO_SETTINGS_MODULE', 'config.settings')
django.setup()

from chargeflow.models import HighwayNode

# CSV 경로
CSV_PATH = os.path.join(os.path.dirname(__file__), 'data', '전국휴게소정보표준데이터.csv')

# 대상 노선
HW_MAP = {
    '경부선':  'gyeongbu',
    '영동선':  'yeongdong',
    '서해안선': 'seohaeAN',
}

# 방향 매핑
DIR_MAP = {
    '상행': 'UP',
    '하행': 'DOWN',
    '양방향': None,   # 양방향은 UP/DOWN 둘 다 적용
}

def normalize(name: str) -> str:
    """비교용 이름 정규화 — 방향 괄호, 띄어쓰기, 특수문자 제거"""
    name = re.sub(r'\(.*?\)', '', name)   # (부산), (서울) 등 괄호 제거
    name = name.replace(' ', '').replace('　', '')
    name = name.replace('휴게소', '')
    return name.strip()


def load_csv():
    """CSV에서 {(hw_code, direction, normalized_name): (lat, lng)} 구성"""
    result = {}
    with open(CSV_PATH, encoding='cp949') as f:
        for row in csv.DictReader(f):
            route = row['도로노선명'].strip()
            if route not in HW_MAP:
                continue

            hw_code  = HW_MAP[route]
            raw_dir  = row['도로노선방향'].strip()
            raw_name = row['휴게소명'].strip()

            try:
                lat = float(row['위도'])
                lng = float(row['경도'])
            except ValueError:
                continue

            norm = normalize(raw_name)
            dirs = DIR_MAP.get(raw_dir)

            if dirs is None:   # 양방향
                result[(hw_code, 'UP',   norm)] = (lat, lng)
                result[(hw_code, 'DOWN', norm)] = (lat, lng)
            else:
                result[(hw_code, dirs, norm)] = (lat, lng)

    return result


def run(dry_run: bool):
    csv_data = load_csv()
    print(f'\n📍 CSV 로드 완료: {len(csv_data)}개 항목  dry-run={dry_run}\n')

    nodes = HighwayNode.objects.filter(
        node_type='RA',
        is_active=True,
        highway__code__in=list(HW_MAP.values()),
    ).select_related('highway').order_by('highway', 'direction', 'sequence')

    matched   = 0
    unmatched = []

    print(f'{"노선":<10} {"방향":<5} {"seq":>3}  {"DB 이름":<24} {"결과":<6}  {"위도":>10} {"경도":>11}')
    print('─' * 80)

    for node in nodes:
        hw_code   = node.highway.code
        direction = node.direction
        norm      = normalize(node.name)

        key = (hw_code, direction, norm)
        csv_row = csv_data.get(key)

        if csv_row:
            new_lat, new_lng = csv_row
            old_lat = float(node.latitude)
            old_lng = float(node.longitude)
            diff_m  = int(((abs(new_lat - old_lat)**2 + abs(new_lng - old_lng)**2)**0.5) * 111000)

            print(f'{node.highway.name:<10} {direction:<5} {node.sequence:>3}  '
                  f'{node.name:<24} ✅ 매핑  '
                  f'{new_lat:>10.6f} {new_lng:>11.6f}  (이동 {diff_m}m)')

            if not dry_run:
                node.latitude  = new_lat
                node.longitude = new_lng
                node.save(update_fields=['latitude', 'longitude'])
            matched += 1
        else:
            print(f'{node.highway.name:<10} {direction:<5} {node.sequence:>3}  '
                  f'{node.name:<24} ⚠️  미매핑  (정규화: "{norm}")')
            unmatched.append((node.highway.name, direction, node.name, norm))

    print(f'\n{"═"*80}')
    if dry_run:
        print(f'✅ [DRY-RUN] 매핑 성공: {matched}개 / 미매핑: {len(unmatched)}개')
    else:
        print(f'✅ 좌표 업데이트 완료: {matched}개 / 미매핑: {len(unmatched)}개')

    if unmatched:
        print(f'\n⚠️  미매핑 항목 (수동 확인 필요):')
        for hw, direction, name, norm in unmatched:
            print(f'   {hw} {direction}  {name}  (정규화: "{norm}")')

    if not dry_run and matched > 0:
        print(f'\n📌 이후 실행 필요:')
        print(f'   python scripts/map_ra_stations.py --api-key 키  # RA 매핑 재실행')


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description='전국휴게소 CSV로 RA 좌표 업데이트')
    parser.add_argument('--dry-run', action='store_true', help='미리보기만 (DB 수정 없음)')
    args = parser.parse_args()
    run(args.dry_run)
