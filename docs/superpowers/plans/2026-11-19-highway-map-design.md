# 상단 간소화 + 고속도로 지도 개편 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 홈 상단을 버튼 줄만 남기고, 고속도로 화면(노선)과 휴게소 화면을 홈과 같은 "지도 + 끌어 올리는 시트" 구조로 바꾼다.

**Architecture:** 서버는 그대로. 시트는 기존 `NearbyListSheet`를 세 화면이 같이 쓴다. 고속도로·휴게소용 지도는 새 컴포넌트 `RouteMap`(노선 선 + 글자 핀 + 겹침 정리) 하나로 만들고 `RestAreaMap`을 대체한다. 판단 로직은 순수 함수(`lib/highway.ts`, `pages/highwayState.ts`, `pages/restAreaState.ts`)로 두고 vitest로 검증한다. `/highways`와 `/highway/:code`는 같은 `HighwayPage`를 쓴다.

**Tech Stack:** React 18 + TypeScript, `@toss/tds-mobile`, react-router v6, 카카오맵 JS SDK, vitest.

**Spec:** `docs/superpowers/specs/2026-11-19-highway-map-design.md` — 실행자는 이 문서의 표(핀 글자·색, 판정 문구)와 "실패 조건"을 그대로 따른다. 앞선 구조: `docs/superpowers/specs/2026-11-19-nearby-sheet-design.md`.

## Global Constraints

- 서버 코드와 `frontend/src/api/*`는 바꾸지 않는다. 지금 API 응답만 쓴다.
- **기능 보존(설계 "실패 조건" 첫 항목)**: 즐겨찾기(+알림 동의 흐름), 최근 본 휴게소, 공유, 방향 전환, 휴게소 이름 검색, 구간 미리 보기 입구, IC 앞/뒤 선택, 필터(충전 규격·100kW 이상·24시간), 30분 거리까지 넓혀 찾기, 추천 충전소와 길찾기, 충전소 상세 시트, 요일별 혼잡 패턴, 1분 자동 갱신, 안내 문구. 하나라도 닿을 수 없게 되면 실패다.
- 경로 보존: `/`, `/highways`, `/highway/:code?dir=`, `/rest-area/:id`, `/trip`, `/?ra=`. `TripPage`는 바꾸지 않는다.
- 홈(`NearbyPage`)의 지도·시트 동작은 Task 1의 상단 변경 외에는 바꾸지 않는다. `NearbyMap`, `NearbyListSheet`의 기존 동작을 깨지 않는다(시트에 prop을 더하는 것은 허용).
- 시트는 접힘/펼침 두 단계. 접힌 상태에 반드시 펼치는 **버튼**이 있다.
- 상태는 색 + 글자. 토큰 `--state-available`(초록), `--state-full`(주황), `--state-unavailable`(회색). 브랜드 파랑은 버튼·노선 선·강조에만.
- 지도 배치는 화면 높이 560px 이상이고 지도 SDK가 불러와졌을 때만(`canUseMapLayout`). 아니면 지도 없는 쌓인 배치로 모든 기능을 제공한다.
- `frontend/AGENTS.md` 하드 규칙: 본문 15px 이상, 터치 타깃 44px 이상, 한글 `keep-all`, font-weight 400~700, 아이콘은 SVG/TDS, 상단 네비 직접 그리지 않기, 하단 safe area. 이름 17px 이상, 숫자 20px 이상, 핀 글씨 15px 이상.
- 문구는 해요체. 거리에는 "약".
- 기존 기록 이름 유지. 새 기록: `highway_pick`(`highway`, `by: "auto"|"last"|"sheet"`), `highway_sheet_toggle`·`rest_area_sheet_toggle`(`open: 0|1`, `by`).
- 상수: 자동 노선 선택 거리 `AUTO_PICK_KM = 20`, 위치 제한 시간은 기존 `LOCATE_TIMEOUT_MS`(12초), 마지막 노선 저장 키 `highway:last`(값 `{code, dir}`).
- 검증 명령(모두 통과): `npm --prefix frontend test`, `npm --prefix frontend run lint`(오류 0), `frontend`에서 `npx tsc -b`. `npm run build`는 돌리지 않는다.
- 브랜치 `feat/nearby-sheet-design`. push·PR은 이용자 승인 없이 하지 않는다. `.env`, `db.sqlite3`, 추적되지 않는 `.claude/`·`.mcp.json`·`frontend/.vite/`, `frontend/src/lib/kakao.ts`는 건드리지 않는다.

