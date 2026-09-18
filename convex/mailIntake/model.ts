// convex/mailIntake/model.ts
//
// The mail intake's own records: mailboxes, the message log, and the few reads
// of shared tables it needs. Everything here is internal — the TA System app
// reaches it with the admin key, after its own authorisation.

import { v } from "convex/values";
import { internalMutation, internalQuery } from "../_generated/server";
import { internal } from "../_generated/api";
import type { Doc, Id } from "../_generated/dataModel";
import type { RoutablePost } from "../lib/postRouting";

/** The desk's shared mailboxes. Created switched off; turned on in Settings → Mailboxes. */
export const DEFAULT_MAILBOXES = ["linkedin@career141.com", "cv@career141.com", "job@career141.com"];

/**
 * A mailbox takes only mail received after it was switched on.
 *
 * The first version read 30 days back when a mailbox was turned on. On
 * linkedin@ that was 11,000 messages, filed over a night at three a minute,
 * with new applicants queued behind old ones (16–17 September). Old mail is
 * the old system's; `backfillFrom` is now the moment reading started, and
 * anything received before it is closed as skipped, never filed.
 */

/**
 * How long a message waits before it is processed.
 *
 * Where the CV platform's poller also reads these mailboxes against the same
 * database (every 3–13 minutes), a CV it has already filed is found by its file
 * hash and reused rather than created twice. Waiting 20 minutes lets it go
 * first.
 */
export const GRACE_MS = 20 * 60_000;
export const MAX_ATTEMPTS = 4;

const EMPTY_TOTALS = { seen: 0, filed: 0, database: 0, duplicate: 0, noCv: 0, skipped: 0, failed: 0 };

// ── mailboxes ───────────────────────────────────────────────────────────────

export const ensureMailboxes = internalMutation({
  args: {},
  handler: async (ctx) => {
    const now = Date.now();
    for (const mailbox of DEFAULT_MAILBOXES) {
      const row = await ctx.db.query("mailIntakeMailboxes").withIndex("by_mailbox", (q) => q.eq("mailbox", mailbox)).first();
      if (!row) {
        await ctx.db.insert("mailIntakeMailboxes", {
          mailbox,
          enabled: false,
          // Moved to the moment it is switched on (setEnabled).
          backfillFrom: now,
          totals: { ...EMPTY_TOTALS },
          updatedAt: now,
        });
      }
    }
  },
});

export const enabledMailboxes = internalQuery({
  args: {},
  handler: async (ctx) => (await ctx.db.query("mailIntakeMailboxes").collect()).filter((m) => m.enabled),
});

export const mailbox = internalQuery({
  args: { mailbox: v.string() },
  handler: async (ctx, args) =>
    ctx.db.query("mailIntakeMailboxes").withIndex("by_mailbox", (q) => q.eq("mailbox", args.mailbox)).first(),
});

export const saveSyncState = internalMutation({
  args: {
    mailbox: v.string(),
    deltaLink: v.optional(v.union(v.string(), v.null())),
    nextLink: v.optional(v.union(v.string(), v.null())),
    error: v.optional(v.union(v.string(), v.null())),
    seenAdded: v.number(),
  },
  handler: async (ctx, args) => {
    const row = await ctx.db.query("mailIntakeMailboxes").withIndex("by_mailbox", (q) => q.eq("mailbox", args.mailbox)).first();
    if (!row) return;
    const patch: Partial<Doc<"mailIntakeMailboxes">> = {
      lastSyncAt: Date.now(),
      lastSyncError: args.error ?? undefined,
      totals: { ...row.totals, seen: row.totals.seen + args.seenAdded },
      updatedAt: Date.now(),
    };
    if (args.deltaLink !== undefined) patch.deltaLink = args.deltaLink ?? undefined;
    if (args.nextLink !== undefined) patch.nextLink = args.nextLink ?? undefined;
    await ctx.db.patch(row._id, patch);
  },
});

