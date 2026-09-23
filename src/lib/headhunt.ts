import { research as askWithSearch, write, type AiResult, type Source } from "./ai";
import type { BenchmarkEntry, Citation, ResearchFields } from "@/data/types";

/**
 * The prompts, and the parsing of what comes back — spec §8A.
 *
 * Two things are enforced here rather than hoped for:
 *
 *   **A row with no source is dropped.** The model is told to omit anything it
 *   cannot cite, and then the parser removes uncited rows anyway. Instructions
 *   are not a guarantee; the filter is.
 *
 *   **Confidence is carried, not flattened.** A benchmark that says "probably
 *   the incumbent, one source, two years old" is useful. The same claim stated
 *   flatly is a liability the moment a client checks it.
 */

export interface OpeningContext {
  title: string;
  clientName: string;
  industry: string;
  locations: string[];
  packageNotes: string;
  mustHaves: string[];
  /** Whose passport the client wants, as set when the opening was created. */
  nationalities?: string[];
  /** Only where the client specified it. */
  gender?: string | null;
}

/** One person's details about the role — the lead's brief, or a TA's notes. */
export interface JdBrief {
  author: string;
  role: "lead" | "ta";
  notes: string;
}

const HOUSE_RULES = `You are supporting a recruitment desk at Career141, a Sri Lankan talent acquisition firm.

Absolute rules:
- Never state a fact about a company or a named person that you did not find in a search result. If you could not find it, say so plainly.
- Never invent a person's name, job title, employer or LinkedIn URL. A plausible-sounding invention is the worst possible output here — it gets a recruiter on the phone to someone who does not exist.
- Prefer recent sources. Say when something is dated.
- Sri Lankan context by default. "Colombo" means Colombo, Sri Lanka.
- Write plainly for a busy recruiter. No filler, no hype, no restating the question.`;

function ctxLines(c: OpeningContext): string {
  return [
    `Role: ${c.title}`,
    `Client: ${c.clientName}${c.industry ? ` (${c.industry})` : ""}`,
    c.locations.length ? `Location: ${c.locations.join(", ")}` : null,
    c.nationalities?.length ? `Hiring: ${c.nationalities.join(", ")} nationals` : null,
    c.gender ? `Gender (as the client specified): ${c.gender}` : null,
    c.packageNotes ? `Package: ${c.packageNotes}` : null,
    c.mustHaves.length ? `Requirements: ${c.mustHaves.join("; ")}` : null,
  ]
    .filter(Boolean)
    .join("\n");
}

/**
 * One Research run each — 23 September, at the desk's request.
 *
 * Research is the expensive button on the desk: a run is about thirty web
 * searches and a model pass over everything they returned. So each person on an
 * opening may run it once; a TA lead has their own run, not an exemption.
 *
 * The runs are kept on the report itself, appended as they happen, which means
 * a run only counts when it produced something: a search that was refused
 * saves no report and costs nobody their turn.
 */
export interface ResearchRun {
  userId: string;
  at: number;
}

/** When this person ran Research on this opening, or null if they have not. */
export function researchRunBy(runs: ResearchRun[] | undefined, userId: string): number | null {
  return runs?.find((r) => r.userId === userId)?.at ?? null;
}

/** The run log with this person's run added. Their first run is the one kept. */
export function withResearchRun(runs: ResearchRun[] | undefined, userId: string, at: number): ResearchRun[] {
  const kept = runs ?? [];
  return researchRunBy(kept, userId) === null ? [...kept, { userId, at }] : kept;
}

export function toCitations(sources: Source[]): Citation[] {
  return sources.map((s) => ({ url: s.url, title: s.title, quote: s.quote }));
}

// ─── Research ────────────────────────────────────────────────────────────────

export async function generateResearch(c: OpeningContext): Promise<AiResult> {
  return askWithSearch(
    HOUSE_RULES,
    `Research ${c.clientName} for a recruitment assignment.

${ctxLines(c)}

Return ONLY these labelled lines, in this order, nothing else:

SIMILAR_DESIGNATION: the titles this same job carries at other companies, semicolon separated.
WEBSITE: the company's own website URL.
SERVICES: what they actually do — 3-6 short items, semicolon separated.
COUNTRY: the country they operate from.
LOCATION: the city or area of their head office.
COMPETITORS: 4-8 named companies competing with them, semicolon separated.
SOCIAL: their LinkedIn company page URL.
OVERVIEW: two short paragraphs — what the business is, its size and structure, who leads it, and anything from the last 18 months that affects hiring.

Rules:
- Leave a line's value EMPTY if you could not source it. An empty field is a fact; a guess is a liability.
- Never pad OVERVIEW with general industry knowledge to fill space.
- Name only companies and people you actually found.`,
    3500,
    10,
  );
}

