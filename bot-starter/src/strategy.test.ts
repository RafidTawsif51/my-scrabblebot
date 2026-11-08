// Run with `npm test`.

import assert from "node:assert/strict";
import { test } from "node:test";
import { countsOf, countsKey, Dictionary, totalOf, wordReward } from "./dictionary.js";
import { marketPrice as liveMarketPrice } from "./market.js";
import { allInBid, allInWindow, applyHeadsUp, decideBid, dynamicEndgameBag, lucent3Cap, lucent3Scale, paramsForMode, planWords, PARAMS, spendRateScale } from "./strategy.js";
import { MatchTracker } from "./tracker.js";
import { valueLetterNow } from "./valuation.js";
import { simulateMatch } from "./sim.js";
import { BingoIndex, relativeGain } from "./bingo.js";
import { Player } from "./player.js";
import { LIVE_LOG_DIR, LOG_DIR } from "./logger.js";

const dict = Dictionary.load();

test("the full ENABLE wordlist loads (Windows path bug fixed)", () => {
  assert.ok(dict.size > 172_000, `only ${dict.size} words`);
  // This ENABLE list has no QI or ZA (the module uses the same file).
  assert.ok(dict.isWord("QUIZ") && dict.isWord("xi") && !dict.isWord("QI"));
});

test("reward formula matches the module (floor(base * num / den))", () => {
  assert.equal(wordReward("XI"), 9); // 8+1, 1x
  assert.equal(wordReward("QUIZ"), 33); // 22 * 3/2
  assert.equal(wordReward("TEAR"), 6); // 4 * 3/2
  assert.equal(wordReward("TEARS"), 10); // 5 * 2
  assert.equal(wordReward("ORATES"), 15); // 6 * 5/2
  assert.equal(wordReward("RETAINS"), 21); // 7 * 3
  assert.equal(wordReward("AAH"), 6); // 6, 1x
  assert.equal(wordReward("DIRT"), 7); // 5 * 3/2 = 7.5 -> 7
});

test("candidates are exactly the words the rack can spell", () => {
  const c = dict.candidates(countsOf("QUIZT"));
  const words = new Set(c.map((x) => x.word));
  assert.ok(words.has("QUIZ") && words.has("ZIT") && words.has("IT"));
  assert.ok(!words.has("QI"));
  for (const x of c) {
    assert.ok(dict.isWord(x.word));
    assert.equal(x.reward, wordReward(x.word));
  }
  assert.equal(c[0]!.word, "QUIZ"); // highest reward first
});

test("bestPlays partitions into disjoint words and beats single words", () => {
  const rack = countsOf("QUIZRETAINS");
  const best = dict.bestPlays(rack);
  const used = countsOf(best.words.join(""));
  for (let i = 0; i < 26; i++) assert.ok(used[i]! <= rack[i]!);
  assert.equal(best.total, best.words.reduce((s, w) => s + wordReward(w), 0));
  assert.ok(best.total >= wordReward("QUIZ") + wordReward("RETAINS"), `got ${best.words}`);
});

test("word search stays fast on a large rack", () => {
  const rack = countsOf("AEEIORSTNLDUGBCMPQ");
  const t0 = performance.now();
  dict.bestPlays(rack);
  assert.ok(performance.now() - t0 < 100, "bestPlays took 100 ms or more");
});

test("tracker: unsold tiles leave the pool; starting tiles are deduced", () => {
  const t = new MatchTracker(1n, 7n, 5);
  t.onAuction(1n, "Q");
  t.onResult(1n, "Q", undefined, 0); // unsold: discarded, not returned
  t.onAuction(2n, "E");
  t.onResult(2n, "E", 7n, 3);
  t.onAuction(3n, "Z");
  t.onResult(3n, "Z", 9n, 4);
  t.onWord(9n, "ZIT"); // opponent revealed starting I and T
  const myRack = countsOf("ETTAIS"); // 5 starting + the E I won
  const pool = t.pool(myRack);
  // 98 - 3 auctioned - 5 my starters - 2 revealed opponent starters
  assert.equal(totalOf(pool), 88);
  assert.equal(pool[16], 0); // the only Q is gone
  assert.equal(pool[25], 0); // the only Z is gone
  assert.equal(t.myWins(), 1);
  assert.equal(t.marketPrice("Z"), 4);
  const opp = t.opponentRacks().find((o) => o.botId === 9n)!;
  assert.equal(opp.unknown, 3);
  assert.equal(countsKey(opp.known), "");
});

