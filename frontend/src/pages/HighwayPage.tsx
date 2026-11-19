import {
  Button,
  ListRow,
  SearchField,
  Skeleton,
  useToast,
} from "@toss/tds-mobile";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
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
import { ModeTabLabel, ModeTabs } from "../components/ModeTabs";
import {
  NearbyListSheet,
  type SheetToggleBy,
} from "../components/NearbyListSheet";
import { RouteMap, type RoutePin } from "../components/RouteMap";
import { RouteMiniMap } from "../components/RouteMiniMap";
import { RouteStrip } from "../components/RouteStrip";
import { RaStatusText } from "../components/RestAreaRow";
import { directionLabel, shortName, timeAgo } from "../lib/format";
import {
  AUTO_PICK_KM,
  listedRestAreas,
  loadLastHighway,
  raAriaLabel,
  raPin,
  saveLastHighway,
} from "../lib/highway";
import { findHighwayStart } from "../lib/highwayLocate";
import { loadHighways, useHighways } from "../lib/store";
import { getLocation, logClick, logScreen } from "../lib/toss";
import { useAsync } from "../lib/useAsync";
import { useElementHeight } from "../lib/useElementHeight";
import { alongRouteKm, buildStrip, shouldAutoScroll } from "./highwayStrip";
import {
  TRAVEL_FRESH_MS,
  aheadText,
  checkTravel,
  highwayPeek,
  distanceKm,
  nearestRestArea,
  nextRestArea,
} from "./highwayState";
import {
  LOCATE_TIMEOUT_MS,
  canGoBack,
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

/** 고속도로 화면으로 넘기는 router state */
interface NavState {
  /** 이미 받은 내 위치 */
  me?: Point;
  /** 그 위치를 받은 시각(Date.now) — 오래되면(뒤로가기·앱 복귀) 믿지 않는다 */
  at?: number;
  /** 이 노선·방향이 이용자가 가는 방향이다(위치로 고를 때 direction_matched) */
  travel?: { code: string; dir: Direction };
  /** 홈에서 왔다 — "주변 충전소"는 새로 쌓지 않고 뒤로 간다 */
  from?: "home";
}

function navState(state: unknown): NavState {
  return (state as NavState | null) ?? {};
}

/** 홈으로: 홈에서 왔으면 뒤로(기록이 쌓이지 않게), 아니면 새로 연다 */
function HomeLink({ from }: { from?: "home" }) {
  const navigate = useNavigate();
  const location = useLocation();
  return (
    <Link
      to="/"
      state={{ from: "highway" }}
      className="mode-tab press"
      onClick={(e) => {
        if (from !== "home") return;
        e.preventDefault();
        // 앞 기록이 정말 있을 때만 뒤로(복원된 웹뷰에서 앱을 닫지 않게). 없으면 바꿔 연다
        if (canGoBack(location.key)) navigate(-1);
        else navigate("/", { replace: true });
      }}
    >
      <ModeTabLabel mode="nearby" />
    </Link>
  );
}

/** /highways(노선 정하기)와 /highway/:code(노선 지도)가 같은 화면을 쓴다 */
export default function HighwayPage() {
  const { code } = useParams();
  return code ? <RouteView code={code} /> : <StartView />;
}

/** 노선 고르기 시트와 그 동작(노선 바꾸기, 내 위치로 찾기, 즐겨찾기·최근 열기) */
function usePicker(current?: { code: string; dir: Direction }) {
  const navigate = useNavigate();
  const from = navState(useLocation().state).from;
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
    matched = false,
  ) => {
    logClick("highway_pick", { highway: code, by });
    setOpen(false);
    // 노선·방향 바꾸기는 뒤로가기 기록을 쌓지 않는다. 직접 고르면 가는 방향(travel)이 아니다
    const state: NavState = {
      me: me ?? undefined,
      at: me ? Date.now() : undefined,
      travel: matched ? { code, dir } : undefined,
      from,
    };
    navigate(`/highway/${code}?dir=${dir}`, { replace: true, state });
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
    const signal = alive.current.signal;
    let codes: string[] = [];
    try {
      codes = (await loadHighways()).map((h) => h.code);
    } catch {
      /* 아래에서 안내 */
    }
    if (signal.aborted) return;
    if (codes.length === 0) {
      // 노선 목록을 아직 못 받았다 — 위치로 고를 수 없다
      locatingRef.current = false;
      setLocating(false);
      openToast("잠시 후 다시 시도해 주세요");
      return;
    }
    const r = await findHighwayStart({ last: null, codes, signal });
    if (signal.aborted) return;
    locatingRef.current = false;
    setLocating(false);
    if (r.me) logClick("home_nearby_result", { matched: r.matched ? 1 : 0 });
    if (r.start.by === "auto") {
      go(r.start.code, r.start.dir, "auto", r.me, r.matched);
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
  return { open, setOpen, sheet, go, highways, from };
}

/** /highways: 위치(20km 안의 휴게소)로 노선을 정하고, 못 정하면 노선 고르기 시트를 연다 */
function StartView() {
  const picker = usePicker();
  const [phase, setPhase] = useState<"deciding" | "sheet">("deciding");
  /** 위치를 못 받은 이유 — 노선 고르기 안내에 한 줄 붙인다 */
  const [failure, setFailure] = useState<"denied" | "failed" | null>(null);
  const from = picker.from;
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
        // 지난번에 본 노선으로 바로 들어가지 않는다 — 위치로 못 정하면 이용자가 직접 고른다
        last: null,
        codes,
        signal: c.signal,
      });
      if (c.signal.aborted) return;
      setFailure(r.failure ?? null);
      // 기다리는 사이 이용자가 직접 노선 고르기를 열었으면 그쪽을 따른다
      if (openRef.current) {
        setPhase("sheet");
        return;
      }
      if (r.start.by === "sheet") return toSheet();
      if (r.start.by === "auto") {
        goRef.current(r.start.code, r.start.dir, "auto", r.me, r.matched);
        return;
      }
      logClick("highway_pick", { highway: r.start.code, by: "last" });
      const state: NavState = {
        me: r.me ?? undefined,
        at: r.me ? Date.now() : undefined,
        from,
      };
      navigate(`/highway/${r.start.code}?dir=${r.start.dir}`, {
        replace: true,
        state,
      });
    })();
    return () => c.abort();
  }, [navigate, setOpen, from]);

  return (
    <main className="page">
      <div className="nearby-intro">
        <h1 className="sr-only">고속도로 휴게소</h1>
        <ModeTabs current="highway" other={<HomeLink from={from} />} />
        {/* 고르기 버튼은 한 곳에만: 찾는 중에는 여기, 다 찾고 나면 아래 안내 카드에 */}
        {phase === "deciding" && (
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
          </div>
        )}
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
            {failure && (
              <p>
                {failure === "denied"
                  ? "위치 권한이 없어도 고속도로를 골라 찾을 수 있어요"
                  : "현재 위치를 찾지 못했어요. 고속도로를 골라 주세요"}
              </p>
            )}
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
  const nav = navState(location.state);
  const navMe = nav.me ?? null;
  const [params, setParams] = useSearchParams();
  const dir: Direction = params.get("dir") === "UP" ? "UP" : "DOWN";
  const picker = usePicker({ code, dir });
  const highways = picker.highways;
  const hw = highways.data?.find((h) => h.code === code);
  const dirLabel = directionLabel(highways.data, code, dir);
  /** 이 노선·방향이 이용자가 가는 방향으로 골라졌는지 — 위치로 고른 방향(direction_matched)일 때만.
   *  방향을 바꾸거나 직접 고르거나 마지막 노선으로 왔으면 false("다음 휴게소 · 앞"이라고 하지 않는다) */
  const navTravel = nav.travel?.code === code && nav.travel.dir === dir;
  const otherDir: Direction = dir === "DOWN" ? "UP" : "DOWN";
  const { openToast } = useToast();
  const toastRef = useRef(openToast);
  toastRef.current = openToast;

  /** 받은 위치와 받은 시각. 넘겨받은 위치는 기록(history.state)에서 오므로 오래됐을 수 있다 */
  const [fix, setFix] = useState<{ me: Point; at: number } | null>(() =>
    navMe ? { me: navMe, at: nav.at ?? 0 } : null,
  );
  /** 위치가 2분 넘게 묵었다 — 새 위치가 올 때까지 내 위치·"다음 휴게소"에 쓰지 않는다 */
  const [stale, setStale] = useState(
    () => navMe != null && Date.now() - (nav.at ?? 0) > TRAVEL_FRESH_MS,
  );
  /** 새 위치로 보니 가는 방향이 아니었다(노선을 벗어남·종점 지남·반대로 감) */
  const [dropped, setDropped] = useState(false);
  const me = fix && !stale ? fix.me : null;
  const travel = navTravel && !dropped && me != null;
  const fixRef = useRef(fix);
  fixRef.current = fix;
  /** 1분마다 위치를 다시 받을지: 가는 방향으로 보는 중이거나 위치가 묵었다 */
  const refreshMeRef = useRef(false);
  refreshMeRef.current = (navTravel && !dropped) || stale;
  const [locating, setLocating] = useState(false);
  const locatingRef = useRef(false);
  /** "내 위치"를 누를 때마다 범위를 다시 맞춘다 */
  const [fitNonce, setFitNonce] = useState(0);
  /** 보기: 노선 띠(기본, 들어올 때마다) 또는 지도 + 시트 */
  const [mode, setMode] = useState<"strip" | "map">("strip");
  /** 노선 띠에서 지나온 휴게소를 펼쳤다 */
  const [showPassed, setShowPassed] = useState(false);
  /** 가까운 휴게소 자동 스크롤을 이미 썼거나 이용자가 손댄 노선·방향(code|dir) */
  const autoScrollSpent = useRef<Set<string>>(new Set());
  /** 지도 보기로 갈 때의 띠 스크롤 위치 — 돌아오면 되살린다 */
  const stripScrollY = useRef<number | null>(null);
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
    setShowPassed(false);
  }, [code, dir]);

  // 화면이 보이는 동안 60초마다 조용히 새로 받는다(시트·검색·지도는 그대로).
  // 가는 방향으로 보는 중이면 위치도 한 번 다시 받는다(실패하면 이전 위치를 두되 시각은 늘리지 않는다)
  const { reload } = nodes;
  useEffect(() => {
    const timer = setInterval(() => {
      if (document.visibilityState !== "visible") return;
      reload();
      const f = fixRef.current;
      if (f && Date.now() - f.at > TRAVEL_FRESH_MS) setStale(true);
      if (refreshMeRef.current) void locateRef.current(false);
    }, REFRESH_MS);
    return () => clearInterval(timer);
  }, [reload]);

  // 다시 보일 때(앱 복귀) 위치가 묵었으면 쓰지 않고 새로 받는다
  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState !== "visible") return;
      const f = fixRef.current;
      if (f && Date.now() - f.at <= TRAVEL_FRESH_MS) return;
      if (f) setStale(true);
      void locateRef.current(false);
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, []);

  // 노선·방향을 다른 위치 정보와 함께 다시 고르면(새 기록) 그 위치로 다시 시작한다
  // 위치·가는 방향은 이 렌더에서 바로 바꾼다(렌더 중 상태 조정) — 효과로 바꾸면 한 번은 이전 위치로
  // "가는 방향"을 판정해 새 기록의 travel을 잘못 버릴 수 있다
  const navKey = location.key;
  const [seenNavKey, setSeenNavKey] = useState(navKey);
  if (seenNavKey !== navKey) {
    setSeenNavKey(navKey);
    setDropped(false);
    const n = navState(location.state);
    if (n.me) {
      setFix({ me: n.me, at: n.at ?? 0 });
      setStale(Date.now() - (n.at ?? 0) > TRAVEL_FRESH_MS);
    }
  }
  const prevNavKey = useRef(navKey);
  const prevNextIdx = useRef<number | null>(null);
  useEffect(() => {
    if (prevNavKey.current === navKey) return;
    prevNavKey.current = navKey;
    prevNextIdx.current = null;
    const n = navState(location.state);
    if (n.me && Date.now() - (n.at ?? 0) > TRAVEL_FRESH_MS) {
      void locateRef.current(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [navKey]);

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
        if (!late.ok) return;
        setFix({ me: { lat: late.lat, lng: late.lng }, at: Date.now() });
        setStale(false);
      },
      signal,
    );
    locatingRef.current = false;
    setLocating(false);
    if (r.ok) {
      setFix({ me: { lat: r.lat, lng: r.lng }, at: Date.now() });
      setStale(false);
      if (fromTap) {
        setFitNonce((n) => n + 1);
        // 직접 "내 위치"를 눌렀으면 띠에서 가까운 휴게소로 한 번 더 데려간다
        autoScrollSpent.current.delete(keyRef.current);
      }
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

  const locateRef = useRef(locate);
  locateRef.current = locate;

  // 화면을 떠나면 기다리던 위치 요청을 무른다. 들어올 때 위치를 한 번 받는다
  // (넘겨받은 위치가 2분 안의 것이면 그대로 쓴다)
  useEffect(() => {
    const c = new AbortController();
    alive.current = c;
    if (!fixRef.current || stale) void locate(false);
    return () => {
      c.abort();
      // 무른 요청은 끝나지 않는다 — 다음 요청을 막지 않게 푼다
      locatingRef.current = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const ras = useMemo(() => listedRestAreas(current?.nodes ?? []), [current]);
  const geoNext = useMemo(() => nextRestArea({ nodes: ras, me }), [ras, me]);
  /** 가는 방향일 때만 "다음 휴게소" */
  const next = travel ? geoNext : null;
  const nextIdx = next ? ras.findIndex((n) => n.id === next.id) : -1;
  const near = useMemo(() => nearestRestArea({ nodes: ras, me }), [ras, me]);

  // 새 위치마다 가는 방향이 맞는지 다시 본다: 노선을 벗어났거나 종점을 지났거나 다음 휴게소가
  // 뒤로 갔으면(반대로 가는 중) "다음 휴게소"를 그만 말한다
  const geoIdx = geoNext ? ras.findIndex((n) => n.id === geoNext.id) : -1;
  useEffect(() => {
    if (!navTravel || dropped || !fix || ras.length === 0) return;
    const v = checkTravel({
      fixAt: stale ? null : fix.at,
      now: Date.now(),
      nextIdx: geoIdx,
      prevNextIdx: prevNextIdx.current,
    });
    if (v === "drop") setDropped(true);
    else if (v === "keep") prevNextIdx.current = geoIdx;
  }, [navTravel, dropped, fix, stale, ras, geoIdx]);
  const nearIdx = near ? ras.findIndex((n) => n.id === near.id) : -1;
  /** 내 위치를 노선 위 거리(기점부터 km)로 — 노선 선에 내린 발. 못 구하면 직선거리로 어림 */
  const meKm =
    nextIdx >= 0 && next && me
      ? (alongRouteKm(current?.nodes ?? [], me) ??
        ras[nextIdx].distance_from_start_km - next.aheadKm)
      : null;

  const list = useMemo(() => {
    const q = query.replace(/\s/g, "");
    return ras.filter((n) => !q || n.name.replace(/\s/g, "").includes(q));
  }, [ras, query]);

  const loadFailed = !!nodes.error && !current;
  const loading = !current && !nodes.error;
  const tall = frozenTall ?? canUseMapLayout(viewportH);

  // 지도 배치를 쓸 수 없게 되면(불러오기 실패·회전·낮은 화면) 띠로 되돌린다 — 나중에 저절로 지도로 바뀌지 않게
  useEffect(() => {
    if (mode === "map" && (!tall || mapFailed || loadFailed)) setMode("strip");
  }, [mode, tall, mapFailed, loadFailed]);

  // 띠로 돌아오면 지도로 가기 전 스크롤 위치를 되살린다
  useLayoutEffect(() => {
    if (mode !== "strip" || stripScrollY.current == null) return;
    window.scrollTo(0, stripScrollY.current);
    stripScrollY.current = null;
  }, [mode]);

  // 띠에서 이용자가 손대면(스크롤·터치·휠·키) 그 노선·방향의 자동 스크롤은 쓴 것으로 친다
  const keyRef = useRef(key);
  keyRef.current = key;
  useEffect(() => {
    if (mode !== "strip") return;
    const spend = () => autoScrollSpent.current.add(keyRef.current);
    const events = ["scroll", "wheel", "touchstart", "pointerdown", "keydown"] as const;
    events.forEach((e) => window.addEventListener(e, spend, { passive: true }));
    return () => events.forEach((e) => window.removeEventListener(e, spend));
  }, [mode]);

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
    // 방향을 바꾸면 가는 방향이 아니다(travel을 뺀다)
    const state: NavState = { me: fix?.me, at: fix?.at, from: nav.from };
    setParams({ dir: otherDir }, { replace: true, state });
  };

  const indexOf = (n: HighwayNode) => ras.indexOf(n);
  /** "약 Nkm 앞"은 가는 방향일 때만(meKm은 next가 있을 때만 있다), 아니면 기점부터 거리 */
  const caption = (n: HighwayNode) => {
    const i = indexOf(n);
    const ahead = aheadText(n, meKm != null && i >= nextIdx ? meKm : null);
    if (i === nextIdx) return `다음 휴게소 · ${ahead}`;
    if (nextIdx < 0 && i === nearIdx) return `가까운 휴게소 · ${ahead}`;
    return ahead;
  };
  const pinOf = (n: HighwayNode) =>
    n.congestion
      ? raPin(n.congestion)
      : { text: "정보 없음", kind: "unavailable" as const };

  /** 접힌 줄 둘째 줄: 빈 대수는 오른쪽에 있으니 전체 충전기 수와 확인 시각만 */
  const peekCaption = (n: HighwayNode) => {
    const c = n.congestion;
    if (!c || c.level === "unknown" || c.total == null) return "실시간 정보 없음";
    return `충전기 ${c.total}대` + (c.checked_at ? ` · ${timeAgo(c.checked_at)}` : "");
  };

  const row = (n: HighwayNode, from: From) => {
    // 오른쪽: 상태 단어 + 빈 대수(두 줄) — 색만으로 상태를 가르지 않는다
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
            bottom={from === "peek" ? peekCaption(n) : caption(n)}
            bottomProps={{ typography: "t6", color: "var(--muted)" }}
          />
        }
        right={<RaStatusText congestion={n.congestion} />}
        onClick={() => openRestArea(n.id, from)}
      />
    );
  };

  const mapLayout = mode === "map" && tall && !mapFailed && !loadFailed;

  /** 작은 지도 창 → 지도 보기. 화면이 낮으면 지도 배치를 쓸 수 없다 */
  const openMap = () => {
    if (!canUseMapLayout(window.innerHeight)) {
      toastRef.current("지도를 불러오지 못했어요");
      return;
    }
    logClick("highway_view_mode", { mode: "map" });
    stripScrollY.current = window.scrollY;
    autoScrollSpent.current.add(key);
    setMode("map");
  };
  const openStrip = () => {
    logClick("highway_view_mode", { mode: "strip" });
    setListOpen(false);
    setMode("strip");
  };

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
      <ModeTabs current="highway" other={<HomeLink from={nav.from} />} />
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
      </div>
    </div>
  );

  const at = (n: { latitude: string; longitude: string }) => ({
    lat: +n.latitude,
    lng: +n.longitude,
  });
  const path = (current?.nodes ?? []).map(at);

  if (!mapLayout) {
    // 노선 띠(내비 고속도로 모드): 검색 → 머리말 + 작은 지도 창 → 띠 → 구간 미리 보기 → 안내. 페이지가 스크롤된다
    const strip = buildStrip({
      nodes: current?.nodes ?? [],
      listed: ras,
      travel: next && meKm != null ? { nextId: next.id, meKm } : null,
      nearId: !travel && near ? near.id : null,
      query,
      showPassed,
    });
    const searching = query.trim() !== "";
    const stripTravel = next != null && meKm != null;
    const title = loading
      ? "휴게소"
      : searching
        ? `휴게소 ${strip.items.length}곳`
        : stripTravel
          ? `앞으로 휴게소 ${strip.aheadCount}곳`
          : `휴게소 ${ras.length}곳`;
    /** 작은 지도 창의 내 위치: 노선 근처(20km)일 때만 그리고 맞춤에도 넣는다 */
    const miniMe =
      me && path.some((p) => distanceKm(me, p) <= AUTO_PICK_KM) ? me : null;
    const nearTarget = !travel && near ? near.id : null;
    return (
      <main className="page">
        {controls}
        <div className="strip-page">
          <div className="section-pad section-pad--flush highway-search">
            <SearchField
              placeholder="휴게소 이름으로 찾기"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onDeleteClick={() => setQuery("")}
            />
          </div>
          {loadFailed ? (
            <ErrorState error={nodes.error} onRetry={nodes.reload} />
          ) : (
            <section aria-labelledby="highway-list-title">
              <div className="strip-head">
                <div className="strip-head__text">
                  <h2 id="highway-list-title">{title}</h2>
                  <p>{dirLabel} · 가는 순서</p>
                  {/* 위치가 없으면(시간 초과·권한 없음) 여기서 다시 받는다. 있으면 다시 재기 */}
                  <button
                    type="button"
                    className={`strip-locate${me ? " strip-locate--quiet" : ""}`}
                    aria-busy={locating}
                    aria-disabled={locating}
                    onClick={() => void locate(true)}
                  >
                    {me ? "내 위치 새로 고침" : "내 위치로 보기"}
                  </button>
                </div>
                {!mapFailed && path.length >= 2 && (
                  <RouteMiniMap path={path} me={miniMe} onClick={openMap} />
                )}
              </div>
              {loading ? (
                <Skeleton pattern="listOnly" repeatLastItemCount={5} />
              ) : strip.items.length === 0 ? (
                <p className="flow-notice">
                  {searching
                    ? `‘${query.trim()}’와 일치하는 휴게소가 없어요.`
                    : "이 방향에 표시할 휴게소가 없어요."}
                </p>
              ) : (
                <RouteStrip
                  items={strip.items}
                  passedCount={strip.passedCount}
                  onOpen={(id) => openRestArea(id, "list")}
                  onShowPassed={() => setShowPassed(true)}
                  scrollToId={
                    shouldAutoScroll({
                      targetId: nearTarget,
                      spent: autoScrollSpent.current.has(key),
                      searching,
                    })
                      ? nearTarget
                      : null
                  }
                  armKey={`${key}|${fitNonce}`}
                  isSpent={() => autoScrollSpent.current.has(keyRef.current)}
                  onAutoScrolled={() => autoScrollSpent.current.add(keyRef.current)}
                />
              )}
            </section>
          )}
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
          <p className="nearby-time">{FOOTNOTE}</p>
        </div>
        {picker.sheet}
      </main>
    );
  }

  const peek = highwayPeek({
    nodes: ras,
    next: geoNext,
    near,
    travel,
    directionLabel: dirLabel,
    loading,
  });
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

  /** 강조할 휴게소: 다음 휴게소, 없으면(가는 방향을 모름) 가까운 휴게소 */
  const focusIdx = nextIdx >= 0 ? nextIdx : nearIdx;
  const pins: RoutePin[] = ras.map((n, i) => {
    const p = pinOf(n);
    const role =
      i === nextIdx ? ", 다음 휴게소" : i === focusIdx ? ", 가까운 휴게소" : "";
    return {
      id: n.id,
      lat: +n.latitude,
      lng: +n.longitude,
      text: p.text,
      kind: p.kind,
      ariaLabel: raAriaLabel(shortName(n.name), n.congestion) + role,
      // 다음 휴게소 > 그 뒤 가는 순서 > 지나온 곳. 가는 방향을 모르면 가까운 휴게소에서 가까운 순
      priority:
        nextIdx >= 0
          ? i >= nextIdx
            ? i - nextIdx
            : 1000 + (nextIdx - i)
          : nearIdx >= 0
            ? Math.abs(i - nearIdx)
            : i,
      emphasized: i === focusIdx,
    };
  });
  // 가는 방향: 내 위치 + 다음 휴게소 두 곳. 노선 가까이: 내 위치 + 가까운 휴게소.
  // 아니면 노선 전체(+ "내 위치"를 눌렀으면 내 위치도 화면에 들어오게)
  const fit =
    me && nextIdx >= 0
      ? [me, ...ras.slice(nextIdx, nextIdx + 2).map(at)]
      : me && nearIdx >= 0
        ? [me, at(ras[nearIdx])]
        : me && fitNonce > 0 && path.length > 0
          ? [...path, me]
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
          softFitKey={nextIdx >= 0 ? "next" : nearIdx >= 0 ? "near" : "route"}
          focusId={null}
          topInset={MAP_EDGE + MAP_BUTTON_MIN_H}
          bottomInset={peekH}
          onSelect={(id) => openRestArea(id, "pin")}
          onMapTap={() => {
            if (listOpen) toggleList(false, "map");
          }}
          onFailed={() => {
            // 지도를 못 불러오면 띠로 돌아가고 작은 지도 창을 숨긴다
            setMapFailed(true);
            setMode("strip");
            toastRef.current("지도를 불러오지 못했어요");
          }}
        />
        {/* 지도 위 왼쪽 위: 노선 띠로 돌아가기(그 줄의 핀은 RouteMap이 점으로 줄인다) */}
        <div className="nearby-map-top">
          <button
            type="button"
            className="nearby-map-btn route-map-back glass press"
            onClick={openStrip}
          >
            목록으로 보기
          </button>
        </div>
        <div
          ref={setFloatEl}
          className="nearby-map-float"
          style={{
            top: MAP_EDGE + MAP_BUTTON_MIN_H + FLOAT_GAP,
            bottom: peekH + MAP_EDGE,
            gap: FLOAT_GAP,
          }}
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
