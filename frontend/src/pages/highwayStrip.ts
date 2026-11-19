import type { HighwayNode } from "../api/types";

/**
 * 노선 띠(내비 고속도로 모드)의 줄 목록. 가는 순서로 휴게소와 IC를 늘어놓는다.
 * - 가는 방향이 확인됐으면(travel) "지금 여기"부터 앞에 있는 것만, 지나온 곳은 접는다(passed-toggle)
 * - 아니면 기점부터 노선 전체, 근처면 가까운 휴게소(near)를 표시
 * - 검색 중이면 맞는 휴게소만(IC·지금 여기·지나온 버튼 없음)
 */
export type StripItem =
  | { kind: "passed-toggle"; count: number }
  | { kind: "me" }
  | {
      kind: "ra";
      node: HighwayNode;
      /** 왼쪽 거리 칸 글자 */
      km: string;
      mark: "next" | "near" | null;
      passed: boolean;
    }
  | { kind: "ic"; node: HighwayNode; km: string; passed: boolean };

/** 앞으로 남은 거리: 1km 미만은 "곧" */
export function kmLabel(km: number): string {
  return km < 1 ? "곧" : `${Math.round(km)}km`;
}

const PASSED_LABEL = "지남";

export function buildStrip(input: {
  /** 이 방향의 IC·휴게소 전체(가는 순서) */
  nodes: HighwayNode[];
  /** 띠에 올릴 휴게소(listedRestAreas) */
  listed: HighwayNode[];
  /** 가는 방향이고 위치가 새것일 때: 다음 휴게소와 내 위치(기점부터 km) */
  travel: { nextId: number; meKm: number } | null;
  /** 가는 방향을 모를 때 노선 근처면 가장 가까운 휴게소 */
  nearId: number | null;
  query: string;
  showPassed: boolean;
}): { items: StripItem[]; passedCount: number } {
  const { nodes, listed, travel, nearId, query, showPassed } = input;
  if (listed.length === 0) return { items: [], passedCount: 0 };
  const keep = new Set(listed.map((n) => n.id));
  const rows = nodes.filter((n) => n.node_type === "IC" || keep.has(n.id));

  const nextAt = travel ? rows.findIndex((n) => n.id === travel.nextId) : -1;
  const ahead = nextAt >= 0 && travel ? travel : null;
  const isPassed = (n: HighwayNode, i: number) =>
    !!ahead &&
    i < nextAt &&
    (n.node_type === "RA" || n.distance_from_start_km < ahead.meKm);
  const km = (n: HighwayNode, passed: boolean) => {
    if (!ahead) return `${Math.round(n.distance_from_start_km)}km`;
    if (passed) return PASSED_LABEL;
    return kmLabel(Math.max(0, n.distance_from_start_km - ahead.meKm));
  };
  const toItem = (n: HighwayNode, i: number): StripItem => {
    const passed = isPassed(n, i);
    if (n.node_type === "IC") return { kind: "ic", node: n, km: km(n, passed), passed };
    const mark =
      ahead && n.id === ahead.nextId ? "next" : !ahead && n.id === nearId ? "near" : null;
    return { kind: "ra", node: n, km: km(n, passed), mark, passed };
  };
  const all = rows.map(toItem);
  const passedCount = all.filter((it) => it.kind === "ra" && it.passed).length;

  const q = query.replace(/\s/g, "");
  if (q) {
    return {
      items: all.filter(
        (it) => it.kind === "ra" && it.node.name.replace(/\s/g, "").includes(q),
      ),
      passedCount,
    };
  }
  if (!ahead) return { items: all, passedCount: 0 };

  const passedOf = (it: StripItem) => (it.kind === "ra" || it.kind === "ic") && it.passed;
  const passedItems = all.filter(passedOf);
  const aheadItems = all.filter((it) => !passedOf(it));
  const head: StripItem[] = showPassed
    ? passedItems
    : passedCount > 0
      ? [{ kind: "passed-toggle", count: passedCount }]
      : [];
  return { items: [...head, { kind: "me" }, ...aheadItems], passedCount };
}

interface LatLng {
  lat: number;
  lng: number;
}

/**
 * 작은 지도 창 좌표: 위경도를 w×h 상자(여백 pad)에 맞춘다. 등장방형(경도에 평균 위도의 cos)으로
 * 가로세로 비율을 지키고 가운데에 둔다. 북쪽이 위. 점이 없거나 한 점이면 상자 가운데.
 */
export function fitProjection(
  points: LatLng[],
  w: number,
  h: number,
  pad: number,
): (p: LatLng) => { x: number; y: number } {
  const center = { x: w / 2, y: h / 2 };
  if (points.length === 0) return () => center;
  const lats = points.map((p) => p.lat);
  const midLat = (Math.min(...lats) + Math.max(...lats)) / 2;
  const k = Math.cos((midLat * Math.PI) / 180);
  const xs = points.map((p) => p.lng * k);
  const ys = points.map((p) => -p.lat);
  const minX = Math.min(...xs);
  const maxX = Math.max(...xs);
  const minY = Math.min(...ys);
  const maxY = Math.max(...ys);
  const spanX = maxX - minX;
  const spanY = maxY - minY;
  const scales = [
    spanX > 0 ? (w - 2 * pad) / spanX : Infinity,
    spanY > 0 ? (h - 2 * pad) / spanY : Infinity,
  ];
  const s = Math.min(...scales);
  if (!Number.isFinite(s)) return () => center;
  const cx = (minX + maxX) / 2;
  const cy = (minY + maxY) / 2;
  return (p) => ({
    x: center.x + (p.lng * k - cx) * s,
    y: center.y + (-p.lat - cy) * s,
  });
}
