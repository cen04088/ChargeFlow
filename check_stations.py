import requests

API_KEY = 'REDACTED_PUBLIC_DATA_API_KEY'
targets = [
    ('망향휴게소', 36.855650, 127.180929),
    ('덕평자연휴게소', 37.241456, 127.390189),
]

url = 'http://apis.data.go.kr/B552584/EvCharger/getChargerInfo'

for name, lat, lng in targets:
    print(f'=== {name} ===')
    params = {
        'serviceKey': API_KEY,
        'pageNo': 1,
        'numOfRows': 9999,
        'dataType': 'JSON',
    }
    res = requests.get(url, params=params)
    items = res.json().get('items', {}).get('item', [])
    print(f'전체 충전소 수: {len(items)}')
    
    found = []
    for item in items:
        s_lat = float(item.get('lat', 0))
        s_lng = float(item.get('lng', 0))
        dist = ((s_lat - lat)**2 + (s_lng - lng)**2) ** 0.5 * 111
        if dist < 10:
            found.append((dist, item.get('statNm'), item.get('addr')))
    
    found.sort()
    if found:
        for dist, statNm, addr in found:
            print(f'  {statNm} | {addr} | dist:{dist:.2f}km')
    else:
        print('  10km 내 충전소 없음')
    print()