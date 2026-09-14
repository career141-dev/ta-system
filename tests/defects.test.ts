/**
 * The defects the 13 September independent review reproduced, kept as
 * regression tests. Each one once gave a wrong answer with every other test
 * passing — which is why they are pinned here by name.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

for (const k of ["OPENAI_API_KEY", "OPENROUTER_API_KEY", "ANTHROPIC_API_KEY", "GOOGLE_API_KEY"]) delete process.env[k];
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "c141-defects-"));
process.chdir(tmp);

const { repo } = await import("@/data/store");
const { requirementsFromOpening, scoreCandidate, credentialStatus, mustsScore } = await import("@/lib/scoring");
const { followUpFor, STANDARD_QUESTIONS } = await import("@/lib/followup");
const { parseReply } = await import("@/lib/reviewReply");
import type { Candidate } from "@/data/types";

let pass = 0, fail = 0;
const eq = (l: string, got: unknown, want: unknown) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  ok ? pass++ : fail++;
  console.log(`${ok ? "  ok  " : "  FAIL"} ${l}${ok ? "" : `  got ${JSON.stringify(got)} want ${JSON.stringify(want)}`}`);
};
const cand = (over: Partial<Candidate> = {}): Candidate => ({
  id: "c", fullName: "Test Person", email: "t@example.com", phone: "+94 77 000 0000", linkedinUrl: null, location: "Colombo",
  nationality: null, age: null, gender: null, currentEmployer: "Acme", currentTitle: "Procurement Manager",
  totalExperienceYears: 12, educationDegree: null, educationInstitution: null, qualifications: null,
  englishLevel: null, languages: [], skills: [], industries: [], noticePeriodDays: null, currentSalary: null,
  expectedSalary: null, cvFileName: null, workHistory: [], createdAt: 0, ...over,
} as Candidate);

console.log("\nseparate experience requirements keep their scope");
{
  const r = requirementsFromOpening({ title: "Head of Engineering", jdMarkdown: "## Requirements\n- Minimum 15 years of overall engineering experience\n- Minimum 8 years in a managerial or leadership role", locations: [], targetNationalities: [], industry: null, knownSkills: [] });
  eq("15 years overall stays 15", r.minYears, 15);
  eq("and 8 years of management is kept separately", r.managementYears, 8);
  const one = requirementsFromOpening({ title: "Head of Engineering", jdMarkdown: "## Requirements\n- 15 years overall and 8 years in management", locations: [], targetNationalities: [], industry: null, knownSkills: [] });
  eq("one sentence with both keeps both", [one.minYears, one.managementYears], [15, 8]);
  const functional = requirementsFromOpening({ title: "Procurement Manager", jdMarkdown: "## Requirements\n- 10 years in procurement management", locations: [], targetNationalities: [], industry: null, knownSkills: [] });
  eq("'procurement management' names the work, not a leadership floor", [functional.minYears, functional.managementYears], [10, null]);
  const eight = cand({ currentTitle: "Engineering Manager", totalExperienceYears: 8, workHistory: [{ title: "Engineering Manager", employer: "X", fromYear: 2018, toYear: null }] });
  const fifteen = cand({ currentTitle: "Engineering Manager", totalExperienceYears: 16, workHistory: [{ title: "Engineering Manager", employer: "X", fromYear: 2016, toYear: null }, { title: "Engineer", employer: "Y", fromYear: 2010, toYear: 2016 }] });
  eq("8 years no longer scores like 15", scoreCandidate(fifteen, r).overall > scoreCandidate(eight, r).overall, true);
}

console.log("\na denial is not evidence");
{
  const m = mustsScore(["Managed procurement budgets"], cand(), "I have never managed procurement budgets. I handled purchase orders.");
  eq("'never managed procurement budgets' does not meet it", m.met, []);
  eq("it is recorded as contradicted", m.contradicted, ["Managed procurement budgets"]);
  const ok = mustsScore(["Managed procurement budgets"], cand(), "Managed procurement budgets of LKR 400 million.");
  eq("a plain statement still meets it", ok.met, ["Managed procurement budgets"]);
}

console.log("\nstudying is not qualified");
{
  eq("'currently studying CIMA' is part-way", credentialStatus("CIMA", "", "Currently studying CIMA while working"), "partial");
  eq("'CIMA passed 9 papers' is part-way", credentialStatus("CIMA", "", "CIMA - passed 9 papers"), "partial");
  eq("'Associate member of CIMA (ACMA)' is held", credentialStatus("CIMA", "", "Associate member of CIMA (ACMA, CGMA)"), "held");
  eq("a plain mention is held", credentialStatus("CIMA", "", "Qualifications: CIMA, BSc Accounting"), "held");
  eq("a record field is held", credentialStatus("CIMA", "CIMA", ""), "held");
  const job = requirementsFromOpening({ title: "Finance Manager", jdMarkdown: "## Requirements\n- CIMA qualified", locations: [], targetNationalities: [], industry: null, knownSkills: [] });
  const studying = scoreCandidate(cand({ currentTitle: "Finance Manager" }), job, { cvText: "Currently studying CIMA" });
  eq("a CIMA-qualified job marks a student part-way", studying.penalties.some((p) => /part-way/.test(p.label)), true);
}

console.log("\none assessment, whatever the screen");
{
  const job = requirementsFromOpening({ title: "Procurement Manager", jdMarkdown: "- Sourcing", locations: [], targetNationalities: [], industry: null, knownSkills: [] });
  const c = cand();
  eq("similarity does not change the displayed score", scoreCandidate(c, job, { vector: 0.2 }).overall, scoreCandidate(c, job).overall);
  eq("nor with a high similarity", scoreCandidate(c, job, { vector: 0.95 }).overall, scoreCandidate(c, job).overall);
}

console.log("\none assessment code path, with its version");
{
  const { assess, ASSESSMENT_VERSION, UNAVAILABLE_MESSAGE } = await import("@/lib/assessment");
  const { requirementsFor } = await import("@/lib/dbMatch");
  const { scoreSet } = await import("@/lib/scoring");
  const approved = repo.openings().find((o) => o.jdStatus === "approved");
  const draft = repo.openings().find((o) => o.jdStatus !== "approved");
  if (approved) {
    const people = repo.candidates().slice(0, 25);
    const a = assess(approved.id, people);
    const direct = new Map(scoreSet(people.map((c) => ({ candidate: c, cvText: repo.cvTextFor(c.id) })), requirementsFor(approved.id)!).map((r) => [r.candidate.id, r.score.overall]));
    eq("the shared assessment gives the same scores as matching's requirements", a.ok && people.every((c) => a.scores.get(c.id)?.overall === direct.get(c.id)), true);
    eq("and names the rules version", a.ok && a.version, ASSESSMENT_VERSION);
  } else eq("seed has an approved opening", false, true);
  if (draft) {
    const d = assess(draft.id, repo.candidates().slice(0, 3));
    eq("an unapproved JD explains why there is no score", !d.ok && d.message, UNAVAILABLE_MESSAGE.jd_not_approved);
  }
  const gone = assess("op_missing", []);
  eq("a missing opening says so", !gone.ok && gone.reason, "no_opening");
}

console.log("\na guessed nationality does not rank");
{
  const job = requirementsFromOpening({ title: "Procurement Manager", jdMarkdown: "- Sourcing", locations: [], targetNationalities: ["Sri Lankan"], industry: null, knownSkills: [] });
  const guessedOther = cand({ nationality: null, phone: "+880 1711 000000" });
  const guessedSame = cand({ nationality: null, phone: "+94 77 000 0000" });
  eq("an unstated nationality is not guessed into the score", scoreCandidate(guessedOther, job).overall, scoreCandidate(guessedSame, job).overall);
}

console.log("\nfollow-up: withdrawal before completeness, and no repeat email");
{
  const complete = cand({ currentSalary: "LKR 300,000", expectedSalary: "LKR 350,000", noticePeriodDays: 30 });
  const f = followUpFor({ candidate: complete, questions: STANDARD_QUESTIONS, enteredAt: Date.now() - 3600_000, contacts: [{ at: Date.now() - 1800_000, channel: "ai_call", direction: "out", outcome: "not_interested" }] });
  eq("someone who said not interested is declined, not complete", f.state, "declined");
  const noPhone = cand({ phone: null });
  const t0 = Date.now() - 2 * 3600_000;
  const g = followUpFor({ candidate: noPhone, questions: STANDARD_QUESTIONS, enteredAt: t0, contacts: [{ at: t0 + 60_000, channel: "email", direction: "out" }], now: t0 + 5 * 60_000 });
  eq("with no phone, a second email is not due straight after the first", g.next?.purpose === "no_answer", false);
}

console.log("\na reply's numbers mean the email's numbers");
{
  const o = repo.openings()[0];
  const apps = repo.applications(o.id).slice(0, 3);
  if (apps.length === 3) {
    const round = repo.openReviewRound({ openingId: o.id, kind: "director", applicationIds: apps.map((a) => a.id), setNumber: null, sentBy: "u_nuha", sentTo: "director@example.com", subject: "test" });
    repo.applyReviewDecisions(round.id, [{ applicationId: apps[0].id, outcome: "shortlisted", confirmed: false } as never], "1 is in");
    const roster = repo.replyRoster(o.id, "director", round.id)!;
    eq("decided people stay in the numbering", roster.applicationIds, apps.map((a) => a.id));
    const list = roster.applicationIds.map((applicationId) => ({ applicationId, name: repo.candidate(repo.application(applicationId)!.candidateId)?.fullName ?? "x" }));
    const parsed = await parseReply("Shortlist 2", list);
    eq("after number 1 was decided, '2' is still the original number 2", parsed.decisions.map((d) => d.applicationId), [apps[1].id]);
  } else {
    eq("seed has three applications to test numbering", apps.length, 3);
  }
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
