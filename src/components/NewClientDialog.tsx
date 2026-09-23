"use client";

import { INDUSTRIES } from "../../convex/lib/jobRequirements";
import { useEffect, useRef, useState, useTransition } from "react";
import { createPortal } from "react-dom";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { createClientInline } from "@/app/actions";
import { CaptureForm } from "./CaptureForm";
import { inputClass } from "./form";
import { CloseIcon } from "./icons";
import type { User } from "@/data/types";

// The one industry list (convex/lib/jobRequirements), shared with the client
// editor and the job details, so a client's industry means the same everywhere.
export { INDUSTRIES } from "../../convex/lib/jobRequirements";

export type NewClient = { id: string; name: string; industry: string };
type Created = { openingId: string; title: string };
type Step = "client" | "opening" | "client_done" | "opening_done";

const chev = (
  <svg width={14} height={14} viewBox="0 0 16 16" aria-hidden="true" className="pointer-events-none absolute right-3.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-ink-faint">
    <path d="M4 6.5L8 10.5L12 6.5" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);

/**
 * A new client, and — straight after — their first opening, in one pop-up.
 *
 * It used to be a form that posted, reloaded the Clients page, then redirected
 * to /openings/new: a pause with nothing happening, and then the page jumped.
 * Here the client is saved in place, its details fold into a one-line summary,
 * and the opening form opens underneath it in the same window. Nothing
 * navigates until the TA picks where to go.
 *
 * `withOpening` false is the short version, for the New opening page: the
 * client is saved and handed back to the form that asked for it.
 */
