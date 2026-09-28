"use client";

import { useState } from "react";

/**
 * Dark mode, per browser (28 Sep). The choice lives in the `theme` cookie so
 * the layout renders the right palette on the first paint — no light flash.
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
    <button type="button" onClick={toggle} className={className}>
      {dark ? "Light mode" : "Dark mode"}
    </button>
  );
}
