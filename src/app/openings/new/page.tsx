import Link from "next/link";
import { repo } from "@/data/store";
import { pageUser } from "@/lib/session";
import { CaptureForm } from "@/components/CaptureForm";
import { primeStore } from "@/data/prime";
import { can } from "@/lib/auth";
import { assignableTas } from "@/lib/assignable";

export default async function NewOpeningPage({
  searchParams,
}: {
  searchParams: Promise<{ created?: string; client?: string; clientId?: string }>;
}) {
  const { created, client, clientId } = await searchParams;
  await primeStore({ allApplications: true });
  const user = await pageUser("opening.create");
  const isLead = user.role === "ta_lead" || user.role === "admin";
  const just = created ? repo.opening(created) : null;
  const initialClientId = client || clientId || null;

  return (
    <main className="mx-auto max-w-[720px] px-8 py-10">
      <Link href="/openings" className="text-[12.5px] text-ink-soft transition-colors hover:text-ink">
        ← Openings
      </Link>

      {just && (
        <div className="mt-4 flex flex-wrap items-center gap-3 rounded-xl border border-brand/25 bg-brand-soft px-5 py-3.5">
          <span className="text-[13px] text-brand">
            <span className="font-medium">{just.title}</span> created for{" "}
            {repo.client(just.clientId)?.name}.
          </span>
          <Link
            href={`/openings/${just.id}`}
            className="ml-auto text-[12.5px] font-medium text-brand hover:underline"
          >
            Open it
          </Link>
        </div>
      )}

      <header className="mb-7 mt-4">
        <h1 className="text-[26px] font-semibold tracking-tight">
          {just ? "Next opening" : "New opening"}
        </h1>
        <p className="mt-2 max-w-[60ch] text-[13.5px] leading-relaxed text-ink-soft">
          {isLead
            ? "Assign the work and leave whatever brief you have. The TA writes and approves the JD."
            : "Client and position first. The notes and the JD come next."}
        </p>
      </header>

      <CaptureForm
        key={`${created ?? "new"}-${initialClientId ?? "none"}`}
        clients={repo.clients()}
        tas={assignableTas(repo.users())}
        isLead={isLead}
        initialClientId={initialClientId}
        canAddClient={can(user, "client.manage").ok}
      />
    </main>
  );
}
