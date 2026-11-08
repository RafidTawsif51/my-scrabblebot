# Jaeger — Survey Corps

Jaeger is the Survey Corps bot for [ScrabbleBot](https://scrabblebot.spacetimedb.com),
a Scrabble-style auction game. Bots bid for letters in sealed-bid auctions
and score points by spelling words. Jaeger lives in `bot-starter/`. It is
built on the official starter from Clockwork Labs, whose original README
is kept [below the divider](#scrabblebot).

## What the bot does

**Monte Carlo letter valuation.** A letter is worth the expected gain in
final points from owning it. That is the best word split of `rack +
letter + future tiles` minus the best split of `rack + future tiles`,
averaged over draws from the remaining bag, using the same samples for
every letter. Words are indexed by their sorted letters in a trie, so the
best-split search takes about 0.2 ms for a 12-tile rack. While an auction
runs, all 26 letters are precomputed for both "I win this tile" and "I
lose it". When an auction opens, a bid goes out immediately from that
cache, then gets refined.

**Bag and opponent tracking.** The remaining pool is the full 98-tile bag,
minus every auctioned letter (unsold tiles are discarded, not returned),
minus my starting tiles, minus opponents' starting tiles once they reveal
them in words. Opponents' balances and scores are public. Their racks are
estimated from what they won minus what they played.

**Market-aware bidding.** A bid is the letter's value divided by a coin
"shadow price". That price is the coins needed to keep buying at this
match's observed prices, relative to my balance, and it falls toward zero
as auctions run out. A floor at 0.7× the going price stops it losing
ordinary tiles, and letters that fit a plausible 7–8 letter word are bid
at the live market price. In Vickrey auctions it bids true value; in
first-price it shades toward the market price + 1. It never bids on the
last auction, because that tile can't be played.

**Balance-aware bidding.** No one can bid more than their balance. In
first-price, Jaeger never bids above `max opponent balance + 1`. In
Vickrey, if its value beats every opponent's balance it bids its whole
balance: the win is certain, and the price is capped by that balance.

**Leave-aware 7–8 letter words.** Words of 7+ letters score 3×. Among
playable 7+ words, Jaeger picks by points plus how close the leftover
rack stays to the next 7–8 letter word. It holds a 7 only if an 8 is one
likely letter away, the bag still has ≥ 25 tiles, and it has ≥ 30 coins.

**5–6 letter cash-outs.** Live data showed our biggest leak was 5–6
letter words: 7.5 points/match vs 22–23 for the best word-converting
bots. Spare tiles that don't help the next 7 are now cashed in as 5–6
letter words mid-game instead of ending as 2-letter junk.

**Exact endgame partition.** From 12 tiles left, each auctioned letter is
valued by how much it raises the exact best split of the rack into
words. Letters that add nothing get a bid of 0. At the dump threshold it
plays that exact split, never junk 2-letter words when a better split
exists.

**Latency-aware endgame.** The match ends the moment the last auction
closes, so the final words have to land in time. The dump threshold is
`max(3, ceil(p95 word latency / auction length) + 2)`. A single slow
server call raises it to `ceil(spike / auction) + 3`, but never dumps
words mid-game, and the spike ages out after 10 normal calls.

**Heads-up mode for the final.** With exactly two players, Jaeger bids at
least 0.8× the going price on any useful letter, to drain the rival, and
adds the letter's value to the rival's tracked rack (denial). This only
runs with two players; with six, every bid is identical to the normal
mode (tested over 288 bid situations).

## How it was built: data first

1. **Read the module source, not just the docs.** Unsold tiles are
   discarded, the lobby lasts 90 s (not 60), and the last tile can never
   be played. The stock starter also loaded an empty dictionary on
   Windows, because of a path bug, so it never played a word.
2. **Analyse the live field.** Everything used public tables over an
   anonymous connection (`bot-starter/tools/`), across hundreds of
   matches of the top bots (Bron, LUCENT, LexForge, RackMaw, Lbender,
   aipom). Findings:
   - Top bots win more tiles per match.
   - Their 7+ letter words are no richer per letter than ours. Their edge
     is more and longer words, plus 5–6 letter words.
   - Points per coin are almost identical across bots: Jaeger 0.51 vs
     0.52–0.58 for the top bots. The gap is how many coins get spent, not
     what is paid per letter.
   - Bids don't track opponents' balances.
3. **Simulate.** `bot-starter/src/sim.ts` reproduces the module's rules
   exactly. Its opponents are fitted to measured live bidding, and the
   field is calibrated so that our own bot reproduces its live numbers.
   Old and new versions are compared on the same deals, with a paired
   standard error.
4. **A/B live.** `$env:JAEGER_MODE` switches strategies. Every match log
   records its mode, and `npm run compare` summarises them.

### Modes tested

Live results from Jaeger's own logs, at the time of writing:

| Mode | Idea | Live (matches, avg score) | Verdict |
|---|---|---|---|
| `v3` | Monte Carlo valuation, budget-based coin price, 0.7× market floor, balance-aware bids | 91, 76.4 | Baseline. The floor alone lifted live scores from ~66 to ~83 over its first 10 matches. |
| `lucent` | Market bids on letters that fit a 7–8 letter word, play every 7+ word at once, spend down | 25, 78.8 | Kept as the base for later modes |
| `lucent2` | lucent + leave-aware 7s, hold-for-8, exact endgame, 5–6 letter cash-outs, Q/Z/J/X up to 40 | 26, 78.6 | Kept |
| `fuel` | Copy the coins-as-fuel bots: market-plus bids from round 1, refuel with 5+ letter words | 10, 54.8 | **Rejected.** Its price targets came from other bots' medians, which sat below many tables' prices, so it held 110 coins while losing every bid. In-match price learning and a spend-rate controller fixed that case, but results stayed poor. |
| `lucent3` | lucent2 + spend-down controller + earlier refuel | 32, 73.3 | **Rejected.** The first version overspent (35 of 36 coins on one F, then 1 coin for 16 auctions). After a trajectory-based fix with hard caps, it still scored below lucent2. |
| `lucent2e` | lucent2 + endgame all-in + 7+ completion premium + heads-up | 10, 64.3 | **Rejected.** It paid 13.6 coins per tile for 9.2 tiles; the all-in and completion premium overpaid. Only its heads-up profile was kept. |
| **`lucent2h`** | lucent2 + heads-up profile (two players only) | new | **Final mode.** Identical to lucent2 in six-player matches. |

Other ideas lost in testing and were dropped:
- Valuing letters by closeness to a 7–8 letter word on its own (−14 to
  −20 points in simulation).
- Pacing bids on opponents' remaining coins (−2 to −22).
- Boosting high-value letters: the data showed richer letters aren't the
  top bots' edge.

## Running it

Requires Node 20+, plus the [SpacetimeDB CLI](https://spacetimedb.com/install)
for generating client bindings. Commands are PowerShell. On macOS/Linux
use `BOT_NAME=jaeger JAEGER_MODE=lucent2h npm start`.

```powershell
cd bot-starter
npm install
npm run generate                       # client bindings from the module

# First run: paste the token from your team page. It is saved to
# .token-<BOT_NAME> (gitignored) and never printed or logged.
$env:BOT_NAME="jaeger"; $env:BOT_TOKEN="<your token>"; npm start

# Every later run, in the final mode:
$env:BOT_NAME="jaeger"; $env:JAEGER_MODE="lucent2h"; npm start

# Enter a tournament:
$env:TOURNAMENT_ID="<id>"; npm start

# Watch-only: anonymous, no token, no reducer calls, logs to sim-output/
$env:SHADOW="1"; npm start
```

| Command | What it does |
|---|---|
| `npm test` | Unit tests: rules, word search, tracker, bidding, word timing, every mode |
| `npm run compare` | Live results per mode from `logs/summary.jsonl` |
| `npm run sim -- 100 vickrey like,likealt alt.<param>=<value>` | Paired offline comparison in the calibrated simulator |
| `npx tsx tools/fetch-matches.ts out.json <botIds>` | Anonymous download of public match data |
| `npx tsx tools/efficiency.ts out.json` | Points per coin, per bot and per letter |

| Path | Contents |
|---|---|
| `bot-starter/src/index.ts` | Connection, targeted subscriptions (the stock `subscribeToAllTables` pulled ~3.5 GB), instant bidding, reconnects |
| `bot-starter/src/player.ts` | The bot's decision logic, shared by the live bot and the simulator |
| `bot-starter/src/strategy.ts` | Bidding and word policy for every mode, plus tuned parameters |
| `bot-starter/src/dictionary.ts`, `bingo.ts` | Word index, best word split, closeness to 7–8 letter words |
| `bot-starter/src/valuation.ts`, `tracker.ts`, `market.ts` | Monte Carlo values, bag and opponent tracking, live price model |
| `bot-starter/src/sim.ts`, `bot-starter/tools/` | Simulator and live-data analysis |
| `RULES.md` | The game's rules as the module enforces them |

## Credits

- **Clockwork Labs** for ScrabbleBot, the SpacetimeDB module, spectator
  site and bot starter
  ([clockworklabs/scrabblebot](https://github.com/clockworklabs/scrabblebot), MIT).
- The public writeups of
  **[Vickrey-Scrabblebot](https://github.com/KarthikSubramanian07/Vickrey-Scrabblebot)**
  and **[Nijello](https://github.com/3nvyx/nijello-scabble-bot)**. Ideas
  drawn from them include the completion premium, heads-up play and
  latency-safe bidding.
- Everyone in the live field. Their public match data was the best
  teacher.
- Dictionary: the public-domain ENABLE wordlist shipped with the module.

---

# ScrabbleBot

A Scrabble-style auction game where AI bots compete for letters.

Each round the module reveals one letter from a shared Scrabble bag and runs a
1-second sealed-bid auction. The highest bidder wins the letter, adds it to
their rack, and pays (Vickrey or first-price). Bots play words from their
collected letters at any time to earn currency, which funds future bids. Long
words pay a superlinear bonus, so hoarding is rewarded.

Built on [SpacetimeDB](https://spacetimedb.com): rules, timing, lobby
formation, dictionary — all inside a TypeScript module. Bots are external
SpacetimeDB clients (any language); the spectator UI is a Vite + React app.

Live at **[scrabblebot.spacetimedb.com](https://scrabblebot.spacetimedb.com)** ·
Bot-writing docs: **[/docs](https://scrabblebot.spacetimedb.com/docs)**

## Repo layout

The web client lives at the repo root (standard SpacetimeDB project shape);
the module is nested inside it.

| Path | What it is |
|---|---|
| `src/`, `index.html`, `vite.config.ts` | Vite + React spectator UI |
| `spacetimedb/` | TypeScript module — schema, reducers, scheduled lobby + auction ticks, dictionary |
| `bot-starter/` | TypeScript starter bot — fork & edit `src/strategy.ts` |

## How a match comes together

There's a single rolling **lobby** that's always open for 60 seconds at a
time:

- Real bots `join_lobby()` at any time.
- If 6 real bots join → match starts immediately.
- If the timer expires → match starts with whoever's there, padded out to 6
  with idle simulated bots.
- A fresh lobby opens the moment the previous one resolves.

This means matches run continuously without anyone having to manually
schedule them. Bots that finish a match just call `join_lobby()` again.

## The rules

- **Auction:** 1-second sealed-bid window per letter. Highest bid wins; ties
  are broken at random.
- **Payment:** Vickrey by default (winner pays the runner-up's bid; reserve
  1). First-price is configurable per lobby.
- **Currency:** start at 100 per match. Reward for a word = base score ×
  length multiplier (1.0× ≤3 letters → 3.0× ≥7 letters). Reward goes into
  both `balance` (spendable) and `score` (ranking).
- **Letters:** standard 98-tile Scrabble bag (no blanks). Match ends when the
  bag empties. Tiles nobody bids on go back to the bag.
- **Visibility:** `Holding` and `BagLetter` are private. Bots see only their
  own rack via the `my_rack` view; nobody can subscribe to the full bag
  composition. The spectator reconstructs opponents' racks from public
  `AuctionResult` + `WordPlay` events.
- **Dictionary:** the public-domain
  [ENABLE](https://en.wikipedia.org/wiki/Moby_Project#ENABLE) wordlist
  (~173k words), embedded from `spacetimedb/wordlist.txt`. Swap in TWL or
  SOWPODS if you have a license.
- **Rating:** the leaderboard ranks by OpenSkill (Plackett-Luce), shown on
  an Elo-like scale where new bots start at 1500, with a ± for how unsure
  it is. A bot is provisional, without a rank, until its ± is within 175.
  It updates at every match end. An Elo rating (K=32) is kept alongside it.
  A team can start a new version of its bot to start the rating over.

## Writing a bot (5-minute version)

Three steps end-to-end:

1. **Get a token** — on the live site, link your spacetimedb.com identity at
   `/account`, then create a team at `/team/new`, then click *Generate token*
   on `/team`. You'll get a SpacetimeDB JWT bound to a credential for your
   team's bot persona (shown once).
2. **Fork the starter** and plug the token in:
   ```bash
   git clone https://github.com/clockworklabs/scrabblebot
   cd scrabblebot/bot-starter
   npm install
   npm run generate
   BOT_NAME=alice BOT_TOKEN=<token> npm start
   ```
3. **Edit `bot-starter/src/strategy.ts`** — two functions:
   - `decideBid(ctx)` — return how much to bid for the current letter.
   - `chooseWord(ctx)` — pick a word to play from your rack.

That's it. Your bot will auto-join the lobby, play in matches as they form,
and re-join after each one ends. Token is persisted to
`.token-<BOT_NAME>` after the first run.

For a deeper writeup — what's visible to your bot, the reducer API, the
SpacetimeDB connection snippet end-to-end — see **[/docs](https://scrabblebot.spacetimedb.com/docs)**.

Bots can use any language SpacetimeDB has an SDK for (Rust, C#, TypeScript).
The starter is just convenience; the reducer interface is language-agnostic.

## Running the project locally

For development work on the module or UI:

```bash
npm install
npm install --prefix spacetimedb
npm run dev
```

This launches `spacetime dev` against maincloud — auto-builds the module,
publishes it, regenerates client bindings, and starts the Vite client on
http://localhost:5173. Edit `spacetimedb/src/` and changes flow
straight through to the browser.

The maincloud database name is set in `spacetime.local.json` (defaults to
`scrabblebot`). The `init` reducer seeds a default admin and the simulated
bot pool on every fresh database init.

### Other npm scripts

- `npm run dev:local` — same flow against a local `spacetime start` server.
- `npm run publish` — one-shot publish to the configured server.
- `npm run generate` — regenerate client bindings without the watcher.
- `npm run build` / `npm run preview` — production build of the spectator.

## Tournament mode

`/admin` (admin-only) has a tournament launcher: Swiss rounds → top-N cut →
single-elimination bracket → best-of-3 finals. Match size, Swiss round
count, and top cut are configurable. Ratings are updated independently
of tournament standings.

## Known limitations

- No human play — bots only.
- Token-recovery for bots is via the *rotate* model: mint a new credential
  on `/team` and the old token keeps working in parallel. The bot persona
  itself survives.

## License

MIT.
