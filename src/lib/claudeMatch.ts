import type { Candidate } from "@/data/types";
import { hasToken, jsonArrayIn, logSubscriptionUsage, readStream, runClaude } from "./claudeSub";
import { yearsFromHistory, type Requirements } from "./scoring";

/**
 * Why each database match was picked, one line, by Claude — 5 Oct, at the
 * owner's request: the TA sees a match's name and the reason, and the rest is
 * one click away on the candidate page.
 *
 * Claude does not choose anyone. The reverse-match engine and the desk's rules
 * pick and order the list exactly as before (lib/dbMatch); a model ranking was
 * tried on 13 September and did no better than the rules score. Claude only
 * says, for the people already chosen, what fits and what is missing.
 *
 * Kept small on purpose, so a run draws little of the subscription: each
 * person goes as one numbered line — their work, years, skills, place — and
 * comes back as one short sentence. Never a name, phone, email, LinkedIn or
 * CV text: the subscription is a personal account, and none of that is needed
 * to say why someone fits. Numbers, not record ids, so Claude cannot answer
 * for somebody who was not asked about.
 *
 * Off unless C141_CLAUDE_MATCH=on. When Claude cannot answer — the usage
 * limit, a lapsed token, a slow run — DeepSeek is asked the same question;
 * when neither can, the engine's own reason is shown. Matching never waits on
 * either.
 */
const TIMEOUT_MS = 180_000;
const DEFAULT_MODEL = "claude-sonnet-5-5";
/** Long enough for "what fits; what is missing", short enough to read in a list. */
const MAX_WORDS = 25;

export function claudeMatchOn(): boolean {
  return (process.env.C141_CLAUDE_MATCH ?? "").trim().toLowerCase() === "on" && hasToken();
}

export interface MatchJob {
  title: string;
  industry: string | null;
  jdText: string;
  req: Pick<Requirements, "minYears" | "requiredSkills" | "qualitativeMusts" | "locations">;
}

/** One person, as Claude sees them: no name, no contacts, no CV text. */
export function matchLine(n: number, c: Candidate): string {
  const years = Math.max(c.totalExperienceYears ?? 0, yearsFromHistory(c.workHistory) ?? 0);
  const current = [c.currentTitle, c.currentEmployer].filter(Boolean).join(" @ ");
  const before = c.workHistory
    .map((h) => h.title)
    .filter((t) => t && t !== c.currentTitle)
    .slice(0, 2);
  return `${n}. ` + [
    current || "title unknown",
    years > 0 ? `${years} yrs` : "years unknown",
    c.location || null,
    c.skills.length ? `skills: ${c.skills.slice(0, 8).join(", ")}` : null,
    before.length ? `before: ${before.join("; ")}` : null,
    c.educationDegree || null,
  ]
    .filter(Boolean)
    .join(" | ");
}

export function matchPrompt(job: MatchJob, lines: string[]): string {
  const musts = [...job.req.requiredSkills, ...(job.req.qualitativeMusts ?? [])].slice(0, 12);
  return `You are a recruiter at Career141. The people below were already chosen as database matches for this job. For each one, say in one short sentence why they were chosen: what fits the job and, if anything, the main gap.

THE JOB
Position: ${job.title}
Industry: ${job.industry || "not given"}
Minimum years: ${job.req.minYears ?? "not given"}
Must-haves: ${musts.join("; ") || "not given"}
Location: ${job.req.locations.join(", ") || "not given"}
Job description:
"""
${job.jdText.slice(0, 3000)}
"""

THE PEOPLE
${lines.join("\n")}

Rules
- Only from what each line says. Never guess a fact that is not there.
- At most ${MAX_WORDS} words each, plain English, no names.

Answer with JSON only, no other text, one entry per person:
[{"n": 1, "why": "..."}]`;
}

/**
 * Claude's answer, kept only where it answers who was asked. Pure, so it is
 * testable without a subscription: a number out of range or given twice, an
 * empty reason, or a failed run gives nothing for that person.
 */
