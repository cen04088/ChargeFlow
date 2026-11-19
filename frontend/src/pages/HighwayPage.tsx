import {
  Button,
  ListRow,
  SearchField,
  Skeleton,
  useToast,
} from "@toss/tds-mobile";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  Link,
  Navigate,
  useLocation,
  useNavigate,
  useParams,
  useSearchParams,
} from "react-router-dom";

import { api } from "../api/client";
import type { Direction, HighwayNode } from "../api/types";
import { ErrorState } from "../components/ErrorState";
import { HighwayPickerSheet } from "../components/HighwayPickerSheet";
import {
  NearbyListSheet,
  type SheetToggleBy,
} from "../components/NearbyListSheet";
import { RouteMap, type RoutePin } from "../components/RouteMap";
import { directionLabel, shortAvailability, shortName } from "../lib/format";
import {
  listedRestAreas,
  loadLastHighway,
  raPin,
  saveLastHighway,
} from "../lib/highway";
import { findHighwayStart } from "../lib/highwayLocate";
import { loadHighways, useHighways } from "../lib/store";
import { getLocation, logClick, logScreen } from "../lib/toss";
import { useAsync } from "../lib/useAsync";
import { useElementHeight } from "../lib/useElementHeight";
import { aheadText, highwayPeek, nextRestArea } from "./highwayState";
import {
  LOCATE_TIMEOUT_MS,
  canUseMapLayout,
  floatButtons,
  locateWithTimeout,
  type Point,
} from "./nearbyState";

const REFRESH_MS = 60_000;
/** 지도 위 요소와 지도 가장자리·접힌 시트 사이 여백(px) */
const MAP_EDGE = 12;
const FLOAT_GAP = 8;
/** CSS .nearby-map-btn의 min-height와 같다 */
const MAP_BUTTON_MIN_H = 44;
const FOOTNOTE =
  "충전기 상태는 환경부 공공데이터를 10분마다 받아 와요. 현장과 다를 수 있어요.";

type From = "pin" | "peek" | "list";

/** /highways(노선 정하기)와 /highway/:code(노선 지도)가 같은 화면을 쓴다 */
export default function HighwayPage() {
  const { code } = useParams();
  return code ? <RouteView code={code} /> : <StartView />;
}

/** 노선 고르기 시트와 그 동작(노선 바꾸기, 내 위치로 찾기, 즐겨찾기·최근 열기) */
function usePicker(current?: { code: string; dir: Direction }) {
  const navigate = useNavigate();
  const highways = useHighways();
  const { openToast } = useToast();
  const [open, setOpen] = useState(false);
  const [locating, setLocating] = useState(false);
  const locatingRef = useRef(false);
  const alive = useRef<AbortController | null>(null);
  useEffect(() => {
    const c = new AbortController();
    alive.current = c;
    return () => c.abort();
  }, []);

  const go = (
    code: string,
    dir: Direction,
    by: "auto" | "sheet",
    me?: Point | null,
  ) => {
    logClick("highway_pick", { highway: code, by });
    setOpen(false);
    // 노선·방향 바꾸기는 뒤로가기 기록을 쌓지 않는다
    navigate(`/highway/${code}?dir=${dir}`, {
      replace: true,
      state: me ? { me } : undefined,
    });
  };

  const pickHighway = (code: string) => {
    logClick("home_open_highway", { highway: code });
    const last = loadLastHighway();
    const dir: Direction =
      current?.code === code
        ? current.dir
        : last?.code === code
          ? last.dir
          : "DOWN";
    go(code, dir, "sheet");
  };

  const locate = async () => {
    if (locatingRef.current || !alive.current) return;
    logClick("home_find_nearby");
    locatingRef.current = true;
    setLocating(true);
    let codes: string[] = [];
    try {
      codes = (await loadHighways()).map((h) => h.code);
    } catch {
      /* 노선 목록이 없으면 고를 수 없다 — 아래에서 안내 */
    }
    const signal = alive.current.signal;
    const r = await findHighwayStart({ last: null, codes, signal });
    if (signal.aborted) return;
    locatingRef.current = false;
    setLocating(false);
    if (r.start.by === "auto") {
      go(r.start.code, r.start.dir, "auto", r.me);
      return;
    }
    openToast(
      r.failure === "denied"
        ? "위치 권한을 켜면 가까운 고속도로를 찾아 드려요"
        : r.failure
          ? "현재 위치를 찾지 못했어요. 아래에서 골라 주세요"
          : "20km 안에 고속도로 휴게소가 없어요. 아래에서 골라 주세요",
    );
  };

  const openRestArea = (id: number, from: "favorite" | "recent") => {
    logClick("home_open_rest_area", { from });
    setOpen(false);
    navigate(`/rest-area/${id}`);
  };

  const sheet = (
    <HighwayPickerSheet
      open={open}
      onClose={() => setOpen(false)}
      highways={highways.data}
      highwaysError={highways.error}
      onRetryHighways={highways.reload}
      currentCode={current?.code}
      onPickHighway={pickHighway}
      onOpenRestArea={openRestArea}
      onLocate={() => void locate()}
      locating={locating}
    />
  );
  return { open, setOpen, sheet, go, highways };
}

