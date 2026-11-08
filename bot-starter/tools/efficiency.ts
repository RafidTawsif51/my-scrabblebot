// Coin efficiency per bot and per letter, from a fetch-matches.ts dump.
//   npx tsx tools/efficiency.ts <matches.json> [perBot=150] [modes=lucent2,lucent3] [--ceilings out.json]
//
// Each tile a bot wins is attributed to the first later word it plays that
// uses that letter (won tiles before starting tiles); the tile is credited
// reward / word length. Tiles never played score 0. Jaeger's matches are
// limited to the given modes using logs/summary.jsonl (read-only).

import * as fs from "node:fs";
import * as path from "node:path";
import { LIVE_LOG_DIR } from "../src/logger.js";

interface R { auctionId: number; letter: string; winner: number | null; paid: number; closedAt: number }
interface W { botId: number; word: string; reward: number; playedAt: number }
interface M { matchId: number; players: { botId: number; score: number; balance: number }[]; results: R[]; words: W[] }

const dump = JSON.parse(fs.readFileSync(process.argv[2]!, "utf8")) as { matches: M[] };
const perBot = Number(process.argv[3] ?? 150);
const modes = new Set((process.argv[4] ?? "lucent2,lucent3").split(","));
const ceilOut = process.argv.includes("--ceilings") ? process.argv[process.argv.indexOf("--ceilings") + 1] : undefined;
const TOP: Record<number, string> = { 18: "LUCENT", 114: "Bron", 201: "Lbender", 207: "LexForge-1107", 224: "LexForge-Base-v1", 193: "RackMaw", 192: "aipom", 138: "Waupus" };
const JAEGER = 167;

// Jaeger match ids by mode (read-only).
const modeOf = new Map<string, string>();
try {
  for (const l of fs.readFileSync(path.join(LIVE_LOG_DIR, "summary.jsonl"), "utf8").split("\n")) {
    if (!l.trim()) continue;
    const r = JSON.parse(l);
    if (r.bot === "jaeger" && r.mode) modeOf.set(String(r.matchId), r.mode);
  }
} catch {
  /* no logs: Jaeger rows will be empty */
}

type Tile = { letter: string; paid: number; points: number };
interface Stat { name: string; matches: number; score: number; spent: number; tiles: Tile[] }

function analyse(botId: number, name: string, filter: (m: M) => boolean): Stat {
  const ms = dump.matches
    .filter((m) => m.players.some((p) => p.botId === botId) && filter(m))
    .sort((a, b) => b.matchId - a.matchId)
    .slice(0, perBot);
  const s: Stat = { name, matches: ms.length, score: 0, spent: 0, tiles: [] };
  for (const m of ms) {
    s.score += m.players.find((p) => p.botId === botId)!.score;
    const evs = [
      ...m.results.filter((r) => r.winner === botId).map((r) => ({ t: r.closedAt, win: r, word: null as W | null })),
      ...m.words.filter((w) => w.botId === botId).map((w) => ({ t: w.playedAt, win: null as R | null, word: w })),
    ].sort((a, b) => a.t - b.t || (a.win ? -1 : 1));
    const held = new Map<string, Tile[]>();
    const all: Tile[] = [];
    for (const e of evs) {
      if (e.win) {
        const tile = { letter: e.win.letter, paid: e.win.paid, points: 0 };
        s.spent += e.win.paid;
        all.push(tile);
        if (!held.has(tile.letter)) held.set(tile.letter, []);
        held.get(tile.letter)!.push(tile);
      } else if (e.word) {
        const per = e.word.reward / e.word.word.length;
        for (const c of e.word.word) {
          const q = held.get(c);
          if (q && q.length) q.shift()!.points = per; // else a starting tile
        }
      }
    }
    s.tiles.push(...all);
  }
  return s;
}

const stats: Stat[] = Object.entries(TOP).map(([id, n]) => analyse(Number(id), n, () => true));
const jae = analyse(JAEGER, `Jaeger (${[...modes].join("+")})`, (m) => modes.has(modeOf.get(String(m.matchId)) ?? ""));

