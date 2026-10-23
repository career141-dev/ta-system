"use client";

import { saveRefereeCalls } from "@/app/actions";
import type { RefereeCall } from "@/data/types";
import {
  GRID_FIELDS,
  applyPaste,
  changeCount,
  diffRows,
  emptyRow,
  isBlankRow,
  parsePastedBlock,
  toTsv,
  type GridField,
  type GridRow,
  type GridValues,
} from "@/lib/refereeGrid";
import { useEffect, useMemo, useRef, useState, useTransition } from "react";

const ANSWERS = [
  "No answer",
  "Not responding",
  "No contacts available",
  "Wrong number",
  "Currently overseas",
  "Will call back",
  "Will send on WhatsApp",
  "Has a contact, will check and share",
  "Number received",
] as const;

const LABEL: Record<GridField, string> = { company: "Company", referral: "Referral", contactNumber: "Contact Number", feedback: "Feedback" };

type Row = GridRow & { addedBy?: string };
type Cell = { r: number; c: number };

const fromCall = (call: RefereeCall): Row => ({
  key: call.id,
  id: call.id,
  addedBy: call.addedBy,
  company: call.company,
  referral: call.referral,
  contactNumber: call.contactNumber ?? "",
  feedback: call.feedback,
});

/**
 * The Referee Calls sheet (23 Oct). It works like the desk's Excel sheet: type
 * in any cell at any time, select a block with the mouse or Shift+arrows, copy
 * it out, paste a block in from Excel, and Save once. Nothing is sent while
 * typing — the first version saved a row on its first cell and then locked it.
 */
