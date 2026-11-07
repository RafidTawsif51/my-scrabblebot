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
  // Values below were tuned with src/sim.ts: first head-to-head vs earlier
  // settings, then (2026-11-07) against opponents that mimic Bron/LUCENT's
  // measured live bidding (sim rows "mimic", "mixed"; tools/bidmodel.json).
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
  mcQuick: 24,
  /** Cap on simulated future tiles (bounds search cost). */
  maxFuture: 7,
  /** Scale on my estimated future win rate (we choose tiles, not random). */
  futureScale: 2.5,
  /**
   * Market floor: for a letter worth at least `minValue` to us, bid at least
   * floorFrac × the going price (this match's median, else live prices by
   * face value). 0 disables it.
   */
  floorFrac: 0.7,

  // ---- LUCENT-style mode (1 = on). Calibrated in sim.ts's "likecal" row,
  // where these rules reproduce Bron's live tile volume and word profile.
  lucentMode: 0,
  /** Letter fits a plausible 7-8 letter word: bingo gain ≥ fitRel × best letter's. */
  fitRel: 0.25,
  /** High-value letters count as fitting more easily: × (1 + hvBoost × (face-1)/9). */
  hvBoost: 3,
  /** Bid at least market × fitMult on fitting letters (market = tools/bidmodel.json). */
  fitMult: 1.0,
  /** Bid at least market × unfitMult on other letters worth ≥ minValue (0 = off). */
  unfitMult: 0,
  dupMult: 0.7,
  lateMult: 1.3,
  lateRound: 55,
  /** In the last N playable auctions, bid ≥ balance / N on fitting letters (aim for 0 coins). */
  spendDown: 10,
  /** Max share of balance for one market-floor bid (whole balance in the last 3). */
  likeCap: 0.6,
  /** Points added to a letter's value per unit of bingo fit. */
  leaveWeight: 0,
  /** Play any 7+ letter word as soon as it can be spelled. */
  play7Any: 1,
};

/**
 * Average price paid per tile on the live server by face value, measured
 * over ~200 recent matches (tools/analyze.ts, 2026-11-07).
 */
export const LIVE_PRICE_BY_FACE: Record<number, number> = { 1: 9.5, 2: 11.8, 3: 14.6, 4: 15.9, 5: 19.2, 8: 21.3, 10: 19.9 };

/**
 * Bag size at or below which every word is played at once: at least
 * `base`, and enough auctions to cover the slowest (p95) word submission
 * plus two auctions of margin: max(base, ceil(p95 / auction length) + 2).
 */
export function dynamicEndgameBag(base: number, p95WordLatencyMs: number | undefined, auctionMs = 1000): number {
  if (p95WordLatencyMs === undefined || !Number.isFinite(p95WordLatencyMs)) return base;
  return Math.max(base, Math.ceil(p95WordLatencyMs / Math.max(1, auctionMs)) + 2);
}

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
  /** Going price for this letter (for the market floor). */
  floorPrice?: number;
  /** LUCENT mode: bingo fit of this letter (relative gain, boosted for high values). */
  fit?: number;
  /** LUCENT mode: live market price for this letter (market.ts). */
  market?: number;
  /** Copies of this letter already in my rack. */
  held?: number;
  /** Auction number in the match (1-based). */
  round?: number;
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
  const lucent = P.lucentMode > 0;
  const fits = lucent && (ctx.fit ?? 0) >= P.fitRel;
  const value = ctx.valuePoints + (lucent ? P.leaveWeight * (ctx.fit ?? 0) : 0);
  if (value < P.minValue && !fits) {
    return { amount: 0, desired: 0, reason: `value ${value.toFixed(2)} too low` };
  }
  const lambda = coinShadowPrice(pl, balance, ctx.avgPrice, P);
  const trueBid = value / lambda; // value in coins
  const cap = Math.floor(balance * capFraction(pl, P));
  let bid = Math.min(Math.round(trueBid), cap, balance);
  let desired = Math.round(trueBid);
  let reason = `v=${ctx.valuePoints.toFixed(2)} λ=${lambda.toFixed(2)} cap=${cap}`;
  // The floor is part of our valuation: live data shows the model's point
  // values sit below what ordinary tiles are worth to the top bots, so a
  // useful letter is worth at least floorFrac × its going price.
  if (P.floorFrac > 0) {
    const going = ctx.floorPrice ?? LIVE_PRICE_BY_FACE[LETTER_VALUES[letterIndex(ctx.letter)] ?? 1] ?? 10;
    const floorRaw = Math.round(P.floorFrac * going);
    desired = Math.max(desired, floorRaw);
    const floor = Math.min(cap, balance, floorRaw);
    if (floor > bid) {
      reason += ` floor ${bid}->${floor} (going ${going})`;
      bid = floor;
    }
  }
  // LUCENT mode: at least the live market price on letters that fit a
  // plausible 7-8 letter word (-30% for a letter already held, +30% late),
  // and spend down toward 0 coins at the end.
  if (lucent && ctx.market !== undefined) {
    let m = ctx.market * (fits ? P.fitMult : value >= P.minValue ? P.unfitMult : 0);
    if ((ctx.held ?? 0) > 0) m *= P.dupMult;
    if ((ctx.round ?? 0) > P.lateRound) m *= P.lateMult;
    if (fits && P.spendDown > 0 && pl <= P.spendDown) m = Math.max(m, balance / pl);
    const likeCap = pl <= 3 ? balance : Math.floor(balance * P.likeCap);
    const mBid = Math.min(likeCap, balance, Math.round(m));
    desired = Math.max(desired, Math.round(m));
    if (mBid > bid) {
      reason += ` market ${bid}->${mBid} (fit ${(ctx.fit ?? 0).toFixed(2)}, mkt ${ctx.market.toFixed(1)})`;
      bid = mBid;
    }
  }

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
  return { amount: bid, desired, reason };
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
  /** Overrides params.endgameBag (see dynamicEndgameBag). */
  endgameBag?: number;
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
  const endgameBag = ctx.endgameBag ?? P.endgameBag;
  if (ctx.bagTotal <= endgameBag) {
    return { words: byReward(best.words), reason: `endgame bag=${ctx.bagTotal} (threshold ${endgameBag})` };
  }
  // LUCENT mode: any spellable 7+ letter word goes now, to recycle coins.
  if (P.lucentMode > 0 && P.play7Any > 0) {
    const seven = ctx.dict.candidates(ctx.rack, 7)[0];
    if (seven) return { words: [seven.word], reason: "7+ letters now (lucent)" };
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
