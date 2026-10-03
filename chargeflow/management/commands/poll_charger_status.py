"""
휴게소 충전기 실시간 상태 폴링 + 혼잡도 계산 + 혼잡 해소 알림
============================================================
실행:
  python manage.py poll_charger_status              # 1회 실행 (Railway 크론 */5 * * * *, 조회 범위 10분)
  python manage.py poll_charger_status --loop        # 상주 워커 (기본 5분 간격)

API 키는 --api-key 또는 환경 변수 PUBLIC_DATA_API_KEY.

동작:
  1) 증분 동기화 — getChargerStatus(period=주기+1분)로 최근 상태를 보고한 전국
     충전기를 받아, 우리가 추적하는 statId(HighwayNodeCharger)만 반영한다.
     주기당 보통 1회(1만 건 이하) 호출.
  2) 기준선 동기화 — 처음 실행했거나, 폴링 공백이 period를 넘었거나, 마지막
     기준선이 BASELINE_MAX_AGE보다 오래되면 getChargerInfo(kindDetail=C001,
     고속도로 휴게소) 1회 + 그 분류에 없는 충전소만 statId로 개별 조회해 전체
     상태를 다시 맞춘다. 하루 1회 수준.
  3) 혼잡도 재계산 → 혼잡(busy/jammed/unavailable)에서 여유/보통으로 바뀐
     휴게소의 알림 구독자에게 토스 메시지를 보낸다.

호출량(5분 간격 기준): 증분 약 300회/일 + 기준선 30회 이내/회.
공공데이터 개발계정 한도(1,000회/일) 안에 들어온다.
"""
import logging
import os
import time
from datetime import timedelta

from django.core.management.base import BaseCommand, CommandError
from django.db import close_old_connections, transaction
from django.utils import timezone

from chargeflow.models import (
    ChargerState, ChargerStatusLog, ChargingStation, CongestionNotifySubscription,
    HighwayNodeCharger, PollerStatus, StationCongestion, UserRoute,
)
from chargeflow.services import ev_api, toss_notify
from chargeflow.services.congestion import record_samples, recompute_all

logger = logging.getLogger(__name__)

BASELINE_MAX_AGE    = timedelta(hours=24)
LOG_RETENTION       = timedelta(hours=2)
SUBSCRIPTION_TTL    = timedelta(hours=6)  # 이동 중 한 번의 충전을 위한 구독이므로 짧게 둔다
VALID_STATS         = {'1', '2', '3', '4', '5', '9'}


def _apply_items(items, tracked, now):
    """API 항목 → ChargerState 반영. 바뀐 충전기 수를 돌려준다."""
    existing = {
        (s.stat_id, s.charger_id): s
        for s in ChargerState.objects.filter(stat_id__in=tracked)
    }
    to_create, logs = [], []
    to_update = {}

    for item in items:
        stat_id = str(item.get('statId') or '').strip()
        if stat_id not in tracked:
            continue
        charger_id = str(item.get('chgerId') or '').strip()
        stat       = str(item.get('stat') or '9').strip()
        if not charger_id:
            continue
        if stat not in VALID_STATS:
            stat = '9'
        updated_at = ev_api.parse_stat_updated(item.get('statUpdDt'))
        # 충전 중일 때만 시작 시각을 둔다 (대기 시간 추정용)
        since      = ev_api.parse_stat_updated(item.get('nowTsdt')) if stat == '3' else None
        zcode      = str(item.get('zcode') or '').strip()[:2]
        chger_type = str(item.get('chgerType') or '').strip()[:2]  # 정보 API에만 있다

        row = existing.get((stat_id, charger_id))
        if row is None:
            row = ChargerState(stat_id=stat_id, charger_id=charger_id, stat=stat,
                               stat_updated_at=updated_at, charging_since=since,
                               chger_type=chger_type, zcode=zcode)
            existing[(stat_id, charger_id)] = row
            to_create.append(row)
            logs.append(ChargerStatusLog(stat_id=stat_id, charger_id=charger_id, stat=stat))
            continue

        # 같은 충전기의 더 오래된 이벤트가 늦게 와도 최신 상태를 덮지 않는다
        if row.stat_updated_at and updated_at and updated_at < row.stat_updated_at:
            continue
        if zcode and not row.zcode:
            row.zcode = zcode
        if chger_type:
            row.chger_type = chger_type
        if row.stat != stat:
            logs.append(ChargerStatusLog(stat_id=stat_id, charger_id=charger_id, stat=stat))
        row.stat            = stat
        row.stat_updated_at = updated_at or row.stat_updated_at
        row.charging_since  = since
        row.synced_at       = now
        if row.pk:
            to_update[row.pk] = row

    with transaction.atomic():
        ChargerState.objects.bulk_create(to_create, ignore_conflicts=True)
        ChargerState.objects.bulk_update(
            list(to_update.values()),
            ['stat', 'stat_updated_at', 'charging_since', 'chger_type', 'zcode', 'synced_at'],
        )
        ChargerStatusLog.objects.bulk_create(logs)
    return len(logs)


