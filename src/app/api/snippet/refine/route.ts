import { currentUser } from "@/lib/session";
import { gemini } from "@/lib/ai";
import { cleanSnippetBullet, splitTitle } from "@/lib/snippet";

/**
 * Refine all snippet labels and language for the social card (WhatsApp, LinkedIn, Meta).
 * Polishes titles, industry, location, company, package, gender, and requirements.
 */
export async function POST(req: Request) {
  const user = await currentUser();
  if (!user || !user.isActive) {
    return Response.json({ ok: false, error: "Sign in first." }, { status: 401 });
  }

  let body: {
    jobTitle?: string;
    titleLead?: string;
    titleMain?: string;
    industry?: string;
    location?: string;
    company?: string;
    package?: string;
    gender?: string;
    bullets?: string[];
    level?: string;
  };
  try {
    body = await req.json();
  } catch {
    return Response.json({ ok: false, error: "Could not parse request body." }, { status: 400 });
  }

  let titleLead = String(body.titleLead ?? "").trim();
  let titleMain = String(body.titleMain ?? "").trim();
  if (!titleLead && !titleMain && body.jobTitle) {
    const s = splitTitle(body.jobTitle);
    titleLead = s.lead;
    titleMain = s.main;
  }

  const industry = String(body.industry ?? "").trim();
  const location = String(body.location ?? "").trim();
  const company = String(body.company ?? "").trim();
  const pkg = String(body.package ?? "").trim();
  const gender = String(body.gender ?? "").trim();
  const level = String(body.level ?? "").trim();
  const rawBullets = Array.isArray(body.bullets)
    ? body.bullets.map(String).filter((b) => b.trim().length > 0)
    : [];

  // Common typo and casing corrections
  const fixCommonTypos = (s: string) =>
    s
      .replace(/\baquisition\b/gi, "Acquisition")
      .replace(/\bacquistion\b/gi, "Acquisition")
      .replace(/\bexperiance\b/gi, "Experience")
      .replace(/\bmanagment\b/gi, "Management")
      .replace(/\bcomunication\b/gi, "Communication")
      .replace(/\bdevops\b/gi, "DevOps")
      .replace(/\bfrontend\b/gi, "Frontend")
      .replace(/\bbackend\b/gi, "Backend")
      .replace(/\bfullstack\b/gi, "Full Stack")
      .replace(/\bui\/ux\b/gi, "UI/UX")
      .replace(/\bcolombo\s+sl\b/gi, "Colombo, Sri Lanka")
      .replace(/\bsri\s*lanka\b/gi, "Sri Lanka");

  const cleanField = (s: string) => fixCommonTypos(s.trim());
  const fallbackBullets = rawBullets.map(cleanSnippetBullet).filter(Boolean).slice(0, 4);

  const prompt = `You are an expert executive recruitment copywriter for Career141.
Refine and polish all the text labels for the following job snippet so it looks pristine, professional, and high-converting on a 1080x1080 social media job card (WhatsApp / LinkedIn).

Input Fields:
- Role Level: ${JSON.stringify(level || "Executive")}
- Top line title: ${JSON.stringify(titleLead)}
- Main line title: ${JSON.stringify(titleMain)}
- Industry: ${JSON.stringify(industry)}
- Location: ${JSON.stringify(location)}
- Company/Sector: ${JSON.stringify(company)}
- Package/Salary: ${JSON.stringify(pkg)}
- Gender: ${JSON.stringify(gender)}
- Requirements:
${rawBullets.map((b, i) => `${i + 1}. ${b}`).join("\n") || "(none provided)"}

Instructions:
1. Fix all spelling errors, typos, and awkward casing across all fields (e.g. "AQUISITION" -> "ACQUISITION", "colombo sl" -> "Colombo, Sri Lanka").
2. "titleLead": Polish the seniority/lead prefix if present (e.g. "Executive / Senior Executive", "Senior", "Lead Specialist"). Keep it clean and concise.
3. "titleMain": Polish the core functional job title in UPPERCASE or Title Case suitable for prominent bold display (e.g. "TALENT ACQUISITION", "FRONTEND ENGINEER").
4. "industry": Polish into a concise, professional industry label (e.g. "Apparel Manufacturing", "FinTech", "Information Technology").
5. "company": Polish into a concise professional company or sector descriptor (e.g. "Apparel Conglomerate", "Leading MNC", "Global Tech Co").
6. "location": Standardize geographic location (e.g. "Sri Lanka | Colombo", "Colombo, Sri Lanka", "Hybrid / Colombo").
7. "package": Standardize compensation wording (e.g. "LKR 450K – 550K + Benefits", "Competitive / Negotiable", "Negotiable").
8. "gender": Standardize to "Open", "Male", or "Female" (default to "Open" if unspecified).
9. "bullets": Produce 3 or 4 crisp, high-impact bullet points.
   - Each bullet point MUST be under 50 characters so it fits neatly without wrapping awkwardly.
   - Start each bullet with a strong action verb or key qualification.
   - Eliminate all filler phrases (e.g., "Candidate must have", "Responsible for", "Ability to").
10. Return ONLY a valid JSON object matching this schema:
{
  "titleLead": "string",
  "titleMain": "string",
  "industry": "string",
  "location": "string",
  "company": "string",
  "package": "string",
  "gender": "string",
  "bullets": ["string", "string", "string"]
}`;

  try {
    const aiRes = await gemini("jd", prompt, { maxTokens: 900, temperature: 0.2 });
    if (aiRes.ok && aiRes.text) {
      const jsonMatch = aiRes.text.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        const parsed = JSON.parse(jsonMatch[0]);
        if (parsed && typeof parsed === "object") {
          const refinedLead = typeof parsed.titleLead === "string" ? parsed.titleLead.trim() : titleLead;
          const refinedMain = typeof parsed.titleMain === "string" ? parsed.titleMain.trim() : titleMain;
          const refinedIndustry = typeof parsed.industry === "string" ? parsed.industry.trim() : industry;
          const refinedLocation = typeof parsed.location === "string" ? parsed.location.trim() : location;
          const refinedCompany = typeof parsed.company === "string" ? parsed.company.trim() : company;
          const refinedPkg = typeof parsed.package === "string" ? parsed.package.trim() : pkg;
          const refinedGender = typeof parsed.gender === "string" ? parsed.gender.trim() : gender;
          const refinedBullets = Array.isArray(parsed.bullets)
            ? parsed.bullets.map(String).map((b: string) => cleanSnippetBullet(b)).filter(Boolean).slice(0, 4)
            : fallbackBullets;

          return Response.json({
            ok: true,
            data: {
              titleLead: refinedLead || titleLead,
              titleMain: refinedMain || titleMain,
              industry: refinedIndustry || industry,
              location: refinedLocation || location,
              company: refinedCompany || company,
              package: refinedPkg || pkg,
              gender: refinedGender || gender || "Open",
              bullets: refinedBullets.length > 0 ? refinedBullets : fallbackBullets,
            },
          });
        }
      }
    }
  } catch (e) {
    console.warn("AI snippet refinement error:", e);
  }

  return Response.json({
    ok: true,
    data: {
      titleLead: cleanField(titleLead),
      titleMain: cleanField(titleMain),
      industry: cleanField(industry) || "Corporate",
      location: cleanField(location) || "Sri Lanka",
      company: cleanField(company) || cleanField(industry) || "Corporate",
      package: cleanField(pkg) || "Negotiable",
      gender: cleanField(gender) || "Open",
      bullets: fallbackBullets.length > 0 ? fallbackBullets : ["Proven track record in role", "Strong stakeholder management", "Relevant qualification"],
    },
  });
}


