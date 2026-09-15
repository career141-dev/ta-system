/**
 * Recruiter review for the live-data test (13 September).
 *
 * A recruiter marks each person Shortlist / Maybe / Reject for a job, without
 * seeing the platform's fit scores or which people it picked. Their decisions
 * are what the matching and the AI reviewer are measured against.
 *
 * Kept outside the pipeline on purpose: several people review the same list,
 * and nobody's review should move anyone's stage. Only present when the test
 * folder holds a review list (`review/key-job<N>.json`).
 */
import fs from "node:fs";
import path from "node:path";
import { dataDir } from "@/data/dataDir";
import { repo } from "@/data/store";

export type ReviewDecision = "shortlist" | "maybe" | "reject";

export interface ReviewRecord {
  reviewerId: string;
  job: number;
  candidateId: string;
  decision: ReviewDecision;
  note: string;
  at: number;
}

const dir = () => path.join(dataDir(), "review");
const decisionsFile = () => path.join(dir(), "decisions.json");

/** The jobs with a review list, as opening numbers (1-based, in opening order). */
export function reviewJobs(): number[] {
  try {
    return fs
      .readdirSync(dir())
      .map((f) => f.match(/^key-job(\d+)\.json$/)?.[1])
      .filter((x): x is string => Boolean(x))
      .map(Number)
      .sort((a, b) => a - b);
  } catch {
    return [];
  }
}

/** The candidate ids to review for a job, in the fixed (shuffled) order. */
export function reviewList(job: number): string[] {
  try {
    const rows = JSON.parse(fs.readFileSync(path.join(dir(), `key-job${job}.json`), "utf8")) as { id: string }[];
    return rows.map((r) => r.id);
  } catch {
    return [];
  }
}

/** Every decision, kept in the database's settings under `review.decisions`. */
function readAll(): ReviewRecord[] {
  try {
    return JSON.parse(repo.setting(DECISIONS_KEY, "[]")) as ReviewRecord[];
  } catch {
    return [];
  }
}

const DECISIONS_KEY = "review.decisions";

export function reviewDecisions(reviewerId: string, job: number): Map<string, ReviewRecord> {
  return new Map(readAll().filter((r) => r.reviewerId === reviewerId && r.job === job).map((r) => [r.candidateId, r]));
}

export function saveReviewDecision(rec: Omit<ReviewRecord, "at">) {
  if (!reviewList(rec.job).includes(rec.candidateId)) throw new Error("Not on this review list.");
  const all = readAll().filter((r) => !(r.reviewerId === rec.reviewerId && r.job === rec.job && r.candidateId === rec.candidateId));
  all.push({ ...rec, note: rec.note.slice(0, 300), at: Date.now() });
  repo.setSetting(DECISIONS_KEY, JSON.stringify(all));
}

export interface ReviewRequirements {
  version: string;
  summary: string;
  essential: string[];
  preferred: string[];
  level: string;
  notSuitability: string;
}

/** The approved requirement list reviewers judge against, when one exists for the job. */
export function reviewRequirements(job: number): ReviewRequirements | null {
  try {
    const all = JSON.parse(fs.readFileSync(path.join(dir(), "requirements.json"), "utf8")) as { version: string; jobs: Record<string, Omit<ReviewRequirements, "version">> };
    const j = all.jobs[String(job)];
    return j ? { version: all.version, ...j } : null;
  } catch {
    return null;
  }
}
