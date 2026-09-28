import { primeStore } from "@/data/prime";
import { ProjectHeader } from "../../ProjectHeader";
import { LinkVaultTable } from "@/components/LinkVaultTable";
import { CaptureSetup } from "@/components/CaptureSetup";
import { LiveTableRefresh } from "@/components/LiveTableRefresh";
import { getCurrentUser } from "@/lib/session";
import { after } from "next/server";
import { matchUnchecked } from "@/lib/cvMatch";

export const dynamic = "force-dynamic";

export default async function LinksPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ q?: string; view?: string; page?: string }>;
}) {
  const { id } = await params;
  const sp = await searchParams;
  await primeStore({ openingId: id });
  const user = await getCurrentUser();
  // Rows added before matching existed get checked after the page is sent
  // (lib/cvMatch); the table picks the answers up on its next refresh.
  after(() => matchUnchecked(id, user?.id).catch((e) => console.warn(`[cvMatch ${id}]`, (e as Error).message)));
  return (
    <>
      <LiveTableRefresh />
      <h1 className="text-[21px] font-semibold tracking-tight">Excel Tables</h1>
      <ProjectHeader openingId={id} />
      <CaptureSetup />
      <LinkVaultTable openingId={id} user={user} q={sp.q} view={sp.view} page={Math.floor(Number(sp.page)) || 1} />
    </>
  );
}