/** Settings → Mailboxes: read a mailbox, or stop reading it. */
export const setEnabled = internalMutation({
  args: { mailbox: v.string(), enabled: v.boolean() },
  handler: async (ctx, args) => {
    const row = await ctx.db.query("mailIntakeMailboxes").withIndex("by_mailbox", (q) => q.eq("mailbox", args.mailbox)).first();
    if (!row) throw new Error(`${args.mailbox} is not one of the intake mailboxes.`);
    const now = Date.now();
    // Switched on (again): from now. Mail that arrived while it was off is not
    // filed later — the sync still pages past it, and claimDue closes any of
    // it already logged.
    const starting = args.enabled && !row.enabled;
    await ctx.db.patch(row._id, { enabled: args.enabled, updatedAt: now, ...(starting ? { backfillFrom: now } : {}) });
    return { ok: true };
  },
});

/**
 * Take a mailbox's mail from this moment only, without switching it off —
 * for a mailbox already reading with an older window (linkedin@, switched on
 * with 30 days, then 3). Anything logged from before is closed as skipped by
 * claimDue as it comes up; nothing is deleted.
 */
export const startFromNow = internalMutation({
  args: { mailbox: v.string() },
  handler: async (ctx, args) => {
    const row = await ctx.db.query("mailIntakeMailboxes").withIndex("by_mailbox", (q) => q.eq("mailbox", args.mailbox)).first();
    if (!row) throw new Error(`${args.mailbox} is not one of the intake mailboxes.`);
    const now = Date.now();
    await ctx.db.patch(row._id, { backfillFrom: now, updatedAt: now });
    return { from: now };
  },
});

/** Settings → Mailboxes: sync one now rather than at the next tick. */
export const syncNow = internalMutation({
  args: { mailbox: v.string() },
  handler: async (ctx, args) => {
    const row = await ctx.db.query("mailIntakeMailboxes").withIndex("by_mailbox", (q) => q.eq("mailbox", args.mailbox)).first();
    if (!row) throw new Error(`${args.mailbox} is not one of the intake mailboxes.`);
    if (!row.enabled) throw new Error(`${args.mailbox} is switched off. Turn it on first.`);
    await ctx.scheduler.runAfter(0, internal.mailIntake.sync.syncMailbox, { mailbox: args.mailbox });
    await ctx.scheduler.runAfter(1000, internal.mailIntake.process.processReady, { ignoreGrace: false });
    return { ok: true };
  },
});

// ── the message log ─────────────────────────────────────────────────────────

export const recordMessages = internalMutation({
  args: {
    mailbox: v.string(),
    messages: v.array(v.object({
      messageId: v.string(),
      receivedAt: v.number(),
      subject: v.string(),
      fromAddress: v.string(),
      hasAttachments: v.boolean(),
    })),
  },
  handler: async (ctx, args) => {
    let added = 0;
    const now = Date.now();
    for (const m of args.messages) {
      const seen = await ctx.db.query("mailIntakeMessages").withIndex("by_messageId", (q) => q.eq("messageId", m.messageId)).first();
      if (seen) continue;
      await ctx.db.insert("mailIntakeMessages", {
        ...m,
        mailbox: args.mailbox,
        status: "waiting",
        attempts: 0,
        nextAttemptAt: m.receivedAt + GRACE_MS,
        openingIds: [],
        candidateIds: [],
        cvUploadIds: [],
        createdAt: now,
      });
      added++;
    }
    return { added };
  },
});

