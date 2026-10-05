import Link from "next/link";
import { repo } from "@/data/store";
import { pageUser } from "@/lib/session";
import { channelStates, liveIntakeEnabled } from "@/lib/ingest";
import { PageHead, Card, Empty } from "@/components/ui";
import { inHours } from "@/lib/format";
import { dropIntake } from "@/app/actions";
import { SubmitButton } from "@/components/Submit";
import type { IntakeItem, IntakeStatus } from "@/data/types";
import { primeStore } from "@/data/prime";
import { Pager } from "@/components/Pager";
import { PlaceUnmatched } from "@/components/PlaceUnmatched";
import { isConvex } from "@/data/mode";
import { unmatchedCvs, type UnmatchedCv } from "@/data/convex/backend";
import { isDeskWide } from "@/lib/auth";
import { matchesQuery, pageFrom, pageLink, slicePage } from "@/lib/paging";

const PAGE_SIZE = 25;

/**
 * The CV queue — everything that has arrived and has not yet been let in.
 *
 * The live system has no screen like this because it has nothing to show: a CV
 * arrives, extraction runs, `createCandidate` either merges it into somebody or
 * writes a new row, and the only record of the ones it got wrong is a line in a
 * console nobody reads. Here the file sits in front of a person first, with
 * what was read out of it and what the identity check made of it, and it stays
 * on this page until somebody decides.
 */

const STATUS_LABEL: Record<IntakeStatus, string> = {
  received: "Received",
  parsed: "Read",
  ready: "Ready",
  needs_review: "Needs a look",
  admitted: "Admitted",
  merged: "Merged",
  rejected: "Not a candidate",
};

const SOURCE_LABEL: Record<string, string> = {
  email: "Mailbox",
  whatsapp: "WhatsApp",
  upload: "Uploaded",
  extension: "LinkedIn",
  portal: "Job board",
};

function Dot({ item }: { item: IntakeItem }) {
  const tone =
    item.status === "needs_review"
      ? "bg-warn"
      : item.status === "rejected"
        ? "bg-rule-strong"
        : item.status === "admitted" || item.status === "merged"
          ? "bg-brand"
          : "bg-ink-faint";
  return <span className={`h-2 w-2 shrink-0 rounded-full ${tone}`} />;
}

function Row({ item, routeTarget }: { item: IntakeItem; routeTarget: string | null }) {
  const p = item.parsed;
  const settled = item.status === "admitted" || item.status === "merged" || item.status === "rejected";
  return (
    <Link
      href={`/intake/${item.id}`}
      className="flex flex-wrap items-center gap-x-5 gap-y-1.5 px-7 py-4 hover:bg-paper"
    >
      <Dot item={item} />
      <div className="min-w-[190px] flex-1">
        <div className="text-[13.5px] font-medium">
          {p?.fullName ?? <span className="text-ink-faint">Name not readable</span>}
        </div>
        <div className="mt-0.5 truncate text-[12px] text-ink-soft">
          {[p?.currentTitle, p?.currentEmployer].filter(Boolean).join(" · ") || item.fileName}
        </div>
      </div>

      <span className="w-[86px] shrink-0 text-[12px] text-ink-soft">
        {SOURCE_LABEL[item.source] ?? item.source}
      </span>

      {/* Where the address and the headline sent it. The whole point of the
          per-TA mailbox is that this column is filled in before anybody has
          touched the row. */}
      <span className="w-[168px] shrink-0 text-[12px]">
        {routeTarget ? (
          <span className="text-ink-soft">
            {routeTarget}
            {item.routeConfidence === "partial" && (
              <span className="text-warn"> · close match</span>
            )}
          </span>
        ) : item.routedToTaId ? (
          <span className="text-warn">no job matched</span>
        ) : (
          <span className="text-ink-faint">unrouted</span>
        )}
      </span>

      <span className="w-[150px] shrink-0 text-[12px]">
        {item.match?.verdict === "same" && item.match.candidateName ? (
          <span className="text-ink-soft">
            Already on file — <span className="text-ink">{item.match.candidateName}</span>
          </span>
        ) : item.match?.verdict === "review" ? (
          <span className="text-warn">Possible duplicate</span>
        ) : (
          <span className="text-ink-faint">New to us</span>
        )}
      </span>

      <span
        className={`w-[104px] shrink-0 text-[12px] ${
          item.status === "needs_review" ? "font-medium text-warn" : "text-ink-soft"
        }`}
      >
        {STATUS_LABEL[item.status]}
      </span>

      <span className="tabular w-[62px] shrink-0 text-right text-[11.5px] text-ink-faint">
        {settled && item.handledAt ? inHours(item.handledAt) : inHours(item.receivedAt)}
      </span>
    </Link>
  );
}

