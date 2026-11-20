import {
  BottomSheet,
  Button,
  Chip,
  ChipItem,
  ListRow,
  Skeleton,
  useToast,
} from "@toss/tds-mobile";
import { useCallback, useEffect, useRef, useState } from "react";
import { Link, useLocation, useNavigate } from "react-router-dom";

import { ApiError, api } from "../api/client";
import type { NearbyStation, NearbyStationsResponse } from "../api/types";
import { ConnectorPicker } from "../components/ConnectorPicker";
import { ErrorState } from "../components/ErrorState";
import {
  NearbyListSheet,
  type SheetToggleBy,
} from "../components/NearbyListSheet";
import { ModeTabLabel, ModeTabs } from "../components/ModeTabs";
import { NearbyMap } from "../components/NearbyMap";
import { NearbySheet } from "../components/NearbySheet";
import { PlaceSearch } from "../components/PlaceSearch";
import { SheetHeading } from "../components/SheetHeading";
import {
  REGIONS,
  countText,
  loadLastLocation,
  rowCaption,
  saveLastLocation,
  summaryText,
  type Region,
} from "../lib/nearby";
import type { Place } from "../lib/placeSearch";
import {
  MIN_POWER_OPTIONS,
  connectorName,
  useConnector,
  useMinPower,
} from "../lib/store";
import { useElementHeight } from "../lib/useElementHeight";
import { getLocation, logClick, logScreen } from "../lib/toss";
import {
  LOCATE_TIMEOUT_MS,
  canGoBack,
  canUseMapLayout,
  fallbackCopy,
  floatButtons,
  fetchedText,
  locateWithTimeout,
  nearbyView,
  nextCenter,
  noneDesc,
  peekInfo,
  type LocFailure,
  type OriginSource,
  type Point,
} from "./nearbyState";

const REFRESH_MS = 60_000;
/** 지도 위 요소와 지도 가장자리·접힌 시트 사이 여백(px) */
const MAP_EDGE = 12;
/** 지도 위 떠 있는 버튼 사이·위쪽 줄과의 간격(px) */
const FLOAT_GAP = 8;
/** 지도 위 버튼을 아직 재지 못했을 때 쓰는 높이 — CSS .nearby-map-btn의 min-height와 같다 */
const MAP_BUTTON_MIN_H = 44;

const REGION_TITLE: Record<LocFailure | "pick", string> = {
  denied: "위치 권한 없이도 주소를 검색하거나 지역을 골라 찾을 수 있어요.",
  failed: "현재 위치를 확인하지 못했어요. 주소를 검색하거나 지역을 골라 주세요.",
  pick: "내 위치로 찾거나, 주소·장소를 검색하거나, 지역을 골라 주세요.",
};

