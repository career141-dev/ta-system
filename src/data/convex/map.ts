/**
 * The backend's records, in this platform's shape.
 *
 * Pure functions — no I/O — so what gets copied is visible and testable. The
 * candidate mapper already exists in `lib/live/mapLive.ts` and is re-exported
 * rather than rewritten: two copies of a field mapping drift, and that one is
 * already used by the read-only sync.
 *
 * The rule throughout: a field the backend does not hold becomes `null`, never
 * a guess. A fabricated default is indistinguishable from a real value once it
 * is on screen, and these values decide who a recruiter calls.
 */

import type {
  Application,
  Candidate,
  Id,
  JobPost,
  Opening,
  PriorityTier,
  Role,
  SourcingChannel,
  Stage,
  User,
} from "@/data/types";
import { mapCandidate, type LiveCandidate, type LiveResume } from "@/lib/live/mapLive";

export { mapCandidate };
export type { LiveCandidate, LiveResume };

// ─── Time ────────────────────────────────────────────────────────────────────

/**
 * The backend stores timestamps three ways — ISO strings, epoch numbers, and
 * occasionally neither. This platform stores numbers throughout, because a
 * string cannot be sorted, compared or counted from.
 */
export function ms(value: unknown, fallback = 0): number {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return fallback;
}

// ─── Openings ────────────────────────────────────────────────────────────────

/** A job's status in this platform's vocabulary. `draft` is still an open
 *  piece of work — the JD approval state says whether it is ready, and that is
 *  a separate field. */
const OPENING_STATUS: Record<string, Opening["status"]> = {
  active: "open",
  draft: "open",
  on_hold: "on_hold",
  filled: "filled",
  cancelled: "closed",
};

const PRIORITY_TIERS = new Set(["P1", "P2", "P3", "P4", "P5"]);

export interface BackendOpening {
  id: string;
  title: string;
  clientId: string | null;
  clientName: string;
  clientIndustry?: string;
  jdMarkdown: string;
  jdStatus: string | null;
  jdApprovedAt: number | null;
  keyword?: string;
  locations: string[];
  targetNationalities: string[];
  targetGender: string | null;
  headcount: number;
  priorityTier: string | null;
  positionStatus: string | null;
  status: string;
  followUpQuestions: { id: string; label: string }[];
  taLeadId: string | null;
  assignedTaIds: string[];
  primaryRecruiterId: string;
  valueOnProgressing: number | null;
  valueOfPlacement: number | null;
  createdAt: string | number;
  updatedAt: string | number;
  [k: string]: unknown;
}

export function mapOpening(o: BackendOpening): Opening {
  return {
    id: o.id,
    clientId: o.clientId ?? "",
    title: o.title,
    // Neither exists in the backend. Left blank rather than invented: an
    // invented position code would look like a real one on a report.
    positionCode: "",
    jobOrderNumber: "",
    jdMarkdown: o.jdMarkdown ?? "",
    followUpQuestions: o.followUpQuestions ?? [],
    jdStatus: (o.jdStatus as Opening["jdStatus"]) ?? "draft",
    jdApprovedBy: null,
    jdApprovedAt: o.jdApprovedAt ?? null,
    briefId: null,

    salaryMin: numOrNull(o.salaryMin),
    salaryMax: numOrNull(o.salaryMax),
    salaryCurrency: typeof o.salaryCurrency === "string" ? o.salaryCurrency : "LKR",
    packageNotes: "",

    targetNationalities: o.targetNationalities ?? [],
    targetGender: o.targetGender ?? null,
    locations: o.locations ?? [],
    headcount: o.headcount ?? 1,
    // A tier drives the "day N of target" counters, so an unset one has to be
    // a real default rather than undefined. P3 (one month) is the middle.
    priorityTier: (PRIORITY_TIERS.has(o.priorityTier ?? "") ? o.priorityTier : "P3") as PriorityTier,
    positionStatus: (o.positionStatus as Opening["positionStatus"]) ?? statusToPosition(o.status),

    assignedTaIds: o.assignedTaIds ?? [],
    taLeadId: o.taLeadId ?? o.primaryRecruiterId ?? "",
    directorId: null,

    requirementReceivedAt: ms(o.createdAt) || null,
    assignedAt: null,
    closedAt: null,

    valueOnProgressing: o.valueOnProgressing ?? null,
    valueOfPlacement: o.valueOfPlacement ?? null,
    valueLost: null,

    status: OPENING_STATUS[o.status] ?? "open",
    createdAt: ms(o.createdAt),
    updatedAt: ms(o.updatedAt, ms(o.createdAt)),
  };
}

function statusToPosition(status: string): Opening["positionStatus"] {
  if (status === "filled") return "filled";
  if (status === "cancelled") return "lost";
  if (status === "on_hold") return "hold";
  return "active";
}

