// Offline match simulator that mirrors the module's rules (RULES.md):
// 5-tile private deal, 100 coins, one auction per tile, Vickrey or
// first-price, random tie-break, unsold tiles discarded, match ends right
// after the last auction closes. Module sim bots are reproduced from
// spacetimedb/src/game.ts (decideBid + simulateWordPlay).
//
//   npx tsx src/sim.ts [matches] [vickrey|first]

import {
  BAG_COUNTS,
  countsOf,
  emptyCounts,
  letterIndex,
  letterOf,
  LETTER_VALUES,
  totalOf,
  wordReward,
  type Counts,
  Dictionary,
} from "./dictionary.js";
import { Player, DEFAULT_OPTIONS } from "./player.js";
import { PARAMS, type AuctionKind, type Params } from "./strategy.js";
import { rng } from "./valuation.js";

export type SeatKind = "me" | "alt" | "starter" | "Cheapskate" | "ValueBidder" | "Aggressive";

/** Parameters for "alt" seats (head-to-head comparisons). */
export const ALT_PARAMS: Params = { ...PARAMS };
const isBrain = (k: SeatKind) => k === "me" || k === "alt";

interface Seat {
  kind: SeatKind;
  botId: bigint;
  balance: number;
  score: number;
  rack: Counts;
  spent: number;
  wins: number;
  player?: Player;
}

export interface SeatResult {
  kind: SeatKind;
  score: number;
  balance: number;
  spent: number;
  wins: number;
  leftoverTiles: number;
  rank: number;
}

function simBid(kind: SeatKind, letter: string, balance: number, jitter: number): number {
  const v = LETTER_VALUES[letterIndex(letter)]!;
  const vowel = "AEIOU".includes(letter);
  let base: number;
  if (kind === "Cheapskate") base = v - 1;
  else if (kind === "ValueBidder") base = v;
  else base = v + (vowel ? 4 : 2);
  return Math.max(Math.min(Math.max(base + jitter, 1), balance), 0);
}

// bot-starter's original strategy (with the dictionary bug fixed).
function starterBid(letter: string, balance: number, rack: Counts): number {
  const v = LETTER_VALUES[letterIndex(letter)]!;
  const have = rack[letterIndex(letter)]!;
  const want = have === 0 ? v + 2 : Math.max(1, v);
  return Math.min(want, Math.max(0, balance));
}

/** Module's findBestPlayable: longest word (lex-first among equals) of >= minLen. */
function longestWord(dict: Dictionary, rack: Counts, minLen: number): string | undefined {
  let best: string | undefined;
  for (const c of dict.candidates(rack, minLen)) {
    if (!best || c.len > best.length || (c.len === best.length && c.word < best)) best = c.word;
  }
  return best;
}