export default function NearbyPage() {
  const { openToast } = useToast();
  const toastRef = useRef(openToast);
  toastRef.current = openToast;
  const [connector] = useConnector();
  const [minKw] = useMinPower();
  const navigate = useNavigate();
  const location = useLocation();
  const cameFromHighway =
    (location.state as { from?: string } | null)?.from === "highway";

  /** 지도 중심 — 내 위치를 받았거나 지역을 골랐을 때만 바뀐다 */
  const [center, setCenter] = useState<Point | null>(null);
  /** 검색 기준점 — 내 위치, 지역, "이 위치에서 찾기" 중 마지막 것 */
  const [origin, setOrigin] = useState<Point | null>(null);
  const [source, setSource] = useState<OriginSource | null>(null);
  /** 실제 기기 위치(파란 점) */
  const [me, setMe] = useState<Point | null>(null);
  /** 이용자가 끌어 놓은 지도 중심. 있으면 "이 위치에서 찾기"가 보인다 */
  const [moved, setMoved] = useState<Point | null>(null);

  const [result, setResult] = useState<NearbyStationsResponse | null>(null);
  const [error, setError] = useState<Error | null>(null);
  const [searching, setSearching] = useState(false);
  const [locating, setLocating] = useState(false);
  const [locFailure, setLocFailure] = useState<LocFailure | null>(null);
  /** 처음 열었고 지난번 위치도 없다 — 위치를 기다리지 않고 바로 "어디에서 찾을까요?"를 보인다 */
  const [firstRun] = useState(() => loadLastLocation() == null);
  const [regionsRequested, setRegionsRequested] = useState(firstRun);
  const [regionName, setRegionName] = useState("");
  const [mapFailed, setMapFailed] = useState(false);
  /** 지도 실패 화면의 쌓인 목록에서 "N곳 더 보기"를 눌렀다 */
  const [expanded, setExpanded] = useState(false);
  /** 지도 위 목록 시트가 펼쳐져 있다 */
  const [listOpen, setListOpen] = useState(false);
  /** 접힌 목록 시트 높이 — 지도 위 버튼과 범위 맞춤 여백을 그만큼 올린다 */
  const [peekH, setPeekH] = useState(0);
  /** 웹뷰 높이 — 낮으면(가로 화면 등) 지도 시트 대신 쌓인 배치 */
  const [viewportH, setViewportH] = useState(() => window.innerHeight);
  const handleRef = useRef<HTMLButtonElement>(null);
  // 지도 위 떠 있는 버튼 자리: 위쪽 줄 높이, 버튼 칸의 높이, 버튼 높이를 잰다
  const [setTopRowEl, topRowH] = useElementHeight<HTMLDivElement>();
  const [setFloatEl, floatSpace] = useElementHeight<HTMLDivElement>();
  const [setMeBtnEl, meBtnH] = useElementHeight<HTMLButtonElement>();
  const [setHereBtnEl, hereBtnH] = useElementHeight<HTMLButtonElement>();
  const [sheet, setSheet] = useState<NearbyStation | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);

  // 비동기 콜백에서 최신 값을 읽기 위한 ref
  const originRef = useRef<Point | null>(null);
  const connectorRef = useRef(connector);
  connectorRef.current = connector;
  const minKwRef = useRef(minKw);
  minKwRef.current = minKw;
  const hasResult = useRef(false);
  const searchSeq = useRef(0);
  const locSeq = useRef(0);
  /** 위치를 받는 중 — 같은 렌더 안의 연타도 막도록 ref로 든다 */
  const locatingRef = useRef(false);
  /** 화면이 떠 있는 동안의 취소 신호 */
  const alive = useRef<AbortController | null>(null);
  const inflight = useRef(false);

  /** 가장 최근 요청의 응답만 화면에 반영한다 */
  const search = useCallback(async (p: Point, silent = false) => {
    const id = ++searchSeq.current;
    inflight.current = true;
    if (!silent) {
      setSearching(true);
      setError(null);
    }
    try {
      const kw = minKwRef.current;
      const raw = await api.nearbyStations(
        p.lat,
        p.lng,
        connectorRef.current,
        kw,
      );
      if (id !== searchSeq.current) return;
      // 서버가 출력 조건을 모르는 버전이어도 화면에는 조건에 맞는 곳만 보인다
      const r = kw
        ? { ...raw, stations: raw.stations.filter((s) => s.power_kw >= kw) }
        : raw;
      hasResult.current = true;
      setResult(r);
      setError(null);
      // 열려 있는 시트는 새 값으로, 목록에서 사라졌으면 마지막 값 그대로
      setSheet((prev) =>
        prev ? (r.stations.find((s) => s.id === prev.id) ?? prev) : prev,
      );
    } catch (e) {
      if (id !== searchSeq.current || silent) return;
      const err = e instanceof Error ? e : new Error(String(e));
      setError(err);
      if (
        hasResult.current &&
        !(err instanceof ApiError && err.status === 400)
      ) {
        toastRef.current(err.message || "잠시 후 다시 시도해 주세요");
      }
    } finally {
      if (id === searchSeq.current) {
        inflight.current = false;
        setSearching(false);
      }
    }
  }, []);

  /** 새 기준점으로 찾는다. moveMap이면 지도 중심도 그곳으로 옮긴다 */
  const searchFrom = useCallback(
    (p: Point, src: OriginSource, moveMap: boolean) => {
      if (moveMap) setCenter((prev) => nextCenter(prev, p));
      originRef.current = p;
      setOrigin(p);
      setSource(src);
      setMoved(null);
      setRegionsRequested(false);
      setExpanded(false);
      // 기준점이 바뀌면 목록 시트를 접는다(새 결과의 첫 줄이 보이게)
      setListOpen(false);
      void search(p);
    },
    [search],
  );

  const locate = useCallback(
    async (fromTap: boolean) => {
      const id = ++locSeq.current;
      // 화면을 열 때의 자동 조회는 버튼을 막지도, 도는 표시를 띄우지도 않는다
      if (fromTap) {
        locatingRef.current = true;
        setLocating(true);
      }
      // 기기가 끝내 답하지 않아도 지역 선택으로 넘어갈 수 있게 시간 제한을 둔다.
      // 제한 뒤에 온 응답은 성공일 때만, 그사이 다른 조작이 없었으면 반영한다
      const r = await locateWithTimeout(
        // 권한 창은 이용자가 "내 위치"를 눌렀을 때만 띄운다
        () => getLocation(fromTap),
        LOCATE_TIMEOUT_MS,
        (late) => {
          if (!late.ok) return;
          saveLastLocation(late.lat, late.lng);
          const p = { lat: late.lat, lng: late.lng };
          setMe(p);
          if (id !== locSeq.current) return;
          setLocFailure(null);
          searchFrom(p, "me", true);
        },
        alive.current?.signal,
      );
      if (r.ok) saveLastLocation(r.lat, r.lng);
      // 실패 기록은 응답이 늦었어도 시도마다 한 번 남긴다
      else logClick("nearby_location_denied", { reason: r.reason });
      if (id !== locSeq.current) {
        // 그사이 이용자가 지역·지도 위치를 직접 골랐다 — 파란 점만 갱신한다
        if (r.ok) setMe({ lat: r.lat, lng: r.lng });
        return;
      }
      locatingRef.current = false;
      setLocating(false);
      if (!r.ok) {
        setLocFailure(r.reason);
        if (fromTap) {
          toastRef.current(
            r.reason === "denied"
              ? "위치 권한을 켜면 내 위치에서 찾아 드려요"
              : "현재 위치를 찾지 못했어요. 잠시 후 다시 시도해 주세요",
          );
        }
        return;
      }
      const p = { lat: r.lat, lng: r.lng };
      setLocFailure(null);
      setMe(p);
      searchFrom(p, "me", true);
    },
    [searchFrom],
  );

  // 화면을 떠나면 기다리던 위치 요청을 무른다(시간 제한 기록·토스트·검색이 남지 않게).
  // 첫 진입 효과보다 먼저 선언해 locate가 이 화면의 signal을 쓰게 한다
  useEffect(() => {
    const c = new AbortController();
    alive.current = c;
    return () => c.abort();
  }, []);

  // 첫 진입: 지난번 위치가 있으면 그걸로 먼저 채우고, 현재 위치를 받는다
  useEffect(() => {
    logScreen("nearby");
    const last = loadLastLocation();
    if (last) searchFrom(last, "last", true);
    void locate(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 충전 규격이나 최소 출력이 바뀌면 같은 기준점으로 다시 찾는다
  const prevFilter = useRef(`${connector}|${minKw}`);
  useEffect(() => {
    const key = `${connector}|${minKw}`;
    if (prevFilter.current === key) return;
    prevFilter.current = key;
    const p = originRef.current;
    if (p) {
      setExpanded(false);
      void search(p);
    }
  }, [connector, minKw, search]);

  // 화면이 보이는 동안 60초마다 조용히 새로 받는다
  useEffect(() => {
    const timer = setInterval(() => {
      const p = originRef.current;
      if (!p || inflight.current || document.visibilityState !== "visible")
        return;
      void search(p, true);
    }, REFRESH_MS);
    return () => clearInterval(timer);
  }, [search]);

  const pickRegion = (r: Region) => {
    logClick("nearby_region_pick", { region: r.name });
    ++locSeq.current; // 기다리던 위치 응답이 지도를 옮기지 않게
    locatingRef.current = false;
    setLocating(false);
    setMe(null);
    setRegionName(r.name);
    // 먼 곳으로 옮긴다 — 이전 위치의 충전소로 지도 범위를 맞추지 않게 결과를 비운다
    setResult(null);
    searchFrom({ lat: r.lat, lng: r.lng }, "region", true);
  };

  /** 검색한 주소·장소를 기준점으로 삼는다(지역 고르기와 같은 흐름) */
  const pickPlace = (p: Place) => {
    logClick("nearby_place_pick");
    ++locSeq.current;
    locatingRef.current = false;
    setLocating(false);
    setMe(null);
    setRegionName(p.name);
    setResult(null);
    searchFrom({ lat: p.lat, lng: p.lng }, "region", true);
  };

  const searchHere = () => {
    if (!moved) return;
    logClick("nearby_search_here");
    ++locSeq.current;
    locatingRef.current = false;
    setLocating(false);
    searchFrom(moved, "here", false);
  };

  const openPicker = () => setPickerOpen(true);
  /** 위치를 받는 중에는 다시 누르지 않게 한다(권한 창·요청이 겹치지 않게) */
  const locateMe = () => {
    if (locatingRef.current) return;
    void locate(true);
  };

  const openStation = (s: NearbyStation, from: "pin" | "list") => {
    logClick("nearby_station_open", { from, station_id: s.id });
    setSheet(s);
  };

  const retry = () => {
    const p = originRef.current;
    if (p) void search(p);
    else locateMe();
  };

  /** 정보 수신 불가 화면의 "다시 시도": 같은 기준점·규격으로 다시 찾는다 */
  const retryStale = () => {
    logClick("nearby_retry");
    const p = originRef.current;
    if (p) void search(p);
  };

  const toggleList = (open: boolean, by: SheetToggleBy) => {
    logClick("nearby_sheet_toggle", { open: open ? 1 : 0, by });
    setListOpen(open);
  };

  /** 접힌 줄의 "N곳 더 보기"·"충전 중인 N곳 보기": 목록 시트를 펼친다.
   *  누른 버튼은 펼치면 숨으므로 포커스를 손잡이로 옮긴다 */
  const openListFromButton = () => {
    logClick("nearby_more");
    toggleList(true, "button");
    requestAnimationFrame(() => handleRef.current?.focus({ preventScroll: true }));
  };

  // 화면 높이(회전·주소창)를 따라간다
  useEffect(() => {
    const onResize = () => setViewportH(window.innerHeight);
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);
  const tall = canUseMapLayout(viewportH);

  const view = nearbyView({
    hasOrigin: origin != null,
    source,
    result,
    errorStatus:
      error == null ? null : error instanceof ApiError ? error.status : 0,
    locFailure,
    regionsRequested,
    expanded,
    stacked: mapFailed || !tall,
  });

  // 지역 고르기 화면으로 바뀌면 열려 있던 충전소 시트를 닫는다
  const viewKind = view.kind;
  useEffect(() => {
    if (viewKind === "regions") setSheet(null);
  }, [viewKind]);

  // 열린 시트는 최신 목록의 같은 충전소를 보여 준다
  const liveSheet = sheet
    ? (result?.stations.find((s) => s.id === sheet.id) ?? sheet)
    : null;

  const showMap =
    !mapFailed &&
    center != null &&
    (view.kind === "loading" ||
      view.kind === "list" ||
      view.kind === "none" ||
      view.kind === "stale");

  /** 지도가 머리말 아래를 채우고 목록이 시트로 얹히는 배치 */
  const mapLayout = showMap && tall;

  const stations = result?.stations ?? [];
  // 기준점이 아직 없으면(처음 연 화면) 고르기 화면을 닫을 수 없다 — 닫으면 빈 로딩만 남는다
  const regionRequired =
    view.kind === "regions" && (view.reason !== "pick" || origin == null);

  const stationRow = (s: NearbyStation) => (
    <ListRow
      as="div"
      className="nearby-row"
      horizontalPadding="small"
      arrowType="right"
      border="none"
      withTouchEffect
      contents={
        <ListRow.Texts
          type="2RowTypeA"
          top={s.name}
          topProps={{ fontWeight: "bold" }}
          bottom={rowCaption(s, Date.now())}
          bottomProps={{
            typography: "t6",
            color: "var(--muted)",
          }}
        />
      }
      right={
        <span className={`nearby-row__count nearby-row__count--${s.state}`}>
          {countText(s)}
        </span>
      }
      onClick={() => openStation(s, "list")}
    />
  );

  /** 결과 구역: 지도 실패 화면에서는 쌓인 목록, 지도 화면에서는 펼친 시트 본문 */
  const resultsSection = (inSheet: boolean) =>
    (view.kind === "list" || view.kind === "none" || view.kind === "stale") &&
    result && (
      <section
        className="nearby-list"
        aria-busy={searching}
        aria-labelledby="nearby-results-title"
      >
        <div className="nearby-results-heading">
          <h2 id="nearby-results-title">
            {source === "region" ? `${regionName} 주변` : "검색 결과"}
          </h2>
          {/* 지도 화면에서는 지도 위 칩이 같은 요약을 보인다 */}
          {view.kind === "list" && !inSheet && (
            <span className="nearby-results-summary">
              {summaryText(stations)}
            </span>
          )}
        </div>
        {mapFailed && (
          <div className="nearby-map-fallback">
            <div>
              <p>지도를 불러오지 못했어요</p>
              {view.notice && <p>지난번 위치로 보여 드려요</p>}
            </div>
            <button
              type="button"
              className="nearby-ctrl nearby-ctrl--me press"
              aria-busy={locating}
              aria-disabled={locating}
              onClick={locateMe}
            >
              내 위치
            </button>
          </div>
        )}

        {searching && (
          <p className="nearby-progress" role="status">
            검색 결과를 새로 불러오고 있어요
          </p>
        )}

        {view.notice && !mapFailed && (
          <div className="nearby-notice">
            <p className="nearby-notice__text">
              현재 위치를 찾지 못해 지난번 위치로 보여 드려요
            </p>
          </div>
        )}

        {view.kind === "none" && (
          <div className="nearby-message">
            <p className="nearby-message__title">
              30km 안에 급속충전소가 없어요
            </p>
            <p className="nearby-message__desc">{noneDesc(mapFailed)}</p>
          </div>
        )}

        {view.kind === "stale" && (
          <div className="nearby-message">
            <p className="nearby-message__title">
              지금 충전소 정보를 받지 못하고 있어요
            </p>
            <p className="nearby-message__desc">잠시 후 다시 확인해 주세요</p>
            <div className="nearby-message__action">
              <Button
                size="large"
                variant="weak"
                display="full"
                loading={searching}
                onClick={retryStale}
              >
                다시 시도
              </Button>
            </div>
          </div>
        )}

        {view.kind === "list" && (
          <>
            {view.fallback && (
              <div className="nearby-message">
                <p className="nearby-message__title">
                  {fallbackCopy(view.fallback, result.radius_km).title}
                </p>
                <p className="nearby-message__desc">
                  {fallbackCopy(view.fallback, result.radius_km).desc}
                </p>
              </div>
            )}
            <ul className="nearby-rows">
              {view.rows.map((s) => (
                <li
                  key={s.id}
                  className={liveSheet?.id === s.id ? "row-focused" : undefined}
                >
                  {stationRow(s)}
                </li>
              ))}
            </ul>
            {/* 지도 실패 화면에서만 잘린다(지도 시트에는 전부 들어 있다) */}
            {view.hidden > 0 && (
              <div className="section-pad section-pad--tight">
                <Button
                  size="large"
                  variant="weak"
                  display="full"
                  onClick={() => {
                    logClick("nearby_more");
                    setExpanded(true);
                  }}
                >
                  {`${view.hidden}곳 더 보기`}
                </Button>
              </div>
            )}
          </>
        )}

        {view.kind !== "stale" && (
          <p className="nearby-time">{fetchedText(result.fetched_at)}</p>
        )}
      </section>
    );

  const peek = peekInfo({
    view,
    radiusKm: result?.radius_km ?? 0,
    searching,
    hasOrigin: origin != null,
  });

  /** 접힌 시트에 보이는 줄: 가장 가까운 빈 곳, 또는 지금 상태의 안내 제목 */
  const peekBody =
    peek.kind === "station" ? (
      <div className="nearby-peek">
        <p className="nearby-peek__label">{peek.label}</p>
        <div
          className={
            liveSheet?.id === peek.station.id
              ? "nearby-peek__row row-focused"
              : "nearby-peek__row"
          }
        >
          {stationRow(peek.station)}
        </div>
        {peek.more > 0 && (
          <div className="nearby-peek__action">
            <Button
              size="large"
              variant="weak"
              display="full"
              onClick={openListFromButton}
            >
              {`${peek.more}곳 더 보기`}
            </Button>
          </div>
        )}
      </div>
    ) : (
      <div className="nearby-peek">
        <p className="nearby-peek__title" role="status">
          {peek.title}
        </p>
        {peek.subtitle && (
          <p className="nearby-peek__subtitle">{peek.subtitle}</p>
        )}
        {peek.action === "retry" && (
          <div className="nearby-peek__action">
            <Button
              size="large"
              variant="weak"
              display="full"
              loading={searching}
              onClick={retryStale}
            >
              다시 시도
            </Button>
          </div>
        )}
        {peek.moreLabel && (peek.more ?? 0) > 0 && (
          <div className="nearby-peek__action">
            <Button
              size="large"
              variant="weak"
              display="full"
              onClick={openListFromButton}
            >
              {peek.moreLabel}
            </Button>
          </div>
        )}
      </div>
    );

  /** 새로 찾는 중(조용한 60초 갱신은 제외)이면 손잡이 줄에 상태 한 줄을 겹쳐 둔다 —
   *  접힌 시트 높이(지도 여백·떠 있는 버튼 자리)는 바뀌지 않는다 */
  const peekContent = (
    <div className="nearby-peek-wrap" aria-busy={peek.status != null}>
      <p className="nearby-peek__status" role="status">
        {peek.status ?? ""}
      </p>
      {peekBody}
    </div>
  );

  const { showHere, showMe } = floatButtons({
    space: floatSpace,
    here: moved != null,
    buttonH: meBtnH || hereBtnH || MAP_BUTTON_MIN_H,
    gap: FLOAT_GAP,
  });

  return (
    <main className={mapLayout ? "page page--map" : "page"}>
      <div className="nearby-intro">
        {/* 제목은 화면낭독기에만 — 보이는 상단은 한 줄이다: 화면 탭 + 검색·충전 규격 아이콘 */}
        <h1 className="sr-only">주변 급속충전소</h1>
        <div className="nearby-top">
          <ModeTabs
            current="nearby"
            other={
              <Link
                to="/highways"
                state={{ from: "home" }}
                className="mode-tab press"
                aria-label="고속도로 휴게소"
                onClick={(e) => {
                  logClick("nearby_open_highway");
                  // 고속도로 화면에서 "주변 충전소"로 왔으면 뒤로 간다(홈 ↔ 고속도로 기록이 쌓이지 않게)
                  if (cameFromHighway) {
                    e.preventDefault();
                    // 앞 기록이 정말 있을 때만 뒤로(복원된 웹뷰에서 앱을 닫지 않게). 없으면 바꿔 연다
                    if (canGoBack(location.key)) navigate(-1);
                    else navigate("/highways", { replace: true });
                  }
                }}
              >
                <ModeTabLabel mode="highway" />
              </Link>
            }
          />
          <button
            type="button"
            className={
              view.kind === "regions" ? "icon-btn icon-btn--on press" : "icon-btn press"
            }
            aria-label="주소로 찾기"
            aria-expanded={view.kind === "regions"}
            disabled={regionRequired}
            onClick={() => setRegionsRequested((open) => !open)}
          >
            <svg width="24" height="24" viewBox="0 0 24 24" fill="none" aria-hidden="true">
              <circle cx="10.5" cy="10.5" r="6.5" stroke="currentColor" strokeWidth="2.2" />
              <path d="m15.5 15.5 5 5" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" />
            </svg>
          </button>
          <button
            type="button"
            className={
              connector || minKw ? "icon-btn icon-btn--on press" : "icon-btn press"
            }
            aria-label={
              connector || minKw
                ? `충전 설정: ${[
                    connector ? connectorName(connector) : "",
                    minKw ? `${minKw}kW 이상` : "",
                  ]
                    .filter(Boolean)
                    .join(", ")}`
                : "충전 규격과 속도 고르기"
            }
            aria-haspopup="dialog"
            onClick={openPicker}
          >
            <svg width="24" height="24" viewBox="0 0 24 24" fill="none" aria-hidden="true">
              <path
                d="M13.5 2.5 5 13.5h6l-1 8 8.5-11h-6l1-8Z"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinejoin="round"
              />
            </svg>
          </button>
        </div>
      </div>

      {/* 지도는 큰 화면(시트)과 낮은 화면(쌓인 배치)에서 같은 자리에 두어 다시 만들지 않는다 */}
      {showMap && center && (
        <div
          key="map"
          className={
            mapLayout
              ? "nearby-map-wrap nearby-map-wrap--full"
              : "nearby-map-wrap"
          }
        >
          <NearbyMap
            center={center}
            me={me}
            stations={stations}
            focusId={liveSheet?.id ?? null}
            mode="count"
            bottomInset={mapLayout ? peekH : 0}
            layoutKey={mapLayout ? "sheet" : "stacked"}
            topInset={mapLayout && topRowH > 0 ? MAP_EDGE + topRowH : 0}
            onSelect={(id) => {
              const s = stations.find((x) => x.id === id);
              if (s) openStation(s, "pin");
            }}
            onMoved={(p) => setMoved(p)}
            onFailed={() => {
              setMapFailed(true);
              setMoved(null);
            }}
            onMapTap={() => {
              if (mapLayout && listOpen) toggleList(false, "map");
            }}
          />

          {mapLayout ? (
            <>
              <div ref={setTopRowEl} className="nearby-map-top">
                {view.kind === "list" && (
                  <p className="nearby-chip glass">{summaryText(stations)}</p>
                )}
              </div>

              {/* 위쪽 줄과 접힌 시트 사이에 오른쪽으로 쌓는다. 자리가 모자라면 "내 위치"부터 숨긴다
                  (펼친 시트에는 가려져도 된다) */}
              <div
                ref={setFloatEl}
                className="nearby-map-float"
                style={{
                  top: MAP_EDGE + topRowH + FLOAT_GAP,
                  bottom: peekH + MAP_EDGE,
                  gap: FLOAT_GAP,
                }}
              >
                {showHere && (
                  <button
                    ref={setHereBtnEl}
                    type="button"
                    className="nearby-map-btn nearby-map-btn--here press"
                    onClick={searchHere}
                  >
                    이 위치에서 찾기
                  </button>
                )}
                {showMe && (
                  <button
                    ref={setMeBtnEl}
                    type="button"
                    className="nearby-map-btn nearby-map-btn--me glass press"
                    aria-busy={locating}
                    aria-disabled={locating}
                    onClick={locateMe}
                  >
                    내 위치
                  </button>
                )}
              </div>

              <NearbyListSheet
                open={listOpen}
                onToggle={toggleList}
                peek={peekContent}
                onPeekHeight={setPeekH}
                handleRef={handleRef}
              >
                {view.kind === "loading" ? (
                  <>
                    <p className="nearby-progress">
                      {origin
                        ? "급속충전소를 찾고 있어요"
                        : "현재 위치를 확인하고 있어요"}
                    </p>
                    <Skeleton pattern="listOnly" repeatLastItemCount={3} />
                  </>
                ) : (
                  resultsSection(true)
                )}
              </NearbyListSheet>
            </>
          ) : (
            <>
              {moved && (
                <div className="nearby-here">
                  <button
                    type="button"
                    className="nearby-map-btn nearby-map-btn--here press"
                    onClick={searchHere}
                  >
                    이 위치에서 찾기
                  </button>
                </div>
              )}
              <button
                type="button"
                className="nearby-map-btn nearby-map-btn--me glass press"
                aria-busy={locating}
                aria-disabled={locating}
                onClick={locateMe}
              >
                내 위치
              </button>
            </>
          )}
        </div>
      )}

      {!mapLayout && (
        <div key="stacked" className="nearby-body">
          {view.kind === "loading" && (
            <>
              <p className="nearby-progress" role="status">
                {origin
                  ? "급속충전소를 찾고 있어요"
                  : "현재 위치를 확인하고 있어요"}
              </p>
              <Skeleton pattern="listOnly" repeatLastItemCount={3} />
            </>
          )}

          {view.kind === "error" && (
            <ErrorState error={error ?? undefined} onRetry={retry} />
          )}

          {view.kind === "regions" && (
            <section
              className="nearby-regions rise"
              aria-labelledby="nearby-regions-title"
            >
              <div className="nearby-regions__head">
                <h2 className="nearby-regions__title" id="nearby-regions-title">
                  어디에서 찾을까요?
                </h2>
                <p>{REGION_TITLE[view.reason]}</p>
              </div>
              {/* 내 위치가 가장 쉬운 길 — 맨 위에 둔다. 권한은 이 버튼을 눌렀을 때 묻는다 */}
              <div className="nearby-regions__locate">
                <Button
                  size="large"
                  display="full"
                  loading={locating}
                  aria-disabled={locating}
                  onClick={locateMe}
                >
                  내 위치로 찾기
                </Button>
              </div>
              <PlaceSearch
                autoFocus={view.reason === "pick" && !firstRun}
                onPick={pickPlace}
              />
              <h3 className="nearby-regions__sub">지역으로 고르기</h3>
              <ul className="nearby-regions__grid">
                {REGIONS.map((r) => (
                  <li key={r.name}>
                    <button
                      type="button"
                      className="nearby-region press"
                      onClick={() => pickRegion(r)}
                    >
                      {r.name}
                    </button>
                  </li>
                ))}
              </ul>
            </section>
          )}

          {resultsSection(false)}
        </div>
      )}

      <NearbySheet station={liveSheet} onClose={() => setSheet(null)} />

      <BottomSheetPicker
        open={pickerOpen}
        onClose={() => setPickerOpen(false)}
      />
    </main>
  );
}

function BottomSheetPicker({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}) {
  const [minKw, saveMinKw] = useMinPower();
  return (
    <BottomSheet
      open={open}
      onDimmerClick={onClose}
      onClose={onClose}
      aria-label="내 차 충전 설정"
      header={<SheetHeading title="내 차 충전 설정" onClose={onClose} />}
      headerDescription={
        <BottomSheet.HeaderDescription>
          고르면 맞는 충전소만 보여 드려요. 다음에도 기억해요.
        </BottomSheet.HeaderDescription>
      }
    >
      <div className="sheet-body charge-settings">
        <h3 className="charge-settings__title">충전 규격</h3>
        <ConnectorPicker />
        <h3 className="charge-settings__title">충전 속도</h3>
        <Chip
          kind="select"
          size="medium"
          wrap
          margin="none"
          className="touch-chips"
        >
          {MIN_POWER_OPTIONS.map((o) => (
            <ChipItem
              key={o.value}
              selected={o.value === minKw}
              onClick={() => {
                logClick("min_power_pick", { kw: o.value });
                saveMinKw(o.value);
              }}
            >
              {o.label}
            </ChipItem>
          ))}
        </Chip>
        <div className="charge-settings__done">
          <Button size="large" display="full" onClick={onClose}>
            확인
          </Button>
        </div>
      </div>
    </BottomSheet>
  );
}
