import { repo } from "@/data/store";
import { canonicalProfile } from "@/lib/serper";
import { linkKey } from "@/lib/url";
import { authorised, normaliseCapture, preflight, reply } from "@/lib/extension";
import { can } from "@/lib/auth";
import { primeStore } from "@/data/prime";
import { revalidatePath } from "next/cache";
import { matchLink } from "@/lib/cvMatch";

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
  if (!authorised(req)) return reply({ error: "bad_token", message: "Invalid or missing token" }, 401);

  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return reply({ error: "bad_json", message: "Invalid JSON body" }, 400);
  }

  const openingId = String(body.openingId ?? "");
  const userId = String(body.userId ?? "");
  await primeStore({ openingId, allApplications: true });

  const opening = repo.opening(openingId);
  if (!opening) return reply({ error: "unknown_opening", message: "Opening not found." }, 404);
  const user = repo.user(userId);
  if (!user) return reply({ error: "unknown_user", message: "User not found. Please open the extension and select your name." }, 404);

  // The token proves the extension is ours; it does not prove who is using it.
  // The named person still has to be allowed to source on this opening, so a
  // capture cannot be filed against somebody else's work (audit finding 03).
  //
  // `can` already lets an admin, lead, director or ops source anywhere and
  // keeps a client contact out, so it is asked every time. Skipping it for
  // anyone holding an assignment let a client contact — who holds one — file
  // captures into the desk's sourcing (review, 23 Sep).
  const assignment = repo.assignmentFor(openingId, userId) ?? null;
  const allowed = can(user, "opening.sourcing", { openingId, assignment });
  if (!allowed.ok) {
    return reply({
      error: "not_on_opening",
      message: `${allowed.message} Open the extension and choose your user, or ask a lead to put you on "${opening.title}".`,
    }, 403);
  }

  const capture = normaliseCapture(body.profile, userId);
  if (!capture) return reply({ error: "not_a_linkedin_profile" }, 400);

  const canonical = canonicalProfile(capture.sourceUrl);
  // Recruiter URLs do not carry a /in/ slug, so they are filed as they came.
  const url = canonical ? `https://www.${canonical}` : capture.sourceUrl;

  // Already on this opening (1 Oct): by the profile's address — a Recruiter
  // page's profile id included, which had no key, so each capture of the same
  // person from Recruiter made a new row — or by the same full name at the
  // same company, which catches one person saved from LinkedIn and Recruiter.
  const key = canonical ?? linkKey(capture.sourceUrl);
  const existing =
    (key ? repo.findLinkByUrl(openingId, key) : undefined) ??
    repo.findLinkByPerson(openingId, capture.fullName, capture.currentCompany);
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

  // Someone we already hold? Linked now if certain, left to confirm if not (lib/cvMatch).
  await matchLink(id, userId);

  revalidatePath(`/openings/${openingId}`, "layout");
  revalidatePath(`/openings/${openingId}/hh`, "layout");
  revalidatePath(`/openings/${openingId}/hh/links`);
  revalidatePath(`/openings/${openingId}/pipeline`, "layout");
  revalidatePath("/", "layout");

  return reply({
    status: existing ? "updated" : "added",
    id,
    // Who has the row already, so a TA unsure whether they added someone
    // hears "already in the table — added by Hassan" (1 Oct).
    addedByName: existing ? (repo.users().find((u) => u.id === existing.addedBy)?.name ?? null) : null,
    name: capture.fullName,
    openingTitle: opening.title,
    openingUrl: `/openings/${openingId}/hh/links`,
  });
}
