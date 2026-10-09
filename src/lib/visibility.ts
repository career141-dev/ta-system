/**
 * Who sees whose work — the 12 Sep rule.
 *
 * Two TAs can be on one opening, and each of them works their own desk: their
 * own posts, their own applicants, their own sourcing, their own table. They do
 * not read each other's pipelines, because a shared list of 40 half-worked
 * profiles is how two people ring the same person on the same afternoon.
 *
 * There is exactly one hole in the wall, and it is the reason the wall works:
 * **the moment a profile is shortlisted, everyone on the opening can see it,
 * marked with whose it is.** That is the collision lock of §9 read from the
 * other side — first to shortlist owns, and the owning is announced so the
 * second TA spends their afternoon on somebody else.
 *
 * Leads, directors, ops and admin are never narrowed. They review the desk;
 * a review that cannot see half of it is not a review.
 */

import type {
  Application, AssignmentRole, JobPost, LinkVaultEntry, ProfileSuggestion, Stage, StrategyAssignment, User,
} from "@/data/types";
import { isDeskWide, isReadOnly } from "@/lib/auth";
import { isTicked } from "@/lib/strategyPlanner";

/**
 * Whose view is narrowed: everybody who is not desk-wide.
 *
 * This read "only a TA" until the 13 September audit, which is how a client
 * account came to receive an unrestricted seat — `client` is not `ta`, so it
 * fell out of the narrowing and into the branch meant for directors. The
 * question is not "are you a recruiter", it is "do you review the whole desk".
 */
export function isScoped(user: User): boolean {
  return !isDeskWide(user);
}

/** A row, and whether the person looking at it may act on it. */
export interface Scoped<T> {
  row: T;
  /** Someone else's, surfaced only because they have claimed it. */
  takenBy: string | null;
}

/** Posts a TA may see: the ones assigned to them. */
export function visiblePosts(posts: JobPost[], user: User): JobPost[] {
  if (!isScoped(user)) return posts;
  return posts.filter((p) => p.assignedTaId === user.id);
}

/**
 * Applicants a TA may see: the ones on their posts, the ones they own, and
 * anybody another TA has already shortlisted.
 */
export function scopeApplications(
  apps: Application[],
  posts: JobPost[],
  user: User,
): Scoped<Application>[] {
  if (!isScoped(user)) return apps.map((row) => ({ row, takenBy: null }));

  const mine = new Set(visiblePosts(posts, user).map((p) => p.id));
  const out: Scoped<Application>[] = [];

  for (const a of apps) {
    const ownedByMe = a.ownerTaId === user.id;
    const onMyPost = a.jobPostId ? mine.has(a.jobPostId) : false;
    const claimedByOther = !!a.ownerTaId && a.ownerTaId !== user.id;

    if (ownedByMe || (onMyPost && !claimedByOther)) out.push({ row: a, takenBy: null });
    // Shortlisted by the other TA — shown so it is not worked twice, and only
    // for that reason. An unclaimed row on their post stays theirs.
    else if (claimedByOther && a.shortlistedAt) out.push({ row: a, takenBy: a.ownerTaId! });
  }
  return out;
}

/**
 * Table rows: mine, and anything a lead put in. Nobody else's.
 *
 * A row added by a lead, director, admin or ops is handed to the TAs, not
 * claimed — it usually arrives with a note saying what to do with it. Until
 * 25 Sep it showed as "Shortlisted by <lead> — leave this one alone", which
 * is the opposite of what the lead meant.
 *
 * Another TA's rows are not shown at all (5 Oct). Until then a row the other
 * TA had taken on — on the pipeline from it, or its CV uploaded — appeared
 * greyed out as "Shortlisted by Hassan — leave this one alone", so two TAs on
 * one opening still read each other's work. The collision it guarded against
 * is caught where it happens: pasting a link already in the table is refused
 * with whose it is (addLink, app/actions.ts).
 */
