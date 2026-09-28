import { gemini } from "./ai";
import { claudeHeadhunt, claudeSourcingOn } from "./claudeSourcing";
import { canonicalProfile, displayUrl, readPage, search, serperConfigured } from "./serper";
import type { BenchmarkEntry, ProfileSuggestion } from "@/data/types";

/**
 * Finding people we do not hold a CV for — spec §8A.2.
 *
 * Six stages, and the ordering is the design:
 *
 *   0. PLAN     a model reads the JD and produces search vocabulary
 *   1. QUERY    query strings built deterministically from that plan
 *   2. SEARCH   Serper runs them; results deduped to one row per person
 *   3. FILTER   free heuristic cut, deliberately generous
 *   4. ENRICH   one search per survivor, which is what turns a headline into a profile
 *   5. JUDGE    a model ranks what it was handed
 *
 * Testing on two real openings taught the three things that actually move
 * quality, and all three live in stage 0:
 *
 *   **Search the work, not the title.** Almost nobody headlines themselves
 *   "NVOCC". They write B/L, Shipping Instructions, delivery orders, ASYCUDA.
 *   A title-only search returned directors and MDs; a vocabulary search returned
 *   the desk-level people the role actually wants.
 *
 *   **Search named employers, not sector words.** "renewable energy OR solar"
 *   found one person; the accountants sitting inside Austral Solar and Navitas
 *   were only ever going to come back from their employers' names.
 *
 *   **One query is one roll of the dice.** The same intent phrased two ways
 *   returned 0 profiles and 8. Coverage comes from many narrow queries, not one
 *   broad one — and at a tenth of a cent each, being stingy costs candidates.
 */

/** The desk's notes on who the client is, as a line under the client's name — "SQ" alone is a dozen companies. */
export function aboutClient(s: Pick<SourcingSpec, "clientNotes">): string {
  const notes = (s.clientNotes ?? "").trim();
  return notes ? `\nAbout the client, from the recruitment desk: ${notes.slice(0, 800)}` : "";
}

export interface SourcingSpec {
  title: string;
  clientName: string;
  /** Never surfaced. You do not headhunt from the company paying you. */
  clientCompanyNames: string[];
  /** What the desk wrote about the client (28 Sep) — who they are, when the name alone is ambiguous. */
  clientNotes?: string;
  jdText: string;
  locations: string[];
  targetNationalities: string[];
  /** Only when the client stated it. Never inferred from anything. */
  targetGender: string | null;
  salaryNote: string;
  /** Employers the TA ticked on Benchmarking. The strongest query terms there are. */
  targetEmployers: string[];
  /** Canonical profile keys already in the vault or a pipeline — never re-suggested. */
  alreadyKnown: string[];
}

export interface QueryPlan {
  titleVariants: string[];
  /** What the person does, in profile language. Paired with employer names,
   *  because a profile rarely carries the exact title a spec asks for. */
  functions: string[];
  vocabulary: string[];
  /** An acronym and what it stands for, searched together so it cannot collide. */
  acronyms: { short: string; long: string }[];
  systems: string[];
  qualifications: string[];
  employers: string[];
  feeders: string[];
  negatives: string[];
}

/**
 * Spec §8A.2 — three rounds per opening, then stop.
 *
 * Round 1 runs by itself the moment the JD is approved, so the TA opens the tab
 * to a list rather than a button. The two that follow are theirs to spend, and
 * only make sense once there is feedback to steer them: a round with nothing
 * kept and nothing dismissed just runs the same search again.
 */
export const MAX_ROUNDS = 3;

export interface SourcingRun {
  suggestions: Omit<ProfileSuggestion, "id">[];
  plan: QueryPlan | null;
  queries: string[];
  credits: number;
  scanned: number;
  /** Removed by the exclusion pass before ranking — shown, so a small list reads
   *  as a judgement rather than a failure. */
  rejected?: number;
  cost: number;
  error?: string;
  note?: string;
}

// ─── Stage 0: the plan ───────────────────────────────────────────────────────

const PLAN_PROMPT = (s: SourcingSpec) => {
  const market = countryOf(s.locations.join(" ")) ?? "Sri Lanka";
  const sources = s.targetNationalities.length
    ? s.targetNationalities.join(", ")
    : market;
  return `You are preparing a LinkedIn X-ray sourcing plan for Career141, a recruitment firm based in Sri Lanka that places candidates across South Asia and the Gulf.

THE ROLE
Title: ${s.title}
Client: ${s.clientName}${aboutClient(s)}
Location: ${s.locations.join(", ") || market}
Market: ${market}
Nationalities this role targets: ${sources}
Package: ${s.salaryNote}

FULL SPECIFICATION
"""
${s.jdText.slice(0, 6000)}
"""

Produce the vocabulary a search should use. Return ONLY these seven labelled lines, values separated by semicolons:

TITLES: the exact job titles a suitable person would have on LinkedIn today, including one rung below and one above. Real titles people write, not descriptions.
VOCABULARY: 8-12 concrete operational terms from the responsibilities — the documents, processes and artefacts someone would actually name in their own profile. Not soft skills. Not the job title. Where a term is an acronym, write it as ACRONYM=expansion (for example NBR=Nitrile Butadiene Rubber, B/L=Bill of Lading). An acronym on its own matches company names and unrelated industries.
SYSTEMS: named software, platforms or ERPs. Empty if the spec names none.
QUALIFICATIONS: named professional bodies, certifications or institutions relevant to this discipline in Sri Lanka.
EMPLOYERS: 6-10 real companies where a suitable person is likely to be working RIGHT NOW. Name companies in ${market} first — direct competitors of the client and firms in the sector named in the spec. Where this role targets nationalities other than the local market (${sources}), include some employers from those home markets too, because that is where those candidates are now. Write each as the SHORT name people put on their own LinkedIn profile, not the registered legal name: "Cargills Food City" not "Cargills (Ceylon) PLC", "Keells" not "Jaykay Marketing Services Ltd".
FUNCTIONS: 4-6 short phrases describing what this person DOES day to day, in the words a profile would use — "branch operations", "outlet management", "product formulation", "retail network". These are searched alongside employer names, because almost nobody at a company holds the exact job title on the spec.
FEEDERS: 3-5 employers or role types people typically move to this job FROM — for finance that is Big 4 audit, for others the equivalent in this discipline and market.
NEGATIVES: 3-6 words that would indicate the WRONG person, to exclude from searches.

Rules:
- Every value must be a term that would plausibly appear verbatim in a LinkedIn profile.
- Name real companies you are confident exist. Do not invent company names.
- The market for this role is ${market}. Do not default to Sri Lankan companies unless the market is Sri Lanka or the role targets Sri Lankan nationals.
- No commentary, no other lines.`;
};

