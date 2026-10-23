/**
 * The mailbox poller's cursor (convex/lib/mailCursor.ts). Until 5 October a
 * burst of more than 15 applications lost all but 15: the cursor moved past
 * the rest and no later run fetched them. Pure — no Graph, no database.
 */
import { cleanMessage, nextCursor, notYetHandled, oldestFirst, pollBatch, POLL_BATCH, readsByLog, stalledUnreported, wellFormed } from "../convex/lib/mailCursor";

let pass = 0, fail = 0;
const eq = (l: string, got: unknown, want: unknown) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  ok ? pass++ : fail++;
  console.log(`${ok ? "  ok  " : "  FAIL"} ${l}${ok ? "" : `  got ${JSON.stringify(got)} want ${JSON.stringify(want)}`}`);
};

console.log("\nwhere the cursor goes");
const start = "2026-10-23T09:00:00Z";
eq("nothing waiting: to the run's start", nextCursor({ fetchedAll: true, waiting: [], runStart: start, markReadDisabled: false }), start);
eq(
  "some waiting: to the oldest of them, so nothing is skipped",
  nextCursor({ fetchedAll: true, waiting: [{ receivedDateTime: "2026-10-06T10:00:00Z" }, { receivedDateTime: "2026-10-05T16:00:00Z" }], runStart: start, markReadDisabled: false }),
  "2026-10-05T16:00:00Z",
);
eq("the mailbox could not be listed in full: left where it is", nextCursor({ fetchedAll: false, waiting: [], runStart: start, markReadDisabled: false }), null);
eq("staging leaves mail unread, so it moves to the start as before", nextCursor({ fetchedAll: true, waiting: [{ receivedDateTime: "2026-10-05T16:00:00Z" }], runStart: start, markReadDisabled: true }), start);

console.log("\na backlog of 10,000 is worked through, not held at its start (23 Oct)");
{
  // linkedin@ from 5 to 23 October: each run lists the backlog, handles the
  // oldest batch, and the next run starts where the waiting ones begin.
  const backlog = Array.from({ length: 10_000 }, (_, i) => ({ id: `m${i}`, receivedDateTime: new Date(Date.parse("2026-10-05T16:00:00Z") + i * 60_000).toISOString() }));
  const size = pollBatch(true);
  const waiting = backlog.slice(size);
  const cursor = nextCursor({ fetchedAll: true, waiting, runStart: start, markReadDisabled: false })!;
  eq("the shared mailboxes take 40 a run", size, 40);
  eq("the next run starts at the 41st message", cursor, backlog[40].receivedDateTime);
  eq("…so it lists fewer each run", backlog.filter((m) => m.receivedDateTime >= cursor).length, 9_960);
  eq("job@ keeps 15 a run", pollBatch(false), POLL_BATCH);
}

console.log("\nthe desk is told once when a mailbox stops being read");
const now = Date.parse("2026-10-23T09:00:00Z");
eq("read 10 minutes ago: fine", stalledUnreported({ okAt: "2026-10-23T08:50:00Z", now }), false);
eq("not read for 2 hours: tell them", stalledUnreported({ okAt: "2026-10-23T07:00:00Z", now }), true);
eq("already told about this stall: not again", stalledUnreported({ okAt: "2026-10-23T07:00:00Z", reportedAt: "2026-10-23T08:05:00Z", now }), false);
eq("recovered, then stalled again: tell them again", stalledUnreported({ okAt: "2026-10-23T07:30:00Z", reportedAt: "2026-10-22T10:00:00Z", now }), true);
eq("never read by this deployment (staging): nothing to say", stalledUnreported({ okAt: null, now }), false);

console.log("\nthe oldest are handled first");
const msgs = [
  { id: "c", receivedDateTime: "2026-10-05T09:30:00Z" },
  { id: "a", receivedDateTime: "2026-10-05T08:00:00Z" },
  { id: "b", receivedDateTime: "2026-10-05T09:00:00Z" },
];
eq("sorted by arrival", oldestFirst(msgs).map((m) => m.id), ["a", "b", "c"]);
eq("the input is left as it was", msgs.map((m) => m.id), ["c", "a", "b"]);

console.log("\nthe application mailboxes are read by the log, not the read flag");
eq("linkedin@ by the log", readsByLog("LinkedIn@Career141.com"), true);
eq("cv@ by the log", readsByLog("cv@career141.com"), true);
eq("job@ keeps the read flag — its mail is replies", readsByLog("job@career141.com"), false);
eq("the configured LinkedIn inbox too", readsByLog("apply@career141.com", "apply@career141.com"), true);

const since = "2026-10-06T00:00:00Z";
const box = [
  { id: "opened-today", isRead: true, receivedDateTime: "2026-10-06T08:00:00Z" },
  { id: "unread-today", isRead: false, receivedDateTime: "2026-10-06T08:05:00Z" },
  { id: "handled-before", isRead: true, receivedDateTime: "2026-10-05T23:50:00Z" },
  { id: "left-unread-before", isRead: false, receivedDateTime: "2026-10-05T23:55:00Z" },
  { id: "logged", isRead: true, receivedDateTime: "2026-10-06T07:00:00Z" },
];
eq(
  "an email opened in Outlook is still handled; logged and old handled mail is not",
  notYetHandled(box, new Set(["logged"]), since).map((m) => m.id),
  ["opened-today", "unread-today", "left-unread-before"],
);

console.log("\nhalf an emoji is cleaned, so one email cannot stop the run (23 Oct)");
const half = "Nimal \uD83D"; // LinkedIn cut the name short mid-emoji
eq("a lone half is replaced", wellFormed(half), "Nimal �");
eq("a whole emoji is kept", wellFormed("Nimal 😀"), "Nimal 😀");
eq("a stray second half is replaced too", wellFormed("\uDE00x"), "�x");
eq("ordinary text is untouched", wellFormed("Brand Manager – Colombo"), "Brand Manager – Colombo");
const msg = cleanMessage({
  subject: "New application: " + half,
  body: { content: "<p>" + half + "</p>" },
  from: { emailAddress: { address: "jobs-noreply@linkedin.com", name: half } },
});
const lone = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
eq("subject, body and sender name are all cleaned", [msg.subject, msg.body?.content, msg.from?.emailAddress?.name].some((t) => lone.test(t ?? "")), false);

console.log(`\n${pass} passed, ${fail} failed`);
process.exitCode = fail ? 1 : 0;
