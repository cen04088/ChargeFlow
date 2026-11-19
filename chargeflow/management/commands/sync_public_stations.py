"""
전국 급속 충전소 목록(PublicStation) 스캔
============================================================
실행:
  python manage.py sync_public_stations                      # 전국 스캔 (시도별 getChargerInfo, 약 60회 호출)
  python manage.py sync_public_stations --zcodes 41 11       # 일부 시도만 (비활성화 안 함)
  python manage.py sync_public_stations --report-only        # API 호출 없이 신선도 보고만

API 키는 --api-key 또는 환경 변수 PUBLIC_DATA_API_KEY.
모든 시도를 오류 없이 받았고 --zcodes를 주지 않았을 때만 사라진 충전소를 비활성화한다.
"""
import os
import time

from django.core.management.base import BaseCommand, CommandError
from django.utils import timezone

from chargeflow.management.commands.poll_charger_status import _skip_query_stats
from chargeflow.models import PublicStation
from chargeflow.services import ev_api
from chargeflow.services.public_catalog import deactivate_missing, freshness_report, sync_items

REGION_ATTEMPTS = 3
REGION_RETRY_WAIT_SEC = 20
MIN_ACTIVE_FOR_GUARD = 100  # 활성 충전소가 이 이상일 때만 안전장치 적용
SEEN_RATIO_GUARD = 0.5      # 이번 스캔이 기존 활성 수의 이 비율 미만이면 비활성화 중단


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
            active_before = PublicStation.objects.filter(is_active=True).count()
            seen, failed = set(), []
            for zcode in (options['zcodes'] or ev_api.PUBLIC_ZCODES):
                items = self._fetch_region(api_key, zcode)
                if items is None:
                    failed.append(zcode)
                    continue
                region = sync_items(items, now)
                seen |= region
                self.stdout.write(f'  zcode {zcode}: 충전기 {len(items)}건 → 급속 충전소 {len(region)}곳')

            if failed:
                error = f'조회 실패 zcode: {", ".join(failed)} (성공한 지역은 반영, 비활성화 안 함)'
            elif not full_scan:
                self.stdout.write('  일부 시도만 스캔해 비활성화는 건너뜀')
            elif active_before >= MIN_ACTIVE_FOR_GUARD and len(seen) < active_before * SEEN_RATIO_GUARD:
                error = (f'안전장치: 이번 스캔 {len(seen)}곳이 기존 활성 {active_before}곳의 '
                         f'{SEEN_RATIO_GUARD:.0%} 미만이라 비활성화 안 함')
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
