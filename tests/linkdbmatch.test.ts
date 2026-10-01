/**
 * A headhunted LinkedIn row that is already in our database (1 Oct): one
 * person, not two. The row keeps "Add to pipeline" while they are only a
 * database suggestion, the matcher and Database CVs leave them to Excel
 * Tables, and going onto the pipeline fills the gaps on the record we hold
 * without overwriting anything it has.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

for (const k of ["OPENAI_API_KEY", "OPENROUTER_API_KEY", "ANTHROPIC_API_KEY", "GOOGLE_API_KEY", "C141_EMBED_MODEL"]) delete process.env[k];
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "c141-linkdb-"));
process.chdir(tmp);
const { repo } = await import("@/data/store");
const { awaitingShortlist } = await import("@/lib/pipeline");
const { linkedCandidates } = await import("@/lib/dbMatch");

let pass = 0, fail = 0;
const eq = (l: string, got: unknown, want: unknown) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  ok ? pass++ : fail++;
  console.log(`${ok ? "  ok  " : "  FAIL"} ${l}${ok ? "" : `  got ${JSON.stringify(got)} want ${JSON.stringify(want)}`}`);
};

const ta = repo.users().find((u) => u.role === "ta")!;
const o = repo.openings()[0];

console.log("\nan unclaimed match is not a place on the pipeline");
eq("matched awaits a shortlist", awaitingShortlist({ stage: "matched" }), true);
eq("a new CV awaits a shortlist", awaitingShortlist({ stage: "new_cv" }), true);
eq("TA Follow-up does not", awaitingShortlist({ stage: "ta_follow_up" }), false);

console.log("\none person: the row, the record and the application");
const held = repo.candidates().find((c) => !c.linkedinUrl && !repo.applicationsForCandidate(c.id).some((a) => a.openingId === o.id))!;
const title = held.currentTitle;
const row = repo.addLink(o.id, "https://www.linkedin.com/in/someone-we-hold", ta.id, held.fullName);
repo.updateLink(row, { candidateId: held.id, outcome: "shortlisted", phoneNumber: "0771112233", title: "A different title", company: "Other Co" });
eq("the row is tied to them", linkedCandidates(o.id).has(held.id), true);
const people = repo.candidates().length;
const made = repo.linkToApplication(row, ta.id);
eq("they go onto the opening", made.ok, true);
eq("no second record", repo.candidates().length, people);
const after = repo.candidate(held.id)!;
eq("their LinkedIn address is kept on the record", after.linkedinUrl, "https://www.linkedin.com/in/someone-we-hold");
eq("a missing number is filled", after.phone === "0771112233" || !!held.phone, true);
eq("what they already had is not overwritten", after.currentTitle, title);
eq("one application on the opening", repo.applications(o.id).filter((a) => a.candidateId === held.id).length, 1);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
