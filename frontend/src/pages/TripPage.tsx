import { ListRow, SegmentedControl, Skeleton } from "@toss/tds-mobile";
import { useEffect } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";

import { api } from "../api/client";
import type { Direction } from "../api/types";
import { CongestionNote } from "../components/Congestion";
import { PageHeading } from "../components/PageHeading";
import { SectionHeader } from "../components/SectionHeader";
import { ErrorState } from "../components/ErrorState";
import {
  formatMinutes,
  highwayRange,
  routeNumber,
  shortAvailability,
  shortName,
} from "../lib/format";
import { useHighways } from "../lib/store";
import { logClick, logScreen } from "../lib/toss";
import { useAsync } from "../lib/useAsync";

/**
 * 구간 모드 — 단계마다 주소(쿼리)를 바꿔서 토스 뒤로가기로 이전 단계에 돌아갈 수 있다.
 *   /trip → 노선 고르기 → ?hw=&dir= 출발 고르기 → &from= 도착 고르기 → &to= 결과
 */
export default function TripPage() {
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const code = params.get("hw");
  const direction: Direction = params.get("dir") === "UP" ? "UP" : "DOWN";
  const from = Number(params.get("from")) || null;
  const to = Number(params.get("to")) || null;

  useEffect(
    () =>
      logScreen("trip", {
        step: !code ? "highway" : !from ? "from" : !to ? "to" : "result",
      }),
    [code, from, to],
  );

  const go = (next: Record<string, string | number>) => {
    const q = new URLSearchParams();
    Object.entries({ hw: code ?? "", dir: direction, ...next }).forEach(
      ([k, v]) => v !== "" && q.set(k, String(v)),
    );
    navigate(`/trip?${q.toString()}`);
  };

  if (!code) return <PickHighway onPick={(hw) => go({ hw })} />;
  if (!from || !to) {
    return (
      <PickPoint
        code={code}
        direction={direction}
        from={from}
        onDirection={(dir) =>
          navigate(`/trip?hw=${code}&dir=${dir}`, { replace: true })
        }
        onPick={(id) => (from ? go({ from, to: id }) : go({ from: id }))}
      />
    );
  }
  return <TripResult code={code} direction={direction} from={from} to={to} />;
}

function PickHighway({ onPick }: { onPick: (code: string) => void }) {
  const highways = useHighways();
  return (
    <main className="page">
      <PageHeading
        context="구간 미리 보기 · 1/3"
        title="어느 고속도로로 가세요?"
        description="출발과 도착을 고르면 지날 휴게소를 볼 수 있어요."
      />
      {highways.error && (
        <ErrorState error={highways.error} onRetry={highways.reload} />
      )}
      {!highways.data && !highways.error && (
        <Skeleton pattern="listOnly" repeatLastItemCount={5} />
      )}
      {highways.data?.map((h) => (
        <ListRow
          key={h.code}
          left={
            <ListRow.AssetText
              shape="squircle"
              size="medium"
              backgroundColor="var(--brand-tint)"
              color="var(--brand-strong)"
            >
              {routeNumber(h.code)}
            </ListRow.AssetText>
          }
          contents={
            <ListRow.Texts
              type="2RowTypeA"
              top={h.name}
              bottom={highwayRange(h)}
            />
          }
          arrowType="right"
          onClick={() => onPick(h.code)}
        />
      ))}
    </main>
  );
}

