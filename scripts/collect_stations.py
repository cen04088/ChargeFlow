"""
환경부 전기차 충전소 수집 스크립트 v3 (중복 제거 버전)
======================================================
중복 원인 2가지 수정:
  1. API가 충전기 1기당 1행 반환 → statId 기준으로 충전소 단위 합산
  2. 같은 IC가 상행/하행 두 방향으로 DB에 존재 → IC 이름 기준 중복 제거

사용법:
  python scripts/collect_stations.py --api-key 발급받은키 --zcode 41 --dry-run
  python scripts/collect_stations.py --api-key 발급받은키
"""
import os, sys, math, time, argparse, json
import urllib.request, urllib.parse
import django

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
os.environ.setdefault('DJANGO_SETTINGS_MODULE', 'config.settings')
django.setup()

from chargeflow.models import HighwayNode, ChargingStation, NodeStationMapping

API_URL           = 'https://apis.data.go.kr/B552584/EvCharger/getChargerInfo'
MAX_DIST_KM       = 5.0
MAX_DRIVE_MINUTES = 15
SPEED_KMH         = 30
PAGE_SIZE         = 9999

ZCODES = {
    '서울':  '11', '경기':  '41', '인천':  '28',
    '강원':  '51', '충북':  '43', '충남':  '44',   # 강원특별자치도 42→51
    '대전':  '30', '경북':  '47', '대구':  '27',
    '경남':  '48', '부산':  '26', '울산':  '31',
    '전북':  '52', '전남':  '46',                   # 전북특별자치도 45→52
    '광주':  '29', '세종':  '36', '제주':  '50',    # 누락 지역 추가
}

# 두 자리 + 한 자리 모두 포함
FAST_TYPES = {'03', '04', '05', '06', '07', '3', '4', '5', '6', '7'}

POWER_DEFAULTS = {'03': 50, '04': 100, '05': 100, '06': 100, '07': 50,
                  '3':  50, '4':  100, '5':  100, '6':  100, '7':  50}

PLACE_TYPE_MAP = [
    ('mart',        ['이마트', '홈플러스', '롯데마트', '코스트코', '트레이더스', '하이마트']),
    ('gas_station', ['주유소', 'GS칼텍스', 'SK에너지', '현대오일', 'S-OIL', '에쓰오일', '오일뱅크']),
    ('hotel',       ['호텔', '모텔', '리조트', '펜션']),
    ('public',      ['공영', '주민센터', '구청', '시청', '공공', '아울렛', '터미널', '역사']),
]

def classify(name):
    for ptype, kws in PLACE_TYPE_MAP:
        if any(kw in name for kw in kws):
            return ptype
    return 'etc'

def haversine(lat1, lng1, lat2, lng2):
    R = 6371
    dlat = math.radians(lat2 - lat1)
    dlng = math.radians(lng2 - lng1)
    a = (math.sin(dlat/2)**2
         + math.cos(math.radians(lat1)) * math.cos(math.radians(lat2))
         * math.sin(dlng/2)**2)
    return R * 2 * math.asin(math.sqrt(a))

def est_minutes(dist_km):
    return round(dist_km * 1.3 / SPEED_KMH * 60)

def fetch(api_key, zcode):
    params = urllib.parse.urlencode({
        'serviceKey': api_key,
        'pageNo':     1,
        'numOfRows':  PAGE_SIZE,
        'dataType':   'JSON',
        'zcode':      zcode,
    })
    try:
        req = urllib.request.Request(
            f'{API_URL}?{params}',
            headers={'Accept': 'application/json'}
        )
        with urllib.request.urlopen(req, timeout=20) as res:
            data = json.loads(res.read().decode('utf-8'))
        body  = data.get('body') or data
        items = body.get('items') or {}
        if isinstance(items, dict):
            items = items.get('item') or []
        if isinstance(items, dict):
            items = [items]
        return items or []
    except urllib.error.HTTPError as e:
        print(f'    HTTP {e.code} 오류')
        return []
    except Exception as e:
        print(f'    오류: {e}')
        return []

