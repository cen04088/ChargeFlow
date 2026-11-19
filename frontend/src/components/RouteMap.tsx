import { useCallback, useEffect, useRef, useState } from "react";

import { loadKakaoMaps } from "../lib/kakao";
import type { PinKind } from "../lib/highway";
import {
  INSET_REFIT_WINDOW_MS,
  declutterPins,
  shouldRefitForInset,
} from "../lib/nearby";

interface Point {
  lat: number;
  lng: number;
}

export interface RoutePin {
  id: number;
  lat: number;
  lng: number;
  text: string;
  kind: PinKind;
  /** false면 상태를 모른다 — 상태색 대신 중립색 */
  known?: boolean;
  ariaLabel: string;
  /** 겹칠 때 글자로 남길 순서(작을수록 먼저) */
  priority: number;
  /** 늘 글자로, 강조 테두리 */
  emphasized?: boolean;
}

/** 누를 수 없는 이름표(IC) */
export interface RouteLabel {
  lat: number;
  lng: number;
  text: string;
}

interface RouteMapProps {
  /** 노선 선(순서대로). 비어 있으면 선 없음 */
  path: Point[];
  pins: RoutePin[];
  labels?: RouteLabel[];
  me: Point | null;
  /** 처음 화면에 들어오게 할 점들 */
  fit: Point[];
  /** 값이 바뀌면 한 번 다시 맞춘다(이용자가 옮겼어도) */
  fitKey: string;
  /** 값이 바뀌면 이용자가 지도를 건드리지 않은 경우에만 한 번 다시 맞춘다(늦게 온 내 위치 등) */
  softFitKey?: string;
  focusId: number | null;
  /** 지도 위쪽·아래쪽을 가리는 높이(px) — 범위 맞춤 여백. 위쪽 자리의 핀은 점으로 줄인다 */
  topInset: number;
  bottomInset: number;
  onSelect: (id: number) => void;
  /** 지도 빈 곳을 눌렀다(핀을 누른 것은 제외) */
  onMapTap?: () => void;
  onFailed: () => void;
  /** 지도 영역 이름(화면낭독기) */
  label: string;
}

/** 지도 가장자리 여백(위·오른쪽·아래·왼쪽) — 글자 핀은 좌표 위로 서고(위 56), 폭의 반쯤 옆으로 퍼진다(36).
 *  아래는 점의 반지름만큼만(20) — 노선이 보이는 칸 가운데 크게 오게 */
const PAD = [56, 36, 20, 36] as const;
/** 맞춘 뒤 이 시간(ms) 안에 접힌 시트 높이가 바뀌면 한 번 다시 맞춘다 */
const ROUTE_INSET_WINDOW_MS = 4000;
/** 범위 맞춤 때 시트 여백을 더해도 핀이 들어갈 세로 공간은 이만큼 남긴다(px) */
const MIN_FIT_SPACE = 120;
/** 핀을 누른 직후에 오는 지도 click은 무시한다(ms) */
const PIN_TAP_GUARD_MS = 400;
/** 글자 핀의 아래 끝이 좌표보다 위에 뜨는 높이(px) — CSS --pin-lift와 같다 */
const PIN_LIFT_PX = 4;
/** 강조한 핀의 확대 비율 — CSS .nearby-pin--focus의 scale과 같다 */
const FOCUS_SCALE = 1.15;
/** 점이 하나뿐이면 이만큼(도) 둘레를 넣어 맞춘다(너무 확대되지 않게) */
const SINGLE_POINT_SPAN = 0.02;
/** 노선 선: 흰 테두리 위에 브랜드 파랑 */
const LINE_OUTER_PX = 8;
const LINE_INNER_PX = 4;

/** 겹침 순서: 강조 > 글자 핀(빈 곳 > 충전 중 > 이용 불가) > 점. 내 위치 점은 0, 이름표는 1 */
function pinZ(kind: PinKind, pill: boolean, top: boolean) {
  if (top) return 20;
  const rank = kind === "available" ? 3 : kind === "full" ? 2 : 1;
  return pill ? 5 + rank : 1 + rank;
}

function brandColor() {
  const v = getComputedStyle(document.documentElement)
    .getPropertyValue("--brand-primary")
    .trim();
  return v || "#2463d7";
}

