/**
 * Domain model for the Career141 TA platform.
 *
 * These types are the contract. The standalone JSON store and the eventual
 * Convex-backed implementation both satisfy them, which is what makes the
 * connection step (spec §15, phase 8c) a swap rather than a rewrite.
 */

export type Id = string;

// ─── People ──────────────────────────────────────────────────────────────────

/** Spec §13. `ops` chases client reviews; `client` and `viewer` are read-only. */
export type Role = "admin" | "director" | "ta_lead" | "ta" | "ops" | "client" | "viewer";

export const ROLE_LABEL: Record<Role, string> = {
  admin: "Admin",
  director: "Director",
  ta_lead: "TA Lead",
  ta: "Talent Acquisition",
  ops: "Operations",
  client: "Client",
  viewer: "Viewer",
};

export interface User {
  id: Id;
  name: string;
  email: string;
  /** Shown on snippets as the contact line, so it belongs on the user. */
  phone: string | null;
  /**
   * The mailbox the TA's job adverts point at.
   *
   * One per TA, not one per job — which is the single change from the old
   * system, where every advert pointed at one shared inbox and a CV arriving
   * told you nothing about which job it was for. The address identifies the
   * TA; the job headline in the subject identifies which of that TA's jobs.
   */
  routingEmail: string | null;
  role: Role;
  initials: string;
  isActive: boolean;
}

// ─── Client → Opening → Job Post (spec §4.1–4.3) ─────────────────────────────

export interface Client {
  id: Id;
  name: string;
  industry: string;
  contacts: { name: string; title: string; email: string; isPrimary: boolean }[];
  esaSignedAt: number | null;
  status: "active" | "dormant" | "archived";
  createdAt: number;
  /**
   * What the desk knows about who this client is — website, LinkedIn page,
   * full name, what they do (28 Sep). Research and Suggestions read it, so a
   * short name like "SQ" is not taken for some other company.
   */
  researchNotes?: string;
}

/** Spec §4.7 — target time-to-fill, from the workbook's `Guidelines` tab. */
export type PriorityTier = "P1" | "P2" | "P3" | "P4" | "P5";

export const PRIORITY_TARGET: Record<PriorityTier, { label: string; days: number }> = {
  P1: { label: "2 weeks", days: 14 },
  P2: { label: "3 weeks", days: 21 },
  P3: { label: "1 month", days: 30 },
  P4: { label: "1.5 months", days: 45 },
  P5: { label: "2 months", days: 60 },
};

/** Spec §4.8 / Q17 — a lookup, not a hardcoded enum, so more can be added. */
/** The Master Sheet's column. Kept in step with `status` — see setOpeningStatus. */
export type PositionStatus = "active" | "hold" | "lost" | "filled";

export interface Opening {
  id: Id;
  clientId: Id;
  title: string;
  positionCode: string;
  jobOrderNumber: string;
  jdMarkdown: string;
  /**
   * The TA's own follow-up questions for this job, asked alongside the desk's
   * standard ones — "Do you hold a valid driving licence?".
   */
  followUpQuestions: { id: Id; label: string }[];
  /**
   * Automatic follow-up: after a TA sends the first message, WhatsApp and email
   * reminders go out every 24 hours up to the attempt ceiling, and replies on
   * the WhatChimp number are read into the record. Written only through
   * `ta/followUp:setAuto`.
   */
  autoFollowUp: boolean;
  jdStatus: "draft" | "pending_ta_approval" | "approved";
  jdApprovedBy: Id | null;
  jdApprovedAt: number | null;
  briefId: Id | null;

  salaryMin: number | null;
  salaryMax: number | null;
  salaryCurrency: string;
  packageNotes: string;

  /**
   * Whose passport, not where the job is. A Bangladesh posting may be a search
   * for Sri Lankans to send there, or a local Bangladeshi hire — that is the
   * client's call and it changes where we look entirely.
   */
  targetNationalities: string[];
  /**
   * Some clients specify it. Where they do it is a hard requirement, and where
   * they do not this stays null and is never inferred.
   */
  targetGender: string | null;
  locations: string[];
  headcount: number;
  priorityTier: PriorityTier;
  positionStatus: PositionStatus;

  /** Spec §4.2 — many TAs per Opening, add and remove freely. */
  assignedTaIds: Id[];
  taLeadId: Id;
  directorId: Id | null;

  requirementReceivedAt: number | null;
  assignedAt: number | null;
  closedAt: number | null;

  /** Commercial pipeline value — Master Sheet columns, spec §4.8. */
  valueOnProgressing: number | null;
  valueOfPlacement: number | null;
  valueLost: number | null;

  status: "open" | "on_hold" | "closed" | "filled";
  createdAt: number;
  updatedAt: number;

  /**
   * The structured requirements read out of the approved JD (Job details).
   * Present on the Convex store; the JSON store has none and scores from the
   * JD text alone.
   */
  requirements?: OpeningRequirements;
}

export interface OpeningRequirements {
  requiredSkills: string[];
  niceToHaveSkills: string[];
  seniorityLevel: string | null;
  experienceMinYears: number | null;
  experienceMaxYears: number | null;
  location: string | null;
  educationLevel: string | null;
  languagesRequired: string[];
  salaryMin: number | null;
  salaryMax: number | null;
  salaryCurrency: string | null;
  clientIndustry: string | null;
  recruitmentType: "both" | "headhunting" | "job_posting";
  isConfidential: boolean;
  jobStatus: string;
  /** extracting while the model reads the JD; failed carries `error`. */
  status: "extracting" | "extracted" | "failed" | null;
  extractedAt: number | null;
  error: string | null;
  /** Fields a person corrected — automatic re-extraction fills around them. */
  lockedFields: string[];
  editedBy: string | null;
  editedAt: number | null;
}

