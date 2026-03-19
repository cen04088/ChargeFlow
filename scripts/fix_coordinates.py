"""
카카오 로컬 API로 IC/RA 노드 좌표 자동 보정 스크립트
======================================================
카카오 REST API 키 (발급받은 키 중 "REST API 키" 사용)

사용법:
  cd chargeflow  (manage.py 있는 폴더)

  # 1단계: 결과 미리보기 (DB 수정 없음)
  python scripts/fix_coordinates.py --kakao-key REDACTED_KAKAO_API_KEY --dry-run

  # 2단계: 특정 고속도로만 먼저 테스트
  python scripts/fix_coordinates.py --kakao-key REDACTED_KAKAO_API_KEY --highway gyeongbu --dry-run

  # 3단계: 실제 좌표 업데이트
  python scripts/fix_coordinates.py --kakao-key REDACTED_KAKAO_API_KEY

  # 4단계: 신뢰도 낮은 결과만 따로 확인
  python scripts/fix_coordinates.py --kakao-key REDACTED_KAKAO_API_KEY --show-low-confidence
"""
import os
import sys
import time
import argparse
import urllib.request
import urllib.parse
import json

import django
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
os.environ.setdefault('DJANGO_SETTINGS_MODULE', 'config.settings')
django.setup()

from chargeflow.models import HighwayNode

KAKAO_LOCAL_URL = 'https://dapi.kakao.com/v2/local/search/keyword.json'

# 검색 키워드 보정 사전
# "판교IC" 처럼 검색하면 안 잡힐 때 대체 검색어 사용
ALIAS = {
    '서울TG':       '경부고속도로 서울요금소',
    '부산TG':       '경부고속도로 부산요금소',
    '조남JCT':      '서해안고속도로 조남분기점',
    '판교JCT':      '영동고속도로 판교분기점',
    '동해JCT':      '동해고속도로 동해분기점',
    '안산JCT':      '영동고속도로 안산분기점',
    '강릉TG':       '강릉요금소',
    '만남의광장휴게소': '경부고속도로 만남의광장',
}

# 신뢰도 판단: 검색 결과의 카테고리 또는 이름에 아래 키워드가 포함되면 높은 신뢰도
HIGH_CONF_KEYWORDS = [
    '고속도로', 'IC', '나들목', '요금소', '휴게소', '분기점', 'JCT', 'TG', 'Junction'
]


def search_kakao(kakao_key: str, query: str, x=None, y=None) -> dict | None:
    """카카오 로컬 키워드 검색 → 첫 번째 결과 반환"""
    params = {
        'query': query,
        'size':  5,
    }
    if x and y:
        params['x'] = x   # 기존 경도 (힌트용)
        params['y'] = y   # 기존 위도
        params['sort'] = 'distance'

    url = f'{KAKAO_LOCAL_URL}?{urllib.parse.urlencode(params)}'
    req = urllib.request.Request(
        url,
        headers={'Authorization': f'KakaoAK {kakao_key}'}
    )
    try:
        with urllib.request.urlopen(req, timeout=10) as res:
            data = json.loads(res.read().decode('utf-8'))
        docs = data.get('documents') or []
        return docs[0] if docs else None
    except Exception as e:
        print(f'      ⚠️  API 오류: {e}')
        return None


def is_high_confidence(doc: dict, node_name: str) -> bool:
    """검색 결과가 실제 IC/RA와 일치할 가능성이 높은지 판단"""
    place_name     = doc.get('place_name', '')
    category_name  = doc.get('category_name', '')
    combined       = place_name + category_name

    # 카테고리에 교통/고속도로 포함
    if any(kw in combined for kw in HIGH_CONF_KEYWORDS):
        return True

    # 노드 이름의 핵심 단어가 결과에 포함
    core = node_name.replace('IC', '').replace('RA', '').replace('휴게소', '').strip()
    if core and core in place_name:
        return True

    return False


