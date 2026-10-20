import { redirect } from "next/navigation";
import { repo } from "@/data/store";
import { getCurrentUser } from "@/lib/session";
import { seatFor } from "@/lib/visibility";

/**
 * Refuses the desk's working-out — headhunting, database CVs, referees,
 * snippets, end of day — to a seat the rail does not offer it to.
 *
 * The rail hides these links from a client seat, but hiding a link is a
 * courtesy: the URL still opened the page. This is the check behind it, using
 * the same `seatFor` rule the rail draws from so the two cannot disagree.
 */
export async function requireSourcingSeat(openingId: string) {
  const user = await getCurrentUser();
  const assignment = repo.assignmentFor(openingId, user.id) ?? null;
  const onStrategy = repo.strategyAssignments(openingId).some((r) => r.doneBy.includes(user.id));
  if (!seatFor(user, assignment?.role ?? null, onStrategy).canSeeSourcing) redirect("/unavailable");
  return user;
}
