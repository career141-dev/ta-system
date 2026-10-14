// convex/ta/commit.ts
//
// One user action, written as one transaction.
//
// The TA platform's rules — the stage machine, the collision lock, set numbers,
// offers and placements — run in the app, against the rows it loaded. What
// they change is sent here as a list of row operations and applied in a single
// Convex mutation, which either writes all of it or none of it.
//
// Each update carries the values the rules saw. Before anything is written, the
// row as it is NOW is read back into the app's shape (./model/tables.ts) and
// every field the action changed is compared with what the action saw. If any
// differs — somebody else shortlisted the candidate a second earlier, the other
// app moved the stage — the whole commit is refused with the field that moved,
// and the app tells the person to reload rather than overwriting the other
// change. That is what makes two TAs reaching for one candidate safe.
//
// New rows arrive with the app's temporary ids. They are inserted first, in an
// order that puts a row after anything it refers to, and every later reference
// to a temporary id — in any field, at any depth — is rewritten to the real id.
// The map is returned so the app can rename them in memory.

import { v } from "convex/values";
import { internalMutation } from "../_generated/server";
import { resolveActor } from "../lib/auth";
import { TABLES, looselySame, sameValue, type ModelCx, type Row } from "./model/tables";
import { refreshEmployersText } from "../candidates/candidates";
import { assertWorkdayScope } from "../lib/workdayScope";
import { refreshWorkdayChecks } from "./workdays";
import type { Doc, Id } from "../_generated/dataModel";

const opValidator = v.object({
  table: v.string(),
  kind: v.union(v.literal("insert"), v.literal("update"), v.literal("delete")),
  /** The app's key: an id (temporary for inserts) or a natural key. */
  key: v.string(),
  before: v.optional(v.any()),
  after: v.optional(v.any()),
  /** The app fields this action changed (updates only). */
  changed: v.optional(v.array(v.string())),
});

export class CommitConflict extends Error {}

