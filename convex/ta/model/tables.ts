// convex/ta/model/tables.ts
//
// Every table the TA platform keeps, and how each of its rows is stored.
//
// The app works in the shapes of src/data/types.ts. The database holds some of
// those in tables written for the TA platform (briefs, link vault, review
// rounds…) and the rest in tables the pipeline backend already owns (jobs,
// applications, candidates, interviews, offers…), whose field names and
// vocabularies differ. This module is the only place that knows both, in both
// directions:
//
//   fromDoc — a stored document as the app reads it. Used by the loaders, and
//             by the commit, to compare what the app saw with what is there now.
//   toDoc   — an app row as it must be stored. Only the fields the TA platform
//             owns; everything else on a shared document is left alone.
//
// Pure: no reads except through the `cx.get` it is handed, so it can be tested.

import { mapIndustry } from "../../lib/jobRequirements";
import type { Id } from "@/data/types";
import { channelOf, mapApplication, mapCandidateDoc, mapJobPost, mapOpening, mapUser } from "../../../src/data/convex/map";
import { toBackendStage, toTaStage } from "../stages";
import { projectApplication, projectOpening } from "./projections";
import { answersByLabel, questionLabels } from "../../lib/followUpScope";

export type Row = Record<string, unknown>;
type Doc = Record<string, unknown> & { _id: string; _creationTime?: number };

export interface ModelCx {
  /** Read another document (already renamed from any temporary id). */
  get(id: string): Promise<Doc | null>;
  now: number;
}

export interface TableModel {
  /** The Convex table rows are stored in. */
  backend: string;
  /** How a row is identified in the app: its `id`, or a natural key. */
  key: (row: Row) => string;
  fromDoc: (doc: Doc) => Row;
  /** The stored fields for a row. `insert` is true when creating the document. */
  toDoc: (row: Row, cx: ModelCx, insert: boolean) => Promise<Record<string, unknown>>;
  /** Rows without a stored id are found by their natural key. */
  locate?: "by_key";
  /** Instead of deleting the document, patch it (history the backend keeps). */
  softDelete?: (cx: ModelCx) => Record<string, unknown>;
  /** Refuse creating rows from the store: they are created elsewhere. */
  noInsert?: string;
}

// ─── helpers ─────────────────────────────────────────────────────────────────

/** null in the app, absent in an optional stored field. */
const u = <T>(v: T | null | undefined): T | undefined => (v === null || v === undefined ? undefined : v);
const nul = <T>(v: T | null | undefined): T | null => (v === undefined ? null : v);
const iso = (ms: number) => new Date(ms).toISOString();
const msOf = (v: unknown, fallback = 0): number => {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string") {
    const p = Date.parse(v);
    if (Number.isFinite(p)) return p;
  }
  return fallback;
};
const byId = (row: Row) => String(row.id);

/**
 * A table the TA platform owns outright: stored under the same field names.
 * `nullable` lists the fields the app reads as null when absent — Convex drops
 * undefined, and `x === null` checks in the app must still hold.
 */
function identity(backend: string, nullable: string[], opts: Partial<TableModel> = {}): TableModel {
  return {
    backend,
    key: byId,
    fromDoc: (doc) => {
      const { _id, _creationTime: _c, ...rest } = doc;
      const row: Row = { id: _id, ...rest };
      for (const f of nullable) if (row[f] === undefined) row[f] = null;
      return row;
    },
    toDoc: async (row) => {
      const { id: _id, ...rest } = row;
      const out: Row = {};
      for (const [k, v] of Object.entries(rest)) if (v !== undefined) out[k] = v;
      return out;
    },
    ...opts,
  };
}

const LEGACY_CHANNEL: Record<string, string> = {
  L: "linkedin",
  E: "email",
  DA: "whatsapp",
  FB: "meta_campaign",
  HH: "headhunting",
  IM: "manual_upload",
  SCOOP: "manual_upload",
};