export interface JobPost {
  id: Id;
  openingId: Id;
  /** Spec §4.3 — the only required field. */
  title: string;
  /**
   * Titles this advert has carried before. Type 4 of the desk's four posting
   * patterns: the headline of a live LinkedIn post gets edited, and applicants
   * who clicked before the edit still arrive under the old title. They belong
   * to the same post.
   */
  previousTitles: string[];
  aliasKeywords: string[];
  country: string | null;
  city: string | null;
  channel: "linkedin" | "portal" | "whatsapp" | "facebook" | "email_campaign" | "other";
  /**
   * A short code that ties a campaign reply to this post.
   *
   * LinkedIn applications are routed by the TA's mailbox and the headline. A
   * Meta campaign arrives as a WhatsApp message and an email campaign as a
   * reply, and neither carries a headline anyone controls — so the ad's
   * pre-filled WhatsApp text, or the email's subject, carries this code
   * instead, and the code decides the post.
   */
  campaignCode: string;
  routingEmailAlias: string;
  assignedTaId: Id | null;
  externalUrl: string | null;
  postedAt: number | null;
  status: "draft" | "live" | "paused" | "closed";
  cvCountToday: number;
  createdAt: number;
}

// ─── Intake (spec §5) ────────────────────────────────────────────────────────

/** What the system pulls out of a brief. Every field is editable before it
 *  becomes an Opening — nothing is committed without a human pressing save. */
export interface ExtractedBrief {
  title: string;
  salaryMin: number | null;
  salaryMax: number | null;
  currency: string;
  packageNotes: string;
  locations: string[];
  nationalities: string[];
  headcount: number;
  mustHaves: string[];
  clientNotes: string;
  priorityTier: PriorityTier;
}

export interface Brief {
  id: Id;
  clientId: Id | null;
  openingId: Id | null;
  /** Spec §5 — the management→lead download, or the lead→TA handoff. */
  kind: "management_to_lead" | "lead_to_ta";
  capturedBy: Id;
  capturedAt: number;
  method: "recording" | "notes" | "both";
  notesMarkdown: string;
  transcript: string | null;
  transcriptStatus: "none" | "pending" | "ready" | "unavailable";
  recordingKey: string | null;
  recordingDurationMs: number | null;
  /** Spec §5.3 / Q1 — consent is given when record is pressed, and the wording
   *  as it stood that day is stored with it. */
  consentAcknowledgedBy: Id | null;
  consentAcknowledgedAt: number | null;
  consentText: string | null;
  extracted: ExtractedBrief;
}

// ─── Candidates and pipeline ─────────────────────────────────────────────────

export interface Candidate {
  id: Id;
  fullName: string;
  email: string | null;
  phone: string | null;
  linkedinUrl: string | null;
  location: string | null;
  nationality: string | null;
  age: number | null;
  /** Where the age came from — dob · nic · stated_age · entered (28 Sep). */
  ageSource?: string | null;
  /** When the CV's date of birth and its NIC disagree, or the age is only approximate. */
  ageNote?: string | null;
  gender: string | null;
  /** Where gender came from when extraction filled it: cv_stated | nic | cv_llm. */
  genderSource?: string | null;
  currentEmployer: string | null;
  currentTitle: string | null;
  totalExperienceYears: number | null;
  /** The CV's own claim disagrees with its dates, or some dates are years only. */
  experienceNote?: string | null;
  educationDegree: string | null;
  educationInstitution: string | null;
  qualifications: string | null;
  /** Score out of 10. Stored as an integer — see spec §4.8 on the workbook's date-serial corruption. */
  englishLevel: number | null;
  languages: string[];
  skills: string[];
  industries: string[];
  noticePeriodDays: number | null;
  noticePeriod?: string | null;
  currentSalary: string | null;
  expectedSalary: string | null;
  cvFileName: string | null;
  /** Their CV file was lost in the Convex Cloud move; kept out of search and matching (src/lib/cvMissing.ts). */
  cvFileMissing?: boolean;
  /** Spec §6D — the result row shows a career, not a single line. */
  workHistory: { title: string; employer: string; fromYear: number; toYear: number | null }[];
  createdAt: number;
}

/**
 * Spec §6.1. The Pipeline nav shows `follow_up` onward; the four stages before
 * it live in the job and database views, not the board.
 */
export type Stage =
  | "new_cv"
  | "matched"
  | "ai_follow_up"
  | "ta_follow_up"
  | "director_review"
  | "director_shortlist"
  | "client_shortlist"
  | "interview"
  | "offer"
  | "placed"
  | "rejected"
  | "dropped_out";

export const PIPELINE_STAGES: Stage[] = [
  "ai_follow_up",
  "ta_follow_up",
  "director_review",
  "director_shortlist",
  "client_shortlist",
  "interview",
  "offer",
  "placed",
];

export const CLOSED_STAGES: Stage[] = ["rejected", "dropped_out"];

/**
 * Before the board: LinkedIn applicants (New CVs) and database matches.
 */
export const EARLY_STAGES: Stage[] = ["new_cv", "matched"];

/** Retired stages, and where their candidates are mapped. */
export const RETIRED_STAGES: Record<string, Stage> = {
  follow_up: "ta_follow_up",
  ta_shortlist: "ta_follow_up",
  ai_call: "ai_follow_up",
};

export const STAGE_LABEL: Record<Stage, string> = {
  new_cv: "New CVs",
  matched: "Database match",
  ai_follow_up: "AI Follow-up",
  ta_follow_up: "TA Follow-up",
  director_review: "Director Review",
  director_shortlist: "Director shortlist",
  client_shortlist: "Client shortlist",
  interview: "Interview",
  offer: "Offer",
  placed: "Placed",
  rejected: "Rejected",
  dropped_out: "Dropped out",
};

/** Spec §4.7 — the `Guidelines` tab's channel codes, verbatim. */
export type SourcingChannel = "DA" | "IM" | "FB" | "E" | "L" | "HH" | "SCOOP";

export const CHANNEL_LABEL: Record<SourcingChannel, string> = {
  DA: "Direct applicant — snippet, WA status, WA channel",
  IM: "In-Mail",
  FB: "Facebook",
  E: "Email",
  L: "LinkedIn",
  HH: "Direct hunt",
  SCOOP: "Database — shortlisted and reviewed",
};

