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
import { isAutoReply, isCvAttachment, isNotAnApplication, parseApplicationEmail, type MailAttachmentMeta } from "../lib/mailParse";
import { inferOpening, matchHouseSubject, parseHouseSubject, type OpeningLite, type ShortlistKind } from "../lib/shortlistMail";
import { routeShared, type PostPick } from "../lib/postRouting";

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

  // A TA's own mailbox is no longer read (29 Sep): scoops are uploaded on the
  // opening's Scoops page. Anything still waiting from before is closed.
  const box = await ctx.runQuery(internal.mailIntake.model.mailbox, { mailbox: m.mailbox });
  if (box?.kind === "ta") {
    await ctx.runMutation(internal.mailIntake.model.finishMessage, {
      id: m._id, outcome: "skipped", note: "A TA's mailbox is not read any more — scoops are uploaded on the opening's Scoops page.",
    });
    return;
  }

  // shortlists@ is read differently: a CV there is someone already in the
  // pipeline being put forward, not an application.
  if (box?.kind === "shortlist") {
    await handleShortlistMessage(ctx, token, m, mailboxPath, subject, fromAddress, parsed.text);
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

/** What the subject said, kept on the message until its CVs have been read. */
type ShortlistNote = {
  kind: ShortlistKind;
  /** A Director's subject was in the house form. */
  parsed: boolean;
  /** The opening that subject named, when it named exactly one. */
  openingId: string | null;
  /** Why it did not, when it did not — shown to the lead. */
  matchNote: string;
  setNumber: number | null;
  body: string;
};

/**
 * Mail at shortlists@: the Director's shortlist ("CLIENT > POSITION > SET 01")
 * or a client's. The CVs are read and matched to people we already hold; the
 * opening comes from the subject (Director) or is inferred (client). Nothing
 * is sent.
 */
async function handleShortlistMessage(
  ctx: ActionCtx, token: string, m: Doc<"mailIntakeMessages">, mailboxPath: string,
  subject: string, fromAddress: string, text: string,
) {
  if (isAutoReply(fromAddress, subject)) {
    await ctx.runMutation(internal.mailIntake.model.finishMessage, { id: m._id, outcome: "skipped", note: "An automatic reply or a bounce." });
    return;
  }
  const attachments = m.hasAttachments
    ? ((await graph<{ value: MailAttachmentMeta[] }>(token, `${mailboxPath}/attachments?$select=id,name,contentType,size,isInline`)).body?.value ?? [])
    : [];
  const cvs = attachments.filter(isCvAttachment);
  if (cvs.length === 0) {
    await ctx.runMutation(internal.mailIntake.model.finishMessage, { id: m._id, outcome: "no_cv", note: "A shortlist mail with no CV attached." });
    return;
  }

  const { openings, directorAddresses } = await ctx.runQuery(internal.mailIntake.shortlist.context, {});
  const house = parseHouseSubject(subject);
  // The subject decides. A Director writing without it is still the Director,
  // but then there is no subject to name the opening, so it is inferred.
  const kind: ShortlistKind = house || directorAddresses.includes(fromAddress) ? "director" : "client";
  const match = house ? matchHouseSubject(house, openings) : null;
  const note: ShortlistNote = {
    kind,
    parsed: Boolean(house),
    openingId: match?.opening?.id ?? null,
    matchNote: match?.note ?? "",
    setNumber: house?.setNumber ?? null,
    body: text.slice(0, 2000),
  };

  const candidateIds: Id<"candidates">[] = [];
  const ingest = await ingestCvs(
    ctx, token, mailboxPath, cvs,
    { jobId: note.openingId ? (note.openingId as Id<"jobs">) : undefined, sourceChannel: "email", fromAddress, subject, campaign: `TA System mail intake — ${m.mailbox}` },
    async (candidateId) => { candidateIds.push(candidateId); },
  );
  if (ingest.cvUploadIds.length > 0) {
    await ctx.runMutation(internal.mailIntake.model.markExtracting, {
      id: m._id, cvUploadIds: ingest.cvUploadIds, candidateIds,
      openingIds: note.openingId ? [note.openingId as Id<"jobs">] : [],
      shortlist: note, note: ingest.notes.join(" ") || undefined,
    });
    return;
  }
  await fileShortlist(ctx, m, note, candidateIds, ingest.notes.join(" "));
}

/**
 * Once the people are known: choose the opening and move them. A Director's
 * subject that names no single opening is HELD, never guessed at; a client's
 * mail is filed only when one opening clearly leads (lib/shortlistMail).
 */
async function fileShortlist(
  ctx: ActionCtx, m: Doc<"mailIntakeMessages">, note: ShortlistNote, candidateIds: Id<"candidates">[], carried: string,
) {
  const label = note.kind === "director" ? "Director shortlist" : "Client shortlist";
  const set = note.setNumber ? `, set ${note.setNumber}` : "";
  if (candidateIds.length === 0) {
    await ctx.runMutation(internal.mailIntake.model.finishMessage, {
      id: m._id, outcome: "failed", note: [`${label}: no CV could be read.`, carried].filter(Boolean).join(" "),
    });
    return;
  }

  const { openings } = await ctx.runQuery(internal.mailIntake.shortlist.context, {});
  let opening: OpeningLite | null = note.openingId ? openings.find((o: OpeningLite) => o.id === note.openingId) ?? null : null;
  let why = note.matchNote;
  if (!opening && !note.parsed) {
    const apps = await ctx.runQuery(internal.mailIntake.shortlist.applicationsFor, { candidateIds });
    const inferred = inferOpening({
      subject: m.subject, body: note.body, fromAddress: m.fromAddress,
      applications: apps, candidateCount: candidateIds.length, openings,
    });
    opening = inferred.opening;
    why = inferred.note;
  }

  if (!opening) {
    const held = `${label}${set}: ${why || "no opening could be told from the mail."} Added to the database, nothing moved — a lead places them.`;
    await ctx.runMutation(internal.mailIntake.model.finishMessage, { id: m._id, outcome: "held", note: [held, carried].filter(Boolean).join(" "), candidateIds });
    return;
  }

  const jobId = opening.id as Id<"jobs">;
  // Someone the mail names who is not on the opening yet is put on it first.
  const apps = await ctx.runQuery(internal.mailIntake.shortlist.applicationsFor, { candidateIds });
  for (const c of candidateIds) {
    if (!apps.some((a: { candidateId: string; openingId: string }) => a.candidateId === (c as string) && a.openingId === opening!.id)) {
      await ctx.runMutation(api.applications.applications.createApplication, {
        candidateId: c, jobId, sourceChannel: "email", metaHeadline: m.subject.slice(0, 200),
      });
    }
  }
  const r = await ctx.runMutation(internal.mailIntake.shortlist.moveShortlisted, {
    openingId: jobId, kind: note.kind, candidateIds, mailbox: m.mailbox, subject: m.subject,
  });
  const stage = note.kind === "director" ? "Director Shortlist" : "Client Shortlist";
  const parts = [
    `${label}${set} for ${opening.clientName} · ${opening.title}: ${why || "matched."}`,
    `${r.moved.length} moved to ${stage}`,
    r.already.length ? `${r.already.length} already there` : "",
    r.left.length ? `${r.left.length} left where they are (${[...new Set(r.left.map((l: { stage: string }) => l.stage))].join(", ")})` : "",
    carried,
  ].filter(Boolean);
  await ctx.runMutation(internal.mailIntake.model.finishMessage, {
    id: m._id, outcome: "filed", note: parts.join(". ") + ".", openingIds: [jobId], candidateIds,
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

  if (m.shortlist) {
    const ids = new Set<Id<"candidates">>(m.candidateIds);
    for (const s of states) if (s.candidateId) ids.add(s.candidateId);
    const unread = states.filter((s) => !s.candidateId);
    await fileShortlist(
      ctx, m, m.shortlist as ShortlistNote, [...ids],
      [m.note ?? "", unread.length ? `${unread.length} CV${unread.length > 1 ? "s" : ""} could not be read.` : ""].filter(Boolean).join(" "),
    );
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
