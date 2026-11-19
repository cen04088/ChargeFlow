import type { NearbyStation } from "../api/types";
import { formatKm } from "./format";

export const LIST_INITIAL = 3;

const STORAGE_KEY = "nearby:last-location";
const STALE_MIN = 30;

/** 소수 셋째 자리로 반올림 (십진 표기 기준이라 부동소수 오차에 흔들리지 않는다) */
export function roundCoord(n: number): number {
  return Number(`${Math.round(Number(`${n}e3`))}e-3`);
}

export function pinText(s: NearbyStation): string {
  if (s.state === "available") return `${s.available}대`;
  return s.state === "full" ? "꽉 참" : "이용 불가";
}

export function countText(s: NearbyStation): string {
  return pinText(s);
}

export function checkedText(iso: string | null, now: number): string {
  if (!iso) return "";
  const min = Math.floor((now - new Date(iso).getTime()) / 60000);
  if (min < 1) return "방금 확인";
  if (min < 60) return `${min}분 전 확인`;
  return `${Math.floor(min / 60)}시간 전 확인`;
}

export function rowCaption(s: NearbyStation, now: number): string {
  const base = `약 ${formatKm(s.distance_km)} · ${s.power_kw}kW`;
  if (!s.checked_at) return base;
  const min = (now - new Date(s.checked_at).getTime()) / 60000;
  return min > STALE_MIN ? `${base} · ${checkedText(s.checked_at, now)}` : base;
}

export function listRows(
  stations: NearbyStation[],
  expanded: boolean,
): { rows: NearbyStation[]; hidden: number; fallback: boolean } {
  const open = stations.filter((s) => s.state === "available");
  const fallback = open.length === 0;
  const pool = fallback ? stations : open;
  const rows = expanded ? pool : pool.slice(0, LIST_INITIAL);
  return { rows, hidden: pool.length - rows.length, fallback: fallback && pool.length > 0 };
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
    if (typeof v?.lat === "number" && typeof v?.lng === "number") {
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
