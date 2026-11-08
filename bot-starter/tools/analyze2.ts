// Word richness and balance-awareness analysis on a fetch-matches.ts dump.
//   npx tsx tools/analyze2.ts <matches.json>

import * as fs from "node:fs";
import { LETTER_VALUES, letterIndex } from "../src/dictionary.js";

interface R { auctionId: number; letter: string; winner: number | null; paid: number; topBid: number | null; closedAt: number }
interface W { botId: number; word: string; reward: number; playedAt: number }
interface M { matchId: number; auctionType: string; players: { botId: number; score: number; balance: number }[]; results: R[]; words: W[] }
const dump = JSON.parse(fs.readFileSync(process.argv[2]!, "utf8")) as { focus: number[]; me: number; matches: M[] };
const NAMES: Record<number, string> = { 114: "Bron", 18: "LUCENT", 167: "Jaeger", [-1]: "others" };
const BOTS = [114, 18, 167];
const key = (b: number) => (BOTS.includes(b) ? b : -1);
const face = (c: string) => LETTER_VALUES[letterIndex(c)]!;
const base = (w: string) => [...w].reduce((s, c) => s + face(c), 0);
const avg = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN);
const med = (xs: number[]) => { const s = [...xs].sort((a, b) => a - b); return s.length ? s[Math.floor(s.length / 2)]! : NaN; };
const pct = (n: number, d: number) => (d ? ((100 * n) / d).toFixed(0) + "%" : "-");
const f = (x: number, d = 1) => (Number.isNaN(x) ? "-" : x.toFixed(d));
const pearson = (xs: number[], ys: number[]) => {
  const mx = avg(xs), my = avg(ys);
  let sxy = 0, sxx = 0, syy = 0;
  for (let i = 0; i < xs.length; i++) { sxy += (xs[i]! - mx) * (ys[i]! - my); sxx += (xs[i]! - mx) ** 2; syy += (ys[i]! - my) ** 2; }
  return sxy / Math.sqrt(sxx * syy);
};
const HI = "JQXZ", FOUR = "FHVWYK";

// ---------- 1. Words ----------
console.log("== 1. Word richness ==");
const words = new Map<number, W[]>();
const wins = new Map<number, R[]>();
const allRes: { r: R; m: M }[] = [];
for (const m of dump.matches) {
  for (const w of m.words) { const k = key(w.botId); if (!words.has(k)) words.set(k, []); words.get(k)!.push(w); }
  for (const r of m.results) { allRes.push({ r, m }); if (r.winner !== null) { const k = key(r.winner); if (!wins.has(k)) wins.set(k, []); wins.get(k)!.push(r); } }
}
for (const k of [114, 18, 167, -1]) {
  const ws = words.get(k) ?? [];
  const s7 = ws.filter((w) => w.word.length >= 7);
  const short = ws.filter((w) => w.word.length < 7);
  const has = (w: W, set: string) => [...w.word].some((c) => set.includes(c));
  console.log(
    `${NAMES[k]!.padEnd(7)} words ${String(ws.length).padStart(5)}  pts/word ${f(avg(ws.map((w) => w.reward)))}  len ${f(avg(ws.map((w) => w.word.length)), 2)}  ` +
      `base/letter ${f(avg(ws.map((w) => base(w.word) / w.word.length)), 2)}  7+ share ${pct(s7.length, ws.length)}  ` +
      `with JQXZ ${pct(ws.filter((w) => has(w, HI)).length, ws.length)}  with FHVWYK ${pct(ws.filter((w) => has(w, FOUR)).length, ws.length)}`,
  );
  console.log(
    `        7+ words: pts ${f(avg(s7.map((w) => w.reward)))}  base ${f(avg(s7.map((w) => base(w.word))))}  base/letter ${f(avg(s7.map((w) => base(w.word) / w.word.length)), 2)}  ` +
      `JQXZ ${pct(s7.filter((w) => has(w, HI)).length, s7.length)}  FHVWYK ${pct(s7.filter((w) => has(w, FOUR)).length, s7.length)}  8+ ${pct(s7.filter((w) => w.word.length >= 8).length, s7.length)}` +
      `   | <7 words: pts ${f(avg(short.map((w) => w.reward)))} len ${f(avg(short.map((w) => w.word.length)), 1)}`,
  );
  const ts = wins.get(k) ?? [];
  const typical = med(ts.map((r) => r.paid));
  const hiT = ts.filter((r) => HI.includes(r.letter)), fourT = ts.filter((r) => FOUR.includes(r.letter));
  console.log(
    `        tiles won ${ts.length}: JQXZ ${pct(hiT.length, ts.length)} (paid med ${med(hiT.map((r) => r.paid))} = ${f(med(hiT.map((r) => r.paid)) / typical, 2)}x typical ${typical})  ` +
      `FHVWYK ${pct(fourT.length, ts.length)} (paid med ${med(fourT.map((r) => r.paid))} = ${f(med(fourT.map((r) => r.paid)) / typical, 2)}x)`,
  );
}
// Share of all J/Q/X/Z auctions each bot won, in matches it played.
const playedIn = (k: number, m: M) => m.players.some((p) => key(p.botId) === k);
for (const k of [114, 18, 167]) {
  const hiAuctions = allRes.filter(({ r, m }) => HI.includes(r.letter) && playedIn(k, m));
  const fourAuctions = allRes.filter(({ r, m }) => FOUR.includes(r.letter) && playedIn(k, m));
  console.log(`${NAMES[k]} wins ${pct(hiAuctions.filter(({ r }) => r.winner === k).length, hiAuctions.length)} of JQXZ auctions and ${pct(fourAuctions.filter(({ r }) => r.winner === k).length, fourAuctions.length)} of FHVWYK auctions in its matches (fair share ~17%)`);
}
// Decomposition: points/word if Jaeger had Bron's length mix, or Bron's base/letter.
{
  const pw = (ws: W[]) => avg(ws.map((w) => w.reward));
  const j = words.get(167) ?? [], b = words.get(114) ?? [];
  const bpl = (ws: W[]) => avg(ws.map((w) => base(w.word) / w.word.length));
  console.log(`decomposition: Jaeger ${f(pw(j))} vs Bron ${f(pw(b))} pts/word; base/letter Jaeger ${f(bpl(j), 2)} vs Bron ${f(bpl(b), 2)} (${f((100 * (bpl(b) - bpl(j))) / bpl(j))}% richer); ` +
    `7+ share Jaeger ${pct(j.filter((w) => w.word.length >= 7).length, j.length)} vs Bron ${pct(b.filter((w) => w.word.length >= 7).length, b.length)}`);
}

