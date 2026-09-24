import Link from "next/link";
import { Suspense } from "react";
import { repo, stageCounts, setsForOpening } from "@/data/store";
import { getCurrentUser } from "@/lib/session";
import { isDeskWide } from "@/lib/auth";
import { StatusMenu, type OpeningStatus } from "@/components/StatusMenu";
import { OpeningMenu } from "@/components/OpeningMenu";
import { OpeningsToolbar } from "@/components/OpeningsToolbar";
import { assignableTas } from "@/lib/assignable";
import { PRIORITY_TARGET } from "@/data/types";
import { computeAlerts } from "@/lib/sla";
import { relDays } from "@/lib/format";
import { primeStore } from "@/data/prime";
import { Pager } from "@/components/Pager";
import { matchesQuery, pageFrom, pageLink, slicePage } from "@/lib/paging";

const PAGE_SIZE = 20;

const BUCKETS = [
  { key: "mine", label: "My openings" },
  { key: "all", label: "All active" },
  // Openings entered before anyone is free to take them (plan 4.1, 21 Sep).
  { key: "unassigned", label: "Unassigned" },
  { key: "hold", label: "On hold" },
  { key: "closed", label: "Closed" },
];

function toCountry(loc: string): string {
  const l = loc.trim().toLowerCase();
  if (/colombo|kandy|galle|jaffna|sri lanka/i.test(l)) return "Sri Lanka";
  if (/karachi|lahore|islamabad|rawalpindi|pakistan/i.test(l)) return "Pakistan";
  if (/dhaka|chittagong|bangladesh/i.test(l)) return "Bangladesh";
  if (/dubai|abu dhabi|sharjah|uae|emirates/i.test(l)) return "UAE";
  if (/doha|qatar/i.test(l)) return "Qatar";
  if (/riyadh|jeddah|dammam|saudi/i.test(l)) return "Saudi Arabia";
  if (/male|maldives/i.test(l)) return "Maldives";
  if (/mumbai|delhi|bangalore|india/i.test(l)) return "India";
  if (/singapore/i.test(l)) return "Singapore";
  if (/london|uk|united kingdom/i.test(l)) return "UK";
  return loc.trim();
}

export default async function OpeningsPage({
  searchParams,
}: {
  searchParams: Promise<{
    bucket?: string;
    q?: string;
    page?: string;
    location?: string;
    country?: string;
    industry?: string;
    clientId?: string;
    taId?: string;
  }>;
}) {
  const sp = await searchParams;
  const { bucket = "mine", q = "", country, location = country, industry, clientId, taId } = sp;
  await primeStore({ allApplications: true });
  const user = await getCurrentUser();
  const clients = repo.clients();
  const users = repo.users();
  const mine = repo.openingsForUser(user);
  // "All" is the desk's list for someone who reviews the desk, and their own
  // list for anyone else — a list of roles they cannot open is no use to them.
  const all = isDeskWide(user) ? repo.openings() : mine;
  const liveAlerts = computeAlerts();
  const showTaFilter = isDeskWide(user);

  // Extract dynamic clean country options for filters
  const locationOptions = Array.from(
    new Set(all.flatMap((o) => o.locations).map(toCountry).filter(Boolean))
  ).sort();

  const industryOptions = Array.from(
    new Set(clients.map((c) => c.industry?.trim()).filter(Boolean))
  ).sort() as string[];

  const clientOptions = clients
    .map((c) => ({ id: c.id, name: c.name }))
    .sort((a, b) => a.name.localeCompare(b.name));

  const taOptions = assignableTas(users).map((u) => ({ id: u.id, name: u.name }));

  let list =
    bucket === "mine"
      ? mine.filter((o) => o.status === "open")
      : bucket === "unassigned"
        ? all.filter((o) => o.status === "open" && o.assignedTaIds.length === 0)
        : bucket === "hold"
        ? all.filter((o) => o.status === "on_hold")
        : bucket === "closed"
          ? all.filter((o) => ["closed", "filled"].includes(o.status))
          : all.filter((o) => o.status === "open");

  // Country filter
  if (location && location !== "all") {
    list = list.filter((o) =>
      o.locations.some(
        (l) =>
          toCountry(l).toLowerCase() === location.toLowerCase() ||
          l.toLowerCase() === location.toLowerCase() ||
          l.toLowerCase().includes(location.toLowerCase())
      )
    );
  }

  // Industry filter
  if (industry && industry !== "all") {
    list = list.filter((o) => {
      const c = clients.find((client) => client.id === o.clientId);
      return c?.industry?.toLowerCase() === industry.toLowerCase();
    });
  }

  // Client filter
  if (clientId && clientId !== "all") {
    list = list.filter((o) => o.clientId === clientId);
  }

  // TA Name filter (for TA Lead, Admin, Director, Ops)
  if (showTaFilter && taId && taId !== "all") {
    list = list.filter((o) => o.assignedTaIds.includes(taId));
  }

  // Search query filter
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
    unassigned: all.filter((o) => o.status === "open" && o.assignedTaIds.length === 0).length,
    hold: all.filter((o) => o.status === "on_hold").length,
    closed: all.filter((o) => ["closed", "filled"].includes(o.status)).length,
  } as Record<string, number>;

  const bucketItems = BUCKETS.map((b) => ({
    key: b.key,
    label: b.label,
    count: counts[b.key] ?? 0,
  }));

  const hasActiveFilters = Boolean(location || industry || clientId || (showTaFilter && taId) || q);

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

      <Suspense fallback={<div className="mb-6 h-[42px]" />}>
        <OpeningsToolbar
          initialQuery={q}
          currentBucket={bucket}
          buckets={bucketItems}
          filters={{ location, industry, clientId, taId }}
          locationOptions={locationOptions}
          industryOptions={industryOptions}
          clientOptions={clientOptions}
          taOptions={taOptions}
          showTaFilter={showTaFilter}
        />
      </Suspense>

      {list.length === 0 ? (
        <div className="rounded-xl border border-rule bg-surface px-8 py-20 text-center">
          <p className="text-[13.5px] text-ink-soft">
            {hasActiveFilters ? "No opening matches the selected filters or search." : "Nothing in this bucket."}
          </p>
          <p className="mt-1.5 text-[12.5px] text-ink-faint">
            {hasActiveFilters ? (
              <Link href={`/openings?bucket=${bucket}`} className="font-medium text-brand hover:underline">
                Reset filters
              </Link>
            ) : (
              "Openings appear here once a TA is assigned."
            )}
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
                      {o.assignedTaIds.length ? (
                        o.assignedTaIds.map((t) => users.find((u) => u.id === t)?.name).join(", ")
                      ) : (
                        <span className="rounded bg-warn-soft px-1.5 py-px text-warn">Unassigned</span>
                      )}
                    </p>
                  </div>

                  <div className="flex shrink-0 items-start gap-8 text-right">
                    {[
                      { n: (c.ai_follow_up ?? 0) + (c.ta_follow_up ?? 0), l: "Follow-up" },
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
                    {isDeskWide(user) && (
                      <span className="pointer-events-auto relative z-10 -mr-3 -mt-1">
                        <OpeningMenu openingId={o.id} title={o.title} candidates={repo.applications(o.id).length} />
                      </span>
                    )}
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
