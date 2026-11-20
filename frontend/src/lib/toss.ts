/**
 * 앱인토스 SDK 호출을 한곳에 모은다.
 * 브라우저 개발 환경에서는 @apps-in-toss/devtools가 SDK를 mock한다.
 */
import {
  Accuracy,
  Analytics,
  Device,
  GetCurrentLocationPermissionError,
  Share,
  User,
} from "@apps-in-toss/web-framework";

import config from "../../apps-in-toss.config";

export const APP_NAME = config.appName;

let anonKeyPromise: Promise<string | null> | null = null;
/** 식별키를 기다리는 최대 시간. 넘으면 키 없이 요청한다(모든 API 요청이 이 값을 기다리므로 화면이 멈추지 않게) */
const ANON_KEY_WAIT_MS = 1500;

/** 미니앱 전용 사용자 식별키(hash). 지원하지 않는 환경이거나 늦으면 null */
export function getAnonKey(): Promise<string | null> {
  const key = loadAnonKey();
  return Promise.race([
    key,
    new Promise<null>((resolve) => setTimeout(() => resolve(null), ANON_KEY_WAIT_MS)),
  ]);
}

function loadAnonKey(): Promise<string | null> {
  if (!anonKeyPromise) {
    anonKeyPromise = (async () => {
      try {
        const res = await User.getAnonymousKey();
        return res?.hash ?? null;
      } catch {
        return null;
      }
    })();
  }
  return anonKeyPromise;
}

export type LocationResult =
  | { ok: true; lat: number; lng: number }
  | { ok: false; reason: "denied" | "failed" };

/**
 * 현재 위치를 한 번 가져온다. 권한이 없으면 권한 요청 화면을 띄운다.
 * prompt가 false면 권한 요청 화면을 띄우지 않고 "denied"로 끝낸다 —
 * 앱을 열자마자 권한 창이 뜨거나 화면이 위치를 기다리며 멈추지 않게, 자동 조회는 이쪽을 쓴다.
 */
export async function getLocation(prompt = true): Promise<LocationResult> {
  const read = async (): Promise<LocationResult> => {
    const loc = await Device.getLocation({ accuracy: Accuracy.Balanced });
    return { ok: true, lat: loc.coords.latitude, lng: loc.coords.longitude };
  };

  try {
    return await read();
  } catch (error) {
    if (!(error instanceof GetCurrentLocationPermissionError)) {
      return { ok: false, reason: "failed" };
    }
  }
  if (!prompt) return { ok: false, reason: "denied" };

  try {
    const result = await Device.getLocation.openPermissionDialog();
    if (result !== "allowed") return { ok: false, reason: "denied" };
    return await read();
  } catch {
    return { ok: false, reason: "denied" };
  }
}

function bearing(lat1: number, lng1: number, lat2: number, lng2: number) {
  const r = Math.PI / 180;
  const y = Math.sin((lng2 - lng1) * r) * Math.cos(lat2 * r);
  const x =
    Math.cos(lat1 * r) * Math.sin(lat2 * r) -
    Math.sin(lat1 * r) * Math.cos(lat2 * r) * Math.cos((lng2 - lng1) * r);
  return ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360;
}

function distanceM(lat1: number, lng1: number, lat2: number, lng2: number) {
  const r = Math.PI / 180;
  const a =
    Math.sin(((lat2 - lat1) * r) / 2) ** 2 +
    Math.cos(lat1 * r) *
      Math.cos(lat2 * r) *
      Math.sin(((lng2 - lng1) * r) / 2) ** 2;
  return 6371000 * 2 * Math.asin(Math.sqrt(a));
}

const HEADING_SAMPLE_MS = 4000;
const MIN_MOVE_M = 40;

/**
 * 위치를 두 번 재서 진행 방향(방위각)을 구한다. 차가 움직이지 않으면 heading은 null.
 * 첫 위치가 나오면 onFirst로 먼저 알려 화면을 바로 채울 수 있게 한다.
 */
export type LocatedWithHeading =
  | { ok: true; lat: number; lng: number; heading: number | null }
  | { ok: false; reason: "denied" | "failed" };

export async function getLocationWithHeading(
  onFirst?: (lat: number, lng: number) => void,
  prompt = true,
): Promise<LocatedWithHeading> {
  const first = await getLocation(prompt);
  if (!first.ok) return first;
  onFirst?.(first.lat, first.lng);
  await new Promise((r) => setTimeout(r, HEADING_SAMPLE_MS));
  const second = await getLocation(false);
  if (!second.ok) return { ...first, heading: null };
  const moved = distanceM(first.lat, first.lng, second.lat, second.lng);
  const heading =
    moved >= MIN_MOVE_M
      ? bearing(first.lat, first.lng, second.lat, second.lng)
      : null;
  return { ...second, heading };
}

/** 휴게소 상세 화면 공유 */
export async function shareRestArea(id: number, name: string) {
  const link = await Share.createLink({
    path: `intoss://${APP_NAME}/rest-area/${id}`,
  });
  await Share.sendMessage({ message: `${name} 충전기 상황 확인하기\n${link}` });
}

export async function openExternal(url: string) {
  try {
    await Device.openURL(url);
  } catch {
    window.open(url, "_blank", "noopener");
  }
}

/** 카카오맵 길찾기 (앱이 있으면 앱, 없으면 웹) */
export function openDirections(
  name: string,
  lat: string | number,
  lng: string | number,
) {
  return openExternal(
    `https://map.kakao.com/link/to/${encodeURIComponent(name)},${lat},${lng}`,
  );
}

export function logScreen(
  name: string,
  params: Record<string, string | number> = {},
) {
  void Analytics.screen({ log_name: name, ...params })?.catch(() => {});
}

export function logClick(
  name: string,
  params: Record<string, string | number> = {},
) {
  void Analytics.click({ log_name: name, ...params })?.catch(() => {});
}
