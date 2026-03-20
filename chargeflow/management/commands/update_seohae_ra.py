"""
서해안고속도로 RA(휴게소) 노드 최신화
============================================================
실행:
  python manage.py update_seohae_ra
  python manage.py update_seohae_ra --dry-run
"""
from django.core.management.base import BaseCommand
from chargeflow.models import Highway, HighwayNode
 
SEOHAE_DOWN_RA = [
    ('매송휴게소',          37.264769, 126.891795),
    ('화성휴게소',          37.143497, 126.881289),
    ('행담도휴게소',        36.944819, 126.807525),
    ('서산휴게소',          36.742991, 126.565029),
    ('홍성휴게소',          36.552584, 126.579514),
    ('대천휴게소',          36.372995, 126.555684),
    ('서천휴게소',          36.129505, 126.626485),
    ('군산휴게소',          35.980591, 126.828971),
    ('부안고려청자휴게소',  35.671628, 126.732073),
    ('고창고인돌휴게소',    35.468653, 126.673871),
    ('함평천지휴게소',      35.069687, 126.478247),
]
 
SEOHAE_UP_RA = [
    ('함평천지휴게소',      35.130746, 126.482295),
    ('고창고인돌휴게소',    35.462070, 126.673477),
    ('부안고려청자휴게소',  35.671598, 126.734592),
    ('군산휴게소',          36.018831, 126.797698),
    ('서천휴게소',          36.131929, 126.627834),
    ('대천휴게소',          36.374457, 126.558327),
    ('홍성휴게소',          36.552430, 126.581870),
    ('서산휴게소',          36.734194, 126.566302),
    ('행담도휴게소',        36.944819, 126.807525),
    ('화성휴게소',          37.143497, 126.881289),
    ('매송휴게소',          37.264769, 126.891795),
]
 
SEOHAE_DOWN_IC_MAP = {
    '매송휴게소':         ('목감IC',   '비봉IC'),
    '화성휴게소':         ('비봉IC',   '발안IC'),
    '행담도휴게소':       ('송악IC',   '당진IC'),
    '서산휴게소':         ('당진IC',   '해미IC'),
    '홍성휴게소':         ('해미IC',   '홍성IC'),
    '대천휴게소':         ('광천IC',   '대천IC'),
    '서천휴게소':         ('무창포IC', '춘장대IC'),   # 하행: 무창포→춘장대
    '군산휴게소':         ('군산IC',   '동군산IC'),
    '부안고려청자휴게소': ('줄포IC',   '선운산IC'),  # 선운산IC (수정)
    '고창고인돌휴게소':   ('선운산IC', '고창IC'),
    '함평천지휴게소':     ('영광IC',   '함평IC'),
}
 
SEOHAE_UP_IC_MAP = {
    '함평천지휴게소':     ('함평IC',   '영광IC'),
    '고창고인돌휴게소':   ('고창IC',   '선운산IC'),
    '부안고려청자휴게소': ('선운산IC', '줄포IC'),
    '군산휴게소':         ('동군산IC', '군산IC'),
    '서천휴게소':         ('서천IC',   '춘장대IC'),   # 상행: 춘장대→무창포
    '대천휴게소':         ('대천IC',   '광천IC'),
    '홍성휴게소':         ('홍성IC',   '해미IC'),
    '서산휴게소':         ('해미IC',   '당진IC'),
    '행담도휴게소':       ('당진IC',   '송악IC'),
    '화성휴게소':         ('발안IC',   '비봉IC'),
    '매송휴게소':         ('비봉IC',   '목감IC'),
}
 
 
class Command(BaseCommand):
    help = '서해안고속도로 RA 최신화'
 
    def add_arguments(self, parser):
        parser.add_argument('--dry-run', action='store_true')
 
    def handle(self, *args, **options):
        dry_run = options['dry_run']
        try:
            highway = Highway.objects.get(code='seohaeAN')
        except Highway.DoesNotExist:
            self.stdout.write(self.style.ERROR('❌ 서해안고속도로 없음'))
            return
 
        self.stdout.write(f'\n🌊 서해안고속도로 RA 최신화  dry-run={dry_run}\n')
 
        for direction, ra_list, ic_map, label in [
            ('DOWN', SEOHAE_DOWN_RA, SEOHAE_DOWN_IC_MAP, '하행'),
            ('UP',   SEOHAE_UP_RA,  SEOHAE_UP_IC_MAP,  '상행'),
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