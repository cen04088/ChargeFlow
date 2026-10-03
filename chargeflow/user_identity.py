"""
사용자 식별 유틸
====================================
앱인토스 미니앱은 SDK getAnonymousKey()로 받은 미니앱 전용 식별키(hash)를
`X-Anon-Key` 헤더로 보낸다. 기기를 바꿔도 같은 사용자면 같은 값이라 즐겨찾기·
최근 기록이 유지되고, 혼잡 해소 알림도 이 키로 보낼 수 있다.

헤더가 없으면(일반 브라우저 개발 환경) 서버가 발급하는 익명 쿠키(cf_uid)로
폴백한다. 저장할 때는 출처를 접두사로 구분한다.

이 앱은 Django 세션 인증을 쓰지 않으므로(DEFAULT_PERMISSION_CLASSES=AllowAny)
이 쿠키는 DRF의 CSRF 검사 대상이 아니다.
"""
import uuid

from rest_framework.views import APIView

ANON_KEY_HEADER  = 'X-Anon-Key'
USER_KEY_HEADER  = 'X-Toss-User-Key'
USER_KEY_COOKIE  = 'cf_uid'
COOKIE_MAX_AGE   = 60 * 60 * 24 * 365 * 2  # 2년

TOSS_ANON_PREFIX = 'ait:'   # getAnonymousKey hash
TOSS_USER_PREFIX = 'tsu:'   # 토스 로그인 userKey (현재 미사용, 확장 대비)
MAX_KEY_LENGTH   = 128      # UserRoute.user_key 등 컬럼 길이


def _valid(value):
    return bool(value) and len(value) <= MAX_KEY_LENGTH


def resolve_user_key(request):
    """(user_key, newly_issued_cookie_or_None) 튜플을 반환한다."""
    anon_key = (request.headers.get(ANON_KEY_HEADER) or '').strip()
    if anon_key and _valid(TOSS_ANON_PREFIX + anon_key):
        return TOSS_ANON_PREFIX + anon_key, None

    user_key = (request.headers.get(USER_KEY_HEADER) or '').strip()
    if user_key and _valid(TOSS_USER_PREFIX + user_key):
        return TOSS_USER_PREFIX + user_key, None

    cookie_key = request.COOKIES.get(USER_KEY_COOKIE)
    if _valid(cookie_key):
        return cookie_key, None

    new_key = f'anon_{uuid.uuid4().hex}'
    return new_key, new_key


class UserScopedAPIView(APIView):
    """요청마다 self.user_key를 채워주고, 신규 발급된 익명 키가 있으면
    응답에 쿠키를 심어주는 공용 베이스 클래스."""

    _new_cookie_value = None

    def initial(self, request, *args, **kwargs):
        super().initial(request, *args, **kwargs)
        self.user_key, self._new_cookie_value = resolve_user_key(request)

    def finalize_response(self, request, response, *args, **kwargs):
        response = super().finalize_response(request, response, *args, **kwargs)
        if self._new_cookie_value:
            response.set_cookie(
                USER_KEY_COOKIE,
                self._new_cookie_value,
                max_age=COOKIE_MAX_AGE,
                httponly=True,
                samesite='Lax',
            )
        return response
