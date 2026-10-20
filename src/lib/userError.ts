/**
 * Messages that cross from the server into the UI (20 Oct).
 *
 * Backend errors are useful in logs but can contain Convex wrappers, paths,
 * service names and request details. Keep a backend sentence only when it is
 * plainly written for a person; otherwise use the caller's helpful fallback.
 */
const TECHNICAL = [
  /\b(?:convex|uncaught|typeerror|referenceerror|syntaxerror|stack trace)\b/i,
  /\b(?:internal (?:server )?(?:error|failure)|server error)\b/i,
  /\b(?:econn\w*|enotfound|etimedout|fetch failed|networkerror)\b/i,
  /\bhttp\s*[45]\d\d\b/i,
  /\b(?:livekit|postgres|qdrant|r2|openrouter)\b/i,
  /\b(?:request|trace|correlation)[-_ ]?id\b/i,
  /\b(?:api[-_ ]?key|access[-_ ]?token|client[-_ ]?secret|authorization:\s*bearer)\b/i,
  /(?:node:|webpack:|\.tsx?:\d|\.mjs:\d|\.js:\d)/i,
  /[A-Z]:\\|\/home\/|\/var\/|\/opt\//,
  /https?:\/\//i,
  /<\/?(?:html|body|pre)\b/i,
];

export function isTechnicalMessage(value: string): boolean {
  return TECHNICAL.some((pattern) => pattern.test(value));
}

export function safeErrorMessage(error: unknown, fallback: string): string {
  const raw = error instanceof Error ? error.message : typeof error === "string" ? error : "";
  const clean = raw
    .replace(/^.*?Uncaught Error:\s*/s, "")
    .split("\n")[0]
    .replace(/\s+/g, " ")
    .trim();
  if (!clean || isTechnicalMessage(clean)) return fallback;
  return clean.slice(0, 200);
}

