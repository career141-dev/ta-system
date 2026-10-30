/**
 * The follow-up sweep and the stage moves around it (2 Oct).
 *
 *   - The sweep carries on from where its last run stopped, so rows it passes
 *     over can no longer hold every place for ever (convex/lib/cronCursor.ts).
 *   - "Complete" in the sweep is Director Review's own rule (ta/stages.ts).
 *   - The state machine asks for Director Review's details on a move that
 *     skips past it, and only the desk-wide roles can undo a placement.
 */
import fs from "node:fs";
import path from "node:path";
import { readWindow, parseWindowCursor, nextCreationCursor, type WindowCursor } from "../convex/lib/cronCursor";
import { directorReviewBlockers, followUpBlockers, needsReviewDetails } from "../convex/ta/stages";

const { mapUser } = await import("@/data/convex/map");
const { isDeskWide } = await import("@/lib/auth");

let pass = 0, fail = 0;
const eq = (l: string, got: unknown, want: unknown) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  ok ? pass++ : fail++;
  console.log(`${ok ? "  ok  " : "  FAIL"} ${l}${ok ? "" : `  got ${JSON.stringify(got)} want ${JSON.stringify(want)}`}`);
};
const read = (p: string) => fs.readFileSync(path.join(process.cwd(), p), "utf8");

// ── The sweep reaches everybody ─────────────────────────────────────────────
console.log("\nthe sweep carries on where it stopped");
type Row = { id: string; _creationTime: number };
const lists: Record<string, Row[]> = {
  "A|follow_up": Array.from({ length: 25 }, (_, i) => ({ id: `A${i}`, _creationTime: 100 + i })),
  "A|ta_shortlist": [],
  "B|follow_up": Array.from({ length: 5 }, (_, i) => ({ id: `B${i}`, _creationTime: 10 + i })),
};
const keys = Object.keys(lists);
const reader = async (key: string, after: number, n: number) =>
  lists[key].filter((r) => r._creationTime > after).slice(0, n);

const seen = new Set<string>();
let cursor: WindowCursor | null = null;
const runs: string[][] = [];
for (let run = 0; run < 4; run++) {
  const w = await readWindow(keys, cursor, 10, reader);
  runs.push(w.rows.map((r) => r.id));
  w.rows.forEach((r) => seen.add(r.id));
  // Through storage, as the cron keeps it.
  cursor = parseWindowCursor(w.cursor ? JSON.stringify(w.cursor) : null);
}
eq("first run: the oldest ten of the first opening", runs[0], lists["A|follow_up"].slice(0, 10).map((r) => r.id));
eq("second run carries on, not the same ten again", runs[1], lists["A|follow_up"].slice(10, 20).map((r) => r.id));
eq("third run finishes A and reaches the next opening", runs[2], [...lists["A|follow_up"].slice(20).map((r) => r.id), ...lists["B|follow_up"].map((r) => r.id)]);
eq("every row reached within three runs", seen.size, 30);
eq("fourth run goes round from the top rather than reading nothing", runs[3], lists["A|follow_up"].slice(0, 10).map((r) => r.id));

const gone = await readWindow(keys, { key: "Z|follow_up", after: 5 }, 3, reader);
eq("a cursor on an opening that has gone starts from the first", gone.rows.map((r) => r.id), ["A0", "A1", "A2"]);
eq("a broken stored cursor reads as none", parseWindowCursor("{not json"), null);
eq("a short read means the end: back to the oldest next time", nextCreationCursor([{ _creationTime: 5 }], 10), null);
eq("a full read keeps the place", nextCreationCursor([{ _creationTime: 5 }, { _creationTime: 9 }], 2), "9");

const cron = read("convex/crons.ts");
eq("the sweep reads through the window, not take(10) per stage", /PER_JOB_STAGE|\.take\(PER_JOB_STAGE\)/.test(cron), false);
eq("flagged rows are left out of the read itself", cron.includes('q.neq(q.field("flaggedForTaReview"), true)'), true);
eq("the SLA check carries on too", cron.includes('readCursor(ctx, "slaBreaches")'), true);

