"""
사용자 식별 유틸
====================================
앱인토스(App in Toss) WebView 브릿지가 `X-Toss-User-Key` 헤더를 실어 보내면
그 값을 사용자 키로 쓰고, 아직 브릿지가 없거나(일반 브라우저 테스트) 헤더가
없으면 서버가 발급하는 익명 쿠키(cf_uid)로 폴백한다.

이 앱은 Django 세션 인증을 쓰지 않으므로(REST_FRAMEWORK에 커스텀 인증 클래스
없음, DEFAULT_PERMISSION_CLASSES=AllowAny) 이 쿠키는 DRF의 CSRF 검사 대상이
아니다.
"""
import uuid

from rest_framework.views import APIView

USER_KEY_HEADER = 'X-Toss-User-Key'
USER_KEY_COOKIE = 'cf_uid'
COOKIE_MAX_AGE  = 60 * 60 * 24 * 365 * 2  # 2년


def resolve_user_key(request):
    """(user_key, newly_issued_key_or_None) 튜플을 반환한다."""
    header_key = request.headers.get(USER_KEY_HEADER)
    if header_key:
        return header_key, None

    cookie_key = request.COOKIES.get(USER_KEY_COOKIE)
    if cookie_key:
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
