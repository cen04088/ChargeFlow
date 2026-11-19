# 주변 충전소 홈 지도 시트 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 홈(`/`)에서 지도가 머리말 아래 남은 화면을 모두 쓰고, 목록은 지도 위에 얹힌 2단 시트(접힘/펼침)로 보이며, 핀은 빈 곳·충전 중·이용 불가를 색과 글자로 구분한다.

**Architecture:** 서버는 그대로. 표시 규칙은 `lib/nearby.ts`·`pages/nearbyState.ts`의 순수 함수로 두고 vitest로 검증한다. `NearbyMap`은 핀 종류·글자 모드·축소 시 점 표시를 받는 props만 늘린다. 시트는 새 컴포넌트 `NearbyListSheet`(비모달, 직접 구현)이고 `NearbyPage`가 배치를 바꿔 쓴다.

**Tech Stack:** React 18 + TypeScript, `@toss/tds-mobile`, 카카오맵 JS SDK, vitest.

**Spec:** `docs/superpowers/specs/2026-11-19-nearby-sheet-design.md` (상위 설계: `docs/superpowers/specs/2026-11-19-nearby-fast-chargers-design.md`)

## Global Constraints

- 서버 코드, `api/*`, 머리말·버튼 줄(지역 선택 · 충전 규격 · 고속도로), `NearbySheet`(상세), 지역 선택 화면, 오류 화면, 지도 실패 시 화면(`mapFailed`)의 동작은 바꾸지 않는다.
- 시트 상태는 접힘/펼침 **두 가지뿐**. 펼치는 방법 세 가지(손잡이 끌기, 손잡이 누르기, "N곳 더 보기" 버튼)가 모두 동작해야 한다.
- 상태는 색 + 글자로: 빈 곳 = 초록 + `"N대"`, 충전 중 = 주황 + `"충전 중"`, 이용 불가 = 회색 + `"이용 불가"`. 브랜드색(파랑, `--brand-*`)은 상태색으로 쓰지 않는다. 흰 글자와의 대비 4.5:1 이상.
- 초급속 기준 `ULTRA_FAST_KW = 150`. 축소 시 점 표시 기준 `DOT_LEVEL = 7`(카카오 지도 레벨 7 이상).
- `frontend/AGENTS.md` 하드 규칙: 본문 15px 이상(11px 이하 금지), 터치 타깃 44px 이상, 한글 `word-break: keep-all`, font-weight 400~700, 꺾쇠·화살표·번개는 SVG(`currentColor`), 상단 네비 직접 그리지 않기, 하단 safe area. 이 화면: 충전소 이름 17px 이상, 빈 대수 20px 이상, 핀 글씨 15px 이상.
- 문구는 해요체. 거리는 "약"을 붙인 직선거리. 주행 시간은 넣지 않는다.
- 기존 기록 이름은 유지한다. 새 기록: `nearby_sheet_toggle`(`open: 0|1`, `by: "drag"|"handle"|"button"|"map"`), `nearby_pin_mode`(`mode: "count"|"power"`).
- 검증 명령(모두 통과): `npm --prefix frontend test`, `npm --prefix frontend run lint`(오류 0), `frontend`에서 `npx tsc -b`. `npm run build`는 돌리지 않는다.
- 브랜치 `feat/nearby-sheet-design`. push·PR은 이용자 승인 없이 하지 않는다. 추적되지 않는 `.claude/`, `.mcp.json`, `frontend/.vite/`와 `.env`, `db.sqlite3`는 건드리지 않는다.

## Review Focus

1. **끌 줄 모르는 사람**: 손잡이를 끌지 않고도 "N곳 더 보기" 버튼과 손잡이 누르기로 목록 전체에 닿을 수 있다. (Task 3 확인 목록, `peekInfo` 테스트)
2. **접힌 시트에 가려지는 안내**: 빈 곳 없음 / 충전소 없음 / 정보 수신 불가 / 지난번 위치 / 찾는 중일 때 접힌 상태에서도 제목이 보인다. (Task 1 `peekInfo` 테스트)
3. **시트 끌기와 지도 끌기의 분리**: 손잡이에서 시작한 끌기는 지도를 움직이지 않고, 지도에서 시작한 끌기는 시트를 움직이지 않는다. 가로 쓸기는 시트가 가로채지 않는다. (Task 3 구현 규칙·확인 목록)
4. **결과 0곳·1곳**: 충전소가 1곳뿐이면 "더 보기" 버튼이 없고, 0곳이면 접힌 줄이 안내 문구가 된다. (Task 1 테스트)
5. **지도 실패**: SDK를 못 불러오면 시트 없이 기존 쌓인 목록이 그대로 나온다. (Task 3 확인 목록)

