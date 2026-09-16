import { repo, setsForOpening } from "@/data/store";
import { colomboDayStart } from "@/lib/calendar";
import { PRIORITY_TARGET, URGENT_ALERTS, type AlertKind, type Id } from "@/data/types";
import { hasWorkingHours, isWorkingDay, workingHoursBetween } from "./calendar";

export { isWorkingDay, workingHoursBetween, nextWorkingDay, TIMEZONE, DAILY_CUTOFF_HOUR } from "./calendar";

/**
 * The SLA rules — spec §12, from notebook page 9 and the briefing doc.
 *
 * Alerts are computed from live records rather than stored. A stored alert goes
 * stale the moment someone acts, and a dashboard showing yesterday's problems is
 * worse than one showing none.
 */

export interface LiveAlert {
  id: string;
  kind: AlertKind;
  urgent: boolean;
  openingId: Id;
  subjectId: Id;
  detail: string;
  /** What to do about it, and where. */
  action: string;
  href: string;
  dueAt: number;
  assignedTo: Id[];
}

// ─── The rules ───────────────────────────────────────────────────────────────

const DAY = 86_400_000;

/*
 * One computation per state of the desk, not one per call.
 *
 * The layout counts alerts for the badge on every page, and the dashboard, the
 * openings list and the alerts page each compute them again in the same
 * request. The answer only changes when the data does — or when the clock
 * crosses a threshold, which is why the memo also expires after half a minute.
 * A caller that passes its own `now` (tests, "as of" views) always computes.
 */
const ALERT_MEMO_MS = 30_000;
let alertMemo: { key: string; at: number; alerts: LiveAlert[] } | null = null;

export function computeAlerts(now?: number): LiveAlert[] {
  if (now !== undefined) return computeAlertsAt(now);
  const at = Date.now();
  const key = repo.version();
  if (alertMemo && alertMemo.key === key && at - alertMemo.at < ALERT_MEMO_MS) return alertMemo.alerts;
  const alerts = computeAlertsAt(at);
  alertMemo = { key, at, alerts };
  return alerts;
}

