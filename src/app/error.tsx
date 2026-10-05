"use client";

import Link from "next/link";

/**
 * What a page shows when it throws (28 Sep).
 *
 * Before this the desk got Next's bare "Application error" screen, with no way
 * back but the browser's. The top bar stays — this renders inside the layout —
 * and the reference is the digest the server logged the error under
 * (`[request-error]` in src/instrumentation.ts), so a TA can quote it.
 */
export default function Error({ error, retry }: { error: Error & { digest?: string }; retry: () => void }) {
  return (
    <main className="mx-auto max-w-[1100px] px-4 sm:px-8 py-6 sm:py-9">
      <h1 className="text-[18px] font-semibold text-ink">This page could not load</h1>
      <p className="mt-2 max-w-[60ch] text-[13px] leading-relaxed text-ink-faint">
        Nothing you saved before this is lost. Try again — if it keeps happening, send the reference below to the
        admin.
      </p>
      {error.digest ? <p className="mt-3 font-mono text-[12px] text-ink-faint">Reference: {error.digest}</p> : null}
      <div className="mt-5 flex gap-3">
        <button onClick={() => retry()} className="rounded bg-ink px-3.5 py-1.5 text-[12.5px] font-medium text-surface">
          Try again
        </button>
        <Link href="/" className="rounded px-3.5 py-1.5 text-[12.5px] font-medium text-ink hover:underline">
          Go to the dashboard
        </Link>
      </div>
    </main>
  );
}
