/**
 * The stage: one view by default, or several of them tiled.
 *
 * A view used to be a tab — one projection at a time, on the grounds that they
 * compete rather than combine. That holds for *reading* one and not for
 * *explaining* one: the sentence "the cost layer writes the shortfall into the
 * phase and the bars do not move" is one claim about two pictures, and made
 * against a single pane it is a claim about a picture that is not on screen any
 * more. So the stage tiles, and the layout is the reader's:
 *
 * - click a tab and you get that view, alone — the old behaviour, and still the
 *   default, because one pane is the right number for looking at one thing
 * - drag a tab into the stage and it opens where the marker was: down the
 *   middle of a pane to sit beside it, near a top or bottom edge to sit above
 *   or below it. Shift-click does the same without the drag
 * - drag a pane by its title to move it, drag a divider to reweight, and close
 *   a pane with the ✕ that appears once there is more than one
 * - − and + scale what is *inside* a pane, independently of the pane's size.
 *   Not the same control as the divider: a narrower pane is less room, while a
 *   smaller scale is more room in the same space — which is what a Bloch sphere
 *   per qubit, or a 278-gate circuit, actually needs
 *
 * The model is rows of panes rather than a general split tree. Rows of panes
 * covers every arrangement anyone actually asks for — two side by side, two
 * stacked, a wide one over a pair — in a shape you can read off the state,
 * where a tree needs a recursion to answer "what is next to what".
 *
 * Nothing here knows what a view draws. Panes are view ids and weights; the
 * caller renders the body.
 */
import { Fragment, useCallback, useRef, useState } from 'react';
import type { CSSProperties, DragEvent, KeyboardEvent, PointerEvent, ReactNode } from 'react';
import { VIEWS, viewById } from '../views';
import type { ViewDef } from '../views/types';
import { Info } from './Info';

/**
 * The narrowest and shortest a divider will squeeze a pane. Small on purpose:
 * a floor set to the width a view wants leaves so little travel between two
 * panes that the divider reads as snapping between two positions rather than
 * moving, and a squeezed view scrolls — it does not break. This is only here so
 * a pane cannot be reduced to a sliver you can no longer grab.
 *
 * In pixels rather than as a share of the stage, because a share that leaves a
 * usable pane on a monitor leaves a sliver on a laptop.
 */
const MIN_PANE = 140;
const MIN_ROW = 120;
/** How much one arrow key moves a divider, as a share of the extent. */
const NUDGE = 0.02;
/**
 * The scales − and + step through. A ladder rather than a factor per press, so
 * the readout is a round number and two panes set to "80%" are the same size.
 */
const SCALES = [0.5, 0.6, 0.7, 0.8, 0.9, 1, 1.1, 1.25, 1.4, 1.6, 1.8, 2];
/**
 * How close to a row's top or bottom edge a drop has to be to mean "stack this"
 * rather than "put it alongside". A share of the row, so the bands scale with a
 * split stage, and capped so a full-height row keeps most of itself for the
 * side-by-side case.
 */
const EDGE_BAND = 0.28;
const EDGE_BAND_MAX = 90;

interface Pane {
  /** A view id. Unique across the whole layout — the same view twice is two
   *  copies of one picture, which is not a comparison. */
  id: string;
  /** Flex weight within its row. Relative, so only the ratios matter. */
  w: number;
  /** How large the view draws inside the pane. One of `SCALES`. */
  z: number;
}

interface Row {
  /** Stable across moves, so React does not remount a row that only changed
   *  weight and a view does not lose its scroll position. */
  key: number;
  panes: Pane[];
  /** Flex weight among the rows. */
  h: number;
}

/** Where a drop would put a pane. */
type Target = { kind: 'col'; row: number; col: number } | { kind: 'row'; at: number };

interface Layout {
  rows: Row[];
}

export interface StageLayout {
  rows: Row[];
  /** Collapse to a single pane showing `id`. */
  showOnly: (id: string) => void;
  /**
   * The program's own suggestion. Honoured only while one pane is open: a
   * reader who has arranged three of them did that on purpose, and having the
   * program tear it down on every change of subject is worse than not
   * suggesting anything.
   */
  suggest: (id: string) => void;
  /** Open `id` alongside, or close it if it is open and not the last one. */
  toggle: (id: string) => void;
  /** Open or move `id` to `target`. */
  place: (id: string, target: Target) => void;
  close: (row: number, col: number) => void;
  /** Step the pane's scale along `SCALES`, or back to 1 when `by` is 0. */
  scale: (row: number, col: number, by: number) => void;
  setWidths: (row: number, widths: number[]) => void;
  setHeights: (heights: number[]) => void;
}

