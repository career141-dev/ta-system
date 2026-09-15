"use client";

import { useState } from "react";
import { BriefRecorder } from "./BriefRecorder";
import { createOpeningStep1 } from "@/app/actions";
import { ClientPicker, PeoplePicker, inputClass } from "./form";
import type { Client, User } from "@/data/types";

/**
 * Screen one. Short for everyone, and shorter still for a TA.
 *
 * A lead gets the brief here because they have no screen two — the JD is the
 * TA's to write. A TA gets client and position only, then moves on to it.
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
}: {
  clients: Client[];
  tas: User[];
  isLead: boolean;
  initialClientId?: string | null;
}) {
  const [rec, setRec] = useState<{ key: string; durationMs: number; consentText: string } | null>(
    null,
  );
  const [title, setTitle] = useState("");
  const [country, setCountry] = useState("Sri Lanka");
  const [client, setClient] = useState<string | null>(initialClientId ?? null);
  const [assigned, setAssigned] = useState<string[]>([]);

  const ready = Boolean(title.trim() && client && (!isLead || assigned.length));

  const selectClass = `${inputClass} cursor-pointer appearance-none pr-10`;
  const card =
    "overflow-hidden rounded-2xl border border-rule bg-surface shadow-[0_1px_2px_rgba(23,28,24,0.04)]";
  const head = "border-b border-rule px-7 py-4";

  return (
    <form action={createOpeningStep1} className="flex flex-col gap-5">
      <section className={card}>
        <div className={head}>
          <h2 className="text-[13.5px] font-semibold">Client</h2>
        </div>
        <div className="px-7 py-6">
          <ClientPicker name="clientId" clients={clients} initial={client} onChange={setClient} />
        </div>
      </section>

      <section className={card}>
        <div className={head}>
          <h2 className="text-[13.5px] font-semibold">Position</h2>
        </div>
        <div className="px-7 py-6">
          <input
            name="title"
            required
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
                Whatever the client said. The TA writes the JD from this.
              </p>
            </div>
            <div className="flex flex-col gap-5 px-7 py-6">
              <BriefRecorder onSaved={setRec} />
              {rec && (
                <>
                  <input type="hidden" name="recordingKey" value={rec.key} />
                  <input type="hidden" name="durationMs" value={rec.durationMs} />
                  <input type="hidden" name="consentText" value={rec.consentText} />
                </>
              )}
              <textarea
                name="notes"
                rows={7}
                placeholder={`Package around LKR 650,000 with fuel and a vehicle allowance. Sri Lankan only. Colombo. Fairly urgent — about 3 weeks.`}
                className={`${inputClass} leading-[1.75]`}
              />
            </div>
          </section>
        </>
      )}

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
    </form>
  );
}