test("valuation: a letter that completes words is worth more", () => {
  const rack = countsOf("QIZT");
  const pool = countsOf("AAEEIIOOUURRSSTTNNLLDDGG");
  const u = valueLetterNow(dict, rack, pool, 2, 24, 20, 1); // U
  const x = valueLetterNow(dict, rack, pool, 2, 24, 23, 1); // X
  assert.ok(u > x, `U ${u} should beat X ${x} with QIZT`);
  assert.ok(u > 5);
});

const bidCtx = { letter: "E", valuePoints: 6, balance: 50, bagTotal: 40, auctionType: "Vickrey" as const };

test("bids: last auction is worthless, never exceed balance, skip junk", () => {
  assert.equal(decideBid({ ...bidCtx, bagTotal: 0 }).amount, 0);
  assert.ok(decideBid({ ...bidCtx, valuePoints: 1000 }).amount <= 50);
  assert.equal(decideBid({ ...bidCtx, valuePoints: 0.1 }).amount, 0);
  assert.equal(decideBid({ ...bidCtx, balance: 0 }).amount, 0);
});

test("bids: coins get cheaper as auctions run out", () => {
  const early = decideBid({ ...bidCtx, bagTotal: 60, balance: 100 }).amount;
  const late = decideBid({ ...bidCtx, bagTotal: 3, balance: 100 }).amount;
  assert.ok(late > early, `late ${late} should exceed early ${early}`);
  // Penultimate auction: may stake the whole balance on a useful letter.
  assert.equal(decideBid({ ...bidCtx, bagTotal: 1, balance: 20, valuePoints: 8 }).amount, 20);
});

test("bids: first-price shades to market + 1 but never above the Vickrey bid", () => {
  const v = decideBid({ ...bidCtx, valuePoints: 8 }).amount;
  const fp = decideBid({ ...bidCtx, valuePoints: 8, auctionType: "FirstPrice", marketPrice: 3 }).amount;
  assert.equal(fp, Math.min(4, v));
  const fpHigh = decideBid({ ...bidCtx, valuePoints: 2, auctionType: "FirstPrice", marketPrice: 50 });
  assert.ok(fpHigh.amount <= decideBid({ ...bidCtx, valuePoints: 2, auctionType: "FirstPrice" }).desired);
});

test("bids: market floor buys useful letters at a share of the going price", () => {
  const ctx = { ...bidCtx, valuePoints: 2, balance: 100 };
  const withFloor = decideBid({ ...ctx, floorPrice: 20, params: { ...PARAMS, floorFrac: 0.7 } });
  assert.equal(withFloor.amount, 14);
  assert.ok(withFloor.desired >= withFloor.amount);
  const noFloor = decideBid({ ...ctx, floorPrice: 20, params: { ...PARAMS, floorFrac: 0 } });
  assert.ok(noFloor.amount < withFloor.amount, `${noFloor.amount} vs ${withFloor.amount}`);
  // Never for letters below minValue, and never above balance.
  assert.equal(decideBid({ ...ctx, valuePoints: 0.2, floorPrice: 12 }).amount, 0);
  assert.ok(decideBid({ ...ctx, balance: 5, floorPrice: 40 }).amount <= 5);
});

test("endgame threshold = max(3, ceil(p95 word latency s) + 2)", () => {
  assert.equal(dynamicEndgameBag(3, undefined), 3);
  assert.equal(dynamicEndgameBag(3, 145), 3); // ceil(0.145) + 2 = 3
  assert.equal(dynamicEndgameBag(3, 1200), 4); // ceil(1.2) + 2 = 4
  assert.equal(dynamicEndgameBag(3, 2500), 5);
  assert.equal(plan("QIZTEDOG", { bagTotal: 5, endgameBag: 5 }).words.length >= 2, true);
  assert.deepEqual(plan("QIZTE", { bagTotal: 5, endgameBag: 3 }).words, []);
});

test("bingo leave: rewards letters that complete 7-8 letter words", () => {
  const bi = new BingoIndex(dict);
  const near = bi.leave(countsOf("RETAINQ"));
  assert.equal(near.minMissing, 1);
  const best = [...near.gain].indexOf(Math.max(...near.gain));
  assert.equal(best, 18); // S -> RETAINS
  assert.equal(bi.leave(countsOf("AEINRST")).playable, 1);
  assert.ok(relativeGain(bi.leave(countsOf("AERST")), 8) > relativeGain(bi.leave(countsOf("AERST")), 16)); // I > Q
});