## Review Focus

1. **옮기다 사라진 기능**: 즐겨찾기 알림 동의, "30분 거리까지 찾아보기", 필터 조합에서 결과 0곳, 패턴 차트가 펼친 시트·쌓인 배치 양쪽에서 닿는가. (Task 4 확인 목록)
2. **위치가 없거나 고속도로에서 멀 때의 `/highways`**: 막다른 화면 없이 마지막 노선 또는 노선 고르기 시트로 간다. (Task 2 테스트, Task 3 확인)
3. **다음 휴게소 판정**: 위치가 노선 위가 아닐 때·종점을 지났을 때·반대 방향일 때 엉뚱한 휴게소를 "다음"이라고 하지 않는다. (Task 2 테스트)
4. **휴게소 상태가 `unknown`이거나 추천 충전소가 없을 때의 접힌 시트**: 결론 줄과 다음 행동(넓혀 찾기 / 목록 보기)이 항상 있다. (Task 2 테스트)
5. **지도 실패·낮은 화면**: 쌓인 배치가 예전 화면과 같은 기능을 준다. (Task 3·4 확인)

---

### Task 1: 홈 상단 — 버튼 줄만

**Files:**
- Modify: `frontend/src/pages/NearbyPage.tsx`, `frontend/src/index.css`

- [ ] **Step 1: 구현** — `PageHeading`을 화면에서 없애고, 같은 자리에 시각적으로 숨긴 `<h1>주변 급속충전소</h1>`을 둔다(이미 숨김용 클래스가 있으면 그것, 없으면 `.sr-only` 추가). 버튼 줄(`.nearby-controls`)의 위 여백을 safe area 기준으로 다듬는다. 지도 배치·쌓인 배치·지역 선택 화면 모두 같은 상단을 쓴다. 지도 위 떠 있는 버튼 위치 계산(위쪽 줄 높이 측정)에 영향이 없는지 확인한다.
- [ ] **Step 2: 확인** — 검증 명령 통과
- [ ] **Step 3: 커밋** — `feat: 홈 상단을 버튼 줄만 남기고 정리`

---

### Task 2: 고속도로·휴게소 판단 로직 (순수 함수)

**Files:**
- Create: `frontend/src/lib/highway.ts`, `frontend/src/lib/highway.test.ts`
- Create: `frontend/src/pages/highwayState.ts`, `frontend/src/pages/highwayState.test.ts`
- Create: `frontend/src/pages/restAreaState.ts`, `frontend/src/pages/restAreaState.test.ts`

**Interfaces — Produces** (타입은 `api/types.ts`의 `Congestion`, `HighwayNode`, `NearbyRestArea`, `BypassResponse`, `BypassStation`, `Highway`, `Direction`):

```ts
// lib/highway.ts
export const AUTO_PICK_KM = 20;
export type PinKind = "available" | "full" | "unavailable";
export function raPin(c: Congestion): { text: string; kind: PinKind };
export function hasChargers(c: Congestion | undefined): boolean;           // total > 0 이거나 level이 unknown이 아님
export function stationPin(s: BypassStation): { text: string; kind: PinKind };
export function loadLastHighway(): { code: string; dir: Direction } | null; // localStorage "highway:last", 실패 시 null
export function saveLastHighway(code: string, dir: Direction): void;

// pages/highwayState.ts
export type HighwayStart =
  | { by: "auto"; code: string; dir: Direction; nextId: number }
  | { by: "last"; code: string; dir: Direction }
  | { by: "sheet" };
export function pickStart(input: {
  nearest: NearbyRestArea[] | null;      // nearest-ra 결과(가는 방향 우선). 위치 실패면 null
  matched: boolean;                       // direction_matched
  last: { code: string; dir: Direction } | null;
  codes: string[];                        // 유효한 노선 code 목록
}): HighwayStart;
export function nextRestArea(input: {
  nodes: HighwayNode[];                   // 이 방향의 휴게소(가는 순서), 충전기 있는 곳만
  me: { lat: number; lng: number } | null;
}): { id: number; aheadKm: number } | null;
export type HighwayPeek =
  | { kind: "next"; label: string; node: HighwayNode; more: number; moreLabel: string }
  | { kind: "first"; label: string; node: HighwayNode; more: number; moreLabel: string }
  | { kind: "message"; title: string };
export function highwayPeek(input: {
  nodes: HighwayNode[]; next: { id: number; aheadKm: number } | null;
  directionLabel: string; loading: boolean;
}): HighwayPeek;
export function aheadText(node: HighwayNode, meKm: number | null): string;  // "약 12km 앞" | "기점에서 34km"

// pages/restAreaState.ts
export function verdict(c: Congestion, waitMinutes: number | null): string;  // 설계의 판정 문구 표
export type RestAreaPeek =
  | { kind: "best"; verdict: string; station: BypassStation; icName: string | undefined; more: number }
  | { kind: "empty"; verdict: string; title: string; canWiden: boolean; more: number };
export function restAreaPeek(input: {
  congestion: Congestion; waitMinutes: number | null;
  best: BypassStation | null; bestIcName?: string;
  maxMinutes: number; totalStations: number;
}): RestAreaPeek;
```

