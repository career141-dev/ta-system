// convex/ta/requirements.ts
//
// An opening's structured requirements — the Job details panel.
//
// Reverse matching (matching/agent2) and CV scoring (cvs/cvScoring) read these
// columns directly: requiredSkills, seniorityLevel, experienceMinYears,
// location. Openings created on the TA platform start with placeholders, so
// until something fills them the engines score every opening as "mid-level, two
// years, no skills". This is what fills them:
//
//   Brief / TA notes     → extracted in the app from the lead's brief and the
//                          TA's notes (keepLocks: every field a person has not
//                          corrected follows the latest notes)
//   JD approved / edited → extract (fill mode: blanks and placeholders only,
//                          never a field a person corrected)
//   TA presses Re-extract → extract (replace mode, locks cleared)
//   TA saves the panel    → those fields are written and locked
//
// Every write clears the stored job embedding so the next match reads the new
// requirements rather than a vector built from the old ones.

import { v } from "convex/values";
import { internalMutation, internalQuery } from "../_generated/server";
import { internal } from "../_generated/api";
import { Doc, Id } from "../_generated/dataModel";
import { requireActor, assertJobAccess } from "./guard";
import {
  EDUCATION_LEVELS, INDUSTRIES, RECRUITMENT_TYPES, REQUIREMENT_FIELDS, SENIORITY_LEVELS,
  mergeRequirements, splitSkills, type RequirementField, type RequirementValues,
} from "../lib/jobRequirements";

/** Who may edit an opening's requirements — the same seats that approve its JD. */
const MANAGES_OPENING = ["primary_recruiter", "supporting_recruiter", "director"];

/** Start an extraction. Called from approveJd / saveJd and from the Re-extract button. */
export async function scheduleExtraction(
  ctx: { db: any; scheduler: any },
  jobId: Id<"jobs">,
  mode: "fill" | "replace",
): Promise<void> {
  await ctx.db.patch(jobId, { requirementsStatus: "extracting", requirementsError: undefined });
  await ctx.scheduler.runAfter(0, internal.ta.requirementsActions.extract, { jobId, mode });
}

export const jobForExtraction = internalQuery({
  args: { jobId: v.id("jobs") },
  handler: async (ctx, args) => {
    const job = await ctx.db.get(args.jobId);
    if (!job) return null;
    return { title: job.title, jobDescription: job.jobDescription ?? "" };
  },
});

export const applyExtraction = internalMutation({
  args: {
    jobId: v.id("jobs"),
    mode: v.union(v.literal("fill"), v.literal("replace")),
    values: v.any(),
    model: v.string(),
    /**
     * With `replace`: overwrite every field a person has not corrected, and keep
     * their corrections locked. For re-reading notes that have changed, where
     * `fill` would keep the first reading and `replace` would drop the locks.
     */
    keepLocks: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    const job = await ctx.db.get(args.jobId);
    if (!job) return { applied: [] as string[] };
    const locked = job.requirementsLockedFields ?? [];
    const current = Object.fromEntries(REQUIREMENT_FIELDS.map((f) => [f, (job as Record<string, unknown>)[f]]));
    let values = args.values as Partial<RequirementValues>;
    if (args.keepLocks) values = Object.fromEntries(Object.entries(values).filter(([k]) => !locked.includes(k))) as Partial<RequirementValues>;
    const patch = mergeRequirements(current, values, { mode: args.mode, locked });
    await ctx.db.patch(args.jobId, {
      ...cleanPatch(patch),
      requirementsStatus: "extracted",
      requirementsExtractedAt: Date.now(),
      requirementsModel: args.model,
      requirementsError: undefined,
      ...(args.mode === "replace" && !args.keepLocks ? { requirementsLockedFields: [] } : {}),
      embedding: undefined,
      updatedAt: new Date().toISOString(),
    });
    return { applied: Object.keys(patch) };
  },
});

export const markExtractionFailed = internalMutation({
  args: { jobId: v.id("jobs"), error: v.string() },
  handler: async (ctx, args) => {
    await ctx.db.patch(args.jobId, { requirementsStatus: "failed", requirementsError: args.error.slice(0, 300) });
  },
});

/** Undefined means "leave alone"; Convex patches treat undefined as "remove", so drop those keys. */
function cleanPatch(patch: Partial<RequirementValues>): Partial<Doc<"jobs">> {
  const out: Record<string, unknown> = {};
  for (const [k, val] of Object.entries(patch)) if (val !== undefined) out[k] = val;
  return out as Partial<Doc<"jobs">>;
}

/** The TA pressed "Re-extract from JD": replace everything the JD speaks to. */
export const reextract = internalMutation({
  args: { actorId: v.string(), openingId: v.string() },
  handler: async (ctx, args) => {
    const user = await requireActor(ctx, args.actorId);
    const jobId = args.openingId as Id<"jobs">;
    const job = await ctx.db.get(jobId);
    if (!job) throw new Error("That opening no longer exists.");
    await assertJobAccess(ctx, user, jobId, MANAGES_OPENING);
    if (!(job.jobDescription ?? "").trim()) throw new Error("There is no JD to extract from yet.");
    await scheduleExtraction(ctx, jobId, "replace");
    return { ok: true };
  },
});

/**
 * Save the Job details panel. Every field sent is written and locked, so an
 * automatic re-extraction later fills around it instead of overwriting it.
 */
