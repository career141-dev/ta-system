import { z } from "zod";

import { repo } from "@/data/store";
import type { User } from "@/data/types";
import { alertGroup, kindLabel } from "@/lib/alertKinds";
import { alertsInScope, canSwitchAlertScope, type MarkAlertsRequest } from "@/lib/alerts/readState";
import { isWorkingDay } from "@/lib/calendar";

import type { AlertGroup, AlertRow, AlertsPayload, MarkAlertsBody } from "./alertsTypes";

/**
 * `GET /api/mobile/v1/alerts` — the web's /alerts page (src/app/alerts/page.tsx)
 * as data: the same scope rule, read flags, headings and order. The app filters
 * and pages locally, so the page's `?q`, `?view` and paging are not applied.
 *
 * `now` is passed to the alert rules only when a caller gives one; left
 * undefined they use the same 30-second memo as a web request does.
 */
export function mobileAlerts(user: User, wantEveryone: boolean, now?: number): AlertsPayload {
  const canSwitchScope = canSwitchAlertScope(user);
  const { everyone, alerts } = alertsInScope(user, wantEveryone, now);
  const readIds = repo.readAlertIds(user.id);
  const workingDay = isWorkingDay(now === undefined ? new Date() : new Date(now));
  const userName = new Map(repo.users().map((u) => [u.id, u.name]));

  const rows: AlertRow[] = alerts.map((a) => ({
    id: a.id,
    kind: a.kind,
    kindLabel: kindLabel(a.kind),
    detail: a.detail,
    action: a.action,
    href: a.href,
    dueAt: a.dueAt,
    urgent: a.urgent,
    read: readIds.has(a.id),
    group: alertGroup(a, workingDay),
    openingId: a.openingId,
    openingTitle: repo.opening(a.openingId)?.title ?? null,
    assignees: a.assignedTo.map((id) => userName.get(id)).filter((n): n is string => !!n),
  }));

  // The page lists Urgent, then Today, then Next working day, each in the
  // rules' own order — a stable sort by heading gives the same sequence.
  const rank: Record<AlertGroup, number> = { urgent: 0, today: 1, held: 2 };
  const ordered = rows
    .map((row, i) => ({ row, i }))
    .sort((x, y) => rank[x.row.group] - rank[y.row.group] || x.i - y.i)
    .map(({ row }) => row);

  return {
    apiVersion: 1,
    canSwitchScope,
    scope: everyone ? "everyone" : "mine",
    workingDay,
    alerts: ordered,
  };
}

/** Most alerts one request may mark; the page's bulk bar marks at most a page of 25. */
export const MARK_ALERTS_MAX = 500;

/**
 * `POST /api/mobile/v1/alerts/read` — the body, as `MarkAlertsBody` in
 * alertsTypes.ts. Strict: a body that mixes `ids` with `all` is refused rather
 * than guessed at.
 */
export const markAlertsBodySchema = z.union([
  z
    .object({
      read: z.literal(true),
      all: z.literal(true),
      scope: z.enum(["mine", "everyone"]),
    })
    .strict(),
  z
    .object({
      read: z.boolean(),
      ids: z.array(z.string().trim().min(1).max(200)).min(1).max(MARK_ALERTS_MAX),
    })
    .strict(),
]);

export type MarkAlertsParse = { ok: true; request: MarkAlertsRequest } | { ok: false; message: string };

/** Checks a posted body and turns it into the read-state service's request. */
export function parseMarkAlertsBody(body: unknown): MarkAlertsParse {
  const parsed = markAlertsBodySchema.safeParse(body);
  if (!parsed.success) {
    const tooMany = Array.isArray((body as { ids?: unknown } | null)?.ids) && (body as { ids: unknown[] }).ids.length > MARK_ALERTS_MAX;
    return {
      ok: false,
      message: tooMany
        ? `Mark at most ${MARK_ALERTS_MAX} alerts at a time.`
        : 'Send { "read": true|false, "ids": [...] } with 1 to 500 alert ids, or { "read": true, "all": true, "scope": "mine"|"everyone" }.',
    };
  }
  const data: MarkAlertsBody = parsed.data;
  return {
    ok: true,
    request: "all" in data ? { all: true, everyone: data.scope === "everyone" } : { read: data.read, ids: data.ids },
  };
}
