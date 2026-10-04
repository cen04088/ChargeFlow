import {
  ListRow,
  Paragraph,
  SegmentedControl,
  Skeleton,
  Top,
} from "@toss/tds-mobile";
import { adaptive } from "@toss/tds-colors";
import { useEffect } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";

import { api } from "../api/client";
import type { Direction } from "../api/types";
import { CongestionNote } from "../components/Congestion";
import { SectionHeader } from "../components/SectionHeader";
import { ErrorState } from "../components/ErrorState";
import {
  formatMinutes,
  highwayRange,
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
    <div className="page">
      <Top
        title={
          <Top.TitleParagraph size={22}>
            어느 고속도로로 가세요?
          </Top.TitleParagraph>
        }
        subtitleBottom={
          <Top.SubtitleParagraph size={15}>
            출발·도착을 고르면 지날 휴게소를 보여 드려요
          </Top.SubtitleParagraph>
        }
      />
      {!highways.data && (
        <Skeleton pattern="listOnly" repeatLastItemCount={5} />
      )}
      {highways.data?.map((h) => (
        <ListRow
          key={h.code}
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
    </div>
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
    <div className="page">
      <Top
        subtitleTop={
          hw && (
            <Top.SubtitleParagraph size={15}>{hw.name}</Top.SubtitleParagraph>
          )
        }
        title={
          <Top.TitleParagraph size={22}>
            {from ? "어디까지 가세요?" : "어디서 출발하세요?"}
          </Top.TitleParagraph>
        }
        subtitleBottom={
          start && (
            <Top.SubtitleParagraph size={15}>
              {shortName(start.name)}에서 출발
            </Top.SubtitleParagraph>
          )
        }
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
    </div>
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
    return <ErrorState error={trip.error} onRetry={trip.reload} />;
  if (!trip.data) return <Skeleton pattern="topList" repeatLastItemCount={6} />;
  const t = trip.data;

  return (
    <div className="page">
      <Top
        subtitleTop={
          <Top.SubtitleParagraph size={15}>{t.highway}</Top.SubtitleParagraph>
        }
        title={
          <Top.TitleParagraph size={22}>
            {shortName(t.from.name)}에서 {shortName(t.to.name)}까지
          </Top.TitleParagraph>
        }
        subtitleBottom={
          <Top.SubtitleParagraph size={15}>
            {Math.round(t.total_km)}km · 휴게소 {t.stops.length}곳
          </Top.SubtitleParagraph>
        }
      />
      <SectionHeader
        title="지날 휴게소"
        description={
          "도착 시각은 시속 90km 기준이에요. 오른쪽 충전기 상태는 참고만 해 주세요."
        }
      />
      {t.stops.length === 0 && (
        <div className="section-pad">
          <Paragraph typography="t6" color={adaptive.grey600}>
            이 구간에는 휴게소가 없어요. 구간을 넓혀 보세요.
          </Paragraph>
        </div>
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
      <div className="footnote" />
    </div>
  );
}
