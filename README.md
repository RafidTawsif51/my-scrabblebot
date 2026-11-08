# Jaeger — a data-driven ScrabbleBot

Jaeger is a bot for [ScrabbleBot](https://scrabblebot.spacetimedb.com), a
Scrabble-style auction game where bots bid for letters in sealed-bid
auctions and score points by spelling words. It was built for the
2026-11-07 ScrabbleBot tournament on top of the official
[clockworklabs/scrabblebot](https://github.com/clockworklabs/scrabblebot)
starter. The game server, spectator site and starter are theirs. Jaeger
is the code in `bot-starter/`.

> **Final results:** _TBD — tournament placement, Swiss record and final
> live averages per mode go here._

## The game in brief

These rules were checked against the module source and the live server.
[RULES.md](RULES.md) has the details, including where the docs and the
source disagree.

- 6 bots per match. Each starts with 100 coins and 5 private tiles from
  a 98-tile bag (no blanks).
- One letter is auctioned every second, so there are 68 auctions per
  match. Lobby matches use **Vickrey** pricing (the winner pays the
  second-highest bid). Tournaments may use first-price.
- Words can be played at any time from your own tiles. Reward =
  `floor(letter sum × length multiplier)`, with multipliers 1× (≤3
  letters), 1.5×, 2×, 2.5×, and **3× for 7+ letters**.
- The reward goes into both your score and your balance. **Spending
  never lowers your score**, and coins or tiles left at the end are
  worth nothing.
- Unsold tiles are discarded, not returned to the bag (the docs say
  otherwise). The match ends the moment the last auction closes, so the
  last tile can never be played.

## What Jaeger does

**Valuation.** A letter is worth the expected increase in my final
points. Jaeger runs a Monte Carlo over future draws from the remaining
bag: the best partition of `rack + letter + future tiles` minus the
best partition of `rack + future tiles`, using the same samples for
every letter. Words are indexed by sorted letters in a trie, so the
best-partition search takes ~0.2 ms for a 12-tile rack. While an
auction runs, all 26 letters are precomputed for both "I win this tile"
and "I lose it", so most bids come straight from a cache.

**Bag tracking.** The remaining pool is the full bag, minus every
auctioned letter (sold or not), minus my starting tiles, minus
opponents' starting tiles once they reveal them in words. Opponents'
balances and scores are public. Their racks are estimated from what
they won minus what they played.

**Market-aware bidding.** Bids are value ÷ a coin "shadow price". That
price comes from the coins needed to keep buying at the observed market
price, relative to my balance, and it falls toward zero as auctions run
out. In Vickrey, Jaeger bids true value. In first-price, it shades
toward the observed market price + 1. A market floor (0.7× the going
price) keeps it from losing ordinary tiles it values too low. The last
auction is never bid on, because that tile can't be played.

**Balance-aware bidding.** No one can bid more than their balance. In
first-price, Jaeger never bids above `maxOpponentBalance + 1`. In
Vickrey, if its value is above every opponent's balance, it bids its
whole balance: the win is certain and the price is capped at that
balance. In 600 paired simulated matches this added +0.29 ± 0.11 points
(Vickrey) and +0.86 ± 0.16 (first-price). It rarely triggers live,
because idle bots sit at 100 coins.

**Word conversion.** Jaeger saves tiles toward 7+ letter words (3×),
plays them as soon as they appear, and cashes in a word when it runs
short of coins. Near the end it plays everything. The endgame threshold
is dynamic, `max(3, ceil(p95 word latency / auction length) + 2)`, and a
panic mode plays everything at once if a server call takes over 1.5 s.

## How it was built: data first

1. **Read the source, not just the docs.** The source showed rules the
   docs get wrong (unsold tiles are discarded; the lobby lasts 90 s, not
   60). It also showed that the stock starter could never play a word
   on Windows: its wordlist path bug left the dictionary empty.
2. **Measure the live field.** Every analysis used public tables only,
   over an anonymous connection (`bot-starter/tools/`). Findings from
   hundreds of live matches:
   - The top bots (Bron, LUCENT) win ~20 tiles per match at ~9–10 coins
     each. The first Jaeger won ~9 tiles at ~13.
   - Bron's 7+ letter words are no richer per letter than ours. Its
     edge is more and longer words, plus richer short words.
   - Bron's bids don't track opponents' balances.
   - LexForge-1107 and RackMaw treat coins as fuel. They bid ~15–16
     from round 1, play a word when nearly out of coins, and finish
     with ~11 coins; we finished with ~40.
   - Lucent mode wins as many tiles as LexForge but loses ~14 points
     per match on **5–6 letter words**. Its spare tiles end up in 2–3
     letter junk.
3. **Simulate.** `bot-starter/src/sim.ts` follows the module's rules
   exactly. Its opponents are fitted to live behaviour: per-letter bid
   distributions measured from the server, and a field calibrated so
   that our own bot reproduces its live numbers (~83 points, ~12.5
   tiles, ~12 coins per tile). Every change was tested on the same
   deals for old and new versions before going live.
4. **A/B live.** `$env:JAEGER_MODE` switches strategies, every match log
   records its mode, and `npm run compare` summarises them.

### Modes

| Mode | Idea | Outcome |
|---|---|---|
| `v3` (default) | Monte Carlo valuation + budget-based coin price + 0.7× market floor + balance-aware bids | The baseline. The market floor alone took live scores from ~66 to ~83. |
| `lucent` | Bid at least the market price on letters that fit a 7–8 letter word (0.6× otherwise), play every 7+ word at once, spend down to ~0 coins | Wins more tiles than v3. Wins more often in early live matches. |
| `fuel` | Copy LexForge/RackMaw: coins are fuel, market-plus bids from round 1, refuel by cashing 5+ letter words | **Rejected.** Its prices came from Bron/LUCENT's medians, which sat below some tables' prices. In one match it held 110 coins for ~20 auctions while losing every bid. In-match price learning and a spend-rate controller fixed that, but the mode had already underperformed (53.5 points over its first 4 live matches) and was dropped. |
| `lucent2` | lucent + choose 7+ words by what they leave behind + hold a 7 for a likely 8 + exact endgame planning (no bids on letters that add nothing) + Q/Z/J/X up to 40 + **cash out 5–6 letter words from spare tiles** | Aimed at the 5–6 letter word leak. Simulator: +0.9 ± 1.5 vs lucent (not significant); judged on the live A/B. |

Some ideas did worse in testing and were dropped:
- Valuing letters by closeness to a 7–8 letter word on its own (−14 to
  −20 points in simulation).
- Lowering expected prices when opponents run short of coins (−2 to −22).
- Boosting high-value letters: the data showed richer letters aren't
  what separates the top bots.

## Running it

Requires Node 20+ and, for regenerating bindings, the
[SpacetimeDB CLI](https://spacetimedb.com/install). Commands are
PowerShell. On macOS/Linux use `BOT_NAME=… npm start`.

```powershell
cd bot-starter
npm install
npm run generate        # client bindings from the module

# First run: token from your team page (saved to .token-<BOT_NAME>, gitignored)
$env:BOT_NAME="jaeger"; $env:BOT_TOKEN="<token>"; npm start
# Later runs:
$env:BOT_NAME="jaeger"; npm start
# Pick a strategy (v3 | lucent | lucent2 | fuel):
$env:JAEGER_MODE="lucent2"; npm start
# Enter a tournament:
$env:TOURNAMENT_ID="<id>"; npm start
# Watch-only: anonymous, no token, no reducer calls, logs to sim-output/
$env:SHADOW="1"; npm start
```

The bot never prints or logs its token. `.token-*` and `.env` are
gitignored.

| Command | What it does |
|---|---|
| `npm test` | Unit tests (rules, word search, tracker, bidding, word timing, modes) |
| `npm run sim -- 100 vickrey like,likealt alt.lucent2=1 …` | Offline paired comparisons in the calibrated simulator |
| `npm run compare` | Live results per mode from `logs/summary.jsonl` |
| `npm run bench` | Word-search speed |
| `npx tsx tools/fetch-matches.ts out.json <botIds>` | Anonymous download of public match data |
| `npx tsx tools/analyze.ts out.json` | Spending, word and bid-function stats per bot |

Per-match logs (bids, results, words, latency, mode) are written to
`bot-starter/logs/`.

## Layout

| Path | Contents |
|---|---|
| `bot-starter/src/index.ts` | Connection, targeted subscriptions (the stock `subscribeToAllTables` pulled ~3.5 GB), event handling, reconnects |
| `bot-starter/src/player.ts` | The bot's decision logic, shared by the live bot and the simulator |
| `bot-starter/src/dictionary.ts`, `bingo.ts` | Word index, best partition, closeness to 7–8 letter words |
| `bot-starter/src/valuation.ts`, `tracker.ts`, `market.ts` | Monte Carlo letter values, bag/opponent tracking, live price model |
| `bot-starter/src/strategy.ts` | Bidding and word policy, all modes, tuned parameters |
| `bot-starter/src/sim.ts` | Rules-exact simulator with opponents fitted to live data |
| `bot-starter/tools/` | Live-data analysis (public tables, anonymous) |
| `RULES.md` | The game rules as the module enforces them |

## Credits

- **Clockwork Labs** for ScrabbleBot, the SpacetimeDB module, spectator
  site and bot starter ([clockworklabs/scrabblebot](https://github.com/clockworklabs/scrabblebot),
  MIT). The original project README is in this repo's git history.
- **Public Cal Hacks writeups** that informed this bot:
  - _TODO: title, author, link_
  - _TODO: title, author, link_
- The other bots in the field (Bron, LUCENT, LexForge-1107, RackMaw and
  others), whose public match data was the best teacher.
- Dictionary: the public-domain ENABLE wordlist, as shipped with the
  module.

## License

MIT, as upstream.
