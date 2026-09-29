import { notFound } from "next/navigation";
import { allows } from "@/lib/auth";
import { repo } from "@/data/store";
import { getCurrentUser } from "@/lib/session";
import { primeStore } from "@/data/prime";
import { ProjectHeader } from "../ProjectHeader";
import { requireSourcingSeat } from "../sourcingGate";
import { CandidateList, applyFilters, type ListFilters } from "@/components/CandidateList";
import { StatRow } from "@/components/StatRow";
import { ScoopUpload } from "@/components/ScoopUpload";

/**
 * Scoops on an opening (29 Sep).
 *
 * The CVs the Director or a TA Lead sent the TA are uploaded here rather than
 * read from the TA's mailbox. Each is filed on this opening and flagged as a
 * scoop; the TA shortlists it from this list like any other CV, and it is
 * counted as a scoop in the end-of-day email once it is sent to the Director.
 */
export default async function ScoopsPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<ListFilters>;
}) {
  const { id } = await params;
  const filters = await searchParams;
  await primeStore({ openingId: id });
  await requireSourcingSeat(id);
  const opening = repo.opening(id);
  if (!opening) notFound();
  const user = await getCurrentUser();

  const everyone = repo.applications(id).filter((a) => a.scoopReceivedAt || a.scoopFrom);
  const apps = applyFilters(everyone, filters, user.id);
  const waiting = everyone.filter((a) => !a.ownerTaId).length;
  const canAct = allows(user, "opening.act", { openingId: id, assignment: repo.assignmentFor(id, user.id) ?? null });
  // Who can have sent it — the same people the scoop rule accepts.
  const senders = repo
    .users()
    .filter((u) => u.isActive && (u.role === "director" || u.role === "ta_lead" || u.role === "ops"))
    .map((u) => ({ id: u.id, name: u.name }));

  return (
    <>
      <h1 className="text-[21px] font-semibold tracking-tight">Scoops</h1>
      <ProjectHeader openingId={id} />

      <StatRow
        items={[
          { n: everyone.length, label: "Scoops on this opening" },
          { n: waiting, label: "Not shortlisted yet" },
        ]}
      />

      {canAct && <ScoopUpload openingId={id} senders={senders} />}

      <CandidateList
        openingId={id}
        apps={apps}
        currentUser={user}
        title="Scoops"
        filters={filters}
        claimable
        basePath={`/openings/${id}/scoops`}
      />
    </>
  );
}
