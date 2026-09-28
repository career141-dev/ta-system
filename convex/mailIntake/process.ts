// convex/mailIntake/process.ts
//
// One logged message at a time: read it, find the CV, work out which advert it
// answers, and put the candidate where they belong.
//
//   advert found   → the candidate, and an application on that opening (New CVs)
//                    recording the post they applied through
//   no advert      → the candidate goes into the database, no application
//
// The CV itself is read by the pipeline the rest of the platform uses
// (pipeline/ingestion:processCvIngestion → cvs/cvExtraction). Nothing here
// replaces or changes it; this decides only where the result is filed, and
// comes back once the CV has been read to record the post on the application.
//
// Nothing is sent and the mailbox is not changed: no replies, no read flags.

import { v } from "convex/values";
import { internalAction, type ActionCtx } from "../_generated/server";
import { api, internal } from "../_generated/api";
import type { Doc, Id } from "../_generated/dataModel";
import { getGraphToken } from "../lib/graphClient";
import { isCvAttachment, isNotAnApplication, parseApplicationEmail, type MailAttachmentMeta } from "../lib/mailParse";
import { routeShared, type PostPick } from "../lib/postRouting";
import { pickScoopOpening } from "../lib/scoopMail";

const GRAPH = "https://graph.microsoft.com/v1.0";
/** Messages handled per tick. Each can mean a download and an upload. */
const PER_RUN = 3;
/** How long to wait for the extraction pipeline to read a CV before giving up on placing it. */
const EXTRACTION_TIMEOUT_MS = 3 * 60 * 60_000;

/** The source channel the rest of the platform uses for each mailbox. */
function channelFor(mailbox: string): "linkedin" | "email" | "email_campaign" {
  const m = mailbox.toLowerCase();
  if (m === "linkedin@career141.com" || m === (process.env.LINKEDIN_SHARED_INBOX ?? "").toLowerCase()) return "linkedin";
  if (m === "cv@career141.com") return "email";
  return "email_campaign";
}

async function graph<T>(token: string, path: string): Promise<{ status: number; body: T | null }> {
  const res = await fetch(`${GRAPH}${path}`, { headers: { Authorization: `Bearer ${token}` } });
  if (res.status === 404) return { status: 404, body: null };
  if (!res.ok) throw new Error(`Graph answered ${res.status} for ${path.split("?")[0]}: ${(await res.text()).slice(0, 200)}`);
  return { status: res.status, body: (await res.json()) as T };
}

