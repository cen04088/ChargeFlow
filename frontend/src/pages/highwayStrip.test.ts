import { expect, test } from "vitest";

import type { HighwayNode } from "../api/types";
import { buildStrip, fitProjection, kmLabel } from "./highwayStrip";

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
    "ic:신갈IC:0km",
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
  expect(brief(one.items)).toEqual(["ic:신갈IC:0km", "ra:기흥휴게소:10km", "ic:오산IC:20km"]);
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
