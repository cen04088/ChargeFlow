import { api } from "../api/client";
import type { Direction } from "../api/types";
import {
  LOCATE_TIMEOUT_MS,
  locateWithTimeout,
  type Point,
} from "../pages/nearbyState";
import { pickStart, type HighwayStart } from "../pages/highwayState";
import { AUTO_PICK_KM } from "./highway";
import { getLocationWithHeading } from "./toss";

export interface FoundStart {
  start: HighwayStart;
  /** 받은 위치(고속도로 화면의 내 위치로 넘긴다). 못 받았으면 null */
  me: Point | null;
  /** 진행 방향으로 가는 방향 휴게소를 골랐다(direction_matched) — 고른 노선·방향이 이용자가 가는 방향이다 */
  matched: boolean;
  /** 위치를 못 받은 이유 — 받았으면 undefined */
  failure?: "denied" | "failed";
}

/**
 * 위치를 받아(12초 제한) 가까운 휴게소로 노선을 정한다. pickStart의 순서(자동 → 마지막 → 시트)를 따른다.
 * 첫 위치에서 가장 가까운 휴게소가 이미 20km 밖이면, 진행 방향을 재는 4초를 기다리지 않고 바로 정한다
 * (방향을 알아도 더 가까운 휴게소가 생기지 않는다). 첫 위치를 받은 뒤 두 번째 측정이 제한 시간을 넘기면
 * 첫 위치로(방향 없이) 정한다. signal이 취소되면 끝나지 않는다.
 */
export function findHighwayStart(input: {
  last: { code: string; dir: Direction } | null;
  codes: string[];
  signal: AbortSignal;
}): Promise<FoundStart> {
  const { last, codes, signal } = input;
  return new Promise((resolve) => {
    let done = false;
    let firstFix: Point | null = null;
    const finish = (r: FoundStart) => {
      if (done || signal.aborted) return;
      done = true;
      resolve(r);
    };
    const fromNearest = async (
      p: Point,
      heading: number | null,
    ): Promise<FoundStart> => {
      try {
        const res = await api.nearest(p.lat, p.lng, heading, 5);
        const start = pickStart({
          nearest: res.stations,
          matched: res.direction_matched,
          last,
          codes,
        });
        return {
          start,
          me: p,
          matched: start.by === "auto" && res.direction_matched,
        };
      } catch {
        return {
          start: pickStart({ nearest: null, matched: false, last, codes }),
          me: p,
          matched: false,
        };
      }
    };
    const onFirst = (lat: number, lng: number) => {
      firstFix = { lat, lng };
      api.nearest(lat, lng, null, 5).then(
        (res) => {
          const first = res.stations[0];
          if (first && first.distance_km <= AUTO_PICK_KM) return;
          finish({
            start: pickStart({ nearest: res.stations, matched: false, last, codes }),
            me: { lat, lng },
            matched: false,
          });
        },
        () => {
          /* 두 번째 측정 결과로 정한다 */
        },
      );
    };
    void locateWithTimeout(
      () => getLocationWithHeading(onFirst),
      LOCATE_TIMEOUT_MS,
      () => {},
      signal,
    ).then(async (r) => {
      if (done || signal.aborted) return;
      if (!r.ok) {
        // 첫 위치는 받았는데 방향 측정이 늦었다 — 받은 위치로 정한다
        if (firstFix && r.reason === "failed") {
          finish(await fromNearest(firstFix, null));
          return;
        }
        finish({
          start: pickStart({ nearest: null, matched: false, last, codes }),
          me: null,
          matched: false,
          failure: r.reason,
        });
        return;
      }
      const heading = "heading" in r ? r.heading : null;
      finish(await fromNearest({ lat: r.lat, lng: r.lng }, heading));
    });
  });
}
