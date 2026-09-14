/**
 * Follow-up: getting the details a CV never carries, inside one day.
 *
 * The desk's process, as set on 13 September — and deliberately not the live
 * system's day 0 / 2 / 4 / 6, close on day 7:
 *
 *   1. Shortlisting sends the candidate here, and the **AI call goes first**.
 *   2. **No answer** → WhatsApp and email straight away.
 *   3. **Answered, but not everything** → the rest over WhatsApp.
 *   4. **"Call me at four"** → the call is placed at four.
 *   5. **"I'll WhatsApp it over"** → they are asked by when; nothing arrives by
 *      then → a WhatsApp chase.
 *   6. **Still nothing** a few hours after the messages → one more call, then
 *      one more reminder.
 *   7. **All of it inside one day.** Not done by then → the TA is alerted, and
 *      it becomes a person's job.
 *
 * Contact is allowed 07:00 to 21:00 Colombo, any day of the week. The old
 * working-hours rule is gone: candidates answer in the evening and at weekends.
 *
 * What is asked is not fixed. Current salary, expected salary and notice period
 * are the standard three, each can be switched off, and a TA can add their own
 * questions to an opening. The chase is finished when every question in force
 * has an answer.
 *
 * Two rules kept from before, because they were right:
 *
 *   **Running out of time is not a rejection.** It hands back to the TA.
 *   **The state is derived, not stored.** Worked out from the record and the
 *   contact log each time, so it cannot go stale.
 *
 * Pure module: no store, no I/O, nothing sent.
 */

import type { Candidate } from "@/data/types";
import { colomboDayStart, colomboHour } from "./calendar";

// ─────────────────────────────────────────────────────────────── the questions ──

/** A standard question maps to a field on the candidate; a TA's own does not. */
export type StandardField = "currentSalary" | "expectedSalary" | "noticePeriodDays";

export interface FollowUpQuestion {
  id: string;
  /** How it reads to the desk: "Current salary". */
  label: string;
  /** How it is put to the candidate: "your current salary". */
  ask: string;
  /** Set for the standard three, which write to the candidate record. */
  field: StandardField | null;
  enabled: boolean;
}

export const STANDARD_QUESTIONS: FollowUpQuestion[] = [
  { id: "current_salary", label: "Current salary", ask: "your current salary", field: "currentSalary", enabled: true },
  { id: "expected_salary", label: "Expected salary", ask: "your expected salary", field: "expectedSalary", enabled: true },
  { id: "notice_period", label: "Notice period", ask: "your notice period", field: "noticePeriodDays", enabled: true },
];

/** The questions in force: the desk's standard set, then the opening's own. */
export function questionsInForce(
  standard: FollowUpQuestion[],
  extra: { id: string; label: string }[] = [],
): FollowUpQuestion[] {
  return [
    ...standard.filter((q) => q.enabled),
    ...extra.map((q) => ({
      id: q.id,
      label: q.label,
      ask: q.label.charAt(0).toLowerCase() + q.label.slice(1),
      field: null,
      enabled: true,
    })),
  ];
}

/** Which of them still has no answer. */
export function unanswered(
  questions: FollowUpQuestion[],
  candidate: Candidate,
  answers: Record<string, string> = {},
): FollowUpQuestion[] {
  return questions.filter((q) => {
    if (q.field === "noticePeriodDays") return candidate.noticePeriodDays === null || candidate.noticePeriodDays === undefined;
    if (q.field) return !candidate[q.field];
    return !answers[q.id]?.trim();
  });
}

/**
 * The standard three, for callers that have no question settings to hand —
 * shortlisting's history note and the seed. Kept under its old name.
 */
export type DataPoint = "current_salary" | "expected_salary" | "notice_period";
export function missingFor(c: Candidate): DataPoint[] {
  return unanswered(STANDARD_QUESTIONS, c).map((q) => q.id as DataPoint);
}

// ──────────────────────────────────────────────────────────────────── the clock ──

