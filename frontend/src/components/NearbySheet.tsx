import { BottomSheet, Paragraph } from "@toss/tds-mobile";
import { adaptive } from "@toss/tds-colors";

import type { NearbyStation } from "../api/types";
import { checkedText } from "../lib/nearby";
import { connectorName } from "../lib/store";
import { logClick, openDirections } from "../lib/toss";

function Detail({ label, value }: { label: string; value: string }) {
  return (
    <div className="detail-row">
      <Paragraph typography="t6" color={adaptive.grey600}>
        {label}
      </Paragraph>
      <Paragraph typography="t6" color={adaptive.grey800}>
        {value}
      </Paragraph>
    </div>
  );
}

function freeText(s: NearbyStation, now: number) {
  const checked = checkedText(s.checked_at, now);
  return checked
    ? `${s.available}/${s.total}대 · ${checked}, 참고용`
    : `${s.available}/${s.total}대 · 참고용`;
}

/** 내 주변 충전소를 누르면 여는 상세 */
export function NearbySheet({
  station: s,
  onClose,
}: {
  station: NearbyStation | null;
  onClose: () => void;
}) {
  return (
    <BottomSheet
      open={s != null}
      onDimmerClick={onClose}
      header={s && <BottomSheet.Header>{s.name}</BottomSheet.Header>}
      headerDescription={
        s?.address ? (
          <BottomSheet.HeaderDescription>{s.address}</BottomSheet.HeaderDescription>
        ) : undefined
      }
      cta={
        s && (
          <BottomSheet.CTA
            onClick={() => {
              logClick("nearby_directions", { station_id: s.id });
              void openDirections(s.name, s.latitude, s.longitude);
            }}
          >
            길찾기
          </BottomSheet.CTA>
        )
      }
    >
      {s && (
        <div className="detail-list">
          <Detail label="빈 충전기" value={freeText(s, Date.now())} />
          <Detail label="충전기" value={`${s.power_kw}kW · 급속 ${s.total}대`} />
          {s.connectors.length > 0 && (
            <Detail
              label="커넥터"
              value={s.connectors.map(connectorName).join(", ")}
            />
          )}
          {s.open_hours && <Detail label="운영 시간" value={s.open_hours} />}
          {s.operator && <Detail label="운영사" value={s.operator} />}
        </div>
      )}
    </BottomSheet>
  );
}