규칙:
- `raPin`: 설계의 표 그대로 — smooth/normal → `{ "${available}대", "available" }`; busy → `{ "${available}대", "full" }`; jammed → `{ "만석", "full" }`; unavailable → `{ "이용 불가", "unavailable" }`; unknown → `{ "정보 없음", "unavailable" }`. `available`이 null이면 smooth/normal/busy도 라벨(`c.label`)을 글자로 쓴다.
- `stationPin`: `realtime`이 있으면 `"${realtime.available}대 · ${detour_extra_minutes}분"`, kind는 available>0 → "available", 아니면 "full". `realtime`이 없으면 `"${detour_extra_minutes}분"`, kind "unavailable"가 아니라 **"available"**(상태를 모를 뿐 쓸 수 있는 곳이므로 브랜드 중립색이 필요하면 Task 3에서 `--neutral` 클래스로 처리 — 이 함수는 `kind: "available"`과 `known: false`를 함께 돌려주도록 `{ text, kind, known }`으로 확장해도 된다).
- `pickStart`: `nearest`의 첫 항목이 `AUTO_PICK_KM` 이내이고 그 `highway_code`가 `codes`에 있으면 auto(`dir` = 그 항목의 direction, `nextId` = 그 id). `matched`가 false여도 20km 이내면 auto로 본다(정차 중일 수 있다). 아니면 `last`가 유효하면 last. 아니면 sheet.
- `nextRestArea`: `me`가 null이면 null. 각 휴게소까지 직선거리를 구해 가장 가까운 휴게소를 찾고, 그 거리가 `AUTO_PICK_KM`을 넘으면 null(노선에서 멀다). 가장 가까운 휴게소와 그 다음 휴게소 중 "앞에 있는" 것을 고른다: 가장 가까운 휴게소 `i`와 다음 `i+1`에 대해, `dist(me, i+1) < dist(i, i+1)`이면 이미 `i`를 지난 것으로 보고 `i+1`, 아니면 `i`. 마지막 휴게소를 지났으면 null. `aheadKm`은 고른 휴게소까지 직선거리(소수 첫째 자리 반올림, 10km 이상은 정수).
- `highwayPeek`: `loading` → message "휴게소를 불러오고 있어요". 휴게소 0곳 → message "이 방향에 충전소가 있는 휴게소가 없어요". `next` 있음 → kind "next", label `"다음 휴게소 · 약 ${aheadKm}km 앞"`, `more` = 그 뒤 휴게소 수, moreLabel `"이후 휴게소 ${more}곳 보기"`. 없음 → kind "first", label `"${directionLabel} 첫 휴게소"`, node = 첫 휴게소, `more` = 나머지 수, moreLabel `"휴게소 ${전체 수}곳 보기"`. `more`가 0이면 버튼 없음(호출부).
- `verdict`: 설계 표의 여섯 문구 그대로. `available`이 null인 혼잡/여유는 "빈 충전기 N대" 부분을 빼고 "휴게소가 붐벼요" / "휴게소에 빈 충전기가 있어요".
- `restAreaPeek`: `best`가 있으면 kind "best"(`more` = `totalStations`). 없으면 kind "empty", title `"IC 밖 ${maxMinutes}분 안에는 맞는 충전소가 없어요"`, `canWiden` = `maxMinutes < 30`.

- [ ] **Step 1: 실패하는 테스트 작성** — 세 테스트 파일에 위 규칙의 각 줄을 `expect` 하나 이상으로. 반드시 포함:

