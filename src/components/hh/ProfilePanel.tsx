"use client";

import { useState } from "react";
import { keepSuggestion, dismissSuggestion } from "@/app/actions";
import type { ProfileSuggestion } from "@/data/types";

/**
 * A suggested profile, opened — spec §8A.2.
 *
 * The same shape as the candidate drawer, so a TA reads one layout wherever a
 * name is clicked. What it cannot do is show the LinkedIn profile itself:
 * LinkedIn answers an embed with HTTP 999, which is the same block that stops
 * the sourcing pipeline reading profiles. So the panel carries everything the
 * search established, and the profile opens in its own tab.
 */
export function ProfilePanel({
  s,
  openingId,
  onClose,
}: {
  s: ProfileSuggestion;
  openingId: string;
  onClose: () => void;
}) {
  const initials = s.name.split(" ").map((p) => p[0]).join("").slice(0, 2).toUpperCase();

  return (
    <div className="fixed inset-0 z-50 flex justify-end bg-[rgba(23,28,24,0.28)]" onClick={onClose}>
      <aside
        onClick={(e) => e.stopPropagation()}
        className="flex h-full w-full max-w-[620px] flex-col overflow-y-auto bg-paper shadow-[-8px_0_28px_rgba(23,28,24,0.12)]"
      >
        <div className="sticky top-0 z-10 flex items-center gap-3 border-b border-rule bg-surface px-6 py-3.5">
          <span className="text-[13.5px] font-semibold">Suggested profile</span>
          <span className="rounded bg-tag px-1.5 py-[3px] text-[10.5px] font-medium text-ink-soft">
            round {s.round}
          </span>
          <button
            onClick={onClose}
            aria-label="Close"
            className="ml-auto grid h-8 w-8 place-items-center rounded-full text-[16px] text-ink-faint transition-colors hover:bg-tag hover:text-ink"
          >
            ✕
          </button>
        </div>

        <div className="px-6 py-6">
          <section className="rounded-2xl border border-rule bg-surface p-6">
            <div className="flex gap-5">
              <span className="grid h-[76px] w-[76px] shrink-0 place-items-center rounded-full bg-[#c9a227] text-[22px] font-semibold text-white">
                {initials}
              </span>
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2.5">
                  <h2 className="text-[20px] font-semibold tracking-tight">{s.name}</h2>
                  <span
                    className={`rounded px-1.5 py-[3px] text-[10.5px] font-medium ${
                      s.tier === "priority" ? "bg-brand-soft text-brand" : "bg-tag text-ink-soft"
                    }`}
                  >
                    {s.tier === "priority" ? "Priority" : "Screen"}
                  </span>
                </div>
                <p className="mt-1 text-[14px]">{s.headline}</p>
                <p className="mt-0.5 text-[12px] text-ink-faint">
                  {[s.company, s.location].filter(Boolean).join(" · ") || "Employer not established"}
                </p>

                {s.linkedinUrl && (
                  <a
                    href={s.linkedinUrl}
                    target="_blank"
                    rel="noreferrer"
                    className="mt-3.5 inline-flex items-center gap-1.5 text-[13px] font-medium text-accent hover:underline"
                  >
                    <span className="grid h-[15px] w-[15px] place-items-center rounded-[2px] bg-accent text-[9px] font-bold leading-none text-white">
                      in
                    </span>
                    Open the LinkedIn profile
                  </a>
                )}
              </div>
            </div>

            <div className="mt-5 flex flex-wrap items-center gap-2.5 border-t border-rule pt-5">
              <form action={keepSuggestion}>
                <input type="hidden" name="openingId" value={openingId} />
                <input type="hidden" name="suggestionId" value={s.id} />
                <button
                  disabled={!s.linkedinUrl}
                  className="rounded-full bg-brand px-4 py-2 text-[13px] font-medium text-white transition-opacity hover:opacity-90 disabled:bg-rule-strong"
                >
                  Add to the list
                </button>
              </form>
              <form action={dismissSuggestion}>
                <input type="hidden" name="openingId" value={openingId} />
                <input type="hidden" name="suggestionId" value={s.id} />
                <button className="rounded-full border border-rule px-4 py-2 text-[13px] text-ink-soft transition-colors hover:bg-tag hover:text-ink">
                  Reject
                </button>
              </form>
            </div>
          </section>

          <section className="mt-4 rounded-2xl border border-rule bg-surface p-6">
            <dl className="grid grid-cols-[92px_1fr] gap-x-4 gap-y-3 text-[13px] leading-relaxed">
              <dt className="font-semibold text-ink-soft">Why</dt>
              <dd className="text-ink-soft">{s.why}</dd>
              {s.concern && (
                <>
                  <dt className="font-semibold text-ink-soft">Confirm</dt>
                  <dd className="text-warn">{s.concern}</dd>
                </>
              )}
              <dt className="font-semibold text-ink-soft">Found by</dt>
              <dd className="text-ink-soft">
                Search round {s.round}
                {s.sourceUrl && (
                  <>
                    {" · "}
                    <a href={s.sourceUrl} target="_blank" rel="noreferrer" className="text-accent hover:underline">
                      source
                    </a>
                  </>
                )}
              </dd>
            </dl>

            <p className="mt-5 border-t border-rule pt-4 text-[11.5px] leading-relaxed text-ink-faint">
              Everything above is judged from what the open web says, not from reading the profile —
              LinkedIn blocks that. Open the profile before approaching them.
            </p>
          </section>
        </div>
      </aside>
    </div>
  );
}

/** The name in the list, which opens the panel. */
export function SuggestionName({ s, openingId }: { s: ProfileSuggestion; openingId: string }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        onClick={() => setOpen(true)}
        className="text-left text-[14px] font-semibold text-accent hover:underline"
      >
        {s.name}
      </button>
      {open && <ProfilePanel s={s} openingId={openingId} onClose={() => setOpen(false)} />}
    </>
  );
}
