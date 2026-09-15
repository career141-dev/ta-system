import { v } from "convex/values";
import { action, query } from "../_generated/server";
import { api, internal } from "../_generated/api";
import type { Doc, Id } from "../_generated/dataModel";
import { logLLMUsage, OPENROUTER_PRIMARY_MODEL } from "../lib/llm";
import { extractSearchRequirements, buildSearchTerms, type SearchRequirements } from "../lib/jdParser";
import { scoreCandidateAgainstRequirements, selectLlmPool, scoreWithLLM, scoreBatchWithLLM, buildDeterministicTaReason, distinct, type ScoredCandidate } from "../cvs/cvScoring";

export const searchCandidates = query({
  args: {
    query: v.string(),
    industry: v.optional(v.string()),
    seniority: v.optional(v.string()),
    limit: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    if (!args.query.trim()) return [];

    const limit = args.limit ?? 20;

    const searchWithFilters = async (
      index: "search_skills" | "search_title" | "search_summary",
      field: "skills" | "currentJobTitle" | "summary"
    ): Promise<Doc<"candidates">[]> => {
      try {
        return await ctx.db.query("candidates").withSearchIndex(index, (q: any) => {
          return q.search(field, args.query);
        }).take(limit);
      } catch (err: any) {
        return [];
      }
    };

    let titleResults: Doc<"candidates">[] = [];
    let skillsResults: Doc<"candidates">[] = [];
    let summaryResults: Doc<"candidates">[] = [];
    let resumeResults: Doc<"candidateResumes">[] = [];

    try {
      titleResults = await searchWithFilters("search_title", "currentJobTitle");
    } catch (e) {}

    try {
      skillsResults = await searchWithFilters("search_skills", "skills");
    } catch (e) {}

    try {
      summaryResults = await searchWithFilters("search_summary", "summary");
    } catch (e) {}

    try {
      resumeResults = await ctx.db.query("candidateResumes").withSearchIndex("search_text", (q: any) => q.search("rawText", args.query)).take(limit);
    } catch (e) {
      resumeResults = [];
    }

    // If search indexes are currently bootstrapping, fallback to recent candidates to ensure zero empty state
    if (titleResults.length === 0 && skillsResults.length === 0 && summaryResults.length === 0) {
      try {
        const recentCand = await ctx.db.query("candidates").order("desc").take(limit);
        titleResults = recentCand;
      } catch (e) {
        // Continue
      }
    }

    const resumeCandidateIds: { candidateId: Id<"candidates">; resumeId: Id<"candidateResumes"> }[] = [];
    for (const res of resumeResults) {
      resumeCandidateIds.push({ candidateId: res.candidateId, resumeId: res._id });
    }

    // Weighted scoring: title match > skills match > text match > summary match
    const weight = new Map<Id<"candidates">, number>();
    for (const cv of titleResults) weight.set(cv._id, (weight.get(cv._id) ?? 0) + 100);
    for (const cv of skillsResults) weight.set(cv._id, (weight.get(cv._id) ?? 0) + 90);
    for (const r of resumeCandidateIds) weight.set(r.candidateId, (weight.get(r.candidateId) ?? 0) + 50);
    for (const cv of summaryResults) weight.set(cv._id, (weight.get(cv._id) ?? 0) + 30);

    const seen = new Set<Id<"candidates">>();
    const merged: { candidateId: Id<"candidates"> }[] = [];
    for (const cv of titleResults) {
      if (!seen.has(cv._id)) {
        seen.add(cv._id);
        merged.push({ candidateId: cv._id });
      }
    }
    for (const cv of skillsResults) {
      if (!seen.has(cv._id)) {
        seen.add(cv._id);
        merged.push({ candidateId: cv._id });
      }
    }
    for (const r of resumeCandidateIds) {
      if (!seen.has(r.candidateId)) {
        seen.add(r.candidateId);
        merged.push({ candidateId: r.candidateId });
      }
    }
    for (const cv of summaryResults) {
      if (!seen.has(cv._id)) {
        seen.add(cv._id);
        merged.push({ candidateId: cv._id });
      }
    }

    // Apply optional simple filters in memory (Removed strict industry and seniority filters as they drop valid candidates due to enum mismatch. Let the LLM handle matching.)
    let filtered = merged;

    filtered.sort((a, b) => (weight.get(b.candidateId) ?? 0) - (weight.get(a.candidateId) ?? 0));
    return filtered.slice(0, limit).map(({ candidateId }) => ({ candidateId, score: weight.get(candidateId) ?? 0 }));
  },
});

