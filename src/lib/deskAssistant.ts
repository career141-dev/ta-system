/**
 * The desk assistant — a TA asks in words, and gets the answer from the desk's
 * own records (13 September).
 *
 * Two rules:
 *
 *   1. **It sees only what the person asking can see.** The snapshot is built
 *      from the same scoping the screens use — a TA's own openings, a client
 *      seat's shortlist and nothing behind it. The model is never given the
 *      whole desk to be discreet with.
 *   2. **It answers from the snapshot, not from memory.** Numbers are counted
 *      here, in code, and handed over; the model's job is to pick the right
 *      ones and say them plainly. If the snapshot does not hold the answer it
 *      says so instead of guessing.
 *
 * It reads and links. It does not change anything — moving a stage or
 * shortlisting stays on the screens, where the checks are.
 */

import { repo, setsForOpening, stageCounts } from "@/data/store";
import { ROLE_LABEL, STAGE_LABEL, type Application, type Assignment, type Stage, type User } from "@/data/types";
import { can, isDeskWide, type Capability } from "./auth";
import { colomboDayStart } from "./calendar";
import { alertsFor } from "./sla";
import { deskScope, seatFor, visiblePosts } from "./visibility";
import { write, type AiResult } from "./ai";
import { assess } from "./assessment";
import { FIT_BANDS } from "./scoring";
import { PLATFORM_KNOWLEDGE, quickWorkflowHelp } from "./platformGuide";

const DAY = 86_400_000;
const when = (t: number) =>
  new Date(t).toLocaleString("en-GB", { timeZone: "Asia/Colombo", weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });

export type AssistantTurn = { role: "user" | "assistant"; text: string };

/** Words in the question that could name a job, a client or a person. */
function words(q: string) {
  return q.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 2);
}

/** Said in place of a name the store has not loaded — never a blank, never a guess. */
const NOT_LOADED = "name not loaded";

/*
 * A desk-wide person with many jobs asking "who's in follow-up" or "where are
 * my sets" got no names at all (6 Oct): detail was only built for the jobs the
 * question named. For these whole-desk questions the most recently active jobs
 * get detail, capped so the snapshot stays small, and the rest are counted.
 */
const DESK_WIDE_DETAIL = 10;
const WHOLE_DESK_QUESTION = /follow.?ups?|\bsets?\b|\binterviews?\b|\bdirector\b|\boffers?\b|\bclient\b|shortlist\w*|\bmatch(es)?\b|\breview\b/i;

/**
 * The openings this person may hear about, what they may see on each, and
 * which get names and numbers. Shared by `snapshotFor` and by
 * `snapshotCandidateIds`, so the people loaded first are exactly the people
 * the snapshot will name.
 */
function deskView(user: User, question: string) {
  const clients = new Map(repo.clients().map((c) => [c.id, c.name]));
  const openings = repo.openingsForUser(user).filter((o) => o.status === "open" || o.status === "on_hold");
  const asked = words(question);
  const mentions = (text: string) => words(text).some((w) => asked.includes(w));
  const scoped = openings.map((o) => {
    const assignment = repo.assignmentFor(o.id, user.id) ?? null;
    const seat = seatFor(user, assignment?.role ?? null);
    const rows = deskScope(repo.applications(o.id), seat);
    return {
      o,
      seat,
      own: rows.filter((r) => !r.takenBy).map((r) => r.row),
      taken: rows.filter((r) => r.takenBy) as { row: Application; takenBy: string }[],
    };
  });
  const named = new Set(scoped.filter((s) => mentions(`${s.o.title} ${clients.get(s.o.clientId) ?? ""}`)).map((s) => s.o.id));
  const detail = new Set<string>();
  let notDetailed = 0;
  for (const s of scoped) {
    if (openings.length <= 8 || named.has(s.o.id) || (!isDeskWide(user) && s.o.assignedTaIds.includes(user.id))) detail.add(s.o.id);
  }
  if (isDeskWide(user) && openings.length > 8 && named.size === 0 && WHOLE_DESK_QUESTION.test(question)) {
    const lastActive = (s: (typeof scoped)[number]) => Math.max(0, ...s.own.map((a) => Math.max(a.lastStageChangedAt ?? 0, a.createdAt)));
    const recent = [...scoped].sort((x, y) => lastActive(y) - lastActive(x)).slice(0, DESK_WIDE_DETAIL);
    for (const s of recent) detail.add(s.o.id);
    notDetailed = scoped.length - recent.length;
  }
  // Names and numbers only for a seat that sees the whole pipeline. A client
  // seat gets counts of its own shortlist.
  for (const s of scoped) if (s.seat.stages !== null) detail.delete(s.o.id);
  return { clients, scoped, detail, notDetailed, asked };
}

/** Stages whose people the snapshot names in a list (everything but the raw intake and the closed). */
const UNNAMED_STAGES = new Set<Stage>(["new_cv", "rejected", "dropped_out"]);
const CANDIDATE_CAP = 3000;

/**
 * The candidate records the snapshot will name, for the route to load before
 * building it (6 Oct). The store holds candidates only for the alert stages,
 * so a top match or an interview could reach the model with a null name.
 *
 * Bounded: the named stages on the jobs that get detail first, then — only
 * when the question holds a word that could be a person's name — everyone in
 * scope, so "what stage is Thisara at" can find them. Never past 3,000, the
 * same ceiling the action proposals use; never the whole database.
 */
