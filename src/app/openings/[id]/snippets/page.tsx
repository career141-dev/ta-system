import Link from "next/link";
import { notFound } from "next/navigation";
import { repo } from "@/data/store";
import { getCurrentUser } from "@/lib/session";
import { ProjectHeader } from "../ProjectHeader";
import { SnippetStudio } from "@/components/SnippetStudio";
import { snippetFromOpening } from "@/lib/snippet";

export default async function SnippetsPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const user = await getCurrentUser();
  const o = repo.opening(id);
  if (!o) notFound();
  const client = repo.client(o.clientId);
  if (!client) notFound();

  // Spec §6.1 — the content comes from the approved JD, so nothing is retyped.
  if (o.jdStatus !== "approved") {
    return (
      <>
        <h1 className="text-[21px] font-semibold tracking-tight">Snippets</h1>
        <ProjectHeader openingId={id} />
        <div className="rounded-2xl border border-rule bg-surface px-7 py-14 text-center">
          <p className="text-[13.5px] text-ink-soft">The JD has not been approved yet.</p>
          <p className="mx-auto mt-2 max-w-[52ch] text-[12.5px] leading-relaxed text-ink-faint">
            The snippet is written from the approved JD, so that a post never advertises something the
            JD does not say.
          </p>
          <Link
            href={`/openings/${id}/jd`}
            className="mt-5 inline-block rounded-full bg-brand px-5 py-2.5 text-[12.5px] font-medium text-white transition-opacity hover:opacity-90"
          >
            Write the JD
          </Link>
        </div>
      </>
    );
  }

  const fields = snippetFromOpening({
    title: o.title,
    clientIndustry: client.industry,
    locations: o.locations,
    salaryMin: o.salaryMin,
    salaryMax: o.salaryMax,
    currency: o.salaryCurrency,
    packageNotes: o.packageNotes,
    jdMarkdown: o.jdMarkdown,
    taEmail: user.email,
    taPhone: user.phone ?? null,
  });

  return (
    <>
      <h1 className="text-[21px] font-semibold tracking-tight">Snippets</h1>
      <ProjectHeader openingId={id} />
      <SnippetStudio initial={fields} />
    </>
  );
}
