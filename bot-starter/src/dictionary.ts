// Word index and best-play search, using the module's exact reward formula
// (RULES.md §6): reward = floor(sum(letter values) * num / den), where the
// multiplier depends only on word length. Reward therefore depends only on
// the multiset of letters, so we index words by their sorted letters (an
// anagram key) in a trie and enumerate every key the rack contains.

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

// A..Z, standard Scrabble values (spacetimedb/src/letters.ts).
export const LETTER_VALUES: readonly number[] = [
  1, 3, 3, 2, 1, 4, 2, 4, 1, 8, 5, 1, 3, 1, 1, 3, 10, 1, 1, 1, 1, 4, 4, 8, 4, 10,
];
// The 98-tile bag, no blanks (spacetimedb/src/letters.ts DEFAULT_BAG).
export const BAG_COUNTS: readonly number[] = [
  9, 2, 2, 4, 12, 2, 3, 2, 9, 1, 1, 4, 2, 6, 8, 2, 1, 6, 4, 6, 4, 2, 2, 1, 2, 1,
];
export const BAG_SIZE = 98;

const A = 65;

/** Letter counts indexed 0..25 (A..Z). */
export type Counts = Uint8Array;

export function letterIndex(c: string): number {
  const i = c.charCodeAt(0) - A;
  return i >= 0 && i < 26 ? i : -1;
}

export function letterOf(i: number): string {
  return String.fromCharCode(A + i);
}

export function emptyCounts(): Counts {
  return new Uint8Array(26);
}

export function countsOf(src: string | Map<string, number> | Iterable<string>): Counts {
  const out = new Uint8Array(26);
  if (src instanceof Map) {
    for (const [c, n] of src) {
      const i = letterIndex(c);
      if (i >= 0) out[i] = Math.min(255, out[i]! + n);
    }
  } else {
    for (const c of src) {
      const i = letterIndex(c);
      if (i >= 0) out[i]!++;
    }
  }
  return out;
}

export function totalOf(c: Counts): number {
  let n = 0;
  for (let i = 0; i < 26; i++) n += c[i]!;
  return n;
}

/** Compact string key for a multiset, e.g. "AAEQ". */
export function countsKey(c: Counts): string {
  let s = "";
  for (let i = 0; i < 26; i++) for (let k = 0; k < c[i]!; k++) s += letterOf(i);
  return s;
}

/** Module's lengthMultiplier as [num, den]. */
export function lengthMultiplier(len: number): [number, number] {
  if (len <= 3) return [1, 1];
  if (len === 4) return [3, 2];
  if (len === 5) return [2, 1];
  if (len === 6) return [5, 2];
  return [3, 1];
}

export function rewardFor(base: number, len: number): number {
  const [num, den] = lengthMultiplier(len);
  return Math.floor((base * num) / den);
}

export function baseScore(word: string): number {
  let b = 0;
  for (let i = 0; i < word.length; i++) b += LETTER_VALUES[word.charCodeAt(i) - A] ?? 0;
  return b;
}

export function wordReward(word: string): number {
  return rewardFor(baseScore(word), word.length);
}

export interface Candidate {
  word: string;
  len: number;
  reward: number;
}

export interface Plays {
  words: string[];
  total: number;
}

// Beam widths per search depth: how many candidate words to try as the
// next-largest word of the partition. Deeper levels get narrower.
const BEAM_FAST = [4, 2, 1];
const BEAM_FULL = [24, 8, 4, 2, 1];

// Does `word` fit in `counts`? Leaves `counts` unchanged.
function fits(word: string, counts: Counts): boolean {
  let i = 0;
  let ok = true;
  for (; i < word.length; i++) {
    const x = word.charCodeAt(i) - A;
    if (counts[x] === 0) {
      ok = false;
      break;
    }
    counts[x]!--;
  }
  for (let j = 0; j < i; j++) counts[word.charCodeAt(j) - A]!++;
  return ok;
}

function take(word: string, counts: Counts) {
  for (let i = 0; i < word.length; i++) counts[word.charCodeAt(i) - A]!--;
}

function give(word: string, counts: Counts) {
  for (let i = 0; i < word.length; i++) counts[word.charCodeAt(i) - A]!++;
}

export class Dictionary {
  readonly words: string[];
  readonly size: number;
  private readonly wordSet: Set<string>;
  // Trie over sorted-letter keys: child[node * 26 + letter] (0 = none; the
  // root is node 0 and is never a child), term[node] = word index or -1.
  private child: Int32Array;
  private term: Int32Array;
  private nodes = 1;

