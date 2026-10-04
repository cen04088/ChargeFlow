import { Paragraph } from "@toss/tds-mobile";
import { adaptive } from "@toss/tds-colors";

import type { Congestion } from "../api/types";

/**
 * 휴게소 충전기 혼잡도 — 공공데이터가 현장과 다를 때가 많아 참고 정보로만 보여 준다.
 * 색으로 강조하지 않고 회색 글자로 두고, 모를 때는 아무것도 보이지 않는다.
 */
export function CongestionNote({ congestion }: { congestion?: Congestion }) {
  if (!congestion || congestion.level === "unknown") return null;
  return (
    <Paragraph typography="t7" color={adaptive.grey600}>
      {congestion.label}
    </Paragraph>
  );
}
