import type { NearbyStation } from "../api/types";
import { formatKm } from "./format";

export const LIST_INITIAL = 3;

const STORAGE_KEY = "nearby:last-location";
const STALE_MIN = 30;

/** 서버 in_korea와 같은 범위 */
const KOREA_LAT = [33.0, 38.7] as const;
const KOREA_LNG = [124.5, 132.0] as const;

/** 소수 셋째 자리로 반올림 (십진 표기 기준이라 부동소수 오차에 흔들리지 않는다).
 *  유한하지 않은 값만 NaN */
export function roundCoord(n: number): number {
  if (!Number.isFinite(n)) return NaN;
  // 지수 표기는 |n| < 1e-6(반올림하면 0) 또는 |n| >= 1e21(이미 정수)일 때만 나온다
  if (String(n).includes("e")) return Math.abs(n) < 1 ? 0 : n;
  return Number(`${Math.round(Number(`${n}e3`))}e-3`) || 0;
}

function inKorea(lat: number, lng: number): boolean {
  return (
    lat >= KOREA_LAT[0] && lat <= KOREA_LAT[1] && lng >= KOREA_LNG[0] && lng <= KOREA_LNG[1]
  );
}

/** 이 출력(kW) 이상이면 초급속 — 핀에 번개, 목록에 "초급속" */
export const ULTRA_FAST_KW = 150;
/** 카카오 지도 레벨이 이 값 이상(더 축소)이면 핀을 글자 없는 점으로 줄인다 */
export const DOT_LEVEL = 7;

/** 핀 글자: 빈 대수·상태("count") 또는 최대 출력("power") */
export type PinMode = "count" | "power";

export function pinText(s: NearbyStation): string {
  if (s.state === "available") return `${s.available}대`;
  return s.state === "full" ? "충전 중" : "이용 불가";
}

export function countText(s: NearbyStation): string {
  return pinText(s);
}

export function isUltraFast(s: NearbyStation): boolean {
  return s.power_kw >= ULTRA_FAST_KW;
}

export function pinLabel(s: NearbyStation, mode: PinMode): string {
  return mode === "power" ? `${s.power_kw}kW` : pinText(s);
}

export function isDotLevel(level: number): boolean {
  return level >= DOT_LEVEL;
}

