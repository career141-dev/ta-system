"use client";

import { addRefereeCall, removeRefereeCall, updateRefereeCall } from "@/app/actions";
import type { RefereeCall } from "@/data/types";
import { useEffect, useRef, useState, useTransition } from "react";

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

type EditableField = "company" | "referral" | "contactNumber" | "feedback";
type GridRow = RefereeCall & { localKey: string; draft?: boolean };

export function RefereeCallsGrid({
  openingId,
  actorId,
  workLocationId,
  calls,
  editable,
  canAdd = editable,
  showTa,
  userNames,
}: {
  openingId: string;
  actorId: string;
  workLocationId?: string;
  calls: RefereeCall[];
  editable: boolean;
  canAdd?: boolean;
  showTa: boolean;
  userNames: Record<string, string>;
}) {
  const [rows, setRows] = useState<GridRow[]>(() => calls.map((row) => ({ ...row, localKey: row.id })));
  const rowsRef = useRef(rows);
  const timers = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  const creating = useRef(new Set<string>());
  const [messages, setMessages] = useState<Record<string, { ok: boolean; text: string }>>({});
  const [, startTransition] = useTransition();
  useEffect(() => { rowsRef.current = rows; }, [rows]);
  useEffect(() => () => { for (const timer of timers.current.values()) clearTimeout(timer); }, []);

  const status = (key: string, ok: boolean, text: string) =>
    setMessages((current) => ({ ...current, [key]: { ok, text } }));

  const formFor = (row: GridRow) => {
    const form = new FormData();
    form.set("openingId", openingId);
    form.set("workLocationId", workLocationId ?? "");
    form.set("company", row.company);
    form.set("referral", row.referral);
    form.set("contactNumber", row.contactNumber ?? "");
    form.set("feedback", row.feedback);
    return form;
  };

  const create = async (localKey: string) => {
    if (creating.current.has(localKey)) return;
    const row = rowsRef.current.find((item) => item.localKey === localKey);
    if (!row || ![row.company, row.referral, row.contactNumber, row.feedback].some((value) => String(value ?? "").trim())) return;
    creating.current.add(localKey);
    status(localKey, true, "Saving…");
    const result = await addRefereeCall(formFor(row));
    creating.current.delete(localKey);
    if (!result.ok || !result.call) return status(localKey, false, "Could not save — try again");
    setRows((current) => current.map((item) => item.localKey === localKey ? { ...item, id: result.call!.id, draft: false } : item));
    status(localKey, true, "Saved");

    // If typing continued while the insert was in flight, bring every newer
    // cell across to the stored row instead of snapping back to the old text.
    const latest = rowsRef.current.find((item) => item.localKey === localKey);
    if (latest) for (const field of ["company", "referral", "contactNumber", "feedback"] as EditableField[]) {
      if (String(latest[field] ?? "") === String(result.call[field] ?? "")) continue;
      const form = new FormData();
      form.set("openingId", openingId);
      form.set("callId", result.call.id);
      form.set("field", field);
      form.set("value", String(latest[field] ?? ""));
      await updateRefereeCall(form);
    }
  };

  const save = (row: GridRow, field: EditableField, value: string) => {
    setRows((current) => current.map((item) => item.localKey === row.localKey ? { ...item, [field]: value } : item));
    status(row.localKey, true, "Saving…");
    const old = timers.current.get(row.localKey);
    if (old) clearTimeout(old);
    timers.current.set(row.localKey, setTimeout(() => {
      const latest = rowsRef.current.find((item) => item.localKey === row.localKey);
      if (!latest) return;
      if (latest.draft || !latest.id) return void create(latest.localKey);
      startTransition(async () => {
        const form = new FormData();
        form.set("openingId", openingId);
        form.set("callId", latest.id);
        form.set("field", field);
        form.set("value", String(latest[field] ?? ""));
        const result = await updateRefereeCall(form);
        status(latest.localKey, result.ok, result.ok ? "Saved" : "Could not save — try again");
      });
    }, 650));
  };

  const addRow = () => {
    const previousCompany = rows.at(-1)?.company ?? "";
    const localKey = `draft_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
    setRows((current) => [...current, {
      id: "",
      localKey,
      draft: true,
      openingId,
      ...(workLocationId ? { workLocationId } : {}),
      addedBy: "",
      date: "",
      company: previousCompany,
      referral: "",
      contactNumber: "",
      feedback: "",
      createdAt: Date.now(),
      updatedAt: Date.now(),
    }]);
  };

  const remove = (row: GridRow) => {
    const timer = timers.current.get(row.localKey);
    if (timer) clearTimeout(timer);
    if (!row.id) {
      setRows((current) => current.filter((item) => item.localKey !== row.localKey));
      return;
    }
    status(row.localKey, true, "Removing…");
    startTransition(async () => {
      const form = new FormData();
      form.set("openingId", openingId);
      form.set("callId", row.id);
      const result = await removeRefereeCall(form);
      if (result.ok) setRows((current) => current.filter((item) => item.localKey !== row.localKey));
      else status(row.localKey, false, "Could not remove — try again");
    });
  };

  const th = "border border-rule bg-tag px-3 py-2 text-left text-[11px] font-semibold uppercase tracking-[0.05em] text-ink-soft";
  const td = "border border-rule bg-surface p-0 align-top";
  const input = "min-h-10 w-full bg-transparent px-3 py-2 text-[13px] leading-5 text-ink outline-none focus:bg-paper";

  return (
    <div className="overflow-x-auto rounded-xl border border-rule bg-surface">
      <datalist id="referee-call-feedback">{ANSWERS.map((answer) => <option key={answer} value={answer} />)}</datalist>
      <table className="w-full min-w-[760px] border-collapse">
        <thead><tr>
          <th className={`${th} w-12 text-center`}>#</th>
          <th className={th}>Company</th>
          <th className={th}>Referral</th>
          <th className={th}>Contact Number</th>
          <th className={`${th} min-w-[270px]`}>Feedback</th>
          {showTa && <th className={`${th} w-36`}>TA</th>}
          {editable && <th className={`${th} w-24`}><span className="sr-only">Actions</span></th>}
        </tr></thead>
        <tbody>
          {rows.map((row, index) => {
            const mine = editable && (!row.addedBy || row.addedBy === actorId);
            const mayEdit = mine && (row.draft || calls.some((call) => call.id === row.id));
            return <tr key={row.localKey}>
              <td className={`${td} px-3 py-2.5 text-center text-[12px] tabular-nums text-ink-faint`}>{index + 1}</td>
              {(["company", "referral", "contactNumber", "feedback"] as EditableField[]).map((field) => <td key={field} className={td}>
                {mayEdit ? <input
                  value={String(row[field] ?? "")}
                  onChange={(event) => save(row, field, event.target.value)}
                  type={field === "contactNumber" ? "tel" : "text"}
                  list={field === "feedback" ? "referee-call-feedback" : undefined}
                  aria-label={`${field} for row ${index + 1}`}
                  className={input}
                /> : <div className="min-h-10 whitespace-pre-wrap px-3 py-2 text-[13px] leading-5">{String(row[field] ?? "") || "—"}</div>}
              </td>)}
              {showTa && <td className={`${td} px-3 py-2 text-[12px] text-ink-soft`}>{userNames[row.addedBy] ?? "Unknown"}</td>}
              {editable && <td className={`${td} px-2 py-1.5`}>
                {mine && <button type="button" onClick={() => remove(row)} className="text-[11.5px] text-ink-faint hover:text-danger">Remove</button>}
                {messages[row.localKey] && <div className={`mt-0.5 text-[10.5px] ${messages[row.localKey].ok ? "text-brand" : "text-danger"}`}>{messages[row.localKey].text}</div>}
              </td>}
            </tr>;
          })}
          {canAdd && <tr>
            <td colSpan={5 + (showTa ? 1 : 0) + 1} className="border border-rule bg-paper/40 px-3 py-2">
              <button type="button" onClick={addRow} className="text-[12.5px] font-medium text-brand hover:underline">+ Add row</button>
              <span className="ml-3 text-[11.5px] text-ink-faint">Changes save as you type.</span>
            </td>
          </tr>}
          {!rows.length && !editable && <tr><td colSpan={6} className="px-5 py-10 text-center text-[13px] text-ink-faint">No referee calls were logged for this day.</td></tr>}
        </tbody>
      </table>
    </div>
  );
}
