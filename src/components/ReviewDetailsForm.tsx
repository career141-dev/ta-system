"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { saveReviewDetailsInline } from "@/app/actions";
import { inputClass } from "./form";
import { ActionNote, SubmitButton, Spinner, submitted, useInline } from "./Submit";
import type { ActionResult } from "@/lib/inlineResult";

/**
 * What Director Review needs before it will take someone: current salary,
 * expected salary, notice period and a CV. The follow-up collects these, but a
 * TA who got them on a call, on WhatsApp or from LinkedIn had nowhere to type
 * them, so the move stayed refused. Entered here, they are saved on the
 * candidate record.
 *
 * 21 Sep: Save answers here instead of at the top of the page behind the
 * sheet, a CV can be uploaded from here (it could not — headhunted people
 * stayed in Follow-up for good), and each salary carries its currency, so a
 * bare "25,000" is no longer saved as a number nobody can read.
 */
const CURRENCIES = ["LKR", "USD", "SAR", "AED", "QAR", "OMR", "KWD", "BHD", "MVR", "BDT", "INR", "SGD", "MYR"];

/** "LKR 250,000" → ["LKR", "250,000"]; a value without a known currency keeps the default. */
function split(value: string | null, fallback: string): [string, string] {
  const m = (value ?? "").trim().match(/^([A-Z]{3})\s+(.*)$/);
  return m && CURRENCIES.includes(m[1]) ? [m[1], m[2]] : [fallback, (value ?? "").trim()];
}

export function ReviewDetailsForm({
  applicationId,
  openingId,
  currentSalary,
  expectedSalary,
  noticePeriodDays,
  hasCv,
  defaultCurrency = "LKR",
}: {
  applicationId: string;
  openingId: string;
  currentSalary: string | null;
  expectedSalary: string | null;
  noticePeriodDays: number | null;
  hasCv: boolean;
  defaultCurrency?: string;
}) {
  const router = useRouter();
  const save = useInline(saveReviewDetailsInline);
  const [cur, curAmount] = split(currentSalary, defaultCurrency);
  const [exp, expAmount] = split(expectedSalary, defaultCurrency);

  const fileInput = useRef<HTMLInputElement | null>(null);
  const [upload, setUpload] = useState<{ progress: number } | null>(null);
  const [uploaded, setUploaded] = useState<ActionResult | null>(null);
  const [cvOnFile, setCvOnFile] = useState(hasCv);

  const missing = [
    !cvOnFile && "CV",
    !currentSalary?.trim() && "current salary",
    !expectedSalary?.trim() && "expected salary",
    noticePeriodDays == null && "notice period",
  ].filter(Boolean) as string[];

  /** Sent with XHR, not fetch, so the bar can say how far it has got. */
  const send = (file: File) => {
    const body = new FormData();
    body.set("applicationId", applicationId);
    body.set("openingId", openingId);
    body.set("file", file);
    const xhr = new XMLHttpRequest();
    xhr.open("POST", "/api/cv/upload");
    xhr.upload.onprogress = (e) => e.lengthComputable && setUpload({ progress: Math.round((e.loaded / e.total) * 100) });
    xhr.onload = () => {
      let r: { ok: boolean; message: string } = { ok: false, message: "The upload did not answer. Try again." };
      try {
        r = JSON.parse(xhr.responseText);
      } catch {
        /* keeps the message above */
      }
      setUpload(null);
      setUploaded({ ok: r.ok, message: r.message, tone: r.ok ? "ok" : "error", at: Date.now() });
      if (r.ok) {
        setCvOnFile(true);
        router.refresh();
      }
    };
    xhr.onerror = () => {
      setUpload(null);
      setUploaded({ ok: false, message: "The upload was interrupted. Check the connection and try again.", tone: "error", at: Date.now() });
    };
    setUploaded(null);
    setUpload({ progress: 0 });
    xhr.send(body);
  };

  const money = (name: string, currency: string, amount: string, placeholder: string, label: string) => (
    <label>
      <span className="mb-1 block text-[11.5px] text-ink-soft">{label}</span>
      <div className="flex">
        <select
          name={`${name}Currency`}
          defaultValue={currency}
          aria-label={`${label} currency`}
          className="rounded-l-lg border border-r-0 border-rule bg-paper px-2 text-[12.5px] outline-none focus:border-brand"
        >
          {CURRENCIES.map((c) => (
            <option key={c}>{c}</option>
          ))}
        </select>
        <input name={name} defaultValue={amount} placeholder={placeholder} className={`${inputClass} rounded-l-none`} />
      </div>
    </label>
  );

  return (
    <form
      onSubmit={(e) => save.run(submitted(e).formData)}
      onDragOver={(e) => {
        if (e.dataTransfer.types.includes("Files")) e.preventDefault();
      }}
      onDrop={(e) => {
        const file = e.dataTransfer.files?.[0];
        if (!file) return;
        e.preventDefault();
        send(file);
      }}
      className="mt-3 rounded-xl border border-rule bg-surface px-5 py-4 text-[12.5px]"
    >
      <input type="hidden" name="applicationId" value={applicationId} />
      <input type="hidden" name="openingId" value={openingId} />
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="text-[13px] font-semibold">Details for Director review</h2>
        <span className={missing.length ? "text-warn" : "text-brand"}>
          {missing.length ? `Still needed: ${missing.join(", ")}` : "All details in — ready for Director review"}
        </span>
      </div>
      <div className="mt-3 grid gap-3 sm:grid-cols-3">
        {money("currentSalary", cur, curAmount, "250,000 a month", "Current salary")}
        {money("expectedSalary", exp, expAmount, "300,000 a month", "Expected salary")}
        <label>
          <span className="mb-1 block text-[11.5px] text-ink-soft">Notice period (days)</span>
          <input name="noticePeriodDays" type="number" min={0} step={1} defaultValue={noticePeriodDays ?? ""} placeholder="30 (0 if immediate)" className={inputClass} />
        </label>
      </div>
      <div className="mt-3 flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-2.5">
          <input
            ref={fileInput}
            type="file"
            accept=".pdf,.doc,.docx,application/pdf,application/msword,application/vnd.openxmlformats-officedocument.wordprocessingml.document"
            hidden
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) send(file);
              e.target.value = "";
            }}
          />
          <button
            type="button"
            disabled={upload !== null}
            aria-busy={upload !== null}
            onClick={() => fileInput.current?.click()}
            className="inline-flex items-center gap-2 rounded-full border border-brand-line px-4 py-1.5 text-[12.5px] font-medium text-brand transition-colors hover:bg-brand-soft disabled:opacity-60"
          >
            {upload && <Spinner tone="dark" />}
            {upload ? `Uploading… ${upload.progress}%` : cvOnFile ? "Replace CV" : "Upload CV"}
          </button>
          <span className="text-[11.5px] text-ink-faint">
            {cvOnFile ? "A CV is on file." : "PDF or Word, up to 10 MB — or drop the file on this card."}
          </span>
        </div>
        <SubmitButton
          busy={save.pending}
          locked={save.pending}
          pendingLabel="Saving…"
          className="rounded-full bg-brand px-4 py-1.5 text-[12.5px] font-medium text-white transition-opacity hover:opacity-90 disabled:opacity-60"
        >
          Save details
        </SubmitButton>
      </div>
      <ActionNote result={uploaded} className="mt-3" />
      <ActionNote result={save.result} className="mt-3" />
    </form>
  );
}
