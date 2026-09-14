"use client";

import { useState } from "react";
import { addUser, setShortlistInbox, setUserActive, updateUser } from "@/app/actions";
import { inputClass } from "@/components/form";
import type { Role, User } from "@/data/types";

const ROLES: { value: Role; label: string; note: string }[] = [
  { value: "ta", label: "Talent Acquisition", note: "Works openings. Sees their own desk." },
  { value: "ta_lead", label: "TA Lead", note: "Assigns work and sees every desk." },
  { value: "director", label: "Director", note: "Reviews shortlists." },
  { value: "ops", label: "Operations", note: "Runs the process, not the roles." },
  { value: "admin", label: "Admin", note: "Everything, including this page." },
  { value: "viewer", label: "Viewer", note: "Read only." },
  { value: "client", label: "Client", note: "Sees their own openings only." },
];

const ROLE_LABEL = Object.fromEntries(ROLES.map((r) => [r.value, r.label])) as Record<Role, string>;

/**
 * The desk — finding 11.
 *
 * Users existed only in the seed: nobody could be added, nobody's role changed,
 * and nobody who left could be taken off the pickers. Leaving is the one that
 * mattered, because a departed TA stayed assignable forever.
 *
 * Nobody is ever deleted. A name sits on a year of stage changes, call logs and
 * shortlist claims, and all of that has to keep resolving to a person.
 */
