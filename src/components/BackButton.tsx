"use client";

export function BackButton({ label = "Go back" }: { label?: string }) {
  return (
    <button
      type="button"
      onClick={() => window.history.back()}
      className="rounded px-3.5 py-1.5 text-[12.5px] font-medium text-ink hover:bg-paper"
    >
      {label}
    </button>
  );
}
