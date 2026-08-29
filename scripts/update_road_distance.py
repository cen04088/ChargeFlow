"""
카카오 모빌리티 API로 IC → 충전소 실제 도로 거리 + 소요시간 갱신
============================================================
카카오 디벨로퍼스 → 앱 → REST API 키 사용
카카오 모빌리티 API는 별도 신청 없이 REST API 키로 바로 사용 가능

사용법:
  cd chargeflow

  # 미리보기 (DB 수정 없음)
  python scripts/update_road_distance.py --kakao-key YOUR_KAKAO_REST_API_KEY --dry-run

  # 실제 갱신
  python scripts/update_road_distance.py --kakao-key YOUR_KAKAO_REST_API_KEY

  # 특정 고속도로만 (테스트용)
  python scripts/update_road_distance.py --kakao-key YOUR_KAKAO_REST_API_KEY --highway gyeongbu --dry-run
"""
import os, sys, time, argparse
import urllib.request, urllib.parse, json
import django

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
os.environ.setdefault('DJANGO_SETTINGS_MODULE', 'config.settings')
django.setup()

from chargeflow.models import NodeStationMapping

KAKAO_NAVI_URL = 'https://apis-navi.kakaomobility.com/v1/directions'

# 실제 도로 거리가 이 값 초과 시 매핑 삭제 (IC에서 너무 먼 경우)
MAX_REAL_DIST_KM  = 8.0
MAX_REAL_MINUTES  = 15


def get_road_info(kakao_key: str, origin_lng: float, origin_lat: float,
                  dest_lng: float, dest_lat: float) -> dict | None:
    """
    카카오 모빌리티 길찾기 API 호출
    반환: { 'distance_km': float, 'duration_min': int } 또는 None
    """
    params = urllib.parse.urlencode({
        'origin':      f'{origin_lng},{origin_lat}',
        'destination': f'{dest_lng},{dest_lat}',
        'priority':    'DISTANCE',   # 최단거리 기준
        'car_type':    1,            # 일반 승용차
    })
    req = urllib.request.Request(
        f'{KAKAO_NAVI_URL}?{params}',
        headers={
            'Authorization': f'KakaoAK {kakao_key}',
            'Content-Type':  'application/json',
        }
    )
    try:
        with urllib.request.urlopen(req, timeout=10) as res:
            data = json.loads(res.read().decode('utf-8'))

        routes = data.get('routes') or []
        if not routes:
            return None

        route = routes[0]
        # result_code 0 = 정상, 그 외 = 경로 없음
        if route.get('result_code', -1) != 0:
            return None

        summary = route.get('summary', {})
        distance_m  = summary.get('distance', 0)    # 미터
        duration_s  = summary.get('duration', 0)    # 초

        return {
            'distance_km':  round(distance_m / 1000, 2),
            'duration_min': max(1, round(duration_s / 60)),
        }

    except urllib.error.HTTPError as e:
        if e.code == 400:
            return None   # 경로 없음 (정상 케이스)
        print(f'    HTTP {e.code}')
        return None
    except Exception as e:
        print(f'    오류: {e}')
        return None


def run(kakao_key: str, hw_filter: str | None, dry_run: bool):
    # 매핑 전체 로드
    qs = NodeStationMapping.objects.select_related(
        'ic_node__highway', 'station'
    )
    if hw_filter:
        qs = qs.filter(ic_node__highway__code=hw_filter)

    total     = qs.count()
    updated   = 0
    removed   = 0
    failed    = 0
    no_route  = 0

    print(f'\n🗺️  카카오 모빌리티 도로 거리 갱신')
    print(f'   대상: {total}개 매핑  |  dry-run={dry_run}')
    print(f'   제거 기준: 도로거리 {MAX_REAL_DIST_KM}km 초과 또는 {MAX_REAL_MINUTES}분 초과\n')

    for i, mapping in enumerate(qs, 1):
        ic      = mapping.ic_node
        station = mapping.station

        ic_lat  = float(ic.latitude)
        ic_lng  = float(ic.longitude)
        s_lat   = float(station.latitude)
        s_lng   = float(station.longitude)

        info = get_road_info(kakao_key, ic_lng, ic_lat, s_lng, s_lat)

        if info is None:
            no_route += 1
            print(f'  [{i:>4}/{total}] 경로없음  {ic.name} → {station.name[:20]}')
            time.sleep(0.12)
            continue

        dist_km  = info['distance_km']
        dur_min  = info['duration_min']
        old_dist = mapping.distance_km
        old_min  = mapping.drive_minutes

        # 범위 초과 시 매핑 삭제
        if dist_km > MAX_REAL_DIST_KM or dur_min > MAX_REAL_MINUTES:
            print(f'  [{i:>4}/{total}] 🗑  제거  {ic.name} → {station.name[:20]}'
                  f'  ({dist_km}km / {dur_min}분 — 범위 초과)')
            if not dry_run:
                mapping.delete()
            removed += 1
        else:
            print(f'  [{i:>4}/{total}] ✅  {ic.name} → {station.name[:20]}'
                  f'  {old_dist}km/{old_min}분 → {dist_km}km/{dur_min}분')
            if not dry_run:
                mapping.distance_km   = dist_km
                mapping.drive_minutes = dur_min
                mapping.save(update_fields=['distance_km', 'drive_minutes'])
            updated += 1

        # API 호출 간격 (카카오 제한: 초당 10회)
        time.sleep(0.12)

    print(f'\n{"═"*60}')
    if dry_run:
        print(f'✅ [DRY-RUN] 완료')
        print(f'   갱신 예정: {updated}개 / 삭제 예정: {removed}개 / 경로없음: {no_route}개')
        print(f'   실제 반영하려면 --dry-run 없이 재실행하세요.')
    else:
        print(f'✅ 완료')
        print(f'   갱신: {updated}개 / 삭제(범위초과): {removed}개 / 경로없음: {no_route}개')
        print(f'\n📌 확인: http://localhost:8000/admin/chargeflow/nodestationmapping/')
    print(f'{"═"*60}')


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description='카카오 모빌리티로 도로 거리+시간 갱신')
    parser.add_argument('--kakao-key', required=True, help='카카오 REST API 키')
    parser.add_argument('--highway',   default=None,
                        help='특정 노선만 (gyeongbu / seohaeAN / yeongdong)')
    parser.add_argument('--dry-run',   action='store_true', help='미리보기만')
    args = parser.parse_args()

    run(args.kakao_key, args.highway, args.dry_run)
