"""
전국 급속 충전소 목록(PublicStation) 스캔
============================================================
실행:
  python manage.py sync_public_stations                      # 전국 스캔 (시도별 getChargerInfo, 약 60회 호출)
  python manage.py sync_public_stations --zcodes 41 11       # 일부 시도만 (비활성화 안 함)
  python manage.py sync_public_stations --report-only        # API 호출 없이 신선도 보고만

API 키는 --api-key 또는 환경 변수 PUBLIC_DATA_API_KEY.
모든 시도를 오류 없이 받았고 --zcodes를 주지 않았을 때만 사라진 충전소를 비활성화한다.
이번 스캔이 전체 또는 어느 한 지역에서 기존 활성 수의 절반 미만이면 비활성화하지 않고 오류로 끝낸다.
"""
import os
import time
from collections import defaultdict

from django.core.management.base import BaseCommand, CommandError
from django.utils import timezone

from chargeflow.management.commands.poll_charger_status import _skip_query_stats
from chargeflow.models import ChargerState, PublicStation
from chargeflow.services import ev_api
from chargeflow.services.public_catalog import FAST_KW, deactivate_missing, freshness_report, sync_items

REGION_ATTEMPTS = 3
REGION_RETRY_WAIT_SEC = 20
MIN_ACTIVE_FOR_GUARD = 100  # 활성 충전소가 이 이상일 때만 안전장치 적용
SEEN_RATIO_GUARD = 0.5      # 이번 스캔이 기존 활성 수의 이 비율 미만이면 비활성화 중단
MIN_REGION_FOR_GUARD = 50   # 지역별 안전장치: 기존 활성 충전소가 이 이상인 지역만 확인


def _active_by_region(active_ids):
    """{zcode: 활성 충전소 stat_id 집합}. 충전소에는 지역 칸이 없어 급속 충전기의 zcode로 정한다."""
    by_region = defaultdict(set)
    rows = ChargerState.objects.filter(output_kw__gte=FAST_KW).values_list('stat_id', 'zcode')
    for sid, zcode in rows.iterator(chunk_size=5000):
        if sid in active_ids and zcode:
            by_region[zcode].add(sid)
    return by_region


class Command(BaseCommand):
    help = '전국 급속(50kW 이상) 충전소 목록을 공공데이터 API에서 받아 반영'

    def add_arguments(self, parser):
        parser.add_argument('--api-key', default=None, help='미지정 시 PUBLIC_DATA_API_KEY')
        parser.add_argument('--zcodes', nargs='+', default=None, help='일부 시도만 스캔 (비활성화 안 함)')
        parser.add_argument('--report-only', action='store_true', help='API를 부르지 않고 보고만 출력')

    def handle(self, *args, **options):
        _skip_query_stats()
        now = timezone.now()
        error = None

        if not options['report_only']:
            api_key = options['api_key'] or os.getenv('PUBLIC_DATA_API_KEY')
            if not api_key:
                raise CommandError('--api-key 또는 PUBLIC_DATA_API_KEY 환경 변수가 필요해요.')
            full_scan = not options['zcodes']
            active_ids = set(PublicStation.objects.filter(is_active=True).values_list('stat_id', flat=True))
            active_before = len(active_ids)
            region_before = _active_by_region(active_ids)
            seen, failed = set(), []
            for zcode in (options['zcodes'] or ev_api.PUBLIC_ZCODES):
                items = self._fetch_region(api_key, zcode)
                if items is None:
                    failed.append(zcode)
                    continue
                region = sync_items(items, now)
                seen |= region
                self.stdout.write(f'  zcode {zcode}: 충전기 {len(items)}건 → 급속 충전소 {len(region)}곳')

            shrunk = sorted(
                z for z, ids in region_before.items()
                if len(ids) >= MIN_REGION_FOR_GUARD and len(ids & seen) < len(ids) * SEEN_RATIO_GUARD)
            if failed:
                error = f'조회 실패 zcode: {", ".join(failed)} (성공한 지역은 반영, 비활성화 안 함)'
            elif not full_scan:
                self.stdout.write('  일부 시도만 스캔해 비활성화는 건너뜀')
            elif active_before >= MIN_ACTIVE_FOR_GUARD and len(seen) < active_before * SEEN_RATIO_GUARD:
                error = (f'안전장치: 이번 스캔 {len(seen)}곳이 기존 활성 {active_before}곳의 '
                         f'{SEEN_RATIO_GUARD:.0%} 미만이라 비활성화 안 함')
                self.stdout.write(f'  ⚠️ {error}')
            elif shrunk:
                error = (f'안전장치: 지역 zcode {", ".join(shrunk)}에서 기존 활성 충전소의 '
                         f'{SEEN_RATIO_GUARD:.0%} 미만만 확인돼 비활성화 안 함')
                self.stdout.write(f'  ⚠️ {error}')
            else:
                self.stdout.write(f'  비활성화: {deactivate_missing(seen)}곳')

        for key, value in freshness_report(timezone.now()).items():
            self.stdout.write(f'{key}: {value}')
        if error:
            raise CommandError(error)

    def _fetch_region(self, api_key, zcode):
        """지역 하나를 최대 REGION_ATTEMPTS번 시도. 끝내 실패하면 None."""
        for attempt in range(1, REGION_ATTEMPTS + 1):
            try:
                return list(ev_api.fetch_region_chargers(api_key, zcode))
            except ev_api.EvApiError as e:
                self.stdout.write(f'  zcode {zcode} 실패({attempt}/{REGION_ATTEMPTS}): {e}')
                if attempt < REGION_ATTEMPTS:
                    time.sleep(REGION_RETRY_WAIT_SEC)
        return None
