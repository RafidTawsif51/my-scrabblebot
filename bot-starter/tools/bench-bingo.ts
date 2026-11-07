// Speed + sanity check for BingoIndex: npx tsx tools/bench-bingo.ts
import { countsOf, Dictionary, letterOf } from "../src/dictionary.js";
import { BingoIndex } from "../src/bingo.js";

const dict = Dictionary.load();
let t = performance.now();
const bi = new BingoIndex(dict);
console.log(`bingo keys ${bi.size}, built in ${Math.round(performance.now() - t)} ms`);
for (const rack of ["", "AEST", "AERST", "AEINRST", "QZXJK", "EEEEII", "RETAINQ", "AEILNRSTU"]) {
  t = performance.now();
  const n = 200;
  let info = bi.leave(countsOf(rack));
  for (let i = 1; i < n; i++) info = bi.leave(countsOf(rack));
  const ms = (performance.now() - t) / n;
  const top = [...info.gain].map((g, i) => [letterOf(i), g] as const).sort((a, b) => b[1] - a[1]).slice(0, 6);
  console.log(
    `${(rack || "(empty)").padEnd(10)} ${ms.toFixed(2)} ms  min missing ${info.minMissing}  playable ${info.playable}  score ${info.score.toFixed(1)}  ` +
      `best adds ${top.map(([l, g]) => `${l}:${g.toFixed(1)}`).join(" ")}  Q:${info.gain[16]!.toFixed(1)}`,
  );
}
