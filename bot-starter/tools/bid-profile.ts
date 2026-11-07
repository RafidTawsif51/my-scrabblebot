// Jaeger's live bid profile from bot-starter/logs (read-only).
//   npx tsx tools/bid-profile.ts
import * as fs from "node:fs";
import * as path from "node:path";
import { LIVE_LOG_DIR } from "../src/logger.js";

const groups: [string, string][] = [["vowels", "AEIOU"], ["LNRST", "LNRST"], ["DG", "DG"], ["BCMP", "BCMP"], ["FHVWY", "FHVWY"], ["JKXQZ", "JKXQZ"]];
const med = (xs: number[]) => { const s = [...xs].sort((a, b) => a - b); return s.length ? s[Math.floor(s.length / 2)]! : NaN; };
const bids: any[] = [];
for (const f of fs.readdirSync(LIVE_LOG_DIR).filter((f) => /^match-\d+\.json$/.test(f))) {
  const log = JSON.parse(fs.readFileSync(path.join(LIVE_LOG_DIR, f), "utf8"));
  if (log.shadow) continue;
  for (const b of log.bids) bids.push({ ...b, round: 0 });
}
console.log(`live bids: ${bids.length}, zero ${bids.filter((b) => b.amount === 0).length}, sources ${JSON.stringify(Object.fromEntries(["cache", "now"].map((s) => [s, bids.filter((b) => b.source === s).length])))}`);
for (const [g, ls] of groups) {
  const xs = bids.filter((b) => ls.includes(b.letter));
  console.log(`  ${g.padEnd(7)} n ${String(xs.length).padStart(4)}  value med ${med(xs.map((b) => b.value)).toFixed(1)}  bid med ${med(xs.map((b) => b.amount))}  zero ${((100 * xs.filter((b) => b.amount === 0).length) / xs.length).toFixed(0)}%  K med ${med(xs.map((b) => b.futureDraws))}  balance med ${med(xs.map((b) => b.balance))}`);
}
const early = bids.filter((b) => b.bagTotal >= 45), mid = bids.filter((b) => b.bagTotal < 45 && b.bagTotal >= 15), late = bids.filter((b) => b.bagTotal < 15);
for (const [n, xs] of [["bag>=45", early], ["15-44", mid], ["<15", late]] as const)
  console.log(`  ${n.padEnd(7)} value med ${med(xs.map((b: any) => b.value)).toFixed(1)}  bid med ${med(xs.map((b: any) => b.amount))}  K med ${med(xs.map((b: any) => b.futureDraws))}`);
