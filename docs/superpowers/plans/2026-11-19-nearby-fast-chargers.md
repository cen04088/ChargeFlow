# 내 주변 빈 급속충전소 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 앱을 열면 내 위치 지도와 주변 급속충전소(50kW 이상)의 지금 빈 대수가 바로 보이는 새 홈을 만들고, 기존 고속도로 기능은 `/highways`로 옮겨 그대로 둔다.

**Architecture:** 전국 급속 충전소는 새 테이블 `PublicStation`(statId 고유)에 하루 1회 전국 스캔으로 채우고, 충전기 상태는 기존 `ChargerState`에 `output_kw`를 더해 같이 쓴다. 기존 폴러는 추적 대상을 넓히되 전국분은 "있는 줄만 갱신"한다. 주변 검색은 위·경도 범위 + 직선거리로 하는 `POST /api/v1/stations/nearby/`이고, 프론트는 카카오맵 + 목록의 새 `NearbyPage`가 이를 부른다.

**Tech Stack:** Django + DRF(SQLite 로컬 / Postgres 운영), React 18 + TypeScript + TDS(`@toss/tds-mobile`), `@apps-in-toss/web-framework`, 카카오맵 JS SDK, 프론트 단위 테스트용 vitest(신규 dev 의존성).

**Spec:** `docs/superpowers/specs/2026-11-19-nearby-fast-chargers-design.md` — 실행자는 계획과 함께 이 문서를 읽는다.

## Global Constraints

- 급속 = 충전기 출력 `output` **50kW 이상**. 빈 대수·전체 대수는 50kW 이상 충전기만 센다.
- 주변 검색에서 제외: `limitYn=Y`, `kind=H0`, `delYn=Y`, `kindDetail=C001`, 이름에 "휴게소" 포함.
- 공공데이터 API 하루 총 호출 **800회 이하**(지금 약 450회 + 전국 스캔 약 60회). DB 볼륨 500MB, 예상 사용량이 **250MB를 넘으면 멈추고 알린다**.
- 건드리지 않는 것: `chargeflow_data.json`, `ChargingStation`, `NodeStationMapping`, `HighwayNodeCharger`, `build_catalog`의 동작, 휴게소 혼잡도 계산·알림 로직, 경로 `/highway/:code` · `/rest-area/:id` · `/trip`, `Procfile`의 `loaddata`.
- PostGIS 등 DB 확장 금지(로컬은 SQLite).
- 좌표는 서버에 저장하지 않고 로그에도 남기지 않는다. 좌표는 URL에 넣지 않는다.
- 프론트 하드 규칙(`frontend/AGENTS.md`): 본문 15px 이상, 11px 이하 금지, 터치 타깃 44px 이상, 한글 `word-break: keep-all`, 꺾쇠·화살표는 TDS 아이콘, 상단 네비 직접 그리지 않기, 이모지는 `.tf`. 이 화면 추가 기준: 충전소 이름 17px 이상, 빈 대수 20px 이상, 핀 글씨 15px 이상.
- 화면 문구는 해요체. 거리는 직선거리이며 "약"을 붙인다. 주행 시간은 보여 주지 않는다.
- 커밋 메시지 끝에 `Co-Authored-By: Claude Fable 5.2 <noreply@anthropic.com>`. 브랜치는 `feat/nearby-fast-chargers`. push·PR·배포·검수 요청·앱 정보 변경은 이용자 승인 없이 하지 않는다.
- **시작 전 확인:** 작업 트리에 이용자의 미커밋 프론트 변경이 있다(`frontend/src/components/{PatternChart,RestAreaMap,StationRow}.tsx`, `frontend/src/index.css`, `frontend/src/main.tsx`, `frontend/src/pages/{HighwayPage,HomePage,RestAreaPage}.tsx`). 되돌리거나 덮어쓰지 않는다. Task 7 전에 이용자가 이 변경을 커밋했는지 확인하고, 안 했으면 멈추고 묻는다.

## Review Focus

1. **낡은 "빈 곳"**: `stat=2`이지만 `stat_updated_at`이 기준보다 오래된 충전기 → 빈 대수에 들어가면 안 된다. (Task 5 테스트)
2. **스캔 도중 실패**: 전국 스캔이 일부 지역만 받고 끊김 → 못 받은 지역의 충전소가 비활성화되면 안 된다. (Task 3 테스트)
3. **위치 거절·실패·한국 밖 좌표**: 권한 거절, 위치 실패, 해외/0,0 좌표 → 막다른 화면 없이 지역 선택으로 간다. 서버는 400. (Task 6 테스트, Task 9 확인)
4. **느린 충전기가 섞인 충전소**: 같은 statId에 7kW와 100kW가 함께 있거나 `output_kw`가 비어 있는 줄 → 50kW 이상만 센다. (Task 5 테스트)
5. **카카오맵 로드 실패**: 지도 SDK를 못 불러옴 → 목록과 길찾기는 그대로 동작한다. (Task 9 확인)

---

## File Structure

| 파일 | 책임 |
|---|---|
| `chargeflow/models.py` (수정) | `PublicStation` 추가, `ChargerState.output_kw` 추가 |
| `chargeflow/migrations/0008_public_station.py` (생성) | 위 변경의 마이그레이션 |
| `chargeflow/services/ev_api.py` (수정) | `ZCODES`, `fetch_region_chargers` 추가 |
| `chargeflow/services/public_catalog.py` (생성) | 스캔 항목 분류 → `PublicStation`·`ChargerState` 반영, 실측 보고 |
| `chargeflow/management/commands/sync_public_stations.py` (생성) | 전국 스캔 실행 명령 |
| `chargeflow/management/commands/poll_charger_status.py` (수정) | 추적 대상 확장, 전국분은 갱신만 |
| `chargeflow/services/nearby.py` (생성) | 빈 대수 판정, 반경 확장 검색 |
| `chargeflow/views.py`, `chargeflow/urls.py` (수정) | `NearbyStationsView` |
| `chargeflow/tests.py` (수정) | 위 전부의 테스트(기존 파일에 클래스 추가) |
| `frontend/src/api/types.ts`, `client.ts` (수정) | `NearbyStation` 타입, `api.nearbyStations` |
| `frontend/src/lib/nearby.ts` + `nearby.test.ts` (생성) | 표시 규칙·지역 목록·마지막 위치 저장(순수 함수) |
| `frontend/src/components/NearbyMap.tsx` (생성) | 카카오맵, 핀, 내 위치, 지도 이동 감지 |
| `frontend/src/components/NearbySheet.tsx` (생성) | 충전소 상세 시트 + 길찾기 |
| `frontend/src/pages/NearbyPage.tsx` (생성) | 새 홈 화면과 상태 전환 |
| `frontend/src/App.tsx`, `pages/HomePage.tsx`, `index.css` (수정) | 라우팅, 고속도로 홈 이동, 스타일 |
| `README.md` (수정) | 기능·명령·크론 안내 |

---

### Task 1: 모델 — `PublicStation`, `ChargerState.output_kw`

**Files:**
- Modify: `chargeflow/models.py`
- Create: `chargeflow/migrations/0008_public_station.py` (`makemigrations --name public_station`)
- Test: `chargeflow/tests.py`

