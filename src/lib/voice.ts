/**
 * Screening calls — the script, the consent gate, and who is allowed to write.
 *
 * Ported from the live system's voice layer, which is the best-engineered part
 * of it: three session modes with only a production one permitted to write,
 * optimistic concurrency on every event, idempotency keys, exact-key request
 * validation and an HMAC-signed webhook. All of that comes across as it stands.
 *
 * Four things change:
 *
 *  1. **Consent is a precondition, not an event.** In the original, `consent`
 *     is one of three webhook event types and nothing structurally stops a
 *     `confirmed_answer` arriving before it — the ordering is a convention of
 *     the agent, not a rule of the system. Here an answer submitted before
 *     consent is granted is refused by the state machine.
 *
 *  2. **A declined call keeps nothing.** Saying "no, please don't record this"
 *     and having the partial transcript sit in the database anyway is the
 *     failure the question exists to prevent.
 *
 *  3. **Answers fill blanks; they do not overwrite.** The original's write
 *     policy decides WHETHER to write candidate fields and then writes them
 *     wholesale. A figure a TA checked last week should not be replaced by a
 *     number a model heard over a phone line — it is raised as a conflict, the
 *     same way an intake merge does it.
 *
 *  4. **The useful mode works today.** Their middle mode is a technical test.
 *     Here it is a TA on the phone themselves, working the same script and
 *     typing what they hear — which is worth having whether or not the voice
 *     agent is ever switched on, and which produces a record identical in shape
 *     to one the agent would write.
 *
 * Pure module: no store, no I/O, no model, and nothing dials anything.
 */

import crypto from "node:crypto";
import type { AiCall, CallField, CallMode, Candidate } from "@/data/types";
import { readReply } from "./followup";

// ─────────────────────────────────────────────────────────── modes & policy ──

export interface ModeState {
  mode: CallMode;
  label: string;
  detail: string;
  /** Whether this mode may write anything to the candidate. */
  writes: boolean;
  /** Whether it can be started in this build. */
  available: boolean;
  why: string;
}

/** The live agent dials real people. Same switch as the rest of intake: an
 *  environment variable and a deploy, never a button on a page. */
export function liveCallsEnabled(): boolean {
  return (process.env.C141_VOICE_LIVE ?? "").trim().toLowerCase() === "on";
}

export function modeState(mode: CallMode): ModeState {
  if (mode === "simulation") {
    return {
      mode,
      label: "Dry run",
      detail: "Walks the script so you can see what would be asked. Records nothing.",
      writes: false,
      available: true,
      why: "Nothing leaves this screen.",
    };
  }
  if (mode === "assisted") {
    return {
      mode,
      label: "You call, we record",
      detail: "You make the call and type what you hear. The record is the same shape the agent would write.",
      writes: true,
      available: true,
      why: "A person is on the call.",
    };
  }
  return {
    mode,
    label: "Voice agent",
    detail: "The agent calls the candidate and works the script on its own.",
    writes: true,
    available: liveCallsEnabled(),
    why: liveCallsEnabled()
      ? "Live."
      : "Built, not switched on. The number is not registered for automated outbound calling, and the two systems are not merged.",
  };
}

export const MODES: CallMode[] = ["simulation", "assisted", "live"];

/** Exactly the live system's `productionWritePolicy`, widened by one mode. */
export function writePolicy(mode: CallMode) {
  const allowed = modeState(mode).writes;
  return {
    candidateFields: allowed,
    applicationFields: allowed,
    pipelineEvents: allowed,
    outcome: allowed,
  } as const;
}

// ───────────────────────────────────────────────────────────────── the script ──

export interface Question {
  field: CallField;
  /** What is asked, as it is said. */
  ask: string;
  /** Read back before it is written down. */
  confirm: (value: string) => string;
  /** Skipped when the record already holds it — nobody wants to be asked twice. */
  neededFor: (c: Candidate) => boolean;
}

export const SCRIPT: Question[] = [
  {
    field: "currentSalary",
    ask: "Can I ask what you are on at the moment, all in?",
    confirm: (v) => `So that is ${v} a month currently — have I got that right?`,
    neededFor: (c) => !c.currentSalary,
  },
  {
    field: "expectedSalary",
    ask: "And what would you be looking for to make a move?",
    confirm: (v) => `${v} a month is what you are looking for.`,
    neededFor: (c) => !c.expectedSalary,
  },
  {
    field: "noticePeriodDays",
    ask: "How much notice would you have to give?",
    confirm: (v) => `${v} notice — noted.`,
    neededFor: (c) => c.noticePeriodDays === null || c.noticePeriodDays === undefined,
  },
  {
    field: "availability",
    ask: "If the client wants to meet, what days and times suit you?",
    confirm: (v) => `I will put you down as free ${v}.`,
    neededFor: () => true,
  },
];

