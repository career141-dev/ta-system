"use client";

/**
 * When the root layout itself fails — usually the database not answering,
 * since the layout loads the store before any page (28 Sep).
 *
 * This replaces the whole document, so none of the app's styles are here:
 * inline styles only, and nothing that could fail the same way.
 */
export default function GlobalError({ error, retry }: { error: Error & { digest?: string }; retry: () => void }) {
  return (
    <html lang="en">
      <body style={{ fontFamily: "system-ui, sans-serif", margin: 0, padding: "48px 32px", color: "#1f2328" }}>
        <title>Career141 — something went wrong</title>
        <h1 style={{ fontSize: 18, fontWeight: 600, margin: 0 }}>The desk could not load</h1>
        <p style={{ fontSize: 13, lineHeight: 1.6, color: "#57606a", maxWidth: "60ch" }}>
          The system may be restarting or the database is not answering. Nothing you saved before this is lost. Try
          again in a minute — if it keeps happening, send the reference below to the admin.
        </p>
        {error.digest ? <p style={{ fontFamily: "monospace", fontSize: 12, color: "#57606a" }}>Reference: {error.digest}</p> : null}
        <button
          onClick={() => retry()}
          style={{ marginTop: 12, padding: "6px 14px", fontSize: 12.5, background: "#1f2328", color: "#fff", border: 0, borderRadius: 4, cursor: "pointer" }}
        >
          Try again
        </button>
      </body>
    </html>
  );
}
