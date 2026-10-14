// @ts-nocheck
import { getOpenAI, getNvidiaOpenAI, getModelForTask, OPENROUTER_PRIMARY_MODEL } from "./llm";
import { askClaudeFirst, claudeBudgetMs } from "./claudeFirst";
import { employersInText } from "./employers";
import type { SearchOccupation } from "./searchRoleEvidence";

function distinct(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

export type SearchRequirements = {
  searchOccupation?: SearchOccupation;
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
  /**
   * Companies the CANDIDATE works or worked at, as the searcher named them,
   * then a few common spellings ("Dialog", "Dialog Axiata"). Not the hiring
   * client: that is clientCompany. Optional, because job descriptions and
   * older callers never set it (9 Oct).
   */
  employers?: string[];
  /** Companies the candidate must not be at now ("not from Dialog"). */
  excludeEmployers?: string[];
  /** "current" when only people there now are wanted ("currently at Dialog"); else "any". */
  employerScope?: "current" | "any";
};

/** Words that limit a company to people there today: "currently at Dialog", "still at MAS". */
const SAYS_NOW = /\b(currently|presently|now|at present|still|current employer)\b/i;

function normalizeRequirements(req: SearchRequirements): SearchRequirements {
  return {
    ...req,
    title: req.title || "Position",
    alternativeTitles: distinct(req.alternativeTitles ?? []),
    occupationSynonyms: distinct(req.occupationSynonyms ?? []),
    requiredSkills: distinct(req.requiredSkills ?? []),
    preferredSkills: distinct(req.preferredSkills ?? []),
    keywords: distinct(req.keywords ?? []),
    employers: distinct(req.employers ?? []).slice(0, 6),
    excludeEmployers: distinct(req.excludeEmployers ?? []).slice(0, 6),
    employerScope: req.employerScope === "current" ? "current" : "any",
  };
}

/**
 * The requirements in a model's reply, wherever the object sits in it.
 * Stripping a fence only worked when the fence was the whole reply; a sentence
 * before or after it made JSON.parse throw, and the search silently fell back
 * to raw words ("accountant, with, years…") (21 September). Null when the
 * reply holds no usable reading.
 */
function requirementsIn(content: string, text: string): SearchRequirements | null {
  const from = content.indexOf("{");
  const to = content.lastIndexOf("}");
  const parsed = JSON.parse(from >= 0 && to > from ? content.slice(from, to + 1) : content) as Partial<SearchRequirements>;
  const strings = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);
  // "Everyone who worked at Dialog" names no role, and is still a search.
  if (!parsed || !(parsed.title || (parsed.requiredSkills && parsed.requiredSkills.length > 0) || strings(parsed.employers).length > 0)) return null;
  return normalizeRequirements({
    ...(parsed.searchOccupation && typeof parsed.searchOccupation === "object" && (parsed.searchOccupation.targetOccupation === null || typeof parsed.searchOccupation.targetOccupation === "string") ? {
      searchOccupation: {
        targetOccupation: typeof parsed.searchOccupation.targetOccupation === "string" ? parsed.searchOccupation.targetOccupation : null,
        equivalentTitles: strings(parsed.searchOccupation.equivalentTitles),
        reportingContext: typeof parsed.searchOccupation.reportingContext === "string" ? parsed.searchOccupation.reportingContext : null,
        explicitSkills: strings(parsed.searchOccupation.explicitSkills),
        inferredSkills: strings(parsed.searchOccupation.inferredSkills),
      },
    } : {}),
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
    employers: strings(parsed.employers),
    excludeEmployers: strings(parsed.excludeEmployers),
    // Owner, 9 Oct: "in", "at" or "working at Dialog" means now or before. The
    // model read "working at" as now only, even when told otherwise, so the
    // narrower reading needs the searcher's own word for it.
    employerScope: parsed.employerScope === "current" && SAYS_NOW.test(text) ? "current" : "any",
  });
}

type Reading = {
  requirements: SearchRequirements;
  usage: { promptTokens: number; completionTokens: number; model: string };
};

