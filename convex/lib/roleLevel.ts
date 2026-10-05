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
