import { asBullets, requirementsFromOpening, scoreCandidate } from "@/lib/scoring";
import { industryExperience, industryWanted, inferNationality, industryOf } from "@/lib/profileInfer";
import type { Candidate } from "@/data/types";

let pass = 0, fail = 0;
const eq = (l: string, got: unknown, want: unknown) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  ok ? pass++ : fail++;
  console.log(`${ok ? "  ok  " : "  FAIL"} ${l}${ok ? "" : `  got ${JSON.stringify(got)} want ${JSON.stringify(want)}`}`);
};
const cand = (over: Partial<Candidate> = {}): Candidate => ({
  id: "c", fullName: "Test Person", email: null, phone: null, linkedinUrl: null, location: null,
  nationality: null, age: null, gender: null, currentEmployer: null, currentTitle: "Digital Marketing Executive",
  totalExperienceYears: 5, educationDegree: null, educationInstitution: null, qualifications: null,
  englishLevel: null, languages: [], skills: [], industries: [], noticePeriodDays: null, currentSalary: null,
  expectedSalary: null, cvFileName: null, workHistory: [], createdAt: 0, ...over,
} as Candidate);

console.log("\nnationality is estimated, and labelled as an estimate");
eq("a +94 phone and a Sri Lankan school", inferNationality(cand({ phone: "+94 77 123 4567", educationInstitution: "University of Colombo" }))?.value, "Sri Lankan");
eq("two agreeing clues are high confidence", inferNationality(cand({ phone: "+94 77 123 4567", educationInstitution: "University of Colombo" }))?.confidence, "high");
eq("a local 07 mobile number counts", inferNationality(cand({ phone: "0771234567" }))?.value, "Sri Lankan");
eq("a Bangladeshi number", inferNationality(cand({ phone: "+880 1711 000000" }))?.value, "Bangladeshi");
eq("a stated nationality wins", inferNationality(cand({ nationality: "Indian", phone: "+94 77 123 4567" }))?.basis, "stated");
eq("no clues, no guess", inferNationality(cand()), null);
eq("working in Dubai now does not make someone Emirati when the rest says Sri Lanka",
  inferNationality(cand({ phone: "+94 77 123 4567", location: "Dubai", educationInstitution: "University of Moratuwa" }))?.value, "Sri Lankan");

console.log("\nfield and industry are kept apart");
const marketer = cand({
  workHistory: [
    { title: "Digital Marketing Executive", employer: "MAS Holdings", fromYear: 2021, toYear: null },
    { title: "Digital Marketing Assistant", employer: "Maliban Biscuits", fromYear: 2019, toYear: 2021 },
  ],
});
const worked = industryExperience(marketer, 2026);
eq("a digital marketer at MAS has apparel experience", worked[0].industry, "Apparel & Textile");
eq("with years", worked[0].years, 5);
eq("and FMCG before it", worked[1].industry, "FMCG & Food");
eq("a merchandiser at a holding company is apparel by title", industryOf("XYZ Holdings", "Senior Merchandiser"), "Apparel & Textile");
eq("an employer name wins over a generic title", industryOf("Hemas Pharmaceuticals", "Accountant"), "Healthcare & Pharma");

console.log("\nwhat a JD asks for");
eq("apparel industry experience is essential", industryWanted("Must have 3+ years of experience in the apparel industry.", null), { industry: "Apparel & Textile", required: true });
eq("FMCG exposure preferred", industryWanted("FMCG industry exposure is preferred.", null), { industry: "FMCG & Food", required: false });
eq("a JD that names no industry", industryWanted("Manage the team and report monthly.", null), null);

const job = requirementsFromOpening({
  title: "Digital Marketing Executive",
  jdMarkdown: "- Digital marketing\n- Must have 3+ years of experience in the apparel industry",
  locations: [], targetNationalities: [], industry: "Apparel", knownSkills: ["Digital marketing"],
});
eq("the JD's industry is required", [job.industries, job.industryRequired], [["Apparel & Textile"], true]);
const fmcgOnly = cand({ workHistory: [{ title: "Digital Marketing Executive", employer: "Maliban Biscuits", fromYear: 2019, toYear: null }] });
const a = scoreCandidate(marketer, job).overall;
const b = scoreCandidate(fmcgOnly, job).overall;
eq("the same field with apparel experience ranks above without it", a > b, true);
eq("without it is marked down but still shown", b > 0, true);