  constructor(rawWords: Iterable<string>) {
    const seen = new Set<string>();
    for (const raw of rawWords) {
      const w = raw.trim().toUpperCase();
      if (w.length >= 2 && /^[A-Z]+$/.test(w)) seen.add(w);
    }
    this.words = [...seen];
    this.wordSet = seen;
    this.size = this.words.length;

    let cap = 1 << 17;
    this.child = new Int32Array(cap * 26);
    this.term = new Int32Array(cap).fill(-1);
    const codes: number[] = [];
    for (let wi = 0; wi < this.words.length; wi++) {
      const w = this.words[wi]!;
      codes.length = 0;
      for (let i = 0; i < w.length; i++) codes.push(w.charCodeAt(i) - A);
      codes.sort((a, b) => a - b);
      let node = 0;
      for (const c of codes) {
        const idx = node * 26 + c;
        let nx = this.child[idx]!;
        if (nx === 0) {
          if (this.nodes >= cap) {
            cap *= 2;
            const ch = new Int32Array(cap * 26);
            ch.set(this.child);
            this.child = ch;
            const t = new Int32Array(cap).fill(-1);
            t.set(this.term);
            this.term = t;
          }
          nx = this.nodes++;
          this.child[idx] = nx;
        }
        node = nx;
      }
      if (this.term[node] === -1) this.term[node] = wi;
    }
  }

  /** Loads the module's ENABLE wordlist (spacetimedb/wordlist.txt). */
  static load(file?: string): Dictionary {
    const p =
      file ??
      path.join(
        path.dirname(fileURLToPath(import.meta.url)),
        "..",
        "..",
        "spacetimedb",
        "wordlist.txt",
      );
    return new Dictionary(fs.readFileSync(p, "utf8").split("\n"));
  }

  isWord(w: string): boolean {
    return this.wordSet.has(w.toUpperCase());
  }

  /**
   * Every distinct-anagram word spellable from `counts` (one representative
   * word per letter multiset), sorted by reward, highest first.
   */
  candidates(counts: Counts, minLen = 2): Candidate[] {
    const out: Candidate[] = [];
    const c = Uint8Array.from(counts);
    const child = this.child;
    const term = this.term;
    const words = this.words;
    const dfs = (node: number, start: number, len: number, base: number) => {
      const row = node * 26;
      for (let l = start; l < 26; l++) {
        if (c[l] === 0) continue;
        const nx = child[row + l]!;
        if (nx === 0) continue;
        c[l]!--;
        const nb = base + LETTER_VALUES[l]!;
        const nl = len + 1;
        const t = term[nx]!;
        if (t >= 0 && nl >= minLen) {
          out.push({ word: words[t]!, len: nl, reward: rewardFor(nb, nl) });
        }
        dfs(nx, l, nl, nb);
        c[l]!++;
      }
    };
    dfs(0, 0, 0, 0);
    out.sort((a, b) => b.reward - a.reward || b.len - a.len);
    return out;
  }

  /**
   * Best set of disjoint words from `counts`, maximizing total reward.
   * Beam search: a partition is explored in descending-reward order, so the
   * next word is always taken from candidates at or after the current one.
   */
  bestPlays(counts: Counts, beam: readonly number[] = BEAM_FULL): Plays {
    const cands = this.candidates(counts);
    const work = Uint8Array.from(counts);
    const chosen: string[] = [];
    let best: Plays = { words: [], total: 0 };
    const search = (from: number, depth: number, acc: number) => {
      if (acc > best.total) best = { words: [...chosen], total: acc };
      const width = beam[Math.min(depth, beam.length - 1)]!;
      let tried = 0;
      for (let i = from; i < cands.length && tried < width; i++) {
        const cand = cands[i]!;
        if (!fits(cand.word, work)) continue;
        tried++;
        take(cand.word, work);
        chosen.push(cand.word);
        search(i, depth + 1, acc + cand.reward);
        chosen.pop();
        give(cand.word, work);
      }
    };
    search(0, 0, 0);
    return best;
  }

  /** Faster, narrower version of bestPlays(...).total for Monte Carlo. */
  bestValue(counts: Counts): number {
    return this.bestPlays(counts, BEAM_FAST).total;
  }
}
