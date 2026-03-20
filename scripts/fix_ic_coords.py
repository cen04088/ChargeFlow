"""
IC 좌표 일괄 보정 스크립트
실행: python scripts/fix_ic_coords.py --dry-run
      python scripts/fix_ic_coords.py
"""
import os, sys, argparse
import django

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
os.environ.setdefault('DJANGO_SETTINGS_MODULE', 'config.settings')
django.setup()

from chargeflow.models import HighwayNode

# 이름 → (위도, 경도) — CSV 확인된 정확한 좌표
CORRECT_COORDS = {
    # ── 경부 (CSV/카카오맵 기준 보정) ────────────────────────
    '안성IC':     (36.994219, 127.156069),  # CSV 확인
    '천안IC':     (36.826284, 127.171309),  # CSV 확인
    '양산IC':     (35.378218, 129.053314),  # CSV 확인
    '경주IC':     (35.806331, 129.187987),  # CSV 확인 (하행/상행 공용)
    '건천IC':     (35.815000, 129.075000),  # 근사값 — 카카오맵 확인 필요
    '내남IC':     (35.620000, 129.120000),  # 근사값 — 카카오맵 확인 필요
    # ── 경부 (기존) ──────────────────────────────────────────
    '신갈JCT':    (37.291807, 127.104780),
    '남사진위IC': (37.106594, 127.116617),
    '북천안IC':   (36.897397, 127.191351),
    '옥산IC':     (36.656813, 127.372626),  # 옥산하이패스IC
    '남청주IC':   (36.534315, 127.432157),
    '금강IC':     (36.279278, 127.673348),
    '동김천IC':   (36.134976, 128.177560),
    '왜관IC':     (35.977351, 128.434690),
    '남구미IC':   (36.068138, 128.370149),
    '영천IC':     (35.921589, 128.951168),  # 두 값 평균
    '내남IC':     (35.644000, 129.137000),  # 근사값 유지
    '남양산IC':   (35.298000, 129.021000),  # 근사값 유지
    '서울주IC':   (35.553861, 129.126636),
    '언양JCT':    (35.566669, 129.130010),
    '수성IC':     (35.837000, 128.643000),  # 근사값 유지
    '회덕JCT':    (36.405272, 127.421007),
    '청주IC':     (36.626784, 127.385014),

    # ── 영동 ──────────────────────────────────────────────
    '서창JCT':   (37.434495, 126.740909),
    '안산IC':    (37.347386, 126.840872),
    '마성IC':    (37.284006, 127.177364),
    '용인IC':    (37.257273, 127.210854),
    '양지IC':    (37.238671, 127.295604),
    '덕평IC':    (37.242153, 127.365249),
    '명봉IC':    (37.232060, 127.590210),
    '면온IC':    (37.562110, 128.366235),
    '대관령IC':  (37.677862, 128.695426),
    '강릉IC':    (37.751200, 128.891200),

    # ── 서해안 ────────────────────────────────────────────
    '목감IC':   (37.396386, 126.873127),
    '선운산IC': (35.508414, 126.684341),
    '춘장대IC': (36.169227, 126.601782),
}


def run(dry_run: bool):
    print(f'\n🔧 IC 좌표 보정  dry-run={dry_run}\n')

    updated = 0
    same    = 0

    for name, (correct_lat, correct_lng) in CORRECT_COORDS.items():
        nodes = HighwayNode.objects.filter(node_type='IC', name=name)
        if not nodes.exists():
            print(f'  ⚠️  DB에 없음: {name}')
            continue

        for node in nodes:
            cur_lat = float(node.latitude)
            cur_lng = float(node.longitude)
            diff_m  = int(((abs(correct_lat - cur_lat)**2 +
                            abs(correct_lng - cur_lng)**2)**0.5) * 111000)

            if diff_m < 10:
                same += 1
                continue

            print(f'  ✅ [{node.highway.code}/{node.direction}] {name:<16} '
                  f'({cur_lat:.6f},{cur_lng:.6f}) → '
                  f'({correct_lat:.6f},{correct_lng:.6f})  {diff_m}m 이동')

            if not dry_run:
                node.latitude  = correct_lat
                node.longitude = correct_lng
                node.save(update_fields=['latitude', 'longitude'])
            updated += 1

    print(f'\n{"═"*60}')
    if dry_run:
        print(f'✅ [DRY-RUN] 보정 예정: {updated}개 / 이미 정확: {same}개')
    else:
        print(f'✅ 완료: {updated}개 보정 / {same}개 이미 정확')
    print('═'*60)


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--dry-run', action='store_true')
    args = parser.parse_args()
    run(args.dry_run)
