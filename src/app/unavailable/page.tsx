import { ProblemState } from "@/components/ProblemState";

export default function UnavailablePage() {
  return (
    <ProblemState
      title="Page unavailable"
      message="You may not have permission to open this page, or the item is no longer available. Choose another page from the dashboard."
    />
  );
}
