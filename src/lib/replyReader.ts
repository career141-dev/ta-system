/**
 * Reading a reviewer's reply without a model — the deterministic half of
 * reviewReply.ts, moved here on 22 Oct so the backend's shortlists@ reader
 * (convex/lib/shortlistReply.ts) can use the same rules.
 *
 * Until then the backend had its own regex reader (19 Oct). It had none of the
 * 13 September fixes below, and read "2 not selected", "Do not proceed with 2"
 * and the greeting "Hi all" as selections — marked safe to apply on their own.
 * Pure: no model, no database, no imports, so both sides can load it.
 */
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
  /\b(shortlist(ed|ing)?|proceed|go ahead|take forward|take|yes|interview|approve[d]?|ok(ay)?|good|fine|strong|keep|include|happy with|like|select(ed|ing|ion)?|pick(ed)?|choose|chosen|prefer(red)?|this one|this candidate|only|just)\b/i;
/** "not sure" is a hold, not a rejection, so it is excluded here and caught by
 *  MAYBE below — which is why MAYBE is tested first. */
const NO =
  /\b(reject(ed|ing)?|drop(ped)?|no\b|pass(ed)?|decline[d]?|not suitable|unsuitable|remove|not|except|apart from|other than|exclude|leave out|weak|poor fit|not a fit|no good|none|discard|skip)\b/i;
// "Optional" and "conditional" are not a yes (22 Oct, the backend reader's rule).
const MAYBE = /\b(hold|maybe|not sure|not certain|unsure|reserve|backup|stand ?by|optional(?:ly)?|conditional(?:ly)?)\b/i;

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
  // The set's own number: "Set 2: proceed with Nimal" shortlisted candidate
  // two as well (22 Oct). The subject line and the reply both name the set.
  /\b(?:set|batch|round)\s*(?:no\.?|#|-)?\s*\d{1,2}\b/gi,
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
/**
 * Greetings and sign-offs decide nothing. "Hi all, please proceed with 1 and 3"
 * shortlisted all three on the backend reader (22 Oct): "all" is the word for
 * the whole set, and the greeting supplied it. "Dear All / Kasun not selected"
 * did the same to everybody, Kasun included.
 *
 * Only a greeting word directly followed by all/everyone goes with it — "Hi,
 * all shortlisted" keeps its "all", because there the comma makes it the answer.
 */
const COURTESY: RegExp[] = [
  /\b(?:hi|hello|hey|dear|morning|good\s+(?:morning|afternoon|evening|day)|thanks|thank\s+you|many\s+thanks|cheers)(?:[ \t]+(?:to[ \t]+)?(?:all|everyone|everybody|team|both|you\s+all|you\s+both))?\b/gi,
  /\b(?:all\s+the\s+best|that'?s\s+all|that\s+is\s+all|hope\s+(?:you\s+are|you're|all\s+is)\s+(?:doing\s+)?(?:well|fine|good))\b/gi,
  /\b(?:(?:best|kind|warm)\s+)?regards\b/gi,
];

function withoutCourtesy(reply: string): string {
  let out = reply;
  for (const re of COURTESY) out = out.replace(re, " ");
  return out;
}

