import Link from "next/link";
import { pageUser } from "@/lib/session";
import { isConvex } from "@/data/mode";
import { primeStore } from "@/data/prime";
import { repo } from "@/data/store";
import { mailIntakeStatus, type MailIntakeStatus } from "@/data/convex/backend";
import { setMailboxEnabled, syncMailboxNow } from "@/app/actions";
import { SubmitButton } from "@/components/Submit";
import { AutoRefresh } from "./AutoRefresh";

/**
 * Settings — the admin panel's switches for the platform's background work.
 *
 * One tab so far: Mailboxes, the shared inboxes (linkedin@, cv@, job@) the TA
 * System reads CVs from, and each TA's own mailbox, read only for scoops. Admins only (user.manage), the same as People and roles.
 */
const TABS = [{ id: "mailboxes", label: "Mailboxes" }] as const;

const OUTCOME: Record<NonNullable<MailIntakeStatus["recent"][number]["outcome"]>, { label: string; tone: string }> = {
  filed: { label: "Filed to opening", tone: "bg-brand-soft text-brand" },
  database: { label: "To database", tone: "bg-accent-soft text-accent" },
  duplicate: { label: "Already held", tone: "bg-tag text-ink-soft" },
  no_cv: { label: "No CV", tone: "bg-tag text-ink-soft" },
  skipped: { label: "Not an application", tone: "bg-tag text-ink-faint" },
  failed: { label: "Failed", tone: "bg-danger-soft text-danger" },
};

const STATUS_LABEL = { waiting: "Waiting", processing: "Reading", extracting: "Reading CV" } as const;

