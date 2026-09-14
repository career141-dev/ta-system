/**
 * Database matches per job — agreed 13 September.
 *
 * When a JD is approved, and every night after, the database is searched for
 * the people we already hold who fit the job. It narrows in four steps, each
 * cheaper than the one before:
 *
 *   1. **Nearest by meaning** — the 300 CVs closest to the JD (lib/embed).
 *   2. **Hard rules** — nationality, location and minimum years where the
 *      opening states them; not anyone taken off this opening before; not
 *      anyone the same client turned down in the last six months; not anyone
 *      with an offer out or placed in the last six months.
 *   3. **Rules score** — the same fit score every list shows.
 *
 * A model review was tried as a fourth step and removed on 13 September: on
 * 184 real CVs checked against the desk's own shortlists it ranked no better
 * than the rules score and rated far too many people highly.
 *
 * The best go under Database CVs as matches, unclaimed, for a TA to confirm.
 * Nobody is contacted by this: a match is a suggestion, and the AI call only
 * starts when a TA shortlists.
 */

import { repo } from "@/data/store";
import type { Candidate, MatchRun } from "@/data/types";
import { candidateEmbedText, candidateVector, cosine, embedModel, ensureVectors, isMeaningBased, nearest, openingEmbedText, openingVector } from "./embed";
import { locationFit } from "./places";
import { ASSESSMENT_VERSION, assess, requirementsFor } from "./assessment";
import { FIT_BANDS, titleScore, yearsFromHistory } from "./scoring";

export { requirementsFor };

export const LIMITS = { nearest: 300, byTitle: 500, shown: 30 } as const;
/** Below this a match is not worth a TA's time, however few there are. */
const RULES_FLOOR = FIT_BANDS.worth;
/**
 * Set from the 13 September live test (704 profiles judged blind): good-or-strong
 * fits were 8% of those scoring 40–49, 28% at 50–59, 48% at 60–69 and 74% at
 * 70+. At 45 the list filled with weak people whenever few good ones existed.
 * Someone just under 60 who is very close in meaning still counts.
 */
const CLOSE_IN_MEANING = 0.75;
const MEANING_FLOOR = 50;
const SIX_MONTHS = 182 * 86_400_000;

export interface MatchResult {
  ok: boolean;
  reason?: string;
  run?: Omit<MatchRun, "id">;
}


/**
 * Every candidate's vector, brought up to date. Only changed text is sent.
 *
 * Skipped entirely when no data has changed since the last check: working out
 * every candidate's text and hash took 2.5 s at 115,000 candidates, and it ran
 * on every search by meaning (13 September).
 */
let vectorsCheckedAt: string | null = null;
export async function refreshCandidateVectors() {
  const version = repo.version();
  if (vectorsCheckedAt === version) return { ok: true as const, embedded: 0, tokens: 0 };
  const r = await ensureVectors(
    "candidates",
    repo.candidates().map((c) => ({ id: c.id, text: candidateEmbedText(c, repo.cvTextFor(c.id)) })),
  );
  if (r.ok) vectorsCheckedAt = version;
  return r;
}

/** The hard rules, with the reason a person fails, for tests and for the run note. */
export function failsHardRules(
  c: Candidate,
  o: { id: string; clientId: string; locations: string[]; targetNationalities: string[]; localOnly?: boolean },
  minYears: number | null,
  now = Date.now(),
): string | null {
  // A stated nationality excludes only someone whose nationality is known and
  // different; a blank one is thin data and stays in (13 September).
  if (o.targetNationalities.length && c.nationality && !o.targetNationalities.some((n) => n.toLowerCase() === c.nationality!.toLowerCase())) {
    return "nationality";
  }
  // Location never excludes unless the JD says local candidates only — and
  // then only another COUNTRY does, not another city. Otherwise it is ranked.
  if (o.localOnly && o.locations.length && locationFit(o.locations, c.location) === "mismatch") return "location";
  // Only someone clearly short is removed; a little under the floor is ranked
  // lower instead. Years come from the record or the career history, whichever
  // is longer — parsed totals are often low (13 September).
  const years = Math.max(c.totalExperienceYears ?? 0, yearsFromHistory(c.workHistory) ?? 0);
  if (minYears != null && years > 0 && years < minYears * 0.7) return "years";

  const apps = repo.applicationsForCandidate(c.id);
  for (const a of apps) {
    const other = repo.opening(a.openingId);
    if (a.stage === "rejected" && other?.clientId === o.clientId && now - a.lastStageChangedAt < SIX_MONTHS) return "client_rejected";
    if (a.stage === "offer") return "offer_out";
    if (a.stage === "placed" && now - a.lastStageChangedAt < SIX_MONTHS) return "recently_placed";
  }
  return null;
}