type SearchInterpretation = {
  searchText: string;
  industry?: string;
  seniority?: string;
  minYears?: number;
  interpretation: string;
  keywords: string[];
};

export const aiSearch = action({
  args: {
    query: v.string(),
    industry: v.optional(v.string()),
    seniority: v.optional(v.string()),
    minExperience: v.optional(v.number()),
    maxExperience: v.optional(v.number()),
    location: v.optional(v.string()),
    education: v.optional(v.array(v.string())),
    sources: v.optional(v.array(v.string())),
    customFilters: v.optional(v.array(v.string())),
    limit: v.optional(v.number()),
  },
  handler: async (
    ctx,
    args
  ): Promise<{
    interpretation: SearchInterpretation;
    results: {
      candidateId: string;
      score: number;
      reason: string;
      breakdown?: {
        title: string;
        skills: string;
        experience: string;
        location: string;
        industry: string;
      };
    }[];
  }> => {
    const fetchLimit = 100;
    const isQueryEmpty = !args.query || !args.query.trim();
    const tokenLogs: any[] = [];

    let parsedReq: SearchRequirements;
    if (isQueryEmpty) {
      parsedReq = {
        title: "",
        alternativeTitles: [],
        occupationSynonyms: [],
        requiredSkills: [],
        preferredSkills: [],
        minYearsExperience: args.minExperience ?? null,
        industry: args.industry ?? null,
        seniority: args.seniority ?? null,
        location: args.location ?? null,
        education: null,
        summary: "Filter-only candidate search",
        keywords: [],
        languages: [],
        clientCompany: null,
        clientContactEmail: null,
        salaryRange: null,
      };
    } else {
      const parseResult = await extractSearchRequirements(args.query, "natural_language");
      parsedReq = parseResult.requirements;
      tokenLogs.push({
        taskType: "jd_extraction",
        model: parseResult.usage.model,
        promptTokens: parseResult.usage.promptTokens,
        completionTokens: parseResult.usage.completionTokens,
        success: true,
      });
    }

    const effectiveReq: SearchRequirements = {
      ...parsedReq,
      industry: args.industry ?? parsedReq.industry,
      seniority: args.seniority ?? parsedReq.seniority,
      location: args.location ?? parsedReq.location,
      minYearsExperience: (args.minExperience !== undefined && args.minExperience > 0) ? args.minExperience : (parsedReq.minYearsExperience ?? null),
    };

    const interp: SearchInterpretation = {
      searchText: isQueryEmpty ? "Filter Search" : [effectiveReq.title, ...effectiveReq.alternativeTitles, ...effectiveReq.requiredSkills.slice(0, 4)].filter(Boolean).join(" "),
      industry: effectiveReq.industry ?? undefined,
      seniority: effectiveReq.seniority ?? undefined,
      minYears: effectiveReq.minYearsExperience ?? undefined,
      interpretation: effectiveReq.summary,
      keywords: effectiveReq.keywords,
    };

    // 1. Embed query with a fallback
    let queryEmbedding: number[] | null = null;
    if (!isQueryEmpty) {
      try {
        const { embedText } = await import("./agent2.js");
        const embedResult = await embedText(args.query, "query");
        queryEmbedding = embedResult.embedding;
        tokenLogs.push({
          taskType: "embedding",
          model: embedResult.usage.model,
          promptTokens: embedResult.usage.promptTokens,
          completionTokens: 0,
          success: true,
        });
      } catch (err) {
        console.error("NVIDIA embedding call failed, falling back to keyword-only search:", err);
        queryEmbedding = null;
        tokenLogs.push({
          taskType: "embedding",
          model: "nvidia/llama-3.2-nv-embedqa-1b-v2",
          promptTokens: 0,
          completionTokens: 0,
          success: false,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    // 2. Run High-Recall Vector Search (Qdrant Primary with Convex Fail-Open Fallback)
    let vectorCandidateIds: { candidateId: Id<"candidates">; vectorScore: number }[] = [];

    if (queryEmbedding) {
      // Try Stage 1 High-Throughput Scan in Qdrant (top 200 vectors — capped to prevent DB timeout)
      try {
        const { queryCandidateVectors } = await import("../lib/qdrant.js");
        const qdrantMatches = await queryCandidateVectors(queryEmbedding, {
          limit: 200,
          minExperience: args.minExperience,
          locationCity: args.location,
          seniorityLevel: args.seniority,
        });

        if (qdrantMatches.length > 0) {
          vectorCandidateIds = qdrantMatches.map((m) => ({
            candidateId: m.candidateId as Id<"candidates">,
            vectorScore: m.score,
          }));
        }
      } catch (qdrantErr: any) {
        console.warn("[aiSearch] Qdrant search error, falling back to Convex native vectorSearch:", qdrantErr?.message);
        vectorCandidateIds = [];
      }

      // Convex Fallback if Qdrant returned 0 or was unreachable
      if (vectorCandidateIds.length === 0) {
        try {
          const vectorResults = await ctx.vectorSearch("candidateResumes", "vector_index_candidates", {
            vector: queryEmbedding,
            limit: fetchLimit,
          });

          if (vectorResults.length > 0) {
            const scoreByResumeId = new Map(vectorResults.map((r) => [r._id, r._score]));
            const mapped = await ctx.runQuery(internal.matching.queries.getCandidateIdsByResumeIds, {
              resumeIds: vectorResults.map((r) => r._id),
            });
            vectorCandidateIds = mapped.map((item: { resumeId: Id<"candidateResumes">; candidateId: Id<"candidates"> }) => ({
              candidateId: item.candidateId as Id<"candidates">,
              vectorScore: scoreByResumeId.get(item.resumeId as Id<"candidateResumes">) ?? 0,
            }));
          }
        } catch (convexVecErr: any) {
          console.warn("[aiSearch] Convex vectorSearch fallback notice:", convexVecErr?.message);
        }
      }
    }

    // Extract query terms for keyword search if query is empty
    const filterTerms: string[] = [];
    if (args.location) filterTerms.push(args.location);
    if (args.seniority) filterTerms.push(args.seniority);
    if (args.customFilters) filterTerms.push(...args.customFilters);
    if (args.education) filterTerms.push(...args.education);

    // 4. Keyword search batches - now return { candidateId, score }[]
    type KeywordSearchResult = { candidateId: Id<"candidates">; score: number };
    let searchBatches: KeywordSearchResult[][] = [];
    if (!isQueryEmpty) {
      const primaryTitle = effectiveReq.title && effectiveReq.title.length > 2 ? effectiveReq.title : args.query;
      const searchTerms = buildSearchTerms(effectiveReq, args.query);
      const queryList = new Set<string>();
      if (primaryTitle) queryList.add(primaryTitle);
      for (const alt of (effectiveReq.alternativeTitles ?? []).slice(0, 3)) if (alt) queryList.add(alt);
      for (const sk of (effectiveReq.requiredSkills ?? []).slice(0, 4)) if (sk) queryList.add(sk);
      for (const t of searchTerms.slice(0, 4)) if (t) queryList.add(t);

      const targetedQueries = Array.from(queryList).slice(0, 3);
      const batchQueries: Promise<KeywordSearchResult[]>[] = [];
      for (const qStr of targetedQueries) {
        batchQueries.push(
          ctx.runQuery(api.matching.search.searchCandidates, {
            query: qStr,
            industry: interp.industry,
            seniority: interp.seniority,
            limit: fetchLimit,
          })
        );
      }
      try {
        const settled = await Promise.allSettled(batchQueries);
        searchBatches = settled
          .filter((res): res is PromiseFulfilledResult<KeywordSearchResult[]> => res.status === "fulfilled")
          .map((res) => res.value);
      } catch (kwErr: any) {
        console.warn("[aiSearch] Keyword batch search notice:", kwErr?.message);
        searchBatches = [];
      }
    } else if (filterTerms.length > 0) {
      try {
        searchBatches = await Promise.all(
          filterTerms.slice(0, 3).map((term) =>
            ctx.runQuery(api.matching.search.searchCandidates, { query: term, limit: 50 })
          )
        );
      } catch (kwErr: any) {
        console.warn("[aiSearch] Keyword filter search notice:", kwErr?.message);
        searchBatches = [];
      }
    }

    // 5. Merge and deduplicate candidate IDs in memory
    const seen = new Set<Id<"candidates">>();
    const allCandidateIds: Id<"candidates">[] = [];
    const vectorScoreByCandidateId = new Map<Id<"candidates">, number>();

    for (const vc of vectorCandidateIds) {
      if (!seen.has(vc.candidateId)) {
        seen.add(vc.candidateId);
        allCandidateIds.push(vc.candidateId);
        vectorScoreByCandidateId.set(vc.candidateId, vc.vectorScore);
      }
    }

    for (const batch of searchBatches.flat()) {
      if (batch && !seen.has(batch.candidateId)) {
        seen.add(batch.candidateId);
        allCandidateIds.push(batch.candidateId);
        vectorScoreByCandidateId.set(batch.candidateId, 0); // keyword-only match, no vector score
      }
    }

    // 6. Batch fetch lightweight candidate summary projections in a single query
    // Cap to 200 to prevent Convex system operation timeouts on large result sets
    const batchedCandidateIds = allCandidateIds.slice(0, 200);
    let candidates: any[] = [];
    if (batchedCandidateIds.length > 0) {
      candidates = await ctx.runQuery(internal.matching.queries.getCandidatesSummaryBatch, {
        candidateIds: batchedCandidateIds,
      });
    }

    // Fallback: If no results found and query is empty, query recently active candidates
    if (candidates.length === 0 && isQueryEmpty) {
      candidates = await ctx.runQuery(api.matching.queries.getRecentCandidates, { limit: 100 });
    }

    if (candidates.length === 0) {
      return { interpretation: interp, results: [] };
    }

    // 7. Reconstruct rawResults with full candidate documents and vector scores
    type ScoredCandidateDoc = Doc<"candidates"> & { vectorScore?: number };
    const rawResults: ScoredCandidateDoc[] = candidates.map((c) => ({
      ...c,
      vectorScore: vectorScoreByCandidateId.get(c._id),
    }));

    const applyFiltersStrictly = (candidatesList: ScoredCandidateDoc[]) => {
      let list = candidatesList;
      if (args.location) {
        const searchLoc = args.location.toLowerCase().trim();
        if (searchLoc) {
          list = list.filter((c) => {
            const dbLoc = (c.location || "").toLowerCase();
            if (searchLoc === "remote") {
              return (
                dbLoc.includes("remote") ||
                dbLoc.includes("wfh") ||
                dbLoc.includes("home") ||
                dbLoc.includes("work from home")
              );
            }
            return dbLoc.includes(searchLoc);
          });
        }
      }

      if (args.seniority) {
        const searchSeniority = args.seniority.toLowerCase().trim();
        list = list.filter((c) => {
          const dbLevel = (c.seniorityLevel || "").toLowerCase();
          const currentTitle = (c.currentJobTitle || c.currentTitle || "").toLowerCase();
          const histTitles = ((c as any).pastJobTitles || []).map((t: string) => (t || "").toLowerCase());
          const allTitles = [currentTitle, ...histTitles];

          if (searchSeniority === "senior") {
            return (
              dbLevel.includes("senior") ||
              dbLevel.includes("snr") ||
              allTitles.some((t) => t.includes("senior") || t.includes("snr") || t.includes("sr "))
            );
          }
          if (searchSeniority === "lead") {
            return (
              dbLevel.includes("lead") ||
              dbLevel.includes("principal") ||
              dbLevel.includes("executive") ||
              allTitles.some((t) =>
                t.includes("lead") ||
                t.includes("principal") ||
                t.includes("head") ||
                t.includes("manager") ||
                t.includes("director") ||
                t.includes("vp") ||
                t.includes("chief") ||
                t.includes("cto") ||
                t.includes("ceo") ||
                t.includes("coo")
              )
            );
          }
          return true;
        });
      }

      if (args.minExperience !== undefined && args.minExperience > 0) {
        list = list.filter((c) => {
          const exp = c.totalExperienceYears ?? c.yearsOfExperience;
          if (exp === undefined || exp === null) return true;
          return exp >= args.minExperience!;
        });
      }

      if (args.maxExperience !== undefined && args.maxExperience < 20) {
        list = list.filter((c) => {
          const exp = c.totalExperienceYears ?? c.yearsOfExperience;
          if (exp === undefined || exp === null) return true;
          return exp <= args.maxExperience!;
        });
      }

      if (args.education && args.education.length > 0) {
        list = list.filter((c) => {
          const degrees = [
            c.educationDegree || "",
            ...(c.education || []).map((edu: any) => edu.degree || ""),
          ].map((d) => d.toLowerCase());

          return args.education!.some((edu) => {
            if (edu === "Bachelor") {
              return degrees.some(
                (degree) =>
                  degree.includes("bachelor") ||
                  degree.includes("bsc") ||
                  degree.includes("ba") ||
                  degree.includes("b.tech") ||
                  degree.includes("b.e.") ||
                  degree.includes("b.a.") ||
                  degree.includes("b.s.")
              );
            }
            if (edu === "Masters") {
              return degrees.some(
                (degree) =>
                  degree.includes("master") ||
                  degree.includes("msc") ||
                  degree.includes("ma") ||
                  degree.includes("mba") ||
                  degree.includes("m.tech") ||
                  degree.includes("m.s.") ||
                  degree.includes("m.phil")
              );
            }
            return degrees.some((degree) => degree.includes(edu.toLowerCase()));
          });
        });
      }

      if (args.sources && args.sources.length > 0) {
        list = list.filter((c) => {
          const source = (c.sourceChannel || c.firstSourceChannel || "").toLowerCase();
          return args.sources!.some((s) => {
            const filterSrc = s.toLowerCase();
            if (filterSrc === "whatsapp") {
              return source === "whatsapp" || source === "meta_campaign";
            }
            return source === filterSrc;
          });
        });
      }

      if (args.customFilters && args.customFilters.length > 0) {
        list = list.filter((c) => {
          const skills = (c.skills || []).map((s) =>
            (typeof s === "string" ? s : (s as any).value || "").toLowerCase()
          );
          const certs = (c.certifications || []).map((cert) => cert.toLowerCase());
          const summary = (c.summary || "").toLowerCase();
          const fullName = (c.fullName || "").toLowerCase();

          return args.customFilters!.every((filter) => {
            const search = filter.toLowerCase().trim();
            if (!search) return true;
            return (
              skills.some((s) => s.includes(search)) ||
              certs.some((cert) => cert.includes(search)) ||
              summary.includes(search) ||
              fullName.includes(search)
            );
          });
        });
      }

      return list;
    };

    // Apply strict filtering first
    let filteredResults = applyFiltersStrictly(rawResults);

    // Progressive Narrowing Fallback:
    // If strict filtering yields zero candidates, fallback to raw results
    // and let the heuristic matching engine score and sort them.
    if (filteredResults.length === 0) {
      console.log("Strict filters returned 0 candidates. Falling back to progressive soft match.");
      filteredResults = rawResults;
    }

    // Score all candidate matches across title, skills, experience, and domain
    const ranked = filteredResults
      .map((cv: ScoredCandidateDoc, index: number) => scoreCandidateAgainstRequirements(cv as any, effectiveReq, index))
      .sort((a: ScoredCandidate, b: ScoredCandidate) =>
        (b.overallScore - a.overallScore) ||
        (b.titleScore - a.titleScore) ||
        (b.skillScore - a.skillScore) ||
        (b.experienceScore - a.experienceScore)
      );

    // LLM-based re-scoring for candidates (skip if query is empty)
    let finalRanked: typeof ranked = [];
    if (!isQueryEmpty) {
      // Deterministic Score Gating:
      // 1. High confidence matches (>= 85%): Zero-token bypass with auto-template
      // 2. Low confidence matches (< 50%): Zero-token bypass
      // 3. Ambiguous score range (50%-84%): Single-call batch LLM scoring (max 10)
      const highConfidence: typeof ranked = [];
      const lowConfidence: typeof ranked = [];
      const ambiguousPool: typeof ranked = [];

      for (const candidate of ranked) {
        if (candidate.overallScore >= 85) {
          highConfidence.push({
            ...candidate,
            llmScore: {
              score: candidate.overallScore,
              reason: buildDeterministicTaReason(candidate, effectiveReq),
            },
          });
        } else if (candidate.overallScore < 50) {
          lowConfidence.push({
            ...candidate,
            llmScore: {
              score: candidate.overallScore,
              reason: buildDeterministicTaReason(candidate, effectiveReq),
            },
          });
        } else {
          ambiguousPool.push(candidate);
        }
      }

      const batchToScore = ambiguousPool.slice(0, 10);
      const remainingAmbiguous = ambiguousPool.slice(10).map((c) => ({
        ...c,
        llmScore: {
          score: c.overallScore,
          reason: buildDeterministicTaReason(c, effectiveReq),
        },
      }));

      let scoredAmbiguousBatch: typeof batchToScore = [];
      if (batchToScore.length > 0) {
        try {
          const { evaluations, usage } = await scoreBatchWithLLM(batchToScore, effectiveReq, "search_ranking");
          tokenLogs.push({
            taskType: "search_ranking",
            model: usage.model,
            promptTokens: usage.promptTokens,
            completionTokens: usage.completionTokens,
            success: true,
            provider: "nvidia",
          });

          scoredAmbiguousBatch = batchToScore.map((c) => {
            const evalResult = evaluations.get(c.index);
            const score = evalResult ? evalResult.score : c.overallScore;
            const reason = evalResult ? evalResult.reason : buildDeterministicTaReason(c, effectiveReq);
            return {
              ...c,
              llmScore: { score, reason },
            };
          });
        } catch (err) {
          tokenLogs.push({
            taskType: "search_ranking",
            model: "meta/llama-3.1-70b-instruct",
            promptTokens: 0,
            completionTokens: 0,
            success: false,
            error: err instanceof Error ? err.message : String(err),
            provider: "nvidia",
          });
          scoredAmbiguousBatch = batchToScore.map((c) => ({
            ...c,
            llmScore: { score: c.overallScore, reason: buildDeterministicTaReason(c, effectiveReq) },
          }));
        }
      }

      finalRanked = [...highConfidence, ...scoredAmbiguousBatch, ...remainingAmbiguous, ...lowConfidence]
        .sort((a, b) =>
          (Number(b.llmScore?.score ?? 0) - Number(a.llmScore?.score ?? 0)) ||
          ((b.cv as any).vectorScore ?? 0) - ((a.cv as any).vectorScore ?? 0) || // Tie-breaker 1: Vector score
          (b.overallScore - a.overallScore) ||                                   // Tie-breaker 2: Heuristics
          (a.locationStatus === "match" ? 1 : 0) - (b.locationStatus === "match" ? 1 : 0)
        );
    } else {
      // Filter-only search: skip LLM and sort by overall score
      finalRanked = ranked.map((c) => ({
        ...c,
        llmScore: { score: c.overallScore, reason: buildDeterministicTaReason(c, effectiveReq) },
      })).sort((a, b) => b.overallScore - a.overallScore);
    }

    const results = finalRanked
      .filter((item) => {
        const sc = item.llmScore?.score !== undefined ? Number(item.llmScore.score) : item.overallScore;
        return sc > 0;
      })
      .slice(0, args.limit ?? 40)
      .map((item) => {
        const displayScore = item.llmScore?.score ? Math.round(Number(item.llmScore.score)) : Math.round(item.overallScore);
        const displayReason = item.llmScore?.reason || item.reason || buildDeterministicTaReason(item, effectiveReq);

        return {
          candidateId: item.cv._id,
          score: displayScore,
          reason: displayReason,
          breakdown: {
            title: item.titleScore >= 90 ? "strong match" : item.titleScore >= 70 ? "partial match" : "loose match",
            skills: item.skillScore >= 80 ? "strong match" : item.skillScore >= 50 ? "partial match" : "loose match",
            experience: effectiveReq.minYearsExperience != null ? (
              ((item.cv as any).yearsOfExperience ?? (item.cv as any).totalExperienceYears ?? 0) >= effectiveReq.minYearsExperience
                ? "meets target" : "below range"
            ) : "not specified",
            location: item.locationStatus === "match" ? "match" : item.locationStatus === "different" ? "different" : "not specified",
            industry: item.industryScore === 100 ? "match" : "different",
          }
        };
      });

    if (tokenLogs.length > 0) {
      try {
        await ctx.runMutation(internal.stats.stats.logNvidiaCallsBatchMutation, {
          logs: tokenLogs,
        });
      } catch (logErr) {
        console.error("Failed to write token logs for aiSearch:", logErr);
      }
    }

    return { interpretation: interp, results };
  },
});

export const parseNLQuery = action({
  args: { query: v.string() },
  handler: async (ctx, args) => {
    const { executeLLMWithNvidiaFallback } = await import("../lib/llm");

    const FILTER_SCHEMA = {
      skills: ["string"],
      minYearsExperience: "number",
      maxYearsExperience: "number",
      location: "string",
      currentJobTitle: "string",
      seniority: "Junior | Mid | Senior | Lead | Director",
    };

    const { content } = await executeLLMWithNvidiaFallback(ctx, "jd_extraction", {
      messages: [{
        role: "user",
        content: `Extract search filters from this query as JSON: "${args.query}"\nSchema: ${JSON.stringify(FILTER_SCHEMA)}\nRespond ONLY with valid JSON. Do not add markdown backticks.`
      }],
      temperature: 0,
      max_tokens: 500,
      response_format: { type: "json_object" },
    });

    try {
      return JSON.parse(content || "{}");
    } catch (e) {
      console.error("Failed to parse LLM response:", e);
      return {};
    }
  },
});

export const semanticSearch = action({
  args: { 
    query: v.string(),
    limit: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    // 1. Embed query
    const { embedText } = await import("./agent2.js");
    let queryEmbedding: number[];
    try {
      const embedResult = await embedText(args.query);
      queryEmbedding = embedResult.embedding;

      await ctx.runMutation(internal.stats.stats.logNvidiaCallsBatchMutation, {
        logs: [
          {
            taskType: "embedding",
            model: embedResult.usage.model,
            promptTokens: embedResult.usage.promptTokens,
            completionTokens: 0,
            success: true,
          }
        ]
      });
    } catch (err) {
      await ctx.runMutation(internal.stats.stats.logNvidiaCallsBatchMutation, {
        logs: [
          {
            taskType: "embedding",
            model: "nvidia/llama-3.2-nv-embedqa-1b-v2",
            promptTokens: 0,
            completionTokens: 0,
            success: false,
            error: err instanceof Error ? err.message : String(err),
          }
        ]
      });
      throw err;
    }

    // 2. Vector search
    const results = await ctx.vectorSearch("candidateResumes", "vector_index_candidates", {
      vector: queryEmbedding,
      limit: args.limit ?? 100,
    });

    if (!results.length) return [];

    const mappedResumes = await ctx.runQuery(internal.matching.queries.getCandidatesByResumeIds, {
      resumeIds: results.map(r => r._id)
    });
    const resumeIdToCandidateId = new Map(mappedResumes.map((item: any) => [item.resumeId, item.candidate._id]));
    
    const mappedResults: any[] = results.map((r: any, i: number) => {
      const candidateId = resumeIdToCandidateId.get(r._id);
      return {
        candidateId,
        matchScore: Math.round(r._score * 100),
        matchReason: `Semantic match based on vector similarity (${(r._score * 100).toFixed(1)}%)`,
      };
    }).filter(r => !!r.candidateId);

    // 3. Return IDs and scores
    return mappedResults;
  }
});

import { mutation } from "../_generated/server";
export const bulkAddToPipeline = mutation({
  args: {
    candidateIds: v.array(v.id("candidates")),
    jobId: v.id("jobs"),
    sourceChannel: v.string(),
    stage: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    // Basic bulk insert to applications
    for (const candidateId of args.candidateIds) {
      // Check existing
      const existing = await ctx.db.query("applications")
        .withIndex("by_candidate_job", q => q.eq("candidateId", candidateId).eq("jobId", args.jobId))
        .first();
        
      if (!existing) {
        const isDatabaseOrManual = 
          args.sourceChannel === "database" ||
          (typeof args.sourceChannel === "string" && (
            args.sourceChannel.toLowerCase().includes("manual") ||
            args.sourceChannel.toLowerCase().includes("directory") ||
            args.sourceChannel.toLowerCase().includes("folder")
          ));
        const defaultStage = isDatabaseOrManual ? "matched_candidates" : "new_cvs";

        await ctx.db.insert("applications", {
          candidateId,
          jobId: args.jobId,
          sourceChannel: args.sourceChannel,
          currentStage: (args.stage ?? defaultStage) as any,
          loopIteration: 0,
          isActive: true,
          createdAt: Date.now(),
          lastStageChangedAt: Date.now(),
        });
      }
    }
  }
});
