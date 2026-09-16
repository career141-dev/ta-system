import Link from "next/link";
import { repo, stageCounts, setsForOpening } from "@/data/store";
import { getCurrentUser } from "@/lib/session";
import { isDeskWide } from "@/lib/auth";
import { StatusMenu, type OpeningStatus } from "@/components/StatusMenu";
import { PRIORITY_TARGET } from "@/data/types";
import { computeAlerts } from "@/lib/sla";
import { relDays } from "@/lib/format";
import { SearchIcon } from "@/components/icons";
import { primeStore } from "@/data/prime";
import { Pager } from "@/components/Pager";
import { matchesQuery, pageFrom, pageLink, slicePage } from "@/lib/paging";

const PAGE_SIZE = 20;

const BUCKETS = [
  { key: "mine", label: "My openings" },
  { key: "all", label: "All active" },
  { key: "hold", label: "On hold" },
  { key: "closed", label: "Closed" },
];

export default async function OpeningsPage({
  searchParams,
}: {
  searchParams: Promise<{ bucket?: string; q?: string; page?: string }>;
}) {
  const sp = await searchParams;
  const { bucket = "mine", q = "" } = sp;
  await primeStore({ allApplications: true });
  const user = await getCurrentUser();
  const clients = repo.clients();
  const users = repo.users();
  const mine = repo.openingsForUser(user);
  // "All" is the desk's list for someone who reviews the desk, and their own
  // list for anyone else — a list of roles they cannot open is no use to them.
  const all = isDeskWide(user) ? repo.openings() : mine;
  const liveAlerts = computeAlerts();

  let list =
    bucket === "mine"
      ? mine.filter((o) => o.status === "open")
      : bucket === "hold"
        ? all.filter((o) => o.status === "on_hold")
        : bucket === "closed"
          ? all.filter((o) => ["closed", "filled"].includes(o.status))
          : all.filter((o) => o.status === "open");

  if (q) {
    list = list.filter((o) => {
      const client = clients.find((c) => c.id === o.clientId);
      return matchesQuery(q, o.title, client?.name, o.locations.join(" "));
    });
  }
  const total = list.length;
  const page = pageFrom(sp, total, PAGE_SIZE);
  list = slicePage(list, page, PAGE_SIZE);

  const counts = {
    mine: mine.filter((o) => o.status === "open").length,
    all: all.filter((o) => o.status === "open").length,
    hold: all.filter((o) => o.status === "on_hold").length,
    closed: all.filter((o) => ["closed", "filled"].includes(o.status)).length,
  } as Record<string, number>;

  return (
    <main className="mx-auto max-w-[1180px] px-8 py-9">
      <div className="mb-7 flex items-end justify-between gap-6">
        <div>
          <h1 className="text-[24px] font-semibold tracking-tight">Openings</h1>
          <p className="mt-1.5 text-[13px] text-ink-soft">
            One commercial requirement, many posts, one candidate pool.
          </p>
        </div>
        <Link
          href="/openings/new"
          className="rounded-full bg-brand px-4 py-2 text-[13px] font-medium text-white hover:opacity-90"
        >
          New opening
        </Link>
      </div>

      <div className="mb-6 flex flex-wrap items-center gap-3">
        <div className="flex gap-1.5">
          {BUCKETS.map((b) => (
            <Link
              key={b.key}
              href={`/openings?bucket=${b.key}`}
              className={`rounded-full border px-3.5 py-1.5 text-[12.5px] transition-colors ${
                b.key === bucket
                  ? "border-navactive bg-navactive text-white"
                  : "border-rule bg-surface text-ink-soft hover:border-rule-strong hover:text-ink"
              }`}
            >
              {b.label}
              <span className={`tabular ml-1.5 ${b.key === bucket ? "text-white/60" : "text-ink-faint"}`}>
                {counts[b.key]}
              </span>
            </Link>
          ))}
        </div>
        <form method="GET" action="/openings" className="relative ml-auto">
          <input type="hidden" name="bucket" value={bucket} />
          <span className="pointer-events-none absolute left-3.5 top-1/2 -translate-y-1/2 text-ink-faint"><SearchIcon /></span>
          <input
            name="q"
            defaultValue={q}
            placeholder="Search openings"
            className="w-[260px] rounded-full border border-rule bg-surface py-2 pl-9 pr-4 text-[13px] outline-none placeholder:text-ink-faint focus:border-brand-line"
          />
        </form>
      </div>

      {list.length === 0 ? (
        <div className="rounded-xl border border-rule bg-surface px-8 py-20 text-center">
          <p className="text-[13.5px] text-ink-soft">Nothing in this bucket.</p>
          <p className="mt-1.5 text-[12.5px] text-ink-faint">
            {q ? "No opening matches that search." : "Openings appear here once a TA is assigned."}
          </p>
        </div>
      ) : (
        <div className="flex flex-col gap-4">
          {list.map((o) => {
            const client = clients.find((c) => c.id === o.clientId);
            const c = stageCounts(o.id);
            // Each TA numbers their own sets, so the footer speaks for the TA
            // reading it, or for the whole opening on a desk-wide screen.
            const sets = setsForOpening(o.id, isDeskWide(user) ? undefined : user.id);
            const openSets = sets.filter((s) => s.status === "open");
            const posts = repo.jobPosts(o.id);
            const live = posts.filter((p) => p.status === "live");
            const cvsToday = live.reduce((n, p) => n + p.cvCountToday, 0);
            const days = Math.floor((Date.now() - (o.assignedAt ?? Date.now())) / 86_400_000);
            const target = PRIORITY_TARGET[o.priorityTier].days;
            const urgent = liveAlerts.filter((a) => a.openingId === o.id && a.urgent).length;

            return (
              // The row stays clickable through a stretched link rather than
              // wrapping everything, so the status control inside it is a real
              // control and not a button nested in an anchor — finding 07.
              <div
                key={o.id}
                className="relative rounded-xl border border-rule bg-surface px-7 py-5 transition-colors hover:border-rule-strong"
              >
                <Link
                  href={`/openings/${o.id}`}
                  aria-label={`${client?.name ?? ""} — ${o.title}`}
                  className="absolute inset-0 z-0 rounded-xl"
                />
                <div className="pointer-events-none relative flex flex-wrap items-start justify-between gap-5">
                  <div className="min-w-0">
                    <p className="text-[12px] text-ink-faint">{client?.name}</p>
                    <div className="mt-0.5 flex flex-wrap items-center gap-2.5">
                      <span className="text-[16px] font-semibold tracking-tight">{o.title}</span>
                      <span className="rounded border border-rule px-1.5 py-px text-[11px] text-ink-soft">
                        {o.priorityTier}
                      </span>
                      <span className="pointer-events-auto relative z-10">
                        <StatusMenu openingId={o.id} status={o.status as OpeningStatus} size="small" />
                      </span>
                      {o.targetNationalities.length > 0 && (
                        <span className="text-[11.5px] text-ink-faint">
                          {o.targetNationalities.join(", ")} only
                        </span>
                      )}
                    </div>
                    <p className="mt-1.5 text-[12.5px] text-ink-soft">
                      {o.locations.join(", ")} · {posts.length} {posts.length === 1 ? "post" : "posts"} ·{" "}
                      {o.assignedTaIds.map((t) => users.find((u) => u.id === t)?.name).join(", ")}
                    </p>
                  </div>

                  <div className="flex shrink-0 gap-8 text-right">
                    {[
                      { n: c.follow_up ?? 0, l: "Follow-up" },
                      { n: c.director_review ?? 0, l: "Director" },
                      { n: cvsToday, l: "CVs today" },
                      {
                        n: `${days}/${target}`,
                        l: "Days",
                        warn: days > target,
                      },
                    ].map((s) => (
                      <div key={s.l}>
                        <div
                          className={`tabular text-[17px] font-semibold leading-none ${
                            s.warn ? "text-danger" : ""
                          }`}
                        >
                          {s.n}
                        </div>
                        <div className="mt-1.5 text-[11.5px] text-ink-soft">{s.l}</div>
                      </div>
                    ))}
                  </div>
                </div>

                <div className="pointer-events-none relative mt-4 flex flex-wrap items-center gap-x-5 gap-y-2 border-t border-rule pt-3.5 text-[12px] text-ink-faint">
                  <span>
                    {sets.filter((s) => s.status === "closed").length} sets closed
                    {openSets.map((s) =>
                      ` · ${isDeskWide(user) ? `${users.find((u) => u.id === s.taId)?.name ?? "TA"}'s` : "your"} set ${s.setNumber} has ${s.count}`,
                    ).join("")}
                  </span>
                  <span>Assigned {relDays(o.assignedAt)}</span>
                  {o.jdStatus === "pending_ta_approval" && (
                    <span className="text-warn">JD waiting for approval</span>
                  )}
                  {urgent > 0 && <span className="text-danger">{urgent} urgent</span>}
                </div>
              </div>
            );
          })}
        </div>
      )}
      <Pager page={page} pageSize={PAGE_SIZE} total={total} href={pageLink("/openings", sp)} className="mt-6" />
    </main>
  );
}
