// ScrabbleBot bot "jaeger" — built on the bot starter (see RULES.md).
//
// First run, with a token from the website:
//   $env:BOT_NAME="<name>"; $env:BOT_TOKEN="<token>"; npm start
// Or with a nonce from the CLI:
//   1. `spacetime call scrabblebot mint_credential_nonce`
//      `spacetime sql 'SELECT code FROM my_nonces ORDER BY expires_at DESC'`
//   2. $env:BOT_NAME="<name>"; $env:BOT_NONCE="<code>"; npm start
// Either way the bot saves its token to .token-<BOT_NAME> (gitignored), so
// later runs need only:   $env:BOT_NAME="jaeger"; npm start
//
// Tournament:  $env:BOT_NAME="jaeger"; $env:TOURNAMENT_ID="<id>"; npm start
//
// Shadow mode (no token, no reducer calls, never writes a token file):
//   $env:SHADOW="1"; npm start
// connects anonymously, follows the newest running match as if it were one
// of its players, and prints the bids it would make. For testing.
//
// The token is never printed or logged.

import {
  DbConnection,
  type EventContext,
  type ErrorContext,
} from "./module_bindings/index.js";
import { Identity } from "spacetimedb";
import * as fs from "node:fs";
import * as path from "node:path";
import { countsKey, Dictionary, emptyCounts, letterIndex, totalOf, wordReward, type Counts } from "./dictionary.js";
import { MatchLogger } from "./logger.js";
import { Player, type PlayerView } from "./player.js";
import type { AuctionKind } from "./strategy.js";

const HOST = process.env.STDB_HOST ?? "https://maincloud.spacetimedb.com";
const DB_NAME = process.env.STDB_DB ?? "scrabblebot";
const BOT_NAME = process.env.BOT_NAME ?? "bot";
const BOT_TOKEN = process.env.BOT_TOKEN; // from the website, first run only
const BOT_NONCE = process.env.BOT_NONCE; // from the CLI, first run only
const TOURNAMENT_ID = process.env.TOURNAMENT_ID;
const SHADOW = process.env.SHADOW === "1";
const TOKEN_PATH = path.join(process.cwd(), `.token-${BOT_NAME}`);
/** A reducer slower than this switches the match to "play everything now". */
const PANIC_LATENCY_MS = 1500;

function loadToken(): string | undefined {
  try {
    return fs.readFileSync(TOKEN_PATH, "utf8").trim() || undefined;
  } catch {
    return undefined;
  }
}
function saveToken(tok: string) {
  if (SHADOW) return; // never overwrite the real token with an anonymous one
  fs.writeFileSync(TOKEN_PATH, tok);
}

const tag = SHADOW ? `${BOT_NAME}/shadow` : BOT_NAME;
const log = (msg: string) => console.log(`[${tag}] ${msg}`);
const warn = (msg: string) => console.warn(`[${tag}] ${msg}`);
const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));

// ---------- Dictionary (fail fast if the wordlist didn't load) ----------

const DICT = Dictionary.load();
if (DICT.size < 100_000) {
  console.error(`[${tag}] dictionary only has ${DICT.size} words; refusing to start`);
  process.exit(1);
}
log(`dictionary: ${DICT.size} words`);

const player = new Player(DICT);

// ---------- Per-connection state ----------

let myIdentity: Identity | null = null;
let myBotId: bigint | null = null;
let currentMatchId: bigint | null = null;
let logger: MatchLogger | null = null;
/** auctionId -> amount we submitted. */
const myBids = new Map<string, number>();
/** Desired bid for the open auction (for re-bidding after a cash-in). */
let openDesired: { auctionId: bigint; desired: number } | null = null;
/** Letters committed to words whose reducer call hasn't settled. */
const reserved = emptyCounts();
let thinkQueued = false;
let pumping = false;
let reconnecting = false;

function resetState() {
  myIdentity = null;
  myBotId = null;
  currentMatchId = null;
  logger = null;
  myBids.clear();
  openDesired = null;
  reserved.fill(0);
  player.endMatch();
}

