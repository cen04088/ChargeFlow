import { Paragraph } from "@toss/tds-mobile";
import { adaptive } from "@toss/tds-colors";

import type { PatternResponse } from "../api/types";

/** 오늘과 같은 요일의 시간대별 혼잡 확률 막대 (0~23시) */
export function PatternChart({
  pattern,
  nowHour,
}: {
  pattern: PatternResponse;
  nowHour: number;
}) {
  if (!pattern.has_pattern) {
    return (
      <Paragraph typography="t6" color={adaptive.grey600}>
        이 휴게소의 시간대별 혼잡 패턴을 모으고 있어요. 며칠 지나면 여기서 보여
        드릴게요.
      </Paragraph>
    );
  }
  const busiest = pattern.hours
    .filter((h) => h.waiting_rate != null)
    .sort((a, b) => (b.waiting_rate ?? 0) - (a.waiting_rate ?? 0))[0];

  return (
    <div>
      <div className="pattern" role="img" aria-label="시간대별 혼잡 확률">
        {pattern.hours.map((h) => (
          <div key={h.hour} className="pattern-col">
            <div
              className={
                "pattern-bar" +
                (h.waiting_rate == null ? " pattern-bar--empty" : "") +
                (h.hour === nowHour ? " pattern-bar--now" : "")
              }
              style={{ height: `${Math.max(4, h.waiting_rate ?? 4)}%` }}
            />
          </div>
        ))}
      </div>
      <div className="pattern-axis">
        <span>0시</span>
        <span>6시</span>
        <span>12시</span>
        <span>18시</span>
        <span>24시</span>
      </div>
      {busiest && busiest.waiting_rate! >= 30 && (
        <Paragraph typography="t6" color={adaptive.grey700}>
          평소 {busiest.hour}시쯤 가장 붐벼요 (혼잡 확률 {busiest.waiting_rate}
          %)
        </Paragraph>
      )}
    </div>
  );
}