**Interfaces:**
- Produces:
  - `PublicStation` 필드: `stat_id`(CharField 20, unique), `name`(100), `address`(200, blank), `latitude`·`longitude`(Decimal 9,6), `operator`(50, blank), `open_hours`(50, blank), `connectors`(CharField 40, blank — `"combo,chademo"` 형식), `power_kw`(PositiveSmallInteger, 최대 출력), `charger_count`(PositiveSmallInteger, 50kW 이상 대수), `is_active`(Boolean, default True), `updated_at`(auto_now). `Meta.indexes = [Index(fields=['latitude', 'longitude'])]`.
  - `ChargerState.output_kw`: `PositiveSmallIntegerField(null=True, blank=True)`.

- [ ] **Step 1: 실패하는 테스트 작성** — `PublicStationModelTests(TestCase)`

```python
def test_stat_id_is_unique(self):
    PublicStation.objects.create(stat_id='ME000001', name='A', latitude=37.25, longitude=127.07, power_kw=100, charger_count=2)
    with self.assertRaises(IntegrityError):
        PublicStation.objects.create(stat_id='ME000001', name='B', latitude=37.0, longitude=127.0, power_kw=50, charger_count=1)

def test_charger_state_output_kw_defaults_to_null(self):
    row = ChargerState.objects.create(stat_id='ME000001', charger_id='01', stat='2')
    self.assertIsNone(row.output_kw)
```

- [ ] **Step 2: 실패 확인** — `python manage.py test chargeflow.tests.PublicStationModelTests` → `ImportError: cannot import name 'PublicStation'`
- [ ] **Step 3: 모델 추가 후 `python manage.py makemigrations chargeflow --name public_station`**
- [ ] **Step 4: 통과 확인** — 위 명령 PASS, 이어서 `python manage.py test chargeflow` 전체 PASS
- [ ] **Step 5: 커밋** — `feat: 전국 급속 충전소 모델(PublicStation)과 충전기 출력 필드`

---

### Task 2: 스캔 항목 분류와 반영 — `public_catalog`

**Files:**
- Create: `chargeflow/services/public_catalog.py`
- Test: `chargeflow/tests.py`

**Interfaces:**
- Consumes: Task 1의 `PublicStation`, `ChargerState.output_kw`; `ev_api.connectors_for`, `ev_api.parse_stat_updated`.
- Produces:
  - `FAST_KW = 50`
  - `output_kw(item: dict) -> int` — `output`을 정수 kW로, 비었거나 숫자가 아니면 0.
  - `is_public_fast(item: dict) -> bool` — 50kW 이상이고 Global Constraints의 제외 조건에 걸리지 않으면 True. 위·경도가 숫자가 아니거나 0이면 False.
  - `sync_items(items: Iterable[dict], now: datetime) -> set[str]` — `is_public_fast`인 항목을 statId별로 묶어 `PublicStation`을 upsert(`is_active=True`)하고, 그 충전기들의 `ChargerState`를 upsert(`stat`, `stat_updated_at`, `charging_since`, `chger_type`, `zcode`, `output_kw`)한다. 반영한 statId 집합을 돌려준다.
  - `deactivate_missing(seen: set[str]) -> int` — `seen`에 없는 활성 `PublicStation`을 `is_active=False`로. 바꾼 수를 돌려준다.

규칙:
- 충전소 필드는 그 statId의 50kW 이상 항목만으로 채운다: `power_kw` = 최댓값, `charger_count` = 개수, `connectors` = `ev_api.connectors_for(chgerType들)`, `name`/`address`/`operator`/`open_hours`/좌표 = 첫 항목(`statNm`/`addr`/`busiNm`/`useTime`/`lat`·`lng`, 길이는 모델 한도로 자른다).
- 같은 statId에 50kW 미만 충전기가 함께 있어도 그 충전기의 `ChargerState`는 만들지 않는다. 다만 **이미 있는 줄**(IC 우회 충전소로 추적 중이던 것)에는 `output_kw`만 채운다.
- `stat`이 `{'1','2','3','4','5','9'}` 밖이면 `'9'`. `charging_since`는 `stat == '3'`일 때만.
- 대량 처리: `bulk_create(update_conflicts=True, unique_fields=[...], update_fields=[...])`, 배치 2,000건.

- [ ] **Step 1: 실패하는 테스트 작성** — `PublicCatalogTests(TestCase)`, 항목 생성 도우미 `_item(**over)`(기본값: `statId='ME000001'`, `chgerId='01'`, `statNm='영통 공영주차장'`, `addr='경기 수원시'`, `lat='37.251'`, `lng='127.071'`, `output='100'`, `chgerType='04'`, `stat='2'`, `statUpdDt='20261119120000'`, `busiNm='환경부'`, `useTime='24시간 이용가능'`, `kind='A0'`, `kindDetail='A001'`, `limitYn='N'`, `delYn='N'`, `zcode='41'`)

```python
def test_is_public_fast_rules(self):
    self.assertTrue(is_public_fast(_item()))
    for over in ({'output': '7'}, {'output': ''}, {'limitYn': 'Y'}, {'kind': 'H0'}, {'delYn': 'Y'},
                 {'kindDetail': 'C001'}, {'statNm': '기흥휴게소(부산)'}, {'lat': '0'}, {'lat': 'abc'}):
        self.assertFalse(is_public_fast(_item(**over)), over)

def test_sync_creates_station_and_fast_chargers_only(self):
    seen = sync_items([_item(chgerId='01', output='100'), _item(chgerId='02', output='200', chgerType='01'),
                       _item(chgerId='03', output='7', chgerType='02')], NOW)
    st = PublicStation.objects.get(stat_id='ME000001')
    self.assertEqual(seen, {'ME000001'})
    self.assertEqual((st.power_kw, st.charger_count, st.connectors, st.is_active), (200, 2, 'combo,chademo', True))
    self.assertEqual(set(ChargerState.objects.values_list('charger_id', 'output_kw')), {('01', 100), ('02', 200)})

def test_sync_fills_output_on_existing_slow_row_without_creating_new(self):
    ChargerState.objects.create(stat_id='ME000001', charger_id='03', stat='2')
    sync_items([_item(chgerId='01'), _item(chgerId='03', output='7')], NOW)
    self.assertEqual(ChargerState.objects.get(charger_id='03').output_kw, 7)

def test_sync_is_idempotent_and_updates_status(self):
    sync_items([_item(stat='2')], NOW)
    sync_items([_item(stat='3', statUpdDt='20261119130000')], NOW)
    self.assertEqual(PublicStation.objects.count(), 1)
    self.assertEqual(ChargerState.objects.get(charger_id='01').stat, '3')

def test_deactivate_missing(self):
    sync_items([_item(), _item(statId='ME000002')], NOW)
    self.assertEqual(deactivate_missing({'ME000001'}), 1)
    self.assertFalse(PublicStation.objects.get(stat_id='ME000002').is_active)
```

