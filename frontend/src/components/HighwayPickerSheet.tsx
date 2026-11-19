import { BottomSheet, Button, ListRow, Skeleton } from "@toss/tds-mobile";
import { useEffect, useState } from "react";

import { api } from "../api/client";
import type { Highway, UserRoute, UserRoutesResponse } from "../api/types";
import { directionLabel, highwayRange, routeNumber, shortName } from "../lib/format";
import { ErrorState } from "./ErrorState";
import { RestAreaRow } from "./RestAreaRow";
import { SheetHeading } from "./SheetHeading";

const MAX_FAVORITES = 5;
const MAX_RECENT = 3;

interface Props {
  open: boolean;
  onClose: () => void;
  highways: Highway[] | undefined;
  highwaysError?: Error;
  onRetryHighways: () => void;
  /** 지금 보고 있는 노선(목록에서 표시) */
  currentCode?: string;
  onPickHighway: (code: string) => void;
  onOpenRestArea: (id: number, from: "favorite" | "recent") => void;
  /** "내 위치로 찾기" — 위치로 노선을 다시 고른다 */
  onLocate: () => void;
  locating: boolean;
}

/** 노선 고르기(모달): 내 위치로 찾기 → 즐겨찾기·최근 본 휴게소 → 노선 목록 */
export function HighwayPickerSheet({
  open,
  onClose,
  highways,
  highwaysError,
  onRetryHighways,
  currentCode,
  onPickHighway,
  onOpenRestArea,
  onLocate,
  locating,
}: Props) {
  // 열 때마다 새로 받는다(다른 화면에서 즐겨찾기를 바꿨을 수 있다). 닫혀도 마지막 값은 둔다
  const [data, setData] = useState<UserRoutesResponse | null>(null);
  const [loadingRoutes, setLoadingRoutes] = useState(false);
  useEffect(() => {
    if (!open) return;
    let alive = true;
    setLoadingRoutes(true);
    api.myRoutes().then(
      (r) => {
        if (!alive) return;
        setData(r);
        setLoadingRoutes(false);
      },
      () => alive && setLoadingRoutes(false),
    );
    return () => {
      alive = false;
    };
  }, [open]);
  const favorites = (data?.favorites ?? []).slice(0, MAX_FAVORITES);
  const favoriteIds = new Set((data?.favorites ?? []).map((r) => r.ra_node_id));
  const recent = (data?.recent ?? [])
    .filter((r) => !favoriteIds.has(r.ra_node_id))
    .slice(0, MAX_RECENT);

  const caption = (r: UserRoute, notify: boolean) =>
    `${r.highway_name} · ${directionLabel(highways, r.highway_code, r.direction)}` +
    (notify && r.notify_enabled ? " · 알림 켜짐" : "");

  return (
    <BottomSheet
      open={open}
      onDimmerClick={onClose}
      onClose={onClose}
      aria-label="고속도로 고르기"
      header={<SheetHeading title="어느 고속도로로 가세요?" onClose={onClose} />}
    >
      <div className="picker-body">
        <div className="picker-locate">
          <Button
            size="large"
            display="full"
            variant="weak"
            loading={locating}
            aria-disabled={locating}
            onClick={onLocate}
          >
            내 위치로 찾기
          </Button>
        </div>

        {loadingRoutes && !data && (
          <Skeleton pattern="listOnly" repeatLastItemCount={2} />
        )}
        {favorites.length > 0 && (
          <section aria-labelledby="picker-favorites">
            <h3 className="picker-title" id="picker-favorites">
              즐겨찾기
            </h3>
            {favorites.map((r) => (
              <RestAreaRow
                key={r.ra_node_id}
                name={shortName(r.name)}
                caption={caption(r, true)}
                congestion={r.congestion}
                onClick={() => onOpenRestArea(r.ra_node_id, "favorite")}
              />
            ))}
          </section>
        )}
        {recent.length > 0 && (
          <section aria-labelledby="picker-recent">
            <h3 className="picker-title" id="picker-recent">
              최근 본 휴게소
            </h3>
            {recent.map((r) => (
              <RestAreaRow
                key={r.ra_node_id}
                name={shortName(r.name)}
                caption={caption(r, false)}
                congestion={r.congestion}
                onClick={() => onOpenRestArea(r.ra_node_id, "recent")}
              />
            ))}
          </section>
        )}

        <section aria-labelledby="picker-highways">
          <h3 className="picker-title" id="picker-highways">
            고속도로
          </h3>
          {highwaysError && !highways && (
            <ErrorState error={highwaysError} onRetry={onRetryHighways} />
          )}
          {!highways && !highwaysError && (
            <Skeleton pattern="listOnly" repeatLastItemCount={4} />
          )}
          {highways?.map((h) => (
            <div
              key={h.code}
              className={h.code === currentCode ? "row-focused" : undefined}
            >
              <ListRow
                left={
                  <ListRow.AssetText
                    shape="squircle"
                    size="medium"
                    backgroundColor="var(--brand-tint)"
                    color="var(--brand-strong)"
                  >
                    {routeNumber(h.code)}
                  </ListRow.AssetText>
                }
                contents={
                  <ListRow.Texts
                    type="2RowTypeA"
                    top={h.name}
                    topProps={{ fontWeight: "bold" }}
                    bottom={highwayRange(h)}
                  />
                }
                arrowType="right"
                aria-current={h.code === currentCode ? "true" : undefined}
                onClick={() => onPickHighway(h.code)}
              />
            </div>
          ))}
        </section>
      </div>
    </BottomSheet>
  );
}
