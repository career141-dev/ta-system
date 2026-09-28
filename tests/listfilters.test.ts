/**
 * The filter rail on Database CVs, the LinkedIn job and the pipeline
 * (lib/listFilters): each field finds what a TA types, and nothing else.
 */
import { passesFilters } from "@/lib/listFilters";

let pass = 0, fail = 0;
const eq = (l: string, got: unknown, want: unknown) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  ok ? pass++ : fail++;
  console.log(`${ok ? "  ok  " : "  FAIL"} ${l}${ok ? "" : `  got ${JSON.stringify(got)} want ${JSON.stringify(want)}`}`);
};

const person = (over: Record<string, unknown>) =>
  ({
    location: "Colombo 03, Sri Lanka",
    currentEmployer: "Cargills (Ceylon) PLC",
    currentTitle: "Senior Brand Manager",
    educationInstitution: "University of Colombo",
    nationality: "Sri Lankan",
    totalExperienceYears: 7,
    noticePeriodDays: 30,
    skills: ["Brand Management", "JavaScript", "SAP FICO"],
    industries: ["FMCG"],
    workHistory: [{ employer: "Unilever Sri Lanka" }, { employer: "John Keells Holdings" }],
    ...over,
  }) as never;
const p = person({});
const passes = (f: Record<string, string>, c = p) => passesFilters(c, f);

console.log("\nlocation");
eq("a city finds a fuller address", passes({ location: "Colombo" }), true);
eq("any case", passes({ location: "colombo" }), true);
eq("the country too", passes({ location: "sri lanka" }), true);
eq("another city does not", passes({ location: "Kandy" }), false);
eq("part of a word does not", passes({ location: "lomb" }), false);

console.log("\nexperience and notice");
eq("7 years passes 5+", passes({ minExp: "5" }), true);
eq("7 years fails 10+", passes({ minExp: "10" }), false);
eq("7 years fails up to 3", passes({ maxExp: "3" }), false);
eq("unknown years is not 'up to 3'", passes({ maxExp: "3" }, person({ totalExperienceYears: null })), false);
eq("unknown years is not '5+'", passes({ minExp: "5" }, person({ totalExperienceYears: null })), false);
eq("30 days passes 30 or less", passes({ maxNotice: "30" }), true);
eq("unknown notice is not '30 or less'", passes({ maxNotice: "30" }, person({ noticePeriodDays: null })), false);

console.log("\ncompanies, titles, schools");
eq("a short company name", passes({ company: "cargills" }), true);
eq("past companies read the work history", passes({ past: "john keells" }), true);
eq("a company they never worked at", passes({ past: "Dialog" }), false);
eq("title words in any order", passes({ title: "brand manager" }), true);
eq("school", passes({ school: "colombo" }), true);

console.log("\nskills and industries are whole terms");
eq("Brand Management", passes({ skill: "brand management" }), true);
eq("Java is not JavaScript", passes({ skill: "java" }), false);
eq("JavaScript", passes({ skill: "javascript" }), true);
eq("SAP inside 'SAP FICO'", passes({ skill: "sap" }), true);
eq("FMCG", passes({ industry: "fmcg" }), true);
eq("Banking", passes({ industry: "banking" }), false);

console.log("\nseveral at once");
eq("all must hold", passes({ location: "colombo", minExp: "5", skill: "javascript", company: "cargills" }), true);
eq("one failing hides them", passes({ location: "colombo", minExp: "5", skill: "python" }), false);
eq("no filters shows everyone", passes({}), true);

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
