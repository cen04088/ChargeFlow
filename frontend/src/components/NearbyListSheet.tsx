import {
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
  type Ref,
} from "react";

import { SHEET_TAP_PX, sheetSnap } from "../pages/nearbyState";

export type SheetToggleBy = "drag" | "handle" | "button" | "map" | "pin";

interface NearbyListSheetProps {
  open: boolean;
  onToggle: (open: boolean, by: SheetToggleBy) => void;
  /** 접혔을 때 손잡이 아래 보이는 줄 */
  peek: ReactNode;
  /** 펼쳤을 때 보이는 본문(세로 스크롤) */
  children: ReactNode;
  /** 접힌 시트 높이(손잡이 + peek) — 지도 위 버튼·범위 맞춤 여백에 쓴다 */
  onPeekHeight: (px: number) => void;
  /** 손잡이 버튼 — 버튼으로 펼친 뒤 포커스를 옮길 곳 */
  handleRef?: Ref<HTMLButtonElement>;
  /** 시트 영역 이름(화면낭독기) */
  label?: string;
  /** 접힌 시트를 한 번 더 내려 요약만 남긴 상태. onCollapse와 함께 준다 */
  collapsed?: boolean;
  /** 주면 접힌 시트를 아래로 끌어 더 줄일 수 있다(부모가 peek 내용을 줄인다) */
  onCollapse?: (collapsed: boolean) => void;
}

/** 펼친 높이: 지도 영역의 85%와 화면 높이의 70% 중 작은 값 */
const OPEN_AREA_RATIO = 0.85;
const OPEN_VIEWPORT_RATIO = 0.7;
/** 놓는 순간 속도는 마지막 이만큼(ms)의 움직임으로 잰다 */
const VELOCITY_WINDOW_MS = 80;
/** 끌기 시작 판정: 이만큼 움직인 뒤 가로·세로를 비교한다 */
const DRAG_DECIDE_PX = 6;
/** 접힌 시트를 이만큼 아래로 끌면 요약만 남긴다 */
const COLLAPSE_DRAG_PX = 24;
/** 접힌 시트를 아래로 끌 때 따라 내려가는 최대 거리 */
const COLLAPSE_PULL_PX = 48;

interface Drag {
  pointerId: number;
  startX: number;
  startY: number;
  /** null: 아직 방향을 모름, true: 세로 끌기, false: 가로라서 포기 */
  vertical: boolean | null;
  samples: { t: number; y: number }[];
}

/**
 * 지도 위에 얹힌 비모달 목록 시트. 접힘/펼침 두 상태뿐이다.
 * 펼치기: 손잡이 끌기·누르기(Enter/Space 포함), 또는 peek 안의 버튼(부모가 onToggle).
 * 끌기는 손잡이에서 시작한 pointer만 받는다 — 지도 끌기와 섞이지 않는다.
 */
