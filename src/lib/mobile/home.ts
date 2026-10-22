import { repo, setsForOpening, stageCounts } from "@/data/store";
import { PIPELINE_STAGES, PRIORITY_TARGET, STAGE_LABEL, type Interview, type User } from "@/data/types";
import { kindLabel } from "@/lib/alertKinds";
import { isTa } from "@/lib/auth";
import { colomboDaysBetween } from "@/lib/calendar";
import { linkedinStatus, type LinkedInStatus } from "@/lib/linkedinStatus";
import { openingNeed } from "@/lib/openingNeed";
import { alertsFor, computeAlerts, type LiveAlert } from "@/lib/sla";

import type {
  DirectorHome,
  HomeAlert,
  HomeInterview,
  HomeVariant,
  LeadDecision,
  LeadHome,
  OpsHome,
  TaHome,
} from "./homeTypes";

/**
 * `GET /api/mobile/v1/home` — the web home dashboard, one variant per role, as
 * data (the app pages the lists locally, so the web's `?q`, `?li` and paging
 * are not applied here).
 *
 * Each builder mirrors one web screen and says which. They read only from
 * `repo` and the same helpers the screens use, with no Next imports, so the
 * whole payload is testable against the JSON store. The role switch is the one
 * in src/app/page.tsx. Clients are refused before this is called (see the
 * route); `client` is not a role this function serves.
 *
 * `now` is passed through to the alert rules only when a caller gives one:
 * left undefined, they use the same 30-second memo as the web request does.
 */
export function mobileHome(user: User, now?: number): HomeVariant {
  if (user.role === "ta_lead" || user.role === "admin") return leadHome(user, now);
  if (user.role === "director") return directorHome();
  if (user.role === "ops") return opsHome(user, now);
  return taHome(user, now);
}

function homeAlert(alert: LiveAlert): HomeAlert {
  return {
    id: alert.id,
    kind: alert.kind,
    kindLabel: kindLabel(alert.kind),
    detail: alert.detail,
    action: alert.action,
    href: alert.href,
    dueAt: alert.dueAt,
  };
}

const clientName = (clientId: string) => repo.client(clientId)?.name ?? "";
const userNames = (ids: string[]) =>
  ids.map((id) => repo.user(id)?.name).filter((name): name is string => !!name);

/** "Attendance confirmed" on the web: a pre-interview call reached the candidate. */
function homeInterview(interview: Interview): HomeInterview | null {
  const application = repo.application(interview.applicationId);
  const opening = application ? repo.opening(application.openingId) : null;
  // Without these there is nothing to link to; the web row would be blank too.
  if (!application || !opening) return null;
  return {
    id: interview.id,
    applicationId: application.id,
    openingId: opening.id,
    candidateName: repo.candidate(application.candidateId)?.fullName ?? "",
    openingTitle: opening.title,
    scheduledAt: interview.scheduledAt,
    mode: interview.mode,
    confirmed: repo
      .callFeedback(application.id)
      .some((feedback) => feedback.kind === "pre_interview" && feedback.outcome === "reached"),
  };
}

// ─── TA (and every role not below): src/app/page.tsx ─────────────────────────

