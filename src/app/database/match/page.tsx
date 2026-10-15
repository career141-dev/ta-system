import { redirect } from "next/navigation";

export default async function MatchByCvPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const sp = await searchParams;
  const candidateId = typeof sp.candidateId === "string" ? sp.candidateId.trim() : "";
  if (candidateId) {
    redirect(`/database/results?candidate=${encodeURIComponent(candidateId)}`);
  }
  redirect("/database");
}
