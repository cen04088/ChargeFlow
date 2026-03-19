"""
API 응답 구조 디버그 스크립트
실행: python scripts/debug_api.py --api-key REDACTED_PUBLIC_DATA_API_KEY
"""
import json, urllib.request, urllib.parse, argparse

API_URL = 'https://apis.data.go.kr/B552584/EvCharger/getChargerInfo'

def debug(api_key):
    params = urllib.parse.urlencode({
        'serviceKey': api_key,
        'pageNo':     1,
        'numOfRows':  5,      # 3개만 가져와서 구조 확인
        'dataType':   'JSON',
        'zcode':      '41',   # 경기도
    })
    url = f'{API_URL}?{params}'
    print(f'요청 URL: {url[:100]}...\n')

    req = urllib.request.Request(url, headers={'Accept': 'application/json'})
    with urllib.request.urlopen(req, timeout=20) as res:
        raw = res.read().decode('utf-8')

    data = json.loads(raw)

    print('=== 최상위 구조 ===')
    print(json.dumps({k: type(v).__name__ for k, v in data.items()}, ensure_ascii=False, indent=2))
    print()

    # 아이템 추출
    body = data.get('body') or data
    items = body.get('items') or {}
    print(f'=== body.items 타입: {type(items).__name__} ===')

    if isinstance(items, dict):
        item_list = items.get('item') or []
        if isinstance(item_list, dict):
            item_list = [item_list]
    elif isinstance(items, list):
        item_list = items
    else:
        item_list = []

    print(f'총 아이템 수: {len(item_list)}\n')

    if item_list:
        print('=== 첫 번째 충전소 전체 필드 ===')
        for k, v in item_list[0].items():
            print(f'  {k:30s}: {v!r}')

        print('\n=== chgerType 값 분포 (5개 샘플) ===')
        for i, item in enumerate(item_list[:5]):
            ct = item.get('chgerType') or item.get('chgType') or item.get('chargerType') or '없음'
            lat = item.get('lat') or item.get('latitude') or '없음'
            lng = item.get('lng') or item.get('longitude') or '없음'
            print(f'  [{i}] chgerType={ct!r}  lat={lat!r}  lng={lng!r}')
    else:
        print('❌ 아이템이 없습니다. 전체 응답:')
        print(json.dumps(data, ensure_ascii=False, indent=2)[:2000])

if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--api-key', required=True)
    args = parser.parse_args()
    debug(args.api_key)
