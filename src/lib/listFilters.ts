import type { Candidate } from "@/data/types";

/** The filter rail's fields (components/FilterPanel), as they arrive in the URL. */
export interface CandidateFilterValues {
  minExp?: string;
  maxExp?: string;
  maxNotice?: string;
  location?: string;
  company?: string;
  past?: string;
  skill?: string;
  school?: string;
  industry?: string;
  title?: string;
  nationality?: string;
}

const norm = (s: string | null | undefined) => (s ?? "").toLowerCase().replace(/\s+/g, " ").trim();
const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Every word typed appears in the field, each at the start of a word.
 *
 * "Colombo" finds "Colombo 03, Sri Lanka" and "cargills" finds "Cargills
 * (Ceylon) PLC". Location was an exact comparison, so almost nobody matched
 * it, and plain substrings let "ma" find "Colombo Ma..." (28 Sep).
 */
function wordsIn(hay: string | null | undefined, needle: string): boolean {
  const h = norm(hay);
  return norm(needle)
    .split(" ")
    .filter(Boolean)
    .every((w) => new RegExp(`(^|[^a-z0-9])${escape(w)}`).test(h));
}

/** The whole term as a word: "Java" is not "JavaScript", "SAP" is not "SAPUI5". */
function termIn(list: string[], needle: string): boolean {
  const n = norm(needle);
  const re = new RegExp(`(^|[^a-z0-9])${escape(n)}($|[^a-z0-9])`);
  return list.some((x) => re.test(norm(x)));
}

/**
 * Whether one candidate passes the rail.
 *
 * A number asked for and not on file fails: someone whose experience is
 * unknown is not "up to 3 years" (they counted as 0 and passed) any more than
 * they are "10+ years".
 */
export function passesFilters(c: Candidate, f: CandidateFilterValues): boolean {
  const years = c.totalExperienceYears;
  if (f.minExp && (years == null || years < Number(f.minExp))) return false;
  if (f.maxExp && (years == null || years > Number(f.maxExp))) return false;
  if (f.maxNotice && (c.noticePeriodDays == null || c.noticePeriodDays > Number(f.maxNotice))) return false;

  if (f.location && !wordsIn(c.location, f.location)) return false;
  if (f.company && !wordsIn(c.currentEmployer, f.company)) return false;
  if (f.title && !wordsIn(c.currentTitle, f.title)) return false;
  if (f.school && !wordsIn(c.educationInstitution, f.school)) return false;
  if (f.nationality && !wordsIn(c.nationality, f.nationality)) return false;
  if (f.past && !c.workHistory.some((w) => wordsIn(w.employer, f.past!))) return false;
  if (f.skill && !termIn(c.skills, f.skill)) return false;
  if (f.industry && !termIn(c.industries, f.industry)) return false;
  return true;
}
