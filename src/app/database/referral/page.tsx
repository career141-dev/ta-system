import Link from "next/link";
import { Suspense } from "react";
import { colomboGreeting } from "@/lib/calendar";
import { pageUser } from "@/lib/session";
import { primeStore } from "@/data/prime";
import { isConvex } from "@/data/mode";
import { DbTabs } from "@/components/db/DbTabs";
import { ReferralCard } from "@/components/db/ReferralCard";
import { ReferralSearchBox } from "@/components/db/ReferralSearchBox";
import { CopyButton } from "@/components/db/CopyButton";
import { referralSearch } from "@/lib/referralSearch";
import { findByNames, type HeldCv, type NameCheck } from "@/lib/nameCheck";
import { nameList } from "@/lib/nameMatch";

type Params = Record<string, string | string[] | undefined>;

const EXAMPLES = [
  "HR Managers at Dialog",
  "General Managers in retail companies",
  "Contact details of referees from FMCG companies",
  "Finance Directors at Hemas",
  "References from Cargills",
];

const one = (v: string | string[] | undefined) => (typeof v === "string" ? v : "");
const many = (v: string | string[] | undefined) => (Array.isArray(v) ? v : v ? [v] : []);

/**
 * Referral Search — the referees named on the CVs in the database (8 Oct).
 *
 * Recruiters use these for two things: a way into a company ("who are the HR
 * managers at Dialog?") and a number for someone they are checking. The box
 * takes a sentence; what Claude understood by it is shown as chips above the
 * list, and any title or company can be taken off without asking again.
 */
export default async function ReferralSearchPage({ searchParams }: { searchParams: Promise<Params> }) {
  const sp = await searchParams;
  await primeStore();
  const user = await pageUser("database.read");
  // Up to 4,000 characters: a pasted list of names is long. A question is still
  // cut to 500 before a model reads it (see Results).
  const q = one(sp.q).trim().slice(0, 4000);
  const drop = many(sp.x).slice(0, 30);
  // "Not names — search it as a question": for a company list that reads as names.
  const asQuestion = one(sp.as) === "search";

  return (
    <main className="mx-auto max-w-[760px] px-4 pb-24 pt-8 sm:px-6">
      <DbTabs active="referral" />
      <h1 className="text-center text-[26px] font-semibold tracking-tight">
        {colomboGreeting()}, {user.name}
      </h1>
      <p className="mb-6 mt-1.5 text-center text-[13px] text-ink-soft">
        Find the referees named on CVs — by title, by company, or both. Ask the way you would ask a colleague.
      </p>

      <ReferralSearchBox defaultValue={q} autoFocus={!q} />

      {!q && (
        <ul className="mt-4 flex flex-wrap justify-center gap-1.5">
          {EXAMPLES.map((e) => (
            <li key={e}>
              <Link
                href={`/database/referral?q=${encodeURIComponent(e)}`}
                className="inline-block rounded-full border border-rule bg-surface px-3 py-1.5 text-[12px] text-ink-soft transition-colors hover:border-brand-line hover:text-brand"
              >
                {e}
              </Link>
            </li>
          ))}
        </ul>
      )}

      {q && (
        <Suspense
          key={`${q}|${drop.join("|")}|${asQuestion}`}
          fallback={
            <div className="mt-8 rounded-xl border border-rule bg-surface px-8 py-14 text-center" role="status" aria-live="polite">
              <p className="text-[14px] font-medium">Searching for “{q.replace(/\s+/g, " ").slice(0, 80)}”</p>
              <p className="mt-1.5 text-[12px] text-ink-faint">A new search can take several seconds; the same search again is instant.</p>
            </div>
          }
        >
          <Results q={q} drop={drop} email={user.email} asQuestion={asQuestion} />
        </Suspense>
      )}
    </main>
  );
}

const STATUS = {
  in: { label: "In our system", tone: "bg-brand-soft text-brand" },
  maybe: { label: "Maybe — similar name", tone: "bg-warn-soft text-warn" },
  none: { label: "Not found", tone: "bg-tag text-ink-faint" },
} as const;

const HOW = { same: "Same name", likely: "Same name, fuller or shorter form", maybe: "Similar name — check it is them" } as const;