export function NewClientDialog({
  onClose,
  withOpening,
  tas = [],
  isLead = false,
  onClientCreated,
}: {
  onClose: () => void;
  withOpening: boolean;
  tas?: User[];
  isLead?: boolean;
  onClientCreated?: (client: NewClient) => void;
}) {
  const router = useRouter();
  const [step, setStep] = useState<Step>("client");
  const [client, setClient] = useState<NewClient | null>(null);
  const [created, setCreated] = useState<Created | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const [shown, setShown] = useState(false);
  // Remounts the opening form for "another opening for this client".
  const [round, setRound] = useState(0);
  const body = useRef<HTMLDivElement>(null);

  // Enter animation, Escape to close, and the page behind held still.
  useEffect(() => {
    const raf = requestAnimationFrame(() => setShown(true));
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !pending) onClose();
    };
    window.addEventListener("keydown", onKey);
    const overflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("keydown", onKey);
      document.body.style.overflow = overflow;
    };
  }, [onClose, pending]);

  // Each step starts at its top: the client's details fold into one line and
  // the next part opens directly beneath it, so the top is where to look.
  useEffect(() => {
    body.current?.scrollTo({ top: 0, behavior: "smooth" });
  }, [step, round]);

  const saveClient = (form: HTMLFormElement, next: "opening" | "done") => {
    if (!form.reportValidity()) return;
    setError(null);
    const data = new FormData(form);
    startTransition(async () => {
      const r = await createClientInline(data);
      if (!r.ok) {
        setError(r.error);
        return;
      }
      setClient(r.client);
      onClientCreated?.(r.client);
      router.refresh();
      // The short version hands the client back and is finished.
      if (!withOpening) return onClose();
      setStep(next === "opening" ? "opening" : "client_done");
    });
  };

  const title =
    step === "opening_done" ? "Opening created" : step === "opening" ? "New client and opening" : "New client";

  // Rendered on <body>: opened from the New opening page it would otherwise sit
  // inside that page's <form>, and a form inside a form is not a form.
  if (typeof document === "undefined") return null;
  return createPortal(
    <div className="fixed inset-0 z-50 flex items-start justify-center px-4 py-6 sm:py-10" role="dialog" aria-modal="true" aria-label={title}>
      <div
        aria-hidden="true"
        className={`fixed inset-0 bg-[#0b1a12]/45 transition-opacity duration-200 ${shown ? "opacity-100" : "opacity-0"}`}
      />

      <div
        className={`relative flex max-h-full w-full max-w-[720px] flex-col overflow-hidden rounded-2xl border border-rule bg-paper shadow-[0_24px_60px_rgba(11,26,18,.22)] transition-all duration-200 motion-reduce:transition-none ${
          shown ? "translate-y-0 opacity-100" : "translate-y-3 opacity-0"
        }`}
      >
        <header className="flex shrink-0 items-center justify-between gap-3 border-b border-rule bg-surface px-6 py-4">
          <div className="min-w-0">
            <h2 className="text-[15px] font-semibold tracking-tight">{title}</h2>
            {withOpening && (step === "client" || step === "opening") && (
              <ol className="mt-1.5 flex items-center gap-2 text-[11.5px]">
                <StepDot n={1} label="Client" state={step === "client" ? "now" : "done"} />
                <span className="h-px w-5 bg-rule" />
                <StepDot n={2} label="Opening" state={step === "opening" ? "now" : "next"} />
              </ol>
            )}
          </div>
          <button
            type="button"
            onClick={onClose}
            disabled={pending}
            aria-label="Close"
            className="grid h-8 w-8 shrink-0 place-items-center rounded-full text-ink-faint transition-colors hover:bg-tag hover:text-ink disabled:opacity-40"
          >
            <CloseIcon />
          </button>
        </header>

        <div ref={body} className="min-h-0 flex-1 overflow-y-auto overscroll-contain p-6">
          {/* ── Step 1: the client ─────────────────────────────────────────── */}
          {step === "client" ? (
            <form
              onSubmit={(e) => {
                e.preventDefault();
                saveClient(e.currentTarget, withOpening ? "opening" : "done");
              }}
              className="rounded-2xl border border-rule bg-surface p-6"
            >
              <div className="grid gap-5 sm:grid-cols-2">
                <label className="sm:col-span-2">
                  <span className="mb-1.5 block text-[12px] text-ink-soft">Company name</span>
                  <input name="name" required autoFocus placeholder="Delmo Holdings" className={`${inputClass} text-[15px]`} />
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
                    {chev}
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
                  <input name="contactEmail" type="email" placeholder="ayesha@delmo.lk" className={inputClass} />
                </label>
              </div>

              {error && (
                <p role="alert" className="mt-5 rounded-lg border border-danger/25 bg-danger/5 px-3.5 py-2.5 text-[12.5px] text-danger">
                  {error}
                </p>
              )}

              <div className="mt-6 flex flex-wrap items-center gap-2.5">
                {withOpening ? (
                  <>
                    <button
                      type="submit"
                      disabled={pending}
                      className="flex items-center gap-2 rounded-full bg-brand px-5 py-2.5 text-[13px] font-medium text-white transition-opacity hover:opacity-90 disabled:opacity-60"
                    >
                      {pending && <Spinner />}
                      {pending ? "Saving client…" : "Save and create opening"}
                      {!pending && <span aria-hidden="true">→</span>}
                    </button>
                    <button
                      type="button"
                      disabled={pending}
                      onClick={(e) => saveClient(e.currentTarget.form!, "done")}
                      className="rounded-full border border-brand-line px-4 py-2.5 text-[13px] font-medium text-brand transition-colors hover:bg-brand-soft disabled:opacity-50"
                    >
                      Save client only
                    </button>
                  </>
                ) : (
                  <button
                    type="submit"
                    disabled={pending}
                    className="flex items-center gap-2 rounded-full bg-brand px-5 py-2.5 text-[13px] font-medium text-white transition-opacity hover:opacity-90 disabled:opacity-60"
                  >
                    {pending && <Spinner />}
                    {pending ? "Saving…" : "Save and use this client"}
                  </button>
                )}
                <button type="button" onClick={onClose} disabled={pending} className="px-2 text-[13px] text-ink-soft transition-colors hover:text-ink disabled:opacity-40">
                  Cancel
                </button>
                <span className="ml-auto text-[11.5px] text-ink-faint">Terms and the signed ESA are added on the client’s card.</span>
              </div>
            </form>
          ) : (
            client && <ClientSummary client={client} />
          )}

          {/* ── Client saved, no opening asked for ───────────────────────── */}
          {step === "client_done" && client && (
            <div className="mt-5 flex flex-wrap items-center gap-2.5">
              {withOpening && (
                <button
                  type="button"
                  onClick={() => setStep("opening")}
                  className="rounded-full bg-brand px-5 py-2.5 text-[13px] font-medium text-white transition-opacity hover:opacity-90"
                >
                  Create an opening for {client.name}
                </button>
              )}
              <button type="button" onClick={onClose} className="rounded-full border border-rule px-4 py-2.5 text-[13px] font-medium text-ink transition-colors hover:border-ink-faint">
                Done
              </button>
            </div>
          )}

          {/* ── Step 2: the opening, opening out below the client ─────────── */}
          <div
            className={`grid transition-[grid-template-rows,opacity] duration-300 ease-out motion-reduce:transition-none ${
              step === "opening" ? "mt-5 grid-rows-[1fr] opacity-100" : "grid-rows-[0fr] opacity-0"
            }`}
          >
            <div className="min-h-0 overflow-hidden">
              {client && step === "opening" && (
                <CaptureForm
                  key={round}
                  clients={[client]}
                  tas={tas}
                  isLead={isLead}
                  lockedClient={client}
                  onCreated={(r) => {
                    setCreated({ openingId: r.openingId, title: r.title });
                    setStep("opening_done");
                  }}
                />
              )}
            </div>
          </div>

          {/* ── Done ─────────────────────────────────────────────────────── */}
          {step === "opening_done" && client && created && (
            <div className="mt-5 rounded-2xl border border-brand/25 bg-brand-soft px-6 py-5">
              <p className="flex items-center gap-2.5 text-[14px] text-brand">
                <span className="grid h-6 w-6 shrink-0 place-items-center rounded-full bg-brand text-[12px] text-white">✓</span>
                <span>
                  <span className="font-semibold">{created.title}</span> is open for {client.name}.
                </span>
              </p>
              <p className="mt-1.5 pl-[34px] text-[12.5px] text-ink-soft">
                {isLead
                  ? "The assigned TAs can see it now and will write the JD."
                  : "A JD draft is being prepared from what you entered."}
              </p>
              <div className="mt-4 flex flex-wrap items-center gap-2.5 pl-[34px]">
                <Link
                  href={isLead ? `/openings/${created.openingId}` : `/openings/${created.openingId}/jd`}
                  onClick={onClose}
                  className="rounded-full bg-brand px-5 py-2.5 text-[13px] font-medium text-white transition-opacity hover:opacity-90"
                >
                  {isLead ? "Go to the opening" : "Write the JD"}
                </Link>
                <button
                  type="button"
                  onClick={() => {
                    setCreated(null);
                    setRound((n) => n + 1);
                    setStep("opening");
                  }}
                  className="rounded-full border border-brand-line bg-surface px-4 py-2.5 text-[13px] font-medium text-brand transition-colors hover:bg-brand-soft"
                >
                  Another opening for {client.name}
                </button>
                <button type="button" onClick={onClose} className="px-2 text-[13px] text-ink-soft transition-colors hover:text-ink">
                  Close
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>,
    document.body,
  );
}

function ClientSummary({ client }: { client: NewClient }) {
  return (
    <div className="flex items-center gap-3 rounded-xl border border-rule bg-surface px-4 py-3">
      <span className="grid h-6 w-6 shrink-0 place-items-center rounded-full bg-brand text-[12px] text-white">✓</span>
      <div className="min-w-0">
        <p className="truncate text-[13.5px] font-medium">{client.name}</p>
        <p className="text-[11.5px] text-ink-faint">{client.industry && client.industry !== "—" ? `${client.industry} · ` : ""}Client saved</p>
      </div>
    </div>
  );
}

function StepDot({ n, label, state }: { n: number; label: string; state: "done" | "now" | "next" }) {
  return (
    <li className={`flex items-center gap-1.5 ${state === "next" ? "text-ink-faint" : "text-ink"}`}>
      <span
        className={`grid h-4.5 w-4.5 place-items-center rounded-full text-[10px] font-semibold ${
          state === "done" ? "bg-brand text-white" : state === "now" ? "border border-brand text-brand" : "border border-rule text-ink-faint"
        }`}
      >
        {state === "done" ? "✓" : n}
      </span>
      <span className={state === "now" ? "font-medium" : ""}>{label}</span>
    </li>
  );
}

export function Spinner() {
  return <span aria-hidden="true" className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-white/40 border-t-white" />;
}
