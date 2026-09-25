"use client";

import { useEffect, useRef, useState } from "react";
import { useFormStatus } from "react-dom";
import { Spinner } from "./Submit";

/**
 * The one way anything destructive is confirmed — finding 22.
 *
 * Not a modal. A modal steals the page, and the thing you are about to delete
 * is usually the thing you need to look at while deciding. This swaps the
 * button for a question in place, says what will go, and reverts on its own if
 * you click elsewhere or press Escape — so a stray click never arms a delete
 * that is still sitting there ten minutes later.
 *
 * It submits the form it sits in, so the server action and its permissions are
 * unchanged. Without JavaScript the button is an ordinary submit: the confirm
 * is a guard, never the mechanism.
 */
export function Confirm({
  label,
  question,
  confirmLabel = "Delete",
  tone = "danger",
  className,
  disabled,
  disabledReason,
}: {
  label: string;
  /** What is about to happen, in the user's terms. Say what goes with it. */
  question: string;
  confirmLabel?: string;
  tone?: "danger" | "quiet";
  className?: string;
  disabled?: boolean;
  disabledReason?: string;
}) {
  const [armed, setArmed] = useState(false);
  const box = useRef<HTMLSpanElement | null>(null);
  // While the delete runs the question stays, with the button busy — it used
  // to look unpressed until the page came back (25 Sep).
  const { pending } = useFormStatus();

  useEffect(() => {
    if (!armed || pending) return;
    const away = (e: MouseEvent) => {
      if (box.current && !box.current.contains(e.target as Node)) setArmed(false);
    };
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape") setArmed(false);
    };
    document.addEventListener("mousedown", away);
    document.addEventListener("keydown", key);
    return () => {
      document.removeEventListener("mousedown", away);
      document.removeEventListener("keydown", key);
    };
  }, [armed, pending]);

  if (disabled) {
    return (
      <span className="text-[12px] text-ink-faint" title={disabledReason}>
        {disabledReason ?? label}
      </span>
    );
  }

  if (!armed) {
    return (
      <button
        type="button"
        onClick={() => setArmed(true)}
        className={
          className ??
          `rounded-full border px-3.5 py-1.5 text-[12.5px] transition-colors ${
            tone === "danger"
              ? "border-rule text-danger hover:border-danger hover:bg-danger-soft"
              : "border-rule text-ink-soft hover:bg-tag hover:text-ink"
          }`
        }
      >
        {label}
      </button>
    );
  }

  return (
    <span
      ref={box}
      className="inline-flex flex-wrap items-center gap-2 rounded-lg border border-danger/40 bg-danger-soft px-3 py-1.5"
    >
      <span className="text-[12px] leading-snug text-ink">{question}</span>
      <button
        type="submit"
        disabled={pending}
        aria-busy={pending}
        className="inline-flex items-center gap-1.5 rounded-full bg-danger px-3 py-1 text-[12px] font-medium text-white transition-opacity hover:opacity-90 disabled:opacity-70"
      >
        {pending && <Spinner />}
        {pending ? "Working…" : confirmLabel}
      </button>
      <button
        type="button"
        disabled={pending}
        onClick={() => setArmed(false)}
        className="px-1 text-[12px] text-ink-soft transition-colors hover:text-ink"
      >
        Cancel
      </button>
    </span>
  );
}