function parsePlan(text: string): QueryPlan {
  const get = (label: string) => {
    const m = text.match(new RegExp(`^${label}:(.*)$`, "im"));
    return m
      ? m[1].split(";").map((x) => x.trim().replace(/^["']|["']$/g, "")).filter((x) => x.length > 1)
      : [];
  };
  // NBR matched "NBR Group", a real-estate firm, on the COO role. An acronym is
  // searched together with its expansion so the two must both appear.
  const vocab = get("VOCABULARY").slice(0, 12);
  const expanded = vocab.map((v) => {
    const m = v.match(/^([A-Z][A-Z0-9/&.-]{1,9})\s*=\s*(.+)$/);
    return m ? { short: m[1], long: m[2].trim() } : { short: v, long: null };
  });

  return {
    titleVariants: get("TITLES").slice(0, 8),
    functions: get("FUNCTIONS").slice(0, 6),
    vocabulary: expanded.map((e) => e.short),
    acronyms: expanded.filter((e) => e.long).map((e) => ({ short: e.short, long: e.long! })),
    systems: get("SYSTEMS").slice(0, 6),
    qualifications: get("QUALIFICATIONS").slice(0, 6),
    employers: get("EMPLOYERS").slice(0, 10),
    feeders: get("FEEDERS").slice(0, 5),
    negatives: get("NEGATIVES").slice(0, 6),
  };
}

// ─── Stage 1: the queries ────────────────────────────────────────────────────

/** LinkedIn's country subdomains, for the markets Career141 actually recruits in. */
const COUNTRY_DOMAIN: Record<string, string> = {
  "sri lanka": "lk", bangladesh: "bd", "saudi arabia": "sa", "united arab emirates": "ae",
  uae: "ae", dubai: "ae", qatar: "qa", oman: "om", kuwait: "kw", bahrain: "bh",
  india: "in", pakistan: "pk", singapore: "sg", malaysia: "my", vietnam: "vn",
  indonesia: "id", philippines: "ph", cambodia: "kh", egypt: "eg", jordan: "jo",
  kenya: "ke", ethiopia: "et", turkey: "tr", china: "cn", "united kingdom": "uk",
  australia: "au",
};

/** Cities that name their country for us, because a spec rarely spells it out. */
const CITY_COUNTRY: Record<string, string> = {
  colombo: "sri lanka", rajagiriya: "sri lanka", wattala: "sri lanka", kandy: "sri lanka",
  galle: "sri lanka", gampaha: "sri lanka", negombo: "sri lanka", nugegoda: "sri lanka",
  dhaka: "bangladesh", mirpur: "bangladesh", chittagong: "bangladesh", gazipur: "bangladesh",
  riyadh: "saudi arabia", jeddah: "saudi arabia", dammam: "saudi arabia",
  dubai: "united arab emirates", "abu dhabi": "united arab emirates", sharjah: "united arab emirates",
  doha: "qatar", muscat: "oman", manama: "bahrain",
};

/** Nationality as written on a brief, to the country it means. */
const NATIONALITY_COUNTRY: Record<string, string> = {
  "sri lankan": "sri lanka", srilankan: "sri lanka", bangladeshi: "bangladesh",
  indian: "india", pakistani: "pakistan", filipino: "philippines", filipina: "philippines",
  nepali: "nepal", nepalese: "nepal", egyptian: "egypt", jordanian: "jordan",
  saudi: "saudi arabia", emirati: "united arab emirates", qatari: "qatar",
  omani: "oman", kuwaiti: "kuwait", bahraini: "bahrain", malaysian: "malaysia",
  singaporean: "singapore", vietnamese: "vietnam", indonesian: "indonesia",
  cambodian: "cambodia", chinese: "china", kenyan: "kenya", ethiopian: "ethiopia",
};

function titleCase(s: string): string {
  return s.replace(/\b[a-z]/g, (c) => c.toUpperCase());
}

const GULF = ["sa", "ae", "qa", "om", "kw", "bh"];
/**
 * Where a Gulf role's candidates sit when the client has NOT named a
 * nationality — those posts are filled largely by expatriates, so searching only
 * the destination halves the pool. Never applied once a nationality is stated:
 * a client asking for Saudi nationals does not want a search of Pakistan.
 */
const GULF_SOURCES = ["in", "pk", "lk", "ph", "eg", "bd"];

/**
 * Where each nationality's people actually work abroad. This is what makes
 * "Sri Lankans who want to come home" findable, and it is keyed on the
 * nationality the client asked for — not on where the job happens to be.
 */
const DIASPORA: Record<string, string[]> = {
  "sri lanka": ["ae", "qa", "sg", "kw", "om"],
  india: ["ae", "sa", "qa", "sg", "kw"],
  pakistan: ["ae", "sa", "qa", "kw"],
  philippines: ["ae", "sa", "qa", "kw", "sg"],
  bangladesh: ["ae", "sa", "qa", "kw"],
  nepal: ["ae", "qa", "kw"],
};

export function countryOf(text: string): string | null {
  const t = text.toLowerCase().trim();
  for (const [nat, country] of Object.entries(NATIONALITY_COUNTRY)) if (t.includes(nat)) return country;
  for (const [c] of Object.entries(COUNTRY_DOMAIN)) if (t.includes(c)) return c;
  for (const [city, country] of Object.entries(CITY_COUNTRY)) if (t.includes(city)) return country;
  return null;
}

/**
 * Whether the client wants locals or a specific nationality brought in.
 *
 * Both happen: a Dhaka posting can be a search for Bangladeshis, or a search for
 * Sri Lankans to place there. Which one it is decides where we look, so it is
 * read from the brief rather than assumed from the address.
 */
export function nationalityPlan(locations: string[], nationalities: string[]) {
  const market = countryOf(locations.join(" ")) ?? "sri lanka";
  const wanted = nationalities
    .map((n) => countryOf(n))
    .filter((c): c is string => Boolean(c));
  const unique = [...new Set(wanted)];
  const localHire = unique.length === 0 || unique.includes(market);
  return {
    market,
    /** Home countries of the nationalities the client asked for. */
    homeCountries: unique,
    /** True when we are placing foreign nationals into this market. */
    expatSearch: unique.length > 0 && !localHire,
    localHire,
  };
}

/**
 * Where to search — spec §8A.2.
 *
 * Follows the job's own market and the nationalities it targets, rather than
 * assuming Sri Lanka. Three rules, each learned from a real opening:
 *
 *   · `www.` is always included. Sahan Gunarathna's profile resolves at `www.`,
 *     not `lk.`, so an `lk.`-only search silently misses people.
 *   · A Sri Lankan role also searches the Gulf, because Sri Lankans working in
 *     Dubai who want to come home are a pool local competitors do not touch
 *     (answer of 11 Sep: follow the target nationality).
 *   · A Gulf role searches the expatriate source countries too, because that is
 *     where most of its candidates currently live.
 */
export function domainsFor(locations: string[], nationalities: string[]): string[] {
  const { market, homeCountries, expatSearch } = nationalityPlan(locations, nationalities);
  const codes: string[] = [];
  const push = (c: string | null | undefined) => {
    if (c && !codes.includes(c)) codes.push(c);
  };
  const marketCode = COUNTRY_DOMAIN[market];

  if (homeCountries.length > 0) {
    // A nationality was named. Search where those people are — at home, in the
    // market already, and in their own diaspora. Nowhere else: a client asking
    // for Saudi nationals is not served by a search of Pakistan.
    if (expatSearch) {
      for (const c of homeCountries) push(COUNTRY_DOMAIN[c]);
      push(marketCode);
    } else {
      push(marketCode);
      for (const c of homeCountries) push(COUNTRY_DOMAIN[c]);
    }
    for (const c of homeCountries) {
      for (const d of DIASPORA[c] ?? []) push(d);
    }
  } else {
    // Nothing stated on the brief: search the people who are in the place the
    // job is, and no wider. Reaching into a diaspora is a decision with real
    // consequences — visas, relocation, notice — and it belongs to the client,
    // not to a default. A TA who wants it names the nationality.
    push(marketCode);
  }

  if (codes.length === 0) codes.push("lk");
  // Each extra domain costs a query. Five is enough to cover home, market and
  // the main diaspora without tripling the credit spend.
  return [...codes.slice(0, 5).map((c) => `${c}.linkedin.com/in`), "www.linkedin.com/in"];
}

export function buildQueries(spec: SourcingSpec, plan: QueryPlan): string[] {
  const q: string[] = [];
  const domains = domainsFor(spec.locations, spec.targetNationalities);
  // The destination market carries the bulk of the queries; the others get the
  // strongest single query each, which is where diaspora and expatriate
  // candidates come from without tripling the credit spend.
  const site = `site:${domains[0]}`;
  const anySite = "site:www.linkedin.com/in";
  const city = spec.locations[0]?.replace(/,.*/, "").trim() || "Colombo";
  const neg = plan.negatives.map((n) => `-"${n}"`).join(" ");

  // Titles — the obvious pass, and the shallowest.
  for (const t of plan.titleVariants.slice(0, 4)) {
    q.push(`${site} "${t}" ${city} ${neg}`.trim());
  }
  // Vocabulary — what people actually write about their own work.
  const ambiguous = new Set(plan.acronyms.map((a) => a.short));
  const plain = plan.vocabulary.filter((v) => !ambiguous.has(v));
  for (let i = 0; i < Math.min(plain.length, 8); i += 2) {
    const a = plain[i];
    const b = plain[i + 1];
    q.push(`${site} "${a}"${b ? ` "${b}"` : ""} ${neg}`.trim());
  }
  // An acronym is only ever searched alongside its expansion or the discipline,
  // so "NBR" cannot pull back a real-estate group called NBR.
  for (const ac of plan.acronyms.slice(0, 3)) {
    q.push(`${site} "${ac.short}" "${ac.long}" ${neg}`.trim());
  }
  // Systems and qualifications — highly discriminating when present.
  for (const s of plan.systems.slice(0, 3)) q.push(`${site} "${s}" ${city}`);
  for (const c of plan.qualifications.slice(0, 3)) {
    q.push(`${site} "${c}" ${plan.titleVariants[0] ?? spec.title}`);
  }
  // Named employers. The planner picked the right companies for retail ops and
  // food R&D and returned nobody from any of them, because the query demanded
  // the registered name AND the exact job title — and a profile carries neither.
  // Company name plus what the person does is what actually matches.
  const employers = [...new Set([...spec.targetEmployers, ...plan.employers])].slice(0, 8);
  const fn = plan.functions.length ? plan.functions : [spec.title];
  employers.forEach((e, i) => {
    if (spec.clientCompanyNames.some((c) => c.toLowerCase() === e.toLowerCase())) return;
    const short = e.replace(/\s*\([^)]*\)\s*/g, " ").replace(/\b(PLC|Ltd|Limited|Pvt|Private|Company|Co\.?|Group|Holdings|Corporation|Inc)\b\.?/gi, "").replace(/\s+/g, " ").trim();
    q.push(`${site} "${short || e}" "${fn[i % fn.length]}"`);
  });
  // Feeder employers — where this person was before they were this person.
  for (const f of plan.feeders.slice(0, 3)) {
    q.push(`${site} "${f}" ${plan.titleVariants[0] ?? spec.title} ${city}`);
  }
  // Placing foreign nationals into a market: the people already there are the
  // cheapest hires, and they are findable by searching the market's subdomain
  // for the home country's name — it appears in their education and history.
  const np = nationalityPlan(spec.locations, spec.targetNationalities);
  if (np.expatSearch) {
    const marketDomain = COUNTRY_DOMAIN[np.market];
    for (const home of np.homeCountries.slice(0, 2)) {
      if (marketDomain) {
        q.push(`site:${marketDomain}.linkedin.com/in "${plan.titleVariants[0] ?? spec.title}" "${titleCase(home)}"`);
      }
      const homeDomain = COUNTRY_DOMAIN[home];
      if (homeDomain) {
        q.push(`site:${homeDomain}.linkedin.com/in "${plan.titleVariants[0] ?? spec.title}" ${plan.vocabulary[0] ? `"${plan.vocabulary[0]}"` : ""}`.trim());
      }
    }
  }

  // Not every profile in a market lives under that market's subdomain, so a
  // `www.` pass is still worth one query — but it matches anyone whose profile
  // merely MENTIONS the country. On the Group CSCO role that single query
  // returned executives in Dubai, Qatar and Singapore, one of whom qualified
  // only through "programs touching Sri Lanka". Anchoring it to the city and a
  // piece of the working vocabulary keeps it local.
  const country = countryOf(spec.locations.join(" ")) ?? "Sri Lanka";
  const lead = plan.titleVariants[0] ?? spec.title;
  const anchor = plan.vocabulary[0] ?? plan.functions[0] ?? "";
  // Anchored to the city so it stays local, and a second pass on the country so
  // narrowing one query does not cost half the coverage — tightening this alone
  // took the R&D role from 131 profiles found to 63.
  q.push(`${anySite} "${lead}" "${city}" ${neg}`.trim());
  if (anchor) q.push(`${anySite} "${anchor}" "${country}" ${neg}`.trim());
  // One query per adjacent market — diaspora for a local role, the expatriate
  // source countries for a Gulf one.
  for (const d of domains.slice(1, 5)) {
    if (d.startsWith("www.")) continue;
    q.push(`site:${d} "${lead}" ${plan.vocabulary[0] ? `"${plan.vocabulary[0]}"` : country}`);
  }
  return [...new Set(q.map((x) => x.replace(/\s+/g, " ").trim()))];
}

// ─── Stage 3: the free filter ────────────────────────────────────────────────

/**
 * Titles that sit above a normal hire — but only relative to the role being
 * filled. "Head of" disqualified every candidate for *Head of Branch
 * Operations*, which is the job: 156 profiles were found and the free filter
 * threw away all of them. A seniority guard has to know what it is guarding.
 */
const SENIOR_MARKERS = [
  "managing director", "chief executive", "ceo", "cfo", "coo", "founder",
  "board member", "general manager", "head of", "vice president", "country manager",
  "director -", "director at", "chief ",
];

function seniorityGuard(plan: QueryPlan, spec: SourcingSpec): string[] {
  const roleText = `${spec.title} ${plan.titleVariants.join(" ")}`.toLowerCase();
  // Anything the role itself is stays in scope.
  return SENIOR_MARKERS.filter((m) => !roleText.includes(m.trim()));
}

interface Candidate {
  key: string;
  url: string;
  title: string;
  snippets: string[];
  hits: number;
  enriched: string[];
}

function relevanceFilter(people: Candidate[], plan: QueryPlan, spec: SourcingSpec, limit: number): Candidate[] {
  const terms = [
    ...plan.vocabulary, ...plan.systems, ...plan.qualifications,
    ...plan.titleVariants, ...plan.functions,
  ].map((t) => t.toLowerCase());
  const tooSenior = seniorityGuard(plan, spec);
  const scored: { score: number; c: Candidate }[] = [];

  const pass = (need: number) => {
    const out: { score: number; c: Candidate }[] = [];
    for (const c of people) {
      const blob = `${c.title} ${c.snippets.join(" ")}`.toLowerCase();
      // Guard rail: never surface the client's own staff.
      if (spec.clientCompanyNames.some((n) => n.length > 3 && blob.includes(n.toLowerCase()))) continue;
      if (tooSenior.some((t) => blob.includes(t))) continue;
      if (plan.negatives.some((n) => blob.includes(n.toLowerCase()))) continue;
      const matched = terms.filter((t) => blob.includes(t)).length;
      if (matched < need) continue;
      // Found by several different queries is a real signal, and it is free.
      out.push({ score: matched + c.hits * 1.5, c });
    }
    return out;
  };

  // Two terms is the right bar for a discipline with its own language. Where the
  // vocabulary is thin it throws away the whole search, so the bar drops rather
  // than the run failing — the model still judges everything that gets through.
  let got = pass(2);
  if (got.length < 8) got = pass(1);
  scored.push(...got);
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, limit).map((x) => x.c);
}

// ─── Stage 5a: the exclusion pass ────────────────────────────────────────────

/**
 * One pass cannot both reject and rank. Asked to do both, it rejected almost
 * nobody and used "screen" as a bin: the COO longlist carried a hospital COO
 * whose own note said "zero exposure to rubber manufacturing", and the data-entry
 * list carried a plantation superintendent. Both are rejects, not weak matches.
 *
 * So rejection happens first, against the must-haves only, with nothing else to
 * weigh. Ranking then gets a clean list.
 */
const EXCLUDE_PROMPT = (spec: SourcingSpec, rows: string[], hard: string[]) => `You are the first screen for a recruitment desk. Your only job is to throw out people who cannot do this job. You are NOT ranking anyone.

THE ROLE
${spec.title} — ${spec.locations.join(", ")} — ${spec.salaryNote}

SPECIFICATION
"""
${spec.jdText.slice(0, 4000)}
"""
${hard.length ? `\nABSOLUTE REQUIREMENTS:\n${hard.map((h) => `- ${h}`).join("\n")}\n` : ""}
CANDIDATES:
${rows.join("\n")}

Return ONLY a line per candidate you are REJECTING, in this format:

INDEX | REASON

Reject where the evidence shows they do not fit. Be decisive: a longlist a TA has to re-screen is worse than a short one.

REJECT:
- a different discipline entirely — a cement plant manager for a retail branch role, a hospital operator for a manufacturing role, a cosmetics formulator for food R&D
- a different SECTOR where the specification names one — this is the commonest mistake, and the one a TA notices first
- a level FAR above or far below the band and title — two or more rungs away. One rung below or above is NOT a reason to reject (a senior analyst for a manager role, a manager for a senior manager role): those are the people who move into this job, and the ranking weighs level separately
- anything contradicting an absolute requirement above
- a career evidently based in another country when the role is a local hire
- a match that rests only on a coinciding acronym or company name

Do NOT reject for missing information. "Years not stated" is a question for the call.
If you would reject nobody, return the single word NONE.`;

/**
 * The rejected rows. The prompt asks for "INDEX | REASON", but the model does not
 * always keep to it — DeepSeek answered "[3] Reject - reason" on one run and the
 * pipe form on the next (16 September), so one run rejected everybody and the
 * next nobody. Any line that starts with an index is read; a line that says the
 * person is kept is not a rejection.
 */
export function parseExclusions(text: string, max: number): Map<number, string> {
  const out = new Map<number, string>();
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^\s*[-*]?\s*\[?(\d{1,3})\]?\s*(?:\||:|-|–|—|\.|\))?\s*(.*)$/);
    if (!m || m[0].trim() === m[1]) continue;
    const idx = Number(m[1]);
    const reason = m[2].replace(/^(reject(ed)?|exclude(d)?)\s*[-–—:|]?\s*/i, "").trim();
    if (/^(keep|kept|include|pass|none)\b/i.test(m[2].trim())) continue;
    if (Number.isInteger(idx) && idx >= 0 && idx < max) out.set(idx, reason || "rejected");
  }
  return out;
}

