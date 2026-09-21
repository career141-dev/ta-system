"use client";

import { useFormStatus } from "react-dom";
import { BUTTON } from "./buttonStyles";

/**
 * A form's submit button that shows it is working.
 *
 * Before this, pressing Save or Add changed nothing on screen until the server
 * answered — no disabled state, no word — so people pressed again, or thought
 * nothing had happened when the page came back the same (21 September). While
 * the form is sending, the button is disabled and says what it is doing; the
 * answer then arrives as the banner at the top (components/Flash.tsx).
 *
 * Put it inside the <form>; `useFormStatus` only sees the form it sits in.
 */
export function SubmitButton({
  children,
  pendingLabel,
  variant = "primary",
  className = "",
  name,
  value,
  title,
}: {
  children: React.ReactNode;
  /** What it says while sending — "Saving…", "Adding…". */
  pendingLabel: string;
  variant?: keyof typeof BUTTON;
  className?: string;
  name?: string;
  value?: string;
  title?: string;
}) {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      name={name}
      value={value}
      title={title}
      disabled={pending}
      aria-busy={pending}
      className={`${BUTTON[variant]} ${className}`}
    >
      {pending && (
        <span
          aria-hidden
          className="h-3 w-3 animate-spin rounded-full border-2 border-current border-t-transparent motion-reduce:animate-none"
        />
      )}
      {pending ? pendingLabel : children}
    </button>
  );
}

/** A finished state in place of the button: "Added", "Shortlisted", "Saved". */
export function DoneBadge({ children, title }: { children: React.ReactNode; title?: string }) {
  return (
    <span
      title={title}
      className="inline-flex items-center gap-1.5 rounded-full border border-brand/30 bg-brand-soft px-3.5 py-1.5 text-[12.5px] font-semibold text-brand"
    >
      <span aria-hidden>✓</span>
      {children}
    </span>
  );
}
