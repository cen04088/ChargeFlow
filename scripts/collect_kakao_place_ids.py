"""
카카오 로컬 API로 충전소별 Place ID 수집
============================================================
카카오 디벨로퍼스 → 앱 → REST API 키 사용
https://developers.kakao.com/docs/latest/ko/local/dev-guide

전략:
  1. ChargingStation 전체 조회
  2. 충전소 이름 + 좌표로 키워드 검색 (반경 200m)
  3. 가장 가까운 결과의 place_id 저장

사용법:
  python scripts/collect_kakao_place_ids.py --kakao-key 카카오REST키 --dry-run
  python scripts/collect_kakao_place_ids.py --kakao-key REDACTED_KAKAO_API_KEY

  # 미매핑 항목만 재시도
  python scripts/collect_kakao_place_ids.py --kakao-key 카카오REST키 --missing-only
"""
import os, sys, json, time, math, argparse
import urllib.request, urllib.parse
import django

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
os.environ.setdefault('DJANGO_SETTINGS_MODULE', 'config.settings')
django.setup()

from chargeflow.models import ChargingStation

KAKAO_LOCAL_URL = 'https://dapi.kakao.com/v2/local/search/keyword.json'


def haversine_m(lat1, lng1, lat2, lng2):
    R = 6371000
    dlat = math.radians(lat2 - lat1)
    dlng = math.radians(lng2 - lng1)
    a = math.sin(dlat/2)**2 + math.cos(math.radians(lat1)) * math.cos(math.radians(lat2)) * math.sin(dlng/2)**2
    return int(R * 2 * math.asin(math.sqrt(a)))


def search_place(kakao_key: str, name: str, lat: float, lng: float) -> dict | None:
    """
    카카오 로컬 키워드 검색
    이름 + '전기차 충전소' 키워드로 반경 200m 내 검색
    """
    params = urllib.parse.urlencode({
        'query': f'{name} 전기차 충전소',
        'x':     lng,
        'y':     lat,
        'radius': 300,
        'size':   5,
    })
    req = urllib.request.Request(
        f'{KAKAO_LOCAL_URL}?{params}',
        headers={'Authorization': f'KakaoAK {kakao_key}'}
    )
    try:
        with urllib.request.urlopen(req, timeout=10) as res:
            data = json.loads(res.read().decode('utf-8'))

        docs = data.get('documents') or []
        if not docs:
            return None

        # 거리 기준으로 가장 가까운 것 선택
        best = None
        best_dist = float('inf')
        for doc in docs:
            try:
                d_lat = float(doc.get('y', 0))
                d_lng = float(doc.get('x', 0))
                dist  = haversine_m(lat, lng, d_lat, d_lng)
                if dist < best_dist:
                    best_dist = dist
                    best = doc
            except:
                continue

        # 300m 이내만 허용
        if best and best_dist <= 300:
            return {
                'place_id':   best.get('id'),
                'place_name': best.get('place_name'),
                'dist_m':     best_dist,
            }
        return None

    except urllib.error.HTTPError as e:
        if e.code == 429:
            print('    ⚠️  API 한도 초과 — 잠시 대기')
            time.sleep(2)
        return None
    except Exception as e:
        return None


def run(kakao_key: str, dry_run: bool, missing_only: bool):
    qs = ChargingStation.objects.all()
    if missing_only:
        qs = qs.filter(kakao_place_id__isnull=True)

    total   = qs.count()
    found   = 0
    missing = 0

    print(f'\n🔍 카카오 Place ID 수집  총 {total}개  dry-run={dry_run}\n')

    for i, station in enumerate(qs, 1):
        lat = float(station.latitude)
        lng = float(station.longitude)

        result = search_place(kakao_key, station.name, lat, lng)

        if result:
            print(f'  [{i:>4}/{total}] ✅ {station.name[:22]:<22} → '
                  f'{result["place_name"][:20]:<20} '
                  f'id={result["place_id"]}  {result["dist_m"]}m')
            if not dry_run:
                station.kakao_place_id = result['place_id']
                station.save(update_fields=['kakao_place_id'])
            found += 1
        else:
            print(f'  [{i:>4}/{total}] ❌ {station.name[:22]:<22} → 미매핑')
            missing += 1

        time.sleep(0.12)   # API 호출 간격

    print(f'\n{"═"*60}')
    if dry_run:
        print(f'✅ [DRY-RUN] 매핑 가능: {found}개 / 미매핑: {missing}개')
    else:
        print(f'✅ 완료: Place ID 저장 {found}개 / 미매핑 {missing}개')
        if missing > 0:
            print(f'   미매핑 재시도: --missing-only 옵션으로 재실행')
    print('═'*60)


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description='카카오 Place ID 수집')
    parser.add_argument('--kakao-key',    required=True, help='카카오 REST API 키')
    parser.add_argument('--dry-run',      action='store_true')
    parser.add_argument('--missing-only', action='store_true', help='미매핑 항목만 처리')
    args = parser.parse_args()
    run(args.kakao_key, args.dry_run, args.missing_only)
