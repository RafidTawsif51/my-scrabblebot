// Live market prices per letter, from tools/bidmodel.json (median winning
// bids of Bron and LUCENT over ~200 live matches; tools/analyze.ts).

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { LETTER_VALUES, letterIndex } from "./dictionary.js";

const FALLBACK_BY_FACE: Record<number, number> = { 1: 10, 2: 13, 3: 16, 4: 19, 5: 21, 8: 32, 10: 30 };

function load(): Record<string, number> {
  const out: Record<string, number> = {};
  try {
    const file = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "tools", "bidmodel.json");
    const model = JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, { letters: Record<string, { med: number }> }>;
    const bots = Object.values(model);
    for (let i = 0; i < 26; i++) {
      const L = String.fromCharCode(65 + i);
      const meds = bots.map((b) => b.letters[L]?.med).filter((x): x is number => Number.isFinite(x));
      out[L] = meds.length ? meds.reduce((a, b) => a + b, 0) / meds.length : FALLBACK_BY_FACE[LETTER_VALUES[i]!]!;
    }
  } catch {
    for (let i = 0; i < 26; i++) out[String.fromCharCode(65 + i)] = FALLBACK_BY_FACE[LETTER_VALUES[i]!]!;
  }
  return out;
}

const PRICES = load();

/** Typical live winning bid for `letter` (mean of Bron's and LUCENT's medians). */
export function marketPrice(letter: string): number {
  return PRICES[letter] ?? FALLBACK_BY_FACE[LETTER_VALUES[letterIndex(letter)] ?? 1] ?? 10;
}