export default async function IntakePage({
  searchParams,
}: {
  searchParams: Promise<{ msg?: string; all?: string; q?: string; rpage?: string; wpage?: string; hpage?: string }>;
}) {
  const sp = await searchParams;
  const { all, q = "" } = sp;
  await primeStore({ allApplications: true });
  const user = await pageUser("intake.handle");
  // The header search, on this page, narrows the queue: the name read off the
  // CV, the role, the employer, the file, or where it came from.
  const items = repo.intake().filter((i) =>
    matchesQuery(
      q,
      i.parsed?.fullName,
      i.parsed?.currentTitle,
      i.parsed?.currentEmployer,
      i.fileName,
      SOURCE_LABEL[i.source] ?? i.source,
      i.match?.candidateName,
    ),
  );
  // Mailbox CVs no post claimed: in the database, seen by no TA (24 September).
  // A lead places them; a TA's view is their own posts, so it is not theirs.
  let unmatched: UnmatchedCv[] | null = null;
  let unmatchedProblem: string | null = null;
  if (isDeskWide(user) && isConvex()) {
    try {
      unmatched = await unmatchedCvs(14);
    } catch (e) {
      unmatchedProblem = (e as Error).message;
    }
  }
  const counts = repo.intakeCounts();
  const states = channelStates();
  const openings = repo.openings().filter((o) => o.status === "open");

  // The advert each unmatched CV can be placed on: every live or draft post of
  // an open opening, so the post's TA sees them; the opening alone if it has none.
  const placeTargets = openings.flatMap((o) => {
    const client = repo.client(o.clientId)?.name;
    const head = `${o.title}${client ? ` — ${client}` : ""}`;
    const posts = repo.jobPosts().filter((p) => p.openingId === o.id && (p.status === "live" || p.status === "draft"));
    if (posts.length === 0) return [{ value: o.id, label: head }];
    return posts.map((p) => ({
      value: `${o.id}:${p.id}`,
      label: `${head} · ${p.title}${p.country || p.city ? ` (${[p.city, p.country].filter(Boolean).join(", ")})` : ""}`,
    }));
  });

  const waiting = items.filter((i) => i.status !== "admitted" && i.status !== "merged" && i.status !== "rejected");
  const review = waiting.filter((i) => i.status === "needs_review");
  const ready = waiting.filter((i) => i.status !== "needs_review");
  const done = items.filter((i) => !waiting.includes(i));

  /** "Brand Manager" — the advert it landed on, or the opening when the advert
   *  could not be pinned down. */
  const routeTarget = (i: IntakeItem): string | null => {
    if (i.jobPostId) return repo.jobPosts().find((p) => p.id === i.jobPostId)?.title ?? null;
    if (i.openingId) return repo.opening(i.openingId)?.title ?? null;
    return null;
  };

  const section = (title: string, sub: string, every: IntakeItem[], emptyText: string, key: string) => {
    const page = pageFrom(sp, every.length, PAGE_SIZE, key);
    const rows = slicePage(every, page, PAGE_SIZE);
    return (
    <section className="mb-7">
      <div className="mb-3 flex flex-wrap items-baseline justify-between gap-3">
        <h2 className="text-[13.5px] font-semibold">{title}</h2>
        <span className="text-[12px] text-ink-faint">{sub}</span>
      </div>
      <Card className="overflow-hidden shadow-[0_1px_2px_rgba(23,28,24,0.04)]">
        {rows.length === 0 ? (
          <Empty>{q ? "Nothing here matches that search." : emptyText}</Empty>
        ) : (
          <div className="divide-y divide-rule">
            {rows.map((i) => (
              <Row key={i.id} item={i} routeTarget={routeTarget(i)} />
            ))}
          </div>
        )}
      </Card>
      <Pager page={page} pageSize={PAGE_SIZE} total={every.length} href={pageLink("/intake", sp, key)} className="mt-4" />
    </section>
    );
  };

  return (
    <main className="mx-auto max-w-[1120px] px-4 sm:px-8 py-7">
      <PageHead
        title="CV intake"
        sub={`${waiting.length} waiting · ${counts.needs_review} need a second look`}
      />


      {(unmatched || unmatchedProblem) && (
        <section className="mb-7">
          <div className="mb-3 flex flex-wrap items-baseline justify-between gap-3">
            <h2 className="text-[13.5px] font-semibold">Mailbox CVs that matched no job</h2>
            <span className="text-[12px] text-ink-faint">
              Last 14 days · no TA sees these until they are placed
            </span>
          </div>
          <Card className="overflow-hidden shadow-[0_1px_2px_rgba(23,28,24,0.04)]">
            {unmatchedProblem ? (
              <Empty>Could not load them: {unmatchedProblem}</Empty>
            ) : unmatched!.length === 0 ? (
              <Empty>Every mailbox CV found its job.</Empty>
            ) : (
              <div className="divide-y divide-rule">
                {unmatched!.map((u) => (
                  <div key={u.candidateId} className="flex flex-wrap items-center gap-x-5 gap-y-2 px-7 py-4">
                    <div className="min-w-[190px] flex-1">
                      <Link href={`/candidates/${u.candidateId}`} className="text-[13.5px] font-medium hover:underline">
                        {u.name ?? "Name not readable"}
                      </Link>
                      <div className="mt-0.5 truncate text-[12px] text-ink-soft">
                        {u.subject ?? "No subject kept"}
                      </div>
                    </div>
                    <span className="w-[86px] shrink-0 text-[12px] text-ink-soft">
                      {u.source === "linkedin" ? "LinkedIn" : u.source === "email_campaign" ? "Campaign" : "Mailbox"}
                    </span>
                    <span className="tabular w-[62px] shrink-0 text-right text-[11.5px] text-ink-faint">
                      {inHours(u.receivedAt)}
                    </span>
                    <PlaceUnmatched candidateId={u.candidateId} targets={placeTargets} />
                  </div>
                ))}
              </div>
            )}
          </Card>
        </section>
      )}

      {/* The switch, said plainly rather than hidden in a settings page. */}
      <Card className="mb-7 overflow-hidden">
        <div className="flex flex-wrap items-baseline justify-between gap-3 border-b border-rule px-5 py-3">
          <h2 className="text-[13px] font-semibold">Where CVs come in from</h2>
          <span
            className={`rounded px-1.5 py-0.5 text-[11px] font-medium ${
              liveIntakeEnabled() ? "bg-brand/10 text-brand" : "bg-paper text-ink-soft"
            }`}
          >
            {liveIntakeEnabled() ? "Live intake on" : "Live intake off"}
          </span>
        </div>
        <div className="divide-y divide-rule">
          {states.map((s) => (
            <div key={s.channel.source} className="flex flex-wrap items-baseline gap-x-4 gap-y-1 px-5 py-2.5">
              <span className="w-[126px] shrink-0 text-[12.5px] font-medium">{s.channel.label}</span>
              <span
                className={`w-[58px] shrink-0 text-[11.5px] font-medium ${
                  s.open ? "text-brand" : "text-ink-faint"
                }`}
              >
                {s.open ? "Open" : "Off"}
              </span>
              <span className="flex-1 text-[12px] text-ink-soft">
                {s.channel.detail} <span className="text-ink-faint">{s.why}</span>
              </span>
            </div>
          ))}
        </div>
        <p className="border-t border-rule px-5 py-2.5 text-[11.5px] text-ink-faint">
          The three external channels are built and switched off. Turning them on pulls real
          candidates&rsquo; CVs into this build, so it takes an environment variable and a deploy
          rather than a button on this page.
        </p>
      </Card>

      {section(
        "Needs a second look",
        "The identity check found something it will not decide on its own",
        review,
        "Nothing waiting on a person.",
        "rpage",
      )}
      {section("Waiting", "Read and checked, ready to be admitted", ready, "The queue is empty.", "wpage")}
      {all === "1"
        ? section("Handled", `${done.length} settled`, done, "Nothing handled yet.", "hpage")
        : done.length > 0 && (
            <p className="mb-7 text-[12.5px] text-ink-soft">
              {done.length} already handled.{" "}
              <Link href={`/intake?all=1${q ? `&q=${encodeURIComponent(q)}` : ""}`} className="underline underline-offset-2">
                Show them
              </Link>
            </p>
          )}

      <section>
        <h2 className="mb-3 text-[13.5px] font-semibold">Add one by hand</h2>
        <Card className="p-5">
          <form action={dropIntake} className="grid gap-3">
            <div className="grid grid-cols-[minmax(0,1fr)] gap-3 sm:grid-cols-2">
              <label className="block">
                <span className="mb-1 block text-[11px] uppercase tracking-[0.08em] text-ink-faint">
                  File name
                </span>
                <input
                  name="fileName"
                  placeholder="Nimal Perera CV.pdf"
                  className="w-full rounded border border-rule bg-paper px-2.5 py-1.5 text-[13px]"
                />
              </label>
              <label className="block">
                <span className="mb-1 block text-[11px] uppercase tracking-[0.08em] text-ink-faint">
                  Against an opening
                </span>
                <select
                  name="openingId"
                  className="w-full rounded border border-rule bg-paper px-2.5 py-1.5 text-[13px]"
                >
                  <option value="">None yet</option>
                  {openings.map((o) => (
                    <option key={o.id} value={o.id}>
                      {o.title}
                    </option>
                  ))}
                </select>
              </label>
            </div>
            <label className="block">
              <span className="mb-1 block text-[11px] uppercase tracking-[0.08em] text-ink-faint">
                CV text
              </span>
              <textarea
                name="rawText"
                rows={7}
                placeholder={"Paste the text of the CV here.\n\nIt is read for a name, contact details, current role and education — and checked against everybody already on the database — before anything is written."}
                className="w-full rounded border border-rule bg-paper px-2.5 py-2 font-mono text-[12px] leading-relaxed"
              />
            </label>
            <div>
              <SubmitButton
                pendingLabel="Reading…"
                className="rounded bg-ink px-3.5 py-1.5 text-[12.5px] font-medium text-surface disabled:opacity-60"
              >
                Read it
              </SubmitButton>
            </div>
          </form>
        </Card>
      </section>
    </main>
  );
}
