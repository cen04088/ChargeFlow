import {
  ListRow,
  SearchField,
  SegmentedControl,
  Skeleton,
} from "@toss/tds-mobile";
import { useEffect, useMemo, useState } from "react";
import {
  Navigate,
  useNavigate,
  useParams,
  useSearchParams,
} from "react-router-dom";

import { api } from "../api/client";
import type { Direction } from "../api/types";
import { ErrorState } from "../components/ErrorState";
import { PageHeading } from "../components/PageHeading";
import { RestAreaRow } from "../components/RestAreaRow";
import { SectionHeader } from "../components/SectionHeader";
import { highwayRange, shortName } from "../lib/format";
import { useHighways } from "../lib/store";
import { logClick, logScreen } from "../lib/toss";
import { useAsync } from "../lib/useAsync";

export default function HighwayPage() {
  const { code } = useParams();
  const highways = useHighways();
  const hw = highways.data?.find((h) => h.code === code);
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const direction: Direction = params.get("dir") === "UP" ? "UP" : "DOWN";
  const [query, setQuery] = useState("");

  const nodes = useAsync(
    () =>
      code
        ? api.nodes(code, direction)
        : Promise.reject(new Error("unknown highway")),
    [code, direction],
  );

  useEffect(() => logScreen("highway", { highway: code ?? "" }), [code]);

  const list = useMemo(() => {
    const q = query.replace(/\s/g, "");
    return (nodes.data?.nodes ?? []).filter(
      (n) => !q || n.name.replace(/\s/g, "").includes(q),
    );
  }, [nodes.data, query]);

  if (highways.data && !hw) return <Navigate to="/" replace />;

  return (
    <main className="page">
      <PageHeading
        title={hw?.name ?? nodes.data?.highway ?? "고속도로 휴게소"}
        description={hw && highwayRange(hw)}
      />

      {hw && (
        <div className="section-pad section-pad--flush">
          <SegmentedControl
            size="large"
            alignment="fluid"
            value={direction}
            onChange={(v) => {
              logClick("highway_direction", { direction: v });
              setParams({ dir: v }, { replace: true });
            }}
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

      <div className="section-pad section-pad--flush">
        <SearchField
          placeholder="휴게소 이름으로 찾기"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onDeleteClick={() => setQuery("")}
        />
      </div>

      <div className="route-shortcut">
        <ListRow
          contents={
            <ListRow.Texts
              type="2RowTypeA"
              top="구간 미리 보기"
              bottom="출발과 도착을 고르면 지날 휴게소를 순서대로 보여 드려요"
            />
          }
          arrowType="right"
          onClick={() => {
            logClick("highway_open_trip");
            navigate(`/trip?hw=${code}&dir=${direction}`);
          }}
        />
      </div>

      {nodes.error && !nodes.data ? (
        <ErrorState error={nodes.error} onRetry={nodes.reload} />
      ) : nodes.loading && !nodes.data ? (
        <Skeleton pattern="listOnly" repeatLastItemCount={6} />
      ) : (
        <section className="flow-section">
          <SectionHeader
            title={`휴게소 ${list.length}곳`}
            description={
              list.length > 0 ? "가는 방향 순서로 보여 드려요." : undefined
            }
          />
          {list.length === 0 && (
            <p className="flow-notice">
              {query.trim()
                ? `‘${query.trim()}’와 일치하는 휴게소가 없어요.`
                : "이 방향에 표시할 휴게소가 없어요."}
            </p>
          )}
          {list.map((n) => (
            <RestAreaRow
              key={n.id}
              name={shortName(n.name)}
              congestion={n.congestion}
              onClick={() => {
                logClick("highway_open_rest_area");
                navigate(`/rest-area/${n.id}`);
              }}
            />
          ))}
        </section>
      )}
    </main>
  );
}