```ts
// highway.test.ts
expect(raPin(cg({ level: "normal", available: 3 }))).toEqual({ text: "3대", kind: "available" });
expect(raPin(cg({ level: "busy", available: 1 }))).toEqual({ text: "1대", kind: "full" });
expect(raPin(cg({ level: "jammed", available: 0 }))).toEqual({ text: "만석", kind: "full" });
expect(raPin(cg({ level: "unavailable" }))).toEqual({ text: "이용 불가", kind: "unavailable" });
expect(raPin(cg({ level: "unknown", available: null }))).toEqual({ text: "정보 없음", kind: "unavailable" });
// localStorage가 던져도 loadLastHighway()는 null, saveLastHighway는 던지지 않음; 잘못된 JSON·dir 값도 null

// highwayState.test.ts
// pickStart: 12km·코드 유효 → auto / 25km → last / last 없음 → sheet / nearest null → last 또는 sheet / 코드가 codes에 없음 → 다음 단계로
// nextRestArea (노선: 위도 37.0, 36.8, 36.6, 36.4의 네 휴게소, 남쪽 방향):
//   me 37.1(첫 휴게소 전) → 첫 휴게소 / me 36.9(첫·둘째 사이) → 둘째 / me 36.3(마지막을 지남) → null
//   me가 20km 넘게 옆으로 떨어짐(경도 +0.4) → null / me null → null
// highwayPeek: loading, 0곳, next(more 2 → "이후 휴게소 2곳 보기"), first("부산 방향 첫 휴게소", "휴게소 4곳 보기"), 1곳뿐(more 0)
// aheadText: meKm 있음/없음

// restAreaState.test.ts
expect(verdict(cg({ level: "jammed", available: 0 }), 25)).toBe("휴게소는 만석이에요. 약 25분 기다려야 해요");
expect(verdict(cg({ level: "jammed", available: 0 }), null)).toBe("휴게소는 만석이에요");
expect(verdict(cg({ level: "busy", available: 1 }), null)).toBe("휴게소가 붐벼요. 빈 충전기 1대");
expect(verdict(cg({ level: "smooth", available: 4 }), 0)).toBe("휴게소에 빈 충전기가 4대 있어요");
expect(verdict(cg({ level: "unavailable" }), null)).toBe("휴게소 충전기를 지금 쓸 수 없어요");
expect(verdict(cg({ level: "unknown", available: null }), null)).toBe("휴게소 충전기 상태를 받지 못했어요");
// restAreaPeek: best 있음 → kind "best", more = totalStations / best 없음·15분 → empty, canWiden true, title에 15 / 30분 → canWiden false
```

- [ ] **Step 2: 실패 확인** — `npm --prefix frontend test` → 새 테스트 FAIL
- [ ] **Step 3: 구현**
- [ ] **Step 4: 통과 확인** — 검증 명령 통과
- [ ] **Step 5: 커밋** — `feat: 고속도로·휴게소 지도 화면용 판단 로직`

---

### Task 3: 고속도로 화면 — 노선 지도 + 시트

**Files:**
- Create: `frontend/src/components/RouteMap.tsx`, `frontend/src/components/HighwayPickerSheet.tsx`
- Modify: `frontend/src/pages/HighwayPage.tsx`, `frontend/src/App.tsx`, `frontend/src/index.css`
- Delete: `frontend/src/pages/HomePage.tsx`(내용을 옮긴 뒤. 쓰이지 않게 된 CSS·컴포넌트도 정리)

**Interfaces:**
- Consumes: Task 2 전부, `NearbyListSheet`, `canUseMapLayout`, `locateWithTimeout`, `declutterPins`(홈 다듬기에서 추가됨, `lib/nearby.ts`), `api.highways/nodes/nearest/myRoutes`, `useHighways`.
- Produces: `RouteMap` props —

```ts
interface RoutePin { id: number; lat: number; lng: number; text: string; kind: PinKind; known?: boolean;
                     ariaLabel: string; priority: number; emphasized?: boolean }
interface RouteLabel { lat: number; lng: number; text: string }           // IC 이름표(누를 수 없음)
interface RouteMapProps {
  path: { lat: number; lng: number }[];        // 노선 선(순서대로). 비어 있으면 선 없음
  pins: RoutePin[]; labels?: RouteLabel[];
  me: { lat: number; lng: number } | null;
  fit: { lat: number; lng: number }[];          // 처음 화면에 들어오게 할 점들
  fitKey: string;                               // 값이 바뀌면 한 번 다시 맞춘다
  focusId: number | null;
  topInset: number; bottomInset: number;
  onSelect: (id: number) => void; onMapTap?: () => void; onFailed: () => void;
}
```

