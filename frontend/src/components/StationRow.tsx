import { Badge, Button, ListRow } from "@toss/tds-mobile";
import { adaptive } from "@toss/tds-colors";

import type { BypassStation } from "../api/types";
import { PLACE_LABEL, formatKm } from "../lib/format";
import { connectorName } from "../lib/store";
import { logClick, openDirections } from "../lib/toss";

interface Props {
  station: BypassStation;
  best: boolean;
  focused: boolean;
  onFocus: (id: number) => void;
}

function RealtimeBadge({ realtime }: { realtime: BypassStation["realtime"] }) {
  if (!realtime) return null;
  return realtime.available > 0 ? (
    <Badge size="xsmall" variant="weak" color="green">
      빈 충전기 {realtime.available}/{realtime.total}
    </Badge>
  ) : (
    <Badge size="xsmall" variant="weak" color="red">
      모두 사용 중
    </Badge>
  );
}

export function StationRow({ station: s, best, focused, onFocus }: Props) {
  const approx = s.is_estimated ? "약 " : "";
  const specs = [
    s.power_kw ? `${s.power_kw}kW` : null,
    s.connectors.length ? s.connectors.map(connectorName).join("·") : null,
    s.charger_count ? `급속 ${s.charger_count}대` : null,
    s.open_hours || null,
  ].filter(Boolean);

  return (
    <div id={`station-${s.id}`} className={focused ? "row-focused" : undefined}>
      <ListRow
        verticalPadding="large"
        contents={
          <ListRow.Texts
            type="3RowTypeA"
            top={
              <span className="station-title">
                <span>{s.name}</span>
                {best && (
                  <Badge size="xsmall" variant="weak" color="blue">
                    추천
                  </Badge>
                )}
                <RealtimeBadge realtime={s.realtime} />
              </span>
            }
            middle={`IC에서 ${approx}${s.drive_minutes}분 · 우회하면 ${approx}${s.detour_extra_minutes}분 더 · ${PLACE_LABEL[s.place_type]}`}
            middleProps={{ typography: "t6", color: adaptive.grey700 }}
            bottom={
              specs.join(" · ") ||
              s.route_memo ||
              `IC에서 ${formatKm(s.distance_km)}`
            }
            bottomProps={{ typography: "t7", color: adaptive.grey600 }}
          />
        }
        right={
          <Button
            size="small"
            variant="weak"
            onClick={(e) => {
              e.stopPropagation();
              logClick("station_directions", { station_id: s.id });
              void openDirections(s.name, s.latitude, s.longitude);
            }}
          >
            길찾기
          </Button>
        }
        onClick={() => onFocus(s.id)}
      />
    </div>
  );
}