function when(ts: number | null): string {
  if (!ts) return "never";
  const mins = Math.round((Date.now() - ts) / 60_000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins} min ago`;
  const hours = Math.round(mins / 60);
  if (hours < 48) return `${hours} h ago`;
  return new Date(ts).toLocaleDateString("en-GB", { day: "numeric", month: "short" });
}

export default async function SettingsPage({ searchParams }: { searchParams: Promise<{ tab?: string }> }) {
  await primeStore({ allApplications: true });
  await pageUser("user.manage");
  const { tab } = await searchParams;
  const active = TABS.find((t) => t.id === tab)?.id ?? "mailboxes";

  let status: MailIntakeStatus | null = null;
  let problem: string | null = null;
  if (!isConvex()) problem = "Mailboxes need the Convex backend; this build is running on the file store.";
  else {
    try {
      status = await mailIntakeStatus();
    } catch (e) {
      problem = `The mailbox status could not be read: ${(e as Error).message}`;
    }
  }
  const openings = new Map(repo.openings().map((o) => [o.id, o]));

  const mailboxCard = (m: MailIntakeStatus["mailboxes"][number]) => (
    <div key={m.mailbox} className="rounded-2xl border border-rule bg-surface p-5">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="truncate text-[14px] font-semibold">{m.taName ?? m.mailbox}</p>
          {m.taName && <p className="truncate text-[11.5px] text-ink-soft">{m.mailbox}</p>}
          <p className="mt-0.5 text-[11.5px] text-ink-faint">
            {m.enabled
              ? m.lastSyncError
                ? "Reading — last sync had a problem"
                : m.synced
                  ? `Reading · synced ${when(m.lastSyncAt)}`
                  : "Starting · the first sync is under way"
              : "Not read"}
          </p>
        </div>
        <span
          className={`shrink-0 rounded-full px-2 py-0.5 text-[11px] font-semibold ${
            !m.enabled ? "bg-tag text-ink-faint" : m.lastSyncError ? "bg-danger-soft text-danger" : "bg-brand-soft text-brand"
          }`}
        >
          {!m.enabled ? "Off" : m.lastSyncError ? "Problem" : "On"}
        </span>
      </div>

      {m.lastSyncError && (
        <p className="mt-3 rounded-lg bg-danger-soft px-3 py-2 text-[11.5px] leading-relaxed text-danger">{m.lastSyncError}</p>
      )}

      <dl className="mt-4 grid grid-cols-3 gap-y-3 text-center">
        {[
          ["Seen", m.totals.seen],
          ["Filed", m.totals.filed],
          ["Database", m.totals.database],
          ["Already held", m.totals.duplicate],
          ["No CV", m.totals.noCv + m.totals.skipped],
          ["Failed", m.totals.failed],
        ].map(([label, n]) => (
          <div key={label as string}>
            <dt className="text-[10.5px] uppercase tracking-wider text-ink-faint">{label}</dt>
            <dd className="tabular text-[17px] font-semibold">{(n as number).toLocaleString()}</dd>
          </div>
        ))}
      </dl>

      <div className="mt-4 flex items-center gap-2 border-t border-rule pt-4">
        <form action={setMailboxEnabled}>
          <input type="hidden" name="mailbox" value={m.mailbox} />
          {!m.enabled && <input type="hidden" name="enabled" value="on" />}
          <SubmitButton
            tone={m.enabled ? "dark" : "light"}
            pendingLabel={m.enabled ? "Stopping…" : "Starting…"}
            className={
              m.enabled
                ? "rounded-full border border-rule px-3.5 py-1.5 text-[12px] font-medium text-ink hover:border-ink-faint disabled:opacity-60"
                : "rounded-full bg-brand px-3.5 py-1.5 text-[12px] font-medium text-white hover:opacity-90 disabled:opacity-60"
            }
          >
            {m.enabled ? "Stop reading" : "Start reading"}
          </SubmitButton>
        </form>
        {m.enabled && (
          <form action={syncMailboxNow}>
            <input type="hidden" name="mailbox" value={m.mailbox} />
            <SubmitButton
              tone="dark"
              pendingLabel="Syncing…"
              className="rounded-full border border-brand-line px-3.5 py-1.5 text-[12px] font-medium text-brand hover:bg-brand-soft disabled:opacity-60"
            >
              Sync now
            </SubmitButton>
          </form>
        )}
      </div>
    </div>
  );

  return (
    <main className="mx-auto max-w-[1180px] px-8 py-9">
      <h1 className="text-[24px] font-semibold tracking-tight">Settings</h1>
      <p className="mt-1.5 text-[13px] text-ink-soft">The platform&rsquo;s background work. Admins only.</p>

      <nav className="mt-6 flex gap-1 border-b border-rule">
        {TABS.map((t) => (
          <Link
            key={t.id}
            href={`/settings?tab=${t.id}`}
            className={`-mb-px border-b-2 px-3.5 py-2 text-[13px] font-medium ${
              active === t.id ? "border-brand text-ink" : "border-transparent text-ink-soft hover:text-ink"
            }`}
          >
            {t.label}
          </Link>
        ))}
      </nav>

      {active === "mailboxes" && (
        <section className="mt-6">
          <div className="mb-5 flex flex-wrap items-end justify-between gap-3">
            <div>
              <h2 className="text-[16px] font-semibold">Mailboxes</h2>
              <p className="mt-1 max-w-[80ch] text-[12.5px] leading-relaxed text-ink-soft">
                CVs that arrive at these addresses come into the TA System. A CV that matches a live advert is filed to
                that opening under New CVs; anything else goes into the database. The mailboxes are only read — nothing is
                marked read, moved or replied to, so the CV platform keeps working on them as before.
              </p>
            </div>
            <AutoRefresh seconds={20} />
          </div>

          {problem && (
            <p className="mb-5 rounded-xl border border-warn/30 bg-warn-soft px-4 py-3 text-[12.5px] text-warn">{problem}</p>
          )}

          {status && (
            <>
              <div className="grid gap-4 lg:grid-cols-3">
                {status.mailboxes.filter((m) => m.kind !== "ta").map(mailboxCard)}
              </div>

              {status.mailboxes.some((m) => m.kind === "ta") && (
                <div className="mt-8">
                  <h3 className="text-[13.5px] font-semibold">TA mailboxes — scoops</h3>
                  <p className="mt-1 max-w-[80ch] text-[12.5px] leading-relaxed text-ink-soft">
                    CVs the Director, a TA Lead or Ops email to a TA are scoops. They go on that TA&rsquo;s job and are counted on
                    their end-of-day SCOOP. Only those emails are read; the rest of the TA&rsquo;s mail is never logged, marked
                    read or moved. When the email does not say which job, nothing is filed and the TA is told.
                  </p>
                  <div className="mt-4 grid gap-4 lg:grid-cols-3">{status.mailboxes.filter((m) => m.kind === "ta").map(mailboxCard)}</div>
                </div>
              )}

              <div className="mt-8 overflow-hidden rounded-2xl border border-rule bg-surface">
                <div className="flex flex-wrap items-baseline justify-between gap-2 border-b border-rule px-5 py-3">
                  <h3 className="text-[13.5px] font-semibold">Latest messages</h3>
                  <span className="text-[12px] text-ink-faint">
                    {status.queue.waiting} waiting · {status.queue.extracting} having their CV read · a message waits 20 minutes before it is filed
                  </span>
                </div>
                {status.recent.length === 0 ? (
                  <p className="px-5 py-10 text-center text-[12.5px] text-ink-soft">
                    Nothing yet. Start reading a mailbox above; only mail that arrives after that is filed.
                  </p>
                ) : (
                  <table className="w-full text-left text-[12.5px]">
                    <thead className="bg-paper/60 text-[11px] uppercase tracking-wider text-ink-faint">
                      <tr>
                        <th className="px-5 py-2 font-medium">Received</th>
                        <th className="px-3 py-2 font-medium">Message</th>
                        <th className="px-3 py-2 font-medium">Result</th>
                        <th className="px-5 py-2 font-medium">Where it went</th>
                      </tr>
                    </thead>
                    <tbody>
                      {status.recent.map((r) => {
                        const tone = r.outcome ? OUTCOME[r.outcome] : null;
                        return (
                          <tr key={r.id} className="border-t border-rule align-top">
                            <td className="whitespace-nowrap px-5 py-3 text-ink-soft">
                              {when(r.receivedAt)}
                              <span className="block text-[11px] text-ink-faint">{r.mailbox.split("@")[0]}@</span>
                            </td>
                            <td className="max-w-[360px] px-3 py-3">
                              <span className="block truncate font-medium">{r.subject || "(no subject)"}</span>
                              <span className="block truncate text-[11.5px] text-ink-faint">{r.fromAddress}</span>
                            </td>
                            <td className="whitespace-nowrap px-3 py-3">
                              <span className={`rounded-full px-2 py-0.5 text-[11px] font-semibold ${tone?.tone ?? "bg-tag text-ink-soft"}`}>
                                {tone?.label ?? STATUS_LABEL[r.status as keyof typeof STATUS_LABEL] ?? r.status}
                              </span>
                            </td>
                            <td className="px-5 py-3">
                              {r.openings.length > 0 && (
                                <span className="block">
                                  {r.openings.map((o, i) => (
                                    <span key={o.id}>
                                      {i > 0 && ", "}
                                      <Link href={`/openings/${o.id}`} className="text-accent hover:underline">
                                        {openings.get(o.id)?.title ?? o.title}
                                      </Link>
                                    </span>
                                  ))}
                                </span>
                              )}
                              {r.candidateIds.length > 0 && (
                                <span className="block text-[11.5px]">
                                  {r.candidateIds.map((c, i) => (
                                    <span key={c}>
                                      {i > 0 && " · "}
                                      <Link href={`/candidates/${c}`} className="text-accent hover:underline">
                                        Candidate{r.candidateIds.length > 1 ? ` ${i + 1}` : ""}
                                      </Link>
                                    </span>
                                  ))}
                                </span>
                              )}
                              {(r.note || r.error) && (
                                <span className={`mt-0.5 block text-[11.5px] leading-relaxed ${r.error && !r.note ? "text-danger" : "text-ink-faint"}`}>
                                  {r.note ?? r.error}
                                </span>
                              )}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                )}
              </div>
            </>
          )}
        </section>
      )}
    </main>
  );
}
