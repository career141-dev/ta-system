import { search as serperSearch, readPage as fetchPage, serperConfigured, type SearchHit } from "./serper";
import { write as askModel, type AiResult } from "./ai";
import type { Citation, CompetitorProfile, ResearchFields } from "@/data/types";
import { findIncumbents, type IncumbentRow } from "./incumbents";
import { searchMatrix } from "./websearch";

/**
 * Research by search, then reading — rebuilt 22 Sep at the desk's request:
 * "we give the client's name and industry; search the client, search the
 * competitors, read their pages and show it."
 *
 * The old path asked one model to search the web by itself and write the
 * fields; nothing read the client's or a competitor's own site, and the
 * competitors came back as bare names. Here Serper finds the pages, the pages
 * are read, and the model only sorts text it was handed, citing which piece
 * each field came from. Every address on the page — website, LinkedIn,
 * sources — is one a search returned, never one a model wrote.
 */

export interface ResearchInput {
  clientName: string;
  industry: string;
  /** The opening's locations; "Sri Lanka" when there are none. */
  where: string;
  title: string;
  /** Also find who holds the role now, at the client and the competitors (Benchmark). */
  benchmark?: boolean;
}

export interface ResearchDeps {
  search: (q: string, num?: number) => Promise<{ hits: SearchHit[]; credits: number; error?: string }>;
  readPage: (url: string, maxChars?: number) => Promise<string | null>;
  model: (system: string, prompt: string, maxTokens?: number) => Promise<AiResult>;
}

export type ResearchRun =
  | {
      ok: true;
      fields: ResearchFields;
      sources: Citation[];
      searches: number;
      markdown: string;
      /** Set when the pages were found but the model could not sort them. */
      modelNote?: string;
      /** The model that sorted the client's pages — Claude, or OpenRouter when Claude could not. */
      answeredBy?: string;
      /** Who holds the role now; absent when Benchmark was not asked for. */
      benchmarks?: IncumbentRow[];
      benchmarkNote?: string;
    }
  | { ok: false; reason: string; detail?: string };

/** The real web: Serper, page reads, and the cheap structuring model. */
export const DEFAULT_DEPS: ResearchDeps = {
  search: (q, num) => serperSearch(q, num),
  readPage: fetchPage,
  model: (s, p, max) => askModel(s, p, max, "plan"),
};

/** How many competitors are searched and read. Six is enough to benchmark against. */
export const MAX_COMPETITORS = 6;

/** Sites that write *about* companies — never a company's own website. */
const NOT_OWN_SITE =
  /(linkedin|facebook|instagram|twitter|x\.com|youtube|tiktok|wikipedia|glassdoor|indeed|crunchbase|zoominfo|rocketreach|bloomberg|reuters|dnb\.com|yellowpages|yelp|google\.|bing\.|topjobs|ikman|jobsnet|naukri|monster|ambitionbox|craft\.co|owler|pitchbook|cbinsights|tracxn|opencorporates|justdial|apollo\.io|signalhire|comparably|kompass|dailymirror|dailynews|ft\.lk|economynext|sundaytimes|newsfirst|adaderana|themorning|lankabusinessonline|medium\.com|blogspot|wordpress\.com)/i;

/** A company's name as the words that would appear in its domain. */
function nameTokens(name: string): string[] {
  return name
    .toLowerCase()
    .replace(/\([^)]*\)/g, " ")
    .replace(/\b(plc|ltd|limited|pvt|private|company|co|group|holdings|inc|llc|the|and|of|lanka|sri)\b\.?/g, " ")
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length >= 3);
}

function hostOf(url: string): string | null {
  try {
    return new URL(url).hostname.replace(/^www\./, "").toLowerCase();
  } catch {
    return null;
  }
}

/**
 * The company's own website among search results: the first result that is not
 * a directory, social network or news site, preferring one whose address
 * carries a word of the company's name. Returned as the site's root.
 */