/** Take the next messages that are due, marking them so a second run leaves them alone. */
export const claimDue = internalMutation({
  args: { limit: v.number(), ignoreGrace: v.optional(v.boolean()) },
  handler: async (ctx, args) => {
    const now = Date.now();
    const boxes = new Map((await ctx.db.query("mailIntakeMailboxes").collect()).map((b) => [b.mailbox, b]));
    // Read past what will be closed unfiled, so a run of old mail does not use
    // up the run and hold new applicants back.
    const due = await ctx.db
      .query("mailIntakeMessages")
      .withIndex("by_status_next", (q) => q.eq("status", "waiting").lte("nextAttemptAt", args.ignoreGrace ? Number.MAX_SAFE_INTEGER : now))
      .take(args.limit + 200);
    const claimed: Doc<"mailIntakeMessages">[] = [];
    for (const m of due) {
      if (claimed.length >= args.limit) break;
      const box = boxes.get(m.mailbox);
      if (!box?.enabled) {
        await finish(ctx, m, { outcome: "skipped", note: "The mailbox was switched off before this was filed." });
        continue;
      }
      if (m.receivedAt < box.backfillFrom) {
        await finish(ctx, m, { outcome: "skipped", note: "Received before this mailbox was switched on — old mail is not filed." });
        continue;
      }
      if (m.attempts >= MAX_ATTEMPTS) {
        await finish(ctx, m, { outcome: "failed", error: m.error ?? "Gave up after repeated attempts." });
        continue;
      }
      // A lease: if this run dies part-way, the message is picked up again later.
      await ctx.db.patch(m._id, { status: "processing", attempts: m.attempts + 1, nextAttemptAt: now + 15 * 60_000 });
      claimed.push({ ...m, attempts: m.attempts + 1 });
    }
    // Leases that ran out: a run that died while processing.
    const stale = await ctx.db
      .query("mailIntakeMessages")
      .withIndex("by_status_next", (q) => q.eq("status", "processing").lte("nextAttemptAt", now))
      .take(10);
    for (const m of stale) await ctx.db.patch(m._id, { status: "waiting", nextAttemptAt: now });
    return claimed;
  },
});

export const extractingDue = internalQuery({
  args: { limit: v.number() },
  handler: async (ctx, args) =>
    ctx.db
      .query("mailIntakeMessages")
      .withIndex("by_status_next", (q) => q.eq("status", "extracting").lte("nextAttemptAt", Date.now()))
      .take(args.limit),
});

type Outcome = NonNullable<Doc<"mailIntakeMessages">["outcome"]>;

const TOTAL_KEY: Record<Outcome, keyof typeof EMPTY_TOTALS> = {
  filed: "filed", database: "database", duplicate: "duplicate", no_cv: "noCv", skipped: "skipped", failed: "failed",
};

async function finish(
  ctx: { db: any },
  m: Doc<"mailIntakeMessages">,
  fields: { outcome: Outcome; note?: string; error?: string; openingIds?: Id<"jobs">[]; jobPostId?: Id<"jobPosts">; candidateIds?: Id<"candidates">[]; cvUploadIds?: Id<"cvUploads">[] },
) {
  await ctx.db.patch(m._id, { ...fields, status: "done", processedAt: Date.now() });
  const box = await ctx.db.query("mailIntakeMailboxes").withIndex("by_mailbox", (q: any) => q.eq("mailbox", m.mailbox)).first();
  if (box) {
    const key = TOTAL_KEY[fields.outcome];
    await ctx.db.patch(box._id, { totals: { ...box.totals, [key]: box.totals[key] + 1 }, updatedAt: Date.now() });
  }
}

export const finishMessage = internalMutation({
  args: {
    id: v.id("mailIntakeMessages"),
    outcome: v.union(v.literal("filed"), v.literal("database"), v.literal("duplicate"), v.literal("no_cv"), v.literal("skipped"), v.literal("failed")),
    note: v.optional(v.string()),
    error: v.optional(v.string()),
    openingIds: v.optional(v.array(v.id("jobs"))),
    jobPostId: v.optional(v.id("jobPosts")),
    candidateIds: v.optional(v.array(v.id("candidates"))),
    cvUploadIds: v.optional(v.array(v.id("cvUploads"))),
  },
  handler: async (ctx, args) => {
    const m = await ctx.db.get(args.id);
    if (!m || m.status === "done") return;
    const { id: _id, ...fields } = args;
    await finish(ctx, m, fields);
  },
});

