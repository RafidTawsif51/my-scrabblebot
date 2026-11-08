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
import { PARAMS, planWords, type AuctionKind, type Params } from "./strategy.js";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { BingoIndex, relativeGain } from "./bingo.js";
import { rng } from "./valuation.js";

export type SeatKind =
  | "me"
  | "alt"
  | "starter"
  | "bron"
  | "lucent"
  | "bronlike"
  | "lucentlike"
  | "other"
  | "Cheapskate"
  | "ValueBidder"
  | "Aggressive";

/** Parameters for "alt" seats (head-to-head comparisons). */
export const ALT_PARAMS: Params = { ...PARAMS };
const isBrain = (k: SeatKind) => k === "me" || k === "alt";
const isMimic = (k: SeatKind) => k === "bron" || k === "lucent";
const isLike = (k: SeatKind) => k === "bronlike" || k === "lucentlike";

// ---------- Bron-like / LUCENT-like players (calibrated to live stats) ----------
// Bid the bot's live market median on letters that move the rack toward a
// 7-8 letter word (bingo leave), a fraction of it otherwise; play every
// 7+ letter word at once; dump everything at the endgame.
// Calibration (2026-11-07): with fitMult 1.8 / unfitMult 0.8 and weak
// others (pBid 0.4) these rules reproduce Bron's live volume and word
// profile (~20 tiles, ~9/tile, ~4 words, 65% 7+, ~110 points), but in that
// field our own current bot would score ~118 vs ~83 live. Defaults below
// are the "cal2" fit instead, which reproduces Jaeger's live stats (83
// points, 12.5 tiles, 11.9/tile); in it these Bron-like rules score ~66,
// so Bron's real edge is something this sim does not model.
export const LIKE = {
  /** A letter "fits" if its leave gain is at least this share of the best letter's. */
  fitRel: 0.25,
  fitMult: 1.3,
  unfitMult: 1.0,
  dup: 0.7,
  late: 1.3,
  lateRound: 55,
  /** Share of balance one bid may use (all of it in the last 3 auctions). */
  capFrac: 0.6,
  /** Spend-down: in the last N playable auctions, bid at least balance / N on fitting letters. */
  spendDown: 10,
  endgameBag: 3,
  /** 1: choose among 7+ words by reward + leave of what remains; 0: highest reward. */
  smartSeven: 0,
  /** Fit boost for high-value letters: relGain × (1 + hvBoost × (face - 1) / 9). */
  hvBoost: 3,
};
/** Live "others" (≈53 points, 8.6 tiles): mimic bids scaled, play words of minLen+ at once. */
export const OTHER = { scale: 1.0, minLen: 6, endgameBag: 3, pBid: 0.9 };

/** Every bid made by me/alt seats in this process (for comparing with live logs). */
export const BID_LOG: {
  kind: SeatKind;
  letter: string;
  amount: number;
  value: number;
  bag: number;
  balance: number;
  reason: string;
  maxOpp: number;
}[] = [];

let BINGO: BingoIndex | null = null;
const bingoFor = (dict: Dictionary) => (BINGO ??= new BingoIndex(dict));

function likeBid(
  dict: Dictionary,
  kind: SeatKind,
  letter: string,
  round: number,
  bagTotal: number,
  rack: Counts,
  balance: number,
): number {
  const li = letterIndex(letter);
  const q = MODEL[kind === "bronlike" ? "Bron" : "LUCENT"]!.letters[letter]!;
  const info = bingoFor(dict).leave(rack);
  const face = LETTER_VALUES[li]!;
  const fits = relativeGain(info, li) * (1 + (LIKE.hvBoost * (face - 1)) / 9) >= LIKE.fitRel;
  let b = q.med * (fits ? LIKE.fitMult : LIKE.unfitMult);
  if (rack[li]! > 0) b *= LIKE.dup;
  if (round > LIKE.lateRound) b *= LIKE.late;
  if (LIKE.spendDown > 0 && fits && bagTotal <= LIKE.spendDown) {
    b = Math.max(b, balance / Math.max(1, bagTotal));
  }
  if (bagTotal === 0) return 0; // last tile can't be played
  const cap = bagTotal <= 3 ? balance : Math.floor(balance * LIKE.capFrac);
  return Math.max(0, Math.min(cap, Math.round(b)));
}