- [ ] **Step 2: 실패 확인** — `python manage.py test chargeflow.tests.PublicCatalogTests` → ImportError
- [ ] **Step 3: `chargeflow/services/public_catalog.py`에 위 네 함수 구현**
- [ ] **Step 4: 통과 확인** — 같은 명령 PASS
- [ ] **Step 5: 커밋** — `feat: 전국 스캔 항목을 급속 충전소 목록으로 반영`

---

### Task 3: 전국 스캔 명령과 실측 — `sync_public_stations`

**Files:**
- Modify: `chargeflow/services/ev_api.py` (`ZCODES`, `fetch_region_chargers` 추가)
- Modify: `chargeflow/management/commands/build_catalog.py:48` (`ZCODES`를 `ev_api.ZCODES`에서 가져오게만 바꾼다. 다른 동작은 그대로)
- Modify: `chargeflow/services/public_catalog.py` (`freshness_report` 추가)
- Create: `chargeflow/management/commands/sync_public_stations.py`
- Test: `chargeflow/tests.py`

**Interfaces:**
- Consumes: Task 2의 `sync_items`, `deactivate_missing`.
- Produces:
  - `ev_api.ZCODES: list[str]` — `build_catalog.py`에 있던 17개 값 그대로.
  - `ev_api.fetch_region_chargers(api_key: str, zcode: str, max_pages: int = 40) -> Iterator[dict]` — `_paginate('getChargerInfo', api_key, {'zcode': zcode}, max_pages)`.
  - `public_catalog.freshness_report(now: datetime) -> dict` — 키: `stations`(활성 `PublicStation` 수), `chargers`(활성 충전소의 `output_kw >= 50` `ChargerState` 수), `within_30m`·`within_2h`·`within_12h`(그중 `stat_updated_at`이 각 시간 안인 비율, 0~1), `db_mb`(Postgres면 `pg_database_size(current_database())`를 MB로, 아니면 `None`).
  - 명령 `python manage.py sync_public_stations [--api-key K] [--zcodes 41 11 ...] [--report-only]`.

명령 동작:
- 지역(zcode)마다 `fetch_region_chargers`를 받아 `sync_items`에 넘기고 `seen`을 합친다.
- **모든 지역을 오류 없이 받았고 `--zcodes`를 주지 않았을 때만** `deactivate_missing(seen)`을 부른다. `EvApiError`가 나면 그때까지 반영한 것은 두고, 비활성화 없이 `CommandError`로 끝낸다.
- 끝에 `freshness_report`를 한 줄씩 출력한다. `--report-only`는 API를 부르지 않고 보고만 한다.
- `poll_charger_status._skip_query_stats()`를 처음에 부른다(볼륨 포화 방지).

- [ ] **Step 1: 실패하는 테스트 작성** — `SyncPublicStationsTests(TestCase)`, `ev_api.fetch_region_chargers`를 `mock.patch`하고 `ev_api.ZCODES`를 `['41', '11']`로 패치

```python
def test_full_scan_deactivates_missing(self):
    PublicStation.objects.create(stat_id='OLD00001', name='옛 충전소', latitude=37.0, longitude=127.0, power_kw=50, charger_count=1)
    fetch.side_effect = lambda key, z, **kw: [_item(zcode=z, statId=f'ME0000{z}')]
    call_command('sync_public_stations', api_key='k', stdout=StringIO())
    self.assertFalse(PublicStation.objects.get(stat_id='OLD00001').is_active)
    self.assertEqual(PublicStation.objects.filter(is_active=True).count(), 2)

def test_failed_region_does_not_deactivate(self):
    PublicStation.objects.create(stat_id='OLD00001', name='옛 충전소', latitude=37.0, longitude=127.0, power_kw=50, charger_count=1)
    def flaky(key, z, **kw):
        if z == '11':
            raise ev_api.EvApiError('504')
        return [_item(zcode=z)]
    fetch.side_effect = flaky
    with self.assertRaises(CommandError):
        call_command('sync_public_stations', api_key='k', stdout=StringIO())
    self.assertTrue(PublicStation.objects.get(stat_id='OLD00001').is_active)
    self.assertTrue(PublicStation.objects.filter(stat_id='ME000001').exists())

def test_partial_zcodes_never_deactivate(self):
    PublicStation.objects.create(stat_id='OLD00001', name='옛 충전소', latitude=37.0, longitude=127.0, power_kw=50, charger_count=1)
    fetch.side_effect = lambda key, z, **kw: [_item(zcode=z)]
    call_command('sync_public_stations', api_key='k', zcodes=['41'], stdout=StringIO())
    self.assertTrue(PublicStation.objects.get(stat_id='OLD00001').is_active)

def test_freshness_report_ratios(self):
    sync_items([_item(chgerId='01', statUpdDt=fmt(NOW - timedelta(minutes=10))),
                _item(chgerId='02', statUpdDt=fmt(NOW - timedelta(hours=1))),
                _item(chgerId='03', statUpdDt=fmt(NOW - timedelta(hours=5))),
                _item(chgerId='04', statUpdDt=fmt(NOW - timedelta(hours=20)))], NOW)
    r = freshness_report(NOW)
    self.assertEqual((r['stations'], r['chargers']), (1, 4))
    self.assertEqual((r['within_30m'], r['within_2h'], r['within_12h']), (0.25, 0.5, 0.75))
```

(`fmt`는 KST `'%Y%m%d%H%M%S'` 문자열로 바꾸는 테스트 도우미.)

- [ ] **Step 2: 실패 확인** — `python manage.py test chargeflow.tests.SyncPublicStationsTests` → 명령 없음 오류
- [ ] **Step 3: `ev_api`에 `ZCODES`·`fetch_region_chargers` 추가, `build_catalog`는 import만 교체, `freshness_report`와 명령 구현**
- [ ] **Step 4: 통과 확인** — 같은 명령 PASS, `python manage.py test chargeflow` 전체 PASS
- [ ] **Step 5: 커밋** — `feat: 전국 급속 충전소 스캔 명령과 실측 보고`
- [ ] **Step 6: 실측 체크포인트 (로컬, `PUBLIC_DATA_API_KEY` 필요 — 약 60회 호출)**

Run: `python manage.py sync_public_stations`
기록할 것: `stations`, `chargers`, `within_30m`, `within_2h`, `within_12h`, 로컬 `db.sqlite3` 크기 증가분.
판단(설계 7.3):
- `within_2h >= 0.8` → Task 5의 `PUBLIC_STALE`을 **2시간**으로.
- 아니고 `within_12h >= 0.5` → **12시간** 유지.
- `within_12h < 0.5` → **멈추고 이용자에게 알린다.**
- 충전기 수 × 약 300바이트(인덱스 포함 추정)가 250MB를 넘으면 **멈추고 알린다.**
API 키가 없으면 이 단계를 건너뛰지 말고 멈춰서 이용자에게 키 또는 실행을 요청한다. 결과 수치는 Task 5 커밋 메시지 본문에 적는다.

---

### Task 4: 폴러 — 전국분은 갱신만

**Files:**
- Modify: `chargeflow/management/commands/poll_charger_status.py` (`_apply_items`, `_tracked_ids` 주변, `run_cycle`)
- Test: `chargeflow/tests.py` (`PollerTests`에 추가)

