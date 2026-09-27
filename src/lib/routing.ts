/**
 * Getting an incoming application to the right job.
 *
 * The old system pointed every advert at one shared inbox, so a CV arriving
 * told you nothing about which job it was for — every one landed in the
 * candidate pool and somebody attached it by hand. The change here is one
 * mailbox per TA:
 *
 *   the ADDRESS it arrived at  → which TA
 *   the HEADLINE in the subject → which of that TA's jobs
 *
 * Both halves are needed. The address alone cannot separate three jobs one TA
 * is running under one opening; the headline alone is not unique across the
 * desk, because two TAs can both be working a "Brand Manager".
 *
 * Pure module: no store, no I/O, no model.
 */

import type { Client, Id, JobPost, Opening, ReviewRound, User } from "@/data/types";

// ──────────────────────────────────────────────────────────── normalisation ──

/** `"Nuha Jobs" <NUHA.JOBS@Career141.com>` → `nuha.jobs@career141.com`. */
export function addressOf(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const inAngles = raw.match(/<([^>]+)>/);
  const t = (inAngles ? inAngles[1] : raw).trim().toLowerCase();
  return /^[^\s@]+@[^\s@]+\.[a-z]{2,}$/.test(t) ? t : null;
}

/**
 * The wrapping the boards put around a job title.
 *
 * LinkedIn's application notifications are not "Brand Manager" — they are
 * "New application: Brand Manager from Nimal Perera" or "Nimal Perera applied
 * to Brand Manager at Delmo". Stripping the furniture first is what lets an
 * exact title match be trusted; without it everything falls through to fuzzy
 * matching and fuzzy matching on a live inbox puts CVs on the wrong job.
 */
const WRAPPERS: RegExp[] = [
  /^\s*(?:re|fw|fwd)\s*:\s*/i,
  /^\s*new application\s*:?\s*/i,
  /^\s*(?:your )?applicant(?:s)? for\s*:?\s*/i,
  /^\s*application (?:for|to)\s*:?\s*/i,
  /\s*[-–|]\s*linkedin\s*$/i,
  /\s*\|\s*(?:indeed|jobstreet|topjobs|xpress ?jobs|rozee)\s*$/i,
];

/** Everything in the subject that could be the job title. */
export function titleCandidates(subject: string): string[] {
  let s = subject.replace(/\s+/g, " ").trim();
  for (const w of WRAPPERS) s = s.replace(w, "");

  const out = new Set<string>([s]);

  // "Nimal Perera applied to Brand Manager at Delmo"
  const appliedTo = s.match(/\bapplied\s+(?:to|for)\s+(.+?)(?:\s+at\s+.+)?$/i);
  if (appliedTo?.[1]) out.add(appliedTo[1]);

  // "Brand Manager from Nimal Perera" / "Brand Manager - Nimal Perera"
  const before = s.match(/^(.+?)\s+(?:from|by)\s+\S+/i);
  if (before?.[1]) out.add(before[1]);

  // "Brand Manager at Delmo"
  const atClient = s.match(/^(.+?)\s+at\s+\S+/i);
  if (atClient?.[1]) out.add(atClient[1]);

  // Dash-separated: take every segment, since the house subject line is
  // "CLIENT - TITLE - DATE".
  for (const part of s.split(/\s+[-–|]\s+/)) out.add(part);
  // "Country Head / General Manager Sales and Marketing": either side of a
  // spaced slash is a title on its own.
  for (const part of s.split(/\s+\/\s+/)) out.add(part);

  return [...out].map((x) => x.trim()).filter((x) => x.length >= 3);
}

/** The subject's job title as a whole, never a fragment of it (as convex/lib/postRouting.ts). */
function wholeTitles(subject: string): string[] {
  let s = subject.replace(/\s+/g, " ").trim();
  for (const w of WRAPPERS) s = s.replace(w, "");
  const out = new Set<string>([s]);
  const appliedTo = s.match(/\bapplied\s+(?:to|for)\s+(.+?)(?:\s+at\s+.+)?$/i);
  if (appliedTo?.[1]) out.add(appliedTo[1]);
  const before = s.match(/^(.+?)\s+(?:from|by)\s+\S+/i);
  if (before?.[1]) out.add(before[1]);
  return [...out].map((x) => x.trim()).filter((x) => x.length >= 3);
}

/** "Pricing Manager" of "Pricing Manager – Sea & Air Freight". */
function titleHead(title: string): string {
  return title.split(/\s+(?:[-–|]|from)\s+/i)[0].trim();
}

