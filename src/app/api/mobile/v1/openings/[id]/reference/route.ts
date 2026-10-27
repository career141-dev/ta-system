import { primeStore } from "@/data/prime";
import { repo } from "@/data/store";
import { mobileReference } from "@/lib/mobile/reference";
import { ok, refuse, signedOut } from "@/lib/mobile/respond";
import { currentUser } from "@/lib/session";

export const dynamic = "force-dynamic";

export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  await primeStore({ openingId: id });
  const user = await currentUser();
  if (!user) return signedOut();
  if (!repo.opening(id)) return refuse(404, "This opening is no longer available.");
  const company = new URL(req.url).searchParams.get("company")?.trim() ?? "";
  if (company.length > 120) return refuse(400, "Use a shorter company name.");
  const payload = mobileReference(user, id, company);
  return payload ? ok(payload) : refuse(403, "You may not have access to references for this opening.");
}
