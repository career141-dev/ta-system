import { after } from "next/server";

import { primeStore } from "@/data/prime";
import { withRealIds } from "@/data/primeState";
import { repo } from "@/data/store";
import { isConvex } from "@/data/mode";
import { can, isTa } from "@/lib/auth";
import { convexQuery } from "@/lib/convexServer";
import { MOBILE_OPENING_DEPS } from "@/lib/mobile/openingDeps";
import { mobileOpeningsList } from "@/lib/mobile/openings";
import { newOpeningBody, parseBody } from "@/lib/mobile/openingsBodies";
import type { AvailableOpening, NewOpeningResult, PendingAccessRequest } from "@/lib/mobile/openingsTypes";
import { ok, refuse, signedOut } from "@/lib/mobile/respond";
import { saveNewOpening } from "@/lib/openings/create";
import { currentUser } from "@/lib/session";
import { safeErrorMessage } from "@/lib/userError";
import { validateWorkLocations } from "@/lib/workLocations";

export const dynamic = "force-dynamic";

/**
 * The web's /openings as data: every row this person's buckets hold, the
 * bucket counts and filter options, and the access-request lists. The app
 * filters and pages locally, so one read serves every bucket and filter.
 */
export async function GET() {
  await primeStore({ allApplications: true });
  const user = await currentUser();
  if (!user) return signedOut();

  const [requestable, pendingRequests] = isConvex()
    ? await Promise.all([
        isTa(user)
          ? convexQuery<AvailableOpening[]>("ta/openingAccess:listAvailable", { actorId: user.id }).catch(() => [])
          : Promise.resolve(null),
        user.role === "ta_lead" || user.role === "admin"
          ? convexQuery<PendingAccessRequest[]>("ta/openingAccess:listPendingForApprover", { actorId: user.id }).catch(() => [])
          : Promise.resolve(null),
      ])
    : [null, null];

  return ok(mobileOpeningsList(user, { requestable, pendingRequests }));
}

/**
 * "Save job" on the web's New opening: the same save (lib/openings/create),
 * so the brief, the assignment, the bell and the JD draft all follow as they do there.
 */
export async function POST(req: Request) {
  // Creating an opening needs users and clients, not every application (see createOpeningStep1).
  await primeStore({});
  const user = await currentUser();
  if (!user) return signedOut();
  const decision = can(user, "opening.create");
  if (!decision.ok) return refuse(403, decision.message);
  const body = parseBody(newOpeningBody, await req.json().catch(() => undefined), "Send the New opening form's fields.");
  if (!body.ok) return refuse(400, body.message);
  const b = body.value;

  let workLocations;
  try {
    workLocations = validateWorkLocations(b.workLocations);
  } catch (e) {
    return refuse(400, (e as Error).message);
  }

  let openingId: string | null;
  try {
    openingId = await saveNewOpening(
      user,
      {
        clientId: b.clientId,
        title: b.title,
        notes: b.notes,
        recordingKey: b.recording?.key ?? null,
        consentText: b.recording?.consentText || null,
        durationMs: b.recording?.durationMs || null,
        country: b.country.trim(),
        hiringFor: b.hiringFor || "local",
        targetGender: b.targetGender || null,
        autoFollowUp: b.autoFollowUp,
        workLocations,
        assignedTaIds: b.assignedTaIds,
      },
      { ...MOBILE_OPENING_DEPS, after },
    );
  } catch (e) {
    return refuse(409, safeErrorMessage(e, "The opening could not be saved. Try again."));
  }
  if (!openingId) return refuse(400, "Choose a client and a position.");
  const id = withRealIds(openingId);
  const clientName = repo.clients().find((c) => c.id === b.clientId)?.name ?? "the client";
  return ok<NewOpeningResult>({ ok: true, message: `${b.title.trim()} created for ${clientName}.`, openingId: id });
}