/** 화면 좌표의 사각형(px) */
export interface Rect {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

/** 핀 사이에 둘 최소 간격(px) — 이보다 가까우면 겹친 것으로 본다 */
export const PIN_GAP_PX = 4;

function overlaps(a: Rect, b: Rect): boolean {
  return a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;
}

/** 겹칠 때 어느 핀을 글자로 남길지: 작을수록 먼저. 빈 곳(목록 순서 = 가까운 순) → 충전 중 → 이용 불가 */
export function pinPriority(state: NearbyStation["state"], index: number): number {
  const group = state === "available" ? 0 : state === "full" ? 1 : 2;
  return group * 100_000 + index;
}

/**
 * 겹치는 핀 정리: 우선순위 순으로 훑으며, 이미 남긴 핀(간격 PIN_GAP_PX 포함)이나
 * 가려진 자리(reserved: 지도 위 칩·토글 줄 등)와 겹치면 점으로 줄인다.
 * 강조한 핀은 언제나 글자로 남는다. 글자로 남길 핀의 id를 돌려준다.
 */
export function declutterPins(
  items: { id: number; rect: Rect; priority: number; focused: boolean }[],
  reserved: Rect[],
): Set<number> {
  const order = [...items].sort((a, b) =>
    a.focused !== b.focused ? (a.focused ? -1 : 1) : a.priority - b.priority,
  );
  const kept: Rect[] = [];
  const ids = new Set<number>();
  for (const it of order) {
    const r = it.rect;
    const padded: Rect = {
      left: r.left - PIN_GAP_PX,
      top: r.top - PIN_GAP_PX,
      right: r.right + PIN_GAP_PX,
      bottom: r.bottom + PIN_GAP_PX,
    };
    const blocked =
      kept.some((k) => overlaps(padded, k)) || reserved.some((z) => overlaps(r, z));
    if (it.focused || !blocked) {
      kept.push(r);
      ids.add(it.id);
    }
  }
  return ids;
}

/** 접힌 시트 높이가 이만큼(px) 이상 바뀌어야 범위를 다시 맞춘다 */
export const INSET_REFIT_MIN_PX = 16;

/** 맞춘 뒤 이 시간(ms) 안에 온 시트 높이 변화만 다시 맞춤의 대상이다 */
export const INSET_REFIT_WINDOW_MS = 1000;

/**
 * 지도 아래를 가리는 시트 높이가 바뀌었을 때 범위를 한 번 더 맞출지.
 * 첫 맞춤 때는 시트에 아직 "찾고 있어요" 한 줄이라 높이가 작다 — 그 직후 실제 높이가 오는
 * 경우만 고친다. 맞춤마다 기회는 한 번(refitSpent)이고, 맞춘 직후(INSET_REFIT_WINDOW_MS)만,
 * 이용자가 지도를 건드리지 않았고, 높이가 실제로(INSET_REFIT_MIN_PX 이상) 바뀐 경우만.
 * 한참 뒤의 변화(60초 갱신 등)로 보고 있는 지도가 움직이지 않게 한다.
 */
export function shouldRefitForInset(input: {
  userMoved: boolean;
  hasFitted: boolean;
  refitSpent: boolean;
  msSinceFit: number;
  prevInset: number;
  nextInset: number;
}): boolean {
  const { userMoved, hasFitted, refitSpent, msSinceFit, prevInset, nextInset } =
    input;
  if (userMoved || !hasFitted || refitSpent) return false;
  if (msSinceFit >= INSET_REFIT_WINDOW_MS) return false;
  return Math.abs(nextInset - prevInset) >= INSET_REFIT_MIN_PX;
}

export function checkedText(iso: string | null, now: number): string {
  if (!iso) return "";
  const min = Math.floor((now - new Date(iso).getTime()) / 60000);
  if (min < 1) return "방금 확인";
  if (min < 60) return `${min}분 전 확인`;
  return `${Math.floor(min / 60)}시간 전 확인`;
}

export function rowCaption(s: NearbyStation, now: number): string {
  const base = `약 ${formatKm(s.distance_km)} · ${s.power_kw}kW${
    isUltraFast(s) ? " 초급속" : ""
  }`;
  if (!s.checked_at) return base;
  const min = (now - new Date(s.checked_at).getTime()) / 60000;
  return min > STALE_MIN ? `${base} · ${checkedText(s.checked_at, now)}` : base;
}

/** 빈 곳이 없을 때 대신 보여 주는 목록 종류: 충전 중 → 이용 불가 순 */
export type ListFallback = false | "full" | "unavailable";

/** 목록에 올릴 묶음: 빈 곳 → 없으면 충전 중 → 없으면 이용 불가. 자르지 않는다 */
export function sheetRows(stations: NearbyStation[]): {
  rows: NearbyStation[];
  fallback: ListFallback;
} {
  let fallback: ListFallback = false;
  let pool = stations.filter((s) => s.state === "available");
  if (pool.length === 0) {
    pool = stations.filter((s) => s.state === "full");
    fallback = "full";
  }
  if (pool.length === 0) {
    pool = stations.filter((s) => s.state === "unavailable");
    fallback = "unavailable";
  }
  if (pool.length === 0) fallback = false;
  return { rows: pool, fallback };
}

/** 지도 실패 화면의 쌓인 목록: sheetRows와 같은 묶음을 처음엔 3곳까지만 */
export function listRows(
  stations: NearbyStation[],
  expanded: boolean,
): { rows: NearbyStation[]; hidden: number; fallback: ListFallback } {
  const { rows: pool, fallback } = sheetRows(stations);
  const rows = expanded ? pool : pool.slice(0, LIST_INITIAL);
  return { rows, hidden: pool.length - rows.length, fallback };
}

export function summaryText(stations: NearbyStation[]): string {
  const n = stations.filter((s) => s.state === "available").length;
  return n > 0 ? `급속 · 빈 곳 ${n}곳` : "급속 · 빈 곳 없음";
}

export interface Region {
  name: string;
  lat: number;
  lng: number;
}

export const REGIONS: Region[] = [
  { name: "서울", lat: 37.5665, lng: 126.978 },
  { name: "부산", lat: 35.1796, lng: 129.0756 },
  { name: "대구", lat: 35.8714, lng: 128.6014 },
  { name: "인천", lat: 37.4563, lng: 126.7052 },
  { name: "광주", lat: 35.1595, lng: 126.8526 },
  { name: "대전", lat: 36.3504, lng: 127.3845 },
  { name: "울산", lat: 35.5384, lng: 129.3114 },
  { name: "세종", lat: 36.48, lng: 127.289 },
  { name: "경기", lat: 37.2636, lng: 127.0286 },
  { name: "강원", lat: 37.8813, lng: 127.7298 },
  { name: "충북", lat: 36.6357, lng: 127.4917 },
  { name: "충남", lat: 36.6588, lng: 126.6728 },
  { name: "전북", lat: 35.8242, lng: 127.148 },
  { name: "전남", lat: 34.8161, lng: 126.4629 },
  { name: "경북", lat: 36.576, lng: 128.5056 },
  { name: "경남", lat: 35.2383, lng: 128.6924 },
  { name: "제주", lat: 33.4996, lng: 126.5312 },
];

export function loadLastLocation(): { lat: number; lng: number } | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const v = JSON.parse(raw);
    if (
      typeof v?.lat === "number" &&
      typeof v?.lng === "number" &&
      Number.isFinite(v.lat) &&
      Number.isFinite(v.lng) &&
      inKorea(v.lat, v.lng)
    ) {
      return { lat: v.lat, lng: v.lng };
    }
  } catch {
    // 저장소 접근 불가 — 없는 것으로 취급
  }
  return null;
}

export function saveLastLocation(lat: number, lng: number): void {
  try {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ lat: roundCoord(lat), lng: roundCoord(lng) }),
    );
  } catch {
    // 저장 실패는 무시
  }
}
