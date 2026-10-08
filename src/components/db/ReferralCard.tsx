import Link from "next/link";
import { CopyButton } from "./CopyButton";
import { relDays } from "@/lib/format";
import type { ReferralPerson } from "@/lib/referralSearch";

/**
 * One referee. The title and company are what a CV said, sometimes years ago,
 * so the card says so and when it was read; it is never presented as where the
 * person works now.
 */
export function ReferralCard({ p }: { p: ReferralPerson }) {
  const tel = p.phone?.replace(/[^\d+]/g, "") ?? "";
  return (
    <li className="rounded-xl border border-rule bg-surface px-5 py-4">
      <div className="flex flex-wrap items-start justify-between gap-x-6 gap-y-3">
        <div className="min-w-0 flex-1">
          <p className="text-[14.5px] font-semibold">{p.name}</p>
          <p className="mt-0.5 text-[12.5px]">
            {p.designation ?? <span className="text-ink-faint">Title not on the CV</span>}
            {p.company && (
              <>
                <span className="text-ink-faint"> at </span>
                <span className="font-medium">{p.company}</span>
              </>
            )}
          </p>
          {p.why.length > 0 && (
            <p className="mt-2 flex flex-wrap gap-1.5">
              {p.why.map((w) => (
                <span key={w} className="rounded-full bg-brand-soft px-2.5 py-0.5 text-[11px] text-brand">
                  {w}
                </span>
              ))}
            </p>
          )}
        </div>

        <div className="shrink-0 text-[12.5px] sm:text-right">
          {p.phone ? (
            <p className="flex items-center gap-1 sm:justify-end">
              <a href={`tel:${tel}`} className="tabular font-medium text-brand hover:underline">{p.phone}</a>
              <CopyButton text={p.phone} label="phone number" />
            </p>
          ) : (
            <p className="text-ink-faint">No number on file</p>
          )}
          {p.email ? (
            <p className="mt-0.5 flex items-center gap-1 sm:justify-end">
              <a href={`mailto:${p.email}`} className="break-all text-brand hover:underline">{p.email}</a>
              <CopyButton text={p.email} label="email" />
            </p>
          ) : (
            <p className="mt-0.5 text-ink-faint">No email on file</p>
          )}
        </div>
      </div>

      <div className="mt-3 border-t border-rule/70 pt-2.5 text-[12px] text-ink-soft">
        <p>
          {p.namedByCount > 1 ? `Named by ${p.namedByCount} candidates: ` : "Reference for "}
          {p.namedBy.map((c, i) => (
            <span key={c.id}>
              {i > 0 && ", "}
              <Link href={`/candidates/${c.id}`} className="font-medium text-brand hover:underline">{c.fullName}</Link>
              {(c.title || c.employer) && (
                <span className="text-ink-faint"> ({[c.title, c.employer].filter(Boolean).join(" at ")})</span>
              )}
            </span>
          ))}
          {p.namedByCount > p.namedBy.length && <span className="text-ink-faint"> and {p.namedByCount - p.namedBy.length} more</span>}
        </p>
        <p className="mt-1 text-[11px] text-ink-faint">
          From the CV{p.at ? `, read ${relDays(p.at)}` : ""} — the role may have changed since.
        </p>
      </div>
    </li>
  );
}
