import { useEffect, useRef, useState } from 'react';

/**
 * Track an element's pixel width.
 *
 * Charts render SVG at real pixel dimensions rather than scaling a fixed
 * viewBox, so that 1px hairlines and 2px strokes stay exactly that at any
 * container width instead of being stretched by preserveAspectRatio.
 */
export function useMeasure<T extends HTMLElement>() {
  const ref = useRef<T | null>(null);
  const [width, setWidth] = useState(0);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => {
      for (const e of entries) setWidth(e.contentRect.width);
    });
    ro.observe(el);
    setWidth(el.getBoundingClientRect().width);
    return () => ro.disconnect();
  }, []);

  return { ref, width };
}
