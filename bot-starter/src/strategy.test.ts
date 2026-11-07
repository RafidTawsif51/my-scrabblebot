// Run with `npm test`.

import assert from "node:assert/strict";
import { test } from "node:test";
import { countsOf, countsKey, Dictionary, totalOf, wordReward } from "./dictionary.js";
import { decideBid, dynamicEndgameBag, planWords, PARAMS } from "./strategy.js";
import { MatchTracker } from "./tracker.js";
import { valueLetterNow } from "./valuation.js";
import { simulateMatch } from "./sim.js";
import { BingoIndex, relativeGain } from "./bingo.js";
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

test("test and shadow logging never targets the live logs folder", () => {
  assert.ok(LIVE_LOG_DIR.endsWith("logs"));
  if (process.env.BOT_LOG_DIR || process.env.SHADOW === "1") assert.notEqual(LOG_DIR, LIVE_LOG_DIR);
});

const plan = (letters: string, extra: Partial<Parameters<typeof planWords>[0]> = {}) =>
  planWords({ dict, rack: countsOf(letters), bagTotal: 40, balance: 50, panic: false, needCoins: false, ...extra });

test("words: hoard mid-game, bank 7+ letters, cash in when short of coins", () => {
  assert.deepEqual(plan("QIZTE").words, []); // hoarding
  assert.ok(plan("RETAINSQ").words.some((w) => w.length >= 7));
  assert.equal(plan("QIZTE", { needCoins: true }).words.length, 1);
  assert.equal(plan("QIZTE", { balance: PARAMS.lowBalance }).words.length, 1);
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