/**
 * Record a candidate on the message the moment it is created, so a retry after
 * a failure part-way uses that person rather than creating them again.
 */
export const noteCandidate = internalMutation({
  args: { id: v.id("mailIntakeMessages"), candidateId: v.id("candidates") },
  handler: async (ctx, args) => {
    const m = await ctx.db.get(args.id);
    if (m && !m.candidateIds.includes(args.candidateId)) {
      await ctx.db.patch(args.id, { candidateIds: [...m.candidateIds, args.candidateId] });
    }
  },
});

/** Try again later — the message stays in the log with why. */
export const retryLater = internalMutation({
  args: { id: v.id("mailIntakeMessages"), delayMs: v.number(), error: v.optional(v.string()) },
  handler: async (ctx, args) => {
    await ctx.db.patch(args.id, { status: "waiting", nextAttemptAt: Date.now() + args.delayMs, error: args.error });
  },
});

/** A CV is being read by the extraction pipeline; come back to place the candidate. */
export const markExtracting = internalMutation({
  args: {
    id: v.id("mailIntakeMessages"),
    cvUploadIds: v.array(v.id("cvUploads")),
    candidateIds: v.array(v.id("candidates")),
    openingIds: v.array(v.id("jobs")),
    jobPostId: v.optional(v.id("jobPosts")),
    route: v.optional(v.any()),
    note: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const { id, ...fields } = args;
    await ctx.db.patch(id, { ...fields, status: "extracting", nextAttemptAt: Date.now() + 2 * 60_000 });
  },
});

export const recheckExtractingLater = internalMutation({
  args: { id: v.id("mailIntakeMessages") },
  handler: async (ctx, args) => {
    await ctx.db.patch(args.id, { nextAttemptAt: Date.now() + 2 * 60_000 });
  },
});

// ── shared tables, read narrowly ────────────────────────────────────────────

/** Live adverts on openings that are taking applicants, in the routing rules' shape. */
export const livePosts = internalQuery({
  args: {},
  handler: async (ctx): Promise<RoutablePost[]> => {
    const posts = await ctx.db.query("jobPosts").withIndex("by_status", (q) => q.eq("status", "live")).collect();
    const out: RoutablePost[] = [];
    const openings = new Map<string, Doc<"jobs"> | null>();
    for (const p of posts) {
      const key = p.openingId as string;
      if (!openings.has(key)) openings.set(key, await ctx.db.get(p.openingId));
      // The extraction pipeline files only to active jobs; an advert left live
      // on a job on hold is not collecting.
      if (openings.get(key)?.status !== "active") continue;
      out.push({
        id: p._id as string,
        openingId: p.openingId as string,
        title: p.title,
        previousTitles: p.previousTitles,
        aliasKeywords: p.aliasKeywords,
        city: p.city ?? null,
        country: p.country ?? null,
        channel: p.channel,
        campaignCode: p.campaignCode,
        externalUrl: p.externalUrl ?? null,
        postedAt: p.postedAt ?? null,
        status: p.status,
      });
    }
    return out;
  },
});

export const uploadByHash = internalQuery({
  args: { fileHash: v.string() },
  handler: async (ctx, args) => {
    const u = await ctx.db.query("cvUploads").withIndex("by_fileHash", (q) => q.eq("fileHash", args.fileHash)).first();
    return u ? { id: u._id, status: u.status, candidateId: u.candidateId ?? null } : null;
  },
});

export const uploadsState = internalQuery({
  args: { ids: v.array(v.id("cvUploads")) },
  handler: async (ctx, args) => {
    const out = [];
    for (const id of args.ids) {
      const u = await ctx.db.get(id);
      out.push(u ? { id, status: u.status, candidateId: u.candidateId ?? null, error: u.errorMessage ?? null } : { id, status: "missing", candidateId: null, error: null });
    }
    return out;
  },
});