/** "LKR 250,000", "250k", "USD 3,500 / month" → a number and a currency, where one can be read. */
export function readSalary(text: string | null | undefined): { amount: number; currency: string | null } | null {
  if (!text) return null;
  const t = text.replace(/,/g, "").trim();
  const cur = t.match(/\b(LKR|USD|AED|SAR|QAR|GBP|EUR|INR|Rs)\b/i)?.[1];
  const m = t.match(/(\d+(?:\.\d+)?)\s*(k|m|mn|million|lakhs?)?\b/i);
  if (!m) return null;
  let amount = Number(m[1]);
  const unit = (m[2] ?? "").toLowerCase();
  if (unit === "k") amount *= 1_000;
  else if (unit === "m" || unit === "mn" || unit === "million") amount *= 1_000_000;
  else if (unit.startsWith("lakh")) amount *= 100_000;
  if (!Number.isFinite(amount) || amount <= 0) return null;
  const currency = cur ? (cur.toLowerCase() === "rs" ? "LKR" : cur.toUpperCase()) : null;
  return { amount, currency };
}

// ─── the tables ──────────────────────────────────────────────────────────────

export const TABLES: Record<string, TableModel> = {
  users: {
    backend: "users",
    key: byId,
    fromDoc: (doc) => mapUser(doc as never) as unknown as Row,
    toDoc: async (r) => ({
      fullName: r.name,
      email: r.email,
      phone: u(r.phone as string | null),
      routingEmail: u(r.routingEmail as string | null),
      taRole: r.role,
      initials: r.initials,
      isActive: r.isActive,
    }),
    noInsert: "People are added from the People page, which creates their sign-in account too.",
  },

  clients: {
    backend: "clients",
    key: byId,
    fromDoc: (d) => ({
      id: d._id,
      name: d.name,
      industry: d.industry ?? "",
      contacts: d.contacts ?? [],
      esaSignedAt: nul(d.esaSignedAt as number | undefined),
      status: d.status ?? "active",
      createdAt: d.createdAt,
    }),
    toDoc: async (r) => ({
      name: r.name,
      nameKey: String(r.name ?? "").trim().toLowerCase().replace(/[^a-z0-9]+/g, " ").trim(),
      industry: r.industry ?? "",
      contacts: r.contacts ?? [],
      esaSignedAt: nul(r.esaSignedAt as number | null),
      status: r.status,
      createdAt: r.createdAt,
    }),
  },

  openings: {
    backend: "jobs",
    key: byId,
    fromDoc: (d) => {
      const { clientName: _n, clientIndustry: _i, ...opening } = mapOpening(projectOpening(d as never) as never);
      return opening as unknown as Row;
    },
    toDoc: async (r, cx, insert) => {
      const client = r.clientId ? await cx.get(String(r.clientId)) : null;
      const locations = (r.locations as string[]) ?? [];
      const current = insert ? null : await cx.get(String(r.id));
      const backendStatus =
        r.status === "on_hold" ? "on_hold"
        : r.status === "filled" ? "filled"
        : r.status === "closed" ? "cancelled"
        // "draft" and "active" both read as open; an unchanged open job keeps whichever it was.
        : current?.status === "draft" ? "draft" : "active";
      const doc: Record<string, unknown> = {
        title: r.title,
        clientId: u(r.clientId as string | null) || undefined,
        positionCode: r.positionCode ?? "",
        jobOrderNumber: r.jobOrderNumber ?? "",
        jobDescription: r.jdMarkdown ?? "",
        followUpQuestions: r.followUpQuestions ?? [],
        jdStatus: r.jdStatus,
        jdApprovedBy: u(r.jdApprovedBy as string | null),
        jdApprovedAt: u(r.jdApprovedAt as number | null),
        briefId: u(r.briefId as string | null),
        salaryMin: u(r.salaryMin as number | null),
        salaryMax: u(r.salaryMax as number | null),
        salaryCurrency: r.salaryCurrency,
        packageNotes: r.packageNotes ?? "",
        targetNationalities: r.targetNationalities ?? [],
        targetGender: nul(r.targetGender as string | null),
        location: locations[0] ?? "",
        taLocations: locations,
        headcount: r.headcount,
        priorityTier: r.priorityTier,
        positionStatus: r.positionStatus,
        assignedTaIds: r.assignedTaIds ?? [],
        taLeadId: u(r.taLeadId as string | null) || undefined,
        directorId: u(r.directorId as string | null),
        requirementReceivedAt: u(r.requirementReceivedAt as number | null),
        assignedAt: u(r.assignedAt as number | null),
        closedAt: u(r.closedAt as number | null),
        valueOnProgressing: u(r.valueOnProgressing as number | null),
        valueOfPlacement: u(r.valueOfPlacement as number | null),
        valueLost: u(r.valueLost as number | null),
        status: backendStatus,
        updatedAt: iso(msOf(r.updatedAt, cx.now)),
      };
      if (client) {
        doc.clientName = client.name;
        doc.clientIndustry = mapIndustry(client.industry as string | undefined) ?? "Other";
      }
      // The CV pipeline's follow-up asks, and reads replies, by the question's
      // wording. Kept in step — except on a job never backfilled, whose own
      // old questions must not be wiped by an empty list it has not seen.
      const questions = (r.followUpQuestions as { id: string; label: string }[]) ?? [];
      if (insert || questions.length > 0 || current?.followUpQuestions !== undefined) {
        doc.customFollowUpQuestions = questionLabels(questions);
      }
      if (insert) {
        const lead = (r.taLeadId as string) || ((r.assignedTaIds as string[]) ?? [])[0];
        if (!lead) throw new Error("An opening needs a lead or an assigned recruiter before it can be saved.");
        const slug = String(r.title ?? "role").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40);
        Object.assign(doc, {
          clientName: client?.name ?? "",
          clientIndustry: mapIndustry(client?.industry as string | undefined) ?? "Other",
          recruitmentType: "job_posting",
          isConfidential: false,
          requiredSkills: [],
          seniorityLevel: "other",
          experienceMinYears: 0,
          // The engines route mail on this; a TA-created opening gets one no subject line will carry by accident.
          keyword: `ta-${slug}-${String(r.id).slice(-6)}`,
          primaryRecruiterId: lead,
          directorReviewEnabled: true,
          clientReviewEnabled: true,
          esaCheckEnabled: false,
          rejectionLoopAction: "ask_ta_each_time",
          headhuntingEnabled: false,
          createdAt: iso(msOf(r.createdAt, cx.now)),
        });
      }
      return doc;
    },
  },

  applications: {
    backend: "applications",
    key: byId,
    fromDoc: (d) => mapApplication(projectApplication(d as never) as never) as unknown as Row,
    toDoc: async (r, _cx, insert) => {
      const stage = String(r.stage);
      // The same answers where the CV pipeline's follow-up looks for them: by
      // question wording, merged over what its reply reading already stored.
      const answers = (r.answers as Record<string, string>) ?? {};
      let customFollowUpAnswers: Record<string, string> | undefined;
      if (Object.keys(answers).length > 0) {
        const opening = await _cx.get(String(r.openingId));
        const mirrored = answersByLabel((opening?.followUpQuestions as { id: string; label: string }[]) ?? [], answers);
        if (Object.keys(mirrored).length > 0) {
          const current = insert ? null : await _cx.get(String(r.id));
          customFollowUpAnswers = { ...((current?.customFollowUpAnswers as Record<string, string>) ?? {}), ...mirrored };
        }
      }
      const doc: Record<string, unknown> = {
        jobId: r.openingId,
        candidateId: r.candidateId,
        jobPostId: u(r.jobPostId as string | null),
        currentStage: toBackendStage(stage),
        answers: r.answers ?? {},
        taSourcingChannel: r.sourcingChannel,
        ownerTaId: u(r.ownerTaId as string | null),
        shortlistedAt: u(r.shortlistedAt as number | null),
        setNumber: nul(r.setNumber as number | null),
        rating: nul(r.rating as number | null),
        taNotes: r.notes ?? [],
        statusA: nul(r.statusA as string | null),
        statusB: nul(r.statusB as string | null),
        rankTier: nul(r.rankTier as string | null),
        rankWeight: u(r.rankWeight as number | null),
        rejectedBy: u(r.rejectedBy as string | null),
        rejectReason: u(r.rejectReason as string | null),
        droppedOutReason: u(r.droppedOutReason as string | null),
        isAddOn: !!r.isAddOn,
        addedOnAt: u(r.addedOnAt as number | null),
        backupForApplicationId: u(r.backupForApplicationId as string | null),
        offerDeclinedAt: u(r.offerDeclinedAt as number | null),
        offerDeclineReason: u(r.offerDeclineReason as string | null),
        lastStageChangedAt: r.lastStageChangedAt,
        isActive: stage !== "rejected" && stage !== "dropped_out",
      };
      if (customFollowUpAnswers) doc.customFollowUpAnswers = customFollowUpAnswers;
      if (insert) {
        Object.assign(doc, {
          sourceChannel: LEGACY_CHANNEL[String(r.sourcingChannel)] ?? "manual_upload",
          loopIteration: 0,
          createdAt: msOf(r.createdAt, _cx.now),
        });
      }
      return doc;
    },
  },

  candidates: {
    backend: "candidates",
    key: byId,
    fromDoc: (d) => mapCandidateDoc(d as never) as unknown as Row,
    toDoc: async (r, cx, insert) => {
      const cur = readSalary(r.currentSalary as string | null);
      const exp = readSalary(r.expectedSalary as string | null);
      const phone = (r.phone as string | null) ?? null;
      const doc: Record<string, unknown> = {
        fullName: r.fullName,
        email: u(r.email as string | null),
        phone: u(phone),
        phoneClean: phone ? phone.replace(/\D/g, "") : undefined,
        linkedinUrl: u(r.linkedinUrl as string | null),
        location: u(r.location as string | null),
        nationality: u(r.nationality as string | null),
        age: u(r.age as number | null),
        gender: u(r.gender as string | null),
        currentEmployer: u(r.currentEmployer as string | null),
        currentJobTitle: u(r.currentTitle as string | null),
        totalExperienceYears: u(r.totalExperienceYears as number | null),
        educationDegree: u(r.educationDegree as string | null),
        educationInstitution: u(r.educationInstitution as string | null),
        certifications: r.qualifications ? String(r.qualifications).split(/,\s*/).filter(Boolean) : undefined,
        languages: r.languages ?? [],
        skills: r.skills ?? [],
        industries: r.industries ?? [],
        noticePeriodDays: u(r.noticePeriodDays as number | null),
        noticePeriod: u(r.noticePeriod as string | null),
        taCurrentSalaryText: u(r.currentSalary as string | null),
        currentSalary: cur?.amount,
        currentSalaryCurrency: cur?.currency ?? undefined,
        taExpectedSalaryText: u(r.expectedSalary as string | null),
        expectedSalary: exp?.amount,
        expectedSalaryCurrency: exp?.currency ?? undefined,
        englishLevel: u(r.englishLevel as number | null),
        cvFileName: u(r.cvFileName as string | null),
        lastUpdatedAt: cx.now,
      };
      if (insert) Object.assign(doc, { firstSeenAt: msOf(r.createdAt, cx.now), status: "new", isParsed: true });
      return doc;
    },
  },

  jobPosts: {
    backend: "jobPosts",
    key: byId,
    fromDoc: (d) => mapJobPost({ ...d, id: d._id } as never, String(d.openingId)) as unknown as Row,
    toDoc: async (r) => {
      const { id: _id, ...rest } = r;
      return rest;
    },
  },

  assignments: {
    backend: "jobAssignments",
    key: byId,
    fromDoc: (d) => ({
      id: d._id,
      openingId: d.jobId,
      userId: d.userId,
      role: d.assignmentRole,
      assignedAt: msOf(d.assignedAt),
      assignedBy: nul(d.assignedBy as string | undefined),
      workingStage: (d.workingStage as string | undefined) ?? undefined,
    }),
    toDoc: async (r, cx) => ({
      jobId: r.openingId,
      userId: r.userId,
      assignmentRole: r.role,
      // The backend requires who assigned it; an assignment the app made without
      // naming anyone is recorded against the person assigned.
      assignedBy: r.assignedBy ?? r.userId,
      assignedAt: iso(msOf(r.assignedAt, cx.now)),
      isActive: true,
      ...(r.workingStage ? { workingStage: r.workingStage } : {}),
    }),
    // Assignments are revoked, not erased: the backend keeps who was on a job.
    softDelete: (cx) => ({ isActive: false, revokedAt: iso(cx.now) }),
  },

  referees: {
    backend: "referees",
    key: byId,
    fromDoc: (d) => ({
      id: d._id,
      fromCandidateId: d.candidateId,
      name: d.name,
      title: nul(d.designation as string | undefined),
      company: nul(d.company as string | undefined),
      phone: nul(d.contactNo as string | undefined),
      email: nul(d.email as string | undefined),
      relationship: nul(d.relationship as string | undefined),
      contactable: d.contactable ?? true,
      lastContactedAt: nul(d.lastContactedAt as number | undefined),
      extractedAt: (d.extractedAt as number | undefined) ?? msOf(d.createdAt),
    }),
    toDoc: async (r, cx, insert) => ({
      candidateId: r.fromCandidateId,
      name: r.name,
      designation: u(r.title as string | null),
      company: u(r.company as string | null),
      contactNo: u(r.phone as string | null),
      email: u(r.email as string | null),
      relationship: u(r.relationship as string | null),
      contactable: r.contactable,
      lastContactedAt: u(r.lastContactedAt as number | null),
      extractedAt: r.extractedAt,
      ...(insert ? { createdAt: iso(msOf(r.extractedAt, cx.now)) } : {}),
    }),
  },

  pipelineEvents: {
    backend: "pipelineEvents",
    key: byId,
    fromDoc: (d) => ({
      id: d._id,
      applicationId: (d.applicationId as string | undefined) ?? "",
      openingId: d.jobId,
      eventType: d.eventType,
      fromStage: d.fromStage ? toTaStage(String(d.fromStage)) : null,
      toStage: d.toStage ? toTaStage(String(d.toStage)) : null,
      actorType: (d.taActorType as string | undefined) ?? (d.actorType === "user" ? "user" : "system"),
      actorId: nul(d.actorId as string | undefined),
      note: (d.note as string | undefined) ?? (d.notes as string | undefined) ?? null,
      at: d.createdAt,
    }),
    toDoc: async (r) => ({
      applicationId: u(r.applicationId as string | null) || undefined,
      jobId: r.openingId,
      eventType: r.eventType,
      fromStage: r.fromStage ? toBackendStage(String(r.fromStage)) : undefined,
      toStage: r.toStage ? toBackendStage(String(r.toStage)) : undefined,
      actorType: r.actorType === "system" ? "system" : "user",
      taActorType: r.actorType,
      actorId: u(r.actorId as string | null),
      note: u(r.note as string | null),
      createdAt: r.at,
    }),
  },

  interviews: {
    backend: "interviews",
    key: byId,
    fromDoc: (d) => ({
      id: d._id,
      applicationId: d.applicationId,
      scheduledAt: (d.scheduledAt as number | undefined) ?? 0,
      timezone: (d.timezone as string | undefined) ?? "Asia/Colombo",
      location: (d.location as string | undefined) ?? "",
      mode: (d.interviewFormat as string | undefined) ?? "in_person",
      round: (d.round as number | undefined) ?? 1,
      interviewers: (d.interviewers as string[] | undefined) ?? [],
      durationMins: nul(d.durationMins as number | undefined),
      confirmedAt: nul(d.confirmedAt as number | undefined),
      notes: nul(d.taNotes as string | undefined),
      outcome: (d.taOutcome as string | undefined) ?? (d.outcome === "no_show" ? "no_show" : d.outcome === "passed" || d.outcome === "failed" ? "attended" : "pending"),
      result: (d.taResult as string | undefined) ?? (d.outcome === "passed" || d.outcome === "failed" ? d.outcome : "pending"),
      clientRating: nul(d.clientRating as number | undefined),
      clientFeedback: nul(d.clientFeedback as string | undefined),
      createdAt: d.createdAt,
    }),
    toDoc: async (r, cx, insert) => {
      const round = Number(r.round ?? 1);
      const doc: Record<string, unknown> = {
        applicationId: r.applicationId,
        interviewType: round <= 1 ? "first_interview" : round === 2 ? "second_interview" : "final_interview",
        scheduledAt: r.scheduledAt,
        interviewFormat: r.mode,
        panelNames: ((r.interviewers as string[]) ?? []).join(", ") || undefined,
        // The backend's single outcome, from the desk's two.
        outcome: r.result === "passed" ? "passed" : r.result === "failed" ? "failed" : r.outcome === "no_show" ? "no_show" : "pending",
        clientRating: u(r.clientRating as number | null),
        clientFeedback: u(r.clientFeedback as string | null),
        taNotes: u(r.notes as string | null),
        taOutcome: r.outcome,
        taResult: r.result,
        timezone: r.timezone,
        location: r.location,
        round,
        interviewers: r.interviewers ?? [],
        durationMins: u(r.durationMins as number | null),
        confirmedAt: u(r.confirmedAt as number | null),
      };
      if (insert) {
        const app = await cx.get(String(r.applicationId));
        if (!app) throw new Error("The application this interview is for no longer exists.");
        Object.assign(doc, { jobId: app.jobId, candidateId: app.candidateId, createdAt: msOf(r.createdAt, cx.now) });
      }
      return doc;
    },
  },

  offers: {
    backend: "offers",
    key: byId,
    fromDoc: (d) => ({
      id: d._id,
      applicationId: d.applicationId,
      openingId: d.jobId,
      candidateId: d.candidateId,
      salary: d.offeredSalary,
      salaryBasis: (d.salaryBasis as string | undefined) ?? "monthly",
      currency: d.offeredSalaryCurrency,
      startDate: (d.startDateMs as number | undefined) ?? (d.offeredStartDate ? msOf(d.offeredStartDate) : null),
      terms: nul(d.contractTerms as string | undefined),
      status: d.status,
      respondedAt: nul(d.candidateResponseAt as number | undefined),
      declineReason: nul(d.declineReason as string | undefined),
      madeBy: (d.madeBy as string | undefined) ?? "",
      createdAt: d.createdAt,
    }),
    toDoc: async (r, cx, insert) => ({
      applicationId: r.applicationId,
      jobId: r.openingId,
      candidateId: r.candidateId,
      offeredSalary: r.salary,
      offeredSalaryCurrency: r.currency,
      salaryBasis: r.salaryBasis,
      startDateMs: u(r.startDate as number | null),
      offeredStartDate: r.startDate ? iso(Number(r.startDate)) : undefined,
      contractTerms: u(r.terms as string | null),
      status: r.status,
      candidateResponseAt: u(r.respondedAt as number | null),
      declineReason: u(r.declineReason as string | null),
      madeBy: u(r.madeBy as string | null) || undefined,
      ...(insert ? { aiCallConfirmation: false, createdAt: msOf(r.createdAt, cx.now) } : {}),
    }),
  },

  placements: {
    backend: "placements",
    key: byId,
    fromDoc: (d) => ({
      id: d._id,
      offerId: d.offerId,
      applicationId: d.applicationId,
      openingId: d.jobId,
      candidateId: d.candidateId,
      clientId: (d.clientId as string | undefined) ?? "",
      placedBy: d.placedBy,
      sourcingChannel: (d.taSourcingChannel as string | undefined) ?? channelOf(d.sourceChannel as string),
      salary: d.placedSalary,
      salaryBasis: (d.salaryBasis as string | undefined) ?? "monthly",
      currency: d.placedSalaryCurrency,
      joinDate: (d.joinDateMs as number | undefined) ?? msOf(d.joinDate),
      joinConfirmedAt: nul(d.joinConfirmedAt as number | undefined),
      feePercent: nul(d.feePercent as number | null | undefined),
      flatFee: nul(d.flatFee as number | null | undefined),
      invoiceSentAt: nul(d.invoiceSentAt as number | undefined),
      invoiceNumber: nul(d.invoiceNumber as string | undefined),
      invoicePaidAt: nul(d.invoicePaidAt as number | undefined),
      guaranteeDays: (d.guaranteeDays as number | undefined) ?? 90,
      fellThroughAt: nul(d.fellThroughAt as number | undefined),
      fellThroughReason: nul(d.fellThroughReason as string | undefined),
      notes: nul(d.notes as string | undefined),
      createdAt: d.createdAt,
    }),
    toDoc: async (r, cx, insert) => ({
      offerId: r.offerId,
      applicationId: r.applicationId,
      jobId: r.openingId,
      candidateId: r.candidateId,
      clientId: u(r.clientId as string | null) || undefined,
      placedBy: r.placedBy,
      sourceChannel: LEGACY_CHANNEL[String(r.sourcingChannel)] ?? "manual_upload",
      taSourcingChannel: r.sourcingChannel,
      placedSalary: r.salary,
      placedSalaryCurrency: r.currency,
      salaryBasis: r.salaryBasis,
      joinDate: iso(Number(r.joinDate)),
      joinDateMs: r.joinDate,
      joinConfirmedAt: u(r.joinConfirmedAt as number | null),
      feePercent: nul(r.feePercent as number | null),
      flatFee: nul(r.flatFee as number | null),
      invoiceSent: !!r.invoiceSentAt,
      invoiceSentAt: u(r.invoiceSentAt as number | null),
      invoiceNumber: u(r.invoiceNumber as string | null),
      invoicePaidAt: u(r.invoicePaidAt as number | null),
      guaranteeDays: r.guaranteeDays,
      fellThroughAt: u(r.fellThroughAt as number | null),
      fellThroughReason: u(r.fellThroughReason as string | null),
      notes: u(r.notes as string | null),
      ...(insert ? { placementSnippetSent: false, createdAt: msOf(r.createdAt, cx.now) } : {}),
    }),
  },

  esaRecords: {
    backend: "esaRecords",
    key: byId,
    fromDoc: (d) => ({
      id: d._id,
      clientId: (d.clientId as string | undefined) ?? "",
      openingId: nul(d.jobId as string | undefined),
      status: d.status === "pending" ? "draft" : d.status,
      feePercent: nul(d.feePercent as number | null | undefined),
      guaranteeDays: (d.guaranteeDays as number | undefined) ?? 90,
      sentAt: nul(d.sentAt as number | undefined),
      signedAt: nul(d.signedAt as number | undefined),
      signedBy: nul(d.signedBy as string | undefined),
      dueAt: nul((d.dueAt ?? d.slaDeadlineAt) as number | undefined),
      documentName: nul(d.documentName as string | undefined),
      notes: nul(d.notes as string | undefined),
      createdAt: d.createdAt,
    }),
    toDoc: async (r, cx, insert) => {
      const client = r.clientId ? await cx.get(String(r.clientId)) : null;
      const contacts = (client?.contacts as { email: string; isPrimary: boolean }[] | undefined) ?? [];
      return {
        clientId: u(r.clientId as string | null) || undefined,
        jobId: u(r.openingId as string | null),
        status: r.status === "draft" ? "pending" : r.status,
        feePercent: nul(r.feePercent as number | null),
        guaranteeDays: r.guaranteeDays,
        sentAt: u(r.sentAt as number | null),
        signedAt: u(r.signedAt as number | null),
        signedBy: u(r.signedBy as string | null),
        dueAt: u(r.dueAt as number | null),
        slaDeadlineAt: u(r.dueAt as number | null),
        documentName: u(r.documentName as string | null),
        notes: u(r.notes as string | null),
        ...(client ? { clientName: client.name, clientEmail: (contacts.find((c) => c.isPrimary) ?? contacts[0])?.email ?? "" } : {}),
        ...(insert ? { slaBreached: false, createdAt: msOf(r.createdAt, cx.now), clientName: client?.name ?? "", clientEmail: (contacts.find((c) => c.isPrimary) ?? contacts[0])?.email ?? "" } : {}),
      };
    },
  },

  settings: {
    backend: "taSettings",
    key: (r) => String(r.key),
    locate: "by_key",
    fromDoc: (d) => ({ key: d.key, value: d.value, updatedAt: d.updatedAt }),
    toDoc: async (r) => ({ key: r.key, value: r.value, updatedAt: r.updatedAt }),
  },

  matchExclusions: {
    backend: "matchExclusions",
    key: (r) => `${r.openingId}:${r.candidateId}`,
    locate: "by_key",
    fromDoc: (d) => ({ openingId: d.openingId, candidateId: d.candidateId, at: d.at }),
    toDoc: async (r) => ({ openingId: r.openingId, candidateId: r.candidateId, at: r.at }),
  },

  aiCalls: identity("taScreeningCalls", ["consent", "consentAt", "consentText", "transcript", "durationSeconds", "endedAt", "failureReason"]),
  outreach: identity("taOutreach", ["to", "subject", "sentAt", "byUserId", "callOutcome", "promisedAt"]),
  alerts: identity("taAlerts", ["resolvedAt"]),
  briefs: (() => {
    const base = identity("briefs", ["clientId", "openingId", "transcript", "recordingKey", "recordingDurationMs", "consentAcknowledgedBy", "consentAcknowledgedAt", "consentText"]);
    return {
      ...base,
      // A brief saved before extraction finished, or by an older build, can hold
      // only some of the extracted fields. Every screen reads the lists as lists.
      fromDoc: (doc) => {
        const row = base.fromDoc(doc);
        const e = (row.extracted ?? {}) as Row;
        row.extracted = {
          title: "", salaryMin: null, salaryMax: null, currency: "LKR", packageNotes: "", headcount: 1, clientNotes: "", priorityTier: "P3",
          ...e,
          locations: Array.isArray(e.locations) ? e.locations : [],
          nationalities: Array.isArray(e.nationalities) ? e.nationalities : [],
          mustHaves: Array.isArray(e.mustHaves) ? e.mustHaves : [],
        };
        return row;
      },
    };
  })(),
  reviewRounds: identity("reviewRounds", ["messageId", "setNumber", "trackedAt", "returnedAt", "replyBody"]),
  linkVault: identity("linkVault", ["name", "title", "company", "phoneNumber", "phoneSource", "candidateId", "capture"]),
  savedSearches: identity("savedSearches", ["openingId", "lastRunAt", "lastResultCount"]),
  savedReports: identity("savedReports", []),
  researchReports: identity("researchReports", ["clientId"]),
  benchmarks: identity("benchmarks", ["name", "linkedinUrl", "sourceUrl", "sourceTitle"]),
  suggestions: identity("profileSuggestions", ["company", "location", "linkedinUrl", "concern", "sourceUrl", "feedback", "generatedFor", "keptBy"]),
  chat: identity("sourcingChat", ["action", "byUserId"]),
  jdChat: identity("jdChat", ["jdMarkdown", "byUserId"]),
  intake: identity("intakeItems", ["receivedFrom", "fileName", "fileHash", "sizeBytes", "rawText", "parsed", "match", "toAddress", "subject", "openingId", "jobPostId", "routedToTaId", "routeNote", "routeConfidence", "candidateId", "handledBy", "handledAt", "note"]),
  matchRuns: identity("matchRuns", ["note"]),
  callFeedback: identity("callFeedback", ["structured"]),
};

