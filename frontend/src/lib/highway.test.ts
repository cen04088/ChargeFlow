import { afterEach, expect, test, vi } from "vitest";

import type { BypassStation, Congestion, HighwayNode } from "../api/types";
import {
  AUTO_PICK_KM,
  hasChargers,
  listedRestAreas,
  loadLastHighway,
  raAriaLabel,
  raPin,
  raStatus,
  saveLastHighway,
  stationPin,
} from "./highway";

afterEach(() => {
  vi.unstubAllGlobals();
});

function cg(p: Partial<Congestion>): Congestion {
  return {
    level: "unknown",
    label: "",
    color: "gray",
    available: null,
    charging: null,
    offline: null,
    total: null,
    turnover_30m: null,
    checked_at: null,
    ...p,
  };
}

function st(p: Partial<BypassStation>): BypassStation {
  return {
    id: 1,
    name: "충전소",
    address: "",
    place_type: "etc",
    latitude: "37",
    longitude: "127",
    power_kw: 100,
    connector_type: "",
    charger_count: 2,
    operator: "",
    open_hours: "",
    distance_km: 1,
    drive_minutes: 3,
    route_memo: "",
    is_recommended: false,
    is_estimated: false,
    kakao_place_id: "",
    connectors: [],
    realtime: null,
    detour_extra_minutes: 8,
    ...p,
  };
}

function node(id: number, c?: Congestion, type: "RA" | "IC" = "RA"): HighwayNode {
  return {
    id,
    sequence: id,
    node_type: type,
    name: `휴게소${id}`,
    latitude: "37",
    longitude: "127",
    distance_from_start_km: id * 10,
    congestion: c,
  };
}

function memoryStorage() {
  const store: Record<string, string> = {};
  vi.stubGlobal("localStorage", {
    getItem: (k: string) => store[k] ?? null,
    setItem: (k: string, v: string) => {
      store[k] = v;
    },
  });
  return store;
}

test("AUTO_PICK_KM", () => {
  expect(AUTO_PICK_KM).toBe(20);
});

test("raPin: 설계 표 그대로", () => {
  expect(raPin(cg({ level: "smooth", available: 4 }))).toEqual({ text: "4대", kind: "available" });
  expect(raPin(cg({ level: "normal", available: 3 }))).toEqual({ text: "3대", kind: "available" });
  expect(raPin(cg({ level: "busy", available: 1 }))).toEqual({ text: "1대", kind: "full" });
  expect(raPin(cg({ level: "jammed", available: 0 }))).toEqual({ text: "만석", kind: "full" });
  expect(raPin(cg({ level: "unavailable" }))).toEqual({ text: "이용 불가", kind: "unavailable" });
  expect(raPin(cg({ level: "unknown", available: null }))).toEqual({ text: "정보 없음", kind: "unavailable" });
});

test("raPin: 빈 대수를 모르면 라벨을 글자로", () => {
  expect(raPin(cg({ level: "smooth", label: "여유" }))).toEqual({ text: "여유", kind: "available" });
  expect(raPin(cg({ level: "normal", label: "보통" }))).toEqual({ text: "보통", kind: "available" });
  expect(raPin(cg({ level: "busy", label: "혼잡" }))).toEqual({ text: "혼잡", kind: "full" });
});

test("hasChargers", () => {
  expect(hasChargers(undefined)).toBe(false);
  expect(hasChargers(cg({ level: "unknown" }))).toBe(false);
  expect(hasChargers(cg({ level: "unknown", total: 3 }))).toBe(true);
  expect(hasChargers(cg({ level: "smooth", available: 2, total: 4 }))).toBe(true);
  expect(hasChargers(cg({ level: "unavailable", total: 0 }))).toBe(true);
});

test("listedRestAreas: 상태를 아는 곳이 있으면 충전기 있는 휴게소만, IC는 빼고", () => {
  const nodes = [
    node(1, cg({ level: "smooth", available: 2, total: 4 })),
    node(2, undefined, "IC"),
    node(3, cg({ level: "unknown" })),
    node(4, cg({ level: "jammed", available: 0, total: 2 })),
  ];
  expect(listedRestAreas(nodes).map((n) => n.id)).toEqual([1, 4]);
});

test("listedRestAreas: 모든 휴게소가 정보 없음이면(집계가 멈춤) 지금 목록처럼 전부", () => {
  const nodes = [node(1, cg({})), node(2, undefined, "IC"), node(3, cg({}))];
  expect(listedRestAreas(nodes).map((n) => n.id)).toEqual([1, 3]);
  expect(listedRestAreas([])).toEqual([]);
});

