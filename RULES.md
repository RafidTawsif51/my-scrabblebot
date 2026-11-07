# ScrabbleBot — live rules (as enforced by the module)

Sources read: https://scrabblebot.spacetimedb.com/docs (= `docs/bot-guide.md`),
`README.md`, `spacetimedb/src/*` (module source), `bot-starter/src/*`.
Live values were checked against maincloud DB `scrabblebot` on 2026-11-07
via `spacetime sql` (public tables only).

**Where docs and source disagree, the source wins.** Disagreements are marked ⚠️
and collected in [§12](#12-docs-vs-source-disagreements).

---

## 1. Match setup

| Rule | Value | Source |
|---|---|---|
| Starting rack | **5 tiles** per bot, dealt randomly from the bag, private | `STARTING_RACK_SIZE = 5` (`game.ts`) |
| Starting coins (`balance`) | **100** per match | `STARTING_BALANCE = 100n` |
| Starting score | 0 | `startMatchWith` |
| Bag | Standard 98 tiles, **no blanks**, one bag per match | `letters.ts` `DEFAULT_BAG` |
| Players per lobby match | 6 | `LOBBY_MAX_SIZE = 6` |
| Lobby auction type | Always **Vickrey** | `openLobbyOrCreate` hardcodes it |
| Tournament auction type | Admin's choice per tournament (`tournament.auction_type`) | `createTournament` |

Rack size, lobby size and auction length are admin-tunable through the
`matchmaker_config` table (row id 0). **Live check: that table is empty**, so
the defaults above apply. Each `match_state` row stores its own
`starting_rack_size` and `auction_duration_ms`, so read those from the match
rather than hardcoding them. Recent live matches show 5 and 1000.

Bag distribution (letter × count, value):
A×9(1) B×2(3) C×2(3) D×4(2) E×12(1) F×2(4) G×3(2) H×2(4) I×9(1) J×1(8)
K×1(5) L×4(1) M×2(3) N×6(1) O×8(1) P×2(3) Q×1(10) R×6(1) S×4(1) T×6(1)
U×4(1) V×2(4) W×2(4) X×1(8) Y×2(4) Z×1(10)

With 6 bots: 30 tiles are dealt, leaving **68 auctions** per match (confirmed
live: ended matches show `current_round = 68`). That is about 68–70 seconds
of play.

## 2. Auction timing

- Only one auction per match is open at a time. When one closes, the next letter is
  drawn and a new `auction` row is inserted **in the same transaction**.
- Window: **1000 ms** (`AUCTION_DURATION_MS`; per-match `auction_duration_ms`).
  `closes_at = opens_at + duration`.
- A bid is accepted only if the server timestamp is `< auction.closes_at` and
  the auction's status is `Open`. Late bids fail with `"Auction window expired"` / `"Auction closed"`.
- The auction closes when the scheduled `auction_tick` fires at `closes_at`.
- Sim bots bid instantly when the auction opens, in the same transaction.

## 3. Bidding & payment rule

- `submit_bid(auction_id, amount)`: `amount` must be ≥ 0 and ≤ your
  **current balance**. You must be a participant in that auction's match.
- **Re-bidding replaces** your earlier bid on that auction, and only your latest bid counts.
  A bid of **0 counts as no bid**, because bids of 0 are filtered out at close, so bidding 0 withdraws you.
- Bids are sealed: `pending_bid` is private. During a running match, bots
  get an empty `visible_auction_top_bids` view.
- **Vickrey (lobby default):** winner pays the **second-highest bid**. If
  nobody else bid (>0), the winner pays `min(1, own bid)` = **1** (the reserve).
- **First-price:** winner pays their own bid.
- The payment is deducted from `balance`. **Score is never reduced by spending.**
- If the winner can't afford `paid` at close, they don't get the tile, but
  `auction_result.winner_bot_id` still names them. This can't happen in normal
  play, because you can only bid what you have and your balance only goes down at auction close.

## 4. Tie-breaking

- **Equal top bids → random winner.** Bids are shuffled, then stably sorted by amount.
  There is no first-come advantage. In Vickrey a tie means the winner pays their own bid,
  since the second-highest bid equals it.
- **Within a match**, placement is by `score`. Equal scores share the place, and everyone tied for the top score
  is counted as a win.
- **Tournament ties**: see §9.

## 5. Unsold tiles ⚠️

If an auction gets **no bid > 0**, the letter is **discarded**. It is NOT
returned to the bag, and `auction_result` records `winner_bot_id = none, paid = 0`.
`closeAuction` never re-adds to the bag. Live match 42743 had an unsold
auction and still ran exactly 68 rounds. The docs say unsold tiles return to the bag. They don't.

## 6. Words & reward formula

- `submit_word(match_id, word)` can be called **any time while the match is
  `Running`**, as often as you like. **Multiple words are allowed**, with no
  per-round limit and no cooldown. **The same word can be played repeatedly.**
  There is no duplicate check.
- One word per call. No board, no hooks, no crossing: you just spend tiles from your rack.
- Validation: lowercase a–z is uppercased, then the word must be A–Z only, **≥ 2 letters**, and in the
  ENABLE wordlist (`spacetimedb/wordlist.txt`, binary search). You must hold
  every letter, counting repeats. On success those tiles are removed from your rack.
- Reward:
  ```
  base   = sum(letterValue(c))            # standard Scrabble values
  reward = floor(base * num / den)        # integer division
  ```
  | Length | Multiplier (num/den) |
  |---|---|
  | 2–3 | 1.0× (1/1) |
  | 4 | 1.5× (3/2) |
  | 5 | 2.0× (2/1) |
  | 6 | 2.5× (5/2) |
  | 7+ | 3.0× (3/1) |

  Example: `QUIZ` base 10+1+1+10 = 22 → floor(22×3/2) = 33.
- `reward` is added to **both** `balance` (spendable) and `score` (ranking).
  `word_play` stores `base_score`, `bonus` (= reward − base), and `total_reward`.

## 7. Match end

- After each auction closes, the module draws the next letter. If the bag is
  empty, the match is set to `Ended` in that same transaction. This happens right after the
  last auction resolves, and there is no grace period for words.
- `submit_word` after that fails with `"Match not running"`.
- **Final score = `match_participant.score`** = the sum of word rewards. Leftover
  `balance` and unplayed tiles are **worth nothing**. There is no penalty for them, but no
  value either.
- Ratings (OpenSkill and Elo) update at match end from finishing order by score.

## 8. Lobby

- Rolling single lobby. `join_lobby()` enters it, and calling it again is idempotent.
- ⚠️ The lobby window is **90 s** (`LOBBY_DURATION_SECONDS = 90n`, confirmed live:
  `closes_at − opens_at = 90 s`). The docs and README say 60 s.
- 6 real bots → the match starts immediately. On timeout, the lobby is padded to 6 with sim bots.
  Fewer than 2 bots → the lobby is cancelled and a new one opens.
- `join_lobby` is refused if you're in a running match or held by an underway tournament.
- Sim bots (padding): `Cheapskate` bids value−1, `ValueBidder` bids value,
  `Aggressive` bids value+2 (+4 for vowels), each with a ±2 random jitter, a minimum of 1, and capped at their balance.
  Sims only play a word **right after winning an auction**: the longest word of
  ≥ 3 letters they can make.

## 9. Tournament

- An admin creates it. **Your bot registers itself** with
  `register_for_tournament(tournament_id)` during `Registration`.
  The starter does this when `TOURNAMENT_ID` is set:
  `$env:BOT_NAME="jaeger"; $env:TOURNAMENT_ID="<id>"; npm start`.
- When it starts, entrants are removed from the open lobby and `join_lobby` refuses them
  until they're eliminated or the tournament ends. Round 1 waits until no entrant is in a running casual match.
- **Swiss rounds**: round 1 is shuffled, later rounds are seated by standings. Table
  sizes: floor(n / match_size) tables, with the extras spread out (sizes differ by ≤1).
  **Swiss points** = `max(match_size − place, 0)`, where place = the number of bots with a
  strictly higher score. Ties share the higher place. With size 6: 1st=6, 2nd=5, … 6th=1.
  The match score is also added to the entry's `total_score`.
- **Cut**: the top `top_cut` by (Swiss points ↓, total score ↓, bot id ↑).
  More than 2 left → Bracket, otherwise Final.
- **Bracket (elimination)**: all survivors play one match together, and the
  **last place is knocked out**. A tie for last goes to the lower tournament total
  score, and if still tied, the **higher** bot id is eliminated. Repeat until 2 remain.
  The admin starts each match.
- **Final**: **3 games**. The champion has the highest summed score across the 3 games,
  then the higher tournament total score, then the lower bot id. No replays.
- Offline registered bots are still seated, and they lose every auction they don't bid in.
- The previous live tournament (id 1) used 4 Swiss rounds, top_cut 6, match_size 6, Vickrey.

## 10. What a bot can see

Public tables (subscribe-able):

| Table | Useful fields |
|---|---|
| `match_state` | `id, status (Lobby/Running/Ended), current_round, current_auction_id, bag_total` (tiles left in the bag **excluding** the one on auction), `auction_type, auction_duration_ms, starting_rack_size, created_at/started_at/ended_at` |
| `match_participant` | `match_id, bot_id, balance, score`. **Everyone's balance and score are public.** |
| `auction` | `id, match_id, letter, opens_at, closes_at, status (Open/Closed)` |
| `auction_result` | `auction_id, match_id, letter, winner_bot_id (option), paid, closed_at`. In Vickrey, `paid` reveals the 2nd-highest bid. |
| `word_play` | `match_id, bot_id, word, base_score, bonus, total_reward, played_at` |
| `auction_top_bid_archive` | top bids for **ended** matches only |
| `lobby`, `lobby_member` | the rolling lobby (all history, so filter `status = Open`) |
| `bot`, `bot_credential` | all bots (`is_simulated`, `strategy` for sims!). Look up your `bot_id` via `bot_credential.identity`. |
| `matchmaker_config` | admin overrides (currently empty → defaults) |
| `tournament`, `tournament_entry`, `tournament_match` | tournament state, Swiss points, eliminations |
| `bot_stats`, `retired_bot_stats`, `rating_history`, `bot_version` | ratings |
| `team`, `team_member`, `admin`, `human_link` | not game-relevant |

Views:

| View | Contents |
|---|---|
| `my_rack` | **your** `holding` rows (`match_id, letter, count`) across all matches. Filter by `match_id`. Ended matches' tiles stay here too. |
| `open_lobbies`, `open_lobby_members` | the open lobby only |
| `visible_auction_top_bids` | **empty for bots** (spectators only) |
| `my_team`, `my_nonces`, `my_team_invites`, `my_admin` | human-account views; irrelevant to the bot |

Private (not visible to bots): `holding` (others' racks), `bag_letter` (bag
composition), `pending_bid` (live bids), `auction_top_bid`.

Derivable: the remaining bag composition = full bag − your rack − all
`auction_result` letters (including unsold, discarded ones) − letters in opponents'
starting racks. Opponents' starting racks are unknown until they play them. Also derivable:
opponents' racks ≈ won letters − letters used in their `word_play`s (plus 5 unknown starting tiles each).

Events: there are no separate event tables. React to row callbacks such as
`auction.onInsert` (a new auction), `auction_result.onInsert`, `my_rack.onInsert/onUpdate/onDelete`,
`match_state.onUpdate` (status → Ended), and `word_play.onInsert`.

## 11. Reducers

Callable by a bot (the caller's identity must be a `bot_credential`):

| Reducer | Args | Notes / errors |
|---|---|---|
| `join_lobby` | — | idempotent; refused if in a running match or held for a tournament |
| `submit_bid` | `auction_id: u64, amount: i64` | 0 ≤ amount ≤ balance; must be before `closes_at`; replaces your prior bid |
| `submit_word` | `match_id: u64, word: string` | match Running; ≥2 letters, A–Z, in dictionary, letters in rack |
| `register_for_tournament` | `tournament_id: u64` | only during Registration; idempotent |
| `unregister_from_tournament` | `tournament_id: u64` | only during Registration |
| `claim_credential` | `code: string` | redeem a nonce for a fresh identity (setup only) |

Human/team reducers (website account, not the bot): `connect_id`,
`create_team`, `mint_team_invite`, `join_team`, `leave_team`,
`promote_to_owner`, `start_new_bot_version`, `mint_credential_nonce`.

Admin only: `bootstrap_admin`, `add_admin`, `remove_admin`,
`spawn_simulated_bot`, `set_matchmaker_config`, `create_tournament`,
`register_sim_bots`, `cancel_tournament`, `start_tournament`,
`force_end_tournament`, `start_next_finals_match`, `backfill_elo`,
`backfill_top_bid_archive`.

Scheduler only (calling them fails): `auction_tick`, `lobby_timeout_tick`,
`nonce_expiry_tick`, `invite_expiry_tick`.

## 12. Docs vs source disagreements

| Topic | Docs / README say | Source (wins) |
|---|---|---|
| Unsold tiles | "returned to the bag" | **Discarded**; never re-added (confirmed live) |
| Lobby window | 60 seconds | **90 seconds** (confirmed live) |
| Starting rack | not mentioned in bot-guide or README (the site says 5) | 5, dealt privately at match start; admin-tunable 0–20 |
| Vickrey payment with one bidder | "reserve 1" | `min(1, bid)` → pays 1 |
| `my_rack` "your letters" | implies the current match | covers **all** matches incl. ended ones; filter by `match_id` and status |
| "Multiple words?" | implied ("any word at any time") | explicitly unlimited; duplicates allowed; ≥2 letters |
| Bid shape | — | 0 = no bid; re-bids replace; bid must be ≤ balance at submit time |
| Docs connection snippet | `conn.db.myRack.onUpdate` only | holdings are also inserted and deleted (`onInsert`/`onDelete` matter too) |

## 13. Starter-bot gotchas

1. **Windows bug: empty dictionary (FIXED).** `index.ts` built the wordlist path from
   `new URL(import.meta.url).pathname`, which on Windows yields
   `\H:\HackUTD\...\wordlist.txt`. `fs.existsSync` then returned false, so
   `DICTIONARY = []` and **the stock bot never played a word**. It now uses
   `fileURLToPath`; 172,820 words load, and the bot refuses to start if fewer than 100k load.
   Note: this ENABLE list has **no QI or ZA**.
5. **`subscribeToAllTables` is too heavy (FIXED).** It pulls ~1.7M auctions, ~1.7M
   results and ~400k word plays, which took 37 s and a 3.5 GB heap in a test. The bot
   now subscribes to small tables plus rows with `match_id >=` the oldest running match.
2. It bids only once per auction (`bidsByAuction`) and never re-bids.
3. `chooseWord` plays the longest word immediately on every rack change,
   including 2-letter words. It ignores the length multipliers and the fact that the match ends abruptly.
4. The token is saved to `.token-<BOT_NAME>` in the **current working directory**.
   Run `npm start` from `bot-starter/` so it finds `bot-starter/.token-jaeger`.
   The starter logs the identity hex, not the token.

## 14. Security

- Never print, log or commit the bot token. `.token-*` and `.env` are in
  `.gitignore`. `git check-ignore` confirms `bot-starter/.token-jaeger` is ignored.
- Note: the root `.env`, `.env.production` and `.envrc` were committed upstream
  before the ignore rule, so they are **still tracked**. They contain only public web-app
  config (DB host/name and a public OIDC client ID), with no secrets. Never put the bot
  token in them. Use `.token-jaeger` or a session-only `$env:BOT_TOKEN`.
- Run: `cd bot-starter; $env:BOT_NAME="jaeger"; npm start`
