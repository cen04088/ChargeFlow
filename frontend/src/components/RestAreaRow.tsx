import { ListRow } from "@toss/tds-mobile";

import type { Congestion } from "../api/types";
import { raStatus } from "../lib/highway";

interface Props {
  name: string;
  /** 노선·방향·거리처럼 이름 아래에 붙는 설명 */
  caption?: string;
  congestion?: Congestion;
  onClick: () => void;
}

/** 휴게소 한 줄: 오른쪽에 상태 단어 + 빈 대수("혼잡 · 1대"), 색은 지도 핀과 같은 상태색 */
export function RestAreaRow({ name, caption, congestion, onClick }: Props) {
  const status = raStatus(congestion);
  return (
    <ListRow
      contents={
        caption ? (
          <ListRow.Texts type="2RowTypeA" top={name} bottom={caption} />
        ) : (
          <ListRow.Texts type="1RowTypeA" top={name} />
        )
      }
      right={
        <span className={`nearby-row__count nearby-row__count--${status.kind}`}>
          {status.text}
        </span>
      }
      arrowType="right"
      onClick={onClick}
    />
  );
}
