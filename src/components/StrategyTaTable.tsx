"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { acceptStrategyAssignmentsInline, removeStrategyProofInline, submitStrategyUpdateInline } from "@/app/actions";
import { ActionNote, SubmitButton, submitted, useInline } from "./Submit";
import { inputClass } from "./form";

export interface TaStrategyRow {
  rowId: string;
  name: string;
  description: string | null;
  /** Struck through by the lead: cannot be used on this job. Read only. */
  struck: boolean;
  doneBy: string[];
  doneByIds?: string[];
  acceptance: "not_assigned" | "pending" | "accepted";
  submittedById?: string | null;
  submittedByName?: string | null;
  assignedLabel: string;
  /** The Date Done as an input value ("YYYY-MM-DD"), or "". */
  doneAtValue: string;
  used: boolean;
  note: string;
  submittedLabel: string | null;
  proofs: { id: string; submitted: boolean }[];
}

/**
 * The TA's side of a job's strategy table (8 Oct): the strategies ticked for
 * the job (9 Oct), and the ones struck through (crossed out, so they know not to
 * use them). Colleagues on the same job see what each other is working on.
 * Filling in a ticked row nobody put them on puts them on it. They tick what they used, set the date, say what they did and any
 * improvement, optionally attach a picture as proof, and press Submit; the TA
 * Lead reads it from then. A picture can be attached before submitting but stays
 * theirs alone until they do.
 */
