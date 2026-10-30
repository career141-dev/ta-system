import {
  answersById,
  answersByLabel,
  autoFollowUpPatch,
  awaitingFirstSend,
  followUpOn,
  questionLabels,
  sweepCovers,
} from "../convex/lib/followUpScope";

let pass = 0, fail = 0;
const eq = (l: string, got: unknown, want: unknown) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  ok ? pass++ : fail++;
  console.log(`${ok ? "  ok  " : "  FAIL"} ${l}${ok ? "" : `  got ${JSON.stringify(got)} want ${JSON.stringify(want)}`}`);
};

// ── The switch ──────────────────────────────────────────────────────────────
const on = autoFollowUpPatch(true);
eq("switching on sets both channels and the manual first send", on, {
  agent3Enabled: true, enableWhatsAppFollowUp: true, enableEmailFollowUp: true, followUpStartsOnSend: true,
});
// Off has to clear the channels too. Leaving them true was harmless while a TA
// had to press Send; once shortlisting began sending by itself, an opening the
// TA had switched off still sent the Day 0 template and email (18 September).
eq("switching off clears the channels as well", autoFollowUpPatch(false), {
  agent3Enabled: false, enableWhatsAppFollowUp: false, enableEmailFollowUp: false,
});
eq("on reads as on", followUpOn(on), true);
eq("off reads as off", followUpOn({ ...on, ...autoFollowUpPatch(false) }), false);
eq("enabled with no channel is off", followUpOn({ agent3Enabled: true }), false);
eq("no job is off", followUpOn(null), false);

// ── What the sweep may touch ────────────────────────────────────────────────
const legacy = { agent3Enabled: true, enableWhatsAppFollowUp: true };
eq("a CV pipeline job is swept by the full sweep", sweepCovers(legacy, false), true);
eq("a CV pipeline job is not swept by the TA-only sweep", sweepCovers(legacy, true), false);
eq("a TA opening is swept by the TA-only sweep", sweepCovers(on, true), true);
eq("a switched-off TA opening is swept by neither", sweepCovers({ ...on, agent3Enabled: false }, false), false);

// ── The first message is a TA's ─────────────────────────────────────────────
eq("TA opening, nothing sent: the sweep waits", awaitingFirstSend(on, {}), true);
eq("TA opening, attempt count 0: the sweep waits", awaitingFirstSend(on, { followUpAttemptCount: 0 }), true);
eq("TA opening, first send gone: the sweep runs", awaitingFirstSend(on, { followUpAttemptCount: 1 }), false);
eq("CV pipeline job never waits", awaitingFirstSend(legacy, {}), false);

// ── Questions and answers between the two vocabularies ──────────────────────
const qs = [
  { id: "q1", label: "Valid driving licence?" },
  { id: "q2", label: " Willing to travel? " },
  { id: "q3", label: "  " },
];
eq("labels are trimmed and blanks dropped", questionLabels(qs), ["Valid driving licence?", "Willing to travel?"]);
eq(
  "TA answers become CV pipeline answers by wording",
  answersByLabel(qs, { q1: "Yes", q2: "  ", q9: "stray" }),
  { "Valid driving licence?": "Yes" },
);
eq(
  "a reply's answers become TA answers by id",
  answersById(qs, { "Valid driving licence?": "Yes, B class", "Unrelated": "x" }),
  { q1: "Yes, B class" },
);
eq("nothing to map is empty", answersById([], { a: "b" }), {});

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
