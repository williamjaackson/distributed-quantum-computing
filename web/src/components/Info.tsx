/**
 * A small ⓘ that keeps an explanation off the screen until it is wanted.
 *
 * Every one of these replaces a line of prose that used to sit permanently in
 * the layout. The rule for what belongs behind one: if it explains, it hides;
 * if it is a *fact about what you are looking at* — a count, a percentage, a
 * caveat about what has been truncated — it stays visible, because hiding those
 * would be hiding the data.
 *
 * A button rather than a hover target, so it works from the keyboard and on
 * touch. Hover and focus reveal; click pins it, for reading something longer
 * without keeping the pointer still.
 */
import { useEffect, useRef, useState } from 'react';

interface Props {
  /** What to say. Prose, not a value. */
  children: string;
  /** Names the thing being explained, for screen readers. */
  about: string;
}

export function Info({ children, about }: Props) {
  const [open, setOpen] = useState(false);
  const [pinned, setPinned] = useState(false);
  const ref = useRef<HTMLButtonElement>(null);
  const [at, setAt] = useState({ x: 0, y: 0 });

  function place() {
    const box = ref.current?.getBoundingClientRect();
    if (box) setAt({ x: box.left + box.width / 2, y: box.top });
  }

  // A pinned tip should not survive scrolling away from what it points at.
  useEffect(() => {
    if (!pinned) return;
    const close = () => {
      setPinned(false);
      setOpen(false);
    };
    window.addEventListener('scroll', close, true);
    return () => window.removeEventListener('scroll', close, true);
  }, [pinned]);

  const show = open || pinned;
  return (
    <>
      <button
        ref={ref}
        type="button"
        className={`info${show ? ' is-open' : ''}`}
        aria-label={`About ${about}`}
        aria-expanded={show}
        onMouseEnter={() => {
          place();
          setOpen(true);
        }}
        onMouseLeave={() => setOpen(false)}
        onFocus={() => {
          place();
          setOpen(true);
        }}
        onBlur={() => {
          setOpen(false);
          setPinned(false);
        }}
        onClick={() => {
          place();
          setPinned((p) => !p);
        }}
      >
        i
      </button>
      {show && (
        <div className="tip tip-prose" style={{ left: at.x, top: at.y }} role="tooltip">
          {children}
        </div>
      )}
    </>
  );
}
