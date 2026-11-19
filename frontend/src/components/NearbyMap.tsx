import { useCallback, useEffect, useRef, useState } from "react";

import type { NearbyStation } from "../api/types";
import { loadKakaoMaps } from "../lib/kakao";
import {
  declutterPins,
  isDotLevel,
  pinPriority,
  isUltraFast,
  pinLabel,
  pinText,
  shouldRefitForInset,
  type PinMode,
} from "../lib/nearby";

interface Point {
  lat: number;
  lng: number;
}

interface NearbyMapProps {
  center: Point;
  me: Point | null;
  stations: NearbyStation[];
  focusId: number | null;
  /** 핀 글자: 빈 대수·상태 또는 최대 출력 */
  mode: PinMode;
  /** 지도 아래쪽을 가리는 시트 높이(px) — 다음 범위 맞춤의 아래 여백에 더한다 */
  bottomInset: number;
  onSelect: (id: number) => void;
  onMoved: (center: Point) => void;
  onFailed: () => void;
  /** 지도 빈 곳을 눌렀다(핀을 누른 것은 제외) */
  onMapTap?: () => void;
  /** 지도를 둘러싼 배치 이름 — 바뀌면(크기가 바뀜) 이용자가 옮기지 않은 경우 한 번 다시 맞춘다 */
  layoutKey?: string;
  /** 지도 위쪽에서 페이지 컨트롤(칩·토글)이 가리는 높이(px) — 그 자리의 핀은 점으로 줄인다 */
  topInset?: number;
}

const MAX_PINS = 30;
/** 처음 화면에 들어오게 맞출 가까운 충전소 수 */
const FIT_COUNT = 5;
/** 지도 가장자리 여백(위·오른쪽·아래·왼쪽) — 핀이 잘리지 않게 */
const PAD = [44, 40, 60, 40] as const;
/** 범위 맞춤 때 시트 여백을 더해도 핀이 들어갈 세로 공간은 이만큼 남긴다(px) */
const MIN_FIT_SPACE = 120;
/** 핀을 누른 직후에 오는 지도 click은 무시한다(ms) */
const PIN_TAP_GUARD_MS = 400;
/** 글자 핀의 아래 끝이 좌표보다 위에 뜨는 높이(px) — CSS --pin-lift와 같다 */
const PIN_LIFT_PX = 4;
/** 강조한 핀의 확대 비율 — CSS .nearby-pin--focus의 scale과 같다 */
const FOCUS_SCALE = 1.15;

/** 겹침 순서: 강조 > 글자 핀(빈 곳 > 충전 중 > 이용 불가) > 점(같은 순). 내 위치 점은 0 */
function pinZ(state: NearbyStation["state"], pill: boolean, focused: boolean) {
  if (focused) return 10;
  const rank = state === "available" ? 3 : state === "full" ? 2 : 1;
  return pill ? 3 + rank : rank;
}

const SVG_NS = "http://www.w3.org/2000/svg";

/** 초급속 번개 — 글자색(currentColor)을 따른다 */
function boltIcon() {
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("class", "nearby-pin__bolt");
  svg.setAttribute("viewBox", "0 0 12 16");
  svg.setAttribute("width", "12");
  svg.setAttribute("height", "16");
  svg.setAttribute("aria-hidden", "true");
  svg.setAttribute("focusable", "false");
  const path = document.createElementNS(SVG_NS, "path");
  path.setAttribute("d", "M7.2 0 0 9.2h4.6L3.8 16 12 6.2H7.1L7.2 0Z");
  path.setAttribute("fill", "currentColor");
  svg.appendChild(path);
  return svg;
}

