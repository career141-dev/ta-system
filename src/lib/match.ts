import type { Application, Candidate, SearchCriteria } from "@/data/types";
import { parseSalary } from "./backup";

/**
 * Turning criteria into a result list — spec §6D.
 *
 * Two kinds of criterion, deliberately separated:
 *
 *   **Hard** — a stated number or enum. Experience, notice, age, salary, gender,
 *   nationality, location. If a TA says "under 30 days notice" they mean it, and
 *   showing 90-day people anyway wastes the only thing the desk is short of.
 *
 *   **Soft** — words. Title, skills, industry, employer. These score, because a
 *   "Senior Merchandiser" is a real answer to "Merchandising Manager" and an
 *   exact-match-only search on job titles finds nothing in a real database.
 *
 * Location is hard on purpose. Colombo to Galle is three hours each way; a near
 * miss there is not a near miss. Where relaxing it would help, the results page
 * offers it as a suggestion rather than doing it silently.
 */

export interface CandidateSignal {
  kind: "free" | "in_pipeline" | "placed" | "rejected_before" | "dropped_before";
  label: string;
  tone: "good" | "warn" | "danger" | "quiet";
}

export interface Result {
  candidate: Candidate;
  score: number;
  /** Criteria this candidate meets, for the row to show without re-deriving. */
  hits: string[];
  /** Soft criteria they miss. Shown, so a partial match never looks like a full one. */
  misses: string[];
  signals: CandidateSignal[];
  apps: Application[];
}

const STOP = new Set(["of", "and", "the", "a", "an", "&", "-"]);

/**
 * Words that say what rank a job is, not what the job is. Two titles sharing
 * only these are not related: a Brand Manager and a Warehouse Manager have the
 * word "Manager" in common and nothing else. Matching on them turned a search
 * for one title into a search for half the database.
 */
const GENERIC_TITLE = new Set([
  "manager", "head", "executive", "officer", "senior", "junior", "lead", "leader",
  "director", "chief", "assistant", "deputy", "general", "associate", "specialist",
]);

function words(s: string | null): Set<string> {
  return new Set(
    (s ?? "")
      .toLowerCase()
      .split(/[^a-z]+/)
      .filter((w) => w.length > 2 && !STOP.has(w)),
  );
}

/** 1 exact · 0.65 strong overlap · 0.4 one word in common · 0 otherwise. */
export function titleScore(candidateTitle: string | null, wanted: string[]): number {
  if (wanted.length === 0) return 0;
  const c = (candidateTitle ?? "").toLowerCase().trim();
  let best = 0;
  for (const w of wanted) {
    const t = w.toLowerCase().trim();
    if (c === t) return 1;
    const a = words(candidateTitle);
    const b = words(w);
    const shared = [...b].filter((x) => a.has(x));
    const meaningful = shared.filter((x) => !GENERIC_TITLE.has(x));
    if (meaningful.length === 0) {
      // Same seniority, different job. Kept barely above zero so it can still
      // surface when nothing else does, but below the relevance floor on its own.
      if (shared.length > 0) best = Math.max(best, 0.1);
      continue;
    }
    const bMeaningful = [...b].filter((x) => !GENERIC_TITLE.has(x)).length;
    best = Math.max(best, meaningful.length >= bMeaningful ? 0.7 : meaningful.length >= 2 ? 0.55 : 0.45);
  }
  return best;
}

function overlap(have: string[], wanted: string[]): { n: number; matched: string[] } {
  const lower = have.map((h) => h.toLowerCase());
  const matched = wanted.filter((w) => lower.some((h) => h.includes(w.toLowerCase()) || w.toLowerCase().includes(h)));
  return { n: wanted.length ? matched.length / wanted.length : 0, matched };
}

/** Expected salary on a CV reads "620K gross". Rupees only — see §14A.1. */
function expectedRupees(c: Candidate): number | null {
  const p = parseSalary(c.expectedSalary);
  if (!p || p.currency !== "LKR") return null;
  return p.amount < 10_000 ? p.amount * 1_000 : p.amount;
}