/** The labelled lines back into fields. Anything unsourced simply stays empty. */
export function parseResearch(raw: string): ResearchFields {
  // Models dress the labels up — "**WEBSITE:**", "- WEBSITE:", "### OVERVIEW" —
  // and a strict "^WEBSITE:" then read every field as not found although the
  // answer was there (21 Sep). The decoration is taken off each label first.
  const LABELS = "SIMILAR_DESIGNATION|WEBSITE|SERVICES|COUNTRY|LOCATION|COMPETITORS|SOCIAL|OVERVIEW";
  const text = raw
    .split("\n")
    // "### Overview" as a heading of its own, with the text below it.
    .map((line) => line.replace(new RegExp(`^\\s*#+\\s*\\**\\s*(${LABELS})\\s*\\**\\s*$`, "i"), (_m, l: string) => `${l.toUpperCase()}:`))
    .map((line) =>
      line.replace(
        new RegExp(`^[\\s>*#\\-•\\d.)]*\\**\\s*(${LABELS})\\s*\\**\\s*[:：]\\s*\\**\\s*`, "i"),
        (_m, label: string) => `${label.toUpperCase()}:`,
      ),
    )
    .join("\n")
    // "[site](https://x.com)" → "https://x.com"
    .replace(/\[([^\]]*)\]\((https?:[^)\s]+)\)/g, "$2");
  const get = (label: string) => {
    const m = text.match(new RegExp(`^${label}:(.*)$`, "im"));
    return (m?.[1] ?? "").trim();
  };
  const list = (label: string) =>
    get(label).split(";").map((x) => x.trim()).filter((x) => x.length > 1);
  const overviewMatch = text.match(/^OVERVIEW:([\s\S]*)$/im);
  return {
    similarDesignation: get("SIMILAR_DESIGNATION"),
    websiteLink: get("WEBSITE"),
    servicesProvider: list("SERVICES"),
    country: get("COUNTRY"),
    location: get("LOCATION"),
    competitors: list("COMPETITORS"),
    socialMedia: get("SOCIAL"),
    companyOverview: (overviewMatch?.[1] ?? "").trim(),
  };
}

// ─── Benchmarking ────────────────────────────────────────────────────────────

const BENCH_FORMAT = `Return ONLY lines in this exact pipe-delimited format, one per line, no heading, no commentary:

KIND | NAME | TITLE | COMPANY | LINKEDIN_URL | CONFIDENCE | NOTE

- KIND is incumbent, predecessor or competitor.
- NAME is the person's real name, or the word UNKNOWN if you found the role but not the person.
- LINKEDIN_URL is their actual profile URL, or UNKNOWN. Never guess a URL pattern.
- CONFIDENCE is high, medium or low — how certain the sourcing makes you.
- NOTE is one short clause: how current it is, or what is uncertain.
- Omit any row you cannot support from a search result. Six well-sourced rows beat fifteen guesses.`;

export async function generateBenchmark(c: OpeningContext): Promise<AiResult> {
  return askWithSearch(
    HOUSE_RULES,
    `Benchmark the role of ${c.title} at ${c.clientName}.

${ctxLines(c)}

Find:
1. Who currently holds this role, or the closest equivalent, at ${c.clientName}.
2. Who held it before them, if that is on the record.
3. Who holds the equivalent role at competing companies in Sri Lanka.

${BENCH_FORMAT}`,
    2500,
    10,
  );
}