---

### Task 1: 표시 규칙 (순수 함수)

**Files:**
- Modify: `frontend/src/lib/nearby.ts`, `frontend/src/lib/nearby.test.ts`
- Modify: `frontend/src/pages/nearbyState.ts`, `frontend/src/pages/nearbyState.test.ts`

**Interfaces — Produces:**

```ts
// lib/nearby.ts
export const ULTRA_FAST_KW = 150;
export const DOT_LEVEL = 7;
export type PinMode = "count" | "power";
export function isUltraFast(s: NearbyStation): boolean;            // power_kw >= 150
export function pinLabel(s: NearbyStation, mode: PinMode): string; // count: pinText(s). power: `${power_kw}kW`
export function isDotLevel(level: number): boolean;                // level >= DOT_LEVEL
export function sheetRows(stations: NearbyStation[]): { rows: NearbyStation[]; fallback: ListFallback };
// rowCaption: 초급속이면 출력 뒤에 " 초급속" — "약 1.2km · 200kW 초급속"

// pages/nearbyState.ts
export function sheetSnap(input: { open: boolean; dy: number; vy: number; range: number }): boolean;
export type PeekInfo =
  | { kind: "station"; label: string; station: NearbyStation; more: number }
  | { kind: "message"; title: string; action?: "retry" };
export function peekInfo(input: {
  view: NearbyView; radiusKm: number; searching: boolean; hasOrigin: boolean;
}): PeekInfo;
```

규칙:
- `sheetRows`: `listRows`와 같은 선택 규칙(빈 곳 → 없으면 충전 중 → 없으면 이용 불가)이지만 자르지 않고 전부 돌려준다. `listRows`는 지도 실패 화면이 계속 쓰므로 그대로 둔다. 선택 규칙은 한 곳에만 구현하고 둘이 공유한다.
- `sheetSnap`: `dy`는 끌기 시작점 대비 이동(px, 위로 끌면 음수), `vy`는 놓는 순간 속도(px/ms, 위가 음수), `range`는 접힘↔펼침 높이 차(px). `|vy| >= 0.5`면 방향대로(위 → 펼침 `true`, 아래 → 접힘 `false`). 아니면 시작 상태 기준 이동량이 `range`의 30%를 넘었을 때만 반대 상태로 바뀐다. `|dy| < 8`이면 끌기가 아니라 누르기로 보고 호출부가 토글한다(이 함수는 현재 상태를 돌려준다).
- `peekInfo`:
  - `view.kind === "loading"` → message `hasOrigin ? "급속충전소를 찾고 있어요" : "현재 위치를 확인하고 있어요"`.
  - `"stale"` → message `"지금 충전소 정보를 받지 못하고 있어요"`, `action: "retry"`.
  - `"none"` → message `"30km 안에 급속충전소가 없어요"`.
  - `"list"`이고 `view.fallback`이 있으면 → message `fallbackCopy(view.fallback, radiusKm).title`.
  - `"list"`이고 빈 곳이 있으면 → station: `label = "가장 가까운 빈 곳"`, 첫 줄, `more = 전체 줄 수 - 1`.
  - `view.notice`(지난번 위치)가 있으면 station의 `label`을 `"지난번 위치에서 가장 가까운 빈 곳"`으로.
  - `NearbyView`의 list 변형은 지금 `listRows` 결과(잘린 rows, hidden)를 담는다. 시트용으로 전체 줄이 필요하면 `nearbyView`가 `sheetRows`를 쓰도록 바꾸되, 지도 실패 화면(`mapFailed`)이 보는 `rows`/`hidden` 동작은 그대로여야 한다 — 필요한 입력(`mapFailed`)을 `ViewInput`에 더해도 된다.

- [ ] **Step 1: 실패하는 테스트 작성**

