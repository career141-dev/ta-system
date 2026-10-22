import { primeStore, resetStore } from "@/data/prime";
import * as backend from "@/data/convex/backend";
import { findDatabaseMatches } from "@/lib/dbMatch";
import { clearMatching, markMatching, matchFailureText } from "@/lib/matchingNow";
import { repo } from "@/data/store";

/**
 * Database matching for an opening, moved out of src/app/actions.ts so the web
 * and the mobile API start the same run (22 Oct).
 *
 * Waits for the JD's details to finish being read, then matches. Marked before
 * the response by the caller (lib/matchingNow); cleared here however the run
 * ends, so the page never says "running" for a dead run.
 */
export async function rematchWhenRequirementsSettle(
  openingId: string,
  actorId: string,
  trigger: "jd_approved" | "manual",
  revalidatePath: (path: string, type?: "layout" | "page") => void,
) {
  let failure: string | null = null;
  try {
    for (let i = 0; i < 30; i++) {
      const row = await backend.opening({ id: actorId }, openingId).catch(() => null);
      const status = (row?.opening as { requirementsStatus?: string | null } | undefined)?.requirementsStatus;
      if (status !== "extracting") break;
      await new Promise((res) => setTimeout(res, 3_000));
    }
    resetStore();
    await primeStore({ openingId });
    const r = await findDatabaseMatches(openingId, trigger).catch((e: unknown) => ({ ok: false as const, reason: (e as Error).message }));
    if (!r.ok) failure = matchFailureText(r.reason);
  } finally {
    clearMatching(openingId, failure);
    revalidatePath(`/openings/${openingId}`, "layout");
  }
}

/**
 * "Run matching again". `schedule` runs the work after the response (Next's
 * `after`), since a run takes up to a minute and a half. Called after
 * `opening.sourcing` has been decided.
 */
export function startMatching(
  user: { id: string },
  openingId: string,
  deps: { revalidatePath: (path: string, type?: "layout" | "page") => void; schedule: (work: () => Promise<void>) => void },
): { ok: true; message: string } | { ok: false; message: string } {
  if (repo.opening(openingId)?.jdStatus !== "approved") return { ok: false, message: matchFailureText("jd_not_approved") };
  markMatching(openingId);
  deps.schedule(() => rematchWhenRequirementsSettle(openingId, user.id, "manual", deps.revalidatePath));
  deps.revalidatePath(`/openings/${openingId}`, "layout");
  return { ok: true, message: "Matching started — new matches appear here when it finishes." };
}
