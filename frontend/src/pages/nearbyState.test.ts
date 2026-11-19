import { expect, test } from "vitest";

import type { NearbyStation, NearbyStationsResponse } from "../api/types";
import {
  fetchedText,
  nearbyView,
  nextCenter,
  noneDesc,
  type ViewInput,
} from "./nearbyState";

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

function res(stations: NearbyStation[]): NearbyStationsResponse {
  return { radius_km: 5, fetched_at: "2026-11-19T05:05:00Z", stations };
}

const base: ViewInput = {
  hasOrigin: false,
  source: null,
  result: null,
  errorStatus: null,
  locFailure: null,
  regionsRequested: false,
  expanded: false,
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

test("충전소가 없으면 none, 빈 곳이 없으면 꽉 찬 곳 목록", () => {
  const r = { ...base, hasOrigin: true, source: "me" as const };
  expect(nearbyView({ ...r, result: res([]) }).kind).toBe("none");
  const v = nearbyView({ ...r, result: res([st(1, "full"), st(2, "unavailable")]) });
  expect(v.kind === "list" && v.fallback).toBe(true);
  expect(v.kind === "list" && v.rows.map((s) => s.id)).toEqual([1, 2]);
});

test("빈 곳만 3곳, 나머지는 더 보기", () => {
  const stations = [1, 2, 3, 4, 5].map((i) => st(i, "available"));
  stations.push(st(6, "full"));
  const r = { ...base, hasOrigin: true, source: "me" as const, result: res(stations) };
  const v = nearbyView(r);
  expect(v.kind === "list" && v.rows.length).toBe(3);
  expect(v.kind === "list" && v.hidden).toBe(2);
  const all = nearbyView({ ...r, expanded: true });
  expect(all.kind === "list" && all.rows.length).toBe(5);
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
