import { Chip, ChipItem, useToast } from "@toss/tds-mobile";

import type { Connector } from "../api/types";
import { CONNECTOR_OPTIONS, useConnector } from "../lib/store";
import { logClick } from "../lib/toss";

/** 내 차 충전 규격 선택 — 고르면 대체 충전소 목록이 그 규격으로 걸러진다 */
export function ConnectorPicker() {
  const [connector, save] = useConnector();
  const { openToast } = useToast();

  const pick = async (value: Connector) => {
    if (value === connector) return;
    logClick("connector_pick", { connector: value || "all" });
    try {
      await save(value);
    } catch {
      openToast("저장하지 못했어요. 잠시 후 다시 시도해 주세요");
    }
  };

  return (
    <Chip kind="select" size="medium" wrap margin="none">
      {CONNECTOR_OPTIONS.map((o) => (
        <ChipItem
          key={o.value || "all"}
          selected={o.value === connector}
          onClick={() => pick(o.value)}
        >
          {o.label}
        </ChipItem>
      ))}
    </Chip>
  );
}
