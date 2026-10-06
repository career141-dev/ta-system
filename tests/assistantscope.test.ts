/**
 * The desk assistant, 6 Oct: two TAs on one job hear only their own desk, every
 * person named is loaded or said to be not loaded, the set rule is the 28 Sep
 * one, and the asker's role decides what they are told to do.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "c141-assist-scope-"));
process.chdir(tmp);
const { repo } = await import("@/data/store");
const { askDesk, quickAnswer, roleBrief, snapshotCandidateIds, snapshotFor, SYSTEM } = await import("@/lib/deskAssistant");
const { PLATFORM_KNOWLEDGE, quickWorkflowHelp } = await import("@/lib/platformGuide");
const { propose } = await import("@/lib/deskActions");
const { seatFor, visibleToSeat } = await import("@/lib/visibility");

let pass = 0, fail = 0;
const eq = (l: string, got: unknown, want: unknown) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  ok ? pass++ : fail++;
  console.log(`${ok ? "  ok  " : "  FAIL"} ${l}${ok ? "" : `  got ${JSON.stringify(got)} want ${JSON.stringify(want)}`}`);
};
const noModel = async () => ({ ok: true as const, text: "", sources: [], searches: 0, provider: "test" });

repo.reset();
const users = repo.users();
const nuha = users.find((u) => u.name === "Nuha")!;
const sanduni = users.find((u) => u.name === "Sanduni")!;
const director = users.find((u) => u.role === "director")!;
const brand = repo.opening("op_brand")!;

console.log("\na TA beside another on one job hears only their own desk");
// One of Sanduni's people she has taken on but not shortlisted, and one she has.
const hers = repo.applications(brand.id).filter((a) => a.ownerTaId === sanduni.id);
const unshort = hers[0];
unshort.shortlistedAt = null;
const shortlisted = hers.find((a) => a.id !== unshort.id && a.shortlistedAt)!;
const hidden = repo.candidate(unshort.candidateId)!;
const shown = repo.candidate(shortlisted.candidateId)!;

const snap = snapshotFor(nuha, "who is in my follow-up on Brand Manager");
const text = JSON.stringify(snap);
const job = snap.openings.find((o) => o.id === brand.id) as any;
eq("no follow-up of Sanduni's is listed", job.followUps.some((f: any) => f.owner === sanduni.name), false);
eq("her unshortlisted person's name is nowhere", text.includes(hidden.fullName), false);
eq("nor their phone", !!hidden.phone && text.includes(hidden.phone), false);
const nuhaDesk = visibleToSeat(repo.applications(brand.id), seatFor(nuha, "primary_recruiter"));
eq("counts are Nuha's own desk", Object.values(job.byStage as Record<string, number>).reduce((a, b) => a + b, 0), nuhaDesk.length);
eq("and leave Sanduni's people out", nuhaDesk.some((a) => a.ownerTaId === sanduni.id), false);
eq("her posts are not listed", job.posts.every((p: any) => p.owner !== sanduni.name), true);
const named = job.shortlistedByOthers.find((p: any) => p.name === shown.fullName);
eq("her shortlisted person is named as hers", named?.shortlistedBy, sanduni.name);
eq("with no number or email", named && !("phone" in named) && !("email" in named) && !("link" in named), true);
const byName = snapshotFor(nuha, `what about ${shown.fullName}`).peopleNamedInQuestion.find((p) => p.name === shown.fullName) as any;
eq("asked by name: shortlisted by Sanduni, nothing more", [byName?.shortlistedBy, "phone" in (byName ?? {}), "link" in (byName ?? {})], [sanduni.name, false, false]);
eq("asked by name, her unshortlisted person is not found", snapshotFor(nuha, `what about ${hidden.fullName}`).peopleNamedInQuestion.some((p) => p.name === hidden.fullName && p.opening === brand.title), false);
const fu = await askDesk(nuha, "Who is in my follow-up, with numbers?", [], noModel);
eq("the instant follow-up answer has none of hers", fu.ok && hers.filter((a) => a.stage === "ta_follow_up").every((a) => !fu.answer.includes(repo.candidate(a.candidateId)!.fullName)), true);
eq("a change to her candidate is not offered", propose(nuha, { kind: "note", name: shown.fullName, job: brand.title, text: "x" }).type, "refusal");
eq("the lead still sees both desks", JSON.stringify(snapshotFor(director, "follow up on Brand Manager")).includes(hidden.fullName), true);

console.log("\neveryone the snapshot names is loaded first, within bounds");
const ids = snapshotCandidateIds(nuha, "who is in my follow-up");
const want = nuhaDesk.filter((a) => !["new_cv", "rejected", "dropped_out"].includes(a.stage)).map((a) => a.candidateId);
eq("every named stage on her desk is asked for", want.every((id) => ids.includes(id)), true);
eq("raw new CVs are not, without a name in the question", nuhaDesk.filter((a) => a.stage === "new_cv").every((a) => !ids.includes(a.candidateId) || want.includes(a.candidateId)), true);
eq("never past 3,000", snapshotCandidateIds(director, "where is Thisara").length <= 3000, true);
eq("a name in the question widens it to her whole desk", nuhaDesk.every((a) => snapshotCandidateIds(nuha, "where is Thisara").includes(a.candidateId)), true);
// A record the store does not hold is said so, never left blank.
const dr = nuhaDesk.find((a) => a.stage === "director_review") ?? nuhaDesk.find((a) => a.stage === "ai_follow_up")!;
const stage = dr.stage;
dr.stage = "director_review";
const realCandidate = dr.candidateId;
dr.candidateId = "c_not_in_memory";
const missing = (snapshotFor(nuha, "director").openings.find((o) => o.id === brand.id) as any).withDirector.find((p: any) => p.link.endsWith(dr.id));
eq("a missing record reads 'name not loaded'", missing?.name, "name not loaded");
dr.candidateId = realCandidate;
dr.stage = stage;
eq("the snapshot says when it was read", /^\d{2}:\d{2}$/.test(snap.asOf), true);

console.log("\nthe set rule is the 28 Sep one");
eq("the prompt says five or more in one day", /five or more CVs are sent in one Colombo day/.test(SYSTEM), true);
eq("and no longer 'reaches five'", /reaches five|until it reaches 5|under 5/i.test(SYSTEM + PLATFORM_KNOWLEDGE), false);
eq("the quick answer says the same", /five or more CVs in one day/.test(quickWorkflowHelp("how do sets work?") ?? ""), true);
eq("an open set in the snapshot is not 'under 5'", JSON.stringify(snap).includes("under 5"), false);

console.log("\nthe role decides what they are told");
const taBrief = roleBrief(nuha);
eq("a TA is not told to record the Director's decision", taBrief.canDo.some((c) => /Director's decision/.test(c)), false);
eq("and is told that she cannot", taBrief.cannotDo.some((c) => /Director's decision/.test(c)), true);
eq("a TA can work her own jobs", taBrief.canDo.some((c) => /^move candidates/.test(c)), true);
const dirBrief = roleBrief(director);
eq("a director can record the Director's decision", dirBrief.canDo.some((c) => /Director's decision/.test(c)), true);
eq("and sees the whole desk", dirBrief.sees, "the whole desk");
const client = (repo.users().find((u) => u.role === "client") ?? (() => {
  (repo as any).addUser({ name: "Client Contact", email: "contact@client.invalid", role: "client", phone: null });
  return repo.users().find((u) => u.role === "client")!;
})());
eq("a client seat is never told to move candidates", roleBrief(client).canDo.some((c) => /move candidates|headhunt|new opening/.test(c)), false);
eq("the role goes to the model", snap.you.role, "Talent Acquisition");
eq("the prompt no longer calls everyone a TA", /answering a member of the TA desk/.test(SYSTEM), false);

console.log("\na desk-wide person's whole-desk question names people on their busiest jobs");
const open = repo.openings().filter((o) => o.status === "open" || o.status === "on_hold");
// The seed has six open jobs; copies make it a desk big enough to cap. An
// opening with no applications of its own is still a job on the desk.
for (let i = open.length; i < 14; i++) repo.openings().push({ ...brand, id: `op_extra_${i}`, title: `Extra role ${i}` });
const all = repo.openings().filter((o) => o.status === "open" || o.status === "on_hold").length;
if (all > 10) {
  const wide = snapshotFor(director, "who's in my follow-up?");
  const detailed = wide.openings.filter((o) => "followUps" in o).length;
  eq("at most ten jobs carry names", detailed <= 10 && detailed > 0, true);
  eq("the rest are counted", wide.openingsWithoutDetail, all - detailed);
  const ans = quickAnswer(wide, "who's in my follow-up?", director) ?? "";
  eq("and the answer says more are not shown", ans.includes(`${all - detailed} more not shown`), true);
} else {
  console.log(`  (skipped: only ${all} open jobs in the seed)`);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