function numOrNull(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

// ─── Applications ────────────────────────────────────────────────────────────

const CHANNELS = new Set(["DA", "IM", "FB", "E", "L", "HH", "SCOOP"]);

/**
 * The backend's free-text `sourceChannel` as one of the Guidelines tab's
 * codes. Only used where the TA code was never set — an explicit
 * `taSourcingChannel` always wins.
 */
export function channelOf(legacy: string | null | undefined): SourcingChannel {
  const s = (legacy ?? "").toLowerCase();
  if (s.includes("linkedin")) return "L";
  if (s.includes("whatsapp") || s.includes("meta")) return "DA";
  if (s.includes("headhunt")) return "HH";
  if (s.includes("database")) return "SCOOP";
  if (s.includes("facebook")) return "FB";
  // Everything that arrived as mail, and anything unrecognised, reads as
  // email — which is what an unlabelled arrival on this desk actually was.
  return "E";
}

export interface BackendApplication {
  id: string;
  openingId: string;
  candidateId: string;
  jobPostId: string | null;
  stage: string;
  backendStage: string;
  ownerTaId: string | null;
  shortlistedAt: number | null;
  setNumber: number | null;
  answers: Record<string, string>;
  sourcingChannel: string | null;
  legacySourceChannel: string;
  isAddOn: boolean;
  createdAt: number;
  lastStageChangedAt: number;
  [k: string]: unknown;
}

export function mapApplication(a: BackendApplication): Application {
  return {
    id: a.id,
    openingId: a.openingId,
    jobPostId: a.jobPostId,
    candidateId: a.candidateId,
    stage: a.stage as Stage,
    answers: a.answers ?? {},
    sourcingChannel: (CHANNELS.has(a.sourcingChannel ?? "")
      ? a.sourcingChannel
      : channelOf(a.legacySourceChannel)) as SourcingChannel,

    ownerTaId: a.ownerTaId,
    shortlistedAt: a.shortlistedAt,
    setNumber: a.setNumber,
    rating: null,
    notes: [],

    statusA: null,
    statusB: null,
    rankTier: null,
    rankWeight: null,

    rejectedBy: null,
    rejectReason: typeof a.rejectReason === "string" ? a.rejectReason : null,
    droppedOutReason: typeof a.droppedOutReason === "string" ? a.droppedOutReason : null,

    isAddOn: a.isAddOn ?? false,
    addedOnAt: null,
    backupForApplicationId: null,
    offerDeclinedAt: null,
    offerDeclineReason: null,

    createdAt: a.createdAt,
    lastStageChangedAt: a.lastStageChangedAt,
  };
}

// ─── Users ───────────────────────────────────────────────────────────────────

/** The backend's role vocabulary in this platform's. Anything unrecognised
 *  reads as `viewer` — the role that can do least. A new role appearing in the
 *  backend must not silently grant anything here. */
const ROLES: Record<string, Role> = {
  admin: "admin",
  ta_manager: "ta_lead",
  senior_ta: "ta_lead",
  director: "director",
  recruiter: "ta",
  ta: "ta",
  test_ta: "ta",
  ops: "ops",
  client: "client",
  viewer: "viewer",
};

export interface BackendUser {
  _id: string;
  email: string;
  fullName: string;
  role: string;
  taRole?: string | null;
  routingEmail?: string | null;
  initials?: string | null;
  phone?: string | null;
  isActive: boolean;
  [k: string]: unknown;
}

export function mapUser(u: BackendUser): User {
  // An explicit taRole is a decision somebody made; the mapped backend role is
  // an inference. The decision wins.
  const role = (u.taRole && ROLES[u.taRole] ? (u.taRole as Role) : ROLES[u.role]) ?? "viewer";
  return {
    id: u._id,
    name: u.fullName,
    email: u.email,
    phone: u.phone ?? null,
    routingEmail: u.routingEmail ?? null,
    role,
    initials: u.initials || initialsOf(u.fullName),
    isActive: u.isActive,
  };
}

function initialsOf(name: string): string {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0]!.toUpperCase())
    .join("");
}

// ─── Job posts ───────────────────────────────────────────────────────────────

export interface BackendJobPost {
  id: string;
  openingId?: string;
  title: string;
  previousTitles?: string[];
  aliasKeywords?: string[];
  country?: string | null;
  city?: string | null;
  channel?: string;
  campaignCode?: string;
  routingEmailAlias?: string;
  assignedTaId?: string | null;
  externalUrl?: string | null;
  postedAt?: number | null;
  status?: string;
  cvCountToday?: number;
  createdAt?: number;
  [k: string]: unknown;
}

export function mapJobPost(p: BackendJobPost, openingId: Id): JobPost {
  return {
    id: p.id,
    openingId: p.openingId ?? openingId,
    title: p.title,
    previousTitles: p.previousTitles ?? [],
    aliasKeywords: p.aliasKeywords ?? [],
    country: p.country ?? null,
    city: p.city ?? null,
    channel: (p.channel as JobPost["channel"]) ?? "linkedin",
    campaignCode: p.campaignCode ?? "",
    routingEmailAlias: p.routingEmailAlias ?? "",
    assignedTaId: p.assignedTaId ?? null,
    externalUrl: p.externalUrl ?? null,
    postedAt: p.postedAt ?? null,
    status: (p.status as JobPost["status"]) ?? "draft",
    cvCountToday: p.cvCountToday ?? 0,
    createdAt: p.createdAt ?? 0,
  };
}

/** For a candidate read straight from the backend rather than through the
 *  resume feed — the common case now that most text lives in R2. */
export function mapCandidateDoc(doc: LiveCandidate): Candidate {
  return mapCandidate(doc, null);
}
