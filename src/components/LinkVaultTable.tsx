import { repo } from "@/data/store";
import { AddLinkForm } from "./AddLinkForm";
import { LinkRow } from "./LinkRow";
import { scopeLinks } from "@/lib/visibility";
import { can, isDeskWide } from "@/lib/auth";
import type { User } from "@/data/types";
import { Pager } from "./Pager";
import { matchesQuery, pageLink, slicePage } from "@/lib/paging";
import { INTEREST_TABS, interestOf, levelLabel } from "@/lib/linkViews";
import { LinkFilters } from "./LinkFilters";
import { awaitingShortlist, movedBackToTables } from "@/lib/pipeline";

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
  status = "",
  level = 0,
  addons = false,
  page = 1,
}: {
  openingId: string;
  user: User;
  /** The header search, narrowing the table. */
  q?: string;
  /** Pending, interested or not interested (INTEREST_TABS); "" is all. */
  status?: string;
  /** The L (started with + in the sidebar); 0 is every L. */
  level?: number;
  /** Add-ons only. */
  addons?: boolean;
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
  // Each row's application here and its interest, worked out once: the tabs,
  // their counts and the rows all read the same answer.
  const facts = new Map(
    everyRow.map(({ row: r }) => {
      const found = r.candidateId
        ? repo.applicationsForCandidate(r.candidateId).find((a) => a.openingId === openingId)
        : undefined;
      // Someone moved back here from the pipeline is off it: the row offers
      // "Add to pipeline" again and reads Pending (29 Sep).
      // Nor is someone only suggested to the opening by the database matcher:
      // they are not shortlisted until the TA presses it (1 Oct).
      const app = found && !movedBackToTables(found) && !awaitingShortlist(found) ? found : null;
      return [r.id, { app, interest: interestOf(r, app) }] as const;
    }),
  );
  const pass = (r: (typeof everyRow)[number]["row"], f: { status: string; level: number; addons: boolean }) => {
    const x = facts.get(r.id)!;
    return (!f.status || x.interest === f.status) && (!f.level || r.level === f.level) && (!f.addons || !!r.isAddOn);
  };
  const searched = everyRow.filter(({ row: r }) => matchesQuery(q, r.name, r.title, r.company, r.linkedinUrl, r.phoneNumber));
  const matching = searched.filter(({ row }) => pass(row, { status, level, addons }));
  const params = (next: Partial<{ status: string; level: number; addons: boolean }>) => {
    const f = { status, level, addons, ...next };
    const out: Record<string, string> = {};
    if (q) out.q = q;
    if (f.status) out.status = f.status;
    if (f.level) out.level = String(f.level);
    if (f.addons) out.addons = "1";
    return out;
  };
  const keep = (next: Partial<{ status: string; level: number; addons: boolean }>) => {
    const qs = new URLSearchParams(params(next)).toString();
    return `/openings/${openingId}/hh/links${qs ? `?${qs}` : ""}`;
  };
  // A tab's count is what pressing it would show, with the other filters kept.
  const count = (next: Partial<{ status: string; level: number; addons: boolean }>) =>
    searched.filter(({ row }) => pass(row, { status, level, addons, ...next })).length;
  // The sheets: All, then the viewer's own L's (started with + in the
  // sidebar). An L number from someone else's link still gets a tab.
  const sheets = repo.linkLevels(openingId, user.id);
  if (level && !sheets.some((l) => l.n === level)) sheets.push({ n: level, at: 0 });
  const pages = Math.max(1, Math.ceil(matching.length / PAGE_SIZE));
  const current = Math.min(Math.max(1, page), pages);
  const scoped = slicePage(matching, current, PAGE_SIZE);
  const rows = scoped.map((x) => x.row);
  // Sheet tabs, as in a workbook: the open one joins the table below it.
  const tab = (on: boolean) =>
    `-mb-px whitespace-nowrap rounded-t-lg border px-4 py-2 text-[12.5px] transition-colors ${
      on ? "border-rule border-b-surface bg-surface font-semibold text-ink" : "border-transparent text-ink-soft hover:bg-tag hover:text-ink"
    }`;

  return (
    <>
      <AddLinkForm openingId={openingId} canNote={canNote} />

      <div className="flex flex-wrap items-end justify-between gap-x-4 gap-y-2 border-b border-rule">
        <nav aria-label="Sheets" className="flex min-w-0 flex-wrap items-end gap-0.5">
          {[{ n: 0, at: 0 } as { n: number; at: number; name?: string }, ...sheets].map((l) => (
            <a key={l.n} href={keep({ level: l.n })} aria-current={level === l.n ? "page" : undefined} className={tab(level === l.n)}>
              {l.n === 0 ? "All" : l.at ? levelLabel(l) : `L${l.n}`}{" "}
              <span className="tabular-nums font-normal text-ink-faint">{count({ level: l.n, status: "", addons: false })}</span>
            </a>
          ))}
        </nav>
        <div className="pb-2">
          <LinkFilters
            status={status}
            options={INTEREST_TABS.map((t) => ({ key: t.key, label: t.label, count: count({ status: t.key }), href: keep({ status: t.key }) }))}
            addons={{ on: addons, count: count({ addons: true }), href: keep({ addons: !addons }) }}
          />
        </div>
      </div>

      <div className="overflow-hidden rounded-b-xl border border-t-0 border-rule bg-surface">
        {rows.length === 0 && (q || status || level || addons) && everyRow.length > 0 ? (
          <p className="px-8 py-16 text-center text-[13px] leading-relaxed text-ink-faint">
            {q
              ? "Nobody in this table matches that search."
              : level && !status && !addons
                ? `Nothing in L${level} yet. Links you add now go into your latest L.`
                : addons && !status && !level
                ? "No add-ons in this table yet. Links added while your stage is Add-on are tagged, or tag one with its Add-on button."
                : "Nobody here matches those filters."}
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
                    onPipeline={facts.get(r.id)!.app}
                    interest={facts.get(r.id)!.interest}
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
        href={pageLink(`/openings/${openingId}/hh/links`, params({}))}
      />
    </>
  );
}
