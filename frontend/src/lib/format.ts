import { adaptive } from "@toss/tds-colors";

import type {
  Congestion,
  CongestionLevel,
  Direction,
  Highway,
  PlaceType,
} from "../api/types";

/** 방향 이름: 노선 정보가 있으면 "부산 방향"처럼, 없으면 하행/상행 */
export function directionLabel(
  highways: Highway[] | undefined,
  code: string,
  direction: Direction,
) {
  const hw = highways?.find((h) => h.code === code);
  const label = hw ? (direction === "DOWN" ? hw.down_label : hw.up_label) : "";
  return label || (direction === "DOWN" ? "하행" : "상행");
}

const CAPITAL_AREA = ["서울", "인천", "하남", "양평", "평택"];

/** "서울–부산 · 416km" — 수도권 쪽 끝을 앞에 둔다 */
export function highwayRange(hw: Highway) {
  const km = hw.total_distance_km
    ? ` · ${Math.round(hw.total_distance_km)}km`
    : "";
  const [a, b] = CAPITAL_AREA.includes(hw.start_name)
    ? [hw.start_name, hw.end_name]
    : [hw.end_name, hw.start_name];
  return `${a}–${b}${km}`;
}

/** 고속도로 노선번호 — 목록 왼쪽 타일에 쓴다 */
const ROUTE_NUMBER: Record<string, string> = {
  gyeongbu: "1",
  namhae: "10",
  gwangjudaegu: "12",
  seohaeAN: "15",
  honam: "25",
  suncheonwanju: "27",
  jungbu: "35",
  pyeongtaekjecheon: "40",
  jungbunaeryuk: "45",
  yeongdong: "50",
  jungang: "55",
  seoulyangyang: "60",
};

export function routeNumber(code: string) {
  return ROUTE_NUMBER[code] ?? "";
}

/** 상태 문구: "바로 충전 2대 / 4대" */
export function availabilityText(c: Congestion | undefined) {
  if (!c || c.level === "unknown" || c.available == null || c.total == null)
    return "실시간 정보 없음";
  if (c.level === "unavailable") return "모든 충전기가 점검·고장 중";
  return `바로 충전 ${c.available}대 / ${c.total}대`;
}

/** 목록용 짧은 표기: "빈 충전기 2/4" */
export function shortAvailability(c: Congestion | undefined) {
  if (!c || c.level === "unknown" || c.available == null || c.total == null)
    return "실시간 정보 없음";
  if (c.level === "unavailable") return "점검·고장 중";
  return `빈 충전기 ${c.available}/${c.total}`;
}

/** 우회를 권할 만큼 기다려야 하는 상태인지 */
export function needsBypass(c: Congestion | undefined) {
  return (
    !!c &&
    (c.level === "jammed" || c.level === "busy" || c.level === "unavailable")
  );
}

export function timeAgo(iso: string | null) {
  if (!iso) return "";
  const min = Math.floor((Date.now() - new Date(iso).getTime()) / 60000);
  if (min < 1) return "방금 업데이트";
  if (min < 60) return `${min}분 전 업데이트`;
  return `${Math.floor(min / 60)}시간 전 업데이트`;
}

export const PLACE_LABEL: Record<PlaceType, string> = {
  mart: "마트",
  gas_station: "주유소",
  hotel: "숙박",
  public: "공공시설",
  etc: "기타",
};

const CONNECTOR_LABEL: Record<string, string> = {
  dc_combo: "DC콤보",
  ac3: "AC3상",
  dc_chademo: "DC차데모",
  dc_ac_combo: "DC콤보·AC3상",
};

export function connectorLabel(code: string) {
  return CONNECTOR_LABEL[code] ?? code;
}

const WEEKDAYS = ["월", "화", "수", "목", "금", "토", "일"];
export function weekdayName(i: number) {
  return WEEKDAYS[i] ?? "";
}

export function formatMinutes(min: number) {
  if (min < 60) return `${min}분`;
  const h = Math.floor(min / 60);
  const m = min % 60;
  return m ? `${h}시간 ${m}분` : `${h}시간`;
}

export function formatKm(km: number) {
  return km < 1 ? `${Math.round(km * 1000)}m` : `${km.toFixed(1)}km`;
}

/** 휴게소 이름 정리: "기흥휴게소(부산방향)" → "기흥휴게소" */
export function shortName(name: string) {
  return name.replace(/\([^)]*\)/g, "").trim();
}

export const LEVEL_TEXT_COLOR: Record<CongestionLevel, string> = {
  smooth: adaptive.green500,
  normal: adaptive.blue500,
  busy: adaptive.orange500,
  jammed: adaptive.red500,
  unavailable: adaptive.grey600,
  unknown: adaptive.grey600,
};

/** "24시간 이용가능"처럼 평범한 운영 시간인지 (목록에서는 숨긴다) */
export function isAlwaysOpen(hours: string) {
  return !hours || /24\s*시간/.test(hours);
}

/** 공공데이터에서 "미개방"으로 표시된 충전소 */
export function isClosedToPublic(hours: string) {
  return hours.includes("미개방");
}