export type Channel = "whatsapp" | "email" | "ai_call";

const HOUR = 3_600_000;
/** Contact window, Colombo time, every day. */
export const CONTACT_FROM_HOUR = 7;
export const CONTACT_TO_HOUR = 21;
/** The whole chase has one day. */
export const WINDOW_HOURS = 24;
/** How long messages are given before the next step. */
export const NUDGE_AFTER_HOURS = 3;

/** The instant itself if it is inside 07:00–21:00, otherwise the next 07:00. */
export function nextContactMoment(at: number): number {
  const h = colomboHour(at);
  if (h >= CONTACT_FROM_HOUR && h < CONTACT_TO_HOUR) return at;
  const day = colomboDayStart(at);
  return h < CONTACT_FROM_HOUR
    ? day + CONTACT_FROM_HOUR * HOUR
    : day + 24 * HOUR + CONTACT_FROM_HOUR * HOUR;
}

// ─────────────────────────────────────────────────────────────── the contact log ──

export type CallOutcome =
  | "no_answer"
  /** Spoke to them. Whatever they did not give is chased on WhatsApp. */
  | "answered"
  /** They named a time to be called back — `promisedAt`. */
  | "callback"
  /** They said they would send it — by `promisedAt`. */
  | "will_send"
  | "not_interested";

export interface Contact {
  at: number;
  channel: Channel;
  direction: "out" | "in";
  /** Calls only. */
  outcome?: CallOutcome | null;
  promisedAt?: number | null;
}

// ────────────────────────────────────────────────────────────── where it stands ──

export type FollowUpState =
  | "complete" //   every question answered
  | "due" //        something should go out now
  | "waiting" //    the next step has a time, and it is not yet
  | "overdue" //    the day is up and details are still missing — the TA's now
  | "declined" //   they said they are not interested
  | "unreachable"; // no phone and no email

export interface NextStep {
  at: number;
  channels: Channel[];
  /** Why this, in the desk's words. */
  reason: string;
  /** Which message wording fits. */
  purpose: "call" | "no_answer" | "the_rest" | "promised" | "reminder";
}

export interface FollowUp {
  state: FollowUpState;
  missing: FollowUpQuestion[];
  startedAt: number;
  deadline: number;
  next: NextStep | null;
  /** What a person should do, in a sentence. Null while it is running itself. */
  handBack: string | null;
}

/**
 * Where one candidate's chase stands, and what happens next.
 *
 * Read the log from the newest call backwards: the latest call's outcome
 * decides the branch, and whatever has gone out or come in since decides how
 * far along that branch they are.
 */
