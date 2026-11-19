import { expect, test } from "vitest";

import type { Congestion, HighwayNode, NearbyRestArea } from "../api/types";
import {
  aheadText,
  highwayPeek,
  nearestRestArea,
  nextRestArea,
  pickStart,
} from "./highwayState";

const UNKNOWN: Congestion = {
  level: "unknown",
  label: "정보 없음",
  color: "gray",
  available: null,
  charging: null,
  offline: null,
  total: null,
  turnover_30m: null,
  checked_at: null,
};

function near(p: Partial<NearbyRestArea>): NearbyRestArea {
  return {
    id: 7,
    name: "기흥휴게소",
    highway_code: "gyeongbu",
    highway_name: "경부고속도로",
    direction: "DOWN",
    latitude: "37.2",
    longitude: "127.1",
    distance_km: 12,
    congestion: UNKNOWN,
    ...p,
  };
}

const CODES = ["gyeongbu", "yeongdong"];

test("pickStart: 20km 안의 가는 방향 휴게소 → auto", () => {
  expect(
    pickStart({ nearest: [near({ distance_km: 12 })], matched: true, last: null, codes: CODES }),
  ).toEqual({ by: "auto", code: "gyeongbu", dir: "DOWN", nextId: 7 });
});

test("pickStart: 방향을 몰라도(정차) 20km 안이면 auto", () => {
  expect(
    pickStart({
      nearest: [near({ distance_km: 19.9, direction: "UP" })],
      matched: false,
      last: { code: "yeongdong", dir: "DOWN" },
      codes: CODES,
    }),
  ).toEqual({ by: "auto", code: "gyeongbu", dir: "UP", nextId: 7 });
});

test("pickStart: 멀면 마지막 노선", () => {
  expect(
    pickStart({
      nearest: [near({ distance_km: 25 })],
      matched: true,
      last: { code: "yeongdong", dir: "UP" },
      codes: CODES,
    }),
  ).toEqual({ by: "last", code: "yeongdong", dir: "UP" });
});

test("pickStart: 멀고 마지막도 없으면 시트", () => {
  expect(
    pickStart({ nearest: [near({ distance_km: 25 })], matched: true, last: null, codes: CODES }),
  ).toEqual({ by: "sheet" });
  expect(pickStart({ nearest: [], matched: false, last: null, codes: CODES })).toEqual({
    by: "sheet",
  });
});

test("pickStart: 위치 실패(null)면 마지막 노선 또는 시트", () => {
  expect(
    pickStart({ nearest: null, matched: false, last: { code: "gyeongbu", dir: "DOWN" }, codes: CODES }),
  ).toEqual({ by: "last", code: "gyeongbu", dir: "DOWN" });
  expect(pickStart({ nearest: null, matched: false, last: null, codes: CODES })).toEqual({
    by: "sheet",
  });
});

test("pickStart: 목록에 없는 노선 코드는 건너뛴다", () => {
  expect(
    pickStart({
      nearest: [near({ distance_km: 5, highway_code: "gone" })],
      matched: true,
      last: { code: "yeongdong", dir: "UP" },
      codes: CODES,
    }),
  ).toEqual({ by: "last", code: "yeongdong", dir: "UP" });
  expect(
    pickStart({
      nearest: [near({ distance_km: 5, highway_code: "gone" })],
      matched: true,
      last: { code: "old", dir: "UP" },
      codes: CODES,
    }),
  ).toEqual({ by: "sheet" });
});

/** 남쪽으로 가는 노선의 휴게소 네 곳: 위도 37.0, 36.8, 36.6, 36.4 (경도 127.0) */
function ra(id: number, lat: number, km: number): HighwayNode {
  return {
    id,
    sequence: id,
    node_type: "RA",
    name: `휴게소${id}`,
    latitude: String(lat),
    longitude: "127.0",
    distance_from_start_km: km,
    congestion: UNKNOWN,
  };
}
const ROUTE = [ra(1, 37.0, 10), ra(2, 36.8, 32), ra(3, 36.6, 54), ra(4, 36.4, 76)];