export async function extractSearchRequirements(
  text: string,
  kind: "job_description" | "natural_language"
): Promise<Reading> {
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
  "maxYearsExperience": "number if the JD gives an upper bound or a range such as 3-5 years, else null",
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
      : NATURAL_LANGUAGE_PROMPT;
  return (
    (await readRequirements(prompt, text.slice(0, 7000), text, kind === "natural_language")) ??
    fallbackRequirements(text)
  );
}

const NATURAL_LANGUAGE_PROMPT = `You are a talent search assistant. Extract the main candidate-match requirements from this search query.
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
  "keywords": ["important keywords, tools, frameworks, brands, certifications, acronyms"],
  "languages": ["required languages"],
  "employers": ["companies the candidate works or worked at: the company as written, then up to 4 common spellings or the parent company name"],
  "excludeEmployers": ["companies the candidate must NOT be working at now, e.g. 'not from Dialog'"],
  "employerScope": "any, unless the query says the person must be there NOW with a word like currently, now or presently, then current. 'in Dialog', 'at Dialog', 'working at Dialog', 'from Dialog' and 'ex-Dialog' are all any",
  "clientCompany": null,
  "clientContactEmail": null,
  "salaryRange": "salary range if mentioned, or null"
}
Companies: a company named in the query is where the CANDIDATE works or worked, so it goes in employers. "HR personnel in Dialog", "engineers at Brandix", "ex-MAS", "working at ABC" all name employers. "in Bangladesh", "in Colombo" are places and go in location. A company is never the hiring client here: leave clientCompany null.
If the query is vague, infer the most likely role and include likely related skills so the search remains broad enough.
For occupationSynonyms, include alternative job titles that represent the same occupation as the primary title — not seniority variations, but genuinely equivalent role names a candidate might use on their CV.`;

/**
 * The model chain for one reading: Claude first when a TA is watching, then
 * DeepSeek, then NVIDIA where its key is set. Null when none gave a usable answer.
 */