export function RefereeCallsGrid({
  openingId,
  actorId,
  workLocationId,
  day,
  calls,
  canEdit,
  showTa,
  userNames,
}: {
  openingId: string;
  actorId: string;
  workLocationId?: string;
  day: string;
  calls: RefereeCall[];
  /** The TA, on today's work day, in a location calls can be saved to. */
  canEdit: boolean;
  showTa: boolean;
  userNames: Record<string, string>;
}) {
  const counter = useRef(0);
  const newKey = () => `new_${Date.now()}_${counter.current++}`;
  // An empty line at the bottom to type into, as in a spreadsheet.
  const withTrailing = (list: Row[]): Row[] =>
    canEdit && (!list.length || !isBlankRow(list[list.length - 1]) || list[list.length - 1].id) ? [...list, emptyRow(newKey())] : list;

  const [rows, setRows] = useState<Row[]>(() => withTrailing(calls.map(fromCall)));
  const [saved, setSaved] = useState<Map<string, GridValues>>(
    () => new Map(calls.filter((c) => c.addedBy === actorId).map((c) => [c.id, fromCall(c)])),
  );
  const [active, setActive] = useState<Cell | null>(null);
  const [anchor, setAnchor] = useState<Cell | null>(null);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const [saving, startSaving] = useTransition();
  const dragging = useRef(false);
  // Focus moved by the keyboard handling, not by a click or Tab: it must not
  // reset the selection Shift+arrows is growing.
  const steering = useRef(false);
  const inputs = useRef(new Map<string, HTMLInputElement>());

  const mayEdit = (row: Row) => canEdit && (!row.id || row.addedBy === actorId);
  const own = useMemo(() => rows.filter((r) => !r.id || r.addedBy === actorId), [rows, actorId]);
  const changes = useMemo(() => diffRows(saved, own), [saved, own]);
  const pending = changeCount(changes);

  const box = active && anchor
    ? { r1: Math.min(active.r, anchor.r), r2: Math.max(active.r, anchor.r), c1: Math.min(active.c, anchor.c), c2: Math.max(active.c, anchor.c) }
    : null;
  const many = !!box && (box.r1 !== box.r2 || box.c1 !== box.c2);
  const inBox = (r: number, c: number) => !!box && many && r >= box.r1 && r <= box.r2 && c >= box.c1 && c <= box.c2;

  // Leaving with unsaved rows asks first.
  useEffect(() => {
    if (!pending) return;
    const warn = (e: BeforeUnloadEvent) => { e.preventDefault(); e.returnValue = ""; };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [pending]);
  useEffect(() => {
    const up = () => { dragging.current = false; };
    window.addEventListener("mouseup", up);
    return () => window.removeEventListener("mouseup", up);
  }, []);

  const focus = (cell: Cell) => {
    const row = rows[cell.r];
    if (!row) return;
    steering.current = true;
    inputs.current.get(`${row.key}:${cell.c}`)?.focus();
    steering.current = false;
  };

  const edit = (r: number, field: GridField, value: string) => {
    setMessage(null);
    setRows((current) => withTrailing(current.map((row, i) => (i === r ? { ...row, [field]: value } : row))));
  };

  const save = () => {
    if (!pending || saving) return;
    setMessage({ ok: true, text: "Saving…" });
    startSaving(async () => {
      const form = new FormData();
      form.set("openingId", openingId);
      form.set("workLocationId", workLocationId ?? "");
      form.set("day", day);
      form.set("changes", JSON.stringify(changes));
      const result = await saveRefereeCalls(form);
      if (!result.ok || !result.calls) {
        setMessage({ ok: false, text: result.message || "Could not save — try again." });
        return;
      }
      const mine = result.calls.map(fromCall);
      const others = rows.filter((r) => r.id && r.addedBy !== actorId);
      const merged = [...others, ...mine].sort((a, b) => {
        const ca = calls.find((c) => c.id === a.id)?.createdAt ?? result.calls!.find((c) => c.id === a.id)?.createdAt ?? 0;
        const cb = calls.find((c) => c.id === b.id)?.createdAt ?? result.calls!.find((c) => c.id === b.id)?.createdAt ?? 0;
        return ca - cb;
      });
      setRows(withTrailing(merged));
      setSaved(new Map(mine.map((r) => [r.id!, r])));
      setActive(null);
      setAnchor(null);
      setMessage({ ok: true, text: "Saved" });
    });
  };

  const removeSelectedRows = () => {
    if (!box) return;
    setMessage(null);
    setRows((current) => withTrailing(current.filter((row, i) => i < box.r1 || i > box.r2 || !mayEdit(row))));
    setActive(null);
    setAnchor(null);
  };

  const clearBox = () => {
    if (!box) return;
    setRows((current) => withTrailing(current.map((row, i) => {
      if (i < box.r1 || i > box.r2 || !mayEdit(row)) return row;
      const next = { ...row };
      for (let c = box.c1; c <= box.c2; c++) next[GRID_FIELDS[c]] = "";
      return next;
    })));
  };

  const onKeyDown = (e: React.KeyboardEvent, cell: Cell) => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s") { e.preventDefault(); save(); return; }
    if ((e.key === "Delete" || e.key === "Backspace") && many) { e.preventDefault(); clearBox(); return; }
    const move = (r: number, c: number) => {
      const next = { r: Math.max(0, Math.min(rows.length - 1, r)), c: Math.max(0, Math.min(GRID_FIELDS.length - 1, c)) };
      e.preventDefault();
      if (e.shiftKey && e.key !== "Enter") { setAnchor(anchor ?? cell); setActive(next); }
      else { setActive(next); setAnchor(next); }
      focus(next);
    };
    const input = e.target as HTMLInputElement;
    const atStart = input.selectionStart === 0 && input.selectionEnd === 0;
    const atEnd = input.selectionStart === input.value.length;
    // Enter in Feedback picks from its suggestion list, so it does not move there.
    const enter = e.key === "Enter" && GRID_FIELDS[cell.c] !== "feedback";
    if (e.key === "ArrowDown" || (enter && !e.shiftKey)) move(cell.r + 1, cell.c);
    else if (e.key === "ArrowUp" || (enter && e.shiftKey)) move(cell.r - 1, cell.c);
    else if (e.key === "ArrowLeft" && (atStart || e.shiftKey)) move(cell.r, cell.c - 1);
    else if (e.key === "ArrowRight" && (atEnd || e.shiftKey)) move(cell.r, cell.c + 1);
  };

  // A block from Excel (tabs or new lines) fills the sheet from the active cell.
  const onPaste = (e: React.ClipboardEvent) => {
    if (!canEdit || !active) return;
    const text = e.clipboardData.getData("text/plain");
    if (!/[\t\r\n]/.test(text.replace(/\r?\n$/, ""))) return;
    e.preventDefault();
    const at = box ? { r: box.r1, c: box.c1 } : active;
    setMessage(null);
    setRows((current) => withTrailing(applyPaste(current, at, parsePastedBlock(text), newKey, mayEdit)));
  };

  // A selected block goes out as Excel reads it.
  const onCopy = (e: React.ClipboardEvent) => {
    if (!many || !box) return;
    e.preventDefault();
    const block = rows.slice(box.r1, box.r2 + 1).map((row) => GRID_FIELDS.slice(box.c1, box.c2 + 1).map((f) => row[f]));
    e.clipboardData.setData("text/plain", toTsv(block));
  };

  const selectRow = (r: number) => { setAnchor({ r, c: 0 }); setActive({ r, c: GRID_FIELDS.length - 1 }); };
  const selectColumn = (c: number) => { setAnchor({ r: 0, c }); setActive({ r: rows.length - 1, c }); };

  const th = "border border-rule bg-tag px-3 py-2 text-left text-[11px] font-semibold uppercase tracking-[0.05em] text-ink-soft select-none";
  const rowsSelected = many && box && box.c1 === 0 && box.c2 === GRID_FIELDS.length - 1;

  return (
    <div>
      {canEdit && (
        <div className="mb-3 flex flex-wrap items-center gap-3">
          <button
            type="button"
            onClick={save}
            disabled={!pending || saving}
            className="rounded-lg bg-brand px-4 py-2 text-[12.5px] font-semibold text-white disabled:cursor-not-allowed disabled:opacity-50"
          >
            {saving ? "Saving…" : pending ? `Save (${pending} change${pending === 1 ? "" : "s"})` : "Save"}
          </button>
          {rowsSelected && (
            <button type="button" onClick={removeSelectedRows} className="rounded-lg border border-rule px-3 py-2 text-[12px] font-medium text-ink-soft hover:border-danger hover:text-danger">
              Remove selected rows
            </button>
          )}
          {message && <span className={`text-[12px] ${message.ok ? "text-brand" : "text-danger"}`}>{message.text}</span>}
          {!message && pending > 0 && <span className="text-[12px] text-ink-faint">Not saved yet.</span>}
        </div>
      )}
      <div className="overflow-x-auto rounded-xl border border-rule bg-surface" onPaste={onPaste} onCopy={onCopy}>
        <datalist id="referee-call-feedback">{ANSWERS.map((answer) => <option key={answer} value={answer} />)}</datalist>
        <table className="w-full min-w-[760px] border-collapse">
          <thead><tr>
            <th className={`${th} w-12 text-center`}>#</th>
            {GRID_FIELDS.map((f, c) => (
              <th key={f} onClick={() => selectColumn(c)} className={`${th} cursor-pointer ${f === "feedback" ? "min-w-[270px]" : ""}`} title="Select the column">
                {LABEL[f]}
              </th>
            ))}
            {showTa && <th className={`${th} w-36`}>TA</th>}
          </tr></thead>
          <tbody>
            {rows.map((row, r) => {
              const writable = mayEdit(row);
              const before = row.id ? saved.get(row.id) : undefined;
              return <tr key={row.key}>
                <td
                  onClick={() => selectRow(r)}
                  title="Select the row"
                  className="cursor-pointer select-none border border-rule bg-tag/40 px-3 py-2.5 text-center text-[12px] tabular-nums text-ink-faint"
                >{r + 1}</td>
                {GRID_FIELDS.map((field, c) => {
                  const changed = writable && (row.id ? !!before && before[field] !== row[field] : !!row[field].trim());
                  return <td
                    key={field}
                    onMouseDown={(e) => {
                      dragging.current = true;
                      if (e.shiftKey && active) { setActive({ r, c }); }
                      else { setActive({ r, c }); setAnchor({ r, c }); }
                    }}
                    onMouseEnter={() => {
                      if (!dragging.current || !anchor) return;
                      setActive({ r, c });
                      window.getSelection()?.removeAllRanges();
                    }}
                    className={`border border-rule p-0 align-top ${inBox(r, c) ? "bg-brand-soft" : changed ? "bg-warn-soft/60" : "bg-surface"}`}
                  >
                    <input
                      ref={(el) => { const k = `${row.key}:${c}`; if (el) inputs.current.set(k, el); else inputs.current.delete(k); }}
                      value={row[field]}
                      readOnly={!writable}
                      onChange={(e) => edit(r, field, e.target.value)}
                      onFocus={() => { if (dragging.current || steering.current) return; setActive({ r, c }); setAnchor({ r, c }); }}
                      onKeyDown={(e) => onKeyDown(e, { r, c })}
                      type={field === "contactNumber" ? "tel" : "text"}
                      list={field === "feedback" && writable ? "referee-call-feedback" : undefined}
                      aria-label={`${LABEL[field]}, row ${r + 1}`}
                      className={`min-h-10 w-full bg-transparent px-3 py-2 text-[13px] leading-5 text-ink outline-none ${writable ? "focus:bg-paper focus:ring-1 focus:ring-brand" : "cursor-default"}`}
                    />
                  </td>;
                })}
                {showTa && <td className="border border-rule px-3 py-2 text-[12px] text-ink-soft">{row.addedBy ? userNames[row.addedBy] ?? "Unknown" : "—"}</td>}
              </tr>;
            })}
            {!rows.length && <tr><td colSpan={showTa ? 6 : 5} className="px-5 py-10 text-center text-[13px] text-ink-faint">No referee calls were logged for this day.</td></tr>}
          </tbody>
        </table>
      </div>
      {canEdit && (
        <div className="mt-2 flex flex-wrap items-center gap-3 text-[11.5px] text-ink-faint">
          <button type="button" onClick={() => setRows((current) => [...current, emptyRow(newKey())])} className="text-[12.5px] font-medium text-brand hover:underline">+ Add row</button>
          <span>Type anywhere, or paste rows from Excel. Drag or Shift+arrows to select; click # to select a row. Nothing is saved until you click Save (or Ctrl+S).</span>
        </div>
      )}
    </div>
  );
}
