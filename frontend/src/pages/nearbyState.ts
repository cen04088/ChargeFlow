import type { NearbyStation, NearbyStationsResponse } from "../api/types";
import { listRows } from "../lib/nearby";

export interface Point {
  lat: number;
  lng: number;
}

export type LocFailure = "denied" | "failed";
/** 검색 기준점이 어디서 왔는지: 지난번 위치, 내 위치, 지역 선택, 이 위치에서 찾기 */
export type OriginSource = "last" | "me" | "region" | "here";

export interface ViewInput {
  hasOrigin: boolean;
  source: OriginSource | null;
  result: NearbyStationsResponse | null;
  /** 마지막 검색 오류의 HTTP 상태(네트워크 오류는 0 등), 오류가 없으면 null */
  errorStatus: number | null;
  locFailure: LocFailure | null;
  /** 지도를 못 띄운 화면에서 "다른 지역에서 찾기"를 눌렀다 */
  regionsRequested: boolean;
  expanded: boolean;
}

export type NearbyView =
  | { kind: "loading" }
  | { kind: "regions"; reason: LocFailure | "pick" }
  | { kind: "error" }
  | { kind: "none"; notice: boolean }
  | {
      kind: "list";
      rows: NearbyStation[];
      hidden: number;
      fallback: boolean;
      notice: boolean;
    };

/** 지금 보여 줄 화면 상태를 고른다 */
export function nearbyView(v: ViewInput): NearbyView {
  if (v.regionsRequested) return { kind: "regions", reason: "pick" };
  // 서버가 좌표를 받지 않았다(국외 등) — 지역을 고르게 한다
  if (v.errorStatus === 400) {
    return { kind: "regions", reason: v.locFailure ?? "failed" };
  }
  if (v.result) {
    // 위치를 못 받았지만 지난번 위치 결과가 있으면 그대로 두고 작은 안내만 붙인다
    const notice = v.source === "last" && v.locFailure != null;
    if (v.result.stations.length === 0) return { kind: "none", notice };
    return { kind: "list", ...listRows(v.result.stations, v.expanded), notice };
  }
  if (v.errorStatus != null) return { kind: "error" };
  if (!v.hasOrigin && v.locFailure) {
    return { kind: "regions", reason: v.locFailure };
  }
  return { kind: "loading" };
}

/** "14시 05분 확인 · 공공데이터라 현장과 다를 수 있어요" (기기 시간대 기준) */
export function fetchedText(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "공공데이터라 현장과 다를 수 있어요";
  const mm = String(d.getMinutes()).padStart(2, "0");
  return `${d.getHours()}시 ${mm}분 확인 · 공공데이터라 현장과 다를 수 있어요`;
}

/**
 * 지도 중심으로 넘길 값. 이전과 좌표가 같으면 지도가 움직이지 않으므로
 * (이용자가 끌어 놓은 뒤 같은 곳을 다시 고른 경우) 눈에 띄지 않을 만큼 살짝 다르게 준다.
 */
export function nextCenter(prev: Point | null, p: Point): Point {
  if (prev && prev.lat === p.lat && prev.lng === p.lng) {
    return { lat: p.lat + 1e-7, lng: p.lng };
  }
  return p;
}

/** 충전소가 하나도 없을 때 둘째 줄 — 지도가 없으면 지도를 옮기라고 하지 않는다 */
export function noneDesc(mapFailed: boolean): string {
  return mapFailed
    ? "다른 지역에서 찾아보세요"
    : "지도를 옮겨 다른 곳에서 찾아보세요";
}
