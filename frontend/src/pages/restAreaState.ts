import type { BypassStation, Congestion } from "../api/types";

/** 휴게소 화면 접힌 시트의 첫 줄(판정) — 설계의 문구 표 그대로 */
export function verdict(c: Congestion, waitMinutes: number | null): string {
  switch (c.level) {
    case "jammed":
      return waitMinutes != null && waitMinutes > 0
        ? `휴게소는 만석이에요. 약 ${waitMinutes}분 기다려야 해요`
        : "휴게소는 만석이에요";
    case "busy":
      return c.available == null
        ? "휴게소가 붐벼요"
        : `휴게소가 붐벼요. 빈 충전기 ${c.available}대`;
    case "smooth":
    case "normal":
      return c.available == null
        ? "휴게소에 빈 충전기가 있어요"
        : `휴게소에 빈 충전기가 ${c.available}대 있어요`;
    case "unavailable":
      return "휴게소 충전기를 지금 쓸 수 없어요";
    default:
      return "휴게소 충전기 상태를 받지 못했어요";
  }
}

export type RestAreaPeek =
  | {
      kind: "best";
      verdict: string;
      station: BypassStation;
      icName: string | undefined;
      more: number;
    }
  | {
      kind: "empty";
      verdict: string;
      title: string;
      canWiden: boolean;
      more: number;
    };

/** 접힌 시트: 판정 + 추천 충전소, 또는 추천할 곳이 없다는 안내(넓혀 찾기) */
export function restAreaPeek(input: {
  congestion: Congestion;
  waitMinutes: number | null;
  best: BypassStation | null;
  bestIcName?: string;
  maxMinutes: number;
  totalStations: number;
}): RestAreaPeek {
  const v = verdict(input.congestion, input.waitMinutes);
  if (input.best) {
    return {
      kind: "best",
      verdict: v,
      station: input.best,
      icName: input.bestIcName,
      more: input.totalStations,
    };
  }
  return {
    kind: "empty",
    verdict: v,
    title: `IC 밖 ${input.maxMinutes}분 안에는 맞는 충전소가 없어요`,
    canWiden: input.maxMinutes < 30,
    more: input.totalStations,
  };
}
