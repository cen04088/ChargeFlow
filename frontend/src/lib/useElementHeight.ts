import { useLayoutEffect, useState } from "react";

/**
 * 요소의 높이(px)를 ResizeObserver로 따라간다. 콜백 ref로 붙이므로
 * 조건부로 나타났다 사라지는 요소도 된다(없으면 0).
 */
export function useElementHeight<T extends HTMLElement>(): [
  (el: T | null) => void,
  number,
] {
  const [el, setEl] = useState<T | null>(null);
  const [height, setHeight] = useState(0);

  useLayoutEffect(() => {
    if (!el) return;
    const measure = () => setHeight(Math.round(el.getBoundingClientRect().height));
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [el]);

  return [setEl, el ? height : 0];
}
