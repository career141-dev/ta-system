/**
 * Reading a director's or a client's reply.
 *
 * They answer in prose — "1, 3 and 5 look good, drop 2, not sure about 4" — and
 * somebody currently reads that and moves five people by hand. This turns the
 * sentence into decisions.
 *
 * The discipline is the same one the sourcing pipeline uses: **the model
 * chooses from a closed list it is given, and cannot name anyone else.**
 * Candidates are offered as numbered lines, the reply comes back as numbers,
 * and a number outside the range is dropped. A hallucinated name is therefore
 * structurally impossible — the worst case is a decision missed, never a
 * decision invented about someone who was not in the set.
 *
 * There is a deterministic reader first, because most replies are "1,3,5" or
 * "shortlist 1 and 4" and do not need a model at all.
 */

import { gemini } from "./ai";

import {
  extractReplyText, readNames, readNumbers, readReply, unreadableClauses,
  type Candidateish, type Outcome, type ParsedDecision,
} from "./replyReader";

export {
  extractReplyText, readNames, readNumbers, unreadableClauses,
  type Candidateish, type Outcome, type ParsedDecision,
};
export type { Unreadable } from "./replyReader";

export interface ParseResult {
  decisions: ParsedDecision[];
  /** How it was read, so the TA knows whether to check it. */
  method: "numbers" | "model" | "none";
  /**
   * Anything the reader would not act on: a clause it refused to guess at, and
   * anything said about somebody not in the set. Shown to the TA, never applied.
   */
  unmatched: string[];
}

const PROMPT = `A recruitment director or a client has replied about a shortlist. Turn the reply into decisions.

You are given a numbered list of the people that were sent. You may only refer to them by their number. You must not name anyone who is not on the list, and you must not invent a decision for someone the reply does not mention.

Return ONLY a JSON object:
{"decisions":[{"n": number, "outcome": "shortlisted" | "rejected" | "hold", "note": "their words, trimmed"}],
 "unmatched":["anything said about a person who is not on the list"]}

Rules:
- "shortlisted" means take them forward. "rejected" means do not. "hold" means undecided, a maybe, or a reserve.
- Silence is not a decision. A person the reply does not mention gets no entry.
- Keep the note to the reviewer's own words, under 160 characters.`;

export async function parseReply(
  reply: string,
  list: Candidateish[],
): Promise<ParseResult> {
  const read = readReply(reply, list);
  // Clauses the reader refused to guess at. They are never acted on, and they
  // are never dropped either — the TA sees them and decides.
  const refused = unreadableClauses(reply).map((u) => `${u.clause.trim()} — ${u.why}`);

  // Merged with an explicit number beating a name mentioned in passing, and
  // either beating all/both/none (replyReader.readReply).
  const merged = new Map<string, ParsedDecision>(read.decisions.map((d) => [d.applicationId, d]));

  // A clean read of the whole set needs no model.
  // A clean read of the whole set needs no model — unless something was
  // refused, in which case a second opinion is worth the call.
  if (merged.size >= list.length && refused.length === 0) {
    return { decisions: [...merged.values()], method: "numbers", unmatched: [] };
  }

  const roster = list.map((c, i) => `${i + 1}. ${c.name}`).join("\n");
  const res = await gemini("parse", `${PROMPT}\n\nThe people sent:\n${roster}\n\nThe reply:\n${reply}`, {
    maxTokens: 900,
    temperature: 0,
  });

  if (!res.ok) {
    return {
      decisions: [...merged.values()],
      method: merged.size ? "numbers" : "none",
      unmatched: refused,
    };
  }

  try {
    const text = res.text.trim().replace(/^```(?:json)?/i, "").replace(/```$/, "").trim();
    const json = JSON.parse(text.match(/\{[\s\S]*\}/)?.[0] ?? text) as {
      decisions?: { n?: number; outcome?: string; note?: string }[];
      unmatched?: string[];
    };

    const conflicts: string[] = [];
    for (const d of json.decisions ?? []) {
      const c = list[(Number(d.n) || 0) - 1];
      // Out of range is dropped rather than guessed at.
      if (!c) continue;
      const outcome = (["shortlisted", "rejected", "hold"] as const).find((o) => o === d.outcome);
      if (!outcome) continue;
      // The model only fills gaps. Where it disagrees with what the reply says
      // in plain numbers or names, nobody is moved on either reading — a person
      // decides (13 September review: the model could overwrite a clean read).
      const prior = merged.get(c.applicationId);
      if (prior) {
        if (prior.outcome !== outcome) {
          merged.delete(c.applicationId);
          conflicts.push(`${c.name} — the reply reads two ways (${prior.outcome} / ${outcome}); decide this one yourself`);
        }
        continue;
      }
      if (conflicts.some((x) => x.startsWith(`${c.name} —`))) continue;
      merged.set(c.applicationId, {
        applicationId: c.applicationId,
        outcome,
        note: typeof d.note === "string" ? d.note.slice(0, 160) : null,
      });
    }

    return {
      decisions: [...merged.values()],
      method: "model",
      unmatched: [...conflicts, ...refused, ...(json.unmatched ?? []).filter((x) => typeof x === "string")].slice(0, 8),
    };
  } catch {
    return {
      decisions: [...merged.values()],
      method: merged.size ? "numbers" : "none",
      unmatched: refused,
    };
  }
}

/** Keep older entry points safe: silence is not evidence of rejection. */
export function withUnpickedRejected(parsed: ParseResult, _applicationIds: string[]): ParsedDecision[] {
  return parsed.decisions;
}