test("lucent mode (off by default): market bid on fitting letters, any 7+ word now", () => {
  assert.equal(PARAMS.lucentMode, 0);
  const P = { ...PARAMS, lucentMode: 1 };
  const base = { ...bidCtx, valuePoints: 0.5, balance: 100, market: 11, params: P };
  assert.equal(decideBid({ ...base, fit: 0.9, round: 10 }).amount, 11);
  assert.equal(decideBid({ ...base, fit: 0.9, round: 10, held: 1 }).amount, Math.round(11 * 0.7));
  assert.equal(decideBid({ ...base, fit: 0.9, round: 60 }).amount, Math.round(11 * 1.3));
  assert.equal(decideBid({ ...base, fit: 0.05, round: 10 }).amount, 0); // doesn't fit, low value
  const p = planWords({ dict, rack: countsOf("RETAINSQZ"), bagTotal: 40, balance: 50, panic: false, needCoins: false, params: P });
  assert.ok(p.words.length === 1 && p.words[0]!.length >= 7, p.reason);
});

test("balance-aware bidding: first-price cap/guarantee, Vickrey sure win", () => {
  assert.equal(PARAMS.balanceAware, 1);
  const P = { ...PARAMS, balanceAware: 1, fpGuarantee: 1 };
  const fp = { ...bidCtx, valuePoints: 8, balance: 100, auctionType: "FirstPrice" as const, params: P };
  // Value allows maxOpp + 1: take the guaranteed win at the lowest sure price.
  assert.equal(decideBid({ ...fp, marketPrice: 20, maxOppBalance: 4 }).amount, 5);
  // Never above maxOpp + 1 even without the guarantee.
  assert.ok(decideBid({ ...fp, marketPrice: 20, maxOppBalance: 4, params: { ...P, fpGuarantee: 0 } }).amount <= 5);
  // Vickrey: value above everyone's balance -> bid everything (price <= maxOpp).
  const v = decideBid({ ...bidCtx, valuePoints: 8, balance: 60, maxOppBalance: 3, params: P });
  assert.equal(v.amount, 60);
  // Rich opponents: same bid as with the feature off.
  const off = decideBid({ ...bidCtx, valuePoints: 8, balance: 60, maxOppBalance: 100, params: { ...PARAMS, balanceAware: 0 } });
  assert.equal(decideBid({ ...bidCtx, valuePoints: 8, balance: 60, maxOppBalance: 100, params: P }).amount, off.amount);
});

test("tracker: max / total opponent balance excludes me", () => {
  const t = new MatchTracker(1n, 7n, 5);
  t.setParticipant(7n, 500, 0);
  t.setParticipant(8n, 30, 0);
  t.setParticipant(9n, 12, 0);
  assert.equal(t.maxOppBalance(), 30);
  assert.equal(t.oppTotalBalance(), 42);
});

test("JAEGER_MODE params: v3 = defaults; lucent = market 1.0/0.6, 7+ now, prefer 8", () => {
  assert.deepEqual(paramsForMode("v3"), PARAMS);
  const L = paramsForMode("lucent");
  assert.equal(L.lucentMode, 1);
  assert.equal(L.balanceAware, 1); // kept on in both modes
  const base = { ...bidCtx, valuePoints: 0.2, balance: 100, market: 10, round: 10, params: L };
  assert.equal(decideBid({ ...base, fit: 0.9 }).amount, 10); // fits: 1.0x market
  assert.equal(decideBid({ ...base, fit: 0.0 }).amount, 6); // otherwise 0.6x, even if low value
  // RETAINERS-style rack: an 8-letter word beats the 7s when both are playable.
  const rack = countsOf("RETAINERS");
  const p = planWords({ dict, rack, bagTotal: 40, balance: 50, panic: false, needCoins: false, params: L });
  assert.ok(p.words[0]!.length >= 8, `${p.words} (${p.reason})`);
});

test("fuel mode: market-plus bids without reserve, refuel with 5+ words, no 2-letter words", () => {
  const F = paramsForMode("fuel");
  assert.equal(F.fuelMode, 1);
  assert.equal(F.balanceAware, 1);
  assert.equal(paramsForMode("v3").fuelMode, 0);
  assert.equal(paramsForMode("lucent").fuelMode, 0);
  const base = { ...bidCtx, valuePoints: 2, balance: 100, round: 5, params: F };
  // Fitting vowel at a market of ~10.5 -> ~15, within 29% of balance.
  assert.equal(decideBid({ ...base, letter: "A", fit: 0.9, market: 10.5 }).amount, 15);
  assert.ok(decideBid({ ...base, letter: "A", fit: 0.9, market: 10.5, balance: 40 }).amount <= Math.floor(40 * 0.29));
  // Fitting Q: up to 44 even above 29% of balance.
  assert.equal(decideBid({ ...base, letter: "Q", fit: 0.9, market: 40 }).amount, 44);
  // Low balance: refuel with a 5+ letter word, never a 2-letter word.
  const low = planWords({ dict, rack: countsOf("QUIZTOX"), bagTotal: 40, balance: 10, panic: false, needCoins: false, params: F });
  assert.ok(low.words.length === 1 && low.words[0]!.length >= 5, `${low.words} ${low.reason}`);
  const rich = planWords({ dict, rack: countsOf("QUIZTOX"), bagTotal: 40, balance: 60, panic: false, needCoins: false, params: F });
  assert.deepEqual(rich.words, []);
  const seven = planWords({ dict, rack: countsOf("RETAINSQ"), bagTotal: 40, balance: 60, panic: false, needCoins: false, params: F });
  assert.ok(seven.words[0]!.length >= 7);
});

