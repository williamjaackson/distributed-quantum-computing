/**
 * Measure how much memory *this* machine will commit, rather than asking.
 *
 * There is no web API for total RAM. `navigator.deviceMemory` is deliberately
 * coarse **and capped at 8** by the Device Memory API to limit fingerprinting, so
 * it reports 8 on a 16 GB machine and 8 on a 128 GB one — it can never describe a
 * large machine. It is also gated on a secure context, so it is simply absent
 * when the page is served over plain HTTP to a LAN address.
 *
 * So measure it. Allocating proves nothing, because the OS commits lazily and its
 * compressor squashes zero pages away; this probe *writes* varied data into every
 * buffer it takes and watches the write rate.
 *
 * What that reveals is not a cliff but two knees, measured here on a 16 GB M4:
 *
 * ```text
 *  0.5 - 6.5 GiB   7-18 GB/s   uncompressed, plenty of free pages
 *  7.0 - 7.5 GiB   1-2  GB/s   transition: the compressor engages
 *  8.0 - 14  GiB   ~3   GB/s   compressed - still works, roughly 4x slower
 * ```
 *
 * It committed the full 14 GiB on a 16 GB machine without dying. That is exactly
 * why an over-RAM budget can appear to work, and why "did it allocate" is a
 * useless test.
 *
 * The figure worth reporting is therefore the **first** knee: how much can be
 * committed while the machine still has free pages. Past it things keep running,
 * just several times slower.
 */

const PAGE_BYTES = 4096;
const F64 = 8;
/** Template size for the fast fill. 1 MiB stays comfortably in cache. */
const TEMPLATE_BYTES = 1 << 20;
const GIB = 1024 ** 3;

export interface MemoryProbeOptions {
  /** Bytes committed per step. Must stay under the ~2 GiB per-object cap. */
  chunkBytes: number;
  /** Never commit more than this, whatever the machine turns out to have. */
  maxBytes: number;
  /** Give up after this long, so a slow machine cannot hang the page. */
  timeBudgetMs: number;
  /**
   * Leading chunks excluded from the baseline and from any knee decision.
   *
   * The first chunk is unrepresentatively fast — the template is still
   * cache-resident and the heap is fresh — so anchoring on it stops the probe
   * almost immediately. Measured: with the first chunk included, the probe
   * reported 1 GiB on a machine that `vm_stat` showed had 6.9 GiB free.
   */
  warmupChunks: number;
  /** Chunks after warm-up whose median defines this machine's uncompressed rate. */
  baselineChunks: number;
  /**
   * Knee threshold, as a fraction of that baseline.
   *
   * Relative — but to a *stable baseline of the same measurement*, not to a
   * running peak. That distinction matters: comparing chunk to chunk is
   * like-for-like (same size, same operation, same worker), whereas a running
   * peak across different configurations is not, and it also makes the verdict
   * depend on measurement order. Relative is right here because the uncompressed
   * rate is a property of the machine: a fixed GB/s number that suits one machine
   * will misjudge another.
   */
  kneeFraction: number;
  /** Backstop in GB/s, in case the baseline itself is measured on a slow machine. */
  absoluteFloorGBps: number;
  /**
   * Chunks in the rolling median. The transition is noisy — a single chunk dipped
   * to 1.16 GB/s and then recovered to 3.5 — so the decision has to rest on a
   * sustained trend, never one sample.
   */
  medianWindow: number;
}

export const DEFAULT_MEMORY_PROBE: MemoryProbeOptions = {
  chunkBytes: 512 * 1024 * 1024,
  maxBytes: 256 * GIB,
  timeBudgetMs: 30000,
  warmupChunks: 1,
  baselineChunks: 3,
  kneeFraction: 0.4,
  absoluteFloorGBps: 2,
  medianWindow: 3,
};

export interface MemoryProbeStep {
  committedBytes: number;
  chunkGBps: number;
  medianGBps: number;
  fast: boolean;
}

/** This machine's uncompressed write rate, once enough chunks have landed. */
export interface MemoryBaseline {
  gbps: number;
  kneeAtGBps: number;
}

export type MemoryProbeStop =
  /** Found the knee: the write rate stopped keeping up. */
  | 'knee'
  /** The allocator refused a chunk outright. */
  | 'refused'
  /** Hit the configured ceiling without finding a knee. */
  | 'max'
  /** Ran out of time budget. */
  | 'time';

export interface MemoryProbeResult {
  /** Committable while the machine still had free pages — the useful figure. */
  fastBytes: number;
  /** Total committed, including the chunks that were already slowing down. */
  committedBytes: number;
  peakGBps: number;
  baseline: MemoryBaseline | null;
  stop: MemoryProbeStop;
  steps: MemoryProbeStep[];
  elapsedMs: number;
  /** What the browser admitted to, for comparison. Capped at 8, often absent. */
  reportedDeviceMemoryGiB: number | null;
}

function makeTemplate(): Float64Array {
  const t = new Float64Array(TEMPLATE_BYTES / F64);
  let s = 0x9e3779b9;
  for (let i = 0; i < t.length; i++) {
    s = (s * 1664525 + 1013904223) >>> 0;
    t[i] = s * 2.3283064365386963e-10;
  }
  return t;
}

