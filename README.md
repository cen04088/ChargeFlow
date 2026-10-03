# ⚡ ChargeFlow — 고속도로 충전 도우미

**앱인토스(App in Toss)**에서 서비스 중인 전기차 운전자를 위한 고속도로 급속충전소 혼잡도 안내 미니앱입니다.

휴게소의 급속충전기가 모두 사용 중일 때, 무작정 기다리지 않고 **이전/다음 IC 인근의 대체 충전소**로 우회할지 판단할 수 있도록 실시간 혼잡도·예상 대기 시간·우회 추가 시간을 안내합니다.

---

## ✨ 주요 기능

| 기능 | 내용 |
|---|---|
| 실시간 혼잡도 | 휴게소 충전기의 빈 충전기 비율로 여유/보통/혼잡/만석/이용 불가 판정. 30분 넘게 갱신이 없으면 "정보 없음" |
| 기다릴까, 우회할까 | 만석이면 충전 시작 시각과 휴게소 40분 제한으로 예상 대기 시간을 추정하고, 우회 충전소의 추가 시간(IC 왕복+진출입)과 비교 |
| 우회 충전소 실시간 | IC 근처 대체 충전소에도 빈 충전기 수를 표시 (환경부 실시간 상태) |
| 내 차 커넥터 | DC콤보·차데모·AC3상·NACS 중 고르면 맞는 충전소만 표시 |
| 가는 방향 휴게소 | 위치를 두 번 재서 진행 방향을 구하고, 앞으로 지날 같은 방향 휴게소만 거리순 표시 |
| 혼잡 패턴·예측 | 요일·시간대별 혼잡 이력을 쌓아 평소 패턴과 1·2시간 뒤 혼잡 가능성(통계 예측) 표시 |
| 구간 모드 | 출발·도착을 고르면 지날 휴게소와 도착 무렵 혼잡 예측을 순서대로 표시 |
| 알림 | 빈자리 알림(1회성, 6시간 유효), 즐겨찾기 휴게소 상태 알림(혼잡해질 때·풀릴 때, 2시간 간격) |
| 노선 | 경부·서해안·영동 + 중부·통영대전, 호남, 남해, 중부내륙, 중앙, 서울양양, 광주대구, 평택제천, 순천완주 (12개) |

---

## 🛠️ 구조

```
chargeflow/
├── config/                         # Django 설정 (CORS: TOSS_APP_NAME 기준 tossmini 도메인)
├── chargeflow/
│   ├── models.py                   # 노선·노드·충전소 / 충전기 상태·혼잡도·혼잡 패턴 / 사용자 설정·즐겨찾기·알림
│   ├── views.py                    # REST API (/api/v1/...)
│   ├── services/
│   │   ├── ev_api.py               # 환경부 충전기 API 클라이언트
│   │   ├── congestion.py           # 혼잡도 계산, 패턴 기록·예측, 대기 추정
│   │   └── toss_notify.py          # 앱인토스 메시지 발송 (mTLS)
│   └── management/commands/
│       ├── poll_charger_status.py  # 상태 폴링 워커 (Procfile worker)
│       └── build_catalog.py        # 신규 노선 구축 + 충전소 정보 보강 (로컬에서 실행 후 fixture 갱신)
├── frontend/                       # 앱인토스 미니앱 (React + TDS + @apps-in-toss/web-framework)
├── templates/index.html            # 구버전 화면 (새 번들 출시 전까지 유지)
└── chargeflow_data.json            # 노선·노드·충전소 fixture (배포 때마다 loaddata)
```

### 충전기 상태 폴링
- 증분: `getChargerStatus(period=주기+1분)`로 최근 상태를 보고한 전국 충전기를 받아 추적 중인 충전소만 반영 (주기당 1회 내외)
- 기준선: 처음 실행·폴링 공백·24시간 경과 시 `getChargerInfo(kindDetail=C001)` 1회 + 빠진 휴게소 충전소만 statId로 보충
- 호출량(5분 간격): 하루 약 300회 + 기준선 30회 이내 → 공공데이터 개발계정 한도(1,000회/일) 안

---

## 🚀 로컬 실행

```bash
python -m venv .venv && .venv\Scripts\activate
pip install -r requirements.txt
python manage.py migrate
python manage.py loaddata chargeflow_data.json
python manage.py runserver 8000

# 실시간 상태 (PUBLIC_DATA_API_KEY 필요)
python manage.py poll_charger_status            # 1회
python manage.py poll_charger_status --loop     # 상주

# 프론트 (브라우저 개발: devtools가 앱인토스 SDK를 mock)
cd frontend
echo VITE_API_BASE_URL=http://localhost:8000 > .env.development.local
npm install && npm run dev
npm run build                                   # frontend.ait 생성
```

테스트: `python manage.py test chargeflow`

환경 변수는 [.env.example](.env.example)을 참고하세요.

---

## ☁️ 배포 (Railway)

- `web`: migrate → collectstatic → loaddata → gunicorn
- `chargeflow-cron` 서비스: 크론 `*/5 * * * *`, 시작 명령 `python manage.py poll_charger_status --period 10`
  (상주 워커를 쓰는 환경이면 `poll_charger_status --loop`)
- 두 서비스 모두 `PUBLIC_DATA_API_KEY`, `DATABASE_URL`이 필요하고, web에는 `TOSS_APP_NAME`(CORS)을 설정
- 알림 발송은 `TOSS_MTLS_CERT`·`TOSS_MTLS_KEY`와 콘솔에서 승인된 템플릿 코드가 있을 때만 동작

### 노선·충전소 데이터 갱신
`build_catalog`는 로컬에서 실행하고 결과를 fixture로 저장해 배포합니다. 이미 배포된 노선은 `--rebuild` 없이 다시 만들지 않습니다(노드 id가 바뀌면 즐겨찾기가 끊기기 때문).

```bash
python manage.py build_catalog                  # 전국 충전기 스캔(약 60회 호출) 포함
python manage.py dumpdata chargeflow.highway chargeflow.highwaynode chargeflow.chargingstation \
  chargeflow.nodestationmapping chargeflow.highwaynodecharger --indent 2 -o chargeflow_data.json
```