export function PeopleAdmin({
  users,
  canEdit,
  shortlistInbox,
}: {
  users: User[];
  canEdit: boolean;
  shortlistInbox: string;
}) {
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<string | null>(null);
  const [showGone, setShowGone] = useState(false);

  const active = users.filter((u) => u.isActive);
  const gone = users.filter((u) => !u.isActive);
  const shown = showGone ? [...active, ...gone] : active;

  return (
    <>
      <div className="mb-6 flex flex-wrap items-center gap-4">
        {canEdit && (
          <button
            onClick={() => setAdding((v) => !v)}
            className="flex items-center gap-2 rounded-full border border-brand-line px-4 py-2 text-[13px] font-medium text-brand transition-colors hover:bg-brand-soft"
          >
            <span className="text-[15px] leading-none">{adding ? "✕" : "+"}</span>
            {adding ? "Cancel" : "Add someone"}
          </button>
        )}
        {gone.length > 0 && (
          <button
            onClick={() => setShowGone((v) => !v)}
            className="text-[12.5px] text-ink-soft transition-colors hover:text-ink"
          >
            {showGone ? "Hide" : "Show"} {gone.length} who have left
          </button>
        )}
      </div>

      {adding && (
        <form action={addUser} className="mb-6 rounded-2xl border border-rule bg-surface px-6 py-5">
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <label>
              <span className="mb-1.5 block text-[12px] text-ink-soft">Name</span>
              <input name="name" required autoFocus placeholder="Nuha Rizwan" className={inputClass} />
            </label>
            <label>
              <span className="mb-1.5 block text-[12px] text-ink-soft">Email</span>
              <input name="email" type="email" placeholder="nuha@career141.com" className={inputClass} />
            </label>
            <label>
              <span className="mb-1.5 block text-[12px] text-ink-soft">Mobile</span>
              <input name="phone" placeholder="+94 77 000 0000" className={inputClass} />
            </label>
            <label>
              <span className="mb-1.5 block text-[12px] text-ink-soft">Role</span>
              <select name="role" defaultValue="ta" className={`${inputClass} cursor-pointer`}>
                {ROLES.map((r) => (
                  <option key={r.value} value={r.value}>{r.label}</option>
                ))}
              </select>
            </label>
            <label className="sm:col-span-2">
              <span className="mb-1.5 block text-[12px] text-ink-soft">
                Applications inbox
              </span>
              <input
                name="routingEmail"
                type="email"
                placeholder="nuha.jobs@career141.com — left blank, one is generated"
                className={inputClass}
              />
            </label>
          </div>
          <button className="mt-4 rounded-full bg-brand px-5 py-2.5 text-[13px] font-medium text-white transition-opacity hover:opacity-90">
            Add them
          </button>
          <p className="mt-3 max-w-[80ch] text-[11.5px] leading-relaxed text-ink-faint">
            The mobile shows on every snippet they publish, so it is worth getting right. The
            applications inbox is the address that goes into the LinkedIn job setup for every
            advert they run — set it up in Microsoft 365 first, then put it here. Shortlist replies
            use the one shared box below, not this.
          </p>
        </form>
      )}

      {canEdit && (
        <form
          action={setShortlistInbox}
          className="mb-6 flex flex-wrap items-end gap-3 rounded-2xl border border-rule bg-surface px-6 py-5"
        >
          <label className="min-w-[280px] flex-1">
            <span className="mb-1.5 block text-[12px] text-ink-soft">
              Shortlist replies inbox — one for the whole desk
            </span>
            <input
              name="shortlistInbox"
              type="email"
              defaultValue={shortlistInbox}
              className={inputClass}
            />
          </label>
          <button className="rounded-full border border-rule-strong px-5 py-2.5 text-[13px] font-medium">
            Save
          </button>
          <p className="w-full max-w-[84ch] text-[11.5px] leading-relaxed text-ink-faint">
            Copied on every shortlist email to a Director or a client, and named on the reply-to,
            so the reply is tracked whichever way they answer. One box is enough because the
            subject line already names the client, the role and the day — which is what places the
            reply against the right set.
          </p>
        </form>
      )}

      <div className="overflow-hidden rounded-2xl border border-rule bg-surface">
        <div className="divide-y divide-rule">
          {shown.map((u) => (
            <div key={u.id} className={`px-6 py-4 ${u.isActive ? "" : "bg-paper/50"}`}>
              {editing === u.id ? (
                <form action={updateUser} onSubmit={() => setEditing(null)} className="flex flex-col gap-3">
                  <input type="hidden" name="userId" value={u.id} />
                  <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
                    <input name="name" defaultValue={u.name} required className={inputClass} />
                    <input name="email" defaultValue={u.email} type="email" className={inputClass} />
                    <input name="phone" defaultValue={u.phone ?? ""} className={inputClass} />
                    <select name="role" defaultValue={u.role} className={`${inputClass} cursor-pointer`}>
                      {ROLES.map((r) => (
                        <option key={r.value} value={r.value}>{r.label}</option>
                      ))}
                    </select>
                  </div>
                  {/*
                    Kept apart from the address above on purpose. That one is
                    where a person is written to; this one is a drop box that
                    nobody writes to by hand — it is the address put into the
                    LinkedIn job setup, and everything landing in it is an
                    applicant to be filed.
                  */}
                  <label className="block">
                    <span className="mb-1 block text-[11px] uppercase tracking-[0.08em] text-ink-faint">
                      Applications inbox
                    </span>
                    <input
                      name="routingEmail"
                      defaultValue={u.routingEmail ?? ""}
                      type="email"
                      placeholder="nuha.jobs@career141.com"
                      className={`${inputClass} max-w-[360px]`}
                    />
                    <span className="mt-1 block text-[11px] text-ink-faint">
                      Goes into the LinkedIn job setup — one per recruiter, because the address is
                      the only thing that says whose adverts a CV came from. Shortlist replies use
                      one shared box for the whole desk instead.
                    </span>
                  </label>
                  <div className="flex items-center gap-2.5">
                    <button className="rounded-full bg-brand px-4 py-1.5 text-[12.5px] font-medium text-white">Save</button>
                    <button type="button" onClick={() => setEditing(null)} className="px-2 text-[12.5px] text-ink-soft hover:text-ink">
                      Cancel
                    </button>
                  </div>
                </form>
              ) : (
                <div className="flex flex-wrap items-center gap-x-5 gap-y-2">
                  <span className={`grid h-9 w-9 shrink-0 place-items-center rounded-full text-[11px] font-bold text-white ${u.isActive ? "bg-brand" : "bg-rule-strong"}`}>
                    {u.initials}
                  </span>
                  <div className="min-w-[180px] flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="text-[14px] font-medium">{u.name}</span>
                      {!u.isActive && (
                        <span className="rounded bg-tag px-1.5 py-px text-[11px] text-ink-soft">Left</span>
                      )}
                    </div>
                    <p className="mt-0.5 text-[12px] text-ink-faint">
                      {u.email}
                      {u.phone && ` · ${u.phone}`}
                    </p>
                  </div>
                  <span className="w-[150px] shrink-0 text-[12.5px] text-ink-soft">{ROLE_LABEL[u.role]}</span>

                  {canEdit && (
                    <div className="flex shrink-0 items-center gap-4">
                      <button onClick={() => setEditing(u.id)} className="text-[12.5px] text-ink-soft transition-colors hover:text-ink">
                        Edit
                      </button>
                      <form action={setUserActive}>
                        <input type="hidden" name="userId" value={u.id} />
                        <input type="hidden" name="active" value={u.isActive ? "0" : "1"} />
                        <button className="text-[12.5px] text-ink-faint transition-colors hover:text-ink">
                          {u.isActive ? "Mark as left" : "Bring back"}
                        </button>
                      </form>
                    </div>
                  )}
                </div>
              )}
            </div>
          ))}
        </div>
      </div>
    </>
  );
}
