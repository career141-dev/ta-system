"use server";

import { revalidatePath } from "next/cache";
import { unstable_rethrow } from "next/navigation";
import { primeStore } from "@/data/prime";
import { getCurrentUser } from "@/lib/session";
import { convexMutation } from "@/lib/convexServer";
import { colomboLocalToInstant } from "@/lib/calendar";

export async function changeWorkday(
  form: FormData,
): Promise<{ ok: boolean; message: string }> {
  await primeStore({});
  const user = await getCurrentUser();
  const value = (key: string) => String(form.get(key) ?? "").trim();
  const op = value("op");
  const args: Record<string, unknown> = { actorId: user.id };
  if (op === "start")
    Object.assign(args, { jobId: value("jobId"), workType: value("workType") });
  else if (op === "addPosition")
    Object.assign(args, {
      workdayId: value("workdayId"),
      jobId: value("jobId"),
      workType: value("workType"),
    });
  else if (op === "decide")
    Object.assign(args, {
      requestId: value("requestId"),
      approve: value("approve") === "yes",
      reason: value("reason"),
    });
  else if (op === "carry")
    Object.assign(args, {
      workdayId: value("workdayId"),
      jobId: value("jobId"),
      key: value("key"),
      reason: value("reason"),
      nextAction: value("nextAction"),
      dueAt: colomboLocalToInstant(value("dueAt")),
    });
  else if (op === "markReviewed")
    Object.assign(args, {
      workdayId: value("workdayId"),
      applicationId: value("applicationId"),
    });
  else if (op === "finish")
    Object.assign(args, { workdayId: value("workdayId") });
  else if (op === "reconcileMail") {
    if (value("verified") !== "yes")
      return {
        ok: false,
        message: "Verify the mailbox result before confirming.",
      };
    Object.assign(args, {
      id: value("id"),
      accepted: value("accepted") === "yes",
      reason: value("reason"),
    });
  } else return { ok: false, message: "Unknown workday action." };
  try {
    const result = await convexMutation<{
      ok?: boolean;
      blockers?: string[];
      pending?: boolean;
    }>(`ta/workdays:${op}`, args);
    if (result.ok === false)
      return {
        ok: false,
        message: `Complete these steps first: ${result.blockers?.slice(0, 5).join("; ") ?? "review the checklist"}.`,
      };
    revalidatePath("/workday");
    const message =
      op === "finish"
        ? "Workday finished. Your TA Lead can see the finish time."
        : op === "start"
          ? "Workday started. Your TA Lead can see the start time."
          : result.pending
            ? "Sent to the TA Lead for approval."
            : "Saved.";
    return { ok: true, message };
  } catch (error) {
    unstable_rethrow(error);
    return {
      ok: false,
      message:
        error instanceof Error
          ? error.message.replace(/^.*?Uncaught Error:\s*/, "").slice(0, 300)
          : "Could not save. Try again.",
    };
  }
}
