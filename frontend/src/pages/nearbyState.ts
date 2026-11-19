import type { NearbyStation, NearbyStationsResponse } from "../api/types";
import { listRows, sheetRows, type ListFallback } from "../lib/nearby";

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
  /** 쌓인 목록에서 "N곳 더 보기"를 눌렀다 */
  expanded: boolean;
  /** 지도 시트가 아니라 쌓인 목록(처음 3곳 + 더 보기)으로 보인다 —
   *  지도를 못 띄웠거나 화면이 낮을 때. 아니면 지도 시트에 고른 묶음 전부를 넘긴다 */
  stacked: boolean;
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
    const rows = v.stacked
      ? listRows(v.result.stations, v.expanded)
      : { ...sheetRows(v.result.stations), hidden: 0 };
    return { kind: "list", ...rows, notice };
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

/** 끌기를 놓았을 때 이 이동량(px) 미만이면 끌기가 아니라 누르기로 본다 */
export const SHEET_TAP_PX = 8;
/** 이 속도(px/ms) 이상으로 튕기면 이동량과 상관없이 그 방향으로 */
const SHEET_FLICK_VY = 0.5;
/** 느린 끌기는 접힘↔펼침 차이의 이 비율을 넘어야 반대 상태로 */
const SHEET_SNAP_RATIO = 0.3;

/**
 * 목록 시트 손잡이를 놓았을 때 펼칠지(true) 접을지(false).
 * dy: 시작점 대비 이동(위로 끌면 음수), vy: 놓는 순간 속도(px/ms, 위가 음수),
 * range: 접힘↔펼침 높이 차. 8px 미만이면 현재 상태를 그대로 돌려준다(누르기는 호출부가 토글).
 */
export function sheetSnap(input: {
  open: boolean;
  dy: number;
  vy: number;
  range: number;
}): boolean {
  const { open, dy, vy, range } = input;
  if (Math.abs(dy) < SHEET_TAP_PX) return open;
  if (Math.abs(vy) >= SHEET_FLICK_VY) return vy < 0;
  const threshold = range * SHEET_SNAP_RATIO;
  return open ? !(dy > threshold) : -dy > threshold;
}

/** 접힌 시트에 보일 한 줄: 가장 가까운 빈 곳, 또는 지금 상태의 안내 제목 */
export type PeekInfo =
  | { kind: "station"; label: string; station: NearbyStation; more: number }
  | {
      kind: "message";
      title: string;
      /** 지난번 위치로 보여 주는 중이면 제목 아래 한 줄 */
      subtitle?: string;
      action?: "retry";
      /** 펼치면 보일 줄 수 — 있으면 시트를 펼치는 버튼(moreLabel)을 둔다 */
      more?: number;
      moreLabel?: string;
    };

const LAST_LOCATION_SUBTITLE = "지난번 위치 기준이에요";

/**
 * searching은 지금 검색이 진행 중인지다. 이전 결과가 있으면 그 결과의 줄을 그대로 두고
 * (본문이 진행을 알린다), 결과가 없을 때(view가 loading)만 찾는 중 문구가 된다.
 */
export function peekInfo(input: {
  view: NearbyView;
  radiusKm: number;
  searching: boolean;
  hasOrigin: boolean;
}): PeekInfo {
  const { view, radiusKm, hasOrigin } = input;
  // 지역 선택·오류 화면에는 시트가 없다. 혹시 불려도 찾는 중 문구로 둔다
  if (view.kind === "loading" || view.kind === "regions" || view.kind === "error") {
    return {
      kind: "message",
      title: hasOrigin ? "급속충전소를 찾고 있어요" : "현재 위치를 확인하고 있어요",
    };
  }
  const notice = view.notice ? { subtitle: LAST_LOCATION_SUBTITLE } : {};
  if (view.kind === "stale") {
    return {
      kind: "message",
      title: "지금 충전소 정보를 받지 못하고 있어요",
      ...notice,
      action: "retry",
    };
  }
  if (view.kind === "none") {
    return { kind: "message", title: "30km 안에 급속충전소가 없어요", ...notice };
  }
  if (view.fallback) {
    const n = view.rows.length;
    return {
      kind: "message",
      title: fallbackCopy(view.fallback, radiusKm).title,
      ...notice,
      more: n,
      moreLabel: view.fallback === "full" ? `충전 중인 ${n}곳 보기` : `${n}곳 보기`,
    };
  }
  return {
    kind: "station",
    label: view.notice ? "지난번 위치에서 가장 가까운 빈 곳" : "가장 가까운 빈 곳",
    station: view.rows[0],
    more: view.rows.length - 1,
  };
}

/** 웹뷰 높이가 이보다 낮으면(가로 화면 등) 지도 시트 대신 쌓인 배치로 — 잘리지 않고 스크롤된다 */
export const MIN_MAP_LAYOUT_HEIGHT = 560;

export function canUseMapLayout(viewportHeight: number): boolean {
  return viewportHeight >= MIN_MAP_LAYOUT_HEIGHT;
}

/**
 * 지도 위 떠 있는 버튼("이 위치에서 찾기" 위, "내 위치" 아래로 쌓음) 중 무엇을 보일지.
 * space는 위쪽 줄과 접힌 시트 사이의 높이. 모자라면 "내 위치"부터 숨긴다
 * (지역 선택 → 내 위치로 찾기로도 갈 수 있다).
 */
export function floatButtons(input: {
  space: number;
  here: boolean;
  buttonH: number;
  gap: number;
}): { showHere: boolean; showMe: boolean } {
  const { space, here, buttonH, gap } = input;
  const showHere = here && space >= buttonH;
  const showMe = space >= (showHere ? 2 * buttonH + gap : buttonH);
  return { showHere, showMe };
}

/** 충전소가 하나도 없을 때 둘째 줄 — 지도가 없으면 지도를 옮기라고 하지 않는다 */
export function noneDesc(mapFailed: boolean): string {
  return mapFailed
    ? "다른 지역에서 찾아보세요"
    : "지도를 옮겨 다른 곳에서 찾아보세요";
}
