"use client";

import { usePathname, useSearchParams } from "next/navigation";
import { useEffect, useState } from "react";

/**
 * A thin bar along the top while the next page is on its way.
 *
 * Every page here renders on the server, and a click on a link or a search
 * gave no sign anything had happened until the whole next page arrived — on a
 * slow search that read as a frozen screen. The bar shows the moment an
 * in-app link is followed or a search form is sent, and goes when the address
 * changes. Links that open elsewhere (a LinkedIn profile, a CV in a new tab)
 * and server actions that do not navigate do not start it.
 */
export function NavigationProgress() {
  const pathname = usePathname();
  const search = useSearchParams();
  const [active, setActive] = useState(false);

  // Arrived: the address changed.
  useEffect(() => {
    setActive(false);
  }, [pathname, search]);

  useEffect(() => {
    const onClick = (e: MouseEvent) => {
      if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
      const a = (e.target as Element | null)?.closest?.("a");
      if (!a || a.hasAttribute("download")) return;
      if (a.target && a.target !== "_self") return;
      const href = a.getAttribute("href");
      if (!href || href.startsWith("#") || href.startsWith("mailto:") || href.startsWith("tel:")) return;
      const url = new URL(a.href, window.location.href);
      if (url.origin !== window.location.origin) return;
      if (url.pathname === window.location.pathname && url.search === window.location.search) return;
      setActive(true);
    };
    const onSubmit = (e: SubmitEvent) => {
      const form = e.target as HTMLFormElement | null;
      if (!form || e.defaultPrevented) return;
      // A GET form is a navigation (a search); a server action may not navigate at all.
      if ((form.getAttribute("method") ?? "get").toLowerCase() !== "get") return;
      if (form.target && form.target !== "_self") return;
      setActive(true);
    };
    document.addEventListener("click", onClick);
    document.addEventListener("submit", onSubmit);
    return () => {
      document.removeEventListener("click", onClick);
      document.removeEventListener("submit", onSubmit);
    };
  }, []);

  // Never left on screen: a navigation that fails or is cancelled clears it.
  useEffect(() => {
    if (!active) return;
    const t = setTimeout(() => setActive(false), 90_000);
    return () => clearTimeout(t);
  }, [active]);

  if (!active) return null;
  return (
    <div aria-hidden className="pointer-events-none fixed inset-x-0 top-0 z-[60] h-[2px] overflow-hidden bg-brand/15">
      <div className="c141-progress h-full w-1/3 bg-brand" />
    </div>
  );
}