**Interfaces:**
- Consumes: Task 1의 `PublicStation`.
- Produces:
  - `_apply_items(items, tracked, now, *, create_for=None, log_for=None) -> int` — `create_for`(statId 집합)에 든 충전소만 새 `ChargerState` 줄을 만들고, `log_for`에 든 충전소만 `ChargerStatusLog`를 남긴다. 둘 다 `None`이면 `tracked`와 같다(기존 호출부와 `build_catalog._seed_states`는 그대로 동작). 반환값은 지금처럼 남긴 로그 수.
  - `_public_ids() -> set[str]` — 활성 `PublicStation.stat_id`.

변경 내용:
- `_apply_items`가 `ChargerState.objects.filter(stat_id__in=tracked)` 전체를 읽던 것을, **이번 `items`에 실제로 나온 statId ∩ tracked**만 읽게 바꾼다(`items`는 제너레이터일 수 있으니 먼저 리스트로).
- `run_cycle`: `public_ids = _public_ids() - rest_ids - bypass_ids`, `tracked = rest_ids | bypass_ids | public_ids`. 세 군데 `_apply_items` 호출에 `create_for=rest_ids | bypass_ids`, `log_for=rest_ids | bypass_ids`를 넘긴다. `_sync_baseline`도 같은 인자를 받아 넘긴다.
- 끝의 요약 출력에 `전국 급속 {n}곳 추적`을 덧붙인다. 그 밖의 흐름(기준선, 혼잡도, 알림, 로그 정리)은 바꾸지 않는다.

- [ ] **Step 1: 실패하는 테스트 작성** (`PollerTests`)

```python
def test_public_station_is_updated_but_not_created_or_logged(self):
    PublicStation.objects.create(stat_id='PUB00001', name='공영', latitude=37.25, longitude=127.07, power_kw=100, charger_count=1)
    ChargerState.objects.create(stat_id='PUB00001', charger_id='01', stat='2', output_kw=100)
    items = [{'statId': 'PUB00001', 'chgerId': '01', 'stat': '3', 'statUpdDt': '20261119120000'},
             {'statId': 'PUB00001', 'chgerId': '99', 'stat': '2', 'statUpdDt': '20261119120000'}]
    poller._apply_items(items, {'PUB00001'}, timezone.now(), create_for=set(), log_for=set())
    self.assertEqual(ChargerState.objects.get(stat_id='PUB00001', charger_id='01').stat, '3')
    self.assertFalse(ChargerState.objects.filter(charger_id='99').exists())
    self.assertFalse(ChargerStatusLog.objects.filter(stat_id='PUB00001').exists())

def test_defaults_keep_existing_behaviour(self):
    poller._apply_items([{'statId': 'NEW00001', 'chgerId': '01', 'stat': '2'}], {'NEW00001'}, timezone.now())
    self.assertTrue(ChargerState.objects.filter(stat_id='NEW00001').exists())
    self.assertEqual(ChargerStatusLog.objects.filter(stat_id='NEW00001').count(), 1)

def test_run_cycle_tracks_public_stations(self):
    # 기존 PollerTests가 ev_api를 패치하는 방식 그대로: fetch_status_changes가 PUB00001/01 을 stat '3'으로 돌려주게 하고
    # run_cycle 뒤 그 줄이 '3'이 됐는지, 휴게소 혼잡도 계산이 예전과 같은지 확인한다.
```

- [ ] **Step 2: 실패 확인** — `python manage.py test chargeflow.tests.PollerTests` → `TypeError: unexpected keyword argument 'create_for'`
- [ ] **Step 3: 구현**
- [ ] **Step 4: 통과 확인** — `python manage.py test chargeflow` 전체 PASS(기존 폴러 테스트 포함)
- [ ] **Step 5: 커밋** — `feat: 폴러가 전국 급속 충전기 상태를 갱신`

---

### Task 5: 빈 대수 판정과 반경 검색 — `nearby`

**Files:**
- Create: `chargeflow/services/nearby.py`
- Test: `chargeflow/tests.py`

**Interfaces:**
- Consumes: `PublicStation`, `ChargerState.output_kw`.
- Produces:
  - 상수: `PUBLIC_STALE`(Task 3 Step 6 결과에 따라 `timedelta(hours=2)` 또는 `timedelta(hours=12)`), `RADII_KM = (5, 10, 20, 30)`, `MIN_AVAILABLE_STATIONS = 3`, `MAX_AVAILABLE = 20`, `MAX_OTHER = 10`, `KOREA_LAT = (33.0, 38.7)`, `KOREA_LNG = (124.5, 132.0)`.
  - `in_korea(lat: float, lng: float) -> bool`
  - `station_status(rows: Iterable[tuple[str, datetime | None]], now: datetime) -> dict | None` — `rows`는 `(stat, stat_updated_at)`. 반환 `{'available', 'charging', 'offline', 'total', 'state', 'checked_at'}`. `state`는 `'available'`(빈 곳 ≥ 1) / `'full'`(빈 곳 0, 충전 중 ≥ 1) / `'unavailable'`(둘 다 0, 이용 불가 ≥ 1). 모든 충전기가 오래됐거나 `rows`가 비면 `None`. `checked_at`은 오래되지 않은 충전기의 가장 최근 `stat_updated_at`(ISO 문자열). `total`은 `rows` 전체 수.
  - `search_nearby(lat: float, lng: float, connector: str = '', now: datetime | None = None) -> dict` — `{'radius_km': int, 'fetched_at': iso, 'stations': [...]}`. 충전소 항목 키: `id`, `stat_id`, `name`, `address`, `latitude`(str), `longitude`(str), `distance_km`(소수 1자리), `power_kw`, `operator`, `open_hours`, `connectors`(list[str]), `available`, `charging`, `offline`, `total`, `state`, `checked_at`.

규칙:
- 충전기 분류: `stat_updated_at`이 없거나 `now - stat_updated_at > PUBLIC_STALE`이면 "정보 없음"(어느 수에도 넣지 않는다). 아니면 `'2'`→빈 곳, `'3'`→충전 중, `'1'·'4'·'5'`→이용 불가, `'9'`→정보 없음.
- `search_nearby`는 활성 `PublicStation`만, 충전기는 `output_kw >= 50`만 본다.
- 반경마다: 위도 ±`r/111.0`, 경도 ±`r/(111.0·cos(lat))` 범위로 거르고, 직선거리(`views._haversine_km`를 `nearby.py`로 옮기고 `views`가 가져다 쓴다)가 `r` 이하인 것만 남긴다. `state`가 `None`인 충전소는 뺀다. `state == 'available'`인 곳이 3곳 이상이면 그 반경에서 멈춘다. 끝까지 못 채우면 30km 결과를 쓴다.
- `connector`가 있으면 `connectors`에 그 값이 있거나 `connectors`가 빈 충전소만.
- 결과 자르기: 빈 곳 있는 충전소 가까운 순 20곳 + 나머지 가까운 순 10곳, 합쳐서 거리순.

- [ ] **Step 1: 실패하는 테스트 작성** — `NearbyServiceTests(TestCase)`; 도우미 `_station(stat_id, lat, lng, chargers, connectors='combo')`는 `PublicStation`과 `(stat, age_minutes, output_kw)` 목록대로 `ChargerState`를 만든다. 기준점 `(37.2500, 127.0700)`, 위도 0.009도 ≈ 1km.

