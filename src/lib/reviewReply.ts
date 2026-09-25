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

export interface Candidateish {
  applicationId: string;
  name: string;
}

export type Outcome = "shortlisted" | "rejected" | "hold";

export interface ParsedDecision {
  applicationId: string;
  outcome: Outcome;
  note: string | null;
}

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

/**
 * Strips quoted email reply headers ("On Fri, Sep 25... wrote:", "-----Original Message-----", etc.)
 * so only the actual reviewer's newly typed text is parsed and displayed.
 */
export function extractReplyText(raw: string): string {
  if (!raw) return "";
  let text = raw.replace(/\r\n/g, "\n");

  // If raw contains HTML markup, clean HTML-level quotes and strip tags first
  if (/<[a-z][\s\S]*>/i.test(text)) {
    text = text.replace(/<head[\s\S]*?<\/head>/gi, "");
    text = text.replace(/<style[\s\S]*?<\/style>/gi, "");
    text = text.replace(/<script[\s\S]*?<\/script>/gi, "");

    // Cut HTML quote containers
    const htmlQuotePatterns = [
      /<div[^>]*class=["'][^"']*(?:gmail_quote|gmail_quote_container|x_gmail_quote|gmail_attr|WordSection1|quoted-text)[^"']*["'][\s\S]*/i,
      /<blockquote[^>]*>[\s\S]*/i,
      /<div[^>]*id=["'][^"']*(?:divRplyFwdMsg|orig_message|appendonsend|mail_quote|quote)[^"']*["'][\s\S]*/i,
      /<hr[^>]*id=["'][^"']*(?:stopSpelling|lineBreakAtBeginningOfQuote)[^"']*["'][\s\S]*/i,
    ];
    for (const re of htmlQuotePatterns) {
      const match = re.exec(text);
      if (match && match.index >= 0) {
        text = text.slice(0, match.index);
      }
    }

    text = text.replace(/<br\s*\/?>/gi, "\n");
    text = text.replace(/<\/(?:p|div|tr|h\d|li)>/gi, "\n");
    text = text.replace(/<[^>]+>/g, " ");
    text = text
      .replace(/&nbsp;/gi, " ")
      .replace(/&amp;/gi, "&")
      .replace(/&lt;/gi, "<")
      .replace(/&gt;/gi, ">")
      .replace(/&#39;/g, "'")
      .replace(/&quot;/gi, '"');
  }

  const headerPatterns = [
    // Divider line: "---", "___", "==="
    /(?:^|\n|\s+)[-_=]{3,}[\s\S]*/i,
    // Gmail / Apple Mail / Outlook "On <date> ... wrote:" or "On <date> ... <email>:"
    /(?:^|\n|\s+)(?:On\s+(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun|[A-Z][a-z]{2,8}|\d{1,2})[\s\S]*?(?:wrote\s*:|wrote|>|:\s*\n|<[^>]+>:?))/i,
    // "On [Date/Time] ...:"
    /(?:^|\n|\s+)On\s+[A-Za-z]{3},\s+[A-Za-z]{3}\s+\d{1,2},\s+\d{4}[\s\S]*/i,
    /(?:^|\n|\s+)On\s+\d{1,2}\s+[A-Za-z]{3}\s+\d{4}[\s\S]*/i,
    // Outlook / standard headers
    /(?:^|\n|\s+)-{2,}\s*(?:Original Message|Forwarded message|Reply Message)\s*-{2,}/i,
    /(?:^|\n)\s*(?:From|Sent|To|Subject|Date):\s*.+/i,
    // Quote indicators
    /(?:^|\n)\s*>{1,}\s*.+/i,
    // Mobile signatures
    /(?:^|\n)\s*(?:Get Outlook for (?:iOS|Android)|Sent from my (?:iPhone|iPad|Android|Galaxy|mobile)|Sent with Gmail|Sent from Mail for Windows)[\s\S]*/i,
  ];

  for (const re of headerPatterns) {
    const match = re.exec(text);
    if (match && match.index >= 0) {
      text = text.slice(0, match.index);
    }
  }

  return text.replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n").trim();
}

const YES =
  /\b(shortlist(ed|ing)?|proceed|go ahead|take forward|take|yes|approve[d]?|ok(ay)?|good|fine|strong|keep|include|happy with|like|select(ed|ing|ion)?|pick(ed)?|choose|chosen|prefer(red)?|this one|this candidate|only|just)\b/i;
/** "not sure" is a hold, not a rejection, so it is excluded here and caught by
 *  MAYBE below — which is why MAYBE is tested first. */
const NO =
  /\b(reject(ed|ing)?|drop(ped)?|no\b|pass(ed)?|decline[d]?|not suitable|unsuitable|remove|not|except|apart from|other than|exclude|leave out|weak|poor fit|not a fit|no good|none|discard|skip)\b/i;
const MAYBE = /\b(hold|maybe|not sure|not certain|unsure|reserve|backup|stand ?by)\b/i;

/**
 * "Do not reject 1" is not a rejection, and reading it as one turns a
 * reviewer's rescue of a candidate into the exact opposite instruction. The
 * 13 September audit found this live.
 *
 * The distinction is what the negator is attached to:
 *
 *   not + a YES verb  — "do not shortlist 2", "don't proceed with 4".
 *                       A plain rejection, and safe to act on.
 *   not + a NO verb   — "do not reject 1", "don't drop him".
 *                       They are cancelling a rejection, which is not the same
 *                       as approving. **Nobody is moved.** The clause is
 *                       handed back to the TA to read themselves.
 *   not + a number    — "proceed with 1 and 3, not 2". An exclusion, and the
 *                       ordinary way a reviewer trims a list.
 */
const NEGATOR =
  /\b(?:do(?:es)?\s*n[o']?t|don['’]?t|doesn['’]?t|did\s*n[o']?t|cannot|can['’]?t|won['’]?t|would\s*n[o']?t|wouldn['’]?t|never|no\s+need\s+to|rather\s+not)\b/i;

/** A clause the reader will not act on, and the reason it stopped. */
export interface Unreadable {
  clause: string;
  why: string;
}

/** A line made of nothing but candidate numbers and joining words. */
const ONLY_NUMBERS =
  /^[\s,.;:&#+/()-]*(?:(?:\d{1,2}(?:st|nd|rd|th)?|first|second|third|fourth|fifth|sixth|seventh|eighth|ninth|tenth|and|&|one|ones|no\.?|nos\.?|number|numbers|candidates?)[\s,.;:&#+/()-]*)+$/i;

const WORD_ORDINALS: Record<string, number> = {
  first: 1,
  "1st": 1,
  second: 2,
  "2nd": 2,
  third: 3,
  "3rd": 3,
  fourth: 4,
  "4th": 4,
  fifth: 5,
  "5th": 5,
  sixth: 6,
  "6th": 6,
  seventh: 7,
  "7th": 7,
  eighth: 8,
  "8th": 8,
  ninth: 9,
  "9th": 9,
  tenth: 10,
  "10th": 10,
};

/**
 * Numbers in a reply are not all candidate numbers.
 *
 * "Please proceed with 1. Interview at 2 pm." shortlisted candidate two,
 * because `2` is a number and the sentence inherited "proceed". A time, a
 * date, a salary, a notice period and a percentage are all numbers nobody
 * decided anything about, so they are masked before the numbers are read.
 *
 * Masking rather than deleting keeps the clause's words intact for the note
 * the TA reads afterwards.
 */
const NOT_A_CANDIDATE: RegExp[] = [
  // Times: 2 pm, 2p.m., 10:30, 10.30am
  /\b\d{1,2}\s*[:.]\s*\d{2}\s*(?:[ap]\.?m\.?)?/gi,
  /\b\d{1,2}\s*(?:[ap]\.?\s?m\.?)\b/gi,
  // "at 2", "by 4" where a meeting is being arranged
  /\b(?:at|by|around|from|until|till)\s+\d{1,2}\b(?=\s*(?:[ap]\.?m|o'?clock|hrs|$|[^\d]))/gi,
  // Dates: on the 2nd, 12/3, 12-03-2026, 3 March, March 3
  /\b(?:on\s+(?:the\s+)?|dated?\s+)\d{1,2}(?:st|nd|rd|th)\b/gi,
  /\b\d{1,2}(?:st|nd|rd|th)\s+(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\b/gi,
  /\b(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\s+\d{1,2}(?:st|nd|rd|th)?\b/gi,
  // A slash is always a date; a hyphen is only a date when it has three parts,
  // because "shortlist 2-4" is a range of candidates and must survive.
  /\b\d{1,2}\s*\/\s*\d{1,2}(?:\s*\/\s*\d{2,4})?\b/g,
  /\b\d{1,2}\s*-\s*\d{1,2}\s*-\s*\d{2,4}\b/g,
  /\b\d{1,2}\s+(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\b/gi,
  // Money: Rs 450,000 · LKR 5 lakhs · $2k · 15%
  /(?:rs\.?|lkr|usd|aud|gbp|eur|inr|aed|\$|£|€)\s*[\d,.]+/gi,
  /\b[\d,.]+\s*(?:k\b|m\b|mn\b|lakhs?|crores?|million|bn|billion)/gi,
  /\b\d[\d,.]*\s*%/g,
  // Durations and counts: 3 weeks notice, 4 years experience, 2 rounds
  /\b\d{1,2}\s*\+?\s*(?:years?|yrs?|months?|mos?|weeks?|wks?|days?|hours?|hrs?|minutes?|mins?|rounds?|positions?|vacanc\w*|headcount)\b/gi,
  // Any run of three or more digits is a salary, a phone number or a year.
  /\b\d{3,}\b/g,
];

function maskNonCandidateNumbers(clause: string): string {
  let out = clause;
  for (const re of NOT_A_CANDIDATE) out = out.replace(re, (m) => m.replace(/\d/g, "#"));
  return out;
}

/**
 * Break a reply into sentences, and each sentence into clauses that carry one
 * instruction.
 *
 * The sentence layer is not decoration. A verdict spreads between clauses of
 * one sentence — "1, 3 and 5, take them forward" puts the verb last — and must
 * not spread past a full stop, or "Shortlist 1. 2 and 4 are weak." shortlists
 * everybody. Before 13 September it did exactly that.
 */
function sentencesOf(reply: string): string[][] {
  return reply
    .split(/[\n.;!?]+/)
    .map((sentence) =>
      sentence
        // Split BEFORE the joining word so it stays with the clause it governs.
        // Splitting on it removes it, and "…, except 4" then loses the only
        // word that made it a rejection and inherits the previous "shortlist".
        // "not" starts a new clause when it excludes somebody — "…, not 2" —
        // but not when it is half of a negated verb, because splitting
        // "do not reject 1" into "do" and "not reject 1" hands the second half
        // to the plain rejection branch and rejects the person being rescued.
        .split(
          /(?=\bbut\b|\bhowever\b|\bexcept\b|\bapart from\b|\bother than\b|(?<!\b(?:do|does|did|can|could|will|would|shall|should|must|may|might|is|are|was|were|has|have|had|need)\s{1,3})\bnot\b)|,/i,
        )
        .map((c) => c.trim())
        .filter(Boolean),
    )
    .filter((cs) => cs.length > 0);
}

/** Kept for callers that only want a flat list of clauses. */
function clauses(reply: string): string[] {
  return sentencesOf(reply).flat();
}

/**
 * What one clause decides, or why it cannot be acted on.
 *
 * `null` means the clause names no verdict — it may still inherit one from its
 * sentence. `Unreadable` means it names something this reader will not guess
 * at, and inheriting is then also refused.
 */
function outcomeOf(clause: string): Outcome | Unreadable | null {
  const neg = NEGATOR.exec(clause);
  if (neg) {
    const after = clause.slice(neg.index + neg[0].length);
    // Which verb is being negated decides everything. Test NO first: "do not
    // reject" must not be read by the YES branch on a stray "ok" elsewhere.
    if (MAYBE.test(after)) return "hold";
    if (NO.test(after)) {
      return {
        clause,
        why: "Cancels a rejection without saying what to do instead, so nobody was moved.",
      };
    }
    if (YES.test(after)) return "rejected";
  }

  // MAYBE first: "not sure" contains "not", and a hold is not a rejection.
  if (MAYBE.test(clause)) return "hold";
  if (NO.test(clause)) return "rejected";
  if (YES.test(clause)) return "shortlisted";
  return null;
}

const isUnreadable = (x: Outcome | Unreadable | null): x is Unreadable =>
  typeof x === "object" && x !== null;

/**
 * Resolve every clause of one sentence to a verdict.
 *
 * A clause with no verb of its own inherits from the nearest clause that has
 * one — looking backwards first ("shortlist 1, 3 and 5"), then forwards
 * ("1 and 3 are fine, take them"). It never looks past the sentence.
 */
function verdictsForSentence(cs: string[]): (Outcome | null)[] {
  const own = cs.map(outcomeOf);
  const out: (Outcome | null)[] = [];

  for (let i = 0; i < cs.length; i++) {
    const mine = own[i];
    if (isUnreadable(mine)) {
      out.push(null); // refused, and refusal does not inherit either
      continue;
    }
    if (mine) {
      out.push(mine);
      continue;
    }

    let found: Outcome | null = null;
    for (let j = i - 1; j >= 0 && !found; j--) {
      const v = own[j];
      if (isUnreadable(v)) break;
      if (v) found = v;
    }
    for (let j = i + 1; j < cs.length && !found; j++) {
      const v = own[j];
      if (isUnreadable(v)) break;
      if (v) found = v;
    }
    out.push(found);
  }
  return out;
}

/** Clauses the reader refused, so the TA can read them and act themselves. */
export function unreadableClauses(reply: string): Unreadable[] {
  const out: Unreadable[] = [];
  for (const sentence of sentencesOf(reply)) {
    for (const clause of sentence) {
      const v = outcomeOf(clause);
      if (isUnreadable(v)) out.push(v);
    }
  }
  return out;
}

/**
 * The common case, read without a model: clauses that name an intent and list
 * numbers. "Shortlist 1, 3 and 5. Reject 2." is two instructions, and so is
 * "1 and 3, not 2".
 */
export function readNumbers(reply: string, list: Candidateish[]): ParsedDecision[] {
  const out = new Map<string, ParsedDecision>();

  for (const sentence of sentencesOf(reply)) {
    const verdicts = verdictsForSentence(sentence);

    for (let i = 0; i < sentence.length; i++) {
      let outcome = verdicts[i];
      const line = sentence[i];
      // Times, dates, salaries and notice periods are masked before any number
      // is read, so "Interview at 2 pm" decides nothing about candidate two.
      const readable = maskNonCandidateNumbers(line);

      const nums = new Set<number>();
      for (const m of readable.matchAll(/\b(\d{1,2})\s*(?:-|–|to)\s*(\d{1,2})\b/g)) {
        const a = Number(m[1]);
        const b = Number(m[2]);
        for (let n = Math.min(a, b); n <= Math.max(a, b); n++) nums.add(n);
      }
      for (const m of readable.matchAll(/(?<![\d.\-–#])(\d{1,2})(?![\d\-–#])/g)) nums.add(Number(m[1]));

      // Ordinals: "1st", "2nd", "3rd", "first", "second", "third", etc.
      for (const m of readable.matchAll(/\b(1st|2nd|3rd|4th|5th|6th|7th|8th|9th|10th|first|second|third|fourth|fifth|sixth|seventh|eighth|ninth|tenth)\b/gi)) {
        const val = WORD_ORDINALS[m[1].toLowerCase()];
        if (val) nums.add(val);
      }
      if (/\b(?:last|final)\s*(?:one|candidate|cv)?\b/i.test(readable)) {
        if (list.length > 0) nums.add(list.length);
      }

      // "all", "both", "everyone", "all of them"
      if (/\b(all|both|everyone|everybody|all of them)\b/i.test(readable)) {
        for (let idx = 1; idx <= list.length; idx++) nums.add(idx);
      }

      // "none", "neither", "nobody", "none of them"
      if (/\b(none|neither|nobody|none of them)\b/i.test(readable)) {
        if (!outcome) outcome = "rejected";
        for (let idx = 1; idx <= list.length; idx++) nums.add(idx);
      }

      // When there is only 1 candidate in the set, any explicit approval/rejection applies to candidate #1
      if (nums.size === 0 && list.length === 1 && outcome) {
        nums.add(1);
      }

      // A line that is ONLY numbers ("1, 3, 5", "1st and 3rd", "#2") picks
      // those people. A number inside other words is not a pick: "busy with 2
      // interviews" must not shortlist candidate 2 (review of PR #56, 25 Sep).
      if (!outcome && nums.size > 0 && ONLY_NUMBERS.test(line) && !isUnreadable(outcomeOf(line))) {
        outcome = "shortlisted";
      }

      if (!outcome || nums.size === 0) continue;

      for (const n of nums) {
        const c = list[n - 1];
        if (!c) continue;
        out.set(c.applicationId, { applicationId: c.applicationId, outcome, note: line.slice(0, 160) });
      }
    }
  }

  return [...out.values()];
}

/** Names, where somebody wrote them instead of numbers. Surname or first name,
 *  matched only when exactly one candidate in the set matches. */
export function readNames(reply: string, list: Candidateish[]): ParsedDecision[] {
  const out = new Map<string, ParsedDecision>();

  // Sentence by sentence, exactly as the numbers are read — otherwise "proceed
  // with Nimal, not Kasun" gives every name the same verdict.
  for (const sentence of sentencesOf(reply)) {
    const verdicts = verdictsForSentence(sentence);

    for (let i = 0; i < sentence.length; i++) {
      const outcome = verdicts[i];
      if (!outcome) continue;
      const clause = sentence[i];
      const text = clause.toLowerCase();

      for (const c of list) {
        const parts = c.name.toLowerCase().split(/\s+/).filter((p) => p.length > 2);
        const hit = parts.find((p) => {
          if (!text.includes(p)) return false;
          // Ambiguous where two people in the set share it.
          return list.filter((o) => o.name.toLowerCase().includes(p)).length === 1;
        });
        if (!hit) continue;
        out.set(c.applicationId, {
          applicationId: c.applicationId,
          outcome,
          note: clause.slice(0, 160),
        });
      }
    }
  }

  return [...out.values()];
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
  const numbered = readNumbers(reply, list);
  const named = readNames(reply, list);
  // Clauses the reader refused to guess at. They are never acted on, and they
  // are never dropped either — the TA sees them and decides.
  const refused = unreadableClauses(reply).map((u) => `${u.clause.trim()} — ${u.why}`);

  // Merge, with an explicit number beating a name mentioned in passing.
  const merged = new Map<string, ParsedDecision>();
  for (const d of named) merged.set(d.applicationId, d);
  for (const d of numbered) merged.set(d.applicationId, d);

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

/**
 * The whole set's decisions: what the reply picked, and everyone else in that
 * email marked not selected — the owner's rule (25 Sep, PR #56), so a set is
 * closed by its reply rather than left hanging.
 *
 * Only when the whole reply was read. If any clause could not be read, nobody
 * is marked not selected on a guess: the reply may have been about them.
 */
export function withUnpickedRejected(parsed: ParseResult, applicationIds: string[]): ParsedDecision[] {
  if (parsed.unmatched.length > 0) return parsed.decisions;
  const decided = new Set(parsed.decisions.map((d) => d.applicationId));
  return [
    ...parsed.decisions,
    ...applicationIds
      .filter((id) => !decided.has(id))
      .map((applicationId) => ({ applicationId, outcome: "rejected" as const, note: "Not selected from this set" })),
  ];
}