```ts
// nearby.test.ts
test("isUltraFast / pinLabel", () => {
  expect(isUltraFast(st({ power_kw: 150 }))).toBe(true);
  expect(isUltraFast(st({ power_kw: 149 }))).toBe(false);
  expect(pinLabel(st({ state: "available", available: 3 }), "count")).toBe("3대");
  expect(pinLabel(st({ state: "full", available: 0 }), "count")).toBe("충전 중");
  expect(pinLabel(st({ state: "unavailable", available: 0 }), "count")).toBe("이용 불가");
  expect(pinLabel(st({ power_kw: 200, state: "full", available: 0 }), "power")).toBe("200kW");
});
test("isDotLevel", () => { expect(isDotLevel(6)).toBe(false); expect(isDotLevel(7)).toBe(true); });
test("rowCaption marks ultra-fast", () => {
  expect(rowCaption(st({ distance_km: 1.2, power_kw: 200, checked_at: iso(NOW) }), NOW)).toBe("약 1.2km · 200kW 초급속");
  expect(rowCaption(st({ distance_km: 1.2, power_kw: 100, checked_at: iso(NOW) }), NOW)).toBe("약 1.2km · 100kW");
});
test("sheetRows returns every row of the chosen group", () => {
  const all = [1, 2, 3, 4, 5].map((id) => st({ id }));
  expect(sheetRows(all).rows).toHaveLength(5);
  expect(sheetRows([st({ id: 1, state: "full", available: 0 }), st({ id: 2, state: "unavailable", available: 0 })]))
    .toMatchObject({ fallback: "full", rows: [{ id: 1 }] });
  expect(sheetRows([])).toEqual({ rows: [], fallback: false });
});

// nearbyState.test.ts
test("sheetSnap: fast flick wins, slow drag needs 30% of the range", () => {
  expect(sheetSnap({ open: false, dy: -20, vy: -0.8, range: 400 })).toBe(true);
  expect(sheetSnap({ open: true, dy: 20, vy: 0.8, range: 400 })).toBe(false);
  expect(sheetSnap({ open: false, dy: -100, vy: -0.1, range: 400 })).toBe(false);
  expect(sheetSnap({ open: false, dy: -130, vy: -0.1, range: 400 })).toBe(true);
  expect(sheetSnap({ open: true, dy: 130, vy: 0.1, range: 400 })).toBe(false);
  expect(sheetSnap({ open: true, dy: 100, vy: 0.1, range: 400 })).toBe(true);
});
test("peekInfo covers every state", () => {
  // loading(위치 전/후), stale(action retry), none, fallback full/unavailable(제목에 radius),
  // list(1곳 → more 0, 5곳 → more 4), notice → label "지난번 위치에서 가장 가까운 빈 곳"
});
```

("peekInfo covers every state"는 주석의 각 경우를 `expect` 하나씩으로 쓴다. `"충전 중"` 문구는 기존 `pinText`의 `"꽉 참"`을 대체한다 — `pinText`·`countText`와 그 테스트를 함께 바꾼다.)

- [ ] **Step 2: 실패 확인** — `npm --prefix frontend test` → 새 테스트 FAIL
- [ ] **Step 3: 구현**
- [ ] **Step 4: 통과 확인** — `npm --prefix frontend test` PASS, `npx tsc -b` 통과(호출부가 깨지면 이 Task에서 맞춘다)
- [ ] **Step 5: 커밋** — `feat: 지도 시트용 표시 규칙(핀 글자·초급속·시트 판정)`

---

### Task 2: 지도 핀 — 상태 3색, 번개, 글자 모드, 축소 시 점

**Files:**
- Modify: `frontend/src/components/NearbyMap.tsx`
- Modify: `frontend/src/index.css` (`.nearby-pin*` 규칙)

**Interfaces:**
- Consumes: Task 1의 `PinMode`, `pinLabel`, `isUltraFast`, `isDotLevel`.
- Produces: `NearbyMap` props 추가 — `mode: PinMode`, `bottomInset: number`(px, 지도 아래쪽을 가리는 시트 높이), `onMapTap?: () => void`. 기존 props와 동작(한 번만 범위 맞춤, 드래그·확대 시 `userMoved`, `onMoved`는 `dragend`에서만, `onFailed` 한 번, 키보드 접근)은 그대로.

