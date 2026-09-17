import { booleanScore, booleanTerms } from "@/lib/booleanScore";
import type { Candidate } from "@/data/types";

let pass = 0, fail = 0;
const eq = (l: string, got: unknown, want: unknown) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  ok ? pass++ : fail++;
  console.log(`${ok ? "  ok  " : "  FAIL"} ${l}${ok ? "" : `  got ${JSON.stringify(got)} want ${JSON.stringify(want)}`}`);
};

const cand = (over: Partial<Candidate>): Candidate => ({
  fullName: "A B", currentTitle: "", currentEmployer: "", location: "Colombo", nationality: "", educationDegree: "",
  educationInstitution: "", qualifications: "", skills: [], industries: [], languages: [], workHistory: [], ...over,
} as unknown as Candidate);

eq("terms skip NOT and repeat", booleanTerms('"sales manager" AND (fmcg OR retail) NOT intern AND fmcg'), ["sales manager", "fmcg", "retail"]);
const terms = booleanTerms('"sales manager" AND fmcg');
const title = booleanScore(terms, cand({ currentTitle: "Sales Manager", industries: ["FMCG"] }));
const skill = booleanScore(terms, cand({ currentTitle: "Executive", skills: ["sales manager training"], industries: ["FMCG"] }));
const half = booleanScore(terms, cand({ currentTitle: "Sales Manager" }));
eq("title and industry", title?.overall, 85);
eq("title outranks skills", (title?.overall ?? 0) > (skill?.overall ?? 0), true);
eq("half the terms", half?.overall, 50);
eq("band from the number", [title?.band, half?.band], ["strong", "weak"]);
eq("no terms, no score", booleanScore([], cand({})), null);

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
