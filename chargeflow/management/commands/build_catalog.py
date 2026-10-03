"""
충전소 카탈로그 구축 (1회성 · 데이터 갱신 시 재실행)
============================================================
실행:
  python manage.py build_catalog                 # 신규 노선 구축 + 전국 충전기 동기화
  python manage.py build_catalog --skip-scan     # 노선만 (충전기 데이터는 캐시 사용)
  python manage.py dumpdata ... > chargeflow_data.json   # 결과를 배포용 fixture로 저장

주의: 노선을 다시 만들면 노드 id가 바뀐다. 운영에 배포한 뒤 다시 만들면 즐겨찾기가
끊기고 fixture에 옛 노드가 남아 중복되므로, 이미 있는 노선은 --rebuild 없이는 건너뛴다.

하는 일:
  1) 신규 노선 — 공공 CSV(전국 IC 좌표, 전국휴게소 표준데이터)로 IC·휴게소 노드를
     만든다. IC 순서는 코드 순서를 2-opt로 다듬어 정하고, 휴게소 방향은 이름 괄호의
     행선지(예: "함양(통영)")를 노선 위에 투영해 판정한다. CSV의 상행/하행 표기는
     노선마다 기준이 달라 쓰지 않는다.
  2) 전국 충전기 정보 — getChargerInfo를 시도별로 내려받아(약 55회 호출) 필요한
     충전기만 추려 캐시한다. 기존 충전소의 커넥터·출력·운영시간을 채우고, 추적
     충전기의 현재 상태(충전 시작 시각 포함)를 미리 채운다.
  3) 신규 노선 연결 — 휴게소 반경 800m 휴게소 충전소를 RA에 매핑하고, IC 반경
     6km 급속 충전소를 우회 후보로 매핑한다. 길찾기 API 없이 직선거리×1.4로 추정한
     값이라 is_estimated=True로 표시한다.
"""
import csv
import json
import math
import os
from collections import defaultdict
from pathlib import Path

from django.conf import settings
from django.core.management.base import BaseCommand, CommandError
from django.db import transaction
from django.utils import timezone

from chargeflow.management.commands.poll_charger_status import _apply_items, _tracked_ids
from chargeflow.models import (
    ChargingStation, Highway, HighwayNode, HighwayNodeCharger, NodeStationMapping,
)
from chargeflow.services import ev_api

DATA_DIR   = Path(settings.BASE_DIR) / 'scripts' / 'data'
IC_CSV     = DATA_DIR / 'ETC_AI_05_02_623950.csv'
RA_CSV     = DATA_DIR / '전국휴게소정보표준데이터.csv'
CACHE_FILE = Path(settings.BASE_DIR) / '.cache' / 'chargers.json'

# 2026년 기준: 광주(29)·전남(46)은 통합 코드 12로 조회된다 (옛 코드는 0건)
ZCODES = ['11', '12', '26', '27', '28', '29', '30', '31', '36', '41', '43', '44', '46', '47', '48', '51', '52']

# 방향 = 기점(start) 쪽이 DOWN, 종점(end) 쪽이 UP — 기존 3개 노선과 같은 규칙
NEW_HIGHWAYS = [
    dict(code='jungbu',       name='중부·통영대전고속도로', ic_routes=['0350'],         ra_routes=['35'],       start='통영', end='하남', order=4),
    dict(code='honam',        name='호남고속도로',          ic_routes=['0250'],         ra_routes=['25'],       start='순천', end='논산', order=5),
    dict(code='namhae',       name='남해고속도로',          ic_routes=['0101', '0102'], ra_routes=['10'],       start='영암', end='부산', order=6),
    dict(code='jungbunaeryuk', name='중부내륙고속도로',     ic_routes=['0450'],         ra_routes=['45'],       start='창원', end='양평', order=7),
    dict(code='jungang',      name='중앙고속도로',          ic_routes=['0550'],         ra_routes=['55'],       start='부산', end='춘천', order=8),
    dict(code='seoulyangyang', name='서울양양고속도로',     ic_routes=['0600'],         ra_routes=['60'],       start='서울', end='양양', order=9),
    dict(code='gwangjudaegu', name='광주대구고속도로',      ic_routes=['0122'],         ra_routes=['12'],       start='광주', end='대구', order=10,
         ra_names=['광주대구선']),  # 노선번호 12를 무안광주선과 같이 쓴다
    dict(code='pyeongtaekjecheon', name='평택제천고속도로', ic_routes=['0400'],         ra_routes=['40'],       start='평택', end='제천', order=11),
    dict(code='suncheonwanju', name='순천완주고속도로',     ic_routes=['0270'],         ra_routes=['27'],       start='순천', end='완주', order=12),
]
EXISTING_LABELS = {
    'gyeongbu':  dict(start='부산', end='서울', order=1, km=416),
    'seohaeAN':  dict(start='목포', end='서울', order=2, km=340),
    'yeongdong': dict(start='강릉', end='인천', order=3, km=234),
}

