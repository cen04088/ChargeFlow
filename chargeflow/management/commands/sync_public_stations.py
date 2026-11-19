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

from django.core.management.base import BaseCommand, CommandError
from django.utils import timezone

from chargeflow.management.commands.poll_charger_status import _skip_query_stats
from chargeflow.services import ev_api
from chargeflow.services.public_catalog import deactivate_missing, freshness_report, sync_items


class Command(BaseCommand):
    help = '전국 급속(50kW 이상) 충전소 목록을 공공데이터 API에서 받아 반영'

    def add_arguments(self, parser):
        parser.add_argument('--api-key', default=None, help='미지정 시 PUBLIC_DATA_API_KEY')
        parser.add_argument('--zcodes', nargs='+', default=None, help='일부 시도만 스캔 (비활성화 안 함)')
        parser.add_argument('--report-only', action='store_true', help='API를 부르지 않고 보고만 출력')

    def handle(self, *args, **options):
        _skip_query_stats()
        now = timezone.now()

        if not options['report_only']:
            api_key = options['api_key'] or os.getenv('PUBLIC_DATA_API_KEY')
            if not api_key:
                raise CommandError('--api-key 또는 PUBLIC_DATA_API_KEY 환경 변수가 필요해요.')
            full_scan = not options['zcodes']
            seen = set()
            for zcode in (options['zcodes'] or ev_api.ZCODES):
                try:
                    items = list(ev_api.fetch_region_chargers(api_key, zcode))
                except ev_api.EvApiError as e:
                    raise CommandError(f'zcode {zcode} 조회 실패(이미 반영한 지역은 유지, 비활성화 안 함): {e}')
                region = sync_items(items, now)
                seen |= region
                self.stdout.write(f'  zcode {zcode}: 충전기 {len(items)}건 → 급속 충전소 {len(region)}곳')
            if full_scan:
                self.stdout.write(f'  비활성화: {deactivate_missing(seen)}곳')
            else:
                self.stdout.write('  일부 시도만 스캔해 비활성화는 건너뜀')

        for key, value in freshness_report(timezone.now()).items():
            self.stdout.write(f'{key}: {value}')
