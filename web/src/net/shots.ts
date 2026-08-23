/**
 * Splitting shots across machines and merging what comes back.
 *
 * Histograms travel as flat `[index, count, index, count, ...]` arrays —
 * compact in JSON, order-preserving, and trivially convertible to the
 * `ShotOutcome[]` the timeline holds. Every basis-state index here fits
 * exactly in a JS `number`: the largest register the visualiser attempts is
 * 30 qubits, far below the 2^53 where doubles would lose integer precision.
 */
import type { ShotOutcome } from '../lib/types';

/**
 * Most outcomes a broadcast result carries.
 *
 * A ctrl-channel message has to stay well under the browsers' data-channel
 * message limit (~256 KiB portable); 4096 pairs is ~60 KiB of JSON. Every
 * scored program's whole outcome space fits (QAOA has 4096 basis states
 * total), so the best shot always survives the cut; only the long tail of an
 * unscored histogram can be dropped, and the sender says so in the note.
 */
export const RESULT_OUTCOME_CAP = 4096;

/**
 * Split `total` as evenly as possible across `n` participants: the first
 * `total % n` get one extra.
 */
export function evenSplit(total: number, n: number): number[] {
  const base = Math.floor(total / n);
  const remainder = total % n;
  return Array.from({ length: n }, (_, i) => base + (i < remainder ? 1 : 0));
}

/** Sum a flat histogram into a Map of basis-state index to count. */
export function countsFromFlat(flat: ArrayLike<number>): Map<number, number> {
  const counts = new Map<number, number>();
  for (let i = 0; i + 1 < flat.length; i += 2) {
    const index = flat[i];
    counts.set(index, (counts.get(index) ?? 0) + flat[i + 1]);
  }
  return counts;
}

/** Encode outcomes as a flat histogram, keeping at most `cap` of them. */
export function flatFromOutcomes(outcomes: ShotOutcome[], cap = Infinity): number[] {
  const kept = outcomes.length > cap ? outcomes.slice(0, cap) : outcomes;
  const flat = new Array<number>(kept.length * 2);
  kept.forEach((o, i) => {
    flat[2 * i] = o.index;
    flat[2 * i + 1] = o.count;
  });
  return flat;
}

/** Decode a flat histogram, preserving the sender's order. */
export function outcomesFromFlat(flat: ArrayLike<number>): ShotOutcome[] {
  const outcomes: ShotOutcome[] = [];
  for (let i = 0; i + 1 < flat.length; i += 2) {
    outcomes.push({ index: flat[i], count: flat[i + 1] });
  }
  return outcomes;
}
