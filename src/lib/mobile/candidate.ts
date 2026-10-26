import { repo } from "@/data/store";
import { STAGE_LABEL, type User } from "@/data/types";
import { allows } from "@/lib/auth";
import { interviewStatus, mayChangeFeedback } from "@/lib/interviews";
import type { CandidatePayload } from "@/lib/mobile/candidateTypes";
import { isSystemNote } from "@/lib/pdf";
import { seatFor, visibleToSeat } from "@/lib/visibility";

export type MobileCandidateResult =
  | { kind: "ok"; payload: CandidatePayload }
  | { kind: "not_found" }
  | { kind: "forbidden"; message: string };

const TAB_LABEL: Record<CandidatePayload["tabs"][number]["key"], string> = {
  cv: "CV",
  prepared: "Prepared CV",
  history: "History",
  call: "Call Log",
  chat: "Chat",
  reference: "Reference",
  company_refs: "Company Reference",
};

function initials(name: string): string {
  return name.split(/\s+/).filter(Boolean).slice(0, 2).map((part) => part[0]?.toUpperCase()).join("");
}

function reviewDetail(note: string, index: number): { label: string; value: string } | null {
  const trimmed = note.replace(/^[->•*]\s*/, "").trim();
  if (!trimmed) return null;
  const colon = trimmed.indexOf(":");
  const dash = trimmed.indexOf(" - ");
  if (colon > 0 && (dash === -1 || colon < dash)) {
    return { label: trimmed.slice(0, colon).trim(), value: trimmed.slice(colon + 1).trim() };
  }
  if (dash > 0) return { label: trimmed.slice(0, dash).trim(), value: trimmed.slice(dash + 3).trim() };
  return { label: index >= 0 ? "Note" : "", value: trimmed };
}