const f = (x: number, d = 2) => (Number.isFinite(x) ? x.toFixed(d) : "-");
const ppcTiles = (ts: Tile[]) => ts.reduce((a, t) => a + t.points, 0) / Math.max(1, ts.reduce((a, t) => a + t.paid, 0));
console.log("bot                 matches  score/match  coins spent/match  points/coin  tile points/coin  tiles/match  % tiles scored");
for (const s of [...stats, jae]) {
  console.log(
    `${s.name.padEnd(20)} ${String(s.matches).padStart(6)}  ${f(s.score / s.matches, 1).padStart(11)}  ${f(s.spent / s.matches, 1).padStart(17)}  ` +
      `${f(s.score / Math.max(1, s.spent)).padStart(11)}  ${f(ppcTiles(s.tiles)).padStart(16)}  ${f(s.tiles.length / s.matches, 1).padStart(11)}  ` +
      `${f((100 * s.tiles.filter((t) => t.points > 0).length) / Math.max(1, s.tiles.length), 0).padStart(13)}%`,
  );
}

// Per letter: top-bot pool vs Jaeger.
const topTiles = stats.flatMap((s) => s.tiles);
const topMatches = stats.reduce((a, s) => a + s.matches, 0);
const pct = (xs: number[], p: number) => { const s = [...xs].sort((a, b) => a - b); return s.length ? s[Math.min(s.length - 1, Math.floor(p * s.length))]! : NaN; };
console.log("\nletter | top: price  scored%  pts/coin  buys/match | Jaeger: price  scored%  pts/coin  buys/match | p75 price of top bots' scoring buys");
const ceilings: Record<string, number> = {};
const rows: { L: string; jp: number; tp: number; jppc: number; tppc: number; jsc: number; tsc: number; n: number }[] = [];
for (let i = 0; i < 26; i++) {
  const L = String.fromCharCode(65 + i);
  const t = topTiles.filter((x) => x.letter === L);
  const j = jae.tiles.filter((x) => x.letter === L);
  const avg = (xs: Tile[]) => xs.reduce((a, x) => a + x.paid, 0) / Math.max(1, xs.length);
  const sc = (xs: Tile[]) => (100 * xs.filter((x) => x.points > 0).length) / Math.max(1, xs.length);
  const ceil = pct(t.filter((x) => x.points > 0).map((x) => x.paid), 0.75);
  if (Number.isFinite(ceil)) ceilings[L] = ceil;
  rows.push({ L, jp: avg(j), tp: avg(t), jppc: ppcTiles(j), tppc: ppcTiles(t), jsc: sc(j), tsc: sc(t), n: j.length });
  console.log(
    `  ${L}    | ${f(avg(t), 1).padStart(10)}  ${f(sc(t), 0).padStart(6)}%  ${f(ppcTiles(t)).padStart(8)}  ${f(t.length / topMatches).padStart(10)} | ` +
      `${f(avg(j), 1).padStart(12)}  ${f(sc(j), 0).padStart(6)}%  ${f(ppcTiles(j)).padStart(8)}  ${f(j.length / Math.max(1, jae.matches)).padStart(10)} | ${ceil}`,
  );
}
const worst = rows.filter((r) => r.n >= 8).sort((a, b) => a.jppc / a.tppc - b.jppc / b.tppc).slice(0, 6);
console.log("\nJaeger's least efficient letters (pts/coin vs top, n>=8): " + worst.map((r) => `${r.L} ${f(r.jppc)} vs ${f(r.tppc)} (price ${f(r.jp, 1)} vs ${f(r.tp, 1)}, scored ${f(r.jsc, 0)}% vs ${f(r.tsc, 0)}%)`).join("; "));
const skips = rows.filter((r) => r.tppc > 0).sort((a, b) => a.tppc - b.tppc).slice(0, 5);
console.log("Letters top bots buy least efficiently / cheapest: " + skips.map((r) => `${r.L} (top pts/coin ${f(r.tppc)}, price ${f(r.tp, 1)})`).join("; "));
if (ceilOut) {
  fs.writeFileSync(ceilOut, JSON.stringify(ceilings, null, 2));
  console.log(`wrote per-letter ceilings to ${ceilOut}`);
}
