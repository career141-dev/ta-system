// @ts-nocheck
import { getOpenAI, getNvidiaOpenAI, getModelForTask, OPENROUTER_PRIMARY_MODEL } from "./llm";

function distinct(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

export type SearchRequirements = {
  title: string;
  alternativeTitles: string[];
  occupationSynonyms: string[];
  requiredSkills: string[];
  preferredSkills: string[];
  minYearsExperience: number | null;
  maxYearsExperience?: number | null;
  industry: string | null;
  seniority: string | null;
  location: string | null;
  education: string | null;
  summary: string;
  keywords: string[];
  languages: string[];
  clientCompany: string | null;
  clientContactEmail: string | null;
  salaryRange: string | null;
};

function normalizeRequirements(req: SearchRequirements): SearchRequirements {
  return {
    ...req,
    title: req.title || "Position",
    alternativeTitles: distinct(req.alternativeTitles ?? []),
    occupationSynonyms: distinct(req.occupationSynonyms ?? []),
    requiredSkills: distinct(req.requiredSkills ?? []),
    preferredSkills: distinct(req.preferredSkills ?? []),
    keywords: distinct(req.keywords ?? []),
  };
}

export async function extractSearchRequirements(
  text: string,
  kind: "job_description" | "natural_language"
): Promise<{
  requirements: SearchRequirements;
  usage: { promptTokens: number; completionTokens: number; model: string };
}> {
  const prompt =
    kind === "job_description"
      ? `You are a recruitment analyst. Extract the main hiring requirements from this job description.
Focus on the signals that matter most for candidate matching. Be inclusive, not overly strict.
Return ONLY valid JSON with these fields:
{
  "title": "best matching role title",
  "alternativeTitles": ["closely related role title 1", "closely related role title 2"],
  "occupationSynonyms": ["truly equivalent role titles that someone in this occupation might use on their CV — not seniority variations, but fundamentally the same job under a different name"],
  "requiredSkills": ["core skills that strongly matter for the role"],
  "preferredSkills": ["nice-to-have or supporting skills"],
  "minYearsExperience": number or null,
  "industry": "industry or null",
  "seniority": "junior, mid, senior, lead, executive, or null",
  "location": "location or null",
  "education": "education requirement or null",
  "summary": "one sentence summary of the role",
  "keywords": ["important keywords, tools, frameworks, company names, brands, certifications, acronyms"],
  "languages": ["required languages e.g. English, Arabic"],
  "clientCompany": "company name if mentioned, or null",
  "clientContactEmail": "email address if mentioned, or null",
  "salaryRange": "salary range if mentioned e.g. 200k - 300k LKR, or null"
}
If a skill is implied by the role and clearly important, include it in requiredSkills even if not explicitly written. Do not over-prune skills.
For occupationSynonyms, include alternative job titles that represent the same occupation as the primary title — not seniority variations, but genuinely equivalent role names a candidate might use on their CV. For example for "Accountant" include ["Finance Officer", "Accounts Executive"].`
      : `You are a talent search assistant. Extract the main candidate-match requirements from this search query.
Interpret the query generously and keep useful context rather than stripping it away.
Return ONLY valid JSON with these fields:
{
  "title": "best matching role title or target profile",
  "alternativeTitles": ["related role title 1", "related role title 2"],
  "occupationSynonyms": ["truly equivalent role titles that someone in this occupation might use on their CV — not seniority variations, but fundamentally the same job under a different name"],
  "requiredSkills": ["core skills explicitly or implicitly requested"],
  "preferredSkills": ["supporting skills or nice-to-have signals"],
  "minYearsExperience": number or null,
  "industry": "industry or null",
  "seniority": "junior, mid, senior, lead, executive, or null",
  "location": "location or null",
  "education": "education requirement or null",
  "summary": "one sentence summary of the search intent",
  "keywords": ["important keywords, tools, frameworks, company names, brands, certifications, acronyms"],
  "languages": ["required languages"],
  "clientCompany": "company name if mentioned, or null",
  "clientContactEmail": "email address if mentioned, or null",
  "salaryRange": "salary range if mentioned, or null"
}
If the query is vague, infer the most likely role and include likely related skills so the search remains broad enough.
For occupationSynonyms, include alternative job titles that represent the same occupation as the primary title — not seniority variations, but genuinely equivalent role names a candidate might use on their CV.`;

  const candidateProviders = [
    { client: getOpenAI("jd_extraction"), model: OPENROUTER_PRIMARY_MODEL, isNvidia: false },
    { client: getNvidiaOpenAI(), model: "meta/llama-3.1-70b-instruct", isNvidia: true },
  ];

  for (const provider of candidateProviders) {
    try {
      const response = await provider.client.chat.completions.create({
        model: provider.model,
        temperature: 0.1,
        max_tokens: 1400,
        messages: [
          { role: "system", content: prompt },
          { role: "user", content: text.slice(0, 7000) },
        ],
      });

      const inputTokens = response.usage?.prompt_tokens || 0;
      const outputTokens = response.usage?.completion_tokens || 0;
      let content = response.choices[0]?.message?.content ?? "{}";

      // Clean any markdown formatting if present
      content = content.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim();

      const parsed = JSON.parse(content) as Partial<SearchRequirements>;
      if (parsed && (parsed.title || (parsed.requiredSkills && parsed.requiredSkills.length > 0))) {
        return {
          requirements: normalizeRequirements({
            title: parsed.title && parsed.title !== "Position" ? parsed.title : text.slice(0, 60),
            alternativeTitles: parsed.alternativeTitles ?? [],
            requiredSkills: parsed.requiredSkills ?? [],
            preferredSkills: parsed.preferredSkills ?? [],
            minYearsExperience: typeof parsed.minYearsExperience === "number" ? parsed.minYearsExperience : null,
            industry: parsed.industry ?? null,
            seniority: parsed.seniority ?? null,
            location: parsed.location ?? null,
            education: parsed.education ?? null,
            summary: parsed.summary ?? text.slice(0, 120),
            occupationSynonyms: parsed.occupationSynonyms ?? [],
            keywords: parsed.keywords ?? [],
            languages: parsed.languages ?? [],
            clientCompany: parsed.clientCompany ?? null,
            clientContactEmail: parsed.clientContactEmail ?? null,
            salaryRange: parsed.salaryRange ?? null,
          }),
          usage: {
            promptTokens: inputTokens,
            completionTokens: outputTokens,
            model: provider.model,
          },
        };
      }
    } catch (providerErr: any) {
      console.warn(`[extractSearchRequirements] Provider ${provider.model} notice:`, providerErr?.message || providerErr);
    }
  }

  // Dynamic regex / token fallback if all LLM endpoints fail
  const words = text.replace(/[^a-zA-Z0-9+#.\s]/g, " ").split(/\s+/).filter(w => w.length >= 3);
  return {
    requirements: normalizeRequirements({
      title: text.slice(0, 60),
      alternativeTitles: [],
      requiredSkills: words.slice(0, 8),
      preferredSkills: [],
      minYearsExperience: null,
      industry: null,
      seniority: null,
      location: null,
      education: null,
      summary: text.slice(0, 120),
      occupationSynonyms: [],
      keywords: words.slice(0, 10),
      languages: [],
      clientCompany: null,
      clientContactEmail: null,
      salaryRange: null,
    }),
    usage: {
      promptTokens: 0,
      completionTokens: 0,
      model: "regex-fallback",
    },
  };
}

export function buildSearchTerms(req: SearchRequirements, sourceText: string): string[] {
  // Filter required skills to remove filler words or long sentences
  const cleanSkills = (req.requiredSkills ?? [])
    .map((s) => s.replace(/^\*\s*/, "").trim())
    .filter((s) => s.length > 2 && s.length < 40 && !/^(developing|managing|handling|working|supporting|proven|strong|experience)$/i.test(s));

  return distinct([
    req.title,
    ...req.alternativeTitles.slice(0, 4),
    ...req.occupationSynonyms.slice(0, 4),
    ...cleanSkills.slice(0, 6),
    ...req.preferredSkills.filter((s) => s.length < 35).slice(0, 3),
    ...req.keywords.slice(0, 6),
  ]).slice(0, 10);
}
