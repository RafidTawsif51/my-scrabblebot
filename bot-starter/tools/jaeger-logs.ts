// Jaeger's own diagnostics from bot-starter/logs/match-*.json, joined with
// public top bids from a fetch-matches.ts dump.
//   npx tsx tools/jaeger-logs.ts <matches.json>

import * as fs from "node:fs";
import * as path from "node:path";
// Read-only: reads the live bot's logs, never writes to them.
import { LIVE_LOG_DIR as LOG_DIR } from "../src/logger.js";

const dump = JSON.parse(fs.readFileSync(process.argv[2]!, "utf8")) as {
  matches: { matchId: number; results: { auctionId: number; topBid: number | null; winner: number | null; paid: number }[] }[];
};
const top = new Map<string, { topBid: number | null; winner: number | null }>();
for (const m of dump.matches) for (const r of m.results) top.set(String(r.auctionId), r);

const files = fs.readdirSync(LOG_DIR).filter((f) => /^match-\d+\.json$/.test(f));
let lost = 0, lostBelowValue = 0, lostBelowDesired = 0, cappedLosses = 0, zeroBidLosses = 0, zeroBidBelowValue = 0;
const wordLat: number[] = [];
const errors = new Map<string, number>();
const lostDetail: string[] = [];
for (const f of files) {
  const log = JSON.parse(fs.readFileSync(path.join(LOG_DIR, f), "utf8"));
  const bids = new Map<string, any>(log.bids.map((b: any) => [b.auctionId, b]));
  for (const r of log.results) {
    if (r.mine) continue;
    const b = bids.get(r.auctionId);
    if (!b) continue;
    lost++;
    const t = top.get(r.auctionId)?.topBid ?? null;
    if (t === null) continue;
    if (b.amount === 0) {
      zeroBidLosses++;
      if (t < b.value) zeroBidBelowValue++;
    }
    if (t < b.value) lostBelowValue++;
    if (t < b.desired) {
      lostBelowDesired++;
      if (b.amount < b.desired) cappedLosses++;
      if (lostDetail.length < 12) lostDetail.push(`${b.letter} bag ${b.bagTotal}: value ${b.value} desired ${b.desired} bid ${b.amount} bal ${b.balance} | winner bid ${t} | ${b.reason}`);
    }
  }
  for (const w of log.words) if (typeof w.latencyMs === "number") wordLat.push(w.latencyMs);
  for (const n of log.notes as string[]) {
    const k = n.replace(/^\S+ /, "").replace(/'[^']*'/g, "'…'").replace(/\d+/g, "#");
    errors.set(k, (errors.get(k) ?? 0) + 1);
  }
  console.log(`${f}: score ${log.score} rank ${log.rank}/${log.players} won ${log.lettersWon.length} spent ${log.coinsSpent} endBal ${log.finalBalance} leftover "${log.leftoverTiles}" latency ${JSON.stringify(log.latencyMs)}`);
}
const s = [...wordLat].sort((a, b) => a - b);
const p = (q: number) => s[Math.min(s.length - 1, Math.floor(q * s.length))];
console.log(`\nlost auctions ${lost}: winner bid < our points value ${lostBelowValue}; < our desired coin bid ${lostBelowDesired} (of which our bid was capped below desired: ${cappedLosses}); we bid 0: ${zeroBidLosses} (winner bid < our value: ${zeroBidBelowValue})`);
for (const d of lostDetail) console.log("  " + d);
console.log(`word reducer latency n ${s.length} p50 ${p(0.5)} p95 ${p(0.95)} max ${s.at(-1)}`);
console.log("errors/notes:");
for (const [k, n] of errors) console.log(`  ${n} x ${k}`);
