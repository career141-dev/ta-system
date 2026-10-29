import Link from "next/link";
import { notFound } from "next/navigation";
import { primeStore } from "@/data/prime";
import { repo } from "@/data/store";
import { getCurrentUser } from "@/lib/session";
import { allows, isDeskWide } from "@/lib/auth";
import { supportSheetCounts, supportTableRows } from "@/lib/supportTables";
import { SupportEodView } from "@/components/SupportEodView";
import { workdayDate } from "@/lib/workday";
import { Pager } from "@/components/Pager";
import { pageFrom, pageLink, slicePage } from "@/lib/paging";
import { INTEREST_LABEL, interestOf } from "@/lib/linkViews";
import { awaitingShortlist, movedBackToTables } from "@/lib/pipeline";
import { rowApplication } from "@/lib/sharedLinks";

export const dynamic = "force-dynamic";
const PAGE_SIZE = 50;
const field = "rounded-lg border border-rule bg-surface p-2 text-sm";
const date = (at: number) => new Date(at).toLocaleString("en-GB", { timeZone: "Asia/Colombo" });

export default async function SupportTablesPage({ searchParams }: {
  searchParams: Promise<{ position?: string; ta?: string; level?: string; q?: string; page?: string; view?: string; date?: string; cursor?: string; location?: string }>;
}) {
  await primeStore({});
  const user = await getCurrentUser();
  if (!allows(user, "tables.readAll")) notFound();
  const sp = await searchParams;
  const eod = sp.view === "eod";
  const selectedDate = /^\d{4}-\d{2}-\d{2}$/.test(sp.date ?? "") && !Number.isNaN(Date.parse(sp.date!)) ? sp.date! : workdayDate(Date.now());
  const openings = repo.openings().slice().sort((a, b) => a.title.localeCompare(b.title));
  const opening = sp.position ? openings.find(o => o.id === sp.position) : null;
  if (sp.position && !opening) notFound();
  // Only the selected position's detail is loaded. This page never writes,
  // schedules profile matching, or grants an opening/workday assignment.
  if (opening) await primeStore({ openingId: opening.id });
  const users = repo.users();
  const names = new Map(users.map(u => [u.id, u.name]));
  const clients = new Map(repo.clients().map(c => [c.id, c.name]));
  const rows = opening ? supportTableRows(user, repo.linkVault(opening.id), {
    openingId: opening.id, taId: sp.ta, level: sp.level, q: sp.q, location: sp.location,
  }) : [];
  const apps = opening ? repo.applications(opening.id) : [];
  const deskWide = new Set(users.filter(isDeskWide).map(u => u.id));
  const levels = opening ? [...new Set(repo.linkVault(opening.id).filter(r => !sp.ta || r.addedBy === sp.ta).map(r => r.level ?? 0))].sort((a, b) => a - b) : [];
  const page = pageFrom(sp, rows.length, PAGE_SIZE);
  const visible = slicePage(rows, page, PAGE_SIZE);
  const counts = opening ? supportSheetCounts(user, repo.linkVault(opening.id), users.flatMap(ta =>
    [undefined, ...(opening.workLocations ?? []).map(l => l.id)].flatMap(location =>
      repo.linkLevels(opening.id, ta.id, location).map(sheet => ({ userId: ta.id, level: sheet.n, name: sheet.name, workLocationId: location })))), opening.id, sp.ta) : [];
  const viewLink = (view: string) => `/support-tables?${new URLSearchParams({ position: opening!.id, view, ...(sp.ta ? { ta: sp.ta } : {}) })}`;
  return <div className="space-y-5 px-4 py-6 sm:px-8">
    <div><h1 className="text-2xl font-semibold">TA Support · Position review</h1>
      <p className="mt-1 text-sm text-ink-soft">Open any position to read its Excel Tables and EOD. No job access request is needed. Both views are read only.</p></div>
    <form action="/support-tables" className="flex flex-wrap items-end gap-3">
      <input type="hidden" name="view" value={eod ? "eod" : "tables"} />
      <label className="grid gap-1 text-sm">Position<select name="position" defaultValue={sp.position ?? ""} className={`${field} max-w-full`} required>
        <option value="">Select a position</option>
        {openings.map(o => <option key={o.id} value={o.id}>{o.title} · {clients.get(o.clientId) ?? "Client"}</option>)}
      </select></label>
      <label className="grid gap-1 text-sm">Added by<select name="ta" defaultValue={sp.ta ?? ""} className={field}>
        <option value="">Everyone</option>{users.slice().sort((a, b) => a.name.localeCompare(b.name)).map(u => <option key={u.id} value={u.id}>{u.name}</option>)}
      </select></label>
      {!eod && <label className="grid gap-1 text-sm">Sheet<select name="level" defaultValue={sp.level ?? ""} className={field}>
        <option value="">All sheets</option>{levels.map(n => <option key={n} value={n}>{n ? `L${n}` : "Not in a sheet"}</option>)}
      </select></label>}
      {!eod && !!opening?.workLocations?.length && <label className="grid gap-1 text-sm">Location<select name="location" defaultValue={sp.location ?? ""} className={field}>
        <option value="">All locations</option><option value="unassigned">Unassigned</option>{opening.workLocations.map(l => <option key={l.id} value={l.id}>{l.name}</option>)}
      </select></label>}
      {eod ? <label className="grid gap-1 text-sm">EOD date<input type="date" name="date" defaultValue={selectedDate} className={field} /></label>
        : <label className="grid gap-1 text-sm">Search<input name="q" defaultValue={sp.q ?? ""} placeholder="Name, company or phone" className={field} /></label>}
      <button className="rounded-lg bg-brand px-4 py-2 text-sm font-medium text-white">{eod ? "View EOD" : "View rows"}</button>
      <Link href="/support-tables" className="py-2 text-sm text-brand underline">Clear filters</Link>
    </form>
    {!opening ? <div className="grid gap-3 sm:grid-cols-2">{openings.map(o => <Link key={o.id} href={`/support-tables?position=${encodeURIComponent(o.id)}`} className="rounded-lg border border-rule p-4 hover:border-brand">
      <p className="font-medium">{o.title}</p><p className="text-sm text-ink-soft">{clients.get(o.clientId)} · Excel Tables / EOD · Read only</p>
    </Link>)}</div> : <>
      <nav aria-label="Position review" className="flex gap-4 border-b border-rule pb-3">
        <Link href="/support-tables" className="text-brand underline">All positions</Link>
        <Link href={viewLink("tables")} aria-current={!eod ? "page" : undefined} className={!eod ? "font-semibold text-brand" : "text-brand underline"}>Excel Tables</Link>
        <Link href={viewLink("eod")} aria-current={eod ? "page" : undefined} className={eod ? "font-semibold text-brand" : "text-brand underline"}>EOD</Link>
      </nav>
      {eod ? <><h2 className="font-semibold">{opening.title} · EOD · Read only</h2><SupportEodView opening={opening} user={user} taId={sp.ta} date={selectedDate} cursor={sp.cursor} /></> : <>
      <div><h2 className="font-semibold">{opening.title}</h2><p className="text-sm text-ink-soft">{rows.length} rows · Read only</p></div>
      <section className="space-y-2"><h3 className="font-semibold">L counts by TA</h3><p className="text-sm text-ink-soft">All rows in each sheet, independent of the row search and pagination. “Added today” uses Sri Lanka time.</p>
        {!counts.length ? <p>No sheets or rows were found.</p> : <div className="overflow-x-auto"><table className="w-full text-left text-sm"><thead><tr>{["TA", "Sheet", "Location", "Total profiles", "Added today"].map(h => <th key={h} className="border border-rule p-2">{h}</th>)}</tr></thead>
          <tbody>{counts.map(c => <tr key={JSON.stringify([c.userId, c.level, c.workLocationId])}>
            <td className="border border-rule p-2">{names.get(c.userId) ?? "Unavailable user"}</td>
            <td className="border border-rule p-2"><Link className="text-brand underline" href={`/support-tables?${new URLSearchParams({ position: opening.id, ta: c.userId, level: String(c.level), location: c.workLocationId ?? "unassigned" })}`}>{c.level ? `L${c.level}${c.name ? ` · ${c.name}` : ""}` : "Not in a sheet"}</Link></td>
            <td className="border border-rule p-2">{opening.workLocations?.find(l => l.id === c.workLocationId)?.name ?? "Unassigned"}</td>
            <td className="border border-rule p-2">{c.total}</td><td className="border border-rule p-2">{c.addedToday}</td>
          </tr>)}</tbody></table></div>}
      </section>
      {!rows.length ? <p>No rows match this selection.</p> : <div className="overflow-x-auto rounded-lg border border-rule">
        <table className="w-full text-left text-sm">
          <thead className="bg-paper"><tr>{["Profile", "TA", "Sheet / location", "Contact", "Progress", "Notes"].map(h => <th key={h} className="whitespace-nowrap p-3">{h}</th>)}</tr></thead>
          <tbody>{visible.map(row => {
            const found = row.candidateId ? apps.find(a => a.candidateId === row.candidateId && (a.workLocationId ?? "") === (row.workLocationId ?? "")) : null;
            const onPipeline = found && !movedBackToTables(found) && !awaitingShortlist(found) ? found : null;
            const { app, takenBy } = rowApplication(row, onPipeline, id => deskWide.has(id));
            const sheet = row.level ? repo.linkLevels(opening.id, row.addedBy, row.workLocationId).find(l => l.n === row.level) : null;
            return <tr key={row.id} className="border-t border-rule align-top">
              <td className="min-w-56 p-3"><p className="font-medium">{row.name ?? "Unnamed profile"}</p><p>{row.title}</p><p>{row.company}</p>
                {/^https?:\/\//i.test(row.linkedinUrl) && <a href={row.linkedinUrl} target="_blank" rel="noopener noreferrer" className="text-brand underline">LinkedIn profile</a>}
                <p className="text-xs text-ink-soft">Added {date(row.createdAt)}</p></td>
              <td className="p-3">{names.get(row.addedBy) ?? "Unavailable user"}</td>
              <td className="p-3"><p>{row.level ? `L${row.level}${sheet?.name ? ` · ${sheet.name}` : ""}` : "Not in a sheet"}</p>
                <p>{opening.workLocations?.find(l => l.id === row.workLocationId)?.name ?? ""}</p>
                {row.isAddOn && <p>Add-on</p>}{row.isEyeMarked && <p>Eye-marked</p>}</td>
              <td className="p-3"><p>{row.phoneNumber ?? "—"}</p><p>{row.phoneSource?.replaceAll("_", " ")}</p><p>{row.capture?.email}</p></td>
              <td className="whitespace-nowrap p-3"><p>{INTEREST_LABEL[interestOf(row, app)]}</p><p>{row.outcome.replaceAll("_", " ")}</p>
                {takenBy && <p>Shortlisted by {names.get(takenBy) ?? "another TA"}</p>}
                {row.cvMatch?.hasCv && <p>CV available</p>}</td>
              <td className="min-w-60 p-3">{[...(row.taNotes ?? []), ...(row.leadNotes ?? [])].map(note => <p key={note.id} className="mb-2 whitespace-pre-wrap">{names.get(note.by) ?? "Unavailable user"} · {date(note.at)}: {note.note}</p>)}
                {row.conversationLog.map((entry, i) => <p key={`call:${i}`} className="mb-2 whitespace-pre-wrap">{date(entry.at)} · {entry.channel}: {entry.note}</p>)}</td>
            </tr>;
          })}</tbody>
        </table>
      </div>}
      <Pager page={page} pageSize={PAGE_SIZE} total={rows.length} href={pageLink("/support-tables", sp)} />
      </>}
    </>}
  </div>;
}
