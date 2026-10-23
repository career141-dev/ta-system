"use client";

import { updateRefereeCall } from "@/app/actions";
import type { RefereeCallEmailRow, RefereeCallResult } from "@/data/types";
import { useState, useTransition } from "react";

export function RefereeCallsEmailSection({ openingId, calls }: { openingId: string; calls: RefereeCallEmailRow[] }) {
  const [rows, setRows] = useState(calls);
  const [included, setIncluded] = useState(calls.length > 0);
  const [message, setMessage] = useState("");
  const [, startTransition] = useTransition();
  if (!calls.length) return null;

  const move = (call: RefereeCallEmailRow, result: RefereeCallResult) => {
    if (!call.id) return;
    const before = rows;
    setRows((current) => current.map((row) => row.id === call.id ? { ...row, result } : row));
    setMessage("Saving…");
    startTransition(async () => {
      const form = new FormData();
      form.set("openingId", openingId);
      form.set("callId", call.id!);
      form.set("field", "result");
      form.set("value", result);
      const answer = await updateRefereeCall(form);
      if (answer.ok) setMessage("Saved");
      else {
        setRows(before);
        setMessage("Could not save — try again");
      }
    });
  };

  const table = (result: RefereeCallResult, label: string, colours: string) => {
    const group = rows.filter((row) => row.result === result);
    if (!group.length) return null;
    return <div className="mb-4 overflow-hidden rounded-lg border border-rule">
      <div className={`border-b px-3 py-2 text-[12px] font-semibold ${colours}`}>{label}</div>
      <div className="overflow-x-auto">
        <table className="w-full min-w-[680px] border-collapse text-[12px]">
          <thead><tr className="bg-tag text-left text-[10.5px] uppercase tracking-[0.04em] text-ink-soft">
            {['#', 'Company', 'Referral', 'Contact Number', 'Feedback', ''].map((head, i) => <th key={`${head}:${i}`} className="border-b border-r border-rule px-2.5 py-2 font-semibold last:border-r-0">{head}</th>)}
          </tr></thead>
          <tbody>{group.map((call, index) => <tr key={call.id ?? `${result}:${index}`}>
            <td className="border-r border-t border-rule px-2.5 py-2 text-ink-faint">{index + 1}</td>
            <td className="border-r border-t border-rule px-2.5 py-2">{call.company}</td>
            <td className="border-r border-t border-rule px-2.5 py-2">{call.referral}</td>
            <td className="border-r border-t border-rule px-2.5 py-2">{call.contactNumber || "—"}</td>
            <td className="border-r border-t border-rule px-2.5 py-2">{call.feedback}</td>
            <td className="border-t border-rule px-2.5 py-2 text-right">
              {call.id && <button type="button" onClick={() => move(call, result === "positive" ? "negative" : "positive")} className="whitespace-nowrap text-[11px] font-medium text-brand hover:underline">
                Move to {result === "positive" ? "Not successful" : "Positive"}
              </button>}
            </td>
          </tr>)}</tbody>
        </table>
      </div>
    </div>;
  };

  return <section className="mt-6 border-t border-rule pt-5">
    <input form="eod-send" type="hidden" name="includeRefereeCalls" value={included ? "yes" : "no"} />
    <input form="eod-send" type="hidden" name="refereeCallResults" value={JSON.stringify(Object.fromEntries(rows.flatMap((row) => row.id ? [[row.id, row.result]] : [])))} />
    <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
      <label className="flex cursor-pointer items-center gap-2 text-[13px] font-semibold">
        <input type="checkbox" checked={included} onChange={(event) => setIncluded(event.target.checked)} className="h-4 w-4 rounded border-rule text-brand focus:ring-brand" />
        Include referee calls ({rows.length})
      </label>
      {message && <span className={`text-[11.5px] ${message.startsWith("Could") ? "text-danger" : "text-ink-faint"}`}>{message}</span>}
    </div>
    {included && <>
      <h3 className="mb-2 text-[13px] font-bold">Referee calls</h3>
      {table("positive", "Positive – contacts available", "border-[#b7dcc4] bg-[#e8f5ec] text-[#1b5e36]")}
      {table("negative", "Not successful", "border-[#f0c4c1] bg-[#fcebea] text-[#8a1f1b]")}
    </>}
  </section>;
}