export interface Application {
  id: Id;
  openingId: Id;
  jobPostId: Id | null;
  candidateId: Id;
  stage: Stage;
  /** Answers to the opening's own follow-up questions, by question id. The
   *  standard three are written to the candidate instead. */
  answers: Record<string, string>;
  sourcingChannel: SourcingChannel;

  /** Spec §9 / Q3 — set in the same write as the shortlist. First to shortlist owns. */
  ownerTaId: Id | null;
  shortlistedAt: number | null;

  setNumber: number | null;
  rating: number | null;
  notes: string[];

  /** Q18 — parked. Free text, no behaviour attached. */
  statusA: string | null;
  statusB: string | null;

  /** Q16 — parked. Carried so no migration is needed when defined. */
  rankTier: string | null;
  rankWeight: number | null;

  rejectedBy: Id | null;
  rejectReason: string | null;
  droppedOutReason: string | null;

  /**
   * Spec §15 phase 7, notebook page 3 — "add on: can be done by the TA".
   * A profile worked beyond the assigned scope of the role.
   */
  isAddOn: boolean;
  addedOnAt: number | null;
  /** A scoop: the TA who brought this CV in, when it was not the owner (plan 6.4). */
  scoopBy?: Id | null;
  scoopAt?: number | null;
  /** A scoop sent to the owner: who mailed the CV to their mailbox, and when (27 Sep). */
  scoopFrom?: Id | null;
  scoopReceivedAt?: number | null;

  /** When this candidate was put up as cover for someone who declined. */
  backupForApplicationId: Id | null;
  /** Set when an offer is turned down, which is what starts the backup search. */
  offerDeclinedAt: number | null;
  offerDeclineReason: string | null;

  createdAt: number;
  lastStageChangedAt: number;
  aiFollowUpNoReply?: boolean | null;
  cvFileName?: string | null;
  cvFileId?: string | null;
}

// ─── Call feedback (spec §6A) ────────────────────────────────────────────────

export type CallKind = "pre_interview" | "post_interview" | "post_offer" | "ad_hoc";
export type CallOutcome = "reached" | "no_answer" | "rescheduled" | "declined";

export interface CallFeedback {
  id: Id;
  applicationId: Id;
  kind: CallKind;
  outcome: CallOutcome;
  body: string;
  structured: Record<string, unknown> | null;
  source: "manual" | "ai_call" | "whatsapp" | "email";
  recordedBy: Id;
  recordedAt: number;
}

export interface Interview {
  id: Id;
  applicationId: Id;
  /**
   * What this interview is — "Technical interview", "HR round". A candidate can
   * have several on one opening (28 Sep), and "round 2" alone did not say
   * which one the feedback was about. Null on interviews booked before then.
   */
  title: string | null;
  /** Spec §12.2a — a time, not just a date, because the escalation fires at an hour. */
  scheduledAt: number;
  timezone: string;
  /** The address, or the meeting link. Which one depends on `mode`. */
  location: string;
  mode: "in_person" | "video" | "phone";
  round: number;
  /** Who is taking it, on the client's side. Goes in the candidate's reminder. */
  interviewers: string[];
  /** Minutes. Drives the "your interview is in an hour" reminder. */
  durationMins: number | null;
  /** Set when the candidate confirms, which is what stops the escalation. */
  confirmedAt: number | null;
  notes: string | null;
  /**
   * Whether they turned up. Deliberately separate from `result` — a candidate
   * can attend and be turned down, and the live system's single enum
   * (pending/passed/failed/no_show/rescheduled) cannot say both, so "attended"
   * and "passed" end up meaning each other.
   */
  outcome: "pending" | "attended" | "no_show" | "cancelled";
  /** How it went, once somebody has heard back from the client. */
  result: "pending" | "passed" | "failed" | "on_hold";
  /** Out of 5, as the client gave it. */
  clientRating: number | null;
  clientFeedback: string | null;
  /** Every reschedule, status change and edit, oldest first, with what it was before. */
  history: InterviewChange[];
  /** One entry per person who gave feedback; saving again updates your own. */
  feedback: InterviewFeedback[];
  createdAt: number;
}

export interface InterviewChange {
  at: number;
  byUserId: Id;
  kind: "rescheduled" | "status" | "edited";
  /** Plain words: "Moved from 3 Oct, 10:00 to 5 Oct, 14:00". Keeps the previous value readable forever. */
  detail: string;
  reason: string | null;
}

export type InterviewRatingKey = "technical" | "communication" | "behaviour" | "performance" | "overall";

export interface InterviewFeedback {
  byUserId: Id;
  /** Whose view it is — the interviewer, who may not have a login; a TA can enter it for them. */
  interviewer: string;
  /** 1–5 each; null when not rated. */
  ratings: Record<InterviewRatingKey, number | null>;
  recommendation: "hire" | "next_round" | "hold" | "reject" | null;
  comments: string | null;
  at: number;
  updatedAt: number;
}

/**
 * Spec §4.6 / notebook page 4 — referees named on a CV, made searchable.
 * Two uses: reaching a referee who is themselves a candidate, and the
 * backchannel from pages 1 and 3 — given a target's employer, find who else in
 * the database works there and ask them for the number.
 */
/**
 * Every stage change, and who or what caused it — ported from the live
 * system's `pipelineEvents`.
 *
 * The reason it matters is the question a client asks in month three: why was
 * this person dropped, and when. A stage field only knows where someone is now.
 */
/**
 * What somebody is on an opening, not just that they are on it — ported from
 * the live system's `jobAssignments`.
 *
 * The distinction earns its keep at the client contact. Being able to say "this
 * person is on this role, but only as the client" is what lets you give a
 * client their own shortlist without also handing them the sourcing, the
 * approach history and everyone who was rejected on the way.
 */
export type AssignmentRole =
  | "primary_recruiter"
  | "supporting_recruiter"
  | "director"
  | "client_contact";

export const ASSIGNMENT_LABEL: Record<AssignmentRole, string> = {
  primary_recruiter: "Primary recruiter",
  supporting_recruiter: "Supporting recruiter",
  director: "Director",
  client_contact: "Client contact",
};

