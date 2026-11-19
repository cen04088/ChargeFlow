import { expect, test } from "vitest";

import type { HighwayNode } from "../api/types";
import {
  alongRouteKm,
  buildStrip,
  fitProjection,
  kmLabel,
  shouldAutoScroll,
} from "./highwayStrip";

function n(id: number, type: "IC" | "RA", name: string, km: number, lat = 37): HighwayNode {
  return {
    id,
    sequence: id,
    node_type: type,
    name,
    latitude: String(lat),
    longitude: "127",
    distance_from_start_km: km,
  };
}

// 가는 순서: IC1 0 · 기흥 10 · IC2 20 · 안성 32 · IC3 44 · 망향 54 · 천안 76 · IC4 90
const IC1 = n(1, "IC", "신갈IC", 0);
const RA1 = n(2, "RA", "기흥휴게소", 10);
const IC2 = n(3, "IC", "오산IC", 20);
const RA2 = n(4, "RA", "안성휴게소", 32);
const IC3 = n(5, "IC", "안성IC", 44);
const RA3 = n(6, "RA", "망향휴게소", 54);
const RA4 = n(7, "RA", "천안호두휴게소", 76);
const IC4 = n(8, "IC", "천안IC", 90);
const NODES = [IC1, RA1, IC2, RA2, IC3, RA3, RA4, IC4];
const LISTED = [RA1, RA2, RA3, RA4];

/** 항목을 짧게 적는다: 종류:이름:km[:표시] */
const brief = (items: ReturnType<typeof buildStrip>["items"]) =>
  items.map((it) => {
    if (it.kind === "passed-toggle") return `toggle:${it.count}`;
    if (it.kind === "me") return "me";
    const mark = it.kind === "ra" && it.mark ? `:${it.mark}` : "";
    return `${it.kind}:${it.node.name}:${it.km}${mark}`;
  });

test("kmLabel: 1km 미만은 '곧', 아니면 반올림 km", () => {
  expect(kmLabel(0.4)).toBe("곧");
  expect(kmLabel(0)).toBe("곧");
  expect(kmLabel(1)).toBe("1km");
  expect(kmLabel(12.4)).toBe("12km");
});

test("가는 방향: 지금 여기부터, 지나온 곳은 접고, 다음 휴게소 표시, 앞 거리(곧 포함)", () => {
  const r = buildStrip({
    nodes: NODES,
    listed: LISTED,
    travel: { nextId: RA2.id, meKm: 31.6 },
    nearId: null,
    query: "",
    showPassed: false,
  });
  expect(r.passedCount).toBe(1);
  expect(brief(r.items)).toEqual([
    "toggle:1",
    "me",
    "ra:안성휴게소:곧:next",
    "ic:안성IC:12km",
    "ra:망향휴게소:22km",
    "ra:천안호두휴게소:44km",
    "ic:천안IC:58km",
  ]);
});

test("가는 방향 + 지나온 곳 펼침: 지나온 곳이 지금 여기 위에(버튼은 사라진다)", () => {
  const r = buildStrip({
    nodes: NODES,
    listed: LISTED,
    travel: { nextId: RA2.id, meKm: 31.6 },
    nearId: null,
    query: "",
    showPassed: true,
  });
  expect(brief(r.items)).toEqual([
    "ic:신갈IC:지남",
    "ra:기흥휴게소:지남",
    "ic:오산IC:지남",
    "me",
    "ra:안성휴게소:곧:next",
    "ic:안성IC:12km",
    "ra:망향휴게소:22km",
    "ra:천안호두휴게소:44km",
    "ic:천안IC:58km",
  ]);
  expect(r.items.filter((i) => i.kind !== "me" && i.kind !== "passed-toggle" && i.passed)).toHaveLength(3);
});

