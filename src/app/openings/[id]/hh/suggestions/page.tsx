import { EmptySuggestionsReason } from "@/components/Workday";
import { notFound } from "next/navigation";
import Link from "next/link";
import { repo } from "@/data/store";
import { ProjectHeader } from "../../ProjectHeader";
import { Generate } from "@/components/hh/Generate";
import { runSuggestionsInline, keepSuggestion, dismissSuggestion } from "@/app/actions";
import { MAX_ROUNDS } from "@/lib/sourcing";
import { SuggestionName } from "@/components/hh/ProfilePanel";
import { FindCvButton } from "@/components/FindCvButton";
import { dateAt } from "@/lib/format";
import { Assistant } from "@/components/hh/Assistant";
import { getCurrentUser } from "@/lib/session";
import { ChevronIcon } from "@/components/icons";
import { scopeSuggestions } from "@/lib/visibility";
import { primeStore } from "@/data/prime";
import { Pager } from "@/components/Pager";
import { DoneBadge, SubmitButton } from "@/components/SubmitButton";
import { SubmitButton as Submit } from "@/components/Submit";
import { BUTTON } from "@/components/buttonStyles";
import { matchesQuery, pageFrom, pageLink, slicePage } from "@/lib/paging";

const PAGE_SIZE = 20;

const TIER_TONE = {
  priority: "bg-brand-soft text-brand",
  screen: "bg-tag text-ink-soft",
} as const;

/**
 * Suggestions — spec §8A.2, laid out to the Figma's Boolean-search frame.
 *
 * One list rather than two stacked sections: the tier rides on the row as a tag
 * where the Figma puts "Applicant", so a TA reads down a single column and the
 * strength of each row is a glance rather than a heading they have to scroll
 * back to.
 */