// ---------- Helpers ----------

function resolveMyBotId(conn: DbConnection): bigint | null {
  if (!myIdentity) return null;
  const cred = conn.db.botCredential.identity.find(myIdentity);
  return cred ? cred.botId : null;
}

function serverRack(conn: DbConnection, matchId: bigint): Counts {
  const rack = emptyCounts();
  for (const h of conn.db.myRack.iter()) {
    if (h.matchId !== matchId) continue;
    const i = letterIndex(h.letter);
    if (i >= 0) rack[i] = Math.min(255, rack[i]! + h.count);
  }
  return rack;
}

/** Rack minus letters already committed to in-flight words. */
function usableRack(conn: DbConnection, matchId: bigint): Counts {
  const r = serverRack(conn, matchId);
  for (let i = 0; i < 26; i++) r[i] = Math.max(0, r[i]! - reserved[i]!);
  return r;
}

function participantsOf(conn: DbConnection, matchId: bigint) {
  return [...conn.db.matchParticipant.iter()].filter((p) => p.matchId === matchId);
}

function myParticipant(conn: DbConnection, matchId: bigint) {
  return participantsOf(conn, matchId).find((p) => p.botId === myBotId);
}

function viewFor(conn: DbConnection, matchId: bigint): PlayerView | null {
  const m = conn.db.matchState.id.find(matchId);
  const me = myParticipant(conn, matchId);
  if (!m || !me) return null;
  return {
    rack: SHADOW ? emptyCounts() : usableRack(conn, matchId),
    balance: Number(me.balance),
    bagTotal: m.bagTotal,
    auctionType: m.auctionType.tag as AuctionKind,
  };
}

function syncParticipants(conn: DbConnection, matchId: bigint) {
  const t = player.tracker;
  if (!t) return;
  for (const p of participantsOf(conn, matchId)) {
    t.setParticipant(p.botId, Number(p.balance), Number(p.score));
  }
}

/** Calls a reducer, measuring latency; slow calls trigger panic mode. */
function timed(what: string, call: () => Promise<void>): Promise<boolean> {
  const t0 = performance.now();
  return call().then(
    () => {
      noteLatency(what, performance.now() - t0);
      return true;
    },
    (e: unknown) => {
      noteLatency(what, performance.now() - t0);
      warn(`${what} failed: ${errMsg(e)}`);
      logger?.note(`${what} failed: ${errMsg(e)}`);
      return false;
    },
  );
}

function noteLatency(what: string, ms: number) {
  logger?.latency(ms);
  if (ms > PANIC_LATENCY_MS && player.tracker && !player.panic) {
    player.panic = true;
    warn(`${what} took ${Math.round(ms)} ms: panic mode, playing all words now`);
    logger?.note(`panic: ${what} took ${Math.round(ms)} ms`);
    queueThink();
  }
}

// ---------- Background valuation ----------

function kickPump() {
  if (pumping) return;
  pumping = true;
  const loop = () => {
    // Short slices so bids and word plays are never delayed long.
    const more = player.pump(performance.now() + 8);
    if (more) setImmediate(loop);
    else pumping = false;
  };
  setImmediate(loop);
}

// ---------- Match lifecycle ----------

