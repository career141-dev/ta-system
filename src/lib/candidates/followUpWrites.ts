import { isConvex } from "@/data/mode";
import { repo } from "@/data/store";
import type { User } from "@/data/types";
import { decideOn, type OpeningWriteDeps } from "@/lib/openings/writes";
import { safeErrorMessage } from "@/lib/userError";

type Channel = "whatsapp" | "email";

type SendResponse = {
  sent: boolean;
  blocked?: boolean;
  reason?: string;
  kind?: string;
  attempt?: number;
  maxAttempts?: number;
  sameRound?: boolean;
};

export type CandidateFollowUpWriteResult =
  | { ok: true; message: string }
  | { ok: false; status: 400 | 403 | 404 | 409; message: string; notice?: boolean };

function refreshed(openingId: string, deps: Pick<OpeningWriteDeps, "resetStore" | "revalidatePath">) {
  deps.resetStore();
  deps.revalidatePath("/alerts");
  deps.revalidatePath(`/openings/${openingId}`, "layout");
}

async function allowed(
  user: User,
  openingId: string,
  applicationId: string,
  deps: Pick<OpeningWriteDeps, "convexQuery">,
) {
  const opening = repo.opening(openingId);
  const app = repo.application(applicationId);
  if (!opening || !app || app.openingId !== opening.id) {
    return { ok: false as const, status: 404 as const, message: "That candidate is not on this opening." };
  }
  return decideOn(user, "opening.act", { openingId, ownerTaId: app.ownerTaId }, deps);
}

/** The website and native app's one guarded path for sending the next follow-up. */
export async function sendCandidateFollowUp(
  user: User,
  openingId: string,
  applicationId: string,
  channel: Channel | undefined,
  deps: Pick<OpeningWriteDeps, "convexQuery" | "convexMutation" | "resetStore" | "revalidatePath">,
): Promise<CandidateFollowUpWriteResult> {
  const decision = await allowed(user, openingId, applicationId, deps);
  if (!decision.ok) return decision;
  if (!isConvex()) return { ok: false, status: 409, message: "Sending needs the Convex store." };

  let result: SendResponse;
  try {
    result = await deps.convexMutation<SendResponse>("ta/followUp:send", {
      actorId: user.id,
      applicationId,
      channel,
    });
  } catch (error) {
    return { ok: false, status: 400, message: safeErrorMessage(error, "The follow-up could not be sent.") };
  } finally {
    refreshed(openingId, deps);
  }

  if (!result.sent) {
    return {
      ok: false,
      status: 409,
      message: result.reason ?? "Nothing was sent.",
      notice: result.blocked === true,
    };
  }

  const what = channel === "whatsapp"
    ? result.kind === "initial" ? "WhatsApp follow-up sent (approved template)" : "WhatsApp reminder sent"
    : channel === "email"
      ? result.kind === "initial" ? "Follow-up email sent" : "Reminder email sent"
      : result.kind === "initial" ? "Follow-up sent — WhatsApp template and email" : "Reminder sent";
  return {
    ok: true,
    message: result.kind === "initial" || result.sameRound
      ? `${what}. Delivery shows in the conversation in a few seconds.`
      : `${what} — follow-up ${result.attempt} of ${result.maxAttempts}.`,
  };
}

/**
 * Take the conversation from the assistant, or give it back (30 Oct). The
 * same access checks as Stop; the rules are in convex/lib/assistantControl.ts.
 */
export async function setCandidateConversationOwner(
  user: User,
  openingId: string,
  applicationId: string,
  owner: "ta" | "assistant",
  deps: Pick<OpeningWriteDeps, "convexQuery" | "convexMutation" | "resetStore" | "revalidatePath">,
): Promise<CandidateFollowUpWriteResult> {
  const decision = await allowed(user, openingId, applicationId, deps);
  if (!decision.ok) return decision;
  if (!isConvex()) return { ok: false, status: 409, message: "This needs the Convex store." };
  let answering = false;
  try {
    const result = await deps.convexMutation<{ ok: boolean; answering?: boolean }>(
      owner === "ta" ? "ta/followUp:takeOver" : "ta/followUp:handBack",
      { actorId: user.id, applicationId },
    );
    answering = result?.answering === true;
  } catch (error) {
    return { ok: false, status: 400, message: safeErrorMessage(error, owner === "ta" ? "Could not take over the conversation." : "Could not hand the conversation back.") };
  } finally {
    refreshed(openingId, deps);
  }
  return {
    ok: true,
    message: owner === "ta"
      ? "You have this conversation. The assistant will not reply or send reminders until you hand it back."
      : answering
        ? "Handed back. The assistant is answering the candidate's last message now."
        : "Handed back. The assistant will send the next reminder within a day.",
  };
}

/** Stop every pending reminder through the same backend mutation as the website. */
export async function stopCandidateFollowUp(
  user: User,
  openingId: string,
  applicationId: string,
  deps: Pick<OpeningWriteDeps, "convexQuery" | "convexMutation" | "resetStore" | "revalidatePath">,
): Promise<CandidateFollowUpWriteResult> {
  const decision = await allowed(user, openingId, applicationId, deps);
  if (!decision.ok) return decision;
  if (!isConvex()) return { ok: false, status: 409, message: "Stopping needs the Convex store." };
  try {
    await deps.convexMutation("ta/followUp:stop", { actorId: user.id, applicationId });
  } catch (error) {
    return { ok: false, status: 400, message: safeErrorMessage(error, "Could not stop the follow-up.") };
  } finally {
    refreshed(openingId, deps);
  }
  return { ok: true, message: "Follow-up stopped. Nothing further will be sent." };
}
