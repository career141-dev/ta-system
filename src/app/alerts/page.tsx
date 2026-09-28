import Link from "next/link";
import { repo } from "@/data/store";
import { getCurrentUser } from "@/lib/session";
import { alertsFor, computeAlerts, isWorkingDay } from "@/lib/sla";
import { inHours } from "@/lib/format";
import { primeStore } from "@/data/prime";
import { Pager } from "@/components/Pager";
import { BulkBar, RowCheck } from "@/components/BulkSelect";
import { SubmitButton } from "@/components/Submit";
import { AlertsScopeToggle } from "@/components/AlertsScopeToggle";
import { markAlertsAsRead, markAlertsAsUnread } from "@/app/actions";
import { matchesQuery, pageFrom, pageLink, slicePage } from "@/lib/paging";

const PAGE_SIZE = 25;

const KIND_LABEL: Record<string, string> = {
  low_volume: "Low volume",
  advert_quiet: "Advert quiet",
  cv_waiting: "CV waiting",
  followup_due: "Follow-up",
  stale_role: "Stale role",
  shortlist_sla: "Unscreened",
  client_review_chase: "Client chase",
  director_review_chase: "Director chase",
  review_reply_received: "Review reply",
  interview_confirmation: "Confirm attendance",
  interview_confirmation_escalation: "Escalation",
  interview_followup: "Interview follow-up",
  joining_date: "Joining date",
  opening_assigned: "Role assigned",
};

