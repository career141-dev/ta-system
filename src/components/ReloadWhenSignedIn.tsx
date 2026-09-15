"use client";

import { useEffect, useState } from "react";

/**
 * A full page load, once Clerk has signed the person in.
 *
 * The root layout decides whether to draw the top nav from the session it saw
 * when it rendered — and on /signin there was none. Clerk's own redirect is a
 * client-side navigation, which keeps that layout, so the app arrived with no
 * nav until someone pressed refresh. Loading the page afresh renders the layout
 * again, with the user.
 *
 * Guarded so it cannot loop: if the browser believes it is signed in but the
 * server keeps sending it back here, it stops after one reload and offers a link.
 */
const KEY = "c141:signin-reload-at";

export function ReloadWhenSignedIn({ to = "/" }: { to?: string }) {
  const [stuck, setStuck] = useState(false);

  useEffect(() => {
    let last = 0;
    try {
      last = Number(sessionStorage.getItem(KEY) ?? 0);
    } catch {
      /* storage blocked: reload anyway */
    }
    if (Date.now() - last < 15_000) {
      setStuck(true);
      return;
    }
    try {
      sessionStorage.setItem(KEY, String(Date.now()));
    } catch {
      /* ignore */
    }
    window.location.replace(to);
  }, [to]);

  return (
    <p className="text-[13px] text-ink-soft">
      {stuck ? (
        <>
          Your sign-in has not reached the server yet.{" "}
          <a href={to} className="underline">
            Try again
          </a>
        </>
      ) : (
        "Signing you in…"
      )}
    </p>
  );
}