/** /highways: 위치(20km) → 마지막 노선 → 노선 고르기 시트 순서로 노선을 정한다 */
function StartView() {
  const picker = usePicker();
  const [phase, setPhase] = useState<"deciding" | "sheet">("deciding");
  const openRef = useRef(picker.open);
  openRef.current = picker.open;
  const goRef = useRef(picker.go);
  goRef.current = picker.go;
  const setOpen = picker.setOpen;
  const navigate = useNavigate();

  useEffect(() => logScreen("highways"), []);

  useEffect(() => {
    const c = new AbortController();
    void (async () => {
      let codes: string[] = [];
      try {
        codes = (await loadHighways()).map((h) => h.code);
      } catch {
        /* 시트가 오류와 다시 시도를 보인다 */
      }
      if (c.signal.aborted) return;
      const toSheet = () => {
        setPhase("sheet");
        setOpen(true);
      };
      if (codes.length === 0) return toSheet();
      const r = await findHighwayStart({
        last: loadLastHighway(),
        codes,
        signal: c.signal,
      });
      if (c.signal.aborted) return;
      // 기다리는 사이 이용자가 직접 노선 고르기를 열었으면 그쪽을 따른다
      if (openRef.current) {
        setPhase("sheet");
        return;
      }
      if (r.start.by === "sheet") return toSheet();
      if (r.start.by === "auto") {
        goRef.current(r.start.code, r.start.dir, "auto", r.me);
        return;
      }
      logClick("highway_pick", { highway: r.start.code, by: "last" });
      navigate(`/highway/${r.start.code}?dir=${r.start.dir}`, {
        replace: true,
        state: r.me ? { me: r.me } : undefined,
      });
    })();
    return () => c.abort();
  }, [navigate, setOpen]);

  return (
    <main className="page">
      <div className="nearby-intro">
        <h1 className="sr-only">고속도로 휴게소</h1>
        <div className="nearby-controls" role="group" aria-label="고속도로 고르기">
          <Button
            type="button"
            className="nearby-filter"
            size="medium"
            variant="weak"
            color="primary"
            aria-haspopup="dialog"
            onClick={() => picker.setOpen(true)}
          >
            고속도로 고르기
          </Button>
          <Link
            to="/"
            className="nearby-ctrl nearby-ctrl--highway press"
          >
            주변 충전소
          </Link>
        </div>
      </div>
      <div className="nearby-body">
        {phase === "deciding" ? (
          <div aria-busy="true">
            <p className="nearby-progress" role="status">
              가까운 고속도로를 찾고 있어요
            </p>
            <Skeleton pattern="listOnly" repeatLastItemCount={4} />
          </div>
        ) : (
          <section className="highway-start" aria-labelledby="highway-start-title">
            <h2 id="highway-start-title">어느 고속도로로 가세요?</h2>
            <p>
              고속도로를 고르면 지도에 휴게소와 빈 충전기 수를 보여 드려요.
            </p>
            <div className="nearby-message__action">
              <Button
                size="large"
                display="full"
                aria-haspopup="dialog"
                onClick={() => picker.setOpen(true)}
              >
                고속도로 고르기
              </Button>
            </div>
          </section>
        )}
      </div>
      {picker.sheet}
    </main>
  );
}

