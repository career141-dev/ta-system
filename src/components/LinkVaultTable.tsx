import { repo } from "@/data/store";
import { AddLinkForm } from "./AddLinkForm";
import { LinkRow } from "./LinkRow";
import { scopeLinks } from "@/lib/visibility";
import type { User } from "@/data/types";
import { Pager } from "./Pager";
import { matchesQuery, pageLink, slicePage } from "@/lib/paging";

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
  page = 1,
}: {
  openingId: string;
  user: User;
  /** The header search, narrowing the table. */
  q?: string;
  page?: number;
}) {
  const users = repo.users();
  const userNames = Object.fromEntries(users.map((u) => [u.id, u.name]));
  // A TA's table is their own. The exception is somebody the other TA has
  // already shortlisted, which appears marked so it is not worked twice.
  const everyRow = scopeLinks(repo.linkVault(openingId), user);
  const matching = everyRow.filter(({ row: r }) => matchesQuery(q, r.name, r.title, r.company, r.linkedinUrl, r.phoneNumber));
  const pages = Math.max(1, Math.ceil(matching.length / PAGE_SIZE));
  const current = Math.min(Math.max(1, page), pages);
  const scoped = slicePage(matching, current, PAGE_SIZE);
  const rows = scoped.map((x) => x.row);

  return (
    <>
      <AddLinkForm openingId={openingId} />

      <div className="overflow-hidden rounded-xl border border-rule bg-surface">
        {rows.length === 0 && q && everyRow.length > 0 ? (
          <p className="px-8 py-16 text-center text-[13px] leading-relaxed text-ink-faint">
            Nobody in this table matches that search.
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
                    onPipeline={
                      r.candidateId
                        ? (repo.applicationsForCandidate(r.candidateId).find((a) => a.openingId === openingId) ?? null)
                        : null
                    }
                    userNames={userNames}
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
        href={pageLink(`/openings/${openingId}/hh/links`, q ? { q } : {})}
      />
    </>
  );
}