export function matchCandidate(
  c: Candidate,
  crit: SearchCriteria,
  apps: Application[],
): Result | null {
  const hits: string[] = [];
  const misses: string[] = [];

  // ── Hard filters ──────────────────────────────────────────────────────────
  if (crit.excludeEmployers.some((e) => (c.currentEmployer ?? "").toLowerCase() === e.toLowerCase())) return null;

  if (crit.minExperience !== null) {
    if ((c.totalExperienceYears ?? 0) < crit.minExperience) return null;
    hits.push(`${c.totalExperienceYears} years`);
  }
  if (crit.maxExperience !== null && (c.totalExperienceYears ?? 0) > crit.maxExperience) return null;

  /*
   * Age, gender, notice and English are rarely on a CV record. A missing value
   * used to count as a fail — "(noticePeriodDays ?? 999) > 30" — so asking for
   * "immediate joiners" or "fluent English" emptied a search the engine had
   * filled (21 September). As with salary below: a known value that fails
   * hides the person; an unknown one keeps them and says so on the row.
   */
  if (crit.minAge !== null || crit.maxAge !== null) {
    if (c.age == null) misses.push("age not on file");
    else if ((crit.minAge !== null && c.age < crit.minAge) || (crit.maxAge !== null && c.age > crit.maxAge)) return null;
    else hits.push(`aged ${c.age}`);
  }

  if (crit.gender) {
    if (!c.gender) misses.push("gender not on file");
    else if (c.gender.toLowerCase() !== crit.gender.toLowerCase()) return null;
  }

  if (crit.maxNoticeDays !== null) {
    if (c.noticePeriodDays == null) misses.push("notice not on file");
    else if (c.noticePeriodDays > crit.maxNoticeDays) return null;
    else hits.push(`${c.noticePeriodDays}-day notice`);
  }

  if (crit.minEnglish !== null) {
    if (c.englishLevel == null) misses.push("English level not on file");
    else if (c.englishLevel < crit.minEnglish) return null;
    else hits.push(`English ${c.englishLevel}`);
  }

  if (crit.maxExpectedSalary !== null) {
    const want = expectedRupees(c);
    // No readable expectation is not a reason to hide someone — it is a reason
    // to say so on the row.
    if (want !== null && want > crit.maxExpectedSalary) return null;
    if (want !== null) hits.push(`expects ${Math.round(want / 1000)}K`);
    else misses.push("no expectation on file");
  }

  if (crit.locations.length) {
    // A place is held as the CV wrote it — "Colombo 3, Sri Lanka" — and asked
    // for as a city, so it is a word inside the address, not the whole of it.
    const where = (c.location ?? "").toLowerCase();
    const ok = crit.locations.some((l) => where.includes(l.toLowerCase()));
    if (!ok) return null;
    hits.push(c.location!);
  }

  if (crit.nationalities.length) {
    const ok = crit.nationalities.some((n) => (c.nationality ?? "").toLowerCase() === n.toLowerCase());
    if (!ok) return null;
    hits.push(c.nationality!);
  }

  if (crit.languages.length) {
    const got = crit.languages.filter((l) => c.languages.some((x) => x.toLowerCase() === l.toLowerCase()));
    if (got.length !== crit.languages.length) return null;
    hits.push(...got);
  }

  // ── Availability, from the pipeline rather than a guess ───────────────────
  const live = apps.filter((a) => !["rejected", "dropped_out", "placed"].includes(a.stage));
  const placed = apps.filter((a) => a.stage === "placed");
  if (crit.availability === "free" && live.length > 0) return null;
  if (crit.availability === "in_pipeline" && live.length === 0) return null;
  if (crit.availability === "placed_before" && placed.length === 0) return null;

  // ── Soft scoring ──────────────────────────────────────────────────────────
  let score = 0;
  let weight = 0;

  if (crit.titles.length) {
    const t = titleScore(c.currentTitle, crit.titles);
    score += t * 0.45;
    weight += 0.45;
    if (t >= 0.9) hits.push(c.currentTitle!);
    else if (t > 0) hits.push(`${c.currentTitle} — close`);
    else misses.push(crit.titles.join(" / "));
  }

  if (crit.skills.length) {
    const { n, matched } = overlap(c.skills, crit.skills);
    score += n * 0.3;
    weight += 0.3;
    hits.push(...matched);
    misses.push(...crit.skills.filter((s) => !matched.includes(s)));
  }

  if (crit.industries.length) {
    const { n, matched } = overlap(c.industries, crit.industries);
    score += n * 0.15;
    weight += 0.15;
    hits.push(...matched);
    misses.push(...crit.industries.filter((s) => !matched.includes(s)));
  }

  if (crit.employers.length) {
    const { n, matched } = overlap([c.currentEmployer ?? ""], crit.employers);
    score += n * 0.1;
    weight += 0.1;
    if (matched.length) hits.push(c.currentEmployer!);
    else misses.push(crit.employers.join(" / "));
  }

  if (crit.qualifications.length) {
    const { n, matched } = overlap([c.educationDegree ?? "", c.educationInstitution ?? "", c.qualifications ?? ""], crit.qualifications);
    score += n * 0.1;
    weight += 0.1;
    if (matched.length) hits.push(...matched);
    else misses.push(crit.qualifications.join(" / "));
  }

  const final = weight === 0 ? 1 : score / weight;
  // A profile that misses every word it was asked for is not a weak match, it is
  // a different person. 0.2 is the floor that keeps "close" titles and drops noise.
  if (weight > 0 && final < 0.2) return null;

  return { candidate: c, score: final, hits, misses, signals: signalsFor(apps), apps };
}

export function signalsFor(apps: Application[]): CandidateSignal[] {
  const out: CandidateSignal[] = [];
  const live = apps.filter((a) => !["rejected", "dropped_out", "placed"].includes(a.stage));
  const placed = apps.filter((a) => a.stage === "placed");
  const rejected = apps.filter((a) => a.stage === "rejected");
  const dropped = apps.filter((a) => a.stage === "dropped_out");

  if (live.length) out.push({ kind: "in_pipeline", label: `In ${live.length} live pipeline${live.length > 1 ? "s" : ""}`, tone: "warn" });
  else out.push({ kind: "free", label: "Not on any live opening", tone: "good" });
  if (placed.length) out.push({ kind: "placed", label: "Placed by Career141", tone: "quiet" });
  // Spec §14A.1 — putting someone back in front of a client who already passed
  // is how an agency loses credibility. Say it before the approach, not after.
  if (rejected.length) out.push({ kind: "rejected_before", label: `Rejected on ${rejected.length} previous opening${rejected.length > 1 ? "s" : ""}`, tone: "danger" });
  if (dropped.length) out.push({ kind: "dropped_before", label: "Dropped out of a process before", tone: "danger" });
  return out;
}
