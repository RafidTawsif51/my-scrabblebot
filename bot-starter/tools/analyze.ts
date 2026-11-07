// Analyzes a dump from fetch-matches.ts.
//   npx tsx tools/analyze.ts <matches.json> [model-out.json]
// Prints spending / word / bid-function stats per bot and, optionally,
// writes a fitted bid model (used by the simulator's "mimic" opponents).

import * as fs from "node:fs";
import { LETTER_VALUES, letterIndex } from "../src/dictionary.js";

interface R { auctionId: number; letter: string; winner: number | null; paid: number; topBid: number | null; closedAt: number }
interface W { botId: number; word: string; reward: number; playedAt: number }
interface M { matchId: number; auctionType: string; players: { botId: number; score: number; balance: number }[]; results: R[]; words: W[] }

const dump = JSON.parse(fs.readFileSync(process.argv[2]!, "utf8")) as { focus: number[]; me: number; matches: M[] };
const NAMES: Record<number, string> = { 114: "Bron", 18: "LUCENT", 167: "Jaeger" };
const bots = [...dump.focus, dump.me];

const face = (l: string) => LETTER_VALUES[letterIndex(l)]!;
const avg = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN);
const med = (xs: number[]) => { const s = [...xs].sort((a, b) => a - b); return s.length ? s[Math.floor(s.length / 2)]! : NaN; };
const pct = (xs: number[], p: number) => { const s = [...xs].sort((a, b) => a - b); return s.length ? s[Math.min(s.length - 1, Math.floor(p * s.length))]! : NaN; };
const f1 = (x: number) => (Number.isNaN(x) ? "-" : x.toFixed(1));

type Obs = { letter: string; round: number; bagLeft: number; balance: number; topBid: number; paid: number; heldSame: number };
const per = new Map<number, {
  matches: number; scores: number[]; ranks: number[]; wins: number; tiles: number[]; paid: number[]; paidByFace: Map<number, number[]>;
  finalBal: number[]; leftover: number[]; wordLens: number[]; rewards: number[]; wordRounds: number[]; pointsByPhase: number[];
  balAtWord: number[]; bids: Obs[]; lostBelow: number;
}>();
for (const b of [...bots, -1]) per.set(b, { matches: 0, scores: [], ranks: [], wins: 0, tiles: [], paid: [], paidByFace: new Map(), finalBal: [], leftover: [], wordLens: [], rewards: [], wordRounds: [], pointsByPhase: [0, 0, 0, 0], balAtWord: [], bids: [], lostBelow: 0 });

for (const m of dump.matches) {
  const n = m.results.length; // auctions in this match
  // Event stream to reconstruct balances: auction closes and word plays.
  type Ev = { t: number; kind: "r"; r: R; idx: number } | { t: number; kind: "w"; w: W };
  const evs: Ev[] = [
    ...m.results.map((r, idx) => ({ t: r.closedAt, kind: "r" as const, r, idx })),
    ...m.words.map((w) => ({ t: w.playedAt, kind: "w" as const, w })),
  ].sort((a, b) => a.t - b.t || (a.kind === "w" ? 1 : -1));
  const bal = new Map<number, number>(m.players.map((p) => [p.botId, 100]));
  const held = new Map<number, Map<string, number>>(m.players.map((p) => [p.botId, new Map()]));
  let closed = 0;
  const wonCount = new Map<number, number>();
  const played = new Map<number, number>();
  for (const e of evs) {
    if (e.kind === "r") {
      const r = e.r;
      closed++;
      if (r.winner !== null) {
        const key = bots.includes(r.winner) ? r.winner : -1;
        const s = per.get(key)!;
        s.paid.push(r.paid);
        if (!s.paidByFace.has(face(r.letter))) s.paidByFace.set(face(r.letter), []);
        s.paidByFace.get(face(r.letter))!.push(r.paid);
        if (r.topBid !== null) {
          s.bids.push({
            letter: r.letter,
            round: closed,
            bagLeft: n - closed,
            balance: bal.get(r.winner) ?? 0,
            topBid: r.topBid,
            paid: r.paid,
            heldSame: held.get(r.winner)?.get(r.letter) ?? 0,
          });
        }
        bal.set(r.winner, (bal.get(r.winner) ?? 0) - r.paid);
        wonCount.set(r.winner, (wonCount.get(r.winner) ?? 0) + 1);
        const h = held.get(r.winner)!;
        h.set(r.letter, (h.get(r.letter) ?? 0) + 1);
      }
    } else {
      const w = e.w;
      const key = bots.includes(w.botId) ? w.botId : -1;
      const s = per.get(key)!;
      s.wordLens.push(w.word.length);
      s.rewards.push(w.reward);
      const round = closed + 1;
      s.wordRounds.push(round);
      s.pointsByPhase[Math.min(3, Math.floor(((round - 1) / Math.max(1, n)) * 4))]! += w.reward;
      s.balAtWord.push(bal.get(w.botId) ?? 0);
      bal.set(w.botId, (bal.get(w.botId) ?? 0) + w.reward);
      played.set(w.botId, (played.get(w.botId) ?? 0) + w.word.length);
      const h = held.get(w.botId)!;
      for (const c of w.word) h.set(c, Math.max(0, (h.get(c) ?? 0) - 1));
    }
  }
  const sorted = [...m.players].sort((a, b) => b.score - a.score);
  for (const p of m.players) {
    const key = bots.includes(p.botId) ? p.botId : -1;
    const s = per.get(key)!;
    s.matches++;
    s.scores.push(p.score);
    const rank = 1 + m.players.filter((q) => q.score > p.score).length;
    s.ranks.push(rank);
    if (rank === 1) s.wins++;
    s.tiles.push(wonCount.get(p.botId) ?? 0);
    s.finalBal.push(p.balance);
    s.leftover.push(5 + (wonCount.get(p.botId) ?? 0) - (played.get(p.botId) ?? 0));
    void sorted;
  }
}