export function snapshotCandidateIds(user: User, question: string): string[] {
  const v = deskView(user, question);
  const ids = new Set<string>();
  const add = (id: string) => { if (ids.size < CANDIDATE_CAP) ids.add(id); };
  for (const s of v.scoped) {
    if (!v.detail.has(s.o.id)) continue;
    for (const a of s.own) if (!UNNAMED_STAGES.has(a.stage)) add(a.candidateId);
    for (const t of s.taken) add(t.row.candidateId);
  }
  const jobWords = new Set(v.scoped.flatMap((s) => words(`${s.o.title} ${v.clients.get(s.o.clientId) ?? ""}`)));
  const mayBeName = v.asked.some((w) => w.length > 3 && !COMMON.has(w) && !INTENT_WORDS.has(w) && !jobWords.has(w));
  if (mayBeName) {
    for (const s of v.scoped) {
      for (const a of s.own) add(a.candidateId);
      for (const t of s.taken) add(t.row.candidateId);
    }
  }
  return [...ids];
}

/** What this person's role may and may not do, from the one policy (lib/auth). */
const ROLE_CAPS: [Capability, string][] = [
  ["opening.act", "move candidates, log calls and record follow-up answers"],
  ["opening.sourcing", "headhunt: Excel Tables, Suggestions, Research, Benchmark"],
  ["opening.manage", "edit a job's terms, posts and team"],
  ["decide.director", "record the Director's decision (move to Director shortlist)"],
  ["decide.client", "record the client's decision (move to Client shortlist)"],
  ["opening.create", "start a new opening"],
  ["client.manage", "add and edit clients"],
  ["database.read", "search the whole database"],
  ["report.read", "read reports"],
  ["commercial.manage", "fees, guarantees and placements"],
  ["link.note", "leave notes for the TA on Excel Tables rows"],
  ["user.manage", "add and edit people"],
];

/**
 * Who is asking, in words the model can act on (6 Oct). The prompt said
 * "a member of the TA desk" to everyone, so a client seat could be told to
 * shortlist and a TA to approve for the Director.
 */
const ON_A_JOB = new Set(ROLE_CAPS.filter(([c]) => (c.startsWith("opening.") && c !== "opening.create") || c.startsWith("decide.")).map(([, label]) => label));

export function roleBrief(user: User) {
  // Opening-level rights are asked as if on one of their jobs; the policy
  // itself refuses them on a job they are not on.
  const assignment = { role: user.role === "client" ? "client_contact" : "primary_recruiter" } as Assignment;
  const canDo: string[] = [];
  const cannotDo: string[] = [];
  for (const [cap, label] of ROLE_CAPS) (can(user, cap, { assignment }).ok ? canDo : cannotDo).push(label);
  return {
    name: user.name,
    role: ROLE_LABEL[user.role],
    sees: isDeskWide(user)
      ? "the whole desk"
      : user.role === "ta"
        ? "the jobs they are on: their own candidates and the unclaimed pool; a colleague's only once shortlisted, by name"
        : "only the jobs they have been put on, and only the stages their seat allows",
    // Work on a job is theirs only on the jobs they are put on; the rest is desk-wide.
    canDo: isDeskWide(user) ? canDo : canDo.map((c) => (ON_A_JOB.has(c) ? `${c} (on the jobs they are on)` : c)),
    cannotDo,
  };
}

/**
 * Everything the assistant may say about, for this person, right now.
 *
 * Detail — names, numbers, follow-up state — is included for every opening
 * when there are few, for the ones the question names, and for a desk-wide
 * person's ten most active jobs on a whole-desk question, so the snapshot
 * stays small and quick.
 */
