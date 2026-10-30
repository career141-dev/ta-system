import { redirect } from "next/navigation";
import { primeStore } from "@/data/prime";
import { getCurrentUser } from "@/lib/session";
import { ExtrasSales } from "./ExtrasSales";

export default async function ExtrasPage() {
  await primeStore();
  const user = await getCurrentUser();
  if (user.role !== "admin") redirect("/unavailable");
  return <ExtrasSales />;
}
