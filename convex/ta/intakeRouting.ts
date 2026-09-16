// convex/ta/intakeRouting.ts
//
// Getting an arriving CV to the right advert.
//
// The old system matched the email subject against every active job's title or
// keyword, first hit wins, iterating in table order. That has three problems
// it cannot see: a job whose channel is paused still collects, two jobs with
// similar titles are decided by which was created first, and there is no such
// thing as an ambiguous result — it always picks one.
//
// This is the TA platform's rule instead, and it is two questions rather than
// one:
//
//   the ADDRESS it arrived at   → which TA
//   the HEADLINE in the subject → which of that TA's adverts
//
// Both halves are needed. The address alone cannot separate three adverts one
// TA is running; the headline alone is not unique across the desk, because two
// TAs can both be working a "Brand Manager".
//
// This mirrors src/lib/routing.ts, which is the tested pure version used by
// the app. Kept in step with it deliberately: the rules are the same, and this
// copy exists only because a Convex function cannot import from src/.

import { v } from "convex/values";
import { internalQuery } from "../_generated/server";
import { optionalActor } from "./guard";

import { addressOf, rankPosts, type RouteConfidence } from "../lib/postRouting";

// The matching rules themselves live in ../lib/postRouting.ts (moved there
// unchanged, 16 September) so they can be tested alone and shared with the
// shared-mailbox route. These re-exports keep existing imports working.
export { addressOf, titleCandidates, type RouteConfidence } from "../lib/postRouting";

export interface RouteResult {
  taId: string | null;
  postId: string | null;
  openingId: string | null;
  confidence: RouteConfidence;
  matchedOn: string | null;
  /** The same advert serving more than one opening — the CV belongs on each. */
  alsoTo: { postId: string; openingId: string }[];
  note: string;
}

/**
 * Where an arriving message belongs.
 *
 * Only LIVE adverts owned by the TA whose mailbox took it are considered. An
 * advert that has been taken down is not collecting applicants, so nothing is
 * filed against it automatically — and a CV that arrives afterwards is not
 * lost, it simply has no post and waits in that TA's queue to be placed by
 * hand.
 */
export const routeInbound = internalQuery({
  args: {
    actorId: v.optional(v.string()),
    to: v.string(),
    subject: v.string(),
    body: v.optional(v.string()),
  },
  handler: async (ctx, args): Promise<RouteResult> => {
    await optionalActor(ctx, args.actorId);
    const none = (note: string, taId: string | null = null): RouteResult => ({
      taId, postId: null, openingId: null, confidence: "none", matchedOn: null, alsoTo: [], note,
    });

    const addr = addressOf(args.to);
    if (!addr) return none("That is not an address we can read.");

    const users = await ctx.db.query("users").collect();
    const ta = users.find((u) => addressOf(u.routingEmail ?? null) === addr && u.isActive);
    if (!ta) return none(`Nothing of ours receives at ${addr}.`);

    const posts = await ctx.db
      .query("jobPosts")
      .withIndex("by_assignedTa", (q) => q.eq("assignedTaId", ta._id))
      .collect();
    const live = posts.filter((p) => p.status === "live");
    if (live.length === 0) return none(`${ta.fullName} has no live adverts.`, ta._id);

    const ranked = rankPosts(
      live.map((p) => ({ ...p, id: p._id as string, openingId: p.openingId as string })),
      args.subject,
      args.body,
    );
    if (!ranked) {
      return none(`Nothing in "${args.subject.slice(0, 60)}" matched one of ${ta.fullName}'s adverts.`, ta._id);
    }

    const { primary, alsoTo } = ranked;
    if (alsoTo.length > 0) {
      // Same title, same recruiter, different clients: the advert is shared,
      // so the CV goes to every opening it serves rather than waiting for
      // somebody to choose one.
      return {
        taId: ta._id as string,
        postId: primary.post.id,
        openingId: primary.post.openingId,
        confidence: primary.confidence,
        matchedOn: primary.matchedOn,
        alsoTo: alsoTo.map((t) => ({ postId: t.post.id, openingId: t.post.openingId })),
        note: `Matched "${primary.matchedOn}" on ${alsoTo.length + 1} openings this advert serves.`,
      };
    }

    return {
      taId: ta._id as string,
      postId: primary.post.id,
      openingId: primary.post.openingId,
      confidence: primary.confidence,
      matchedOn: primary.matchedOn,
      alsoTo: [],
      note: `Came to ${ta.fullName}'s mailbox and matched "${primary.matchedOn}".`,
    };
  },
});

/**
 * Whether a routed message can be filed without anybody looking at it.
 *
 * An exact or deliberate-keyword match on one live advert is acted on. A
 * partial one is filed but flagged, because holding every partial match for
 * review fills the queue with things that were obviously right.
 */
export function autoFile(r: RouteResult): boolean {
  return r.postId !== null && (r.confidence === "exact" || r.confidence === "keyword");
}
