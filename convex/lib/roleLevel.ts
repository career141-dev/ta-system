/**
 * The one ladder a job's level and a candidate's current level are both read
 * on, for the reverse-match engine's current-role gate (matching/agent2).
 *
 * Fixed 5 Oct: the job and the candidate were graded on two different ladders.
 * The candidate classifier (lib/currentRoleClassifier) puts intern 0, junior 1,
 * mid 2, senior 3, lead 4, manager 5 …; the job side put entry 0, mid 1,
 * executive 2, senior executive 3, manager 4 …. So a mid-level person was "one
 * level above" a mid-level job and dropped as overqualified, a junior was
 * dropped from an entry-level job, and real managers were dropped from manager
 * jobs. The job side now maps onto the candidate classifier's ladder, because
 * that one is cached on 78,000 candidate records and the job side is not.
 *
 *   0 Intern / Apprentice
 *   1 Entry-level / Junior / Associate
 *   2 Mid-level individual contributor (Executive)
 *   3 Senior individual contributor (Senior Executive)
 *   4 Lead / Assistant Manager / Team Lead
 *   5 Manager
 *   6 Senior Manager / Head of Department
 *   7 AGM / DGM
 *   8 GM / VP / Country Manager
 *   9 Director / C-suite
 */

/** A job's seniority (the schema's levels, or loose wording) on the ladder above; null skips the gate. */
export function jobLevelRank(seniorityLevel?: string | null): number | null {
  if (!seniorityLevel) return null;
  const s = seniorityLevel.toLowerCase().trim().replace(/[\s-]+/g, "_");
  if (s.includes("intern") || s.includes("apprentice")) return 0;
  if (s.includes("entry") || s === "junior" || s === "associate") return 1;
  if (s === "mid_level" || s === "mid" || s === "executive") return 2;
  if (s === "senior_executive" || s === "senior") return 3;
  if (s === "lead" || s === "assistant_manager") return 4;
  if (s === "manager") return 5;
  if (s === "senior_manager") return 6;
  if (s === "agm" || s === "dgm" || s.includes("assistant_general") || s.includes("deputy_general")) return 7;
  if (s === "gm" || s.includes("general_manager") || s === "vp" || s.includes("vice_president")) return 8;
  if (s === "director" || s === "c_suite" || s.includes("chief")) return 9;
  return null; // "other", custom, or unmapped -> skip gate
}

/** What each rung is called on screen. */
export const LEVEL_LABEL: readonly string[] = [
  "Intern / Trainee",
  "Junior / Associate",
  "Mid-level",
  "Senior",
  "Lead / Assistant Manager",
  "Manager",
  "Senior Manager / Head",
  "AGM / DGM",
  "GM / VP",
  "Director / C-suite",
];

/**
 * A candidate's level from their current title, for people the engine's
 * classifier has not seen yet — database search reaches far more people than
 * reverse matching ever classifies. Most specific wording first, so an
 * "Assistant General Manager" is not read as a manager or an assistant.
 */
export function levelFromTitle(title: string | null | undefined, years?: number | null): number | null {
  const t = ` ${String(title ?? "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim()} `;
  if (!t.trim()) return null;
  const has = (re: RegExp) => re.test(t);
  if (has(/ (agm|dgm|assistant general manager|deputy general manager) /)) return 7;
  if (has(/ (assistant manager|asst manager|team lead|team leader|lead|principal) /)) return 4;
  if (has(/ (senior manager|sr manager|head of|head) /)) return 6;
  if (has(/ (general manager|gm|country manager|vice president|vp) /)) return 8;
  if (has(/ (chief|ceo|cto|cfo|coo|cio|director|managing director|president|founder) /)) return 9;
  if (has(/ manager /)) return 5;
  if (has(/ (intern|internship|apprentice) /)) return 0;
  if (has(/ (senior|sr|snr) /)) return 3;
  if (has(/ (junior|jr|associate|graduate|trainee|entry|assistant) /)) return 1;
  // No level word ("Software Engineer", "Accountant", "Executive"): the
  // working level, unless they have under two years behind them.
  return years != null && years > 0 && years < 2 ? 1 : 2;
}

/**
 * The sections a list of candidates is shown in — 5 Oct, at the owner's
 * request: under each level, the people at that level, highest level first.
 *
 * With a job: its own level, then each level below it (the levels matching
 * looks at), then anyone above it, then anyone whose level is not known.
 * Without a job (a plain database search): every level, highest first.
 */
export function levelSection(
  jobRank: number | null,
  candRank: number | null,
): { order: number; label: string } {
  if (candRank === null) return { order: 100, label: "Level not known" };
  const name = LEVEL_LABEL[candRank] ?? `Level ${candRank}`;
  if (jobRank === null) return { order: 9 - candRank, label: name };
  const below = jobRank - candRank;
  if (below < 0) return { order: 50 + candRank, label: `${name} — above this job's level` };
  if (below === 0) return { order: 0, label: `${name} — this job's level` };
  return { order: below, label: `${name} — ${below === 1 ? "one level" : below === 2 ? "two levels" : `${below} levels`} below` };
}

export type CurrentRoleGate = "pass" | "pass_with_penalty" | "excluded_overqualified" | "skipped_other";

/**
 * The gate itself, unchanged in what it decides — only the ladder under it was
 * wrong. Above the job: out. Same level or one below: in. Further below: in,
 * with a penalty that grows per level.
 */
export function currentRoleGate(jobRank: number | null, candRank: number | null): { gate: CurrentRoleGate; penalty: number } {
  if (jobRank === null) return { gate: "skipped_other", penalty: 0 };
  if (candRank === null) return { gate: "pass", penalty: 0 };
  const delta = jobRank - candRank;
  if (delta < 0) return { gate: "excluded_overqualified", penalty: 0 };
  if (delta <= 1) return { gate: "pass", penalty: 0 };
  return { gate: "pass_with_penalty", penalty: Math.max(-40, -12 * (delta - 1)) };
}
