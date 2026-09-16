"use client";

import { useState, useTransition } from "react";
import { BriefRecorder, type SavedRecording } from "./BriefRecorder";
import { createOpeningInline, createOpeningStep1 } from "@/app/actions";
import { ClientPicker, PeoplePicker, inputClass } from "./form";
import { NewClientDialog, Spinner, type NewClient } from "./NewClientDialog";
import type { Client, User } from "@/data/types";

/**
 * Screen one. Short for everyone, and shorter still for a TA.
 *
 * A lead gets the brief here because they have no screen two — the JD is the
 * TA's to write. A TA gets client and position only, then moves on to it.
 *
 * Two homes. On the New opening page it posts and navigates, as it always has.
 * Inside the create-client pop-up (`onCreated` given) the client is already
 * chosen, the save happens in place, and the pop-up decides what comes next.
 */
const COUNTRIES = [
  "Sri Lanka", "Bangladesh", "India", "Maldives", "Saudi Arabia",
  "United Arab Emirates", "Qatar", "Oman", "Kuwait", "Bahrain",
  "Singapore", "Malaysia", "Vietnam",
];

const NATIONALITIES = [
  "Sri Lankan", "Bangladeshi", "Indian", "Pakistani", "Filipino",
  "Nepali", "Maldivian", "Saudi", "Emirati",
];

const LOCAL: Record<string, string> = {
  "Sri Lanka": "Sri Lankan", Bangladesh: "Bangladeshi", India: "Indian",
  Maldives: "Maldivian", "Saudi Arabia": "Saudi", "United Arab Emirates": "Emirati",
  Qatar: "Qatari", Oman: "Omani", Kuwait: "Kuwaiti", Bahrain: "Bahraini",
  Singapore: "Singaporean", Malaysia: "Malaysian", Vietnam: "Vietnamese",
};
const localNationality = (c: string) => LOCAL[c] ?? c;

const chev = (
  <svg width={14} height={14} viewBox="0 0 16 16" aria-hidden="true" className="pointer-events-none absolute right-3.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-ink-faint">
    <path d="M4 6.5L8 10.5L12 6.5" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);

