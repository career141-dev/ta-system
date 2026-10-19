"use server";

import { revalidatePath } from "next/cache";
import { getCurrentUser } from "@/lib/session";
import { convexActorForEmail, convexMutation } from "@/lib/convexServer";

const REVIEWERS = new Set(["admin", "director", "ta_lead", "ops"]);

async function actor() {
  const user = await getCurrentUser();
  if (!REVIEWERS.has(user.role)) throw new Error("Only Admin, Director, TA Lead or Ops can review shortlist replies.");
  const backend = await convexActorForEmail(user.email);
  if (!backend) throw new Error("Your account is not connected to the backend.");
  return backend;
}

export async function rematchShortlistReply(formData: FormData) {
  const user = await actor();
  await convexMutation("mailIntake/decisions:rematch", {
    actorId: user._id,
    reviewId: String(formData.get("reviewId") ?? ""),
    roundId: String(formData.get("roundId") ?? ""),
  });
  revalidatePath("/shortlist-decisions");
}

export async function confirmShortlistReply(formData: FormData) {
  const user = await actor();
  const decisions = [...formData.entries()].flatMap(([key, value]) => {
    if (!key.startsWith("decision:")) return [];
    const applicationId = key.slice("decision:".length);
    const outcome = String(value);
    if (!applicationId || !["shortlisted", "rejected", "hold"].includes(outcome)) return [];
    return [{ applicationId, outcome, evidence: String(formData.get(`evidence:${applicationId}`) ?? "Confirmed from the shortlist reply").slice(0, 240) }];
  });
  if (decisions.length === 0) throw new Error("Select at least one candidate decision.");
  await convexMutation("mailIntake/decisions:confirm", {
    actorId: user._id,
    reviewId: String(formData.get("reviewId") ?? ""),
    decisions,
    note: String(formData.get("note") ?? "").trim() || undefined,
  });
  revalidatePath("/shortlist-decisions");
}

export async function ignoreShortlistReply(formData: FormData) {
  const user = await actor();
  await convexMutation("mailIntake/decisions:ignore", {
    actorId: user._id,
    reviewId: String(formData.get("reviewId") ?? ""),
    note: String(formData.get("note") ?? "").trim(),
  });
  revalidatePath("/shortlist-decisions");
}

export async function keepShortlistReplyForReview(formData: FormData) {
  const user = await actor();
  await convexMutation("mailIntake/decisions:keepForReview", {
    actorId: user._id,
    reviewId: String(formData.get("reviewId") ?? ""),
    note: String(formData.get("note") ?? "").trim() || undefined,
  });
  revalidatePath("/shortlist-decisions");
}
