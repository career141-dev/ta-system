// Pure helpers for reading shortlist replies. Kept free of Convex and Graph so
// the exact safety rules can be unit-tested without touching a mailbox or DB.

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
    const next = out.replace(/^\s*(?:re|fw|fwd)\s*:\s*/i, "");
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

const POSITIVE = /\b(shortlist(?:ed)?|select(?:ed)?|proceed|go ahead|take forward|interview|approve(?:d)?|both|all)\b/i;
const NEGATIVE = /\b(not shortlisted|reject(?:ed)?|drop(?:ped)?|not suitable|unsuitable|decline(?:d)?|none|neither)\b/i;
const HOLD = /\b(optional(?:ly)?|conditional(?:ly)?|maybe|hold|reserve|backup|stand ?by|not sure|unsure)\b/i;
const OTHERS = /\b(other|others|remaining|rest)\b/i;

function uniqueNameTokens(candidate: ReplyCandidate, roster: ReplyCandidate[]): string[] {
  return candidate.name
    .toLowerCase()
    .replace(/[^a-z0-9 ]/g, " ")
    .split(/\s+/)
    .filter((part) => part.length >= 3)
    .filter((part) => roster.filter((row) => row.name.toLowerCase().includes(part)).length === 1);
}

function outcomeOf(text: string): ReplyOutcome | null {
  if (HOLD.test(text)) return "hold";
  if (NEGATIVE.test(text)) return "rejected";
  if (POSITIVE.test(text)) return "shortlisted";
  return null;
}

/**
 * Conservative deterministic parser. It proposes only people explicitly
 * named/numbered, except for unambiguous whole-roster words (all/both/none).
 * Silence is never turned into rejection.
 */
export function parseShortlistReply(raw: string, roster: ReplyCandidate[]): ParsedShortlistReply {
  const text = newestReplyText(raw);
  const reasons = new Set<string>();
  const picked = new Map<string, ReplyDecision>();
  if (!text) return { decisions: [], reviewReasons: ["The reply body is empty."], autoSafe: false };
  if (OTHERS.test(text)) reasons.add('“Others/remaining” must be checked against the original roster.');
  if (HOLD.test(text)) reasons.add("Optional or conditional decisions require confirmation.");

  const clauses = text.split(/[\n.!?;]+/).map((part) => part.trim()).filter(Boolean);
  for (const clause of clauses) {
    const bareNumberList = /^\s*#?\d{1,2}(?:\s*(?:,|&|and)\s*#?\d{1,2})*\s*$/i.test(clause);
    const outcome = outcomeOf(clause) ?? (bareNumberList ? "shortlisted" : null);
    if (!outcome) continue;
    const lower = clause.toLowerCase();
    const numbers = new Set<number>();
    for (const hit of clause.matchAll(/(?<!\d)(\d{1,2})(?!\d)/g)) {
      const n = Number(hit[1]);
      const at = hit.index ?? 0;
      const before = lower.slice(Math.max(0, at - 12), at);
      const after = lower.slice(at + hit[1].length, at + hit[1].length + 14);
      if (/\b(?:at|on)\s*$/.test(before) || /^\s*(?:am|pm|years?|weeks?|days?|months?|%|lakhs?|lkr|usd)\b/.test(after)) continue;
      if (n >= 1 && n <= roster.length) numbers.add(n);
    }
    const wholeRoster = /\b(all|both|everyone|everybody|none|neither)\b/i.test(clause) && !OTHERS.test(clause);
    if (wholeRoster) for (let n = 1; n <= roster.length; n++) numbers.add(n);
    if (roster.length === 1 && numbers.size === 0) numbers.add(1);

    const matchedNames = new Set<string>();
    for (const n of numbers) {
      const candidate = roster[n - 1];
      const prior = picked.get(candidate.applicationId);
      if (prior && prior.outcome !== outcome) reasons.add(`Conflicting decisions were found for ${candidate.name}.`);
      picked.set(candidate.applicationId, { applicationId: candidate.applicationId, outcome, evidence: clause.slice(0, 240) });
    }
    for (const candidate of roster) {
      const tokens = uniqueNameTokens(candidate, roster);
      if (!tokens.some((token) => new RegExp(`\\b${token}\\b`, "i").test(lower))) continue;
      tokens.forEach((token) => matchedNames.add(token));
      const prior = picked.get(candidate.applicationId);
      if (prior && prior.outcome !== outcome) reasons.add(`Conflicting decisions were found for ${candidate.name}.`);
      picked.set(candidate.applicationId, { applicationId: candidate.applicationId, outcome, evidence: clause.slice(0, 240) });
    }
    if (!wholeRoster && numbers.size === 0 && roster.length > 1) {
      const ignored = new Set([
        "please", "kindly", "shortlist", "shortlisted", "select", "selected", "proceed", "interview",
        "approve", "approved", "reject", "rejected", "drop", "dropped", "hold", "optional", "conditional",
        "maybe", "reserve", "none", "both", "all", "not", "suitable", "unsuitable", "candidate",
      ]);
      const unknown = [...clause.matchAll(/\b[A-Z][a-z]{2,}\b/g)]
        .map((hit) => hit[0].toLowerCase())
        .filter((word) => !ignored.has(word) && !matchedNames.has(word));
      if (unknown.length > 0) reasons.add(`Could not uniquely match: ${[...new Set(unknown)].join(", ")}.`);
      if (matchedNames.size === 0) reasons.add(`Could not match a candidate in: “${clause.slice(0, 120)}”.`);
    }
  }

  const decisions = [...picked.values()];
  if (decisions.length === 0) reasons.add("No explicit candidate decision could be read safely.");
  if (decisions.some((decision) => decision.outcome === "hold")) reasons.add("Held candidates are never moved automatically.");
  return { decisions, reviewReasons: [...reasons], autoSafe: reasons.size === 0 && decisions.length > 0 };
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
