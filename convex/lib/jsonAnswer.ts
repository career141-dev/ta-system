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
