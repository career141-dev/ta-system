import { redirect } from "next/navigation";
import { primeStore } from "@/data/prime";
import { repo } from "@/data/store";
import { getCurrentUser } from "@/lib/session";
import { canViewTaTracking, canPairTaTracking } from "@/lib/taTracking";
import { TaTrackReport } from "./TaTrackReport";

export default async function TaTrackPage() {
  await primeStore();
  const user = await getCurrentUser();
  if (!canViewTaTracking(user.role)) redirect("/unavailable");
  const users = repo.users().filter(u => canPairTaTracking(u.role)).map(u => ({ id: u.id, name: u.name, active: u.isActive })).sort((a, b) => a.name.localeCompare(b.name));
  return <TaTrackReport users={users} />;
}