let nextRowKey = 1;

function row(panes: Pane[], h = 1): Row {
  return { key: nextRowKey++, panes, h };
}

function single(id: string): Layout {
  return { rows: [row([{ id, w: 1, z: 1 }])] };
}

function mean(values: number[]): number {
  return values.length > 0 ? values.reduce((a, b) => a + b, 0) / values.length : 1;
}

function paneCount(rows: Row[]): number {
  return rows.reduce((n, r) => n + r.panes.length, 0);
}

/** Ids in reading order, for telling one arrangement from another. */
function shape(rows: Row[]): string {
  return rows.map((r) => r.panes.map((p) => p.id).join(',')).join('/');
}

/**
 * Open `id` at `target`, moving it if it is already open.
 *
 * Written as insert-then-remove around a marker object rather than as index
 * arithmetic: a target index refers to the layout *before* the pane left its old
 * slot, and every off-by-one in a drag-and-drop reorder lives in the gap between
 * those two.
 */
function place(layout: Layout, id: string, target: Target): Layout {
  const rows = layout.rows.map((r) => ({ ...r, panes: [...r.panes] }));
  const open = rows.flatMap((r) => r.panes).find((p) => p.id === id);
  const mark: Pane = {
    id,
    // A pane keeps its weight when it moves, and a new one arrives at the
    // average of its new neighbours, so opening one never singles out a
    // neighbour to pay for it.
    w: open?.w ?? (target.kind === 'col' ? mean(rows[target.row].panes.map((p) => p.w)) : 1),
    // The scale belongs to the view, not the slot — moving a pane is not a
    // reason to undo how it was set up.
    z: open?.z ?? 1,
  };

  if (target.kind === 'col') rows[target.row].panes.splice(target.col, 0, mark);
  else rows.splice(target.at, 0, row([mark], mean(layout.rows.map((r) => r.h))));

  for (const r of rows) {
    const i = r.panes.findIndex((p) => p !== mark && p.id === id);
    if (i !== -1) {
      r.panes.splice(i, 1);
      break;
    }
  }

  const kept = rows.filter((r) => r.panes.length > 0);
  return shape(kept) === shape(layout.rows) ? layout : { rows: kept };
}

function without(layout: Layout, r: number, c: number): Layout {
  if (paneCount(layout.rows) === 1) return layout;
  const rows = layout.rows.map((x, i) =>
    i === r ? { ...x, panes: x.panes.filter((_, j) => j !== c) } : x,
  );
  return { rows: rows.filter((x) => x.panes.length > 0) };
}

export function useStageLayout(initial: string): StageLayout {
  const [state, setState] = useState<Layout>(() => single(initial));

  const showOnly = useCallback((id: string) => setState(single(id)), []);
  const suggest = useCallback(
    (id: string) => setState((s) => (paneCount(s.rows) === 1 ? single(id) : s)),
    [],
  );
  const placeAt = useCallback(
    (id: string, target: Target) => setState((s) => place(s, id, target)),
    [],
  );
  const close = useCallback((r: number, c: number) => setState((s) => without(s, r, c)), []);
  const toggle = useCallback(
    (id: string) =>
      setState((s) => {
        for (let r = 0; r < s.rows.length; r++) {
          const c = s.rows[r].panes.findIndex((p) => p.id === id);
          if (c !== -1) return without(s, r, c);
        }
        const last = s.rows.length - 1;
        return place(s, id, { kind: 'col', row: last, col: s.rows[last].panes.length });
      }),
    [],
  );
  const setWidths = useCallback(
    (r: number, widths: number[]) =>
      setState((s) => ({
        rows: s.rows.map((x, i) =>
          i === r ? { ...x, panes: x.panes.map((p, j) => ({ ...p, w: widths[j] })) } : x,
        ),
      })),
    [],
  );
  const scale = useCallback(
    (r: number, c: number, by: number) =>
      setState((s) => ({
        rows: s.rows.map((x, i) =>
          i === r
            ? {
                ...x,
                panes: x.panes.map((p, j) => {
                  if (j !== c) return p;
                  if (by === 0) return { ...p, z: 1 };
                  const at = SCALES.indexOf(p.z);
                  const next = SCALES[Math.min(Math.max((at === -1 ? 5 : at) + by, 0), SCALES.length - 1)];
                  return { ...p, z: next };
                }),
              }
            : x,
        ),
      })),
    [],
  );
  const setHeights = useCallback(
    (heights: number[]) =>
      setState((s) => ({ rows: s.rows.map((x, i) => ({ ...x, h: heights[i] })) })),
    [],
  );

  return {
    rows: state.rows,
    showOnly,
    suggest,
    toggle,
    place: placeAt,
    close,
    scale,
    setWidths,
    setHeights,
  };
}

