"use client";

import { useState } from "react";

/**
 * Dark mode, per browser (28 Sep). The choice lives in the `theme` cookie so
 * the layout renders the right palette on the first paint — no light flash.
 * An on/off switch rather than a "Dark mode" link, so the menu shows which
 * one is on.
 */
export function ThemeToggle({ className }: { className: string }) {
  const [dark, setDark] = useState(
    () => typeof document !== "undefined" && document.documentElement.dataset.theme === "dark",
  );

  function toggle() {
    const next = !dark;
    setDark(next);
    if (next) document.documentElement.dataset.theme = "dark";
    else delete document.documentElement.dataset.theme;
    document.cookie = `theme=${next ? "dark" : "light"}; path=/; max-age=31536000; samesite=lax`;
  }

  return (
    <button type="button" role="switch" aria-checked={dark} onClick={toggle} className={`flex items-center justify-between ${className}`}>
      Dark mode
      <span
        aria-hidden="true"
        className={`relative h-[18px] w-8 shrink-0 rounded-full transition-colors ${dark ? "bg-brand" : "bg-rule-strong"}`}
      >
        <span
          className={`absolute top-[2px] h-[14px] w-[14px] rounded-full bg-white shadow transition-[left] ${dark ? "left-[16px]" : "left-[2px]"}`}
        />
      </span>
    </button>
  );
}
