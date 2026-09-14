import { ProjectHeader } from "../../ProjectHeader";
import { LinkVaultTable } from "@/components/LinkVaultTable";
import { CaptureSetup } from "@/components/CaptureSetup";
import { getCurrentUser } from "@/lib/session";

export default async function LinksPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const user = await getCurrentUser();
  return (
    <>
      <h1 className="text-[21px] font-semibold tracking-tight">Excel Tables</h1>
      <ProjectHeader openingId={id} />
      <CaptureSetup />
      <LinkVaultTable openingId={id} user={user} />
    </>
  );
}