async function readRequirements(prompt: string, userText: string, text: string, claudeFirst: boolean): Promise<Reading | null> {
  // Claude first for a search sentence (6 Oct, at the owner's request), DeepSeek
  // second. Only a sentence typed into search: a pasted job description still
  // goes to DeepSeek, as extraction does. A TA is watching this one, so it waits
  // the short queue (match_read). Anything short of a usable answer — no slot,
  // slow, refused, not JSON — falls through to the models below, unchanged.
  if (claudeFirst) {
    try {
      const answer = await askClaudeFirst("match_read", prompt, userText, claudeBudgetMs("match_read"));
      const requirements = answer ? requirementsIn(answer, text) : null;
      if (requirements) {
        return { requirements, usage: { promptTokens: 0, completionTokens: 0, model: "claude-subscription" } };
      }
    } catch (e: any) {
      console.warn(`[extractSearchRequirements] Claude answer unusable, using DeepSeek: ${e?.message || e}`);
    }
  }

  // Clients are made per attempt, inside the try. Building both up front threw
  // "NVIDIA_API_KEY is not set" wherever that fallback key is absent — the web
  // app, which runs this for Database search — before DeepSeek was ever asked,
  // so the whole search fell back to words only. The fallback is offered only
  // where its key exists.
  const candidateProviders = [
    { client: () => getOpenAI("jd_extraction"), model: OPENROUTER_PRIMARY_MODEL, isNvidia: false },
    ...(process.env.NVIDIA_API_KEY
      ? [{ client: () => getNvidiaOpenAI(), model: "meta/llama-3.1-70b-instruct", isNvidia: true }]
      : []),
  ];

  for (const provider of candidateProviders) {
    try {
      const response = await provider.client().chat.completions.create({
        model: provider.model,
        temperature: 0.1,
        max_tokens: 1400,
        messages: [
          { role: "system", content: prompt },
          { role: "user", content: userText },
        ],
        // DeepSeek can spend its whole budget "reasoning" and return nothing
        // (the Desk Copilot's empty replies, 17 September); a structured read
        // needs no reasoning. OpenRouter-only field, ignored elsewhere.
        ...({ reasoning: { enabled: false } } as object),
      });

      const inputTokens = response.usage?.prompt_tokens || 0;
      const outputTokens = response.usage?.completion_tokens || 0;
      const content = response.choices[0]?.message?.content ?? "{}";

      const requirements = requirementsIn(content, text);
      if (requirements) {
        return {
          requirements,
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

  return null;
}

/** Words only, for when every model is down. Companies are still read, by pattern. */
export function fallbackRequirements(text: string): Reading {
  const companies = employersInText(text);
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
      employers: companies.employers,
      excludeEmployers: companies.excludeEmployers,
      employerScope: companies.scope,
    }),
    usage: {
      promptTokens: 0,
      completionTokens: 0,
      model: "regex-fallback",
    },
  };
}

// ─── A search held as a conversation ─────────────────────────────────────────
//
// The Database search is a chat: "software engineer", then "in Bangladesh",
// then "working at ABC". Joined with ". " the messages read as one odd
// sentence, and "in Colombo instead" did not reliably replace the earlier
// place (9 Oct). The model now reads the messages in order and is told how
// they combine.

export const CONVERSATION_RULES = `The search below was typed as a conversation: each numbered message refines the search so far.
Combine all the messages into ONE search and return ONE JSON object in the format above.
- Later messages add to earlier ones: a skill, a company, a years figure added later all apply together with what came before.
- A later message that names a different role, place or number replaces the earlier one ("in Colombo instead", "actually 8 years", "make it a team lead").
- "not X", "without X", "exclude X" removes X: drop it from what you return; a company goes in excludeEmployers.
- If a later message contradicts an earlier one, the later message wins.
- The summary describes the combined search.`;

/** What the model is sent: the messages, numbered, oldest first. */
export function conversationMessage(turns: string[]): string {
  return turns.map((t, i) => `${i + 1}. ${t.trim()}`).join("\n").slice(0, 7000);
}

/** A model's reply to the conversation, read the same way as a single sentence. */
export function conversationReply(reply: string, turns: string[]): SearchRequirements | null {
  try {
    return requirementsIn(reply, turns.join(". "));
  } catch {
    return null;
  }
}

/**
 * One reading of the whole conversation. A single message is read exactly as
 * before. When every model is down, the words of all the messages are used.
 */
export async function extractConversationRequirements(turns: string[], opts: { roleAware?: boolean } = {}): Promise<Reading> {
  const said = turns.map((t) => t.trim()).filter(Boolean);
  if (said.length <= 1 && !opts.roleAware) return extractSearchRequirements(said[0] ?? "", "natural_language");
  const joined = said.map((t) => t.replace(/[.\s]+$/, "")).join(". ");
  return (
    (await readRequirements(`${NATURAL_LANGUAGE_PROMPT}\n\n${CONVERSATION_RULES}${opts.roleAware ? ROLE_AWARE_SEARCH : ""}`, conversationMessage(said), joined, true)) ??
    fallbackRequirements(joined)
  );
}

const ROLE_AWARE_SEARCH = `
For this Database search, these rules override the implicit-skills rules above:
Add searchOccupation: {targetOccupation: string or null, equivalentTitles: string[], reportingContext: string or null, explicitSkills: string[], inferredSkills: string[]}.
The occupation is the candidate's work, never the person they support or report to.
Personal Assistant to CFO / personal assistant cfo means Personal Assistant, supporting CFO, NOT CFO. Executive Assistant to CEO means Executive Assistant, NOT CEO.
Preserve Assistant Accountant and Assistant Finance Manager as distinct occupations; do not strip assistant.
equivalentTitles and occupationSynonyms must describe the SAME occupation, not merely a related department or senior role.
Use targetOccupation null when only skills, employers, or other constraints were requested.
explicitSkills and requiredSkills contain only skills the recruiter actually requested, excluding preferences. Put inferred or preferred skills into inferredSkills and preferredSkills, never requiredSkills.
Do not infer executive seniority from a reporting-line CFO/CEO or from the title Executive Assistant.
Retain the complete role phrase in title. Later explicit role changes replace earlier roles.
`;

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
