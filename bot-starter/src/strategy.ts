// Bidding and word-timing policy. Pure functions; the numbers they need
// (letter value in points, market price, bag state) come from valuation.ts
// and tracker.ts. Rules referenced are in RULES.md.
//
// Core idea: coins never reduce score and are worth nothing at match end
// (§3, §7), so this is budget allocation. A coin's worth in points (its
// shadow price) starts near 1 and falls toward 0 as auctions run out.

import { LETTER_VALUES, letterIndex, totalOf, wordReward, type Counts, type Dictionary } from "./dictionary.js";

export type AuctionKind = "Vickrey" | "FirstPrice";

// Tunables (exported so the simulator can sweep them).
export const PARAMS = {
  // Values below were tuned with src/sim.ts (head-to-head tables vs the
  // previous best settings, plus tables of module sim bots).
  /** Share of remaining auctions we plan to buy (for coin pacing). */
  buyShare: 0.15,
  /** Coin shadow price floor (coins nearly worthless) and ceiling. */
  lambdaMin: 0.1,
  lambdaMax: 0.6,
  /** In the last N playable auctions, coins are nearly worthless. */
  endgameAuctions: 10,
  /** Max fraction of balance on one letter before the endgame. */
  capFracMin: 0.45,
  capFracMax: 0.5,
  /** First-price overrides: paying your own bid favours less aggression. */
  fpLambdaMax: 0.8,
  fpCapFracMin: 0.3,
  /** Bag size at or below which every word is played at once. */
  endgameBag: 3,
  /** Balance at or below which we cash in a word for bidding power. */
  lowBalance: 8,
  /** Rack size at which we cash in a word to keep searches fast. */
  maxHoard: 16,
  /** Letters worth less than this many points get no bid. */
  minValue: 1.5,
  /** Monte Carlo samples: background precompute / on-the-spot. */
  mcSamples: 24,
  mcQuick: 12,
  /** Cap on simulated future tiles (bounds search cost). */
  maxFuture: 7,
  /** Scale on my estimated future win rate (we choose tiles, not random). */
  futureScale: 1.5,
};

/**
 * Auctions still able to deliver a playable tile, counting the open one.
 * `bagTotal` excludes the letter on auction. The very last auction's tile
 * arrives in the same transaction that ends the match, so it can never be
 * played (§7): with bagTotal 0 nothing is playable.
 */
export function playableLeft(bagTotal: number): number {
  return Math.max(0, bagTotal);
}

/**
 * Points one coin is worth now: the coins I'd need to keep buying my share
 * of the remaining playable auctions at the going price, over the coins I
 * have. Plenty of money or few auctions left → coins are cheap, so bid more;
 * leftover coins score nothing (§7).
 */
export type Params = typeof PARAMS;

export function coinShadowPrice(pl: number, balance: number, avgPrice = 4, p: Params = PARAMS): number {
  const need = pl * Math.max(1, avgPrice) * p.buyShare;
  const lambda = need / Math.max(1, balance);
  return Math.min(p.lambdaMax, Math.max(p.lambdaMin, lambda));
}

/** Largest share of balance to stake on one letter. */
export function capFraction(pl: number, p: Params = PARAMS): number {
  if (pl <= p.endgameAuctions) return Math.min(1, 3 / Math.max(1, pl));
  return Math.min(p.capFracMax, Math.max(p.capFracMin, 4 / pl));
}

export interface BidContext {
  letter: string;
  /** Marginal expected points of owning this letter (valuation.ts). */
  valuePoints: number;
  balance: number;
  bagTotal: number;
  auctionType: AuctionKind;
  /** Estimated highest competing bid (tracker.marketPrice). */
  marketPrice?: number;
  /** Mean price paid for sold tiles this match (for pacing). */
  avgPrice?: number;
  params?: Params;
}

export interface BidDecision {
  amount: number;
  /** What we'd bid with unlimited money (to detect coin starvation). */
  desired: number;
  reason: string;
}

export function decideBid(ctx: BidContext): BidDecision {
  const base = ctx.params ?? PARAMS;
  const P =
    ctx.auctionType === "FirstPrice"
      ? { ...base, lambdaMax: base.fpLambdaMax, capFracMin: base.fpCapFracMin }
      : base;
  const pl = playableLeft(ctx.bagTotal);
  const balance = Math.max(0, Math.floor(ctx.balance));
  if (pl === 0) return { amount: 0, desired: 0, reason: "last auction: tile unplayable" };
  if (ctx.valuePoints < P.minValue) {
    return { amount: 0, desired: 0, reason: `value ${ctx.valuePoints.toFixed(2)} too low` };
  }
  const lambda = coinShadowPrice(pl, balance, ctx.avgPrice, P);
  const trueBid = ctx.valuePoints / lambda; // value in coins
  const cap = Math.floor(balance * capFraction(pl, P));
  let bid = Math.min(Math.round(trueBid), cap, balance);
  let reason = `v=${ctx.valuePoints.toFixed(2)} λ=${lambda.toFixed(2)} cap=${cap}`;

  if (ctx.auctionType === "FirstPrice") {
    // Pay-your-bid: shade toward the price that has been winning this
    // letter, plus one, but never above our value.
    const face = LETTER_VALUES[letterIndex(ctx.letter)] ?? 1;
    const market = ctx.marketPrice ?? face + 2;
    const shaded = Math.min(bid, Math.max(1, Math.ceil(market) + 1));
    reason += ` fp market=${market} shaded ${bid}->${shaded}`;
    bid = shaded;
  }
  bid = Math.max(0, Math.min(bid, balance));
  return { amount: bid, desired: Math.round(trueBid), reason };
}

export interface WordPlanContext {
  dict: Dictionary;
  rack: Counts;
  bagTotal: number;
  balance: number;
  /** Reducer latency looked dangerous: stop hoarding entirely. */
  panic: boolean;
  /** Our last bid was capped by our balance. */
  needCoins: boolean;
  params?: Params;
}

export interface WordPlan {
  words: string[];
  reason: string;
}

function byReward(words: string[]): string[] {
  return [...words].sort((a, b) => wordReward(b) - wordReward(a));
}

/**
 * Which words to play now. Hoard toward 7+ letters (3x), but cash in when
 * coins are needed, and play everything near the end because the match
 * ends with no grace period (§7).
 */
export function planWords(ctx: WordPlanContext): WordPlan {
  const P = ctx.params ?? PARAMS;
  const tiles = totalOf(ctx.rack);
  if (tiles < 2) return { words: [], reason: "rack too small" };
  const best = ctx.dict.bestPlays(ctx.rack);
  if (best.words.length === 0) return { words: [], reason: "no words" };

  if (ctx.panic) return { words: byReward(best.words), reason: "panic: latency" };
  if (ctx.bagTotal <= P.endgameBag) {
    return { words: byReward(best.words), reason: `endgame bag=${ctx.bagTotal}` };
  }
  // A 7+ letter word already earns the top multiplier: bank it.
  const long = best.words.filter((w) => w.length >= 7);
  if (long.length > 0) return { words: byReward(long), reason: "7+ letters (3x)" };

  const top = byReward(best.words)[0]!;
  if (ctx.needCoins || ctx.balance <= P.lowBalance) {
    return { words: [top], reason: `need coins (balance ${ctx.balance})` };
  }
  if (tiles >= P.maxHoard) return { words: [top], reason: `rack ${tiles} tiles` };
  return { words: [], reason: "hoarding" };
}
