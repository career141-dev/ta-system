import { notFound } from "next/navigation";
import { repo } from "@/data/store";
import { getCurrentUser } from "@/lib/session";
import { JdScreen } from "@/components/JdScreen";
import { JdRead } from "./JdRead";
import { ProjectHeader } from "../ProjectHeader";
import { dateAt } from "@/lib/format";
import { primeStore } from "@/data/prime";
import { JobDetailsPanel } from "@/components/JobDetailsPanel";
import { allows } from "@/lib/auth";

export default async function JdPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ msg?: string }>;
}) {
  const { id } = await params;
  const { msg } = await searchParams;
  await primeStore({ openingId: id });
  const user = await getCurrentUser();
  const o = repo.opening(id);
  if (!o) notFound();

  const client = repo.client(o.clientId);
  if (!client) notFound();
  const brief = o.briefId ? repo.brief(o.briefId) : null;
  const e = brief?.extracted;
  const lead = repo.user(o.taLeadId);
  const canWrite = o.assignedTaIds.includes(user.id) || user.role === "admin";

  const summary = [
    e?.salaryMin
      ? `${e.currency} ${e.salaryMin.toLocaleString()}${e.salaryMax ? `–${e.salaryMax.toLocaleString()}` : ""}`
      : null,
    e?.locations?.length ? e.locations.join(", ") : null,
    e?.nationalities?.length ? `${e.nationalities.join(", ")} only` : null,
    e?.headcount && e.headcount > 1 ? `${e.headcount} positions` : null,
    e?.mustHaves?.length ? `${e.mustHaves.length} requirements` : null,
    e?.priorityTier ?? null,
  ].filter(Boolean) as string[];

  const approved = o.jdStatus === "approved";

  if (approved) {
    return (
      <>
        <h1 className="text-[21px] font-semibold tracking-tight">Job description</h1>
        <ProjectHeader openingId={id} />
        <JdRead
          openingId={id}
          jd={o.jdMarkdown}
          approvedBy={repo.user(o.jdApprovedBy ?? "")?.name ?? null}
          approvedAt={o.jdApprovedAt ? dateAt(o.jdApprovedAt) : null}
          canAmend={canWrite}
        />
        {o.requirements && (
          <div className="mt-8">
            <JobDetailsPanel
              openingId={id}
              title={o.title}
              requirements={o.requirements}
              jdApproved
              canEdit={allows(user, "opening.manage", { openingId: id, assignment: repo.assignmentFor(id, user.id) ?? null })}
              editedByName={repo.user(o.requirements.editedBy ?? "")?.name ?? null}
            />
          </div>
        )}
      </>
    );
  }

  return (
    <div className="mx-auto max-w-[860px]">
      <h1 className="text-[21px] font-semibold tracking-tight">Job description</h1>
      <p className="mb-6 text-[12.5px] leading-relaxed text-ink-soft">
        {brief?.notesMarkdown.trim() || brief?.recordingKey
          ? `Brief left by ${lead?.name ?? "the lead"}.`
          : "No brief was left."}{" "}
        Write it and approve it — the job cannot go live until you do.
      </p>

      {canWrite ? (
        <JdScreen
          openingId={id}
          title={o.title}
          clientName={client.name}
          initialNotes={brief?.notesMarkdown ?? ""}
          jd={o.jdMarkdown}
          extractedSummary={summary}
          fromLead={Boolean(brief && brief.capturedBy !== user.id)}
        />
      ) : (
        <div className="rounded-2xl border border-rule bg-surface px-7 py-14 text-center">
          <p className="text-[13px] text-ink-soft">
            Only an assigned TA can write this JD.
          </p>
          <p className="mt-1.5 text-[12.5px] text-ink-faint">
            Assigned to {o.assignedTaIds.map((t) => repo.user(t)?.name).join(", ")}.
          </p>
        </div>
      )}
    </div>
  );
}