export function followUpFor(input: {
  candidate: Candidate;
  questions: FollowUpQuestion[];
  answers?: Record<string, string>;
  enteredAt: number;
  contacts: Contact[];
  now?: number;
}): FollowUp {
  const now = input.now ?? Date.now();
  const c = input.candidate;
  const missing = unanswered(input.questions, c, input.answers);
  const startedAt = nextContactMoment(input.enteredAt);
  const deadline = startedAt + WINDOW_HOURS * HOUR;
  const base = { missing, startedAt, deadline };
  const names = missing.map((q) => q.label.toLowerCase()).join(", ");

  const log = [...input.contacts].sort((a, b) => a.at - b.at);
  const calls = log.filter((x) => x.channel === "ai_call" && x.direction === "out");
  const lastCall = calls[calls.length - 1];

  // Withdrawal comes before completeness: someone who said no is not "ready to
  // move on" because their salary and notice happen to be filled in (13 September review).
  if (lastCall?.outcome === "not_interested") {
    return { ...base, state: "declined", next: null, handBack: "They said they are not interested. Mark them dropped out." };
  }

  if (missing.length === 0) {
    return { ...base, state: "complete", next: null, handBack: "Everything is in. Move them on to the Director." };
  }
  if (!c.phone && !c.email) {
    return {
      ...base,
      state: "unreachable",
      next: null,
      handBack: "No phone and no email on the record. Nothing can go out — find a number or drop them.",
    };
  }

  // Inclusive, less the call itself: a WhatsApp logged in the same minute as
  // the call it followed still counts as after it.
  const after = (t: number) => log.filter((x) => x.at >= t && x !== lastCall);
  const messagesOut = (list: Contact[]) =>
    list.filter((x) => x.direction === "out" && (x.channel === "whatsapp" || x.channel === "email"));
  const replies = (list: Contact[]) => list.filter((x) => x.direction === "in");
  const step = (at: number, channels: Channel[], reason: string, purpose: NextStep["purpose"]): NextStep => ({
    at: nextContactMoment(Math.max(at, startedAt)),
    // Only what can reach them; a WhatsApp step for someone with no number goes by email.
    channels: ((f) => (f.length === 0 && c.email && channels.includes("whatsapp") ? (["email"] as Channel[]) : f))(
      channels.filter((ch) => (ch === "email" ? !!c.email : !!c.phone)),
    ),
    reason,
    purpose,
  });

  const decide = (): NextStep | null => {
    // Nothing tried yet: the call goes first, where there is a number to call.
    if (calls.length === 0) {
      if (c.phone) return step(startedAt, ["ai_call"], "The AI call goes first.", "call");
      // No phone: the email stands in for the call — once. After it has gone,
      // what follows is the same as after any message: wait, answer a partial
      // reply, one reminder, then stop (13 September: every visit re-sent it).
      const emailed = messagesOut(log);
      return emailed.length === 0
        ? step(startedAt, ["email"], "No phone number — email instead of the call.", "no_answer")
        : reminderAfter(emailed);
    }

    const since = after(lastCall.at);
    const sentSince = messagesOut(since);
    const heardSince = replies(since);

    switch (lastCall.outcome) {
      case "callback":
        if (lastCall.promisedAt && lastCall.promisedAt > lastCall.at) {
          return step(lastCall.promisedAt, ["ai_call"], "They asked to be called back at this time.", "call");
        }
        // No time given counts as no answer.
        break;

      case "will_send": {
        const by = lastCall.promisedAt ?? lastCall.at + NUDGE_AFTER_HOURS * HOUR;
        if (heardSince.length > 0) {
          // Something came, but not everything.
          const lastHeard = heardSince[heardSince.length - 1].at;
          if (messagesOut(after(lastHeard)).length === 0) {
            return step(lastHeard, ["whatsapp"], `Their reply still left out ${names}.`, "the_rest");
          }
          return reminderAfter(messagesOut(after(lastHeard)));
        }
        if (sentSince.length === 0) {
          return step(by, ["whatsapp"], "They promised to send it by now.", "promised");
        }
        return reminderAfter(sentSince);
      }

      case "answered":
        if (sentSince.length === 0) {
          return step(lastCall.at, ["whatsapp"], `On the call they did not give ${names}.`, "the_rest");
        }
        return reminderAfter(sentSince);
    }

    // no_answer, a callback with no time, or an unrecorded outcome.
    if (sentSince.length === 0) {
      return step(lastCall.at, ["whatsapp", "email"], "No answer on the call.", "no_answer");
    }
    // Messages went out and nothing came back: one more call, then one more
    // reminder, then the day runs out.
    const lastSent = sentSince[sentSince.length - 1].at;
    if (replies(after(lastSent)).length === 0 && calls.length < 2) {
      return step(lastSent + NUDGE_AFTER_HOURS * HOUR, ["ai_call"], "No reply to the messages — one more call.", "call");
    }
    return reminderAfter(sentSince);
  };

  /**
   * After messages have gone: answer a partial reply with the rest, otherwise
   * one reminder — and then nothing more automatic. Messages sent within a few
   * minutes of each other (the WhatsApp and its email) count as one send.
   */
  const reminderAfter = (sent: Contact[]): NextStep | null => {
    const lastSent = sent[sent.length - 1].at;
    const heard = replies(after(lastSent));
    if (heard.length > 0) {
      return step(heard[heard.length - 1].at, ["whatsapp"], `They replied, but ${names} is still missing.`, "the_rest");
    }
    const sends = new Set(sent.map((x) => Math.floor(x.at / (5 * 60_000))));
    if (sends.size >= 2) return null;
    return step(lastSent + NUDGE_AFTER_HOURS * HOUR, ["whatsapp"], "Still nothing back — a reminder.", "reminder");
  };

  const next = decide();

  if (now >= deadline) {
    return {
      ...base,
      state: "overdue",
      next: null,
      handBack: `A day has gone and ${names} ${missing.length === 1 ? "is" : "are"} still missing. Call them yourself.`,
    };
  }
  if (!next || next.at >= deadline) {
    return {
      ...base,
      state: "waiting",
      next: null,
      handBack: `Everything automatic has been tried. If ${names} has not come in by the end of the day you will be alerted.`,
    };
  }
  return { ...base, state: next.at <= now ? "due" : "waiting", next, handBack: null };
}

