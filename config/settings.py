from pathlib import Path
import os
import dj_database_url

BASE_DIR = Path(__file__).resolve().parent.parent

# ── 보안 ──────────────────────────────────────────────────
SECRET_KEY = os.getenv('SECRET_KEY', 'django-insecure-chargeflow-change-this-in-production')
DEBUG      = os.getenv('DEBUG', 'False') == 'True'
ALLOWED_HOSTS = ['*']

# ── 앱 ────────────────────────────────────────────────────
INSTALLED_APPS = [
    'django.contrib.admin',
    'django.contrib.auth',
    'django.contrib.contenttypes',
    'django.contrib.sessions',
    'django.contrib.messages',
    'django.contrib.staticfiles',
    'rest_framework',
    'corsheaders',
    'chargeflow',
]

# ── 미들웨어 ───────────────────────────────────────────────
MIDDLEWARE = [
    'corsheaders.middleware.CorsMiddleware',           # 반드시 최상단
    'django.middleware.security.SecurityMiddleware',
    'whitenoise.middleware.WhiteNoiseMiddleware',       # 정적 파일
    'django.contrib.sessions.middleware.SessionMiddleware',
    'django.middleware.common.CommonMiddleware',
    'django.middleware.csrf.CsrfViewMiddleware',
    'django.contrib.auth.middleware.AuthenticationMiddleware',
    'django.contrib.messages.middleware.MessageMiddleware',
    'django.middleware.clickjacking.XFrameOptionsMiddleware',
]

ROOT_URLCONF     = 'config.urls'
WSGI_APPLICATION = 'config.wsgi.application'

# ── 템플릿 ─────────────────────────────────────────────────
TEMPLATES = [
    {
        'BACKEND': 'django.template.backends.django.DjangoTemplates',
        'DIRS': [os.path.join(BASE_DIR, 'templates')],
        'APP_DIRS': True,
        'OPTIONS': {
            'context_processors': [
                'django.template.context_processors.debug',
                'django.template.context_processors.request',
                'django.contrib.auth.context_processors.auth',
                'django.contrib.messages.context_processors.messages',
                'chargeflow.context_processors.analytics_keys',
            ],
        },
    },
]

# ── 데이터베이스 ───────────────────────────────────────────
# Railway PostgreSQL 환경변수(DATABASE_URL)가 있으면 사용, 없으면 SQLite
DATABASES = {
    'default': dj_database_url.config(
        default=f'sqlite:///{BASE_DIR}/db.sqlite3',
        conn_max_age=600,
    )
}

# ── 비밀번호 검증 ──────────────────────────────────────────
AUTH_PASSWORD_VALIDATORS = [
    {'NAME': 'django.contrib.auth.password_validation.UserAttributeSimilarityValidator'},
    {'NAME': 'django.contrib.auth.password_validation.MinimumLengthValidator'},
    {'NAME': 'django.contrib.auth.password_validation.CommonPasswordValidator'},
    {'NAME': 'django.contrib.auth.password_validation.NumericPasswordValidator'},
]

# ── 국제화 ─────────────────────────────────────────────────
LANGUAGE_CODE = 'ko-kr'
TIME_ZONE     = 'Asia/Seoul'
USE_I18N      = True
USE_TZ        = True

# ── 정적 파일 ──────────────────────────────────────────────
STATIC_URL   = '/static/'
STATIC_ROOT  = os.path.join(BASE_DIR, 'staticfiles')
STATICFILES_STORAGE = 'whitenoise.storage.CompressedManifestStaticFilesStorage'

DEFAULT_AUTO_FIELD = 'django.db.models.BigAutoField'

# ── CSRF ──────────────────────────────────────────────────
CSRF_TRUSTED_ORIGINS = [
    'https://chargeflow-production.up.railway.app',
    'http://localhost:8000',
]

# ── CORS ──────────────────────────────────────────────────
# 앱인토스 번들은 https://<appName>.apps.tossmini.com (실서비스),
# https://<appName>.private-apps.tossmini.com (콘솔 QR 테스트)에서 호출한다.
# TOSS_APP_NAME이 없으면 기존 동작(모든 Origin 허용)을 유지한다.
from corsheaders.defaults import default_headers  # noqa: E402

TOSS_APP_NAME = os.getenv('TOSS_APP_NAME', '')
if TOSS_APP_NAME:
    CORS_ALLOW_ALL_ORIGINS = False
    # SDK 버전에 따라 출처가 다르다: 1.x·2.x·3.1.1+ → apps, 3.0.0~3.1.1 미만 → web
    CORS_ALLOWED_ORIGINS = [
        f'https://{TOSS_APP_NAME}.apps.tossmini.com',
        f'https://{TOSS_APP_NAME}.private-apps.tossmini.com',
        f'https://{TOSS_APP_NAME}.web.tossmini.com',
        f'https://{TOSS_APP_NAME}.private-web.tossmini.com',
        *[o for o in os.getenv('CORS_EXTRA_ORIGINS', '').split(',') if o],
    ]
    if DEBUG:
        CORS_ALLOWED_ORIGINS += ['http://localhost:5173', 'http://127.0.0.1:5173']
else:
    CORS_ALLOW_ALL_ORIGINS = True
CORS_ALLOW_HEADERS = (*default_headers, 'x-anon-key', 'x-toss-user-key')

# ── DRF ───────────────────────────────────────────────────
REST_FRAMEWORK = {
    'DEFAULT_RENDERER_CLASSES': [
        'rest_framework.renderers.JSONRenderer',
    ],
    'DEFAULT_PERMISSION_CLASSES': [
        'rest_framework.permissions.AllowAny',
    ],
}

KAKAO_API_KEY = os.getenv('KAKAO_API_KEY', '')   # REST API 키 (로컬 검색용)
KAKAO_JS_KEY  = os.getenv('KAKAO_JS_KEY', '')    # JavaScript 키 (지도 SDK용)


GA_MEASUREMENT_ID = os.environ.get('GA_MEASUREMENT_ID', '')
AMPLITUDE_API_KEY = os.environ.get('AMPLITUDE_API_KEY', '')

STATICFILES_DIRS = [BASE_DIR / 'static']

LOGGING = {
    'version': 1,
    'disable_existing_loggers': False,
    'handlers': {'console': {'class': 'logging.StreamHandler'}},
    'root': {'handlers': ['console'], 'level': 'INFO'},
}