import {
  BottomSheet,
  Button,
  ListRow,
  Skeleton,
  useToast,
} from "@toss/tds-mobile";
import { adaptive } from "@toss/tds-colors";
import { useCallback, useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";

import { ApiError, api } from "../api/client";
import type { NearbyStation, NearbyStationsResponse } from "../api/types";
import { ConnectorPicker } from "../components/ConnectorPicker";
import { ErrorState } from "../components/ErrorState";
import { NearbyMap } from "../components/NearbyMap";
import { NearbySheet } from "../components/NearbySheet";
import {
  REGIONS,
  countText,
  loadLastLocation,
  rowCaption,
  saveLastLocation,
  summaryText,
  type Region,
} from "../lib/nearby";
import { connectorName, useConnector } from "../lib/store";
import { getLocation, logClick, logScreen } from "../lib/toss";
import {
  LOCATE_TIMEOUT_MS,
  fallbackCopy,
  fetchedText,
  locateWithTimeout,
  nearbyView,
  nextCenter,
  noneDesc,
  type LocFailure,
  type OriginSource,
  type Point,
} from "./nearbyState";

const REFRESH_MS = 60_000;

const REGION_TITLE: Record<LocFailure | "pick", string> = {
  denied: "위치를 켜지 않아도 지역을 골라 찾을 수 있어요",
  failed: "현재 위치를 찾지 못했어요. 지역을 골라 주세요",
  pick: "지역을 골라 주세요",
};

function countColor(s: NearbyStation) {
  if (s.state === "available") return "var(--brand-strong)";
  return s.state === "full" ? adaptive.grey600 : adaptive.red700;
}

export default function NearbyPage() {
  const navigate = useNavigate();
  const { openToast } = useToast();
  const toastRef = useRef(openToast);
  toastRef.current = openToast;
  const [connector] = useConnector();

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
  const [regionsRequested, setRegionsRequested] = useState(false);
  const [mapFailed, setMapFailed] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [sheet, setSheet] = useState<NearbyStation | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);

  // 비동기 콜백에서 최신 값을 읽기 위한 ref
  const originRef = useRef<Point | null>(null);
  const connectorRef = useRef(connector);
  connectorRef.current = connector;
  const hasResult = useRef(false);
  const searchSeq = useRef(0);
  const locSeq = useRef(0);
  /** 위치를 받는 중 — 같은 렌더 안의 연타도 막도록 ref로 든다 */
  const locatingRef = useRef(false);
  /** 화면이 떠 있는 동안의 취소 신호 */
  const alive = useRef<AbortController | null>(null);
  const inflight = useRef(false);

  /** 가장 최근 요청의 응답만 화면에 반영한다 */
  const search = useCallback(
    async (p: Point, silent = false) => {
      const id = ++searchSeq.current;
      inflight.current = true;
      if (!silent) {
        setSearching(true);
        setError(null);
      }
      try {
        const r = await api.nearbyStations(p.lat, p.lng, connectorRef.current);
        if (id !== searchSeq.current) return;
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
        if (hasResult.current && !(err instanceof ApiError && err.status === 400)) {
          toastRef.current(err.message || "잠시 후 다시 시도해 주세요");
        }
      } finally {
        if (id === searchSeq.current) {
          inflight.current = false;
          setSearching(false);
        }
      }
    },
    [],
  );

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
      void search(p);
    },
    [search],
  );

  const locate = useCallback(
    async (fromTap: boolean) => {
      const id = ++locSeq.current;
      locatingRef.current = true;
      setLocating(true);
      // 기기가 끝내 답하지 않아도 지역 선택으로 넘어갈 수 있게 시간 제한을 둔다.
      // 제한 뒤에 온 응답은 성공일 때만, 그사이 다른 조작이 없었으면 반영한다
      const r = await locateWithTimeout(getLocation, LOCATE_TIMEOUT_MS, (late) => {
        if (!late.ok) return;
        saveLastLocation(late.lat, late.lng);
        const p = { lat: late.lat, lng: late.lng };
        setMe(p);
        if (id !== locSeq.current) return;
        setLocFailure(null);
        searchFrom(p, "me", true);
      }, alive.current?.signal);
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

  // 충전 규격이 바뀌면 같은 기준점으로 다시 찾는다
  const prevConnector = useRef(connector);
  useEffect(() => {
    if (prevConnector.current === connector) return;
    prevConnector.current = connector;
    const p = originRef.current;
    if (p) {
      setExpanded(false);
      void search(p);
    }
  }, [connector, search]);

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
    searchFrom({ lat: r.lat, lng: r.lng }, "region", true);
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

  const view = nearbyView({
    hasOrigin: origin != null,
    source,
    result,
    errorStatus:
      error == null ? null : error instanceof ApiError ? error.status : 0,
    locFailure,
    regionsRequested,
    expanded,
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

  const highwayRow = (
    <div className="nearby-bottom">
      <button
        type="button"
        className="nearby-highway press"
        onClick={() => {
          logClick("nearby_open_highway");
          navigate("/highways");
        }}
      >
        <span className="nearby-highway__label">고속도로 가는 날이에요</span>
        <span className="nearby-highway__action">
          휴게소 보기
          <svg
            width="20"
            height="20"
            viewBox="0 0 24 24"
            aria-hidden="true"
            fill="none"
            stroke="currentColor"
            strokeWidth="2.2"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d="M9 6l6 6-6 6" />
          </svg>
        </span>
      </button>
    </div>
  );

  const stations = result?.stations ?? [];

  return (
    <div className="page nearby-page">
      {showMap && center && (
        <div className="nearby-map-wrap">
          <NearbyMap
            center={center}
            me={me}
            stations={stations}
            focusId={liveSheet?.id ?? null}
            onSelect={(id) => {
              const s = stations.find((x) => x.id === id);
              if (s) openStation(s, "pin");
            }}
            onMoved={(p) => setMoved(p)}
            onFailed={() => {
              setMapFailed(true);
              setMoved(null);
            }}
          />
          {result && (
            <span className="nearby-chip glass" aria-live="polite">
              {summaryText(stations)}
            </span>
          )}
          <button
            type="button"
            className="nearby-map-btn nearby-map-btn--connector glass press"
            onClick={openPicker}
          >
            {connector ? connectorName(connector) : "충전 규격"}
          </button>
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
        </div>
      )}

      <div className="nearby-body">
        {view.kind === "loading" && (
          <Skeleton pattern="listOnly" repeatLastItemCount={3} />
        )}

        {view.kind === "error" && (
          <ErrorState error={error ?? undefined} onRetry={retry} />
        )}

        {view.kind === "regions" && (
          <div className="rise">
            <div className="nearby-regions__head">
              <h1 className="nearby-regions__title">{REGION_TITLE[view.reason]}</h1>
              <Button
                size="large"
                variant="weak"
                display="full"
                loading={locating}
                aria-disabled={locating}
                onClick={locateMe}
              >
                위치 켜고 다시 찾기
              </Button>
            </div>
            {REGIONS.map((r) => (
              <ListRow
                key={r.name}
                contents={<ListRow.Texts type="1RowTypeA" top={r.name} />}
                arrowType="right"
                onClick={() => pickRegion(r)}
              />
            ))}
          </div>
        )}

        {(view.kind === "list" || view.kind === "none" || view.kind === "stale") &&
          result && (
          <div className={"nearby-list" + (searching ? " nearby-list--busy" : "")}>
            {mapFailed && (
              <div className="nearby-controls">
                <button
                  type="button"
                  className="nearby-ctrl press"
                  onClick={() => setRegionsRequested(true)}
                >
                  다른 지역에서 찾기
                </button>
                <button
                  type="button"
                  className="nearby-ctrl press"
                  onClick={openPicker}
                >
                  {connector ? connectorName(connector) : "충전 규격"}
                </button>
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

            {view.notice && (
              <div className="nearby-notice">
                <p className="nearby-notice__text">
                  현재 위치를 찾지 못해 지난번 위치로 보여 드려요
                </p>
                <button
                  type="button"
                  className="nearby-notice__action"
                  aria-busy={locating}
                  aria-disabled={locating}
                  onClick={locateMe}
                >
                  위치 켜고 다시 찾기
                </button>
              </div>
            )}

            {view.kind === "none" && (
              <div className="nearby-message">
                <p className="nearby-message__title">30km 안에 급속충전소가 없어요</p>
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
                    <li key={s.id}>
                      <button
                        type="button"
                        className={
                          "nearby-row" +
                          (liveSheet?.id === s.id ? " row-focused" : "")
                        }
                        onClick={() => openStation(s, "list")}
                      >
                        <span className="nearby-row__text">
                          <span className="nearby-row__name">{s.name}</span>
                          <span className="nearby-row__caption">
                            {rowCaption(s, Date.now())}
                          </span>
                        </span>
                        <span
                          className="nearby-row__count"
                          style={{ color: countColor(s) }}
                        >
                          {countText(s)}
                        </span>
                      </button>
                    </li>
                  ))}
                </ul>
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
          </div>
        )}
      </div>

      {highwayRow}

      <NearbySheet station={liveSheet} onClose={() => setSheet(null)} />

      <BottomSheetPicker open={pickerOpen} onClose={() => setPickerOpen(false)} />
    </div>
  );
}

function BottomSheetPicker({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}) {
  return (
    <BottomSheet
      open={open}
      onDimmerClick={onClose}
      header={<BottomSheet.Header>내 차 충전 규격</BottomSheet.Header>}
      headerDescription={
        <BottomSheet.HeaderDescription>
          고르면 맞는 충전소만 보여 드려요. 다음에도 기억해요.
        </BottomSheet.HeaderDescription>
      }
    >
      <div className="sheet-body">
        <ConnectorPicker onPicked={onClose} />
      </div>
    </BottomSheet>
  );
}
