/**
 * What a CV rarely says outright, worked out from what it does say (13 September).
 *
 * Two things the live records almost never carry: nationality (0% of records)
 * and the industries someone has worked in (9%). Both matter to this desk — a
 * client asks for "a Sri Lankan", or for "a digital marketer with apparel
 * experience" — so both are estimated here, without a model, from clues
 * already in the record.
 *
 * Kept deliberately apart:
 *
 *  - FIELD is what a person does — digital marketing, procurement — and comes
 *    from their titles. A digital marketer at MAS is still a digital marketer.
 *  - INDUSTRY is the kind of business they did it in, and comes from each
 *    employer, job by job, with years. The same person has apparel experience.
 *
 * Everything here is an estimate and is labelled so. It ranks; it never
 * excludes anyone on its own.
 */
import type { Candidate } from "@/data/types";
import { countryOf } from "./places";

// ─── Nationality ─────────────────────────────────────────────────────────────

const DIAL_CODES: [string, string][] = [
  ["880", "Bangladeshi"], ["971", "Emirati"], ["966", "Saudi"], ["974", "Qatari"], ["960", "Maldivian"],
  ["968", "Omani"], ["965", "Kuwaiti"], ["973", "Bahraini"], ["94", "Sri Lankan"], ["91", "Indian"],
  ["92", "Pakistani"], ["977", "Nepali"], ["44", "British"], ["60", "Malaysian"], ["65", "Singaporean"],
];

const COUNTRY_TO_NATIONALITY: Record<string, string> = {
  "sri lanka": "Sri Lankan", bangladesh: "Bangladeshi", india: "Indian", pakistan: "Pakistani", maldives: "Maldivian",
  "united arab emirates": "Emirati", "saudi arabia": "Saudi", qatar: "Qatari", oman: "Omani", kuwait: "Kuwaiti",
  bahrain: "Bahraini", "united kingdom": "British", nepal: "Nepali",
};

/** Institutions and places that pin a country when the record names no city. */
const EDUCATION_COUNTRY: [RegExp, string][] = [
  [/\b(?:university of (?:colombo|moratuwa|peradeniya|kelaniya|sri jayewardenepura|ruhuna|jaffna)|sliit|nsbm|iit\b.*sri lanka|open university of sri lanka|cima sri lanka|ca sri lanka|aat sri lanka|slim\b|nibm|g\.?c\.?e\.? (?:o|a)[/ .]?l|advanced level|ordinary level|royal college|ananda college|nalanda college)\b/i, "sri lanka"],
  [/\b(?:dhaka|chittagong|bangladesh university|buet|brac university|north south university|ssc\b|hsc\b)\b/i, "bangladesh"],
  [/\b(?:iit (?:delhi|bombay|madras|kanpur|kharagpur)|anna university|delhi university|university of (?:mumbai|madras|calcutta|delhi)|niit\b|nift\b|cbse)\b/i, "india"],
  [/\b(?:lahore|karachi|punjab university|lums|comsats)\b/i, "pakistan"],
];

export interface Inferred<T> {
  value: T;
  /** A short reason a TA can check: "phone +94, studied in Sri Lanka". */
  basis: string;
  confidence: "high" | "medium" | "low";
}

export function inferNationality(c: Pick<Candidate, "nationality" | "phone" | "location" | "educationInstitution" | "educationDegree" | "workHistory">, cvText = ""): Inferred<string> | null {
  if (c.nationality) return { value: c.nationality, basis: "stated", confidence: "high" };
  const votes = new Map<string, string[]>();
  const vote = (country: string | null, why: string) => {
    const nat = country && COUNTRY_TO_NATIONALITY[country];
    if (!nat) return;
    votes.set(nat, [...(votes.get(nat) ?? []), why]);
  };

  const digits = (c.phone ?? "").replace(/[^\d+]/g, "");
  if (digits.startsWith("+") || digits.startsWith("00")) {
    const d = digits.replace(/^\+|^00/, "");
    const hit = DIAL_CODES.find(([code]) => d.startsWith(code));
    if (hit) votes.set(hit[1], [...(votes.get(hit[1]) ?? []), `phone +${hit[0]}`]);
  } else if (/^0?7\d{8}$/.test(digits)) {
    votes.set("Sri Lankan", [...(votes.get("Sri Lankan") ?? []), "Sri Lankan mobile number"]);
  }

  const edu = `${c.educationInstitution ?? ""} ${c.educationDegree ?? ""} ${cvText.slice(0, 6000)}`;
  const eduCountry = countryOf(c.educationInstitution) ?? EDUCATION_COUNTRY.find(([re]) => re.test(edu))?.[1] ?? null;
  vote(eduCountry, "studied there");

  // The earliest job is usually at home, before any move abroad.
  const first = [...c.workHistory].filter((h) => h.fromYear).sort((a, b) => a.fromYear - b.fromYear)[0];
  if (first) vote(countryOf(first.employer), "first job there");

  vote(countryOf(c.location), "lives there");

  if (votes.size === 0) return null;
  const [best, why] = [...votes.entries()].sort((a, b) => b[1].length - a[1].length)[0];
  const rivals = [...votes.entries()].filter(([n]) => n !== best).length;
  const confidence = why.length >= 2 && rivals === 0 ? "high" : why.length >= 2 || (why[0].startsWith("phone") && rivals === 0) ? "medium" : "low";
  return { value: best, basis: why.join(", "), confidence };
}

