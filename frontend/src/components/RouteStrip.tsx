import { Button } from "@toss/tds-mobile";
import { useEffect, useLayoutEffect, useRef } from "react";

import type { HighwayNode } from "../api/types";
import { shortName, timeAgo } from "../lib/format";
import { raPin } from "../lib/highway";
import type { StripItem } from "../pages/highwayStrip";
import { RaStatusText } from "./RestAreaRow";

/** 휴게소 줄 둘째 줄: "급속 {전체}대 · {확인 시각}" — 모르는 부분은 뺀다 */
function subText(n: HighwayNode) {
  const c = n.congestion;
  const parts = [
    c?.total != null ? `급속 ${c.total}대` : null,
    c?.checked_at ? timeAgo(c.checked_at) : null,
  ].filter(Boolean);
  return parts.length ? parts.join(" · ") : "실시간 정보 없음";
}

function Chevron() {
  return (
    <svg
      className="strip-ra__chevron"
      viewBox="0 0 16 16"
      width="16"
      height="16"
      aria-hidden="true"
      focusable="false"
    >
      <path
        d="M6 3l5 5-5 5"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

const rowId = (id: number) => `strip-ra-${id}`;

/**
 * 노선 띠(내비 고속도로 모드): 곧은 세로 도로 띠 위에 휴게소(상태색 고리)와 IC(작은 점)를 가는 순서로.
 * 왼쪽은 거리 칸. 띠는 줄마다 이어 그리고(줄 사이 틈 없음) 첫 줄·마지막 줄 가운데에서 끝난다.
 */
export function RouteStrip({
  items,
  passedCount,
  onOpen,
  onShowPassed,
  scrollToId,
  armKey,
  isSpent,
  onAutoScrolled,
}: {
  items: StripItem[];
  passedCount: number;
  onOpen: (id: number) => void;
  onShowPassed: () => void;
  /** 화면 가운데로 데려갈 휴게소(가까운 휴게소). 이용자가 손대기 전에만 부모가 넘긴다 */
  scrollToId: number | null;
  /** 바뀌면(노선·방향, "내 위치"를 다시 누름) 다시 판단한다 */
  armKey: string;
  /** 지금 이 순간 이미 손댔는지(스크롤 직전에 다시 확인 — 1분 갱신 등으로 늦게 움직이지 않게) */
  isSpent: () => boolean;
  onAutoScrolled: () => void;
}) {
  const listRef = useRef<HTMLOListElement>(null);

  // 가까운 휴게소로 한 번 스크롤 — 이용자가 손대기 전에만(손대면 그 노선·방향에서는 끝)
  useEffect(() => {
    if (scrollToId == null || isSpent()) return;
    const el = document.getElementById(rowId(scrollToId));
    if (!el) return;
    onAutoScrolled();
    el.scrollIntoView({ block: "center" });
    // isSpent·onAutoScrolled는 ref를 읽는 함수라 의존성에서 뺀다
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scrollToId, armKey]);

  // 지나온 곳을 펼치면 위에 줄이 생긴다 — "지금 여기"가 화면에서 같은 자리에 머물게 스크롤을 보정한다
  const anchorTop = useRef<number | null>(null);
  const showPassed = () => {
    const me = listRef.current?.querySelector(".strip-row--me");
    anchorTop.current = me ? me.getBoundingClientRect().top : null;
    onShowPassed();
  };
  useLayoutEffect(() => {
    if (anchorTop.current == null) return;
    const me = listRef.current?.querySelector(".strip-row--me");
    if (me) window.scrollBy(0, me.getBoundingClientRect().top - anchorTop.current);
    anchorTop.current = null;
  }, [items]);

  const hasToggle = items.some((it) => it.kind === "passed-toggle");

  return (
    <>
      {hasToggle && (
        <div className="strip-passed">
          <Button size="large" variant="weak" color="dark" display="full" onClick={showPassed}>
            {`지나온 휴게소 ${passedCount}곳 보기`}
          </Button>
        </div>
      )}
      <ol ref={listRef} className="strip" aria-label="가는 순서의 휴게소와 IC">
        {items.map((it) => {
          if (it.kind === "passed-toggle") return null;
          if (it.kind === "me") {
            return (
              <li key="me" className="strip-row strip-row--me">
                <span className="strip-node strip-node--me" aria-hidden="true" />
                <span className="strip-me">지금 여기</span>
              </li>
            );
          }
          if (it.kind === "ic") {
            return (
              <li key={it.node.id} className="strip-row strip-row--ic">
                <span className="strip-km">{it.km}</span>
                <span className="strip-node strip-node--ic" aria-hidden="true" />
                <span className="strip-ic">{it.node.name}</span>
              </li>
            );
          }
          const n = it.node;
          const kind = n.congestion ? raPin(n.congestion).kind : "unavailable";
          return (
            <li
              key={n.id}
              id={rowId(n.id)}
              className={`strip-row strip-row--ra${it.mark ? " strip-row--mark" : ""}${it.passed ? " strip-row--passed" : ""}`}
            >
              <button type="button" className="strip-ra" onClick={() => onOpen(n.id)}>
                <span className="strip-km">{it.km}</span>
                <span className={`strip-node strip-node--${kind}`} aria-hidden="true" />
                <span className="strip-ra__text">
                  {it.mark && (
                    <span className="strip-ra__mark">
                      {it.mark === "next" ? "다음 휴게소" : "가까운 휴게소"}
                    </span>
                  )}
                  <span className="strip-ra__name">{shortName(n.name)}</span>
                  <span className="strip-ra__sub">{subText(n)}</span>
                </span>
                <RaStatusText congestion={n.congestion} />
                <Chevron />
              </button>
            </li>
          );
        })}
      </ol>
    </>
  );
}
