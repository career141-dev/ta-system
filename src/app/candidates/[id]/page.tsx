import { externalUrl } from "@/lib/url";
import Link from "next/link";
import { notFound } from "next/navigation";
import { repo } from "@/data/store";
import { pageUser } from "@/lib/session";
import { STAGE_LABEL } from "@/data/types";
import { AddToOpening } from "@/components/AddToOpening";
import { dateAt } from "@/lib/format";
import { allows } from "@/lib/auth";
import { primeStore } from "@/data/prime";
import { assess } from "@/lib/assessment";
import { FIT_BANDS } from "@/lib/scoring";
import { isConvex } from "@/data/mode";
import * as backend from "@/data/convex/backend";
import { fileSize, previewsInline, type CandidateProfile } from "@/lib/candidateProfile";

/**
 * A person, on their own — not through an opening.
 *
 * Most of the database is on no opening at all (588 of 754 in the audit's
 * copy), and the only way into one of them was their LinkedIn page, outside the
 * platform. This is their record: what we hold, every opening they have been
 * on and how it went, and the way onto the opening you are working now.
 *
 * Backed by Convex, the page also reads the full record — summary, a dated
 * career, every qualification, referees, the engine's match on each opening,
 * and the CV itself — which the narrow list mapper does not carry.
 */
