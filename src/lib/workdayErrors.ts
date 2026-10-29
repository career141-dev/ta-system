/** Turn a Convex mutation failure into copy that is safe and useful in the form. */
export function workdayErrorMessage(error: unknown, op: string): string {
  const raw = error instanceof Error ? error.message : "";
  const backend = raw.match(/Uncaught Error:\s*([^\r\n]+)/s)?.[1]
    ?.replace(/\s+at handler\b.*$/s, "")
    .trim();

  // Convex validation errors are intentional instructions. Hide request IDs,
  // function paths and stack locations, which do not help a TA correct a form.
  if (backend) return backend.slice(0, 300);
  if (op === "start") {
    if (error && typeof error === "object" && "unreachable" in error && error.unreachable === true)
      return "Could not reach the workday service. Check your connection and try Start workday again.";
    if (/backend is not answering|http (502|503|504)|timed out|timeout/i.test(raw))
      return "The workday service did not answer. Try Start workday again in a moment.";
    return "Could not start your workday. Try again. If it keeps happening, ask an admin to check the workday service.";
  }
  return "Could not save. Try again. If this continues, ask an admin for help.";
}

/** A safe server-log category, without candidate text, credentials or Convex details. */
export function workdayFailureCategory(error: unknown): string {
  const raw = error instanceof Error ? error.message : "";
  if (error && typeof error === "object" && "unreachable" in error && error.unreachable === true) return "unreachable";
  if (/too many|limit|exceeded|bytes read|documents scanned/i.test(raw)) return "backend_limit";
  if (/timed out|timeout/i.test(raw)) return "timeout";
  if (/http (502|503|504)|backend is not answering/i.test(raw)) return "backend_unavailable";
  if (error && typeof error === "object" && "status" in error && typeof error.status === "number") return `http_${error.status}`;
  return error instanceof Error ? error.name : "unknown";
}
