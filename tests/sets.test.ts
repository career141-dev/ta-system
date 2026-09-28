/**
 * The set rule on its own (convex/lib/sets.ts, the desk 28 Sep): a set stays
 * open across days until five or more are sent in one Colombo day.
 */
import { nextSetFor, setClosed, colomboDay } from "../convex/lib/sets";

let pass = 0, fail = 0;
const eq = (l: string, got: unknown, want: unknown) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  ok ? pass++ : fail++;
  console.log(`${ok ? "  ok  " : "  FAIL"} ${l}${ok ? "" : `  got ${JSON.stringify(got)} want ${JSON.stringify(want)}`}`);
};
const DAY = 86_400_000;
const HOUR = 3_600_000;
// 28 Sep 2026, 15:00 Colombo.
const now = Date.UTC(2026, 8, 28, 9, 30);
const rows = (set: number, n: number, at: number) => Array.from({ length: n }, () => ({ setNumber: set, shortlistedAt: at }));

console.log("\nnextSetFor");
eq("nothing yet: set 1", nextSetFor([], now), 1);
eq("four yesterday: still set 1", nextSetFor(rows(1, 4, now - DAY), now), 1);
eq("four, then three: still set 1", nextSetFor([...rows(1, 4, now - 2 * DAY), ...rows(1, 3, now - DAY)], now), 1);
eq("five yesterday: set 2", nextSetFor(rows(1, 5, now - DAY), now), 2);
eq("twelve today: still set 1 today", nextSetFor(rows(1, 12, now), now), 1);
eq("twelve yesterday: set 2, not set 3", nextSetFor(rows(1, 12, now - DAY), now), 2);
eq("an earlier full set does not close the open one", nextSetFor([...rows(1, 5, now - 3 * DAY), ...rows(2, 2, now - DAY)], now), 2);
eq("unnumbered rows are ignored", nextSetFor([{ setNumber: null, shortlistedAt: now - DAY }], now), 1);

console.log("\nColombo days, not UTC");
// 00:30 Colombo on 28 Sep is 19:00 UTC on 27 Sep.
const justAfterMidnight = Date.UTC(2026, 8, 27, 19, 0);
eq("00:30 Colombo belongs to that Colombo day", colomboDay(justAfterMidnight), Date.UTC(2026, 8, 27, 18, 30));
eq("five sent after Colombo midnight count as today", nextSetFor(rows(1, 5, justAfterMidnight), now), 1);
eq("five sent before Colombo midnight count as yesterday", nextSetFor(rows(1, 5, justAfterMidnight - HOUR), now), 2);
eq(
  "three either side of Colombo midnight are two days, not one",
  nextSetFor([...rows(1, 3, justAfterMidnight), ...rows(1, 3, justAfterMidnight - HOUR)], now + DAY),
  1,
);

console.log("\nsetClosed");
eq("not the newest: closed", setClosed(1, 2, rows(1, 2, now)), true);
eq("five today: closed", setClosed(1, 1, rows(1, 5, now)), true);
eq("seven over two days: open", setClosed(1, 1, [...rows(1, 4, now - DAY), ...rows(1, 3, now)]), false);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