```python
def test_status_counts_and_states(self):
    fresh, old = NOW - timedelta(minutes=5), NOW - PUBLIC_STALE - timedelta(minutes=1)
    self.assertEqual(station_status([('2', fresh), ('3', fresh), ('5', fresh)], NOW)['state'], 'available')
    s = station_status([('3', fresh), ('1', fresh)], NOW)
    self.assertEqual((s['available'], s['charging'], s['offline'], s['total'], s['state']), (0, 1, 1, 2, 'full'))
    self.assertEqual(station_status([('4', fresh), ('5', fresh)], NOW)['state'], 'unavailable')

def test_stale_available_is_not_counted(self):          # Review Focus 1
    fresh, old = NOW - timedelta(minutes=5), NOW - PUBLIC_STALE - timedelta(minutes=1)
    s = station_status([('2', old), ('3', fresh)], NOW)
    self.assertEqual((s['available'], s['state']), (0, 'full'))
    self.assertIsNone(station_status([('2', old), ('2', None)], NOW))
    self.assertIsNone(station_status([], NOW))

def test_only_fast_chargers_are_counted(self):           # Review Focus 4
    _station('A', 37.2590, 127.07, [('3', 5, 100), ('2', 5, 7), ('2', 5, None)])
    st = search_nearby(37.25, 127.07, now=NOW)['stations'][0]
    self.assertEqual((st['available'], st['total'], st['state']), (0, 1, 'full'))

def test_radius_stops_at_first_with_three_available(self):
    for i, km in enumerate((1, 2, 3)):
        _station(f'N{i}', 37.25 + 0.009 * km, 127.07, [('2', 5, 100)])
    _station('FAR', 37.25 + 0.009 * 8, 127.07, [('2', 5, 100)])
    r = search_nearby(37.25, 127.07, now=NOW)
    self.assertEqual(r['radius_km'], 5)
    self.assertEqual([s['stat_id'] for s in r['stations']], ['N0', 'N1', 'N2'])

def test_radius_expands_when_not_enough(self):
    _station('N0', 37.25 + 0.009 * 1, 127.07, [('2', 5, 100)])
    _station('MID', 37.25 + 0.009 * 8, 127.07, [('2', 5, 100)])
    _station('FAR', 37.25 + 0.009 * 15, 127.07, [('2', 5, 100)])
    self.assertEqual(search_nearby(37.25, 127.07, now=NOW)['radius_km'], 20)

def test_falls_back_to_30km_with_full_stations(self):
    _station('FULL', 37.25 + 0.009 * 12, 127.07, [('3', 5, 100)])
    r = search_nearby(37.25, 127.07, now=NOW)
    self.assertEqual((r['radius_km'], r['stations'][0]['state']), (30, 'full'))

def test_excludes_inactive_unknown_and_beyond_30km(self):
    _station('OFF', 37.259, 127.07, [('2', 5, 100)]); PublicStation.objects.filter(stat_id='OFF').update(is_active=False)
    _station('UNK', 37.259, 127.07, [('9', 5, 100)])
    _station('OUT', 37.25 + 0.009 * 40, 127.07, [('2', 5, 100)])
    self.assertEqual(search_nearby(37.25, 127.07, now=NOW)['stations'], [])

def test_connector_filter_keeps_matching_and_unknown(self):
    _station('C', 37.259, 127.07, [('2', 5, 100)], connectors='combo')
    _station('D', 37.260, 127.07, [('2', 5, 100)], connectors='chademo')
    _station('E', 37.261, 127.07, [('2', 5, 100)], connectors='')
    ids = [s['stat_id'] for s in search_nearby(37.25, 127.07, connector='combo', now=NOW)['stations']]
    self.assertEqual(ids, ['C', 'E'])

def test_result_cap_keeps_available_first(self):
    for i in range(25): _station(f'F{i:02}', 37.25 + 0.0005 * (i + 1), 127.07, [('3', 5, 100)])
    for i in range(22): _station(f'A{i:02}', 37.25 + 0.02 + 0.0005 * i, 127.07, [('2', 5, 100)])
    st = search_nearby(37.25, 127.07, now=NOW)['stations']
    self.assertEqual(len(st), 30)
    self.assertEqual(sum(s['state'] == 'available' for s in st), 20)
    self.assertEqual(st, sorted(st, key=lambda s: s['distance_km']))

def test_in_korea(self):
    self.assertTrue(in_korea(37.5, 127.0)); self.assertTrue(in_korea(33.4, 126.5))
    for lat, lng in ((0, 0), (35.6, 139.7), (40.0, 127.0)):
        self.assertFalse(in_korea(lat, lng))
```

- [ ] **Step 2: 실패 확인** — `python manage.py test chargeflow.tests.NearbyServiceTests` → ImportError
- [ ] **Step 3: `chargeflow/services/nearby.py` 구현, `_haversine_km`를 이쪽으로 옮기고 `views.py`는 import로 교체**
- [ ] **Step 4: 통과 확인** — 같은 명령 PASS, 전체 테스트 PASS
- [ ] **Step 5: 커밋** — `feat: 주변 급속충전소 빈 대수 판정과 반경 검색` (본문에 Task 3 실측 수치와 고른 `PUBLIC_STALE`)

---

### Task 6: 주변 검색 API

**Files:**
- Modify: `chargeflow/views.py` (`NearbyStationsView` 추가), `chargeflow/urls.py`
- Test: `chargeflow/tests.py`

**Interfaces:**
- Consumes: Task 5의 `search_nearby`, `in_korea`.
- Produces: `POST /api/v1/stations/nearby/`, 본문 `{"lat": number, "lng": number, "connector"?: "combo"|"chademo"|"ac3"|"nacs"|""}`. 200 응답은 `search_nearby`의 dict 그대로. URL name `stations-nearby`. `urls.py`에서 `stations/<int:pk>/` 위에 둔다.

규칙:
- `lat`·`lng`가 없거나, 숫자가 아니거나(bool·NaN·무한대 포함), `in_korea`가 False면 400 `{"detail": "위치를 확인하지 못했어요."}`.
- `connector`가 허용값 밖이면 `''`로 본다.
- 인증·이용자 식별을 쓰지 않는다(`APIView`). 좌표를 저장하거나 `logger`로 남기지 않는다.

- [ ] **Step 1: 실패하는 테스트 작성** — `NearbyApiTests(TestCase)`

