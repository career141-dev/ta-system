// Pure helpers for reading shortlist replies. Kept free of Convex and Graph so
// the exact safety rules can be unit-tested without touching a mailbox or DB.

import { readReply } from "../../src/lib/replyReader";

export type ReplyOutcome = "shortlisted" | "rejected" | "hold";

export interface ReplyCandidate {
  applicationId: string;
  name: string;
}

export interface ReplyDecision {
  applicationId: string;
  outcome: ReplyOutcome;
  evidence: string;
}

export interface ParsedShortlistReply {
  decisions: ReplyDecision[];
  reviewReasons: string[];
  autoSafe: boolean;
}

export function stripReplyPrefixes(subject: string): string {
  let out = (subject ?? "").trim();
  for (;;) {
    // "REVISED - " is the TA resending the same email (lib/eod-format); a
    // reply to it belongs to the same round.
    const next = out.replace(/^\s*(?:re|fw|fwd)\s*:\s*/i, "").replace(/^\s*revised\s*[-–—:]\s*/i, "");
    if (next === out) return out.replace(/\s+/g, " ").trim();
    out = next;
  }
}

export function reviewToken(subject: string): string | null {
  return subject.match(/\bC141-[A-HJ-NP-Z2-9]{6}\b/i)?.[0].toUpperCase() ?? null;
}

/** Only the newly typed part of a reply is evidence. */
export function newestReplyText(raw: string): string {
  let text = (raw ?? "").replace(/\r\n/g, "\n");
  if (/<[a-z][\s\S]*>/i.test(text)) {
    text = text
      .replace(/<head[\s\S]*?<\/head>/gi, "")
      .replace(/<style[\s\S]*?<\/style>/gi, "")
      .replace(/<script[\s\S]*?<\/script>/gi, "");
    const quote = /<(?:blockquote|div)[^>]*(?:gmail_quote|gmail_attr|divRplyFwdMsg|orig_message|quoted-text)[^>]*>[\s\S]*/i.exec(text);
    if (quote) text = text.slice(0, quote.index);
    text = text
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<\/(?:p|div|li|tr|h\d)>/gi, "\n")
      .replace(/<[^>]+>/g, " ")
      .replace(/&nbsp;/gi, " ")
      .replace(/&amp;/gi, "&")
      .replace(/&lt;/gi, "<")
      .replace(/&gt;/gi, ">")
      .replace(/&#39;/g, "'")
      .replace(/&quot;/gi, '"');
  }
  const quoted = [
    /(?:^|\n)\s*-{2,}\s*(?:Original Message|Forwarded message)[\s\S]*/i,
    /(?:^|\n)\s*On\s.+?wrote:\s*[\s\S]*/i,
    /(?:^|\n)\s*(?:From|Sent|To|Subject|Date):\s*.+[\s\S]*/i,
    /(?:^|\n)\s*>.+[\s\S]*/,
  ];
  for (const pattern of quoted) {
    const hit = pattern.exec(text);
    if (hit) text = text.slice(0, hit.index);
  }
  return text.replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n").trim();
}

const HOLD_WORDS = /\b(optional(?:ly)?|conditional(?:ly)?|maybe|hold|reserve|backup|stand ?by|not sure|unsure)\b/i;
const OTHERS = /\b(other|others|remaining|rest)\b/i;

/** Capitalised words that are not somebody's name. */
const NOT_A_NAME = new Set([
  "please", "kindly", "shortlist", "shortlisted", "select", "selected", "selection", "proceed", "interview",
  "approve", "approved", "reject", "rejected", "drop", "dropped", "hold", "optional", "conditional",
  "maybe", "reserve", "none", "both", "all", "not", "suitable", "unsuitable", "candidate", "candidates",
  "yes", "no", "ok", "okay", "good", "fine", "strong", "weak", "keep", "include", "take", "go", "ahead",
  "forward", "pass", "decline", "declined", "remove", "except", "only", "just", "first", "second", "third",
  "last", "number", "set", "and", "but", "the", "they", "them", "he", "she", "his", "her", "we", "i", "you",
  "is", "are", "was", "can", "could", "would", "will", "should", "let", "also", "with", "for", "this", "that",
  "these", "those", "one", "ones", "cv", "cvs", "sir", "madam", "director", "client", "team", "thanks",
]);

