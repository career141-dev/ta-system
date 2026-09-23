"use client";

import { startTransition, useActionState, useEffect, useState, type FormEvent } from "react";
import { useFormStatus } from "react-dom";
import { useRouter } from "next/navigation";
import type { ActionResult } from "@/lib/inlineResult";

/**
 * A submit button that shows it was pressed.
 *
 * Most buttons on the desk gave no sign between the click and the page coming
 * back: nothing disabled, nothing moving, so testers clicked again or assumed
 * it was broken (21 Sep — Save job, Save job details, Save notes, Add). This
 * disables every button in the form while one runs, so nothing is sent twice,
 * and puts a spinner and `pendingLabel` on the one that was pressed.
 *
 * Inside a plain `<form action>` it reads `useFormStatus`. A form driven by
 * `useInline` passes `busy` (this button's action is running) and `locked`
 * (any of the form's actions is) instead.
 */
export function SubmitButton({
  children,
  pendingLabel,
  formAction,
  className,
  tone = "light",
  disabled,
  formNoValidate,
  name,
  value,
  busy,
  locked,
}: {
  children: React.ReactNode;
  pendingLabel?: string;
  formAction?: (formData: FormData) => void | Promise<void>;
  className: string;
  /** The spinner's colour: "light" on a filled button, "dark" on an outline or text one. */
  tone?: "light" | "dark";
  disabled?: boolean;
  formNoValidate?: boolean;
  /** Which button was pressed, for a form with two (see `submitted`). */
  name?: string;
  value?: string;
  busy?: boolean;
  locked?: boolean;
}) {
  const status = useFormStatus();
  const mine = busy ?? (status.pending && (!formAction || status.action === formAction));
  const lock = locked ?? status.pending;
  return (
    <button
      type="submit"
      name={name}
      value={value}
      formAction={formAction}
      formNoValidate={formNoValidate}
      disabled={disabled || lock}
      aria-busy={mine}
      className={`inline-flex items-center justify-center gap-2 ${className}`}
    >
      {mine && <Spinner tone={tone} />}
      {mine && pendingLabel ? pendingLabel : children}
    </button>
  );
}

export function Spinner({ tone = "light" }: { tone?: "light" | "dark" }) {
  const ring = tone === "light" ? "border-white/40 border-t-white" : "border-ink-faint/40 border-t-ink";
  return <span aria-hidden="true" className={`h-3.5 w-3.5 shrink-0 animate-spin rounded-full border-2 ${ring}`} />;
}

/**
 * What the last press did, said beside the button.
 *
 * Success fades after a few seconds — it has been read. A warning or an error
 * stays until the next try, because it asks the person to do something.
 */
export function ActionNote({ result, className = "" }: { result: ActionResult | null; className?: string }) {
  const [hidden, setHidden] = useState<number | null>(null);

  useEffect(() => {
    if (!result || result.tone !== "ok") return;
    const t = setTimeout(() => setHidden(result.at), 6000);
    return () => clearTimeout(t);
  }, [result]);

  if (!result || hidden === result.at) return null;

  const look =
    result.tone === "ok"
      ? "border-brand/25 bg-brand-soft text-brand"
      : result.tone === "warn"
        ? "border-warn/40 bg-warn-soft text-warn"
        : "border-danger/30 bg-danger-soft text-danger";
  const mark = result.tone === "ok" ? "✓" : result.tone === "warn" ? "!" : "✕";

  return (
    <p
      role={result.tone === "ok" ? "status" : "alert"}
      className={`flex items-start gap-2 rounded-lg border px-3 py-2 text-[12.5px] leading-snug ${look} ${className}`}
    >
      <span aria-hidden="true" className="font-semibold">
        {mark}
      </span>
      <span>
        {result.message}
        {result.tone === "ok" && (
          <span className="ml-1.5 text-[11px] opacity-70">· {new Date(result.at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</span>
        )}
      </span>
    </p>
  );
}

/** Of two forms' answers, the more recent — for a panel with two buttons sharing one note. */
export function latest(...results: (ActionResult | null)[]): ActionResult | null {
  return results.reduce<ActionResult | null>((a, b) => (!b ? a : !a || b.at > a.at ? b : a), null);
}

/**
 * An inline action, run from the form's onSubmit.
 *
 * Not `<form action>`: React 19 resets an uncontrolled form once its action
 * finishes, so a refused save would wipe everything the person had typed. Here
 * the form is left alone and the answer comes back as `result`.
 */
export function useInline(action: (prev: ActionResult | null, formData: FormData) => Promise<ActionResult>) {
  const router = useRouter();
  const [result, dispatch, pending] = useActionState(action, null);
  const run = (formData: FormData) => startTransition(() => dispatch(formData));

  useEffect(() => {
    if (result && result.tone === "ok") {
      router.refresh();
    }
  }, [result, router]);

  return { result, pending, run };
}

/** The form's data, including the name/value of the button that sent it. */
export function submitted(e: FormEvent<HTMLFormElement>): { formData: FormData; pressed: string | null } {
  e.preventDefault();
  const submitter = (e.nativeEvent as SubmitEvent).submitter as HTMLButtonElement | null;
  return { formData: new FormData(e.currentTarget, submitter), pressed: submitter?.value ?? null };
}