function taHome(user: User, now?: number): TaHome {
  const at = now ?? Date.now();
  const visible = repo.openingsForUser(user);
  const openings = visible.filter((opening) => opening.status === "open");
  const alerts = alertsFor(user.id, now);

  /*
   * Upcoming interviews: the next five pending ones, as on the web — but only
   * on openings this user can see. The web list reads every interview on the
   * desk; the app does not widen what a TA can see to other TAs' candidates
   * (the same scoping as /api/mobile/v1/bootstrap).
   */
  const visibleIds = new Set(visible.map((opening) => opening.id));
  const interviews = repo
    .interviews()
    .filter((interview) => interview.outcome === "pending" && interview.scheduledAt > at)
    .filter((interview) => visibleIds.has(repo.application(interview.applicationId)?.openingId ?? ""))
    .sort((a, b) => a.scheduledAt - b.scheduledAt)
    .slice(0, 5)
    .map(homeInterview)
    .filter((row): row is HomeInterview => row !== null);

  return {
    variant: "ta",
    openCount: openings.length,
    urgent: alerts.filter((alert) => alert.urgent).map(homeAlert),
    openings: openings.map((opening) => {
      const counts = stageCounts(opening.id);
      const posts = repo.jobPosts(opening.id);
      const cvsToday = posts.filter((post) => post.status === "live").reduce((n, post) => n + post.cvCountToday, 0);
      const openSet = setsForOpening(opening.id).find((set) => set.status === "open");
      return {
        id: opening.id,
        clientName: clientName(opening.clientId),
        title: opening.title,
        linkedin: linkedinStatus(posts),
        followUp: (counts.ai_follow_up ?? 0) + (counts.ta_follow_up ?? 0),
        cvsToday,
        daysOpen: opening.assignedAt ? colomboDaysBetween(opening.assignedAt, at) : 0,
        targetDays: PRIORITY_TARGET[opening.priorityTier].days,
        need: openingNeed({ jdStatus: opening.jdStatus, cvsToday, openSet }),
      };
    }),
    interviews,
    routine: alerts.filter((alert) => !alert.urgent).slice(0, 6).map(homeAlert),
  };
}

// ─── TA Lead and admin: src/components/dash/LeadDashboard.tsx ────────────────

const IN_PIPELINE = ["ai_follow_up", "ta_follow_up", "follow_up", "director_review", "director_shortlist", "client_shortlist"];

function leadHome(user: User, now?: number): LeadHome {
  const at = now ?? Date.now();
  const openings = repo.openings().filter((opening) => opening.status === "open");
  const linked = new Map<string, LinkedInStatus>(
    openings.map((opening) => [opening.id, linkedinStatus(repo.jobPosts(opening.id))]),
  );
  const alerts = computeAlerts(now);

  const team = repo
    .users()
    .filter((u) => isTa(u))
    .map((ta) => {
      const mine = openings.filter((opening) => opening.assignedTaIds.includes(ta.id));
      const apps = mine.flatMap((opening) => repo.applications(opening.id)).filter((a) => a.ownerTaId === ta.id);
      const onLinkedIn = mine.filter((opening) => linked.get(opening.id) === "connected").length;
      const noLink = mine.filter((opening) => linked.get(opening.id) === "no_link").length;
      return {
        userId: ta.id,
        name: ta.name,
        initials: ta.initials,
        roleCount: mine.length,
        roleTitles: mine.slice(0, 2).map((opening) => opening.title),
        onLinkedIn,
        noLink,
        notPosted: mine.length - onLinkedIn - noLink,
        inPipeline: apps.filter((a) => IN_PIPELINE.includes(a.stage)).length,
        cvsToday: mine
          .flatMap((opening) => repo.jobPosts(opening.id))
          .filter((post) => post.status === "live")
          .reduce((n, post) => n + post.cvCountToday, 0),
        sets: mine.reduce((n, opening) => n + setsForOpening(opening.id).filter((s) => s.status === "closed").length, 0),
        alerts: alerts.filter((alert) => alert.assignedTo.includes(ta.id)).length,
      };
    });

  // Decisions are scoped to the roles this lead leads, falling back to the whole desk.
  const theirs = openings.filter((opening) => opening.taLeadId === user.id);
  const scope = theirs.length > 0 ? theirs : openings;
  const daysOpen = (assignedAt: number | null) => (assignedAt ? colomboDaysBetween(assignedAt, at) : 0);
  const decisions: LeadDecision[] = [
    ...scope
      .filter((opening) => opening.assignedTaIds.length === 0)
      .map((opening): LeadDecision => ({
        kind: "unassigned",
        openingId: opening.id,
        title: opening.title,
        clientName: clientName(opening.clientId),
      })),
    ...scope
      .filter((opening) => opening.jdStatus === "pending_ta_approval")
      .map((opening): LeadDecision => ({
        kind: "jd",
        openingId: opening.id,
        title: opening.title,
        clientName: clientName(opening.clientId),
        taNames: userNames(opening.assignedTaIds),
      })),
    ...scope
      .filter((opening) => daysOpen(opening.assignedAt) > PRIORITY_TARGET[opening.priorityTier].days)
      .map((opening): LeadDecision => ({
        kind: "stale",
        openingId: opening.id,
        title: opening.title,
        clientName: clientName(opening.clientId),
        daysOpen: daysOpen(opening.assignedAt),
        priorityTier: opening.priorityTier,
        targetDays: PRIORITY_TARGET[opening.priorityTier].days,
      })),
  ];

  return {
    variant: "lead",
    // The header line in src/app/page.tsx: this user's open roles and urgent alerts.
    openCount: repo.openingsForUser(user).filter((opening) => opening.status === "open").length,
    urgentCount: alertsFor(user.id, now).filter((alert) => alert.urgent).length,
    team,
    decisions,
    roles: openings.map((opening) => {
      const counts = stageCounts(opening.id);
      return {
        openingId: opening.id,
        title: opening.title,
        clientName: clientName(opening.clientId),
        taNames: userNames(opening.assignedTaIds),
        assignedAt: opening.assignedAt ?? null,
        linkedin: linked.get(opening.id) ?? "no_post",
        followUp: (counts.ai_follow_up ?? 0) + (counts.ta_follow_up ?? 0),
      };
    }),
  };
}