/** 방향 바꾸기 아이콘(위아래 화살표) */
function SwapIcon() {
  return (
    <svg
      className="swap-icon"
      viewBox="0 0 20 20"
      width="18"
      height="18"
      aria-hidden="true"
      focusable="false"
    >
      <path
        d="M6 3v12M6 15l-3-3M6 15l3-3M14 17V5M14 5l-3 3M14 5l3 3"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function RouteView({ code }: { code: string }) {
  const navigate = useNavigate();
  const location = useLocation();
  const navMe = (location.state as { me?: Point } | null)?.me ?? null;
  const [params, setParams] = useSearchParams();
  const dir: Direction = params.get("dir") === "UP" ? "UP" : "DOWN";
  const picker = usePicker({ code, dir });
  const highways = picker.highways;
  const hw = highways.data?.find((h) => h.code === code);
  const dirLabel = directionLabel(highways.data, code, dir);
  const otherDir: Direction = dir === "DOWN" ? "UP" : "DOWN";
  const { openToast } = useToast();
  const toastRef = useRef(openToast);
  toastRef.current = openToast;

  const [me, setMe] = useState<Point | null>(navMe);
  const [locating, setLocating] = useState(false);
  const locatingRef = useRef(false);
  /** "내 위치"를 누를 때마다 범위를 다시 맞춘다 */
  const [fitNonce, setFitNonce] = useState(0);
  const [listOpen, setListOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [peekH, setPeekH] = useState(0);
  const [mapFailed, setMapFailed] = useState(false);
  const [viewportH, setViewportH] = useState(() => window.innerHeight);
  /** 검색 칸에 초점이 있는 동안의 배치 — 키보드가 화면을 줄여도 바꾸지 않는다 */
  const [frozenTall, setFrozenTall] = useState<boolean | null>(null);
  const handleRef = useRef<HTMLButtonElement>(null);
  const [setFloatEl, floatSpace] = useElementHeight<HTMLDivElement>();
  const [setMeBtnEl, meBtnH] = useElementHeight<HTMLButtonElement>();
  const alive = useRef<AbortController | null>(null);

  const key = `${code}|${dir}`;
  const nodes = useAsync(
    () => api.nodes(code, dir, "ALL").then((d) => ({ key, d })),
    [code, dir],
  );
  /** 지금 노선·방향의 응답만 쓴다(바꾼 직후 이전 응답은 버린다) */
  const current = nodes.data?.key === key ? nodes.data.d : null;

  useEffect(() => logScreen("highway", { highway: code }), [code]);

  // 들어오면 마지막 노선으로 저장한다(유효한 노선일 때)
  const valid = !!hw;
  useEffect(() => {
    if (valid) saveLastHighway(code, dir);
  }, [valid, code, dir]);

  // 방향·노선을 바꾸면 시트를 접고 검색을 비운다
  useEffect(() => {
    setListOpen(false);
    setQuery("");
  }, [code, dir]);

  // 화면이 보이는 동안 60초마다 조용히 새로 받는다(시트·검색·지도는 그대로)
  const { reload } = nodes;
  useEffect(() => {
    const timer = setInterval(() => {
      if (document.visibilityState === "visible") reload();
    }, REFRESH_MS);
    return () => clearInterval(timer);
  }, [reload]);

  useEffect(() => {
    const onResize = () => setViewportH(window.innerHeight);
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  const locate = async (fromTap: boolean) => {
    if (locatingRef.current || !alive.current) return;
    const signal = alive.current.signal;
    locatingRef.current = true;
    setLocating(true);
    const r = await locateWithTimeout(
      getLocation,
      LOCATE_TIMEOUT_MS,
      (late) => {
        if (late.ok) setMe({ lat: late.lat, lng: late.lng });
      },
      signal,
    );
    locatingRef.current = false;
    setLocating(false);
    if (r.ok) {
      setMe({ lat: r.lat, lng: r.lng });
      if (fromTap) setFitNonce((n) => n + 1);
      return;
    }
    if (fromTap) {
      toastRef.current(
        r.reason === "denied"
          ? "위치 권한을 켜면 내 위치를 보여 드려요"
          : "현재 위치를 찾지 못했어요. 잠시 후 다시 시도해 주세요",
      );
    }
  };

  // 화면을 떠나면 기다리던 위치 요청을 무른다. 들어올 때 위치를 한 번 받는다(넘겨받았으면 그대로)
  useEffect(() => {
    const c = new AbortController();
    alive.current = c;
    if (!navMe) void locate(false);
    return () => {
      c.abort();
      // 무른 요청은 끝나지 않는다 — 다음 요청을 막지 않게 푼다
      locatingRef.current = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const ras = useMemo(() => listedRestAreas(current?.nodes ?? []), [current]);
  const next = useMemo(() => nextRestArea({ nodes: ras, me }), [ras, me]);
  const nextIdx = next ? ras.findIndex((n) => n.id === next.id) : -1;
  /** 내 위치를 기점부터 거리로(다음 휴게소까지 직선거리를 뺀 값) */
  const meKm =
    nextIdx >= 0 && next
      ? ras[nextIdx].distance_from_start_km - next.aheadKm
      : null;

  const list = useMemo(() => {
    const q = query.replace(/\s/g, "");
    return ras.filter((n) => !q || n.name.replace(/\s/g, "").includes(q));
  }, [ras, query]);

  if (highways.data && !hw) return <Navigate to="/highways" replace />;

  const openRestArea = (id: number, from: From) => {
    logClick("highway_open_rest_area", { from });
    navigate(`/rest-area/${id}`);
  };

  const toggleList = (open: boolean, by: SheetToggleBy) => {
    logClick("highway_sheet_toggle", { open: open ? 1 : 0, by });
    setListOpen(open);
  };
  const openListFromButton = () => {
    toggleList(true, "button");
    requestAnimationFrame(() => handleRef.current?.focus({ preventScroll: true }));
  };

  const switchDirection = () => {
    logClick("highway_direction", { direction: otherDir });
    setParams({ dir: otherDir }, { replace: true, state: location.state });
  };

  const indexOf = (n: HighwayNode) => ras.indexOf(n);
  const caption = (n: HighwayNode) => {
    const i = indexOf(n);
    const ahead = aheadText(n, meKm != null && i >= nextIdx ? meKm : null);
    return i === nextIdx ? `다음 휴게소 · ${ahead}` : ahead;
  };
  const pinOf = (n: HighwayNode) =>
    n.congestion
      ? raPin(n.congestion)
      : { text: "정보 없음", kind: "unavailable" as const };

  const row = (n: HighwayNode, from: From) => {
    const p = pinOf(n);
    return (
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
            top={shortName(n.name)}
            topProps={{ fontWeight: "bold" }}
            bottom={from === "peek" ? shortAvailability(n.congestion) : caption(n)}
            bottomProps={{ typography: "t6", color: "var(--muted)" }}
          />
        }
        right={
          <span className={`nearby-row__count nearby-row__count--${p.kind}`}>
            {p.text}
          </span>
        }
        onClick={() => openRestArea(n.id, from)}
      />
    );
  };

  const loadFailed = !!nodes.error && !current;
  const loading = !current && !nodes.error;
  const tall = frozenTall ?? canUseMapLayout(viewportH);
  const mapLayout = tall && !mapFailed && !loadFailed;

  const freeze = {
    onFocus: () => setFrozenTall(tall),
    onBlur: () => setFrozenTall(null),
  };

  /** 펼친 시트 본문 / 쌓인 배치의 목록: 검색 → 구간 미리 보기 → 휴게소 전체 → 안내 */
  const listBody = (
    <section className="highway-list" aria-labelledby="highway-list-title">
      <div className="section-pad section-pad--flush highway-search" {...freeze}>
        <SearchField
          placeholder="휴게소 이름으로 찾기"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onDeleteClick={() => setQuery("")}
        />
      </div>
      <div className="route-shortcut">
        <ListRow
          contents={
            <ListRow.Texts
              type="2RowTypeA"
              top="구간 미리 보기"
              bottom="출발과 도착을 고르면 지날 휴게소를 순서대로 보여 드려요"
            />
          }
          arrowType="right"
          onClick={() => {
            logClick("highway_open_trip");
            navigate(`/trip?hw=${code}&dir=${dir}`);
          }}
        />
      </div>
      <div className="nearby-results-heading">
        <h2 id="highway-list-title">
          {loading ? "휴게소" : `휴게소 ${list.length}곳`}
        </h2>
        {list.length > 0 && (
          <span className="highway-list__order">{dirLabel} · 가는 순서</span>
        )}
      </div>
      {loading ? (
        <Skeleton pattern="listOnly" repeatLastItemCount={4} />
      ) : (
        <>
          {list.length === 0 && (
            <p className="flow-notice">
              {query.trim()
                ? `‘${query.trim()}’와 일치하는 휴게소가 없어요.`
                : "이 방향에 표시할 휴게소가 없어요."}
            </p>
          )}
          <ul className="nearby-rows">
            {list.map((n) => (
              <li key={n.id}>{row(n, "list")}</li>
            ))}
          </ul>
        </>
      )}
      <p className="nearby-time">{FOOTNOTE}</p>
    </section>
  );

  const controls = (
    <div className="nearby-intro">
      <h1 className="sr-only">{hw?.name ?? "고속도로 휴게소"}</h1>
      <div className="nearby-controls" role="group" aria-label="노선과 방향">
        <Button
          type="button"
          className="nearby-filter"
          size="medium"
          variant="weak"
          color="primary"
          aria-haspopup="dialog"
          onClick={() => picker.setOpen(true)}
        >
          {hw?.name ?? "고속도로 고르기"}
        </Button>
        <Button
          type="button"
          className="nearby-filter highway-dir"
          size="medium"
          variant="weak"
          color="dark"
          aria-label={`방향 바꾸기, 지금 ${dirLabel}`}
          onClick={switchDirection}
        >
          <span className="highway-dir__inner">
            {dirLabel}
            <SwapIcon />
          </span>
        </Button>
        <Link
          to="/"
          className="nearby-ctrl nearby-ctrl--highway press"
        >
          주변 충전소
        </Link>
      </div>
    </div>
  );

  if (!mapLayout) {
    return (
      <main className="page">
        {controls}
        <div className="nearby-body">
          {mapFailed && !loadFailed && (
            <div className="nearby-message">
              <p className="nearby-message__desc">
                지도를 불러오지 못해 목록으로 보여 드려요
              </p>
            </div>
          )}
          {loadFailed ? (
            <ErrorState error={nodes.error} onRetry={nodes.reload} />
          ) : (
            listBody
          )}
        </div>
        {picker.sheet}
      </main>
    );
  }

  const peek = highwayPeek({ nodes: ras, next, directionLabel: dirLabel, loading });
  const peekContent =
    peek.kind === "message" ? (
      <div className="nearby-peek">
        <p className="nearby-peek__title" role="status">
          {peek.title}
        </p>
      </div>
    ) : (
      <div className="nearby-peek">
        <p className="nearby-peek__label">{peek.label}</p>
        <div className="nearby-peek__row">{row(peek.node, "peek")}</div>
        {peek.more > 0 && (
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

  const pins: RoutePin[] = ras.map((n, i) => {
    const p = pinOf(n);
    const isNext = i === nextIdx;
    return {
      id: n.id,
      lat: +n.latitude,
      lng: +n.longitude,
      text: p.text,
      kind: p.kind,
      ariaLabel: `${shortName(n.name)} ${p.text}${isNext ? ", 다음 휴게소" : ""}`,
      // 다음 휴게소 > 그 뒤 가는 순서 > 지나온 곳(가까운 순)
      priority:
        nextIdx < 0 ? i : i >= nextIdx ? i - nextIdx : 1000 + (nextIdx - i),
      emphasized: isNext,
    };
  });
  const path = (current?.nodes ?? []).map((n) => ({
    lat: +n.latitude,
    lng: +n.longitude,
  }));
  const fit =
    next && me
      ? [
          me,
          ...ras
            .slice(nextIdx, nextIdx + 2)
            .map((n) => ({ lat: +n.latitude, lng: +n.longitude })),
        ]
      : path;

  const { showMe } = floatButtons({
    space: floatSpace,
    here: false,
    buttonH: meBtnH || MAP_BUTTON_MIN_H,
    gap: FLOAT_GAP,
  });

  return (
    <main className="page page--map">
      {controls}
      <div className="nearby-map-wrap nearby-map-wrap--full">
        <RouteMap
          label={`${hw?.name ?? "고속도로"} ${dirLabel} 휴게소 지도`}
          path={path}
          pins={pins}
          me={me}
          fit={fit}
          fitKey={`${key}|${fitNonce}`}
          softFitKey={next ? "me" : "route"}
          focusId={null}
          topInset={0}
          bottomInset={peekH}
          onSelect={(id) => openRestArea(id, "pin")}
          onMapTap={() => {
            if (listOpen) toggleList(false, "map");
          }}
          onFailed={() => setMapFailed(true)}
        />
        <div
          ref={setFloatEl}
          className="nearby-map-float"
          style={{ top: MAP_EDGE, bottom: peekH + MAP_EDGE, gap: FLOAT_GAP }}
        >
          {showMe && (
            <button
              ref={setMeBtnEl}
              type="button"
              className="nearby-map-btn nearby-map-btn--me glass press"
              aria-busy={locating}
              aria-disabled={locating}
              onClick={() => void locate(true)}
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
          label={`${dirLabel} 휴게소 목록`}
        >
          {listBody}
        </NearbyListSheet>
      </div>
      {picker.sheet}
    </main>
  );
}
