import { repo } from "@/data/store";
import { AddLinkForm } from "./AddLinkForm";
import { LinkRow } from "./LinkRow";
import { scopeLinks } from "@/lib/visibility";
import { can, isDeskWide } from "@/lib/auth";
import type { User } from "@/data/types";
import { Pager } from "./Pager";
import { matchesQuery, pageLink, slicePage } from "@/lib/paging";
import { LINK_VIEWS, inLinkView } from "@/lib/linkViews";
import { movedBackToTables } from "@/lib/pipeline";

const PAGE_SIZE = 25;

/**
 * Excel Tables — spec §4.5, laid out to the Figma frame.
 *
 * This is the Master Sheet, replaced. A TA pastes a competitor's profile and
 * works down the list; the rows carry the same shape as every other candidate
 * list in the product, so there is one way to read a person here rather than
 * two. What was a spreadsheet column — outcome, the number, how it was got — is
 * now the row's own state, and the approach log sits underneath it.
 */
export function LinkVaultTable({
  openingId,
  user,
  q = "",
  view = "",
  page = 1,
}: {
  openingId: string;
  user: User;
  /** The header search, narrowing the table. */
  q?: string;
  /** All links, add-ons or shortlisted (LINK_VIEWS). */
  view?: string;
  page?: number;
}) {
  const users = repo.users();
  const userNames = Object.fromEntries(users.map((u) => [u.id, u.name]));
  // A TA's table is their own, plus whatever a lead put in for them. The
  // exception is somebody the other TA has already shortlisted, which appears
  // marked so it is not worked twice.
  const deskWide = new Set(users.filter(isDeskWide).map((u) => u.id));
  const everyRow = scopeLinks(repo.linkVault(openingId), user, (id) => deskWide.has(id));
  // Leads, directors, admins and ops leave notes; TAs read them (25 Sep).
  const canNote = can(user, "link.note").ok;
  const matching = everyRow.filter(
    ({ row: r }) => inLinkView(r, view) && matchesQuery(q, r.name, r.title, r.company, r.linkedinUrl, r.phoneNumber),
  );
  const keep = (next: string) => {
    const params: Record<string, string> = {};
    if (q) params.q = q;
    if (next) params.view = next;
    const qs = new URLSearchParams(params).toString();
    return `/openings/${openingId}/hh/links${qs ? `?${qs}` : ""}`;
  };
  const pages = Math.max(1, Math.ceil(matching.length / PAGE_SIZE));
  const current = Math.min(Math.max(1, page), pages);
  const scoped = slicePage(matching, current, PAGE_SIZE);
  // Someone moved back here from the pipeline is off it: the row offers "Add
  // to pipeline" again, which brings the same application back (29 Sep).
  const onPipeline = (candidateId: string | null | undefined) => {
    const app = candidateId
      ? repo.applicationsForCandidate(candidateId).find((a) => a.openingId === openingId)
      : undefined;
    return app && !movedBackToTables(app) ? app : null;
  };
  const rows = scoped.map((x) => x.row);

  return (
    <>
      <AddLinkForm openingId={openingId} canNote={canNote} />

      <nav aria-label="Show" className="mb-3 flex flex-wrap items-center gap-2">
        {LINK_VIEWS.map((v) => {
          const on = (view || "") === v.key;
          const n = everyRow.filter(({ row }) => inLinkView(row, v.key)).length;
          return (
            <a
              key={v.key || "all"}
              href={keep(v.key)}
              aria-current={on ? "page" : undefined}
              className={`rounded-full border px-3.5 py-1.5 text-[12.5px] transition-colors ${
                on ? "border-brand bg-brand-soft font-medium text-brand" : "border-rule text-ink-soft hover:border-ink-faint hover:text-ink"
              }`}
            >
              {v.label} <span className="tabular-nums text-ink-faint">{n}</span>
            </a>
          );
        })}
      </nav>

      <div className="overflow-hidden rounded-xl border border-rule bg-surface">
        {rows.length === 0 && (q || view) && everyRow.length > 0 ? (
          <p className="px-8 py-16 text-center text-[13px] leading-relaxed text-ink-faint">
            {view === "addons" && !q
              ? "No add-ons in this table yet. Links added while your stage is Add-on are tagged, or tag one with its Add-on button."
              : view === "shortlisted" && !q
                ? "Nobody here is shortlisted yet."
                : "Nobody in this table matches that search."}
          </p>
        ) : rows.length === 0 ? (
          <p className="px-8 py-16 text-center text-[13px] leading-relaxed text-ink-faint">
            Nothing here yet. Paste a competitor&rsquo;s profile above, or keep someone on
            Suggestions and they land here with their name and company already filled in.
          </p>
        ) : (
          <div className="divide-y divide-rule">
            {scoped.map(({ row: r, takenBy }) => (
              <div key={r.id}>
                {takenBy && (
                  <p className="flex items-center gap-2 border-b border-rule bg-paper px-8 py-2 text-[12px] text-ink-soft">
                    <span className="h-1.5 w-1.5 rounded-full bg-warn" />
                    Shortlisted by <span className="font-medium text-ink">{userNames[takenBy] ?? "another TA"}</span>
                    <span className="text-ink-faint">— leave this one alone</span>
                  </p>
                )}
                <div className={takenBy ? "pointer-events-none opacity-55" : undefined}>
                  <LinkRow
                    entry={r}
                    openingId={openingId}
                    addedByName={userNames[r.addedBy] ?? "—"}
                    onPipeline={onPipeline(r.candidateId)}
                    userNames={userNames}
                    canNote={canNote}
                    viewerId={user.id}
                  />
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
      <Pager
        page={current}
        pageSize={PAGE_SIZE}
        total={matching.length}
        href={pageLink(`/openings/${openingId}/hh/links`, { ...(q ? { q } : {}), ...(view ? { view } : {}) })}
      />
    </>
  );
}
