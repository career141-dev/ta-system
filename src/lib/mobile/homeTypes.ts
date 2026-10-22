/*
 * The `GET /api/mobile/v1/home` contract, copied verbatim from the native app
 * (TA_APP `src/types/home.ts`) so the two sides agree field for field. Change
 * both together: the app has no other source for these shapes.
 */
/**
 * `GET /api/mobile/v1/home` — the web dashboard (`src/app/page.tsx` and
 * `src/components/dash/*` in ta-system), one variant per role, as data.
 *
 * `href` values are the web's own paths (`/openings/{id}/candidate/{app}?tab=call`);
 * the app maps them to native screens in `navigation/links.ts`.
 */

export type LinkedInStatus = "connected" | "no_link" | "no_post";

export interface HomeAlert {
  id: string;
  kind: string;
  kindLabel: string;
  detail: string;
  action: string;
  href: string;
  dueAt: number;
}

export interface HomeInterview {
  id: string;
  applicationId: string;
  openingId: string;
  candidateName: string;
  openingTitle: string;
  scheduledAt: number;
  mode: string;
  /** A pre-interview call reached the candidate — the web's "Attendance confirmed". */
  confirmed: boolean;
}

export type OpeningNeed =
  | { kind: "jd_approval"; text: string }
  | { kind: "low_cvs"; text: string }
  | { kind: "open_set"; text: string }
  | { kind: "on_track"; text: string };

export interface HomeOpening {
  id: string;
  clientName: string;
  title: string;
  linkedin: LinkedInStatus;
  followUp: number;
  cvsToday: number;
  daysOpen: number;
  targetDays: number;
  need: OpeningNeed;
}

export interface TaHome {
  variant: "ta";
  openCount: number;
  urgent: HomeAlert[];
  openings: HomeOpening[];
  interviews: HomeInterview[];
  /** Up to six non-urgent alerts: "When you have a moment". */
  routine: HomeAlert[];
}

export interface LeadTeamRow {
  userId: string;
  name: string;
  initials: string;
  roleCount: number;
  /** The first two titles; the rest are counted, as on the web. */
  roleTitles: string[];
  onLinkedIn: number;
  noLink: number;
  notPosted: number;
  inPipeline: number;
  cvsToday: number;
  sets: number;
  alerts: number;
}

export type LeadDecision =
  | { kind: "unassigned"; openingId: string; title: string; clientName: string }
  | { kind: "jd"; openingId: string; title: string; clientName: string; taNames: string[] }
  | { kind: "stale"; openingId: string; title: string; clientName: string; daysOpen: number; priorityTier: string; targetDays: number };

export interface LeadRole {
  openingId: string;
  title: string;
  clientName: string;
  taNames: string[];
  assignedAt: number | null;
  linkedin: LinkedInStatus;
  followUp: number;
}

export interface LeadHome {
  variant: "lead";
  openCount: number;
  urgentCount: number;
  team: LeadTeamRow[];
  decisions: LeadDecision[];
  roles: LeadRole[];
}

export interface DirectorWaiting {
  applicationId: string;
  openingId: string;
  candidateName: string;
  clientName: string;
  openingTitle: string;
  setNumber: number | null;
  taName: string | null;
}

export interface DirectorHome {
  variant: "director";
  openCount: number;
  /** Sums of the openings' commercial values, in the desk's reporting currency (USD on the web). */
  valueInProgress: number;
  valuePlaced: number;
  waiting: DirectorWaiting[];
  stages: { stage: string; label: string; count: number }[];
  byClient: { clientId: string; name: string; openCount: number; sets: number; value: number }[];
}

export interface OpsWithClient {
  applicationId: string;
  openingId: string;
  candidateName: string;
  clientName: string;
  openingTitle: string;
  daysWithClient: number;
}

export interface OpsHome {
  variant: "ops";
  withClient: OpsWithClient[];
  interviews: HomeInterview[];
  assigned: HomeAlert[];
}

export type HomeVariant = TaHome | LeadHome | DirectorHome | OpsHome;

export interface HomePayload {
  apiVersion: 1;
  /** "Good morning" etc. in Colombo time, from the server. */
  greeting: string;
  generatedAt: number;
  home: HomeVariant;
}