// ─── Director: src/components/dash/DirectorDashboard.tsx ─────────────────────

function directorHome(): DirectorHome {
  const openings = repo.openings();
  const open = openings.filter((opening) => opening.status === "open");

  return {
    variant: "director",
    openCount: open.length,
    valueInProgress: open.reduce((n, opening) => n + (opening.valueOnProgressing ?? 0), 0),
    valuePlaced: openings.reduce((n, opening) => n + (opening.valueOfPlacement ?? 0), 0),
    waiting: open.flatMap((opening) =>
      repo
        .applications(opening.id)
        .filter((a) => a.stage === "director_review")
        .map((a) => ({
          applicationId: a.id,
          openingId: opening.id,
          candidateName: repo.candidate(a.candidateId)?.fullName ?? "",
          clientName: clientName(opening.clientId),
          openingTitle: opening.title,
          // The web prints "set N" only when there is one.
          setNumber: a.setNumber || null,
          taName: repo.user(a.ownerTaId ?? "")?.name ?? null,
        })),
    ),
    stages: PIPELINE_STAGES.map((stage) => ({
      stage,
      label: STAGE_LABEL[stage],
      count: open.reduce((sum, opening) => sum + (stageCounts(opening.id)[stage] ?? 0), 0),
    })),
    byClient: repo.clients().map((client) => {
      const mine = open.filter((opening) => opening.clientId === client.id);
      return {
        clientId: client.id,
        name: client.name,
        openCount: mine.length,
        sets: mine.reduce((n, opening) => n + setsForOpening(opening.id).filter((s) => s.status === "closed").length, 0),
        value: mine.reduce((n, opening) => n + (opening.valueOnProgressing ?? 0), 0),
      };
    }),
  };
}

// ─── Ops: src/components/dash/OpsDashboard.tsx ───────────────────────────────

function opsHome(user: User, now?: number): OpsHome {
  const at = now ?? Date.now();
  const open = repo.openings().filter((opening) => opening.status === "open");

  return {
    variant: "ops",
    withClient: open.flatMap((opening) =>
      repo
        .applications(opening.id)
        .filter((a) => a.stage === "client_shortlist")
        .map((a) => ({
          applicationId: a.id,
          openingId: opening.id,
          candidateName: repo.candidate(a.candidateId)?.fullName ?? "",
          clientName: clientName(opening.clientId),
          openingTitle: opening.title,
          daysWithClient: colomboDaysBetween(a.lastStageChangedAt, at),
        })),
    ),
    // Every pending interview, past ones included, as the web's coordination list.
    interviews: repo
      .interviews()
      .filter((interview) => interview.outcome === "pending")
      .sort((a, b) => a.scheduledAt - b.scheduledAt)
      .map(homeInterview)
      .filter((row): row is HomeInterview => row !== null),
    assigned: computeAlerts(now).filter((alert) => alert.assignedTo.includes(user.id)).map(homeAlert),
  };
}
