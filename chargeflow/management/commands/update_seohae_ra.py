"""
서해안고속도로 RA(휴게소) 노드 최신화
============================================================
실행:
  python manage.py update_seohae_ra
  python manage.py update_seohae_ra --dry-run
"""
from django.core.management.base import BaseCommand
from chargeflow.models import Highway, HighwayNode


# ── 서해안 하행 RA (서울 → 목포 순서) ───────────────────────
SEOHAE_DOWN_RA = [
    # (이름, 위도, 경도)
    ('매송휴게소',          37.279274, 126.899805),
    ('화성휴게소',          37.124645, 126.883322),
    ('행담도휴게소',        36.853400, 126.802300),
    ('서산휴게소',          36.808180, 126.573123),
    ('홍성휴게소',          36.420100, 126.634100),
    ('대천휴게소',          36.222120, 126.620100),
    ('서천휴게소',          36.001200, 126.720100),
    ('군산휴게소',          35.851200, 126.731200),
    ('부안고려청자휴게소',  35.651200, 126.701200),
    ('고창고인돌휴게소',    35.381200, 126.720100),
    ('함평천지휴게소',      35.010100, 126.530100),
]

# ── 서해안 상행 RA (목포 → 서울 순서) ───────────────────────
SEOHAE_UP_RA = [
    ('함평천지휴게소',      35.010100, 126.530100),
    ('고창고인돌휴게소',    35.381200, 126.720100),
    ('부안고려청자휴게소',  35.651200, 126.701200),
    ('군산휴게소',          35.851200, 126.731200),
    ('서천휴게소',          36.001200, 126.720100),
    ('대천휴게소',          36.221200, 126.620100),
    ('홍성휴게소',          36.534100, 126.581200),
    ('서산휴게소',          36.701200, 126.510200),
    ('행담도휴게소',        36.853400, 126.802300),
    ('화성휴게소',          37.198100, 126.823400),
    ('매송휴게소',          37.320100, 126.881200),
]


class Command(BaseCommand):
    help = '서해안고속도로 RA(휴게소) 노드 이름/좌표 최신화'

    def add_arguments(self, parser):
        parser.add_argument('--dry-run', action='store_true', help='미리보기만')

    def handle(self, *args, **options):
        dry_run = options['dry_run']

        try:
            highway = Highway.objects.get(code='seohaeAN')
        except Highway.DoesNotExist:
            self.stdout.write(self.style.ERROR('❌ 서해안고속도로 데이터가 없습니다.'))
            return

        self.stdout.write(f'\n🌊 서해안고속도로 RA 최신화  dry-run={dry_run}\n')

        datasets = [
            ('DOWN', '하행', SEOHAE_DOWN_RA),
            ('UP',   '상행', SEOHAE_UP_RA),
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
                    f'  {marker}[{i+1:>2}] {node.name:<24} → {new_name:<24}'
                    f'  ({float(node.latitude):.4f},{float(node.longitude):.4f})'
                    f' → ({new_lat:.4f},{new_lng:.4f})'
                )

                if not dry_run and changed:
                    node.name      = new_name
                    node.latitude  = new_lat
                    node.longitude = new_lng
                    node.save(update_fields=['name', 'latitude', 'longitude'])

            if len(ra_list) > len(existing_ras):
                for i in range(len(existing_ras), len(ra_list)):
                    new_name, new_lat, new_lng = ra_list[i]
                    self.stdout.write(self.style.WARNING(
                        f'  ⚠️  신규 RA [{i+1}] {new_name} — sequence 수동 지정 필요'
                    ))

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
                '\n✅ 서해안고속도로 RA 최신화 완료!'
                '\n   확인: http://localhost:8000/admin/chargeflow/highwaynode/'
                '\n   이후 map_ra_stations.py 재실행 필요'
            ))
