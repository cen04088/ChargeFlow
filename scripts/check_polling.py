"""
충전기 상태 폴링 동작 확인 진단 스크립트
============================================================
사용법:
  python scripts/check_polling.py --api-key YOUR_PUBLIC_DATA_API_KEY
"""
import os, sys, json, time
import urllib.request, urllib.parse
import django

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
os.environ.setdefault('DJANGO_SETTINGS_MODULE', 'config.settings')
django.setup()

import argparse

API_STATUS_URL = 'https://apis.data.go.kr/B552584/EvCharger/getChargerStatus'
API_INFO_URL   = 'https://apis.data.go.kr/B552584/EvCharger/getChargerInfo'

STAT_LABEL = {
    '1': '통신이상', '2': '충전가능', '3': '충전중',
    '4': '운영중지', '5': '점검중',  '9': '상태미확인',
}

def check(api_key: str):
    print('\n' + '═'*60)
    print('  ChargeFlow 충전기 상태 폴링 진단')
    print('═'*60)

    # ── STEP 1: DB 모델 확인 ────────────────────────────────
    print('\n[1/5] DB 모델 확인...')
    try:
        from chargeflow.models import ChargingStation, ChargerStatusLog, StationCongestion
        station_cnt = ChargingStation.objects.count()
        log_cnt     = ChargerStatusLog.objects.count()
        cong_cnt    = StationCongestion.objects.count()
        print(f'  ✅ ChargingStation   : {station_cnt}개')
        print(f'  ✅ ChargerStatusLog  : {log_cnt}개')
        print(f'  ✅ StationCongestion : {cong_cnt}개')

        if station_cnt == 0:
            print('  ⚠️  충전소 데이터가 없습니다. collect_stations.py를 먼저 실행하세요.')
            return
    except Exception as e:
        print(f'  ❌ 모델 오류: {e}')
        print('     → models.py에 ChargerStatusLog, StationCongestion 추가 후 migrate 필요')
        return

    # ── STEP 2: source_api_id 있는 충전소 확인 ──────────────
    print('\n[2/5] API 연동 가능 충전소 확인...')
    from chargeflow.models import ChargingStation
    has_id   = ChargingStation.objects.exclude(source_api_id=None).exclude(source_api_id='').count()
    no_id    = ChargingStation.objects.filter(source_api_id=None).count() + \
               ChargingStation.objects.filter(source_api_id='').count()
    print(f'  ✅ source_api_id 있음 : {has_id}개 (폴링 대상)')
    print(f'  ℹ️  source_api_id 없음 : {no_id}개 (폴링 제외)')

    if has_id == 0:
        print('  ⚠️  폴링 대상 충전소가 없습니다.')
        return

    # ── STEP 3: 실제 API 호출 테스트 (첫 번째 충전소 3개) ───
    print('\n[3/5] 환경부 API 실제 호출 테스트...')
    test_stations = list(
        ChargingStation.objects.exclude(source_api_id=None).exclude(source_api_id='')[:3]
    )

    api_ok = 0
    for st in test_stations:
        params = urllib.parse.urlencode({
            'serviceKey': api_key,
            'pageNo':     1,
            'numOfRows':  10,
            'dataType':   'JSON',
            'statId':     st.source_api_id,
        })
        try:
            req = urllib.request.Request(
                f'{API_STATUS_URL}?{params}',
                headers={'Accept': 'application/json'}
            )
            with urllib.request.urlopen(req, timeout=10) as res:
                data = json.loads(res.read().decode('utf-8'))

            body  = data.get('body') or data
            items = body.get('items') or {}
            if isinstance(items, dict):
                items = items.get('item') or []
            if isinstance(items, dict):
                items = [items]

            if items:
                sample = items[0]
                stat   = sample.get('stat', '?')
                label  = STAT_LABEL.get(str(stat), '알수없음')
                print(f'  ✅ {st.name[:22]:<22} → 충전기 {len(items)}기  상태: {stat}({label})')
                api_ok += 1
            else:
                print(f'  ⚠️  {st.name[:22]:<22} → 응답은 왔으나 데이터 없음')

        except urllib.error.HTTPError as e:
            print(f'  ❌ {st.name[:22]:<22} → HTTP {e.code}')
            if e.code == 400:
                print('     API 키 또는 statId 오류일 수 있습니다.')
        except Exception as e:
            print(f'  ❌ {st.name[:22]:<22} → {e}')
        time.sleep(0.2)

    if api_ok == 0:
        print('\n  ❌ API 호출이 전부 실패했습니다. API 키를 확인하세요.')
        return

    # ── STEP 4: poll_charger_status 커맨드 실행 (5개만) ─────
    print('\n[4/5] poll_charger_status 커맨드 실행 (5개 테스트)...')
    try:
        from django.core.management import call_command
        from io import StringIO
        out = StringIO()
        call_command('poll_charger_status', api_key=api_key, limit=5, verbose=True, stdout=out)
        output = out.getvalue()
        print(output)
    except Exception as e:
        print(f'  ❌ 커맨드 실행 오류: {e}')
        print('     → management/commands/poll_charger_status.py 파일 위치를 확인하세요.')
        return

    # ── STEP 5: 결과 확인 ────────────────────────────────────
    print('\n[5/5] 폴링 결과 확인...')
    from chargeflow.models import ChargerStatusLog, StationCongestion
    from django.utils import timezone
    from datetime import timedelta

    recent_logs = ChargerStatusLog.objects.filter(
        checked_at__gte=timezone.now() - timedelta(minutes=5)
    ).count()
    cong_updated = StationCongestion.objects.filter(
        updated_at__gte=timezone.now() - timedelta(minutes=5)
    ).count()

    print(f'  ✅ 최근 5분 내 상태 로그 : {recent_logs}개')
    print(f'  ✅ 최근 5분 내 혼잡도 갱신: {cong_updated}개')

    # 혼잡도 분포 출력
    from django.db.models import Count
    dist = StationCongestion.objects.values('level').annotate(cnt=Count('id'))
    if dist:
        print('\n  혼잡도 분포:')
        label_map = {'smooth':'원활','normal':'보통','busy':'혼잡','jammed':'매우혼잡'}
        for d in dist:
            print(f'    {label_map.get(d["level"], d["level"]):<8} : {d["cnt"]}개')

    suspicious = StationCongestion.objects.filter(is_suspicious=True).count()
    if suspicious:
        print(f'\n  ⚠️  의심 충전소 (잦은 상태변동): {suspicious}개')
    else:
        print(f'\n  ✅ 의심 충전소 없음 (정상 운영 중)')

    print('\n' + '═'*60)
    print('  ✅ 진단 완료! 폴링이 정상 동작하고 있습니다.')
    print('═'*60 + '\n')


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description='충전기 상태 폴링 진단')
    parser.add_argument('--api-key', required=True, help='공공데이터포털 인증키')
    args = parser.parse_args()
    check(args.api_key)
