"""주변 급속충전소 검색: 충전기 상태로 빈 대수를 판정하고 반경을 넓혀가며 찾는다."""
import math
from collections import defaultdict
from datetime import timedelta

from django.utils import timezone

from chargeflow.models import ChargerState, PublicStation

# 마지막 상태 갱신이 이보다 오래된 충전기는 '정보 없음'으로 본다.
# 놀고 있는 충전기는 몇 시간씩 다시 보고하지 않는 경우가 많다. 2026-11-19 전국 실측: 12시간은 급속 충전기의 54%, 24시간은 75%를 남긴다.
PUBLIC_STALE = timedelta(hours=24)
RADII_KM = (5, 10, 20, 30)
MIN_AVAILABLE_STATIONS = 3
MAX_AVAILABLE = 20
MAX_OTHER = 10
KOREA_LAT = (33.0, 38.7)
KOREA_LNG = (124.5, 132.0)
FAST_KW = 50
ID_CHUNK = 500
KM_PER_DEG_LAT = 111.0

_AVAILABLE = {'2'}
_CHARGING = {'3'}
_OFFLINE = {'1', '4', '5'}


def haversine_km(lat1, lng1, lat2, lng2):
    to_r = math.pi / 180
    d_lat = (lat2 - lat1) * to_r
    d_lng = (lng2 - lng1) * to_r
    a = (
        math.sin(d_lat / 2) ** 2
        + math.cos(lat1 * to_r) * math.cos(lat2 * to_r) * math.sin(d_lng / 2) ** 2
    )
    return 6371 * 2 * math.asin(math.sqrt(a))


def in_korea(lat, lng):
    return KOREA_LAT[0] <= lat <= KOREA_LAT[1] and KOREA_LNG[0] <= lng <= KOREA_LNG[1]


def station_status(rows, now):
    """rows: (stat, stat_updated_at) 목록. 판정할 수 없으면 None."""
    rows = list(rows)
    available = charging = offline = 0
    checked = None
    for stat, updated_at in rows:
        if updated_at is None or now - updated_at > PUBLIC_STALE:
            continue
        if stat in _AVAILABLE:
            available += 1
        elif stat in _CHARGING:
            charging += 1
        elif stat in _OFFLINE:
            offline += 1
        else:
            continue
        if checked is None or updated_at > checked:
            checked = updated_at
    if available:
        state = 'available'
    elif charging:
        state = 'full'
    elif offline:
        state = 'unavailable'
    else:
        return None
    return {
        'available': available, 'charging': charging, 'offline': offline,
        'total': len(rows), 'state': state, 'checked_at': checked.isoformat(),
    }


def _fetch_states(stat_ids, cache):
    """아직 가져오지 않은 stat_id의 급속 충전기 상태를 500개씩 끊어 조회해 cache에 채운다."""
    missing = [s for s in stat_ids if s not in cache]
    for i in range(0, len(missing), ID_CHUNK):
        chunk = missing[i:i + ID_CHUNK]
        found = defaultdict(list)
        rows = ChargerState.objects.filter(
            stat_id__in=chunk, output_kw__gte=FAST_KW,
        ).values_list('stat_id', 'stat', 'stat_updated_at')
        for stat_id, stat, updated_at in rows:
            found[stat_id].append((stat, updated_at))
        for stat_id in chunk:
            cache[stat_id] = found.get(stat_id, [])


def _candidates(lat, lng, radius, connector):
    d_lat = radius / KM_PER_DEG_LAT
    d_lng = radius / (KM_PER_DEG_LAT * max(math.cos(math.radians(lat)), 1e-6))
    qs = PublicStation.objects.filter(
        is_active=True,
        latitude__gte=lat - d_lat, latitude__lte=lat + d_lat,
        longitude__gte=lng - d_lng, longitude__lte=lng + d_lng,
    )
    found = []
    for st in qs:
        if connector:
            kinds = [c for c in st.connectors.split(',') if c]
            if kinds and connector not in kinds:
                continue
        dist = haversine_km(lat, lng, float(st.latitude), float(st.longitude))
        if dist <= radius:
            found.append((dist, st))
    return found


def _scan(lat, lng, radius, connector, now, cache):
    cands = _candidates(lat, lng, radius, connector)
    _fetch_states([st.stat_id for _, st in cands], cache)
    result = []
    for dist, st in cands:
        status = station_status(cache[st.stat_id], now)
        if status is not None:
            result.append((dist, st, status))
    return result


def _to_dict(dist, st, status):
    return {
        'id': st.pk,
        'stat_id': st.stat_id,
        'name': st.name,
        'address': st.address,
        'latitude': str(st.latitude),
        'longitude': str(st.longitude),
        'distance_km': round(dist, 1),
        'power_kw': st.power_kw,
        'operator': st.operator,
        'open_hours': st.open_hours,
        'connectors': [c for c in st.connectors.split(',') if c],
        **status,
    }


def search_nearby(lat, lng, connector='', now=None):
    now = now or timezone.now()
    cache = {}
    found = []
    radius = RADII_KM[-1]
    for radius in RADII_KM:
        found = _scan(lat, lng, radius, connector, now, cache)
        if sum(1 for _, _, s in found if s['state'] == 'available') >= MIN_AVAILABLE_STATIONS:
            break
    found.sort(key=lambda t: t[0])
    with_slot = [t for t in found if t[2]['state'] == 'available'][:MAX_AVAILABLE]
    others = [t for t in found if t[2]['state'] != 'available'][:MAX_OTHER]
    chosen = sorted(with_slot + others, key=lambda t: t[0])
    return {
        'radius_km': radius,
        'fetched_at': now.isoformat(),
        'stations': [_to_dict(*t) for t in chosen],
    }
