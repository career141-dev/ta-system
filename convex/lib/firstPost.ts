// convex/lib/firstPost.ts
//
// The advert every opening starts with, in the shape the routing rules read
// (ta/firstPost.ts, 22 September). Pure, so it can be tested alone.

import type { Doc, Id } from "../_generated/dataModel";

/** One post for a job, in the shape the routing rules read. */
export function firstPostFor(job: Pick<Doc<"jobs">, "_id" | "title" | "keyword" | "location" | "primaryRecruiterId" | "status">, now: number) {
  const parts = (job.location ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  return {
    openingId: job._id as Id<"jobs">,
    title: job.title,
    previousTitles: [] as string[],
    // The job's keyword stays a way in: it is what the old routing matched on.
    aliasKeywords: job.keyword ? [job.keyword] : [],
    country: parts.length ? parts[parts.length - 1] : null,
    city: parts.length > 1 ? parts[0] : null,
    channel: "linkedin",
    campaignCode: (job.keyword || job.title.slice(0, 5).toUpperCase().replace(/\s/g, "")).trim(),
    routingEmailAlias: "",
    assignedTaId: (job.primaryRecruiterId as Id<"users"> | undefined) ?? null,
    externalUrl: null,
    postedAt: null,
    status: job.status === "active" ? ("live" as const) : ("draft" as const),
    cvCountToday: 0,
    createdAt: now,
  };
}