test("stationPin: 빈 대수를 알면 'N대 · M분'", () => {
  expect(
    stationPin(st({ realtime: { available: 3, total: 4, checked_at: "" }, detour_extra_minutes: 6 })),
  ).toEqual({ text: "3대 · 6분", kind: "available", known: true });
  expect(
    stationPin(st({ realtime: { available: 0, total: 2, checked_at: "" }, detour_extra_minutes: 9 })),
  ).toEqual({ text: "0대 · 9분", kind: "full", known: true });
});

test("stationPin: 모르면 'M분', 쓸 수 있는 곳으로 두되 known false", () => {
  expect(stationPin(st({ realtime: null, detour_extra_minutes: 16 }))).toEqual({
    text: "16분",
    kind: "available",
    known: false,
  });
});

test("last highway: 저장소가 막혀도 던지지 않는다", () => {
  vi.stubGlobal("localStorage", {
    getItem() {
      throw new Error("blocked");
    },
    setItem() {
      throw new Error("blocked");
    },
  });
  expect(loadLastHighway()).toBeNull();
  expect(() => saveLastHighway("gyeongbu", "DOWN")).not.toThrow();
});

test("last highway: 저장하고 다시 읽는다", () => {
  const store = memoryStorage();
  expect(loadLastHighway()).toBeNull();
  saveLastHighway("gyeongbu", "UP");
  expect(JSON.parse(store["highway:last"])).toEqual({ code: "gyeongbu", dir: "UP" });
  expect(loadLastHighway()).toEqual({ code: "gyeongbu", dir: "UP" });
});

test("last highway: 잘못된 값은 null", () => {
  const store = memoryStorage();
  store["highway:last"] = "{not json";
  expect(loadLastHighway()).toBeNull();
  store["highway:last"] = JSON.stringify({ code: "gyeongbu", dir: "LEFT" });
  expect(loadLastHighway()).toBeNull();
  store["highway:last"] = JSON.stringify({ code: 3, dir: "UP" });
  expect(loadLastHighway()).toBeNull();
  store["highway:last"] = JSON.stringify({ code: "", dir: "UP" });
  expect(loadLastHighway()).toBeNull();
  store["highway:last"] = "null";
  expect(loadLastHighway()).toBeNull();
});

test("raStatus: 상태 단어 + 빈 대수, 색은 핀과 같은 상태", () => {
  expect(raStatus(cg({ level: "busy", label: "혼잡", available: 1 }))).toEqual({
    text: "혼잡 · 1대",
    word: "혼잡",
    count: "1대",
    kind: "full",
  });
  expect(raStatus(cg({ level: "normal", label: "보통", available: 1 }))).toMatchObject({
    text: "보통 · 1대",
    kind: "available",
  });
  expect(raStatus(cg({ level: "smooth", label: "여유", available: 3 }))).toMatchObject({
    text: "여유 · 3대",
    word: "여유",
    count: "3대",
    kind: "available",
  });
  const only = (text: string, kind: string) => ({ text, word: text, count: null, kind });
  expect(raStatus(cg({ level: "smooth", label: "여유", available: null }))).toEqual(only("여유", "available"));
  expect(raStatus(cg({ level: "jammed", label: "만석", available: 0 }))).toEqual(only("만석", "full"));
  expect(raStatus(cg({ level: "unavailable", label: "이용 불가" }))).toEqual(only("이용 불가", "unavailable"));
  expect(raStatus(cg({ level: "unknown", label: "정보 없음" }))).toEqual(only("정보 없음", "unavailable"));
  expect(raStatus(undefined)).toEqual(only("정보 없음", "unavailable"));
});

test("raAriaLabel: 이름 + 상태 단어 + 빈 대수 문구", () => {
  expect(raAriaLabel("기흥휴게소", cg({ level: "busy", label: "혼잡", available: 1 }))).toBe(
    "기흥휴게소 혼잡 빈 충전기 1대",
  );
  expect(raAriaLabel("양산휴게소", cg({ level: "jammed", label: "만석", available: 0 }))).toBe(
    "양산휴게소 만석 빈 충전기 0대",
  );
  expect(raAriaLabel("안성휴게소", cg({ level: "unavailable", label: "이용 불가", available: 0 }))).toBe(
    "안성휴게소 이용 불가",
  );
  expect(raAriaLabel("망향휴게소", cg({ level: "unknown", label: "정보 없음" }))).toBe("망향휴게소 정보 없음");
  expect(raAriaLabel("망향휴게소", undefined)).toBe("망향휴게소 정보 없음");
});
