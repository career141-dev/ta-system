import { action, internalQuery, internalMutation } from "../_generated/server";
import { v } from "convex/values";
import { Id } from "../_generated/dataModel";
import { api, internal } from "../_generated/api";
import { syncCandidateOverallStatus } from "../candidates/candidates";
import { adjustJobStageStat } from "../jobs/stats";
import { initiateFollowUpOutreach } from "../pipeline/followUpHelper";
import { scoreCandidateAgainstRequirements, scoreWithLLM } from "./cvScoring";
import { getOpenAI, getModelForTask, OPENROUTER_CV_EXTRACTION_MODEL } from "../lib/llm";

// 1. Internal Query to get the necessary data for scoring
export const getScoringData = internalQuery({
  args: { candidateId: v.id("candidates"), jobId: v.id("jobs") },
  handler: async (ctx, args) => {
    const candidate = await ctx.db.get(args.candidateId);
    const job = await ctx.db.get(args.jobId);
    if (!candidate || !job) return null;

    // Get the application
    const application = await ctx.db.query("applications")
      .withIndex("by_candidate_job", (q) => q.eq("candidateId", args.candidateId).eq("jobId", args.jobId))
      .first();

    // Get the resume for heavy fields (rawText, jobHistory, etc.)
    const resume = await ctx.db.query("candidateResumes")
      .withIndex("by_candidateId", (q) => q.eq("candidateId", args.candidateId))
      .first();

    if (resume) {
      // Attach the heavy fields to the candidate object dynamically
      // so downstream logic (like cvScoring) can use them without knowing about the split.
      (candidate as any).rawText = resume.rawText;
      (candidate as any).jobHistory = resume.jobHistory;
    }

    return { candidate, job, application };
  },
});

// 2. Internal Mutation to save the score and move pipeline stage if needed
export const saveMatchScore = internalMutation({
  args: {
    applicationId: v.id("applications"),
    jobId: v.id("jobs"),
    candidateId: v.id("candidates"),
    score: v.number(),
    reason: v.string(),
    minMatchScoreToShow: v.number(),
  },
  handler: async (ctx, args) => {
    const app = await ctx.db.get(args.applicationId);
    if (!app) return;

    // Update application with score
    await ctx.db.patch(args.applicationId, {
      aiMatchScore: args.score,
      aiMatchExplanation: args.reason,
    });

    // Save to match_scores history
    await ctx.db.insert("match_scores", {
      jobId: args.jobId,
      candidateId: args.candidateId,
      score: args.score,
      scoredBy: "system",
      scoreSource: "search",
      scoredAt: new Date().toISOString(),
      trigger: "search",
    } as any);

    // If score >= minimum required, auto-advance pipeline to ta_shortlist
    if (args.score >= args.minMatchScoreToShow && app.currentStage === "new_cvs") {
      await ctx.db.patch(args.applicationId, {
        currentStage: "ta_shortlist",
        lastStageChangedAt: Date.now(),
        followUpEnteredAt: Date.now(),
      });
      await adjustJobStageStat(ctx, args.jobId, "new_cvs", "ta_shortlist");
      await syncCandidateOverallStatus(ctx, args.candidateId);
      
      await initiateFollowUpOutreach(ctx, args.applicationId);
    }
  },
});

