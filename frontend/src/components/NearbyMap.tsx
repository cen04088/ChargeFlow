import { useEffect, useRef, useState } from "react";

import type { NearbyStation } from "../api/types";
import { loadKakaoMaps } from "../lib/kakao";
import { pinText } from "../lib/nearby";

interface Point {
  lat: number;
  lng: number;
}

interface NearbyMapProps {
  center: Point;
  me: Point | null;
  stations: NearbyStation[];
  focusId: number | null;
  onSelect: (id: number) => void;
  onMoved: (center: Point) => void;
  onFailed: () => void;
}

const MAX_PINS = 30;
/** 처음 화면에 들어오게 맞출 가까운 충전소 수 */
const FIT_COUNT = 5;
/** 지도 가장자리 여백(위·오른쪽·아래·왼쪽) — 핀이 잘리지 않게 */
const PAD = [44, 40, 60, 40] as const;

/** DB에서 온 이름이 HTML로 해석되지 않도록 DOM으로 만든다 */
function pinElement(s: NearbyStation, focused: boolean, onClick: () => void) {
  const el = document.createElement("div");
  el.className =
    "nearby-pin" +
    (s.state === "available" ? "" : " nearby-pin--off") +
    (focused ? " nearby-pin--focus" : "");
  el.textContent = pinText(s);
  el.setAttribute("role", "button");
  el.setAttribute("aria-label", `${s.name} ${pinText(s)}`);
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
  onSelect,
  onMoved,
  onFailed,
}: NearbyMapProps) {
  const box = useRef<HTMLDivElement>(null);
  /* eslint-disable @typescript-eslint/no-explicit-any */
  const map = useRef<any>(null);
  const pins = useRef<Map<number, any>>(new Map());
  const meOverlay = useRef<any>(null);
  /* eslint-enable @typescript-eslint/no-explicit-any */
  const [ready, setReady] = useState(false);
  const [failed, setFailed] = useState(false);

  /** 이용자가 지도를 끌거나 확대·축소했다 — 그 뒤로는 화면을 맞추지 않는다 */
  const userMoved = useRef(false);
  /** 이 center 값으로 아직 화면을 맞추지 않았다(맞춤은 center마다 한 번) */
  const needsFit = useRef(true);
  /** 코드가 바꾼 확대 수준(setBounds)은 이용자 조작으로 치지 않는다 */
  const programmatic = useRef(false);
  const failedCalled = useRef(false);

  // 콜백·최신 값은 ref로 들고 있어 효과가 다시 돌지 않게 한다
  const selectRef = useRef(onSelect);
  selectRef.current = onSelect;
  const movedRef = useRef(onMoved);
  movedRef.current = onMoved;
  const failedRef = useRef(onFailed);
  failedRef.current = onFailed;
  const centerRef = useRef(center);
  centerRef.current = center;
  const stationsRef = useRef(stations);
  stationsRef.current = stations;
  const focusRef = useRef(focusId);
  focusRef.current = focusId;

  // 같은 구성이면 다시 그리지 않는다(1분마다 새로 받아도 깜박이지 않게)
  const signature = stations
    .slice(0, MAX_PINS)
    .map(
      (s) => `${s.id}:${s.state}:${s.available}:${s.latitude}:${s.longitude}`,
    )
    .join("|");

  // 지도 만들기 (마운트 시 한 번)
  useEffect(() => {
    let cancelled = false;
    let removeListeners: (() => void) | null = null;
    const pinMap = pins.current;

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
      // 확대·축소는 화면 맞춤만 멈춘다("이 위치에서 찾기"는 끌었을 때만)
      const onZoom = () => {
        if (!programmatic.current) userMoved.current = true;
      };
      maps.event.addListener(m, "dragend", onDragEnd);
      maps.event.addListener(m, "zoom_changed", onZoom);
      removeListeners = () => {
        maps.event.removeListener(m, "dragend", onDragEnd);
        maps.event.removeListener(m, "zoom_changed", onZoom);
      };
      map.current = m;
      setReady(true);
    });

    return () => {
      cancelled = true;
      removeListeners?.();
      pinMap.forEach((o) => o.setMap(null));
      pinMap.clear();
      meOverlay.current?.setMap(null);
      meOverlay.current = null;
      map.current = null;
    };
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

    const shown = stations.slice(0, MAX_PINS);
    shown.forEach((s) => {
      const o = new maps.CustomOverlay({
        position: new maps.LatLng(+s.latitude, +s.longitude),
        content: pinElement(s, s.id === focusRef.current, () =>
          selectRef.current(s.id),
        ),
        yAnchor: 1.1,
        zIndex: s.id === focusRef.current ? 3 : 1,
      });
      o.setMap(map.current);
      pins.current.set(s.id, o);
    });

    if (!needsFit.current || userMoved.current || shown.length === 0) return;
    needsFit.current = false;
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
    // zoom_changed가 호출 중에 바로 오든 조금 뒤에 오든 이 맞춤은 이용자 조작으로 치지 않는다
    programmatic.current = true;
    try {
      map.current.setBounds(bounds, ...PAD);
    } finally {
      setTimeout(() => {
        programmatic.current = false;
      }, 0);
    }
    // signature가 stations의 구성을 대표한다
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, signature]);

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

  // 강조 표시(핀을 다시 그린 뒤에도 유지)
  useEffect(() => {
    if (!ready) return;
    pins.current.forEach((o, id) => {
      const on = id === focusId;
      (o.getContent() as HTMLElement).classList.toggle("nearby-pin--focus", on);
      o.setZIndex(on ? 3 : 1);
    });
  }, [ready, focusId, signature]);

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