export const ASSIGNMENT_NOTE: Record<AssignmentRole, string> = {
  primary_recruiter: "Owns the role. Sees and does everything on it.",
  supporting_recruiter: "Works it alongside. Their own desk, same as the primary.",
  director: "Reviews shortlists. Sees the whole opening.",
  client_contact: "Sees their shortlist onward — not the sourcing behind it.",
};

export type WorkingStage = "100%" | "Follow-up" | "Add-on";

export interface Assignment {
  id: Id;
  openingId: Id;
  userId: Id;
  role: AssignmentRole;
  assignedAt: number;
  assignedBy: Id | null;
  /** The TA's current working stage for this job (100% / Follow-up / Add-on). */
  workingStage?: WorkingStage;
}

export interface PipelineEvent {
  id: Id;
  applicationId: Id;
  openingId: Id;
  eventType: string;
  fromStage: Stage | null;
  toStage: Stage | null;
  /** A person, the system, or somebody outside it replying to an email. */
  actorType: "user" | "system" | "director" | "client";
  actorId: Id | null;
  note: string | null;
  at: number;
}

/**
 * A set of CVs sent out for a decision, and the decision that came back.
 *
 * The desk emails a set to the director, the director replies in prose, and
 * today somebody reads that reply and moves people by hand. This records the
 * round so the reply can be matched to it and the moves made from it.
 *
 * The token is what makes the match reliable: it goes out in the subject and
 * comes back on the reply, so an inbound email can be tied to exactly the set
 * it answers even when the thread headers are lost by a forward.
 */
export interface ReviewRound {
  id: Id;
  openingId: Id;
  kind: "director" | "client";
  /** Matches an email back to this round. */
  token: string;
  /**
   * The provider's message id for the mail that went out, once a mailbox is
   * connected. A reply's In-Reply-To names it exactly, which is the only
   * signal that survives a forwarded thread and a rewritten subject.
   */
  messageId: string | null;
  /** The set number this round covers, where it is a set. */
  setNumber: number | null;
  applicationIds: Id[];
  sentBy: Id;
  sentAt: number;
  sentTo: string;
  /** Copied in, and the address the reply is watched on. */
  trackedAt: string | null;
  subject: string;
  /** Nothing is emailed until the systems are merged — see lib/reviewRounds. */
  dispatch: "held" | "sent";
  status: "awaiting" | "partial" | "returned";
  returnedAt: number | null;
  /** The reply as received, kept so a parse can be re-read or disputed. */
  replyBody: string | null;
  decisions: ReviewDecision[];
}

export interface ReviewDecision {
  applicationId: Id;
  outcome: "shortlisted" | "rejected" | "hold";
  note: string | null;
  /** True when a person confirmed it rather than the parse alone. */
  confirmed: boolean;
}

export interface Referee {
  id: Id;
  /** The candidate whose CV named them. */
  fromCandidateId: Id;
  name: string;
  title: string | null;
  company: string | null;
  phone: string | null;
  email: string | null;
  relationship: string | null;
  contactable: boolean;
  lastContactedAt: number | null;
  extractedAt: number;
}

// ─── Headhunting (spec §4.5) ─────────────────────────────────────────────────

export type LinkOutcome =
  | "no_contact"
  | "contacted"
  | "responded"
  | "cv_received"
  | "shortlisted"
  | "declined"
  | "unreachable";

/**
 * What the browser extension read off a LinkedIn profile the TA had open.
 *
 * Captured by a person looking at the page, one profile at a time — there is no
 * crawl here and there must never be one. Stored whole so that phase 8 can map
 * it onto candidate records without asking the TA to visit the profile again.
 */
export interface ProfileCapture {
  fullName: string | null;
  headline: string | null;
  currentTitle: string | null;
  currentCompany: string | null;
  location: string | null;
  about: string | null;
  connectionDegree: string | null;
  openToWork: boolean;
  experience: { title: string; company: string; dates: string | null }[];
  education: { school: string; detail: string | null }[];
  skills: string[];
  email: string | null;
  phone: string | null;
  /** The page it came off, and when. */
  sourceUrl: string;
  capturedAt: number;
  capturedBy: Id;
}

/** One of a TA's L's on an opening's Excel Tables (store.linkLevels, 29 Sep). */
export interface LinkLevel {
  /** 1 for L1. Never reused, so rows can hold it. */
  n: number;
  /** When it was started with +. */
  at: number;
  /** The TA's own name for it; the date is shown when there is none. */
  name?: string;
  deleted?: boolean;
}

export interface LinkVaultEntry {
  id: Id;
  openingId: Id;
  addedBy: Id;
  linkedinUrl: string;
  name: string | null;
  title: string | null;
  company: string | null;
  isEyeMarked: boolean;
  phoneNumber: string | null;
  phoneSource: "mutual_connection" | "reception_call" | "internal_db" | "profile" | "other" | null;
  sourcingChannel: SourcingChannel;
  outcome: LinkOutcome;
  candidateId: Id | null;
  /** Who in the database this profile is, if anyone — see convex/lib/samePerson. */
  cvMatch?: CvMatch | null;
  conversationLog: { at: number; channel: string; note: string; by: Id }[];
  createdAt: number;
  /** When the outcome last changed (28 Sep) — the end-of-day L EFFORT counts a
   *  row worked today. Absent on rows not touched since. */
  outcomeAt?: number;
  /** An add-on: added while the TA's stage on the job was Add-on, or tagged by
   *  hand (28 Sep). Carried to the application when the row joins the
   *  pipeline. Absent on rows that are not. */
  isAddOn?: boolean;
  /** The TA's L it was added under (1 = L1), started with + in the sidebar
   *  (29 Sep). Absent on rows added before their first L. */
  level?: number | null;
  /** Present when the row came from, or was enriched by, the extension. */
  capture?: ProfileCapture | null;
  /** Feedback for the TA from a lead, director, admin or ops. Absent on rows
   *  nobody has left a note on. */
  leadNotes?: LeadNote[];
}

