/**
 * The mailbox poller's cursor (convex/lib/mailCursor.ts). Until 5 October a
 * burst of more than 15 applications lost all but 15: the cursor moved past
 * the rest and no later run fetched them. Pure — no Graph, no database.
 */
import { advanceCursor, oldestFirst, POLL_BATCH } from "../convex/lib/mailCursor";

let pass = 0, fail = 0;
const eq = (l: string, got: unknown, want: unknown) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  ok ? pass++ : fail++;
  console.log(`${ok ? "  ok  " : "  FAIL"} ${l}${ok ? "" : `  got ${JSON.stringify(got)} want ${JSON.stringify(want)}`}`);
};

console.log("\nwhen the cursor may move");
eq("everything fetched and handled: it moves", advanceCursor({ fetchedAll: true, found: 3, markReadDisabled: false }), true);
eq("exactly a batch: it moves", advanceCursor({ fetchedAll: true, found: POLL_BATCH, markReadDisabled: false }), true);
eq("a burst of 40: it stays, the other 25 are fetched next run", advanceCursor({ fetchedAll: true, found: 40, markReadDisabled: false }), false);
eq("the mailbox read failed part-way: it stays", advanceCursor({ fetchedAll: false, found: 0, markReadDisabled: false }), false);
eq("staging leaves mail unread, so it moves as before", advanceCursor({ fetchedAll: true, found: 40, markReadDisabled: true }), true);

console.log("\nthe oldest are handled first");
const msgs = [
  { id: "c", receivedDateTime: "2026-10-05T09:30:00Z" },
  { id: "a", receivedDateTime: "2026-10-05T08:00:00Z" },
  { id: "b", receivedDateTime: "2026-10-05T09:00:00Z" },
];
eq("sorted by arrival", oldestFirst(msgs).map((m) => m.id), ["a", "b", "c"]);
eq("the input is left as it was", msgs.map((m) => m.id), ["c", "a", "b"]);

console.log(`\n${pass} passed, ${fail} failed`);
process.exitCode = fail ? 1 : 0;
