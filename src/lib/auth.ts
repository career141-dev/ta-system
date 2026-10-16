/**
 * One authorization policy, checked on the server, for the whole platform.
 *
 * The 13 September audit found the same fault in three shapes: a client seat
 * that was never narrowed, an interface that hid buttons without refusing the
 * writes behind them, and decision stages a recruiter could walk their own
 * candidate through. All three are the same missing thing — a policy that
 * lives in one place and is asked, rather than a habit of hiding controls.
 *
 * The rule this module exists to hold: **hiding a control is a courtesy, not a
 * permission check.** Every server action asks `must` before it writes, and the
 * interface asks `can` to decide what to draw. When they disagree the action
 * wins, because the action is the one an attacker reaches.
 *
 * Two layers, deliberately kept apart:
 *
 *   **Role** — what kind of person you are across the desk. A director reviews
 *   shortlists everywhere; a viewer reads and never writes, anywhere.
 *
 *   **Assignment** — what you are on *this* opening. It is what makes a client
 *   contact possible: their own shortlist without the sourcing behind it.
 *
 * You need both. A TA with no assignment to an opening is a stranger to it.
 */

import type { Assignment, Id, Role, User } from "@/data/types";

export type Capability =
  /** See the opening exists, and the stages this seat is allowed. */
  | "opening.read"
  /** Move candidates, log calls, chase, edit a candidate record on it. */
  | "opening.act"
  /** Edit the opening itself: terms, posts, team, status, deletion. */
  | "opening.manage"
  /** Headhunting, the link table, suggestions, research, benchmarking. */
  | "opening.sourcing"
  /** Leave a note for the TA on an Excel Tables row. */
  | "link.note"
  /** Leave a note on a candidate in Director review. */
  | "review.note"
  /** Record a decision that says the director approved somebody. */
  | "decide.director"
  /** Record a decision that says the client approved somebody. */
  | "decide.client"
  /** Create, edit and delete clients. */
  | "client.manage"
  /** The people page: add, edit, deactivate. */
  | "user.manage"
  /** The whole-database search, which crosses every opening. */
  | "database.read"
  /** Reports, which aggregate across the desk. */
  | "report.read"
  /** Commercial records: fees, guarantees, fall-throughs, ESA. */
  | "commercial.manage"
  /** Start a new opening. */
  | "opening.create"
  /** Work an incoming CV that has not been filed against an opening yet. */
  | "intake.handle"
  /** Give or update feedback on an interview — the interviewer's view of the candidate. */
  | "interview.feedback"
  /** The Voice agent practice line: talk to the screening agent as a candidate. */
  | "voice.practice"
  /** Give a TA strategies to use on a job (the Strategy Planner). */
  | "strategy.assign"
  /** Edit the list of strategies a lead can choose from. */
  | "strategy.manage"
  /** A TA works the strategies they were given on a job: read their own, mark them started or done. */
  | "strategy.work";

/** Everything a decision needs to know, resolved by the caller. */
export interface AuthContext {
  /** The opening in play, when the capability is opening-scoped. */
  openingId?: Id | null;
  /** This user's assignment on that opening, if any. */
  assignment?: Assignment | null;
  /** True when the user has strategies assigned to them on this opening. */
  onStrategy?: boolean;
  /**
   * The candidate's owning TA, for the collision lock: first to shortlist owns,
   * and a second TA does not act on what the first has claimed.
   */
  ownerTaId?: Id | null;
  /**
   * Set when the authority is a reviewer's own recorded reply rather than the
   * person typing. Pasting the director's email into the reply box is the
   * director deciding — the TA is a transcriber, not the approver.
   */
  viaRecordedReview?: boolean;
}

export type Decision = { ok: true } | { ok: false; message: string };

const ALLOW: Decision = { ok: true };
const deny = (message: string): Decision => ({ ok: false, message });

/** Roles that are never narrowed to one opening — they review the whole desk. */
const DESK_WIDE: Role[] = ["admin", "director", "ta_lead", "ops"];

/** Roles that may never write anything, whatever they are assigned. */
const READ_ONLY: Role[] = ["viewer"];

