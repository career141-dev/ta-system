import { primeStore } from "@/data/prime";
import { markTablesStale, resetStore } from "@/data/primeState";
import { repo } from "@/data/store";
import { convexQuery } from "@/lib/convexServer";
import { mobileJd } from "@/lib/mobile/jd";
import { jdWriteBody, parseBody } from "@/lib/mobile/openingsBodies";
import { ok, refuse, signedOut } from "@/lib/mobile/respond";
import { amendJdText, approveJdText, generateJd, reextractJdDetails, restoreJd, reviseJd, saveJdDetails, writeJdNotes } from "@/lib/openings/jdWrites";
import { currentUser } from "@/lib/session";
import { markMatching } from "@/lib/matchingNow";
import { rematchWhenRequirementsSettle } from "@/lib/openings/matching";

export const dynamic = "force-dynamic";

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  await primeStore({ openingId: id });
  const user = await currentUser();
  if (!user) return signedOut();
  if (!repo.opening(id)) return refuse(404, "This opening is no longer available.");
  const payload = mobileJd(user, id);
  return payload ? ok(payload) : refuse(403, "You may not have access to this opening, or it is no longer available.");
}

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  await primeStore({ openingId: id });
  const user = await currentUser();
  if (!user) return signedOut();
  const body = parseBody(jdWriteBody, await req.json().catch(() => null), "Check the JD details and try again.");
  if (!body.ok) return refuse(400, body.message);
  const deps = { convexQuery, markTablesStale, resetStore };
  const input = body.value;
  const result = input.action === "save_notes" ? await writeJdNotes(user, id, input.notes, deps)
    : input.action === "generate" ? await generateJd(user, id, input.notes, deps)
      : input.action === "approve" ? await approveJdText(user, id, input.markdown, deps)
        : input.action === "amend" ? await amendJdText(user, id, input.markdown, deps)
          : input.action === "revise" ? await reviseJd(user, id, input.request, input.currentMarkdown, deps)
            : input.action === "restore" ? await restoreJd(user, id, input.messageId, deps)
              : input.action === "save_details" ? await saveJdDetails(user, id, input.details, deps)
                : await reextractJdDetails(user, id, deps);
  if (result.ok && result.reextracting) {
    markMatching(id);
    after(() => rematchWhenRequirementsSettle(id, user.id, "jd_approved", revalidatePath));
  }
  return result.ok ? ok(result) : refuse(result.status, result.message);
}
import { revalidatePath } from "next/cache";
import { after } from "next/server";
