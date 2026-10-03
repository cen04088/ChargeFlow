import { ListRow } from "@toss/tds-mobile";

import type { Congestion } from "../api/types";
import { shortAvailability } from "../lib/format";
import { CongestionBadge } from "./Congestion";

interface Props {
  name: string;
  /** 노선·방향·거리처럼 이름 아래에 붙는 설명. 없으면 충전기 현황만 보인다 */
  caption?: string;
  congestion?: Congestion;
  onClick: () => void;
}

export function RestAreaRow({ name, caption, congestion, onClick }: Props) {
  const bottom = caption
    ? `${caption} · ${shortAvailability(congestion)}`
    : shortAvailability(congestion);
  return (
    <ListRow
      contents={<ListRow.Texts type="2RowTypeA" top={name} bottom={bottom} />}
      right={<CongestionBadge congestion={congestion} />}
      arrowType="right"
      onClick={onClick}
    />
  );
}
