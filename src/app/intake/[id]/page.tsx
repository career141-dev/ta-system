import Link from "next/link";
import { notFound } from "next/navigation";
import { repo } from "@/data/store";
import { pageUser } from "@/lib/session";
import { PageHead, Card } from "@/components/ui";
import { timeAt } from "@/lib/format";
import {
  admitIntake,
  editIntakeParsed,
  mergeIntake,
  recheckIntake,
  rejectIntake,
} from "@/app/actions";

/**
 * One CV at the door.
 *
 * Three questions, in the order they have to be answered: is this readable, is
 * this somebody we already hold, and do we want them. The screen refuses to
 * skip the middle one — `Admit as new` is disabled while the identity check has
 * an open question, and clearing it takes a deliberate press.
 */

const FIELDS: { key: string; label: string; wide?: boolean }[] = [
  { key: "fullName", label: "Name" },
  { key: "email", label: "Email" },
  { key: "phone", label: "Phone" },
  { key: "linkedinUrl", label: "LinkedIn", wide: true },
  { key: "currentTitle", label: "Current title" },
  { key: "currentEmployer", label: "Employer" },
  { key: "location", label: "Location" },
  { key: "totalExperienceYears", label: "Years" },
];

export default async function IntakeItemPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ msg?: string }>;
}) {
  const { id } = await params;
  const { msg } = await searchParams;
  await pageUser("intake.handle");
  const item = repo.intakeItem(id);
  if (!item) notFound();

  const p = item.parsed;
  const match = item.match;
  const openings = repo.openings().filter((o) => o.status === "open");
  const settled = item.status === "admitted" || item.status === "merged" || item.status === "rejected";
  const hit = match?.candidateId ? repo.candidate(match.candidateId) : null;
  const routedTa = item.routedToTaId ? repo.user(item.routedToTaId) : null;
  const routedPost = item.jobPostId
    ? repo.jobPosts().find((p) => p.id === item.jobPostId) ?? null
    : null;
  const routedOpening = item.openingId ? repo.opening(item.openingId) : null;
  const value = (k: string) => {
    const v = p ? (p as unknown as Record<string, unknown>)[k] : null;
    return v === null || v === undefined ? "" : String(v);
  };

  return (
    <main className="mx-auto max-w-[1000px] px-8 py-7">
      <Link href="/intake" className="text-[12px] text-ink-soft hover:text-ink">
        ← CV intake
      </Link>
      <div className="mt-2">
        <PageHead
          title={p?.fullName ?? item.fileName ?? "Unreadable file"}
          sub={`${item.fileName ?? "no file name"} · arrived ${timeAt(item.receivedAt)}${
            item.receivedFrom ? ` from ${item.receivedFrom}` : ""
          }`}
        />
      </div>


      {settled && (
        <Card className="mb-6 px-5 py-3.5">
          <p className="text-[13px]">
            <span className="font-medium">
              {item.status === "admitted"
                ? "Admitted as a new candidate."
                : item.status === "merged"
                  ? `Merged into ${hit?.fullName ?? "an existing record"}.`
                  : "Thrown out."}
            </span>{" "}
            <span className="text-ink-soft">
              {repo.user(item.handledBy ?? "")?.name ?? "Someone"}
              {item.handledAt ? `, ${timeAt(item.handledAt)}` : ""}.
            </span>
          </p>
          {item.note && <p className="mt-1 text-[12.5px] text-ink-soft">{item.note}</p>}
        </Card>
      )}

      {/* ── How it got here ─────────────────────────────────────────────── */}
      {item.toAddress && (
        <section className="mb-7">
          <h2 className="mb-3 text-[13.5px] font-semibold">How it got here</h2>
          <Card className="divide-y divide-rule">
            <div className="flex items-baseline gap-3 px-5 py-2.5">
              <span className="w-[96px] shrink-0 text-[11px] uppercase tracking-[0.08em] text-ink-faint">
                Arrived at
              </span>
              <span className="flex-1 text-[12.5px]">
                {item.toAddress}
                {routedTa && <span className="text-ink-soft"> — {routedTa.name}&rsquo;s mailbox</span>}
              </span>
            </div>
            {item.subject && (
              <div className="flex items-baseline gap-3 px-5 py-2.5">
                <span className="w-[96px] shrink-0 text-[11px] uppercase tracking-[0.08em] text-ink-faint">
                  Subject
                </span>
                <span className="flex-1 text-[12.5px]">{item.subject}</span>
              </div>
            )}
            <div className="flex items-baseline gap-3 px-5 py-2.5">
              <span className="w-[96px] shrink-0 text-[11px] uppercase tracking-[0.08em] text-ink-faint">
                Filed under
              </span>
              <span className="flex-1 text-[12.5px]">
                {routedPost ? (
                  <>
                    <span className="font-medium">{routedPost.title}</span>
                    {routedOpening && (
                      <span className="text-ink-soft"> · {routedOpening.title}</span>
                    )}
                  </>
                ) : (
                  <span className="text-warn">Nothing — pick the opening below.</span>
                )}
              </span>
            </div>
            {item.routeNote && (
              <p className="px-5 py-2.5 text-[11.5px] text-ink-faint">{item.routeNote}</p>
            )}
          </Card>
        </section>
      )}

      {/* ── What the identity check found ───────────────────────────────── */}
      <section className="mb-7">
        <h2 className="mb-3 text-[13.5px] font-semibold">Is this somebody we already hold?</h2>
        <Card className="overflow-hidden">
          <div
            className={`px-5 py-4 ${
              match?.verdict === "review" ? "bg-warn/10" : match?.verdict === "same" ? "bg-paper" : ""
            }`}
          >
            {!match ? (
              <p className="text-[13px] text-ink-soft">Not checked yet.</p>
            ) : match.verdict === "new" ? (
              <p className="text-[13px]">
                Nobody on the database matches. Checked against {repo.candidates().length} records
                on email, phone, LinkedIn and name.
              </p>
            ) : (
              <>
                <p className="text-[13px]">
                  {match.verdict === "same" ? "This is " : "This may be "}
                  <Link
                    href={`/database?q=${encodeURIComponent(match.candidateName ?? "")}`}
                    className="font-medium underline underline-offset-2"
                  >
                    {match.candidateName}
                  </Link>
                  {hit?.currentTitle ? (
                    <span className="text-ink-soft">
                      {" "}
                      — {hit.currentTitle}
                      {hit.currentEmployer ? ` at ${hit.currentEmployer}` : ""}
                    </span>
                  ) : null}
                </p>
                <ul className="mt-2 flex flex-wrap gap-1.5">
                  {match.evidence.map((e, i) => (
                    <li
                      key={i}
                      className={`rounded px-1.5 py-0.5 text-[11.5px] ${
                        e.strong
                          ? "bg-ink text-surface"
                          : "border border-rule-strong text-ink-soft"
                      }`}
                    >
                      {e.key}: {e.detail}
                    </li>
                  ))}
                </ul>
                {match.reason && (
                  <p className="mt-2.5 max-w-[68ch] text-[12.5px] leading-relaxed text-ink-soft">
                    {match.reason}
                  </p>
                )}
              </>
            )}
          </div>
          <div className="flex items-center justify-between border-t border-rule px-5 py-2.5">
            <span className="text-[11.5px] text-ink-faint">
              {match ? `Checked ${timeAt(match.checkedAt)}.` : ""} A solid line means a matching
              email, phone or LinkedIn; an outlined one only supports.
            </span>
            {!settled && (
              <form action={recheckIntake}>
                <input type="hidden" name="itemId" value={item.id} />
                <button className="text-[12px] text-ink-soft underline underline-offset-2 hover:text-ink">
                  Check again
                </button>
              </form>
            )}
          </div>
        </Card>
      </section>

      {/* ── What was read ───────────────────────────────────────────────── */}
      <section className="mb-7">
        <div className="mb-3 flex flex-wrap items-baseline justify-between gap-3">
          <h2 className="text-[13.5px] font-semibold">What was read out of it</h2>
          <span className="text-[12px] text-ink-faint">
            {FIELDS.filter((f) => p?.readFields.includes(f.key)).length} of {FIELDS.length} fields
            found in the text
          </span>
        </div>
        <Card className="p-5">
          <form action={editIntakeParsed} className="grid gap-3">
            <input type="hidden" name="itemId" value={item.id} />
            <div className="grid gap-3 sm:grid-cols-2">
              {FIELDS.map((f) => (
                <label key={f.key} className={`block ${f.wide ? "sm:col-span-2" : ""}`}>
                  <span className="mb-1 flex items-baseline gap-1.5 text-[11px] uppercase tracking-[0.08em] text-ink-faint">
                    {f.label}
                    {!p?.readFields.includes(f.key) && (
                      <span className="normal-case tracking-normal text-[10.5px] text-warn">
                        not found
                      </span>
                    )}
                  </span>
                  <input
                    name={f.key}
                    defaultValue={value(f.key)}
                    disabled={settled}
                    className="w-full rounded border border-rule bg-paper px-2.5 py-1.5 text-[13px] disabled:opacity-60"
                  />
                </label>
              ))}
            </div>

            {p?.skills.length ? (
              <div>
                <span className="mb-1 block text-[11px] uppercase tracking-[0.08em] text-ink-faint">
                  Skills
                </span>
                <div className="flex flex-wrap gap-1.5">
                  {p.skills.map((s) => (
                    <span
                      key={s}
                      className="rounded border border-rule px-1.5 py-0.5 text-[11.5px] text-ink-soft"
                    >
                      {s}
                    </span>
                  ))}
                </div>
              </div>
            ) : null}

            {item.problems.length > 0 && (
              <ul className="rounded border border-rule bg-paper px-3.5 py-2.5 text-[12.5px] text-ink-soft">
                {item.problems.map((x, i) => (
                  <li key={i}>· {x}</li>
                ))}
              </ul>
            )}

            <p className="max-w-[70ch] text-[11.5px] leading-relaxed text-ink-faint">
              Blank means the text did not say, not that the person has none. Nothing here is
              guessed at — a field the system filled in wrongly is a mistake nobody notices, and a
              wrong email or phone becomes the key the next duplicate is judged on. Correcting one
              here re-runs the check above.
            </p>

            {!settled && (
              <div>
                <button
                  type="submit"
                  className="rounded border border-rule-strong px-3 py-1.5 text-[12.5px] font-medium"
                >
                  Save corrections
                </button>
              </div>
            )}
          </form>
        </Card>
      </section>

      {/* ── The decision ────────────────────────────────────────────────── */}
      {!settled && (
        <section className="mb-7">
          <h2 className="mb-3 text-[13.5px] font-semibold">Decide</h2>
          <div className="grid gap-3 md:grid-cols-3">
            <Card className="flex flex-col p-4">
              <h3 className="text-[13px] font-medium">Admit as new</h3>
              <p className="mt-1 flex-1 text-[12px] leading-relaxed text-ink-soft">
                Writes a new candidate
                {item.openingId ? " and puts them on the opening this came in against" : ""}.
              </p>
              <form action={admitIntake} className="mt-3 grid gap-2">
                <input type="hidden" name="itemId" value={item.id} />
                <select
                  name="openingId"
                  defaultValue={item.openingId ?? ""}
                  className="w-full rounded border border-rule bg-paper px-2 py-1.5 text-[12.5px]"
                >
                  <option value="">Database only</option>
                  {openings.map((o) => (
                    <option key={o.id} value={o.id}>
                      {o.title}
                    </option>
                  ))}
                </select>
                {match?.verdict === "review" && (
                  <label className="flex items-start gap-2 text-[11.5px] text-ink-soft">
                    <input type="checkbox" name="force" value="1" className="mt-0.5" />
                    <span>Yes, this is a different person to {match.candidateName}.</span>
                  </label>
                )}
                <button
                  type="submit"
                  disabled={!p?.fullName}
                  className="rounded bg-ink px-3 py-1.5 text-[12.5px] font-medium text-surface disabled:opacity-40"
                >
                  Admit
                </button>
                {!p?.fullName && (
                  <span className="text-[11px] text-ink-faint">Fill the name in first.</span>
                )}
              </form>
            </Card>

            <Card className="flex flex-col p-4">
              <h3 className="text-[13px] font-medium">
                Merge into {match?.candidateName ?? "an existing record"}
              </h3>
              <p className="mt-1 flex-1 text-[12px] leading-relaxed text-ink-soft">
                Fills in what that record is missing and adds any new skills. Nothing already on
                file is overwritten — anything that disagrees is kept on this item so you can see
                both.
              </p>
              <form action={mergeIntake} className="mt-3">
                <input type="hidden" name="itemId" value={item.id} />
                <input type="hidden" name="candidateId" value={match?.candidateId ?? ""} />
                <button
                  type="submit"
                  disabled={!match?.candidateId}
                  className="w-full rounded border border-rule-strong px-3 py-1.5 text-[12.5px] font-medium disabled:opacity-40"
                >
                  Merge
                </button>
                {!match?.candidateId && (
                  <span className="mt-1 block text-[11px] text-ink-faint">Nothing to merge into.</span>
                )}
              </form>
            </Card>

            <Card className="flex flex-col p-4">
              <h3 className="text-[13px] font-medium">Throw it out</h3>
              <p className="mt-1 flex-1 text-[12px] leading-relaxed text-ink-soft">
                Not a CV, or not somebody we want on the database. The item stays, so the count of
                what arrived is still true.
              </p>
              <form action={rejectIntake} className="mt-3 grid gap-2">
                <input type="hidden" name="itemId" value={item.id} />
                <input
                  name="note"
                  placeholder="Why"
                  className="w-full rounded border border-rule bg-paper px-2 py-1.5 text-[12.5px]"
                />
                <button
                  type="submit"
                  className="rounded border border-rule-strong px-3 py-1.5 text-[12.5px] font-medium"
                >
                  Reject
                </button>
              </form>
            </Card>
          </div>
        </section>
      )}

      {/* ── The file ────────────────────────────────────────────────────── */}
      <section>
        <h2 className="mb-3 text-[13.5px] font-semibold">The text it was read from</h2>
        <Card className="max-h-[300px] overflow-auto p-4">
          <pre className="whitespace-pre-wrap font-mono text-[11.5px] leading-relaxed text-ink-soft">
            {item.rawText ?? "Nothing extractable."}
          </pre>
        </Card>
      </section>
    </main>
  );
}