export const apply = internalMutation({
  args: { actorId: v.optional(v.string()), ops: v.array(opValidator) },
  handler: async (ctx, args): Promise<{ ids: Record<string, string> }> => {
    // Called only by the TA server with the admin key. A named actor is
    // checked to exist and be active; the app has already authorised the action.
    let actorUser: Doc<"users"> | null = null;
    if (args.actorId) {
      const { user } = await resolveActor(ctx, args.actorId);
      actorUser = user;
      const workTables = new Set(["applications", "linkVault", "researchReports", "benchmarks", "reviewRounds"]);
      const jobs = new Set<string>();
      for (const op of args.ops) {
        if (!workTables.has(op.table)) continue;
        const jobId = op.before?.openingId ?? op.after?.openingId;
        if (typeof jobId === "string" && ctx.db.normalizeId("jobs", jobId)) jobs.add(jobId);
      }
      for (const jobId of jobs) await assertWorkdayScope(ctx, user, jobId as Id<"jobs">);
    }

    const now = Date.now();
    const ids: Record<string, string> = {};
    // Temporary ids only: a settings key or an exclusion's "opening:candidate" is a
    // natural key, not a name waiting for the database to replace it.
    const temp = new Set(
      args.ops.filter((o) => o.kind === "insert" && TABLES[o.table]?.locate !== "by_key").map((o) => o.key),
    );

    const rename = (value: unknown): unknown => {
      if (typeof value === "string") {
        if (!temp.has(value)) return value;
        const real = ids[value];
        if (!real) throw new Error(`A new row refers to another new row (${value}) that has not been created.`);
        return real;
      }
      if (Array.isArray(value)) return value.map(rename);
      if (value && typeof value === "object") {
        return Object.fromEntries(Object.entries(value as Row).map(([k, x]) => [k, rename(x)]));
      }
      return value;
    };

    const cx: ModelCx = {
      now,
      get: async (id) => {
        const real = temp.has(id) ? ids[id] : id;
        if (!real) return null;
        const normal = normalize(ctx, real);
        return normal ? ((await ctx.db.get(normal as never)) as never) : null;
      },
    };

    // ── inserts, each after the new rows it refers to ────────────────────────
    const inserts = args.ops.filter((o) => o.kind === "insert");
    const pending = new Map(inserts.map((o) => [o.key, o]));
    const refersTo = (value: unknown, found: Set<string>) => {
      if (typeof value === "string") {
        if (pending.has(value)) found.add(value);
      } else if (Array.isArray(value)) value.forEach((x) => refersTo(x, found));
      else if (value && typeof value === "object") Object.values(value as Row).forEach((x) => refersTo(x, found));
    };
    while (pending.size > 0) {
      const ready = [...pending.values()].find((o) => {
        const deps = new Set<string>();
        refersTo({ ...(o.after as Row), id: undefined }, deps);
        for (const d of [...deps]) if (!temp.has(d)) deps.delete(d);
        deps.delete(o.key);
        return [...deps].every((d) => !pending.has(d));
      });
      if (!ready) throw new Error("New rows refer to each other in a loop; they cannot be created in any order.");
      pending.delete(ready.key);
      const model = TABLES[ready.table];
      if (!model) throw new Error(`Unknown table "${ready.table}".`);
      if (model.noInsert) throw new Error(model.noInsert);
      // The row's own temporary id is not a reference to resolve; it is what is being created.
      const { id: _own, ...fields } = ready.after as Row;
      const row = { ...(rename(fields) as Row), id: ready.key };
      const doc = await model.toDoc(row, cx, true);
      // One application per person per opening (2 Oct). The app checks against the rows it
      // loaded, which can be 30 seconds old; two TAs adding the same candidate, or an add
      // racing a CV intake, both arrived here as inserts and made two applications: two
      // owners, two follow-up streams. Here the check sees the live table inside the
      // transaction, so the second insert becomes the first one's row instead.
      if (model.backend === "applications" && doc.candidateId && doc.jobId) {
        const held = await ctx.db
          .query("applications")
          .withIndex("by_candidate_job", (q) => q.eq("candidateId", doc.candidateId as never).eq("jobId", doc.jobId as never))
          .first();
        if (held) {
          if (temp.has(ready.key)) ids[ready.key] = held._id;
          continue;
        }
      }
      const inserted = await ctx.db.insert(model.backend as never, clean(doc) as never);
      if (temp.has(ready.key)) ids[ready.key] = inserted;
    }

    // ── updates, each checked against what the action saw ────────────────────
    for (const op of args.ops.filter((o) => o.kind === "update")) {
      const model = TABLES[op.table];
      if (!model) throw new Error(`Unknown table "${op.table}".`);
      const doc = await locate(ctx, model, op.table, op.key, op.before as Row);
      if (!doc) throw new Error(`conflict:${op.table}:${op.key}:*: it was deleted by someone else`);
      const current = model.fromDoc(doc);
      const before = op.before as Row;
      const after = rename(op.after) as Row;
      for (const field of op.changed ?? []) {
        if (!looselySame(current[field], before[field])) {
          // If the database already holds what this action wants to write, continue
          if (looselySame(current[field], after?.[field])) continue;
          throw new Error(`conflict:${op.table}:${op.key}:${field}: changed by someone else since it was loaded`);
        }
      }
      const [was, will] = await Promise.all([model.toDoc(before, cx, false), model.toDoc(after, cx, false)]);
      const patch: Record<string, unknown> = {};
      const unsets: string[] = [];
      for (const k of new Set([...Object.keys(was), ...Object.keys(will)])) {
        if (!sameValue(was[k], will[k])) {
          if (will[k] === undefined) {
            unsets.push(k);
          } else {
            patch[k] = will[k];
          }
        }
      }
      if (unsets.length > 0) {
        const nextDoc = { ...doc, ...clean(patch) };
        for (const k of unsets) delete (nextDoc as Record<string, unknown>)[k];
        const { _id, _creationTime, ...body } = nextDoc as Record<string, unknown>;
        await ctx.db.replace(doc._id as never, clean(body) as never);
      } else if (Object.keys(patch).length > 0) {
        await ctx.db.patch(doc._id as never, clean(patch) as never);
      }
      // A company the TA corrected on the profile or the end-of-day email is
      // who database search finds there now (9 Oct); employersText is not a
      // field the app holds, so it is kept in step here.
      if (model.backend === "candidates" && ("currentEmployer" in patch || unsets.includes("currentEmployer"))) {
        await refreshEmployersText(ctx, doc._id as never);
      }
    }

    // ── deletes ───────────────────────────────────────────────────────────────
    for (const op of args.ops.filter((o) => o.kind === "delete")) {
      const model = TABLES[op.table];
      if (!model) throw new Error(`Unknown table "${op.table}".`);
      const doc = await locate(ctx, model, op.table, op.key, op.before as Row);
      if (!doc) continue; // already gone: the outcome the action wanted
      if (model.softDelete) await ctx.db.patch(doc._id as never, model.softDelete(cx) as never);
      else await ctx.db.delete(doc._id as never);
    }

    if (actorUser) {
      const day = await ctx.db.query("taWorkdays").withIndex("by_user_finished", (q) => q.eq("userId", actorUser!._id).eq("finishedAt", undefined)).first();
      if (day) for (const op of args.ops) {
        if (!["researchReports", "benchmarks"].includes(op.table)) continue;
        const jobId = op.before?.openingId ?? op.after?.openingId;
        if (!day.jobs.some((j) => j.jobId === jobId)) continue;
        await ctx.db.insert("taWorkdayActivity", { workdayId: day._id, jobId: jobId as Id<"jobs">, userId: actorUser._id, kind: `${op.table}:${op.kind}`, recordId: ids[op.key] ?? op.key, at: now });
      }
    }
    const affectedJobs = new Set<Id<"jobs">>();
    for (const op of args.ops) {
      const raw = op.after?.openingId ?? op.before?.openingId;
      if (raw && ctx.db.normalizeId("jobs", raw)) {
        affectedJobs.add(raw as Id<"jobs">);
        if (["jobPosts", "profileSuggestions"].includes(op.table)) {
          const relevant = op.table === "jobPosts" ? op.kind === "insert" || op.changed?.includes("externalUrl") : op.kind === "insert" || op.changed?.includes("status");
          if (relevant) await ctx.db.insert("taWorkdayEvidence", { jobId: raw as Id<"jobs">, recordId: ids[op.key] ?? op.key, table: op.table, at: now,
            ...(actorUser ? { by: actorUser._id } : {}), version: String(op.table === "jobPosts" ? op.after?.externalUrl ?? "" : op.after?.status ?? "deleted") });
        }
      }
    }
    for (const jobId of affectedJobs) await refreshWorkdayChecks(ctx, jobId, actorUser?._id);
    return { ids };
  },
});