test("fuel spend-rate controller: high balance + losing streak raises bids (match 45457)", () => {
  const F = paramsForMode("fuel");
  // 110 coins, 20 auctions left: planned spend (110-10)/20 = 5 per auction.
  const streak = { spent: 0, auctions: 6 }; // won nothing lately
  const onPace = { spent: 30, auctions: 6 }; // 5 per auction
  const tooFast = { spent: 120, auctions: 6 };
  assert.equal(spendRateScale(110, 20, streak, F), 2); // capped at 2x
  assert.ok(Math.abs(spendRateScale(110, 20, onPace, F) - 1) < 1e-9);
  assert.equal(spendRateScale(110, 20, tooFast, F), 0.5); // capped at 0.5x
  assert.equal(spendRateScale(110, 20, undefined, F), 1);
  // Same auction, same prices: the streak must bid more than being on pace.
  // avgPrice 14 as at that table: the value path alone gives ~11 (the live bug).
  const ctx = { ...bidCtx, letter: "E", valuePoints: 4, balance: 110, bagTotal: 20, round: 48, fit: 0.9, market: 11, matchPrice: 15, avgPrice: 14, params: F };
  assert.ok(decideBid({ ...ctx, params: { ...F, fuelMode: 0 } }).amount <= 13);
  const hot = decideBid({ ...ctx, recentSpend: streak }).amount;
  const calm = decideBid({ ...ctx, recentSpend: onPace }).amount;
  assert.ok(hot > calm, `streak ${hot} should beat on-pace ${calm}`);
  assert.ok(hot > 13, `streak bid ${hot} must clear the 11-13 that lost in 45457`);
  assert.ok(hot <= Math.floor(110 * F.fuelCap));
  // v3 and lucent ignore the controller.
  const v3 = decideBid({ ...ctx, params: paramsForMode("v3"), recentSpend: streak }).amount;
  assert.equal(v3, decideBid({ ...ctx, params: paramsForMode("v3"), recentSpend: onPace }).amount);
});

test("fuel price learning: in-match class prices replace bidmodel after 5 sales", () => {
  const t = new MatchTracker(1n, 7n, 5);
  const model = () => 10;
  const sell = (id: bigint, l: string, paid: number) => {
    t.onAuction(id, l);
    t.onResult(id, l, 9n, paid);
  };
  sell(1n, "E", 16);
  sell(2n, "A", 18);
  sell(3n, "T", 17);
  sell(4n, "C", 21);
  assert.equal(t.classPrice("E", model), undefined); // only 4 sales
  sell(5n, "O", 19);
  assert.equal(t.classPrice("I", model), 18); // median of 1-pt class: 16,17,18,19
  // Class with no sales: model price scaled by this table's price level.
  const z = t.classPrice("Z", model)!;
  assert.ok(z > 10 && Math.abs(z - 10 * (91 / 5 / 10)) < 1e-9);
  const s = t.recentMySpend(6);
  assert.deepEqual(s, { spent: 0, auctions: 5 });
});

