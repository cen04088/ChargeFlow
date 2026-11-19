import { expect, test } from "vitest";

import type { BypassStation, Congestion } from "../api/types";
import { restAreaPeek, verdict } from "./restAreaState";

function cg(p: Partial<Congestion>): Congestion {
  return {
    level: "unknown",
    label: "",
    color: "gray",
    available: null,
    charging: null,
    offline: null,
    total: null,
    turnover_30m: null,
    checked_at: null,
    ...p,
  };
}

const STATION = { id: 5, name: "공영주차장", detour_extra_minutes: 6 } as BypassStation;

test("verdict: 설계의 판정 문구 표", () => {
  expect(verdict(cg({ level: "jammed", available: 0 }), 25)).toBe(
    "휴게소는 만석이에요. 약 25분 기다려야 해요",
  );
  expect(verdict(cg({ level: "jammed", available: 0 }), null)).toBe("휴게소는 만석이에요");
  expect(verdict(cg({ level: "busy", available: 1 }), null)).toBe("휴게소가 붐벼요. 빈 충전기 1대");
  expect(verdict(cg({ level: "smooth", available: 4 }), 0)).toBe("휴게소에 빈 충전기가 4대 있어요");
  expect(verdict(cg({ level: "normal", available: 2 }), null)).toBe(
    "휴게소에 빈 충전기가 2대 있어요",
  );
  expect(verdict(cg({ level: "unavailable" }), null)).toBe("휴게소 충전기를 지금 쓸 수 없어요");
  expect(verdict(cg({ level: "unknown", available: null }), null)).toBe(
    "휴게소 충전기 상태를 받지 못했어요",
  );
});

test("verdict: 대기 0분은 추정 없음과 같이", () => {
  expect(verdict(cg({ level: "jammed", available: 0 }), 0)).toBe("휴게소는 만석이에요");
});

test("verdict: 빈 대수를 모르면 그 부분을 뺀다", () => {
  expect(verdict(cg({ level: "busy", available: null }), null)).toBe("휴게소가 붐벼요");
  expect(verdict(cg({ level: "smooth", available: null }), null)).toBe(
    "휴게소에 빈 충전기가 있어요",
  );
});

test("restAreaPeek: 추천 충전소가 있으면 best", () => {
  expect(
    restAreaPeek({
      congestion: cg({ level: "jammed", available: 0 }),
      waitMinutes: 25,
      best: STATION,
      bestIcName: "안성IC",
      maxMinutes: 15,
      totalStations: 7,
    }),
  ).toEqual({
    kind: "best",
    verdict: "휴게소는 만석이에요. 약 25분 기다려야 해요",
    station: STATION,
    icName: "안성IC",
    more: 7,
  });
});

test("restAreaPeek: 없으면 empty, 15분이면 넓혀 찾기", () => {
  expect(
    restAreaPeek({
      congestion: cg({ level: "unknown" }),
      waitMinutes: null,
      best: null,
      maxMinutes: 15,
      totalStations: 3,
    }),
  ).toEqual({
    kind: "empty",
    verdict: "휴게소 충전기 상태를 받지 못했어요",
    title: "IC 밖 15분 안에는 맞는 충전소가 없어요",
    canWiden: true,
    more: 3,
  });
});

test("restAreaPeek: 30분이면 더 넓히지 않는다", () => {
  const p = restAreaPeek({
    congestion: cg({ level: "smooth", available: 2 }),
    waitMinutes: null,
    best: null,
    maxMinutes: 30,
    totalStations: 0,
  });
  expect(p).toMatchObject({
    kind: "empty",
    title: "IC 밖 30분 안에는 맞는 충전소가 없어요",
    canWiden: false,
    more: 0,
  });
});
