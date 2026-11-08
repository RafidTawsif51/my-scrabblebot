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
  /** Mid-game "need coins" plays must have at least this many letters / points. */
  cashInMinLen: 4,
  cashInMinPoints: 10,
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
  /** 1: unfitMult only for letters worth >= minValue; 0: for every non-fitting letter. */
  unfitGate: 1,
  /** Among playable 7+ words, take an 8+ letter one if there is one. */
  prefer8: 0,

  // ---- Lucent2 (1 = on, on top of lucent): better word conversion.
  lucent2: 0,
  /** Points per unit of log(1 + bingo leave score) when weighing what a word leaves behind. */
  l2LeaveW: 6,
  /** Surplus cash-out: play a 5-6 letter word if reward + leave change >= this. */
  l2SurplusMin: 10,
  /** Hold a 7 for an 8+ word one likely letter away only if bag >= this and balance >= l2HoldBal. */
  l2HoldBag: 25,
  l2HoldBal: 30,
  /** From this bag size, value letters by exact best-partition gain; 0 gain = no bid. */
  l2EndBag: 12,
  /** Q/Z/J/X that fit a reachable 7+ word: bid up to this. */
  l2HiMax: 40,

  // ---- Fuel mode (1 = on): LexForge-1107 / RackMaw's measured live pattern.
  fuelMode: 0,
  /** Target bid = market (bidmodel.json) × fuelScale: ~15-16 for ordinary letters. */
  fuelScale: 1.45,
  /** Share of the target bid on letters that don't fit a 7-8 letter word. */
  fuelUnfit: 0.7,
  /** Most of the balance one bid may use (their winning bids: ~29%). */
  fuelCap: 0.29,
  /** Q/Z/J/X that fit: bid up to this (their median: ~44). */
  fuelHiMax: 44,
  fuelDup: 0.8,
  fuelLate: 1.2,
  /** Coins to aim to finish with. */
  fuelKeep: 10,
  /** Cash in a 5+ letter word when balance drops below this. */
  fuelCashIn: 15,
  /** Weight of rack leave (log of bingo leave score) when choosing a cash-in word. */
  fuelLeaveW: 3,
  /** Once this match has prices: target = in-match clearing price × this (beat it). */
  fuelLearnScale: 1.2,
  /** Spend-rate controller: auctions of my own spending to look back over. */
  fuelCtrlWindow: 6,
  fuelCtrlMin: 0.5,
  fuelCtrlMax: 2,

  // ---- Balance-aware bidding (balances are public). 0 = off.
  /**
   * 1: use the opponents' max balance. First-price: never bid more than
   * maxOpp + 1. Vickrey: the price can't exceed maxOpp, so when our value
   * is above it, bid our whole balance (guaranteed win, pay <= maxOpp).
   */
  // On (2026-11-07): 600 paired sim matches, Vickrey +0.29 ± 0.11,
  // first-price +0.86 ± 0.16 (cap only; the guaranteed-win variant +0.79).
  balanceAware: 1,
  /** First-price: also raise the bid to maxOpp + 1 (a sure win) whenever value allows. */
  fpGuarantee: 0,
  /**
   * Pacing: expected price <= oppPaceK × opponents' coins per remaining
   * auction (0 = off). Off: K=1 cost -2.0 (Vickrey) / -22 (first-price),
   * K=2 -0.18 ± 0.28 over 600 paired matches.
   */
  oppPaceK: 0,
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

export type JaegerMode = "v3" | "lucent" | "lucent2" | "fuel";

/** Exact-enough best partition for endgame planning (wide beam). */
export const EXACT_BEAM = [64, 32, 16, 8, 4, 2];

/** Parameters for a live A/B mode ($env:JAEGER_MODE). v3 = current defaults. */
export function paramsForMode(mode: JaegerMode): Params {
  if (mode === "lucent") {
    return {
      ...PARAMS,
      lucentMode: 1,
      floorFrac: 0, // replaced by the lucent market floor below
      fitMult: 1.0, // market floor on letters that fit a 7-8 letter word
      unfitMult: 0.6, // ...and 0.6x on every other letter
      unfitGate: 0,
      play7Any: 1,
      spendDown: 10, // spend toward ~0 coins over the last 10 auctions
      prefer8: 1,
    };
  }
  if (mode === "lucent2") return { ...paramsForMode("lucent"), lucent2: 1 };
  if (mode === "fuel") {
    // Coins are fuel: market-plus bids from round 1, no reserve, refuel by
    // cashing 5+ letter words when low. Balance-aware bidding stays on.
    return { ...PARAMS, fuelMode: 1, floorFrac: 0, spendDown: 10 };
  }
  return { ...PARAMS };
}

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
  /** Highest opponent balance right now (public). */
  maxOppBalance?: number;
  /** Sum of opponents' balances. */
  oppTotalBalance?: number;
  /** Fuel mode: this match's clearing price for the letter's class (tracker.classPrice). */
  matchPrice?: number;
  /** Fuel mode: my spending over the last few closed auctions (tracker.recentMySpend). */
  recentSpend?: { spent: number; auctions: number };
  /** Lucent2 endgame: exact best-partition gain from this letter (points). */
  endgameGain?: number;
  params?: Params;
}

