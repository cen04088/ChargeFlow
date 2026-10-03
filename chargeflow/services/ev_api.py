"""
한국환경공단 전기자동차 충전소 API 클라이언트
====================================================================
- getChargerStatus: 최근 `period`분(1~10) 안에 상태가 바뀐 충전기만 전국 단위로
  돌려준다. statId 필터가 없으므로 받아온 뒤 우리가 추적하는 statId만 골라 쓴다.
  statUpdDt는 상태가 그대로여도 단말이 보고할 때마다 갱신되므로 10분 범위면
  전국 1만 5천 건 안팎이 온다(2026-10 실측).
- getChargerInfo:   충전기 정보 + 현재 상태. kindDetail(C001=고속도로 휴게소)와
  statId 필터를 지원한다. 폴링 공백 뒤 전체 상태를 다시 맞추는 기준선 동기화에 쓴다.

개발계정 일일 호출 한도는 1,000건이라, 휴게소마다 호출하지 않고 주기당 한두 번만
호출하도록 설계했다.
"""
import json
import logging
import urllib.parse
import urllib.request
from datetime import datetime
from zoneinfo import ZoneInfo

logger = logging.getLogger(__name__)

BASE_URL  = 'https://apis.data.go.kr/B552584/EvCharger'
PAGE_SIZE = 9999
KST       = ZoneInfo('Asia/Seoul')

KIND_HIGHWAY_REST_AREA = 'C001'  # 고속도로 휴게소 (전국 약 2천 대, 1페이지)


class EvApiError(Exception):
    pass


def _get(operation, api_key, params, timeout=30):
    query = urllib.parse.urlencode({
        'serviceKey': api_key,
        'dataType':   'JSON',
        **params,
    })
    req = urllib.request.Request(
        f'{BASE_URL}/{operation}?{query}',
        headers={'Accept': 'application/json'},
    )
    try:
        with urllib.request.urlopen(req, timeout=timeout) as res:
            raw = res.read().decode('utf-8')
    except Exception as e:
        raise EvApiError(f'{operation} 요청 실패: {e}') from e

    try:
        data = json.loads(raw)
    except ValueError as e:
        # 키 오류·한도 초과 시 XML 에러 본문이 온다
        raise EvApiError(f'{operation} 응답이 JSON이 아님: {raw[:200]}') from e

    body = data.get('body') or data
    result_code = str(body.get('resultCode') or data.get('resultCode') or '00')
    if result_code not in ('00', '0'):
        raise EvApiError(f'{operation} 오류 {result_code}: {body.get("resultMsg") or data.get("resultMsg")}')

    items = body.get('items') or {}
    if isinstance(items, dict):
        items = items.get('item') or []
    if isinstance(items, dict):
        items = [items]
    total = int(body.get('totalCount') or data.get('totalCount') or 0)
    return items or [], total


def _paginate(operation, api_key, params, max_pages):
    page, fetched = 1, 0
    while page <= max_pages:
        items, total = _get(operation, api_key, {**params, 'pageNo': page, 'numOfRows': PAGE_SIZE})
        yield from items
        fetched += len(items)
        if not items or fetched >= total:
            return
        page += 1
    logger.warning('[ev_api] %s %s: %d페이지 상한에 도달해 중단', operation, params, max_pages)


def fetch_status_changes(api_key, period, max_pages=5):
    """최근 period분(1~10) 안에 상태를 보고한 충전기 (전국)"""
    return _paginate('getChargerStatus', api_key, {'period': period}, max_pages)


def fetch_rest_area_chargers(api_key, max_pages=3):
    """전국 고속도로 휴게소 충전기 정보 (현재 상태 포함)"""
    return _paginate('getChargerInfo', api_key, {'kindDetail': KIND_HIGHWAY_REST_AREA}, max_pages)


def fetch_station(api_key, stat_id):
    """충전소 하나의 충전기 정보 (휴게소 분류가 아닌 충전소 보충용)"""
    return _paginate('getChargerInfo', api_key, {'statId': stat_id}, 1)


def parse_stat_updated(value):
    """statUpdDt('YYYYMMDDHHMMSS', KST) → aware datetime"""
    if not value:
        return None
    try:
        return datetime.strptime(str(value).strip()[:14], '%Y%m%d%H%M%S').replace(tzinfo=KST)
    except ValueError:
        return None


# chgerType → 커넥터 (02 AC완속은 고속도로 우회 충전에 의미가 없어 제외)
CHGER_TYPE_CONNECTORS = {
    '01': {'chademo'},
    '03': {'chademo', 'ac3'},
    '04': {'combo'},
    '05': {'chademo', 'combo'},
    '06': {'chademo', 'ac3', 'combo'},
    '07': {'ac3'},
    '08': {'combo'},
    '09': {'nacs'},
    '10': {'combo', 'nacs'},
}
CONNECTOR_ORDER = ['combo', 'chademo', 'ac3', 'nacs']


def connectors_for(chger_types):
    found = set()
    for t in chger_types:
        found |= CHGER_TYPE_CONNECTORS.get(str(t).strip(), set())
    return ','.join(c for c in CONNECTOR_ORDER if c in found)