export default async function Page({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{
    err?: string; found?: string; scanned?: string; queries?: string;
    cost?: string; rejected?: string; note?: string; sort?: string; show?: string;
    q?: string; page?: string;
  }>;
}) {
  const { id } = await params;
  const sp = await searchParams;
  await primeStore({ openingId: id });
  const user = await getCurrentUser();
  const o = repo.opening(id);
  if (!o) notFound();

  // A sourcing run belongs to whoever asked for it. What crosses between two
  // TAs on one opening is a profile the other has already kept — see
  // lib/visibility for why that is the only thing that crosses.
  const scoped = scopeSuggestions(repo.suggestions(id), user);
  const takenBy = new Map(scoped.map((x) => [x.row.id, x.takenBy]));
  const userNames = Object.fromEntries(repo.users().map((u) => [u.id, u.name]));
  const all = scoped.map((x) => x.row);
  const open = all.filter((s) => s.status === "new");
  const kept = all.filter((s) => s.status === "kept");
  const dismissed = all.filter((s) => s.status === "dismissed");
  const picked = repo.benchmarks(id).filter((b) => b.isSelected);
  // Rounds are the opening's, counted from every run on it — the server counts
  // them that way, so counting only the visible ones offered a round the
  // server then refused ("works once", 21 Sep).
  const everyRun = repo.suggestions(id);
  const round = everyRun.length ? Math.max(...everyRun.map((s) => s.round)) : 0;
  const roundsLeft = Math.max(0, MAX_ROUNDS - round);
  const steered = all.filter((s) => s.status !== "new").length;

  const showing = sp.show === "kept" ? kept : sp.show === "dismissed" ? dismissed : open;
  const sort = sp.sort ?? "strength";
  const matching = [...showing].filter((s) => matchesQuery(sp.q, s.name, s.headline, s.company, s.location, s.why)).sort((a, b) =>
    sort === "recent"
      ? b.generatedAt - a.generatedAt
      : (a.tier === "priority" ? 0 : 1) - (b.tier === "priority" ? 0 : 1) || b.round - a.round,
  );
  const page = pageFrom(sp, matching.length, PAGE_SIZE);
  const rows = slicePage(matching, page, PAGE_SIZE);
  // Paging and sorting keep the tab and the search; the one-off run summary is not carried.
  const listParams = { show: sp.show, sort: sp.sort, q: sp.q, page: sp.page };

  const tab = (key: string, label: string, n: number) => {
    const active = (sp.show ?? "new") === key;
    return (
      <Link
        key={key}
        href={`?show=${key}${sp.sort ? `&sort=${sp.sort}` : ""}`}
        className={`rounded-full px-3 py-1 text-[12px] transition-colors ${
          active ? "bg-navactive font-medium text-white" : "text-ink-soft hover:bg-tag hover:text-ink"
        }`}
      >
        {label} <span className="tabular opacity-70">{n}</span>
      </Link>
    );
  };

  return (
    <>
      <h1 className="text-[21px] font-semibold tracking-tight">Suggestions</h1>
      <ProjectHeader openingId={id} />
      {scoped.length === 0 && <div className="mb-5 rounded-lg border border-rule p-4"><EmptySuggestionsReason jobId={id} /></div>}

      <Generate
        openingId={id}
        action={runSuggestionsInline}
        label={
          round === 0
            ? "Find profiles to headhunt"
            : roundsLeft === 0
              ? `All ${MAX_ROUNDS} rounds used`
              : `Refine — round ${round + 1} of ${MAX_ROUNDS}`
        }
        sub={
          round === 0
            ? "Real LinkedIn profiles for people we do not hold a CV for. This runs by itself once the JD is approved."
            : roundsLeft === 0
              ? "Three rounds is the budget for an opening. Work the list, or widen the brief and start again."
              : steered === 0
                ? "Keep or reject a few below first — a round with no feedback runs the same search again."
                : `Steered by ${steered} you have judged. Profiles already seen will not come back.`
        }
        err={sp.err}
        found={sp.found}
        needs="sourcing"
        hasResult={all.length > 0}
      />

      {sp.found !== undefined && !sp.err && (
        <p className="-mt-2 mb-5 text-[11.5px] leading-relaxed text-ink-faint">
          {sp.queries} searches · <span className="tabular">{sp.scanned}</span> profiles found ·{" "}
          {sp.rejected && sp.rejected !== "0" && (
            <><span className="tabular">{sp.rejected}</span> ruled out · </>
          )}
          <span className="tabular">{sp.found}</span> shortlisted · <span className="tabular">${sp.cost}</span>.
          Every link came back from a search result, so no profile here can be invented — the reasons
          are judged from what the open web says, not from reading the LinkedIn page.
          {sp.note?.startsWith("screen_removed_") && (
            <span className="text-warn">
              {" "}The screen ruled out most of what the searches found ({sp.note.replace("screen_removed_", "").replace("_of_", " of ")}).
              Either the searches reached the wrong people or the requirements are too narrow — check the ruled-out names before running another round.
            </span>
          )}
          {sp.note?.startsWith("only_") && (
            <span className="text-warn">
              {" "}Only {sp.found} genuinely fit. Senior and confidential roles have less public
              surface — benchmark some names on Research and they feed the next round.
            </span>
          )}
        </p>
      )}

      {picked.length > 0 && (
        <p className="mb-4 text-[12px] text-ink-soft">
          Searching against {picked.length} benchmarked{" "}
          {picked.length === 1 ? "profile" : "profiles"} — {picked.map((b) => b.name ?? b.title).join(", ")}
        </p>
      )}

      <div className="overflow-hidden rounded-xl border border-rule bg-surface">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-rule px-6 py-3.5">
          {tab("new", "To review", open.length)}
          {tab("kept", "Kept", kept.length)}
          {tab("dismissed", "Rejected", dismissed.length)}
          <Link
            href={`/openings/${id}/hh/links`}
            className="ml-auto text-[12.5px] font-medium text-accent hover:underline"
          >
            + Add a candidate
          </Link>
        </div>

        {rows.length > 0 && (
          <div className="flex items-center gap-4 border-b border-rule px-6 py-2.5">
            <span className="text-[11px] font-semibold uppercase tracking-wider text-ink-soft">
              <span className="tabular">{matching.length}</span> results
            </span>
            <Link
              href={`?show=${sp.show ?? "new"}&sort=${sort === "strength" ? "recent" : "strength"}${sp.q ? `&q=${encodeURIComponent(sp.q)}` : ""}`}
              className="ml-auto flex items-center gap-1.5 text-[12px] text-ink-soft hover:text-ink"
            >
              Sort by: {sort === "strength" ? "Strength of match" : "Most recent"}
              <ChevronIcon size={12} />
            </Link>
          </div>
        )}

        {rows.length === 0 ? (
          <p className="px-8 py-16 text-center text-[13px] leading-relaxed text-ink-faint">
            {all.length === 0
              ? "Nothing suggested yet. These are people to approach, not CVs we hold — for the database of people we do hold, use Database search."
              : sp.q && showing.length > 0
                ? "Nobody here matches that search."
                : "Nothing here. Try another tab."}
          </p>
        ) : (
          <div className="divide-y divide-rule">
            {rows.map((s) => (
              <article key={s.id} className="px-6 py-5">
                <div className="flex flex-wrap items-start gap-x-4 gap-y-3">
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                      <SuggestionName s={s} openingId={id} />
                      <span className={`rounded px-1.5 py-[3px] text-[10.5px] font-medium ${TIER_TONE[s.tier]}`}>
                        {s.tier === "priority" ? "Priority" : "Screen"}
                      </span>
                      <span className="text-[11px] text-ink-faint">round {s.round}</span>
                      {takenBy.get(s.id) && (
                        <span className="rounded bg-warn-soft px-1.5 py-[3px] text-[10.5px] font-medium text-warn">
                          Kept by {userNames[takenBy.get(s.id)!] ?? "another TA"}
                        </span>
                      )}
                    </div>
                    <p className="mt-0.5 text-[13px]">{s.headline}</p>
                    {(s.company || s.location) && (
                      <p className="mt-0.5 text-[12px] text-ink-faint">
                        {[s.company, s.location].filter(Boolean).join(" · ")}
                      </p>
                    )}
                    {/* Before adding them: are they already in our database? (1 Oct) */}
                    {s.status === "new" && s.linkedinUrl && !takenBy.get(s.id) && (
                      <FindCvButton openingId={id} suggestionId={s.id} />
                    )}
                  </div>

                  {takenBy.get(s.id) ? (
                    <span className="shrink-0 text-[12px] text-ink-faint">Leave this one alone</span>
                  ) : s.status === "new" ? (
                    <div className="flex shrink-0 items-center gap-2">
                      <form action={keepSuggestion}>
                        <input type="hidden" name="openingId" value={id} />
                        <input type="hidden" name="suggestionId" value={s.id} />
                        {s.linkedinUrl ? (
                          <SubmitButton pendingLabel="Adding…" title="Adds them to Excel Tables as Shortlisted">
                            Add to list
                          </SubmitButton>
                        ) : (
                          <button type="button" disabled title="No profile URL to add" className={BUTTON.primary}>
                            Add to list
                          </button>
                        )}
                      </form>
                      <form action={dismissSuggestion}>
                        <input type="hidden" name="openingId" value={id} />
                        <input type="hidden" name="suggestionId" value={s.id} />
                        <Submit
                          tone="dark"
                          pendingLabel="Rejecting…"
                          className="rounded-full border border-rule px-4 py-1.5 text-[12.5px] text-ink-soft transition-colors hover:bg-tag hover:text-ink disabled:opacity-60"
                        >
                          Reject
                        </Submit>
                      </form>
                    </div>
                  ) : (
                    s.status === "kept" ? (
                      <span className="shrink-0">
                        <DoneBadge title={`Kept ${dateAt(s.generatedAt)}`}>Added to Excel Tables</DoneBadge>
                      </span>
                    ) : (
                      <span className="shrink-0 text-[11.5px] text-ink-faint">Rejected · {dateAt(s.generatedAt)}</span>
                    )
                  )}
                </div>

                <dl className="mt-3 grid grid-cols-[92px_1fr] gap-x-4 gap-y-1.5 text-[12.5px] leading-relaxed">
                  <dt className="text-ink-faint">Why</dt>
                  <dd className="text-ink-soft">{s.why}</dd>
                  {s.concern && (
                    <>
                      <dt className="text-ink-faint">Confirm</dt>
                      <dd className="text-warn">{s.concern}</dd>
                    </>
                  )}
                </dl>
              </article>
            ))}
          </div>
        )}
        <Pager page={page} pageSize={PAGE_SIZE} total={matching.length} href={pageLink(`/openings/${id}/hh/suggestions`, listParams)} className="border-t border-rule py-4" />
      </div>

      <Assistant
        openingId={id}
        messages={repo.chat(id)}
        initials={user.name.split(" ").map((p) => p[0]).join("").slice(0, 2)}
      />
    </>
  );
}
