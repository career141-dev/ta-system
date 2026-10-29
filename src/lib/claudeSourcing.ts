import type { ProfileSuggestion } from "@/data/types";
import { claudeSearchEnabled, jsonArrayIn, readStream, runClaude } from "./claudeSub";
import { canonicalProfile, displayUrl } from "./serper";
import { aboutClient, type SourcingRun, type SourcingSpec } from "./sourcing";

/**
 * Suggestions by Claude — 24 Sep, at the owner's request: "I need people based
 * on the JD, accurate people from Claude."
 *
 * One Claude run does the headhunter's work: reads the JD, works out the
 * must-haves, runs its own LinkedIn X-ray searches (several titles, several
 * companies), and judges every person the searches return. It replaces about
 * fifty fixed searches and three model passes, and it is what a recruiter
 * would do by hand.
 *
 * What it can see is what a search result shows about a person — their
 * headline, current company, location — not their whole profile: nobody is
 * signed in to LinkedIn on the server, and nobody should be. So a "strong" fit
 * is strong on that evidence, and the concern says what could not be seen.
 *
 * Nobody is named who was not in a search result: a person is kept only when
 * their profile address is one the WebSearch tool returned. When Claude
 * cannot answer, the run carries on the old way (runSourcing).
 */
// A second search per person to check them (28 Oct) takes longer than the
// first sweep alone did.
const TIMEOUT_MS = 12 * 60_000;
/**
 * Few and right (28 Oct): TAs said the people suggested did not fit — a
 * procurement head with 28 years for a shipping executive role, because her
 * headline said "Supply Chain & Logistics". Eight people who pass every check
 * are worth more than twenty to re-screen.
 */
export const CLAUDE_MAX_PEOPLE = 8;

export function claudeSourcingOn(): boolean {
  return claudeSearchEnabled();
}

/**
 * What the desk has shown it wants (28 Oct), with nothing asked of the TAs:
 * the people they moved on to TA Follow-up, the suggestions they selected and
 * the ones they turned down. Their choices are the brief the JD could not be.
 */
export function deskSignals(s: Pick<SourcingSpec, "picked" | "selected" | "notSelected">): string {
  const list = (xs: string[] | undefined) => (xs ?? []).map((x) => `- ${x}`).join("\n");
  return [
    s.picked?.length ? `\n\nPEOPLE THE RECRUITERS PICKED for this job (from their CVs). Find people like them — the same kind of work, level and years — and search their employers:\n${list(s.picked)}` : "",
    s.selected?.length ? `\n\nSuggestions the recruiters SELECTED. More like these:\n${list(s.selected)}` : "",
    s.notSelected?.length ? `\n\nSuggestions the recruiters TURNED DOWN. Work out what they have in common (level, years, function, industry) and suggest nobody like them:\n${list(s.notSelected)}` : "",
  ].join("");
}

export function headhuntPrompt(s: SourcingSpec, market: string): string {
  const client = s.clientName;
  return `You are a headhunter at Career141, a recruitment firm in Sri Lanka that places candidates across Sri Lanka, South Asia and the Gulf.

Find real people on LinkedIn we can approach for this job.

THE JOB
Position: ${s.title}
Client: ${client}${aboutClient(s)}
Location: ${s.locations.join(", ") || market}
Market: ${market}
Nationalities the client wants: ${s.targetNationalities.join(", ") || "any"}
Package: ${s.salaryNote || "not given"}${s.targetEmployers.length ? `\nCompanies the recruiter wants searched first: ${s.targetEmployers.join("; ")}` : ""}
Job description:
"""
${s.jdText.slice(0, 6000)}
"""

How to work
1. Read the job description and write down five must-haves for yourself:
   FUNCTION — the work itself (for example shipping and freight operations; procurement or general supply chain is a different function);
   LEVEL — the job's level, with one rung below and one above allowed;
   YEARS — the experience range the job states;
   INDUSTRY — the sector the job asks for;
   LOCATION — where they must be.
2. Use the WebSearch tool to find LinkedIn profiles of people doing this work now in ${market}. Search the way a headhunter would: site:linkedin.com/in with the job titles people really use (one level below and above too), the key skills, and the companies where such people work — the client's competitors and similar firms. Run at least 8 different searches, with different titles and companies.
3. For every person who looks promising, run ONE more search on their name and company to check them: their real years, what they actually do, their level. A headline can mislead — "Supply Chain & Logistics Manager" may be a procurement head with 28 years.
4. Keep a person only when the search results show they pass ALL five must-haves. Unknown is not a pass: if a must-have cannot be seen, leave them out. Fewer people is fine.${deskSignals(s)}

Rules
- Only people whose LinkedIn profile link appeared in your search results. Never write a link yourself and never make up a person.
- Only personal profiles (linkedin.com/in/...), not company pages or job posts.
- Never suggest anyone who works at ${client} now. They are our client.
- "why" shows the proof, one tick per must-have, from what the searches showed: "✓ Function: … ✓ Level: … ✓ Years: … ✓ Industry: … ✓ Location: …".
- Plain English and factual.

Answer with JSON only, no other text, best fit first, up to ${CLAUDE_MAX_PEOPLE} people:
[
  {"name": "", "link": "the linkedin.com/in link exactly as the search returned it", "headline": "their current job title", "company": "their current company", "location": "", "years": "their years of experience, a number, or null", "level": "far_below, below, match, above or far_above against the job", "sameFunction": "true only when their work is the job's function", "fit": "strong or possible", "why": "the five ticks with the proof", "concern": "anything a recruiter should still check; empty if nothing"}
]`;
}

