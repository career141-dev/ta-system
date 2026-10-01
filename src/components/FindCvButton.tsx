"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { chooseCvInline, findCv } from "@/app/actions";
import type { CvHit } from "@/lib/cvMatch";
import { ActionNote, Spinner, submitted, useInline } from "./Submit";

/**
 * "Find CV" (1 Oct): is this LinkedIn person already in our database?
 *
 * The matching links a profile on its own only when it is certain, so a
 * person whose company or title changed since their CV was missed, and became
 * a second record. This asks on demand: one clear match is shown alone; if
 * there are several, the top few are listed with enough to tell them apart —
 * title, company, past employers, place, LinkedIn, contact, whether a CV is on
 * file — and the TA chooses. Nothing is linked until they do.
 */
export function FindCvButton({ openingId, entryId, suggestionId }: { openingId: string; entryId?: string; suggestionId?: string }) {
  const [hits, setHits] = useState<CvHit[] | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [searching, start] = useTransition();
  const choose = useInline(chooseCvInline);

  const search = () =>
    start(async () => {
      setProblem(null);
      const r = await findCv({ openingId, entryId, suggestionId });
      if (r.ok) setHits(r.hits);
      else setProblem(r.message);
    });

  // One certain match, well clear of the next: shown alone.
  const clear = hits && hits[0]?.strength === "same" && (hits.length === 1 || hits[1].score < 60);
  const shown = clear ? hits!.slice(0, 1) : (hits ?? []);

  return (
    <div className="mt-1.5">
      {hits === null ? (
        <button
          type="button"
          onClick={search}
          disabled={searching}
          title="Search our database for this person before adding them again"
          className="inline-flex items-center gap-1.5 rounded-full border border-brand-line px-3 py-1 text-[12px] font-medium text-brand hover:bg-brand-soft disabled:opacity-60"
        >
          {searching && <Spinner tone="dark" />}
          {searching ? "Searching our database…" : "Find CV"}
        </button>
      ) : (
        <div className="rounded-lg border border-rule bg-paper p-3">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <p className="text-[12.5px] font-medium">
              {hits.length === 0
                ? "Nobody in our database matches this profile — it is a new person."
                : clear
                  ? "Found in our database"
                  : `${hits.length} possible ${hits.length === 1 ? "match" : "matches"} — check before choosing`}
            </p>
            <button type="button" onClick={() => setHits(null)} className="text-[12px] text-ink-soft hover:text-ink">
              {hits.length ? "None of these" : "Close"}
            </button>
          </div>
          <ul className="mt-2 grid gap-2">
            {shown.map((h) => (
              <li key={h.candidateId} className="rounded-lg border border-rule bg-surface p-3 text-[12.5px]">
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div className="min-w-0">
                    <Link href={`/candidates/${encodeURIComponent(h.candidateId)}`} target="_blank" className="font-semibold text-accent hover:underline">
                      {h.fullName || "Unnamed candidate"}
                    </Link>
                    <span className={`ml-2 rounded px-1.5 py-[2px] text-[10.5px] font-medium ${h.hasCv ? "bg-brand-soft text-brand" : "bg-tag text-ink-soft"}`}>
                      {h.hasCv ? "CV on file" : "No CV yet"}
                    </span>
                    <p className="mt-0.5 text-ink-soft">
                      {[h.currentTitle, h.currentEmployer].filter(Boolean).join(" at ") || "Title not recorded"}
                      {h.location ? ` · ${h.location}` : ""}
                    </p>
                    {h.pastEmployers.length > 0 && <p className="text-[12px] text-ink-faint">Worked at: {h.pastEmployers.join(", ")}</p>}
                    <p className="text-[12px] text-ink-faint">
                      {[h.email, h.phone].filter(Boolean).join(" · ") || "No contact on file"}
                      {h.linkedinUrl ? (
                        <>
                          {" · "}
                          <a href={h.linkedinUrl} target="_blank" rel="noreferrer" className="text-accent hover:underline">
                            LinkedIn
                          </a>
                        </>
                      ) : null}
                    </p>
                    <p className="mt-0.5 text-[11.5px] text-ink-faint">Why: {h.reasons.join(", ")}</p>
                  </div>
                  <form onSubmit={(e) => choose.run(submitted(e).formData)}>
                    <input type="hidden" name="openingId" value={openingId} />
                    {entryId && <input type="hidden" name="entryId" value={entryId} />}
                    {suggestionId && <input type="hidden" name="suggestionId" value={suggestionId} />}
                    <input type="hidden" name="candidateId" value={h.candidateId} />
                    <button
                      disabled={choose.pending}
                      className="rounded-full bg-brand px-3 py-1 text-[12px] font-medium text-white disabled:opacity-60"
                    >
                      {choose.pending ? "Linking…" : "This is them"}
                    </button>
                  </form>
                </div>
              </li>
            ))}
          </ul>
          <ActionNote result={choose.result} className="mt-2" />
        </div>
      )}
      {problem && <p className="mt-1 text-[12px] text-danger">{problem}</p>}
    </div>
  );
}
