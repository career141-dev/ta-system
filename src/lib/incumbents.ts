import { canonicalProfile, displayUrl, type SearchHit } from "./serper";
import { searchMatrix } from "./websearch";
import type { AiResult } from "./ai";
import type { BenchmarkEntry } from "@/data/types";

/**
 * Benchmark: who holds this role now — rebuilt 22 Sep at the desk's request.
 *
 * "Find the person currently in that position — at the client and at the
 * competitors. Not for an intern or a small position; for a C-level one, yes.
 * It may be on the company website, or a web search." So, for each company:
 * its own leadership / management / team pages are read, and the web is
 * searched for the title at that company (news, announcements, LinkedIn).
 *
 * The old Benchmark searched LinkedIn only, for anyone with a similar title,
 * and returned fifteen Brand Managers at Nestlé rather than the one person
 * doing the job at the client. It also never opened a company's own site.
 *
 * As everywhere in Research: a name is kept only when it is written in the
 * piece of evidence it is cited from, and a LinkedIn address only ever comes
 * from a search result.
 */

export type Seniority = "c_level" | "senior" | "mid" | "junior";

const C_LEVEL =
  /\b(chief\b[\w\s&,-]{0,40}\bofficer|ceo|cfo|coo|cto|cio|cmo|chro|cpo|cso|ciso|cdo|cxo|managing director|md|president|chair(man|person|woman)?|country (manager|head|director)|general manager|gm)\b/i;
const SENIOR =
  /\b(director|head\b|vp|vice president|avp|deputy general manager|dgm|agm|assistant general manager|senior manager|group manager|partner|principal|controller)\b/i;
const JUNIOR =
  /\b(intern|internship|trainee|apprentice|junior|assistant|executive|associate|officer|coordinator|clerk|analyst|representative|operator|cashier|agent|staff)\b/i;

/** How senior a title reads. C-level first, so "Chief Executive Officer" is not an executive. */
export function seniorityOf(title: string): Seniority {
  if (C_LEVEL.test(title)) return "c_level";
  if (SENIOR.test(title)) return "senior";
  if (JUNIOR.test(title)) return "junior";
  return "mid";
}

/** Benchmark runs by itself for C-level and senior roles only. */
export function benchmarkByDefault(title: string): boolean {
  const s = seniorityOf(title);
  return s === "c_level" || s === "senior";
}

export const SENIORITY_LABEL: Record<Seniority, string> = {
  c_level: "C-level",
  senior: "senior",
  mid: "mid-level",
  junior: "junior",
};

/** Titles written two ways. The search asks for both. */
const SAME_ROLE: [RegExp, string[]][] = [
  [/\b(cfo|chief financial officer)\b/i, ["CFO", "Chief Financial Officer"]],
  [/\b(ceo|chief executive officer)\b/i, ["CEO", "Chief Executive Officer"]],
  [/\b(coo|chief operating officer)\b/i, ["COO", "Chief Operating Officer"]],
  [/\b(cto|chief technology officer)\b/i, ["CTO", "Chief Technology Officer"]],
  [/\b(cio|chief information officer)\b/i, ["CIO", "Chief Information Officer"]],
  [/\b(cmo|chief marketing officer)\b/i, ["CMO", "Chief Marketing Officer"]],
  [/\b(chro|chief (human resources?|people) officer)\b/i, ["CHRO", "Chief Human Resources Officer", "Chief People Officer"]],
  [/\b(md|managing director)\b/i, ["Managing Director", "MD"]],
  [/\b(gm|general manager)\b/i, ["General Manager", "GM"]],
];

export function titleVariants(title: string): string[] {
  const out = [title.trim()];
  for (const [re, names] of SAME_ROLE) if (re.test(title)) out.push(...names);
  return [...new Set(out.filter(Boolean))].slice(0, 4);
}

/** Where companies list their people. A page that is not there is a quick 404. */
const PEOPLE_PAGES = ["/leadership", "/management", "/management-team", "/our-team", "/team", "/board-of-directors"];

export interface IncumbentCompany {
  name: string;
  /** The company's own site, when Research found it. */
  website: string | null;
  isClient: boolean;
}

export interface IncumbentDeps {
  search: (q: string, num?: number) => Promise<{ hits: SearchHit[]; credits: number; error?: string }>;
  readPage: (url: string, maxChars?: number) => Promise<string | null>;
  model: (system: string, prompt: string, maxTokens?: number) => Promise<AiResult>;
}

