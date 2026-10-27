"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { trackingDay, type TrackingReport, type TrackingReportRow } from "@/lib/taTracking";

const duration = (ms: number) => `${Math.floor(ms / 3600000)}h ${Math.floor(ms / 60000) % 60}m ${Math.floor(ms / 1000) % 60}s`;
const button = "rounded-lg border border-rule bg-surface px-4 py-2 text-sm font-medium disabled:opacity-50";
export function TaTrackReport({ users }: { users: { id: string; name: string; active: boolean }[] }) {
  const [date, setDate] = useState(() => trackingDay());
  const [userId, setUserId] = useState("");
  const [report, setReport] = useState<TrackingReport | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [updated, setUpdated] = useState(0);
  const request = useRef(0);
  const refresh = useCallback(async () => {
    const id = ++request.current;
    setLoading(true);
    try {
      const response = await fetch(`/api/ta-track?${new URLSearchParams({ date, userId })}`, { cache: "no-store" });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Could not load the report.");
      if (id === request.current) { setReport(data); setUpdated(Date.now()); setError(""); }
    } catch (e) { if (id === request.current) { setReport(null); setError(e instanceof Error ? e.message : "Could not load the report."); } }
    finally { if (id === request.current) setLoading(false); }
  }, [date, userId]);
  useEffect(() => {
    setReport(null);
    void refresh();
    const timer = setInterval(() => { if (document.visibilityState === "visible") void refresh(); }, 30000);
    return () => { clearInterval(timer); ++request.current; };
  }, [refresh]);
  // Each browser uploads independent cumulative rows. Combine matching TA/domain buckets.
  const grouped = new Map<string, TrackingReportRow>();
  for (const row of report?.rows ?? []) {
    const key = JSON.stringify([row.userId, row.domain]);
    const existing = grouped.get(key);
    if (!existing) grouped.set(key, { ...row });
    else for (const field of ["foregroundMs", "activeMs", "idleMs", "clicks", "scrolls", "movementSeconds"] as const) existing[field] += row[field];
  }
  const rows = [...grouped.values()].sort((a, b) => b.foregroundMs - a.foregroundMs);
  const total = (field: "foregroundMs" | "activeMs" | "idleMs") => rows.reduce((sum, row) => sum + row[field], 0);
  const lastSync = Math.max(0, ...(report?.devices ?? []).map(d => d.lastSyncAt));
  const recent = report?.devices.filter(d => d.enabled && Date.now() - d.lastSyncAt < 120000).length ?? 0;
  const exportCsv = () => {
    const fields = ["name", "domain", "date", "foregroundMs", "activeMs", "idleMs", "clicks", "scrolls", "movementSeconds"] as const;
    const cell = (value: unknown) => `"${String(value).replace(/^[=+@\-\t\r]/, "'$&").replaceAll('"', '""')}"`;
    const csv = [fields.join(","), ...rows.map(row => fields.map(f => cell(row[f])).join(","))].join("\r\n");
    const url = URL.createObjectURL(new Blob(["\ufeff", csv], { type: "text/csv;charset=utf-8" }));
    const link = document.createElement("a"); link.href = url; link.download = `ta-track-${date}.csv`; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  return <main className="mx-auto max-w-[1400px] px-4 py-8 sm:px-6">
    <div className="flex flex-wrap items-start justify-between gap-4"><div><h1 className="text-2xl font-semibold">TA Track</h1><p className="mt-1 text-sm text-ink-soft">Website activity by TA · Asia/Colombo · Last 30 days</p></div></div>
    <div className="my-6 flex flex-wrap items-end gap-3">
      <label className="grid gap-1 text-sm">TA<select className={button} value={userId} onChange={e => { setReport(null); setUserId(e.target.value); }}><option value="">All TAs</option>{users.map(u => <option key={u.id} value={u.id}>{u.name}{u.active ? "" : " (inactive)"}</option>)}</select></label>
      <label className="grid gap-1 text-sm">Date<input className={button} type="date" min={trackingDay(Date.now() - 29 * 86400000)} max={trackingDay()} value={date} onChange={e => { setReport(null); setDate(e.target.value); }} /></label>
      <button className={button} disabled={loading} onClick={() => void refresh()}>{loading ? "Loading…" : "Refresh"}</button><button className={button} disabled={!rows.length || loading} onClick={exportCsv}>Export CSV</button>
    </div>
    {error && <p role="alert" className="mb-4 rounded-lg border border-danger p-4 text-sm text-danger">{error}</p>}
    <div className="mb-6 grid gap-4 sm:grid-cols-3">{([ ["Time on website", "foregroundMs"], ["Active time", "activeMs"], ["Inactive time", "idleMs"] ] as const).map(([label, field]) => <div key={field} className="rounded-xl border border-rule bg-surface p-5"><p className="text-sm text-ink-soft" title={field === "foregroundMs" ? "Time this website was the selected tab while the browser was in focus." : field === "activeMs" ? "Website time when the computer detected mouse or keyboard use in the last minute." : "Website time when the computer detected no mouse or keyboard use for a minute, or was locked."}>{label}</p><strong className="mt-2 block text-2xl tabular-nums">{report ? duration(total(field)) : "—"}</strong></div>)}</div>
    <p role="status" className="mb-3 text-sm text-ink-soft">{report ? `${recent} browser${recent === 1 ? "" : "s"} recently syncing · Last upload: ${lastSync ? new Date(lastSync).toLocaleString("en-GB", { timeZone: "Asia/Colombo" }) : "No uploads yet"}` : loading ? "Loading tracking data…" : "Report unavailable"}</p>
    <div className="overflow-x-auto rounded-xl border border-rule bg-surface"><table className="w-full whitespace-nowrap text-left text-sm"><thead className="border-b border-rule text-ink-soft"><tr>{["TA", "Website", "Time on website", "Active time", "Inactive time", "Clicks", "Scrolls", "Mouse movement (seconds)"].map(label => <th key={label} className="px-4 py-3 font-medium">{label}</th>)}</tr></thead><tbody>{rows.map(row => <tr className="border-b border-rule last:border-0" key={JSON.stringify([row.userId, row.domain])}>{[row.name, row.domain, duration(row.foregroundMs), duration(row.activeMs), duration(row.idleMs), row.clicks, row.scrolls, row.movementSeconds].map((value, index) => <td className="px-4 py-3 tabular-nums" key={index}>{value}</td>)}</tr>)}</tbody></table>{report && !rows.length && <p className="p-8 text-center text-sm text-ink-soft">No activity received for this TA and date. The TA must start tracking in the extension.</p>}</div>

    {updated > 0 && <p className="mt-2 text-xs text-ink-faint">Report refreshed at {new Date(updated).toLocaleTimeString("en-GB", { timeZone: "Asia/Colombo" })}. Updates every 30 seconds.</p>}
  </main>;
}
