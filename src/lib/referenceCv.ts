import "server-only";

import { createHash } from "node:crypto";
import { extractRawText } from "./refereeExtractor";

export interface ReferenceCvBlueprint {
  targetTitle: string;
  alternativeTitles: string[];
  seniority: "junior" | "mid" | "senior" | "lead" | "executive";
  totalExperienceYears: number | null;
  minYears: number | null;
  maxYears: number | null;
  skills: string[];
  employers: string[];
  industries: string[];
  education: string[];
  summary: string;
  suggestedQuery: string;
}

const CACHE_MS = 10 * 60_000;
const cache = new Map<string, { at: number; blueprint: ReferenceCvBlueprint }>();

function sha256(content: string | Buffer): string {
  return createHash("sha256").update(content).digest("hex");
}

function normalizeSeniority(val: string): ReferenceCvBlueprint["seniority"] {
  const v = (val || "").toLowerCase().trim();
  if (v.includes("intern") || v.includes("junior") || v.includes("entry") || v.includes("trainee")) return "junior";
  if (v.includes("lead") || v.includes("manager") || v.includes("head") || v.includes("principal")) return "lead";
  if (v.includes("director") || v.includes("vp") || v.includes("chief") || v.includes("executive") || v.includes("c-suite")) return "executive";
  if (v.includes("senior") || v.includes("sr")) return "senior";
  return "mid";
}

/**
 * Heuristic fallback parser when AI models are unavailable or rate-limited.
 */
function heuristicBlueprint(text: string): ReferenceCvBlueprint {
  const lines = text.split("\n").map((l) => l.trim()).filter(Boolean);
  
  // Look for potential job titles in first 20 lines
  const titleKeywords = ["engineer", "developer", "manager", "lead", "director", "specialist", "consultant", "analyst", "assistant", "executive", "officer", "accountant", "designer"];
  let targetTitle = "Specialist";
  for (const line of lines.slice(0, 25)) {
    if (line.length > 3 && line.length < 60) {
      const lower = line.toLowerCase();
      if (titleKeywords.some((kw) => lower.includes(kw))) {
        targetTitle = line.replace(/^[•\-\*\s]+/, "");
        break;
      }
    }
  }

  // Look for years of experience
  let totalExperienceYears: number | null = null;
  const expMatch = text.match(/(\d{1,2})\+?\s*(?:years?|yrs?)(?:\s+of)?\s+experience/i);
  if (expMatch) {
    totalExperienceYears = parseInt(expMatch[1], 10);
  }

  // Common skills dictionary search
  const commonSkills = [
    "JavaScript", "TypeScript", "React", "Node.js", "Python", "Java", "C#", ".NET",
    "SQL", "PostgreSQL", "MongoDB", "AWS", "Azure", "GCP", "Docker", "Kubernetes",
    "CI/CD", "Git", "DevOps", "Agile", "Scrum", "Project Management", "Product Management",
    "Accounting", "Financial Analysis", "Auditing", "ERP", "SAP", "Excel", "Power BI",
    "Marketing", "SEO", "Content Strategy", "Sales", "Customer Success", "Human Resources",
  ];
  const matchedSkills: string[] = [];
  const textLower = text.toLowerCase();
  for (const skill of commonSkills) {
    const sLower = skill.toLowerCase();
    const regex = new RegExp(`\\b${sLower.replace(".", "\\.")}\\b`, "i");
    if (regex.test(textLower)) {
      matchedSkills.push(skill);
    }
  }

  const seniority = normalizeSeniority(targetTitle);
  const minYears = totalExperienceYears ? Math.max(1, totalExperienceYears - 2) : 2;
  const maxYears = totalExperienceYears ? totalExperienceYears + 3 : 8;

  return {
    targetTitle,
    alternativeTitles: [],
    seniority,
    totalExperienceYears,
    minYears,
    maxYears,
    skills: matchedSkills.slice(0, 10),
    employers: [],
    industries: [],
    education: [],
    summary: `${targetTitle} with ${totalExperienceYears ? `${totalExperienceYears} years of` : "proven"} experience in ${matchedSkills.slice(0, 4).join(", ") || "core domain competencies"}.`,
    suggestedQuery: `${targetTitle} ${matchedSkills.slice(0, 3).join(" ")}`.trim(),
  };
}

/**
 * Parses and extracts a ReferenceCvBlueprint from raw CV text using AI
 * (DeepSeek V4 Flash via OpenRouter or GPT-4o-mini via OpenAI, with fallback heuristics).
 */
