"""
환경부 충전기 실시간 상태 폴링 + 혼잡도 계산
============================================================
실행:
  python manage.py poll_charger_status --api-key 발급받은키

스케줄러 (cron 예시 — 3분마다):
  */3 * * * * cd /path/to/chargeflow && venv/bin/python manage.py poll_charger_status --api-key KEY

혼잡 판단 기준:
  - 30분 내 같은 충전기의 상태(stat)가 5회 이상 변동 → 고장 의심 → is_suspicious=True
  - 3분마다 폴링 → 30분 윈도우 내 최대 10회 수집
  - 해당 충전소의 suspicious 충전기 비율:
      0%     → smooth (원활)
      1~30%  → normal (보통)
      31~60% → busy   (혼잡)
      61%+   → jammed (매우 혼잡)
"""
import os, sys, json, time, argparse
import urllib.request, urllib.parse
from datetime import timedelta

from django.core.management.base import BaseCommand
from django.utils import timezone
from django.db import transaction

# 모델 임포트 (models.py에 두 클래스를 추가한 뒤 실행하세요)
from chargeflow.models import ChargingStation, ChargerStatusLog, StationCongestion

API_URL = 'https://apis.data.go.kr/B552584/EvCharger/getChargerStatus'

# 상태 변동으로 인정하는 조합
# (1=통신이상, 2=충전가능, 3=충전중, 4=운영중지, 5=점검중, 9=상태미확인)
CHANGE_THRESHOLD = 5    # 30분 내 변동 횟수 기준 (3분 폴링 기준 약 10회 수집 중 5회)
WINDOW_MINUTES   = 30   # 집계 윈도우 (분)

LEVEL_MAP = [
    (0.00, 'smooth'),   # 의심 충전기 0%
    (0.30, 'normal'),   # ~30%
    (0.60, 'busy'),     # ~60%
    (1.01, 'jammed'),   # 60%+
]


def fetch_status(api_key: str, stat_id: str) -> list:
    """단일 충전소의 모든 충전기 상태 조회"""
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

    except Exception as e:
        return []


def calc_change_count(station, charger_id: str, window_start) -> int:
    """
    window_start 이후 해당 충전기의 상태 변동 횟수 계산
    연속된 같은 상태는 1번으로 카운트
    """
    logs = list(
        ChargerStatusLog.objects.filter(
            station=station,
            charger_id=charger_id,
            checked_at__gte=window_start,
        ).order_by('checked_at').values_list('stat', flat=True)
    )

    if len(logs) < 2:
        return 0

    changes = 0
    prev = logs[0]
    for curr in logs[1:]:
        if curr != prev:
            changes += 1
        prev = curr
    return changes


class Command(BaseCommand):
    help = '환경부 API로 충전소 상태를 폴링하고 혼잡도를 계산합니다.'

    def add_arguments(self, parser):
        parser.add_argument('--api-key', required=True, help='공공데이터포털 인증키')
        parser.add_argument('--limit',   type=int, default=None,
                            help='테스트용: 처음 N개 충전소만 처리')
        parser.add_argument('--verbose', action='store_true',
                            help='충전기별 상세 출력')

    def handle(self, *args, **options):
        api_key = options['api_key']
        limit   = options['limit']
        verbose = options['verbose']
        now     = timezone.now()
        window  = now - timedelta(minutes=WINDOW_MINUTES)

        # source_api_id가 있는 충전소만 대상
        stations = ChargingStation.objects.exclude(source_api_id=None).exclude(source_api_id='')
        if limit:
            stations = stations[:limit]

        total     = stations.count()
        processed = 0
        suspicious_count = 0

        self.stdout.write(f'\n⚡ 충전소 상태 폴링 시작 ({total}개)\n')

        for station in stations:
            chargers = fetch_status(api_key, station.source_api_id)
            if not chargers:
                time.sleep(0.1)
                continue

            # ── 1. 상태 이력 저장 ──────────────────────────
            new_logs = []
            for ch in chargers:
                charger_id = str(ch.get('chgerId') or '').strip()
                stat       = str(ch.get('stat') or '9').strip()
                if not charger_id:
                    continue

                # 직전 로그와 상태가 다를 때만 저장 (중복 방지)
                last = ChargerStatusLog.objects.filter(
                    station=station, charger_id=charger_id
                ).order_by('-checked_at').first()

                if last is None or last.stat != stat:
                    new_logs.append(ChargerStatusLog(
                        station=station,
                        charger_id=charger_id,
                        stat=stat,
                    ))

            if new_logs:
                ChargerStatusLog.objects.bulk_create(new_logs)

            # ── 2. 30분 윈도우 내 변동 집계 ────────────────
            charger_ids = list({ch.get('chgerId') for ch in chargers if ch.get('chgerId')})
            total_chargers = len(charger_ids)

            if total_chargers == 0:
                continue

            suspicious_chargers = 0
            for cid in charger_ids:
                cnt = calc_change_count(station, str(cid), window)
                if cnt >= CHANGE_THRESHOLD:
                    suspicious_chargers += 1
                    if verbose:
                        self.stdout.write(
                            f'  ⚠️  {station.name} 충전기{cid}: {cnt}회 변동 (의심)'
                        )

            # ── 3. 혼잡도 레벨 결정 ────────────────────────
            ratio = suspicious_chargers / total_chargers
            level = 'smooth'
            for threshold, lv in LEVEL_MAP:
                if ratio <= threshold:
                    level = lv
                    break

            is_suspicious = suspicious_chargers > 0

            # ── 4. StationCongestion 갱신 ──────────────────
            StationCongestion.objects.update_or_create(
                station=station,
                defaults={
                    'change_count_30m': suspicious_chargers,
                    'level':            level,
                    'is_suspicious':    is_suspicious,
                }
            )

            processed += 1
            if is_suspicious:
                suspicious_count += 1

            time.sleep(0.05)   # API 호출 간격

        # ── 오래된 로그 정리 (2시간 이상) ─────────────────
        cutoff = now - timedelta(hours=2)
        deleted, _ = ChargerStatusLog.objects.filter(checked_at__lt=cutoff).delete()

        self.stdout.write(self.style.SUCCESS(
            f'\n✅ 완료: {processed}개 처리 / 의심 충전소: {suspicious_count}개 / 오래된 로그 {deleted}개 삭제'
        ))