export default async function CandidatePage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ msg?: string; from?: string }>;
}) {
  const { id } = await params;
  const { from } = await searchParams;
  const backHref = from ? decodeURIComponent(from) : null;
  // Only a path on this site: "/x" is, "//host/x" and "/\host" are another site.
  const safeBack = backHref && /^\/(?![\/\\])/.test(backHref) ? backHref : "/database";
  await primeStore({ candidateIds: [id] });
  const user = await pageUser("database.read");
  const c = repo.candidate(id);
  if (!c) notFound();

  // The full record, and whether the CV can actually be opened from here. Both
  // are best-effort: a profile that cannot reach them still shows what it has.
  let profile: CandidateProfile | null = null;
  let profileProblem: string | null = null;
  let cvLink: backend.CvLink | null = null;
  if (isConvex()) {
    const [p, link] = await Promise.allSettled([
      backend.candidateProfile({ id: null }, c.id),
      backend.cvLink({ id: null }, c.id),
    ]);
    if (p.status === "fulfilled") profile = p.value;
    else profileProblem = `The full record could not be loaded (${(p.reason as Error).message}).`;
    if (link.status === "fulfilled") cvLink = link.value;
  }

  const apps = repo.applicationsForCandidate(c.id).sort((a, b) => b.lastStageChangedAt - a.lastStageChangedAt);
  const mine = repo
    .openingsForUser(user)
    .filter((o) => o.status === "open" && !apps.some((a) => a.openingId === o.id))
    .filter((o) => allows(user, "opening.act", { openingId: o.id, assignment: repo.assignmentFor(o.id, user.id) ?? null }));
  const clients = repo.clients();
  // Reverse matching, candidate to openings: this person against every open
  // opening this seat can add to, on the same assessment the opening's own
  // screens use. Openings without an approved JD cannot be assessed and are left out.
  const fits = mine
    .map((o) => {
      const a = assess(o.id, [c]);
      return a.ok ? { opening: o, score: Math.round(a.scores.get(c.id)?.overall ?? 0) } : null;
    })
    .filter((x): x is { opening: (typeof mine)[number]; score: number } => !!x && x.score >= FIT_BANDS.worth)
    .sort((a, b) => b.score - a.score)
    .slice(0, 6);
  const status = repo.overallStatus(c.id);
  const linkedin = externalUrl(c.linkedinUrl);
  const matchFor = new Map((profile?.matches ?? []).map((m) => [m.applicationId, m]));

  const row = (label: string, value: React.ReactNode) => (
    <>
      <dt className="text-ink-faint">{label}</dt>
      <dd className="text-ink">{value || <span className="text-ink-faint">—</span>}</dd>
    </>
  );

  const notice =
    c.noticePeriodDays === 0
      ? "Immediate"
      : c.noticePeriodDays != null
        ? `${c.noticePeriodDays} days`
        : profile?.noticePeriodText ?? null;

  const cv = profile?.cv ?? null;
  const cvHref = `/api/cv/${encodeURIComponent(c.id)}`;

  return (
    <main className="mx-auto max-w-[1040px] px-8 py-9">
      <Link href={safeBack} className="text-[12.5px] text-ink-soft hover:text-ink">
        {backHref ? "← Back to results" : "← Database"}
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
          {profile?.doNotContact && (
            <p className="mt-1.5 text-[12.5px] font-medium text-danger">
              Do not contact{profile.doNotContact.reason ? ` — ${profile.doNotContact.reason}` : ""}
            </p>
          )}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {linkedin && (
            <a
              href={linkedin}
              target="_blank"
              rel="noreferrer"
              className="rounded-full border border-rule px-4 py-1.5 text-[12.5px] text-accent hover:bg-tag"
            >
              LinkedIn profile ↗
            </a>
          )}
          {cvLink?.ok && (
            <>
              <a
                href={cvHref}
                target="_blank"
                rel="noreferrer"
                className="rounded-full border border-rule px-4 py-1.5 text-[12.5px] text-accent hover:bg-tag"
              >
                View CV ↗
              </a>
              <a href={`${cvHref}?download=1`} className="rounded-full border border-rule px-4 py-1.5 text-[12.5px] text-ink-soft hover:bg-tag">
                Download
              </a>
            </>
          )}
        </div>
      </header>

      {profileProblem && (
        <p className="mt-4 rounded-xl border border-warn/30 bg-warn-soft px-4 py-3 text-[12.5px] text-warn">{profileProblem}</p>
      )}

      <div className="mt-7 grid gap-8 lg:grid-cols-[1fr_320px]">
        <div className="flex min-w-0 flex-col gap-6">
          {profile?.summary && (
            <section className="rounded-2xl border border-rule bg-surface px-6 py-5">
              <h2 className="mb-2 text-[13px] font-semibold">Summary</h2>
              <p className="whitespace-pre-line text-[13px] leading-relaxed text-ink">{profile.summary}</p>
            </section>
          )}

          <section className="rounded-2xl border border-rule bg-surface px-6 py-5">
            <h2 className="mb-3 text-[13px] font-semibold">On file</h2>
            <dl className="grid grid-cols-[150px_1fr] gap-x-4 gap-y-2.5 text-[13px]">
              {row("Email", c.email && <a href={`mailto:${c.email}`} className="text-accent hover:underline">{c.email}</a>)}
              {row("Phone", c.phone && <a href={`tel:${c.phone.replace(/[^\d+]/g, "")}`} className="text-accent hover:underline">{c.phone}</a>)}
              {row("LinkedIn", linkedin && (
                <a href={linkedin} target="_blank" rel="noreferrer" className="break-all text-accent hover:underline">
                  {linkedin.replace(/^https?:\/\/(www\.)?/, "").replace(/\/$/, "")}
                </a>
              ))}
              {row("Location", c.location)}
              {row("Experience", c.totalExperienceYears != null ? `${c.totalExperienceYears} years` : null)}
              {row("Seniority", profile?.seniority)}
              {row("Current salary", c.currentSalary)}
              {row("Expected salary", c.expectedSalary)}
              {row("Notice", notice)}
              {row("Availability", profile?.availability ?? profile?.employmentStatus)}
              {row("Nationality", c.nationality)}
              {row("Age", c.age ?? profile?.age)}
              {row("Gender", c.gender ?? profile?.gender)}
              {row("Languages", (profile?.languages.length ? profile.languages : c.languages).join(", "))}
              {row("Skills", c.skills.join(", "))}
              {row("Industries", c.industries.join(", "))}
              {row("Certifications", profile?.certifications.length ? profile.certifications.join(", ") : c.qualifications)}
              {row("Source", profile?.source?.replace(/_/g, " "))}
              {row("First seen", profile?.firstSeenAt ? dateAt(profile.firstSeenAt) : null)}
              {row("CV", cv ? [cv.fileName, fileSize(cv.fileSize)].filter(Boolean).join(" · ") : c.cvFileName)}
            </dl>
          </section>

          {(profile?.career.length ?? 0) > 0 ? (
            <section className="rounded-2xl border border-rule bg-surface px-6 py-5">
              <h2 className="mb-3 text-[13px] font-semibold">Career</h2>
              <ol className="flex flex-col gap-4">
                {profile!.career.map((w, i) => (
                  <li key={i} className="text-[12.5px]">
                    <div className="flex flex-wrap items-baseline justify-between gap-x-4">
                      <span>
                        <span className="font-medium text-ink">{w.title || "Role not recorded"}</span>
                        {w.employer && <span className="text-ink-soft"> · {w.employer}</span>}
                      </span>
                      {(w.from || w.to || w.current) && (
                        <span className="tabular text-[11.5px] text-ink-faint">
                          {w.from ?? "?"} – {w.current ? "Present" : w.to ?? "?"}
                        </span>
                      )}
                    </div>
                    {w.description && <p className="mt-1 whitespace-pre-line leading-relaxed text-ink-soft">{w.description}</p>}
                  </li>
                ))}
              </ol>
            </section>
          ) : (
            c.workHistory.length > 0 && (
              <section className="rounded-2xl border border-rule bg-surface px-6 py-5">
                <h2 className="mb-3 text-[13px] font-semibold">Career</h2>
                <ul className="flex flex-col gap-1.5 text-[12.5px]">
                  {c.workHistory.map((w, i) => (
                    <li key={i}>
                      <span className="text-ink">{w.title}</span>
                      <span className="text-ink-soft"> · {w.employer}</span>
                    </li>
                  ))}
                </ul>
              </section>
            )
          )}

          {(profile?.education.length ?? 0) > 0 ? (
            <section className="rounded-2xl border border-rule bg-surface px-6 py-5">
              <h2 className="mb-3 text-[13px] font-semibold">Education</h2>
              <ul className="flex flex-col gap-2 text-[12.5px]">
                {profile!.education.map((e, i) => (
                  <li key={i}>
                    <span className="text-ink">{[e.degree, e.field && e.field !== e.degree ? e.field : null].filter(Boolean).join(", ") || "Qualification"}</span>
                    {e.institution && <span className="text-ink-soft"> · {e.institution}</span>}
                    {e.year && <span className="text-ink-faint"> · {e.year}</span>}
                  </li>
                ))}
              </ul>
            </section>
          ) : (
            (c.educationDegree || c.educationInstitution) && (
              <section className="rounded-2xl border border-rule bg-surface px-6 py-5">
                <h2 className="mb-3 text-[13px] font-semibold">Education</h2>
                <p className="text-[12.5px]">{[c.educationDegree, c.educationInstitution].filter(Boolean).join(" — ")}</p>
              </section>
            )
          )}

          {isConvex() && (
            <section className="rounded-2xl border border-rule bg-surface px-6 py-5">
              <div className="mb-3 flex flex-wrap items-baseline justify-between gap-2">
                <h2 className="text-[13px] font-semibold">CV</h2>
                {cv && (
                  <span className="text-[11.5px] text-ink-faint">
                    {[cv.fileName, fileSize(cv.fileSize)].filter(Boolean).join(" · ")}
                  </span>
                )}
              </div>
              {cvLink?.ok ? (
                previewsInline(cv) || /pdf/i.test(cvLink.fileType ?? "") ? (
                  <iframe src={cvHref} title={`CV — ${c.fullName}`} className="h-[720px] w-full rounded-lg border border-rule bg-paper" />
                ) : (
                  <p className="text-[12.5px] text-ink-soft">
                    This file type does not preview in the browser.{" "}
                    <a href={`${cvHref}?download=1`} className="font-medium text-accent hover:underline">Download it</a>.
                  </p>
                )
              ) : (
                <p className="text-[12.5px] text-ink-soft">{cvLink ? cvLink.detail : "No CV file is on record for this candidate."}</p>
              )}
              {profile?.cvText && (
                <details className="mt-3">
                  <summary className="cursor-pointer text-[12.5px] font-medium text-accent">Text read from the CV</summary>
                  <pre className="mt-2 max-h-[480px] overflow-auto whitespace-pre-wrap rounded-lg bg-paper px-4 py-3 font-sans text-[12px] leading-relaxed text-ink-soft">
                    {profile.cvText}
                  </pre>
                </details>
              )}
            </section>
          )}

          {(profile?.referees.length ?? 0) > 0 && (
            <section className="rounded-2xl border border-rule bg-surface px-6 py-5">
              <h2 className="mb-3 text-[13px] font-semibold">Referees</h2>
              <ul className="grid gap-3 sm:grid-cols-2">
                {profile!.referees.map((r, i) => (
                  <li key={i} className="rounded-lg bg-paper px-4 py-3 text-[12.5px]">
                    <div className="font-medium text-ink">{r.name}</div>
                    {(r.designation || r.company) && <div className="text-ink-soft">{[r.designation, r.company].filter(Boolean).join(", ")}</div>}
                    {r.relationship && <div className="text-ink-faint">{r.relationship}</div>}
                    {r.contactNo && <div className="mt-1 tabular">{r.contactNo}</div>}
                    {r.email && <div className="break-all">{r.email}</div>}
                  </li>
                ))}
              </ul>
            </section>
          )}
        </div>

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
                  const m = matchFor.get(a.id);
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
                      {m?.score != null && (
                        <p className="mt-1 text-[12px] text-ink-soft">
                          <span className="tabular font-semibold text-ink">Match {Math.round(m.score)}</span>
                          {m.explanation ? ` — ${m.explanation}` : ""}
                        </p>
                      )}
                    </li>
                  );
                })}
              </ul>
            )}
          </section>

          {fits.length > 0 && (
            <section className="rounded-2xl border border-rule bg-surface px-5 py-4" id="fits">
              <h2 className="text-[13px] font-semibold">Openings they may fit</h2>
              <p className="mt-1 text-[12px] text-ink-faint">Scored against each open opening&rsquo;s approved JD.</p>
              <ul className="mt-2 divide-y divide-rule">
                {fits.map(({ opening: o, score }) => (
                  <li key={o.id} className="flex items-center justify-between gap-3 py-2 text-[12.5px]">
                    <span>
                      <span className="tabular font-semibold">{score}</span>{" "}
                      <span className="font-medium">{o.title}</span>
                      <span className="text-ink-soft"> · {clients.find((x) => x.id === o.clientId)?.name}</span>
                    </span>
                    <AddToOpening candidateId={c.id} openings={[{ id: o.id, label: o.title }]} variant="single" />
                  </li>
                ))}
              </ul>
            </section>
          )}

          {mine.length > 0 && (
            <AddToOpening
              candidateId={c.id}
              openings={mine.map((o) => ({ id: o.id, label: `${clients.find((x) => x.id === o.clientId)?.name} — ${o.title}` }))}
              variant="card"
            />
          )}

          {(profile?.pastTitles.length ?? 0) > 1 && (
            <section className="rounded-2xl border border-rule bg-surface px-5 py-4">
              <h2 className="text-[13px] font-semibold">Titles they have held</h2>
              <p className="mt-2 text-[12.5px] leading-relaxed text-ink-soft">{profile!.pastTitles.join(" · ")}</p>
            </section>
          )}
        </aside>
      </div>
    </main>
  );
}