// ── One rule for complete ───────────────────────────────────────────────────
console.log("\ncomplete means what Director Review accepts");
const flags = {};
eq("no current salary still counts as complete",
  directorReviewBlockers(flags, { cvUploadId: "cv1", expectedSalary: 250000, noticePeriodDays: 30 }), []);
eq("'Negotiable' and 'One month' count as answers",
  directorReviewBlockers(flags, { cvUploadId: "cv1", taExpectedSalaryText: "Negotiable", noticePeriod: "One month" }), []);
eq("missing details are named",
  directorReviewBlockers(flags, { expectedSalary: 1 }), ["a CV", "notice period"]);
eq("the sweep uses that rule rather than its own", cron.includes("directorReviewBlockers(app, candidate)"), true);
eq("the sweep no longer patches a stage itself", /currentStage:\s*"/.test(cron), false);

// Every place that decides "complete" uses one rule, and current salary is not
// part of it (owner, 29 Oct).
const done = { cvUploadId: "cv1", expectedSalary: 250000, noticePeriodDays: 30 };
const job = { customFollowUpQuestions: ["Do you have a licence?"] };
eq("follow-up: no current salary is complete", followUpBlockers({}, done, null), []);
eq("follow-up: an unanswered job question blocks", followUpBlockers({}, done, job), ["Do you have a licence?"]);
eq("follow-up: an answered job question does not",
  followUpBlockers({ customFollowUpAnswers: { "Do you have a licence?": "Yes" } }, done, job), []);
const helper = read("convex/pipeline/followUpHelper.ts");
for (const [name, src] of [
  ["the sweep", cron],
  ["the stage helper", helper],
  ["the reply bot", read("convex/communications/inboundExtraction.ts")],
  ["a TA's logged call", read("convex/applications/applications.ts")],
] as const) eq(`${name} uses followUpBlockers`, src.includes("followUpBlockers("), true);
eq("the stage helper moves through the state machine", helper.includes("executeStageTransition(ctx"), true);
eq("the stage helper no longer patches a stage itself", /currentStage:\s*"second_shortlist"/.test(helper), false);
eq("nor logs an email as sent that nothing sends", /deliveryStatus:\s*"sent"/.test(cron), false);

// ── Moves the state machine refuses ─────────────────────────────────────────
console.log("\nDirector Review's details on the way past it");
eq("entering Director Review checks", needsReviewDetails("follow_up", "second_shortlist"), true);
eq("Follow-up straight to the Director's shortlist checks", needsReviewDetails("follow_up", "director_shortlist"), true);
eq("Follow-up straight to the client checks", needsReviewDetails("ta_shortlist", "client_review"), true);
eq("the Director's own mail does not", needsReviewDetails("follow_up", "director_shortlist", true), false);
eq("Director Review onwards does not ask again", needsReviewDetails("second_shortlist", "director_shortlist"), false);
eq("rejecting never checks", needsReviewDetails("follow_up", "rejected"), false);
eq("bringing someone back never checks", needsReviewDetails("rejected", "follow_up"), false);
const machine = read("convex/pipeline/pipelineStateMachine.ts");
eq("the state machine asks the shared rule", machine.includes("needsReviewDetails(currentStage, targetStage"), true);
eq("the mail intake says the reviewer decided", read("convex/mailIntake/shortlist.ts").includes("decidedByReviewer: true"), true);

console.log("\nonly the desk-wide roles undo a placement");
const user = (role: string, taRole?: string) => mapUser({ _id: "u", email: "", fullName: "", role, taRole, isActive: true });
eq("a TA cannot", isDeskWide(user("recruiter")), false);
eq("a TA by taRole cannot, whatever the backend role", isDeskWide(user("director", "ta")), false);
eq("a TA lead can", isDeskWide(user("ta_manager")), true);
eq("a director can", isDeskWide(user("director")), true);
eq("ops can", isDeskWide(user("ops")), true);
eq("an admin can", isDeskWide(user("admin")), true);
eq("the state machine checks it on leaving Placed", /currentStage === "placed"[\s\S]{0,400}isDeskWideUser/.test(machine), true);
eq("and takes the placement back off the day it was counted", machine.includes("placements: daily.placements - 1"), true);

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