export function snapshotFor(user: User, question: string, now = Date.now()) {
  const today = colomboDayStart(now);
  const weekAgo = today - 6 * DAY;
  const users = new Map(repo.users().map((u) => [u.id, u.name]));
  const v = deskView(user, question);
  const nameOf = (candidateId: string) => repo.candidate(candidateId)?.fullName ?? NOT_LOADED;

  const followUpsByApp = new Map(repo.followUps(now).map((f) => [f.application.id, f]));

  const out = v.scoped.map(({ o, own: apps, taken }) => {
    const counts = stageCounts(o.id);
    const visibleStages = new Set(apps.map((a) => a.stage));
    const applied = apps.filter((a) => a.sourcingChannel !== "SCOOP");
    const base = {
      id: o.id,
      title: o.title,
      client: v.clients.get(o.clientId) ?? null,
      status: o.status,
      jd: o.jdStatus === "approved" ? "approved" : "waiting for approval",
      ...(o.jdStatus === "approved" ? {} : { jdLink: `/openings/${o.id}/jd` }),
      recruiters: o.assignedTaIds.map((t) => users.get(t) ?? t),
      cvsToday: applied.filter((a) => a.createdAt >= today).length,
      cvsLast7Days: applied.filter((a) => a.createdAt >= weekAgo).length,
      byStage: Object.fromEntries(
        (Object.keys(counts) as Stage[]).filter((s) => visibleStages.has(s)).map((s) => [STAGE_LABEL[s], apps.filter((a) => a.stage === s).length]),
      ),
      link: `/openings/${o.id}`,
    };
    if (!v.detail.has(o.id)) return base;

    const candidate = (id: string) => repo.candidate(id);
    // Only the follow-ups in this person's own view. It read "any TA on the
    // opening", which listed a colleague's follow-ups, numbers and all (6 Oct).
    const followUps = apps
      .map((a) => followUpsByApp.get(a.id))
      .filter((f): f is NonNullable<typeof f> => !!f)
      .map((f) => ({
        name: f.candidate.fullName,
        phone: f.candidate.phone,
        email: f.candidate.email,
        owner: users.get(f.application.ownerTaId ?? "") ?? null,
        state: f.followUp.state,
        stillMissing: f.followUp.missing.map((q) => q.label),
        next: f.followUp.next ? `${f.followUp.next.reason} — ${f.followUp.next.channels.join(" + ")} at ${when(f.followUp.next.at)}` : null,
        needsPerson: f.followUp.handBack,
        link: `/openings/${o.id}/candidate/${f.application.id}?tab=call`,
      }));

    const interviews = apps
      .flatMap((a) => repo.interviews(a.id).map((i) => ({ i, a })))
      .filter(({ i }) => i.scheduledAt >= today - DAY)
      .sort((x, y) => x.i.scheduledAt - y.i.scheduledAt)
      .slice(0, 15)
      .map(({ i, a }) => ({
        name: nameOf(a.candidateId),
        phone: candidate(a.candidateId)?.phone ?? null,
        at: when(i.scheduledAt),
        confirmed: Boolean(i.confirmedAt),
        link: `/openings/${o.id}/candidate/${a.id}`,
      }));

    const people = (stages: Stage[], limit = 25) =>
      apps
        .filter((a) => stages.includes(a.stage))
        .slice(0, limit)
        .map((a) => ({
          name: nameOf(a.candidateId),
          phone: candidate(a.candidateId)?.phone ?? null,
          stage: STAGE_LABEL[a.stage],
          set: a.setNumber,
          owner: users.get(a.ownerTaId ?? "") ?? null,
          link: `/openings/${o.id}/candidate/${a.id}`,
        }));

    // Database matches waiting for a TA, best first, with what makes them fit —
    // so "top matches for X" and "anyone with NEBOSH" can be answered (13 September:
    // the live test found the assistant could see none of this).
    const QUALS = /\b(ACCA|FCCA|CIMA|ACMA|CGMA|ACA|FCA|CPA|CFA|NEBOSH|IOSH|CIPS|CIPD|CIPM|ISMM|PMP|MBA|SLIM|CIM|AAT|Six Sigma|Lean Six Sigma)\b/g;
    // The same assessment the candidate list shows — computed, never parsed out
    // of a note written when the match was made (13 September review).
    const matchApps = apps.filter((a) => a.stage === "matched");
    const loaded = matchApps.map((a) => ({ a, c: candidate(a.candidateId) })).filter((x) => x.c);
    const assessed = assess(o.id, loaded.map((x) => x.c!));
    const scores = assessed.ok
      ? new Map([...assessed.scores].map(([id, s]) => [id, s.overall]))
      : new Map<string, number>();
    const matched = loaded
      .map(({ a, c }) => ({ a, c, fit: scores.get(c!.id) ?? NaN }))
      .sort((x, y) => (Number.isNaN(y.fit) ? 0 : y.fit) - (Number.isNaN(x.fit) ? 0 : x.fit));
    const databaseMatches = {
      // Which rules produced the fit scores, or why there are none.
      assessment: assessed.ok ? { version: assessed.version } : { unavailable: assessed.message },
      // Counted from the applications, not from the records loaded — a person
      // whose record is not in memory is still a match (6 Oct).
      total: matchApps.length,
      strong: matched.filter((x) => x.fit >= FIT_BANDS.strong).length,
      unclaimed: matchApps.filter((a) => !a.ownerTaId).length,
      top: matched.slice(0, 12).map(({ a, c, fit }) => ({
        name: c!.fullName,
        fitScore: Number.isNaN(fit) ? null : fit,
        currentTitle: c!.currentTitle,
        employer: c!.currentEmployer,
        years: c!.totalExperienceYears,
        qualifications: [...new Set(`${c!.qualifications ?? ""} ${c!.educationDegree ?? ""} ${(repo.cvTextFor(c!.id) ?? "").slice(0, 8000)}`.match(QUALS) ?? [])].slice(0, 6),
        link: `/openings/${o.id}/candidate/${a.id}`,
      })),
    };

    return {
      ...base,
      waitingForReview: { newCvs: apps.filter((a) => a.stage === "new_cv" && !a.ownerTaId).length, databaseMatches: databaseMatches.unclaimed },
      databaseMatches,
      // A TA hears about their own posts only — a colleague's post, its count
      // and its title are theirs (12 Sep wall).
      posts: (isDeskWide(user) ? repo.jobPosts(o.id) : visiblePosts(repo.jobPosts(o.id), user)).map((p) => ({ title: p.title, status: p.status, cvsToday: p.cvCountToday, owner: users.get(p.assignedTaId ?? "") ?? null })),
      sets: setsForOpening(o.id, isDeskWide(user) ? undefined : user.id).map((s) => ({
        recruiter: users.get(s.taId) ?? s.taId,
        set: s.setNumber,
        people: s.count,
        // The 28 Sep rule (convex/lib/sets.ts): open across days until five or
        // more are sent in one Colombo day. "Under 5" said otherwise.
        status: s.status === "open" ? "still open (closes on a day five or more are sent)" : "closed",
      })),
      shortlistedToday: apps.filter((a) => (a.shortlistedAt ?? 0) >= today).length,
      followUps,
      withDirector: people(["director_review"]),
      directorShortlist: people(["director_shortlist"]),
      clientShortlist: people(["client_shortlist"]),
      offers: people(["offer"]),
      interviews,
      // A colleague's shortlisted people: named so they are not approached
      // twice, and nothing more — no number, no email, no link (12 Sep wall).
      shortlistedByOthers: taken.slice(0, 25).map((t) => ({ name: nameOf(t.row.candidateId), shortlistedBy: users.get(t.takenBy) ?? "another recruiter", stage: STAGE_LABEL[t.row.stage] })),
    };
  });

  // A name in the question: look for that person in this person's own view.
  const asked = v.asked;
  const nameMatches = (candidateId: string) => {
    const c = repo.candidate(candidateId);
    return !!c && words(c.fullName).some((w) => w.length > 3 && asked.includes(w));
  };
  const nameHits = asked.length
    ? [
        ...v.scoped.flatMap(({ o, own }) =>
          own.filter((a) => nameMatches(a.candidateId)).map((a) => {
            const c = repo.candidate(a.candidateId)!;
            return {
              name: c.fullName,
              phone: c.phone,
              email: c.email,
              opening: o.title,
              stage: STAGE_LABEL[a.stage],
              owner: users.get(a.ownerTaId ?? "") ?? null,
              link: `/openings/${o.id}/candidate/${a.id}`,
            };
          }),
        ),
        ...v.scoped.flatMap(({ o, taken }) =>
          taken.filter((t) => nameMatches(t.row.candidateId)).map((t) => ({
            name: repo.candidate(t.row.candidateId)!.fullName,
            opening: o.title,
            stage: STAGE_LABEL[t.row.stage],
            shortlistedBy: users.get(t.takenBy) ?? "another recruiter",
          })),
        ),
      ].slice(0, 10)
    : [];

  return {
    now: when(now),
    // "As of 10:42" — the numbers below were read at this minute (6 Oct).
    asOf: new Date(now).toLocaleTimeString("en-GB", { timeZone: "Asia/Colombo", hour: "2-digit", minute: "2-digit" }),
    you: roleBrief(user),
    openings: out,
    ...(v.notDetailed > 0 ? { openingsWithoutDetail: v.notDetailed } : {}),
    peopleNamedInQuestion: nameHits,
    yourAlerts: alertsFor(user.id, now).slice(0, 15).map((a) => ({ detail: a.detail, action: a.action, urgent: a.urgent, link: a.href })),
  };
}