function normalize(ctx: { db: { normalizeId: (t: never, id: string) => unknown } }, id: string): string | null {
  // An id could belong to any table; try the ones rows refer to.
  for (const t of Object.values(TABLES).map((m) => m.backend).concat(["users", "candidates", "jobs", "applications", "clients", "cvUploads"])) {
    const n = ctx.db.normalizeId(t as never, id);
    if (n) return n as string;
  }
  return null;
}

async function locate(
  ctx: { db: { get: (id: never) => Promise<unknown>; query: (t: never) => { collect: () => Promise<unknown[]> } } } & Parameters<typeof normalize>[0],
  model: (typeof TABLES)[string],
  table: string,
  key: string,
  before: Row,
): Promise<(Row & { _id: string }) | null> {
  if (model.locate === "by_key") {
    const all = (await ctx.db.query(model.backend as never).collect()) as (Row & { _id: string })[];
    return all.find((d) => model.key(model.fromDoc(d as never)) === model.key(before)) ?? null;
  }
  const id = ctx.db.normalizeId(model.backend as never, key);
  if (!id) throw new Error(`"${key}" is not a ${table} id.`);
  return (await ctx.db.get(id as never)) as (Row & { _id: string }) | null;
}

/** Convex refuses undefined values in a document. */
function clean(doc: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(doc).filter(([, v]) => v !== undefined));
}
