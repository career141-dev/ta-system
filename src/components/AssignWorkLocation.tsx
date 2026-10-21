import type { WorkLocation } from "@/lib/workLocations";
import { assignWorkLocation, assignSelectedWorkLocations } from "@/app/actions";
import { SubmitButton } from "./Submit";

export function AssignWorkLocation({ openingId, locations, selected, linkId, applicationId }: {
  openingId: string; locations?: WorkLocation[]; selected?: string; linkId?: string; applicationId?: string;
}) {
  if (!locations?.length) return null;
  return <form action={assignWorkLocation} className="flex flex-wrap items-center gap-2 px-5 py-3 text-[12px]">
    <input type="hidden" name="openingId" value={openingId} />
    {linkId && <input type="hidden" name="linkId" value={linkId} />}
    {applicationId && <input type="hidden" name="applicationId" value={applicationId} />}
    <label>Work location <select name="workLocationId" defaultValue={selected ?? ""} required className="ml-2 rounded border border-rule bg-surface px-2 py-1">
      <option value="" disabled>Location not assigned</option>
      {locations.filter(l => !l.archived).map(l => <option key={l.id} value={l.id}>{l.name}</option>)}
    </select></label>
    <SubmitButton pendingLabel="Saving…" className="text-brand">Save location</SubmitButton>
  </form>;
}

export function WorkLocationBulkControls({ locations }: { locations?: WorkLocation[] }) {
  if (!locations?.length) return null;
  return <>
    <select name="targetWorkLocationId" aria-label="Location for selected candidates" defaultValue="" className="rounded border border-rule bg-surface px-2 py-1 text-[12px]">
      <option value="" disabled>Choose work location</option>
      {locations.filter(l => !l.archived).map(l => <option key={l.id} value={l.id}>{l.name}</option>)}
    </select>
    <SubmitButton formAction={assignSelectedWorkLocations} pendingLabel="Assigning…" className="rounded-full border border-rule px-3 py-1 text-[12px] text-brand">Assign selected to location</SubmitButton>
  </>;
}
