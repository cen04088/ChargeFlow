import type { ReactNode } from "react";

export type Mode = "nearby" | "highway";

const LABEL: Record<Mode, string> = {
  nearby: "주변 충전소",
  highway: "고속도로",
};

function ModeIcon({ mode }: { mode: Mode }) {
  if (mode === "nearby")
    return (
      <svg width="20" height="20" viewBox="0 0 20 20" fill="none" aria-hidden="true">
        <path
          d="M10 17.5s5.5-4.9 5.5-9.2a5.5 5.5 0 0 0-11 0c0 4.3 5.5 9.2 5.5 9.2Z"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinejoin="round"
        />
        <circle cx="10" cy="8.3" r="1.8" fill="currentColor" />
      </svg>
    );
  return (
    <svg width="20" height="20" viewBox="0 0 20 20" fill="none" aria-hidden="true">
      <path d="M6.5 3 3.5 17M13.5 3l3 14" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
      <path d="M10 3.5v2.5M10 8.75v2.5M10 14v2.5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
    </svg>
  );
}

/** 탭 안에 들어가는 아이콘 + 이름. 다른 화면으로 가는 링크의 내용으로도 쓴다 */
export function ModeTabLabel({ mode }: { mode: Mode }) {
  return (
    <>
      <ModeIcon mode={mode} />
      {LABEL[mode]}
    </>
  );
}

/**
 * 화면 맨 위의 두 칸 탭(주변 충전소 | 고속도로). 홈과 고속도로 화면에서 같은 자리에 둔다.
 * 지금 화면 쪽은 채워서 보여 주고, 다른 쪽은 화면마다 뒤로가기 처리가 달라 링크를 받아서 그린다
 * (링크에는 className="mode-tab press"를 준다).
 */
export function ModeTabs({ current, other }: { current: Mode; other: ReactNode }) {
  const here = (
    <span className="mode-tab mode-tab--on" aria-current="page">
      <ModeTabLabel mode={current} />
    </span>
  );
  return (
    <nav className="mode-tabs" aria-label="화면 바꾸기">
      {current === "nearby" ? here : other}
      {current === "nearby" ? other : here}
    </nav>
  );
}
