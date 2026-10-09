"use client";

import { useState } from "react";
import { addUser, inviteUser, revokeUserInvite, setShortlistInbox, setUserActive, updateUser } from "@/app/actions";
import type { OffDeskAccount, PendingInvite } from "@/lib/invites";
import { inputClass } from "@/components/form";
import { SubmitButton } from "@/components/Submit";
import type { Role, User } from "@/data/types";

const ROLES: { value: Role; label: string; note: string }[] = [
  { value: "ta", label: "Talent Acquisition", note: "Works openings. Sees their own desk." },
  { value: "ta_support", label: "TA Support", note: "Works openings as a TA does, and reads every TA's Excel Tables rows on them." },
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
  currentUserId,
  shortlistInbox,
  invites,
  otherAccounts,
}: {
  users: User[];
  canEdit: boolean;
  currentUserId: string;
  shortlistInbox: string;
  invites: PendingInvite[];
  otherAccounts: OffDeskAccount[];
}) {
  const [adding, setAdding] = useState(false);
  const [inviting, setInviting] = useState(false);
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
            onClick={() => { setInviting((v) => !v); setAdding(false); }}
            className="flex items-center gap-2 rounded-full bg-brand px-4 py-2 text-[13px] font-medium text-white transition-opacity hover:opacity-90"
          >
            <span className="text-[15px] leading-none">{inviting ? "✕" : "✉"}</span>
            {inviting ? "Cancel" : "Invite someone"}
          </button>
        )}
        {canEdit && (
          <button
            onClick={() => { setAdding((v) => !v); setInviting(false); }}
            className="flex items-center gap-2 rounded-full border border-brand-line px-4 py-2 text-[13px] font-medium text-brand transition-colors hover:bg-brand-soft"
          >
            <span className="text-[15px] leading-none">{adding ? "✕" : "+"}</span>
            {adding ? "Cancel" : "Add without invite"}
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

      {inviting && (
        <form
          action={inviteUser}
          className="mb-6 rounded-2xl border border-rule bg-surface px-6 py-5"
        >
          <div className="grid grid-cols-[minmax(0,1fr)] gap-4 sm:grid-cols-2 lg:grid-cols-3">
            <label>
              <span className="mb-1.5 block text-[12px] text-ink-soft">Email</span>
              <input name="email" type="email" required autoFocus placeholder="nuha@career141.com" className={inputClass} />
            </label>
            <label>
              <span className="mb-1.5 block text-[12px] text-ink-soft">Name</span>
              <input name="name" placeholder="Nuha Rizwan" className={inputClass} />
            </label>
            <label>
              <span className="mb-1.5 block text-[12px] text-ink-soft">Role</span>
              <select name="role" defaultValue="ta" className={`${inputClass} cursor-pointer`}>
                {ROLES.map((r) => (
                  <option key={r.value} value={r.value}>{r.label} — {r.note}</option>
                ))}
              </select>
            </label>
          </div>
          <SubmitButton
            pendingLabel="Sending…"
            onDone={() => setInviting(false)}
            className="mt-4 rounded-full bg-brand px-5 py-2.5 text-[13px] font-medium text-white transition-opacity hover:opacity-90 disabled:opacity-60"
          >
            Send invite
          </SubmitButton>
          <p className="mt-3 max-w-[80ch] text-[11.5px] leading-relaxed text-ink-faint">
            The role is saved now, so it applies from their first sign-in. They get an email from
            Clerk with a link to set up their sign-in. You can change the role later with Edit.
          </p>
        </form>
      )}

      {canEdit && invites.length > 0 && (
        <div className="mb-6 overflow-hidden rounded-2xl border border-rule bg-surface">
          <div className="border-b border-rule px-6 py-2.5 text-[11px] uppercase tracking-[0.08em] text-ink-faint">
            Invites waiting to be accepted
          </div>
          <div className="divide-y divide-rule">
            {invites.map((i) => (
              <div key={i.id} className="flex flex-wrap items-center gap-x-5 gap-y-1 px-6 py-3">
                <span className="min-w-[200px] flex-1 text-[13px]">{i.email}</span>
                <span className="w-[150px] text-[12.5px] text-ink-soft">
                  {i.role && i.role in ROLE_LABEL ? ROLE_LABEL[i.role as Role] : "—"}
                </span>
                <span className="text-[12px] text-ink-faint">sent {new Date(i.createdAt).toLocaleDateString()}</span>
                <form action={revokeUserInvite}>
                  <input type="hidden" name="invitationId" value={i.id} />
                  <SubmitButton
                    tone="dark"
                    pendingLabel="Revoking…"
                    className="text-[12.5px] text-ink-faint transition-colors hover:text-ink disabled:opacity-60"
                  >
                    Revoke
                  </SubmitButton>
                </form>
              </div>
            ))}
          </div>
        </div>
      )}

      {adding && (
        <form action={addUser} className="mb-6 rounded-2xl border border-rule bg-surface px-6 py-5">
          <div className="grid grid-cols-[minmax(0,1fr)] gap-4 sm:grid-cols-2 lg:grid-cols-4">
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
          <SubmitButton
            pendingLabel="Adding…"
            className="mt-4 rounded-full bg-brand px-5 py-2.5 text-[13px] font-medium text-white transition-opacity hover:opacity-90 disabled:opacity-60"
          >
            Add them
          </SubmitButton>
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
          <SubmitButton
            tone="dark"
            pendingLabel="Saving…"
            className="rounded-full border border-rule-strong px-5 py-2.5 text-[13px] font-medium disabled:opacity-60"
          >
            Save
          </SubmitButton>
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
                <form action={updateUser} className="flex flex-col gap-3">
                  <input type="hidden" name="userId" value={u.id} />
                  <div className="grid grid-cols-[minmax(0,1fr)] gap-3 sm:grid-cols-2 lg:grid-cols-4">
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
                    <SubmitButton
                      pendingLabel="Saving…"
                      onDone={() => setEditing(null)}
                      className="rounded-full bg-brand px-4 py-1.5 text-[12.5px] font-medium text-white disabled:opacity-60"
                    >
                      Save
                    </SubmitButton>
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
                      {/* Nobody marks themselves as left — that is how a desk locks itself out. */}
                      {u.id !== currentUserId && (
                        <form action={setUserActive}>
                          <input type="hidden" name="userId" value={u.id} />
                          <input type="hidden" name="active" value={u.isActive ? "0" : "1"} />
                          <SubmitButton
                            tone="dark"
                            pendingLabel="Saving…"
                            className="text-[12.5px] text-ink-faint transition-colors hover:text-ink disabled:opacity-60"
                          >
                            {u.isActive ? "Mark as left" : "Bring back"}
                          </SubmitButton>
                        </form>
                      )}
                    </div>
                  )}
                </div>
              )}
            </div>
          ))}
        </div>
      </div>

      {/* Accounts the older app created. They exist — which is why inviting
          one says "already has an account" — but are not on this desk and
          have no access here until an admin gives them a role. */}
      {canEdit && otherAccounts.length > 0 && (
        <div className="mt-8 overflow-hidden rounded-2xl border border-rule bg-surface">
          <div className="border-b border-rule px-6 py-3">
            <div className="text-[13.5px] font-semibold">Other accounts — not on the desk</div>
            <p className="mt-0.5 max-w-[84ch] text-[11.5px] leading-relaxed text-ink-faint">
              Created by the older app. They have no access here until you give them a role. Only
              those marked &ldquo;can sign in&rdquo; have a login on this Clerk instance; the others
              need an invite after you give them access.
            </p>
          </div>
          <div className="divide-y divide-rule">
            {otherAccounts.map((a) => (
              <form key={a.email} action={addUser} className="flex flex-wrap items-center gap-x-5 gap-y-2 px-6 py-3">
                <input type="hidden" name="email" value={a.email} />
                <input type="hidden" name="name" value={a.fullName} />
                <div className="min-w-[220px] flex-1">
                  <div className="text-[13px]">{a.fullName}</div>
                  <div className="text-[12px] text-ink-faint">
                    {a.email}
                    {a.duplicates > 0 && ` · ${a.duplicates + 1} records`}
                  </div>
                </div>
                <span className="w-[130px] text-[11.5px] text-ink-faint">old app: {a.oldAppRole}</span>
                <span className={`w-[100px] text-[11.5px] ${a.canSignInHere ? "text-brand" : "text-ink-faint"}`}>
                  {a.canSignInHere ? "can sign in" : "no login here"}
                </span>
                <select name="role" defaultValue="ta" className={`${inputClass} w-[170px] cursor-pointer`}>
                  {ROLES.map((r) => (
                    <option key={r.value} value={r.value}>{r.label}</option>
                  ))}
                </select>
                <SubmitButton
                  tone="dark"
                  pendingLabel="Giving access…"
                  className="rounded-full border border-brand-line px-4 py-1.5 text-[12.5px] font-medium text-brand hover:bg-brand-soft disabled:opacity-60"
                >
                  Give access
                </SubmitButton>
              </form>
            ))}
          </div>
        </div>
      )}
    </>
  );
}
