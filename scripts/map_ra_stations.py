"""
휴게소(RA) 이름으로 환경부 API statId 자동 매핑
============================================================

사용법:
  python scripts/map_ra_stations.py --api-key 공공데이터키 --dry-run
  python scripts/map_ra_stations.py --api-key REDACTED_PUBLIC_DATA_API_KEY

"""
import os, sys, json, time, math, argparse
import urllib.request, urllib.parse
import django
 
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
os.environ.setdefault('DJANGO_SETTINGS_MODULE', 'config.settings')
django.setup()
 
from chargeflow.models import HighwayNode, HighwayNodeCharger
 
API_URL  = 'https://apis.data.go.kr/B552584/EvCharger/getChargerInfo'
 
# 고속도로 휴게소 충전소가 속한 시도코드 (고속국도 충전소는 kind=A0)
# 이름 매칭 키워드 — 이 단어가 환경부 충전소명에 포함되면 휴게소 소속으로 판단
RA_KEYWORDS = ['휴게소', '고속도로', '고속', 'SA', '나들목']
 
def haversine(lat1, lng1, lat2, lng2):
    R = 6371
    dlat = math.radians(lat2 - lat1)
    dlng = math.radians(lng2 - lng1)
    a = math.sin(dlat/2)**2 + math.cos(math.radians(lat1))*math.cos(math.radians(lat2))*math.sin(dlng/2)**2
    return R * 2 * math.asin(math.sqrt(a))
 
def name_score(ra_name: str, stat_name: str) -> int:
    """
    좌표 기반 매핑 전략:
    반경 내에서 stat_name에 '휴게소'가 포함된 충전소만 매핑.
    환경부는 같은 휴게소도 '서울만남(부산)', '기흥(서울)' 처럼
    방향명을 붙여 저장하므로 핵심어 매칭보다 거리+키워드가 더 정확.
    """
    if '휴게소' in stat_name:
        return 10   # 휴게소 소속 충전소
    return 0        # 일반 상업시설 제외
 
def fetch_nearby(api_key: str, zcode: str) -> list:
    """시도코드별 전체 충전소 조회 (kind 필터 없이 전체)"""
    params = urllib.parse.urlencode({
        'serviceKey': api_key,
        'pageNo':     1,
        'numOfRows':  9999,
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
    except Exception as e:
        print(f'    API 오류: {e}')
        return []
 
def run(api_key: str, dry_run: bool):
    # ── 1. 중복 없는 RA 노드 수집 ──────────────────────────
    ra_nodes = list(
        HighwayNode.objects.filter(node_type='RA', is_active=True)
        .select_related('highway')
        .order_by('highway', 'direction', 'sequence')
    )
    # 이름 기준 중복 제거 (상행/하행 같은 RA → 한 번만)
    seen = {}
    for ra in ra_nodes:
        key = (ra.highway.code, ra.name)
        if key not in seen:
            seen[key] = ra
    unique_ras = list(seen.values())
 
    print(f'\n🔍 매핑 대상 RA: {len(unique_ras)}개  dry-run={dry_run}\n')
 
    # ── 2. 시도별 고속국도 충전소 전체 수집 ─────────────────
    # 고속국도(A0)는 전국이 하나의 데이터셋으로 잡히는 경우가 많아
    # 대표 시도코드 몇 개로 수집 후 전체 목록 구성
    ZCODES = [
        '11',  # 서울
        '26',  # 부산
        '27',  # 대구
        '28',  # 인천
        '29',  # 광주
        '30',  # 대전
        '31',  # 울산
        '36',  # 세종
        '41',  # 경기
        '43',  # 충북
        '44',  # 충남
        '46',  # 전남
        '47',  # 경북
        '48',  # 경남
        '51',  # 강원특별자치도
        '52',  # 전북특별자치도
    ]
 
    all_stations = {}   # statId → item
    for zcode in ZCODES:
        print(f'  [{zcode}] 고속국도 충전소 조회 중...')
        items = fetch_nearby(api_key, zcode)
        for item in items:
            sid = (item.get('statId') or '').strip()
            if sid and sid not in all_stations:
                all_stations[sid] = item
        print(f'       → {len(items)}개 (누계 {len(all_stations)}개)')
        time.sleep(0.3)
 
    print(f'\n총 고속국도 충전소: {len(all_stations)}개\n')
 
    # ── 3. RA별 매핑 ────────────────────────────────────────
    total_mapped = 0
 
    for ra in unique_ras:
        ra_lat = float(ra.latitude)
        ra_lng = float(ra.longitude)
 
        # 500m 이내 + 이름 점수 2 이상인 충전소만 매핑
        candidates = []
        for sid, item in all_stations.items():
            try:
                s_lat = float(item.get('lat') or 0)
                s_lng = float(item.get('lng') or 0)
            except:
                continue
            if not s_lat or not s_lng:
                continue
 
            dist = haversine(ra_lat, ra_lng, s_lat, s_lng)
            if dist > 2.0:   # 2km 초과 제외
                continue
 
            stat_name = (item.get('statNm') or '').strip()
            score = name_score(ra.name, stat_name)
 
            candidates.append({
                'stat_id':   sid,
                'stat_name': stat_name,
                'dist':      dist,
                'score':     score,
            })
 
        # 점수 높은 순 정렬
        candidates.sort(key=lambda x: (-x['score'], x['dist']))
 
        # 점수 0 이하면 제외 (휴게소 무관 충전소)
        matched = [c for c in candidates if c['score'] >= 10]  # 풀네임 포함된 것만
 
        if not matched:
            print(f'  ⚠️  {ra.name:<20} → 매핑 없음')
            continue
 
        print(f'  ✅ {ra.name:<20} → {len(matched)}개 충전소')
        for c in matched[:3]:   # 출력은 최대 3개만
            print(f'       {c["stat_name"][:30]:<30} ({c["dist"]*1000:.0f}m, 점수{c["score"]})')
 
        if not dry_run:
            # statId별 충전기 수 집계
            stat_charger_cnt = {}
            for sid, item in all_stations.items():
                s = (item.get('statId') or '').strip()
                if s:
                    stat_charger_cnt[s] = stat_charger_cnt.get(s, 0) + 1
 
            # 상행/하행 모두 동일한 RA에 매핑
            same_ras = [r for r in ra_nodes if r.name == ra.name and r.highway.code == ra.highway.code]
            for same_ra in same_ras:
                for c in matched:
                    HighwayNodeCharger.objects.update_or_create(
                        ra_node=same_ra,
                        stat_id=c['stat_id'],
                        defaults={
                            'stat_name':   c['stat_name'],
                            'charger_cnt': stat_charger_cnt.get(c['stat_id'], 1),
                        }
                    )
            total_mapped += len(matched)
 
    print(f'\n{"═"*60}')
    if dry_run:
        print('✅ [DRY-RUN] 완료 — DB 저장 없음')
    else:
        print(f'✅ 완료: {total_mapped}개 매핑 저장')
        print(f'   확인: http://localhost:8000/admin/chargeflow/highwaynodecharger/')
    print('═'*60)
 
 
if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--api-key', required=True)
    parser.add_argument('--dry-run', action='store_true')
    args = parser.parse_args()
    run(args.api_key, args.dry_run)