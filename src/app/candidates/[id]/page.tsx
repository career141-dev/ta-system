import Link from "next/link";
import { notFound } from "next/navigation";
import { repo } from "@/data/store";
import { pageUser } from "@/lib/session";
import { STAGE_LABEL } from "@/data/types";
import { addToOpening } from "@/app/actions";
import { dateAt } from "@/lib/format";
import { allows } from "@/lib/auth";

/**
 * A person, on their own — not through an opening.
 *
 * Most of the database is on no opening at all (588 of 754 in the audit's
 * copy), and the only way into one of them was their LinkedIn page, outside the
 * platform. This is their record: what we hold, every opening they have been
 * on and how it went, and the way onto the opening you are working now.
 */
export default async function CandidatePage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ msg?: string }>;
}) {
  const { id } = await params;
  const { msg } = await searchParams;
  const user = await pageUser("database.read");
  const c = repo.candidate(id);
  if (!c) notFound();

  const apps = repo.applicationsForCandidate(c.id).sort((a, b) => b.lastStageChangedAt - a.lastStageChangedAt);
  const mine = repo
    .openingsForUser(user)
    .filter((o) => o.status === "open" && !apps.some((a) => a.openingId === o.id))
    .filter((o) => allows(user, "opening.act", { openingId: o.id, assignment: repo.assignmentFor(o.id, user.id) ?? null }));
  const clients = repo.clients();
  const status = repo.overallStatus(c.id);

  const row = (label: string, value: React.ReactNode) => (
    <>
      <dt className="text-ink-faint">{label}</dt>
      <dd className="text-ink">{value || <span className="text-ink-faint">—</span>}</dd>
    </>
  );

  return (
    <main className="mx-auto max-w-[1040px] px-8 py-9">
      <Link href="/database" className="text-[12.5px] text-ink-soft hover:text-ink">
        ← Database
      </Link>

      <header className="mt-3 flex flex-wrap items-start justify-between gap-6">
        <div>
          <h1 className="text-[24px] font-semibold tracking-tight">{c.fullName}</h1>
          <p className="mt-1 text-[13px] text-ink-soft">
            {[c.currentTitle, c.currentEmployer].filter(Boolean).join(" at ") || "No current role on file"}
            {c.location && ` · ${c.location}`}
          </p>
          {status?.busy && status.stage && (
            <p className="mt-1.5 text-[12.5px] font-medium text-warn">
              {status.stage === "placed" ? "Placed elsewhere" : `${STAGE_LABEL[status.stage]} on another opening`}
            </p>
          )}
        </div>
        {c.linkedinUrl && (
          <a href={c.linkedinUrl} target="_blank" rel="noreferrer" className="text-[12.5px] text-accent hover:underline">
            LinkedIn profile ↗
          </a>
        )}
      </header>


      <div className="mt-7 grid gap-8 lg:grid-cols-[1fr_320px]">
        <section className="rounded-2xl border border-rule bg-surface px-6 py-5">
          <h2 className="mb-3 text-[13px] font-semibold">On file</h2>
          <dl className="grid grid-cols-[150px_1fr] gap-x-4 gap-y-2.5 text-[13px]">
            {row("Email", c.email)}
            {row("Phone", c.phone)}
            {row("Experience", c.totalExperienceYears != null ? `${c.totalExperienceYears} years` : null)}
            {row("Education", [c.educationDegree, c.educationInstitution].filter(Boolean).join(" — "))}
            {row("Qualifications", c.qualifications)}
            {row("Nationality", c.nationality)}
            {row("Current salary", c.currentSalary)}
            {row("Expected salary", c.expectedSalary)}
            {row("Notice", c.noticePeriodDays === 0 ? "Immediate" : c.noticePeriodDays != null ? `${c.noticePeriodDays} days` : null)}
            {row("Skills", c.skills.join(", "))}
            {row("Industries", c.industries.join(", "))}
            {row("CV", c.cvFileName)}
          </dl>
          {c.workHistory.length > 0 && (
            <>
              <h3 className="mb-2 mt-6 text-[13px] font-semibold">Career</h3>
              <ul className="flex flex-col gap-1.5 text-[12.5px]">
                {c.workHistory.map((w, i) => (
                  <li key={i}>
                    <span className="text-ink">{w.title}</span>
                    <span className="text-ink-soft"> · {w.employer}</span>
                  </li>
                ))}
              </ul>
            </>
          )}
        </section>

        <aside className="flex flex-col gap-6">
          <section className="rounded-2xl border border-rule bg-surface px-5 py-4">
            <h2 className="text-[13px] font-semibold">Openings they have been on</h2>
            {apps.length === 0 ? (
              <p className="mt-2 text-[12.5px] text-ink-faint">None yet.</p>
            ) : (
              <ul className="mt-2 divide-y divide-rule">
                {apps.map((a) => {
                  const o = repo.opening(a.openingId);
                  const canOpen = allows(user, "opening.read", { openingId: a.openingId, assignment: repo.assignmentFor(a.openingId, user.id) ?? null });
                  return (
                    <li key={a.id} className="py-2 text-[12.5px]">
                      {canOpen ? (
                        <Link href={`/openings/${a.openingId}/candidate/${a.id}`} className="font-medium hover:underline">
                          {o?.title}
                        </Link>
                      ) : (
                        <span className="font-medium">{o?.title}</span>
                      )}
                      <span className="text-ink-soft"> · {clients.find((x) => x.id === o?.clientId)?.name}</span>
                      <br />
                      <span className="text-ink-faint">
                        {STAGE_LABEL[a.stage]} · {dateAt(a.lastStageChangedAt)}
                        {a.rejectReason ? ` · ${a.rejectReason}` : ""}
                      </span>
                    </li>
                  );
                })}
              </ul>
            )}
          </section>

          {mine.length > 0 && (
            <form action={addToOpening} className="rounded-2xl border border-rule bg-surface px-5 py-4">
              <input type="hidden" name="candidateId" value={c.id} />
              <h2 className="text-[13px] font-semibold">Add to an opening</h2>
              <p className="mt-1 text-[12px] text-ink-faint">Goes in as a database match, ready to shortlist.</p>
              <select name="openingId" className="mt-2.5 w-full rounded border border-rule bg-paper px-2.5 py-2 text-[12.5px]">
                {mine.map((o) => (
                  <option key={o.id} value={o.id}>
                    {clients.find((x) => x.id === o.clientId)?.name} — {o.title}
                  </option>
                ))}
              </select>
              <button className="mt-2.5 rounded-full bg-brand px-4 py-1.5 text-[12.5px] font-medium text-white">Add</button>
            </form>
          )}
        </aside>
      </div>
    </main>
  );
}
