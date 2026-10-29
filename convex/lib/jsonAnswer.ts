/**
 * Whether a JSON-mode model answer parses, allowing a ```json fence or text
 * around the object. A cut-off answer (28 Oct: "not readable JSON (323
 * characters — likely cut off)") is not complete and is asked for again.
 */
export function isCompleteJson(content: string): boolean {
  const first = content.indexOf("{");
  const last = content.lastIndexOf("}");
  if (first === -1 || last <= first) return false;
  try {
    JSON.parse(content.slice(first, last + 1));
    return true;
  } catch {
    return false;
  }
}

/** An empty array or whitespace is not evidence that a CV was read (29 Oct). */
export function hasCvDetails(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const cv = value as Record<string, unknown>;
  const text = (v: unknown): boolean => typeof v === "string" && v.trim().length > 0;
  return [cv.fullName, cv.email, cv.phone].some(text)
    || (Array.isArray(cv.skills) && cv.skills.some((s) => text(s) || text(s?.value)))
    || (Array.isArray(cv.jobHistory) && cv.jobHistory.some((j) => text(j?.company) || text(j?.title)));
}

export function hasCvDetailsJson(content: string): boolean {
  try {
    return hasCvDetails(JSON.parse(content.slice(content.indexOf("{"), content.lastIndexOf("}") + 1)));
  } catch {
    return false;
  }
}
