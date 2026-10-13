import { notFound } from "next/navigation";
import { primeStore } from "@/data/prime";
import { getCurrentUser } from "@/lib/session";
import { WorkdayDashboard } from "@/components/Workday";

export default async function WorkdayPage() {
  await primeStore({});
  const user = await getCurrentUser();
  if (!["ta", "ta_support", "ta_lead", "admin"].includes(user.role)) notFound();
  return (
    <main className="mx-auto max-w-6xl px-5 py-8">
      <h1 className="text-2xl font-semibold">Workday</h1>
      <p className="mb-6 mt-2 text-sm text-ink-soft">
        Start and finish work with the buttons here. Times are shown in Sri
        Lanka time. Account sign-out does not finish your workday.
      </p>
      <WorkdayDashboard />
    </main>
  );
}
