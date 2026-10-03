import { Badge } from "@toss/tds-mobile";

import type { Congestion, CongestionLevel } from "../api/types";

const BADGE_COLOR: Record<
  CongestionLevel,
  "green" | "blue" | "yellow" | "red" | "elephant"
> = {
  smooth: "green",
  normal: "blue",
  busy: "yellow",
  jammed: "red",
  unavailable: "elephant",
  unknown: "elephant",
};

export function CongestionBadge({ congestion }: { congestion?: Congestion }) {
  const level = congestion?.level ?? "unknown";
  return (
    <Badge size="small" variant="weak" color={BADGE_COLOR[level]}>
      {congestion?.label ?? "정보 없음"}
    </Badge>
  );
}