/** A LinkedIn row matched to a candidate we already hold (28 Sep). */
export interface CvMatch {
  candidateId: Id;
  fullName: string;
  /** "same" is linked already; "possible" waits for a TA. */
  strength: "same" | "possible";
  reasons: string[];
  hasCv: boolean;
  /** A TA's answer to a possible match. */
  decided?: "same" | "different";
  checkedAt: number;
}

/** A note left on an Excel Tables row for the TA working it. */
export interface LeadNote {
  id: Id;
  at: number;
  note: string;
  by: Id;
  /** The author's role when they wrote it — the note says who it came from. */
  byRole: Role;
}

// ─── Alerts (spec §12) ───────────────────────────────────────────────────────

export type AlertKind =
  | "low_volume"
  | "stale_role"
  | "shortlist_sla"
  | "client_review_chase"
  | "interview_confirmation"
  | "interview_confirmation_escalation"
  | "interview_followup"
  | "joining_date"
  | "director_review_chase"
  | "advert_quiet"
  | "cv_waiting"
  | "followup_due"
  | "review_reply_received"
  | "opening_assigned";

/** Spec §12.3 — only urgent kinds push outside working days. */
export const URGENT_ALERTS: AlertKind[] = [
  "interview_confirmation",
  "interview_confirmation_escalation",
  "interview_followup",
  "review_reply_received",
  "opening_assigned",
];

export interface Alert {
  id: Id;
  kind: AlertKind;
  subjectType: "opening" | "job_post" | "application";
  subjectId: Id;
  assignedTo: Id;
  raisedAt: number;
  dueAt: number;
  resolvedAt: number | null;
  detail: string;
}

// ─── Database search (spec §6D) ──────────────────────────────────────────────

/**
 * What a search actually asks for, once the sentence has been read.
 *
 * Everything is optional because the parser leaves a field blank rather than
 * guessing at it — the same rule as brief extraction (§5). A criterion that is
 * present was either typed plainly enough to be certain, or added by hand.
 */
export interface SearchCriteria {
  titles: string[];
  skills: string[];
  industries: string[];
  employers: string[];
  /** "not from X" — the client's own staff, or a company we agreed not to touch. */
  excludeEmployers: string[];
  locations: string[];
  nationalities: string[];
  languages: string[];
  qualifications: string[];
  minExperience: number | null;
  maxExperience: number | null;
  minAge: number | null;
  maxAge: number | null;
  gender: string | null;
  maxNoticeDays: number | null;
  minEnglish: number | null;
  /** LKR thousands, matched against the expectation on the CV. */
  maxExpectedSalary: number | null;
  /** Spec §9 — the collision rule reaches into search, not just the pipeline. */
  availability: "any" | "free" | "in_pipeline" | "placed_before";
}

export const EMPTY_CRITERIA: SearchCriteria = {
  titles: [], skills: [], industries: [], employers: [], excludeEmployers: [],
  locations: [], nationalities: [], languages: [], qualifications: [],
  minExperience: null, maxExperience: null, minAge: null, maxAge: null,
  gender: null, maxNoticeDays: null, minEnglish: null, maxExpectedSalary: null,
  availability: "any",
};

/** A search worth keeping — per user, because desks differ. */
export interface SavedSearch {
  id: Id;
  name: string;
  query: string;
  mode: "natural" | "boolean" | "meaning";
  ownerId: Id;
  openingId: Id | null;
  createdAt: number;
  lastRunAt: number | null;
  /** The count when it was last run, so "12 new since Tuesday" is possible. */
  lastResultCount: number | null;
}

// ─── Headhunting intelligence (spec §8A) ─────────────────────────────────────

/** A claim the system did not invent. Every one carries where it came from. */
export interface Citation {
  url: string;
  title: string;
  quote: string;
}

/**
 * Company research for an opening. Cached rather than regenerated on each view:
 * searches cost money, and a TA opening the tab four times should not pay four
 * times for the same answer.
 */
/** The named fields on the Figma's Research frame. Each is generated, each is
 *  editable, and any the search could not source stays empty. */
export interface ResearchFields {
  similarDesignation: string;
  websiteLink: string;
  servicesProvider: string[];
  country: string;
  location: string;
  competitors: string[];
  socialMedia: string;
  companyOverview: string;
  /** Each competitor searched and read (22 Sep). Absent on reports made before. */
  competitorProfiles?: CompetitorProfile[];
}

/** A competitor as the search found it: addresses from the results, text from their pages. */
export interface CompetitorProfile {
  name: string;
  website: string;
  linkedin: string;
  whatTheyDo: string;
  location: string;
  summary: string;
  sources: Citation[];
}

export const EMPTY_RESEARCH: ResearchFields = {
  similarDesignation: "", websiteLink: "", servicesProvider: [], country: "",
  location: "", competitors: [], socialMedia: "", companyOverview: "",
};

export interface ResearchReport {
  id: Id;
  openingId: Id;
  clientId: Id;
  fields: ResearchFields;
  /** What the TA changed by hand, so a regeneration does not overwrite it. */
  editedFields: string[];
  markdown: string;
  sources: Citation[];
  /** How many web searches it took, shown so the cost is never hidden. */
  searches: number;
  model: string;
  generatedBy: Id;
  generatedAt: number;
}

/**
 * Profile benchmarking (Q21): who holds this role now, who held it before, and
 * who holds it at named competitors. Several options with a confidence level
 * rather than one asserted answer — the TA picks which to benchmark against,
 * and that choice feeds Suggestions.
 */
export interface BenchmarkEntry {
  id: Id;
  openingId: Id;
  name: string | null;
  title: string;
  company: string;
  linkedinUrl: string | null;
  kind: "incumbent" | "predecessor" | "competitor";
  confidence: "high" | "medium" | "low";
  note: string;
  sourceUrl: string | null;
  sourceTitle: string | null;
  /** The TA's pick. What Suggestions searches against. */
  isSelected: boolean;
  generatedAt: number;
}

/**
 * A LinkedIn profile worth approaching — people we do **not** hold a CV for.
 * The Database section covers the ones we do; this is the other direction.
 * Keeping one sends it to the link vault, which is where the approach is logged.
 */
/** A report a TA built and kept — spec is stored, never the numbers, so a
 *  saved report is always current when it is reopened. */
