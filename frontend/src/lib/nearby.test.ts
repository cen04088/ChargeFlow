import { expect, test, vi } from "vitest";

import type { NearbyStation } from "../api/types";
import {
  REGIONS,
  checkedText,
  countText,
  listRows,
  loadLastLocation,
  pinText,
  roundCoord,
  rowCaption,
  saveLastLocation,
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

test("roundCoord", () => {
  expect(roundCoord(37.251234)).toBe(37.251);
  expect(roundCoord(127.0715)).toBe(127.072);
});
test("pinText and countText", () => {
  expect(pinText(st({ state: "available", available: 3 }))).toBe("3대");
  expect(pinText(st({ state: "full", available: 0 }))).toBe("꽉 참");
  expect(countText(st({ state: "unavailable", available: 0 }))).toBe("이용 불가");
});
test("rowCaption hides fresh check time", () => {
  expect(rowCaption(st({ distance_km: 1.2, power_kw: 100, checked_at: iso(NOW - 10 * 60000) }), NOW)).toBe("약 1.2km · 100kW");
  expect(rowCaption(st({ distance_km: 0.4, power_kw: 200, checked_at: iso(NOW - 125 * 60000) }), NOW)).toBe("약 400m · 200kW · 2시간 전 확인");
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
  expect(listRows(full, false)).toMatchObject({ hidden: 1, fallback: true });
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
  const store: Record<string, string> = {};
  vi.stubGlobal("localStorage", {
    getItem: (k: string) => store[k] ?? null,
    setItem: (k: string, v: string) => { store[k] = v; },
  });
  saveLastLocation(37.2512, 127.0712);
  expect(loadLastLocation()).toEqual({ lat: 37.251, lng: 127.071 });
});
