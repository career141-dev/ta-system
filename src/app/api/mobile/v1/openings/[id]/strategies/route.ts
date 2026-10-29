import { revalidatePath } from "next/cache";
import { primeStore } from "@/data/prime";
import { markTablesStale } from "@/data/primeState";
import { convexMutation } from "@/lib/convexServer";
import { mobileStrategies } from "@/lib/mobile/strategies";
import { strategyWriteBody, parseBody } from "@/lib/mobile/openingsBodies";
import { ok, refuse, signedOut } from "@/lib/mobile/respond";
import { acceptStrategies, removeStrategyPicture, submitStrategies } from "@/lib/openings/strategyWrites";
import { currentUser } from "@/lib/session";

export const dynamic = "force-dynamic";

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  await primeStore({ openingId: id });
  const user = await currentUser();
  if (!user) return signedOut();
  const payload = mobileStrategies(user, id);
  return payload ? ok(payload) : refuse(403, "You may not have access to these strategies, or the opening is no longer available.");
}

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  await primeStore({ openingId: id });
  const user = await currentUser();
  if (!user) return signedOut();
  const body = parseBody(strategyWriteBody, await req.json().catch(() => null), "Check the strategy update and try again.");
  if (!body.ok) return refuse(400, body.message);
  const deps = { convexMutation, markTablesStale, notify: (path: string) => revalidatePath(path) };
  const result = body.value.action === "accept" ? acceptStrategies(user, id, deps)
    : body.value.action === "submit" ? await submitStrategies(user, id, body.value.rows, deps)
      : await removeStrategyPicture(user, body.value.rowId, body.value.proofId, deps, id);
  if (result.ok) {
    revalidatePath(`/openings/${id}/strategies`);
    revalidatePath(`/strategy/${id}`);
    revalidatePath("/strategy");
  }
  return result.ok ? ok(result) : refuse(result.status, result.message);
}
