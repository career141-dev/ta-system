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
import { STAGE_LABEL, type Stage, type User } from "@/data/types";
import { isDeskWide } from "./auth";
import { colomboDayStart } from "./calendar";
import { alertsFor } from "./sla";
import { seatFor, visibleToSeat } from "./visibility";
import { write, type AiResult } from "./ai";
import { assess } from "./assessment";
import { FIT_BANDS } from "./scoring";

const DAY = 86_400_000;
const when = (t: number) =>
  new Date(t).toLocaleString("en-GB", { timeZone: "Asia/Colombo", weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });

export type AssistantTurn = { role: "user" | "assistant"; text: string };

/** Words in the question that could name a job, a client or a person. */
function words(q: string) {
  return q.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 2);
}

/**
 * Everything the assistant may say about, for this person, right now.
 *
 * Detail — names, numbers, follow-up state — is included for every opening
 * when there are few, and only for the openings the question mentions when a
 * desk-wide person has many, so the snapshot stays small and quick.
 */
export function snapshotFor(user: User, question: string, now = Date.now()) {
  const today = colomboDayStart(now);
  const weekAgo = today - 6 * DAY;
  const users = new Map(repo.users().map((u) => [u.id, u.name]));
  const clients = new Map(repo.clients().map((c) => [c.id, c.name]));
  const openings = repo.openingsForUser(user).filter((o) => o.status === "open" || o.status === "on_hold");
  const asked = words(question);
  const mentions = (text: string) => words(text).some((w) => asked.includes(w));
  const detailFor = (o: (typeof openings)[number]) =>
    openings.length <= 8 ||
    mentions(`${o.title} ${clients.get(o.clientId) ?? ""}`) ||
    (!isDeskWide(user) && o.assignedTaIds.includes(user.id));

  const followUpsByOpening = new Map<string, ReturnType<typeof repo.followUps>>();
  for (const f of repo.followUps(now)) {
    const list = followUpsByOpening.get(f.opening.id) ?? [];
    list.push(f);
    followUpsByOpening.set(f.opening.id, list);
  }

  const out = openings.map((o) => {
    const assignment = repo.assignmentFor(o.id, user.id) ?? null;
    const seat = seatFor(user, assignment?.role ?? null);
    const apps = visibleToSeat(repo.applications(o.id), seat);
    const counts = stageCounts(o.id);
    const visibleStages = new Set(apps.map((a) => a.stage));
    const applied = apps.filter((a) => a.sourcingChannel !== "SCOOP");
    const base = {
      id: o.id,
      title: o.title,
      client: clients.get(o.clientId) ?? null,
      status: o.status,
      jd: o.jdStatus === "approved" ? "approved" : "waiting for approval",
      recruiters: o.assignedTaIds.map((t) => users.get(t) ?? t),
      cvsToday: applied.filter((a) => a.createdAt >= today).length,
      cvsLast7Days: applied.filter((a) => a.createdAt >= weekAgo).length,
      byStage: Object.fromEntries(
        (Object.keys(counts) as Stage[]).filter((s) => visibleStages.has(s)).map((s) => [STAGE_LABEL[s], apps.filter((a) => a.stage === s).length]),
      ),
      link: `/openings/${o.id}`,
    };
    // Names and numbers only for someone who sees the whole pipeline — a TA,
    // lead, director or ops. A client seat gets counts of its own shortlist.
    if (!detailFor(o) || seat.stages !== null) return base;

    const candidate = (id: string) => repo.candidate(id);
    const followUps = (followUpsByOpening.get(o.id) ?? [])
      .filter((f) => isDeskWide(user) || f.application.ownerTaId === user.id || o.assignedTaIds.includes(user.id))
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
        name: candidate(a.candidateId)?.fullName ?? null,
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
          name: candidate(a.candidateId)?.fullName ?? null,
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
    const matchApps = apps.filter((a) => a.stage === "matched").map((a) => ({ a, c: candidate(a.candidateId) })).filter((x) => x.c);
    const assessed = assess(o.id, matchApps.map((x) => x.c!));
    const scores = assessed.ok
      ? new Map([...assessed.scores].map(([id, s]) => [id, s.overall]))
      : new Map<string, number>();
    const matched = matchApps
      .map(({ a, c }) => ({ a, c, fit: scores.get(c!.id) ?? NaN }))
      .sort((x, y) => (Number.isNaN(y.fit) ? 0 : y.fit) - (Number.isNaN(x.fit) ? 0 : x.fit));
    const databaseMatches = {
      // Which rules produced the fit scores, or why there are none.
      assessment: assessed.ok ? { version: assessed.version } : { unavailable: assessed.message },
      total: matched.length,
      strong: matched.filter((x) => x.fit >= FIT_BANDS.strong).length,
      unclaimed: matched.filter((x) => !x.a.ownerTaId).length,
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
      posts: repo.jobPosts(o.id).map((p) => ({ title: p.title, status: p.status, cvsToday: p.cvCountToday, owner: users.get(p.assignedTaId ?? "") ?? null })),
      sets: setsForOpening(o.id, isDeskWide(user) ? undefined : user.id, now).map((s) => ({
        recruiter: users.get(s.taId) ?? s.taId,
        set: s.setNumber,
        people: s.count,
        status: s.status === "open" ? "still open (under 5 before today)" : "closed",
      })),
      shortlistedToday: apps.filter((a) => (a.shortlistedAt ?? 0) >= today).length,
      followUps,
      withDirector: people(["director_review"]),
      directorShortlist: people(["director_shortlist"]),
      clientShortlist: people(["client_shortlist"]),
      offers: people(["offer"]),
      interviews,
    };
  });

  // A name in the question: look for that person on the openings in scope.
  const nameHits = asked.length
    ? openings
        .flatMap((o) => {
          const assignment = repo.assignmentFor(o.id, user.id) ?? null;
          return visibleToSeat(repo.applications(o.id), seatFor(user, assignment?.role ?? null)).map((a) => ({ a, o }));
        })
        .map(({ a, o }) => ({ a, o, c: repo.candidate(a.candidateId) }))
        .filter(({ c }) => c && words(c.fullName).some((w) => w.length > 3 && asked.includes(w)))
        .slice(0, 10)
        .map(({ a, o, c }) => ({
          name: c!.fullName,
          phone: c!.phone,
          email: c!.email,
          opening: o.title,
          stage: STAGE_LABEL[a.stage],
          owner: users.get(a.ownerTaId ?? "") ?? null,
          link: `/openings/${o.id}/candidate/${a.id}`,
        }))
    : [];

  return {
    now: when(now),
    you: { name: user.name, role: user.role },
    openings: out,
    peopleNamedInQuestion: nameHits,
    yourAlerts: alertsFor(user.id, now).slice(0, 15).map((a) => ({ detail: a.detail, action: a.action, urgent: a.urgent, link: a.href })),
  };
}

