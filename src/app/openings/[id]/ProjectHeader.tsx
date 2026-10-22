import { repo } from "@/data/store";
import { openingFacts } from "@/lib/openingFacts";

// Moved to lib so the mobile API prints the same line (22 Oct).
export { openingFacts };

/** The sub-header inside a page: package and constraints, nothing you act on. */
export function ProjectHeader({ openingId }: { openingId: string }) {
  const o = repo.opening(openingId);
  if (!o) return null;
  const facts = openingFacts(o);
  if (!facts) return null;
  return <p className="mb-6 text-[12.5px] leading-relaxed text-ink-soft">{facts}</p>;
}