test("다음 휴게소 바로 앞 IC는 내 위치보다 앞이면 지나지 않은 것", () => {
  const r = buildStrip({
    nodes: NODES,
    listed: LISTED,
    travel: { nextId: RA2.id, meKm: 18 },
    nearId: null,
    query: "",
    showPassed: false,
  });
  expect(brief(r.items).slice(0, 3)).toEqual(["toggle:1", "me", "ic:오산IC:2km"]);
});

test("가는 방향을 모르고 근처: 노선 전체를 기점부터, 가까운 휴게소 표시", () => {
  const r = buildStrip({
    nodes: NODES,
    listed: LISTED,
    travel: null,
    nearId: RA3.id,
    query: "",
    showPassed: false,
  });
  expect(r.passedCount).toBe(0);
  expect(brief(r.items)).toEqual([
    "ic:신갈IC:기점",
    "ra:기흥휴게소:10km",
    "ic:오산IC:20km",
    "ra:안성휴게소:32km",
    "ic:안성IC:44km",
    "ra:망향휴게소:54km:near",
    "ra:천안호두휴게소:76km",
    "ic:천안IC:90km",
  ]);
});

test("위치가 없으면 표시 없이 노선 전체", () => {
  const r = buildStrip({ nodes: NODES, listed: LISTED, travel: null, nearId: null, query: "", showPassed: false });
  expect(r.items).toHaveLength(8);
  expect(r.items.some((i) => i.kind === "ra" && i.mark)).toBe(false);
  expect(r.items.some((i) => i.kind === "me" || i.kind === "passed-toggle")).toBe(false);
});

test("검색 중: IC·지금 여기·지나온 버튼을 숨기고 맞는 휴게소만(공백 무시)", () => {
  const r = buildStrip({
    nodes: NODES,
    listed: LISTED,
    travel: { nextId: RA2.id, meKm: 31.6 },
    nearId: null,
    query: "안 성",
    showPassed: false,
  });
  expect(brief(r.items)).toEqual(["ra:안성휴게소:곧:next"]);
  const none = buildStrip({ nodes: NODES, listed: LISTED, travel: null, nearId: null, query: "없는곳", showPassed: false });
  expect(none.items).toEqual([]);
});

test("목록에 남기지 않은 휴게소(충전기 없음)는 빠진다", () => {
  const r = buildStrip({ nodes: NODES, listed: [RA1, RA4], travel: null, nearId: null, query: "", showPassed: false });
  expect(brief(r.items).filter((s) => s.startsWith("ra:"))).toEqual(["ra:기흥휴게소:10km", "ra:천안호두휴게소:76km"]);
});

test("휴게소 한 곳뿐 / 0곳", () => {
  const one = buildStrip({ nodes: [IC1, RA1, IC2], listed: [RA1], travel: null, nearId: null, query: "", showPassed: false });
  expect(brief(one.items)).toEqual(["ic:신갈IC:기점", "ra:기흥휴게소:10km", "ic:오산IC:20km"]);
  const zero = buildStrip({ nodes: [IC1, IC2], listed: [], travel: null, nearId: null, query: "", showPassed: false });
  expect(zero.items).toEqual([]);
  expect(zero.passedCount).toBe(0);
});

test("fitProjection: 상자 안(여백 포함)에 비율을 지켜 맞춘다", () => {
  // 세로로 긴 노선: 위도 1도, 경도 0.5도(위도 0이라 cos=1)
  const pts = [
    { lat: 1, lng: 0 },
    { lat: 0, lng: 0.5 },
  ];
  const p = fitProjection(pts, 96, 96, 8);
  const a = p(pts[0]);
  const b = p(pts[1]);
  // 세로가 꽉 찬다(8..88), 가로는 그 절반 폭으로 가운데
  expect(a.y).toBeCloseTo(8);
  expect(b.y).toBeCloseTo(88);
  expect(b.x - a.x).toBeCloseTo(40);
  expect((a.x + b.x) / 2).toBeCloseTo(48);
});

