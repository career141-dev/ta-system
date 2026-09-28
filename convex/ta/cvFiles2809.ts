// convex/ta/cvFiles2809.ts
//
// CVs lost in the Convex Cloud move (28 September).
//
// 5,434 CVs uploaded 7 Jul – 12 Aug 2026 sit in Convex file storage records
// whose files were never copied to the self-hosted backend, so 2,977 profiles
// show "Historical CV file pending…" and cannot go to the Director. For 176 of
// them a working copy of the CV is already in R2 — the same file (by hash) or
// another CV of the same person — and pointing the candidate at it is all it
// takes. The rest are marked (`cvMissingUploadId`, src/lib/cvMissing.ts) and
// kept out of search and matching until their files are copied across.
//
// Run by the release pipeline (AGENTS.md rule 5):
//   run_function  ta/cvFiles2809:run   run_args  {"dryRun": true}
// then again with {"dryRun": false}. Idempotent: a second run relinks nothing
// and marks nobody new, and it lifts the mark from anyone whose file is back.
// If it stops for time it returns `nextCursor`; run again with {"cursor": …}.

import { v } from "convex/values";
import { internalAction, internalMutation, type MutationCtx } from "../_generated/server";
import { internal } from "../_generated/api";
import type { Doc } from "../_generated/dataModel";

/** Whether the upload's file can be opened — the test getCvUploadUrl makes. */
async function hasFile(ctx: MutationCtx, u: Doc<"cvUploads">): Promise<boolean> {
  if ((u.storageProvider === "r2" || !u.storageProvider) && u.s3Key) return true;
  return !!u.storageId && (await ctx.db.system.get(u.storageId)) !== null;
}

type Page = { scanned: number; relinked: number; marked: number; unmarked: number; stillMissing: number; sample: string[]; nextCursor: string | null };

export const page = internalMutation({
  args: { dryRun: v.boolean(), cursor: v.union(v.string(), v.null()), limit: v.number() },
  handler: async (ctx, args): Promise<Page> => {
    const res = await ctx.db.query("candidates").paginate({ cursor: args.cursor, numItems: args.limit });
    const out: Page = { scanned: res.page.length, relinked: 0, marked: 0, unmarked: 0, stillMissing: 0, sample: [], nextCursor: res.isDone ? null : res.continueCursor };

    for (const c of res.page) {
      if (!c.cvUploadId) continue;
      const upload = await ctx.db.get(c.cvUploadId);
      if (!upload) continue;
      if (await hasFile(ctx, upload)) {
        if (c.cvMissingUploadId) {
          out.unmarked++;
          if (!args.dryRun) await ctx.db.patch(c._id, { cvMissingUploadId: undefined });
        }
        continue;
      }

      // A working copy: another CV of this person first, then the same file
      // filed under anyone. Newest first, so a later CV wins over an older one.
      const hashes = [...new Set([upload.fileHash, c.fileHash].filter((h): h is string => !!h))];
      const copies = [
        ...(await ctx.db.query("cvUploads").withIndex("by_candidateId", (q) => q.eq("candidateId", c._id)).order("desc").take(20)),
        ...(await Promise.all(hashes.map((h) => ctx.db.query("cvUploads").withIndex("by_fileHash", (q) => q.eq("fileHash", h)).order("desc").take(20)))).flat(),
      ];
      let good: Doc<"cvUploads"> | null = null;
      for (const u of copies) {
        if (u._id !== upload._id && (await hasFile(ctx, u))) {
          good = u;
          break;
        }
      }

      if (good) {
        out.relinked++;
        if (out.sample.length < 10) out.sample.push(`${c._id} → ${good._id}`);
        if (!args.dryRun) await ctx.db.patch(c._id, { cvUploadId: good._id, cvMissingUploadId: undefined });
      } else if (c.cvMissingUploadId !== upload._id) {
        out.marked++;
        if (!args.dryRun) await ctx.db.patch(c._id, { cvMissingUploadId: upload._id });
      } else {
        out.stillMissing++;
      }
    }
    return out;
  },
});

export const run = internalAction({
  args: { dryRun: v.optional(v.boolean()), cursor: v.optional(v.union(v.string(), v.null())), limit: v.optional(v.number()) },
  handler: async (ctx, args) => {
    const dryRun = args.dryRun !== false;
    // Candidate rows can carry CV text, so pages stay small; the loop stops
    // well inside the action's 10-minute limit and hands back where it was.
    const limit = args.limit ?? 100;
    const stopAt = Date.now() + 8 * 60_000;
    const total = { dryRun, scanned: 0, relinked: 0, marked: 0, unmarked: 0, stillMissing: 0, sample: [] as string[], nextCursor: args.cursor ?? null };
    do {
      const p = await ctx.runMutation(internal.ta.cvFiles2809.page, { dryRun, cursor: total.nextCursor, limit });
      total.scanned += p.scanned;
      total.relinked += p.relinked;
      total.marked += p.marked;
      total.unmarked += p.unmarked;
      total.stillMissing += p.stillMissing;
      total.sample.push(...p.sample.slice(0, 10 - total.sample.length));
      total.nextCursor = p.nextCursor;
    } while (total.nextCursor && Date.now() < stopAt);
    console.log(JSON.stringify(total));
    return total;
  },
});
