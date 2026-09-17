import type { Candidate } from "@/data/types";
import { FIT_BANDS, type Score } from "@/lib/scoring";
import { parseBoolean, type Node } from "@/lib/query";

/**
 * A score for a Boolean search with no opening to fit against.
 *
 * Every CV a Boolean search returns satisfies the expression, so the list had
 * no number at all and read as unranked (17 September). This scores how well
 * each person carries the words asked for, and where: a term in their job
 * title counts for more than the same term in their skills, and that more than
 * a mention anywhere else on the record. Terms under NOT are not scored.
 */

const PLACE = [
  { part: "Title" as const, weight: 1, label: "title" },
  { part: "Skills" as const, weight: 0.85, label: "skills" },
  { part: "Industry" as const, weight: 0.7, label: "industry or employer" },
  { part: "Experience" as const, weight: 0.5, label: "record" },
];

function positiveTerms(node: Node | null, out: string[] = []): string[] {
  if (!node) return out;
  if (node.t === "term") out.push(node.v);
  else if (node.t === "and" || node.t === "or") node.xs.forEach((x) => positiveTerms(x, out));
  return out;
}

export function booleanTerms(query: string): string[] {
  return [...new Set(positiveTerms(parseBoolean(query).node).map((t) => t.toLowerCase().trim()).filter(Boolean))];
}

export function booleanScore(terms: string[], c: Candidate): Score | null {
  if (terms.length === 0) return null;
  const titles = [c.currentTitle, ...c.workHistory.map((w) => w.title)].filter(Boolean).join(" ").toLowerCase();
  const skills = c.skills.join(" ").toLowerCase();
  const trade = [...c.industries, c.currentEmployer, ...c.workHistory.map((w) => w.employer), c.qualifications]
    .filter(Boolean).join(" ").toLowerCase();
  const rest = [c.fullName, c.location, c.nationality, c.educationDegree, c.educationInstitution, ...c.languages]
    .filter(Boolean).join(" ").toLowerCase();

  const found: Record<string, string[]> = {};
  let total = 0;
  for (const t of terms) {
    const where = titles.includes(t) ? 0 : skills.includes(t) ? 1 : trade.includes(t) ? 2 : rest.includes(t) ? 3 : -1;
    if (where < 0) continue;
    total += PLACE[where].weight;
    (found[PLACE[where].label] ??= []).push(t);
  }
  const overall = Math.round((total / terms.length) * 100);
  const reasons = Object.entries(found).map(([label, ts]) => `${ts.map((t) => `"${t}"`).join(", ")} in ${label}`);
  const missing = terms.filter((t) => !Object.values(found).some((ts) => ts.includes(t)));
  if (missing.length) reasons.push(`not found: ${missing.map((t) => `"${t}"`).join(", ")}`);

  return {
    overall,
    band: overall >= FIT_BANDS.strong ? "strong" : overall >= FIT_BANDS.worth ? "worth a look" : "weak",
    breakdown: { title: 0, skills: 0, seniority: 0, experience: 0, industry: 0 },
    weights: { title: 0.2, skills: 0.2, seniority: 0.2, experience: 0.2, industry: 0.2 },
    reasons: [`Search terms: ${reasons.join("; ")}.`],
    matchedSkills: found.skills ?? [],
    missingSkills: [],
    penalties: [],
    semanticUsed: false,
    explanation: [],
  };
}
