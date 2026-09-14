import { repo } from "@/data/store";

/** The sub-header inside a page: package and constraints, nothing you act on. */
export function ProjectHeader({ openingId }: { openingId: string }) {
  const o = repo.opening(openingId);
  if (!o) return null;
  return (
    <p className="mb-6 text-[12.5px] leading-relaxed text-ink-soft">
      {o.locations.join(", ")} · {o.packageNotes}
      {o.targetNationalities.length > 0 && ` · ${o.targetNationalities.join(", ")} only`}
    </p>
  );
}
