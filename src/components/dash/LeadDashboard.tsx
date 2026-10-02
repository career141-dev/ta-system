import Link from "next/link";
import { repo, stageCounts, setsForOpening } from "@/data/store";
import { computeAlerts } from "@/lib/sla";
import { PRIORITY_TARGET } from "@/data/types";
import { colomboDaysBetween, relDays } from "@/lib/format";
import { Pager } from "@/components/Pager";
import { matchesQuery, pageOf, type Params } from "@/lib/paging";
import { linkedinStatus, type LinkedInStatus } from "@/lib/linkedinStatus";
import { LinkedInPill } from "@/components/LinkedInPill";

/**
 * The TA Lead's view — spec §13: allocation across the team, who is under the
 * line, and which roles have gone stale. Deliberately not a copy of the TA's
 * screen; a lead is looking at people and throughput, not at candidates.
 */
export function LeadDashboard({ leadId, sp = {} }: { leadId: string; sp?: Params }) {
  const q = typeof sp.q === "string" ? sp.q : "";
  // The header search, on the dashboard, narrows its lists: a role, its client, a TA.
  const roleMatches = (o: { title: string; clientId: string }) => matchesQuery(q, o.title, repo.client(o.clientId)?.name);
  const openings = repo.openings().filter((o) => o.status === "open");
  // Each job's LinkedIn connection, worked out once for both lists (30 Sep).
  const linked = new Map<string, LinkedInStatus>(openings.map((o) => [o.id, linkedinStatus(repo.jobPosts(o.id))]));
  const offOnly = sp.li === "off";
  // A TA matches by name, or by carrying a role that matches.
  const tas = repo
    .users()
    .filter((u) => u.role === "ta")
    .filter((u) => matchesQuery(q, u.name) || openings.some((o) => o.assignedTaIds.includes(u.id) && roleMatches(o)));
  const alerts = computeAlerts();

  const load = tas.map((t) => {
    const mine = openings.filter((o) => o.assignedTaIds.includes(t.id));
    const apps = mine.flatMap((o) => repo.applications(o.id)).filter((a) => a.ownerTaId === t.id);
    const cvsToday = mine
      .flatMap((o) => repo.jobPosts(o.id))
      .filter((p) => p.status === "live")
      .reduce((n, p) => n + p.cvCountToday, 0);
    const sets = mine.reduce(
      (n, o) => n + setsForOpening(o.id).filter((s) => s.status === "closed").length,
      0,
    );
    return {
      ta: t,
      openings: mine,
      inPipeline: apps.filter((a) =>
        ["ai_follow_up", "ta_follow_up", "follow_up", "director_review", "director_shortlist", "client_shortlist"].includes(a.stage),
      ).length,
      cvsToday,
      sets,
      alerts: alerts.filter((a) => a.assignedTo.includes(t.id)).length,
      onLinkedIn: mine.filter((o) => linked.get(o.id) === "connected").length,
      noLink: mine.filter((o) => linked.get(o.id) === "no_link").length,
    };
  });

  /*
   * Scoped to the roles this lead actually leads.
   *
   * `leadId` was accepted and never used, so every lead saw an identical
   * dashboard — including stale roles and unassigned roles belonging to
   * somebody else's desk, which is a list you cannot act on. Where a lead
   * leads nothing (an admin looking), it falls back to the whole desk.
   */
  const theirs = openings.filter((o) => o.taLeadId === leadId);
  const scope = theirs.length > 0 ? theirs : openings;

  const stale = scope.filter(roleMatches).filter((o) => {
    const days = o.assignedAt ? colomboDaysBetween(o.assignedAt) : 0;
    return days > PRIORITY_TARGET[o.priorityTier].days;
  });
  const unassigned = scope.filter(roleMatches).filter((o) => o.assignedTaIds.length === 0);
  const awaitingJd = scope.filter(roleMatches).filter((o) => o.jdStatus === "pending_ta_approval");

  // Each list pages on its own.
  const team = pageOf(load, sp, "tpage", 10, "/");
  const decisions = pageOf(
    [
      ...unassigned.map((o) => ({ kind: "unassigned" as const, o })),
      ...awaitingJd.map((o) => ({ kind: "jd" as const, o })),
      ...stale.map((o) => ({ kind: "stale" as const, o })),
    ],
    sp,
    "dpage",
    10,
    "/",
  );
  const notOn = openings.filter(roleMatches).filter((o) => linked.get(o.id) !== "connected");
  const roles = pageOf(offOnly ? notOn : openings.filter(roleMatches), sp, "rpage", 15, "/");
  const liHref = (on: boolean) => {
    const params = new URLSearchParams();
    if (q) params.set("q", q);
    if (on) params.set("li", "off");
    const qs = params.toString();
    return qs ? `/?${qs}` : "/";
  };

  return (
    <>
      <section className="mb-8">
        <h2 className="mb-3.5 text-[13px] font-semibold">The team today</h2>
        <div className="overflow-hidden rounded-2xl border border-rule bg-surface shadow-[0_1px_2px_rgba(23,28,24,0.04)]">
          <div className="divide-y divide-rule">
            {load.length === 0 && (
              <p className="px-7 py-10 text-center text-[12.5px] text-ink-faint">Nobody matches that search.</p>
            )}
            {team.rows.map((l) => (
              <div key={l.ta.id} className="flex flex-wrap items-center gap-x-6 gap-y-3 px-7 py-4">
                <span className="grid h-8 w-8 shrink-0 place-items-center rounded-full bg-tag text-[11px] font-bold text-ink-soft">
                  {l.ta.initials}
                </span>
                <div className="min-w-[150px] flex-1">
                  <p className="text-[13.5px] font-medium">{l.ta.name}</p>
                  {/* Finding 17 — this printed every title joined by a dot, so
                      a TA carrying seventeen roles produced three dense lines
                      of run-together job titles that pushed everyone else off
                      the screen. The count is the number a lead reads; the
                      first two are context. */}
                  <p className="mt-0.5 text-[11.5px] text-ink-faint">
                    {l.openings.length === 0 ? (
                      "Nothing assigned"
                    ) : (
                      <>
                        <span className="tabular font-medium text-ink-soft">
                          {l.openings.length} {l.openings.length === 1 ? "role" : "roles"}
                        </span>
                        {" · "}
                        <span title={l.openings.map((o) => o.title).join(" · ")}>
                          {l.openings.slice(0, 2).map((o) => o.title).join(" · ")}
                          {l.openings.length > 2 && ` and ${l.openings.length - 2} more`}
                        </span>
                      </>
                    )}
                  </p>
                  {l.openings.length > 0 && (
                    <p className="mt-1 flex items-center gap-1.5 text-[11.5px] text-ink-soft">
                      <span
                        aria-hidden
                        className={`h-1.5 w-1.5 rounded-full ${l.onLinkedIn === l.openings.length ? "bg-brand" : "bg-warn"}`}
                      />
                      LinkedIn:{" "}
                      <span className="tabular font-medium">
                        {l.onLinkedIn} of {l.openings.length}
                      </span>{" "}
                      on
                      {l.noLink > 0 && <span className="text-warn">· {l.noLink} no link</span>}
                      {l.openings.length - l.onLinkedIn - l.noLink > 0 && (
                        <span>· {l.openings.length - l.onLinkedIn - l.noLink} not posted</span>
                      )}
                    </p>
                  )}
                </div>
                <div className="flex gap-7 text-right">
                  {[
                    { n: l.inPipeline, label: "In pipeline" },
                    { n: l.cvsToday, label: "CVs today", warn: l.cvsToday < 10 && l.openings.length > 0 },
                    { n: l.sets, label: "Sets" },
                    { n: l.alerts, label: "Alerts", warn: l.alerts > 3 },
                  ].map((s) => (
                    <div key={s.label}>
                      <div
                        className={`tabular text-[15px] font-semibold leading-none ${s.warn ? "text-danger" : ""}`}
                      >
                        {s.n}
                      </div>
                      <div className="mt-1.5 text-[11px] text-ink-soft">{s.label}</div>
                    </div>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </div>
        <Pager {...team.pager} scroll={false} className="mt-4" />
      </section>

      <div className="grid gap-8 lg:grid-cols-2">
        <section>
          <h2 className="mb-3.5 text-[13px] font-semibold">Needs a decision</h2>
          <div className="overflow-hidden rounded-2xl border border-rule bg-surface">
            {stale.length + unassigned.length + awaitingJd.length === 0 ? (
              <p className="px-7 py-10 text-center text-[12.5px] text-ink-faint">
                {q ? "Nothing here matches that search." : "Nothing waiting on you."}
              </p>
            ) : (
              <div className="divide-y divide-rule">
                {decisions.rows.map(({ kind, o }) => kind === "unassigned" ? (
                  <Link key={`u-${o.id}`} href={`/openings/${o.id}`} className="block px-7 py-4 hover:bg-paper/60">
                    <p className="text-[13.5px]">{o.title}</p>
                    <p className="mt-0.5 text-[11.5px] text-danger">Nobody assigned</p>
                  </Link>
                ) : kind === "jd" ? (
                  <Link key={`j-${o.id}`} href={`/openings/${o.id}`} className="block px-7 py-4 hover:bg-paper/60">
                    <p className="text-[13.5px]">{o.title}</p>
                    <p className="mt-0.5 text-[11.5px] text-warn">
                      JD not approved by{" "}
                      {o.assignedTaIds.map((t) => repo.user(t)?.name).join(" or ")}
                    </p>
                  </Link>
                ) : (() => {
                  const days = o.assignedAt ? colomboDaysBetween(o.assignedAt) : 0;
                  return (
                    <Link key={`s-${o.id}`} href={`/openings/${o.id}`} className="block px-7 py-4 hover:bg-paper/60">
                      <p className="text-[13.5px]">{o.title}</p>
                      <p className="mt-0.5 text-[11.5px] text-ink-soft">
                        Day {days} against a {o.priorityTier} target of{" "}
                        {PRIORITY_TARGET[o.priorityTier].days} — close it or reassign
                      </p>
                    </Link>
                  );
                })())}
              </div>
            )}
          </div>
          <Pager {...decisions.pager} scroll={false} className="mt-4" />
        </section>

        <section>
          <div className="mb-3.5 flex items-baseline justify-between gap-3">
            <h2 className="text-[13px] font-semibold">Every open role</h2>
            {/* The roles LinkedIn applications cannot reliably reach, on their own (30 Sep). */}
            {(notOn.length > 0 || offOnly) && (
              <a
                href={liHref(!offOnly)}
                aria-current={offOnly ? "true" : undefined}
                className={`rounded-full border px-3 py-1 text-[12px] transition-colors ${
                  offOnly ? "border-warn bg-warn-soft font-medium text-warn" : "border-rule text-ink-soft hover:border-ink-faint hover:text-ink"
                }`}
              >
                {offOnly ? "Showing not on LinkedIn · show all" : `${notOn.length} not on LinkedIn`}
              </a>
            )}
          </div>
          <div className="overflow-hidden rounded-2xl border border-rule bg-surface">
            {roles.pager.total === 0 && (
              <p className="px-7 py-10 text-center text-[12.5px] text-ink-faint">
                {offOnly ? "Every open role is on LinkedIn." : q ? "No open role matches that search." : "No open roles."}
              </p>
            )}
            <div className="divide-y divide-rule">
              {roles.rows.map((o) => {
                const c = stageCounts(o.id);
                return (
                  <Link
                    key={o.id}
                    href={`/openings/${o.id}`}
                    className="flex items-center gap-4 px-7 py-3.5 hover:bg-paper/60"
                  >
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-[13px]">{o.title}</p>
                      <p className="truncate text-[11.5px] text-ink-faint">
                        {repo.client(o.clientId)?.name} ·{" "}
                        {o.assignedTaIds.length
                          ? o.assignedTaIds.map((t) => repo.user(t)?.name).filter(Boolean).join(", ")
                          : "Unassigned"}{" "}
                        · assigned {relDays(o.assignedAt)}
                      </p>
                    </div>
                    <LinkedInPill status={linked.get(o.id) ?? "no_post"} />
                    <span className="tabular shrink-0 text-[13px] text-ink-soft">
                      {(c.ai_follow_up ?? 0) + (c.ta_follow_up ?? 0)}
                    </span>
                  </Link>
                );
              })}
            </div>
          </div>
          <Pager {...roles.pager} scroll={false} className="mt-4" />
        </section>
      </div>
    </>
  );
}
