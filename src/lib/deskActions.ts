/**
 * Doing things from the Ask chat — with a confirm, always (13 September).
 *
 * The chat never changes anything on its own. A message that asks for a change
 * becomes a *proposal*: who, which job, exactly what will happen. The TA
 * presses Confirm, and only then does it run — through the same permission
 * checks and the same store functions as the buttons on the candidate screen.
 *
 * A proposal is signed by the server, names the person it was made for, runs
 * once, and expires after ten minutes. Everything is checked again when it runs,
 * because a lot can change between a proposal and a click: someone else may
 * have shortlisted the candidate, or the stage may have moved.
 */

import { repo } from "@/data/store";
import { STAGE_LABEL, type Application, type FollowUpCallOutcome, type Stage, type User } from "@/data/types";
import { can } from "./auth";
import { colomboDayStart } from "./calendar";
import { canMove } from "./pipeline";
import { seatFor, visibleToSeat } from "./visibility";
import { signText, verifyText } from "./sign";
import { write, type AiResult } from "./ai";

export type DeskAction =
  | { kind: "shortlist"; appId: string }
  | { kind: "move"; appId: string; stage: Stage; reason: string | null }
  | { kind: "note"; appId: string; text: string }
  | { kind: "answers"; appId: string; currentSalary: string | null; expectedSalary: string | null; noticeDays: number | null }
  | { kind: "call"; appId: string; outcome: FollowUpCallOutcome; promisedAt: number | null; note: string };

/** What a message asked for, before we know which application it means. */
export interface Intent {
  kind: DeskAction["kind"];
  name: string;
  job: string | null;
  stage?: Stage;
  reason?: string | null;
  text?: string;
  currentSalary?: string | null;
  expectedSalary?: string | null;
  noticeDays?: number | null;
  outcome?: FollowUpCallOutcome;
  when?: string | null;
}

export type Proposal = {
  token: string;
  summary: string;
  details: string[];
  link: string;
};

export type ActionReply =
  | { type: "proposal"; proposal: Proposal }
  | { type: "question"; text: string; choices?: string[] }
  | { type: "refusal"; text: string };

const TTL = 10 * 60_000;
const used = new Map<string, number>();

// ─── Reading the message ────────────────────────────────────────────────────

