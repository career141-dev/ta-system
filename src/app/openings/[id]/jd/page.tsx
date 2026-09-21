import { notFound } from "next/navigation";
import { repo } from "@/data/store";
import { getCurrentUser } from "@/lib/session";
import { JdScreen } from "@/components/JdScreen";
import { JdRead } from "./JdRead";
import { ProjectHeader } from "../ProjectHeader";
import { dateAt } from "@/lib/format";
import { primeStore } from "@/data/prime";

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
  // Every brief on the opening: the lead's from creation and each TA's notes.
  const briefs = repo.briefsForOpening(id);
  const brief = briefs[0] ?? (o.briefId ? repo.brief(o.briefId) : null);
  const mine = briefs.filter((b) => b.capturedBy === user.id).pop() ?? null;
  const others = briefs
    .filter((b) => b.capturedBy !== user.id && (b.notesMarkdown.trim() || b.transcript))
    .map((b) => ({
      id: b.id,
      author: repo.user(b.capturedBy)?.name ?? "Someone on the desk",
      isLead: repo.user(b.capturedBy)?.role !== "ta",
      notes: [b.notesMarkdown.trim(), b.transcriptStatus === "ready" ? b.transcript ?? "" : ""].filter(Boolean).join("\n\n"),
      at: dateAt(b.capturedAt),
    }));
  const e = brief?.extracted;
  const lead = repo.user(o.taLeadId);
  const canWrite = o.assignedTaIds.includes(user.id) || user.role === "admin";

  // Named, not bare values: "P3" on its own read as a code (testing, 21 Sep).
  const summary = [
    e?.salaryMin
      ? `Salary ${e.currency} ${e.salaryMin.toLocaleString()}${e.salaryMax ? `–${e.salaryMax.toLocaleString()}` : ""}`
      : e?.packageNotes?.trim()
        ? `Package ${e.packageNotes.trim()}`
        : null,
    e?.locations?.length ? `Location ${e.locations.join(", ")}` : null,
    e?.nationalities?.length ? `${e.nationalities.join(", ")} nationals only` : null,
    e?.headcount && e.headcount > 1 ? `${e.headcount} positions` : null,
    e?.mustHaves?.length ? `${e.mustHaves.length} requirement${e.mustHaves.length === 1 ? "" : "s"}` : null,
    e?.priorityTier ? `Priority ${e.priorityTier.replace(/^P/, "")}` : null,
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
      </>
    );
  }

  return (
    <div className="mx-auto max-w-[860px]">
      <h1 className="text-[21px] font-semibold tracking-tight">Job description</h1>
      <p className="mb-6 text-[12.5px] leading-relaxed text-ink-soft">
        {others.length
          ? `Brief left by ${[...new Set(others.map((b) => b.author))].join(" and ")}.`
          : brief?.recordingKey
            ? `Brief left by ${lead?.name ?? "the lead"}.`
            : "No brief was left."}{" "}
        Write it and approve it — the job cannot go live until you do.
      </p>

      {canWrite ? (
        <JdScreen
          openingId={id}
          title={o.title}
          clientName={client.name}
          initialNotes={mine?.notesMarkdown ?? ""}
          otherBriefs={others}
          jd={o.jdMarkdown}
          extractedSummary={summary}
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