def collect(api_key, zcode_filter=None, dry_run=False, empty_only=False):
    # ── IC 로드: (highway_code, ic_name) 기준 중복 제거 ──
    ic_nodes = list(
        HighwayNode.objects.filter(node_type='IC', is_active=True)
        .select_related('highway')
    )
    seen_ic = {}
    for ic in ic_nodes:
        key = (ic.highway.code, ic.name)
        if key not in seen_ic:
            seen_ic[key] = ic
    ic_unique = list(seen_ic.values())

    # --empty-only: 충전소 매핑이 없는 IC만 대상
    if empty_only:
        ic_unique = [ic for ic in ic_unique if ic.nearby_stations.count() == 0]
        print(f'  [empty-only] 충전소 없는 IC만 대상: {len(ic_unique)}개')
    ic_coords = [(ic, float(ic.latitude), float(ic.longitude)) for ic in ic_unique]

    print(f'\n수집 기준 IC: {len(ic_unique)}개 (상하행 중복 제거 후)  반경 {MAX_DIST_KM}km  dry-run={dry_run}\n')

    zcodes = {'지정시도': zcode_filter} if zcode_filter else ZCODES
    total_s = total_m = 0

    for zname, zcode in zcodes.items():
        print(f'[{zname}] zcode={zcode} 수집 중...')
        raw = fetch(api_key, zcode)

        if not raw:
            print('   응답 없음\n')
            time.sleep(0.5)
            continue

        # ── 충전기 → 충전소 단위로 합산 (statId 기준) ──
        stat_map = {}
        for s in raw:
            if str(s.get('chgerType', '')).strip() not in FAST_TYPES:
                continue
            sid = (s.get('statId') or '').strip()
            if not sid:
                continue
            if sid not in stat_map:
                stat_map[sid] = {'row': s, 'count': 1}
            else:
                stat_map[sid]['count'] += 1

        stations_deduped = [
            dict(**e['row'], _charger_count=e['count'])
            for e in stat_map.values()
        ]
        print(f'   전체 {len(raw)}행  →  급속 충전소(중복제거) {len(stations_deduped)}개')

        matched = 0
        for s in stations_deduped:
            try:
                s_lat = float(s.get('lat') or 0)
                s_lng = float(s.get('lng') or 0)
                if not s_lat or not s_lng:
                    continue

                nearby = []
                for ic, ic_lat, ic_lng in ic_coords:
                    dist = haversine(ic_lat, ic_lng, s_lat, s_lng)
                    if dist <= MAX_DIST_KM:
                        mins = est_minutes(dist)
                        if mins <= MAX_DRIVE_MINUTES:
                            nearby.append((ic, dist, mins))

                if not nearby:
                    continue

                name          = (s.get('statNm') or s.get('busiNm') or '충전소').strip()

                # 고속도로 휴게소 충전소 제외
                if '휴게소' in name:
                    continue
                addr          = (s.get('addr') or '').strip()
                operator      = (s.get('busiNm') or '').strip()
                stat_id       = (s.get('statId') or '').strip() or None
                open_hours    = (s.get('useTime') or '').strip()
                ptype         = classify(name)
                ct            = str(s.get('chgerType', ''))
                power_kw      = int(s.get('output') or 0) or POWER_DEFAULTS.get(ct, 50)
                charger_count = s.get('_charger_count', 1)

                if dry_run:
                    seen_names = set()
                    for ic, dist, mins in nearby:
                        if ic.name not in seen_names:
                            seen_names.add(ic.name)
                            print(f'   ✔ {name[:22]:<22} → {ic.name:<14} '
                                  f'{dist:.2f}km {mins}분 [{ptype}] 충전기{charger_count}기')
                    matched += 1
                else:
                    station, _ = ChargingStation.objects.update_or_create(
                        source_api_id=stat_id,
                        defaults=dict(
                            name=name, address=addr,
                            latitude=s_lat, longitude=s_lng,
                            place_type=ptype, power_kw=power_kw,
                            charger_count=charger_count,
                            operator=operator,
                            open_hours=open_hours, is_verified=False,
                        )
                    )
                    seen_ic_names = set()
                    for ic, dist, mins in nearby:
                        if ic.name in seen_ic_names:
                            continue
                        seen_ic_names.add(ic.name)
                        # 매핑은 상행/하행 모두 등록 (같은 이름 IC의 모든 방향)
                        for real_ic in ic_nodes:
                            if real_ic.name == ic.name and real_ic.highway.code == ic.highway.code:
                                NodeStationMapping.objects.update_or_create(
                                    ic_node=real_ic, station=station,
                                    defaults=dict(
                                        distance_km=round(dist, 2),
                                        drive_minutes=mins,
                                        route_memo='',
                                        is_recommended=ptype in ('mart', 'public'),
                                    )
                                )
                                total_m += 1
                    total_s += 1
                    matched += 1

            except Exception as e:
                continue

        print(f'   IC 반경 매칭: {matched}개\n')
        time.sleep(0.5)

    print('=' * 60)
    if dry_run:
        print('DRY-RUN 완료 — --dry-run 제거 후 재실행하면 저장됩니다.')
    else:
        print(f'충전소 저장: {total_s}개')
        print(f'IC-충전소 매핑: {total_m}개')
        print(f'\n확인: http://localhost:8000/admin/chargeflow/chargingstation/')
        print(f'확인: http://localhost:8000/api/v1/nodes/8/bypass-stations/')
    print('=' * 60)


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--api-key',    required=True)
    parser.add_argument('--zcode',      default=None)
    parser.add_argument('--dry-run',    action='store_true')
    parser.add_argument('--empty-only', action='store_true', help='충전소 없는 IC만 대상')
    args = parser.parse_args()
    collect(args.api_key, args.zcode, args.dry_run, getattr(args, 'empty_only', False))