export const save = internalMutation({
  args: {
    actorId: v.string(),
    openingId: v.string(),
    title: v.optional(v.string()),
    clientIndustry: v.optional(v.string()),
    recruitmentType: v.optional(v.string()),
    isConfidential: v.optional(v.boolean()),
    status: v.optional(v.string()),
    location: v.optional(v.string()),
    seniorityLevel: v.optional(v.string()),
    experienceMinYears: v.optional(v.number()),
    experienceMaxYears: v.optional(v.union(v.number(), v.null())),
    educationLevel: v.optional(v.string()),
    salaryMin: v.optional(v.union(v.number(), v.null())),
    salaryMax: v.optional(v.union(v.number(), v.null())),
    salaryCurrency: v.optional(v.string()),
    requiredSkills: v.optional(v.array(v.string())),
    niceToHaveSkills: v.optional(v.array(v.string())),
    languagesRequired: v.optional(v.array(v.string())),
  },
  handler: async (ctx, args) => {
    const user = await requireActor(ctx, args.actorId);
    const jobId = args.openingId as Id<"jobs">;
    const job = await ctx.db.get(jobId);
    if (!job) throw new Error("That opening no longer exists.");
    await assertJobAccess(ctx, user, jobId, MANAGES_OPENING);

    const patch: Record<string, unknown> = {};
    const touched: RequirementField[] = [];
    const set = (field: string, value: unknown, requirement = true) => {
      if (value === undefined) return;
      patch[field] = value === null ? undefined : value;
      if (requirement) touched.push(field as RequirementField);
    };

    if (args.title !== undefined) {
      const title = args.title.trim();
      if (!title) throw new Error("A job title is required.");
      set("title", title.slice(0, 160), false);
    }
    if (args.clientIndustry !== undefined) {
      if (!(INDUSTRIES as readonly string[]).includes(args.clientIndustry)) throw new Error("Pick an industry from the list.");
      set("clientIndustry", args.clientIndustry);
    }
    if (args.recruitmentType !== undefined) {
      if (!(RECRUITMENT_TYPES as readonly string[]).includes(args.recruitmentType)) throw new Error("Unknown recruitment type.");
      set("recruitmentType", args.recruitmentType, false);
    }
    if (args.isConfidential !== undefined) set("isConfidential", args.isConfidential, false);
    if (args.status !== undefined) {
      if (!["active", "draft", "on_hold"].includes(args.status)) throw new Error("Unknown job status.");
      set("status", args.status, false);
    }
    if (args.location !== undefined) {
      const location = args.location.trim();
      if (!location) throw new Error("A location is required.");
      set("location", location.slice(0, 160));
    }
    if (args.seniorityLevel !== undefined) {
      if (!(SENIORITY_LEVELS as readonly string[]).includes(args.seniorityLevel)) throw new Error("Pick a seniority level from the list.");
      set("seniorityLevel", args.seniorityLevel);
    }
    const min = args.experienceMinYears;
    const max = args.experienceMaxYears;
    if (min !== undefined && (!Number.isInteger(min) || min < 0 || min > 50)) throw new Error("Minimum years must be 0–50.");
    if (max !== undefined && max !== null && (!Number.isInteger(max) || max < 0 || max > 50)) throw new Error("Maximum years must be 0–50.");
    const effMin = min ?? job.experienceMinYears ?? 0;
    if (max !== undefined && max !== null && max < effMin) throw new Error("Maximum years cannot be below the minimum.");
    set("experienceMinYears", min);
    set("experienceMaxYears", max);
    if (args.educationLevel !== undefined) {
      const e = args.educationLevel.trim();
      set("educationLevel", e ? e.slice(0, 120) : null);
    }
    for (const key of ["salaryMin", "salaryMax"] as const) {
      const n = args[key];
      if (n !== undefined && n !== null && (!Number.isFinite(n) || n < 0 || n > 1_000_000_000)) throw new Error("Salary must be a positive number.");
      set(key, n);
    }
    if ((args.salaryMin ?? 0) && (args.salaryMax ?? 0) && (args.salaryMax as number) < (args.salaryMin as number)) {
      throw new Error("Maximum salary cannot be below the minimum.");
    }
    if (args.salaryCurrency !== undefined) {
      const c = args.salaryCurrency.trim().toUpperCase();
      if (c && !/^[A-Z]{3}$/.test(c)) throw new Error("Currency must be a three-letter code such as LKR.");
      set("salaryCurrency", c || null);
    }
    if (args.requiredSkills !== undefined) {
      const skills = splitSkills(args.requiredSkills);
      if (skills.length === 0) throw new Error("Add at least one required skill.");
      set("requiredSkills", skills);
    }
    if (args.niceToHaveSkills !== undefined) set("niceToHaveSkills", splitSkills(args.niceToHaveSkills));
    if (args.languagesRequired !== undefined) set("languagesRequired", splitSkills(args.languagesRequired));

    const locked = [...new Set([...(job.requirementsLockedFields ?? []), ...touched])];
    await ctx.db.patch(jobId, {
      ...(patch as Partial<Doc<"jobs">>),
      requirementsLockedFields: locked,
      requirementsEditedBy: user._id,
      requirementsEditedAt: Date.now(),
      embedding: undefined,
      updatedAt: new Date().toISOString(),
    });
    return { ok: true, locked };
  },
});

export { EDUCATION_LEVELS };