type Drag = { kind: 'view'; id: string } | { kind: 'pane'; id: string };

/**
 * Where a drop at these coordinates would land.
 *
 * Measured against the panes and rows themselves rather than the containers'
 * children, because the drop marker is one of those children and a target that
 * moved as the marker appeared would never settle.
 */
function targetAt(container: HTMLElement | null, x: number, y: number): Target | null {
  const rows = Array.from(container?.querySelectorAll<HTMLElement>('[data-row]') ?? []);
  if (rows.length === 0) return null;
  let r = rows.findIndex((el) => y < el.getBoundingClientRect().bottom);
  if (r === -1) r = rows.length - 1;

  const box = rows[r].getBoundingClientRect();
  const band = Math.min(box.height * EDGE_BAND, EDGE_BAND_MAX);
  if (y < box.top + band) return { kind: 'row', at: r };
  if (y > box.bottom - band) return { kind: 'row', at: r + 1 };

  const panes = Array.from(rows[r].querySelectorAll<HTMLElement>('[data-pane]'));
  for (let c = 0; c < panes.length; c++) {
    const p = panes[c].getBoundingClientRect();
    if (x < p.left + p.width / 2) return { kind: 'col', row: r, col: c };
  }
  return { kind: 'col', row: r, col: panes.length };
}

function sameTarget(a: Target | null, b: Target | null): boolean {
  if (!a || !b || a.kind !== b.kind) return a === b;
  return a.kind === 'row' && b.kind === 'row'
    ? a.at === b.at
    : a.kind === 'col' && b.kind === 'col' && a.row === b.row && a.col === b.col;
}

/**
 * Move the boundary between `i` and `i + 1` by `shiftPx` pixels.
 *
 * The weights are relative and the drag is in pixels, so everything crosses
 * through `perPx` — including the floor. Skipping that conversion is what makes
 * a divider snap: a pixel added straight onto a weight of 1 saturates the whole
 * range in three pixels of travel.
 *
 * Halves the pair rather than refusing when it cannot hold two panes at the
 * floor: at that size the reader has asked for more panes than fit, and a dead
 * divider is a worse answer than an even split.
 */
function reweighted(weights: number[], i: number, shiftPx: number, extent: number, minPx: number) {
  if (extent <= 0) return weights;
  const total = weights.reduce((a, b) => a + b, 0);
  const perPx = total / extent;
  const pair = weights[i] + weights[i + 1];
  const floor = Math.min(minPx * perPx, pair / 2);
  const a = Math.min(Math.max(weights[i] + shiftPx * perPx, floor), pair - floor);
  const next = [...weights];
  next[i] = a;
  next[i + 1] = pair - a;
  return next;
}

