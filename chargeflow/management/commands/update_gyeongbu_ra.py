"""
경부고속도로 RA(휴게소) 노드 최신화
============================================================
실행:
  python manage.py update_gyeongbu_ra
  python manage.py update_gyeongbu_ra --dry-run
"""
from django.core.management.base import BaseCommand
from chargeflow.models import Highway, HighwayNode
 
GYEONGBU_DOWN_RA = [
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
    ('건천휴게소',      35.830716, 129.109310),
    ('경주휴게소',          35.724761, 129.192950),
    ('통도사휴게소',        35.488841, 129.090775),
]
 
GYEONGBU_UP_RA = [
    ('양산휴게소',          35.323172, 129.056867),
    ('언양휴게소',          35.597942, 129.141801),
    ('건천휴게소',      35.831894, 129.109244),
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
 
# 휴게소별 인근 IC 매핑 (직전IC, 직후IC)
GYEONGBU_DOWN_IC_MAP = {
    '서울만남의광장휴게소': ('양재IC',    '판교IC'),
    '기흥휴게소':          ('신갈JCT',   '기흥IC'),
    '안성휴게소':          ('남사진위IC', '안성IC'),
    '망향휴게소':          ('북천안IC',  '천안IC'),
    '천안호두휴게소':      ('천안IC',    '목천IC'),
    '옥산휴게소':          ('천안JCT',   '옥산IC'),
    '죽암휴게소':          ('남청주IC',  '신탄진IC'),
    '금강휴게소':          ('금강IC',    '옥천IC'),
    '옥천휴게소':          ('옥천IC',    '영동IC'),
    '추풍령휴게소':        ('추풍령IC',  '황간IC'),
    '황간휴게소':          ('황간IC',    '김천IC'),
    '김천휴게소':          ('김천IC',    '동김천IC'),
    '칠곡휴게소':          ('왜관IC',    '남구미IC'),
    '평사휴게소':          ('경산IC',    '영천IC'),
    '건천휴게소':      ('건천IC',    '경주IC'),
    '경주휴게소':          ('경주IC',    '내남IC'),
    '통도사휴게소':        ('통도사IC',  '양산IC'),
}
 
GYEONGBU_UP_IC_MAP = {
    '양산휴게소':          ('양산IC',    '남양산IC'),
    '언양휴게소':          ('서울주IC',  '언양JCT'),
    '건천휴게소':      ('경주IC',    '건천IC'),
    '경산휴게소':          ('경산IC',    '수성IC'),
    '칠곡휴게소':          ('남구미IC',  '왜관IC'),
    '김천휴게소':          ('동김천IC',  '김천IC'),
    '추풍령휴게소':        ('황간IC',    '추풍령IC'),
    '황간휴게소':          ('김천IC',    '황간IC'),
    '옥천휴게소':          ('영동IC',    '옥천IC'),
    '금강휴게소':          ('옥천IC',    '금강IC'),
    '신탄진휴게소':        ('회덕JCT',   '신탄진IC'),
    '죽암휴게소':          ('신탄진IC',  '남청주IC'),
    '청주휴게소':          ('옥산IC',    '청주IC'),
    '천안삼거리휴게소':    ('목천IC',    '천안IC'),
    '입장거봉포도휴게소':  ('북천안IC',  '안성IC'),
    '안성휴게소':          ('안성IC',    '남사진위IC'),
    '죽전휴게소':          ('신갈JCT',   '판교IC'),
}
 
 
class Command(BaseCommand):
    help = '경부고속도로 RA 최신화'
 
    def add_arguments(self, parser):
        parser.add_argument('--dry-run', action='store_true')
 
    def handle(self, *args, **options):
        dry_run = options['dry_run']
        highway = Highway.objects.get(code='gyeongbu')
        self.stdout.write(f'\n🛣️  경부고속도로 RA 최신화  dry-run={dry_run}\n')
 
        for direction, ra_list, ic_map, label in [
            ('DOWN', GYEONGBU_DOWN_RA, GYEONGBU_DOWN_IC_MAP, '하행'),
            ('UP',   GYEONGBU_UP_RA,  GYEONGBU_UP_IC_MAP,  '상행'),
        ]:
            self.stdout.write(f'\n▶ {label} ({direction}) — {len(ra_list)}개 RA')
            existing = list(HighwayNode.objects.filter(
                highway=highway, direction=direction, node_type='RA'
            ).order_by('sequence'))
            self.stdout.write(f'  기존 DB: {len(existing)}개 / 새 데이터: {len(ra_list)}개')
 
            for i, (new_name, new_lat, new_lng) in enumerate(ra_list):
                if i < len(existing):
                    node = existing[i]
                    self.stdout.write(
                        f'  [{i+1:>2}] {node.name:<24} → {new_name:<24}'
                        f'  IC: {ic_map.get(new_name, ("?","?"))}'
                    )
                    if not dry_run:
                        node.name = new_name
                        node.latitude = new_lat
                        node.longitude = new_lng
                        node.save(update_fields=['name','latitude','longitude'])
                else:
                    self.stdout.write(self.style.WARNING(
                        f'  ⚠️  [{i+1}] {new_name} — 신규 (수동 추가 필요)'
                    ))
 
        if not dry_run:
            self.stdout.write(self.style.SUCCESS('\n✅ 완료!'))
        else:
            self.stdout.write(self.style.SUCCESS('\n✅ [DRY-RUN] 완료'))