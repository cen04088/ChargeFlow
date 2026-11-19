import { loadKakaoMaps } from "./kakao";

/** 주소·장소 검색 결과 한 줄 */
export interface Place {
  id: string;
  /** 큰 글씨: 장소 이름이나 주소 */
  name: string;
  /** 작은 글씨: 주소(이름이 곧 주소면 빈 문자열) */
  address: string;
  lat: number;
  lng: number;
}

/** 카카오 주소 검색(Geocoder.addressSearch) 결과에서 쓰는 항목 */
export interface RawAddress {
  address_name: string;
  x: string;
  y: string;
}

/** 카카오 장소 검색(Places.keywordSearch) 결과에서 쓰는 항목 */
export interface RawPlace {
  id: string;
  place_name: string;
  address_name: string;
  road_address_name?: string;
  x: string;
  y: string;
}

export const PLACE_LIMIT = 8;
/** 이보다 짧은 검색어는 찾지 않는다 */
export const MIN_QUERY = 2;

function point(x: string, y: string): { lat: number; lng: number } | null {
  const lat = Number(y);
  const lng = Number(x);
  return Number.isFinite(lat) && Number.isFinite(lng) ? { lat, lng } : null;
}

/**
 * 주소 결과를 앞에, 장소 결과를 뒤에 두고 합친다.
 * 좌표가 깨진 줄과 이름·좌표가 같은 줄은 버리고 PLACE_LIMIT개까지만 남긴다.
 */
export function mergePlaces(
  addresses: RawAddress[],
  places: RawPlace[],
  limit = PLACE_LIMIT,
): Place[] {
  const out: Place[] = [];
  const seen = new Set<string>();
  const push = (p: Place) => {
    const key = `${p.name}|${p.lat.toFixed(4)}|${p.lng.toFixed(4)}`;
    if (seen.has(key) || out.length >= limit) return;
    seen.add(key);
    out.push(p);
  };
  for (const a of addresses) {
    const pt = point(a.x, a.y);
    if (!pt || !a.address_name) continue;
    push({ id: `addr:${a.address_name}`, name: a.address_name, address: "", ...pt });
  }
  for (const p of places) {
    const pt = point(p.x, p.y);
    if (!pt || !p.place_name) continue;
    push({
      id: `place:${p.id}`,
      name: p.place_name,
      address: p.road_address_name || p.address_name || "",
      ...pt,
    });
  }
  return out;
}

/* eslint-disable @typescript-eslint/no-explicit-any */
function ask<T>(
  kakao: any,
  run: (cb: (result: T[], status: string) => void) => void,
): Promise<T[]> {
  return new Promise((resolve, reject) => {
    const S = kakao.maps.services.Status;
    run((result, status) => {
      if (status === S.OK) resolve(result);
      else if (status === S.ZERO_RESULT) resolve([]);
      else reject(new Error("place search failed"));
    });
  });
}

/**
 * 주소와 장소 이름을 함께 찾는다(카카오맵 services).
 * 둘 중 하나만 실패하면 나머지 결과를 쓰고, 둘 다 실패하거나 SDK를 못 불러오면 던진다.
 */
export async function searchPlaces(query: string): Promise<Place[]> {
  const q = query.trim();
  if (q.length < MIN_QUERY) return [];
  const kakao = await loadKakaoMaps();
  if (!kakao?.maps?.services) throw new Error("place search unavailable");
  const { services } = kakao.maps;
  const [addr, place] = await Promise.allSettled([
    ask<RawAddress>(kakao, (cb) => new services.Geocoder().addressSearch(q, cb)),
    ask<RawPlace>(kakao, (cb) =>
      new services.Places().keywordSearch(q, cb, { size: PLACE_LIMIT }),
    ),
  ]);
  if (addr.status === "rejected" && place.status === "rejected")
    throw new Error("place search failed");
  return mergePlaces(
    addr.status === "fulfilled" ? addr.value : [],
    place.status === "fulfilled" ? place.value : [],
  );
}
