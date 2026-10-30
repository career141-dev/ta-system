"use client";

import { useCallback, useEffect, useRef, useState } from "react";

type Row = { id: string; name: string; email?: string; title: string; level: string; matchedBy?: string; employer?: string; phone?: string; linkedinUrl?: string; experienceYears?: number };
type Summary = { counts: Record<string, number>; kept: number; finishedAt: number | null; running: { scanned: number } | null };

const LEVELS = [
  { key: "", label: "All salespeople" },
  { key: "manager", label: "Managers" },
  { key: "executive", label: "Executives" },
  { key: "intern", label: "Interns" },
  { key: "other", label: "Other" },
];
const control = "rounded-lg border border-rule bg-surface px-4 py-2 text-sm font-medium disabled:opacity-50";

export function ExtrasSales() {
  const [segment, setSegment] = useState("");
  const [level, setLevel] = useState("");
  const [hasEmail, setHasEmail] = useState(true);
  const [search, setSearch] = useState("");
  const [query, setQuery] = useState("");
  const [rows, setRows] = useState<Row[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [summary, setSummary] = useState<Summary | null>(null);
  const request = useRef(0);

  const filters = useCallback(
    (extra: Record<string, string> = {}) => new URLSearchParams({ ...(segment ? { segment } : {}), ...(level ? { level } : {}), ...(hasEmail ? { hasEmail: "1" } : {}), ...(query ? { q: query } : {}), ...extra }),
    [segment, level, hasEmail, query],
  );

  const loadSummary = useCallback(async () => {
    try {
      const r = await fetch(`/api/extras/sales-contacts?summary=1${segment ? `&segment=${segment}` : ""}`, { cache: "no-store" });
      const d = await r.json();
      if (r.ok) setSummary(d);
    } catch { /* the table still works without the counts */ }
  }, []);

  const load = useCallback(async (more: boolean, from: string | null) => {
    const id = ++request.current;
    setLoading(true);
    try {
      const r = await fetch(`/api/extras/sales-contacts?${filters(from ? { cursor: from } : {})}`, { cache: "no-store" });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || "Could not load the list.");
      if (id !== request.current) return;
      setRows((prev) => (more ? [...prev, ...d.rows] : d.rows));
      setCursor(d.cursor);
      setDone(d.isDone);
      setError("");
    } catch (e) {
      if (id === request.current) setError(e instanceof Error ? e.message : "Could not load the list.");
    } finally {
      if (id === request.current) setLoading(false);
    }
  }, [filters]);

  useEffect(() => { void loadSummary(); }, [loadSummary]);
  // A running refresh is checked every 10 seconds so its counts appear without a reload.
  useEffect(() => {
    if (!summary?.running) return;
    const t = setInterval(() => void loadSummary(), 10000);
    return () => clearInterval(t);
  }, [summary?.running, loadSummary]);
  useEffect(() => { setRows([]); setCursor(null); setDone(false); void load(false, null); }, [load]);

  const refresh = async () => {
    setError("");
    const r = await fetch(`/api/extras/sales-contacts${segment ? `?segment=${segment}` : ""}`, { method: "POST" });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) setError(d.error || "Could not start the refresh.");
    await loadSummary();
  };

  const counts = summary?.counts ?? {};
  const shown = (key: string) => (key ? counts[key] ?? 0 : summary?.kept ?? 0);
  const downloadHref = `/api/extras/sales-contacts/download?${filters()}`;

  return (
    <main className="mx-auto max-w-[1400px] px-4 py-8 sm:px-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold">Extras · {segment ? "Automobile" : "Sales"} contacts</h1>
          <p className="mt-1 text-sm text-ink-soft">
            {segment ? "People who have worked for an automobile employer, at any level (current or past)." : "Salespeople found in the candidate database, by the level in their title."} Do-not-contact and merged duplicates are left out.
            {summary?.finishedAt ? ` Last refreshed ${new Date(summary.finishedAt).toLocaleString()}.` : " Not refreshed yet — press Refresh."}
          </p>
        </div>
        <button className={control} disabled={!!summary?.running} onClick={() => void refresh()}>
          {summary?.running ? `Refreshing… ${summary.running.scanned.toLocaleString()} candidates read` : "Refresh list"}
        </button>
      </div>

      <div className="my-6 flex flex-wrap gap-2">
        {LEVELS.map((l) => (
          <button key={l.key} onClick={() => setLevel(l.key)} aria-pressed={level === l.key}
            className={`${control} ${level === l.key ? "border-brand-line bg-brand-soft" : ""}`}>
            {l.label} <span className="tabular text-ink-soft">{shown(l.key).toLocaleString()}</span>
          </button>
        ))}
      </div>

      <form className="mb-4 flex flex-wrap items-center gap-3" onSubmit={(e) => { e.preventDefault(); setQuery(search.trim()); }}>
        <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search name, title, employer or email"
          aria-label="Search sales contacts" className={`${control} w-80 font-normal`} />
        <button className={control} type="submit">Search</button>
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={hasEmail} onChange={(e) => setHasEmail(e.target.checked)} /> Has email
        </label>
        <a className={`${control} ml-auto`} href={downloadHref}>Download Excel ({LEVELS.find((l) => l.key === level)?.label})</a>
      </form>

      {error && <p role="alert" className="mb-4 rounded-lg border border-danger p-4 text-sm text-danger">{error}</p>}

      <div className="overflow-x-auto rounded-xl border border-rule bg-surface">
        <table className="w-full min-w-[1100px] text-left text-sm">
          <thead className="border-b border-rule text-ink-soft">
            <tr>{["Name", "Email", "Title", "Level", "Employer", "Phone", "LinkedIn", "Years", "Matched by"].map((h) => <th key={h} className="px-3 py-2 font-medium">{h}</th>)}</tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id} className="border-b border-rule last:border-0">
                <td className="px-3 py-2 font-medium">{r.name}</td>
                <td className="px-3 py-2">{r.email ?? "—"}</td>
                <td className="px-3 py-2">{r.title}</td>
                <td className="px-3 py-2 capitalize">{r.level}</td>
                <td className="px-3 py-2">{r.employer ?? "—"}</td>
                <td className="px-3 py-2">{r.phone ?? "—"}</td>
                <td className="px-3 py-2">{r.linkedinUrl ? <a className="underline" href={r.linkedinUrl} target="_blank" rel="noreferrer noopener">Profile</a> : "—"}</td>
                <td className="tabular px-3 py-2">{r.experienceYears ?? "—"}</td>
                <td className="px-3 py-2 text-ink-soft">{r.matchedBy ?? "—"}</td>
              </tr>
            ))}
            {!rows.length && !loading && (
              <tr><td colSpan={9} className="px-3 py-8 text-center text-ink-soft">
                {summary?.finishedAt ? "No one matches these filters." : "The list is empty. Press Refresh list to build it."}
              </td></tr>
            )}
          </tbody>
        </table>
      </div>

      <div className="mt-4 flex items-center gap-3 text-sm text-ink-soft">
        <span>{rows.length.toLocaleString()} shown{done ? "" : " so far"}</span>
        {!done && <button className={control} disabled={loading} onClick={() => void load(true, cursor)}>{loading ? "Loading…" : "Load more"}</button>}
      </div>
    </main>
  );
}
