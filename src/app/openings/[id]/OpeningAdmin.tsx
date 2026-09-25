"use client";

import { useState } from "react";
import { setOpeningTeam, updateOpening } from "@/app/actions";
import { inputClass } from "@/components/form";
import { ASSIGNMENT_LABEL, ASSIGNMENT_NOTE, type AssignmentRole } from "@/data/types";
import { Confirm } from "@/components/Confirm";
import { SubmitButton } from "@/components/Submit";
import { PRIORITY_TARGET, type PriorityTier } from "@/data/types";

/**
 * Everything about the opening that is not the work itself — findings 02 and 08.
 *
 * Status moved out of here in the 12 Sep sweep: it now rides in the identity
 * band on every screen, because it was unreachable at the foot of this rail and
 * invisible to the TA actually running the role.
 *
 * What is left is the record and the team. The record used to be write-once,
 * which meant a client moving the band or adding a location could not be
 * written down at all.
 */
export function OpeningAdmin({
  openingId,
  title,
  salaryMin,
  salaryMax,
  salaryCurrency,
  packageNotes,
  locations,
  targetNationalities,
  headcount,
  priorityTier,
  team,
  people,
  canEdit,
  canDelete,
  counts,
}: {
  openingId: string;
  title: string;
  salaryMin: number | null;
  salaryMax: number | null;
  salaryCurrency: string;
  packageNotes: string;
  locations: string[];
  targetNationalities: string[];
  headcount: number;
  priorityTier: PriorityTier;
  team: { userId: string; role: AssignmentRole }[];
  people: { id: string; name: string; role: string }[];
  canEdit: boolean;
  canDelete: boolean;
  counts: { applications: number; posts: number; links: number };
}) {
  const [pane, setPane] = useState<null | "record" | "team">(null);
  if (!canEdit) return null;

  const field = (label: string, node: React.ReactNode) => (
    <label className="block">
      <span className="mb-1 block text-[11.5px] text-ink-soft">{label}</span>
      {node}
    </label>
  );

  return (
    <div className="flex flex-col gap-3 border-t border-rule pt-4">
      {pane === "record" ? (
        <form action={updateOpening} className="flex flex-col gap-3">
          <input type="hidden" name="openingId" value={openingId} />
          {field("Position", <input name="title" defaultValue={title} required className={inputClass} />)}

          <div className="grid grid-cols-2 gap-2.5">
            {field("Package from", <input name="salaryMin" defaultValue={salaryMin ?? ""} placeholder="475000" className={inputClass} />)}
            {field("to", <input name="salaryMax" defaultValue={salaryMax ?? ""} placeholder="550000" className={inputClass} />)}
          </div>
          {field("Currency", <input name="salaryCurrency" defaultValue={salaryCurrency} className={inputClass} />)}
          {field("Package notes", <input name="packageNotes" defaultValue={packageNotes} placeholder="+ fuel, negotiable" className={inputClass} />)}
          {field("Locations", <input name="locations" defaultValue={locations.join(", ")} placeholder="Colombo, Gampaha" className={inputClass} />)}
          {field("Nationality", <input name="targetNationalities" defaultValue={targetNationalities.join(", ")} placeholder="Leave empty for open" className={inputClass} />)}

          <div className="grid grid-cols-2 gap-2.5">
            {field("Headcount", <input name="headcount" type="number" min={1} defaultValue={headcount} className={inputClass} />)}
            {field(
              "Priority",
              <select name="priorityTier" defaultValue={priorityTier} className={`${inputClass} cursor-pointer`}>
                {(Object.keys(PRIORITY_TARGET) as PriorityTier[]).map((t) => (
                  <option key={t} value={t}>
                    {t} — {PRIORITY_TARGET[t].label}
                  </option>
                ))}
              </select>,
            )}
          </div>

          <div className="flex items-center gap-2">
            <SubmitButton
              pendingLabel="Saving…"
              onDone={() => setPane(null)}
              className="rounded-full bg-brand px-4 py-1.5 text-[12px] font-medium text-white disabled:opacity-60"
            >
              Save
            </SubmitButton>
            <button type="button" onClick={() => setPane(null)} className="px-2 text-[12px] text-ink-soft hover:text-ink">
              Cancel
            </button>
          </div>
        </form>
      ) : pane === "team" ? (
        <TeamEditor
          openingId={openingId}
          team={team}
          people={people}
          onClose={() => setPane(null)}
        />
      ) : (
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
          <button type="button" onClick={() => setPane("record")} className="text-[12px] font-medium text-brand hover:underline">
            Edit the details
          </button>
          <button type="button" onClick={() => setPane("team")} className="text-[12px] font-medium text-brand hover:underline">
            Change the team
          </button>

          {/* Deleting the opening is in its three-dots menu (OpeningMenu). */}
        </div>
      )}
    </div>
  );
}