export async function findDatabaseMatches(
  openingId: string,
  trigger: MatchRun["trigger"],
  opts: { now?: number } = {},
): Promise<MatchResult> {
  const now = opts.now ?? Date.now();
  const o = repo.opening(openingId);
  if (!o) return { ok: false, reason: "no_opening" };
  if (o.status !== "open") return { ok: false, reason: "not_open" };
  const req = requirementsFor(openingId);
  if (!req) return { ok: false, reason: "jd_not_approved" };

  // 1. Nearest by meaning.
  const cv = await refreshCandidateVectors();
  if (!cv.ok) return { ok: false, reason: `embeddings: ${cv.reason}` };
  const job = await ensureVectors("openings", [{ id: o.id, text: openingEmbedText(o, repo.client(o.clientId)?.industry ?? null) }]);
  if (!job.ok) return { ok: false, reason: `embeddings: ${job.reason}` };
  const jobVec = openingVector(o.id)!;

  const onOpening = new Set(repo.applications(o.id).map((a) => a.candidateId));
  const excluded = repo.matchExcluded(o.id);
  const near = nearest(jobVec, LIMITS.nearest, (id) => !onOpening.has(id) && !excluded.has(id));

  // 1b. And by title, so nobody whose job IS this job is missed because 300
  // closer CVs filled the list first — a common role has more than 300 people
  // (13 September). Their real similarity is used, so the ranking stays fair.
  // Ranked before the limit: the best-titled 500, not the first 500 the
  // database happens to hold (13 September review).
  const nearIds = new Set(near.map((n) => n.id));
  const titled: { id: string; title: number; similarity: number }[] = [];
  for (const c of repo.candidates()) {
    if (nearIds.has(c.id) || onOpening.has(c.id) || excluded.has(c.id)) continue;
    const t = Math.max(titleScore(c.currentTitle, req.title, req.titleVariants), ...c.workHistory.slice(0, 2).map((h) => titleScore(h.title, req.title, req.titleVariants)));
    if (t < 50) continue;
    const v = candidateVector(c.id);
    titled.push({ id: c.id, title: t, similarity: v ? cosine(jobVec, v) : 0 });
  }
  titled.sort((a, b) => b.title - a.title || b.similarity - a.similarity);
  const byTitle = Math.min(titled.length, LIMITS.byTitle);
  for (const x of titled.slice(0, LIMITS.byTitle)) near.push({ id: x.id, similarity: x.similarity });

  // 2. Hard rules.
  const failed: Record<string, number> = {};
  const kept: { candidate: Candidate; similarity: number }[] = [];
  for (const n of near) {
    const c = repo.candidate(n.id);
    if (!c) continue;
    const why = failsHardRules(c, { ...o, localOnly: req.localOnly }, req.minYears, now);
    if (why) failed[why] = (failed[why] ?? 0) + 1;
    else kept.push({ candidate: c, similarity: n.similarity });
  }

  // 3. Rules score — the same assessment every page shows (./assessment).
  const sim = new Map(kept.map((k) => [k.candidate.id, k.similarity]));
  const assessed = assess(o.id, kept.map((k) => k.candidate), req);
  if (!assessed.ok) return { ok: false, reason: assessed.reason };
  const allScored = kept.map((k) => ({ candidate: k.candidate, score: assessed.scores.get(k.candidate.id)! })).sort((a, b) => b.score.overall - a.score.overall);
  const relevant = (x: (typeof allScored)[number]) =>
    x.score.overall >= RULES_FLOOR || (isMeaningBased() && x.score.overall >= MEANING_FLOOR && (sim.get(x.candidate.id) ?? 0) >= CLOSE_IN_MEANING);
  // Someone whose job IS this job ranks above someone merely close to it at a
  // similar score — in the live test good title matches lost their place to
  // weaker people who happened to score a point or two higher.
  const titleOf = (c: Candidate) => Math.max(titleScore(c.currentTitle, req.title, req.titleVariants), ...c.workHistory.slice(0, 2).map((h) => titleScore(h.title, req.title, req.titleVariants)));
  const rankOf = (x: (typeof allScored)[number]) => x.score.overall + (titleOf(x.candidate) >= 80 ? 8 : titleOf(x.candidate) >= 60 ? 4 : 0);
  const scored = allScored.filter(relevant).sort((a, b) => rankOf(b) - rankOf(a));
  // The ones just under the bar are counted, never silently dropped.
  const justBelow = allScored.filter((s) => !relevant(s) && s.score.overall >= RULES_FLOOR - 10).length;

  // A standing list of 30, not 30 more every night.
  const waiting = repo.applications(o.id).filter((a) => a.stage === "matched" && !a.ownerTaId).length;
  const room = Math.max(0, LIMITS.shown - waiting);
  const by = o.assignedTaIds[0] ?? repo.users().find((u) => u.role === "director")?.id ?? "system";
  let added = 0;
  // One save for the whole list, not one per person.
  repo.batch(() => {
  for (const r of scored.slice(0, room)) {
    const bits = [
      `fit ${r.score.overall}`,
      isMeaningBased() ? `similarity ${sim.get(r.candidate.id)?.toFixed(2)}` : null,
    ].filter(Boolean);
    const res = repo.addCandidateToOpening(r.candidate.id, o.id, by, null, {
      kind: "auto_match",
      note: `Matched from the database ${trigger === "nightly" ? "overnight" : trigger === "jd_approved" ? "when the JD was approved" : "on request"} — ${bits.join(", ")}`,
    });
    if (res.ok) added++;
  }
  });

  const failedNote = Object.entries(failed).map(([k, n]) => `${n} ${k.replace("_", " ")}`).join(", ");
  const run: Omit<MatchRun, "id"> = {
    openingId: o.id,
    at: now,
    trigger,
    considered: near.length,
    afterRules: kept.length,
    added,
    embedModel: embedModel(),
    assessmentVersion: ASSESSMENT_VERSION,
    note: [
      failedNote ? `Ruled out: ${failedNote}.` : null,
      scored.length < LIMITS.shown ? `Only ${scored.length} relevant ${scored.length === 1 ? "person" : "people"} found in the database.` : null,
      byTitle ? `${byTitle} more looked at because their job title matches.` : null,
      justBelow ? `${justBelow} more scored just under ${RULES_FLOOR} and were not added.` : null,
      room === 0 ? `${waiting} matches already waiting, so none added.` : null,
      !isMeaningBased() ? "No embedding key: nearest by shared words, not meaning." : null,
    ].filter(Boolean).join(" ") || null,
  };
  repo.saveMatchRun(run);
  return { ok: true, run };
}

/** The nightly job: every open opening with an approved JD. */
export async function nightly() {
  const results: { openingId: string; ok: boolean; added: number; reason?: string }[] = [];
  for (const o of repo.openings().filter((x) => x.status === "open" && x.jdStatus === "approved")) {
    const r = await findDatabaseMatches(o.id, "nightly");
    results.push({ openingId: o.id, ok: r.ok, added: r.run?.added ?? 0, reason: r.reason });
  }
  return { openings: results };
}
