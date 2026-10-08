import type { Candidate, Opening } from "@/data/types";
import { LEVEL_LABEL, jobLevelRank, levelFromTitle, levelSection } from "../../convex/lib/roleLevel";

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

/**
 * The level filter on Database search (8 Oct, at the owner's request). The
 * results used to be cut into level sections under headings; now they stay in
 * best-fit order and the levels they hold are a list beside them, with how many
 * people sit at each, for the TA to tick. A Senior Software Engineer search
 * lists Senior, Mid-level, Junior / Associate… — whatever the matched people
 * are, nearest the job's own level first.
 */
export type LevelOption = {
  /** The rank as text, or "x" for a level that is not known — what the URL carries. */
  key: string;
  name: string;
  /** How it sits against the job: "this job's level", "one level below"… Null without a job. */
  note: string | null;
  order: number;
  count: number;
};

export function levelKey(c: Candidate): string {
  const r = candidateLevel(c);
  return r === null ? "x" : String(r);
}

export function levelOptions(o: Opening | null | undefined, candidates: Candidate[]): LevelOption[] {
  const job = openingLevel(o);
  const by = new Map<string, LevelOption>();
  for (const c of candidates) {
    const rank = candidateLevel(c);
    const key = rank === null ? "x" : String(rank);
    const held = by.get(key);
    if (held) {
      held.count++;
      continue;
    }
    const name = rank === null ? "Level not known" : (LEVEL_LABEL[rank] ?? `Level ${rank}`);
    const below = job !== null && rank !== null ? job - rank : null;
    const note =
      below === null
        ? null
        : below < 0
          ? "above this job's level"
          : below === 0
            ? "this job's level"
            : below === 1
              ? "one level below"
              : below === 2
                ? "two levels below"
                : `${below} levels below`;
    by.set(key, { key, name, note, order: levelSection(job, rank).order, count: 1 });
  }
  return [...by.values()].sort((a, b) => a.order - b.order);
}

/** Nothing ticked means everyone; otherwise only the ticked levels. */
export function inSelectedLevels(c: Candidate, selected: ReadonlySet<string>): boolean {
  return selected.size === 0 || selected.has(levelKey(c));
}