/**
 * Conservative deterministic reading of a reply at shortlists@. The rules are
 * the TA paste box's (src/lib/replyReader.ts) — negation, "not 2", masked
 * times, dates and set numbers — and this adds the gate for acting without a
 * person: `autoSafe` only when every sentence was read, nobody was read two
 * ways and nothing was held.
 *
 * Replaced the 19 Oct regex reader on 22 Oct. That one had no negation, so
 * "2 not selected" and "Do not proceed with 2" both shortlisted candidate two,
 * and "Hi all" shortlisted the whole set — each marked safe to apply.
 * Silence is never turned into rejection.
 */
export function parseShortlistReply(raw: string, roster: ReplyCandidate[]): ParsedShortlistReply {
  const text = newestReplyText(raw);
  const reasons = new Set<string>();
  if (!text) return { decisions: [], reviewReasons: ["The reply body is empty."], autoSafe: false };
  if (OTHERS.test(text)) reasons.add("“Others/remaining” must be checked against the original roster.");
  if (HOLD_WORDS.test(text)) reasons.add("Optional or conditional decisions require confirmation.");

  const read = readReply(text, roster);
  const nameOf = (id: string) => roster.find((row) => row.applicationId === id)?.name ?? id;
  for (const id of read.conflicts) reasons.add(`Conflicting decisions were found for ${nameOf(id)}.`);
  for (const refused of read.unreadable) reasons.add(`Could not read safely: “${refused.clause.slice(0, 120)}” — ${refused.why}`);
  for (const sentence of read.unplaced) reasons.add(`Could not match a candidate in: “${sentence.slice(0, 120)}”.`);
  // "Nimal and Dilani, not Kasun": a person named with no verdict of their own
  // is not guessed from the next clause (22 Oct); a person decides.
  for (const clause of read.undecided) reasons.add(`No decision was written for: “${clause.slice(0, 120)}”.`);
  for (const n of read.outOfRange) reasons.add(`Candidate number ${n} is not in this email.`);
  if (read.mixedWholeSet) reasons.add("“All/both/none” was used alongside named candidates; check who it covers.");

  // A name the set does not hold — "Nimal and Ruwan are shortlisted" — is a
  // person this reply decides about whom we cannot place.
  const known = new Set(roster.flatMap((row) => row.name.toLowerCase().split(/[^a-z0-9]+/)).filter(Boolean));
  const unknown = [...text.matchAll(/\b[A-Z][a-z]{2,}\b/g)]
    .map((hit) => hit[0].toLowerCase())
    .filter((word) => !NOT_A_NAME.has(word) && !known.has(word));
  const decisive = /\b(shortlist|select|proceed|approve|reject|drop|interview|take|go ahead|not suitable|unsuitable)/i;
  const sentencesWithUnknown = text.split(/[\n.!?;]+/).filter((sentence) =>
    decisive.test(sentence) && unknown.some((word) => new RegExp(`\\b${word}\\b`, "i").test(sentence)));
  if (sentencesWithUnknown.length > 0) {
    const words = unknown.filter((word) => sentencesWithUnknown.some((sentence) => new RegExp(`\\b${word}\\b`, "i").test(sentence)));
    reasons.add(`Could not uniquely match: ${[...new Set(words)].join(", ")}.`);
  }

  const decisions: ReplyDecision[] = read.decisions.map((decision) => ({
    applicationId: decision.applicationId,
    outcome: decision.outcome,
    evidence: (decision.note ?? "").slice(0, 240),
  }));
  if (decisions.length === 0) reasons.add("No explicit candidate decision could be read safely.");
  if (decisions.some((decision) => decision.outcome === "hold")) reasons.add("Held candidates are never moved automatically.");
  return { decisions, reviewReasons: [...reasons], autoSafe: reasons.size === 0 && decisions.length > 0 };
}