/** The website candidate drawer, as one seat-scoped native payload. */
export function mobileCandidate(user: User, openingId: string, applicationId: string): MobileCandidateResult {
  const opening = repo.opening(openingId);
  const app = repo.application(applicationId);
  if (!opening || !app || app.openingId !== opening.id) return { kind: "not_found" };

  const assignment = repo.assignmentFor(openingId, user.id) ?? null;
  const onStrategy = repo.strategyAssignments(openingId).some((row) => row.doneBy.includes(user.id));
  const seat = seatFor(user, assignment?.role ?? null, onStrategy);
  if (!allows(user, "opening.read", { openingId, assignment, onStrategy })) {
    return { kind: "forbidden", message: "You do not have access to this candidate through this opening." };
  }
  if (seat.stages !== null && !seat.stages.includes(app.stage)) {
    return { kind: "forbidden", message: "This candidate is outside the pipeline stages available to your role." };
  }
  if (visibleToSeat([app], seat).length === 0) {
    return { kind: "forbidden", message: "This candidate belongs to another recruiter on this opening." };
  }

  const candidate = repo.candidate(app.candidateId);
  const client = repo.client(opening.clientId);
  if (!candidate || !client) return { kind: "not_found" };

  const users = repo.users();
  const userName = (id: string | null) => id ? users.find((row) => row.id === id)?.name ?? null : null;
  const siblings = visibleToSeat(repo.applications(openingId), seat).filter((row) => row.stage === app.stage);
  const index = siblings.findIndex((row) => row.id === app.id);
  const outreach = repo.outreach(app.id);
  const refs = repo.referees().filter((row) => row.fromCandidateId === candidate.id);
  const company = (candidate.currentEmployer ?? candidate.workHistory?.[0]?.employer ?? "").trim();
  const companyReferences = company
    ? repo.peopleAtCompany(company, candidate.id).map((row) => ({
        id: row.id,
        name: row.fullName,
        title: row.currentTitle ?? null,
        company: row.currentEmployer ?? company,
        phone: row.phone ?? null,
        email: row.email ?? null,
        kind: ((row as typeof row & { kind?: "candidate" | "referee" }).kind ?? "candidate") as "candidate" | "referee",
      }))
    : [];
  const events = repo.events(app.id);
  const calls = repo.callFeedback(app.id).map((row) => ({
    id: row.id,
    kind: row.kind,
    outcome: row.outcome,
    body: row.body,
    source: row.source,
    at: row.recordedAt,
    byName: userName(row.recordedBy),
  }));
  const aiCalls = outreach.filter((row) => row.channel === "ai_call").map((row) => ({
    id: row.id,
    kind: "AI follow-up",
    outcome: row.callOutcome ?? (row.sentAt ? "sent" : "draft"),
    body: row.body,
    source: "ai_call",
    at: row.sentAt ?? row.createdAt,
    byName: userName(row.byUserId),
  }));
  const offer = repo.offers(app.id)[0] ?? null;
  const placement = repo.placementForApplication(app.id) ?? null;
  const questions = new Map(opening.followUpQuestions.map((question) => [question.id, question.label]));
  const reviewNotes = (app.reviewNotes ?? []).map((note) => ({
    id: note.id,
    note: note.note,
    byUserId: note.by,
    byName: userName(note.by) ?? "Unknown",
    byRole: note.byRole,
    at: note.at,
    canRemove: note.by === user.id,
  }));
  const messages = outreach.filter((row): row is typeof row & { channel: "whatsapp" | "email" } => row.channel !== "ai_call");
  const tags = [
    app.isAddOn ? "Add-on" : null,
    app.backupForApplicationId ? "Backup" : null,
    app.sourcingChannel === "HH" ? "Headhunted" : null,
    !app.ownerTaId ? "Unclaimed" : null,
  ].filter((value): value is string => Boolean(value));
  const canManageInterviews = allows(user, "opening.act", { openingId, assignment, ownerTaId: app.ownerTaId });
  const canGiveInterviewFeedback = allows(user, "interview.feedback", { openingId, assignment });
  const reviewStages = ["new_cv", "matched", "ai_follow_up", "ta_follow_up"];
  const showReviewDetails = reviewStages.includes(app.stage);
  const canAddReviewNote = app.stage === "director_review" && allows(user, "review.note", { openingId, assignment });
  const hasCv = Boolean(candidate.cvFileName || app.cvFileName);
  const noticePeriod = candidate.noticePeriod ?? (candidate.noticePeriodDays === null ? "" : candidate.noticePeriodDays === 0 ? "Immediate" : `${candidate.noticePeriodDays} days`);
  const missingReviewDetails = [
    !hasCv ? "CV" : null,
    !candidate.expectedSalary?.trim() ? "expected salary" : null,
    !noticePeriod.trim() ? "notice period" : null,
  ].filter((value): value is string => Boolean(value));
  const customDetails = (app.notes ?? [])
    .filter((note) => !isSystemNote(note))
    .map(reviewDetail)
    .filter((detail): detail is { label: string; value: string } => Boolean(detail?.value));

  const payload: CandidatePayload = {
    apiVersion: 1,
    context: {
      applicationId: app.id,
      openingId: opening.id,
      openingTitle: opening.title,
      clientName: client.name,
      stage: app.stage,
      stageLabel: STAGE_LABEL[app.stage],
      position: index + 1,
      total: siblings.length,
      previousApplicationId: index > 0 ? siblings[index - 1]?.id ?? null : null,
      nextApplicationId: index >= 0 && index < siblings.length - 1 ? siblings[index + 1]?.id ?? null : null,
      interviewAccess: {
        canBook: canManageInterviews && (app.stage === "client_shortlist" || app.stage === "interview"),
        canManage: canManageInterviews,
        canFeedback: canGiveInterviewFeedback,
        userId: user.id,
        userName: user.name,
      },
    },
    profile: {
      candidateId: candidate.id,
      name: candidate.fullName,
      initials: initials(candidate.fullName),
      currentTitle: candidate.currentTitle,
      currentEmployer: candidate.currentEmployer,
      education: [candidate.educationDegree, candidate.educationInstitution].filter(Boolean).join(" · ") || null,
      location: candidate.location,
      email: candidate.email,
      phone: candidate.phone,
      linkedinUrl: candidate.linkedinUrl,
      experienceYears: candidate.totalExperienceYears,
      noticePeriod: candidate.noticePeriod ?? (candidate.noticePeriodDays === null ? null : `${candidate.noticePeriodDays} days`),
      currentSalary: candidate.currentSalary,
      expectedSalary: candidate.expectedSalary,
      ownerName: userName(app.ownerTaId),
      sourcingChannel: app.sourcingChannel,
      setNumber: app.setNumber,
      rating: app.rating,
      tags,
      canAct: canManageInterviews,
    },
    onOpenings: repo.applicationsForCandidate(candidate.id).map((row) => {
      const rowOpening = repo.opening(row.openingId);
      return {
        applicationId: row.id,
        openingId: row.openingId,
        openingTitle: rowOpening?.title ?? "—",
        clientName: repo.client(rowOpening?.clientId ?? "")?.name ?? "—",
        stageLabel: STAGE_LABEL[row.stage],
      };
    }),
    interviews: repo.interviews(app.id).sort((a, b) => a.scheduledAt - b.scheduledAt).map((row) => ({
      id: row.id,
      title: row.title ?? `Interview ${row.round}`,
      scheduledAt: row.scheduledAt,
      timezone: row.timezone,
      location: row.location,
      mode: row.mode,
      round: row.round,
      interviewers: row.interviewers,
      durationMins: row.durationMins,
      confirmedAt: row.confirmedAt,
      notes: row.notes,
      outcome: row.outcome,
      result: row.result,
      clientRating: row.clientRating,
      clientFeedback: row.clientFeedback,
      status: interviewStatus(row),
      feedback: row.feedback.map((entry) => ({
        byUserId: entry.byUserId,
        byName: userName(entry.byUserId) ?? "Unknown",
        interviewer: entry.interviewer,
        ratings: entry.ratings,
        recommendation: entry.recommendation,
        comments: entry.comments,
        at: entry.at,
        updatedAt: entry.updatedAt,
        canEdit: canGiveInterviewFeedback && mayChangeFeedback(user, entry),
      })),
      history: [...row.history].reverse().map((entry) => ({
        at: entry.at,
        byName: userName(entry.byUserId) ?? "Unknown",
        kind: entry.kind,
        detail: entry.detail,
        reason: entry.reason,
      })),
    })),
    closing: {
      access: {
        canManage: canManageInterviews,
        canMakeOffer: canManageInterviews && ["client_shortlist", "interview", "offer", "placed"].includes(app.stage),
      },
      offer: offer ? {
        id: offer.id,
        salary: offer.salary,
        salaryBasis: offer.salaryBasis,
        currency: offer.currency,
        startDate: offer.startDate,
        terms: offer.terms,
        status: offer.status,
        declineReason: offer.declineReason,
        createdAt: offer.createdAt,
        respondedAt: offer.respondedAt,
      } : null,
      placement: placement ? {
        id: placement.id,
        joinDate: placement.joinDate,
        joinConfirmedAt: placement.joinConfirmedAt,
        salary: placement.salary,
        salaryBasis: placement.salaryBasis,
        currency: placement.currency,
        invoiceNumber: placement.invoiceNumber,
        invoicePaidAt: placement.invoicePaidAt,
        guaranteeDays: placement.guaranteeDays,
        fellThroughAt: placement.fellThroughAt,
      } : null,
    },
    review: {
      access: {
        showDetails: showReviewDetails,
        canSaveDetails: showReviewDetails && canManageInterviews,
        showNotes: app.stage === "director_review" || reviewNotes.length > 0,
        canAddNote: canAddReviewNote,
      },
      details: {
        hasCv,
        ready: missingReviewDetails.length === 0,
        missing: missingReviewDetails,
        currentSalary: candidate.currentSalary ?? "",
        expectedSalary: candidate.expectedSalary ?? "",
        noticePeriod,
        currentDesignation: candidate.currentTitle ?? "",
        currentCompany: candidate.currentEmployer ?? "",
        customDetails,
      },
      answers: Object.entries(app.answers).map(([question, answer]) => ({ question: questions.get(question) ?? question, answer })),
      notes: reviewNotes,
    },
    callAccess: {
      canLog: canManageInterviews,
      defaultKind: repo.interviews(app.id).length > 0 ? "pre_interview" : app.stage === "offer" ? "post_offer" : "ad_hoc",
    },
    // The route fills this from ta/voice:callsFor on the connected Convex store.
    aiCallResults: [],
    tabs: [
      { key: "cv", label: TAB_LABEL.cv, count: null },
      { key: "prepared", label: TAB_LABEL.prepared, count: null },
      { key: "history", label: TAB_LABEL.history, count: events.length + 1 },
      { key: "call", label: TAB_LABEL.call, count: calls.length + aiCalls.length },
      { key: "chat", label: TAB_LABEL.chat, count: messages.length },
      { key: "reference", label: TAB_LABEL.reference, count: refs.length },
      { key: "company_refs", label: TAB_LABEL.company_refs, count: companyReferences.length },
    ],
    cv: { available: Boolean(candidate.cvFileName || app.cvFileName), fileName: candidate.cvFileName ?? app.cvFileName ?? null },
    history: [
      ...events.map((row) => ({
        id: row.id,
        label: row.toStage ? `Moved to ${STAGE_LABEL[row.toStage]}` : row.eventType,
        detail: row.note,
        at: row.at,
        actorName: userName(row.actorId),
      })),
      { id: `created_${app.id}`, label: "Added to opening", detail: null, at: app.createdAt, actorName: null },
    ].sort((a, b) => b.at - a.at),
    calls: [...calls, ...aiCalls].sort((a, b) => b.at - a.at),
    // The connected route replaces this with the live Convex sequence state.
    followUp: null,
    messages: messages.map((row) => ({
      id: row.id,
      channel: row.channel,
      direction: row.direction,
      body: row.body,
      subject: row.subject,
      deliveryStatus: "recorded",
      legacyStatus: null,
      stoppedSequence: false,
      errorMessage: null,
      sentAt: row.sentAt ?? row.createdAt,
    })),
    referees: refs.map((row) => ({
      id: row.id,
      name: row.name,
      title: row.title,
      company: row.company,
      phone: row.phone,
      email: row.email,
      relationship: row.relationship,
    })),
    companyReferences,
  };
  return { kind: "ok", payload };
}
