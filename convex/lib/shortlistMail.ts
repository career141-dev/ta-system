// convex/lib/shortlistMail.ts
//
// Reading the mail that arrives at shortlists@: which opening it is about, and
// whether it is the Director's shortlist or a client's. Pure — no Graph, no
// database — so it is tested on its own (tests/shortlistmail.test.ts).
//
// Two kinds of mail come in, and the subject tells them apart:
//
//   Director   "LANKA HOSPITAL > PA TO CFO > SET 01"   (also the house form
//              "SET 1 - LANKA HOSPITAL - PA TO CFO - 3 CVs", which the app's
//              own send uses, src/lib/eod.ts subjectLine)
//   Client     anything else — clients write their own subject, or none
//
// A Director's subject names the opening outright, so it is matched by client
// and title. A client's does not, so the opening is INFERRED from several weak
// signals added together, and filed only when one opening clearly leads. A
// close call is held for a lead; it is never settled by a guess.

import { norm } from "./postRouting";

export type ShortlistKind = "director" | "client";

export interface HouseSubject {
  client: string;
  position: string;
  setNumber: number | null;
  cvCount: number | null;
}

/**
 * Forwards and replies stack "RE: FW:" in front; the subject proper is what
 * follows. A resent end-of-day email adds "REVISED - " (lib/eod-format
 * revisedSubject), which until 22 Oct was read as the client's name.
 */
export function stripReplyPrefixes(subject: string): string {
  let s = (subject ?? "").trim();
  for (;;) {
    const next = s.replace(/^\s*(?:re|fw|fwd)\s*:\s*/i, "").replace(/^\s*revised\s*[-–—:]\s*/i, "");
    if (next === s) return s;
    s = next;
  }
}

const SET_TOKEN = /^set\s*0*(\d+)$/i;
const CV_TOKEN = /^(\d+)\s*cvs?$/i;

/**
 * "CLIENT > POSITION > SET 01" or "SET 1 - CLIENT - POSITION - 3 CVs" → its parts.
 * Null when there is no SET marker with a client and a position around it —
 * which is how a client's own subject is told from the Director's.
 */
export function parseHouseSubject(subject: string): HouseSubject | null {
  const s = stripReplyPrefixes(subject);
  // ">" is the Director's separator; the app's own subject uses spaced dashes,
  // which are safe to split on because a title's own hyphen has no spaces round it.
  const parts = (/[>›»]/.test(s) ? s.split(/\s*[>›»]\s*/) : s.split(/\s+[-–—]\s+/))
    .map((p) => p.trim())
    .filter(Boolean);
  let setNumber: number | null = null;
  let cvCount: number | null = null;
  const rest: string[] = [];
  for (const p of parts) {
    const set = p.match(SET_TOKEN);
    const cvs = p.match(CV_TOKEN);
    if (set && setNumber === null) setNumber = Number(set[1]);
    else if (cvs && cvCount === null) cvCount = Number(cvs[1]);
    else rest.push(p);
  }
  if (setNumber === null || rest.length < 2) return null;
  return { client: rest[0], position: rest.slice(1).join(" - "), setNumber, cvCount };
}

export interface OpeningLite {
  id: string;
  title: string;
  clientName: string;
  clientContactEmail?: string | null;
}

