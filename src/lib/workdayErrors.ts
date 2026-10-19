const CLOSED_WORKDAY_ADD_POSITION =
  "Your workday was completed when the 100% EOD email was sent. You cannot add another 100% position today. Choose Follow-up or Add-on only for returning work; otherwise, add the position on your next workday.";

/** Turn a Convex mutation failure into copy that is safe and useful in the form. */
export function workdayErrorMessage(error: unknown, op: string): string {
  const raw = error instanceof Error ? error.message : "";
  const backend = raw.match(/Uncaught Error:\s*([^\r\n]+)/s)?.[1]
    ?.replace(/\s+at handler\b.*$/s, "")
    .trim();

  if (
    op === "addPosition" &&
    (backend ?? raw).includes("The workday clock has stopped")
  ) {
    return CLOSED_WORKDAY_ADD_POSITION;
  }

  // Convex validation errors are intentional instructions. Hide request IDs,
  // function paths and stack locations, which do not help a TA correct a form.
  if (backend) return backend.slice(0, 300);
  return "Could not save. Try again. If this continues, ask an admin for help.";
}
