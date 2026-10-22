import { repo, LINK_LEVEL_UNDO_MS } from "@/data/store";
import { AddLinkForm } from "./AddLinkForm";
import { LinkRow } from "./LinkRow";
import { scopeLinks } from "@/lib/visibility";
import { can, isDeskWide, seesEveryTaRow } from "@/lib/auth";
import type { User } from "@/data/types";
import { Pager } from "./Pager";
import { matchesQuery, pageLink, slicePage } from "@/lib/paging";
import { clockAt, colomboDateTime } from "@/lib/format";
import { workTimeZone } from "@/lib/countries";
import { INTEREST_TABS, NO_SHEET, colomboDay, dayLabel, inDay, inSheet, interestOf, levelLabel, levelParam, sheetOwner } from "@/lib/linkViews";
import { LinkFilters } from "./LinkFilters";
import { LinkSearch } from "./LinkSearch";
import { LinkExportMenu } from "./LinkExportMenu";
import { visibleEyeMarked } from "@/lib/eyeMarkedStore";
import { HhUpload } from "./HhUpload";
import { awaitingShortlist, movedBackToTables } from "@/lib/pipeline";
import { bulkStages } from "@/lib/bulkStages";
import { BulkBar, BulkStageControls } from "./BulkSelect";
import { SubmitButton } from "./Submit";
import { addLinksToPipeline, addLinkLevel, restoreLinkLevel } from "@/app/actions";
import { inWorkLocation, workLocationView } from "@/lib/workLocations";
import { WorkLocationTabs } from "./WorkLocationTabs";
import { AssignWorkLocation, WorkLocationBulkControls } from "./AssignWorkLocation";
import { LinkLevelItem } from "./LinkLevelItem";
import { rowApplication } from "@/lib/sharedLinks";

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
  day = "",
  undo = 0,
  page = 1,
  location,
}: {
  openingId: string;
  user: User;
  /** The header search, narrowing the table. */
  q?: string;
  /** Pending, interested or not interested (INTEREST_TABS); "" is all. */
  status?: string;
  /** The L (started with + in the sidebar); 0 is every L, NO_SHEET the person's rows in none. */
  level?: number;
  /** Add-ons only. */
  addons?: boolean;
  /** Only eye-marked profiles. */
  imark?: boolean;
  /** Only the rows this person added; "" is everyone's. */
  by?: string;
  /** Added today, yesterday, in the last 7 days or on one date (lib/linkViews readDay); "" is any time. */
  day?: string;
  /** The L just deleted, offered back with Undo. */
  undo?: number;
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
      const onPipeline = found && !movedBackToTables(found) && !awaitingShortlist(found) ? found : null;
      // Another TA shortlisted the same person first: not this row's progress (lib/sharedLinks).
      const { app, takenBy } = rowApplication(r, onPipeline, (id) => deskWide.has(id));
      return [r.id, { app, interest: interestOf(r, app), takenBy }] as const;
    }),
  );
  // Sheets belong to one person (22 Oct): the one chosen under Added by, or a
  // TA's own. A lead on Everyone has no L tabs — L1 was every TA's L1 added
  // together under one person's date (lib/linkViews).
  const seesEveryone = isDeskWide(user) || seesEveryTaRow(user);
  const owner = sheetOwner(user.id, seesEveryone, by);
  const now = Date.now();
  type F = { status: string; level: number; addons: boolean; imark: boolean; by: string; day: string; q: string };
  const cur: F = { status, level: owner ? level : 0, addons, imark, by, day, q };
  const pass = (r: (typeof everyRow)[number]["row"], f: F) => {
    const x = facts.get(r.id)!;
    return (!f.status || x.interest === f.status) && inSheet(r, f.level, sheetOwner(user.id, seesEveryone, f.by)) && (!f.addons || !!r.isAddOn) &&
      (!f.imark || r.isEyeMarked) && (!f.by || r.addedBy === f.by) && inDay(r.createdAt, f.day, now) &&
      matchesQuery(f.q, r.name, r.title, r.company, r.linkedinUrl, r.phoneNumber);
  };
  const matching = everyRow.filter(({ row }) => pass(row, cur));
  const params = (next: Partial<F>) => {
    const f = { ...cur, ...next };
    const out: Record<string, string> = {};
    if (workLocationId !== undefined) out.location = workLocationId || "unassigned";
    if (f.q) out.q = f.q;
    if (f.status) out.status = f.status;
    if (f.level) out.level = levelParam(f.level);
    if (f.addons) out.addons = "1";
    if (f.imark) out.imark = "1";
    if (f.by) out.by = f.by;
    if (f.day) out.day = f.day;
    return out;
  };
  const keep = (next: Partial<F>) => {
    const qs = new URLSearchParams(params(next)).toString();
    return `/openings/${openingId}/hh/links${qs ? `?${qs}` : ""}`;
  };
  // A tab's count is what pressing it shows: every other filter kept (22 Oct —
  // the L tabs cleared status and add-ons, so "L2 53" opened on 4 rows).
  const count = (next: Partial<F>) => everyRow.filter(({ row }) => pass(row, { ...cur, ...next })).length;
  // Everyone who added a row here, the viewer first as "Me" (1 Oct).
  const adders = [...new Set(everyRow.map(({ row }) => row.addedBy))].sort((a, b) =>
    a === user.id ? -1 : b === user.id ? 1 : (userNames[a] ?? "").localeCompare(userNames[b] ?? ""),
  );
  const locationKey = workLocationId || undefined;
  // The owner's own L's, plus any number on their rows with no L of theirs
  // behind it (older repairs and imports), so every row can be reached.
  const sheetMap = new Map<number, { n: number; at: number; name?: string }>();
  if (owner) {
    for (const l of repo.linkLevels(openingId, owner, locationKey)) sheetMap.set(l.n, { ...l });
    for (const { row } of everyRow) {
      if (row.addedBy === owner && row.level && row.level > 0 && !sheetMap.has(row.level)) sheetMap.set(row.level, { n: row.level, at: 0 });
    }
    if (level > 0 && !sheetMap.has(level)) sheetMap.set(level, { n: level, at: 0 });
  }
  const sheets = [...sheetMap.values()].sort((a, b) => a.n - b.n);
  const sheetName = (n: number) => (n === NO_SHEET ? "Not in a sheet" : sheetMap.get(n)?.at ? levelLabel(sheetMap.get(n)!) : `L${n}`);
  const noSheetCount = owner ? count({ level: NO_SHEET }) : 0;
  const myLevels = repo.linkLevels(openingId, user.id, locationKey);

  // Where a link typed above goes (22 Oct): the open L when it is yours,
  // otherwise your latest — said beside the button, before it is pressed.
  const chosen = owner === user.id && cur.level > 0 ? myLevels.find((l) => l.n === cur.level) : undefined;
  const target = chosen ?? repo.latestLinkLevel(openingId, user.id, locationKey);
  const addingTo = target
    ? `Adding to ${seesEveryone ? "your " : ""}${levelLabel(target)}`
    : `Adding to a new ${seesEveryone ? "L-sheet of yours" : `L${repo.nextLinkLevel(openingId, user.id, locationKey)}`}`;

  // The open sheet at a glance: when it started, what is in it, the last link.
  const inOpenSheet = owner && cur.level ? everyRow.filter(({ row }) => inSheet(row, cur.level, owner)).map(({ row }) => row) : [];
  const summary = owner && cur.level ? {
    started: cur.level > 0 ? sheetMap.get(cur.level)?.at ?? 0 : 0,
    total: inOpenSheet.length,
    by: Object.fromEntries(INTEREST_TABS.filter((t) => t.key).map((t) => [t.label, inOpenSheet.filter((r) => facts.get(r.id)!.interest === t.key).length])),
    last: inOpenSheet.reduce((m, r) => Math.max(m, r.createdAt), 0),
  } : null;

  // Undo for a sheet deleted a moment ago (22 Oct).
  const deletedSheet = undo ? repo.allLinkLevels(openingId, user.id, locationKey)[undo - 1] : undefined;
  const canUndo = !!deletedSheet?.deleted && !!deletedSheet.deletedAt && now - deletedSheet.deletedAt <= LINK_LEVEL_UNDO_MS;

  // "You're viewing: Colombo › Hassan › L2 › Interested — 4 links" (22 Oct): the
  // filters stacked with nothing saying which were on.
  const where = [
    workLocationId === undefined ? null : workLocationId === "" ? "Location not assigned" : (opening.workLocations?.find((l) => l.id === workLocationId)?.name ?? "This location"),
    seesEveryone ? (by ? (by === user.id ? "Me" : (userNames[by] ?? "Someone")) : "Everyone") : null,
    cur.level ? sheetName(cur.level) : "All sheets",
    status ? INTEREST_TABS.find((t) => t.key === status)?.label : null,
    imark ? "iMark" : null,
    addons ? "Add-ons only" : null,
    day ? dayLabel(day) : null,
    q ? `\u201c${q}\u201d` : null,
  ].filter(Boolean);
  const filtered = !!(status || cur.level || addons || imark || by || day || q);

  // A card per person for the lead on Everyone (22 Oct): what each TA has
  // added, today's links hour by hour, and their own sheets — each person's
  // work apart, with its times.
  const today = colomboDay(now);
  const cards = seesEveryone && !by ? adders.map((id) => {
    const theirs = everyRow.filter(({ row }) => row.addedBy === id).map(({ row }) => row);
    const todays = theirs.filter((r) => colomboDay(r.createdAt) === today).sort((a, b) => a.createdAt - b.createdAt);
    const hours = new Map<number, number>();
    for (const r of todays) {
      const h = Number(new Date(r.createdAt).toLocaleString("en-GB", { hour: "2-digit", hour12: false, timeZone: "Asia/Colombo" }));
      hours.set(h, (hours.get(h) ?? 0) + 1);
    }
    return {
      id,
      name: id === user.id ? "Me" : (userNames[id] ?? "Someone"),
      total: theirs.length,
      today: todays.length,
      first: todays[0]?.createdAt ?? 0,
      last: todays.at(-1)?.createdAt ?? 0,
      hours: [...hours.entries()].sort((a, b) => a[0] - b[0]),
      sheets: repo.linkLevels(openingId, id, locationKey).map((l) => ({ label: levelLabel(l), n: theirs.filter((r) => r.level === l.n).length })),
      noSheet: theirs.filter((r) => !(r.level && r.level > 0)).length,
      zone: workTimeZone(repo.user(id)?.workCountry),
    };
  }) : [];
  const hourLabel = (h: number) => `${h % 12 || 12} ${h < 12 ? "AM" : "PM"}`;
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
      {workLocationId !== "" && !opening.workLocations?.find(l => l.id === workLocationId)?.archived && <AddLinkForm key={workLocationId ?? "legacy"} openingId={openingId} canNote={canNote} workLocationId={workLocationId} level={chosen?.n} addingTo={addingTo} />}
      {workLocationId === "" && <p className="mb-4 text-[13px] text-ink-soft">Select a location to add profiles. Assign existing rows below after checking where they belong.</p>}
      {workLocationId !== "" && <form action={addLinkLevel} className="mb-3">
        <input type="hidden" name="openingId" value={openingId} /><input type="hidden" name="workLocationId" value={workLocationId ?? ""} />
        <SubmitButton pendingLabel="Adding…" className="text-[12px] text-brand">+ Add L-sheet</SubmitButton>
      </form>}
      {canUndo && (
        <form action={restoreLinkLevel} className="mb-3 flex flex-wrap items-center gap-3 rounded-lg border border-rule bg-tag px-4 py-2.5 text-[12.5px]">
          <input type="hidden" name="openingId" value={openingId} />
          <input type="hidden" name="workLocationId" value={workLocationId ?? ""} />
          <input type="hidden" name="level" value={undo} />
          <span>
            Deleted L{undo}. {deletedSheet!.movedRows?.length ? `Its ${deletedSheet!.movedRows.length === 1 ? "link is" : `${deletedSheet!.movedRows.length} links are`} in Not in a sheet.` : "It had no links."}
          </span>
          <SubmitButton pendingLabel="Putting back…" className="font-medium text-brand">Undo</SubmitButton>
        </form>
      )}
      {imark && (
        <div className="mb-4 text-[13px] text-ink-soft">
          <p className="mb-3">Call these candidates and request their CVs. Once received, add them to TA Follow-up and prepare them for Director Review.</p>
          {workLocationId !== "" && can(user, "opening.act", { assignment: repo.assignmentFor(openingId, user.id) ?? null }).ok && <HhUpload key={workLocationId} openingId={openingId} workLocationId={workLocationId} />}
        </div>
      )}

      {cards.length > 0 && (
        <section aria-label="Work by person" className="mb-4 grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
          {cards.map((c) => (
            <a key={c.id} href={keep({ by: c.id, level: 0 })} className="rounded-xl border border-rule bg-surface p-4 text-[12px] transition-colors hover:border-brand">
              <div className="flex items-baseline justify-between gap-2">
                <span className="text-[13.5px] font-semibold text-ink">{c.name}</span>
                <span className="text-ink-soft"><span className="font-semibold text-ink">{c.total}</span> links · <span className="font-semibold text-ink">{c.today}</span> today</span>
              </div>
              <p className="mt-1.5 text-ink-soft">
                {c.today
                  ? <>Today {clockAt(c.first, "Asia/Colombo") === clockAt(c.last, "Asia/Colombo") ? `at ${clockAt(c.last, "Asia/Colombo")}` : `${clockAt(c.first, "Asia/Colombo")} – ${clockAt(c.last, "Asia/Colombo")}`} <span className="text-ink-faint">(Sri Lanka{c.zone.zone !== "Asia/Colombo" && clockAt(c.last, c.zone.zone) !== clockAt(c.last, "Asia/Colombo") ? ` · ${clockAt(c.first, c.zone.zone)} – ${clockAt(c.last, c.zone.zone)} ${c.zone.label}` : ""})</span></>
                  : "Nothing added today"}
              </p>
              {c.hours.length > 0 && (
                <p className="mt-1 text-ink-faint">By hour: {c.hours.map(([h, n]) => `${hourLabel(h)} ${n}`).join(" · ")}</p>
              )}
              {(c.sheets.length > 0 || c.noSheet > 0) && (
                <p className="mt-1.5 text-ink-soft">
                  {[...c.sheets.map((x) => `${x.label} (${x.n})`), ...(c.noSheet ? [`Not in a sheet (${c.noSheet})`] : [])].join(" · ")}
                </p>
              )}
            </a>
          ))}
        </section>
      )}

      {/* Sheet tabs row: one person's sheets, never several people's L1 added together. */}
      <div className="border-b border-rule">
        <nav aria-label="Sheets" className="flex min-w-0 flex-wrap items-end gap-0.5">
          {[{ n: 0, at: 0 } as { n: number; at: number; name?: string }, ...sheets].map((l) => (
            l.n && opening.workLocations?.length ? <LinkLevelItem key={`${workLocationId}:${l.n}`} openingId={openingId} workLocationId={workLocationId || undefined} href={keep({ level: l.n })} active={cur.level === l.n} className={`${tab(cur.level === l.n)} flex items-center gap-2`} level={{ n: l.n, label: sheetName(l.n), name: l.name ?? "", count: count({ level: l.n }), canManage: workLocationId !== "" && owner === user.id && myLevels.some(own => own.n === l.n) }} /> : <a key={l.n} href={keep({ level: l.n })} aria-current={cur.level === l.n ? "page" : undefined} className={tab(cur.level === l.n)}>
              {l.n === 0 ? "All" : sheetName(l.n)}{" "}
              <span className="tabular-nums font-normal text-ink-faint">{count({ level: l.n })}</span>
            </a>
          ))}
          {(noSheetCount > 0 || cur.level === NO_SHEET) && (
            <a href={keep({ level: NO_SHEET })} aria-current={cur.level === NO_SHEET ? "page" : undefined} className={tab(cur.level === NO_SHEET)}
              title="Links from a deleted L, or added before L-sheets. Still here, in no L.">
              Not in a sheet <span className="tabular-nums font-normal text-ink-faint">{noSheetCount}</span>
            </a>
          )}
          {seesEveryone && !by && (
            <span className="ml-2 self-center pb-1 text-[11.5px] text-ink-faint">L-sheets belong to one person — pick a name under Added by to see theirs.</span>
          )}
        </nav>
      </div>
      {summary && (
        <p className="pt-2.5 text-[12px] text-ink-soft">
          <span className="font-medium text-ink">{sheetName(cur.level)}</span>
          {summary.started ? ` · started ${colomboDateTime(summary.started)}` : ""}
          {` · ${summary.total} ${summary.total === 1 ? "link" : "links"}`}
          {Object.entries(summary.by).map(([label, n]) => ` · ${n} ${label}`).join("")}
          {summary.last ? ` · last link ${colomboDateTime(summary.last)}` : ""}
        </p>
      )}

      {/* Filter and search toolbar row */}
      <div className="flex flex-wrap items-center justify-between gap-3 py-2.5">
        {seesEveryone && adders.length > 0 && (
          <nav aria-label="Added by" className="flex flex-wrap items-center gap-1 text-[12px]">
            <span className="text-ink-faint">Added by</span>
            {["", ...adders].map((id) => (
              <a
                key={id || "all"}
                href={keep({ by: id, level: 0 })}
                aria-current={by === id ? "true" : undefined}
                className={`rounded-full border px-2.5 py-0.5 ${by === id ? "border-ink bg-ink text-white" : "border-rule text-ink-soft hover:bg-tag"}`}
              >
                {id === "" ? "Everyone" : id === user.id ? "Me" : (userNames[id] ?? "Someone")}{" "}
                <span className={by === id ? "text-white/70" : "text-ink-faint"}>{count({ by: id, level: 0 })}</span>
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
            filters={{ q, status, level: cur.level, addons, imark, by, day, location: workLocationId === undefined ? undefined : workLocationId || "unassigned" }}
            matchingCount={matching.length}
          />
        </div>
      </div>

      {/* When the links were added, by the Sri Lanka calendar (22 Oct). */}
      <div className="flex flex-wrap items-center gap-2 pb-2.5 text-[12px]">
        <span className="text-ink-faint">Added</span>
        {(["", "today", "yesterday", "week"] as const).map((d) => (
          <a key={d || "any"} href={keep({ day: d })} aria-current={day === d ? "true" : undefined}
            className={`rounded-full border px-2.5 py-0.5 ${day === d ? "border-ink bg-ink text-white" : "border-rule text-ink-soft hover:bg-tag"}`}>
            {dayLabel(d)} <span className={day === d ? "text-white/70" : "text-ink-faint"}>{count({ day: d })}</span>
          </a>
        ))}
        <form action={`/openings/${openingId}/hh/links`} className="flex items-center gap-1.5">
          {Object.entries(params({ day: "" })).map(([k, v]) => <input key={k} type="hidden" name={k} value={v} />)}
          <input type="date" name="day" defaultValue={/^\d/.test(day) ? day : ""} aria-label="Added on this date" className="rounded-md border border-rule bg-surface px-2 py-0.5 text-[12px]" />
          <button className="rounded-full border border-rule px-2.5 py-0.5 text-ink-soft hover:bg-tag">Show</button>
        </form>
      </div>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 pb-3 text-[12.5px]">
        <span className="text-ink-faint">You&rsquo;re viewing:</span>
        <span className="font-medium text-ink">{where.join(" › ")}</span>
        <span className="text-ink-soft">— {matching.length} {matching.length === 1 ? "link" : "links"}</span>
        {filtered && <a href={keep({ status: "", level: 0, addons: false, imark: false, by: "", day: "", q: "" })} className="text-brand hover:underline">Clear all</a>}
      </div>

      <div className="overflow-hidden rounded-xl border border-rule bg-surface">
        {rows.length === 0 && filtered && everyRow.length > 0 ? (
          <p className="px-8 py-16 text-center text-[13px] leading-relaxed text-ink-faint">
            {q
              ? "Nobody in this table matches that search."
              : imark && !status && !cur.level && !addons && !by && !day
                ? "No iMark candidates match this table. Eye-mark a profile to include it here."
              : cur.level === NO_SHEET && !status && !addons && !imark && !day
                ? "Every link here is in an L-sheet."
              : cur.level && !status && !addons && !imark && !day
                ? `Nothing in ${sheetName(cur.level)} yet.${owner === user.id ? " Open it and add a link above to put one in." : ""}`
              : day && !status && !cur.level && !addons && !imark
                ? `No links added ${day === "week" ? "in the last 7 days" : day === "today" || day === "yesterday" ? dayLabel(day).toLowerCase() : `on ${dayLabel(day)}`}.`
                : addons && !status && !cur.level && !imark
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
                  takenByName={facts.get(r.id)!.takenBy ? (userNames[facts.get(r.id)!.takenBy!] ?? "Another TA") : null}
                  addedByTimeZone={workTimeZone(repo.user(r.addedBy)?.workCountry)}
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