/** The app tables the store keeps. `liveMirror` is the JSON store's read-only copy and has no table. */
export const TA_TABLES = Object.keys(TABLES);

/**
 * Whether two values are the same as far as the app is concerned (null and
 * absent are). Exact on text: this decides what a save writes, so "nimal" and
 * "Nimal", or "250,000" and "250000", are different — a correction that only
 * changes case or commas must be saved (review of PR #10, 22 September).
 */
export function sameValue(a: unknown, b: unknown): boolean {
  if (a === undefined) a = null;
  if (b === undefined) b = null;
  if (a === b) return true;
  if (typeof a !== typeof b || a === null || b === null) return false;
  if (typeof a !== "object") return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a)) {
    const bb = b as unknown[];
    return a.length === bb.length && a.every((x, i) => sameValue(x, bb[i]));
  }
  const ka = Object.keys(a as object).filter((k) => (a as Row)[k] !== undefined && (a as Row)[k] !== null);
  const kb = Object.keys(b as object).filter((k) => (b as Row)[k] !== undefined && (b as Row)[k] !== null);
  if (ka.length !== kb.length) return false;
  return ka.every((k) => sameValue((a as Row)[k], (b as Row)[k]));
}

/**
 * The same value, ignoring case, commas and surrounding spaces — for the
 * conflict check only. A field reformatted since the page loaded ("250000"
 * read back as "250,000") is not an edit by someone else and should not refuse
 * the save; what gets written is still decided by `sameValue`.
 */
export function looselySame(a: unknown, b: unknown): boolean {
  if (typeof a === "string" && typeof b === "string") {
    return a.replace(/,/g, "").trim().toLowerCase() === b.replace(/,/g, "").trim().toLowerCase();
  }
  return sameValue(a, b);
}

export type { Id };
