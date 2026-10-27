import { primeStore } from "@/data/prime";
import { repo } from "@/data/store";
import { mobileSnippet } from "@/lib/mobile/snippets";
import { ok, refuse, signedOut } from "@/lib/mobile/respond";
import { currentUser } from "@/lib/session";

export const dynamic = "force-dynamic";

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  await primeStore({ openingId: id });
  const user = await currentUser();
  if (!user) return signedOut();
  if (!repo.opening(id)) return refuse(404, "This opening is no longer available.");
  const payload = mobileSnippet(user, id);
  return payload ? ok(payload) : refuse(403, "You may not have access to snippets for this opening.");
}
