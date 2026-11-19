import type {
  BypassStation,
  Congestion,
  Direction,
  HighwayNode,
} from "../api/types";

/** 이 거리(km) 안에 가는 방향 휴게소가 있으면 그 노선을 자동으로 고른다 */
export const AUTO_PICK_KM = 20;

/** 핀 색: 홈과 같은 세 상태색(.nearby-pin--*) */
export type PinKind = "available" | "full" | "unavailable";

const LAST_KEY = "highway:last";

/** 휴게소 핀 글자·색 — 설계의 표 그대로 */
export function raPin(c: Congestion): { text: string; kind: PinKind } {
  switch (c.level) {
    case "smooth":
    case "normal":
      return {
        text: c.available == null ? c.label : `${c.available}대`,
        kind: "available",
      };
    case "busy":
      return {
        text: c.available == null ? c.label : `${c.available}대`,
        kind: "full",
      };
    case "jammed":
      return { text: "만석", kind: "full" };
    case "unavailable":
      return { text: "이용 불가", kind: "unavailable" };
    default:
      return { text: "정보 없음", kind: "unavailable" };
  }
}

/**
 * 목록 줄 오른쪽 글자: 상태 단어 + 빈 대수("혼잡 · 1대", "여유 · 3대", "만석", "이용 불가", "정보 없음").
 * 색만으로 상태를 가르지 않도록 단어를 함께 쓴다. 색(kind)은 핀과 같다.
 */
export function raStatus(c: Congestion | undefined): { text: string; kind: PinKind } {
  if (!c) return { text: "정보 없음", kind: "unavailable" };
  const { kind } = raPin(c);
  switch (c.level) {
    case "smooth":
    case "normal":
    case "busy":
      return {
        text: c.available == null ? c.label : `${c.label} · ${c.available}대`,
        kind,
      };
    case "jammed":
      return { text: "만석", kind };
    case "unavailable":
      return { text: "이용 불가", kind };
    default:
      return { text: "정보 없음", kind };
  }
}

/** 휴게소 핀·줄의 화면낭독기 이름: "{이름} {상태 단어} {빈 대수 문구}" */
export function raAriaLabel(name: string, c: Congestion | undefined): string {
  if (!c || c.level === "unknown") return `${name} 정보 없음`;
  if (c.level === "unavailable") return `${name} ${c.label}`;
  return c.available == null
    ? `${name} ${c.label}`
    : `${name} ${c.label} 빈 충전기 ${c.available}대`;
}

/** 충전기가 있는 휴게소인지: 충전기 수를 알거나 상태를 안다 */
export function hasChargers(c: Congestion | undefined): boolean {
  if (!c) return false;
  return (c.total ?? 0) > 0 || c.level !== "unknown";
}

/**
 * 지도·목록에 올릴 휴게소(가는 순서). 상태를 아는 휴게소가 하나라도 있으면(집계가 돌고 있다)
 * 충전기 있는 곳만 남긴다. 모두 "정보 없음"이면 집계가 멈춘 것이라 구분할 수 없으므로
 * 지금 목록처럼 전부 둔다(화면이 비지 않게).
 */
export function listedRestAreas(nodes: HighwayNode[]): HighwayNode[] {
  const ras = nodes.filter((n) => n.node_type === "RA");
  return ras.some((n) => hasChargers(n.congestion))
    ? ras.filter((n) => hasChargers(n.congestion))
    : ras;
}

/**
 * IC 밖 충전소 핀: 빈 대수를 알면 "N대 · M분"(M = 우회하면 더 걸리는 시간), 모르면 "M분".
 * 모르는 곳은 쓸 수 있는 곳으로 두되 known false — 상태색 대신 중립색으로 그린다.
 */
export function stationPin(s: BypassStation): {
  text: string;
  kind: PinKind;
  known: boolean;
} {
  if (s.realtime) {
    return {
      text: `${s.realtime.available}대 · ${s.detour_extra_minutes}분`,
      kind: s.realtime.available > 0 ? "available" : "full",
      known: true,
    };
  }
  return { text: `${s.detour_extra_minutes}분`, kind: "available", known: false };
}

export function loadLastHighway(): { code: string; dir: Direction } | null {
  try {
    const raw = localStorage.getItem(LAST_KEY);
    if (!raw) return null;
    const v = JSON.parse(raw);
    if (
      typeof v?.code === "string" &&
      v.code !== "" &&
      (v.dir === "UP" || v.dir === "DOWN")
    ) {
      return { code: v.code, dir: v.dir };
    }
  } catch {
    // 저장소 접근 불가·깨진 값 — 없는 것으로 취급
  }
  return null;
}

export function saveLastHighway(code: string, dir: Direction): void {
  try {
    localStorage.setItem(LAST_KEY, JSON.stringify({ code, dir }));
  } catch {
    // 저장 실패는 무시
  }
}
