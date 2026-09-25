/**
 * Standalone JSON-backed store.
 *
 * Spec §15: this is the stage-one implementation. Everything above it goes
 * through `repo`, so phase 8c swaps this file's internals for the live Convex
 * deployment without touching a single component.
 *
 * Writes are whole-file, but they are not careless: every write takes a lock,
 * re-reads what anyone else committed, applies the change to that, and lands
 * the result with an atomic rename. That is enough for a desk of this size and
 * it is what the Convex swap will inherit conceptually — read, decide, commit.
 */

import { profileLink } from "@/lib/url";
import fs from "node:fs";
import path from "node:path";
import type {
  MatchRun,
  AiCall,
  Application,
  Brief,
  CallField,
  CallMode,
  Candidate,
  Currency,
  EsaRecord,
  EsaStatus,
  Offer,
  OfferStatus,
  Placement,
  SalaryBasis,
  Client,
  Database,
  Id,
  LinkVaultEntry,
  LinkOutcome,
  BenchmarkEntry,
  ChatMessage,
  JdChatMessage,
  Assignment,
  AssignmentRole,
  WorkingStage,
  Interview,
  IntakeItem,
  IntakeSource,
  IntakeStatus,
  Opening,
  OutreachChannel,
  OutreachMessage,
  ParsedCv,
  PipelineEvent,
  ProfileSuggestion,
  ReviewDecision,
  ReviewRound,
  ResearchReport,
  SavedReport,
  SavedSearch,
  SearchCriteria,
  Stage,
  User,
  JobPost,
} from "./types";
import { RETIRED_STAGES } from "./types";
import { buildSeed } from "./seed";
import { canMove, eventTypeFor } from "@/lib/pipeline";
import { colomboDayStart } from "@/lib/calendar";
import { evalBoolean, haystackFor, parseBoolean, type Vocabulary } from "@/lib/query";
import { matchCandidate, type Result } from "@/lib/match";
import { employerRelated, matchAgainst, planMerge } from "@/lib/dedup";
import { guard, parseCv, problemsWith } from "@/lib/ingest";
import { makeCampaignCode, routeByCampaignCode, routeInbound, routeNote, DEFAULT_SHORTLIST_INBOX } from "@/lib/routing";
import { DEFAULT_EOD_CC } from "@/lib/eod-format";
import {
  followUpFor, missingFor, questionsInForce, readReply, STANDARD_QUESTIONS,
  type Contact, type FollowUp, type FollowUpQuestion, type FollowUpState, type ReplyReading,
} from "@/lib/followup";
import { DEFAULT_FEE_PERCENT, DEFAULT_GUARANTEE_DAYS } from "@/lib/closing";
import { healthFor, overallStatus } from "@/lib/health";
import { acceptAnswer, applyPlan, CALL_CONSENT_TEXT, modeState, writePolicy } from "@/lib/voice";
import { dataDir } from "./dataDir";
import { isConvex } from "./mode";
import { bumpPrimed, getCommitter, realId, recordAliases, hasCandidate, missingCandidateMessage, primed, primedVersion, primedVocabulary, resetStore } from "./primeState";
import { describeCommitError, diffTables, renameIds, restoreTables, snapshotTables } from "./unitOfWork";

const DATA_DIR = dataDir();
const DB_FILE = path.join(DATA_DIR, "db.json");
const LOCK_FILE = path.join(DATA_DIR, "db.lock");

let cache: Database | null = null;
/** Bumped on every write in this process, so derived indexes know to rebuild. */
let dataVersion = 0;

/**
 * Lookups that were whole-table scans. `repo.candidate(id)` ran
 * `candidates.find` — fine at 755, and at 115,000 a database-match run for one
 * job took 32 seconds, most of it in scans like that (13 September). These are
 * built once per version of the data and thrown away on the next write.
 */
interface Indexes {
  db: Database;
  version: number;
  primedVersion: number;
  candidateById: Map<Id, Candidate>;
  applicationById: Map<Id, Application>;
  appsByOpening: Map<Id, Application[]>;
  appsByCandidate: Map<Id, Application[]>;
  cvTextByCandidate: Map<Id, string>;
  vocabulary?: Vocabulary;
}
let indexCache: Indexes | null = null;

function indexes(): Indexes {
  const db = load();
  if (
    indexCache &&
    indexCache.db === db &&
    indexCache.version === dataVersion &&
    indexCache.primedVersion === primedVersion()
  ) {
    return indexCache;
  }
  const push = <K, V>(m: Map<K, V[]>, k: K, v: V) => {
    const list = m.get(k);
    if (list) list.push(v);
    else m.set(k, [v]);
  };
  const appsByOpening = new Map<Id, Application[]>();
  const appsByCandidate = new Map<Id, Application[]>();
  for (const a of db.applications) {
    push(appsByOpening, a.openingId, a);
    push(appsByCandidate, a.candidateId, a);
  }
  const newest = new Map<Id, { at: number; text: string }>();
  for (const m of db.liveMirror) {
    if (m.rawText) newest.set(m.candidateId, { at: m.syncedAt, text: m.rawText });
  }
  for (const i of db.intake) {
    if (!i.candidateId || !i.rawText) continue;
    const had = newest.get(i.candidateId);
    if (!had || i.receivedAt > had.at) newest.set(i.candidateId, { at: i.receivedAt, text: i.rawText });
  }
  indexCache = {
    db,
    version: dataVersion,
    primedVersion: primedVersion(),
    candidateById: new Map(db.candidates.map((c) => [c.id, c])),
    applicationById: new Map(db.applications.map((a) => [a.id, a])),
    appsByOpening,
    appsByCandidate,
    cvTextByCandidate: new Map([...newest].map(([k, v]) => [k, v.text])),
  };
  return indexCache;
}
/** The file's mtime and size when `cache` was filled. See `load`. */
let cacheStamp = 0;
let cacheSize = 0;

/**
 * A file written before a table existed is missing that table, and every read of
 * it then throws on `undefined.filter`. The shape will keep moving through
 * phase 8, so rather than reseeding every time it changes, anything absent is
 * backfilled empty on load. Existing records are never touched.
 */
function backfill(db: Partial<Database>): Database {
  const empty = {
    users: [], briefs: [], clients: [], openings: [], jobPosts: [], candidates: [],
    referees: [], applications: [], callFeedback: [], interviews: [], linkVault: [],
    assignments: [], pipelineEvents: [], reviewRounds: [],
    alerts: [], savedSearches: [], savedReports: [], researchReports: [], benchmarks: [], suggestions: [], chat: [], jdChat: [],
    intake: [], outreach: [], offers: [], placements: [], esaRecords: [], aiCalls: [], settings: [],
    matchRuns: [], matchExclusions: [], liveMirror: [],
  } satisfies Database;
  const out = { ...empty } as Database;
  for (const key of Object.keys(empty) as (keyof Database)[]) {
    const v = db[key];
    if (Array.isArray(v)) (out[key] as unknown[]) = v;
  }
  for (const p of out.jobPosts) {
    p.previousTitles ??= [];
    if (!p.campaignCode) p.campaignCode = makeCampaignCode(p.title, out.jobPosts.map((x) => x.campaignCode).filter(Boolean));
  }
  for (const o of out.openings) {
    o.followUpQuestions ??= [];
    o.autoFollowUp ??= false;
    if (o.status === "closed" && o.positionStatus !== "lost") o.positionStatus = "lost";
    if (o.status === "filled") o.positionStatus = "filled";
  }
  for (const a of out.applications) a.answers ??= {};
  // Stages retired 13 September. Read their people as Follow-up rather than
  // leaving them in a stage no screen shows.
  for (const a of out.applications) {
    const moved = RETIRED_STAGES[a.stage as string];
    if (moved) a.stage = moved;
  }
  for (const e of out.pipelineEvents) {
    if (e.fromStage && RETIRED_STAGES[e.fromStage as string]) e.fromStage = RETIRED_STAGES[e.fromStage as string];
    if (e.toStage && RETIRED_STAGES[e.toStage as string]) e.toStage = RETIRED_STAGES[e.toStage as string];
  }
  return out;
}

/**
 * Holding the database in a module-level variable assumes one module instance.
 * That assumption is false: a route handler and a server component can be
 * evaluated in separate module graphs, so a write through one leaves the other
 * serving whatever it read first — silently, and until the process restarts.
 *
 * Checking the file's mtime costs a stat and removes the whole class of
 * staleness. It matters more at connection, not less: the live deployment is
 * written by another application as well as this one.
 */
function load(): Database {
  // Backed by Convex, the rows were fetched before the render began — see
  // src/data/prime.ts for why they are not fetched here. Everything below this
  // line is the JSON file's path and is untouched.
  if (isConvex()) {
    const working = primed();
    if (!working) {
      throw new Error(
        "The store has not been primed. Add `await primeStore()` at the top of the page, " +
          "server action or route handler before anything reads `repo` — and pass a scope " +
          "({ openingId } or { candidateIds }) where candidates are needed. See src/data/prime.ts.",
      );
    }
    return working;
  }

  let stamp = 0;
  let size = 0;
  try {
    if (fs.existsSync(DB_FILE)) {
      const st = fs.statSync(DB_FILE);
      stamp = st.mtimeMs;
      size = st.size;
    }
  } catch {
    stamp = 0;
    size = 0;
  }
  if (cache && stamp === cacheStamp && size === cacheSize) return cache;

  if (stamp > 0) {
    const raw = fs.readFileSync(DB_FILE, "utf8");
    try {
      cache = backfill(JSON.parse(raw) as Partial<Database>);
      cacheStamp = stamp;
      cacheSize = size;
      return cache;
    } catch (err) {
      // A damaged file used to be reseeded over, which turned a half-written
      // save into silent data loss — the 13 September audit reproduced exactly
      // that. The file is now moved aside, intact, and the read fails loudly.
      // Recovery is a decision for a person, not a default.
      const kept = path.join(DATA_DIR, `db.damaged-${Date.now()}.json`);
      try {
        fs.renameSync(DB_FILE, kept);
      } catch {
        /* If it cannot even be moved, the message below still has to reach someone. */
      }
      throw new Error(
        `The database file could not be read and was not overwritten. ` +
          `A copy is at ${kept}. Restore a backup, or delete .data/db.json to start from seed data. ` +
          `(${(err as Error).message})`,
      );
    }
  }

  // No file at all — a first run. Seeding here is creation, not replacement.
  cache = backfill(buildSeed());
  writeOut(cache);
  // The seeded CVs at the door are filed the way live ones are, once the
  // store is ready to take writes.
  pendingSettle = true;
  if (lockDepth === 0) settleSeed();
  return cache;
}

let lockDepth = 0;
let pendingSettle = false;

function settleSeed() {
  if (!pendingSettle) return;
  pendingSettle = false;
  for (const item of load().intake) {
    if (item.status === "ready") repo.processIntake(item.id);
  }
}

/** The write itself: whole file, atomically, so no reader ever sees a half. */
function writeOut(db: Database) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  // Write beside the target and rename. Rename within a directory is atomic,
  // so a reader arriving mid-write sees the old file or the new one — never a
  // truncated one, which is what produced the damaged file above.
  const tmp = path.join(DATA_DIR, `.db.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`);
  try {
    // Compact, not pretty-printed: at 115,000 candidates the indentation alone
    // was a third of the file and of every save.
    fs.writeFileSync(tmp, JSON.stringify(db));
    fs.renameSync(tmp, DB_FILE);
  } finally {
    try {
      if (fs.existsSync(tmp)) fs.unlinkSync(tmp);
    } catch {
      /* best effort */
    }
  }
  try {
    const st = fs.statSync(DB_FILE);
    cacheStamp = st.mtimeMs;
    cacheSize = st.size;
  } catch {
    cacheStamp = 0;
    cacheSize = 0;
  }
}

function persist() {
  if (cache) writeOut(cache);
}

/** How long to wait for another writer before assuming it died mid-write. */
const LOCK_STALE_MS = 10_000;

/**
 * Take the write lock, or wait for it.
 *
 * `wx` fails if the file exists, which makes creating it the whole test — there
 * is no gap between checking and taking. A lock older than ten seconds is
 * treated as abandoned, because a crashed process cannot clean up after itself
 * and a desk that has to be restarted to save a phone number is worse than the
 * race this guards.
 */
function withLock<T>(fn: () => T): T {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const deadline = Date.now() + LOCK_STALE_MS * 2;
  let held = false;

  while (!held) {
    try {
      fs.writeFileSync(LOCK_FILE, `${process.pid}`, { flag: "wx" });
      held = true;
    } catch {
      let age = 0;
      try {
        age = Date.now() - fs.statSync(LOCK_FILE).mtimeMs;
      } catch {
        continue; // It went away between the failure and the stat — try again.
      }
      if (age > LOCK_STALE_MS) {
        try {
          fs.unlinkSync(LOCK_FILE);
        } catch {
          /* somebody else cleared it first */
        }
        continue;
      }
      if (Date.now() > deadline) {
        throw new Error("Another process is writing to the database and did not finish.");
      }
      // A short spin. Writes are milliseconds; this is not a queue.
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 15);
    }
  }

  lockDepth++;
  try {
    return fn();
  } finally {
    lockDepth--;
    try {
      fs.unlinkSync(LOCK_FILE);
    } catch {
      /* already gone */
    }
    if (lockDepth === 0) settleSeed();
  }
}

/**
 * Every write goes through here: take the lock, re-read whatever another writer
 * committed while we were deciding, apply the change to *that*, write it back.
 *
 * Reading inside the lock is the part that matters. Without it two overlapping
 * saves both start from the same snapshot and the second silently erases the
 * first — which is the concurrency hole the audit flagged.
 */
function mutate(fn: (db: Database) => void) {
  // A write inside a write — processing an intake item admits a candidate —
  // works on the same in-memory database and is committed by the outer one.
  // Taking the lock again would wait on itself.
  if (lockDepth > 0) {
    fn(load());
    dataVersion++;
    return;
  }
  if (isConvex()) return commitToConvex(fn);
  return withLock(() => {
    // `load` compares the file's modified time with the copy in memory, so a
    // write by another process is still picked up — without re-reading the
    // whole file before every save, which cost 0.6 s at 115,000 candidates.
    const db = load();
    fn(db);
    dataVersion++;
    writeOut(db);
  });
}

/**
 * A write, saved to Convex as one transaction.
 *
 * The rules run exactly as they do over the file: against the in-memory
 * tables. The tables are copied first; afterwards the difference is sent as a
 * single commit (convex/ta/commit.ts) that writes all of it or none of it, and
 * refuses the lot if anything the write changed was changed by someone else
 * since it was loaded. On success the new rows take the ids the database gave
 * them and the in-memory copy stays current, so the rest of the request reads
 * its own write. On refusal the copy is put back and the action gets an error
 * it can show.
 *
 * Until this, a write here changed the copy and then threw it away: the page
 * said "saved" and the next page showed the old data.
 */
function commitToConvex(fn: (db: Database) => void) {
  const commit = getCommitter();
  if (!commit) {
    throw new Error("Saving is not available: the store was not loaded from Convex. Call primeStore() first.");
  }
  const db = load();
  const before = snapshotTables(db);
  lockDepth++;
  try {
    fn(db);
  } catch (e) {
    restoreTables(db, before);
    throw e;
  } finally {
    lockDepth--;
  }
  const ops = diffTables(before, db);
  if (ops.length === 0) return;
  try {
    const { ids } = commit(ops);
    renameIds(db, ids);
    recordAliases(ids);
  } catch (e) {
    restoreTables(db, before);
    dataVersion++;
    bumpPrimed();
    throw new Error(describeCommitError((e as Error).message));
  }
  dataVersion++;
  bumpPrimed();
}

/** "Bangladesh" → "Bangladeshi", so an unstated brief still routes correctly. */
function localNationalityOf(country: string): string {
  const map: Record<string, string> = {
    "sri lanka": "Sri Lankan", bangladesh: "Bangladeshi", india: "Indian",
    pakistan: "Pakistani", "saudi arabia": "Saudi", "united arab emirates": "Emirati",
    qatar: "Qatari", oman: "Omani", kuwait: "Kuwaiti", maldives: "Maldivian",
    singapore: "Singaporean", malaysia: "Malaysian", vietnam: "Vietnamese",
  };
  return map[country.trim().toLowerCase()] ?? country.trim();
}

const JD_NOT_APPROVED =
  "This job cannot go live until its JD is approved. Approve the JD first, then set the advert live.";

/** A set closes on the day it reaches this many. */
export const SET_SIZE = 5;

/**
 * The set a newly shortlisted person joins.
 *
 * The desk's rule, as the user put it on 13 September: the end-of-day email
 * goes out every day, even with fewer than five. Set 1 with three CVs today is
 * still Set 1 tomorrow. Only a day on which the set reaches five — or passes
 * it — finishes the set, and the next working day starts Set 2.
 *
 * So a set is closed when five or more of its members were shortlisted before
 * today. Anybody shortlisted today joins the set that is open this morning,
 * even if that takes it to seven.
 *
 * Counted per recruiter per opening: each TA sends their own end-of-day email,
 * so Shamra's Set 1 and Azma's Set 1 on the same job are different sets.
 */
function nextSetNumber(db: Database, openingId: Id, taId: Id, now = Date.now()): number {
  const mine = db.applications.filter(
    (a) => a.openingId === openingId && a.ownerTaId === taId && a.setNumber !== null,
  );
  if (mine.length === 0) return 1;
  const top = Math.max(...mine.map((a) => a.setNumber as number));
  const today = colomboDayStart(now);
  const beforeToday = mine.filter(
    (a) => a.setNumber === top && a.shortlistedAt !== null && a.shortlistedAt < today,
  ).length;
  return beforeToday >= SET_SIZE ? top + 1 : top;
}

/**
 * Which channel code an intake source becomes on the application.
 *
 * This is the Master Sheet's column, and the reports that split performance by
 * channel read it. An intake item filed as SCOOP — the database code — made
 * every LinkedIn applicant look like a database find, which is the second half
 * of finding 06.
 */
function channelForIntake(source: IntakeSource, jobPostId: Id | null): Application["sourcingChannel"] {
  switch (source) {
    case "email":
      // The TA's application mailbox receives LinkedIn's forwards; a mail with
      // no post to file against is an ordinary emailed CV.
      return jobPostId ? "L" : "E";
    case "whatsapp":
      return "DA";
    case "extension":
      // Captured from a LinkedIn profile the TA had open — a hunt.
      return "HH";
    case "upload":
      return jobPostId ? "L" : "E";
    case "portal":
      return "E";
  }
}

// ─── Reads ───────────────────────────────────────────────────────────────────

