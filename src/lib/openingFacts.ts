import type { Opening } from "@/data/types";

/**
 * Where the job is, the package and who it is for, as one line.
 *
 * Joined from what is there, so an opening without a package no longer reads
 * "Sri Lanka · · local only" (testing, 21 Sep), and the stored "local" — a hire
 * of the country's own nationals — is said in words.
 */
export function openingFacts(o: Pick<Opening, "locations" | "packageNotes" | "targetNationalities">): string {
  const who = o.targetNationalities.filter((n) => n.trim());
  const nationals = who.length
    ? who.every((n) => n.toLowerCase() === "local")
      ? "Local candidates only"
      : `${who.map((n) => (n.toLowerCase() === "local" ? "local" : n)).join(", ")} only`
    : "";
  return [o.locations.filter(Boolean).join(", "), o.packageNotes?.trim() ?? "", nationals].filter(Boolean).join(" · ");
}
