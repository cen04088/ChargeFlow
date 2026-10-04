import { Badge, BottomSheet, ListRow, Paragraph } from "@toss/tds-mobile";
import { adaptive } from "@toss/tds-colors";

import type { BypassStation, Connector } from "../api/types";
import {
  PLACE_LABEL,
  formatKm,
  isAlwaysOpen,
  isClosedToPublic,
  timeAgo,
} from "../lib/format";
import { connectorName } from "../lib/store";
import { logClick, openDirections } from "../lib/toss";

/** 목록 둘째 줄: 고를 때 필요한 두 가지 — 더 걸리는 시간과 충전 속도 */
export function summary(s: BypassStation) {
  const approx = s.is_estimated ? "약 " : "";
  const speed = s.power_kw
    ? `${s.power_kw}kW ${s.charger_count}대`
    : `급속 ${s.charger_count}대`;
  return `우회하면 ${approx}${s.detour_extra_minutes}분 더 · ${speed}`;
}

/** 목록 셋째 줄: 평소와 다른 점이 있을 때만 */
function caution(s: BypassStation, connector: Connector) {
  if (connector && !(s.connectors as string[]).includes(connector)) {
    return { text: `${connectorName(connector)} 커넥터가 없어요`, warn: true };
  }
  if (isClosedToPublic(s.open_hours)) {
    return { text: "외부인 이용이 제한될 수 있어요", warn: true };
  }
  if (!isAlwaysOpen(s.open_hours)) {
    return { text: `${s.open_hours} 운영`, warn: false };
  }
  return null;
}

interface RowProps {
  station: BypassStation;
  best: boolean;
  focused: boolean;
  connector: Connector;
  onOpen: (s: BypassStation) => void;
}

export function StationRow({
  station: s,
  best,
  focused,
  connector,
  onOpen,
}: RowProps) {
  const note = caution(s, connector);
  return (
    <div id={`station-${s.id}`} className={focused ? "row-focused" : undefined}>
      <ListRow
        contents={
          <ListRow.Texts
            type="2RowTypeA"
            top={
              <span className="station-title">
                <span>{s.name}</span>
                {best && (
                  <Badge size="small" variant="weak" color="green">
                    추천
                  </Badge>
                )}
              </span>
            }
            bottom={
              <>
                {summary(s)}
                {note && (
                  <span
                    className="station-note"
                    style={{
                      color: note.warn ? adaptive.red700 : adaptive.grey600,
                    }}
                  >
                    {note.text}
                  </span>
                )}
              </>
            }
            bottomProps={{ typography: "t6", color: adaptive.grey700 }}
          />
        }
        arrowType="right"
        onClick={() => {
          logClick("station_open", { station_id: s.id });
          onOpen(s);
        }}
      />
    </div>
  );
}

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

interface SheetProps {
  station: BypassStation | null;
  icName?: string;
  onClose: () => void;
}

/** 충전소를 누르면 여는 상세 — 목록에서 뺀 정보는 여기서 본다 */
export function StationSheet({ station: s, icName, onClose }: SheetProps) {
  const approx = s?.is_estimated ? "약 " : "";
  return (
    <BottomSheet
      open={s != null}
      onDimmerClick={onClose}
      header={s && <BottomSheet.Header>{s.name}</BottomSheet.Header>}
      headerDescription={
        s && (
          <BottomSheet.HeaderDescription>
            {[
              s.place_type !== "etc" ? PLACE_LABEL[s.place_type] : null,
              s.address,
            ]
              .filter(Boolean)
              .join(" · ")}
          </BottomSheet.HeaderDescription>
        )
      }
      cta={
        s && (
          <BottomSheet.CTA
            onClick={() => {
              logClick("station_directions", { station_id: s.id });
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
          <Detail
            label="가는 길"
            value={`${icName ?? "IC"}에서 ${approx}${s.drive_minutes}분 · ${formatKm(s.distance_km)}`}
          />
          <Detail
            label="더 걸리는 시간"
            value={`${approx}${s.detour_extra_minutes}분 (IC 왕복과 진출입 포함)`}
          />
          <Detail
            label="충전기"
            value={`${s.power_kw ? `${s.power_kw}kW` : "급속"} · ${s.charger_count}대`}
          />
          {s.connectors.length > 0 && (
            <Detail
              label="커넥터"
              value={s.connectors.map(connectorName).join(", ")}
            />
          )}
          {s.open_hours && <Detail label="운영 시간" value={s.open_hours} />}
          {s.realtime && (
            <Detail
              label="빈 충전기"
              value={`${s.realtime.available}/${s.realtime.total}대 (참고 · ${timeAgo(s.realtime.checked_at)})`}
            />
          )}
          {s.route_memo && <Detail label="메모" value={s.route_memo} />}
        </div>
      )}
    </BottomSheet>
  );
}
