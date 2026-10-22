import { repo } from "@/data/store";
import type { User } from "@/data/types";
import { can } from "@/lib/auth";

import type { SearchPayload } from "./alertsTypes";

/** Most rows of each list one response carries; the totals still count them all. */
export const SEARCH_CAP = 100;

/** Shorter than this (after trimming), the web's database search is not run. */
export const SEARCH_MIN_CHARS = 2;

/**
 * Whether `user` may search, as the web's /search page decides it
 * (`pageUser("database.read")`). Returns the refusal message, or null.
 */
export function searchRefusal(user: User): string | null {
  const decision = can(user, "database.read");
  return decision.ok ? null : decision.message;
}

/** Whether a query is long enough to search at all. */
export const searchable = (q: string) => q.trim().length >= SEARCH_MIN_CHARS;

/**
 * `GET /api/mobile/v1/search?q=` — the web's /search page (src/app/search/page.tsx)
 * as data. The route has already run the database's quickSearch and loaded
 * those people (`rankedIds`); this reads `repo.search` exactly as the page does.
 *
 * Only what the page shows goes out: a candidate's name, title, employer and
 * the opening they are on. No email, phone or CV.
 */
export function mobileSearch(q: string, rankedIds: string[] = [], cap = SEARCH_CAP): SearchPayload {
  if (!searchable(q)) {
    return { apiVersion: 1, q, openings: [], openingTotal: 0, candidates: [], candidateTotal: 0 };
  }
  const found = repo.search(q, rankedIds);
  const clientName = (id: string) => repo.client(id)?.name ?? "";

  return {
    apiVersion: 1,
    q,
    openings: found.openings.slice(0, cap).map((o) => ({
      id: o.id,
      title: o.title,
      clientName: clientName(o.clientId),
      status: o.status,
    })),
    openingTotal: found.openings.length,
    candidates: found.candidates.slice(0, cap).map(({ candidate: c, application: a }) => {
      const opening = a ? repo.opening(a.openingId) : undefined;
      return {
        candidateId: c.id,
        name: c.fullName,
        currentTitle: c.currentTitle ?? "",
        currentEmployer: c.currentEmployer ?? "",
        application: a
          ? {
              applicationId: a.id,
              openingId: a.openingId,
              openingTitle: opening?.title ?? "",
              clientName: opening ? clientName(opening.clientId) : "",
            }
          : null,
      };
    }),
    candidateTotal: found.candidates.length,
  };
}
