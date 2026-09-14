import { repo } from "@/data/store";
import { authorised, preflight, reply } from "@/lib/extension";

export const dynamic = "force-dynamic";

export function OPTIONS() {
  return preflight();
}

/** What the extension's picker lists: the live work, and who is on the desk. */
export function GET(req: Request) {
  if (!authorised(req)) return reply({ error: "bad_token" }, 401);

  const openings = repo
    .openings()
    .filter((o) => o.status === "open")
    .map((o) => ({
      id: o.id,
      title: o.title,
      client: repo.client(o.clientId)?.name ?? "—",
      locations: o.locations,
    }));

  const users = repo
    .users()
    .filter((u) => ["ta", "ta_lead", "admin", "director"].includes(u.role))
    .map((u) => ({ id: u.id, name: u.name, initials: u.initials }));

  return reply({ openings, users });
}