test("lucent2: modes, surplus 5-6 cash-out, hold-for-8, exact endgame, Q/Z up to 40", () => {
  const L2 = paramsForMode("lucent2");
  assert.equal(L2.lucent2, 1);
  assert.equal(paramsForMode("lucent").lucent2, 0);
  const bi = new BingoIndex(dict);
  const leave = (r: Uint8Array) => Math.log1p(bi.leave(r).score);
  const ctx = { dict, bagTotal: 40, balance: 50, panic: false, needCoins: false, leave, params: L2 };
  // Surplus: QUAKY-style junk alongside a strong 7-letter core gets cashed as a 5-6 word.
  const sur = planWords({ ...ctx, rack: countsOf("JUMPYAEIRST") });
  assert.ok(sur.words.length === 1 && sur.words[0]!.length >= 5 && sur.words[0]!.length <= 7, `${sur.words} ${sur.reason}`);
  // Hold a 7 when an 8 is one likely letter away, bag >= 25, balance >= 30.
  const pool = countsOf("SSSSEEEEAAAA");
  const hold = planWords({ ...ctx, rack: countsOf("RETAINS"), pool });
  assert.deepEqual(hold.words, [], hold.reason);
  // ...but not late or when short of coins.
  assert.equal(planWords({ ...ctx, rack: countsOf("RETAINS"), pool, bagTotal: 20 }).words.length, 1);
  assert.equal(planWords({ ...ctx, rack: countsOf("RETAINS"), pool, balance: 20 }).words.length, 1);
  // Endgame: exact partition, no junk 2-letter word when a better split exists.
  const eg = planWords({ ...ctx, rack: countsOf("QUIZDOGTEA"), bagTotal: 3 });
  const total = eg.words.reduce((s, w) => s + wordReward(w), 0);
  assert.ok(total >= dict.bestPlays(countsOf("QUIZDOGTEA")).total);
  // Bidding: endgame letter that adds nothing gets 0 even with a market floor.
  const b = { ...bidCtx, valuePoints: 3, balance: 100, bagTotal: 8, round: 60, market: 11, fit: 0.9, params: L2 };
  assert.equal(decideBid({ ...b, endgameGain: 0 }).amount, 0);
  assert.ok(decideBid({ ...b, endgameGain: 9 }).amount > 0);
  // Q that fits a reachable 7+: up to 40.
  assert.equal(decideBid({ ...bidCtx, letter: "Q", valuePoints: 5, balance: 100, round: 10, market: 28, fit: 0.9, params: L2 }).amount, 40);
});

test("latency spike: no global panic; it only raises the endgame threshold", () => {
  for (const mode of ["v3", "lucent", "lucent2"] as const) {
    const p = new Player(dict, { params: paramsForMode(mode) });
    p.beginMatch(1n, 7n, 5, 6);
    const rack = countsOf("EHORNIS"); // EH, OR, IN, ... (the match-45677 junk)
    const view = (bagTotal: number) => ({ rack, balance: 60, bagTotal, auctionType: "Vickrey" as const });
    for (let i = 0; i < 5; i++) p.recordCallLatency(120);
    assert.equal(p.endgameBag(), 3);
    p.recordCallLatency(2374); // the live spike
    assert.equal(p.panic, false);
    assert.equal(p.endgameBag(), 6); // ceil(2374 / 1000) + 3
    // Mid-game (bag 37): no junk dump.
    const mid = p.words(view(37));
    assert.ok(!mid.words.some((w) => w.length < 4), `${mode} bag 37 played ${mid.words} (${mid.reason})`);
    assert.ok(!mid.reason.startsWith("endgame") && !mid.reason.startsWith("panic"), mid.reason);
    // Near the end (bag 5 <= 6): the dump starts early.
    const late = p.words(view(5));
    assert.ok(late.words.length > 0 && late.reason.includes("endgame"), `${mode} bag 5: ${late.reason}`);
    // The spike ages out after ~10 calls; the threshold comes back down.
    for (let i = 0; i < 10; i++) p.recordCallLatency(120);
    assert.equal(p.endgameBag(), 3);
  }
});

test("lucent3: rich & idle raises bids (88 coins, bag 40); never scales down", () => {
  const L2 = paramsForMode("lucent2");
  const L3 = paramsForMode("lucent3");
  assert.equal(L3.lucent3, 1);
  assert.equal(L2.lucent3, 0);
  // Match 45858: 88 coins at bag 40 (round 28 of ~67 playable), bids stuck at 5-12.
  const ctx = { ...bidCtx, letter: "E", valuePoints: 4, balance: 88, bagTotal: 40, round: 28, fit: 0.1, market: 11, avgPrice: 12 };
  const b2 = decideBid({ ...ctx, params: L2 }).amount;
  const b3 = decideBid({ ...ctx, params: L3 }).amount;
  assert.ok(b3 > b2, `lucent3 ${b3} should beat lucent2 ${b2}`);
  assert.ok(b3 <= lucent3Cap(88, 40, 11, L3));
  // Trajectory at bag 40 of 67: 10 + 90*40/67 ≈ 63.7 -> excess ≈ 24 > 15 -> scale up.
  assert.ok(lucent3Scale(88, 40, 67, L3) > 1);
  // Excess <= 15 (or below the trajectory): no scaling.
  assert.equal(lucent3Scale(70, 40, 67, L3), 1);
  assert.equal(lucent3Scale(36, 40, 67, L3), 1);
  // Low-value letters are never scaled.
  const low2 = decideBid({ ...ctx, valuePoints: 2, params: L2 }).amount;
  assert.ok(decideBid({ ...ctx, valuePoints: 2, params: L3 }).amount <= low2);
});

