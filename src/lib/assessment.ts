/**
 * The one assessment of a candidate against an opening.
 *
 * The candidate list, database search results, automatic matching and the Ask
 * assistant all show a fit score. Until 14 September each built the job's
 * requirements in its own copy of the code, so a change to one could quietly
 * make them disagree. They all come through here now, and every result carries
 * the version of the rules that produced it.
 */
import { repo } from "@/data/store";
import type { Candidate } from "@/data/types";
import { requirementsFromOpening, scoreSet, type Requirements, type Score } from "./scoring";

/** Bump whenever a change to scoring can move anyone's score. */
export const ASSESSMENT_VERSION = "rules-2026-09-14";

export type AssessmentUnavailable = "no_opening" | "jd_not_approved";

export const UNAVAILABLE_MESSAGE: Record<AssessmentUnavailable, string> = {
  no_opening: "This opening no longer exists, so there is nothing to score against.",
  jd_not_approved: "No fit scores until the job description is approved: there are no agreed requirements to score against yet.",
};

/** Why an opening cannot be assessed right now, or null when it can. */
export function assessmentUnavailable(openingId: string | null | undefined): AssessmentUnavailable | null {
  const o = openingId ? repo.opening(openingId) : null;
  if (!o) return "no_opening";
  return o.jdStatus === "approved" ? null : "jd_not_approved";
}

/** The requirements from an opening's approved JD, or null before approval. */
export function requirementsFor(openingId: string): Requirements | null {
  if (assessmentUnavailable(openingId)) return null;
  const o = repo.opening(openingId)!;
  return requirementsFromOpening({
    title: o.title,
    jdMarkdown: o.jdMarkdown,
    locations: o.locations,
    targetNationalities: o.targetNationalities,
    industry: repo.client(o.clientId)?.industry ?? null,
    knownSkills: repo.vocabulary().skills,
  });
}

export type Assessment =
  | { ok: true; version: string; requirements: Requirements; scores: Map<string, Score> }
  | { ok: false; reason: AssessmentUnavailable; message: string };

/** Scores a set of candidates against an opening, together, from their records and CV text. */
export function assess(openingId: string, candidates: Candidate[], reqOverride?: Requirements): Assessment {
  const why = assessmentUnavailable(openingId);
  if (why) return { ok: false, reason: why, message: UNAVAILABLE_MESSAGE[why] };
  const requirements = reqOverride ?? requirementsFor(openingId)!;
  const scores = new Map(
    scoreSet(candidates.map((candidate) => ({ candidate, cvText: repo.cvTextFor(candidate.id) })), requirements).map((r) => [r.candidate.id, r.score]),
  );
  return { ok: true, version: ASSESSMENT_VERSION, requirements, scores };
}
