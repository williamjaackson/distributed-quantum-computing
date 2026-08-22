/**
 * Transport for the timeline: where we are, and whether we are moving.
 *
 * Playback advances on a timer rather than per animation frame — a step is a
 * discrete event, and the thing being watched is which gate just ran, not a
 * tween between two states. The timer is rebuilt whenever the speed changes so
 * a speed change takes effect immediately instead of after the current tick.
 */
import { useCallback, useEffect, useRef, useState } from 'react';

/** Milliseconds per step at 1x. Slow enough to read the step description. */
export const BASE_INTERVAL_MS = 700;

export const SPEEDS = [0.25, 0.5, 1, 2, 4, 8];

export function usePlayer(length: number) {
  const [index, setIndex] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState(1);
  const last = Math.max(0, length - 1);
  const lastRef = useRef(last);
  lastRef.current = last;

  // A new timeline must not leave the playhead past its end — and if it was
  // *at* the end, it should stay there. Dragging an input re-runs the program,
  // and watching the final answer change as you drag is the point of the slider.
  const previousLast = useRef(last);
  useEffect(() => {
    const wasAtEnd = index >= previousLast.current;
    previousLast.current = Math.max(0, length - 1);
    setIndex((i) => (wasAtEnd ? previousLast.current : Math.min(i, previousLast.current)));
    // Only the timeline's length is a trigger; `index` is read, not depended on.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [length]);

  useEffect(() => {
    if (!playing) return;
    const id = window.setInterval(() => {
      setIndex((i) => {
        if (i >= lastRef.current) {
          setPlaying(false);
          return lastRef.current;
        }
        return i + 1;
      });
    }, BASE_INTERVAL_MS / speed);
    return () => window.clearInterval(id);
  }, [playing, speed]);

  const seek = useCallback((i: number) => {
    setIndex(Math.max(0, Math.min(lastRef.current, Math.round(i))));
  }, []);

  const step = useCallback(
    (delta: number) => {
      setPlaying(false);
      setIndex((i) => Math.max(0, Math.min(lastRef.current, i + delta)));
    },
    [],
  );

  const toStart = useCallback(() => {
    setPlaying(false);
    setIndex(0);
  }, []);

  const toEnd = useCallback(() => {
    setPlaying(false);
    setIndex(lastRef.current);
  }, []);

  const toggle = useCallback(() => {
    setPlaying((p) => {
      // Pressing play at the end restarts, rather than doing nothing.
      if (!p && index >= lastRef.current) setIndex(0);
      return !p;
    });
  }, [index]);

  const reset = useCallback(() => {
    setPlaying(false);
    setIndex(0);
  }, []);

  return {
    index,
    playing,
    speed,
    last,
    setSpeed,
    seek,
    step,
    toStart,
    toEnd,
    toggle,
    reset,
    atStart: index === 0,
    atEnd: index >= last,
  };
}
