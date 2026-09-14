"use server";

import { revalidatePath } from "next/cache";
import { getCurrentUser } from "@/lib/session";
import { reviewDecisions, saveReviewDecision, type ReviewDecision } from "@/lib/review";

export async function recordReview(formData: FormData) {
  const user = await getCurrentUser();
  const job = Number(formData.get("job"));
  const candidateId = String(formData.get("candidateId") ?? "");
  const decision = String(formData.get("decision") ?? "") as ReviewDecision;
  if (!["shortlist", "maybe", "reject"].includes(decision) || !Number.isInteger(job)) return;
  // Re-clicking the same decision keeps the reason already given; a new decision starts without one.
  const before = reviewDecisions(user.id, job).get(candidateId);
  const note = formData.has("note") ? String(formData.get("note")) : before?.decision === decision ? before.note : "";
  saveReviewDecision({ reviewerId: user.id, job, candidateId, decision, note });
  revalidatePath(`/review/${job}`);
  revalidatePath("/review");
}
