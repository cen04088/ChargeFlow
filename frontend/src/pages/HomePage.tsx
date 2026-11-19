import {
  BottomSheet,
  Border,
  Button,
  ListHeader,
  ListRow,
  Paragraph,
  Skeleton,
} from "@toss/tds-mobile";
import { adaptive } from "@toss/tds-colors";
import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";

import { api } from "../api/client";
import type { NearbyRestArea, UserRoute } from "../api/types";
import { ConnectorPicker } from "../components/ConnectorPicker";
import { RestAreaRow } from "../components/RestAreaRow";
import { SectionHeader } from "../components/SectionHeader";
import {
  directionLabel,
  formatKm,
  highwayRange,
  routeNumber,
  shortName,
} from "../lib/format";
import { connectorName, useConnector, useHighways } from "../lib/store";
import { getLocationWithHeading, logClick, logScreen } from "../lib/toss";
import { useAsync } from "../lib/useAsync";

type NearbyState =
  | { status: "idle" }
  | { status: "loading" }
  | {
      status: "done";
      items: NearbyRestArea[];
      matched: boolean;
      measuring: boolean;
    }
  | { status: "denied" | "failed" };

export default function HomePage() {
  const navigate = useNavigate();
  const routes = useAsync(() => api.myRoutes(), []);
  const highways = useHighways();
  const [nearby, setNearby] = useState<NearbyState>({ status: "idle" });
  const [connector] = useConnector();
  const [pickerOpen, setPickerOpen] = useState(false);

  useEffect(() => logScreen("home"), []);

  const findNearby = async () => {
    logClick("home_find_nearby");
    setNearby({ status: "loading" });
    // 첫 위치로 가까운 곳을 먼저 보여주고, 4초 뒤 진행 방향을 알면 가는 방향 휴게소로 바꾼다
    const result = await getLocationWithHeading(async (lat, lng) => {
      try {
        const res = await api.nearest(lat, lng, null, 5);
        setNearby({
          status: "done",
          items: res.stations,
          matched: false,
          measuring: true,
        });
      } catch {
        /* 두 번째 측정 결과로 다시 시도한다 */
      }
    });
    if (!result.ok) {
      setNearby({ status: result.reason });
      return;
    }
    try {
      const res = await api.nearest(result.lat, result.lng, result.heading, 5);
      setNearby({
        status: "done",
        items: res.stations,
        matched: res.direction_matched,
        measuring: false,
      });
      logClick("home_nearby_result", {
        matched: res.direction_matched ? 1 : 0,
      });
    } catch {
      setNearby((prev) =>
        prev.status === "done"
          ? { ...prev, measuring: false }
          : { status: "failed" },
      );
    }
  };

  const openRestArea = (id: number, from: string) => {
    logClick("home_open_rest_area", { from });
    navigate(`/rest-area/${id}`);
  };

  const hw = highways.data;
  const favorites = routes.data?.favorites ?? [];
  const favoriteIds = new Set(favorites.map((r) => r.ra_node_id));
  const recent = (routes.data?.recent ?? [])
    .filter((r) => !favoriteIds.has(r.ra_node_id))
    .slice(0, 3);

  // 다시 온 사람은 저장한 휴게소가 첫 화면에 보이도록 머리말을 줄인다
  const returning = favorites.length > 0 || recent.length > 0;

  return (
    <div className="page">
      <section className="hero rise" aria-labelledby="home-title">
        {!returning && (
          <span className="hero__mark tf" aria-hidden="true">
            ⚡
          </span>
        )}
        <h1
          id="home-title"
          className={"display" + (returning ? " display--small" : "")}
        >
          휴게소가 붐빌 때 IC 밖 충전소를 찾아 드려요
        </h1>
        {!returning && (
          <p className="lede">
            휴게소 앞뒤 IC로 나가면 몇 분 더 걸리는지 비교해 드려요
          </p>
        )}
        <div className="hero__cta">
          <Button
            display="full"
            size="large"
            color="light"
            style={{ color: "var(--brand-deep)" }}
            loading={nearby.status === "loading"}
            onClick={findNearby}
          >
            가는 길 휴게소 찾기
          </Button>
        </div>
      </section>

      {nearby.status === "done" && (
        <div className="rise">
          <SectionHeader
            title={nearby.matched ? "가는 방향 휴게소" : "가까운 휴게소"}
            description={
              nearby.measuring
                ? "진행 방향을 확인하고 있어요"
                : nearby.matched
                  ? "앞으로 지날 휴게소를 가까운 순서로 보여 드려요"
                  : "차가 멈춰 있으면 양방향 휴게소를 모두 보여 드려요"
            }
          />
          {nearby.items.map((ra) => (
            <RestAreaRow
              key={ra.id}
              name={shortName(ra.name)}
              caption={`${directionLabel(hw, ra.highway_code, ra.direction)} · ${formatKm(ra.distance_km)}`}
              congestion={ra.congestion}
              onClick={() => openRestArea(ra.id, "nearby")}
            />
          ))}
        </div>
      )}
      {(nearby.status === "denied" || nearby.status === "failed") && (
        <div className="section-pad">
          <Paragraph typography="t6" color={adaptive.grey600}>
            {nearby.status === "denied"
              ? "위치 권한이 없어도 아래에서 고속도로를 골라 찾을 수 있어요."
              : "현재 위치를 찾지 못했어요. 아래에서 고속도로를 골라 주세요."}
          </Paragraph>
        </div>
      )}

      <Border variant="height16" />

      {routes.loading && !routes.data && (
        <Skeleton pattern="listOnly" repeatLastItemCount={2} />
      )}
      <SavedSection
        title="즐겨찾기"
        items={favorites}
        caption={(r) =>
          directionLabel(hw, r.highway_code, r.direction) +
          (r.notify_enabled ? " · 알림 켜짐" : "")
        }
        onOpen={(id) => openRestArea(id, "favorite")}
      />
      <SavedSection
        title="최근 본 휴게소"
        items={recent}
        caption={(r) => directionLabel(hw, r.highway_code, r.direction)}
        onOpen={(id) => openRestArea(id, "recent")}
      />

      <div className="quick-grid">
        <button
          type="button"
          className="tile tile--brand press"
          onClick={() => {
            logClick("home_open_connector");
            setPickerOpen(true);
          }}
        >
          <span className="tile__icon tf" aria-hidden="true">
            🔌
          </span>
          <span className="tile__title">내 차 충전 규격</span>
          {connector ? (
            <span className="tile__value">
              {connectorName(connector)}만 보는 중
            </span>
          ) : (
            <span className="tile__desc">고르면 맞는 충전소만 보여 드려요</span>
          )}
        </button>
        <button
          type="button"
          className="tile tile--sky press"
          onClick={() => {
            logClick("home_open_trip");
            navigate("/trip");
          }}
        >
          <span className="tile__icon tf" aria-hidden="true">
            🛣️
          </span>
          <span className="tile__title">구간 미리 보기</span>
          <span className="tile__desc">출발과 도착 사이 휴게소를 순서대로 봐요</span>
        </button>
      </div>

      <Border variant="height16" />
      <ListHeader
        title={
          <ListHeader.TitleParagraph fontWeight="bold">
            고속도로에서 찾기
          </ListHeader.TitleParagraph>
        }
      />
      {highways.error && !hw && (
        <div className="section-pad">
          <Paragraph typography="t6" color={adaptive.grey600}>
            고속도로 목록을 불러오지 못했어요. 잠시 후 다시 열어 주세요.
          </Paragraph>
        </div>
      )}
      {!hw && !highways.error && (
        <Skeleton pattern="listOnly" repeatLastItemCount={4} />
      )}
      {hw?.map((h) => (
        <ListRow
          key={h.code}
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
              bottom={highwayRange(h)}
            />
          }
          arrowType="right"
          onClick={() => {
            logClick("home_open_highway", { highway: h.code });
            navigate(`/highway/${h.code}`);
          }}
        />
      ))}

      <div className="footnote">
        <Paragraph typography="t7" color={adaptive.grey600}>
          충전기 상태는 환경부 공공데이터를 10분마다 받아 와요. 현장과 다를 수
          있어요.
        </Paragraph>
      </div>

      <BottomSheet
        open={pickerOpen}
        onDimmerClick={() => setPickerOpen(false)}
        header={<BottomSheet.Header>내 차 충전 규격</BottomSheet.Header>}
        headerDescription={
          <BottomSheet.HeaderDescription>
            고르면 맞는 충전소만 보여 드려요. 다음에도 기억해요.
          </BottomSheet.HeaderDescription>
        }
      >
        <div className="sheet-body">
          <ConnectorPicker onPicked={() => setPickerOpen(false)} />
        </div>
      </BottomSheet>
    </div>
  );
}

function SavedSection({
  title,
  items,
  caption,
  onOpen,
}: {
  title: string;
  items: UserRoute[];
  caption: (r: UserRoute) => string;
  onOpen: (id: number) => void;
}) {
  if (!items.length) return null;
  return (
    <>
      <ListHeader
        title={
          <ListHeader.TitleParagraph fontWeight="bold">
            {title}
          </ListHeader.TitleParagraph>
        }
      />
      {items.map((r) => (
        <RestAreaRow
          key={r.ra_node_id}
          name={shortName(r.name)}
          caption={caption(r)}
          congestion={r.congestion}
          onClick={() => onOpen(r.ra_node_id)}
        />
      ))}
    </>
  );
}
