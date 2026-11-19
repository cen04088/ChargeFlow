import { BottomSheet, Paragraph } from "@toss/tds-mobile";
import { adaptive } from "@toss/tds-colors";

import type { NearbyStation } from "../api/types";
import { checkedText } from "../lib/nearby";
import { connectorName } from "../lib/store";
import { logClick, openDirections } from "../lib/toss";
import { SheetHeading } from "./SheetHeading";

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

/** 내 주변 충전소를 누르면 여는 상세 */
export function NearbySheet({
  station: s,
  onClose,
}: {
  station: NearbyStation | null;
  onClose: () => void;
}) {
  const checked = s && checkedText(s.checked_at, Date.now());

  return (
    <BottomSheet
      open={s != null}
      onDimmerClick={onClose}
      onClose={onClose}
      aria-label={s?.name}
      header={s && <SheetHeading title={s.name} onClose={onClose} />}
      headerDescription={
        s?.address ? (
          <BottomSheet.HeaderDescription>
            {s.address}
          </BottomSheet.HeaderDescription>
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
          <div className={`sheet-availability sheet-availability--${s.state}`}>
            <p>빈 충전기</p>
            <div className="sheet-availability__count">
              <strong>{s.available}대</strong>
              <span> / {s.total}대</span>
            </div>
            <p>{checked ? `${checked} · 참고용` : "현장과 다를 수 있어요."}</p>
          </div>
          <Detail
            label="충전기"
            value={`${s.power_kw}kW · 급속 ${s.total}대`}
          />
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