def _tracked_ids():
    """(휴게소 충전소 statId, 우회 충전소 statId) — 우회 충전소는 IC 매핑된 곳만"""
    rest = set(HighwayNodeCharger.objects.values_list('stat_id', flat=True))
    bypass = set(
        ChargingStation.objects
        .filter(ic_mappings__isnull=False)
        .exclude(source_api_id__isnull=True).exclude(source_api_id='')
        .values_list('source_api_id', flat=True)
    )
    return rest, bypass - rest


def _sync_baseline(api_key, rest_ids, tracked, now):
    """휴게소 분류로 한 번에 받고, 빠진 휴게소 충전소만 statId로 보충한다.
    우회 충전소(800여 곳)는 개별 조회하면 한도를 넘으므로 증분 피드와
    build_catalog 명령의 일괄 동기화로 채운다."""
    items = list(ev_api.fetch_rest_area_chargers(api_key))
    seen  = {str(i.get('statId') or '').strip() for i in items}
    missing = sorted(rest_ids - seen)
    for stat_id in missing:
        items.extend(ev_api.fetch_station(api_key, stat_id))
    changed = _apply_items(items, tracked, now)
    return changed, len(missing)


def _notify_cleared(transitions, now, stdout):
    cleared_ra_ids = [
        ra_id for ra_id, prev, new in transitions
        if prev in StationCongestion.WAITING_LEVELS and new in ('smooth', 'normal')
    ]
    expired = CongestionNotifySubscription.objects.filter(
        is_active=True, subscribed_at__lt=now - SUBSCRIPTION_TTL,
    ).update(is_active=False)

    sent = 0
    if cleared_ra_ids:
        subs = (CongestionNotifySubscription.objects
                .filter(is_active=True, ra_node_id__in=cleared_ra_ids)
                .select_related('ra_node'))
        for sub in subs:
            if toss_notify.send_congestion_cleared_message(sub.user_key, sub.ra_node):
                sent += 1
            # 발송 가능 여부와 무관하게 1회성 구독은 종료한다
            sub.is_active   = False
            sub.notified_at = now
            sub.save(update_fields=['is_active', 'notified_at'])
    if cleared_ra_ids or expired:
        stdout.write(f'  🔔 혼잡 해소 {len(cleared_ra_ids)}곳 / 알림 {sent}건 / 만료 구독 {expired}건')


FAVORITE_NOTIFY_GAP = timedelta(hours=2)  # 같은 휴게소 즐겨찾기 알림 최소 간격


def _notify_favorites(transitions, now, stdout):
    """즐겨찾기에서 알림을 켠 휴게소가 혼잡해지거나 풀리면 알린다."""
    changed = {}
    for ra_id, prev, new in transitions:
        became_waiting = new in StationCongestion.WAITING_LEVELS and prev not in StationCongestion.WAITING_LEVELS
        cleared        = prev in StationCongestion.WAITING_LEVELS and new in ('smooth', 'normal')
        if (became_waiting or cleared) and prev != 'unknown':
            changed[ra_id] = new
    if not changed:
        return

    routes = (UserRoute.objects
              .filter(ra_node_id__in=changed, is_favorite=True, notify_enabled=True)
              .select_related('ra_node'))
    sent = 0
    for route in routes:
        if route.last_notified_at and now - route.last_notified_at < FAVORITE_NOTIFY_GAP:
            continue
        level = changed[route.ra_node_id]
        label = dict(StationCongestion.LEVEL_CHOICES)[level]
        if toss_notify.send_favorite_status_message(route.user_key, route.ra_node, label):
            sent += 1
        route.last_notified_at = now
        route.save(update_fields=['last_notified_at'])
    if sent:
        stdout.write(f'  ⭐ 즐겨찾기 알림 {sent}건')


