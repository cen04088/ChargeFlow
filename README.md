# ⚡ ChargeFlow — 고속도로 충전 도우미

**앱인토스(App in Toss)**에서 서비스 중인 전기차 운전자를 위한 고속도로 급속충전소 혼잡도 안내 미니앱입니다.

휴게소의 급속충전기가 모두 사용 중일 때, 무작정 기다리지 않고 **이전/다음 IC 인근의 대체 충전소(마트·주유소·호텔·공공기관 등)**로 우회할 수 있도록 실시간 혼잡도와 소요 시간을 안내합니다.

---

## 🚗 문제 정의

고속도로 휴게소 급속충전기는 대수가 적어 성수기·주말에 대기줄이 길게 늘어섭니다. 하지만 운전자는 현재 휴게소가 얼마나 혼잡한지, 대안이 있는지 알 방법이 없습니다. ChargeFlow는 **환경부 전기차 충전소 실시간 상태 데이터를 지속적으로 폴링해 혼잡도를 추정**하고, 혼잡할 경우 인근 IC 주변의 대체 충전소로 우회 경로를 제안합니다.

---

## ✨ 주요 기능

### 1. 실시간 혼잡도 안내
- 각 휴게소 충전기의 상태를 주기적으로 폴링(`poll_charger_status`)해 최근 10분간 상태 변화 이력을 분석
- 충전기 상태가 짧은 시간 내 여러 번 바뀌면 "의심(대기줄로 인한 사용 반복)"으로 판단해 혼잡도(원활/보통/혼잡/정체)를 산출

### 2. 우회 충전소 추천 (핵심 기능)
- 혼잡한 휴게소 기준으로 이전/다음 IC 인근의 대체 충전소를 검색
- Kakao Mobility Directions API로 실제 도로 기준 이동 거리·시간을 계산해 N분 이내 도달 가능한 곳만 추천

### 3. 노선/휴게소 탐색
- 경부·영동·서해안 고속도로의 IC/휴게소 순서를 지도에 시각화 (Kakao Maps)
- 현재 위치 기준 "가장 가까운 휴게소" 원탭 조회

### 4. 즐겨찾기 & 알림 구독
- 자주 이용하는 노선/휴게소를 저장(쿠키 기반 익명 사용자 식별)
- 혼잡이 해소되면 토스 파트너 메신저 API로 알림을 보내는 구독 기능

### 5. 앱인토스 연동
- `X-Toss-User-Key` 헤더로 토스 사용자 식별, 웹 접근 시 쿠키 기반 익명 식별로 폴백

---

## 🛠️ 기술 스택

| 영역 | 기술 |
|---|---|
| Backend | Python, Django 4.2, Django REST Framework |
| DB | SQLite(dev) / PostgreSQL(prod, `dj-database-url`) |
| 거리/경로 계산 | Haversine 직선거리 + Kakao Mobility Directions API |
| 지도/장소 검색 | Kakao Maps JS SDK, Kakao Local Search API |
| 외부 데이터 | 공공데이터포털 환경부 전기차 충전소 API (실시간 상태 폴링) |
| 알림 연동 | 토스 파트너 메신저 API |
| 배포 | Railway (Procfile + Gunicorn), Whitenoise |
| 플랫폼 | 앱인토스(App in Toss) 미니앱 |

---

## 📁 프로젝트 구조

```
chargeflow/
├── config/                     # Django 프로젝트 설정
├── chargeflow/                  # 메인 Django 앱
│   ├── models.py                 # Highway, HighwayNode, ChargingStation, ChargerStatusLog, StationCongestion 등
│   ├── views.py                   # 노선/혼잡도/우회 추천/즐겨찾기 API
│   ├── user_identity.py           # 토스 사용자 키 / 익명 쿠키 식별
│   ├── services/toss_notify.py     # 토스 파트너 메신저 알림 클라이언트
│   └── management/commands/        # load_highway_nodes, poll_charger_status 등 배치 명령어
├── scripts/                     # 데이터 수집·좌표 보정 등 1회성 파이프라인 스크립트
├── templates/index.html          # Kakao Maps 기반 SPA 프론트엔드
└── chargeflow_data.json          # IC/휴게소/충전소 시드 데이터 (loaddata fixture)
```

---

## 🚀 로컬 실행

```bash
git clone https://github.com/cen04088/chargeflow.git
cd chargeflow
python -m venv venv && venv\Scripts\activate
pip install -r requirements.txt

python manage.py migrate
python manage.py loaddata chargeflow_data.json
python manage.py runserver
```

필요한 환경 변수 (`.env` 생성 후 입력):

```ini
SECRET_KEY=your_django_secret_key
DEBUG=True
KAKAO_API_KEY=your_kakao_rest_api_key
KAKAO_JS_KEY=your_kakao_javascript_key
PUBLIC_DATA_API_KEY=your_data_go_kr_service_key   # 환경부 전기차 충전소 API
TOSS_PARTNER_API_KEY=your_toss_partner_key         # 알림 기능(선택)
```

실시간 충전기 상태 폴링(선택, data.go.kr 키 필요):
```bash
python manage.py poll_charger_status
```

---

## ☁️ 배포

- **플랫폼:** Railway (`Procfile`: migrate → collectstatic → loaddata → gunicorn)
- **서비스 채널:** 앱인토스(App in Toss) 미니앱 "ChargeFlow"