export function NearbyListSheet({
  open,
  onToggle,
  peek,
  children,
  onPeekHeight,
  handleRef,
  label = "주변 급속충전소 목록",
  collapsed = false,
  onCollapse,
}: NearbyListSheetProps) {
  const sheetRef = useRef<HTMLElement>(null);
  const headRef = useRef<HTMLDivElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const bodyId = useId();

  const [openH, setOpenH] = useState(0);
  const [peekH, setPeekH] = useState(0);
  /** 끄는 중의 위치(translateY px, 0 = 펼침). null이면 끄는 중이 아니다 */
  const [dragY, setDragY] = useState<number | null>(null);

  const drag = useRef<Drag | null>(null);
  /** 방금 끝난 끌기(또는 포기한 가로 쓸기)에 딸려 오는 click 하나를 누르기로 치지 않는다.
   *  다음 pointerdown에서 풀리므로 새 누르기·끌기를 막지 않는다 */
  const suppressClick = useRef(false);
  const openRef = useRef(open);
  openRef.current = open;
  const peekCb = useRef(onPeekHeight);
  peekCb.current = onPeekHeight;

  // 펼친 높이: 지도 영역(부모)과 화면 높이가 바뀔 때마다 다시 잰다
  useLayoutEffect(() => {
    const area = sheetRef.current?.parentElement;
    if (!area) return;
    const measure = () =>
      setOpenH(
        Math.round(
          Math.min(
            area.clientHeight * OPEN_AREA_RATIO,
            window.innerHeight * OPEN_VIEWPORT_RATIO,
          ),
        ),
      );
    measure();
    const ro =
      typeof ResizeObserver === "undefined" ? null : new ResizeObserver(measure);
    ro?.observe(area);
    window.addEventListener("resize", measure);
    return () => {
      ro?.disconnect();
      window.removeEventListener("resize", measure);
    };
  }, []);

  // 접힌 높이: 손잡이 + peek의 실제 높이. 펼친 동안은 peek가 숨으므로 재지 않는다
  useLayoutEffect(() => {
    const head = headRef.current;
    if (!head) return;
    const measure = () => {
      if (openRef.current) return;
      const h = Math.round(head.getBoundingClientRect().height);
      if (h > 0) setPeekH(h);
    };
    measure();
    const ro =
      typeof ResizeObserver === "undefined" ? null : new ResizeObserver(measure);
    ro?.observe(head);
    return () => ro?.disconnect();
  }, [open]);

  useEffect(() => {
    if (peekH > 0) peekCb.current(peekH);
  }, [peekH]);

  // 접힌 동안 본문은 읽히지도 포커스되지도 않게(inert). 끄는 중에는 보이기만 한다
  useEffect(() => {
    const body = bodyRef.current;
    if (!body) return;
    if (open) body.removeAttribute("inert");
    else body.setAttribute("inert", "");
  }, [open]);

  const height = Math.max(openH, peekH);
  const range = Math.max(0, height - peekH);
  const restY = open ? 0 : range;
  const y = dragY ?? restY;

  const endDrag = (e: ReactPointerEvent<HTMLButtonElement>) => {
    const d = drag.current;
    drag.current = null;
    if (e.currentTarget.hasPointerCapture?.(e.pointerId)) {
      e.currentTarget.releasePointerCapture(e.pointerId);
    }
    return d;
  };

  const onPointerDown = (e: ReactPointerEvent<HTMLButtonElement>) => {
    if (e.button !== 0) return;
    // 이전 끌기가 끝 소식 없이 남아 있어도(capture를 잃음) 새 누르기를 막지 않는다
    const stale = drag.current;
    if (stale && e.currentTarget.hasPointerCapture?.(stale.pointerId)) return;
    suppressClick.current = false;
    drag.current = {
      pointerId: e.pointerId,
      startX: e.clientX,
      startY: e.clientY,
      vertical: null,
      samples: [{ t: e.timeStamp, y: e.clientY }],
    };
    e.currentTarget.setPointerCapture?.(e.pointerId);
  };

  const onPointerMove = (e: ReactPointerEvent<HTMLButtonElement>) => {
    const d = drag.current;
    if (!d || d.pointerId !== e.pointerId) return;
    const dx = e.clientX - d.startX;
    const dy = e.clientY - d.startY;
    if (d.vertical === null) {
      if (Math.max(Math.abs(dx), Math.abs(dy)) < DRAG_DECIDE_PX) return;
      d.vertical = Math.abs(dy) >= Math.abs(dx);
      if (!d.vertical) {
        // 가로 쓸기(뒤로가기 등)는 가로채지 않는다
        suppressClick.current = true;
        endDrag(e);
        return;
      }
    }
    d.samples.push({ t: e.timeStamp, y: e.clientY });
    const cutoff = e.timeStamp - VELOCITY_WINDOW_MS * 2;
    while (d.samples.length > 2 && d.samples[0].t < cutoff) d.samples.shift();
    const base = openRef.current ? 0 : range;
    // 접힌 시트는 아래로도 조금 따라 내려간다(더 줄일 수 있을 때)
    const pull =
      onCollapse && !openRef.current && !collapsed ? COLLAPSE_PULL_PX : 0;
    setDragY(Math.min(range + pull, Math.max(0, base + dy)));
  };

  const onPointerUp = (e: ReactPointerEvent<HTMLButtonElement>) => {
    const d = drag.current;
    if (!d || d.pointerId !== e.pointerId) return;
    endDrag(e);
    setDragY(null);
    const dy = e.clientY - d.startY;
    // 8px 미만은 누르기 — 뒤따르는 click이 토글한다(키보드 Enter/Space와 같은 길)
    if (d.vertical !== true || Math.abs(dy) < SHEET_TAP_PX) return;
    suppressClick.current = true;
    d.samples.push({ t: e.timeStamp, y: e.clientY });
    const last = d.samples[d.samples.length - 1];
    const first =
      d.samples.find((s) => s.t >= last.t - VELOCITY_WINDOW_MS) ?? last;
    const dt = last.t - first.t;
    const vy = dt > 0 ? (last.y - first.y) / dt : 0;
    const was = openRef.current;
    if (onCollapse && !was) {
      // 접힌 시트: 아래로 끌면 요약만, 요약 상태에서 위로 끌면 다시 접힌 상태로
      if (!collapsed && dy > COLLAPSE_DRAG_PX) {
        onCollapse(true);
        return;
      }
      if (collapsed && dy < 0) {
        onCollapse(false);
        return;
      }
    }
    const next = sheetSnap({ open: was, dy, vy, range });
    if (next !== was) onToggle(next, "drag");
  };

  const onPointerCancel = (e: ReactPointerEvent<HTMLButtonElement>) => {
    const d = drag.current;
    if (!d || d.pointerId !== e.pointerId) return;
    endDrag(e);
    setDragY(null);
  };

  /** capture를 pointerup/cancel 없이 잃었을 때도 끌기를 끝낸다(다음 끌기가 막히지 않게) */
  const onLostPointerCapture = (e: ReactPointerEvent<HTMLButtonElement>) => {
    const d = drag.current;
    if (!d || d.pointerId !== e.pointerId) return;
    drag.current = null;
    setDragY(null);
  };

  const onClick = (e: ReactMouseEvent<HTMLButtonElement>) => {
    // 키보드(Enter/Space)로 온 click(detail 0)은 언제나 토글한다
    const suppressed = suppressClick.current && e.detail !== 0;
    suppressClick.current = false;
    if (suppressed) return;
    // 요약만 남긴 상태에서 누르면 먼저 접힌 상태로 돌아온다
    if (!open && collapsed && onCollapse) {
      onCollapse(false);
      return;
    }
    onToggle(!open, "handle");
  };

  const dragging = dragY !== null;

  return (
    <section
      ref={sheetRef}
      className={`nearby-sheet${dragging ? " nearby-sheet--dragging" : ""}`}
      aria-label={label}
      style={{
        height: height || undefined,
        transform: `translate3d(0, ${y}px, 0)`,
        visibility: height > 0 ? undefined : "hidden",
      }}
    >
      <div ref={headRef} className="nearby-sheet__head">
        <button
          ref={handleRef}
          type="button"
          className="nearby-sheet__handle"
          aria-expanded={open}
          aria-controls={bodyId}
          aria-label={
            open ? "목록 접기" : collapsed ? "요약 펼치기" : "목록 펼치기"
          }
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={onPointerCancel}
          onLostPointerCapture={onLostPointerCapture}
          onClick={onClick}
        >
          <span className="nearby-sheet__bar" aria-hidden="true" />
        </button>
        <div className="nearby-sheet__peek" hidden={open}>
          {peek}
        </div>
      </div>
      <div
        ref={bodyRef}
        id={bodyId}
        className={`nearby-sheet__body${
          !open && !dragging ? " nearby-sheet__body--hidden" : ""
        }`}
        aria-hidden={!open}
      >
        {children}
      </div>
    </section>
  );
}
