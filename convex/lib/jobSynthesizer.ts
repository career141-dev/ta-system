import { getOpenAI, getModelForTask } from "./llm";

export type SynthesizedJobRequirements = {
  primaryRoleTitle: string;
  targetDomain: string;
  coreDomainSkills: string[];
  generalCommercialSkills: string[];
  distractorWordsToIgnore: string[];
  synthesizedEmbeddingPrompt: string;
  domainGateRules: string;
};

/**
 * Perform holistic AI requirement synthesis on job description and required skills.
 * Understands full sentences, paragraphs, and punctuation. Distinguishes filler verbs
 * (e.g. "developing", "handling", "managing") from actual domain competencies (e.g. "Tea Trading", "Tea Exports").
 */
export async function synthesizeJobRequirements(job: {
  title: string;
  jobDescription: string;
  requiredSkills?: string[];
  niceToHaveSkills?: string[];
  clientIndustry?: string | null;
  seniorityLevel?: string | null;
  taPreferences?: string | null;
}): Promise<SynthesizedJobRequirements> {
  const model = getModelForTask("jd_extraction");
  const openai = getOpenAI("jd_extraction");

  const rawInput = `
JOB TITLE: ${job.title}
CLIENT INDUSTRY: ${job.clientIndustry ?? "Not specified"}
SENIORITY LEVEL: ${job.seniorityLevel ?? "Not specified"}

REQUIRED SKILLS / QUALIFICATIONS (may be sentences, bullets, or paragraphs):
${(job.requiredSkills ?? []).map((s) => `- ${s}`).join("\n")}

NICE TO HAVE SKILLS:
${(job.niceToHaveSkills ?? []).map((s) => `- ${s}`).join("\n")}

TA RECRUITER PREFERENCES:
${job.taPreferences ?? "None"}

FULL JOB DESCRIPTION:
${job.jobDescription.slice(0, 3500)}
`;

  const systemPrompt = `You are a Senior Executive Recruiter and NLP Intelligence System.
Your job is to read and comprehend the provided Job Description, Required Skills, and Punctuation/Sentences HOLISTICALLY as a human expert recruiter.

Do NOT treat general English filler verbs (such as "developing", "managing", "handling", "working with", "supporting", "leading") as required technical skills or search keywords!
For example:
- In "Experience developing new business in tea trading", the core skill is "Tea Trading" and "New Business Development". "Developing" is just a filler verb.
- In "Responsible for handling export documentation", the core skill is "Export Documentation". "Handling" is a filler verb.

Read the entire context carefully and extract:
1. "primaryRoleTitle": The standard, canonical job title (e.g., "Tea Trader", "Export Sales Manager").
2. "targetDomain": The core industry domain or product specialization (e.g., "Tea Export & Trading", "Semiconductor Manufacturing", "Aviation Logistics").
3. "coreDomainSkills": 3-8 clean, concise domain-specific hard skills / qualifications MUST HAVE (e.g., ["Tea Trading", "Tea Exports", "Tea Auctions", "Tea Tasting", "Export Documentation"]). NEVER include filler verbs like "developing" or "managing" alone.
4. "generalCommercialSkills": Secondary general competencies (e.g., ["Negotiation", "Account Management", "International Client Sales"]).
5. "distractorWordsToIgnore": General English verbs or ambiguous words in the sentences that should NEVER be used as standalone keyword search terms (e.g., ["developing", "handling", "managing", "working", "proven"]).
6. "synthesizedEmbeddingPrompt": A comprehensive, 2-3 sentence holistic summary of the ideal candidate background, combining domain, role, experience, and core skills, designed for vector semantic search.
7. "domainGateRules": A 1-sentence explicit constraint detailing mandatory domain experience (e.g., "Must have direct professional experience in tea trading, tea export, or tea plantation industry").

Return ONLY valid JSON matching this schema:
{
  "primaryRoleTitle": "string",
  "targetDomain": "string",
  "coreDomainSkills": ["string"],
  "generalCommercialSkills": ["string"],
  "distractorWordsToIgnore": ["string"],
  "synthesizedEmbeddingPrompt": "string",
  "domainGateRules": "string"
}`;

  try {
    const response = await openai.chat.completions.create({
      model,
      temperature: 0.1,
      max_tokens: 1000,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: rawInput },
      ],
      response_format: { type: "json_object" },
    });

    const content = response.choices[0]?.message?.content ?? "{}";
    const parsed = JSON.parse(content) as Partial<SynthesizedJobRequirements>;

    const coreDomainSkills = (parsed.coreDomainSkills ?? [])
      .map((s) => s.trim())
      .filter((s) => s.length > 1 && !/^(developing|managing|handling|working|supporting|proven|strong|experience)$/i.test(s));

    return {
      primaryRoleTitle: parsed.primaryRoleTitle || job.title,
      targetDomain: parsed.targetDomain || job.clientIndustry || "General Industry",
      coreDomainSkills: coreDomainSkills.length > 0 ? coreDomainSkills : [job.title],
      generalCommercialSkills: parsed.generalCommercialSkills ?? [],
      distractorWordsToIgnore: parsed.distractorWordsToIgnore ?? ["developing", "managing", "handling", "working"],
      synthesizedEmbeddingPrompt:
        parsed.synthesizedEmbeddingPrompt ||
        `Seeking a ${job.title} with experience in ${job.clientIndustry || "the industry"} and skills in ${(job.requiredSkills || []).slice(0, 3).join(", ")}.`,
      domainGateRules:
        parsed.domainGateRules ||
        `Must have relevant domain experience related to ${job.title} and ${job.clientIndustry || "the role"}.`,
    };
  } catch (error) {
    console.error("Failed to synthesize job requirements with LLM, falling back to heuristics:", error);
    
    // Heuristic fallback: clean raw skills by stripping common filler prefixes
    const cleanedSkills = (job.requiredSkills ?? [])
      .map((s) => s.replace(/^\*\s*/, "").replace(/^(Minimum|Proven|Strong|Experience)\s+\d+[-–]\d+\s+years['’]?\s+(experience\s+in\s+)?/i, "").trim())
      .filter((s) => s.length > 2 && s.length < 50);

    return {
      primaryRoleTitle: job.title,
      targetDomain: job.clientIndustry || "General Industry",
      coreDomainSkills: cleanedSkills.length > 0 ? cleanedSkills : [job.title],
      generalCommercialSkills: job.niceToHaveSkills ?? [],
      distractorWordsToIgnore: ["developing", "managing", "handling", "working"],
      synthesizedEmbeddingPrompt: `Role: ${job.title}. Industry: ${job.clientIndustry || ""}. Skills: ${(job.requiredSkills || []).join(", ")}. ${job.jobDescription.slice(0, 500)}`,
      domainGateRules: `Must have professional experience in ${job.title} or ${job.clientIndustry || "the domain"}.`,
    };
  }
}
