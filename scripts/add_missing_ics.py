"""
누락된 IC 노드 직접 추가
실행: python scripts/add_missing_ics.py --dry-run
      python scripts/add_missing_ics.py
"""
import os, sys, argparse
import django

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
os.environ.setdefault('DJANGO_SETTINGS_MODULE', 'config.settings')
django.setup()

from chargeflow.models import Highway, HighwayNode

# ── 추가할 IC 목록 ────────────────────────────────────────
# 형식: (노선코드, 방향, 이름, 위도, 경도)
# 방향은 상하행 공용이므로 DOWN/UP 둘 다 추가
# sequence는 기존 최대값 이후로 자동 배정 (정렬용이 아닌 식별자)

MISSING_ICS = [
    # ── 경부 ──────────────────────────────────────────────
    ('gyeongbu', '신갈JCT',    37.290000, 127.103680),
    ('gyeongbu', '남사진위IC', 36.989000, 127.260000),
    ('gyeongbu', '북천안IC',   36.704100, 127.081200),
    ('gyeongbu', '옥산IC',     36.657743, 127.369817),
    ('gyeongbu', '남청주IC',   36.590300, 127.047800),
    ('gyeongbu', '금강IC',     36.279148, 127.672231),
    ('gyeongbu', '동김천IC',   36.071200, 128.158200),
    ('gyeongbu', '왜관IC',     35.970000, 128.393000),
    ('gyeongbu', '남구미IC',   36.046000, 128.339000),
    ('gyeongbu', '영천IC',     35.884000, 128.952000),
    ('gyeongbu', '내남IC',     35.644000, 129.137000),
    ('gyeongbu', '남양산IC',   35.298000, 129.021000),
    ('gyeongbu', '서울주IC',   35.553861, 129.126636),
    ('gyeongbu', '언양JCT',    35.580000, 129.180000),
    ('gyeongbu', '수성IC',     35.837000, 128.643000),
    ('gyeongbu', '회덕JCT',    36.405272, 127.421007),
    ('gyeongbu', '청주IC',     36.716005, 127.349315),

    # ── 영동 ──────────────────────────────────────────────
    ('yeongdong', '서창JCT',   37.434495, 126.740909),
    ('yeongdong', '안산IC',    37.347386, 126.840872),
    ('yeongdong', '마성IC',    37.284006, 127.177364),
    ('yeongdong', '용인IC',    37.257273, 127.210854),
    ('yeongdong', '양지IC',    37.238671, 127.295604),
    ('yeongdong', '덕평IC',    37.242153, 127.365249),
    ('yeongdong', '명봉IC',    37.232060, 127.590210),
    ('yeongdong', '면온IC',    37.562110, 128.366235),
    ('yeongdong', '대관령IC',  37.677862, 128.695426),
    ('yeongdong', '강릉IC',    37.751200, 128.891200),

    # ── 서해안 ────────────────────────────────────────────
    ('seohaeAN', '목감IC',    37.329000, 126.904000),
    ('seohaeAN', '선운산IC',  35.400000, 126.680000),
    ('seohaeAN', '춘장대IC',  36.160000, 126.720000),
]


def run(dry_run: bool):
    print(f'\n➕ 누락 IC 추가  dry-run={dry_run}\n')

    added   = 0
    skipped = 0

    for hw_code, ic_name, lat, lng in MISSING_ICS:
        try:
            hw = Highway.objects.get(code=hw_code)
        except Highway.DoesNotExist:
            print(f'  ❌ 노선 없음: {hw_code}')
            continue

        for direction in ['DOWN', 'UP']:
            # 이미 있으면 skip
            exists = HighwayNode.objects.filter(
                highway=hw,
                direction=direction,
                node_type='IC',
                name=ic_name,
            ).exists()

            if exists:
                print(f'  ⏭  [{hw_code}/{direction}] {ic_name} — 이미 존재')
                skipped += 1
                continue

            # sequence: 같은 노선+방향 최대값 + 100
            max_seq = HighwayNode.objects.filter(
                highway=hw, direction=direction
            ).order_by('-sequence').values_list('sequence', flat=True).first() or 0
            new_seq = max_seq + 100

            print(f'  ✅ [{hw_code}/{direction}] {ic_name}  ({lat}, {lng})  seq={new_seq}')

            if not dry_run:
                HighwayNode.objects.create(
                    highway=hw,
                    direction=direction,
                    node_type='IC',
                    sequence=new_seq,
                    name=ic_name,
                    latitude=lat,
                    longitude=lng,
                    distance_from_start_km=0,
                    is_active=True,
                )
            added += 1

    print(f'\n{"═"*60}')
    if dry_run:
        print(f'✅ [DRY-RUN] 추가 예정: {added}개 / 이미 존재: {skipped}개')
    else:
        print(f'✅ 완료: 추가 {added}개 / 스킵 {skipped}개')
        print(f'\n다음 단계:')
        print(f'  python manage.py set_ra_ics --dry-run')
    print('═'*60)


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--dry-run', action='store_true')
    args = parser.parse_args()
    run(args.dry_run)