function PickPoint({
  code,
  direction,
  from,
  onDirection,
  onPick,
}: {
  code: string;
  direction: Direction;
  from: number | null;
  onDirection: (d: Direction) => void;
  onPick: (id: number) => void;
}) {
  const hw = useHighways().data?.find((h) => h.code === code);
  const nodes = useAsync(
    () => api.nodes(code, direction, "ALL"),
    [code, direction],
  );
  const all = nodes.data?.nodes ?? [];
  const startIndex = from ? all.findIndex((n) => n.id === from) : -1;
  const choices = from ? all.slice(startIndex + 1) : all.slice(0, -1);
  const start = startIndex >= 0 ? all[startIndex] : null;

  return (
    <main className="page">
      <PageHeading
        context={`구간 미리 보기 · ${from ? "3/3" : "2/3"}`}
        title={from ? "어디까지 가세요?" : "어디서 출발하세요?"}
        description={[
          hw?.name ?? nodes.data?.highway,
          start && `${shortName(start.name)}에서 출발`,
        ]
          .filter(Boolean)
          .join(" · ")}
      />
      {!from && hw && (
        <div className="section-pad section-pad--flush">
          <SegmentedControl
            size="large"
            alignment="fluid"
            value={direction}
            onChange={(v) => onDirection(v as Direction)}
          >
            <SegmentedControl.Item value="DOWN">
              {hw.down_label}
            </SegmentedControl.Item>
            <SegmentedControl.Item value="UP">
              {hw.up_label}
            </SegmentedControl.Item>
          </SegmentedControl>
        </div>
      )}
      {nodes.error && !nodes.data && (
        <ErrorState error={nodes.error} onRetry={nodes.reload} />
      )}
      {!nodes.data && !nodes.error && (
        <Skeleton pattern="listOnly" repeatLastItemCount={8} />
      )}
      {nodes.data && choices.length === 0 && (
        <p className="flow-notice">
          {from
            ? "이 출발 지점 이후에 선택할 도착 지점이 없어요."
            : "이 방향에 선택할 출발 지점이 없어요."}
        </p>
      )}
      {choices.map((n) => (
        <ListRow
          key={n.id}
          contents={
            <ListRow.Texts
              type="2RowTypeA"
              top={shortName(n.name)}
              bottom={
                n.node_type === "RA"
                  ? `휴게소 · ${shortAvailability(n.congestion)}`
                  : start
                    ? `IC · ${Math.round(n.distance_from_start_km - start.distance_from_start_km)}km`
                    : "IC"
              }
            />
          }
          arrowType="right"
          onClick={() => onPick(n.id)}
        />
      ))}
    </main>
  );
}

function TripResult({
  code,
  direction,
  from,
  to,
}: {
  code: string;
  direction: Direction;
  from: number;
  to: number;
}) {
  const navigate = useNavigate();
  const trip = useAsync(
    () => api.trip(code, direction, from, to),
    [code, direction, from, to],
  );

  if (trip.error && !trip.data)
    return (
      <main className="page">
        <ErrorState error={trip.error} onRetry={trip.reload} />
      </main>
    );
  if (!trip.data)
    return (
      <main className="page" aria-busy="true">
        <PageHeading title="지날 휴게소" />
        <Skeleton pattern="listOnly" repeatLastItemCount={6} />
      </main>
    );
  const t = trip.data;

  return (
    <main className="page">
      <PageHeading
        context={t.highway}
        title={`${shortName(t.from.name)}에서 ${shortName(t.to.name)}까지`}
      />
      <dl className="trip-metrics">
        <div>
          <dt>구간 거리</dt>
          <dd>{Math.round(t.total_km)}km</dd>
        </div>
        <div>
          <dt>지날 휴게소</dt>
          <dd>{t.stops.length}곳</dd>
        </div>
      </dl>
      <section className="flow-section">
        <SectionHeader
          title="지날 휴게소"
          description="도착까지 걸리는 시간은 시속 90km 기준이에요."
        />
        {t.stops.length === 0 && (
          <p className="flow-notice">
            이 구간에는 휴게소가 없어요. 구간을 넓혀 보세요.
          </p>
        )}
        {t.stops.map((s, i) => (
          <ListRow
            key={s.id}
            left={
              <ListRow.AssetText
                shape="squircle"
                size="medium"
                backgroundColor="var(--brand-tint)"
                color="var(--brand-strong)"
              >
                {`${i + 1}`}
              </ListRow.AssetText>
            }
            contents={
              <ListRow.Texts
                type="2RowTypeA"
                top={shortName(s.name)}
                bottom={`${Math.round(s.km_from_start)}km · 약 ${formatMinutes(s.eta_minutes)} 뒤`}
              />
            }
            right={<CongestionNote congestion={s.congestion} />}
            arrowType="right"
            onClick={() => {
              logClick("trip_open_rest_area");
              navigate(`/rest-area/${s.id}`);
            }}
          />
        ))}
      </section>
    </main>
  );
}
