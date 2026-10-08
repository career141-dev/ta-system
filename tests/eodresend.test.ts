/**
 * Sending an end-of-day email again, corrected (8 Oct): the copy kept for a
 * day (src/data/store saveEodCopy), the REVISED subject (src/lib/eod-format),
 * a reply to the revised email finding the same round (src/lib/routing), and
 * table 1 for people already sent (src/lib/eod rowsForApplications).
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { revisedSubject, type EffortRow, type ShortlistRow } from "@/lib/eod-format";
import { matchReviewReply, DEFAULT_SHORTLIST_INBOX } from "@/lib/routing";
import type { Client, Opening, ReviewRound, User } from "@/data/types";

// The copies are kept in the in-memory JSON store, in a scratch directory.
process.chdir(fs.mkdtempSync(path.join(os.tmpdir(), "c141-eodresend-")));
const { repo, EOD_COPY_KEPT_MS } = await import("@/data/store");
const { rowsForApplications, shortlistRows } = await import("@/lib/eod");

let pass = 0, fail = 0;
const eq = (l: string, got: unknown, want: unknown) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  ok ? pass++ : fail++;
  console.log(`${ok ? "  ok  " : "  FAIL"} ${l}${ok ? "" : `  got ${JSON.stringify(got)} want ${JSON.stringify(want)}`}`);
};

const SUBJECT = "SET 2 - DELMO - BRAND MANAGER - 3 CVs";

console.log("\nThe REVISED subject");
eq("the prefix goes in front", revisedSubject(SUBJECT), `REVISED - ${SUBJECT}`);
eq("once, however many times it is resent", revisedSubject(revisedSubject(SUBJECT)), `REVISED - ${SUBJECT}`);
eq("whatever capitals it was typed in", revisedSubject(`Revised: ${SUBJECT}`), `REVISED - ${SUBJECT}`);
eq("a double one typed by hand is folded", revisedSubject(`REVISED - REVISED - ${SUBJECT}`), `REVISED - ${SUBJECT}`);
eq("spaces round it are trimmed", revisedSubject(`  ${SUBJECT}  `), `REVISED - ${SUBJECT}`);

console.log("\nA reply to the revised email answers the same set");
{
  const users = [
    { id: "u_dir", name: "Director", email: "director@career141.com", role: "director" },
    { id: "u_ta", name: "Nuha", email: "nuha@career141.com", role: "ta" },
  ] as User[];
  const clients = [{ id: "cl_delmo", name: "Delmo", contacts: [] }] as unknown as Client[];
  const openings = [{ id: "op_brand", clientId: "cl_delmo", title: "Brand Manager" } as Opening];
  const round = (id: string, subject: string, sentAt: number) =>
    ({ id, openingId: "op_brand", kind: "director", sentAt, status: "awaiting", applicationIds: ["a1"], token: "",
       messageId: null, setNumber: null, sentBy: "u_ta", sentTo: "x", trackedAt: DEFAULT_SHORTLIST_INBOX,
       subject, dispatch: "held", returnedAt: null, replyBody: null, decisions: [] } as ReviewRound);
  // Two sets out on the same job, so only the subject can tell them apart.
  const rounds = [round("r_set2", SUBJECT, 2000), round("r_set1", "SET 1 - DELMO - BRAND MANAGER - 5 CVs", 1000)];
  const M = (subject: string) =>
    matchReviewReply({ from: "director@career141.com", subject }, { rounds, openings, clients, users }).round?.id;
  eq("a reply to the first send", M(`RE: ${SUBJECT}`), "r_set2");
  eq("a reply to the REVISED send", M(`RE: ${revisedSubject(SUBJECT)}`), "r_set2");
  eq("forwarded, then replied to", M(`Fw: RE: ${revisedSubject(SUBJECT)}`), "r_set2");
  eq("the other set is still its own", M("RE: SET 1 - DELMO - BRAND MANAGER - 5 CVs"), "r_set1");
}

console.log("\nThe copy kept for a month");
{
  const o = repo.openings()[0];
  const apps = repo.applications(o.id).slice(0, 2);
  const ta = repo.users().find((u) => u.role === "ta")!;
  const ids = apps.map((a) => a.id);
  const effort = { date: "8 Oct", assignee: ta.name, hundredOrFollowUp: "100%", lEffort: 4, sets: 2, da: 0, scoop: null,
    l: 2, post: 0, addOns: null, backUp: null, targets: { l: 5 } } as EffortRow;
  const round = repo.openReviewRound({
    openingId: o.id, kind: "director", applicationIds: ids, setNumber: 2, sentBy: ta.id, sentTo: "joborders@career141.com", subject: SUBJECT,
  });
  const rows = rowsForApplications(ids);
  const base = {
    openingId: o.id, roundId: round.id, sentBy: ta.id, subject: SUBJECT, introText: "Dear Sir,", outroText: "Thank You",
    researchLink: null, applicationIds: ids, rows, effort, extraTo: [], extraCc: [], removed: [],
    to: ["joborders@career141.com"], cc: [],
  };

  const v1 = repo.saveEodCopy({ ...base, version: 1 });
  eq("it is kept for a month from the send", v1.expiresAt - v1.sentAt, EOD_COPY_KEPT_MS);
  eq("a month is never short: at least 31 days", EOD_COPY_KEPT_MS >= 31 * 24 * 60 * 60 * 1000, true);
  eq("it is listed for the opening", repo.eodCopies(o.id).map((c) => c.id), [v1.id]);
  eq("and can be opened", repo.eodCopy(v1.id)?.subject, SUBJECT);
  eq("the targets the TA typed are kept", repo.eodCopy(v1.id)?.effort.targets, { l: 5 });

  const v2 = repo.saveEodCopy({ ...base, version: 2, subject: revisedSubject(SUBJECT), expiresAt: v1.expiresAt });
  eq("a resend keeps the first send's day", v2.expiresAt, v1.expiresAt);
  eq("both versions are listed, newest first", repo.eodCopies(o.id).map((c) => c.version), [2, 1]);

  repo.markRoundRevised(round.id, { at: 123, researchLink: "https://chatgpt.com/share/x" });
  const after = repo.reviewRound(round.id);
  eq("the round records the resend", after?.revisedAt, [123]);
  eq("a corrected research link replaces the round's", after?.researchLink, "https://chatgpt.com/share/x");
  eq("the resend opens no new round", repo.reviewRounds(o.id).filter((r) => r.subject === SUBJECT).length, 1);

  // A month later: neither version can be listed or opened, even before a purge.
  const past = repo.saveEodCopy({ ...base, version: 1, expiresAt: Date.now() - 1 });
  eq("a copy past its month is not listed", repo.eodCopies(o.id).some((c) => c.id === past.id), false);
  eq("nor opened", repo.eodCopy(past.id), undefined);
  repo.saveEodCopy({ ...base, version: 3, expiresAt: v1.expiresAt });
  const onDisk = JSON.parse(fs.readFileSync(path.join(process.env.C141_DATA_DIR || path.join(process.cwd(), ".data"), "db.json"), "utf8"));
  eq("and the next save deletes it from the store", onDisk.eodEmailCopies.some((c: { id: string }) => c.id === past.id), false);
  eq("the versions inside their month stay", repo.eodCopies(o.id).map((c) => c.version), [3, 2, 1]);

  console.log("\nTable 1 for people already sent");
  eq("one row each, numbered in the order sent", rows.map((r) => [r.no, r.applicationId]), ids.map((id, i) => [i + 1, id]));
  eq("they are no longer in the new email", shortlistRows(o.id, null, "director").some((r) => ids.includes(r.applicationId)), false);
  const one = rows[0] as ShortlistRow;
  const c = repo.candidate(apps[0].candidateId)!;
  eq("built from the record", one.name, c.fullName);
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