test("lucent3 hard caps: no 35 on F at 36 coins (match 46091), keep a reserve while bag > 10", () => {
  const L3 = paramsForMode("lucent3");
  const f = { ...bidCtx, letter: "F", valuePoints: 12, balance: 36, bagTotal: 40, round: 28, fit: 0.9, market: 21, avgPrice: 12 };
  const bF = decideBid({ ...f, params: L3 });
  assert.ok(bF.amount <= 15, `F bid ${bF.amount} (${bF.reason})`);
  assert.ok(36 - bF.amount >= 20); // reserve min(20, 2 x 40)
  // Full-balance bid on S at 20 coins (later in 46091): now leaves the reserve.
  const s = decideBid({ ...f, letter: "S", balance: 20, bagTotal: 30, market: 11, params: L3 });
  assert.equal(s.amount, 0);
  // Y for 27 (46106): capped at min(1.3 x market, 30% of balance).
  const y = decideBid({ ...f, letter: "Y", balance: 90, market: 18, params: L3 });
  assert.ok(y.amount <= Math.min(Math.floor(18 * 1.3), Math.floor(90 * 0.3)), `${y.amount}`);
  // Late (bag <= 10) the reserve no longer applies; the % cap still does.
  assert.equal(lucent3Cap(20, 8, 11, L3), 6);
  assert.equal(lucent3Cap(36, 40, 21, L3), 10);
});

test("lucent3: broke & stuck refuels with a 10+ point 4-letter word (12 coins, bag 30)", () => {
  const L3 = paramsForMode("lucent3");
  // QUIZ is the only 10+ point word, and it's 4 letters: lucent2's 5-6
  // letter surplus rule can't use it, so lucent2 sits on 12 coins.
  const ctx = { dict, rack: countsOf("QUIZT"), bagTotal: 30, balance: 12, panic: false, needCoins: false, params: L3 };
  assert.deepEqual(planWords(ctx).words, ["QUIZ"]);
  // lucent2 at the same spot keeps hoarding (the stuck case).
  assert.deepEqual(planWords({ ...ctx, params: paramsForMode("lucent2") }).words, []);
  // Not late (bag <= 15) and not with junk-only racks.
  assert.deepEqual(planWords({ ...ctx, bagTotal: 15 }).words, []);
  assert.deepEqual(planWords({ ...ctx, rack: countsOf("ARTE") }).words, []);
});

test("lucent2e endgame all-in: spend leftover coins on letters that raise the final partition", () => {
  const E = paramsForMode("lucent2e");
  const L2 = paramsForMode("lucent2");
  assert.equal(E.l2AllIn, 1);
  assert.equal(L2.l2AllIn, 0);
  const ctx = { ...bidCtx, letter: "S", valuePoints: 3, round: 60, market: 11, fit: 0.2, avgPrice: 12, dumpBag: 3, params: E };
  // 8 auctions left, gain > 0, 60 coins: ceil(60 / ceil(8/3)) = 20.
  assert.ok(decideBid({ ...ctx, balance: 60, bagTotal: 8, endgameGain: 6 }).amount >= 20);
  assert.equal(allInBid(60, 8), 20);
  // Final 3 playable auctions: full balance (Vickrey and first-price alike).
  for (const left of [3, 2, 1]) {
    assert.equal(decideBid({ ...ctx, balance: 47, bagTotal: left, endgameGain: 4 }).amount, 47);
    assert.equal(decideBid({ ...ctx, balance: 47, bagTotal: left, endgameGain: 4, auctionType: "FirstPrice", marketPrice: 5 }).amount, 47);
  }
  // Zero gain: still 0. Last auction (bag 0): still 0.
  assert.equal(decideBid({ ...ctx, balance: 60, bagTotal: 8, endgameGain: 0 }).amount, 0);
  assert.equal(decideBid({ ...ctx, balance: 60, bagTotal: 0, endgameGain: 9 }).amount, 0);
  // Window = max(12, dump threshold + 9): a raised threshold of 6 widens it to 15.
  assert.equal(allInWindow(E, 3), 12);
  assert.equal(allInWindow(E, 6), 15);
  // Before the window nothing changes vs lucent2.
  const early = { ...ctx, balance: 60, bagTotal: 20, round: 45 };
  assert.equal(decideBid(early).amount, decideBid({ ...early, params: L2 }).amount);
  // Inside the window lucent2e never bids less than lucent2 (and goes all-in at the end).
  for (const left of [8, 5, 2]) {
    const c = { ...ctx, balance: 60, bagTotal: left, endgameGain: 6 };
    assert.ok(decideBid(c).amount >= decideBid({ ...c, params: L2 }).amount);
  }
  // Where it matters: a small positive gain mid-window, which lucent2 bids little for.
  const small = { ...ctx, valuePoints: 1, balance: 60, bagTotal: 10, endgameGain: 2 };
  const e = decideBid(small).amount;
  const l2 = decideBid({ ...small, params: L2 }).amount;
  assert.ok(e > l2 && e === allInBid(60, 10), `lucent2e ${e} vs lucent2 ${l2}`);
});