// ─── Stage 5b: the judgement ─────────────────────────────────────────────────

/**
 * What the client actually insisted on. Both the exclusion pass and the ranking
 * pass work from this same list, so they cannot disagree about what is required.
 */
function hardRequirements(spec: SourcingSpec): string[] {
  const np = nationalityPlan(spec.locations, spec.targetNationalities);
  const hard: string[] = [];
  if (spec.targetNationalities.length) {
    hard.push(
      np.expatSearch
        ? `NATIONALITY — the client wants ${spec.targetNationalities.join(" or ")} nationals placed in ${titleCase(np.market)}. Someone clearly a local national of ${titleCase(np.market)} and not one of the requested nationalities does NOT belong on this list. Where nationality cannot be established from education, previous employers or location history, say so in CONCERN and tier them "screen".`
        : `NATIONALITY — this is a local hire in ${titleCase(np.market)} for ${spec.targetNationalities.join(" or ")} nationals. Nationality is evidenced by schooling, university, previous employers or a stated location history in ${titleCase(np.market)} — not by a passing mention of the country. EXCLUDE anyone whose evidence places their career in another country, however senior or well matched they otherwise look. A profile that merely references ${titleCase(np.market)} in passing is not a ${spec.targetNationalities[0]} candidate.`,
    );
  }
  // The band is the sharpest seniority filter there is, and it is always stated.
  if (spec.salaryNote && /\d/.test(spec.salaryNote)) {
    hard.push(
      `COMPENSATION — the budget is ${spec.salaryNote}. EXCLUDE anyone whose evidenced seniority or market is plainly far above it: a multinational C-suite executive, or someone whose career is based in a substantially higher-paying market. Judge this against the local market for the role, and where it is merely uncertain put it in CONCERN rather than excluding.`,
    );
  }
  if (spec.targetGender) {
    hard.push(
      `GENDER — the client has specified ${spec.targetGender}. LinkedIn does not state gender, so this can only be judged from pronouns, a clearly gendered given name, or an explicit mention. Where it cannot be established, say so rather than guessing — never infer from a name you are not confident about.`,
    );
  }
  return hard;
}