// ─── Industry, job by job ────────────────────────────────────────────────────

/** Employer words → industry. Order matters: the first match wins. */
const EMPLOYER_INDUSTRY: [RegExp, string][] = [
  [/\b(?:mas\b|brandix|hirdaramani|hela\b|teejay|stretchline|omega line|timex garments|star garments|jay jay mills|norlanka|nor lanka|kenpark|ocean lanka|hayleys fabric|tech spase|courtaulds|quantum clothing|inqube|fashion ?linq|li ?& ?fung|intimates|apparel|garments?|clothing|textiles?|fabrics?|knit\w*|sweaters?|denim|fashion|lingerie|rmg\b|epic group|pds\b|next sourcing|sourcing (?:bangladesh|ltd|limited)|h&m|c&a|marks (?:and|&) spencer)\b/i, "Apparel & Textile"],
  [/\b(?:bank\b|banking|finance plc|finance company|leasing|capital\b|credit\b|insurance|assurance|securities|investment|lolc|dfcc|hnb\b|sampath|commercial bank|seylan|ndb\b|pan asia)\b/i, "Banking & Financial Services"],
  [/\b(?:hospital|healthcare|health care|pharma\w*|diagnostics|medical|clinic|nawaloka|asiri|durdans|lanka hospitals)\b/i, "Healthcare & Pharma"],
  [/\b(?:logistics|freight|shipping|cargo|forwarding|maritime|ship agency|nvocc|courier|expo lanka|dhl|toll global|kuehne|bollor[eé]|dart global)\b/i, "Logistics & Shipping"],
  [/\b(?:foods?\b|beverages?|biscuit|brewery|breweries|dairy|tea\b|teas\b|spice|confectioner\w*|chocolate|fmcg|consumer brands|cold stores|nestl[eé]|unilever|coca-cola|maliban|munchee|elephant house|cargills|keells food|fonterra|delmege)\b/i, "FMCG & Food"],
  // Only names that mean software: "tech", "systems" and "solutions" also name
  // garment, packaging and trading firms (13 September: Tech Spase and Ocean Lanka
  // were both read as technology).
  [/\b(?:software|information technology|it services|infotech|digital labs|codegen|virtusa|ifs r ?(?:&|and) ?d|wso2|99x|arimac|directfn|millennium ?it|sysco labs|pickme|dialog enterprise|epic lanka|hsenid|calcey|zone24x7|lolc technologies|axiata digital)\b/i, "Technology & Software"],
  [/\b(?:telecom|mobitel|dialog|axiata|airtel|hutch|slt\b)\b/i, "Telecommunications"],
  [/\b(?:hotel|resort|hospitality|cinnamon|jetwing|aitken spence hotel|shangri)\b/i, "Hospitality & Tourism"],
  [/\b(?:construction|builders|engineering (?:plc|pvt|ltd)|access engineering|maga\b|sanken|contracting)\b/i, "Construction & Engineering"],
  [/\b(?:university|campus|college|school|institute|academy|education)\b/i, "Education"],
  [/\b(?:advertising|agency|media\b|communications (?:pvt|ltd)|publishing|newspapers?)\b/i, "Media & Advertising"],
  [/\b(?:retail|supermarket|department store|daraz|keells super|arpico|odel)\b/i, "Retail & E-commerce"],
  [/\b(?:cement|insee|steel|tyres?|packaging|plastics?|paints?|chemicals?|glass|gloves|ansell|manufactur\w*|industries|factory|mills\b|rubber)\b/i, "Manufacturing"],
  [/\b(?:holdings|group of companies|conglomerate|hayleys|john keells|aitken spence|hemas|expolanka|softlogic|abans)\b/i, "Diversified Group"],
];

/** Titles that only exist in one industry, for when the employer says nothing. */
const TITLE_INDUSTRY: [RegExp, string][] = [
  [/\b(?:merchandis\w*|fabric\w*|garment technolog\w*|sewing|pattern maker|washing|knitting|dyeing)\b/i, "Apparel & Textile"],
  [/\b(?:freight|shipping|forwarding|nvocc|customs clearance|documentation executive)\b/i, "Logistics & Shipping"],
  [/\b(?:nurse|pharmacist|medical officer|doctor|radiograph\w*|lab technician)\b/i, "Healthcare & Pharma"],
  [/\b(?:teller|branch manager|credit analyst|relationship manager|underwriter|actuar\w*)\b/i, "Banking & Financial Services"],
  [/\b(?:software engineer|developer|devops|qa engineer|business analyst|product manager|scrum)\b/i, "Technology & Software"],
  [/\b(?:chef|front office|housekeeping|f&b)\b/i, "Hospitality & Tourism"],
];

