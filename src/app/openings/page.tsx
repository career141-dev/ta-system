import Link from "next/link";
import { Suspense } from "react";
import { repo, stageCounts, setsForOpening } from "@/data/store";
import { getCurrentUser } from "@/lib/session";
import { allows, isDeskWide } from "@/lib/auth";
import { seatFor, visibleToSeat } from "@/lib/visibility";
import { StatusMenu, type OpeningStatus } from "@/components/StatusMenu";
import { WorkingStageMenu } from "@/components/WorkingStageMenu";
import { OpeningMenu } from "@/components/OpeningMenu";
import { OpeningsToolbar } from "@/components/OpeningsToolbar";
import { assignableTas } from "@/lib/assignable";
import { PRIORITY_TARGET } from "@/data/types";
import { computeAlerts } from "@/lib/sla";
import { colomboDaysBetween, relDays } from "@/lib/format";
import { primeStore } from "@/data/prime";
import { Pager } from "@/components/Pager";
import { matchesQuery, pageFrom, pageLink, slicePage } from "@/lib/paging";
import { BulkBar, BulkConfirm, RowCheck } from "@/components/BulkSelect";
import { deleteOpenings } from "@/app/actions";
import { OPENING_BUCKETS, statusMatchesBucket, type OpeningBucket } from "@/lib/openingStatus";

const PAGE_SIZE = 20;