export function ViewStage({
  layout,
  program,
  badge,
  children,
}: {
  layout: StageLayout;
  /** For the suggested-view marker on the tabs. */
  program: { name: string; suggestedView?: string };
  /** One fact about the whole run, not about a projection of it. */
  badge?: ReactNode;
  /** Renders one pane's body. */
  children: (view: ViewDef) => ReactNode;
}) {
  const { rows } = layout;
  const split = useRef<HTMLDivElement | null>(null);
  const drag = useRef<Drag | null>(null);
  const [drop, setDrop] = useState<Target | null>(null);
  const multi = paneCount(rows) > 1;
  const open = new Set(rows.flatMap((r) => r.panes.map((p) => p.id)));

  const endDrag = useCallback(() => {
    drag.current = null;
    setDrop(null);
  }, []);

  const startDrag = (e: DragEvent, payload: Drag) => {
    drag.current = payload;
    e.dataTransfer.effectAllowed = 'copyMove';
    // Firefox will not start a drag without payload, and a view id is the
    // honest thing to carry.
    e.dataTransfer.setData('text/plain', payload.id);
  };

  const onDragOver = (e: DragEvent<HTMLDivElement>) => {
    if (!drag.current) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = drag.current.kind === 'pane' ? 'move' : 'copy';
    const next = targetAt(split.current, e.clientX, e.clientY);
    setDrop((prev) => (sameTarget(prev, next) ? prev : next));
  };

  const onDrop = (e: DragEvent<HTMLDivElement>) => {
    const payload = drag.current;
    if (!payload) return;
    e.preventDefault();
    const target = targetAt(split.current, e.clientX, e.clientY);
    endDrag();
    if (target) layout.place(payload.id, target);
  };

  /** Drag a divider: widths within row `r`, or the row heights when `r` is null. */
  const startResize = (e: PointerEvent<HTMLDivElement>, r: number | null, i: number) => {
    const container = r === null ? split.current : split.current?.querySelector(`[data-row="${r}"]`);
    if (!container) return;
    const handle = e.currentTarget;
    const box = container.getBoundingClientRect();
    const extent = r === null ? box.height : box.width;
    if (extent <= 0) return;
    const from = r === null ? e.clientY : e.clientX;
    const base = r === null ? rows.map((x) => x.h) : rows[r].panes.map((p) => p.w);
    const min = r === null ? MIN_ROW : MIN_PANE;
    const apply = (to: number) => {
      const next = reweighted(base, i, to - from, extent, min);
      if (r === null) layout.setHeights(next);
      else layout.setWidths(r, next);
    };
    handle.setPointerCapture(e.pointerId);
    const onMove = (ev: globalThis.PointerEvent) => apply(r === null ? ev.clientY : ev.clientX);
    const onUp = () => {
      handle.removeEventListener('pointermove', onMove);
      handle.removeEventListener('pointerup', onUp);
      handle.removeEventListener('pointercancel', onUp);
    };
    handle.addEventListener('pointermove', onMove);
    handle.addEventListener('pointerup', onUp);
    handle.addEventListener('pointercancel', onUp);
  };

  const onDividerKey = (e: KeyboardEvent<HTMLDivElement>, r: number | null, i: number) => {
    const [less, more] = r === null ? ['ArrowUp', 'ArrowDown'] : ['ArrowLeft', 'ArrowRight'];
    const dir = e.key === less ? -1 : e.key === more ? 1 : 0;
    if (!dir) return;
    e.preventDefault();
    const container = r === null ? split.current : split.current?.querySelector(`[data-row="${r}"]`);
    const box = container?.getBoundingClientRect();
    const extent = (r === null ? box?.height : box?.width) ?? 0;
    const base = r === null ? rows.map((x) => x.h) : rows[r].panes.map((p) => p.w);
    const next = reweighted(base, i, dir * NUDGE * extent, extent, r === null ? MIN_ROW : MIN_PANE);
    if (r === null) layout.setHeights(next);
    else layout.setWidths(r, next);
  };

  return (
    <>
      <div className="tabs">
        {VIEWS.map((v) => {
          const shown = open.has(v.id);
          const suggested = program.suggestedView === v.id;
          return (
            <button
              key={v.id}
              className={`tab${suggested ? ' tab-suggested' : ''}`}
              aria-pressed={shown}
              draggable
              onDragStart={(e) => startDrag(e, { kind: 'view', id: v.id })}
              onDragEnd={endDrag}
              onClick={(e) =>
                e.shiftKey || e.metaKey || e.ctrlKey ? layout.toggle(v.id) : layout.showOnly(v.id)
              }
              title={[
                suggested ? `${v.subtitle} — the best angle on ${program.name}` : v.subtitle,
                shown && multi
                  ? 'shift-click to close it'
                  : 'drag in — beside a pane, or above or below it. shift-click to open it alongside',
              ].join('\n')}
            >
              {v.name}
            </button>
          );
        })}
        {!multi && <span className="tabs-hint">drag a tab in to compare</span>}
        {badge}
      </div>

      <div
        className="stage-split"
        ref={split}
        onDragOver={onDragOver}
        onDragLeave={(e) => {
          // Only when the pointer has actually left the stage — moving between
          // two panes fires a leave for the one behind.
          if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDrop(null);
        }}
        onDrop={onDrop}
      >
        {rows.map((r, ri) => (
          <Fragment key={r.key}>
            {drop?.kind === 'row' && drop.at === ri && <div className="pane-drop-row" aria-hidden />}
            {ri > 0 && (
              <div
                className="row-divider"
                role="separator"
                aria-orientation="horizontal"
                aria-label="Resize the rows above and below"
                tabIndex={0}
                onPointerDown={(e) => startResize(e, null, ri - 1)}
                onKeyDown={(e) => onDividerKey(e, null, ri - 1)}
              />
            )}
            <div className="stage-row" data-row={ri} style={{ flex: r.h }}>
              {r.panes.map((pane, ci) => {
                const view = viewById(pane.id);
                return (
                  <Fragment key={pane.id}>
                    {drop?.kind === 'col' && drop.row === ri && drop.col === ci && (
                      <div className="pane-drop" aria-hidden />
                    )}
                    {ci > 0 && (
                      <div
                        className="pane-divider"
                        role="separator"
                        aria-orientation="vertical"
                        aria-label={`Resize the ${viewById(r.panes[ci - 1].id).name} and ${view.name} views`}
                        tabIndex={0}
                        onPointerDown={(e) => startResize(e, ri, ci - 1)}
                        onKeyDown={(e) => onDividerKey(e, ri, ci - 1)}
                      />
                    )}
                    <section className="stage" data-pane={`${ri}.${ci}`} style={{ flex: pane.w }}>
                      <div
                        className="stage-head"
                        draggable={multi}
                        onDragStart={(e) => startDrag(e, { kind: 'pane', id: pane.id })}
                        onDragEnd={endDrag}
                      >
                        <h2>{view.name}</h2>
                        {/* The subtitle is the first thing to go once panes share
                            the width: it is the sentence the ⓘ opens with. */}
                        {!multi && <p>{view.subtitle}</p>}
                        <Info about={`the ${view.name.toLowerCase()} view`}>{view.about}</Info>
                        <span className="pane-zoom">
                          <button
                            type="button"
                            aria-label={`Draw the ${view.name} view smaller`}
                            title="draw it smaller — more of it in the same space"
                            disabled={pane.z === SCALES[0]}
                            onClick={() => layout.scale(ri, ci, -1)}
                          >
                            −
                          </button>
                          {/* Only when it is not 1: a readout that always says
                              "100%" is a number nobody reads. */}
                          {pane.z !== 1 && (
                            <button
                              type="button"
                              className="pane-zoom-value"
                              title="back to full size"
                              onClick={() => layout.scale(ri, ci, 0)}
                            >
                              {Math.round(pane.z * 100)}%
                            </button>
                          )}
                          <button
                            type="button"
                            aria-label={`Draw the ${view.name} view larger`}
                            title="draw it larger"
                            disabled={pane.z === SCALES[SCALES.length - 1]}
                            onClick={() => layout.scale(ri, ci, 1)}
                          >
                            +
                          </button>
                        </span>
                        {multi && (
                          <button
                            type="button"
                            className="pane-close"
                            aria-label={`Close the ${view.name} view`}
                            title="close this pane"
                            onClick={() => layout.close(ri, ci)}
                          >
                            ×
                          </button>
                        )}
                      </div>
                      {/* The scale is CSS `zoom` rather than a transform, so the
                          view still measures a real box and lays itself out for
                          it — a smaller scale is more room, not the same picture
                          shrunk. `--pane-zoom` is read back by `.tip`, which is
                          positioned against the viewport and has to undo it. */}
                      <div
                        className="stage-body"
                        style={{ '--pane-zoom': pane.z } as CSSProperties}
                      >
                        {children(view)}
                      </div>
                    </section>
                  </Fragment>
                );
              })}
              {drop?.kind === 'col' && drop.row === ri && drop.col === r.panes.length && (
                <div className="pane-drop" aria-hidden />
              )}
            </div>
          </Fragment>
        ))}
        {drop?.kind === 'row' && drop.at === rows.length && (
          <div className="pane-drop-row" aria-hidden />
        )}
      </div>
    </>
  );
}
