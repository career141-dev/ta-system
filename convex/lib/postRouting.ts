// convex/lib/postRouting.ts
//
// Which advert an arriving application belongs to — the rules, and nothing
// that reads the database.
//
// Moved here unchanged from ta/intakeRouting.ts so the rules can be tested on
// their own (tests/postrouting.test.ts) and shared by the two routes that use
// them:
//
//   ta/intakeRouting:routeInbound — a TA's own mailbox: address → TA, then the
//                                   headline among that TA's adverts
//   routeShared (below)           — the desk's shared mailboxes (linkedin@,
//                                   cv@, job@), where the address says nothing
//                                   about which TA, so every live advert is a
//                                   candidate and stronger signals come first
//
// src/lib/routing.ts is the app's copy of the same rules; keep them in step.

export type RouteConfidence = "exact" | "keyword" | "partial" | "none";

/** The fields of a job post the rules read. Convex docs and app rows both fit. */
export interface RoutablePost {
  id: string;
  openingId: string;
  title: string;
  previousTitles?: string[];
  aliasKeywords?: string[];
  city?: string | null;
  country?: string | null;
  channel?: string;
  campaignCode?: string;
  externalUrl?: string | null;
  postedAt?: number | null;
  status: string;
}

export interface PostPick {
  postId: string;
  openingId: string;
  confidence: RouteConfidence;
  matchedOn: string;
  /** The same advert serving more than one opening — the CV belongs on each. */
  alsoTo: { postId: string; openingId: string }[];
  /** How it was decided, for the log a person reads. */
  how: "linkedin_job" | "linkedin_project" | "campaign_code" | "headline";
}

// ── normalisation ───────────────────────────────────────────────────────────

/** `"Nuha Jobs" <NUHA.JOBS@Career141.com>` → `nuha.jobs@career141.com`. */
export function addressOf(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const inAngles = raw.match(/<([^>]+)>/);
  const t = (inAngles ? inAngles[1] : raw).trim().toLowerCase();
  return /^[^\s@]+@[^\s@]+\.[a-z]{2,}$/.test(t) ? t : null;
}

/**
 * The wrapping the boards put round a job title.
 *
 * LinkedIn's notifications are not "Brand Manager" — they are "New
 * application: Brand Manager from Nimal Perera". Stripping the furniture first
 * is what lets an exact match be trusted; without it everything falls through
 * to fuzzy matching, and fuzzy matching on a live inbox files CVs against the
 * wrong job.
 */
const WRAPPERS: RegExp[] = [
  /^\s*(?:re|fw|fwd)\s*:\s*/i,
  /^\s*new application\s*:?\s*/i,
  // LinkedIn's second notification (seen on linkedin@, 16 September): "You have
  // a new applicant ready for review for Brand Manager of Delmo".
  /^\s*(?:you\s+)?have\s+(?:a\s+)?new\s+applicants?\s+ready\s+for\s+review\s+for\s*:?\s*/i,
  /^\s*(?:your )?applicant(?:s)? for\s*:?\s*/i,
  /^\s*application (?:for|to)\s*:?\s*/i,
  /\s*[-–|]\s*linkedin\s*$/i,
  /\s*\|\s*(?:indeed|jobstreet|topjobs|xpress ?jobs|rozee)\s*$/i,
];

export function titleCandidates(subject: string): string[] {
  let s = (subject ?? "").replace(/\s+/g, " ").trim();
  for (const w of WRAPPERS) s = s.replace(w, "");
  const out = new Set<string>([s]);

  const appliedTo = s.match(/\bapplied\s+(?:to|for)\s+(.+?)(?:\s+at\s+.+)?$/i);
  if (appliedTo?.[1]) out.add(appliedTo[1]);
  const before = s.match(/^(.+?)\s+(?:from|by)\s+\S+/i);
  if (before?.[1]) out.add(before[1]);
  const atClient = s.match(/^(.+?)\s+at\s+\S+/i);
  if (atClient?.[1]) out.add(atClient[1]);
  // "Brand Manager of Delmo"
  const ofClient = s.match(/^(.+?)\s+of\s+\S+/i);
  if (ofClient?.[1]) out.add(ofClient[1]);
  for (const part of s.split(/\s+[-–|]\s+/)) out.add(part);
  // "Country Head / General Manager Sales and Marketing - Sea freight": either
  // side of a spaced slash is a title on its own.
  for (const part of s.split(/\s+\/\s+/)) out.add(part);

  return [...out].map((x) => x.trim()).filter((x) => x.length >= 3);
}

