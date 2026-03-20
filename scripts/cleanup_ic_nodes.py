"""
휴게소(RA) 인근 IC만 남기고 나머지 IC 삭제
============================================================
각 휴게소의 직전/직후 IC만 유지, 나머지 IC 노드는 모두 삭제

실행:
  python scripts/cleanup_ic_nodes.py --dry-run
  python scripts/cleanup_ic_nodes.py
"""
import os, sys, argparse
import django

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
os.environ.setdefault('DJANGO_SETTINGS_MODULE', 'config.settings')
django.setup()

from chargeflow.models import HighwayNode

# ── 휴게소별 인근 IC 이름 목록 ─────────────────────────────
# (휴게소 직전 IC, 직후 IC) — 상하행 모두 포함

KEEP_IC_NAMES = {
    'gyeongbu': {
        # 하행
        '양재IC', '판교IC',
        '신갈JCT',  '기흥IC',
        '남사진위IC', '안성IC',
        '북천안IC', '천안IC',
        '목천IC',
        '천안JCT', '옥산IC',
        '남청주IC', '신탄진IC',
        '금강IC', '옥천IC',
        '영동IC',
        '추풍령IC', '황간IC',
        '김천IC', '동김천IC',
        '왜관IC', '남구미IC',
        '경산IC', '영천IC',
        '건천IC', '경주IC',
        '내남IC',
        '통도사IC', '양산IC',
        # 상행 추가분
        '남양산IC',
        '서울주IC', '언양JCT',
        '수성IC',
        '회덕JCT',
        '청주IC',
        '안성IC',
    },
    'yeongdong': {
        '서창JCT', '선부IC', '안산IC',
        '마성IC', '용인IC',
        '양지IC', '덕평IC',
        '여주IC', '명봉IC',
        '문막IC', '원주IC',
        '새말IC', '둔내IC',
        '면온IC', '평창IC',
        '대관령IC', '강릉JCT', '강릉IC', '북강릉IC',
    },
    'seohaeAN': {
        '목감IC', '비봉IC',
        '발안IC',
        '송악IC', '당진IC',
        '해미IC',
        '홍성IC',
        '광천IC', '대천IC',
        '무창포IC', '춘장대IC',
        '군산IC', '동군산IC',
        '줄포IC', '선운산IC',
        '고창IC',
        '영광IC', '함평IC',
    },
}


def run(dry_run: bool):
    print(f'\n🗑️  IC 정리  dry-run={dry_run}\n')

    total_keep   = 0
    total_delete = 0

    for hw_code, keep_names in KEEP_IC_NAMES.items():
        all_ics = HighwayNode.objects.filter(
            highway__code=hw_code,
            node_type='IC',
        ).select_related('highway')

        keep_list   = []
        delete_list = []

        for ic in all_ics:
            # IC 이름에서 방향 괄호 제거 후 비교
            # 예: '신갈JCT' 포함 여부로 판단
            matched = any(keep_name in ic.name or ic.name in keep_name
                         for keep_name in keep_names)
            if matched:
                keep_list.append(ic)
            else:
                delete_list.append(ic)

        hw_name = all_ics.first().highway.name if all_ics.exists() else hw_code
        print(f'  ▶ {hw_name}')
        print(f'     유지: {len(keep_list)}개  삭제: {len(delete_list)}개')

        if delete_list:
            print(f'     삭제 대상:')
            for ic in delete_list:
                print(f'       - [{ic.direction} seq{ic.sequence:>3}] {ic.name}')

        if not dry_run and delete_list:
            ids = [ic.id for ic in delete_list]
            HighwayNode.objects.filter(id__in=ids).delete()

        total_keep   += len(keep_list)
        total_delete += len(delete_list)

    print(f'\n{"═"*60}')
    if dry_run:
        print(f'✅ [DRY-RUN] 유지: {total_keep}개 / 삭제 예정: {total_delete}개')
        print(f'   실제 삭제하려면 --dry-run 없이 재실행하세요.')
    else:
        print(f'✅ 완료  유지: {total_keep}개 / 삭제: {total_delete}개')
    print('═'*60)


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description='휴게소 인근 IC만 남기고 나머지 삭제')
    parser.add_argument('--dry-run', action='store_true', help='미리보기만')
    args = parser.parse_args()
    run(args.dry_run)
