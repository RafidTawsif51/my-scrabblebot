// Word conversion: Jaeger (one mode, from logs/ — read-only) vs a public bot.
//   npx tsx tools/conversion.ts <matches.json> <botId> [mode]
import * as fs from "node:fs";
import * as path from "node:path";
import { LIVE_LOG_DIR } from "../src/logger.js";

const dump = JSON.parse(fs.readFileSync(process.argv[2]!, "utf8"));
const bot = Number(process.argv[3]);
const mode = process.argv[4] ?? "lucent";
const avg = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN);
const f = (x: number) => (Number.isNaN(x) ? "-" : x.toFixed(1));

type Word = { word: string; reward: number; endgame: boolean };
type MatchStat = { tiles: number; words: Word[]; leftover: number; score: number };

function report(name: string, ms: MatchStat[]) {
  const ws = ms.flatMap((m) => m.words);
  const lens = new Map<string, number>();
  for (const w of ws) {
    const k = w.word.length >= 8 ? "8+" : String(w.word.length);
    lens.set(k, (lens.get(k) ?? 0) + 1);
  }
  const dist = ["2", "3", "4", "5", "6", "7", "8+"].map((k) => `${k}:${(((lens.get(k) ?? 0) * 100) / ws.length).toFixed(0)}%`).join(" ");
  const eg = ws.filter((w) => w.endgame);
  const used5 = avg(ms.map((m) => m.words.filter((w) => w.word.length >= 5).reduce((t, w) => t + w.word.length, 0)));
  const tiles = avg(ms.map((m) => m.tiles));
  const pointsBy = (pred: (w: Word) => boolean) => avg(ms.map((m) => m.words.filter(pred).reduce((t, w) => t + w.reward, 0)));
  console.log(
    `${name.padEnd(16)} matches ${ms.length}  score ${f(avg(ms.map((m) => m.score)))}  tiles held ${f(tiles)}  words/match ${f(ws.length / ms.length)}  pts/word ${f(avg(ws.map((w) => w.reward)))}\n` +
      `                 lengths ${dist}\n` +
      `                 points/match from 7+ ${f(pointsBy((w) => w.word.length >= 7))}, 5-6 ${f(pointsBy((w) => w.word.length >= 5 && w.word.length < 7))}, 2-4 ${f(pointsBy((w) => w.word.length < 5))}\n` +
      `                 endgame dump: ${f(eg.length / ms.length)} words/match, ${f(pointsBy((w) => w.endgame))} pts/match (${f(avg(eg.map((w) => w.reward)))} per word)\n` +
      `                 tiles used in 5+ words ${f(used5)} of ${f(tiles)} (${f((100 * used5) / tiles)}%); never in a 5+ word ${f(tiles - used5)}; unplayed at end ${f(avg(ms.map((m) => m.leftover)))}`,
  );
}

// Jaeger in the given mode, from its own logs (endgame = reason says so).
const mine: MatchStat[] = [];
for (const file of fs.readdirSync(LIVE_LOG_DIR).filter((x) => /^match-\d+\.json$/.test(x))) {
  const m = JSON.parse(fs.readFileSync(path.join(LIVE_LOG_DIR, file), "utf8"));
  if (m.mode !== mode || m.shadow || m.matchId === "45450") continue;
  const words: Word[] = (m.words as { word: string; reward: number; ok?: boolean; reason: string }[])
    .filter((w) => w.ok)
    .map((w) => ({ word: w.word, reward: w.reward, endgame: w.reason.startsWith("endgame") || w.reason.startsWith("panic") }));
  const start = String(m.startingRack ?? "").length || 5;
  mine.push({ tiles: start + m.lettersWon.length, words, leftover: String(m.leftoverTiles ?? "").length, score: m.score });
}
report(`Jaeger/${mode}`, mine);

// Public bot: endgame = played after the last 4 auctions began.
const theirs: MatchStat[] = [];
for (const m of dump.matches) {
  const me = m.players.find((p: { botId: number }) => p.botId === bot);
  if (!me) continue;
  const closes = (m.results as { closedAt: number }[]).map((r) => r.closedAt).sort((a, b) => a - b);
  const egStart = closes[closes.length - 5] ?? Infinity;
  const won = m.results.filter((r: { winner: number | null }) => r.winner === bot).length;
  const words: Word[] = m.words
    .filter((w: { botId: number }) => w.botId === bot)
    .map((w: { word: string; reward: number; playedAt: number }) => ({ word: w.word, reward: w.reward, endgame: w.playedAt >= egStart }));
  const used = words.reduce((t, w) => t + w.word.length, 0);
  theirs.push({ tiles: 5 + won, words, leftover: Math.max(0, 5 + won - used), score: me.score });
}
report(`bot ${bot}`, theirs);
