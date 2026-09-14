import { repo } from "@/data/store";
import { canonicalProfile } from "@/lib/serper";
import { authorised, normaliseCapture, preflight, reply } from "@/lib/extension";
import { can } from "@/lib/auth";

export const dynamic = "force-dynamic";

export function OPTIONS() {
  return preflight();
}

/**
 * One profile, filed against one opening, because a TA pressed a button on it.
 *
 * Re-capturing someone already in the table updates the row rather than adding
 * a second one — a desk that has three rows for the same person stops trusting
 * the table, and the collision lock in §9 depends on there being exactly one.
 */
export async function POST(req: Request) {
  if (!authorised(req)) return reply({ error: "bad_token" }, 401);

  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return reply({ error: "bad_json" }, 400);
  }

  const openingId = String(body.openingId ?? "");
  const userId = String(body.userId ?? "");
  const opening = repo.opening(openingId);
  if (!opening) return reply({ error: "unknown_opening" }, 404);
  const user = repo.user(userId);
  if (!user) return reply({ error: "unknown_user" }, 404);
  // The token proves the extension is ours; it does not prove who is using it.
  // The named person still has to be allowed to source on this opening, so a
  // capture cannot be filed against somebody else's work (audit finding 03).
  const allowed = can(user, "opening.sourcing", {
    openingId,
    assignment: repo.assignmentFor(openingId, userId) ?? null,
  });
  if (!allowed.ok) return reply({ error: "not_on_opening", message: allowed.message }, 403);

  const capture = normaliseCapture(body.profile, userId);
  if (!capture) return reply({ error: "not_a_linkedin_profile" }, 400);

  const canonical = canonicalProfile(capture.sourceUrl);
  // Recruiter URLs do not carry a /in/ slug, so they are filed as they came.
  const url = canonical ? `https://www.${canonical}` : capture.sourceUrl;

  const existing = canonical ? repo.findLinkByUrl(openingId, canonical) : undefined;
  const id = existing?.id ?? repo.addLink(openingId, url, userId);

  // A capture fills what the row is missing and refreshes what it already has,
  // but it never clears a value a TA typed by hand.
  const keep = <T,>(fresh: T | null, current: T | null | undefined): T | null =>
    (fresh ?? current ?? null) as T | null;

  repo.updateLink(id, {
    name: keep(capture.fullName, existing?.name),
    title: keep(capture.currentTitle ?? capture.headline, existing?.title),
    company: keep(capture.currentCompany, existing?.company),
    phoneNumber: existing?.phoneNumber ?? capture.phone ?? null,
    phoneSource: existing?.phoneNumber
      ? existing.phoneSource
      : capture.phone
        ? "profile"
        : null,
    capture,
  });

  return reply({
    status: existing ? "updated" : "added",
    id,
    name: capture.fullName,
    openingTitle: opening.title,
    openingUrl: `/openings/${openingId}/hh/links`,
  });
}
