import { repo } from "@/data/store";
import { AddLinkForm } from "./AddLinkForm";
import { LinkRow } from "./LinkRow";
import { scopeLinks } from "@/lib/visibility";
import { can, isDeskWide, seesEveryTaRow } from "@/lib/auth";
import type { User } from "@/data/types";
import { Pager } from "./Pager";
import { matchesQuery, pageLink, slicePage } from "@/lib/paging";
import { INTEREST_TABS, interestOf, levelLabel } from "@/lib/linkViews";
import { LinkFilters } from "./LinkFilters";
import { LinkSearch } from "./LinkSearch";
import { LinkExportMenu } from "./LinkExportMenu";
import { visibleEyeMarked } from "@/lib/eyeMarkedStore";
import { HhUpload } from "./HhUpload";
import { awaitingShortlist, movedBackToTables } from "@/lib/pipeline";
import { bulkStages } from "@/lib/bulkStages";
import { BulkBar, BulkStageControls } from "./BulkSelect";
import { SubmitButton } from "./Submit";
import { addLinksToPipeline, addLinkLevel } from "@/app/actions";
import { inWorkLocation, workLocationView } from "@/lib/workLocations";
import { WorkLocationTabs } from "./WorkLocationTabs";
import { AssignWorkLocation, WorkLocationBulkControls } from "./AssignWorkLocation";
import { LinkLevelItem } from "./LinkLevelItem";

