import { useEffect, useRef, useState } from 'react';

/**
 * Track an element's pixel size.
 *
 * The views render SVG at real pixel dimensions rather than scaling a fixed
 * viewBox, so 1px hairlines and 2px strokes stay exactly that at any container
 * size instead of being stretched by `preserveAspectRatio`.
 */
export function useMeasure<T extends HTMLElement>() {
  const ref = useRef<T | null>(null);
  const [size, setSize] = useState({ width: 0, height: 0 });

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => {
      for (const e of entries) {
        setSize({ width: e.contentRect.width, height: e.contentRect.height });
      }
    });
    ro.observe(el);
    const box = el.getBoundingClientRect();
    setSize({ width: box.width, height: box.height });
    return () => ro.disconnect();
  }, []);

  return { ref, ...size };
}
