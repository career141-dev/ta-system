/**
 * The native candidate-sheet contract.
 *
 * Kept identical in TA_APP `src/types/candidate.ts`: change both together.
 */
export type CandidateStage =
  | "new_cv"
  | "matched"
  | "ta_follow_up"
  | "ai_follow_up"
  | "director_review"
  | "director_shortlist"
  | "client_shortlist"
  | "interview"
  | "offer"
  | "placed"
  | "rejected"
  | "dropped_out";

export type CandidateTab = "cv" | "prepared" | "history" | "call" | "chat" | "reference" | "company_refs";

export interface CandidatePayload {
  apiVersion: 1;
  context: {
    applicationId: string;
    openingId: string;
    openingTitle: string;
    clientName: string;
    stage: CandidateStage;
    stageLabel: string;
    position: number;
    total: number;
    previousApplicationId: string | null;
    nextApplicationId: string | null;
    interviewAccess: {
      canBook: boolean;
      canManage: boolean;
      canFeedback: boolean;
      userId: string;
      userName: string;
    };
  };
  profile: {
    candidateId: string;
    name: string;
    initials: string;
    currentTitle: string | null;
    currentEmployer: string | null;
    education: string | null;
    location: string | null;
    email: string | null;
    phone: string | null;
    linkedinUrl: string | null;
    experienceYears: number | null;
    noticePeriod: string | null;
    currentSalary: string | null;
    expectedSalary: string | null;
    ownerName: string | null;
    sourcingChannel: string;
    setNumber: number | null;
    rating: number | null;
    tags: string[];
    canAct: boolean;
  };
  onOpenings: {
    applicationId: string;
    openingId: string;
    openingTitle: string;
    clientName: string;
    stageLabel: string;
  }[];
  interviews: {
    id: string;
    title: string;
    scheduledAt: number;
    timezone: string;
    location: string;
    mode: "in_person" | "video" | "phone";
    round: number;
    interviewers: string[];
    durationMins: number | null;
    confirmedAt: number | null;
    notes: string | null;
    outcome: "pending" | "attended" | "no_show" | "cancelled";
    result: "pending" | "passed" | "failed" | "on_hold";
    clientRating: number | null;
    clientFeedback: string | null;
    status: "scheduled" | "rescheduled" | "completed" | "cancelled" | "no_show";
    feedback: {
      byUserId: string;
      byName: string;
      interviewer: string;
      ratings: { technical: number | null; communication: number | null; behaviour: number | null; performance: number | null; overall: number | null };
      recommendation: "hire" | "next_round" | "hold" | "reject" | null;
      comments: string | null;
      at: number;
      updatedAt: number;
      canEdit: boolean;
    }[];
    history: { at: number; byName: string; kind: string; detail: string; reason: string | null }[];
  }[];
  closing: {
    offer: {
      id: string;
      salary: number;
      salaryBasis: "monthly" | "annual";
      currency: "LKR" | "USD";
      startDate: number | null;
      terms: string | null;
      status: "pending" | "accepted" | "declined" | "withdrawn";
      declineReason: string | null;
    } | null;
    placement: {
      id: string;
      joinDate: number;
      joinConfirmedAt: number | null;
      salary: number;
      salaryBasis: "monthly" | "annual";
      currency: "LKR" | "USD";
      invoiceNumber: string | null;
      invoicePaidAt: number | null;
      guaranteeDays: number;
      fellThroughAt: number | null;
    } | null;
  };
  review: {
    answers: { question: string; answer: string }[];
    notes: { id: string; note: string; byName: string; byRole: string; at: number }[];
  };
  tabs: { key: CandidateTab; label: string; count: number | null }[];
  cv: { available: boolean; fileName: string | null };
  history: { id: string; label: string; detail: string | null; at: number; actorName: string | null }[];
  calls: { id: string; kind: string; outcome: string; body: string; source: string; at: number; byName: string | null }[];
  messages: { id: string; channel: "whatsapp" | "email"; direction: "out" | "in"; body: string; subject: string | null; sentAt: number | null; createdAt: number }[];
  referees: { id: string; name: string; title: string | null; company: string | null; phone: string | null; email: string | null; relationship: string | null }[];
  companyReferences: { id: string; name: string; title: string | null; company: string | null; phone: string | null; email: string | null; kind: "candidate" | "referee" }[];
}

export interface CandidateCvUploadResult {
  ok: boolean;
  message: string;
}

export interface CandidateProfileBody {
  field: "email" | "phone" | "name";
  value: string;
}

export interface CandidateProfileResult {
  ok: boolean;
  message: string;
}

export type CandidateInterviewBody =
  | { action: "schedule"; title: string; date: string; time: string; timezone: string; location: string; mode: "in_person" | "video" | "phone"; interviewers: string[]; durationMins: number | null; notes: string }
  | { action: "confirm"; interviewId: string }
  | { action: "outcome"; interviewId: string; outcome: "scheduled" | "completed" | "cancelled" | "no_show"; reason: string }
  | { action: "result"; interviewId: string; result: "pending" | "passed" | "failed" | "on_hold"; clientRating: 1 | 2 | 3 | 4 | 5 | null; clientFeedback: string }
  | { action: "reschedule"; interviewId: string; date: string; time: string; location: string; mode: "in_person" | "video" | "phone"; reason: string }
  | { action: "edit"; interviewId: string; title: string; interviewers: string[]; durationMins: number | null; notes: string }
  | { action: "feedback"; interviewId: string; forUserId: string | null; interviewer: string; ratings: { technical: 1 | 2 | 3 | 4 | 5 | null; communication: 1 | 2 | 3 | 4 | 5 | null; behaviour: 1 | 2 | 3 | 4 | 5 | null; performance: 1 | 2 | 3 | 4 | 5 | null; overall: 1 | 2 | 3 | 4 | 5 | null }; recommendation: "hire" | "next_round" | "hold" | "reject" | null; comments: string };

export interface CandidateInterviewResult {
  ok: boolean;
  message: string;
}