규칙:
- 핀 클래스: `nearby-pin nearby-pin--available | --full | --unavailable`, 강조 `--focus`, 점 표시 `--dot`. 기존 `--off`는 없앤다.
- 색: 빈 곳 초록, 충전 중 주황, 이용 불가 회색. 값은 `index.css`의 `:root`에 `--state-available`, `--state-full`, `--state-unavailable` 토큰으로 두고 목록 숫자(`.nearby-row__count--*`)도 같은 토큰을 쓴다. 흰 글자 대비 4.5:1 이상인 값을 고르고 값을 보고서에 적는다.
- 초급속이면 글자 앞에 번개 SVG(`currentColor`, `aria-hidden`). `aria-label`은 `"{이름} {pinLabel(count)}"`에 초급속이면 `" 초급속"`을 덧붙인다. `mode`가 바뀌어도 `aria-label`은 빈 대수 기준.
- `mode`가 바뀌면 핀 글자만 바꾼다(지도 이동·범위 맞춤 없음).
- 지도 레벨이 `DOT_LEVEL` 이상이면 모든 핀에 `--dot`: 글자·번개를 숨기고 지름 18px 색 점으로. 터치 영역은 44px을 유지한다(투명 여백). `zoom_changed`에서 전환하며, 이 전환은 `userMoved` 판정과 별개다.
- `bottomInset`: 범위 맞춤(`setBounds`)의 아래 여백에 더한다. 값이 바뀌어도 다시 맞추지 않는다(다음 맞춤부터 적용).
- `onMapTap`: 지도 빈 곳을 눌렀을 때(카카오 `click`) 호출. 핀 클릭에서는 호출되지 않아야 한다.

- [ ] **Step 1: 구현**
- [ ] **Step 2: 확인** — `npm --prefix frontend test`, `npm --prefix frontend run lint`, `npx tsc -b` 통과(`NearbyPage`가 새 필수 props를 넘기도록 최소 수정: `mode="count"`, `bottomInset={0}`)
- [ ] **Step 3: 커밋** — `feat: 지도 핀을 상태 3색·초급속 번개·글자 모드·축소 시 점으로`

---

### Task 3: 시트와 배치

**Files:**
- Create: `frontend/src/components/NearbyListSheet.tsx`
- Modify: `frontend/src/pages/NearbyPage.tsx`, `frontend/src/index.css`

**Interfaces:**
- Consumes: Task 1의 `peekInfo`, `sheetSnap`, `sheetRows`; Task 2의 `NearbyMap` props.
- Produces: `NearbyListSheet` props — `{ open: boolean; onToggle: (open: boolean, by: "drag" | "handle" | "button" | "map") => void; peek: ReactNode; children: ReactNode; onPeekHeight: (px: number) => void }`. 시트는 내용(줄, 문구)을 모른다. `NearbyPage`가 `peek`와 `children`을 만든다.

배치(지도가 보이는 상태 — `showMap`이 참일 때만):
- `main.page`를 화면 높이(`100dvh`) 기둥으로: 머리말+버튼 줄(자기 높이) → 지도 영역(`flex: 1`, 최소 260px). 페이지 자체는 스크롤하지 않는다. 지도 래퍼의 좌우 여백·둥근 모서리는 없애고 화면 폭을 다 쓴다.
- 시트는 지도 영역 안 아래쪽에 겹쳐 놓는다(`position: absolute`). 접힘 높이 = 내용 높이(손잡이 + 한 줄 + 버튼), 펼침 높이 = 지도 영역 높이의 85%와 화면 높이의 70% 중 작은 값. 위쪽 모서리 20px 둥글게, 그림자. 아래 안쪽 여백에 `env(safe-area-inset-bottom)`.
- 높이 전환은 `transform`으로 하고 `--spring`·`--spring-time` 토큰을 쓴다. `prefers-reduced-motion`이면 전환 없이.
- 펼침일 때 시트 본문만 세로 스크롤(`overscroll-behavior: contain`).
- 지도 위 "내 위치" 버튼과 "이 위치에서 찾기"는 접힌 시트에 가려지지 않게 `onPeekHeight` 값만큼 위에 둔다. 펼침일 때는 가려져도 된다.
- 지도 오른쪽 위에 글자 모드 토글(TDS `SegmentedControl`, "빈 대수" / "출력"), 왼쪽 위에 요약 칩(`summaryText`)은 지금 위치를 유지하되 서로 겹치지 않게 한다(320px 폭 기준).
- `showMap`이 거짓인 상태(지역 선택, 오류, 지도 실패, 위치 전 로딩)는 지금의 쌓인 배치 그대로 — 페이지 스크롤도 그대로.