`RouteMap` 규칙: `NearbyMap`의 검증된 방식을 따른다 — 지도는 한 번만 만들고, 핀은 DOM + `textContent`, 범위 맞춤은 `fitKey`마다 한 번(+ `bottomInset`이 맞춘 직후 1초 안에 바뀌면 한 번 더, `shouldRefitForInset`), 이용자가 끌거나 확대한 뒤에는 다시 맞추지 않음, 겹치는 핀은 `declutterPins`로 점 처리(`emphasized`·focus는 항상 글자), 키보드로 핀 접근, 언마운트 정리, SDK 실패 시 `onFailed` 한 번. 노선 선은 카카오 `Polyline` 두 겹(흰 8px 아래, `--brand-primary` 4px 위). 핀 클래스는 홈의 `.nearby-pin--*` 스타일을 재사용한다(공통 클래스로 이름을 바꾸지 말고 같은 클래스를 쓴다). 공통 로직을 `NearbyMap`에서 훅으로 빼내는 것은 `NearbyMap`의 동작이 바뀌지 않는 범위에서만.

`HighwayPage` (`/highways`, `/highway/:code?dir=`):
- `/highways`: `loadLastHighway`, `locateWithTimeout(getLocationWithHeading…)` → `api.nearest` → `pickStart` → auto/last면 `navigate('/highway/…?dir=…', { replace: true })` + `highway_pick` 기록, sheet면 노선 고르기 시트를 연 상태로 안내 문구("어느 고속도로로 가세요?")만 보인다. 정하는 동안 Skeleton.
- `/highway/:code`: 유효하지 않은 code면 `/highways`로. 들어오면 `saveLastHighway`.
- 상단 버튼 줄(홈의 `.nearby-controls` 스타일 재사용): `[노선 이름]`(시트 열기, `aria-haspopup="dialog"`), `[방향 이름]`(반대로 전환, `aria-label="방향 바꾸기, 지금 {이름}"`, 전환 아이콘 SVG), `[주변 충전소]`(`/`). 보이지 않는 `h1` = 노선 이름.
- 데이터: `api.nodes(code, dir, "ALL")`로 노선 선(전체 노드)과 휴게소(`node_type === "RA"`이고 `hasChargers`)를 얻는다. 1분마다 조용히 갱신(화면이 보일 때만).
- 내 위치: 들어올 때 한 번 받아 `me`와 `nextRestArea`를 정한다(실패해도 화면은 동작). 지도에 "내 위치" 버튼.
- 지도: `path` = 전체 노드 좌표, `pins` = 휴게소(`raPin`, priority = 다음 휴게소 > 그 뒤 순서대로 > 지나온 곳), `fit` = 위치가 노선 위면 [내 위치, 다음 휴게소, 그다음 휴게소], 아니면 노선 전체, `fitKey` = `code|dir`. 핀을 누르면 `/rest-area/:id`.
- 시트(`NearbyListSheet`): peek = `highwayPeek` 결과(줄을 누르면 휴게소 화면, `more > 0`이면 버튼). 펼침 = `SearchField`(이름 필터) → "구간 미리 보기" 줄 → 휴게소 전체(`RestAreaRow` 재사용 또는 같은 모양, 설명에 `aheadText`). 검색 결과 0곳 문구는 지금 그대로.
- 쌓인 배치(`!canUseMapLayout` 또는 지도 실패): 상단 버튼 줄 + 지금 `HighwayPage`의 목록(검색, 구간 미리 보기, 휴게소 줄).
- `HighwayPickerSheet`(TDS `BottomSheet`): "내 위치로 찾기" 버튼(`/highways`의 자동 선택을 다시 실행), 즐겨찾기·최근 본 휴게소(`api.myRoutes`, 누르면 휴게소 화면, 기록 이름은 지금의 `home_open_rest_area` 유지), 노선 목록(누르면 그 노선으로, `highway_pick` by "sheet").
- `App.tsx`: `/highways` → `HighwayPage`. `HomePage`의 기능 중 "가는 길 휴게소 찾기"는 자동 선택과 "내 위치로 찾기"로, 즐겨찾기·최근은 시트로, 구간 미리 보기는 펼친 목록으로, 내 차 충전 규격 타일은 삭제, 안내 문구(공공데이터 10분)는 펼친 목록 맨 아래로 옮긴다.

