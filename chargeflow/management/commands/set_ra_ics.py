"""
휴게소(RA) 노드에 직전/직후 IC 연결
============================================================
실행:
  python manage.py set_ra_ics --dry-run
  python manage.py set_ra_ics
"""
from django.core.management.base import BaseCommand
from chargeflow.models import HighwayNode
 
# ── RA별 직전/직후 IC 이름 정의 ──────────────────────────────
# 형식: '휴게소명': ('직전IC명', '직후IC명')
# IC 이름은 DB의 HighwayNode.name 과 일치해야 함
 
RA_IC_MAP = {
    # ══ 경부 하행 ══
    ('gyeongbu', 'DOWN', '서울만남의광장휴게소'): ('양재IC',     '판교IC'),
    ('gyeongbu', 'DOWN', '기흥휴게소'):          ('신갈JCT',    '기흥IC'),
    ('gyeongbu', 'DOWN', '안성휴게소'):          ('남사진위IC', '안성IC'),
    ('gyeongbu', 'DOWN', '망향휴게소'):          ('북천안IC',   '천안IC'),
    ('gyeongbu', 'DOWN', '천안호두휴게소'):      ('천안IC',     '목천IC'),
    ('gyeongbu', 'DOWN', '옥산휴게소'):          ('천안JCT',    '옥산IC'),
    ('gyeongbu', 'DOWN', '죽암휴게소'):          ('남청주IC',   '신탄진IC'),
    ('gyeongbu', 'DOWN', '금강휴게소'):          ('금강IC',     '옥천IC'),
    ('gyeongbu', 'DOWN', '옥천휴게소'):          ('옥천IC',     '영동IC'),
    ('gyeongbu', 'DOWN', '추풍령휴게소'):        ('추풍령IC',   '황간IC'),
    ('gyeongbu', 'DOWN', '황간휴게소'):          ('황간IC',     '김천IC'),
    ('gyeongbu', 'DOWN', '김천휴게소'):          ('김천IC',     '동김천IC'),
    ('gyeongbu', 'DOWN', '칠곡휴게소'):          ('왜관IC',     '남구미IC'),
    ('gyeongbu', 'DOWN', '평사휴게소'):          ('경산IC',     '영천IC'),
    ('gyeongbu', 'DOWN', '건천휴게소'):      ('건천IC',     '경주IC'),
    ('gyeongbu', 'DOWN', '경주휴게소'):          ('경주IC',     '내남IC'),
    ('gyeongbu', 'DOWN', '통도사휴게소'):        ('통도사IC',   '양산IC'),
 
    # ══ 경부 상행 ══
    ('gyeongbu', 'UP', '양산휴게소'):            ('양산IC',     '남양산IC'),
    ('gyeongbu', 'UP', '언양휴게소'):            ('서울주IC',   '언양JCT'),
    ('gyeongbu', 'UP', '건천휴게소'):        ('경주IC',     '건천IC'),
    ('gyeongbu', 'UP', '경산휴게소'):            ('경산IC',     '수성IC'),
    ('gyeongbu', 'UP', '칠곡휴게소'):            ('남구미IC',   '왜관IC'),
    ('gyeongbu', 'UP', '김천휴게소'):            ('동김천IC',   '김천IC'),
    ('gyeongbu', 'UP', '추풍령휴게소'):          ('황간IC',     '추풍령IC'),
    ('gyeongbu', 'UP', '황간휴게소'):            ('김천IC',     '황간IC'),
    ('gyeongbu', 'UP', '옥천휴게소'):            ('영동IC',     '옥천IC'),
    ('gyeongbu', 'UP', '금강휴게소'):            ('옥천IC',     '금강IC'),
    ('gyeongbu', 'UP', '신탄진휴게소'):          ('회덕JCT',    '신탄진IC'),
    ('gyeongbu', 'UP', '죽암휴게소'):            ('신탄진IC',   '남청주IC'),
    ('gyeongbu', 'UP', '청주휴게소'):            ('옥산IC',     '청주IC'),
    ('gyeongbu', 'UP', '천안삼거리휴게소'):      ('목천IC',     '천안IC'),
    ('gyeongbu', 'UP', '입장거봉포도휴게소'):    ('북천안IC',   '안성IC'),
    ('gyeongbu', 'UP', '안성휴게소'):            ('안성IC',     '남사진위IC'),
    ('gyeongbu', 'UP', '죽전휴게소'):            ('신갈JCT',    '판교IC'),
 
    # ══ 영동 하행 ══
    ('yeongdong', 'DOWN', '안산휴게소'):         ('서창JCT',    '안산IC'),
    ('yeongdong', 'DOWN', '용인휴게소'):         ('마성IC',     '용인IC'),
    ('yeongdong', 'DOWN', '덕평자연휴게소'):     ('양지IC',     '덕평IC'),
    ('yeongdong', 'DOWN', '여주휴게소'):         ('여주IC',     '명봉IC'),
    ('yeongdong', 'DOWN', '문막휴게소'):         ('문막IC',     '원주IC'),
    ('yeongdong', 'DOWN', '횡성휴게소'):         ('새말IC',     '둔내IC'),
    ('yeongdong', 'DOWN', '평창휴게소'):         ('면온IC',     '평창IC'),
    ('yeongdong', 'DOWN', '강릉휴게소'):         ('대관령IC',   '강릉IC'),
 
    # ══ 영동 상행 ══
    ('yeongdong', 'UP', '강릉휴게소'):           ('강릉IC',     '대관령IC'),
    ('yeongdong', 'UP', '평창휴게소'):           ('평창IC',     '면온IC'),
    ('yeongdong', 'UP', '횡성휴게소'):           ('둔내IC',     '새말IC'),
    ('yeongdong', 'UP', '문막휴게소'):           ('원주IC',     '문막IC'),
    ('yeongdong', 'UP', '여주휴게소'):           ('명봉IC',     '여주IC'),
    ('yeongdong', 'UP', '덕평자연휴게소'):       ('덕평IC',     '양지IC'),
    ('yeongdong', 'UP', '용인휴게소'):           ('용인IC',     '마성IC'),
    ('yeongdong', 'UP', '안산휴게소'):           ('안산IC',     '서창JCT'),
 
    # ══ 서해안 하행 ══
    ('seohaeAN', 'DOWN', '매송휴게소'):          ('목감IC',     '비봉IC'),
    ('seohaeAN', 'DOWN', '화성휴게소'):          ('비봉IC',     '발안IC'),
    ('seohaeAN', 'DOWN', '행담도휴게소'):        ('송악IC',     '당진IC'),
    ('seohaeAN', 'DOWN', '서산휴게소'):          ('당진IC',     '해미IC'),
    ('seohaeAN', 'DOWN', '홍성휴게소'):          ('해미IC',     '홍성IC'),
    ('seohaeAN', 'DOWN', '대천휴게소'):          ('광천IC',     '대천IC'),
    ('seohaeAN', 'DOWN', '서천휴게소'):          ('무창포IC',   '춘장대IC'),
    ('seohaeAN', 'DOWN', '군산휴게소'):          ('군산IC',     '동군산IC'),
    ('seohaeAN', 'DOWN', '부안고려청자휴게소'):  ('줄포IC',     '선운산IC'),
    ('seohaeAN', 'DOWN', '고창고인돌휴게소'):    ('선운산IC',   '고창IC'),
    ('seohaeAN', 'DOWN', '함평천지휴게소'):      ('영광IC',     '함평IC'),
 
    # ══ 서해안 상행 ══
    ('seohaeAN', 'UP', '함평천지휴게소'):        ('함평IC',     '영광IC'),
    ('seohaeAN', 'UP', '고창고인돌휴게소'):      ('고창IC',     '선운산IC'),
    ('seohaeAN', 'UP', '부안고려청자휴게소'):    ('선운산IC',   '줄포IC'),
    ('seohaeAN', 'UP', '군산휴게소'):            ('동군산IC',   '군산IC'),
    ('seohaeAN', 'UP', '서천휴게소'):            ('춘장대IC',   '무창포IC'),
    ('seohaeAN', 'UP', '대천휴게소'):            ('대천IC',     '광천IC'),
    ('seohaeAN', 'UP', '홍성휴게소'):            ('홍성IC',     '해미IC'),
    ('seohaeAN', 'UP', '서산휴게소'):            ('해미IC',     '당진IC'),
    ('seohaeAN', 'UP', '행담도휴게소'):          ('당진IC',     '송악IC'),
    ('seohaeAN', 'UP', '화성휴게소'):            ('발안IC',     '비봉IC'),
    ('seohaeAN', 'UP', '매송휴게소'):            ('비봉IC',     '목감IC'),
}
 
 
class Command(BaseCommand):
    help = 'RA 노드에 prev_ic / next_ic 연결'
 
    def add_arguments(self, parser):
        parser.add_argument('--dry-run', action='store_true')
 
    def handle(self, *args, **options):
        dry_run = options['dry_run']
        self.stdout.write(f'\n🔗 RA-IC 연결 시작  dry-run={dry_run}\n')
 
        ok = 0
        fail = []
 
        for (hw_code, direction, ra_name), (prev_name, next_name) in RA_IC_MAP.items():
            # RA 노드 찾기
            try:
                ra = HighwayNode.objects.get(
                    highway__code=hw_code,
                    direction=direction,
                    node_type='RA',
                    name=ra_name,
                )
            except HighwayNode.DoesNotExist:
                fail.append(f'RA 없음: [{hw_code}/{direction}] {ra_name}')
                continue
 
            # IC 노드 찾기 — 정확한 이름 먼저, 없으면 포함 검색
            def find_ic(name):
                # 1. 정확한 이름 매칭
                ic = HighwayNode.objects.filter(
                    highway__code=hw_code,
                    node_type='IC',
                    name=name,
                ).first()
                if ic:
                    return ic
                # 2. 이름 포함 검색 (JCT/IC 제거 후)
                core = name.replace('IC','').replace('JCT','').replace('JC','').strip()
                if len(core) >= 2:
                    return HighwayNode.objects.filter(
                        highway__code=hw_code,
                        node_type='IC',
                        name__icontains=core,
                    ).first()
                return None
 
            prev_ic = find_ic(prev_name)
            next_ic = find_ic(next_name)
 
            prev_label = prev_ic.name if prev_ic else f'❌ 없음({prev_name})'
            next_label = next_ic.name if next_ic else f'❌ 없음({next_name})'
 
            self.stdout.write(
                f'  [{hw_code}/{direction}] {ra_name:<24} '
                f'직전: {prev_label:<16} 직후: {next_label}'
            )
 
            if not prev_ic:
                fail.append(f'IC 없음: {prev_name} (for {ra_name})')
            if not next_ic:
                fail.append(f'IC 없음: {next_name} (for {ra_name})')
 
            if not dry_run:
                ra.prev_ic = prev_ic
                ra.next_ic = next_ic
                ra.save(update_fields=['prev_ic', 'next_ic'])
 
            ok += 1
 
        self.stdout.write(f'\n{"═"*60}')
        if dry_run:
            self.stdout.write(self.style.SUCCESS(f'✅ [DRY-RUN] {ok}개 RA 처리 예정'))
        else:
            self.stdout.write(self.style.SUCCESS(f'✅ 완료: {ok}개 RA 연결'))
 
        if fail:
            self.stdout.write(self.style.WARNING('\n⚠️  실패 목록:'))
            for f in fail:
                self.stdout.write(f'   {f}')
        self.stdout.write('═'*60)
