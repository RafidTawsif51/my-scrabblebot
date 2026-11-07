// Performance check for the word search: `npx tsx src/bench.ts`.
import { countsOf, Dictionary, BAG_COUNTS, letterOf } from "./dictionary.js";

const t0 = performance.now();
const dict = Dictionary.load();
console.log(`dictionary: ${dict.size} words, built in ${Math.round(performance.now() - t0)} ms`);

// Random racks drawn from the real bag distribution.
let seed = 12345;
const rand = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
const bag: string[] = [];
BAG_COUNTS.forEach((n, i) => { for (let k = 0; k < n; k++) bag.push(letterOf(i)); });
function rack(n: number): string {
  const b = [...bag];
  let s = "";
  for (let i = 0; i < n; i++) s += b.splice(Math.floor(rand() * b.length), 1)[0];
  return s;
}

for (const n of [5, 8, 10, 12, 15, 18, 22]) {
  const racks = Array.from({ length: 30 }, () => countsOf(rack(n)));
  let t = performance.now();
  let c = 0;
  for (const r of racks) c += dict.candidates(r).length;
  const tc = (performance.now() - t) / racks.length;
  t = performance.now();
  let v = 0;
  for (const r of racks) v += dict.bestValue(r);
  const tv = (performance.now() - t) / racks.length;
  t = performance.now();
  let f = 0;
  for (const r of racks) f += dict.bestPlays(r).total;
  const tf = (performance.now() - t) / racks.length;
  console.log(
    `rack ${n}: ${Math.round(c / racks.length)} cands, candidates ${tc.toFixed(2)} ms, ` +
      `bestValue ${tv.toFixed(2)} ms (avg ${(v / racks.length).toFixed(1)}), ` +
      `bestPlays ${tf.toFixed(2)} ms (avg ${(f / racks.length).toFixed(1)})`,
  );
}