const name = (b: number) => (b === -1 ? "others" : NAMES[b] ?? String(b));
console.log("\n== 1. Spending ==");
for (const [b, s] of per) {
  const byFace = [...s.paidByFace.entries()].sort((a, b2) => a[0] - b2[0]).map(([f, xs]) => `${f}:${f1(avg(xs))}`).join(" ");
  console.log(
    `${name(b).padEnd(7)} matches ${String(s.matches).padStart(4)}  score ${f1(avg(s.scores))}  rank ${f1(avg(s.ranks))}  win ${f1((100 * s.wins) / s.matches)}%  ` +
      `tiles/match ${f1(avg(s.tiles))}  paid/tile ${f1(avg(s.paid))}  endBal ${f1(avg(s.finalBal))} (med ${med(s.finalBal)})  leftoverTiles ${f1(avg(s.leftover))}\n         paid by face ${byFace}`,
  );
}
console.log("\n== 2. Words ==");
for (const [b, s] of per) {
  const lens = new Map<number, number>();
  for (const l of s.wordLens) lens.set(Math.min(l, 8), (lens.get(Math.min(l, 8)) ?? 0) + 1);
  const dist = [...lens.entries()].sort((a, b2) => a[0] - b2[0]).map(([l, c]) => `${l === 8 ? "8+" : l}:${((100 * c) / s.wordLens.length).toFixed(0)}%`).join(" ");
  const tot = s.pointsByPhase.reduce((a, c) => a + c, 0);
  console.log(
    `${name(b).padEnd(7)} words/match ${f1(s.wordLens.length / s.matches)}  avg len ${f1(avg(s.wordLens))}  avg reward ${f1(avg(s.rewards))}  ` +
      `round med ${med(s.wordRounds)}  points by quarter ${s.pointsByPhase.map((x) => ((100 * x) / tot).toFixed(0) + "%").join("/")}  ` +
      `balance when playing med ${med(s.balAtWord)}\n         lengths ${dist}`,
  );
}
console.log("\n== 3. Bid function (winning top bids) ==");
const groups: [string, (l: string) => boolean][] = [
  ["vowels AEIOU", (l) => "AEIOU".includes(l)],
  ["E", (l) => l === "E"],
  ["S", (l) => l === "S"],
  ["1-pt consonants LNRT", (l) => "LNRT".includes(l)],
  ["D G", (l) => "DG".includes(l)],
  ["B C M P", (l) => "BCMP".includes(l)],
  ["F H V W Y", (l) => "FHVWY".includes(l)],
  ["K", (l) => l === "K"],
  ["J X", (l) => "JX".includes(l)],
  ["Q Z", (l) => "QZ".includes(l)],
];
for (const [b, s] of per) {
  if (b === -1) continue;
  console.log(`${name(b)} (${s.bids.length} wins with top bid):`);
  for (const [g, f] of groups) {
    const xs = s.bids.filter((o) => f(o.letter));
    if (!xs.length) continue;
    const top = xs.map((o) => o.topBid);
    console.log(`   ${g.padEnd(22)} n ${String(xs.length).padStart(4)}  bid med ${med(top)}  p25 ${pct(top, 0.25)}  p75 ${pct(top, 0.75)}  paid med ${med(xs.map((o) => o.paid))}  bid/balance med ${f1(100 * med(xs.map((o) => o.topBid / Math.max(1, o.balance))))}%`);
  }
  const phases = [[1, 20], [21, 40], [41, 55], [56, 70]];
  console.log("   by round: " + phases.map(([a, z]) => { const xs = s.bids.filter((o) => o.round >= a! && o.round <= z!).map((o) => o.topBid); return `${a}-${z}: med ${med(xs)} (n ${xs.length})`; }).join("  "));
  const balB = [[0, 30], [30, 60], [60, 100], [100, 1e9]];
  console.log("   by balance: " + balB.map(([a, z]) => { const xs = s.bids.filter((o) => o.balance >= a! && o.balance < z!).map((o) => o.topBid); return `${a}-${z === 1e9 ? "+" : z}: med ${med(xs)} (n ${xs.length})`; }).join("  "));
  const dup = s.bids.filter((o) => o.heldSame > 0).map((o) => o.topBid);
  const fresh = s.bids.filter((o) => o.heldSame === 0).map((o) => o.topBid);
  console.log(`   already holds letter: med ${med(dup)} (n ${dup.length})  vs not: med ${med(fresh)} (n ${fresh.length})`);
}

// Fitted model for the simulator: per-letter median winning bid, plus
// a balance factor (median bid / balance), per focus bot.
const outModel = process.argv[3];
if (outModel) {
  const model: Record<string, unknown> = {};
  for (const b of dump.focus) {
    const s = per.get(b)!;
    const letters: Record<string, { med: number; p25: number; p75: number; n: number }> = {};
    for (let i = 0; i < 26; i++) {
      const L = String.fromCharCode(65 + i);
      let xs = s.bids.filter((o) => o.letter === L).map((o) => o.topBid);
      if (xs.length < 5) xs = s.bids.filter((o) => face(o.letter) === face(L)).map((o) => o.topBid);
      letters[L] = { med: med(xs), p25: pct(xs, 0.25), p75: pct(xs, 0.75), n: xs.length };
    }
    model[name(b)] = { letters, fracMed: med(s.bids.map((o) => o.topBid / Math.max(1, o.balance))) };
  }
  fs.writeFileSync(outModel, JSON.stringify(model, null, 2));
  console.log(`\nwrote bid model to ${outModel}`);
}
