// Per-match JSON logs in bot-starter/logs/ (gitignored). One file per
// match plus a one-line summary appended to logs/summary.jsonl.
// Nothing here ever sees the bot token.

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
/** The live bot's log folder. Tests, sims and shadow runs must never write here. */
export const LIVE_LOG_DIR = path.join(ROOT, "logs");
/**
 * Where this process logs: $BOT_LOG_DIR if set; shadow runs default to
 * sim-output/shadow-logs (gitignored); only a real bot run uses logs/.
 */
export const LOG_DIR =
  process.env.BOT_LOG_DIR ??
  (process.env.SHADOW === "1" ? path.join(ROOT, "sim-output", "shadow-logs") : LIVE_LOG_DIR);

export interface BidLog {
  auctionId: string;
  letter: string;
  bagTotal: number;
  balance: number;
  value: number;
  amount: number;
  desired: number;
  source: string;
  futureDraws: number;
  market?: number;
  reason: string;
  lagMs?: number;
}

export interface ResultLog {
  auctionId: string;
  letter: string;
  winner: string | null;
  paid: number;
  mine: boolean;
  myBid: number;
}

export interface WordLog {
  word: string;
  reward: number;
  reason: string;
  bagTotal: number;
  ok?: boolean;
  error?: string;
  latencyMs?: number;
}

export interface FinalLog {
  myBotId: string;
  rank: number;
  players: number;
  score: number;
  balance: number;
  scores: { botId: string; score: number; balance: number }[];
  leftoverTiles: string;
}

export class MatchLogger {
  private readonly startedAt = new Date().toISOString();
  private readonly bids: BidLog[] = [];
  private readonly results: ResultLog[] = [];
  private readonly words: WordLog[] = [];
  private readonly notes: string[] = [];
  private readonly latencies: number[] = [];
  private coinsSpent = 0;
  private coinsEarned = 0;
  private readonly lettersWon: { letter: string; paid: number }[] = [];
  private finished = false;

  constructor(
    readonly botName: string,
    readonly matchId: bigint,
    readonly info: Record<string, unknown>,
  ) {}

  bid(b: BidLog) {
    this.bids.push(b);
  }

  result(r: ResultLog) {
    this.results.push(r);
    if (r.mine) {
      this.coinsSpent += r.paid;
      this.lettersWon.push({ letter: r.letter, paid: r.paid });
    }
  }

  word(w: WordLog) {
    this.words.push(w);
  }

  wordScored(reward: number) {
    this.coinsEarned += reward;
  }

  latency(ms: number) {
    this.latencies.push(Math.round(ms));
  }

  note(msg: string) {
    this.notes.push(`${new Date().toISOString()} ${msg}`);
  }

  finish(final: FinalLog): string | undefined {
    if (this.finished) return undefined;
    this.finished = true;
    const lat = [...this.latencies].sort((a, b) => a - b);
    const pct = (p: number) => (lat.length ? lat[Math.min(lat.length - 1, Math.floor(p * lat.length))] : null);
    const record = {
      bot: this.botName,
      matchId: this.matchId.toString(),
      startedAt: this.startedAt,
      endedAt: new Date().toISOString(),
      ...this.info,
      rank: final.rank,
      players: final.players,
      score: final.score,
      finalBalance: final.balance,
      coinsSpent: this.coinsSpent,
      coinsEarned: this.coinsEarned,
      lettersWon: this.lettersWon,
      leftoverTiles: final.leftoverTiles,
      wordsPlayed: this.words.filter((w) => w.ok).map((w) => ({ word: w.word, reward: w.reward })),
      scores: final.scores,
      latencyMs: { n: lat.length, p50: pct(0.5), p90: pct(0.9), max: lat.at(-1) ?? null },
      bids: this.bids,
      results: this.results,
      words: this.words,
      notes: this.notes,
    };
    try {
      fs.mkdirSync(LOG_DIR, { recursive: true });
      const file = path.join(LOG_DIR, `match-${this.matchId}.json`);
      fs.writeFileSync(file, JSON.stringify(record, null, 2));
      const summary = {
        bot: this.botName,
        matchId: record.matchId,
        endedAt: record.endedAt,
        auctionType: this.info.auctionType,
        tournament: this.info.tournament ?? null,
        rank: final.rank,
        players: final.players,
        score: final.score,
        bestOther: Math.max(0, ...final.scores.filter((s) => s.botId !== final.myBotId).map((s) => s.score)),
        coinsSpent: this.coinsSpent,
        finalBalance: final.balance,
        lettersWon: this.lettersWon.length,
        leftoverTiles: final.leftoverTiles.length,
        latencyP90: pct(0.9),
      };
      fs.appendFileSync(path.join(LOG_DIR, "summary.jsonl"), JSON.stringify(summary) + "\n");
      return file;
    } catch (e) {
      console.warn(`log write failed: ${e instanceof Error ? e.message : e}`);
      return undefined;
    }
  }
}
