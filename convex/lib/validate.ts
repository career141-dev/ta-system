// convex/lib/validate.ts
import { v } from "convex/values";

export const paginationArgs = {
  paginationOpts: v.object({
    cursor: v.union(v.string(), v.null()),
    numItems: v.number(),
  }),
};

// Reusable validators
export const jobStatusValidator = v.union(
  v.literal("active"),
  v.literal("on_hold"),
  v.literal("filled"),
  v.literal("cancelled"),
  v.literal("draft")
);

export const channelTypeValidator = v.union(
  v.literal("whatsapp"),
  v.literal("meta_campaign"),
  v.literal("email"),
  v.literal("email_campaign"),
  v.literal("linkedin"),
  v.literal("workable"),
  v.literal("manual_upload"),
  v.literal("headhunting")
);

export const seniorityValidator = v.union(
  v.literal("executive"),
  v.literal("senior_executive"),
  v.literal("manager"),
  v.literal("senior_manager"),
  v.literal("agm"),
  v.literal("gm"),
  v.literal("director"),
  v.literal("c_suite"),
  v.literal("other")
);

/** Validate score weights sum to 100. */
export function validateScoreWeights(weights: {
  skills: number;
  experience: number;
  job_title: number;
  industry: number;
  location: number;
}): void {
  const total = Object.values(weights).reduce((a, b) => a + b, 0);
  if (total !== 100) {
    throw new Error(
      `Score weights must sum to 100. Got ${total}. ` +
      `Breakdown: ${JSON.stringify(weights)}`
    );
  }
}

/** Sanitise a keyword: uppercase, no spaces, alphanumeric only. */
export function sanitiseKeyword(raw: string): string {
  return raw.trim().toUpperCase().replace(/[^A-Z0-9]/g, "");
}