def fix_coordinates(kakao_key: str, hw_filter: str, dry_run: bool, show_low: bool):
    qs = HighwayNode.objects.select_related('highway').order_by(
        'highway', 'direction', 'sequence'
    )
    if hw_filter:
        qs = qs.filter(highway__code=hw_filter)

    # 중복 이름 처리 (상행/하행 같은 IC → 한 번만 검색)
    processed_names = {}   # name → (lat, lng, confidence)

    updated   = 0
    skipped   = 0
    low_conf  = []

    print(f'\n🗺️  좌표 보정 시작  (dry_run={dry_run})\n')
    print(f'{"노선":<12} {"방향":<5} {"seq":>3}  {"이름":<18} {"기존 위도":>10} {"기존 경도":>11}  →  {"새 위도":>10} {"새 경도":>11}  {"신뢰도"}')
    print('─' * 110)

    current_hw = None

    for node in qs:
        hw_label = f'{node.highway.name} {node.direction}'
        if hw_label != current_hw:
            print(f'\n▶ {hw_label}')
            current_hw = hw_label

        node_name = node.name

        # 캐시 확인 (같은 이름이면 재검색 생략)
        if node_name in processed_names:
            new_lat, new_lng, conf = processed_names[node_name]
        else:
            # 검색 키워드 결정
            query = ALIAS.get(node_name, node_name)

            # 카카오 검색 (기존 좌표를 힌트로 사용)
            doc = search_kakao(
                kakao_key, query,
                x=str(node.longitude), y=str(node.latitude)
            )

            if not doc:
                print(f'  seq{node.sequence:>3}  {node_name:<18}  검색 결과 없음 — 건너뜀')
                skipped += 1
                time.sleep(0.1)
                continue

            new_lat = float(doc['y'])
            new_lng = float(doc['x'])
            conf    = 'HIGH' if is_high_confidence(doc, node_name) else 'LOW'
            place_found = doc.get('place_name', '')

            processed_names[node_name] = (new_lat, new_lng, conf)

            if conf == 'LOW':
                low_conf.append({
                    'node':        node,
                    'found':       place_found,
                    'new_lat':     new_lat,
                    'new_lng':     new_lng,
                    'category':    doc.get('category_name', ''),
                })

            time.sleep(0.1)   # API 호출 간격

        # 변화량 계산
        delta_lat = abs(new_lat - float(node.latitude))
        delta_lng = abs(new_lng - float(node.longitude))
        moved_m   = int(((delta_lat ** 2 + delta_lng ** 2) ** 0.5) * 111_000)

        conf_icon = '✅' if conf == 'HIGH' else '⚠️ '
        print(
            f'  {node.sequence:>3}  {node_name:<18} '
            f'{float(node.latitude):>10.4f} {float(node.longitude):>11.4f}  →  '
            f'{new_lat:>10.4f} {new_lng:>11.4f}  {conf_icon} {conf} (~{moved_m}m 이동)'
        )

        if not dry_run:
            node.latitude  = new_lat
            node.longitude = new_lng
            node.save(update_fields=['latitude', 'longitude'])
            updated += 1

    # ── 요약 ──────────────────────────────────────────────
    print('\n' + '═' * 110)
    if dry_run:
        print(f'✅ [DRY-RUN] DB 수정 없음. 총 {qs.count()}개 노드 미리보기 완료.')
    else:
        print(f'✅ 좌표 업데이트 완료: {updated}개  /  건너뜀: {skipped}개')

    # 신뢰도 낮은 결과 출력
    if low_conf and (show_low or dry_run):
        print(f'\n⚠️  신뢰도 낮은 결과 {len(low_conf)}개 — 수동 확인 필요:')
        print(f'  {"이름":<20} {"검색됨":<30} {"카테고리":<25} {"새 좌표"}')
        print('  ' + '─' * 100)
        for item in low_conf:
            print(
                f'  {item["node"].name:<20} '
                f'{item["found"]:<30} '
                f'{item["category"]:<25} '
                f'({item["new_lat"]:.4f}, {item["new_lng"]:.4f})'
            )

    print('\n📌 수동 보정이 필요한 항목은 Django Admin에서 직접 수정하세요:')
    print('   http://localhost:8000/admin/chargeflow/highwaynode/')


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description='카카오 로컬 API로 IC/RA 좌표 보정')
    parser.add_argument('--kakao-key',        required=True, help='카카오 REST API 키')
    parser.add_argument('--highway',          default=None,
                        help='특정 노선만 (gyeongbu / seohaeAN / yeongdong)')
    parser.add_argument('--dry-run',          action='store_true', help='미리보기만 (DB 수정 없음)')
    parser.add_argument('--show-low-confidence', action='store_true',
                        help='신뢰도 낮은 결과 목록 출력')
    args = parser.parse_args()

    fix_coordinates(
        kakao_key = args.kakao_key,
        hw_filter = args.highway,
        dry_run   = args.dry_run,
        show_low  = args.show_low_confidence,
    )
