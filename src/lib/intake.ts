import type { ExtractedBrief, PriorityTier } from "@/data/types";

/**
 * Brief extraction.
 *
 * This is deliberately NOT a stub that invents plausible-looking values. It
 * reads what is actually written in the notes and leaves everything else blank,
 * because a field the system guessed wrong is worse than a field a TA has to
 * fill in — the first is a mistake nobody notices, the second is two seconds.
 *
 * Spec §5: the TA edits every field before anything becomes an Opening.
 *
 * When a model is wired in later it replaces `extractFromText` and keeps this
 * signature. The heuristics below stay useful as the offline fallback.
 */

const KNOWN_LOCATIONS = [
  "Colombo", "Gampaha", "Kandy", "Negombo", "Nugegoda", "Dehiwala", "Kurunegala",
  "Galle", "Jaffna", "Horana", "Sri Lanka", "Bangladesh", "Dhaka", "India",
  "Turkey", "Maldives", "Dubai", "UAE", "Uzbekistan", "Indonesia", "Pakistan",
];

const NATIONALITIES = ["Sri Lankan", "Indian", "Bangladeshi", "Pakistani", "Filipino", "Nepali"];

/**
 * "800K", "LKR 800,000", "USD 7,500", "1.2m" — the ways the desk actually
 * writes money.
 *
 * Recruitment notes are full of large numbers that are NOT salaries: turnover
 * a candidate handled, company revenue, headcount of a plant. Those are read as
 * context and discarded, because a wrong salary band silently mis-scopes the
 * whole search.
 */
const NOT_SALARY = /\b(turnover|revenue|sales of|worth|valuation|budget of|p&l|portfolio)\b/i;

function parseMoney(text: string): { min: number | null; max: number | null; currency: string } {
  const currency = /\busd?\b|\$/i.test(text) ? "USD" : "LKR";

  const nums: number[] = [];
  // "3L" / "3.5 lakhs" is how Sri Lankan packages are said — "package around
  // 3L" was read as nothing and the JD printed "Around 3L" (testing, 21 Sep).
  const re = /(?:lkr|usd|rs\.?|\$)?\s*([\d][\d,.]*)\s*(k|m|million|lakhs?|lacs?|l)?\b/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    const raw = m[1].replace(/,/g, "").replace(/\.$/, "");
    if (!raw || Number.isNaN(Number(raw))) continue;
    let n = Number(raw);
    const unit = (m[2] ?? "").toLowerCase();
    if (unit === "k") n *= 1_000;
    if (unit === "m" || unit === "million") n *= 1_000_000;
    if (unit === "l" || unit.startsWith("lakh") || unit.startsWith("lac")) n *= 100_000;
    if (n < 1_000 || n > 100_000_000) continue;

    // Look at the words either side. A figure sitting next to "turnover" or
    // "revenue" belongs to the candidate's track record, not the package.
    const around = text.slice(Math.max(0, m.index - 60), m.index + m[0].length + 40);
    if (NOT_SALARY.test(around)) continue;

    nums.push(n);
  }

  if (nums.length === 0) return { min: null, max: null, currency };
  const sorted = [...new Set(nums)].sort((a, b) => a - b);
  const min = sorted[0];
  const rest = sorted.slice(1);
  // A band wider than ten times the floor is not a band — drop the top rather
  // than assert a range nobody said.
  const max = rest.length ? rest[rest.length - 1] : null;
  return { min, max: max !== null && max <= min * 10 ? max : null, currency };
}

const WORD_NUMBERS: Record<string, number> = {
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
};

function parseHeadcount(text: string): number {
  const digits = text.match(/\b(\d{1,2})\s*(?:positions?|vacancies|headcount|people|roles?|seats?)\b/i);
  if (digits) return Math.max(1, Number(digits[1]));
  const words = text.match(
    /\b(one|two|three|four|five|six|seven|eight|nine|ten)\s*(?:positions?|vacancies|roles?|seats?)\b/i,
  );
  if (words) return WORD_NUMBERS[words[1].toLowerCase()] ?? 1;
  return 1;
}

/**
 * P1–P5 from the workbook's Guidelines tab, inferred only from explicit urgency.
 *
 * Negations are tested first and on purpose: "not urgent" contains "urgent",
 * and reading it as P1 would put a relaxed role on a two-week clock and have
 * the stale-role alert chasing a TA who is not late.
 */
function parseTier(text: string): PriorityTier {
  const t = text.toLowerCase();
  if (/\b(p5|no rush|not urgent|no hurry|when(?:ever)? (?:you|they) can)\b/.test(t)) return "P5";
  if (/\bp4\b/.test(t)) return "P4";
  if (/\bp2\b|\b(?:three|3) weeks\b/.test(t)) return "P2";
  if (/\bp1\b|\b(?<!not )urgent\b|\basap\b|\bimmediately\b|\b(?:two|2) weeks\b/.test(t)) return "P1";
  return "P3";
}