export type IncumbentRow = Omit<BenchmarkEntry, "id" | "openingId">;

interface Evidence {
  id: string;
  company: string;
  url: string;
  title: string;
  text: string;
}

/** Around every mention of the title, so a leadership page is not sent whole. */
export function aroundMentions(text: string, variants: string[], span = 350): string {
  const lower = text.toLowerCase();
  const windows: [number, number][] = [];
  for (const v of variants) {
    let at = lower.indexOf(v.toLowerCase());
    while (at >= 0 && windows.length < 6) {
      windows.push([Math.max(0, at - span), Math.min(text.length, at + v.length + span)]);
      at = lower.indexOf(v.toLowerCase(), at + v.length);
    }
  }
  windows.sort((a, b) => a[0] - b[0]);
  const merged: [number, number][] = [];
  for (const w of windows) {
    const last = merged[merged.length - 1];
    if (last && w[0] <= last[1]) last[1] = Math.max(last[1], w[1]);
    else merged.push([...w]);
  }
  return merged.map(([a, b]) => text.slice(a, b).trim()).join(" … ");
}

const quoted = (variants: string[]) => (variants.length > 1 ? `(${variants.map((v) => `"${v}"`).join(" OR ")})` : `"${variants[0]}"`);

/**
 * The angles one company is searched from — the scraper's query matrix
 * (SCRAPPER, ported 23 Sep), cut to what benchmarking a single post needs:
 * the title at the company, the person's own profile, and how an appointment
 * is usually written up. The client is the answer the desk actually wants, so
 * it gets the leadership-page angle and the one that turns up a predecessor;
 * competitors get three, because each extra angle is another paid search.
 */
export function benchmarkQueries(c: IncumbentCompany, variants: string[]): string[] {
  const t = quoted(variants);
  const qs = [
    `"${c.name}" ${t}`,
    `site:linkedin.com/in "${c.name}" ${t} -inurl:jobs -inurl:dir`,
    `"${c.name}" ${t} appointed OR named OR "has joined"`,
  ];
  if (c.isClient) {
    qs.push(`"${c.name}" leadership OR "management team" ${t}`);
    qs.push(`"${c.name}" ${t} former OR previously OR succeeded`);
  }
  return qs;
}

/**
 * Everything that could name the person, for one company: its people pages and
 * the angles above, fired together. A page several angles turned up is the
 * likelier answer, so the matrix's hitCount decides what the model reads first
 * — the cross-query verification the scraper ranks candidates by.
 */
