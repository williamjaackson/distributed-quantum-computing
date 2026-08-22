import { useState, type ReactNode } from 'react';

/**
 * Hover tooltips for SVG marks.
 *
 * Every chart here is interactive by default, and a mark small enough to be
 * drawn thin is too small to label directly — so the exact numbers live in a
 * tooltip (and in the table view beside it). Positioned against the viewport in
 * `position: fixed` so it never gets clipped by a scrolling stage.
 */
export function useTip() {
  const [tip, setTip] = useState<{ x: number; y: number; text: string } | null>(null);

  function bind(text: string) {
    return {
      onMouseEnter: (e: { clientX: number; clientY: number }) =>
        setTip({ x: e.clientX, y: e.clientY, text }),
      onMouseMove: (e: { clientX: number; clientY: number }) =>
        setTip({ x: e.clientX, y: e.clientY, text }),
      onMouseLeave: () => setTip(null),
    };
  }

  const node: ReactNode = tip ? (
    <div className="tip" style={{ left: tip.x, top: tip.y }}>
      {tip.text}
    </div>
  ) : null;

  return { bind, node };
}