export function scopeLinks(
  rows: LinkVaultEntry[],
  user: User,
  addedByDeskWide: (userId: string) => boolean,
): Scoped<LinkVaultEntry>[] {
  if (!isScoped(user)) return rows.map((row) => ({ row, takenBy: null }));
  return rows
    .filter((r) => r.addedBy === user.id || addedByDeskWide(r.addedBy))
    .map((row) => ({ row, takenBy: null }));
}

/**
 * Suggestions: a run belongs to whoever asked for it. Profiles kept by the
 * other TA appear whatever their run, because keeping is the claim.
 */
export function scopeSuggestions(
  rows: ProfileSuggestion[],
  user: User,
): Scoped<ProfileSuggestion>[] {
  if (!isScoped(user)) return rows.map((row) => ({ row, takenBy: null }));
  const out: Scoped<ProfileSuggestion>[] = [];
  for (const s of rows) {
    // A run from before ownership was recorded belongs to nobody, so it stays
    // visible rather than vanishing out of the desk's history.
    const mine = !s.generatedFor || s.generatedFor === user.id;
    if (mine) out.push({ row: s, takenBy: s.keptBy && s.keptBy !== user.id ? s.keptBy : null });
    else if (s.status === "kept" && s.keptBy) out.push({ row: s, takenBy: s.keptBy });
  }
  return out;
}

/** Convenience for pages that only need the rows. */
export const rowsOf = <T,>(scoped: Scoped<T>[]): T[] => scoped.map((s) => s.row);


// ─── What somebody is on one opening ─────────────────────────────────────────

/**
 * The assignment layer, added 12 September alongside the roles themselves.
 *
 * A user role says what kind of person you are across the desk. An assignment
 * says what you are on *this* opening. The two are different and the second is
 * what makes a client contact possible: somebody who can be given their own
 * shortlist without also being handed the sourcing that produced it, the
 * profiles that were approached and went nowhere, and everyone rejected along
 * the way.
 */

/** Stages a client contact is allowed to see. Everything before the client
 *  shortlist is the desk's working-out, and showing a client the rejects on the
 *  way to their five is how a shortlist stops looking considered. */
const CLIENT_VISIBLE: Stage[] = ["client_shortlist", "interview", "offer", "placed"];

export interface Seat {
  role: AssignmentRole | null;
  /** Sourcing, the Excel table, suggestions, research, benchmarking. */
  canSeeSourcing: boolean;
  /** Move people, log calls, edit the record. */
  canAct: boolean;
  /** Which stages they may see at all. Null means every stage. */
  stages: Stage[] | null;
  /**
   * Set for a TA working an opening beside another: they see the unclaimed pool
   * and their own candidates, never a colleague's. Null for everyone who
   * reviews the desk — a lead has to see both TAs' work (2 Oct).
   */
  ownDeskOf?: string | null;
}

export function seatFor(user: User, assignment: AssignmentRole | null | undefined): Seat {
  if (!user.isActive) return { role: null, canSeeSourcing: false, canAct: false, stages: [] };

  // Leads, directors, ops and admin are never narrowed by an assignment —
  // they review the desk, and a review that cannot see half of it is not one.
  if (!isScoped(user)) {
    return { role: assignment ?? null, canSeeSourcing: true, canAct: true, stages: null };
  }

  // A viewer is read-only wherever they are put, including on an opening that
  // has named them a recruiter.
  if (isReadOnly(user)) {
    return {
      role: assignment ?? null,
      canSeeSourcing: !!assignment && assignment !== "client_contact",
      canAct: false,
      stages: assignment === "client_contact" ? CLIENT_VISIBLE : assignment ? null : [],
    };
  }

  // A client account is a client seat whatever the assignment says, because the
  // assignment is set by the desk and the account is held outside it.
  if (user.role === "client") {
    return { role: assignment ?? "client_contact", canSeeSourcing: false, canAct: false, stages: CLIENT_VISIBLE };
  }

  switch (assignment) {
    case "client_contact":
      return { role: assignment, canSeeSourcing: false, canAct: false, stages: CLIENT_VISIBLE };
    case "director":
      return { role: assignment, canSeeSourcing: true, canAct: true, stages: null };
    case "primary_recruiter":
    case "supporting_recruiter":
      return { role: assignment, canSeeSourcing: true, canAct: true, stages: null, ownDeskOf: user.role === "ta" ? user.id : null };
    default:
      // Not on this opening at all.
      return { role: null, canSeeSourcing: false, canAct: false, stages: [] };
  }
}

