/**
 * Changes from the Ask chat: understood, proposed, and only made on confirm —
 * once, by the right person, with every check run again.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "c141-actions-"));
process.chdir(tmp);
const { repo } = await import("@/data/store");
const { execute, noticeToDays, parseIntent, parseWhen, propose, understand } = await import("@/lib/deskActions");
const { colomboDayStart } = await import("@/lib/calendar");

let pass = 0, fail = 0;
const eq = (l: string, got: unknown, want: unknown) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  ok ? pass++ : fail++;
  console.log(`${ok ? "  ok  " : "  FAIL"} ${l}${ok ? "" : `  got ${JSON.stringify(got)} want ${JSON.stringify(want)}`}`);
};

console.log("\nreading what was typed");
eq("shortlist", parseIntent("Shortlist Thisara Jayasuriya"), { kind: "shortlist", name: "Thisara Jayasuriya", job: null });
eq("shortlist on a job", parseIntent("shortlist Thisara on Brand Manager"), { kind: "shortlist", name: "Thisara", job: "Brand Manager" });
eq("reject with a reason", parseIntent("reject Kavindi — package above range"), { kind: "move", name: "Kavindi", job: null, stage: "rejected", reason: "package above range" });
eq("reject without a reason", parseIntent("reject Kavindi")?.reason, null);
eq("move to a stage", parseIntent("move Lakmal to interview")?.stage, "interview");
eq("dropped out", parseIntent("Yohan dropped out because accepted another offer"), { kind: "move", name: "Yohan", job: null, stage: "dropped_out", reason: "accepted another offer" });
eq("a note", parseIntent("add note to Hasitha: prefers Colombo only"), { kind: "note", name: "Hasitha", job: null, text: "prefers Colombo only" });
const fields = parseIntent("Kavindi expected salary 250k, notice 1 month")!;
eq("salary and notice together", [fields.kind, fields.name, fields.expectedSalary, fields.noticeDays], ["answers", "Kavindi", "250k", 30]);
eq("current salary on its own, commas in the number kept", parseIntent("record Lakmal's current salary is 180,000")?.currentSalary, "180,000");
eq("and a comma between fields still splits them", parseIntent("Lakmal current salary 180,000, expected salary 220,000")?.expectedSalary, "220,000");
eq("no answer", parseIntent("Thisara didn't answer")?.outcome, "no_answer");
eq("not interested", parseIntent("Nadeesha is not interested")?.outcome, "not_interested");
eq("call back", parseIntent("call Hasitha back tomorrow 10am"), { kind: "call", name: "Hasitha", job: null, outcome: "callback", when: "tomorrow 10am", text: "" });
eq("a question is not an action", parseIntent("how many cvs today?"), null);
eq("notice in weeks", noticeToDays("2 weeks"), 14);
eq("immediate notice", noticeToDays("immediately"), 0);

console.log("\nreading a time (Colombo)");
const now = Date.UTC(2026, 8, 14, 4, 30); // Mon 14 Sep 2026, 10:00 in Colombo
const day = colomboDayStart(now);
eq("4pm today", parseWhen("4pm", now), day + 16 * 3_600_000);
eq("tomorrow 10am", parseWhen("tomorrow 10am", now), day + 86_400_000 + 10 * 3_600_000);
eq("a bare time already past is tomorrow", parseWhen("9am", now), day + 86_400_000 + 9 * 3_600_000);
eq("'at 3' on a desk is the afternoon", parseWhen("3", now), day + 15 * 3_600_000);
eq("a date and a time", parseWhen("16 Sep 3pm", now), day + 2 * 86_400_000 + 15 * 3_600_000);
eq("nonsense is not a time", parseWhen("soon", now), null);

repo.reset();
const users = repo.users();
const nuha = users.find((u) => u.name === "Nuha")!;
const other = users.find((u) => u.role === "ta" && u.id !== nuha.id && repo.openingsForUser(u).some((o) => !repo.openingsForUser(nuha).some((x) => x.id === o.id)))!;
const brand = repo.openingsForUser(nuha)[0];
const nameOf = (appId: string) => repo.candidate(repo.application(appId)!.candidateId)!.fullName;

console.log("\nfinding the person");
eq("someone not on your jobs isn't found", propose(nuha, { kind: "shortlist", name: "Nobody Atall", job: null }).type, "refusal");
const otherJob = repo.openingsForUser(other).find((o) => !repo.openingsForUser(nuha).some((x) => x.id === o.id))!;
const otherApp = repo.applications(otherJob.id).find((a) => !repo.applications().some((b) => b.candidateId === a.candidateId && b.openingId === brand.id))!;
eq("a candidate on another TA's job isn't found", propose(nuha, { kind: "note", name: nameOf(otherApp.id), job: null, text: "x" }).type, "refusal");

console.log("\nnothing changes until confirmed");
const fresh = repo.applications(brand.id).find((a) => a.stage === "new_cv" && !a.ownerTaId)!;
const p = propose(nuha, { kind: "shortlist", name: nameOf(fresh.id), job: brand.title });
eq("a proposal comes back", p.type, "proposal");
eq("and the candidate is untouched", [repo.application(fresh.id)!.stage, repo.application(fresh.id)!.ownerTaId], ["new_cv", null]);
const tok = p.type === "proposal" ? p.proposal.token : "";

console.log("\nconfirming");
eq("someone else can't use it", execute(other, tok).ok, false);
const tampered = tok.replace(/^(.)/, (c) => (c === "e" ? "f" : "e"));
eq("a changed token is refused", execute(nuha, tampered).ok, false);
eq("an old one is refused", execute(nuha, tok, Date.now() + 11 * 60_000).ok, false);
const done = execute(nuha, tok);
eq("the owner confirms and it runs", [done.ok, repo.application(fresh.id)!.stage, repo.application(fresh.id)!.ownerTaId], [true, "ai_follow_up", nuha.id]);
eq("and it runs only once", execute(nuha, tok).ok, false);

console.log("\nchecked again when it runs");
const second = repo.applications(brand.id).find((a) => a.stage === "new_cv" && !a.ownerTaId && a.id !== fresh.id)!;
const p2 = propose(nuha, { kind: "shortlist", name: nameOf(second.id), job: brand.title });
const tok2 = p2.type === "proposal" ? p2.proposal.token : "";
const colleague = users.find((u) => u.id !== nuha.id && brand.assignedTaIds.includes(u.id))!;
repo.shortlist(second.id, colleague.id);
const late = execute(nuha, tok2);
eq("someone else shortlisted in between: refused", late.ok, false);
eq("and it stays theirs", repo.application(second.id)!.ownerTaId, colleague.id);

console.log("\nthe rules the screens keep");
eq("shortlisting someone already in follow-up is refused", propose(nuha, { kind: "shortlist", name: nameOf(fresh.id), job: brand.title }).type, "refusal");
eq("rejecting needs a reason", propose(nuha, { kind: "move", name: nameOf(fresh.id), job: brand.title, stage: "rejected", reason: null }).type, "question");
eq("a move the pipeline doesn't allow is refused", propose(nuha, { kind: "move", name: nameOf(fresh.id), job: brand.title, stage: "placed", reason: null }).type, "refusal");
eq("a colleague's candidate can't be changed", propose(nuha, { kind: "note", name: nameOf(second.id), job: brand.title, text: "hi" }).type, "refusal");
const third = repo.applications(brand.id).find((a) => a.stage === "new_cv" && !a.ownerTaId && a.id !== fresh.id && a.id !== second.id);
if (third) {
  const mv = propose(nuha, { kind: "move", name: nameOf(third.id), job: brand.title, stage: "ta_follow_up", reason: null });
  eq("'move to follow-up' from a new CV becomes a shortlist", mv.type === "proposal" && /^Shortlist/.test(mv.proposal.summary), true);
}
eq("a follow-up call on someone not in follow-up is refused", propose(nuha, { kind: "call", name: nameOf(repo.applications(brand.id).find((a) => a.stage === "placed")!.id), job: brand.title, outcome: "no_answer" }).type, "refusal");

console.log("\nthe everyday changes");
const note = propose(nuha, { kind: "note", name: nameOf(fresh.id), job: brand.title, text: "Prefers Colombo" });
const noteRun = note.type === "proposal" ? execute(nuha, note.proposal.token) : { ok: false };
eq("a note is added", noteRun.ok && repo.application(fresh.id)!.notes.some((n) => n.startsWith("Prefers Colombo — Nuha")), true);
const ans = propose(nuha, { kind: "answers", name: nameOf(fresh.id), job: brand.title, expectedSalary: "250k", currentSalary: null, noticeDays: 30 });
if (ans.type === "proposal") execute(nuha, ans.proposal.token);
const cand = repo.candidate(repo.application(fresh.id)!.candidateId)!;
eq("salary and notice are saved", [cand.expectedSalary, cand.noticePeriodDays], ["250k", 30]);
const cb = propose(nuha, { kind: "call", name: nameOf(fresh.id), job: brand.title, outcome: "callback", when: "tomorrow 11am" });
eq("a call-back with a time is proposed", cb.type, "proposal");
eq("a call-back with no time asks when", propose(nuha, { kind: "call", name: nameOf(fresh.id), job: brand.title, outcome: "callback", when: "later" }).type, "question");
if (cb.type === "proposal") eq("and recorded on confirm", execute(nuha, cb.proposal.token).ok, true);

console.log("\nwhen the rules can't read it, the model only fills the same fields");
let calls = 0;
const intent = await understand("could you pop Hasitha into the shortlist please", async () => {
  calls++;
  return { ok: true as const, text: '{"kind":"shortlist","name":"Hasitha","job":null}', sources: [], searches: 0, provider: "test" };
});
eq("read by the model", [intent?.kind, intent?.name, calls], ["shortlist", "Hasitha", 1]);
eq("a question read as 'none' is not an action", await understand("what do you think of Hasitha?", async () => ({ ok: true as const, text: '{"kind":"none","name":""}', sources: [], searches: 0, provider: "test" })), null);
eq("rule-readable messages never reach the model", [await understand("shortlist Hasitha", async () => { throw new Error("called"); }).then((i) => i?.kind)], ["shortlist"]);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