export function readMatch(stream: string, count: number): { reasons: Map<number, string>; rejected: number; error?: string } {
  const { final } = readStream(stream);
  if (!final) return { reasons: new Map(), rejected: 0, error: "claude_no_answer" };
  if (final.is_error || (final.subtype && final.subtype !== "success")) {
    return { reasons: new Map(), rejected: 0, error: `claude_failed: ${(final.result ?? final.subtype ?? "").slice(0, 200)}` };
  }
  return readMatchText(final.result ?? "", count);
}

/** The same reading for a plain-text answer — DeepSeek's, when Claude had none. */
export function readMatchText(text: string, count: number): { reasons: Map<number, string>; rejected: number } {
  const reasons = new Map<number, string>();
  let rejected = 0;
  for (const r of jsonArrayIn(text)) {
    const n = typeof r.n === "number" ? r.n : Number(r.n);
    const why = typeof r.why === "string" ? r.why.replace(/\s+/g, " ").trim() : "";
    if (!Number.isInteger(n) || n < 1 || n > count || reasons.has(n) || !why) {
      rejected++;
      continue;
    }
    // A sentence that ran long is cut, not dropped.
    reasons.set(n, why.split(" ").length > MAX_WORDS + 10 ? `${why.split(" ").slice(0, MAX_WORDS + 10).join(" ")}…` : why);
  }
  return { reasons, rejected };
}

/**
 * The reasons for these people, by candidate id, and who wrote them: Claude
 * first, DeepSeek when Claude has no answer (5 Oct: "if something happens to
 * the Claude subscription, straight away move to DeepSeek"). Null when neither
 * answered; the caller then shows the engine's reasons.
 */
export async function claudeMatchReasons(
  job: MatchJob,
  candidates: Candidate[],
): Promise<{ reasons: Map<string, string>; by: "claude" | "deepseek" } | null> {
  if (candidates.length === 0) return { reasons: new Map(), by: "claude" };
  const prompt = matchPrompt(job, candidates.map((c, i) => matchLine(i + 1, c)));
  const byId = (m: Map<number, string>) => new Map([...m].map(([n, why]) => [candidates[n - 1].id, why]));

  const fromClaude = await askClaude(prompt, candidates.length);
  if (fromClaude) return { reasons: byId(fromClaude), by: "claude" };

  // DeepSeek, on OpenRouter — the engine matching used before. Only that
  // route: with no OpenRouter key, `write` would reach for the metered
  // Anthropic key, which is not a fallback anyone asked for.
  const { viaOpenRouter, write } = await import("./ai");
  if (!viaOpenRouter()) return null;
  const r = await write("", prompt, 1500, "rank");
  const fromDeepSeek = r.ok ? readMatchText(r.text, candidates.length).reasons : new Map<number, string>();
  if (fromDeepSeek.size) return { reasons: byId(fromDeepSeek), by: "deepseek" };
  console.warn(`[claude-match] DeepSeek had no answer either (${r.ok ? "unreadable" : r.reason}); engine reasons shown`);
  return null;
}

async function askClaude(prompt: string, count: number): Promise<Map<number, string> | null> {
  const model = (process.env.C141_CLAUDE_MATCH_MODEL ?? "").trim() || DEFAULT_MODEL;
  const r = await runClaude(
    // No tools at all: it answers from the prompt, it does not act.
    ["--output-format", "stream-json", "--verbose", "--tools", "", "--model", model],
    prompt,
    TIMEOUT_MS,
  );
  logSubscriptionUsage("match", r.out);
  if (r.timedOut) {
    console.warn(`[claude-match] no answer in ${TIMEOUT_MS / 1000}s; asking DeepSeek`);
    return null;
  }
  const { reasons, rejected, error } = readMatch(r.out, count);
  if (error || reasons.size === 0) {
    console.warn(`[claude-match] ${error ?? `exited ${r.code}: ${r.err.slice(0, 200)}`}; asking DeepSeek`);
    return null;
  }
  if (rejected) console.warn(`[claude-match] ${rejected} answer(s) dropped: not one of the people asked about`);
  return reasons;
}