const rawRepo = {
  reset() {
    cache = backfill(buildSeed());
    persist();
    pendingSettle = true;
    if (lockDepth === 0) settleSeed();
  },

  users: (): User[] => load().users,
  user: (id: Id) => load().users.find((u) => u.id === id) ?? null,

  clients: () => load().clients,
  client: (id: Id) => load().clients.find((c) => c.id === id) ?? null,

  openings: () => load().openings,
  opening: (id: Id) => load().openings.find((o) => o.id === id) ?? null,

  openingsForUser(user: User): Opening[] {
    const all = load().openings;
    if (user.role === "ta") return all.filter((o) => o.assignedTaIds.includes(user.id) || !!repo.assignmentFor(o.id, user.id));
    if (user.role === "ta_lead") return all.filter((o) => o.taLeadId === user.id || o.assignedTaIds.includes(user.id));
    // A client or a viewer sees the openings they have been put on, and no
    // others — this returned every opening on the desk for them.
    if (user.role === "client" || user.role === "viewer") return all.filter((o) => !!repo.assignmentFor(o.id, user.id));
    return all;
  },

  /**
   * Job posts, with "CVs today" counted rather than read.
   *
   * It was a stored number that nothing ever increased or reset, so the seeded
   * figure sat under the label "today" indefinitely and a new applicant never
   * moved it (audit finding 26). It is now the applicants filed to the post
   * since midnight Colombo — the same count everywhere it is shown.
   */
  jobPosts: (openingId?: Id) => {
    const db = load();
    const since = colomboDayStart(Date.now());
    const today = new Map<Id, number>();
    for (const a of db.applications) {
      if (a.jobPostId && a.createdAt >= since && a.sourcingChannel !== "SCOOP") {
        today.set(a.jobPostId, (today.get(a.jobPostId) ?? 0) + 1);
      }
    }
    const all = db.jobPosts.map((j) => ({ ...j, cvCountToday: today.get(j.id) ?? 0 }));
    return openingId ? all.filter((j) => j.openingId === openingId) : all;
  },

  candidates: () => load().candidates,
  referees: () => load().referees ?? [],

  /**
   * Spec §6.1 — referees relevant to an opening. Relevance is company overlap
   * with people already in the pool plus seniority in the title, because the
   * useful referee is the one who sits where the target sits.
   */
  /**
   * Referees worth calling about THIS opening, and why each one is here.
   *
   * A referee has to be tied to the job to appear: at a company the desk is
   * hunting in, at a company somebody in the pool works for, named by a
   * candidate on this opening, or doing the job being filled. Having a phone
   * number or a senior title only orders those — before 13 September either
   * one was enough on its own, so nearly every referee in the database was
   * listed against every opening.
   */
  refereesForOpening(openingId: Id) {
    const db = load();
    const opening = db.openings.find((o) => o.id === openingId);
    const apps = db.applications.filter((a) => a.openingId === openingId);
    const onOpening = new Set(apps.map((a) => a.candidateId));
    const poolCompanies = apps
      .map((a) => db.candidates.find((c) => c.id === a.candidateId)?.currentEmployer)
      .filter(Boolean) as string[];
    const vaultCompanies = db.linkVault
      .filter((l) => l.openingId === openingId)
      .map((l) => l.company)
      .filter(Boolean) as string[];
    const titleWords = (opening?.title ?? "")
      .toLowerCase()
      .split(/\W+/)
      .filter((w) => w.length > 3 && !["head", "senior", "manager", "assistant", "executive"].includes(w));

    return (db.referees ?? [])
      .filter((r) => r.contactable)
      .map((r) => {
        const why: string[] = [];
        let score = 0;
        if (r.company && vaultCompanies.some((c) => employerRelated(c, r.company!))) {
          score += 3;
          why.push(`at ${r.company}, a company you are hunting in`);
        }
        if (r.company && poolCompanies.some((c) => employerRelated(c, r.company!))) {
          score += 2;
          why.push(`at ${r.company}, where someone in this pool works`);
        }
        if (onOpening.has(r.fromCandidateId)) {
          score += 2;
          why.push("named by a candidate on this opening");
        }
        if (titleWords.length && titleWords.some((w) => (r.title ?? "").toLowerCase().includes(w))) {
          score += 2;
          why.push(`works in ${opening!.title.toLowerCase()}`);
        }
        const relevant = score > 0;
        // Tie-breakers only.
        if (relevant && /head|director|chief|general manager/i.test(r.title ?? "")) score += 0.5;
        if (relevant && r.phone) score += 0.5;
        return { referee: r, score, relevant, why };
      })
      .filter((x) => x.relevant)
      .sort((a, b) => b.score - a.score);
  },

  /**
   * Referees of the people being followed up or shortlisted on this opening —
   * and nobody else's (testing, 21 Sep: the list drew on whatever candidates
   * happened to be loaded, from any stage or opening, so it changed from visit
   * to visit). Grouped by candidate, in stage order.
   */
  refereesForPipeline(openingId: Id) {
    const db = load();
    const STAGES: Stage[] = ["ai_follow_up", "ta_follow_up", "director_review", "director_shortlist", "client_shortlist", "interview", "offer"];
    const apps = db.applications
      .filter((a) => a.openingId === openingId && STAGES.includes(a.stage))
      .sort((a, b) => STAGES.indexOf(a.stage) - STAGES.indexOf(b.stage));
    return apps
      .map((app) => ({
        app,
        candidate: db.candidates.find((c) => c.id === app.candidateId) ?? null,
        referees: (db.referees ?? []).filter((r) => r.fromCandidateId === app.candidateId),
      }))
      .filter((g) => g.candidate);
  },

  /** Notebook pages 1 and 3 — who else in the database works at this company? */
  peopleAtCompany(company: string, excludeCandidateId?: Id) {
    const db = load();
    const needle = company.toLowerCase();
    return db.candidates.filter(
      (c) =>
        c.id !== excludeCandidateId &&
        (c.currentEmployer ?? "").toLowerCase().includes(needle) &&
        (c.phone || c.email),
    );
  },
  // Inside a write the data is changing under the lookup, so it scans directly;
  // outside one it uses the indexes.
  candidate: (id: Id) => {
    const found =
      lockDepth > 0 ? load().candidates.find((c) => c.id === id) ?? null : indexes().candidateById.get(id) ?? null;
    // Backed by Convex, a miss returns null rather than throwing so callers with
    // `if (!candidate) continue` or optional chaining don't crash the server.
    if (!found && isConvex() && !hasCandidate(id)) return null;
    return found;
  },

  applications: (openingId?: Id) => {
    if (!openingId) return load().applications;
    if (lockDepth > 0) return load().applications.filter((a) => a.openingId === openingId);
    return [...(indexes().appsByOpening.get(openingId) ?? [])];
  },
  application: (id: Id) =>
    lockDepth > 0 ? load().applications.find((a) => a.id === id) ?? null : indexes().applicationById.get(id) ?? null,

  /** Changes whenever the data does — for caches outside the store. */
  version: () => `${cacheStamp}:${dataVersion}:${primedVersion()}`,

  /**
   * The opening a record really belongs to, read from the record.
   *
   * A form's `openingId` is whatever the browser sent. Authorization is decided
   * on this instead, so an interview, a post or an advert from one opening
   * cannot be edited by naming a different opening you do have access to — and
   * a candidate page cannot show one opening's person under another's header.
   */
  openingOf(
    kind:
      | "application" | "post" | "interview" | "link" | "benchmark" | "suggestion"
      | "placement" | "offer" | "call" | "round" | "intake" | "esa",
    id: Id,
  ): { found: boolean; openingId: Id | null; ownerTaId: Id | null } {
    const db = load();
    const viaApp = (applicationId: Id | null | undefined) => {
      const a = applicationId ? db.applications.find((x) => x.id === applicationId) : undefined;
      return a
        ? { found: true, openingId: a.openingId, ownerTaId: a.ownerTaId }
        : { found: false, openingId: null, ownerTaId: null };
    };
    const plain = (row: { openingId: Id | null } | undefined) =>
      row
        ? { found: true, openingId: row.openingId, ownerTaId: null }
        : { found: false, openingId: null, ownerTaId: null };

    switch (kind) {
      case "application": return viaApp(id);
      case "interview": return viaApp(db.interviews.find((x) => x.id === id)?.applicationId);
      case "offer": return viaApp(db.offers.find((x) => x.id === id)?.applicationId);
      case "call": return viaApp(db.aiCalls.find((x) => x.id === id)?.applicationId);
      case "post": return plain(db.jobPosts.find((x) => x.id === id));
      case "link": return plain(db.linkVault.find((x) => x.id === id));
      case "benchmark": return plain(db.benchmarks.find((x) => x.id === id));
      case "suggestion": return plain(db.suggestions.find((x) => x.id === id));
      case "placement": return plain(db.placements.find((x) => x.id === id));
      case "round": return plain(db.reviewRounds.find((x) => x.id === id));
      case "intake": return plain(db.intake.find((x) => x.id === id));
      case "esa": return plain(db.esaRecords.find((x) => x.id === id));
    }
  },

  linkVault: (openingId: Id): LinkVaultEntry[] =>
    load().linkVault.filter((l) => l.openingId === openingId),

  callFeedback: (applicationId: Id) =>
    load()
      .callFeedback.filter((f) => f.applicationId === applicationId)
      .sort((a, b) => b.recordedAt - a.recordedAt),

  interviews: (applicationId?: Id) => {
    const all = load().interviews;
    return applicationId ? all.filter((i) => i.applicationId === applicationId) : all;
  },

  /** Spec §12 / notebook page 4 — "plan the day". Null until phase 6 fills it. */
  dayPlan(taId: Id, date: Date) {
    void taId;
    void date;
    return null as { isHundredPercentDay: boolean } | null;
  },

  alerts: (userId?: Id) => {
    const all = load().alerts.filter((a) => !a.resolvedAt);
    return userId ? all.filter((a) => a.assignedTo === userId) : all;
  },

  // ─── Writes ────────────────────────────────────────────────────────────────

  /**
   * Spec §9 / Q3 — ownership is claimed by whoever shortlists first, and the
   * claim is written in the same operation as the stage change so two
   * simultaneous shortlists cannot both win.
   *
   * Returns the existing owner if the candidate is already claimed, so the
   * caller can show "Already shortlisted by …" rather than silently failing.
   */
  /**
   * A TA shortlists a candidate.
   *
   *   **They own it.** First to shortlist owns, and a second TA is refused —
   *   the collision lock of §9.
   *
   *   **They join a set** — see `nextSetNumber` for the desk's rule.
   *
   *   **They go to Follow-up.** Always: that is where the AI call, the WhatsApp
   *   and the email happen, and the call is placed whether or not the details
   *   are already on file, because it also confirms the person is still
   *   interested (the user's pipeline, 13 September).
   *
   * The move is written to history. Shortlisting twice changes nothing.
   */
  shortlist(applicationId: Id, taId: Id): { ok: true; stage: Stage; setNumber: number | null } | { ok: false; ownerTaId: Id } {
    const db = load();
    const app = db.applications.find((a) => a.id === applicationId);
    if (!app) return { ok: false, ownerTaId: "" };
    if (app.ownerTaId && app.ownerTaId !== taId) {
      return { ok: false, ownerTaId: app.ownerTaId };
    }
    if (app.ownerTaId === taId && app.shortlistedAt) {
      return { ok: true, stage: app.stage, setNumber: app.setNumber };
    }

    const candidate = db.candidates.find((c) => c.id === app.candidateId);
    const from = app.stage;
    // A TA's shortlist is TA Follow-up — database matches, new CVs, and the
    // AI's own shortlist too. Only the AI's pass-mark shortlist is AI Follow-up.
    const claimable = from === "new_cv" || from === "matched" || from === "ai_follow_up";
    const to: Stage = claimable ? "ta_follow_up" : from;

    let setNumber: number | null = app.setNumber;
    mutate((d) => {
      const a = d.applications.find((x) => x.id === applicationId);
      if (!a) return;
      const now = Date.now();
      a.ownerTaId = taId;
      a.shortlistedAt = now;
      if (a.setNumber === null) {
        a.setNumber = nextSetNumber(d, a.openingId, taId, now);
        setNumber = a.setNumber;
      }
      if (to !== from) {
        a.stage = to;
        a.lastStageChangedAt = now;
      }
      d.pipelineEvents.push({
        id: `pe_${Math.random().toString(36).slice(2, 10)}`,
        applicationId,
        openingId: a.openingId,
        eventType: "shortlisted",
        fromStage: from,
        toStage: to,
        actorId: taId,
        actorType: "user",
        note:
          candidate && missingFor(candidate).length
            ? `Shortlisted into set ${a.setNumber}; still needed: ${missingFor(candidate).join(", ").replace(/_/g, " ")}`
            : `Shortlisted into set ${a.setNumber}`,
        at: now,
      });
    });
    return { ok: true, stage: to, setNumber };
  },

  /**
   * A stage change, checked and recorded.
   *
   * Two things changed here on 12 September. The move is now validated against
   * the state machine, so a CV cannot reach a client without a director having
   * seen it. And every move writes a `pipelineEvents` row — which is what
   * answers "why was this person dropped, and when" three months later.
   *
   * `actorType` distinguishes a TA from the follow-up cron from a director
   * replying to an email, because "the system moved them" and "Sanduni moved
   * them" are different facts.
   */
  moveStage(
    applicationId: Id,
    stage: Stage,
    actorId: Id | null,
    reason?: string,
    opts: { actorType?: PipelineEvent["actorType"]; eventType?: string; force?: boolean } = {},
  ): { ok: true } | { ok: false; message: string } {
    const app = load().applications.find((a) => a.id === applicationId);
    if (!app) return { ok: false, message: "That application no longer exists." };

    const from = app.stage;
    // A person rejecting or dropping someone says why — whichever screen, or
    // the assistant, asked. Only the form enforced it, so the assistant could
    // reject with no reason on record.
    if (!opts.force && actorId && (opts.actorType ?? "user") === "user" && (stage === "rejected" || stage === "dropped_out") && from !== stage && !reason?.trim()) {
      return { ok: false, message: stage === "rejected" ? "Say why they were rejected." : "Say why they dropped out." };
    }
    if (!opts.force) {
      const db0 = load();
      const check = canMove(from, stage, {
        hasInterview: db0.interviews.some(
          (i) => i.applicationId === applicationId && i.outcome !== "cancelled",
        ),
        hasPlacement: db0.placements.some((p) => p.applicationId === applicationId && !p.fellThroughAt),
        hasOffer: db0.offers.some(
          (o) => o.applicationId === applicationId && o.status !== "declined" && o.status !== "withdrawn",
        ),
      });
      if (!check.ok) return { ok: false, message: check.message };
    }

    mutate((db) => {
      const a = db.applications.find((x) => x.id === applicationId);
      if (!a) return;
      a.stage = stage;
      a.lastStageChangedAt = Date.now();
      if (stage === "rejected") {
        a.rejectedBy = actorId;
        a.rejectReason = reason ?? null;
      }
      if (stage === "dropped_out") a.droppedOutReason = reason ?? null;
      // Brought back: the old rejection no longer describes them (21 Sep).
      if ((from === "rejected" || from === "dropped_out") && stage !== "rejected" && stage !== "dropped_out") {
        a.rejectedBy = null;
        a.rejectReason = null;
        a.droppedOutReason = null;
      }

      db.pipelineEvents.push({
        id: `pe_${Math.random().toString(36).slice(2, 10)}`,
        applicationId,
        openingId: a.openingId,
        eventType: opts.eventType ?? eventTypeFor(from, stage),
        fromStage: from,
        toStage: stage,
        actorType: opts.actorType ?? "user",
        actorId,
        note: reason ?? null,
        at: Date.now(),
      });
    });
    return { ok: true };
  },

  events(applicationId: Id): PipelineEvent[] {
    return load()
      .pipelineEvents.filter((e) => e.applicationId === applicationId)
      .sort((a, b) => b.at - a.at);
  },

  /** Anything that has happened on an opening, newest first. */
  openingEvents(openingId: Id, limit = 50): PipelineEvent[] {
    return load()
      .pipelineEvents.filter((e) => e.openingId === openingId)
      .sort((a, b) => b.at - a.at)
      .slice(0, limit);
  },

  /** Records a fact that is not a stage change — a set going out, a reply
   *  landing — so the history holds the whole story. */
  logEvent(input: Omit<PipelineEvent, "id" | "at">) {
    mutate((db) => {
      db.pipelineEvents.push({
        ...input,
        id: `pe_${Math.random().toString(36).slice(2, 10)}`,
        at: Date.now(),
      });
    });
  },

  // ─── Interviews ────────────────────────────────────────────────────────────

  /**
   * Booking one is what moves the candidate, not the other way round.
   *
   * The stage cannot be entered without this record, because everything the
   * desk does afterwards hangs off the time: the confirmation chase, the
   * escalation when it is not confirmed, the reminder, and the follow-up the
   * morning after.
   */
  scheduleInterview(input: {
    applicationId: Id;
    scheduledAt: number;
    timezone: string;
    location: string;
    mode: Interview["mode"];
    interviewers: string[];
    durationMins: number | null;
    notes: string | null;
    byUserId: Id;
  }): { ok: true; id: Id } | { ok: false; message: string } {
    const app = load().applications.find((a) => a.id === input.applicationId);
    if (!app) return { ok: false, message: "That application no longer exists." };
    // Booking is a way INTO the Interview stage, not around the stages before
    // it. A New CV could be booked straight to interview, skipping the Director
    // and the client (audit finding 14). Only a client-shortlisted candidate,
    // or one already interviewing, can be booked.
    if (app.stage !== "client_shortlist" && app.stage !== "interview") {
      return { ok: false, message: "Only a candidate on the client's shortlist can be booked for an interview." };
    }
    const all = load().interviews.filter((i) => i.applicationId === input.applicationId);
    const existing = all.filter((i) => i.outcome === "pending");
    // A new round once the previous one has happened; a re-booking keeps its
    // round. Counting pending ones numbered a second interview as round 1
    // again (audit finding 15).
    const happened = all.filter((i) => i.outcome === "attended" || i.outcome === "no_show");
    const round = existing.length > 0 ? existing[0].round : happened.length + 1;
    const id = `iv_${Math.random().toString(36).slice(2, 10)}`;

    mutate((db) => {
      // Re-booking supersedes rather than stacks: one pending interview per
      // application, or the reminders fire twice.
      for (const i of db.interviews) {
        if (i.applicationId === input.applicationId && i.outcome === "pending") {
          i.outcome = "cancelled";
        }
      }
      db.interviews.push({
        id,
        applicationId: input.applicationId,
        scheduledAt: input.scheduledAt,
        timezone: input.timezone,
        location: input.location,
        mode: input.mode,
        round,
        interviewers: input.interviewers,
        durationMins: input.durationMins,
        confirmedAt: null,
        notes: input.notes,
        outcome: "pending",
        result: "pending",
        clientRating: null,
        clientFeedback: null,
        createdAt: Date.now(),
      });
    });

    this.moveStage(
      input.applicationId,
      "interview",
      input.byUserId,
      `${new Date(input.scheduledAt).toISOString()} · ${input.location}`,
      { eventType: existing.length ? "interview_rescheduled" : "interview_scheduled", force: true },
    );
    return { ok: true, id };
  },

  confirmInterview(interviewId: Id) {
    mutate((db) => {
      const i = db.interviews.find((x) => x.id === interviewId);
      if (i) i.confirmedAt = Date.now();
    });
  },

  setInterviewResult(
    interviewId: Id,
    patch: { result: Interview["result"]; clientRating: number | null; clientFeedback: string | null },
  ) {
    mutate((db) => {
      const iv = db.interviews.find((x) => x.id === interviewId);
      if (iv) Object.assign(iv, patch);
    });
  },

  setInterviewOutcome(interviewId: Id, outcome: Interview["outcome"]) {
    mutate((db) => {
      const i = db.interviews.find((x) => x.id === interviewId);
      if (i) i.outcome = outcome;
    });
  },

  pendingInterview(applicationId: Id): Interview | undefined {
    return load().interviews.find(
      (i) => i.applicationId === applicationId && i.outcome === "pending",
    );
  },

  /** Spec §6A — a logged call. `no_answer` deliberately does not clear the escalation. */
  recordCall(input: Omit<import("./types").CallFeedback, "id" | "recordedAt">) {
    mutate((db) => {
      db.callFeedback.push({
        ...input,
        id: `cf_${Math.random().toString(36).slice(2, 10)}`,
        recordedAt: Date.now(),
      });
      if (input.kind === "pre_interview" && input.outcome === "reached") {
        // Clears the 3–4h escalation, per spec §12.2a.
        for (const a of db.alerts) {
          if (
            a.kind === "interview_confirmation_escalation" &&
            a.subjectId === input.applicationId &&
            !a.resolvedAt
          ) {
            a.resolvedAt = Date.now();
          }
        }
      }
    });
  },

  // ─── Intake (spec §5) ──────────────────────────────────────────────────────

  briefs: () => load().briefs ?? [],
  brief: (id: Id) => (load().briefs ?? []).find((b) => b.id === id) ?? null,

  createBrief(b: Omit<Brief, "id">): Id {
    const id = `br_${Math.random().toString(36).slice(2, 10)}`;
    mutate((db) => {
      db.briefs = db.briefs ?? [];
      db.briefs.push({ ...b, id });
    });
    return id;
  },

  /**
   * Every brief left on an opening, oldest first — the lead's from creation and
   * each TA's own notes. Found by opening rather than through `briefId`, which
   * the Convex backend does not set when it creates the opening.
   */
  briefsForOpening(openingId: Id): Brief[] {
    return (load().briefs ?? []).filter((b) => b.openingId === openingId).sort((a, b) => a.capturedAt - b.capturedAt);
  },

  updateBrief(id: Id, patch: Partial<Brief>) {
    mutate((db) => {
      const b = (db.briefs ?? []).find((x) => x.id === id);
      if (b) Object.assign(b, patch);
    });
  },

  /**
   * Spec §5.2 — the Opening is created from the brief, the JD lands as a draft
   * awaiting TA approval, and a TA must be assigned at creation time.
   */
  createOpeningFromBrief(briefId: Id, input: {
    clientId: Id;
    jdMarkdown: string;
    taLeadId: Id;
    assignedTaIds: Id[];
    directorId: Id | null;
    /** Where the job is. Sourcing searches this market's LinkedIn. */
    country?: string;
    /** "local" for that country's own nationals, or a nationality to send there. */
    hiringFor?: string;
    targetGender?: string | null;
    autoFollowUp?: boolean;
  }): Id {
    const id = `op_${Math.random().toString(36).slice(2, 10)}`;
    mutate((db) => {
      const b = (db.briefs ?? []).find((x) => x.id === briefId);
      const e = b?.extracted;
      const n = db.openings.length + 1;
      db.openings.push({
        id,
        clientId: input.clientId,
        title: e?.title || "Untitled role",
        positionCode: `C141-${String(n).padStart(4, "0")}`,
        jobOrderNumber: `JO-2026-${String(n + 100).padStart(3, "0")}`,
        jdMarkdown: input.jdMarkdown,
        followUpQuestions: [],
        autoFollowUp: input.autoFollowUp ?? false,
        jdStatus: "pending_ta_approval",
        jdApprovedBy: null,
        jdApprovedAt: null,
        briefId,
        salaryMin: e?.salaryMin ?? null,
        salaryMax: e?.salaryMax ?? null,
        salaryCurrency: e?.currency ?? "LKR",
        packageNotes: e?.packageNotes ?? "",
        targetGender: input.targetGender ?? null,
        // "Hiring for" is whose passport, and it is not the same question as
        // where the job is: a Dhaka post may be a search for Sri Lankans. The
        // brief's own nationalities win where it named any (§8A.2).
        targetNationalities:
          e?.nationalities?.length
            ? e.nationalities
            : input.hiringFor && input.hiringFor !== "local"
              ? [input.hiringFor]
              : input.country
                ? [localNationalityOf(input.country)]
                : [],
        locations: e?.locations?.length
          ? e.locations
          : input.country
            ? [input.country]
            : [],
        headcount: e?.headcount ?? 1,
        priorityTier: e?.priorityTier ?? "P3",
        positionStatus: "active",
        assignedTaIds: input.assignedTaIds,
        taLeadId: input.taLeadId,
        directorId: input.directorId,
        requirementReceivedAt: b?.capturedAt ?? Date.now(),
        assignedAt: Date.now(),
        closedAt: null,
        valueOnProgressing: null,
        valueOfPlacement: null,
        valueLost: null,
        status: "open",
        createdAt: Date.now(),
        updatedAt: Date.now(),
      });
      if (b) b.openingId = id;
    });
    return id;
  },

  /** Spec §5.2 — the TA reads and approves; only then does the job go live. */
  approveJd(openingId: Id, userId: Id) {
    mutate((db) => {
      const o = db.openings.find((x) => x.id === openingId);
      if (!o) return;
      o.jdStatus = "approved";
      o.jdApprovedBy = userId;
      o.jdApprovedAt = Date.now();
      o.updatedAt = Date.now();
    });
  },

  /** The brief's fields land on the Opening when the TA generates the JD. */
  applyExtractedToOpening(openingId: Id, e: import("./types").ExtractedBrief) {
    mutate((db) => {
      const o = db.openings.find((x) => x.id === openingId);
      if (!o) return;
      o.salaryMin = e.salaryMin;
      o.salaryMax = e.salaryMax;
      o.salaryCurrency = e.currency;
      o.packageNotes = e.packageNotes;
      o.locations = e.locations;
      o.targetNationalities = e.nationalities;
      o.headcount = e.headcount;
      o.priorityTier = e.priorityTier;
      o.updatedAt = Date.now();
    });
  },

  updateJd(openingId: Id, jdMarkdown: string) {
    mutate((db) => {
      const o = db.openings.find((x) => x.id === openingId);
      if (o) { o.jdMarkdown = jdMarkdown; o.updatedAt = Date.now(); }
    });
  },

  // ─── Phase 7: backups and add-ons ──────────────────────────────────────────

  /**
   * Notebook page 3 — the offer goes out and is not accepted. Recording the
   * decline is what starts the backup search, so it is one operation.
   */
  declineOffer(appId: Id, reason: string, actorId: Id) {
    const now = Date.now();
    mutate((db) => {
      const a = db.applications.find((x) => x.id === appId);
      if (!a) return;
      a.stage = "dropped_out";
      a.offerDeclinedAt = now;
      a.offerDeclineReason = reason;
      a.droppedOutReason = reason;
      a.lastStageChangedAt = now;
      // The offer record has to hear about it too. Two places holding the same
      // fact is how they come to disagree — a declined candidate with an offer
      // still reading "pending" shows up in the unbilled pipeline for ever.
      for (const o of db.offers) {
        if (o.applicationId === appId && o.status === "pending") {
          o.status = "declined";
          o.respondedAt = now;
          o.declineReason = reason;
        }
      }
      void actorId;
    });
  },

  /** Spec §12.1 — an add-on notifies the TA and the lead. */
  setAddOn(appId: Id, on: boolean) {
    mutate((db) => {
      const a = db.applications.find((x) => x.id === appId);
      if (!a) return;
      a.isAddOn = on;
      a.addedOnAt = on ? Date.now() : null;
    });
  },

  promoteBackup(appId: Id, forApplicationId: Id) {
    mutate((db) => {
      const a = db.applications.find((x) => x.id === appId);
      if (!a) return;
      a.backupForApplicationId = forApplicationId;
      if (a.stage === "new_cv" || a.stage === "matched") a.stage = "ta_follow_up";
      a.lastStageChangedAt = Date.now();
    });
  },

  /** Offers that fell through and still have nobody lined up behind them. */
  openDeclines(openingId?: Id) {
    const db = load();
    return db.applications.filter(
      (a) =>
        a.offerDeclinedAt &&
        (openingId ? a.openingId === openingId : true) &&
        !db.applications.some((x) => x.backupForApplicationId === a.id),
    );
  },

  /** Spec §4.2 — on hold, closed, reopened. */
  setOpeningStatus(openingId: Id, status: Opening["status"]) {
    mutate((db) => {
      const o = db.openings.find((x) => x.id === openingId);
      if (!o) return;
      o.status = status;
      // One status, stated twice for the Master Sheet — so they must never
      // disagree. Closing a held role used to leave it "hold" (audit finding 33).
      o.positionStatus =
        status === "open" ? "active" : status === "on_hold" ? "hold" : status === "filled" ? "filled" : "lost";
      o.closedAt = status === "closed" || status === "filled" ? Date.now() : null;
      o.updatedAt = Date.now();
    });
  },

  addClient(input: {
    name: string;
    industry: string;
    contacts?: Client["contacts"];
    esaSignedAt?: number | null;
  }): Id {
    const id = `cl_${Math.random().toString(36).slice(2, 10)}`;
    mutate((db) => {
      db.clients.push({
        id,
        name: input.name,
        industry: input.industry,
        contacts: input.contacts ?? [],
        esaSignedAt: input.esaSignedAt ?? null,
        status: "active",
        createdAt: Date.now(),
      });
    });
    return id;
  },

  updateClient(id: Id, patch: Partial<Omit<Client, "id" | "createdAt">>) {
    mutate((db) => {
      const c = db.clients.find((x) => x.id === id);
      if (c) Object.assign(c, patch);
    });
  },

  /**
   * Refused while the client still has openings. A cascade here would take
   * candidates, shortlists and a year of outreach history with it, and nobody
   * deleting a duplicate client record means to do that.
   */
  deleteClient(id: Id): { ok: true } | { ok: false; openings: number } {
    const held = load().openings.filter((o) => o.clientId === id).length;
    if (held > 0) return { ok: false, openings: held };
    mutate((db) => {
      db.clients = db.clients.filter((c) => c.id !== id);
    });
    return { ok: true };
  },

  setContacts(clientId: Id, contacts: Client["contacts"]) {
    mutate((db) => {
      const c = db.clients.find((x) => x.id === clientId);
      if (!c) return;
      // Exactly one primary, always — the clients list reads [0] as the one to
      // print and a list with two primaries prints whichever sorted first.
      const cleaned = contacts.filter((x) => x.name.trim());
      if (cleaned.length && !cleaned.some((x) => x.isPrimary)) cleaned[0].isPrimary = true;
      let seen = false;
      for (const x of cleaned) {
        if (x.isPrimary && seen) x.isPrimary = false;
        if (x.isPrimary) seen = true;
      }
      c.contacts = cleaned;
    });
  },

  // ─── Deletes (12 Sep sweep, finding 02) ───────────────────────────────────

  /**
   * An opening and everything filed under it. This is the one genuinely
   * destructive action in the product, so it is deliberate rather than
   * convenient: the caller has to have confirmed, and what goes is listed back
   * so the confirmation could say what it was about to take.
   */
  deleteOpening(
    id: Id,
  ): { ok: true; applications: number; posts: number; links: number; suggestions: number } | { ok: false; message: string } {
    const db0 = load();
    // A role that reached an offer or a placement is history the desk has to
    // keep. It is closed, not deleted.
    if (db0.offers.some((o) => o.openingId === id) || db0.placements.some((p) => p.openingId === id)) {
      return { ok: false, message: "This opening has an offer or a placement on it. Close it instead — that record has to stay." };
    }
    const count = {
      applications: db0.applications.filter((a) => a.openingId === id).length,
      posts: db0.jobPosts.filter((p) => p.openingId === id).length,
      links: db0.linkVault.filter((l) => l.openingId === id).length,
      suggestions: db0.suggestions.filter((x) => x.openingId === id).length,
    };
    mutate((db) => {
      const appIds = new Set(db.applications.filter((a) => a.openingId === id).map((a) => a.id));
      const gone = (appId: Id) => appIds.has(appId);
      db.openings = db.openings.filter((o) => o.id !== id);
      db.applications = db.applications.filter((a) => a.openingId !== id);
      db.jobPosts = db.jobPosts.filter((p) => p.openingId !== id);
      db.linkVault = db.linkVault.filter((l) => l.openingId !== id);
      db.suggestions = db.suggestions.filter((x) => x.openingId !== id);
      db.benchmarks = db.benchmarks.filter((b) => b.openingId !== id);
      db.researchReports = db.researchReports.filter((r) => r.openingId !== id);
      db.chat = db.chat.filter((c) => c.openingId !== id);
      db.jdChat = db.jdChat.filter((c) => c.openingId !== id);
      db.callFeedback = db.callFeedback.filter((f) => !gone(f.applicationId));
      db.interviews = db.interviews.filter((i) => !gone(i.applicationId));
      db.alerts = db.alerts.filter((a) => a.subjectId !== id && !gone(a.subjectId));
      // Everything else that pointed at it, which the first version left behind
      // (audit finding 39).
      db.reviewRounds = db.reviewRounds.filter((r) => r.openingId !== id);
      db.pipelineEvents = db.pipelineEvents.filter((e) => e.openingId !== id);
      db.outreach = db.outreach.filter((m) => !gone(m.applicationId));
      db.aiCalls = db.aiCalls.filter((c) => c.openingId !== id);
      db.assignments = db.assignments.filter((a) => a.openingId !== id);
      db.esaRecords = db.esaRecords.filter((e) => e.openingId !== id);
      // A CV that came in for this job is still a CV. It stays, without a job.
      for (const item of db.intake) {
        if (item.openingId === id) {
          item.openingId = null;
          item.jobPostId = null;
        }
      }
    });
    return { ok: true, ...count };
  },

  updateOpening(id: Id, patch: Partial<Opening>) {
    mutate((db) => {
      const o = db.openings.find((x) => x.id === id);
      if (o) Object.assign(o, patch);
    });
  },

  /** Applications keep the pool but lose their post, so nobody is deleted by
   *  deleting a post. */
  deleteJobPost(postId: Id): number {
    let orphaned = 0;
    mutate((db) => {
      db.jobPosts = db.jobPosts.filter((p) => p.id !== postId);
      for (const a of db.applications) {
        if (a.jobPostId === postId) {
          a.jobPostId = null;
          orphaned += 1;
        }
      }
    });
    return orphaned;
  },

  deleteLink(entryId: Id) {
    mutate((db) => {
      db.linkVault = db.linkVault.filter((l) => l.id !== entryId);
    });
  },

  /** Removes one person from one opening. The candidate stays in the database. */
  removeApplication(appId: Id): { ok: true } | { ok: false; message: string } {
    const db0 = load();
    if (db0.offers.some((o) => o.applicationId === appId) || db0.placements.some((p) => p.applicationId === appId)) {
      return { ok: false, message: "They have an offer or a placement on this opening, so they stay on it. Mark them rejected or dropped out instead." };
    }
    mutate((db) => {
      // A database match somebody took off is not matched to this opening again.
      const gone = db.applications.find((a) => a.id === appId);
      if (gone && gone.stage === "matched" && !db.matchExclusions.some((x) => x.openingId === gone.openingId && x.candidateId === gone.candidateId)) {
        db.matchExclusions.push({ openingId: gone.openingId, candidateId: gone.candidateId, at: Date.now() });
      }
      db.applications = db.applications.filter((a) => a.id !== appId);
      db.callFeedback = db.callFeedback.filter((f) => f.applicationId !== appId);
      db.interviews = db.interviews.filter((i) => i.applicationId !== appId);
      db.alerts = db.alerts.filter((a) => a.subjectId !== appId);
      db.outreach = db.outreach.filter((m) => m.applicationId !== appId);
      db.aiCalls = db.aiCalls.filter((c) => c.applicationId !== appId);
      db.pipelineEvents = db.pipelineEvents.filter((e) => e.applicationId !== appId);
      // Out of any set that went for review, so a reply's numbers still line up
      // with the people who remain.
      for (const r of db.reviewRounds) {
        if (r.applicationIds.includes(appId)) {
          r.applicationIds = r.applicationIds.filter((x) => x !== appId);
          r.decisions = r.decisions.filter((d) => d.applicationId !== appId);
        }
      }
    });
    return { ok: true };
  },

  /** Finding 13 — the contact controls on a candidate had no handler. */
  /** The follow-up figures, typed in by a TA who got them some other way. */
  updateCandidate(
    candidateId: Id,
    patch: Partial<Pick<Candidate, "currentSalary" | "expectedSalary" | "noticePeriodDays">>,
  ) {
    if (Object.keys(patch).length === 0) return;
    mutate((db) => {
      const c = db.candidates.find((x) => x.id === candidateId);
      if (c) Object.assign(c, patch);
    });
  },

  /** A note on one application, signed and dated, as the notes on the CV tab read. */
  addApplicationNote(applicationId: Id, text: string, byUserId: Id): { ok: boolean } {
    const note = text.trim().slice(0, 1000);
    if (!note) return { ok: false };
    let found = false;
    mutate((db) => {
      const a = db.applications.find((x) => x.id === applicationId);
      if (!a) return;
      found = true;
      const who = db.users.find((u) => u.id === byUserId)?.name ?? "A TA";
      const day = new Date().toLocaleDateString("en-GB", { timeZone: "Asia/Colombo", day: "numeric", month: "short" });
      a.notes.push(`${note} — ${who}, ${day}`);
    });
    return { ok: found };
  },

  updateCandidateContact(candidateId: Id, patch: { email?: string | null; phone?: string | null }) {
    mutate((db) => {
      const c = db.candidates.find((x) => x.id === candidateId);
      if (c) Object.assign(c, patch);
    });
  },

  /** Custom detail lines / notes saved from Director review */
  setApplicationDirectorNotes(applicationId: Id, notes: string[]) {
    mutate((db) => {
      const a = db.applications.find((x) => x.id === applicationId);
      if (!a) return;
      // Preserve internal historical / match notes if any
      const systemNotes = (a.notes ?? []).filter((n) => /^Matched from the database/i.test(n) || /^>Historical/i.test(n));
      a.notes = [...systemNotes, ...notes];
    });
  },

  /** Atomic update of both Director notes and candidate review details */
  saveReviewDetails(
    applicationId: Id,
    candidateId: Id,
    notes: string[],
    patch: Partial<Pick<Candidate, "currentSalary" | "expectedSalary" | "noticePeriodDays">>,
  ) {
    mutate((db) => {
      const a = db.applications.find((x) => x.id === applicationId);
      if (a) {
        const systemNotes = (a.notes ?? []).filter((n) => /^Matched from the database/i.test(n) || /^>Historical/i.test(n));
        a.notes = [...systemNotes, ...notes];
      }
      const c = db.candidates.find((x) => x.id === candidateId);
      if (c) {
        Object.assign(c, patch);
      }
    });
  },

  // ─── People (finding 11) ──────────────────────────────────────────────────

  addUser(input: {
    name: string;
    email: string;
    phone: string | null;
    /** Set at onboarding. Generated from the name when left blank, so a TA is
     *  never created without somewhere for their applications to land. */
    routingEmail?: string | null;
    role: User["role"];
  }): Id {
    const id = `u_${Math.random().toString(36).slice(2, 10)}`;
    mutate((db) => {
      db.users.push({
        id,
        name: input.name,
        email: input.email,
        phone: input.phone,
        // A recruiter gets a mailbox their adverts point at; nobody else needs
        // one, and an address on a director is an address nothing delivers to.
        routingEmail:
          input.routingEmail ??
          (input.role === "ta" || input.role === "ta_lead"
            ? `${input.name.toLowerCase().replace(/[^a-z]/g, "")}.jobs@career141.com`
            : null),
        role: input.role,
        initials: input.name.split(/\s+/).map((p) => p[0]).join("").slice(0, 2).toUpperCase(),
        isActive: true,
      });
    });
    return id;
  },

  updateUser(id: Id, patch: Partial<Omit<User, "id">>) {
    mutate((db) => {
      const u = db.users.find((x) => x.id === id);
      if (!u) return;
      Object.assign(u, patch);
      if (patch.name) u.initials = patch.name.split(/\s+/).map((p) => p[0]).join("").slice(0, 2).toUpperCase();
    });
  },

  /** Nobody is deleted — a name on a year of stage changes and call logs has to
   *  keep resolving. Deactivating takes them off the pickers instead. */
  setUserActive(id: Id, active: boolean) {
    mutate((db) => {
      const u = db.users.find((x) => x.id === id);
      if (u) u.isActive = active;
    });
  },

  /** Top-nav search — openings and candidates by name. */
  search(q: string, rankedIds: Id[] = []) {
    const db = load();
    const n = q.trim().toLowerCase();
    if (!n) return { openings: [], candidates: [] };
    // People the database search ranked, in its order, then any loaded row that matches.
    const ranked = rankedIds.map((id) => db.candidates.find((c) => c.id === id)).filter((c): c is Candidate => !!c);
    const clientName = (id: Id) => db.clients.find((c) => c.id === id)?.name ?? "";
    return {
      openings: db.openings
        .filter((o) => `${o.title} ${clientName(o.clientId)}`.toLowerCase().includes(n))
        .slice(0, 8),
      candidates: [...new Set([...ranked, ...db.candidates
        .filter((c) => `${c.fullName} ${c.currentEmployer ?? ""} ${c.currentTitle ?? ""}`.toLowerCase().includes(n))])]
        .slice(0, 12)
        .map((c) => ({
          candidate: c,
          application: db.applications.find((a) => a.candidateId === c.id) ?? null,
        })),
    };
  },

  addTaToOpening(openingId: Id, taId: Id) {
    mutate((db) => {
      const o = db.openings.find((x) => x.id === openingId);
      if (o && !o.assignedTaIds.includes(taId)) o.assignedTaIds.push(taId);
    });
  },

  removeTaFromOpening(openingId: Id, taId: Id) {
    mutate((db) => {
      const o = db.openings.find((x) => x.id === openingId);
      if (o) o.assignedTaIds = o.assignedTaIds.filter((id) => id !== taId);
    });
  },

  /** `createdBy` is a TA creating their own post — it is theirs from the first
   *  write, which is what the visibility rule reads. A lead creating one leaves
   *  it on the opening's single TA, or unassigned for them to hand out. */
  addJobPost(
    openingId: Id,
    title: string,
    createdBy?: Id,
    liveOnLinkedIn = false,
    channel: JobPost["channel"] = "linkedin",
    externalUrl?: string | null,
  ): { ok: true } | { ok: false; message: string } {
    const opening = load().openings.find((x) => x.id === openingId);
    if (!opening) return { ok: false, message: "That opening no longer exists." };
    // "A job cannot go live until its JD is approved" was a promise the
    // interface made and the store did not keep.
    if (liveOnLinkedIn && opening.jdStatus !== "approved") {
      return { ok: false, message: JD_NOT_APPROVED };
    }
    // The same post twice (a double submit, or added from both the rail and
    // the post manager) showed up as duplicate rows under LinkedIn Job. Posts
    // with the same title for another recruiter, region or channel are normal
    // and still allowed.
    const owner =
      createdBy && opening.assignedTaIds.includes(createdBy)
        ? createdBy
        : opening.assignedTaIds.length === 1
          ? opening.assignedTaIds[0]
          : createdBy ?? opening.assignedTaIds[0] ?? null;
    const twin = load().jobPosts.find(
      (p) =>
        p.openingId === openingId &&
        p.title.trim().toLowerCase() === title.trim().toLowerCase() &&
        p.channel === channel &&
        p.assignedTaId === owner &&
        p.country === (opening.locations[0] ?? null),
    );
    if (twin) return { ok: false, message: `There is already a post called "${twin.title}" on this job.` };
    mutate((db) => {
      const o = db.openings.find((x) => x.id === openingId);
      if (!o) return;
      const client = db.clients.find((c) => c.id === o.clientId);
      const slug = (client?.name ?? "job").toLowerCase().replace(/[^a-z0-9]+/g, "").slice(0, 6);
      db.jobPosts.push({
        id: `jp_${Math.random().toString(36).slice(2, 10)}`,
        openingId,
        title,
        previousTitles: [],
        aliasKeywords: [],
        country: o.locations[0] ?? null,
        city: null,
        channel,
        campaignCode: makeCampaignCode(title, db.jobPosts.map((x) => x.campaignCode)),
        routingEmailAlias: `jobs+${slug}-${db.jobPosts.length + 1}@career141.com`,
        // Every post belongs to a mailbox. A post with nobody on it was never
        // matched to anything — applicants went to no one. Whoever creates it
        // owns it unless the opening has exactly one recruiter to give it to.
        assignedTaId:
          createdBy && o.assignedTaIds.includes(createdBy)
            ? createdBy
            : o.assignedTaIds.length === 1
              ? o.assignedTaIds[0]
              : createdBy ?? o.assignedTaIds[0] ?? null,
        externalUrl: externalUrl ?? null,
        // Whether the advert is up decides two things: whether applications to
        // this TA's inbox get filed against it, and whether it is chased for
        // going quiet. Both are meaningless for an advert nobody can apply to.
        postedAt: liveOnLinkedIn ? Date.now() : null,
        status: liveOnLinkedIn ? "live" : "draft",
        cvCountToday: 0,
        createdAt: Date.now(),
      });
    });
    return { ok: true };
  },

  // ─── Job posts (spec §4.3, §9) ─────────────────────────────────────────────

  updatePost(
    postId: Id,
    patch: Partial<import("./types").JobPost>,
  ): { ok: true } | { ok: false; message: string } {
    const db0 = load();
    const post = db0.jobPosts.find((x) => x.id === postId);
    if (!post) return { ok: false, message: "That post no longer exists." };
    if (patch.status === "live" && post.status !== "live") {
      const opening = db0.openings.find((o) => o.id === post.openingId);
      if (opening?.jdStatus !== "approved") return { ok: false, message: JD_NOT_APPROVED };
    }
    // The counter is derived, never written — see `cvsToday`.
    const { cvCountToday: _ignored, ...rest } = patch;
    void _ignored;
    mutate((db) => {
      const p = db.jobPosts.find((x) => x.id === postId);
      if (!p) return;
      // A renamed advert keeps answering to its old title (posting type 4).
      if (rest.title && rest.title.trim() && rest.title.trim() !== p.title) {
        p.previousTitles = [...new Set([...(p.previousTitles ?? []), p.title])];
      }
      Object.assign(p, rest);
      if (rest.status === "live" && !p.postedAt) p.postedAt = Date.now();
    });
    return { ok: true };
  },

  /**
   * Spec §6.1 / notebook page 6 — when a paused post is reactivated the desk
   * wants the CVs it already gathered. Moving them is one operation rather than
   * re-sourcing, and the applications keep their stage and ownership.
   */
  transferApplications(fromPostId: Id, toPostId: Id): number {
    let moved = 0;
    mutate((db) => {
      for (const a of db.applications) {
        if (a.jobPostId === fromPostId) {
          a.jobPostId = toPostId;
          moved++;
        }
      }
    });
    return moved;
  },

  updateLink(entryId: Id, patch: Partial<LinkVaultEntry>) {
    mutate((db) => {
      const e = db.linkVault.find((l) => l.id === entryId);
      if (e) Object.assign(e, patch);
    });
  },

  logOutreach(entryId: Id, by: Id, channel: string, note: string) {
    mutate((db) => {
      const e = db.linkVault.find((l) => l.id === entryId);
      if (!e) return;
      e.conversationLog.push({ at: Date.now(), channel, note, by });
      if (e.outcome === "no_contact") e.outcome = "contacted";
    });
  },

  toggleEyeMark(entryId: Id) {
    mutate((db) => {
      const e = db.linkVault.find((l) => l.id === entryId);
      if (e) e.isEyeMarked = !e.isEyeMarked;
    });
  },

  /** The same person pasted twice, or pasted and then captured, is one row. */
  findLinkByUrl(openingId: Id, canonical: string): LinkVaultEntry | undefined {
    // By the profile's key, not a substring: "linkedin.com/in/nimal" is inside
    // "linkedin.com/in/nimal-perera", and they are different people.
    const want = canonical.toLowerCase();
    return load().linkVault.find(
      (l) => l.openingId === openingId && (profileLink(l.linkedinUrl)?.key ?? l.linkedinUrl.toLowerCase()) === want,
    );
  },

  /**
   * A shortlisted headhunted person, onto the opening's pipeline.
   *
   * Headhunting has no CV intake: the TA found them on LinkedIn, talked to
   * them and shortlisted them in Excel Tables. This makes them a candidate (or
   * reuses the one the row already points at, or one with the same LinkedIn
   * profile), puts them on the opening at Follow-up, and ties the row to them.
   * The caller then moves them to Director Review through the normal stage
   * rules, so the same checks apply as for anyone else.
   */
  linkToApplication(entryId: Id, byUserId: Id):
    | { ok: true; applicationId: Id; stage: Stage }
    | { ok: false; message: string } {
    const db = load();
    const e = db.linkVault.find((l) => l.id === entryId);
    if (!e) return { ok: false, message: "That row no longer exists." };
    if (e.outcome !== "shortlisted") return { ok: false, message: "Set the outcome to Shortlisted first." };
    const name = (e.name ?? e.capture?.fullName ?? "").trim();
    if (!name) return { ok: false, message: "Add their name first (Change outcome ⇕ → Name)." };

    const profile = (u: string | null | undefined) => (u ?? "").toLowerCase().replace(/^https?:\/\/(www\.)?/, "").replace(/[/?#].*$|\/+$/, "");
    const sameProfile = (c: Candidate) => {
      const a = profile(c.linkedinUrl);
      const b = profile(e.linkedinUrl);
      return Boolean(a) && a === b;
    };
    const existingCandidate =
      (e.candidateId && db.candidates.find((c) => c.id === e.candidateId)) ||
      (profile(e.linkedinUrl).includes("linkedin.com/in") ? db.candidates.find(sameProfile) : undefined);
    const candidateId = existingCandidate?.id ?? `ca_${Math.random().toString(36).slice(2, 10)}`;
    const onOpening = db.applications.find((a) => a.candidateId === candidateId && a.openingId === e.openingId);
    if (onOpening) {
      if (e.candidateId !== candidateId) mutate((d) => { const row = d.linkVault.find((l) => l.id === entryId); if (row) row.candidateId = candidateId; });
      return { ok: true, applicationId: onOpening.id, stage: onOpening.stage };
    }

    const targetStage: Stage = "ta_follow_up";
    const by = db.users.find((u) => u.id === byUserId)?.name ?? "a TA";
    const now = Date.now();
    const applicationId = `app_${Math.random().toString(36).slice(2, 10)}`;
    mutate((d) => {
      if (!existingCandidate) {
        const cap = e.capture ?? null;
        d.candidates.push({
          id: candidateId,
          fullName: name,
          email: null,
          phone: e.phoneNumber,
          linkedinUrl: e.linkedinUrl,
          location: cap?.location ?? null,
          nationality: null,
          age: null,
          gender: null,
          currentEmployer: e.company ?? cap?.currentCompany ?? null,
          currentTitle: e.title ?? cap?.currentTitle ?? null,
          totalExperienceYears: null,
          educationDegree: null,
          educationInstitution: null,
          qualifications: null,
          englishLevel: null,
          languages: [],
          skills: [],
          industries: [],
          noticePeriodDays: null,
          currentSalary: null,
          expectedSalary: null,
          cvFileName: null,
          workHistory: [],
          createdAt: now,
        });
      }
      d.applications.push({
        id: applicationId,
        openingId: e.openingId,
        jobPostId: null,
        candidateId,
        stage: targetStage,
        answers: {},
        sourcingChannel: e.sourcingChannel,
        ownerTaId: null,
        shortlistedAt: null,
        setNumber: null,
        rating: null,
        notes: [`Headhunted — shortlisted in Excel Tables by ${by}`],
        statusA: null,
        statusB: null,
        rankTier: null,
        rankWeight: null,
        isAddOn: false,
        addedOnAt: null,
        backupForApplicationId: null,
        offerDeclinedAt: null,
        offerDeclineReason: null,
        rejectedBy: null,
        rejectReason: null,
        droppedOutReason: null,
        createdAt: now,
        lastStageChangedAt: now,
      });
      const row = d.linkVault.find((l) => l.id === entryId);
      if (row) row.candidateId = candidateId;
    });
    return { ok: true, applicationId: realId(applicationId), stage: targetStage };
  },

  /**
   * A new Excel Tables row. Saved from the extension, pasted, or kept from
   * Suggestions, the person arrives Shortlisted: someone chose them on purpose,
   * and "Not contacted" made every saved profile look untouched (21 September).
   * Shortlisted also marks the row as this TA's, so a colleague sees it is taken.
   */
  addLink(openingId: Id, url: string, addedBy: Id, name: string | null = null, outcome: LinkOutcome = "shortlisted"): Id {
    const id = `lv_${Math.random().toString(36).slice(2, 10)}`;
    mutate((db) => {
      db.linkVault.push({
        id,
        openingId,
        addedBy,
        linkedinUrl: url,
        name,
        title: null,
        company: null,
        isEyeMarked: false,
        phoneNumber: null,
        phoneSource: null,
        sourcingChannel: "L",
        outcome,
        candidateId: null,
        conversationLog: [],
        createdAt: Date.now(),
      });
    });
    return id;
  },

  // ─── Assignments — what someone is on an opening ──────────────────────────

  /**
   * Openings created before assignments existed carry their team in
   * `assignedTaIds`, `taLeadId` and `directorId`. Rather than migrate the data
   * and risk losing it, the roles are derived on read when no explicit
   * assignment has been made: first TA is the primary, the rest support.
   */
  assignments(openingId: Id): Assignment[] {
    const db = load();
    const explicit = db.assignments.filter((a) => a.openingId === openingId);
    if (explicit.length) return explicit;

    const o = db.openings.find((x) => x.id === openingId);
    if (!o) return [];
    const derived: Assignment[] = o.assignedTaIds.map((userId, i) => ({
      id: `as_derived_${openingId}_${userId}`,
      openingId,
      userId,
      role: (i === 0 ? "primary_recruiter" : "supporting_recruiter") as AssignmentRole,
      assignedAt: o.assignedAt ?? o.createdAt,
      assignedBy: null,
    }));
    if (o.directorId) {
      derived.push({
        id: `as_derived_${openingId}_${o.directorId}`,
        openingId,
        userId: o.directorId,
        role: "director",
        assignedAt: o.assignedAt ?? o.createdAt,
        assignedBy: null,
      });
    }
    return derived;
  },

  assignmentFor(openingId: Id, userId: Id): Assignment | undefined {
    return this.assignments(openingId).find((a) => a.userId === userId);
  },

  /** Replaces the whole team in one write, and keeps `assignedTaIds` in step
   *  because the rest of the product reads that for "who is on this". */
  setAssignments(
    openingId: Id,
    rows: { userId: Id; role: AssignmentRole }[],
    byUserId: Id,
  ) {
    // The rule lives here as well as in the action. A team with nobody
    // recruiting it is not a team, and a guard that only exists in one form
    // handler stops being a guard the moment anything else calls this.
    const recruiters = rows.filter(
      (r) => r.role === "primary_recruiter" || r.role === "supporting_recruiter",
    );
    if (rows.length > 0 && recruiters.length === 0) return;

    mutate((db) => {
      db.assignments = db.assignments.filter((a) => a.openingId !== openingId);
      for (const r of rows) {
        if (!r.userId) continue;
        db.assignments.push({
          id: `as_${Math.random().toString(36).slice(2, 10)}`,
          openingId,
          userId: r.userId,
          role: r.role,
          assignedAt: Date.now(),
          assignedBy: byUserId,
        });
      }
      const o = db.openings.find((x) => x.id === openingId);
      if (o) {
        o.assignedTaIds = rows
          .filter((r) => r.role === "primary_recruiter" || r.role === "supporting_recruiter")
          .map((r) => r.userId);
        const director = rows.find((r) => r.role === "director");
        o.directorId = director?.userId ?? o.directorId;
        o.updatedAt = Date.now();
      }
    });
  },

  /** The TA's working stage on an opening (100% / Follow-up / Add-on). Defaults to "100%". */
  workingStage(openingId: Id, userId: Id): WorkingStage {
    const a = this.assignmentFor(openingId, userId);
    return a?.workingStage ?? "100%";
  },

  /** Update the TA's working stage for this opening. Only someone on the job has one. */
  setWorkingStage(openingId: Id, userId: Id, stage: WorkingStage) {
    const team = this.assignments(openingId);
    if (!team.some((x) => x.userId === userId)) return;
    mutate((db) => {
      // An older opening's team is derived on read (assignments above) until
      // one row is stored, and then only stored rows count — so store the
      // whole team, or the others would drop off it.
      if (!db.assignments.some((x) => x.openingId === openingId)) {
        for (const x of team) db.assignments.push({ ...x, id: `as_${Math.random().toString(36).slice(2, 10)}` });
      }
      const a = db.assignments.find((x) => x.openingId === openingId && x.userId === userId);
      if (a) a.workingStage = stage;
    });
  },

  // ─── Review rounds — the director and client round trip ───────────────────

  /**
   * A set going out for a decision.
   *
   * Nothing is emailed from here. `dispatch: "held"` is the default and stays
   * that way until the systems are merged and the mailbox is connected — the
   * record, the token and the parsing all work now, so that switching sending
   * on is a configuration change rather than a build.
   */
  openReviewRound(input: {
    openingId: Id;
    kind: ReviewRound["kind"];
    applicationIds: Id[];
    setNumber: number | null;
    sentBy: Id;
    sentTo: string;
    trackedAt?: string | null;
    subject: string;
    dispatch?: ReviewRound["dispatch"];
  }): ReviewRound {
    // Short, unambiguous, and readable in a subject line. Excludes the letters
    // that are misread when somebody retypes one by hand.
    const token = `C141-${Array.from({ length: 6 }, () =>
      "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"[Math.floor(Math.random() * 32)],
    ).join("")}`;

    const round: ReviewRound = {
      id: `rr_${Math.random().toString(36).slice(2, 10)}`,
      openingId: input.openingId,
      kind: input.kind,
      token,
      // Filled when a mailbox is connected and the mail actually leaves.
      messageId: null,
      setNumber: input.setNumber,
      applicationIds: input.applicationIds,
      sentBy: input.sentBy,
      sentAt: Date.now(),
      sentTo: input.sentTo,
      trackedAt: input.trackedAt ?? null,
      subject: input.subject,
      dispatch: input.dispatch ?? "held",
      status: "awaiting",
      returnedAt: null,
      replyBody: null,
      decisions: [],
    };

    mutate((db) => {
      db.reviewRounds.push(round);
      for (const appId of input.applicationIds) {
        db.pipelineEvents.push({
          id: `pe_${Math.random().toString(36).slice(2, 10)}`,
          applicationId: appId,
          openingId: input.openingId,
          eventType: "sent_for_review",
          fromStage: null,
          toStage: null,
          actorType: "user",
          actorId: input.sentBy,
          note: `Sent to the ${input.kind} — ${token}`,
          at: Date.now(),
        });
      }
    });
    return round;
  },

  /** Every round, or one opening's. The unfiltered form is what places a reply
   *  arriving in the shared box, which does not know which opening it is for. */
  reviewRounds(openingId?: Id): ReviewRound[] {
    const rows = load().reviewRounds;
    return (openingId ? rows.filter((r) => r.openingId === openingId) : rows).sort(
      (a, b) => b.sentAt - a.sentAt,
    );
  },

  reviewRound(id: Id): ReviewRound | undefined {
    return load().reviewRounds.find((r) => r.id === id);
  },

  /** Matching an inbound reply to the set it answers. The token first, because
   *  it survives a forward; the thread only as a fallback. */
  roundByToken(token: string): ReviewRound | undefined {
    const t = token.trim().toUpperCase();
    return load().reviewRounds.find((r) => r.token.toUpperCase() === t);
  },

  /**
   * The decision coming back, and the moves it causes.
   *
   * Shortlisted goes to the stage the reviewer owns — the director's shortlist
   * or the client's. Rejected is recorded with the reviewer as the actor, not
   * the TA who happened to open the email. Held is left where it is, because a
   * maybe is not an instruction.
   */
  /**
   * Apply a reviewer's decisions to the people they were actually sent.
   *
   * Three things this refuses to do, all of them found by the 13 September
   * audit, all of them ways a reply could quietly undo real work:
   *
   *   **It does not forget the last reply.** Decisions merge into the round
   *   rather than replacing it, because directors answer in two goes — "take 1
   *   and 3" on Tuesday, "2 is a no" on Wednesday — and replacing meant the
   *   round still looked half-answered and Tuesday's decision vanished.
   *
   *   **It does not move somebody who has moved on.** A reply that arrives
   *   after the candidate has been placed is out of date, not authoritative. A
   *   decision is applied only while the person is still where the round left
   *   them.
   *
   *   **It does not apply the same decision twice.** Pasting a reply again is
   *   something people do when they are not sure it took.
   */
  applyReviewDecisions(
    roundId: Id,
    decisions: ReviewDecision[],
    replyBody: string | null,
  ): { moved: number; rejected: number; held: number; stale: number; repeated: number } {
    const round = load().reviewRounds.find((r) => r.id === roundId);
    if (!round) return { moved: 0, rejected: 0, held: 0, stale: 0, repeated: 0 };

    const shortlistStage: Stage =
      round.kind === "director" ? "director_shortlist" : "client_shortlist";

    /** Where somebody must still be for this round's answer to mean anything. */
    const awaiting: Stage[] =
      round.kind === "director"
        ? ["director_review", "ai_follow_up", "ta_follow_up", "follow_up" as Stage, "new_cv", "matched"]
        : ["director_shortlist"];

    const already = new Map((round.decisions ?? []).map((d) => [d.applicationId, d]));

    let moved = 0;
    let rejected = 0;
    let held = 0;
    let stale = 0;
    let repeated = 0;

    const applied: ReviewDecision[] = [];

    for (const d of decisions) {
      if (!round.applicationIds.includes(d.applicationId)) continue;

      const prior = already.get(d.applicationId);
      if (prior && prior.outcome === d.outcome) {
        repeated += 1;
        continue;
      }

      if (d.outcome === "hold") {
        held += 1;
        applied.push(d);
        continue;
      }

      const app = this.application(d.applicationId);
      if (!app) continue;
      if (!awaiting.includes(app.stage)) {
        // They have been placed, interviewed, offered or already decided. A
        // late reply does not reach back and undo that.
        stale += 1;
        continue;
      }

      const target: Stage = d.outcome === "shortlisted" ? shortlistStage : "rejected";
      const res = this.moveStage(d.applicationId, target, null, d.note ?? undefined, {
        actorType: round.kind,
        eventType: d.outcome === "shortlisted"
          ? (round.kind === "director" ? "director_shortlisted" : "client_shortlisted")
          : (round.kind === "director" ? "rejected" : "client_passed"),
        // The reviewer's decision is the authority for the step they were asked
        // about. It is not authority to move somebody who has moved on, which
        // is what `awaiting` above has already settled.
        force: true,
      });
      if (res.ok) {
        applied.push(d);
        if (d.outcome === "shortlisted") moved += 1;
        else rejected += 1;
      }
    }

    mutate((db) => {
      const r = db.reviewRounds.find((x) => x.id === roundId);
      if (!r) return;
      // Merge, so a second reply completes the round instead of replacing it.
      const merged = new Map((r.decisions ?? []).map((d) => [d.applicationId, d]));
      for (const d of applied) merged.set(d.applicationId, d);
      r.decisions = [...merged.values()];
      r.replyBody = [r.replyBody, replyBody].filter(Boolean).join("\n\n---\n\n") || null;
      r.returnedAt = Date.now();
      const decided = r.decisions.filter((d) => d.outcome !== "hold").length;
      r.status = decided >= r.applicationIds.length ? "returned" : "partial";
    });

    return { moved, rejected, held, stale, repeated };
  },

  /**
   * Everyone waiting on a reviewer's decision for an opening, as one list.
   *
   * Replies are read against this rather than against one set (13 September):
   * sets are how the Director and the client read the email, not something a
   * reply has to be matched to. The newest email's people come first, in the
   * order that email numbered them, so "1 and 3" means what the reviewer was
   * looking at; anyone still waiting from an earlier email follows.
   */
  waitingOn(openingId: Id, kind: ReviewRound["kind"]): { applicationId: Id; roundId: Id }[] {
    const rounds = load()
      .reviewRounds.filter((r) => r.openingId === openingId && r.kind === kind && r.status !== "returned")
      .sort((a, b) => b.sentAt - a.sentAt);
    const seen = new Set<Id>();
    const out: { applicationId: Id; roundId: Id }[] = [];
    for (const r of rounds) {
      const decided = new Set(r.decisions.filter((d) => d.outcome !== "hold").map((d) => d.applicationId));
      for (const id of r.applicationIds) {
        if (seen.has(id) || decided.has(id)) continue;
        seen.add(id);
        out.push({ applicationId: id, roundId: r.id });
      }
    }
    return out;
  },

  /** Apply a reply's decisions to whichever email each person went out in. */
  /**
   * The people a reply answers, numbered exactly as the email numbered them:
   * one round (the newest still open, unless named), in its original order,
   * decided people included so numbers never shift (13 September review).
   */
  replyRoster(openingId: Id, kind: ReviewRound["kind"], roundId?: Id): { round: ReviewRound; applicationIds: Id[]; openRounds: number } | null {
    const rounds = load()
      .reviewRounds.filter((r) => r.openingId === openingId && r.kind === kind && r.status !== "returned")
      .sort((a, b) => b.sentAt - a.sentAt);
    const round = roundId ? rounds.find((r) => r.id === roundId) : rounds[0];
    return round ? { round, applicationIds: [...round.applicationIds], openRounds: rounds.length } : null;
  },

  applyReply(
    openingId: Id,
    kind: ReviewRound["kind"],
    decisions: ReviewDecision[],
    body: string,
  ): { moved: number; rejected: number; held: number; stale: number; repeated: number } {
    const where = new Map(repo.waitingOn(openingId, kind).map((w) => [w.applicationId, w.roundId]));
    const byRound = new Map<Id, ReviewDecision[]>();
    for (const d of decisions) {
      const r = where.get(d.applicationId);
      if (r) byRound.set(r, [...(byRound.get(r) ?? []), d]);
    }
    const total = { moved: 0, rejected: 0, held: 0, stale: 0, repeated: 0 };
    for (const [roundId, ds] of byRound) {
      const res = repo.applyReviewDecisions(roundId, ds, body);
      for (const k of Object.keys(total) as (keyof typeof total)[]) total[k] += res[k];
    }
    return total;
  },

  /** Rounds still waiting on somebody, for the chase list. */
  awaitingReview(openingId?: Id): ReviewRound[] {
    return load()
      .reviewRounds.filter(
        (r) => r.status !== "returned" && (!openingId || r.openingId === openingId),
      )
      .sort((a, b) => a.sentAt - b.sentAt);
  },

  // ─── Database search (spec §6D) ───────────────────────────────────────────

  /**
   * The searchable vocabulary, read off the data rather than hardcoded. At
   * connection this becomes the distinct values across all 115,000 CVs, and the
   * parser starts recognising every title the database actually contains.
   */
  vocabulary(): Vocabulary {
    /*
     * Backed by Convex the words come from the database, not from the rows
     * this page happens to hold.
     *
     * Over the JSON file those are the same thing — the file IS the database.
     * Over Convex they are not, and the difference is not visible in the
     * result: a vocabulary built from an empty working set recognises no
     * words, so the parser quietly ignores every one of them and the search
     * answers a wider question than the one that was asked. `primeStore` reads
     * the real one; this prefers it wherever it has.
     */
    const live = isConvex() ? primedVocabulary() : null;
    if (live) return live;
    if (lockDepth > 0) return buildVocabulary(load());
    const ix = indexes();
    if (ix.vocabulary) return ix.vocabulary;
    ix.vocabulary = buildVocabulary(ix.db);
    return ix.vocabulary;
  },


  searchDatabase(
    criteria: SearchCriteria,
    opts: {
      boolean?: string | null;
      limit?: number;
      /**
       * Search by meaning: each candidate's similarity to the query, 0–1. When
       * given, the words in the query stop scoring — the similarity ranks — and
       * only the strict criteria (place, nationality, years, notice, salary…)
       * still filter. Anyone below `floor` is not a match at all.
       */
      similarity?: Map<Id, number>;
      floor?: number;
      /** Also count people between this and `floor` — the "more below the bar" link. */
      belowFloor?: number;
    } = {},
  ): { results: Result[]; total: number; scanned: number; below: number } {
    const db = load();
    const byCandidate = new Map<Id, Application[]>();
    for (const a of db.applications) {
      byCandidate.set(a.candidateId, [...(byCandidate.get(a.candidateId) ?? []), a]);
    }

    let pool = db.candidates;
    if (opts.boolean) {
      const { node } = parseBoolean(opts.boolean);
      pool = node ? pool.filter((c) => evalBoolean(node, haystackFor(c))) : [];
    }

    const sim = opts.similarity;
    const crit = sim
      ? { ...criteria, titles: [], skills: [], industries: [], employers: [], qualifications: [] }
      : criteria;
    // Two ways in, so one method's blind spot is covered by the other (13
    // September): close in meaning, OR a match on the words themselves — a
    // CV that says "Procurement Manager" is never hidden from a search for one
    // because its vector happened to land under the bar.
    let below = 0;
    if (sim) {
      const floor = opts.floor ?? 0;
      const hasWords = criteria.titles.length + criteria.skills.length + criteria.industries.length + criteria.employers.length + criteria.qualifications.length > 0;
      pool = pool.filter((c) => {
        const s = sim.get(c.id) ?? -1;
        if (s >= floor) return true;
        if (hasWords && matchCandidate(c, criteria, byCandidate.get(c.id) ?? [])) return true;
        if (opts.belowFloor != null && s >= opts.belowFloor && matchCandidate(c, crit, byCandidate.get(c.id) ?? [])) below++;
        return false;
      });
    }

    const results: Result[] = [];
    for (const c of pool) {
      const r = matchCandidate(c, crit, byCandidate.get(c.id) ?? []);
      if (r) results.push(sim ? { ...r, score: sim.get(c.id) ?? 0 } : r);
    }
    results.sort((a, b) => b.score - a.score || (b.candidate.totalExperienceYears ?? 0) - (a.candidate.totalExperienceYears ?? 0));
    return {
      results: results.slice(0, opts.limit ?? 50),
      total: results.length,
      scanned: db.candidates.length,
      below,
    };
  },

  // ─── Headhunting intelligence (spec §8A) ──────────────────────────────────

  research(openingId: Id): ResearchReport | null {
    return load().researchReports.find((r) => r.openingId === openingId) ?? null;
  },

  saveResearch(r: Omit<ResearchReport, "id">): Id {
    const id = `rr_${Math.random().toString(36).slice(2, 10)}`;
    mutate((db) => {
      db.researchReports = db.researchReports.filter((x) => x.openingId !== r.openingId);
      db.researchReports.push({ ...r, id });
    });
    return id;
  },

  chat(openingId: Id): ChatMessage[] {
    return load().chat.filter((m) => m.openingId === openingId).sort((a, b) => a.at - b.at);
  },

  addChat(m: Omit<ChatMessage, "id">): Id {
    const id = `cm_${Math.random().toString(36).slice(2, 10)}`;
    mutate((db) => db.chat.push({ ...m, id }));
    return id;
  },

  /** The TA's conversation with the AI about this opening's JD, oldest first. */
  jdChat(openingId: Id): JdChatMessage[] {
    return (load().jdChat ?? []).filter((m) => m.openingId === openingId).sort((a, b) => a.at - b.at);
  },

  addJdChat(m: Omit<JdChatMessage, "id">): Id {
    const id = `jc_${Math.random().toString(36).slice(2, 10)}`;
    mutate((db) => {
      db.jdChat ??= [];
      db.jdChat.push({ ...m, id });
    });
    return id;
  },

  /** Applied by the assistant when a message re-reads the existing shortlist. */
  applyRefinement(openingId: Id, changes: { url: string; tier?: "priority" | "screen"; drop?: boolean }[]): number {
    let n = 0;
    mutate((db) => {
      for (const c of changes) {
        const s = db.suggestions.find(
          (x) => x.openingId === openingId && (x.linkedinUrl ?? "").includes(c.url),
        );
        if (!s) continue;
        if (c.drop) {
          s.status = "dismissed";
          s.feedback = "not_relevant";
        } else if (c.tier && s.tier !== c.tier) {
          s.tier = c.tier;
        } else continue;
        n++;
      }
    });
    return n;
  },

  updateResearchField(openingId: Id, key: string, value: string | string[]) {
    mutate((db) => {
      const r = db.researchReports.find((x) => x.openingId === openingId);
      if (!r) return;
      (r.fields as unknown as Record<string, unknown>)[key] = value;
      if (!r.editedFields.includes(key)) r.editedFields.push(key);
    });
  },

  benchmarks(openingId: Id): BenchmarkEntry[] {
    const order = { incumbent: 0, predecessor: 1, competitor: 2 };
    const conf = { high: 0, medium: 1, low: 2 };
    return load()
      .benchmarks.filter((b) => b.openingId === openingId)
      .sort((a, b) => order[a.kind] - order[b.kind] || conf[a.confidence] - conf[b.confidence]);
  },

  replaceBenchmarks(openingId: Id, entries: Omit<BenchmarkEntry, "id">[]) {
    mutate((db) => {
      db.benchmarks = db.benchmarks.filter((b) => b.openingId !== openingId);
      entries.forEach((e, i) =>
        db.benchmarks.push({ ...e, id: `bm_${Date.now().toString(36)}_${i}` }),
      );
    });
  },

  toggleBenchmark(entryId: Id) {
    mutate((db) => {
      const b = db.benchmarks.find((x) => x.id === entryId);
      if (b) b.isSelected = !b.isSelected;
    });
  },

  suggestions(openingId: Id): ProfileSuggestion[] {
    return load()
      .suggestions.filter((s) => s.openingId === openingId)
      .sort((a, b) => b.round - a.round || a.generatedAt - b.generatedAt);
  },

  addSuggestions(openingId: Id, entries: Omit<ProfileSuggestion, "id">[]) {
    mutate((db) => {
      // A profile already seen should not come back on a later round as if new.
      const known = new Set(
        db.suggestions
          .filter((s) => s.openingId === openingId)
          .map((s) => (s.linkedinUrl ?? s.name).toLowerCase()),
      );
      entries
        .filter((e) => !known.has((e.linkedinUrl ?? e.name).toLowerCase()))
        .forEach((e, i) => db.suggestions.push({ ...e, id: `sg_${Date.now().toString(36)}_${i}` }));
    });
  },

  setSuggestionStatus(
    id: Id,
    status: ProfileSuggestion["status"],
    feedback: ProfileSuggestion["feedback"],
    by?: Id,
  ) {
    mutate((db) => {
      const s = db.suggestions.find((x) => x.id === id);
      if (!s) return;
      s.status = status;
      s.feedback = feedback;
      // Keeping is the claim. Dismissing is not — the other TA may still want
      // them, so a dismissal never marks a profile as taken.
      if (status === "kept" && by) s.keptBy = by;
    });
  },

  /** Every opening this candidate has ever been on. */
  applicationsForCandidate(candidateId: Id): Application[] {
    if (lockDepth > 0) return load().applications.filter((a) => a.candidateId === candidateId);
    return [...(indexes().appsByCandidate.get(candidateId) ?? [])];
  },

  savedSearches(userId?: Id): SavedSearch[] {
    const db = load();
    const all = [...db.savedSearches].sort((a, b) => b.createdAt - a.createdAt);
    return userId ? all.filter((s) => s.ownerId === userId) : all;
  },

  saveSearch(input: { name: string; query: string; mode: "natural" | "boolean" | "meaning"; ownerId: Id; openingId: Id | null; count: number }): Id {
    const id = `ss_${Math.random().toString(36).slice(2, 10)}`;
    mutate((db) => {
      db.savedSearches.push({
        id,
        name: input.name,
        query: input.query,
        mode: input.mode,
        ownerId: input.ownerId,
        openingId: input.openingId,
        createdAt: Date.now(),
        lastRunAt: Date.now(),
        lastResultCount: input.count,
      });
    });
    return id;
  },

  // ─── Saved reports ────────────────────────────────────────────────────────

  /** Yours, plus anything the desk has shared. */
  savedReports(userId: Id): SavedReport[] {
    return load()
      .savedReports.filter((r) => r.ownerId === userId || r.shared)
      .sort((a, b) => b.createdAt - a.createdAt);
  },

  savedReport(id: Id): SavedReport | undefined {
    return load().savedReports.find((r) => r.id === id);
  },

  saveReport(input: { name: string; ownerId: Id; shared: boolean; spec: unknown }): Id {
    const id = `rp_${Math.random().toString(36).slice(2, 10)}`;
    mutate((db) => {
      db.savedReports.push({ id, ...input, createdAt: Date.now() });
    });
    return id;
  },

  deleteReport(id: Id, byUserId: Id) {
    mutate((db) => {
      // Somebody else's saved report is not yours to remove, shared or not.
      db.savedReports = db.savedReports.filter((r) => !(r.id === id && r.ownerId === byUserId));
    });
  },

  deleteSearch(id: Id) {
    mutate((db) => {
      db.savedSearches = db.savedSearches.filter((s) => s.id !== id);
    });
  },

  /**
   * Put a database candidate onto an opening. Lands at `matched` — found, not
   * yet screened — and never at a shortlist stage, because §9 ownership is only
   * ever taken by a deliberate shortlist, not by a search result.
   */
  // ─── Screening calls ───────────────────────────────────────────────────────
  //
  // Every write bumps `stateVersion` and every caller may name the version it
  // expects, so the same event delivered twice applies once. Nothing is kept
  // before consent, and a declined call keeps nothing at all.

  calls(applicationId?: Id): AiCall[] {
    const rows = load().aiCalls;
    return (applicationId ? rows.filter((c) => c.applicationId === applicationId) : rows).sort(
      (a, b) => b.startedAt - a.startedAt,
    );
  },

  call: (id: Id): AiCall | undefined => load().aiCalls.find((c) => c.id === id),

  /** One live call per application. The live system holds this as a lock for
   *  the same reason: two recruiters, or one double-click, otherwise dial the
   *  same person twice. */
  liveCall(applicationId: Id): AiCall | undefined {
    return load().aiCalls.find(
      (c) =>
        c.applicationId === applicationId &&
        (c.status === "draft" || c.status === "awaiting_consent" || c.status === "in_progress"),
    );
  },

  startCall(input: {
    applicationId: Id;
    mode: CallMode;
    byUserId: Id;
  }): { ok: true; id: Id } | { ok: false; message: string } {
    const db = load();
    const app = db.applications.find((a) => a.id === input.applicationId);
    if (!app) return { ok: false, message: "No such application." };
    if (repo.liveCall(input.applicationId))
      return { ok: false, message: "There is already a call open on this candidate." };
    const state = modeState(input.mode);
    if (!state.available) return { ok: false, message: state.why };

    const id = `ac_${Math.random().toString(36).slice(2, 10)}`;
    mutate((d) => {
      d.aiCalls.push({
        id,
        applicationId: app.id,
        candidateId: app.candidateId,
        openingId: app.openingId,
        mode: input.mode,
        status: "awaiting_consent",
        stateVersion: 0,
        consent: null,
        consentAt: null,
        consentText: null,
        answers: [],
        transcript: null,
        durationSeconds: null,
        applied: [],
        conflicts: [],
        startedBy: input.byUserId,
        startedAt: Date.now(),
        endedAt: null,
        failureReason: null,
      });
    });
    return { ok: true, id };
  },

  /**
   * Consent, and the wording it was given against.
   *
   * A refusal ends the call and clears it. Keeping a transcript of a call
   * somebody asked not to be recorded is the exact thing the question is
   * there to prevent, and "we stopped recording from that point" is not what
   * they were asked.
   */
  recordConsent(
    id: Id,
    decision: "granted" | "declined",
    expectedVersion?: number,
  ): { ok: true } | { ok: false; message: string } {
    const call = load().aiCalls.find((c) => c.id === id);
    if (!call) return { ok: false, message: "No such call." };
    if (expectedVersion !== undefined && expectedVersion !== call.stateVersion)
      return { ok: false, message: "Out of date — this call has moved on." };

    const now = Date.now();
    mutate((d) => {
      const c = d.aiCalls.find((x) => x.id === id)!;
      c.consent = decision;
      c.consentAt = now;
      c.consentText = CALL_CONSENT_TEXT;
      c.stateVersion++;
      if (decision === "granted") {
        c.status = "in_progress";
      } else {
        c.status = "declined";
        c.endedAt = now;
        c.answers = [];
        c.transcript = null;
      }
    });
    return { ok: true };
  },

  recordAnswer(input: {
    callId: Id;
    field: CallField;
    heard: string;
    expectedVersion?: number;
  }): { ok: true; value: string | number | null } | { ok: false; message: string } {
    const call = load().aiCalls.find((c) => c.id === input.callId);
    if (!call) return { ok: false, message: "No such call." };

    const check = acceptAnswer({
      call,
      field: input.field,
      heard: input.heard,
      expectedVersion: input.expectedVersion,
    });
    if (!check.ok) return check;

    mutate((d) => {
      const c = d.aiCalls.find((x) => x.id === input.callId)!;
      c.answers = [
        ...c.answers.filter((a) => a.field !== input.field),
        { field: input.field, value: check.value, heard: input.heard.trim(), at: Date.now() },
      ];
      c.stateVersion++;
    });
    return { ok: true, value: check.value };
  },

  /**
   * End the call and write what it produced.
   *
   * A dry run writes nothing — `applyPlan` refuses on the mode, not on a flag
   * somebody remembered to pass. Anything that disagrees with the record is
   * kept on the call rather than applied.
   */
  finishCall(input: {
    callId: Id;
    status: "completed" | "failed" | "cancelled";
    transcript?: string | null;
    durationSeconds?: number | null;
    failureReason?: string | null;
    expectedVersion?: number;
  }): { ok: true; applied: string[]; conflicts: number } | { ok: false; message: string } {
    const db = load();
    const call = db.aiCalls.find((c) => c.id === input.callId);
    if (!call) return { ok: false, message: "No such call." };
    if (input.expectedVersion !== undefined && input.expectedVersion !== call.stateVersion)
      return { ok: false, message: "Out of date — this call has moved on." };
    const candidate = db.candidates.find((c) => c.id === call.candidateId);
    if (!candidate) return { ok: false, message: "No such candidate." };

    const plan = input.status === "completed" ? applyPlan(call, candidate) : { fill: {}, conflicts: [] };
    const applied = Object.keys(plan.fill);
    const now = Date.now();

    mutate((d) => {
      const c = d.aiCalls.find((x) => x.id === input.callId)!;
      c.status = input.status;
      c.endedAt = now;
      c.transcript = input.transcript ?? c.transcript;
      c.durationSeconds = input.durationSeconds ?? c.durationSeconds;
      c.failureReason = input.failureReason ?? null;
      c.applied = applied;
      c.conflicts = plan.conflicts;
      c.stateVersion++;

      const cand = d.candidates.find((x) => x.id === call.candidateId)!;
      Object.assign(cand, plan.fill);
    });

    // The call is a piece of feedback on the application as well as a record of
    // itself, so it lands where a TA already looks for what was said.
    if (writePolicy(call.mode).applicationFields && input.status === "completed") {
      repo.recordCall({
        applicationId: call.applicationId,
        kind: "ad_hoc",
        outcome: "reached",
        body:
          call.answers.map((a) => `${a.field}: ${a.heard}`).join(" · ") || "Screening call, nothing recorded.",
        structured: Object.fromEntries(call.answers.map((a) => [a.field, a.value])),
        source: call.mode === "live" ? "ai_call" : "manual",
        recordedBy: call.startedBy,
      });
    }

    return { ok: true, applied, conflicts: plan.conflicts.length };
  },

  // ─── Closing records ───────────────────────────────────────────────────────
  //
  // Offer, placement, agreement. Money and paper, kept as records rather than
  // as columns on the application, because the questions asked of them —
  // what is unbilled, what is still inside its guarantee, what has no signed
  // agreement behind it — are questions about the set, not about one candidate.

  offers(applicationId?: Id): Offer[] {
    const rows = load().offers;
    return (applicationId ? rows.filter((o) => o.applicationId === applicationId) : rows).sort(
      (a, b) => b.createdAt - a.createdAt,
    );
  },

  offer: (id: Id): Offer | undefined => load().offers.find((o) => o.id === id),

  /** The live one on an application, where there is one. */
  pendingOffer(applicationId: Id): Offer | undefined {
    return load().offers.find((o) => o.applicationId === applicationId && o.status === "pending");
  },

  makeOffer(input: {
    applicationId: Id;
    salary: number;
    salaryBasis: SalaryBasis;
    currency: Currency;
    startDate: number | null;
    terms: string | null;
    byUserId: Id;
  }): { ok: true; id: Id } | { ok: false; message: string } {
    const db = load();
    const app = db.applications.find((a) => a.id === input.applicationId);
    if (!app) return { ok: false, message: "No such application." };
    if (input.salary <= 0) return { ok: false, message: "An offer needs a salary." };
    // An offer goes to someone the client shortlisted or interviewed. The move
    // below is forced (the offer is what allows it), so without this a New CV
    // could be made an offer, skipping the Director and the client.
    const route = canMove(app.stage, "offer", { hasOffer: true });
    if (!route.ok) return { ok: false, message: `An offer can be made once the client has shortlisted them. ${route.message}` };
    if (db.offers.some((o) => o.applicationId === app.id && o.status === "pending"))
      return { ok: false, message: "There is already an open offer on this candidate." };

    const id = `of_${Math.random().toString(36).slice(2, 10)}`;
    const now = Date.now();
    mutate((d) => {
      d.offers.push({
        id,
        applicationId: app.id,
        openingId: app.openingId,
        candidateId: app.candidateId,
        salary: input.salary,
        salaryBasis: input.salaryBasis,
        currency: input.currency,
        startDate: input.startDate,
        terms: input.terms,
        status: "pending",
        respondedAt: null,
        declineReason: null,
        madeBy: input.byUserId,
        createdAt: now,
      });
    });

    repo.moveStage(app.id, "offer", input.byUserId, `${input.currency} ${input.salary.toLocaleString()}`, {
      force: true,
    });
    return { ok: true, id };
  },

  /**
   * The candidate answers.
   *
   * A decline is not just a status: it ends the application and starts the
   * backup search, which is behaviour this platform already had on
   * `declineOffer`. Both paths now write the same two things, so the offer
   * record and the application can never disagree about what happened.
   */
  respondToOffer(input: {
    offerId: Id;
    status: Exclude<OfferStatus, "pending">;
    reason?: string;
    byUserId: Id;
  }): { ok: true } | { ok: false; message: string } {
    const db = load();
    const offer = db.offers.find((o) => o.id === input.offerId);
    if (!offer) return { ok: false, message: "No such offer." };
    if (offer.status !== "pending") return { ok: false, message: "That offer is already settled." };

    const now = Date.now();
    mutate((d) => {
      const o = d.offers.find((x) => x.id === input.offerId)!;
      o.status = input.status;
      o.respondedAt = now;
      o.declineReason = input.status === "accepted" ? null : (input.reason ?? null);
    });

    if (input.status !== "accepted") {
      const reason = input.reason?.trim() || (input.status === "withdrawn" ? "Offer withdrawn" : "Offer declined");
      mutate((d) => {
        const a = d.applications.find((x) => x.id === offer.applicationId);
        if (!a) return;
        a.offerDeclinedAt = now;
        a.offerDeclineReason = reason;
      });
      repo.moveStage(offer.applicationId, "dropped_out", input.byUserId, reason, { force: true });
    }
    return { ok: true };
  },

  placements(filter?: { openingId?: Id; clientId?: Id }): Placement[] {
    let rows = load().placements;
    if (filter?.openingId) rows = rows.filter((p) => p.openingId === filter.openingId);
    if (filter?.clientId) rows = rows.filter((p) => p.clientId === filter.clientId);
    return [...rows].sort((a, b) => b.joinDate - a.joinDate);
  },

  placement: (id: Id): Placement | undefined => load().placements.find((p) => p.id === id),

  placementForApplication(applicationId: Id): Placement | undefined {
    return load().placements.find((p) => p.applicationId === applicationId);
  },

  /**
   * Turn an accepted offer into a placement.
   *
   * The fee rate and the guarantee length are COPIED from the client's
   * agreement as it reads today, not referenced. Terms get renegotiated, and a
   * placement made in March has to keep March's terms however the agreement
   * reads in November — a live reference would silently rewrite the value of
   * work already done.
   */
  recordPlacement(input: {
    offerId: Id;
    joinDate: number;
    salary?: number;
    byUserId: Id;
  }): { ok: true; id: Id } | { ok: false; message: string } {
    const db = load();
    const offer = db.offers.find((o) => o.id === input.offerId);
    if (!offer) return { ok: false, message: "No such offer." };
    // A placement IS the acceptance. Requiring the offer to be marked accepted
    // in a separate click before it can be placed makes one fact take two
    // actions, and the two then drift — which is exactly how an application
    // ends up placed with an offer still reading "pending". A declined or
    // withdrawn offer is a different matter and still refused.
    if (offer.status === "declined" || offer.status === "withdrawn")
      return { ok: false, message: `That offer was ${offer.status}. Make a new one to place them.` };
    if (db.placements.some((p) => p.offerId === offer.id))
      return { ok: false, message: "This offer is already placed." };
    const app = db.applications.find((a) => a.id === offer.applicationId);
    const opening = db.openings.find((o) => o.id === offer.openingId);
    if (!app || !opening) return { ok: false, message: "The application or opening is missing." };

    const esa = repo.esaFor(opening.clientId, opening.id);
    const id = `pl_${Math.random().toString(36).slice(2, 10)}`;
    const now = Date.now();

    mutate((d) => {
      const o = d.offers.find((x) => x.id === offer.id)!;
      if (o.status === "pending") {
        o.status = "accepted";
        o.respondedAt = now;
      }
      d.placements.push({
        id,
        offerId: offer.id,
        applicationId: app.id,
        openingId: opening.id,
        candidateId: app.candidateId,
        clientId: opening.clientId,
        placedBy: input.byUserId,
        sourcingChannel: app.sourcingChannel,
        salary: input.salary ?? offer.salary,
        salaryBasis: offer.salaryBasis,
        currency: offer.currency,
        joinDate: input.joinDate,
        joinConfirmedAt: null,
        feePercent: esa?.feePercent ?? DEFAULT_FEE_PERCENT,
        flatFee: null,
        invoiceSentAt: null,
        invoiceNumber: null,
        invoicePaidAt: null,
        guaranteeDays: esa?.guaranteeDays ?? DEFAULT_GUARANTEE_DAYS,
        fellThroughAt: null,
        fellThroughReason: null,
        notes: null,
        createdAt: now,
      });
    });

    repo.moveStage(app.id, "placed", input.byUserId, `Joining ${new Date(input.joinDate).toISOString().slice(0, 10)}`, {
      force: true,
    });
    return { ok: true, id };
  },

  updatePlacement(id: Id, patch: Partial<Omit<Placement, "id" | "offerId" | "createdAt">>): void {
    mutate((d) => {
      const p = d.placements.find((x) => x.id === id);
      if (p) Object.assign(p, patch);
    });
  },

  /**
   * The candidate left. Inside the guarantee this is money going back out, so
   * it moves the application as well as marking the record — a placement that
   * is still sitting in `placed` while the person has gone is how a fee gets
   * counted twice.
   */
  recordFallThrough(id: Id, reason: string, byUserId: Id): void {
    const p = load().placements.find((x) => x.id === id);
    if (!p) return;
    const now = Date.now();
    mutate((d) => {
      const row = d.placements.find((x) => x.id === id)!;
      row.fellThroughAt = now;
      row.fellThroughReason = reason.trim() || null;
    });
    repo.moveStage(p.applicationId, "dropped_out", byUserId, reason, { force: true });
  },

  esaRecords(clientId?: Id): EsaRecord[] {
    const rows = load().esaRecords;
    return (clientId ? rows.filter((e) => e.clientId === clientId) : rows).sort(
      (a, b) => b.createdAt - a.createdAt,
    );
  },

  esa: (id: Id): EsaRecord | undefined => load().esaRecords.find((e) => e.id === id),

  /**
   * Which agreement governs a placement for this client.
   *
   * One signed for this specific role beats a signed client-wide one, which
   * beats anything unsigned. Nothing here falls back to a different client —
   * that is the failure the live schema invites by keying on the client's name
   * as free text.
   */
  esaFor(clientId: Id, openingId?: Id): EsaRecord | undefined {
    const rows = repo.esaRecords(clientId);
    const usable = rows.filter((e) => e.status !== "expired");
    return (
      usable.find((e) => e.status === "signed" && openingId && e.openingId === openingId) ??
      usable.find((e) => e.status === "signed" && e.openingId === null) ??
      usable.find((e) => e.status === "not_required") ??
      usable.find((e) => openingId && e.openingId === openingId) ??
      usable.find((e) => e.openingId === null)
    );
  },

  saveEsa(input: {
    id?: Id;
    clientId: Id;
    openingId: Id | null;
    status: EsaStatus;
    feePercent: number | null;
    guaranteeDays: number;
    dueAt: number | null;
    signedBy: string | null;
    documentName: string | null;
    notes: string | null;
  }): Id {
    const now = Date.now();
    const id = input.id ?? `esa_${Math.random().toString(36).slice(2, 10)}`;
    mutate((d) => {
      const existing = d.esaRecords.find((e) => e.id === id);
      const sentAt = input.status === "sent" || input.status === "signed" ? (existing?.sentAt ?? now) : existing?.sentAt ?? null;
      const signedAt = input.status === "signed" ? (existing?.signedAt ?? now) : null;
      if (existing) {
        Object.assign(existing, { ...input, id, sentAt, signedAt });
      } else {
        d.esaRecords.push({ ...input, id, sentAt, signedAt, createdAt: now });
      }

      // `Client.esaSignedAt` predates this record and several screens still
      // read it. Writing both from one place is what stops them drifting —
      // a client card reading "no ESA on file" next to a signed agreement is
      // the kind of disagreement nobody notices until it matters.
      const client = d.clients.find((c) => c.id === input.clientId);
      if (client) {
        const signedNow = d.esaRecords
          .filter((e) => e.clientId === input.clientId && e.status === "signed")
          .map((e) => e.signedAt)
          .filter((x): x is number => x !== null)
          .sort((a, b) => b - a)[0];
        client.esaSignedAt = signedNow ?? null;
      }
    });
    return id;
  },

  /** The furthest this candidate has got on any job. Stops somebody placed
   *  elsewhere reading as available. */
  overallStatus(candidateId: Id) {
    return overallStatus(repo.applicationsForCandidate(candidateId));
  },

  /** Whether a role is on track, worked out fresh each time. */
  health(openingId: Id, now = Date.now()) {
    const o = load().openings.find((x) => x.id === openingId);
    if (!o) return null;
    const posts = repo.jobPosts(openingId);
    return healthFor({
      opening: o,
      apps: repo.applications(openingId),
      cvsToday: posts.filter((p) => p.status === "live").reduce((n, p) => n + p.cvCountToday, 0),
      livePosts: posts.filter((p) => p.status === "live").length,
      now,
    });
  },

  // ─── House settings ────────────────────────────────────────────────────────

  setting(key: string, fallback: string): string {
    return load().settings.find((s) => s.key === key)?.value ?? fallback;
  },

  setSetting(key: string, value: string): void {
    mutate((d) => {
      const row = d.settings.find((s) => s.key === key);
      if (row) {
        row.value = value;
        row.updatedAt = Date.now();
      } else {
        d.settings.push({ key, value, updatedAt: Date.now() });
      }
    });
  },

  /** The one box every shortlist reply is copied to. A director can change it
   *  here rather than waiting on a deploy — it is an address, not a code path. */
  /** Copied on every end-of-day email. Changed on the People page. */
  eodCopyTo(): string {
    return repo.setting("eodCc", DEFAULT_EOD_CC);
  },

  shortlistInbox(): string {
    return repo.setting("shortlistInbox", DEFAULT_SHORTLIST_INBOX);
  },

  // ─── Follow-up ─────────────────────────────────────────────────────────────
  //
  // The sequence state is DERIVED every time from the outreach log and the
  // candidate record — see lib/followup. Nothing about where a chase has got
  // to is written down, so nothing about it can go stale.

  outreach(applicationId: Id): OutreachMessage[] {
    return load()
      .outreach.filter((m) => m.applicationId === applicationId)
      .sort((a, b) => a.createdAt - b.createdAt);
  },

  /** The desk's standard follow-up questions, with whichever are switched off. */
  followUpStandard(): FollowUpQuestion[] {
    const raw = repo.setting("followUpQuestions", "");
    if (!raw) return STANDARD_QUESTIONS;
    try {
      const saved = JSON.parse(raw) as { id: string; enabled: boolean; label?: string }[];
      return STANDARD_QUESTIONS.map((q) => {
        const hit = saved.find((x) => x.id === q.id);
        return hit ? { ...q, enabled: hit.enabled, label: hit.label?.trim() || q.label } : q;
      });
    } catch {
      return STANDARD_QUESTIONS;
    }
  },

  setFollowUpStandard(rows: { id: string; enabled: boolean; label: string }[]) {
    repo.setSetting("followUpQuestions", JSON.stringify(rows));
  },

  /** Local mode only; with Convex the switch is `ta/followUp:setAuto`. */
  setOpeningAutoFollowUp(openingId: Id, enabled: boolean) {
    mutate((db) => {
      const o = db.openings.find((x) => x.id === openingId);
      if (!o) return;
      o.autoFollowUp = enabled;
      o.updatedAt = Date.now();
    });
  },

  setOpeningQuestions(openingId: Id, questions: { id: Id; label: string }[]) {
    mutate((db) => {
      const o = db.openings.find((x) => x.id === openingId);
      if (!o) return;
      o.followUpQuestions = questions.filter((q) => q.label.trim()).slice(0, 12);
      o.updatedAt = Date.now();
    });
  },

  saveAnswers(applicationId: Id, answers: Record<string, string>) {
    mutate((db) => {
      const a = db.applications.find((x) => x.id === applicationId);
      if (!a) return;
      a.answers = { ...(a.answers ?? {}), ...answers };
    });
  },

  /**
   * The contact log the follow-up engine reads: messages both ways, and every
   * call — the ones logged by outcome here, and screening calls, which count as
   * answered when they completed and as no answer when they did not connect.
   */
  contactsFor(applicationId: Id): Contact[] {
    const db = load();
    const out: Contact[] = db.outreach
      .filter((m) => m.applicationId === applicationId && (m.direction === "in" || m.sentAt))
      .map((m) => ({
        at: m.sentAt ?? m.createdAt,
        channel: m.channel,
        direction: m.direction,
        outcome: m.callOutcome ?? null,
        promisedAt: m.promisedAt ?? null,
      }));
    for (const c of db.aiCalls.filter((x) => x.applicationId === applicationId)) {
      if (c.status === "completed") out.push({ at: c.endedAt ?? c.startedAt, channel: "ai_call", direction: "out", outcome: "answered" });
      else if (c.status === "failed") out.push({ at: c.endedAt ?? c.startedAt, channel: "ai_call", direction: "out", outcome: "no_answer" });
    }
    return out.sort((x, y) => x.at - y.at);
  },

  /** Everyone currently being chased, with where their day has got to. */
  followUps(now = Date.now()): {
    application: Application;
    candidate: Candidate;
    opening: Opening;
    followUp: FollowUp;
    questions: FollowUpQuestion[];
    messages: OutreachMessage[];
  }[] {
    const db = load();
    const standard = repo.followUpStandard();
    const out = [];
    for (const a of db.applications) {
      if (a.stage !== "ai_follow_up" && a.stage !== "ta_follow_up" && (a.stage as string) !== "follow_up") continue;
      const candidate = repo.candidate(a.candidateId);
      const opening = db.openings.find((o) => o.id === a.openingId);
      if (!candidate || !opening) continue;
      const questions = questionsInForce(standard, opening.followUpQuestions);
      const followUp = followUpFor({
        candidate,
        questions,
        answers: a.answers,
        // The moment they landed in this stage starts the day.
        enteredAt: a.lastStageChangedAt,
        contacts: repo.contactsFor(a.id),
        now,
      });
      out.push({
        application: a,
        candidate,
        opening,
        followUp,
        questions,
        messages: db.outreach.filter((m) => m.applicationId === a.id),
      });
    }
    // Late first, then what is owed now, then what is waiting.
    const rank = (s: FollowUpState) =>
      s === "overdue" ? 0 : s === "due" ? 1 : s === "declined" ? 2 : s === "waiting" ? 3 : s === "unreachable" ? 4 : 5;
    return out.sort((x, y) => rank(x.followUp.state) - rank(y.followUp.state) || x.followUp.deadline - y.followUp.deadline);
  },

  followUp(applicationId: Id, now = Date.now()) {
    return repo.followUps(now).find((f) => f.application.id === applicationId);
  },

  /** A follow-up call, and how it went. */
  recordCallOutcome(input: {
    applicationId: Id;
    outcome: import("./types").FollowUpCallOutcome;
    promisedAt: number | null;
    note: string;
    byUserId: Id | null;
  }): { ok: true } | { ok: false; message: string } {
    const db = load();
    const app = db.applications.find((a) => a.id === input.applicationId);
    if (!app) return { ok: false, message: "No such application." };
    if ((input.outcome === "callback" || input.outcome === "will_send") && !input.promisedAt) {
      return {
        ok: false,
        message: input.outcome === "callback" ? "Say what time they asked to be called back." : "Say when they said they would send it.",
      };
    }
    const now = Date.now();
    mutate((d) => {
      d.outreach.push({
        id: `om_${Math.random().toString(36).slice(2, 10)}`,
        applicationId: app.id,
        candidateId: app.candidateId,
        direction: "out",
        channel: "ai_call",
        attempt: d.outreach.filter((m) => m.applicationId === app.id && m.direction === "out").length + 1,
        to: d.candidates.find((c) => c.id === app.candidateId)?.phone ?? null,
        subject: null,
        body: input.note.trim(),
        sentAt: now,
        byUserId: input.byUserId,
        createdAt: now,
        callOutcome: input.outcome,
        promisedAt: input.promisedAt,
      });
    });
    return { ok: true };
  },

  /**
   * Record that an attempt went out.
   *
   * Sending is not connected in this build, so this is a person saying they
   * sent it. When the mailbox and the WhatsApp number are switched on the same
   * call is made by the sender instead, with `byUserId` null — which is why
   * the log carries who rather than assuming.
   */
  recordAttempt(input: {
    applicationId: Id;
    drafts: { channel: OutreachChannel; to: string; subject: string | null; body: string }[];
    byUserId: Id | null;
  }): { ok: true; count: number } | { ok: false; message: string } {
    const db = load();
    const app = db.applications.find((a) => a.id === input.applicationId);
    if (!app) return { ok: false, message: "No such application." };
    if (input.drafts.length === 0)
      return { ok: false, message: "No phone and no email — there is nothing to send." };

    const now = Date.now();
    mutate((d) => {
      const attempt = d.outreach.filter((m) => m.applicationId === app.id && m.direction === "out").length + 1;
      for (const dr of input.drafts) {
        d.outreach.push({
          id: `om_${Math.random().toString(36).slice(2, 10)}`,
          applicationId: input.applicationId,
          candidateId: app.candidateId,
          direction: "out",
          channel: dr.channel,
          attempt,
          to: dr.to,
          subject: dr.subject,
          body: dr.body,
          sentAt: now,
          byUserId: input.byUserId,
          createdAt: now,
        });
      }
    });
    return { ok: true, count: input.drafts.length };
  },

  /**
   * A reply came back.
   *
   * Logging it stops the sequence — that is the whole mechanism, and it is why
   * this writes before anything is read out of the text. What the reader finds
   * is applied to the candidate only where the record is BLANK; a reply never
   * overwrites a figure somebody already checked.
   */
  recordReply(input: {
    applicationId: Id;
    channel: OutreachChannel;
    body: string;
    byUserId: Id | null;
  }): { ok: true; applied: string[]; reading: ReplyReading } | { ok: false; message: string } {
    const db = load();
    const app = db.applications.find((a) => a.id === input.applicationId);
    if (!app) return { ok: false, message: "No such application." };
    const candidate = db.candidates.find((c) => c.id === app.candidateId);
    if (!candidate) return { ok: false, message: "No such candidate." };

    const reading = readReply(input.body);
    const applied: string[] = [];
    const now = Date.now();

    mutate((d) => {
      d.outreach.push({
        id: `om_${Math.random().toString(36).slice(2, 10)}`,
        applicationId: input.applicationId,
        candidateId: app.candidateId,
        direction: "in",
        channel: input.channel,
        attempt: 0,
        to: null,
        subject: null,
        body: input.body.trim(),
        sentAt: now,
        byUserId: input.byUserId,
        createdAt: now,
      });

      const c = d.candidates.find((x) => x.id === app.candidateId)!;
      if (reading.currentSalary && !c.currentSalary) {
        c.currentSalary = reading.currentSalary;
        applied.push("current salary");
      }
      if (reading.expectedSalary && !c.expectedSalary) {
        c.expectedSalary = reading.expectedSalary;
        applied.push("expected salary");
      }
      if (reading.noticePeriodDays !== null && (c.noticePeriodDays === null || c.noticePeriodDays === undefined)) {
        c.noticePeriodDays = reading.noticePeriodDays;
        applied.push("notice period");
      }
    });

    return { ok: true, applied, reading };
  },

  // ─── Intake ────────────────────────────────────────────────────────────────
  //
  // The queue in front of the candidate table. Nothing here writes a candidate
  // except `admitIntake` and `mergeIntake`, and both of those are called by a
  // person pressing a button.

  intake(status?: IntakeStatus[]): IntakeItem[] {
    const rows = load().intake;
    const out = status ? rows.filter((r) => status.includes(r.status)) : rows;
    return [...out].sort((a, b) => b.receivedAt - a.receivedAt);
  },

  intakeItem(id: Id): IntakeItem | undefined {
    return load().intake.find((r) => r.id === id);
  },

  intakeCounts(): Record<IntakeStatus, number> {
    const out = {
      received: 0, parsed: 0, ready: 0, needs_review: 0, admitted: 0, merged: 0, rejected: 0,
    } as Record<IntakeStatus, number>;
    for (const r of load().intake) out[r.status]++;
    return out;
  },

  /**
   * Bring a file in. Refused unless the channel it claims to come from is open
   * — see lib/ingest. The refusal is returned rather than thrown so a closed
   * channel is reported to whoever tried, not swallowed into a log.
   */
  receiveIntake(input: {
    source: IntakeSource;
    receivedFrom?: string | null;
    /** The mailbox it arrived at. This is what routes it. */
    to?: string | null;
    subject?: string | null;
    fileName?: string | null;
    fileHash?: string | null;
    sizeBytes?: number | null;
    rawText: string;
    openingId?: Id | null;
    jobPostId?: Id | null;
  }): { ok: true; id: Id } | { ok: false; message: string } {
    const allowed = guard(input.source);
    if (!allowed.ok) return allowed;

    const db = load();
    // Address → TA, headline → job. An explicit openingId on the call still
    // wins, because a TA dropping a file in by hand has already said where it
    // goes and should not be second-guessed by a subject line.
    // A campaign code in the subject or the message decides the post outright —
    // that is how Meta (WhatsApp) and email-campaign applicants are filed. The
    // mailbox and headline route LinkedIn applications.
    const coded = routeByCampaignCode(`${input.subject ?? ""}\n${input.rawText}`, db.jobPosts);
    const route = coded
      ? {
          taId: coded.assignedTaId,
          postId: coded.id,
          openingId: coded.openingId,
          confidence: "exact" as const,
          matchedOn: coded.campaignCode,
          ambiguous: [],
          alsoTo: [],
        }
      : input.to && input.subject
        ? routeInbound({ to: input.to, subject: input.subject, body: input.rawText }, db.users, db.jobPosts)
        : null;
    const routedTa = route?.taId ? db.users.find((u) => u.id === route.taId) ?? null : null;

    const parsed = parseCv(input.rawText);
    const id = `in_${Math.random().toString(36).slice(2, 10)}`;
    const item: IntakeItem = {
      id,
      source: input.source,
      receivedFrom: input.receivedFrom ?? null,
      receivedAt: Date.now(),
      fileName: input.fileName ?? null,
      fileHash: input.fileHash ?? null,
      sizeBytes: input.sizeBytes ?? input.rawText.length,
      rawText: input.rawText,
      parsed,
      match: null,
      status: "parsed",
      toAddress: input.to ?? null,
      subject: input.subject ?? null,
      openingId: input.openingId ?? route?.openingId ?? null,
      jobPostId: input.jobPostId ?? route?.postId ?? null,
      alsoFiledTo: input.openingId ? [] : route?.alsoTo ?? [],
      routedToTaId: route?.taId ?? null,
      routeNote: route ? routeNote(route, routedTa?.name ?? null) : null,
      routeConfidence: route?.confidence ?? null,
      candidateId: null,
      handledBy: null,
      handledAt: null,
      note: null,
      problems: problemsWith(parsed),
    };
    mutate((d) => void d.intake.push(item));
    repo.recheckIntake(id);
    repo.processIntake(id);
    return { ok: true, id };
  },

  /**
   * File an incoming CV without anybody pressing a button.
   *
   * The desk's rule (13 September), in order:
   *
   *   **Somebody we already have** → their record is updated from the new CV,
   *   and they are filed to the job the CV came in for. Applying to three jobs
   *   puts them on all three; applying twice to one job updates, never copies.
   *   **Somebody new** → created, and filed to the job.
   *   **No job to go to** → the person still goes into the database, new or
   *   updated. Nothing is lost for want of a subject line.
   *
   * Two things still wait for a TA, because guessing would be worse: a CV no
   * name could be read from, and an identity check that could not decide
   * whether two records are one person. Both raise an alert.
   *
   * The queue used to hold every CV until somebody admitted it, with no alert
   * and no menu entry — a correctly routed applicant could sit outside the
   * pipeline indefinitely (audit finding 08).
   */
  processIntake(id: Id): { filed: "merged" | "admitted" | "held"; why?: string } {
    const item = load().intake.find((r) => r.id === id);
    if (!item || item.status === "admitted" || item.status === "merged" || item.status === "rejected") {
      return { filed: "held", why: "already handled" };
    }
    if (!item.parsed?.fullName) return { filed: "held", why: "no name could be read" };
    // A name alone identifies nobody. With no email, phone or LinkedIn there is
    // nothing to check for a duplicate against and no way to reach them — a
    // scanned image CV is the usual case — so a person reads it first.
    if (!item.parsed.email && !item.parsed.phone && !item.parsed.linkedinUrl) {
      return { filed: "held", why: "no email, phone or LinkedIn to identify them by" };
    }
    if (!item.match || item.match.verdict === "review") return { filed: "held", why: "identity unclear" };

    // Recorded against the TA whose mailbox it came to, or the desk's lead when
    // it came in some other way. The history note says it was automatic.
    const actor =
      item.routedToTaId ?? load().users.find((u) => u.role === "ta_lead" && u.isActive)?.id ?? load().users[0].id;

    // The same advert can serve two openings; the CV goes on each of them.
    const fileToOthers = (candidateId: Id) => {
      for (const t of item.alsoFiledTo ?? []) {
        repo.addCandidateToOpening(candidateId, t.openingId, actor, t.postId, { kind: "intake", source: item.source });
      }
    };

    if (item.match.verdict === "same" && item.match.candidateId) {
      const r = repo.mergeIntake(id, item.match.candidateId, actor);
      if (r.ok) fileToOthers(item.match.candidateId);
      return r.ok ? { filed: "merged" } : { filed: "held", why: r.message };
    }
    const r = repo.admitIntake(id, actor);
    if (r.ok) fileToOthers(r.candidateId);
    return r.ok ? { filed: "admitted" } : { filed: "held", why: r.message };
  },

  /** Run the identity check against the current database and record what it
   *  found. Separate from receiving so it can be re-run after a TA corrects a
   *  mis-read field — the verdict then reflects the corrected value. */
  recheckIntake(id: Id): IntakeItem | undefined {
    const db = load();
    const item = db.intake.find((r) => r.id === id);
    if (!item || !item.parsed) return item;

    const known = db.candidates.map((c) => ({
      fullName: c.fullName,
      email: c.email,
      phone: c.phone,
      linkedinUrl: c.linkedinUrl,
      currentEmployer: c.currentEmployer,
      location: c.location,
    }));
    const m = matchAgainst(
      {
        fullName: item.parsed.fullName ?? "",
        email: item.parsed.email,
        phone: item.parsed.phone,
        linkedinUrl: item.parsed.linkedinUrl,
        currentEmployer: item.parsed.currentEmployer,
        location: item.parsed.location,
        fileHash: item.fileHash,
      },
      known,
    );
    const hit = m.index >= 0 ? db.candidates[m.index] : null;

    mutate((d) => {
      const row = d.intake.find((r) => r.id === id)!;
      row.match = {
        verdict: m.verdict,
        candidateId: hit?.id ?? null,
        candidateName: hit?.fullName ?? null,
        evidence: m.evidence,
        reason: m.reason,
        checkedAt: Date.now(),
      };
      // A settled item keeps its status — rechecking is a read of the world,
      // not a reason to reopen a decision somebody already made.
      if (row.status === "parsed" || row.status === "ready" || row.status === "needs_review") {
        row.status = m.verdict === "review" ? "needs_review" : "ready";
      }
    });
    return load().intake.find((r) => r.id === id);
  },

  /** Correct a field the parser got wrong, then re-check. Editing here rather
   *  than after admission is the point: a wrong email becomes a wrong dedup
   *  key, and once it is on the candidate table it has already done its damage. */
  editIntakeParsed(id: Id, patch: Partial<ParsedCv>): void {
    mutate((d) => {
      const row = d.intake.find((r) => r.id === id);
      if (!row || !row.parsed) return;
      row.parsed = { ...row.parsed, ...patch };
      row.problems = problemsWith(row.parsed);
    });
    repo.recheckIntake(id);
    repo.processIntake(id);
  },

  /**
   * Admit as a NEW person. Refused when dedup says this is somebody we already
   * hold and nobody has looked at it — the whole point of the queue is that
   * that decision is taken deliberately.
   */
  admitIntake(
    id: Id,
    byUserId: Id,
    opts: { openingId?: Id | null; force?: boolean } = {},
  ): { ok: true; candidateId: Id } | { ok: false; message: string } {
    const db = load();
    const item = db.intake.find((r) => r.id === id);
    if (!item) return { ok: false, message: "No such item." };
    if (item.status === "admitted" || item.status === "merged")
      return { ok: false, message: "Already admitted." };
    const p = item.parsed;
    if (!p?.fullName)
      return { ok: false, message: "No name could be read. Fill the name in before admitting." };
    // The identity check's verdict is enforced here, where the record is
    // written — not only in the screen that steers towards merging. A "same"
    // verdict let straight through was a second copy of a person the desk
    // already had, which is the one thing dedup exists to prevent.
    if (item.match?.verdict === "same" && !opts.force)
      return {
        ok: false,
        message:
          "Not admitted — this is somebody already on file. Merge it into their record instead, or tick the box if you are certain it is a different person.",
      };
    if (item.match?.verdict === "review" && !opts.force)
      return {
        ok: false,
        message:
          "Not admitted — the identity check has an open question about this one. Either merge it into the record it matched, or tick the box to say this is a different person.",
      };

    const candidateId = `ca_${Math.random().toString(36).slice(2, 10)}`;
    const now = Date.now();
    mutate((d) => {
      d.candidates.push({
        id: candidateId,
        fullName: p.fullName!,
        email: p.email,
        phone: p.phone,
        linkedinUrl: p.linkedinUrl,
        location: p.location,
        nationality: null,
        age: null,
        gender: null,
        currentEmployer: p.currentEmployer,
        currentTitle: p.currentTitle,
        totalExperienceYears: p.totalExperienceYears,
        educationDegree: p.educationDegree,
        educationInstitution: p.educationInstitution,
        qualifications: null,
        englishLevel: null,
        languages: [],
        skills: p.skills,
        industries: [],
        noticePeriodDays: null,
        currentSalary: null,
        expectedSalary: null,
        cvFileName: item.fileName,
        workHistory: [],
        createdAt: now,
      });
      const row = d.intake.find((r) => r.id === id)!;
      row.status = "admitted";
      row.candidateId = candidateId;
      row.handledBy = byUserId;
      row.handledAt = now;
    });

    const openingId = opts.openingId ?? item.openingId;
    if (openingId) {
      // Placed where it was routed: on its post. Placed on another opening by
      // hand: on that opening's newest post, so its TA sees it — the routed
      // post belongs to a different opening (post routing, 22 September).
      const postId =
        openingId === item.openingId
          ? item.jobPostId
          : [...repo.jobPosts(openingId)].sort((a, b) => (b.postedAt ?? b.createdAt) - (a.postedAt ?? a.createdAt))[0]?.id ?? null;
      repo.addCandidateToOpening(candidateId, openingId, byUserId, postId, {
        kind: "intake",
        source: item.source,
      });
    }
    return { ok: true, candidateId };
  },

  /**
   * Fold into the record already on file.
   *
   * Fills blanks and grows lists; never overwrites a field that already holds
   * something. Anything that disagrees is written into the item's note so the
   * TA can see both versions and decide, instead of the system picking one and
   * losing the other.
   */
  mergeIntake(
    id: Id,
    candidateId: Id,
    byUserId: Id,
  ): { ok: true; filled: string[]; conflicts: number } | { ok: false; message: string } {
    const db = load();
    const item = db.intake.find((r) => r.id === id);
    const target = db.candidates.find((c) => c.id === candidateId);
    if (!item?.parsed) return { ok: false, message: "Nothing parsed to merge." };
    if (!target) return { ok: false, message: "No such candidate." };

    const p = item.parsed;
    const plan = planMerge(
      target as unknown as Record<string, unknown>,
      {
        email: p.email, phone: p.phone, linkedinUrl: p.linkedinUrl, location: p.location,
        currentTitle: p.currentTitle, currentEmployer: p.currentEmployer,
        totalExperienceYears: p.totalExperienceYears, educationDegree: p.educationDegree,
        educationInstitution: p.educationInstitution, skills: p.skills,
        cvFileName: item.fileName,
      } as Record<string, unknown>,
      ["email", "phone", "linkedinUrl", "location", "currentTitle", "currentEmployer",
       "totalExperienceYears", "educationDegree", "educationInstitution", "skills", "cvFileName"],
      { takeNewest: ["cvFileName"] },
    );

    const now = Date.now();
    mutate((d) => {
      const c = d.candidates.find((x) => x.id === candidateId)!;
      Object.assign(c, plan.fill);
      const row = d.intake.find((r) => r.id === id)!;
      row.status = "merged";
      row.candidateId = candidateId;
      row.handledBy = byUserId;
      row.handledAt = now;
      if (plan.conflicts.length) {
        row.note = plan.conflicts
          .map((c2) => `${c2.field}: on file “${c2.existing}”, this CV says “${c2.incoming}”`)
          .join(" · ");
      }
    });

    const openingId = item.openingId;
    if (openingId) {
      // They applied, even though we already knew them — a new application,
      // not a database match.
      repo.addCandidateToOpening(candidateId, openingId, byUserId, item.jobPostId, {
        kind: "intake",
        source: item.source,
      });
    }
    return { ok: true, filled: Object.keys(plan.fill), conflicts: plan.conflicts.length };
  },

  rejectIntake(id: Id, byUserId: Id, note: string): void {
    mutate((d) => {
      const row = d.intake.find((r) => r.id === id);
      if (!row) return;
      row.status = "rejected";
      row.handledBy = byUserId;
      row.handledAt = Date.now();
      row.note = note.trim() || null;
    });
  },

  // ─── Database matching (13 September) ─────────────────────────────────────

  /** The CV text we hold for someone: the newest file that became them. */
  cvTextFor(candidateId: Id): string | null {
    if (lockDepth > 0) {
      const items = load().intake.filter((i) => i.candidateId === candidateId && i.rawText);
      return items.sort((a, b) => b.receivedAt - a.receivedAt)[0]?.rawText ?? null;
    }
    return indexes().cvTextByCandidate.get(candidateId) ?? null;
  },

  matchRuns(openingId: Id): MatchRun[] {
    return load().matchRuns.filter((r) => r.openingId === openingId).sort((a, b) => b.at - a.at);
  },

  saveMatchRun(r: Omit<MatchRun, "id">): void {
    mutate((db) => {
      db.matchRuns.push({ ...r, id: `mr_${Math.random().toString(36).slice(2, 10)}` });
      // A year of nightly runs per opening is plenty of history.
      const mine = db.matchRuns.filter((x) => x.openingId === r.openingId);
      if (mine.length > 400) {
        const drop = new Set(mine.sort((a, b) => a.at - b.at).slice(0, mine.length - 400).map((x) => x.id));
        db.matchRuns = db.matchRuns.filter((x) => !drop.has(x.id));
      }
    });
  },

  /** Several changes as one save — each save rewrites the whole file. */
  batch<T>(fn: () => T): T {
    let out!: T;
    mutate(() => {
      out = fn();
    });
    return out;
  },

  /**
   * Copies CVs read from the current system into this build — candidates by
   * their `lv_` id, replaced on every sync, plus where the text came from.
   * One save for the whole page.
   */
  upsertLiveCandidates(rows: { candidate: Candidate; liveId: string; rawText: string | null; textSource: "db" | "r2" | "none" }[]): { added: number; updated: number } {
    let added = 0;
    let updated = 0;
    mutate((db) => {
      const byId = new Map(db.candidates.map((c, i) => [c.id, i]));
      const mirrorAt = new Map(db.liveMirror.map((m, i) => [m.candidateId, i]));
      const now = Date.now();
      for (const r of rows) {
        const at = byId.get(r.candidate.id);
        if (at === undefined) {
          db.candidates.push(r.candidate);
          byId.set(r.candidate.id, db.candidates.length - 1);
          added++;
        } else {
          db.candidates[at] = r.candidate;
          updated++;
        }
        const row = { candidateId: r.candidate.id, liveId: r.liveId, rawText: r.rawText, textSource: r.textSource, syncedAt: now };
        const m = mirrorAt.get(r.candidate.id);
        if (m === undefined) db.liveMirror.push(row);
        else db.liveMirror[m] = row;
      }
    });
    return { added, updated };
  },

  liveMirrorCount(): number {
    return load().liveMirror.length;
  },

  matchExcluded(openingId: Id): Set<Id> {
    return new Set(load().matchExclusions.filter((x) => x.openingId === openingId).map((x) => x.candidateId));
  },

  addCandidateToOpening(
    candidateId: Id,
    openingId: Id,
    byUserId: Id,
    /** The advert it came in on, where it came in on one. Null for a database
     *  pick, which did not come from an advert at all. */
    jobPostId: Id | null = null,
    /**
     * Where they came from. A database pick is a match the desk went looking
     * for; an intake item is somebody who applied. They start in different
     * stages under different channel codes, and the 13 September audit found
     * both were being filed as database matches.
     */
    origin: { kind: "database" } | { kind: "auto_match"; note: string } | { kind: "intake"; source: IntakeSource } = { kind: "database" },
  ): { ok: boolean; reason?: string } {
    const db = load();
    if (!db.candidates.some((c) => c.id === candidateId)) return { ok: false, reason: "No such candidate" };
    if (!db.openings.some((o) => o.id === openingId)) return { ok: false, reason: "No such opening" };
    const existing = db.applications.find((a) => a.candidateId === candidateId && a.openingId === openingId);
    if (existing) return { ok: false, reason: "Already on this opening" };

    mutate((d) => {
      d.applications.push({
        id: `app_${Math.random().toString(36).slice(2, 10)}`,
        openingId,
        jobPostId,
        candidateId,
        stage: origin.kind === "intake" ? "new_cv" : "matched",
        answers: {},
        sourcingChannel: origin.kind === "intake" ? channelForIntake(origin.source, jobPostId) : "SCOOP",
        ownerTaId: null,
        shortlistedAt: null,
        setNumber: null,
        rating: null,
        notes: [
          origin.kind === "intake"
            ? `Applied — admitted from ${origin.source} by ${d.users.find((u) => u.id === byUserId)?.name ?? "a TA"}`
            : origin.kind === "auto_match"
              ? origin.note
              : `Found in the database by ${d.users.find((u) => u.id === byUserId)?.name ?? "a TA"}`,
        ],
        statusA: null,
        statusB: null,
        rankTier: null,
        rankWeight: null,
        isAddOn: false,
        addedOnAt: null,
        backupForApplicationId: null,
        offerDeclinedAt: null,
        offerDeclineReason: null,
        rejectedBy: null,
        rejectReason: null,
        droppedOutReason: null,
        createdAt: Date.now(),
        lastStageChangedAt: Date.now(),
      });
    });
    return { ok: true };
  },
};

/**
 * Every repo method resolves temporary ids in what it is given — a new row's
 * first name, still held by the code that created it, after the database has
 * renamed it on save (primeState.recordAliases). Strings, arrays of strings,
 * and the string fields of an input object are checked; nothing else is touched.
 */
function withIdAliases<T extends Record<string, unknown>>(target: T): T {
  const resolve = (arg: unknown): unknown => {
    if (typeof arg === "string") return realId(arg);
    if (Array.isArray(arg)) return arg.some((x) => typeof x === "string") ? arg.map((x) => realId(x)) : arg;
    if (arg && typeof arg === "object" && Object.getPrototypeOf(arg) === Object.prototype) {
      let copy: Record<string, unknown> | null = null;
      for (const [k, v] of Object.entries(arg)) {
        const r = typeof v === "string" ? realId(v) : Array.isArray(v) ? resolve(v) : v;
        if (r !== v) (copy ??= { ...(arg as Record<string, unknown>) })[k] = r;
      }
      return copy ?? arg;
    }
    return arg;
  };
  for (const [name, fn] of Object.entries(target)) {
    if (typeof fn !== "function") continue;
    (target as Record<string, unknown>)[name] = (...args: unknown[]) => (fn as (...a: unknown[]) => unknown).apply(target, args.map(resolve));
  }
  return target;
}

export const repo = withIdAliases(rawRepo);

function buildVocabulary(db: Database): Vocabulary {
  const uniq = (xs: (string | null)[]) => [...new Set(xs.filter(Boolean) as string[])];
  return {
    titles: uniq(db.candidates.map((c) => c.currentTitle)),
    skills: uniq(db.candidates.flatMap((c) => c.skills)),
    industries: uniq(db.candidates.flatMap((c) => c.industries)),
    cities: uniq(db.candidates.map((c) => c.location)),
    employers: uniq(db.candidates.map((c) => c.currentEmployer)),
    qualifications: uniq([
      ...db.candidates.map((c) => c.educationDegree),
      ...db.candidates.map((c) => c.educationInstitution),
    ]),
    languages: uniq(db.candidates.flatMap((c) => c.languages)),
    nationalities: uniq(db.candidates.map((c) => c.nationality)),
  };
}

// ─── Derived values ──────────────────────────────────────────────────────────

/**
 * Spec §7 — a set closes at five or more; an open set carries across days.
 * Counted per Opening, across whichever TAs are working it (Q2).
 */
/**
 * The sets on an opening, one list across every recruiter on it.
 *
 * A set belongs to the TA who built it (see `nextSetNumber`), so two TAs each
 * have a Set 1. A set is closed when it is not that TA's newest, or when five
 * or more of it were shortlisted before today — the same test that decides
 * where tomorrow's shortlist goes, so the screen and the numbering agree.
 */
export function setsForOpening(openingId: Id, taId?: Id, now = Date.now()) {
  const today = colomboDayStart(now);
  const apps = repo
    .applications(openingId)
    .filter((a) => a.setNumber !== null && a.ownerTaId && (!taId || a.ownerTaId === taId));

  const byTa = new Map<Id, Application[]>();
  for (const a of apps) byTa.set(a.ownerTaId!, [...(byTa.get(a.ownerTaId!) ?? []), a]);

  const out: { taId: Id; setNumber: number; count: number; status: "open" | "closed" }[] = [];
  for (const [owner, mine] of byTa) {
    const top = Math.max(...mine.map((a) => a.setNumber as number));
    const bySet = new Map<number, Application[]>();
    for (const a of mine) bySet.set(a.setNumber!, [...(bySet.get(a.setNumber!) ?? []), a]);
    for (const [setNumber, members] of bySet) {
      const beforeToday = members.filter((m) => (m.shortlistedAt ?? 0) < today).length;
      const closed = setNumber < top || beforeToday >= SET_SIZE;
      out.push({ taId: owner, setNumber, count: members.length, status: closed ? "closed" : "open" });
    }
  }
  return out.sort((x, y) => x.taId.localeCompare(y.taId) || x.setNumber - y.setNumber);
}

export function stageCounts(openingId: Id): Record<Stage, number> {
  const out = {} as Record<Stage, number>;
  for (const a of repo.applications(openingId)) {
    out[a.stage] = (out[a.stage] ?? 0) + 1;
  }
  return out;
}
