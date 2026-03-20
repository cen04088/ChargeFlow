"""
영동고속도로 RA(휴게소) 노드 최신화
============================================================
실행:
  python manage.py update_yeongdong_ra
  python manage.py update_yeongdong_ra --dry-run
"""
from django.core.management.base import BaseCommand
from chargeflow.models import Highway, HighwayNode
 
YEONGDONG_DOWN_RA = [
    ('안산휴게소',      37.351075, 126.818799),
    ('용인휴게소',      37.245583, 127.241980),
    ('덕평자연휴게소',  37.241456, 127.390189),
    ('여주휴게소',      37.238022, 127.568892),
    ('문막휴게소',      37.335469, 127.858220),
    ('횡성휴게소',      37.462755, 128.133969),
    ('평창휴게소',      37.605570, 128.452681),
    ('강릉휴게소',      37.758206, 128.806648),  # 대관령IC ↔ 강릉JCT/강릉IC
]
 
YEONGDONG_UP_RA = [
    ('강릉휴게소',      37.760275, 128.805360),  # 북강릉IC/강릉JCT ↔ 대관령IC
    ('평창휴게소',      37.610876, 128.463363),
    ('횡성휴게소',      37.464983, 128.135449),
    ('문막휴게소',      37.297853, 127.817261),
    ('여주휴게소',      37.239739, 127.569949),
    ('덕평자연휴게소',  37.241456, 127.390189),
    ('용인휴게소',      37.248318, 127.238342),
    ('안산휴게소',      37.351075, 126.818799),
]
 
YEONGDONG_DOWN_IC_MAP = {
    '안산휴게소':     ('서창JCT/선부IC', '안산IC'),
    '용인휴게소':     ('마성IC',         '용인IC'),
    '덕평자연휴게소': ('양지IC',         '덕평IC'),
    '여주휴게소':     ('여주IC',         '명봉IC(동여주)'),
    '문막휴게소':     ('문막IC',         '원주IC'),
    '횡성휴게소':     ('새말IC',         '둔내IC'),
    '평창휴게소':     ('면온IC',         '평창IC'),
    '강릉휴게소':     ('대관령IC',       '강릉JCT/강릉IC'),
}
 
YEONGDONG_UP_IC_MAP = {
    '강릉휴게소':     ('북강릉IC/강릉JCT', '대관령IC'),
    '평창휴게소':     ('평창IC',           '면온IC'),
    '횡성휴게소':     ('둔내IC',           '새말IC'),
    '문막휴게소':     ('원주IC',           '문막IC'),
    '여주휴게소':     ('명봉IC(동여주)',   '여주IC'),
    '덕평자연휴게소': ('덕평IC',           '양지IC'),
    '용인휴게소':     ('용인IC',           '마성IC'),
    '안산휴게소':     ('안산IC',           '선부IC/서창JCT'),
}
 
 
class Command(BaseCommand):
    help = '영동고속도로 RA 최신화'
 
    def add_arguments(self, parser):
        parser.add_argument('--dry-run', action='store_true')
 
    def handle(self, *args, **options):
        dry_run = options['dry_run']
        try:
            highway = Highway.objects.get(code='yeongdong')
        except Highway.DoesNotExist:
            self.stdout.write(self.style.ERROR('❌ 영동고속도로 없음'))
            return
 
        self.stdout.write(f'\n⛰️  영동고속도로 RA 최신화  dry-run={dry_run}\n')
 
        for direction, ra_list, ic_map, label in [
            ('DOWN', YEONGDONG_DOWN_RA, YEONGDONG_DOWN_IC_MAP, '하행'),
            ('UP',   YEONGDONG_UP_RA,  YEONGDONG_UP_IC_MAP,  '상행'),
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
                        f'  [{i+1:>2}] {node.name:<22} → {new_name:<22}'
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