/**
 * The subject's job title as a whole — the subject without its wrapper, the
 * applicant's name or the client — never a fragment of it.
 */
export function wholeTitles(subject: string): string[] {
  let s = (subject ?? "").replace(/\s+/g, " ").trim();
  for (const w of WRAPPERS) s = s.replace(w, "");
  const out = new Set<string>([s]);
  const appliedTo = s.match(/\bapplied\s+(?:to|for)\s+(.+?)(?:\s+at\s+.+)?$/i);
  if (appliedTo?.[1]) out.add(appliedTo[1]);
  const before = s.match(/^(.+?)\s+(?:from|by)\s+\S+/i);
  if (before?.[1]) out.add(before[1]);
  return [...out].map((x) => x.trim()).filter((x) => x.length >= 3);
}

/**
 * An advert title's own head: "Pricing Manager" of "Pricing Manager – Sea &
 * Air Freight", "Divisional Merchandise Manager" of "… from Apparel
 * Manufacturing Industry". The LinkedIn advert often carries only that.
 */
export function titleHead(title: string): string {
  return (title ?? "").split(/\s+(?:[-–|]|from)\s+/i)[0].trim();
}

export function norm(s: string): string {
  return (s ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9&\s]/g, " ")
    .replace(/\b(and|the|of|for|a|an)\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

const tokens = (s: string) => norm(s).split(" ").filter(Boolean);

/** Words that make a title a different job when they follow it ("Sales Manager Assistant"). */
const CHANGES_ROLE_AFTER = new Set(["assistant", "trainee", "intern", "internship", "apprentice", "support", "coordinator"]);

/**
 * `text` (normalised) starts with the whole of `title` (normalised), and what
 * follows does not change the job. Words BEFORE a title almost always do —
 * General, Regional, Area, Deputy, Assistant — so a title inside a subject
 * only counts at the start.
 */
export function leadsWith(text: string, title: string): boolean {
  if (!title || !text.startsWith(`${title} `)) return false;
  return !CHANGES_ROLE_AFTER.has(text.slice(title.length + 1).split(" ")[0]);
}

// ── scoring one advert ──────────────────────────────────────────────────────

export interface Scored<P extends RoutablePost = RoutablePost> {
  post: P;
  score: number;
  confidence: RouteConfidence;
  matchedOn: string;
}

export function scorePost<P extends RoutablePost>(post: P, cands: string[], whole: string[] = cands): Scored<P> | null {
  const postNorm = norm(post.title);
  const postTokens = tokens(post.title);
  let best: Scored<P> | null = null;
  const take = (score: number, confidence: RouteConfidence, matchedOn: string) => {
    if (!best || score > best.score) best = { post, score, confidence, matchedOn };
  };

  // The whole title in the subject is the advert's head. Only the whole title:
  // "General Manager - Sales" must not match the head "General Manager" of an
  // unrelated advert through its first segment. Below an exact title, so a
  // subject naming the shorter title still goes to that advert if it exists.
  const head = norm(titleHead(post.title));
  if (head !== postNorm && head.split(" ").length >= 2 && whole.some((w) => norm(w) === head)) {
    take(75, "exact", post.title);
  }

  for (const c of cands) {
    const cn = norm(c);
    if (!cn) continue;

    // The whole title, exactly — the only thing worth acting on without doubt.
    if (cn === postNorm) take(100, "exact", post.title);
    // The title followed by a place, a client or a product line ("Chief
    // Operating Officer - Gloves"). Not a title found anywhere inside the
    // subject, and never the subject found inside a title: on 16 September
    // "General Sales Manager" filed 169 applicants to "Sales Manager", and the
    // fragment "Head" (from "Head of Operations") matched every "Head of …".
    else if (leadsWith(cn, postNorm)) take(80, "exact", post.title);

    // A title the advert carried before it was edited: applicants who clicked
    // before the edit still arrive under the old one.
    for (const old of post.previousTitles ?? []) {
      const on = norm(old);
      if (on && (cn === on || leadsWith(cn, on))) take(90, "exact", old);
    }

    // A keyword the TA put on the post on purpose — the advert may be headed
    // "Marketing Lead" while the opening is "Brand Manager". The old system's
    // per-job keyword is carried here by the backfill, so a reply quoting it
    // still lands.
    for (const k of post.aliasKeywords ?? []) {
      const kn = norm(k);
      if (kn && (cn === kn || ` ${cn} `.includes(` ${kn} `))) take(70, "keyword", k);
    }

    const ct = new Set(tokens(c));
    const hit = postTokens.filter((t) => ct.has(t)).length;
    if (postTokens.length > 0 && hit === postTokens.length) take(60, "partial", post.title);
    // One word short, but only where the title is long enough for that to mean
    // something. On a two-word title "one short" is one shared word, and job
    // titles here share their second word constantly — Marketing Executive and
    // Operations Executive are not the same advert.
    else if (postTokens.length > 2 && hit >= 2 && hit >= postTokens.length - 1) {
      take(40, "partial", post.title);
    }
  }
  return best;
}

/**
 * The best advert among `live` for a subject, with the desk's tie rules.
 *
 * A tie is normal on this desk, not a reason to give up: one job is posted
 * under several adverts. The region named in the message picks one; where it
 * does not, adverts of the same opening are the same job (the newest post is
 * the one recorded). Same title across DIFFERENT openings: the advert is
 * shared, so the CV goes to every opening it serves (13 September).
 */
export function rankPosts<P extends RoutablePost>(
  live: P[],
  subject: string,
  body?: string | null,
): { primary: Scored<P>; alsoTo: Scored<P>[] } | null {
  const cands = titleCandidates(subject);
  const whole = wholeTitles(subject);
  const scored = live
    .map((p) => scorePost(p, cands, whole))
    .filter((x): x is Scored<P> => x !== null)
    .sort((a, b) => b.score - a.score);
  if (scored.length === 0) return null;

  const top = scored[0];
  let tied = scored.filter((s) => s.score === top.score);

  if (tied.length > 1) {
    const text = norm(`${subject} ${body ?? ""}`);
    const inRegion = tied.filter((t) =>
      [t.post.city, t.post.country].some((place) => place && text.includes(norm(place))),
    );
    if (inRegion.length >= 1) tied = inRegion;
  }

  // The more specific advert wins a tie. "Chief Operating Officer - Gloves"
  // contains "Chief Operating Officer", so a subject naming the first matches
  // both at the same score; on 16 September that filed 39 of 507 real LinkedIn
  // applications to the wrong opening as well. Identical titles are left tied —
  // that is one advert serving two clients.
  if (tied.length > 1) {
    const specific = tied.filter(
      (t) => !tied.some((o) => o !== t && norm(o.post.title).length > norm(t.post.title).length && norm(o.post.title).includes(norm(t.post.title))),
    );
    if (specific.length >= 1) tied = specific;
  }

  const byOpening = new Map<string, Scored<P>>();
  for (const t of [...tied].sort((a, b) => (b.post.postedAt ?? 0) - (a.post.postedAt ?? 0))) {
    if (!byOpening.has(t.post.openingId)) byOpening.set(t.post.openingId, t);
  }
  const picks = [...byOpening.values()];
  return { primary: picks[0], alsoTo: picks.slice(1) };
}

// ── shared mailboxes ────────────────────────────────────────────────────────

/** A LinkedIn job's number, from any of the URL shapes LinkedIn uses. */
export function linkedinJobId(text: string | null | undefined): string | null {
  const m = String(text ?? "").match(
    /linkedin\.com\/(?:comm\/)?(?:jobs\/view\/(?:[^\s"'<>?#/]*-)?|jobs\/search\/?\?[^\s"'<>]*currentJobId=|hiring\/jobs\/)(\d{6,})/i,
  );
  return m ? m[1] : null;
}

/**
 * A LinkedIn Recruiter project's number.
 *
 * The desk posts through LinkedIn Recruiter. Every application email's "View
 * applicant" button links to `talent/redirect/batchReview?project=1528413625&…`,
 * and a project's own page is `talent/hire/1528413625/…` — the same number
 * (22 September). A TA saves either link on the post once; every later
 * application for that job carries the number, whatever its title says. The
 * link may arrive HTML-escaped (`&amp;`) or URL-encoded in a tracking wrapper,
 * so both forms are read.
 */
export function linkedinProjectId(text: string | null | undefined): string | null {
  const raw = String(text ?? "");
  const unescaped = raw.replace(/&amp;/gi, "&");
  let decoded = unescaped;
  try {
    decoded = decodeURIComponent(unescaped);
  } catch {
    /* a stray % — the undecoded text is still read */
  }
  for (const t of [unescaped, decoded]) {
    const m =
      t.match(/linkedin\.com\/talent\/hire\/(\d{6,})/i) ??
      t.match(/linkedin\.com\/talent\/[^\s"'<>]*?[?&]project=(\d{6,})/i);
    if (m) return m[1];
  }
  return null;
}

/** The live post whose campaign code appears in the text, if exactly one does. */
export function postByCampaignCode<P extends RoutablePost>(text: string, posts: P[]): P | null {
  const hay = text.toUpperCase();
  const hits = posts.filter(
    (p) => p.status === "live" && p.campaignCode && new RegExp(`(^|[^A-Z0-9])${escapeRe(p.campaignCode.toUpperCase())}([^A-Z0-9]|$)`).test(hay),
  );
  return hits.length === 1 ? hits[0] : null;
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Route a message that arrived at one of the desk's shared mailboxes.
 *
 * Strongest signal first:
 *   1. the LinkedIn job number in the message, against each post's advert URL
 *   2. a campaign code in the subject or body
 *   3. the headline, among every live advert on the desk (LinkedIn adverts
 *      only, for the LinkedIn mailbox)
 *
 * Only exact and keyword headline matches are returned. Across the whole desk a
 * partial match is a guess, and a guess puts a candidate in front of the wrong
 * client; a message that does not route goes to the database instead, where
 * nothing is lost.
 *
 * `live` must already be restricted to live posts on open openings.
 */
export function routeShared<P extends RoutablePost>(
  input: { subject: string; body?: string | null; linkedinOnly?: boolean },
  live: P[],
): PostPick | null {
  const text = `${input.subject}\n${input.body ?? ""}`;

  const jobNo = linkedinJobId(input.body) ?? linkedinJobId(input.subject);
  if (jobNo) {
    const byUrl = live.filter((p) => linkedinJobId(p.externalUrl) === jobNo);
    if (byUrl.length >= 1) {
      const [primary, ...rest] = [...byUrl].sort((a, b) => (b.postedAt ?? 0) - (a.postedAt ?? 0));
      const others = new Map<string, P>();
      for (const p of rest) if (p.openingId !== primary.openingId && !others.has(p.openingId)) others.set(p.openingId, p);
      return {
        postId: primary.id,
        openingId: primary.openingId,
        confidence: "exact",
        matchedOn: `LinkedIn job ${jobNo}`,
        alsoTo: [...others.values()].map((p) => ({ postId: p.id, openingId: p.openingId })),
        how: "linkedin_job",
      };
    }
  }

  // The LinkedIn Recruiter project behind the "View applicant" button.
  const projectNo = linkedinProjectId(input.body);
  if (projectNo) {
    const byProject = live.filter((p) => linkedinProjectId(p.externalUrl) === projectNo);
    if (byProject.length >= 1) {
      const [primary, ...rest] = [...byProject].sort((a, b) => (b.postedAt ?? 0) - (a.postedAt ?? 0));
      const others = new Map<string, P>();
      for (const p of rest) if (p.openingId !== primary.openingId && !others.has(p.openingId)) others.set(p.openingId, p);
      return {
        postId: primary.id,
        openingId: primary.openingId,
        confidence: "exact",
        matchedOn: `LinkedIn project ${projectNo}`,
        alsoTo: [...others.values()].map((p) => ({ postId: p.id, openingId: p.openingId })),
        how: "linkedin_project",
      };
    }
  }

  const coded = postByCampaignCode(text, live);
  if (coded) {
    return {
      postId: coded.id,
      openingId: coded.openingId,
      confidence: "exact",
      matchedOn: coded.campaignCode ?? "",
      alsoTo: [],
      how: "campaign_code",
    };
  }

  const pool = input.linkedinOnly ? live.filter((p) => (p.channel ?? "linkedin") === "linkedin") : live;
  const ranked = rankPosts(pool, input.subject, input.body);
  if (!ranked) return null;
  if (ranked.primary.confidence !== "exact" && ranked.primary.confidence !== "keyword") return null;
  return {
    postId: ranked.primary.post.id,
    openingId: ranked.primary.post.openingId,
    confidence: ranked.primary.confidence,
    matchedOn: ranked.primary.matchedOn,
    alsoTo: ranked.alsoTo.map((t) => ({ postId: t.post.id, openingId: t.post.openingId })),
    how: "headline",
  };
}
