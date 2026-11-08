// Per-match bookkeeping from public events (RULES.md §10).
//
// Unknown pool (letters that might still come up) =
//     full bag
//   - every auctioned letter (sold or not: unsold tiles are discarded, §5)
//   - my starting tiles (my rack + my played letters - letters I won)
//   - opponents' starting tiles they have revealed (played - won)
// The pool also contains opponents' unrevealed starting tiles, which are
// indistinguishable from bag tiles from our point of view.

import {
  BAG_COUNTS,
  countsOf,
  emptyCounts,
  letterIndex,
  LETTER_VALUES,
  type Counts,
} from "./dictionary.js";

export interface AuctionRecord {
  id: bigint;
  letter: string;
  closed: boolean;
  winner?: bigint;
  paid: number;
}

export interface Opponent {
  botId: bigint;
  balance: number;
  score: number;
  won: Counts;
  played: Counts;
  words: string[];
  coinsSpent: number;
}

export interface OpponentRack {
  botId: bigint;
  /** Letters known to be in the rack (won at auction, not yet played). */
  known: Counts;
  /** Starting tiles never revealed. */
  unknown: number;
}

function sub0(a: Counts, b: Counts): Counts {
  const out = emptyCounts();
  for (let i = 0; i < 26; i++) out[i] = Math.max(0, a[i]! - b[i]!);
  return out;
}

function addLetter(c: Counts, letter: string) {
  const i = letterIndex(letter);
  if (i >= 0) c[i]!++;
}

export class MatchTracker {
  readonly auctions = new Map<bigint, AuctionRecord>();
  readonly bots = new Map<bigint, Opponent>(); // everyone, me included
  /** Observed `paid` per letter (index), in order. */
  readonly prices: number[][] = Array.from({ length: 26 }, () => []);
  closedCount = 0;
  soldCount = 0;

  constructor(
    readonly matchId: bigint,
    readonly myBotId: bigint,
    readonly startingRackSize: number,
  ) {}

  private bot(botId: bigint): Opponent {
    let b = this.bots.get(botId);
    if (!b) {
      b = {
        botId,
        balance: 0,
        score: 0,
        won: emptyCounts(),
        played: emptyCounts(),
        words: [],
        coinsSpent: 0,
      };
      this.bots.set(botId, b);
    }
    return b;
  }

  setParticipant(botId: bigint, balance: number, score: number) {
    const b = this.bot(botId);
    b.balance = balance;
    b.score = score;
  }

  onAuction(id: bigint, letter: string) {
    if (!this.auctions.has(id)) {
      this.auctions.set(id, { id, letter, closed: false, paid: 0 });
    }
  }

  onResult(id: bigint, letter: string, winner: bigint | undefined, paid: number) {
    let a = this.auctions.get(id);
    if (!a) {
      a = { id, letter, closed: false, paid: 0 };
      this.auctions.set(id, a);
    }
    if (a.closed) return;
    a.closed = true;
    a.winner = winner;
    a.paid = paid;
    this.closedCount++;
    if (winner !== undefined) {
      this.soldCount++;
      const b = this.bot(winner);
      addLetter(b.won, letter);
      b.coinsSpent += paid;
      const li = letterIndex(letter);
      if (li >= 0) this.prices[li]!.push(paid);
    }
  }

  onWord(botId: bigint, word: string) {
    const b = this.bot(botId);
    b.words.push(word);
    for (const c of word) addLetter(b.played, c);
  }

  /** The open auction, if any. */
  openAuction(): AuctionRecord | undefined {
    for (const a of this.auctions.values()) if (!a.closed) return a;
    return undefined;
  }

  me(): Opponent {
    return this.bot(this.myBotId);
  }

  myWins(): number {
    let n = 0;
    for (const a of this.auctions.values()) if (a.closed && a.winner === this.myBotId) n++;
    return n;
  }

  /**
   * Letters not accounted for, given my current rack. `includeOpen` false
   * keeps the open auction's letter in the pool (used for cache keys that
   * must not depend on which letter is up right now).
   */
  pool(myRack: Counts, includeOpen = true): Counts {
    const out = Uint8Array.from(BAG_COUNTS);
    const take = (c: Counts) => {
      for (let i = 0; i < 26; i++) out[i] = Math.max(0, out[i]! - c[i]!);
    };
    const auctioned = emptyCounts();
    for (const a of this.auctions.values()) {
      if (a.closed || includeOpen) addLetter(auctioned, a.letter);
    }
    take(auctioned);
    const me = this.me();
    const myHeld = Uint8Array.from(myRack);
    for (let i = 0; i < 26; i++) myHeld[i] = myHeld[i]! + me.played[i]!;
    take(sub0(myHeld, me.won)); // my starting tiles
    for (const b of this.bots.values()) {
      if (b.botId === this.myBotId) continue;
      take(sub0(b.played, b.won)); // revealed starting tiles
    }
    return out;
  }