export function simulateMatch(
  dict: Dictionary,
  kinds: SeatKind[],
  auctionType: AuctionKind,
  seed: number,
): SeatResult[] {
  const rand = rng(seed);
  const bag = Uint8Array.from(BAG_COUNTS);
  let bagTotal = totalOf(bag);
  const draw = (): string | undefined => {
    if (bagTotal === 0) return undefined;
    let idx = Math.floor(rand() * bagTotal);
    for (let i = 0; i < 26; i++) {
      if (idx < bag[i]!) {
        bag[i]!--;
        bagTotal--;
        return letterOf(i);
      }
      idx -= bag[i]!;
    }
    return undefined;
  };
  const matchId = BigInt(seed);
  const seats: Seat[] = kinds.map((kind, i) => ({
    kind,
    botId: BigInt(i + 1),
    balance: 100,
    score: 0,
    rack: emptyCounts(),
    spent: 0,
    wins: 0,
  }));
  for (const s of seats) {
    for (let n = 0; n < 5; n++) {
      const l = draw();
      if (l) s.rack[letterIndex(l)]!++;
    }
    if (isBrain(s.kind)) {
      s.player = new Player(dict, {
        ...DEFAULT_OPTIONS,
        params: s.kind === "alt" ? ALT_PARAMS : PARAMS,
      });
      s.player.beginMatch(matchId, s.botId, 5, seats.length);
    }
  }
  const everyone = (fn: (p: Player) => void) => {
    for (const s of seats) if (s.player) fn(s.player);
  };
  const syncParticipants = () =>
    everyone((p) => {
      for (const s of seats) p.tracker!.setParticipant(s.botId, s.balance, s.score);
    });
  const play = (s: Seat, word: string): boolean => {
    if (!dict.isWord(word)) return false;
    const need = countsOf(word);
    for (let i = 0; i < 26; i++) if (need[i]! > s.rack[i]!) return false;
    for (let i = 0; i < 26; i++) s.rack[i]! -= need[i]!;
    const r = wordReward(word);
    s.balance += r;
    s.score += r;
    everyone((p) => p.tracker!.onWord(s.botId, word));
    return true;
  };
  const view = (s: Seat) => ({
    rack: s.rack,
    balance: s.balance,
    bagTotal,
    auctionType,
  });
  // Non-sim bots act on their rack whenever the match is running.
  const act = () => {
    for (const s of seats) {
      if (isBrain(s.kind)) {
        for (let guard = 0; guard < 8; guard++) {
          const plan = s.player!.words(view(s));
          if (plan.words.length === 0) break;
          let any = false;
          for (const w of plan.words) any = play(s, w) || any;
          if (!any) break;
        }
      } else if (s.kind === "starter") {
        for (let guard = 0; guard < 8; guard++) {
          const w = longestWord(dict, s.rack, 2);
          if (!w || !play(s, w)) break;
        }
      }
    }
  };

  let auctionId = 0n;
  let letter = draw();
  act();
  while (letter !== undefined) {
    auctionId++;
    everyone((p) => p.tracker!.onAuction(auctionId, letter!));
    syncParticipants();
    const bids: { seat: Seat; amount: number }[] = [];
    for (const s of seats) {
      let amount = 0;
      if (isBrain(s.kind)) {
        amount = s.player!.bid(letter, view(s)).amount;
      } else if (s.kind === "starter") {
        amount = starterBid(letter, s.balance, s.rack);
      } else {
        const jitter = Math.floor(rand() * 5) - 2;
        amount = simBid(s.kind, letter, s.balance, jitter);
      }
      if (amount > 0) bids.push({ seat: s, amount });
    }
    // Close: shuffle then stable sort, as closeAuction does.
    for (let i = bids.length - 1; i >= 1; i--) {
      const j = Math.floor(rand() * (i + 1));
      [bids[i], bids[j]] = [bids[j]!, bids[i]!];
    }
    bids.sort((a, b) => b.amount - a.amount);
    let winner: Seat | undefined;
    let paid = 0;
    if (bids.length > 0) {
      const [first, second] = bids;
      winner = first!.seat;
      paid =
        auctionType === "FirstPrice" ? first!.amount : second ? second.amount : Math.min(1, first!.amount);
      if (winner.balance >= paid) {
        winner.balance -= paid;
        winner.spent += paid;
        winner.wins++;
        winner.rack[letterIndex(letter)]!++;
      }
    }
    everyone((p) => p.tracker!.onResult(auctionId, letter!, winner?.botId, paid));
    if (winner && !isBrain(winner.kind) && winner.kind !== "starter") {
      const w = longestWord(dict, winner.rack, 3);
      if (w) play(winner, w);
    }
    letter = draw();
    if (letter === undefined) break; // match ends in the same transaction
    act();
  }

  const results = seats.map((s) => ({
    kind: s.kind,
    score: s.score,
    balance: s.balance,
    spent: s.spent,
    wins: s.wins,
    leftoverTiles: totalOf(s.rack),
    rank: 0,
  }));
  for (const r of results) r.rank = 1 + results.filter((q) => q.score > r.score).length;
  return results;
}

// ---------- CLI ----------

function summarize(label: string, rows: SeatResult[][], kind: SeatKind) {
  const mine = rows.flatMap((r) => r.filter((s) => s.kind === kind));
  const n = mine.length;
  const avg = (f: (s: SeatResult) => number) => (mine.reduce((a, s) => a + f(s), 0) / n).toFixed(1);
  const wins = mine.filter((s) => s.rank === 1).length;
  const best = rows.map((r) => Math.max(...r.map((s) => s.score)));
  console.log(
    `${label.padEnd(34)} n=${n} score ${avg((s) => s.score)}  rank ${avg((s) => s.rank)}  ` +
      `win ${((100 * wins) / n).toFixed(0)}%  spent ${avg((s) => s.spent)}  ` +
      `tiles ${avg((s) => s.wins)}  ppt ${(mine.reduce((a, s) => a + s.spent, 0) / Math.max(1, mine.reduce((a, s) => a + s.wins, 0))).toFixed(1)}  ` +
      `leftCoins ${avg((s) => s.balance)}  leftTiles ${avg((s) => s.leftoverTiles)}  ` +
      `tableBest ${(best.reduce((a, b) => a + b, 0) / best.length).toFixed(1)}`,
  );
}

