import type { Candidate } from "@/data/types";
import { hasToken, jsonArrayIn, logSubscriptionUsage, readStream, runClaude } from "./claudeSub";
import { yearsFromHistory, type Requirements } from "./scoring";

/**
 * Claude scores each database match and says why, in one line — 5 Oct, at
 * the owner's request: Claude takes over the scoring from DeepSeek, and the
 * TA sees the full row as before, with Claude's score and reason on it.
 *
 * Claude is given the engine's best people after the desk's rules (lib/dbMatch)
 * and answers, for each, only three things: the number it was given, a score
 * and a reason. The number is the reference — the run holds number → candidate
 * id, and everything shown on the row is read from the database by that id,
 * never from Claude. A number, not the record id, because the subscription's
 * limit is on output: an id is ~20 tokens and can be mistyped, a number is one
 * or two and cannot point at somebody who was not asked about.
 *
 * Kept small on purpose for the same reason: each person goes as one numbered
 * line — their work, years, skills, place — and comes back as `n|score|reason`,
 * no JSON keys. Never a name, phone, email, LinkedIn or CV text: the
 * subscription is a personal account, and none of that is needed to judge fit.
 *
 * Off unless C141_CLAUDE_MATCH=on. When Claude cannot answer — the usage
 * limit, a lapsed token, a slow run — DeepSeek is asked the same question;
 * when neither can, the engine's own score and reason stand. Matching never
 * waits on either.
 */
const TIMEOUT_MS = 180_000;
const DEFAULT_MODEL = "claude-sonnet-5-5";
/** Long enough for "what fits; what is missing", short enough to cost little. */
const MAX_WORDS = 15;

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
  return `You are a recruiter at Career141. Score how well each person below fits this job, from 0 to 100, and say why in a few words.

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

Scores
- 75-100: strong fit, worth calling today.
- 60-74: worth a look, with a clear gap.
- Below 60: weak fit.

Rules
- Only from what each line says. Never guess a fact that is not there.
- Reason: at most ${MAX_WORDS} words, what fits and the main gap. No names.

Answer with one line per person and nothing else, in this exact form:
number|score|reason
1|82|6 yrs IFRS reporting in manufacturing; no team-lead role yet`;
}

export interface MatchVerdict {
  score: number;
  reason: string;
}

/**
 * Claude's answer, kept only where it answers who was asked. Pure, so it is
 * testable without a subscription: a number out of range or given twice, a
 * score outside 0–100, an empty reason, or a failed run gives nothing for that
 * person.
 */
export function readMatch(stream: string, count: number): { results: Map<number, MatchVerdict>; rejected: number; error?: string } {
  const { final } = readStream(stream);
  if (!final) return { results: new Map(), rejected: 0, error: "claude_no_answer" };
  if (final.is_error || (final.subtype && final.subtype !== "success")) {
    return { results: new Map(), rejected: 0, error: `claude_failed: ${(final.result ?? final.subtype ?? "").slice(0, 200)}` };
  }
  return readMatchText(final.result ?? "", count);
}

/**
 * The same reading for a plain-text answer — DeepSeek's, when Claude had none.
 * `n|score|reason` lines; JSON (`[{"n":1,"score":82,"why":"…"}]`) is read too,
 * because a model asked for one shape sometimes answers in the other.
 */