/*
 * 6 Oct: the prompt told the model everyone was "a member of the TA desk",
 * stated the 25 Sep set rule, and never said what the asker may do. Who is
 * asking, and what their role allows, now comes in the snapshot (`you`).
 */
export const SYSTEM = [
  "You are the desk assistant inside Career141's TA System. You work from the live records in the JSON snapshot, read at `asOf` (Colombo time).",
  "",
  "Who you are talking to is `you` in the snapshot: their name, role, what they see, `canDo` and `cannotDo`.",
  "- Only tell them to do things in `canDo`. If they ask about something in `cannotDo`, say plainly who can (a TA Lead, Director, Ops or Admin; a client seat reads its shortlist only).",
  "- A TA sees their own candidates and the unclaimed pool on the jobs they are on. A colleague's candidate appears only in `shortlistedByOthers` or `peopleNamedInQuestion` with `shortlistedBy`: say it is shortlisted by that person and to leave it alone. Never give a number or email for it, and never say more than the snapshot holds.",
  "- A TA Lead, Director, Ops or Admin sees the whole desk. If `openingsWithoutDetail` is set, say names are shown for the most active jobs only, and how many more there are.",
  "",
  "Answering:",
  "- Desk questions: count from the snapshot only. Never invent names, numbers, dates or stages. A name shown as \"name not loaded\" is said that way. When you give counts, say \"as of <asOf>\".",
  "- How-to questions: use the Platform Guide below, and only describe what it says the system does.",
  "- When something needs attention — an alert, a follow-up with `needsPerson`, a set still open, a JD waiting for approval (`jdLink`), people waiting for review — give the exact `link` from the snapshot as a markdown link and the one next step.",
  "- Plain words: 'follow-up' not 'follow_up', 'new CV' not 'new_cv'.",
  "- Sets: numbered per recruiter per job. A set stays open across days until five or more CVs are sent in one Colombo day; that day closes it however many went, and the next day starts the next set.",
  "- A strong match has a fit score of 70+.",
  "- Waiting for review means new CVs plus database matches nobody has claimed yet.",
  "- Be brief: at most 6 short lines or bullets. No greeting, no closing offer of more help.",
  "- Link only to pages in the guide's page list, or to a `link`/`jdLink` value in the snapshot. Never make up a page address; if a page belongs to one opening and you have no link for it, say where to find it on that opening.",
  "- You only read and propose. You never make a change yourself: a change typed as an instruction comes back as a proposal the person confirms.",
  "",
  PLATFORM_KNOWLEDGE,
].join("\n");