/**
 * A candidate replying to a follow-up, rather than a new application.
 *
 * The follow-up email goes from the TA's mailbox and asks for a CV, salary and
 * notice period; the answer comes back to job@ with none of those attached, and
 * the intake closed it as "No CV attached" (17 September) — the reply the whole
 * sequence is waiting for, thrown away. This finds the person by the address
 * they wrote from, and the application their reply belongs to: the one the
 * outbound message named in its `x-c141-candidatejobid` header where we have
 * it, otherwise the one we last wrote to.
 */
export const replyingCandidate = internalQuery({
  args: { fromAddress: v.string(), applicationHint: v.optional(v.string()) },
  handler: async (ctx, args) => {
    const email = args.fromAddress.trim().toLowerCase();
    if (!email) return null;
    const candidate = await ctx.db.query("candidates").withIndex("by_email", (q) => q.eq("email", email)).first();
    if (!candidate) return null;

    const apps = await ctx.db
      .query("applications")
      .withIndex("by_candidateId", (q) => q.eq("candidateId", candidate._id))
      .collect();
    const live = apps.filter((a) => a.isActive !== false && a.currentStage !== "rejected" && a.currentStage !== "placed");
    if (live.length === 0) return null;

    const hinted = args.applicationHint ? live.find((a) => (a._id as string) === args.applicationHint) : undefined;
    let chosen = hinted ?? null;
    if (!chosen) {
      // The application we last wrote to — a reply answers the message it follows.
      let newest = 0;
      for (const a of live) {
        const out = await ctx.db
          .query("communications")
          .withIndex("by_applicationId", (q) => q.eq("applicationId", a._id))
          .filter((q) => q.eq(q.field("direction"), "outbound"))
          .collect();
        for (const c of out) {
          const at = typeof c.sentAt === "number" ? c.sentAt : Number(c.sentAt);
          if (Number.isFinite(at) && at >= newest) {
            newest = at;
            chosen = a;
          }
        }
      }
    }
    chosen ??= live[0];
    return {
      candidateId: candidate._id,
      candidateName: candidate.fullName ?? null,
      applicationId: chosen._id,
      jobId: chosen.jobId,
      stage: chosen.currentStage,
    };
  },
});

/** Record the reply on the conversation, so the panel and the sweep both see it. */
export const recordInboundEmail = internalMutation({
  args: {
    applicationId: v.id("applications"),
    candidateId: v.id("candidates"),
    body: v.string(),
    subject: v.optional(v.string()),
    fromAddress: v.string(),
    messageId: v.optional(v.string()),
    receivedAt: v.number(),
  },
  handler: async (ctx, args) => {
    // The intake can hand the same message over twice after a retry.
    const already = await ctx.db
      .query("communications")
      .withIndex("by_applicationId", (q) => q.eq("applicationId", args.applicationId))
      .filter((q) => q.eq(q.field("direction"), "inbound"))
      .collect();
    if (already.some((c) => Number(c.sentAt) === args.receivedAt)) return { recorded: false };

    const app = await ctx.db.get(args.applicationId);
    await ctx.db.insert("communications", {
      applicationId: args.applicationId,
      candidateId: args.candidateId,
      jobId: app?.jobId,
      channel: "email" as const,
      direction: "inbound" as const,
      subject: args.subject,
      body: args.body.slice(0, 20_000),
      deliveryStatus: "delivered" as const,
      senderType: "candidate" as const,
      senderName: args.fromAddress,
      sentAt: args.receivedAt,
      stoppedSequence: false,
    });
    await ctx.db.patch(args.applicationId, { lastCandidateReplyAt: args.receivedAt });
    return { recorded: true };
  },
});

export const candidateByLinkedin = internalQuery({
  args: { url: v.string() },
  handler: async (ctx, args) => {
    const c = await ctx.db.query("candidates").withIndex("by_linkedinUrl", (q) => q.eq("linkedinUrl", args.url)).first();
    return c?._id ?? null;
  },
});