시트 동작:
- 손잡이: 폭 전체 × 높이 44px 이상의 버튼(`aria-expanded`, `aria-label` "목록 펼치기"/"목록 접기"), 가운데 막대 모양. Enter/Space/클릭으로 토글(`by: "handle"`).
- 끌기: 손잡이에서 시작한 pointer 이벤트만 받는다(`setPointerCapture`). 가로 이동이 세로보다 크면 끌기를 포기한다. 끄는 동안 시트가 손가락을 따라가고(접힘~펼침 범위로 제한), 놓으면 `sheetSnap`으로 판정(`by: "drag"`). 이동이 8px 미만이면 누르기로 처리. 손잡이에 `touch-action: none`.
- "N곳 더 보기" 버튼(`peek` 안, `more > 0`일 때만): 펼친다(`by: "button"`, 기존 `nearby_more`도 기록).
- 지도 빈 곳 누르기(`onMapTap`): 펼쳐져 있으면 접는다(`by: "map"`).
- 줄을 눌러 상세 시트를 열어도 목록 시트 상태는 그대로.
- 새 검색 결과가 와도(60초 갱신 포함) 열림 상태와 스크롤 위치를 유지한다. 지역을 고르거나 "이 위치에서 찾기"·"내 위치"로 기준점이 바뀌면 접는다.

펼친 본문(`children`): 지금 목록 구역의 내용 — 결과 제목, 안내 문구(빈 곳 없음/충전소 없음/정보 수신 불가 + 다시 시도/지난번 위치), 줄 전체(`sheetRows`), 확인 시각. 줄 오른쪽 숫자·문구는 상태 토큰 색.

접힌 줄(`peek`): `peekInfo` 결과대로. `station`이면 라벨(15px, `--muted`) + 줄 하나(누르면 상세 시트) + `more > 0`이면 "N곳 더 보기" 버튼(TDS `Button`, `display="full"`). `message`면 제목(17px bold) + `action === "retry"`면 "다시 시도" 버튼.

- [ ] **Step 1: 구현**
- [ ] **Step 2: 정적 확인** — `npm --prefix frontend test`, `npm --prefix frontend run lint`, `npx tsc -b` 통과
- [ ] **Step 3: 커밋** — `feat: 홈을 큰 지도 + 끌어 올리는 목록 시트로`
- [ ] **Step 4: 화면 확인(컨트롤러가 수행)** — `api`·`frontend` 서버를 띄우고:
  1. 지도가 머리말 아래 화면을 채우고, 접힌 시트에 가장 가까운 빈 곳과 "N곳 더 보기"가 보인다.
  2. 버튼, 손잡이 누르기, 손잡이 끌기로 각각 펼쳐지고 접힌다. 펼친 목록이 스크롤된다.
  3. 손잡이를 끌 때 지도가 움직이지 않고, 지도를 끌 때 시트가 움직이지 않는다.
  4. 핀이 초록/주황/회색 + 글자로 보이고, 150kW 이상에 번개가 있다. 토글로 "200kW"로 바뀐다. 축소하면 점이 된다.
  5. 빈 곳 없음·충전소 없음 상태에서 접힌 줄에 안내 제목이 보인다.
  6. 지도 SDK 실패 시 예전 쌓인 목록이 나온다. 지역 선택·오류 화면은 그대로다.
  7. 320px·375px 폭에서 지도 위 요소가 겹치지 않고 가로 스크롤이 없다. 글씨 크기 기준을 지킨다.
  8. 콘솔 오류가 없다.
  로컬에 `KAKAO_JS_KEY`가 없으면 1~4는 확인할 수 없다 — 확인하지 못한 항목을 그대로 보고한다.