export function questionsFor(c: Candidate): Question[] {
  return SCRIPT.filter((q) => q.neededFor(c));
}

/**
 * The consent wording, stored verbatim with every call — spec §5.3.
 *
 * Not the same sentence as the brief-recording consent: this one is read to a
 * candidate at the start of a call they did not ask for, so it says who is
 * calling, why, that they can say no, and that saying no costs them nothing.
 */
export const CALL_CONSENT_TEXT =
  "This is a call from Career141 about a role you may be a fit for. Before we go on — we record these calls and keep a written note of what you tell us, so the recruitment team has it accurately. That is only used to put you forward for roles. You can say no and we will carry on without recording, and it makes no difference to your application. Is that all right?";

/** The opening line, so a TA making the call by hand says the same thing. */
export function openingLine(candidateName: string, roleTitle: string, taName: string): string {
  const first = candidateName.split(" ")[0];
  return `Good morning, is that ${first}? This is ${taName} calling from Career141 — we are working on a ${roleTitle} role and your CV came through to us. Is now a reasonable time for five minutes?`;
}

// ────────────────────────────────────────────────────────── the state machine ──

export type Step =
  | { do: "ask_consent"; text: string }
  | { do: "ask"; question: Question; index: number; total: number }
  | { do: "finish"; summary: string }
  | { do: "stop"; because: string };

/**
 * What happens next on a call.
 *
 * The order is the guarantee: nothing can be asked, and nothing can be written,
 * until consent has been given. A caller that tries anyway is refused by
 * `acceptAnswer` below rather than by the agent remembering to behave.
 */
export function nextStep(call: AiCall, candidate: Candidate): Step {
  if (call.status === "declined")
    return { do: "stop", because: "They asked not to be recorded. Nothing was kept." };
  if (call.status === "cancelled") return { do: "stop", because: "The call was cut short." };
  if (call.status === "failed")
    return { do: "stop", because: call.failureReason ?? "The call did not connect." };
  if (call.status === "completed") return { do: "stop", because: "Finished." };

  if (call.consent !== "granted") return { do: "ask_consent", text: CALL_CONSENT_TEXT };

  const needed = questionsFor(candidate);
  const answered = new Set(call.answers.map((a) => a.field));
  const idx = needed.findIndex((q) => !answered.has(q.field));
  if (idx >= 0) {
    return { do: "ask", question: needed[idx], index: idx + 1, total: needed.length };
  }
  return {
    do: "finish",
    summary: `That is everything — thank you. I will come back to you either way.`,
  };
}

/**
 * Every distinct figure in a short answer, normalised.
 *
 * Only used once the keyword reader has failed, and only on an answer to a
 * question that already said what the number is for.
 */
export function readFigures(text: string, asNotice: boolean): (string | number)[] {
  const out: (string | number)[] = [];
  const seen = new Set<string>();
  const re = asNotice
    ? /(\d{1,3})\s*(day|week|month)s?\b|\b(immediate(?:ly)?|right away|no notice)\b/gi
    : /(?:lkr|rs\.?|usd|\$)?\s*(\d[\d,]*(?:\.\d+)?)\s*(k|m|lakhs?|million)?/gi;

  for (const m of text.matchAll(re)) {
    if (asNotice) {
      if (m[3]) {
        if (!seen.has("0")) { seen.add("0"); out.push(0); }
        continue;
      }
      const n = Number(m[1]);
      const unit = (m[2] ?? "").toLowerCase();
      const days = unit.startsWith("day") ? n : unit.startsWith("week") ? n * 7 : n * 30;
      if (days < 0 || days > 365) continue;
      if (!seen.has(String(days))) { seen.add(String(days)); out.push(days); }
      continue;
    }
    const raw = Number((m[1] ?? "").replace(/,/g, ""));
    if (!Number.isFinite(raw) || raw <= 0) continue;
    const unit = (m[2] ?? "").toLowerCase();
    const value = unit.startsWith("k")
      ? raw * 1_000
      : unit.startsWith("m")
        ? raw * 1_000_000
        : unit.startsWith("lakh")
          ? raw * 100_000
          : raw;
    if (value < 1_000 || value > 100_000_000) continue;
    const label =
      value >= 1_000_000
        ? `${(value / 1_000_000).toFixed(value % 1_000_000 ? 1 : 0)}M`
        : `${Math.round(value / 1_000)}K`;
    if (!seen.has(label)) { seen.add(label); out.push(label); }
  }
  return out;
}