const SYSTEM = [
  "You are the assistant inside Career141's recruitment platform, answering a member of the TA desk.",
  "Answer ONLY from the JSON snapshot you are given. If the snapshot does not contain the answer, say you can't see that and suggest where on the platform to look.",
  "Never invent names, numbers, phone numbers or dates. Count from the snapshot.",
  "Be brief: a sentence or a short list. Use the person's words, not the system's (say 'follow-up', not 'follow_up').",
  "When you mention an opening or a person, link it with markdown using the snapshot's link, e.g. [Brand Manager](/openings/op_brand).",
  "Sets are numbered per recruiter; a set stays open until a day it reaches five.",
  "When listing jobs or people, include only those the snapshot shows with a count above zero for what was asked.",
  "Never assume anyone's gender: use the person's name, or 'they'.",
  "Never mention the snapshot's field names (like byStage or databaseMatches); describe things in plain words.",
  "Use each link exactly as the snapshot gives it, starting with /openings/.",
  `A strong match is a fit score of ${FIT_BANDS.strong} or more. Qualifications listed for a match were found in their CV.`,
  "People waiting for review means new CVs plus database matches nobody has claimed yet; add them up across jobs.",
  "When several jobs tie on a count, say they tie rather than naming one.",
].join("\n");

export type ModelCall = (system: string, prompt: string) => Promise<AiResult>;

export async function askDesk(
  user: User,
  question: string,
  history: AssistantTurn[] = [],
  call: ModelCall = (s, p) => write(s, p, 900, "assist"),
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
    .map((t) => `${t.role === "user" ? "TA" : "Assistant"}: ${t.text.slice(0, 800)}`)
    .join("\n");
  const prompt = [
    "Snapshot:",
    JSON.stringify(snapshot),
    convo ? `\nEarlier in this conversation:\n${convo}` : "",
    `\nQuestion: ${q}`,
  ].join("\n");
  const r = await call(SYSTEM, prompt);
  if (!r.ok) return { ok: false, reason: r.reason };
  return { ok: true, answer: r.text.trim(), instant: false };
}

type Snapshot = ReturnType<typeof snapshotFor>;

/**
 * Answers the questions a TA asks every day straight from the snapshot:
 * CVs today, follow-ups with numbers, sets, interviews, alerts. Returns null
 * for anything else, or when the question names a job this person cannot see.
 */