test("lucent2e completion premium fires only when the letter makes a 7+ word playable now", () => {
  const E = paramsForMode("lucent2e");
  const p = new Player(dict, { params: E });
  p.beginMatch(9n, 7n, 5, 6);
  const rack = countsOf("RETAIN");
  const s = p.completionReward(rack, 18); // S -> RETAINS (7 letters)
  assert.ok(s >= wordReward("RETAINS"), `S completion ${s}`);
  assert.equal(p.completionReward(rack, 16), 0); // Q: no 7+ word
  assert.equal(p.completionReward(countsOf("QZXJK"), 4), 0);
  const ctx = { ...bidCtx, letter: "S", valuePoints: 5, balance: 100, bagTotal: 40, round: 20, market: 11, fit: 0.9, avgPrice: 11, params: E };
  const withPrem = decideBid({ ...ctx, completionReward: s });
  assert.ok(withPrem.amount >= Math.min(100, Math.round(5 + 0.5 * s)), withPrem.reason);
  assert.ok(withPrem.reason.includes("completes 7+"));
  assert.ok(!decideBid({ ...ctx, completionReward: 0 }).reason.includes("completes 7+"));
  // Other modes ignore it.
  assert.ok(!decideBid({ ...ctx, completionReward: s, params: paramsForMode("lucent2") }).reason.includes("completes"));
});

test("lucent2e heads-up: never at 6 players; at 2 players bid >= 0.8x going price", () => {
  const E = paramsForMode("lucent2e");
  const view = { rack: countsOf("RETAIN"), balance: 90, bagTotal: 40, auctionType: "Vickrey" as const };
  const run = (players: number, params = E) => {
    const p = new Player(dict, { params });
    p.beginMatch(11n, 7n, 5, players);
    p.tracker!.setParticipant(7n, 90, 0);
    for (let i = 2; i <= players; i++) p.tracker!.setParticipant(BigInt(100 + i), 80, 0);
    p.tracker!.onAuction(1n, "D");
    return p.bid("D", view);
  };
  const six = run(6);
  assert.ok(!/heads-up|denial/.test(six.reason), six.reason);
  // 6-player bid identical to lucent2e with heads-up switched off.
  assert.equal(six.amount, run(6, { ...E, l2eHeadsUp: 0 }).amount);
  const two = run(2);
  if (two.value >= E.l2eHuMinValue) {
    assert.ok(two.amount >= Math.min(90, Math.ceil(0.8 * liveMarketPrice("D"))), `${two.amount} (${two.reason})`);
  }
  // The wrapper itself: floor and denial, capped at balance, never on the last auction.
  const base = { amount: 3, desired: 3, reason: "x" };
  assert.equal(applyHeadsUp(base, { value: 4, balance: 50, going: 12, rivalValue: 0, bagTotal: 20 }, E).amount, 10);
  assert.equal(applyHeadsUp(base, { value: 4, balance: 50, going: 12, rivalValue: 6, bagTotal: 20 }, E).amount, 16);
  assert.equal(applyHeadsUp(base, { value: 4, balance: 12, going: 12, rivalValue: 30, bagTotal: 20 }, E).amount, 12);
  assert.equal(applyHeadsUp(base, { value: 1, balance: 50, going: 12, rivalValue: 0, bagTotal: 20 }, E).amount, 3);
  assert.equal(applyHeadsUp(base, { value: 9, balance: 50, going: 12, rivalValue: 9, bagTotal: 0 }, E).amount, 3);
});

