import { internalMutation } from "../_generated/server";

export const backfillApplications = internalMutation({
  args: {},
  handler: async (ctx) => {
    const apps = await ctx.db.query("applications").collect();
    let updatedCount = 0;
    
    for (const app of apps) {
      if (!app.candidateName) {
        const candidate = await ctx.db.get(app.candidateId);
        if (candidate) {
          const updateObj: any = {
            candidateName: candidate.fullName,
            candidateEmail: candidate.email,
            candidatePhone: candidate.phone,
            candidateTitle: candidate.currentTitle ?? candidate.currentJobTitle,
            candidateExperience: candidate.yearsOfExperience ?? candidate.totalExperienceYears,
            candidateCvUploadId: candidate.cvUploadId,
            candidateCurrentSalary: candidate.currentSalary,
            candidateExpectedSalary: candidate.expectedSalary,
            candidateNoticePeriodDays: candidate.noticePeriodDays,
          };
          if (!app.cvFileName && candidate.cvUploadId) {
             const cvUpload = await ctx.db.get(candidate.cvUploadId);
             if (cvUpload) {
                updateObj.cvFileName = cvUpload.fileName;
             }
          }
          await ctx.db.patch(app._id, updateObj);
          updatedCount++;
        }
      }
    }
    console.log(`Backfilled ${updatedCount} applications.`);
    return `Backfilled ${updatedCount} applications.`;
  }
});

export const backfillCandidateSummaries = internalMutation({
  args: {},
  handler: async (ctx) => {
    const candidates = await ctx.db.query("candidates").collect();
    let updatedCount = 0;
    
    const jobs = await ctx.db.query("jobs").collect();
    const jobCache = new Map(jobs.map(j => [j._id, j]));

    for (const candidate of candidates) {
      if (!candidate.activeApplicationsSummary) {
        const apps = await ctx.db
          .query("applications")
          .withIndex("by_candidateId", (q) => q.eq("candidateId", candidate._id))
          .filter((q) => q.eq(q.field("isActive"), true))
          .collect();

        const activeApplicationsSummary = apps.map((app) => {
          const job = jobCache.get(app.jobId);
          return {
            jobId: app.jobId,
            jobTitle: job?.title ?? "Unknown Job",
            stage: app.currentStage,
            isActive: app.isActive,
          };
        });

        await ctx.db.patch(candidate._id, { activeApplicationsSummary });
        updatedCount++;
      }
    }
    console.log(`Backfilled ${updatedCount} candidate summaries.`);
    return `Backfilled ${updatedCount} candidate summaries.`;
  }
});