/**
 * Fuel-mode spend-rate controller. The trajectory runs linearly from the
 * current balance to `keep` coins at the last playable auction, i.e. a
 * planned spend of (balance - keep) / auctionsLeft per auction. Spending
 * slower than that (balance above the trajectory, e.g. a losing streak
 * after a big word) scales bids up, faster scales them down, within
 * [min, max]. Recomputed every auction.
 */
export function spendRateScale(
  balance: number,
  playableLeft: number,
  recent: { spent: number; auctions: number } | undefined,
  P: Params = PARAMS,
): number {
  if (!recent || recent.auctions === 0 || playableLeft <= 0) return 1;
  const planned = Math.max(0, balance - P.fuelKeep) / playableLeft;
  const actual = recent.spent / recent.auctions;
  const scale = (planned + 1) / (actual + 1); // +1: no blow-ups near zero
  return Math.min(P.fuelCtrlMax, Math.max(P.fuelCtrlMin, scale));
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
  const fuel = P.fuelMode > 0;
  // Lucent2 endgame: a letter that doesn't raise the best final partition
  // is worth nothing, whatever the market floor says.
  const l2End = lucent && P.lucent2 > 0 && ctx.endgameGain !== undefined;
  if (l2End && ctx.endgameGain! <= 0) {
    return { amount: 0, desired: 0, reason: `endgame: '${ctx.letter}' adds nothing to the final partition` };
  }
  const fits = (lucent || fuel) && (ctx.fit ?? 0) >= P.fitRel;
  const value = l2End
    ? Math.max(ctx.valuePoints, ctx.endgameGain!)
    : ctx.valuePoints + (lucent ? P.leaveWeight * (ctx.fit ?? 0) : 0);
  const unfitAll = lucent && P.unfitGate === 0 && P.unfitMult > 0;
  if (value < P.minValue && !fits && !unfitAll) {
    return { amount: 0, desired: 0, reason: `value ${value.toFixed(2)} too low` };
  }
  // If opponents hold few coins for the auctions left, future tiles will be
  // cheap: price expectations drop, so we save less.
  let avgPrice = ctx.avgPrice;
  if (P.oppPaceK > 0 && ctx.oppTotalBalance !== undefined) {
    const oppPerAuction = (P.oppPaceK * ctx.oppTotalBalance) / Math.max(1, pl);
    avgPrice = Math.min(avgPrice ?? 4, oppPerAuction);
  }
  const lambda = coinShadowPrice(pl, balance, avgPrice, P);
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
    let m = ctx.market * (fits ? P.fitMult : value >= P.minValue || unfitAll ? P.unfitMult : 0);
    if ((ctx.held ?? 0) > 0) m *= P.dupMult;
    if ((ctx.round ?? 0) > P.lateRound) m *= P.lateMult;
    if (fits && P.spendDown > 0 && pl <= P.spendDown) m = Math.max(m, balance / pl);
    let likeCap = pl <= 3 ? balance : Math.floor(balance * P.likeCap);
    // Lucent2: Q/Z/J/X that fit a reachable 7+ word are worth up to l2HiMax.
    if (P.lucent2 > 0 && fits && "JQXZ".includes(ctx.letter)) {
      m = Math.max(m, P.l2HiMax);
      likeCap = Math.max(likeCap, Math.min(balance, P.l2HiMax));
    }
    const mBid = Math.min(likeCap, balance, Math.round(m));
    desired = Math.max(desired, Math.round(m));
    if (mBid > bid) {
      reason += ` market ${bid}->${mBid} (fit ${(ctx.fit ?? 0).toFixed(2)}, mkt ${ctx.market.toFixed(1)})`;
      bid = mBid;
    }
  }
  // Fuel mode: no reserve. Bid a market-plus target from round 1, capped at
  // ~29% of balance (Q/Z/J/X that fit: up to ~44), and spend down to
  // ~fuelKeep coins over the last auctions.
  if (fuel) {
    const hi = "JQXZ".includes(ctx.letter);
    // Reference price: this match's clearing prices once known, else the
    // live bidmodel (which can sit below a given table's prices).
    const target =
      ctx.matchPrice !== undefined ? ctx.matchPrice * P.fuelLearnScale : (ctx.market ?? 11) * P.fuelScale;
    const ctrl = spendRateScale(balance, pl, ctx.recentSpend, P);
    let m = (fits ? target : value >= P.minValue ? target * P.fuelUnfit : 0) * ctrl;
    if ((ctx.held ?? 0) > 0) m *= P.fuelDup;
    if ((ctx.round ?? 0) > P.lateRound) m *= P.fuelLate;
    const spendable = Math.max(0, balance - P.fuelKeep);
    if (fits && P.spendDown > 0 && pl <= P.spendDown) m = Math.max(m, spendable / pl);
    let fcap = hi && fits ? Math.min(P.fuelHiMax, balance) : Math.floor(balance * P.fuelCap);
    if (pl <= 3) fcap = Math.max(fcap, spendable);
    const vBid = Math.min(Math.round(trueBid), fcap, balance);
    const fBid = Math.min(fcap, balance, Math.round(m));
    const next = Math.max(vBid, fBid);
    reason +=
      ` fuel ${bid}->${next} (target ${m.toFixed(1)}, ref ${ctx.matchPrice !== undefined ? `match ${ctx.matchPrice}` : `model ${(ctx.market ?? 11).toFixed(1)}`}, ` +
      `ctrl ${ctrl.toFixed(2)}, cap ${fcap}, fit ${(ctx.fit ?? 0).toFixed(2)})`;
    bid = next;
    desired = Math.max(Math.round(trueBid), Math.round(m));
  }

  if (ctx.auctionType === "FirstPrice") {
    // Pay-your-bid: shade toward the price that has been winning this
    // letter, plus one, but never above our value.
    const face = LETTER_VALUES[letterIndex(ctx.letter)] ?? 1;
    const market = ctx.marketPrice ?? face + 2;
    const shaded = Math.min(bid, Math.max(1, Math.ceil(market) + 1));
    reason += ` fp market=${market} shaded ${bid}->${shaded}`;
    const valueBid = bid;
    bid = shaded;
    if (P.balanceAware > 0 && ctx.maxOppBalance !== undefined) {
      const sure = Math.max(1, Math.floor(ctx.maxOppBalance) + 1); // nobody can match this
      if (P.fpGuarantee > 0 && sure <= valueBid) {
        reason += ` guaranteed ${bid}->${sure} (maxOpp ${ctx.maxOppBalance})`;
        bid = sure;
      } else if (bid > sure) {
        reason += ` capped ${bid}->${sure} (maxOpp ${ctx.maxOppBalance})`;
        bid = sure;
      }
    }
  } else if (P.balanceAware > 0 && ctx.maxOppBalance !== undefined && bid > 0) {
    // Vickrey: we pay the second-highest bid, which can't exceed the richest
    // opponent's balance. If our value beats that, bid everything: the win
    // is certain and the price is still at most maxOpp.
    if (Math.round(trueBid) > ctx.maxOppBalance && balance > ctx.maxOppBalance) {
      reason += ` vickrey sure-win ${bid}->${balance} (maxOpp ${ctx.maxOppBalance} < value ${Math.round(trueBid)})`;
      bid = balance;
    }
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
  /** Rack-leave score of a rack (higher = closer to 7-8 letter words); fuel mode. */
  leave?: (rack: Counts) => number;
  /** Letters that might still come up (tracker.pool); lucent2's hold-for-8 rule. */
  pool?: Counts;
  params?: Params;
}