export function industryOf(employer: string, title = ""): string | null {
  const byEmployer = EMPLOYER_INDUSTRY.find(([re]) => re.test(employer))?.[1] ?? null;
  const byTitle = TITLE_INDUSTRY.find(([re]) => re.test(title))?.[1] ?? null;
  // A group that does everything says less than a title that exists in one industry.
  return byEmployer === "Diversified Group" && byTitle ? byTitle : byEmployer ?? byTitle;
}

export interface IndustryExperience {
  industry: string;
  years: number;
  employers: string[];
}

/** Each industry someone has worked in, with years, most recent first. "Diversified Group" is dropped when the title says more. */
export function industryExperience(c: Pick<Candidate, "workHistory" | "industries" | "currentEmployer" | "currentTitle">, now = new Date().getFullYear()): IndustryExperience[] {
  const rows = new Map<string, IndustryExperience & { last: number }>();
  const add = (industry: string | null, employer: string, years: number, last: number) => {
    if (!industry) return;
    const r = rows.get(industry) ?? { industry, years: 0, employers: [], last: 0 };
    r.years += years;
    if (employer && !r.employers.includes(employer)) r.employers.push(employer);
    r.last = Math.max(r.last, last);
    rows.set(industry, r);
  };
  const history = c.workHistory.length ? c.workHistory : c.currentEmployer ? [{ title: c.currentTitle ?? "", employer: c.currentEmployer, fromYear: 0, toYear: null }] : [];
  for (const h of history) {
    const to = h.toYear ?? now;
    const years = h.fromYear ? Math.max(0.5, to - h.fromYear) : 1;
    add(industryOf(h.employer, h.title), h.employer, years, to);
  }
  for (const i of c.industries) add(i, "", 0, 0);
  return [...rows.values()].sort((a, b) => b.last - a.last || b.years - a.years).map(({ last: _last, ...r }) => r);
}

// ─── What a job asks for ─────────────────────────────────────────────────────

/**
 * The industry a JD asks for experience in, and whether it is a must.
 * "Experience in the apparel industry is essential" → Apparel, required.
 * "FMCG exposure preferred" → FMCG, preferred.
 */
export function industryWanted(jd: string, clientIndustry: string | null): { industry: string; required: boolean } | null {
  const text = jd.replace(/\s+/g, " ");
  const MENTION = /\b(apparel|garment|textile|rmg|fmcg|consumer goods|food|beverage|banking|financial services|insurance|healthcare|hospital|pharma\w*|logistics|freight forwarding|shipping|technology|software|fintech|telecom\w*|hospitality|hotel|construction|manufacturing|retail)\b[^.]{0,40}\b(industry|sector|environment|background|exposure|experience)\b|\b(experience|background|exposure)\b[^.]{0,30}\b(?:in|within|from) (?:the |an? )?(apparel|garment|textile|rmg|fmcg|consumer goods|food|banking|financial services|insurance|healthcare|hospital|pharma\w*|logistics|freight forwarding|shipping|technology|software|fintech|telecom\w*|hospitality|hotel|construction|manufacturing|retail)\b/i;
  // "Fabric technology", "food technology" name a discipline, not the tech industry.
  const m = text.replace(/\b(fabric|textile|garment|food|process|information|production|dyeing|washing|printing|packaging)\s+technolog\w*/gi, "$1-tech").match(MENTION);
  if (!m) return null;
  const word = (m[1] ?? m[4] ?? "").toLowerCase();
  const industry = industryOf(word, word) ?? normaliseIndustry(word) ?? clientIndustry;
  if (!industry) return null;
  const around = text.slice(Math.max(0, (m.index ?? 0) - 80), (m.index ?? 0) + m[0].length + 80);
  const required = !/\b(prefer|advantage|desirable|nice to have|plus|bonus|ideally)\b/i.test(around) && /\b(must|essential|required|mandatory|minimum|proven|strong|extensive|\d+\+? years)\b/i.test(around);
  return { industry, required };
}

export function normaliseIndustry(word: string | null | undefined): string | null {
  if (!word) return null;
  const w = word.toLowerCase();
  if (/apparel|garment|textile|rmg|fashion/.test(w)) return "Apparel & Textile";
  if (/fmcg|consumer|food|beverage/.test(w)) return "FMCG & Food";
  if (/bank|financ|insurance|fintech/.test(w)) return "Banking & Financial Services";
  if (/health|hospital|pharma|medical/.test(w)) return "Healthcare & Pharma";
  if (/logistic|freight|shipping/.test(w)) return "Logistics & Shipping";
  if (/technolog|software|it\b/.test(w)) return "Technology & Software";
  if (/telecom/.test(w)) return "Telecommunications";
  if (/hospitality|hotel|tourism/.test(w)) return "Hospitality & Tourism";
  if (/construction/.test(w)) return "Construction & Engineering";
  if (/manufactur/.test(w)) return "Manufacturing";
  if (/retail|e-?commerce/.test(w)) return "Retail & E-commerce";
  if (/education|academic|school/.test(w)) return "Education";
  return null;
}
