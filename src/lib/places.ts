/**
 * Where somebody is, against where a job is.
 *
 * The naive comparison fails on the commonest case this desk has: an opening
 * says "Sri Lanka" and a candidate says "Kurunegala". Neither string contains
 * the other, so a substring test calls that a mismatch and penalises every
 * local candidate on a local role. That is worse than no location test at all,
 * because it fires quietly and pushes the right people down the list.
 *
 * A small gazetteer covering the markets the desk actually works is enough. The
 * live system solves this with a resolver and a cache; if this platform ends up
 * on their backend it should call that instead of keeping two lists.
 */

const COUNTRY_CITIES: Record<string, string[]> = {
  "sri lanka": [
    "colombo", "dehiwala", "moratuwa", "sri jayawardenepura kotte", "negombo",
    "kandy", "galle", "matara", "jaffna", "kurunegala", "anuradhapura",
    "ratnapura", "batticaloa", "trincomalee", "badulla", "gampaha", "kalutara",
    "panadura", "kegalle", "nuwara eliya", "hambantota", "puttalam", "matale",
    "polonnaruwa", "vavuniya", "ampara", "monaragala", "mannar", "kilinochchi",
    "seethawaka", "homagama", "maharagama", "kotte", "rajagiriya", "battaramulla",
    "wattala", "ja-ela", "katunayake", "biyagama", "kelaniya", "peliyagoda",
  ],
  bangladesh: ["dhaka", "chittagong", "chattogram", "khulna", "rajshahi", "sylhet", "gazipur", "narayanganj", "savar", "comilla", "bogra", "mymensingh"],
  maldives: ["male", "malé", "hulhumale", "addu", "fuvahmulah"],
  "united arab emirates": ["dubai", "abu dhabi", "sharjah", "ajman", "al ain", "ras al khaimah", "fujairah"],
  "saudi arabia": ["riyadh", "jeddah", "dammam", "khobar", "mecca", "makkah", "medina", "jubail", "yanbu"],
  qatar: ["doha", "al rayyan", "al wakrah"],
  india: ["chennai", "bangalore", "bengaluru", "mumbai", "delhi", "hyderabad", "kochi", "coimbatore", "pune", "kolkata"],
  "united kingdom": ["london", "manchester", "birmingham", "leeds", "glasgow", "leicester", "bristol", "nottingham"],
  oman: ["muscat", "salalah", "sohar"],
  kuwait: ["kuwait city", "hawalli", "salmiya"],
  bahrain: ["manama", "riffa", "muharraq"],
};

const ALIASES: Record<string, string> = {
  uae: "united arab emirates",
  "u.a.e.": "united arab emirates",
  emirates: "united arab emirates",
  ksa: "saudi arabia",
  uk: "united kingdom",
  britain: "united kingdom",
  england: "united kingdom",
  lanka: "sri lanka",
  ceylon: "sri lanka",
};

const norm = (v: string) =>
  v.toLowerCase().replace(/[^\p{L}\p{N}\s.-]+/gu, " ").replace(/\s+/g, " ").trim();

const CITY_TO_COUNTRY = new Map<string, string>();
for (const [country, cities] of Object.entries(COUNTRY_CITIES)) {
  for (const city of cities) CITY_TO_COUNTRY.set(city, country);
}

export function isCountry(place: string): boolean {
  const n = ALIASES[norm(place)] ?? norm(place);
  return n in COUNTRY_CITIES;
}

/** The country a place sits in, whether it was given as a city or a country. */
export function countryOf(place: string | null | undefined): string | null {
  if (!place) return null;
  // "Kurunegala, Sri Lanka" and "Colombo 03" both resolve. Split BEFORE
  // normalising: `norm` turns commas into spaces, and splitting afterwards
  // left "london united kingdom" as one unknown place (audit finding 51).
  for (const raw of place.split(/[,/|;]/).map(norm)) {
    const part = raw.trim();
    if (!part) continue;
    const aliased = ALIASES[part] ?? part;
    if (aliased in COUNTRY_CITIES) return aliased;
    if (CITY_TO_COUNTRY.has(aliased)) return CITY_TO_COUNTRY.get(aliased)!;
    // "colombo 03" → colombo
    const stripped = aliased.replace(/\s*\d+$/, "");
    if (CITY_TO_COUNTRY.has(stripped)) return CITY_TO_COUNTRY.get(stripped)!;
  }
  return null;
}

export type LocationFit = "match" | "same_country" | "unknown" | "mismatch";

/**
 * How well a candidate's location answers a job's.
 *
 * `unknown` is deliberately not a mismatch. Penalising a candidate because
 * their record is thin punishes the data, not the person — and on 115,000
 * imported CVs the data is often thin.
 */
export function locationFit(
  wanted: string[],
  candidatePlace: string | null | undefined,
): LocationFit {
  if (wanted.length === 0) return "match";
  if (!candidatePlace) return "unknown";

  const mine = norm(candidatePlace);
  const myCountry = countryOf(candidatePlace);

  for (const w of wanted) {
    const target = norm(w);
    if (!target) continue;

    // Same words, either way round: "Colombo" against "Colombo 03".
    if (mine.includes(target) || target.includes(mine)) return "match";

    const targetCountry = countryOf(w);
    if (targetCountry && myCountry && targetCountry === myCountry) {
      // A country-level requirement is answered by any city in it.
      return isCountry(w) ? "match" : "same_country";
    }
  }

  return myCountry ? "mismatch" : "unknown";
}

/**
 * Whether a JD restricts the search to people already in the job's country
 * (13 September, decided with the desk): "local candidates only", "Sri Lankan
 * nationals only", "must be a resident of Bangladesh". Anything short of that
 * never excludes anyone on location — it only ranks them lower.
 */
const LOCAL_ONLY = [
  /\b(?:local|resident|in-country)\s+(?:candidates?|applicants?|hires?|nationals?|residents?|talent)\s+only\b/i,
  /\bonly\s+(?:local|in-country)\s+(?:candidates?|applicants?|hires?|nationals?|residents?)\b/i,
  /\b(?:open|available)\s+(?:only\s+)?to\s+(?:local|in-country)\s+(?:candidates?|applicants?|residents?)(?:\s+only)?\b/i,
  /\b[a-z]+(?:\s[a-z]+)?\s+(?:nationals?|citizens?|residents?)\s+only\b/i,
  /\bmust\s+(?:be|currently\s+be)\s+(?:a\s+)?(?:local|resident|based)\b/i,
  /\bno\s+(?:expat(?:riate)?s?|overseas\s+(?:candidates?|applicants?)|relocation)\b/i,
];
export function localOnlyFromJd(text: string): boolean {
  return LOCAL_ONLY.some((re) => re.test(text));
}
