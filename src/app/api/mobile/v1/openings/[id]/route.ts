import { primeStore } from "@/data/prime";
import { isConvex } from "@/data/mode";
import { repo } from "@/data/store";
import { isTa } from "@/lib/auth";
import { convexQuery } from "@/lib/convexServer";
import type { DailyEmail } from "@/lib/dailyEmail";
import { matchingSnapshot } from "@/lib/matchingSnapshot";
import { mayReadOpening, mobileOpeningOverview, mobileOpeningShell } from "@/lib/mobile/openings";
import type { AvailableOpening, OpeningPayload } from "@/lib/mobile/openingsTypes";
import { ok, refuse, signedOut } from "@/lib/mobile/respond";
import { currentUser } from "@/lib/session";
import { seatFor } from "@/lib/visibility";
import { workdayDate } from "@/lib/workday";

export const dynamic = "force-dynamic";

/**
 * One opening: the web layout's header and rail, and its Overview. The same
 * gate as the layout: no `opening.read` is a 403, unless a TA can ask for it.
 */
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  await primeStore({ openingId: id });
  const user = await currentUser();
  if (!user) return signedOut();
  if (!repo.opening(id)) return refuse(404, "This opening is no longer available.");

  if (!mayReadOpening(user, id)) {
    const available =
      isTa(user) && isConvex()
        ? await convexQuery<AvailableOpening[]>("ta/openingAccess:listAvailable", { actorId: user.id })
            .then((rows) => rows.find((row) => row.id === id) ?? null)
            .catch(() => null)
        : null;
    if (available) return ok<OpeningPayload>({ apiVersion: 1, access: "requestable", opening: available });
    return refuse(403, "You may not have access to this opening, or it is no longer available.");
  }

  // Midday and EOD records only for a seat that acts: for anyone else the
  // backend refuses the read (layout.tsx).
  const onStrategy = repo.strategyAssignments(id).some((r) => r.doneBy.includes(user.id));
  const seat = seatFor(user, repo.assignmentFor(id, user.id)?.role ?? null, onStrategy);
  const dailyEmails =
    seat.canAct && isConvex()
      ? await convexQuery<DailyEmail[]>("ta/dailyEmails:list", { actorId: user.id, jobId: id }).catch(() => [])
      : [];
  const today = workdayDate(Date.now());
  const middayEmails = dailyEmails
    .filter((e) => e.userId === user.id && e.date === today && e.submissionType === "midday")
    .map((e) => ({ id: e._id, number: e.number, status: e.status }));

  const shell = mobileOpeningShell(user, id, { middayEmails });
  const overview = mobileOpeningOverview(user, id, { matching: await matchingSnapshot(user, id) });
  if (!shell || !overview) return refuse(404, "This opening is no longer available.");
  return ok<OpeningPayload>({ apiVersion: 1, access: "ok", shell, overview });
}
