import { primeStore } from "@/data/prime";
import { ProjectHeader } from "../../ProjectHeader";
import { LinkVaultTable } from "@/components/LinkVaultTable";
import { CaptureSetup } from "@/components/CaptureSetup";
import { getCurrentUser } from "@/lib/session";

export default async function LinksPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ q?: string; page?: string }>;
}) {
  const { id } = await params;
  const sp = await searchParams;
  await primeStore({ openingId: id });
  const user = await getCurrentUser();
  return (
    <>
      <h1 className="text-[21px] font-semibold tracking-tight">Excel Tables</h1>
      <ProjectHeader openingId={id} />
      <CaptureSetup />
      <LinkVaultTable openingId={id} user={user} q={sp.q} page={Math.floor(Number(sp.page)) || 1} />
    </>
  );
}