export function readMatchText(text: string, count: number): { results: Map<number, MatchVerdict>; rejected: number } {
  const results = new Map<number, MatchVerdict>();
  let rejected = 0;
  const take = (nRaw: unknown, scoreRaw: unknown, whyRaw: unknown) => {
    const n = typeof nRaw === "number" ? nRaw : Number(String(nRaw ?? "").trim());
    const score = typeof scoreRaw === "number" ? scoreRaw : Number(String(scoreRaw ?? "").trim() || NaN);
    const why = typeof whyRaw === "string" ? whyRaw.replace(/\s+/g, " ").trim() : "";
    if (!Number.isInteger(n) || n < 1 || n > count || results.has(n) || !Number.isFinite(score) || score < 0 || score > 100 || !why) {
      rejected++;
      return;
    }
    // A sentence that ran long is cut, not dropped.
    const words = why.split(" ");
    results.set(n, { score: Math.round(score), reason: words.length > MAX_WORDS + 10 ? `${words.slice(0, MAX_WORDS + 10).join(" ")}…` : why });
  };
  const lines = text
    .split(/\r?\n/)
    .map((l) => l.trim().replace(/^[-*\s]+/, ""))
    .filter((l) => /^\d+\s*\|/.test(l));
  if (lines.length) {
    for (const l of lines) {
      const [n, score, ...rest] = l.split("|");
      take(n, score, rest.join("|"));
    }
  } else {
    for (const r of jsonArrayIn(text)) take(r.n, r.score ?? r.s, r.why ?? r.reason);
  }
  return { results, rejected };
}

/**
 * Who goes on the list, by the model's score: best first, nobody under the
 * floor, at most `room`. Pure, for tests. Anyone the model did not score is
 * left out — they were asked about and got no answer.
 */
export function pickByScore<T extends { candidate: { id: string } }>(
  pool: T[],
  verdicts: Map<string, MatchVerdict>,
  room: number,
  floor: number,
): { chosen: T[]; under: number; unscored: number } {
  const score = (p: T) => verdicts.get(p.candidate.id)!.score;
  const ranked = pool.filter((p) => verdicts.has(p.candidate.id)).sort((a, b) => score(b) - score(a));
  const above = ranked.filter((p) => score(p) >= floor);
  return { chosen: above.slice(0, room), under: ranked.length - above.length, unscored: pool.length - ranked.length };
}

/**
 * Scores and reasons for these people, by candidate id, and who gave them:
 * Claude first, DeepSeek when Claude has no answer (5 Oct: "if something
 * happens to the Claude subscription, straight away move to DeepSeek"). Null
 * when neither answered; the caller then keeps the engine's scores.
 */
export async function claudeMatchScores(
  job: MatchJob,
  candidates: Candidate[],
): Promise<{ results: Map<string, MatchVerdict>; by: "claude" | "deepseek" } | null> {
  if (candidates.length === 0) return { results: new Map(), by: "claude" };
  const prompt = matchPrompt(job, candidates.map((c, i) => matchLine(i + 1, c)));
  // The reference back to the record: number n is candidates[n - 1].
  const byId = (m: Map<number, MatchVerdict>) => new Map([...m].map(([n, v]) => [candidates[n - 1].id, v]));

  const fromClaude = await askClaude(prompt, candidates.length);
  if (fromClaude) return { results: byId(fromClaude), by: "claude" };

  // DeepSeek, on OpenRouter — the engine matching used before. Only that
  // route: with no OpenRouter key, `write` would reach for the metered
  // Anthropic key, which is not a fallback anyone asked for.
  const { viaOpenRouter, write } = await import("./ai");
  if (!viaOpenRouter()) return null;
  const r = await write("", prompt, 1500, "rank");
  const fromDeepSeek = r.ok ? readMatchText(r.text, candidates.length).results : new Map<number, MatchVerdict>();
  if (fromDeepSeek.size) return { results: byId(fromDeepSeek), by: "deepseek" };
  console.warn(`[claude-match] DeepSeek had no answer either (${r.ok ? "unreadable" : r.reason}); engine scores kept`);
  return null;
}

async function askClaude(prompt: string, count: number): Promise<Map<number, MatchVerdict> | null> {
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
  const { results, rejected, error } = readMatch(r.out, count);
  if (error || results.size === 0) {
    console.warn(`[claude-match] ${error ?? `exited ${r.code}: ${r.err.slice(0, 200)}`}; asking DeepSeek`);
    return null;
  }
  if (rejected) console.warn(`[claude-match] ${rejected} answer(s) dropped: not one of the people asked about`);
  return results;
}