/**
 * Record which advert an application came through.
 *
 * `applications:createApplication` files to the opening and knows nothing of
 * posts; the post is what makes "applicants on my LinkedIn advert" mean
 * anything, so it is written here — once, and never over a post already set.
 */
export const setApplicationPost = internalMutation({
  args: { candidateId: v.id("candidates"), jobId: v.id("jobs"), jobPostId: v.id("jobPosts") },
  handler: async (ctx, args) => {
    // The same person under the id they were merged into, as createApplication does.
    const person = await ctx.db.get(args.candidateId);
    const candidateId = (person?.mergedInto as Id<"candidates"> | undefined) ?? args.candidateId;
    const app = await ctx.db
      .query("applications")
      .withIndex("by_candidate_job", (q) => q.eq("candidateId", candidateId).eq("jobId", args.jobId))
      .first();
    if (app && !app.jobPostId) await ctx.db.patch(app._id, { jobPostId: args.jobPostId });
    return Boolean(app);
  },
});

// ── Settings → Mailboxes ────────────────────────────────────────────────────

export const status = internalQuery({
  args: { limit: v.optional(v.number()) },
  handler: async (ctx, args) => {
    const mailboxes = await ctx.db.query("mailIntakeMailboxes").collect();
    const recent = await ctx.db.query("mailIntakeMessages").withIndex("by_receivedAt").order("desc").take(Math.min(args.limit ?? 50, 200));
    const titles = new Map<string, string>();
    for (const m of recent) {
      for (const o of m.openingIds) {
        const key = o as string;
        if (!titles.has(key)) {
          const job = await ctx.db.get(o);
          titles.set(key, job ? `${job.title}${job.clientName ? ` — ${job.clientName}` : ""}` : "(removed)");
        }
      }
    }
    const waiting = await ctx.db.query("mailIntakeMessages").withIndex("by_status_next", (q) => q.eq("status", "waiting")).take(1001);
    const extracting = await ctx.db.query("mailIntakeMessages").withIndex("by_status_next", (q) => q.eq("status", "extracting")).take(1001);
    return {
      mailboxes: mailboxes
        .sort((a, b) => DEFAULT_MAILBOXES.indexOf(a.mailbox) - DEFAULT_MAILBOXES.indexOf(b.mailbox))
        .map((m) => ({
          mailbox: m.mailbox,
          enabled: m.enabled,
          synced: Boolean(m.deltaLink),
          backfillFrom: m.backfillFrom,
          lastSyncAt: m.lastSyncAt ?? null,
          lastSyncError: m.lastSyncError ?? null,
          totals: m.totals,
        })),
      queue: { waiting: waiting.length, extracting: extracting.length },
      recent: recent.map((m) => ({
        id: m._id as string,
        mailbox: m.mailbox,
        receivedAt: m.receivedAt,
        subject: m.subject,
        fromAddress: m.fromAddress,
        status: m.status,
        outcome: m.outcome ?? null,
        openings: m.openingIds.map((o) => ({ id: o as string, title: titles.get(o as string) ?? "" })),
        candidateIds: m.candidateIds as string[],
        note: m.note ?? null,
        error: m.error ?? null,
      })),
    };
  },
});

/** Claim one named message, whatever its wait — for a retry of that message, or a test. */
export const claimOne = internalMutation({
  args: { id: v.id("mailIntakeMessages") },
  handler: async (ctx, args) => {
    const m = await ctx.db.get(args.id);
    // Waiting, or finished as failed — a message that was filed is not filed twice.
    if (!m || !(m.status === "waiting" || (m.status === "done" && m.outcome === "failed"))) return null;
    await ctx.db.patch(m._id, { status: "processing", attempts: m.attempts + 1, nextAttemptAt: Date.now() + 15 * 60_000, outcome: undefined });
    return { ...m, status: "processing" as const, attempts: m.attempts + 1 };
  },
});
