"use node";

// convex/ta/intakeReceive.ts
//
// A CV arriving from a channel, put in the queue instead of the candidate
// table.
//
// The old ingestion writes a candidate the moment a file lands and lets
// deduplication merge or drop it afterwards — so nobody ever sees the ones it
// got wrong, and "we received forty and kept six" is not a question the system
// can answer. Here the arrival is a row in `intakeItems`: routed, read, checked
// against the database, and then waiting for a person.
//
// Everything expensive is reused rather than rebuilt: the text extraction is
// `cvs/cvExtraction.ts` (pdf.js, mammoth, the Vision OCR fallback) and the
// structured read is the same DeepSeek call the live path makes. The only new
// thing is where the result goes.

import { v } from "convex/values";
import { action } from "../_generated/server";
import { api, internal } from "../_generated/api";
import { extractText } from "../cvs/cvExtraction";

/**
 * Take one arriving CV.
 *
 * Idempotent on the file's hash: the same bytes arriving twice is the same
 * file, and a retrying webhook must not produce two rows.
 */
export const receiveCv = action({
  args: {
    actorId: v.optional(v.string()),
    source: v.string(),
    /** Where it came from, as text. Never parsed into an identity. */
    receivedFrom: v.optional(v.union(v.string(), v.null())),
    /** The address it arrived AT — which says whose adverts it can belong to. */
    toAddress: v.optional(v.union(v.string(), v.null())),
    subject: v.optional(v.union(v.string(), v.null())),
    fileName: v.optional(v.union(v.string(), v.null())),
    fileHash: v.optional(v.union(v.string(), v.null())),
    /** Where the bytes are. One of these, or rawText below. */
    s3Key: v.optional(v.union(v.string(), v.null())),
    rawText: v.optional(v.union(v.string(), v.null())),
    fileType: v.optional(v.string()),
  },
  handler: async (ctx, args): Promise<{ id: string; duplicate: boolean; routed: boolean; note: string }> => {
    // 1 ─ Which advert, from the mailbox and the headline.
    const route = args.toAddress
      ? await ctx.runQuery(api.ta.intakeRouting.routeInbound, {
          actorId: args.actorId,
          to: args.toAddress,
          subject: args.subject ?? "",
        })
      : null;

    // 2 ─ The row exists before anything is read, so a file that cannot be
    //     parsed is still visible rather than silently dropped.
    const created = await ctx.runMutation(api.ta.intake.receive, {
      actorId: args.actorId,
      source: args.source,
      receivedFrom: args.receivedFrom ?? null,
      fileName: args.fileName ?? null,
      fileHash: args.fileHash ?? null,
      rawText: args.rawText ?? null,
      s3Key: args.s3Key ?? null,
      toAddress: args.toAddress ?? null,
      subject: args.subject ?? null,
      openingId: route?.openingId ?? null,
      jobPostId: route?.postId ?? null,
      routedToTaId: route?.taId ?? null,
      routeNote: route?.note ?? "Arrived with no address to route on.",
      routeConfidence: route?.confidence ?? "none",
    });
    if (created.duplicate) {
      return { id: created.id, duplicate: true, routed: Boolean(route?.postId), note: "Already in the queue." };
    }

    // 3 ─ The text, then the structured read. Both are the live path's.
    const problems: string[] = [];
    let text = args.rawText ?? null;
    if (!text && args.s3Key) {
      try {
        const url = await ctx.runAction(api.storage.r2.generateDownloadUrl, { key: args.s3Key });
        const res = await fetch(url);
        if (!res.ok) throw new Error(`storage returned ${res.status}`);
        const extracted = await extractText(await res.arrayBuffer(), args.fileType ?? "application/pdf", false, ctx);
        text = extracted.text;
      } catch (e) {
        problems.push(`The file could not be read: ${(e as Error).message}`);
      }
    }

    let parsed: Record<string, unknown> | null = null;
    if (text && text.trim().length >= 30) {
      try {
        const { callOpenRouterLLM } = await import("../cvs/cvExtraction");
        parsed = (await (callOpenRouterLLM as never as (
          c: unknown, t: string, u?: unknown, s?: unknown,
        ) => Promise<Record<string, unknown>>)(ctx, text, undefined, args.source)) ?? null;
      } catch (e) {
        // A CV that cannot be read is a normal outcome, not a failure: a
        // photographed one yields a name and nothing else. It is said out
        // loud on the row rather than swallowed.
        problems.push(`Could not read the details: ${(e as Error).message}`);
      }
    } else if (!problems.length) {
      problems.push("No readable text in the file.");
    }

    await ctx.runMutation(api.ta.intake.setParsed, {
      actorId: args.actorId,
      itemId: created.id,
      parsed: parsed ?? undefined,
      // `ready` only where something was actually read. Anything else waits
      // for a person, which is the entire point of the queue.
      status: parsed ? "ready" : "needs_review",
      problems,
    });

    return {
      id: created.id,
      duplicate: false,
      routed: Boolean(route?.postId),
      note: route?.note ?? "No address to route on.",
    };
  },
});
