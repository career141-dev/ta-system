import { ProjectHeader } from "../../ProjectHeader";
import { RefereeCallsGrid } from "@/components/RefereeCallsGrid";
import { WorkLocationTabs } from "@/components/WorkLocationTabs";
import { primeStore } from "@/data/prime";
import { repo } from "@/data/store";
import { isDeskWide, isTa, seesEveryTaRow } from "@/lib/auth";
import { getCurrentUser } from "@/lib/session";
import { workdayDate } from "@/lib/workday";
import { inWorkLocation, workLocationView } from "@/lib/workLocations";
import { notFound } from "next/navigation";

export const dynamic = "force-dynamic";

export default async function RefereeCallsPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ location?: string; day?: string }>;
}) {
  const { id } = await params;
  const sp = await searchParams;
  await primeStore({ openingId: id });
  const user = await getCurrentUser();
  const opening = repo.opening(id);
  if (!opening) notFound();

  const workLocationId = workLocationView(opening, sp.location);
  const seesEveryone = isDeskWide(user) || seesEveryTaRow(user);
  const visible = repo.refereeCalls(id)
    .filter((call) => seesEveryone || call.addedBy === user.id)
    .filter((call) => inWorkLocation(call, workLocationId));
  const today = workdayDate(Date.now());
  const days = [...new Set([today, ...visible.map((call) => call.date)])].sort((a, b) => b.localeCompare(a));
  const day = days.includes(sp.day ?? "") ? sp.day! : today;
  const calls = visible.filter((call) => call.date === day);
  const userNames = Object.fromEntries(repo.users().map((person) => [person.id, person.name]));
  const locationParam = workLocationId === undefined ? "" : workLocationId || "unassigned";
  const editable = isTa(user);

  return <>
    <h1 className="text-[21px] font-semibold tracking-tight">Referee Calls</h1>
    <ProjectHeader openingId={id} />
    <WorkLocationTabs locations={opening.workLocations} selected={workLocationId} basePath={`/openings/${id}/hh/referees`} params={{ day }} />
    <div className="mb-4 flex flex-wrap items-end justify-between gap-3">
      <div>
        <p className="text-[13px] text-ink-soft">Type or paste the calls, then click Save. The end-of-day email sorts them into Positive and Not successful from the Feedback.</p>
        {!editable && <p className="mt-1 text-[12px] text-ink-faint">Read-only — calls are entered by the TA who made them.</p>}
      </div>
      <form className="flex items-end gap-2">
        {locationParam && <input type="hidden" name="location" value={locationParam} />}
        <label className="block">
          <span className="mb-1 block text-[10.5px] font-medium uppercase tracking-[0.06em] text-ink-faint">Work day</span>
          <select name="day" defaultValue={day} className="rounded-lg border border-rule bg-surface px-3 py-2 text-[12.5px]">
            {days.map((value) => <option key={value} value={value}>{value === today ? `Today · ${value}` : value}</option>)}
          </select>
        </label>
        <button className="rounded-lg border border-rule px-3 py-2 text-[12px] font-medium hover:border-brand">View</button>
      </form>
    </div>
    {workLocationId === "" && opening.workLocations?.length ? <p className="mb-3 rounded-lg bg-warn-soft px-3.5 py-2 text-[12px] text-warn">Select an active location to add calls. Existing unassigned calls remain available here.</p> : null}
    <RefereeCallsGrid
      key={`${workLocationId ?? "legacy"}:${day}`}
      openingId={id}
      actorId={user.id}
      workLocationId={workLocationId || undefined}
      day={day}
      calls={calls}
      canEdit={editable && workLocationId !== "" && day === today}
      showTa={seesEveryone}
      userNames={userNames}
    />
  </>;
}
