// The bot's brain, independent of the network: it holds the match tracker,
// the letter-value cache, and turns game state into bids and word plays.
// index.ts wires it to SpacetimeDB; sim.ts wires it to an offline engine.

import { countsKey, letterIndex, totalOf, type Counts, type Dictionary } from "./dictionary.js";
import {
  decideBid,
  PARAMS,
  planWords,
  type AuctionKind,
  type BidDecision,
  type Params,
  type WordPlan,
} from "./strategy.js";
import { MatchTracker } from "./tracker.js";
import { lettersByLikelihood, valueLetterNow, ValuationJob } from "./valuation.js";

export interface PlayerView {
  rack: Counts;
  balance: number;
  /** Tiles left in the bag, excluding the one on auction. */
  bagTotal: number;
  auctionType: AuctionKind;
}

export interface PlayerOptions {
  /** Strategy parameters (defaults to strategy.PARAMS), incl. Monte Carlo sizes. */
  params?: Params;
}

export const DEFAULT_OPTIONS: PlayerOptions = {};

export interface BidOutcome extends BidDecision {
  value: number;
  source: "cache" | "now";
  futureDraws: number;
  market?: number;
}

export class Player {
  tracker: MatchTracker | null = null;
  numPlayers = 6;
  /** Set when a reducer took too long: stop hoarding for the rest of the match. */
  panic = false;
  needCoins = false;
  private cache = new Map<string, ValuationJob>();
  private queue: { key: string; job: ValuationJob }[] = [];
  private seed = 1;

  constructor(
    readonly dict: Dictionary,
    readonly opts: PlayerOptions = DEFAULT_OPTIONS,
  ) {}

  beginMatch(matchId: bigint, myBotId: bigint, startingRackSize: number, numPlayers: number) {
    this.tracker = new MatchTracker(matchId, myBotId, startingRackSize);
    this.numPlayers = Math.max(2, numPlayers);
    this.panic = false;
    this.needCoins = false;
    this.cache.clear();
    this.queue = [];
    this.last = null;
    this.seed = Number(matchId % 1000003n) + 1;
  }

  endMatch() {
    this.tracker = null;
    this.cache.clear();
    this.queue = [];
  }

  /**
   * K: tiles I expect to win in the playable auctions after this one, from
   * my win rate so far (prior: a fair share). The last auction's tile can't
   * be played, so it doesn't count.
   */
  futureDraws(wins: number, closed: number, bagTotal: number): number {
    const future = Math.max(0, bagTotal - 1);
    const w = 6;
    const rate = (wins + w / this.numPlayers) / (closed + w);
    return Math.min(this.P.maxFuture, Math.round(rate * future * this.P.futureScale));
  }

  private get P(): Params {
    return this.opts.params ?? PARAMS;
  }

  private key(rack: Counts, k: number, closed: number): string {
    return `${countsKey(rack)}|${k}|${closed}`;
  }

  /** Points value of `letter` for my rack now. */
  valueOf(letter: string, view: PlayerView): { value: number; source: "cache" | "now"; k: number } {
    const t = this.tracker!;
    const li = letterIndex(letter);
    if (li < 0) return { value: 0, source: "now", k: 0 };
    const k = this.futureDraws(t.myWins(), t.closedCount, view.bagTotal);
    const cached = this.cache.get(this.key(view.rack, k, t.closedCount))?.value(li);
    if (cached !== undefined) return { value: cached, source: "cache", k };
    const pool = t.pool(view.rack, true);
    const v = valueLetterNow(this.dict, view.rack, pool, k, this.P.mcQuick, li, this.seed++);
    return { value: v, source: "now", k };
  }

  /** Decide the bid for the open auction, then queue precompute for the next one. */
  bid(letter: string, view: PlayerView): BidOutcome {
    const t = this.tracker!;
    const { value, source, k } = this.valueOf(letter, view);
    const market = t.marketPrice(letter);
    const dec = decideBid({
      letter,
      valuePoints: value,
      balance: view.balance,
      bagTotal: view.bagTotal,
      auctionType: view.auctionType,
      marketPrice: market,
      avgPrice: t.avgPrice(),
      params: this.opts.params,
    });
    this.needCoins = dec.desired > view.balance && dec.desired > 0;
    this.last = { letter, bid: dec.amount, market };
    this.schedulePrecompute(letter, view, dec.amount, market);
    return { ...dec, value, source, futureDraws: k, market };
  }

  private last: { letter: string; bid: number; market?: number } | null = null;

  /** My rack changed mid-auction (a word was played): redo the precompute. */
  reschedule(view: PlayerView) {
    if (!this.tracker || !this.last) return;
    const open = this.tracker.openAuction();
    if (!open || open.letter !== this.last.letter) return;
    this.schedulePrecompute(this.last.letter, view, this.last.bid, this.last.market);
  }

  /**
   * While this auction runs, value all letters for the two racks I might
   * hold when the next auction opens: without this tile (lose) and with it
   * (win). The likelier outcome goes first.
   */
  schedulePrecompute(letter: string, view: PlayerView, myBid: number, market?: number) {
    const t = this.tracker;
    if (!t) return;
    const li = letterIndex(letter);
    const closedNext = t.closedCount + 1;
    const bagNext = view.bagTotal - 1;
    if (bagNext < 1) {
      this.queue = [];
      return; // the next auction (if any) is the unplayable last one
    }
    const wins = t.myWins();
    const pool = t.pool(view.rack, true); // the open letter is gone either way
    const lose = { rack: view.rack, k: this.futureDraws(wins, closedNext, bagNext) };
    const winRack = Uint8Array.from(view.rack);
    if (li >= 0) winRack[li]!++;
    const win = { rack: winRack, k: this.futureDraws(wins + 1, closedNext, bagNext) };
    const likelyWin = myBid > 0 && myBid >= (market ?? 3);
    const order = myBid <= 0 ? [lose] : likelyWin ? [win, lose] : [lose, win];
    this.queue = [];
    const keep = new Map<string, ValuationJob>();
    for (const s of order) {
      const key = this.key(s.rack, s.k, closedNext);
      const job = new ValuationJob(this.dict, {
        rack: s.rack,
        pool,
        futureDraws: s.k,
        samples: this.P.mcSamples,
        letters: lettersByLikelihood(pool),
        seed: this.seed++,
      });
      keep.set(key, job);
      this.queue.push({ key, job });
    }
    this.cache = keep;
  }

  /** Run queued valuation work until `deadline`. Returns true if work remains. */
  pump(deadline: number): boolean {
    while (this.queue.length > 0) {
      const head = this.queue[0]!;
      if (!head.job.step(deadline)) return true;
      this.queue.shift();
    }
    return false;
  }

  hasWork(): boolean {
    return this.queue.length > 0;
  }

  /** Words to play now, given the rack actually available. */
  words(view: PlayerView): WordPlan {
    const plan = planWords({
      dict: this.dict,
      rack: view.rack,
      bagTotal: view.bagTotal,
      balance: view.balance,
      panic: this.panic,
      needCoins: this.needCoins,
      params: this.opts.params,
    });
    if (plan.words.length > 0 && plan.reason.startsWith("need coins")) this.needCoins = false;
    return plan;
  }

  rackSize(rack: Counts): number {
    return totalOf(rack);
  }
}
