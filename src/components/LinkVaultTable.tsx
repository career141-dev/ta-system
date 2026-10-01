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
  status = "",
  level = 0,
  addons = false,
  by = "",
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
  /** Only the rows this person added; "" is everyone's. */
  by?: string;
  page?: number;
}) {
  const users = repo.users();
  const userNames = Object.fromEntries(users.map((u) => [u.id, u.name]));
  // A TA's table is their own, plus whatever a lead put in for them. The
  // exception is somebody the other TA is really working — on the pipeline
  // from their row — which appears marked so it is not worked twice (1 Oct).
  const deskWide = new Set(users.filter(isDeskWide).map((u) => u.id));
  const notTakenOn = new Set(["rejected", "dropped_out", "matched", "new_cv", "ai_follow_up"]);
  const everyRow = scopeLinks(repo.linkVault(openingId), user, (id) => deskWide.has(id), (r) =>
    !!r.candidateId &&
    repo.applicationsForCandidate(r.candidateId).some((a) => a.openingId === openingId && !notTakenOn.has(a.stage)),
  );
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
      const app = found && !movedBackToTables(found) ? found : null;
      return [r.id, { app, interest: interestOf(r, app) }] as const;
    }),
  );
  type F = { status: string; level: number; addons: boolean; by: string };
  const pass = (r: (typeof everyRow)[number]["row"], f: F) => {
    const x = facts.get(r.id)!;
    return (!f.status || x.interest === f.status) && (!f.level || r.level === f.level) && (!f.addons || !!r.isAddOn) && (!f.by || r.addedBy === f.by);
  };
  const searched = everyRow.filter(({ row: r }) => matchesQuery(q, r.name, r.title, r.company, r.linkedinUrl, r.phoneNumber));
  const matching = searched.filter(({ row }) => pass(row, { status, level, addons, by }));
  const params = (next: Partial<F>) => {
    const f = { status, level, addons, by, ...next };
    const out: Record<string, string> = {};
    if (q) out.q = q;
    if (f.status) out.status = f.status;
    if (f.level) out.level = String(f.level);
    if (f.addons) out.addons = "1";
    if (f.by) out.by = f.by;
    return out;
  };
  const keep = (next: Partial<F>) => {
    const qs = new URLSearchParams(params(next)).toString();
    return `/openings/${openingId}/hh/links${qs ? `?${qs}` : ""}`;
  };
  // A tab's count is what pressing it would show, with the other filters kept.
  const count = (next: Partial<F>) =>
    searched.filter(({ row }) => pass(row, { status, level, addons, by, ...next })).length;
  // Everyone who added a row here, the viewer first as "Me" (1 Oct).
  const adders = [...new Set(everyRow.map(({ row }) => row.addedBy))].sort((a, b) =>
    a === user.id ? -1 : b === user.id ? 1 : (userNames[a] ?? "").localeCompare(userNames[b] ?? ""),
  );
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
        <div className="flex flex-wrap items-center gap-3 pb-2">
          {/* For leads, who see every TA's rows. A TA's table is their own
              (scopeLinks), so the filter would only repeat it (1 Oct). */}
          {isDeskWide(user) && adders.length > 1 && (
            <nav aria-label="Added by" className="flex flex-wrap items-center gap-1 text-[12px]">
              <span className="text-ink-faint">Added by</span>
              {["", ...adders].map((id) => (
                <a
                  key={id || "all"}
                  href={keep({ by: id })}
                  aria-current={by === id ? "true" : undefined}
                  className={`rounded-full border px-2.5 py-0.5 ${by === id ? "border-ink bg-ink text-white" : "border-rule text-ink-soft hover:bg-tag"}`}
                >
                  {id === "" ? "Everyone" : id === user.id ? "Me" : (userNames[id] ?? "Someone")}{" "}
                  <span className={by === id ? "text-white/70" : "text-ink-faint"}>{count({ by: id })}</span>
                </a>
              ))}
            </nav>
          )}
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