```python
def test_returns_nearby_stations(self):
    _station('A', 37.259, 127.07, [('2', 5, 100)])
    res = self.client.post('/api/v1/stations/nearby/', {'lat': 37.25, 'lng': 127.07}, format='json')
    self.assertEqual(res.status_code, 200)
    self.assertEqual(set(res.data), {'radius_km', 'fetched_at', 'stations'})
    self.assertEqual(res.data['stations'][0]['stat_id'], 'A')

def test_rejects_bad_coordinates(self):                   # Review Focus 3
    for body in ({}, {'lat': 37.25}, {'lat': 'abc', 'lng': 127.07}, {'lat': 0, 'lng': 0},
                 {'lat': 35.6, 'lng': 139.7}, {'lat': True, 'lng': 127.07}, {'lat': float('inf'), 'lng': 127.07}):
        res = self.client.post('/api/v1/stations/nearby/', body, format='json')
        self.assertEqual(res.status_code, 400, body)

def test_unknown_connector_is_ignored(self):
    _station('A', 37.259, 127.07, [('2', 5, 100)], connectors='chademo')
    res = self.client.post('/api/v1/stations/nearby/', {'lat': 37.25, 'lng': 127.07, 'connector': 'zzz'}, format='json')
    self.assertEqual(len(res.data['stations']), 1)

def test_get_is_not_allowed(self):
    self.assertEqual(self.client.get('/api/v1/stations/nearby/?lat=37.25&lng=127.07').status_code, 405)

def test_station_detail_route_still_works(self):
    self.assertEqual(self.client.get('/api/v1/stations/999999/').status_code, 404)
```

(`float('inf')`는 JSON으로 못 보내므로 그 경우만 `content_type='application/json'`, `data='{"lat": 1e999, "lng": 127.07}'`로 보낸다.)

- [ ] **Step 2: 실패 확인** — `python manage.py test chargeflow.tests.NearbyApiTests` → 404
- [ ] **Step 3: 뷰와 URL 구현**
- [ ] **Step 4: 통과 확인** — 같은 명령 PASS, 전체 테스트 PASS
- [ ] **Step 5: 커밋** — `feat: 주변 급속충전소 검색 API`

---

### Task 7: 프론트 — 타입·API·표시 규칙

**시작 전:** Global Constraints의 "시작 전 확인"(이용자의 미커밋 프론트 변경)을 처리한다.

**Files:**
- Modify: `frontend/package.json` (devDependency `vitest`, script `"test": "vitest run"`)
- Modify: `frontend/src/api/types.ts`, `frontend/src/api/client.ts`
- Create: `frontend/src/lib/nearby.ts`, `frontend/src/lib/nearby.test.ts`

**Interfaces:**
- Consumes: Task 6의 API.
- Produces:

```ts
// api/types.ts
export type NearbyState = "available" | "full" | "unavailable";
export interface NearbyStation {
  id: number; stat_id: string; name: string; address: string;
  latitude: string; longitude: string; distance_km: number;
  power_kw: number; operator: string; open_hours: string;
  connectors: Exclude<Connector, "">[];
  available: number; charging: number; offline: number; total: number;
  state: NearbyState; checked_at: string | null;
}
export interface NearbyStationsResponse { radius_km: number; fetched_at: string; stations: NearbyStation[]; }

// api/client.ts
api.nearbyStations(lat: number, lng: number, connector: Connector): Promise<NearbyStationsResponse>  // POST, 좌표는 roundCoord 후 전송

// lib/nearby.ts
export const LIST_INITIAL = 3;
export function roundCoord(n: number): number;                       // 소수 셋째 자리
export function pinText(s: NearbyStation): string;                   // "3대" | "꽉 참" | "이용 불가"
export function countText(s: NearbyStation): string;                 // 목록 오른쪽: "3대" | "꽉 참" | "이용 불가"
export function rowCaption(s: NearbyStation, now: number): string;   // "약 1.2km · 100kW" (+ " · 2시간 전 확인": 확인이 30분보다 오래됐을 때만)
export function checkedText(iso: string | null, now: number): string; // "방금 확인" | "12분 전 확인" | "2시간 전 확인" | ""
export function listRows(stations: NearbyStation[], expanded: boolean): { rows: NearbyStation[]; hidden: number; fallback: boolean };
export function summaryText(stations: NearbyStation[]): string;      // "급속 · 빈 곳 3곳" | "급속 · 빈 곳 없음"
export interface Region { name: string; lat: number; lng: number }
export const REGIONS: Region[];
export function loadLastLocation(): { lat: number; lng: number } | null;
export function saveLastLocation(lat: number, lng: number): void;
```

규칙:
- `listRows`: 빈 곳 있는 충전소만 대상으로, `expanded`가 아니면 앞 `LIST_INITIAL`곳, `hidden`은 나머지 수, `fallback: false`. 빈 곳 있는 충전소가 하나도 없으면 전체(꽉 참·이용 불가)를 같은 방식으로 자르고 `fallback: true`.
- `rowCaption`의 거리는 기존 `formatKm`을 써서 `약 ${formatKm(km)}`.
- `loadLastLocation`/`saveLastLocation`: `localStorage` 키 `nearby:last-location`, 모든 접근을 try/catch로 감싸고 실패하면 `null`/무시. 저장값도 `roundCoord`한 값.
- `REGIONS`(시·도청 좌표, 이 순서): 서울 37.5665,126.9780 · 부산 35.1796,129.0756 · 대구 35.8714,128.6014 · 인천 37.4563,126.7052 · 광주 35.1595,126.8526 · 대전 36.3504,127.3845 · 울산 35.5384,129.3114 · 세종 36.4800,127.2890 · 경기 37.2636,127.0286 · 강원 37.8813,127.7298 · 충북 36.6357,127.4917 · 충남 36.6588,126.6728 · 전북 35.8242,127.1480 · 전남 34.8161,126.4629 · 경북 36.5760,128.5056 · 경남 35.2383,128.6924 · 제주 33.4996,126.5312.

- [ ] **Step 1: `npm --prefix frontend i -D vitest` 후 실패하는 테스트 작성** (`nearby.test.ts`; `st(over)`는 기본 `NearbyStation`을 만드는 도우미, `NOW = Date.parse("2026-11-19T12:00:00+09:00")`)

```ts
test("roundCoord", () => { expect(roundCoord(37.251234)).toBe(37.251); expect(roundCoord(127.0715)).toBe(127.072); });
test("pinText and countText", () => {
  expect(pinText(st({ state: "available", available: 3 }))).toBe("3대");
  expect(pinText(st({ state: "full", available: 0 }))).toBe("꽉 참");
  expect(countText(st({ state: "unavailable", available: 0 }))).toBe("이용 불가");
});
test("rowCaption hides fresh check time", () => {
  expect(rowCaption(st({ distance_km: 1.2, power_kw: 100, checked_at: iso(NOW - 10 * 60000) }), NOW)).toBe("약 1.2km · 100kW");
  expect(rowCaption(st({ distance_km: 0.4, power_kw: 200, checked_at: iso(NOW - 125 * 60000) }), NOW)).toBe("약 400m · 200kW · 2시간 전 확인");
});
test("checkedText", () => {
  expect(checkedText(iso(NOW - 20000), NOW)).toBe("방금 확인");
  expect(checkedText(iso(NOW - 12 * 60000), NOW)).toBe("12분 전 확인");
  expect(checkedText(null, NOW)).toBe("");
});
test("listRows shows three available, then all", () => {
  const all = [st({ id: 1 }), st({ id: 2, state: "full", available: 0 }), st({ id: 3 }), st({ id: 4 }), st({ id: 5 })];
  expect(listRows(all, false)).toMatchObject({ hidden: 1, fallback: false });
  expect(listRows(all, false).rows.map((s) => s.id)).toEqual([1, 3, 4]);
  expect(listRows(all, true).rows.map((s) => s.id)).toEqual([1, 3, 4, 5]);
});
test("listRows falls back to full stations", () => {
  const full = [1, 2, 3, 4].map((id) => st({ id, state: "full", available: 0 }));
  expect(listRows(full, false)).toMatchObject({ hidden: 1, fallback: true });
  expect(listRows([], false)).toEqual({ rows: [], hidden: 0, fallback: false });
});
test("summaryText", () => {
  expect(summaryText([st({}), st({ state: "full", available: 0 })])).toBe("급속 · 빈 곳 1곳");
  expect(summaryText([st({ state: "full", available: 0 })])).toBe("급속 · 빈 곳 없음");
});
test("REGIONS covers 17 regions inside Korea", () => {
  expect(REGIONS).toHaveLength(17);
  for (const r of REGIONS) { expect(r.lat).toBeGreaterThan(33); expect(r.lat).toBeLessThan(38.7); expect(r.lng).toBeGreaterThan(124.5); expect(r.lng).toBeLessThan(132); }
});
test("last location survives storage errors", () => {
  vi.stubGlobal("localStorage", { getItem() { throw new Error("blocked"); }, setItem() { throw new Error("blocked"); } });
  expect(loadLastLocation()).toBeNull();
  expect(() => saveLastLocation(37.2512, 127.0712)).not.toThrow();
});
```

