import { ListRow } from "@toss/tds-mobile";

import type { Congestion } from "../api/types";
import { CongestionNote } from "./Congestion";

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
      right={<CongestionNote congestion={congestion} />}
      arrowType="right"
      onClick={onClick}
    />
  );
}