export interface SavedReport {
  id: Id;
  name: string;
  ownerId: Id;
  /** Visible to the whole desk rather than just its author. */
  shared: boolean;
  /** A `ReportSpec` from lib/reporting, stored as given. */
  spec: unknown;
  createdAt: number;
}

export interface ProfileSuggestion {
  id: Id;
  openingId: Id;
  name: string;
  headline: string;
  company: string | null;
  location: string | null;
  linkedinUrl: string | null;
  /** How strong the evidence is. The two tiers are kept roughly balanced, so
   *  that "priority" means something rather than covering the whole list. */
  tier: "priority" | "screen";
  /** Why this person, in a sentence. */
  why: string;
  /** What does not fit, where something does not. Never left flattering. */
  concern: string | null;
  sourceUrl: string | null;
  status: "new" | "kept" | "dismissed";
  /** Drives the refinement rounds — more like this, or not relevant. */
  feedback: "more_like_this" | "not_relevant" | null;
  round: number;
  generatedAt: number;
  /** Whose run this was. Absent on rows written before ownership was recorded,
   *  which stay visible to everyone rather than disappearing. */
  generatedFor?: Id | null;
  /** Who claimed it. Keeping a profile is the claim — see lib/visibility. */
  keptBy?: Id | null;
}

/**
 * The assistant conversation on an opening — spec §8A.3.
 *
 * A third way to steer sourcing, alongside keep/reject and the benchmark ticks:
 * the TA says what they want in words. Two kinds of instruction, and the
 * difference costs money, so it is never guessed at silently:
 *
 *   **refine** — re-reads the candidates already found. Free, instant.
 *   **search** — runs another round with new terms. Spends a round and credits.
 */
export interface ChatMessage {
  id: Id;
  openingId: Id;
  role: "user" | "assistant";
  body: string;
  /** What the assistant did about it, where it did anything. */
  action: "refine" | "search" | "answer" | null;
  /** Candidates whose tier or status this message changed. */
  affected: number;
  sources: Citation[];
  byUserId: Id | null;
  at: number;
}

/**
 * The TA's conversation with the AI about an opening's JD (25 Sep): the TA
 * asks for a change, the AI rewrites the JD and says what it changed, until
 * the TA approves it. Each answer keeps the JD it produced, so an earlier
 * version can be put back.
 */
export interface JdChatMessage {
  id: Id;
  openingId: Id;
  role: "user" | "assistant";
  /** The TA's request, or what the AI changed. */
  body: string;
  /** The JD this answer produced. Only on an assistant turn that worked. */
  jdMarkdown: string | null;
  byUserId: Id | null;
  at: number;
  /** The AI did not answer; the JD was left as it was. */
  failed?: boolean;
}

/**
 * Where a CV came in from — spec §4, and the four the desk actually uses.
 *
 * `upload` is a TA dropping a file in themselves; the other three arrive
 * without anybody asking, which is exactly why they need a queue in front of
 * them rather than a direct write to the candidate table.
 */
export type IntakeSource = "email" | "whatsapp" | "upload" | "extension" | "portal";

/**
 * An intake item's life. It only ever moves forward, and `admitted` is the
 * only state that has written anything to the candidate table.
 *
 *   received → parsed → { ready | needs_review } → { admitted | merged | rejected }
 *
 * `needs_review` is the state the live system does not have. There, dedup
 * decides alone: it either merges or it does not, and nobody sees the ones it
 * got wrong.
 */
export type IntakeStatus =
  | "received"
  | "parsed"
  | "ready"
  | "needs_review"
  | "admitted"
  | "merged"
  | "rejected";

/** What dedup concluded, carried on the item so the queue can be read without
 *  recomputing it and so the decision is auditable after the fact. */
export interface IntakeMatch {
  verdict: "same" | "review" | "new";
  candidateId: Id | null;
  candidateName: string | null;
  evidence: { key: string; detail: string; strong: boolean }[];
  reason: string | null;
  checkedAt: number;
}

/** The fields a CV is read for. Everything optional: a photographed CV yields
 *  a name and nothing else, and that is a normal outcome, not a failure. */
export interface ParsedCv {
  fullName: string | null;
  email: string | null;
  phone: string | null;
  linkedinUrl: string | null;
  location: string | null;
  currentTitle: string | null;
  currentEmployer: string | null;
  totalExperienceYears: number | null;
  educationDegree: string | null;
  educationInstitution: string | null;
  skills: string[];
  /** Which fields were read rather than guessed. Anything not listed was left
   *  blank on purpose — see lib/ingest. */
  readFields: string[];
}

/**
 * One CV waiting at the door.
 *
 * Nothing here is a candidate yet. The row exists so that a file which arrived
 * can be seen, parsed, checked against the database and then admitted BY A
 * PERSON — or not. Holding it as its own record rather than writing a
 * provisional candidate is what makes "we received 40 CVs and kept 6" a
 * question the system can answer.
 */
export interface IntakeItem {
  id: Id;
  source: IntakeSource;
  /** The address, number or URL it came from, as text. Never parsed into an
   *  identity — it says where the file came from, not who is in it. */
  receivedFrom: string | null;
  receivedAt: number;
  fileName: string | null;
  /** SHA-256 of the file. The first and cheapest dedup factor. */
  fileHash: string | null;
  sizeBytes: number | null;
  /** Extracted text. In the standalone build this is the synthetic CV body. */
  rawText: string | null;
  parsed: ParsedCv | null;
  match: IntakeMatch | null;
  status: IntakeStatus;
  /** The address it arrived at — which is what says whose mailbox, and so
   *  which TA's jobs it can possibly belong to. */
  toAddress: string | null;
  /** The subject line, which is what says which of those jobs. */
  subject: string | null;
  /** The opening it was routed to. */
  openingId: Id | null;
  /** And the specific advert under it. Carried onto the application, which is
   *  what makes "applicants on my post" mean anything. */
  jobPostId: Id | null;
  /** Other openings the same advert serves — the CV is filed to each. */
  alsoFiledTo?: { postId: Id; openingId: Id }[];
  /** Whose mailbox took it. */
  routedToTaId: Id | null;
  /** How sure the match was, and what it matched on, in a sentence. */
  routeNote: string | null;
  routeConfidence: "exact" | "keyword" | "partial" | "none" | null;
  /** Set once admitted or merged — the candidate this became. */
  candidateId: Id | null;
  handledBy: Id | null;
  handledAt: number | null;
  /** Why it was rejected, or what the reviewer decided. Free text. */
  note: string | null;
  /** Anything the parser could not do, said plainly rather than swallowed. */
  problems: string[];
}

