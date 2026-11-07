// Dumps public match data for analysis. Anonymous connection: no token is
// read or written. Usage:
//   npx tsx tools/fetch-matches.ts <out.json> <botId,botId,...> [maxMatchesPerGroup]
// Selects the last N ended matches containing any of the "focus" bots
// (all but the last id), plus every ended match of the last id (us).

import * as fs from "node:fs";
import { DbConnection } from "../src/module_bindings/index.js";

const out = process.argv[2]!;
const ids = process.argv[3]!.split(",").map((s) => BigInt(s));
const maxN = Number(process.argv[4] ?? 200);
const focus = ids.slice(0, -1);
const me = ids.at(-1)!;

const t0 = Date.now();
const log = (m: string) => console.log(`[${((Date.now() - t0) / 1000).toFixed(1)}s] ${m}`);

DbConnection.builder()
  .withUri("https://maincloud.spacetimedb.com")
  .withDatabaseName("scrabblebot")
  .onConnect((conn) => {
    log("connected (anonymous)");
    conn
      .subscriptionBuilder()
      .onApplied(() => {
        const ended = new Set<bigint>();
        for (const m of conn.db.matchState.iter()) if (m.status.tag === "Ended") ended.add(m.id);
        const focusMatches = new Set<bigint>();
        const myMatches = new Set<bigint>();
        for (const p of conn.db.matchParticipant.iter()) {
          if (!ended.has(p.matchId)) continue;
          if (focus.includes(p.botId)) focusMatches.add(p.matchId);
          if (p.botId === me) myMatches.add(p.matchId);
        }
        const chosenFocus = [...focusMatches].sort((a, b) => (a > b ? -1 : 1)).slice(0, maxN);
        const chosen = new Set([...chosenFocus, ...myMatches]);
        const minId = [...chosen].reduce((a, b) => (b < a ? b : a), 1n << 62n);
        log(`focus matches ${focusMatches.size} (using ${chosenFocus.length}), mine ${myMatches.size}, min id ${minId}`);
        const list = [...chosen].map(String).join(",");
        void list;
        conn
          .subscriptionBuilder()
          .onApplied(() => {
            log("stage 2 applied");
            const data: Record<string, unknown>[] = [];
            const by = <T extends { matchId: bigint }>(rows: Iterable<T>) => {
              const m = new Map<bigint, T[]>();
              for (const r of rows) {
                if (!chosen.has(r.matchId)) continue;
                let a = m.get(r.matchId);
                if (!a) m.set(r.matchId, (a = []));
                a.push(r);
              }
              return m;
            };
            const parts = by(conn.db.matchParticipant.iter());
            const results = by(conn.db.auctionResult.iter());
            const words = by(conn.db.wordPlay.iter());
            const tops = by(conn.db.auctionTopBidArchive.iter());
            for (const id of chosen) {
              const m = conn.db.matchState.id.find(id)!;
              const top = new Map((tops.get(id) ?? []).map((t) => [t.auctionId, Number(t.topBid)]));
              data.push({
                matchId: Number(id),
                auctionType: m.auctionType.tag,
                startedAt: Number((m.startedAt?.microsSinceUnixEpoch ?? 0n) / 1000n),
                endedAt: Number((m.endedAt?.microsSinceUnixEpoch ?? 0n) / 1000n),
                startingRackSize: m.startingRackSize,
                players: (parts.get(id) ?? []).map((p) => ({
                  botId: Number(p.botId),
                  score: Number(p.score),
                  balance: Number(p.balance),
                })),
                results: (results.get(id) ?? [])
                  .sort((a, b) => (a.auctionId < b.auctionId ? -1 : 1))
                  .map((r) => ({
                    auctionId: Number(r.auctionId),
                    letter: r.letter,
                    winner: r.winnerBotId === undefined ? null : Number(r.winnerBotId),
                    paid: Number(r.paid),
                    topBid: top.get(r.auctionId) ?? null,
                    closedAt: Number(r.closedAt.microsSinceUnixEpoch / 1000n),
                  })),
                words: (words.get(id) ?? []).map((w) => ({
                  botId: Number(w.botId),
                  word: w.word,
                  reward: Number(w.totalReward),
                  playedAt: Number(w.playedAt.microsSinceUnixEpoch / 1000n),
                })),
              });
            }
            fs.writeFileSync(out, JSON.stringify({ focus: focus.map(Number), me: Number(me), matches: data }));
            log(`wrote ${data.length} matches to ${out}`);
            process.exit(0);
          })
          .onError(() => {
            console.error("stage 2 subscription error");
            process.exit(1);
          })
          .subscribe([
            `SELECT * FROM match_participant WHERE match_id >= ${minId}`,
            `SELECT * FROM auction_result WHERE match_id >= ${minId}`,
            `SELECT * FROM word_play WHERE match_id >= ${minId}`,
            `SELECT * FROM auction_top_bid_archive WHERE match_id >= ${minId}`,
          ]);
      })
      .onError(() => {
        console.error("stage 1 subscription error");
        process.exit(1);
      })
      .subscribe([
        "SELECT * FROM match_state",
        ...ids.map((id) => `SELECT * FROM match_participant WHERE bot_id = ${id}`),
      ]);
  })
  .onConnectError((_c, e) => {
    console.error(`connect error: ${e.message}`);
    process.exit(1);
  })
  .build();
setTimeout(() => {
  console.error("timeout");
  process.exit(2);
}, 300_000);