// ---------- 2. Opponent balances ----------
console.log("\n== 2. Bron's bids vs opponents' max balance ==");
type Obs = { bot: number; letter: string; top: number | null; paid: number; maxOpp: number; round: number; winner: number | null; myBal: number };
const obs: Obs[] = [];
const bidMed = new Map<string, number>();
for (const m of dump.matches) {
  const n = m.results.length;
  const evs = [...m.results.map((r) => ({ t: r.closedAt, r, w: null as W | null })), ...m.words.map((w) => ({ t: w.playedAt, r: null as R | null, w }))].sort((a, b) => a.t - b.t || (a.w ? 1 : -1));
  const bal = new Map<number, number>(m.players.map((p) => [p.botId, 100]));
  let round = 0;
  for (const e of evs) {
    if (e.r) {
      round++;
      const r = e.r;
      for (const b of [114, 18]) {
        if (!bal.has(b)) continue;
        const maxOpp = Math.max(...[...bal.entries()].filter(([id]) => id !== b).map(([, v]) => v));
        obs.push({ bot: b, letter: r.letter, top: r.topBid, paid: r.paid, maxOpp, round, winner: r.winner, myBal: bal.get(b)! });
      }
      if (r.winner !== null) bal.set(r.winner, bal.get(r.winner)! - r.paid);
    } else if (e.w) bal.set(e.w.botId, (bal.get(e.w.botId) ?? 0) + e.w.reward);
    void n;
  }
}
for (const b of [114, 18]) {
  const won = obs.filter((o) => o.bot === b && o.winner === b && o.top !== null);
  for (const L of new Set(won.map((o) => o.letter))) bidMed.set(`${b}${L}`, med(won.filter((o) => o.letter === L).map((o) => o.top!)));
  const ratio = (o: Obs) => o.top! / bidMed.get(`${b}${o.letter}`)!;
  const bins = [[0, 15], [15, 30], [30, 50], [50, 80], [80, 1e9]];
  console.log(`${NAMES[b]} (wins ${won.length}): corr(winning bid / letter median, maxOppBalance) = ${f(pearson(won.map(ratio), won.map((o) => o.maxOpp)), 3)};  corr(paid, maxOpp) = ${f(pearson(won.map((o) => o.paid), won.map((o) => o.maxOpp)), 3)}`);
  console.log("   maxOpp bin: " + bins.map(([lo, hi]) => { const xs = won.filter((o) => o.maxOpp >= lo! && o.maxOpp < hi!); return `${lo}-${hi === 1e9 ? "+" : hi}: n ${xs.length} bid/med ${f(med(xs.map(ratio)), 2)} paid ${med(xs.map((o) => o.paid))}`; }).join(" | "));
  // Did the second price hit the opponents' balance cap?
  const capped = won.filter((o) => o.paid >= o.maxOpp - 1).length;
  console.log(`   paid within 1 of maxOpp (balance-capped price): ${pct(capped, won.length)};  own balance at win med ${med(won.map((o) => o.myBal))}`);
}
// Market level: how broke is the field late, and does that cap prices?
const all = obs.filter((o) => o.bot === 114);
for (const [lo, hi] of [[1, 20], [21, 40], [41, 55], [56, 70]]) {
  const xs = all.filter((o) => o.round >= lo! && o.round <= hi!);
  console.log(`rounds ${lo}-${hi}: maxOpp (excl. Bron) med ${med(xs.map((o) => o.maxOpp))}, p10 ${[...xs.map((o) => o.maxOpp)].sort((a, b) => a - b)[Math.floor(xs.length * 0.1)]}; paid med ${med(xs.filter((o) => o.winner !== null).map((o) => o.paid))}; share with maxOpp < 15: ${pct(xs.filter((o) => o.maxOpp < 15).length, xs.length)}`);
}