export function parseBenchmark(text: string, openingId: string, sources: Source[]): Omit<BenchmarkEntry, "id">[] {
  const byHost = new Map<string, Source>();
  for (const s of sources) {
    try {
      byHost.set(new URL(s.url).hostname.replace(/^www\./, ""), s);
    } catch {
      /* a malformed URL is simply not a usable source */
    }
  }
  const now = Date.now();
  const out: Omit<BenchmarkEntry, "id">[] = [];

  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line.includes("|")) continue;
    const parts = line.split("|").map((p) => p.trim());
    if (parts.length < 6) continue;
    const [kindRaw, nameRaw, title, company, urlRaw, confRaw, ...noteParts] = parts;
    const kind = kindRaw.toLowerCase();
    if (!["incumbent", "predecessor", "competitor"].includes(kind)) continue;
    if (!title || !company || /^unknown$/i.test(company)) continue;

    const name = /^unknown$/i.test(nameRaw) || !nameRaw ? null : nameRaw;
    const linkedinUrl = /^https?:\/\/[^\s]*linkedin\.com/i.test(urlRaw) ? urlRaw : null;
    const conf = ["high", "medium", "low"].includes(confRaw.toLowerCase())
      ? (confRaw.toLowerCase() as BenchmarkEntry["confidence"])
      : "low";

    // A named individual with nothing behind it is exactly the output that gets
    // a TA calling a person who does not hold the job. Unsourced rows go.
    const src = sources.find((s) => s.url === urlRaw) ?? [...byHost.values()][0] ?? null;
    if (name && !src) continue;

    out.push({
      openingId,
      name,
      title,
      company,
      linkedinUrl,
      kind: kind as BenchmarkEntry["kind"],
      confidence: conf,
      note: noteParts.join(" | ").trim(),
      sourceUrl: src?.url ?? null,
      sourceTitle: src?.title ?? null,
      isSelected: false,
      generatedAt: now,
    });
  }
  return out;
}

// ─── Suggestions ─────────────────────────────────────────────────────────────

/**
 * Suggestions used to ask a model for profiles, and the model produced URLs.
 * That was replaced by `sourcing.ts`, where Serper finds the people and the
 * model only ever filters a list it was handed — see spec §8A.2. Removed rather
 * than kept alongside, because two ways to do it is how the unsafe one survives.
 */

// ─── The JD ──────────────────────────────────────────────────────────────────

export async function generateJdText(
  c: OpeningContext,
  briefs: JdBrief[],
  houseTemplate: string,
  currentJd = "",
): Promise<AiResult> {
  const given = briefs.filter((b) => b.notes.trim());
  const sections = given.length
    ? given
        .map((b) => `${b.role === "lead" ? "The TA lead's brief" : "The TA's notes"} (${b.author}):\n"""\n${b.notes.trim()}\n"""`)
        .join("\n\n")
    : "(no notes were left — work from the opening details above only)";
  return write(
    `${HOUSE_RULES}

You are writing a job description that goes out under Career141's name to candidates in Sri Lanka.`,
    `Write the full job description for this role.

The opening, as it was set up:
${ctxLines(c)}

${sections}
${currentJd.trim() ? `\nThe job description on file now — keep everything in it that still holds, and improve the rest:\n"""\n${currentJd.trim().slice(0, 6000)}\n"""\n` : ""}
The desk's own short template for this role, for the facts it carries:
"""
${houseTemplate}
"""

Write it in Markdown under these headings, in this order, and leave out only a heading you truly have nothing for:

## <role title>
**Client** · **Location** · **Package** · **Nationality** · **Headcount** — one line each, only where known.
### About the role — two or three sentences: what the job is and where it sits.
### Responsibilities — 5 to 8 bullets.
### Requirements — the must-haves: years, industry, background.
### Qualifications — degrees, professional qualifications.
### Skills — the skills the role is worked with, as bullets.
### Experience — how many years of what.
### Package — salary, allowances and benefits.
### Other — anything left: notice period, travel, shift, reporting line, headcount.

Two kinds of thing go in it, and they are not treated the same:

FACTS about this role and this client — salary, allowances, benefits, location, nationality, headcount, notice period, the client's name and industry, must-haves, anything the notes say. Only from the material above. Never invent one, and never write filler like "competitive salary" or "attractive benefits". A fact nobody gave you is left out, and its line with it.

THE ORDINARY WORK of the job titled "${c.title}" — responsibilities, the skills it is done with, the usual qualifications. A short note ("we need a finance manager, 10 years, CIMA") is a brief, not a job description: write out what this role does day to day, the way a recruiter who has filled it would, and keep it recognisable for Sri Lanka. Never contradict the notes, and never dress an assumption up as the client's requirement — anything essential comes from the notes.

Rules:
- Use everything above together. Nothing the lead or the TA wrote is dropped.
- Where they disagree, follow the TA's notes — written later, usually after speaking to the client again.
- No hype, no marketing. A Sri Lankan candidate reading this should learn what the job is and whether they qualify.
- Plain Markdown. No preamble, no closing note, no "here is the job description".`,
    2500,
  );
}
