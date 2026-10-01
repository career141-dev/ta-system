import { notFound } from "next/navigation";
import { repo } from "@/data/store";
import { getCurrentUser } from "@/lib/session";
import { JdScreen } from "@/components/JdScreen";
import { OpeningBrief } from "@/components/OpeningBrief";
import { JdRead } from "./JdRead";
import { ProjectHeader } from "../ProjectHeader";
import { dateAt } from "@/lib/format";
import { primeStore } from "@/data/prime";
import { JobDetailsPanel } from "@/components/JobDetailsPanel";
import { allows } from "@/lib/auth";
import { MatchingStatus } from "@/components/MatchingStatus";
import { detailsFollowNotes } from "@/lib/jdChat";
import type { JdChatTurn } from "@/components/JdChat";

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
  // The same rule as every other edit on the opening, so a TA who is on it
  // through an assignment, or its lead, is not shut out of the notes (1 Oct).
  const canWrite =
    o.assignedTaIds.includes(user.id) ||
    allows(user, "opening.manage", { openingId: id, assignment: repo.assignmentFor(id, user.id) ?? null });
  // Everyone's notes, the viewer's own included, for the read-only views.
  const everyone = briefs
    .filter((b) => b.notesMarkdown.trim() || b.transcript)
    .map((b) => ({
      id: b.id,
      author: repo.user(b.capturedBy)?.name ?? "Someone on the desk",
      isLead: repo.user(b.capturedBy)?.role !== "ta",
      notes: [b.notesMarkdown.trim(), b.transcriptStatus === "ready" ? b.transcript ?? "" : ""].filter(Boolean).join("\n\n"),
      at: dateAt(b.capturedAt),
    }));

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

  // The JD chat, with the asker's name on each request.
  const thread = repo.jdChat(id);
  const chat: JdChatTurn[] = thread.map((m) => ({
    id: m.id,
    role: m.role,
    body: m.body,
    at: m.at,
    author: m.role === "user" ? repo.user(m.byUserId ?? "")?.name ?? null : null,
    hasVersion: !!m.jdMarkdown,
    failed: !!m.failed,
  }));
  // Once the chat has begun, the Job details wait for the approved JD (25 Sep).
  const detailsWait = !approved && !detailsFollowNotes(thread);

  // Moved here from the Overview: the fields are read from this JD, so they
  // are checked beside it (testing, 21 Sep).
  const details = o.requirements ? (
    <div id="job-details" className="mt-8 scroll-mt-24">
      {detailsWait && (
        <p className="mb-3 rounded-lg border border-rule bg-paper/60 px-4 py-2.5 text-[12.5px] text-ink-soft">
          Job details will be updated from the JD when you approve it. Until then they stay as they were
          read from the notes.
        </p>
      )}
      <JobDetailsPanel
        openingId={id}
        title={o.title}
        requirements={o.requirements}
        jdApproved={approved}
        canEdit={allows(user, "opening.manage", { openingId: id, assignment: repo.assignmentFor(id, user.id) ?? null })}
        editedByName={repo.user(o.requirements.editedBy ?? "")?.name ?? null}
      />
    </div>
  ) : null;

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
          chat={chat}
        />
        <OpeningBrief entries={everyone} className="mt-8" />
        <MatchingStatus openingId={id} />
        {details}
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
          chat={chat}
        />
      ) : (
        <>
          <OpeningBrief entries={everyone} className="mb-5" />
          <div className="rounded-2xl border border-rule bg-surface px-7 py-14 text-center">
            <p className="text-[13px] text-ink-soft">
              Only an assigned TA can write this JD.
            </p>
            <p className="mt-1.5 text-[12.5px] text-ink-faint">
              Assigned to {o.assignedTaIds.map((t) => repo.user(t)?.name).join(", ") || "no one yet"}.
            </p>
          </div>
        </>
      )}

      {details}
    </div>
  );
}
