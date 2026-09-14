"use client";

import { useState } from "react";
import { useFormStatus } from "react-dom";
import { addClient } from "@/app/actions";
import { inputClass } from "./form";
import { CloseIcon } from "./icons";

const INDUSTRIES = [
  "Apparel", "FMCG", "Manufacturing", "Banking & Finance", "Power & Energy",
  "Shipping & Freight", "Logistics", "Retail", "Hospitality", "Healthcare",
  "Construction", "Telecom", "Plantation", "IT Services", "Other",
];

function Save() {
  const { pending } = useFormStatus();
  return (
    <button
      disabled={pending}
      className="rounded-full bg-brand px-5 py-2.5 text-[13px] font-medium text-white transition-opacity hover:opacity-90 disabled:opacity-50"
    >
      {pending ? "Adding…" : "Add client"}
    </button>
  );
}

/**
 * Adding a client — spec §4.1.
 *
 * Closed until asked for. A form sitting open above the list is the first thing
 * the eye lands on, and it is the thing a TA does least: they read this page
 * every day and add to it once a month.
 */
export function AddClient() {
  const [open, setOpen] = useState(false);

  if (!open) {
    return (
      <button
        onClick={() => setOpen(true)}
        className="flex items-center gap-2 rounded-full border border-brand-line px-4 py-2 text-[13px] font-medium text-brand transition-colors hover:bg-brand-soft"
      >
        <span className="text-[15px] leading-none">+</span>
        Add a client
      </button>
    );
  }

  return (
    <form
      action={addClient}
      onSubmit={() => setOpen(false)}
      className="mb-7 rounded-2xl border border-rule bg-surface p-6 shadow-[0_1px_2px_rgba(23,28,24,0.04)]"
    >
      <div className="mb-5 flex items-center justify-between">
        <h2 className="text-[14px] font-semibold">New client</h2>
        <button
          type="button"
          onClick={() => setOpen(false)}
          aria-label="Close"
          className="grid h-7 w-7 place-items-center rounded-full text-ink-faint transition-colors hover:bg-tag hover:text-ink"
        >
          <CloseIcon />
        </button>
      </div>

      <div className="grid gap-5 sm:grid-cols-2">
        <label className="sm:col-span-2">
          <span className="mb-1.5 block text-[12px] text-ink-soft">Company name</span>
          <input
            name="name"
            required
            autoFocus
            placeholder="Delmo Holdings"
            className={`${inputClass} text-[15px]`}
          />
        </label>

        <label>
          <span className="mb-1.5 block text-[12px] text-ink-soft">Industry</span>
          <div className="relative">
            <select name="industry" defaultValue="" className={`${inputClass} cursor-pointer appearance-none pr-10`}>
              <option value="">Not set</option>
              {INDUSTRIES.map((i) => (
                <option key={i} value={i}>{i}</option>
              ))}
            </select>
            <svg width={14} height={14} viewBox="0 0 16 16" aria-hidden="true" className="pointer-events-none absolute right-3.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-ink-faint">
              <path d="M4 6.5L8 10.5L12 6.5" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </div>
        </label>

        <label>
          <span className="mb-1.5 block text-[12px] text-ink-soft">Main contact</span>
          <input name="contactName" placeholder="Ayesha Perera" className={inputClass} />
        </label>

        <label>
          <span className="mb-1.5 block text-[12px] text-ink-soft">Their title</span>
          <input name="contactTitle" placeholder="Head of HR" className={inputClass} />
        </label>

        <label>
          <span className="mb-1.5 block text-[12px] text-ink-soft">Their email</span>
          <input
            name="contactEmail"
            type="email"
            placeholder="ayesha@delmo.lk"
            className={inputClass}
          />
        </label>
      </div>

      <div className="mt-6 flex items-center gap-3">
        <Save />
        <button
          type="button"
          onClick={() => setOpen(false)}
          className="px-2 text-[13px] text-ink-soft transition-colors hover:text-ink"
        >
          Cancel
        </button>
        <span className="ml-auto text-[11.5px] text-ink-faint">
          Terms and the signed ESA are added once the client is on the list.
        </span>
      </div>
    </form>
  );
}