export type ModelCall = (system: string, prompt: string) => Promise<AiResult>;

export async function askDesk(
  user: User,
  question: string,
  history: AssistantTurn[] = [],
  call: ModelCall = (s, p) => write(s, p, 1200, "assist"),
): Promise<{ ok: true; answer: string; instant: boolean } | { ok: false; reason: string }> {
  const q = question.trim().slice(0, 600);
  if (!q) return { ok: false, reason: "empty" };
  const snapshot = snapshotFor(user, q);
  // The everyday questions are answered from the numbers directly — no model,
  // no wait, no cost. Anything else goes to the model with the same snapshot.
  const quick = history.length === 0 ? quickAnswer(snapshot, q, user) : null;
  if (quick) return { ok: true, answer: quick, instant: true };
  const convo = history
    .slice(-6)
    .map((t) => `${t.role === "user" ? "Them" : "Assistant"}: ${t.text.slice(0, 800)}`)
    .join("\n");
  const prompt = [
    "Snapshot:",
    JSON.stringify(snapshot),
    convo ? `\nEarlier in this conversation:\n${convo}` : "",
    `\nQuestion: ${q}`,
  ].join("\n");
  const r = await call(SYSTEM, prompt);
  if (!r.ok) {
    // The reason alone ("bad_response") hid a 404 from the provider for weeks.
    console.error(`[desk assistant] model call failed: ${r.reason}${"detail" in r && r.detail ? ` — ${String(r.detail).slice(0, 300)}` : ""}`);
    return { ok: false, reason: r.reason };
  }
  return { ok: true, answer: onlyRealLinks(r.text.trim()), instant: false };
}

/**
 * Page addresses in this app. A link the model writes that is not one of these
 * is shown as plain text, so the Copilot never sends someone to a page that
 * does not exist — the one navigation mistake a prompt alone cannot rule out.
 */
const REAL_PAGE = [
  /^\/$/,
  /^\/(clients|openings|database|alerts|reports|people|intake|search|bin|review|voice)$/,
  /^\/review\/[a-z0-9_]+$/,
  /^\/openings\/new$/,
  /^\/database\/(results|scan)$/,
  /^\/candidates\/[a-z0-9_]+$/,
  /^\/openings\/[a-z0-9_]+$/,
  /^\/openings\/[a-z0-9_]+\/(jd|eod|database|linkedin-job|snippets|reference|scoops|hh|hh\/(suggestions|links|research))$/,
  /^\/openings\/[a-z0-9_]+\/pipeline\/[a-z_]+$/,
  /^\/openings\/[a-z0-9_]+\/candidate\/[a-z0-9_]+$/,
];

