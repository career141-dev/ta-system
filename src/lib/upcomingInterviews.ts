import { repo } from "@/data/store";
import type { Interview, User } from "@/data/types";

/**
 * The next five pending interviews for the home's "Upcoming interviews" — only
 * on openings this person can open (22 Oct). The web list used to read every
 * interview on the desk, so a TA, viewer or client account saw candidate names
 * on other people's openings. Shared by the web home (src/app/page.tsx) and the
 * phone's (src/lib/mobile/home.ts).
 */
export function upcomingInterviews(user: User, now = Date.now(), limit = 5): Interview[] {
  const visibleIds = new Set(repo.openingsForUser(user).map((o) => o.id));
  return repo
    .interviews()
    .filter((i) => i.outcome === "pending" && i.scheduledAt > now)
    .filter((i) => visibleIds.has(repo.application(i.applicationId)?.openingId ?? ""))
    .sort((a, b) => a.scheduledAt - b.scheduledAt)
    .slice(0, limit);
}
