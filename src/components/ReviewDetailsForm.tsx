"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { saveReviewDetailsInline } from "@/app/actions";
import { inputClass } from "./form";
import { ActionNote, SubmitButton, Spinner, submitted, useInline } from "./Submit";
import type { ActionResult } from "@/lib/inlineResult";
import { isSystemNote } from "@/lib/pdf";

/**
 * What Director Review needs before it will take someone: current salary,
 * expected salary, notice period and a CV. The follow-up collects these, but a
 * TA who got them on a call, on WhatsApp or from LinkedIn had nowhere to type
 * them, so the move stayed refused. Entered here, they are saved on the
 * candidate record.
 *
 * 21 Sep: Save answers here instead of at the top of the page behind the
 * sheet, a CV can be uploaded from here, each salary carries its currency,
 * and custom detail lines (with + icon) can be added/updated for the prepared CV box.
 */
const CURRENCIES = ["LKR", "USD", "SAR", "AED", "QAR", "OMR", "KWD", "BHD", "MVR", "BDT", "INR", "SGD", "MYR"];

/** "LKR 250,000" → ["LKR", "250,000"]; a value without a known currency keeps the default. */
function split(value: string | null, fallback: string): [string, string] {
  const m = (value ?? "").trim().match(/^([A-Z]{3})\s+(.*)$/);
  return m && CURRENCIES.includes(m[1]) ? [m[1], m[2]] : [fallback, (value ?? "").trim()];
}

interface CustomField {
  id: string;
  label: string;
  value: string;
}

function parseInitialDetails(notes: string[] = []): CustomField[] {
  return notes
    .filter((n) => !isSystemNote(n))
    .map((n, i) => {
      const trimmed = n.replace(/^[->•*]\s*/, "").trim();
      const colonIdx = trimmed.indexOf(":");
      const dashIdx = trimmed.indexOf(" - ");
      if (colonIdx > 0 && (dashIdx === -1 || colonIdx < dashIdx)) {
        return {
          id: `f_${i}_${i}`,
          label: trimmed.slice(0, colonIdx).trim(),
          value: trimmed.slice(colonIdx + 1).trim(),
        };
      }
      if (dashIdx > 0) {
        return {
          id: `f_${i}_${i}`,
          label: trimmed.slice(0, dashIdx).trim(),
          value: trimmed.slice(dashIdx + 3).trim(),
        };
      }
      return {
        id: `f_${i}_${i}`,
        label: "Note",
        value: trimmed,
      };
    })
    .filter((f) => f.value.length > 0);
}

