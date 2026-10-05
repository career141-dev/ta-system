import type { Candidate, Opening } from "@/data/types";
import { jobLevelRank, levelFromTitle, levelSection } from "../../convex/lib/roleLevel";

/**
 * Database matches and database search, shown in level sections — 5 Oct, at
 * the owner's request. A Senior Software Engineer opening reads: Senior (this
 * job's level), then Mid-level, Junior / Associate and Intern below it, each
 * with its own people, best fit first.
 *
 * The ladder and the sections are the matcher's own (convex/lib/roleLevel), so
 * a section means the same thing the engine's level gate means.
 */

/** The candidate's level: the engine's classification where it has one, else their title. */
export function candidateLevel(c: Candidate): number | null {
  return c.currentLevel ?? levelFromTitle(c.currentTitle, c.totalExperienceYears);
}

/** The opening's level: its approved seniority, else its title ("Senior …" reads as Senior). */
export function openingLevel(o: Opening | null | undefined): number | null {
  if (!o) return null;
  return jobLevelRank(o.requirements?.seniorityLevel) ?? levelFromTitle(o.title);
}

export function levelSectionFor(o: Opening | null | undefined, c: Candidate): { order: number; label: string } {
  return levelSection(openingLevel(o), candidateLevel(c));
}

/**
 * Put a list into level sections, keeping the order it came in inside each one
 * — so a list sorted best fit first stays best fit first under every heading.
 */
export function inLevelOrder<T>(items: T[], section: (x: T) => { order: number }): T[] {
  return items
    .map((x, i) => ({ x, i, order: section(x).order }))
    .sort((a, b) => a.order - b.order || a.i - b.i)
    .map((e) => e.x);
}