function startMatch(conn: DbConnection, matchId: bigint) {
  if (currentMatchId === matchId || myBotId === null) return;
  const m = conn.db.matchState.id.find(matchId);
  if (!m || m.status.tag !== "Running") return;
  const parts = participantsOf(conn, matchId);
  if (!parts.some((p) => p.botId === myBotId)) return;
  player.beginMatch(matchId, myBotId, m.startingRackSize, parts.length);
  currentMatchId = matchId;
  myBids.clear();
  openDesired = null;
  reserved.fill(0);
  const t = player.tracker!;
  // Backfill anything that happened before we started tracking.
  const auctions = [...conn.db.auction.iter()].filter((a) => a.matchId === matchId);
  auctions.sort((a, b) => (a.id < b.id ? -1 : 1));
  for (const a of auctions) t.onAuction(a.id, a.letter);
  const results = [...conn.db.auctionResult.iter()].filter((r) => r.matchId === matchId);
  results.sort((a, b) => (a.auctionId < b.auctionId ? -1 : 1));
  for (const r of results) t.onResult(r.auctionId, r.letter, r.winnerBotId ?? undefined, Number(r.paid));
  for (const w of conn.db.wordPlay.iter()) if (w.matchId === matchId) t.onWord(w.botId, w.word);
  syncParticipants(conn, matchId);
  const rack = SHADOW ? "?" : countsKey(serverRack(conn, matchId));
  const tourn = [...conn.db.tournament.iter()].find(
    (x) => x.status.tag === "Swiss" || x.status.tag === "Bracket" || x.status.tag === "Final",
  );
  logger = new MatchLogger(BOT_NAME, matchId, {
    auctionType: m.auctionType.tag,
    players: parts.length,
    startingRack: rack,
    auctionDurationMs: Number(m.auctionDurationMs),
    tournament: tourn ? tourn.id.toString() : null,
    shadow: SHADOW,
  });
  log(
    `match ${matchId} started: ${parts.length} players, ${m.auctionType.tag}, rack ${rack}, bag ${m.bagTotal}`,
  );
  for (const a of auctions) if (a.status.tag === "Open") scheduleBid(conn, a.id);
  queueThink();
}

function finishMatch(conn: DbConnection, matchId: bigint) {
  if (currentMatchId !== matchId) return;
  const parts = participantsOf(conn, matchId);
  const me = parts.find((p) => p.botId === myBotId);
  const score = me ? Number(me.score) : 0;
  const rank = 1 + parts.filter((p) => Number(p.score) > score).length;
  const leftover = SHADOW ? "" : countsKey(serverRack(conn, matchId));
  const file = logger?.finish({
    myBotId: String(myBotId),
    rank,
    players: parts.length,
    score,
    balance: me ? Number(me.balance) : 0,
    scores: parts
      .map((p) => ({ botId: p.botId.toString(), score: Number(p.score), balance: Number(p.balance) }))
      .sort((a, b) => b.score - a.score),
    leftoverTiles: leftover,
  });
  const top = Math.max(...parts.map((p) => Number(p.score)));
  log(
    `match ${matchId} ended: rank ${rank}/${parts.length}, score ${score} (top ${top}), ` +
      `balance ${me ? me.balance : "?"}, leftover "${leftover}"${file ? `, log ${path.basename(file)}` : ""}`,
  );
  player.endMatch();
  currentMatchId = null;
  logger = null;
  myBids.clear();
  openDesired = null;
  reserved.fill(0);
}

// ---------- Bidding ----------

function scheduleBid(conn: DbConnection, auctionId: bigint) {
  // Run after every callback of this transaction, so the rack, balance and
  // bag count we read are all post-transaction.
  setImmediate(() => {
    try {
      doBid(conn, auctionId);
    } catch (e) {
      warn(`bid error: ${errMsg(e)}`);
    }
  });
}

function doBid(conn: DbConnection, auctionId: bigint, rebid = false) {
  const a = conn.db.auction.id.find(auctionId);
  if (!a || a.status.tag !== "Open" || a.matchId !== currentMatchId) return;
  const key = auctionId.toString();
  if (!rebid && myBids.has(key)) return;
  const v = viewFor(conn, a.matchId);
  if (!v) return;
  syncParticipants(conn, a.matchId);
  player.tracker!.onAuction(a.id, a.letter);
  const out = player.bid(a.letter, v);
  const lagMs = Date.now() - Number(a.opensAt.microsSinceUnixEpoch / 1000n);
  logger?.bid({
    auctionId: key,
    letter: a.letter,
    bagTotal: v.bagTotal,
    balance: v.balance,
    value: Math.round(out.value * 100) / 100,
    amount: out.amount,
    desired: out.desired,
    source: out.source,
    futureDraws: out.futureDraws,
    market: out.market,
    reason: out.reason + (rebid ? " (rebid)" : ""),
    lagMs,
  });
  openDesired = { auctionId, desired: out.desired };
  kickPump();
  const prev = myBids.get(key) ?? 0;
  if (rebid && out.amount <= prev) return;
  if (out.amount <= 0 && !rebid) {
    myBids.set(key, 0);
    return;
  }
  myBids.set(key, out.amount);
  log(
    `${rebid ? "re" : ""}bid ${out.amount} on '${a.letter}' (value ${out.value.toFixed(1)}, ` +
      `bag ${v.bagTotal}, bal ${v.balance}, ${out.source}, lag ${lagMs}ms)`,
  );
  if (SHADOW) return;
  void timed(`bid on '${a.letter}'`, () => conn.reducers.submitBid({ auctionId, amount: BigInt(out.amount) }));
}

