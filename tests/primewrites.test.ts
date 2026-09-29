/**
 * A save during a reload (the desk, 29 Sep: "I delete something and it is not
 * gone until I refresh"). The loader (src/data/prime.ts) reads `state.writes`
 * before and after each fetch and drops rows a save overtook; this checks that
 * every kind of save moves that count, and that a load alone does not.
 */
import { state, bumpPrimed, resetStore } from "@/data/primeState";

let pass = 0, fail = 0;
const eq = (l: string, got: unknown, want: unknown) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  ok ? pass++ : fail++;
  console.log(`${ok ? "  ok  " : "  FAIL"} ${l}${ok ? "" : `  got ${JSON.stringify(got)} want ${JSON.stringify(want)}`}`);
};

const w0 = state.writes;
bumpPrimed();
eq("a store commit counts as a save", state.writes, w0 + 1);
resetStore();
eq("a backend write (resetStore) counts as a save", state.writes, w0 + 2);
eq("and leaves every table due for a fresh read", [state.tablesAt, state.allAt, state.openings.size, state.candidates.size], [0, 0, 0, 0]);
const w1 = state.writes;
state.version++; // what a finished load does
eq("a load finishing is not a save", state.writes, w1);

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
