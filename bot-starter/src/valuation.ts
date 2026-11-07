// Letter valuation: the marginal increase in my expected final points from
// owning one more copy of a letter.
//
//   V(R)     = E_D[ bestPartition(R + D) ]   D = K random future tiles
//   value(L) = E_D[ bestPartition(R + L + D) - bestPartition(R + D) ]
//
// The same samples D are used for every letter (common random numbers), so
// differences between letters aren't swamped by sampling noise. Leftover
// tiles are worth nothing at match end (RULES.md §7), which bestPartition
// already reflects.

import { Dictionary, emptyCounts, totalOf, type Counts } from "./dictionary.js";

/** Small fast PRNG (mulberry32). */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** N samples of K tiles drawn without replacement from `pool`. */
export function sampleDraws(pool: Counts, k: number, n: number, rand: () => number): Counts[] {
  const tiles: number[] = [];
  for (let i = 0; i < 26; i++) for (let j = 0; j < pool[i]!; j++) tiles.push(i);
  const kk = Math.min(k, tiles.length);
  const out: Counts[] = [];
  const samples = kk === 0 ? 1 : n;
  for (let s = 0; s < samples; s++) {
    const d = emptyCounts();
    for (let i = 0; i < kk; i++) {
      const j = i + Math.floor(rand() * (tiles.length - i));
      const t = tiles[j]!;
      tiles[j] = tiles[i]!;
      tiles[i] = t;
      d[t]!++;
    }
    out.push(d);
  }
  return out;
}

export interface JobSpec {
  rack: Counts;
  pool: Counts;
  /** Future tiles I expect to win (K). */
  futureDraws: number;
  samples: number;
  /** Letters to value, most important first. */
  letters: number[];
  seed: number;
}

/**
 * A valuation that can run in time slices (`step`) so the event loop keeps
 * serving bids and word plays while it computes.
 */
export class ValuationJob {
  readonly values = new Float64Array(26).fill(Number.NaN);
  private readonly draws: Counts[];
  private readonly base: Float64Array;
  private baseDone = 0;
  private li = 0;
  private si = 0;
  private acc = 0;
  private readonly tmp = emptyCounts();
  done = false;
  evals = 0;

  constructor(
    private readonly dict: Dictionary,
    readonly spec: JobSpec,
  ) {
    this.draws = sampleDraws(spec.pool, spec.futureDraws, spec.samples, rng(spec.seed));
    this.base = new Float64Array(this.draws.length);
  }

  private evalWith(d: Counts, extra: number): number {
    const t = this.tmp;
    const r = this.spec.rack;
    for (let i = 0; i < 26; i++) t[i] = r[i]! + d[i]!;
    if (extra >= 0) t[extra]!++;
    this.evals++;
    return this.dict.bestValue(t);
  }

  /** Runs until done or `deadline` (performance.now() ms). Returns done. */
  step(deadline: number): boolean {
    const n = this.draws.length;
    while (!this.done) {
      if (performance.now() >= deadline) return false;
      if (this.baseDone < n) {
        this.base[this.baseDone] = this.evalWith(this.draws[this.baseDone]!, -1);
        this.baseDone++;
        continue;
      }
      if (this.li >= this.spec.letters.length) {
        this.done = true;
        break;
      }
      const L = this.spec.letters[this.li]!;
      this.acc += this.evalWith(this.draws[this.si]!, L) - this.base[this.si]!;
      this.si++;
      if (this.si >= n) {
        this.values[L] = Math.max(0, this.acc / n);
        this.acc = 0;
        this.si = 0;
        this.li++;
      }
    }
    return true;
  }

  /** Runs to completion synchronously. */
  run(): this {
    this.step(Number.POSITIVE_INFINITY);
    return this;
  }

  value(letter: number): number | undefined {
    const v = this.values[letter]!;
    return Number.isNaN(v) ? undefined : v;
  }

  /** Expected final points with no extra letter (mean of base samples). */
  expectedPoints(): number {
    if (this.baseDone === 0) return 0;
    let s = 0;
    for (let i = 0; i < this.baseDone; i++) s += this.base[i]!;
    return s / this.baseDone;
  }
}

/** Value one letter right now (synchronous, for cache misses). */
export function valueLetterNow(
  dict: Dictionary,
  rack: Counts,
  pool: Counts,
  futureDraws: number,
  samples: number,
  letter: number,
  seed: number,
): number {
  const job = new ValuationJob(dict, {
    rack,
    pool,
    futureDraws,
    samples,
    letters: [letter],
    seed,
  }).run();
  return job.value(letter) ?? 0;
}

/** Letters in order of how likely they are to come up next. */
export function lettersByLikelihood(pool: Counts): number[] {
  const ls: number[] = [];
  for (let i = 0; i < 26; i++) ls.push(i);
  return ls.sort((a, b) => pool[b]! - pool[a]!);
}

export function poolSize(pool: Counts): number {
  return totalOf(pool);
}