// 3. Main scoring action — THREE-TIER AI SCORING SYSTEM
//
//  Tier 1: DeepSeek (primary — best quality, full reasoning)
//          3 retries with exponential backoff: 1s → 2s → 4s
//
//  Tier 2: DeepSeek Fallback (short prompt to reduce load)
//          2 retries, 1s apart.
//
//  Tier 3: Smart Heuristic Reason (last resort — zero API calls)
//          Score  = weighted heuristic score (fair — never 0)
//          Reason = generated from actual CV breakdown (proper recruiter language)
//
//  Result: EVERY candidate ALWAYS gets a real score + proper reason.
//
export const processCvScoring = action({
  args: { candidateId: v.id("candidates"), jobId: v.id("jobs") },
  handler: async (ctx, args) => {
    // ── Step 1: Load candidate + job data ──────────────────────────────
    const data = await ctx.runQuery(internal.cvs.cvScoringActions.getScoringData, {
      candidateId: args.candidateId,
      jobId: args.jobId,
    });

    if (!data || !data.application) {
      console.error("[Scoring] Failed to find candidate, job, or application for scoring");
      return;
    }

    const { candidate, job, application } = data;

    // ── Step 2: Build job requirements object ──────────────────────────
    const req = {
      title:             job.title,
      summary:           job.jobDescription,
      requiredSkills:    job.requiredSkills,
      preferredSkills:   job.niceToHaveSkills ?? [],
      industry:          job.clientIndustry,
      location:          job.location,
      minYearsExperience: job.experienceMinYears,
      seniority:         job.seniorityLevel,
      alternativeTitles: [],
    };

    // ── Step 3: Heuristic scoring (always runs — no API needed) ────────
    const scored = scoreCandidateAgainstRequirements(candidate as any, req as any, 0);

    const weightedScore = Math.round(
      (scored.titleScore      * ((job.scoreWeightJobTitle   ?? 30) / 100)) +
      (scored.skillScore      * ((job.scoreWeightSkills     ?? 35) / 100)) +
      (scored.experienceScore * ((job.scoreWeightExperience ?? 15) / 100)) +
      (scored.industryScore   * ((job.scoreWeightIndustry   ?? 15) / 100)) +
      (scored.locationScore   * ((job.scoreWeightLocation   ??  5) / 100))
    );

    // ── Step 4: Smart reason builder (Tier 3 fallback) ─────────────────
    function buildHeuristicReason(): string {
      const name     = (candidate as any).fullName || "The candidate";
      const jobTitle = job.title || "this role";
      const parts: string[] = [];

      // Title match
      if (scored.titleScore >= 70) {
        parts.push(`${name}'s job title is a strong match for the ${jobTitle} role.`);
      } else if (scored.titleScore >= 40) {
        parts.push(`${name}'s experience is partially aligned with the ${jobTitle} position.`);
      } else {
        parts.push(`${name}'s current role differs significantly from the ${jobTitle} requirement.`);
      }

      // Skills match
      const reqSkills = (job.requiredSkills || []).join(", ");
      if (scored.skillScore >= 70) {
        parts.push(`Required skills (${reqSkills || "as specified"}) are well-represented in the CV.`);
      } else if (scored.skillScore >= 40) {
        parts.push(`Some required skills (${reqSkills || "as specified"}) are present but coverage is partial.`);
      } else {
        parts.push(`Required skills (${reqSkills || "as specified"}) are largely absent from the CV.`);
      }

      // Experience match
      const minYears  = job.experienceMinYears;
      const candYears = (candidate as any).totalExperienceYears ?? (candidate as any).totalYearsExperience;
      if (minYears && candYears) {
        if (candYears >= minYears) {
          parts.push(`Candidate has ${candYears} years of experience, meeting the ${minYears}-year requirement.`);
        } else {
          parts.push(`Candidate has ${candYears} years of experience, below the ${minYears}-year minimum.`);
        }
      } else if (scored.experienceScore >= 60) {
        parts.push("Experience level appears suitable for this role.");
      } else {
        parts.push("Experience level may not fully meet the role requirements.");
      }

      return parts.slice(0, 3).join(" ");
    }

    // ── Step 5: THREE-TIER AI SCORING ──────────────────────────────────
    let finalScore  = weightedScore;
    let finalReason = buildHeuristicReason(); // safe default
    let scoringTier = "heuristic-smart";

    const scoringModel = OPENROUTER_CV_EXTRACTION_MODEL;

    // ── TIER 1: OpenRouter DeepSeek — 3 retries ───────────────────
    let tier1Success = false;
    let tier1Usage   = { promptTokens: 0, completionTokens: 0, model: scoringModel };

    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        const { result, usage } = await scoreWithLLM({ cv: candidate }, req as any);
        finalScore   = Math.round((weightedScore * 0.6) + (result.score * 0.4));
        finalReason  = result.reason;
        tier1Usage   = usage;
        tier1Success = true;
        scoringTier  = "deepseek-primary";
        break;
      } catch {
        if (attempt < 3) {
          await new Promise(r => setTimeout(r, Math.pow(2, attempt - 1) * 1000));
        }
      }
    }

    // Log Tier 1
    await ctx.runMutation(internal.stats.stats.logNvidiaCallsBatchMutation, {
      logs: [{
        taskType: "cv_scoring",
        model:           tier1Usage.model,
        promptTokens:    tier1Usage.promptTokens,
        completionTokens: tier1Usage.completionTokens,
        success: tier1Success,
        error:   tier1Success ? undefined : "Tier 1 (DeepSeek) failed after 3 retries",
        cvUploadId: candidate.cvUploadId ?? undefined,
        provider: "openrouter",
      }]
    });

    // ── TIER 2: DeepSeek Fallback — only if Tier 1 failed ──────
    if (!tier1Success) {
      console.warn(`[Scoring] Tier 1 (${scoringModel}) failed for ${args.candidateId}. Trying Tier 2 fallback...`);

      let tier2Success = false;
      let tier2Usage   = { promptTokens: 0, completionTokens: 0, model: scoringModel };

      for (let attempt = 1; attempt <= 2; attempt++) {
        try {
          const openrouter = getOpenAI("cv_scoring");

          // Shorter prompt — reduces token usage and rate-limit pressure
          const response = await openrouter.chat.completions.create({
            model: scoringModel,
            messages: [
              {
                role: "system",
                content: `You are a recruiter. Write all evaluations strictly in English. Do NOT output Chinese or any other language. Return ONLY JSON: {"score": 0-100, "reason": "2-3 sentence professional recruiter assessment of fit in English."}`
              },
              {
                role: "user",
                content: [
                  `Job: ${req.title}`,
                  `Required Skills: ${(req.requiredSkills || []).join(", ")}`,
                  `Min Experience: ${req.minYearsExperience || "Not specified"} years`,
                  `Candidate: ${(candidate as any).fullName}`,
                  `Title: ${(candidate as any).currentTitle || "Unknown"}`,
                  `Skills: ${((candidate as any).skills || []).join(", ")}`,
                  `Experience: ${(candidate as any).totalExperienceYears ?? 0} years`,
                ].join("\n")
              }
            ],
            response_format: { type: "json_object" },
          });

          const content   = response.choices[0]?.message?.content ?? '{"score":0}';
          const parsed    = JSON.parse(content) as { score?: number; reason?: string };
          const score8b   = Math.min(100, Math.max(0, parsed.score ?? 0));

          finalScore   = Math.round((weightedScore * 0.6) + (score8b * 0.4));
          finalReason  = parsed.reason || buildHeuristicReason();
          tier2Usage   = {
            promptTokens:    response.usage?.prompt_tokens    || 0,
            completionTokens: response.usage?.completion_tokens || 0,
            model: scoringModel,
          };
          tier2Success = true;
          scoringTier  = "deepseek-fallback";
          break;
        } catch {
          if (attempt < 2) await new Promise(r => setTimeout(r, 1000));
        }
      }

      // Log Tier 2
      await ctx.runMutation(internal.stats.stats.logNvidiaCallsBatchMutation, {
        logs: [{
          taskType: "cv_scoring",
          model:           tier2Usage.model,
          promptTokens:    tier2Usage.promptTokens,
          completionTokens: tier2Usage.completionTokens,
          success: tier2Success,
          error:   tier2Success ? undefined : "Tier 2 (DeepSeek) also failed — using Tier 3 heuristic",
          cvUploadId: candidate.cvUploadId ?? undefined,
          provider: "openrouter",
        }]
      });

      // ── TIER 3: Smart Heuristic — guaranteed, zero API calls ─────────
      if (!tier2Success) {
        console.warn(`[Scoring] All AI tiers failed for ${args.candidateId}. Using Tier 3 smart heuristic reason.`);
        finalScore  = weightedScore;
        finalReason = buildHeuristicReason();
        scoringTier = "heuristic-smart";
      }
    }

    console.log(`[Scoring] Candidate ${args.candidateId} → score: ${finalScore}, tier: ${scoringTier}`);

    // ── Step 6: Save final score + reason ──────────────────────────────
    await ctx.runMutation(internal.cvs.cvScoringActions.saveMatchScore, {
      applicationId: application._id,
      jobId:         job._id,
      candidateId:   candidate._id,
      score:         finalScore,
      reason:        finalReason,
      minMatchScoreToShow: job.minMatchScoreToShow ?? 60,
    });
  },
});