test("fitProjection: 북쪽이 위, 동쪽이 오른쪽", () => {
  const p = fitProjection(
    [
      { lat: 37, lng: 127 },
      { lat: 35, lng: 129 },
    ],
    96,
    96,
    8,
  );
  const nw = p({ lat: 37, lng: 127 });
  const se = p({ lat: 35, lng: 129 });
  expect(nw.y).toBeLessThan(se.y);
  expect(nw.x).toBeLessThan(se.x);
});

test("fitProjection: 점이 모두 같거나 곧은 세로선이어도 상자 가운데에", () => {
  const same = fitProjection([{ lat: 36, lng: 127 }, { lat: 36, lng: 127 }], 96, 96, 8);
  expect(same({ lat: 36, lng: 127 })).toEqual({ x: 48, y: 48 });
  const vertical = fitProjection([{ lat: 37, lng: 127 }, { lat: 35, lng: 127 }], 96, 96, 8);
  const top = vertical({ lat: 37, lng: 127 });
  const bottom = vertical({ lat: 35, lng: 127 });
  expect(top.x).toBeCloseTo(48);
  expect(bottom.x).toBeCloseTo(48);
  expect(top.y).toBeCloseTo(8);
  expect(bottom.y).toBeCloseTo(88);
  const empty = fitProjection([], 96, 96, 8);
  expect(empty({ lat: 1, lng: 1 })).toEqual({ x: 48, y: 48 });
});

test("앞으로 남은 휴게소 수(aheadCount): 가는 방향이면 지나지 않은 휴게소만, 아니면 전체", () => {
  const t = buildStrip({ nodes: NODES, listed: LISTED, travel: { nextId: RA2.id, meKm: 31.6 }, nearId: null, query: "", showPassed: false });
  expect(t.aheadCount).toBe(3);
  const all = buildStrip({ nodes: NODES, listed: LISTED, travel: null, nearId: null, query: "", showPassed: false });
  expect(all.aheadCount).toBe(4);
});

test("기점 거리가 0으로 반올림되면 '기점'", () => {
  const r = buildStrip({ nodes: [n(9, "RA", "서울만남의광장휴게소", 0.3), IC2], listed: [n(9, "RA", "서울만남의광장휴게소", 0.3)], travel: null, nearId: null, query: "", showPassed: false });
  expect(brief(r.items)[0]).toBe("ra:서울만남의광장휴게소:기점");
});

test("검색: 다음 휴게소가 걸러져도 남은 결과는 앞 거리, 맞는 지나온 휴게소는 '지남'", () => {
  const r = buildStrip({
    nodes: NODES,
    listed: LISTED,
    travel: { nextId: RA2.id, meKm: 31.6 },
    nearId: null,
    query: "휴게소",
    showPassed: false,
  });
  expect(brief(r.items)).toEqual([
    "ra:기흥휴게소:지남",
    "ra:안성휴게소:곧:next",
    "ra:망향휴게소:22km",
    "ra:천안호두휴게소:44km",
  ]);
  const noNext = buildStrip({
    nodes: NODES,
    listed: LISTED,
    travel: { nextId: RA2.id, meKm: 31.6 },
    nearId: null,
    query: "망향",
    showPassed: false,
  });
  expect(brief(noNext.items)).toEqual(["ra:망향휴게소:22km"]);
});

test("내 위치가 첫 정류장보다 앞(meKm 음수): 지나온 곳 없이 모두 앞 거리", () => {
  const r = buildStrip({
    nodes: NODES,
    listed: LISTED,
    travel: { nextId: RA1.id, meKm: -3 },
    nearId: null,
    query: "",
    showPassed: false,
  });
  expect(r.passedCount).toBe(0);
  expect(brief(r.items).slice(0, 3)).toEqual(["me", "ic:신갈IC:3km", "ra:기흥휴게소:13km:next"]);
});