const RANK_PROMPT = (spec: SourcingSpec, rows: string[]) => {
  const hard = hardRequirements(spec);
  return `You are building a sourcing longlist for Career141, a recruitment firm placing candidates across South Asia and the Gulf.

THE ROLE
${spec.title} — ${spec.clientName} — ${spec.locations.join(", ")} — ${spec.salaryNote}${aboutClient(spec)}
${hard.length ? `\nHARD REQUIREMENTS FROM THE CLIENT — these override every other consideration:\n${hard.map((h) => `- ${h}`).join("\n")}\n` : ""}

FULL SPECIFICATION
"""
${spec.jdText.slice(0, 5000)}
"""

CANDIDATES — a LinkedIn search snippet, plus what other searches found about the same person:
${rows.join("\n")}

Return ONLY pipe-delimited lines, one per candidate you would put in front of the client's recruiter, all seven fields present:

INDEX | SCORE | TIER | NAME | CURRENT_TITLE_AND_EMPLOYER | WHY | CONCERN

CHECK EVERY CANDIDATE AGAINST EACH REQUIREMENT IN THE SPECIFICATION, one by one:
  1. LOCATION — are they in (or clearly working in) the role's location?
  2. EXPERIENCE — do the evidenced years fall in the stated range?
  3. INDUSTRY — is their current or recent employer in the sector the role needs?
  4. LEVEL — is their title at the role's level?
  5. SKILLS / QUALIFICATIONS — are the required ones evidenced?
A requirement the evidence CONTRADICTS is disqualifying. A requirement the evidence is silent on lowers the score and goes in CONCERN.

SCORE — 0 to 100, how well the EVIDENCE matches this specification:
- 85-100: right work, right level, and at least two further hard matches evidenced
- 70-84: right work at roughly the right level, one further match evidenced
- 55-69: plausible, worth a call, but a material fact is unclear
- below 55: do not list them at all

DO NOT LIST (leave the line out entirely):
- fewer years than a stated minimum, where the years ARE evidenced
- students, undergraduates, interns or trainees for anything above an entry-level role
- two or more levels below or above the role (a junior for a mid-level role, a head of department for an executive role)
- anyone where the snippet gives no real evidence of the discipline — "insufficient evidence" is a reason to leave them out, not to list them

TIER — apply strictly, they must carry information:
- "priority" = the evidence shows BOTH (a) the right kind of work at roughly the right level, AND
  (b) at least one further hard match — the stated experience band, a required qualification, a
  named system, or the sector the specification asks for.
- "screen" = plausible and worth a call, but a material fact is missing, contradictory, or slightly
  off: wrong level, unclear years, unrelated sector, or the only evidence is a job title.

CALIBRATION: the two tiers should come out roughly balanced. If more than 60% land in one tier you
are not discriminating — move the weaker ones to "screen".

- Plain text only in WHY and CONCERN: no markdown, no asterisks.
- WHY: cite the SPECIFIC evidence — employer, qualification, system, years or duties actually named.
  Where the ALSO FOUND line adds something the snippet lacked, use it.
- CONCERN: what the TA must confirm on the call, or what is contradictory between sources. Be
  concrete. Only write NONE if every stated requirement is genuinely evidenced.
- Use the salary band to judge seniority: someone already above this band is a "screen" at best.
- Exclude only people clearly in the wrong discipline, or clearly far above or below the band.
- Aim for the 10-20 best, best first, but NEVER pad. If only four people genuinely fit this specification, return four. A short honest list is worth more than a long one a TA has to re-screen.`;
};

