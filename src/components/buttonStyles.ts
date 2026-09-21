/**
 * The three button looks, as class strings (21 September). Kept out of the
 * client module so server components can use them too — a plain value
 * exported from a "use client" file arrives on the server as a reference, not
 * the string.
 */
export const BUTTON = {
  primary:
    "inline-flex items-center justify-center gap-1.5 rounded-full bg-brand px-4 py-1.5 text-[12.5px] font-semibold text-white shadow-[0_1px_2px_rgba(22,91,66,0.25)] transition-[background-color,opacity] hover:bg-[#0f4a35] disabled:opacity-60",
  secondary:
    "inline-flex items-center justify-center gap-1.5 rounded-full border border-brand-line bg-surface px-4 py-1.5 text-[12.5px] font-semibold text-brand transition-colors hover:bg-brand-soft disabled:opacity-60",
  quiet:
    "inline-flex items-center justify-center gap-1.5 rounded-full border border-rule-strong bg-surface px-4 py-1.5 text-[12.5px] font-medium text-ink transition-colors hover:border-ink-faint hover:bg-paper disabled:opacity-60",
} as const;
