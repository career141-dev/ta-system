import type { Application, Id, LinkVaultEntry } from "@/data/types";

/**
 * Where a CV came from, in the end-of-day sheet's terms (the desk, 28 Sep).
 *
 *   da        approached us directly — WhatsApp, a WhatsApp or Meta campaign,
 *             or a CV emailed in with no advert behind it
 *   post      applied through one of our adverts — a LinkedIn post above all
 *   l         headhunted: worked in Excel Tables, or captured off a profile
 *   database  picked from the database ("TBR") — not a hunted CV
 *
 * A LinkedIn-post applicant and a headhunted person both carry channel L
 * (store channelForIntake, convex map channelOf), so the channel alone cannot
 * tell them apart: the one who sits in the opening's Excel Tables was hunted,
 * and any other L applied.
 */
export type CvSource = "da" | "post" | "l" | "database";

/** The candidates an opening's Excel Tables rows became. */
export function headhuntedCandidates(vault: readonly LinkVaultEntry[]): Set<Id> {
  return new Set(vault.flatMap((v) => (v.candidateId ? [v.candidateId] : [])));
}

export function cvSource(app: Application, headhunted: ReadonlySet<Id>): CvSource {
  if (app.sourcingChannel === "SCOOP") return "database";
  if (headhunted.has(app.candidateId)) return "l";
  switch (app.sourcingChannel) {
    case "HH":
    case "IM":
      return "l";
    case "L":
      return "post";
    case "DA":
      return "da";
    default:
      // E and FB: an advert's applicant when filed against one, otherwise
      // someone who came to us of their own accord.
      return app.jobPostId ? "post" : "da";
  }
}
