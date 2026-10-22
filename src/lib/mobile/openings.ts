import { repo, setsForOpening, stageCounts } from "@/data/store";
import { CLOSED_STAGES, PIPELINE_STAGES, PRIORITY_TARGET, STAGE_LABEL, URGENT_ALERTS } from "@/data/types";
import type { Application, Opening, Stage, User } from "@/data/types";
import { openingFacts } from "@/lib/openingFacts";
import { toCountry } from "@/lib/openingCountry";
import { assignableTas } from "@/lib/assignable";
import { allows, isDeskWide, isTa, seesEveryTaRow } from "@/lib/auth";
import { colomboDaysBetween } from "@/lib/format";
import { linkedinStatus } from "@/lib/linkedinStatus";
import { levelLabel } from "@/lib/linkViews";
import { OPENING_BUCKETS, statusMatchesBucket, type OpeningBucket } from "@/lib/openingStatus";
import { computeAlerts } from "@/lib/sla";
import { seatFor, visiblePosts, visibleToSeat, type Seat } from "@/lib/visibility";
import type {
  AvailableOpening,
  MatchingSnapshot,
  OpeningOverview,
  OpeningRow,
  OpeningSection,
  OpeningShell,
  OpeningsPayload,
  PendingAccessRequest,
  WorkingStage,
} from "@/lib/mobile/openingsTypes";

/**
 * The web's openings list (src/app/openings/page.tsx) and one opening's
 * layout and Overview (src/app/openings/[id]/layout.tsx, page.tsx), as data
 * for the native app. Read only from the store; the routes fetch what comes
 * from Convex (access requests, daily emails, matching) and pass it in.
 */

function seatOf(user: User, openingId: string): Seat {
  const onStrategy = repo.strategyAssignments(openingId).some((r) => r.doneBy.includes(user.id));
  return seatFor(user, repo.assignmentFor(openingId, user.id)?.role ?? null, onStrategy);
}

/** Stage counts for this person's own desk — a TA beside another sees their own (2 Oct). */
function countsFor(openingId: string, seat: Seat): Partial<Record<Stage, number>> {
  if (!seat.ownDeskOf) return stageCounts(openingId);
  return visibleToSeat(repo.applications(openingId), seat).reduce(
    (m, a) => {
      m[a.stage] = (m[a.stage] ?? 0) + 1;
      return m;
    },
    {} as Partial<Record<Stage, number>>,
  );
}

function bucketsOf(o: Opening, mineIds: Set<string>): OpeningBucket[] {
  const out: OpeningBucket[] = [];
  if (mineIds.has(o.id) && o.status === "open") out.push("mine");
  if (o.status === "open") out.push("all");
  if (o.status === "open" && o.assignedTaIds.length === 0) out.push("unassigned");
  for (const b of ["hold", "placed", "closed"] as const) if (statusMatchesBucket(o.status, b)) out.push(b);
  return out;
}