console.log("\nqualifications are read from the CV text");
const acca = requirementsFromOpening({ title: "Finance Manager", jdMarkdown: "## Requirements\n- ACCA qualified\n- IFRS", locations: [], targetNationalities: [], industry: null, knownSkills: ["IFRS"] });
const fm = cand({ currentTitle: "Finance Manager" });
const noText = scoreCandidate(fm, acca);
const withText = scoreCandidate(fm, acca, { cvText: "PROFESSIONAL QUALIFICATIONS\nACCA member since 2019\nIFRS reporting for a group of companies" });
eq("without the CV text, ACCA looks missing", noText.penalties.some((p) => /ACCA/.test(p.label)), true);
eq("with it, nobody is marked missing ACCA", withText.penalties.some((p) => /ACCA/.test(p.label)), false);
eq("and IFRS in the CV counts as the skill", withText.breakdown.skills > noText.breakdown.skills, true);

console.log("\nplain-text JDs are read");
const plain = `POSITION - MANAGER – PROCUREMENT

KEY RESPONSIBILITIES
Manage the end-to-end procurement cycle

CANDIDATE PROFILE
Degree in Supply Chain Management or related field
Minimum 8 years of procurement experience in manufacturing
CIPS qualified`;
eq("lines under headings become bullets", asBullets(plain).includes("- Minimum 8 years of procurement experience in manufacturing"), true);
eq("capitals lines become headings", asBullets(plain).includes("## CANDIDATE PROFILE"), true);
const r = requirementsFromOpening({ title: "Procurement Manager", jdMarkdown: plain, locations: [], targetNationalities: [], industry: null, knownSkills: [] });
eq("years are found", r.minYears, 8);
eq("the named qualification is found", r.requiredQualifications.includes("CIPS"), true);
eq("a JD that already has bullets is left alone", asBullets("- SQL\n**Desirable:**\n- Python"), "- SQL\n**Desirable:**\n- Python");

console.log("\nthe title's work words");
{
  const { coreTermsOf } = await import("@/lib/scoring");
  eq("Senior Pricing Manager is about pricing", coreTermsOf("Senior Pricing Manager"), ["pric"]);
  eq("rank and filler words are dropped", coreTermsOf("Divisional Merchandise Manager from Apparel Manufacturing Industry"), ["merchandis", "apparel", "manufactur"]);
  const pricing = requirementsFromOpening({ title: "Senior Pricing Manager", jdMarkdown: "- Pricing strategy", locations: [], targetNationalities: [], industry: null, knownSkills: [] });
  const salesHead = cand({ currentTitle: "Head of Sales", workHistory: [{ title: "Area Sales Manager", employer: "Maliban", fromYear: 2015, toYear: null }] });
  const pricer = cand({ currentTitle: "Pricing Analyst", workHistory: [{ title: "Pricing Analyst", employer: "PickMe", fromYear: 2018, toYear: null }] });
  eq("someone doing the work ranks well above someone who is not", scoreCandidate(pricer, pricing).overall - scoreCandidate(salesHead, pricing).overall >= 20, true);
  const proc = requirementsFromOpening({ title: "Procurement Manager", jdMarkdown: "- Sourcing", locations: [], targetNationalities: [], industry: null, knownSkills: [] });
  eq("a purchasing manager counts for procurement", scoreCandidate(cand({ currentTitle: "Purchasing Manager" }), proc).penalties.some((p) => /Nothing in their roles/.test(p.label)), false);
}

console.log("\nlevel and discipline");
{
  const exec = requirementsFromOpening({ title: "Marketing Executive", jdMarkdown: "- Brand management", locations: [], targetNationalities: [], industry: null, knownSkills: [] });
  const head = scoreCandidate(cand({ currentTitle: "Head of Marketing" }), exec);
  const abm = scoreCandidate(cand({ currentTitle: "Assistant Brand Manager" }), exec);
  eq("a head of marketing is marked well above an executive role", head.penalties.some((p) => /Well above/.test(p.label)), true);
  eq("an assistant brand manager is not", abm.penalties.some((p) => /Well above/.test(p.label)), false);
  const both = requirementsFromOpening({ title: "Senior Executive/ Assistant Accountant", jdMarkdown: "- GL", locations: [], targetNationalities: [], industry: null, knownSkills: [] });
  eq("a title open to two levels takes the higher", both.seniority, "senior");
  const plant = requirementsFromOpening({ title: "Head of Engineering", jdMarkdown: "- Maintenance", locations: [], targetNationalities: [], industry: null, knownSkills: [] });
  eq("a software head is not a plant head", scoreCandidate(cand({ currentTitle: "Head of Software Engineering" }), plant).penalties.some((p) => /software role/.test(p.label)), true);
  eq("a plant engineering manager is", scoreCandidate(cand({ currentTitle: "Engineering Manager" }), plant).penalties.some((p) => /software role/.test(p.label)), false);
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