export function quickAnswer(snap: Snapshot, question: string, user: User): string | null {
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

  if (/\b(cv|cvs|applica\w*|applicants?)\b/.test(q) && /\b(today|so far)\b/.test(q)) {
    const total = scope.reduce((n, o) => n + o.cvsToday, 0);
    return [`${total} CV${total === 1 ? "" : "s"} today.`, ...scope.map((o) => `- ${link(o)}: ${o.cvsToday}`)].join("\n");
  }
  if (/\b(cv|cvs|applica\w*|applicants?)\b/.test(q) && /\b(week|7 days|seven days)\b/.test(q)) {
    return [`CVs in the last 7 days:`, ...scope.map((o) => `- ${link(o)}: ${o.cvsLast7Days}`)].join("\n");
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
    if (rows.length === 0) return `Nobody is in follow-up on ${scope.length === 1 ? link(scope[0]) : "your jobs"} right now.`;
    return [
      `${rows.length} in follow-up:`,
      ...rows.slice(0, 30).map(({ o, f }) =>
        `- [${f.name}](${f.link}) — ${f.phone ?? "no number"} · ${o.title}${f.stillMissing.length ? ` · still need ${f.stillMissing.join(", ").toLowerCase()}` : " · everything in"}${f.needsPerson ? " · needs you" : ""}`,
      ),
      rows.length > 30 ? `…and ${rows.length - 30} more.` : "",
    ].filter(Boolean).join("\n");
  }
  if (/\bdirector\b/.test(q)) {
    if (detail.length === 0) return null;
    const rows = detail.flatMap((o) => o.withDirector.map((p) => ({ o, p })));
    if (rows.length === 0) return "Nobody is waiting on the Director.";
    const jobs = detail.filter((o) => o.withDirector.length > 0);
    return [`${rows.length} with the Director, on ${jobs.length} job${jobs.length === 1 ? "" : "s"}:`, ...jobs.map((o) => `- ${link(o)}: ${o.withDirector.map((p) => `[${p.name}](${p.link})`).join(", ")}`)].join("\n");
  }
  if (/\bclient\b/.test(q) && /\b(shortlist\w*|waiting|with)\b/.test(q)) {
    if (detail.length === 0) return null;
    const jobs = detail.filter((o) => o.clientShortlist.length > 0);
    if (jobs.length === 0) return "Nobody is on a client shortlist right now.";
    return ["On client shortlists:", ...jobs.map((o) => `- ${link(o)}: ${o.clientShortlist.map((p) => `[${p.name}](${p.link})`).join(", ")}`)].join("\n");
  }
  if (/\boffers?\b/.test(q)) {
    if (detail.length === 0) return null;
    const jobs = detail.filter((o) => o.offers.length > 0);
    if (jobs.length === 0) return "No offers out right now.";
    return ["Offers out:", ...jobs.map((o) => `- ${link(o)}: ${o.offers.map((p) => `[${p.name}](${p.link})`).join(", ")}`)].join("\n");
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
    return [`${total} waiting for review${scope.length > 1 ? ` across ${rows.length} job${rows.length === 1 ? "" : "s"}` : ""}:`, ...rows.sort((x, y) => y.n - x.n).map((r) => `- ${link(r.o)}: ${r.n} (${r.o.waitingForReview.newCvs} new CVs, ${r.o.waitingForReview.databaseMatches} database matches)`)].join("\n");
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
    return `${link(o)}${o.client ? ` (${o.client})` : ""}: ${parts.length ? parts.join(" · ") : "nobody yet"}. ${o.cvsToday} CV${o.cvsToday === 1 ? "" : "s"} today, ${o.cvsLast7Days} this week. JD ${o.jd}.`;
  }
  if (/\bsets?\b/.test(q)) {
    if (detail.length === 0) return null;
    const lines = detail.flatMap((o) =>
      o.sets.length === 0
        ? [`- ${link(o)}: no sets yet`]
        : o.sets.map((st) => `- ${link(o)}: ${isDeskWide(user) ? `${st.recruiter}'s ` : ""}set ${st.set} — ${st.people} ${st.people === 1 ? "person" : "people"}, ${st.status.startsWith("still") ? "still open" : "closed"}`),
    );
    return ["Sets:", ...lines].join("\n");
  }
  if (/\binterviews?\b/.test(q)) {
    if (detail.length === 0) return null;
    const rows = detail.flatMap((o) => o.interviews.map((i) => ({ o, i })));
    if (rows.length === 0) return "No interviews coming up.";
    return [`${rows.length} interview${rows.length === 1 ? "" : "s"}:`, ...rows.map(({ o, i }) => `- [${i.name ?? "Candidate"}](${i.link}) · ${i.at} · ${o.title} · ${i.confirmed ? "confirmed" : "not confirmed yet"}`)].join("\n");
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
    const inner = m[2].match(/(\/(?:openings|candidates|database|reports|people)\/[^\s)]*)/);
    const href = m[2].startsWith("/") ? m[2] : inner ? inner[1] : m[2];
    parts.push(href.startsWith("/") && !href.startsWith("//") ? { text: m[1], href } : { text: m[1] });
    last = m.index + m[0].length;
  }
  if (last < markdown.length) parts.push({ text: markdown.slice(last) });
  return parts;
}
