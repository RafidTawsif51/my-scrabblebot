// Run with `npm test`.

import assert from "node:assert/strict";
import { test } from "node:test";
import { countsOf, countsKey, Dictionary, totalOf, wordReward } from "./dictionary.js";
import { decideBid, planWords, PARAMS } from "./strategy.js";
import { MatchTracker } from "./tracker.js";
import { valueLetterNow } from "./valuation.js";
import { simulateMatch } from "./sim.js";

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
