import { repo } from "@/data/store";
import { isConvex } from "@/data/mode";
import type { User } from "@/data/types";
import { alertsFor, computeAlerts, type LiveAlert } from "@/lib/sla";

/**
 * Which alerts a person sees, and marking them read or unread — shared by the
 * web's server actions (`markAlertsAsRead` / `markAlertsAsUnread` in
 * src/app/actions.ts), the /alerts page, and the mobile API
 * (`/api/mobile/v1/alerts`, `/api/mobile/v1/alerts/read`), so the app and the
 * web cannot drift on who may see everyone's alerts or what "mark all" covers.
 *
 * No Next imports: `revalidatePath` and the Convex call are handed in by the
 * caller, which keeps this testable against the JSON store.
 */

/** Admin, TA Lead and Director may switch /alerts between their own and everyone's. */
export function canSwitchAlertScope(user: User): boolean {
  return user.role === "admin" || user.role === "ta_lead" || user.role === "director";
}

/**
 * The alerts in the asked-for scope. Asking for everyone's without the right
 * quietly gives your own, as the page's `?all=1` does.
 */
export function alertsInScope(user: User, wantEveryone: boolean, now?: number): { everyone: boolean; alerts: LiveAlert[] } {
  const everyone = wantEveryone && canSwitchAlertScope(user);
  return { everyone, alerts: everyone ? computeAlerts(now) : alertsFor(user.id, now) };
}

export type MarkAlertsRequest = { read: boolean; ids: string[] } | { all: true; everyone: boolean };

export type MarkAlertsOutcome = { ok: true; changed: number; message: string } | { ok: false; message: string };

export interface MarkAlertsDeps {
  /** `revalidatePath` from next/cache. */
  revalidatePath: (path: string) => void;
  /** `convexMutation` from src/lib/convexServer.ts; only called on the Convex store. */
  convexMutation: (name: string, args: Record<string, unknown>) => Promise<unknown>;
}

/**
 * Marks alerts read or unread for `user`. `all` marks every alert in scope
 * read (there is no "mark all unread"). The Convex notification calls are
 * best-effort, as they always were: the read state that the alerts page shows
 * is the one saved through `repo`, and a failed bell update must not refuse it.
 */
export async function markAlerts(user: User, request: MarkAlertsRequest, deps: MarkAlertsDeps): Promise<MarkAlertsOutcome> {
  if ("all" in request) {
    const { alerts } = alertsInScope(user, request.everyone);
    repo.markAlertsRead(user.id, alerts.map((a) => a.id));
    if (isConvex()) {
      await deps.convexMutation("ta/notifications:markAllRead", { userId: user.id }).catch(() => {});
    }
    deps.revalidatePath("/alerts");
    deps.revalidatePath("/api/notifications");
    return { ok: true, changed: alerts.length, message: "All alerts marked as read." };
  }

  const ids = request.ids;
  if (ids.length === 0) return { ok: false, message: "No alerts selected." };

  if (request.read) repo.markAlertsRead(user.id, ids);
  else repo.markAlertsUnread(user.id, ids);

  if (isConvex()) {
    const name = request.read ? "ta/notifications:markRead" : "ta/notifications:markUnread";
    await Promise.all(ids.map((id) => deps.convexMutation(name, { userId: user.id, notificationId: id }).catch(() => {})));
  }

  deps.revalidatePath("/alerts");
  deps.revalidatePath("/api/notifications");
  return {
    ok: true,
    changed: ids.length,
    message: `${ids.length} ${ids.length === 1 ? "alert" : "alerts"} marked as ${request.read ? "read" : "unread"}.`,
  };
}
