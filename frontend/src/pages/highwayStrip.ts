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
const START_LABEL = "기점";

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
}): { items: StripItem[]; passedCount: number; aheadCount: number } {
  const { nodes, listed, travel, nearId, query, showPassed } = input;
  if (listed.length === 0) return { items: [], passedCount: 0, aheadCount: 0 };
  const keep = new Set(listed.map((n) => n.id));
  const rows = nodes.filter((n) => n.node_type === "IC" || keep.has(n.id));

  const nextAt = travel ? rows.findIndex((n) => n.id === travel.nextId) : -1;
  const ahead = nextAt >= 0 && travel ? travel : null;
  const isPassed = (n: HighwayNode, i: number) =>
    !!ahead &&
    i < nextAt &&
    (n.node_type === "RA" || n.distance_from_start_km < ahead.meKm);
  const km = (n: HighwayNode, passed: boolean) => {
    if (!ahead) {
      const d = Math.round(n.distance_from_start_km);
      return d === 0 ? START_LABEL : `${d}km`;
    }
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
  /** 앞으로 남은 휴게소 수(가는 방향이 아니면 전체) */
  const aheadCount = all.filter((it) => it.kind === "ra" && !it.passed).length;

  const q = query.replace(/\s/g, "");
  if (q) {
    return {
      items: all.filter(
        (it) => it.kind === "ra" && it.node.name.replace(/\s/g, "").includes(q),
      ),
      passedCount,
      aheadCount,
    };
  }
  if (!ahead) return { items: all, passedCount: 0, aheadCount };

  const passedOf = (it: StripItem) => (it.kind === "ra" || it.kind === "ic") && it.passed;
  const passedItems = all.filter(passedOf);
  const aheadItems = all.filter((it) => !passedOf(it));
  const head: StripItem[] = showPassed
    ? passedItems
    : passedCount > 0
      ? [{ kind: "passed-toggle", count: passedCount }]
      : [];
  return { items: [...head, { kind: "me" }, ...aheadItems], passedCount, aheadCount };
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

/**
 * 내 위치를 노선 위 거리(기점부터 km)로: 이웃한 정류장 사이 구간 중 가장 가까운 구간에 수선의 발을 내리고
 * 그 구간의 기점 거리를 비례로 나눈다. 첫 구간 앞·마지막 구간 뒤는 그 방향으로 늘려 음수·끝 넘는 값을 준다.
 * 곡선에서도 직선거리보다 정확해 바로 앞 IC를 지난 것으로 잘못 숨기지 않는다.
 */
export function alongRouteKm(nodes: HighwayNode[], me: LatLng): number | null {
  if (nodes.length === 0) return null;
  if (nodes.length === 1) return nodes[0].distance_from_start_km;
  // 내 위치 둘레의 평면 근사(km)
  const k = Math.cos((me.lat * Math.PI) / 180);
  const toXY = (n: HighwayNode) => ({
    x: (+n.longitude - me.lng) * 111.32 * k,
    y: (+n.latitude - me.lat) * 111.32,
  });
  let best: { dist: number; km: number } | null = null;
  for (let i = 0; i + 1 < nodes.length; i++) {
    const a = toXY(nodes[i]);
    const b = toXY(nodes[i + 1]);
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const len2 = dx * dx + dy * dy;
    let t = len2 > 0 ? (-a.x * dx - a.y * dy) / len2 : 0;
    // 양 끝 구간만 바깥으로 늘린다
    const lo = i === 0 ? -Infinity : 0;
    const hi = i + 2 === nodes.length ? Infinity : 1;
    t = Math.min(hi, Math.max(lo, t));
    const px = a.x + t * dx;
    const py = a.y + t * dy;
    const dist = Math.hypot(px, py);
    const d0 = nodes[i].distance_from_start_km;
    const d1 = nodes[i + 1].distance_from_start_km;
    const km = d0 + t * (d1 - d0);
    if (!best || dist < best.dist) best = { dist, km };
  }
  return best ? best.km : null;
}

/** 가까운 휴게소로 자동 스크롤할지: 대상이 있고, 이 노선·방향에서 아직 손대지 않았고(spent 아님), 검색 중이 아닐 때만 */
export function shouldAutoScroll(input: {
  targetId: number | null;
  spent: boolean;
  searching: boolean;
}): boolean {
  return input.targetId != null && !input.spent && !input.searching;
}
