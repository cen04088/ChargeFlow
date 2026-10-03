"""
앱인토스 메시지 발송 API 연동 (혼잡 해소 알림)
====================================================================
POST https://apps-in-toss-api.toss.im/api-partner/v1/apps-in-toss/messenger/send-message
  - 인증: mTLS (콘솔에서 발급한 클라이언트 인증서). Bearer 토큰 방식이 아니다.
  - 수신자: 헤더 x-anon-key (SDK getAnonymousKey의 hash) 또는 x-toss-user-key
  - 본문:   {"templateSetCode": "...", "context": {...}}
  - 비즈니스 오류도 HTTP 200 + resultType=FAIL로 오므로 resultType을 확인한다.
  - 한도: 사용자당 분당 10회, 앱당 분당 15,000회

필요한 환경 변수 (하나라도 없으면 발송을 건너뛰고 로그만 남긴다):
  TOSS_MTLS_CERT / TOSS_MTLS_KEY   PEM 내용 그대로, 또는 PEM 파일 경로
  TOSS_TEMPLATE_CONGESTION_CLEARED 혼잡 해소 알림 템플릿 코드 (변수: restAreaName)
  TOSS_TEMPLATE_FAVORITE_STATUS    즐겨찾기 상태 알림 템플릿 코드 (변수: restAreaName, statusLabel)
"""
import json
import logging
import os
import ssl
import tempfile
import urllib.error
import urllib.request

logger = logging.getLogger(__name__)

SEND_MESSAGE_URL = 'https://apps-in-toss-api.toss.im/api-partner/v1/apps-in-toss/messenger/send-message'

_ssl_context = None


def _pem_path(value, suffix):
    """환경 변수 값이 PEM 본문이면 임시 파일로 써서 경로를 돌려준다(Railway용)."""
    if value.lstrip().startswith('-----BEGIN'):
        f = tempfile.NamedTemporaryFile('w', suffix=suffix, delete=False)
        f.write(value.replace('\\n', '\n'))
        f.close()
        os.chmod(f.name, 0o600)
        return f.name
    return value


def _get_ssl_context():
    global _ssl_context
    if _ssl_context is None:
        cert = os.getenv('TOSS_MTLS_CERT', '')
        key  = os.getenv('TOSS_MTLS_KEY', '')
        if not cert or not key:
            return None
        ctx = ssl.create_default_context()
        ctx.load_cert_chain(_pem_path(cert, '.crt'), _pem_path(key, '.key'))
        _ssl_context = ctx
    return _ssl_context


def is_configured(template_env='TOSS_TEMPLATE_CONGESTION_CLEARED'):
    return bool(os.getenv('TOSS_MTLS_CERT') and os.getenv('TOSS_MTLS_KEY') and os.getenv(template_env))


def recipient_header(user_key):
    """저장된 user_key → 발송 헤더. 웹 쿠키 사용자(anon_)는 토스로 보낼 수 없다."""
    from chargeflow.user_identity import TOSS_ANON_PREFIX, TOSS_USER_PREFIX
    if user_key.startswith(TOSS_ANON_PREFIX):
        return {'x-anon-key': user_key[len(TOSS_ANON_PREFIX):]}
    if user_key.startswith(TOSS_USER_PREFIX):
        return {'x-toss-user-key': user_key[len(TOSS_USER_PREFIX):]}
    return None


def _send(user_key, template_env, context, what):
    template = os.getenv(template_env)
    header   = recipient_header(user_key)
    if header is None:
        return False
    if not is_configured(template_env):
        logger.info('[toss_notify] mTLS 인증서/템플릿(%s) 미설정 — 발송 생략 (%s)', template_env, what)
        return False

    payload = json.dumps({'templateSetCode': template, 'context': context}).encode('utf-8')
    req = urllib.request.Request(
        SEND_MESSAGE_URL, data=payload, method='POST',
        headers={'Content-Type': 'application/json', **header},
    )
    try:
        with urllib.request.urlopen(req, timeout=5, context=_get_ssl_context()) as res:
            body = json.loads(res.read().decode('utf-8') or '{}')
    except urllib.error.HTTPError as e:
        logger.warning('[toss_notify] HTTP %s (%s): %s', e.code, what, e.read()[:300])
        return False
    except Exception:
        logger.exception('[toss_notify] 발송 중 오류 (%s)', what)
        return False

    if body.get('resultType') != 'SUCCESS':
        err = body.get('error') or {}
        logger.warning('[toss_notify] 발송 실패 %s %s (%s)', err.get('errorCode'), err.get('reason'), what)
        return False
    return True


def send_congestion_cleared_message(user_key, ra_node):
    """혼잡이 풀린 휴게소를 구독자에게 알린다. 보냈으면 True."""
    return _send(user_key, 'TOSS_TEMPLATE_CONGESTION_CLEARED',
                 {'restAreaName': ra_node.name}, ra_node.name)


def send_favorite_status_message(user_key, ra_node, status_label):
    """즐겨찾기 휴게소의 상태가 바뀌었음을 알린다. 보냈으면 True."""
    return _send(user_key, 'TOSS_TEMPLATE_FAVORITE_STATUS',
                 {'restAreaName': ra_node.name, 'statusLabel': status_label}, ra_node.name)