const ACTION_START = /^\s*(please\s+)?(shortlist|short-list|reject|decline|move|put|mark|note|add (a )?note|record|log|set|update|save|call back|callback|drop)\b/i;
const CALL_WORDS = /\b(didn'?t answer|did not answer|no answer|not answering|not interested|will send|call (him|her|them)? ?back|call back|callback|asked (us |me )?to call)\b/i;
const FIELD_WORDS = /\b(expected salary|current salary|notice( period)?)\b/i;

export function looksLikeAction(message: string): boolean {
  return ACTION_START.test(message) || CALL_WORDS.test(message) || (FIELD_WORDS.test(message) && /\b(is|=|:|of|\d)/i.test(message));
}

const STAGE_WORDS: [RegExp, Stage][] = [
  [/follow.?up/i, "follow_up"],
  [/director review|with the director|to the director/i, "director_review"],
  [/director shortlist/i, "director_shortlist"],
  [/client shortlist|to the client/i, "client_shortlist"],
  [/interview/i, "interview"],
  [/offer/i, "offer"],
  [/placed|joined/i, "placed"],
  [/reject/i, "rejected"],
  [/drop(ped)? ?out|withdr[ae]w/i, "dropped_out"],
];

/** Splits "Thisara Jayasuriya on Brand Manager" into the person and the job. */
function personAndJob(text: string): { name: string; job: string | null } {
  const m = text.match(/^(.+?)\s+(?:on|for|in|from)\s+(?:the\s+)?(.+?)(?:\s+(?:role|job|opening))?\s*$/i);
  return m ? { name: m[1].trim(), job: m[2].trim() } : { name: text.trim(), job: null };
}

/** The common ways a TA types a change, read with rules. Null when unsure. */
export function parseIntent(message: string): Intent | null {
  const msg = message.trim().replace(/[.!]+$/, "").replace(/^please\s+/i, "");

  let m = msg.match(/^(?:shortlist|short-list)\s+(.+)$/i);
  if (m) return { kind: "shortlist", ...personAndJob(m[1]) };

  m = msg.match(/^(?:reject|decline)\s+(.+?)(?:\s*(?:[—–:,-]|\bbecause\b|\breason\b:?|\bas\b)\s*(.+))?$/i);
  if (m) return { kind: "move", ...personAndJob(m[1]), stage: "rejected", reason: m[2]?.trim() || null };

  m = msg.match(/^(?:mark|move|put)\s+(.+?)\s+(?:as\s+)?(?:to|into|in|as)\s+(.+?)(?:\s*(?:[—–:,]|\bbecause\b)\s*(.+))?$/i);
  if (m) {
    const target = STAGE_WORDS.find(([re]) => re.test(m![2]))?.[1];
    if (target) return { kind: "move", ...personAndJob(m[1]), stage: target, reason: m[3]?.trim() || null };
  }
  m = msg.match(/^(.+?)\s+(?:dropped out|has dropped out|withdrew)(?:\s*(?:[—–:,-]|\bbecause\b)\s*(.+))?$/i);
  if (m) return { kind: "move", ...personAndJob(m[1]), stage: "dropped_out", reason: m[2]?.trim() || null };

  m = msg.match(/^(?:add (?:a )?note|note)\s+(?:(?:to|on|for)\s+)?(.+?)\s*[:—–-]\s*(.+)$/i);
  if (m) return { kind: "note", ...personAndJob(m[1]), text: m[2].trim() };

  // "Thisara expected salary 250k, notice 30 days" — one or more fields.
  if (FIELD_WORDS.test(msg)) {
    const first = msg.search(/\b(?:(?:record|set|update|save)\s+)?(?:his|her|their)?\s*(expected salary|current salary|notice)/i);
    const head = msg.slice(0, first).replace(/^(record|set|update|save)\s+/i, "").replace(/'s\s*$|\s+(?:has|is|with)\s*$/i, "").trim();
    const grab = (label: RegExp) => msg.match(new RegExp(`${label.source}\\s*(?:is|of|=|:)?\\s*((?:[^,;]|,(?=\\d))+?)(?=\\s*(?:,(?!\\d)|;|\\band\\b|$|\\b(?:expected|current|notice)\\b))`, "i"))?.[1]?.trim() ?? null;
    const expected = grab(/expected salary/);
    const current = grab(/current salary/);
    const noticeRaw = grab(/notice(?: period)?/);
    const noticeDays = noticeRaw ? noticeToDays(noticeRaw) : null;
    if (head && (expected || current || noticeDays !== null)) {
      return { kind: "answers", ...personAndJob(head), expectedSalary: expected, currentSalary: current, noticeDays };
    }
  }

  m = msg.match(/^(?:record\s+(?:that\s+)?|log\s+(?:that\s+)?)?(.+?)\s+(didn'?t answer|did not answer|no answer|isn'?t answering|not answering|is not interested|isn'?t interested|not interested)\b\s*(.*)$/i);
  if (m) {
    return {
      kind: "call", ...personAndJob(m[1]),
      outcome: /interest/i.test(m[2]) ? "not_interested" : "no_answer",
      text: m[3]?.replace(/^[—–:,-]\s*/, "").trim() || "",
    };
  }
  m = msg.match(/^(?:call\s+)?(.+?)\s+(?:back\s+)?(?:asked (?:us |me )?to call back|wants a call back|call back|callback)\s+(?:at\s+|on\s+)?(.+)$/i)
    ?? msg.match(/^call\s+(.+?)\s+back\s+(?:at\s+|on\s+)?(.+)$/i);
  if (m) return { kind: "call", ...personAndJob(m[1]), outcome: "callback", when: m[2].trim(), text: "" };
  m = msg.match(/^(.+?)\s+will send(?:\s+(?:it|the details|them))?\s+(?:by\s+|at\s+|on\s+)?(.+)$/i);
  if (m) return { kind: "call", ...personAndJob(m[1]), outcome: "will_send", when: m[2].trim(), text: "" };

  return null;
}

export function noticeToDays(text: string): number | null {
  const t = text.toLowerCase();
  if (/immediate|now|none|no notice/.test(t)) return 0;
  const n = Number(t.match(/\d+(?:\.\d+)?/)?.[0]);
  if (!Number.isFinite(n)) return null;
  if (/month/.test(t)) return Math.round(n * 30);
  if (/week/.test(t)) return Math.round(n * 7);
  return Math.round(n);
}

/**
 * "4pm", "tomorrow 10am", "Monday 9:30", "15 Sep 3pm" — Colombo time. Null when
 * it cannot be read, and the chat asks again rather than guessing a time.
 */
export function parseWhen(text: string, now = Date.now()): number | null {
  const t = text.toLowerCase().trim();
  const time = t.match(/(\d{1,2})(?::(\d{2}))?\s*(am|pm)?/);
  if (!time) return null;
  let hour = Number(time[1]);
  const minute = Number(time[2] ?? 0);
  if (time[3] === "pm" && hour < 12) hour += 12;
  if (time[3] === "am" && hour === 12) hour = 0;
  if (!time[3] && hour < 7) hour += 12; // "call at 3" on a desk means 3 in the afternoon
  if (hour > 23 || minute > 59) return null;

  let day = colomboDayStart(now);
  const DAY = 86_400_000;
  // A date first — "15 Sep 3pm" — so its day number is not read as the hour.
  const months = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
  const dated = t.match(/\b(\d{1,2})\s*(?:st|nd|rd|th)?\s+(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)\w*/);
  if (dated) {
    const year = new Date(now).getUTCFullYear();
    const d = Date.UTC(year, months.indexOf(dated[2]), Number(dated[1])) - 5.5 * 3_600_000;
    day = d < colomboDayStart(now) ? Date.UTC(year + 1, months.indexOf(dated[2]), Number(dated[1])) - 5.5 * 3_600_000 : d;
    const rest = t.replace(dated[0], " ");
    const tm = rest.match(/(\d{1,2})(?::(\d{2}))?\s*(am|pm)?/);
    if (!tm) return null;
    let h = Number(tm[1]);
    if (tm[3] === "pm" && h < 12) h += 12;
    if (tm[3] === "am" && h === 12) h = 0;
    if (!tm[3] && h < 7) h += 12;
    return h > 23 ? null : day + h * 3_600_000 + Number(tm[2] ?? 0) * 60_000;
  }
  if (/tomorrow/.test(t)) day += DAY;
  const weekdays = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];
  const wd = weekdays.findIndex((w) => t.includes(w) || t.includes(w.slice(0, 3) + " "));
  if (wd >= 0) {
    const todayWd = new Date(day + 5.5 * 3_600_000).getUTCDay();
    day += (((wd - todayWd + 7) % 7) || 7) * DAY;
  }
  const at = day + hour * 3_600_000 + minute * 60_000;
  // A bare time already past today means tomorrow.
  return at <= now && !/today/.test(t) && wd < 0 && !/tomorrow/.test(t) ? at + DAY : at;
}

// ─── Finding who they meant ─────────────────────────────────────────────────

type Hit = { app: Application; name: string; job: string };

function words(s: string) {
  return s.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 1);
}

/** Applications on this person's jobs whose candidate matches the name typed. */
/**
 * The people a name could refer to: everyone on the openings this person
 * can act on (narrowed to the named job when there is one). The desk loads
 * applications for everyone but candidate records only on request, so without
 * this the assistant could find nobody by name. The caller loads them.
 */
export function candidateIdsForIntent(user: User, job: string | null): string[] {
  const jobWords = job ? words(job) : [];
  const ids = new Set<string>();
  for (const o of repo.openingsForUser(user)) {
    if (jobWords.length && !jobWords.some((w) => words(`${o.title} ${repo.client(o.clientId)?.name ?? ""}`).includes(w))) continue;
    for (const a of repo.applications(o.id)) ids.add(a.candidateId);
    if (ids.size >= 3000) break;
  }
  return [...ids];
}

export function resolvePerson(user: User, name: string, job: string | null): Hit[] {
  const want = words(name);
  if (want.length === 0) return [];
  const jobWords = job ? words(job) : [];
  const hits: (Hit & { score: number })[] = [];
  for (const o of repo.openingsForUser(user)) {
    if (jobWords.length && !jobWords.some((w) => words(`${o.title} ${repo.client(o.clientId)?.name ?? ""}`).includes(w))) continue;
    const seat = seatFor(user, repo.assignmentFor(o.id, user.id)?.role ?? null);
    if (seat.stages !== null || !seat.canAct) continue;
    for (const a of visibleToSeat(repo.applications(o.id), seat)) {
      const c = repo.candidate(a.candidateId);
      if (!c) continue;
      const have = words(c.fullName);
      const matched = want.filter((w) => have.some((h) => h === w || (w.length >= 4 && h.startsWith(w))));
      if (matched.length === want.length) hits.push({ app: a, name: c.fullName, job: o.title, score: have.length === want.length ? 2 : 1 });
    }
  }
  const best = Math.max(0, ...hits.map((h) => h.score));
  return hits.filter((h) => h.score === best);
}

// ─── Checking, proposing, running ───────────────────────────────────────────

function check(user: User, action: DeskAction): { ok: true; app: Application } | { ok: false; message: string } {
  const app = repo.application(action.appId);
  if (!app) return { ok: false, message: "That candidate is no longer on that job." };
  const assignment = repo.assignmentFor(app.openingId, user.id) ?? null;
  const allowed = can(user, "opening.act", { openingId: app.openingId, assignment, ownerTaId: app.ownerTaId });
  if (!allowed.ok) return { ok: false, message: allowed.message };

  switch (action.kind) {
    case "shortlist":
      if (app.stage !== "new_cv" && app.stage !== "matched") {
        return { ok: false, message: `They're already in ${STAGE_LABEL[app.stage]}, so there's nothing to shortlist.` };
      }
      return { ok: true, app };
    case "move": {
      const decides = action.stage === "director_shortlist" ? "decide.director" : action.stage === "client_shortlist" ? "decide.client" : null;
      if (decides) {
        const verdict = can(user, decides, { openingId: app.openingId, assignment });
        if (!verdict.ok) return { ok: false, message: verdict.message };
      }
      const move = canMove(app.stage, action.stage, {
        hasInterview: repo.interviews(app.id).some((i) => i.outcome !== "cancelled"),
      });
      if (!move.ok) return { ok: false, message: move.message };
      return { ok: true, app };
    }
    case "call":
      if (app.stage !== "follow_up") return { ok: false, message: `They're in ${STAGE_LABEL[app.stage]}, not follow-up, so there's no follow-up call to record.` };
      return { ok: true, app };
    default:
      return { ok: true, app };
  }
}

function describe(action: DeskAction, hit: { name: string; job: string; app: Application }): { summary: string; details: string[] } {
  const where = `${hit.name} · ${hit.job} · now in ${STAGE_LABEL[hit.app.stage]}`;
  const time = (t: number | null) => (t ? new Date(t).toLocaleString("en-GB", { timeZone: "Asia/Colombo", weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }) : "");
  switch (action.kind) {
    case "shortlist":
      return { summary: `Shortlist ${hit.name} for ${hit.job}`, details: [where, "Moves them to Follow-up under your name, gives them a set number, and starts the follow-up (the AI call goes first)."] };
    case "move":
      return {
        summary: `Move ${hit.name} to ${STAGE_LABEL[action.stage]}`,
        details: [where, ...(action.reason ? [`Reason: ${action.reason}`] : [])],
      };
    case "note":
      return { summary: `Add a note to ${hit.name}`, details: [where, `“${action.text}”`] };
    case "answers":
      return {
        summary: `Save ${hit.name}'s details`,
        details: [
          where,
          ...(action.currentSalary ? [`Current salary: ${action.currentSalary}`] : []),
          ...(action.expectedSalary ? [`Expected salary: ${action.expectedSalary}`] : []),
          ...(action.noticeDays !== null ? [`Notice: ${action.noticeDays === 0 ? "immediate" : `${action.noticeDays} days`}`] : []),
        ],
      };
    case "call":
      return {
        summary:
          action.outcome === "no_answer" ? `Record that ${hit.name} didn't answer`
            : action.outcome === "not_interested" ? `Record that ${hit.name} isn't interested`
              : action.outcome === "callback" ? `Record a call-back for ${hit.name}`
                : `Record that ${hit.name} will send their details`,
        details: [
          where,
          ...(action.promisedAt ? [`${action.outcome === "callback" ? "Call back" : "Expected"}: ${time(action.promisedAt)} (Colombo)`] : []),
          ...(action.note ? [`Note: ${action.note}`] : []),
          action.outcome === "no_answer" ? "The follow-up moves on to WhatsApp and email." : "",
        ].filter(Boolean),
      };
  }
}

function token(user: User, action: DeskAction, now: number): string {
  const body = Buffer.from(JSON.stringify({ v: 1, uid: user.id, exp: now + TTL, action })).toString("base64url");
  return `${body}.${signText(body)}`;
}

/** Turns an understood intent into a proposal, a question back, or a plain no. */
export function propose(user: User, intent: Intent, now = Date.now()): ActionReply {
  const hits = resolvePerson(user, intent.name, intent.job);
  if (hits.length === 0) {
    return { type: "refusal", text: `I can't find “${intent.name}”${intent.job ? ` on ${intent.job}` : ""} among the candidates on your jobs.` };
  }
  if (hits.length > 1) {
    const verb = intent.kind === "shortlist" ? "Shortlist" : intent.kind === "note" ? "Add a note to" : intent.kind === "move" ? "Move" : "Update";
    return {
      type: "question",
      text: `There's more than one match — which one?`,
      choices: hits.slice(0, 6).map((h) => `${verb} ${h.name} on ${h.job}${intent.kind === "move" && intent.stage ? ` to ${STAGE_LABEL[intent.stage]}` : ""}`),
    };
  }
  const hit = hits[0];
  let action: DeskAction;
  switch (intent.kind) {
    case "shortlist":
      action = { kind: "shortlist", appId: hit.app.id };
      break;
    case "move":
      if (!intent.stage) return { type: "question", text: "Which stage should they move to?" };
      // Into Follow-up from a new CV or a match is a shortlist — it takes the
      // candidate, numbers the set and starts the chase, which a bare stage
      // move would skip.
      if (intent.stage === "follow_up" && (hit.app.stage === "new_cv" || hit.app.stage === "matched")) {
        action = { kind: "shortlist", appId: hit.app.id };
        break;
      }
      if ((intent.stage === "rejected" || intent.stage === "dropped_out") && !intent.reason) {
        return { type: "question", text: intent.stage === "rejected" ? `Why is ${hit.name} being rejected? Say, for example, “reject ${hit.name.split(" ")[0]} — package above range”.` : `Why did ${hit.name} drop out?` };
      }
      action = { kind: "move", appId: hit.app.id, stage: intent.stage, reason: intent.reason ?? null };
      break;
    case "note":
      if (!intent.text?.trim()) return { type: "question", text: "What should the note say?" };
      action = { kind: "note", appId: hit.app.id, text: intent.text.trim().slice(0, 1000) };
      break;
    case "answers":
      action = { kind: "answers", appId: hit.app.id, currentSalary: intent.currentSalary ?? null, expectedSalary: intent.expectedSalary ?? null, noticeDays: intent.noticeDays ?? null };
      break;
    case "call": {
      const outcome = intent.outcome ?? "no_answer";
      const promisedAt = outcome === "callback" || outcome === "will_send" ? (intent.when ? parseWhen(intent.when, now) : null) : null;
      if ((outcome === "callback" || outcome === "will_send") && !promisedAt) {
        return { type: "question", text: `What time? Say, for example, “call ${hit.name.split(" ")[0]} back tomorrow 10am”.` };
      }
      action = { kind: "call", appId: hit.app.id, outcome, promisedAt, note: intent.text ?? "" };
      break;
    }
  }
  const ok = check(user, action);
  if (!ok.ok) return { type: "refusal", text: ok.message };
  const { summary, details } = describe(action, hit);
  return {
    type: "proposal",
    proposal: { token: token(user, action, now), summary, details, link: `/openings/${hit.app.openingId}/candidate/${hit.app.id}` },
  };
}

/** Runs a confirmed proposal. Everything is checked again. */
export function execute(user: User, tokenText: string, now = Date.now()): { ok: true; message: string; link: string } | { ok: false; message: string } {
  const cut = tokenText.lastIndexOf(".");
  if (cut <= 0) return { ok: false, message: "That confirmation isn't valid." };
  const body = tokenText.slice(0, cut);
  if (!verifyText(body, tokenText.slice(cut + 1))) return { ok: false, message: "That confirmation isn't valid." };
  let payload: { v: number; uid: string; exp: number; action: DeskAction };
  try {
    payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
  } catch {
    return { ok: false, message: "That confirmation isn't valid." };
  }
  if (payload.uid !== user.id) return { ok: false, message: "That was proposed for someone else." };
  if (payload.exp < now) return { ok: false, message: "That's more than ten minutes old — ask again." };
  for (const [k, exp] of used) if (exp < now) used.delete(k);
  if (used.has(body)) return { ok: false, message: "That's already been done." };

  const action = payload.action;
  const ok = check(user, action);
  if (!ok.ok) return { ok: false, message: ok.message };
  const app = ok.app;
  const link = `/openings/${app.openingId}/candidate/${app.id}`;
  const name = repo.candidate(app.candidateId)?.fullName ?? "They";
  used.set(body, payload.exp);

  switch (action.kind) {
    case "shortlist": {
      const r = repo.shortlist(app.id, user.id);
      if (!r.ok) return { ok: false, message: "Someone else shortlisted them first." };
      return { ok: true, message: `${name} is shortlisted${r.setNumber ? ` in set ${r.setNumber}` : ""} and in Follow-up.`, link };
    }
    case "move": {
      const r = repo.moveStage(app.id, action.stage, user.id, action.reason ?? undefined);
      if (!r.ok) return { ok: false, message: r.message };
      return { ok: true, message: `${name} is now in ${STAGE_LABEL[action.stage]}.`, link };
    }
    case "note": {
      const r = repo.addApplicationNote(app.id, action.text, user.id);
      return r.ok ? { ok: true, message: `Note added to ${name}.`, link } : { ok: false, message: "The note wasn't saved." };
    }
    case "answers":
      repo.updateCandidate(app.candidateId, {
        ...(action.currentSalary ? { currentSalary: action.currentSalary } : {}),
        ...(action.expectedSalary ? { expectedSalary: action.expectedSalary } : {}),
        ...(action.noticeDays !== null ? { noticePeriodDays: action.noticeDays } : {}),
      });
      return { ok: true, message: `Saved ${name}'s details.`, link };
    case "call": {
      const r = repo.recordCallOutcome({ applicationId: app.id, outcome: action.outcome, promisedAt: action.promisedAt, note: action.note, byUserId: user.id });
      if (!r.ok) return { ok: false, message: r.message };
      return { ok: true, message: `Recorded for ${name}.`, link };
    }
  }
}

// ─── When the rules can't read it ───────────────────────────────────────────

export type ModelCall = (system: string, prompt: string) => Promise<AiResult>;

/**
 * A change typed in a way the rules don't recognise goes to the model — but
 * the model only *reads* it into the same fields. It never runs anything, and
 * what it reads still has to find a real candidate and pass every check.
 */
export async function understand(message: string, call: ModelCall = (s, p) => write(s, p, 300, "assist")): Promise<Intent | null> {
  const rules = parseIntent(message);
  if (rules) return rules;
  const system = [
    "Read a recruiter's instruction into JSON. Reply with JSON only.",
    'Shape: {"kind":"shortlist"|"move"|"note"|"answers"|"call"|"none","name":string,"job":string|null,"stage":"follow_up"|"director_review"|"director_shortlist"|"client_shortlist"|"interview"|"offer"|"placed"|"rejected"|"dropped_out"|null,"reason":string|null,"text":string|null,"currentSalary":string|null,"expectedSalary":string|null,"noticeDays":number|null,"outcome":"no_answer"|"answered"|"callback"|"will_send"|"not_interested"|null,"when":string|null}',
    'Use "none" if it is a question or not a change to one candidate. Copy the candidate name exactly as written. Never invent values.',
  ].join("\n");
  const r = await call(system, message.slice(0, 500));
  if (!r.ok) return null;
  const s = r.text.indexOf("{"), e = r.text.lastIndexOf("}");
  try {
    const j = JSON.parse(r.text.slice(s, e + 1));
    if (!j || j.kind === "none" || typeof j.name !== "string" || !j.name.trim()) return null;
    const kinds = ["shortlist", "move", "note", "answers", "call"];
    if (!kinds.includes(j.kind)) return null;
    const stages = Object.keys(STAGE_LABEL);
    return {
      kind: j.kind,
      name: j.name,
      job: typeof j.job === "string" ? j.job : null,
      stage: stages.includes(j.stage) ? j.stage : undefined,
      reason: typeof j.reason === "string" ? j.reason : null,
      text: typeof j.text === "string" ? j.text : undefined,
      currentSalary: typeof j.currentSalary === "string" ? j.currentSalary : null,
      expectedSalary: typeof j.expectedSalary === "string" ? j.expectedSalary : null,
      noticeDays: typeof j.noticeDays === "number" ? j.noticeDays : null,
      outcome: ["no_answer", "answered", "callback", "will_send", "not_interested"].includes(j.outcome) ? j.outcome : undefined,
      when: typeof j.when === "string" ? j.when : null,
    };
  } catch {
    return null;
  }
}
