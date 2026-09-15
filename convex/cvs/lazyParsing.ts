"use node";

import { v } from "convex/values";
import { action } from "../_generated/server";
import { api, internal } from "../_generated/api";
import { callOpenRouterLLM } from "./cvExtraction";

export const triggerLazyParse = action({
  args: {
    candidateId: v.id("candidates"),
  },
  handler: async (ctx, args) => {
    // 1. Fetch candidate
    const candidate = await ctx.runQuery(api.candidates.candidates.getCandidateForParsing, {
      candidateId: args.candidateId,
    });
    
    if (!candidate) {
      throw new Error("Candidate not found");
    }
    
    if (candidate.isParsed) {
      return { status: "already_parsed" };
    }
    
    const resume = await ctx.runQuery(internal.matching.queries.getCandidateResume, { candidateId: args.candidateId });
    if (!resume || !resume.rawText) {
      throw new Error("No raw text available for parsing");
    }

    // 2. Inject known context into the LLM prompt
    const injectedContext = `
[KNOWN CANDIDATE DETAILS FROM ATS]
Name: ${candidate.fullName || 'Unknown'}
Email: ${candidate.email || 'Unknown'}
Phone: ${candidate.phone || 'Unknown'}

`;
    const textToSend = injectedContext + resume.rawText;

    // 3. Call LLM with the raw text
    const extracted = await callOpenRouterLLM(ctx, textToSend, candidate.cvUploadId);
    
    if (!extracted) {
      throw new Error("LLM extraction failed or returned empty");
    }

    // 4. Format and update the candidate
    const formattedSkills = (extracted.skills as any[])?.map((s: any) => s.value) || [];
    const parsingConfidence = {
      ...(candidate.parsingConfidence || {}),
      skills: (extracted.skills as any[])?.map((s: any) => ({ skill: s.value, confidence: s.confidence })),
      jobHistory: (extracted.jobHistory as any[])?.map((jh: any) => ({ company: jh.company, title: jh.title, confidence: jh.confidence }))
    };

    const formattedJobHistory = extracted.jobHistory?.map((jh: any) => ({
      company: jh.company ?? "Unknown Company",
      title: jh.title ?? "Unknown Title",
      startDate: jh.startDate,
      endDate: jh.endDate,
      description: jh.description,
    }));

    await ctx.runMutation(api.candidates.candidates.updateCandidateAfterLazyParse, {
      candidateId: args.candidateId,
      skills: formattedSkills,
      jobHistory: formattedJobHistory,
      education: extracted.education?.map((e: any) => ({
        degree: e.degree,
        institution: e.institution,
        year: e.year,
        field: e.field
      })),
      industries: extracted.industries ?? undefined,
      certifications: extracted.certifications ?? undefined,
      languages: extracted.languages ?? undefined,
      summary: extracted.summary ?? undefined,
      parsingConfidence,
      isParsed: true,
    });

    if (extracted.referees && extracted.referees.length > 0) {
      const validReferees = extracted.referees
        .filter((r: any) => r && r.name && String(r.name).trim().length > 0)
        .map((r: any) => ({
          name: String(r.name).trim(),
          designation: r.designation ? String(r.designation) : undefined,
          company: r.company ? String(r.company) : undefined,
          contactNo: r.contactNo ? String(r.contactNo) : undefined,
          email: r.email ? String(r.email) : undefined,
          relationship: r.relationship ? String(r.relationship) : undefined,
          notes: r.notes ? String(r.notes) : undefined,
        }));

      if (validReferees.length > 0) {
        await ctx.runMutation(api.candidates.referees.saveExtractedReferees, {
          candidateId: args.candidateId,
          referees: validReferees,
        });
      }
    }

    return { status: "success" };
  },
});
