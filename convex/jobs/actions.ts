import { action } from "../_generated/server";
import { v } from "convex/values";
import { extractSearchRequirements } from "../lib/jdParser";
import { internal } from "../_generated/api";

export const extractRequirementsAction = action({
  args: { description: v.string() },
  handler: async (ctx, args) => {
    const result = await extractSearchRequirements(args.description, "job_description");
    const parsed = result.requirements;

    await ctx.runMutation(internal.stats.stats.logNvidiaCallsBatchMutation, {
      logs: [
        {
          taskType: "jd_extraction",
          model: result.usage.model,
          promptTokens: result.usage.promptTokens,
          completionTokens: result.usage.completionTokens,
          success: true,
        }
      ]
    });

    return {
      requiredSkills: parsed.requiredSkills || [],
      niceToHaveSkills: parsed.preferredSkills || [],
      location: parsed.location || "",
      title: parsed.title || "",
      minYearsExperience: parsed.minYearsExperience || 0,
      industry: parsed.industry || "",
      education: parsed.education || "",
      seniority: parsed.seniority || "",
      languages: parsed.languages || [],
      clientCompany: parsed.clientCompany || "",
      clientContactEmail: parsed.clientContactEmail || "",
      salaryRange: parsed.salaryRange || "",
    };
  },
});