def run_cycle(api_key, stdout, force_baseline=False, interval_sec=300, period=None):
    now = timezone.now()
    rest_ids, bypass_ids = _tracked_ids()
    tracked = rest_ids | bypass_ids
    if not rest_ids:
        stdout.write('추적 중인 휴게소 충전소(HighwayNodeCharger)가 없어요. loaddata를 먼저 실행하세요.')
        return

    # 주기보다 1분 넓게 조회해 경계에서 놓치는 변화가 없게 한다 (API 상한 10분)
    period = min(10, max(2, period or interval_sec // 60 + 1))
    status, _ = PollerStatus.objects.get_or_create(key='charger')
    gap = (now - status.last_status_at) if status.last_status_at else None
    need_baseline = (
        force_baseline
        or status.last_baseline_at is None
        or now - status.last_baseline_at > BASELINE_MAX_AGE
        or gap is None
        or gap > timedelta(minutes=period) - timedelta(seconds=30)
    )

    try:
        if need_baseline:
            changed, extra = _sync_baseline(api_key, rest_ids, tracked, now)
            status.last_baseline_at = now
            stdout.write(f'  📥 기준선 동기화: 개별 조회 {extra}곳, 상태 변화 {changed}건')

        changed = _apply_items(ev_api.fetch_status_changes(api_key, period=period), tracked, now)
        status.last_status_at = now
        status.last_error     = ''
    except ev_api.EvApiError as e:
        status.last_error = str(e)[:1000]
        status.save()
        raise CommandError(str(e))
    status.save()

    transitions = recompute_all(now)
    record_samples(now)
    _notify_cleared(transitions, now, stdout)
    _notify_favorites(transitions, now, stdout)

    ChargerStatusLog.objects.filter(checked_at__lt=now - LOG_RETENTION).delete()

    levels = {}
    for level in StationCongestion.objects.values_list('level', flat=True):
        levels[level] = levels.get(level, 0) + 1
    known_rest   = ChargerState.objects.filter(stat_id__in=rest_ids).count()
    known_bypass = ChargerState.objects.filter(stat_id__in=bypass_ids).values('stat_id').distinct().count()
    stdout.write(
        f'✅ {now.astimezone(ev_api.KST):%H:%M} 증분 변화 {changed}건 · 휴게소 충전기 {known_rest}대 · '
        f'우회 충전소 {known_bypass}/{len(bypass_ids)}곳 상태 보유 · 혼잡도 {levels}'
    )


class Command(BaseCommand):
    help = '휴게소 충전기 상태 폴링 → 혼잡도 계산 → 혼잡 해소 알림'

    def add_arguments(self, parser):
        parser.add_argument('--api-key', default=None, help='미지정 시 PUBLIC_DATA_API_KEY')
        parser.add_argument('--loop', action='store_true', help='상주하며 주기 실행')
        parser.add_argument('--interval', type=int, default=300, help='--loop 주기(초), 기본 300')
        parser.add_argument('--baseline', action='store_true', help='기준선 동기화를 강제로 실행')
        parser.add_argument('--period', type=int, default=None,
                            help='증분 조회 범위(분, 2~10). 크론처럼 실행 간격이 들쭉날쭉하면 10을 권장')

    def handle(self, *args, **options):
        api_key = options['api_key'] or os.getenv('PUBLIC_DATA_API_KEY')
        if not api_key:
            raise CommandError('--api-key 또는 PUBLIC_DATA_API_KEY 환경 변수가 필요해요.')

        if not options['loop']:
            # 크론 1회 실행: 실행 간격이 들쭉날쭉해도 공백이 생기지 않게 최대 범위(10분)를 기본으로
            run_cycle(api_key, self.stdout, force_baseline=options['baseline'],
                      interval_sec=options['interval'], period=options['period'] or 10)
            return

        interval = max(60, options['interval'])
        self.stdout.write(f'⚡ 폴링 워커 시작 ({interval}초 간격)')
        force = options['baseline']
        while True:
            started = time.monotonic()
            close_old_connections()
            try:
                run_cycle(api_key, self.stdout, force_baseline=force, interval_sec=interval,
                          period=options['period'])
                force = False
            except Exception as e:  # 한 주기 실패로 워커가 죽지 않게 한다
                logger.exception('폴링 주기 실패')
                self.stderr.write(f'❌ 폴링 실패: {e}')
            time.sleep(max(5, interval - (time.monotonic() - started)))