test("마지막 휴게소 뒤에 IC가 이어져도 그대로 끝까지", () => {
  const IC5 = n(9, "IC", "목천IC", 95);
  const r = buildStrip({ nodes: [...NODES, IC5], listed: LISTED, travel: { nextId: RA4.id, meKm: 70 }, nearId: null, query: "", showPassed: false });
  expect(brief(r.items).slice(-3)).toEqual(["ra:천안호두휴게소:6km:next", "ic:천안IC:20km", "ic:목천IC:25km"]);
});

test("fitProjection: 위도 37°에서는 경도 폭을 cos(위도)만큼 줄인다", () => {
  // 위도 1도 × 경도 1도 사각형: 37°에서 가로는 세로의 약 0.8배
  const p = fitProjection(
    [
      { lat: 37.5, lng: 127 },
      { lat: 36.5, lng: 128 },
    ],
    96,
    96,
    8,
  );
  const a = p({ lat: 37.5, lng: 127 });
  const b = p({ lat: 36.5, lng: 128 });
  expect(b.y - a.y).toBeCloseTo(80);
  expect((b.x - a.x) / (b.y - a.y)).toBeCloseTo(Math.cos((37 * Math.PI) / 180), 3);
});

/** 남북으로 곧은 노선: 위도 37.0(0km) → 36.9(11.1km) → 36.8(22.2km), 경도 127 */
const LINE = [
  n(1, "IC", "A", 0, 37.0),
  n(2, "RA", "B", 11.1, 36.9),
  n(3, "IC", "C", 22.2, 36.8),
];

test("alongRouteKm: 구간 위면 앞뒤 정류장 사이를 비례로", () => {
  expect(alongRouteKm(LINE, { lat: 36.95, lng: 127 })).toBeCloseTo(5.55, 1);
  expect(alongRouteKm(LINE, { lat: 36.85, lng: 127 })).toBeCloseTo(16.65, 1);
});

test("alongRouteKm: 첫 정류장 전이면 음수, 마지막 뒤면 끝보다 크게", () => {
  expect(alongRouteKm(LINE, { lat: 37.05, lng: 127 })).toBeCloseTo(-5.55, 1);
  expect(alongRouteKm(LINE, { lat: 36.75, lng: 127 })).toBeCloseTo(27.75, 1);
});

test("alongRouteKm: 옆으로 비켜 있어도 가장 가까운 구간에 내린 발", () => {
  expect(alongRouteKm(LINE, { lat: 36.95, lng: 127.05 })).toBeCloseTo(5.55, 1);
  expect(alongRouteKm([], { lat: 37, lng: 127 })).toBeNull();
  expect(alongRouteKm([LINE[0]], { lat: 37, lng: 127 })).toBe(0);
});

test("alongRouteKm: 꺾인 노선에서는 꺾인 뒤 구간에 내린다", () => {
  // 남쪽으로 내려가다(0→11.1km) 동쪽으로 꺾인다(11.1→20km)
  const bend = [
    n(1, "IC", "A", 0, 37.0),
    { ...n(2, "RA", "B", 11.1, 36.9) },
    { ...n(3, "IC", "C", 20, 36.9), longitude: "127.1" },
  ];
  // 꺾인 뒤 구간의 가운데 바로 아래: 앞 구간(남북)보다 뒤 구간(동서)이 가깝다
  expect(alongRouteKm(bend, { lat: 36.895, lng: 127.05 })).toBeCloseTo(15.55, 0);
});

test("shouldAutoScroll: 대상이 있고, 손대기 전이고, 검색 중이 아닐 때만", () => {
  expect(shouldAutoScroll({ targetId: 3, spent: false, searching: false })).toBe(true);
  expect(shouldAutoScroll({ targetId: null, spent: false, searching: false })).toBe(false);
  expect(shouldAutoScroll({ targetId: 3, spent: true, searching: false })).toBe(false);
  expect(shouldAutoScroll({ targetId: 3, spent: false, searching: true })).toBe(false);
});