function computeAlertsAt(now: number): LiveAlert[] {
  const out: LiveAlert[] = [];
  const openings = repo.openings().filter((o) => o.status === "open");

  for (const o of openings) {
    const apps = repo.applications(o.id);
    const posts = repo.jobPosts(o.id);
    const live = posts.filter((p) => p.status === "live");
    const team = [...new Set([...o.assignedTaIds, o.taLeadId])];

    // 1. Low volume — fewer than ten CVs in a day. Judged on yesterday, a
    // whole day, rather than on today at eight in the morning, when every
    // advert on the desk has had no time to collect anything.
    const todayStart = colomboDayStart(now);
    const cvsToday = apps.filter(
      (a) => a.jobPostId && live.some((p) => p.id === a.jobPostId) && a.sourcingChannel !== "SCOOP" &&
        a.createdAt >= todayStart - DAY && a.createdAt < todayStart,
    ).length;
    if (live.length > 0 && cvsToday < 10 && live.some((p) => (p.postedAt ?? now) < todayStart - DAY)) {
      out.push({
        id: `lv_${o.id}`,
        kind: "low_volume",
        urgent: false,
        openingId: o.id,
        subjectId: o.id,
        detail: `${o.title} — ${cvsToday} ${cvsToday === 1 ? "CV" : "CVs"} yesterday, under the ten a day line`,
        action: "Open the posts",
        href: `/openings/${o.id}/linkedin-job`,
        dueAt: now + DAY,
        assignedTo: team,
      });
    }

    /*
     * 1b. A live advert that has gone quiet.
     *
     * Different from the low-volume line above, which is about today. This is
     * about an advert that is up on LinkedIn, pointed at a TA's applications
     * inbox, and has produced nothing at all for a working week — which
     * usually means the advert is wrong, the inbox is not wired to it, or it
     * has quietly expired. Only live adverts qualify, because an advert nobody
     * can apply to going quiet is not news.
     */
    const QUIET_DAYS = 5;
    for (const p of live) {
      const onPost = apps.filter((a) => a.jobPostId === p.id);
      const lastAt = onPost.length ? Math.max(...onPost.map((a) => a.createdAt)) : null;
      const since = lastAt ?? p.postedAt ?? p.createdAt;
      const days = Math.floor(workingHoursBetween(since, now) / 24);
      if (days < QUIET_DAYS) continue;
      out.push({
        id: `aq_${p.id}`,
        kind: "advert_quiet",
        urgent: false,
        openingId: o.id,
        subjectId: p.id,
        detail:
          `${p.title} has been up on LinkedIn for ${days} working days with ` +
          (lastAt ? "nothing new" : "no applications at all"),
        action: "Check the advert",
        href: `/openings/${o.id}/linkedin-job`,
        dueAt: now,
        assignedTo: p.assignedTaId ? [p.assignedTaId] : o.assignedTaIds,
      });
    }

    // 2. Stale role — measured against the priority tier, not a flat five days.
    const days = Math.floor((now - (o.assignedAt ?? now)) / DAY);
    const target = PRIORITY_TARGET[o.priorityTier].days;
    if (days > target) {
      out.push({
        id: `st_${o.id}`,
        kind: "stale_role",
        urgent: false,
        openingId: o.id,
        subjectId: o.id,
        detail: `${o.title} — day ${days} against a ${o.priorityTier} target of ${target}`,
        action: "Review or close",
        href: `/openings/${o.id}`,
        dueAt: now,
        assignedTo: [o.taLeadId],
      });
    }

    // 3. Shortlist SLA — unscreened for 24 working hours.
    //
    // Collapsed to one alert per opening rather than one per candidate. Twelve
    // separate rows saying the same thing is not twelve times more useful; it
    // buries everything else on the page and the TA opens the same list either
    // way.
    const unscreened = apps.filter(
      (a) => (a.stage === "new_cv" || a.stage === "matched") && hasWorkingHours(a.createdAt, now, 24),
    );
    if (unscreened.length) {
      const longest = Math.max(...unscreened.map((a) => workingHoursBetween(a.createdAt, now)));
      out.push({
        id: `sl_${o.id}`,
        kind: "shortlist_sla",
        urgent: false,
        openingId: o.id,
        subjectId: o.id,
        detail:
          unscreened.length === 1
            ? `${o.title} — one CV unscreened for ${Math.floor(longest)} working hours`
            : `${o.title} — ${unscreened.length} CVs unscreened, the oldest for ${Math.floor(longest)} working hours`,
        action: "Screen them",
        href: `/openings/${o.id}/database`,
        dueAt: now,
        assignedTo: o.assignedTaIds,
      });
    }

    /*
     * 4. Nobody has replied.
     *
     * The set went out on the end-of-day email and nothing has come back. This
     * is the safety net under the reply reader, and it is the reason the email
     * itself does not have to change: whatever the Director or the client
     * writes, in whatever form, either it reads cleanly and people move, or
     * this fires and a TA goes and asks. The system never asks them to reply
     * in a particular way.
     *
     * One working day on the Director, two on the client — a client is a
     * client and has a day job; the Director is down the corridor.
     */
    for (const round of repo.reviewRounds(o.id)) {
      if (round.status === "returned") continue;
      if (round.applicationIds.length === 0) continue;
      const limitDays = round.kind === "director" ? 1 : 2;
      // `workingHoursBetween` skips weekends and holidays but counts the whole
      // of a working day, so a working day is 24 of these hours, not 8. Getting
      // that wrong reported three calendar days as five working ones.
      const waited = workingHoursBetween(round.sentAt, now);
      if (waited < limitDays * 24) continue;

      const days = Math.floor(waited / 24);
      const who = round.kind === "director" ? "the Director" : "the client";
      // Past double the window it stops being a reminder and goes to the lead.
      const escalated = waited >= limitDays * 24 * 2;
      out.push({
        id: `rc_${round.id}`,
        kind: round.kind === "director" ? "director_review_chase" : "client_review_chase",
        urgent: escalated,
        openingId: o.id,
        subjectId: round.id,
        detail:
          `${o.title} — ${round.applicationIds.length} ${round.applicationIds.length === 1 ? "CV has" : "CVs have"} been with ` +
          `${who} ${days === 0 ? "since yesterday" : `${days} working ${days === 1 ? "day" : "days"}`} with no reply` +
          (round.status === "partial" ? ", and only part of the set was answered" : ""),
        action: round.kind === "director" ? "Ask him" : "Chase the client",
        href: `/openings/${o.id}/eod?kind=${round.kind}`,
        dueAt: round.sentAt + limitDays * DAY,
        assignedTo: escalated
          ? [...new Set([round.sentBy, o.taLeadId])]
          : [round.sentBy],
      });
    }

    // 5 & 6. Interview confirmation, and the escalation if nobody has called.
    for (const iv of repo.interviews().filter((i) => i.outcome === "pending")) {
      const a = repo.application(iv.applicationId);
      if (!a || a.openingId !== o.id) continue;
      const c = repo.candidate(a.candidateId);
      // Reached about THIS interview: a call logged after it was booked. An
      // earlier confirmation for an earlier or since-moved interview does not
      // confirm this one (audit finding 44).
      const contacted =
        !!iv.confirmedAt ||
        repo
          .callFeedback(a.id)
          .some((f) => f.kind === "pre_interview" && f.outcome === "reached" && f.recordedAt >= iv.createdAt);
      const sameDay = colomboDayStart(iv.scheduledAt) === colomboDayStart(now);

      if (sameDay && !contacted) {
        out.push({
          id: `ic_${a.id}`,
          kind: "interview_confirmation",
          urgent: true,
          openingId: o.id,
          subjectId: a.id,
          detail: `Confirm ${c?.fullName ?? "the candidate"} is attending today's interview`,
          action: "Log the call",
          href: `/openings/${o.id}/candidate/${a.id}?tab=call`,
          dueAt: iv.scheduledAt,
          assignedTo: a.ownerTaId ? [a.ownerTaId] : o.assignedTaIds,
        });
      }

      // Spec §12.2a — four hours out, and only if nobody has actually reached them.
      const escalateAt = iv.scheduledAt - 4 * 3_600_000;
      if (!contacted && now >= escalateAt && now < iv.scheduledAt) {
        out.push({
          id: `ie_${a.id}`,
          kind: "interview_confirmation_escalation",
          urgent: true,
          openingId: o.id,
          subjectId: a.id,
          detail: `${c?.fullName ?? "A candidate"} still not contacted — interview in under four hours`,
          action: "Step in",
          href: `/openings/${o.id}/candidate/${a.id}?tab=call`,
          dueAt: iv.scheduledAt,
          assignedTo: [o.taLeadId],
        });
      }
    }

    // 7. Interview follow-up — after it has happened.
    for (const iv of repo.interviews().filter((i) => i.outcome === "attended")) {
      const a = repo.application(iv.applicationId);
      if (!a || a.openingId !== o.id) continue;
      // Done means they were actually spoken to after this interview. A call
      // that went unanswered is an attempt, not a follow-up (audit finding 45).
      const done = repo
        .callFeedback(a.id)
        .some((f) => f.kind === "post_interview" && f.outcome === "reached" && f.recordedAt >= iv.scheduledAt);
      if (done || now < iv.scheduledAt) continue;
      const c = repo.candidate(a.candidateId);
      out.push({
        id: `if_${a.id}`,
        kind: "interview_followup",
        urgent: true,
        openingId: o.id,
        subjectId: a.id,
        detail: `Follow up with ${c?.fullName ?? "the candidate"} after their interview`,
        action: "Log the call",
        href: `/openings/${o.id}/candidate/${a.id}?tab=call`,
        dueAt: iv.scheduledAt + DAY,
        assignedTo: a.ownerTaId ? [a.ownerTaId] : o.assignedTaIds,
      });
    }

    // 8. Joining. An offer needs a start date agreed, and on the morning they
    // start, somebody calls to check they actually arrived (13 September).
    // Read from the offer and the placement — where the dates are entered —
    // not from a special call field nobody could fill in (audit finding 25).
    for (const a of apps.filter((x) => x.stage === "offer")) {
      const offer = repo.offers(a.id).sort((x, y) => y.createdAt - x.createdAt)[0];
      if (!offer || offer.status !== "pending" || offer.startDate) continue;
      const c = repo.candidate(a.candidateId);
      out.push({
        id: `jd_${a.id}`,
        kind: "joining_date",
        urgent: false,
        openingId: o.id,
        subjectId: a.id,
        detail: `No start date agreed yet on ${c?.fullName ?? "a candidate"}'s offer`,
        action: "Add the start date",
        href: `/openings/${o.id}/candidate/${a.id}`,
        dueAt: now,
        assignedTo: a.ownerTaId ? [a.ownerTaId] : o.assignedTaIds,
      });
    }
    for (const pl of repo.placements({ openingId: o.id })) {
      if (pl.fellThroughAt) continue;
      const startDay = colomboDayStart(pl.joinDate);
      if (colomboDayStart(now) !== startDay) continue;
      const checked = repo
        .callFeedback(pl.applicationId)
        .some((f) => f.kind === "post_offer" && f.outcome === "reached" && f.recordedAt >= startDay);
      if (checked) continue;
      const a = repo.application(pl.applicationId);
      const c = a ? repo.candidate(a.candidateId) : null;
      out.push({
        id: `jc_${pl.id}`,
        kind: "joining_date",
        urgent: true,
        openingId: o.id,
        subjectId: pl.applicationId,
        detail: `${c?.fullName ?? "A candidate"} starts today — call this morning and check they arrived`,
        action: "Log the call",
        href: `/openings/${o.id}/candidate/${pl.applicationId}?tab=call`,
        dueAt: startDay + 9 * 3_600_000,
        assignedTo: a?.ownerTaId ? [a.ownerTaId] : o.assignedTaIds,
      });
    }

    // Open sets that have gone quiet — not an SLA from the notes, but the thing
    // a lead actually chases. Kept routine.
    // A set under five goes out every day and is normal. One that has sat under
    // five for more than two days is a recruiter short of CVs.
    for (const openSet of setsForOpening(o.id).filter((s) => s.status === "open")) {
    if (days > 2 && openSet.count > 0 && openSet.count < 5) {
      out.push({
        id: `os_${o.id}_${openSet.taId}`,
        kind: "low_volume",
        urgent: false,
        openingId: o.id,
        subjectId: o.id,
        detail: `${o.title} — set ${openSet.setNumber} stuck at ${openSet.count} of 5`,
        action: "Open the pipeline",
        href: `/openings/${o.id}/pipeline/director_review`,
        dueAt: now,
        assignedTo: [openSet.taId],
      });
    }
    }
  }

  /*
   * 9 & 10. The two things that used to have a tab of their own.
   *
   * A CV arriving and a chase going out are background work — neither should
   * need a screen a TA remembers to visit. They only need a person when
   * something is stuck, and that is an alert, which is where a TA already
   * looks.
   */
  for (const item of repo.intake(["needs_review", "ready", "parsed"])) {
    const stuck = item.status === "needs_review" || !item.openingId;
    if (!stuck) continue;
    const waited = Math.floor(workingHoursBetween(item.receivedAt, now) / 24);
    if (item.status !== "needs_review" && waited < 1) continue;
    const ta = item.routedToTaId;
    out.push({
      id: `cv_${item.id}`,
      kind: "cv_waiting",
      urgent: false,
      openingId: item.openingId ?? "",
      subjectId: item.id,
      detail:
        item.status === "needs_review"
          ? `${item.parsed?.fullName ?? item.fileName ?? "A CV"} may already be on the database — needs a look`
          : `${item.parsed?.fullName ?? item.fileName ?? "A CV"} arrived with no job to go to`,
      action: "Open it",
      href: `/intake/${item.id}`,
      dueAt: item.receivedAt,
      assignedTo: ta ? [ta] : repo.users().filter((u) => u.role === "ta_lead").map((u) => u.id),
    });
  }

  for (const f of repo.followUps(now)) {
    const to = f.application.ownerTaId ? [f.application.ownerTaId] : f.opening.assignedTaIds;
    const s = f.followUp;
    const base = `/openings/${f.opening.id}/candidate/${f.application.id}`;
    const missing = s.missing.map((q) => q.label.toLowerCase()).join(", ");

    if (s.state === "due" && s.next) {
      // Straight to the tab where the owed step is done (audit finding 23).
      const isCall = s.next.channels.includes("ai_call");
      out.push({
        id: `fu_${f.application.id}`,
        kind: "followup_due",
        urgent: false,
        openingId: f.opening.id,
        subjectId: f.application.id,
        detail: `${f.candidate.fullName} — ${isCall ? "call" : "message"} owed now. ${s.next.reason} Still needed: ${missing}.`,
        action: isCall ? "Make the call" : "Send the message",
        href: `${base}?tab=${isCall ? "call" : "chat"}`,
        dueAt: s.next.at,
        assignedTo: to,
      });
    } else if (s.state === "overdue" || s.state === "declined") {
      // The day is up, or they said no: a person's job now.
      out.push({
        id: `fx_${f.application.id}`,
        kind: "followup_due",
        urgent: s.state === "overdue",
        openingId: f.opening.id,
        subjectId: f.application.id,
        detail: `${f.candidate.fullName} — ${s.handBack ?? "needs you"}`,
        action: s.state === "overdue" ? "Call them yourself" : "Mark dropped out",
        href: `${base}?tab=call`,
        dueAt: s.deadline,
        assignedTo: to,
      });
    }
  }

  return out.sort((a, b) => Number(b.urgent) - Number(a.urgent) || a.dueAt - b.dueAt);
}

export function alertsFor(userId: Id, now?: number): LiveAlert[] {
  return computeAlerts(now).filter((a) => a.assignedTo.includes(userId));
}

