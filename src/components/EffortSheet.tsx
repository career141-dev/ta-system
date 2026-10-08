"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { EFFORT_NUMBERS, MANUAL_EFFORT, OUTREACH_TYPES, dayTotal, effortColumns, setsCell, type EffortKey, type EffortRow } from "@/lib/eod-format";
import { setWorkingStage } from "@/app/actions";

/**
 * The L-sheet, editable before it is sent (plan 6.1–6.3, 21 Sep).
 *
 * Every column starts from the records and can be corrected (28 Sep); the
 * day's total beside SETS is the CV columns added up, so a correction moves
 * it. What kind of day it was (100% / Follow-up / Add-on) is picked here, and
 * switches the fourth column between profiles scouted and CVs. A target row is optional. The inputs belong to the
 * send form (`form=`), so what is sent is what is on screen. Edits are kept in
 * this browser until sent, so a reload loses nothing; a corrected record
 * figure is marked, with the record's figure on hover.
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
  const router = useRouter();
  const [, startTransition] = useTransition();
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
    // A sent email's own targets, when it is opened to send again (8 Oct); the
    // records give none, so a new email starts blank as before.
    targets: Object.fromEntries(
      Object.entries(effort.targets ?? {}).flatMap(([k, t]) => (t == null || t === "" ? [] : [[k, String(t)]])),
    ),
  };
  const [draft, setDraft] = useState<Draft>(initial);
  // The draft as the page opened with it, before anything kept was read back.
  const opened = useRef(draft);

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
    // Not until the draft has changed: writing the opening figures straight
    // away replaced what was kept before it had been read back, and React's
    // development double-run of effects then read the blank copy — the TA's
    // typed figures were gone after a reload (25 Sep).
    if (draft === opened.current) return;
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
              if (c.key === "date") {
                return (
                  <td key={c.key} className={td}>
                    <input
                      form={formId}
                      name="effort_date"
                      value={draft.values["date" as EffortKey] ?? effort.date}
                      onChange={(e) => {
                        const val = e.target.value;
                        setDraft((d) => ({ ...d, values: { ...d.values, ["date" as EffortKey]: val } }));
                      }}
                      className={`${cell} min-w-[70px]`}
                    />
                  </td>
                );
              }
              if (c.key === "assignee") {
                return (
                  <td key={c.key} className={td}>
                    <input
                      form={formId}
                      name="effort_assignee"
                      value={draft.values["assignee" as EffortKey] ?? effort.assignee}
                      onChange={(e) => {
                        const val = e.target.value;
                        setDraft((d) => ({ ...d, values: { ...d.values, ["assignee" as EffortKey]: val } }));
                      }}
                      className={`${cell} min-w-[80px]`}
                    />
                  </td>
                );
              }
              if (c.key === "hundredOrFollowUp") {
                return (
                  <td key={c.key} className={td}>
                    <select
                      form={formId}
                      name="effort_kind"
                      value={draft.kind}
                      onChange={(e) => {
                        const val = e.target.value;
                        setDraft((d) => ({ ...d, kind: val }));
                        window.dispatchEvent(
                          new CustomEvent("working-stage-changed", {
                            detail: { openingId, stage: val },
                          }),
                        );
                        if (openingId) {
                          startTransition(async () => {
                            const fd = new FormData();
                            fd.append("openingId", openingId);
                            fd.append("stage", val);
                            await setWorkingStage(fd);
                            router.refresh();
                          });
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
              // A typed column has no record to differ from, so it is never marked.
              const manual = MANUAL_EFFORT.has(k);
              const changed = !manual && (draft.values[k] ?? "") !== recorded;
              return (
                <td key={c.key} className={`${td} ${changed ? "bg-warn-soft/60" : ""}`} title={changed ? `From the records: ${recorded || "—"}` : undefined}>
                  <input
                    form={formId}
                    name={`effort_${k}`}
                    inputMode={k === "sets" ? "text" : "numeric"}
                    placeholder={manual ? "—" : undefined}
                    value={draft.values[k] ?? ""}
                    onChange={(e) =>
                      setDraft({
                        ...draft,
                        values: {
                          ...draft.values,
                          [k]: k === "sets" ? e.target.value : e.target.value.replace(/[^\d]/g, ""),
                        },
                      })
                    }
                    aria-label={c.label}
                    className={`${cell} ${k === "sets" ? "min-w-[75px]" : ""}`}
                  />
                  {k === "sets" && (
                    // The day's total beside the set, as the email sends it (27 Sep).
                    <span className="block whitespace-nowrap px-1 text-[11px] tabular-nums text-ink-soft">
                      {setsCell(null, dayTotal(draft.values))}
                    </span>
                  )}
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
              const met = draft.targets[k] && !Number.isNaN(target) && !Number.isNaN(value) ? (value >= target ? "text-brand" : "text-warn") : "";
              return (
                <td key={c.key} className={td}>
                  <input
                    form={formId}
                    name={`target_${k}`}
                    inputMode={k === "sets" ? "text" : "numeric"}
                    placeholder="—"
                    value={draft.targets[k] ?? ""}
                    onChange={(e) =>
                      setDraft({
                        ...draft,
                        targets: {
                          ...draft.targets,
                          [k]: k === "sets" ? e.target.value : e.target.value.replace(/[^\d]/g, ""),
                        },
                      })
                    }
                    aria-label={`${c.label} target`}
                    className={`${cell} ${k === "sets" ? "min-w-[75px]" : ""} ${met}`}
                  />
                </td>
              );
            })}
          </tr>
        </tbody>
      </table>
      <p className="mt-2 flex flex-wrap items-center gap-3 text-[11.5px] text-ink-faint">
        <span>
          Filled in from the records, counting only the CVs you send the Director today. Each is in one column: BACK-UP if
          it is tagged Backup, else SCOOP if you uploaded it under Scoops (add any that came on WhatsApp), else ADD-ONS if it is
          an add-on, else DA if it came on WhatsApp, POST if it applied to a LinkedIn post, L if you hunted it in Excel
          Tables. Under SETS is those columns added up.
          A shaded cell differs from the records. The fourth
          column is {draft.kind === "Follow-up" ? "CVs sent to the Director" : "LinkedIn profiles scouted"} for a {draft.kind} day. Targets are
          optional — green once met.
        </span>
        <button
          type="button"
          // Only the records' columns go back; what the TA typed stays.
          onClick={() =>
            setDraft({
              ...draft,
              values: Object.fromEntries(EFFORT_NUMBERS.map((k) => [k, MANUAL_EFFORT.has(k) ? draft.values[k] ?? "" : initial.values[k]])),
            })
          }
          className="text-accent hover:underline"
        >
          Put back the records&rsquo; figures
        </button>
      </p>
    </div>
  );
}
