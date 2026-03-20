"""
경부고속도로 RA(휴게소) 노드 최신화
============================================================
실행:
  python manage.py update_gyeongbu_ra
  python manage.py update_gyeongbu_ra --dry-run
"""
from django.core.management.base import BaseCommand
from chargeflow.models import Highway, HighwayNode


# ── 경부 하행 RA (서울 → 부산 순서) ─────────────────────────
GYEONGBU_DOWN_RA = [
    # (이름, 위도, 경도)
    ('서울만남의광장휴게소', 37.460166, 127.041908),
    ('기흥휴게소',          37.235125, 127.104595),
    ('안성휴게소',          37.013407, 127.144800),
    ('망향휴게소',          36.855650, 127.180929),
    ('천안호두휴게소',      36.730226, 127.263877),
    ('옥산휴게소',          36.657743, 127.369817),
    ('죽암휴게소',          36.486810, 127.429261),
    ('금강휴게소',          36.279148, 127.672231),
    ('옥천휴게소',          36.296863, 127.595223),
    ('추풍령휴게소',        36.200356, 128.000331),
    ('황간휴게소',          36.249437, 127.854835),
    ('김천휴게소',          36.129252, 128.164782),
    ('칠곡휴게소',          36.019795, 128.428517),
    ('평사휴게소',          35.885522, 128.867541),
    ('경주건천휴게소',      35.830716, 129.109310),
    ('경주휴게소',          35.724761, 129.192950),
    ('통도사휴게소',        35.488841, 129.090775),
]

# ── 경부 상행 RA (부산 → 서울 순서) ─────────────────────────
GYEONGBU_UP_RA = [
    ('양산휴게소',          35.323172, 129.056867),
    ('언양고래휴게소',      35.597942, 129.141801),
    ('경주건천휴게소',      35.831894, 129.109244),
    ('경산휴게소',          35.879323, 128.810331),
    ('칠곡휴게소',          36.012005, 128.430800),
    ('김천휴게소',          36.131107, 128.164009),
    ('추풍령휴게소',        36.199708, 128.003242),
    ('황간휴게소',          36.248899, 127.852670),
    ('옥천휴게소',          36.297616, 127.598777),
    ('금강휴게소',          36.279148, 127.672231),
    ('신탄진휴게소',        36.426834, 127.418438),
    ('죽암휴게소',          36.496775, 127.430650),
    ('청주휴게소',          36.716005, 127.349315),
    ('천안삼거리휴게소',    36.787809, 127.173455),
    ('입장거봉포도휴게소',  36.942997, 127.192467),
    ('안성휴게소',          37.076681, 127.132496),
    ('죽전휴게소',          37.332371, 127.104795),
]


class Command(BaseCommand):
    help = '경부고속도로 RA(휴게소) 노드 이름/좌표 최신화'

    def add_arguments(self, parser):
        parser.add_argument('--dry-run', action='store_true', help='미리보기만')

    def handle(self, *args, **options):
        dry_run = options['dry_run']
        highway = Highway.objects.get(code='gyeongbu')

        self.stdout.write(f'\n🛣️  경부고속도로 RA 최신화  dry-run={dry_run}\n')

        datasets = [
            ('DOWN', '하행', GYEONGBU_DOWN_RA),
            ('UP',   '상행', GYEONGBU_UP_RA),
        ]

        for direction, dir_kor, ra_list in datasets:
            self.stdout.write(f'\n▶ {dir_kor} ({direction}) — {len(ra_list)}개 RA')

            # 기존 RA 노드 조회 (sequence 순)
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

            # ── 이름+좌표 업데이트 ──────────────────────────
            # 순서 기준으로 매핑 (순서가 같다고 가정)
            min_len = min(len(existing_ras), len(ra_list))

            for i in range(min_len):
                node = existing_ras[i]
                new_name, new_lat, new_lng = ra_list[i]

                self.stdout.write(
                    f'  [{i+1:>2}] {node.name:<22} → {new_name:<22}'
                    f'  ({float(node.latitude):.4f},{float(node.longitude):.4f})'
                    f' → ({new_lat:.4f},{new_lng:.4f})'
                )

                if not dry_run:
                    node.name      = new_name
                    node.latitude  = new_lat
                    node.longitude = new_lng
                    node.save(update_fields=['name', 'latitude', 'longitude'])

            # 기존보다 새 데이터가 많으면 추가 (새 RA 생성)
            if len(ra_list) > len(existing_ras):
                # IC 노드 중 마지막 sequence 파악 후 삽입 필요
                # → 일단 경고만 출력 (수동 조정 필요)
                for i in range(len(existing_ras), len(ra_list)):
                    new_name, new_lat, new_lng = ra_list[i]
                    self.stdout.write(
                        self.style.WARNING(
                            f'  ⚠️  신규 RA [{i+1}] {new_name} — sequence 수동 지정 필요'
                        )
                    )

            # 기존보다 새 데이터가 적으면 경고
            if len(existing_ras) > len(ra_list):
                for i in range(len(ra_list), len(existing_ras)):
                    node = existing_ras[i]
                    self.stdout.write(
                        self.style.WARNING(
                            f'  ⚠️  잉여 RA [{i+1}] {node.name} — 수동 삭제 필요'
                        )
                    )

        if dry_run:
            self.stdout.write(self.style.SUCCESS(
                '\n✅ [DRY-RUN] 완료 — DB 수정 없음'
            ))
        else:
            self.stdout.write(self.style.SUCCESS(
                '\n✅ 경부고속도로 RA 최신화 완료!'
                '\n   확인: http://localhost:8000/admin/chargeflow/highwaynode/'
                '\n   이후 map_ra_stations.py 재실행 필요'
            ))
