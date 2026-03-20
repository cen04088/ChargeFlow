"""
영동고속도로 RA(휴게소) 노드 최신화
============================================================
실행:
  python manage.py update_yeongdong_ra
  python manage.py update_yeongdong_ra --dry-run
"""
from django.core.management.base import BaseCommand
from chargeflow.models import Highway, HighwayNode


# ── 영동 하행 RA (인천 → 강릉 순서) ─────────────────────────
YEONGDONG_DOWN_RA = [
    # (이름, 위도, 경도)
    ('안산휴게소',      37.348000, 126.838160),
    ('용인휴게소',      37.257273, 127.210854),
    ('덕평자연휴게소',  37.381200, 127.351200),
    ('여주휴게소',      37.281200, 127.691200),
    ('문막휴게소',      37.311143, 127.827320),
    ('횡성휴게소',      37.492300, 128.071200),
    ('평창휴게소',      37.590530, 128.413840),
    ('강릉휴게소',      37.730100, 128.853400),
]

# ── 영동 상행 RA (강릉 → 인천 순서) ─────────────────────────
YEONGDONG_UP_RA = [
    ('강릉휴게소',      37.730100, 128.853400),
    ('평창휴게소',      37.590173, 128.414764),
    ('횡성휴게소',      37.464983, 128.135449),
    ('문막휴게소',      37.311143, 127.827320),
    ('여주휴게소',      37.281200, 127.691200),
    ('덕평자연휴게소',  37.381200, 127.351200),
    ('용인휴게소',      37.257273, 127.210854),
    ('안산휴게소',      37.348000, 126.838160),
]


class Command(BaseCommand):
    help = '영동고속도로 RA(휴게소) 노드 이름/좌표 최신화'

    def add_arguments(self, parser):
        parser.add_argument('--dry-run', action='store_true', help='미리보기만')

    def handle(self, *args, **options):
        dry_run = options['dry_run']

        try:
            highway = Highway.objects.get(code='yeongdong')
        except Highway.DoesNotExist:
            self.stdout.write(self.style.ERROR('❌ 영동고속도로 데이터가 없습니다.'))
            return

        self.stdout.write(f'\n⛰️  영동고속도로 RA 최신화  dry-run={dry_run}\n')

        datasets = [
            ('DOWN', '하행', YEONGDONG_DOWN_RA),
            ('UP',   '상행', YEONGDONG_UP_RA),
        ]

        for direction, dir_kor, ra_list in datasets:
            self.stdout.write(f'\n▶ {dir_kor} ({direction}) — {len(ra_list)}개 RA')

            existing_ras = list(
                HighwayNode.objects.filter(
                    highway=highway,
                    direction=direction,
                    node_type='RA',
                ).order_by('sequence')
            )

            self.stdout.write(
                f'  기존 DB: {len(existing_ras)}개 / 새 데이터: {len(ra_list)}개'
            )

            min_len = min(len(existing_ras), len(ra_list))

            for i in range(min_len):
                node = existing_ras[i]
                new_name, new_lat, new_lng = ra_list[i]

                changed = (
                    node.name != new_name or
                    abs(float(node.latitude)  - new_lat) > 0.0001 or
                    abs(float(node.longitude) - new_lng) > 0.0001
                )
                marker = '✏️ ' if changed else '   '

                self.stdout.write(
                    f'  {marker}[{i+1:>2}] {node.name:<22} → {new_name:<22}'
                    f'  ({float(node.latitude):.4f},{float(node.longitude):.4f})'
                    f' → ({new_lat:.4f},{new_lng:.4f})'
                )

                if not dry_run and changed:
                    node.name      = new_name
                    node.latitude  = new_lat
                    node.longitude = new_lng
                    node.save(update_fields=['name', 'latitude', 'longitude'])

            # 새 데이터가 더 많은 경우 경고
            if len(ra_list) > len(existing_ras):
                for i in range(len(existing_ras), len(ra_list)):
                    new_name, new_lat, new_lng = ra_list[i]
                    self.stdout.write(self.style.WARNING(
                        f'  ⚠️  신규 RA [{i+1}] {new_name} — sequence 수동 지정 필요'
                    ))

            # 기존이 더 많은 경우 경고
            if len(existing_ras) > len(ra_list):
                for i in range(len(ra_list), len(existing_ras)):
                    node = existing_ras[i]
                    self.stdout.write(self.style.WARNING(
                        f'  ⚠️  잉여 RA [{i+1}] {node.name} — Admin에서 삭제 필요'
                    ))

        if dry_run:
            self.stdout.write(self.style.SUCCESS('\n✅ [DRY-RUN] 완료 — DB 수정 없음'))
        else:
            self.stdout.write(self.style.SUCCESS(
                '\n✅ 영동고속도로 RA 최신화 완료!'
                '\n   확인: http://localhost:8000/admin/chargeflow/highwaynode/'
                '\n   이후 map_ra_stations.py 재실행 필요'
            ))