/**
 * Write varied data across `buf` so every page is resident *and* incompressible.
 *
 * Generating values element by element would be honest but far too slow —
 * measured at ~1.2 GB/s, which would take a minute on a large machine and would
 * itself be the bottleneck rather than memory. Copying a varied template runs at
 * memcpy speed. Compression is page-granular, so a page of template bytes is
 * already incompressible; the per-page salt afterwards also makes every page
 * distinct, so nothing can be deduplicated.
 */
function commit(buf: ArrayBuffer, template: Float64Array, salt: number): void {
  const v = new Float64Array(buf);
  const step = template.length;
  let off = 0;
  for (; off + step <= v.length; off += step) v.set(template, off);
  if (off < v.length) v.set(template.subarray(0, v.length - off), off);

  const perPage = PAGE_BYTES / F64;
  for (let i = 0; i < v.length; i += perPage) v[i] = salt + i;
}

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

export function deviceMemoryGiB(): number | null {
  return (navigator as Navigator & { deviceMemory?: number }).deviceMemory ?? null;
}

export async function measureUsableMemory(
  options: MemoryProbeOptions = DEFAULT_MEMORY_PROBE,
  onStep?: (s: MemoryProbeStep) => void,
): Promise<MemoryProbeResult> {
  const started = performance.now();
  const template = makeTemplate();
  // Held so the pages stay resident: releasing as we go would let the OS reclaim
  // them and the probe would never find a limit.
  const held: ArrayBuffer[] = [];
  const steps: MemoryProbeStep[] = [];
  const window: number[] = [];

  let committed = 0;
  let fastBytes = 0;
  let peakGBps = 0;
  let stop: MemoryProbeStop = 'max';
  let baseline: MemoryBaseline | null = null;
  const postWarmup: number[] = [];

  try {
    while (committed + options.chunkBytes <= options.maxBytes) {
      if (performance.now() - started > options.timeBudgetMs) {
        stop = 'time';
        break;
      }

      let buf: ArrayBuffer;
      try {
        buf = new ArrayBuffer(options.chunkBytes);
      } catch {
        stop = 'refused';
        break;
      }

      const t0 = performance.now();
      commit(buf, template, committed);
      const ms = performance.now() - t0;

      held.push(buf);
      committed += options.chunkBytes;

      const chunkGBps = options.chunkBytes / 1e9 / (ms / 1000);
      peakGBps = Math.max(peakGBps, chunkGBps);
      const index = steps.length; // 0-based, before pushing this step

      // Warm-up chunks are recorded but never influence the baseline or a knee.
      if (index >= options.warmupChunks) {
        postWarmup.push(chunkGBps);
        window.push(chunkGBps);
        if (window.length > options.medianWindow) window.shift();
        if (!baseline && postWarmup.length >= options.baselineChunks) {
          const gbps = median(postWarmup.slice(0, options.baselineChunks));
          baseline = {
            gbps,
            kneeAtGBps: Math.max(gbps * options.kneeFraction, options.absoluteFloorGBps),
          };
        }
      }

      const medianGBps = window.length ? median(window) : chunkGBps;
      // Nothing can be declared a knee until the baseline exists and the rolling
      // window is full, so a noisy start cannot end the probe early.
      const decidable = baseline !== null && window.length >= options.medianWindow;
      const fast = !decidable || medianGBps >= baseline!.kneeAtGBps;

      const step: MemoryProbeStep = { committedBytes: committed, chunkGBps, medianGBps, fast };
      steps.push(step);
      onStep?.(step);

      if (!fast) {
        stop = 'knee';
        break;
      }
      fastBytes = committed;

      // Yield so progress can paint and the page stays responsive.
      await new Promise((r) => setTimeout(r, 0));
    }
  } finally {
    // Release everything. The OS reclaims asynchronously, so callers should give
    // it a moment before allocating again.
    held.length = 0;
  }

  return {
    fastBytes,
    committedBytes: committed,
    peakGBps,
    baseline,
    stop,
    steps,
    elapsedMs: performance.now() - started,
    reportedDeviceMemoryGiB: deviceMemoryGiB(),
  };
}

/**
 * Budget to hand the simulator from a measured knee.
 *
 * The knee is used as-is rather than discounted: it is already measured *on top
 * of* whatever the browser and OS were using, and the probe stops at the first
 * sustained slowdown rather than pushing to the limit. Rounded down to a whole
 * GiB so the number reads as a decision rather than a reading.
 */
export function suggestBudgetBytes(fastBytes: number): number {
  return Math.max(GIB, Math.floor(fastBytes / GIB) * GIB);
}

/**
 * Fallback when nothing has been measured.
 *
 * `deviceMemory` is capped at 8 and absent outside a secure context, so this is a
 * floor to start from, never a description of the machine.
 */
export function fallbackBudgetBytes(): number {
  return (deviceMemoryGiB() ?? 4) * GIB;
}
