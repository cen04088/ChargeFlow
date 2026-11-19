import { afterEach, expect, test, vi } from "vitest";

import type { NearbyStation, NearbyStationsResponse } from "../api/types";
import {
  LOCATE_TIMEOUT_MS,
  MIN_MAP_LAYOUT_HEIGHT,
  canUseMapLayout,
  fallbackCopy,
  floatButtons,
  fetchedText,
  locateWithTimeout,
  nearbyView,
  nextCenter,
  noneDesc,
  peekInfo,
  sheetSnap,
  type ViewInput,
} from "./nearbyState";

afterEach(() => {
  vi.useRealTimers();
});

type Loc = { ok: true; lat: number; lng: number } | { ok: false; reason: "denied" | "failed" };

function deferred() {
  let resolve!: (r: Loc) => void;
  const promise = new Promise<Loc>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

test("locateWithTimeout returns the real answer when it is in time", async () => {
  vi.useFakeTimers();
  const d = deferred();
  const onLate = vi.fn();
  const p = locateWithTimeout(() => d.promise, LOCATE_TIMEOUT_MS, onLate);
  d.resolve({ ok: true, lat: 37.5, lng: 127 });
  await expect(p).resolves.toEqual({ ok: true, lat: 37.5, lng: 127 });
  await vi.advanceTimersByTimeAsync(LOCATE_TIMEOUT_MS * 2);
  expect(onLate).not.toHaveBeenCalled();
});

test("locateWithTimeout fails after 12s and hands the late answer to onLate", async () => {
  expect(LOCATE_TIMEOUT_MS).toBe(12000);
  vi.useFakeTimers();
  const d = deferred();
  const onLate = vi.fn();
  let settled: Loc | null = null;
  void locateWithTimeout(() => d.promise, LOCATE_TIMEOUT_MS, onLate).then((r) => {
    settled = r;
  });
  await vi.advanceTimersByTimeAsync(LOCATE_TIMEOUT_MS - 1);
  expect(settled).toBeNull();
  await vi.advanceTimersByTimeAsync(1);
  expect(settled).toEqual({ ok: false, reason: "failed" });
  d.resolve({ ok: true, lat: 37.5, lng: 127 });
  await vi.advanceTimersByTimeAsync(0);
  expect(onLate).toHaveBeenCalledWith({ ok: true, lat: 37.5, lng: 127 });
});

test("locateWithTimeout does nothing after it is cancelled", async () => {
  vi.useFakeTimers();
  const d = deferred();
  const onLate = vi.fn();
  const ctl = new AbortController();
  let settled = false;
  void locateWithTimeout(() => d.promise, LOCATE_TIMEOUT_MS, onLate, ctl.signal).then(() => {
    settled = true;
  });
  ctl.abort();
  await vi.advanceTimersByTimeAsync(LOCATE_TIMEOUT_MS * 2);
  expect(vi.getTimerCount()).toBe(0);
  d.resolve({ ok: true, lat: 37.5, lng: 127 });
  await vi.advanceTimersByTimeAsync(0);
  expect(settled).toBe(false);
  expect(onLate).not.toHaveBeenCalled();
});

test("locateWithTimeout ignores a late answer once cancelled", async () => {
  vi.useFakeTimers();
  const d = deferred();
  const onLate = vi.fn();
  const ctl = new AbortController();
  void locateWithTimeout(() => d.promise, LOCATE_TIMEOUT_MS, onLate, ctl.signal);
  await vi.advanceTimersByTimeAsync(LOCATE_TIMEOUT_MS);
  ctl.abort();
  d.resolve({ ok: true, lat: 37.5, lng: 127 });
  await vi.advanceTimersByTimeAsync(0);
  expect(onLate).not.toHaveBeenCalled();
});

test("locateWithTimeout with an already-aborted signal never asks", async () => {
  const ctl = new AbortController();
  ctl.abort();
  const get = vi.fn(() => Promise.resolve({ ok: true as const, lat: 1, lng: 2 }));
  void locateWithTimeout(get, 1000, () => {}, ctl.signal);
  expect(get).not.toHaveBeenCalled();
});

test("locateWithTimeout treats a rejected request as failed", async () => {
  const r = await locateWithTimeout(() => Promise.reject(new Error("x")), 1000, () => {});
  expect(r).toEqual({ ok: false, reason: "failed" });
});

function st(id: number, state: NearbyStation["state"]): NearbyStation {
  return {
    id,
    stat_id: `S${id}`,
    name: `충전소 ${id}`,
    address: "서울",
    latitude: "37.5",
    longitude: "127.0",
    distance_km: id,
    power_kw: 100,
    operator: "테스트",
    open_hours: "24시간",
    connectors: ["combo"],
    available: state === "available" ? 1 : 0,
    charging: 0,
    offline: 0,
    total: 2,
    state,
    checked_at: null,
  };
}

function res(stations: NearbyStation[], feed_stale = false): NearbyStationsResponse {
  return { radius_km: 5, fetched_at: "2026-11-19T05:05:00Z", stations, feed_stale };
}

const base: ViewInput = {
  hasOrigin: false,
  source: null,
  result: null,
  errorStatus: null,
  locFailure: null,
  regionsRequested: false,
  expanded: false,
  stacked: false,
};

test("위치·검색을 기다리는 동안은 찾는 중", () => {
  expect(nearbyView(base).kind).toBe("loading");
  expect(nearbyView({ ...base, hasOrigin: true, source: "last" }).kind).toBe(
    "loading",
  );
});

test("위치가 없고 지난번 위치도 없으면 지역 선택 (거절·실패 구분)", () => {
  expect(nearbyView({ ...base, locFailure: "denied" })).toEqual({
    kind: "regions",
    reason: "denied",
  });
  expect(nearbyView({ ...base, locFailure: "failed" })).toEqual({
    kind: "regions",
    reason: "failed",
  });
});

test("지난번 위치로 검색 중이면 위치 실패여도 지역 선택으로 바꾸지 않는다", () => {
  const v = nearbyView({
    ...base,
    hasOrigin: true,
    source: "last",
    locFailure: "denied",
  });
  expect(v.kind).toBe("loading");
});

test("지난번 위치 결과가 있으면 위치 실패 시 결과를 두고 안내만 붙인다", () => {
  const v = nearbyView({
    ...base,
    hasOrigin: true,
    source: "last",
    locFailure: "failed",
    result: res([st(1, "available")]),
  });
  expect(v.kind).toBe("list");
  expect(v.kind === "list" && v.notice).toBe(true);
});

test("지역을 고른 뒤에는 위치 실패 안내를 붙이지 않는다", () => {
  const v = nearbyView({
    ...base,
    hasOrigin: true,
    source: "region",
    locFailure: "denied",
    result: res([st(1, "available")]),
  });
  expect(v.kind === "list" && v.notice).toBe(false);
});

test("서버 400이면 결과가 있어도 지역 선택", () => {
  expect(
    nearbyView({
      ...base,
      hasOrigin: true,
      source: "me",
      errorStatus: 400,
      result: res([st(1, "available")]),
    }),
  ).toEqual({ kind: "regions", reason: "failed" });
});

test("검색 실패는 이전 결과가 없을 때만 오류 화면", () => {
  expect(
    nearbyView({ ...base, hasOrigin: true, source: "me", errorStatus: 0 }).kind,
  ).toBe("error");
  expect(
    nearbyView({
      ...base,
      hasOrigin: true,
      source: "me",
      errorStatus: 500,
      result: res([st(1, "available")]),
    }).kind,
  ).toBe("list");
});

test("충전소가 없으면 none, 빈 곳이 없으면 충전 중인 곳 목록", () => {
  const r = { ...base, hasOrigin: true, source: "me" as const };
  expect(nearbyView({ ...r, result: res([]) }).kind).toBe("none");
  const v = nearbyView({ ...r, result: res([st(1, "full"), st(2, "unavailable")]) });
  expect(v.kind === "list" && v.fallback).toBe("full");
  expect(v.kind === "list" && v.rows.map((s) => s.id)).toEqual([1]);
  const off = nearbyView({ ...r, result: res([st(2, "unavailable")]) });
  expect(off.kind === "list" && off.fallback).toBe("unavailable");
});

test("대체 목록 문구는 충전 중·이용 불가에 맞춘다", () => {
  expect(fallbackCopy("full", 30)).toEqual({
    title: "30km 안에 지금 빈 급속충전소가 없어요",
    desc: "충전 중인 곳을 가까운 순서로 보여 드려요",
  });
  expect(fallbackCopy("unavailable", 20)).toEqual({
    title: "20km 안에 지금 쓸 수 있는 급속충전소가 없어요",
    desc: "점검 중이거나 연결이 끊긴 곳만 있어요",
  });
});

test("결과가 비고 정보 수신이 끊겼으면 stale (none보다 우선)", () => {
  const r = { ...base, hasOrigin: true, source: "last" as const };
  expect(nearbyView({ ...r, result: res([], true) })).toEqual({ kind: "stale", notice: false });
  expect(nearbyView({ ...r, locFailure: "failed", result: res([], true) })).toEqual({
    kind: "stale",
    notice: true,
  });
  expect(nearbyView({ ...r, result: res([], false) }).kind).toBe("none");
  // 예전 응답처럼 값이 없으면 false로 본다
  const legacy = { radius_km: 30, fetched_at: "2026-11-19T05:05:00Z", stations: [] } as unknown as NearbyStationsResponse;
  expect(nearbyView({ ...r, result: legacy }).kind).toBe("none");
  // 결과가 있으면 무시
  expect(nearbyView({ ...r, result: res([st(1, "available")], true) }).kind).toBe("list");
});

test("stale은 지역 선택·오류·찾는 중을 덮지 않는다", () => {
  const r = { ...base, hasOrigin: true, source: "me" as const, result: res([], true) };
  expect(nearbyView({ ...r, regionsRequested: true }).kind).toBe("regions");
  expect(nearbyView({ ...r, errorStatus: 400 }).kind).toBe("regions");
  expect(nearbyView({ ...base, hasOrigin: true, source: "me", errorStatus: 0 }).kind).toBe("error");
  expect(nearbyView({ ...base, hasOrigin: true, source: "me" }).kind).toBe("loading");
});

test("쌓인 목록(지도 실패·낮은 화면): 빈 곳만 3곳, 나머지는 더 보기", () => {
  const stations = [1, 2, 3, 4, 5].map((i) => st(i, "available"));
  stations.push(st(6, "full"));
  const r = {
    ...base,
    hasOrigin: true,
    source: "me" as const,
    result: res(stations),
    stacked: true,
  };
  const v = nearbyView(r);
  expect(v.kind === "list" && v.rows.length).toBe(3);
  expect(v.kind === "list" && v.hidden).toBe(2);
  const all = nearbyView({ ...r, expanded: true });
  expect(all.kind === "list" && all.rows.length).toBe(5);
});

test("지도 시트: 고른 묶음의 줄을 자르지 않고 전부 준다", () => {
  const stations = [1, 2, 3, 4, 5].map((i) => st(i, "available"));
  stations.push(st(6, "full"));
  const v = nearbyView({
    ...base,
    hasOrigin: true,
    source: "me",
    result: res(stations),
  });
  expect(v.kind === "list" && v.rows.map((s) => s.id)).toEqual([1, 2, 3, 4, 5]);
  expect(v.kind === "list" && v.hidden).toBe(0);
});

test("sheetSnap: fast flick wins, slow drag needs 30% of the range", () => {
  expect(sheetSnap({ open: false, dy: -20, vy: -0.8, range: 400 })).toBe(true);
  expect(sheetSnap({ open: true, dy: 20, vy: 0.8, range: 400 })).toBe(false);
  expect(sheetSnap({ open: false, dy: -100, vy: -0.1, range: 400 })).toBe(false);
  expect(sheetSnap({ open: false, dy: -130, vy: -0.1, range: 400 })).toBe(true);
  expect(sheetSnap({ open: true, dy: 130, vy: 0.1, range: 400 })).toBe(false);
  expect(sheetSnap({ open: true, dy: 100, vy: 0.1, range: 400 })).toBe(true);
});

test("sheetSnap: under 8px is a tap — the current state comes back", () => {
  expect(sheetSnap({ open: false, dy: -5, vy: -2, range: 400 })).toBe(false);
  expect(sheetSnap({ open: true, dy: 7, vy: 2, range: 400 })).toBe(true);
});

test("peekInfo covers every state", () => {
  const p = { radiusKm: 5, searching: false, hasOrigin: true };
  const listOf = (stations: NearbyStation[], notice = false) =>
    nearbyView({
      ...base,
      hasOrigin: true,
      source: notice ? "last" : "me",
      locFailure: notice ? "failed" : null,
      result: res(stations),
    });

  // 찾는 중: 위치 전/후
  expect(peekInfo({ ...p, view: { kind: "loading" }, hasOrigin: false })).toEqual({
    kind: "message",
    title: "현재 위치를 확인하고 있어요",
  });
  expect(peekInfo({ ...p, view: { kind: "loading" } })).toEqual({
    kind: "message",
    title: "급속충전소를 찾고 있어요",
  });
  // 정보 수신 불가: 다시 시도
  expect(peekInfo({ ...p, view: { kind: "stale", notice: false } })).toEqual({
    kind: "message",
    title: "지금 충전소 정보를 받지 못하고 있어요",
    action: "retry",
  });
  // 충전소 없음
  expect(peekInfo({ ...p, view: { kind: "none", notice: false } })).toEqual({
    kind: "message",
    title: "30km 안에 급속충전소가 없어요",
  });
  // 빈 곳 없음(충전 중·이용 불가) — 제목에 반경, 펼칠 목록으로 들어가는 버튼
  expect(peekInfo({ ...p, view: listOf([st(1, "full"), st(2, "unavailable")]) })).toEqual({
    kind: "message",
    title: "5km 안에 지금 빈 급속충전소가 없어요",
    more: 1,
    moreLabel: "충전 중인 1곳 보기",
  });
  expect(peekInfo({ ...p, radiusKm: 20, view: listOf([st(2, "unavailable")]) })).toEqual({
    kind: "message",
    title: "20km 안에 지금 쓸 수 있는 급속충전소가 없어요",
    more: 1,
    moreLabel: "1곳 보기",
  });
  // 1곳 → 더 보기 없음
  const one = [st(1, "available")];
  expect(peekInfo({ ...p, view: listOf(one) })).toEqual({
    kind: "station",
    label: "가장 가까운 빈 곳",
    station: one[0],
    more: 0,
  });
  // 5곳 → 4곳 더 보기
  const five = [1, 2, 3, 4, 5].map((i) => st(i, "available"));
  expect(peekInfo({ ...p, view: listOf(five) })).toMatchObject({
    kind: "station",
    station: { id: 1 },
    more: 4,
  });
  // 지난번 위치
  expect(peekInfo({ ...p, view: listOf(one, true) })).toMatchObject({
    kind: "station",
    label: "지난번 위치에서 가장 가까운 빈 곳",
  });
  // 찾는 중이어도 이전 결과가 있으면 그 결과의 접힌 줄을 그대로 둔다(본문이 진행을 알린다)
  expect(peekInfo({ ...p, searching: true, view: listOf(five) })).toMatchObject({
    kind: "station",
    station: { id: 1 },
    more: 4,
  });
});

test("peekInfo: 빈 곳이 없으면 펼칠 줄 수만큼 들어가는 버튼", () => {
  const p = { radiusKm: 5, searching: false, hasOrigin: true };
  const listOf = (stations: NearbyStation[]) =>
    nearbyView({ ...base, hasOrigin: true, source: "me", result: res(stations) });
  const full = [st(1, "full"), st(2, "full"), st(3, "full"), st(4, "unavailable")];
  expect(peekInfo({ ...p, view: listOf(full) })).toMatchObject({
    kind: "message",
    more: 3,
    moreLabel: "충전 중인 3곳 보기",
  });
  const off = [st(1, "unavailable"), st(2, "unavailable")];
  expect(peekInfo({ ...p, view: listOf(off) })).toMatchObject({
    kind: "message",
    more: 2,
    moreLabel: "2곳 보기",
  });
  // 충전소 없음에는 펼칠 것이 없어 버튼이 없다. 정보 수신 불가는 다시 시도만
  const none = peekInfo({ ...p, view: { kind: "none", notice: false } });
  expect(none).not.toHaveProperty("more");
  expect(none).not.toHaveProperty("moreLabel");
  const stale = peekInfo({ ...p, view: { kind: "stale", notice: false } });
  expect(stale).toMatchObject({ action: "retry" });
  expect(stale).not.toHaveProperty("more");
});

test("peekInfo: 지난번 위치 안내는 안내 문구와 함께여도 남는다", () => {
  const p = { radiusKm: 5, searching: false, hasOrigin: true };
  const fallback = nearbyView({
    ...base,
    hasOrigin: true,
    source: "last",
    locFailure: "failed",
    result: res([st(1, "full")]),
  });
  expect(peekInfo({ ...p, view: fallback })).toMatchObject({
    kind: "message",
    title: "5km 안에 지금 빈 급속충전소가 없어요",
    subtitle: "지난번 위치 기준이에요",
  });
  expect(peekInfo({ ...p, view: { kind: "none", notice: true } })).toEqual({
    kind: "message",
    title: "30km 안에 급속충전소가 없어요",
    subtitle: "지난번 위치 기준이에요",
  });
  expect(peekInfo({ ...p, view: { kind: "stale", notice: true } })).toEqual({
    kind: "message",
    title: "지금 충전소 정보를 받지 못하고 있어요",
    subtitle: "지난번 위치 기준이에요",
    action: "retry",
  });
  // 안내가 없으면 subtitle도 없다
  expect(peekInfo({ ...p, view: { kind: "none", notice: false } })).not.toHaveProperty(
    "subtitle",
  );
});

test("peekInfo: 다시 시도 중에도 정보 수신 불가 줄과 버튼을 그대로 둔다", () => {
  expect(
    peekInfo({
      radiusKm: 5,
      searching: true,
      hasOrigin: true,
      view: { kind: "stale", notice: false },
    }),
  ).toEqual({
    kind: "message",
    title: "지금 충전소 정보를 받지 못하고 있어요",
    action: "retry",
  });
});

test("작은 화면(웹뷰 높이 560px 미만)은 지도 시트 대신 쌓인 배치", () => {
  expect(MIN_MAP_LAYOUT_HEIGHT).toBe(560);
  expect(canUseMapLayout(559)).toBe(false);
  expect(canUseMapLayout(560)).toBe(true);
  expect(canUseMapLayout(844)).toBe(true);
});

test("지도 위 떠 있는 버튼: 자리가 모자라면 '내 위치'부터 숨긴다", () => {
  const h = 44;
  const gap = 8;
  // 둘 다 들어간다
  expect(floatButtons({ space: 2 * h + gap, here: true, buttonH: h, gap })).toEqual({
    showHere: true,
    showMe: true,
  });
  // 하나만 들어가면 "이 위치에서 찾기"를 남긴다
  expect(floatButtons({ space: 2 * h + gap - 1, here: true, buttonH: h, gap })).toEqual({
    showHere: true,
    showMe: false,
  });
  // 찾기 버튼이 없으면 내 위치 하나만 들어가면 된다
  expect(floatButtons({ space: h, here: false, buttonH: h, gap })).toEqual({
    showHere: false,
    showMe: true,
  });
  // 하나도 안 들어가면 둘 다 숨긴다
  expect(floatButtons({ space: h - 1, here: true, buttonH: h, gap })).toEqual({
    showHere: false,
    showMe: false,
  });
});

test("다른 지역에서 찾기를 누르면 지역 선택", () => {
  expect(
    nearbyView({
      ...base,
      hasOrigin: true,
      source: "me",
      result: res([st(1, "available")]),
      regionsRequested: true,
    }),
  ).toEqual({ kind: "regions", reason: "pick" });
});

test("확인 시각은 기기 시간 기준 '{H}시 {mm}분'", () => {
  const iso = new Date(2026, 10, 19, 14, 5).toISOString();
  expect(fetchedText(iso)).toBe(
    "14시 05분 확인 · 공공데이터라 현장과 다를 수 있어요",
  );
  const morning = new Date(2026, 10, 19, 9, 30).toISOString();
  expect(fetchedText(morning)).toBe(
    "9시 30분 확인 · 공공데이터라 현장과 다를 수 있어요",
  );
});

test("같은 좌표를 다시 지도 중심으로 주면 살짝 다르게 준다", () => {
  const p = { lat: 37.5, lng: 127 };
  expect(nextCenter(null, p)).toBe(p);
  const again = nextCenter(p, { ...p });
  expect(again).not.toEqual(p);
  expect(Math.abs(again.lat - p.lat)).toBeLessThan(1e-6);
  expect(nextCenter(again, p)).toEqual(p);
  expect(nextCenter(p, { lat: 35, lng: 129 })).toEqual({ lat: 35, lng: 129 });
});

test("충전소가 없을 때 둘째 줄은 지도가 있을 때만 지도를 옮기라고 한다", () => {
  expect(noneDesc(false)).toBe("지도를 옮겨 다른 곳에서 찾아보세요");
  expect(noneDesc(true)).toBe("다른 지역에서 찾아보세요");
});
