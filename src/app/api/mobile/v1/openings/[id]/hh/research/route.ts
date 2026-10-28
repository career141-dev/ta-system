import { revalidatePath } from "next/cache";
import { after } from "next/server";
import { primeStore } from "@/data/prime";
import { markTablesStale, resetStore } from "@/data/primeState";
import { repo } from "@/data/store";
import { convexMutation, convexQuery } from "@/lib/convexServer";
import { mobileResearch } from "@/lib/mobile/research";
import { parseBody, researchWriteBody } from "@/lib/mobile/openingsBodies";
import { ok, refuse, signedOut } from "@/lib/mobile/respond";
import {
  confirmOpeningResearch,
  correctOpeningClient,
  runOpeningBenchmark,
  runOpeningResearch,
  toggleOpeningBenchmark,
  updateOpeningResearchField,
  type ResearchWriteDeps,
} from "@/lib/openings/researchWrites";
import { sourceFor } from "@/lib/openings/suggestionRuns";
import { decideOn } from "@/lib/openings/writes";
import { currentUser } from "@/lib/session";

export const dynamic = "force-dynamic";

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  await primeStore({ openingId: id });
  const user = await currentUser();
  if (!user) return signedOut();
  if (!repo.opening(id)) return refuse(404, "This opening is no longer available.");
  const payload = mobileResearch(user, id);
  return payload ? ok(payload) : refuse(403, "You may not have access to Research for this opening.");
}

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  await primeStore({ openingId: id });
  const user = await currentUser();
  if (!user) return signedOut();
  const body = parseBody(researchWriteBody, await req.json().catch(() => null), "Check the Research update and try again.");
  if (!body.ok) return refuse(400, body.message);
  const deps: ResearchWriteDeps = {
    revalidatePath, convexQuery, convexMutation, markTablesStale, resetStore, after,
    rerunSuggestions: async (openingId, userId) => { await sourceFor(openingId, userId, true); },
  };
  const input = body.value;
  if (input.action === "confirm") {
    const decision = await decideOn(user, "opening.sourcing", { openingId: id }, deps);
    if (!decision.ok) return refuse(decision.status, decision.message);
  }
  const result = input.action === "run_research" ? await runOpeningResearch(user, id, deps)
    : input.action === "correct_client" ? await correctOpeningClient(user, id, input.researchNotes, deps)
      : input.action === "edit_field" ? await updateOpeningResearchField(user, id, input.field, input.value, deps)
        : input.action === "run_benchmark" ? await runOpeningBenchmark(user, id, deps)
          : input.action === "toggle_benchmark" ? await toggleOpeningBenchmark(user, id, input.entryId, deps)
            : await confirmOpeningResearch(user, id, input.unavailable, deps);
  return result.ok ? ok(result) : refuse(result.status, result.message);
}