/**
 * Narrows a list to what this seat may see: its stages, and — for a TA — not a
 * colleague's candidates. Every candidate list, the desk assistant and the
 * candidate page pass through here, so two TAs on one job work apart without
 * each screen having to remember it (2 Oct).
 */
export function visibleToSeat(apps: Application[], seat: Seat): Application[] {
  const mine = seat.ownDeskOf;
  const owned = mine ? apps.filter((a) => !a.ownerTaId || a.ownerTaId === mine) : apps;
  if (seat.stages === null) return owned;
  const allowed = new Set(seat.stages);
  return owned.filter((a) => allowed.has(a.stage));
}

/**
 * What the desk assistant may tell this person about one opening (6 Oct).
 *
 * Exactly their seat (`visibleToSeat`) — for a TA beside another, their own
 * candidates and the unclaimed pool, the same rows the candidate lists show.
 * On top of that, the one hole in the 12 Sep wall: a colleague's candidate
 * once shortlisted, as `takenBy`, so the assistant can say "shortlisted by
 * Sanduni — leave this one" without a number, an email or a link.
 *
 * Until now the assistant filtered follow-ups by "any TA on the opening" and
 * read all posts, so it listed a co-TA's follow-ups, phones included, and
 * their posts' counts. Action proposals already read `visibleToSeat`,
 * which is these rows less the `takenBy` ones, plus the collision lock.
 */
export function deskScope(apps: Application[], seat: Seat): Scoped<Application>[] {
  const own = visibleToSeat(apps, seat).map((row) => ({ row, takenBy: null as string | null }));
  if (!seat.ownDeskOf) return own;
  const mine = seat.ownDeskOf;
  const taken = apps
    .filter((a) => a.ownerTaId && a.ownerTaId !== mine && a.shortlistedAt)
    .map((row) => ({ row, takenBy: row.ownerTaId }));
  return [...own, ...taken];
}

/**
 * An Excel Tables row that is another TA's to work: added by a TA who is not
 * the viewer. A row a lead put in is handed to the TAs, so it is nobody's.
 * Leads, directors, admin and ops are never kept out of a row.
 */
export function rowIsAnotherTas(
  row: Pick<LinkVaultEntry, "addedBy">,
  user: User,
  addedByDeskWide: (userId: string) => boolean,
): boolean {
  if (!isScoped(user)) return false;
  return row.addedBy !== user.id && !addedByDeskWide(row.addedBy);
}

/**
 * The job's strategy table, as each person may see it (8 Oct).
 *
 * A TA sees the strategies ticked for the job, and the rows struck through, so
 * they know what not to use (9 Oct: it was only the rows they were on until the
 * lead asked for the tick box). They do not see strategies nobody ticked, even
 * when they are named on one. Leads, directors, ops and admin see every row. A
 * client or viewer account sees none: the table is how the desk works a job.
 * Applied on every read, not only on the TA's page: every assignee can open
 * every page of an opening, so the page cannot be the guard.
 */
export function scopeStrategies(rows: StrategyAssignment[], user: User): StrategyAssignment[] {
  if (!isScoped(user)) return rows;
  if (user.role !== "ta") return [];
  return rows.filter((r) => isTicked(r) || r.notApplicable);
}