export function CaptureForm({
  clients,
  tas,
  isLead,
  initialClientId,
  lockedClient,
  onCreated,
  canAddClient = false,
}: {
  clients: Pick<Client, "id" | "name" | "industry">[];
  tas: User[];
  isLead: boolean;
  initialClientId?: string | null;
  /** Inside the pop-up: the client just saved, shown rather than picked. */
  lockedClient?: NewClient;
  /** Inside the pop-up: called with the new opening instead of navigating. */
  onCreated?: (created: { openingId: string; title: string }) => void;
  /** Offers "+ New client" beside the picker; only for people who may add one. */
  canAddClient?: boolean;
}) {
  const inline = Boolean(onCreated);
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  // A client added from the picker joins the list and is selected; the picker
  // is remounted (`pickerKey`) so it starts from the new selection.
  const [clientList, setClientList] = useState(clients);
  const [pickerKey, setPickerKey] = useState(0);
  const [addingClient, setAddingClient] = useState(false);
  // The brief (lead) or details (TA) box. Kept in state so a transcribed
  // recording can be added to what has already been typed.
  const [notes, setNotes] = useState("");
  const addTranscript = (text: string) =>
    setNotes((prev) => `${prev.trim() ? `${prev.trimEnd()}\n\n` : ""}From the recording:\n${text.trim()}`);
  const [rec, setRec] = useState<SavedRecording | null>(
    null,
  );
  const [title, setTitle] = useState("");
  const [country, setCountry] = useState("Sri Lanka");
  const [client, setClient] = useState<string | null>(lockedClient?.id ?? initialClientId ?? null);
  const [assigned, setAssigned] = useState<string[]>([]);

  const ready = Boolean(title.trim() && client && (!isLead || assigned.length));

  const selectClass = `${inputClass} cursor-pointer appearance-none pr-10`;
  const card =
    "overflow-hidden rounded-2xl border border-rule bg-surface shadow-[0_1px_2px_rgba(23,28,24,0.04)]";
  const head = inline ? "border-b border-rule px-6 py-3.5" : "border-b border-rule px-7 py-4";

  const submitInline = (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (!ready || pending) return;
    setError(null);
    const data = new FormData(e.currentTarget);
    startTransition(async () => {
      const r = await createOpeningInline(data);
      if (!r.ok) setError(r.error);
      else onCreated!({ openingId: r.openingId, title: r.title });
    });
  };

  return (
    <form
      action={inline ? undefined : createOpeningStep1}
      onSubmit={inline ? submitInline : undefined}
      className={`flex flex-col ${inline ? "gap-4" : "gap-5"}`}
    >
      {lockedClient ? (
        <input type="hidden" name="clientId" value={lockedClient.id} />
      ) : (
        <section className={card}>
          <div className={`${head} flex items-center justify-between gap-3`}>
            <h2 className="text-[13.5px] font-semibold">Client</h2>
            {canAddClient && (
            <button
              type="button"
              onClick={() => setAddingClient(true)}
              className="flex items-center gap-1 rounded-full border border-brand-line px-3 py-1 text-[12px] font-medium text-brand transition-colors hover:bg-brand-soft"
            >
              <span className="text-[14px] leading-none">+</span> New client
            </button>
            )}
          </div>
          <div className="px-7 py-6">
            <ClientPicker key={pickerKey} name="clientId" clients={clientList} initial={client} onChange={setClient} />
          </div>
        </section>
      )}
      {addingClient && (
        <NewClientDialog
          withOpening={false}
          onClose={() => setAddingClient(false)}
          onClientCreated={(c) => {
            setClientList((list) => [c, ...list.filter((x) => x.id !== c.id)]);
            setClient(c.id);
            setPickerKey((k) => k + 1);
          }}
        />
      )}

      <section className={card}>
        <div className={head}>
          <h2 className="text-[13.5px] font-semibold">Position</h2>
        </div>
        <div className={inline ? "px-6 py-5" : "px-7 py-6"}>
          <input
            name="title"
            required
            autoFocus={inline}
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="Head of Finance"
            className={`${inputClass} max-w-[420px] text-[15px]`}
          />

          {/* Where the job is and whose passport the client wants are two
              different questions — a Dhaka post can be a search for Sri Lankans.
              Sourcing cannot work this out later, so it is asked here. */}
          <div className="mt-6 grid gap-5 sm:grid-cols-2">
            <label>
              <span className="mb-1.5 block text-[12px] text-ink-soft">Country the job is in</span>
              <div className="relative">
                <select name="country" value={country} onChange={(e) => setCountry(e.target.value)} className={selectClass}>
                  {COUNTRIES.map((c) => (
                    <option key={c} value={c}>{c}</option>
                  ))}
                </select>
                {chev}
              </div>
            </label>

            <label>
              <span className="mb-1.5 block text-[12px] text-ink-soft">Hiring for</span>
              <div className="relative">
                <select name="hiringFor" defaultValue="local" className={selectClass}>
                  <option value="local">{localNationality(country)} — a local hire</option>
                  {NATIONALITIES.filter((n) => n !== localNationality(country)).map((n) => (
                    <option key={n} value={n}>{n} — sent to {country}</option>
                  ))}
                </select>
                {chev}
              </div>
            </label>
          </div>

          <label className="mt-5 block max-w-[420px]">
            <span className="mb-1.5 block text-[12px] text-ink-soft">
              Gender, only if the client specified it
            </span>
            <div className="relative">
              <select name="targetGender" defaultValue="" className={selectClass}>
                <option value="">Not specified</option>
                <option value="Female">Female</option>
                <option value="Male">Male</option>
              </select>
              {chev}
            </div>
            <span className="mt-1.5 block text-[11.5px] leading-relaxed text-ink-faint">
              Leave this alone unless they asked. LinkedIn does not state gender, so
              sourcing can only judge it from pronouns or an unambiguous name — it will
              say when it could not tell rather than guessing.
            </span>
          </label>
        </div>
      </section>

      {!isLead && (
        <section className={card}>
          <div className={head}>
            <h2 className="text-[13.5px] font-semibold">
              Details <span className="ml-1.5 font-normal text-[12px] text-ink-faint">optional</span>
            </h2>
            <p className="mt-0.5 text-[12.5px] text-ink-soft">
              Anything you know about the role. The JD draft is written from these and the lead’s brief.
            </p>
          </div>
          <div className={inline ? "px-6 py-5" : "px-7 py-6"}>
            <div className="mb-4">
              <BriefRecorder label="Record the details" onSaved={setRec} onTranscript={addTranscript} />
            </div>
            {rec?.key && (
              <>
                <input type="hidden" name="recordingKey" value={rec.key} />
                <input type="hidden" name="durationMs" value={rec.durationMs} />
                <input type="hidden" name="consentText" value={rec.consentText} />
              </>
            )}
            <textarea
              name="notes"
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              rows={5}
              placeholder={`Package around LKR 650,000. Colombo. CA or CIMA qualified, 10+ years in manufacturing.`}
              className={`${inputClass} leading-[1.75]`}
            />
          </div>
        </section>
      )}

      {isLead && (
        <>
          <section className={card}>
            <div className={head}>
              <h2 className="text-[13.5px] font-semibold">Assign to</h2>
              <p className="mt-0.5 text-[12.5px] text-ink-soft">
                They write and approve the JD.
              </p>
            </div>
            <div className="px-7 py-6">
              <PeoplePicker name="assignedTaIds" people={tas} onChange={setAssigned} />
            </div>
          </section>

          <section className={card}>
            <div className={head}>
              <h2 className="text-[13.5px] font-semibold">
                Brief <span className="ml-1.5 font-normal text-[12px] text-ink-faint">optional</span>
              </h2>
              <p className="mt-0.5 text-[12.5px] text-ink-soft">
                Whatever the client said. The JD draft is written from this and the TA’s own notes.
              </p>
            </div>
            <div className="flex flex-col gap-5 px-7 py-6">
              <BriefRecorder onSaved={setRec} onTranscript={addTranscript} />
              {rec?.key && (
                <>
                  <input type="hidden" name="recordingKey" value={rec.key} />
                  <input type="hidden" name="durationMs" value={rec.durationMs} />
                  <input type="hidden" name="consentText" value={rec.consentText} />
                </>
              )}
              <textarea
                name="notes"
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                rows={7}
                placeholder={`Package around LKR 650,000 with fuel and a vehicle allowance. Sri Lankan only. Colombo. Fairly urgent — about 3 weeks.`}
                className={`${inputClass} leading-[1.75]`}
              />
            </div>
          </section>
        </>
      )}

      <section className={card}>
        <label className={`flex cursor-pointer items-start gap-3 ${inline ? "px-6 py-4" : "px-7 py-5"}`}>
          <input type="checkbox" name="autoFollowUp" value="on" className="mt-0.5" />
          <span>
            <span className="block text-[13.5px] font-semibold">Automatic follow-up</span>
            <span className="mt-0.5 block text-[12.5px] leading-relaxed text-ink-soft">
              After you send a candidate the first follow-up, WhatsApp and email reminders go out every
              24 hours until the details are in or the reminders run out. Replies on WhatsApp are read into the record.
            </span>
          </span>
        </label>
      </section>

      {inline ? (
        <div className="flex flex-wrap items-center gap-3 pt-1">
          <input type="hidden" name="next" value="save" />
          <button
            type="submit"
            disabled={!ready || pending}
            className="flex items-center gap-2 rounded-full bg-brand px-5 py-2.5 text-[13px] font-medium text-white transition-opacity hover:opacity-90 disabled:opacity-35"
          >
            {pending && <Spinner />}
            {pending ? "Creating opening…" : "Create opening"}
          </button>
          <span className="text-[12.5px] text-ink-faint">
            {!ready
              ? isLead
                ? "Add a position and at least one TA"
                : "Add a position"
              : isLead
                ? "The TA is notified and writes the JD"
                : "You write the JD next"}
          </span>
          {error && (
            <p role="alert" className="w-full rounded-lg border border-danger/25 bg-danger-soft px-3.5 py-2.5 text-[12.5px] text-danger">
              {error}
            </p>
          )}
        </div>
      ) : (
      <div className="flex flex-wrap items-center gap-3 pt-1">
        <button
          name="next"
          value="save"
          disabled={!ready}
          className="rounded-full border border-rule-strong px-5 py-2.5 text-[13px] font-medium text-ink transition-colors hover:border-ink-faint disabled:opacity-35"
        >
          Save job
        </button>

        {isLead ? (
          <button
            name="next"
            value="again"
            disabled={!ready}
            className="rounded-full bg-brand px-5 py-2.5 text-[13px] font-medium text-white transition-opacity hover:opacity-90 disabled:opacity-35"
          >
            Save and create next opening
          </button>
        ) : (
          <button
            name="next"
            value="jd"
            disabled={!ready}
            className="rounded-full bg-brand px-6 py-2.5 text-[13px] font-medium text-white transition-opacity hover:opacity-90 disabled:opacity-35"
          >
            Next
          </button>
        )}

        <span className="text-[12.5px] text-ink-faint">
          {!ready
            ? isLead
              ? "Choose a client, a position and at least one TA"
              : "Choose a client and a position"
            : isLead
              ? "The TA is notified and writes the JD"
              : "Next: notes and the JD"}
        </span>
      </div>
      )}
    </form>
  );
}