/** A bare number with no unit, answering "how much notice", is days. */
export function bareNoticeDays(text: string): number | null {
  const m = text.trim().match(/^[^\d]{0,12}(\d{1,3})[^\d]{0,12}$/);
  if (!m) return null;
  const n = Number(m[1]);
  return n >= 0 && n <= 365 ? n : null;
}

export type Refusal = { ok: false; message: string };
export type Accepted = { ok: true; value: string | number | null };

/**
 * Whether an answer may be recorded, and what it comes to.
 *
 * `expectedVersion` is the live system's optimistic-concurrency check, kept
 * because it is the thing that makes a webhook safe to deliver twice.
 */
export function acceptAnswer(input: {
  call: AiCall;
  field: CallField;
  heard: string;
  expectedVersion?: number;
}): Accepted | Refusal {
  const { call } = input;
  if (call.status === "completed" || call.status === "declined" || call.status === "cancelled")
    return { ok: false, message: "That call is closed." };
  if (call.consent !== "granted")
    return { ok: false, message: "Nothing is recorded until consent has been given." };
  if (input.expectedVersion !== undefined && input.expectedVersion !== call.stateVersion)
    return {
      ok: false,
      message: `Out of date — this call has moved on (expected version ${input.expectedVersion}, it is at ${call.stateVersion}).`,
    };

  const heard = input.heard.trim();
  if (!heard) return { ok: false, message: "Nothing was said." };

  // Availability is words, not a number, and is kept as it was said.
  if (input.field === "availability") return { ok: true, value: heard };

  // The rest go through the same reader the follow-up replies use, so a figure
  // written down off a phone call and one typed into a WhatsApp reply are
  // normalised the same way.
  const r = readReply(heard);
  const value =
    input.field === "currentSalary"
      ? r.currentSalary
      : input.field === "expectedSalary"
        ? r.expectedSalary
        : r.noticePeriodDays;

  if (value !== null && value !== undefined) return { ok: true, value };

  // The keyword reader found nothing, which is the NORMAL case here: it wants
  // a word like "expecting" that the question has already supplied. Asked what
  // they are looking for, people answer "around 950k" — the figure is the whole
  // answer and the hedge in front of it is just how people talk.
  //
  // So: one figure in the text means that figure. Two or more with nothing to
  // tell them apart is genuinely ambiguous and is handed back rather than
  // guessed at — the reader has already had its chance at the sentences where
  // the words do separate them.
  const found = readFigures(heard, input.field === "noticePeriodDays");
  if (found.length === 1) return { ok: true, value: found[0] };
  if (found.length === 0 && input.field === "noticePeriodDays") {
    const days = bareNoticeDays(heard);
    if (days !== null) return { ok: true, value: days };
  }
  if (found.length > 1)
    return {
      ok: false,
      message: `More than one figure in that — ${found.join(", ")}. Write just the one they meant.`,
    };
  return {
    ok: false,
    message: "That could not be read as a figure. Write it as they said it — 150k, or 2 months.",
  };
}

/**
 * What a finished call would write to the candidate.
 *
 * Blanks only. A figure already on the record was put there by somebody who
 * checked it; a number heard down a phone line does not get to replace it, it
 * gets raised.
 */
export function applyPlan(call: AiCall, c: Candidate) {
  const fill: Partial<Pick<Candidate, "currentSalary" | "expectedSalary" | "noticePeriodDays">> = {};
  const conflicts: { field: string; existing: string; heard: string }[] = [];
  if (!writePolicy(call.mode).candidateFields) return { fill, conflicts, wrote: false as const };

  for (const a of call.answers) {
    if (a.value === null) continue;
    if (a.field === "currentSalary") {
      if (!c.currentSalary) fill.currentSalary = String(a.value);
      else if (c.currentSalary !== String(a.value))
        conflicts.push({ field: "current salary", existing: c.currentSalary, heard: String(a.value) });
    }
    if (a.field === "expectedSalary") {
      if (!c.expectedSalary) fill.expectedSalary = String(a.value);
      else if (c.expectedSalary !== String(a.value))
        conflicts.push({ field: "expected salary", existing: c.expectedSalary, heard: String(a.value) });
    }
    if (a.field === "noticePeriodDays") {
      const n = Number(a.value);
      if (c.noticePeriodDays === null || c.noticePeriodDays === undefined) fill.noticePeriodDays = n;
      else if (c.noticePeriodDays !== n)
        conflicts.push({
          field: "notice period",
          existing: `${c.noticePeriodDays} days`,
          heard: `${n} days`,
        });
    }
  }
  return { fill, conflicts, wrote: true as const };
}