/** A pasted list of names, and whether we hold a CV for each. */
function NameCheckList({ q, checks, quiet = false }: { q: string; checks: NameCheck[]; quiet?: boolean }) {
  const count = (s: NameCheck["status"]) => checks.filter((c) => c.status === s).length;
  const missing = checks.filter((c) => c.status === "none").map((c) => c.name);
  const asQuestion = `/database/referral?${new URLSearchParams({ q, as: "search" }).toString()}`;
  return (
    <section className="mt-6">
      {!quiet && <div className="flex flex-wrap items-center gap-x-4 gap-y-1 rounded-xl border border-rule bg-surface px-5 py-4">
        <p className="text-[14px] font-medium">
          <span className="tabular">{checks.length}</span> names · <span className="tabular text-brand">{count("in")}</span> in our system
          {count("maybe") > 0 && <> · <span className="tabular">{count("maybe")}</span> maybe</>} · <span className="tabular">{count("none")}</span> not found
        </p>
        {missing.length > 0 && (
          <span className="ml-auto flex items-center gap-1 text-[12px] text-ink-faint">
            Not found <CopyButton text={missing.join("\n")} label="the names not found" />
          </span>
        )}
        <p className="basis-full text-[11.5px] text-ink-faint">
          A match is by name only. Open the CV to check it is the same person.{" "}
          <Link href={asQuestion} className="text-accent hover:underline">Not names? Search it as a question</Link>
        </p>
      </div>}
      <ul className={`${quiet ? "" : "mt-4 "}flex flex-col gap-2.5`}>
        {checks.map((c) => (
          <li key={c.name} className="rounded-xl border border-rule bg-surface px-5 py-3.5">
            <div className="flex flex-wrap items-center gap-2.5">
              <span className={`rounded-full px-2.5 py-0.5 text-[11px] font-medium ${STATUS[c.status].tone}`}>{STATUS[c.status].label}</span>
              <p className="text-[14px] font-semibold">{c.name}</p>
            </div>
            {c.matches.length > 0 && (
              <ul className="mt-2 flex flex-col gap-1.5 border-t border-rule/70 pt-2">
                {c.matches.map((m) => (
                  <li key={m.id} className="text-[12.5px]">
                    <Link href={`/candidates/${m.id}`} className="font-medium text-brand hover:underline">{m.fullName}</Link>
                    <span className="text-ink-faint">
                      {" "}
                      {[[m.title, m.employer].filter(Boolean).join(" at "), m.location].filter(Boolean).join(" · ")}
                    </span>
                    <span className="ml-2 text-[11.5px] text-ink-soft">— {HOW[m.how]}</span>
                  </li>
                ))}
              </ul>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}

async function Results({ q, drop, email, asQuestion }: { q: string; drop: string[]; email: string; asQuestion: boolean }) {
  if (!isConvex()) {
    return (
      <p className="mt-8 rounded-xl border border-rule bg-surface px-6 py-10 text-center text-[13px] text-ink-soft">
        Referral Search reads the live referee table, so it needs the backend. It is not available in this local mode.
      </p>
    );
  }

  let actorId: string | null = null;
  try {
    const { convexActorForEmail } = await import("@/lib/convexServer");
    actorId = (await convexActorForEmail(email))?._id ?? null;
  } catch {
    // Reads go without an actor (convex/ta/guard optionalActor).
  }

  // A pasted list of names is a different question: who of these do we hold?
  const names = asQuestion ? null : nameList(q);
  let own: NameCheck[] = [];
  if (names) {
    try {
      own = await findByNames(names, actorId);
    } catch (e) {
      console.warn("[referral-search] name check failed:", (e as Error)?.message);
      return (
        <p className="mt-8 rounded-xl border border-rule bg-surface px-6 py-10 text-center text-[13px] text-ink-soft">
          Could not check the names just now. Try again in a moment.
        </p>
      );
    }
    if (names.length >= 2) return <NameCheckList q={q} checks={own} />;
  }

  let a;
  try {
    // A question is read by a model: still at most 500 characters of it.
    a = await referralSearch(q.slice(0, 500), drop, actorId);
  } catch (e) {
    console.warn("[referral-search] failed:", (e as Error)?.message);
    return (
      <p className="mt-8 rounded-xl border border-rule bg-surface px-6 py-10 text-center text-[13px] text-ink-soft">
        Could not search the referees just now. Try again in a moment.
      </p>
    );
  }

  // Beside each referee: do we hold a CV for someone with this name? A prompt to
  // open the CV and look, not a claim that it is them. A failed lookup shows none.
  const held = new Map<string, HeldCv[]>();
  try {
    for (const c of await findByNames(a.people.map((p) => p.name), actorId, { loose: false })) held.set(c.name, c.matches);
  } catch (e) {
    console.warn("[referral-search] referee name check failed:", (e as Error)?.message);
  }

  const here = (left: string[]) => {
    const p = new URLSearchParams({ q });
    for (const x of left) p.append("x", x);
    return `/database/referral?${p.toString()}`;
  };
  const gone = new Set(drop.map((d) => d.toLowerCase()));
  const chips = [
    ...a.criteria.designations.map((t) => ({ t, kind: "Title" })),
    ...a.criteria.companies.map((t) => ({ t, kind: "Company" })),
  ];
  const left = chips.filter(({ t }) => !gone.has(t.toLowerCase())).length;
  const noQuestion = !left && !a.criteria.name && !a.criteria.loose;

  return (
    <section className="mt-6">
      {names && names.length === 1 && own[0]?.status !== "none" && (
        <div className="mb-5">
          <p className="mb-2 text-[11.5px] text-ink-faint">Do we hold a CV for this name?</p>
          <NameCheckList q={q} checks={own} quiet />
        </div>
      )}
      <div className="rounded-xl border border-rule bg-surface px-5 py-4">
        <p className="text-[11.5px] text-ink-faint">
          Searching for
          {a.via === "words" && " (read from the words alone — the assistant was unavailable, so titles and industries are not expanded)"}
        </p>
        <p className="mt-0.5 text-[14px] font-medium">{a.summary}</p>
        {chips.length > 0 && (
          <ul className="mt-3 flex flex-wrap gap-1.5">
            {chips.map(({ t, kind }) => {
              const off = gone.has(t.toLowerCase());
              return (
                <li key={`${kind}:${t}`}>
                  {off ? (
                    <Link href={here(drop.filter((d) => d.toLowerCase() !== t.toLowerCase()))} className="inline-flex items-center gap-1.5 rounded-full border border-dashed border-rule px-2.5 py-1 text-[11.5px] text-ink-faint line-through hover:text-ink">
                      {t}
                    </Link>
                  ) : (
                    <span className="inline-flex items-center gap-1.5 rounded-full border border-rule bg-tag px-2.5 py-1 text-[11.5px] text-ink-soft">
                      <span className="text-ink-faint">{kind}:</span> {t}
                      <Link href={here([...drop, t])} aria-label={`Leave out ${t}`} title="Leave this out" className="text-ink-faint hover:text-ink">✕</Link>
                    </span>
                  )}
                </li>
              );
            })}
          </ul>
        )}
        {a.criteria.industry && !(a.criteria.companies[0] && q.toLowerCase().includes(a.criteria.companies[0].toLowerCase())) && (
          <p className="mt-2.5 text-[11.5px] leading-relaxed text-ink-faint">
            Companies for “{a.criteria.industry}” are the assistant&rsquo;s best list, not a record of what the database holds. Take any off with ✕, or search a company by name.
          </p>
        )}
      </div>

      {a.titleMissed && (
        <p className="mt-4 rounded-lg bg-brand-soft px-4 py-3 text-[12.5px] leading-relaxed text-brand">
          Nobody with that title at those companies. Showing everyone named from them instead.
        </p>
      )}

      {a.total === 0 ? (
        <div className="mt-4 rounded-xl border border-rule bg-surface px-8 py-14 text-center">
          <p className="text-[14px] font-medium">{noQuestion ? "Nothing to search for" : "No referees found"}</p>
          <p className="mx-auto mt-1.5 max-w-[52ch] text-[12.5px] leading-relaxed text-ink-faint">
            {noQuestion
              ? "Every title and company has been left out. Search again."
              : a.criteria.designations.length && a.criteria.companies.length
                ? "Try the company alone to see everyone named from it, or a broader title."
                : "Try a shorter search, another spelling, or the company's usual name."}
          </p>
        </div>
      ) : (
        <>
          <p className="mb-3 mt-5 text-[12.5px] text-ink-soft">
            <span className="tabular font-medium text-ink">{a.total.toLocaleString()}</span> {a.total === 1 ? "person" : "people"}
            {a.total > a.people.length && ` — the best ${a.people.length} shown; narrow the search to see the rest`}
            {a.deep && a.total <= a.people.length && " — a very common title, so add a company to be sure nobody is missed"}
          </p>
          <ul className="flex flex-col gap-3">
            {a.people.map((p) => (
              <ReferralCard key={p.id} p={p} cvs={held.get(p.name) ?? []} />
            ))}
          </ul>
        </>
      )}
    </section>
  );
}
