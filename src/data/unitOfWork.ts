/**
 * What one write changed, as the rows the database has to change.
 *
 * The store's write methods edit the in-memory tables directly — that is how
 * the rules were written and tested. To save that to Convex, the tables are
 * copied before the write, compared after it, and every row that appeared,
 * disappeared or differs becomes one operation. The operations go to Convex as
 * a single transaction (convex/ta/commit.ts), which refuses the lot if any
 * field the write changed has meanwhile been changed by someone else.
 *
 * Pure: no I/O, so the diff is tested on its own (tests/unitOfWork.test.ts).
 */

import type { Database } from "./types";

export interface CommitOp {
  table: string;
  kind: "insert" | "update" | "delete";
  key: string;
  before?: Record<string, unknown>;
  after?: Record<string, unknown>;
  changed?: string[];
}

type Row = Record<string, unknown>;
type Tables = Record<string, Row[]>;

/** How each table's rows are identified. Everything else is keyed by `id`. */
const KEYS: Record<string, (row: Row) => string> = {
  settings: (r) => String(r.key),
  matchExclusions: (r) => `${r.openingId}:${r.candidateId}`,
};
const keyOf = (table: string, row: Row) => (KEYS[table] ? KEYS[table](row) : String(row.id));

/** Tables that exist only in the JSON store and are never saved to Convex. */
const LOCAL_ONLY = new Set(["liveMirror"]);

/** A deep copy of the tables, to compare against after the write. */
export function snapshotTables(db: Database): Tables {
  const out: Tables = {};
  for (const [table, rows] of Object.entries(db)) {
    if (LOCAL_ONLY.has(table) || !Array.isArray(rows)) continue;
    out[table] = structuredClone(rows) as Row[];
  }
  return out;
}

/** Put the tables back as they were — a refused save must not leave its edits in memory. */
export function restoreTables(db: Database, before: Tables): void {
  for (const [table, rows] of Object.entries(before)) {
    (db as unknown as Tables)[table] = rows;
  }
}

function same(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === undefined) return b === null;
  if (b === undefined) return a === null;
  if (typeof a !== typeof b || a === null || b === null || typeof a !== "object") return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a)) {
    const bb = b as unknown[];
    return a.length === bb.length && a.every((x, i) => same(x, bb[i]));
  }
  const ao = a as Row;
  const bo = b as Row;
  const keys = new Set([...Object.keys(ao), ...Object.keys(bo)]);
  for (const k of keys) if (!same(ao[k], bo[k])) return false;
  return true;
}

/** Every row inserted, deleted or changed between two versions of the tables. */
export function diffTables(before: Tables, db: Database): CommitOp[] {
  const ops: CommitOp[] = [];
  for (const [table, oldRows] of Object.entries(before)) {
    const newRows = ((db as unknown as Tables)[table] ?? []) as Row[];
    const was = new Map(oldRows.map((r) => [keyOf(table, r), r]));
    const now = new Map(newRows.map((r) => [keyOf(table, r), r]));
    for (const [key, row] of now) {
      const old = was.get(key);
      if (!old) {
        ops.push({ table, kind: "insert", key, after: row });
        continue;
      }
      if (old === row && same(old, row)) continue;
      const changed = [...new Set([...Object.keys(old), ...Object.keys(row)])].filter((f) => !same(old[f], row[f]));
      if (changed.length > 0) ops.push({ table, kind: "update", key, before: old, after: row, changed });
    }
    for (const [key, row] of was) {
      if (!now.has(key)) ops.push({ table, kind: "delete", key, before: row });
    }
  }
  return ops;
}

/**
 * Replace temporary ids with the ones the database assigned, everywhere they
 * appear — the new row's own id and any reference to it in another row.
 */
export function renameIds(db: Database, ids: Record<string, string>): void {
  if (Object.keys(ids).length === 0) return;
  const swap = (value: unknown): unknown => {
    if (typeof value === "string") return ids[value] ?? value;
    if (Array.isArray(value)) {
      for (let i = 0; i < value.length; i++) value[i] = swap(value[i]);
      return value;
    }
    if (value && typeof value === "object") {
      const o = value as Row;
      for (const k of Object.keys(o)) o[k] = swap(o[k]);
      return o;
    }
    return value;
  };
  for (const [table, rows] of Object.entries(db)) {
    if (LOCAL_ONLY.has(table) || !Array.isArray(rows)) continue;
    for (const row of rows) swap(row);
  }
}

/** A refused save, in words a person can act on. */
export function describeCommitError(message: string): string {
  const conflict = message.match(/conflict:([^:]+):([^:]+):([^:]+):/);
  if (conflict) {
    return "Someone else changed this record a moment ago, so your change was not saved. Reload the page and try again.";
  }
  return `Your change was not saved: ${message.replace(/^Convex refused [^:]+:\s*/, "").replace(/^Uncaught Error:\s*/, "").slice(0, 240)}`;
}
