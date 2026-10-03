export type Direction = "UP" | "DOWN";

export type CongestionLevel =
  "smooth" | "normal" | "busy" | "jammed" | "unavailable" | "unknown";

export interface Congestion {
  level: CongestionLevel;
  label: string;
  color: string;
  available: number | null;
  charging: number | null;
  offline: number | null;
  total: number | null;
  turnover_30m: number | null;
  checked_at: string | null;
}

export interface Highway {
  id: number;
  code: string;
  name: string;
  total_distance_km: number | null;
  start_name: string;
  end_name: string;
  down_label: string;
  up_label: string;
}

export type Connector = "" | "combo" | "chademo" | "ac3" | "nacs";

export interface Forecast {
  hours_ahead: number;
  at: string;
  probability: number | null;
  label: "높음" | "보통" | "낮음" | null;
  based_on_history: boolean;
}

export interface Decision {
  wait_minutes: number | null;
  prediction: Forecast[];
}

export interface PatternResponse {
  node_id: number;
  weekday: number;
  hours: { hour: number; waiting_rate: number | null; samples: number }[];
  has_pattern: boolean;
  prediction: Forecast[];
}

export interface TripStop {
  id: number;
  name: string;
  km_from_start: number;
  eta_minutes: number;
  congestion: Congestion;
  forecast: Forecast | null;
}

export interface TripResponse {
  highway: string;
  direction: Direction;
  from: { id: number; name: string };
  to: { id: number; name: string };
  total_km: number;
  stops: TripStop[];
}

export interface HighwayNode {
  id: number;
  sequence: number;
  node_type: "IC" | "RA";
  name: string;
  latitude: string;
  longitude: string;
  distance_from_start_km: number;
  congestion?: Congestion;
}

export interface NodeListResponse {
  highway: string;
  direction: Direction;
  nodes: HighwayNode[];
}

export interface NearbyResponse {
  direction_matched: boolean;
  stations: NearbyRestArea[];
}

export interface NearbyRestArea {
  id: number;
  name: string;
  highway_code: string;
  highway_name: string;
  direction: Direction;
  latitude: string;
  longitude: string;
  distance_km: number;
  congestion: Congestion;
}

export interface UserRoute {
  ra_node_id: number;
  name: string;
  highway_code: string;
  highway_name: string;
  direction: Direction;
  is_favorite: boolean;
  notify_enabled: boolean;
  visit_count: number;
  last_used_at: string;
  congestion: Congestion;
}

export interface UserRoutesResponse {
  recent: UserRoute[];
  favorites: UserRoute[];
}

export type PlaceType = "mart" | "gas_station" | "hotel" | "public" | "etc";

export interface BypassStation {
  id: number;
  name: string;
  address: string;
  place_type: PlaceType;
  latitude: string;
  longitude: string;
  power_kw: number | null;
  connector_type: string;
  charger_count: number;
  operator: string;
  open_hours: string;
  distance_km: number;
  drive_minutes: number;
  route_memo: string;
  is_recommended: boolean;
  is_estimated: boolean;
  kakao_place_id: string;
  connectors: Exclude<Connector, "">[];
  realtime: { available: number; total: number; checked_at: string } | null;
  detour_extra_minutes: number;
}

export interface BypassIC {
  id: number;
  name: string;
  latitude: string;
  longitude: string;
  distance_from_start_km: number;
  stations: BypassStation[];
}

export interface BypassResponse {
  target_rest_area: {
    id: number;
    name: string;
    highway_code: string;
    highway_name: string;
    direction: Direction;
    latitude: string;
    longitude: string;
  };
  congestion: Congestion;
  decision: Decision;
  previous_ic: BypassIC | null;
  next_ic: BypassIC | null;
}

export interface NotifySubscription {
  subscribed: boolean;
  rest_area?: string;
  deliverable?: boolean;
}
