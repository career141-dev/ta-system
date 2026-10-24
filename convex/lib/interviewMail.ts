// convex/lib/interviewMail.ts
//
// Reading the mail at interviews@ (24 October). The TAs invite a candidate
// to the client's interview from Outlook, always with the subject
// "CLIENT [INTERVIEW] > ROLE > CANDIDATE", to the candidate's own address;
// the candidate answers in the same thread; a cancelled meeting arrives as
// "Canceled: …". "CAREER141 INTERVIEW > …" is Career141 hiring for itself,
// not a client's opening. Pure — tested in tests/interviewmail.test.ts.

import { stripReplyPrefixes } from "./shortlistReply";

export type InterviewMailKind = "invite" | "cancel" | "reply" | "ignore";
export type InterviewAnswer = "confirmed" | "declined" | "replied";

export interface InterviewMail {
  kind: InterviewMailKind;
  client: string;
  role: string;
  candidate: string;
  /** A candidate's reply: what they said. */
  answer?: InterviewAnswer;
  /** Why it is ignored. */
  why?: string;
}

const OURS = "@career141.com";

export function readInterviewMail(m: { subject: string; fromAddress: string; body: string }): InterviewMail {
  const raw = (m.subject ?? "").trim();
  const cancelled = /^\s*(?:re\s*:\s*)?cancel+ed\s*:/i.test(raw);
  const isReply = /^\s*(?:re|fw|fwd)\s*:/i.test(raw);
  const subject = stripReplyPrefixes(raw.replace(/^\s*cancel+ed\s*:\s*/i, ""));
  const parts = subject.split(">").map((s) => s.trim()).filter(Boolean);
  const none = (why: string): InterviewMail => ({ kind: "ignore", client: "", role: "", candidate: "", why });
  if (parts.length < 3) return none("The subject is not CLIENT > ROLE > CANDIDATE.");
  const client = parts[0].replace(/\b(?:interviews?|assess?ment round)\b/gi, "").replace(/\s+/g, " ").trim();
  const role = parts.slice(1, -1).join(" > ");
  const candidate = parts[parts.length - 1].replace(/^candidate\s+/i, "").trim();
  if (/^career\s*141\b/i.test(client)) return none("Career141's own hiring, not a client's opening.");
  if (!client || !candidate) return none("The subject names no client or no candidate.");

  const ours = (m.fromAddress ?? "").trim().toLowerCase().endsWith(OURS);
  if (ours) {
    if (cancelled) return { kind: "cancel", client, role, candidate };
    // A TA's follow-up in the thread is not a new invitation.
    if (isReply) return { ...none("A TA's follow-up in the thread."), client, role, candidate };
    return { kind: "invite", client, role, candidate };
  }
  return { kind: "reply", client, role, candidate, answer: readAnswer(m.body) };
}

/** The candidate's answer, from the newest part of their reply. */
export function readAnswer(body: string): InterviewAnswer {
  const text = (body ?? "").split(/\bOn .{5,80}wrote:|From:\s/)[0];
  if (/\b(declin|unable to (attend|make it|participate)|(will|would) not be able|can(no|')t (attend|make it)|withdraw|not interested|after careful consideration|regret)/i.test(text)) return "declined";
  if (/\b(confirm|will attend|will be attending|i accept|accepted|participat|available|i'?ll be there|looking forward)/i.test(text)) return "confirmed";
  return "replied";
}

// "LANKA HOSPITAL" is the subject's, "Lanka Hospitals" the opening's: a plural s is not a different word.
const words = (s: string) => s.toLowerCase().normalize("NFKD").replace(/[^a-z0-9 ]/g, " ").split(/\s+/)
  .filter((w) => w.length >= 2).map((w) => (w.length > 3 ? w.replace(/s$/, "") : w));

/**
 * Whether the subject's client is this opening's client: every word of the
 * shorter name in the longer ("Q COLLECTION" — "Q COLLECTION (SL)",
 * "DELMO" — "DELMO - HOLDING", "MELWIRE" — "Melwire Group").
 */
export function sameClient(subjectClient: string, clientName: string): boolean {
  const a = words(subjectClient), b = words(clientName);
  if (!a.length || !b.length) return false;
  const [short, long] = a.length <= b.length ? [a, b] : [b, a];
  return short.every((w) => long.includes(w));
}

/** How many of the role's words the opening's title shares. */
export function roleOverlap(role: string, title: string): number {
  const t = new Set(words(title));
  return words(role).filter((w) => w.length >= 3 && t.has(w)).length;
}
