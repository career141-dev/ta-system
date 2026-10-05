import Link from "next/link";
import { colomboGreeting } from "@/lib/calendar";
import { repo } from "@/data/store";
import { pageUser } from "@/lib/session";
import { SearchBox } from "@/components/db/SearchBox";
import { Suggestion } from "@/components/db/Suggestion";
import { Illustration } from "@/components/db/Illustration";
import { deleteSearch } from "@/app/actions";
import { SubmitButton } from "@/components/Submit";
import { relDays } from "@/lib/format";
import { primeStore } from "@/data/prime";
import { isConvex } from "@/data/mode";
import { databaseShelf } from "@/lib/retrieve";

/**
 * The Database, before you have asked it anything — spec §6D.1.
 *
 * Laid out like Recruiter's assisted-search home: a scene, the greeting, one
 * box, and a written-out suggestion you can take as it stands. Everything else
 * is below the fold on purpose — the box is the page.
 */
export default async function DatabaseHome({
  searchParams,
}: {
  searchParams: Promise<{ q?: string }>;
}) {
  await primeStore({ allApplications: true });
  // A link that carries a query has to run it. The intake screen's "find this
  // person in the database" arrived here with ?q= and dropped the visitor on
  // an empty box, looking like the link was broken.
  const { q } = await searchParams;
  const user = await pageUser("database.read");
  // Backed by Convex the working set holds only what this page primed, so
  // `repo.candidates()` is not the database. The count and the words come from
  // the backend, which can answer both without handing over 77,000 people.
  const shelf = isConvex() ? await databaseShelf() : null;
  const local = repo.candidates();
  const vocab = shelf
    ? { titles: shelf.titles.map((t) => t.title), skills: shelf.skills, industries: shelf.industries, cities: shelf.cities, employers: shelf.employers, qualifications: [], languages: [], nationalities: [] }
    : repo.vocabulary();
  const candidates = shelf ? [] : local;

  // Read saved searches from Convex DB (persists across restarts) in Convex
  // mode, and from the in-memory file store otherwise.
  let saved: { id: string; name: string; query: string; mode: "natural" | "boolean" | "meaning"; ownerId: string; openingId: string | null; createdAt: number; lastRunAt: number | null; lastResultCount: number | null; mine?: boolean }[] = [];
  if (isConvex()) {
    try {
      const { convexActorForEmail, convexQuery } = await import("@/lib/convexServer");
      const actor = await convexActorForEmail(user.email);
      if (actor) {
        saved = await convexQuery<typeof saved>("ta/search:savedSearches", { actorId: actor._id });
      }
    } catch {
      // Non-fatal — if Convex is unreachable, show an empty list rather than crashing.
      saved = [];
    }
  } else {
    saved = repo.savedSearches().map((s) => ({ ...s, mine: s.ownerId === user.id }));
  }
  const mine = saved.filter((s) => s.mine !== false && (s.ownerId === user.id || s.mine === true));
  const others = saved.filter((s) => s.mine === false || (s.ownerId !== user.id && s.mine !== true));
  const users = repo.users();

  const greeting = colomboGreeting();

  const counts = candidates.reduce<Record<string, number>>((acc, c) => {
    if (c.currentTitle) acc[c.currentTitle] = (acc[c.currentTitle] ?? 0) + 1;
    return acc;
  }, {});
  const topTitles: [string, number][] = shelf
    ? shelf.titles.slice(0, 10).map((t) => [t.title, t.count])
    : (Object.entries(counts).sort((a, b) => b[1] - a[1]).slice(0, 10) as [string, number][]);

  // Written-out searches, built from the database's own vocabulary so each one
  // is a search that returns people rather than a plausible-looking sentence.
  const skillsByTitle = new Map<string, string[]>();
  for (const c of shelf ? [] : candidates) {
    if (!c.currentTitle) continue;
    const have = skillsByTitle.get(c.currentTitle) ?? [];
    skillsByTitle.set(c.currentTitle, [...new Set([...have, ...c.skills])]);
  }
  const cities = (vocab.cities.length ? vocab.cities : ["Colombo"]).slice(0, 6);
  const prompts = topTitles.slice(0, 6).map(([title], i) => {
    const sk = skillsByTitle.get(title) ?? [];
    const a = sk[i % Math.max(sk.length, 1)];
    const b = sk[(i + 3) % Math.max(sk.length, 1)];
    const city = cities[i % cities.length];
    return a && b && a !== b
      ? `A ${title} in ${city} with mastery in ${a} and proven experience in ${b}.`
      : `A ${title} in ${city} with at least ${5 + i} years behind them.`;
  });

  // Only meaningful over a database held in memory. Backed by Convex these
  // would each be a whole-table scan, and a wrong number is worse than none,
  // so the line is left off rather than filled with a count of the page's own
  // working set.
  const freshMonth = shelf ? null : candidates.filter((c) => Date.now() - c.createdAt < 30 * 86_400_000).length;
  const onNoOpening = shelf ? null : candidates.filter((c) => repo.applicationsForCandidate(c.id).length === 0).length;

  return (
    <main className="mx-auto max-w-[720px] px-4 sm:px-6 pb-24 pt-8">
      <Illustration />

      <h1 className="mt-5 text-center text-[28px] font-semibold tracking-tight">
        {greeting}, {user.name}
      </h1>
      <p className="mb-7 mt-1.5 text-center text-[13px] text-ink-soft">
        <span className="tabular">{(shelf?.total ?? candidates.length).toLocaleString()}</span>{shelf?.sampled ? "+" : ""} CVs in the database
      </p>

      <SearchBox initialQuery={q ?? ""}
        vocab={[...vocab.titles, ...vocab.skills, ...vocab.industries, ...vocab.cities, ...vocab.employers]}
        autoFocus
      />
      <Suggestion lines={prompts} />

      <div className="mt-12 flex flex-col gap-9">
        <section>
          <h2 className="mb-3 text-[13px] font-semibold">Your saved searches</h2>
          <div className="overflow-hidden rounded-xl border border-rule bg-surface">
            {mine.length === 0 ? (
              <p className="px-5 py-7 text-center text-[12.5px] leading-relaxed text-ink-faint">
                None yet. Run a search you would repeat, then save it from the results.
              </p>
            ) : (
              <ul className="divide-y divide-rule">
                {mine.map((s) => (
                  <li key={s.id} className="flex items-start gap-3 px-5 py-3.5">
                    <Link
                      href={`/database/results?q=${encodeURIComponent(s.query)}${s.mode !== "natural" ? `&mode=${s.mode}` : ""}${s.openingId ? `&for=${s.openingId}` : ""}`}
                      className="min-w-0 flex-1"
                    >
                      <p className="text-[13px] font-medium hover:underline">{s.name}</p>
                      <p className="mt-0.5 truncate text-[11.5px] text-ink-faint">{s.query}</p>
                      <p className="mt-0.5 text-[11px] text-ink-faint">
                        {s.lastResultCount !== null ? `${s.lastResultCount} results · ` : ""}
                        {s.lastRunAt ? `run ${relDays(s.lastRunAt)}` : "never run"}
                      </p>
                    </Link>
                    <form action={deleteSearch}>
                      <input type="hidden" name="searchId" value={s.id} />
                      <SubmitButton tone="dark" title="Delete" className="rounded px-1.5 py-0.5 text-[12px] text-ink-faint hover:bg-tag hover:text-ink disabled:opacity-60">
                        ✕
                      </SubmitButton>
                    </form>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </section>

        {others.length > 0 && (
          <section>
            <h2 className="mb-3 text-[13px] font-semibold">Saved by the team</h2>
            <ul className="divide-y divide-rule overflow-hidden rounded-xl border border-rule bg-surface">
              {others.map((s) => (
                <li key={s.id}>
                  <Link
                    href={`/database/results?q=${encodeURIComponent(s.query)}${s.openingId ? `&for=${s.openingId}` : ""}`}
                    className="block px-5 py-3.5"
                  >
                    <p className="text-[13px] font-medium hover:underline">{s.name}</p>
                    <p className="mt-0.5 truncate text-[11.5px] text-ink-faint">{s.query}</p>
                    <p className="mt-0.5 text-[11px] text-ink-faint">
                      {users.find((u) => u.id === s.ownerId)?.name}
                      {s.openingId ? ` · ${repo.opening(s.openingId)?.title}` : ""}
                    </p>
                  </Link>
                </li>
              ))}
            </ul>
          </section>
        )}

        <section>
          <h2 className="mb-3 text-[13px] font-semibold">Browse by title</h2>
          <ul className="flex flex-wrap gap-1.5">
            {topTitles.map(([t, n]) => (
              <li key={t}>
                <Link
                  href={`/database/results?q=${encodeURIComponent(t)}`}
                  className="inline-flex items-center gap-1.5 rounded-full border border-rule bg-surface px-3 py-1.5 text-[12px] text-ink-soft transition-colors hover:border-brand-line hover:text-brand"
                >
                  {t}
                  <span className="tabular text-[11px] text-ink-faint">{n}</span>
                </Link>
              </li>
            ))}
          </ul>
          {freshMonth !== null && onNoOpening !== null && (
            <p className="mt-4 text-[11.5px] leading-relaxed text-ink-faint">
              <span className="tabular">{freshMonth.toLocaleString()}</span> added in the last 30 days ·{" "}
              <span className="tabular">{onNoOpening.toLocaleString()}</span> on no opening at all
            </p>
          )}
        </section>
      </div>
    </main>
  );
}
