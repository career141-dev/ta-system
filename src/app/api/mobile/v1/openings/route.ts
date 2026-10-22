import { primeStore } from "@/data/prime";
import { isConvex } from "@/data/mode";
import { isTa } from "@/lib/auth";
import { convexQuery } from "@/lib/convexServer";
import { mobileOpeningsList } from "@/lib/mobile/openings";
import type { AvailableOpening, PendingAccessRequest } from "@/lib/mobile/openingsTypes";
import { ok, signedOut } from "@/lib/mobile/respond";
import { currentUser } from "@/lib/session";

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
