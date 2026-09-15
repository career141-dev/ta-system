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
import { Doc, Id } from "../_generated/dataModel";
import { optionalActor } from "./guard";

// ── normalisation ───────────────────────────────────────────────────────────

/** `"Nuha Jobs" <NUHA.JOBS@Career141.com>` → `nuha.jobs@career141.com`. */
export function addressOf(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const inAngles = raw.match(/<([^>]+)>/);
  const t = (inAngles ? inAngles[1] : raw).trim().toLowerCase();
  return /^[^\s@]+@[^\s@]+\.[a-z]{2,}$/.test(t) ? t : null;
}

/**
 * The wrapping the boards put round a job title.
 *
 * LinkedIn's notifications are not "Brand Manager" — they are "New
 * application: Brand Manager from Nimal Perera". Stripping the furniture first
 * is what lets an exact match be trusted; without it everything falls through
 * to fuzzy matching, and fuzzy matching on a live inbox files CVs against the
 * wrong job.
 */
const WRAPPERS: RegExp[] = [
  /^\s*(?:re|fw|fwd)\s*:\s*/i,
  /^\s*new application\s*:?\s*/i,
  /^\s*(?:your )?applicant(?:s)? for\s*:?\s*/i,
  /^\s*application (?:for|to)\s*:?\s*/i,
  /\s*[-–|]\s*linkedin\s*$/i,
  /\s*\|\s*(?:indeed|jobstreet|topjobs|xpress ?jobs|rozee)\s*$/i,
];

export function titleCandidates(subject: string): string[] {
  let s = (subject ?? "").replace(/\s+/g, " ").trim();
  for (const w of WRAPPERS) s = s.replace(w, "");
  const out = new Set<string>([s]);

  const appliedTo = s.match(/\bapplied\s+(?:to|for)\s+(.+?)(?:\s+at\s+.+)?$/i);
  if (appliedTo?.[1]) out.add(appliedTo[1]);
  const before = s.match(/^(.+?)\s+(?:from|by)\s+\S+/i);
  if (before?.[1]) out.add(before[1]);
  const atClient = s.match(/^(.+?)\s+at\s+\S+/i);
  if (atClient?.[1]) out.add(atClient[1]);
  for (const part of s.split(/\s+[-–|]\s+/)) out.add(part);

  return [...out].map((x) => x.trim()).filter((x) => x.length >= 3);
}

function norm(s: string): string {
  return (s ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9&\s]/g, " ")
    .replace(/\b(and|the|of|for|a|an)\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

const tokens = (s: string) => norm(s).split(" ").filter(Boolean);

export type RouteConfidence = "exact" | "keyword" | "partial" | "none";

interface Scored {
  post: Doc<"jobPosts">;
  score: number;
  confidence: RouteConfidence;
  matchedOn: string;
}

function scorePost(post: Doc<"jobPosts">, cands: string[]): Scored | null {
  const postNorm = norm(post.title);
  const postTokens = tokens(post.title);
  let best: Scored | null = null;
  const take = (score: number, confidence: RouteConfidence, matchedOn: string) => {
    if (!best || score > best.score) best = { post, score, confidence, matchedOn };
  };

  for (const c of cands) {
    const cn = norm(c);
    if (!cn) continue;

    // The whole title, exactly — the only thing worth acting on without doubt.
    if (cn === postNorm) take(100, "exact", post.title);
    else if (cn.includes(postNorm) || postNorm.includes(cn)) take(80, "exact", post.title);

    // A title the advert carried before it was edited: applicants who clicked
    // before the edit still arrive under the old one.
    for (const old of post.previousTitles ?? []) {
      const on = norm(old);
      if (on && (cn === on || cn.includes(on))) take(90, "exact", old);
    }

    // A keyword the TA put on the post on purpose — the advert may be headed
    // "Marketing Lead" while the opening is "Brand Manager". The old system's
    // per-job keyword is carried here by the backfill, so a reply quoting it
    // still lands.
    for (const k of post.aliasKeywords ?? []) {
      const kn = norm(k);
      if (kn && (cn === kn || cn.includes(kn))) take(70, "keyword", k);
    }

    const ct = new Set(tokens(c));
    const hit = postTokens.filter((t) => ct.has(t)).length;
    if (postTokens.length > 0 && hit === postTokens.length) take(60, "partial", post.title);
    // One word short, but only where the title is long enough for that to mean
    // something. On a two-word title "one short" is one shared word, and job
    // titles here share their second word constantly — Marketing Executive and
    // Operations Executive are not the same advert.
    else if (postTokens.length > 2 && hit >= 2 && hit >= postTokens.length - 1) {
      take(40, "partial", post.title);
    }
  }
  return best;
}

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

    const cands = titleCandidates(args.subject);
    const scored = live
      .map((p) => scorePost(p, cands))
      .filter((x): x is Scored => x !== null)
      .sort((a, b) => b.score - a.score);
    if (scored.length === 0) {
      return none(`Nothing in "${args.subject.slice(0, 60)}" matched one of ${ta.fullName}'s adverts.`, ta._id);
    }

    const top = scored[0];
    let tied = scored.filter((s) => s.score === top.score);

    // A tie is normal on this desk, not a reason to give up: one job is posted
    // under several adverts. The region named in the message picks one; where
    // it does not, adverts of the same opening are the same job.
    if (tied.length > 1) {
      const text = norm(`${args.subject} ${args.body ?? ""}`);
      const inRegion = tied.filter((t) =>
        [t.post.city, t.post.country].some((place) => place && text.includes(norm(place))),
      );
      if (inRegion.length >= 1) tied = inRegion;
    }

    if (tied.length > 1) {
      const byOpening = new Map<string, Scored>();
      for (const t of [...tied].sort((a, b) => (b.post.postedAt ?? 0) - (a.post.postedAt ?? 0))) {
        const key = t.post.openingId as string;
        if (!byOpening.has(key)) byOpening.set(key, t);
      }
      const picks = [...byOpening.values()];
      const primary = picks[0];
      // Same title, same recruiter, different clients: the advert is shared,
      // so the CV goes to every opening it serves rather than waiting for
      // somebody to choose one.
      return {
        taId: ta._id as string,
        postId: primary.post._id as string,
        openingId: primary.post.openingId as string,
        confidence: primary.confidence,
        matchedOn: primary.matchedOn,
        alsoTo: picks.slice(1).map((t) => ({
          postId: t.post._id as string,
          openingId: t.post.openingId as string,
        })),
        note: `Matched "${primary.matchedOn}" on ${picks.length} openings this advert serves.`,
      };
    }

    const only = tied[0];
    return {
      taId: ta._id as string,
      postId: only.post._id as string,
      openingId: only.post.openingId as string,
      confidence: only.confidence,
      matchedOn: only.matchedOn,
      alsoTo: [],
      note: `Came to ${ta.fullName}'s mailbox and matched "${only.matchedOn}".`,
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