const ROLES: AssignmentRole[] = [
  "primary_recruiter",
  "supporting_recruiter",
  "director",
  "client_contact",
];

/**
 * Who is on it, and as what — the assignment layer.
 *
 * It used to be a list of TAs, which could only express "on it" or "not on it".
 * The seat is the point: a director reviews, a client contact sees their
 * shortlist and none of the sourcing behind it, and both of those are people on
 * the opening who must not be given a recruiter's view of it.
 */
function TeamEditor({
  openingId,
  team,
  people,
  onClose,
}: {
  openingId: string;
  team: { userId: string; role: AssignmentRole }[];
  people: { id: string; name: string; role: string }[];
  onClose: () => void;
}) {
  const [rows, setRows] = useState(
    team.length ? team : [{ userId: people[0]?.id ?? "", role: "primary_recruiter" as AssignmentRole }],
  );

  return (
    <form action={setOpeningTeam} className="flex flex-col gap-3">
      <input type="hidden" name="openingId" value={openingId} />
      <span className="text-[11.5px] text-ink-faint">
        Somebody has to be recruiting it — a team of reviewers alone is refused.
      </span>

      {rows.map((r, i) => (
        <div key={i} className="flex flex-col gap-1.5">
          <div className="flex items-center gap-2">
            <select
              name="memberId"
              value={r.userId}
              onChange={(e) => {
                const next = [...rows];
                next[i] = { ...r, userId: e.target.value };
                setRows(next);
              }}
              className={`${inputClass} cursor-pointer py-1.5`}
            >
              {people.map((p) => (
                <option key={p.id} value={p.id}>{p.name}</option>
              ))}
            </select>
            <select
              name="memberRole"
              value={r.role}
              onChange={(e) => {
                const next = [...rows];
                next[i] = { ...r, role: e.target.value as AssignmentRole };
                setRows(next);
              }}
              className={`${inputClass} w-[160px] cursor-pointer py-1.5`}
            >
              {ROLES.map((x) => (
                <option key={x} value={x}>{ASSIGNMENT_LABEL[x]}</option>
              ))}
            </select>
            <button
              type="button"
              onClick={() => setRows(rows.filter((_, n) => n !== i))}
              aria-label="Remove"
              className="shrink-0 text-[12px] text-ink-faint hover:text-danger"
            >
              ✕
            </button>
          </div>
          <span className="text-[11px] leading-snug text-ink-faint">{ASSIGNMENT_NOTE[r.role]}</span>
        </div>
      ))}

      <button
        type="button"
        onClick={() =>
          setRows([...rows, { userId: people[0]?.id ?? "", role: "supporting_recruiter" }])
        }
        className="self-start text-[12px] font-medium text-brand hover:underline"
      >
        + Someone else
      </button>

      <div className="flex gap-2">
        <SubmitButton
          pendingLabel="Saving…"
          onDone={onClose}
          className="rounded-full bg-brand px-3.5 py-1.5 text-[12px] font-medium text-white disabled:opacity-60"
        >
          Save team
        </SubmitButton>
        <button type="button" onClick={onClose} className="px-2 text-[12px] text-ink-soft hover:text-ink">
          Cancel
        </button>
      </div>
    </form>
  );
}