const words = (s: string) =>
  s
    .toLowerCase()
    .replace(/\b(plc|ltd|limited|pvt|private|company|group|holdings|inc|the)\b/g, " ")
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length > 2);

/**
 * Claude's answer, kept only where it is grounded. Pure, so the rules are
 * testable: a link the searches did not return, a company page, someone
 * already in the vault, or someone at the client is dropped.
 */
export function readHeadhunt(stream: string, s: SourcingSpec, round: number, now = Date.now()): SourcingRun {
  const empty: SourcingRun = { suggestions: [], plan: null, queries: [], credits: 0, scanned: 0, cost: 0 };
  const { final, found } = readStream(stream);
  if (!final) return { ...empty, error: "claude_no_answer" };
  if (final.is_error || (final.subtype && final.subtype !== "success")) {
    return { ...empty, error: "claude_failed", note: (final.result ?? "").slice(0, 200) };
  }

  // Every profile the searches returned, by its canonical address.
  const returned = new Map<string, string>();
  for (const url of found.keys()) {
    const key = canonicalProfile(url);
    if (key && !returned.has(key)) returned.set(key, url);
  }
  const known = new Set(s.alreadyKnown);
  const client = new Set(s.clientCompanyNames.flatMap(words));
  const atClient = (company: string) => {
    const w = words(company);
    return w.length > 0 && client.size > 0 && w.every((x) => client.has(x));
  };

  const suggestions: Omit<ProfileSuggestion, "id">[] = [];
  const seen = new Set<string>();
  let rejected = 0;
  for (const p of jsonArrayIn(final.result ?? "")) {
    const text = (k: string) => (typeof p[k] === "string" ? (p[k] as string).trim() : "");
    const key = canonicalProfile(text("link"));
    // Named by Claude but never returned by a search: not a finding.
    if (!key || !returned.has(key)) {
      rejected++;
      continue;
    }
    if (known.has(key) || seen.has(key) || atClient(text("company"))) continue;
    // The bar, enforced here and not only asked for (28 Oct): a level far off
    // the job, a different function, or nothing to judge them on is no suggestion.
    const sameFunction = p.sameFunction === true || String(p.sameFunction).toLowerCase() === "true";
    if (/far/i.test(text("level")) || !sameFunction || (!text("headline") && !text("company"))) {
      rejected++;
      continue;
    }
    seen.add(key);
    const title = found.get(returned.get(key)!) ?? "";
    const concern = text("concern");
    suggestions.push({
      openingId: "",
      name: text("name") || title.split(/ [-–|] /)[0],
      headline: text("headline") || title,
      company: text("company") || null,
      location: text("location") || null,
      // Never the model's spelling: the address the search returned.
      linkedinUrl: displayUrl(key),
      tier: text("fit").toLowerCase().startsWith("strong") ? "priority" : "screen",
      why: text("why"),
      concern: concern && !/^(none|n\/a|-)\.?$/i.test(concern) ? concern : null,
      sourceUrl: returned.get(key)!,
      status: "new",
      feedback: null,
      round,
      generatedAt: now,
    });
    if (suggestions.length >= CLAUDE_MAX_PEOPLE) break;
  }
  const searches = Math.max(1, (stream.match(/"name"\s*:\s*"WebSearch"/g) ?? []).length);
  // The searches Claude ran, so the page counts them (it showed "0 searches").
  const queries = [...stream.matchAll(/"name"\s*:\s*"WebSearch"\s*,\s*"input"\s*:\s*\{\s*"query"\s*:\s*"((?:[^"\\]|\\.)*)"/g)].map((m) => m[1]);
  return {
    suggestions,
    plan: null,
    queries,
    credits: searches,
    scanned: returned.size,
    rejected,
    cost: 0,
    note: suggestions.length > 0 && suggestions.length < 6 ? `only_${suggestions.length}_fit` : undefined,
  };
}

export async function claudeHeadhunt(s: SourcingSpec, market: string, round: number): Promise<SourcingRun> {
  const r = await runClaude(
    // The search tool and nothing else, as for every Claude search.
    ["--output-format", "stream-json", "--verbose", "--tools", "WebSearch", "--allowedTools", "WebSearch"],
    headhuntPrompt(s, market),
    TIMEOUT_MS,
  );
  if (r.timedOut) return { suggestions: [], plan: null, queries: [], credits: 0, scanned: 0, cost: 0, error: "claude_timeout" };
  return readHeadhunt(r.out, s, round);
}