// ─── Screening calls ─────────────────────────────────────────────────────────

/**
 * How a screening call is being run.
 *
 * Ported from the live system's `VoiceSessionMode` (simulation / test / live),
 * with the middle one changed from a technical test into the mode that is
 * actually useful today: a TA on the phone themselves, working through the same
 * script, typing the answers as they hear them. Their own documentation says
 * the automated calls are suspended over number registration, so a build where
 * only `live` does anything real is a build where the feature does nothing.
 */
export type CallMode =
  /** A dry run. Shows what would be asked and writes nothing at all. */
  | "simulation"
  /** A person makes the call and records what they heard. */
  | "assisted"
  /** The voice agent calls. Off in this build. */
  | "live";

export type CallStatus =
  | "draft"
  | "awaiting_consent"
  | "in_progress"
  | "completed"
  | "declined"
  | "failed"
  | "cancelled";

export type CallField = "currentSalary" | "expectedSalary" | "noticePeriodDays" | "availability";

/** One answer, with what was actually said next to what was read out of it. */
export interface CallAnswer {
  field: CallField;
  /** The value as it will be written. Null when it was asked and not answered. */
  value: string | number | null;
  /** What the candidate said, verbatim. The check on the value above. */
  heard: string;
  at: number;
}

/**
 * A screening call.
 *
 * `stateVersion` is carried straight across from the live system and is the
 * reason that design is worth porting: every write names the version it
 * expects, so a webhook arriving twice, or out of order, cannot apply an
 * answer to a call that has already moved on.
 */
export interface AiCall {
  id: Id;
  applicationId: Id;
  candidateId: Id;
  openingId: Id;
  mode: CallMode;
  status: CallStatus;
  /** Bumped on every accepted write. */
  stateVersion: number;
  /** Null until asked. Nothing is recorded before this is granted. */
  consent: "granted" | "declined" | null;
  consentAt: number | null;
  /** The wording agreed to, stored verbatim — spec §5.3. A later change to the
   *  text must never rewrite what somebody actually agreed to. */
  consentText: string | null;
  answers: CallAnswer[];
  transcript: string | null;
  durationSeconds: number | null;
  /** What was written to the candidate at the end, and what clashed. */
  applied: string[];
  conflicts: { field: string; existing: string; heard: string }[];
  startedBy: Id;
  startedAt: number;
  endedAt: number | null;
  failureReason: string | null;
}

// ─── Closing records ─────────────────────────────────────────────────────────
//
// The four records that close a placement out: the offer, the placement
// itself, the agreement that makes the fee collectable, and the interviews
// that led there. The live system holds all four; what it does not hold is the
// commercial half — what the fee was based on, and whether the guarantee has
// run out — which is the half the business is actually paid on.

export type Currency = "LKR" | "USD";

/** Salaries on this desk are quoted monthly; fees are charged on the year.
 *  Storing which one a number is stops the 12× error at the source. */
export type SalaryBasis = "monthly" | "annual";

export function annualise(amount: number, basis: SalaryBasis): number {
  return basis === "annual" ? amount : amount * 12;
}

export type OfferStatus = "pending" | "accepted" | "declined" | "withdrawn";

export interface Offer {
  id: Id;
  applicationId: Id;
  openingId: Id;
  candidateId: Id;
  salary: number;
  salaryBasis: SalaryBasis;
  currency: Currency;
  /** A timestamp, not a string. The live schema stores this as text, which is
   *  why nothing can sort by it, compare it, or fire a reminder off it. */
  startDate: number | null;
  terms: string | null;
  status: OfferStatus;
  /** When the candidate said yes or no. */
  respondedAt: number | null;
  declineReason: string | null;
  madeBy: Id;
  createdAt: number;
}

/**
 * A placement, and the money attached to it.
 *
 * Two fields here have no counterpart in the live system and are the reason
 * this record is worth having:
 *
 *   **The fee basis.** The live table stores `invoiceAmount` as a bare number.
 *   A number with no basis cannot be checked, cannot be recomputed when the
 *   salary is corrected, and cannot be reported on as a realised rate. Here the
 *   percentage and the salary it was taken on are both kept.
 *
 *   **The guarantee.** Every one of these fees is repayable if the candidate
 *   leaves inside the guarantee period, which is why `placed` is not a terminal
 *   stage in this platform's pipeline. Nothing in the live schema records when
 *   that window closes, so nothing can tell you which placements are still at
 *   risk.
 *
 * Both the rate and the guarantee are SNAPSHOTTED from the client's agreement
 * at the moment of placement. Terms get renegotiated; a placement made in March
 * must keep March's terms however the agreement reads today.
 */
export interface Placement {
  id: Id;
  offerId: Id;
  applicationId: Id;
  openingId: Id;
  candidateId: Id;
  clientId: Id;
  placedBy: Id;
  sourcingChannel: SourcingChannel;

  salary: number;
  salaryBasis: SalaryBasis;
  currency: Currency;

  /** Agreed start. A timestamp. */
  joinDate: number;
  /** Set when somebody confirms they actually turned up — which is not the
   *  same thing as the join date passing. */
  joinConfirmedAt: number | null;

  /** Snapshotted from the client agreement. Null means a flat fee was agreed. */
  feePercent: number | null;
  /** Set only when the fee was negotiated as a lump rather than a rate. */
  flatFee: number | null;

  invoiceSentAt: number | null;
  invoiceNumber: string | null;
  invoicePaidAt: number | null;

  /** Snapshotted. Days from the join date. */
  guaranteeDays: number;
  /** Set only when it fell through inside the window. */
  fellThroughAt: number | null;
  fellThroughReason: string | null;