// ──────────────────────────────────────────────────── the webhook, for later ──

const MAX_SKEW_MS = 5 * 60 * 1000;
const MAX_TRANSCRIPT = 100_000;

export type AgentEvent =
  | { type: "consent"; callId: string; decision: "granted" | "declined"; expectedVersion: number }
  | { type: "answer"; callId: string; field: CallField; heard: string; expectedVersion: number }
  | {
      type: "finalize";
      callId: string;
      expectedVersion: number;
      status: "completed" | "failed" | "cancelled";
      durationSeconds: number;
      transcript: string;
    };

const FIELDS: CallField[] = ["currentSalary", "expectedSalary", "noticePeriodDays", "availability"];

function obj(v: unknown): Record<string, unknown> {
  if (!v || typeof v !== "object" || Array.isArray(v)) throw new Error("Body must be a JSON object");
  return v as Record<string, unknown>;
}

/** Exact keys, not "at least these". An unexpected field is a different version
 *  of the agent talking to us, and guessing what it meant is how a payload gets
 *  half-applied. */
function keys(v: Record<string, unknown>, required: string[], optional: string[] = []) {
  const allowed = new Set([...required, ...optional]);
  if (Object.keys(v).some((k) => !allowed.has(k))) throw new Error("Body has unsupported fields");
  if (required.some((k) => !(k in v))) throw new Error("Body is missing required fields");
}

function str(v: unknown, name: string, max: number): string {
  if (typeof v !== "string" || v.trim().length === 0 || v.length > max)
    throw new Error(`${name} must be 1-${max} characters`);
  return v;
}

function nat(v: unknown, name: string): number {
  if (typeof v !== "number" || !Number.isInteger(v) || v < 0)
    throw new Error(`${name} must be a non-negative whole number`);
  return v;
}

export function readEvent(value: unknown): AgentEvent {
  const b = obj(value);
  if (b.type === "consent") {
    keys(b, ["type", "callId", "decision", "expectedVersion"]);
    if (b.decision !== "granted" && b.decision !== "declined")
      throw new Error("Invalid consent decision");
    return {
      type: "consent",
      callId: str(b.callId, "callId", 200),
      decision: b.decision,
      expectedVersion: nat(b.expectedVersion, "expectedVersion"),
    };
  }
  if (b.type === "answer") {
    keys(b, ["type", "callId", "field", "heard", "expectedVersion"]);
    if (typeof b.field !== "string" || !FIELDS.includes(b.field as CallField))
      throw new Error("Unknown field");
    return {
      type: "answer",
      callId: str(b.callId, "callId", 200),
      field: b.field as CallField,
      heard: str(b.heard, "heard", 2000),
      expectedVersion: nat(b.expectedVersion, "expectedVersion"),
    };
  }
  if (b.type === "finalize") {
    keys(b, ["type", "callId", "expectedVersion", "status", "durationSeconds", "transcript"]);
    if (b.status !== "completed" && b.status !== "failed" && b.status !== "cancelled")
      throw new Error("Invalid final status");
    if (typeof b.transcript !== "string" || b.transcript.length > MAX_TRANSCRIPT)
      throw new Error("Invalid transcript");
    return {
      type: "finalize",
      callId: str(b.callId, "callId", 200),
      expectedVersion: nat(b.expectedVersion, "expectedVersion"),
      status: b.status,
      durationSeconds: nat(b.durationSeconds, "durationSeconds"),
      transcript: b.transcript,
    };
  }
  throw new Error("Unsupported event type");
}

export function freshTimestamp(ts: string | null, now = Date.now()): boolean {
  if (!ts || !/^\d{10,13}$/.test(ts)) return false;
  const n = Number(ts);
  if (!Number.isSafeInteger(n)) return false;
  return Math.abs(now - (ts.length <= 10 ? n * 1000 : n)) <= MAX_SKEW_MS;
}

/** HMAC over timestamp.nonce.body, compared in constant time. The nonce and the
 *  timestamp are in the signed material so a captured call cannot be replayed. */
export function verifySignature(input: {
  rawBody: string;
  timestamp: string;
  nonce: string;
  signature: string | null;
  secret: string;
}): boolean {
  if (!input.signature || !/^[a-f0-9]{64}$/i.test(input.signature)) return false;
  const expected = crypto
    .createHmac("sha256", input.secret)
    .update(`${input.timestamp}.${input.nonce}.${input.rawBody}`)
    .digest();
  const given = Buffer.from(input.signature, "hex");
  return expected.length === given.length && crypto.timingSafeEqual(expected, given);
}
