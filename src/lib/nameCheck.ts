import "server-only";

/**
 * Do we hold a CV for this name? (Referral Search, 29 Oct)
 *
 * Two uses: a TA pastes a list of names and wants to know who is already in the
 * database, and a referee's card says "we have a CV for someone with this name —
 * maybe them". Both ask the database's own name search (`ta/candidates:quickSearch`,
 * the same one `/search` uses: it leaves out merged people and lost CV files),
 * then grade what comes back with `nameMatch`, so a hit that only shares a first
 * name or a job title is dropped.
 *
 * A failed search throws. "Not found" must mean it was looked for and is not
 * there, not that the lookup broke.
 */
import { convexQuery } from "@/lib/convexServer";
import { primeStore } from "@/data/prime";
import { repo } from "@/data/store";
import { nameMatch, nameWords, type NameMatch } from "@/lib/nameMatch";

export type HeldCv = {
  id: string;
  fullName: string;
  title: string | null;
  employer: string | null;
  location: string | null;
  how: NameMatch;
};

export type NameCheck = {
  name: string;
  /** in: the same name or an obvious form of it; maybe: a close spelling; none: nobody. */
  status: "in" | "maybe" | "none";
  matches: HeldCv[];
};

const KEEP_MS = 5 * 60_000;
const KEEP_MAX = 500;
const WIDE = 6;
const ids = new Map<string, { at: number; p: Promise<string[]> }>();

async function lookup(name: string, actorId: string | null, loose: boolean): Promise<string[]> {
  const ask = (q: string) => convexQuery<string[]>("ta/candidates:quickSearch", { ...(actorId ? { actorId } : {}), q, limit: 10 });
  const found = await ask(name);
  if (found.length || !loose) return found;
  // A first name or a surname spelt differently finds nobody as a whole, but
  // each word alone still finds the person; nameMatch then judges them.
  const words = nameWords(name).filter((w) => w.length >= 3);
  const parts = await Promise.all([...new Set([words[0], words[words.length - 1]])].filter(Boolean).map(ask));
  return [...new Set(parts.flat())];
}

function idsFor(name: string, actorId: string | null, loose: boolean): Promise<string[]> {
  const k = `${loose ? "loose" : "exact"}|${nameWords(name).sort().join(" ")}`;
  const held = ids.get(k);
  if (held && Date.now() - held.at < KEEP_MS) return held.p;
  const p = lookup(name, actorId, loose);
  ids.set(k, { at: Date.now(), p });
  p.catch(() => ids.delete(k));
  while (ids.size > KEEP_MAX) ids.delete(ids.keys().next().value!);
  return p;
}

const RANK: Record<NameMatch, number> = { same: 0, likely: 1, maybe: 2 };

/**
 * `loose` also tries each word of a name alone when the whole finds nobody, so a
 * misspelt name is still found. A pasted list wants that; the line under each
 * referee does not (up to sixty names, so it stays to the one indexed search).
 */
export async function findByNames(names: string[], actorId: string | null, { loose = true } = {}): Promise<NameCheck[]> {
  const found: string[][] = [];
  for (let i = 0; i < names.length; i += WIDE) {
    found.push(...(await Promise.all(names.slice(i, i + WIDE).map((n) => idsFor(n, actorId, loose)))));
  }
  const all = [...new Set(found.flat())];
  if (all.length) await primeStore({ candidateIds: all });

  return names.map((name, i) => {
    const matches: HeldCv[] = [];
    for (const id of found[i]) {
      const c = repo.candidate(id);
      const how = c ? nameMatch(name, c.fullName) : null;
      if (c && how) {
        matches.push({ id: c.id, fullName: c.fullName, title: c.currentTitle, employer: c.currentEmployer, location: c.location, how });
      }
    }
    matches.sort((a, b) => RANK[a.how] - RANK[b.how]);
    const status = matches.some((m) => m.how !== "maybe") ? "in" : matches.length ? "maybe" : "none";
    return { name, status, matches: matches.slice(0, 3) };
  });
}
