// convex/lib/cronCursor.ts
//
// Where a capped background job got to, so its next run carries on from there.
//
// The follow-up sweep, the SLA check and the stuck-upload requeue each read a
// fixed number of rows per run, oldest first. Rows the job then passed over —
// a flagged application, a CV that can never be read — kept those places for
// ever, and everything behind them was never reached (2 Oct). Each now keeps
// the `_creationTime` of the last row it read, and starts the next run after
// it; once a run reads fewer rows than it asked for, it has reached the end
// and the next run starts again from the oldest.
//
// Stored in `taSettings` under `cron.<name>`; no schema change.

type Ctx = { db: any };

const keyOf = (name: string) => `cron.${name}`;

/** The saved position, or null to start from the oldest row. */
export async function readCursor(ctx: Ctx, name: string): Promise<string | null> {
  const row = await ctx.db
    .query("taSettings")
    .withIndex("by_key", (q: any) => q.eq("key", keyOf(name)))
    .first();
  return row?.value ? row.value : null;
}

export async function writeCursor(ctx: Ctx, name: string, value: string | null): Promise<void> {
  const key = keyOf(name);
  const row = await ctx.db
    .query("taSettings")
    .withIndex("by_key", (q: any) => q.eq("key", key))
    .first();
  const stored = value ?? "";
  if (row) {
    if (row.value !== stored) await ctx.db.patch(row._id, { value: stored, updatedAt: Date.now() });
  } else if (value !== null) {
    await ctx.db.insert("taSettings", { key, value: stored, updatedAt: Date.now() });
  }
}

/**
 * The next position after reading `got` rows of `asked`: the last row's
 * creation time, or null (back to the oldest) when the read came up short.
 */
export function nextCreationCursor(rows: { _creationTime: number }[], asked: number): string | null {
  return rows.length < asked || rows.length === 0 ? null : String(rows[rows.length - 1]._creationTime);
}

/** Where a walk over several lists got to: the list, and the last row read in it. */
export type WindowCursor = { key: string; after: number };

/**
 * The next `budget` rows across several lists read in order — each opening's
 * stage, for the follow-up sweep — carrying on from `cursor`.
 *
 * `read(key, after, n)` returns up to `n` rows of list `key` created after
 * `after`, oldest first; fewer than `n` means the list is finished. The
 * returned cursor is where the next run starts, null once every list has been
 * read to the end. A cursor naming a list that is no longer there (an opening
 * closed since) starts again from the first.
 *
 * ponytail: no wrap inside one run — a run that reaches the end stops there
 * and the next one starts from the top. Fine while a run is minutes apart.
 */
export async function readWindow<T extends { _creationTime: number }>(
  keys: string[],
  cursor: WindowCursor | null,
  budget: number,
  read: (key: string, after: number, n: number) => Promise<T[]>,
): Promise<{ rows: T[]; cursor: WindowCursor | null }> {
  let i = cursor ? keys.indexOf(cursor.key) : 0;
  let after = cursor && i >= 0 ? cursor.after : 0;
  if (i < 0) i = 0;
  const rows: T[] = [];
  while (i < keys.length && rows.length < budget) {
    const want = budget - rows.length;
    const got = await read(keys[i], after, want);
    rows.push(...got);
    if (got.length < want) {
      i++;
      after = 0;
    } else {
      after = got[got.length - 1]._creationTime;
    }
  }
  // Started part-way and found nothing left: go round from the top now
  // rather than spend a whole run reading nothing.
  if (rows.length === 0 && cursor) return readWindow(keys, null, budget, read);
  return { rows, cursor: i < keys.length ? { key: keys[i], after } : null };
}

export function parseWindowCursor(raw: string | null): WindowCursor | null {
  if (!raw) return null;
  try {
    const c = JSON.parse(raw);
    return typeof c?.key === "string" && typeof c?.after === "number" ? c : null;
  } catch {
    return null;
  }
}
