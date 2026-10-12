import { Metadata } from "next";
import { redirect } from "next/navigation";
import { getCurrentUser } from "@/lib/session";
import { primeStore } from "@/data/prime";
import { repo } from "@/data/store";
import { isTa } from "@/lib/auth";
import { FeedbackDesk } from "@/components/FeedbackDesk";

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

  if (isTa(user)) {
    redirect("/");
  }

  // Feedbacks are marked as seen client-side in FeedbackDesk via markFeedbackSeenAction()
  const feedbacks = repo.feedbacks(user);

  return (
    <main className="mx-auto max-w-[1180px] px-4 sm:px-8 py-6 sm:py-9">
      {/* Page Header */}
      <div className="mb-6">
        <h1 className="text-[22px] font-semibold tracking-tight text-ink">TA Feedback & Support Desk</h1>
      </div>

      <FeedbackDesk initialFeedbacks={feedbacks} currentUser={user} />
    </main>
  );
}