const isMain = process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, "/").split("/").pop()!);
if (isMain) {
  // npx tsx src/sim.ts <matches> <vickrey|first> [rows] [key=value ...]
  //   rows: comma list of base,sims,starters,self (default all)
  const n = Number(process.argv[2] ?? 40);
  const type: AuctionKind = process.argv[3] === "first" ? "FirstPrice" : "Vickrey";
  const rowsWanted = new Set((process.argv[4] ?? "base,sims,starters,self").split(","));
  // key=value sets PARAMS (the "me" seats); alt.key=value sets ALT_PARAMS.
  const sets = process.argv.slice(5).map((kv) => kv.split("=") as [string, string]);
  for (const [k0, v] of [...sets.filter(([k]) => !k.startsWith("alt.")), ...sets.filter(([k]) => k.startsWith("alt."))]) {
    const alt = k0.startsWith("alt.");
    const k = alt ? k0.slice(4) : k0;
    if (!(k in PARAMS)) throw new Error(`unknown param ${k}`);
    if (!alt) (PARAMS as Record<string, number>)[k] = Number(v);
    (ALT_PARAMS as Record<string, number>)[k] = Number(v);
  }
  const dict = Dictionary.load();
  const simPool: SeatKind[] = ["Cheapskate", "ValueBidder", "Aggressive", "ValueBidder", "Aggressive", "Cheapskate"];
  const pickSims = (seed: number, k: number): SeatKind[] => {
    const r = rng(seed * 7 + 3);
    const p = [...simPool];
    for (let i = p.length - 1; i >= 1; i--) {
      const j = Math.floor(r() * (i + 1));
      [p[i], p[j]] = [p[j]!, p[i]!];
    }
    return p.slice(0, k);
  };
  const t0 = performance.now();
  const run = (label: string, kind: SeatKind, table: (seed: number) => SeatKind[], also?: SeatKind) => {
    const rows: SeatResult[][] = [];
    for (let i = 0; i < n; i++) rows.push(simulateMatch(dict, table(1000 + i), type, 1000 + i));
    summarize(label, rows, kind);
    if (also) summarize(`  ${also} in same tables`, rows, also);
  };
  const diff = Object.entries(ALT_PARAMS).filter(([k, v]) => (PARAMS as Record<string, number>)[k] !== v);
  console.log(`${n} matches per row, ${type}, PARAMS ${JSON.stringify(PARAMS)}`);
  if (diff.length) console.log(`alt differs: ${JSON.stringify(Object.fromEntries(diff))}`);
  if (rowsWanted.has("h2h")) run("me x3 vs alt x3", "me", () => ["me", "alt", "me", "alt", "me", "alt"], "alt");
  if (rowsWanted.has("duel")) run("me + alt + 4 sims", "me", (s) => ["me", "alt", ...pickSims(s, 4)], "alt");
  // A live-like field: five "alt" bots (tune alt.* to match live prices).
  if (rowsWanted.has("live")) run("me vs 5 alt (live-like)", "me", () => ["me", "alt", "alt", "alt", "alt", "alt"], "alt");
  if (rowsWanted.has("altfield")) run("6 alt (calibration)", "alt", () => ["alt", "alt", "alt", "alt", "alt", "alt"]);
  // One variant (alt) against a live-like field of five defaults (me).
  if (rowsWanted.has("variant")) run("alt vs 5 me (variant test)", "alt", () => ["alt", "me", "me", "me", "me", "me"], "me");
  if (rowsWanted.has("base"))
    run("starter vs 5 sims (baseline)", "starter", (s) => ["starter", ...pickSims(s, 5)]);
  if (rowsWanted.has("sims")) run("me vs 5 sims", "me", (s) => ["me", ...pickSims(s, 5)]);
  if (rowsWanted.has("starters"))
    run("me vs 2 starters + 3 sims", "me", (s) => ["me", "starter", "starter", ...pickSims(s, 3)]);
  if (rowsWanted.has("self")) run("me vs 5 me (self-play)", "me", () => ["me", "me", "me", "me", "me", "me"]);
  console.log(`done in ${((performance.now() - t0) / 1000).toFixed(1)} s`);
}