/** Stages a candidate sits in while the reviewer has not yet decided. */
const AWAITING: Record<"director" | "client", string[]> = {
  director: ["new_cvs", "matched_candidates", "ta_shortlist", "ai_call", "follow_up", "second_shortlist"],
  client: ["director_shortlist"],
};

/** Where a reviewer's "yes" puts somebody. */
export const SHORTLIST_STAGE = { director: "director_shortlist", client: "client_review" } as const;

/**
 * What a reviewer's decision does to somebody, given where they stand now.
 *
 *   move     waiting for this reviewer: moved to the shortlist or to rejected
 *   already  already where the decision puts them: recorded, not moved
 *   correct  the reviewer said no, but they were already moved onto this
 *            reviewer's shortlist — by the TA's own email copy, an earlier
 *            misread, or a hand. A person confirmed it, so they come off.
 *   left     anything else: recorded, not moved, and reported, so a person
 *            decides. A "no" read without a person is never a correction.
 *
 * Until 22 Oct everybody past the waiting stages was "stale" and the decision
 * was dropped, so a wrong move could never be undone by the Director's reply.
 */
export function placement(
  kind: "director" | "client",
  stage: string,
  outcome: ReplyOutcome,
  confirmed: boolean,
): "move" | "already" | "correct" | "left" {
  if (outcome === "hold") return "already";
  const target = outcome === "shortlisted" ? SHORTLIST_STAGE[kind] : "rejected";
  if (stage === target) return "already";
  if (AWAITING[kind].includes(stage)) return "move";
  if (outcome === "rejected" && stage === SHORTLIST_STAGE[kind]) return confirmed ? "correct" : "left";
  return "left";
}

export interface ReplyRound {
  id: string;
  token: string;
  subject: string;
  status: "awaiting" | "partial" | "returned";
  conversationId?: string | null;
  internetMessageId?: string | null;
  messageId?: string | null;
  senderAuthorized?: boolean;
}

export function matchReplyRound(
  message: { subject: string; conversationId?: string | null; inReplyTo?: string | null },
  rounds: ReplyRound[],
): { round: ReplyRound | null; method: "conversation" | "reply_header" | "token" | "subject" | "none"; note: string } {
  const open = rounds.filter((round) => round.status !== "returned");
  const unique = (rows: ReplyRound[], method: "conversation" | "reply_header" | "token" | "subject", note: string) =>
    rows.length === 1 ? { round: rows[0], method, note } : rows.length > 1 ? { round: null, method: "none" as const, note: `${note} More than one open round matched.` } : null;
  if (message.conversationId) {
    const found = unique(open.filter((round) => round.conversationId === message.conversationId), "conversation", "Matched by the Microsoft 365 conversation.");
    if (found) return found;
  }
  if (message.inReplyTo) {
    const id = message.inReplyTo.trim().replace(/^</, "").replace(/>$/, "").toLowerCase();
    const found = unique(open.filter((round) => [round.internetMessageId, round.messageId].some((value) => value?.trim().replace(/^</, "").replace(/>$/, "").toLowerCase() === id)), "reply_header", "Matched by In-Reply-To.");
    if (found) return found;
  }
  const token = reviewToken(message.subject);
  if (token) {
    const found = unique(open.filter((round) => round.token.toUpperCase() === token), "token", `Matched ${token}.`);
    if (found) return found;
  }
  const subject = stripReplyPrefixes(message.subject).replace(/\s*\[C141-[A-HJ-NP-Z2-9]{6}\]\s*/ig, " ").replace(/\s+/g, " ").trim().toLowerCase();
  const found = unique(open.filter((round) => (round.senderAuthorized ?? true) && stripReplyPrefixes(round.subject).replace(/\s*\[C141-[A-HJ-NP-Z2-9]{6}\]\s*/ig, " ").replace(/\s+/g, " ").trim().toLowerCase() === subject), "subject", "Matched the original subject and authorized sender.");
  return found ?? { round: null, method: "none", note: "No open review round matched this reply." };
}