/** Balance went up mid-auction (we cashed in a word): bid again if we were short. */
function maybeRebid(conn: DbConnection) {
  if (!openDesired || currentMatchId === null) return;
  const sent = myBids.get(openDesired.auctionId.toString()) ?? 0;
  if (openDesired.desired <= sent) return;
  const me = myParticipant(conn, currentMatchId);
  if (!me || Number(me.balance) <= sent) return;
  doBid(conn, openDesired.auctionId, true);
}

// ---------- Word play ----------

function queueThink() {
  if (thinkQueued) return;
  thinkQueued = true;
  setImmediate(() => {
    thinkQueued = false;
    if (!activeConn) return;
    try {
      think(activeConn);
    } catch (e) {
      warn(`word planning error: ${errMsg(e)}`);
    }
  });
}

function think(conn: DbConnection) {
  if (SHADOW || currentMatchId === null) return;
  const matchId = currentMatchId;
  const m = conn.db.matchState.id.find(matchId);
  if (!m || m.status.tag !== "Running") return;
  const v = viewFor(conn, matchId);
  if (!v || totalOf(v.rack) < 2) return;
  const plan = player.words(v);
  if (plan.words.length === 0) return;
  // Words use disjoint letters of the current rack, so they can all be in
  // flight at once; the reservation stops us re-spending their letters.
  for (const word of plan.words) {
    for (const c of word) reserved[letterIndex(c)]!++;
    const reward = wordReward(word);
    log(`playing '${word}' (+${reward}, ${plan.reason})`);
    const t0 = performance.now();
    void timed(`word '${word}'`, () => conn.reducers.submitWord({ matchId, word })).then((ok) => {
      for (const c of word) reserved[letterIndex(c)] = Math.max(0, reserved[letterIndex(c)]! - 1);
      if (currentMatchId === matchId) {
        logger?.word({
          word,
          reward,
          reason: plan.reason,
          bagTotal: v.bagTotal,
          ok,
          latencyMs: Math.round(performance.now() - t0),
        });
        queueThink();
      }
    });
  }
}

// ---------- Lobby ----------

function joinLobby(conn: DbConnection) {
  if (SHADOW || myBotId === null) return;
  const inRunning = [...conn.db.matchParticipant.iter()].some((p) => {
    if (p.botId !== myBotId) return false;
    return conn.db.matchState.id.find(p.matchId)?.status.tag === "Running";
  });
  if (inRunning) return;
  const open = [...conn.db.openLobbies.iter()][0];
  const alreadyIn =
    open !== undefined &&
    [...conn.db.openLobbyMembers.iter()].some((lm) => lm.lobbyId === open.id && lm.botId === myBotId);
  if (alreadyIn) return;
  log("joining lobby");
  void timed("joining the lobby", () => conn.reducers.joinLobby({}));
}

// ---------- Shadow mode: adopt a player in the newest running match ----------

function shadowAdopt(conn: DbConnection) {
  if (currentMatchId !== null) return;
  const running = [...conn.db.matchState.iter()].filter((m) => m.status.tag === "Running");
  running.sort((a, b) => (a.id > b.id ? -1 : 1));
  const m = running[0];
  if (!m) return;
  const p = participantsOf(conn, m.id)[0];
  if (!p) return;
  myBotId = p.botId;
  startMatch(conn, m.id);
}