- [ ] **Step 2: 실패 확인** — `npm --prefix frontend test` → 모듈 없음
- [ ] **Step 3: 타입, `api.nearbyStations`, `lib/nearby.ts` 구현**
- [ ] **Step 4: 통과 확인** — `npm --prefix frontend test` PASS, `npm --prefix frontend run lint` 오류 없음, `frontend` 폴더에서 `npx tsc -b` 오류 없음
- [ ] **Step 5: 커밋** — `feat: 주변 충전소 API 클라이언트와 표시 규칙`

---

### Task 8: 지도 컴포넌트 — `NearbyMap`

**Files:**
- Create: `frontend/src/components/NearbyMap.tsx`
- Modify: `frontend/src/index.css` (지도·핀 스타일 추가만. 기존 규칙은 고치지 않는다)

**Interfaces:**
- Consumes: `loadKakaoMaps`(`lib/kakao.ts`), Task 7의 `NearbyStation`, `pinText`.
- Produces:

```ts
interface NearbyMapProps {
  center: { lat: number; lng: number };          // 바뀌면 지도를 그 위치로 옮긴다
  me: { lat: number; lng: number } | null;        // 내 위치 점(없으면 안 그림)
  stations: NearbyStation[];
  focusId: number | null;                         // 강조할 충전소
  onSelect: (id: number) => void;                 // 핀을 눌렀을 때
  onMoved: (center: { lat: number; lng: number }) => void;  // 이용자가 지도를 끌어 옮긴 뒤(dragend)
  onFailed: () => void;                           // SDK 로드 실패
}
export function NearbyMap(props: NearbyMapProps): JSX.Element | null
```

규칙:
- `RestAreaMap.tsx`의 방식(커스텀 오버레이를 DOM으로 만들고 `textContent`로 글자를 넣는다, 같은 구성이면 다시 그리지 않는다)을 따른다. `RestAreaMap.tsx`는 고치지 않는다.
- 핀: 빈 곳 있는 곳은 브랜드색 알약(`.nearby-pin`), 그 밖은 회색·작게(`.nearby-pin--off`), 강조는 `.nearby-pin--focus`. 글씨 15px 이상, 터치 영역 44px 이상. `role="button"`, `aria-label`은 `"{이름} {pinText}"`.
- 내 위치는 파란 점(`.nearby-me`).
- 처음 그릴 때와 `stations`가 바뀔 때: `center`와 가까운 충전소 최대 5곳이 보이게 `setBounds`. 이용자가 지도를 끈 뒤에는 `stations`가 새로 와도 지도를 옮기지 않는다(`center` prop이 바뀔 때만 옮긴다).
- `onMoved`는 이용자의 드래그(`dragend`)에서만 부른다. 코드가 옮긴 경우에는 부르지 않는다.
- SDK 로드 실패 시 `onFailed()`를 한 번 부르고 `null`을 그린다.
- 높이: 화면 높이의 45%(`45dvh`), 최소 260px.

- [ ] **Step 1: 컴포넌트와 스타일 구현**
- [ ] **Step 2: 확인** — `npm --prefix frontend run lint`, `frontend` 폴더에서 `npx tsc -b` 오류 없음 (화면 확인은 Task 9에서 함께)
- [ ] **Step 3: 커밋** — `feat: 주변 충전소 지도 컴포넌트`

---

### Task 9: 새 홈 — `NearbyPage`, `NearbySheet`, 라우팅

**Files:**
- Create: `frontend/src/pages/NearbyPage.tsx`, `frontend/src/components/NearbySheet.tsx`
- Modify: `frontend/src/App.tsx`, `frontend/src/pages/HomePage.tsx:49`(`logScreen("home")` → `logScreen("highways")`), `frontend/src/index.css`(추가만)

**Interfaces:**
- Consumes: Task 7의 `api.nearbyStations`·`lib/nearby.ts`, Task 8의 `NearbyMap`, 기존 `getLocation`·`openDirections`·`logScreen`·`logClick`(`lib/toss.ts`), `useConnector`·`connectorName`(`lib/store.ts`), `ConnectorPicker`, `ErrorState`.
- Produces: 경로 `/` → `NearbyPage`(기존 `Root`의 `?ra=` 리다이렉트는 유지), `/highways` → 기존 `HomePage`. `NearbySheet` props: `{ station: NearbyStation | null; onClose: () => void }`.

화면 상태(설계 6장):

| 상태 | 조건 | 보이는 것 |
|---|---|---|
| 찾는 중 | 첫 진입, 위치·검색 대기 | 마지막 위치가 있으면 그 지도 + 목록 자리 Skeleton, 없으면 Skeleton만 |
| 결과 | 충전소 1곳 이상 | 지도 + 요약 칩 + 목록 |
| 빈 곳 없음 | `listRows(...).fallback` | 지도 + 안내문 + 꽉 찬 곳 목록 |
| 충전소 없음 | `stations.length === 0` | 지도 + 안내문 |
| 위치 없음 | 권한 거절·위치 실패, 또는 서버 400 | 지역 선택 목록 |
| 오류 | 검색 실패(400 제외), 이전 결과 없음 | `ErrorState`(다시 시도) |

