// The bot's brain, independent of the network: it holds the match tracker,
// the letter-value cache, and turns game state into bids and word plays.
// index.ts wires it to SpacetimeDB; sim.ts wires it to an offline engine.

import { countsKey, letterIndex, LETTER_VALUES, totalOf, type Counts, type Dictionary } from "./dictionary.js";
import { BingoIndex, relativeGain } from "./bingo.js";
import { marketPrice as liveMarketPrice } from "./market.js";
import {
  allInWindow,
  applyHeadsUp,
  decideBid,
  dynamicEndgameBag,
  EXACT_BEAM,
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
  /**
   * Legacy "dump everything now" switch. Never set any more: a latency
   * spike raises the endgame threshold instead (see endgameBag).
   */
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
  valueOf(letter: string, view: PlayerView, fast = false): { value: number; source: "cache" | "now"; k: number } {
    const t = this.tracker!;
    const li = letterIndex(letter);
    if (li < 0) return { value: 0, source: "now", k: 0 };
    const k = this.futureDraws(t.myWins(), t.closedCount, view.bagTotal);
    const cached = this.cache.get(this.key(view.rack, k, t.closedCount))?.value(li);
    if (cached !== undefined) return { value: cached, source: "cache", k };
    const pool = t.pool(view.rack, true);
    // Fast path (instant bid on auction arrival): a few samples only; the
    // refined bid right after uses the full sample count.
    const samples = fast ? Math.min(6, this.P.mcQuick) : this.P.mcQuick;
    const v = valueLetterNow(this.dict, view.rack, pool, k, samples, li, this.seed++);
    return { value: v, source: "now", k };
  }

  /** Decide the bid for the open auction, then queue precompute for the next one. */
  private bingo: BingoIndex | null = null;

  /** Lucent2 endgame: how much `letter` raises the exact best partition of my rack. */
  endgameGain(rack: Counts, letter: number, fast = false): number {
    const withL = Uint8Array.from(rack);
    withL[letter]!++;
    const beam = fast ? undefined : EXACT_BEAM;
    return this.dict.bestPlays(withL, beam).total - this.dict.bestPlays(rack, beam).total;
  }

  /** Lucent2e: reward of the 7+ word `letter` makes playable now (0 if none / no better). */
  completionReward(rack: Counts, letter: number): number {
    const withL = Uint8Array.from(rack);
    withL[letter]!++;
    const after = this.dict.candidates(withL, 7)[0];
    if (!after) return 0;
    const before = this.dict.candidates(rack, 7)[0];
    return !before || after.reward > before.reward ? after.reward : 0;
  }

  /** Lucent2e heads-up denial: what `letter` adds to the rival's known rack. */
  private rivalValue(letter: number): number {
    const rival = this.tracker!.opponentRacks()[0];
    if (!rival) return 0;
    const withL = Uint8Array.from(rival.known);
    withL[letter]!++;
    return this.dict.bestPlays(withL).total - this.dict.bestPlays(rival.known).total;
  }

  bid(letter: string, view: PlayerView, opts: { fast?: boolean } = {}): BidOutcome {
    const t = this.tracker!;
    const li = letterIndex(letter);
    const fast = opts.fast === true;
    const { value, source, k } = this.valueOf(letter, view, fast);
    const market = t.marketPrice(letter);
    let fit: number | undefined;
    if (this.P.lucentMode > 0 || this.P.fuelMode > 0) {
      this.bingo ??= new BingoIndex(this.dict);
      const face = LETTER_VALUES[li]!;
      fit = relativeGain(this.bingo.leave(view.rack), li) * (1 + (this.P.hvBoost * (face - 1)) / 9);
    }
    let dec = decideBid({
      letter,
      valuePoints: value,
      balance: view.balance,
      bagTotal: view.bagTotal,
      auctionType: view.auctionType,
      marketPrice: market,
      avgPrice: t.avgPrice(),
      floorPrice: t.marketPrice(letter, 0.5),
      fit,
      market: liveMarketPrice(letter),
      held: li >= 0 ? view.rack[li]! : 0,
      round: t.closedCount + 1,
      maxOppBalance: t.maxOppBalance(),
      oppTotalBalance: t.oppTotalBalance(),
      matchPrice: this.P.fuelMode > 0 ? t.classPrice(letter, liveMarketPrice) : undefined,
      endgameGain:
        this.P.lucent2 > 0 &&
        li >= 0 &&
        view.bagTotal <=
          (this.P.l2AllIn > 0 ? Math.max(this.P.l2EndBag, allInWindow(this.P, this.endgameBag())) : this.P.l2EndBag)
          ? this.endgameGain(view.rack, li, fast)
          : undefined,
      dumpBag: this.endgameBag(),
      completionReward: this.P.l2eComplete > 0 && li >= 0 ? this.completionReward(view.rack, li) : undefined,
      recentSpend:
        this.P.fuelMode > 0
          ? t.recentMySpend(this.P.fuelCtrlWindow)
          : this.P.lucent3 > 0
            ? t.recentMySpend(this.P.l3Window)
            : undefined,
      params: this.opts.params,
    });
    // Lucent2e heads-up profile: exactly 2 players only; any error keeps the normal bid.
    if (this.P.l2eHeadsUp > 0 && this.numPlayers === 2 && li >= 0) {
      try {
        dec = applyHeadsUp(
          dec,
          {
            value,
            balance: view.balance,
            going: t.marketPrice(letter, 0.5) ?? liveMarketPrice(letter),
            rivalValue: this.rivalValue(li),
            bagTotal: view.bagTotal,
          },
          this.P,
        );
      } catch {
        /* fall back to the normal bid */
      }
    }
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

  // Word reducer latencies (ms), kept across matches, newest last.
  private wordLatencies: number[] = [];
  auctionMs = 1000;

  recordWordLatency(ms: number) {
    this.wordLatencies.push(ms);
    if (this.wordLatencies.length > 100) this.wordLatencies.shift();
  }

  /** p95 of recent word latencies, or undefined with too few samples. */
  wordLatencyP95(): number | undefined {
    if (this.wordLatencies.length < 3) return undefined;
    const s = [...this.wordLatencies].sort((a, b) => a - b);
    return s[Math.min(s.length - 1, Math.floor(0.95 * s.length))];
  }

  // Latency of the last ~10 reducer calls of any kind (bids, words, ...).
  private callLatencies: number[] = [];

  recordCallLatency(ms: number) {
    this.callLatencies.push(ms);
    if (this.callLatencies.length > 10) this.callLatencies.shift();
  }

  /** Slowest of the last ~10 calls, if it was a spike (slower than one auction). */
  latencySpike(): number | undefined {
    const max = Math.max(0, ...this.callLatencies);
    return max > this.auctionMs ? max : undefined;
  }

  /**
   * Bag size at which to dump all words:
   * max(3, ceil(p95 word latency / auction) + 2), raised by a recent spike
   * to ceil(spike / auction) + 3. A spike never dumps words mid-game; it
   * only starts the endgame dump earlier.
   */
  endgameBag(): number {
    const base = dynamicEndgameBag(this.P.endgameBag, this.wordLatencyP95(), this.auctionMs);
    const spike = this.latencySpike();
    return spike === undefined ? base : Math.max(base, Math.ceil(spike / Math.max(1, this.auctionMs)) + 3);
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
      endgameBag: this.endgameBag(),
      leave:
        this.P.fuelMode > 0 || this.P.lucent2 > 0
          ? (r) => Math.log1p((this.bingo ??= new BingoIndex(this.dict)).leave(r).score)
          : undefined,
      pool: this.P.lucent2 > 0 && this.tracker ? this.tracker.pool(view.rack) : undefined,
      params: this.opts.params,
    });
    if (plan.words.length > 0 && plan.reason.startsWith("need coins")) this.needCoins = false;
    return plan;
  }

  rackSize(rack: Counts): number {
    return totalOf(rack);
  }
}
