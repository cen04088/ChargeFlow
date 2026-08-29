"""
실제 환경부 API 데이터 샘플 확인
사용법: python scripts/debug_ra_mapping.py --api-key YOUR_PUBLIC_DATA_API_KEY
"""
import os, sys, json, math, argparse
import urllib.request, urllib.parse
import django

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
os.environ.setdefault('DJANGO_SETTINGS_MODULE', 'config.settings')
django.setup()

from chargeflow.models import HighwayNode

API_URL = 'https://apis.data.go.kr/B552584/EvCharger/getChargerInfo'

def haversine(lat1, lng1, lat2, lng2):
    R = 6371
    dlat = math.radians(lat2 - lat1)
    dlng = math.radians(lng2 - lng1)
    a = math.sin(dlat/2)**2 + math.cos(math.radians(lat1))*math.cos(math.radians(lat2))*math.sin(dlng/2)**2
    return R * 2 * math.asin(math.sqrt(a))

def fetch(api_key, zcode, kind=None):
    p = {'serviceKey': api_key, 'pageNo': 1, 'numOfRows': 9999, 'dataType': 'JSON', 'zcode': zcode}
    if kind:
        p['kind'] = kind
    params = urllib.parse.urlencode(p)
    try:
        req = urllib.request.Request(f'{API_URL}?{params}', headers={'Accept': 'application/json'})
        with urllib.request.urlopen(req, timeout=20) as res:
            data = json.loads(res.read().decode('utf-8'))
        body  = data.get('body') or data
        items = body.get('items') or {}
        if isinstance(items, dict): items = items.get('item') or []
        if isinstance(items, dict): items = [items]
        return items or []
    except Exception as e:
        print(f'오류: {e}')
        return []

def run(api_key):
    # 테스트할 RA 3개
    test_ras = list(
        HighwayNode.objects.filter(
            node_type='RA', is_active=True,
            highway__code='gyeongbu'
        ).order_by('sequence')[:3]
    )

    print('\n=== 테스트 RA 좌표 ===')
    for ra in test_ras:
        print(f'  {ra.name}: lat={ra.latitude}, lng={ra.longitude}')

    # kind 없이 경기도(41) 전체 수집
    print('\n=== kind 없이 경기도(41) 수집 ===')
    items_all = fetch(api_key, '41')
    print(f'전체: {len(items_all)}개')

    print('\n=== kind=A0 경기도(41) 수집 ===')
    items_a0 = fetch(api_key, '41', kind='A0')
    print(f'kind=A0: {len(items_a0)}개')

    # 기흥휴게소 기준으로 반경 1km 내 충전소 탐색
    ra = test_ras[1] if len(test_ras) > 1 else test_ras[0]
    ra_lat = float(ra.latitude)
    ra_lng = float(ra.longitude)

    print(f'\n=== {ra.name} 반경 2km 내 충전소 (kind 없음) ===')
    nearby = []
    for item in items_all:
        try:
            s_lat = float(item.get('lat') or 0)
            s_lng = float(item.get('lng') or 0)
            if not s_lat or not s_lng: continue
            dist = haversine(ra_lat, ra_lng, s_lat, s_lng)
            if dist <= 2.0:
                nearby.append((dist, item))
        except: continue

    nearby.sort(key=lambda x: x[0])
    if nearby:
        print(f'  {len(nearby)}개 발견:')
        for dist, item in nearby[:10]:
            print(f'  {dist*1000:.0f}m | statNm={item.get("statNm")} | statId={item.get("statId")} | kind={item.get("kind")} | addr={item.get("addr","")[:30]}')
    else:
        print('  없음 — 반경을 5km로 확대')
        for item in items_all:
            try:
                s_lat = float(item.get('lat') or 0)
                s_lng = float(item.get('lng') or 0)
                if not s_lat or not s_lng: continue
                dist = haversine(ra_lat, ra_lng, s_lat, s_lng)
                if dist <= 5.0:
                    nearby.append((dist, item))
            except: continue
        nearby.sort(key=lambda x: x[0])
        for dist, item in nearby[:10]:
            print(f'  {dist*1000:.0f}m | statNm={item.get("statNm")} | statId={item.get("statId")} | kind={item.get("kind")} | addr={item.get("addr","")[:30]}')

    # kind 분포 확인
    print('\n=== kind 코드 분포 (경기도 전체) ===')
    kind_dist = {}
    for item in items_all:
        k = item.get('kind', '없음')
        kind_dist[k] = kind_dist.get(k, 0) + 1
    for k, v in sorted(kind_dist.items(), key=lambda x: -x[1])[:10]:
        print(f'  kind={k}: {v}개')

if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--api-key', required=True)
    args = parser.parse_args()
    run(args.api_key)
