import { primeStore } from "@/data/prime";
import { repo } from "@/data/store";
import { can } from "@/lib/auth";
import { authorised, extensionUser, preflight, reply } from "@/lib/extension";

export const dynamic = "force-dynamic";

export function OPTIONS() {
  return preflight();
}

/**
 * What the extension's picker lists: the recruiters, and the chosen one's own
 * open openings (`?userId=`).
 *
 * Until 2 Oct this listed every open opening and every TA, lead, director and
 * admin id to anyone holding the shared token — and a desk-wide id named back
 * in a capture could file anywhere. Now only active recruiters are listed (the
 * only people a capture accepts, lib/extension), and an opening only when that
 * recruiter may source on it — the same `can` the capture asks.
 */
export async function GET(req: Request) {
  // Load the store before reading it — this route has no page to do it first.
  await primeStore();
  if (!authorised(req)) return reply({ error: "bad_token" }, 401);

  const user = extensionUser(new URL(req.url).searchParams.get("userId"));
  const openings = user
    ? repo
        .openingsForUser(user)
        .filter((o) => o.status === "open")
        .filter((o) => can(user, "opening.sourcing", { openingId: o.id, assignment: repo.assignmentFor(o.id, user.id) ?? null }).ok)
        .map((o) => ({
          id: o.id,
          title: o.title,
          client: repo.client(o.clientId)?.name ?? "—",
          locations: o.locations,
        }))
    : [];

  const users = repo
    .users()
    .filter((u) => extensionUser(u.id))
    .map((u) => ({ id: u.id, name: u.name, initials: u.initials }));

  return reply({ openings, users });
}