/** DB에서 온 이름이 HTML로 해석되지 않도록 DOM으로 만든다 */
function pinElement(p: RoutePin, focused: boolean, onClick: () => void) {
  const el = document.createElement("div");
  el.className =
    `nearby-pin nearby-pin--${p.kind}` +
    (p.known === false ? " nearby-pin--neutral" : "") +
    (p.emphasized ? " route-pin--emph" : "") +
    (focused ? " nearby-pin--focus" : "");
  const text = document.createElement("span");
  text.className = "nearby-pin__text";
  text.textContent = p.text;
  el.appendChild(text);
  el.setAttribute("role", "button");
  el.setAttribute("aria-label", p.ariaLabel);
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

/**
 * 고속도로·휴게소 지도: 노선 선 + 글자 핀 + 이름표. NearbyMap과 같은 방식이다 —
 * 지도는 한 번만 만들고, 범위 맞춤은 fitKey마다 한 번(+ 맞춘 직후 시트 높이가 바뀌면 한 번 더),
 * 이용자가 끌거나 확대한 뒤에는 다시 맞추지 않는다. 겹치는 핀은 점으로(강조·선택은 늘 글자).
 */
export function RouteMap({
  path,
  pins,
  labels = [],
  me,
  fit,
  fitKey,
  softFitKey = "",
  focusId,
  topInset,
  bottomInset,
  onSelect,
  onMapTap,
  onFailed,
  label,
}: RouteMapProps) {
  const box = useRef<HTMLDivElement>(null);
  /* eslint-disable @typescript-eslint/no-explicit-any */
  const map = useRef<any>(null);
  const pinOverlays = useRef<Map<number, any>>(new Map());
  /* eslint-enable @typescript-eslint/no-explicit-any */
  const pinEls = useRef<Map<number, HTMLElement>>(new Map());
  const pillSizes = useRef<Map<string, { w: number; h: number }>>(new Map());
  const measureBox = useRef<HTMLDivElement | null>(null);
  const lastDotsKey = useRef("");
  const [ready, setReady] = useState(false);
  const [failed, setFailed] = useState(false);

  const userMoved = useRef(false);
  const needsFit = useRef(true);
  const programmatic = useRef(false);
  const failedCalled = useRef(false);
  const fittedInset = useRef(0);
  const fittedAt = useRef(0);
  const insetRefitDone = useRef(false);
  const pinTapAt = useRef(0);

  const selectRef = useRef(onSelect);
  selectRef.current = onSelect;
  const failedRef = useRef(onFailed);
  failedRef.current = onFailed;
  const mapTapRef = useRef(onMapTap);
  mapTapRef.current = onMapTap;
  const pinsRef = useRef(pins);
  pinsRef.current = pins;
  const fitRef = useRef(fit);
  fitRef.current = fit;
  const focusRef = useRef(focusId);
  focusRef.current = focusId;
  const insetRef = useRef(bottomInset);
  insetRef.current = bottomInset;
  const topInsetRef = useRef(topInset);
  topInsetRef.current = topInset;

  /** 글자 핀일 때의 크기(px). 화면 밖 상자에 한 번 그려 재고 캐시한다 */
  const pillSize = useCallback((p: RoutePin) => {
    const key = `${p.kind}|${p.known === false ? 0 : 1}|${p.emphasized ? 1 : 0}|${p.text}`;
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
    const el = pinElement(p, false, () => {});
    measureBox.current.appendChild(el);
    const size = { w: el.offsetWidth, h: el.offsetHeight };
    el.remove();
    if (size.w > 0) pillSizes.current.set(key, size);
    return size;
  }, []);

  /** 핀마다 글자로 둘지 점으로 줄일지 정해 적용한다(지도를 옮기지 않는다) */
  const applyDots = useCallback(() => {
    const m = map.current;
    const kakao = window.kakao;
    if (!m || !kakao || pinOverlays.current.size === 0) return;
    const list = pinsRef.current.filter((p) => pinOverlays.current.has(p.id));
    const focus = focusRef.current;
    const proj = m.getProjection();
    const items = list.map((p) => {
      const pt = proj.containerPointFromCoords(new kakao.maps.LatLng(p.lat, p.lng));
      const focused = p.id === focus;
      const size = pillSize(p);
      const scale = focused ? FOCUS_SCALE : 1;
      const w = size.w * scale;
      const h = size.h * scale;
      const bottom = pt.y - PIN_LIFT_PX;
      return {
        id: p.id,
        rect: { left: pt.x - w / 2, right: pt.x + w / 2, top: bottom - h, bottom },
        priority: p.priority,
        focused: focused || !!p.emphasized,
      };
    });
    const top = topInsetRef.current;
    const pills = declutterPins(
      items,
      top > 0 ? [{ left: -Infinity, top: -Infinity, right: Infinity, bottom: top }] : [],
    );
    const key = `${focus}|${[...pills].sort((a, b) => a - b).join(",")}`;
    if (key === lastDotsKey.current) return;
    lastDotsKey.current = key;
    list.forEach((p) => {
      const el = pinEls.current.get(p.id);
      const o = pinOverlays.current.get(p.id);
      if (!el || !o) return;
      const pill = pills.has(p.id);
      el.classList.toggle("nearby-pin--dot", !pill);
      o.setZIndex(pinZ(p.kind, pill, p.id === focus || !!p.emphasized));
    });
  }, [pillSize]);

  // 지도 만들기 (마운트 시 한 번)
  useEffect(() => {
    let cancelled = false;
    let removeListeners: (() => void) | null = null;
    const overlayMap = pinOverlays.current;
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
      const c = fitRef.current[0] ?? { lat: 36.5, lng: 127.8 };
      const m = new maps.Map(box.current, {
        center: new maps.LatLng(c.lat, c.lng),
        level: 9,
      });
      const onDragEnd = () => {
        userMoved.current = true;
      };
      const onZoom = () => {
        if (!programmatic.current) userMoved.current = true;
      };
      const onIdle = () => applyDots();
      const onClick = () => {
        if (Date.now() - pinTapAt.current < PIN_TAP_GUARD_MS) return;
        mapTapRef.current?.();
      };
      maps.event.addListener(m, "dragend", onDragEnd);
      maps.event.addListener(m, "zoom_changed", onZoom);
      maps.event.addListener(m, "click", onClick);
      maps.event.addListener(m, "idle", onIdle);
      const ro =
        typeof ResizeObserver === "undefined" ? null : new ResizeObserver(() => m.relayout());
      ro?.observe(box.current);
      removeListeners = () => {
        maps.event.removeListener(m, "dragend", onDragEnd);
        maps.event.removeListener(m, "zoom_changed", onZoom);
        maps.event.removeListener(m, "click", onClick);
        maps.event.removeListener(m, "idle", onIdle);
        ro?.disconnect();
      };
      map.current = m;
      setReady(true);
    });

    return () => {
      cancelled = true;
      removeListeners?.();
      overlayMap.forEach((o) => o.setMap(null));
      overlayMap.clear();
      elMap.clear();
      measureBox.current?.remove();
      measureBox.current = null;
      map.current = null;
    };
  }, [applyDots]);

  /** fit 점들이 시트 위·버튼 줄 아래 화면에 들어오게 맞춘다(ref만 읽는다) */
  const fitNow = useCallback(() => {
    const kakao = window.kakao;
    const pts = fitRef.current;
    if (!map.current || !kakao || pts.length === 0) return false;
    const { maps } = kakao;
    const bounds = new maps.LatLngBounds();
    pts.forEach((p) => bounds.extend(new maps.LatLng(p.lat, p.lng)));
    if (pts.length === 1) {
      const p = pts[0];
      bounds.extend(new maps.LatLng(p.lat + SINGLE_POINT_SPAN, p.lng + SINGLE_POINT_SPAN));
      bounds.extend(new maps.LatLng(p.lat - SINGLE_POINT_SPAN, p.lng - SINGLE_POINT_SPAN));
    }
    const inset = Math.max(0, insetRef.current);
    fittedInset.current = inset;
    fittedAt.current = performance.now();
    map.current.relayout();
    programmatic.current = true;
    try {
      const h = box.current?.clientHeight ?? 0;
      const top = PAD[0] + Math.max(0, topInsetRef.current);
      const bottom = Math.min(PAD[2] + inset, Math.max(PAD[2], h - top - MIN_FIT_SPACE));
      map.current.setBounds(bounds, top, PAD[1], bottom, PAD[3]);
    } finally {
      setTimeout(() => {
        programmatic.current = false;
      }, 0);
    }
    return true;
  }, []);

  // fitKey가 바뀌면 이용자 조작 표시를 풀고 한 번 다시 맞춘다
  useEffect(() => {
    userMoved.current = false;
    needsFit.current = true;
  }, [fitKey]);

  // 늦게 온 정보(내 위치 등)로 맞출 점이 바뀌면, 이용자가 지도를 건드리지 않았을 때만 한 번 다시 맞춘다
  const prevSoft = useRef(softFitKey);
  useEffect(() => {
    if (prevSoft.current === softFitKey) return;
    prevSoft.current = softFitKey;
    if (!userMoved.current) needsFit.current = true;
  }, [softFitKey]);

  // 맞출 점이 준비되면(그리고 맞춤이 필요하면) 맞춘다. 맞춤 뒤 시트 높이 다시 맞춤의 기회를 새로 준다
  const fitSig = fit.map((p) => `${p.lat},${p.lng}`).join("|");
  useEffect(() => {
    if (!ready || !needsFit.current || userMoved.current) return;
    if (!fitNow()) return;
    needsFit.current = false;
    insetRefitDone.current = false;
  }, [ready, fitKey, softFitKey, fitSig, fitNow]);

  // 맞춘 직후 접힌 시트가 실제 높이로 바뀌면 한 번만 다시 맞춘다(NearbyMap과 같은 규칙에 기다리는 시간만 더 길게).
  // 노선 화면은 처음 맞출 때 시트가 아직 "불러오고 있어요" 한 줄이고, 실제 높이는 2~3초 뒤에야 오기도 했다
  // (실제 지도 확인: 노선이 시트 높이를 덜 뺀 채 맞춰져 아래로 치우쳤다). 이용자가 지도를 건드리지 않았을 때만
  useEffect(() => {
    if (!ready || insetRefitDone.current || needsFit.current) return;
    if (bottomInset === fittedInset.current) return;
    const msSinceFit = performance.now() - fittedAt.current;
    // 시간 창만 이 지도 기준(ROUTE_INSET_WINDOW_MS)으로 바꿔 같은 판정 함수를 쓴다
    const refit = shouldRefitForInset({
      userMoved: userMoved.current,
      hasFitted: fittedAt.current > 0,
      refitSpent: false,
      msSinceFit: msSinceFit * (INSET_REFIT_WINDOW_MS / ROUTE_INSET_WINDOW_MS),
      prevInset: fittedInset.current,
      nextInset: bottomInset,
    });
    if (!refit) {
      // 작은 중간 변화로 기회를 써 버리지 않는다 — 창이 지났거나 이용자가 옮겼을 때만 기회를 닫는다
      if (userMoved.current || msSinceFit >= ROUTE_INSET_WINDOW_MS) {
        insetRefitDone.current = true;
      }
      return;
    }
    insetRefitDone.current = true;
    let fired = false;
    const frame = requestAnimationFrame(() => {
      fired = true;
      if (userMoved.current || needsFit.current) return;
      fitNow();
    });
    return () => {
      cancelAnimationFrame(frame);
      if (!fired) insetRefitDone.current = false;
    };
  }, [ready, bottomInset, fitNow]);

  // 노선 선: 흰 테두리(아래) + 브랜드 파랑(위)
  const pathSig = path.map((p) => `${p.lat},${p.lng}`).join("|");
  useEffect(() => {
    const kakao = window.kakao;
    if (!ready || !map.current || !kakao || path.length < 2) return;
    const { maps } = kakao;
    const line = path.map((p) => new maps.LatLng(p.lat, p.lng));
    const outer = new maps.Polyline({
      path: line,
      strokeWeight: LINE_OUTER_PX,
      strokeColor: "#ffffff",
      strokeOpacity: 1,
      strokeStyle: "solid",
      zIndex: 0,
    });
    const inner = new maps.Polyline({
      path: line,
      strokeWeight: LINE_INNER_PX,
      strokeColor: brandColor(),
      strokeOpacity: 1,
      strokeStyle: "solid",
      zIndex: 1,
    });
    outer.setMap(map.current);
    inner.setMap(map.current);
    return () => {
      outer.setMap(null);
      inner.setMap(null);
    };
    // pathSig가 path를 대표한다
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, pathSig]);

  // IC 이름표(누를 수 없다)
  const labelSig = labels.map((l) => `${l.lat},${l.lng},${l.text}`).join("|");
  useEffect(() => {
    const kakao = window.kakao;
    if (!ready || !map.current || !kakao) return;
    const { maps } = kakao;
    const created = labels.map((l) => {
      const anchor = document.createElement("div");
      anchor.className = "nearby-pin-anchor";
      const el = document.createElement("div");
      el.className = "route-label";
      el.textContent = l.text;
      anchor.appendChild(el);
      const o = new maps.CustomOverlay({
        position: new maps.LatLng(l.lat, l.lng),
        content: anchor,
        xAnchor: 0,
        yAnchor: 0,
        zIndex: 1,
      });
      o.setMap(map.current);
      return o;
    });
    return () => created.forEach((o) => o.setMap(null));
    // labelSig가 labels를 대표한다
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, labelSig]);

  // 핀 그리기 — 같은 구성이면 다시 그리지 않는다(1분마다 새로 받아도 깜박이지 않게)
  const pinSig = pins
    .map(
      (p) =>
        `${p.id}:${p.lat}:${p.lng}:${p.text}:${p.kind}:${p.known}:${p.emphasized}:${p.priority}:${p.ariaLabel}`,
    )
    .join("|");
  useEffect(() => {
    const kakao = window.kakao;
    if (!ready || !map.current || !kakao) return;
    const { maps } = kakao;
    pinOverlays.current.forEach((o) => o.setMap(null));
    pinOverlays.current.clear();
    pinEls.current.clear();
    pinsRef.current.forEach((p) => {
      const focused = p.id === focusRef.current;
      const el = pinElement(p, focused, () => {
        pinTapAt.current = Date.now();
        selectRef.current(p.id);
      });
      const anchor = document.createElement("div");
      anchor.className = "nearby-pin-anchor";
      anchor.appendChild(el);
      const o = new maps.CustomOverlay({
        position: new maps.LatLng(p.lat, p.lng),
        content: anchor,
        xAnchor: 0,
        yAnchor: 0,
        zIndex: pinZ(p.kind, true, focused || !!p.emphasized),
        clickable: true,
      });
      o.setMap(map.current);
      pinOverlays.current.set(p.id, o);
      pinEls.current.set(p.id, el);
    });
    lastDotsKey.current = "";
    applyDots();
  }, [ready, pinSig, applyDots]);

  // 위쪽 가림 높이가 바뀌면 겹침을 다시 잰다
  useEffect(() => {
    if (ready) applyDots();
  }, [ready, topInset, applyDots]);

  // 내 위치 점
  useEffect(() => {
    const kakao = window.kakao;
    if (!ready || !map.current || !kakao || !me) return;
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
    return () => o.setMap(null);
    // 좌표 값으로 비교한다
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, me?.lat, me?.lng]);

  // 선택 표시(핀을 다시 그린 뒤에도 유지) — 선택한 핀은 늘 글자·맨 위
  useEffect(() => {
    if (!ready) return;
    pinEls.current.forEach((el, id) => {
      el.classList.toggle("nearby-pin--focus", id === focusId);
    });
    lastDotsKey.current = "";
    applyDots();
  }, [ready, focusId, pinSig, applyDots]);

  // 선택한 핀으로 지도를 옮긴다(선택이 바뀔 때만)
  useEffect(() => {
    const kakao = window.kakao;
    if (!ready || !map.current || !kakao || focusId == null) return;
    const p = pinsRef.current.find((x) => x.id === focusId);
    if (p) map.current.panTo(new kakao.maps.LatLng(p.lat, p.lng));
  }, [ready, focusId]);

  if (failed) return null;
  return (
    <div className="nearby-map-card">
      {!ready && (
        <p className="nearby-map-loading" role="status">
          지도를 불러오는 중이에요
        </p>
      )}
      <div ref={box} className="nearby-map" role="region" aria-label={label} />
    </div>
  );
}
