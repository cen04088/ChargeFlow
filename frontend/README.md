# ChargeFlow 프런트엔드

React·TypeScript·Vite와 앱인토스 TDS로 만든 전기차 충전 미니앱입니다. 백엔드와 충전소 데이터 준비는 [저장소 README](../README.md#로컬-실행)를 참고하세요.

## 로컬 미리보기

이 디렉터리에서 `npm ci`를 실행한 뒤 `.env.development.local`에 아래 값을 설정합니다.

```dotenv
VITE_API_BASE_URL=http://localhost:8000
```

```sh
npm run dev
```

기본 주소는 [http://localhost:5173/](http://localhost:5173/)입니다. 브라우저 개발 모드에서는 앱인토스 DevTools가 SDK를 모의 실행합니다. `TOSS_APP_NAME`을 설정한 로컬 서버에서 기본 포트 외의 주소를 사용한다면, Django의 `CORS_EXTRA_ORIGINS`에 미리보기 주소를 추가하세요.

지도와 주소·장소 검색은 `GET /api/v1/config/`에서 받은 카카오 JavaScript 키를 사용합니다. Django에 `KAKAO_JS_KEY`를 설정하고 카카오 디벨로퍼스에 로컬·앱인토스 실행 도메인을 등록해야 합니다. 키가 없거나 지도 SDK를 불러오지 못하면 지역 선택과 목록으로 충전소를 탐색할 수 있습니다.

## 화면과 코드

| 경로 | 구현 |
|---|---|
| `/` | [NearbyPage](src/pages/NearbyPage.tsx)가 화면 탭, 주소·장소 검색, 지도와 목록 시트, 충전 규격·최소 출력 설정을 연결합니다. |
| `/highways`, `/highway/:code` | [HighwayPage](src/pages/HighwayPage.tsx)에서 노선과 방향을 고르고 노선 띠와 지도 보기를 전환합니다. 방향은 `dir` 쿼리에 저장합니다. |
| `/rest-area/:id` | [RestAreaPage](src/pages/RestAreaPage.tsx)가 휴게소 상태, IC 밖 우회 추천과 펼침 목록을 표시합니다. 기존 공유 링크 `/?ra=<id>`는 이 화면으로 이어집니다. |
| `/trip` | [TripPage](src/pages/TripPage.tsx)에서 노선·방향·출발·도착을 고르고 구간 결과를 확인합니다. |

브랜드 색 `#2463D7`은 [앱인토스 설정](apps-in-toss.config.ts)의 `brand.primaryColor`와 [공통 CSS](src/index.css)의 `--brand-primary`에 정의합니다. 화면을 수정할 때는 [디자인 가이드](docs/design-guide.md)의 글자 크기, 44px 터치 영역, 화면 안전 영역 기준을 적용합니다.

### 첫 진입과 제한 시간

- **위치 조회:** 마지막 위치가 없을 때는 검색과 지역 선택 화면을 먼저 표시합니다. 자동 조회는 권한 창을 띄우지 않으며, 사용자가 내 위치 버튼을 누르면 권한을 요청할 수 있습니다. 주변 및 고속도로 시작 위치 조회의 제한 시간은 12초입니다.
- **토스 익명 키:** 최대 1.5초 기다리고, 시간 안에 키를 받지 못하면 키 없이 API 요청을 보냅니다.
- **카카오맵 SDK:** 최대 10초 기다린 뒤 지도 없는 흐름으로 전환합니다. 화면 높이가 560px 미만일 때도 목록형 배치를 사용합니다.

## 검사와 빌드

```sh
npm test
npm run lint
npx tsc -b
npm run build
```

`npm run build`는 `dist/`와 앱인토스에 올릴 `chargeflow.ait`를 생성합니다. 일반 빌드에서 실기기 디버거 코드는 번들에서 제외됩니다.

### 실기기 디버그 빌드

실기기 디버거가 필요한 경우에만 `AIT_DEBUG_BUILD=1`을 켜고 `AIT_RELAY_KEYS`에 사용하는 릴레이의 공개키 JSON 배열을 제공합니다. [Vite 설정](vite.config.ts)이 이 값을 디버그 빌드에 전달합니다.

### 앱인토스 배포

배포 API 키는 [앱인토스 콘솔](https://apps-in-toss.toss.im/)의 워크스페이스 설정에서 발급받습니다. 검수에 사용할 일반 번들을 빌드한 뒤 배포 명령을 실행합니다.

```sh
npm run deploy
```

## 유용한 링크

- [앱인토스 개발자센터](https://developers-apps-in-toss.toss.im/)
- [앱인토스 개발자 커뮤니티](https://techchat-apps-in-toss.toss.im/)
- [앱인토스 개발 문서 목록](https://developers-apps-in-toss.toss.im/development/llms.html)
