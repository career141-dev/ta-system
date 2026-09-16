import Link from "next/link";
import { repo } from "@/data/store";
import { getCurrentUser } from "@/lib/session";
import { alertsFor, computeAlerts, isWorkingDay } from "@/lib/sla";
import { inHours } from "@/lib/format";
import { primeStore } from "@/data/prime";

const KIND_LABEL: Record<string, string> = {
  low_volume: "Low volume",
  advert_quiet: "Advert quiet",
  cv_waiting: "CV waiting",
  followup_due: "Follow-up",
  stale_role: "Stale role",
  shortlist_sla: "Unscreened",
  client_review_chase: "Client chase",
  director_review_chase: "Director chase",
  interview_confirmation: "Confirm attendance",
  interview_confirmation_escalation: "Escalation",
  interview_followup: "Interview follow-up",
  joining_date: "Joining date",
};

export default async function AlertsPage({
  searchParams,
}: {
  searchParams: Promise<{ all?: string }>;
}) {
  const { all } = await searchParams;
  await primeStore({ allApplications: true, followUps: true });
  const user = await getCurrentUser();
  const everyones = all === "1";
  const alerts = everyones ? computeAlerts() : alertsFor(user.id);
  const working = isWorkingDay(new Date());
  // Follow-up runs every day, 07:00–21:00, so its alerts are never held for a
  // working day — a weekend candidate is chased on the weekend.
  const everyDay = (k: string) => k === "followup_due";
  const urgent = alerts.filter((a) => a.urgent);
  const today = alerts.filter((a) => !a.urgent && (working || everyDay(a.kind)));
  const held = alerts.filter((a) => !a.urgent && !working && !everyDay(a.kind));
  const users = repo.users();

  const group = (title: string, sub: string, items: typeof alerts, held: boolean) => (
    <section className="mb-7">
      <div className="mb-3 flex flex-wrap items-baseline justify-between gap-3">
        <h2 className="text-[13.5px] font-semibold">{title}</h2>
        <span className="text-[12px] text-ink-faint">{sub}</span>
      </div>
      <div className="overflow-hidden rounded-2xl border border-rule bg-surface shadow-[0_1px_2px_rgba(23,28,24,0.04)]">
        {items.length === 0 ? (
          <p className="px-7 py-10 text-center text-[12.5px] text-ink-faint">Nothing here.</p>
        ) : (
          <div className="divide-y divide-rule">
            {items.map((a) => {
              const o = repo.opening(a.openingId);
              return (
                <div key={a.id} className="flex flex-wrap items-center gap-x-5 gap-y-2 px-7 py-4">
                  <span
                    className={`mt-1 h-2 w-2 shrink-0 rounded-full ${
                      a.urgent ? "bg-danger" : held ? "bg-rule-strong" : "bg-warn"
                    }`}
                  />
                  <div className="min-w-[260px] flex-1">
                    <p className="text-[13.5px] leading-snug">{a.detail}</p>
                    <p className="mt-1 text-[11.5px] text-ink-faint">
                      {KIND_LABEL[a.kind] ?? a.kind}
                      {o && ` · ${o.title}`}
                      {everyones &&
                        ` · ${a.assignedTo.map((t) => users.find((u) => u.id === t)?.name).filter(Boolean).join(", ")}`}
                    </p>
                  </div>
                  <span className="tabular shrink-0 text-[12px] text-ink-soft">
                    {inHours(a.dueAt)}
                  </span>
                  <Link
                    href={a.href}
                    className="shrink-0 rounded-full border border-brand-line px-3.5 py-1.5 text-[12.5px] font-medium text-brand transition-colors hover:bg-brand-soft"
                  >
                    {a.action}
                  </Link>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </section>
  );

  return (
    <main className="mx-auto max-w-[1100px] px-8 py-9">
      <div className="mb-7 flex flex-wrap items-end justify-between gap-5">
        <div>
          <h1 className="text-[24px] font-semibold tracking-tight">Need attention</h1>
          <p className="mt-1.5 max-w-[68ch] text-[13px] leading-relaxed text-ink-soft">
            Worked out from the records each time you open this page, so nothing here is
            yesterday&rsquo;s problem. Alerts are shown here only — nothing is sent to your phone
            or inbox yet.
          </p>
        </div>
        {(user.role === "ta_lead" || user.role === "director" || user.role === "admin") && (
          <Link
            href={everyones ? "/alerts" : "/alerts?all=1"}
            className="rounded-full border border-rule-strong px-4 py-2 text-[12.5px] font-medium text-ink transition-colors hover:border-ink-faint"
          >
            {everyones ? "Just mine" : "Everyone's"}
          </Link>
        )}
      </div>

      {group("Urgent", "Any day, including weekends", urgent, false)}
      {group("Today", working ? "Everything routine" : "Follow-up runs at weekends too", today, false)}
      {!working && held.length > 0 && group("Next working day", "Routine desk work, held over the weekend", held, true)}
    </main>
  );
}
