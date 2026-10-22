import { repo } from "@/data/store";
import { isConvex } from "@/data/mode";
import * as backend from "@/data/convex/backend";
import type { User } from "@/data/types";
import { allows } from "@/lib/auth";
import { matchingMarks, matchingState, type MatchingState } from "@/lib/matchingNow";

/**
 * Whether database matching is running for an opening, and whether this person
 * may start it — read once for the web's MatchingStatus box and the mobile
 * Overview, so both say the same thing (moved out of the component, 22 Oct).
 * Null until the JD is approved: there is nothing to match against before.
 */
export async function matchingSnapshot(user: User, openingId: string): Promise<{ state: MatchingState; canRun: boolean } | null> {
  const o = repo.opening(openingId);
  if (!o || o.jdStatus !== "approved") return null;
  const canRun = allows(user, "opening.sourcing", { openingId, assignment: repo.assignmentFor(openingId, user.id) ?? null });

  const [engine, runs] = isConvex()
    ? await Promise.all([
        backend.reverseMatchResults({ id: user.id }, openingId).catch(() => null),
        backend.matchRuns({ id: user.id }, openingId).catch(() => null),
      ])
    : [null, null];
  const last = (runs ?? repo.matchRuns(openingId)).reduce<{ at: number; added: number; note: string | null } | null>(
    (a, r) => (!a || r.at > a.at ? r : a),
    null,
  );
  const state = matchingState({
    now: Date.now(),
    ...matchingMarks(openingId),
    requirementsStatus: o.requirements?.status,
    engineStatus: engine?.status,
    engineAt: engine?.matchedAt ? Date.parse(engine.matchedAt) || null : null,
    lastRun: last,
  });
  return { state, canRun };
}
