import { primeStore } from "@/data/prime";
import { requireSourcingSeat } from "../sourcingGate";

/** Every headhunting page is sourcing; refused once here for all of them. */
export default async function HeadhuntingLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  await primeStore({ openingId: id });
  await requireSourcingSeat(id);
  return <>{children}</>;
}
