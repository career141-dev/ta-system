"use client";

import {
  addStrategyDoneByInline,
  removeStrategyDoneByInline,
  setStrategyNotApplicableInline,
  updateStrategyLineInline,
} from "@/app/actions";
import { ActionNote, useInline } from "./Submit";

export interface LeadStrategyLine {
  strategyId: string;
  name: string;
  description: string | null;
  /** Still on the desk's list; a retired one keeps its row but cannot be ticked or given again. */
  active: boolean;
  /** The row's id, once the lead has acted on the line. */
  rowId: string | null;
  ticked: boolean;
  struck: boolean;
  doneBy: { id: string; name: string }[];
  /** "YYYY-MM-DD" or "". */
  assignedValue: string;
  doneValue: string;
  note: string;
  submittedLabel: string | null;
  /** Proof pictures the TA has submitted. */
  proofIds: string[];
}

/**
 * A job's strategy table as the TA Lead works it (9 Oct): tick the strategies
 * the TAs on this job should use, put TAs on them, and keep the dates and a note
 * on each line. Every change is saved as it is made, so there is no Save button.
 * N/A strikes a strategy through for the job; the TAs see it crossed out.
 */
export function StrategyLeadTable({
  openingId,
  tas,
  lines,
}: {
  openingId: string;
  tas: { id: string; name: string }[];
  lines: LeadStrategyLine[];
}) {
  const line = useInline(updateStrategyLineInline);
  const add = useInline(addStrategyDoneByInline);
  const remove = useInline(removeStrategyDoneByInline);
  const na = useInline(setStrategyNotApplicableInline);
  const busy = line.pending || add.pending || remove.pending || na.pending;
  const latest = [line.result, add.result, remove.result, na.result]
    .filter((r): r is NonNullable<typeof r> => !!r)
    .sort((a, b) => b.at - a.at)[0] ?? null;

  const save = (strategyId: string, field: string, value: string) => {
    const fd = new FormData();
    fd.set("openingId", openingId);
    fd.set("strategyId", strategyId);
    fd.set("field", field);
    fd.set("value", value);
    line.run(fd);
  };

  const th = "px-3 py-2.5 text-left text-[11px] font-semibold uppercase tracking-wider text-ink-faint";
  const td = "px-3 py-2 align-middle text-[12.5px]";
  const field = "rounded-md border border-rule bg-surface px-2 py-1 text-[12px] text-ink outline-none focus:border-brand-line disabled:opacity-40";

  return (
    <div className={busy ? "opacity-95" : ""}>
      <div className="overflow-x-auto">
        <table className="w-full min-w-[900px] border-collapse">
          <thead>
            <tr className="border-b border-rule">
              <th className={`${th} w-12 pl-5`}><span className="sr-only">Use on this job</span></th>
              <th className={th}>Strategy</th>
              <th className={th}>Done by</th>
              <th className={th}>Date assigned</th>
              <th className={th}>Date done</th>
              <th className={th}>Note</th>
              <th className={`${th} text-right`}><span className="sr-only">Not for this job</span></th>
            </tr>
          </thead>
          <tbody>
            {lines.map((l) => {
              const free = tas.filter((t) => !l.doneBy.some((d) => d.id === t.id));
              const locked = l.struck || (!l.active && !l.rowId);
              return (
                <tr key={l.strategyId} className={`border-b border-rule last:border-b-0 ${l.struck ? "bg-paper/60" : l.ticked ? "" : "text-ink-soft"}`}>
                  <td className={`${td} pl-5`}>
                    <input
                      key={`t${l.ticked}`}
                      type="checkbox"
                      defaultChecked={l.ticked}
                      disabled={locked || (!l.active && !l.ticked)}
                      onChange={(e) => save(l.strategyId, "selected", e.target.checked ? "1" : "0")}
                      aria-label={`Use ${l.name} on this job`}
                      title={l.ticked ? "Ticked: the TAs on this job see it" : "Tick so the TAs on this job see it"}
                      className="h-4 w-4 accent-[var(--brand,#165b42)]"
                    />
                  </td>

                  <td className={`${td} min-w-[200px]`}>
                    <span className={`font-medium ${l.struck ? "text-ink-faint line-through" : "text-ink"}`}>{l.name}</span>
                    {!l.active && <span className="ml-2 rounded-full bg-tag px-2 py-0.5 text-[10.5px] text-ink-soft">retired</span>}
                    {l.description && <span className="mt-0.5 block text-[11.5px] leading-snug text-ink-faint">{l.description}</span>}
                    {l.submittedLabel && <span className="mt-0.5 block text-[11px] text-brand">{l.submittedLabel}</span>}
                  </td>

                  <td className={td}>
                    <div className="flex flex-wrap items-center gap-1.5">
                      {l.doneBy.map((d) => (
                        <span key={d.id} className="inline-flex items-center gap-1 rounded-full border border-rule bg-tag py-0.5 pl-2.5 pr-1 text-[12px]">
                          {d.name}
                          <button
                            type="button"
                            disabled={busy || !l.rowId}
                            onClick={() => {
                              const fd = new FormData();
                              fd.set("rowId", l.rowId!);
                              fd.set("taId", d.id);
                              remove.run(fd);
                            }}
                            title={`Take ${d.name} off`}
                            aria-label={`Take ${d.name} off ${l.name}`}
                            className="grid h-4 w-4 place-items-center rounded-full text-[11px] text-ink-faint hover:bg-rule hover:text-ink"
                          >
                            ✕
                          </button>
                        </span>
                      ))}
                      {!locked && l.active && free.length > 0 && (
                        <select
                          key={l.doneBy.map((d) => d.id).join(",")}
                          defaultValue=""
                          disabled={busy}
                          onChange={(e) => {
                            if (!e.target.value) return;
                            const fd = new FormData();
                            fd.set("openingId", openingId);
                            fd.set("strategyId", l.strategyId);
                            fd.set("taId", e.target.value);
                            add.run(fd);
                          }}
                          aria-label={`Put a TA on ${l.name}`}
                          className="cursor-pointer appearance-none rounded-full border border-dashed border-rule-strong bg-transparent px-2.5 py-0.5 text-[11.5px] text-ink-soft hover:border-brand-line hover:text-brand"
                        >
                          <option value="" disabled>+ Add</option>
                          {free.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
                        </select>
                      )}
                      {l.doneBy.length === 0 && tas.length === 0 && !l.struck && (
                        <span className="text-[11.5px] text-ink-faint">No TA on the job</span>
                      )}
                    </div>
                  </td>

                  <td className={td}>
                    <input
                      key={`a${l.assignedValue}`}
                      type="date"
                      defaultValue={l.assignedValue}
                      disabled={locked}
                      onChange={(e) => {
                        if (e.target.value === "" || e.target.validity.valid) save(l.strategyId, "assignedAt", e.target.value);
                      }}
                      aria-label={`Date ${l.name} was assigned`}
                      className={`${field} w-[140px]`}
                    />
                  </td>

                  <td className={td}>
                    <input
                      key={`d${l.doneValue}`}
                      type="date"
                      defaultValue={l.doneValue}
                      disabled={locked}
                      onChange={(e) => {
                        if (e.target.value === "" || e.target.validity.valid) save(l.strategyId, "doneAt", e.target.value);
                      }}
                      aria-label={`Date ${l.name} was done`}
                      className={`${field} w-[140px]`}
                    />
                  </td>

                  <td className={`${td} min-w-[170px]`}>
                    <input
                      key={`n${l.note}`}
                      type="text"
                      defaultValue={l.note}
                      maxLength={500}
                      disabled={locked}
                      placeholder="Note…"
                      onBlur={(e) => {
                        if (e.target.value.trim() !== l.note.trim()) save(l.strategyId, "note", e.target.value);
                      }}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") e.currentTarget.blur();
                      }}
                      aria-label={`Note on ${l.name}`}
                      className={`${field} w-full border-transparent bg-transparent hover:border-rule focus:bg-surface`}
                    />
                    {l.rowId && l.proofIds.length > 0 && (
                      <div className="mt-1.5 flex flex-wrap gap-1.5">
                        {l.proofIds.map((p) => {
                          const src = `/api/strategy-proof?row=${l.rowId}&proof=${encodeURIComponent(p)}`;
                          return (
                            <a key={p} href={src} target="_blank" rel="noopener noreferrer" title="Open the proof picture">
                              {/* eslint-disable-next-line @next/next/no-img-element */}
                              <img src={src} alt={`Proof for ${l.name}`} width={40} height={40} className="h-10 w-10 rounded border border-rule object-cover" />
                            </a>
                          );
                        })}
                      </div>
                    )}
                  </td>

                  <td className={`${td} text-right`}>
                    <button
                      type="button"
                      disabled={busy || (!l.active && !l.rowId)}
                      onClick={() => {
                        const fd = new FormData();
                        fd.set("openingId", openingId);
                        fd.set("strategyId", l.strategyId);
                        fd.set("na", l.struck ? "0" : "1");
                        na.run(fd);
                      }}
                      title={l.struck ? "Use it on this job again" : "Not for this job: the TAs see it crossed out"}
                      className={`whitespace-nowrap rounded-md border px-2.5 py-1 text-[11px] font-semibold disabled:opacity-50 ${
                        l.struck ? "border-warn bg-warn-soft text-warn" : "border-rule text-ink-soft hover:border-warn hover:text-warn"
                      }`}
                    >
                      {l.struck ? "Use again" : "N/A"}
                    </button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <ActionNote result={latest} className="mx-3 my-2" />
    </div>
  );
}