# 휴게소 이름 괄호 속 행선지 → 좌표 (방향 판정용)
CITY = {
    '서울': (37.57, 126.98), '하남': (37.54, 127.21), '남이': (36.55, 127.45), '대전': (36.35, 127.38),
    '통영': (34.85, 128.43), '천안': (36.81, 127.15), '순천': (34.95, 127.49), '영암': (34.80, 126.70),
    '부산': (35.18, 129.07), '서부산': (35.15, 128.98), '창원': (35.23, 128.68), '양평': (37.49, 127.49),
    '춘천': (37.88, 127.73), '양양': (38.08, 128.62), '광주': (35.16, 126.85), '대구': (35.87, 128.60),
    '평택': (36.99, 127.09), '제천': (37.13, 128.19), '완주': (35.90, 127.16), '함양': (35.52, 127.73),
    '울산': (35.54, 129.31), '무안': (34.99, 126.48), '진주': (35.18, 128.11), '마산': (35.21, 128.57),
    '논산': (36.20, 127.09),
}

ORIGINAL_MAX_STATION_ID = 4471  # 기존 fixture의 마지막 충전소 id

PLACE_BY_KIND = {'A0': 'public', 'B0': 'public', 'J0': 'public', 'E0': 'mart', 'F0': 'gas_station'}

OUTLIER_KM       = 35    # 가장 가까운 이웃 IC와 이보다 멀면 좌표 오류로 보고 뺀다
DUPLICATE_KM     = 5     # 같은 이름 IC가 이 거리 안에 여러 개면 하나만 쓴다 (방향·램프별 중복 등록)
RA_RADIUS_KM     = 0.8
IC_RADIUS_KM     = 6.0
ROAD_FACTOR      = 1.4   # IC→충전소 직선거리 → 시내 도로거리 보정
HIGHWAY_CURVE    = 1.1   # 노드 사이 직선거리 → 고속도로 실제 거리 보정
CITY_SPEED_KMH   = 35
MAX_DRIVE_MIN    = 15
STATIONS_PER_IC  = 10
FAST_KW          = 50


def haversine(a, b):
    lat1, lng1 = a
    lat2, lng2 = b
    r = math.pi / 180
    h = (math.sin((lat2 - lat1) * r / 2) ** 2
         + math.cos(lat1 * r) * math.cos(lat2 * r) * math.sin((lng2 - lng1) * r / 2) ** 2)
    return 6371 * 2 * math.asin(math.sqrt(h))


def path_length(pts):
    return sum(haversine(pts[i], pts[i + 1]) for i in range(len(pts) - 1))


def two_opt(items, key=lambda x: x['pos']):
    """열린 경로 2-opt — 코드 순서가 틀어진(나중에 추가된) IC를 제자리로 옮긴다."""
    best = list(items)
    improved = True
    while improved:
        improved = False
        for i in range(len(best) - 1):
            for j in range(i + 1, len(best)):
                cand = best[:i] + best[i:j + 1][::-1] + best[j + 1:]
                if path_length([key(x) for x in cand]) + 1e-6 < path_length([key(x) for x in best]):
                    best, improved = cand, True
    return best


class Chain:
    """노선 중심선(IC·JC를 이은 꺾은선) 위의 거리 계산"""

    def __init__(self, pts):
        self.pts = pts
        self.cum = [0.0]
        for i in range(len(pts) - 1):
            self.cum.append(self.cum[-1] + haversine(pts[i], pts[i + 1]) * HIGHWAY_CURVE)
        self.total = self.cum[-1]

    def project(self, p):
        """(노선 시작점부터 km, 노선까지 거리 km)"""
        best = (float('inf'), 0.0)
        lat0 = math.radians(p[0])
        for i in range(len(self.pts) - 1):
            a, b = self.pts[i], self.pts[i + 1]
            ax, ay = a[1] * math.cos(lat0), a[0]
            bx, by = b[1] * math.cos(lat0), b[0]
            px, py = p[1] * math.cos(lat0), p[0]
            dx, dy = bx - ax, by - ay
            seg = dx * dx + dy * dy
            t = 0.0 if seg == 0 else max(0.0, min(1.0, ((px - ax) * dx + (py - ay) * dy) / seg))
            q = (a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t)
            d = haversine(p, q)
            if d < best[0]:
                best = (d, self.cum[i] + (self.cum[i + 1] - self.cum[i]) * t)
        return best[1], best[0]


