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
  Application, AssignmentRole, JobPost, LinkVaultEntry, ProfileSuggestion, Stage, User,
} from "@/data/types";
import { isDeskWide, isReadOnly } from "@/lib/auth";

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
 * Table rows: mine, anything a lead put in, and anyone another TA has
 * shortlisted.
 *
 * A row added by a lead, director, admin or ops is handed to the TAs, not
 * claimed — it usually arrives with a note saying what to do with it. Until
 * 25 Sep it showed as "Shortlisted by <lead> — leave this one alone", which
 * is the opposite of what the lead meant.
 */
export function scopeLinks(
  rows: LinkVaultEntry[],
  user: User,
  addedByDeskWide: (userId: string) => boolean,
): Scoped<LinkVaultEntry>[] {
  if (!isScoped(user)) return rows.map((row) => ({ row, takenBy: null }));
  const out: Scoped<LinkVaultEntry>[] = [];
  for (const r of rows) {
    if (r.addedBy === user.id || addedByDeskWide(r.addedBy)) out.push({ row: r, takenBy: null });
    // A headhunted CV uploaded for the row is a claim too: it was hidden from
    // everyone else, so a colleague started on the same person (1 Oct).
    else if (r.outcome === "shortlisted" || r.outcome === "cv_received") out.push({ row: r, takenBy: r.addedBy });
  }
  return out;
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
      return { role: assignment, canSeeSourcing: true, canAct: true, stages: null };
    default:
      // Not on this opening at all.
      return { role: null, canSeeSourcing: false, canAct: false, stages: [] };
  }
}

/** Narrows a list to the stages this seat may see. */
export function visibleToSeat(apps: Application[], seat: Seat): Application[] {
  if (seat.stages === null) return apps;
  const allowed = new Set(seat.stages);
  return apps.filter((a) => allowed.has(a.stage));
}
