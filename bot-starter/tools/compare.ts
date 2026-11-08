// Live A/B summary per JAEGER_MODE from logs/summary.jsonl (read-only).
//   npm run compare            (or: npx tsx tools/compare.ts [--last N])
//
// lucent, fuel: only rows that carry that mode (the mode field exists).
// v3:     rows with mode "v3", plus older rows without a mode field that are
//         the current lineage (their match file shows the market floor that
//         v3 introduced). Older versions are left out.

import * as fs from "node:fs";
import * as path from "node:path";
import { LIVE_LOG_DIR } from "../src/logger.js";

const lastN = (() => {
  const i = process.argv.indexOf("--last");
  return i >= 0 ? Number(process.argv[i + 1]) : Infinity;
})();

interface Row {
  bot: string;
  matchId: string;
  mode?: string | null;
  rank: number;
  players: number;
  score: number;
  coinsSpent: number;
  finalBalance: number;
  lettersWon: number;
  shadow?: boolean;
}

const file = path.join(LIVE_LOG_DIR, "summary.jsonl");
if (!fs.existsSync(file)) {
  console.log(`no ${file} yet`);
  process.exit(0);
}
const rows: Row[] = fs
  .readFileSync(file, "utf8")
  .split("\n")
  .filter((l) => l.trim())
  .map((l) => {
    try {
      return JSON.parse(l) as Row;
    } catch {
      return null;
    }
  })
  .filter((r): r is Row => r !== null && r.bot === "jaeger");

const floorCache = new Map<string, boolean>();
function isFloorEra(matchId: string): boolean {
  if (!floorCache.has(matchId)) {
    let v = false;
    try {
      const m = JSON.parse(fs.readFileSync(path.join(LIVE_LOG_DIR, `match-${matchId}.json`), "utf8"));
      v = !m.shadow && (m.bids as { reason: string }[]).some((b) => b.reason.includes("floor"));
    } catch {
      v = false;
    }
    floorCache.set(matchId, v);
  }
  return floorCache.get(matchId)!;
}

// Matches that can't be attributed to one mode.
const EXCLUDE = new Set([
  "45450", // mixed modes: bot restarted mid-match
]);

const groups: Record<string, Row[]> = { v3: [], "v3 (tagged only)": [], lucent: [], lucent2: [], lucent2e: [], lucent3: [], fuel: [] };
for (const r of rows) {
  if (EXCLUDE.has(String(r.matchId))) continue;
  if (r.mode === "lucent") groups.lucent!.push(r);
  else if (r.mode === "lucent2") groups.lucent2!.push(r);
  else if (r.mode === "lucent2e") groups.lucent2e!.push(r);
  else if (r.mode === "lucent3") groups.lucent3!.push(r);
  else if (r.mode === "fuel") groups.fuel!.push(r);
  else if (r.mode === "v3") {
    groups.v3!.push(r);
    groups["v3 (tagged only)"]!.push(r);
  } else if (!r.mode && isFloorEra(r.matchId)) groups.v3!.push(r);
}

const avg = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN);
console.log("mode               matches  avg score  avg rank  win rate  tiles won  price/tile  coins left");
for (const [mode, all] of Object.entries(groups)) {
  const g = all.slice(-lastN);
  if (g.length === 0) {
    console.log(`${mode.padEnd(18)} ${"0".padStart(7)}  (no matches yet)`);
    continue;
  }
  const tiles = g.reduce((a, r) => a + r.lettersWon, 0);
  const spent = g.reduce((a, r) => a + r.coinsSpent, 0);
  console.log(
    `${mode.padEnd(18)} ${String(g.length).padStart(7)}  ${avg(g.map((r) => r.score)).toFixed(1).padStart(9)}  ` +
      `${avg(g.map((r) => r.rank)).toFixed(2).padStart(8)}  ${((100 * g.filter((r) => r.rank === 1).length) / g.length).toFixed(0).padStart(7)}%  ` +
      `${avg(g.map((r) => r.lettersWon)).toFixed(1).padStart(9)}  ${(tiles ? spent / tiles : NaN).toFixed(1).padStart(10)}  ` +
      `${avg(g.map((r) => r.finalBalance)).toFixed(1).padStart(10)}`,
  );
}