// ─── The run ─────────────────────────────────────────────────────────────────

/** Below this the ranker has said the person is not worth a call. */
const MIN_SCORE = 55;
/** "priority" needs the evidence to back it, not only the word. */
const PRIORITY_SCORE = 75;
/** A curated list, not a dump: what a TA will genuinely call in a round. */
const MAX_SUGGESTIONS = 20;
/** Profiles enriched and screened together. */
const BATCH = 30;
/** Survivors that make a second batch unnecessary. */
const ENOUGH = 8;

/** Run `work` over `items`, `limit` at a time, keeping the input order in the result. */
async function inParallel<T, R>(items: T[], limit: number, work: (item: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        out[i] = await work(items[i]);
      }
    }),
  );
  return out;
}

/**
 * One ranked line. Seven fields with a score; the older six-field form (no
 * score) is still read, so a model that drops the column does not lose the run.
 */
export function rankFields(line: string): { index: string; score: number | null; tier: string; name: string; headline: string; why: string; concern: string } | null {
  const f = line.split("|").map((x) => x.trim());
  if (f.length >= 7 && /^\d{1,3}$/.test(f[1])) {
    return { index: f[0], score: Number(f[1]), tier: f[2], name: f[3], headline: f[4], why: f[5], concern: f.slice(6).join(" | ") };
  }
  if (f.length >= 6) return { index: f[0], score: null, tier: f[1], name: f[2], headline: f[3], why: f[4], concern: f.slice(5).join(" | ") };
  return null;
}

