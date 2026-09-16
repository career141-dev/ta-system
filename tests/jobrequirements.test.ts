import {
  mapEducation, mapIndustry, mapSeniority, mergeRequirements, parseSalaryRange, splitSkills, valuesFromExtraction,
} from "../convex/lib/jobRequirements";

let pass = 0, fail = 0;
const eq = (l: string, got: unknown, want: unknown) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  ok ? pass++ : fail++;
  console.log(`${ok ? "  ok  " : "  FAIL"} ${l}${ok ? "" : `  got ${JSON.stringify(got)} want ${JSON.stringify(want)}`}`);
};

// ── Salary: the older page stored "200k - 300k LKR" as 200 / 300 / "kkLKR" ──
eq("200k - 300k LKR", parseSalaryRange("200k - 300k LKR"), { min: 200000, max: 300000, currency: "LKR" });
eq("Rs. 250,000 - 350,000", parseSalaryRange("Rs. 250,000 - 350,000"), { min: 250000, max: 350000, currency: "LKR" });
eq("200 - 300k shares the unit", parseSalaryRange("200 - 300k"), { min: 200000, max: 300000, currency: "LKR" });
eq("USD 3,500 to 5,000", parseSalaryRange("USD 3,500 to 5,000"), { min: 3500, max: 5000, currency: "USD" });
eq("AED 12k", parseSalaryRange("AED 12k"), { min: 12000, max: undefined, currency: "AED" });
eq("up to 1.2 million", parseSalaryRange("up to 1.2 million"), { min: undefined, max: 1200000, currency: "LKR" });
eq("2.5 lakhs - 3 lakhs", parseSalaryRange("2.5 lakhs - 3 lakhs"), { min: 250000, max: 300000, currency: "LKR" });
eq("empty", parseSalaryRange(null), { min: undefined, max: undefined, currency: undefined });

// ── Seniority: every value lands inside the schema's enum ───────────────────
eq("senior → senior_executive", mapSeniority("senior"), "senior_executive");
eq("lead → manager", mapSeniority("lead"), "manager");
eq("junior → entry_level", mapSeniority("junior"), "entry_level");
eq("mid → mid_level", mapSeniority("mid"), "mid_level");
eq("Mid-Level label", mapSeniority("Mid-Level"), "mid_level");
eq("Assistant General Manager", mapSeniority("Assistant General Manager"), "agm");
eq("General Manager", mapSeniority("General Manager"), "gm");
eq("Head of Finance → director", mapSeniority("Head of Finance"), "director");
eq("CFO → c_suite", mapSeniority("CFO"), "c_suite");
eq("nonsense → other", mapSeniority("wizard"), "other");
eq("null stays null", mapSeniority(null), null);

// ── Industry and education onto their option lists ──────────────────────────
eq("banking → Finance", mapIndustry("Banking & Financial Services"), "Finance");
eq("software → Technology", mapIndustry("Software development"), "Technology");
eq("garments → Apparel", mapIndustry("garment manufacturing"), "Apparel");
eq("unknown → Other", mapIndustry("Hospitality"), "Other");
eq("BSc degree → bachelor", mapEducation("BSc in Accounting or related degree"), "bachelor");
eq("degree or MBA → bachelor_or_master", mapEducation("Bachelor's degree; MBA preferred"), "bachelor_or_master");
eq("CIMA → professional_cert", mapEducation("CIMA passed finalist"), "professional_cert");

// ── Skills: pasted lists split, trimmed, de-duplicated ──────────────────────
eq("split pasted skills", splitSkills(["Excel, SAP ; excel", "• Power BI"]), ["Excel", "SAP", "Power BI"]);

// ── One extraction → field values ───────────────────────────────────────────
const values = valuesFromExtraction({
  requiredSkills: ["IFRS", "SAP FICO"], preferredSkills: ["Power BI", "ifrs"], minYearsExperience: "5 years",
  maxYearsExperience: 3, industry: "bank", seniority: "senior", location: "Colombo, Sri Lanka",
  education: "CIMA", languages: ["English", "Sinhala"], salaryRange: "300k-400k LKR",
});
eq("values", values, {
  requiredSkills: ["IFRS", "SAP FICO"], niceToHaveSkills: ["Power BI"], seniorityLevel: "senior_executive",
  experienceMinYears: 5, location: "Colombo, Sri Lanka", educationLevel: "professional_cert",
  languagesRequired: ["English", "Sinhala"], salaryMin: 300000, salaryMax: 400000, salaryCurrency: "LKR",
  clientIndustry: "Finance",
});

// ── Merge: keep what a person corrected; fill only blanks and placeholders ──
const current = {
  requiredSkills: [], seniorityLevel: "mid_level", experienceMinYears: 2, location: "Sri Lanka",
  clientIndustry: "Technology", salaryMin: 150000,
};
const fill = mergeRequirements(current, values, { mode: "fill", locked: ["salaryMin"] });
eq("fill replaces placeholders", [fill.requiredSkills, fill.seniorityLevel, fill.experienceMinYears, fill.location],
  [["IFRS", "SAP FICO"], "senior_executive", 5, "Colombo, Sri Lanka"]);
eq("fill keeps a real industry", fill.clientIndustry, undefined);
eq("fill never touches a locked field", fill.salaryMin, undefined);
const replace = mergeRequirements(current, values, { mode: "replace", locked: ["salaryMin"] });
eq("replace overwrites everything the JD speaks to", [replace.salaryMin, replace.clientIndustry], [300000, "Finance"]);

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
