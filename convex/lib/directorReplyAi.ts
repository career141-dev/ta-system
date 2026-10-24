// convex/lib/directorReplyAi.ts
//
// Reading a Director's reply with the model, for the replies the strict reader
// (lib/shortlistReply.ts) will not act on alone (23 October). The Director
// writes the way a person does — "Others are shortlisted", "Excluding Arpon
// others are shortlisted", "Chamika — what's her age?" — and of 115 replies
// in shortlists@ the strict reader could apply 27; read against the set's
// names, the model read 62 clearly. Pure: the prompt, the check of its
// answer, and matching a set's CV file names to candidates. No Convex, no
// network, so it is tested alone (tests/directorreplyai.test.ts).
//
// The owner's rules (23 October):
//   shortlisted / optional  → Director shortlist (optional with an "Optional" note)
//   not shortlisted, too expensive, sourced previously → Rejected
//   a question or a score ("what's her age?", "65%") → no move; the TA's task is noted

import type { ReplyDecision } from "./shortlistReply";

export interface RosterRow {
  applicationId: string;
  name: string;
}

export function directorReplyPrompt(roster: RosterRow[], replyText: string, reviewer: "director" | "client" = "director"): string {
  const list = roster.map((r, i) => `${i + 1}. ${r.name}`).join("\n");
  const who = reviewer === "client" ? "The client company" : "A recruitment Director";
  return `${who} replied to a recruitment agency's email that submitted these candidates:
${list}

The reply:
"""
${replyText.slice(0, 6000)}
"""

For EACH numbered candidate decide one of:
- "shortlisted" (also "Shortlisted, but we need his updated CV" — the condition is a task)
- "optional" (optional shortlisted / shortlisted as optional / reserve)
- "not_shortlisted" (not shortlisted, too expensive, too junior, not strong enough, sourced previously, out, no relevance)
- "no_decision" (only a question or a score like 65%, needs information, or not mentioned at all)
Rules: "All/Both/All three shortlisted" means every candidate. "Others/rest/remaining/other two shortlisted" means every candidate not decided otherwise in the reply. A bare "Shortlisted." with one candidate means that candidate; with several and no names, it means all of them. Match names by first name or surname, ignoring spelling slips. Never invent a decision.
Reply with JSON only: {"decisions":[{"n":1,"decision":"...","reason":"short reason from the reply or empty","task":"what the TA must do, or empty"}],"namesNotInList":["names the reply decides about that are not in the list"],"confident":true|false}`;
}

export interface AiReading {
  decisions: ReplyDecision[];
  /** Safe to apply without a person: confident, every candidate read once, nobody unknown. */
  clear: boolean;
  problems: string[];
}

const OUTCOME: Record<string, ReplyDecision["outcome"]> = {
  shortlisted: "shortlisted",
  optional: "shortlisted",
  not_shortlisted: "rejected",
  no_decision: "hold",
};

/** The model's answer, checked against the set before anything acts on it. */
export function readAiAnswer(raw: unknown, roster: RosterRow[]): AiReading {
  const problems: string[] = [];
  const answer = (typeof raw === "string" ? safeJson(raw) : raw) as {
    decisions?: { n?: number; decision?: string; reason?: string; task?: string }[];
    namesNotInList?: string[];
    confident?: boolean;
  } | null;
  if (!answer || !Array.isArray(answer.decisions)) return { decisions: [], clear: false, problems: ["The AI reader gave no usable answer."] };
  const seen = new Set<number>();
  const decisions: ReplyDecision[] = [];
  for (const d of answer.decisions) {
    const n = Number(d.n);
    const row = roster[n - 1];
    const outcome = OUTCOME[String(d.decision ?? "")];
    if (!row || !outcome) { problems.push(`The AI reader returned an unknown candidate or decision (${d.n}: ${d.decision}).`); continue; }
    if (seen.has(n)) { problems.push(`The AI reader decided ${row.name} twice.`); continue; }
    seen.add(n);
    const reason = String(d.reason ?? "").trim();
    const task = String(d.task ?? "").trim();
    const evidence = [
      d.decision === "optional" ? "Optional" : "",
      reason,
      task ? `TA task: ${task}` : "",
    ].filter(Boolean).join(" — ");
    decisions.push({ applicationId: row.applicationId, outcome, evidence: evidence.slice(0, 240) });
  }
  const unknown = (answer.namesNotInList ?? []).map((s) => String(s).trim()).filter(Boolean);
  if (unknown.length) problems.push(`The reply decides about people not in this set: ${unknown.join(", ")}.`);
  if (seen.size !== roster.length) problems.push(`The AI reader decided ${seen.size} of the ${roster.length} candidates in this set.`);
  if (answer.confident !== true) problems.push("The AI reader was not confident about this reply.");
  return { decisions, clear: problems.length === 0 && decisions.length > 0, problems };
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text.replace(/^\s*```(?:json)?/i, "").replace(/```\s*$/, "").trim());
  } catch {
    return null;
  }
}

/** "Rizny Ahamed - Career141.pdf" → "Rizny Ahamed". */
export function nameFromCvFile(file: string): string {
  return file
    .replace(/\.(pdf|docx?)$/i, "")
    .replace(/\s*[-–_]\s*career\s*141.*$/i, "")
    .replace(/\b(cv|resume)\b/gi, "")
    .replace(/\s+/g, " ")
    .trim();
}

export const isCvFile = (file: string) => /\.(pdf|docx?)$/i.test(file);

const NOT_NAME = new Set(["mba", "cv", "cvs", "resume", "career", "mrs", "miss", "mr", "ms", "dr"]);
const nameWords = (s: string) => s.toLowerCase().normalize("NFKD").replace(/[^a-z ]/g, " ").split(/\s+/).filter((w) => w.length >= 3 && !NOT_NAME.has(w));

/**
 * The set an email submitted, from its CV file names: each file matched to the
 * candidate on the opening who shares its words — two when the file has two or
 * more, one when it has one (a file named only "ILYAS"). A file that matches
 * nobody, or more than one person equally, is left out and reported.
 */
export function matchCvFiles<T extends { applicationId: string; name: string }>(
  files: string[],
  candidates: T[],
): { roster: T[]; unmatched: string[] } {
  const roster: T[] = [];
  const unmatched: string[] = [];
  for (const file of files.filter(isCvFile)) {
    const want = nameWords(nameFromCvFile(file));
    if (want.length === 0) continue;
    const need = Math.min(2, want.length);
    const scored = candidates
      .map((c) => ({ c, shared: want.filter((w) => new Set(nameWords(c.name)).has(w)).length }))
      .filter((x) => x.shared >= need)
      .sort((a, b) => b.shared - a.shared);
    const best = scored[0];
    if (!best || (scored[1] && scored[1].shared === best.shared) || roster.some((r) => r.applicationId === best.c.applicationId)) {
      unmatched.push(nameFromCvFile(file));
      continue;
    }
    roster.push(best.c);
  }
  return { roster, unmatched };
}