// ---------- Connection ----------

let activeConn: DbConnection | null = null;

function onConnect(conn: DbConnection, identity: Identity, token: string) {
  activeConn = conn;
  myIdentity = identity;
  saveToken(token);
  log(`connected as ${identity.toHexString()}`);

  // Stage 1: small tables. (subscribeToAllTables pulls ~3.5 GB of match
  // history; GC pauses on a heap that size would miss 1 s auctions.)
  conn
    .subscriptionBuilder()
    .onApplied(() => {
      log("stage 1 subscription applied");
      if (SHADOW) {
        subscribeMatches(conn);
        return;
      }
      myBotId = resolveMyBotId(conn);
      if (myBotId === null) {
        if (BOT_NONCE) {
          log("claiming credential with nonce…");
          void timed("claiming the credential", () => conn.reducers.claimCredential({ code: BOT_NONCE }));
          setTimeout(() => {
            myBotId = resolveMyBotId(conn);
            if (myBotId === null) {
              console.error(`[${tag}] couldn't claim credential. Bad / expired nonce?`);
              process.exit(1);
            }
            log(`claimed credential for bot '${conn.db.bot.id.find(myBotId)?.name ?? "?"}' (id ${myBotId})`);
            subscribeMatches(conn);
          }, 1000);
          return;
        }
        console.error(`[${tag}] no BotCredential for this token. Set BOT_TOKEN or BOT_NONCE and re-run.`);
        process.exit(1);
      }
      log(`acting as bot '${conn.db.bot.id.find(myBotId)?.name ?? "?"}' (id ${myBotId})`);
      subscribeMatches(conn);
    })
    .onError((_ctx: ErrorContext) => warn("stage 1 subscription error"))
    .subscribe([
      "SELECT * FROM bot_credential",
      "SELECT * FROM bot",
      "SELECT * FROM match_state",
      "SELECT * FROM my_rack",
      "SELECT * FROM open_lobbies",
      "SELECT * FROM open_lobby_members",
      "SELECT * FROM tournament",
    ]);

  conn.db.auction.onInsert((_ctx: EventContext, a) => {
    if (currentMatchId === null) {
      // We may be in a match we haven't started tracking yet.
      const p = participantsOf(conn, a.matchId).find((x) => x.botId === myBotId);
      if (p) startMatch(conn, a.matchId);
    }
    if (a.matchId !== currentMatchId) return;
    player.tracker?.onAuction(a.id, a.letter);
    if (a.status.tag === "Open") scheduleBid(conn, a.id);
  });
  conn.db.auctionResult.onInsert((_ctx, r) => {
    if (r.matchId !== currentMatchId) return;
    const winner = r.winnerBotId ?? undefined;
    player.tracker?.onResult(r.auctionId, r.letter, winner, Number(r.paid));
    const mine = winner !== undefined && winner === myBotId;
    logger?.result({
      auctionId: r.auctionId.toString(),
      letter: r.letter,
      winner: winner === undefined ? null : winner.toString(),
      paid: Number(r.paid),
      mine,
      myBid: myBids.get(r.auctionId.toString()) ?? 0,
    });
    if (mine) log(`won '${r.letter}' for ${r.paid}`);
  });
  conn.db.wordPlay.onInsert((_ctx, w) => {
    if (w.matchId !== currentMatchId) return;
    player.tracker?.onWord(w.botId, w.word);
    if (w.botId === myBotId) logger?.wordScored(Number(w.totalReward));
  });
  const onRack = (matchId: bigint) => {
    if (matchId !== currentMatchId) return;
    queueThink();
    const v = viewFor(conn, matchId);
    if (v) player.reschedule(v);
    kickPump();
  };
  conn.db.myRack.onInsert((_ctx, h) => onRack(h.matchId));
  conn.db.myRack.onUpdate((_ctx, _old, h) => onRack(h.matchId));
  conn.db.myRack.onDelete((_ctx, h) => onRack(h.matchId));
  conn.db.matchParticipant.onInsert((_ctx, p) => {
    if (myBotId !== null && p.botId === myBotId) setImmediate(() => startMatch(conn, p.matchId));
  });
  conn.db.matchParticipant.onUpdate((_ctx, _old, p) => {
    if (p.matchId !== currentMatchId) return;
    player.tracker?.setParticipant(p.botId, Number(p.balance), Number(p.score));
    if (p.botId === myBotId) setImmediate(() => maybeRebid(conn));
  });
  conn.db.matchState.onUpdate((_ctx, old, neu) => {
    if (old.status.tag !== "Ended" && neu.status.tag === "Ended") {
      if (neu.id === currentMatchId) {
        finishMatch(conn, neu.id);
        if (SHADOW) setTimeout(() => shadowAdopt(conn), 2000);
      }
      const wasIn = [...conn.db.matchParticipant.iter()].some(
        (p) => p.matchId === neu.id && p.botId === myBotId,
      );
      if (wasIn) setImmediate(() => joinLobby(conn));
    } else if (neu.id === currentMatchId && neu.bagTotal !== old.bagTotal) {
      queueThink(); // the endgame threshold depends on the bag count
    }
  });
  conn.db.openLobbies.onInsert(() => setImmediate(() => joinLobby(conn)));
}

