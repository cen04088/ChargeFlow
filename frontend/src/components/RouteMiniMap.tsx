import { fitProjection } from "../pages/highwayStrip";

interface Point {
  lat: number;
  lng: number;
}

const SIZE = 96;
const PAD = 10;

/**
 * 노선 띠 오른쪽 위의 작은 지도 창: 노선 모양(도로색 선)과 내 위치 점만 그린 그림이다(지도 SDK를 쓰지 않는다).
 * 누르면 지도 보기로 바뀐다.
 */
export function RouteMiniMap({
  path,
  me,
  onClick,
}: {
  path: Point[];
  me: Point | null;
  onClick: () => void;
}) {
  const project = fitProjection(path, SIZE, SIZE, PAD);
  const points = path
    .map((p) => project(p))
    .map(({ x, y }) => `${x.toFixed(1)},${y.toFixed(1)}`)
    .join(" ");
  const dot = me ? project(me) : null;
  const dotInside =
    dot != null && dot.x >= 0 && dot.x <= SIZE && dot.y >= 0 && dot.y <= SIZE;
  return (
    <button type="button" className="route-mini press" onClick={onClick}>
      <svg
        className="route-mini__map"
        viewBox={`0 0 ${SIZE} ${SIZE}`}
        width={SIZE}
        height={SIZE}
        aria-hidden="true"
        focusable="false"
      >
        <polyline
          points={points}
          fill="none"
          stroke="#fff"
          strokeWidth="7"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
        <polyline
          points={points}
          fill="none"
          stroke="var(--road)"
          strokeWidth="4"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
        {dotInside && dot && (
          <circle
            cx={dot.x}
            cy={dot.y}
            r="5"
            fill="var(--sky-strong)"
            stroke="#fff"
            strokeWidth="2"
          />
        )}
      </svg>
      <span className="route-mini__caption">지도로 보기</span>
    </button>
  );
}
