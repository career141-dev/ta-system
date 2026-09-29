// convex/ta/model/projections.ts
//
// Openings and applications as the TA platform reads them — the one place a
// stored row becomes that shape.
//
// Pure (types only from Convex), so the list queries use it and so does the
// write model (./tables.ts), which must compare a row as the app saw it with
// the row as it is now. Two copies of this projection would disagree about
// what "unchanged" means, and every save would report a conflict.

import type { Doc } from "../../_generated/dataModel";
import { toTaStage } from "../stages";
import { followUpOn } from "../../lib/followUpScope";

const n = <T>(v: T | undefined): T | null => (v === undefined ? null : v);

/** An opening as the TA platform reads it. Legacy fields are carried through
 *  unchanged so nothing is lost in translation. */
export function projectOpening(job: Doc<"jobs">) {
  const j = job as Doc<"jobs"> & { taLocations?: string[]; packageNotes?: string };
  return {
    id: job._id as string,
    title: job.title,
    clientId: (job.clientId ?? null) as string | null,
    clientName: job.clientName,
    clientIndustry: job.clientIndustry,
    jdMarkdown: job.jobDescription,
    jdStatus: job.jdStatus ?? null,
    jdApprovedAt: job.jdApprovedAt ?? null,
    jdApprovedBy: (job.jdApprovedBy ?? null) as string | null,
    briefId: (job.briefId ?? null) as string | null,
    keyword: job.keyword,
    // Several places can be written; the backend's single `location` is the first.
    locations: j.taLocations ?? (job.location ? [job.location] : []),
    targetNationalities: job.targetNationalities ?? [],
    targetGender: job.targetGender ?? null,
    headcount: job.headcount ?? 1,
    priorityTier: job.priorityTier ?? null,
    positionStatus: job.positionStatus ?? null,
    positionCode: job.positionCode ?? "",
    jobOrderNumber: job.jobOrderNumber ?? "",
    salaryMin: n(job.salaryMin),
    salaryMax: n(job.salaryMax),
    salaryCurrency: job.salaryCurrency ?? null,
    packageNotes: j.packageNotes ?? "",
    status: job.status,
    seniorityLevel: job.seniorityLevel,
    requiredSkills: job.requiredSkills ?? [],
    niceToHaveSkills: job.niceToHaveSkills ?? [],
    experienceMinYears: job.experienceMinYears ?? null,
    experienceMaxYears: job.experienceMaxYears ?? null,
    recruitmentType: job.recruitmentType ?? "both",
    isConfidential: job.isConfidential ?? false,
    educationLevel: job.educationLevel ?? null,
    languagesRequired: job.languagesRequired ?? [],
    // The job's requirements, as extracted from the JD on approval and edited by hand.
    requirementsStatus: job.requirementsStatus ?? null,
    requirementsExtractedAt: job.requirementsExtractedAt ?? null,
    requirementsError: job.requirementsError ?? null,
    requirementsLockedFields: job.requirementsLockedFields ?? [],
    requirementsEditedBy: (job.requirementsEditedBy ?? null) as string | null,
    requirementsEditedAt: job.requirementsEditedAt ?? null,
    followUpQuestions: job.followUpQuestions ?? [],
    autoFollowUp: followUpOn(job),
    taLeadId: (job.taLeadId ?? null) as string | null,
    directorId: (job.directorId ?? null) as string | null,
    assignedTaIds: (job.assignedTaIds ?? []) as string[],
    primaryRecruiterId: job.primaryRecruiterId as string,
    stageCounts: job.stageCounts ?? {},
    totalApplications: job.totalApplications ?? 0,
    valueOnProgressing: job.valueOnProgressing ?? null,
    valueOfPlacement: job.valueOfPlacement ?? null,
    valueLost: job.valueLost ?? null,
    requirementReceivedAt: job.requirementReceivedAt ?? null,
    assignedAt: job.assignedAt ?? null,
    closedAt: job.closedAt ?? null,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
  };
}

export function projectApplication(a: Doc<"applications">) {
  const x = a as Doc<"applications"> & { rating?: number | null; taNotes?: string[]; taPreparedCvBox?: { x: number; y: number } };
  return {
    id: a._id as string,
    openingId: a.jobId as string,
    candidateId: a.candidateId as string,
    jobPostId: (a.jobPostId ?? null) as string | null,
    stage: toTaStage(a.currentStage),
    backendStage: a.currentStage,
    ownerTaId: (a.ownerTaId ?? null) as string | null,
    shortlistedAt: a.shortlistedAt ?? null,
    setNumber: a.setNumber ?? null,
    answers: a.answers ?? {},
    sourcingChannel: a.taSourcingChannel ?? null,
    legacySourceChannel: a.sourceChannel,
    isAddOn: a.isAddOn ?? false,
    addedOnAt: a.addedOnAt ?? null,
    scoopBy: a.scoopByUserId ?? null,
    scoopAt: a.scoopAt ?? null,
    scoopFrom: (a.scoopFromUserId ?? null) as string | null,
    scoopReceivedAt: a.scoopReceivedAt ?? null,
    rating: x.rating ?? null,
    notes: x.taNotes ?? [],
    preparedCvBox: x.taPreparedCvBox ?? null,
    reviewNotes: a.reviewNotes ?? [],
    statusA: a.statusA ?? null,
    statusB: a.statusB ?? null,
    rankTier: a.rankTier ?? null,
    rankWeight: a.rankWeight ?? null,
    rejectedBy: (a.rejectedBy ?? null) as string | null,
    rejectReason: a.rejectReason ?? null,
    droppedOutReason: a.droppedOutReason ?? null,
    backupForApplicationId: (a.backupForApplicationId ?? null) as string | null,
    offerDeclinedAt: a.offerDeclinedAt ?? null,
    offerDeclineReason: a.offerDeclineReason ?? null,
    // Not the engine's aiMatchScore / aiMatchExplanation, nor candidateName:
    // no screen reads them from a list, and the explanation is a paragraph per
    // row — across the 8,378 applications the layout loads, most of a 6 MB
    // response. The profile reads them for one person (ta/candidates:profile).
    isActive: a.isActive,
    createdAt: typeof a.createdAt === "number" ? a.createdAt : Date.parse(String(a.createdAt)) || 0,
    lastStageChangedAt: a.lastStageChangedAt,
  };
}