export function isDeskWide(user: User): boolean {
  return DESK_WIDE.includes(user.role);
}

/**
 * A TA working their own desk — a TA, or TA Support (9 Oct). TA Support has a
 * TA's access in every respect but one: on a job's Excel Tables they read the
 * rows of every TA on it (seesEveryTaRow). Every "is this a TA" check asks
 * this, so the two seats cannot drift apart.
 */
export function isTa(user: Pick<User, "role"> | null | undefined): boolean {
  return user?.role === "ta" || user?.role === "ta_support";
}

/**
 * TA Support on Excel Tables: every TA's rows on the job, not only their own
 * (9 Oct). Reading only — another TA's row is still theirs to work, so the
 * sourcing check below refuses acting on it exactly as it does for a TA.
 */
export function seesEveryTaRow(user: User): boolean {
  return user.role === "ta_support";
}

export function isReadOnly(user: User): boolean {
  return READ_ONLY.includes(user.role);
}

/** Every capability that only reads. Everything else is a write. */
const READS: Capability[] = ["opening.read", "database.read", "report.read"];

/**
 * The policy itself.
 *
 * Written as a series of refusals rather than a table of grants, because the
 * safe default when a new role or capability is added is "no", and a table
 * makes the default "whatever the missing cell happens to be".
 */
