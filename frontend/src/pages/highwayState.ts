import type { Direction, HighwayNode, NearbyRestArea } from "../api/types";
import { AUTO_PICK_KM } from "../lib/highway";

export type HighwayStart =
  | { by: "auto"; code: string; dir: Direction; nextId: number }
  | { by: "last"; code: string; dir: Direction }
  | { by: "sheet" };

/**
 * /highways로 들어왔을 때 보여 줄 노선: 20km 안의 휴게소(가는 방향 우선) → 마지막에 본 노선 → 노선 고르기 시트.
 * 방향을 모르더라도(정차 중) 20km 안이면 그 휴게소의 노선·방향을 고른다.
 */
export function pickStart(input: {
  nearest: NearbyRestArea[] | null;
  matched: boolean;
  last: { code: string; dir: Direction } | null;
  codes: string[];
}): HighwayStart {
  const { nearest, last, codes } = input;
  const first = nearest?.[0];
  if (first && first.distance_km <= AUTO_PICK_KM && codes.includes(first.highway_code)) {
    return { by: "auto", code: first.highway_code, dir: first.direction, nextId: first.id };
  }
  if (last && codes.includes(last.code)) {
    return { by: "last", code: last.code, dir: last.dir };
  }
  return { by: "sheet" };
}

interface Point {
  lat: number;
  lng: number;
}

/** 두 좌표 사이 직선거리(km) */
export function distanceKm(a: Point, b: Point): number {
  const r = Math.PI / 180;
  const h =
    Math.sin(((b.lat - a.lat) * r) / 2) ** 2 +
    Math.cos(a.lat * r) * Math.cos(b.lat * r) * Math.sin(((b.lng - a.lng) * r) / 2) ** 2;
  return 6371 * 2 * Math.asin(Math.min(1, Math.sqrt(h)));
}

const at = (n: HighwayNode): Point => ({ lat: +n.latitude, lng: +n.longitude });

/** 10km 미만은 소수 첫째 자리, 이상은 정수 */
function roundKm(km: number): number {
  return km >= 10 ? Math.round(km) : Math.round(km * 10) / 10;
}

/**
 * 가는 방향으로 다음에 만날 휴게소. 가장 가까운 휴게소 i를 찾고(20km 넘게 떨어졌으면 노선 위가 아니다 → null),
 * 이미 i를 지났으면 i+1을 고른다: 다음 휴게소까지가 i와 그 다음 사이보다 가까우면 지난 것이다.
 * i가 마지막이면 바로 앞 휴게소로 같은 판정을 해서, 지났으면 null.
 */
export function nextRestArea(input: {
  nodes: HighwayNode[];
  me: Point | null;
}): { id: number; aheadKm: number } | null {
  const { nodes, me } = input;
  if (!me || nodes.length === 0) return null;
  const d = nodes.map((n) => distanceKm(me, at(n)));
  let i = 0;
  d.forEach((v, k) => {
    if (v < d[i]) i = k;
  });
  if (d[i] > AUTO_PICK_KM) return null;
  let pick = i;
  if (i + 1 < nodes.length) {
    if (d[i + 1] < distanceKm(at(nodes[i]), at(nodes[i + 1]))) pick = i + 1;
  } else if (i > 0) {
    if (d[i - 1] > distanceKm(at(nodes[i - 1]), at(nodes[i]))) return null;
  }
  return { id: nodes[pick].id, aheadKm: roundKm(d[pick]) };
}

/** 가는 방향과 상관없이 가장 가까운 휴게소(20km 안). 노선에서 멀면 null */
export function nearestRestArea(input: {
  nodes: HighwayNode[];
  me: Point | null;
}): { id: number; km: number } | null {
  const { nodes, me } = input;
  if (!me || nodes.length === 0) return null;
  let best: { id: number; km: number } | null = null;
  for (const n of nodes) {
    const km = distanceKm(me, at(n));
    if (!best || km < best.km) best = { id: n.id, km };
  }
  if (!best || best.km > AUTO_PICK_KM) return null;
  return { id: best.id, km: roundKm(best.km) };
}