/** Words a Bron-like player plays now. */
function likeWords(dict: Dictionary, rack: Counts, bagTotal: number): string[] {
  if (bagTotal <= LIKE.endgameBag) return dict.bestPlays(rack).words;
  const sevens = dict.candidates(rack, 7);
  if (sevens.length === 0) return [];
  if (!LIKE.smartSeven) return [sevens[0]!.word];
  // Prefer the 7+ word whose leftover rack keeps the best bingo leave.
  let best = sevens[0]!.word;
  let bestV = -1;
  for (const c of sevens.slice(0, 12)) {
    const rest = Uint8Array.from(rack);
    for (const ch of c.word) rest[letterIndex(ch)]!--;
    const v = c.reward + 0.02 * bingoFor(dict).leave(rest).score;
    if (v > bestV) {
      bestV = v;
      best = c.word;
    }
  }
  return [best];
}

// ---------- Bron / LUCENT mimics ----------
// Bid model fitted from live data (tools/analyze.ts → tools/bidmodel.json):
// per letter, the p25 / median / p75 of their winning bids.
type BidQ = { med: number; p25: number; p75: number };
const MODEL = JSON.parse(
  fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "tools", "bidmodel.json"), "utf8"),
) as Record<string, { letters: Record<string, BidQ> }>;

/** Calibration knobs, set so simulated mimics reproduce live stats. */
export const MIMIC = {
  /** Multiplier on the fitted (winning-bid) quantiles. */
  scale: 1,
  /** Bid factor for a letter already held (live: ~0.7). */
  dup: 0.7,
  /** Bid factor after `lateRound` (live: medians rise ~30% late). */
  late: 1.3,
  lateRound: 55,
  /** Never bid more than this share of balance (live: they keep a reserve). */
  capFrac: 0.5,
  /** Cash in a word at or below this balance. */
  lowBalance: 3,
};
/** Word policy of the mimics: hoard toward 7+, cash in when low, dump at the end. */
const mimicWords = (): Params => ({ ...PARAMS, endgameBag: 4, lowBalance: MIMIC.lowBalance, maxHoard: 16 });

function mimicBid(
  kind: SeatKind,
  letter: string,
  round: number,
  held: number,
  balance: number,
  rand: () => number,
): number {
  const q = MODEL[kind === "bron" ? "Bron" : "LUCENT"]!.letters[letter]!;
  const u = rand();
  let b = u < 0.5 ? q.p25 + (q.med - q.p25) * (u / 0.5) : q.med + (q.p75 - q.med) * ((u - 0.5) / 0.5);
  b *= MIMIC.scale;
  if (held > 0) b *= MIMIC.dup;
  if (round > MIMIC.lateRound) b *= MIMIC.late;
  const cap = round > 64 ? balance : Math.floor(balance * MIMIC.capFrac);
  return Math.max(0, Math.min(cap, Math.round(b)));
}

interface Seat {
  kind: SeatKind;
  botId: bigint;
  balance: number;
  score: number;
  rack: Counts;
  spent: number;
  wins: number;
  player?: Player;
  winBids: { letter: string; bid: number; round: number }[];
  wordLens: number[];
}

