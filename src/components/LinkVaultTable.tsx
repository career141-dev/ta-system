import { repo } from "@/data/store";
import { AddLinkForm } from "./AddLinkForm";
import { LinkRow } from "./LinkRow";
import { scopeLinks } from "@/lib/visibility";
import { can, isDeskWide } from "@/lib/auth";
import type { User } from "@/data/types";
import { Pager } from "./Pager";
import { matchesQuery, pageLink, slicePage } from "@/lib/paging";
import { INTEREST_TABS, interestOf, levelLabel } from "@/lib/linkViews";
import { LinkLevelHeader } from "./LinkLevelHeader";

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
      const app = r.candidateId
        ? (repo.applicationsForCandidate(r.candidateId).find((a) => a.openingId === openingId) ?? null)
        : null;
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
  // The viewer's own L, when the one being looked at is theirs.
  const mine = repo.linkLevels(openingId, user.id).find((l) => l.n === level);
  const pages = Math.max(1, Math.ceil(matching.length / PAGE_SIZE));
  const current = Math.min(Math.max(1, page), pages);
  const scoped = slicePage(matching, current, PAGE_SIZE);
  const rows = scoped.map((x) => x.row);
  const pill = (on: boolean) =>
    `rounded-full border px-3.5 py-1.5 text-[12.5px] transition-colors ${
      on ? "border-brand bg-brand-soft font-medium text-brand" : "border-rule text-ink-soft hover:border-ink-faint hover:text-ink"
    }`;

  return (
    <>
      <AddLinkForm openingId={openingId} canNote={canNote} />

      {level > 0 && (
        <LinkLevelHeader
          openingId={openingId}
          n={level}
          label={mine ? levelLabel(mine) : `L${level}`}
          name={mine?.name ?? ""}
          rows={everyRow.filter(({ row }) => row.level === level && row.addedBy === user.id).length}
          own={!!mine}
          allHref={keep({ level: 0 })}
        />
      )}
      <nav aria-label="Interest" className="mb-3 flex flex-wrap items-center gap-2">
        {INTEREST_TABS.map((t) => (
          <a key={t.key || "all"} href={keep({ status: t.key })} aria-current={status === t.key ? "page" : undefined} className={pill(status === t.key)}>
            {t.label} <span className="tabular-nums text-ink-faint">{count({ status: t.key })}</span>
          </a>
        ))}
        <span aria-hidden className="mx-1 h-4 w-px bg-rule" />
        <a href={keep({ addons: !addons })} aria-current={addons ? "page" : undefined} className={pill(addons)}>
          Add-ons only <span className="tabular-nums text-ink-faint">{count({ addons: true })}</span>
        </a>
      </nav>

      <div className="overflow-hidden rounded-xl border border-rule bg-surface">
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
