// One translation for the HH and Scoop upload screens. The extraction keeps
// durable technical states; people need a small, honest set of steps. Percent
// values describe completed pipeline phases, not a fake time-based animation.

export type UploadUiState = "reading" | "done" | "held" | "failed";

type UploadProgressSource = {
  status: string;
  processingStage?: string;
  queuedAt?: number;
  processingStartedAt?: number;
  completedAt?: number;
  errorMessage?: string;
  _creationTime: number;
};

const FAILED = new Set([
  "failed",
  "failed_retry",
  "extraction_failed_permanent",
  "cancelled",
  "paused",
  "needs_review",
]);

const STEPS: Record<string, { label: string; progress: number; estimateSeconds: number | null }> = {
  queued: { label: "Waiting for a CV reader", progress: 8, estimateSeconds: 90 },
  downloading: { label: "Opening the CV", progress: 16, estimateSeconds: 75 },
  extracting_text: { label: "Extracting document text", progress: 28, estimateSeconds: 65 },
  ocr: { label: "Reading a scanned CV", progress: 38, estimateSeconds: 150 },
  structuring: { label: "Extracting all CV details", progress: 62, estimateSeconds: 60 },
  validating: { label: "Checking extracted details", progress: 78, estimateSeconds: 25 },
  saving: { label: "Saving the complete profile", progress: 88, estimateSeconds: 15 },
  filing: { label: "Adding the candidate to the opening", progress: 95, estimateSeconds: 10 },
  completed: { label: "Complete", progress: 100, estimateSeconds: 0 },
  needs_review: { label: "Needs review", progress: 100, estimateSeconds: null },
  failed: { label: "Could not be completed", progress: 100, estimateSeconds: null },
};

function inferredStage(upload: UploadProgressSource): string {
  if (upload.processingStage) return upload.processingStage;
  if (FAILED.has(upload.status)) return upload.status === "needs_review" ? "needs_review" : "failed";
  if (upload.status === "processed" || upload.status === "completed") return "completed";
  if (upload.status === "processing") return "structuring";
  return "queued";
}

export function uploadProgress(
  upload: UploadProgressSource,
  businessState?: "done" | "held" | null,
  now = Date.now(),
) {
  const stage = inferredStage(upload);
  const step = STEPS[stage] ?? STEPS.queued;
  const terminalFailure = FAILED.has(upload.status) || stage === "failed" || stage === "needs_review";
  // New uploads are complete only after the extraction action has finished
  // filing them. The application row can exist a few mutations earlier.
  // Legacy rows have no processingStage, so retain their former behaviour.
  const completedBusinessState = businessState && (!upload.processingStage || stage === "completed")
    ? businessState
    : null;
  const state: UploadUiState = terminalFailure
    ? "failed"
    : completedBusinessState ?? (stage === "completed" ? "done" : "reading");
  const startedAt = upload.processingStartedAt ?? upload.queuedAt ?? upload._creationTime;
  const finishedAt = upload.completedAt ?? now;
  return {
    state,
    stage,
    label: completedBusinessState === "held" ? "Needs attention" : step.label,
    progress: completedBusinessState ? 100 : step.progress,
    elapsedMs: Math.max(0, finishedAt - startedAt),
    estimateSeconds: state === "reading" ? step.estimateSeconds : 0,
  };
}