export function mobileOpeningsList(
  user: User,
  extra: { requestable: AvailableOpening[] | null; pendingRequests: PendingAccessRequest[] | null },
  now = Date.now(),
): OpeningsPayload {
  const clients = repo.clients();
  const users = repo.users();
  const mine = repo.openingsForUser(user);
  const mineIds = new Set(mine.map((o) => o.id));
  // "All" is the desk's list for someone who reviews the desk, and their own
  // list for anyone else — as on the web.
  const all = isDeskWide(user) ? repo.openings() : mine;
  const liveAlerts = computeAlerts();

  const rows: OpeningRow[] = all.map((o) => {
    const client = clients.find((c) => c.id === o.clientId);
    const seat = seatOf(user, o.id);
    const counts = countsFor(o.id, seat);
    // Each TA numbers their own sets, so the footer speaks for the reader.
    const sets = setsForOpening(o.id, isDeskWide(user) ? undefined : user.id);
    const posts = repo.jobPosts(o.id);
    const assignment = repo.assignmentFor(o.id, user.id) ?? null;
    const canStage = allows(user, "opening.act", { assignment });
    const canManage = allows(user, "opening.manage", { openingId: o.id, assignment });
    return {
      id: o.id,
      clientId: o.clientId,
      clientName: client?.name ?? "",
      clientIndustry: client?.industry?.trim() || null,
      title: o.title,
      priorityTier: o.priorityTier,
      status: o.status,
      workingStage: canStage ? (repo.workingStage(o.id, user.id) as WorkingStage) : null,
      targetNationalities: o.targetNationalities,
      locations: o.locations,
      countries: [...new Set(o.locations.map(toCountry).filter(Boolean))],
      postCount: posts.length,
      taIds: o.assignedTaIds,
      taNames: o.assignedTaIds.map((t) => users.find((u) => u.id === t)?.name ?? "").filter(Boolean),
      followUp: (counts.ai_follow_up ?? 0) + (counts.ta_follow_up ?? 0),
      directorReview: counts.director_review ?? 0,
      cvsToday: posts.filter((p) => p.status === "live").reduce((n, p) => n + p.cvCountToday, 0),
      daysOpen: o.assignedAt ? colomboDaysBetween(o.assignedAt, now) : 0,
      targetDays: PRIORITY_TARGET[o.priorityTier].days,
      setsClosed: sets.filter((s) => s.status === "closed").length,
      openSets: sets
        .filter((s) => s.status === "open")
        .map((s) => `${isDeskWide(user) ? `${users.find((u) => u.id === s.taId)?.name ?? "TA"}'s` : "your"} set ${s.setNumber} has ${s.count}`),
      assignedAt: o.assignedAt ?? null,
      jdWaiting: o.jdStatus === "pending_ta_approval",
      urgentAlerts: liveAlerts.filter((a) => a.openingId === o.id && a.urgent).length,
      linkedin: linkedinStatus(posts),
      canBin: canManage,
      canSetStatus: canManage,
      buckets: bucketsOf(o, mineIds),
    };
  });

  const counts: Record<OpeningBucket, number> = {
    mine: mine.filter((o) => o.status === "open").length,
    all: all.filter((o) => o.status === "open").length,
    unassigned: all.filter((o) => o.status === "open" && o.assignedTaIds.length === 0).length,
    hold: all.filter((o) => o.status === "on_hold").length,
    placed: all.filter((o) => o.status === "filled").length,
    closed: all.filter((o) => o.status === "closed").length,
  };

  return {
    apiVersion: 1,
    buckets: OPENING_BUCKETS.map((b) => ({ key: b.key, label: b.label, count: counts[b.key] })),
    rows,
    filters: {
      countries: [...new Set(all.flatMap((o) => o.locations).map(toCountry).filter(Boolean))].sort(),
      industries: ([...new Set(clients.map((c) => c.industry?.trim()).filter(Boolean))] as string[]).sort(),
      clients: clients.map((c) => ({ id: c.id, name: c.name })).sort((a, b) => a.name.localeCompare(b.name)),
      tas: isDeskWide(user) ? assignableTas(users).map((u) => ({ id: u.id, name: u.name })) : null,
    },
    requestable: isTa(user) ? extra.requestable ?? [] : null,
    pendingRequests: user.role === "ta_lead" || user.role === "admin" ? extra.pendingRequests ?? [] : null,
    canCreate: allows(user, "opening.create"),
  };
}

/** May this person open the opening at all (the layout's gate). */
export function mayReadOpening(user: User, openingId: string): boolean {
  const assignment = repo.assignmentFor(openingId, user.id) ?? null;
  const onStrategy = repo.strategyAssignments(openingId).some((r) => r.doneBy.includes(user.id));
  return allows(user, "opening.read", { openingId, assignment, onStrategy });
}

export function mobileOpeningShell(
  user: User,
  openingId: string,
  extra: { middayEmails: { id: string; number: number; status: string }[] },
): OpeningShell | null {
  const o = repo.opening(openingId);
  if (!o) return null;
  const client = repo.client(o.clientId);
  const seat = seatOf(user, openingId);
  const assignment = repo.assignmentFor(openingId, user.id) ?? null;
  const canStage = allows(user, "opening.act", { assignment });
  const canManage = allows(user, "opening.manage", { openingId, assignment });
  const counts = countsFor(openingId, seat);
  const apps = visibleToSeat(repo.applications(openingId), seat);

  // The rail, by seat (components/ProjectSidebar): a client contact reads the
  // shortlist and the job it is for; Midday and EOD only for a seat that acts.
  const sections: OpeningSection[] = ["overview", "pipeline"];
  if (seat.canSeeSourcing) {
    sections.push("scoops", "linkedin", "jd", "database", "snippets", "strategies");
    if (seat.canAct) sections.push("midday", "eod");
    sections.push("hh_overview", "hh_research", "hh_suggestions", "hh_tables");
  } else {
    sections.push("jd");
  }

  // The stages this seat may open; the web lists them all and refuses on the page.
  const allowed = seat.stages === null ? null : new Set(seat.stages);
  const stages = [...PIPELINE_STAGES.map((s) => ({ s, closed: false })), ...CLOSED_STAGES.map((s) => ({ s, closed: true }))]
    .filter(({ s }) => allowed === null || allowed.has(s))
    .map(({ s, closed }) => ({ stage: s, label: STAGE_LABEL[s], count: counts[s] ?? 0, closed }));

  // Excel Tables: the L-sheets this person started, or the opening's for a lead
  // who has none of their own (layout.tsx).
  let tables: OpeningShell["tables"] = [];
  if (seat.canSeeSourcing) {
    const isLeadViewer = isDeskWide(user) || seesEveryTaRow(user);
    const myLevels = repo.linkLevels(openingId, user.id);
    const vaultRows = repo.linkVault(openingId);
    if (myLevels.length > 0 || !isLeadViewer) {
      const mine = vaultRows.filter((r) => r.addedBy === user.id);
      tables = myLevels.map((l) => ({ n: l.n, label: levelLabel(l), name: l.name ?? "", count: mine.filter((r) => r.level === l.n).length }));
    } else {
      const byN = new Map<number, { n: number; at: number; name?: string }>();
      for (const uid of [...new Set(vaultRows.map((r) => r.addedBy))]) {
        for (const l of repo.linkLevels(openingId, uid)) if (!byN.has(l.n)) byN.set(l.n, { ...l });
      }
      for (const r of vaultRows) if (typeof r.level === "number" && r.level > 0 && !byN.has(r.level)) byN.set(r.level, { n: r.level, at: 0 });
      tables = [...byN.values()]
        .sort((a, b) => a.n - b.n)
        .map((l) => ({ n: l.n, label: l.at ? levelLabel(l) : `L${l.n}`, name: l.name ?? "", count: vaultRows.filter((r) => r.level === l.n).length }));
    }
  }

  return {
    id: o.id,
    title: o.title,
    clientName: client?.name ?? "",
    positionCode: o.positionCode ?? null,
    status: o.status,
    workingStage: canStage ? (repo.workingStage(openingId, user.id) as WorkingStage) : null,
    team: o.assignedTaIds.flatMap((t) => {
      const u = repo.user(t);
      return u ? [{ id: u.id, name: u.name, initials: u.initials }] : [];
    }),
    canSetStatus: canManage,
    canBin: canManage,
    sections,
    stages,
    posts: seat.canSeeSourcing
      ? visiblePosts(repo.jobPosts(openingId), user).map((p) => ({
          id: p.id,
          title: p.title,
          status: p.status,
          count: apps.filter((a: Application) => a.jobPostId === p.id).length,
        }))
      : [],
    tables,
    middayEmails: seat.canAct ? extra.middayEmails : [],
    workLocations: (o.workLocations ?? []).filter((l) => !l.archived).map((l) => ({ id: l.id, name: l.name })),
  };
}

export function mobileOpeningOverview(
  user: User,
  openingId: string,
  extra: { matching: { state: MatchingSnapshot; canRun: boolean } | null },
  now = Date.now(),
): OpeningOverview | null {
  const o = repo.opening(openingId);
  if (!o) return null;
  const seat = seatOf(user, openingId);
  const counts = countsFor(openingId, seat);
  const sets = setsForOpening(openingId);
  const openSet = sets.find((s) => s.status === "open" && s.taId === user.id);
  const apps = visibleToSeat(repo.applications(openingId), seat);
  const cvsToday = repo.jobPosts(openingId).filter((p) => p.status === "live").reduce((n, p) => n + p.cvCountToday, 0);
  const users = repo.users();
  const health = repo.health(openingId, now);

  const brief = repo.briefsForOpening(openingId)[0] ?? (o.briefId ? repo.brief(o.briefId) : null);
  const be = brief?.extracted;
  const briefSummary = [
    be?.salaryMin ? `${be.currency} ${be.salaryMin.toLocaleString()}${be.salaryMax ? `–${be.salaryMax.toLocaleString()}` : ""}` : null,
    be?.locations.length ? be.locations.join(", ") : null,
    be?.nationalities.length ? `${be.nationalities.join(", ")} only` : null,
    be?.mustHaves.length ? `${be.mustHaves.length} requirements` : null,
    be?.priorityTier ? be.priorityTier : null,
  ].filter(Boolean) as string[];

  const inbox = apps.filter((a) => a.stage === "new_cv" || a.stage === "matched").length;
  const followUp = (counts.ai_follow_up ?? 0) + (counts.ta_follow_up ?? 0);
  const base = `/openings/${openingId}`;
  const suggested = [
    inbox > 0 && {
      title: `Review ${inbox} unscreened ${inbox === 1 ? "CV" : "CVs"}`,
      sub: "Applicants and database matches nobody has claimed",
      href: `${base}/database`,
      action: "Review",
    },
    openSet && {
      title: `Set ${openSet.setNumber} has ${openSet.count} so far`,
      sub: `It goes to the Director tonight as it is, and carries on as set ${openSet.setNumber} until a day you send five or more`,
      href: `${base}/eod`,
      action: "End of day",
    },
    (counts.director_review ?? 0) > 0 && {
      title: `${counts.director_review} ready for the Director`,
      sub: "Send the end-of-day email with their prepared CVs attached",
      href: `${base}/eod`,
      action: "Review email",
    },
    followUp > 0 && {
      title: `${followUp} in follow-up`,
      sub: `${counts.ta_follow_up ?? 0} in TA Follow-up · ${counts.ai_follow_up ?? 0} in AI Follow-up`,
      href: `${base}/pipeline/${(counts.ta_follow_up ?? 0) > 0 ? "ta_follow_up" : "ai_follow_up"}`,
      action: "Continue",
    },
  ].filter(Boolean) as OpeningOverview["suggested"];

  const alerts = computeAlerts().filter((a) => a.subjectId === openingId || apps.some((x) => x.id === a.subjectId));
  const r = o.requirements;

  return {
    facts: openingFacts(o),
    inPipeline: PIPELINE_STAGES.reduce((n, s) => n + (counts[s] ?? 0), 0),
    cvsToday,
    daysOpen: o.assignedAt ? colomboDaysBetween(o.assignedAt, now) : 0,
    targetDays: PRIORITY_TARGET[o.priorityTier].days,
    health: health ? { score: health.score, band: health.band, headline: health.headline, parts: health.parts } : null,
    jdApproval:
      o.jdStatus === "pending_ta_approval"
        ? {
            jd: o.jdMarkdown ?? "",
            canApprove: o.assignedTaIds.includes(user.id) || user.role === "admin",
            approverLabel: o.assignedTaIds.map((t) => users.find((u) => u.id === t)?.name).join(" or "),
            hasBrief: Boolean(brief && (brief.notesMarkdown.trim() || brief.recordingKey)),
            briefSummary,
          }
        : null,
    briefs: repo
      .briefsForOpening(openingId)
      .filter((b) => b.notesMarkdown.trim())
      .map((b) => {
        const author = users.find((u) => u.id === b.capturedBy);
        return { id: b.id, author: author?.name ?? "Someone on the desk", isLead: !isTa(author), notes: b.notesMarkdown.trim(), at: b.capturedAt };
      }),
    jobDetails: r
      ? {
          salaryMin: r.salaryMin,
          salaryMax: r.salaryMax,
          salaryCurrency: r.salaryCurrency,
          location: r.location,
          experienceMinYears: r.experienceMinYears,
          experienceMaxYears: r.experienceMaxYears,
          seniorityLevel: r.seniorityLevel,
          educationLevel: r.educationLevel,
          clientIndustry: r.clientIndustry,
          requiredSkills: r.requiredSkills,
          niceToHaveSkills: r.niceToHaveSkills,
          languagesRequired: r.languagesRequired,
          recruitmentType: r.recruitmentType,
          isConfidential: r.isConfidential,
        }
      : null,
    matching: o.jdStatus === "approved" ? extra.matching : null,
    suggested,
    pipeline: PIPELINE_STAGES.map((s) => ({ stage: s, label: STAGE_LABEL[s], count: counts[s] ?? 0 })),
    activity: apps
      .filter((a) => a.ownerTaId)
      .sort((x, y) => y.lastStageChangedAt - x.lastStageChangedAt)
      .slice(0, 5)
      .map((a) => ({
        applicationId: a.id,
        candidateName: repo.candidate(a.candidateId)?.fullName ?? "",
        stageLabel: STAGE_LABEL[a.stage] ?? a.stage,
        byName: users.find((u) => u.id === a.ownerTaId)?.name ?? null,
        at: a.lastStageChangedAt,
      })),
    about: {
      team: o.assignedTaIds.map((t) => users.find((u) => u.id === t)?.name ?? "").filter(Boolean),
      lead: users.find((u) => u.id === o.taLeadId)?.name ?? null,
      setsFinished: sets.filter((s) => s.status === "closed").length,
      yourOpenSet: openSet ? { setNumber: openSet.setNumber, count: openSet.count } : null,
      reference: o.positionCode ?? null,
      attention: alerts.length,
      attentionUrgent: alerts.some((a) => URGENT_ALERTS.includes(a.kind)),
    },
    // The TA running the role can correct its details (OpeningAdmin canEdit).
    canEdit: o.assignedTaIds.includes(user.id) || !isTa(user),
  };
}
