import { ProblemState } from "@/components/ProblemState";

/** A wrong link or a record someone deleted — said plainly, with a way back (28 Sep). */
export default function NotFound() {
  return (
    <ProblemState
      title="This item is unavailable"
      message="It may have been removed, or the link may be out of date. Return to Openings and choose an available item."
      primaryHref="/openings"
      primaryLabel="Go to Openings"
    />
  );
}