export interface SeatResult {
  kind: SeatKind;
  score: number;
  balance: number;
  spent: number;
  wins: number;
  leftoverTiles: number;
  rank: number;
  /** Winning (top) bids, for calibrating mimics against live data. */
  winBids: { letter: string; bid: number; round: number }[];
  wordLens: number[];
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
    winBids: [],
    wordLens: [],
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
    s.wordLens.push(word.length);
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
      } else if (isLike(s.kind)) {
        for (let guard = 0; guard < 8; guard++) {
          const ws = likeWords(dict, s.rack, bagTotal);
          if (ws.length === 0) break;
          let any = false;
          for (const w of ws) any = play(s, w) || any;
          if (!any) break;
        }
      } else if (s.kind === "other") {
        for (let guard = 0; guard < 8; guard++) {
          const ws =
            bagTotal <= OTHER.endgameBag
              ? dict.bestPlays(s.rack).words
              : dict.candidates(s.rack, OTHER.minLen).slice(0, 1).map((c) => c.word);
          if (ws.length === 0) break;
          let any = false;
          for (const w of ws) any = play(s, w) || any;
          if (!any) break;
        }
      } else if (isMimic(s.kind)) {
        for (let guard = 0; guard < 8; guard++) {
          const plan = planWords({
            dict,
            rack: s.rack,
            bagTotal,
            balance: s.balance,
            panic: false,
            needCoins: false,
            params: mimicWords(),
          });
          if (plan.words.length === 0) break;
          let any = false;
          for (const w of plan.words) any = play(s, w) || any;
          if (!any) break;
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
        const out = s.player!.bid(letter, view(s));
        amount = out.amount;
        BID_LOG.push({
          kind: s.kind,
          letter,
          amount,
          value: out.value,
          bag: bagTotal,
          balance: s.balance,
          reason: out.reason,
          maxOpp: Math.max(...seats.filter((o) => o !== s).map((o) => o.balance)),
        });
      } else if (s.kind === "starter") {
        amount = starterBid(letter, s.balance, s.rack);
      } else if (isMimic(s.kind)) {
        amount = mimicBid(s.kind, letter, Number(auctionId), s.rack[letterIndex(letter)]!, s.balance, rand);
      } else if (isLike(s.kind)) {
        amount = likeBid(dict, s.kind, letter, Number(auctionId), bagTotal, s.rack, s.balance);
      } else if (s.kind === "other") {
        const b = mimicBid("bron", letter, Number(auctionId), s.rack[letterIndex(letter)]!, s.balance, rand);
        amount = rand() < OTHER.pBid ? Math.round(OTHER.scale * b) : 0;
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
        winner.winBids.push({ letter, bid: first!.amount, round: Number(auctionId) });
        winner.rack[letterIndex(letter)]!++;
      }
    }
    everyone((p) => p.tracker!.onResult(auctionId, letter!, winner?.botId, paid));
    const moduleSim = (k: SeatKind) => k === "Cheapskate" || k === "ValueBidder" || k === "Aggressive";
    if (winner && moduleSim(winner.kind)) {
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
    winBids: s.winBids,
    wordLens: s.wordLens,
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
      `words ${avg((s) => s.wordLens.length)}  7+ ${(() => { const l = mine.flatMap((s) => s.wordLens); return l.length ? ((100 * l.filter((x) => x >= 7).length) / l.length).toFixed(0) : "-"; })()}%  ` +
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
    if (k0.startsWith("like.") || k0.startsWith("other.")) {
      const obj = (k0.startsWith("like.") ? LIKE : OTHER) as Record<string, number>;
      const k = k0.slice(k0.indexOf(".") + 1);
      if (!(k in obj)) throw new Error(`unknown param ${k0}`);
      obj[k] = Number(v);
      continue;
    }
    if (k0.startsWith("mimic.")) {
      const k = k0.slice(6);
      if (!(k in MIMIC)) throw new Error(`unknown mimic param ${k}`);
      (MIMIC as Record<string, number>)[k] = Number(v);
      continue;
    }
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
  const run = (label: string, kind: SeatKind, table: (seed: number) => SeatKind[], ...also: SeatKind[]) => {
    const rows: SeatResult[][] = [];
    for (let i = 0; i < n; i++) rows.push(simulateMatch(dict, table(1000 + i), type, 1000 + i));
    summarize(label, rows, kind);
    for (const a of also) summarize(`  ${a} in same tables`, rows, a);
    LAST_ROWS = rows;
    return rows;
  };
  let LAST_ROWS: SeatResult[][] = [];
  // Median winning bid by letter group, to compare with tools/analyze.ts.
  const groups: [string, string][] = [["vowels", "AEIOU"], ["LNRT", "LNRT"], ["S", "S"], ["DG", "DG"], ["BCMP", "BCMP"], ["FHVWY", "FHVWY"], ["JX", "JX"], ["QZ", "QZ"]];
  const bidProfile = (rows: SeatResult[][], kind: SeatKind) => {
    const bids = rows.flatMap((r) => r.filter((s) => s.kind === kind).flatMap((s) => s.winBids));
    const med = (xs: number[]) => { const s = [...xs].sort((a, b) => a - b); return s.length ? s[Math.floor(s.length / 2)] : "-"; };
    const lens = rows.flatMap((r) => r.filter((s) => s.kind === kind).flatMap((s) => s.wordLens));
    const seven = lens.filter((l) => l >= 7).length;
    console.log(
      `    ${kind} winning-bid medians: ` +
        groups.map(([g, ls]) => `${g} ${med(bids.filter((b) => ls.includes(b.letter)).map((b) => b.bid))}`).join("  ") +
        `  | rounds 1-20 ${med(bids.filter((b) => b.round <= 20).map((b) => b.bid))} 56+ ${med(bids.filter((b) => b.round > 55).map((b) => b.bid))}` +
        `  | words 7+ ${lens.length ? ((100 * seven) / lens.length).toFixed(0) : "-"}%`,
    );
  };
  // Live-calibration table: Bron + LUCENT + 4 "others" (old-Jaeger-like alt).
  if (rowsWanted.has("cal")) {
    const rows = run("cal: bron", "bron", () => ["bron", "lucent", "alt", "alt", "alt", "alt"], "lucent", "alt");
    bidProfile(rows, "bron");
    bidProfile(rows, "lucent");
  }
  // Tuning field: me against five Bron/LUCENT mimics.
  if (rowsWanted.has("mimic")) {
    const rows = run("me vs 5 mimics", "me", () => ["me", "bron", "lucent", "bron", "lucent", "bron"], "bron", "lucent");
    bidProfile(rows, "me");
  }
  // Same seeds with the variant in my seat (paired comparison).
  if (rowsWanted.has("mimicalt")) {
    const rows = run("alt vs 5 mimics", "alt", () => ["alt", "bron", "lucent", "bron", "lucent", "bron"], "bron", "lucent");
    bidProfile(rows, "alt");
  }
  if (rowsWanted.has("mixed")) run("me + bron + lucent + 3 old", "me", () => ["me", "bron", "lucent", "alt", "alt", "alt"], "bron", "lucent", "alt");
  const diff = Object.entries(ALT_PARAMS).filter(([k, v]) => (PARAMS as Record<string, number>)[k] !== v);
  console.log(`${n} matches per row, ${type}, PARAMS ${JSON.stringify(PARAMS)}`);
  if (diff.length) console.log(`alt differs: ${JSON.stringify(Object.fromEntries(diff))}`);
  console.log(`MIMIC ${JSON.stringify(MIMIC)} LIKE ${JSON.stringify(LIKE)} OTHER ${JSON.stringify(OTHER)}`);
  // Calibration: live tables are Bron + LUCENT + weaker "others".
  if (rowsWanted.has("likecal"))
    run("likecal: bronlike", "bronlike", () => ["bronlike", "lucentlike", "other", "other", "other", "other"], "lucentlike", "other");
  // Calibration anchored on Jaeger too: the current version (alt) should
  // land near its live stats (~83 points, ~12.5 tiles, ~12/tile).
  if (rowsWanted.has("cal2"))
    run("cal2: bronlike", "bronlike", () => ["bronlike", "lucentlike", "alt", "other", "other", "other"], "lucentlike", "alt", "other");
  // Live-like table, and a hard table of only Bron/LUCENT-likes; *alt rows
  // put the variant (alt) in my seat on the same seeds.
  if (rowsWanted.has("like"))
    run("me + bronlike + lucentlike + 3 others", "me", () => ["me", "bronlike", "lucentlike", "other", "other", "other"], "bronlike", "lucentlike");
  let likeRows: SeatResult[][] | undefined;
  if (rowsWanted.has("like")) likeRows = LAST_ROWS;
  if (rowsWanted.has("likealt")) {
    const altRows = run("alt + bronlike + lucentlike + 3 others", "alt", () => ["alt", "bronlike", "lucentlike", "other", "other", "other"], "bronlike", "lucentlike");
    if (likeRows) {
      // Same seeds: per-match difference of my seat's score (variant - current).
      const d = altRows.map((r, i) => r[0]!.score - likeRows![i]![0]!.score);
      const mean = d.reduce((a, b) => a + b, 0) / d.length;
      const sd = Math.sqrt(d.reduce((a, b) => a + (b - mean) ** 2, 0) / (d.length - 1));
      const se = sd / Math.sqrt(d.length);
      const wins = altRows.filter((r) => r[0]!.rank === 1).length - likeRows.filter((r) => r[0]!.rank === 1).length;
      console.log(`paired: variant - current = ${mean.toFixed(2)} ± ${se.toFixed(2)} (SE, n ${d.length}); 95% CI [${(mean - 1.96 * se).toFixed(2)}, ${(mean + 1.96 * se).toFixed(2)}]; first places ${wins >= 0 ? "+" : ""}${wins}`);
    }
  }
  if (rowsWanted.has("hard"))
    run("me vs 5 bron/lucent-likes", "me", () => ["me", "bronlike", "lucentlike", "bronlike", "lucentlike", "bronlike"], "bronlike", "lucentlike");
  if (rowsWanted.has("hardalt"))
    run("alt vs 5 bron/lucent-likes", "alt", () => ["alt", "bronlike", "lucentlike", "bronlike", "lucentlike", "bronlike"], "bronlike", "lucentlike");
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
  if (rowsWanted.has("bidprofile")) {
    const med = (xs: number[]) => { const s = [...xs].sort((a, b) => a - b); return s.length ? s[Math.floor(s.length / 2)]! : NaN; };
    for (const kind of ["me", "alt"] as SeatKind[]) {
      const bl = BID_LOG.filter((b) => b.kind === kind);
      if (!bl.length) continue;
      console.log(`${kind} bids ${bl.length}, zero ${((100 * bl.filter((b) => b.amount === 0).length) / bl.length).toFixed(0)}%`);
      const trig = (s: string) => bl.filter((b) => b.reason.includes(s)).length;
      console.log(
        `  balance-aware: vickrey sure-win ${trig("sure-win")}, fp guaranteed ${trig("guaranteed")}, fp capped ${trig("capped")} | ` +
          `maxOpp med by bag: >=45 ${med(bl.filter((b) => b.bag >= 45).map((b) => b.maxOpp))}, 15-44 ${med(bl.filter((b) => b.bag < 45 && b.bag >= 15).map((b) => b.maxOpp))}, <15 ${med(bl.filter((b) => b.bag < 15).map((b) => b.maxOpp))}; share maxOpp<15 ${((100 * bl.filter((b) => b.maxOpp < 15).length) / bl.length).toFixed(1)}%`,
      );
      for (const [g, ls] of [["vowels", "AEIOU"], ["LNRST", "LNRST"], ["DG", "DG"], ["BCMP", "BCMP"], ["FHVWY", "FHVWY"], ["JKXQZ", "JKXQZ"]]) {
        const xs = bl.filter((b) => ls!.includes(b.letter));
        console.log(`  ${g!.padEnd(7)} value med ${med(xs.map((b) => b.value)).toFixed(1)}  bid med ${med(xs.map((b) => b.amount))}  balance med ${med(xs.map((b) => b.balance))}`);
      }
    }
  }
  console.log(`done in ${((performance.now() - t0) / 1000).toFixed(1)} s`);
}