export function ReviewDetailsForm({
  applicationId,
  openingId,
  currentSalary,
  expectedSalary,
  noticePeriodDays,
  noticePeriod,
  currentDesignation = null,
  currentCompany = null,
  hasCv,
  notes = [],
  // None by default: a bare "12000" already on file, for a Gulf role, was
  // re-saved as "LKR 12000" by a plain Save (review of PR #2, 21 Sep).
  defaultCurrency = "",
}: {
  applicationId: string;
  openingId: string;
  currentSalary: string | null;
  expectedSalary: string | null;
  noticePeriodDays: number | null;
  noticePeriod?: string | null;
  /** As read from the CV until the TA corrects it on the call (9 Oct). */
  currentDesignation?: string | null;
  currentCompany?: string | null;
  hasCv: boolean;
  notes?: string[];
  defaultCurrency?: string;
}) {
  const router = useRouter();
  const save = useInline(saveReviewDetailsInline);
  const [cur, initialCurAmount] = split(currentSalary, defaultCurrency);
  const [exp, initialExpAmount] = split(expectedSalary, defaultCurrency);

  const [curCurrency, setCurCurrency] = useState(cur);
  const [curVal, setCurVal] = useState(initialCurAmount);
  const [expCurrency, setExpCurrency] = useState(exp);
  const [expVal, setExpVal] = useState(initialExpAmount);
  const [npVal, setNpVal] = useState(noticePeriod || (noticePeriodDays === 0 ? "Immediate" : noticePeriodDays != null ? `${noticePeriodDays} days` : ""));
  const [designation, setDesignation] = useState(currentDesignation ?? "");
  const [company, setCompany] = useState(currentCompany ?? "");

  const fileInput = useRef<HTMLInputElement | null>(null);
  const [upload, setUpload] = useState<{
    progress: number;
    phase: "uploading" | "processing" | "refreshing";
    fileName?: string;
  } | null>(null);
  const [uploaded, setUploaded] = useState<ActionResult | null>(null);
  const [cvOnFile, setCvOnFile] = useState(hasCv);
  const [customFields, setCustomFields] = useState<CustomField[]>(() => parseInitialDetails(notes));

  useEffect(() => {
    setCvOnFile(hasCv);
  }, [hasCv]);

  const [draftRestored, setDraftRestored] = useState(false);
  const draftCheckedRef = useRef(false);

  const initialNp = noticePeriod || (noticePeriodDays === 0 ? "Immediate" : noticePeriodDays != null ? `${noticePeriodDays} days` : "");
  const initialDesignation = currentDesignation ?? "";
  const initialCompany = currentCompany ?? "";

  // Check and restore draft on mount if differences exist
  useEffect(() => {
    if (draftCheckedRef.current) return;
    draftCheckedRef.current = true;
    try {
      const raw = localStorage.getItem(`candidate-details-draft:${applicationId}`);
      if (!raw) return;
      const draft = JSON.parse(raw);
      if (!draft || typeof draft !== "object") return;

      const serverCustom = parseInitialDetails(notes);
      const differs =
        (draft.curCurrency !== undefined && draft.curCurrency !== cur) ||
        (draft.curVal !== undefined && draft.curVal !== initialCurAmount) ||
        (draft.expCurrency !== undefined && draft.expCurrency !== exp) ||
        (draft.expVal !== undefined && draft.expVal !== initialExpAmount) ||
        (draft.npVal !== undefined && draft.npVal !== initialNp) ||
        (draft.designation !== undefined && draft.designation !== initialDesignation) ||
        (draft.company !== undefined && draft.company !== initialCompany) ||
        (Array.isArray(draft.customFields) && JSON.stringify(draft.customFields) !== JSON.stringify(serverCustom));

      if (differs) {
        if (typeof draft.curCurrency === "string") setCurCurrency(draft.curCurrency);
        if (typeof draft.curVal === "string") setCurVal(draft.curVal);
        if (typeof draft.expCurrency === "string") setExpCurrency(draft.expCurrency);
        if (typeof draft.expVal === "string") setExpVal(draft.expVal);
        if (typeof draft.npVal === "string") setNpVal(draft.npVal);
        if (typeof draft.designation === "string") setDesignation(draft.designation);
        if (typeof draft.company === "string") setCompany(draft.company);
        if (Array.isArray(draft.customFields)) setCustomFields(draft.customFields);
        setDraftRestored(true);
      } else {
        localStorage.removeItem(`candidate-details-draft:${applicationId}`);
      }
    } catch {
      // Ignore storage errors
    }
  }, [applicationId, cur, initialCurAmount, exp, initialExpAmount, initialNp, initialDesignation, initialCompany, notes]);

  // Debounced auto-save when user types
  useEffect(() => {
    if (!draftCheckedRef.current) return;

    const timer = setTimeout(() => {
      try {
        const serverCustom = parseInitialDetails(notes);
        const differs =
          curCurrency !== cur ||
          curVal !== initialCurAmount ||
          expCurrency !== exp ||
          expVal !== initialExpAmount ||
          npVal !== initialNp ||
          designation !== initialDesignation ||
          company !== initialCompany ||
          JSON.stringify(customFields) !== JSON.stringify(serverCustom);

        if (differs) {
          const draft = {
            curCurrency,
            curVal,
            expCurrency,
            expVal,
            npVal,
            designation,
            company,
            customFields,
            updatedAt: Date.now(),
          };
          localStorage.setItem(`candidate-details-draft:${applicationId}`, JSON.stringify(draft));
        } else {
          localStorage.removeItem(`candidate-details-draft:${applicationId}`);
          setDraftRestored(false);
        }
      } catch {
        // Ignore quota/storage errors
      }
    }, 300);

    return () => clearTimeout(timer);
  }, [
    curCurrency,
    curVal,
    expCurrency,
    expVal,
    npVal,
    designation,
    company,
    customFields,
    applicationId,
    cur,
    initialCurAmount,
    exp,
    initialExpAmount,
    initialNp,
    initialDesignation,
    initialCompany,
    notes,
  ]);

  const discardDraft = () => {
    try {
      localStorage.removeItem(`candidate-details-draft:${applicationId}`);
    } catch {}
    setCurCurrency(cur);
    setCurVal(initialCurAmount);
    setExpCurrency(exp);
    setExpVal(initialExpAmount);
    setNpVal(initialNp);
    setDesignation(initialDesignation);
    setCompany(initialCompany);
    setCustomFields(parseInitialDetails(notes));
    setDraftRestored(false);
  };

  useEffect(() => {
    if (draftRestored) return;
    const [c, ca] = split(currentSalary, defaultCurrency);
    setCurCurrency(c);
    setCurVal(ca);
  }, [currentSalary, defaultCurrency, draftRestored]);

  useEffect(() => {
    if (draftRestored) return;
    const [e, ea] = split(expectedSalary, defaultCurrency);
    setExpCurrency(e);
    setExpVal(ea);
  }, [expectedSalary, defaultCurrency, draftRestored]);

  useEffect(() => {
    if (draftRestored) return;
    setNpVal(noticePeriod || (noticePeriodDays === 0 ? "Immediate" : noticePeriodDays != null ? `${noticePeriodDays} days` : ""));
  }, [noticePeriod, noticePeriodDays, draftRestored]);

  useEffect(() => {
    if (draftRestored) return;
    setDesignation(currentDesignation ?? "");
  }, [currentDesignation, draftRestored]);

  useEffect(() => {
    if (draftRestored) return;
    setCompany(currentCompany ?? "");
  }, [currentCompany, draftRestored]);

  useEffect(() => {
    if (draftRestored) return;
    setCustomFields(parseInitialDetails(notes));
  }, [notes, draftRestored]);

  useEffect(() => {
    if (save.result?.ok) {
      try {
        localStorage.removeItem(`candidate-details-draft:${applicationId}`);
      } catch {}
      setDraftRestored(false);
      router.refresh();
    }
  }, [save.result, router, applicationId]);

  const hasCvNow = Boolean(hasCv || cvOnFile);
  const hasNotice = noticePeriodDays != null || Boolean(noticePeriod?.trim()) || Boolean(npVal.trim());

  // Current salary is not mandatory for Director review.
  const missing = [
    !hasCvNow && "CV",
    !expectedSalary?.trim() && !expVal.trim() && "expected salary",
    !hasNotice && "notice period",
  ].filter(Boolean) as string[];

  /** Sent with XHR, not fetch, so the bar can say how far it has got. */
  const send = (file: File) => {
    const body = new FormData();
    body.set("applicationId", applicationId);
    body.set("openingId", openingId);
    body.set("file", file);
    const xhr = new XMLHttpRequest();
    xhr.open("POST", "/api/cv/upload");
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) {
        const percent = Math.round((e.loaded / e.total) * 100);
        setUpload({
          progress: percent,
          phase: percent >= 100 ? "processing" : "uploading",
          fileName: file.name,
        });
      }
    };
    xhr.onload = () => {
      let r: { ok: boolean; message: string } = { ok: false, message: "The upload did not answer. Try again." };
      try {
        r = JSON.parse(xhr.responseText);
      } catch {
        /* keeps the message above */
      }
      if (r.ok) {
        setUpload({ progress: 100, phase: "refreshing", fileName: file.name });
        setUploaded({ ok: true, message: `${r.message} Updating view…`, tone: "ok", at: Date.now() });
        setCvOnFile(true);
        router.refresh();
        setTimeout(() => {
          window.location.reload();
        }, 500);
      } else {
        setUpload(null);
        setUploaded({ ok: false, message: r.message, tone: "error", at: Date.now() });
      }
    };
    xhr.onerror = () => {
      setUpload(null);
      setUploaded({ ok: false, message: "The upload was interrupted. Check the connection and try again.", tone: "error", at: Date.now() });
    };
    setUploaded(null);
    setUpload({ progress: 0, phase: "uploading", fileName: file.name });
    xhr.send(body);
  };

  const addField = () => {
    setCustomFields((prev) => [
      ...prev,
      { id: `cf_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`, label: "", value: "" },
    ]);
  };

  const updateField = (idx: number, key: "label" | "value", val: string) => {
    setCustomFields((prev) => {
      const next = [...prev];
      next[idx] = { ...next[idx], [key]: val };
      return next;
    });
  };

  const removeField = (idx: number) => {
    setCustomFields((prev) => prev.filter((_, i) => i !== idx));
  };

  const money = (
    name: string,
    currencyVal: string,
    onCurrencyChange: (v: string) => void,
    amountVal: string,
    onAmountChange: (v: string) => void,
    placeholder: string,
    label: string
  ) => (
    <label>
      <span className="mb-1 block text-[11.5px] text-ink-soft">{label}</span>
      <div className="flex">
        <select
          name={`${name}Currency`}
          value={currencyVal}
          onChange={(e) => onCurrencyChange(e.target.value)}
          aria-label={`${label} currency`}
          className="rounded-l-lg border border-r-0 border-rule bg-paper px-2 text-[12.5px] outline-none focus:border-brand"
        >
          <option value="">Currency</option>
          {CURRENCIES.map((c) => (
            <option key={c}>{c}</option>
          ))}
        </select>
        <input
          name={name}
          value={amountVal}
          onChange={(e) => onAmountChange(e.target.value)}
          placeholder={placeholder}
          className={`${inputClass} rounded-l-none`}
        />
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
      <input type="hidden" name="customDetailsSubmitted" value="1" />
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="text-[13px] font-semibold">Details for Director review</h2>
        <span className={missing.length ? "text-warn" : "text-brand"}>
          {missing.length ? `Still needed: ${missing.join(", ")}` : "All details in — ready for Director review"}
        </span>
      </div>
      {draftRestored && (
        <div className="mt-2.5 flex items-center justify-between gap-2 rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-1.5 text-[11.5px] text-amber-800 dark:text-amber-200">
          <div className="flex items-center gap-1.5">
            <span className="inline-block h-2 w-2 rounded-full bg-amber-500 animate-pulse" />
            <span>Draft restored from unsubmitted changes</span>
          </div>
          <button
            type="button"
            onClick={discardDraft}
            className="font-medium underline hover:text-amber-950 dark:hover:text-amber-100 cursor-pointer"
          >
            Discard draft
          </button>
        </div>
      )}
      <div className="mt-3 grid grid-cols-[minmax(0,1fr)] gap-3 sm:grid-cols-3">
        {money("currentSalary", curCurrency, setCurCurrency, curVal, setCurVal, "e.g. 250,000 / 250k / Not disclosed", "Current salary (optional)")}
        {money("expectedSalary", expCurrency, setExpCurrency, expVal, setExpVal, "e.g. 300,000 / 300k / Negotiable / Open to discuss", "Expected salary")}
        <label>
          <span className="mb-1 block text-[11.5px] text-ink-soft">Notice period</span>
          <input
            name="noticePeriod"
            type="text"
            value={npVal}
            onChange={(e) => setNpVal(e.target.value)}
            placeholder="e.g. 30 days, 5 days, Immediate, 2 months, Not disclosed"
            className={inputClass}
          />
        </label>
      </div>
      {/* Filled from the CV; corrected here when the call says otherwise (9 Oct). */}
      <div className="mt-3 grid grid-cols-[minmax(0,1fr)] gap-3 sm:grid-cols-2">
        <label>
          <span className="mb-1 block text-[11.5px] text-ink-soft">Current designation</span>
          <input
            name="currentDesignation"
            value={designation}
            onChange={(e) => setDesignation(e.target.value)}
            placeholder={currentDesignation ? "e.g. Senior Accountant" : "Not on the CV — ask on the call"}
            className={inputClass}
          />
        </label>
        <label>
          <span className="mb-1 block text-[11.5px] text-ink-soft">Current company</span>
          <input
            name="currentCompany"
            value={company}
            onChange={(e) => setCompany(e.target.value)}
            placeholder={currentCompany ? "e.g. Hayleys PLC" : "Not on the CV — ask on the call"}
            className={inputClass}
          />
        </label>
      </div>

      {/* Additional custom detail lines for Prepared CV */}
      <div className="mt-4 border-t border-rule/70 pt-3">
        <div className="flex items-center justify-between gap-2">
          <h3 className="text-[12.5px] font-semibold text-ink">Additional details / notes</h3>
          <button
            type="button"
            onClick={addField}
            className="inline-flex items-center gap-1 rounded-full border border-brand/30 bg-paper px-2.5 py-1 text-[11.5px] font-medium text-brand transition-colors hover:bg-brand-soft"
          >
            <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M12 4v16m8-8H4" />
            </svg>
            Add detail
          </button>
        </div>

        {customFields.length > 0 && (
          <div className="mt-3 space-y-2.5">
            {customFields.map((f, idx) => (
              <div key={f.id} className="flex items-end gap-2.5">
                <label className="w-1/3 min-w-[120px]">
                  <span className="mb-1 block text-[11.5px] text-ink-soft">Label</span>
                  <input
                    name="customLabel"
                    value={f.label}
                    onChange={(e) => updateField(idx, "label", e.target.value)}
                    placeholder="e.g. Location, Bonus"
                    className={inputClass}
                  />
                </label>
                <label className="flex-1">
                  <span className="mb-1 block text-[11.5px] text-ink-soft">Details</span>
                  <input
                    name="customValue"
                    value={f.value}
                    onChange={(e) => updateField(idx, "value", e.target.value)}
                    placeholder="e.g. Sri Lanka, 15% annual bonus"
                    className={inputClass}
                  />
                </label>
                <button
                  type="button"
                  onClick={() => removeField(idx)}
                  title="Remove this detail"
                  className="mb-[1px] flex h-[34px] w-[34px] shrink-0 items-center justify-center rounded-lg border border-rule text-ink-faint transition-colors hover:bg-tag hover:text-red-600 dark:text-red-400"
                >
                  <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                  </svg>
                </button>
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="mt-4 flex flex-wrap items-center justify-between gap-3 border-t border-rule/70 pt-3">
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
            className="inline-flex items-center gap-2 rounded-full border border-brand-line px-4 py-1.5 text-[12.5px] font-medium text-brand transition-colors hover:bg-brand-soft disabled:opacity-75"
          >
            {upload && <Spinner tone="dark" />}
            {upload
              ? upload.phase === "refreshing"
                ? "Refreshing view…"
                : upload.phase === "processing"
                ? "Extracting references…"
                : `Uploading… ${upload.progress}%`
              : hasCvNow
              ? "Replace CV"
              : "Upload CV"}
          </button>
          <span className="text-[11.5px] text-ink-faint">
            {hasCvNow ? "A CV is on file." : "PDF or Word, up to 10 MB — or drop the file on this card."}
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

      {/* Progress & extraction feedback banner */}
      {upload && (
        <div className="mt-3 flex items-center gap-3 rounded-lg border border-brand/30 bg-brand-soft/50 px-4 py-2.5 text-[12.5px]">
          <Spinner tone="dark" />
          <div className="min-w-0 flex-1">
            <div className="flex items-center justify-between gap-2">
              <span className="font-semibold text-ink">
                {upload.phase === "refreshing"
                  ? "CV attached! Updating view and references…"
                  : upload.phase === "processing"
                  ? "Extracting references from CV & updating database…"
                  : `Uploading ${upload.fileName ?? "CV"} (${upload.progress}%)…`}
              </span>
              <span className="text-[11.5px] font-semibold text-brand">
                {upload.phase === "refreshing" ? "100%" : upload.phase === "processing" ? "Processing" : `${upload.progress}%`}
              </span>
            </div>
            <div className="mt-1.5 h-1.5 w-full overflow-hidden rounded-full bg-brand/15">
              <div
                className="h-full rounded-full bg-brand transition-all duration-300"
                style={{
                  width: upload.phase === "refreshing" ? "100%" : upload.phase === "processing" ? "88%" : `${Math.max(8, upload.progress)}%`,
                }}
              />
            </div>
          </div>
        </div>
      )}

      <ActionNote result={uploaded} className="mt-3" />
      <ActionNote result={save.result} className="mt-3" />
    </form>
  );
}
