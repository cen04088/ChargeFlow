import { Notification } from "@apps-in-toss/web-framework";
import {
  BottomSheet,
  Border,
  Button,
  Chip,
  ChipItem,
  IconButton,
  ListHeader,
  ListRow,
  Paragraph,
  Skeleton,
  Spacing,
  Tab,
  Top,
  useToast,
} from "@toss/tds-mobile";
import { adaptive } from "@toss/tds-colors";
import { useEffect, useMemo, useState } from "react";
import { Navigate, useParams } from "react-router-dom";

import { api } from "../api/client";
import type {
  BypassIC,
  BypassResponse,
  BypassStation,
  Connector,
} from "../api/types";
import { ConnectorPicker } from "../components/ConnectorPicker";
import { ErrorState } from "../components/ErrorState";
import { PatternChart } from "../components/PatternChart";
import { RestAreaMap } from "../components/RestAreaMap";
import {
  StationRow,
  StationSheet,
  summary,
} from "../components/StationRow";
import {
  availabilityText,
  directionLabel,
  isAlwaysOpen,
  isClosedToPublic,
  shortName,
  timeAgo,
  weekdayName,
} from "../lib/format";
import { connectorName, useConnector, useHighways } from "../lib/store";
import {
  logClick,
  logScreen,
  openDirections,
  shareRestArea,
} from "../lib/toss";
import { useAsync } from "../lib/useAsync";

const REFRESH_MS = 60_000;
/** 처음엔 가까운 몇 곳만 — 나머지는 "더 보기"로 */
const INITIAL_COUNT = 5;
const NOTIFY_TEMPLATE = import.meta.env.VITE_NOTIFY_TEMPLATE_CODE as
  string | undefined;

/** "100kW 이상" 필터 기준 */
const FAST_KW = 100;

type Which = "prev" | "next";

export default function RestAreaPage() {
  const id = Number(useParams().id);
  const valid = Number.isInteger(id) && id > 0;
  const [maxMinutes, setMaxMinutes] = useState(15);
  const bypass = useAsync(
    () =>
      valid ? api.bypass(id, maxMinutes) : Promise.reject(new Error("invalid")),
    [id, maxMinutes],
  );

  useEffect(() => {
    if (!valid) return;
    logScreen("rest_area", { rest_area_id: id });
    const timer = setInterval(() => {
      if (document.visibilityState === "visible") bypass.reload();
    }, REFRESH_MS);
    return () => clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, valid]);

  if (!valid) return <Navigate to="/" replace />;
  if (bypass.error && !bypass.data) {
    return (
      <ErrorState error={bypass.error} onRetry={bypass.reload} />
    );
  }
  if (!bypass.data)
    return <Skeleton pattern="topList" repeatLastItemCount={4} />;

  return (
    <RestAreaView
      key={id}
      data={bypass.data}
      maxMinutes={maxMinutes}
      onWiden={() => {
        logClick("rest_area_widen_range");
        setMaxMinutes(30);
      }}
    />
  );
}

/** 커넥터 설정에 맞는 충전소인지 (설정이 없거나 커넥터 정보가 없으면 보여준다) */
function fits(station: BypassStation, connector: Connector) {
  return (
    !connector ||
    station.connectors.length === 0 ||
    station.connectors.includes(connector)
  );
}

interface Filters {
  fast: boolean;
  allDay: boolean;
}

function passes(s: BypassStation, f: Filters) {
  if (f.fast && (s.power_kw ?? 0) < FAST_KW) return false;
  if (f.allDay && !isAlwaysOpen(s.open_hours)) return false;
  return true;
}

/** 더 걸리는 시간이 짧은 순, 같으면 출력이 높은 순 */
function byDetour(a: BypassStation, b: BypassStation) {
  return (
    a.detour_extra_minutes - b.detour_extra_minutes ||
    (b.power_kw ?? 0) - (a.power_kw ?? 0)
  );
}

/** 가장 빨리 다녀올 곳 — 지금 문을 닫았을 수 있는 곳(운영 시간 제한)은 뒤로 미룬다 */
function pickBest(list: BypassStation[]) {
  const open = list.filter((s) => !isClosedToPublic(s.open_hours));
  const allDay = open.filter((s) => isAlwaysOpen(s.open_hours));
  return [...(allDay.length ? allDay : open)].sort(byDetour)[0] ?? null;
}