// Whole words only (review of PR #31): "male" is inside "Female", "uk" inside "Sukkur".
function toCountry(loc: string): string {
  const l = loc.trim().toLowerCase();
  if (/\b(colombo|kandy|galle|jaffna|sri lanka)\b/i.test(l)) return "Sri Lanka";
  if (/\b(karachi|lahore|islamabad|rawalpindi|pakistan)\b/i.test(l)) return "Pakistan";
  if (/\b(dhaka|chittagong|bangladesh)\b/i.test(l)) return "Bangladesh";
  if (/\b(dubai|abu dhabi|sharjah|uae|emirates)\b/i.test(l)) return "UAE";
  if (/\b(doha|qatar)\b/i.test(l)) return "Qatar";
  if (/\b(riyadh|jeddah|dammam|saudi)\b/i.test(l)) return "Saudi Arabia";
  if (/\b(male|maldives)\b/i.test(l)) return "Maldives";
  if (/\b(mumbai|delhi|bangalore|india)\b/i.test(l)) return "India";
  if (/\b(singapore)\b/i.test(l)) return "Singapore";
  if (/\b(london|uk|united kingdom)\b/i.test(l)) return "UK";
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
  const { bucket: requestedBucket = "mine", q = "", country, location = country, industry, clientId, taId } = sp;
  const bucket = OPENING_BUCKETS.some((item) => item.key === requestedBucket)
    ? requestedBucket as OpeningBucket
    : "mine";
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
  // Who may move an opening to the Bin: the same test the delete action makes.
  const mayBin = (openingId: string) =>
    allows(user, "opening.manage", { openingId, assignment: repo.assignmentFor(openingId, user.id) ?? null });

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
      ? mine.filter((o) => statusMatchesBucket(o.status, bucket))
      : bucket === "unassigned"
        ? all.filter((o) => o.status === "open" && o.assignedTaIds.length === 0)
        : all.filter((o) => statusMatchesBucket(o.status, bucket));

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
    placed: all.filter((o) => o.status === "filled").length,
    closed: all.filter((o) => o.status === "closed").length,
  } as Record<string, number>;

  const bucketItems = OPENING_BUCKETS.map((b) => ({
    key: b.key,
    label: b.label,
    count: counts[b.key] ?? 0,
  }));

  const hasActiveFilters = Boolean(location || industry || clientId || (showTaFilter && taId) || q);

  return (
    <main className="mx-auto max-w-[1180px] px-4 py-5 sm:px-8 sm:py-9">
      <div className="mb-6 flex flex-col items-stretch gap-4 sm:mb-7 sm:flex-row sm:items-end sm:justify-between sm:gap-6">
        <div className="min-w-0 pr-28 sm:pr-0">
          <h1 className="text-[22px] font-semibold leading-tight tracking-tight sm:text-[24px]">Openings</h1>
          <p className="mt-1.5 text-[13px] text-ink-soft">
            One commercial requirement, many posts, one candidate pool.
          </p>
        </div>
        <Link
          href="/openings/new"
          className="flex min-h-11 shrink-0 items-center justify-center self-start rounded-full bg-brand px-4 py-2 text-[13px] font-medium text-white active:opacity-80 sm:min-h-0 sm:self-auto sm:hover:opacity-90"
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
          {/* Delete moves to the Bin: a lead or above can tick any opening, a
              TA the openings they recruit on (28 Sep). */}
          {list.some((o) => mayBin(o.id)) && (
            <BulkBar form="bulk-openings" noun={["opening", "openings"]} action={deleteOpenings}>
              <BulkConfirm
                label="Delete"
                noun={["opening", "openings"]}
                warning="They move to the Bin and can be restored for 7 days, then are deleted for good. Their candidates are never deleted."
              />
            </BulkBar>
          )}
          {list.map((o) => {
            const client = clients.find((c) => c.id === o.clientId);
            const onStrategy = repo.strategyAssignments(o.id).some((r) => r.doneBy.includes(user.id));
            const oSeat = seatFor(user, repo.assignmentFor(o.id, user.id)?.role ?? null, onStrategy);
            const c = oSeat.ownDeskOf
              ? visibleToSeat(repo.applications(o.id), oSeat).reduce((m, a) => { m[a.stage] = (m[a.stage] ?? 0) + 1; return m; }, {} as ReturnType<typeof stageCounts>)
              : stageCounts(o.id);
            // Each TA numbers their own sets, so the footer speaks for the TA
            // reading it, or for the whole opening on a desk-wide screen.
            const sets = setsForOpening(o.id, isDeskWide(user) ? undefined : user.id);
            const openSets = sets.filter((s) => s.status === "open");
            const posts = repo.jobPosts(o.id);
            const live = posts.filter((p) => p.status === "live");
            const cvsToday = live.reduce((n, p) => n + p.cvCountToday, 0);
            const days = o.assignedAt ? colomboDaysBetween(o.assignedAt) : 0;
            const target = PRIORITY_TARGET[o.priorityTier].days;
            const urgent = liveAlerts.filter((a) => a.openingId === o.id && a.urgent).length;

            // The reader's own stage on this job (100% / Follow-up / Add-on),
            // next to the status so it can be changed without opening the job.
            // It is what the end-of-day L-sheet reports. Everyone who works
            // the job has one, not only its TAs (25 Sep).
            const canStage = allows(user, "opening.act", { assignment: repo.assignmentFor(o.id, user.id) });
            const workingStage = repo.workingStage(o.id, user.id);

            return (
              // The row stays clickable through a stretched link rather than
              // wrapping everything, so the status control inside it is a real
              // control and not a button nested in an anchor — finding 07.
              // A row with a menu open is lifted over the rows below it, or the
              // next job's status and stage buttons showed through the menu.
              <div
                key={o.id}
                className="relative rounded-xl border border-rule bg-surface px-4 py-4 transition-colors active:border-rule-strong active:bg-paper/40 sm:px-7 sm:py-5 sm:hover:border-rule-strong sm:hover:bg-surface has-[[aria-expanded=true]]:z-20"
              >
                <Link
                  href={`/openings/${o.id}`}
                  aria-label={`${client?.name ?? ""} — ${o.title}`}
                  className="absolute inset-0 z-0 rounded-xl"
                />
                <div className={`pointer-events-none relative grid grid-cols-1 gap-4 sm:flex sm:flex-wrap sm:items-start sm:justify-between sm:gap-5 ${mayBin(o.id) ? "sm:pr-9" : ""}`}>
                  <div className={`flex min-w-0 items-start gap-3 ${mayBin(o.id) ? "pr-9" : ""} sm:gap-3.5 sm:pr-0`}>
                  {mayBin(o.id) && (
                    <span className="pointer-events-auto relative z-10 -ml-1 flex min-h-11 min-w-8 items-start justify-center pt-1">
                      <RowCheck form="bulk-openings" name="openingId" value={o.id} label={o.title} />
                    </span>
                  )}
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
                      {canStage && (
                        <span className="pointer-events-auto relative z-10">
                          <WorkingStageMenu openingId={o.id} stage={workingStage} size="small" />
                        </span>
                      )}
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
                  </div>

                  <div className="grid w-full grid-cols-4 gap-1 rounded-lg bg-paper p-3 text-center sm:flex sm:w-auto sm:shrink-0 sm:items-start sm:gap-8 sm:rounded-none sm:bg-transparent sm:p-0 sm:text-right">
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
                  </div>
                  {mayBin(o.id) && (
                    <span className="pointer-events-auto absolute right-0 top-0 z-10 sm:-mr-3 sm:-mt-1">
                      <OpeningMenu openingId={o.id} title={o.title} candidates={repo.applications(o.id).length} />
                    </span>
                  )}
                </div>

                <div className="pointer-events-none relative mt-4 flex flex-wrap items-center gap-x-4 gap-y-2 border-t border-rule pt-3.5 text-[12px] text-ink-faint sm:gap-x-5">
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
