// convex/lib/sets.ts
//
// Which set a newly shortlisted CV joins. One rule, called by both copies of
// the numbering: convex/ta/applications.ts (live) and src/data/store.ts (the
// local store), so the two cannot drift apart again.

/** Five CVs sent in one day closes a set. */
export const SET_SIZE = 5;

/** Colombo is UTC+05:30 all year — no daylight saving to account for. */
const COLOMBO_OFFSET_MS = 5.5 * 3_600_000;
const DAY_MS = 86_400_000;

/** Midnight in Colombo for the day containing `at`, as an instant. */
export function colomboDay(at: number): number {
  const shifted = at + COLOMBO_OFFSET_MS;
  return shifted - (((shifted % DAY_MS) + DAY_MS) % DAY_MS) - COLOMBO_OFFSET_MS;
}

export interface SetRow {
  setNumber?: number | null;
  shortlistedAt?: number | null;
}

/** True when any one Colombo day holds five or more of these rows. */
export function hasFullDay(rows: SetRow[], before?: number): boolean {
  const perDay = new Map<number, number>();
  for (const r of rows) {
    if (r.shortlistedAt == null) continue;
    const day = colomboDay(r.shortlistedAt);
    if (before != null && day >= before) continue;
    const n = (perDay.get(day) ?? 0) + 1;
    if (n >= SET_SIZE) return true;
    perDay.set(day, n);
  }
  return false;
}

/**
 * The set a TA's next shortlist joins, given the TA's existing shortlists on
 * the opening.
 *
 * The desk's rule (28 September): a set stays open across days until the TA
 * sends five or more CVs in a single day. That day closes it, however many
 * went — twelve in a day is still one set — and the next day starts the next
 * set from zero. Four on Monday and three on Tuesday are all Set 1; six on
 * Wednesday close Set 1; Thursday's first CV is Set 2.
 *
 * Only days before today can close the open set, so everything sent today
 * stays in the set it started in. This replaced the 25 September "five to a
 * set, the sixth starts the next" rule. Sets numbered under earlier rules
 * keep their numbers; only the next number is decided here.
 */
export function nextSetFor(mine: SetRow[], now: number): number {
  const numbered = mine.filter((r) => r.setNumber != null);
  if (numbered.length === 0) return 1;
  const top = Math.max(...numbered.map((r) => r.setNumber as number));
  const inTop = numbered.filter((r) => r.setNumber === top);
  return hasFullDay(inTop, colomboDay(now)) ? top + 1 : top;
}

/** Whether a set is closed: not the TA's newest, or five sent on one day. */
export function setClosed(setNumber: number, top: number, members: SetRow[]): boolean {
  return setNumber < top || hasFullDay(members);
}