export function can(user: User, capability: Capability, ctx: AuthContext = {}): Decision {
  // A deactivated account is not an account. This is checked here as well as
  // at the session, because an action reached with a stale cookie arrives here.
  if (!user.isActive) return deny("This account is deactivated.");

  if (isReadOnly(user) && !READS.includes(capability)) {
    return deny("A viewer account can read, and cannot change anything.");
  }

  switch (capability) {
    case "user.manage":
      return user.role === "admin" ? ALLOW : deny("Only an admin can manage people.");

    case "client.manage":
      return user.role === "admin" || user.role === "director" || user.role === "ta_lead"
        ? ALLOW
        : deny("Only a director, lead or admin can change client records.");

    case "strategy.assign":
    case "strategy.manage":
      // The lead decides how a job is worked (8 Oct); a TA does not assign
      // strategies to themselves or to anyone else. Same people as client.manage.
      return user.role === "admin" || user.role === "director" || user.role === "ta_lead"
        ? ALLOW
        : deny("Only a TA Lead, Director or Admin can assign strategies.");

    case "strategy.work":
      // A team member works the strategies they were given on a job.
      if (!isTa(user) && !ctx.onStrategy) return deny("Strategies are worked by the TA they were given to.");
      if (ctx.assignment?.role === "client_contact") return deny("You are not on this opening.");
      if (!ctx.assignment && !ctx.onStrategy) return deny("You are not on this opening.");
      return ALLOW;

    case "database.read":
      // The whole database crosses every opening, so a client contact — who is
      // given one shortlist — has no business in it.
      return user.role === "client"
        ? deny("The database search covers every client's work, not only yours.")
        : ALLOW;

    case "report.read":
      return user.role === "client"
        ? deny("Reports aggregate the whole desk, not one opening.")
        : ALLOW;

    case "commercial.manage":
      return user.role === "admin" || user.role === "director" || user.role === "ta_lead" || user.role === "ops"
        ? ALLOW
        : deny("Fees, guarantees and placements are kept by ops, a lead or a director.");

    case "decide.director":
      // The reviewer's own reply is the authority, whoever pasted it in.
      if (ctx.viaRecordedReview) return ALLOW;
      if (user.role === "admin" || user.role === "director" || user.role === "ta_lead") return ALLOW;
      if (ctx.assignment?.role === "director") return ALLOW;
      return deny(
        "Moving somebody to the director's shortlist says the director approved them. Record their reply instead.",
      );

    case "decide.client":
      if (ctx.viaRecordedReview) return ALLOW;
      if (user.role === "admin" || user.role === "director" || user.role === "ta_lead") return ALLOW;
      if (ctx.assignment?.role === "client_contact") return ALLOW;
      return deny(
        "Moving somebody to the client's shortlist says the client approved them. Record their reply instead.",
      );

    case "opening.sourcing":
      if (isDeskWide(user)) return ALLOW;
      if (user.role === "client") return deny("Sourcing is the desk's working-out, not the shortlist.");
      if (ctx.assignment?.role === "client_contact") {
        return deny("Sourcing is the desk's working-out, not the shortlist.");
      }
      // A table row another TA added is theirs. Callers name an owner only for
      // rows (repo.openingOf), so nothing else is narrowed by this (2 Oct).
      if (ctx.assignment && ctx.ownerTaId && ctx.ownerTaId !== user.id && isTa(user)) {
        return deny("That row is another recruiter's. Their table is theirs to work.");
      }
      return ctx.assignment ? ALLOW : deny("You are not on this opening.");

    case "opening.manage":
      if (isDeskWide(user)) return ALLOW;
      if (ctx.assignment?.role === "primary_recruiter" || ctx.assignment?.role === "supporting_recruiter") {
        return ALLOW;
      }
      return deny("Only the recruiters on this opening, or a lead, can change it.");

    case "opening.act": {
      if (!isDeskWide(user)) {
        if (!ctx.assignment) return deny("You are not on this opening.");
        if (ctx.assignment.role === "client_contact") {
          return deny("A client seat reads its shortlist; it does not work the pipeline.");
        }
      }
      // The collision lock of §9: first to shortlist owns it. A lead or
      // director may still act — somebody has to be able to unstick a desk.
      if (
        ctx.ownerTaId &&
        ctx.ownerTaId !== user.id &&
        isTa(user)
      ) {
        return deny("Another recruiter has claimed this candidate.");
      }
      return ALLOW;
    }

    case "opening.read":
      if (isDeskWide(user)) return ALLOW;
      return ctx.assignment || ctx.onStrategy ? ALLOW : deny("You are not on this opening.");

    case "opening.create":
      return user.role === "client"
        ? deny("A client account cannot open a role on the desk.")
        : ALLOW;

    case "intake.handle":
      return user.role === "client"
        ? deny("Incoming CVs are the desk's to sort, not a client's.")
        : ALLOW;

    case "link.note":
      // Feedback runs one way: whoever reviews the desk writes, the TA working
      // the row reads (25 Sep). Desk-wide is exactly that set of people.
      return isDeskWide(user)
        ? ALLOW
        : deny("Only a TA Lead, Director, Admin or Ops can leave notes.");

    case "review.note":
      // Unlike link.note, this runs every way (29 Sep): the TA who sent the CV,
      // the lead, the director and admin all add to what is said about a person
      // in Director review. A client seat sees its own shortlist and stays out.
      if (user.role === "client" || ctx.assignment?.role === "client_contact") {
        return deny("A client seat reads its shortlist; it does not add notes to Director review.");
      }
      if (isDeskWide(user)) return ALLOW;
      return ctx.assignment ? ALLOW : deny("You are not on this opening.");

    case "interview.feedback":
      // Wider than opening.act on purpose (28 Sep): the client's interviewer
      // sits in a client seat and is the one person whose view this is. The
      // collision lock does not apply — feedback is not working the candidate.
      if (isDeskWide(user)) return ALLOW;
      return ctx.assignment ? ALLOW : deny("You are not on this opening.");

    case "voice.practice":
      // Taken off the TA seat (2 Oct). Leads, directors, admin and ops keep it.
      return isTa(user)
        ? deny("The voice agent practice line is not available on a Talent Acquisition account.")
        : ALLOW;
  }
}

/** Thrown when a write is refused, so an action can stop where it stands. */
export class Refused extends Error {
  readonly capability: Capability;
  constructor(capability: Capability, message: string) {
    super(message);
    this.name = "Refused";
    this.capability = capability;
  }
}

/**
 * The form every server action uses. It either returns, or throws — there is no
 * third path where the write quietly happens anyway.
 */
export function must(user: User, capability: Capability, ctx: AuthContext = {}): void {
  const d = can(user, capability, ctx);
  if (!d.ok) throw new Refused(capability, d.message);
}

/** Convenience for the interface layer, which wants a boolean. */
export function allows(user: User, capability: Capability, ctx: AuthContext = {}): boolean {
  return can(user, capability, ctx).ok;
}
