import { useEffect, useRef, useState } from "react";

import type { BypassIC, BypassStation } from "../api/types";
import { loadKakaoMaps } from "../lib/kakao";

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
  const [failed, setFailed] = useState(false);

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
      if (!bounds.isEmpty()) map.current.setBounds(bounds, 32, 32, 32, 32);
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

  if (failed) return null;
  return (
    <div ref={box} className="map" aria-label="휴게소와 대체 충전소 지도" />
  );
}