  /** Approximate opponent racks: won - played, plus unrevealed starters. */
  opponentRacks(): OpponentRack[] {
    const out: OpponentRack[] = [];
    for (const b of this.bots.values()) {
      if (b.botId === this.myBotId) continue;
      const known = sub0(b.won, b.played);
      const revealedStart = sub0(b.played, b.won);
      let revealed = 0;
      for (let i = 0; i < 26; i++) revealed += revealedStart[i]!;
      out.push({
        botId: b.botId,
        known,
        unknown: Math.max(0, this.startingRackSize - revealed),
      });
    }
    return out;
  }

  /**
   * Estimated price to beat for `letter`: a high percentile of what this
   * letter (or, lacking data, letters of the same face value) sold for.
   */
  marketPrice(letter: string, percentile = 0.75): number | undefined {
    const li = letterIndex(letter);
    if (li < 0) return undefined;
    let obs = this.prices[li]!.slice(-8);
    if (obs.length < 2) {
      const v = LETTER_VALUES[li]!;
      obs = [];
      for (let j = 0; j < 26; j++) {
        if (LETTER_VALUES[j] === v) obs.push(...this.prices[j]!.slice(-6));
      }
    }
    if (obs.length === 0) return undefined;
    const sorted = [...obs].sort((a, b) => a - b);
    return sorted[Math.min(sorted.length - 1, Math.floor(percentile * sorted.length))]!;
  }

  /**
   * Highest balance among opponents in this match (public). Nobody can bid
   * more than their balance, so a bid of maxOppBalance + 1 always wins.
   * Every participant counts: a bot that hasn't bid yet still could.
   */
  maxOppBalance(): number {
    let m = 0;
    for (const b of this.bots.values()) if (b.botId !== this.myBotId && b.balance > m) m = b.balance;
    return m;
  }

  /** Sum of opponents' balances. */
  oppTotalBalance(): number {
    let s = 0;
    for (const b of this.bots.values()) if (b.botId !== this.myBotId) s += Math.max(0, b.balance);
    return s;
  }

  /**
   * This match's clearing price for `letter`'s class (face 1 / 2 / 3 /
   * 4-5 / 8-10): the median `paid` of the last 10 sold tiles in that class.
   * Needs 5+ sold auctions this match; a class with < 2 sales is
   * estimated as `fallback` × (this match's mean paid / mean fallback
   * price of the tiles sold). Undefined until then.
   */
  classPrice(letter: string, fallback: (l: string) => number): number | undefined {
    const sold = [...this.auctions.values()].filter((a) => a.closed && a.winner !== undefined);
    if (sold.length < 5) return undefined;
    const cls = (l: string) => {
      const v = LETTER_VALUES[letterIndex(l)] ?? 1;
      return v >= 8 ? 8 : v >= 4 ? 4 : v;
    };
    const mine = sold.filter((a) => cls(a.letter) === cls(letter)).slice(-10).map((a) => a.paid);
    if (mine.length >= 2) {
      const s = [...mine].sort((a, b) => a - b);
      return s[Math.floor(s.length / 2)]!;
    }
    const paid = sold.reduce((t, a) => t + a.paid, 0) / sold.length;
    const ref = sold.reduce((t, a) => t + fallback(a.letter), 0) / sold.length;
    return ref > 0 ? fallback(letter) * (paid / ref) : undefined;
  }

  /** What I paid over the last `window` closed auctions: { spent, auctions }. */
  recentMySpend(window: number): { spent: number; auctions: number } {
    const closed = [...this.auctions.values()].filter((a) => a.closed).slice(-window);
    return {
      spent: closed.reduce((t, a) => t + (a.winner === this.myBotId ? a.paid : 0), 0),
      auctions: closed.length,
    };
  }

  /** Mean price paid for sold tiles so far (default 4 before any sale). */
  avgPrice(): number {
    let sum = 0;
    let n = 0;
    for (const a of this.auctions.values()) {
      if (a.closed && a.winner !== undefined) {
        sum += a.paid;
        n++;
      }
    }
    return n === 0 ? 4 : (sum + 4 * 2) / (n + 2);
  }

  /** My rank (1 = best), with ties sharing the higher place (§4). */
  rankOf(botId: bigint): number {
    const mine = this.bots.get(botId)?.score ?? 0;
    let higher = 0;
    for (const b of this.bots.values()) if (b.score > mine) higher++;
    return higher + 1;
  }
}

export { countsOf };