/** Words that make a title a different job when they follow it. */
const CHANGES_ROLE_AFTER = new Set(["assistant", "trainee", "intern", "internship", "apprentice", "support", "coordinator"]);

/** `text` starts with the whole of `title` (both normalised), and what follows does not change the job. */
function leadsWith(text: string, title: string): boolean {
  if (!title || !text.startsWith(`${title} `)) return false;
  return !CHANGES_ROLE_AFTER.has(text.slice(title.length + 1).split(" ")[0]);
}

function norm(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9&\s]/g, " ")
    .replace(/\b(and|the|of|for|a|an)\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function tokens(s: string): string[] {
  return norm(s).split(" ").filter(Boolean);
}

/**
 * The one box every shortlist reply is copied to.
 *
 * One address for the whole desk, not one per recruiter — the reply does not
 * need the address to say which job it is about, because the subject line
 * already does: "DELMO - BRAND MANAGER - 12 SEPTEMBER 2026" names the client,
 * the role and the day. A second address per TA would be eight more mailboxes
 * to create, eight more subscriptions to watch, and nothing gained.
 */
export const DEFAULT_SHORTLIST_INBOX = "shortlists@career141.com";

/**
 * Which of our drop boxes a message landed in, and therefore what it is.
 *
 * This is the whole reason there are two kinds of address rather than one. A
 * candidate's CV and a Director's one-line reply need completely different
 * readers, and a single inbox would have each of them trying to parse the
 * other's post. The address settles it before anything is opened.
 */
export type InboundKind = "application" | "review_reply" | "not_ours";

export interface Inbound {
  kind: InboundKind;
  /** Whose adverts it came from. Only ever set for an application — a reply is
   *  placed by its subject, not by which box it arrived in. */
  taId: Id | null;
}

export function classifyInbound(
  to: string,
  users: User[],
  shortlistInbox = DEFAULT_SHORTLIST_INBOX,
): Inbound {
  const addr = addressOf(to);
  if (!addr) return { kind: "not_ours", taId: null };
  if (addr === addressOf(shortlistInbox)) return { kind: "review_reply", taId: null };

  const byJobs = users.find((u) => addressOf(u.routingEmail) === addr && u.isActive);
  if (byJobs) return { kind: "application", taId: byJobs.id };

  // Deliberately NOT falling back to a TA's own address. Their working mailbox
  // is theirs; nothing here reads it.
  return { kind: "not_ours", taId: null };
}

// ───────────────────────────────────────────────────────────────── the match ──

export type RouteConfidence = "exact" | "keyword" | "partial" | "none";

export interface RouteResult {
  /** Whose mailbox it came to. Null when the address is not one of ours. */
  taId: Id | null;
  postId: Id | null;
  openingId: Id | null;
  confidence: RouteConfidence;
  /** What it matched on, for the intake screen to show. */
  matchedOn: string | null;
  /** More than one of this TA's jobs fits and nothing separates them. Routed
   *  nowhere on purpose — a coin-toss between two live jobs is worse than a
   *  row in the queue. */
  ambiguous: { postId: Id; title: string }[];
  /**
   * The same advert serving more than one opening: one recruiter running the
   * same title for two clients. The CV belongs on every one of them, so it is
   * filed to the primary post above and to each of these as well.
   */
  alsoTo: { postId: Id; openingId: Id }[];
}

const NO_MATCH: Omit<RouteResult, "taId"> = {
  alsoTo: [],
  postId: null,
  openingId: null,
  confidence: "none",
  matchedOn: null,
  ambiguous: [],
};

interface Scored {
  post: JobPost;
  score: number;
  confidence: RouteConfidence;
  matchedOn: string;
}

function scorePost(post: JobPost, cands: string[], whole: string[] = cands): Scored | null {
  const postNorm = norm(post.title);
  const postTokens = tokens(post.title);
  let best: Scored | null = null;

  const take = (score: number, confidence: RouteConfidence, matchedOn: string) => {
    if (!best || score > best.score) best = { post, score, confidence, matchedOn };
  };

  // The subject's whole title is the advert's head.
  const head = norm(titleHead(post.title));
  if (head !== postNorm && head.split(" ").length >= 2 && whole.some((w) => norm(w) === head)) {
    take(75, "exact", post.title);
  }

  for (const c of cands) {
    const cn = norm(c);
    if (!cn) continue;

    // The whole title, exactly. The only thing worth acting on without doubt.
    if (cn === postNorm) take(100, "exact", post.title);
    // The title followed by a place or a client. Not a title found anywhere
    // inside the subject, and never the subject inside a title: "General Sales
    // Manager" is not "Sales Manager", and the fragment "Head" is not every
    // "Head of …" (linkedin@, 16 September).
    else if (leadsWith(cn, postNorm)) take(80, "exact", post.title);

    // A title the advert carried before it was edited (posting type 4).
    for (const old of post.previousTitles ?? []) {
      const on = norm(old);
      if (on && (cn === on || leadsWith(cn, on))) take(90, "exact", old);
    }

    // A keyword the TA put on the post on purpose — the advert may be headed
    // "Marketing Lead" while the opening is "Brand Manager".
    for (const k of post.aliasKeywords) {
      const kn = norm(k);
      if (kn && (cn === kn || ` ${cn} `.includes(` ${kn} `))) take(70, "keyword", k);
    }

    // Every significant word of the title present, in any order.
    const ct = new Set(tokens(c));
    const hit = postTokens.filter((t) => ct.has(t)).length;
    if (postTokens.length > 0 && hit === postTokens.length) take(60, "partial", post.title);
    // One word short, but only on a title long enough for that to mean
    // something. On a two-word title "one short" is one shared word, and job
    // titles here share their second word constantly — Marketing Executive and
    // Operations Executive are not the same advert.
    else if (postTokens.length > 2 && hit >= 2 && hit >= postTokens.length - 1)
      take(40, "partial", post.title);
  }

  return best;
}

/**
 * Route one inbound message.
 *
 * Only LIVE posts belonging to the TA whose mailbox it arrived at are
 * considered — a closed job does not take new applicants, and another TA's job
 * is not this TA's to receive.
 */
export function routeInbound(
  input: { to: string; subject: string; body?: string | null },
  users: User[],
  posts: JobPost[],
): RouteResult {
  const to = addressOf(input.to);
  const ta = to ? users.find((u) => addressOf(u.routingEmail) === to && u.isActive) : undefined;
  if (!ta) return { taId: null, ...NO_MATCH };

  // Only what is CURRENTLY up on LinkedIn. An advert that has been taken down
  // is not collecting applicants, so nothing should be filed against it
  // automatically — which is also what makes the "no CVs for five days" chase
  // mean something, since it can only ever be about a live advert.
  //
  // A CV that arrives after the advert came down is not lost: it has no post to
  // go to, so it sits in that TA's intake queue for them to place by hand.
  const mine = posts.filter((p) => p.assignedTaId === ta.id && p.status === "live");
  if (mine.length === 0) return { taId: ta.id, ...NO_MATCH };

  const cands = titleCandidates(input.subject);
  const whole = wholeTitles(input.subject);
  const scored = mine
    .map((p) => scorePost(p, cands, whole))
    .filter((x): x is Scored => x !== null)
    .sort((a, b) => b.score - a.score);

  if (scored.length === 0) return { taId: ta.id, ...NO_MATCH };

  const top = scored[0];
  let tied = scored.filter((s) => s.score === top.score);

  // The desk posts one job in four patterns (13 September), and three of them
  // put several live posts with the same title into one TA's mailbox:
  //
  //   1. One job, several posts, one recruiter.
  //   2. One job, several recruiters, one region each — separated already,
  //      because each recruiter has their own mailbox.
  //   3. One job, several regions, any recruiter, one nationality.
  //   4. The title edited on a live post — handled by `previousTitles`.
  //
  // A tie is therefore normal, not a reason to give up. The region named in
  // the message picks the post; failing that, posts of the same opening are
  // the same job and the CV is filed to it. Only a tie across two DIFFERENT
  // openings — two clients hiring the same title through one recruiter — is a
  // genuine question, and only that is held for the TA.
  if (tied.length > 1) {
    const text = norm(`${input.subject} ${input.body ?? ""}`);
    const inRegion = tied.filter((t) =>
      [t.post.city, t.post.country].some((place) => place && text.includes(norm(place))),
    );
    if (inRegion.length >= 1) tied = inRegion;
  }

  // The more specific advert wins a tie: "Chief Operating Officer - Gloves"
  // contains "Chief Operating Officer", and a subject naming the first matched
  // both (16 September, 39 of 507 real LinkedIn applications). Identical titles
  // stay tied — one advert serving two clients. Mirrors convex/lib/postRouting.ts.
  if (tied.length > 1) {
    const specific = tied.filter(
      (t) => !tied.some((o) => o !== t && norm(o.post.title).length > norm(t.post.title).length && norm(o.post.title).includes(norm(t.post.title))),
    );
    if (specific.length >= 1) tied = specific;
  }

  if (tied.length > 1) {
    // One post per opening — the newest where an opening has several.
    const byOpening = new Map<Id, Scored>();
    for (const t of [...tied].sort((a, b) => (b.post.postedAt ?? 0) - (a.post.postedAt ?? 0))) {
      if (!byOpening.has(t.post.openingId)) byOpening.set(t.post.openingId, t);
    }
    const picks = [...byOpening.values()];
    const primary = picks[0];
    // Same title, same recruiter, different clients: the advert is shared, so
    // the CV goes to every opening it serves (13 September) rather than
    // waiting for somebody to choose one.
    return {
      taId: ta.id,
      postId: primary.post.id,
      openingId: primary.post.openingId,
      confidence: primary.confidence,
      matchedOn: primary.matchedOn,
      ambiguous: [],
      alsoTo: picks.slice(1).map((t) => ({ postId: t.post.id, openingId: t.post.openingId })),
    };
  }

  const only = tied[0];
  return {
    taId: ta.id,
    postId: only.post.id,
    openingId: only.post.openingId,
    confidence: only.confidence,
    matchedOn: only.matchedOn,
    ambiguous: [],
    alsoTo: [],
  };
}

/**
 * Whether a routed message should be filed without anybody looking at it.
 *
 * An exact or deliberate-keyword match on one live job is acted on. A partial
 * one is filed against the job but flagged, so a TA sees what it guessed and
 * can move it — the alternative, holding every partial match for review, means
 * the queue fills up with things that were obviously right.
 */
export function autoFile(r: RouteResult): boolean {
  return r.postId !== null && (r.confidence === "exact" || r.confidence === "keyword");
}

/** One line for the intake row, so the routing explains itself. */
export function routeNote(r: RouteResult, taName: string | null): string {
  if (!r.taId) return "Came to an address that is not one of ours.";
  if (r.ambiguous.length)
    return `${taName ?? "The TA"} has ${r.ambiguous.length} live jobs this could be — ${r.ambiguous
      .map((a) => a.title)
      .join(", ")}. Pick one.`;
  if (!r.postId) return `${taName ?? "The TA"}'s mailbox, but the subject matches none of their live jobs.`;
  if (r.confidence === "keyword") return `Matched on the keyword “${r.matchedOn}”.`;
  if (r.confidence === "partial") return `Close match on “${r.matchedOn}” — worth a look.`;
  return `Matched “${r.matchedOn}”.`;
}

// ─────────────────────────────────────────────── placing a shortlist reply ──

export interface ReplyTarget {
  round: ReviewRound | null;
  /** Why, in a sentence — shown when it could not be placed. */
  note: string;
  /** Rounds the subject fits but the sender does not, or the other way round. */
  near: ReviewRound[];
}

/**
 * Work out which set a reply is answering.
 *
 * Two independent signals, and it wants both:
 *
 *   the SUBJECT says which opening — "DELMO - BRAND MANAGER - 12 SEPTEMBER
 *   2026" carries the client and the role, and survives a "Re:" and a
 *   forwarded chain;
 *
 *   the SENDER says whether this is the Director or the client — which is what
 *   separates two rounds that are otherwise identical, because the client's
 *   copy of a set has the same subject as the Director's.
 *
 * Without the sender there is no telling a Director's "yes to 1 and 3" from
 * the client's, and they move people to different stages. So a reply that
 * matches a subject but comes from nobody we know is handed back rather than
 * applied to whichever round was most recent.
 */
export function matchReviewReply(
  msg: { from: string; subject: string; inReplyTo?: string | null; receivedAt?: number | string | null },
  ctx: {
    rounds: ReviewRound[];
    openings: Opening[];
    clients: Client[];
    users: User[];
  },
): ReplyTarget {
  const from = addressOf(msg.from);
  if (!from) return { round: null, note: "No readable sender address.", near: [] };

  const openAll = ctx.rounds.filter((r) => r.status !== "returned");
  if (openAll.length === 0)
    return { round: null, note: "Nothing is out waiting on a reply.", near: [] };

  const receivedTs = msg.receivedAt ? new Date(msg.receivedAt).getTime() : null;
  const open = receivedTs
    ? openAll.filter((r) => r.sentAt <= receivedTs + 60_000)
    : openAll;

  if (open.length === 0)
    return { round: null, note: "Nothing is out waiting on a reply.", near: [] };

  // Who is this?
  const director = ctx.users.find((u) => u.role === "director" && addressOf(u.email) === from);
  const clientContact = ctx.clients.find((c) =>
    c.contacts.some((x) => addressOf(x.email) === from),
  );
  const kind: ReviewRound["kind"] | null = director
    ? "director"
    : clientContact
      ? "client"
      : null;

  // The provider's own thread beats everything else: it survives a rewritten
  // subject, a forward, and a reply typed from a phone with no subject at all.
  // It is checked before the subject so those replies are not thrown away.
  if (msg.inReplyTo) {
    const id = bareMessageId(msg.inReplyTo);
    const threaded = open.find((r) => r.messageId && bareMessageId(r.messageId) === id);
    if (threaded) {
      return {
        round: threaded,
        note: `Matched to the set sent on ${new Date(threaded.sentAt).toDateString()} — the reply threads onto that mail.`,
        near: [],
      };
    }
  }

  // Which opening? Scored off the subject.
  const cands = titleCandidates(msg.subject);
  const subjectNorm = norm(msg.subject);
  const fits = (r: ReviewRound): boolean => {
    const o = ctx.openings.find((x) => x.id === r.openingId);
    if (!o) return false;
    const titleHit = cands.some((c) => {
      const cn = norm(c);
      return cn === norm(o.title) || cn.includes(norm(o.title)) || subjectNorm.includes(norm(o.title));
    });
    if (!titleHit) return false;
    // The client name is in the house subject line too; where it is present it
    // has to agree, which is what stops two clients hiring the same job title
    // from crossing over.
    const client = ctx.clients.find((c) => c.id === o.clientId);
    if (client) {
      const cn = norm(client.name);
      const named = ctx.clients.some((c) => subjectNorm.includes(norm(c.name)));
      if (named && !subjectNorm.includes(cn)) return false;
    }
    return true;
  };

  const bySubject = open.filter(fits);
  if (bySubject.length === 0)
    return {
      round: null,
      note: "The subject does not name any opening with a set out.",
      near: [],
    };

  if (!kind)
    return {
      round: null,
      note: `${from} is not the Director and not a contact on this client, so there is no telling whether this is a director or a client decision.`,
      near: bySubject,
    };

  const byKind = bySubject.filter((r) => {
    if (r.kind !== kind) return false;
    // A client contact answers their OWN client's sets and nobody else's.
    // Without this, two clients hiring the same job title can answer each
    // other's shortlists — the subject matches, the sender is "a client
    // contact", and the reply lands on the wrong opening.
    if (kind === "client") {
      const o = ctx.openings.find((x) => x.id === r.openingId);
      return !!o && !!clientContact && o.clientId === clientContact.id;
    }
    return true;
  });
  if (byKind.length === 0)
    return {
      round: null,
      note:
        kind === "client"
          ? `${from} is a contact at ${clientContact?.name ?? "another client"}, and nothing is out with them on that opening.`
          : "Nothing is out with the Director on that opening.",
      near: bySubject,
    };

  // Which of that opening's sets. A job that has been running a month has had
  // several, and "the newest one" was how a reply about 1 September came to be
  // applied to a set sent on the 11th containing different people — the
  // 13 September audit reproduced exactly that.
  //
  // Three signals, strongest first. Only the last one guesses, and it says so.
  const pick = (): { round: ReviewRound; how: string } => {
    // 1. The subject the set was sent under. The house subject line carries the
    //    client, the job and the date, and a reply keeps it after the "RE:".
    //    (A provider thread id, when there is one, was settled further up.)
    const replySubject = strippedSubject(msg.subject);
    const sameSubject = byKind.filter((r) => strippedSubject(r.subject) === replySubject);
    if (sameSubject.length === 1) {
      return { round: sameSubject[0], how: "the subject line matches the one it was sent under" };
    }

    // 2. The date written in the subject, which is how the desk has always told
    //    one day's set from another.
    const when = dateInSubject(msg.subject);
    if (when) {
      const sameDay = byKind.filter((r) => onSameDay(r.sentAt, when));
      if (sameDay.length === 1) {
        return { round: sameDay[0], how: `the subject names ${when.toDateString()}` };
      }
    }

    const newest = [...byKind].sort((a, b) => b.sentAt - a.sentAt)[0];
    return {
      round: newest,
      how: "nothing in the reply says which set it answers, so this is the most recent one",
    };
  };

  if (byKind.length === 1) {
    const only = byKind[0];
    return {
      round: only,
      note: `Matched to the set sent to the ${kind} on ${new Date(only.sentAt).toDateString()}.`,
      near: [],
    };
  }

  const { round: best, how } = pick();
  return {
    round: best,
    note:
      `${byKind.length} sets are out with the ${kind} on this opening. ` +
      `Matched to ${new Date(best.sentAt).toDateString()} because ${how}.`,
    near: byKind.filter((r) => r.id !== best.id),
  };
}

/** "<abc@mail>" and "abc@mail" are the same id. */
function bareMessageId(raw: string): string {
  return raw.trim().replace(/^</, "").replace(/>$/, "").toLowerCase();
}

/** The subject without the reply and forward prefixes mail clients pile on. */
function strippedSubject(raw: string): string {
  let out = raw.trim();
  let changed = true;
  while (changed) {
    const next = out.replace(/^(re|fw|fwd|aw|sv|vs)\s*(\[\d+\])?\s*:\s*/i, "");
    changed = next !== out;
    out = next;
  }
  return norm(out);
}

const MONTHS = [
  "january", "february", "march", "april", "may", "june",
  "july", "august", "september", "october", "november", "december",
];

/**
 * The date the house subject line carries — "DELMO - BRAND MANAGER - 1
 * SEPTEMBER 2026". It is read, never added: the subject format is the desk's,
 * and the reader adapts to it rather than asking anybody to change how they write.
 */
export function dateInSubject(subject: string): Date | null {
  const text = subject.toLowerCase();

  const long = text.match(
    /\b(\d{1,2})(?:st|nd|rd|th)?\s+([a-z]{3,9})\.?\s+(\d{4})\b/,
  );
  if (long) {
    const month = MONTHS.findIndex((m) => m.startsWith(long[2].slice(0, 3)));
    if (month >= 0) return new Date(Number(long[3]), month, Number(long[1]));
  }

  const monthFirst = text.match(/\b([a-z]{3,9})\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(\d{4})\b/);
  if (monthFirst) {
    const month = MONTHS.findIndex((m) => m.startsWith(monthFirst[1].slice(0, 3)));
    if (month >= 0) return new Date(Number(monthFirst[3]), month, Number(monthFirst[2]));
  }

  const numeric = text.match(/\b(\d{1,2})[/-](\d{1,2})[/-](\d{4})\b/);
  // Day first: the desk writes British dates, and the subject builder does too.
  if (numeric) return new Date(Number(numeric[3]), Number(numeric[2]) - 1, Number(numeric[1]));

  return null;
}

function onSameDay(a: number, b: Date): boolean {
  const x = new Date(a);
  return (
    x.getFullYear() === b.getFullYear() &&
    x.getMonth() === b.getMonth() &&
    x.getDate() === b.getDate()
  );
}


// ─────────────────────────────────────────────────────────── campaign codes ──

/** "Brand Manager" → "BM-7K3". Short enough to type, unlikely to collide. */
export function makeCampaignCode(title: string, taken: string[]): string {
  const letters = title
    .split(/\s+/)
    .filter((w) => /^[A-Za-z]/.test(w) && !["of", "and", "the", "for"].includes(w.toLowerCase()))
    .map((w) => w[0].toUpperCase())
    .join("")
    .slice(0, 4) || "JOB";
  const alphabet = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
  for (let i = 0; i < 50; i++) {
    const tail = Array.from({ length: 3 }, () => alphabet[Math.floor(Math.random() * alphabet.length)]).join("");
    const code = `${letters}-${tail}`;
    if (!taken.includes(code)) return code;
  }
  return `${letters}-${Date.now().toString(36).slice(-4).toUpperCase()}`;
}

/**
 * The live post whose campaign code appears in a message, if exactly one does.
 *
 * Checked before the mailbox and headline, because a code is a deliberate
 * label and a headline is a guess.
 */
export function routeByCampaignCode(text: string, posts: JobPost[]): JobPost | null {
  const hay = text.toUpperCase();
  const hits = posts.filter(
    (p) => p.status === "live" && p.campaignCode && new RegExp(`(^|[^A-Z0-9])${p.campaignCode}([^A-Z0-9]|$)`).test(hay),
  );
  return hits.length === 1 ? hits[0] : null;
}
