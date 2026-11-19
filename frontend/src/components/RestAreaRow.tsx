import { ListRow } from "@toss/tds-mobile";

import type { Congestion } from "../api/types";
import { raStatus } from "../lib/highway";

/**
 * 휴게소 상태 표시(줄 오른쪽): 위에 상태 단어(15px), 아래에 빈 대수(20px 굵게). 늘 두 줄로 쌓아 폭을 좁게 둔다
 * (긴 휴게소 이름이 320px 화면에서도 잘리지 않게). 색은 지도 핀과 같은 상태색.
 */
export function RaStatusText({ congestion }: { congestion?: Congestion }) {
  const s = raStatus(congestion);
  return (
    <span className={`ra-status ra-status--${s.kind}`}>
      <span className="ra-status__word">{s.word}</span>
      {s.count && <span className="ra-status__count">{s.count}</span>}
    </span>
  );
}

interface Props {
  name: string;
  /** 노선·방향·거리처럼 이름 아래에 붙는 설명 */
  caption?: string;
  congestion?: Congestion;
  onClick: () => void;
}

export function RestAreaRow({ name, caption, congestion, onClick }: Props) {
  return (
    <ListRow
      contents={
        caption ? (
          <ListRow.Texts type="2RowTypeA" top={name} bottom={caption} />
        ) : (
          <ListRow.Texts type="1RowTypeA" top={name} />
        )
      }
      right={<RaStatusText congestion={congestion} />}
      arrowType="right"
      onClick={onClick}
    />
  );
}