function bytesFromBase64(b64: string): Uint8Array<ArrayBuffer> {
  const bin = atob(b64);
  const out = new Uint8Array(new ArrayBuffer(bin.length));
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function sha256Hex(bytes: Uint8Array<ArrayBuffer>): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * The opening a reply belongs to, from the marker the outbound email carried.
 *
 * `convex/lib/graphMail.ts` stamps `x-c141-candidatejobid` on everything it
 * sends; a reply quotes the message it answers, so the id often comes back in
 * the body. Without it a reply is filed against the application we last wrote
 * to, which is wrong when a candidate is on two openings at once.
 */
function applicationIdFrom(subject: string, body: string): string | null {
  const m = `${subject}\n${body}`.match(/x-c141-candidatejobid:\s*([a-z0-9]{20,})/i);
  return m ? m[1] : null;
}

/** Every opening a routed message goes to: the primary, then any other opening the advert serves. */
function destinations(route: PostPick | null): { jobId: Id<"jobs">; postId: Id<"jobPosts"> }[] {
  if (!route) return [];
  return [
    { jobId: route.openingId as Id<"jobs">, postId: route.postId as Id<"jobPosts"> },
    ...route.alsoTo.map((a) => ({ jobId: a.openingId as Id<"jobs">, postId: a.postId as Id<"jobPosts"> })),
  ];
}

/** Put a known candidate on each destination opening, with the post recorded. */
async function placeCandidate(
  ctx: ActionCtx,
  candidateId: Id<"candidates">,
  route: PostPick | null,
  sourceChannel: string,
  subject: string,
) {
  for (const d of destinations(route)) {
    // Already on this opening — the CV pipeline filed them, or LinkedIn's
    // second email about the same applicant. createApplication on an existing
    // application moves it from New CVs to Matched candidates, which moved 196
    // applicants no one had looked at (17 September); only the post is recorded.
    const already: boolean = await ctx.runMutation(internal.mailIntake.model.setApplicationPost, {
      candidateId, jobId: d.jobId, jobPostId: d.postId,
    });
    if (already) continue;
    await ctx.runMutation(api.applications.applications.createApplication, {
      candidateId,
      jobId: d.jobId,
      sourceChannel,
      metaHeadline: subject.slice(0, 200),
    });
    await ctx.runMutation(internal.mailIntake.model.setApplicationPost, { candidateId, jobId: d.jobId, jobPostId: d.postId });
  }
}

function describe(route: PostPick | null): string {
  if (!route) return "No live advert matched, so the candidate went to the database.";
  const how = route.how === "linkedin_job" ? "the LinkedIn job link" : route.how === "linkedin_project" ? "the LinkedIn project in the View applicant link" : route.how === "campaign_code" ? "the campaign code" : "the headline";
  const extra = route.alsoTo.length ? ` and ${route.alsoTo.length} more opening${route.alsoTo.length > 1 ? "s" : ""} the advert serves` : "";
  return `Matched "${route.matchedOn}" by ${how}${extra}.`;
}

async function handleMessage(ctx: ActionCtx, token: string, m: Doc<"mailIntakeMessages">) {
  const mailboxPath = `/users/${encodeURIComponent(m.mailbox)}/messages/${encodeURIComponent(m.messageId)}`;
  const msg = await graph<{
    subject?: string;
    body?: { contentType?: string; content?: string };
    from?: { emailAddress?: { address?: string } };
  }>(token, `${mailboxPath}?$select=subject,body,from`);
  if (msg.status === 404 || !msg.body) {
    await ctx.runMutation(internal.mailIntake.model.finishMessage, { id: m._id, outcome: "skipped", note: "The message was deleted before it could be read." });
    return;
  }

  const subject = msg.body.subject ?? m.subject;
  const fromAddress = (msg.body.from?.emailAddress?.address ?? m.fromAddress).toLowerCase();
  const html = msg.body.body?.contentType === "html" ? msg.body.body.content ?? "" : "";
  const plain = msg.body.body?.contentType !== "html" ? msg.body.body?.content ?? "" : "";
  const parsed = parseApplicationEmail({ subject, fromAddress, bodyHtml: html, bodyText: plain });
  const sourceChannel = channelFor(m.mailbox);

  // A TA's own mailbox is read for scoops and nothing else.
  const box = await ctx.runQuery(internal.mailIntake.model.mailbox, { mailbox: m.mailbox });
  if (box?.kind === "ta" && box.taUserId) {
    await handleScoop(ctx, token, m, box.taUserId, { subject, fromAddress, text: parsed.text, mailboxPath });
    return;
  }

  // Our own mail and automatic replies are not applications.
  if (isNotAnApplication(fromAddress, subject)) {
    await ctx.runMutation(internal.mailIntake.model.finishMessage, { id: m._id, outcome: "skipped", note: "Our own mail or an automatic reply — not an application." });
    return;
  }

  const live = await ctx.runQuery(internal.mailIntake.model.livePosts, {});
  const route = routeShared({ subject, body: parsed.text, linkedinOnly: sourceChannel === "linkedin" }, live);
  const openingIds = destinations(route).map((d) => d.jobId);
  const jobPostId = route ? (route.postId as Id<"jobPosts">) : undefined;

  // ── the CVs ───────────────────────────────────────────────────────────────
  const attachments = m.hasAttachments
    ? ((await graph<{ value: MailAttachmentMeta[] }>(token, `${mailboxPath}/attachments?$select=id,name,contentType,size,isInline`)).body?.value ?? [])
    : [];
  const cvs = attachments.filter(isCvAttachment);

  if (cvs.length === 0) {
    // LinkedIn also mails notices that are not applications — "Your job has
    // expired: …", performance summaries (seen on linkedin@, 16 September).
    // Without a CV or a named applicant, it is one of those.
    if (parsed.isLinkedIn && !parsed.applicantName) {
      await ctx.runMutation(internal.mailIntake.model.finishMessage, {
        id: m._id, outcome: "skipped", note: "A LinkedIn notice (such as a job expiring), not an application.",
      });
      return;
    }
    // job@ is mostly candidates replying to us. A reply carries no CV, and
    // closing it as "no CV" threw away the very answer the follow-up was
    // waiting for (17 September). If the sender is someone we are chasing, the
    // reply is recorded on their conversation and read for salary, notice
    // period and the rest — the same reading the CV platform does.
    if (!parsed.isLinkedIn) {
      const reply = await ctx.runQuery(internal.mailIntake.model.replyingCandidate, {
        fromAddress,
        applicationHint: applicationIdFrom(subject, parsed.text) ?? undefined,
      });
      if (reply) {
        await ctx.runMutation(internal.mailIntake.model.recordInboundEmail, {
          applicationId: reply.applicationId,
          candidateId: reply.candidateId,
          body: parsed.text || subject,
          subject,
          fromAddress,
          receivedAt: m.receivedAt,
        });
        await ctx.runAction(internal.communications.inboundExtraction.extractDetailsFromText, {
          candidateId: reply.candidateId,
          textBody: parsed.text || subject,
          channel: "email",
          inboxEmail: m.mailbox,
          senderEmail: fromAddress,
        });
        await ctx.runMutation(internal.mailIntake.model.finishMessage, {
          id: m._id,
          outcome: "filed",
          note: `A reply from ${reply.candidateName ?? fromAddress}, read into their record.`,
          openingIds: [reply.jobId],
          candidateIds: [reply.candidateId],
        });
        return;
      }
      await ctx.runMutation(internal.mailIntake.model.finishMessage, { id: m._id, outcome: "no_cv", note: "No CV attached, and not a reply from anyone we are chasing." });
      return;
    }
    // A LinkedIn applicant with no résumé attached: they named themselves, the
    // job and their profile, which is enough to hold them and place them.
    // A retry of this message: the person was already created last time.
    let candidateId: Id<"candidates"> | null = m.candidateIds[0] ?? null;
    if (!candidateId && parsed.profileUrl) {
      candidateId = await ctx.runQuery(internal.mailIntake.model.candidateByLinkedin, { url: parsed.profileUrl });
    }
    if (!candidateId) {
      candidateId = await ctx.runMutation(api.candidates.candidates.createCandidate, {
        fullName: parsed.applicantName ?? undefined,
        linkedinUrl: parsed.profileUrl ?? undefined,
        email: parsed.email ?? undefined,
        phone: parsed.phone ?? undefined,
        sourceChannel,
      });
      if (candidateId) await ctx.runMutation(internal.mailIntake.model.noteCandidate, { id: m._id, candidateId });
    }
    if (!candidateId) throw new Error("The candidate could not be created.");
    await placeCandidate(ctx, candidateId, route, sourceChannel, subject);
    await ctx.runMutation(internal.mailIntake.model.finishMessage, {
      id: m._id,
      outcome: route ? "filed" : "database",
      note: `CV not attached — held from the LinkedIn notification. ${describe(route)}`,
      openingIds, jobPostId, candidateIds: [candidateId],
    });
    return;
  }

  const candidateIds: Id<"candidates">[] = [];
  const known: string[] = [];
  const ingest = await ingestCvs(
    ctx, token, mailboxPath, cvs,
    { jobId: destinations(route)[0]?.jobId, sourceChannel, fromAddress, subject, campaign: `TA System mail intake — ${m.mailbox}` },
    // Already held — often because the CV platform's poller read it first.
    // The person is not created twice; they are placed on this advert too.
    async (candidateId, fileName) => {
      candidateIds.push(candidateId);
      await placeCandidate(ctx, candidateId, route, sourceChannel, subject);
      known.push(`${fileName} was already held; the existing candidate was used.`);
    },
  );
  const { cvUploadIds, waitingOnOther } = ingest;
  const notes = [...known, ...ingest.notes];

  if (cvUploadIds.length > 0) {
    await ctx.runMutation(internal.mailIntake.model.markExtracting, {
      id: m._id, cvUploadIds, candidateIds, openingIds, jobPostId, route: route ?? undefined,
      note: [describe(route), ...notes].join(" "),
    });
    return;
  }
  await ctx.runMutation(internal.mailIntake.model.finishMessage, {
    id: m._id,
    outcome: candidateIds.length ? (waitingOnOther ? "filed" : "duplicate") : "failed",
    note: [describe(route), ...notes].join(" "),
    openingIds, jobPostId, candidateIds,
  });
}

/**
 * Download a message's CV attachments and hand each to the extraction
 * pipeline, the way handleMessage does. A CV already held is not read again:
 * its person is given to `known`, or the upload waited on if still being read.
 */
async function ingestCvs(
  ctx: ActionCtx,
  token: string,
  mailboxPath: string,
  cvs: MailAttachmentMeta[],
  opts: { jobId?: Id<"jobs">; sourceChannel: string; fromAddress: string; subject: string; campaign: string },
  known: (candidateId: Id<"candidates">, fileName: string) => Promise<void>,
): Promise<{ cvUploadIds: Id<"cvUploads">[]; notes: string[]; waitingOnOther: boolean }> {
  const cvUploadIds: Id<"cvUploads">[] = [];
  const notes: string[] = [];
  let waitingOnOther = false;
  for (const a of cvs) {
    const file = await graph<{ contentBytes?: string }>(token, `${mailboxPath}/attachments/${encodeURIComponent(a.id)}`);
    if (!file.body?.contentBytes) {
      notes.push(`${a.name ?? "An attachment"} could not be downloaded.`);
      continue;
    }
    const bytes = bytesFromBase64(file.body.contentBytes);
    const fileHash = await sha256Hex(bytes);
    const fileName = a.name ?? "cv.pdf";
    const fileType = a.contentType || "application/pdf";

    const held = await ctx.runQuery(internal.mailIntake.model.uploadByHash, { fileHash });
    if (held) {
      if (held.candidateId) {
        await known(held.candidateId, fileName);
      } else if (["pending", "processing", "uploaded", "healing", "pending_retry"].includes(held.status)) {
        cvUploadIds.push(held.id);
        waitingOnOther = true;
        notes.push(`${fileName} is already being read; placing the candidate when it is done.`);
      } else {
        notes.push(`${fileName} was received before and could not be read (${held.status}).`);
      }
      continue;
    }

    const s3Key: string = await ctx.runAction(internal.storage.r2.uploadBufferToR2, {
      fileName,
      contentType: fileType,
      base64Data: file.body.contentBytes,
    });
    const result = (await ctx.runMutation(api.pipeline.ingestion.processCvIngestion, {
      jobId: opts.jobId,
      sourceChannel: opts.sourceChannel,
      rawSender: opts.fromAddress,
      s3Key,
      storageProvider: "r2",
      fileHash,
      fileName,
      fileType,
      fileSizeBytes: bytes.length,
      metaHeadline: opts.subject.slice(0, 200),
      metaCampaignId: opts.campaign,
    })) as { success: boolean; reason?: string; cvUploadId?: Id<"cvUploads">; existingFileId?: Id<"cvUploads"> };
    const uploadId = result.cvUploadId ?? result.existingFileId;
    if (uploadId) cvUploadIds.push(uploadId);
    if (!result.success) notes.push(`${fileName}: ${result.reason ?? "not accepted by the pipeline"}.`);
  }
  return { cvUploadIds, notes, waitingOnOther };
}

/** Put one scooped candidate on the job as the TA's; a note when they could not be. */
async function placeScoopedCandidate(
  ctx: ActionCtx,
  candidateId: Id<"candidates">,
  jobId: Id<"jobs">,
  taUserId: Id<"users">,
  fromUserId: Id<"users">,
  receivedAt: number,
  subject: string,
): Promise<string | null> {
  const args = { candidateId, jobId, taUserId, fromUserId, receivedAt };
  let r = await ctx.runMutation(internal.mailIntake.model.placeScoop, args);
  if (r.needsApplication) {
    await ctx.runMutation(api.applications.applications.createApplication, {
      candidateId,
      jobId,
      sourceChannel: "email",
      metaHeadline: subject.slice(0, 200),
    });
    r = await ctx.runMutation(internal.mailIntake.model.placeScoop, args);
  }
  return r.note ?? null;
}

/**
 * A scoop: CVs the Director, a TA Lead or Ops mailed to a TA for one of their
 * jobs (the desk, 27 September). Each CV is read like any other and the
 * candidate goes on that job as the TA's, marked as a scoop — which is what
 * the TA's end-of-day SCOOP counts. Where the job cannot be told, nothing is
 * filed and the TA is told, so a CV never lands on the wrong job.
 */
async function handleScoop(
  ctx: ActionCtx,
  token: string,
  m: Doc<"mailIntakeMessages">,
  taUserId: Id<"users">,
  msg: { subject: string; fromAddress: string; text: string; mailboxPath: string },
) {
  const sender = await ctx.runQuery(internal.mailIntake.model.scoopSender, { fromAddress: msg.fromAddress });
  if (!sender) {
    await ctx.runMutation(internal.mailIntake.model.finishMessage, {
      id: m._id, outcome: "skipped", note: "Not from the Director, a TA Lead or Ops — the rest of a TA's mail is not read.",
    });
    return;
  }

  const attachments = m.hasAttachments
    ? ((await graph<{ value: MailAttachmentMeta[] }>(token, `${msg.mailboxPath}/attachments?$select=id,name,contentType,size,isInline`)).body?.value ?? [])
    : [];
  const cvs = attachments.filter(isCvAttachment);
  if (cvs.length === 0) {
    await ctx.runMutation(internal.mailIntake.model.finishMessage, { id: m._id, outcome: "no_cv", note: `From ${sender.name}, with no CV attached.` });
    return;
  }

  const openings = await ctx.runQuery(internal.mailIntake.model.taOpenOpenings, { taUserId });
  const job = pickScoopOpening(openings, msg.subject, msg.text);
  if (!job) {
    const why = openings.length === 0 ? "you have no open job" : "the email does not say which of your jobs it is for";
    await ctx.runMutation(internal.ta.notifications.create, {
      userId: taUserId as string,
      type: "scoop_received",
      title: `Scoop from ${sender.name} — not filed`,
      body: `"${msg.subject.slice(0, 80)}": ${cvs.length} CV${cvs.length > 1 ? "s" : ""}, but ${why}. Add them to the job by hand.`,
    });
    await ctx.runMutation(internal.mailIntake.model.finishMessage, {
      id: m._id, outcome: "skipped", note: `Scoop from ${sender.name}, not filed: ${why}. The TA was told.`,
    });
    return;
  }

  const jobId = job.id as Id<"jobs">;
  const candidateIds: Id<"candidates">[] = [];
  const notes: string[] = [];
  const ingest = await ingestCvs(
    ctx, token, msg.mailboxPath, cvs,
    { jobId, sourceChannel: "email", fromAddress: msg.fromAddress, subject: msg.subject, campaign: `TA System scoop — ${m.mailbox}` },
    async (candidateId, fileName) => {
      candidateIds.push(candidateId);
      const note = await placeScoopedCandidate(ctx, candidateId, jobId, taUserId, sender.userId, m.receivedAt, msg.subject);
      notes.push(`${fileName} was already held${note ? ` (${note})` : ""}.`);
    },
  );
  const summary = `Scoop from ${sender.name} for ${job.title}${job.clientName ? ` — ${job.clientName}` : ""}.`;
  if (ingest.cvUploadIds.length > 0) {
    await ctx.runMutation(internal.mailIntake.model.markExtracting, {
      id: m._id, cvUploadIds: ingest.cvUploadIds, candidateIds, openingIds: [jobId],
      scoopTaId: taUserId, scoopFromUserId: sender.userId,
      note: [summary, ...notes, ...ingest.notes].join(" "),
    });
    return;
  }
  if (candidateIds.length) await notifyScoop(ctx, taUserId, jobId, candidateIds.length, msg.subject);
  await ctx.runMutation(internal.mailIntake.model.finishMessage, {
    id: m._id,
    outcome: candidateIds.length ? "filed" : "failed",
    note: [summary, ...notes, ...ingest.notes].join(" "),
    openingIds: [jobId], candidateIds,
  });
}

async function notifyScoop(ctx: ActionCtx, taUserId: Id<"users">, jobId: Id<"jobs">, count: number, subject: string) {
  await ctx.runMutation(internal.ta.notifications.create, {
    userId: taUserId as string,
    type: "scoop_received",
    title: `Scoop: ${count} CV${count > 1 ? "s" : ""} added to your job`,
    body: `"${subject.slice(0, 80)}" — counted on tonight's SCOOP.`,
    jobId: jobId as string,
  });
}

/** Once a CV has been read: put the candidate on every opening the advert serves, with the post. */
async function finishExtracting(ctx: ActionCtx, m: Doc<"mailIntakeMessages">) {
  type UploadState = { id: Id<"cvUploads">; status: string; candidateId: Id<"candidates"> | null; error: string | null };
  const states: UploadState[] = await ctx.runQuery(internal.mailIntake.model.uploadsState, { ids: m.cvUploadIds });
  const pending = states.filter((s) => !s.candidateId && ["pending", "processing", "uploaded", "healing", "pending_retry"].includes(s.status));
  const timedOut = Date.now() - (m.processedAt ?? m.createdAt) > EXTRACTION_TIMEOUT_MS && Date.now() - m.receivedAt > EXTRACTION_TIMEOUT_MS;
  if (pending.length > 0 && !timedOut) {
    await ctx.runMutation(internal.mailIntake.model.recheckExtractingLater, { id: m._id });
    return;
  }

  // A scoop goes on the TA's job as theirs, not wherever an advert points.
  if (m.scoopTaId && m.scoopFromUserId && m.openingIds[0]) {
    const placed = new Set<Id<"candidates">>(m.candidateIds);
    const notes: string[] = [];
    for (const s of states) {
      if (!s.candidateId) continue;
      placed.add(s.candidateId);
      const note = await placeScoopedCandidate(ctx, s.candidateId, m.openingIds[0], m.scoopTaId, m.scoopFromUserId, m.receivedAt, m.subject);
      if (note) notes.push(`One candidate was ${note}.`);
    }
    const unread = states.filter((s) => !s.candidateId);
    if (placed.size > 0) await notifyScoop(ctx, m.scoopTaId, m.openingIds[0], placed.size, m.subject);
    await ctx.runMutation(internal.mailIntake.model.finishMessage, {
      id: m._id,
      outcome: placed.size === 0 ? "failed" : "filed",
      note: [m.note ?? "", ...notes, unread.length ? `${unread.length} CV${unread.length > 1 ? "s" : ""} could not be read.` : ""].filter(Boolean).join(" "),
      candidateIds: [...placed],
    });
    return;
  }

  const route = (m.route ?? null) as PostPick | null;
  const sourceChannel = channelFor(m.mailbox);
  const candidateIds = new Set<Id<"candidates">>(m.candidateIds);
  for (const s of states) {
    if (!s.candidateId) continue;
    candidateIds.add(s.candidateId);
    await placeCandidate(ctx, s.candidateId, route, sourceChannel, m.subject);
  }

  const unread = states.filter((s) => !s.candidateId);
  const note = [
    m.note ?? "",
    unread.length ? `${unread.length} CV${unread.length > 1 ? "s" : ""} could not be read (${unread.map((u) => u.error ?? u.status).join("; ").slice(0, 200)}).` : "",
  ].filter(Boolean).join(" ");
  await ctx.runMutation(internal.mailIntake.model.finishMessage, {
    id: m._id,
    outcome: candidateIds.size === 0 ? "failed" : route ? "filed" : "database",
    note,
    candidateIds: [...candidateIds],
  });
}

/** The cron's entry: a few due messages, then any whose CVs have now been read. */
export const processReady = internalAction({
  args: { ignoreGrace: v.optional(v.boolean()) },
  handler: async (ctx, args): Promise<{ handled: number; claimed: number; extracting: number }> => {
    const claimed: Doc<"mailIntakeMessages">[] = await ctx.runMutation(internal.mailIntake.model.claimDue, { limit: PER_RUN, ignoreGrace: args.ignoreGrace });
    let token: string | null = null;
    let handled = 0;
    for (const m of claimed) {
      try {
        token ??= await getGraphToken();
        await handleMessage(ctx, token, m);
        handled++;
      } catch (e) {
        const error = ((e as Error).message ?? String(e)).slice(0, 500);
        // Back off and try again later; claimDue gives up after MAX_ATTEMPTS.
        await ctx.runMutation(internal.mailIntake.model.retryLater, { id: m._id, delayMs: 10 * 60_000 * m.attempts, error });
      }
    }

    const extracting: Doc<"mailIntakeMessages">[] = await ctx.runQuery(internal.mailIntake.model.extractingDue, { limit: 10 });
    for (const m of extracting) {
      try {
        await finishExtracting(ctx, m);
      } catch (e) {
        console.warn(`[mailIntake] could not finish ${m._id}: ${(e as Error).message}`);
        await ctx.runMutation(internal.mailIntake.model.recheckExtractingLater, { id: m._id });
      }
    }
    return { handled, claimed: claimed.length, extracting: extracting.length };
  },
});

/** Handle one named message now — a retry from Settings, or a check of one message. */
export const processMessage = internalAction({
  args: { id: v.id("mailIntakeMessages") },
  handler: async (ctx, args): Promise<{ ok: boolean; error?: string }> => {
    const m: Doc<"mailIntakeMessages"> | null = await ctx.runMutation(internal.mailIntake.model.claimOne, { id: args.id });
    if (!m) return { ok: false, error: "That message is being handled or has not been logged." };
    try {
      await handleMessage(ctx, await getGraphToken(), m);
      return { ok: true };
    } catch (e) {
      const error = ((e as Error).message ?? String(e)).slice(0, 500);
      await ctx.runMutation(internal.mailIntake.model.retryLater, { id: m._id, delayMs: 10 * 60_000, error });
      return { ok: false, error };
    }
  },
});