/** Model prose without markdown: the list shows plain text. */
export function plain(text: string | undefined): string {
  return (text ?? "").replace(/\*\*|__|`/g, "").replace(/^\s*[-*]\s+/gm, "").trim();
}

/**
 * Company and location as LinkedIn's own search result states them — "Name -
 * Title - Company | LinkedIn" and "Location: Colombo" — never from the model.
 */
export function profileFacts(c: { title: string; snippets: string[] }): { company: string | null; location: string | null } {
  const parts = c.title.replace(/\s*\|\s*LinkedIn.*$/i, "").split(/\s+[-–—]\s+/);
  // "Name - Title - Company", or "Name - Title at Company".
  const company =
    (parts.length >= 3 ? parts[parts.length - 1].trim() : parts[1]?.match(/\s(?:at|@)\s+(.+)$/i)?.[1]?.trim()) || null;
  const loc = c.snippets.join(" ").match(/Location:\s*([^·|.\n]{2,60})/i)?.[1]?.trim() ?? null;
  return { company, location: loc };
}

export async function runSourcing(spec: SourcingSpec, round: number): Promise<SourcingRun> {
  const empty: SourcingRun = { suggestions: [], plan: null, queries: [], credits: 0, scanned: 0, cost: 0 };
  if (!serperConfigured()) return { ...empty, error: "no_serper" };

  // Claude does the headhunting when its search is on (lib/claudeSourcing,
  // 24 Sep). When it finds nobody or cannot answer, the stages below run as
  // before, so Suggestions never comes back empty because Claude could not.
  if (claudeSourcingOn()) {
    const byClaude = await claudeHeadhunt(spec, countryOf(spec.locations.join(" ")) ?? "Sri Lanka", round);
    if (byClaude.suggestions.length) return byClaude;
    console.warn(`[suggestions] Claude found nobody (${byClaude.error ?? "no one fit"}${byClaude.note ? `: ${byClaude.note}` : ""}) — searching the old way`);
  }

  // Stage 0 — plan.
  const planRes = await gemini("plan", PLAN_PROMPT(spec), { maxTokens: 2000 });
  if (!planRes.ok) return { ...empty, error: planRes.reason, note: planRes.detail };
  const plan = parsePlan(planRes.text);
  let cost = usageCost(planRes.usage);

  // Stages 1–2 — search and dedupe.
  const queries = buildQueries(spec, plan);
  const known = new Set(spec.alreadyKnown);
  const byKey = new Map<string, Candidate>();
  let credits = 0;

  // The first ten results of the best queries are not the only ten. Page two
  // costs one credit and is the cheapest coverage available.
  //
  // Run six at a time: one after another, a run took four and a half minutes
  // (16 September), nearly all of it waiting on searches that do not depend on
  // each other. Results are merged in query order, so the outcome is the same.
  const deep = new Set(queries.slice(0, 4));
  const pages = await inParallel(queries.flatMap((q) => (deep.has(q) ? [[q, 1], [q, 2]] : [[q, 1]])) as [string, number][], 6, ([q, page]) =>
    search(q, 10, page),
  );
  for (const r of pages) {
    credits += r.credits;
    for (const h of r.hits) {
      const key = canonicalProfile(h.url);
      if (!key || known.has(key)) continue;
      // "Name - Title at Company | LinkedIn": the suffix is not part of the person,
      // and a pipe in it split the ranker's pipe-delimited line one field early.
      const title = h.title.replace(/\s*\|\s*LinkedIn.*$/i, "").replace(/\|/g, "/").trim();
      const c = byKey.get(key) ?? { key, url: displayUrl(key), title, snippets: [], hits: 0, enriched: [] };
      c.hits += 1;
      if (h.snippet && !c.snippets.includes(h.snippet)) c.snippets.push(h.snippet);
      byKey.set(key, c);
    }
  }
  const scanned = byKey.size;

  // Stage 3 — free filter. Two batches' worth, best first: the second is
  // screened only when the first leaves too few (below).
  const pool = relevanceFilter([...byKey.values()], plan, spec, BATCH * 2);
  if (pool.length === 0) {
    return { ...empty, plan, queries, credits, scanned, cost, note: "nothing_survived_filter" };
  }

  // Stage 4 — enrich. The step that turns a headline into a profile.
  //
  // Three angles rather than one: the name alone, the name with the discipline,
  // and the name with the qualification the spec asks for. One search gave
  // Varnan Neethirajah three roles and a CIM Level 7; three give more. And where
  // a result is a page we are allowed to read — ZoomInfo, a company team page —
  // it is fetched outright, which costs nothing and beats any snippet.
  const where = countryOf(spec.locations.join(" ")) ?? "Sri Lanka";
  const discipline = spec.title.split(/[\s/]+/)[0];
  const credential = plan.qualifications[0] ?? plan.systems[0] ?? "";
  const enrich = (batch: Candidate[]) => inParallel(batch, 6, async (c) => {
    const name = c.title.split(/ - | \| /)[0].trim();
    const angles = [
      `"${name}" ${where} ${discipline}`,
      `"${name}" ${where}`,
      credential ? `"${name}" "${credential}"` : "",
    ].filter(Boolean);

    const pages: string[] = [];
    for (const r of await Promise.all(angles.map((a) => search(a, 6)))) {
      credits += r.credits;
      for (const h of r.hits.slice(0, 5)) {
        if (h.snippet && !c.snippets.includes(h.snippet) && !c.enriched.includes(h.snippet)) {
          c.enriched.push(h.snippet);
        }
        if (pages.length < 2 && !/linkedin\.com/i.test(h.url)) pages.push(h.url);
      }
    }
    for (const [i, body] of (await Promise.all(pages.map((url) => readPage(url)))).entries()) {
      if (body) c.enriched.push(`[${new URL(pages[i]).hostname}] ${body}`);
    }
    c.enriched = c.enriched.slice(0, 7);
  });

  // Stage 5a — reject, against the must-haves and nothing else.
  const rowsOf = (xs: Candidate[]) =>
    xs.map(
      (c, i) =>
        `[${i}] ${c.title}\n  PROFILE: ${c.snippets.join(" ").slice(0, 380)}\n  ALSO FOUND: ${c.enriched.join(" | ").slice(0, 480)}`,
    );
  const hardReqs = hardRequirements(spec);
  let survivors: Candidate[] = [];
  let rejected = 0;
  let screened = 0;
  let screenNote: string | undefined;
  // Batches of thirty, best first. A niche role's first thirty can all be the
  // wrong people — operations staff for a pricing role (16 September: 30 of 30
  // rejected, 0 suggested) — while the right ones sit further down the pool.
  // So a second batch is screened when the first leaves too few, and the
  // screen's decisions still stand: nobody rejected is put back.
  for (let from = 0; from < pool.length && survivors.length < ENOUGH; from += BATCH) {
    const batch = pool.slice(from, from + BATCH);
    await enrich(batch);
    const cut = await gemini("plan", EXCLUDE_PROMPT(spec, rowsOf(batch), hardReqs), { maxTokens: 2500 });
    screened += batch.length;
    if (!cut.ok) {
      survivors.push(...batch);
      continue;
    }
    cost += usageCost(cut.usage);
    const drop = parseExclusions(cut.text, batch.length);
    if (process.env.C141_DEBUG_SOURCING === "1") console.log("[sourcing] exclusion reply:", cut.text.slice(0, 4000));
    survivors.push(...batch.filter((_, i) => !drop.has(i)));
    rejected += drop.size;
  }
  // When the screen removes most of what it saw, that is reported — a bad
  // search and a bad screen look the same from here (13 September review).
  if (screened > 0 && rejected >= screened * 0.75) screenNote = `screen_removed_${rejected}_of_${screened}`;
  if (survivors.length === 0) {
    return { ...empty, plan, queries, credits, scanned, rejected, cost, note: screenNote ?? "all_excluded" };
  }

  // Stage 5b — rank what is left.
  const rows = rowsOf(survivors);
  const rank = await gemini("rank", RANK_PROMPT(spec, rows), { maxTokens: 10000 });
  if (!rank.ok) return { ...empty, plan, queries, credits, scanned, cost, error: rank.reason, note: rank.detail };
  cost += usageCost(rank.usage);

  const now = Date.now();
  const scored: { score: number; s: Omit<ProfileSuggestion, "id"> }[] = [];
  const seen = new Set<number>();
  for (const line of rank.text.split("\n")) {
    const f = rankFields(line);
    if (!f) continue;
    const idx = Number(f.index.replace(/[[\]]/g, ""));
    if (!Number.isInteger(idx) || idx < 0 || idx >= survivors.length || seen.has(idx)) continue;
    seen.add(idx);
    // The bar the prompt states, enforced here too: a model that lists someone
    // at 40 has told us not to show them.
    if (f.score !== null && f.score < MIN_SCORE) continue;
    const c = survivors[idx];
    // Priority is earned by the evidence, not by the label alone.
    const tier = f.tier.toLowerCase().startsWith("prior") && (f.score === null || f.score >= PRIORITY_SCORE) ? "priority" : "screen";
    const concern = plain(f.concern);
    const found = profileFacts(c);
    scored.push({ score: f.score ?? (tier === "priority" ? PRIORITY_SCORE : MIN_SCORE), s: {
      openingId: "",
      name: plain(f.name) || c.title.split(/ - | \| /)[0],
      headline: plain(f.headline) || c.title,
      company: found.company,
      location: found.location,
      // Never from the model — always the URL the search returned.
      linkedinUrl: c.url,
      tier,
      why: plain(f.why),
      concern: concern && !/^none\.?$/i.test(concern) ? concern : null,
      sourceUrl: c.url,
      status: "new",
      feedback: null,
      round,
      generatedAt: now,
    } });
  }
  // Best first, and no more than a TA will genuinely work through.
  const suggestions = scored.sort((a, b) => b.score - a.score).slice(0, MAX_SUGGESTIONS).map((x) => x.s);
  // A thin list is a finding, not a failure — senior and confidential roles
  // simply have less public surface. Saying so points the TA at Benchmarking
  // instead of leaving them to assume the search broke.
  const note =
    screenNote ??
    (suggestions.length > 0 && suggestions.length < 6
      ? `only_${suggestions.length}_fit`
      : undefined);
  return { suggestions, plan, queries, credits, scanned, rejected, note, cost: cost + credits / 1000 };
}

/** Gemini bills thinking tokens as output — they dominate on ranking calls. */
function usageCost(u?: { inputTokens: number; outputTokens: number; thinkingTokens: number }): number {
  if (!u) return 0;
  return (u.inputTokens * 0.75) / 1e6 + ((u.outputTokens + u.thinkingTokens) * 3.75) / 1e6;
}

// ─── Benchmarking, the same way (13 September) ───────────────────────────────

/**
 * Who does this job at the client now, who did it before, and who does it at
 * competitors — found the way Suggestions finds people: Serper searches, then
 * one cheap model call that only sorts a list it is handed. It replaced a top
 * model browsing the web on its own, which cost about $0.25–0.30 a job and
 * wrote LinkedIn links out itself. Here every link is the one the search
 * returned, and nobody can be named who was not in a result.
 *
 * The competitor list comes from the sourcing plan when one exists, so the
 * same companies are not worked out twice.
 */
export interface BenchmarkRun {
  rows: Omit<BenchmarkEntry, "id">[];
  queries: string[];
  credits: number;
  cost: number;
  error?: string;
  note?: string;
}

const BENCH_SORT_PROMPT = (s: SourcingSpec, rows: string[], competitors: string[]) => `You are sorting search results for a recruitment benchmark.

ROLE: ${s.title}
CLIENT: ${s.clientName}${aboutClient(s)}
COMPETITORS: ${competitors.join("; ") || "(none listed)"}

Each numbered line below is a LinkedIn search result: headline and snippet. Decide for each whether the person is:
- incumbent: holds this role, or the closest equivalent, at ${s.clientName} NOW
- predecessor: held it at ${s.clientName} before, and has since moved on
- competitor: holds the equivalent role at another company in the same sector NOW
- skip: anything else — a different function, a much more junior role, unclear, or not at a relevant company

Return ONLY lines in this exact format, one per result you do not skip:
INDEX | KIND | NAME | TITLE | COMPANY | CONFIDENCE | NOTE

- INDEX is the number in square brackets. Never invent one.
- NAME, TITLE and COMPANY come from the result text only. Do not add anything the text does not say.
- CONFIDENCE is high when the result text states the title and company plainly and currently, medium when one is inferred, low otherwise.
- NOTE is one short clause: what makes it current or uncertain.

RESULTS
${rows.join("\n")}`;

export async function benchmarkViaSearch(
  spec: SourcingSpec,
  openingId: string,
  existingPlan: QueryPlan | null = null,
): Promise<BenchmarkRun> {
  const empty: BenchmarkRun = { rows: [], queries: [], credits: 0, cost: 0 };
  if (!serperConfigured()) return { ...empty, error: "no_serper" };

  let cost = 0;
  let plan = existingPlan;
  if (!plan) {
    const planRes = await gemini("plan", PLAN_PROMPT(spec), { maxTokens: 2000 });
    if (!planRes.ok) return { ...empty, error: planRes.reason, note: planRes.detail };
    plan = parsePlan(planRes.text);
    cost += usageCost(planRes.usage);
  }

  const site = `site:${domainsFor(spec.locations, spec.targetNationalities)[0]}`;
  const titles = [spec.title, ...plan.titleVariants.slice(0, 2)];
  // A code or "Confidential Client" is not a company anyone writes on a profile.
  const clientSearchable = !/^(confidential|unknown|internal)\b/i.test(spec.clientName) && spec.clientName.replace(/[^a-z]/gi, "").length >= 3;
  const clientShort = spec.clientName.replace(/\s*\([^)]*\)\s*/g, " ").replace(/\b(PLC|Ltd|Limited|Pvt|Private|Company|Group|Holdings)\b\.?/gi, "").trim();
  const competitors = [...new Set([...spec.targetEmployers, ...plan.employers])]
    .filter((e) => !spec.clientCompanyNames.some((c) => c.toLowerCase() === e.toLowerCase()))
    .slice(0, 8);

  const queries: string[] = [];
  if (clientSearchable) {
    queries.push(`${site} "${titles[0]}" "${clientShort}"`);
    if (titles[1]) queries.push(`${site} "${titles[1]}" "${clientShort}"`);
    queries.push(`${site} "former" OR "ex" "${titles[0]}" "${clientShort}"`);
  }
  const fn = plan.functions[0] ?? titles[0];
  for (const c of competitors) queries.push(`${site} "${c}" "${titles[0]}" OR "${fn}"`);

  let credits = 0;
  const byKey = new Map<string, { url: string; title: string; snippet: string }>();
  // All at once, then read in order: one after another took about half a
  // minute of the run (testing, 22 Sep). The order of the results is kept.
  const results = await Promise.all(queries.map((q) => search(q, 10)));
  for (const r of results) credits += r.credits;
  if (results.some((r) => r.error === "spend_cap")) return { ...empty, queries, credits, cost, error: "spend_cap" };
  for (const r of results) {
    for (const h of r.hits) {
      const key = canonicalProfile(h.url);
      if (!key || spec.alreadyKnown.includes(key) || byKey.has(key)) continue;
      byKey.set(key, { url: displayUrl(key), title: h.title, snippet: h.snippet });
    }
  }
  const found = [...byKey.values()].slice(0, 60);
  if (found.length === 0) return { ...empty, queries, credits, cost, note: clientSearchable ? "nothing_found" : "client_not_searchable" };

  const sort = await gemini("plan", BENCH_SORT_PROMPT(spec, found.map((f, i) => `[${i}] ${f.title} — ${f.snippet.slice(0, 300)}`), competitors), { maxTokens: 3000 });
  if (!sort.ok) return { ...empty, queries, credits, cost, error: sort.reason, note: sort.detail };
  cost += usageCost(sort.usage);

  const now = Date.now();
  const rows: Omit<BenchmarkEntry, "id">[] = [];
  for (const line of sort.text.split("\n")) {
    const f = line.split("|").map((x) => x.trim());
    if (f.length < 6) continue;
    const idx = Number(f[0].replace(/[[\]]/g, ""));
    const kind = f[1]?.toLowerCase();
    if (!Number.isInteger(idx) || idx < 0 || idx >= found.length) continue;
    if (kind !== "incumbent" && kind !== "predecessor" && kind !== "competitor") continue;
    // Only the client's own people can be incumbent or predecessor, and only when the client could be searched.
    if (kind !== "competitor" && !clientSearchable) continue;
    const hit = found[idx];
    const conf = ["high", "medium", "low"].includes(f[5]?.toLowerCase()) ? (f[5].toLowerCase() as BenchmarkEntry["confidence"]) : "low";
    rows.push({
      openingId,
      name: f[2] && !/^unknown$/i.test(f[2]) ? f[2] : null,
      title: f[3] || hit.title,
      company: f[4] || "",
      // Never from the model — always the URL the search returned.
      linkedinUrl: hit.url,
      kind,
      confidence: conf,
      note: f.slice(6).join(" | "),
      sourceUrl: hit.url,
      sourceTitle: hit.title,
      isSelected: false,
      generatedAt: now,
    });
  }
  return { rows, queries, credits, cost: cost + credits / 1000, note: clientSearchable ? undefined : "client_not_searchable" };
}
