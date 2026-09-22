"use client";

import { useEffect, useState } from "react";
import { EFFORT_NUMBERS, OUTREACH_TYPES, effortColumns, type EffortKey, type EffortRow } from "@/lib/eod-format";
import { setWorkingStage } from "@/app/actions";

/**
 * The L-sheet, editable before it is sent (plan 6.1–6.3, 21 Sep).
 *
 * Every figure starts from the records and can be corrected; what kind of day
 * it was (100% / Follow-up / Add-on) is picked here, and switches the fourth
 * column between links approached and CVs. A target row is optional. The
 * inputs belong to the send form (`form=`), so what is sent is what is on
 * screen. Edits are kept in this browser until sent, so a reload loses
 * nothing; a changed figure is marked, with the record's figure on hover.
 */
export function EffortSheet({
  effort,
  formId,
  draftKey,
  openingId,
}: {
  effort: EffortRow;
  formId: string;
  draftKey: string;
  openingId?: string;
}) {
  type Draft = {
    kind: string;
    values: Partial<Record<EffortKey, string>>;
    targets: Partial<Record<EffortKey, string>>;
    /** The records' figures when the draft was kept, to tell an edit from a figure that has since grown. */
    base?: Partial<Record<EffortKey, string>>;
  };
  const initial: Draft = {
    kind: effort.hundredOrFollowUp || "100%",
    values: Object.fromEntries(EFFORT_NUMBERS.map((k) => [k, effort[k] == null ? "" : String(effort[k])])),
    targets: {},
  };
  const [draft, setDraft] = useState<Draft>(initial);

  useEffect(() => {
    if (effort.hundredOrFollowUp) {
      setDraft((d) => (d.kind === effort.hundredOrFollowUp ? d : { ...d, kind: effort.hundredOrFollowUp }));
    }
  }, [effort.hundredOrFollowUp]);

  useEffect(() => {
    const handleStageChange = (e: Event) => {
      const detail = (e as CustomEvent<{ openingId?: string; stage: string }>).detail;
      if (detail && (!openingId || !detail.openingId || detail.openingId === openingId)) {
        if (detail.stage && (OUTREACH_TYPES as readonly string[]).includes(detail.stage)) {
          setDraft((d) => {
            try {
              const held = JSON.parse(localStorage.getItem(draftKey) ?? "{}");
              localStorage.setItem(draftKey, JSON.stringify({ ...held, kind: detail.stage }));
            } catch {
              /* storage blocked */
            }
            return { ...d, kind: detail.stage };
          });
        }
      }
    };
    window.addEventListener("working-stage-changed", handleStageChange);
    return () => window.removeEventListener("working-stage-changed", handleStageChange);
  }, [openingId, draftKey]);

  useEffect(() => {
    try {
      const held = JSON.parse(localStorage.getItem(draftKey) ?? "null") as Draft | null;
      // Only what the TA changed is taken back. A kept draft replaced every
      // figure, so counts that grew later in the day stayed hidden behind the
      // morning's (review of PR #2, 21 Sep).
      if (held && held.values) {
        const values = { ...initial.values };
        for (const k of EFFORT_NUMBERS) {
          const v = held.values[k];
          if (v !== undefined && held.base && v !== held.base[k]) values[k] = v;
        }
        setDraft({ ...initial, kind: effort.hundredOrFollowUp || held.kind || initial.kind, targets: held.targets ?? {}, values });
      }
    } catch {
      /* nothing kept, or storage blocked: the records' figures */
    }
    // Only on first load; later edits are this draft's own.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draftKey]);
  useEffect(() => {
    try {
      localStorage.setItem(draftKey, JSON.stringify({ ...draft, base: initial.values }));
    } catch {
      /* not kept, still sent */
    }
    // initial.values is read, not watched: it is the records' figure this draft is measured against.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draft, draftKey]);
  // Sent means done: the next visit starts from the records again.
  useEffect(() => {
    const form = document.getElementById(formId);
    const clear = () => {
      try {
        localStorage.removeItem(draftKey);
      } catch {
        /* nothing kept */
      }
    };
    form?.addEventListener("submit", clear);
    return () => form?.removeEventListener("submit", clear);
  }, [formId, draftKey]);

  const cols = effortColumns(draft.kind);
  const th =
    "whitespace-nowrap border border-rule bg-tag px-2.5 py-2 text-left text-[10.5px] font-semibold uppercase tracking-[0.04em] text-ink-soft";
  const td = "border border-rule px-1.5 py-1 align-middle text-[12px]";
  const cell = "w-full min-w-[52px] rounded border border-transparent bg-transparent px-1 py-1 text-[12px] tabular-nums outline-none hover:border-rule focus:border-brand focus:bg-surface";

  return (
    <div className="overflow-x-auto">
      <table className="w-full border-collapse">
        <thead>
          <tr>
            {cols.map((c) => (
              <th key={c.key} className={th}>
                {c.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          <tr>
            {cols.map((c) => {
              if (c.key === "date") return <td key={c.key} className={`${td} px-2.5`}>{effort.date}</td>;
              if (c.key === "assignee") return <td key={c.key} className={`${td} px-2.5`}>{effort.assignee}</td>;
              if (c.key === "hundredOrFollowUp") {
                return (
                  <td key={c.key} className={td}>
                    <select
                      form={formId}
                      name="effort_kind"
                      value={draft.kind}
                      onChange={async (e) => {
                        const val = e.target.value;
                        setDraft((d) => ({ ...d, kind: val }));
                        window.dispatchEvent(
                          new CustomEvent("working-stage-changed", {
                            detail: { openingId, stage: val },
                          }),
                        );
                        if (openingId) {
                          const fd = new FormData();
                          fd.append("openingId", openingId);
                          fd.append("stage", val);
                          await setWorkingStage(fd);
                        }
                      }}
                      className="w-full rounded border border-rule bg-surface px-1 py-1 text-[12px] outline-none focus:border-brand"
                    >
                      {OUTREACH_TYPES.map((t) => (
                        <option key={t}>{t}</option>
                      ))}
                    </select>
                  </td>
                );
              }
              const k = c.key as EffortKey;
              const recorded = effort[k] == null ? "" : String(effort[k]);
              const changed = (draft.values[k] ?? "") !== recorded;
              return (
                <td key={c.key} className={`${td} ${changed ? "bg-warn-soft/60" : ""}`} title={changed ? `From the records: ${recorded || "—"}` : undefined}>
                  <input
                    form={formId}
                    name={`effort_${k}`}
                    inputMode="numeric"
                    value={draft.values[k] ?? ""}
                    onChange={(e) => setDraft({ ...draft, values: { ...draft.values, [k]: e.target.value.replace(/[^\d]/g, "") } })}
                    aria-label={c.label}
                    className={cell}
                  />
                </td>
              );
            })}
          </tr>
          <tr>
            {cols.map((c, i) => {
              if (i === 0) return <td key={c.key} className={`${td} px-2.5 text-[11px] text-ink-faint`} />;
              if (c.key === "assignee") return <td key={c.key} className={`${td} px-2.5 text-[11px] italic text-ink-faint`}>Target</td>;
              if (c.key === "hundredOrFollowUp") return <td key={c.key} className={td} />;
              const k = c.key as EffortKey;
              const target = Number(draft.targets[k] ?? "");
              const value = Number(draft.values[k] ?? "");
              const met = draft.targets[k] ? (value >= target ? "text-brand" : "text-warn") : "";
              return (
                <td key={c.key} className={td}>
                  <input
                    form={formId}
                    name={`target_${k}`}
                    inputMode="numeric"
                    placeholder="—"
                    value={draft.targets[k] ?? ""}
                    onChange={(e) => setDraft({ ...draft, targets: { ...draft.targets, [k]: e.target.value.replace(/[^\d]/g, "") } })}
                    aria-label={`${c.label} target`}
                    className={`${cell} ${met}`}
                  />
                </td>
              );
            })}
          </tr>
        </tbody>
      </table>
      <p className="mt-2 flex flex-wrap items-center gap-3 text-[11.5px] text-ink-faint">
        <span>
          Every figure can be corrected before sending; a shaded cell differs from the records. The fourth column counts{" "}
          {draft.kind === "Follow-up" ? "CVs brought in" : "profiles approached"} for a {draft.kind} day. Targets are optional —
          green once met.
        </span>
        <button type="button" onClick={() => setDraft(initial)} className="text-accent hover:underline">
          Put back the records&rsquo; figures
        </button>
      </p>
    </div>
  );
}
