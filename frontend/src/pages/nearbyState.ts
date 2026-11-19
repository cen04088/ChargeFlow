import type { NearbyStation, NearbyStationsResponse } from "../api/types";
import { listRows, type ListFallback } from "../lib/nearby";

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
  /** 결과가 비었고 서버가 상태 정보를 못 받고 있다고 알려 왔다 */
  | { kind: "stale"; notice: boolean }
  | {
      kind: "list";
      rows: NearbyStation[];
      hidden: number;
      fallback: ListFallback;
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
    if (v.result.stations.length === 0) {
      // 예전 응답처럼 feed_stale이 없으면 false로 본다
      return { kind: v.result.feed_stale === true ? "stale" : "none", notice };
    }
    return { kind: "list", ...listRows(v.result.stations, v.expanded), notice };
  }
  if (v.errorStatus != null) return { kind: "error" };
  if (!v.hasOrigin && v.locFailure) {
    return { kind: "regions", reason: v.locFailure };
  }
  return { kind: "loading" };
}

/** 위치 응답을 기다리는 최대 시간 — 넘으면 "찾지 못함"과 같이 다룬다 */
export const LOCATE_TIMEOUT_MS = 12000;

type LocResult =
  | { ok: true; lat: number; lng: number }
  | { ok: false; reason: LocFailure };

/**
 * 위치 요청을 시간 제한과 겨룬다. 제한 안에 오면 그 결과를, 넘으면
 * { ok: false, reason: "failed" }를 돌려주고, 늦게 온 실제 응답은 onLate로 넘긴다.
 * signal이 취소되면(화면을 떠남) 타이머를 지우고, 이후 어떤 응답도 반영하지 않는다
 * (돌려준 Promise는 끝나지 않는다).
 */
export function locateWithTimeout<T extends LocResult>(
  get: () => Promise<T>,
  ms: number,
  onLate: (r: T) => void,
  signal?: AbortSignal,
): Promise<T | { ok: false; reason: "failed" }> {
  return new Promise((resolve) => {
    if (signal?.aborted) return;
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      resolve({ ok: false, reason: "failed" });
    }, ms);
    signal?.addEventListener("abort", () => clearTimeout(timer), { once: true });
    get().then(
      (r) => {
        if (signal?.aborted) return;
        if (timedOut) onLate(r);
        else {
          clearTimeout(timer);
          resolve(r);
        }
      },
      () => {
        if (timedOut || signal?.aborted) return;
        clearTimeout(timer);
        resolve({ ok: false, reason: "failed" });
      },
    );
  });
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

/** 빈 곳이 없어 대신 보여 주는 목록 위 두 줄 */
export function fallbackCopy(
  fallback: Exclude<ListFallback, false>,
  radiusKm: number,
): { title: string; desc: string } {
  return fallback === "full"
    ? {
        title: `${radiusKm}km 안에 지금 빈 급속충전소가 없어요`,
        desc: "충전 중인 곳을 가까운 순서로 보여 드려요",
      }
    : {
        title: `${radiusKm}km 안에 지금 쓸 수 있는 급속충전소가 없어요`,
        desc: "점검 중이거나 연결이 끊긴 곳만 있어요",
      };
}

/** 충전소가 하나도 없을 때 둘째 줄 — 지도가 없으면 지도를 옮기라고 하지 않는다 */
export function noneDesc(mapFailed: boolean): string {
  return mapFailed
    ? "다른 지역에서 찾아보세요"
    : "지도를 옮겨 다른 곳에서 찾아보세요";
}
