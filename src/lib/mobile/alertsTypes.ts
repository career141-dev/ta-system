/*
 * The alerts, read-state and search contract, copied verbatim from the native
 * app (TA_APP `src/types/alerts.ts`) so the two sides agree field for field.
 * Change both together: the app has no other source for these shapes.
 */
/**
 * `GET /api/mobile/v1/alerts[?scope=everyone]` — the web's `/alerts` page as data.
 * `POST /api/mobile/v1/alerts/read` — the page's Mark read / Mark unread / Mark all.
 * `GET /api/notifications` (existing) — the bell's feed.
 * `GET /api/mobile/v1/search?q=` — the web's `/search` page as data.
 */

/** Which heading an alert sits under on the web: Urgent, Today, or Next working day (weekends). */
export type AlertGroup = "urgent" | "today" | "held";

export interface AlertRow {
  id: string;
  kind: string;
  kindLabel: string;
  detail: string;
  action: string;
  href: string;
  dueAt: number;
  urgent: boolean;
  read: boolean;
  group: AlertGroup;
  openingId: string;
  openingTitle: string | null;
  /** Names of the people the alert is for — shown when viewing everyone's. */
  assignees: string[];
}

export interface AlertsPayload {
  apiVersion: 1;
  /** Admin, TA Lead and Director may switch between their own and everyone's. */
  canSwitchScope: boolean;
  scope: "mine" | "everyone";
  /** False at weekends and on holidays: routine alerts are then held for the next working day. */
  workingDay: boolean;
  alerts: AlertRow[];
}

export type MarkAlertsBody =
  | { read: boolean; ids: string[] }
  | { read: true; all: true; scope: "mine" | "everyone" };

export interface MarkAlertsResult {
  ok: true;
  message: string;
  changed: number;
}

export interface NotificationsPayload {
  signedOut?: boolean;
  unreadCount: number;
  notifications: {
    id: string;
    type: string;
    title: string;
    body: string;
    jobId: string | null;
    href?: string | null;
    read: boolean;
    createdAt: string;
  }[];
}

export interface SearchPayload {
  apiVersion: 1;
  q: string;
  openings: { id: string; title: string; clientName: string; status: string }[];
  openingTotal: number;
  candidates: {
    candidateId: string;
    name: string;
    currentTitle: string;
    currentEmployer: string;
    /** The opening they are on, when they are on one — the web's "in {opening} for {client}". */
    application: { applicationId: string; openingId: string; openingTitle: string; clientName: string } | null;
  }[];
  candidateTotal: number;
}
