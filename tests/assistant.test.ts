/**
 * The desk assistant sees only what the person asking can see, and answers
 * from the snapshot. No model is called — the "model" here echoes the prompt.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "c141-assist-"));
process.chdir(tmp);
const { repo } = await import("@/data/store");
const { askDesk, onlyRealLinks, safeLinks, snapshotFor } = await import("@/lib/deskAssistant");

let pass = 0, fail = 0;
const eq = (l: string, got: unknown, want: unknown) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  ok ? pass++ : fail++;
  console.log(`${ok ? "  ok  " : "  FAIL"} ${l}${ok ? "" : `  got ${JSON.stringify(got)} want ${JSON.stringify(want)}`}`);
};

repo.reset();
const users = repo.users();
const ta = users.find((u) => u.role === "ta" && repo.openingsForUser(u).length > 0)!;
const director = users.find((u) => u.role === "director")!;

console.log("\na TA's snapshot is their own jobs");
const mine = snapshotFor(ta, "how many cvs today");
const theirs = repo.openingsForUser(ta).filter((o) => o.status === "open" || o.status === "on_hold").map((o) => o.id).sort();
eq("exactly the openings they are on", mine.openings.map((o) => o.id).sort(), theirs);
eq("and not everyone's", mine.openings.length < repo.openings().length, true);
const other = repo.openings().find((o) => !theirs.includes(o.id))!;
eq("another TA's job is not in it", JSON.stringify(mine).includes(`/openings/${other.id}`), false);

console.log("\nthe counts are the records' counts");
const o = repo.openings().find((x) => x.id === mine.openings[0].id)!;
const snap = mine.openings[0] as any;
eq("stage counts add up to the visible applications", Object.values(snap.byStage as Record<string, number>).reduce((a, b) => a + b, 0), repo.applications(o.id).length);
eq("follow-ups carry a name and a number", (snap.followUps ?? []).every((f: any) => typeof f.name === "string" && "phone" in f), true);

console.log("\na director sees the desk");
eq("every open or held job", snapshotFor(director, "status").openings.length, repo.openings().filter((x) => x.status === "open" || x.status === "on_hold").length);

console.log("\na client seat sees its shortlist and nothing behind it");
const client = repo.users().find((u) => u.role === "client") ?? null;
let clientUser = client;
if (!clientUser) {
  const r = (repo as any).addUser({ name: "Client Contact", email: "contact@client.invalid", role: "client", phone: null });
  clientUser = repo.users().find((u) => u.role === "client")!;
  void r;
}
repo.setAssignments(o.id, [...repo.assignments(o.id).filter((a) => a.userId !== clientUser!.id).map((a) => ({ userId: a.userId, role: a.role })), { userId: clientUser!.id, role: "client_contact" }], director.id);
const cs = snapshotFor(clientUser!, "who is shortlisted");
const csText = JSON.stringify(cs);
eq("the client sees the one job it is on", cs.openings.map((x) => x.id), [o.id]);
const seenStages = Object.keys((cs.openings[0] as any)?.byStage ?? {});
eq("only client-visible stages are counted", seenStages.every((st) => !["New CVs", "Database match", "Follow-up", "Rejected", "Director Review"].includes(st)), true);
eq("no follow-up list", csText.includes('"followUps"'), false);
eq("no phone numbers", /"phone":"[^"]+"/.test(csText), false);

console.log("\na name in the question is looked up, inside scope only");
const someone = repo.applications(o.id).map((a) => repo.candidate(a.candidateId)!).find((c) => c.fullName.split(" ")[0].length > 3)!;
const byName = snapshotFor(ta, `what stage is ${someone.fullName.split(" ")[0]} at`);
eq("found", byName.peopleNamedInQuestion.some((p) => p.name === someone.fullName), true);
const outsider = repo.applications(other.id).map((a) => repo.candidate(a.candidateId)!).find((c) => !repo.applications().some((a) => a.candidateId === c.id && theirs.includes(a.openingId)))!;
eq("someone on another TA's job is not", snapshotFor(ta, `what about ${outsider.fullName}`).peopleNamedInQuestion.some((p) => p.name === outsider.fullName), false);

console.log("\nthe answer comes from the snapshot it was given");
let seen = "";
const r = await askDesk(ta, "which of my candidates look strongest and why?", [], async (_s, prompt) => {
  seen = prompt;
  return { ok: true as const, text: "3 CVs today on [Brand Manager](/openings/op_brand).", sources: [], searches: 0, provider: "test" };
});
eq("answered", r.ok, true);
eq("the snapshot went with the question", seen.includes('"cvsToday"') && seen.includes("strongest"), true);
eq("a free-form answer is marked as not instant", r.ok && r.instant, false);
eq("an empty question is refused without a call", (await askDesk(ta, "   ", [], async () => { throw new Error("called"); })).ok, false);

console.log("\neveryday questions are answered at once, from the records");
let called = false;
const noModel = async () => { called = true; return { ok: true as const, text: "", sources: [], searches: 0, provider: "test" }; };
const today = await askDesk(ta, "How many CVs came in today?", [], noModel);
const expectedToday = snapshotFor(ta, "cvs today").openings.reduce((n, x) => n + x.cvsToday, 0);
eq("CVs today: instant, and no model call", [today.ok && today.instant, called], [true, false]);
eq("with the total counted from the records", today.ok && today.answer.startsWith(`${expectedToday} CV`), true);
const fu = await askDesk(ta, "Who is in my follow-up, with numbers?", [], noModel);
const fuRows = (snapshotFor(ta, "follow up").openings as any[]).flatMap((x) => x.followUps ?? []);
eq("follow-ups: every name listed", fu.ok && fuRows.every((f: any) => fu.answer.includes(f.name)), true);
eq("with their numbers", fu.ok && fuRows.filter((f: any) => f.phone).every((f: any) => fu.answer.includes(f.phone)), true);
const sets = await askDesk(ta, "where are my sets?", [], noModel);
eq("sets: instant", sets.ok && sets.instant, true);
called = false;
const notMine = await askDesk(ta, `how many cvs today for the ${other.title} role?`, [], async (_s, p) => { called = true; return { ok: true as const, text: "I can't see that job.", sources: [], searches: 0, provider: "test" }; });
eq("a job that isn't theirs is not answered from their numbers", [notMine.ok && notMine.instant, called], [false, true]);

const narrowed = await askDesk(ta, "which of my follow-ups still need expected salary?", [], noModel);
const needExpected = fuRows.filter((f: any) => f.stillMissing.some((m: string) => m.toLowerCase().includes("expected")));
eq("a filtered follow-up question is filtered", narrowed.ok && fuRows.every((f: any) => narrowed.answer.includes(f.name) === needExpected.includes(f)), true);
const dir = await askDesk(director, "which jobs are waiting on the director?", [], noModel);
const withDir = repo.openings().filter((x) => (x.status === "open" || x.status === "on_hold") && repo.applications(x.id).some((a) => a.stage === "director_review"));
eq("director queue lists only jobs with someone waiting", dir.ok && repo.openings().every((x) => dir.answer.includes(`(/openings/${x.id})`) === withDir.includes(x)), true);

console.log("\nonly platform links survive");
eq("internal link kept", safeLinks("see [Brand Manager](/openings/op_brand)")[1], { text: "Brand Manager", href: "/openings/op_brand" });
eq("outside link becomes text", safeLinks("[click](https://evil.example)")[0], { text: "click" });
eq("protocol-relative link becomes text", safeLinks("[x](//evil.example)")[0], { text: "x" });

console.log("\na link to a page that does not exist is shown as text");
eq("a real page stays a link", onlyRealLinks("go to [Clients](/clients)"), "go to [Clients](/clients)");
eq("an opening's own page stays a link", onlyRealLinks("[Suggestions](/openings/op_brand/hh/suggestions)"), "[Suggestions](/openings/op_brand/hh/suggestions)");
eq("a candidate on an opening, with its tab, stays a link", onlyRealLinks("[Call](/openings/op_1/candidate/app_2?tab=call)"), "[Call](/openings/op_1/candidate/app_2?tab=call)");
eq("a made-up page becomes plain text", onlyRealLinks("try [Sourcing](/hh/suggestions) now"), "try Sourcing now");
eq("so does another invented one", onlyRealLinks("[Settings](/settings/team)"), "Settings");

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