동작:
- 진입 즉시 `getLocation()`. 성공하면 `saveLastLocation` 후 `api.nearbyStations`. 그 전에 `loadLastLocation()`이 있으면 그 좌표로 먼저 검색해 화면을 채운다.
- 검색 기준점(`origin`)은 내 위치, 지역 선택, "이 위치에서 찾기" 중 마지막 것. 화면이 보이는 동안 60초마다 같은 `origin`으로 조용히 다시 받는다(`document.visibilityState === "visible"`일 때만, 실패해도 이전 결과 유지).
- 지도를 끌면(`onMoved`) "이 위치에서 찾기" 버튼이 지도 위에 나타난다. 누르면 그 중심으로 검색하고 버튼을 숨긴다.
- "내 위치" 버튼: `getLocation()`을 다시 부르고 성공하면 그 위치로 검색.
- 지도 위 "충전 규격" 버튼: `ConnectorPicker` 시트를 연다(`RestAreaPage`의 시트와 같은 구성). 규격이 바뀌면 다시 검색한다.
- 목록 줄·핀 → `NearbySheet`. 시트 항목: 주소(헤더 설명), 빈 충전기 `"{available}/{total}대 · {checkedText}, 참고용"`, 충전기 `"{power_kw}kW · 급속 {total}대"`, 커넥터, 운영 시간, 운영사. CTA "길찾기" → `openDirections(name, latitude, longitude)`.
- `NearbyMap`이 `onFailed`를 부르면 지도 자리를 접고 목록만 보여 준다. "이 위치에서 찾기"는 숨기고, 지역을 바꿀 수 있게 "다른 지역에서 찾기" 버튼을 목록 위에 둔다.
- 맨 아래 한 줄: "고속도로 가는 날이에요" / "휴게소 보기" → `/highways`.

고정 문구:
- 요약 칩: `summaryText(stations)`
- 목록 아래: `"{HH}시 {mm}분 확인 · 공공데이터라 현장과 다를 수 있어요"`
- 더 보기: `"{hidden}곳 더 보기"`
- 빈 곳 없음: `"{radius_km}km 안에 지금 빈 급속충전소가 없어요"` / `"충전 중인 곳을 가까운 순서로 보여 드려요"`
- 충전소 없음: `"30km 안에 급속충전소가 없어요"` / `"지도를 옮겨 다른 곳에서 찾아보세요"`
- 위치 없음 제목: 거절 `"위치를 켜지 않아도 지역을 골라 찾을 수 있어요"`, 실패 `"현재 위치를 찾지 못했어요. 지역을 골라 주세요"`; 버튼 `"위치 켜고 다시 찾기"`
- 지도 버튼: `"이 위치에서 찾기"`, `"내 위치"`, 규격 미선택 `"충전 규격"` / 선택 시 `connectorName(connector)`

기록(설계 6.5): `logScreen("nearby")`; `logClick("nearby_station_open", { from: "pin" | "list", station_id })`, `nearby_directions`(`station_id`), `nearby_more`, `nearby_search_here`, `nearby_location_denied`(`reason: "denied" | "failed"`), `nearby_region_pick`(`region`), `nearby_open_highway`.

- [ ] **Step 1: `NearbySheet`, `NearbyPage`, 라우팅, 스타일 구현**
- [ ] **Step 2: 정적 확인** — `npm --prefix frontend test`, `npm --prefix frontend run lint`, `frontend` 폴더에서 `npx tsc -b` 모두 통과
- [ ] **Step 3: 화면 확인** — `.claude/launch.json`의 `api`·`frontend` 서버를 띄운다. 로컬 DB에 Task 3 Step 6의 스캔 데이터가 있어야 한다. `frontend/.env.development.local`에 `VITE_API_BASE_URL=http://localhost:8000`.

확인 목록(각각 통과해야 한다):
  1. 버튼을 누르지 않아도 지도·내 위치·핀·목록이 뜬다. 목록은 빈 곳만 최대 3곳.
  2. 핀과 목록 줄을 누르면 시트가 열리고 길찾기 버튼이 있다.
  3. 지도를 끌면 "이 위치에서 찾기"가 나오고, 누르면 목록이 바뀐다.
  4. devtools에서 위치 권한을 거절로 두면 지역 선택이 나오고, 지역을 고르면 지도와 목록이 뜬다. (Review Focus 3)
  5. `lib/kakao.ts`의 `loadKakaoMaps`가 `null`을 돌려주게 임시로 바꿔 보면 목록·시트·길찾기가 그대로 동작한다. 확인 후 되돌린다. (Review Focus 5)
  6. 충전소가 없는 좌표(예: 지도를 바다로 옮김)에서 "30km 안에 급속충전소가 없어요"가 나온다.
  7. "휴게소 보기" → `/highways`에 예전 홈이 그대로 나오고, `/rest-area/2202`, `/trip`, `/?ra=2202`가 예전처럼 동작한다.
  8. 모바일 폭(375px)에서 가로 스크롤이 없고, 계산된 글씨 크기가 기준(본문 15px, 이름 17px, 빈 대수 20px, 핀 15px) 이상이다.
  9. 콘솔 오류가 없다.

- [ ] **Step 4: 커밋** — `feat: 내 주변 빈 급속충전소 홈 화면, 고속도로 홈은 /highways로`

---

### Task 10: 문서와 출시 준비

**Files:**
- Modify: `README.md`

- [ ] **Step 1: README 갱신** — 주요 기능 표 첫 줄에 "내 주변 빈 급속충전소", 구조에 `public_catalog.py`·`nearby.py`·`sync_public_stations.py`, 배포 절에 크론 서비스 추가 안내:
  - 서비스 `chargeflow-catalog-cron`: 크론 `0 19 * * *`(UTC, 한국 04시), 시작 명령 `python manage.py sync_public_stations`, 환경 변수 `PUBLIC_DATA_API_KEY`·`DATABASE_URL`.
  - 호출량: 스캔 약 60회/일 + 폴러 약 450회/일.
  - 첫 배포 뒤 `sync_public_stations`를 한 번 수동 실행해야 지도가 채워진다는 점.
- [ ] **Step 2: 전체 확인** — `python manage.py test chargeflow` PASS, `npm --prefix frontend test` PASS, `npm --prefix frontend run build` 성공
- [ ] **Step 3: 커밋** — `docs: 주변 급속충전소 기능과 스캔 크론 안내`
- [ ] **Step 4: 멈추고 이용자에게 넘긴다.** 아래는 계획 범위 밖이며 각각 이용자 승인이 필요하다(설계 8장):
  1. 서버 배포 + Railway 크론 서비스 생성 + 운영 DB 첫 스캔, 하루 동안 용량·호출량 확인
  2. 새 번들 검수 요청·출시
  3. 앱 이름("전기차 빈 충전소 찾기" 후보)·부제·상세 설명·검색 키워드·스크린샷 변경 검토 요청

---

## Self-Review 결과

- 설계 6.1~6.5 → Task 7·8·9, 7.1 → Task 1·2·3, 7.2 → Task 4, 7.3 → Task 3(실측)·5, 7.4 → Task 5·6, 8장 → Task 10 Step 4, 9장 → 각 Task 테스트와 Task 9 Step 3.
- 설계와 달라진 점 하나: 주변 검색을 GET이 아니라 POST로 했다(좌표가 URL·접속 기록에 남지 않게). 설계 문서 7.4에도 반영했다.
- 프론트 컴포넌트(Task 8·9)는 단위 테스트 대신 화면 확인 목록으로 검증한다. 이 저장소에 컴포넌트 테스트 환경이 없고, 판단이 들어가는 로직은 Task 7의 순수 함수로 빼서 테스트한다.