/** "Lanka Hospitals (Pvt) Ltd" and "LANKA HOSPITAL" are the same client. */
export function normClient(name: string): string {
  return norm(name)
    .replace(/\b(pvt|private|ltd|limited|plc|inc|llc|co|company|group|holdings)\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** 2 = same, 1 = one contains the other (at a word boundary), 0 = unrelated. */
function likeness(a: string, b: string): 0 | 1 | 2 {
  if (!a || !b) return 0;
  if (a === b) return 2;
  // Plural or trailing-s differences: "hospital" / "hospitals".
  const sa = a.replace(/s\b/g, "");
  const sb = b.replace(/s\b/g, "");
  if (sa === sb) return 2;
  if (` ${sa} `.includes(` ${sb} `) || ` ${sb} `.includes(` ${sa} `)) return 1;
  return 0;
}

export interface OpeningMatch {
  opening: OpeningLite | null;
  /** Openings that tie for the lead — what a lead is shown to choose from. */
  near: OpeningLite[];
  note: string;
}

/**
 * The opening a Director's subject names. Client AND position must both agree;
 * a lead on one alone is not enough, which is what stops two clients hiring
 * the same title from crossing over. A tie is returned as `near`, not decided.
 */
export function matchHouseSubject(h: HouseSubject, openings: OpeningLite[]): OpeningMatch {
  const client = normClient(h.client);
  const position = norm(h.position);
  const scored = openings
    .map((o) => {
      const c = likeness(client, normClient(o.clientName));
      const t = likeness(position, norm(o.title));
      return { o, c, t, sum: c && t ? c + t : 0 };
    })
    .filter((x) => x.sum > 0)
    .sort((a, b) => b.sum - a.sum);
  if (scored.length === 0) {
    return { opening: null, near: [], note: `No open opening for "${h.client}" and "${h.position}".` };
  }
  const top = scored[0];
  const tied = scored.filter((x) => x.sum === top.sum);
  // Exact on both, or one exact and one contained; a contained-only pair (2) is too loose.
  if (tied.length === 1 && top.sum >= 3) {
    return { opening: top.o, near: [], note: `Matched ${top.o.clientName} · ${top.o.title} from the subject.` };
  }
  return {
    opening: null,
    near: tied.map((x) => x.o),
    note: tied.length > 1
      ? `"${h.client}" and "${h.position}" fit ${tied.length} openings equally.`
      : `"${h.client}" and "${h.position}" only loosely fit ${top.o.clientName} · ${top.o.title}.`,
  };
}

// ── client mail: inferring the opening ──────────────────────────────────────

/** Stages that mean a candidate has been put forward to the client. */
const SENT_FORWARD = new Set(["director_shortlist", "client_review"]);

export interface CandidateOnOpening {
  candidateId: string;
  openingId: string;
  stage: string;
}

export interface InferInput {
  subject: string;
  body: string;
  fromAddress: string;
  /** Every attached candidate's applications on the openings under consideration. */
  applications: CandidateOnOpening[];
  candidateCount: number;
  openings: OpeningLite[];
}

export interface Inference {
  opening: OpeningLite | null;
  confidence: "high" | "low" | "none";
  near: { opening: OpeningLite; score: number }[];
  reasons: string[];
  note: string;
}

const AUTO_SCORE = 5;
const AUTO_MARGIN = 3;

function mentions(text: string, phrase: string): boolean {
  return phrase.length >= 3 && ` ${text} `.includes(` ${phrase} `);
}

const domainOf = (addr: string) => (addr.split("@")[1] ?? "").toLowerCase();
const FREE_MAIL = /^(gmail|yahoo|hotmail|outlook|live|icloud|msn|proton(mail)?)\./;

/**
 * Which opening a client's shortlist is about, from evidence added up per
 * opening:
 *   +3 per attached candidate already at Director/Client Shortlist on it —
 *      a client's shortlist is a subset of what we sent them, so this is the
 *      strongest signal there is
 *   +1 per attached candidate anywhere else on it
 *   +3 the client's name appears in the subject or body
 *   +2 the position appears in the subject or body
 *   +3 the sender is the opening's client contact, +1 the same company domain
 * Filed only when the leader has at least AUTO_SCORE and leads by AUTO_MARGIN.
 * Otherwise it is "low" and held for a person.
 */
export function inferOpening(input: InferInput): Inference {
  const text = norm(`${stripReplyPrefixes(input.subject)} ${input.body}`);
  const from = input.fromAddress.toLowerCase();
  const scores = new Map<string, { opening: OpeningLite; score: number; reasons: string[] }>();
  for (const o of input.openings) scores.set(o.id, { opening: o, score: 0, reasons: [] });
  const add = (id: string, n: number, why: string) => {
    const s = scores.get(id);
    if (s && n > 0) { s.score += n; s.reasons.push(why); }
  };

  const byOpening = new Map<string, CandidateOnOpening[]>();
  for (const a of input.applications) byOpening.set(a.openingId, [...(byOpening.get(a.openingId) ?? []), a]);
  for (const [id, apps] of byOpening) {
    const forward = apps.filter((a) => SENT_FORWARD.has(a.stage)).length;
    const other = apps.length - forward;
    if (forward) add(id, forward * 3, `${forward} of ${input.candidateCount} candidate${input.candidateCount === 1 ? "" : "s"} already shortlisted on it`);
    if (other) add(id, other, `${other} more already on it`);
  }

  for (const o of input.openings) {
    if (mentions(text, normClient(o.clientName))) add(o.id, 3, `names ${o.clientName}`);
    if (mentions(text, norm(o.title))) add(o.id, 2, `names ${o.title}`);
    const contact = (o.clientContactEmail ?? "").toLowerCase();
    if (contact && contact === from) add(o.id, 3, "sent by the opening's client contact");
    else if (contact && domainOf(contact) === domainOf(from) && !FREE_MAIL.test(domainOf(from))) add(o.id, 1, "sent from the client's domain");
  }

  const ranked = [...scores.values()].filter((s) => s.score > 0).sort((a, b) => b.score - a.score);
  if (ranked.length === 0) {
    return { opening: null, confidence: "none", near: [], reasons: [], note: "Nothing in the mail points to an opening." };
  }
  const [top, next] = ranked;
  const margin = top.score - (next?.score ?? 0);
  const near = ranked.slice(0, 4).map((r) => ({ opening: r.opening, score: r.score }));
  if (top.score >= AUTO_SCORE && margin >= AUTO_MARGIN) {
    return {
      opening: top.opening, confidence: "high", near, reasons: top.reasons,
      note: `${top.opening.clientName} · ${top.opening.title}: ${top.reasons.join("; ")}.`,
    };
  }
  return {
    opening: null, confidence: "low", near, reasons: top.reasons,
    note: `Best guess ${top.opening.clientName} · ${top.opening.title} (${top.reasons.join("; ")}), but not clear enough to file without a lead.`,
  };
}

// ── moving candidates ───────────────────────────────────────────────────────

const ORDER = [
  "new_cvs", "matched_candidates", "ta_shortlist", "follow_up", "second_shortlist",
  "director_shortlist", "client_review", "interview", "offer", "placed",
];

export const TARGET_STAGE: Record<ShortlistKind, "director_shortlist" | "client_review"> = {
  director: "director_shortlist",
  client: "client_review",
};

/**
 * Whether a shortlist mail should move someone to `target`. Forward only: a
 * candidate already at interview or offer is not pulled back because a client
 * mailed the shortlist again, and a rejected or dropped-out candidate is left
 * for a person — someone rejected them for a reason.
 */
export function shouldMove(current: string | null | undefined, target: string): boolean {
  const from = ORDER.indexOf(current ?? "new_cvs");
  const to = ORDER.indexOf(target);
  return from !== -1 && to !== -1 && from < to;
}