export async function extractBlueprintFromText(text: string): Promise<ReferenceCvBlueprint> {
  const trimmed = text.trim();
  if (trimmed.length < 30) {
    return heuristicBlueprint(trimmed);
  }

  const hash = sha256(trimmed);
  const cached = cache.get(hash);
  if (cached && Date.now() - cached.at < CACHE_MS) {
    return cached.blueprint;
  }

  const openrouterKey = (process.env.OPENROUTER_API_KEY ?? "").trim();
  const openaiKey = (process.env.OPENAI_API_KEY ?? "").trim();

  // If no API key is available, use heuristic extraction immediately
  if (!openrouterKey && !openaiKey) {
    const bp = heuristicBlueprint(trimmed);
    cache.set(hash, { at: Date.now(), blueprint: bp });
    return bp;
  }

  const systemPrompt = `You are an expert talent acquisition and resume parsing engine.
Your task is to analyze an uploaded candidate CV/resume and extract a clean "Reference Profile Blueprint" JSON for finding lookalike candidates in a database.

Respond ONLY with a valid JSON object matching this schema:
{
  "targetTitle": "string (the candidate's primary/target job title, e.g. 'Senior DevOps Engineer')",
  "alternativeTitles": ["string", "string"],
  "seniority": "junior" | "mid" | "senior" | "lead" | "executive",
  "totalExperienceYears": number | null,
  "minYears": number | null,
  "maxYears": number | null,
  "skills": ["string", "string"],
  "employers": ["string", "string"],
  "industries": ["string", "string"],
  "education": ["string", "string"],
  "summary": "string (concise 1-2 sentence reference persona)",
  "suggestedQuery": "string (a high-signal 3-6 word search query to find candidates like this, e.g. 'Senior DevOps Engineer Kubernetes AWS Terraform')"
}
Do not include markdown fences, thoughts, or explanations. Only return valid JSON.`;

  const truncatedText = trimmed.slice(0, 14_000);

  try {
    let resultJson = "";
    if (openrouterKey) {
      // Use DeepSeek V4 Flash via OpenRouter
      const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${openrouterKey}`,
          "HTTP-Referer": "https://ta-system.career141.com",
          "X-Title": "Career141 TA System",
        },
        body: JSON.stringify({
          model: "deepseek/deepseek-v4-flash",
          messages: [
            { role: "system", content: systemPrompt },
            { role: "user", content: `Here is the candidate CV:\n\n${truncatedText}` },
          ],
          temperature: 0.1,
          max_tokens: 800,
        }),
        signal: AbortSignal.timeout(25_000),
      });

      if (res.ok) {
        const data = await res.json();
        resultJson = data.choices?.[0]?.message?.content ?? "";
      }
    }

    if (!resultJson && openaiKey) {
      // Fallback to OpenAI gpt-4o-mini
      const res = await fetch("https://api.openai.com/v1/chat/completions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${openaiKey}`,
        },
        body: JSON.stringify({
          model: "gpt-4o-mini",
          messages: [
            { role: "system", content: systemPrompt },
            { role: "user", content: `Here is the candidate CV:\n\n${truncatedText}` },
          ],
          response_format: { type: "json_object" },
          temperature: 0.1,
          max_tokens: 800,
        }),
        signal: AbortSignal.timeout(20_000),
      });

      if (res.ok) {
        const data = await res.json();
        resultJson = data.choices?.[0]?.message?.content ?? "";
      }
    }

    if (resultJson) {
      const cleaned = resultJson.replace(/^```json\s*/i, "").replace(/```\s*$/i, "").trim();
      const parsed = JSON.parse(cleaned);

      const blueprint: ReferenceCvBlueprint = {
        targetTitle: String(parsed.targetTitle || "Specialist").trim(),
        alternativeTitles: Array.isArray(parsed.alternativeTitles) ? parsed.alternativeTitles.map(String).filter(Boolean) : [],
        seniority: normalizeSeniority(parsed.seniority),
        totalExperienceYears: typeof parsed.totalExperienceYears === "number" ? parsed.totalExperienceYears : null,
        minYears: typeof parsed.minYears === "number" ? parsed.minYears : null,
        maxYears: typeof parsed.maxYears === "number" ? parsed.maxYears : null,
        skills: Array.isArray(parsed.skills) ? parsed.skills.map(String).filter(Boolean) : [],
        employers: Array.isArray(parsed.employers) ? parsed.employers.map(String).filter(Boolean) : [],
        industries: Array.isArray(parsed.industries) ? parsed.industries.map(String).filter(Boolean) : [],
        education: Array.isArray(parsed.education) ? parsed.education.map(String).filter(Boolean) : [],
        summary: String(parsed.summary || "").trim(),
        suggestedQuery: String(parsed.suggestedQuery || parsed.targetTitle || "").trim(),
      };

      cache.set(hash, { at: Date.now(), blueprint });
      return blueprint;
    }
  } catch (err) {
    console.warn("[referenceCv] LLM extraction error, using heuristic fallback:", err);
  }

  const bp = heuristicBlueprint(trimmed);
  cache.set(hash, { at: Date.now(), blueprint: bp });
  return bp;
}

/**
 * Extracts a ReferenceCvBlueprint from an uploaded file Buffer (PDF or Word DOC/DOCX).
 */
export async function extractBlueprintFromFile(buffer: Buffer, fileType?: string): Promise<{ text: string; blueprint: ReferenceCvBlueprint }> {
  const text = await extractRawText(buffer, fileType);
  if (!text || text.trim().length < 20) {
    throw new Error("Could not extract readable text from this document. Please ensure it is a valid PDF or Word CV.");
  }
  const blueprint = await extractBlueprintFromText(text);
  return { text, blueprint };
}
