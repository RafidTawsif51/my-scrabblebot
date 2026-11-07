// Bingo-style rack leave: how close a rack is to 7-8 letter words (the 3x
// multiplier, RULES.md §6), and how much each letter would bring it closer.
//
// For every distinct 7-8 letter anagram key W, missing(W) = letters of W
// the rack lacks. A rack's leave score sums a weight per key by how many
// letters it is away. Adding letter L lowers missing(W) by one for every W
// that lacks an L, so one pass over the keys gives the gain for all 26
// letters at once.

import { emptyCounts, type Counts, type Dictionary } from "./dictionary.js";

/** Weight of a key that is `m` letters away (m = 0: playable now). */
export const LEAVE_WEIGHTS = [3, 1, 0.2, 0.03];

export interface LeaveInfo {
  /** Fewest letters missing from any 7-8 letter word. */
  minMissing: number;
  /** Leave score of the rack (sum of LEAVE_WEIGHTS over near keys). */
  score: number;
  /** Increase in score from adding one of each letter. */
  gain: Float64Array;
  /** 7-8 letter keys playable right now. */
  playable: number;
}

export class BingoIndex {
  /** Flattened letter counts, 26 per key. */
  private readonly keys: Uint8Array;
  readonly size: number;

  constructor(dict: Dictionary) {
    const seen = new Set<string>();
    const rows: number[][] = [];
    for (const w of dict.words) {
      if (w.length < 7 || w.length > 8) continue;
      const key = [...w].sort().join("");
      if (seen.has(key)) continue;
      seen.add(key);
      const c = new Array<number>(26).fill(0);
      for (let i = 0; i < w.length; i++) c[w.charCodeAt(i) - 65]!++;
      rows.push(c);
    }
    this.size = rows.length;
    this.keys = new Uint8Array(rows.length * 26);
    rows.forEach((r, i) => this.keys.set(r, i * 26));
  }

  leave(rack: Counts): LeaveInfo {
    const gain = new Float64Array(26);
    const W = LEAVE_WEIGHTS;
    const maxM = W.length - 1;
    let minMissing = 99;
    let score = 0;
    let playable = 0;
    const keys = this.keys;
    for (let k = 0, o = 0; k < this.size; k++, o += 26) {
      let m = 0;
      for (let i = 0; i < 26; i++) {
        const d = keys[o + i]! - rack[i]!;
        if (d > 0) {
          m += d;
          if (m > maxM + 1) break;
        }
      }
      if (m > maxM + 1) continue;
      if (m < minMissing) minMissing = m;
      const wm = m <= maxM ? W[m]! : 0;
      score += wm;
      if (m === 0) {
        playable++;
        continue;
      }
      const delta = W[m - 1]! - wm; // gain if one missing letter arrives
      for (let i = 0; i < 26; i++) if (keys[o + i]! > rack[i]!) gain[i]! += delta;
    }
    return { minMissing, score, gain, playable };
  }
}

/** Gain for `letter` relative to the best available letter (0..1). */
export function relativeGain(info: LeaveInfo, letter: number): number {
  let max = 0;
  for (let i = 0; i < 26; i++) if (info.gain[i]! > max) max = info.gain[i]!;
  return max > 0 ? info.gain[letter]! / max : 0;
}

export { emptyCounts };
