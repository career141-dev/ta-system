"use client";

import { INDUSTRIES } from "../../convex/lib/jobRequirements";
import { useEffect, useRef, useState } from "react";
import { deleteClient, saveContacts, updateClient } from "@/app/actions";
import { inputClass } from "./form";
import { Confirm } from "./Confirm";

export interface Contact {
  name: string;
  title: string;
  email: string;
  isPrimary: boolean;
}

export type Pane = "record" | "contacts" | null;

// The one industry list — see convex/lib/jobRequirements.

const STATUS = [
  { value: "active", label: "Active" },
  { value: "dormant", label: "Dormant" },
  { value: "archived", label: "Archived" },
];

/**
 * Editing a client, out of the way until it is wanted.
 *
 * These controls used to be a strip across every expanded card — three links
 * and, on most clients, the words "Cannot delete — 3 openings filed under it"
 * sitting there permanently. A row that reports what you cannot do, to someone
 * who was not trying to do it, is the definition of clutter. It is a menu now.
 */
export function ClientMenu({
  clientId,
  name,
  openingCount,
  canDelete,
  onPane,
  pane,
}: {
  clientId: string;
  name: string;
  industry: string;
  status: string;
  esaSignedAt: number | null;
  contacts: Contact[];
  openingCount: number;
  canDelete: boolean;
  onPane: (p: Pane) => void;
  pane: Pane;
}) {
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    const away = (e: MouseEvent) => {
      if (box.current && !box.current.contains(e.target as Node)) setOpen(false);
    };
    const key = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("mousedown", away);
    document.addEventListener("keydown", key);
    return () => {
      document.removeEventListener("mousedown", away);
      document.removeEventListener("keydown", key);
    };
  }, [open]);

  const item =
    "flex w-full items-center gap-2 px-3.5 py-2 text-left text-[12.5px] text-ink-soft transition-colors hover:bg-paper hover:text-ink";

  return (
    <div ref={box} className="relative">
      <button
        onClick={() => setOpen((v) => !v)}
        aria-label={`Manage ${name}`}
        aria-haspopup="menu"
        aria-expanded={open}
        className={`grid h-8 w-8 place-items-center rounded-lg text-ink-faint transition-all hover:bg-tag hover:text-ink ${
          open || pane ? "bg-tag text-ink" : ""
        }`}
      >
        <svg width={16} height={16} viewBox="0 0 16 16" aria-hidden="true">
          <circle cx="3.2" cy="8" r="1.3" fill="currentColor" />
          <circle cx="8" cy="8" r="1.3" fill="currentColor" />
          <circle cx="12.8" cy="8" r="1.3" fill="currentColor" />
        </svg>
      </button>

      {open && (
        <div
          role="menu"
          className="absolute right-0 top-full z-50 mt-1 w-[218px] overflow-hidden rounded-xl border border-rule bg-surface py-1 shadow-lg"
        >
          <button className={item} onClick={() => { onPane("record"); setOpen(false); }}>
            Edit the client
          </button>
          <button className={item} onClick={() => { onPane("contacts"); setOpen(false); }}>
            Contacts
          </button>

          {canDelete && (
            <div className="mt-1 border-t border-rule pt-1">
              {openingCount > 0 ? (
                // The reason belongs here, where someone is actually looking
                // for the delete — not across the card at all times.
                <p className="px-3.5 py-2 text-[11.5px] leading-snug text-ink-faint">
                  Cannot be deleted — {openingCount} opening{openingCount === 1 ? "" : "s"} filed
                  under it
                </p>
              ) : (
                <form action={deleteClient} className="px-3.5 py-1.5">
                  <input type="hidden" name="clientId" value={clientId} />
                  <Confirm
                    label="Delete this client"
                    question={`Delete ${name}? It moves to the Bin and can be restored for 7 days.`}
                    className="text-[12.5px] text-danger hover:underline"
                  />
                </form>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * Delete, visible on the card itself.
 *
 * It lived only in the "…" menu, and that button shows only while the pointer
 * is over the card — so on the Clients page there was no delete to be seen
 * (16 September). A client with openings filed under it still cannot go: the
 * button says why instead of disappearing.
 */
export function ClientDeleteButton({ clientId, name, openingCount }: { clientId: string; name: string; openingCount: number }) {
  const pill = "rounded-full border border-rule px-3 py-1 text-[12px] transition-colors";
  if (openingCount > 0) {
    const why = `${openingCount} opening${openingCount === 1 ? "" : "s"} filed under this client — move or delete them first`;
    return (
      <button type="button" disabled title={why} aria-label={`Delete ${name} (not available: ${why})`} className={`${pill} cursor-not-allowed text-ink-faint opacity-60`}>
        Delete
      </button>
    );
  }
  return (
    <form action={deleteClient} className="shrink-0">
      <input type="hidden" name="clientId" value={clientId} />
      <Confirm
        label="Delete"
        question={`Delete ${name}? It moves to the Bin and can be restored for 7 days.`}
        confirmLabel="Delete client"
        className={`${pill} text-ink-soft hover:border-danger/40 hover:text-danger`}
      />
    </form>
  );
}

import { useRouter } from "next/navigation";
import { useTransition } from "react";

export function ClientEditor({
  clientId,
  name,
  industry,
  status,
  esaSignedAt,
  researchNotes,
  contacts,
  pane,
  onClose,
}: {
  clientId: string;
  name: string;
  industry: string;
  status: string;
  esaSignedAt: number | null;
  researchNotes: string;
  contacts: Contact[];
  pane: Pane;
  onClose: () => void;
}) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [rows, setRows] = useState<Contact[]>(
    contacts.length ? contacts : [{ name: "", title: "", email: "", isPrimary: true }],
  );

  const asDate = (t: number | null) => (t ? new Date(t).toISOString().slice(0, 10) : "");

  const handleUpdateRecord = (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const fd = new FormData(e.currentTarget);
    startTransition(async () => {
      await updateClient(fd);
      router.refresh();
      onClose();
    });
  };

  const handleSaveContacts = (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const fd = new FormData(e.currentTarget);
    startTransition(async () => {
      await saveContacts(fd);
      router.refresh();
      onClose();
    });
  };

  if (pane === "record") {
    return (
      <form onSubmit={handleUpdateRecord} className="flex flex-col gap-3.5 border-t border-rule bg-paper/40 px-7 py-5">
        <input type="hidden" name="clientId" value={clientId} />
        <fieldset disabled={isPending} className="grid gap-3.5 sm:grid-cols-2 disabled:opacity-60">
          <label>
            <span className="mb-1.5 block text-[11.5px] text-ink-soft">Company name</span>
            <input name="name" defaultValue={name} required autoFocus className={inputClass} />
          </label>
          <label>
            <span className="mb-1.5 block text-[11.5px] text-ink-soft">Industry</span>
            <select name="industry" defaultValue={industry} className={`${inputClass} cursor-pointer`}>
              {[industry, ...INDUSTRIES.filter((i) => i !== industry)].map((i) => (
                <option key={i} value={i}>{i}</option>
              ))}
            </select>
          </label>
          <label>
            <span className="mb-1.5 block text-[11.5px] text-ink-soft">ESA signed</span>
            <input name="esaSignedAt" type="date" defaultValue={asDate(esaSignedAt)} className={inputClass} />
          </label>
          <label>
            <span className="mb-1.5 block text-[11.5px] text-ink-soft">Relationship</span>
            <select name="status" defaultValue={status} className={`${inputClass} cursor-pointer`}>
              {STATUS.map((x) => (
                <option key={x.value} value={x.value}>{x.label}</option>
              ))}
            </select>
          </label>
          <label className="sm:col-span-2">
            <span className="mb-1.5 block text-[11.5px] text-ink-soft">What we know about them — for Research</span>
            <textarea
              name="researchNotes"
              defaultValue={researchNotes}
              rows={3}
              maxLength={2000}
              placeholder="Website, LinkedIn company page, full company name, what they do…"
              className={inputClass}
            />
          </label>
        </fieldset>
        <div className="flex items-center gap-2.5">
          <button disabled={isPending} className="rounded-full bg-brand px-4 py-1.5 text-[12.5px] font-medium text-white disabled:opacity-60">
            {isPending ? "Saving…" : "Save"}
          </button>
          <button type="button" disabled={isPending} onClick={onClose} className="px-2 text-[12.5px] text-ink-soft hover:text-ink disabled:opacity-60">
            Cancel
          </button>
        </div>
      </form>
    );
  }

  return (
    <form onSubmit={handleSaveContacts} className="flex flex-col gap-3 border-t border-rule bg-paper/40 px-7 py-5">
      <input type="hidden" name="clientId" value={clientId} />
      <span className="text-[11.5px] text-ink-soft">
        Who you deal with. The one marked main is the name that shows on the client row.
      </span>

      <fieldset disabled={isPending} className="flex flex-col gap-3 disabled:opacity-60">
        {rows.map((c, i) => (
          <div key={i} className="grid items-end gap-2.5 sm:grid-cols-[1fr_1fr_1.2fr_auto_auto]">
            <input name="contactName" defaultValue={c.name} placeholder="Name" className={inputClass} />
            <input name="contactTitle" defaultValue={c.title} placeholder="Title" className={inputClass} />
            <input name="contactEmail" defaultValue={c.email} type="email" placeholder="Email" className={inputClass} />
            <label className="flex items-center gap-1.5 whitespace-nowrap pb-2.5 text-[11.5px] text-ink-soft">
              <input
                type="radio"
                name="primary"
                value={i}
                defaultChecked={c.isPrimary || (i === 0 && !rows.some((r) => r.isPrimary))}
              />
              Main
            </label>
            <button
              type="button"
              onClick={() => setRows(rows.filter((_, n) => n !== i))}
              className="pb-2 text-[12px] text-ink-faint hover:text-danger"
            >
              Remove
            </button>
          </div>
        ))}

        <button
          type="button"
          onClick={() => setRows([...rows, { name: "", title: "", email: "", isPrimary: false }])}
          className="self-start text-[12px] font-medium text-brand hover:underline"
        >
          + Another contact
        </button>
      </fieldset>

      <div className="flex items-center gap-2.5">
        <button disabled={isPending} className="rounded-full bg-brand px-4 py-1.5 text-[12.5px] font-medium text-white disabled:opacity-60">
          {isPending ? "Saving…" : "Save contacts"}
        </button>
        <button type="button" disabled={isPending} onClick={onClose} className="px-2 text-[12.5px] text-ink-soft hover:text-ink disabled:opacity-60">
          Cancel
        </button>
      </div>
    </form>
  );
}
