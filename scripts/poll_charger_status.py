"""
고속도로 휴게소(RA) 충전기 상태 폴링 + 혼잡도 계산
============================================================
대상: HighwayNodeCharger (휴게소 ↔ statId 매핑 테이블)

혼잡 판단:
  - 30분 내 같은 충전기 상태 변동 5회 이상 → 고장 의심
  - 휴게소 전체 충전기 중 의심 비율로 혼잡도 결정

실행:
  python manage.py poll_charger_status --api-key 발급받은키
  python manage.py poll_charger_status --api-key 발급받은키 --limit 5 --verbose
"""
import json, time
import urllib.request, urllib.parse
from datetime import timedelta

from django.core.management.base import BaseCommand
from django.utils import timezone

from chargeflow.models import (
    HighwayNode, HighwayNodeCharger, ChargerStatusLog, StationCongestion,
    CongestionNotifySubscription,
)
from chargeflow.services.toss_notify import send_congestion_cleared_message

CLEARED_LEVELS = {'smooth', 'normal'}
CONGESTED_LEVELS = {'busy', 'jammed'}

API_URL          = 'https://apis.data.go.kr/B552584/EvCharger/getChargerStatus'
CHANGE_THRESHOLD = 5
WINDOW_MINUTES   = 30

LEVEL_MAP = [
    (0.00, 'smooth'),
    (0.30, 'normal'),
    (0.60, 'busy'),
    (1.01, 'jammed'),
]


def fetch_status(api_key, stat_id):
    params = urllib.parse.urlencode({
        'serviceKey': api_key,
        'pageNo':     1,
        'numOfRows':  50,
        'dataType':   'JSON',
        'statId':     stat_id,
    })
    try:
        req = urllib.request.Request(
            f'{API_URL}?{params}',
            headers={'Accept': 'application/json'}
        )
        with urllib.request.urlopen(req, timeout=10) as res:
            data = json.loads(res.read().decode('utf-8'))
        body  = data.get('body') or data
        items = body.get('items') or {}
        if isinstance(items, dict):
            items = items.get('item') or []
        if isinstance(items, dict):
            items = [items]
        return items or []
    except Exception:
        return []


def calc_change_count(ra_node, charger_id, window_start):
    logs = list(
        ChargerStatusLog.objects.filter(
            ra_node=ra_node,
            charger_id=charger_id,
            checked_at__gte=window_start,
        ).order_by('checked_at').values_list('stat', flat=True)
    )
    if len(logs) < 2:
        return 0
    changes, prev = 0, logs[0]
    for curr in logs[1:]:
        if curr != prev:
            changes += 1
        prev = curr
    return changes


class Command(BaseCommand):
    help = '고속도로 휴게소 충전기 상태를 폴링하고 혼잡도를 계산합니다.'

    def add_arguments(self, parser):
        parser.add_argument('--api-key', required=True)
        parser.add_argument('--limit',   type=int, default=None)
        parser.add_argument('--verbose', action='store_true')

    def _notify_cleared_subscribers(self, ra_node, verbose):
        subs = CongestionNotifySubscription.objects.filter(ra_node=ra_node, is_active=True)
        for sub in subs:
            sent = send_congestion_cleared_message(sub.user_key, ra_node)
            if sent:
                sub.is_active   = False
                sub.notified_at = timezone.now()
                sub.save(update_fields=['is_active', 'notified_at'])
                if verbose:
                    self.stdout.write(f'  🔔 알림 발송: {ra_node.name} → {sub.user_key}')

    def handle(self, *args, **options):
        api_key = options['api_key']
        limit   = options['limit']
        verbose = options['verbose']
        now     = timezone.now()
        window  = now - timedelta(minutes=WINDOW_MINUTES)

        charger_qs = HighwayNodeCharger.objects.select_related(
            'ra_node__highway'
        ).order_by('ra_node__highway', 'ra_node__name')

        if limit:
            charger_qs = charger_qs[:limit]

        # 이름별로 묶기 (상행/하행 중복 제거)
        ra_groups = {}
        for ch in charger_qs:
            key = (ch.ra_node.highway.code, ch.ra_node.name)
            if key not in ra_groups:
                ra_groups[key] = {'ra': ch.ra_node, 'chargers': []}
            ra_groups[key]['chargers'].append(ch)

        total = len(ra_groups)
        suspicious_total = 0

        self.stdout.write(f'\n⚡ 휴게소 충전기 폴링 시작 ({total}개 휴게소)\n')

        for (hw_code, ra_name), group in ra_groups.items():
            ra_node  = group['ra']
            chargers = group['chargers']
            all_charger_ids  = []
            suspicious_count = 0

            for ch in chargers:
                items = fetch_status(api_key, ch.stat_id)
                if not items:
                    time.sleep(0.1)
                    continue

                for item in items:
                    charger_id = str(item.get('chgerId') or '').strip()
                    stat       = str(item.get('stat') or '9').strip()
                    if not charger_id:
                        continue

                    all_charger_ids.append(charger_id)

                    last = ChargerStatusLog.objects.filter(
                        ra_node=ra_node,
                        charger_id=charger_id,
                    ).order_by('-checked_at').first()

                    if last is None or last.stat != stat:
                        ChargerStatusLog.objects.create(
                            ra_node=ra_node,
                            charger_id=charger_id,
                            stat=stat,
                        )

                time.sleep(0.05)

            for cid in set(all_charger_ids):
                cnt = calc_change_count(ra_node, cid, window)
                if cnt >= CHANGE_THRESHOLD:
                    suspicious_count += 1
                    if verbose:
                        self.stdout.write(f'  ⚠️  {ra_name} [{cid}] {cnt}회 변동')

            total_chargers = len(set(all_charger_ids))
            if total_chargers == 0:
                continue

            ratio = suspicious_count / total_chargers
            level = next(lv for threshold, lv in LEVEL_MAP if ratio <= threshold)

            # 상행+하행 모두 업데이트
            same_ras = HighwayNode.objects.filter(
                highway=ra_node.highway,
                name=ra_node.name,
                node_type='RA',
            )
            for same_ra in same_ras:
                previous = StationCongestion.objects.filter(ra_node=same_ra).first()
                previous_level = previous.level if previous else None

                StationCongestion.objects.update_or_create(
                    ra_node=same_ra,
                    defaults={
                        'change_count_30m': suspicious_count,
                        'level':            level,
                        'is_suspicious':    suspicious_count > 0,
                    }
                )

                if previous_level in CONGESTED_LEVELS and level in CLEARED_LEVELS:
                    self._notify_cleared_subscribers(same_ra, verbose)

            if suspicious_count > 0:
                suspicious_total += 1
                self.stdout.write(
                    f'  🟠 {ra_name:<20} 의심 {suspicious_count}/{total_chargers}기 → {level}'
                )
            elif verbose:
                self.stdout.write(f'  🟢 {ra_name:<20} 정상 ({total_chargers}기)')

        # 2시간 이상 오래된 로그 정리
        cutoff = now - timedelta(hours=2)
        deleted, _ = ChargerStatusLog.objects.filter(checked_at__lt=cutoff).delete()

        self.stdout.write(self.style.SUCCESS(
            f'\n✅ 완료: {total}개 휴게소 / 의심: {suspicious_total}개 / 오래된 로그 {deleted}개 삭제'
        ))