export function onlyRealLinks(answer: string): string {
  return answer.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (whole, label: string, href: string) => {
    if (/^https?:\/\//i.test(href)) return whole;
    const path = href.split(/[?#]/)[0];
    return REAL_PAGE.some((re) => re.test(path)) ? whole : label;
  });
}

type Snapshot = ReturnType<typeof snapshotFor>;

/**
 * Answers the questions a TA asks every day straight from the snapshot:
 * CVs today, follow-ups with numbers, sets, interviews, alerts. Returns null
 * for anything else, or when the question names a job this person cannot see.
 */
export function quickAnswer(snap: Snapshot, question: string, user: User): string | null {
  // Check common platform guide & workflow questions first
  const workflowHelp = quickWorkflowHelp(question);
  if (workflowHelp) return workflowHelp;

  const q = question.toLowerCase();
  // Desk shorthand for job titles: "EHS" is Environment, Health and Safety.
  const expanded = q.replace(/\b(ehs|hse|ohs)\b/g, "environment health safety").replace(/\bba\b/g, "business analyst").replace(/\bqa\b/g, "quality assurance").replace(/\bscm\b/g, "supply chain");
  const asked = new Set(words(expanded).filter((w) => !COMMON.has(w)));
  const named = snap.openings.filter((o) => words(`${o.title} ${o.client ?? ""}`).some((w) => !COMMON.has(w) && asked.has(w)));
  // The question names a job or client that exists but is not theirs: step
  // aside, rather than answer with their own numbers as if it were.
  const inScope = new Set(snap.openings.map((o) => o.id));
  const clientNames = new Map(repo.clients().map((c) => [c.id, c.name]));
  const namesOther = repo
    .openings()
    .filter((o) => !inScope.has(o.id))
    .some((o) => words(`${o.title} ${clientNames.get(o.clientId) ?? ""}`).some((w) => !COMMON.has(w) && !INTENT_WORDS.has(w) && asked.has(w)));
  if (named.length === 0 && namesOther) return null;
  const scope = named.length ? named : snap.openings;
  if (scope.length === 0) return "You're not on any open jobs right now.";
  const link = (o: Snapshot["openings"][number]) => `[${o.title}](${o.link})`;
  const detail = scope.filter((o): o is Extract<typeof o, { followUps: unknown }> => "followUps" in o);
  // A desk-wide person's whole-desk question names people on their most
  // active jobs only; say so, rather than let the list pass for everything.
  const hidden = "openingsWithoutDetail" in snap ? snap.openingsWithoutDetail ?? 0 : 0;
  const more = hidden ? `Names shown for your ${detail.length} most active jobs; ${hidden} more not shown — name a job to see it.` : "";
  const asOf = ` (as of ${snap.asOf})`;

  if (/\b(cv|cvs|applica\w*|applicants?)\b/.test(q) && /\b(today|so far)\b/.test(q)) {
    const total = scope.reduce((n, o) => n + o.cvsToday, 0);
    return [`${total} CV${total === 1 ? "" : "s"} today${asOf}.`, ...scope.map((o) => `- ${link(o)}: ${o.cvsToday}`)].join("\n");
  }
  if (/\b(cv|cvs|applica\w*|applicants?)\b/.test(q) && /\b(week|7 days|seven days)\b/.test(q)) {
    return [`CVs in the last 7 days${asOf}:`, ...scope.map((o) => `- ${link(o)}: ${o.cvsLast7Days}`)].join("\n");
  }
  if (/follow.?ups?/.test(q)) {
    if (detail.length === 0) return null;
    let rows = detail.flatMap((o) => o.followUps.map((f) => ({ o, f })));
    // "still need expected salary", "missing notice": narrow to what they asked about.
    if (/\b(need|needs|missing|without|haven'?t|not got|outstanding)\b/.test(q)) {
      const topics = [["expected", "expected"], ["current", "current"], ["notice", "notice"], ["salary", "salary"]].filter(([w]) => q.includes(w)).map(([, t]) => t);
      if (topics.length === 0) rows = rows.filter(({ f }) => f.stillMissing.length > 0);
      else rows = rows.filter(({ f }) => f.stillMissing.some((m) => topics.every((t) => m.toLowerCase().includes(t))));
      if (rows.length === 0) return "Nobody in follow-up is missing that.";
    }
    if (rows.length === 0) return [`Nobody is in follow-up on ${scope.length === 1 ? link(scope[0]) : "your jobs"} right now.`, more].filter(Boolean).join("\n");
    const needYou = rows.filter(({ f }) => f.needsPerson).length;
    return [
      `${rows.length} in follow-up${asOf}:`,
      ...rows.slice(0, 30).map(({ o, f }) =>
        `- [${f.name}](${f.link}) — ${f.phone ?? "no number"} · ${o.title}${f.stillMissing.length ? ` · still need ${f.stillMissing.join(", ").toLowerCase()}` : " · everything in"}${f.needsPerson ? " · needs you" : ""}`,
      ),
      rows.length > 30 ? `…and ${rows.length - 30} more.` : "",
      // The next step, where a person is needed: the call tab is linked above.
      needYou ? `${needYou} need${needYou === 1 ? "s" : ""} you — open the name to call and record the answer.` : "",
      more,
    ].filter(Boolean).join("\n");
  }
  if (/\bdirector\b/.test(q)) {
    if (detail.length === 0) return null;
    const rows = detail.flatMap((o) => o.withDirector.map((p) => ({ o, p })));
    if (rows.length === 0) return ["Nobody is waiting on the Director.", more].filter(Boolean).join("\n");
    const jobs = detail.filter((o) => o.withDirector.length > 0);
    return [`${rows.length} with the Director, on ${jobs.length} job${jobs.length === 1 ? "" : "s"}:`, ...jobs.map((o) => `- ${link(o)}: ${o.withDirector.map((p) => `[${p.name}](${p.link})`).join(", ")}`), more].filter(Boolean).join("\n");
  }
  if (/\bclient\b/.test(q) && /\b(shortlist\w*|waiting|with)\b/.test(q)) {
    if (detail.length === 0) return null;
    const jobs = detail.filter((o) => o.clientShortlist.length > 0);
    if (jobs.length === 0) return ["Nobody is on a client shortlist right now.", more].filter(Boolean).join("\n");
    return ["On client shortlists:", ...jobs.map((o) => `- ${link(o)}: ${o.clientShortlist.map((p) => `[${p.name}](${p.link})`).join(", ")}`), more].filter(Boolean).join("\n");
  }
  if (/\boffers?\b/.test(q)) {
    if (detail.length === 0) return null;
    const jobs = detail.filter((o) => o.offers.length > 0);
    if (jobs.length === 0) return ["No offers out right now.", more].filter(Boolean).join("\n");
    return ["Offers out:", ...jobs.map((o) => `- ${link(o)}: ${o.offers.map((p) => `[${p.name}](${p.link})`).join(", ")}`), more].filter(Boolean).join("\n");
  }
  if (/shortlist\w*/.test(q) && /\btoday\b/.test(q)) {
    if (detail.length === 0) return null;
    const total = detail.reduce((n, o) => n + o.shortlistedToday, 0);
    return [`${total} shortlisted today.`, ...detail.map((o) => `- ${link(o)}: ${o.shortlistedToday}`)].join("\n");
  }
  // Counting and comparing are done here, exactly — the live test (13 September)
  // found the model added 23 + 30 + … to "30" and called a nine-way tie "the most".
  const withMatches = detail.filter((o) => "databaseMatches" in o) as (typeof detail[number] & { databaseMatches: { total: number; strong: number; unclaimed: number; top: { name: string; fitScore: number | null; currentTitle: string | null; employer: string | null; years: number | null; qualifications: string[]; link: string }[] }; waitingForReview: { newCvs: number; databaseMatches: number } })[];
  if (/\b(waiting|to review|need(?:s)? review|review queue|unreviewed)\b/.test(q) && withMatches.length) {
    const rows = withMatches.map((o) => ({ o, n: o.waitingForReview.newCvs + o.waitingForReview.databaseMatches })).filter((r) => r.n > 0);
    const total = rows.reduce((n, r) => n + r.n, 0);
    if (total === 0) return "Nobody is waiting for review.";
    return [`${total} waiting for review${asOf}${scope.length > 1 ? ` across ${rows.length} job${rows.length === 1 ? "" : "s"}` : ""}:`, ...rows.sort((x, y) => y.n - x.n).map((r) => `- ${link(r.o)}: ${r.n} (${r.o.waitingForReview.newCvs} new CVs, ${r.o.waitingForReview.databaseMatches} database matches)`)].join("\n");
  }
  const QUALS_ASKED = [...question.matchAll(/\b(ACCA|FCCA|CIMA|ACMA|CGMA|ACA|FCA|CPA|CFA|NEBOSH|IOSH|CIPS|CIPD|CIPM|ISMM|PMP|MBA|SLIM|CIM|AAT|Six Sigma)\b/gi)].map((m) => m[1].toLowerCase());
  const QUAL_ASKED = QUALS_ASKED.length ? QUALS_ASKED.map((x) => x.toUpperCase()).join(" or ") : null;
  if ((/\bmatch(?:es|ed)?\b/.test(q) || (QUALS_ASKED.length > 0 && named.length > 0)) && withMatches.length) {
    const strongOnly = /\bstrong\b/.test(q);
    const count = (o: (typeof withMatches)[number]) => (strongOnly ? o.databaseMatches.strong : o.databaseMatches.total);
    const what = strongOnly ? "strong matches" : "database matches";
    if (QUAL_ASKED) {
      const seen = new Set<string>();
      const rows = withMatches
        .flatMap((o) => o.databaseMatches.top.filter((m) => m.qualifications.some((x) => QUALS_ASKED.includes(x.toLowerCase()))).map((m) => ({ o, m })))
        // The same person imported twice shows once.
        .filter(({ o, m }) => (seen.has(`${o.id}|${m.name.toLowerCase()}`) ? false : (seen.add(`${o.id}|${m.name.toLowerCase()}`), true)));
      if (rows.length === 0) return `None of the top matches${scope.length === 1 ? ` on ${link(scope[0])}` : ""} show ${QUAL_ASKED} in their CV.`;
      return [`${rows.length} of the top matches show ${QUAL_ASKED} in their CV:`, ...rows.map(({ o, m }) => `- [${m.name}](${m.link}) — ${m.currentTitle ?? "title not read"}${m.employer ? ` at ${m.employer}` : ""}, fit ${m.fitScore ?? "—"} · ${m.qualifications.filter((x) => QUALS_ASKED.includes(x.toLowerCase())).join(", ")}${scope.length > 1 ? ` · ${o.title}` : ""}`)].join("\n");
    }
    const topN = q.match(/\btop\s+(\d{1,2})\b/)?.[1] ?? (/\b(best|top)\b/.test(q) ? "5" : null);
    if (topN && withMatches.length === 1) {
      const o = withMatches[0];
      const top = o.databaseMatches.top.slice(0, Number(topN));
      if (top.length === 0) return `No database matches on ${link(o)} yet.`;
      return [`Top ${top.length} on ${link(o)}:`, ...top.map((m, i) => `${i + 1}. [${m.name}](${m.link}) — fit ${m.fitScore ?? "—"} · ${m.currentTitle ?? "title not read"}${m.employer ? ` at ${m.employer}` : ""}${m.years != null ? ` · ${Math.round(m.years)} yrs` : ""}${m.qualifications.length ? ` · ${m.qualifications.join(", ")}` : ""}`)].join("\n");
    }
    const cmp = q.match(/\b(fewer than|less than|under|below|more than|over|above|at least)\s+(\d{1,4})\b/);
    if (cmp) {
      const n = Number(cmp[2]);
      const test = /fewer|less|under|below/.test(cmp[1]) ? (x: number) => x < n : cmp[1] === "at least" ? (x: number) => x >= n : (x: number) => x > n;
      const rows = withMatches.filter((o) => test(count(o)));
      if (rows.length === 0) return `No job has ${cmp[1]} ${n} ${what}.`;
      return [`${rows.length} job${rows.length === 1 ? "" : "s"} with ${cmp[1]} ${n} ${what}:`, ...rows.map((o) => `- ${link(o)}: ${count(o)}`)].join("\n");
    }
    if (/\b(most|fewest|least|highest|lowest)\b/.test(q)) {
      const fewest = /\b(fewest|least|lowest)\b/.test(q);
      const best = fewest ? Math.min(...withMatches.map(count)) : Math.max(...withMatches.map(count));
      const tied = withMatches.filter((o) => count(o) === best);
      return tied.length === 1
        ? `${link(tied[0])} has the ${fewest ? "fewest" : "most"} ${what}: ${best}.`
        : `${tied.length} jobs tie on ${best} ${what}: ${tied.map(link).join(", ")}.`;
    }
    if (/\bhow many\b/.test(q) || withMatches.length > 1) {
      const total = withMatches.reduce((n, o) => n + o.databaseMatches.total, 0);
      const strong = withMatches.reduce((n, o) => n + o.databaseMatches.strong, 0);
      if (withMatches.length === 1) return `${link(withMatches[0])}: ${total} database matches, ${strong} strong (fit ${FIT_BANDS.strong}+).`;
      return [`${total} database matches across ${withMatches.length} jobs, ${strong} strong (fit ${FIT_BANDS.strong}+):`, ...withMatches.map((o) => `- ${link(o)}: ${o.databaseMatches.total} (${o.databaseMatches.strong} strong)`)].join("\n");
    }
  }
  if (named.length === 1 && /\b(how many|status|pipeline|where are we|how is|how's|stages?)\b/.test(q)) {
    const o = named[0];
    const parts = Object.entries(o.byStage).filter(([, n]) => n > 0).map(([stage, n]) => `${stage} ${n}`);
    // A JD still waiting is the next step on the job, so it is linked (6 Oct).
    const jd = "jdLink" in o && o.jdLink ? `JD waiting for approval — [open the JD](${o.jdLink}).` : `JD ${o.jd}.`;
    return `${link(o)}${o.client ? ` (${o.client})` : ""}: ${parts.length ? parts.join(" · ") : "nobody yet"}. ${o.cvsToday} CV${o.cvsToday === 1 ? "" : "s"} today, ${o.cvsLast7Days} this week${asOf}. ${jd}`;
  }
  if (/\bsets?\b/.test(q)) {
    if (detail.length === 0) return null;
    const lines = detail.flatMap((o) =>
      o.sets.length === 0
        ? [`- ${link(o)}: no sets yet`]
        : o.sets.map((st) => `- ${link(o)}: ${isDeskWide(user) ? `${st.recruiter}'s ` : ""}set ${st.set} — ${st.people} ${st.people === 1 ? "person" : "people"}, ${st.status.startsWith("still") ? "still open" : "closed"}`),
    );
    const open = detail.some((o) => o.sets.some((st) => st.status.startsWith("still")));
    // The 28 Sep rule, said where it matters: an open set is not "under five".
    return ["Sets:", ...lines, open ? "An open set closes on a day five or more CVs are sent." : "", more].filter(Boolean).join("\n");
  }
  if (/\binterviews?\b/.test(q)) {
    if (detail.length === 0) return null;
    const rows = detail.flatMap((o) => o.interviews.map((i) => ({ o, i })));
    if (rows.length === 0) return ["No interviews coming up.", more].filter(Boolean).join("\n");
    return [`${rows.length} interview${rows.length === 1 ? "" : "s"}:`, ...rows.map(({ o, i }) => `- [${i.name}](${i.link}) · ${i.at} · ${o.title} · ${i.confirmed ? "confirmed" : "not confirmed yet"}`), more].filter(Boolean).join("\n");
  }
  if (/\b(alerts?|urgent|overdue)\b/.test(q)) {
    if (snap.yourAlerts.length === 0) return "Nothing needs you right now.";
    return [`${snap.yourAlerts.length} thing${snap.yourAlerts.length === 1 ? "" : "s"} need you:`, ...snap.yourAlerts.map((a) => `- ${a.urgent ? "Urgent: " : ""}[${a.detail}](${a.link})`)].join("\n");
  }
  return null;
}

const COMMON = new Set(["the", "and", "for", "how", "many", "what", "who", "whos", "where", "are", "is", "my", "me", "any", "with", "give", "names", "name", "numbers", "number", "today", "came", "come", "there", "have", "has", "get", "show", "list", "all", "our", "your", "manager", "executive", "officer", "head", "senior"]);
const INTENT_WORDS = new Set(["cv", "cvs", "applications", "applicants", "follow", "followup", "sets", "set", "interview", "interviews", "alerts", "urgent", "overdue", "role", "job", "position", "opening", "week", "days", "phone", "contact", "call", "coming", "far"]);

/** Only links inside the platform survive; anything else is shown as text. */
export function safeLinks(markdown: string): { text: string; href?: string }[] {
  const parts: { text: string; href?: string }[] = [];
  const re = /\[([^\]]{1,120})\]\(([^)\s]{1,300})\)/g;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(markdown))) {
    if (m.index > last) parts.push({ text: markdown.slice(last, m.index) });
    // Models sometimes put a host in front of an internal path ("https://example.com/openings/…").
    // Keep the path, never the host.
    const inner = m[2].match(/(\/(?:openings|candidates|database|reports|people|clients|review|hh|alerts)(?:\/[^\s)]*)?)/);
    const href = m[2].startsWith("/") ? m[2] : inner ? inner[1] : m[2];
    parts.push(href.startsWith("/") && !href.startsWith("//") ? { text: m[1], href } : { text: m[1] });
    last = m.index + m[0].length;
  }
  if (last < markdown.length) parts.push({ text: markdown.slice(last) });
  return parts;
}
