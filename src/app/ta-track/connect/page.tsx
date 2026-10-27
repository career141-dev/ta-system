import { redirect } from "next/navigation";
import { primeStore } from "@/data/prime";
import { getCurrentUser } from "@/lib/session";
import { canPairTaTracking } from "@/lib/taTracking";
import { ConnectTracker } from "./ConnectTracker";

export default async function ConnectTrackingPage() {
  await primeStore();
  const user = await getCurrentUser();
  if (!canPairTaTracking(user.role)) redirect("/unavailable");
  return <ConnectTracker name={user.name} email={user.email} />;
}