  notes: string | null;
  createdAt: number;
}

export type EsaStatus = "not_required" | "draft" | "sent" | "signed" | "expired";

/**
 * The Employment Services Agreement — the paper that makes a fee collectable.
 *
 * Keyed to the client RECORD, not to the client's name. The live table keys on
 * `clientName` as free text, so two spellings of one company are two separate
 * agreement histories and neither of them is complete.
 *
 * The fee terms live here because this is where they are actually agreed, and
 * a placement takes its copy from here.
 */
export interface EsaRecord {
  id: Id;
  clientId: Id;
  /** Scoped to one role where it was signed for one role only. */
  openingId: Id | null;
  status: EsaStatus;
  /** What was agreed, and what every placement under it inherits. */
  feePercent: number | null;
  guaranteeDays: number;
  sentAt: number | null;
  signedAt: number | null;
  /** The person at the client who signed. Free text — they are not a user. */
  signedBy: string | null;
  /** When it has to be back by. Breach is derived from this, never stored. */
  dueAt: number | null;
  documentName: string | null;
  notes: string | null;
  createdAt: number;
}

/**
 * One message to or from a candidate during follow-up.
 *
 * A log rather than a counter. The live system keeps `followUpAttemptCount` on
 * the application and a separate `communications` table; keeping only the log
 * means the count can never disagree with the messages, and "what did we
 * actually say to this person" is answerable — which it has to be when a
 * candidate rings up asking why they were closed.
 *
 * Nothing here is delivered by this build. A row with `sentAt` set means a
 * person sent it and said so.
 */
export type OutreachChannel = "whatsapp" | "email" | "ai_call";

/** What happened on a follow-up call — see lib/followup. */
export type FollowUpCallOutcome = "no_answer" | "answered" | "callback" | "will_send" | "not_interested";

export interface OutreachMessage {
  id: Id;
  applicationId: Id;
  candidateId: Id;
  direction: "out" | "in";
  channel: OutreachChannel;
  /** Which attempt in the sequence this was. 0 for anything inbound. */
  attempt: number;
  /** The number or address it went to, as it stood at the time. */
  to: string | null;
  subject: string | null;
  body: string;
  /** Set when a person confirms it went. Null means drafted and not sent. */
  sentAt: number | null;
  /** Who pressed the button. Null when the sequence is running itself. */
  byUserId: Id | null;
  createdAt: number;
  /** Calls only: how it went. */
  callOutcome?: FollowUpCallOutcome | null;
  /** Calls only: the time they asked to be called back, or promised to send by. */
  promisedAt?: number | null;
}

/**
 * House settings a director can change without a deploy.
 *
 * Kept as rows rather than an object so the store's backfill — which fills in
 * any missing TABLE as an empty array — handles it without a special case, and
 * so a new setting never needs a migration.
 */
export interface Setting {
  key: string;
  value: string;
  updatedAt: number;
}

// ─── The database shape ──────────────────────────────────────────────────────

export interface Database {
  users: User[];
  briefs: Brief[];
  clients: Client[];
  openings: Opening[];
  jobPosts: JobPost[];
  candidates: Candidate[];
  referees: Referee[];
  applications: Application[];
  callFeedback: CallFeedback[];
  interviews: Interview[];
  assignments: Assignment[];
  pipelineEvents: PipelineEvent[];
  reviewRounds: ReviewRound[];
  linkVault: LinkVaultEntry[];
  alerts: Alert[];
  savedSearches: SavedSearch[];
  savedReports: SavedReport[];
  researchReports: ResearchReport[];
  benchmarks: BenchmarkEntry[];
  suggestions: ProfileSuggestion[];
  chat: ChatMessage[];
  jdChat: JdChatMessage[];
  intake: IntakeItem[];
  outreach: OutreachMessage[];
  offers: Offer[];
  placements: Placement[];
  esaRecords: EsaRecord[];
  aiCalls: AiCall[];
  settings: Setting[];
  matchRuns: MatchRun[];
  matchExclusions: MatchExclusion[];
  liveMirror: LiveMirrorRow[];
  bin: BinEntry[];
}

/**
 * Something deleted, kept seven days in case it was a mistake (src/lib/bin.ts).
 * The JSON store lifts the rows off the desk into here; Convex stamps them in
 * place (convex/ta/bin.ts). Either way the Bin page reads `BinItem`.
 */
export interface BinEntry {
  id: Id;
  kind: "opening" | "client";
  itemId: Id;
  binnedAt: number;
  binnedBy: Id | null;
  /** The rows taken off the desk with it, put back as they were on Restore. */
  rows: Partial<Database>;
  /** CVs that came in for the opening: they stay, and get it back on Restore. */
  intake: { id: Id; openingId: Id | null; jobPostId: Id | null }[];
}

/** One row on the Bin page. */
export interface BinItem {
  kind: "opening" | "client";
  id: Id;
  name: string;
  /** The opening's client; null for a client. */
  clientName: string | null;
  binnedAt: number;
  binnedBy: string | null;
  purgeAt: number;
}

/**
 * A CV read from the current system over the read-only link (lib/live). The
 * candidate itself sits in `candidates` with an `lv_` id; this keeps where it
 * came from and its text. Nothing here is ever written back.
 */
export interface LiveMirrorRow {
  candidateId: Id;
  liveId: string;
  rawText: string | null;
  textSource: "db" | "r2" | "none";
  syncedAt: number;
}

// ─── Database matches (13 September) ─────────────────────────────────────────

export interface MatchRun {
  id: Id;
  openingId: Id;
  at: number;
  trigger: "jd_approved" | "nightly" | "manual";
  /** Nearest by meaning, before any rule. */
  considered: number;
  afterRules: number;
  added: number;
  embedModel: string;
  /** The scoring rules the run used (lib/assessment). Absent on runs before 14 September. */
  assessmentVersion?: string;
  note: string | null;
}

/** Someone taken off an opening's database matches is not matched to it again. */
export interface MatchExclusion {
  openingId: Id;
  candidateId: Id;
  at: number;
}
