import { v } from "convex/values";
import { action, internalMutation, internalQuery } from "../_generated/server";
import { internal } from "../_generated/api";
import { resolveLocationViaGazetteer, type StructuredLocation } from "./gazetteer";
import { executeLLMWithNvidiaFallback } from "./llm";

export const getCachedLocation = internalQuery({
  args: {
    rawTextNormalized: v.string(),
  },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("locationResolutionCache")
      .withIndex("by_rawTextNormalized", (q) =>
        q.eq("rawTextNormalized", args.rawTextNormalized)
      )
      .first();
  },
});

export const saveCachedLocation = internalMutation({
  args: {
    rawTextNormalized: v.string(),
    city: v.union(v.string(), v.null()),
    region: v.union(v.string(), v.null()),
    country: v.union(v.string(), v.null()),
    resolvedVia: v.union(v.literal("gazetteer"), v.literal("llm_fallback")),
  },
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query("locationResolutionCache")
      .withIndex("by_rawTextNormalized", (q) =>
        q.eq("rawTextNormalized", args.rawTextNormalized)
      )
      .first();

    if (!existing) {
      await ctx.db.insert("locationResolutionCache", {
        rawTextNormalized: args.rawTextNormalized,
        city: args.city,
        region: args.region,
        country: args.country,
        resolvedVia: args.resolvedVia,
        createdAt: Date.now(),
      });
    }
  },
});

/**
 * Resolves a raw location string into structured location:
 * { raw_text: string, city: string | null, region: string | null, country: string | null }
 * 
 * Strategy:
 * 1. Check Convex cache (locationResolutionCache)
 * 2. Static Gazetteer lookup (resolveLocationViaGazetteer)
 * 3. DeepSeek LLM fallback via OpenRouter (cv_location_resolution)
 */
export const resolveCandidateLocationAction = action({
  args: {
    rawText: v.string(),
  },
  handler: async (ctx, args): Promise<StructuredLocation> => {
    return await resolveCandidateLocation(ctx, args.rawText);
  },
});

export async function resolveCandidateLocation(
  ctx: any,
  rawText: string
): Promise<StructuredLocation> {
  const defaultFallback: StructuredLocation = {
    raw_text: rawText,
    city: null,
    region: null,
    country: null,
  };

  if (!rawText || typeof rawText !== "string" || !rawText.trim()) {
    return defaultFallback;
  }

  const rawTextNormalized = rawText.trim().toLowerCase();

  // 1. Check Convex Cache
  const cached: any = await ctx.runQuery(internal.lib.locationResolver.getCachedLocation, {
    rawTextNormalized,
  });

  if (cached) {
    return {
      raw_text: rawText,
      city: cached.city ?? null,
      region: cached.region ?? null,
      country: cached.country ?? null,
    };
  }

  // 2. Static Gazetteer Lookup
  const gazetteerResult = resolveLocationViaGazetteer(rawText);
  if (gazetteerResult && (gazetteerResult.country || gazetteerResult.city)) {
    await ctx.runMutation(internal.lib.locationResolver.saveCachedLocation, {
      rawTextNormalized,
      city: gazetteerResult.city,
      region: gazetteerResult.region,
      country: gazetteerResult.country,
      resolvedVia: "gazetteer",
    });
    return gazetteerResult;
  }

  // 3. Fallback: DeepSeek via OpenRouter (taskType: cv_location_resolution)
  try {
    const prompt = `Identify the country, region/state/province (if applicable), and city from the location text below.

Target Location Text: "${rawText.slice(0, 300)}"

CRITICAL INSTRUCTIONS:
1. Return ONLY valid JSON matching this schema:
{
  "city": "City or town name, or null",
  "region": "State, province, or division name, or null",
  "country": "Canonical country name, or null"
}
2. Respond with JSON ONLY. Do not add markdown codeblocks, preambles, or notes.`;

    const { content } = await executeLLMWithNvidiaFallback(ctx, "cv_location_resolution", {
      messages: [
        { role: "system", content: "You are a precise geographical location resolver. Output strictly valid JSON." },
        { role: "user", content: prompt },
      ],
      temperature: 0.0,
      response_format: { type: "json_object" },
    });

    const parsed = JSON.parse(content.trim().replace(/^```json\s*/i, "").replace(/```$/i, "").trim());

    const resolved: StructuredLocation = {
      raw_text: rawText,
      city: typeof parsed.city === "string" && parsed.city.trim() ? parsed.city.trim() : null,
      region: typeof parsed.region === "string" && parsed.region.trim() ? parsed.region.trim() : null,
      country: typeof parsed.country === "string" && parsed.country.trim() ? parsed.country.trim() : null,
    };

    await ctx.runMutation(internal.lib.locationResolver.saveCachedLocation, {
      rawTextNormalized,
      city: resolved.city,
      region: resolved.region,
      country: resolved.country,
      resolvedVia: "llm_fallback",
    });

    return resolved;
  } catch (err) {
    console.warn(`[resolveCandidateLocation] LLM fallback error for "${rawText}":`, err);
    return defaultFallback;
  }
}