/** The title is the hardest thing to guess, so we only take it when it is
 *  stated in a form the desk actually uses. Otherwise we leave it empty. */
function parseTitle(text: string): string {
  const patterns = [
    /(?:looking for|hiring|need|require|recruit(?:ing)?)\s+(?:a|an|one)?\s*([A-Z][\w&/\- ]{3,48}?)(?:\s+for\b|\s+at\b|[.,\n]|$)/i,
    /^(?:position|role|title)\s*[:\-]\s*(.{3,50})$/im,
  ];
  for (const p of patterns) {
    const m = text.match(p);
    if (m?.[1]) return m[1].trim().replace(/\s+/g, " ");
  }
  // A short first line is very often just the title.
  const first = text.trim().split("\n")[0]?.trim() ?? "";
  if (first && first.length <= 50 && !/[.!?]$/.test(first)) return first;
  return "";
}

function parseList(text: string): string[] {
  return text
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => /^[-•*>]\s+/.test(l))
    .map((l) => l.replace(/^[-•*>]\s+/, "").trim())
    .filter(Boolean);
}

/**
 * What the notes say in sentences — everything but the bullet list, which is
 * the requirements. The template's Notes section printed "None recorded" over
 * a TA's saved notes because this was never filled in (testing, 21 Sep).
 */
function proseOf(text: string): string {
  return text
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l && !/^[-•*>]\s+/.test(l) && !/^from the recording:?$/i.test(l))
    .join("\n");
}

export function extractFromText(text: string): ExtractedBrief {
  const money = parseMoney(text);
  return {
    title: parseTitle(text),
    salaryMin: money.min,
    salaryMax: money.max,
    currency: money.currency,
    packageNotes:
      text.match(/\b(?:plus|with|\+)\s+([^.\n]{3,60}(?:vehicle|fuel|accommodation|driver|allowance)[^.\n]{0,30})/i)?.[0]?.trim() ??
      "",
    locations: KNOWN_LOCATIONS.filter((l) => new RegExp(`\\b${l}\\b`, "i").test(text)),
    nationalities: NATIONALITIES.filter((n) => new RegExp(`\\b${n}\\b`, "i").test(text)),
    headcount: parseHeadcount(text),
    mustHaves: parseList(text),
    clientNotes: proseOf(text),
    priorityTier: parseTier(text),
  };
}

export const EMPTY_EXTRACT: ExtractedBrief = {
  title: "",
  salaryMin: null,
  salaryMax: null,
  currency: "LKR",
  packageNotes: "",
  locations: [],
  nationalities: [],
  headcount: 1,
  mustHaves: [],
  clientNotes: "",
  priorityTier: "P3",
};

/**
 * JD generation from the approved fields. Template-driven and deterministic —
 * it will be replaced by a model, but a template that says only what the brief
 * says is safer than prose that invents requirements nobody asked for.
 */
export function buildJd(e: ExtractedBrief, clientName: string): string {
  const money =
    e.salaryMin && e.salaryMax
      ? `${e.currency} ${e.salaryMin.toLocaleString()} – ${e.salaryMax.toLocaleString()}`
      : e.salaryMin
        ? // One figure is what was said ("around 3L"), not a floor.
          `${e.currency} ${e.salaryMin.toLocaleString()}`
        : "";
  const pkg = [money, e.packageNotes].filter(Boolean).join(" ");

  // Only what is known. Placeholders ("To be completed from the client
  // brief", "None recorded") went out to candidates as if they were the JD.
  const lines = [
    `## ${e.title || "Untitled role"}`,
    "",
    `**Client** ${clientName}`,
    e.locations.length ? `**Location** ${e.locations.join(", ")}` : null,
    pkg ? `**Package** ${pkg}` : null,
    e.nationalities.length ? `**Nationality** ${e.nationalities.join(", ")} only` : null,
    e.headcount > 1 ? `**Headcount** ${e.headcount}` : null,
    ...(e.mustHaves.length ? ["", "### Requirements", "", ...e.mustHaves.map((m) => `- ${m}`)] : []),
    ...(e.clientNotes.trim() ? ["", "### About the role", "", e.clientNotes.trim()] : []),
  ].filter((l) => l !== null) as string[];

  return lines.join("\n");
}

/** Spec §5.3 — stored verbatim with each acknowledgement, so a later change to
 *  the wording never rewrites what someone actually agreed to. */
export const CONSENT_TEXT =
  "This call is being recorded by Career141 for recruitment purposes. The recording and its transcript are stored in the Career141 platform and are accessible to the assigned recruitment team. Confirm that everyone on the call has been told and has agreed.";