- [ ] **Step 1: 구현**
- [ ] **Step 2: 정적 확인** — 검증 명령 통과
- [ ] **Step 3: 커밋** — `feat: 고속도로 화면을 노선 지도 + 시트로`
- [ ] **Step 4: 화면 확인(컨트롤러)** — 실제 지도에서: `/highways` 자동 선택·마지막 노선·시트로 시작; 노선 선과 핀(글자·색); 방향 전환; 시트 여닫기와 버튼; 검색; 구간 미리 보기; 즐겨찾기·최근; 핀 → 휴게소; 지도 실패·낮은 화면의 쌓인 배치; 콘솔 오류 없음.

---

### Task 4: 휴게소 화면 — 지도 + 결론 시트

**Files:**
- Modify: `frontend/src/pages/RestAreaPage.tsx`, `frontend/src/index.css`
- Delete: `frontend/src/components/RestAreaMap.tsx`(`RouteMap`으로 대체한 뒤)

**Interfaces:** Consumes Task 2의 `verdict`, `restAreaPeek`, `raPin`, `stationPin`; Task 3의 `RouteMap`; `NearbyListSheet`.

규칙:
- 지금 `RestAreaPage`의 데이터 흐름(`api.bypass(id, maxMinutes)`, 1분 갱신, `pattern`, `recordVisit`, 즐겨찾기·알림 동의, 공유, 필터 상태, `pickBest`, `fits`/`passes`/`byDetour`)은 그대로 둔다. 배치만 바꾼다.
- 상단 버튼 줄: 왼쪽에 휴게소 이름(`h1`, 17px 이상 bold)과 "노선 · 방향"(15px), 오른쪽에 즐겨찾기·공유 `IconButton`(지금 그대로).
- 지도(`RouteMap`): `path` = [앞 IC, 휴게소, 뒤 IC](있는 것만), `pins` = 휴게소 핀(`raPin`, emphasized, 누르면 아무 일 없음 대신 시트를 펼친다) + 조건에 맞는 충전소 핀(`stationPin`, 추천은 emphasized, priority는 `byDetour` 순), `labels` = IC 이름, `fit` = 휴게소 + IC들 + 추천 충전소, `fitKey` = 휴게소 id + `maxMinutes`. 충전소 핀을 누르면 그 IC 탭으로 맞추고 `StationSheet`를 연다(지금 `onSelectStation`과 같은 동작).
- 시트 peek(`restAreaPeek`): 판정 줄(15px 이상, 배경을 상태 토큰의 옅은 색으로) → `best`면 충전소 한 줄(이름, `summary(best)`, "{IC}에서 나가요") + "길찾기" 버튼(`best_directions` 기록) + "IC 밖 충전소 N곳 보기" 버튼; `empty`면 제목 + `canWiden`이면 "30분 거리까지 찾아보기" 버튼(`rest_area_widen_range`) + (`more > 0`이면) 목록 보기 버튼.
- 시트 펼침: IC 앞/뒤 `Tab`, 필터 칩 줄, 안내 캡션, `StationRow` 목록과 "N곳 더 보기", 패턴 차트, 안내 문구 — 지금 마크업을 옮긴다.
- 쌓인 배치(낮은 화면·지도 실패): 지금 화면과 같은 순서(추천 카드 → 목록 → 패턴 → 안내)로, 지도만 없다.
- `StationSheet`, `ConnectorPicker` 시트, 토스트는 그대로.

- [ ] **Step 1: 구현**
- [ ] **Step 2: 정적 확인** — 검증 명령 통과
- [ ] **Step 3: 커밋** — `feat: 휴게소 화면을 지도 + 결론 시트로`
- [ ] **Step 4: 화면 확인(컨트롤러)** — 실제 지도에서: 만석·여유·정보 없음 휴게소 각각의 판정 줄; 추천 충전소와 길찾기; 충전소 핀 → 상세; IC 탭·필터·더 보기; 30분으로 넓히기; 즐겨찾기·공유; 패턴 차트; `/?ra=` 진입; 쌓인 배치; 콘솔 오류 없음.
