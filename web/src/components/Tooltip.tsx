import { useState, type ReactNode } from 'react';

/**
 * Hover tooltips, in two shapes.
 *
 * Every chart here is interactive by default, and a mark small enough to be
 * drawn thin is too small to label directly — so the exact numbers live in a
 * tooltip (and in the table view beside it). Positioned against the viewport in
 * `position: fixed` so it never gets clipped by a scrolling stage.
 *
 * The two shapes exist because the content is two different things. A mark's
 * tooltip is an aligned block of numbers, so it stays monospaced with its line
 * breaks intact. Prose wraps in the UI face and has its whitespace collapsed
 * first, so a line break in the source string does not become one on screen.
 */
interface Tip {
  x: number;
  y: number;
  text: string;
  prose: boolean;
}

export function useTip() {
  const [tip, setTip] = useState<Tip | null>(null);

  function bind(raw: string, prose = false) {
    const text = prose ? raw.replace(/\s+/g, ' ').trim() : raw;
    const at = (e: { clientX: number; clientY: number }) =>
      setTip({ x: e.clientX, y: e.clientY, text, prose });
    return {
      onMouseEnter: at,
      onMouseMove: at,
      onMouseLeave: () => setTip(null),
    };
  }

  const node: ReactNode = tip ? (
    <div
      className={`tip${tip.prose ? ' tip-prose' : ''}`}
      style={{ left: tip.x, top: tip.y }}
      role="tooltip"
    >
      {tip.text}
    </div>
  ) : null;

  return { bind, node };
}
