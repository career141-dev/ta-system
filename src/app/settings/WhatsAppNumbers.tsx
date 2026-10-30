"use client";

import { checkWhatsAppNumber } from "@/app/demoSendActions";
import { ActionNote, SubmitButton, submitted, useInline } from "@/components/Submit";

export type NumberRow = {
  id: string;
  name: string;
  phone: string;
  phoneId: string;
  wabaId: string | null;
  taName: string | null;
  ready: boolean | null;
  readyNote: string | null;
  checkedAt: number | null;
};

const BTN = "rounded-full border border-rule px-3 py-1 text-[12px] font-medium hover:bg-tag disabled:opacity-60";

/** Settings → WhatsApp numbers: which line each TA's candidates hear from, and a check with Meta per number. */
export function WhatsAppNumbers({ rows }: { rows: NumberRow[] }) {
  const check = useInline(checkWhatsAppNumber);
  return (
    <form onSubmit={(e) => check.run(submitted(e).formData)} className="space-y-3">
      <div className="overflow-x-auto rounded-2xl border border-rule bg-surface">
        <table className="w-full text-left text-[12.5px]">
          <thead className="text-ink-soft">
            <tr className="border-b border-rule">
              <th className="px-4 py-2.5 font-medium">Number</th>
              <th className="px-4 py-2.5 font-medium">TA</th>
              <th className="px-4 py-2.5 font-medium">Sends?</th>
              <th className="px-4 py-2.5" />
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id} className="border-b border-rule last:border-0 align-top">
                <td className="px-4 py-2.5">
                  <div className="font-medium">{r.phone}</div>
                  <div className="text-ink-faint">{r.name}</div>
                </td>
                <td className="px-4 py-2.5">{r.taName ?? <span className="text-ink-faint">—</span>}</td>
                <td className="px-4 py-2.5 max-w-[420px]">
                  {r.ready === true ? (
                    <span className="text-brand">Yes</span>
                  ) : r.ready === false ? (
                    <span className="text-warn">No — the main line sends instead</span>
                  ) : (
                    <span className="text-ink-soft">As before (not a TA number)</span>
                  )}
                  {r.readyNote && <div className="mt-0.5 text-ink-faint">{r.readyNote}</div>}
                  {r.checkedAt && (
                    <div className="text-ink-faint">Checked {new Date(r.checkedAt).toLocaleString("en-GB", { dateStyle: "medium", timeStyle: "short" })}</div>
                  )}
                </td>
                <td className="px-4 py-2.5 text-right">
                  {r.wabaId && (
                    <SubmitButton name="check" value={r.id} busy={check.pending} locked={check.pending} className={BTN}>
                      Check with Meta
                    </SubmitButton>
                  )}
                </td>
              </tr>
            ))}
            {rows.length === 0 && (
              <tr>
                <td colSpan={4} className="px-4 py-6 text-center text-ink-soft">
                  No numbers listed. Every message goes from the main line, +94 74 219 7476.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
      <ActionNote result={check.result} />
    </form>
  );
}