test("nextRestArea: 첫 휴게소 전이면 첫 휴게소", () => {
  const r = nextRestArea({ nodes: ROUTE, me: { lat: 37.1, lng: 127.0 } });
  expect(r?.id).toBe(1);
  expect(r?.aheadKm).toBe(11);
});

test("nextRestArea: 10km 미만은 소수 첫째 자리", () => {
  const r = nextRestArea({ nodes: ROUTE, me: { lat: 36.85, lng: 127.0 } });
  expect(r?.id).toBe(2);
  expect(r?.aheadKm).toBe(5.6);
});

test("nextRestArea: 첫째와 둘째 사이면 둘째", () => {
  expect(nextRestArea({ nodes: ROUTE, me: { lat: 36.9, lng: 127.0 } })?.id).toBe(2);
  // 첫째를 막 지났다
  expect(nextRestArea({ nodes: ROUTE, me: { lat: 36.98, lng: 127.0 } })?.id).toBe(2);
  // 둘째에 거의 다 왔다
  expect(nextRestArea({ nodes: ROUTE, me: { lat: 36.82, lng: 127.0 } })?.id).toBe(2);
});

test("nextRestArea: 마지막 휴게소를 지났으면 null", () => {
  expect(nextRestArea({ nodes: ROUTE, me: { lat: 36.3, lng: 127.0 } })).toBeNull();
});

test("nextRestArea: 노선에서 20km 넘게 떨어졌으면 null", () => {
  expect(nextRestArea({ nodes: ROUTE, me: { lat: 36.9, lng: 127.4 } })).toBeNull();
});

test("nextRestArea: 위치가 없거나 휴게소가 없으면 null", () => {
  expect(nextRestArea({ nodes: ROUTE, me: null })).toBeNull();
  expect(nextRestArea({ nodes: [], me: { lat: 37, lng: 127 } })).toBeNull();
});

test("nextRestArea: 10km 이상은 정수로", () => {
  const r = nextRestArea({ nodes: ROUTE, me: { lat: 37.15, lng: 127.0 } });
  expect(r?.id).toBe(1);
  expect(r?.aheadKm).toBe(17);
});

test("highwayPeek: 불러오는 중", () => {
  expect(highwayPeek({ nodes: [], next: null, near: null, travel: true, directionLabel: "부산 방향", loading: true })).toEqual({
    kind: "message",
    title: "휴게소를 불러오고 있어요",
  });
});

test("highwayPeek: 휴게소 0곳", () => {
  expect(
    highwayPeek({ nodes: [], next: null, near: null, travel: true, directionLabel: "부산 방향", loading: false }),
  ).toEqual({ kind: "message", title: "이 방향에 충전소가 있는 휴게소가 없어요" });
});

test("highwayPeek: 다음 휴게소", () => {
  expect(
    highwayPeek({
      nodes: ROUTE,
      next: { id: 2, aheadKm: 12 },
      near: null,
      travel: true,
      directionLabel: "부산 방향",
      loading: false,
    }),
  ).toEqual({
    kind: "next",
    label: "다음 휴게소 · 약 12km 앞",
    node: ROUTE[1],
    more: 2,
    moreLabel: "이후 휴게소 2곳 보기",
  });
});

test("highwayPeek: 위치가 노선 위가 아니면 첫 휴게소", () => {
  expect(
    highwayPeek({ nodes: ROUTE, next: null, near: null, travel: true, directionLabel: "부산 방향", loading: false }),
  ).toEqual({
    kind: "first",
    label: "부산 방향 첫 휴게소",
    node: ROUTE[0],
    more: 3,
    moreLabel: "휴게소 4곳 보기",
  });
  // 다음 휴게소가 이 목록에 없으면(노선을 바꾼 직후 등) 첫 휴게소로
  expect(
    highwayPeek({ nodes: ROUTE, next: { id: 99, aheadKm: 3 }, near: null, travel: true, directionLabel: "부산 방향", loading: false })
      .kind,
  ).toBe("first");
});

