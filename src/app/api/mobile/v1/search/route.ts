import { NextResponse } from "next/server";

import { primeStore } from "@/data/prime";
import { storeMode } from "@/data/mode";
import { convexQuery } from "@/lib/convexServer";
import { mobileSearch, searchable, searchRefusal } from "@/lib/mobile/search";
import { currentUser } from "@/lib/session";

export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "private, no-store" };

/**
 * The app's search: the web's /search page as data (src/lib/mobile/search.ts).
 * Same permission (`database.read`, so a client is refused), same database
 * search, same rows — names and titles only.
 */
export async function GET(req: Request) {
  // Load first: knowing who is signed in reads the users table.
  await primeStore({ allApplications: true });
  const user = await currentUser();
  if (!user) {
    return NextResponse.json(
      { error: "unauthenticated", message: "Sign in to continue." },
      { status: 401, headers: NO_STORE },
    );
  }
  const refusal = searchRefusal(user);
  if (refusal) {
    return NextResponse.json({ error: "forbidden", message: refusal }, { status: 403, headers: NO_STORE });
  }

  const q = new URL(req.url).searchParams.get("q") ?? "";
  // The loaded rows are a slice of the database; the people come from the
  // database's own search, then are loaded so the list can name them.
  const ids = storeMode() === "convex" && searchable(q) ? await convexQuery<string[]>("ta/candidates:quickSearch", { q }) : [];
  if (ids.length) await primeStore({ allApplications: true, candidateIds: ids });
  return NextResponse.json(mobileSearch(q, ids), { headers: NO_STORE });
}
