import { getAnonKey } from "../lib/toss";
import type {
  BypassResponse,
  Connector,
  Direction,
  Highway,
  NearbyResponse,
  NodeListResponse,
  NotifySubscription,
  PatternResponse,
  TripResponse,
  UserRoute,
  UserRoutesResponse,
} from "./types";

const BASE_URL = (
  import.meta.env.VITE_API_BASE_URL ??
  "https://chargeflow-production.up.railway.app"
).replace(/\/$/, "");
const TIMEOUT_MS = 8000;

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

async function request<T>(
  method: string,
  path: string,
  body?: unknown,
): Promise<T> {
  const anonKey = await getAnonKey();
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);

  try {
    const res = await fetch(`${BASE_URL}/api/v1${path}`, {
      method,
      signal: ctrl.signal,
      headers: {
        Accept: "application/json",
        ...(body ? { "Content-Type": "application/json" } : {}),
        ...(anonKey ? { "X-Anon-Key": anonKey } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new ApiError(
        res.status,
        err.detail ?? "잠시 후 다시 시도해 주세요.",
      );
    }
    return res.status === 204 ? (undefined as T) : ((await res.json()) as T);
  } catch (e) {
    if (e instanceof ApiError) throw e;
    if (e instanceof DOMException && e.name === "AbortError") {
      throw new ApiError(408, "연결이 느려요. 잠시 후 다시 시도해 주세요.");
    }
    throw new ApiError(0, "인터넷 연결을 확인해 주세요.");
  } finally {
    clearTimeout(timer);
  }
}

export const api = {
  highways: () => request<Highway[]>("GET", "/highways/"),

  nodes: (code: string, direction: Direction, type: "RA" | "ALL" = "RA") =>
    request<NodeListResponse>(
      "GET",
      `/highways/${code}/nodes/?direction=${direction}&type=${type}`,
    ),

  trip: (code: string, direction: Direction, from: number, to: number) =>
    request<TripResponse>(
      "GET",
      `/highways/${code}/trip/?direction=${direction}&from=${from}&to=${to}`,
    ),

  nearest: (lat: number, lng: number, heading: number | null, limit = 5) =>
    request<NearbyResponse>(
      "GET",
      `/nodes/nearest-ra/?lat=${lat}&lng=${lng}&limit=${limit}` +
        (heading == null ? "" : `&heading=${Math.round(heading)}`),
    ),

  pattern: (raId: number) =>
    request<PatternResponse>("GET", `/nodes/${raId}/pattern/`),

  bypass: (raId: number, maxMinutes = 15) =>
    request<BypassResponse>(
      "GET",
      `/nodes/${raId}/bypass-stations/?max_minutes=${maxMinutes}`,
    ),

  myRoutes: () => request<UserRoutesResponse>("GET", "/me/routes/"),
  recordVisit: (raId: number) =>
    request<UserRoute>("POST", "/me/routes/", { ra_node_id: raId }),
  addFavorite: (raId: number) =>
    request<UserRoute>("POST", `/me/routes/${raId}/favorite/`),
  removeFavorite: (raId: number) =>
    request<void>("DELETE", `/me/routes/${raId}/favorite/`),
  removeRecent: (raId: number) =>
    request<void>("DELETE", `/me/routes/${raId}/`),
  enableFavoriteNotify: (raId: number) =>
    request<UserRoute & { deliverable: boolean }>(
      "POST",
      `/me/routes/${raId}/notify/`,
    ),
  disableFavoriteNotify: (raId: number) =>
    request<void>("DELETE", `/me/routes/${raId}/notify/`),

  settings: () => request<{ connector: Connector }>("GET", "/me/settings/"),
  saveSettings: (connector: Connector) =>
    request<{ connector: Connector }>("PUT", "/me/settings/", { connector }),

  notifyStatus: (raId: number) =>
    request<NotifySubscription>("GET", `/nodes/${raId}/notify-me/`),
  subscribeNotify: (raId: number) =>
    request<NotifySubscription>("POST", `/nodes/${raId}/notify-me/`),
  unsubscribeNotify: (raId: number) =>
    request<void>("DELETE", `/nodes/${raId}/notify-me/`),

  kakaoKey: () =>
    fetch(`${BASE_URL}/api/v1/config/`)
      .then((r) => r.json() as Promise<{ kakao_key: string }>)
      .then((r) => r.kakao_key),
};
