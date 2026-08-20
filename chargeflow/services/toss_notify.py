"""
Toss 파트너 메신저 API 연동 (혼잡 해소 알림) — 메커니즘만 구축
====================================================================
실제 발송을 켜려면 앱인토스 콘솔에서:
  1) 파트너 API 자격증명을 발급받아 TOSS_PARTNER_API_KEY 환경변수로 설정
  2) 메시지 템플릿을 등록/검수 승인받아 그 템플릿 코드를 TOSS_TEMPLATE_CONGESTION_CLEARED
     환경변수로 설정
두 값 중 하나라도 없으면 조용히 no-op(로그만 남김) — 자격증명이 없는 로컬/개발
환경에서도 폴링 커맨드가 깨지지 않는다.

엔드포인트/요청 형식은 앱인토스 개발자센터 문서(단일 발송 API,
/api-partner/v1/apps-in-toss/messenger/send-message, 분당 10회 제한) 기준.
실제 요청 바디 스키마는 템플릿 등록 후 콘솔에서 최종 확인이 필요하다.
"""
import json
import logging
import os
import urllib.request

logger = logging.getLogger(__name__)

SEND_MESSAGE_URL = 'https://apis-partner.toss.im/api-partner/v1/apps-in-toss/messenger/send-message'


def send_congestion_cleared_message(user_key: str, ra_node) -> bool:
    """혼잡이 해소된 휴게소에 대해 구독자에게 알림을 보낸다.
    자격증명/템플릿이 준비되지 않았으면 False를 반환하고 발송을 건너뛴다."""
    api_key       = os.getenv('TOSS_PARTNER_API_KEY')
    template_code = os.getenv('TOSS_TEMPLATE_CONGESTION_CLEARED')

    if not api_key or not template_code:
        logger.info(
            '[toss_notify] 자격증명/템플릿 미설정 — 알림 스킵 (%s → %s)',
            ra_node.name, user_key,
        )
        return False

    payload = json.dumps({
        'templateCode': template_code,
        'variables': {'restAreaName': ra_node.name},
    }).encode('utf-8')

    req = urllib.request.Request(
        SEND_MESSAGE_URL,
        data=payload,
        method='POST',
        headers={
            'Content-Type':    'application/json',
            'Authorization':   f'Bearer {api_key}',
            'x-toss-user-key': user_key,
        },
    )
    try:
        with urllib.request.urlopen(req, timeout=5) as res:
            ok = 200 <= res.status < 300
            if not ok:
                logger.warning('[toss_notify] 발송 실패 status=%s (%s)', res.status, ra_node.name)
            return ok
    except Exception:
        logger.exception('[toss_notify] 발송 중 오류 (%s → %s)', ra_node.name, user_key)
        return False