async function gather(
  c: IncumbentCompany,
  variants: string[],
  deps: IncumbentDeps,
  count: (credits: number) => void,
): Promise<{ company: string; items: Omit<Evidence, "id">[]; profiles: SearchHit[] }> {
  const queries = benchmarkQueries(c, variants);
  const pages = c.website ? PEOPLE_PAGES.map((p) => `${c.website}${p}`) : [];
  const [matrix, read] = await Promise.all([
    // One person is one piece of evidence: LinkedIn serves the same profile
    // from lk. and www., and both turn up across the angles.
    searchMatrix(queries, deps.search, {
      num: 10,
      key: (u) => canonicalProfile(u) ?? u.replace(/[?#].*$/, "").replace(/\/+$/, "").toLowerCase(),
    }),
    Promise.all(pages.map(async (u) => ({ url: u, text: await deps.readPage(u, 20000) }))),
  ]);
  count(matrix.credits);

  const items: Omit<Evidence, "id">[] = [];
  const seen = new Set<string>();
  for (const p of read) {
    if (!p.text) continue;
    const bit = aroundMentions(p.text, variants);
    if (!bit || seen.has(bit.slice(0, 120))) continue;
    seen.add(bit.slice(0, 120));
    items.push({ company: c.name, url: p.url, title: `${c.name} — ${p.url.replace(/^https?:\/\/[^/]+/, "")}`, text: bit.slice(0, 1500) });
  }
  const hits = matrix.hits;
  for (const h of hits.slice(0, 12)) {
    if (seen.has(h.url)) continue;
    seen.add(h.url);
    // How many angles found it is said out loud, so the model can weigh a page
    // three searches agree on above one that surfaced once.
    const verified = h.hitCount > 1 ? ` (found by ${h.hitCount} searches)` : "";
    items.push({ company: c.name, url: h.url, title: h.title, text: `${h.title}${verified} — ${h.snippet}` });
  }
  return { company: c.name, items, profiles: hits.filter((h) => canonicalProfile(h.url)) };
}

const SYSTEM = `You find who holds a job at named companies, for a recruitment desk at Career141 in Sri Lanka.
You are given numbered evidence: search results and text from the companies' own pages.
Use ONLY that evidence. Never add a name you know from elsewhere. Never write a URL.
A person counts only when the evidence says they hold (or held) this role at that company.
Reply with JSON only.`;

export async function findIncumbents(
  input: { title: string; where: string; companies: IncumbentCompany[] },
  deps: IncumbentDeps,
): Promise<{ rows: IncumbentRow[]; searches: number; modelNote?: string }> {
  const variants = titleVariants(input.title);
  let searches = 0;
  const found = await Promise.all(input.companies.map((c) => gather(c, variants, deps, (n) => (searches += n))));

  const evidence: Evidence[] = [];
  for (const f of found) for (const it of f.items) evidence.push({ ...it, id: `P${evidence.length + 1}` });
  if (evidence.length === 0) return { rows: [], searches };

  const client = input.companies.find((c) => c.isClient)?.name ?? "";
  const r = await deps.model(
    SYSTEM,
    `Role: ${input.title} (also written: ${variants.join(", ")}). Market: ${input.where || "Sri Lanka"}.
Client: ${client}. Competitors: ${input.companies.filter((c) => !c.isClient).map((c) => c.name).join("; ") || "none"}.

Evidence:
${evidence.map((e) => `[${e.id}] (${e.company}) ${e.title} — ${e.url}\n${e.text}`).join("\n\n")}

For each company: who holds this role now — at most two people, the likeliest first. For ${client || "the client"} only, also anyone the evidence says held it before.
Name exactly as written in the evidence. Title as the evidence writes it.
JSON: {"people": [{"company": "", "name": "", "title": "", "status": "current" or "former", "source": "P<n>", "confidence": "high" or "medium" or "low", "note": "under 15 words: what the evidence says, and how recent"}]}
An empty list is a fine answer.`,
    2000,
  );
  if (!r.ok) return { rows: [], searches, modelNote: r.reason };
  const start = r.text.indexOf("{");
  const end = r.text.lastIndexOf("}");
  let people: unknown[] = [];
  try {
    people = (JSON.parse(r.text.slice(start, end + 1)) as { people?: unknown[] }).people ?? [];
  } catch {
    return { rows: [], searches, modelNote: "bad_response" };
  }

  const now = Date.now();
  const rows: IncumbentRow[] = [];
  const perCompany = new Map<string, number>();
  for (const p of people) {
    if (!p || typeof p !== "object") continue;
    const x = p as Record<string, unknown>;
    const s = (k: string) => (typeof x[k] === "string" ? (x[k] as string).trim() : "");
    const name = s("name");
    const ev = evidence.find((e) => e.id === s("source").replace(/[[\]\s]/g, "").split(",")[0]?.toUpperCase());
    // The name must be in the very piece it is cited from.
    if (!ev || name.length < 3 || !ev.text.toLowerCase().includes(name.toLowerCase())) continue;
    const company = input.companies.find((c) => c.name.toLowerCase() === (s("company") || ev.company).toLowerCase()) ?? input.companies.find((c) => c.name === ev.company)!;
    const former = s("status") === "former";
    if (former && !company.isClient) continue;
    const key = `${company.name}|${former}`;
    if ((perCompany.get(key) ?? 0) >= 2) continue;
    if (rows.some((row) => row.name?.toLowerCase() === name.toLowerCase() && row.company === company.name)) continue;
    perCompany.set(key, (perCompany.get(key) ?? 0) + 1);

    // LinkedIn only from a result: the cited one, or a profile result carrying the name.
    const profiles = found.find((f) => f.company === company.name)?.profiles ?? [];
    const own = canonicalProfile(ev.url) ?? canonicalProfile(profiles.find((h) => h.title.toLowerCase().includes(name.toLowerCase()))?.url ?? "");
    const conf = s("confidence");
    rows.push({
      name,
      title: s("title") || input.title,
      company: company.name,
      linkedinUrl: own ? displayUrl(own) : null,
      kind: company.isClient ? (former ? "predecessor" : "incumbent") : "competitor",
      confidence: conf === "high" || conf === "medium" || conf === "low" ? conf : "low",
      note: s("note").slice(0, 160),
      sourceUrl: ev.url,
      sourceTitle: ev.title,
      isSelected: false,
      generatedAt: now,
    });
  }
  return { rows, searches };
}
