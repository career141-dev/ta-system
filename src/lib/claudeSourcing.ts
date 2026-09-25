import type { ProfileSuggestion } from "@/data/types";
import { claudeSearchEnabled, jsonArrayIn, readStream, runClaude } from "./claudeSub";
import { canonicalProfile, displayUrl } from "./serper";
import type { SourcingRun, SourcingSpec } from "./sourcing";

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
const TIMEOUT_MS = 8 * 60_000;
export const CLAUDE_MAX_PEOPLE = 20;

export function claudeSourcingOn(): boolean {
  return claudeSearchEnabled();
}

export function headhuntPrompt(s: SourcingSpec, market: string): string {
  const client = s.clientName;
  return `You are a headhunter at Career141, a recruitment firm in Sri Lanka that places candidates across Sri Lanka, South Asia and the Gulf.

Find real people on LinkedIn we can approach for this job.

THE JOB
Position: ${s.title}
Client: ${client}
Location: ${s.locations.join(", ") || market}
Market: ${market}
Nationalities the client wants: ${s.targetNationalities.join(", ") || "any"}
Package: ${s.salaryNote || "not given"}${s.targetEmployers.length ? `\nCompanies the recruiter wants searched first: ${s.targetEmployers.join("; ")}` : ""}
Job description:
"""
${s.jdText.slice(0, 6000)}
"""

How to work
1. Read the job description and work out the must-haves: the type of work, the years of experience, the industry and the level.
2. Use the WebSearch tool to find LinkedIn profiles of people doing this work now in ${market}. Search the way a headhunter would: site:linkedin.com/in with the job titles people really use (one level below and above too), the key skills, and the companies where such people work — the client's competitors and similar firms. Run at least 6 different searches, with different titles and companies.
3. Judge every person the searches return against the must-haves, from what the search result shows: their current title, company, location and anything else it says.
4. Keep only people who plausibly fit. Leave out people who are clearly too junior, too senior, in the wrong field, or outside ${market}, unless the nationalities the client wants mean they should be included.

Rules
- Only people whose LinkedIn profile link appeared in your search results. Never write a link yourself and never make up a person.
- Only personal profiles (linkedin.com/in/...), not company pages or job posts.
- Never suggest anyone who works at ${client} now. They are our client.
- Say honestly what you could not see: if their years of experience or their exact work are not shown, say so in the concern.
- Plain English and factual.

Answer with JSON only, no other text, best fit first, up to ${CLAUDE_MAX_PEOPLE} people:
[
  {"name": "", "link": "the linkedin.com/in link exactly as the search returned it", "headline": "their current job title", "company": "their current company", "location": "", "fit": "strong or possible", "why": "why they fit this job, from what the search showed", "concern": "what does not fit or could not be seen; empty if nothing"}
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
  return {
    suggestions,
    plan: null,
    queries: [],
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