def read_csv(path):
    with open(path, encoding='cp949') as f:
        return list(csv.reader(f))[1:]


def ra_display_name(raw):
    base = raw.split('(')[0].strip()
    return base if base.endswith('휴게소') else f'{base}휴게소'


def ra_destination(raw):
    if '(' in raw and ')' in raw:
        return raw[raw.index('(') + 1:raw.index(')')].strip()
    return None


class Command(BaseCommand):
    help = '신규 노선 구축 + 전국 충전기 정보로 충전소 카탈로그 보강'

    def add_arguments(self, parser):
        parser.add_argument('--api-key', default=None)
        parser.add_argument('--skip-scan', action='store_true', help='충전기 데이터는 캐시만 사용')
        parser.add_argument('--only', nargs='*', help='구축할 신규 노선 code 목록')
        parser.add_argument('--zcodes', nargs='*', help='이 지역만 내려받아 기존 캐시에 합친다')
        parser.add_argument('--labels-only', action='store_true', help='기존 노선 표기·거리만 갱신')
        parser.add_argument('--rebuild', action='store_true', help='이미 있는 신규 노선도 다시 만든다(배포 전에만)')

    def handle(self, *args, **opts):
        api_key = opts['api_key'] or os.getenv('PUBLIC_DATA_API_KEY')
        targets = [h for h in NEW_HIGHWAYS if not opts['only'] or h['code'] in opts['only']]

        self._label_existing()
        if opts['labels_only']:
            return
        built = []
        for cfg in targets:
            existing = Highway.objects.filter(code=cfg['code']).first()
            if existing and existing.nodes.exists() and not opts['rebuild']:
                self.stdout.write(f"⏭️  {cfg['name']}: 이미 있어 건너뜀 (--rebuild로 다시 만들 수 있어요)")
                built.append(existing)
                continue
            built.append(self._build_highway(cfg))

        chargers = self._load_chargers(api_key, opts['skip_scan'], opts['zcodes'])
        self._enrich_stations(chargers)
        for hw in built:
            self._map_rest_area_chargers(hw, chargers)
            self._map_bypass_stations(hw, chargers)
        self._seed_states(chargers)
        # 다시 만들면서 어느 IC에도 연결되지 않게 된 충전소 정리 (원본 fixture 범위는 건드리지 않는다)
        removed, _ = ChargingStation.objects.filter(id__gt=ORIGINAL_MAX_STATION_ID, ic_mappings__isnull=True).delete()
        if removed:
            self.stdout.write(f'  🧹 연결이 끊긴 충전소 {removed}곳 정리')

    # ── 1) 노선 ───────────────────────────────────────────
    def _label_existing(self):
        """기존 3개 노선: 표기 정보를 채우고, 기점부터 거리를 좌표로 다시 계산한다.
        (원본 데이터는 나중에 추가된 IC의 거리가 0으로 들어가 있었다)"""
        for code in EXISTING_LABELS:
            for direction in ('UP', 'DOWN'):
                nodes = list(HighwayNode.objects.filter(highway__code=code, direction=direction).order_by('sequence'))
                km, prev = 0.0, None
                for n in nodes:
                    pos = (float(n.latitude), float(n.longitude))
                    if prev:
                        km += haversine(prev, pos) * HIGHWAY_CURVE
                    n.distance_from_start_km = round(km, 1)
                    prev = pos
                HighwayNode.objects.bulk_update(nodes, ['distance_from_start_km'])
        # 총거리는 공식 연장(경부 416km 등)을 그대로 둔다
        for code, meta in EXISTING_LABELS.items():
            Highway.objects.filter(code=code).update(
                start_name=meta['start'], end_name=meta['end'],
                down_label=f"{meta['start']} 방향", up_label=f"{meta['end']} 방향",
                sort_order=meta['order'], total_distance_km=meta['km'],
            )

    def _build_highway(self, cfg):
        ics = [r for r in read_csv(IC_CSV) if r[2] in cfg['ic_routes']]
        if not ics:
            raise CommandError(f"{cfg['code']}: IC 데이터가 없어요 ({cfg['ic_routes']})")
        pts = [{'code': r[0], 'name': r[1].strip().replace('ICIC', 'IC'), 'pos': (float(r[5]), float(r[4]))}
               for r in ics]
        pts.sort(key=lambda x: (x['code'][:4], x['code'][5:]))
        deduped = []
        for p in pts:
            if not any(q['name'] == p['name'] and haversine(q['pos'], p['pos']) <= DUPLICATE_KM for q in deduped):
                deduped.append(p)
        pts = [p for p in deduped
               if min(haversine(p['pos'], q['pos']) for q in deduped if q is not p) <= OUTLIER_KM]
        pts = two_opt(pts)
        if haversine(pts[0]['pos'], CITY[cfg['start']]) > haversine(pts[-1]['pos'], CITY[cfg['start']]):
            pts.reverse()
        chain = Chain([p['pos'] for p in pts])

        # IC 노드 (JCT·TG는 고속도로를 나갈 수 없어 제외)
        ic_nodes = []
        for p in pts:
            name = p['name']
            if 'JC' in name or not name.endswith('IC'):
                continue
            km, _ = chain.project(p['pos'])
            ic_nodes.append({'name': name, 'pos': p['pos'], 'km': km})

        # 휴게소 노드: 노선에서 2.5km 이내, 행선지로 방향 판정
        ra_nodes = []
        for r in read_csv(RA_CSV):
            if r[2] not in cfg['ra_routes'] or (cfg.get('ra_names') and r[3] not in cfg['ra_names']):
                continue
            pos = (float(r[5]), float(r[6]))
            km, off = chain.project(pos)
            if off > 2.5:
                continue
            dest = ra_destination(r[0])
            if dest and dest in CITY:
                dest_km, _ = chain.project(CITY[dest])
                dirs = ['UP'] if dest_km > km else ['DOWN']
            else:
                dirs = ['UP', 'DOWN']  # 양방향 휴게소
            for d in dirs:
                ra_nodes.append({'name': ra_display_name(r[0]), 'pos': pos, 'km': km, 'dir': d})

        with transaction.atomic():
            hw, _ = Highway.objects.update_or_create(code=cfg['code'], defaults={
                'name': cfg['name'], 'total_distance_km': round(chain.total, 1),
                'start_name': cfg['start'], 'end_name': cfg['end'],
                'down_label': f"{cfg['start']} 방향", 'up_label': f"{cfg['end']} 방향",
                'sort_order': cfg['order'],
            })
            HighwayNode.objects.filter(highway=hw).delete()  # 다시 만들 때 매핑까지 정리된다
            counts = {}
            for direction in ('UP', 'DOWN'):
                nodes = [dict(n, type='IC') for n in ic_nodes]
                nodes += [dict(n, type='RA') for n in ra_nodes if n['dir'] == direction]
                nodes.sort(key=lambda n: n['km'], reverse=(direction == 'DOWN'))
                created = []
                for seq, n in enumerate(nodes, start=1):
                    dist = n['km'] if direction == 'UP' else chain.total - n['km']
                    created.append(HighwayNode.objects.create(
                        highway=hw, node_type=n['type'], direction=direction, sequence=seq,
                        name=n['name'], latitude=round(n['pos'][0], 6), longitude=round(n['pos'][1], 6),
                        distance_from_start_km=round(dist, 1),
                    ))
                # 휴게소마다 직전·직후 IC
                for i, node in enumerate(created):
                    if node.node_type != 'RA':
                        continue
                    node.prev_ic = next((x for x in reversed(created[:i]) if x.node_type == 'IC'), None)
                    node.next_ic = next((x for x in created[i + 1:] if x.node_type == 'IC'), None)
                    node.save(update_fields=['prev_ic', 'next_ic'])
                counts[direction] = sum(1 for x in created if x.node_type == 'RA')

        self.stdout.write(
            f"🛣️  {cfg['name']}: {chain.total:.0f}km · IC {len(ic_nodes)}개 · "
            f"휴게소 {cfg['start']}방향 {counts['DOWN']} / {cfg['end']}방향 {counts['UP']}"
        )
        return hw

    # ── 2) 전국 충전기 ────────────────────────────────────
    def _load_chargers(self, api_key, skip_scan, zcodes=None):
        """필요한 충전기만 추린 목록. 캐시가 있고 --skip-scan이면 캐시를 쓴다.
        zcodes를 주면 그 지역만 새로 받아 캐시의 같은 지역 항목을 바꾼다."""
        if skip_scan:
            if not CACHE_FILE.exists():
                raise CommandError(f'캐시가 없어요: {CACHE_FILE}')
            return json.loads(CACHE_FILE.read_text(encoding='utf-8'))
        if not api_key:
            raise CommandError('--api-key 또는 PUBLIC_DATA_API_KEY가 필요해요.')

        wanted_ids = set(ChargingStation.objects.exclude(source_api_id=None).values_list('source_api_id', flat=True))
        wanted_ids |= set(HighwayNodeCharger.objects.values_list('stat_id', flat=True))
        ic_points = [
            (float(lat), float(lng)) for lat, lng in
            HighwayNode.objects.filter(node_type='IC').values_list('latitude', 'longitude')
        ]
        keep_fields = ('statId', 'chgerId', 'statNm', 'addr', 'lat', 'lng', 'useTime', 'busiNm', 'stat',
                       'statUpdDt', 'nowTsdt', 'output', 'kind', 'kindDetail', 'limitYn', 'delYn',
                       'chgerType', 'zcode')

        def near_ic(item):
            try:
                p = (float(item.get('lat') or 0), float(item.get('lng') or 0))
            except ValueError:
                return False
            # 빠른 사전 필터(위경도 0.07도 ≈ 7km) 후 정확한 거리
            return any(abs(p[0] - q[0]) < 0.07 and abs(p[1] - q[1]) < 0.09 and haversine(p, q) <= IC_RADIUS_KM
                       for q in ic_points)

        kept, calls = [], 0
        if zcodes:
            if CACHE_FILE.exists():
                kept = [c for c in json.loads(CACHE_FILE.read_text(encoding='utf-8'))
                        if c.get('zcode') not in zcodes]
        for zcode in (zcodes or ZCODES):
            n = 0
            for item in ev_api._paginate('getChargerInfo', api_key, {'zcode': zcode}, 40):
                n += 1
                sid = str(item.get('statId') or '')
                if sid in wanted_ids or item.get('kindDetail') == ev_api.KIND_HIGHWAY_REST_AREA or near_ic(item):
                    kept.append({k: item.get(k) for k in keep_fields})
            calls += math.ceil(n / ev_api.PAGE_SIZE) or 1
            self.stdout.write(f'  📥 zcode {zcode}: {n:,}대 확인')
        CACHE_FILE.parent.mkdir(exist_ok=True)
        CACHE_FILE.write_text(json.dumps(kept, ensure_ascii=False), encoding='utf-8')
        self.stdout.write(f'  ✅ 충전기 {len(kept):,}대 보관 (API 호출 약 {calls}회) → {CACHE_FILE}')
        return kept

    def _enrich_stations(self, chargers):
        by_station = defaultdict(list)
        for c in chargers:
            by_station[c['statId']].append(c)
        updated = 0
        for st in ChargingStation.objects.exclude(source_api_id=None):
            rows = by_station.get(st.source_api_id)
            if not rows:
                continue
            fast = [r for r in rows if _kw(r) >= FAST_KW]
            st.connectors    = ev_api.connectors_for(r.get('chgerType') for r in (fast or rows))
            st.charger_count = len(fast) or st.charger_count
            st.power_kw      = max((_kw(r) for r in rows), default=0) or st.power_kw
            st.open_hours    = st.open_hours or (rows[0].get('useTime') or '')[:50]
            st.operator      = st.operator or (rows[0].get('busiNm') or '')[:50]
            st.save(update_fields=['connectors', 'charger_count', 'power_kw', 'open_hours', 'operator'])
            updated += 1
        self.stdout.write(f'  🔌 충전소 {updated}곳 커넥터·출력 보강')

    # ── 3) 신규 노선 연결 ─────────────────────────────────
    def _map_rest_area_chargers(self, hw, chargers):
        ras = list(HighwayNode.objects.filter(highway=hw, node_type='RA'))
        stations = defaultdict(list)
        for c in chargers:
            if c.get('kindDetail') == ev_api.KIND_HIGHWAY_REST_AREA:
                stations[c['statId']].append(c)
        made = 0
        for sid, rows in stations.items():
            pos = (float(rows[0]['lat']), float(rows[0]['lng']))
            dists = [(haversine(pos, (float(r.latitude), float(r.longitude))), r) for r in ras]
            near = [x for x in dists if x[0] <= RA_RADIUS_KM]
            if not near:
                continue
            d0 = min(d for d, _ in near)
            for d, ra in near:
                if d <= d0 + 0.05:  # 같은 좌표(양방향 공용)면 모두 연결
                    HighwayNodeCharger.objects.get_or_create(
                        ra_node=ra, stat_id=sid,
                        defaults={'stat_name': (rows[0].get('statNm') or '')[:100], 'charger_cnt': len(rows)},
                    )
                    made += 1
        mapped = HighwayNode.objects.filter(highway=hw, node_type='RA', chargers__isnull=False).distinct().count()
        self.stdout.write(f'  🅿️  {hw.name}: 휴게소 충전소 매핑 {made}건 (충전소 있는 휴게소 {mapped}/{len(ras)})')

    def _map_bypass_stations(self, hw, chargers):
        by_station = defaultdict(list)
        for c in chargers:
            if c.get('kindDetail') == ev_api.KIND_HIGHWAY_REST_AREA or c.get('kind') == 'H0':
                continue  # 휴게소 자체·공동주택 제외
            if c.get('limitYn') == 'Y' or c.get('delYn') == 'Y' or '휴게소' in (c.get('statNm') or ''):
                continue
            by_station[c['statId']].append(c)
        fast_stations = {sid: rows for sid, rows in by_station.items() if max(_kw(r) for r in rows) >= FAST_KW}

        made = 0
        for ic in HighwayNode.objects.filter(highway=hw, node_type='IC'):
            icp = (float(ic.latitude), float(ic.longitude))
            cands = []
            for sid, rows in fast_stations.items():
                pos = (float(rows[0]['lat']), float(rows[0]['lng']))
                d = haversine(icp, pos)
                if d > IC_RADIUS_KM:
                    continue
                road_km = d * ROAD_FACTOR
                minutes = max(1, round(road_km / CITY_SPEED_KMH * 60))
                if minutes <= MAX_DRIVE_MIN:
                    cands.append((minutes, road_km, sid, rows))
            cands.sort(key=lambda x: (x[0], -max(_kw(r) for r in x[3])))
            for minutes, road_km, sid, rows in cands[:STATIONS_PER_IC]:
                station = _upsert_station(sid, rows)
                power = max(_kw(r) for r in rows)
                NodeStationMapping.objects.update_or_create(
                    ic_node=ic, station=station,
                    defaults={
                        'distance_km': round(road_km, 1), 'drive_minutes': minutes,
                        'is_estimated': True,
                        'is_recommended': power >= 100 and '24' in (rows[0].get('useTime') or ''),
                    },
                )
                made += 1
        self.stdout.write(f'  ⚡ {hw.name}: IC 우회 충전소 매핑 {made}건')

    def _seed_states(self, chargers):
        rest_ids, bypass_ids = _tracked_ids()
        tracked = rest_ids | bypass_ids
        changed = _apply_items([c for c in chargers if c['statId'] in tracked], tracked, timezone.now())
        self.stdout.write(f'  📊 추적 충전기 상태 초기화 {changed}건')


def _kw(row):
    try:
        return int(float(row.get('output') or 0))
    except ValueError:
        return 0


def _upsert_station(sid, rows):
    first = rows[0]
    fast = [r for r in rows if _kw(r) >= FAST_KW]
    station, _ = ChargingStation.objects.update_or_create(source_api_id=sid, defaults={
        'name':          (first.get('statNm') or '')[:100],
        'address':       (first.get('addr') or '')[:200],
        'latitude':      round(float(first['lat']), 6),
        'longitude':     round(float(first['lng']), 6),
        'place_type':    PLACE_BY_KIND.get(first.get('kind') or '', 'etc'),
        'charger_count': len(fast) or len(rows),
        'power_kw':      max(_kw(r) for r in rows),
        'connectors':    ev_api.connectors_for(r.get('chgerType') for r in (fast or rows)),
        'operator':      (first.get('busiNm') or '')[:50],
        'open_hours':    (first.get('useTime') or '')[:50],
    })
    return station
