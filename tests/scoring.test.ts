import { bandFor, exaggeratedScore, requirementsFromOpening, scoreCandidate, seniorityOf, skillsScore, type Requirements } from "@/lib/scoring";
import { countryOf, locationFit } from "@/lib/places";
import type { Candidate } from "@/data/types";

let pass = 0, fail = 0;
const eq = (l: string, got: unknown, want: unknown) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  ok ? pass++ : fail++;
  console.log(`${ok ? "  ok  " : "  FAIL"} ${l}${ok ? "" : `  got ${JSON.stringify(got)} want ${JSON.stringify(want)}`}`);
};
const cand = (over: Partial<Candidate> = {}): Candidate => ({
  id: "c", fullName: "Test Person", email: null, phone: null, linkedinUrl: null, location: "Colombo",
  nationality: "Sri Lankan", age: null, gender: null, currentEmployer: "Acme", currentTitle: "Finance Manager",
  totalExperienceYears: 8, educationDegree: null, educationInstitution: null, qualifications: null,
  englishLevel: null, languages: [], skills: [], industries: [], noticePeriodDays: null, currentSalary: null,
  expectedSalary: null, cvFileName: null, workHistory: [], createdAt: 0, ...over,
} as Candidate);
const base: Requirements = {
  title: "Finance Manager", titleVariants: [], requiredSkills: [], preferredSkills: [], minYears: null,
  seniority: "lead", locations: [], nationalities: [], industries: [], requiredQualifications: [],
  negativeKeywords: [], discipline: "finance", qualitativeMusts: [],
};

console.log("\nfinding 46: holding the credential is holding it");
const cimaJd = requirementsFromOpening({
  title: "Finance Manager", jdMarkdown: "## Requirements\n- CIMA qualified\n- 5 years experience",
  locations: [], targetNationalities: [], industry: null, knownSkills: [],
});
const withCima = scoreCandidate(cand({ qualifications: "CIMA" }), cimaJd);
eq("no qualification penalty for a CIMA holder", withCima.penalties.some((p) => /^Missing /.test(p.label)), false);
const without = scoreCandidate(cand({ qualifications: "BSc" }), cimaJd);
eq("still penalised without it", without.penalties.some((p) => /^Missing /.test(p.label)), true);
const anyOf = requirementsFromOpening({
  title: "Finance Manager", jdMarkdown: "- CA, ACCA or CIMA", locations: [], targetNationalities: [], industry: null, knownSkills: [],
});
eq("any one of CA / ACCA / CIMA satisfies", scoreCandidate(cand({ qualifications: "ACCA (affiliate)" }), anyOf).penalties.length, 0);
eq("'CA' is not found inside 'Canada'", scoreCandidate(cand({ qualifications: "Diploma, Canada" }), anyOf).penalties.some((p) => /^Missing /.test(p.label)), true);

console.log("\nfinding 47: a Markdown heading marks preferred skills");
const md = requirementsFromOpening({
  title: "Data Analyst", jdMarkdown: "## Required\n- SQL\n\n## Preferred\n- Python",
  locations: [], targetNationalities: [], industry: null, knownSkills: ["SQL", "Python"],
});
eq("Python is preferred", md.preferredSkills, ["Python"]);
eq("and not required", md.requiredSkills, ["SQL"]);
for (const heading of ["### Nice to have", "**Desirable:**", "Preferred skills:", "Advantageous"]) {
  const r = requirementsFromOpening({
    title: "Data Analyst", jdMarkdown: `- SQL\n${heading}\n- Python`, locations: [], targetNationalities: [], industry: null, knownSkills: ["SQL", "Python"],
  });
  eq(`"${heading}" works too`, r.preferredSkills, ["Python"]);
}

console.log("\nfinding 48: JavaScript is not Java");
eq("Java is missing for a JavaScript candidate", skillsScore(["Java"], [], ["JavaScript"]).missing, ["Java"]);
eq("'Advanced Excel' still covers Excel", skillsScore(["Excel"], [], ["Advanced Excel"]).missing, []);
eq("'SAP' is not inside 'Sapphire'", skillsScore(["SAP"], [], ["Sapphire Suite"]).missing, ["SAP"]);

console.log("\nfinding 49: seniority of common titles");
eq("Assistant General Manager is not junior", seniorityOf("Assistant General Manager"), "lead");
eq("Deputy General Manager", seniorityOf("Deputy General Manager"), "lead");
eq("General Manager", seniorityOf("General Manager"), "executive");
eq("Assistant Manager is one step below a manager", seniorityOf("Assistant Manager"), "senior");
eq("Assistant Accountant", seniorityOf("Assistant Accountant"), "junior");
eq("Senior Manager", seniorityOf("Senior Manager"), "lead");
eq("Finance Director", seniorityOf("Finance Director"), "executive");
eq("Executive Assistant is not an executive", seniorityOf("Executive Assistant"), "junior");