/** Lucent2: is an 8+ letter word one *likely* letter away (2+ left in the pool)? */
function eightOneAway(dict: Dictionary, rack: Counts, pool: Counts | undefined): string | undefined {
  if (!pool) return undefined;
  const r = Uint8Array.from(rack);
  for (let i = 0; i < 26; i++) {
    if (pool[i]! < 2) continue;
    r[i]!++;
    const w = dict.candidates(r, 8)[0];
    r[i]!--;
    if (w) return w.word;
  }
  return undefined;
}

function minus(rack: Counts, word: string): Counts {
  const rest = Uint8Array.from(rack);
  for (const ch of word) rest[letterIndex(ch)]!--;
  return rest;
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
  // ---- Lucent2 word play.
  if (P.lucentMode > 0 && P.lucent2 > 0) {
    // (b) Endgame: the exact best partition, so no junk 2-letter word goes
    // down when a better split of the rack exists.
    if (ctx.bagTotal <= endgameBag) {
      const exact = ctx.dict.bestPlays(ctx.rack, EXACT_BEAM);
      return { words: byReward(exact.words), reason: `endgame exact partition (${exact.total}) bag=${ctx.bagTotal}` };
    }
    const leaveOf = (r: Counts) => (ctx.leave ? ctx.leave(r) : 0);
    const here = leaveOf(ctx.rack);
    // (a) 7+ words chosen by reward + value of the rack they leave.
    const sevens = ctx.dict.candidates(ctx.rack, 7).slice(0, 16);
    if (sevens.length > 0) {
      let pick = sevens[0]!;
      let pickV = -Infinity;
      for (const c of sevens) {
        const v = c.reward + P.l2LeaveW * leaveOf(minus(ctx.rack, c.word));
        if (v > pickV || (v === pickV && c.len > pick.len)) {
          pickV = v;
          pick = c;
        }
      }
      if (pick.len === 7 && ctx.bagTotal >= P.l2HoldBag && ctx.balance >= P.l2HoldBal) {
        const eight = eightOneAway(ctx.dict, ctx.rack, ctx.pool);
        if (eight) return { words: [], reason: `hold '${pick.word}' for an 8 (${eight}) one letter away` };
      }
      return { words: [pick.word], reason: `${pick.len} letters, leave-aware (lucent2)` };
    }
    // (d) Surplus cash-out: a 5-6 letter word whose points outweigh what
    // it costs the rack's 7-8 letter prospects.
    let surplus: { word: string; v: number } | undefined;
    for (const c of ctx.dict.candidates(ctx.rack, 5)) {
      if (c.len > 6) continue;
      const v = c.reward + P.l2LeaveW * (leaveOf(minus(ctx.rack, c.word)) - here);
      if (v >= P.l2SurplusMin && (!surplus || v > surplus.v)) surplus = { word: c.word, v };
    }
    if (surplus) return { words: [surplus.word], reason: `surplus 5-6 (net ${surplus.v.toFixed(1)})` };
  }
  if (ctx.bagTotal <= endgameBag) {
    return { words: byReward(best.words), reason: `endgame bag=${ctx.bagTotal} (threshold ${endgameBag})` };
  }
  // Fuel mode: 8+ then 7 letter words at once; when low on coins, refuel
  // with the 5+ letter word that scores best while keeping a good leave;
  // no 2-letter words outside the endgame dump.
  if (P.fuelMode > 0) {
    const cands = ctx.dict.candidates(ctx.rack, 5);
    const eight = cands.find((c) => c.len >= 8);
    if (eight) return { words: [eight.word], reason: "8+ letters now (fuel)" };
    const seven = cands.find((c) => c.len === 7);
    if (seven) return { words: [seven.word], reason: "7 letters now (fuel)" };
    if (ctx.balance < P.fuelCashIn && cands.length > 0) {
      let best = cands[0]!;
      let bestV = -Infinity;
      for (const c of cands.slice(0, 16)) {
        let v = c.reward;
        if (ctx.leave) {
          const rest = Uint8Array.from(ctx.rack);
          for (const ch of c.word) rest[letterIndex(ch)]!--;
          v += P.fuelLeaveW * ctx.leave(rest);
        }
        if (v > bestV) {
          bestV = v;
          best = c;
        }
      }
      return { words: [best.word], reason: `refuel (balance ${ctx.balance})` };
    }
    if (tiles >= P.maxHoard) {
      const w = ctx.dict.candidates(ctx.rack, 3)[0];
      if (w) return { words: [w.word], reason: `rack ${tiles} tiles` };
    }
    return { words: [], reason: "hoarding (fuel)" };
  }
  // LUCENT mode: any spellable 7+ letter word goes now, to recycle coins.
  if (P.lucentMode > 0 && P.play7Any > 0) {
    const sevens = ctx.dict.candidates(ctx.rack, 7);
    const eight = P.prefer8 > 0 ? sevens.find((c) => c.len >= 8) : undefined;
    if (eight) return { words: [eight.word], reason: "8+ letters now (lucent)" };
    if (sevens[0]) return { words: [sevens[0].word], reason: "7+ letters now (lucent)" };
  }
  // A 7+ letter word already earns the top multiplier: bank it.
  const long = best.words.filter((w) => w.length >= 7);
  if (long.length > 0) return { words: byReward(long), reason: "7+ letters (3x)" };

  const top = byReward(best.words)[0]!;
  if (ctx.needCoins || ctx.balance <= P.lowBalance) {
    // Only a real cash-in: >= 4 letters and >= 10 points (no ART for +3).
    // Prefer a word from the best partition; otherwise any such word.
    const ok = (w: string) => w.length >= P.cashInMinLen && wordReward(w) >= P.cashInMinPoints;
    const fromBest = byReward(best.words).find(ok);
    const any = fromBest ?? ctx.dict.candidates(ctx.rack, P.cashInMinLen).find((c) => c.reward >= P.cashInMinPoints)?.word;
    if (any) return { words: [any], reason: `need coins (balance ${ctx.balance})` };
  }
  if (tiles >= P.maxHoard) return { words: [top], reason: `rack ${tiles} tiles` };
  return { words: [], reason: "hoarding" };
}
