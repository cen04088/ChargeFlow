import { afterEach, expect, test, vi } from "vitest";

import type { NearbyStation } from "../api/types";
import {
  DOT_LEVEL,
  INSET_REFIT_MIN_PX,
  INSET_REFIT_WINDOW_MS,
  REGIONS,
  ULTRA_FAST_KW,
  checkedText,
  countText,
  declutterPins,
  pinPriority,
  type Rect,
  isDotLevel,
  isUltraFast,
  listRows,
  loadLastLocation,
  pinLabel,
  pinText,
  roundCoord,
  rowCaption,
  saveLastLocation,
  sheetRows,
  shouldRefitForInset,
  summaryText,
} from "./nearby";

const NOW = Date.parse("2026-11-19T12:00:00+09:00");
const iso = (ms: number) => new Date(ms).toISOString();

function st(over: Partial<NearbyStation> = {}): NearbyStation {
  return {
    id: 1,
    stat_id: "S1",
    name: "테스트 충전소",
    address: "서울",
    latitude: "37.5",
    longitude: "127.0",
    distance_km: 1.2,
    power_kw: 100,
    operator: "테스트",
    open_hours: "24시간",
    connectors: ["combo"],
    available: 1,
    charging: 1,
    offline: 0,
    total: 2,
    state: "available",
    checked_at: iso(NOW),
    ...over,
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

function memoryStorage(store: Record<string, string> = {}) {
  vi.stubGlobal("localStorage", {
    getItem: (k: string) => store[k] ?? null,
    setItem: (k: string, v: string) => {
      store[k] = v;
    },
  });
  return store;
}

test("roundCoord", () => {
  expect(roundCoord(37.251234)).toBe(37.251);
  expect(roundCoord(127.0715)).toBe(127.072);
});
test("roundCoord handles exponent notation and non-finite input", () => {
  expect(roundCoord(1e-7)).toBe(0);
  expect(roundCoord(-1e-7)).toBe(0);
  expect(roundCoord(1e21)).toBe(1e21);
  expect(roundCoord(-37.2516)).toBe(-37.252);
  expect(roundCoord(0.0005)).toBe(0.001);
  expect(roundCoord(NaN)).toBeNaN();
  expect(roundCoord(Infinity)).toBeNaN();
  expect(roundCoord(-Infinity)).toBeNaN();
});
test("loadLastLocation rejects values outside Korea or non-finite", () => {
  const key = "nearby:last-location";
  const store = memoryStorage();
  for (const v of [
    { lat: 51.5, lng: -0.12 },
    { lat: 37.5, lng: 140 },
    { lat: 32.9, lng: 127 },
    { lat: "37.5", lng: 127 },
    { lat: null, lng: 127 },
  ]) {
    store[key] = JSON.stringify(v);
    expect(loadLastLocation()).toBeNull();
  }
  store[key] = '{"lat":1e400,"lng":127}'; // JSON.parse → Infinity
  expect(loadLastLocation()).toBeNull();
  store[key] = JSON.stringify({ lat: 33.0, lng: 132.0 });
  expect(loadLastLocation()).toEqual({ lat: 33.0, lng: 132.0 });
});
test("pinText and countText", () => {
  expect(pinText(st({ state: "available", available: 3 }))).toBe("3대");
  expect(pinText(st({ state: "full", available: 0 }))).toBe("충전 중");
  expect(countText(st({ state: "full", available: 0 }))).toBe("충전 중");
  expect(countText(st({ state: "unavailable", available: 0 }))).toBe("이용 불가");
});
test("isUltraFast / pinLabel", () => {
  expect(ULTRA_FAST_KW).toBe(150);
  expect(isUltraFast(st({ power_kw: 150 }))).toBe(true);
  expect(isUltraFast(st({ power_kw: 149 }))).toBe(false);
  expect(pinLabel(st({ state: "available", available: 3 }), "count")).toBe("3대");
  expect(pinLabel(st({ state: "full", available: 0 }), "count")).toBe("충전 중");
  expect(pinLabel(st({ state: "unavailable", available: 0 }), "count")).toBe("이용 불가");
  expect(pinLabel(st({ power_kw: 200, state: "full", available: 0 }), "power")).toBe("200kW");
});
test("shouldRefitForInset: one chance per fit, only right after it", () => {
  const fit = { userMoved: false, hasFitted: true, refitSpent: false };
  expect(INSET_REFIT_WINDOW_MS).toBe(1000);
  // 맞출 때 이미 맞는 높이였고, 한참 뒤(60초 갱신 등)에 바뀌면 → 다시 맞추지 않는다
  expect(
    shouldRefitForInset({ ...fit, msSinceFit: 60_000, prevInset: 236, nextInset: 111 }),
  ).toBe(false);
  // 맞출 때 너무 낮았고(찾는 중 한 줄), 곧 실제 높이가 오면 → 한 번 다시 맞춘다
  expect(
    shouldRefitForInset({ ...fit, msSinceFit: 200, prevInset: 111, nextInset: 236 }),
  ).toBe(true);
  // 그 기회를 쓴 뒤의 두 번째 변화 → 다시 맞추지 않는다
  expect(
    shouldRefitForInset({
      ...fit,
      refitSpent: true,
      msSinceFit: 400,
      prevInset: 236,
      nextInset: 300,
    }),
  ).toBe(false);
  expect(
    shouldRefitForInset({ ...fit, msSinceFit: 1000, prevInset: 111, nextInset: 236 }),
  ).toBe(false);
});
test("shouldRefitForInset: only before the user moves, after a fit, on a real change", () => {
  const ok = {
    userMoved: false,
    hasFitted: true,
    refitSpent: false,
    msSinceFit: 100,
    prevInset: 111,
    nextInset: 236,
  };
  expect(INSET_REFIT_MIN_PX).toBe(16);
  expect(shouldRefitForInset(ok)).toBe(true);
  expect(shouldRefitForInset({ ...ok, userMoved: true })).toBe(false);
  expect(shouldRefitForInset({ ...ok, hasFitted: false })).toBe(false);
  expect(shouldRefitForInset({ ...ok, nextInset: 111 + 15 })).toBe(false);
  expect(shouldRefitForInset({ ...ok, nextInset: 111 + 16 })).toBe(true);
  expect(shouldRefitForInset({ ...ok, prevInset: 236, nextInset: 200 })).toBe(true);
});
const box = (left: number, top: number, w = 60, h = 44): Rect => ({
  left,
  top,
  right: left + w,
  bottom: top + h,
});
const pin = (id: number, rect: Rect, priority: number, focused = false) => ({
  id,
  rect,
  priority,
  focused,
});

test("declutterPins: no overlap keeps every pill", () => {
  const kept = declutterPins(
    [pin(1, box(0, 100), 0), pin(2, box(100, 100), 1), pin(3, box(200, 100), 2)],
    [],
  );
  expect([...kept].sort()).toEqual([1, 2, 3]);
});
test("declutterPins: of two overlapping pills the higher priority stays", () => {
  const kept = declutterPins([pin(1, box(30, 100), 5), pin(2, box(0, 100), 1)], []);
  expect([...kept]).toEqual([2]);
});
test("declutterPins: pills closer than 4px count as overlapping", () => {
  expect([...declutterPins([pin(1, box(0, 100), 0), pin(2, box(63, 100), 1)], [])]).toEqual([1]);
  expect([...declutterPins([pin(1, box(0, 100), 0), pin(2, box(70, 100), 1)], [])].sort()).toEqual([1, 2]);
});
test("declutterPins: the focused pin always stays a pill", () => {
  const kept = declutterPins(
    [pin(1, box(0, 100), 0), pin(2, box(10, 100), 9, true)],
    [box(-1000, -1000, 3000, 1110)],
  );
  expect(kept.has(2)).toBe(true);
  expect(kept.has(1)).toBe(false);
});
test("declutterPins: a pill inside a reserved rect becomes a dot", () => {
  const topBand = { left: -Infinity, top: -Infinity, right: Infinity, bottom: 60 };
  const kept = declutterPins([pin(1, box(0, 30), 0), pin(2, box(0, 200), 1)], [topBand]);
  expect([...kept]).toEqual([2]);
});
test("declutterPins: chain A–B–C where B overlaps both and is lowest → A and C stay", () => {
  const kept = declutterPins(
    [pin(1, box(0, 100), 0), pin(2, box(40, 100), 2), pin(3, box(80, 100), 1)],
    [],
  );
  expect([...kept].sort()).toEqual([1, 3]);
});
test("pinPriority: available by order, then full, then unavailable", () => {
  expect(pinPriority("available", 3)).toBeLessThan(pinPriority("full", 0));
  expect(pinPriority("full", 3)).toBeLessThan(pinPriority("unavailable", 0));
  expect(pinPriority("available", 0)).toBeLessThan(pinPriority("available", 1));
});
test("isDotLevel", () => {
  expect(DOT_LEVEL).toBe(7);
  expect(isDotLevel(6)).toBe(false);
  expect(isDotLevel(7)).toBe(true);
});
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
test("rowCaption hides fresh check time", () => {
  expect(rowCaption(st({ distance_km: 1.2, power_kw: 100, checked_at: iso(NOW - 10 * 60000) }), NOW)).toBe("약 1.2km · 100kW");
  expect(rowCaption(st({ distance_km: 0.4, power_kw: 200, checked_at: iso(NOW - 125 * 60000) }), NOW)).toBe("약 400m · 200kW 초급속 · 2시간 전 확인");
  expect(rowCaption(st({ checked_at: null }), NOW)).toBe("약 1.2km · 100kW");
});
test("checkedText", () => {
  expect(checkedText(iso(NOW - 20000), NOW)).toBe("방금 확인");
  expect(checkedText(iso(NOW - 12 * 60000), NOW)).toBe("12분 전 확인");
  expect(checkedText(iso(NOW - 59 * 60000), NOW)).toBe("59분 전 확인");
  expect(checkedText(iso(NOW - 60 * 60000), NOW)).toBe("1시간 전 확인");
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
  expect(listRows(full, false)).toMatchObject({ hidden: 1, fallback: "full" });
});
test("listRows with full and unavailable lists only full ones", () => {
  const off = (id: number) => st({ id, state: "unavailable", available: 0 });
  const full = (id: number) => st({ id, state: "full", available: 0 });
  const mixed = [off(1), full(2), off(3), full(4), full(5), full(6), full(7), off(8)];
  const r = listRows(mixed, false);
  expect(r.fallback).toBe("full");
  expect(r.rows.map((s) => s.id)).toEqual([2, 4, 5]);
  expect(r.hidden).toBe(2);
  expect(listRows(mixed, true).rows.map((s) => s.id)).toEqual([2, 4, 5, 6, 7]);
});
test("listRows with only unavailable stations", () => {
  const off = [1, 2, 3, 4, 5].map((id) => st({ id, state: "unavailable", available: 0 }));
  expect(listRows(off, false)).toMatchObject({ hidden: 2, fallback: "unavailable" });
  expect(listRows(off, false).rows.map((s) => s.id)).toEqual([1, 2, 3]);
});
test("listRows with available stations or nothing has no fallback", () => {
  const some = [st({ id: 1, state: "full", available: 0 }), st({ id: 2 })];
  expect(listRows(some, false)).toEqual({ rows: [some[1]], hidden: 0, fallback: false });
  expect(listRows([], false)).toEqual({ rows: [], hidden: 0, fallback: false });
});
test("summaryText", () => {
  expect(summaryText([st({}), st({ state: "full", available: 0 })])).toBe("급속 · 빈 곳 1곳");
  expect(summaryText([st({ state: "full", available: 0 })])).toBe("급속 · 빈 곳 없음");
});
test("REGIONS covers 17 regions inside Korea", () => {
  expect(REGIONS).toHaveLength(17);
  for (const r of REGIONS) {
    expect(r.lat).toBeGreaterThan(33);
    expect(r.lat).toBeLessThan(38.7);
    expect(r.lng).toBeGreaterThan(124.5);
    expect(r.lng).toBeLessThan(132);
  }
});
test("last location survives storage errors", () => {
  vi.stubGlobal("localStorage", { getItem() { throw new Error("blocked"); }, setItem() { throw new Error("blocked"); } });
  expect(loadLastLocation()).toBeNull();
  expect(() => saveLastLocation(37.2512, 127.0712)).not.toThrow();
});
test("last location round trip", () => {
  memoryStorage();
  saveLastLocation(37.2512, 127.0712);
  expect(loadLastLocation()).toEqual({ lat: 37.251, lng: 127.071 });
});
