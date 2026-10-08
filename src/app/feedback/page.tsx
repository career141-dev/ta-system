import { Metadata } from "next";
import { getCurrentUser } from "@/lib/session";
import { primeStore } from "@/data/prime";
import { repo } from "@/data/store";
import { isConvex } from "@/data/mode";
import { convexQuery } from "@/lib/convexServer";
import { FeedbackDesk } from "@/components/FeedbackDesk";
import type { FeedbackItem } from "@/data/types";

export const metadata: Metadata = {
  title: "Feedback & Support — Career141 TA Desk",
  description: "TA Feedback, Bug Reporting, TA Lead Review & Admin Escalation Queue",
};

export default async function FeedbackPage() {
  await primeStore();
  const user = await getCurrentUser();

  if (!user) {
    return (
      <main className="mx-auto max-w-[1180px] px-4 sm:px-8 py-10">
        <p className="text-[14px] text-ink-soft">Please sign in to access the Feedback desk.</p>
      </main>
    );
  }

  // Mark feedbacks as seen for the current user so the alert badge on TopNav clears
  repo.markAllFeedbackSeen(user.id, user);

  let feedbacks: FeedbackItem[] = [];

  if (isConvex()) {
    try {
      const remote = await convexQuery<FeedbackItem[]>("ta/feedbacks:listFeedbacks", {
        actorId: user.id,
      });
      if (Array.isArray(remote)) {
        feedbacks = remote;
      } else {
        feedbacks = repo.feedbacks(user);
      }
    } catch {
      feedbacks = repo.feedbacks(user);
    }
  } else {
    feedbacks = repo.feedbacks(user);
  }

  return (
    <main className="mx-auto max-w-[1180px] px-4 sm:px-8 py-6 sm:py-9">
      {/* Page Header */}
      <div className="mb-7">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h1 className="text-[24px] font-semibold tracking-tight text-ink">TA Feedback & Support Desk</h1>
            <p className="mt-1 text-[13px] text-ink-soft">
              Continuous improvement workflow: <strong className="text-ink">1. TA Submission</strong> &rarr;{" "}
              <strong className="text-ink">2. TA Lead Review & Endorsement</strong> &rarr;{" "}
              <strong className="text-ink">3. Admin / Engineering Implementation</strong>.
            </p>
          </div>
          <div className="flex items-center gap-2 rounded-lg border border-rule bg-paper px-3 py-1.5 text-[12px] text-ink-soft">
            <span>Signed in as:</span>
            <strong className="text-ink">{user.name}</strong>
            <span className="rounded bg-brand/10 px-1.5 py-0.5 text-[11px] font-medium text-brand capitalize">
              {user.role}
            </span>
          </div>
        </div>
      </div>

      <FeedbackDesk initialFeedbacks={feedbacks} currentUser={user} />
    </main>
  );
}
