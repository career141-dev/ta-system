import { repo } from "@/data/store";
import { canonicalProfile } from "@/lib/serper";
import { authorised, normaliseCapture, preflight, reply } from "@/lib/extension";
import { can } from "@/lib/auth";
import { primeStore } from "@/data/prime";
import { revalidatePath } from "next/cache";

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

  // An admin, TA lead or director can source on any opening across the desk.
  // For other recruiters, check their assignment on the opening.
  const assignment = repo.assignmentFor(openingId, userId) ?? null;
  const isAssigned = assignment || opening.assignedTaIds.includes(userId) || opening.taLeadId === userId;
  const isDeskWideUser = ["admin", "director", "ta_lead", "ops"].includes(user.role);

  if (!isDeskWideUser && !isAssigned) {
    const check = can(user, "opening.sourcing", { openingId, assignment });
    if (!check.ok) {
      return reply({
        error: "not_on_opening",
        message: `You are not assigned to "${opening.title}". Open the extension and choose your user or assign yourself on the opening.`,
      }, 403);
    }
  }

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

  revalidatePath(`/openings/${openingId}`, "layout");
  revalidatePath(`/openings/${openingId}/hh`, "layout");
  revalidatePath(`/openings/${openingId}/hh/links`);
  revalidatePath(`/openings/${openingId}/pipeline`, "layout");
  revalidatePath("/", "layout");

  return reply({
    status: existing ? "updated" : "added",
    id,
    name: capture.fullName,
    openingTitle: opening.title,
    openingUrl: `/openings/${openingId}/hh/links`,
  });
}