console.log("\nfinding 50: a penalty never raises a score");
const nobody = cand({ currentTitle: "Barista", nationality: "Indian", skills: [], qualifications: null });
const hard = { ...base, requiredSkills: ["IFRS"], nationalities: ["Sri Lankan"] };
const a = scoreCandidate(nobody, hard).overall;
const b = scoreCandidate(nobody, { ...hard, requiredQualifications: ["CIMA"] }).overall;
eq("less qualified never scores higher", b <= a, true);
eq("every penalty is negative or zero", scoreCandidate(nobody, { ...hard, requiredQualifications: ["CIMA"] }).penalties.every((p) => p.delta <= 0), true);

console.log("\nfinding 51: 'City, Country' keeps its country");
eq("London, United Kingdom", countryOf("London, United Kingdom"), "united kingdom");
eq("Kurunegala, Sri Lanka", countryOf("Kurunegala, Sri Lanka"), "sri lanka");
eq("Colombo 03", countryOf("Colombo 03"), "sri lanka");
eq("fit against a country requirement", locationFit(["Sri Lanka"], "Kandy, Sri Lanka"), "match");

console.log("\nthe working adds up to the score");
for (const [label, c, r] of [
  ["a near fit", cand({ currentTitle: "Head of Finance", skills: ["IFRS"], qualifications: "CIMA" }), { ...base, requiredSkills: ["IFRS"], requiredQualifications: ["CIMA"] }],
  ["a poor fit with penalties", nobody, { ...hard, requiredQualifications: ["CIMA"] }],
  ["a city-country candidate", cand({ location: "Kandy, Sri Lanka" }), { ...base, locations: ["Colombo"] }],
] as [string, Candidate, Requirements][]) {
  const sc = scoreCandidate(c, r);
  eq(label, sc.explanation.reduce((n, l) => n + l.points, 0), sc.overall);
}

console.log("\nlocation ranks, it does not exclude (13 September)");
{
  const { localOnlyFromJd } = await import("@/lib/places");
  eq("local candidates only is read", localOnlyFromJd("- Local candidates only"), true);
  eq("Sri Lankan nationals only is read", localOnlyFromJd("Open to Sri Lankan nationals only."), true);
  eq("no expats is read", localOnlyFromJd("No expats please"), true);
  eq("a plain location line is not local only", localOnlyFromJd("Location: Colombo, Sri Lanka. Candidates from the apparel industry preferred."), false);
  const job = (jd: string) => requirementsFromOpening({ title: "Finance Manager", jdMarkdown: jd, locations: ["Colombo District, Western Province, Sri Lanka"], targetNationalities: [], industry: null, knownSkills: [] });
  const open = job("- ACCA");
  const local = job("- ACCA\n- Local candidates only");
  const at = (req: typeof open, location: string | null) => scoreCandidate(cand({ location }), req).overall;
  eq("same city ranks above another city", at(open, "Colombo") > at(open, "Kandy, Sri Lanka"), true);
  eq("another city ranks above another country", at(open, "Kandy, Sri Lanka") > at(open, "Dubai"), true);
  eq("another country costs little when not local only", at(open, "Colombo") - at(open, "Dubai") <= 10, true);
  eq("another country costs a lot when local only", at(local, "Colombo") - at(local, "Dubai") >= 20, true);
  eq("local only: another city is not marked down", at(local, "Kandy, Sri Lanka"), at(local, "Colombo"));
}

console.log("\nexaggeratedScore: boosts the number, never the order (database search and reverse-match screens)");
{
  eq("0 stays 0", exaggeratedScore(0), 0);
  eq("100 stays 100", exaggeratedScore(100), 100);
  eq("a mid score is boosted", exaggeratedScore(45) > 45, true);
  eq("a high score is boosted less, in absolute terms, than a mid one", exaggeratedScore(80) - 80 < exaggeratedScore(45) - 45, true);
  eq("out-of-range input is clamped low", exaggeratedScore(-10), 0);
  eq("out-of-range input is clamped high", exaggeratedScore(150), 100);
  for (let a = 0; a <= 100; a += 5) {
    for (let b = a + 1; b <= 100; b += 5) {
      if (exaggeratedScore(b) < exaggeratedScore(a)) {
        eq(`monotonic: ${a} <= ${b} must not invert (got ${exaggeratedScore(a)}, ${exaggeratedScore(b)})`, false, true);
      }
    }
  }
  // A real 45 reads "weak" on the pipeline; boosted for display it reads
  // "worth a look" or better — the word always matches the number shown.
  eq("a boosted mid score no longer reads as weak", bandFor(exaggeratedScore(45)), "worth a look");
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
