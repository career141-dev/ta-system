import type { RefereeCallResult } from "@/data/types";

export type CallResult = RefereeCallResult;

/**
 * Sort a written call outcome without an AI round trip. The pessimistic
 * default is deliberate: until somebody has offered or supplied a contact,
 * the call has not succeeded.
 */
export function classifyFeedback(feedback: string): CallResult {
  const text = String(feedback ?? "").trim().toLowerCase();

  // The desk's real example contains "cannot give" followed by a concrete
  // promise to pass the number and call back. Keep that promise positive while
  // still treating a bare refusal as unsuccessful.
  if (/can(?:not|'t)\s+give\b[\s\S]*\b(?:will\s+pass|will\s+call\s+back)\b/i.test(text)) return "positive";

  const negative = [
    /\bno\s+contacts?\b/,
    /\bno\s+(?:phone\s+)?number\b/,
    /\bno\s+answer\b/,
    /\bnot\s+respond(?:ing|ed)?\b/,
    /\bnot\s+answer(?:ing|ed)?\b/,
    /\bwrong\s+number\b/,
    /\b(?:overseas|abroad)\b/,
    /\bnot\s+available\b/,
    // "Not interested" contains the positive word "interested" (review, 23 Oct).
    /\bnot\s+interested\b/,
    /\bno\s+interest\b/,
    /\bcan(?:not|'t)\s+give\b/,
    /\b(?:refused|declined)\b/,
    /\bswitched\s+off\b/,
    /\bnot\s+reachable\b/,
  ];
  if (negative.some((pattern) => pattern.test(text))) return "negative";

  const positive = [
    /\b(?:have|has)\s+(?:got\s+)?a\s+contact\b/,
    /\bwill\s+share\b/,
    /\bwill\s+send\b/,
    /\bwill\b[\s\S]*\bwhats\s*app\b/,
    /\bwill\s+call\s+back\b/,
    /\bwill\s+pass\b(?:[\s\S]*\b(?:the|this|my|his|her)\s+number\b)?/,
    /\bnumber\s+(?:received|given|shared)\b/,
    /\binterested\b/,
  ];
  return positive.some((pattern) => pattern.test(text)) ? "positive" : "negative";
}

export function resultOf(call: { feedback: string; result?: CallResult | null }): CallResult {
  return call.result ?? classifyFeedback(call.feedback);
}