// ───────────────────────────────────────────────────────────────── the wording ──

export interface Draft {
  channel: "whatsapp" | "email";
  to: string;
  subject: string | null;
  body: string;
}

/**
 * The message itself. Short, because it is read on a phone, and naming only
 * what is still outstanding — asked again for a salary they already gave, a
 * candidate assumes nobody read it.
 */
export function draftsFor(input: {
  candidate: Candidate;
  missing: FollowUpQuestion[];
  roleTitle: string;
  purpose: NextStep["purpose"];
  channels: Channel[];
  taName: string;
}): Draft[] {
  const first = input.candidate.fullName.split(" ")[0];
  const items = input.missing.map((q) => q.ask);
  const list =
    items.length === 1 ? items[0] : `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;

  const body = (() => {
    switch (input.purpose) {
      case "no_answer":
        return `Hi ${first}, this is ${input.taName} from Career141 — I tried calling about the ${input.roleTitle} role. To put you forward I need ${list}. Reply here whenever suits.`;
      case "the_rest":
        return `Hi ${first}, thanks for your time. For the ${input.roleTitle} role I still need ${list} — a one-line reply is enough.`;
      case "promised":
        return `Hi ${first}, just checking in on ${list} for the ${input.roleTitle} role. Whenever you get a moment.`;
      case "reminder":
      case "call":
      default:
        return `Hi ${first}, a quick reminder about the ${input.roleTitle} role — I still need ${list} to put you forward today.`;
    }
  })();

  const out: Draft[] = [];
  if (input.channels.includes("whatsapp") && input.candidate.phone) {
    out.push({ channel: "whatsapp", to: input.candidate.phone, subject: null, body });
  }
  if (input.channels.includes("email") && input.candidate.email) {
    out.push({
      channel: "email",
      to: input.candidate.email,
      subject: `${input.roleTitle} — ${input.missing.length === 1 ? "one thing" : `${input.missing.length} things`} still needed`,
      body: `${body}\n\nThanks,\n${input.taName}\nCareer141`,
    });
  }
  return out;
}

// ──────────────────────────────────────────────────────── reading the reply ──

export interface ReplyReading {
  currentSalary: string | null;
  expectedSalary: string | null;
  noticePeriodDays: number | null;
  /** What in the text produced each value, so a TA can check rather than trust. */
  evidence: { field: string; quote: string }[];
  /** True when nothing at all could be read and a person has to read it. */
  empty: boolean;
}

const MONEY = /(?:lkr|rs\.?|usd|\$)?\s*(\d[\d,.]*)\s*(k|m|lakhs?|million)?/i;

function money(text: string): string | null {
  const m = text.match(MONEY);
  if (!m) return null;
  const n = Number(m[1].replace(/,/g, ""));
  if (!Number.isFinite(n) || n <= 0) return null;
  const unit = (m[2] ?? "").toLowerCase();
  const value = unit.startsWith("k")
    ? n * 1_000
    : unit.startsWith("m")
      ? n * 1_000_000
      : unit.startsWith("lakh")
        ? n * 100_000
        : n;
  // Below a thousand it is not a salary, it is a count of something.
  if (value < 1_000 || value > 100_000_000) return null;
  return value >= 1_000_000
    ? `${(value / 1_000_000).toFixed(value % 1_000_000 ? 1 : 0)}M`
    : `${Math.round(value / 1_000)}K`;
}

/**
 * Read a candidate's reply for the three numbers.
 *
 * Deterministic first, same discipline as the director and client replies: the
 * shapes people actually write — "current 150k, expecting 200k, 1 month
 * notice" — are a closed set, and a regular expression that returns nothing is
 * honest in a way a model that returns something is not. Anything it cannot
 * read is handed to a person with `empty` set, and a model can be asked later
 * without changing this signature.
 */
export function readReply(text: string): ReplyReading {
  const t = text.replace(/\s+/g, " ").trim();
  const evidence: { field: string; quote: string }[] = [];

  const grab = (re: RegExp, field: string): string | null => {
    const m = t.match(re);
    if (!m) return null;
    const v = money(m[1] ?? "");
    if (!v) return null;
    evidence.push({ field, quote: m[0].trim() });
    return v;
  };

  // The number comes before the word as often as after it — "Rs. 1.2M
  // currently" and "currently on 1.2M" are the same sentence to everyone
  // except a pattern that only reads left to right.
  const AMOUNT = String.raw`([\d][\d,.]*\s*(?:k|m|lakhs?|million)?)`;
  const CURRENT = String.raw`currently|current(?:ly)? (?:on|earning|drawing|salary)|present salary|now (?:on|drawing)|at the moment`;
  const EXPECTED = String.raw`expect(?:ing|ed|ation)?|looking for|hoping for|asking`;
  const fwd = (kw: string) => new RegExp(String.raw`\b(?:${kw})\b[^.\n]{0,12}?` + AMOUNT, "i");
  const back = (kw: string) => new RegExp(AMOUNT + String.raw`[^.\n]{0,12}?\b(?:${kw})\b`, "i");
  const plain = (kw: string) => new RegExp(String.raw`\b${kw}\b\s*[:\-]?\s*` + AMOUNT, "i");

  const currentSalary =
    grab(fwd(CURRENT), "currentSalary") ??
    grab(back(CURRENT), "currentSalary") ??
    grab(plain("current"), "currentSalary");

  const expectedSalary =
    grab(fwd(EXPECTED), "expectedSalary") ??
    grab(back(EXPECTED), "expectedSalary") ??
    grab(plain("expected"), "expectedSalary");

  let noticePeriodDays: number | null = null;
  const immediate = t.match(/\b(immediate(?:ly)?|right away|available now|no notice)\b/i);
  if (immediate) {
    noticePeriodDays = 0;
    evidence.push({ field: "noticePeriodDays", quote: immediate[0] });
  } else {
    const n = t.match(/\b(\d{1,3})\s*(day|week|month)s?\b(?:[^.\n]{0,14}notice)?|notice[^.\n]{0,14}?\b(\d{1,3})\s*(day|week|month)s?\b/i);
    if (n) {
      const num = Number(n[1] ?? n[3]);
      const unit = (n[2] ?? n[4] ?? "").toLowerCase();
      const days = unit.startsWith("day") ? num : unit.startsWith("week") ? num * 7 : num * 30;
      if (days >= 0 && days <= 365) {
        noticePeriodDays = days;
        evidence.push({ field: "noticePeriodDays", quote: n[0].trim() });
      }
    }
  }

  return {
    currentSalary,
    expectedSalary,
    noticePeriodDays,
    evidence,
    empty: !currentSalary && !expectedSalary && noticePeriodDays === null,
  };
}
