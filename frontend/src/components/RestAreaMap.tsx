import { useEffect, useRef, useState } from "react";

import type { BypassIC, BypassStation } from "../api/types";
import { loadKakaoMaps } from "../lib/kakao";
import { logClick } from "../lib/toss";

interface Point {
  lat: number;
  lng: number;
}

interface Props {
  restArea: Point & { name: string };
  ics: BypassIC[];
  stations: BypassStation[];
  focusId: number | null;
  onSelectStation: (id: number) => void;
}

/** 지도 카드 높이 전환(스프링) 시간 — index.css의 --spring-time과 맞춘다 */
const RESIZE_MS = 480;

/** DB에서 온 이름이 HTML로 해석되지 않도록 DOM으로 만든다 */
function label(
  text: string,
  kind: "ra" | "ic" | "station" | "focus",
  onClick?: () => void,
) {
  const el = document.createElement("div");
  el.className = `map-label map-label--${kind}`;
  el.textContent = text;
  if (onClick) {
    el.addEventListener("click", onClick);
    el.setAttribute("role", "button");
  }
  return el;
}

export function RestAreaMap({
  restArea,
  ics,
  stations,
  focusId,
  onSelectStation,
}: Props) {
  const box = useRef<HTMLDivElement>(null);
  /* eslint-disable @typescript-eslint/no-explicit-any */
  const map = useRef<any>(null);
  const overlays = useRef<Map<number, any>>(new Map());
  const boundsRef = useRef<any>(null);
  const [failed, setFailed] = useState(false);
  const [expanded, setExpanded] = useState(false);

  // 1분마다 새로 받아도 같은 충전소 구성이면 지도를 다시 그리지 않는다
  const signature = [
    restArea.lat,
    restArea.lng,
    ics.map((ic) => ic.id).join(","),
    stations.map((s) => s.id).join(","),
  ].join("|");
  const selectRef = useRef(onSelectStation);
  selectRef.current = onSelectStation;

  useEffect(() => {
    let cancelled = false;
    const created = new Map<number, any>();
    const others: any[] = [];

    loadKakaoMaps().then((kakao) => {
      if (cancelled || !box.current) return;
      if (!kakao) {
        setFailed(true);
        return;
      }
      const { maps } = kakao;
      if (!map.current) {
        map.current = new maps.Map(box.current, {
          center: new maps.LatLng(restArea.lat, restArea.lng),
          level: 8,
        });
      }
      const bounds = new maps.LatLngBounds();
      const add = (p: Point, content: HTMLElement) => {
        const pos = new maps.LatLng(p.lat, p.lng);
        bounds.extend(pos);
        const o = new maps.CustomOverlay({
          position: pos,
          content,
          yAnchor: 1.1,
        });
        o.setMap(map.current);
        return o;
      };

      others.push(add(restArea, label(restArea.name, "ra")));
      ics.forEach((ic) =>
        others.push(
          add({ lat: +ic.latitude, lng: +ic.longitude }, label(ic.name, "ic")),
        ),
      );
      stations.slice(0, 20).forEach((s) => {
        created.set(
          s.id,
          add(
            { lat: +s.latitude, lng: +s.longitude },
            label(`${s.drive_minutes}분`, "station", () =>
              selectRef.current(s.id),
            ),
          ),
        );
      });
      overlays.current = created;
      if (!bounds.isEmpty()) {
        map.current.setBounds(bounds, 48, 32, 56, 32);
        boundsRef.current = bounds;
      }
    });

    return () => {
      cancelled = true;
      created.forEach((o) => o.setMap(null));
      others.forEach((o) => o.setMap(null));
    };
    // signature가 restArea·ics·stations의 구성을 대표한다
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [signature]);

  useEffect(() => {
    const kakao = window.kakao;
    if (!kakao || !map.current || focusId == null) return;
    const s = stations.find((x) => x.id === focusId);
    if (!s) return;
    map.current.panTo(new kakao.maps.LatLng(+s.latitude, +s.longitude));
    overlays.current.forEach((o, id) => {
      const el = o.getContent() as HTMLElement;
      el.classList.toggle("map-label--focus", id === focusId);
    });
  }, [focusId, stations]);

  // 카드 높이가 바뀐 뒤 지도 크기를 다시 재고 모든 지점이 보이게 맞춘다
  useEffect(() => {
    if (!map.current) return;
    const t = setTimeout(() => {
      map.current?.relayout();
      if (boundsRef.current)
        map.current?.setBounds(boundsRef.current, 48, 32, 56, 32);
    }, RESIZE_MS);
    return () => clearTimeout(t);
  }, [expanded]);

  if (failed) return null;
  return (
    <div className={"map-card" + (expanded ? " map-card--expanded" : "")}>
      <div ref={box} className="map" aria-label="휴게소와 대체 충전소 지도" />
      <span className="map-legend glass" aria-hidden="true">
        <span className="map-legend__dot" />
        IC에서 걸리는 시간
      </span>
      <button
        type="button"
        className="map-toggle glass press"
        aria-expanded={expanded}
        onClick={() => {
          logClick("rest_area_map", { expand: expanded ? 0 : 1 });
          setExpanded((v) => !v);
        }}
      >
        {expanded ? "작게 보기" : "크게 보기"}
      </button>
    </div>
  );
}