export type HighwayPeek =
  | { kind: "next"; label: string; node: HighwayNode; more: number; moreLabel: string }
  | { kind: "near"; label: string; node: HighwayNode; more: number; moreLabel: string }
  | { kind: "first"; label: string; node: HighwayNode; more: number; moreLabel: string }
  | { kind: "message"; title: string };

/**
 * 고속도로 화면의 접힌 시트.
 * - 이 방향이 이용자가 가는 방향(travel)이고 다음 휴게소가 있으면 "다음 휴게소 · 약 Nkm 앞"
 * - 아니면(방향을 바꿨거나, 정차 중 자동 선택, 마지막 노선 등) 노선 가까이 있을 때 "{방향} 가까운 휴게소"
 *   — 앞뒤를 모르므로 "앞"이라고 하지 않는다
 * - 위치가 없거나 노선에서 멀면 "{방향} 첫 휴게소"
 */
export function highwayPeek(input: {
  nodes: HighwayNode[];
  next: { id: number; aheadKm: number } | null;
  near: { id: number; km: number } | null;
  travel: boolean;
  directionLabel: string;
  loading: boolean;
}): HighwayPeek {
  const { nodes, next, near, travel, directionLabel, loading } = input;
  if (loading) return { kind: "message", title: "휴게소를 불러오고 있어요" };
  if (nodes.length === 0) {
    return { kind: "message", title: "이 방향에 충전소가 있는 휴게소가 없어요" };
  }
  const all = { more: nodes.length - 1, moreLabel: `휴게소 ${nodes.length}곳 보기` };
  const k = travel && next ? nodes.findIndex((n) => n.id === next.id) : -1;
  if (next && k >= 0) {
    const more = nodes.length - k - 1;
    return {
      kind: "next",
      label: `다음 휴게소 · 약 ${next.aheadKm}km 앞`,
      node: nodes[k],
      more,
      moreLabel: `이후 휴게소 ${more}곳 보기`,
    };
  }
  const nearNode = near ? nodes.find((n) => n.id === near.id) : undefined;
  if (nearNode) {
    return { kind: "near", label: `${directionLabel} 가까운 휴게소`, node: nearNode, ...all };
  }
  return { kind: "first", label: `${directionLabel} 첫 휴게소`, node: nodes[0], ...all };
}

/**
 * 목록 줄 설명: 내 위치(기점부터 km, meKm)를 알면 "약 Nkm 앞", 모르면 "기점에서 Nkm".
 * 기점부터 거리는 가는 순서로 커진다.
 */
export function aheadText(node: HighwayNode, meKm: number | null): string {
  if (meKm == null) return `기점에서 ${Math.round(node.distance_from_start_km)}km`;
  return `약 ${roundKm(Math.max(0, node.distance_from_start_km - meKm))}km 앞`;
}

/** 이보다 오래된 위치로는 "다음 휴게소 · 앞"을 말하지 않는다(ms) */
export const TRAVEL_FRESH_MS = 120_000;

/**
 * "가는 방향" 표시를 유지할지. 다시 열었거나(뒤로가기·앱 복귀) 갱신에 실패해 위치가 2분 넘게 묵었으면
 * "stale"(새 위치가 올 때까지 가는 방향이 아닌 것처럼 보인다). 새 위치가 노선에서 멀거나 마지막 휴게소를
 * 지났으면(nextIdx -1), 또는 다음 휴게소가 가는 순서에서 뒤로 갔으면(반대로 가는 중) "drop".
 */
export function checkTravel(input: {
  fixAt: number | null;
  now: number;
  nextIdx: number;
  prevNextIdx: number | null;
}): "keep" | "stale" | "drop" {
  const { fixAt, now, nextIdx, prevNextIdx } = input;
  if (fixAt == null || now - fixAt > TRAVEL_FRESH_MS) return "stale";
  if (nextIdx < 0) return "drop";
  if (prevNextIdx != null && prevNextIdx >= 0 && nextIdx < prevNextIdx) return "drop";
  return "keep";
}