function RestAreaView({
  data,
  maxMinutes,
  onWiden,
}: {
  data: BypassResponse;
  maxMinutes: number;
  onWiden: () => void;
}) {
  const ra = data.target_rest_area;
  const congestion = data.congestion;
  const { openToast } = useToast();
  const highways = useHighways().data;
  const [connector] = useConnector();
  const [favorite, setFavorite] = useState(false);
  const [focusId, setFocusId] = useState<number | null>(null);
  const [showAll, setShowAll] = useState(false);
  const [filters, setFilters] = useState<Filters>({
    fast: false,
    allDay: false,
  });
  const [expanded, setExpanded] = useState(false);
  const [sheet, setSheet] = useState<BypassStation | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [mapOpen, setMapOpen] = useState(false);
  const pattern = useAsync(() => api.pattern(ra.id), [ra.id]);

  const ics = [data.previous_ic, data.next_ic].filter(Boolean) as BypassIC[];
  const [tab, setTab] = useState<Which>(data.previous_ic ? "prev" : "next");
  const activeIC = tab === "prev" ? data.previous_ic : data.next_ic;
  const visible = (s: BypassStation) =>
    (showAll || fits(s, connector)) && passes(s, filters);

  // 지도·추천에는 두 IC의 충전소를 함께, 중복 없이 쓴다
  const allStations = useMemo(() => {
    const seen = new Set<number>();
    return ics
      .flatMap((ic) => ic.stations)
      .filter((s) => !seen.has(s.id) && !!seen.add(s.id));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data.previous_ic, data.next_ic]);
  const candidates = allStations.filter(visible);
  const best = pickBest(candidates);
  const icOf = (st: BypassStation) =>
    ics.find((ic) => ic.stations.some((x) => x.id === st.id));

  useEffect(() => {
    api.recordVisit(ra.id).then(
      (r) => setFavorite(r.is_favorite),
      () => {},
    );
  }, [ra.id]);

  const askAgreement = async () => {
    // 콘솔에 알림 템플릿이 등록돼 있으면 토스 알림 동의를 먼저 받는다
    if (!NOTIFY_TEMPLATE || !Notification.requestAgreement.isSupported())
      return true;
    return new Promise<boolean>((resolve) => {
      const cleanup = Notification.requestAgreement({
        options: { templateCode: NOTIFY_TEMPLATE },
        onEvent: ({ type }) => {
          cleanup();
          resolve(type !== "agreementRejected");
        },
        onError: () => {
          cleanup();
          resolve(false);
        },
      });
    });
  };

  // 즐겨찾기 하나로 상태 알림까지 켠다 (알림 동의를 거절해도 즐겨찾기는 남는다)
  const toggleFavorite = async () => {
    const next = !favorite;
    logClick("rest_area_favorite", { on: next ? 1 : 0 });
    setFavorite(next);
    try {
      if (!next) {
        await api.removeFavorite(ra.id);
        openToast("즐겨찾기에서 뺐어요");
        return;
      }
      await api.addFavorite(ra.id);
      if (!(await askAgreement())) {
        openToast("즐겨찾기에 추가했어요");
        return;
      }
      const res = await api.enableFavoriteNotify(ra.id);
      openToast(
        res.deliverable
          ? "즐겨찾기에 추가했어요. 붐비거나 여유로워지면 알려 드릴게요"
          : "즐겨찾기에 추가했어요",
      );
    } catch {
      setFavorite(!next);
      openToast("잠시 후 다시 시도해 주세요");
    }
  };

  const share = async () => {
    logClick("rest_area_share");
    try {
      await shareRestArea(ra.id, shortName(ra.name));
    } catch {
      openToast("공유하지 못했어요. 잠시 후 다시 시도해 주세요");
    }
  };

  const openSheet = (st: BypassStation) => {
    setFocusId(st.id);
    setSheet(st);
  };

  const toggleFilter = (key: keyof Filters) => {
    logClick("station_filter", { filter: key, on: filters[key] ? 0 : 1 });
    setFilters((f) => ({ ...f, [key]: !f[key] }));
    setExpanded(false);
  };

  const filtering = filters.fast || filters.allDay;
  const known = congestion.level !== "unknown";
  const now = new Date();
  const icStations = activeIC?.stations ?? [];
  const visibleStations = icStations.filter(visible).sort(byDetour);
  const shownStations = expanded
    ? visibleStations
    : visibleStations.slice(0, INITIAL_COUNT);
  const bestIC = best ? icOf(best) : undefined;

  return (
    <div className="page">
      <Top
        subtitleTop={
          <Top.SubtitleParagraph size={15}>
            {ra.highway_name} ·{" "}
            {directionLabel(highways, ra.highway_code, ra.direction)}
          </Top.SubtitleParagraph>
        }
        title={
          <Top.TitleParagraph size={22}>{shortName(ra.name)}</Top.TitleParagraph>
        }
        right={
          <div className="top-actions">
            <IconButton
              name="icon-star-mono"
              variant="clear"
              iconSize={24}
              color={favorite ? "var(--brand-primary)" : adaptive.grey400}
              aria-label={favorite ? "즐겨찾기 해제" : "즐겨찾기"}
              aria-pressed={favorite}
              onClick={toggleFavorite}
            />
            <IconButton
              name="icon-share-mono"
              variant="clear"
              iconSize={24}
              color={adaptive.grey600}
              aria-label="공유하기"
              onClick={share}
            />
          </div>
        }
      />

      <div className="section-pad">
        {best ? (
          <div className="best-card">
            <Paragraph typography="t7" color="var(--brand-strong)">
              가장 빨리 다녀올 곳
            </Paragraph>
            <Spacing size={4} />
            <Paragraph
              typography="t4"
              fontWeight="bold"
              color={adaptive.grey900}
            >
              {best.name}
            </Paragraph>
            <Spacing size={4} />
            <Paragraph typography="t6" color={adaptive.grey700}>
              {summary(best)}
            </Paragraph>
            {bestIC && (
              <Paragraph typography="t7" color={adaptive.grey600}>
                {bestIC.name}에서 나가요
              </Paragraph>
            )}
            <Spacing size={16} />
            <div className="best-card__actions">
              <Button
                size="large"
                variant="weak"
                onClick={() => {
                  logClick("best_detail");
                  openSheet(best);
                }}
              >
                자세히
              </Button>
              <Button
                size="large"
                display="full"
                onClick={() => {
                  logClick("best_directions", { station_id: best.id });
                  void openDirections(best.name, best.latitude, best.longitude);
                }}
              >
                길찾기
              </Button>
            </div>
          </div>
        ) : (
          <div className="best-card">
            <Paragraph
              typography="t5"
              fontWeight="bold"
              color={adaptive.grey900}
            >
              IC 밖 {maxMinutes}분 안에는 맞는 충전소가 없어요
            </Paragraph>
            <Spacing size={4} />
            <Paragraph typography="t6" color={adaptive.grey700}>
              {filtering
                ? "아래 조건을 풀거나 거리를 넓혀 보세요."
                : "거리를 넓혀서 다시 찾아볼 수 있어요."}
            </Paragraph>
            {maxMinutes < 30 && (
              <>
                <Spacing size={16} />
                <Button size="large" display="full" onClick={onWiden}>
                  30분 거리까지 찾아보기
                </Button>
              </>
            )}
          </div>
        )}
      </div>

      <Border variant="height16" />

      {ics.length > 1 && (
        <Tab
          onChange={(i) => {
            setTab(i === 0 ? "prev" : "next");
            setExpanded(false);
          }}
          fluid
        >
          <Tab.Item selected={tab === "prev"}>휴게소 전에 나가기</Tab.Item>
          <Tab.Item selected={tab === "next"}>휴게소 지나서 나가기</Tab.Item>
        </Tab>
      )}

      {activeIC ? (
        <>
          <div className="section-pad section-pad--tight">
            <Chip kind="select" size="medium" margin="none">
              <ChipItem
                selected={!!connector && !showAll}
                onClick={() => {
                  if (!connector) {
                    logClick("station_filter", { filter: "connector_pick" });
                    setPickerOpen(true);
                    return;
                  }
                  logClick("station_filter", {
                    filter: "connector",
                    on: showAll ? 1 : 0,
                  });
                  setShowAll((v) => !v);
                  setExpanded(false);
                }}
              >
                {connector ? connectorName(connector) : "충전 규격"}
              </ChipItem>
              <ChipItem
                selected={filters.fast}
                onClick={() => toggleFilter("fast")}
              >
                {`${FAST_KW}kW 이상`}
              </ChipItem>
              <ChipItem
                selected={filters.allDay}
                onClick={() => toggleFilter("allDay")}
              >
                24시간
              </ChipItem>
            </Chip>
            <Spacing size={8} />
            <Paragraph typography="t7" color={adaptive.grey600}>
              {activeIC.name}에서 나가요 · 더 걸리는 시간이 짧은 순
            </Paragraph>
          </div>
          {visibleStations.length === 0 ? (
            <div className="section-pad">
              <Paragraph typography="t6" color={adaptive.grey700}>
                {filtering || (connector && !showAll)
                  ? "조건에 맞는 충전소가 이 IC 근처엔 없어요."
                  : "이 IC 근처엔 충전소가 없어요."}
              </Paragraph>
            </div>
          ) : (
            <>
              {shownStations.map((s) => (
                <StationRow
                  key={s.id}
                  station={s}
                  best={s.id === best?.id}
                  focused={focusId === s.id}
                  connector={connector}
                  onOpen={openSheet}
                />
              ))}
              {visibleStations.length > shownStations.length && (
                <div className="section-pad section-pad--tight">
                  <Button
                    size="large"
                    variant="weak"
                    display="full"
                    onClick={() => {
                      logClick("station_more");
                      setExpanded(true);
                    }}
                  >
                    {`${visibleStations.length - shownStations.length}곳 더 보기`}
                  </Button>
                </div>
              )}
            </>
          )}
        </>
      ) : (
        <div className="section-pad">
          <Paragraph typography="t6" color={adaptive.grey600}>
            이 휴게소 근처 IC 정보가 아직 없어요.
          </Paragraph>
        </div>
      )}

      {ics.length > 0 && (
        <>
          <ListRow
            contents={
              <ListRow.Texts
                type="1RowTypeA"
                top={mapOpen ? "지도 접기" : "지도로 보기"}
              />
            }
            arrowType={mapOpen ? "up" : "down"}
            onClick={() => {
              logClick("rest_area_map", { open: mapOpen ? 0 : 1 });
              setMapOpen((v) => !v);
            }}
          />
          {mapOpen && (
            <RestAreaMap
              restArea={{
                lat: +ra.latitude,
                lng: +ra.longitude,
                name: shortName(ra.name),
              }}
              ics={ics}
              stations={candidates}
              focusId={focusId}
              onSelectStation={(sid) => {
                const st = allStations.find((s) => s.id === sid);
                if (!st) return;
                const inPrev = data.previous_ic?.stations.some(
                  (s) => s.id === sid,
                );
                setTab(inPrev ? "prev" : "next");
                openSheet(st);
              }}
            />
          )}
        </>
      )}

      {pattern.data?.has_pattern && (
        <>
          <Border variant="height16" />
          <ListHeader
            title={
              <ListHeader.TitleParagraph fontWeight="bold">
                평소 {weekdayName((now.getDay() + 6) % 7)}요일 휴게소 혼잡도
              </ListHeader.TitleParagraph>
            }
          />
          <div className="section-pad">
            <PatternChart pattern={pattern.data} nowHour={now.getHours()} />
          </div>
        </>
      )}

      <div className="footnote">
        <Paragraph typography="t7" color={adaptive.grey600}>
          {known
            ? `휴게소 충전기: ${congestion.label} · ${availabilityText(congestion)} · ${timeAgo(congestion.checked_at)} (공공데이터 기준이라 참고만 해 주세요)`
            : "휴게소 충전기 상태는 지금 받아오지 못했어요."}
        </Paragraph>
        <Spacing size={8} />
        <Paragraph typography="t7" color={adaptive.grey600}>
          ‘약’이 붙은 시간은 직선거리로 계산했어요. 운영 시간과 요금은
          충전소에서 한 번 더 확인해 주세요.
        </Paragraph>
      </div>

      <StationSheet
        station={sheet}
        icName={sheet ? icOf(sheet)?.name : undefined}
        onClose={() => setSheet(null)}
      />

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