export default async function AlertsPage({
  searchParams,
}: {
  searchParams: Promise<{ all?: string; q?: string; view?: string; upage?: string; tpage?: string; hpage?: string }>;
}) {
  const sp = await searchParams;
  const { all, q = "", view } = sp;
  const currentView = view === "unread" ? "unread" : view === "read" ? "read" : "all";

  await primeStore({ allApplications: true, followUps: true });
  const user = await getCurrentUser();
  const canSwitchScope = user.role === "admin" || user.role === "ta_lead" || user.role === "director";
  const everyones = canSwitchScope && all === "1";
  const users = repo.users();

  const readIds = repo.readAlertIds(user.id);
  const rawAlerts = everyones ? computeAlerts() : alertsFor(user.id);

  const totalCount = rawAlerts.length;
  const unreadCount = rawAlerts.filter((a) => !readIds.has(a.id)).length;
  const readCount = rawAlerts.filter((a) => readIds.has(a.id)).length;

  const filteredAlerts = rawAlerts.filter((a) => {
    const isRead = readIds.has(a.id);
    if (currentView === "unread" && isRead) return false;
    if (currentView === "read" && !isRead) return false;
    return matchesQuery(
      q,
      a.detail,
      KIND_LABEL[a.kind] ?? a.kind,
      a.action,
      repo.opening(a.openingId)?.title,
      ...a.assignedTo.map((t) => users.find((u) => u.id === t)?.name),
    );
  });

  const working = isWorkingDay(new Date());
  const everyDay = (k: string) => k === "followup_due" || k === "opening_assigned" || k === "review_reply_received";
  const urgent = filteredAlerts.filter((a) => a.urgent);
  const today = filteredAlerts.filter((a) => !a.urgent && (working || everyDay(a.kind)));
  const held = filteredAlerts.filter((a) => !a.urgent && !working && !everyDay(a.kind));

  const buildViewHref = (targetView: "all" | "unread" | "read") => {
    const params = new URLSearchParams();
    if (everyones) params.set("all", "1");
    if (targetView !== "all") params.set("view", targetView);
    if (q) params.set("q", q);
    const qs = params.toString();
    return qs ? `/alerts?${qs}` : "/alerts";
  };

  const renderAlertRow = (a: (typeof rawAlerts)[0], isHeld: boolean) => {
    const o = repo.opening(a.openingId);
    const isRead = readIds.has(a.id);

    return (
      <div
        key={a.id}
        className={`group flex flex-wrap items-center gap-x-4 gap-y-2 px-6 py-3.5 transition-colors ${
          isRead
            ? "bg-surface/50 border-l-[3px] border-l-transparent text-ink-soft opacity-85 hover:bg-paper/70 hover:opacity-100"
            : "bg-surface border-l-[3px] border-l-brand text-ink hover:bg-paper/40"
        }`}
      >
        <RowCheck form="bulk-alerts" name="alertId" value={a.id} label={a.detail} />
        <span
          className={`mt-0.5 h-2.5 w-2.5 shrink-0 rounded-full ${
            isRead
              ? "bg-rule-strong/70"
              : a.urgent
              ? "bg-danger shadow-xs"
              : isHeld
              ? "bg-rule-strong"
              : "bg-warn"
          }`}
          title={isRead ? "Read alert" : "Unread alert"}
        />
        <div className="min-w-[240px] flex-1">
          <div className="flex items-center gap-2">
            <p className={`text-[13.5px] leading-snug ${isRead ? "font-normal text-ink-soft" : "font-semibold text-ink"}`}>
              {a.detail}
            </p>
            {!isRead && (
              <span className="inline-block shrink-0 rounded-full bg-brand/10 px-2 py-0.5 text-[10.5px] font-semibold text-brand">
                Unread
              </span>
            )}
          </div>
          <p className={`mt-1 text-[11.5px] ${isRead ? "text-ink-faint font-normal" : "text-ink-soft font-medium"}`}>
            <span>{KIND_LABEL[a.kind] ?? a.kind}</span>
            {o && ` · ${o.title}`}
            {everyones &&
              ` · ${a.assignedTo.map((t) => users.find((u) => u.id === t)?.name).filter(Boolean).join(", ")}`}
          </p>
        </div>
        <span className={`tabular shrink-0 text-[12px] ${isRead ? "text-ink-faint font-normal" : "text-ink-soft font-medium"}`}>
          {inHours(a.dueAt)}
        </span>
        <div className="flex items-center gap-2 shrink-0">
          <form action={isRead ? markAlertsAsUnread : markAlertsAsRead} className="inline-flex">
            <input type="hidden" name="alertId" value={a.id} />
            <SubmitButton
              tone="dark"
              className="shrink-0 rounded-full border border-rule bg-surface px-2.5 py-1 text-[11.5px] font-medium text-ink-soft transition-colors hover:border-rule-strong hover:bg-tag hover:text-ink"
              pendingLabel="Updating…"
            >
              {isRead ? "Mark unread" : "Mark read"}
            </SubmitButton>
          </form>
          <Link
            href={a.href}
            className={`shrink-0 rounded-full px-3.5 py-1.5 text-[12.5px] font-medium transition-colors ${
              isRead
                ? "border border-rule text-ink-soft hover:bg-paper hover:text-ink"
                : "border border-brand-line bg-brand-soft/30 text-brand hover:bg-brand hover:text-white"
            }`}
          >
            {a.action}
          </Link>
        </div>
      </div>
    );
  };

  const group = (title: string, sub: string, every: typeof rawAlerts, isHeld: boolean, key: string) => {
    const page = pageFrom(sp, every.length, PAGE_SIZE, key);
    const items = slicePage(every, page, PAGE_SIZE);
    return (
      <section className="mb-7">
        <div className="mb-3 flex flex-wrap items-baseline justify-between gap-3">
          <h2 className="text-[13.5px] font-semibold">{title}</h2>
          <span className="text-[12px] text-ink-faint">{sub}</span>
        </div>
        <div className="overflow-hidden rounded-2xl border border-rule bg-surface shadow-[0_1px_2px_rgba(23,28,24,0.04)]">
          {items.length === 0 ? (
            <p className="px-7 py-10 text-center text-[12.5px] text-ink-faint">{q ? "Nothing here matches that search." : "Nothing here."}</p>
          ) : (
            <div className="divide-y divide-rule">
              {items.map((a) => renderAlertRow(a, isHeld))}
            </div>
          )}
        </div>
        <Pager page={page} pageSize={PAGE_SIZE} total={every.length} href={pageLink("/alerts", sp, key)} className="mt-4" />
      </section>
    );
  };

  return (
    <main className="mx-auto max-w-[1100px] px-8 py-9">
      <div className="mb-7 flex flex-wrap items-end justify-between gap-5">
        <div>
          <h1 className="text-[24px] font-semibold tracking-tight">Need attention</h1>
          <p className="mt-1.5 max-w-[68ch] text-[13px] leading-relaxed text-ink-soft">
            Inbox for all live alerts and task notices. Unread alerts appear in bold so you can spot what needs attention at a glance.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          {canSwitchScope && (
            <AlertsScopeToggle
              isEveryone={everyones}
              q={q}
              view={currentView}
            />
          )}
          {unreadCount > 0 && (
            <form action={markAlertsAsRead} className="inline-flex">
              <input type="hidden" name="all" value="true" />
              <input type="hidden" name="isEveryone" value={everyones ? "true" : "false"} />
              <SubmitButton
                tone="dark"
                className="rounded-full border border-rule bg-surface px-3.5 py-1.5 text-[12.5px] font-medium text-ink-soft transition-colors hover:border-rule-strong hover:bg-tag hover:text-ink"
                pendingLabel="Marking all…"
              >
                Mark all as read
              </SubmitButton>
            </form>
          )}
        </div>
      </div>

      <div className="mb-6 flex items-center justify-between border-b border-rule pb-3">
        <div className="flex items-center gap-2">
          <Link
            href={buildViewHref("all")}
            className={`inline-flex items-center gap-1.5 rounded-full px-3.5 py-1.5 text-[13px] font-medium transition-colors ${
              currentView === "all"
                ? "bg-navactive text-white shadow-xs"
                : "text-ink-soft hover:bg-paper hover:text-ink"
            }`}
          >
            <span>All</span>
            <span className={`tabular text-[11px] rounded-full px-1.5 py-0.2 ${currentView === "all" ? "bg-white/20 text-white" : "bg-tag text-ink-soft"}`}>
              {totalCount}
            </span>
          </Link>
          <Link
            href={buildViewHref("unread")}
            className={`inline-flex items-center gap-1.5 rounded-full px-3.5 py-1.5 text-[13px] font-medium transition-colors ${
              currentView === "unread"
                ? "bg-navactive text-white shadow-xs"
                : "text-ink-soft hover:bg-paper hover:text-ink"
            }`}
          >
            <span>Unread</span>
            <span className={`tabular text-[11px] rounded-full px-1.5 py-0.2 ${currentView === "unread" ? "bg-white/20 text-white" : "bg-tag text-ink-soft"}`}>
              {unreadCount}
            </span>
          </Link>
          <Link
            href={buildViewHref("read")}
            className={`inline-flex items-center gap-1.5 rounded-full px-3.5 py-1.5 text-[13px] font-medium transition-colors ${
              currentView === "read"
                ? "bg-navactive text-white shadow-xs"
                : "text-ink-soft hover:bg-paper hover:text-ink"
            }`}
          >
            <span>Read</span>
            <span className={`tabular text-[11px] rounded-full px-1.5 py-0.2 ${currentView === "read" ? "bg-white/20 text-white" : "bg-tag text-ink-soft"}`}>
              {readCount}
            </span>
          </Link>
        </div>
      </div>

      <BulkBar form="bulk-alerts" noun={["alert", "alerts"]} action={markAlertsAsRead}>
        <SubmitButton
          formAction={markAlertsAsRead}
          className="inline-flex items-center gap-1.5 rounded-full border border-brand bg-brand px-3.5 py-1.5 text-[12.5px] font-medium text-white transition-colors hover:bg-brand-strong"
          pendingLabel="Marking…"
        >
          Mark as read
        </SubmitButton>
        <SubmitButton
          formAction={markAlertsAsUnread}
          tone="dark"
          className="inline-flex items-center gap-1.5 rounded-full border border-rule bg-surface px-3.5 py-1.5 text-[12.5px] font-medium text-ink transition-colors hover:bg-tag hover:border-rule-strong"
          pendingLabel="Marking…"
        >
          Mark as unread
        </SubmitButton>
      </BulkBar>

      {filteredAlerts.length === 0 ? (
        <div className="rounded-2xl border border-rule bg-surface p-12 text-center">
          <p className="text-[14px] font-medium text-ink">
            {q
              ? "No alerts match your search."
              : currentView === "unread"
              ? "You have no unread alerts. You're all caught up!"
              : currentView === "read"
              ? "No alerts marked as read yet."
              : "No alerts at the moment."}
          </p>
          <p className="mt-1.5 text-[12.5px] text-ink-soft">
            {q
              ? "Try clearing the search query."
              : currentView === "unread" && totalCount > 0
              ? `You have ${totalCount} total alert${totalCount === 1 ? "" : "s"} in history.`
              : "Everything is up to date."}
          </p>
          {currentView === "unread" && totalCount > 0 && !q && (
            <Link
              href={buildViewHref("all")}
              className="mt-4 inline-block rounded-full border border-rule px-4 py-1.5 text-[12.5px] font-medium text-ink-soft transition-colors hover:bg-tag hover:text-ink"
            >
              View all {totalCount} alerts
            </Link>
          )}
        </div>
      ) : (
        <>
          {group("Urgent", "Any day, including weekends", urgent, false, "upage")}
          {group("Today", working ? "Everything routine" : "Follow-up runs at weekends too", today, false, "tpage")}
          {!working && held.length > 0 && group("Next working day", "Routine desk work, held over the weekend", held, true, "hpage")}
        </>
      )}
    </main>
  );
}