test("lucent2h = lucent2 + heads-up only: identical to lucent2 at 6 players", () => {
  const H = paramsForMode("lucent2h");
  const L2 = paramsForMode("lucent2");
  assert.equal(H.l2eHeadsUp, 1);
  assert.equal(H.l2AllIn, 0);
  assert.equal(H.l2eComplete, 0);
  assert.deepEqual({ ...H, l2eHeadsUp: 0 }, L2);
  // Same seeds, same events: every bid across a range of letters, racks and
  // bag sizes (incl. the endgame window) must match lucent2 at 6 players.
  const racks = ["RETAIN", "QUIZT", "EEAIO", "BCDFGH", "AERSTL", ""];
  for (const players of [6]) {
    for (const rackStr of racks) {
      for (const bag of [60, 40, 20, 12, 8, 3, 1, 0]) {
        const mk = (params: typeof H) => {
          const p = new Player(dict, { params });
          p.beginMatch(21n, 7n, 5, players);
          p.tracker!.setParticipant(7n, 70, 0);
          for (let i = 2; i <= players; i++) p.tracker!.setParticipant(BigInt(100 + i), 60, 0);
          return p;
        };
        const ph = mk(H), p2 = mk(L2);
        for (const [i, L] of ["E", "S", "Q", "D", "Z", "A"].entries()) {
          ph.tracker!.onAuction(BigInt(i + 1), L);
          p2.tracker!.onAuction(BigInt(i + 1), L);
          const view = { rack: countsOf(rackStr), balance: 70, bagTotal: bag, auctionType: "Vickrey" as const };
          const a = ph.bid(L, view), b = p2.bid(L, view);
          assert.equal(a.amount, b.amount, `rack ${rackStr} bag ${bag} letter ${L}: ${a.reason} vs ${b.reason}`);
          assert.ok(!/heads-up|denial/.test(a.reason));
        }
      }
    }
  }
  // At 2 players the heads-up profile can fire.
  const p = new Player(dict, { params: H });
  p.beginMatch(22n, 7n, 5, 2);
  p.tracker!.setParticipant(7n, 70, 0);
  p.tracker!.setParticipant(102n, 60, 0);
  p.tracker!.onAuction(1n, "S");
  const hu = p.bid("S", { rack: countsOf("RETAIN"), balance: 70, bagTotal: 40, auctionType: "Vickrey" });
  assert.ok(hu.amount >= Math.min(70, Math.ceil(0.8 * liveMarketPrice("S"))), hu.reason);
});

test("fast bid path: cached/quick value gives a bid without the full valuation", () => {
  const p = new Player(dict, { params: paramsForMode("lucent2e") });
  p.beginMatch(12n, 7n, 5, 6);
  p.tracker!.onAuction(1n, "E");
  const view = { rack: countsOf("RTAINS"), balance: 80, bagTotal: 30, auctionType: "Vickrey" as const };
  const t0 = performance.now();
  const fast = p.bid("E", view, { fast: true });
  const fastMs = performance.now() - t0;
  assert.ok(fast.amount > 0 && fastMs < 150, `fast ${fast.amount} in ${fastMs.toFixed(0)} ms`);
  const full = p.bid("E", view);
  assert.ok(full.amount > 0);
});

test("test and shadow logging never targets the live logs folder", () => {
  assert.ok(LIVE_LOG_DIR.endsWith("logs"));
  if (process.env.BOT_LOG_DIR || process.env.SHADOW === "1") assert.notEqual(LOG_DIR, LIVE_LOG_DIR);
});

const plan = (letters: string, extra: Partial<Parameters<typeof planWords>[0]> = {}) =>
  planWords({ dict, rack: countsOf(letters), bagTotal: 40, balance: 50, panic: false, needCoins: false, ...extra });

test("words: hoard mid-game, bank 7+ letters, cash in when short of coins", () => {
  assert.deepEqual(plan("QIZTE").words, []); // hoarding
  assert.ok(plan("RETAINSQ").words.some((w) => w.length >= 7));
  assert.deepEqual(plan("QUIZTE", { needCoins: true }).words, ["QUIZ"]);
  assert.deepEqual(plan("QUIZTE", { balance: PARAMS.lowBalance }).words, ["QUIZ"]);
  // No junk cash-ins: ART (+3) or a 3-letter word is never played for coins mid-game.
  assert.deepEqual(plan("ARTE", { needCoins: true }).words, []);
  assert.deepEqual(plan("ZITE", { balance: 2 }).words, []);
});

test("words: endgame and panic play everything, biggest first", () => {
  for (const extra of [{ bagTotal: PARAMS.endgameBag }, { panic: true }]) {
    const p = plan("QIZTEDOG", extra);
    assert.ok(p.words.length >= 2, p.reason);
    for (let i = 1; i < p.words.length; i++) {
      assert.ok(wordReward(p.words[i - 1]!) >= wordReward(p.words[i]!));
    }
  }
});

test("simulator: a full match follows the module's rules", () => {
  const res = simulateMatch(dict, ["me", "Cheapskate", "ValueBidder", "Aggressive"], "Vickrey", 42);
  assert.equal(res.length, 4);
  const wins = res.reduce((s, r) => s + r.wins, 0);
  assert.ok(wins <= 98 - 4 * 5 && wins > 40, `wins ${wins}`);
  for (const r of res) assert.ok(r.balance >= 0);
  assert.ok(res[0]!.score > 0);
});