export function StrategyTaTable({
  openingId,
  rows,
  currentUserId,
}: {
  openingId: string;
  rows: TaStrategyRow[];
  currentUserId?: string;
}) {
  const router = useRouter();
  const [state, setState] = useState(() =>
    Object.fromEntries(rows.map((r) => [r.rowId, { used: r.used, date: r.doneAtValue, note: r.note }])),
  );
  const [uploading, setUploading] = useState<string | null>(null);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const files = useRef<Record<string, HTMLInputElement | null>>({});
  const submit = useInline(submitStrategyUpdateInline);
  const accept = useInline(acceptStrategyAssignmentsInline);
  const remove = useInline(removeStrategyProofInline);

  const isRowMine = (r: TaStrategyRow) =>
    !currentUserId ||
    (r.doneByIds?.includes(currentUserId) ?? false) ||
    (r.doneByIds?.length ?? 0) === 0;

  const pending = rows.filter((r) => !r.struck && isRowMine(r) && r.acceptance === "pending");
  const editable = rows.filter((r) => !r.struck && isRowMine(r) && r.acceptance !== "pending");
  const set = (id: string, patch: Partial<{ used: boolean; date: string; note: string }>) =>
    setState((s) => ({ ...s, [id]: { ...(s[id] ?? { used: false, date: "", note: "" }), ...patch } }));

  async function upload(rowId: string, file: File | undefined) {
    if (!file) return;
    setUploadError(null);
    setUploading(rowId);
    try {
      const body = new FormData();
      body.set("rowId", rowId);
      body.set("file", file);
      const res = await fetch("/api/strategy-proof", { method: "POST", body });
      const out = (await res.json().catch(() => null)) as { ok?: boolean; message?: string } | null;
      if (!res.ok || !out?.ok) setUploadError(out?.message ?? "The picture could not be added. Try again.");
      else router.refresh();
    } catch {
      setUploadError("The picture could not be added. Check your connection and try again.");
    } finally {
      setUploading(null);
      if (files.current[rowId]) files.current[rowId]!.value = "";
    }
  }

  const th = "border-b border-rule bg-paper px-3 py-2.5 text-left text-[11px] font-semibold uppercase tracking-wider text-ink-faint";
  const td = "border-b border-rule px-3 py-3 align-top text-[12.5px]";

  return (
    <form onSubmit={(e) => submit.run(submitted(e).formData)} className="flex flex-col gap-4">
      <input type="hidden" name="openingId" value={openingId} />
      {editable.map((r) => (
        <input key={r.rowId} type="hidden" name="rowId" value={r.rowId} />
      ))}

      {pending.length > 0 && (
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-warn/40 bg-warn-soft px-4 py-3">
          <div>
            <p className="text-[13px] font-medium text-warn">
              {pending.length} new {pending.length === 1 ? "strategy is" : "strategies are"} waiting for your acceptance
            </p>
            <p className="mt-0.5 text-[11.5px] text-ink-soft">Accept them together before you start working on those rows.</p>
          </div>
          <button
            type="button"
            disabled={accept.pending}
            onClick={() => {
              const fd = new FormData();
              fd.set("openingId", openingId);
              accept.run(fd);
            }}
            className="rounded-full bg-brand px-5 py-2 text-[12.5px] font-medium text-white hover:opacity-90 disabled:opacity-60"
          >
            {accept.pending ? "Accepting…" : `Accept all ${pending.length} ${pending.length === 1 ? "strategy" : "strategies"}`}
          </button>
        </div>
      )}
      <ActionNote result={accept.result} />

      <div className="overflow-x-auto rounded-xl border border-rule bg-surface">
        <table className="w-full min-w-[900px] border-collapse">
          <thead>
            <tr>
              <th className={th}>Strategy</th>
              <th className={th}>Done by</th>
              <th className={th}>Date assigned</th>
              <th className={th}>Used</th>
              <th className={th}>Date done</th>
              <th className={th}>What you did, and any improvement</th>
              <th className={th}>Proof (optional)</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => {
              const s = state[r.rowId] ?? { used: r.used, date: r.doneAtValue, note: r.note };
              if (r.struck) {
                return (
                  <tr key={r.rowId} className="bg-paper/60">
                    <td className={td} colSpan={7}>
                      <span className="font-medium text-ink-faint line-through">{r.name}</span>
                      <span className="ml-3 text-[12px] text-ink-faint">Not for this job. Your TA Lead has said it cannot be used here.</span>
                    </td>
                  </tr>
                );
              }

              const mine = isRowMine(r);
              const canWork = mine && r.acceptance !== "pending";

              return (
                <tr key={r.rowId}>
                  <td className={td}>
                    <span className="font-medium text-ink">{r.name}</span>
                    {r.description && <span className="mt-0.5 block text-[11.5px] leading-snug text-ink-faint">{r.description}</span>}
                    {r.submittedLabel && <span className="mt-1 block text-[11px] text-brand">{r.submittedLabel}</span>}
                  </td>
                  <td className={td}>
                    <span className="text-ink">{r.doneBy.length ? r.doneBy.join(", ") : "—"}</span>
                  </td>
                  <td className={`${td} whitespace-nowrap text-ink-soft`}>{r.assignedLabel}</td>
                  <td className={td}>
                    {canWork ? (
                      <label className="flex items-center gap-2">
                        <input
                          type="checkbox"
                          name={`used_${r.rowId}`}
                          checked={s.used}
                          onChange={(e) => set(r.rowId, { used: e.target.checked })}
                          className="h-4 w-4 accent-[var(--brand,#165b42)]"
                        />
                        <span className="text-[12px] text-ink-soft">I used it</span>
                      </label>
                    ) : mine ? (
                      <span className="inline-flex rounded-full bg-warn-soft px-2.5 py-1 text-[11.5px] font-medium text-warn">Accept first</span>
                    ) : (
                      <div>
                        {r.used ? (
                          <span className="inline-flex items-center gap-1 rounded-full bg-brand-soft px-2.5 py-1 text-[11.5px] font-medium text-brand">
                            ✓ Used
                          </span>
                        ) : (
                          <span className="inline-flex items-center rounded-full bg-tag px-2.5 py-1 text-[11.5px] font-medium text-ink-soft">
                            Currently working
                          </span>
                        )}
                      </div>
                    )}
                  </td>
                  <td className={td}>
                    {canWork ? (
                      <input
                        type="date"
                        name={`date_${r.rowId}`}
                        value={s.date}
                        disabled={!s.used}
                        onChange={(e) => set(r.rowId, { date: e.target.value })}
                        aria-label={`Date you used ${r.name}`}
                        className={`${inputClass} !w-[140px] !py-1 !text-[12px] disabled:opacity-40`}
                      />
                    ) : (
                      <span className="tabular text-[12px] text-ink">
                        {r.doneAtValue || <span className="text-ink-faint">—</span>}
                      </span>
                    )}
                  </td>
                  <td className={`${td} min-w-[240px]`}>
                    {canWork ? (
                      <textarea
                        name={`note_${r.rowId}`}
                        value={s.note}
                        onChange={(e) => set(r.rowId, { note: e.target.value })}
                        rows={3}
                        maxLength={500}
                        placeholder="Note…"
                        aria-label={`What you did with ${r.name}`}
                        className={`${inputClass} !py-1.5 !text-[12.5px]`}
                      />
                    ) : mine ? (
                      <span className="text-[12px] text-ink-faint">Accept this assignment to start.</span>
                    ) : (
                      <div>
                        {r.note ? (
                          <p className="whitespace-pre-wrap text-[12.5px] leading-relaxed text-ink">{r.note}</p>
                        ) : (
                          <span className="text-[12px] italic text-ink-faint">Currently working</span>
                        )}
                      </div>
                    )}
                  </td>
                  <td className={td}>
                    {canWork ? (
                      <div className="flex flex-wrap items-center gap-1.5">
                        {r.proofs.map((p) => (
                          <span key={p.id} className="relative">
                            <a
                              href={`/api/strategy-proof?row=${r.rowId}&proof=${encodeURIComponent(p.id)}`}
                              target="_blank"
                              rel="noopener noreferrer"
                              title={p.submitted ? "Open the picture" : "Open the picture (not submitted yet)"}
                            >
                              {/* eslint-disable-next-line @next/next/no-img-element */}
                              <img
                                src={`/api/strategy-proof?row=${r.rowId}&proof=${encodeURIComponent(p.id)}`}
                                alt={`Proof for ${r.name}`}
                                width={56}
                                height={56}
                                className={`h-14 w-14 rounded border object-cover ${p.submitted ? "border-rule" : "border-warn/60"}`}
                              />
                            </a>
                            <button
                              type="button"
                              title="Remove this picture"
                              aria-label={`Remove this picture from ${r.name}`}
                              onClick={() => {
                                const fd = new FormData();
                                fd.set("rowId", r.rowId);
                                fd.set("proofId", p.id);
                                remove.run(fd);
                              }}
                              className="absolute -right-1.5 -top-1.5 grid h-4 w-4 place-items-center rounded-full bg-ink text-[10px] leading-none text-surface"
                            >
                              ×
                            </button>
                          </span>
                        ))}
                        {r.proofs.length < 5 && (
                          <label className={`cursor-pointer rounded-full border border-rule px-3 py-1 text-[11.5px] font-medium text-ink-soft hover:border-brand-line hover:text-brand ${uploading === r.rowId ? "opacity-60" : ""}`}>
                            {uploading === r.rowId ? "Adding…" : "Add picture"}
                            <input
                              ref={(el) => { files.current[r.rowId] = el; }}
                              type="file"
                              accept="image/png,image/jpeg,image/webp"
                              className="sr-only"
                              disabled={uploading !== null}
                              onChange={(e) => upload(r.rowId, e.target.files?.[0])}
                            />
                          </label>
                        )}
                      </div>
                    ) : (
                      <div>
                        {r.proofs.length > 0 ? (
                          <span className="text-[11.5px] text-ink-soft">
                            {r.proofs.length} proof picture{r.proofs.length === 1 ? "" : "s"}
                          </span>
                        ) : (
                          <span className="text-[12px] text-ink-faint">—</span>
                        )}
                      </div>
                    )}
                    {canWork && r.proofs.some((p) => !p.submitted) && (
                      <span className="mt-1 block text-[11px] text-warn">Pictures marked in amber go to your TA Lead when you submit.</span>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {uploadError && <p className="text-[12.5px] text-warn" role="alert">{uploadError}</p>}
      <ActionNote result={remove.result} />

      {editable.length > 0 && (
        <div className="flex flex-wrap items-center gap-3">
          <SubmitButton busy={submit.pending} locked={submit.pending} pendingLabel="Submitting…" className="rounded-full bg-brand px-6 py-2.5 text-[13px] font-medium text-white shadow-sm transition-opacity hover:opacity-90 disabled:opacity-60">
            Submit update
          </SubmitButton>
          <span className="text-[11.5px] text-ink-faint">Your TA Lead sees what you submit, with any pictures. You can submit again whenever it changes.</span>
          <ActionNote result={submit.result} />
        </div>
      )}
    </form>
  );
}