test("highwayPeek: 한 곳뿐이면 more 0", () => {
  const p = highwayPeek({ nodes: [ROUTE[0]], next: null, near: null, travel: true, directionLabel: "서울 방향", loading: false });
  expect(p).toMatchObject({ kind: "first", label: "서울 방향 첫 휴게소", more: 0 });
  const q = highwayPeek({
    nodes: ROUTE,
    next: { id: 4, aheadKm: 3.4 },
    near: null,
    travel: true,
    directionLabel: "서울 방향",
    loading: false,
  });
  expect(q).toMatchObject({ kind: "next", label: "다음 휴게소 · 약 3.4km 앞", more: 0 });
});

test("aheadText: 내 위치(기점부터 km)를 알면 '약 Nkm 앞', 모르면 기점부터", () => {
  expect(aheadText(ROUTE[2], 40)).toBe("약 14km 앞");
  expect(aheadText(ROUTE[1], 28.75)).toBe("약 3.3km 앞");
  expect(aheadText(ROUTE[1], 40)).toBe("약 0km 앞");
  expect(aheadText(ROUTE[2], null)).toBe("기점에서 54km");
});

test("highwayPeek: 가는 방향이 아니면(방향을 바꿨거나 정차 중 자동 선택) '다음'이라고 하지 않는다", () => {
  // 위치상 다음 휴게소가 있어도 travel이 false면 next를 쓰지 않는다 — 가까운 휴게소로
  expect(
    highwayPeek({
      nodes: ROUTE,
      next: { id: 2, aheadKm: 3 },
      near: { id: 2, km: 3 },
      travel: false,
      directionLabel: "서울 방향",
      loading: false,
    }),
  ).toEqual({
    kind: "near",
    label: "서울 방향 가까운 휴게소",
    node: ROUTE[1],
    more: 3,
    moreLabel: "휴게소 4곳 보기",
  });
  // 노선에서 멀면(near 없음) 첫 휴게소
  expect(
    highwayPeek({
      nodes: ROUTE,
      next: { id: 2, aheadKm: 3 },
      near: null,
      travel: false,
      directionLabel: "서울 방향",
      loading: false,
    }),
  ).toMatchObject({ kind: "first", label: "서울 방향 첫 휴게소", node: ROUTE[0] });
});

test("highwayPeek: 가는 방향인데 다음 휴게소가 없으면(종점 지남) 가까운 휴게소 또는 첫 휴게소", () => {
  expect(
    highwayPeek({
      nodes: ROUTE,
      next: null,
      near: { id: 4, km: 11 },
      travel: true,
      directionLabel: "부산 방향",
      loading: false,
    }),
  ).toMatchObject({ kind: "near", label: "부산 방향 가까운 휴게소", node: ROUTE[3] });
});

test("nearestRestArea: 20km 안의 가장 가까운 휴게소(앞뒤 상관없이)", () => {
  expect(nearestRestArea({ nodes: ROUTE, me: { lat: 36.62, lng: 127.0 } })).toEqual({ id: 3, km: 2.2 });
  // 마지막 휴게소를 지났어도 가까운 곳은 있다
  expect(nearestRestArea({ nodes: ROUTE, me: { lat: 36.3, lng: 127.0 } })?.id).toBe(4);
  expect(nearestRestArea({ nodes: ROUTE, me: { lat: 36.9, lng: 127.4 } })).toBeNull();
  expect(nearestRestArea({ nodes: ROUTE, me: null })).toBeNull();
  expect(nearestRestArea({ nodes: [], me: { lat: 37, lng: 127 } })).toBeNull();
});
