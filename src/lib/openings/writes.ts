import { repo } from "@/data/store";
import { isConvex } from "@/data/mode";
import type { User, WorkingStage } from "@/data/types";
import { can, isTa, type Capability } from "@/lib/auth";
import { BIN_DAYS } from "@/lib/bin";
import { safeErrorMessage } from "@/lib/userError";

/**
 * The opening-level decision and writes shared by the web's server actions
 * (src/app/actions.ts) and the mobile API (src/app/api/mobile/v1/openings/**),
 * so the phone and the desk cannot drift on who may do what (22 Oct).
 *
 * No Next imports: `revalidatePath` and the Convex calls are handed in by the
 * caller, which keeps this testable against the JSON store.
 */
export interface OpeningWriteDeps {
  revalidatePath: (path: string, type?: "layout" | "page") => void;
  convexQuery: <T = unknown>(name: string, args: Record<string, unknown>) => Promise<T>;
  convexMutation: <T = unknown>(name: string, args: Record<string, unknown>) => Promise<T>;
  markTablesStale: () => void;
  resetStore: () => void;
}

export type Decision = { ok: true } | { ok: false; status: 403 | 404; message: string };

/**
 * The last half of the web's `authorize()`: the record's opening is known, so
 * decide. It still exists, the policy in lib/auth allows it, and — for a TA
 * about to act or source — today's workday covers this opening.
 */
export async function decideOn(
  user: User,
  capability: Capability,
  target: { openingId: string | null; ownerTaId?: string | null },
  deps: Pick<OpeningWriteDeps, "convexQuery">,
): Promise<Decision> {
  const { openingId } = target;
  if (openingId && !repo.opening(openingId)) return { ok: false, status: 404, message: "That opening no longer exists." };
  const assignment = openingId ? repo.assignmentFor(openingId, user.id) ?? null : null;
  const decision = can(user, capability, { openingId, assignment, ownerTaId: target.ownerTaId ?? null });
  if (!decision.ok) return { ok: false, status: 403, message: decision.message };
  if (openingId && isTa(user) && isConvex() && ["opening.act", "opening.sourcing"].includes(capability)) {
    try {
      await deps.convexQuery("ta/workdays:checkScope", { actorId: user.id, jobId: openingId });
    } catch (error) {
      return { ok: false, status: 403, message: safeErrorMessage(error, "Check your workday before continuing.") };
    }
  }
  return { ok: true };
}

export const OPENING_STATUSES = ["open", "on_hold", "closed", "filled"] as const;
export type OpeningStatusValue = (typeof OPENING_STATUSES)[number];

/** The status write, after `opening.manage` has been decided. */
export function writeOpeningStatus(openingId: string, status: OpeningStatusValue, deps: Pick<OpeningWriteDeps, "revalidatePath">): void {
  repo.setOpeningStatus(openingId, status);
  deps.revalidatePath("/openings", "layout");
  deps.revalidatePath(`/openings/${openingId}`, "layout");
}

export const WORKING_STAGES: WorkingStage[] = ["100%", "Follow-up", "Add-on"];

/** This person's own working stage on the opening, after `opening.act` has been decided. */
export async function writeWorkingStage(
  user: User,
  openingId: string,
  stage: string,
  deps: Pick<OpeningWriteDeps, "revalidatePath" | "convexMutation" | "markTablesStale">,
): Promise<{ ok: true } | { ok: false; message: string }> {
  if (!WORKING_STAGES.includes(stage as WorkingStage)) return { ok: false, message: "Choose a valid working stage." };
  if (isConvex()) {
    try {
      await deps.convexMutation("ta/openings:setWorkingStage", { actorId: user.id, openingId, stage });
      deps.markTablesStale();
    } catch (e) {
      return { ok: false, message: safeErrorMessage(e, "The working stage could not be saved.") };
    }
  } else {
    repo.setWorkingStage(openingId, user.id, stage as WorkingStage);
  }
  // The openings list shows the stage on every row too (24 Sep).
  deps.revalidatePath("/openings");
  deps.revalidatePath(`/openings/${openingId}`, "layout");
  deps.revalidatePath(`/openings/${openingId}/eod`);
  return { ok: true };
}

/** Move one opening to the Bin, in whichever store is behind the app. */
export async function binOpeningNamed(
  user: User,
  openingId: string,
  deps: Pick<OpeningWriteDeps, "convexMutation">,
): Promise<{ ok: true; title: string; purgeAt: number } | { ok: false; message: string }> {
  if (isConvex()) {
    try {
      return await deps.convexMutation<{ ok: true; title: string; purgeAt: number }>("ta/bin:binOpening", { actorId: user.id, openingId });
    } catch (e) {
      return { ok: false, message: safeErrorMessage(e, "The opening could not be deleted.") };
    }
  }
  return repo.binOpening(openingId, user.id);
}

/**
 * Several openings into the Bin, each checked on its own: a lead or above, or
 * a recruiter on that opening (opening.manage). The web's bulk Delete.
 */
export async function binOpenings(
  user: User,
  ids: string[],
  deps: Pick<OpeningWriteDeps, "convexMutation" | "resetStore" | "revalidatePath">,
): Promise<{ deleted: number; problems: string[]; message: string }> {
  let deleted = 0;
  const problems: string[] = [];
  for (const openingId of ids) {
    const title = repo.opening(openingId)?.title ?? "An opening";
    const allowed = can(user, "opening.manage", { openingId, assignment: repo.assignmentFor(openingId, user.id) ?? null });
    if (!allowed.ok) {
      problems.push(`${title}: ${allowed.message}`);
      continue;
    }
    const r = await binOpeningNamed(user, openingId, deps);
    if (r.ok) deleted++;
    else problems.push(`${title}: ${r.message}`);
  }
  if (isConvex()) deps.resetStore();
  deps.revalidatePath("/", "layout");
  const said = `${deleted} ${deleted === 1 ? "opening" : "openings"} moved to the Bin. They can be restored for ${BIN_DAYS} days.`;
  return { deleted, problems, message: problems.length ? `${said} Not deleted — ${problems.join("; ")}` : said };
}