function sentencesOf(reply: string): string[][] {
  return withoutCourtesy(reply)
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
 *
 * One exception, forwards first: when the very next clause is a verdict about
 * nobody in particular, it is this clause's verdict. "1 and 3 selected, 2 not
 * suitable" splits into "2" and "not suitable", and until 22 Oct "2" took the
 * "selected" behind it.
 */
function verdictsForSentence(cs: string[], mentions: (clause: string) => boolean): (Outcome | null)[] {
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

    const next = own[i + 1];
    if (next && !isUnreadable(next) && !mentions(cs[i + 1])) {
      out.push(next);
      continue;
    }

    let found: Outcome | null = null;
    for (let j = i - 1; j >= 0 && !found; j--) {
      const v = own[j];
      if (isUnreadable(v)) break;
      if (v) found = v;
    }
    // Never forward from a clause about other people (22 Oct): "1 and 3, not
    // 2" read "not 2" for 1 and 3 and rejected all three, marked safe. Left
    // without a verdict, a bare list reads as a pick and a named person goes
    // to review (readHits).
    const namesOwn = mentions(cs[i]);
    for (let j = i + 1; j < cs.length && !found; j++) {
      const v = own[j];
      if (isUnreadable(v)) break;
      if (namesOwn && mentions(cs[j])) break;
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

/** One reading of one person in one clause. */
interface Hit {
  applicationId: string;
  outcome: Outcome;
  note: string;
  by: "number" | "name";
  /** Reached through all/both/none rather than a number or a name. */
  wholeSet: boolean;
}

const escapeRe = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * The parts of a name that pick out one person in this set: first name or
 * surname, three letters or more, shared with nobody else on the list. Matched
 * as whole words — "Ali" is not in "quality".
 */
function namePartsOf(c: Candidateish, list: Candidateish[]): RegExp[] {
  // Letters of any script, so "Ali" is not in "quality" and a Tamil or
  // Sinhala name still matches; "M.F." loses its dots before it is compared.
  const word = (part: string) => new RegExp(`(?<![\\p{L}\\p{N}])${escapeRe(part)}(?![\\p{L}\\p{N}])`, "iu");
  return c.name.toLowerCase().split(/[^\p{L}\p{N}']+/u).filter((p) => p.length > 2)
    .filter((p) => list.filter((o) => word(p).test(o.name)).length === 1)
    .map(word);
}

/** Numbers that name a person: digits, ordinals, last, and the whole-set words. */
function numbersIn(readable: string, size: number): { nums: Set<number>; wholeSet: boolean } {
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
    if (size > 0) nums.add(size);
  }

  // "all", "both", "everyone", "all of them", "none", "neither", "nobody"
  const wholeSet = /\b(all|both|everyone|everybody|none|neither|nobody)\b/i.test(readable);
  if (wholeSet) for (let idx = 1; idx <= size; idx++) nums.add(idx);
  return { nums, wholeSet };
}

/** Whether a clause names anybody — used to tell "2" + "not suitable" apart. */
function mentionsSomeone(clause: string, list: Candidateish[]): boolean {
  if (numbersIn(maskNonCandidateNumbers(clause), list.length).nums.size > 0) return true;
  return list.some((c) => namePartsOf(c, list).some((re) => re.test(clause)));
}

/** Everything the reader would act on, clause by clause, plus what it could not place. */
function readHits(reply: string, list: Candidateish[]) {
  const hits: Hit[] = [];
  const outOfRange = new Set<number>();
  /** Sentences that gave a verdict about nobody in the set. */
  const unplaced: string[] = [];
  /** Clauses that name someone in the set but say nothing about them, beside a clause that decides. */
  const undecided: string[] = [];
  const mentions = (clause: string) => mentionsSomeone(clause, list);

  for (const sentence of sentencesOf(reply)) {
    const verdicts = verdictsForSentence(sentence, mentions);
    let placed = false;
    let spoke = false;

    for (let i = 0; i < sentence.length; i++) {
      let outcome = verdicts[i];
      const line = sentence[i];
      // Times, dates, salaries and notice periods are masked before any number
      // is read, so "Interview at 2 pm" decides nothing about candidate two.
      const readable = maskNonCandidateNumbers(line);
      const { nums, wholeSet } = numbersIn(readable, list.length);

      // "none", "neither", "nobody" are a verdict as well as a list.
      if (/\b(none|neither|nobody|none of them)\b/i.test(readable) && !outcome) outcome = "rejected";

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

      if (!outcome) {
        if (mentions(line) && verdicts.some(Boolean)) undecided.push(line.slice(0, 160));
        continue;
      }
      spoke = true;

      for (const n of nums) {
        const c = list[n - 1];
        if (!c) {
          outOfRange.add(n);
          continue;
        }
        placed = true;
        hits.push({ applicationId: c.applicationId, outcome, note: line.slice(0, 160), by: "number", wholeSet });
      }

      // Names, where somebody wrote them instead of numbers. Sentence by
      // sentence, exactly as the numbers are read — otherwise "proceed with
      // Nimal, not Kasun" gives every name the same verdict.
      for (const c of list) {
        if (!namePartsOf(c, list).some((re) => re.test(line))) continue;
        placed = true;
        hits.push({ applicationId: c.applicationId, outcome, note: line.slice(0, 160), by: "name", wholeSet: false });
      }
    }
    if (spoke && !placed) unplaced.push(sentence.join(", ").slice(0, 160));
  }
  return { hits, outOfRange: [...outOfRange], unplaced, undecided };
}

/** The last word on each person wins, as it always has for the TA's paste box. */
function lastWord(hits: Hit[]): ParsedDecision[] {
  const out = new Map<string, ParsedDecision>();
  for (const h of hits) out.set(h.applicationId, { applicationId: h.applicationId, outcome: h.outcome, note: h.note });
  return [...out.values()];
}

/**
 * The common case, read without a model: clauses that name an intent and list
 * numbers. "Shortlist 1, 3 and 5. Reject 2." is two instructions, and so is
 * "1 and 3, not 2".
 */
export function readNumbers(reply: string, list: Candidateish[]): ParsedDecision[] {
  return lastWord(readHits(reply, list).hits.filter((h) => h.by === "number"));
}

/** Names, where somebody wrote them instead of numbers. Surname or first name,
 *  matched only when exactly one candidate in the set matches. */
export function readNames(reply: string, list: Candidateish[]): ParsedDecision[] {
  return lastWord(readHits(reply, list).hits.filter((h) => h.by === "name"));
}

/** A whole reply, read for somebody who will act on it without a person checking. */
export interface ReplyReading {
  /** One per person: an explicit number beats a name mentioned in passing. */
  decisions: ParsedDecision[];
  /** People the reply gives two different verdicts. */
  conflicts: string[];
  /** Clauses the reader refused to act on. */
  unreadable: Unreadable[];
  /** Sentences with a verdict that named nobody in the set. */
  unplaced: string[];
  /** Clauses naming someone in the set with no verdict of their own, beside one that decides. */
  undecided: string[];
  /** Candidate numbers beyond the end of the set. */
  outOfRange: number[];
  /** all/both/none were used next to named or numbered people. */
  mixedWholeSet: boolean;
}

export function readReply(reply: string, list: Candidateish[]): ReplyReading {
  const { hits, outOfRange, unplaced, undecided } = readHits(reply, list);
  // Weakest first: all/both/none, then a name, then an explicit number. "Shortlist
  // all except Kasun" must leave Kasun out, not let "all" outvote his name.
  const merged = new Map<string, ParsedDecision>();
  for (const d of lastWord(hits.filter((h) => h.wholeSet))) merged.set(d.applicationId, d);
  for (const d of lastWord(hits.filter((h) => h.by === "name"))) merged.set(d.applicationId, d);
  for (const d of lastWord(hits.filter((h) => h.by === "number" && !h.wholeSet))) merged.set(d.applicationId, d);

  const seen = new Map<string, Set<Outcome>>();
  for (const h of hits) seen.set(h.applicationId, (seen.get(h.applicationId) ?? new Set()).add(h.outcome));
  const conflicts = [...seen].filter(([, outcomes]) => outcomes.size > 1).map(([id]) => id);

  return {
    decisions: [...merged.values()],
    conflicts,
    unreadable: unreadableClauses(reply),
    unplaced,
    undecided,
    outOfRange,
    mixedWholeSet: hits.some((h) => h.wholeSet) && hits.some((h) => !h.wholeSet),
  };
}