export function pickOfficialSite(hits: SearchHit[], name: string): string | null {
  const tokens = nameTokens(name);
  const own = hits.filter((h) => {
    const host = hostOf(h.url);
    return host && !NOT_OWN_SITE.test(host);
  });
  const named = own.find((h) => tokens.some((t) => hostOf(h.url)!.replace(/[^a-z0-9]/g, "").includes(t)));
  const pick = named ?? null;
  if (!pick) return null;
  const u = new URL(pick.url);
  return `${u.protocol}//${u.hostname}`;
}

/** A LinkedIn company page among the results, at its canonical address. */
export function pickLinkedInCompany(hits: SearchHit[], name?: string): string | null {
  const tokens = name ? nameTokens(name) : [];
  const pages = hits
    .map((h) => h.url.match(/^https?:\/\/(?:[a-z]{2,3}\.)?linkedin\.com\/company\/([^/?#]+)/i))
    .filter((m): m is RegExpMatchArray => Boolean(m));
  const named = pages.find((m) => tokens.some((t) => m[1].toLowerCase().replace(/[^a-z0-9]/g, "").includes(t)));
  const m = named ?? (tokens.length ? null : pages[0]);
  return m ? `https://www.linkedin.com/company/${m[1]}` : null;
}

/**
 * Competitor names the model proposed, kept only when the name is written in
 * something the search returned — a company the model knows of but the search
 * did not turn up is not a finding. The client itself is dropped.
 */
export function groundedCompetitors(proposed: string[], evidence: string, clientName: string): string[] {
  const text = evidence.toLowerCase();
  const client = nameTokens(clientName).join(" ");
  const out: string[] = [];
  for (const raw of proposed) {
    const name = raw.replace(/^[-*\d.)\s]+/, "").trim();
    if (name.length < 2 || name.length > 80) continue;
    if (!text.includes(name.toLowerCase())) continue;
    const key = nameTokens(name).join(" ");
    if (!key || key === client) continue;
    if (out.some((o) => nameTokens(o).join(" ") === key)) continue;
    out.push(name);
  }
  return out.slice(0, MAX_COMPETITORS);
}

/** The first JSON object in a model's answer, however it is wrapped. */
export function parseJsonObject(text: string): Record<string, unknown> | null {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    const v = JSON.parse(text.slice(start, end + 1));
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

interface Evidence {
  id: string;
  url: string;
  title: string;
  text: string;
}

const str = (v: unknown) => (typeof v === "string" ? v.trim() : "");
const list = (v: unknown) =>
  (Array.isArray(v) ? v : typeof v === "string" ? v.split(";") : [])
    .map((x) => str(x))
    .filter((x) => x.length > 1);

/**
 * A field the model filled is kept only when it names a piece of evidence it
 * was given. An uncited field is empty: an empty field is a fact, a guess a
 * liability.
 */
function cited(field: unknown, ids: Set<string>): { value: unknown; sources: string[] } {
  if (!field || typeof field !== "object" || Array.isArray(field)) return { value: null, sources: [] };
  const f = field as { value?: unknown; source?: unknown };
  // Models cite several at once — "S1, S5, S8" — and a strict single id threw
  // away good answers in the first real run (22 Sep). Any real id counts.
  const raw = Array.isArray(f.source) ? f.source.map(str).join(",") : str(f.source);
  const sources = [...new Set(raw.match(/S\d+/gi)?.map((x) => x.toUpperCase()) ?? [])].filter((x) => ids.has(x));
  return sources.length ? { value: f.value, sources } : { value: null, sources: [] };
}

const SYSTEM = `You organise research for a recruitment desk at Career141, a Sri Lankan talent acquisition firm.
You are given numbered pieces of evidence: search results and text read from web pages.
Use ONLY that evidence. Never add anything you know from elsewhere. Never write a URL.
Every field you fill names the evidence id it came from, e.g. "S3". If the evidence does not say it, leave the value empty.
Reply with JSON only.`;

export async function researchViaSearch(input: ResearchInput, deps: ResearchDeps = DEFAULT_DEPS): Promise<ResearchRun> {
  if (deps === DEFAULT_DEPS && !serperConfigured()) return { ok: false, reason: "no_serper" };
  const name = input.clientName.trim();
  if (!name || /^(the client|confidential|unknown|internal)\b/i.test(name)) return { ok: false, reason: "client_not_searchable" };
  const industry = input.industry.trim();
  const where = input.where.trim() || "Sri Lanka";

  let searches = 0;
  // A search that fails — a rejected key, a 429, a network error — used to
  // return nothing and be reported as "the search found nothing under the
  // client's name", sending the desk to check a client record that was fine
  // (live, 23 Sep). The first refusal is kept so an empty run can say so.
  let searchError: string | null = null;
  const run = async (q: string) => {
    const r = await deps.search(q, 10);
    searches += r.credits || (r.error ? 0 : 1);
    if (r.error === "spend_cap") throw new SpendCapHit();
    if (r.error && !searchError) searchError = r.error;
    return r.hits;
  };

  try {
    // ── 1. The client, and who competes with them — all at once. ─────────────
    const [siteHits, linkedinHits, aboutHits, compHits, marketHits, titleHits] = await Promise.all([
      run(`"${name}" ${industry}`.trim()),
      run(`"${name}" site:linkedin.com/company`),
      run(`"${name}" about head office ${where}`),
      run(`"${name}" competitors`),
      run(`top ${industry || "companies"} companies in ${where}`),
      run(`"${input.title}" jobs ${where}`),
    ]);
    const clientHits = [...siteHits, ...aboutHits];
    if (clientHits.length + linkedinHits.length === 0) {
      return searchError
        ? { ok: false, reason: "search_failed", detail: searchError }
        : { ok: false, reason: "nothing_found" };
    }

    const website = pickOfficialSite(clientHits, name);
    const linkedin = pickLinkedInCompany([...linkedinHits, ...siteHits], name);

    // ── 2. Read the client's own pages. Free: a fetch, not a search. ─────────
    const clientPages = website
      ? await Promise.all(
          [website, `${website}/about`, `${website}/about-us`, `${website}/services`].map(async (u) => ({ url: u, text: await deps.readPage(u, 1500) })),
        )
      : [];

    // ── 3. Competitors named in what the search returned. ────────────────────
    const compEvidence = [...compHits, ...marketHits].map((h) => `${h.title} — ${h.snippet}`).join("\n");
    let competitors: string[] = [];
    if (compEvidence) {
      const r = await deps.model(
        SYSTEM,
        `Search results about ${name}${industry ? ` (${industry})` : ""} and its market in ${where}:\n\n${compEvidence}\n\nList up to ${MAX_COMPETITORS} companies from these results that compete with ${name} in the same business. Company names only, spelled exactly as in the results. Not ${name} itself, not directories, news sites or job boards.\nJSON: {"competitors": ["..."]}`,
        600,
      );
      if (r.ok) competitors = groundedCompetitors(list(parseJsonObject(r.text)?.competitors), compEvidence, name);
    }

    // ── 4. Search and read each competitor, in parallel. ─────────────────────
    // Three angles each, not one (23 Sep): what they do, their LinkedIn page,
    // and where they are and how big — the last is what made competitor rows
    // read as bare names before. The angles run together and a page two of
    // them found is offered to the model first, as in Benchmark.
    const compFound = await Promise.all(
      competitors.map(async (c) => {
        const matrix = await searchMatrix(
          [`"${c}" ${industry}`.trim(), `"${c}" site:linkedin.com/company`, `"${c}" ${where} headquarters OR "head office" OR employees`],
          deps.search,
          { num: 10 },
        );
        searches += matrix.credits;
        if (matrix.errors.includes("spend_cap")) throw new SpendCapHit();
        const hits = matrix.hits;
        const site = pickOfficialSite(hits, c);
        // Their own words about themselves: the front page and the about page.
        const [page, about] = site
          ? await Promise.all([deps.readPage(site, 1200), deps.readPage(`${site}/about`, 1200)])
          : [null, null];
        return { name: c, hits: hits.slice(0, 4), site, linkedin: pickLinkedInCompany(hits, c), page, about };
      }),
    );

    // ── 5. Number every piece of evidence, so a field can say where it is from.
    // Kept short: a 30,000-character prompt took the model 56 s in the first
    // real run (22 Sep). A page repeated under two addresses is sent once.
    const evidence: Evidence[] = [];
    const seen = new Set<string>();
    const add = (url: string, title: string, text: string) => {
      const t = text.trim();
      const key = t.slice(0, 200);
      if (!t || seen.has(key)) return "";
      seen.add(key);
      const id = `S${evidence.length + 1}`;
      evidence.push({ id, url, title, text: t });
      return id;
    };
    const clientIds = [
      ...clientPages.filter((p) => p.text).map((p) => add(p.url, `${name} — ${p.url}`, p.text!)),
      ...[...siteHits.slice(0, 4), ...aboutHits.slice(0, 4), ...linkedinHits.slice(0, 2), ...titleHits.slice(0, 5)].map((h) =>
        add(h.url, h.title, h.snippet),
      ),
    ].filter(Boolean);
    const compIds = compFound.map((c) =>
      [
        c.page && c.site ? add(c.site, `${c.name} — website`, c.page) : "",
        c.about && c.site ? add(`${c.site}/about`, `${c.name} — about`, c.about) : "",
        ...c.hits.map((h) => add(h.url, h.title, h.snippet)),
      ].filter(Boolean),
    );
    const ids = new Set(evidence.map((e) => e.id));
    const blockOf = (wanted: string[]) =>
      evidence
        .filter((e) => wanted.includes(e.id))
        .map((e) => `[${e.id}] ${e.title} (${e.url})\n${e.text}`)
        .join("\n\n");

    // What we know without the model: the addresses the search returned.
    const competitorProfiles: CompetitorProfile[] = compFound.map((c) => ({
      name: c.name,
      website: c.site ?? "",
      linkedin: c.linkedin ?? "",
      whatTheyDo: "",
      location: "",
      summary: "",
      sources: [],
    }));
    const fields: ResearchFields = {
      similarDesignation: "",
      websiteLink: website ?? "",
      servicesProvider: [],
      country: "",
      location: "",
      competitors,
      socialMedia: linkedin ?? "",
      companyOverview: "",
      competitorProfiles,
    };

    // ── 6. The model sorts the evidence into fields, citing each one. The
    // client and the competitors are two calls at once, not one long one.
    const CITE = `Each field is {"value": ..., "source": "S<n>"} naming the evidence it came from; leave value "" (or []) when the evidence does not say it.`;
    // Benchmark — who holds the role now — runs alongside the write-up, over
    // the client's and the competitors' own sites found above (22 Sep).
    const incumbents = input.benchmark
      ? findIncumbents(
          {
            title: input.title,
            where,
            companies: [
              { name, website, isClient: true },
              ...compFound.map((c) => ({ name: c.name, website: c.site, isClient: false })),
            ],
          },
          deps,
        )
      : Promise.resolve(null);
    const [clientAnswer, compAnswer, bench] = await Promise.all([
      deps.model(
        SYSTEM,
        `Client: ${name}${industry ? ` — ${industry}` : ""}. Role being hired: ${input.title}. Market: ${where}.

Evidence:
${blockOf(clientIds)}

${CITE}
{
  "similarDesignation": {"value": "titles this same role carries at other companies, semicolon separated", "source": ""},
  "services": {"value": ["what ${name} actually does, 3-6 short items"], "source": ""},
  "country": {"value": "", "source": ""},
  "location": {"value": "city or area of the head office", "source": ""},
  "overview": {"value": "two short paragraphs: what the business is, size and structure, who leads it, anything recent that affects hiring", "source": ""}
}`,
        1500,
      ),
      competitors.length
        ? deps.model(
            SYSTEM,
            `Competitors of ${name}${industry ? ` (${industry})` : ""} in ${where}: ${competitors.join("; ")}.

Evidence:
${blockOf(compIds.flat())}

${CITE}
{"competitors": [{"name": "exactly as listed above", "whatTheyDo": {"value": "what this company sells or does, in a few words", "source": ""}, "location": {"value": "city or area of the head office", "source": ""}, "summary": {"value": "two or three sentences: size or staff numbers, where they operate, how they compete with ${name}, anything recent", "source": ""}}]}`,
            1500,
          )
        : Promise.resolve(null),
      incumbents,
    ]);
    if (bench) searches += bench.searches;

    let modelNote: string | undefined;
    const j = clientAnswer.ok ? parseJsonObject(clientAnswer.text) : null;
    if (!clientAnswer.ok) modelNote = clientAnswer.reason;
    else if (!j) modelNote = "bad_response";
    if (j) {
      fields.similarDesignation = str(cited(j.similarDesignation, ids).value);
      fields.servicesProvider = list(cited(j.services, ids).value).slice(0, 6);
      fields.country = str(cited(j.country, ids).value);
      fields.location = str(cited(j.location, ids).value);
      fields.companyOverview = str(cited(j.overview, ids).value);
    }

    const cj = compAnswer?.ok ? parseJsonObject(compAnswer.text) : null;
    if (compAnswer && !compAnswer.ok) modelNote ??= compAnswer.reason;
    const byName = new Map(
      (Array.isArray(cj?.competitors) ? (cj!.competitors as unknown[]) : [])
        .filter((c): c is Record<string, unknown> => Boolean(c) && typeof c === "object")
        .map((c) => [str(c.name).toLowerCase(), c]),
    );
    for (const p of competitorProfiles) {
      const c = byName.get(p.name.toLowerCase());
      if (!c) continue;
      const what = cited(c.whatTheyDo, ids);
      const at = cited(c.location, ids);
      const sum = cited(c.summary, ids);
      p.whatTheyDo = str(what.value);
      p.location = str(at.value);
      p.summary = str(sum.value);
      p.sources = [...new Set([...what.sources, ...at.sources, ...sum.sources])]
        .map((id) => evidence.find((e) => e.id === id)!)
        .map((e) => ({ url: e.url, title: e.title, quote: "" }));
    }

    // Every piece of evidence is a source: the TA can open what was read.
    const sources: Citation[] = evidence.map((e) => ({ url: e.url, title: e.title, quote: e.text.slice(0, 150) }));
    const markdown = [
      `# ${name}`,
      fields.websiteLink && `Website: ${fields.websiteLink}`,
      fields.socialMedia && `LinkedIn: ${fields.socialMedia}`,
      fields.companyOverview,
      competitorProfiles.length ? `## Competitors\n${competitorProfiles.map((p) => `- ${p.name}${p.website ? ` (${p.website})` : ""}${p.whatTheyDo ? ` — ${p.whatTheyDo}` : ""}`).join("\n")}` : "",
    ]
      .filter(Boolean)
      .join("\n\n");
    return { ok: true, fields, sources, searches, markdown, modelNote, answeredBy: clientAnswer.ok ? clientAnswer.provider : undefined, benchmarks: bench?.rows, benchmarkNote: bench?.modelNote };
  } catch (e) {
    if (e instanceof SpendCapHit) return { ok: false, reason: "spend_cap" };
    throw e;
  }
}

class SpendCapHit extends Error {}