/** DB에서 온 이름이 HTML로 해석되지 않도록 DOM으로 만든다 */
function pinElement(
  s: NearbyStation,
  opts: { focused: boolean; mode: PinMode; dot: boolean },
  onClick: () => void,
) {
  const el = document.createElement("div");
  el.className =
    `nearby-pin nearby-pin--${s.state}` +
    (opts.focused ? " nearby-pin--focus" : "") +
    (opts.dot ? " nearby-pin--dot" : "");
  const ultra = isUltraFast(s);
  if (ultra) el.appendChild(boltIcon());
  const text = document.createElement("span");
  text.className = "nearby-pin__text";
  text.textContent = pinLabel(s, opts.mode);
  el.appendChild(text);
  el.setAttribute("role", "button");
  // 글자 모드와 상관없이 빈 대수 기준으로 읽는다
  el.setAttribute(
    "aria-label",
    `${s.name} ${pinText(s)}${ultra ? " 초급속" : ""}`,
  );
  el.tabIndex = 0;
  el.addEventListener("click", onClick);
  el.addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      onClick();
    }
  });
  return el;
}

export function NearbyMap({
  center,
  me,
  stations,
  focusId,
  mode,
  bottomInset,
  onSelect,
  onMoved,
  onFailed,
  onMapTap,
  layoutKey = "",
  topInset = 0,
}: NearbyMapProps) {
  const box = useRef<HTMLDivElement>(null);
  /* eslint-disable @typescript-eslint/no-explicit-any */
  const map = useRef<any>(null);
  const pins = useRef<Map<number, any>>(new Map());
  const meOverlay = useRef<any>(null);
  /* eslint-enable @typescript-eslint/no-explicit-any */
  /** 핀 본체(.nearby-pin) — 오버레이 content는 좌표에 놓인 0×0 기준점이고 그 안에 든다 */
  const pinEls = useRef<Map<number, HTMLElement>>(new Map());
  /** 글자 핀 크기 캐시(상태·번개·글자별) — 점으로 보이는 중에도 글자 핀일 때의 크기로 겹침을 잰다 */
  const pillSizes = useRef<Map<string, { w: number; h: number }>>(new Map());
  const measureBox = useRef<HTMLDivElement | null>(null);
  /** 마지막으로 적용한 글자/점 구성 — 같으면 DOM을 건드리지 않는다 */
  const lastDotsKey = useRef("");
  const [ready, setReady] = useState(false);
  const [failed, setFailed] = useState(false);

  /** 이용자가 지도를 끌거나 확대·축소했다 — 그 뒤로는 화면을 맞추지 않는다 */
  const userMoved = useRef(false);
  /** 이 center 값으로 아직 화면을 맞추지 않았다(맞춤은 center마다 한 번) */
  const needsFit = useRef(true);
  /** 코드가 바꾼 확대 수준(setBounds)은 이용자 조작으로 치지 않는다 */
  const programmatic = useRef(false);
  const failedCalled = useRef(false);
  /** 지금 핀을 점으로 줄여 보이는 중(축소 레벨) — 이용자 조작 판정과 별개 */
  const dot = useRef(false);
  /** 마지막 범위 맞춤에 쓴 시트 높이 */
  const fittedInset = useRef(0);
  /** 마지막 범위 맞춤 시각(performance.now) */
  const fittedAt = useRef(0);
  /** 맞춘 뒤 시트 높이 다시 맞춤의 기회를 썼다(맞춤마다 한 번) */
  const insetRefitDone = useRef(false);
  /** 마지막으로 핀을 누른 시각 — 그 직후의 지도 click은 빈 곳 누르기가 아니다 */
  const pinTapAt = useRef(0);

  // 콜백·최신 값은 ref로 들고 있어 효과가 다시 돌지 않게 한다
  const selectRef = useRef(onSelect);
  selectRef.current = onSelect;
  const movedRef = useRef(onMoved);
  movedRef.current = onMoved;
  const failedRef = useRef(onFailed);
  failedRef.current = onFailed;
  const mapTapRef = useRef(onMapTap);
  mapTapRef.current = onMapTap;
  const centerRef = useRef(center);
  centerRef.current = center;
  const stationsRef = useRef(stations);
  stationsRef.current = stations;
  const focusRef = useRef(focusId);
  focusRef.current = focusId;
  const modeRef = useRef(mode);
  modeRef.current = mode;
  const insetRef = useRef(bottomInset);
  insetRef.current = bottomInset;
  const topInsetRef = useRef(topInset);
  topInsetRef.current = topInset;

  /** 글자 핀일 때의 크기(px). 화면 밖 상자에 한 번 그려 재고 캐시한다 */
  const pillSize = useCallback((s: NearbyStation, m: PinMode) => {
    const label = pinLabel(s, m);
    const key = `${s.state}|${isUltraFast(s) ? 1 : 0}|${label}`;
    const hit = pillSizes.current.get(key);
    if (hit) return hit;
    if (!measureBox.current) {
      const mb = document.createElement("div");
      mb.setAttribute("aria-hidden", "true");
      mb.style.cssText =
        "position:absolute;left:-10000px;top:0;visibility:hidden;pointer-events:none";
      document.body.appendChild(mb);
      measureBox.current = mb;
    }
    const el = pinElement(s, { focused: false, mode: m, dot: false }, () => {});
    measureBox.current.appendChild(el);
    const size = { w: el.offsetWidth, h: el.offsetHeight };
    el.remove();
    if (size.w > 0) pillSizes.current.set(key, size);
    return size;
  }, []);

  /**
   * 핀마다 글자로 둘지 점으로 줄일지 정해 적용한다(지도를 옮기거나 맞추지 않는다).
   * 축소 레벨이면 모두 점, 아니면 화면 위치로 겹침을 재서 declutterPins로 고른다.
   */
  const applyDots = useCallback(() => {
    const m = map.current;
    const kakao = window.kakao;
    if (!m || !kakao || pins.current.size === 0) return;
    const list = stationsRef.current
      .slice(0, MAX_PINS)
      .filter((s) => pins.current.has(s.id));
    const focus = focusRef.current;
    let pills: Set<number>;
    if (dot.current) {
      pills = new Set();
    } else {
      const proj = m.getProjection();
      const items = list.map((s, i) => {
        const p = proj.containerPointFromCoords(
          new kakao.maps.LatLng(+s.latitude, +s.longitude),
        );
        const focused = s.id === focus;
        const size = pillSize(s, modeRef.current);
        const scale = focused ? FOCUS_SCALE : 1;
        const w = size.w * scale;
        const h = size.h * scale;
        // 글자 핀은 가운데 아래가 좌표 위 PIN_LIFT_PX에 놓이고, 강조는 아래 가운데 기준으로 커진다
        const bottom = p.y - PIN_LIFT_PX;
        return {
          id: s.id,
          rect: { left: p.x - w / 2, right: p.x + w / 2, top: bottom - h, bottom },
          priority: pinPriority(s.state, i),
          focused,
        };
      });
      const top = topInsetRef.current;
      pills = declutterPins(
        items,
        top > 0
          ? [{ left: -Infinity, top: -Infinity, right: Infinity, bottom: top }]
          : [],
      );
    }
    const key = `${dot.current ? "z" : ""}|${focus}|${[...pills]
      .sort((a, b) => a - b)
      .join(",")}`;
    if (key === lastDotsKey.current) return;
    lastDotsKey.current = key;
    list.forEach((s) => {
      const el = pinEls.current.get(s.id);
      const o = pins.current.get(s.id);
      if (!el || !o) return;
      const pill = pills.has(s.id);
      el.classList.toggle("nearby-pin--dot", !pill);
      o.setZIndex(pinZ(s.state, pill, s.id === focus));
    });
  }, [pillSize]);

  // 같은 구성이면 다시 그리지 않는다(1분마다 새로 받아도 깜박이지 않게)
  const signature = stations
    .slice(0, MAX_PINS)
    .map(
      (s) =>
        `${s.id}:${s.state}:${s.available}:${s.power_kw}:${s.latitude}:${s.longitude}`,
    )
    .join("|");

  // 지도 만들기 (마운트 시 한 번)
  useEffect(() => {
    let cancelled = false;
    let removeListeners: (() => void) | null = null;
    const pinMap = pins.current;
    const elMap = pinEls.current;

    loadKakaoMaps().then((kakao) => {
      if (cancelled || !box.current) return;
      if (!kakao) {
        if (!failedCalled.current) {
          failedCalled.current = true;
          failedRef.current();
        }
        setFailed(true);
        return;
      }
      const { maps } = kakao;
      const m = new maps.Map(box.current, {
        center: new maps.LatLng(centerRef.current.lat, centerRef.current.lng),
        level: 5,
      });
      // 코드가 옮기는 경우(setCenter·setBounds·panTo)에는 dragend가 오지 않는다
      const onDragEnd = () => {
        userMoved.current = true;
        const c = m.getCenter();
        movedRef.current({ lat: c.getLat(), lng: c.getLng() });
      };
      // 확대·축소는 화면 맞춤만 멈춘다("이 위치에서 찾기"는 끌었을 때만).
      // 점 표시 전환은 누가 바꿨든 레벨만 보고 정한다
      const onZoom = () => {
        if (!programmatic.current) userMoved.current = true;
        const next = isDotLevel(m.getLevel());
        if (next === dot.current) return;
        dot.current = next;
        applyDots();
      };
      // 끌기·확대가 끝나 멈추면 겹침을 다시 잰다(멈출 때마다 한 번, 바뀐 것이 없으면 그대로)
      const onIdle = () => applyDots();
      // 지도 빈 곳 누르기. 핀은 clickable 오버레이라 보통 여기까지 오지 않지만,
      // 혹시 오더라도 핀을 누른 직후면 무시한다
      const onClick = () => {
        if (Date.now() - pinTapAt.current < PIN_TAP_GUARD_MS) return;
        mapTapRef.current?.();
      };
      maps.event.addListener(m, "dragend", onDragEnd);
      maps.event.addListener(m, "zoom_changed", onZoom);
      maps.event.addListener(m, "click", onClick);
      maps.event.addListener(m, "idle", onIdle);
      // 화면 크기가 바뀌면(주소창·회전) 지도가 새 크기를 알게 한다
      const ro =
        typeof ResizeObserver === "undefined"
          ? null
          : new ResizeObserver(() => m.relayout());
      ro?.observe(box.current);
      removeListeners = () => {
        maps.event.removeListener(m, "dragend", onDragEnd);
        maps.event.removeListener(m, "zoom_changed", onZoom);
        maps.event.removeListener(m, "click", onClick);
        maps.event.removeListener(m, "idle", onIdle);
        ro?.disconnect();
      };
      dot.current = isDotLevel(m.getLevel());
      map.current = m;
      setReady(true);
    });

    return () => {
      cancelled = true;
      removeListeners?.();
      pinMap.forEach((o) => o.setMap(null));
      pinMap.clear();
      elMap.clear();
      meOverlay.current?.setMap(null);
      meOverlay.current = null;
      measureBox.current?.remove();
      measureBox.current = null;
      map.current = null;
    };
  }, [applyDots]);

  /** 기준점과 가까운 충전소들이 접힌 시트 위 화면에 들어오게 맞춘다(ref만 읽는다) */
  const fitToNearest = useCallback(() => {
    const kakao = window.kakao;
    if (!map.current || !kakao) return;
    const { maps } = kakao;
    const shown = stationsRef.current.slice(0, MAX_PINS);
    if (shown.length === 0) return;
    const c = centerRef.current;
    const bounds = new maps.LatLngBounds();
    bounds.extend(new maps.LatLng(c.lat, c.lng));
    shown
      .map((s) => ({
        s,
        d: (+s.latitude - c.lat) ** 2 + (+s.longitude - c.lng) ** 2,
      }))
      .sort((a, b) => a.d - b.d)
      .slice(0, FIT_COUNT)
      .forEach(({ s }) =>
        bounds.extend(new maps.LatLng(+s.latitude, +s.longitude)),
      );
    const inset = Math.max(0, insetRef.current);
    fittedInset.current = inset;
    fittedAt.current = performance.now();
    // 배치가 막 바뀌었으면 ResizeObserver보다 먼저 올 수 있다 — 지금 크기를 알게 한다
    map.current.relayout();
    // zoom_changed가 호출 중에 바로 오든 조금 뒤에 오든 이 맞춤은 이용자 조작으로 치지 않는다
    programmatic.current = true;
    try {
      // 아래 여백은 그 순간 지도를 가리는 시트 높이만큼 더 둔다.
      // 지도가 낮으면 핀이 들어갈 자리(MIN_FIT_SPACE)는 남긴다
      const h = box.current?.clientHeight ?? 0;
      const bottom = Math.min(
        PAD[2] + inset,
        Math.max(PAD[2], h - PAD[0] - MIN_FIT_SPACE),
      );
      map.current.setBounds(bounds, PAD[0], PAD[1], bottom, PAD[3]);
    } finally {
      setTimeout(() => {
        programmatic.current = false;
      }, 0);
    }
  }, []);

  // center 값이 바뀌면 그 위치로 옮기고 '이용자가 옮김' 표시를 풀어 한 번 다시 맞추게 한다
  useEffect(() => {
    const kakao = window.kakao;
    if (!ready || !map.current || !kakao) return;
    userMoved.current = false;
    needsFit.current = true;
    map.current.setCenter(
      new kakao.maps.LatLng(centerRef.current.lat, centerRef.current.lng),
    );
  }, [ready, center.lat, center.lng]);

  // 핀 그리기. 화면 맞춤은 center마다 첫 결과에서 한 번만 하고,
  // 이용자가 지도를 끌거나 확대·축소한 뒤에는 하지 않는다(새로 받을 때 시트로 옮긴 화면이 튀지 않게)
  useEffect(() => {
    const kakao = window.kakao;
    if (!ready || !map.current || !kakao) return;
    const { maps } = kakao;

    pins.current.forEach((o) => o.setMap(null));
    pins.current.clear();
    pinEls.current.clear();

    const shown = stations.slice(0, MAX_PINS);
    shown.forEach((s) => {
      const focused = s.id === focusRef.current;
      const el = pinElement(
        s,
        { focused, mode: modeRef.current, dot: dot.current },
        () => {
          pinTapAt.current = Date.now();
          selectRef.current(s.id);
        },
      );
      // 오버레이 content는 좌표에 놓인 0×0 기준점이다. 글자 핀·점의 자리는 CSS가
      // 이 점을 기준으로 정한다(카카오가 content 크기로 anchor를 계산하지 않게)
      const anchor = document.createElement("div");
      anchor.className = "nearby-pin-anchor";
      anchor.appendChild(el);
      const o = new maps.CustomOverlay({
        position: new maps.LatLng(+s.latitude, +s.longitude),
        content: anchor,
        xAnchor: 0,
        yAnchor: 0,
        zIndex: pinZ(s.state, !dot.current, focused),
        // 핀을 눌러도 지도 click(빈 곳 누르기)이 일어나지 않게
        clickable: true,
      });
      o.setMap(map.current);
      pins.current.set(s.id, o);
      pinEls.current.set(s.id, el);
    });
    // 새로 그린 핀에 겹침 정리를 적용한다(범위를 맞추면 idle에서 한 번 더)
    lastDotsKey.current = "";
    applyDots();

    if (!needsFit.current || userMoved.current || shown.length === 0) return;
    needsFit.current = false;
    insetRefitDone.current = false;
    fitToNearest();
    // signature가 stations의 구성을 대표한다
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, signature]);

  // 배치(지도 시트 ↔ 쌓인 배치)가 바뀌면 지도 크기가 달라진다. 이용자가 지도를 건드리지
  // 않았으면 새 크기로 한 번 맞춘다. 이 맞춤이 시트 높이 변화(0 ↔ 접힌 높이)까지 함께 처리하므로
  // 아래 시트 높이 다시 맞춤의 기회는 쓴 것으로 친다(아래 효과보다 먼저 선언)
  const prevLayoutKey = useRef(layoutKey);
  useEffect(() => {
    if (prevLayoutKey.current === layoutKey) return;
    prevLayoutKey.current = layoutKey;
    if (!ready || needsFit.current) return;
    insetRefitDone.current = true;
    if (userMoved.current) return;
    const frame = requestAnimationFrame(() => {
      if (userMoved.current || needsFit.current) return;
      fitToNearest();
    });
    return () => cancelAnimationFrame(frame);
  }, [ready, layoutKey, fitToNearest]);

  // 첫 맞춤 때 시트는 아직 "찾고 있어요" 한 줄이라 낮다. 맞춘 직후 접힌 시트가 실제 높이로
  // 바뀌면(이용자가 지도를 건드리기 전에 한해) 한 번만 다시 맞춘다. 기회는 맞춤마다 한 번이고,
  // 맞춘 뒤 처음 오는 높이 변화가 다시 맞추든 아니든 그 기회를 쓴다 — 한참 뒤의 변화(60초 갱신,
  // 시트를 접을 때 다시 잰 높이 등)로 보고 있는 지도가 움직이지 않게. 한 프레임 모아서 맞춘다.
  // 시트를 펼쳐도 bottomInset(접힌 높이)은 그대로라 여기서 다시 맞추지 않는다
  useEffect(() => {
    if (!ready || insetRefitDone.current || needsFit.current) return;
    if (bottomInset === fittedInset.current) return;
    const refit = shouldRefitForInset({
      userMoved: userMoved.current,
      hasFitted: true,
      refitSpent: false,
      msSinceFit: performance.now() - fittedAt.current,
      prevInset: fittedInset.current,
      nextInset: bottomInset,
    });
    insetRefitDone.current = true;
    if (!refit) return;
    let fired = false;
    const frame = requestAnimationFrame(() => {
      fired = true;
      if (userMoved.current || needsFit.current) return;
      fitToNearest();
    });
    return () => {
      cancelAnimationFrame(frame);
      // 같은 프레임에 높이가 또 바뀌었다 — 마지막 값으로 다시 판단하게 기회를 돌려준다
      if (!fired) insetRefitDone.current = false;
    };
  }, [ready, bottomInset, fitToNearest]);

  // 글자 모드가 바뀌면 핀 글자만 바꾼다(다시 그리거나 지도를 옮기지 않는다).
  // 글자 폭이 달라지므로 겹침은 다시 잰다
  useEffect(() => {
    if (!ready) return;
    pinEls.current.forEach((el, id) => {
      const s = stationsRef.current.find((x) => x.id === id);
      const text = el.querySelector(".nearby-pin__text");
      if (s && text) text.textContent = pinLabel(s, mode);
    });
    applyDots();
  }, [ready, mode, applyDots]);

  // 지도 위 컨트롤이 가리는 높이가 바뀌면 겹침을 다시 잰다
  useEffect(() => {
    if (ready) applyDots();
  }, [ready, topInset, applyDots]);

  // 내 위치 점
  useEffect(() => {
    const kakao = window.kakao;
    if (!ready || !map.current || !kakao) return;
    meOverlay.current?.setMap(null);
    meOverlay.current = null;
    if (!me) return;
    const el = document.createElement("div");
    el.className = "nearby-me";
    el.setAttribute("aria-hidden", "true");
    const o = new kakao.maps.CustomOverlay({
      position: new kakao.maps.LatLng(me.lat, me.lng),
      content: el,
      xAnchor: 0.5,
      yAnchor: 0.5,
      zIndex: 0,
    });
    o.setMap(map.current);
    meOverlay.current = o;
    // 좌표 값으로 비교한다(같은 값의 새 객체에는 다시 그리지 않는다)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, me?.lat, me?.lng]);

  // 강조 표시(핀을 다시 그린 뒤에도 유지). 강조한 핀은 늘 글자·맨 위 — 겹침을 다시 정한다
  useEffect(() => {
    if (!ready) return;
    pinEls.current.forEach((el, id) => {
      el.classList.toggle("nearby-pin--focus", id === focusId);
    });
    applyDots();
  }, [ready, focusId, signature, applyDots]);

  // 강조한 충전소로 지도를 옮긴다(강조가 바뀔 때만)
  useEffect(() => {
    const kakao = window.kakao;
    if (!ready || !map.current || !kakao || focusId == null) return;
    const s = stationsRef.current.find((x) => x.id === focusId);
    if (s) map.current.panTo(new kakao.maps.LatLng(+s.latitude, +s.longitude));
  }, [ready, focusId]);

  if (failed) return null;
  return (
    <div className="nearby-map-card">
      {!ready && (
        <p className="nearby-map-loading" role="status">
          지도를 불러오는 중이에요
        </p>
      )}
      <div
        ref={box}
        className="nearby-map"
        role="region"
        aria-label="주변 급속충전소 지도"
      />
    </div>
  );
}
