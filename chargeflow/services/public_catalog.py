"""
전국 급속 충전소 목록(PublicStation) 반영
====================================================================
공공데이터 충전기 항목(dict)을 받아 50kW 이상·일반 이용 가능한 충전소와 그 충전기
상태를 upsert하는 순수 서비스. 네트워크 호출은 하지 않는다.
"""
import math
from collections import defaultdict
from itertools import islice

from datetime import timedelta

from django.db import connection, transaction

from chargeflow.models import ChargerState, PublicStation
from chargeflow.services import ev_api

FAST_KW = 50
BATCH_SIZE = 2000
VALID_STATS = {'1', '2', '3', '4', '5', '9'}


def output_kw(item):
    try:
        return int(float(item.get('output') or 0))
    except (TypeError, ValueError, OverflowError):
        return 0


def _coord(value):
    try:
        v = float(value)
    except (TypeError, ValueError):
        return None
    return v if math.isfinite(v) and v != 0 else None


def is_public_fast(item):
    if output_kw(item) < FAST_KW:
        return False
    if item.get('kindDetail') == ev_api.KIND_HIGHWAY_REST_AREA or item.get('kind') == 'H0':
        return False  # 휴게소 자체(기존 추적 대상)·공동주택 제외
    if item.get('limitYn') == 'Y' or item.get('delYn') == 'Y' or '휴게소' in (item.get('statNm') or ''):
        return False
    return _coord(item.get('lat')) is not None and _coord(item.get('lng')) is not None


def _chunks(iterable, size):
    it = iter(iterable)
    while chunk := list(islice(it, size)):
        yield chunk


def sync_items(items, now):
    items = list(items)
    stations = defaultdict(dict)  # statId -> {chgerId: item} (50kW 이상만)
    for it in items:
        if is_public_fast(it):
            stations[it['statId']][it['chgerId']] = it

    # 같은 충전소의 50kW 미만 충전기: 새로 만들지 않고 이미 있는 줄에 출력만 채운다
    slow = {}
    for it in items:
        sid, cid = it.get('statId'), it.get('chgerId')
        if sid in stations and cid not in stations[sid]:
            slow[(sid, cid)] = output_kw(it)

    station_rows, charger_rows = [], []
    for sid, chargers in stations.items():
        rows = list(chargers.values())
        first = rows[0]
        station_rows.append(PublicStation(
            stat_id=sid,
            name=(first.get('statNm') or '')[:100],
            address=(first.get('addr') or '')[:200],
            latitude=round(_coord(first['lat']), 6),
            longitude=round(_coord(first['lng']), 6),
            operator=(first.get('busiNm') or '')[:50],
            open_hours=(first.get('useTime') or '')[:50],
            connectors=ev_api.connectors_for(r.get('chgerType') for r in rows),
            power_kw=max(output_kw(r) for r in rows),
            charger_count=len(rows),
            is_active=True,
            updated_at=now,
        ))
        for cid, r in chargers.items():
            stat = str(r.get('stat') or '').strip()
            if stat not in VALID_STATS:
                stat = '9'
            charger_rows.append(ChargerState(
                stat_id=sid, charger_id=cid, stat=stat,
                stat_updated_at=ev_api.parse_stat_updated(r.get('statUpdDt')),
                charging_since=ev_api.parse_stat_updated(r.get('nowTsdt')) if stat == '3' else None,
                chger_type=(r.get('chgerType') or '')[:2],
                zcode=(r.get('zcode') or '')[:2],
                output_kw=output_kw(r),
                synced_at=now,
            ))

    with transaction.atomic():
        for batch in _chunks(station_rows, BATCH_SIZE):
            PublicStation.objects.bulk_create(
                batch, update_conflicts=True, unique_fields=['stat_id'],
                update_fields=['name', 'address', 'latitude', 'longitude', 'operator', 'open_hours',
                               'connectors', 'power_kw', 'charger_count', 'is_active', 'updated_at'])
        for batch in _chunks(charger_rows, BATCH_SIZE):
            ChargerState.objects.bulk_create(
                batch, update_conflicts=True, unique_fields=['stat_id', 'charger_id'],
                update_fields=['stat', 'stat_updated_at', 'charging_since', 'chger_type',
                               'zcode', 'output_kw', 'synced_at'])
        _fill_slow_outputs(slow)
    return set(stations)


def _fill_slow_outputs(slow):
    if not slow:
        return
    stat_ids = {sid for sid, _ in slow}
    to_update = []
    for sids in _chunks(stat_ids, 500):
        for row in ChargerState.objects.filter(stat_id__in=sids):
            kw = slow.get((row.stat_id, row.charger_id))
            if kw is not None and row.output_kw != kw:
                row.output_kw = kw
                to_update.append(row)
    for batch in _chunks(to_update, BATCH_SIZE):
        ChargerState.objects.bulk_update(batch, ['output_kw'])


def deactivate_missing(seen):
    """seen에 없는 활성 충전소를 비활성화한다. 전국 규모에서 NOT IN 파라미터 한도를
    넘지 않도록 파이썬에서 차집합을 구해 500개씩 갱신한다."""
    missing = set(PublicStation.objects.filter(is_active=True).values_list('stat_id', flat=True)) - set(seen)
    count = 0
    for chunk in _chunks(sorted(missing), 500):
        count += PublicStation.objects.filter(stat_id__in=chunk, is_active=True).update(is_active=False)
    return count


def freshness_report(now):
    """활성 급속 충전소의 상태 신선도 (실측 보고용)."""
    active = PublicStation.objects.filter(is_active=True)
    chargers = ChargerState.objects.filter(
        stat_id__in=active.values('stat_id'), output_kw__gte=FAST_KW)
    total = chargers.count()

    def within(delta):
        if not total:
            return 0.0
        return chargers.filter(stat_updated_at__gte=now - delta).count() / total

    db_mb = None
    if connection.vendor == 'postgresql':
        with connection.cursor() as cur:
            cur.execute('SELECT pg_database_size(current_database())')
            db_mb = round(cur.fetchone()[0] / 1024 / 1024, 1)
    return {
        'stations': active.count(),
        'chargers': total,
        'within_30m': within(timedelta(minutes=30)),
        'within_2h': within(timedelta(hours=2)),
        'within_12h': within(timedelta(hours=12)),
        'db_mb': db_mb,
    }
