/**
 * The native pipeline contract.
 *
 * Kept identical in ta-system `src/lib/mobile/pipelineTypes.ts` and TA_APP
 * `src/types/pipeline.ts`: change both together.
 */
export type PipelineStage =
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

export type FitBand = "strong" | "possible" | "low" | "unknown";

export interface PipelineStageSummary {
  stage: PipelineStage;
  label: string;
  count: number;
}

export interface PipelineCandidate {
  applicationId: string;
  candidateId: string;
  name: string;
  initials: string;
  currentTitle: string | null;
  currentEmployer: string | null;
  location: string | null;
  experienceYears: number | null;
  noticeDays: number | null;
  ownerName: string | null;
  fitScore: number | null;
  fitBand: FitBand;
  fitReasons: string[];
  tags: string[];
  waitingDays: number;
  hasCv: boolean;
  lockedBy: string | null;
  canCall: boolean;
  canEmail: boolean;
  allowedStages: PipelineStage[];
}

export interface PipelinePayload {
  apiVersion: 1;
  opening: {
    id: string;
    title: string;
    clientName: string;
    positionCode: string | null;
    workLocations: { id: string; name: string }[];
  };
  activeStage: PipelineStage;
  activeWorkLocationId: string | null;
  stages: PipelineStageSummary[];
  candidates: PipelineCandidate[];
  stats: { atStage: number; setsClosed: number; longestWaitingDays: number | null };
  filters: { locations: string[]; tags: string[] };
  followUp: {
    autoFollowUp: boolean;
    standardQuestions: string[];
    customQuestions: string[];
    canManage: boolean;
    canUploadCv: boolean;
  } | null;
}

export interface PipelineUploadResult {
  ok: boolean;
  message: string;
  uploadId?: string;
}

