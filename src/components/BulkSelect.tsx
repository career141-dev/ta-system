"use client";

import { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";
import type { ActionResult } from "@/lib/inlineResult";
import { ActionNote, Spinner, SubmitButton } from "./Submit";
import { Confirm } from "./Confirm";
import { STAGE_LABEL, type Stage } from "@/data/types";
import { moveSelectedCandidates } from "@/app/actions";

/**
 * Tick several rows, then act on all of them at once (25 Sep).
 *
 * The rows are drawn by the server and already hold forms of their own, and a
 * form cannot sit inside another. So each row's box names the bar's form with
 * the `form` attribute instead of sitting in it: the bar's buttons then send
 * every ticked row, through the same server actions and the same permission
 * checks as the one-at-a-time buttons.
 */

const Selected = createContext(0);

/** One row's tick box. `name` is what the bar's action reads: "appId", "candidateId", "openingId" … */
export function RowCheck({ form, name, value, label }: { form: string; name: string; value: string; label: string }) {
  return (
    <input
      type="checkbox"
      form={form}
      name={name}
      value={value}
      aria-label={`Select ${label}`}
      className="h-5 w-5 shrink-0 cursor-pointer accent-brand sm:h-4 sm:w-4"
    />
  );
}

/**
 * The bar above a list: Select all, how many are ticked and, once any are, the
 * actions. Put hidden inputs and action buttons in as children — they sit
 * inside the form, so `SubmitButton` shows its spinner as usual.
 */
export function BulkBar({
  form,
  noun,
  action,
  children,
}: {
  form: string;
  noun: [one: string, many: string];
  /** What a plain submit in the bar does — the one a `BulkConfirm` sends. Other buttons pass `formAction`. */
  action?: (formData: FormData) => void | Promise<void>;
  children: React.ReactNode;
}) {
  const [count, setCount] = useState(0);
  const [total, setTotal] = useState(0);
  const all = useRef<HTMLInputElement | null>(null);

  const boxes = useCallback(
    () => [...document.querySelectorAll<HTMLInputElement>(`input[type="checkbox"][form="${form}"]`)],
    [form],
  );
  const recount = useCallback(() => {
    const b = boxes();
    setTotal(b.length);
    setCount(b.filter((x) => x.checked).length);
  }, [boxes]);

  useEffect(() => {
    recount();
    document.addEventListener("change", recount);
    // Rows come and go when the page refreshes after an action; the count
    // follows what is actually on screen.
    const watch = new MutationObserver(recount);
    watch.observe(document.body, { childList: true, subtree: true });
    return () => {
      document.removeEventListener("change", recount);
      watch.disconnect();
    };
  }, [recount]);

  useEffect(() => {
    if (all.current) all.current.indeterminate = count > 0 && count < total;
  }, [count, total]);

  const setAll = (on: boolean) => {
    for (const b of boxes()) b.checked = on;
    recount();
  };

  if (total === 0) return null;

  return (
    <form
      id={form}
      action={action}
      className="sticky top-[68px] z-20 mb-3 flex min-h-[46px] flex-wrap items-center gap-x-3 gap-y-2 rounded-xl border border-rule bg-surface/95 px-4 py-2 shadow-sm backdrop-blur"
    >
      <label className="flex cursor-pointer items-center gap-2 text-[12.5px] text-ink-soft">
        <input
          ref={all}
          type="checkbox"
          aria-label="Select all on this page"
          checked={count > 0 && count === total}
          onChange={(e) => setAll(e.currentTarget.checked)}
          className="h-4 w-4 cursor-pointer accent-brand"
        />
        {count === 0 ? (
          `Select all ${total} on this page`
        ) : (
          <span className="font-medium text-ink">
            {count} {count === 1 ? noun[0] : noun[1]} selected
          </span>
        )}
      </label>
      <Selected.Provider value={count}>
        <div className={`flex flex-wrap items-center gap-2 ${count === 0 ? "hidden" : ""}`}>
          {children}
          <button
            type="button"
            onClick={() => setAll(false)}
            className="px-1.5 text-[12px] text-ink-soft transition-colors hover:text-ink"
          >
            Clear
          </button>
        </div>
      </Selected.Provider>
    </form>
  );
}

/** A destructive action for everything ticked, confirmed in place like every other delete. */
export function BulkConfirm({
  label,
  noun,
  warning,
}: {
  /** The button, and the verb of the question: "Delete", "Remove from this job". */
  label: string;
  noun: [one: string, many: string];
  warning: string;
}) {
  const n = useContext(Selected);
  return <Confirm label={label} question={`${label} ${n} ${n === 1 ? noun[0] : noun[1]}? ${warning}`} confirmLabel={`${label.split(" ")[0]} ${n}`} />;
}

/** Shares the bar's form; no nested form and no bypass of the individual stage action. */
export function BulkStageControls({ stages }: { stages: Stage[] }) {
  const [stage, setStage] = useState("");
  if (!stages.length) return null;
  return (
    <>
      <select name="stage" aria-label="Stage for selected candidates" value={stage} onChange={(e) => setStage(e.target.value)} className="rounded-full border border-rule bg-surface px-3 py-1.5 text-[12.5px]">
        <option value="">Choose stage</option>
        {stages.map((s) => <option key={s} value={s}>{STAGE_LABEL[s]}</option>)}
      </select>
      {(stage === "rejected" || stage === "dropped_out") && (
        <input name="reason" aria-label="Reason for moving selected candidates" placeholder="Reason (required)" onKeyDown={(e) => {
          // The bar also has shortlist/remove buttons. Enter in a reason must
          // not implicitly submit whichever action happens to come first.
          if (e.key === "Enter") e.preventDefault();
        }} className="rounded-full border border-rule px-3 py-1.5 text-[12.5px]" />
      )}
      <SubmitButton formAction={moveSelectedCandidates} disabled={!stages.includes(stage as Stage)} pendingLabel="Moving…" tone="dark" className="rounded-full border border-brand-line px-3.5 py-1.5 text-[12.5px] font-medium text-brand disabled:opacity-60">
        Move selected
      </SubmitButton>
      <span className="text-[11.5px] text-ink-faint">Each candidate must meet the stage requirements.</span>
    </>
  );
}

/**
 * Every ticked person's CV in one ZIP, each file named after the person
 * (api/cv/zip). Anyone without a CV on file is named, not silently left out.
 */
export function DownloadCvsButton({ field }: { field: "appId" | "candidateId" }) {
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<ActionResult | null>(null);
  const say = (message: string, tone: ActionResult["tone"]) => setResult({ ok: tone !== "error", message, tone, at: Date.now() });

  const download = async (form: HTMLFormElement | null) => {
    if (!form || busy) return;
    const ids = new FormData(form).getAll(field).map(String);
    if (ids.length === 0) return;
    setBusy(true);
    setResult(null);
    try {
      const res = await fetch("/api/cv/zip", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(field === "appId" ? { appIds: ids } : { candidateIds: ids }),
      });
      if (!res.ok) {
        say((await res.text()) || "The CVs could not be downloaded.", "error");
        return;
      }
      const missing: string[] = JSON.parse(decodeURIComponent(res.headers.get("x-missing-cvs") ?? "%5B%5D"));
      const got = Number(res.headers.get("x-cv-count") ?? 0);
      const blob = await res.blob();
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = `CVs ${new Date().toISOString().slice(0, 10)}.zip`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 10_000);
      say(
        `${got} ${got === 1 ? "CV" : "CVs"} downloaded.${missing.length ? ` No CV on file for: ${missing.join(", ")}.` : ""}`,
        missing.length ? "warn" : "ok",
      );
    } catch {
      say("The CVs could not be downloaded — check the connection and try again.", "error");
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <button
        type="button"
        disabled={busy}
        aria-busy={busy}
        onClick={(e) => download(e.currentTarget.form)}
        className="inline-flex items-center gap-2 rounded-full border border-rule px-3.5 py-1.5 text-[12.5px] font-medium text-ink transition-colors hover:bg-tag disabled:opacity-60"
      >
        {busy && <Spinner tone="dark" />}
        {busy ? "Preparing ZIP…" : "Download CVs"}
      </button>
      {result && <ActionNote result={result} className="basis-full" />}
    </>
  );
}
