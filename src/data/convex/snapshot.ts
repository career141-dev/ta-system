/**
 * A short-lived in-process cache in front of the backend.
 *
 * The reason this exists, rather than each `repo` method making its own call:
 * a single page asks for the same small tables over and over. The openings
 * list reads every user to name owners, the candidate drawer reads the
 * opening, the client and the assignments, and a list of fifty rows asks for
 * fifty candidates. The JSON store answered all of that from memory. Turning
 * each lookup into its own HTTP round trip would make the app slower than the
 * thing it replaces, which would be a strange way to fix a performance problem.
 *
 * So: small tables are fetched WHOLE, once, and held for a moment. Large ones
 * are fetched by id, in batches, and the ids already seen are remembered.
 *
 * ── Why a TTL and not a per-request store ──────────────────────────────────
 *
 * React's `cache()` scopes exactly to one request, which would be the precise
 * tool — but this module is also imported by scripts and tests that never run
 * inside a request, where `cache()` gives no dedup at all. A short TTL behaves
 * correctly in all three settings and is simple enough to reason about: inside
 * one render everything hits the cache, and a second render a moment later
 * re-reads.
 *
 * The TTL is deliberately shorter than a person can perceive. It is a
 * within-render optimisation, not a data cache, and it must never be the
 * reason somebody saves a change and does not see it — which is why every
 * write calls `invalidate()`.
 */

/** Long enough to cover one render, short enough that nothing reads stale. */
const TTL_MS = Number(process.env.C141_SNAPSHOT_TTL_MS ?? "") || 1_000;

interface Entry<T> {
  at: number;
  value: Promise<T>;
}

const whole = new Map<string, Entry<unknown>>();
const byId = new Map<string, Map<string, unknown>>();
let generation = 0;

/**
 * Drop everything cached.
 *
 * Called by every write. Blunt on purpose: working out which tables a write
 * touched is a second model of the data that can disagree with the first, and
 * the tables are small enough that re-reading costs less than being wrong.
 */
export function invalidate(): void {
  whole.clear();
  byId.clear();
  generation++;
}

/** The generation counter, so derived indexes can tell when to rebuild. */
export function version(): number {
  return generation;
}

/**
 * A whole table, fetched once per TTL window.
 *
 * Only for tables small enough that reading all of them is cheaper than
 * reading some of them repeatedly — users, clients, openings, job posts,
 * assignments. Never for candidates.
 */
export function table<T>(key: string, load: () => Promise<T>): Promise<T> {
  const hit = whole.get(key) as Entry<T> | undefined;
  if (hit && Date.now() - hit.at < TTL_MS) return hit.value;

  const value = load().catch((e) => {
    // A failed read must not be cached — otherwise one blip becomes a
    // TTL-long outage for every caller behind it.
    whole.delete(key);
    throw e;
  });
  whole.set(key, { at: Date.now(), value: value as Promise<unknown> });
  return value;
}

/**
 * Rows by id, fetching only the ones not already seen.
 *
 * `load` is handed just the missing ids, so asking for fifty candidates when
 * forty are already in hand costs one request for ten. Ids that come back
 * absent are remembered as absent, so a missing row is not re-requested on
 * every pass.
 */
export async function rows<T>(
  key: string,
  ids: string[],
  load: (missing: string[]) => Promise<Map<string, T>>,
): Promise<Map<string, T>> {
  let seen = byId.get(key) as Map<string, T | null> | undefined;
  if (!seen) {
    seen = new Map();
    byId.set(key, seen as Map<string, unknown>);
  }

  const missing = [...new Set(ids)].filter((id) => !seen!.has(id));
  if (missing.length > 0) {
    const fetched = await load(missing);
    for (const id of missing) seen.set(id, fetched.get(id) ?? null);
  }

  const out = new Map<string, T>();
  for (const id of ids) {
    const v = seen.get(id);
    if (v != null) out.set(id, v);
  }
  return out;
}

/** One row by id, through the same cache as a batch. */
export async function row<T>(
  key: string,
  id: string,
  load: (missing: string[]) => Promise<Map<string, T>>,
): Promise<T | null> {
  const got = await rows<T>(key, [id], load);
  return got.get(id) ?? null;
}

/** For tests: forget everything, including the generation counter. */
export function _reset(): void {
  whole.clear();
  byId.clear();
  generation = 0;
}