// Stage 2: only matches that are running now or start later.
function subscribeMatches(conn: DbConnection) {
  let from: bigint | null = null;
  let maxId = 0n;
  for (const m of conn.db.matchState.iter()) {
    if (m.id > maxId) maxId = m.id;
    if (m.status.tag === "Running" && (from === null || m.id < from)) from = m.id;
  }
  const m0 = from ?? maxId + 1n;
  conn
    .subscriptionBuilder()
    .onApplied(() => {
      log(`stage 2 subscription applied (matches >= ${m0})`);
      bootstrapActivity(conn);
    })
    .onError((_ctx: ErrorContext) => warn("stage 2 subscription error"))
    .subscribe([
      `SELECT * FROM match_participant WHERE match_id >= ${m0}`,
      `SELECT * FROM auction WHERE match_id >= ${m0}`,
      `SELECT * FROM auction_result WHERE match_id >= ${m0}`,
      `SELECT * FROM word_play WHERE match_id >= ${m0}`,
    ]);
}

function bootstrapActivity(conn: DbConnection) {
  if (SHADOW) {
    shadowAdopt(conn);
    return;
  }
  if (TOURNAMENT_ID) {
    void timed(`registering for tournament ${TOURNAMENT_ID}`, () =>
      conn.reducers.registerForTournament({ tournamentId: BigInt(TOURNAMENT_ID) }),
    ).then((ok) => ok && log(`registered for tournament ${TOURNAMENT_ID}`));
  }
  // Resume a match already in progress (e.g. after a reconnect).
  for (const p of conn.db.matchParticipant.iter()) {
    if (p.botId === myBotId && conn.db.matchState.id.find(p.matchId)?.status.tag === "Running") {
      startMatch(conn, p.matchId);
    }
  }
  joinLobby(conn);
}

function scheduleReconnect() {
  if (reconnecting) return;
  reconnecting = true;
  activeConn = null;
  setTimeout(() => {
    reconnecting = false;
    resetState();
    main();
  }, 3000);
}

function main() {
  log(`connecting to ${DB_NAME} at ${HOST}`);
  DbConnection.builder()
    .withUri(HOST)
    .withDatabaseName(DB_NAME)
    .withToken(SHADOW ? undefined : (BOT_TOKEN ?? loadToken()))
    .onConnect(onConnect)
    .onConnectError((_ctx: ErrorContext, err: Error) => {
      console.error(`[${tag}] connect error: ${err.message}`);
      scheduleReconnect();
    })
    .onDisconnect(() => {
      warn("disconnected; reconnecting in 3 s");
      scheduleReconnect();
    })
    .build();
}

process.on("unhandledRejection", (e) => warn(`unhandled rejection: ${errMsg(e)}`));
process.on("uncaughtException", (e) => warn(`uncaught exception: ${errMsg(e)}`));

main();