const PAGE_SIZE = 25;
const BULK_FORM = "bulk-links";

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
  imark = false,
  by = "",
  page = 1,
  location,
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
  /** Only eye-marked profiles. */
  imark?: boolean;
  /** Only the rows this person added; "" is everyone's. */
  by?: string;
  page?: number;
  location?: string;
}) {
  const progress = new Map(visibleEyeMarked(openingId, user).items.map((item) => [item.id, item]));
  const users = repo.users();
  const userNames = Object.fromEntries(users.map((u) => [u.id, u.name]));
  // A TA's table is their own, plus whatever a lead put in for them. Another
  // TA's rows are not shown, even ones they have taken on (5 Oct). TA Support
  // reads every TA's rows on the job (9 Oct).
  const deskWide = new Set(users.filter(isDeskWide).map((u) => u.id));
  const opening = repo.opening(openingId)!;
  const workLocationId = workLocationView(opening, location);
  const everyRow = scopeLinks(repo.linkVault(openingId), user, (id) => deskWide.has(id)).filter(({ row }) => inWorkLocation(row, workLocationId));
  // Leads, directors, admins and ops leave notes; TAs read them (25 Sep).
  const canNote = can(user, "link.note").ok;
  // Each row's application here and its interest, worked out once: the tabs,
  // their counts and the rows all read the same answer.
  const facts = new Map(
    everyRow.map(({ row: r }) => {
      const found = r.candidateId
        ? repo.applicationsForCandidate(r.candidateId).find((a) => a.openingId === openingId && inWorkLocation(a, r.workLocationId ?? ""))
        : undefined;
      // Someone moved back here from the pipeline is off it: the row offers
      // "Add to pipeline" again and reads Pending (29 Sep).
      // Nor is someone only suggested to the opening by the database matcher:
      // they are not shortlisted until the TA presses it (1 Oct).
      const app = found && !movedBackToTables(found) && !awaitingShortlist(found) ? found : null;
      return [r.id, { app, interest: interestOf(r, app) }] as const;
    }),
  );
  type F = { status: string; level: number; addons: boolean; imark: boolean; by: string };
  const pass = (r: (typeof everyRow)[number]["row"], f: F) => {
    const x = facts.get(r.id)!;
    return (!f.status || x.interest === f.status) && (!f.level || r.level === f.level) && (!f.addons || !!r.isAddOn) && (!f.imark || r.isEyeMarked) && (!f.by || r.addedBy === f.by);
  };
  const searched = everyRow.filter(({ row: r }) => matchesQuery(q, r.name, r.title, r.company, r.linkedinUrl, r.phoneNumber));
  const matching = searched.filter(({ row }) => pass(row, { status, level, addons, imark, by }));
  const params = (next: Partial<F>) => {
    const f = { status, level, addons, imark, by, ...next };
    const out: Record<string, string> = {};
    if (workLocationId !== undefined) out.location = workLocationId || "unassigned";
    if (q) out.q = q;
    if (f.status) out.status = f.status;
    if (f.level) out.level = String(f.level);
    if (f.addons) out.addons = "1";
    if (f.imark) out.imark = "1";
    if (f.by) out.by = f.by;
    return out;
  };
  const keep = (next: Partial<F>) => {
    const qs = new URLSearchParams(params(next)).toString();
    return `/openings/${openingId}/hh/links${qs ? `?${qs}` : ""}`;
  };
  // A tab's count is what pressing it would show, with the other filters kept.
  const count = (next: Partial<F>) =>
    searched.filter(({ row }) => pass(row, { status, level, addons, imark, by, ...next })).length;
  // Everyone who added a row here, the viewer first as "Me" (1 Oct).
  const adders = [...new Set(everyRow.map(({ row }) => row.addedBy))].sort((a, b) =>
    a === user.id ? -1 : b === user.id ? 1 : (userNames[a] ?? "").localeCompare(userNames[b] ?? ""),
  );
  // Adders in recent activity order (most recent first, matching linkVault order)
  const recentAdders = [...new Set(everyRow.map(({ row }) => row.addedBy))];
  // The sheets: All, then the relevant L's (started with + in the
  // sidebar). For a TA, their own L's; for a lead/admin or when filtered by TA ("by"),
  // all L's present in the current view so the lead can segregate by L1, L2, etc.
  const levelOwners = by
    ? [by]
    : isDeskWide(user) || seesEveryTaRow(user)
      ? [...new Set([user.id, ...recentAdders])]
      : [user.id];

  const levelsMap = new Map<number, { n: number; at: number; name?: string }>();
  for (const uid of levelOwners) {
    for (const l of repo.linkLevels(openingId, uid, workLocationId || undefined)) {
      if (!levelsMap.has(l.n)) {
        levelsMap.set(l.n, { ...l });
      }
    }
  }

  // Include any L number present on rows in the table
  const rowsToCheck = by ? everyRow.filter(({ row }) => row.addedBy === by) : everyRow;
  for (const { row } of rowsToCheck) {
    if (typeof row.level === "number" && row.level > 0 && !levelsMap.has(row.level)) {
      const known = recentAdders.flatMap((u) => repo.linkLevels(openingId, u, workLocationId || undefined)).find((l) => l.n === row.level);
      levelsMap.set(row.level, { n: row.level, at: known?.at ?? 0, name: known?.name });
    }
  }

  // An L number from query params still gets a tab
  if (level && !levelsMap.has(level)) {
    const known = recentAdders.flatMap((u) => repo.linkLevels(openingId, u, workLocationId || undefined)).find((l) => l.n === level);
    levelsMap.set(level, { n: level, at: known?.at ?? 0, name: known?.name });
  }

  const sheets = Array.from(levelsMap.values()).sort((a, b) => a.n - b.n);
  const pages = Math.max(1, Math.ceil(matching.length / PAGE_SIZE));
  const current = Math.min(Math.max(1, page), pages);
  const rows = slicePage(matching, current, PAGE_SIZE).map((x) => x.row);
  const assignment = repo.assignmentFor(openingId, user.id) ?? null;
  const stages = bulkStages(rows.flatMap((r) => {
    const app = facts.get(r.id)?.app;
    return app && can(user, "opening.act", { openingId, assignment, ownerTaId: app.ownerTaId }).ok ? [app.stage] : [];
  }), can(user, "decide.director", { openingId, assignment }).ok, can(user, "decide.client", { openingId, assignment }).ok);
  // Sheet tabs, as in a workbook: the open one joins the table below it.
  const tab = (on: boolean) =>
    `-mb-px whitespace-nowrap rounded-t-lg border px-4 py-2 text-[12.5px] transition-colors ${
      on ? "border-rule border-b-surface bg-surface font-semibold text-ink" : "border-transparent text-ink-soft hover:bg-tag hover:text-ink"
    }`;

  return (
    <>
      <WorkLocationTabs locations={opening.workLocations} selected={workLocationId} basePath={`/openings/${openingId}/hh/links`} />
      {workLocationId !== "" && !opening.workLocations?.find(l => l.id === workLocationId)?.archived && <AddLinkForm key={workLocationId ?? "legacy"} openingId={openingId} canNote={canNote} workLocationId={workLocationId} level={level} />}
      {workLocationId === "" && <p className="mb-4 text-[13px] text-ink-soft">Select a location to add profiles. Assign existing rows below after checking where they belong.</p>}
      {workLocationId !== "" && <form action={addLinkLevel} className="mb-3">
        <input type="hidden" name="openingId" value={openingId} /><input type="hidden" name="workLocationId" value={workLocationId ?? ""} />
        <SubmitButton pendingLabel="Adding…" className="text-[12px] text-brand">+ Add L-sheet</SubmitButton>
      </form>}
      {imark && (
        <div className="mb-4 text-[13px] text-ink-soft">
          <p className="mb-3">Call these candidates and request their CVs. Once received, add them to TA Follow-up and prepare them for Director Review.</p>
          {workLocationId !== "" && can(user, "opening.act", { assignment: repo.assignmentFor(openingId, user.id) ?? null }).ok && <HhUpload key={workLocationId} openingId={openingId} workLocationId={workLocationId} />}
        </div>
      )}

      {/* Sheet tabs row */}
      <div className="border-b border-rule">
        <nav aria-label="Sheets" className="flex min-w-0 flex-wrap items-end gap-0.5">
          {[{ n: 0, at: 0 } as { n: number; at: number; name?: string }, ...sheets].map((l) => (
            l.n && opening.workLocations?.length ? <LinkLevelItem key={`${workLocationId}:${l.n}`} openingId={openingId} workLocationId={workLocationId || undefined} href={keep({ level: l.n })} active={level === l.n} className={`${tab(level === l.n)} flex items-center gap-2`} level={{ n: l.n, label: l.at ? levelLabel(l) : `L${l.n}`, name: l.name ?? "", count: count({ level: l.n, status: "", addons: false }), canManage: workLocationId !== "" && !by && repo.linkLevels(openingId, user.id, workLocationId || undefined).some(own => own.n === l.n) }} /> : <a key={l.n} href={keep({ level: l.n })} aria-current={level === l.n ? "page" : undefined} className={tab(level === l.n)}>
              {l.n === 0 ? "All" : l.at ? levelLabel(l) : `L${l.n}`}{" "}
              <span className="tabular-nums font-normal text-ink-faint">{count({ level: l.n, status: "", addons: false })}</span>
            </a>
          ))}
        </nav>
      </div>

      {/* Filter and search toolbar row */}
      <div className="flex flex-wrap items-center justify-between gap-3 py-2.5">
        {(isDeskWide(user) || seesEveryTaRow(user)) && adders.length > 1 && (
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
        <div className="flex flex-wrap items-center gap-3 ml-auto">
          <LinkSearch
            openingId={openingId}
            q={q}
            baseParams={params({})}
          />
          <LinkFilters
            status={status}
            options={INTEREST_TABS.map((t) => ({ key: t.key, label: t.label, count: count({ status: t.key }), href: keep({ status: t.key }) }))}
            imark={{ on: imark, count: count({ imark: true }), href: keep({ imark: !imark }) }}
            addons={{ on: addons, count: count({ addons: true }), href: keep({ addons: !addons }) }}
          />
          <LinkExportMenu
            openingId={openingId}
            filters={{ q, status, level, addons, imark, by, location: workLocationId === undefined ? undefined : workLocationId || "unassigned" }}
            matchingCount={matching.length}
          />
        </div>
      </div>

      <div className="overflow-hidden rounded-xl border border-rule bg-surface">
        {rows.length === 0 && (q || status || level || addons || imark || by) && everyRow.length > 0 ? (
          <p className="px-8 py-16 text-center text-[13px] leading-relaxed text-ink-faint">
            {q
              ? "Nobody in this table matches that search."
              : imark && !status && !level && !addons && !by
                ? "No iMark candidates match this table. Eye-mark a profile to include it here."
              : level && !status && !addons && !imark
                ? `Nothing in L${level} yet. Links you add now go into your latest L.`
                : addons && !status && !level && !imark
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
            <div className="px-4 pt-4 sm:px-6">
              <BulkBar form={BULK_FORM} noun={["candidate", "candidates"]}>
                <input type="hidden" name="openingId" value={openingId} />
                <WorkLocationBulkControls locations={opening.workLocations} />
                <SubmitButton formAction={addLinksToPipeline} pendingLabel="Adding…" className="rounded-full bg-brand px-3.5 py-1.5 text-[12.5px] font-medium text-white disabled:opacity-60">Add selected to pipeline</SubmitButton>
                <BulkStageControls stages={stages} />
              </BulkBar>
            </div>
            {rows.map((r) => (
              <div key={r.id} id={`eye-${r.id}`} className="scroll-mt-24">
                {(r.addedBy === user.id || isDeskWide(user)) && <AssignWorkLocation openingId={openingId} locations={opening.workLocations} selected={r.workLocationId} linkId={r.id} />}
                {imark && progress.has(r.id) && (
                  <p className={`px-5 pt-4 text-[12.5px] font-medium ${progress.get(r.id)!.blocked ? "text-warn" : "text-ink-soft"}`}>{progress.get(r.id)!.status}</p>
                )}
                <LinkRow
                  entry={r}
                  openingId={openingId}
                  addedByName={userNames[r.addedBy] ?? "—"}
                  onPipeline={facts.get(r.id)!.app}
                  interest={facts.get(r.id)!.interest}
                  userNames={userNames}
                  canNote={canNote}
                  viewerId={user.id}
                  selectForm={BULK_FORM}
                  readOnly={seesEveryTaRow(user) && r.addedBy !== user.id && !deskWide.has(r.addedBy)}
                />
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
