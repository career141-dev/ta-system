// convex/ta/backfill.ts
//
// Fitting the restored production data to the new shape.
//
// The rows came from a system that had no clients table, no adverts under an
// opening, and no owner on an application. All three exist now, and the data
// has to be given them — derived from what the old system did record, never
// invented.
//
// Every step is idempotent and every step can be asked what it WOULD do before
// it does it. That matters more than usual here: this runs against a database
// restored from production, and a backfill that cannot be rehearsed is one
// that gets run once, nervously, and never verified.
//
// Nothing here deletes or overwrites a value somebody set. A field is filled
// only where it is empty, so a correction made by hand survives a re-run.

import { v } from "convex/values";
import { mutation, query } from "../_generated/server";
import { Doc, Id } from "../_generated/dataModel";
import { optionalActor } from "./guard";

// ─── shared derivations ──────────────────────────────────────────────────────

/** "DirectFN", "DIRECTFN" and " directfn " are one client. */
export function clientKey(name: string): string {
  return (name ?? "").trim().toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

/**
 * "Colombo, Western Province, Sri Lanka" → city and country.
 *
 * The old system stored one free-text line. Splitting it is a guess at the
 * middle, so only the two ends are taken — the first part is the city and the
 * last the country, and anything else is left alone rather than assigned to a
 * field it might not belong in.
 */
function placeOf(location: string | undefined): { city: string | null; country: string | null } {
  const parts = (location ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  if (parts.length === 0) return { city: null, country: null };
  if (parts.length === 1) return { city: null, country: parts[0] };
  return { city: parts[0], country: parts[parts.length - 1] };
}

/** The Guidelines tab's channel code for the old free-text source. */
export function taChannel(legacy: string | undefined): string {
  const s = (legacy ?? "").toLowerCase();
  if (s.includes("linkedin")) return "L";
  if (s.includes("whatsapp") || s.includes("meta")) return "DA";
  if (s.includes("headhunt")) return "HH";
  if (s.includes("database") || s.includes("manual") || s.includes("directory") || s.includes("folder")) return "SCOOP";
  if (s.includes("facebook")) return "FB";
  return "E";
}

/** A job's status as the Master Sheet's position column. */
function positionStatusOf(status: string): string {
  if (status === "filled") return "filled";
  if (status === "cancelled") return "lost";
  if (status === "on_hold") return "hold";
  return "active";
}

/**
 * The advert code that ties a campaign reply back to a post.
 *
 * Built from the job's own keyword, which is already unique per job and is
 * what the old routing matched on — so a reply carrying the old code still
 * lands on the right advert after the backfill.
 */
function campaignCodeOf(job: Doc<"jobs">): string {
  return (job.keyword || job.title.slice(0, 5).toUpperCase().replace(/\s/g, "")).trim();
}

// ─── 1. clients ──────────────────────────────────────────────────────────────

export const backfillClients = mutation({
  args: {
    actorId: v.optional(v.string()),
    dryRun: v.optional(v.boolean()),
    cursor: v.optional(v.union(v.string(), v.null())),
    pageSize: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    await optionalActor(ctx, args.actorId);
    // Paged: a job carries its full description and an inline
    // reverseMatchResults array, so reading even 95 of them at once exceeds
    // the 16 MB a single execution may read.
    const page = await ctx.db.query("jobs").paginate({ numItems: Math.min(args.pageSize ?? 5, 50), cursor: args.cursor ?? null });
    const jobs = page.page;
    const existing = await ctx.db.query("clients").collect();
    const byKey = new Map(existing.map((c) => [c.nameKey, c]));

    let linked = 0, already = 0;
    const createdKeys: string[] = [];
    const spellings = new Map<string, Set<string>>();

    for (const job of jobs) {
      const name = (job.clientName ?? "").trim();
      const key = clientKey(name);
      if (!key) continue;
      if (!spellings.has(key)) spellings.set(key, new Set());
      spellings.get(key)!.add(name);

      let client = byKey.get(key);
      if (!client) {
        if (args.dryRun) {
          createdKeys.push(key);
          // Stand-in so the link below can be counted in a dry run too.
          byKey.set(key, { _id: "dry" as Id<"clients">, nameKey: key } as Doc<"clients">);
        } else {
          const id = await ctx.db.insert("clients", {
            name,
            nameKey: key,
            industry: job.clientIndustry ?? "",
            contacts: [],
            esaSignedAt: null,
            status: "active" as const,
            createdAt: Date.now(),
          });
          client = { _id: id, nameKey: key } as Doc<"clients">;
          byKey.set(key, client);
          createdKeys.push(key);
        }
      }

      if (job.clientId) { already++; continue; }
      if (!args.dryRun && client && String(client._id) !== "dry") {
        await ctx.db.patch(job._id, { clientId: client._id });
      }
      linked++;
    }

    // Where one client was spelled several ways, say so — it is the evidence
    // that folding them was the right call.
    const folded = [...spellings.entries()]
      .filter(([, set]) => set.size > 1)
      .map(([key, set]) => ({ key, spellings: [...set] }));

    return {
      dryRun: args.dryRun === true, createdKeys, linked, alreadyLinked: already, folded,
      isDone: page.isDone, continueCursor: page.continueCursor,
    };
  },
});

// ─── 2. job posts ────────────────────────────────────────────────────────────

export const backfillJobPosts = mutation({
  args: {
    actorId: v.optional(v.string()),
    dryRun: v.optional(v.boolean()),
    cursor: v.optional(v.union(v.string(), v.null())),
    pageSize: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    await optionalActor(ctx, args.actorId);
    const page = await ctx.db.query("jobs").paginate({ numItems: Math.min(args.pageSize ?? 5, 50), cursor: args.cursor ?? null });
    const jobs = page.page;
    const existing = await ctx.db.query("jobPosts").collect();
    const have = new Set(existing.map((p) => `${p.openingId}|${p.campaignCode}`));

    const users = await ctx.db.query("users").collect();
    const routing = new Map(users.map((u) => [u._id as string, u.routingEmail ?? null]));

    let created = 0, skipped = 0;
    for (const job of jobs) {
      const channels = await ctx.db
        .query("jobChannels")
        .withIndex("by_job", (q) => q.eq("jobId", job._id))
        .collect();
      const enabled = channels.filter((c) => c.isEnabled);

      // One advert per enabled channel, or a single default where the job has
      // none configured — a job with no channel row still had applicants.
      const wanted = enabled.length > 0
        ? enabled.map((c) => ({ channel: c.channelType, suffix: `-${c.channelType.slice(0, 3).toUpperCase()}` }))
        : [{ channel: "linkedin", suffix: "" }];

      const { city, country } = placeOf(job.location);
      const base = campaignCodeOf(job);

      for (const w of wanted) {
        const code = `${base}${wanted.length > 1 ? w.suffix : ""}`;
        if (have.has(`${job._id}|${code}`)) { skipped++; continue; }
        created++;
        if (args.dryRun) continue;
        await ctx.db.insert("jobPosts", {
          openingId: job._id,
          title: job.title,
          previousTitles: [],
          // The old keyword is kept as an alias so a reply quoting it still
          // routes: it is what the previous system matched on.
          aliasKeywords: job.keyword ? [job.keyword] : [],
          country,
          city,
          channel: w.channel,
          campaignCode: code,
          routingEmailAlias: routing.get(job.primaryRecruiterId as string) ?? "",
          assignedTaId: job.primaryRecruiterId,
          externalUrl: null,
          postedAt: job.publishedAt ? Date.parse(job.publishedAt) || null : null,
          status: job.status === "active" ? ("live" as const) : job.status === "draft" ? ("draft" as const) : ("paused" as const),
          cvCountToday: 0,
          createdAt: Date.parse(job.createdAt) || Date.now(),
        });
        have.add(`${job._id}|${code}`);
      }
    }
    return {
      dryRun: args.dryRun === true, created, skipped,
      isDone: page.isDone, continueCursor: page.continueCursor,
    };
  },
});

// ─── 3. the TA fields on a job ───────────────────────────────────────────────

export const backfillJobFields = mutation({
  args: {
    actorId: v.optional(v.string()),
    dryRun: v.optional(v.boolean()),
    cursor: v.optional(v.union(v.string(), v.null())),
    pageSize: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    await optionalActor(ctx, args.actorId);
    const page = await ctx.db.query("jobs").paginate({ numItems: Math.min(args.pageSize ?? 5, 50), cursor: args.cursor ?? null });
    const jobs = page.page;

    let patched = 0, untouched = 0;
    for (const job of jobs) {
      const patch: Record<string, unknown> = {};

      // A published job was agreed with the client, which is what the JD
      // approval state records. A draft is left as a draft.
      if (job.jdStatus === undefined) {
        patch.jdStatus = job.publishedAt ? "approved" : "draft";
        if (job.publishedAt) patch.jdApprovedAt = Date.parse(job.publishedAt) || undefined;
      }
      // P3 is one month — the middle tier. A real tier is a decision nobody
      // has made yet, so the default is the one that claims least.
      if (job.priorityTier === undefined) patch.priorityTier = "P3";
      if (job.positionStatus === undefined) patch.positionStatus = positionStatusOf(job.status);
      if (job.headcount === undefined) patch.headcount = 1;
      if (job.targetNationalities === undefined) patch.targetNationalities = [];
      if (job.followUpQuestions === undefined) {
        // The old per-job questions, carried across as the opening's own.
        patch.followUpQuestions = (job.customFollowUpQuestions ?? []).map((label: string, i: number) => ({
          id: `q${i + 1}`,
          label,
        }));
      }
      if (job.assignedTaIds === undefined) {
        patch.assignedTaIds = [job.primaryRecruiterId, ...(job.supportingRecruiterIds ?? [])];
      }
      if (job.taLeadId === undefined && job.directorId) patch.taLeadId = job.directorId;

      if (Object.keys(patch).length === 0) { untouched++; continue; }
      patched++;
      if (!args.dryRun) await ctx.db.patch(job._id, patch);
    }
    return {
      dryRun: args.dryRun === true, patched, untouched,
      isDone: page.isDone, continueCursor: page.continueCursor,
    };
  },
});

// ─── 4. applications ─────────────────────────────────────────────────────────

/**
 * Owner, shortlist time and channel code, a page at a time.
 *
 * Paged because there are 8,378 of them and a mutation that walks the whole
 * table is one that times out halfway and leaves the job half done. The cursor
 * comes back so the caller can continue, and re-running from the start is
 * harmless.
 */
export const backfillApplications = mutation({
  args: {
    actorId: v.optional(v.string()),
    dryRun: v.optional(v.boolean()),
    cursor: v.optional(v.union(v.string(), v.null())),
    limit: v.optional(v.number()),
    pageSize: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    await optionalActor(ctx, args.actorId);
    const page = await ctx.db.query("applications").paginate({
      numItems: Math.min(args.pageSize ?? args.limit ?? 100, 500),
      cursor: args.cursor ?? null,
    });

    let patched = 0, untouched = 0;
    for (const app of page.page) {
      const patch: Record<string, unknown> = {};

      // The first TA to shortlist owns them. The old system recorded who and
      // when on separate fields; the new one calls that ownership.
      if (app.ownerTaId === undefined && app.taShortlistById) patch.ownerTaId = app.taShortlistById;
      if (app.shortlistedAt === undefined && app.taShortlistAt) patch.shortlistedAt = app.taShortlistAt;
      if (app.taSourcingChannel === undefined) patch.taSourcingChannel = taChannel(app.sourceChannel);
      if (app.isAddOn === undefined) patch.isAddOn = false;
      if (app.answers === undefined) patch.answers = app.customFollowUpAnswers ?? {};

      if (Object.keys(patch).length === 0) { untouched++; continue; }
      patched++;
      if (!args.dryRun) await ctx.db.patch(app._id, patch);
    }

    return {
      dryRun: args.dryRun === true,
      patched,
      untouched,
      isDone: page.isDone,
      continueCursor: page.continueCursor,
    };
  },
});

// ─── what the data looks like now ────────────────────────────────────────────

/**
 * How far the backfill has got, one page at a time.
 *
 * Convex permits a single paginated query per execution, so the loop lives in
 * the caller rather than here — and the job rows are too heavy to collect in
 * one go anyway.
 */
export const status = query({
  args: {
    actorId: v.optional(v.string()),
    cursor: v.optional(v.union(v.string(), v.null())),
    pageSize: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    await optionalActor(ctx, args.actorId);
    // A read, so it can afford a bigger page than the write steps.
    const page = await ctx.db.query("jobs").paginate({ numItems: Math.min(args.pageSize ?? 15, 50), cursor: args.cursor ?? null });
    let total = 0, withClientId = 0, withJdStatus = 0, withPriorityTier = 0;
    for (const j of page.page) {
      total++;
      if (j.clientId) withClientId++;
      if (j.jdStatus !== undefined) withJdStatus++;
      if (j.priorityTier !== undefined) withPriorityTier++;
    }
    // Small tables, counted only on the first page so the totals are not
    // multiplied by the number of pages.
    const first = !args.cursor;
    const clients = first ? (await ctx.db.query("clients").collect()).length : 0;
    const posts = first ? await ctx.db.query("jobPosts").collect() : [];
    return {
      jobs: { total, withClientId, withJdStatus, withPriorityTier },
      clients: { total: clients },
      jobPosts: { total: posts.length, openingsCovered: new Set(posts.map((p) => p.openingId)).size },
      isDone: page.isDone,
      continueCursor: page.continueCursor,
    };
  },
});
